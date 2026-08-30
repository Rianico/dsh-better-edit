<p align="center">
  <img src="assets/logo.svg" alt="dsh-better-edit" width="200">
</p>

<h1 align="center">dsh-better-edit</h1>
<p align="center">
  <strong>A better edit tool for DeepSeek Harness<br>
  Powered by hash‑anchored positioning — not by line numbers, not by string replacement, fewer tokens, more context space for real work.</strong>
</p>
<p align="center">
  <strong>English</strong> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="#why-you-need-this"><img src="https://img.shields.io/badge/why-hashline-blue?style=flat" alt="why hashline"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/quick_start-30s-brightgreen?style=flat" alt="quick start 30s"></a>
  <a href="#comparison"><img src="https://img.shields.io/badge/correctness-23%2F23-success?style=flat" alt="23/23 battery"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#why-hashline">Why Hashline</a> •
  <a href="#tools">Tools</a> •
  <a href="#comparison">Comparison</a> •
  <a href="#how-anchors-work">How Anchors Work</a> •
  <a href="#development">Development</a> •
  <a href="#acknowledgments">Acknowledgments</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.3.1-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License">
  <img src="https://img.shields.io/badge/DeepSeek_Harness-Plugin-blueviolet.svg" alt="DeepSeek Harness Plugin">
  <img src="https://img.shields.io/npm/v/dsh-better-edit" alt="npm version">
  <img src="https://img.shields.io/npm/dm/dsh-better-edit" alt="npm downloads">
  <img src="https://img.shields.io/github/stars/Rianico/dsh-better-edit?style=social" alt="GitHub Stars">
</p>

<p align="center">
  <img src="assets/banner.svg" alt="file.ts → read → hashed lines → edit by hash → diff" width="900">
</p>

---

