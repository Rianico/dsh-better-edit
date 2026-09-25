#!/usr/bin/env node
/**
 * T3h mutation-ledger applier + runner.
 *
 * Makes ADR-0018 `## Reproduce` re-derivable from the committed tree: it archives HEAD into a temp
 * tree, applies one mutation to the COPY (the worktree is never written to), runs vitest there, and
 * compares the failing cells against the expected RED set recorded in the ADR.
 *
 * Usage:
 *   node test/tools/mutate-ledger.mjs --list
 *   node test/tools/mutate-ledger.mjs <id> [--full] [--keep] [--expect-rev=<sha>]
 *
 * Contract:
 *   - prints `git rev-parse HEAD` and refuses to run when `git status --porcelain -- src test docs`
 *     is non-empty (ignored handoff/scratch paths are not the artifact, so they are out of scope);
 *   - `--expect-rev=<sha>` additionally asserts the revision the recipe was verified at;
 *   - asserts each anchor occurs exactly once (a drifted tree fails loudly here);
 *   - prints `applied <id>`, then greps the inserted line back out of the mutated file, so mutant
 *     presence is recorded rather than inferred;
 *   - prints both vitest summary lines and the failing cell titles, then `RED SET MATCH` or
 *     `MISMATCH` + the missing/extra diff; exits non-zero on mismatch.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENGINE = "src/mutation/engine.ts";
const ANCHOR_PIPELINE = "src/hashline/anchor-pipeline.ts";
const CONTRACT = "test/core/serve-leases.test.ts";
const DOMAIN_ERRORS = "src/domain-errors.ts";

/**
 * Revisions the expected RED sets below were measured at:
 *  - T3h (`M1`/`M2`/`M4`/`N1`/`Z3b`, contract file): see ADR-0018's T3h subsection.
 *  - T4 (`T4M1`–`T4M5`, full suite): see ADR-0018's "T4 ledger" subsection.
 * The T4 ids are prefixed because the T3h ledger already owns `M1`/`M2`/`M4`.
 */
// FROZEN vs MOVING: the three revisions below are FROZEN baseline labels for closed corpora (T3h, T4,
// T4-r3) — keep them; their immutability is the information. A literal claiming a measurement of the
// CURRENT sets is a MOVING referent: it rots at the next cell addition, so it is removed rather than
// updated (see the T5 header's invariant: the run asserts its own revision).
const VERIFIED_AT = "ba430557912b8b2934261654d3e09034188d8571";
/** T4 (T4M1–T4M5) expected RED sets were measured at this revision. */
const T4_VERIFIED_AT = "ddce82b333a2c6cc5854823de92264971f5e84f2";
/** T4 CP1-r3 (M6–M9) expected RED sets were measured at this revision. */
const R3_VERIFIED_AT = "09b4391a4a8c696860d5ed89c4f21641cbdbb2ed";

const T = {
  twinRecords: "twin rejection records nothing — served rows byte-identical before/after",
  twinGrants: "twin rejection grants nothing — no grant field changes, no new lease appears",
  twinReadEquiv: "twin rejection → fresh read ≡ control (0 duplicates, no shifted labels)",
  insertOnly: "non-twin insert-only exterior change → rejection → fresh read ≡ control",
  windowed:
    "non-twin windowed read + change outside the served span → rejection → fresh read ≡ control",
  consecutive:
    "consecutive rejections compose — reject → reject leaves served rows and grants byte-identical",
  batchAbort:
    "batch abort (one part rejecting) records nothing — served rows and grants byte-identical",
  noopLoop:
    "noop-loop rejection records nothing — served rows and grants byte-identical, next read ≡ control",
  malformed: "malformed anchor on an existing file rejects E_BATCH_ABORT and writes nothing",
};

/** T4 CP1-r2 cell titles (ADR-0018 "T4 ledger" / ADR-0013 "Reproduce"). */
const T4 = {
  spanLength: "span-length rejection offers no dead retry (C1)",
  unservedInterior: "unserved-interior rejection offers no dead retry (C2)",
  staleAnchorReread: "stale-anchor rejection recovers only by re-read (C3)",
  contextRows: "stale-anchor with context rows states the arm-dependent truth (C4)",
};

/**
 * T6 cell titles (ADR-0022: the region rule and the deleted retry pair).
 * T4M1/T4M2/T4M3/T4M5 retired here: their mutation anchors (`reread: true`, `RETRY_HINT`,
 * the payload-map field) no longer exist — the deferral they pinned fired in T6.
 */
const T6 = {
  formatterHint: "E_STALE_RANGE with rows renders the heading and the named region's rows (T6)",
  regionOracle: "span-length arm carries the named region's rows",
  armFlag: "no range-family arm carries the deleted retry flag (arm counts pinned)",
  nullRowGate: "fails closed on a null row inside the window — the gate is directly callable",
  lengthDisagree: "rejects a window whose served and rebased lengths disagree",
  deletedExternally:
    "rejects E_STALE_RANGE and writes nothing when the anchored line was deleted externally",
  neverGuard: "W_NEVER_SERVED_SHAPE's guard holds while the source scan sees no producer for it",
  mismatchGuard:
    "W_SERVED_PREFIX_MISMATCH's guard holds while the source scan sees no producer for it",
  deferredRefute:
    "the deferred predicates refute a constant: their own code falsifies, others do not",
  orderIndependence:
    "the witness is order-independent: a render through the pure seam cannot falsify a guard",
};

/** T4 CP1-r3 cell titles (arch registry oracle + the numeric-note end-to-end cell). */
const T4R3 = {
  forward: "totality forward: every code is produced or deferred",
  backward: "totality backward: deferred codes name a ticket and a trigger",
  fields: "every registry field is rendered or declaration-only",
  deleted: "deleting a deferred code's producer *stays* deleted",
  contextMessage:
    "shows current context around the resolved anchor when only one anchor of a range is stale",
};

/** T4 CP1-r4 cell titles (the envelope separator). */
const T4R4 = {
  glueRows: "the rendered envelope never glues a row to the on-disk heading (C11a)",
  glueFallback: "the contextless fallback starts its own line in the rendered envelope (C11b)",
};

