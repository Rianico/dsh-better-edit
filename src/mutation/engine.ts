/**
 * @internal — private to Mutation seam. Do not import from outside src/mutation.
 * The edit-sequence engine private to Mutation:
 * apply-one-edit against in-memory content with served verification and the
 * multi-edit sequencer that drives a whole file's item list against evolving
 * content, the noop-loop guard, and the persist-undo → write → restore
 * Transaction (persist-undo → write → restore) is owned by Mutation, not this engine.
 *
 * The model-facing contract lives here unchanged: E_BATCH_ABORT,
 * E_NOOP_LOOP, E_UNDO_UNAVAILABLE carry byte-identical messages, and
 * reject-and-serve records the same echo serves.
 * @module dsh-better-edit/mutation/engine
 */

import type { FileIO } from "../fs-bridge.js";
import { loadHashStore, type HashStore, type InternalHashStore } from "../hash-store.js";
import { snapshotHashFor } from "../snapshot-store/lineage-store.js";
import type { LineEnding } from "../edit-diff.js";
import { loadConfig } from "../store-config.js";
import { canon } from "../hashline/hash-assign.js";
import { normFromText } from "../file-reader.js";
import {
  scanDrift,
  loadServed,
  loadServedCanons,
  loadRetiredAnchors,
  retireAnchors,
} from "../session-view.js";
import {
  applyEdit,
  resEdit,
  parseHashRef,
  type HEdit,
  type NEdit,
  type LeaseSpanSource,
} from "../hashline/anchor-pipeline.js";
import { lineHashes } from "../hashline/hash.js";
import { AnchorSpaceExhaustedError, HASH_SPACE } from "../hashline/hash-assign.js";

function isAnchorSpaceExhausted(e: unknown): boolean {
  return (
    e instanceof AnchorSpaceExhaustedError ||
    (e instanceof Error && e.message.includes("probing failed over"))
  );
}

function promotionWarning(retiredSize: number, servedLen: number): string {
  // Soft promotion notice: plain non-header text (no [E_] code, no audience).
  // The hard capacity refusal routes through E_LARGE_FILE (hash-space).
  return `Anchor space exhausted (retired ${retiredSize} + served ${servedLen} of ${HASH_SPACE}); promotion cleared retired — re-read recommended, stale-anchor checks degraded until next full read.`;
}

async function clearRetiredForPromotion(
  sessionKey: string | undefined,
  absolutePath: string,
): Promise<void> {
  try {
    const { loadServedStore } = await import("../hash-store.js");
    const store = await loadServedStore();
    store.clearRetiredAnchors(sessionKey ?? "", absolutePath);
    try {
      store.clearCards(sessionKey ?? "", absolutePath);
    } catch {}
  } catch {}
}

async function retryLineHashesWithPromotion(
  sessionKey: string | undefined,
  absolutePath: string,
  retired: ReadonlySet<string> | undefined,
  served: readonly (string | null)[] | undefined,
  warnings: string[],
  fn: (reserved: Set<string>, retired: Set<string>) => Promise<string[]>,
): Promise<string[]> {
  await clearRetiredForPromotion(sessionKey, absolutePath);
  const servedLen = served?.filter((h): h is string => h !== null).length ?? 0;
  warnings.push(promotionWarning(retired?.size ?? 0, servedLen));
  const recomputed = new Set<string>(
    (served?.filter((h): h is string => h !== null) ?? []) as string[],
  );
  try {
    return await fn(recomputed, new Set<string>());
  } catch (e2: unknown) {
    if (isAnchorSpaceExhausted(e2))
      throw new DomainError("E_LARGE_FILE", { limitKind: "hash-space", limit: HASH_SPACE });
    throw e2;
  }
}
import { MAX_HASH_LINES } from "../hashline/hash-assign.js";
import {
  AnchorMismatchError,
  ServedRejectionError,
  buildRangeEcho,
  fmtServedRows,
  recordEchoServes,
  type ResolvedRange,
  type ServeRecordPolicy,
  type ServedRow,
} from "../hashline/anchor-pipeline.js";
import { DomainError, formatError, formatWarning } from "../domain-errors.js";
import type { RangeCause } from "../domain-errors.js";
import type { EditMode } from "../contract.js";
import { findSnapshotPathsByHashes } from "../hash-store.js";
import { clearNoopLoop, noopPayloadKey, trackNoopPayload } from "../noop-guard.js";
import { NOOP_LOOP_THRESHOLD } from "../constants.js";
import { abortIf, splitLines } from "../utils.js";

