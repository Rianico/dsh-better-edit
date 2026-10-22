#!/usr/bin/env python3
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Deterministic changelog-ledger floor.

Validates the `## [Unreleased]` block in CHANGELOG.md:
- Heading and section integrity (conventional commit types)
- Well-formedness of bullets (markdown syntax, no placeholders, no empty bullets)
- Entry shape budget (max 100 words / 4 lines per bullet, no raw benchmark telemetry,
  scope label on current-PR entries), the squash-title/entry-scope alignment audit, and
  the release-bump audit (a patch title cannot publish feature or breaking entries)
- Duplicate entry detection
- Provenance and attribution (#PR)
- PR-boundary coverage: the current PR must carry an entry, exempt when
  --squash-title carries a hidden Conventional Commit type (docs, chore, style,
  test, ci, build) without a breaking `!`
- Permits multiple curated entries per PR

Usage:
  uv run scripts/changelog-gate.py ledger [--changelog CHANGELOG.md]
  uv run scripts/changelog-gate.py ledger --pr 123
  uv run scripts/changelog-gate.py ledger --pr 123 --waiver "reason"
  uv run scripts/changelog-gate.py ledger --pr 123 --landing squash
  uv run scripts/changelog-gate.py ledger --pr 123 --squash-title "feat(scope): subject"
  uv run scripts/changelog-gate.py ticket   # pre-merge shape-only phase over the ledger
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import cast

UNRELEASED_HEADING = "## [Unreleased]"
VERSION_HEADING_RE = re.compile(r"^## \[[^\]]+\].*", re.MULTILINE)
SECTION_HEADING_RE = re.compile(r"^###\s+(?P<name>.+?)\s*$")
BULLET_RE = re.compile(r"^[*+-]\s+\S")
EMPTY_BULLET_RE = re.compile(r"^[*+-]\s*$")
ENTRY_RE = re.compile(r"^\* (?:\*\*[^*]+:\*\* )?\S")
SCOPED_RE = re.compile(r"^\* \*\*[^*]+:\*\* \S")
PLACEHOLDER_RE = re.compile(r"\bTBD\b|\bTODO\b|<[^>]+>")
CODE_SPAN_RE = re.compile(r"`[^`]+`")
ANNOTATION_RE = re.compile(r"\s*\(#\d+\)\s*$|\s*\(BREAKING CHANGE\)\s*$")
ATTRIBUTION_RE = re.compile(r"\(#(?P<pr>\d+)\)(?:\s*\(BREAKING CHANGE\))?\s*$")
PR_REF_RE = re.compile(r"#(\d+)")

# Entry shape floor: one bullet stays a summary, not an essay or a telemetry dump.
SHAPE_MAX_WORDS = 100
SHAPE_MAX_LINES = 4
STRUCTURE_HINT = (
    "keep the entry as `**scope:** imperative summary, optional 1-2 sentence rationale, "
    "closing with `(#N)`; paste command output, timings, and benchmark telemetry into the "
    "PR's Evidence section, never the ledger"
)
LOADAVG_RE = re.compile(r"\bload[ _-]?avg\b", re.IGNORECASE)
PERCENTILE_RE = re.compile(r"\bp\d{2}\b", re.IGNORECASE)
SUBSECOND_RE = re.compile(r"(?<![\w.])\d+(?:[.,]\d+)?\s*(?:ns|ps|µs|μs|us)\b")
RATE_RE = re.compile(r"\b[\w-]+/(?:s|sec|min)\b", re.IGNORECASE)
ERROR_CODE_RE = re.compile(
    r"\b(?:err|error|errno|exit|status)[ _-]?(?:code|no|num)?\s*[=:]\s*-?\d+\b|\b0x[0-9a-fA-F]{6,}\b",
    re.IGNORECASE,
)
ENTRY_SCOPE_RE = re.compile(r"^\* \*\*(?P<scope>[^*:]+):\*\* \S")
TITLE_SCOPE_RE = re.compile(r"^[A-Za-z]+(?:\((?P<scope>[^()]+)\))?!?:")
HIDDEN_TYPES = frozenset({"docs", "chore", "style", "test", "ci", "build", "refactor"})
HIDDEN_TITLE_RE = re.compile(r"^(?P<type>[a-z]+)(?P<bang>!)?(\([^)]*\))?:")

# Release levels a squash title or a ledger section licenses (semantic-release defaults).
BUMP_NONE = 0
BUMP_PATCH = 1
BUMP_MINOR = 2
BUMP_MAJOR = 3
BUMP_NAMES = {
    BUMP_NONE: "no release",
    BUMP_PATCH: "patch",
    BUMP_MINOR: "minor",
    BUMP_MAJOR: "major",
}

SECTION_BUMP: dict[str, int] = {
    "Features": BUMP_MINOR,
    "Bug Fixes": BUMP_PATCH,
    "Performance Improvements": BUMP_PATCH,
    "Reverts": BUMP_PATCH,
}
TITLE_BUMP: dict[str, int] = {
    "feat": BUMP_MINOR,
    "fix": BUMP_PATCH,
    "perf": BUMP_PATCH,
    "revert": BUMP_PATCH,
    "docs": BUMP_NONE,
    "style": BUMP_NONE,
    "chore": BUMP_NONE,
    "refactor": BUMP_NONE,
    "test": BUMP_NONE,
    "build": BUMP_NONE,
    "ci": BUMP_NONE,
}
BREAKING_ENTRY_RE = re.compile(r"\(BREAKING CHANGE\)\s*$")

KNOWN_SECTIONS = frozenset(
    {
        "Features",
        "Bug Fixes",
        "Performance Improvements",
        "Reverts",
        "Documentation",
        "Styles",
        "Code Refactoring",
        "Tests",
        "Build System",
        "Continuous Integration",
        "Miscellaneous Chores",
    }
)

DEFAULT_BASELINE = Path(".config/changelog-unattributed-baseline.txt")


@dataclass(frozen=True)
class Finding:
    check: str
    detail: str
    fixable: bool = True
    hint: str | None = None


def run_git(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def unreleased_block(content: str) -> str | None:
    if UNRELEASED_HEADING not in content:
        return None
    _, rest = content.split(UNRELEASED_HEADING, 1)
    version = VERSION_HEADING_RE.search(rest)
    return rest[: version.start()] if version else rest


def entry_identity(entry: str) -> str:
    text = entry.strip()
    if text[:1] in "*+-":
        text = text[1:].strip()
    while True:
        trimmed = ANNOTATION_RE.sub("", text).rstrip()
        if trimmed == text:
            return text
        text = trimmed


def attributed_pr(entry: str) -> str | None:
    match = ATTRIBUTION_RE.search(entry.rstrip())
    return match.group("pr") if match else None


def parse_unreleased_sections(content: str) -> dict[str, list[str]]:
    block = unreleased_block(content)
    if not block:
        return {}
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in block.splitlines():
        heading = SECTION_HEADING_RE.match(line)
        if heading:
            current = heading.group("name")
            if current:
                _ = sections.setdefault(current, [])
            continue
        if current and BULLET_RE.match(line):
            sections[current].append(line.rstrip())
    return sections


def check_sections(block: str) -> list[Finding]:
    findings: list[Finding] = []
    current: str | None = None
    seen: set[str] = set()
    for line in block.splitlines():
        heading = SECTION_HEADING_RE.match(line)
        if heading:
            name = heading.group("name")
            if name in seen:
                findings.append(Finding("section-integrity", f"duplicate heading '### {name}'"))
            seen.add(name)
            if name not in KNOWN_SECTIONS:
                findings.append(
                    Finding(
                        "section-integrity",
                        f"unknown section '### {name}' — this ledger's sections are the conventional-commit types: "
                        + ", ".join(sorted(KNOWN_SECTIONS)),
                    )
                )
            current = name
            continue
        if BULLET_RE.match(line) and current is None:
            findings.append(
                Finding("section-integrity", f"entry outside any section: {line.strip()!r}")
            )
    return findings


def check_entries(block: str) -> list[Finding]:
    findings: list[Finding] = []
    for line in block.splitlines():
        text = line.rstrip()
        if EMPTY_BULLET_RE.match(text):
            findings.append(Finding("well-formedness", f"empty bullet: {text!r}"))
            continue
        if not BULLET_RE.match(text):
            continue
        if not ENTRY_RE.match(text) or (text.startswith("* **") and not SCOPED_RE.match(text)):
            findings.append(
                Finding("well-formedness", f"not in the renderer's bullet grammar: {text!r}")
            )
        if PLACEHOLDER_RE.search(CODE_SPAN_RE.sub("", text)):
            findings.append(Finding("placeholders", f"placeholder text: {text!r}"))
    return findings


def iter_entry_blocks(block: str) -> list[list[str]]:
    """Each bullet grouped with its continuation lines (a wrapped entry stays one entry)."""
    entries: list[list[str]] = []
    current: list[str] | None = None
    for line in block.splitlines():
        if BULLET_RE.match(line):
            current = [line]
            entries.append(current)
        elif current is not None and line.strip() and not line.lstrip().startswith("#"):
            current.append(line.rstrip())
        else:
            current = None
    return entries


def _telemetry_hit(text: str) -> str | None:
    """The first raw-telemetry construct in the text, or None."""
    for detector in (LOADAVG_RE, PERCENTILE_RE, RATE_RE, ERROR_CODE_RE):
        match = detector.search(text)
        if match is not None:
            return match.group(0)
    subsecond = SUBSECOND_RE.findall(text)
    if len(subsecond) >= 2:
        return ", ".join(subsecond[:3])
    return None


def check_entry_shape(block: str) -> list[Finding]:
    """The word/line budget and the telemetry floor over every `## [Unreleased]` entry."""
    findings: list[Finding] = []
    for lines in iter_entry_blocks(block):
        text = " ".join(part.strip() for part in lines)
        shown = text if len(text) <= 70 else text[:69] + "…"
        if len(lines) > SHAPE_MAX_LINES:
            findings.append(
                Finding(
                    "entry-shape",
                    f"entry spans {len(lines)} lines (max {SHAPE_MAX_LINES}): {shown!r}",
                    hint=STRUCTURE_HINT,
                )
            )
        words = len(text.split())
        if words > SHAPE_MAX_WORDS:
            findings.append(
                Finding(
                    "entry-shape",
                    f"entry carries {words} words (max {SHAPE_MAX_WORDS}): {shown!r}",
                    hint=STRUCTURE_HINT,
                )
            )
        hit = _telemetry_hit(text)
        if hit is not None:
            findings.append(
                Finding(
                    "entry-shape",
                    f"entry carries raw machine telemetry ({hit!r}): {shown!r}",
                    hint=STRUCTURE_HINT,
                )
            )
    return findings


def title_is_hidden(title: str) -> bool:
    """A hidden Conventional Commit type owes no ledger entry: docs, chore, ... without `!`."""
    match = HIDDEN_TITLE_RE.match(title.strip().casefold())
    if match is None or match.group("bang") is not None:
        return False
    return match.group("type") in HIDDEN_TYPES


def _bump_phrase(level: int) -> str:
    return "no release" if level == BUMP_NONE else f"a {BUMP_NAMES[level]}"


def _title_bump(squash_title: str) -> int | None:
    """The release level the squash title licenses, or None when it is not conventional."""
    match = HIDDEN_TITLE_RE.match(squash_title.strip().casefold())
    if match is None:
        return None
    if match.group("bang") is not None:
        return BUMP_MAJOR
    return TITLE_BUMP.get(match.group("type"))


def check_bump_alignment(
    sections: dict[str, list[str]], pr: str | None, squash_title: str | None
) -> list[Finding]:
    """The squash title's release level must cover every ledger entry this PR adds.

    A `fix(...)` title licenses a patch, so a `### Features` entry under it would publish
    feature text inside a patch release. A breaking entry likewise needs a major title.
    Hidden-type titles license no release, so they cannot carry a visible entry either.
    """
    if pr is None or not squash_title:
        return []
    licensed = _title_bump(squash_title)
    if licensed is None:
        return []
    findings: list[Finding] = []
    for section, entries in sections.items():
        for entry in entries:
            if attributed_pr(entry) != pr:
                continue
            breaking = BREAKING_ENTRY_RE.search(entry.rstrip()) is not None
            required = BUMP_MAJOR if breaking else SECTION_BUMP.get(section, BUMP_NONE)
            if required <= licensed:
                continue
            reason = (
                "is marked (BREAKING CHANGE) and requires a major"
                if breaking
                else f"is a {BUMP_NAMES[required]} change"
            )
            findings.append(
                Finding(
                    "bump-alignment",
                    f"squash title {squash_title.strip()!r} licenses {_bump_phrase(licensed)} "
                    + f"but the '### {section}' entry {reason}: {entry_identity(entry)!r}",
                    hint=(
                        "retitle the squash commit to the higher level (`feat(...)` for a feature, "
                        "`feat(...)!` or a BREAKING CHANGE for a major), or land this entry in its own PR"
                    ),
                )
            )
    return findings


def check_squash_alignment(
    entries: list[str], pr: str | None, squash_title: str | None
) -> list[Finding]:
    """The squash commit subject and the PR's ledger entries share a scope.

    Audited only when both sides name a scope: a scopeless conventional title or
    scopeless entries are already handled by the title grammar and the shape floor.
    """
    if pr is None or not squash_title:
        return []
    title = TITLE_SCOPE_RE.match(squash_title.strip())
    if title is None or title.group("scope") is None:
        return []
    pr_entries = [entry for entry in entries if attributed_pr(entry) == pr]
    entry_scopes = [
        match.group("scope") for entry in pr_entries if (match := ENTRY_SCOPE_RE.match(entry))
    ]
    if not entry_scopes:
        return []
    title_parts = {part.casefold() for part in re.split(r"[/:,\s]+", title.group("scope")) if part}
    for scope in entry_scopes:
        parts = {part.casefold() for part in re.split(r"[/:,\s]+", scope) if part}
        if title_parts & parts:
            return []
    return [
        Finding(
            "squash-alignment",
            f"squash title scope {title.group('scope')!r} matches no entry scope under #{pr} "
            + f"(entry scopes: {', '.join(sorted(set(entry_scopes)))!r})",
            hint="retarget the ledger entries, or reuse one of their scopes in the squash title",
        )
    ]


def check_duplicates(sections: dict[str, list[str]]) -> list[Finding]:
    findings: list[Finding] = []
    seen: set[str] = set()
    for entries in sections.values():
        for entry in entries:
            identity = entry_identity(entry)
            if identity in seen:
                findings.append(
                    Finding("duplicate-identity", f"duplicate entry identity: {identity!r}")
                )
            seen.add(identity)
    return findings


def landing_commits() -> set[str]:
    raw = run_git(["git", "log", "HEAD", "--pretty=format:%s%x00%P%x1e"])
    refs: set[str] = set()
    for record in raw.split("\x1e"):
        record = record.strip()
        if not record:
            continue
        subject, _, _ = record.partition("\x00")
        for m in PR_REF_RE.finditer(subject):
            refs.add(m.group(1))
    return refs


def read_baseline(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return {
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    }


CHANGELOG_TITLE = "# Changelog"


def check_title(content: str) -> list[Finding]:
    first = next((line for line in content.splitlines() if line.strip()), "")
    if first.strip() == CHANGELOG_TITLE:
        return []
    line = next(
        (n for n, line in enumerate(content.splitlines(), 1) if line.strip() == CHANGELOG_TITLE),
        0,
    )
    where = f"it sits at line {line}" if line else "the title is absent"
    return [Finding("title", f"`{CHANGELOG_TITLE}` must be the file's first line; {where}")]


def check_ledger(
    changelog: Path,
    pr: str | None = None,
    baseline_path: Path = DEFAULT_BASELINE,
    update_baseline: bool = False,
    landing: str | None = None,
    squash_title: str | None = None,
) -> list[Finding]:
    if not changelog.exists():
        return [Finding("ledger", f"{changelog} is missing", fixable=False)]
    try:
        content = changelog.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        return [Finding("ledger", f"{changelog} is not UTF-8: {error}", fixable=False)]

    findings: list[Finding] = check_title(content)
    block = unreleased_block(content)
    if block is None:
        return findings + [
            Finding("section-integrity", f"no '{UNRELEASED_HEADING}' block to check")
        ]
    findings += check_sections(block) + check_entries(block) + check_entry_shape(block)
    sections = parse_unreleased_sections(content)
    findings += check_duplicates(sections)

    entries = [entry for group in sections.values() for entry in group]
    baseline = read_baseline(baseline_path)

    if update_baseline:
        unatt = {entry_identity(e) for e in entries if attributed_pr(e) is None}
        recorded = baseline & unatt if baseline else unatt
        baseline_path.parent.mkdir(parents=True, exist_ok=True)
        lines = ["# Legacy unattributed baseline"] + sorted(recorded)
        _ = baseline_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return findings

    # Check provenance
    landings: set[str] = landing_commits() if not pr else set()

    for entry in entries:
        ref = attributed_pr(entry)
        identity = entry_identity(entry)
        if ref is None:
            if identity in baseline:
                continue
            findings.append(
                Finding(
                    "provenance",
                    f"entry carries no (#N): {identity!r}",
                    hint="Stamp (#N) into the entry, or run pr-land (pr.py auto-attributes after PR creation).",
                )
            )
        elif pr is not None and ref == pr:
            if ENTRY_SCOPE_RE.match(entry) is None:
                findings.append(
                    Finding(
                        "entry-shape",
                        f"entry for #{pr} carries no `**scope:**` label: {identity!r}",
                        hint=STRUCTURE_HINT,
                    )
                )
            continue
        elif landing == "squash":
            continue  # squash lands as one commit the ledger cannot resolve; shape checked below
        elif not pr and ref not in landings:
            findings.append(
                Finding(
                    "provenance",
                    f"(#{ref}) resolves to no commit reachable from HEAD: {identity!r}",
                )
            )

    # Current PR coverage: must carry at least one entry attributed to this PR
    if pr is not None:
        pr_entries = [entry for entry in entries if attributed_pr(entry) == pr]
        if not pr_entries and not (squash_title is not None and title_is_hidden(squash_title)):
            findings.append(Finding("landing", f"#{pr} carries no entries in {UNRELEASED_HEADING}"))
    # Declared squash landing without a PR number: the squash commit is unresolvable
    # from the ledger, so reachability is skipped above and only shape is checked.
    elif landing == "squash" and not entries:
        findings.append(
            Finding(
                "landing",
                f"{UNRELEASED_HEADING} carries no entries (landing=squash declares a PR with nothing to land)",
            )
        )
    findings += check_squash_alignment(entries, pr, squash_title)
    findings += check_bump_alignment(sections, pr, squash_title)
    return findings


def check_ticket(changelog: Path) -> list[Finding]:
    """The pre-merge audit phase: the shape-only floor over `## [Unreleased]`.

    Runs after the squash (ADR-0016 ticket boundary), where provenance is not yet
    resolvable: a missing ledger or block passes, the curated entries themselves must
    be well-formed and inside the shape budget.
    """
    if not changelog.exists():
        return []
    try:
        content = changelog.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        return [Finding("ledger", f"{changelog} is not UTF-8: {error}", fixable=False)]
    block = unreleased_block(content)
    if block is None:
        return []
    return check_entries(block) + check_entry_shape(block)


def exit_code(findings: list[Finding]) -> int:
    if not findings:
        return 0
    return 2 if any(not finding.fixable for finding in findings) else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Deterministic changelog-ledger floor")
    _ = parser.add_argument("check", choices=["ticket", "ledger"], default="ledger", nargs="?")
    _ = parser.add_argument("--changelog", default="CHANGELOG.md", help="path to CHANGELOG.md")
    _ = parser.add_argument("--base", default=None, help="ignored for compatibility")
    _ = parser.add_argument("--pr", default=None, help="this PR's number, for PR-boundary check")
    _ = parser.add_argument(
        "--landing",
        default=None,
        help="declared landing strategy (squash|merge); validated, and selects the ledger rule when --pr is absent",
    )
    _ = parser.add_argument(
        "--baseline", default=str(DEFAULT_BASELINE), help="recorded unattributed identities"
    )
    _ = parser.add_argument(
        "--update-baseline", action="store_true", help="seed or shrink baseline"
    )
    _ = parser.add_argument(
        "--waiver",
        default=None,
        help="recorded reason to accept fixable findings; never rescues a needs-human one",
    )
    _ = parser.add_argument(
        "--squash-title",
        default=None,
        help="the squash commit subject (== PR title); audits its scope against this PR's entries",
    )
    ns = parser.parse_args(argv)
    check_name = cast("str", getattr(ns, "check", "ledger"))
    changelog_arg = cast("str", getattr(ns, "changelog", "CHANGELOG.md"))
    pr_arg = cast("str | None", getattr(ns, "pr", None))
    baseline_arg = cast("str", getattr(ns, "baseline", str(DEFAULT_BASELINE)))
    update_baseline_arg = cast("bool", getattr(ns, "update_baseline", False))
    waiver_arg = cast("str | None", getattr(ns, "waiver", None))
    landing_arg = cast("str | None", getattr(ns, "landing", None))
    squash_title_arg = cast("str | None", getattr(ns, "squash_title", None))
    if landing_arg is not None and landing_arg not in ("squash", "merge"):
        parser.error("--landing must be squash or merge")
    if squash_title_arg is not None and pr_arg is None:
        parser.error("--squash-title needs --pr: alignment is audited at the PR boundary")

    if check_name == "ticket":
        findings = check_ticket(Path(changelog_arg))
    else:
        findings = check_ledger(
            Path(changelog_arg),
            pr_arg,
            Path(baseline_arg),
            update_baseline_arg,
            landing_arg,
            squash_title_arg,
        )

    waiver_clean = waiver_arg.strip() if waiver_arg is not None else None
    if waiver_arg is not None and not waiver_clean:
        findings.append(Finding("waiver", "--waiver needs a written reason", fixable=False))

    waived: list[Finding] = []
    blocking: list[Finding] = []
    for finding in findings:
        (waived if waiver_clean and finding.fixable else blocking).append(finding)

    for finding in waived:
        print(f"[waived] [{finding.check}] {finding.detail}", file=sys.stderr)
    for finding in blocking:
        print(f"[{finding.check}] {finding.detail}", file=sys.stderr)
        if finding.hint:
            print(f"  → {finding.hint}", file=sys.stderr)
    if waiver_clean:
        print(f"waiver recorded: {waiver_clean}", file=sys.stderr)
    if not blocking:
        print(f"{check_name}: pass" + (" (waived)" if waived else ""))
    return exit_code(blocking)


if __name__ == "__main__":
    sys.exit(main())
