#!/usr/bin/env python3
"""Gate the typecheck with a shrink-only warning budget.

`basedpyright` fails on warnings, so the repo's 1000-odd of them make the release job red — which
means a red typecheck surfaces as a blocked release rather than a red pull request, and the debt
grows invisibly. This turns that into a ratchet: errors always fail, and warnings may only shrink.

The budget is keyed by `(file, rule)` rather than by line, so it survives refactors that move code
without moving the debt, and a new file's warnings are new keys — growth — rather than slack.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Protocol, TypedDict, cast

BASELINE = Path(".config/basedpyright-baseline.txt")

BASELINE_NOTE = [
    "# basedpyright warnings the repo has not paid down yet: `count<TAB>path<TAB>rule`.",
    "# Shrink-only. `scripts/typecheck-budget.py --update-baseline` rewrites it to the entries that",
    "# still exist, and reports anything new as a finding instead of absorbing it. Errors are never",
    "# budgeted: they fail the check outright.",
]

REPO_ROOT = Path(__file__).resolve().parent.parent


class _Position(TypedDict):
    line: int
    character: int


class _Range(TypedDict):
    start: _Position


class _Diagnostic(TypedDict):
    severity: str
    rule: str | None
    file: str
    message: str
    range: _Range


class _Report(TypedDict):
    generalDiagnostics: list[_Diagnostic]


class _Args(Protocol):
    """The CLI surface, declared so `argparse`'s `Namespace` stops leaking `Any`."""

    baseline: str
    seed: bool
    update_baseline: bool


def run_typecheck() -> _Report:
    """Run basedpyright over the repo and return its JSON report."""
    proc = subprocess.run(
        ["uv", "run", "basedpyright", "--outputjson"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if not proc.stdout.strip():
        raise SystemExit("basedpyright produced no report:\n" + proc.stderr)
    try:
        loaded = cast(object, json.loads(proc.stdout))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"basedpyright report is not JSON ({exc}):\n{proc.stdout[:400]}") from exc
    return cast(_Report, loaded)


def relative(path: str) -> str:
    """Report paths relative to the repo root, so the budget survives a checkout elsewhere."""
    try:
        return str(Path(path).resolve().relative_to(REPO_ROOT))
    except ValueError:
        return path


def read_baseline(path: Path) -> dict[tuple[str, str], int]:
    if not path.exists():
        return {}
    budget: dict[tuple[str, str], int] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        try:
            count, file, rule = line.split("\t")
            budget[(file, rule)] = int(count)
        except ValueError as exc:
            raise SystemExit(f"{path}: not a `count<TAB>path<TAB>rule` row: {line!r}") from exc
    return budget


def write_baseline(path: Path, budget: dict[tuple[str, str], int]) -> None:
    rows = [
        f"{count}\t{file}\t{rule}"
        for (file, rule), count in sorted(budget.items(), key=lambda kv: (kv[0][0], kv[0][1]))
    ]
    _ = path.parent.mkdir(parents=True, exist_ok=True)
    _ = path.write_text("\n".join([*BASELINE_NOTE, *rows]) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Shrink-only budget for basedpyright warnings.")
    _ = parser.add_argument(
        "--baseline", default=str(BASELINE), help="budget file (default: %(default)s)"
    )
    _ = parser.add_argument(
        "--seed",
        action="store_true",
        help="record the current state as the starting budget (one-time bootstrap)",
    )
    _ = parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="rewrite the budget to the entries that still exist; never absorbs new ones",
    )
    args = cast(_Args, cast(object, parser.parse_args(argv)))

    path = Path(args.baseline)
    budget = read_baseline(path)

    report = run_typecheck()
    diagnostics = report["generalDiagnostics"]

    errors = [d for d in diagnostics if d["severity"] == "error"]
    if errors:
        for diagnostic in errors:
            start = diagnostic["range"]["start"]
            print(
                f"{relative(diagnostic['file'])}:{start['line'] + 1} "
                f"{diagnostic['rule'] or 'error'}: {diagnostic['message']}",
                file=sys.stderr,
            )
        print(f"typecheck: {len(errors)} error(s) — errors are never budgeted", file=sys.stderr)
        return 1

    current: Counter[tuple[str, str]] = Counter(
        (relative(d["file"]), str(d.get("rule") or "unknown"))
        for d in diagnostics
        if d["severity"] == "warning"
    )
    if args.seed:
        write_baseline(path, dict(current))
        print(
            f"typecheck-budget: seeded {path} — {sum(current.values())} warnings", file=sys.stderr
        )
        return 0

    growth = {key: count for key, count in current.items() if count > budget.get(key, 0)}
    retired = sorted(key for key in budget if not current.get(key))

    if args.update_baseline:
        if growth:
            for (file, rule), count in sorted(growth.items()):
                print(
                    f"::error file={file}::{count} warning(s) exceed the budget for {rule} "
                    f"(budget {budget.get((file, rule), 0)}); --update-baseline only shrinks",
                    file=sys.stderr,
                )
            print("typecheck-budget: refusing to absorb new warnings", file=sys.stderr)
            return 1
        write_baseline(path, dict(current))
        print(
            f"typecheck-budget: rewrote {path} — {len(current)} entries, "
            f"{len(retired)} retired, {sum(current.values())} warnings",
            file=sys.stderr,
        )
        return 0

    if growth:
        for (file, rule), count in sorted(growth.items()):
            print(
                f"::error file={file}::{count} warning(s) for {rule}, "
                f"budget {budget.get((file, rule), 0)} — fix them, or the budget grows",
                file=sys.stderr,
            )
        print(
            f"typecheck-budget: {sum(growth.values())} new warning(s) in {len(growth)} place(s)",
            file=sys.stderr,
        )
        return 1

    total = sum(current.values())
    print(
        f"typecheck-budget: pass — {total} warnings, {len(current)} entries, "
        f"{len(retired)} ready to retire with --update-baseline",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