// ---------------------------------------------------------------------------
// shared types

export interface PreparedItem {
  index: number;
  file: string;
  absolutePath: string;
  anchor_from: string;
  anchor_to: string;
  replace_with: string;
  fileWarning?: string;
  /** Request-level edit mode ("general" default, "literal" bypasses served-echo). */
  mode?: EditMode;
}

export interface FileEditResult {
  displayPath: string;
  absolutePath: string;
  originalNormalized: string;
  result: string;
  bom: string;
  originalEnding: LineEnding;
  hadUtf8DecodeErrors: boolean;
  warnings: string[];
  originalHashes: string[];
  resultHashes: string[];
  appliedCount: number;
  noopCount: number;
  totalAddedLines: number;
  totalRemovedLines: number;
  driftNotice: string | undefined;
  range: ResolvedRange;
}

// ---------------------------------------------------------------------------
// request / counting helpers shared by both tool paths

/**
 * Resolve a request's missing `path` from its anchors: the only file whose
 * stored hashes contain both anchors. Returns the path plus an autocorrect
 * warning, or undefined when no resolution is possible.
 */
export async function resolveMissingPath(
  request: Record<string, unknown>,
): Promise<{ path: string; warning: string } | undefined> {
  if (typeof request.path === "string") return undefined;
  const from = request.anchor_from;
  const to = request.anchor_to;
  if (typeof from !== "string" || typeof to !== "string") return undefined;
  const hashes: string[] = [];
  for (const ref of [from, to]) {
    try {
      hashes.push(parseHashRef(ref).hash);
    } catch {
      return undefined;
    }
  }
  let matches: string[];
  try {
    matches = await findSnapshotPathsByHashes(hashes);
  } catch {
    return undefined;
  }
  if (matches.length === 1) {
    return {
      path: matches[0]!,
      warning: formatError("E_BAD_PAYLOAD", {
        message: `Autocorrected: missing "path" resolved to ${matches[0]} — the only file whose stored hashes contain both anchors.`,
      }),
    };
  }
  if (matches.length > 1) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `Edit request requires a non-empty "path" string; the anchors match multiple known files: ${matches.join(", ")}. Include the intended path.`,
    });
  }
  return undefined;
}

/** The hashes a range edit removes, for stable re-hash bookkeeping. */
export function collectRemovedHashes(edit: HEdit, originalHashes: string[]): Set<string> {
  const removedHashes = new Set<string>();
  const startHash = edit.hash_bounds[0].hash;
  const endHash = edit.hash_bounds[1].hash;
  const startLine = originalHashes.indexOf(startHash);
  const endLine = originalHashes.indexOf(endHash);
  if (startLine >= 0 && endLine >= 0) {
    const firstLine = Math.min(startLine, endLine);
    const lastLine = Math.max(startLine, endLine);
    for (let i = firstLine; i <= lastLine; i++) {
      removedHashes.add(originalHashes[i]!);
    }
  }
  return removedHashes;
}

/** Added/removed line counts for one resolved edit against a file's original hashes. */
export function countLineChanges(
  edit: HEdit,
  originalHashes: string[],
  isNoop: boolean,
  removedAutoFixes: number,
): { totalAddedLines: number; totalRemovedLines: number } {
  if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 };
  let totalRemovedLines = 0;
  const startLine = originalHashes.indexOf(edit.hash_bounds[0].hash);
  const endLine = originalHashes.indexOf(edit.hash_bounds[1].hash);
  if (startLine >= 0 && endLine >= 0) {
    totalRemovedLines = Math.abs(endLine - startLine) + 1;
  }
  return {
    totalAddedLines: Math.max(0, edit.content_lines.length - removedAutoFixes),
    totalRemovedLines,
  };
}