/** T4 CP1-r5 cell titles (scanner controls, union/registry parity, allowlist identity). */
const T4R5 = {
  commentFake: "a producer-shaped line inside a comment is not a producer",
  singleQuote: "single-quoted union members and producers are recognised",
  digits: "digit-bearing code names are recognised",
  parity: "union and registry agree in both directions",
  fieldIdentity: "the field allowlist is pinned by identity and its predicates hold",
};

/** T4 CP1-r6 cell titles (predicate pins, shape derivation, full-oracle limits). */
const T4R6 = {
  holdsPins: "`holds` predicates are pinned by source text and by behaviour (C17)",
  shapeDerivation: "every shape literal derives from CODE_SHAPE/QUOTED_CODE (C18)",
  limitHeld: "DECLARED LIMIT (full oracle): a variable-held producer reports LOUD",
  limitMjs: "DECLARED LIMIT (full oracle): a .mjs producer reports LOUD",
  limitRegex: "DECLARED LIMIT (full oracle): a regex-literal `//` hides a producer LOUDLY",
  stripperPremise: "the stripper's doc comment states the well-formed-input premise (C20)",
};
/**
 * T5 cell titles (LRU snapshot vacuum). Corpus: `docs/adr/0021-lru-snapshot-vacuum.md`.
 * The expected sets below are verified at the revision this run asserts: the run prints that revision
 * and `--expect-rev=<sha>` refuses loudly on mismatch, so a stale expectation cannot pass quietly.
 * Re-run the full sweep to re-derive them. The frozen baseline labels for the closed corpora above
 * are the opposite case: they stay, because the corpora they name no longer move.
 * An `expected: []` entry is a measured GREEN mutant, diagnosed by one of: (1) a real gap, (2) the
 * mutation did not apply, (3) the claim was too strong, (4) another mechanism covered the effect
 * (T5M22/T5M26/T5M28: the FK cascade or the serve write's re-materialization, per the P1 matrix).
 * Adding a cell can widen the RED sets of EXISTING mutants, so a new mutant's line alone is not
 * evidence: re-run the full sweep (`for i in $(seq 1 30); do node test/tools/mutate-ledger.mjs T5M$i; done`),
 * because the ledger exits non-zero on any mismatch — it is a gate, not a report. Two assertion rules
 * from cell 29: bracket the boundary (probe just past it, in both directions) and require a delimiter
 * in the match — a substring a longer name can satisfy (`b 1` vs `b 10`) is a paper tiger inside the
 * assertion itself.
 */
const T5 = {
  window:
    "cell 01 per-path window: the oldest versions are evicted and their lineage goes with them",
  globalBudget: "cell 02 global budget: oldest-created_at rows are evicted until the total holds",
  activePin:
    "cell 03 active pin survives: a leased version stays resolvable while siblings are evicted",
  pinRecency: "cell 04 pin recency: an aged lease stops pinning and a re-serve pins again",
  retiredGrace: "cell 05 retired-inside-grace pins, and a retirement older than the grace does not",
  undoPin:
    "cell 06 undo target pinned: a `file_undo.snapshot_hash` survives the per-path and global arms",
  protectIds: "cell 07 protectSnapshotIds: the in-flight id survives an over-budget sweep",
  countersLeases: "cell 08 counters and leases are never touched, even for a fully evicted path",
  loudDeferral: "cell 09 loud deferral: an all-pinned over-budget store reports, never evicts",
  rematerialize:
    "cell 10 re-materializing an evicted version issues counter-fresh ids and never duplicates a line",
  evictedTarget: "cell 11 an evicted lease target fails loudly and writes nothing",
  rejectNoop:
    "cell 12 reject-stays-a-no-op and a read after a vacuum still equals the on-disk bytes",
  undoPinSurvives: "cell 13 the undo pin survives a vacuum and the undo still restores",
  crossTable:
    "cell 14 cross-table: a pruned v7 family re-materializes and the legacy row is not the source",
  triggerFailure:
    "cell 15 the best-effort trigger reports its own failure and the read still succeeds",
  deferral: "cell 16 deferral: a sweep inside a caller-owned unit skips, the boundary stays atomic",
  reportPayload:
    "cell 17 report payload: an over-budget deferral under the soft cap is reported with its numbers",
  reportRearm: "cell 18 report throttle: an under-budget pass re-arms the warning",
  idempotence: "cell 19 idempotence: a second sweep evicts nothing and changes no row",
  pairInvariant:
    "cell 20 pair invariant: no orphan lineage after a normal, an aborted-boundary or a deferred sweep",
  pairOnRealOpener:
    "cell 21 pair invariant: an eviction leaves no orphan lineage on the real opener",
  inflightProtection:
    "cell 22 in-flight protection: the sweep never targets the row a materialization just wrote",
  reportAtOpen: "cell 23 report at store open: the open trigger surfaces the deferred state",
  reportAtMaterialization:
    "cell 24 report at materialization: the overflow and the skip are surfaced by the trigger",
  overBroadPin:
    "cell 25 over-broad pin: a file_undo row for another path does not pin the candidate",
  crashMidPair:
    "cell 26 crash mid-pair: a fault between the two deletes rolls back to a whole pair",
  openFailure: "cell 27 report at store open: a failing open sweep is loud and non-fatal",
  legacyOnlyUpsert:
    "cell 28 legacy-only upsert: no v7 materialization means no sweep and no failure",
  reportCap:
    "cell 29 the report ledger cap evicts the oldest context, which is then reported again",
};
const VACUUM = "src/snapshot-store/vacuum.ts";
const LINEAGE_STORE = "src/snapshot-store/lineage-store.ts";
const HASH_STORE = "src/hash-store.ts";
const STORE_LIFECYCLE = "src/store-lifecycle.ts";
const SESSION_VIEW = "src/session-view.ts";
const VACUUM_UNIT = "test/core/vacuum.test.ts";
const VACUUM_INTERACTION = "test/core/vacuum-interaction.test.ts";
const ARCH_SCAN = "test/support/arch-scan.ts";

