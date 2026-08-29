# dsh-better-edit

Hash-anchored read/edit/undo_last_edit tools for DeepSeek Harness (dsh). Every line carries a stable 3-char hash; edits anchor on hashes and verify every line against what the model was shown.

## Language

### Hashline

**serve**:
To deliver a line's `HASH│content` row into the model's context through tool output. Reading serves the rows it shows; a post-edit diff serves its rows; an error's fresh-anchor feedback serves its rows.
_Avoid_: display, show, echo

**served state**:
The tool's per-file, per-line record of the hash last delivered to the model for each line — a mirror of the model's knowledge of the file, maintained by the tool and cleared at session start.
_Avoid_: expectation, last read, snapshot

**model–tool boundary**:
The separation of responsibilities: the tool owns verification of what the model submits; the model owns intent. The tool never relies on the model to supply verification data or to perform pre-edit rituals (re-reading) to keep its own checks honest.
_Avoid_: —

**anchor philosophy**:
The project's core contract: per-line anchors are content-derived with ASCII whitespace (`[ \t\r\n]`) stripped, stable for unchanged lines and across whitespace-only formatting, and position-independent; an anchor that cannot be resolved is rejected, never fuzzy-matched or silently relocated. Byte-level detection of non-whitespace changes is unchanged — token-level edits still rotate the anchor (ADR-0005).

**boundary staleness**:
An anchor that no longer resolves against the current file because the line's content changed since it was served.
_Avoid_: stale anchor (ambiguous between boundary and range staleness)

**interior**:
The lines of a resolved range strictly between `remove_from` and `remove_to`.

**range**:
The resolved contiguous run of lines between `remove_from` and `remove_to` in the current file — the model-facing word for what a replace touches.
_Avoid_: hunk, region

**span**:
A contiguous interval of lines; the technical word used when verification compares two such intervals. The check compares the served span against the current span.
_Avoid_: hunk

**served span**:
The contiguous run of served hashes between the two boundary anchors' served positions — the served-state reconstruction of the model's view of a range.

**range staleness**:
The condition where a resolved range's interior cannot be reconciled with served state: a served line's content changed since it was served, or the line was never served.

**never-served**:
An interior line with no entry in the served record — the model was never shown that line. Reported as `[E_RANGE_UNSERVED]`; the response serves the current range so the model can retry.

**reject-and-serve**:
The staleness policy: reject the edit and return the current range as fresh `HASH│content` rows, which themselves count as serves, so the retry needs no read.
_Avoid_: reject-then-reread (the retry must not require a read)

**drift**:
The divergence between the served state and the current file: lines the model was shown whose content has changed on disk since they were served. Detected by comparing served hashes against current hashes.
_Avoid_: modification, external change (the tool cannot know the source)

**drift notice**:
The informational section appended to a replace result (applied or noop, not undo) when drift lies in served territory outside the replacement range: the current content of the drifted lines, capped, with rows counting as serves. Fires once per drift episode — already-reported drift shrinks to a one-line pointer until a read re-serves the lines. Classified as a user-facing signal (details only, not model content).
_Avoid_: warning (the operation succeeded; it is information, not a warning)

**model-facing signal**:
A model-visible signal the tool must include in `content` for correctness (e.g. boundary staleness, range staleness, E_RANGE_*, E_EDIT_HASH_ECHO). The model needs it to retry correctly.

**user-facing signal**:
A model-visible signal informative for the human only, emitted in `details`/`warnings` and rendered collapsed in TUI (e.g. drift notice, Batch drift note). Not in model content.

**orphaned serve**:
An entry in served state whose hash no longer matches the current file at that position — the mirror retained a hash that the file has moved or removed elsewhere. Contrast with never-served. An orphan is drift, but at a single position rather than a range.
_Avoid_: stale serve (ambiguous with boundary staleness)

**orphaning re-serve**:
The serve event that creates an orphan: re-serving the same hash at a new position without nulling its previous served position — typically a partial re-read (or an echo/diff that covers the new but not the old slot) after an external relocation that kept the hash. A full re-read heals by overwriting every position; an orphaning re-serve leaves the stale slot behind.
_Avoid_: duplicate serve (conflates duplicated content with relocated-line-keeps-hash)

**relocated line keeps its hash**:
The file condition where a line's content survives an external write and, because no probe collision occurs at its new spot, the same hash is reproduced by a fresh hashing pass. Distinct from "duplicated content" (same text at two positions in one file gets two different hashes via probing).
_Avoid_: duplicate content (implies same hash, which perfect hashing prevents)

**read_skill**:
To read a file's content as plain text — no hash prefixes, no served rows. The model's tool for loading skill content (SKILL.md or any file in its directory) to invoke and consume; `read` remains the hashed read for edit targets.
_Avoid_: plain read, skill tool

