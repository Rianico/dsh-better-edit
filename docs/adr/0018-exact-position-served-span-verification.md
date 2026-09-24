# ADR-0018 — Exact-position served-span verification, fail closed

Date: 2026-09-24
Status: accepted; supersedes [ADR-0004](0004-orphaned-serve-healing.md); amended by [ADR-0019](0019-lease-identity-served-span-resolution.md)
Related: `src/hashline/anchor-pipeline.ts` (`verifyServedRange`), `src/session-view.ts`
(`_mergeServedRows`), `src/domain-errors.ts` (`E_STALE_RANGE`, `E_UNSERVED_RANGE`),
`docs/adr/0004-orphaned-serve-healing.md`, upstream ADR `content-addressed-line-identity-mvcc`

## Context

ADR-0004 healed orphaned serves in two places, both silently: an _eager heal_ at the
served-state layer (`_mergeServedRows` nulled the old slot when the same hash was written at a
new position) and _lazy content disambiguation_ at verification (`verifyServedRange`
enumerated candidate `(s,e)` spans filtered by length and content equality, then picked the one
nearest `startLine - 1`), plus a multi-line length-mismatch tolerance (`lenHealed`, `hashline`
`f94fb88`). The two reinforced: new orphans never persisted, and orphans already in the store
stayed recoverable.

The healing was load-bearing for a promise that does not hold. Content-addressed line identity
(ADR-0017; upstream ADR `content-addressed-line-identity-mvcc`) makes an anchor a name for
_content_, not for a position — so when an anchor moved, a look-alike line satisfied every
content-based test the disambiguation applied. Two identical lines are indistinguishable by
digest; only position separates them. Healing therefore could not detect the case it existed to
repair, and its failure mode was silent: the edit re-bound onto the wrong line and reported
success.

## Decision

A served span is verified against the file **exactly**, and anything else fails closed.

### The contract

For a request spanning `startLine..endLine` with boundary anchors `anchor_from` / `anchor_to`:

- each boundary anchor must have **exactly one** served position;
- the served span's length must equal the requested range's length;
- every line's hash must equal the served hash at its served position;
- a boundary anchor whose served position no longer equals its resolved position is **stale**;
- anything else rejects with `ServedRejectionError` — `E_STALE_RANGE`, or `E_UNSERVED_RANGE`
  when a boundary anchor has zero or multiple served positions.

**No look-alike search, ever.** There is no candidate enumeration, no nearest-span ranking, and
no length tolerance: `verifyServedRange` resolves each boundary anchor's single served position
and rejects when the span does not line up.

### What it removes

Both of ADR-0004's arms, and its tolerance:

- the **eager heal** in `_mergeServedRows` — a hash written at a new position now leaves the old
  slot INTACT — and the duplicate is then **served by the next read**, not merely detected at
  verification. Half-true as first written: an _edit_ built from that ambiguous read rejects
  (`E_STALE_RANGE` / `E_UNSERVED_RANGE`), but the read output the user copies anchors from is
  already ambiguous. T3f removed the reject path's own contribution to that slot (Consequences).
- the **lazy content disambiguation** in `verifyServedRange` — the candidate `(s,e)` enumeration
  filtered by length + content equality and ranked by proximity to `startLine - 1` is gone;
- `lenHealed` — the multi-line length-mismatch tolerance (`hashline` `f94fb88`).

ADR-0004 is **superseded** by this ADR.

## Behaviour change

**This is a user-visible behaviour change, and it is the point of the ADR.**

> After a **windowed** read (`offset`/`limit` on a file not yet fully read in that session), an
> edit whose anchor has moved now **rejects with `E_STALE_RANGE` and requires a re-read**, where
> it previously silently re-bound onto a content-identical line.
>
> More generally: the position check is **unconditional**, so _every_ pos-free route now fails
> closed, while a **strict** session (epoch pinned, file changed) already rejected before this
> ADR. An exterior shift that moves the served span therefore now costs a **re-read** rather
> than passing silently — that is ADR-0013's withdrawn promise, and the cost is deliberate.

### Measured: session-level A/B through the real tools

Three cells, driving `read`/`edit` rather than `verifyServedRange` with hand-set `strictPos`:

