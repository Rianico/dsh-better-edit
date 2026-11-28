# dsh-unique design dossier

Snapshot date: 2026-11-25. This file records the designs `dsh-better-edit` owns because its
host is DeepSeek Harness, not pi. Each entry states the problem, the design, the invariant that
must survive future work, and the evidence. Companion file: `docs/divergence-from-upstream.md`.

Scope rule: an entry is "unique" when upstream `pi-better-edit` has no equivalent seam. Adapted
ports are marked as such and live in the divergence ledger, not here.

## 1. Ownership and installation

### U-01 Per-agent shadow install

**Problem.** dsh resolves tools `agent → preset → global`, and the built-ins live on the preset.
A plugin that registers globally cannot shadow a preset tool for one agent, and a plugin that
edits the preset would fight the user's configuration.

**Design.** `apply(rootCtx)` listens on `agent/created`. For each agent it registers the hashline
tools on the agent's own scope layer. The nearest layer wins, so `read`/`edit` shadow the preset's
built-ins only for that agent. Registrations are wrapped in `agent.ctx.effect`, so disposing the
agent unwinds them automatically.

**Invariants.**

- Registration happens inside `agent/created`, before any eager peer can claim the name.
- `read` is installed synchronously and unconditionally; the mutating tools may land a microtask
  later because `agentPresets.acquireScope` is async in dsh 0.2.x.
- A factory fault for one tool must not cost the remaining tools or the guidance sections.
  Each step is isolated and logged.
- The install holds its own tool definitions. It must never read `layer.get("read")` to verify
  identity; that would ratify an intruder.

**Evidence.** `src/index.ts` (`installAgentTools`), `cordis.patch.yml`, ADR-0032.
**Upstream has no equivalent.** A pi extension loads once per process and replaces tools globally.

### U-02 Contested-name reclaim

**Problem.** A peer plugin can register `read` or `edit` on the same agent layer before or after
this plugin. dsh's registry does not arbitrate ownership for same-scope registrations.

**Design.** `registerWithReclaim` claims the name, inspects the resolved entry, and reclaims it
when the entry is not the definition this install built. It returns a disposer either way.

**Invariants.**

- Reclaim compares against the closure's own definition, never against whatever currently sits
  under the name.
- Reclaim is idempotent under a lost teardown race: a disposer that runs after disposal still
  releases its registration.
- A tool the preset gate declined is absent from the heal set; a `tools/change` event can never
  resurrect it.

**Evidence.** `src/reclaim.ts`, `src/self-heal.ts`, `test/core/tool-install-isolation.test.ts`,
`test/core/self-heal.test.ts`, `docs/specs/issue-123-tool-install-isolation-and-reclaim.md`
(related: ADR-0015, ADR-0032).

### U-03 Self-heal watcher

**Problem.** A router or stage-advance plugin can delete a tool between calls. The model then
silently falls back to the built-in, losing anchors and served state.

**Design.** The watcher listens for `tools/change` and restores exactly the definitions this
install registered. The heal set is built from the same variables the install used.

**Invariants.** Heal set equals installed set. A definition that was never registered is never
healed. The watcher is disposed with the agent.

**Evidence.** `src/self-heal.ts`, ADR-0032.

### U-04 Preset tool-policy gate

**Problem.** dsh scope restrictions filter inherited tools, not a scope's own registrations.
Registering `edit` for an agent whose preset never composed `edit` would grant a capability the
preset deliberately withheld.

**Design.** `resolveToolset` reads the composed preset's layer through the optional
`agentPresets` service. `read` stays unconditional. `edit`, `undo_last_edit`,
`str_replace_editor`, and the write hook follow the preset. A host without the service keeps the
compiled unconditional behavior.

**Invariants.**

- `undo` follows `edit`.
- `str_replace_editor` is shadowed only when the preset composed that tool.
- Every failure path (no service, no preset, no scope-read API, thrown error) degrades to the
  pre-gate behavior; it never removes `read`.

