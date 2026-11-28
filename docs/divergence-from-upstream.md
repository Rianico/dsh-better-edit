# Divergence from upstream — evidence ledger

Snapshot date: 2026-11-25. This file records where `dsh-better-edit` differs from
`pi-better-edit`, and why. It is evidence, not a plan. Update it at every upstream sync.

| Side       | Version | Commit                                     | Package entry                 |
| ---------- | ------- | ------------------------------------------ | ----------------------------- |
| Downstream | 1.3.0   | `1018480ff797c16ba464caaf079a656f11a56307` | Cordis host-plane plugin      |
| Upstream   | 2.21.1  | `ca29e6499de8479e990bcb6320829ecb581c26fc` | pi `ExtensionAPI` entry point |

Absorption cursor: `0b1934ccd39dbabcb97ea9957e84b08d730391e7` (upstream `v2.5.0`).
As of this snapshot, `0b1934c..ca29e64` is **162 commits** of unabsorbed backlog. Per-fix
ports outside the cursor are listed in `AGENTS.md` and `docs/absorption-plan.md`.

## How to reproduce every claim

Run from this repository root. The upstream checkout is expected at `../pi-better-edit`.

```bash
# Pins
git log -1 --format='%H %ad %s' --date=short
git -C ../pi-better-edit log -1 --format='%H %ad %s' --date=short
git -C ../pi-better-edit rev-list --count 0b1934c..HEAD

# Surface counts
find src -name '*.ts' | wc -l            # 61
find test -name '*.test.ts' | wc -l      # 208
find ../pi-better-edit/src -name '*.ts' | wc -l    # 117
find ../pi-better-edit/test -name '*.test.ts' | wc -l  # 295

# Anchor model
rg -n 'HASH_LEN|ANCHOR_GENERATION|CANON_VERSION' src/hashline/hash-assign.ts
rg -n 'HASH_LEN|ANCHOR_GENERATION|CANON_VERSION' ../pi-better-edit/src/hashline/alphabet.ts ../pi-better-edit/src/hashline/hash-identity.ts

# Tool wire shapes
rg -n 'READ_KS|ROOT_INPUT_KS|EDIT_KS' src/contract.ts
rg -n 'readToolSchema|readWindowSchema|text_ref|dry_run' ../pi-better-edit/src/read.ts ../pi-better-edit/src/payload-contract.ts

# Config surfaces
rg -n 'configYamlPath|DEFAULT_CONFIG_YAML|EOL_ENV_VAR|SPAN_MODE_ENV_VAR' src/store-config.ts src/span-mode.ts
rg -n 'settingsRoot|stateRoot|PROJECT_SETTINGS_REL|span_mode|selectionRange' ../pi-better-edit/src/config-dir.ts ../pi-better-edit/src/span-mode-config.ts

# Store schemas
rg -o 'CREATE TABLE IF NOT EXISTS [a-z_]+' src | sort -u
rg -o 'CREATE TABLE IF NOT EXISTS [a-z_]+' ../pi-better-edit/src | sort -u
```

## Classification legend

| Class           | Meaning                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `PLATFORM`      | Forced by the host: dsh tool registry, services, fs policy, bundle mount |
| `DESIGN`        | Deliberate downstream choice, recorded in a local ADR                    |
| `ADAPTED-PORT`  | Upstream behavior intended to match, with a downstream spelling change   |
| `UPSTREAM-ONLY` | Upstream capability with no carrier here (not a defect by itself)        |
| `DEBT`          | Unabsorbed upstream change; no decision recorded yet                     |

## 1. Identity and install surface