| #   | route                                                                             | base `ecdf997`             | this revision `3ed4323`    |
| --- | --------------------------------------------------------------------------------- | -------------------------- | -------------------------- |
| A   | full read → exterior insert `@0` → edit the originally-served range               | **REJECT** `E_STALE_RANGE` | **REJECT** `E_STALE_RANGE` |
| B   | windowed read (`offset`/`limit`, never a full read) → same exterior insert → edit | **PASS** (silent re-bind)  | **REJECT** `E_STALE_RANGE` |
| C   | control: full read, no external change → edit                                     | PASS                       | PASS                       |

The full-read route is **unchanged**, which is worth stating because it is easy to infer
otherwise from synthetic parameters: a full read pins the epoch, the exterior write makes
`epoch !== curSnapshotId` (`mutation.ts:152-155`), so `strictPos` was already `true` at base and
the old `strictPos &&` gate already rejected — the base message even reads `(pos-restricted
concurrency)`. The behaviour change is exactly cell B, the epoch-unpinned route.

Why the windowed case is the reachable one: the epoch snapshot id is pinned only on a full read
— `session-view.ts:307`/`:311`, inside `if (isFullRead)`; `upsertEpochSnapshotId` has one caller
and `clearEpochSnapshotId` none; and `isFullRead` requires `rows.length === full.hashes.length`.
A windowed read therefore never pins the epoch, so position trust stays off for that
`(session, path)` and the strict position check applies permanently.

A second route reaches the same state: `curSnapshotId` stays `undefined` when `fileSnap` throws
(`mutation.ts:148-151`).

The position check was made **unconditional** rather than left behind a `strictPos` flag
precisely because the unpinned route is reachable with no flag set — which is the route cell B
measures.

## Why this closed in T3a rather than T3c (T6 timing)

T6 (multi-window read) **adds** read windows. Every added window is another path that leaves the
epoch unpinned, so the exposure would have **multiplied** rather than stayed constant. Closing it
one line before T6 was strictly cheaper than carrying a known silent-rebind exposure into the
checkpoint that widens it. That is the affirmative reason the unconditional position check
(branch (b)) beat deferring to T3c (branch (a)).

## Status of the follow-up work

- **RES-1 is CLOSED in T3a.** It is not outstanding; the fail-closed contract above is its
  resolution.
- **Accepted debt, with a binding on T3c.** `strictPos` is now computed (`mutation.ts:152-155`)
  and passed (`mutation.ts:178`, `mutation/engine.ts:321/694/735`) but **read by nothing** — the
  position check no longer consults it. T3c is **bound** to delete it or subsume it into
  lease-derived position trust, and to resolve the `epochSnapshotId`/`curSnapshotId` interface
  fields (`anchor-pipeline.ts:593-594`) and their `applyEdit` passthrough (`:1043-1045`).
  **Anything still computed-but-unread after T3c is a blocking finding for T3c.**

  **Discharged in T3c.** `strictPos` and the `epochSnapshotId`/`curSnapshotId` interface fields were
  deleted in CP1-r1 (`6272e09`) — `rg -n 'strictPos|EpochSnapshotId|epochSnapshotId|curSnapshotId' src/ test/ tests/`
  → 0 hits — and the position check is no longer the sole staleness instrument on
  the live edit path: [ADR-0019](0019-lease-identity-served-span-resolution.md) replaces it with line
  identity wherever a `LeaseSpanSource` exists, and keeps it as the fallback everywhere else. The
  paragraph above is left as written.

## Relationship to upstream

Upstream's ADR-0016, `content-addressed-line-identity-mvcc`, is both why this contract is
meaningful and why healing was attractive. Content-addressed identity is what lets a lease
survive the edit that reassigns anchors — and it is also what made healing look safe, because a
moved anchor still names the same content. It is not safe: the digest cannot separate two
identical lines, so position is the only discriminator. This ADR keeps upstream's identity model
(ported in ADR-0017) and rejects upstream's healing.

## Considered Options

- **Keep healing and mark the result** (surface it as drift, or attach a healed-span notice to
  the response) — rejected. It still re-binds silently onto a look-alike line: a content digest
  cannot distinguish two identical lines, so the tool cannot know it healed the wrong span, and
  marking a result the tool cannot verify is not a safety property. Fail closed and re-read.
- **Keep healing behind a flag** (strict only when concurrency is suspected) — rejected: the
  windowed route reaches the unpinned state with no concurrency involved, so the flag would be
  off in exactly the reachable case.
- **Defer to T3c** — rejected on the T6 timing argument above.

