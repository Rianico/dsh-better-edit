# ADR-0025 — #63 supersedes #24's 0-matched strip arm

Status: RULED (orchestrator, CP3 ticket "Option 1 granted"); landed by p0-impl in-lane 2026-09-26.
Landed as `docs/adr/0025-63-supersedes-24-zero-matched-strip-arm.md` by T8 on 2026-09-26; this file is the durable decision record for the lane.
Revision: `ab713ddf1d76451139257f43761b282143957a30` (branch `audit/p0-61-canon-fallback`).

## The two contract texts

**#24 (issue: "partial hash prefixes copied into content"), as pinned pre-supersession** —
`stripBarePrefixes` (`src/hashline/anchor-pipeline.ts:314-341`) rejected ANY `replace_with` line matching
`HL_BARE_PREFIX_RE` (`^\s*[A-Za-z0-9]{3}│`, `src/hashline/hash-assign.ts:103`), regardless of whether the
3-char prefix is an anchor of the target file: `stripped.length > 0` → `BadAnchorError` (`E_MALFORMED_ANCHOR`),
whole batch aborted, nothing written; the `matched` computation (:320) fed only the message
(:326-329, incl. the `0 matched — verify literal 'HASH│' content` evidence). Pinned by
`test/core/hashline-strict-input.test.ts` describe block "(issue #24)", incl. the tests
"rejects bare prefixes even when the hash is not in the file hash set" and
"reports the replace_with line for each rejected line".

**#63 (issue: over-broad guard misfires on legitimate content), acceptance criteria** — reject only when
"the line-start hash is a real anchor of the current file and matches the served echo at that position"
(reuse `E_SERVED_ECHO` semantics); literal `HASH│` content (`0 matched`) WRITES THROUGH UNCHANGED; on
rejection, state whole-batch rejection + nothing written.

The two texts are in direct conflict on exactly one input class: `replace_with` lines whose 3-char prefix is
NOT in the file's anchor set (`0 matched`). #24: reject. #63: write through.

## The collision (file:line, pre-fix)

- Guard: `src/hashline/anchor-pipeline.ts` — 0-matched arm threw at :337 (second `throw`), rescued only for
  exact echoes at the call-site catch (:1040-1075; `else { throw error; }` :1073); with `served = undefined`
  the rethrow is unconditional (:1041). Even `mode:"literal"` could not pass literal content (bypass lives
  inside `if (echo)`).
- Tests standing on the old contract: `test/core/hashline-strict-input.test.ts:94-105`
  (`ZZZ│one\nZZP│two` → `.toThrow(/E_MALFORMED_ANCHOR/)`, `.toThrow(/0 matched/)`,
  `.toThrow(/literal 'HASH│' content/)`) and `:107-115` (`ZZZ│one\nreal\nZZP│two` → `.toThrow` +
  location report). Full-tree greps (`0 matched`, `ZZZ│`, `ZZP│`) confirmed these were the only
  0-matched pins outside the p063 cell.

## Ruling

