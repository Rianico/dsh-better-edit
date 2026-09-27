#!/usr/bin/env python3
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Manage ## [Unreleased] section in CHANGELOG.md.

- update: generate notes from commits since last tag, place under Unreleased
- clear:  remove Unreleased section before semantic-release takes over
- check:  read-only drift check — exit 0 when in sync, 1 when `update` would rewrite (never writes)

Usage:
  python scripts/changelog-unreleased.py update [--changelog CHANGELOG.md]
  python scripts/changelog-unreleased.py clear [--changelog CHANGELOG.md]
  python scripts/changelog-unreleased.py check [--changelog CHANGELOG.md]
"""

from __future__ import annotations

import argparse
import difflib
import re
import subprocess
import sys
from pathlib import Path

HEADER = "# Changelog"
UNRELEASED_HEADING = "## [Unreleased]"

# Mirrors .releaserc.json presetConfig.types
TYPE_SECTIONS: dict[str, tuple[str, bool]] = {
    "feat": ("Features", False),
    "fix": ("Bug Fixes", False),
    "perf": ("Performance Improvements", False),
    "revert": ("Reverts", False),
    "docs": ("Documentation", False),
    "style": ("Styles", True),
    "chore": ("Miscellaneous Chores", True),
    "refactor": ("Code Refactoring", True),
    "test": ("Tests", True),
    "build": ("Build System", True),
    "ci": ("Continuous Integration", True),
}

CONVENTIONAL_RE = re.compile(
    r"^(?P<type>feat|fix|perf|revert|docs|style|chore|refactor|test|build|ci)(\((?P<scope>[^\)]+)\))?(?P<breaking>!)?:\s(?P<subject>.+)",
    re.DOTALL,
)

VERSION_HEADING_RE = re.compile(r"^## \[[^\]]+\].*", re.MULTILINE)
SECTION_HEADING_RE = re.compile(r"^###\s+(?P<name>.+?)\s*$")
BULLET_RE = re.compile(r"^[*+-]\s+\S")


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


VISIBLE_SYNC_TYPES = frozenset({"feat", "fix", "perf", "revert", "docs"})


def warn_if_visible_sync_head(commits: list[tuple[str, str]]) -> None:
    """Warn when HEAD looks like a visible-type changelog sync commit.

    A sync committed as `docs:` (or any visible type) re-triggers the guard:
    the next `update` lists the sync commit itself, demanding another sync.
    Sync commits must use a hidden type (e.g. `chore: sync changelog unreleased section`).
    Stderr only; never changes file bytes.
    """
    if not commits:
        return
    subject = commits[0][0]
    m = CONVENTIONAL_RE.match(subject)
    if not m:
        return
    if m.group("type") in VISIBLE_SYNC_TYPES and "sync changelog" in subject.lower():
        print(
            "WARNING: HEAD looks like a visible-type changelog sync commit: "
            f"{subject!r} — commit the sync as a hidden type "
            "(e.g. `chore: sync changelog unreleased section`); "
            "a visible type mints a ledger entry for the sync itself.",
            file=sys.stderr,
        )


def _is_ancestor(tag: str) -> bool:
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", tag, "HEAD"], capture_output=True
    )
    return result.returncode == 0


def get_last_tag() -> str:
    tag = run(["git", "describe", "--tags", "--abbrev=0"])
    if tag and _is_ancestor(tag):
        return tag
    # orphaned-tag aware: find newest semver tag that is ancestor of HEAD
    for t in run(["git", "tag", "--sort=-v:refname"]).splitlines():
        t = t.strip()
        if t and _is_ancestor(t):
            return t
    # fallback: most recent tag merged into HEAD (handles branches ahead of tags)
    merged = run(["git", "tag", "--merged", "HEAD", "--sort=-v:refname"])
    if merged:
        first_line = merged.splitlines()[0].strip()
        if first_line:
            return first_line
    first = run(["git", "rev-list", "--max-parents=0", "HEAD"])
    return first


def get_commits_since(tag: str) -> list[tuple[str, str]]:
    """Return list of (subject, body) for commits since tag."""
    if not tag:
        range_spec = "HEAD"
    else:
        # verify tag is ancestor; if not, fallback to HEAD
        has_tag = run(["git", "tag", "-l", tag])
        if has_tag:
            range_spec = f"{tag}..HEAD"
        else:
            range_spec = "HEAD"

    return parse_commit_log(
        run(["git", "log", range_spec, "--pretty=format:%s%n%b%x00%x00", "--no-merges"])
    )


def parse_commit_log(log: str) -> list[tuple[str, str]]:
    """Parse `%s%n%b%x00%x00` output into (subject, body) pairs, order preserved."""
    commits: list[tuple[str, str]] = []
    for raw in (chunk.strip() for chunk in log.split("\x00\x00")):
        if not raw:
            continue
        subject, _, body = raw.partition("\n")
        if subject.strip():
            commits.append((subject.strip(), body))
    return commits


def commits_to_sections(commits: list[tuple[str, str]]) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {}
    seen: dict[str, set[str]] = {}
    for subject, body in commits:
        m = CONVENTIONAL_RE.match(subject)
        if not m:
            continue
        ctype = m.group("type")
        breaking = bool(m.group("breaking")) or "BREAKING CHANGE:" in body
        # hidden types are skipped unless breaking
        section, hidden = TYPE_SECTIONS.get(ctype, (ctype, True))
        if hidden and not breaking:
            continue
        if breaking:
            section = "Features" if ctype == "feat" else section
            # breaking via ! or footer goes to appropriate section but ensure visible
            # if hidden and breaking, force visible under its section
            if ctype in ("perf",) and breaking:
                section = "Performance Improvements"

        # `*` matches @semantic-release/changelog's notes body. Staying consistent keeps
        # pi-lens's markdown fixer from normalising the generated section on every touch.
        entry = f"* {m.group('subject').strip()}"
        scope = m.group("scope")
        if scope:
            entry = f"* **{scope}:** {m.group('subject').strip()}"
        if breaking:
            # annotate breaking
            entry += " (BREAKING CHANGE)"

        # One commit per identity: a branch commit and its squash share a subject, and the
        # ledger's unit is the entry, not the commit that minted it.
        identities = seen.setdefault(section, set())
        identity = entry_identity(entry)
        if identity in identities:
            continue
        identities.add(identity)
        sections.setdefault(section, []).append(entry)

    return sections


def parse_unreleased_sections(content: str) -> dict[str, list[str]]:
    """Parse the on-disk Unreleased block into {section: [entry, ...]}, order preserved.

    Only the block's own `### Section` headings and bullets are modelled. Each bullet is
    kept verbatim so `update` never rewrites an entry it did not author.
    """
    if UNRELEASED_HEADING not in content:
        return {}
    _, rest = content.split(UNRELEASED_HEADING, 1)
    version = VERSION_HEADING_RE.search(rest)
    block = rest[: version.start()] if version else rest

    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in block.splitlines():
        heading = SECTION_HEADING_RE.match(line)
        if heading:
            current = heading.group("name")
            if current is not None:
                _ = sections.setdefault(current, [])
            continue
        if current is not None and BULLET_RE.match(line):
            sections[current].append(line.rstrip())
    return sections


_ANNOTATION_RE = re.compile(r"\s*\(#\d+\)\s*$|\s*\(BREAKING CHANGE\)\s*$")


def entry_identity(entry: str) -> str:
    """Entry text with its trailing `(#N)` / `(BREAKING CHANGE)` annotations removed.

    GitHub appends `(#N)` when it squashes a PR, so the entry a branch generated and the
    one regenerated after the merge differ by that suffix alone. Matching on identity lets
    the named form supersede the branch form instead of the change appearing twice.
    """
    text = entry.strip()
    if text[:1] in "*+-":
        text = text[1:].strip()
    while True:
        trimmed = _ANNOTATION_RE.sub("", text).rstrip()
        if trimmed == text:
            return text
        text = trimmed


def merge_unreleased(
    existing: dict[str, list[str]], generated: dict[str, list[str]]
) -> dict[str, list[str]]:
    """Union: keep every on-disk entry, prepend only what the commits newly justify.

    Regenerating alone deletes entries whose commits a squash-merge erased, so an entry
    already on disk is never dropped. An entry the merge re-issued under its squashed name
    (same identity, `(#N)` added) is superseded rather than duplicated. New entries arrive
    newest-first (`git log` order) ahead of the preserved ones, and a section with nothing
    new is returned untouched - which is what makes `update` idempotent.
    """
    merged = {section: list(entries) for section, entries in existing.items()}
    for section, entries in generated.items():
        bucket = merged.setdefault(section, [])
        superseded = {entry_identity(entry) for entry in entries}
        kept = [entry for entry in bucket if entry_identity(entry) not in superseded]
        present = {entry_identity(entry) for entry in kept}
        fresh = [entry for entry in entries if entry_identity(entry) not in present]
        merged[section] = fresh + kept
    return merged


def render_unreleased(sections: dict[str, list[str]]) -> str:
    if not sections:
        return ""
    # canonical order by presetConfig.types order, then any section the file already carried
    ordered_keys: list[str] = []
    seen: set[str] = set()
    for key in (value[0] for value in TYPE_SECTIONS.values()):
        if key in sections and key not in seen:
            seen.add(key)
            ordered_keys.append(key)
    for key in sections:
        if key not in seen:
            seen.add(key)
            ordered_keys.append(key)
    lines: list[str] = [UNRELEASED_HEADING, ""]
    for key in ordered_keys:
        entries = sections[key]
        if not entries:
            continue
        lines.append(f"### {key}")
        lines.append("")
        lines.extend(entries)
        lines.append("")
    return "\n".join(lines).strip() + "\n\n"


def _normalize(text: str) -> str:
    """Canonical file form: no triple blanks, single trailing newline."""
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


def render_updated_changelog(changelog: Path) -> str:
    """Content `update` would write, as a pure function (never touches disk).

    `update` and `check` both go through here, so a drift `check` reports is exactly the
    rewrite `update` would make — the two can never disagree.
    """
    tag = get_last_tag()
    commits = get_commits_since(tag)
    warn_if_visible_sync_head(commits)
    generated = commits_to_sections(commits)

    if changelog.exists():
        content = changelog.read_text(encoding="utf-8")
    else:
        content = (
            f"{HEADER}\n\nAll notable changes to this project will be documented in this file.\n\n"
        )

    # ensure header exists
    if HEADER not in content:
        content = f"{HEADER}\n\n" + content

    # Union rather than regenerate: an entry whose commits a squash-merge erased stays put.
    sections = merge_unreleased(parse_unreleased_sections(content), generated)
    new_block = render_unreleased(sections)

    if UNRELEASED_HEADING in content:
        # replace existing Unreleased block (from heading to next version heading or EOF)
        # split into before, unreleased block, after
        before, rest = content.split(UNRELEASED_HEADING, 1)
        # rest starts after "## [Unreleased]"
        # find next version heading
        m = VERSION_HEADING_RE.search(rest)
        if m:
            after = rest[m.start() :]
        else:
            after = ""
        # rebuild
        if new_block.strip() == UNRELEASED_HEADING:
            # no visible sections -> remove Unreleased entirely
            new_content = before.rstrip() + "\n\n" + after.lstrip()
        else:
            new_content = before.rstrip() + "\n\n" + new_block + after.lstrip()
    else:
        if not new_block.strip() or new_block.strip() == UNRELEASED_HEADING:
            # nothing to add
            new_content = content
        else:
            # insert after header (after first HEADER line and following blank lines)
            # simple: insert right after header's first paragraph
            # find first "## [" after header
            m = VERSION_HEADING_RE.search(content)
            if m:
                new_content = (
                    content[: m.start()].rstrip()
                    + "\n\n"
                    + new_block
                    + content[m.start() :].lstrip()
                )
            else:
                new_content = content.rstrip() + "\n\n" + new_block

    return _normalize(new_content)


def update_changelog(changelog: Path) -> bool:
    """Rewrite CHANGELOG.md when it differs from the generated Unreleased block.

    Idempotent: a second run over an in-sync file reports no change instead of churning
    whitespace-only diffs.
    """
    new_content = render_updated_changelog(changelog)
    current = _normalize(changelog.read_text(encoding="utf-8")) if changelog.exists() else ""
    if new_content == current:
        return False
    _ = changelog.write_text(new_content, encoding="utf-8")
    return True


def check_changelog(changelog: Path) -> tuple[bool, str]:
    """Read-only drift check: (in_sync, report). Never writes, never stages, never commits.

    Exit-code contract lives in `main()`: 0 when the file already matches what `update`
    would write, 1 when it drifts (or is missing). A convergence Finalize can call this to
    detect changelog drift without dirtying the integration worktree, which is what made
    the composite gate fail after a fully successful batch.
    """
    if not changelog.exists():
        return False, f"{changelog}: missing — `update` would create it"
    current = _normalize(changelog.read_text(encoding="utf-8"))
    expected = render_updated_changelog(changelog)
    if current == expected:
        return True, f"{changelog}: in sync"
    diff = "".join(
        difflib.unified_diff(
            current.splitlines(keepends=True),
            expected.splitlines(keepends=True),
            fromfile=f"{changelog} (on disk)",
            tofile=f"{changelog} (generated by update)",
        )
    )
    return False, diff or f"{changelog}: drift"


def clear_changelog(changelog: Path) -> bool:
    if not changelog.exists():
        return False
    content = changelog.read_text(encoding="utf-8")
    if UNRELEASED_HEADING not in content:
        return False
    before, rest = content.split(UNRELEASED_HEADING, 1)
    m = VERSION_HEADING_RE.search(rest)
    after = rest[m.start() :] if m else ""
    # Keep the heading: @semantic-release/changelog anchors its insertion point on it, and
    # prepends the new version above the file title (and stranded the title at the end) when it
    # is missing - which is exactly what the v2.0.0 release did.
    new_content = before.rstrip() + "\n\n" + UNRELEASED_HEADING + "\n\n" + after.lstrip()
    new_content = re.sub(r"\n{3,}", "\n\n", new_content).strip() + "\n"
    if new_content == content:
        return False
    _ = changelog.write_text(new_content, encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage Unreleased section in CHANGELOG.md")
    _ = parser.add_argument(
        "command", choices=["update", "clear", "check"], help="update, clear, or check Unreleased"
    )
    _ = parser.add_argument("--changelog", default="CHANGELOG.md", help="path to CHANGELOG.md")
    args = parser.parse_args()

    changelog = Path(args.changelog)
    if args.command == "update":
        changed = update_changelog(changelog)
        print("updated" if changed else "no change")
        return 0
    if args.command == "clear":
        changed = clear_changelog(changelog)
        print("cleared" if changed else "no change")
        return 0

    # check — read-only; exit 1 so a gate can fail loud on drift without mutating the tree
    in_sync, report = check_changelog(changelog)
    if in_sync:
        print("in sync")
        return 0
    print(report, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