**Evidence.** `src/preset-toolset.ts`, ADR-0032, issue #110.

## 2. Guidance

### U-05 Per-preset guidance override files

**Problem.** The model-facing contract for `read`/`edit`/`undo_last_edit` is large. Different
presets need different emphases, and a deployment must be able to tune text without forking the
plugin.

**Design.** Three markdown files per preset at
`$DSH_HOME/plugins/dsh-better-edit/<preset>/<section>.md`. Each file carries optional
front-matter (`order`) and a fenced body. Resolution runs at `agent/created`: the agent's
composed preset id selects the directory, the harness's `systemPrompt.getSectionOrder` supplies
the default slot, and malformed files fall back to the compiled default with one warning per
agent.

**Invariants.**

- The compiled default is byte-identical to the pre-guidance install.
- A malformed override never fails the install.
- Section order follows the harness's own tool slot when the registry exposes one; plugin-owned
  sections keep their compiled order.
- A preset that composed no mutating tool gets no mutating-tool guidance section
  (`sectionsForToolset`).

**Evidence.** `src/guidance.ts`, `src/guidance/parse.ts`, `src/guidance/resolve.ts`,
`src/guidance/materialize.ts`, ADR-0001.

### U-06 Seed provenance and upgrade lifecycle

**Problem.** A first boot must create editable files, but a release must not overwrite user
edits. A naive "write if absent" leaves stale defaults forever; a naive "always write" destroys
customization.

**Design.** The materializer writes a ledger of the seed bodies it shipped. Each file is
classified against that ledger: `current`, `refresh`, `preserve`, `deliberate-blank`, or
`malformed`. Only `refresh` rewrites. A deliberate blank fence disables a section silently.
`seed-history.ts` carries the hash of every body ever shipped, so an old default left in a user
file is still recognized as `refresh` rather than mistaken for intent.

**Invariants.**

- Writes are atomic; a failed refresh leaves the prior file intact.
- `preserve` is byte-identical, not "semantically equivalent".
- A custom preset's modified files are reported, never rewritten.
- Deleting or emptying a file re-seeds it at next boot.

**Evidence.** `src/guidance/seed.ts`, `src/guidance/seed-history.ts`,
`src/guidance/materialize.ts`, `test/fixtures/guidance-seeds/*`, ADR-0052.

## 3. Filesystem and policy

### U-07 `ctx.fs` bridge with policy-event participation

**Problem.** dsh deploys sandboxed or remote filesystems. A tool that calls `node:fs` directly
bypasses the deployment's backend and leaves the built-in observation policy stale.

**Design.** Every read and write goes through `ctxFsIO(ctx.fs, rootCtx)`. The bridge resolves
targets, reads text, writes atomically, and emits the same `fs/write-intent` and `fs/observed`
events as the built-in tools. A local implementation exists only for tests.

**Invariants.**

- No production path reaches around the bridge.
- Every successful read or mutation emits `fs/observed` with the resulting version.
- Writes dispatch `fs/write-intent` before writing, so the create/replace guard and
  stale-version checks see the same intent as a built-in `write`.
- An fs policy failure surfaces as the host's own `FS_NOT_OBSERVED` / `FS_STALE_VERSION`, not
  as a hashline error.

**Evidence.** `src/fs-bridge.ts`, ADR-0030.
**Failure mode if removed:** the next built-in `write` on the same file fails with
`FS_NOT_OBSERVED` or `FS_STALE_VERSION`.

### U-08 Sandbox escalation parity

**Problem.** Under a confining backend, the built-in `write` can request escalation. A shadowed
`edit` that cannot escalate is less capable than the tool it replaces, and it may be denied
inside the session workspace because the policy lacks the session root.

**Design.** `FsSandboxController` mirrors the built-in controller's vocabulary and approval
sequence. `edit`, `undo_last_edit`, and `str_replace_editor` resolve a per-call policy and stamp
it with the calling session's workspace root, plus any approved one-shot escalation.