/** Shared pre-edit for the three `recordServed` mutants. */
const SESS_IMPORT = {
  file: ENGINE,
  old: '  retireAnchors,\n} from "../session-view.js";',
  new: '  retireAnchors,\n  recordServed,\n} from "../session-view.js";',
};

const M1_TITLES = [
  T.twinRecords,
  T.twinGrants,
  T.twinReadEquiv,
  T.insertOnly,
  T.windowed,
  T.consecutive,
  T.batchAbort,
];

const MUTANTS = {
  M1: {
    what: "full write at collectAbortPart (rows + snapshot context)",
    scope: [CONTRACT],
    expected: M1_TITLES,
    edits: [
      SESS_IMPORT,
      {
        file: ENGINE,
        old: "        : undefined;\n  const originalLines = splitLines(opts.originalNormalized);",
        new:
          "        : undefined;\n" +
          "  await recordServed(opts.sessionKey, opts.absolutePath, echoRows ?? [], opts.originalHashes.length, {\n" +
          "    content: opts.originalNormalized,\n" +
          "    hashes: opts.originalHashes,\n" +
          "  });\n" +
          "  const originalLines = splitLines(opts.originalNormalized);",
      },
    ],
  },
  M2: {
    what: "same site, rows only — no snapshot context",
    scope: [CONTRACT],
    expected: M1_TITLES.filter((t) => t !== T.twinGrants),
    edits: [
      SESS_IMPORT,
      {
        file: ENGINE,
        old: "        : undefined;\n  const originalLines = splitLines(opts.originalNormalized);",
        new:
          "        : undefined;\n" +
          "  await recordServed(opts.sessionKey, opts.absolutePath, echoRows ?? [], opts.originalHashes.length);\n" +
          "  const originalLines = splitLines(opts.originalNormalized);",
      },
    ],
  },
  M4: {
    what: "full write at the batch noop guard's call site",
    scope: [CONTRACT],
    expected: [T.noopLoop],
    edits: [
      SESS_IMPORT,
      {
        file: ENGINE,
        old: "      const notice = await enforceNoopLoop({",
        new:
          "      await recordServed(opts.sessionKey, absolutePath, echoRowsForItem(applied.edit, originalHashes) ?? [], originalHashes.length, {\n" +
          "        content: originalNormalized,\n" +
          "        hashes: originalHashes,\n" +
          "      });\n" +
          "      const notice = await enforceNoopLoop({",
      },
    ],
  },
  N1: {
    what: "anchor parser accepts a malformed token",
    scope: [CONTRACT],
    expected: [T.malformed],
    caveat:
      "the RED is the cause assertion (contract :759); the envelope assertion (:758) passes because " +
      "the E_BATCH_ABORT envelope survives, and the two nothing-written asserts (:760-761) are NOT reached",
    edits: [
      {
        file: ANCHOR_PIPELINE,
        old: "if (trimmed.length === ANCHOR_LEN && ALPH_RE.test(trimmed)) {",
        new: "if (trimmed.length === ANCHOR_LEN || ALPH_RE.test(trimmed)) {",
      },
    ],
  },
  Z3b: {
    what: "throw in enforceNoopLoop's batch branch",
    scope: null, // full suite
    expected: [
      "batch_edit rejects repeated noop edits at the loop threshold",
      T.noopLoop,
      "second identical no-op warns applied, third rejects E_NOOP_LOOP, file untouched",
      "batch: throws at threshold and notice at 2",
      "batch reject renders the on-disk heading exactly once",
      "batch without echoRows still throws",
    ],
    edits: [
      {
        file: ENGINE,
        old: "  if (count >= NOOP_LOOP_THRESHOLD) {\n    const originalLines = splitLines(opts.originalNormalized);",
        new: '  if (count >= NOOP_LOOP_THRESHOLD) {\n    throw new Error("Z3b");\n    const originalLines = splitLines(opts.originalNormalized);',
      },
    ],
  },
  T4M4: {
    what: "restore the read-free E_STALE_ANCHOR remedy string",
    scope: null, // full suite
    expected: [T4.staleAnchorReread],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old: '    remedy: "Read the file again for fresh anchors, then retry.",',
        new: '    remedy: "Retry with the served rows; no read is needed.",',
      },
    ],
  },
  T6M1: {
    what: "restore the deleted retry affordance on the stale-range formatter",
    scope: null, // full suite
    expected: [
      T4.spanLength,
      T6.nullRowGate,
      T6.lengthDisagree,
      T6.regionOracle,
      T6.deletedExternally,
      T6.formatterHint,
    ],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old:
          "  // headline alone; the payload's rows are its retry affordance.\n" +
          "  if (!payload.servedBlock) return payload.headline;\n" +
          "  return `${payload.headline}\\nCurrent range:\\n${payload.servedBlock}`;",
        new:
          "  // headline alone; the payload's rows are its retry affordance.\n" +
          "  if (!payload.servedBlock) return payload.headline;\n" +
          "  return `${payload.headline}\\nCurrent range:\\n${payload.servedBlock}\\nRetry with these anchors (no read needed).`;",
      },
    ],
  },
  T6M2: {
    what: "re-add the deleted retry flag at one range arm",
    scope: null, // full suite
    expected: [T6.armFlag],
    edits: [
      {
        file: ANCHOR_PIPELINE,
        old: "      servedBlock: echo,\n      firstOffendingLine: args.rebasedStart,",
        new: "      servedBlock: echo,\n      reread: true,\n      firstOffendingLine: args.rebasedStart,",
      },
    ],
  },
  T6M3: {
    what: "plant a REAL W_* producer through the real seam (source scan sees it; the other code's guard must stay held)",
    scope: null, // full suite
    expected: [T4R3.backward, T6.neverGuard],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old: "export const DEFERRED_PRODUCERS: Readonly<Record<string, AllowlistEntry>> = {",
        new:
          'export const __t6m3 = formatWarning("W_NEVER_SERVED_SHAPE", { count: 1 });\n' +
          "export const DEFERRED_PRODUCERS: Readonly<Record<string, AllowlistEntry>> = {",
      },
    ],
  },
  T6M4: {
    what: "break the region oracle's real per-row identity guard",
    scope: null, // full suite
    expected: ["negative control: a misplaced row fails the live-mapping check"],
    edits: [
      {
        file: "test/arch/rejection-payload-region.test.ts",
        old:
          "    // The identity half: the row's hash IS the current snapshot's hash at that position.\n" +
          "    expect(row.hash, `row ${row.position} reproduces fileHashes[${row.position}]`).toBe(\n" +
          "      args.fileHashes[row.position],\n" +
          "    );",
        new: "    // mutated (T6M4): the per-row identity guard is dropped.",
      },
    ],
  },
  T6M5: {
    what: "plant a W_SERVED_PREFIX_MISMATCH producer ONLY — per-code isolation (W_NEVER_SERVED_SHAPE's guard must stay held)",
    scope: null, // full suite
    expected: [T4R3.backward, T6.mismatchGuard],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old: "export const DEFERRED_PRODUCERS: Readonly<Record<string, AllowlistEntry>> = {",
        new:
          'export const __t6m5 = formatWarning("W_SERVED_PREFIX_MISMATCH", { k: 1, anchor: "aaa", servedLine: 1 });\n' +
          "export const DEFERRED_PRODUCERS: Readonly<Record<string, AllowlistEntry>> = {",
      },
    ],
  },
  M6: {
    what: "re-add E_FOREIGN_ANCHOR to DEFERRED_PRODUCERS as a bare rot-marker string",
    scope: null, // full suite
    expected: [T4R3.backward, T6.deferredRefute, T6.orderIndependence, T4R3.deleted],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old:
          "export const DEFERRED_PRODUCERS: Readonly<Record<string, AllowlistEntry>> = {\n" +
          "  W_NEVER_SERVED_SHAPE: {",
        new:
          "export const DEFERRED_PRODUCERS: Readonly<Record<string, AllowlistEntry | string>> = {\n" +
          '  E_FOREIGN_ANCHOR: "range-family ticket (leases)",\n' +
          "  W_NEVER_SERVED_SHAPE: {",
      },
    ],
  },
  M7: {
    what: "re-add E_TARGET_LOST as a union member with no producer and no deferral",
    scope: null, // full suite
    expected: [T4R3.forward, T4R3.deleted, T4R5.parity],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old: '  | "E_STALE_RANGE"\n  | "E_MALFORMED_ANCHOR"',
        new: '  | "E_STALE_RANGE"\n  | "E_TARGET_LOST"\n  | "E_MALFORMED_ANCHOR"',
      },
    ],
  },
  M8: {
    what: "delete DECLARATION_ONLY_FIELDS while `remedy` still has no reader",
    scope: null, // full suite
    expected: [T4R3.fields, T4R5.fieldIdentity],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old:
          "export const DECLARATION_ONLY_FIELDS: Readonly<Record<string, AllowlistEntry>> = {\n" +
          "  remedy: {\n" +
          '    owner: "src/domain-errors.ts",\n' +
          "    trigger: {\n" +
          '      text: "src/domain-errors.ts",\n' +
          '      holds: () => Object.values(ERROR_REGISTRY).some((spec) => "remedy" in spec),\n' +
          "    },\n" +
          "  },\n" +
          "};",
        new: "export const DECLARATION_ONLY_FIELDS: Readonly<Record<string, AllowlistEntry>> = {};",
      },
    ],
  },
  M9: {
    what: "add a `remedy` reader (append it in staleAnchorFormat) without de-allowlisting it",
    scope: null, // full suite
    expected: [T4R3.fields, T4R5.fieldIdentity, T4R3.contextMessage],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old:
          "  if (!payload.servedBlock) return payload.headline;\n" +
          "  return `${payload.headline}\\n\\n${payload.servedBlock}`;\n}",
        new:
          "  if (!payload.servedBlock) return payload.headline;\n" +
          '  return `${payload.headline}\\n\\n${payload.servedBlock}\\n${ERROR_REGISTRY.E_STALE_ANCHOR.remedy ?? ""}`;\n}',
      },
    ],
  },
  M10: {
    what: "revert F12: glue the echo block back onto the inner message",
    scope: null, // full suite
    expected: [T4R4.glueRows, T4R4.glueFallback],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old: "    `edits[${payload.index}] (${payload.path}) failed: ${payload.inner}\\n${payload.echoBlock.trimStart()}\\n` +",
        new: "    `edits[${payload.index}] (${payload.path}) failed: ${payload.inner}${payload.echoBlock}\\n` +",
      },
    ],
  },
  M11: {
    what: "revert G1: scan producers without stripping comments",
    scope: null, // full suite
    expected: [T4R5.commentFake, T4R6.limitRegex],
    edits: [
      {
        file: ARCH_SCAN,
        old: "export function producedCodesInText(text: string): string[] {\n  const bare = stripComments(text);",
        new: "export function producedCodesInText(text: string): string[] {\n  const bare = text;",
      },
    ],
  },
  M12: {
    what: "revert G2: accept double quotes only",
    scope: null, // full suite
    expected: [T4R5.singleQuote],
    edits: [
      {
        file: ARCH_SCAN,
        old: "export const QUOTED_CODE = `[\"'](${CODE_SHAPE})[\"']`;",
        new: 'export const QUOTED_CODE = `"(${CODE_SHAPE})"`;',
      },
    ],
  },
  M13: {
    what: "revert G3: exclude digits from the code shape",
    scope: null, // full suite
    expected: [T4R5.digits, T4R6.shapeDerivation],
    edits: [
      {
        file: ARCH_SCAN,
        old: 'export const CODE_SHAPE = "[EW]_[A-Z0-9_]+";',
        new: 'export const CODE_SHAPE = "[EW]_[A-Z_]+";',
      },
    ],
  },
  M14: {
    what: "add a union member with no registry entry",
    scope: null, // full suite
    expected: [T4R5.parity, T4R3.forward],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old: '  | "E_STALE_RANGE"\n  | "E_MALFORMED_ANCHOR"',
        new: '  | "E_STALE_RANGE"\n  | "E_ORPHAN"\n  | "E_MALFORMED_ANCHOR"',
      },
    ],
  },
  M15: {
    what: "field allowlist owner is a bare lane letter (not an addressable identity)",
    scope: null, // full suite
    expected: [T4R5.fieldIdentity],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old: '    owner: "src/domain-errors.ts",\n    trigger: {\n      text: "src/domain-errors.ts",',
        new: '    owner: "T6",\n    trigger: {\n      text: "src/domain-errors.ts",',
      },
    ],
  },
  M16: {
    what: "holds: () => true in a DECLARATION_ONLY_FIELDS entry (unrefutable predicate)",
    scope: null, // full suite
    expected: [T4R6.holdsPins],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old: '      holds: () => Object.values(ERROR_REGISTRY).some((spec) => "remedy" in spec),',
        new: "      holds: () => true,",
      },
    ],
  },
  M17: {
    what: "caricature: holds: () => true in a DEFERRED_PRODUCERS entry (refuted by the token + behavioural pin; R15's real mutant is T6M3)",
    scope: null, // full suite
    expected: [T6.deferredRefute],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old: '      holds: (fired) => !fired.has("W_NEVER_SERVED_SHAPE"),',
        new: "      holds: () => true,",
      },
    ],
  },
  M18: {
    what: "reintroduce a private shape literal in unionMembers (no knob change)",
    scope: null, // full suite
    expected: [T4R6.shapeDerivation],
    edits: [
      {
        file: ARCH_SCAN,
        old: '  const members = [...block![1]!.matchAll(new RegExp(QUOTED_CODE, "g"))].map((m) => m[1]!);',
        new: "  const members = [...block![1]!.matchAll(/[\"']([EW]_[A-Z0-9_]+)[\"']/g)].map((m) => m[1]!);",
      },
    ],
  },
  // ---- T5: LRU snapshot vacuum ----
  T5M1: {
    what: "drop the per-path retention arm (global budget only)",
    scope: [VACUUM_UNIT],
    expected: [
      T5.window,
      T5.activePin,
      T5.pinRecency,
      T5.deferral,
      T5.idempotence,
      T5.pairInvariant,
      T5.pairOnRealOpener,
      T5.crashMidPair,
      T5.overBroadPin,
    ],
    edits: [
      {
        file: VACUUM,
        old: "    if (total > VACUUM_GLOBAL_BUDGET_BYTES || retained > retention) {",
        new: "    if (total > VACUUM_GLOBAL_BUDGET_BYTES) {",
      },
    ],
  },
  T5M2: {
    what: "drop the global-budget arm (per-path retention only)",
    scope: [VACUUM_UNIT],
    expected: [T5.globalBudget, T5.protectIds, T5.countersLeases],
    edits: [
      {
        file: VACUUM,
        old: "    if (total > VACUUM_GLOBAL_BUDGET_BYTES || retained > retention) {",
        new: "    if (retained > retention) {",
      },
    ],
  },
  T5M3: {
    what: "the pin probe returns nothing (no snapshot is ever pinned)",
    scope: [VACUUM_UNIT],
    expected: [
      T5.activePin,
      T5.pinRecency,
      T5.retiredGrace,
      T5.undoPin,
      T5.loudDeferral,
      T5.reportPayload,
      T5.reportRearm,
    ],
    edits: [
      {
        file: VACUUM,
        old:
          "    stmts\n" +
          "      .listPinned(now - SERVED_TTL_MS, now - VACUUM_RETIRED_PIN_MS)\n" +
          "      .map((row) => row.snapshot_id),",
        new: "    [],",
      },
    ],
  },
  T5M4: {
    what: "the lease pin ignores `updated_at` (no LRU-on-access)",
    scope: [VACUUM_UNIT, VACUUM_INTERACTION],
    expected: [
      T5.pinRecency,
      T5.countersLeases,
      T5.rematerialize,
      T5.evictedTarget,
      T5.rejectNoop,
      T5.crossTable,
    ],
    edits: [
      {
        file: VACUUM,
        old: '      "AND ((sl.retired_at IS NULL AND sl.updated_at >= ?) OR sl.retired_at >= ?)) " +',
        new: '      "AND ((sl.retired_at IS NULL AND ? IS NOT NULL) OR sl.retired_at >= ?)) " +',
      },
    ],
  },
  T5M5: {
    what: "the retired-lease grace clause can never hold",
    scope: [VACUUM_UNIT],
    expected: [T5.retiredGrace],
    edits: [
      {
        file: VACUUM,
        old: '      "AND ((sl.retired_at IS NULL AND sl.updated_at >= ?) OR sl.retired_at >= ?)) " +',
        new: '      "AND ((sl.retired_at IS NULL AND sl.updated_at >= ?) OR (sl.retired_at >= ? AND 0))) " +',
      },
    ],
  },
  T5M6: {
    what: "the `file_undo` undo pin can never match",
    scope: [VACUUM_UNIT, VACUUM_INTERACTION],
    expected: [T5.undoPin, T5.undoPinSurvives],
    edits: [
      {
        file: VACUUM,
        old: '      "AND fu.snapshot_hash = fs.snapshot_hash))",',
        new: "      \"AND fu.snapshot_hash = 'never'))\",",
      },
    ],
  },
  T5M7: {
    what: "the in-flight protection set is never applied",
    scope: [VACUUM_UNIT],
    expected: [T5.protectIds],
    edits: [
      {
        file: VACUUM,
        old: "  for (const id of options.protectSnapshotIds ?? []) pinned.add(id);",
        new: "  // mutant: in-flight protection dropped",
      },
    ],
  },
  T5M8: {
    what: "the sweep wipes `line_id_counters` (ID-reuse invariant broken)",
    scope: [VACUUM_UNIT],
    expected: [T5.countersLeases],
    edits: [
      {
        file: VACUUM,
        old: "      stmts.deleteLineage(id);",
        new: '      db.prepare("DELETE FROM line_id_counters").run();\n      stmts.deleteLineage(id);',
      },
    ],
  },
  T5M9: {
    what: "the overflow warning is deleted (the deferred state is returned, never reported)",
    scope: [VACUUM_UNIT],
    // COUPLING (CP2-r4): cell 29 asserts warned(target) === 1 while the context is retained, so
    // deleting this warning drives that count to 0 — the same warn-count path this site feeds.
    expected: [T5.loudDeferral, T5.reportPayload, T5.reportRearm, T5.reportCap],
    edits: [
      {
        file: VACUUM,
        old:
          "    console.warn(\n" +
          "      `dsh-better-edit: snapshot vacuum soft overflow (${context}): ` +\n" +
          "        `totalBytes=${result.totalBytes} pinnedBytes=${result.pinnedBytes} ` +\n" +
          "        `deferredBytes=${result.deferredBytes} — pinned snapshots are never evicted and this ` +\n" +
          "        `state is expected to lapse as leases expire.`,\n" +
          "    );",
        new: "    // mutant: the deferred state is returned but never reported",
      },
    ],
  },
  T5M10: {
    what: "`line_id_counters.next_id` is ignored (fresh ids restart at 1)",
    scope: [VACUUM_INTERACTION],
    expected: [T5.rematerialize],
    edits: [
      {
        file: LINEAGE_STORE,
        old: "          let fresh = counter === undefined ? 1 : counter.next_id;",
        new: "          let fresh = 1;",
      },
    ],
  },
  T5M11: {
    what: "the lease pin ignores `updated_at`, measured in the interaction corpus",
    scope: [VACUUM_INTERACTION],
    expected: [T5.rematerialize, T5.evictedTarget, T5.rejectNoop, T5.crossTable],
    edits: [
      {
        file: VACUUM,
        old: '      "AND ((sl.retired_at IS NULL AND sl.updated_at >= ?) OR sl.retired_at >= ?)) " +',
        new: '      "AND ((sl.retired_at IS NULL AND ? IS NOT NULL) OR sl.retired_at >= ?)) " +',
      },
    ],
  },
  T5M12: {
    what: "the sweep wipes `served_leases` (pins deleted, not computed)",
    scope: [VACUUM_INTERACTION],
    expected: [T5.evictedTarget],
    edits: [
      {
        file: VACUUM,
        old: "      stmts.deleteSnapshot(id);",
        new: '      db.prepare("DELETE FROM served_leases").run();\n      stmts.deleteSnapshot(id);',
      },
    ],
  },
  T5M13: {
    what: "the `file_undo` undo pin can never match, measured in the interaction corpus",
    scope: [VACUUM_INTERACTION],
    expected: [T5.undoPinSurvives],
    edits: [
      {
        file: VACUUM,
        old: '      "AND fu.snapshot_hash = fs.snapshot_hash))",',
        new: "      \"AND fu.snapshot_hash = 'never'))\",",
      },
    ],
  },
  T5M14: {
    what: "the sweep also deletes the legacy `snapshots` row (D2 breached)",
    scope: [VACUUM_INTERACTION],
    expected: [T5.crossTable, T5.evictedTarget],
    edits: [
      {
        file: VACUUM,
        old: "      stmts.deleteLineage(id);\n      stmts.deleteSnapshot(id);",
        new: '      db.prepare(\n        "DELETE FROM snapshots WHERE path = (SELECT path FROM file_snapshots WHERE snapshot_id = ?)",\n      ).run(id);\n      stmts.deleteLineage(id);\n      stmts.deleteSnapshot(id);',
      },
    ],
  },
  T5M15: {
    what: "the post-materialization trigger swallows its own failure",
    scope: [VACUUM_INTERACTION],
    expected: [T5.triggerFailure],
    edits: [
      {
        file: HASH_STORE,
        old:
          "    } catch (error) {\n" +
          "      console.warn(\n" +
          "        `dsh-better-edit: snapshot vacuum failed after materializing ${path}: ${\n" +
          "          error instanceof Error ? error.message : String(error)\n" +
          "        }`,\n" +
          "      );\n" +
          "    }",
        new: "    } catch {\n      // mutant: the retention failure is swallowed\n    }",
      },
    ],
  },
  // ---- T5 round 2: guards, reports, the pair, the cross-table pin ----
  T5M16: {
    what: "the in-sweep deferral guard is removed (a joined sweep runs)",
    scope: [VACUUM_UNIT],
    expected: [T5.deferral, T5.pairInvariant],
    edits: [
      {
        file: VACUUM,
        old:
          "  if (db.isTransaction) {\n" +
          "    return {\n" +
          "      evicted: 0,\n" +
          "      totalBytes: 0,\n" +
          "      pinnedBytes: 0,\n" +
          "      deferredBytes: 0,\n" +
          "      overSoftOverflow: false,\n" +
          "      skippedInTransaction: true,\n" +
          "    };\n" +
          "  }",
        new: "  // mutant: the in-sweep deferral guard is removed",
      },
    ],
  },
  T5M17: {
    what: "the content-less early return is deleted (a legacy-only write is fed to the sweep)",
    scope: [VACUUM_INTERACTION],
    expected: [T5.legacyOnlyUpsert],
    edits: [
      {
        file: HASH_STORE,
        old: "    if (content === undefined) return;",
        new: "    // mutant: the legacy-only early return is removed",
      },
    ],
  },
  T5M18: {
    what: "the overflow dedup early-return is deleted (warn on every over-budget pass)",
    scope: [VACUUM_UNIT],
    // COUPLING (CP2-r4): without the dedup a retained context warns again, breaking cell 29's
    // count-1 assertion — the same warn-count path this site feeds.
    expected: [T5.reportPayload, T5.reportCap],
    edits: [
      {
        file: VACUUM,
        old: "    if (overflowReported.has(context)) return;",
        new: "    // mutant: the transition-in dedup is removed",
      },
    ],
  },
  T5M19: {
    what: "the throttle re-arm is deleted (an under-budget pass cannot re-arm)",
    scope: [VACUUM_UNIT],
    expected: [T5.reportRearm],
    edits: [
      {
        file: VACUUM,
        old: "      overflowReported.delete(context);",
        new: "      // mutant: the re-arm is removed",
      },
    ],
  },
  T5M20: {
    what: "the materialization trigger stops passing the resolved in-flight id",
    scope: [VACUUM_INTERACTION],
    expected: [T5.inflightProtection],
    edits: [
      {
        file: HASH_STORE,
        old: "        protectId === undefined ? {} : { protectSnapshotIds: [protectId] },",
        new: "        {},",
      },
    ],
  },
  T5M21: {
    what: "the store-open trigger drops the result silently",
    scope: [VACUUM_INTERACTION],
    expected: [T5.reportAtOpen],
    edits: [
      {
        file: STORE_LIFECYCLE,
        old: "    reportVacuum(store.vacuumSnapshots(), `store open ${storePath}`);",
        new: "    store.vacuumSnapshots();",
      },
    ],
  },
  T5M22: {
    what: "the pair delete order is swapped (snapshot before lineage)",
    scope: [VACUUM_UNIT],
    expected: [],
    edits: [
      {
        file: VACUUM,
        old: "      stmts.deleteLineage(id);\n      stmts.deleteSnapshot(id);",
        new: "      stmts.deleteSnapshot(id);\n      stmts.deleteLineage(id);",
      },
    ],
  },
  T5M23: {
    what: "the `file_undo` pin drops its path clause (over-broad pin)",
    scope: [VACUUM_UNIT],
    expected: [T5.overBroadPin],
    edits: [
      {
        file: VACUUM,
        old: '      "OR EXISTS (SELECT 1 FROM file_undo fu WHERE fu.path = fs.path " +',
        new: '      "OR EXISTS (SELECT 1 FROM file_undo fu WHERE 1 = 1 " +',
      },
    ],
  },
  T5M24: {
    what: "the materialization trigger drops the result silently",
    scope: [VACUUM_INTERACTION],
    expected: [T5.reportAtMaterialization],
    edits: [
      {
        file: HASH_STORE,
        old: "      reportVacuum(result, `materialize ${path}`);",
        new: "      // mutant: the trigger drops the result",
      },
    ],
  },
  T5M25: {
    what: "the store-open catch is silenced (the failure disappears)",
    scope: [VACUUM_INTERACTION],
    expected: [T5.openFailure],
    edits: [
      {
        file: STORE_LIFECYCLE,
        old:
          "  } catch (error) {\n" +
          "    console.warn(\n" +
          "      `dsh-better-edit: snapshot vacuum failed at store open for ${storePath}: ${error instanceof Error ? error.message : String(error)}`,\n" +
          "    );\n" +
          "  }",
        new: "  } catch {\n    // mutant: the store-open failure is swallowed\n  }",
      },
    ],
  },
  T5M26: {
    what: "the explicit lineage delete is dropped (cascade-masked, P1 meaning 4)",
    scope: [VACUUM_UNIT],
    expected: [],
    edits: [
      {
        file: VACUUM,
        old: "      stmts.deleteLineage(id);\n      stmts.deleteSnapshot(id);",
        new: "      stmts.deleteSnapshot(id);",
      },
    ],
  },
  T5M27: {
    what: "the sweep's transaction wrapper is removed (same-file rollback lost)",
    scope: [VACUUM_UNIT],
    expected: [T5.deferral, T5.pairInvariant, T5.crashMidPair],
    edits: [
      {
        file: VACUUM,
        old:
          "  withTransaction(db, () => {\n" +
          "    for (const id of snapshotIds) {\n" +
          "      stmts.deleteLineage(id);\n" +
          "      stmts.deleteSnapshot(id);\n" +
          "    }\n" +
          "  });",
        new:
          "  for (const id of snapshotIds) {\n" +
          "    stmts.deleteLineage(id);\n" +
          "    stmts.deleteSnapshot(id);\n" +
          "  }",
      },
    ],
  },
  T5M28: {
    what: "`getSnapshot`'s lineage-first branch is disabled (the legacy row serves)",
    scope: [VACUUM_INTERACTION],
    expected: [], // GREEN: the serve write's re-materialization covers the disabled branch
    edits: [
      {
        file: HASH_STORE,
        old: "        lineage.length === splitLines(content).length &&",
        new: "        lineage.length === -1 &&",
      },
    ],
  },
  T5M29: {
    what: "the serve write stops materializing the v7 family (serve-write dependency)",
    scope: [VACUUM_INTERACTION],
    expected: [T5.rematerialize, T5.evictedTarget, T5.undoPinSurvives, T5.reportAtMaterialization],
    edits: [
      {
        file: SESSION_VIEW,
        old: "  internal.commitSnapshot({ path, content, hashes: [...hashes], leases: { sessionKey, rows } });",
        new: "  // mutant: the serve write stops materializing the v7 family",
      },
    ],
  },
  T5M30: {
    what: "the report ledger never evicts (the cap check is disabled)",
    scope: [VACUUM_UNIT],
    expected: [T5.reportCap],
    edits: [
      {
        file: VACUUM,
        old: "  if (ledger.size >= REPORT_CONTEXT_CAP) {",
        new: "  if (false) {",
      },
    ],
  },
};

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function fail(message) {
  console.error(`mutate-ledger: ${message}`);
  process.exit(1);
}

