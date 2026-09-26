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
 * a rejection rethrows with the current-range echo and records/grants nothing.
 * @module dsh-better-edit/mutation/engine
 */

import type { FileIO } from "../fs-bridge.js";
import { loadHashStore, type HashStore, type InternalHashStore } from "../hash-store.js";
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
import { buildNeverServedEditHint } from "../hashline/served-guard.js";

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
): Promise<string | undefined> {
  let store: ServedPersistence;
  try {
    const { loadServedStore } = await import("../hash-store.js");
    store = await loadServedStore();
    store.clearRetiredAnchors(sessionKey ?? "", absolutePath);
  } catch (error) {
    return (
      `promotion could not clear retired anchors for ${absolutePath} ` +
      `(${error instanceof Error ? error.message : String(error)}); ` +
      "stale-anchor checks stay degraded until the next full read."
    );
  }
  try {
    store.clearCards(sessionKey ?? "", absolutePath);
    return undefined;
  } catch (error) {
    return (
      `promotion could not clear the reported cards for ${absolutePath} ` +
      `(${error instanceof Error ? error.message : String(error)}); ` +
      "the next read may still compare against the pre-promotion range."
    );
  }
}

async function retryLineHashesWithPromotion(
  sessionKey: string | undefined,
  absolutePath: string,
  retired: ReadonlySet<string> | undefined,
  served: readonly (string | null)[] | undefined,
  warnings: string[],
  fn: (reserved: Set<string>, retired: Set<string>) => Promise<string[]>,
): Promise<string[]> {
  const clearWarning = await clearRetiredForPromotion(sessionKey, absolutePath);
  if (clearWarning !== undefined) warnings.push(clearWarning);
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
  type ResolvedRange,
  type ServedRow,
} from "../hashline/anchor-pipeline.js";
import { DomainError, formatError, formatWarning } from "../domain-errors.js";
import type { RangeCause } from "../domain-errors.js";
import type { EditMode } from "../contract.js";
import { findSnapshotPathsByHashes, type ServedPersistence } from "../hash-store.js";
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
  /** Offending never-served anchor-shaped lines, as data (FU-R, upstream pipeline.ts:261,269); the batch renders one counted hint per call. */
  neverServedCount: number;
}

/**
 * One edit against in-memory content: resolve (unless a pre-resolved edit was
 * given) → apply with served verification → stable re-hash → line counts.
 *
 * `onReject` owns the reject-and-serve policy: it receives resolve/verify
 * failures (and the edit that failed, when resolved) and MUST throw. The
 * single path rethrows the original anchor error; the batch path wraps with
 * E_BATCH_ABORT plus the current-range echo. A rejection records and grants
 * nothing — the recovery is the re-read the message already instructs.
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
    neverServedCount: anchorResult.neverServedCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// noop-loop guard

export interface NoopLoopOptions {
  anchorFrom: string;
  anchorTo: string;
  displayPath: string;
  /** Batch item index. */
  index: number;
  count: number;
  originalNormalized: string;
  /** Batch flavor: precomputed echo rows for the failed item (may be absent). */
  echoRows?: ServedRow[];
}

/**
 * The shared noop-loop guard. Returns the "twice in a row" notice for the
 * caller to append to warnings, or throws E_NOOP_LOOP (with the current-range
 * echo) once the payload has been submitted NOOP_LOOP_THRESHOLD times
 * with no change. Messages are byte-identical to the pre-engine tools.
 */