**Invariants.**

- The escalation fields are advertised only when the backend is confining.
- A preview (`dry_run`) resolves no write policy; a preview must not ask for a permission it
  cannot use.
- A denial maps to the host's denial marker, not to a hashline code.

**Evidence.** `src/sandbox.ts`, `src/tool-edit.ts` (`dryRun` branch), ADR-0049.

### U-09 Write hook: guard then auto-read

**Problem.** The built-in `write` stays in place. It can write text that starts with a served
`HASH│` row, and after it writes, the model holds no fresh anchors.

**Design.** A scoped `tools/pre-execute` listener rejects a copied served row before dispatch.
A `tools/post-execute` listener re-reads a successful write through the same `read-and-serve`
path and appends fresh anchored rows. Both listeners attach by event, so they have no tool-name
collision surface and need no reclaim.

**Invariants.**

- The guard fires only on an exact same-line served row; it does not reject ordinary prose.
- The auto-read owns its fs observation (ADR-0030).
- A failed post-read never fails the write; it degrades with a named notice.

**Evidence.** `src/write-hook.ts`, `src/read-and-serve.ts`, ADR-0030.

## 4. Encoding

### U-10 Read-codec / write-UTF-8 model with per-call migration consent

**Problem.** Code on disk is not always UTF-8. Silent transcoding corrupts bytes. Refusing every
legacy file makes the tool unusable in real repositories.

**Design.** Reads admit bytes through a deterministic ladder: BOM → strict UTF-8 → optional
guessing (`autoGuessEncoding`) → top-3 candidate preview. A read records `{encoding, hasBOM}` in
a version-invalidated memo keyed by the slash-normalized absolute path. Writes are text-only and
always encode UTF-8. A legacy file that cannot round-trip refuses with `E_ENCODING_UNWRITABLE`.
Conversion needs explicit consent: per call `allow_encoding_migration: "utf8" | "utf8bom"`, or
the standing `allowEncodingMigration` config, with the legacy `normalizeToUtf8` honored as
`"utf8"`. Undo restores the text, names the abandoned codec, and never reverses the migration.

**Invariants.**

- Reads are codec-agnostic; writes are UTF-8 only.
- The memo key is one identity: the slash-normalized absolute path.
- A consent never names "the codec to write"; it names whether this write may abandon the
  recorded codec and which UTF-8 shape the bytes get.
- An ASCII-only legacy file edits silently at every consent; its bytes already are UTF-8.
- Anchors describe the bytes on disk, including after a failed write.

**Evidence.** `src/file-encoding-state.ts`, `src/encoding.ts`, `src/encoding-consent.ts`,
ADR-0012, ADR-0052, ADR-0051.
**Upstream has no equivalent.** Upstream detects binary/UTF-16 and discloses invisible
characters; it carries no legacy codec model and no migration consent.

## 5. Line endings

### U-11 One effective EOL per write, normalized undo

**Problem.** Mixed terminators make a small edit rewrite unrelated lines. A forced EOL policy
must be predictable and reversible.

**Design.** A write resolves one effective EOL: `DSH_BETTER_EDIT_EOL` > `eol` in `config.yaml` >
the file's dominant terminator (whole file; ties prefer LF, then CRLF, then CR) > the system
ending. The edit warning `W_EOL_REWRITTEN` names target, source, and the count changed. A read
that sees a mixture emits `W_MIXED_EOL`. Undo restores at the edit's effective EOL and names a
lost mixture.

**Invariants.**

- The read notice and the applied warning resolve the same ladder; they can never name different
  rungs.
- `AUTO` follows the file; a file with no terminator falls back to the system ending.
- A forced rung re-spells even a uniform file and says so.
- The mixed-EOL notice is chrome appended to `text`, never a served row.

