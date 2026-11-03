# ADR-0028 — Blocked-hash vocabulary: decline the upstream rename, retire the dead cause member

Status: Accepted (triage of upstream `8ad9a51` + `3e1f6dc`; PR #97, part of issue #95, lane `a245`).
Upstream referents: `pi-better-edit@8ad9a51` — rename tombstone vocabulary to blockedHashes
(upstream ADR-0025) and `pi-better-edit@3e1f6dc` — retire the unused blocked-hash library-seam
signal (upstream ADR-0026). Both ADRs are referents, not text: this record states the downstream
decision only.
Downstream records: `GLOSSARY.md` (`retired anchor`, `retired entry`), [ADR-0013](0013-pos-free-roundtrip-optimization.md),
[ADR-0014](0014-user-model-audience.md), `src/domain-errors.ts` (`RangeCause`),
`src/hashline/anchor-pipeline.ts` (`verifyServedRange` route split),
`test/arch/blocked-hash-vocabulary.test.ts` (the pin).

## Context

One concept, two names. Upstream calls a hash freed by an edit — not reusable while the model may
still hold it, per `(session, path)` — a **blocked hash**; `8ad9a51` is a pure rename from the older
term `tombstone` across identifiers, comments, tests, specs and the `RangeCause` member (renamed
`tombstone` → `blocked-hash`). Six days later `3e1f6dc` deleted that member again, together with the
`ServedVerification` mirror seam (`verify`, `verifyOrThrow`, `throwStaleForBlockedHash`, the
`verifyServedRange` wrappers), because "the sole live `applyEdit` path always carries a defined
lease identity". Upstream's end state is therefore a cause vocabulary with **no** tombstone or
blocked-hash member, reached by a rename that was then undone.

Downstream reached the same concept earlier and spent its rename budget differently: [ADR-0013](0013-pos-free-roundtrip-optimization.md)
renamed `tombstone` to `retired` (`served.retired`, `retired anchor`, `retired entry`), the
`GLOSSARY.md` entry says so and carries an explicit `_Avoid_: tombstone` line, and the live
rejection cause for the concept is `"retirement"`.

State immediately before this ticket:

- `rg -ni tombstone src/` → 3 hits: the `RangeCause` member `"tombstone"` (no producer anywhere in
  `src/`) and two comments in `src/hashline/anchor-pipeline.ts`.
- `rg -ni "blockedHash|blocked hash|blocked-hash" src/ test/` → 0 hits (before this ticket).
- `rg -n "ServedVerification|verifyOrThrow|throwStaleForBlockedHash" src/` → 0 hits.
- The mirror route that `3e1f6dc` deleted upstream is **reachable** downstream: `verifyServedRange`'s
  `leaseSource` is opt-in, and the non-leased position route is the documented fallback for a
  windowed read that never pinned the epoch or a preview/no-store edit that carries no leases. The
  route-split comment states it directly: "The pos-free route is REACHABLE on a normal session
  route … which is why this fallback cannot be dropped."

So the two upstream commits do not transfer symmetrically: the rename target conflicts with a
vocabulary downstream already owns, and the seam deletion would remove a live fallback.

## Decision

1. **Decline the rename `tombstone` → `blockedHashes`.** Downstream already renamed the concept to
   `retired`; installing upstream's name would give one concept two names and contradict the
   glossary's `_Avoid_: tombstone` line rather than satisfy it. The upstream name is banned from
   `src/` by the pin below.
2. **Port the retirement half, in downstream terms.** Delete the dead `"tombstone"` `RangeCause`
   member and rename the two `anchor-pipeline.ts` comments to the `retired` vocabulary. The member
   had no producer, so this is vocabulary hygiene, not behavior. Upstream's end state after
   `3e1f6dc` is also a cause vocabulary with no such member, so the two trees agree on the end state
   even though the intermediate rename is declined.
3. **Decline `3e1f6dc`'s seam deletion.** Downstream's mirror route is live (see the reachability
   note above) and is exercised by `test/core/error-codes.test.ts`, `test/core/lease-resolve-seam.test.ts`
   and `test/core/served-evidence-route.test.ts`. The upstream symbols it removed do not exist here,
   so there is nothing by those names to retire; what they guarded here is a production-reachable
   fallback, and deleting it would trade a live correctness arm for line count.

## Consequences

- `src/` speaks one vocabulary for the concept: `retired` / `retirement`. The glossary claim that
  `retired anchor` "replaces `tombstone` everywhere" is now true of production source.
- `test/arch/blocked-hash-vocabulary.test.ts` makes the ruling refutable: re-adding the legacy word
  or upstream's name under `src/` fails the suite, so a future absorb must amend this ADR
  deliberately instead of drifting back.
- The mirror route stays. Its retirement trigger is concrete: it becomes portable exactly when every
  live edit path carries a lease identity (windowed reads pin the epoch and preview/no-store edits
  gain leases). That is a future observation to look for, not a debt to pay now.
- Out of scope here, and flagged rather than fixed: `RangeCause` also declares `"anchor staleness"`
  and `"served span"` with no producer in `src/`. They name vocabulary terms from
  [ADR-0014](0014-user-model-audience.md), not the freed-hash concept, so this ticket leaves them
  alone; a later vocabulary pass should decide whether they are rendered anywhere or should go too.
- No version bump, no dependency change, no payload-contract change.

## Evidence (decline path, commands and results)

- `rg -ni tombstone src/` — before: `domain-errors.ts:73: | "tombstone"`,
  `hashline/anchor-pipeline.ts:928` and `:1094` comments. After: **0 hits**.
- `rg -ni "blockedHash|blocked hash|blocked-hash" src/` — **0 hits**; outside docs, the only repository mentions are the pin test itself, which must name the banned terms to ban them.
- `rg -n "ServedVerification|verifyOrThrow|throwStaleForBlockedHash" src/` — **0 hits**: the upstream
  library-seam signal has no downstream presence by name.
- `rg -n "leaseSource|mirror route|pos-free route" src/hashline/anchor-pipeline.ts` — the opt-in
  seam plus the reachability note quoted in Context.

## References

- [ADR-0013](0013-pos-free-roundtrip-optimization.md) — `retired` vocabulary and the per-session epoch.
- [ADR-0014](0014-user-model-audience.md) — `details.cause` vocabulary and glossary realignment.
- [ADR-0018](0018-exact-position-served-span-verification.md), [ADR-0019](0019-lease-identity-served-span-resolution.md) — the two verification routes.
- `GLOSSARY.md` — `retired anchor`, `retired entry`, `_Avoid_: tombstone`.
- Upstream `pi-better-edit@8ad9a51` (upstream ADR-0025) and `pi-better-edit@3e1f6dc` (upstream
  ADR-0026) — the commits this record triages.
