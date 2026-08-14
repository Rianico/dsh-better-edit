# dsh-better-edit

Hash-anchored `read` / `edit` / `batch_edit` / `undo_last_edit` tools for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).
Every line of a file gets a unique 3-character hash, and you edit by hash. No
line numbers, no fuzzy matching, no edits landing on the wrong line.

This is a dsh port of
[pi-hashline-edit-lsz](https://github.com/Rianico/pi-hashline-edit-lsz) (itself
a self-maintained fork of pi-hashline-edit / pi-hashline-edit-pro by RimuruW
and Yugimob). The hashline core is ported byte-for-byte; the tool layer is
rewritten on dsh's plugin API.

## What you get

- **Read with anchors.** Every line comes back as `HASH│content`. The hash is
  the line's address.
- **Edit by hash.** `edit` targets a range of hashes
  (`remove_from` / `remove_to`), so edits always land on the lines you meant.
- **Anchors that stay put.** Edit one part of a file and the hashes of the
  rest stay the same. Read once, keep editing.
- **Fresh anchors, automatically.** After every `write` you get the new
  anchors (auto-read). After every `edit` you get the diff with the new
  hashes.
- **Undo when you need it.** The last edit on a file can be reverted, even
  after a restart.
- **Safe writes.** Permissions, line endings, BOMs, symlinks, and hard links
  survive every edit (writes go through `ctx.fs`, honoring sandboxed/remote
  backends).
- **Reject-and-serve.** A stale or never-served range is hard-rejected with
  fresh `HASH│content` rows so the retry needs no `read`.

## How it replaces the built-in tools

