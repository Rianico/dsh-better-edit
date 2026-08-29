# Served-State Range Verification for replace

## Problem Statement

`replace` verifies only its two boundary anchors. If a line strictly inside the range changed after the model last saw it — a human edit in an editor, a formatter-on-save, a code generator — while the boundary lines are untouched, the edit succeeds and the interior change is silently destroyed. The existing mitigations (reread nudges in the guidelines, auto-read after write, post-edit diffs, undo) all refresh what the model *sees*; none narrows what the tool *verifies* — validation still checks only 2 lines. Reread nudges are unreliable: the window between any reread and the next replace always exists.

## Solution

The tool records, per file and per line, the hash it last delivered to the model's context (the **served state**), and `replace` verifies the *entire resolved range* against it before applying. The check is **boundary-anchored span comparison**: the served span between the two anchors' served positions must equal the current resolved span line-for-line. On mismatch the edit is hard-rejected with the current range served back as fresh anchors, so the model retries without a read. The tool owns verification; the model owns intent. No request-schema change, no LLM-visible anchor format change, no model-supplied verification data.

## User Stories

1. As a model editing a file, I want `replace` to verify every line in my range against what the tool last showed me, so that an interior line changed externally between my read and my edit is never silently overwritten.
2. As a model whose edit range contains a line that changed externally since it was served, I want a hard `[E_RANGE_STALE]` rejection naming the first offending line, so that I never apply an edit over content I haven't seen.
3. As a model rejected with `[E_RANGE_STALE]`, I want the current range echoed as fresh `HASH│content` rows, so that I can retry immediately without calling `read`.
4. As a model retrying after a rejection, I want the echoed rows from the rejection to count as serves, so that the retry's range verifies cleanly and reject-and-serve terminates instead of looping.
5. As a model whose range interior contains lines I was never shown (paged reads, disjoint diff hunks, truncated auto-read previews), I want `[E_RANGE_UNSERVED]` plus the current range, so that I never edit lines blind.
6. As a model, I want out-of-range external changes to be tolerated, so that content-anchored edits still succeed when unrelated parts of the file changed.
7. As a model, I want out-of-range changes that shift line positions (deletions or insertions above my range) to be tolerated, so that my content-based anchors survive positional shifts without false rejection.
8. As a model, I want a change-then-revert interior (`b → B → b`) to verify successfully, so that I am not falsely rejected when the file has returned to the state I was shown.
9. As a model, I want an interior line whose content changed externally to *another* content that was served elsewhere in the file (duplicate content) to still be rejected, so that verification stays sound even with repeated lines.
10. As a model, I want a range whose boundary anchor was served at multiple positions (e.g. externally de-duplicating a previously duplicated line) to fail safe rather than guess, so that I am never silently relocated.
11. As a model chaining edits, I want to anchor follow-up edits on post-edit diff rows without re-reading, so that chained edits cost nothing extra.
12. As a model replacing a single line, I want no interior verification overhead, so that single-line edits behave exactly as today.
13. As a model in a fresh session, I want served state to start empty, so that I am never falsely allowed to edit lines served to a previous session's context.
14. As a model, I want the verification to require nothing from me beyond the existing three fields (`remove_from`, `remove_to`, `replacement_text`), so that the tool owns verification and I own intent.
15. As a model, I want a drift notice appended when served territory *outside* my range has changed, so that my context stays honest without a forced re-read.
16. As a model, I want the drift notice to fire once per drift episode, so that subsequent edits do not re-echo the same drifted rows.
17. As a model with auto-read disabled, I want a follow-up edit spanning my own prior change to recover in one reject-and-serve roundtrip, so that correctness holds even without diff serves.
18. As a model, I want drift-notice rows and rejection rows to count as serves, so that lines I have been shown verify cleanly afterward.
19. As a model, I want large-range staleness feedback capped with a pagination hint, so that rejection feedback does not flood my context.
20. As a model, I want the edit preview to surface staleness before I submit, so that I can correct it without an error roundtrip.
21. As a model, I want `undo_last_replace` to keep working unchanged (file-level `[E_UNDO_STALE]`), with its diff rows serving the restored hashes, so that undo and the new verification compose.
22. As a developer, I want served state persisted in the hash store keyed by file and cleared at session start, so that behavior is deterministic across restarts and sessions.
23. As a developer, I want served rows pruned for deleted files alongside snapshots and undo, so that the store does not accumulate stale entries.
24. As a developer, I want the misleading "anchors still match" stub test replaced with a test that actually modifies the file on disk, so that the documented behavior is genuinely tested.
25. As a maintainer, I want the read/replace guidelines updated to present rereading as on-demand recovery, so that models stop paying the reread ritual cost on every edit.
26. As a maintainer, I want the noop replace path to also receive drift notices, so that a noop result still reports context drift.

