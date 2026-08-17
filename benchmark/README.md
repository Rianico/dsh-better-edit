# Benchmark — hashline vs str_replace vs @oh-my-pi/hashline

`run.mjs` compares the **model-side token cost** of three edit patterns applied to the **same file
with the same 12 replacements**:

| | hashline (this plugin) | str_replace (traditional) | @oh-my-pi/hashline (patch) |
| --- | --- | --- | --- |
| request | `{ path, remove_from, remove_to, replacement_text }` | `{ path, old_string, new_string }` | `[PATH#TAG]` + `PUT N.=M:` + `+TEXT` rows |
| old text echoed? | **never** — 2×3-char anchors | **verbatim** (`old_string`) | **never** — the range deletes, body is final content |
| lines addressed by | content hash | text match | **number** + full-file content-hash tag |

An edit that replaces `L` lines sends `O(L)` fewer tokens than `str_replace` for every arm that
skips `old_string`. That saving is the whole point of the [hashline edit
pattern](../../#why-hashline): the model output that would transcribe the old code (and
often transcribe it *wrong* — the "harness problem") is replaced by a stable content address — or,
for `@oh-my-pi/hashline`, by a line number bound to a full-file content hash.

`@oh-my-pi/hashline` is measured in **both** of the format's modes:

- **seq** — one `[PATH#TAG]` section per edit (tool-loop style). Line numbers are the *current*
  ones: the format's own rules say every edit renumbers and changes the tag.
