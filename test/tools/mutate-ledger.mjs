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
const SERVED_GUARD = "src/hashline/served-guard.ts";
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
  // `nullRowGate` retired here: FU-3 (edc516d, upstream ADR-0024 decision 1) turned the
  // null-row-in-window rejection into an ACCEPTANCE cell, so no cell under this title can
  // redden; the acceptance is pinned by "accepts an unread interior row between two leased
  // boundaries" and the direct-call gate arms stay pinned separately.
  lengthDisagree: "rejects a window whose served and rebased lengths disagree",
  // FU-5 re-anchor: the producers landed in src/hashline/served-guard.ts (ADR-0025
  // amendment); the guard-holds cells flipped to producer-present conjunctions, and
  // the mutants below flipped from PLANT a producer to DELETE one.
  neverGuard: "W_NEVER_SERVED_SHAPE is a union member with a literal producer (FU-5)",
  mismatchGuard: "W_SERVED_PREFIX_MISMATCH is a union member with a literal producer (FU-5)",
  deferredRefute:
    "the deferred predicates refute a constant: their own code falsifies, others do not",
  orderIndependence:
    "the witness is per-call: a different source set yields a different witness and verdicts",
  // `deletedExternally` retired here: FU-4 renamed the cell to "rejects E_TARGET_LOST …" and the
  // rejection no longer routes through the `E_STALE_RANGE` formatter, so T6M1 cannot redden it.
  // The retry-affordance ban is still pinned by T4.spanLength, T6.regionOracle and the E_TARGET_LOST
  // cell's own `not.toContain(Retry with these anchors)` assertion.
};

/**
 * P0-63 cell titles (issue #63 write-through; FU-5 added the warning-path pin).
 * The treatment cell asserts the rendered `[W_NEVER_SERVED_SHAPE]` header in the
 * tool response, so deleting the producer reddens it end-to-end (T6M3).
 */
const P063 = {
  neverHint:
    "writes 0-matched literal `abc│text`/`KEY│value` through unchanged (treatment, acceptance criterion 1)",
};

/**
 * FU-R cell titles (upstream aggregation seam + literal format pins,
 * served-guard-warning-stages.test.ts). The two engine cells ride the per-call hint
 * rendering, so T6M3 reddens them end-to-end; the three format pins call their
 * builder directly, so each reddens only under its own code's deletion (the
 * per-code isolation T6M5 already proves for the producer cells).
 */
const FUR = {
  singularPin: "the count===1 arm of neverServedShapeFormat renders the singular body verbatim",
  pluralPin: "the plural arm of neverServedShapeFormat renders the counted body verbatim",
  mismatchPin: "servedPrefixMismatchFormat renders the k/anchor/servedLine body verbatim",
  engineSingle: "reports success with one counted hint and keeps file bytes verbatim",
  engineMirror: "emits exactly one hint for the whole call when 2 batch items offend",
};

/**
 * T6b cell titles (ADR-0023: multi-region interaction on sequential windowed reads).
 * Both assert an `E_STALE_RANGE` payload through `assertRegionPayload`, so both redden under
 * `T6M1` — measured 2026-09-25, re-pointed in the same commit that added them.
 */