| Aspect           | Downstream (`dsh-better-edit`)                                                                                    | Upstream (`pi-better-edit`)                                                             | Class      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------- |
| Host contract    | Cordis plugin, `apply(rootCtx)`; `inject = ["tools","systemPrompt","fs"]`                                         | `ExtensionAPI` `default export`; `pi.on(...)` hooks                                     | `PLATFORM` |
| Install artifact | `lib/` from `tsc`; `main` and `exports` point at one built entry; `dsh.bundle.patch` points at `cordis.patch.yml` | esbuild `dist/index.js`; prebuilt bundle is the extension entry (`pi.extensions`)       | `PLATFORM` |
| Mount point      | Bundle patch inserts the plugin row; tools register per agent on `agent/created`                                  | Extension loads once per host process                                                   | `PLATFORM` |
| Scope of a tool  | Agent's own scope layer shadows the preset's built-in; unwinds on agent dispose                                   | Process-global tool replacement                                                         | `PLATFORM` |
| Tool names owned | `read`, `edit`, `undo_last_edit`, `str_replace_editor` (only if preset composed it)                               | `read`, `edit`, `undo_last_edit` plus bash/search interception                          | `PLATFORM` |
| Config roots     | One `$DSH_HOME/plugins/dsh-better-edit/` (config + runtime + guidance)                                            | Two roots: settings under the agent dir, state under `XDG_STATE_HOME` (`config-dir.ts`) | `PLATFORM` |
| Config format    | YAML `config.yaml` + `DSH_BETTER_EDIT_*` env                                                                      | JSON `settings.json` (global + project) + `PI_BETTER_EDIT_*` env                        | `PLATFORM` |
| Guidance         | Per-preset markdown override files with seed provenance                                                           | No guidance-override system; prompts are package files                                  | `DESIGN`   |

Evidence (downstream): `src/index.ts` (`apply`, `installAgentTools`, `inject`), `cordis.patch.yml`,
`test/arch/install-surface.test.ts`, `src/store-config.ts` (`configYamlPath`).
Evidence (upstream): `index.ts`, `src/config-dir.ts` (`settingsRoot`, `stateRoot`,
`PROJECT_SETTINGS_REL`), `package.json` (`pi.extensions`, `dist`).

## 2. Anchor and line-identity model

| Aspect              | Downstream                                                                                               | Upstream                                                                           | Class          |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------- |
| Anchor width        | **3 chars**, base62, `62³ = 238,328` usable spellings                                                    | **4 chars**, base62; all-digit spellings reserved, `62⁴ − 10⁴ = 14,766,336` usable | `DESIGN`       |
| Anchor seeding      | Content-only: `xxh32(line)`; no path seed                                                                | File-scoped: `fileBaseIndex(line, pathSeed)`; content-only fallback                | `DESIGN`       |
| Cross-file identity | Same line text can produce the same anchor in two files; `E_FOREIGN_ANCHOR` comes from the served record | Same text derives different anchors per file                                       | `DESIGN`       |
| Canon version       | `CANON_VERSION = 4`, trim-only over the frozen 28-code-point class                                       | `CANON_VERSION = 4`, same trim-only rule                                           | `ADAPTED-PORT` |
| Anchor generation   | `ANCHOR_GENERATION = 2`, raw-byte identity                                                               | `ANCHOR_GENERATION = 2`, raw-byte identity                                         | `ADAPTED-PORT` |
| Snapshot key        | `${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}`                                                      | Same key shape                                                                     | `ADAPTED-PORT` |
| Probe stride        | `62² + 62 + 1 = 3,907` over a bitset                                                                     | Same stride over a bitset that also reserves digit anchors                         | `DESIGN`       |
| Exhaustion handling | Retired-anchor promotion, then `E_LARGE_FILE` (`limitKind: "hash-space"`)                                | Same refusal family; capacity is the 4-char space                                  | `ADAPTED-PORT` |

Downstream ADRs: `docs/adr/0040-canon-v4-trim-only.md`,
`docs/adr/0041-anchor-identity-from-raw-bytes.md`, `docs/adr/0017-content-addressed-line-identity.md`.
Upstream references: `docs/adr/0002-tokenizer-stable-4-character-anchors-canon-v3.md`,
`docs/adr/0013-anchor-identity-derives-from-raw-bytes.md`.

