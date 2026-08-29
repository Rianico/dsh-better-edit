# Compact JSON Edit Payload Specification

**Status:** superseded by [ADR-0007](../adr/0007-merged-edit-payload-hoisted-path.md)
**Decision:** [ADR-0006](../adr/0006-compact-json-edit-payload.md) — see [merged-edit-payload.md](merged-edit-payload.md) for the current contract.

## Goal

Reduce repeated JSON keys in model-facing edit calls without changing the verified edit protocol. The tool remains responsible for resolving anchors, checking served state, rejecting stale or unseen ranges, and applying writes atomically.

## Public contracts

### Single `edit`

The model-facing payload is an object-root schema containing one fixed three-position JSON tuple:

```json
{
  "edit": ["src/file.ts", ["abx", "sdc"], "replacement text"]
}
```

Positions inside `edit` are:

1. `path`: a non-empty string, or `null` to invoke the existing unique anchor-based path resolution;
2. `range`: a two-element array `[remove_from, remove_to]` of 3-character anchor strings, inclusive at both ends;
3. `replacement_text`: the complete replacement text. An empty string deletes the range.

The root object must contain only `edit`, and the tuple must have exactly three positions. Missing positions, extra positions, wrong JSON types, empty paths, malformed anchors, and ambiguous path resolution are rejected with the existing `[E_BAD_SHAPE]`/anchor error conventions.

### `batch_edit`

The model-facing payload is an object-root schema containing a `batch` array:

```json
{
  "batch": [
    ["src/a.ts", ["abx", "sdc"], "first replacement"],
    [null, ["qwe", "rty"], "second replacement"]
  ]
}
```

Each item is the same fixed three-position tuple as `edit`. Existing batch limits, ordering, overlap checks, served-range verification, all-or-nothing writes, rollback, and persisted undo remain unchanged.

## Normalization and safety

- Both public shapes normalize into the existing internal edit representation before mutation.
- `null` path is normalized through the existing `resolveMissingPath` behavior; it does not create a variable-arity tuple.
- The range array is normalized to the existing `remove_from` and `remove_to` fields.
- No model-supplied digest, expected-hash list, force flag, fuzzy matching, silent remapping, or recovery merge is added.
- Rejection feedback continues to serve fresh rows, so a retry does not require a read.
- The old named-object single-edit and batch-item shapes are not accepted by the new contract.

## Non-goals

- No new tools.
- No exposed format configuration or automatic format detection.
- No textual patch language in this change. Unified diff may be considered later as an explicit interoperability adapter, but it must not bypass served-state verification or enable fuzzy relocation.
- No block operations, registers, file moves/removals, or syntax-aware structural edits.

## Test seams

Tests must exercise public tool schemas and execution seams, not private parser helpers:

- valid single tuple applies the intended replacement;
- `null` path resolves a unique file from the two anchors;
- malformed tuple arity and member types reject before mutation;
- empty replacement preserves deletion behavior;
- old named-object payload is rejected;
- valid batch tuple items preserve ordering and atomicity;
- malformed or stale batch item rejects the entire batch and writes nothing;
- batch limit and existing reject-and-serve behavior remain intact.

## Implementation tickets

1. Implement and test the single `edit` tuple contract, including shared tuple schema/types and prompt guidance.
2. Implement and test tuple items in `batch_edit`, reusing the shared contract and preserving atomic behavior.
3. Update model-facing prompts and contract documentation, then run the full validation suite and review the combined diff.
