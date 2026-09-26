# Merged edit payload with hoisted path

Date: 2026-08-20 (adapted for dsh-better-edit from pi-better-edit)

## Status

accepted (adapted for dsh-better-edit — same hashline algorithm; tool layer is dsh plugin API); supersedes [ADR-0006](0006-compact-json-edit-payload.md) — **that link is a verbatim carry from upstream and does not resolve in this tree; the number now points at an unrelated local ADR. Kept as a historical record, not repointed; see the Amendment**

## Context

The ADR-0006 tuple payload broke `edit` in two ways: `parameters` as a bare array was rejected by OpenAI-compatible transports ("schema must be of type object"), and the object-wrapped `{ "edit": [...] }` shape dropped top-level `path`, which crashed `tool_call` hooks such as pi-permission-lsz that read `event.input.path` on the `edit` tool (`path.isAbsolute(undefined)` → `ERR_INVALID_ARG_TYPE`). Google's Gemini API also requires `items` to be a single schema object, not a tuple array. We needed an object-root schema that keeps tuple token savings and restores the top-level `path` contract.

## Decision

We decided the `edit` tool is the only mutation tool, carrying one uniform payload — `{ "path": ..., "edits": [[remove_from, remove_to, replacement_text], ...] }` — and `batch_edit` is removed. Hoisting `path` to the payload root keeps the tuple token savings (no repeated path or keys), keeps an object-root schema, and restores the implicit contract that a tool named `edit` carries its target path at the top level.

### Considered Options

- **Bare tuple `parameters`** (ADR-0006's first cut): rejected by OpenAI-compatible transports — `type: "array"` root is not a valid function-tool schema.
- **Object-wrapped tuple `{ "edit": [...] }`**: provider-valid, but removes top-level `path`; any `tool_call` hook on `edit` that reads `event.input.path` (pi-permission-lsz) crashes with a Node path `TypeError`. Also rejected by Google's Gemini API, which requires `items` to be a single schema object, not a tuple array.
- **Per-item object items `{ "edits": [{ remove_from, remove_to, replacement_text }] }`**: Gemini-safe but ~13% more tokens on the pinned 12-edit corpus (609 → 702 envelope tokens); deferred until provider-agnostic support is actually required.
- **Keep both `edit` and `batch_edit`**: rejected — fewer tools in context and one uniform contract was the goal (Q3), and two tools with two payload shapes duplicated every prompt, renderer, and handler branch.

## Consequences

- Single-file batches only: one top-level `path` per call; cross-file `batch_edit` items are dropped (two `edit` calls suffice).
- Arity is expressed by `edits.length`; a length-1 array is the single-edit case. Guidance still prefers one edit per call but permits batched edits to the same file.
- Atomicity is per-call: preflight all items, apply, roll back on failure — unchanged from `batch_edit`.
- The nested tuple `items` arrays remain incompatible with Gemini's API; provider-agnostic support (object items) is a known, deferred follow-up.
- Any `tool_call` hook that assumes `edit` input carries top-level `path` keeps working; hooks must still tolerate `null` paths (anchor inference) — pi-permission-lsz is patched to fall through when `path` is not a string.

## Amendment (2026-09-26) — every `ADR-0006` in this file is upstream's, and was never ported

`:7`, `:11` and `:19` all mean `pi-better-edit`'s `0006-compact-json-edit-payload.md`. The link at `:7` is kept as a historical record and is **not** repointed; the prose at `:11`/`:19` is left as written. ADRs are write-once.

- **The link is a verbatim carry.** This ADR adapts `pi-better-edit`'s `docs/adr/0007-merged-edit-payload-hoisted-path.md`: the two `:1` titles are byte-identical (`# Merged edit payload with hoisted path`), and upstream's `:7` reads `accepted; supersedes [ADR-0006](0006-compact-json-edit-payload.md)` — the same supersession tail this file carries. The adaptation clause was inserted into the Status line; the target came across unchanged, so it still names upstream's sequence.
- **The target exists upstream, not here.** At `pi-better-edit@00f8c34`, `git ls-tree --name-only 00f8c34 docs/adr/` lists both `0006-compact-json-edit-payload.md` and `0007-merged-edit-payload-hoisted-path.md`. Upstream `0006`'s title is `# Compact JSON edit payload` (Status `accepted`), added by `5c948dd` (2026-08-17). The two commits that ever added a `docs/adr/*compact-json*` file anywhere in this repository — `5c948dd`, and `b60ad00` which added `0007-compact-json-edit-payload.md` — are **both non-ancestors of HEAD** (`git merge-base --is-ancestor <sha> HEAD` fails for each; `5c948dd` is reachable only from the `pi-better-edit`/`upstream` remotes, `b60ad00` only from `origin/map/sync-upstream`). The superseded sibling was never ported onto this line.
- **Dangling from birth here, not broken by a renumber.** `git blame -L 7,7` attributes the line to `1975a1a` (2026-08-20, `absorb/t6-docs`), whose `docs/adr/` diff adds exactly `0002`, `0003` and `0004` — no `0006`. The link has never resolved against this tree.
- **The number now misresolves, which is why `:7` carries the qualifier.** Local `0006` was allocated independently to `0006-user-facing-drift-signals.md` (`c4a7957`), an unrelated decision about drift-signal audience. A reader who follows the number rather than the filename lands on the wrong ADR. Repointing the link at local `0006` would assert a supersession that never happened, and deleting it would erase the record of what upstream's `0007` replaced — so it stays, annotated.