Consequence to keep in mind: any port that hard-codes `4-character` anchors, digit-anchor
reservation, or a path seed must be re-derived for the 3-char content-only model. The
downstream `HASH_SPACE` cap is ~62x smaller, so line-count and promotion behavior differ.

## 3. Tool wire contracts

### 3.1 `read`

| Aspect       | Downstream                                                             | Upstream                                                                   | Class           |
| ------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------- |
| Target key   | `path` (only; unknown fields rejected)                                 | `file`                                                                     | `PLATFORM`      |
| Paging       | Top-level `offset` + `limit`; `windows: [{offset,limit}]`              | `windows: [{offset,limit} \| {around_anchor,radius}]`; no top-level paging | `DESIGN`        |
| Modes        | None                                                                   | `mode: "served" \| "verbatim" \| "outline"`                                | `UPSTREAM-ONLY` |
| Encoding     | `encoding` reopens bytes under a named codec                           | None                                                                       | `DESIGN`        |
| Window cap   | 16, enforced in `normWindows` (dsh value-schema has no `maxItems`)     | 16, enforced in schema + admission + preview                               | `ADAPTED-PORT`  |
| Window merge | Overlapping windows merge into the union; disjoint keep a section each | Windows are projected; no downstream-style merge contract                  | `DESIGN`        |
| Result shape | `{ text, warning? }`                                                   | Content blocks; codemode projection mirrors the built-in                   | `PLATFORM`      |
| Line cap     | `MAX_READ_LINE_BYTES = 200 KB` per line                                | Per-line placeholder at the host default (50 KB)                           | `DESIGN`        |

Evidence: `src/tool-read.ts`, `src/contract.ts` (`READ_KS`), `src/file-view.ts`
(`MAX_READ_WINDOWS`, `normWindows`), `docs/adr/0029-windowed-read-projection.md`.
Upstream: `src/read.ts` (`readToolSchema`, `OUTLINE_MODE_DESCRIPTION`).

### 3.2 `edit`

| Aspect       | Downstream                                                                                               | Upstream                                                             | Class           |
| ------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------- |
| Item payload | `replace_with` only                                                                                      | Exactly one of `text` or `text_ref`                                  | `DESIGN`        |
| Placement    | In-place only                                                                                            | `at: "in-place" \| "before" \| "after"`                              | `UPSTREAM-ONLY` |
| Span payload | None                                                                                                     | `text_ref: { anchor_from, anchor_to, file?, mode: "copy" \| "cut" }` | `UPSTREAM-ONLY` |
| Cut path     | No cut transaction, no `cut_intent` table                                                                | Correlated multi-file cut transaction with recovery                  | `UPSTREAM-ONLY` |
| Legacy folds | Tuples `[from,to,replace_with]`; `remove_from`/`remove_to`/`replacement_text`; `file`/`path`/`file_path` | Flat wire items, retired shapes tolerated for history only           | `ADAPTED-PORT`  |
| Dry run      | `dry_run: boolean`; validates anchors/leases, computes diff, writes nothing                              | `dry_run: boolean`                                                   | `ADAPTED-PORT`  |
| Encoding     | `allow_encoding_migration: "refuse" \| "utf8" \| "utf8bom"`                                              | No encoding-migration payload                                        | `DESIGN`        |
| Sandbox      | `sandbox_permissions` + `justification` added when the backend is confining                              | No equivalent (pi host sandbox is outside the extension)             | `PLATFORM`      |
| Mode         | `general` vs `literal` served-echo policy                                                                | Same two values                                                      | `ADAPTED-PORT`  |

Evidence: `src/tool-edit.ts`, `src/contract.ts` (`ROOT_INPUT_KS`, `editRequestFrom`,
`dryRunSchema`), `docs/adr/0049-dry-run-previews-an-edit-without-writing.md`.
Upstream: `src/payload-contract.ts` (`text_ref`, `at`, `dry_run`, `EDIT_DESCRIPTION`).

