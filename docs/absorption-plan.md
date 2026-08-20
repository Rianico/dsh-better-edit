# Absorption Plan — pi-better-edit → dsh-better-edit since 6a9cefca

**Basis:** `pi-better-edit@6a9cefca` (1.1.3) → `v1.1.4` (42 commits, +8200/-4702). Downstream is `dsh-better-edit@0.2.2` on `arch/deepen-all-6` (deepened 6 seams). Decisions from grilling round 1 (2026-08-20) are authoritative.

## Decisions (grilling Q1–Q6)

- **Q1 Phased:** P1 = correctness+contract+arch (must ship atomically), P2 = hygiene, P3 = README/glossary. No big-bang.
- **Q2 Payload:** **(a) breaking** — adopt `{path, edits:[[hash,hash,text]]}` verbatim, delete `batch_edit`, major `0.3.0`. No bridge.
- **Q3 Glossary:** merge upstream hashline glossary wholesale into single `CONTEXT.md` (§§ Hashline + §§ Guidance).
- **Q4 README:** structural mirror of upstream brooks-lint order/tone, keep dsh install matrix, benchmark section *references* upstream `benchmarks/results/` (same hashline algorithm — no re-run).
- **Q5 Arch mapping:** deep-seam replay (canon→HashAssign, orphan→SessionView/AnchorPipeline, payload→contract.ts/mutation.ts) — no flatten.
- **Q6 Execution:** 6 delta tickets + 1 integration = 7 worktrees, each `typecheck + vitest`, lane integration `build + full suite`, isolated writes.

## Phases

### Phase 1 — correctness + contract (P1, blocks P2/P3)

| Ticket | Branch | Upstream source | Deep seam | Acceptance |
| -------- | -------- | ---------------- | ----------- | ------------ |
| **T1 — whitespace-insensitive canon** | `absorb/t1-canon` | ADR-0005, `1b92f4f` `canon()` strip `[ \t\r\n]`, `CANON_VERSION=2`, memoized `getCanon`, snapshot cache version | `hashline/hash.ts`→`HashAssign`, `snapshot-store.ts`, `hashline/resolve.ts` | `canon("  a b ")==="ab"`, `CANON_VERSION` invalidates cache, `prettier` whitespace-only pass does not rotate anchor, string-internal whitespace caveat documented, `npm run typecheck && npm test` green |
| **T2 — orphaned serve healing & robustness** | `absorb/t2-orphan` | ADR-0008, `abd8372` `25ed5f0` `8cb8d3d`, `a550e07` `2cea04f` | `SessionView`/`served-state`, `AnchorPipeline.verifyServedRange`, `hashline/served.ts` | `patchServed` O(1) eager heal, candidate-span enumeration picks closest, truncation on rejection-echo/external-shrink, `E_RANGE_UNVERIFIED` loop gone, `served-truncation-*` tests ported |
| **T3 — merged edit payload** | `absorb/t3-payload` | ADR-0007, `baf6c3b` `71bf701` `c68a040` `958d9d3` `69fe48b` | `contract.ts`, `mutation.ts`, `tool-edit.ts` (delete `tool-batch-edit.ts`), `edit-engine.ts`, `prompts.ts` | `edit({path, edits:[[h,h,t]]})` only, `batch_edit` removed, `null` path inference, `EDITS_MAX_ITEMS=32`, `[E_BAD_SHAPE]` on old shape, `tool:edit` order preserved, `typecheck+vitest` on contract/edit tests |
| **T4 — arch purity + preview controller** | `absorb/t4-arch` | `a11a833` `394b9ad` `a550e07` `c0c4ee0` `8937060` | `HashAssign` purity (no DB in hash layer), `SessionView` drift, `AnchorPipeline.applyOneEdit`, `DebouncedPreview` | `hash.ts` pure (IO injected), `recordDiffServes` helper, `applyOneEdit` shared by single+batch, preview debounced 150ms, noop-loop folded, no extra I/O on read hot path |

### Phase 2 — hygiene (P2, after P1 green)

| Ticket | Branch | Upstream source | Scope | Acceptance |
|--------|--------|----------------|-------|------------|
| **T5 — notices & prompts hygiene** | `absorb/t5-hygiene` | `de73860` `3cade32` `cec32eb` | Zed terse notices, lean guidelines (dedupe tool-description rules), schema descriptions 184→39w, `file-kind` etc | Notices match upstream wording (codes unchanged), guidelines lean, `tool:edit/read/undo` descriptions trimmed, no behavior change |

### Phase 3 — docs (P3, after P2)

| Ticket | Branch | Upstream source | Scope | Acceptance |
|--------|--------|----------------|-------|------------|
| **T6 — README + CONTEXT merge** | `absorb/t6-docs` | `b52e776` `a120fde` `e645672` `7d5e281`, upstream `CONTEXT.md` | README brooks-lint reorg (hook, shining points, Why Hashline before Tools, -XX% savings), banner.svg, benchmark section referencing `pi-better-edit/benchmarks/results/` | README order mirrors upstream but keeps `npx @deepseek-ai/dsh` install + profile rows, CONTEXT.md merged wholesale, no benchmark re-run |

### Integration

| Ticket | Branch | Scope | Acceptance |
|--------|--------|-------|------------|
| **T7 — integration + release 0.3.0** | `absorb/t7-integration` | merge P1→P2→P3 onto `arch/deepen-all-6`, bump `package.json` `0.3.0`, CHANGELOG `[Unreleased]`→`[0.3.0]`, `npm run typecheck && npm test && npm run build` full suite, no cross-worktree clobber | `git status` clean, `npm run build` emits, `typecheck` zero errors, all 7 worktrees merged, single PR |

## Worktree discipline

- One worktree per ticket = own directory, own branch. `git worktree add ../.worktrees/<ticket> -b <branch> arch/deepen-all-6`
- Each ticket worktree writes only inside its seam (see table). Main agent verifies `typecheck+vitest` in that worktree before integration.
- `T7` integrates sequentially: `T1→T2→T3→T4` rebase order, then `T5`, then `T6`.
- Benchmark harness (`benchmarks/`, `scripts/practical-token-benchmark.mjs`) is **not** ported — README references upstream results per Q4.

## Pointers for subagents

- Upstream diff base: `6a9cefca6c6e7011f5a20f058f9e17e3375419da..v1.1.4` in `/Users/zhengxk/development/ai/pi-better-edit`
- Downstream deep seams: `src/hashline/`, `src/file-view.ts`, `src/session-view.ts`, `src/mutation.ts`, `src/hash-store.ts` (hashAssign), `src/hashline/anchor-pipeline.ts`
- ADRs to port: `docs/adr/0005-whitespace-insensitive-anchors.md`, `0006→0007 merged payload`, `0008 orphaned heal` (copy+adapt, not verbatim)
- Verification gates: `npm run typecheck`, `npm test` (vitest), `npm run build` (T7 only). Use `.lsz/tmp` for scratch, never repo root.
