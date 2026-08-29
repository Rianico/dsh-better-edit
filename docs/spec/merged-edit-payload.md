# Merged Edit Payload Specification

**Status:** accepted
**Decision:** [ADR-0007](../adr/0007-merged-edit-payload-hoisted-path.md) (supersedes [ADR-0006](../adr/0006-compact-json-edit-payload.md))

## Goal

One mutation tool (`edit`) with one compact payload contract, expressed as an object-root schema with a hoisted path and an arity-carrying `edits` array. The tool remains responsible for resolving anchors, checking served state, rejecting stale or unseen ranges, and applying writes atomically.

## Public contract

```json
{
  "path": "/src/file.ts",
  "edits": [
    ["aB3", "cD4", "complete replacement for the range"],
    ["xY9", "xY9", ""]
  ]
}
```

- `path`: a non-empty string, or `null` to invoke the existing unique anchor-based path resolution. It is the **only** file target for the call — every item in `edits` applies to this file.
- `edits`: a non-empty array of fixed three-position tuples `[remove_from, remove_to, replacement_text]`, applied in order:
  1. `remove_from` — first line of the range to remove (inclusive), a bare 3-char HASH anchor;
  2. `remove_to` — last line of the range to remove (inclusive), a bare 3-char HASH anchor;
  3. `replacement_text` — the complete replacement text; an empty string deletes the range.

Arity is expressed by `edits.length`: a length-1 array is the single-edit case; longer arrays are batched edits to one file, applied atomically (preflight all items, write once, roll back on failure).

The root object must contain only `path` and `edits`. Missing/extra fields, empty `edits`, malformed tuples, empty or malformed paths, malformed anchors, and ambiguous path resolution are rejected with the existing `[E_BAD_SHAPE]`/anchor error conventions.

## Normalization and safety

- Each tuple normalizes into the existing internal edit representation (`remove_from`, `remove_to`, `replacement_text`) before mutation.
- `null` path is normalized through the existing `resolveMissingPath` behavior.
- Per-item served-range verification, reject-and-serve, noop policy, drift notices, and persisted undo are unchanged.
- No model-supplied digest, expected-hash list, force flag, fuzzy matching, silent remapping, or recovery merge is added.
- Rejection feedback continues to serve fresh rows, so a retry does not require a read.

## Tool surface

- `batch_edit` is removed. Its prompts, renderer, and `tool_result` handling merge into `edit`.
- The `tool_result` handler records served rows from the post-edit diff for the call's single `path`.

## Non-goals

- No cross-file batches (dropped capability; two `edit` calls suffice).
- No exposed format configuration or automatic format detection.
- No textual patch language. Unified diff may be considered later as an explicit interoperability adapter, but it must not bypass served-state verification or enable fuzzy relocation.
- No block operations, registers, file moves/removals, or syntax-aware structural edits.
- No Gemini-compatible `items` shapes yet — nested tuple `items` remain OpenAI-compatible-only until provider-agnostic support (per-item object items) is required.