export async function enforceNoopLoop(opts: NoopLoopOptions): Promise<string | undefined> {
  const { anchorFrom, anchorTo, displayPath, index, count } = opts;
  if (count >= NOOP_LOOP_THRESHOLD) {
    const originalLines = splitLines(opts.originalNormalized);
    const echoRows = opts.echoRows;
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
 * rows, else the resolved edit's rows. The rows are rendered into the
 * envelope only — a rejection records and grants nothing.
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
  if (parts.length === 1) {
    // FU-7 conformance (b92e0ec:src/mutation-engine/pipeline.ts:531-560 — `batchAbortFor`): the
    // single-failing-item stage forwards the item's `details.cause` untouched; unanimity is
    // trivially true for one item, so the base envelope must not drop it.
    return new DomainError("E_BATCH_ABORT", {
      ...base,
      ...(first.cause !== undefined ? { cause: first.cause } : {}),
    });
  }
  const firstCause = parts[0]!.cause;
  const unanimous = firstCause !== undefined && parts.every((part) => part.cause === firstCause);
  return new DomainError("E_BATCH_ABORT", {
    ...base,
    failures: parts.map((part) => ({ index: part.index, inner: part.inner })),
    ...(unanimous ? { cause: firstCause } : {}),
  });
}

/** The `makeDomainStore` object behind the narrowed `HashStore` view. */
function internalStore(store: HashStore): InternalHashStore {
  // SAFETY: `loadHashStore` and `options.store` return the `makeDomainStore` object, which
  // implements `InternalHashStore`; `HashStore` is its narrowed public view (the same cast
  // session-view.ts documents for its served view).
  return store as unknown as InternalHashStore;
}

/**
 * The `line_id` -> line-number map for one buffer, or undefined when the store read throws.
 * `undefined` means "no source": the unconditional position check keeps guarding the edit, never a
 * weaker check. `positionsByIdentity` itself writes nothing.
 */
function identityPositions(
  store: HashStore,
  absolutePath: string,
  content: string,
): Map<number, number> | undefined {
  try {
    return internalStore(store).positionsByIdentity(absolutePath, content);
  } catch {
    return undefined;
  }
}

/** The lease lookups over an already-resolved identity map. Nothing here writes. */
function leaseSourceFrom(
  store: HashStore,
  sessionKey: string,
  absolutePath: string,
  positions: Map<number, number>,
): LeaseSpanSource {
  const internal = internalStore(store);
  return {
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
    // Failure-path only (upstream b92e0ec:src/hashline/resolve.ts:41-49): the lease-miss
    // rejection asks which OTHER files this session served the anchor for.
    anchorHomes: (anchor) => internal.leaseHomes(sessionKey, absolutePath, anchor),
  };
}

/**
 * The read-only lease-identity source for one buffer, or undefined when it cannot be built.
 *
 * Leases come from `served_leases`; the `line_id` -> current-line map comes from the store's
 * `positionsByIdentity` over the buffer the edit is applied to. Nothing is written: the edit path
 * never re-stamps a lease and never retires one.
 *
 * For a buffer that is not a committed snapshot — batch item k > 0 — the caller passes the map it
 * already advanced (`leaseSourceFrom` + `spliceWorkingBufferIds`) rather than re-deriving it here.
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
  const positions = identityPositions(store, absolutePath, content);
  if (positions === undefined) return undefined;
  return leaseSourceFrom(store, sessionKey, absolutePath, positions);
}

/**
 * Index -> `line_id` for a buffer, from the identity map. `null` is a line the batch created (or
 * one the engine could not prove moved): it carries no identity to resolve against yet.
 */
function idsFromPositions(positions: Map<number, number>, lineCount: number): (number | null)[] {
  const byPosition = new Map<number, number>();
  for (const [lineId, lineNumber] of positions) byPosition.set(lineNumber, lineId);
  return Array.from({ length: lineCount }, (_, index) => byPosition.get(index + 1) ?? null);
}

/** The inverse of `idsFromPositions` — the shape `rebasedLineOf` reads. */
function positionsFromIds(ids: readonly (number | null)[]): Map<number, number> {
  const positions = new Map<number, number>();
  for (let index = 0; index < ids.length; index++) {
    const lineId = ids[index];
    if (lineId !== null && lineId !== undefined) positions.set(lineId, index + 1);
  }
  return positions;
}

/**
 * Advance the working-buffer identity map past one APPLIED item.
 *
 * Lines outside the item's resolved range keep their id — they only shifted, so the same identity
 * lives at a new coordinate. The range's replacement lines become `null`: the batch created them, so
 * they carry no identity to resolve against until a read leases them.
 *
 * WHY this map exists, and why dsh does NOT port upstream's commit-from-map half: resolution needs
 * the working buffer's identities *during* the batch, and re-pairing `S_latest` against the
 * intermediate buffer is ambiguous exactly when the batch introduced a duplicate canon — the map is
 * the deterministic answer there. The COMMIT path is a different question and keeps re-pairing the
 * final content against the latest snapshot, which is *more* identity-preserving than the map for a
 * line inside a replaced range that survived byte-identical: re-pairing inherits it, while the map
 * would assign `null` and force a re-read on the next edit. So the map is resolution-only by design.
 */
function spliceWorkingBufferIds(
  ids: readonly (number | null)[],
  rangeStart: number,
  rangeEnd: number,
  lineCount: number,
): (number | null)[] {
  const replaced = rangeEnd - rangeStart + 1;
  const replacementCount = Math.max(lineCount - ids.length + replaced, 0);
  const middle = Array.from({ length: replacementCount }, () => null);
  return [...ids.slice(0, rangeStart - 1), ...middle, ...ids.slice(rangeEnd)];
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
  // FU-R (upstream pipeline.ts:811-822): the never-served soft hint is once per call. Per-item
  // counts travel as structured data (`neverServedCount`), aggregate here, and one counted hint
  // renders after the loop. No other warning tier is capped; a noop writes nothing, so its count
  // is never aggregated.
  let neverServedTotal = 0;
  const pushAppliedWarnings = (list: string[] | undefined, hintCount: number): void => {
    if (list) warnings.push(...list);
    neverServedTotal += hintCount;
  };
  const pushNoopWarnings = (list: string[] | undefined): void => {
    if (list) warnings.push(...list);
  };

  // The lease store is resolved once per file edit; the source itself is rebuilt per buffer (the
  // pre-pass resolves against `originalNormalized`, each loop item against `currentContent` plus the
  // working-buffer identity map below).
  const leaseStore = await loadLeaseStore();
  const originalPositions =
    leaseStore === undefined
      ? undefined
      : identityPositions(leaseStore, absolutePath, originalNormalized);
  const originalLeaseSource =
    leaseStore === undefined || originalPositions === undefined
      ? undefined
      : leaseSourceFrom(leaseStore, opts.sessionKey, absolutePath, originalPositions);
  // The working-buffer identity map: index -> `line_id | null`, seeded from the same seam the
  // resolution uses so resolution and any future commit cannot disagree. Advanced after each
  // applied item; a length that disagrees with the buffer's line count falls back to
  // `positionsByIdentity` — never to a guess.
  let currentIds =
    originalPositions === undefined
      ? undefined
      : idsFromPositions(originalPositions, splitLines(originalNormalized).length);
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
        : currentIds !== undefined && currentIds.length === splitLines(currentContent).length
          ? leaseSourceFrom(leaseStore, opts.sessionKey, absolutePath, positionsFromIds(currentIds))
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
        anchorFrom: item.anchor_from,
        anchorTo: item.anchor_to,
        displayPath: item.file,
        index: item.index,
        count,
        originalNormalized,
        echoRows: echoRowsForItem(applied.edit, originalHashes),
      });
      if (notice) warnings.push(notice);
      warnings.push(
        `edits[${item.index}] (${item.file}) was a noop: the range already contains the replacement text.`,
      );
      pushNoopWarnings(applied.anchorWarnings);
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
    if (currentIds !== undefined) {
      currentIds = spliceWorkingBufferIds(
        currentIds,
        range.startLine,
        range.endLine,
        splitLines(applied.result).length,
      );
    }
    currentHashes = applied.hashes;
    clearNoopLoop(absolutePath);
    pushAppliedWarnings(applied.anchorWarnings, applied.neverServedCount);
  }

  if (neverServedTotal > 0) {
    warnings.push(buildNeverServedEditHint({ count: neverServedTotal }));
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
