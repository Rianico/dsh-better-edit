# Benchmark — hashline vs str_replace token cost

`run.mjs` compares the **model-side token cost** of two edit tool patterns on
the same file with the same replacements:

| | hashline (this plugin) | str_replace (traditional) |
| --- | --- | --- |
| request | `{ path, remove_from, remove_to, replacement_text }` | `{ path, old_string, new_string }` |
| replaced text | **never echoed** — 2×3-char anchors only | must be reproduced **verbatim** (`old_string`) |

An edit that replaces `L` lines sends `O(L)` fewer tokens with hashline,
because `old_string` is omitted. That saving is the whole point of the
[hashline edit pattern](../../#inspiration-and-lineage): the model output
that would transcribe the old code (and often transcribe it *wrong* — the
"harness problem") is replaced by two stable content addresses.

## Reproduce

```sh
npm install        # installs js-tiktoken (pinned), the tokenizer
npm run benchmark  # node benchmark/run.mjs
```

Deterministic by construction — the same corpus, the same 12-edit script, the
same pinned tokenizer always produce the same numbers. The script also
**self-checks**: every edit pins a unique `match` substring in the corpus and
throws if the corpus is reformatted so a match goes missing or becomes
ambiguous, so the benchmark cannot silently drift from the fixture it claims
to measure.

## Methodology

- **Corpus** — `corpus/shopping-cart.ts`, a fixed 103-line TypeScript module
  (types, a service class with guards/rounding/totals, an error class, a
  formatter). Realistic indentation and line lengths.
- **Edit script** — 12 edits: 8 single-line, 4 multi-line (3, 6, 10, and 15
  lines). The replacement text is **identical** for both tools — only the
  request encoding differs.
- **Tokenizer** — `js-tiktoken` `cl100k_base` (pinned devDependency), the
  standard OpenAI BPE vocabulary. Falls back to the `chars/4` heuristic if
  js-tiktoken is missing; `chars/4` *under*-counts code tokens, so the
  fallback flatters str_replace, never hashline.
- **What's counted** — the JSON of the edit request as the model would emit
  it. Read traffic is identical for both tools and is excluded (it cancels).
  The counted tokens are the model's **output** tokens, billed at ~5-6× the
  input rate.
- **Correctness proxy** — for each str_replace edit, how many times does
  `old_string` occur in the file? `0` = the patch fails (no match, needs a
  re-read), `>1` = ambiguous (the patch lands on the first occurrence, which
  may be the wrong one). hashline's equivalent failure mode is a hard
  rejection with fresh anchors — a retry needs no re-read.

## Results (cl100k_base, js-tiktoken)

| scenario | lines | hashline | str_replace | saved | % |
| --- | --- | --- | --- | --- | --- |
| single-line ×8 | 1 | 309 | 324 | 15 | 5% |
| multi-line ×4 | 3–15 | 393 | 691 | 298 | **43%** |
| **TOTAL ×12** | | **702** | **1015** | **313** | **31%** |

At the ~5× output-token rate, hashline costs **~1.4× less** on effective
cost. Savings scale with the size of the replaced text: near parity for short
single lines (the two 3-char anchors plus key-name overhead roughly cancel a
one-line `old_string`), 29–47% for multi-line ranges.

## What this does *not* measure

- **Transcription failure and retries.** The baseline assumes the model
  reproduces `old_string` perfectly. In practice that is the dominant
  failure mode — the original [harness-problem blog](https://stencil.so/blog/the-harness-problem)
  reported 46–51% patch failure rates for several models with replace-style
  edits, and a 61% output-token reduction after switching to anchored edits.
  Every such failure costs a re-read plus a retry; hashline's reject-and-serve
  rejects *before* writing and hands the model fresh anchors, so a retry
  needs no re-read.
- **Drift.** If the file changed on disk after the model's last view, a
  stale `old_string` can still match — and land on the wrong occurrence.
  hashline refuses a stale range (`E_RANGE_STALE`) because it verifies every
  resolved line against the served state.

Run with a different corpus or edit script to see how the numbers scale —
the script is a plain ~320-line `.mjs` with no build step.
