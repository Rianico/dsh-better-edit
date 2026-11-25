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
The tool never names a coordinate (anchor, line, path) it has not verified against served state; when no single coordinate is pinned, a refusal states the shape rule and leaves the choice to the model.
_Avoid_: —

**anchor philosophy**:
The project's core contract: per-line anchors are content-derived from the line's raw materialized bytes (never the canon), stable for unchanged lines, position-independent, and unique per file via probing; edge-whitespace formatter tolerance comes from the canon-keyed lease/pairing, not from the anchor digest, so a re-indent keeps a held anchor valid while its spelling rotates; interior whitespace is significant, including inside literals; an unresolvable anchor is rejected, never fuzzy-matched (ADR-0002 amended by ADR-0040 and ADR-0041).

**canon**:
The line with one leading and one trailing run of the frozen 28-code-point whitespace class removed — the ALIGNMENT and verification form, never the anchor's derivation base. Two lines with the same canon are "the same line after a reformat"; their anchors may still differ, because the bytes differ (ADR-0002, amended by ADR-0040 and ADR-0041).
_Avoid_: canonical text, normalized line, whitespace-insensitive line (it is not the identity)

**canon digest**:
`xxh32(canon(line))`. Pairs snapshots and verifies served evidence — "did this line survive a reformat?" — and never names anchor identity (`line_lineage.canon_hash`, `served_leases.canon_hash`).
_Avoid_: content hash (that is the whole-file `contentChecksum`), anchor hash

**anchor staleness**:
An anchor (one line, `remove_from` or `remove_to`) that no longer resolves against the current file because the line's content changed since it was served (`hash`/`canon`/`retired` miss). The model must re-`read` for fresh anchors.
_Avoid_: boundary staleness (use `anchor` for one line, `served range` for span)

**interior**:
The lines of a resolved range strictly between `remove_from` and `remove_to`.

**range**:
The resolved contiguous run of lines between `remove_from` and `remove_to` in the current file — the model-facing word for what a replace touches.
_Avoid_: hunk, region

**span**:
A contiguous interval of lines; the technical word used when verification compares two such intervals. The check compares the served span against the current span.
_Avoid_: hunk

**served span**:
The contiguous run of served hashes between the two boundary anchors' served positions — the served-state reconstruction of the model's view of a range. The two boundary anchors pin the span's extent, not the model's view of its interior: a leased span may cross unserved interior lines (ADR-0045).

**served range**:
The model-facing word for the `served span` — the span between `remove_from` and `remove_to` as the model saw it. Alias to `served span` for glossary search.
_Avoid_: range (use `served range` for verified span, `range` for current file run)

**served-range staleness**:
The condition where the `served range` (span between anchors) cannot be reconciled with served state: interior `served span` vs `current span` mismatch (`hash`/`canon`/`retired`/`len`). Reported as `[E_STALE_RANGE]` (changed) or `[E_UNSERVED_RANGE]` (never-served, `details.unservedKind` `boundary`|`interior`). Both do `reject-and-serve`; when the region is unidentifiable the rejection is a `target-lost rejection`.
_Avoid_: range staleness (use `served range` for span)

**never-served**:
An interior line with no entry in the served record — the model was never shown that line. `hint` span mode accepts it and discloses the replaced interior (`[W_UNSERVED_INTERIOR]`, blank diff gutter); `strict` refuses the edit before any write with a rowless `[E_UNSERVED_RANGE]` naming the unserved file lines (ADR-0045).

**unserved interior**:
A `never-served` line strictly inside a resolved range. `hint` tolerates it and discloses the replacement; `strict` refuses a span that replaces one before any write (ADR-0045).
_Avoid_: stale interior (staleness is a failed reconciliation, not a missing serve)

**span mode**:
The per-profile served-span policy: `hint` (default) accepts a leased span across unserved interior lines and discloses them, `strict` refuses such a span before any write. Configured by `spanMode` in `config.yaml` or `DSH_BETTER_EDIT_SPAN_MODE`; never a per-call argument (ADR-0045).
_Avoid_: strict mode (name the axis: span mode)

### File Encoding

**file encoding state**:
The `{encoding, hasBOM, lineEnding}` recorded at open and inverted on save — the buffer-level identity that guarantees round-trip fidelity. Distinct from `served state` (hash mirror) and from the file's byte content on disk. When the DSH provider supports it, the provider owns this state; otherwise the plugin maintains a per-`targetKey` fallback mirror invalidated by `FsVersion`.
_Avoid_: encoding setting, charset cache

