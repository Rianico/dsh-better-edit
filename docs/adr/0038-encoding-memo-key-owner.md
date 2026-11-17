# ADR-0038 — One memo identity per file: the slash-normalized absolute path

Status: Accepted (ticket arch-T6, lane `arch-impl-candidates`).
Related: [ADR-0012](0012-vscode-encoding-model.md) — the encoding model `encodingMemo` mirrors and
its `FsVersion` invalidation (`invalidateIfStale`); [ADR-0035](0035-full-read-authority.md) — the
sibling "one owner per verdict" collapse.
Downstream records: `src/file-encoding-state.ts` (`keyOf`), `src/fs-bridge.ts` (`readText` ×3,
`writeText`), `src/read-and-serve.ts`, `src/tool-str-replace-editor.ts` (the footer lookups).

## Context

`file-encoding-state.ts` keyed `encodingMemo` and `autoGuessFooterMemo` by whatever string the caller
handed it, and `fs-bridge.ts` offered two spellings of the same file: `targetKeyOf(target,
absolutePath)` returned `target.targetKey ?? absolutePath`. Every read/write site therefore wrote both
keys (`_setEncodingState(key, …)` plus `if (key !== absolutePath) _setEncodingState(absolutePath, …)`),
cleared both, and read with a fallback (`_getEncodingState(key) ?? _getEncodingState(absolutePath)`).
The dual keying then leaked upward: two consumers carried three-spelling probe ladders
(`getAutoGuessFooter(absolutePath) ?? getAutoGuessFooter(rawPath) ?? getAutoGuessFooter(absolutePath.replace(/\\/g, "/"))`)
because they could not know which spelling the memo had landed under. Each of those pairs was a
hand-maintained sync — and `FileIO.resolve` already returns `fs.processPath(target)`, the backend's
processed absolute path, so the extra spelling was redundant by construction.

## Decision

1. **The memo identity of a file is its absolute path, slash-normalized** — `keyOf` applies
   `String(path).replace(/\\/g, "/")`. `src/file-encoding-state.ts` is the one construction site;
   it is private to that module, so no caller can invent a key.
2. **Every memo access funnels through it** — `get`/`set`/`clear` for both memos, `invalidateIfStale`,
   and the two recording helpers (`recordOpenState`, `recordFooter`). Signatures and the maps are
   unchanged; `clear` with no argument still clears the whole memo.
3. **`targetKeyOf` is deleted.** The backend's `targetKey` is the backend's view of the target
   (symlink/case canonicalization inside `ctx.fs`), not the memo's identity — canonicalizing it in
   the memo would duplicate what `resolve` already returned.
4. **Callers pass whatever path they hold**: `fs-bridge` uses `absolutePath`, and each site now has
   one write, one clear and one read. A caller that passes a Windows-separated spelling of the same
   absolute path gets the same entry, by construction rather than by probing.

## Consequences

- One memo entry per file; the three-spelling ladders in `read-and-serve.ts` and
  `tool-str-replace-editor.ts` collapse to a single lookup (`autoGuessWarning` loses its `rawPath`
  parameter; `read-and-serve`'s `rawPath` binding stays, being the resolve argument).
- Pins (`rg`): `targetKeyOf` → none in `src/`; `replace(/\\/g, "/")` → `file-encoding-state.ts`
  `keyOf` only; `getAutoGuessFooter(` → one lookup per consumer site; `_getEncodingState(key)`,
  `_setEncodingState(key`, `if (key !== absolutePath)`, `if (targetKey !== absolutePath)` → none.
- Three cells looked up the memo by the backend's spelling (`getEncodingState("tk:…")`,
  `getEncodingState("tk-1")` in `coverage-agent-b`/`coverage-agent-e` fs-bridge and
  `fs-bridge.policy`); they pinned the removed spelling and are retargeted to the absolute path,
  names, fixtures and other assertions untouched.
- Residual: the memos stay process-global — per-workspace scoping is unchanged and out of scope.