### 3.3 `undo_last_edit`

Both sides take `{ path }` and refuse a file changed after the edit with `E_UNDO_STALE`.
Downstream adds two behaviors:

- The undo is one transaction: if the write fails, the undo row is restored
  (`docs/adr/0034-undo-transaction-restores-unwritten-rows.md`).
- Undo restores at the edit's effective EOL and names a lost pre-edit mixture
  (`docs/adr/0047`); an abandoned legacy codec is named too
  (`docs/adr/0051-undo-names-the-abandoned-codec.md`).
- Upstream has a correlated cut undo (`E_UNDO_REVERT_FAILED`), which has no carrier here.

## 4. Config and settings vocabulary

| Setting        | Downstream                                                                             | Upstream                                           |
| -------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Store location | `storeDir: central \| workspace \| /abs`                                               | `store` settings + two-root relocation             |
| Span policy    | top-level `spanMode: hint \| strict`                                                   | `edit.span_mode`                                   |
| EOL            | top-level `eol: AUTO \| LF \| CRLF \| CR`                                              | top-level `eol`                                    |
| Encoding       | `autoGuessEncoding`, `normalizeToUtf8`, `allowEncodingMigration`, `supportedEncodings` | None                                               |
| Undo retention | `undo_ttl_s`                                                                           | `undo_ttl_s`                                       |
| Janitor        | `storeMaxAgeS`, `storeMaxTotalBytes`                                                   | `janitor`, `janitorIntervalMs`, `janitorBatchSize` |
| Read expansion | None                                                                                   | `read.selectionRange`                              |
| Env prefix     | `DSH_BETTER_EDIT_`                                                                     | `PI_BETTER_EDIT_`                                  |

Evidence: `src/store-config.ts` (`StoreConfigSchema`, `DEFAULT_CONFIG_YAML`),
`src/span-mode.ts` (`SPAN_MODE_ENV_VAR`), `src/eol-config.ts` (`EOL_ENV_VAR`).
Upstream: `src/span-mode-config.ts`, `src/store-kernel/settings.ts`, `src/eol-config.ts`.

Config ladder differences are behavioral, not cosmetic:

- Downstream resolves `env > config.yaml > file > system` for EOL; there is no project
  settings file and no `.editorconfig`.
- Upstream resolves global and project `settings.json` per key and reports the winning
  rung.
- Downstream seeds a `config.yaml` with comments on first boot; upstream relocates and
  adopts retired settings files.

## 5. Persistence and state

| Aspect            | Downstream                                                                                                                                  | Upstream                                                                                                                        | Class          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Schema version    | `HASH_STORE_VERSION = 8`                                                                                                                    | `HASH_STORE_VERSION = 12`                                                                                                       | `DESIGN`       |
| Tables            | `meta`, `snapshots` (legacy), `served`, `undo` (legacy), `file_undo`, `file_snapshots`, `line_lineage`, `line_id_counters`, `served_leases` | `meta`, `file_snapshots`, `line_lineage`, `line_id_counters`, `served_leases`, `served_session_meta`, `file_undo`, `cut_intent` | `DESIGN`       |
| Tenancy           | `central` default (`runtime/<name>-<hash8>/`), `workspace` legacy, or absolute custom root; `.wsPath` sidecar detects hash collision        | Two-root layout; state under `XDG_STATE_HOME`; retirement/adoption of old roots                                                 | `PLATFORM`     |
| Vacuum            | LRU snapshot vacuum + central janitor (`storeMaxAgeS`, `storeMaxTotalBytes`)                                                                | Janitor lifecycle hooks + compaction settings                                                                                   | `ADAPTED-PORT` |
| Retired anchors   | Per `(session, path)` retired-anchor column; single writer (`docs/adr/0036`)                                                                | Blocked-hash vocabulary; no `retired` spelling                                                                                  | `DESIGN`       |
| Session isolation | Served rows keyed by session; sub-agent serves never validate main edits                                                                    | `served_leases` keyed `(session_id, file_path, anchor)`                                                                         | `ADAPTED-PORT` |
| Migration         | Forward-only, schema-version gate, quarantines an unreadable store, legacy JSON import                                                      | Forward migration + epoch/canon fencing + store kernel                                                                          | `ADAPTED-PORT` |