// ---------------------------------------------------------------------------
// apply-one

export interface ApplyOneInput {
  content: string;
  hashes: string[];
  served: (string | null)[];
  anchorFrom: string;
  anchorTo: string;
  replaceWith: string;
  absolutePath: string;
  displayPath: string;
  signal?: AbortSignal;
  /** Shared warnings array; resEdit warnings are pushed here. */
  warnings: string[];
  /**
   * The hashes to count added/removed lines against. Defaults to `hashes`;
   * the batch sequencer passes the file's ORIGINAL hashes so later edits in
   * a sequence still count against the file as first served.
   */
  countHashes?: string[];
  store?: HashStore;
  persist: boolean;
  reservedHashes?: ReadonlySet<string>;
  servedCanons?: (string | null)[];
  retired?: ReadonlySet<string>;
  /** Request-level edit mode ("general" default, "literal" bypasses served-echo). */
  mode?: EditMode;
  /**
   * The lease-identity source for this item's buffer. Present => the identity gate replaces the
   * position check; absent => the unconditional position check (preview/no-store).
   */
  leaseSource?: LeaseSpanSource;
  sessionKey?: string;
  /** Pre-resolved edit (single path keeps resEdit before IO for error order). */
  edit?: HEdit;
}

export interface ApplyOneResult {
  result: string;
  /** Stable re-hash after the edit (equals `hashes` for a noop). */
  hashes: string[];
  range: ResolvedRange;
  noop: boolean;
  edit: HEdit;
  noopEdit?: NEdit;
  firstChangedLine?: number;
  lastChangedLine?: number;
  removedHashes: Set<string> | undefined;
  totalAddedLines: number;
  totalRemovedLines: number;
  anchorWarnings: string[] | undefined;
}

/**
 * One edit against in-memory content: resolve (unless a pre-resolved edit was
 * given) → apply with served verification → stable re-hash → line counts.
 *
 * `onReject` owns the reject-and-serve policy: it receives resolve/verify
 * failures (and the edit that failed, when resolved) and MUST throw. The
 * single path rethrows the original anchor error after recording echo serves;
 * the batch path wraps with E_BATCH_ABORT plus the current-range echo.
 */
export async function applyOne(
  input: ApplyOneInput,
  onReject: (error: unknown, edit: HEdit | undefined) => Promise<never>,
): Promise<ApplyOneResult> {
  let edit: HEdit;
  if (input.edit) {
    edit = input.edit;
  } else {
    try {
      edit = resEdit(
        {
          anchor_from: input.anchorFrom,
          anchor_to: input.anchorTo,
          replace_with: input.replaceWith,
        },
        input.warnings,
      );
    } catch (error) {
      return onReject(error, undefined);
    }
  }

  const retiredForApply = input.retired;
  let anchorResult: ReturnType<typeof applyEdit>;
  try {
    anchorResult = applyEdit(
      input.content,
      edit,
      input.signal,
      input.hashes,
      input.displayPath,
      input.served,
      input.servedCanons,
      retiredForApply,
      input.mode,
      input.leaseSource,
    );
  } catch (error) {
    if (error instanceof AnchorMismatchError || error instanceof ServedRejectionError) {
      return onReject(error, edit);
    }
    throw error;
  }

  const result = anchorResult.content;
  const noop = result === input.content;
  const removedHashes = noop ? undefined : collectRemovedHashes(edit, input.hashes);
  const retiredForHash = input.retired;
  let resultHashes: string[];
  if (noop) {
    resultHashes = input.hashes;
  } else {
    try {
      resultHashes = await lineHashes(
        result,
        input.absolutePath,
        {
          content: input.content,
          hashes: input.hashes,
          removedHashes,
        },
        input.store,
        input.persist,
        input.reservedHashes,
        retiredForHash,
      );
    } catch (e: unknown) {
      if (!isAnchorSpaceExhausted(e)) throw e;
      resultHashes = await retryLineHashesWithPromotion(
        input.sessionKey,
        input.absolutePath,
        retiredForHash,
        input.served,
        input.warnings ?? [],
        (recomputed, emptyRetired) =>
          lineHashes(
            result,
            input.absolutePath,
            {
              content: input.content,
              hashes: input.hashes,
              removedHashes,
            },
            input.store,
            input.persist,
            recomputed,
            emptyRetired,
          ),
      );
    }
  }
  const { totalAddedLines, totalRemovedLines } = countLineChanges(
    edit,
    input.countHashes ?? input.hashes,
    noop,
    0,
  );

  return {
    result,
    hashes: resultHashes,
    range: anchorResult.range,
    noop,
    edit,
    noopEdit: anchorResult.noopEdit,
    firstChangedLine: anchorResult.firstChangedLine,
    lastChangedLine: anchorResult.lastChangedLine,
    removedHashes,
    totalAddedLines,
    totalRemovedLines,
    anchorWarnings: anchorResult.warnings,
  };
}

