# #34 Encoding Research — DSH `ctx.fs` Seam & Systematic Fix Space

**Date:** 2026-08-30  
**Upstream:** `deepseek-ai/deepseek-harness@master` (`cd5ef81`), `dsh-fs@0.1.0-rc.6` (developer preview — breaking changes allowed)  
**Local plugin:** `dsh-better-edit@0.5.0`, `src/fs-bridge.ts` (`ctxFsIO`/`localIO`), `src/file-view.ts`  

## 1. Executive Summary

`#34` is real but the issue's suggested fix ("catch `FS_NOT_TEXT` in `better-edit`, `readBytes` + `jschardet` + re-encode on write") is a **plugin-local shim** that duplicates a seam the DSH FS stack already owns. The FS seam is deliberately `Text-UTF-8-only` today — `readText`/`streamText`/`editText`/`writeText` all reject non-UTF-8 with `FS_NOT_TEXT`, and `readBytes` is the single raw escape hatch — with `Binary-safe mutations remain deferred` explicitly listed under Known Limitations (`packages/fs/fs/README.md#Known Limitations`). The seam splits as **Service Definition** (`@deepseek-ai/dsh-fs`), **Provider** (`@deepseek-ai/dsh-fs-local`, `fs-sandbox`, `fs-e2b`), **Consumer** (`@deepseek-ai/dsh-tool-fs`) and **Policy** (`@deepseek-ai/dsh-fs-observation-policy`) per `docs/subsystems/filesystem.md` and `capability-seams.md`. Since DSH is still `rc.x` and `release/dsh-0.1.2-alpha.1`, the most elegant fix is **upstream** — make the provider smarter or the error richer — not to pile a per-plugin charset stack onto `better-edit`. The ranked space below shows a Tier-0 message fix first, then a provider-normalizing read (BOM + optional `iconv-lite` fallback to UTF-8) that benefits every consumer, with plugin-local detection as fallback only if upstream stalls.

## 2. DSH FS Seam Map (primary sources)

| Role | Package | What it owns | Source |
|------|---------|--------------|--------|
| Service Definition | `@deepseek-ai/dsh-fs` | Abstract `FileSystem` class + 13 primitives + `FsError` taxonomy + `fs/*` events | `packages/fs/fs/src/index.ts`, `packages/fs/fs/src/types.ts` |
| Provider — local | `@deepseek-ai/dsh-fs-local` | `realpath` identity, `probe`/`probeNoFollow`, `readWholeText`/`streamWholeText`/`readWholeBytes`, atomic `writeFileAtomic`, per-key lock | `packages/fs/fs-local/src/index.ts`, `packages/fs/fs-local/src/fsio.ts` |
| Consumer — tools | `@deepseek-ai/dsh-tool-fs` | Model `read`/`write`/`edit` schemas (snake_case), `resolveRegularReadTarget` + windowing + `fs/observed` emit | `packages/fs/tool-fs/src/read.ts`, `read-target.ts`, `write.ts`, `edit.ts` |
| Policy | `@deepseek-ai/dsh-fs-observation-policy` | `WeakMap<owner, Map<targetKey, FsObservation>>`, `fs/write-intent` + `fs/edit-intent` waterfalls + `fs/observed` recorder | `packages/fs/fs-observation-policy/src/index.ts`, `docs/subsystems/filesystem.md#Observed-file state` |

** primitives (13):** `resolve`, `processPath`, `processPathFromHostPath`, `fileUrl`, `contains`, `stat`, `lstat`, `readText`, `streamText`, `readBytes`, `listDir`, `writeText`, `editText`. No delete/rename/copy/watch — deferred by design.

**Note on rapid iteration:** `dsh-fs` is `0.1.0-rc.6` via `better-edit/package.json`, harness docs state `_Developer preview — THERE WILL BE COMPATIBILITY-BREAKING CHANGES_`. Issues disabled, Discussions used. Contract changes are normal now — ideal window for a charset proposal vs. a permanent shim.