function usage() {
  console.log("usage: node test/tools/mutate-ledger.mjs --list");
  console.log(
    "       node test/tools/mutate-ledger.mjs <id> [--full] [--keep] [--expect-rev=<sha>]",
  );
  console.log("");
  console.log(`ids: ${Object.keys(MUTANTS).join(", ")}`);
  console.log("");
  console.log(`T3h expected RED sets measured at ${VERIFIED_AT}; T4 (T4M*) at ${T4_VERIFIED_AT};`);
  console.log("so a drifted tree fails at the anchor check rather than silently mis-running.");
}

function listMutants() {
  const width = Math.max(...Object.keys(MUTANTS).map((id) => id.length));
  console.log(`T3h ledger measured at ${VERIFIED_AT}`);
  console.log(`T4 ledger measured at ${T4_VERIFIED_AT}`);
  console.log(`T4 r3 ledger measured at ${R3_VERIFIED_AT}`);
  for (const [id, m] of Object.entries(MUTANTS)) {
    const scope = m.scope ? m.scope.join(",") : "--full (full suite)";
    console.log(`${id.padEnd(width)}  RED=${m.expected.length}  scope=${scope}  ${m.what}`);
  }
}

function assertCleanAndGetRevision(expectRev) {
  const rev = run("git", ["-C", REPO, "rev-parse", "HEAD"]).stdout.trim();
  console.log(`revision ${rev}`);
  if (expectRev && expectRev !== rev) {
    fail(`--expect-rev=${expectRev} but HEAD is ${rev}`);
  }
  const status = run("git", [
    "-C",
    REPO,
    "status",
    "--porcelain",
    "--",
    "src",
    "test",
    "docs",
  ]).stdout.trim();
  if (status !== "") {
    fail(`refusing to run: src/test/docs is dirty\n${status}`);
  }
  console.log("worktree clean (src test docs)");
  return rev;
}

