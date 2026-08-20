# Merged edit payload with hoisted path

Date: 2026-08-20 (adapted for dsh-better-edit from pi-better-edit)

## Status

accepted (adapted for dsh-better-edit — same hashline algorithm; tool layer is dsh plugin API); supersedes [ADR-0006](0006-compact-json-edit-payload.md)

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