## 3. Provider Contract — what the types actually say

`packages/fs/fs/src/index.ts:0xX` / `lib/types/index.d.ts`:

```ts
abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
abstract readBytes(target: FsTarget, signal: AbortSignal|undefined, maxBytes: number): Promise<Uint8Array>
abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent, …): Promise<FsWriteOutcome>
abstract editText(target: FsTarget, edit: FsEditRequest, expected?: {version: FsVersion}, …): Promise<FsEditOutcome>
```

`FsInfo` carries only `{version, type: 'file'|'directory'|'other', size?}` — **no encoding field**. `FsErrorCode` includes `FS_NOT_TEXT` alongside 12 others (`FS_NOT_FOUND`, `FS_TOO_LARGE`, `FS_STALE_VERSION`, …). `FsWriteOutcome.before` is `string|null` — `null` when prior file was binary/non-UTF-8/at-boundary/too-large, else LF-normalized. This prefigures graceful degradation for non-UTF-8 priors.

`readBytes` contract is explicit: _bound lives at this seam so a backend can never buffer an unbounded file: … fails with `FS_TOO_LARGE` instead of returning a truncated result_. The bound is the ergonomic hook for any fallback — `ctxFsIO` already uses `stat.size` + `info.size + BOM_LEN` checks in `restoreStrippedUtf8Bom`.

## 4. How `FS_NOT_TEXT` is produced (fsio.ts is the truth)

`packages/fs/fs-local/src/fsio.ts`:

```ts
// helper
function decodeUtf8(buf: Uint8Array): string {
  try { return new TextDecoder('utf-8', {fatal:true}).decode(buf) }
  catch (e) { if (e instanceof TypeError) throw notTextError(verb, displayPath); throw e }
}
function notTextError(verb, displayPath) {
  return new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
}

// whole-file read
export async function readWholeText(target, signal): Promise<string> {
  await statRegularFile(target, 'read', signal)          // throws FS_NOT_FOUND / FS_NOT_REGULAR_FILE
  const raw = await readFileAbortable(target.targetKey, 'read', signal)
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0))  // BINARY_SAMPLE_BYTES=8192
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  return decodeUtf8(raw, 'read', displayPath)            // FS_NOT_TEXT on any non-UTF-8 byte
}

export async function* streamWholeText(target, signal) {
  // same: statRegularFile → per-chunk decodeUtf8Stream + sampled NUL check
}

export async function readForEdit(absolutePath, displayPath, signal) {
  if (buffer.includes(0)) throw FsError('binary file','FS_NOT_TEXT')
  const raw = decodeUtf8(buffer,'edit',displayPath)      // FS_NOT_TEXT on invalid UTF-8
  return {content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw)}
}
```

So `FS_NOT_TEXT` conflates **two cases** the issue lumps together but which want different UX:

| Case | Detection | Example bytes |
|------|-----------|---------------|
| Binary | NUL in first 8 KiB | `0x68 0x00 0x69` → `"h\0i"` |  
| Non-UTF-8 text | fatal `TextDecoder` throw | `GBK "你好"` → `0xC4 0xE3 0xBA 0xC3`; `CP1251 "Привет"` → `0xCF 0xF0 …`; `0xFF` lone byte |

Current consumer `tool-fs/src/read.ts` does **not** handle `FS_NOT_TEXT` specially — it just surfaces it. `tool-fs` streaming path chooses `streamText` when `size >= STREAM_MIN_SIZE (10 MiB)`, else `readText`; neither has an encoding param.

## 5. Why BetterEdit `#34` fails — and why `localIO` vs `ctxFsIO` diverge

`src/fs-bridge.ts:ctxFsIO.readText` (v0.5.0):

```ts
async readText(absolutePath, signal) {
  const target = await fs.resolve(absolutePath, {signal})
  const text = await fs.readText(target, signal)             // ← throws FS_NOT_TEXT
  return await restoreStrippedUtf8Bom(fs, target, text, signal)
}
catch (e) { return mapFsError(e, absolutePath) }             // → [E_NOT_TEXT] …
```