- **batch** — one patch document with all 12 hunks fixed to the **original** line numbers ("numbers
  are original, never shifted by hunks"), the `[PATH#TAG]` header counted once. This is the
  format's favourable case.

## Reproduce

```sh
npm install        # installs js-tiktoken (pinned), the tokenizer
npm run benchmark  # node benchmark/run.mjs
```

Deterministic by construction — the same corpus, the same 12-edit script, the same pinned tokenizer
always produce the same numbers (verified: two runs produce byte-identical output). The script also
**self-checks**:

- every edit pins a unique `match` substring in the corpus and throws if the corpus is reformatted
  so a match goes missing or becomes ambiguous — the benchmark cannot silently drift from the
  fixture it claims to measure;
- the generated oh-my-pi payloads are validated against the package's **published grammar**
  ([`src/prompt.md`](https://github.com/can1357/oh-my-pi/blob/main/packages/hashline/src/prompt.md))
  before counting — a malformed `[PATH#TAG]` header, hunk, or body row aborts the run.

The oh-my-pi arm does **not** import the package: it is Bun-only (`engines.bun >=1.3.14`, ships raw
`.ts` source), so it cannot run under this Node.js benchmark — and only its model-side emission text
is being measured here anyway. Payloads are constructed from the published grammar; the tag is a
fixed 4-hex placeholder (`a1b2`), because any 4-hex value tokenizes identically.

## Methodology

- **Corpus** — `corpus/shopping-cart.ts`, a fixed 103-line TypeScript module (types, a service
  class with guards/rounding/totals, an error class, a formatter). Realistic indentation and line
  lengths.
- **Edit script** — 12 edits: 8 single-line, 4 multi-line (3, 6, 10, and 15 lines). The replacement
  text is **identical** for every arm — only the request encoding differs.
- **Tokenizer** — `js-tiktoken` `cl100k_base` (pinned devDependency), the standard OpenAI BPE
  vocabulary. Falls back to the `chars/4` heuristic if js-tiktoken is missing; `chars/4`
  *under*-counts code tokens, so the fallback flatters the replacement-style arms, never hashline.
- **What's counted** — the edit request as the model would emit it: JSON tool calls
  (`JSON.stringify`, so newlines are `\n`-escaped) for hashline and str_replace; raw patch text
  (literal newlines) for oh-my-pi, per its documented usage. Read traffic is identical for every
  arm and is excluded (it cancels). The counted tokens are the model's **output** tokens, billed at
  ~5-6× the input rate.
- **Correctness proxy** — for each str_replace edit, how many times does `old_string` occur in the
  file? `0` = the patch fails (no match, needs a re-read), `>1` = ambiguous (the patch lands on the
  first occurrence, which may be the wrong one). hashline's equivalent failure mode is a hard
  rejection with fresh anchors — a retry needs no re-read.

## Results (cl100k_base, js-tiktoken)

| scenario | lines | hashline | str_replace | oh-my-pi seq | oh-my-pi batch |
| --- | ---: | ---: | ---: | ---: | ---: |
| single · constant | 1 | 37 | 37 | 27 | — |
| single · comment | 1 | 39 | 39 | 29 | — |
| single · assignment | 1 | 36 | 38 | 28 | — |
| single · signature | 1 | 40 | 43 | 32 | — |
| single · guard | 1 | 43 | 46 | 35 | — |
| single · expression | 1 | 40 | 45 | 32 | — |
| single · getter | 1 | 33 | 32 | 25 | — |
| single · export fn | 1 | 41 | 44 | 33 | — |
| multi · 3-line if-block | 3 | 60 | 84 | 50 | — |
| multi · 6-line helper body | 6 | 73 | 128 | 63 | — |
| multi · 10-line loop block | 10 | 79 | 149 | 70 | — |
| multi · 15-line method body | 15 | 181 | 330 | 166 | — |
| **single-line ×8** | | **309** | **324** | **241** | — |
| **multi-line ×4** | | **393** | **691** | **349** | — |
| **TOTAL ×12** | | **702** | **1015** | **590** | **480** |

Saved vs `str_replace`: hashline **313 (31%)** · oh-my-pi per-edit **425 (42%)** · oh-my-pi batch
**535 (53%)**.

- **hashline vs str_replace** — 5% on single lines (the two 3-char anchors plus key-name overhead
  roughly cancel a one-line `old_string`), 29–47% on multi-line ranges. Savings scale with the size
  of the replaced text.
- **oh-my-pi vs str_replace** — 26% on single lines (no JSON envelope), 40–53% on multi-line
  ranges. The payload is *lighter* than this plugin's tool call: a patch language skips JSON keys,
  braces, and escaping. That is a real property of the format, and this README does not hide it.
- **oh-my-pi batch vs per-edit** — 590 → 480 tokens: 12 headers collapse into 1. The format's
  natural one-document mode.

At the ~5× output-token rate, effective cost vs `str_replace`: hashline **~1.4× less**,
oh-my-pi per-edit **~1.7× less**, oh-my-pi batch **~2.1× less**.

## Why this plugin still exists (honest reading)

The token headline over `str_replace` belongs to the *pattern*, not to any one implementation —
`@oh-my-pi/hashline`'s payload is lighter still. The differences that matter are not in this table:

- **What the model must track between edits.** hashline anchors are content addresses: edit one part
  of a file and the hashes of the rest stay put, and the diff serves fresh anchors — chained edits
  need no re-read and no bookkeeping. A line-numbered format requires the model to renumber and
  re-fetch the file tag after **every** edit (its own prompt: "RE-GROUND AFTER EVERY EDIT").
- **What can land silently on the wrong line.** hashline verifies **every resolved line** against
  the served state — a stale, never-served, or ambiguous range is hard-rejected before anything is
  written. oh-my-pi's tag is a full-file content hash: it detects version drift (then refuses or
  3-way-merges), but a wrong line number against the current tag still applies at the wrong place.
- **The runtime and the job.** oh-my-pi is a standalone patcher library (Bun, pluggable
  filesystem, block ops, `REM`/`MV`, registers). This plugin is a dsh tool pair (Node): `read`
  returns the anchors, `edit`/`batch_edit`/`undo_last_edit` consume them, all inside DeepSeek
  Harness.
- **The model skill floor.** `edit` has the same call shape as `str_replace` — any model that can
  call an edit tool can call it. A patch language must be *learned*: `PUT N.=M:` vs `PUT N*:`,
  registers, block-openers, the anti-patterns.

## What this does *not* measure

- **Transcription failure and retries.** The baseline assumes the model reproduces `old_string`
  perfectly. In practice that is the dominant failure mode — the original
  [harness-problem blog](https://stencil.so/blog/the-harness-problem) reported 46–51% patch failure
  rates for several models with replace-style edits, and a 61% output-token reduction after
  switching to anchored edits. Every such failure costs a re-read plus a retry; hashline's
  reject-and-serve rejects *before* writing and hands the model fresh anchors.
- **Renumber/tag-chase cost.** The 590/480 oh-my-pi numbers assume the model gets the *right*
  line numbers and tag every round, for free. Getting them wrong costs a re-read or a merge.
- **Block ops.** `PUT N*:` resolves a whole syntactic block in one hunk; this benchmark's edits
  are all exact ranges, which is the least favourable case for block ops.
- **Batch planning.** The 480-token batch document assumes the model can plan all 12 edits up front
  against the original file. In a read-edit-re-read agent loop, per-edit mode (590) is the honest
  number.

Run with a different corpus or edit script to see how the numbers scale — the script is a plain
~505-line `.mjs` with no build step.