const T6b = {
  overlap:
    "overlapping windowed reads: an anchor pair spanning the overlap scopes the payload to the resolved region (R13)",
  disjoint:
    "disjoint windowed reads: an anchor pair inside window A excludes window B's rows (R14)",
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
      T6.lengthDisagree,
      T6.regionOracle,
      T6.formatterHint,
      // T6b (ADR-0023): the two multi-region cells assert their E_STALE_RANGE payloads through
      // `assertRegionPayload`, which bans the restored affordance — measured 3/3 in this file.
      // FU-4 re-measure (b65d437): dropped `nullRowGate` (cell turned into an acceptance by
      // FU-3) and `deletedExternally` (cell renamed and rerouted to E_TARGET_LOST) — 6/6.
      T6b.overlap,
      T6b.disjoint,
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
    what: "delete the REAL W_NEVER_SERVED_SHAPE producer from served-guard — the landed code must be refutable (FU-5 re-anchor; per-code isolation: the mismatch guard stays green)",
    scope: null, // full suite
    // FU-5 flipped plant→delete: the deferral is gone, so adding a producer reddens
    // nothing — the refuting mutation is removing the real one. Reddens totality
    // forward (union member with neither producer nor deferral), the producer-present
    // cell, the witness cell's live-tree conjunctions, and the p063 response pin.
    // FU-R re-point: the engine now renders the one per-call hint, so the two batch
    // engine cells and the two singular/plural format pins ride the same builder —
    // measured at the FU-R commit (got 8, expected 4 → 8).
    expected: [
      T4R3.forward,
      T6.neverGuard,
      T6.orderIndependence,
      P063.neverHint,
      FUR.singularPin,
      FUR.pluralPin,
      FUR.engineSingle,
      FUR.engineMirror,
    ],
    edits: [
      {
        file: SERVED_GUARD,
        old: '  return `${formatWarning("W_NEVER_SERVED_SHAPE", { count: args.count })} ${ANCHOR_PREFIX_REMEDY}`;',
        new: "  return ANCHOR_PREFIX_REMEDY;",
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
    what: "delete the W_SERVED_PREFIX_MISMATCH producer ONLY — per-code isolation (W_NEVER_SERVED_SHAPE's producer-present cell must stay green)",
    scope: null, // full suite
    // FU-5 re-anchor (see T6M3): plant→delete. The p063 pin rides the never-served
    // header only, so it stays green here — that asymmetry IS the isolation proof.
    // FU-R re-point: the mismatch format pin joins (the never-served pins stay green,
    // extending the same asymmetry to the FU-R cells; measured got 4, expected 3 → 4).
    expected: [T4R3.forward, T6.mismatchGuard, T6.orderIndependence, FUR.mismatchPin],
    edits: [
      {
        file: SERVED_GUARD,
        old:
          '  return `${formatWarning("W_SERVED_PREFIX_MISMATCH", {\n' +
          "    k: args.k,\n" +
          "    anchor: args.anchor,\n" +
          "    servedLine: args.servedLine,\n" +
          "  })} ${ANCHOR_PREFIX_REMEDY}`;",
        new: "  return ANCHOR_PREFIX_REMEDY;",
      },
    ],
  },
  M6: {
    what: "re-add E_FOREIGN_ANCHOR to DEFERRED_PRODUCERS as a bare rot-marker string",
    scope: null, // full suite
    // `T6.orderIndependence` renamed in CP3 (the old title claimed a property its re-read could
    // not falsify); M6 no longer reddens the renamed cell — its loop dereferences named codes.
    // FU-4 re-measure: `E_FOREIGN_ANCHOR` is a real ported code with a producer now, so the
    // marker refutes through `totality backward` and the constant-refutation pin; the
    // stays-deleted cell no longer fires for a code whose producer exists (measured at b65d437).
    // FU-5 re-anchor: DEFERRED_PRODUCERS is now EMPTY (both producers landed), so the marker
    // plants into the empty map; `totality backward`'s identity pin ({} vs the planted entry)
    // and the dereferencing loop still redden.
    expected: [T4R3.backward, T6.deferredRefute],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old: "export const DEFERRED_PRODUCERS: Readonly<Record<string, AllowlistEntry>> = {};",
        new:
          "export const DEFERRED_PRODUCERS: Readonly<Record<string, AllowlistEntry | string>> = {\n" +
          '  E_FOREIGN_ANCHOR: "range-family ticket (leases)",\n' +
          "};",
      },
    ],
  },
  // M7 retired here: its subject was re-adding `E_TARGET_LOST` as a union member with no
  // producer and no deferral — FU-4 ports the code WITH a producer (anchor-pipeline.ts:703),
  // so the scenario no longer exists. Re-anchoring it to a fictional member would duplicate
  // M14 (declared-without-registry-entry); the unproduced-member guard stays pinned by
  // T4R3.forward's own cell.
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
        // Re-anchored by FU-4: the union now carries the ported codes between E_STALE_RANGE
        // and E_MALFORMED_ANCHOR, so the insertion point moved with the neighbor.
        file: DOMAIN_ERRORS,
        old: '  | "E_STALE_RANGE"\n  | "E_TARGET_LOST"',
        new: '  | "E_STALE_RANGE"\n  | "E_ORPHAN"\n  | "E_TARGET_LOST"',
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
  // M17 retired here: FU-5 landed both W_* producers and emptied DEFERRED_PRODUCERS, so no live
  // `holds(fired)` predicate remains to caricature (its anchor — the W_NEVER_SERVED_SHAPE
  // predicate line — is gone with the deferral). The predicate mechanism's refutability stays
  // pinned by M6 (rot-marker through backward + deferredRefute) and the generic loop cells in
  // test/arch/domain-error-registry.test.ts; re-anchoring would mean inventing a deferral that
  // does not exist. R15's real mutant is now T6M3's producer deletion.
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
    // FU-8 sweep re-anchor: FU-4 (b65d437) flipped cell 11 to the lease-boundary interception —
    // the evicted edit now fails closed where identity is checked before any snapshot row is
    // consulted, so deleting the legacy row no longer changes its outcome (measured 1/1 at
    // a2b211d). `evictedTarget` stays refutable through T5M29; D2 itself is still directly
    // refuted here by `crossTable` (its legacy-row-count assertion fails under this mutant).
    expected: [T5.crossTable],
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
    expected: [], // GREEN (meaning 4 — the mutation applies and TWO mechanisms cover its effect): `withTransaction` (src/snapshot-store/vacuum.ts:323) makes the pair atomic, and `ON DELETE CASCADE` (src/snapshot-store/lineage-store.ts:161) removes the lineage rows together with the snapshot. Row-count matrix measured on the pair's own DDL/SQL, kept-vs-dropped x FK-ON/FK-OFF: FK-ON baseline removes [lineage 2, snapshot 1], swapped removes [snapshot 1, lineage 0] — different work, identical final set {snapshots 0, lineage 0, orphans 0}; FK-OFF both orders give the same final set, because two DELETEs on different tables commute. The order IS load-bearing, but only for a crash mid-pair with no transaction wrapper AND FKs off, which leaves 2 orphan lineage rows the adopt path cannot repair (it keys on the snapshot row, so an orphan snapshot self-heals while an orphan lineage does not). No shipped opener configures that: `PRAGMA foreign_keys` measures 1, and `enableForeignKeyConstraints:false` / `PRAGMA foreign_keys = OFF` have 0 hits in src/. NOT meaning 1 — no cell is missing; under every configuration the product builds, the swapped order has no observable effect.
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
    expected: [], // GREEN (meaning 4 — `what` claimed cascade-masking; this is the count that proves it): dropping the explicit `deleteLineage` leaves FK-ON removing [snapshot 1] and landing on {snapshots 0, lineage 0, orphans 0}, the identical final set the baseline reaches via [lineage 2, snapshot 1], because `ON DELETE CASCADE` (src/snapshot-store/lineage-store.ts:161) does the lineage work itself. The deleted line is NOT vestigial — under FK-OFF the same mutation lands on {snapshots 0, lineage 2, orphans 2}, so the explicit delete is the belt to the cascade's braces and the mutation's effect is real wherever foreign keys are disabled. It is GREEN here only because no shipped opener disables them: `PRAGMA foreign_keys` measures 1 (src/hash-store.ts:549 sets it ON and `node:sqlite` defaults it ON), and `enableForeignKeyConstraints:false` / `PRAGMA foreign_keys = OFF` have 0 hits in src/. NOT meaning 1 — the cell that would redden this needs an FK-OFF store the product never constructs.
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
  R2M1: {
    what: "#62 alignment gate removed — pseudo-previous rebuilt from a holed served mirror (drift returns)",
    scope: [
      "test/core/hashline-p061-canon-fallback.test.ts",
      "test/core/hashline-p062-partial-read-anchor-stability.test.ts",
    ],
    expected: [
      "resolves the old line-9 anchor via the served path and applies AT line 9 after an interleaved windowed read (steps a–d, re-pinned)",
      "keeps every line-8–14 anchor stable across interleaved partial reads, file byte-identical (steps 1–5)",
      "non-regression: after the 5-step sequence, freshest anchors still edit (repeated-canon line) and stale anchors still reject (issue #62 acceptance)",
    ],
    edits: [
      {
        file: "src/read-and-serve.ts",
        old: "if (servedForNorm.every((h) => h !== null)) {",
        new: "if (servedForNorm.some((h) => h !== null)) {",
      },
    ],
  },
  RX1M1: {
    what: "invert the leased route's interior-hole rule in `acceptsInteriorHole` — boundaries accepted, holes rejected (the RX-1 flip-test, made durable)",
    scope: null, // full suite
    // Measured at the RX-1 commit: the RED set is exactly the interior-hole family — the gate's
    // accept/boundary arms and the end-to-end hole cell (lease-resolve-seam), the C2 leased-route
    // truth (range-family-retry-truth), the three conjunction cells (served-evidence-route), and
    // the multi-window span cell whose edit crosses an unserved gap (read-windows). 8/8.
    expected: [
      "accepts an unread interior row between two leased boundaries (upstream ADR-0024 decision 1)",
      "accepts the same hole end-to-end through verifyServedRange with a lease source",
      "rejects a never-served boundary row — a two-row window is all boundary (decision 1 keeps it fail-closed)",
      "never-served interior edit applies on the leased route (C2, flipped by FU-3)",
      "interior-hole conjunction: the gate accepts an interior null and verifies the boundary leases",
      "interior-hole conjunction: the gate rejects a null end-boundary — the named anchor stays fail-closed",
      "interior-hole conjunction: the leased route accepts a holed window end-to-end",
      "serves anchors from every window so one edit can span them",
    ],
    edits: [
      {
        file: ANCHOR_PIPELINE,
        old: '  return route.kind === "leased" && k !== 0 && k !== servedLen - 1;',
        new: '  return route.kind === "leased" && (k === 0 || k === servedLen - 1);',
      },
    ],
  },
  RX2M1: {
    what: "relax the shifted-survivor arm — one stale bound serves E_UNVERIFIED_RANGE even when the survivor moved (CRUX-P2-1 refuter)",
    scope: null, // full suite
    // Measured at the RX-2 commit: the geometry (one stale + shifted-live survivor) is
    // refuted exactly by the ported upstream cell; no other full-suite path reaches
    // `exactlyOneStale && !survivorLiveUnshifted`. 1/1.
    expected: ["emits E_TARGET_LOST when the live bound shifted (one stale, one moved)"],
    edits: [
      {
        file: ANCHOR_PIPELINE,
        old: "    if (exactlyOneStale && survivorLiveUnshifted) {",
        new: "    if (exactlyOneStale) {",
      },
    ],
  },
  RX3M1: {
    what: "silence the identity-read degrade signal — restore the silent fail-open catch (KEEL K-1 refuter)",
    scope: null, // full suite
    // The mutate-ledger anchor is the whole catch block; the mutation removes the report call
    // and the binding (behavior unchanged — only the signal goes). Measured at the RX-3
    // commit: both K-1 cells ride the warn assertion; the edit itself still applies under
    // either code, so no other full-suite cell moves. 2/2.
    expected: [
      "warns exactly once per file on the first degrade and stays silent on repeats",
      "the edit still applies under the degrade — signal added, behavior unchanged",
    ],
    edits: [
      {
        file: ENGINE,
        old:
          "  } catch (cause) {\n" +
          "    reportIdentityDegrade(absolutePath, cause);\n" +
          "    return undefined;\n" +
          "  }",
        new: "  } catch {\n    return undefined;\n  }",
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