`src/fs-bridge.ts:localIO.readText`:

```ts
async readText(absolutePath, signal) {
  signal?.throwIfAborted();
  return readFile(absolutePath, "utf-8")                     // permissive: replaces invalid bytes
}
```

`src/file-view.ts:loadFileKindAndText` (used only when `readView` goes via `file-view`):

```ts
const decoder = new TextDecoder("utf-8", {fatal:false, ignoreBOM:true})
// hadUtf8DecodeErrors flagged via \uFFFD, surfaced as
// "[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]"
```

So:
- On DSH (the product path) a GBK file **never reaches** `file-view` — it dies at `fs.readText` before `readView` runs. The `hadUtf8DecodeErrors` path is dead code on `ctxFsIO`.
- On local/host (tests) the same file **succeeds** via `readFile("utf-8")` with replacement chars and a rewrite note — then edits normalize to UTF-8. Cross-backend inconsistency.
- BOM handling in `file-view.ts:detectTextBom` detects UTF-32LE/BE, UTF-16LE/BE but then **rejects** them as `binary: "UTF-16LE encoded text"` rather than decoding — a missed 30-line fix.
- `file-type` + `IMG_TYPES`/`TEXT_TYPES` + `SNIFF_BYTES` checks in `file-view` are bypassed on `ctxFsIO`.

## 6. Solution Space — from local shim to systematic seam shift

### T0 — Error-hint patch (no contract change, ship today)

**What:** In `mapFsError` (`fs-bridge.ts:88`) enrich `FS_NOT_TEXT` → `[E_NOT_TEXT] … not valid UTF-8: ${displayPath}. The file may be GBK/CP1251/Shift-JIS. Convert to UTF-8 (\`iconv -f GBK -t UTF-8\`) or retry after upstream encoding support. Binary files contain NUL bytes in the first 8 KiB.`
**Pros:** Zero deps, fixes "no hint" complaint, tool passes without new API.
**Cons:** Still can't read/edit the file.
**Effort:** ~5 lines.

### T1 — BOM-aware decode (no new deps, 30-50 lines, upstream or plugin)

Decode UTF-16LE/BE, UTF-32LE/BE via `TextDecoder` when BOM present. Reuse `detectTextBom` but instead of `kind:"binary"` return decoded text. Already proven by `restoreStrippedUtf8Bom`'s `readBytes` + `Buffer.from(text,"utf-8")` comparison. Fixes Windows Notepad UTF-16 default.

### T2 — Plugin-local fallback shim (issue as-written)

```
catch(FS_NOT_TEXT) → readBytes(maxBytes=info.size) →
  BOM? TextDecoder(utf-16*) :
  file-type? binary → E_NOT_TEXT :
  try iconv-lite / jschardet → decode → normalize → feed hashline
write: Map<targetKey, {encoding, version}> → encode on writeText
```

**Pros:** Ships without waiting on upstream; `readBytes` already exists; fixes GBK/CP1251/SJIS on `better-edit` alone.
**Cons:** 
- State persistence problem: `FileIO` is stateless, hashline works in UTF-8, write must re-encode. Requires `Map<absolutePath, encoding>` invalidated by `stat.version` — cross-session persistence needs `hash-store` or sidecar.
- Binary guard duplication: must replicate `file-type` + NUL + `MAX_BYTES` checks or risk misclassifying `image/png` as CP1251.
- `jschardet` false-positive rate on <1 KiB files, ~200-300 KiB bundle, extra dep for every user.
- Diverges from `tool-fs` `read` — user sees `dsh read` still fail while `better-edit read` succeeds.
- `localIO` parity must be added separately.

**When to use:** Only if upstream rejects the systematic options and `#34` is blocking users.

### T3 — Upstream error enrichment (systematic, contract-additive, elegant)