## Consequences

- Silent rebinds become visible rejections. The cost is a re-read; the alternative was a
  successful edit to the wrong line.
- `E_UNSERVED_RANGE` gains a second producer (duplicate served positions) and stays a live code
  rather than the retiring one it was expected to become.
- The served mirror can hold a stale slot indefinitely — nothing nulls it. That is deliberate:
  the duplicate is the evidence, and deleting it here is the heal this ADR removes. Two
  producers can leave that slot. An **out-of-band file write** still does — the exact-write rule
  leaves the old slot intact when the _file_ changes behind the served mirror, and the next read
  serves the duplicate. The **reject path's echo write** did, and T3f removed it: `recordEchoServes`
  re-committed the rejection's current-range rows, which is what left the slot that the next read
  turned into a duplicate anchor.
- **A rejected edit is observably a no-op for the next read** (T3f, the invariant the
  fail-closed contract above needed). A rejection rethrows with the current-range echo and
  records/grants nothing: the served rows are byte-identical before and after, no lease row
  appears, and every grant field (`snapshotHash`, `lineId`, `lineNumber`, `canonHash`) is
  unchanged. The next fresh read's anchor list is byte-identical to the control that performs the
  same external change with no intervening rejected edit. The recovery is the re-read the message
  already instructs; the reject sites now only render the echo into the error message.
- **`retiredAt` is a different mechanism, not an exception to the bullet above.** The edit
  pipeline calls `normFromText` (`src/mutation.ts:125`) **before** `applyOne` (`:149`). That
  normalization persists a snapshot of the file as it is on disk, and `commitSnapshot` retires
  every live lease for the path whose `line_id` left that snapshot (`retireAbsentLeases`,
  `src/snapshot-store/lineage-store.ts:478` — a path this change did not touch). Measured
  positively: the same `normFromText` call retires the lease with **no edit and no rejection at
  all** (the `norm-only` arm: `f9U.retiredAt` `null → 1790264335193`). Nothing on the reject path
  owns it. The non-rejecting arms do not _show_ it because something follows the normalization and
  revives the row — a read/serve re-commits with leases, and a passing edit's serve does the same
  (the `accept` arm retires a different lease instead). A rejection is simply the one path where
  nothing follows. Where the external change preserves every served `line_id` — the insert-only
  and windowed cells — nothing is retired at all and the byte-identity above holds _including_
  `retiredAt`; those two cells are the contrast that makes the attribution visible. Assert
  observable equivalence, not global immutability.
- **The live writer was the in-loop collector, not the sequential arrow** (T3f, corrected
  attribution). The tool path is `src/tool-edit.ts:166` → `execute` (`src/mutation.ts:371`) →
  `applySequence` (`:382`, defined `:506`) → `runFileEdits` (`:511` → `src/mutation/engine.ts:711`),
  whose `applyOne` (`engine.ts:285`) fail callback routes `AnchorMismatchError |
ServedRejectionError` through `collectAbortPart` (`engine.ts:512`, called at `:806` and `:851`)
  and rethrows a batch-abort envelope — so a **single**-edit rejection was the live producer of the
  stale slot. Its pre-fix `recordEchoServes` call sat at `engine.ts:549` at base `4efa43a`.
- **Two of the four removed sites were dead on arrival**, belonging to an orphaned single-edit
  flavor: `src/mutation.ts:179` at base `4efa43a` — the anonymous arrow passed as `applyOne`'s
  `onReject` argument (`engine.ts:287`, invoked `:303`/`:324`) inside `execPipeline`
  (`src/mutation.ts:91`), reached only via `applySingle` (`:491` → `:502`), which has **zero** `src/`
  callers — and `enforceNoopLoop`'s `index === undefined` branch (base `engine.ts:443`;
  `engine.ts:429`; deleted by T3h), because `PreparedItem.index` is **required** (`engine.ts:109`) and the sole
  production call site (`:895`) passes `item.index` (`:901`); `NoopLoopOptions.index?` (`:409`,
  "undefined = single-edit flavor") and `NoopLoopOptions.range?` (`:415`, "Single-edit flavor only")
  exist only for that dead flavor. Base `4efa43a` had exactly four `recordEchoServes` call sites:
  `mutation.ts:179`, `engine.ts:443`, `:475`, `:549`. Do not read them as four live paths. Both
  orphaned symbols named in this bullet are deleted in T3h — see the closure below.
