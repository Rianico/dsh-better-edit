# 01 — Config seam (yaml + env, central default, fallback)

**What to build:** `storeDir` tenancy as default config — `$DSH_HOME/plugins/dsh-better-edit/config.yaml` + god envs, validated, fallback to `central` + warn. Precedence `env > yaml > default(central)` demoable via `storePathFor(ws)` returning central/workspace/abs without crashing on malformed input.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] yaml at `$DSH_HOME/plugins/dsh-better-edit/config.yaml` Zod `storeDir:"workspace"|"central"|"/abs"`, `autoGitignore: bool=false`, `undo_ttl_s: int -1=forever default 604800`, `storeMaxAgeDays=30`, `storeMaxTotalBytes=500MB` (mtime-cache reload, once at admission)
- [ ] env `DSH_BETTER_EDIT_STORE_DIR` (workspace|central|/abs) overrides yaml, `DSH_BETTER_EDIT_AUTO_GITIGNORE` `true|false` case-insensitive overrides yaml `autoGitignore` — other strings warn + fallback
- [ ] malformed `storeDir: ""|"   "|./relative|~/` not absolute after `expand` → fallback `central` + `logger.warn`, never throw at `configDir()`
- [ ] default `central` when no yaml/env — existing behavior preserved for explicit `workspace` opt-in
