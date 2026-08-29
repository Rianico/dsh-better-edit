# Compact JSON edit payload

Date: 2026-08-17

## Status

accepted

Superseded by [ADR-0007](0007-merged-edit-payload-hoisted-path.md)

## Context

OpenAI-compatible function-tool transports require object-root schemas (`type: "object"`), and repeated JSON keys in edit payloads inflate token cost. Textual patch languages and full-file digests reduce keys but lose strict schema validation and the model–tool boundary where the tool owns verification.

## Decision

We will use compact tuples inside object-root JSON payloads: `edit` is `{ "edit": [path, [remove_from, remove_to], replacement_text] }`, and `batch_edit` is `{ "batch": [ [path, [remove_from, remove_to], replacement_text], ... ] }`. The tuple positions preserve the existing verified edit semantics: the path is a string or `null` for anchor-based inference, the two-anchor range is inclusive, and an empty replacement means deletion. We chose fixed tuples over a textual patch language or a full-file digest because they reduce repeated JSON keys while keeping strict schema validation and the model–tool boundary. The old named-object edit payload and the `edits` wrapper are not retained; textual formats such as unified diff remain deferred interoperability experiments rather than alternate mutation semantics.

### Considered Options

- **Fixed compact tuples (chosen)** — object-root, fixed-arity, token-efficient; preserves strict schema validation and the model–tool boundary.
- **Textual patch language (e.g. unified diff)** — deferred: interoperability experiment, not an alternate mutation contract; risks fuzzy relocation.
- **Full-file digest** — rejected: verbose and unnecessary given anchor-based verification.

## Consequences

- Compact JSON is the sole current payload contract; no new tool or exposed format configuration is added.
- The tuple is intentionally fixed-arity: `null` represents an inferred path rather than an omitted position.
- Both forms must normalize into the existing edit pipeline, including served-state range verification, reject-and-serve, atomic batch preflight, rollback, and persisted undo.
- Syntax-aware structural edits and file-lifecycle operations remain outside the verified line-range contract.
