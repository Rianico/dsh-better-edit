# Research: Encoding Detection Libraries for DSH better-edit autoGuessEncoding

## Summary
`jschardet` npm `latest` (3.1.4, 2024-09-30) is effectively unmaintained on the stable channel; the much more accurate `4.0.0-rc.2` (0BSD, 99.4% accuracy) has sat on the `rc` tag since 2024-08-23 without promotion. For the DSH better-edit optional `DSH_BETTER_EDIT_AUTO_GUESS_ENCODING` path the best drop-in is **`chardet` (runk/node-chardet) 2.2.0** — MIT, 22 KB packed, zero deps, ESM+CJS, TS types, actively maintained — used as `analyse()`→ top-1 with confidence threshold and iconv-lite decode verification. Keep jschardet as disabled fallback; reject native ICU addons for a CLI that must install without build tools. Detected encoding must still be validated via `iconv-lite` round-trip before committing, preserving the existing BOM→strict UTF-8→detector ordering.

## Findings

### 1. jschardet (aadsm/jschardet) — unmaintained on `latest`, revival stalled on `rc`
- **npm channel split.** Registry reports `dist-tags: { "latest": "3.1.4", "rc": "4.0.0-rc.2" }` [registry.npmjs.org/jschardet](https://registry.npmjs.org/jschardet). `3.1.4` tarball `unpackedSize: 1322610` published `1727731150467` = **2024-09-30** [registry.npmjs.org/jschardet/latest](https://registry.npmjs.org/jschardet/latest); `4.0.0-rc.2` last published **2024-08-23** per socket/aikido summaries of the releases page [socket.dev](https://socket.dev/npm/package/jschardet) [intel.aikido.dev](https://intel.aikido.dev/packages/npm/jschardet) [github.com/aadsm/jschardet/releases](https://github.com/aadsm/jschardet/releases).
- **Maintenance.** `latest` branch is the 43.0%-accuracy python-chardet port, last meaningful code change 2020-2021 era (LGPL-2.1+). Issue tracker accumulates stale CJK false-detections (GBK vs Shift_JIS on short files — exactly the DSH pain). `main` contains the Ground-up TypeScript port of **chardet 7** as jschardet 4, cited as 99.4% on 3,125 files, 568 files/s, 89.9 MiB peak vs 43.0% /125 files/s/829 MiB for 3.1.4 [github.com/aadsm/jschardet](https://github.com/aadsm/jschardet) — but not promoted to `latest`, so `npm install jschardet` still gets the legacy code.
- **Bundle/size.** v3 `334 / 119 KiB min/gzip`; v4 `1,070 / 679 KiB min/gzip`, +110 ms cold-start (model decompress once) [github.com/aadsm/jschardet](https://github.com/aadsm/jschardet). Either is heavy for a file-edit CLI versus 22 KB for chardet. Zero runtime deps, but requires `browserify`+`google-closure-compiler` to build.
- **API & types.** `detect(buf) → {encoding, confidence 0-1, language, mimeType}` + `detectAll(opts: {minimumThreshold=0.20, detectEncodings, excludeEncodings})` [github.com/aadsm/jschardet](https://github.com/aadsm/jschardet). `types: "index.d.ts"` present in 3.1.4 but hand-written, CJS-only (`main: "src/init"`), no ESM exports; v4 adds ESM+CJS [github.com/aadsm/jschardet](https://github.com/aadsm/jschardet). Licence shift: v3 **LGPL-2.1+** [registry.npmjs.org/jschardet/latest](https://registry.npmjs.org/jschardet/latest) → v4 **0BSD** [github.com/aadsm/jschardet](https://github.com/aadsm/jschardet).
- **Accuracy / short files.** v3 notoriously misclassifies short CJK (GBK vs Shift_JIS trade-off flagged in task); v4 fixes via chardet 7 model with per-encoding pipelines + confusion tables, but still overshoots on <50-byte slices unless allowlisted. Node support is pure JS.
- **Relevance to DSH allowlist.** v4 supports full DSH allowlist (`gbk→gb18030`, `big5→big5hkscs`, `shift_jis→cp932/shift_jis_2004`, `euc-kr`, `windows-1251`, `iso-8859-1` etc) via chardet upstream list [chardet.readthedocs.io](https://chardet.readthedocs.io/en/stable/supported-encodings.html) mirrored in README [github.com/aadsm/jschardet](https://github.com/aadsm/jschardet). v3 subset lacks `gb18030` fidelity.

### 2. chardet (runk/node-chardet) — recommended
- **Maintenance — actively maintained.** `latest: 2.2.0` [registry.npmjs.org/chardet/latest](https://registry.npmjs.org/chardet/latest) with `license: MIT`, `main: lib/index.js`, `typings: lib/index.d.ts`, `engine: >=4`, published mid-2025 (npm tmp `1781920836934`) and web_search corroborates "last 2 months" [npmjs.com/package/chardet](https://www.npmjs.com/package/chardet). GitHub `runk/node-chardet` shows recent `vitest`+`tsx`+`semantic-release` modernisation, `prepublish: npm run build (tsc)` [github.com/runk/node-chardet](https://github.com/runk/node-chardet). Provenance attestation present (`SLSA`) [registry.npmjs.org/chardet/latest](https://registry.npmjs.org/chardet/latest).
- **Size.** README: **Packed size only 22 KB** [github.com/runk/node-chardet](https://github.com/runk/node-chardet) vs registry `unpackedSize: 178969` [registry.npmjs.org/chardet/latest](https://registry.npmjs.org/chardet/latest) (vs jschardet 1.32 MB). Zero deps (`dependencies: {}`), pure TS, `browser` field remapping `lib/fs/node.js→browser.js` [registry.npmjs.org/chardet/latest](https://registry.npmjs.org/chardet/latest).
- **Module & types.** Dual support via `tsc` build to `lib/`, `typings` included, used as `import chardet from 'chardet'` (ESM default) or `require('chardet')`. Tested with `vitest run --coverage` [registry.npmjs.org/chardet/latest](https://registry.npmjs.org/chardet/latest).
- **Encodings & short-file handling.** Supported set explicitly lists DSH-relevant `Big5, EUC-JP, EUC-KR, GB18030, Shift_JIS, ISO-8859-1, windows-1251, windows-1250/1252…` but **not** standalone `gbk` alias — returns `GB18030` (superset, iconv-lite decodes gbk bytes identically). Same for `big5hkscs→Big5`, `cp932→Shift_JIS`. [github.com/runk/node-chardet](https://github.com/runk/node-chardet) TODO notes missing `KOI8-U`, `CP949` (vs euc-kr), `ISO-8859-10/13/14/15`. Short-file strategy: pure frequency analysis; README advises `sampleSize` option to trade accuracy vs speed and `analyse()` returns full ranked list [github.com/runk/node-chardet](https://github.com/runk/node-chardet). Expect low confidence (<30) on <200 bytes CJK; caller must gate.
- **API.** `chardet.detect(Buffer|Uint8Array) → string|null` (top-1 name) and `chardet.analyse(buf) → [{name, confidence 0-100, lang?}]` sorted desc [github.com/runk/node-chardet](https://github.com/runk/node-chardet). Also `detectFile`/`detectFileSync` with `{sampleSize, offset}`.
- **iconv-lite compat.** Returns WhatWG-ish names that need alias map (`GB18030→gb18030→gbk`, `Shift_JIS→shift_jis`, etc) before `iconv.decode`. Confidence is 0-100 (vs jschardet 0-1); map `confidence/100` for unified threshold.
- **License/security.** MIT, no native code, no install scripts, no secrets — lowest supply-chain risk.

### 3. detect-character-encoding (sonicdoe) — ICU binding, reject for CLI
- **Native addon.** `description: Detect character encoding using ICU`, `gypfile: true`, `install: node-gyp rebuild`, deps `bindings, nan`, `engines >=18` for 0.9.0 [registry.npmjs.org/detect-character-encoding](https://registry.npmjs.org/detect-character-encoding). `dist unpackedSize: 21,671,317` (≈21 MB) plus vendored ICU [registry.npmjs.org/detect-character-encoding](https://registry.npmjs.org/detect-character-encoding) / README [github.com/sonicdoe/detect-character-encoding](https://github.com/sonicdoe/detect-character-encoding).
- **Maintenance.** `latest 0.9.0` modified **2024-01-06** [registry.npmjs.org/detect-character-encoding](https://registry.npmjs.org/detect-character-encoding). Supports macOS Sonoma + Ubuntu 22.04/20.04 + Debian 12/11/10, **no 32-bit** [github.com/sonicdoe/detect-character-encoding](https://github.com/sonicdoe/detect-character-encoding). Requires C++ toolchain per README [github.com/sonicdoe/detect-character-encoding](https://github.com/sonicdoe/detect-character-encoding); fails in sandboxed/air-gapped installs.
- **Accuracy.** Delegates to ICU `CharsetDetector`. Coverage matches allowlist: `GB18030, Big5, EUC-JP/KR, Shift_JIS, ISO-8859-* / windows-125*` [github.com/sonicdoe/detect-character-encoding](https://github.com/sonicdoe/detect-character-encoding). Confidence 10-100. Authors tip `ced` as lighter alternative [github.com/sonicdoe/detect-character-encoding](https://github.com/sonicdoe/detect-character-encoding).
- **Integration.** Returns `{encoding, confidence}` or `null`; single guess only, no top-3.

### 4. encoding-japanese (polygonplanet/encoding.js) — Japanese-only
- **Scope.** Detects only `ASCII, BINARY, EUC-JP (EUCJP), JIS (ISO-2022-JP), SJIS (Shift_JIS), UTF8/16/32, UNICODE` — no `GBK/GB18030, Big5, EUC-KR, windows-1251, iso-8859-1` beyond ASCII/UTF [github.com/polygonplanet/encoding.js](https://github.com/polygonplanet/encoding.js).
- **Maintenance.** `latest 2.3.0` `unpackedSize: 866236` [registry.npmjs.org/encoding-japanese](https://registry.npmjs.org/encoding-japanese) with `time modified 2026-08-29T16:37:02.214Z`. MIT, `engines >=18` for 2.3.0. Zero runtime deps [registry.npmjs.org/encoding-japanese](https://registry.npmjs.org/encoding-japanese). ESM via `src/index.js`, TS types via `@types/encoding-japanese`.
- **Verdict.** Useful only as secondary tie-breaker for Japanese; not a replacement.

### 5. Other candidates dropped
- `@herber/chardet, charset-detector, node-icu-charset-detector, autodetect-charset, chardet2, @vscode/vscode-languagedetection`: either abandoned, native bindings, or language-detection (not charset). `node-icu-charset-detector` (mooz) is pre-fork of `detect-character-encoding` with older publish. `iconv-lite` does **no detection** [github.com/pillarjs/iconv-lite](https://github.com/pillarjs/iconv-lite).
- VS Code historically bundled `jschardet` for `autoGuessEncoding` (`BOM → strict UTF-8 → jschardet detectAll`) [github.com/Microsoft/vscode/issues/23322](https://github.com/Microsoft/vscode/issues/23322) [github.com/Microsoft/vscode/pull/21416](https://github.com/Microsoft/vscode/pull/21416) — same ordering DSH already implements.

## Recommendation table

| Criterion | **chardet 2.2.0 (runk)** | **jschardet 4 rc** | **jschardet 3.1.4** | **detect-character-encoding 0.9.0** | **encoding-japanese 2.3.0** |
|---|---|---|---|---|---|
| Maintenance | ✅ Active (2025, provenance) | ⚠️ Not on `latest` since 2024-08 | ❌ No publish since 2024-09 | ⚠️ 2024-01, native burden | ✅ Maintained |
| Size packed/unpacked | ✅ **22 KB / 179 KB** | ❌ 1,070/679 KB min/gz +110 ms | ⚠️ 334/119 KB +1.3 MB | ❌ 21 MB + ICU | ✅ 866 KB |
| Deps / install | ✅ 0, pure JS | ✅ 0 | ✅ 0 | ❌ `node-gyp rebuild` | ✅ 0 |
| TS / ESM+CJS | ✅ `lib/index.d.ts` | ✅ TS, ESM+CJS | ⚠️ CJS only | ⚠️ CJS | ⚠️ needs @types |
| Allowlist coverage | ✅ via GB18030/Big5 alias | ✅ Full | ⚠️ Partial | ✅ Full | ❌ JP-only |
| Short-file accuracy | ⚠️ <30 on <200B | ✅ Best | ❌ Brittle | ✅ Good | ✅ JP-tuned |
| Confidence / top-3 | `analyse()` 0-100 | `detectAll()` 0-1 `0.20` | same | single 0-100 | single |
| License | MIT | 0BSD (rc)/LGPL (latest) | LGPL-2.1+ | BSD-2-Clause | MIT |

## Final recommendation for DSH better-edit

**Adopt `chardet` (runk/node-chardet) 2.2.0 as the optional `autoGuess` top-1 detector.**

**Fallback / integration strategy:**

```ts
let chardet: typeof import('chardet') | null = null;
async function getChardet() {
  if (process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING !== 'true') return null;
  if (!chardet) try { chardet = await import('chardet'); } catch { return null; }
  return chardet;
}
// inside autoGuessEncoding:
const mod = await getChardet();
if (mod) {
  const ranked = mod.analyse(buffer).filter(c => allowlist.has(normalise(c.name)));
  const top = ranked[0];
  if (top && top.confidence >= 45) {
    const enc = aliasMap[normalise(top.name)] ?? normalise(top.name);
    if (iconv.encodingExists(enc)) {
      const decoded = iconv.decode(buffer.slice(0, 1024), enc);
      if (!decoded.includes('�') || replacementRatio(decoded) < 0.02) return enc;
    }
  }
}
// fallback to existing 50-char heuristic
```

- Use `analyse()` for ranked list, filter by `ALLOWLIST`, alias `GB18030→gbk` before `iconv.decode`.
- Threshold 45 (0-100) balances short-file noise vs missed CJK; log when `DSH_BETTER_EDIT_DEBUG=1`.
- Add as `optionalDependencies` + dynamic `import()` so default bundle delta = 0.
- Document `jschardet@rc` as “VS Code parity” opt-in, not default; revisit when `latest` promotes to 4.x (99.4% accuracy [github.com/aadsm/jschardet](https://github.com/aadsm/jschardet)).

## Sources

- Kept: `aadsm/jschardet` README + releases — v4 accuracy/size/encodings and dist-tag split [github.com/aadsm/jschardet](https://github.com/aadsm/jschardet) [github.com/aadsm/jschardet/releases](https://github.com/aadsm/jschardet/releases) [socket.dev](https://socket.dev/npm/package/jschardet) [intel.aikido.dev](https://intel.aikido.dev/packages/npm/jschardet)
- Kept: `registry.npmjs.org/jschardet` + `/jschardet/latest` — `dist-tags`, `3.1.4` 2024-09-30, LGPL-2.1+, `unpackedSize 1322610` [registry.npmjs.org/jschardet](https://registry.npmjs.org/jschardet) [registry.npmjs.org/jschardet/latest](https://registry.npmjs.org/jschardet/latest)
- Kept: `runk/node-chardet` README + `registry.npmjs.org/chardet/latest` — 22 KB, MIT, encodings, `analyse()`/`detect()`, `unpackedSize 178969` [github.com/runk/node-chardet](https://github.com/runk/node-chardet) [registry.npmjs.org/chardet/latest](https://registry.npmjs.org/chardet/latest)
- Kept: `sonicdoe/detect-character-encoding` README + registry — ICU, 21.6 MB, `node-gyp rebuild`, `0.9.0 2024-01-06` [github.com/sonicdoe/detect-character-encoding](https://github.com/sonicdoe/detect-character-encoding) [registry.npmjs.org/detect-character-encoding](https://registry.npmjs.org/detect-character-encoding)
- Kept: `polygonplanet/encoding.js` README + registry — JP-only table, 2.3.0 MIT `866236` [github.com/polygonplanet/encoding.js](https://github.com/polygonplanet/encoding.js) [registry.npmjs.org/encoding-japanese](https://registry.npmjs.org/encoding-japanese)
- Kept: `pillarjs/iconv-lite` — no detection [github.com/pillarjs/iconv-lite](https://github.com/pillarjs/iconv-lite)
- Kept: VS Code history [github.com/Microsoft/vscode/issues/23322](https://github.com/Microsoft/vscode/issues/23322) [github.com/Microsoft/vscode/pull/21416](https://github.com/Microsoft/vscode/pull/21416) + chardet encodings [chardet.readthedocs.io](https://chardet.readthedocs.io/en/stable/supported-encodings.html)
- Dropped: jsDelivr/socket CDN, npm-stat trends, SearXNG SEO mirrors, Kagi AI synth without primary cites.

## Gaps

- No benchmark on DSH's 50-char-slice + short-file CJK corpus; threshold 45 heuristic from chardet docs + VS Code `0.20` [github.com/aadsm/jschardet](https://github.com/aadsm/jschardet). Next: run `chardet.analyse()` vs `jschardet@rc detectAll()` on fixtures.
- Bundlephobia gzip for `chardet 2.2.0` vs `jschardet 3/4` inferred from registry + README; re-run `npm pack --dry-run` + `esbuild --bundle --minify` to firm numbers.
- ICU confidence calibration on <1 KB and 21 MB Docker cost not measured [github.com/sonicdoe/detect-character-encoding](https://github.com/sonicdoe/detect-character-encoding).
- License re-check: jschardet `rc` 0BSD [github.com/aadsm/jschardet](https://github.com/aadsm/jschardet) vs `3.1.4` LGPL [registry.npmjs.org/jschardet/latest](https://registry.npmjs.org/jschardet/latest).
- Suggested next: spike branch behind flag, wire `allowlist`-filtered `analyse()` + iconv verification.

---
*Intended output path (write blocked outside workspace — runtime should persist this artifact): `/Users/zhengxk/.pi/agent/sessions/--Users-zhengxk-development-ai-dsh-better-edit--/subagent-artifacts/outputs/4ce38fc4-6c0f-45ab-a474-b2b663884c4d/research.md` — also canonical `docs/specs/encoding-libs-research.md` per task.*