**Evidence.** `src/eol-config.ts`, `src/read-and-serve.ts` (`mixedEolWarning`),
`src/mutation/engine.ts`, ADR-0047.
**Downstream deviation from upstream:** no `.editorconfig`, no `settings.json` ladder, and the
env var is `DSH_BETTER_EDIT_EOL`.

## 6. Store

### U-12 Store tenancy: central, workspace, custom

**Problem.** A plugin can run in one workspace, many workspaces, or a sandboxed home. A single
global database becomes a contention and cleanup problem; a per-workspace database pollutes every
repository.

**Design.** `tenancyFor(cwd)` returns `{dir, mode, runtimeDir, canonical}`. The default is
`central`: `$DSH_HOME/plugins/dsh-better-edit/runtime/<name>-<hash8>/`, readable by `ls`, with a
`.wsPath` sidecar that detects a hash collision. `workspace` keeps the legacy
`<ws>/.dsh_better_edit/`; an absolute `storeDir` is a custom root. A central janitor runs at app
start and session start, throttled to 24 hours, and evicts by idle age and total bytes.

**Invariants.**

- The database is a disposable cache; deleting it is safe and rebuilds on the next read.
- A collision warning never silently repoints a store.
- The janitor never evicts a live hash or an active snapshot pin.
- A store path is resolved once per workspace, not per tool call.

**Evidence.** `src/store-tenancy.ts`, `src/store-lifecycle.ts`, `src/snapshot-store/vacuum.ts`,
ADR-0021, ADR-0026, `docs/specs/issue-24-store-tenancy.md`.

## 7. Read and mutation contracts

### U-13 Multi-window read projection with union merge

**Problem.** A model often needs two distant ranges in one turn. Serving them as separate reads
costs a round trip; serving them as separate sections must not double-serve overlapping lines.

**Design.** `windows: [{offset, limit}]` accepts up to 16 ranges. Every window's rows are served,
so anchors from all of them work in one `edit`. Overlapping windows merge into the union of their
line ranges and render as one section; disjoint windows keep one section each.

**Invariants.**

- Merge happens on line ranges before assignment, so an overlapping line is served once.
- The window cap is 16 and is enforced in `normWindows` (the dsh value schema has no `maxItems`).
- A read with no requested windows keeps the plain full-read contract.

**Evidence.** `src/file-view.ts` (`MAX_READ_WINDOWS`, `normWindows`), `src/tool-read.ts`,
ADR-0029.

### U-14 Rejection rows are a fresh read

**Problem.** A refusal that shows stale rows teaches the model to retry with the same bad
anchors. A refusal that shows no rows teaches nothing.

**Design.** A rejection raised after an earlier batch item changed the working buffer is
served-or-absent: it either shows rows from the current buffer or shows none. Row-carrying
refusals record their rows as served, exactly like a `read`. A rowless refusal names the read.
`retired` anchors are named as retired, never as `tombstone`.

**Invariants.**

- A rejection never mixes a working-buffer anchor with on-disk text.
- Rows shown by a rejection are usable for the retry without another read.
- A rowless refusal records nothing and says so.
- The vocabulary stays `retired` (ADR-0028), even though upstream renamed it.

**Evidence.** `src/mutation/rejection-serve.ts`, `src/hashline/anchor-pipeline.ts`,
ADR-0022, ADR-0042, ADR-0043, ADR-0028.

### U-15 Served-evidence seam and full-read authority

**Problem.** Anchors alone do not prove the model saw the interior of a replaced span. Different
paths (read, diff, rejection, write auto-read) can record served state inconsistently.

**Design.** `served-evidence.ts` owns the question "was this line served?". `FileView` owns the
full-read verdict; a page clears no hazard state. `SessionView` owns session-scoped served rows
and drift. The mutation pipeline reads the evidence, never a second copy.

**Invariants.**

- One owner per question; no parallel served store.
- A full read is the only operation that clears the full-read hazard.
- A sub-agent's serves never validate the main agent's edits.
- `strict` span mode refuses an unserved replaced interior before any write; `hint` applies and
  discloses it.

