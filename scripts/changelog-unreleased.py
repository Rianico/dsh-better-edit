#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Manage ## [Unreleased] section in CHANGELOG.md.

- update: generate notes from commits since last tag, place under Unreleased
- clear:  remove Unreleased section before semantic-release takes over

Usage:
  python scripts/changelog-unreleased.py update [--changelog CHANGELOG.md]
  python scripts/changelog-unreleased.py clear [--changelog CHANGELOG.md]
"""

from __future__ import annotations

import argparse
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


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


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

    log = run(["git", "log", range_spec, "--pretty=format:%s%n%b%x00%x00", "--no-merges"])
    if not log:
        return []
    # commits separated by double null
    raw_commits = [c.strip() for c in log.split("\x00\x00") if c.strip()]
    commits: list[tuple[str, str]] = []
    for raw in raw_commits:
        parts = raw.split("\n", 1)
        subject = parts[0].strip()
        body = parts[1] if len(parts) > 1 else ""
        if subject:
            commits.append((subject, body))
    return commits


def commits_to_sections(commits: list[tuple[str, str]]) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {}
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

        entry = f"- {m.group('subject').strip()}"
        scope = m.group("scope")
        if scope:
            entry = f"- **{scope}:** {m.group('subject').strip()}"
        if breaking:
            # annotate breaking
            entry += " (BREAKING CHANGE)"

        sections.setdefault(section, []).append(entry)

    return sections


def render_unreleased(sections: dict[str, list[str]]) -> str:
    if not sections:
        return ""
    # order by presetConfig.types order
    order = [v[0] for v in TYPE_SECTIONS.values()]
    # dedupe order preserving first occurrence
    seen: set[str] = set()
    ordered_keys: list[str] = []
    for k in order:
        if k not in seen:
            seen.add(k)
            ordered_keys.append(k)
    lines: list[str] = [UNRELEASED_HEADING, ""]
    for key in ordered_keys:
        if key not in sections:
            continue
        lines.append(f"### {key}")
        lines.append("")
        lines.extend(sections[key])
        lines.append("")
    return "\n".join(lines).strip() + "\n\n"


def update_changelog(changelog: Path) -> bool:
    tag = get_last_tag()
    commits = get_commits_since(tag)
    sections = commits_to_sections(commits)
    new_block = render_unreleased(sections)

    if not changelog.exists():
        changelog.write_text(
            f"{HEADER}\n\nAll notable changes to this project will be documented in this file.\n\n",
            encoding="utf-8",
        )

    content = changelog.read_text(encoding="utf-8")

    # ensure header exists
    if HEADER not in content:
        content = f"{HEADER}\n\n" + content

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
            return False
        # insert after header (after first HEADER line and following blank lines)
        # simple: insert right after header's first paragraph
        # find first "## [" after header
        m = VERSION_HEADING_RE.search(content)
        if m:
            new_content = (
                content[: m.start()].rstrip() + "\n\n" + new_block + content[m.start() :].lstrip()
            )
        else:
            new_content = content.rstrip() + "\n\n" + new_block

    if new_content == content:
        return False
    # normalize: ensure single trailing newline, no triple blanks
    new_content = re.sub(r"\n{3,}", "\n\n", new_content).strip() + "\n"
    changelog.write_text(new_content, encoding="utf-8")
    return True


def clear_changelog(changelog: Path) -> bool:
    if not changelog.exists():
        return False
    content = changelog.read_text(encoding="utf-8")
    if UNRELEASED_HEADING not in content:
        return False
    before, rest = content.split(UNRELEASED_HEADING, 1)
    m = VERSION_HEADING_RE.search(rest)
    after = rest[m.start() :] if m else ""
    new_content = before.rstrip() + "\n\n" + after.lstrip()
    new_content = re.sub(r"\n{3,}", "\n\n", new_content).strip() + "\n"
    if new_content == content:
        return False
    changelog.write_text(new_content, encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage Unreleased section in CHANGELOG.md")
    parser.add_argument("command", choices=["update", "clear"], help="update or clear Unreleased")
    parser.add_argument("--changelog", default="CHANGELOG.md", help="path to CHANGELOG.md")
    args = parser.parse_args()

    changelog = Path(args.changelog)
    if args.command == "update":
        changed = update_changelog(changelog)
        print("updated" if changed else "no change")
    else:
        changed = clear_changelog(changelog)
        print("cleared" if changed else "no change")
    return 0


if __name__ == "__main__":
    sys.exit(main())