## Implementation Decisions

1. **Served record storage** — a new per-file, per-position record of served hashes in the hash store (a `served` table alongside snapshots and undo): position-indexed entries holding either a served 3-char hash or a never-served marker. Cleared wholesale at session start; pruned for missing files alongside snapshots and undo. Storing hashes (not content) is sufficient: hashes are content-derived.
2. **Serve surfaces** — the served record is written wherever a row is delivered to the model's context: `read` output rows; auto-read-after-`write` preview rows; post-edit diff rows for `replace` and `undo` (delivered via the `tool_result` handler when auto-read is enabled); and error/rejection feedback rows (`[E_STALE_ANCHOR]` context, `[E_RANGE_STALE]`/`[E_RANGE_UNSERVED]` range echoes). Preview computation (`noPersist`) never writes served state. With auto-read disabled, diff rows are not delivered and therefore not recorded.
3. **Span verification** — a pure verification step in the `replace` apply path, executed on the final resolved range after all autocorrection (reversed-range swap, prefix stripping, boundary-duplicate stripping) and before splicing: locate the served positions of the two boundary hashes; require a contiguous fully-served span between them; compare that served span line-for-line against the current resolved span. Any gap (never-served entry) → `[E_RANGE_UNSERVED]`; any hash inequality → `[E_RANGE_STALE]`; served-side ambiguity (a boundary hash served at multiple positions) or a missing served position → fail-safe rejection. Single-line ranges have no interior and pass trivially.
4. **Error contract** — two codes: `[E_RANGE_STALE]` (served-but-changed) and `[E_RANGE_UNSERVED]` (never-served). Each names the first offending line and echoes the current range as `HASH│content` rows, capped at ~150 lines with a pagination hint past the cap. All echoed rows are recorded as serves — this is what makes retry-without-read terminate. The boundary fail-safe cases of decision 3 (a boundary hash served at multiple positions, or a missing served position) reject with a third code, `[E_RANGE_UNVERIFIED]`, since they are neither stale nor never-served-interior verdicts.
5. **Drift notice** — after a successful `replace` (applied or noop, not `undo`), when served territory outside the resolved range has drifted, append an informational section with the current content of the drifted lines plus the current-file lines immediately around them (capped like `read` output); all shown rows count as serves. Fires once per drift episode: reported drifted hashes are tracked; a later `replace` finding only already-reported drift emits a one-line pointer instead of re-echoing rows, until a `read` re-serves the lines. Drift inside the range is the check's reject path — the two never overlap. The drift scan compares the pre-edit served record (outside the range) against the post-edit file, and must run before the diff-driven served-record update (or against a snapshot of the pre-update record).
6. **Tool contract** — no request-schema change: `replace` still takes only `path`, `remove_from`, `remove_to`, `replacement_text`. No LLM-visible anchor format change. The expectation is reconstructed server-side from what was served.
7. **Guidelines** — update the read/replace guidelines to present rereading as on-demand recovery (only when the model needs information it was never served) rather than a mandatory per-edit ritual.
8. **Architecture** — the served record is injected into the `replace` apply path as a parameter (keeping the path pure and unit-testable); diff/auto-read serve recording lives in the `tool_result` handler where delivery is decided; session clearing lives in the `session_start` handler; error-feedback serves are recorded where errors are produced.
9. **Accepted limits** — the span check is best-effort against a moving target: the file can change between verification and the atomic write (TOCTOU); no atomicity is claimed. Post-race recovery remains `saveUndo` + `[E_UNDO_STALE]`. Self-inflicted staleness (the model mis-tracking information it was served) is not detected — detecting it would require model-submitted data, which the model–tool boundary rejects.