function makeTree() {
  const base = mkdtempSync(join(tmpdir(), "mutate-ledger-"));
  const tree = join(base, "tree");
  const tar = join(base, "head.tar");
  const archive = run("git", ["-C", REPO, "archive", "HEAD", "-o", tar]);
  if (archive.status !== 0) fail(`git archive failed: ${archive.stderr}`);
  const extract = run("mkdir", ["-p", tree]);
  if (extract.status !== 0) fail(`mkdir failed: ${extract.stderr}`);
  const untar = run("tar", ["-xf", tar, "-C", tree]);
  if (untar.status !== 0) fail(`tar failed: ${untar.stderr}`);
  symlinkSync(join(REPO, "node_modules"), join(tree, "node_modules"));
  console.log(`archived HEAD -> ${tree}`);
  return { base, tree };
}

function applyMutant(tree, id, mutant) {
  for (const edit of mutant.edits) {
    const target = join(tree, edit.file);
    const text = readFileSync(target, "utf8");
    const count = text.split(edit.old).length - 1;
    if (count !== 1) {
      fail(
        `${id} ${edit.file}: anchor count ${count} (expected exactly 1) — tree or recipe drifted`,
      );
    }
    writeFileSync(target, text.replace(edit.old, edit.new));
  }
  console.log(`applied ${id}`);

  for (const edit of mutant.edits) {
    const oldLines = edit.old.split("\n");
    const inserted = edit.new
      .split("\n")
      .filter((line) => line.trim() !== "" && !oldLines.includes(line));
    const marker = inserted[0] ?? edit.new.split("\n")[0];
    const hit = run("grep", ["-n", "-F", marker, join(tree, edit.file)]);
    const found = hit.stdout.trim().split("\n").filter(Boolean);
    if (found.length === 0) fail(`${id}: mutated line not found back in ${edit.file}`);
    for (const line of found) console.log(`mutated line ${edit.file}:${line}`);
  }
}