**Add to `FsError` / provider:** On `FS_NOT_TEXT`, attach `cause` with `{sampleBytes: Uint8Array(0..256), hasNul: boolean, suggestedEncodings?: string[]}` or extend `FsInfo` with `hint`. Tool and plugin can then render _guessed GBK (74%) — convert to UTF-8 to edit_ without guessing in each consumer.

**API sketch (non-breaking):**

```ts
// in FsError, carry diagnosis in cause.data
throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', {
  cause: { sampleHex: raw.subarray(0,128), hasNul, firstInvalidOffset }
})
```

Consumers keep current `code` routing; nicer message is free. DSH docs already show `cause` chaining in `HarnessError`.

### T4 — Provider-normalizing read (systematic, most ergonomic, recommended)

Make the **provider own decoding**, per seam philosophy "_Backends own … decoding, binary rejection_". The tool schema stays `read(file_path, offset?, limit?)` (no encoding param leak to model), but `readText`/`streamText` become **permissive readers** that normalize to UTF-8:

```
LocalFileSystem.readWholeText:
  raw = readFile(...)
  if NUL in sample → FS_NOT_TEXT (binary)
  try: TextDecoder('utf-8',{fatal:true}) → success → return text
  catch TypeError:
    if BOM → return TextDecoder(bomEncoding).decode(rawWithBOMStripped)
    else if raw.length < 10MiB and optional iconv-lite allowlist matches → decode(guessed) → return text + record hadDecodeErrors
    else throw FS_NOT_TEXT enriched with T3 hint
```

On write, `writeText` always writes **UTF-8** (normalization). Prior-file `before` is then `string` (not `null`) for legitimate legacy text, preserving diff/context cards — currently `FsWriteOutcome.before=null` for non-UTF-8 prior. Edit's `readForEdit` similarly normalizes after the NUL gate.

**Why this is elegant:** Model and plugin never think about encodings; legacy `GBK notes.txt` just works; every consumer benefits; `readBytes` remains the raw escape hatch; the 13-primitive count unchanged; no new method.

**Dependency:** Add `iconv-lite` (~40 KiB) to `dsh-fs-local` behind an opt-in allowlist (`gbk`, `shift_jis`, `windows-1251`, `euc-kr`) rather than full `jschardet` — exact bytes map deterministically, detector confidence not needed.

### T5 — Additive explicit-encoding overload (systematic, explicit-control escape hatch)

If round-trip preservation (GBK stays GBK on write) is required for some workspaces, add an **overload** rather than mutating the default:

```ts
// additive, backwards compatible
abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
abstract readText(target: FsTarget, signal: AbortSignal|undefined, opts: {encoding?: string}): Promise<{text:string, encoding:string}>

abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent, …): Promise<FsWriteOutcome>
abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent, …, opts?: {encoding?: string}): Promise<FsWriteOutcome>
```

Tool `read` keeps snake_case, no `encoding` field — plugin `better-edit` would use `ctx.fs.readText(target, signal, {encoding:'gbk'})` after catching `FS_NOT_TEXT` and peeking `readBytes`. This preserves bytes on write for GBK-only repos while keeping the happy path simple. Similar to `dsh-fs`'s prior additive changes (`processPathFromHostPath`, `lstat`).

## 7. Recommendation — what `better-edit` should do vs. propose upstream

**Ship T0+T1 locally now** (1 PR, no upstream wait, zero dep). This resolves 30% of `#34` (BOM + UTF-16) and the UX gap today.

**Propose T4+T3 upstream as the systematic fix** (one Discussion + draft PR to `dsh-fs-local/src/fsio.ts`). Frame it as _"binary-safe mutations remain deferred; text reads become permissive decoders that normalize to UTF-8 with `before` diff intact"_ — aligns with existing `before:null` → `before:string` improvement and with `FS_TOO_LARGE` bounding discipline. Mention `tool-fs` will automatically benefit with no tool-schema churn (stable `read`/`write`/`edit` contracts per `capability-seams` note).