Evidence: `src/constants.ts` (`HASH_STORE_VERSION`), `src/hash-store.ts`,
`src/snapshot-store/*`, `src/store-tenancy.ts`, `docs/adr/0016`, `0020`, `0021`.
Upstream: `src/store-kernel/constants.ts`, `src/hash-store.ts`, `src/snapshot-store/*`,
`src/config-dir.ts`.

Note: downstream keeps the legacy `snapshots` and `undo` tables beside the lineage family.
That is a migration seam, not a second live authority. Upstream has already retired them and
carries `cut_intent` + `served_session_meta` instead.

## 6. Capabilities only upstream has (no carrier here)

These are not automatically defects. Each needs a decision before a port.

| Capability                     | What it does                                                                                                            | Evidence (upstream)                                                   | State here                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------- |
| Read expansion / outline       | `read` gains `mode: "outline"`, `around_anchor`, structural providers (TS, Go, Rust, Python, Markdown, paragraph, Bash) | `src/read-expansion/*`, `docs/adr/0016`, `0017`, `0008`               | Absent                              |
| Selection-range note           | Read header names enclosing blocks instead of widening the read                                                         | `docs/adr/0012`, `0014`; `src/served-session/serve-render.ts`         | Absent                              |
| Bash view interception         | `cat`/`head`/`tail`/`sed -n`/`grep`/`rg` stdout becomes served rows                                                     | `docs/adr/0006`, archive `0033`, `0039`, `0048`, `0049`; `src/bash-*` | Absent                              |
| Search hook                    | Search results can be anchored and served                                                                               | `src/search-hook.ts`                                                  | Absent                              |
| pi-lens integration            | IO bridge feeds pi-lens read-before-edit state; `/lens` command                                                         | `src/integrations/pi-lens/*`, archive `0038`                          | Absent                              |
| TUI preview                    | Debounced edit preview and TUI presenter                                                                                | `src/preview-controller.ts`, `src/tui-presenter.ts`                   | Absent                              |
| Invisible-codepoint disclosure | Edit diff annotates removed invisible code points (NBSP, bidi)                                                          | `docs/adr/0009`, `0011`; `src/file-content/invisible.ts`              | Absent                              |
| Cut / copy spans               | `text_ref` copy/cut, foreign-file cut, correlated transaction                                                           | `src/payload-contract.ts`, `src/cut-repair.ts`, archive `0028`        | Absent                              |
| 4-char anchors                 | Tokenizer-stable wider anchors, digit spellings reserved                                                                | `docs/adr/0002`; `src/hashline/alphabet.ts`                           | Diverged (`DESIGN`)                 |
| Two-root settings/state        | Settings in agent dir, state in XDG state home; retired-root adoption                                                   | `docs/adr/0050`; `src/config-dir.ts`                                  | Not applicable (dsh home owns both) |

## 7. Capabilities only downstream has