// ---------------------------------------------------------------------------
// noop-loop guard

export interface NoopLoopOptions {
  absolutePath: string;
  anchorFrom: string;
  anchorTo: string;
  replaceWith: string;
  displayPath: string;
  /** Batch item index; undefined = single-edit flavor. */
  index?: number;
  count: number;
  sessionKey: string;
  originalHashes: string[];
  originalNormalized: string;
  /** Single-edit flavor only: the edit's range, for the echo rows. */
  range?: ResolvedRange;
  /** Batch flavor: precomputed echo rows for the failed item (may be absent). */
  echoRows?: ServedRow[];
}

/**
 * The shared noop-loop guard. Returns the "twice in a row" notice for the
 * caller to append to warnings, or throws E_NOOP_LOOP (after recording the
 * echo serves) once the payload has been submitted NOOP_LOOP_THRESHOLD times
 * with no change. Messages are byte-identical to the pre-engine tools.
 */
export async function enforceNoopLoop(opts: NoopLoopOptions): Promise<string | undefined> {
  const {
    absolutePath,
    anchorFrom,
    anchorTo,
    displayPath,
    index,
    count,
    sessionKey,
    originalHashes,
  } = opts;

  if (index === undefined) {
    if (count >= NOOP_LOOP_THRESHOLD) {
      const echoRows = buildRangeEcho(opts.range!.startLine, opts.range!.endLine, originalHashes);
      const echo = fmtServedRows(echoRows, splitLines(opts.originalNormalized));
      await recordEchoServes(sessionKey, absolutePath, echoRows, "live", originalHashes.length, {
        content: opts.originalNormalized,
        hashes: originalHashes,
      });
      throw new DomainError("E_NOOP_LOOP", {
        ref: displayPath,
        anchorFrom,
        anchorTo,
        count,
        batch: false,
        servedBlock: echo,
        path: displayPath,
      });
    }
    if (count === 2) {
      // Channel rule: applied-tier notices are human-observable → USER audience via the registry.
      return formatWarning("W_NOOP", {
        ref: displayPath,
        anchorFrom,
        anchorTo,
        batch: false,
        count,
        path: displayPath,
      });
    }
    return undefined;
  }

  if (count >= NOOP_LOOP_THRESHOLD) {
    const originalLines = splitLines(opts.originalNormalized);
    const echoRows = opts.echoRows;
    if (echoRows) {
      await recordEchoServes(sessionKey, absolutePath, echoRows, "live", originalHashes.length, {
        content: opts.originalNormalized,
        hashes: originalHashes,
      });
    }
    throw new DomainError("E_NOOP_LOOP", {
      ref: `edits[${index}] (${displayPath})`,
      anchorFrom,
      anchorTo,
      count,
      batch: true,
      // F5: pass raw rows — the registry owns the `Current on-disk range:` heading.
      servedBlock: echoRows ? fmtServedRows(echoRows, originalLines) : "",
    });
  }
  if (count === 2) {
    return formatWarning("W_NOOP", {
      ref: `edits[${index}] (${displayPath})`,
      anchorFrom,
      anchorTo,
      batch: true,
      count,
    });
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// per-file sequencer (batch)

function echoRowsForItem(edit: HEdit, originalHashes: string[]): ServedRow[] | undefined {
  const startHash = edit.hash_bounds[0].hash;
  const endHash = edit.hash_bounds[1].hash;
  const s = originalHashes.indexOf(startHash);
  const e = originalHashes.indexOf(endHash);
  if (s < 0 || e < 0) return undefined;
  return buildRangeEcho(Math.min(s, e) + 1, Math.max(s, e) + 1, originalHashes);
}

/** One failing item's share of an E_BATCH_ABORT envelope (C). */
type AbortPart = {
  index: number;
  /** The item's full failure message (already header-bearing, own `[E_*]` inline). */
  inner: string;
  echoRows: ServedRow[] | undefined;
  /** Message fragment: ranged block or the read fallback (single envelopes). */
  echoBlock: string;
  /** Structural rows rendered without heading (unions into servedBlock). */
  fmtBlock: string;
  cause: RangeCause | undefined;
};

/**
 * Shared echo resolution for batch rejections: prefer the failure's own
 * rows, else the resolved edit's rows; record the same reject-and-serve
 * leases the sequential path records so a pre-pass rejection leaves
 * identical retry state.
 */
async function collectAbortPart(opts: {
  sessionKey: string;
  absolutePath: string;
  error: DomainError;
  edit: HEdit | undefined;
  index: number;
  originalNormalized: string;
  originalHashes: string[];
}): Promise<AbortPart> {
  const echoRows =
    opts.error.servedRows.length > 0
      ? opts.error.servedRows
      : opts.edit
        ? echoRowsForItem(opts.edit, opts.originalHashes)
        : undefined;
  if (echoRows) {
    await recordEchoServes(
      opts.sessionKey,
      opts.absolutePath,
      echoRows,
      "live",
      opts.originalHashes.length,
      { content: opts.originalNormalized, hashes: opts.originalHashes },
    );
  }
  const originalLines = splitLines(opts.originalNormalized);
  const fmtBlock = echoRows ? fmtServedRows(echoRows, originalLines) : "";
  const echoBlock = echoRows
    ? ` Current on-disk range for edits[${opts.index}] (unchanged — nothing was written):\n${fmtBlock}`
    : " Call read() to get fresh anchors.";
  return {
    index: opts.index,
    inner: opts.error.message,
    echoRows,
    echoBlock,
    fmtBlock,
    cause: opts.error.cause,
  };
}

/**
 * One aggregated E_BATCH_ABORT for every failing item (C). A single part
 * renders byte-identically to the legacy single-failure envelope; several
 * parts name every failing item in order with the plural fix sentence.
 * `code` routes the typed path via the first item; servedRows unions every
 * part's rows; servedBlock joins every part's block; cause/details ride
 * only on unanimous diagnosis (DomainError builds details from cause).
 */
function buildBatchAbort(file: string, parts: AbortPart[]): DomainError<"E_BATCH_ABORT"> {
  const first = parts[0]!;
  const rows: ServedRow[] = [];
  const blocks: string[] = [];
  for (const part of parts) {
    if (part.echoRows) rows.push(...part.echoRows);
    if (part.fmtBlock) blocks.push(part.fmtBlock);
  }
  const base = {
    index: first.index,
    path: file,
    inner: first.inner,
    echoBlock: first.echoBlock,
    servedRows: rows,
    servedBlock: blocks.join("\n"),
  };
  if (parts.length === 1) return new DomainError("E_BATCH_ABORT", base);
  const firstCause = parts[0]!.cause;
  const unanimous = firstCause !== undefined && parts.every((part) => part.cause === firstCause);
  return new DomainError("E_BATCH_ABORT", {
    ...base,
    failures: parts.map((part) => ({ index: part.index, inner: part.inner })),
    ...(unanimous ? { cause: firstCause } : {}),
  });
}

/**
 * The read-only lease-identity source for one buffer, or undefined when it cannot be built.
 *
 * Leases come from `served_leases`; the `line_id` -> current-line map comes from the store's
 * `positionsByIdentity` over the buffer the edit is applied to. Nothing is written: the edit path
 * never re-stamps a lease and never retires one.
 *
 * RESIDUAL (CP2-r2): for batch item k > 0 the buffer is in-memory and is not a committed snapshot,
 * so `positionsByIdentity` pairs `S_latest` against the working buffer. Correct for shifted and
 * moved lines, fail-closed (`E_STALE_RANGE`) for a row whose identity an earlier edit in the same
 * batch created, or that a duplicate canon makes ambiguous. CP2-r2's explicit working-buffer
 * identity map (`spliceWorkingBufferIds`) plus commit-from-map removes that conservative rejection.
 *
 * UPGRADE CONSEQUENCE: a session whose `served` rows predate lease granting (a pre-T2b store) holds
 * no lease for those anchors, so its first edit rejects and needs one re-read. Fail-closed and
 * one-time; it goes in the CP3 ADR and the T7 CHANGELOG note.
 */
export function makeLeaseSource(
  store: HashStore,
  sessionKey: string,
  absolutePath: string,
  content: string,
): LeaseSpanSource | undefined {
  try {
    // SAFETY: `loadHashStore` and `options.store` return the `makeDomainStore` object, which
    // implements `InternalHashStore`; `HashStore` is its narrowed public view (the same cast
    // session-view.ts documents for its served view).
    const internal = store as unknown as InternalHashStore;
    const positions = internal.positionsByIdentity(absolutePath, content);
    return {
      currentSnapshotHash: snapshotHashFor(content),
      leaseFor: (anchor) => {
        const lease = internal.leaseFor(sessionKey, absolutePath, anchor);
        if (lease === undefined) return undefined;
        return {
          lineId: lease.lineId,
          servedLineNumber: lease.lineNumber,
          servedSnapshotHash: lease.snapshotHash,
          retiredAt: lease.retiredAt,
        };
      },
      rebasedLineOf: (lineId) => positions.get(lineId),
    };
  } catch {
    // Fail-closed: with no source the unconditional position check still guards the edit — the
    // fallback is stricter, never weaker.
    return undefined;
  }
}

/** The ambient store for the lease source, or undefined when it cannot be opened. */
async function loadLeaseStore(): Promise<HashStore | undefined> {
  try {
    return await loadHashStore();
  } catch {
    return undefined;
  }
}

/**
 * Run a file's item list against freshly-read content with served
 * verification, evolving content/hashes, union range, noop tracking, and a
 * per-file drift notice. All-or-nothing is enforced by the caller's
 * transaction ({@link persistUndoAndWrite}): nothing here writes to disk.
 */
export async function runFileEdits(
  io: FileIO,
  items: PreparedItem[],
  opts: { signal?: AbortSignal; sessionKey: string },
): Promise<FileEditResult> {
  const first = items[0]!;
  abortIf(opts.signal);
  const absolutePath = first.absolutePath;
  const perSessionRetired = await loadRetiredAnchors(opts.sessionKey, absolutePath);
  const reservedHashes = new Set(perSessionRetired);
  const rawText = await io.readText(absolutePath, opts.signal);
  const {
    normalized: originalNormalized,
    bom,
    originalEnding,
    fileHashes: originalHashes,
    hadUtf8DecodeErrors,
  } = await normFromText({
    absolutePath,
    rawText,
    displayPath: first.file,
    signal: opts.signal,
    maxLines: MAX_HASH_LINES,
    reservedHashes,
    retiredHashes: perSessionRetired,
  });

  const served = await loadServed(opts.sessionKey, absolutePath);
  const servedCanons = await loadServedCanons(opts.sessionKey, absolutePath);
  const warnings: string[] = [];

  // The lease store is resolved once per file edit; the source itself is rebuilt per buffer (the
  // pre-pass resolves against `originalNormalized`, each loop item against `currentContent`).
  const leaseStore = await loadLeaseStore();
  const originalLeaseSource =
    leaseStore === undefined
      ? undefined
      : makeLeaseSource(leaseStore, opts.sessionKey, absolutePath, originalNormalized);
  let currentContent = originalNormalized;
  let currentHashes = originalHashes;
  let appliedCount = 0;
  let noopCount = 0;
  let totalAddedLines = 0;
  let totalRemovedLines = 0;
  let unionStartLine = Infinity;
  let unionEndLine = -Infinity;
  let unionStartHash = "";
  let unionEndHash = "";
  let lastApplied: { content: string; hashes: string[]; removedHashes: Set<string> } | undefined;
  const newlyRetired = new Set<string>();

  // C: pure pre-pass over all items on the pre-batch snapshot — parse each
  // item (resEdit) and resolve its span (applyEdit) with no mutation
  // (warnings go to a throwaway array; noop tracking untouched). Anchor and
  // served failures collect for one aggregated rejection; a non-domain
  // throw is unexpected and aborts immediately. The loop below still owns
  // state-dependent (mid-loop) failures via onReject.
  const preParts: AbortPart[] = [];
  for (const item of items) {
    abortIf(opts.signal);
    let edit: HEdit | undefined;
    try {
      edit = resEdit({
        anchor_from: item.anchor_from,
        anchor_to: item.anchor_to,
        replace_with: item.replace_with,
      });
      applyEdit(
        originalNormalized,
        edit,
        opts.signal,
        originalHashes,
        item.file,
        served,
        servedCanons,
        perSessionRetired,
        item.mode,
        originalLeaseSource,
      );
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      preParts.push(
        await collectAbortPart({
          sessionKey: opts.sessionKey,
          absolutePath,
          error,
          edit,
          index: item.index,
          originalNormalized,
          originalHashes,
        }),
      );
    }
  }
  if (preParts.length > 0) throw buildBatchAbort(first.file, preParts);

  for (const item of items) {
    abortIf(opts.signal);
    const leaseSource =
      leaseStore === undefined
        ? undefined
        : makeLeaseSource(leaseStore, opts.sessionKey, absolutePath, currentContent);
    const applied = await applyOne(
      {
        content: currentContent,
        hashes: currentHashes,
        served,
        anchorFrom: item.anchor_from,
        anchorTo: item.anchor_to,
        replaceWith: item.replace_with,
        absolutePath,
        displayPath: item.file,
        signal: opts.signal,
        warnings,
        countHashes: originalHashes,
        persist: false,
        reservedHashes,
        servedCanons,
        retired: new Set([...perSessionRetired, ...Array.from(newlyRetired)]),
        mode: item.mode,
        leaseSource,
      },
      async (error, edit) => {
        // In-loop (state-dependent) failures keep single-failure envelopes.
        if (error instanceof AnchorMismatchError || error instanceof ServedRejectionError) {
          const part = await collectAbortPart({
            sessionKey: opts.sessionKey,
            absolutePath,
            error,
            edit,
            index: item.index,
            originalNormalized,
            originalHashes,
          });
          throw buildBatchAbort(item.file, [part]);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw buildBatchAbort(item.file, [
          {
            index: item.index,
            inner: message,
            echoRows: undefined,
            echoBlock: "",
            fmtBlock: "",
            cause: undefined,
          },
        ]);
      },
    );

    const range = applied.range;
    if (range.startLine < unionStartLine) {
      unionStartLine = range.startLine;
      unionStartHash = range.startHash;
    }
    if (range.endLine > unionEndLine) {
      unionEndLine = range.endLine;
      unionEndHash = range.endHash;
    }

    if (applied.noop) {
      noopCount += 1;
      const payload = noopPayloadKey(
        absolutePath,
        item.anchor_from,
        item.anchor_to,
        item.replace_with,
      );
      const count = trackNoopPayload(absolutePath, payload);
      const notice = await enforceNoopLoop({
        absolutePath,
        anchorFrom: item.anchor_from,
        anchorTo: item.anchor_to,
        replaceWith: item.replace_with,
        displayPath: item.file,
        index: item.index,
        count,
        sessionKey: opts.sessionKey,
        originalHashes,
        originalNormalized,
        echoRows: echoRowsForItem(applied.edit, originalHashes),
      });
      if (notice) warnings.push(notice);
      warnings.push(
        `edits[${item.index}] (${item.file}) was a noop: the range already contains the replacement text.`,
      );
      if (applied.anchorWarnings?.length) warnings.push(...applied.anchorWarnings);
      continue;
    }

    appliedCount += 1;
    const removedHashes = applied.removedHashes!;
    for (const hash of removedHashes) {
      reservedHashes.add(hash);
      newlyRetired.add(hash);
    }
    totalAddedLines += applied.totalAddedLines;
    totalRemovedLines += applied.totalRemovedLines;
    lastApplied = {
      content: currentContent,
      hashes: currentHashes,
      removedHashes,
    };
    currentContent = applied.result;
    currentHashes = applied.hashes;
    clearNoopLoop(absolutePath);
    if (applied.anchorWarnings?.length) warnings.push(...applied.anchorWarnings);
  }

  const result = currentContent;
  let resultHashes = currentHashes;
  if (appliedCount > 0 && lastApplied) {
    try {
      resultHashes = await lineHashes(
        result,
        absolutePath,
        {
          content: lastApplied.content,
          hashes: lastApplied.hashes,
          removedHashes: lastApplied.removedHashes,
        },
        undefined,
        true,
        reservedHashes,
        perSessionRetired,
      );
    } catch (e: unknown) {
      if (!isAnchorSpaceExhausted(e)) throw e;
      resultHashes = await retryLineHashesWithPromotion(
        opts.sessionKey,
        absolutePath,
        perSessionRetired,
        served,
        warnings,
        (recomputed, emptyRetired) =>
          lineHashes(
            result,
            absolutePath,
            {
              content: lastApplied.content,
              hashes: lastApplied.hashes,
              removedHashes: lastApplied.removedHashes,
            },
            undefined,
            true,
            recomputed,
            emptyRetired,
          ),
      );
    }
    await retireAnchors(opts.sessionKey, absolutePath, newlyRetired);
  }

  if (hadUtf8DecodeErrors) {
    warnings.push("Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.");
  }
  if (first.fileWarning) warnings.unshift(first.fileWarning);

  let driftNotice: string | undefined;
  if (appliedCount > 0 && unionStartLine !== Infinity) {
    const resultLines = splitLines(result);
    const originalLines = splitLines(originalNormalized);
    try {
      driftNotice = await scanDrift({
        sessionKey: opts.sessionKey,
        served,
        resultHashes,
        resultLines,
        range: {
          startLine: unionStartLine,
          endLine: unionEndLine,
          startHash: unionStartHash,
          endHash: unionEndHash,
          delta: resultLines.length - originalLines.length,
        },
        path: absolutePath,
      });
    } catch (error) {
      console.error("Failed to compute drift notice:", error);
    }
  }

  return {
    displayPath: first.file,
    absolutePath,
    originalNormalized,
    result,
    bom,
    originalEnding,
    hadUtf8DecodeErrors,
    warnings,
    originalHashes,
    resultHashes,
    appliedCount,
    noopCount,
    totalAddedLines,
    totalRemovedLines,
    driftNotice,
    range: {
      startLine: unionStartLine,
      endLine: unionEndLine,
      startHash: unionStartHash,
      endHash: unionEndHash,
      delta: splitLines(result).length - splitLines(originalNormalized).length,
    },
  };
}

// ---------------------------------------------------------------------------
// the write transaction