**decoding error**:
A byte sequence that cannot be decoded under a chosen encoding — e.g. `0xFF` under UTF-8 `fatal:true` → `FS_NOT_TEXT`. Deterministic, not a guess.
_Avoid_: invalid text

**detection error**:
Choosing the wrong encoding for bytes that are valid under multiple code pages — e.g. `C4 E3` decoded as CP1251 `Дг` vs GBK `你`. The bytes are valid in both, the interpretation is wrong; surfaces as mojibake, not as `FS_NOT_TEXT`.
_Avoid_: decoding error

**autoGuessEncoding**:
The opt-in gate (default `false`) that allows auto-decode after deterministic `BOM → strict UTF-8` has failed. Mirrors VS Code `files.autoGuessEncoding`; when off, `FS_NOT_TEXT` is thrown with **Top-3 candidates always pushed** (`Top-3 guesses: … Try read({encoding})`); when on, the file is auto-decoded and the same Top-3 is pushed as a second `ContentBlock` footer (`[Auto-guessed: enc, candidates: …]`). Probabilistic encodings are never hidden — Top-3 is always surfaced for the model to pick.
_Avoid_: auto-detect

**config complement**:
When `config.yaml` is missing keys (e.g. after an upgrade adds `autoGuessEncoding`), `loadConfig()` complements the file with defaults (appends `key: default` lines, best-effort, preserving existing content) so the file stays complete without manual edit.
_Avoid_: manual migration

**effective EOL**:
The one terminator an `edit` writes for the whole file, resolved from the raw pre-image's terminator counts by the `EOL source ladder` and used for every line the write lands on — including untouched lines, which are re-spelled with the rest. It is also what `undo_last_edit` restores at: a revert writes ONE ending, so a pre-edit mixture cannot come back and the response says so (ADR-0047).
_Avoid_: target ending, normalized ending