| Capability                   | Purpose                                                                                                | Evidence                                                            | Class          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------- |
| Per-agent shadow install     | Shadow preset built-ins on the agent layer; auto-unwind on dispose                                     | `src/index.ts` (`installAgentTools`), ADR-0015                      | `PLATFORM`     |
| Contested-name reclaim       | Win back a tool name claimed by a peer, without ratifying an intruder                                  | `src/reclaim.ts`, ADR-0032, `docs/specs/issue-123-*`                | `PLATFORM`     |
| Self-heal watcher            | Restore only the definitions this install actually registered                                          | `src/self-heal.ts`, ADR-0032                                        | `PLATFORM`     |
| Preset tool-policy gate      | Install mutating tools only when the composed preset resolves them                                     | `src/preset-toolset.ts`, ADR-0032                                   | `PLATFORM`     |
| Guidance override system     | Per-preset `tool:read`/`tool:edit`/`tool:undo_last_edit` sections; seed provenance and upgrade refresh | `src/guidance/*`, ADR-0001, ADR-0052                                | `DESIGN`       |
| `str_replace_editor` shadow  | Same contract as the built-in, routed through the encoding seam                                        | `src/tool-str-replace-editor.ts`, ADR-0015                          | `PLATFORM`     |
| dsh fs bridge                | All IO through `ctx.fs`; emits `fs/write-intent` and `fs/observed`                                     | `src/fs-bridge.ts`, ADR-0030                                        | `PLATFORM`     |
| Sandbox escalation parity    | `edit`/`undo`/`str_replace_editor` escalate exactly like built-in `write`                              | `src/sandbox.ts`                                                    | `PLATFORM`     |
| Encoding model               | BOM/UTF-8 admission, codec reopen, memo by file, migration consent, undo names codec                   | `src/file-encoding-state.ts`, `src/encoding.ts`, ADR-0012, ADR-0052 | `DESIGN`       |
| Store tenancy                | central/workspace/custom roots, `.wsPath` collision guard, janitor                                     | `src/store-tenancy.ts`, ADR-0026, `docs/specs/issue-24-*`           | `DESIGN`       |
| Multi-window merge           | Overlapping read windows merge into their union                                                        | `src/file-view.ts`, ADR-0029                                        | `DESIGN`       |
| EOL ladder + normalized undo | One effective EOL per write; mixed-EOL read notice; undo restores at that EOL                          | `src/eol-config.ts`, ADR-0047                                       | `DESIGN`       |
| Rejection serves             | Region-scoped refusals echo fresh rows as a fresh read                                                 | `src/mutation/rejection-serve.ts`, ADR-0022, ADR-0042, ADR-0043     | `ADAPTED-PORT` |
| Served-evidence seam         | One owner for what the session was shown; full-read authority                                          | `src/hashline/served-evidence.ts`, ADR-0037, ADR-0035               | `ADAPTED-PORT` |
| Dry-run preview              | Validate anchors/leases and compute the diff without writing                                           | `src/mutation/engine.ts`, ADR-0049                                  | `ADAPTED-PORT` |

## 8. Internal seam map

The two codebases do not share a module layout. Ports must land on downstream seams, never by
copying upstream directory shape.

| Concern              | Downstream owner                                               | Upstream owner                                             |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| Request admission    | `src/contract.ts`                                              | `src/payload-contract.ts`                                  |
| Anchor allocation    | `src/hashline/hash-assign.ts` (pure) + `hash.ts` (persistence) | `src/hashline/hash-identity.ts`                            |
| Served evidence      | `src/hashline/served-evidence.ts`, `src/session-view.ts`       | `src/served-session/*`                                     |
| Read projection      | `src/file-view.ts`, `src/read-and-serve.ts`                    | `src/file-content/*`, `src/read.ts`                        |
| Mutation lifecycle   | `src/mutation.ts` + `src/mutation/engine.ts`                   | `src/mutation-engine/pipeline.ts`                          |
| Store plumbing       | `src/hash-store.ts`, `src/snapshot-store/*`                    | `src/hash-store.ts`, `src/store-kernel/*`                  |
| Undo                 | `src/undo-edit.ts`, `src/tool-undo.ts`                         | `src/undo-store.ts`, `src/edit-undo.ts`                    |
| Diff rendering       | `src/edit-diff.ts`, `src/edit-response.ts`                     | `src/edit-diff.ts`, `src/edit-render.ts`                   |
| Capability extension | `src/guidance/*`, `src/preset-toolset.ts`, `src/self-heal.ts`  | `src/read-expansion/*`, `src/bash-*`, `src/search-hook.ts` |

