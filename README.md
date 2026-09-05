<p align="center">
  <img src="assets/logo.svg" alt="dsh-better-edit" width="200">
</p>

<h1 align="center">dsh-better-edit</h1>
<p align="center">
  <strong>A better edit tool for DeepSeek Harness<br>
  Position-free hashes — one read, many edits, fewer tokens, more room for real work.</strong>
</p>
<p align="center">
  <strong>English</strong> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="#why-you-need-this"><img src="https://img.shields.io/badge/why-hashline-blue?style=flat" alt="why hashline"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/quick_start-30s-brightgreen?style=flat" alt="quick start 30s"></a>
  <a href="#benchmark"><img src="https://img.shields.io/badge/correctness-23%2F23-success?style=flat" alt="23/23 battery"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#why-hashline">Why Hashline</a> •
  <a href="#tools">Tools</a> •
  <a href="#benchmark">Benchmark</a> •
  <a href="#how-anchors-work">How Anchors Work</a> •
  <a href="#development">Development</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.6.1-blue.svg" alt="Version">
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

> **This is the harness fix.** Hashes replace line numbers — edits above don't shift anchors below. One `read` serves many `edit`s; drift outside your range passes with a notice, true conflicts retry with fresh anchors — no full `read` needed.

> **3 calls vs 6 · -55.8% tokens · 23/23 correctness.** Same external-drift refactor, same file (single stochastic run; [method](https://github.com/Rianico/pi-better-edit/blob/main/benchmarks/results/2026-08-17-practical-token-benchmark.md)). Payload numbers are deterministic — see [Benchmark](#benchmark).

## Why you need this

**If you've watched `line 47 → 74` corrupt a file after an insert — this is for you.**

| Before: `str_replace` / line numbers | After: hashline `edit` |
| --- | --- |
| Re-types old code (~5-6× billed) | Two `3-char` hashes, old text never echoed |
| One insert shifts every number → silent wrong line | Content addresses — edits above don't move anchors below |
| No check against what was shown | Every line verified; `[E_STALE_RANGE]`/`[E_UNSERVED_RANGE]` reject before write, then **reject-and-serve** returns fresh `HASH│content` |

> [!TIP]
> **Shining points — honest:**
>
> - **Position-free.** `read 1..5` → `insert @0` → `edit 10..12` still lands at `10..12`. Anchors are `canon(line)` hashes, not positions (ADR-0013). Exterior drift is a notice, not a re-read.
> - **Fewer round-trips.** Single-session `1 read → N edits` — no ritual re-reads. Multi-session exterior `A:10..12 / B:20..30` also passes; only overlapping `A∩B≠∅` retries once via `servedRows` (no full `read`). Harness `9/9` green.
> - **Fewer tokens.** Compact payload `{path, edits:[[from,to,text]]}` + never echoing `old_string`; diff/echo/rejection rows count as serves. Envelope `-40%` pinned 12-edit corpus, session `-55.8%` on external-drift.
> - **Concurrent-safe, not silent.** `tombstone` per `(session,path)` epoch blocks re-bound `S@3→@3`; `canon` + `hash` + `changed∩[L,R]` makes `pos-free` single-thread and `strict` only on true overlap. One retry vs silent wrong-line.

Not for one-line touch-ups (near parity) or new files (`write`). Pays off in long sessions and structural edits.

## Quick Start — install to verified edit in 30s

### Install (pick one)

```sh
npx @deepseek-ai/dsh plugin --profile web add github:Rianico/dsh-better-edit   # from github
npx @deepseek-ai/dsh plugin --profile web add dsh-better-edit                 # from npm
npx @deepseek-ai/dsh plugin --profile web add /path/to/dsh-better-edit       # local
```

No config. Next session runs with hashline tools. Verify:

```sh
dsh --profile <name> --dump-config   # shows "# == dsh-better-edit" layer
```

| Requirement | |
| --- | --- |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Profile | `dsh` profile (`dsh plugin` creates one) |
| Backends | sandboxed / remote `ctx.fs` |

### See it work

`read` serves `HASH│content` — the hash *is* the address:

```text
ve7│function hello() {
szJ│  console.log("world");
kQm│}
```

`edit` by hashes — always lands where you meant:

```json
{ "path": "src/main.ts", "edits": [["szJ", "szJ", "  console.log('hi');"]] }
```

Returns a diff with fresh anchors — next edit needs no `read`:

```text
- szJ │   console.log("world");
+ a3m │   console.log('hi');
  kQm │ }
```

**Position-free in one line:** `read 1..5` → `insert @0` → `edit 10..12` still verifies `10..12` (`resist` mode). **Multi-session honesty:** `A:10..12+1` shifts `B:20..30→21..31` → `B` passes (drift notice); `B:12..13` overlapping `A` → `E_STALE_RANGE` + fresh rows, one retry.

Batch atomically — one `edit`, up to 32 same-file ranges:

```json
{ "path": "src/main.ts", "edits": [["a1b","a1b","new line 1\n"], ["c3d","c3d","new line 2"]] }
```

One fails → none write (`[E_BATCH_ABORT]`).

> [!TIP]
> **Want proof before you install?** Upstream [23/23 battery](https://github.com/Rianico/pi-better-edit/blob/main/benchmarks/README.md) runs no LLM — stale edits are rejected every run. Same algorithm.

### Configuration

Tenancy and prompt guidance declare once, read at `agent/session-start`, no code change.

**Store** central by default `$DSH_HOME/plugins/dsh-better-edit/runtime/<name>-<hash8>/` (`ls`-readable + `.wsPath` sidecar). DBs are disposable caches — `rm -rf runtime/<name>-<hash8>/` is safe, rebuilt on next `read`.

```yaml
# $DSH_HOME/plugins/dsh-better-edit/config.yaml
storeDir: central              # central | workspace | /abs
autoGitignore: false
undo_ttl_s: 604800             # 7d, -1 forever
storeMaxAgeS: 2592000          # 30d janitor
storeMaxTotalBytes: 524288000  # 500 MB LRU
```

Env overrides yaml (`DSH_BETTER_EDIT_STORE_DIR`, `DSH_BETTER_EDIT_AUTO_GITIGNORE`).

**Guidance per preset** — `tool:read` / `tool:edit` / `tool:undo_last_edit` are plain markdown per preset at `$DSH_HOME/plugins/dsh-better-edit/<preset>/<section>.md` (orders `130/131/133`). Delete or empty a file → default re-seeds at next boot; keep a `---` fence to blank on purpose.

## Why Hashline

**Verified against what was served.** Every resolved line checked against `read`/diff/rejection rows. Stale or unseen → `[E_STALE_RANGE]`/`[E_UNSERVED_RANGE]` + fresh `HASH│content`, retry needs no `read`. Session-scoped — sub-agent serves never validate main edits.

**Content-addressed.** `canon(line)` strips ASCII whitespace, `xxh32 → 62³=238,328` anchors. Re-inserting identical text keeps its hash; `prettier`/`eslint --fix` between edits doesn't invalidate. Unique by bitset probing — `}`/`import` repeats never collide; cap `238,328` lines (`[E_LARGE_FILE]`).

**No loop, no ritual.** No-op → `No changes made`; same no-op ×3 → `[E_NOOP_LOOP]`. Diff/echo/rejection rows count as serves — `read` is recovery, not ritual.

### Token economics

Envelope change: hoist `path`, `edits:[[from,to,text]]`, never repeat `old_string`.

| snapshot | `str_replace` | `edit` | `edit` multi | OMP per-edit | OMP batch |
| --- | ---: | ---: | ---: | ---: | ---: |
| pinned 12-edit corpus | 1,015 | 609 **-40.0%** | 582 **-42.7%** | 590 **-41.9%** | 480 **-52.7%** |
| local snapshot | 358 | 272 **-24.0%** | 241 **-32.7%** | 268 **-25.1%** | 180 **-49.7%** |

Percent vs `str_replace`. External row pinned corpus, `cl100k_base`; local `npm run benchmark` in upstream.

| engine | calls | tokens | saved | ok |
| --- | ---: | ---: | ---: | :---: |
| OMP | **6** | 28,467 | — | ✅ |
| hashline `edit` | **3** | 12,593 | **-55.8%** | ✅ |

Single stochastic run, `opencode-go/gpt-5.6-luna` high. [Artifact](https://github.com/Rianico/pi-better-edit/blob/main/benchmarks/results/2026-08-17-practical-token-benchmark.md).

> **Scope & honesty.** Payload deterministic; practical run stochastic. We measure **payload + round-trips**, not throughput. Retries are where the gap is largest — see [edge cases](#comparison).

## Tools

| Tool | What it does |
| --- | --- |
| `read` | `HASH│content` with `offset`/`limit`; `[Showing N-M of T]` paging; `>200KB` lines show marker |
| `read_skill` | Plain text, no hashes, no serves — editing after it needs a serve |
| `edit` | `{path, edits:[[from,to,text]]}` `path:string\|null` inference, `""` deletes, atomic ≤32, verify-then-write |
| `undo_last_edit` | `{path}` restores last edit (BOM/line endings/anchors), persisted |

`write` stays, but refuses an exact `HASH│` echo for same `session/path/line` before dispatch.

### Error codes

| Code | Meaning |
| --- | --- |
| `[E_BAD_PAYLOAD]` | Bad tuple shape (payload must be `{path, edits}` with 3-position tuples) |
| `[E_STALE_ANCHOR]` | No line (hash/tombstone/canon miss) / multi-line → `read` |
| `[E_BAD_ANCHOR]` | Not bare `3-char`, or `replacement_text` carries `HASH│`/diff-preview prefixes — refused, remove and retry |
| `[E_SERVED_ECHO]` | Copied `HASH│` from same session/path/line — refused, remove and retry |
| `[E_EMPTY_RANGE]`/`[E_NOT_FOUND]`/`[E_ACCESS]`/`[E_UNSUPPORTED_FILE]`/`[E_LARGE_FILE]` | Empty guard / missing / access / binary / >238,328 lines |
| `[E_REVERSED_ANCHORS]` | Swapped range — healed with dimmed `[USER]` notice on success, otherwise refused |
| `[E_BAD_ENCODING]`/`[E_DECODE_FAILED]` | Encoding / decode failed |
| `[E_NOT_OBSERVED]`/`[E_STALE_RANGE]`/`[E_UNSERVED_RANGE]` | Served-state miss — echoed fresh `HASH│content` |
| `[E_UNDO_STALE]`/`[E_UNDO_UNAVAILABLE]` | Undo stale / unavailable |
| `[E_NOOP_LOOP]`/`[E_BATCH_ABORT]` | 3× same no-op / atomic batch fail → nothing written |

Full list in `src/` — every rejection echoes fresh rows, no `read` needed.

## Comparison

| | **dsh-better-edit** | @oh-my-pi/hashline | `str_replace` |
| --- | --- | --- | --- |
| Address | `HASH│` 3-char canon | `[path#tag]` + line | text match |
| Whitespace-insen. | ✅ | ~ n/a | ❌ |
| Duplicate lines | ✅ unique | ~ pos | ❌ first |
| Verified vs served | ✅ every line | ~ file tag | ❌ |
| Blind edit | ✅ reject | ~ | ❌ |
| Batch atomic | ✅ | ✅ | ❌ |
| Undo | ✅ | ❌ | ❌ |
| Battery | 23/23 | 10/10 | — |

`~` partial, `—` n/a. Same lineage — patch library vs dsh tool pair; pick by seam.

**Edge cases:** wrong anchor impossible (verified), disk drift → reject+serve, shift above → nothing moves, repeats → unique/ambiguous, unseen → reject, batch → atomic. See upstream [benchmarks](https://github.com/Rianico/pi-better-edit/blob/main/benchmarks/README.md).

**Battery:** `23/23` tool, `10/10` library (upstream `npm run eval`, same algorithm).

## How Anchors Work

`canon(line)` strips ASCII whitespace → `xxHash32` → `A-Za-z0-9` 3-char (62³). Stable across `prettier`; Unicode/strings stay significant except ASCII whitespace inside strings (linter-only). `stride=62²+62+1` probes bitset → unique; cap `238,328`. Store `hash-store.sqlite` per workspace (central, honoring `XDG_CONFIG_HOME`); 7-day served TTL, janitor `storeMaxAgeS/LRU` + `wal_checkpoint`.

## How It Replaces Built-ins

dsh resolves `agent → preset → global`; built-ins live on preset. Plugin via `cordis.patch.yml`: at `agent/session-start` registers `read/edit` on agent layer (shadows, auto-unwinds); `write` stays with `pre-execute` guard + `post-execute` auto-read.

## Project Structure

```
dsh-better-edit/
├── src/hashline/     # hash + served core
├── src/tool-*.ts     # read / edit / undo
├── src/served-store.ts # SQLite store
├── benchmark/corpus/ # 103-line fixture
├── test/             # 108 files, 1222 tests
├── assets/           # logo + banner
└── cordis.patch.yml
```

## Development

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm benchmark   # hash probe + session envelope (reads/retries/tokens)
```

## Benchmark

103-line file, 12 replacements (8×1 + 4×3/6/10/15), `cl100k_base`. `hashline` vs `str_replace` vs `oh-my-pi` `seq/batch`. Upstream is source of truth — same algorithm byte-for-byte.

| Criterion | hashline | str_replace | seq / batch |
| --- | :---: | :---: | :---: |
| `old_string` echoed | never | every edit | never |
| 12-edit saved | **31%** | 0% | **42% / 53%** |
| multi-line saved | **29–47%** | 0% | **40–53%** |
| 5× output cost | **~1.4× less** | 1× | **~1.7×/~2.1× less** |
| Verified | 100% | none | tag only |

| Scenario | hashline | str_replace |
| --- | ---: | ---: |
| `1×8` | 309 | 324 |
| `3–15×4` | 393 | 691 |
| **TOTAL ×12** | **702** | **1015** |

Saved **313 (31%)**. Reproduce: upstream `npm run benchmark`. See [`pi-better-edit/benchmark/README.md`](https://github.com/Rianico/pi-better-edit/blob/main/benchmarks/README.md).

> **Scope & honesty.** Benchmark is **request-payload tokens** (reads cancel, replacement text identical). No transcription-failure model — real gap larger; see [edge cases](#comparison).

## Roadmap

**Current `0.6.1`:** pos-free `resist`/`strict` + tombstone/canons/epoch, per-session `(session,path)` store, `1222` tests, `9/9` harness.

<details><summary>Next</summary>

- Keep `benchmark/run.mjs` in sync with `ADR-0013` (reads/retries/tokens per session)
- Re-check wiring vs next `dsh` (pinned `0.1.0-rc.6`)
- `README.zh.md` parity

</details>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Most valuable: more served-state edge-case tests.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

From Can Bölük's [*The Harness Problem*](https://stencil.so/blog/the-harness-problem). Thanks to [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit), [pi-hashline-edit-pro](https://github.com/YuGiMob/pi-hashline-edit-pro), [pi-better-edit](https://github.com/Rianico/pi-better-edit), [@oh-my-pi/hashline](https://www.npmjs.com/package/@oh-my-pi/hashline). Reading: [hash-anchors](https://dirac.run/posts/hash-anchors-myers-diff-single-token).

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Rianico/dsh-better-edit&type=Date)](https://star-history.com/#Rianico/dsh-better-edit&Date)

---

<p align="center">
  <strong>⭐ If hashline made your agent edit better, give it a star!</strong>
</p>
