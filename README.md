<p align="center">
  <img src="assets/logo.svg" alt="dsh-better-edit" width="200">
</p>

<h1 align="center">dsh-better-edit</h1>

<p align="center">
  <strong>Hash-anchored edit tools for DeepSeek Harness.<br>
  Edit by content address — not by line numbers, not by string replacement. Fewer tokens. More attention for real work. Zero misapplied edits.</strong>
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#why-hashline">Why Hashline</a> •
  <a href="#benchmark">Benchmark</a> •
  <a href="#tools">Tools</a> •
  <a href="#acknowledgments">Acknowledgments</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.9-blue.svg" alt="Version">
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

> *"The harness — not the model — is the bottleneck."*
> — Can Bölük, [*The Harness Problem*](https://stencil.so/blog/the-harness-problem)

Most edit tools ask the model to echo the old code **token-for-token** before it can change anything
— and that's exactly where agents fail: 46–51% patch-format failure rates for several models with
replace-style edits. **dsh-better-edit** goes deeper. Every line of a file gets a unique 3-character
content hash, and edits target hashes. The old text is never echoed, anchors survive edits, and every
resolved range is verified against exactly what the model saw — wrong-line edits cannot silently land.

## Why you need this

`str_replace` makes the model re-type the code it's replacing — pure transcription cost (output tokens, billed ~5-6× input), and where agents fail most: 46–51% patch failures on real models, worse on bigger blocks, each failure costing a re-read and a retry.

Hashline sends two hashes instead of the old text — **31% fewer edit tokens** (43% on multi-line ranges) — and verifies every range against what the model saw: an edit lands where you meant, or fails loudly with fresh anchors. Anchors are content addresses that survive edits above, so chained edits skip re-reads — and a leaner context keeps the model's attention on the code, not on re-transcribing it.

Not for one-line touch-ups (near parity) or new files (`write`). It pays off in long sessions and structural edits — anywhere an edit must not land on the wrong line.

## Quick Start

### Install

```sh
dsh plugin --profile <name> add dsh-better-edit   # from npm
dsh plugin --profile <name> add /path/to/dsh-better-edit   # from a local checkout
```

The profile's next session runs with the hashline tools installed. To verify the layer is active:

```sh
dsh --profile <name> --dump-config   # shows a "# == dsh-better-edit" layer
```

| Requirement | |
| --- | --- |
| Node | `^22.19.0 \|\| >=24.0.0` (dsh's requirement; the store uses `node:sqlite`) |
| Profile | a dsh profile (`dsh plugin` initializes one on first use) |
| Backends | sandboxed / remote filesystems supported (writes go through `ctx.fs`) |

`read` returns every line prefixed by its hash — the hash *is* the line's address:

```text
ve7│function hello() {
szJ│  console.log("world");
kQm│}
```

`edit` targets a range of hashes, so edits always land on the lines you meant:

```json
{
  "path": "src/main.ts",
  "remove_from": "szJ",
  "remove_to": "szJ",
  "replacement_text": "  console.log('hi');"
}
```

and produces a diff with fresh anchors, so the next edit verifies cleanly with no re-read:

```text
− szJ │   console.log("world");
+ a3m │   console.log('hi');
  kQm │ }
```

## Configuring Guidance per Preset

The `tool:read` / `tool:edit` / `tool:batch_edit` / `tool:undo_last_edit` guidance sections are
plain-markdown files, overridable per agent preset. Override files live in the plugin's shared
home — never the workspace store:

```
$DSH_HOME/plugins/dsh-better-edit/<preset>/<section>.md
```

(default home `~/.dsh`, so `~/.dsh/plugins/dsh-better-edit/`). The section table:

| File | Section | Default order |
| --- | --- | --- |
| `read.md` | `tool:read` | 130 |
| `edit.md` | `tool:edit` | 131 |
| `batch_edit.md` | `tool:batch_edit` | 132 |
| `undo_last_edit.md` | `tool:undo_last_edit` | 133 |

On first boot the plugin seeds the four shipped presets — `standard/`, `code/`,
`minimal/`, `cordis/` — each with the compiled guidance as editable files (plus
`order` front-matter), so every preset's guidance starts editable rather than
blank. A `README.md` at the plugin-home root documents the scheme. Files are
seeded once and never rewritten, so your edits survive. A preset directory may
hold only the sections you want to override — the rest fall through to the
compiled defaults.

A file is pure prose unless it opens with an `order` front-matter fence, which moves the section in
the assembled system prompt:

```md
---
order: 150
---

<section text>
```

Per section, resolution reads `<preset>/<section>.md`, else the compiled
default. Files are read once per agent at session-start, so edits apply to new
sessions — never mid-session. A preset with no seeded directory (e.g. a
user-authored one) falls back to the compiled defaults unless you copy a seeded
dir to its name. A deployment without the `agentPresets` service (no preset
roster) keeps the compiled defaults and never touches these files; presets are
never required.

## Why Hashline

**Token-saving.** An edit call carries `remove_from` / `remove_to` (two 3-char hashes) plus the
replacement text — it never echoes the text being replaced. A `str_replace` call must reproduce that
text verbatim. On a 12-edit session over a realistic file this is **31% fewer output tokens** (43%
on multi-line ranges) — and these are *output* tokens, billed at ~5-6× the input rate. See the
[benchmark](#benchmark).

**But this was never about “fewest tokens.”** Savings scale with the replaced text — near parity on
one-line touch-ups — and a compact patch language like [@oh-my-pi/hashline](#how-it-compares) can
emit a lighter payload still (42–53% on the same session). The point is the *right* kind of edit
call: no re-typing old code, and nothing for the model to track except two stable content addresses.

**Correctness.** Every resolved edit range is verified against the exact lines the model was shown.
A stale, never-served, or ambiguous range is hard-rejected **before anything is written**, and the
current range is echoed back as fresh anchors (reject-and-serve) — the retry needs no `read`.

**A modern edit pattern for agents.** Content-addressed anchors are line-number-agnostic: edit one
part of a file and the hashes of the rest stay put, so chained edits need no re-reads. The model
pins a line by what it *is*, not by where it used to sit.

### How It Compares

| | hashline `edit` | `str_replace` (Claude Code / Codex) | @oh-my-pi/hashline patch |
| --- | :---: | :---: | :---: |
| Replaced text never echoed in the call | ✅ 2 hashes only | ❌ verbatim | ✅ `+` rows only |
| Lines addressed by | content hash | text match | number + file-content tag |
| Verified against what the model saw | ✅ every line | ❌ first match wins | ~ file version only |
| Stale file detected | ✅ rejects, fresh anchors | ❌ may match wrong spot | ✅ tag mismatch → refuse or 3-way merge |
| Anchors survive edits above | ✅ content-addressed | ✅ content-based | ❌ renumber + new tag |
| Chained edits without re-reads | ✅ diff serves fresh anchors | ~ | ~ via edit-response numbers |
| Unambiguous when text repeats | ✅ boundary anchors verified | ❌ first occurrence | ~ position, unverified per line |
| Wrong-line edit never lands silently | ✅ every line verified | ❌ first match wins | ~ possible in principle (tag checks version, not lines) |
| Block ops / registers / `MV` / `REM` | ❌ | ❌ | ✅ |
| One document per change | ❌ per-edit call | ❌ per-edit call | ✅ multi-hunk patch |
| Runtime | ✅ Node (dsh) | — | ⚠️ Bun only |
| Undo | ✅ persisted | ❌ | ❌ not in scope |

> `~` = occasionally / inconsistently. `@oh-my-pi/hashline` is a compact line-anchored patch language
> ([npm](https://www.npmjs.com/package/@oh-my-pi/hashline), [repo](https://github.com/can1357/oh-my-pi/tree/main/packages/hashline)):
> `[path#tag]` headers bind each hunk to a full-file content hash, `PUT N.=M:` addresses lines by
> number, and every edit renumbers — take the next numbers and tag from the edit response or a fresh `read`.

**Different jobs, same lineage.** Both descend from the
[harness-problem](https://stencil.so/blog/the-harness-problem) insight that the model should never
re-type old code. `@oh-my-pi/hashline` is a **patch-language library** — payload-light (42% saved
per edit, 53% in a single batch document, see [benchmark](#benchmark)), with syntactic block ops
(`PUT N*:`), registers, `REM`/`MV`, multi-hunk documents, a pluggable filesystem for any backend,
and session-aware 3-way-merge recovery on stale tags. This plugin is a **dsh tool pair**: `read`
hands the model 3-char content hashes, `edit` takes two of them, and every resolved line is verified
against the served state — no line numbers to renumber, no tag to re-fetch, a wrong anchor can never
land on the wrong line, and `undo_last_edit` survives restarts. Its trade-offs: a JSON envelope per
edit costs a little payload, there are no block ops, and it lives inside dsh (Node) rather than as a
standalone patcher (Bun). Pick hashline-the-library for a cross-backend patch format; pick
hashline-the-tool for verified, content-addressed edits in your agent.

### Correctness in edge cases

The token benchmark measures the payload the model emits — it assumes the model gets every
address right, for free. Correctness is where the two hashline implementations actually diverge.
These are the real failure modes from the harness-problem literature (wrong-line edits, drift,
repeated text), and what each tool does when they hit:

| Edge case | hashline `edit` (this plugin) | @oh-my-pi/hashline patch |
| --- | --- | --- |
| Wrong address (off-by-one anchor / line number) | **Impossible** — anchors resolve to specific lines; every resolved line is verified against served state, rejected **before** anything is written | **Possible** — a wrong line number against a current tag applies **silently** at the wrong place; the tag proves the file version, never the lines |
| File changed on disk after the model's view | Hard reject + fresh anchors echoed (reject-and-serve); retry needs no `read` | Tag mismatch → refuse **or best-effort 3-way merge** onto unknown current content |
| An edit above shifts the file | Nothing shifts — anchors are content addresses; the diff serves fresh anchors | **Every edit renumbers** — “RE-GROUND AFTER EVERY EDIT” is the format's own #1 rule; the model carries the bookkeeping |
| Repeated / identical text | Per-line hashes are unique (collision-resolved); ambiguity → `[E_AMBIGUOUS_ANCHOR]` | Position-based, so repeats don't confuse it — but the position itself is unverified |
| Lines never shown to the model | `[E_RANGE_UNSERVED]` — hard reject with fresh anchors | Undisplayed hunks rejected — same reliance on the model knowing what it saw |
| Mid-expression / wrong block node | Irrelevant — any verified line range is valid | Grammar rules + `PUT N*:` node choice; mispointing (anchoring `def` orphans its decorator) silently lands wrong; no syntax check |
| Multi-edit batch fails mid-way | `batch_edit` — atomic, all-or-nothing; the failing item is echoed as fresh serves | Multi-section patches preflighted up front — also atomic |

> The 42–53% oh-my-pi payload saving is a lighter wire format; the table above is what that
> format asks the model to hold in its head instead — renumbering, tag-chasing, node choice —
> the exact component that fails most (46–51% patch-failure rates on replace-style edits). This
> plugin's 31% is the price of a contract where a wrong edit cannot land, and any rejection
> needs no re-read.

## Benchmark

Measured on the same 103-line file with the same 12 replacements (8 single-line, 4 multi-line of
3/6/10/15 lines), tokenized with the pinned `js-tiktoken` `cl100k_base`. Three arms emit the same
replacements: this plugin's `edit` (two 3-char anchors), a `str_replace` tool (old text echoed
verbatim), and [`@oh-my-pi/hashline`](https://www.npmjs.com/package/@oh-my-pi/hashline) in both of
its modes — one `[path#tag]` section per edit (`seq`) and one multi-hunk batch document (`batch`):

| Criterion | hashline | str_replace | oh-my-pi seq / batch |
| ----------- | :---: | :---: | :---: |
| Replaced text sent over the wire | ✅ never | ❌ every edit | ✅ never |
| Output tokens saved (12-edit session) | ✅ **31%** | ❌ 0% | ✅ **42% / 53%** |
| Multi-line range savings (3–15 lines) | ✅ **29–47%** | ❌ 0% | ✅ **40–53%** |
| Effective cost at 5× output pricing | ✅ **~1.4× less** | ❌ 1× | ✅ **~1.7× / ~2.1× less** |
| Ranges verified against served state | ✅ 100% | ❌ none | ~ file version only |
| Line numbers the model must track | ✅ none — content anchors | ✅ none — text match | ❌ renumber every edit |
| Deterministic, reproducible locally | ✅ `npm run benchmark` | — | — |

### Reproducible

The numbers above are **deterministic and you can reproduce them locally** — `npm run benchmark`:

| Scenario | Lines | hashline | str_replace | oh-my-pi seq | oh-my-pi batch |
| --- | :---: | :---: | :---: | :---: | :---: |
| single-line ×8 | 1 | 309 | 324 | 241 | — |
| multi-line ×4 | 3–15 | 393 | 691 | 349 | — |
| **TOTAL ×12** | | **702** | **1015** | **590** | **480** |

Saved vs `str_replace`: hashline **313 (31%)** · oh-my-pi per-edit **425 (42%)** · oh-my-pi batch **535 (53%)**.

The script is deterministic by construction: a frozen corpus, a content-addressed edit script that
self-checks (a reformatted corpus throws instead of silently changing what's measured), a pinned
tokenizer, and oh-my-pi payloads validated against the package's published grammar before counting.
Because everything is fixed, `npm run benchmark` gives everyone the same result — the numbers in
this README are a snapshot of that run; regenerate, don't trust.

> **Scope & honesty.** The benchmark measures **request-payload tokens** — what the model emits per
> edit call — with identical read traffic excluded (it cancels) and identical replacement text.
> It does **not** model transcription failure and retries, which is where the real-world gap is
> largest: the original [harness-problem](https://stencil.so/blog/the-harness-problem) post reported
> a **61% output-token reduction** and patch-failure drops from 46–51% to near zero after switching
> to anchored edits. It also does **not** model what a line-numbered format costs the model *between*
> calls — renumbering and re-fetching the file tag after every edit — nor block-op power, nor the
> Bun-vs-Node runtime difference, nor the fact that `@oh-my-pi/hashline` is a standalone patcher
> while this plugin is a dsh tool pair with `read`/`edit`/`undo`. Full methodology, the per-edit
> table, and the complete limitation list in [`benchmark/README.md`](benchmark/README.md). The correctness gap behind those numbers is spelled out above in [Correctness in edge cases](#correctness-in-edge-cases).

## Tools

| Tool | What it does |
| ------ | -------------- |
| `read` | Returns a file with every line as `HASH│content`. Parameters: `offset` (1-based), `limit`. Paged output ends with `[Showing lines N-M of T. Use offset=… to continue.]`. Lines >200KB are shown as a marker with a `sed` hint — hash anchors need full lines. |
| `edit` | Replaces a range of lines by hash. `path` · `remove_from` · `remove_to` · `replacement_text` (`""` deletes). Verifies **every line** of the resolved range against served state; `[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]` / `[E_RANGE_UNVERIFIED]` reject-and-serve fresh anchors. |
| `batch_edit` | Up to 32 edits in one atomic call: `{ edits: [{ path?, remove_from, remove_to, replacement_text }, …] }`. All-or-nothing; the failing item's range is echoed as fresh serves. |
| `undo_last_edit` | `{ path }` reverts the last hashline edit, only while the file still matches the stored post-edit content; survives restarts. |

### Error codes

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

## How It Replaces the Built-in Tools

dsh's tool registry resolves per scope: an agent sees `agent → preset → global`, and its **own**
layer always wins. The built-in `read`/`edit` live on the agent-preset layer, so a plain global
registration cannot replace them. This plugin:

1. Mounts as a host-plane Cordis plugin via its `cordis.patch.yml` bundle patch.
2. On `agent/session-start`, registers the hashline tools **and** the `tool:read` / `tool:edit`
   prompt sections on the agent's own scope layer — they shadow the preset's built-ins for that
   agent and unwind automatically when the agent is disposed.
3. Leaves the built-in `write` in place, but a scoped `tools/post-execute` listener appends the
   hashline auto-read to write results.

## Store

Hash snapshots, served-state rows, and undo history live in one SQLite store **co-located with the
workspace being edited** — one store per session cwd:

```
<workspace>/.dsh_better_edit/hash-store.sqlite
```

Parallel sessions in different workspaces keep separate stores (the session cwd is carried through
each tool call), so one project's anchors and undo history never leak into another's. Outside a tool
call (tests, previews) the store falls back to the shared DeepSeek Harness home
(`$DSH_HOME/plugins/dsh-better-edit/hash-store.sqlite`).

A 7-day TTL prunes served rows; missing-file snapshots are pruned at startup. Corrupt stores are
quarantined and rebuilt automatically. Moving to the per-workspace layout does not migrate earlier
undo history from the shared home — treat any pre-0.1.2 undo entries as gone.

## Project Structure

```
dsh-better-edit/
├── src/
│   ├── hashline/        # hash + served-state core (ported byte-for-byte from pi-hashline-edit-lsz)
│   ├── tool-read.ts     # read  — HASH│content, offset/limit paging
│   ├── tool-edit.ts     # edit  — range-by-hash, reject-and-serve
│   ├── tool-batch-edit.ts
│   ├── tool-undo.ts     # undo_last_edit
│   ├── sandbox.ts       # FsSandboxController mirror (sandbox_permissions/justification)
│   ├── write-hook.ts    # auto-read appended to write results
│   ├── served-store.ts  # per-workspace SQLite store (node:sqlite)
│   └── workspace.ts     # session-cwd AsyncLocalStorage carrier
├── benchmark/           # reproducible hashline-vs-str_replace-vs-oh-my-pi token benchmark
│   └── corpus/          # frozen 103-line fixture
├── test/                # 615 tests (ported + regression)
├── assets/              # logo + banner
├── cordis.patch.yml     # bundle patch
└── package.json         # dsh.bundle manifest
```

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run (615 tests)
npm run build       # tsc → lib/
npm run benchmark   # reproducible token-cost benchmark (benchmark/)
```

### Releasing (tag-first)

```sh
npm run release -- 0.2.0                 # bump + CHANGELOG move + commit + tag + push → GitHub release
npm publish --registry https://registry.npmjs.org   # blocked until the version is tagged
```

`npm run release` bumps `package.json`/lockfile, moves the CHANGELOG `[Unreleased]` section to the
version, commits, tags `vX.Y.Z`, and pushes — the tag push creates the GitHub release from the
changelog. `npm publish` refuses to run until that tag exists (prepublishOnly gate), so every npm
version is always already tagged and released.

The test suite is ported from pi-hashline-edit-lsz and drives the dsh tool builders directly over a
local filesystem bridge.

## Roadmap

**Current state (0.1.6):** 615 tests, per-workspace store, sandbox policy participation, the
served-tail truncation fix, reproducible benchmark, EN + 中文 READMEs, published on npm.

<details><summary>Next</summary>

- **Close or justify the gap vs @oh-my-pi/hashline** (reference: [`../oh-my-pi.md`](../oh-my-pi.md)). The sibling patch language is payload-lighter — 42%/53% vs our 31% vs `str_replace` on the benchmark, because a bare patch document skips the JSON envelope we pay per call — and offers four abilities we do not support: syntactic block ops (`PUT N*:`), registers + `REM`/`MV`, one multi-hunk document per change, and a pluggable filesystem. The counterweight is correctness: its line numbers are unverified (a wrong number on a current tag lands silently), every edit renumbers, stale tags trigger best-effort 3-way merge instead of verification, and the grammar raises the model skill floor. Decide each ability reject-or-adopt on its own merits — the payload gap alone is not a reason to switch formats.
- Verify 0.1.6 live in a dsh session after the served-tail fix.
- Upstream the served-tail truncation fix to pi-hashline-edit-lsz / upstream (their `upsertServed`
  never truncates either).
- Re-check plugin wiring against the next dsh release (pinned to `0.1.0-rc.6`; dsh is in developer
  preview and promises breaking changes).

</details>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (or just open an [issue](https://github.com/Rianico/dsh-better-edit/issues)).
The most valuable contributions right now are more benchmark scenarios and edge-case tests for the
served-state verification.

## License

MIT License — see [LICENSE](LICENSE) for details. Ported from pi-hashline-edit-lsz (MIT), which
itself carries the upstream copyrights of RimuruW and YuGiMob.

## Acknowledgments

Hash-anchored editing descends from Can Bölük's
[*The Harness Problem*](https://stencil.so/blog/the-harness-problem) — the post that showed the
harness, not the model, is the bottleneck, and that anchored edits beat search-and-replace. This
project stands on the shoulders of:

- [**pi-hashline-edit**](https://github.com/RimuruW/pi-hashline-edit) by RimuruW — the original
  pi-coding-agent extension that introduced 3-character hashes and collision resolution.
- [**pi-hashline-edit-pro**](https://github.com/YuGiMob/pi-hashline-edit-pro) by YuGiMob — the
  hardened fork the hashline core here is ported from.
- [**pi-hashline-edit-lsz**](https://github.com/Rianico/pi-hashline-edit-lsz) — the self-maintained
  fork this project tracks. The hashline core is ported byte-for-byte; the tool layer is rewritten
  on dsh's plugin API.

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