Deep seams named in `AGENTS.md` — HashAssign, SessionView, FileView, Mutation, AnchorPipeline —
are downstream-only names. An upstream commit that edits `lease-resolve`, `apply`, or
`serve-render` maps to those seams; it does not map file-for-file.

## 9. Governance and verification divergence

| Gate                   | Downstream                                                                                                      | Upstream                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Unit/integration tests | `vitest run` (208 test files)                                                                                   | `vitest run` (295 test files)                                                                                |
| Coverage thresholds    | None in `test` script; `test:coverage` exists                                                                   | Lines/statements/functions 85, branches 80                                                                   |
| Dead-code gate         | None                                                                                                            | `knip --max-issues 0`                                                                                        |
| Build                  | `tsc -p tsconfig.json` → `lib/`                                                                                 | esbuild `dist/` + `verify-dist` + mutation check                                                             |
| Architecture tests     | `test/arch/*` pins install surface, error registry, warning audience, rejection region, blocked-hash vocabulary | `test/arch/*` pins ADR numbering, anchor width, payload seam, read-expansion boundary, config ladder         |
| CI extra               | Windows smoke job (ADR-0044), changelog gate at both PR and `main`                                              | Changelog gate, dist verification + mutation guards, import-ratio gate, install-surface check, install smoke |
| ADR numbering          | `docs/adr/0001..0052` (two `0052` files)                                                                        | `docs/adr/0001..0019` + archived `docs/.archive_adrs/0001..0050`                                             |
| Upstream-sync ledger   | `docs/absorption-plan.md`, `AGENTS.md` checkpoints                                                              | `docs/articles/absorption-plan.md`                                                                           |

Implication: a port cannot use "upstream tests pass" as proof. Downstream arch tests encode
different invariants (for example, `blocked-hash-vocabulary.test.ts` keeps the local
`retired` spelling after ADR-0028).

## 10. Divergence register (one line each)

Use this table as the port checklist. `D-*` ids are stable; add rows, do not renumber.