- **Orphaned single-edit flavor — CLOSED by T3h.** Deleted from `src/`: `PipelineResult` and
  `ExecPipelineOptions` (base `f3ffe7a` `src/mutation.ts:64`/`:84`), `execPipeline` (`:91`), and
  `applySingle` (`:491`); `enforceNoopLoop`'s `index === undefined` branch (`engine.ts:444` at base) and
  the `NoopLoopOptions` fields that existed only for it (`absolutePath`, `replaceWith`, `sessionKey`,
  `range?`, `originalHashes`). Measured with `git diff --numstat f3ffe7a..HEAD`: `src/mutation.ts`
  −185 lines, `src/mutation/engine.ts` −42. Deleted from the
  tests: the direct-call seam cells that pinned it by hand — base `serve-leases.test.ts:883`/`:904`,
  `coverage-agent-a-mutation.test.ts:49`/`:85`/`:159`, `coverage-agent-g-mutation-sandbox.test.ts:32`,
  `coverage-agent-c-edit-engine.test.ts:244`/`:261`/`:276`, `lease-resolve-seam.test.ts:155`,
  `epoch-lifecycle.test.ts:81` — `test/` 25 added / 470 deleted (net −445, same numstat), plus one live
  replacement cell: a malformed anchor on
  an existing file now rejects through the tool and writes nothing. The lesson stands and is _why_ this
  ledger exists: an agent can "fix" a dead path, watch it go green, and believe the live path was
  exercised. The trap that lesson warns about is code-free — the flavor is gone from `src/`, from
  `test/`, and from `tests/`.
- **Mutation ledger — historical measurement at `735df10`** (mutation = re-adding the write at one
  isolated site; cells in `test/core/serve-leases.test.ts`). Legend at that revision — C1 twin records
  (`:764`), C2 twin grants (`:771`), C3 twin read ≡ control (`:804`), C4 insert-only (`:813`), C5
  windowed (`:827`), C6 noop-loop (`:841`), C7 consecutive rejections (`:860`), C8 batch abort
  (`:872`). The `C9`/`C10` legend entries and the `M3`/`M5` rows are dropped from this table: T3h
  deleted the orphaned single-edit flavor those two sites — and the two direct-call cells that pinned
  them — belonged to, so neither has a subject at HEAD. Raw per-cell output:
  `evidence/cp1r3-ledger-runs.txt`.

  | mutation | site                                                                                    | RED                  | GREEN (reason)                                                                                          |
  | -------- | --------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
  | M1       | `collectAbortPart` (`engine.ts:512` at `735df10`) — full write, rows + snapshot context | 7: C1–C5, C7, C8     | C6 — site isolation                                                                                     |
  | M2       | same site — rows only, no snapshot context                                              | 6: C1, C3–C5, C7, C8 | **C2 — by design**: rows without the context grant nothing, so C2 pins the _grant_; C6 — site isolation |
  | M4       | `enforceNoopLoop` batch branch (`engine.ts:457` at `735df10`) — full write              | 1: C6                | C1–C5, C7, C8 — site isolation                                                                          |
  | M6       | ≡ M1 — same site, same mutation, observed through the batch-abort driver C8             | (as M1)              | (as M1)                                                                                                 |

  **M1 ≡ M6**: one measurement with two driver classes, not two mutations. At `735df10` the ledger had
  **five** distinct sites; three survive at HEAD (next bullet). The five pre-existing happy-path cells
  (`read`, `diff`, `truncated`, `undo`, `bind`) stay green under every mutation.