## Testing Decisions

- **What makes a good test**: external behavior only. Drive `read`/`replace` through the tool-execution seam against a real temp directory, mutate the file on disk *between* calls to simulate external changes, and assert on result text / error text / final file state. Never assert on internal served-record contents through tool tests.
- **Primary seam (behavior)**: the tool-execution integration seam (`setupIntegrationTest` + `withTempFile`). Covers all span-check verdicts, both error codes, retry-without-read, drift notices, single-line and noop passes. The data-model edges are constructed via disk manipulation:
  - position shift — external deletion above the range;
  - duplicate-content — external change to content served elsewhere in the file;
  - change-then-revert — `b → B → b` on disk between read and edit;
  - never-served interior — offset/limit paged read, then a range spanning the unseen lines;
  - served-side ambiguity — read a file with duplicate lines, externally delete one duplicate, then edit the span.
- **Handler seam (serve surfaces)**: `tool_result` handler tests for diff-row and auto-read-row serves, including auto-read-disabled non-serve; `session_start` handler tests for served-state clearing. Follow the captured-handlers patterns used by the auto-read and lifecycle tests.
- **Store seam (minimal)**: served-table CRUD, session wipe, and prune-alongside-snapshots/undo, following the hash-store test pattern. Table behavior observable through tools stays at the primary seam.
- **Stub replacement**: replace the misleading snapshot-id stub test with a test that actually modifies the file on disk between read and edit and asserts the intended outcome.
- **Prior art**: the edit / stale-position-compound / chained-edit-anchors / boundary-dup-correction / replace-validation tests (behavior), the auto-read-after-write / auto-read-handler tests (handler seam), the lifecycle tests (session_start), and the hash-store tests (store seam).

## Out of Scope

- **expected_hashes** (model-submitted verification data) — rejected on the model–tool boundary.
- **Multi-version served-state history / LRU** — rejected as subsumed by latest-served-per-line.
- **Per-line epoch counters on anchors** — rejected (change-then-revert false positive).
- **Atomic batch preflight** (validate all edits before any write) — deferred follow-up, enabled by this work.
- **Noop-loop guard** — deferred follow-up.
- **Rebranding** (package metadata / README still carry the upstream identity) — deferred follow-up.
- **Concurrent multi-agent writers on the same file** — workflow-level concern (git worktrees).
- **TOCTOU elimination / atomicity guarantees** — accepted as inherent; best-effort by design.
- **Detection of the model mis-tracking served information** (self-inflicted staleness) — rejected on the model–tool boundary.

## Further Notes

- This spec implements, for this fork, a refined version of upstream issue **YuGiMob/pi-hashline-edit-pro#22** (closed upstream). The fork deliberately diverges from upstream: verification is the tool's responsibility, never the model's.
- Design authority: `docs/adr/0001-served-state-range-verification.md` (status: **accepted**) and the `CONTEXT.md` glossary. Use its vocabulary throughout: *serve, served state, span, served span, range staleness, never-served, reject-and-serve, drift, drift notice, model–tool boundary, anchor philosophy*.
- `docs/absorption-plan.md` is retained for the deferred patterns (batch preflight, noop-loop guard).
- The implementation lands on the `replace_rejection` branch (currently empty).