> *"The harness — not the model — is the bottleneck."* — Can Bölük, [*The Harness Problem*](https://stencil.so/blog/the-harness-problem)
>
> **This is the harness fix.** Content hashes replace line numbers — an edit above never shifts the anchor below. Every range is verified against what the agent actually saw. Stale or unseen lines are hard-rejected with fresh anchors to retry — no `read` needed.
>
> **3 tool calls vs 6 · -55.8% tokens · 23/23 correctness.** Same external-drift refactor, same correct file (single stochastic run vs OMP; [full method](https://github.com/Rianico/pi-better-edit/blob/main/benchmarks/results/2026-08-17-practical-token-benchmark.md)). Benchmark envelope numbers are deterministic — see [Benchmark](#benchmark).

## Why you need this

**If you've watched an agent corrupt a file because `line 47` became `line 74` after an insert — this is for you.**

| Before: `str_replace` / line numbers | After: hashline `edit` |
| --- | --- |
| Model re-types old code (output billed ~5-6× input) | Sends two 3-char hashes — old text is never echoed |
| One insert above shifts every number below → wrong line lands silently | Anchors are content addresses → edits above don't move anchors below |
| No check that the range matches what was shown | Every line verified against served rows; `[E_RANGE_STALE]`/`[E_RANGE_UNSERVED]` reject before any write, then **reject-and-serve** returns fresh `HASH│content` to retry |

> [!TIP]
> **Shining points — honest and measured:**
>
> - **Self-healing, not silent.** External edits never get overwritten — stale ranges are rejected and re-served as fresh `HASH│content` to retry; orphaned serves heal without a full re-read (ADR-0008). Fail-closed, not auto-merge.
> - **Formatter-tolerant.** ASCII-whitespace-insensitive anchors survive `prettier`/`black`/`eslint --fix` between edits (`formatOnSave`, watcher, CI). Linter-only assumption — whitespace inside string literals is not distinguished (ADR-0005).
> - **Chained & batched, no re-read ritual.** Anchors for untouched lines stay valid; diff/echo/reject rows count as serves. `edit` batches up to 32 same-file edits atomically (`[E_BATCH_ABORT]`), ~-40% envelope vs `str_replace` on the pinned 12-edit corpus.
> - **Read guard enforced.** Never edits what it hasn't seen — `[E_RANGE_UNSERVED]`/`[E_RANGE_UNVERIFIED]`/`[E_STALE_ANCHOR]` reject before any write, then `reject-and-serve`.
> - **Fewer round-trips in practice.** Dated run: **3 calls vs 6** for the OMP wrapper on the same external-drift refactor, same correct file; envelope vs `str_replace` is the durable number — reproducible via the upstream battery (same hashline algorithm, [method](https://github.com/Rianico/pi-better-edit/blob/main/benchmarks/results/2026-08-17-practical-token-benchmark.md)). Correctness `23/23` deterministic.

Not for one-line touch-ups (near parity) or brand-new files (`write`). It pays off in long sessions and structural edits — anywhere an edit must not land on the wrong line.

> Deep dive: <a href="#why-hashline">Why Hashline</a> · <a href="#comparison">Comparison</a> · <a href="benchmark/README.md">Benchmark</a>

## Quick Start — from install to verified edit in 30s

### Install (pick one)

```sh
npx @deepseek-ai/dsh plugin --profile web add github:Rianico/dsh-better-edit   # from github
npx @deepseek-ai/dsh plugin --profile web add dsh-better-edit   # from npm
npx @deepseek-ai/dsh plugin --profile web add /path/to/dsh-better-edit   # from a local checkout
```

No config. The profile's next session runs with the hashline tools installed. To verify the layer is active:

```sh
dsh --profile <name> --dump-config   # shows a "# == dsh-better-edit" layer
```

| Requirement | |
| --- | --- |
| Node | `^22.19.0 \|\| >=24.0.0` (dsh's requirement; the store uses `node:sqlite`) |
| Profile | a dsh profile (`dsh plugin` initializes one on first use) |
| Backends | sandboxed / remote filesystems supported (writes go through `ctx.fs`) |

### See it work

`read` returns every line prefixed by its hash — the hash *is* the line's address:

```text
ve7│function hello() {
szJ│  console.log("world");
kQm│}
```

`edit` targets a range of hashes, so edits always land on the lines you meant:

```json
{ "path": "src/main.ts", "edits": [["szJ", "szJ", "  console.log('hi');"]] }
```

and returns a diff with fresh anchors, so the next edit verifies cleanly with no re-read:

```text
- szJ │   console.log("world");
+ a3m │   console.log('hi');
  kQm │ }
```

Chained edits stay cheap — anchors for untouched lines remain valid, diff/echo rows count as serves, and `read` becomes on-demand recovery, not a ritual. Try batching — one `edit` call, same-file, atomic:

```json
{ "path": "src/main.ts", "edits": [["a1b", "a1b", "new line 1\n"], ["c3d", "c3d", "new line 2"]] }
```

One fails, none write (`[E_BATCH_ABORT]`). Encoding errors `[E_BAD_ENCODING]`/`[E_DECODE_FAILED]` are also emitted.

> [!TIP]
> **Want proof before you install?** The upstream [23/23 tool battery](https://github.com/Rianico/pi-better-edit/blob/main/benchmarks/README.md) runs with no LLM — stale edits are rejected before they corrupt a file, on every run. Same hashline algorithm, same verification.

### Configuration

Tenancy and prompt guidance are both declared once, read at `agent/session-start`, and need no code changes.

#### Store tenancy — central by default

The store lives at `$DSH_HOME/plugins/dsh-better-edit/runtime/<name>-<hash8>/` by default (`central`).

> [!NOTE]
> DB files are **disposable caches** — they are rebuilt automatically on the next `read` (hashes are re-derived from file content). Feel free to `rm -rf` any `runtime/<name>-<hash8>/` or `hash-store.sqlite*` to reclaim disk; no user data is lost (only anchor history and undo snapshots).

To opt into legacy co-location or a custom root:

```yaml
# $DSH_HOME/plugins/dsh-better-edit/config.yaml
storeDir: central              # where the store lives: "central" (default, in $DSH_HOME/.../runtime/<name>-<hash8>/) | "workspace" (legacy <ws>/.dsh_better_edit/) | "/abs/path" (custom root)
autoGitignore: false           # workspace only: when .git exists but .gitignore lacks .dsh_better_edit/, true = auto-append ".dsh_better_edit/", false = warn once
undo_ttl_s: 604800             # undo history TTL in seconds; -1 = keep forever (default 604800 = 7 days)
storeMaxAgeS: 2592000          # central janitor: max idle age in seconds before a runtime/<name>-<hash8>/ dir is evicted (default 2592000 = 30 days)
storeMaxTotalBytes: 524288000  # central janitor: max total bytes under runtime/ before LRU eviction (default 524288000 = 500 MB)
```

> [!TIP]
> If the file does not exist, a default `config.yaml` with commented defaults is generated on first boot (never overwrites an existing file).

Env overrides yaml (`env > yaml > central`), malformed falls back to `central` with a warning:

```sh
DSH_BETTER_EDIT_STORE_DIR=central|workspace|/abs
DSH_BETTER_EDIT_AUTO_GITIGNORE=true|false  # case-insensitive
```

`runtime/<name>-<hash8>/` is `ls`-readable with a `.wsPath` sidecar. See `docs/specs/issue-24-store-tenancy.md` for lifecycle (janitor `mtime>storeMaxAgeS` then LRU, WAL checkpoint, `undo` TTL).

#### Guidance per preset

The `tool:read` / `tool:edit` / `tool:undo_last_edit` prompt sections are plain-markdown files per agent preset, overridable without touching the plugin:

```
$DSH_HOME/plugins/dsh-better-edit/<preset>/<section>.md
```

(default home `~/.dsh`, so `~/.dsh/plugins/dsh-better-edit/`). The section table:

| File | Section | Default order |
| --- | --- | --- |
| `read.md` | `tool:read` | 130 |
| `edit.md` | `tool:edit` | 131 |
| `undo_last_edit.md` | `tool:undo_last_edit` | 133 |

On first boot the plugin seeds the three shipped presets — `standard/`, `code/`, `minimal/`, `cordis/` — each with the compiled guidance as editable files (plus `order` front-matter). See [Configuration details](#configuring-guidance-per-preset) for reset/restore. Full spec: `docs/specs/issue-24-store-tenancy.md` and guidance docs.

##### Reset / restore defaults

Emptying or deleting an override file restores that section's compiled default guidance and order: the default renders at session-start, and the file re-seeds at next boot.

- **Reset = delete the file, or empty it AND remove the front-matter fence.** A whitespace-only file with no fence means "I want the default" — the compiled default renders, and the file re-seeds at next boot for any preset dir, shipped or custom.
- **Blank on purpose = keep a valid fence.** Any well-formed `---` fence — even a keyless `---\n---\n`, even an empty body — is a deliberate-intent signal: the file is explicit content and is never reset or re-seeded.
- **Broken fence = fast fail.** A `---` fence that does not parse (missing closing `---`, non-integer `order`, unknown key) is rejected: the malformed text is never injected into the context, the compiled default renders, a warning names the file and the reason, and the file is left untouched on disk for repair.
- **Shipped vs custom.** Shipped preset files (`standard`, `code`, `minimal`, `cordis`) re-seed at boot; a deleted custom-preset override stays absent — absence is no override. Deleting a whole `<preset>/` directory re-seeds all three section files at boot (shipped presets).
- **Reset restores the current bundle defaults** — a plugin upgrade yields new defaults.

Re-seeding happens at boot, never mid-session.

## Why Hashline

**Correctness, not just brevity.** Every resolved edit range is verified against the
served rows — what `read`, a post-edit diff, or a rejection echo actually showed the model.
A line inside the range that changed on disk since it was served, or was never served, is
hard-rejected before any file I/O: `[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]` /
`[E_RANGE_UNVERIFIED]`, and the current range is echoed as fresh `HASH│content` rows. The
retry needs no `read`. Served state is session-scoped, so sub-agent serves never validate the main session's edits and vice versa.

**Content-addressed anchors.** Anchors are derived from line content (ASCII-whitespace
stripped), not position: edit one part of a file and the hashes of the rest stay put, so
chained edits need no re-reads. Re-inserting identical text keeps its hash — "edit X with
X" doesn't rotate the anchor. Anchors are unique by construction — repeated `}` or
`import` lines never share one.

**Chained edits without re-reading.** Post-edit diff rows, auto-read rows, and rejection
echoes all count as serves. `read` is on-demand recovery, not a per-edit ritual.

**Stop the loop.** A no-op edit reports `No changes made` and leaves anchors alone; the
same no-op re-sent three times is refused (`[E_NOOP_LOOP]`). `edit` applies up to 32
edits atomically — any stale item aborts the whole batch with `[E_BATCH_ABORT]`.

### Token economics: envelope savings

The compact JSON contract is primarily a **token-saving envelope change**. It removes repeated field names and escaped wrapper syntax while leaving the verified edit semantics unchanged:

- `edit` is one uniform payload: `{ "path": path, "edits": [[from, to, replacement], …] }` — `path` hoisted, arity by `edits.length`;
- replacement text is emitted once, and the old text is never repeated in the call.

#### Theoretical benchmark — serialized envelopes

This benchmark counts only the serialized edit payloads, not model reasoning, tool descriptions, reads, retries, or cache traffic. Same hashline algorithm as upstream — numbers reproduced from [`pi-better-edit/benchmarks/results/`](https://github.com/Rianico/pi-better-edit/tree/main/benchmarks/results) (pinned 12-edit corpus, `cl100k_base`):

| snapshot | `str_replace` | pi/dsh-better-edit: `edit` | pi/dsh-better-edit: `edit` (multi-item) | OMP: per-edit | OMP: one batch |
| --- | ---: | ---: | ---: | ---: | ---: |
| external pinned 12-edit corpus, current-envelope recount | 1,015 | 609 (**-40.0%**) | 582 (**-42.7%**) | 590 (**-41.9%**) | 480 (**-52.7%**) |
| local 12-edit configuration snapshot | 358 | 272 (**-24.0%**) | 241 (**-32.7%**) | 268 (**-25.1%**) | 180 (**-49.7%**) |

All percentages are savings against the `str_replace` value in the same row. The external row uses the pinned corpus, current object-root tuple envelopes, and current 3-character anchors. The local row is reproducible with `npm run benchmark` in the upstream repo; correctness is measured separately with the battery.

#### Practical benchmark — coding-agent session

This benchmark measures a real coding-agent loop rather than serialized envelopes. The practical advantage is round-trip efficiency: hashline completed the scenario in **3 tool calls**, versus **6 for OMP**. Upstream runs `pi` with `opencode-go/gpt-5.6-luna` at `high` thinking. Same algorithm downstream — we reference the upstream dated artifact:

| engine | tool calls | total tokens | saved vs OMP baseline | final correctness |
| --- | ---: | ---: | ---: | :---: |
| OMP patch wrapper | **6** | 28,467 | 0.0% | ✅ |
| hashline `edit` (multi-item) | **3 (fewest)** | 12,593 | **-55.8%** | ✅ |

Both engines preserved the external change and produced the expected final file in this sample. This result is one stochastic model run; it must not be read as a universal performance claim. Latest dated artifact: [2026-08-17 practical token benchmark](https://github.com/Rianico/pi-better-edit/blob/main/benchmarks/results/2026-08-17-practical-token-benchmark.md) · [hashline library battery](https://github.com/Rianico/pi-better-edit/blob/main/benchmarks/results/2026-08-17-hashline-library.md) · [tool battery](https://github.com/Rianico/pi-better-edit/blob/main/benchmarks/results/2026-08-17-tool-battery.md).

> **Scope & honesty.** These numbers are **payload + round-trip** measures, not throughput claims. The benchmark payload is deterministic; the practical run is stochastic. Dated results live upstream in `benchmarks/results/`; we do not re-run locally because the algorithm is identical.

## Tools

| Tool | What it does |
| ------ | -------------- |
| `read` | Returns a text file with every line as `HASH│content`. `offset` (1-based), `limit`. Paged output ends with `[Showing lines N-M of T. Use offset=… to continue.]`. Lines >200KB shown as a marker with a `sed` hint — hash anchors need full lines. |
| `read_skill` | Same file read as plain text — no `HASH│` prefixes, no served rows. For skill content (SKILL.md or any file); records no serves, so editing a file read this way starts with a `[E_RANGE_UNSERVED]` serve on the first edit. |
| `edit` | An object-root payload `{ "path": path, "edits": [[remove_from, remove_to, replacement_text], …] }`; the path may be `null` for anchor-based inference. A single item edits one range; several items batch same-file edits atomically (up to 32). Verifies every line of each inclusive range and reject-and-serve returns fresh anchors. |
| `undo_last_edit` | `{ path }` restores the most recent successful edit with its original content, BOM, line endings, and anchors; persisted across restarts. |

The built-in `write` remains available for full-file replacement. Before it runs, the plugin refuses only a candidate line that begins with the exact `HASH│` anchor served for the same session, canonical path, and line; the file stays unchanged and the response asks for a retry with file content only. It never generically strips hash-like text.

`edit` accepts `{ "path": path, "edits": [[remove_from, remove_to, replacement_text], …] }`. The path
position is a non-empty string or `null` for unique anchor-based inference. Each range is inclusive,
and an empty replacement deletes the range. All items are checked before file I/O and applied
atomically to that one file — one item per call is the norm, several same-file items batch in one call.

### Error codes

| Code | Meaning |
| --- | --- |
| `[E_BAD_SHAPE]` | The payload is not the fixed tuple shape, or a tuple member has an unknown, missing, or wrongly-typed value. |
| `[E_BAD_REF]` | An anchor in the inclusive range is not a bare 3-char hash. |
| `[E_STALE_ANCHOR]` | An anchor does not match any line in the current file; call `read` for fresh anchors. |
| `[E_AMBIGUOUS_ANCHOR]` | An anchor matches multiple lines; call `read` for fresh anchors. |
| `[E_INVALID_PATCH]` | A `replacement_text` line is a diff-preview row (`+HASH│`, `-HASH│`, `-   │`). The marker is stripped automatically with a warning. |
| `[E_BARE_HASH_PREFIX]` | A `replacement_text` line starts with a hash-like `HASH│` prefix. The prefix is stripped automatically with a warning. |
| `[E_EDIT_HASH_ECHO]` | A `replacement_text` line begins with the exact `HASH│` anchor served for the same session, path, and range-relative line (`E1`). The edit is refused; remove the copied anchors and retry. Nothing was written. |
| `[E_BAD_OP]` | Range start line is after range end line. The pair is swapped automatically with a warning. |
| `[E_WOULD_EMPTY]` | An edit would empty a non-empty file; use `write` instead. |
| `[E_NOT_FOUND]` | The path does not exist. |
| `[E_ACCESS]` | The path is not readable or writable. |
| `[E_NOT_TEXT]` | The path is a directory, binary file, image, or UTF-16/UTF-32 encoded text; hashline editing only supports text files. |
| `[E_NOT_OBSERVED]` | The file has not been observed in this session (read-before-write); call `read` first. |
| `[E_WRITE_HASH_ECHO]` | A built-in `write` candidate copied a `HASH│` preview anchor served for the same session, path, and line. The write is refused before dispatch; remove the entire copied anchor chain and retry. |
| `[E_UNDO_STALE]` | `undo_last_edit` refused: the file was modified or deleted after the last edit. |
| `[E_UNDO_UNAVAILABLE]` | Undo history could not be persisted to the hash store; the `edit` was refused and the file was left unchanged. |
| `[E_FILE_TOO_LARGE]` | The file exceeds the 238,328-line hashline limit. |
| `[E_RANGE_STALE]` | A line inside the resolved edit range changed on disk since it was served (read output, diff, or rejection feedback). The edit is refused and the current range is echoed as fresh `HASH│content` rows; retry with those rows (no `read` needed). |
| `[E_RANGE_UNSERVED]` | A line inside the resolved edit range was never served to the model (paged reads, truncated output). The edit is refused and the current range is echoed as fresh `HASH│content` rows. |
| `[E_RANGE_UNVERIFIED]` | A boundary anchor (`remove_from`/`remove_to`) has no served position or was served at multiple positions, so the range cannot be verified against served state. The edit is refused and the current range is echoed as fresh `HASH│content` rows. |
| `[E_NOOP_LOOP]` | The exact same edit (same path, anchors, and replacement) was re-sent and produced no changes 3 consecutive times — the range already contains the replacement. The edit is refused and the current range is echoed as fresh `HASH│content` rows. |
| `[E_BATCH_ABORT]` | A multi-item `edit` call was rejected as a whole: an item failed validation or served-state verification. Nothing was written; the failing item's current range is echoed as fresh `HASH│content` rows. |

## Comparison

### Capability comparison

| | **dsh-better-edit** (this) | @oh-my-pi/hashline | `str_replace` (Claude Code / Codex) |
| --- | --- | --- | --- |
| Layer | dsh tools: `read` / `read_skill` / `edit` / `undo_last_edit` | patch-engine library: `Patcher` / `Patch` / `Filesystem` / `SnapshotStore` | built-in `str_replace` |
| Address format | `HASH│` — 3-char content hash, no line number | `[path#tag]` — full-file content tag + line numbers | text match |
| Whitespace-insensitive anchors | ✅ all ASCII whitespace stripped — survives `prettier`/`black`/`eslint --fix` | ~ n/a (anchors are line numbers) | ❌ |
| Duplicate lines | ✅ unique per line (collision-resolved); ambiguity → `[E_AMBIGUOUS_ANCHOR]` | ~ position-based — repeats fine, position unverified | ❌ first occurrence |
| Verified against what the model saw | ✅ every resolved line, per session — `[E_RANGE_STALE]`/`[E_RANGE_UNSERVED]` reject before write | ~ seen-lines provenance + file-version tag (H7) | ❌ first match wins |
| Stale interior | ✅ reject + fresh anchors (`[E_RANGE_STALE]`) | ~ recovery-with-warning, else `MismatchError` | ❌ may overwrite |
| Blind edit — lines never shown | ✅ hard reject (`[E_RANGE_UNVERIFIED]` / `[E_RANGE_UNSERVED]`) | ~ reject when seen-lines recorded (H7) | ❌ |
| Batch atomicity | ✅ `edit` multi-item — all-or-nothing, `[E_BATCH_ABORT]` | ✅ multi-section preflight (H8) | ❌ |
| Undo (persisted) | ✅ survives restarts | ❌ none | ❌ |
| Sub-agent session isolation | ✅ session-keyed served state | ~ | — |
| Deterministic battery | ✅ 23/23 | ✅ 10/10 library (own seam) | — |
| Runtime | dsh (Node) | Bun ≥ 1.3.14 (TS source) | — |

> `~` = occasionally / inconsistently. `—` = not specified / not applicable.

### Different jobs, same lineage

Both this plugin and `@oh-my-pi/hashline` descend from the harness-problem insight that
the model should never re-type old code, but they are different layers.

`@oh-my-pi/hashline` is a **patch-language library**: `[path#tag]` headers bind every hunk
to a full-file content hash, `PUT N.=M:` addresses lines by number, and it ships multi-hunk
documents, a pluggable filesystem for any backend (disk, in-memory, network), and
session-aware 3-way-merge recovery on stale tags. Its payload per edit is lighter and it cannot
be confused by repeated text — the line number is unambiguous.
This plugin is a **dsh tool pair**: `read` hands the model 3-char content hashes, `edit`
takes two of them, and every resolved line is verified against the served state — no line
numbers to renumber, no tag to refetch, a wrong anchor can never land on the wrong line,
and `undo_last_edit` survives restarts. Its trade-offs: a JSON envelope per edit costs a
little payload, and it lives inside dsh (Node) rather than as a standalone patcher (Bun). Pick
hashline-the-library for a cross-backend patch format; pick hashline-the-tool for verified,
content-addressed edits in your agent. Syntax-aware structural edits and file-lifecycle operations
remain outside this verified line-range contract.

### What you get

- **Verified before it writes** — every line of the resolved range is checked against served rows; stale or never-served interiors are hard-rejected (`[E_RANGE_STALE]`/`[E_RANGE_UNSERVED]`/`[E_RANGE_UNVERIFIED]`) and re-served as fresh anchors.
- **Session-keyed** — sub-agent serves never validate the main session's edits and vice versa.
- **Drift notices** — served territory outside the range that changed on disk is reported once per episode, not as a warning.
- **Chained without re-reads** — diff, auto-read, and rejection rows all count as serves.
- **Atomic batch** — up to 32 same-file edits in one `edit` call, all-or-nothing with `[E_BATCH_ABORT]`.
- **Formatter-tolerant** — ASCII-whitespace-insensitive anchors survive re-indents; unique by construction (bitset probing).

### Correctness in edge cases

The battery below measures *behavior*, where the two hashline implementations actually
diverge. These are the real failure modes from the harness-problem literature, and what
each tool does when they hit:

| Edge case | hashline `edit` (this) | @oh-my-pi/hashline patch |
| --- | --- | --- |
| Wrong address (off-by-one anchor / line number) | **Impossible** — anchors resolve to specific lines; every resolved line is verified against served state, rejected before anything is written | **Possible** — a wrong line number against a current tag applies silently at the wrong place; the tag proves the file version, never the lines |
| File changed on disk after the model's view | Hard reject + fresh anchors echoed (reject-and-serve); retry needs no `read` | Tag mismatch → refuse **or** best-effort 3-way merge onto unknown current content, with an explicit recovery banner |
| An edit above shifts the file | Nothing shifts — anchors are content addresses; the diff serves fresh anchors | **Every edit renumbers** — the format's own #1 rule is "re-ground after every edit"; the model carries the bookkeeping |
| Repeated / identical text | Per-line hashes are unique (collision-resolved); ambiguity → `[E_AMBIGUOUS_ANCHOR]` | Position-based, so repeats don't confuse it — but the position itself is unverified |
| Lines never shown to the model | `[E_RANGE_UNSERVED]` — hard reject with fresh anchors | Undisplayed hunks rejected when seen-lines are recorded — same reliance on the model knowing what it saw |
| Multi-edit batch fails mid-way | `edit` multi-item — atomic, all-or-nothing; the failing item is echoed as fresh serves | Multi-section patches preflighted up front — also atomic |

> The oh-my-pi payload saving is a lighter wire format; the table above is what that format
> asks the model to hold in its head instead — renumbering, tag-chasing — the
> exact component that fails most with replace-style edits. This plugin's contract is:
> a wrong edit cannot land, and any rejection needs no re-read. Both engines gate the same guarantee — **stale edits are detected, never silently applied** — with different policies when drift is found (recover-with-warning vs fail-closed rejection).

### Reproducible benchmark

The claims above are measured, not asserted. Two deterministic batteries — no LLM in the
loop, no sampling: a run either reproduces or it doesn't.

**Tool battery — 23 scenarios (2026-08-17):**

| vs expected verdict | correct | silent data-loss cases |
| --- | --: | --: |
| **dsh-better-edit** (same algorithm as pi-better-edit 1.1.4) | **23/23** | 0 |

Reproduce via upstream: `npm run eval` in `pi-better-edit` (this plugin shares the hashline algorithm byte-for-byte). Library battery for `@oh-my-pi/hashline` is 10/10 separately.

Full method, per-scenario tables, and limitations: upstream [benchmarks/README.md](https://github.com/Rianico/pi-better-edit/blob/main/benchmarks/README.md)
and [benchmarks/results/](https://github.com/Rianico/pi-better-edit/tree/main/benchmarks/results).

> See [Configuration](#configuration) under [Quick Start](#quick-start) for guidance overrides and store tenancy.

## How Anchors Work

Each line is canonicalized (all ASCII whitespace — spaces, tabs, carriage returns, and
line feeds — stripped) and hashed with [xxhash-wasm](https://github.com/jungomi/xxhash-wasm)
(xxHash32), then mapped to a 3-character string over `A-Za-z0-9` — 62³ = 238,328 possible
anchors. Canonicalization keeps anchors stable across formatting passes and editor-save
cycles: a line that changes only in ASCII whitespace keeps its anchor, so external linting
between edits does not invalidate it. Everything that is not ASCII whitespace stays
significant — string contents, regex classes, comments, quotes, semicolons, and Unicode
whitespace (NBSP) all rotate the anchor. One caveat: ASCII whitespace *inside* string
literals and regexes is stripped too, so a whitespace-only change within a string is
invisible to verification — benign in practice because formatters never alter string
contents. Token-level edits (quote style, semicolons, brace placement) therefore still
reject as stale.

The alphabet is sized for an LLM consumer — the model tokenizes rather than squinting at
glyphs, so case and digits are all included. The URL-safe specials `-` and `_` are
deliberately excluded: a hash starting with `-` is shape-identical to a diff-preview
deletion row, and `-`/`_` at a line start are markdown-active, inviting mis-copying.

Anchors are unique by construction. If a line's base hash collides with an already-assigned
hash, the next free hash is allocated from a bitset by probing with a stride coprime to the
hash space (O(1) amortized; the stride is 62² + 62 + 1, so runs of blank lines or repeated
`}` land on anchors that differ in all three characters). Every line therefore gets a
unique anchor; two byte-identical lines never share one. The same guarantee sets the file
size cap: at most 238,328 lines per file, beyond which `read` and `edit` reject with
`[E_FILE_TOO_LARGE]` (use `write` for very large files).

Hashes live in a persistent per-file store
(`<workspace>/.dsh_better_edit/hash-store.sqlite`, honoring `XDG_CONFIG_HOME` on
non-Windows) that keeps the hashes of unchanged lines across edits.

## How It Replaces the Built-in Tools

dsh's tool registry resolves per scope: an agent sees `agent → preset → global`, and its **own**
layer always wins. The built-in `read`/`edit` live on the agent-preset layer, so a plain global
registration cannot replace them. This plugin:

1. Mounts as a host-plane Cordis plugin via its `cordis.patch.yml` bundle patch.
2. On `agent/session-start`, registers the hashline tools **and** the `tool:read` / `tool:edit`
   prompt sections on the agent's own scope layer — they shadow the preset's built-ins for that
   agent and unwind automatically when the agent is disposed.
3. Leaves the built-in `write` in place: a scoped `tools/pre-execute` listener rejects an exact
   same-session/path/line served-anchor echo before dispatch, and `tools/post-execute` appends the
   hashline auto-read to successful results.

## Store

Hash snapshots, served-state rows, and undo history live in one SQLite store — **central by default** (`$DSH_HOME/plugins/dsh-better-edit/runtime/<name>-<hash8>/hash-store.sqlite`, `ls`-readable with `.wsPath` sidecar). Legacy co-located `<workspace>/.dsh_better_edit/` is still supported via `storeDir: workspace` in `config.yaml` and is copied once on first central open. Parallel sessions in different workspaces keep separate stores (the session cwd is carried through each tool call), so one project's anchors and undo history never leak into another's. Outside a tool call (tests, previews) the store falls back to the shared DeepSeek Harness home (`$DSH_HOME/plugins/dsh-better-edit/hash-store.sqlite`).

A 7-day TTL prunes served rows; `undo_ttl_s` (default 7d, `-1` forever) prunes undo clones; missing-file snapshots are pruned on throttled `openStore`; corrupt stores are quarantined and rebuilt automatically. The central janitor (`apply` + `agent/session-start` throttled >24h) evicts `mtime>storeMaxAgeS` (default 2592000 s = 30 days) then LRU to `count<100 && sum<500MB`, never deleting live `hash(workspaceCwd)`, with `wal_checkpoint(TRUNCATE)` on close. DB files are disposable caches — safe to delete, rebuilt on next `read`.

## Project Structure

```
dsh-better-edit/
├── src/
│   ├── hashline/        # hash + served-state core (ported from pi-better-edit)
│   ├── tool-read.ts     # read  — HASH│content, offset/limit paging
│   ├── tool-edit.ts     # edit  — {path, edits:[[hash,hash,text]]}, reject-and-serve
│   ├── tool-undo.ts     # undo_last_edit
│   ├── sandbox.ts       # FsSandboxController mirror (sandbox_permissions/justification)
│   ├── write-hook.ts    # auto-read appended to write results
│   ├── served-store.ts  # per-workspace SQLite store (node:sqlite)
│   └── workspace.ts     # session-cwd AsyncLocalStorage carrier
├── benchmark/           # frozen 103-line fixture (reference upstream for reproducible numbers)
│   └── corpus/          # frozen 103-line fixture
├── test/                # ported + regression tests
├── assets/              # logo + banner
├── cordis.patch.yml     # bundle patch
└── package.json         # dsh.bundle manifest
```

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc → lib/
```

### Releasing (tag-first)

```sh
npm run release -- 0.3.1                 # bump + CHANGELOG move + commit + tag + push → GitHub release
npm publish --registry https://registry.npmjs.org   # blocked until the version is tagged
```

`npm run release` bumps `package.json`/lockfile, moves the CHANGELOG `[Unreleased]` section to the
version, commits, tags `vX.Y.Z`, and pushes — the tag push creates the GitHub release from the
changelog. `npm publish` refuses to run until that tag exists (prepublishOnly gate), so every npm
version is always already tagged and released.

## Benchmark

Measured on the same 103-line file with the same 12 replacements (8 single-line, 4 multi-line of
3/6/10/15 lines), tokenized with the pinned `js-tiktoken` `cl100k_base`. Three arms emit the same
replacements: this plugin's `edit` (two 3-char anchors via `edits` tuple), a `str_replace` tool (old text echoed
verbatim), and [`@oh-my-pi/hashline`](https://www.npmjs.com/package/@oh-my-pi/hashline) in both of
its modes — one `[path#tag]` section per edit (`seq`) and one multi-hunk batch document (`batch`). Same hashline algorithm, so we reference the upstream reproducible results:

| Criterion | hashline | str_replace | oh-my-pi seq / batch |
| ----------- | :---: | :---: | :---: |
| Replaced text sent over the wire | ✅ never | ❌ every edit | ✅ never |
| Output tokens saved (12-edit session) | ✅ **31%** | ❌ 0% | ✅ **42% / 53%** |
| Multi-line range savings (3–15 lines) | ✅ **29–47%** | ❌ 0% | ✅ **40–53%** |
| Effective cost at 5× output pricing | ✅ **~1.4× less** | ❌ 1× | ✅ **~1.7× / ~2.1× less** |
| Ranges verified against served state | ✅ 100% | ❌ none | ~ file version only |
| Line numbers the model must track | ✅ none — content anchors | ✅ none — text match | ❌ renumber every edit |
| Deterministic, reproducible locally | ✅ via upstream `npm run benchmark` | — | — |

| Scenario | Lines | hashline | str_replace | oh-my-pi seq | oh-my-pi batch |
| --- | :---: | :---: | :---: | :---: | :---: |
| single-line ×8 | 1 | 309 | 324 | 241 | — |
| multi-line ×4 | 3–15 | 393 | 691 | 349 | — |
| **TOTAL ×12** | | **702** | **1015** | **590** | **480** |

Saved vs `str_replace`: hashline **313 (31%)** · oh-my-pi per-edit **425 (42%)** · oh-my-pi batch **535 (53%)**.

Upstream is the source of truth for reproducibility: [`pi-better-edit/benchmark/README.md`](https://github.com/Rianico/pi-better-edit/blob/main/benchmarks/README.md) and [`benchmarks/results/`](https://github.com/Rianico/pi-better-edit/tree/main/benchmarks/results). This plugin shares the hashline algorithm byte-for-byte, so we do not re-run locally.

> **Scope & honesty.** The benchmark measures **request-payload tokens** — what the model emits per
> edit call — with identical read traffic excluded (it cancels) and identical replacement text.
> It does **not** model transcription failure and retries, which is where the real-world gap is
> largest. The correctness gap behind those numbers is spelled out above in [Correctness in edge cases](#correctness-in-edge-cases).

## Roadmap

**Current state (0.3.1):** hashline `edit` with merged payload `{path, edits:[[hash,hash,text]]}`, whitespace-insensitive anchors, orphan healing, per-workspace store, 674 tests.

<details><summary>Next</summary>

- Verify 0.3.1 live in a dsh session after the orphan-healing + canon changes.
- Keep benchmark reference in sync with upstream releases (algorithm is shared).
- Re-check plugin wiring against the next dsh release (pinned to `0.1.0-rc.6`; dsh is in developer preview and promises breaking changes).

</details>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (or just open an [issue](https://github.com/Rianico/dsh-better-edit/issues)).
The most valuable contributions right now are more edge-case tests for the
served-state verification.

## License

MIT License — see [LICENSE](LICENSE) for details. Ported from pi-better-edit.

## Acknowledgments

Hash-anchored editing descends from Can Bölük's
[*The Harness Problem*](https://stencil.so/blog/the-harness-problem) — the post that showed the
harness, not the model, is the bottleneck, and that anchored edits beat search-and-replace. This
project stands on the shoulders of:

- [**pi-hashline-edit**](https://github.com/RimuruW/pi-hashline-edit) by RimuruW — the original
  pi-coding-agent extension that introduced hash anchors and the strict-semantics
  policy.
- [**pi-hashline-edit-pro**](https://github.com/YuGiMob/pi-hashline-edit-pro) by YuGiMob —
  the hardened fork this project is self-maintained from (3-char hashes, collision
  resolution, served-state verification, persisted undo).
- [**pi-better-edit**](https://github.com/Rianico/pi-better-edit) — the upstream this project tracks. The hashline core is ported; the tool layer is rewritten on dsh's plugin API.
- [**@oh-my-pi/hashline**](https://www.npmjs.com/package/@oh-my-pi/hashline)
  by can1357 — the original oh-my-pi implementation and the hashline patch-language concept.

Related reading: [Hash anchors + Myers diff + single-token anchors
(dirac.run)](https://dirac.run/posts/hash-anchors-myers-diff-single-token) (a design review of the
O(S+R) → O(R) edit-call saving) and an independent
[hashline-vs-replace benchmark](https://nwyin.com/blogs/hashline-vs-replace-edit-bench.html).

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Rianico/dsh-better-edit&type=Date)](https://star-history.com/#Rianico/dsh-better-edit&Date)

---

<p align="center">
  <strong>⭐ If hashline editing made your agent edit better, give it a star!</strong>
</p>
