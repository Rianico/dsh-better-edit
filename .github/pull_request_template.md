<!-- markdownlint-disable MD041 -->

<!-- Canonical template: skills/gh-router/references/pull_request_template.md
     In the gh-router source repo: sync the installed copy with
     skills/gh-router/scripts/install-template.sh --target . --force
     The installer compares the two files byte-for-byte; keep them identical (no checksum). -->

## Summary

<!-- Lead with the visual that carries the change — pseudocode, a call tree, a component or
     state diagram, a Mermaid block, or a shaped diff — pasted straight into this section.
     Then write brief supporting text on the intent and the user-visible effect. Do not
     narrate the diff line by line. -->
<!-- Review path (optional): start at <file:line>. -->
<!-- The squash gate strips Mermaid from the derived squash message but keeps fenced
     pseudocode, call trees, and shaped diffs, so one compact visual beats a wall of prose. -->

## Root Cause

<!-- FIX-ONLY: one line naming why the bug happened, not what changed. Delete this whole
     section for feat, docs, chore, and refactor changes; the squash gate requires Root for
     a `fix` title only. -->

## Blast Radius & Safety

**Door:** one-way / two-way
**Downstream consumers:**
**Breaking changes:**
**Data / state invariants:**
**Rollback / containment:**

<!-- Door: pick exactly one — `one-way` = irreversible, `two-way` = revertible with the
     rollback stated above. Keep the Door line first in this section: the squash gate reads it. -->

## Evidence

<!-- Paste BOTH outputs verbatim, not a summary: the commands and outputs BEFORE the change,
     then the commands and outputs AFTER it. Link the CI run. -->
**Before (command + output):**
**After (command + output):**

## Checklist

- [ ] Formatter, linter, typecheck, and tests green (exact commands in `CONTRIBUTING.md`)
- [ ] Conventional Commits (`commitlint` + `husky`) — `npx commitlint --from=origin/main --to=HEAD`
- [ ] `CHANGELOG.md` `## [Unreleased]` updated (if user-facing)
- [ ] Docs / `docs/adr/` updated when seams or contracts change
- [ ] No generated artifacts committed outside `.lsz/` (transient scratch in `.lsz/tmp`, pr-land scaffold leaves in `.lsz/gh-router/`)
- [ ] Linked issue with `Closes #NN` (if applicable)

---

<!-- Related issues: list each on its own line below (never comma-separated: "Closes #1, #2" fails to close #2).
Closes #123
Closes #456
-->

<!-- CODE_AUTHORS: replace with `Co-authored-by: Name <email>` lines for each outside
     contributor whose commits this PR carries, or delete this block. The merge step
     refuses a body that still contains the raw `CODE_AUTHORS` token. -->
