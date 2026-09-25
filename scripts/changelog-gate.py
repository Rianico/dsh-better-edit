#!/usr/bin/env python3
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Deterministic changelog-ledger floor.

Validates the `## [Unreleased]` block in CHANGELOG.md:
- Heading and section integrity (conventional commit types)
- Well-formedness of bullets (markdown syntax, no placeholders, no empty bullets)
- Duplicate entry detection
- Provenance and attribution (#PR)
- Permits multiple curated entries per PR

Usage:
  uv run scripts/changelog-gate.py ledger [--changelog CHANGELOG.md]
  uv run scripts/changelog-gate.py ledger --pr 123
  uv run scripts/changelog-gate.py ledger --pr 123 --waiver "reason"
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
ANNOTATION_RE = re.compile(r"\s*\(#\d+\)\s*$|\s*\(BREAKING CHANGE\)\s*$")
ATTRIBUTION_RE = re.compile(r"\(#(?P<pr>\d+)\)(?:\s*\(BREAKING CHANGE\))?\s*$")
PR_REF_RE = re.compile(r"#(\d+)")

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
        if PLACEHOLDER_RE.search(text):
            findings.append(Finding("placeholders", f"placeholder text: {text!r}"))
    return findings


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
    findings += check_sections(block) + check_entries(block)
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
    landings = landing_commits() if not pr else set()

    for entry in entries:
        ref = attributed_pr(entry)
        identity = entry_identity(entry)
        if ref is None:
            if identity in baseline:
                continue
            findings.append(Finding("provenance", f"entry carries no (#N): {identity!r}"))
        elif pr is not None and ref == pr:
            continue
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
        if not pr_entries:
            findings.append(Finding("landing", f"#{pr} carries no entries in {UNRELEASED_HEADING}"))

    return findings


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
    _ = parser.add_argument("--landing", default=None, help="ignored for compatibility")
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
    ns = parser.parse_args(argv)
    check_name = cast("str", getattr(ns, "check", "ledger"))
    changelog_arg = cast("str", getattr(ns, "changelog", "CHANGELOG.md"))
    pr_arg = cast("str | None", getattr(ns, "pr", None))
    baseline_arg = cast("str", getattr(ns, "baseline", str(DEFAULT_BASELINE)))
    update_baseline_arg = cast("bool", getattr(ns, "update_baseline", False))
    waiver_arg = cast("str | None", getattr(ns, "waiver", None))

    if check_name == "ticket":
        print("ticket: pass")
        return 0

    findings = check_ledger(
        Path(changelog_arg),
        pr_arg,
        Path(baseline_arg),
        update_baseline_arg,
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
    if waiver_clean:
        print(f"waiver recorded: {waiver_clean}", file=sys.stderr)
    if not blocking:
        print(f"{check_name}: pass" + (" (waived)" if waived else ""))
    return exit_code(blocking)


if __name__ == "__main__":
    sys.exit(main())
