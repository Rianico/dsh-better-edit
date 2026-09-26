# ADR-0024 — Pre-push changelog guard retired; the gate owns both CI boundaries

Date: 2026-09-26
Status: accepted (S1 orchestrator ratified CP2 on 2026-09-25; the change landed on
`map/absorb-v2` through `fa06f4d337e377838dc12af44e23956d4129fb6c`; this file is the record,
written after the landing)
Related: `.github/workflows/changelog-check.yml` (the gate's two runs),
`scripts/changelog-gate.py` (the deterministic floor), `scripts/changelog-unreleased.py` (the
`check` probe), `scripts/release-changelog.mjs` + `.releaserc.json` (the curated-ledger plugin),
`.config/changelog-unattributed-baseline.txt` (the tolerated pre-gate entry), `AGENTS.md:56`
(corrected with this ADR), `CONTRIBUTING.md` (prose pointer). Upstream `pi-better-edit` has an
**unrelated** ADR-0024 (`narrow-p2-interior-exposure-cap-removed-diffs`) — this number is ours.

## Context

`CHANGELOG.md` `## [Unreleased]` was guarded at three places: a local `pre-push` hook
(`.githooks/pre-push`, live via `.husky/pre-push`), the PR workflow
`.github/workflows/changelog-check.yml`, and a prose restatement in `CONTRIBUTING.md`. All three
implemented the same rule — run `scripts/changelog-unreleased.py update` and `diff -q` the result
against the committed file — which makes the ledger a *projection of commit subjects*: any human
curation of it is machine-overwritten on the next run.

## Decision

### 1. The retirement — what died, and the four witnesses

`.githooks/pre-push` was **deleted**; `.husky/pre-push` was deleted with it — measured content
shows it was a pure delegation (`exec .githooks/pre-push "$@"`), carrying no other hook logic.
Nothing else in `.husky/` was touched. No replacement local hook was added.

The hook was retired because it was a **scripted bypass engine**. Its auto-fix path, quoted
verbatim from the deleted file at the last revision carrying it (`ab713dd`), four independent
witnesses — re-derive with
`git show ab713dd:.githooks/pre-push | rg -n "no-verify|force-with-lease|Bypass|sleep 0.5"`:

1. `:34` — `if git commit --amend --no-edit --no-verify >/dev/null 2>&1; then` — the hook rewrote
   pushed history AND bypassed every other hook while doing it: an automation holding its own
   off-switch.
2. `:41` — `( sleep 0.5; git push </dev/null >&2 || git push --set-upstream origin HEAD </dev/null >&2 ) &`
   — after aborting the user's push (`:42 exit 1`), a detached background process re-pushed while
   the user's command had not succeeded; push semantics became non-deterministic across the abort.
3. `:55` — `# or amend on a feature branch: git commit --amend --no-edit --no-verify && git push --force-with-lease`
   — the fix text printed to the user taught history-rewriting and force-push as the *correct*
   response to a bookkeeping warning.
4. `:57` — `Bypass (human): git push --no-verify  or  PREPUSH_AUTOFIX=0 git push` — a guard whose
   own output advertises its escape hatch is documentation for its bypass, not a gate.

Under the never-bypass-gates discipline this repo holds, "mutate history + auto-retry-push +
advertise its own bypass" disqualifies the hook regardless of what it guards.

Post-change proof of the retirement (both print nothing at `HEAD`):
`git ls-tree --name-only HEAD -- .githooks/` → empty; `git grep -n "no-verify" -- .githooks/` →
0 hits (exit 1 — the path no longer exists).

### 2. The replacement — one rule, the gate, at two boundaries

The rule needs **one implementation (the gate), at two boundaries (PR + durable `main`), with one
recorded escape (the waiver)** — not three copies with three divergence risks.
`.github/workflows/changelog-check.yml` now runs `python scripts/changelog-gate.py ledger`:
on `pull_request` with `--pr <number>`, forwarding a single-line `Ledger-Waiver: <reason>` PR-body
trailer as `--waiver` when present; on `push: [main]` it is the durable run with no PR context,
where every entry must resolve to a landing commit. Read the workflow itself —
`sed -n '28,55p' .github/workflows/changelog-check.yml` — the failure comment names the gate and
the waiver as the only escape (fixable findings only, never a needs-human one).

The local fast-feedback role moves to a **read-only probe**: `python3 scripts/changelog-unreleased.py
check` — exit-only, never amends, never pushes. Its verdict is **informational only**: it diffs the
file against the FULL commit-subject projection and has **no baseline awareness** (CP4 correction),
so it stays RED by design while tolerated pre-gate entries exist. The baseline-aware local floor is
`python3 scripts/changelog-gate.py ledger` → `ledger: pass` (exit 0 at landing).

### 3. Curation replaced projection — and the `Landing:` forward contract

The ledger's new contract: `## [Unreleased]` is a **curated record where every entry resolves to a
landing**. Projection (`update`-equality) and curation are contradictory owners of the same bytes:
a hook that auto-amends rewrites curated entries from commit subjects, silently destroying the
thing the gate now protects.

**Declared limit — the PR run does NOT yet read the `## Landing` declaration.** Measured at the
merged tip, only the durable `main` run consumes landing commits:
`rg -n "Landing" scripts/changelog-gate.py` → **0 hits** (the gap stands). The gate ignores
`--landing` (script `:289`, "ignored for compatibility") and skips landing-set construction on PR
(`:249`, `landings = landing_commits() if not pr else set()`). The `Landing:` field in
`.github/pull_request_template.md` is therefore a **forward contract**: written into the template,
reader unwired. **Predicate trigger:** this section is stale when the PR run begins reading the
declaration. **Deciding command:** the same `rg` above — empty output means the gap stands; any
hit means re-read the gate and update this section. No reader was shimmed at landing: the script
is pinned verbatim from the scaffold skill and the gap is recorded, not patched.

### 4. `clear` versus the curated plugin — the release-workflow verdict

`scripts/release-changelog.mjs` is wired in `.releaserc.json`:
`generateNotes` returns the curated `## [Unreleased]` block as the release notes, and `prepare`
promotes it to `## [version] - date` and re-opens an empty `## [Unreleased]` above
(`rg -n "generateNotes|prepare" scripts/release-changelog.mjs` shows the mechanism and the order
note: `generateNotes` runs before `prepare`). **The promotion IS the clear** — running
`changelog-unreleased.py clear` first would empty the block `generateNotes` reads and destroy the
curated entries at release. The two writers cannot coexist; the plugin owns the handoff. Verdict:
the `Clear Unreleased section (handoff to semantic-release)` step was removed from
`.github/workflows/release.yml`. Evidence read before the removal: the scaffold flavor templates
carry no `clear` in the release path (`templates/ci/release.yml.j2`'s base release block is
checkout → setup-node → `npm ci` → `npx semantic-release`).

The same checkpoint swapped `@semantic-release/changelog` for this plugin and retired the manual
tag-first path (`scripts/release.mjs`, `scripts/changelog.mjs`, `scripts/tag-current.mjs` + the
`release`/`postpublish` stanzas). `scripts/assert-tagged.mjs` + `prepublishOnly` are KEPT: with
`npmPublish: false`, publishing a cut version stays a human step and nothing else refuses an
untagged publish.

### 5. The release job's Python — a step deletion, not a version move

**Correction carried from the lane:** an interim framing called `setup-python 3.12 → 3.14` in the
release job a "behavioural line". That framing is void — the step is **gone**. Within the same
lane, the `clear` step (the job's only Python consumer) was deleted, which left `setup-python`
consumer-less, and it was deleted too. The lane's live statement: **the release job runs no
Python.** Deciding command at `HEAD`: `rg -c "python" .github/workflows/release.yml` → 0 hits
(exit 1). The release job is checkout → pnpm-setup → setup-node → `pnpm install` →
`pnpm exec semantic-release`.

**Deliberate divergence, with reason:** the scaffold flavor projection
(`templates/ci/runtimes/node.yml.j2`) pins `setup-python 3.14` in the node release job because it
keeps Python for a baseline-retire step; this job has zero Python consumers after the
curated-ledger handoff, so the step is removed rather than carried. The scaffold drift probe's
`release.yml` line for this delta is RULED (orchestrator-ordered, same class as the `.gitignore`
partial). Note `setup-python@… python-version: "3.14"` **remains** in
`changelog-check.yml` — that is the gate's reader, a different job; `rg -n setup-python .github/workflows/`
distinguishes them.

### 6. The unattributed-entry baseline — provenance, not retyping

CP0 ruled option (a): one pre-gate entry is **tolerated, not fixed**.
`.config/changelog-unattributed-baseline.txt` holds the exact identity bytes of that entry
(`对齐 DSH 0.1.6-alpha.2 并修复本地测试`) behind `#` comments recording WHY it is unattributed:
it landed before the gate and carries no `(#N)` because no PR/issue exists — attributing one would
invent provenance. Extraction was mechanical (via the gate's own `entry_identity`, never retyped),
provable by `cmp` against the file's non-comment lines. Comment form is safe: the gate's
`read_baseline` (`scripts/changelog-gate.py:189-195`) skips `#` lines and `entry_identity`
(`:82-90`) matches the bullet-stripped identity. Gate probe green baselined at landing:
`python3 scripts/changelog-gate.py ledger` → `ledger: pass`.

## Consequences

- Local pushes no longer warn about a stale ledger; the first automatic check is the PR run and
  the durable `main` run is the backstop. Accepted: fast feedback traded for history integrity.
  Revisit predicate: the first stale-ledger push the PR gate catches that the read-only `check`
  probe would have caught — if that recurs, promote `check` into the verify chain, **never** into
  an amending hook.
- The hidden-type rule for sync commits loses its enforcer (it existed to stop the amend-loop);
  `CONTRIBUTING.md` retains the sentence for semantic-release hygiene only.
- The three divergent copies of the old rule (hook, workflow, `CONTRIBUTING.md`) collapse to the
  gate plus one prose pointer.
- **Lockfile integrity of the release path:** in CI, flag-free `pnpm install` is a *frozen*
  install (`frozen-lockfile=true` under `CI`), so a lockfile lagging `package.json` fails the
  release loudly at install. Declared limit: registry reachability from a hosted runner is not
  provable offline — predicate trigger: the first dispatched release; deciding command:
  `gh run view <release-run-id> --log | rg 'ERR_PNPM|Lockfile is up to date'`.