dsh's tool registry resolves per scope: an agent sees `agent → preset →
global`, and its **own** layer always wins. The built-in `read`/`edit` live on
the agent-preset layer, so a plain global registration cannot replace them.
This plugin:

1. Mounts as a host-plane Cordis plugin via its `cordis.patch.yml` bundle
   patch.
2. On `agent/session-start`, registers the hashline tools **and** the
   `tool:read` / `tool:edit` prompt sections on the agent's own scope layer —
   they shadow the preset's built-ins for that agent and unwind automatically
   when the agent is disposed.
3. Leaves the built-in `write` in place, but a scoped `tools/post-execute`
   listener appends the hashline auto-read to write results.

## Installation

From npm:

```sh
dsh plugin --profile <name> add dsh-better-edit
```

From a local checkout:

```sh
dsh plugin --profile <name> add /path/to/dsh-better-edit
```

The profile's next session runs with the hashline tools installed. To verify
the layer is active:

```sh
dsh --profile <name> --dump-config   # shows a "# == dsh-better-edit" layer
```

### Requirements

- Node `^22.19.0 || >=24.0.0` (dsh's requirement; the store uses `node:sqlite`)
- A dsh profile (`dsh plugin` initializes one on first use)

## Usage

1. Read a file:

```text
ve7│function hello() {
szJ│  console.log("world");
kQm│}
```

1. Edit a line by its hash:

```json
{
  "path": "src/main.ts",
  "remove_from": "szJ",
  "remove_to": "szJ",
  "replacement_text": "  console.log('hi');"
}
```

1. Keep editing. Anchors for lines you didn't touch stay valid; the post-edit
   diff and the auto-read after `write` hand you fresh anchors.

### The read tool

`read` returns a text file with every line prefixed by `HASH│content` (hash =
3 chars from `A-Za-z0-9`). Parameters: `offset` (1-based start line), `limit`
(maximum lines). Paged output ends with `[Showing lines N-M of T. Use
offset=… to continue.]`. Lines larger than 200KB are shown as a marker with a
`sed` inspection hint — hash anchors need full lines.

### The edit tool

| Field | Meaning |
| --- | --- |
| `path` | Path to edit (relative to the session cwd; absolute works). |
| `remove_from` | Bare 3-char hash of the first line to remove. |
| `remove_to` | Bare 3-char hash of the last line to remove. |
| `replacement_text` | Replacement text; `""` deletes the range. |

The tool verifies **every line** of the resolved range against what the model
was actually shown. A line inside the range that changed on disk since it was
served is hard-rejected with `[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]` /
`[E_RANGE_UNVERIFIED]`, and the current range is echoed back as fresh anchors
(reject-and-serve). Anchors for lines outside the post-edit diff window are
recovered with a `read` — that is the documented on-demand recovery.

### batch_edit

Several edits in one atomic call: `{ edits: [{ path?, remove_from,
remove_to, replacement_text }, …] }`. All-or-nothing — any failing item
rejects the whole batch with nothing written, and the failing item's current
range is echoed as fresh serves. Up to 32 items.

### undo_last_edit

`{ path }` reverts the last hashline edit on the file, only while the file
still matches the stored post-edit content. A later external write clears the
history instead of being overwritten. Undo survives restarts (stored in the
hash store).

## Store

Hash snapshots, served-state rows, and undo history live in one SQLite store
under the DeepSeek Harness home:

- `$DSH_HOME/plugins/dsh-better-edit/hash-store.sqlite` (default
  `~/.dsh/plugins/dsh-better-edit/hash-store.sqlite`)

A 7-day TTL prunes served rows; missing-file snapshots are pruned at startup.
Corrupt stores are quarantined and rebuilt automatically.

## Error codes

| Code | Meaning |
| --- | --- |
| `[E_ACCESS]` | File exists but is not readable/writable by the tool. |
| `[E_AMBIGUOUS_ANCHOR]` | A hash matches more than one current line; call `read` for fresh anchors. |
| `[E_BAD_OP]` | Range end precedes range start (autocorrected when the pair was reversed). |
| `[E_BAD_REF]` | `remove_from`/`remove_to` is not a bare 3-char hash. |
| `[E_BAD_SHAPE]` | Request/field shape is wrong (unknown fields, missing path, non-string text, …). |
| `[E_BARE_HASH_PREFIX]` | `HASH│` prefix pasted into `replacement_text` (autocorrected). |
| `[E_BATCH_ABORT]` | A batch item failed; the whole batch was rejected, nothing written. |
| `[E_FILE_TOO_LARGE]` | File exceeds the hashline line ceiling; use `write` or another approach. |
| `[E_INVALID_PATCH]` | Diff-preview markers pasted into `replacement_text` (autocorrected). |
| `[E_NOOP_LOOP]` | The exact same edit keeps producing no change; resubmitting is rejected. |
| `[E_NOT_FOUND]` | File does not exist. |
| `[E_NOT_OBSERVED]` | The file has not been observed in this session (read-before-write policy); call `read` first. |
| `[E_NOT_TEXT]` | Path is a directory, binary, or non-UTF-8 file; hashline edits only text. |
| `[E_RANGE_STALE]` | A served line differs on disk since it was read; the range is echoed fresh. |
| `[E_RANGE_UNSERVED]` | The range includes lines never served to the model. |
| `[E_RANGE_UNVERIFIED]` | Boundary anchor cannot be verified against served state. |
| `[E_STALE_ANCHOR]` | Anchor(s) no longer resolve; call `read` for fresh anchors. |
| `[E_UNDO_STALE]` | Cannot undo: the file was modified (or deleted) after the edit. |
| `[E_UNDO_UNAVAILABLE]` | Undo history could not be persisted; the edit was not applied. |
| `[E_WOULD_EMPTY]` | An edit would empty a non-empty file; use `write` to clear it. |

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc → lib/
```

The test suite is ported from pi-hashline-edit-lsz (598 tests) and drives the
dsh tool builders directly over a local filesystem bridge.

## License

MIT — see [LICENSE](LICENSE). Ported from pi-hashline-edit-lsz (MIT), which
itself carries the upstream copyrights of RimuruW and Yugimob.