**Evidence.** `src/hashline/served-evidence.ts`, `src/file-view.ts`, `src/session-view.ts`,
ADR-0035, ADR-0037, ADR-0045.

## 8. Undo

### U-16 Undo as a transaction, at the edit's EOL, naming the abandoned codec

**Problem.** A failed undo write can leave the undo row consumed but the file unchanged, so the
next undo is unavailable. Restoring at the wrong EOL rewrites the file. A migration edit cannot
restore bytes it no longer has.

**Design.** The mutation transaction persists the undo row, writes, and restores the row when the
write fails. Undo restores at the edit's recorded `effective_ending` and names a pre-edit mixture
it cannot rebuild. After an encoding migration it restores the text as UTF-8 and names the codec
and BOM the edit abandoned.

**Invariants.**

- One authority restores the undo row on write failure.
- Undo refuses with `E_UNDO_STALE` when the file changed after the edit.
- The undo response names what it could not restore; it never claims byte-exactness it lacks.

**Evidence.** `src/mutation.ts`, `src/undo-edit.ts`, `src/tool-undo.ts`, ADR-0034, ADR-0047,
ADR-0051.

## 9. Governed `str_replace_editor` shadow

**Problem.** Some dsh presets compose `str_replace_editor` instead of `edit`. Leaving it
unshadowed means those agents bypass the encoding state, the fs policy events, and the sandbox
policy.

**Design.** `buildStrReplaceEditorTool` implements the built-in contract (`view`, `str_replace`,
`insert`, `create`) and refuses `undo_edit`. `view` is observation only: it records encoding state
and emits `fs/observed`, but never records served state, so it cannot authorize a hashline
`edit`. Mutations stamp the sandbox policy.

**Invariants.**

- Same wire contract as the built-in; no new `encoding` parameter.
- `view` never grants anchors.
- `str_replace`/`insert` without a prior `view`/`read` fail loud with `E_BAD_PAYLOAD`.
- `create` defaults to UTF-8 without BOM.
- Installed only when the preset composed the tool.

**Evidence.** `src/tool-str-replace-editor.ts`, ADR-0015, ADR-0032.

## 10. Boundary: intentionally not adopted

These are host-boundary decisions, not missing work. Revisit only with a new ADR.

| Upstream capability        | Why it has no carrier here                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bash view interception     | dsh owns the `bash` tool; this plugin shadows only file tools and a write hook. Intercepting bash would need a host event this plugin does not own. |
| Search hook                | Same boundary: dsh's search surface is not this plugin's tool.                                                                                      |
| pi-lens IO bridge          | pi-lens is a pi extension; dsh has no equivalent bridge service here.                                                                               |
| TUI preview / presenter    | The dsh tool result is a string; the plugin does not own the TUI.                                                                                   |
| Read expansion providers   | Would require an AST/symbol service in dsh; not present in the pinned host surface.                                                                 |
| `text_ref` cut transaction | The downstream contract never absorbed the cut path; there is no `cut_intent` table or repair state.                                                |
| 4-char anchors             | The 3-char content-only model is the local contract; changing it is a stored-state migration, not a formatting choice.                              |

## 11. Maintenance rules

1. **Never bypass the fs bridge.** Any new read/write path must emit the same policy events.
2. **Never register a tool outside `agent/created`.** Global registration breaks the shadow and
   the auto-unwind.
3. **Never grow the heal set beyond the install set.** A preset-declined tool stays absent.
4. **Add a new config key in three places:** schema, YAML materializer, env parser, plus a
   README row. A key with no default is a bug.
5. **Add a new persisted column behind the schema version gate.** Do not mutate an existing
   column's meaning.
6. **A behavior change needs an ADR.** Then add a row to `docs/divergence-from-upstream.md` when
   it changes a shared contract.
7. **Keep `test/arch/*` green.** Those tests pin the seams this dossier describes; a failure is
   a design change, not a test to relax.
