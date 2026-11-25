# ADR-0045 — Strict span mode: a policy axis beside the served-evidence route

Date: 2026-11-24

## Status

accepted (opt-in; default `hint` keeps the shipped acceptance semantics)

## Context

The read guard promised that a line the model never saw is never edited. The leased route cannot prove that promise: `verifyRebasedSpan` verifies the two boundary leases and the window length, and upstream ADR-0024 decision 1 deliberately accepts an interior `null` slot — an unread interior row carries no identity to verify, and the two verified boundaries already fix the span's extent. A still-valid boundary pair can therefore authorize a replacement across lines the model never saw. That is the contract defect #141: the docs claimed a refusal the route never performed. Prompt-only mitigation ("read contiguously") is advisory; it cannot make the acceptance decision.

Upstream `feeef35` (`feat(edit): dual-mode span verification & disclosure`, PR #309, closes #301) ships the same ladder with an env/settings knob, so the mechanism is measured upstream rather than invented here.

## Decision

- **One policy, owned by the profile.** `spanMode: hint|strict` in `$DSH_HOME/plugins/dsh-better-edit/config.yaml`, overridden by `DSH_BETTER_EDIT_SPAN_MODE`, default `hint`. There is no per-call override: the policy belongs to the profile, so one call cannot lower a guard the operator chose.
- **Beside the route, not inside it.** `refusesInteriorHole = spanMode === "strict" && acceptsInteriorHole(route, k, servedLen)` (`src/hashline/served-evidence.ts`). The `ServedEvidenceRoute` union keeps answering what the evidence can prove; the mode answers what acceptance tolerates. Neither absorbs the other, and the mirror route's own interior scan is untouched.
- **Strict collects, the gate adjudicates.** Verification gathers the interior nulls while the existing gate keeps running, so a concrete staleness still wins with its own code and rows. Only when nothing stronger fired does the edit throw ONE rowless `[E_UNSERVED_RANGE]` (`unservedKind: "interior"`, empty rows and block) with the count-versus-span summary — `N of the M file lines it replaces was|were never served.` — and the absolute file lines ascending, run-compressed, capped at 8 runs with ` (+K more lines)`; a single line renders `Unserved file line: N`.
- **Boundaries keep their own diagnosis.** A `null` boundary is the named anchor itself and keeps `[E_STALE_RANGE]`; the mirror route keeps its interior scan and never consults the mode.
- **Hint acceptance is byte-identical.** The edit is accepted exactly as before; the diff blanks the unserved removed row's gutter (`-   │content`), a folded deletion appends ` (N unserved)` to its `[N lines deleted]` marker, and each committed file carries one applied-tier `[MODEL] [W_UNSERVED_INTERIOR]`. No extra refusal, no extra round trip.
- **Rejected alternatives.** A per-call flag would let the caller that benefits from the looser route choose it; a default flip to `strict` would change shipped acceptance for every profile that never asked for it; encoding the policy in the route union would conflate what evidence proves with what the operator tolerates, and the mirror route would need a second copy of the rule.

## Consequences

The default acceptance path is unchanged, so no existing profile loses an edit and no retry budget moves. Two architecture pins move with the new producer and the new warning: `test/arch/range-family-signal.test.ts` expects `E_UNSERVED_RANGE` at 3 sites, and `test/arch/warning-audience.test.ts` gains the `W_UNSERVED_INTERIOR` fixture so the audience oracle still renders every warning. Both READMEs and `GLOSSARY.md` now state the boundary/interior truth instead of a blanket refusal; the #141 claim is gone. Strict is judged per edit against the served record, and a line served once stays served.

## What this deliberately does not do

- It does not add extra interior content verification on the leased route — there is no identity to verify, and inventing one would re-tax the correct edit upstream measured at 8/242 calls.
- It does not add a per-call override.
- It does not change the default.
- It does not add a pi-lens command surface — downstream has no bridge to extend.

## References

- #144 — this change.
- #141 — the false blanket-refusal promise this ADR retires.
- upstream `pi-better-edit@feeef35` (`feat(edit): dual-mode span verification & disclosure`, PR #309, closes #301) — the implementing source.
- `Rianico/pi-better-edit#319` — downstream-filed refinement request for the strict refusal message shape (summary + run-compressed capped list); open, not implemented upstream.
- upstream ADR-0024 decision 1 — interior `null` slots are accepted on the leased route.
- ADR-0037 — the served-evidence seam; this ADR adds a policy axis beside it, not a second entry point.

## Amendment (2026-11-25, #223)

Hint now feeds the same formatter as strict (`src/unserved-span-message.ts`). The hint
`[W_UNSERVED_INTERIOR]` names the replaced file-line count, the unserved count and the exact
absolute file lines as compressed runs; it no longer prints the min..max envelope that could name a
served line. Strict's facts are unchanged: the same path, denominator, counts and list, and the
same eight-run cap. The capped remainder now agrees in number — `(+1 more line)` when one line is
hidden. See [ADR-0053](0053-unserved-interior-one-formatter.md).