| ID   | Divergence                                                        | Class               | Decision / evidence                                   |
| ---- | ----------------------------------------------------------------- | ------------------- | ----------------------------------------------------- |
| D-01 | Cordis plugin vs pi `ExtensionAPI`                                | `PLATFORM`          | `src/index.ts`, `cordis.patch.yml`                    |
| D-02 | Agent-scope shadow vs process-global replacement                  | `PLATFORM`          | ADR-0015, ADR-0032                                    |
| D-03 | Contested-name reclaim + self-heal                                | `PLATFORM`          | `src/reclaim.ts`, `src/self-heal.ts`                  |
| D-04 | Preset tool-policy gate                                           | `PLATFORM`          | ADR-0032                                              |
| D-05 | Per-preset guidance override files                                | `DESIGN`            | ADR-0001, ADR-0052                                    |
| D-06 | `ctx.fs` bridge + `fs/*` event participation                      | `PLATFORM`          | `src/fs-bridge.ts`, ADR-0030                          |
| D-07 | Sandbox escalation parity                                         | `PLATFORM`          | `src/sandbox.ts`                                      |
| D-08 | `str_replace_editor` governed shadow                              | `PLATFORM`          | ADR-0015                                              |
| D-09 | 3-char content-only anchors vs 4-char file-scoped anchors         | `DESIGN`            | `src/hashline/hash-assign.ts`, upstream ADR-0002/0013 |
| D-10 | Canon v4 + generation 2 (shared rule)                             | `ADAPTED-PORT`      | ADR-0040, ADR-0041                                    |
| D-11 | Read payload: `path`/paging/`encoding` vs `file`/`windows`/`mode` | `PLATFORM`+`DESIGN` | `src/contract.ts`, `src/tool-read.ts`                 |
| D-12 | Edit payload: `replace_with` vs `text`/`text_ref`/`at`            | `DESIGN`            | `src/contract.ts`                                     |
| D-13 | No cut/copy span transaction                                      | `UPSTREAM-ONLY`     | Upstream `cut-repair.ts`; no `cut_intent` here        |
| D-14 | Encoding admission + migration consent + codec-aware undo         | `DESIGN`            | ADR-0012, ADR-0052                                    |
| D-15 | YAML + `DSH_BETTER_EDIT_*` vs JSON + `PI_BETTER_EDIT_*`           | `PLATFORM`          | `src/store-config.ts`, upstream `src/config-dir.ts`   |
| D-16 | Store tenancy: central/workspace/custom + `.wsPath`               | `DESIGN`            | `src/store-tenancy.ts`                                |
| D-17 | Store schema: v8, legacy tables retained; no `cut_intent`         | `DESIGN`            | `src/constants.ts`, `src/hash-store.ts`               |
| D-18 | Read expansion / outline / `around_anchor`                        | `UPSTREAM-ONLY`     | Upstream `src/read-expansion/*`                       |
| D-19 | Bash view interception + search hook                              | `UPSTREAM-ONLY`     | Upstream `src/bash-*`, `src/search-hook.ts`           |
| D-20 | pi-lens IO bridge                                                 | `UPSTREAM-ONLY`     | Upstream `src/integrations/pi-lens/*`                 |
| D-21 | TUI preview / presenter                                           | `UPSTREAM-ONLY`     | Upstream `src/preview-controller.ts`                  |
| D-22 | Invisible-codepoint disclosure                                    | `UPSTREAM-ONLY`     | Upstream ADR-0009/0011                                |
| D-23 | Selection-range note                                              | `UPSTREAM-ONLY`     | Upstream ADR-0012/0014                                |
| D-24 | Multi-window merge contract                                       | `DESIGN`            | ADR-0029                                              |
| D-25 | EOL ladder + normalized undo                                      | `DESIGN`            | ADR-0047                                              |
| D-26 | Rejection rows are a fresh read                                   | `ADAPTED-PORT`      | ADR-0022/0042/0043                                    |
| D-27 | Prebuilt `dist` bundle vs `tsc lib/` + bundle patch               | `PLATFORM`          | `test/arch/install-surface.test.ts`                   |
| D-28 | Coverage/knip/dist gates absent here                              | `DESIGN`            | `package.json`, upstream `package.json`               |
| D-29 | Upstream backlog beyond the cursor                                | `DEBT`              | `AGENTS.md`, `docs/absorption-plan.md`                |

## 11. Port decision checklist

Before absorbing an upstream commit:

1. **Classify the host seam.** If it touches extension registration, TUI, bash, search, or
   pi-lens, decide whether dsh has a carrier at all. No carrier means `UPSTREAM-ONLY`, not
   "port later by default".
2. **Re-derive anchor math.** Any 4-char, digit-reservation, path-seed, or 14.7M-space
   assumption must be recomputed for 3-char content-only anchors.
3. **Check the payload lineage.** Downstream accepts `replace_with` plus legacy folds and
   has no `text_ref`/`at`. An upstream payload change may be a contract break here, not a
   rename.
4. **Map the config rung.** `settings.json` project/global ladders map to `config.yaml` or
   env; a new upstream key needs a local spelling and a default.
5. **Map the store schema.** A new table or column must respect the downstream version gate
   and the legacy-table migration seam.
6. **Land the decision.** Behavior with no ADR is incomplete (`AGENTS.md` step 7). Amend an
   existing ADR when the decision extends one.
7. **Update this ledger.** Move the row's class, update the pins and the backlog count, and
   record the per-commit verdict in `docs/absorption-plan.md`.

## 12. Non-goals

- This file does not restate `docs/absorption-plan.md` per-commit verdicts.
- It does not claim upstream is ahead in every row. Downstream has capabilities upstream
  cannot have (agent-scope reclaim, presets, guidance, fs policy) and one capability
  upstream chose not to take (3-char anchors).
- It does not treat a missing upstream feature as a defect. `UPSTREAM-ONLY` is a state, not a
  verdict.
