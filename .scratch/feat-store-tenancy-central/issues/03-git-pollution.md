# 03 — Git pollution warning + autoGitignore opt-in

**What to build:** `workspace` only pollution UX — warn once per ws if `.gitignore` lacks entry, idempotent auto-append when `autoGitignore:true` (yaml+env).

**Blocked by:** 02 — tenancy paths

**Status:** ready-for-agent

- [ ] `openStore` when `storeDir==workspace` && `exists(join(ws,".git"))` && `!gitignoreHasEntry(ws)` → `logger.warn` once per ws via `Set<ws>` — no mutation by default
- [ ] when `autoGitignore==true` (yaml or env `true|false`) → idempotent `grep -q "^\.dsh_better_edit/" || echo ".dsh_better_edit/" >> .gitignore` via `fs/write-intent` guard, never for `central`/custom
- [ ] env `DSH_BETTER_EDIT_AUTO_GITIGNORE` `true|false` case-insensitive mirrors yaml, other strings warn + fallback false