**EOL source ladder**:
The four rungs deciding an `effective EOL`, in precedence order: `env` (`DSH_BETTER_EDIT_EOL`) > `config` (the `eol` key in `config.yaml`) > `file` (the pre-image's most frequent terminator kind — whole file, ties prefer LF, then CRLF, then CR) > `system` (`\r\n` on `win32`, `\n` elsewhere, and only when the file spells no terminator). `AUTO` is a value, not a rung: spelled at `env` or `config` it continues down the ladder, and a valid `env` value stops it either way. A forced `LF`/`CRLF`/`CR` names its own rung and stops. One resolver feeds both the read notice and the applied warning, so they can never name different rungs.
_Avoid_: precedence chain (unnamed), dominant ending (one rung's answer, not the ladder)

**W_EOL_REWRITTEN**:
The applied-tier `[MODEL]` warning that an applied write re-spelled at least one pre-image terminator: `EOL normalized to <target> (<source>): N terminators changed. Undo restores normalized content.` `N` counts pre-image terminators at a kind other than the target — a kept terminator counts zero, and a terminator a NEW line introduces was never in the pre-image and is never counted. Pushed only after the write landed, so an all-noop call never claims it; it fires for a forced rung re-spelling a UNIFORM file too, where the read stays silent.
_Avoid_: EOL warning (unnamed), line-ending notice

**W_MIXED_EOL**:
The read-tier notice that the pre-image it just served spells more than one terminator kind — the last cheap moment to learn that the first edit will collapse it. Bare `[<CODE>]` header with NO audience prefix (a read reports observed state; nothing has been written and nobody is addressed), appended as chrome after the read's rows and notes: `Mixed EOL: <n> CRLF, <n> LF, <n> CR. All edits normalize to <target> (<source>).` Counts are whole-file, taken once at decode, so `offset`/`limit`/`windows` change which rows render and never the counts; a kind with a zero count is omitted (never spelled `0`); the order is fixed CRLF, LF, CR. Never a served row, never file content, never an anchor.
_Avoid_: mixed EOL warning (it carries no audience), drift notice (that reports a change on disk, this reports the bytes as served)

**W_ENCODING_MIGRATED**:
The applied-tier `[MODEL]` warning that an applied write migrated a legacy file to UTF-8: `Migrated <path> from <encoding> (with BOM) to UTF-8. Undo restores the text, not the encoding.` — or `(no BOM)` when the pre-image carried none. Pushed only after the write landed, so a refusal, a batch abort, a dry run, an all-noop call, a byte-faithful body and a non-migrating file never carry it. It never claims the original bytes come back: the revert restores the text as UTF-8 and names the abandoned codec, never its bytes.
_Avoid_: encoding warning (unnamed), migration notice

**manual override**:
The status-bar-equivalent escape hatch: `read({encoding})` re-interprets bytes on disk (`Reopen with Encoding`) and `write({encoding})` transcodes the buffer on save (`Save with Encoding`). The agent-facing surface for correcting a `detection error` without corrupting disk.
_Avoid_: force encoding

**encoding governance**:
The invariant that every agent-issued file mutation passes through `file encoding state` (recorded at open, inverted at save): BOM sniff → strict UTF-8 → `autoGuessEncoding` gate → Top-3 always surfaced. A mutation without prior observation fails loud instead of guessing bytes.
_Avoid_: encoding handling (implies best-effort, not a gate)

**encoding migration**:
A write that replaced a legacy codec with UTF-8 — one-way and disclosed, never restored by undo. The verdict is taken once at the save seam (on the non-faithful arm only) and rides the undo pair, so the revert names the abandoned codec and its BOM state while restoring the text as UTF-8; the original bytes do not come back. See `effective EOL` (the revert's one ending) and `W_MIXED_EOL` (the sibling pre-image disclosure) for the mixture half of the same contract.
_Avoid_: transcode (a byte operation, not the disclosed one-way write), migration notice (that is the warning's name, not the event)

**governed edit path**:
Any tool path that enforces `encoding governance`: `read`/`edit`/`undo_last_edit` and the `str_replace_editor` shadow (`view` → `str_replace`/`insert`/`create`). The `str_replace_editor` shadow records `file encoding state` but never `served state` — it can feed `write` round-trips but cannot authorize hashline `edit` anchors.
_Avoid_: native edit path (implies the built-in tools own the semantics; here the plugin does)

**ungoverned edit path**:
A file mutation that bypasses `encoding governance` — the built-in `write`/`edit`/`str_replace_editor` on layers the plugin does not shadow, or any shell redirection. Ungoverned writes can silently normalize or mojibake non-UTF-8 bytes; the plugin heals by discarding stale `file encoding state` on version drift and re-running deterministic detection.
_Avoid_: native edit path

**reject-and-serve**:
The staleness policy: reject the edit and return the current content of the region the submitted anchors identify as `HASH|content` rows — a _region-matched_ serve. A serve refreshes the model's inputs for that region and never substitutes another region for those anchors; the echoed rows are the current file's anchors and ARE recorded as serves (rows + canons + snapshot + leases) when the verifier identified the region from the committed snapshot, so the retry needs no read (ADR-0043). A refusal that cannot identify the region (a changed batch buffer, a `target-lost rejection`, an unresolved anchor) carries no rows; a window whose echoed anchor the served mirror already holds elsewhere is declined — both name the read. "Region-matched" is the upstream referent's name (`pi-better-edit` ADR-0018) for "the window the submitted anchors identify".
_Avoid_: reject-then-reread (only a rowless or declined refusal needs the read), context serve (no such operation exists), region (use `served span` / `served range`)

**target-lost rejection**:
A rejection whose region cannot be identified: the submitted anchors no longer name a live span (both bounds stale, a survivor that shifted, or a window that collapses or misses the file). Its payload carries **no rows** and no `Current range` heading; the headline names the previously served position and instructs a read, so no served coordinate the model never targeted becomes committable. Realized locally as an `[E_STALE_RANGE]` payload with an empty `servedRows` (`src/fs-bridge.ts`, F7) — the local disjointness signal is the row count, not the code.
_Avoid_: context serve (dropped: no such operation exists), unverified range (unported upstream code)

**drift**:
The divergence between the served state and the current file: lines the model was shown whose content has changed on disk since they were served. Detected by comparing served hashes against current hashes.
_Avoid_: modification, external change (the tool cannot know the source)

**drift notice**:
The informational section appended to a replace result (applied or noop, not undo) when drift lies in served territory outside the replacement range: the current content of the drifted lines, capped, with rows counting as serves. Fires once per drift episode — already-reported drift shrinks to a one-line pointer until a read re-serves the lines. Classified as a user-facing signal (details only, not model content).
_Avoid_: warning (the operation succeeded; it is information, not a warning)

**model-facing signal**:
A model-visible signal the tool must include in `content` for correctness, rendered with a `[MODEL]` header (e.g. `anchor staleness`, `served-range staleness`, `E_STALE_*`/`E_UNSERVED_*`, `E_SUSPICIOUS_TEXT`; `W_NOOP`'s retry-stopping prediction). The model needs it to retry correctly.

**user-facing signal**:
A model-visible signal informative for the human only, rendered with a `[USER]` header and carried in `details` (e.g. drift notice; the former `Batch drift note` was retired — see ADR-0006's Amendment). It can ride `content` too — the header, not the channel, tells the model it is not its to act on. Contrast model-facing signal.

**orphaned serve**:
An entry in served state whose hash no longer matches the current file at that position — the mirror retained a hash that the file has moved or removed elsewhere. Contrast with never-served. An orphan is drift, but at a single position rather than a range.
_Avoid_: stale serve (ambiguous with anchor staleness)

**orphaning re-serve**:
The serve event that creates an orphan: re-serving the same hash at a new position without nulling its previous served position — typically a partial re-read (or an echo/diff that covers the new but not the old slot) after an external relocation that kept the hash. A full re-read heals by overwriting every position; an orphaning re-serve leaves the stale slot behind.
_Avoid_: duplicate serve (conflates duplicated content with relocated-line-keeps-hash)

**relocated line keeps its hash**:
The file condition where a line's content survives an external write and, because no probe collision occurs at its new spot, the same hash is reproduced by a fresh hashing pass. Distinct from "duplicated content" (same text at two positions in one file gets two different hashes via probing).
_Avoid_: duplicate content (implies same hash, which perfect hashing prevents)

**retired anchor** (replaces `tombstone` — ADR-0013 term, DB column `served.retired`, code var `tombstone` is now `retired`):
A hash freed by an edit since the last epoch (full read) that must not be reallocated while the model may still hold it. Per `(session, path)`. GC analogy: garbage not yet reclaimable. Replaces `tombstone` everywhere in docs; see also `retired entry` and `hazard card`.
_Avoid_: tombstone (legacy term — use `retired anchor` for the hash, `retired entry` for the per-position record)

**retired entry**:
The per-position death record `{hash, deathPos}` (and implicitly `deathEpoch = snapshotId`) that makes the retired set precise. A retired anchor at `deathPos` is reclaimable only after that position's hazard card is cleared. Enables incremental GC — paging re-reads sweep incrementally instead of requiring a full-file stop-the-world clear.
_Avoid_: retired hash without position (implies heap-granular set)

**hazard card** (aka **coverage card**):
Per-position `bitset<N>` tracking which file positions the model has re-observed since retirement. `read` that serves position `p` marks `card[p]=clean`. When `card[deathPos]` turns clean, `retiredEntries` with that `deathPos` are swept. Full-file `all clean` is equivalent to the old full-read valve but incremental; powers per-position hazard-pointer reclamation (Q7b).
_Avoid_: coverage epoch as single counter (too coarse)

**anchor epoch**:
The generation bound to `snapshotId` of the last full read that produced the current `served`+`retired` generation (Q8a — no separate counter; epoch is `snapshotId`). Promotion on hash-space exhaustion bumps epoch by `clear retired` + loud degraded warning, not by clearing `served`.
_Avoid_: epoch counter (only needed if HASH_LEN 3→4 widens)

**read_skill**:
To read a file's content as plain text — no hash prefixes, no served rows, but maintaining `file encoding state` for round-trip. The model's tool for loading skill content (SKILL.md or any file in its directory) to invoke and consume; `read` remains the hashed read for edit targets. `read_skill` follows the same `BOM → strict UTF-8 → autoGuess` capture path as `read`, records `file encoding state` (so a later `write` can round-trip), but never records `served state` — it cannot authorize `edit` anchors.
_Avoid_: plain read, skill tool

**reference read**:
A read that serves no hashes and records no served state, but may record `file encoding state`. `read_skill` is the reference read that maintains encoding without serving.
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

**E_SUSPICIOUS_TEXT**:
Refusal that `content` (for `write`) or `replacement_text` (for `edit`) copied a `served hash echo` — rendered by `suspiciousFormat` (`src/domain-errors.ts`): names the refused line (for `edit`, the replacement-line index `k`, matched range-relatively at AA: E1), the echoed `${hash}│` anchor and its absolute `servedLine`, plus "HASH│ anchors are tool output, not file content". Producers: `servedHashEchoDenial` (`src/write-hook.ts`, pre-dispatch; content line == `servedLine`) and `EditHashEchoError` (`src/hashline/anchor-pipeline.ts`). The edit arm carries the escape: omit the copied anchors from `replace_with` and retry with the same anchors, or declare intent with `mode: "literal"` (raw bytes applied verbatim, a `W_LITERAL_BYPASS` warning) — the write arm promises no literal retry (`F2`: the built-in `write` tool takes no mode flag). "Nothing was written." renders only when a resubmission tally (`count`) is supplied; no tool producer holds one. Deny, not strip — fail-loud, compensable.
_Avoid_: E_HASH_ECHO (ambiguous); E_WRITE_HASH_ECHO / E_EDIT_HASH_ECHO (the per-tool split, merged by ADR-0014); E_SERVED_ECHO (the merged name, renamed by the domain-errors registry — see ADR-0005's Amendment)

**boundary duplicate (historical, removed by ADR-0007):**
Auto-spliced `replacement_text` edge when it equaled an adjacent file line — `trailingDups`/`leadingDups` (byte `===`, 1-line) and `firstNewAfterDups`/`lastNewBeforeDups` (`canon()` + `sectionIsUnique`). Removed — tool is now pure `range = [remove_from, remove_to]` by hash, `replacement = exact replacement_text`; a duplicate stays as a loud duplicate the model fixes next turn (see ADR-0007).
_Avoid_: boundaryDups

### Workspace

**Working directory**:
The directory a tool call operates in: the session's committed live directory from the `workingDirectory` service (moved by the `working_directory` tool), falling back to the immutable session header's `cwd` when the composition predates the service. It keys relative-path resolution and the per-workspace store.
_Avoid_: cwd (ambiguous: header vs live), project root

**Session header directory**:
The directory the session was CREATED in, kept immutable in the session header (`exec.agent.session.header.cwd`). Not the operation target once a session has moved — read the working directory instead.
_Avoid_: workspace (the workspace follows the live directory, not the header)

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

**seeded identity**:
The v1 projection of a seeded override file plus its `seedHash` (`src/guidance/seed.ts`, [ADR-0052](docs/adr/0052-guidance-seed-provenance-and-upgrade-lifecycle.md)): leading BOM run dropped, CRLF and lone CR normalized to LF, trailing blank lines stripped. Identity, not byte equality — EOL and trailing-newline noise never fork it, so the plugin can tell its own seed from a user edit.
_Avoid_: file hash (a raw byte hash forks on EOL noise), checksum

**seed provenance**:
The hash the plugin last wrote for a shipped override file, recorded per `<preset>/<file>` in `<plugin-home>/.seeded.json`. Refresh is allowed only while the file's identity matches the recorded hash or a `KNOWN_HISTORICAL_SEEDS` entry ([ADR-0052](docs/adr/0052-guidance-seed-provenance-and-upgrade-lifecycle.md)); any other content is a customization and is preserved.
_Avoid_: front-matter marker, provenance fence (provenance never lives in the markdown)

**Order**:
The numeric ordering of a prompt section within the assembled system prompt. A section without an explicit `order` takes the harness's canonical slot for its tool (`systemPrompt.getSectionOrder('TOOL_READ'|'TOOL_EDIT')`), falling back to `1100`/`1300`/`1310` when the registry predates that API. Overridable alongside guidance; equal orders sort by name.

_Prefer_: harness slot (for the canonical value)

**Preset**:
A per-session agent composition declared by a `@deepseek-ai/dsh-agent-preset` row (an id plus child plugin rows) and served by `agentPresets`. The unit guidance overrides are keyed by; the plugin reads the agent's preset id at `agent/created` via `agentPresets.composedPreset`. Shipped ids: `standard`, `ptc`, `minimal`, `cordis`.
_Avoid_: `agent.cordis.yml` (the pre-0.2 roster file), mode (the UI label)
**Reset**:
Restoring the compiled default guidance and order for an override file. Triggered by emptying an override file without a front-matter fence, deleting it, or deleting its whole `<preset>/` directory: the plugin renders the compiled default at agent creation and re-seeds at next boot — shipped presets always re-seed; a deleted custom-preset override stays absent (absence is no override).
_Avoid_: restore, regenerate, "recover the default prompt"

**source of truth**:
The file bytes on disk plus the lease store (`served_leases`, snapshots, `line_lineage`) — the sole authority for retry coordinates. Rendered diff text is never the source of truth; coordinates resolve through leases, never by re-reading a projection.
_Avoid_: machine diff (a projection, not the table)

**projection**:
The single shared rendered diff — preview, applied, and human display render the same text with different context params — derived from the source of truth under a stated collapse contract. Informational only: hidden spans come in two kinds, each with a unified counted marker whose count equals its hidden span — untouched-span (middle gap; ` ... [N lines untouched] ...`, every hidden row stays lease-covered, both cursors advance) and deleted-span (removed run; ` - ... [N lines deleted] ...`, the count drives the old-side cursor); added spans are never hidden (the collapse invariant). The model path never consumes projection text as coordinate input.
_Avoid_: view (unqualified — name the audience), second diff (there is only one rendering), middle-gap marker (think spans, not gaps)