function vitestCommand(tree) {
  const local = join(tree, "node_modules", ".bin", "vitest");
  return existsSync(local) ? { cmd: local, prefix: [] } : { cmd: "npx", prefix: ["vitest"] };
}

function parseVitest(output) {
  const summary = { testFiles: null, tests: null };
  const failing = [];
  for (const raw of output.split("\n")) {
    const files = raw.match(/^\s*Test Files\s+(.*\S)\s*$/);
    if (files && summary.testFiles === null) summary.testFiles = files[1];
    const tests = raw.match(/^\s*Tests\s+(.*\S)\s*$/);
    if (tests && summary.tests === null) summary.tests = tests[1];
    const cell = raw.match(/^\s*[×✕]\s+(.*\S)$/);
    if (cell) {
      const body = cell[1].replace(/\s+\d+(?:\.\d+)?m?s$/, "");
      const segments = body.split(" > ");
      failing.push({ path: body, title: segments[segments.length - 1] });
    }
  }
  return { summary, failing };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) return usage();
  if (argv.includes("--list")) return listMutants();

  const id = argv.find((a) => !a.startsWith("-"));
  if (!id) {
    usage();
    process.exit(2);
  }
  const mutant = MUTANTS[id];
  if (!mutant) fail(`unknown id "${id}" (known: ${Object.keys(MUTANTS).join(", ")})`);

  const expectRevArg = argv.find((a) => a.startsWith("--expect-rev="));
  const forceFull = argv.includes("--full");
  const keep = argv.includes("--keep");
  const scope = forceFull || mutant.scope === null ? [] : mutant.scope;

  assertCleanAndGetRevision(expectRevArg ? expectRevArg.split("=")[1] : null);

  const { base, tree } = makeTree();
  try {
    applyMutant(tree, id, mutant);

    const { cmd, prefix } = vitestCommand(tree);
    const args = [...prefix, "run", ...scope, "--reporter=verbose"];
    console.log(`running: ${cmd} ${args.join(" ")}   (cwd=${tree})`);
    const result = run(cmd, args, { cwd: tree, maxBuffer: 64 * 1024 * 1024 });
    const output = `${result.stdout}${result.stderr}`;
    if (result.stdout) writeFileSync(join(base, `log-${id}.txt`), output);

    const { summary, failing } = parseVitest(output);
    console.log(`summary Test Files: ${summary.testFiles ?? "(not parsed)"}`);
    console.log(`summary Tests: ${summary.tests ?? "(not parsed)"}`);
    console.log(`failing cells (${failing.length}):`);
    for (const cell of failing) console.log(`  - ${cell.title}`);

    const got = failing.map((cell) => cell.title);
    const missing = mutant.expected.filter((title) => !got.includes(title));
    const extra = got.filter((title) => !mutant.expected.includes(title));
    if (missing.length === 0 && extra.length === 0 && failing.length === mutant.expected.length) {
      console.log(`RED SET MATCH (${failing.length}/${mutant.expected.length})`);
      if (mutant.caveat) console.log(`caveat: ${mutant.caveat}`);
      return;
    }
    console.log(`RED SET MISMATCH (got ${failing.length}, expected ${mutant.expected.length})`);
    for (const title of missing) console.log(`  missing: ${title}`);
    for (const title of extra) console.log(`  unexpected: ${title}`);
    console.log(`log: ${join(base, `log-${id}.txt`)}`);
    process.exitCode = 1;
  } finally {
    if (!keep) {
      const link = join(tree, "node_modules");
      if (existsSync(link)) unlinkSync(link);
      rmSync(base, { recursive: true, force: true });
    } else {
      console.log(`kept ${base}`);
    }
  }
}

main();