Option 1 (deliberate supersession) GRANTED; Option 2 (conditional third design) RULED OUT; Option 3
(leave #63 LIVE) RULED OUT. Conditions: re-pin the two tests to the new contract (never delete); keep the
matched arms pinned from the other side; record this document; non-silent write-through only if expressible
via an EXISTING warning channel. Condition 4 outcome: NOT expressible in-lane — the warning channel is the
registered `DomainWarningCode` set (`src/domain-errors.ts:737` `formatWarning`; existing:
`W_UNICODE_LITERAL`, `W_REVERSED_ANCHORS`, `W_LITERAL_BYPASS`, …); `W_LITERAL_BYPASS` means "declared literal
served-echo under `mode:'literal'`", semantically distinct from "0-matched literal passed"; a new code would
be a new design → surfaced to the orchestrator as a possible own bounded ticket, NOT created.

## Implemented fix (this round)

`src/hashline/anchor-pipeline.ts` `stripBarePrefixes`: after computing `matchedCount`,
`if (matchedCount === 0) return edit;` (UNCHANGED — prefixes intact, no strip), with a comment naming the
supersession; the all-matched and partial arms keep throwing `BadAnchorError`; the now-dead
`0 matched` evidence branch was collapsed to `${matchedCount}/${stripped.length} matched` (reachable only
when `matchedCount >= 1`). Call-site echo routing (:1040-1075, :1098-1116) unchanged and still governs every
line whose prefix IS a file anchor.

## Both-sides evidence (what reddens if each arm returns)

**0-matched side — write-through (#63):**
- `test/core/hashline-p063-literal-pipe-content.test.ts` treatment (`:83` `expect(error).toBeUndefined()` +
  byte assert): reddens if the 0-matched throw returns (the round-3 LIVE carrier).
- `test/core/hashline-strict-input.test.ts` "writes 0-matched bare prefixes through literally — supersedes
  #24's 0-matched arm per #63" and "writes a mixed 0-matched replacement through literally — supersedes #24
  per #63": `result.content` byte equality reddens if the throw returns (a throw makes `applyTool` fail the
  test) or if any implementation starts STRIPPING literal prefixes (bytes differ).

**Matched side — echo guard still throws (#24's surviving half):**
- `hashline-strict-input.test.ts` "rejects bare HASH| prefix in content with E_MALFORMED_ANCHOR" (:8) —
  assertions at :15-17; real file hash, `served = undefined` → the ONLY guard on this route is
  `stripBarePrefixes`' matched throw; deleting it reddens `toThrow(/E_MALFORMED_ANCHOR/)` directly.
- same file :67, :81, :118 ("rejects indented prefix") — matched/partial arms through the same served-free
  seam; each `.toThrow(/\[E_MALFORMED_ANCHOR\]/)` reddens on throw-deletion.
- `test/core/hashline.recovery.test.ts:148` ("rejects bare hash prefix in content_lines with
  E_MALFORMED_ANCHOR") — :160 `toThrow(/\[E_MALFORMED_ANCHOR\]/)` + :171 `toThrow(/stripped "HASH│"
  prefix/)` are the named red carriers.
- `hashline-p063` control (b) (real served echo rejected with both wording asserts + unchanged bytes) —
  honest attribution: it reddens only if BOTH the matched throw AND the call-site echo arms are removed
  (either one alone routes to the same `E_SUSPICIOUS_TEXT` denial); it pins the REFUSAL end-to-end, the
  strict-input/recovery cases pin the strip-arm THROW itself.

## Declared limit — the 0-matched write-through is SILENT (Condition 4)

**Declared limit — a 0-matched `HASH│`-prefixed token in `replace_with` is written through as literal
content without a warning.** The response payload does not distinguish it from an ordinary edit: no produced
warning, no returned flag, no message names the literal-write-through that occurred.

Why it stands: the produced-warning channel is the registered `DomainWarningCode` set
(`src/domain-errors.ts:737` `formatWarning`), and no existing code expresses "0-matched literal written".
Measured at the merged lane tip: `rg -n '0-matched' src/domain-errors.ts` → **0 hits** (RC=1; the gap stands).
The nearest code, `W_LITERAL_BYPASS`, means "declared literal served-ECHO under `mode:'literal'`" — a
semantically distinct input class (real echoes, not 0-matched literals) — so reusing it would mislabel the
event. Adding a code plus registry entry plus arch assertion is a bounded change but a NEW one, deliberately
excluded from this lane at its blast-radius ceiling (orchestrator ruling, CP3).

**Predicate trigger:** this section is stale when a warning code expressing 0-matched-literal write-through
exists in the registry, or the edit response payload otherwise distinguishes the case. **Deciding command:**
the same `rg -n '0-matched' src/domain-errors.ts` above — empty output (RC=1) means the gap stands; any hit
means re-read the registry and update this section. No reader was shimmed at landing: the write-through ships
silent and the gap is recorded, not patched.