**reference read**:
A read that serves no hashes and records no served state — the model consumes the content rather than editing it. `read_skill` is the only reference read.
_Avoid_: unmanaged read

**tool-name-as-intent**:
The principle that a tool's name encodes the model's intent — `read` (hashed, editable) vs `read_skill` (plain, consumable) — so the model always knows what it's getting.
_Avoid_: —

**payload contract**:
The model-facing JSON shape used to state one or more file edits in a single `edit` call: `{ "path": …, "edits": [[remove_from, remove_to, replacement_text], …] }`. The path is hoisted to the payload root (see nullable path), and the `edits` array expresses arity — length 1 is a single edit, longer is a batched edit applied atomically to one file. There is no separate batch tool.
_Avoid_: patch language, command language

**edits**:
The payload's array of compact JSON tuples; its length is the call's arity. The tool name `edit` covers single and batched edits — intent is expressed by arity, not by a separate tool.
_Avoid_: batch_edit (removed tool)

**inclusive anchor range**:
A pair of boundary anchors identifying the first and last lines of a model-facing range; both boundaries are included.
_Avoid_: hunk, region

**nullable path**:
A top-level `path` position that may be `null` when the tool can resolve a unique target from the anchor range. It sits above the `edits` array rather than inside each item, so every edit in one call targets the same file.
_Avoid_: optional path

**compact JSON tuple**:
A fixed three-position JSON array `[remove_from, remove_to, replacement_text]` — one edit item inside the payload's `edits` array, the model-facing unit of mutation. The path is not part of the item; it is hoisted to the payload root.
_Avoid_: patch language, array shorthand

**served hash echo**:
A candidate line that begins with the exact `HASH│` anchor served for the same session, canonical path, and line — tool output mistaken for file content. For `write` the check is absolute line `i` vs `served[i]`; for `edit` it is range-relative line `k` vs `served[startLine + k]` (AA: E1). Detected before dispatch/write, file stays byte-identical. Not a generic `^[A-Za-z0-9]{3}│` strip.
_Avoid_: hash echo (without served qualification), anchor echo

**E_WRITE_HASH_ECHO**:
Refusal of a built-in `write` that copied a served hash echo — `[E_WRITE_HASH_ECHO] Refused write to ${path}: line ${n} begins with the exact ${hash}│ anchor served for this session, path, and line. Remove the entire copied anchor chain and retry. Nothing was written.`
_Avoid_: E_HASH_ECHO (ambiguous between write/edit)

**E_EDIT_HASH_ECHO**:
Refusal of an `edit` whose `replacement_text` contains a served hash echo at the range-relative position — `[E_EDIT_HASH_ECHO] Refused edit to ${path}: replacement line ${k} begins with the exact ${hash}│ anchor served for this session, path, and range-relative line. Remove the copied anchors and retry. Nothing was written.` Deny, not strip — fail-loud, compensable (AA: A).
_Avoid_: E_WRITE_HASH_ECHO (write-only), generic strip

### Guidance

**Prompt section**:
A named unit in dsh's `systemPrompt` registry — one of `tool:read`, `tool:edit`, `tool:undo_last_edit` — carrying a name, an `order`, and rendered text. Registered per agent on the agent's own scope layer, so it shadows the preset's built-in section of the same name.
_Avoid_: prompt, prompt entry

**Guidance**:
The editable prose of a prompt section — the usage instructions the model reads. Overridable per preset; the compiled defaults live in `src/prompts.ts`.
_Avoid_: prompt, instructions ("instructions" is `dsh-agent-instructions`' term for AGENTS.md content), guidelines (the legacy `*_GUIDELINES` constant names in `src/prompts.ts` — unify on "guidance")

**Override file**:
A `<preset>/<section>.md` plain-markdown file in the plugin's shared home that overrides one prompt section's guidance and (optionally) its `order` via front-matter. The unit users edit and reset — distinct from the preset, which is a roster composition.
_Avoid_: preset ("the preset file" is the composition row, not this override file), custom prompt

**Order**:
The numeric ordering of a prompt section within the assembled system prompt. Overridable alongside guidance.

**Preset**:
A per-session agent composition from the dsh roster (`agent.cordis.yml` plus metadata, system- or user-authored). The unit guidance overrides are keyed by; the plugin reads the agent's preset id at `agent/session-start` via `agentPresets.composedPreset`.

**Reset**:
Restoring the compiled default guidance and order for an override file. Triggered by emptying an override file without a front-matter fence, deleting it, or deleting its whole `<preset>/` directory: the plugin renders the compiled default at session-start and re-seeds at next boot — shipped presets always re-seed; a deleted custom-preset override stays absent (absence is no override).
_Avoid_: restore, regenerate, "recover the default prompt"
