# ADR-0029 — Windowed read projection: overlapping windows merge into their union

Status: Accepted (fix for #106, lane `fix/106-window-merge`).
Related: [ADR-0023](0023-multi-window-read-declined.md) — the decline record for multi-window reads,
superseded by its own §FU-6 amendment, which ported the feature. That amendment covers the port, not
the projection contract, so this record is filed separately rather than as a second amendment there.
[ADR-0027](0027-single-projection-collapse-contract.md) — `projection` / `source of truth`
vocabulary reused below.
Downstream records: `src/file-view.ts` (`buildWindowedPreview`, `mergeWindowRuns`),
`src/tool-read.ts` (`windows` description), `test/tools/read-windows.test.ts` (the pins).

## Context

The `windows` port (§FU-6, upstream `pi-better-edit@2334352`) renders one section per requested
window from that window's own unfiltered slice, while `served` is filled from a
`hashByPosition` map — a dedupe. Text and the served mirror were therefore produced under two
different rules, so the projection could show more than the mirror recorded. Measured on the tree at
`009b922` (v1.2.1), all three probes deterministic:

| request                                                 | rendered rows | unique rows | `served` | other                                                                                                                                                                       |
| ------------------------------------------------------- | ------------- | ----------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[{offset:1,limit:10},{offset:5,limit:11}]` on 20 lines | 21            | 15          | 15       | lines 5–10 rendered twice, identical anchors, under two headers                                                                                                             |
| `[{1,10},{3,4}]`                                        | 14            | 10          | 10       | the interior window re-renders lines 3–6 under its own header                                                                                                               |
| 16 × `{1,200}` on 200 lines                             | 2000          | 200         | 200      | **6** sections print `[Read budget exhausted; this window is not shown.]`, and `truncation = {truncated:true, truncatedBy:"lines", maxLines:0}`, with zero unique rows lost |

The old doc comment claimed the opposite of the payload ("overlapping windows collapse to one
served row per line") — true of the mirror, false of the text. The third row is the same defect
charging the shared budget twice for bytes nobody needed.

## Decision

1. **Merge inside one call.** Within a single `read` call, the requested intervals merge into their
   union and each maximal contiguous span of that union renders exactly once. Sections are those
   runs, ordered by first appearance in the request; disjoint windows keep one section each and an
   unchanged order.
2. **Touching intervals coalesce.** `[{1,2},{3,4}]` is one run `1-4`: no gap exists between them, so
   a second header would frame nothing.
3. **A header names the run it shows,** taken from the run's span, never the literal window.
4. **A past-EOF window contributes no interval** and keeps today's message at its caller slot. It
   orders sections but is not a coalescing barrier, so `[{1,2},{99,1},{3,4}]` yields one run `1-4`
   (order 0) followed by the message (order 1).
5. **One build, one record.** Text and `served` now derive from the same per-run slice, so the
   position record is injective by construction rather than by dedupe.
6. **No cross-call dedupe.** Across calls nothing is ever withheld: a re-read of the same range
   renders and re-serves it again. Re-reading is how anchors refresh.
7. **A starved section says "this section is not shown"**, not "this window", because a run can
   merge several windows.

Runs are contiguous, which is why no section builder changes: both derive
`position = startLine - 1 + index` and assume a single slice.

## Rejected alternatives

- **Skip-and-notify** — render only not-yet-rendered positions and add a bracket notice per skipped
  run. Honest, but it costs three new surfaces (a notice vocabulary, non-contiguous row support,
  a separate budget rule) for no information gain over the union. An interior window such as
  `[{5,2},{1,10}]` would render 1–4, skip 5–6, render 7–10 and silently mis-position every served
  row unless each row carried its own position.
- **Per-window headers over clipped ranges** — keep `=== Lines 5-15 ===` but render only its unseen
  rows. A header naming lines it does not show is the same honesty defect in a quieter form.
- **Reject overlapping windows with `E_BAD_PAYLOAD`** — narrows a contract ADR-0023 §FU-6
  deliberately took permissive, and the caller cannot know its ranges overlap before asking.

## Consequences

- The projection can no longer exceed the mirror: duplicated bytes are never rendered, so they never
  debit the shared budget either. The 16 × `{1,200}` probe loses its six false starvations and its
  false `truncated: true` with no separate budget rule.
- A header may name lines the caller did not literally request, and a fully covered window has no
  section of its own — for overlapping requests the union span is the honest answer to "what did I
  get".
- `served` keeps its meaning and contains the same positions whenever the budget does not starve a
  section; where duplicates used to starve a distinct later window, that window now renders and is
  served: strictly additive. No lease, rejection-payload, builder or architecture-cell change, and
  no `E_BAD_PAYLOAD`, `MAX_READ_WINDOWS` or `windows: []` → full-read change.
- The tool description gains one clause so the merge rule is discoverable to the model.
- Upstream shares the defect at its v2.18.1 checkout (the 20-line probe renders 21 rows / 15 unique
  there too); its `mergeRanges` walk (`d272b1c`) is a paging optimisation that hands every window its
  rows back byte for byte, so there is no referent to port. Offering this upstream is a follow-up,
  not part of this record.

## Evidence

- `[{1,10},{5,11}]` on 20 lines → one header `=== Lines 1-15 of 20 ===`, 15 rendered rows,
  `served` 0..14, row↔hash agreement (`renders an overlapping pair once, over its union`).
- 16 × `{1,200}` on 200 lines → one section, 200 rows, `served` 200, `truncation` undefined
  (`collapses sixteen identical windows to one section and charges the budget once`).
- `[{5,2},{1,10}]` → one section `1-10`, `served` 0..9 — the cell that reddens if a non-contiguous
  row list ever reaches a builder (`keeps served positions aligned when an interior window merges away`).
- Disjoint `[{1,3},{10,11}]` and its reverse → two sections, caller order preserved, `served`
  position-sorted (`keeps disjoint windows as separate sections in caller order`).
- Two sequential reads of `[{1,3}]` → both render and re-serve, and the second call's anchors resolve
  (`re-renders and re-serves the same window across two calls`).
- Genuine starvation on disjoint windows still reports `truncated: true` and serves nothing for the
  starved section (`spends one shared budget across every window`).

## References

- [ADR-0023](0023-multi-window-read-declined.md) — the multi-window decline, §FU-6 amendment (the port).
- [ADR-0027](0027-single-projection-collapse-contract.md) — single-projection / source-of-truth vocabulary.
- `src/file-view.ts` — `mergeWindowRuns`, `buildWindowedPreview`, `windowHeader`.
- `test/tools/read-windows.test.ts` — the cells listed under Evidence.
