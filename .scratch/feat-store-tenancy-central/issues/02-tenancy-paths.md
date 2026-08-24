# 02 — Tenancy path resolution (central file-per-workspace)

**What to build:** `resolveStoreDir` + `hash8` + migration probe — `central` → `runtime/<sanitizedBasename>-<hash8>/`, `/abs` → `join(abs,hash8)`, `workspace` → legacy, with legacy copy-once on first central open. `ls runtime/` readable.

**Blocked by:** 01 — config seam

**Status:** ready-for-agent

- [ ] `canonicalWs = resolveTarget(ws)` before hash/basename; `hash8 = sha1(canonicalWs)[:8]`; `sanitizedBasename = basename(canonicalWs).replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,32)||"root"`; `centralDir = join(resolveDshHome(),"plugins/dsh-better-edit/runtime", name-hash8)` + sidecar `.wsPath` with `canonicalWs`
- [ ] `storePathFor(cwd)` still the call seam — no caller break; pure `resolveStoreDir` testable
- [ ] migration probe: if `!exists(centralPath) && exists(legacyWsPath)` then `cp -r` once (recursive), log migrated, never delete legacy
- [ ] collision proof: stored `.wsPath` mismatch → extend hash (or warn) — not silent overwrite