- **Current ledger at HEAD.** Same recipe (re-add the write at one isolated site, revert); line numbers
  re-derived with `rg -n` at this revision rather than copied. Cells are `test/core/serve-leases.test.ts`.
  The surviving pins this ledger is measured against are the live noop-loop cell (`:697`) and the
  batch-abort cell (`:728`):
  - **M1 ≡ M6 → `collectAbortPart`** (`src/mutation/engine.ts:492`; called from the pre-pass at `:786`
    and from `applyOne`'s fail callback at `:831`). RED: the batch-abort cell (`:728`) and the other
    live rejection cells the `735df10` run measured — C1 (`:620`), C3 (`:660`), C4 (`:669`), C5
    (`:683`), C7 (`:716`). The noop-loop cell is **not** this site (the guard throws from the loop body,
    outside `collectAbortPart`); T3h's CP2 ticket groups it with this row, and CP3's re-run is the
    authority for the current RED set.
  - **M2 → the same site, rows only, no snapshot context.** GREEN on C2
    (`"twin rejection grants nothing — no grant field changes, no new lease appears"`, `:627`) **by
    design**: rows without the context grant nothing, so that cell pins the _grant_, not the write.
  - **M4 → the batch noop branch, now expressed at the guard's call site.** `enforceNoopLoop` is called
    once, from `src/mutation/engine.ts:875`, passing `index: item.index` (`:879`); the branch it arms is
    `:437`. The guard no longer receives a `sessionKey` or an `absolutePath` — orphan-only
    fields, deleted by T3h — so the M4 recipe anchors at that call site instead of inside the guard.
    RED on the live noop-loop cell (`:697`).

- **Two commits were required for the defect to be observable — a lesson.** T2b `510af05` made
  the reject path _write_ served rows (the stale slot); T3a `b623aa8` removed the eager orphan
  heal that had been nulling it. At T2b's head the heal masked the slot — labels churned, no
  duplicate — so the duplicate is observable only with **both** present. A defect can be created
  by one change and become _reachable_ by a later, correct one; neither commit alone reproduces it.
- `_mergeServedRows` becomes a pure merge with no disambiguation; the exact-write rule is now
  the only rule.

## Reproduce

Both numeric claims in this ADR are re-derivable from the archived instruments. `src/` blobs are
identical across `735df10`, `998fd43` and `39351d9` (`mutation.ts` `c8b6c039…`, `engine.ts`
`0dc0e78c…`), so every number below transfers across those revisions without re-running.

**Mutation ledger** (the historical table plus the current ledger). Recipe: re-add the write at exactly
one isolated site, run the contract file, revert. The recipes are the committed exact-string edits in
`test/tools/mutate-ledger.mjs` (T3h subsection below) — `M1`/`M2` = `collectAbortPart` with and
`M4` = `enforceNoopLoop`'s batch branch. **`M3`/`M5` are historical**: their sites — the orphaned
single-edit branch and the sequential arrow — were deleted by T3h, so those two recipes no longer apply
to HEAD. `M4`'s site moved with the code: the guard is called once, at `src/mutation/engine.ts:875`,
and no longer receives a `sessionKey`/`absolutePath`, so the recipe anchors at that call site. It was
measured RED on C6 (`test/core/serve-leases.test.ts:697`) by the CP1 reviewer at `f3ffe7a`+deletion
(`evidence/cp1-tm-mutant-logs/`); CP3 re-runs it.

```
python3 evidence/probes/mutate.py.txt M4                    # one recipe; asserts exactly one match
pnpm exec vitest run test/core/serve-leases.test.ts --reporter=verbose
git checkout -- src/mutation.ts src/mutation/engine.ts      # revert; git diff --quiet 998fd43 -- src/ must exit 0
```

Historical, at `735df10`. Expected output shape: baseline `15 passed`; `M1` `7 failed`, `M2` `6 failed`,
`M3`/`M4`/`M5` `1 failed` each, with the failing cell names matching the RED column above and the five
happy-path cells green in every run. Raw per-cell output: `evidence/cp1r3-ledger-runs.txt`. At HEAD the
contract file holds `14` cells (`rg -c '^  it\(' test/core/serve-leases.test.ts`).

### T3h ledger — re-run it from the tree

`test/tools/mutate-ledger.mjs` is the committed applier and runner (T3h CP3-r4). It archives HEAD into a
temp tree, mutates the **copy** — the worktree is never written to — asserts every anchor occurs exactly
once, prints `applied <id>`, greps the inserted line back out of the mutated file, runs vitest there, and
compares the failing cells against the expected set below (`RED SET MATCH`, or `MISMATCH` + the diff and a
non-zero exit). It refuses to run when `git status --porcelain -- src test docs` is non-empty.

```
node test/tools/mutate-ledger.mjs --list     # ids, scopes, expected RED counts
node test/tools/mutate-ledger.mjs M4         # one mutant, contract file
node test/tools/mutate-ledger.mjs Z3b        # full suite
node test/tools/mutate-ledger.mjs N1 --keep  # keep the temp tree and the vitest log
```

| id  | file                              | anchor (old)                                                                                               | new                                                                                                                                                                             | scope                            | expected RED |
| --- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------ |
| M1  | `src/mutation/engine.ts`          | `        : undefined;` + `  const originalLines = splitLines(opts.originalNormalized);`                    | same, with `await recordServed(opts.sessionKey, opts.absolutePath, echoRows ?? [], opts.originalHashes.length, { content, hashes });` inserted after `: undefined;`             | `test/core/serve-leases.test.ts` | 7            |
| M2  | same                              | same                                                                                                       | M1 without the snapshot context (rows and hash count only)                                                                                                                      | same                             | 6            |
| M4  | same                              | `      const notice = await enforceNoopLoop({`                                                             | `await recordServed(opts.sessionKey, absolutePath, echoRowsForItem(applied.edit, originalHashes) ?? [], originalHashes.length, { content, hashes });` inserted before that line | same                             | 1            |
| N1  | `src/hashline/anchor-pipeline.ts` | `if (trimmed.length === ANCHOR_LEN && ALPH_RE.test(trimmed)) {`                                            | the same line with the two conditions OR-ed                                                                                                                                     | same                             | 1            |
| Z3b | `src/mutation/engine.ts`          | `  if (count >= NOOP_LOOP_THRESHOLD) {` + `    const originalLines = splitLines(opts.originalNormalized);` | `throw new Error("Z3b");` inserted between them                                                                                                                                 | full suite                       | 6            |

`M1`/`M2`/`M4` each begin with the shared import pre-edit (`  retireAnchors,` → `  retireAnchors,` +
`  recordServed,` in the `../session-view.js` import). Expected RED sets, by exact title, are the
`test/core/serve-leases.test.ts` cells `M1` `:620`, `:627`, `:660`, `:669`, `:683`, `:716`, `:728` (`M2`
is that set minus `:627`), the live noop-loop cell (`:697`) for `M4`, the malformed cell (`:739`) for
`N1`, and the three `coverage-agent-c` batch cells plus three live cells for `Z3b`.

**N1 does not prove the nothing-written asserts.** Under N1 the RED is the _cause_ assertion — `:758`
(`/E_BATCH_ABORT/`) **passes** because the envelope survives, `:759` (`/E_MALFORMED_ANCHOR/`) **fails** on
the received `[E_STALE_ANCHOR]`, and the two nothing-written asserts (`:760-761`) are **not reached**. N1
proves the envelope-and-cause assertion is refutable; it says nothing about the nothing-written semantics.

**Scope note (Z3b).** The pre-deletion full-suite Z3b from CP1 lives in the handoff's
`evidence/cp1-tm-mutant-logs/` — see its `PRE-DELETION.md`, which scopes every log in that directory to
`f3ffe7a` — and must not be cited as deletion-safe evidence. The post-deletion full-suite Z3b is the
handoff's `evidence/cp3-tm-runs/log-Z3b-FULL-HEAD.txt` → `Test Files 4 failed | 137 passed (141)` /
`Tests 6 failed | 1497 passed (1503)`; `node test/tools/mutate-ledger.mjs Z3b` re-derives it.

**`retiredAt` arms.** Probe `evidence/probes/tm-retiredat-control.test.ts.txt`; copy it to
`.tmp/t3f/tm-retiredat-control.test.ts` (vitest collects `.tmp/**/*.test.ts`) and run from the worktree
root:

```
T3F_EVIDENCE_OUT=/tmp/retiredat.txt pnpm exec vitest run .tmp/t3f/tm-retiredat-control.test.ts
```

It drives the twin fixture through the real tool path and prints `RETIRED_BEFORE` /
`RETIRED_AFTER_STEP` / `RETIRED_AFTER_READ2` per arm. Arms and outcomes (raw:
`evidence/tm-retiredat-control-raw.txt`, the orchestrator's run on the same `src/` blobs — the raw file
carries no revision header): **S1 reject** → `f9U.retiredAt 1790264335105`; **S2 accept** (an edit that
applies) → `f9U` stays live and `EyS.retiredAt` flips instead; **S4 accept-delete-twin** → `f9U` flips
too, from an accepted edit; **S3 no-edit** → nothing flips; **S5 norm-only** — no edit, no rejection,
only the `normFromText` call (`src/mutation.ts:125`) — → `f9U.retiredAt 1790264335193`. S5 is the proof
that the retirement is path-independent; S1 is observable only because nothing follows the
normalization to revive the row.