**Keep T2 as fallback only** if upstream declines. If forced to T2, implement it via a shared `decodeBytes(bytes)` helper that both `ctxFsIO` and `localIO` call, with `file-type` guard before any charset guess, confidence threshold `>0.85`, and `Map<targetKey, {encoding, version}>` invalidated on `stat.version` mismatch (and persisted only in-memory — cross-restart normalization is acceptable as modeled by `better-edit`'s current `UTF8_REWRITE_NOTE` behavior).

**Do not ship a naked `jschardet` global fallback** — its short-file accuracy is too low for `edit` range integrity (a 3-byte mis-detect rotates every hash).

## 8. Ergonomic API sketch (if upstream accepts T4)

```ts
// dsh-fs/src/types.ts — new vocabulary (optional, not required for T4 alone)
export interface FsText {
  text: string        // always UTF-8, LF-normalized like today
  encoding: string    // 'utf-8' | 'utf-16le' | 'gbk' | …
  hadDecodeErrors: boolean
  hadBOM: boolean
}

// dsh-fs-local/src/fsio.ts — internal helper
function decodePermissive(raw: Uint8Array, displayPath: string): {text:string, encoding:string} {
  if (raw.subarray(0,8192).includes(0)) throw FsError('binary','FS_NOT_TEXT')
  try { return {text: new TextDecoder('utf-8',{fatal:true}).decode(raw), encoding:'utf-8'} }
  catch (e) {
    // BOM
    if (raw[0]===0xFF && raw[1]===0xFE && raw[2]===0x00 && raw[3]===0x00) return {text: new TextDecoder('utf-32le').decode(raw.subarray(4)), encoding:'utf-32le'}
    if (raw[0]===0xFF && raw[1]===0xFE) return {text: new TextDecoder('utf-16le').decode(raw.subarray(2)), encoding:'utf-16le'}
    // … utf-32be/utf-16be …
    // allowlist fallback
    for (const enc of ['gbk','shift_jis','windows-1251']) {
      try {
        const text = iconv.decode(raw, enc)
        if (!text.includes('\uFFFD')) return {text, encoding: enc}
      } catch {}
    }
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', {cause:{hasNul:false}})
  }
}
```

Tool and better-edit then just call `readText`; `writeText` always emits UTF-8; diff `before` becomes available for legacy files; observation versioning unchanged.

## 9. Implementation sketch for `better-edit` if upstream stalls (T2 fallback)

```ts
// src/encoding.ts — shared, pure
import iconv from 'iconv-lite'
import { fileTypeFromBuffer } from 'file-type'
export async function decodeBytes(bytes: Uint8Array, displayPath: string): Promise<{text:string, encoding:string}|null> {
  if (bytes.subarray(0, 8192).includes(0)) return null  // binary
  if (await fileTypeFromBuffer(bytes) && !TEXT_TYPES.has(...)) return null
  // BOM (reuse file-view detectTextBom)
  const bom = detectTextBom(bytes); if (bom) return {text: new TextDecoder(bomEnc(bom)).decode(stripBOM(bytes)), encoding:bom}
  // try utf-8 first
  try { return {text: new TextDecoder('utf-8',{fatal:true}).decode(bytes), encoding:'utf-8'} } catch {}
  // allowlist decode — no jschardet
  for (const enc of ['gbk','shift_jis','windows-1251','euc-kr']) {
    const text = iconv.decode(Buffer.from(bytes), enc)
    if (!text.includes('\uFFFD') && printableRatio(text) > 0.9) return {text, encoding:enc}
  }
  return null
}

// src/fs-bridge.ts — wire
const encodingMemo = new Map<string, {encoding:string, version:string}>()
async readText(path, signal) {
  try { const t=await fs.readText(target,signal); return restoreStrippedUtf8Bom(...) }
  catch(e) {
    if (!isFsNotText(e)) throw mapFsError(e, path)
    const stat = await fs.stat(target, signal); if (!stat) throw mapFsError(e, path)
    const bytes = await fs.readBytes(target, signal, stat.size ?? 10*1024*1024)
    const dec = await decodeBytes(bytes, path); if (!dec) throw mapFsError(e, path)
    encodingMemo.set(target.targetKey, {encoding: dec.encoding, version: stat.version})
    return dec.text
  }
}
async writeText(path, content, …) {
  const memo = encodingMemo.get(target.targetKey)
  const buf = memo ? iconv.encode(content, memo.encoding) : Buffer.from(content,'utf-8')
  // … but ctx.fs.writeText only takes string — so this path must write via
  // bytes seam or re-encode in DSH. For better-edit alone you'd store encoding
  // and warn that edit normalizes to UTF-8 unless upstream adds writeBytes.
}
```

Note: pure `better-edit` cannot round-trip GBK without a `writeBytes` escape hatch or an encoding-aware `writeText` — which is why T4/T5 upstream is the real fix.

## 10. Risks & Open Questions

- **False positives:** `GBK` bytes for `你好` (`C4E3 BAC3`) are also valid `CP1251` gibberish for `ДгКГ`. Without a confidence model, allowlist order matters. Prefer BOM → dictionary check (does result contain expected script range?) → printable ratio.
- **Binary misclassify:** Need `file-type` + NUL + `MAX_BYTES` before any decode; do not replace DSH's `BINARY_SAMPLE_BYTES` check with NUL-length-agnostic heuristics.
- **Diff basis breakage:** Today's `readTextForDiff` returns `null` for non-UTF-8 priors, collapsing to whole-file diff. Permissive decode turns `before:string`, which changes UI diff cardinality — test `diff.spec.ts` expectations.
- **Write normalization surprise:** Normalizing GBK → UTF-8 on first edit is a one-way migration. Must be announced in `UTF8_REWRITE_NOTE` equivalent and in release notes; for GBK-locked repos the overload (T5) is required.
- **Remote backend (`fs-e2b`):** Any `iconv-lite` Dep must be available in the e2b image or be client-side after `readBytes`; verify `readBytes` path works cross-backend.

## 11. References (exact sources)

- Contract: `packages/fs/fs/src/index.ts`, `packages/fs/fs/src/types.ts`, `packages/fs/fs/README.md#Known Limitations`
- Provider: `packages/fs/fs-local/src/fsio.ts:readWholeText, streamWholeText, readForEdit, readWholeBytes, readTextForDiff`, `packages/fs/fs-local/src/index.ts:LocalFileSystem`
- Consumer: `packages/fs/tool-fs/src/read.ts:READ_LIMIT=2000, STREAM_MIN_SIZE=10MiB, parseReadArgs, buildWindow`, `packages/fs/tool-fs/src/read-target.ts:resolveRegularReadTarget`, `packages/fs/tool-fs/src/error.ts:REMEDIES`
- Subsystem: `docs/subsystems/filesystem.md` (FsTarget/Version/WriteIntent/Policy events/Observed state/Error taxonomy)
- Seams: `.agents/notes/implemented/architecture/2026-06-13-capability-seams.md`, `.agents/notes/implemented/feature/2026-06-17-filesystem-tool-schemas.md`
- Better-edit: `src/fs-bridge.ts:ctxFsIO, mapFsError, restoreStrippedUtf8Bom`, `src/file-view.ts:detectTextBom, loadFileKindAndText, hadUtf8DecodeErrors`, `src/read-and-serve.ts:UTF8_REWRITE_NOTE`

## 12. Next Steps (checklist)

- [ ] PR `fix(fs-bridge): hint non-UTF-8 encodings in E_NOT_TEXT` (T0)
- [ ] PR `fix(fs): decode BOM text instead of rejecting as binary` (T1, touches `file-view.ts` + `ctxFsIO` fallback)
- [ ] Discussion to `deepseek-harness`: _Permissive text reads that normalize to UTF-8 (BOM + iconv allowlist), keep binary gate on NUL_ — offer draft `fsio.ts` patch (T4) + error-enrichment (T3)
- [ ] If upstream accepts: delete T2 fallback; if declines: implement T2 with shared `encoding.ts` + in-memory memo, documenting normalization
