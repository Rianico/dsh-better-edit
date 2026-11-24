/**
 * FileView — deep module owning "what the model sees".
 *
 * Single seam for normalize → hash → render → truncate → served-row
 * selection. Previously split across five shallow modules
 * (interface≈implementation). Now one file owns the invariant; deleting it
 * would scatter complexity (deep).
 *
 * Private helpers inlined from the retired reader, renderer and truncate
 * modules: normFromText/fileSnap, fmtReadPreview, truncateHead.
 *
 * Two surfaces:
 *  - `fmtReadPreview` (pure, no IO) — tested without filesystem
 *  - `readView` (IO) — read + normalize + render + truncate + hashes
 *
 * @module dsh-better-edit/file-view
 */

import { stat as fsStat } from "fs/promises";
import { MAX_READ_LINE_BYTES, eLargeFileMsg } from "./constants.js";
import { lineHashes, fmtRegion, HASH_SEP } from "./hashline/index.js";
import { HASH_SPACE } from "./hashline/hash-assign.js";
import { visLines, abortIf } from "./utils.js";
import { DomainError } from "./domain-errors.js";
import {
  detectEnding,
  toLF,
  stripBOM,
  type LineEnding,
  type LineEndingCounts,
} from "./edit-diff.js";
import { countLineEndings } from "./eol-config.js";
import { resolveTarget } from "./paths.js";
import type { FileIO } from "./fs-bridge.js";
import type { ServedRow } from "./hashline/anchor-pipeline.js";
import type { HashStore } from "./hash-store.js";

export const MAX_HASH_LINES = HASH_SPACE;
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

// WHY: a multi-window read is still ONE tool result, so the window count is bounded — otherwise
// WHY: `windows` would multiply the auto-read budget by N — and every window draws on the same
// WHY: budget (buildWindowedPreview below). Co-located here with the other read budgets.
export const MAX_READ_WINDOWS = 16;

// --- Truncate (from truncate.ts, private to this seam) ---

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateHead(
  content: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }
  const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf-8");
  if (firstLineBytes > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }
  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }
  const outputContent = outputLinesArr.join("\n");
  const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

// FU-6 (port of pi-better-edit@2334352, stat consolidation):
// WHY: narrowing `fs.Stats` to the fields this codebase reasons about keeps `node:fs` out of the
// WHY: domain types, so callers — tests included — can hand over a plain object, not a `Stats` fixture.
/** Snapshot identity and size: the only `fs.Stats` fields this codebase reads. */
export interface FileStats {
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

// --- File reader (private to this seam) ---

export interface NormFile {
  absolutePath: string;
  normalized: string;
  bom: string;
  originalEnding: LineEnding;
  /**
   * The RAW pre-image's terminators, counted once where the bytes are decoded. One decode feeds
   * both the effective-ending choice and the rewrite count, so the two can never disagree (#169).
   */
  endingCounts: LineEndingCounts;
  fileHashes: string[];
  hadUtf8DecodeErrors: boolean;
}

export type SnapInfo = {
  snapshotId: string;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
};

function fmtSnapId(
  canonicalPath: string,
  info: { ino: number; mtimeMs: number; ctimeMs: number; size: number },
): string {
  return `v2|${canonicalPath}|${info.ino}|${info.mtimeMs}|${info.ctimeMs}|${info.size}`;
}

export async function fileSnap(
  absolutePath: string,
  preloadedStats?: FileStats,
): Promise<SnapInfo> {
  const canonicalPath = await resolveTarget(absolutePath);
  // FU-6 (port of pi-better-edit@2334352, stat consolidation; upstream's `checksum` third
  // parameter belongs to ADR-0013, which this tree does not carry — fmtSnapId has no checksum
  // segment — so preloadedStats lands as the second argument):
  // WHY: the load path stat'd this same canonical path to size the file and reject directories, so
  // WHY: its `Stats` is authoritative for the snapshot id; re-stat'ing could only disagree with the
  // WHY: bytes the caller has already read and hashed.
  const stats: FileStats = preloadedStats ?? (await fsStat(canonicalPath));
  return {
    snapshotId: fmtSnapId(canonicalPath, stats),
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    size: stats.size,
  };
}

export async function normFromText(input: {
  absolutePath: string;
  rawText: string;
  displayPath: string;
  signal?: AbortSignal;
  maxLines?: number;
  store?: HashStore;
  noPersist?: boolean;
  reservedHashes?: ReadonlySet<string>;
  retiredHashes?: ReadonlySet<string>;
  hadUtf8DecodeErrors?: boolean;
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> };
}): Promise<NormFile> {
  const { absolutePath, displayPath, signal } = input;
  abortIf(signal);
  const { bom, text: rawContent } = stripBOM(input.rawText);
  const originalEnding = detectEnding(rawContent);
  const endingCounts = countLineEndings(rawContent);
  const normalized = toLF(rawContent);
  if (input.maxLines !== undefined) {
    const lineCount = visLines(normalized).length;
    if (lineCount > input.maxLines) {
      throw new Error(eLargeFileMsg(displayPath, lineCount, input.maxLines));
    }
  }
  const fileHashes = await lineHashes(
    normalized,
    absolutePath,
    input.previous,
    input.store,
    input.noPersist !== true,
    input.reservedHashes,
    input.retiredHashes,
  );
  return {
    absolutePath,
    normalized,
    bom,
    originalEnding,
    endingCounts,
    fileHashes,
    hadUtf8DecodeErrors: input.hadUtf8DecodeErrors === true,
  };
}

// --- Read render (private to this seam) ---

function normPosInt(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `Read request field "${name}" must be a positive integer.`,
    });
  }
  return value;
}

/** One requested line range of a multi-window read (FU-6, port of pi-better-edit@2334352). */
export interface ReadWindow {
  offset: number;
  limit: number;
}

function normReqInt(value: unknown, name: string): number {
  const normalized = normPosInt(value as number | undefined, name);
  if (normalized === undefined) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `Read request field "${name}" must be a positive integer.`,
    });
  }
  return normalized;
}

/**
 * The windows rule, owned here so the preview and the serve-side full-read contract
 * cannot disagree: `undefined` and `[]` both mean "no windows" — the caller falls back to the
 * single-window `offset`/`limit` contract, so an empty array stays backward compatible.
 *
 * WHY (moved with the rule from read-and-serve): `windows: []` falls back to a
 * full read in the preview, so the full-read contract has to follow the same rule — otherwise an
 * empty array silently skips the drift clear that a full read owes. A non-empty multi-window
 * read serves sparse rows, never the full file.
 */
export function hasRequestedWindows(
  windows: readonly ReadWindow[] | undefined,
): windows is readonly ReadWindow[] {
  return windows !== undefined && windows.length > 0;
}

/**
 * Validates a `windows` request; the `undefined`/`[]` → no-windows mapping is owned by
 * `hasRequestedWindows`.
 */
function normWindows(windows: ReadWindow[] | undefined): ReadWindow[] | undefined {
  if (!hasRequestedWindows(windows)) return undefined;
  if (windows.length > MAX_READ_WINDOWS) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `Read request accepts at most ${MAX_READ_WINDOWS} windows.`,
    });
  }
  return windows.map((window, index) => {
    if (window === null || typeof window !== "object") {
      throw new DomainError("E_BAD_PAYLOAD", {
        message: `Read request field "windows[${index}]" must be an object with offset and limit.`,
      });
    }
    return {
      offset: normReqInt(window.offset, `windows[${index}].offset`),
      limit: normReqInt(window.limit, `windows[${index}].limit`),
    };
  });
}

export function formatPaginationHint(
  startLine: number,
  endLine: number,
  totalLines: number,
  nextOffset: number,
  byteLimit?: number,
): string {
  const sizeSuffix = byteLimit !== undefined ? ` (${formatSize(byteLimit)} limit)` : "";
  return `[Showing lines ${startLine}-${endLine} of ${totalLines}${sizeSuffix}. Use offset=${nextOffset} to continue.]`;
}

// FU-6 (port of pi-better-edit@2334352): the oversized and normal render paths were extracted
// from fmtReadPreview's body into the builders below — the multi-window sections must route
// through the SAME pipeline a single-window read uses, on ONE shared budget (same render arms,
// budget-relative measurement — see buildWindowSection). Single-window behavior is unchanged
// (pinned by read-preview tests).

function oversizedLineFacts(oversized: { lineNumber: number }[]): {
  lineLabel: string;
  verb: string;
  pronoun: "it" | "them";
} {
  const lineLabel =
    oversized.length === 1
      ? `Line ${oversized[0]!.lineNumber}`
      : `Lines ${oversized.map((row) => row.lineNumber).join(", ")}`;
  const verb = oversized.length === 1 ? "exceeds" : "exceed";
  const pronoun = oversized.length === 1 ? "it" : "them";
  return { lineLabel, verb, pronoun };
}

function buildOversizedPreview(params: {
  rowSizes: { lineNumber: number; bytes: number }[];
  selected: string[];
  selectedHashes: string[];
  startLine: number;
  totalLines: number;
  maxBytes: number;
  maxTruncLines: number;
  // WHY: a window is a bounded ask, so its section must not advertise a page it never owed
  // WHY: (mirrors buildNormalPreview); a genuinely truncated window still keeps its own hint.
  hintRemainder?: boolean;
}): { text: string; truncation?: TruncationResult; nextOffset?: number; served: ServedRow[] } {
  const { rowSizes, selected, selectedHashes, startLine, totalLines, maxBytes, maxTruncLines } =
    params;
  const oversized = rowSizes.filter((row) => row.bytes > maxBytes);
  const rows = rowSizes.map((row, index) =>
    row.bytes > maxBytes
      ? `[Line ${row.lineNumber}: ${formatSize(row.bytes)}; not shown.]`
      : fmtRegion([selectedHashes[index]!], [selected[index]!]),
  );
  const skippedTruncation = truncateHead(rows.join("\n"), { maxBytes, maxLines: maxTruncLines });
  const shownRowCount =
    skippedTruncation.content === "" ? 0 : skippedTruncation.content.split("\n").length;
  const lastShownLine = shownRowCount > 0 ? startLine + shownRowCount - 1 : startLine - 1;
  const { lineLabel, verb, pronoun } = oversizedLineFacts(oversized);
  const warning = `[${lineLabel} ${verb} the ${formatSize(maxBytes)} limit; the read tool cannot show ${pronoun}.]`;
  let preview = skippedTruncation.content;
  let nextOffset: number | undefined;
  if (shownRowCount > 0 && skippedTruncation.truncated) {
    nextOffset = lastShownLine + 1;
    preview += `\n\n${warning}\n${formatPaginationHint(startLine, lastShownLine, totalLines, nextOffset, skippedTruncation.maxBytes)}`;
  } else if (shownRowCount > 0 && params.hintRemainder !== false && lastShownLine < totalLines) {
    nextOffset = lastShownLine + 1;
    preview += `\n\n${warning}\n${formatPaginationHint(startLine, lastShownLine, totalLines, nextOffset)}`;
  } else {
    preview += `\n\n${warning}`;
  }
  const served: ServedRow[] = [];
  for (let index = 0; index < shownRowCount; index++) {
    if (rowSizes[index]!.bytes <= maxBytes) {
      served.push({
        position: startLine - 1 + index,
        hash: selectedHashes[index]!,
      });
    }
  }
  return {
    text: preview,
    truncation: skippedTruncation.truncated ? skippedTruncation : undefined,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    served,
  };
}

function buildNormalPreview(params: {
  formatted: string;
  startLine: number;
  endIdx: number;
  totalLines: number;
  maxBytes: number;
  maxTruncLines: number;
  selectedHashes: string[];
  // WHY: an entry of an explicit `windows` request is a bounded ask, not a page: the caller named
  // WHY: exactly these lines, so a trailing "use offset=N to continue" would invent intent.
  hintRemainder?: boolean;
}): {
  preview: string;
  nextOffset?: number;
  truncation: ReturnType<typeof truncateHead>;
  served: ServedRow[];
} {
  const { formatted, startLine, endIdx, totalLines, maxBytes, maxTruncLines, selectedHashes } =
    params;
  const truncation = truncateHead(formatted, { maxBytes, maxLines: maxTruncLines });
  let preview = truncation.content;
  let nextOffset: number | undefined;
  if (truncation.truncated) {
    const endLineDisplay = startLine + truncation.outputLines - 1;
    nextOffset = endLineDisplay + 1;
    if (truncation.truncatedBy === "lines") {
      preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset)}`;
    } else {
      preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset, truncation.maxBytes)}`;
    }
  } else if (params.hintRemainder !== false && endIdx < totalLines) {
    nextOffset = endIdx + 1;
    preview += `\n\n${formatPaginationHint(startLine, endIdx, totalLines, nextOffset)}`;
  }
  const served: ServedRow[] = [];
  for (let index = 0; index < truncation.outputLines; index++) {
    served.push({
      position: startLine - 1 + index,
      hash: selectedHashes[index]!,
    });
  }
  return { preview, nextOffset, truncation, served };
}

function windowHeader(startLine: number, endLine: number, totalLines: number): string {
  return `=== Lines ${startLine}-${endLine} of ${totalLines} ===`;
}

/** One rendered section of a multi-window read: a merged run, or a window past EOF. */
type WindowPlan =
  | { kind: "run"; startLine: number; endLine: number; order: number }
  | { kind: "pastEof"; offset: number; order: number };

/**
 * Folds a `windows` request into the sections the preview renders: the requested line ranges
 * merge into their union, so every requested line renders — and is served — exactly once. Each
 * maximal contiguous span of that union is one run, carrying the smallest caller index that
 * contributed to it; ranges that touch coalesce, since no gap exists between them to frame.
 * A window past EOF contributes no interval and keeps its message at its caller slot, which
 * orders sections but never splits a run. Runs stay contiguous, so a section's rows are a single
 * slice and `startLine - 1 + index` still locates every row.
 */
function mergeWindowRuns(windows: readonly ReadWindow[], totalLines: number): WindowPlan[] {
  const intervals: { startLine: number; endLine: number; order: number }[] = [];
  const pastEof: WindowPlan[] = [];
  windows.forEach((window, order) => {
    if (window.offset > totalLines) {
      pastEof.push({ kind: "pastEof", offset: window.offset, order });
      return;
    }
    intervals.push({
      startLine: window.offset,
      // WHY: the end is exclusive, and `offset + limit` can overshoot the file by thousands.
      endLine: Math.min(window.offset - 1 + window.limit, totalLines),
      order,
    });
  });
  intervals.sort((left, right) => left.startLine - right.startLine);
  const runs: WindowPlan[] = [];
  for (const interval of intervals) {
    const last = runs.at(-1);
    if (last?.kind === "run" && interval.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, interval.endLine);
      last.order = Math.min(last.order, interval.order);
      continue;
    }
    runs.push({ kind: "run", ...interval });
  }
  // WHY: the caller's order is part of the request; `order` is unique, so this sort is total.
  return [...runs, ...pastEof].sort((left, right) => left.order - right.order);
}

/**
 * Renders one window through the same oversized/truncation pipeline a single-window read uses, but
 * against the shared budget actually LEFT to this window: `maxBytes`/`maxTruncLines` are the
 * caller's remaining bytes/lines, not the single-read caps. The render arm is identical while the
 * measurement is not — a 120KB line under a 200KB single-read cap is reported oversized as
 * "exceeds the 80KB limit" once earlier windows spent the shared budget down to 80KB. A window degrades like
 * the same range read alone only while the shared budget is still unspent.
 */
function buildWindowSection(params: {
  rowSizes: { lineNumber: number; bytes: number }[];
  selected: string[];
  selectedHashes: string[];
  startLine: number;
  endIdx: number;
  totalLines: number;
  maxBytes: number;
  maxTruncLines: number;
}): { text: string; truncation?: TruncationResult; served: ServedRow[] } {
  const {
    rowSizes,
    selected,
    selectedHashes,
    startLine,
    endIdx,
    totalLines,
    maxBytes,
    maxTruncLines,
  } = params;
  if (rowSizes.some((row) => row.bytes > maxBytes)) {
    return buildOversizedPreview({
      rowSizes,
      selected,
      selectedHashes,
      startLine,
      totalLines,
      maxBytes,
      maxTruncLines,
      hintRemainder: false,
    });
  }
  const normal = buildNormalPreview({
    formatted: fmtRegion(selectedHashes, selected),
    startLine,
    endIdx,
    totalLines,
    maxBytes,
    maxTruncLines,
    selectedHashes,
    hintRemainder: false,
  });
  return {
    text: normal.preview,
    truncation: normal.truncation.truncated ? normal.truncation : undefined,
    served: normal.served,
  };
}

/**
 * Multi-window read (one tool result, several requested line ranges). The ranges merge into their
 * union first (see `mergeWindowRuns`), so a line requested by several windows renders and is
 * served once and every header names the run it actually shows. Sections render in the order their
 * runs first appear in the request — that order is part of the request, so it is never sorted by
 * position — while every section draws on ONE shared byte/line budget so N windows cannot multiply
 * the auto-read budget by N. Rows are served only for the lines actually shown; because each
 * position belongs to exactly one run, the union's position record is injective by construction.
 * The record is SORTED by position but never de-duplicated: the sort is load-bearing (runs render
 * in request order, so run order is not position order), yet a collector that dropped duplicates
 * would mask a `mergeWindowRuns` regression — overlapping runs would collapse into one served row
 * instead of surfacing as two for the same position.
 */
function buildWindowedPreview(params: {
  windows: ReadWindow[];
  allLines: string[];
  allHashes: string[];
  totalLines: number;
  maxBytes: number;
  maxTruncLines: number;
}): { text: string; truncation?: TruncationResult; served: ServedRow[] } {
  const { windows, allLines, allHashes, totalLines, maxBytes, maxTruncLines } = params;
  const sections: string[] = [];
  const servedRows: ServedRow[] = [];
  let truncation: TruncationResult | undefined;
  let remainingBytes = maxBytes;
  let remainingLines = maxTruncLines;

  for (const plan of mergeWindowRuns(windows, totalLines)) {
    if (plan.kind === "pastEof") {
      sections.push(
        `Offset ${plan.offset} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
      );
      continue;
    }
    const header = windowHeader(plan.startLine, plan.endLine, totalLines);
    const selected = allLines.slice(plan.startLine - 1, plan.endLine);
    const selectedHashes = allHashes.slice(plan.startLine - 1, plan.endLine);
    if (remainingBytes <= 0 || remainingLines <= 0) {
      sections.push(
        `${header}\n[Read budget exhausted; this section is not shown. Re-read it on its own.]`,
      );
      // WHY: `metrics.truncated` must be honest when the shared budget cut a section away, so the
      // WHY: same function that reports truncation elsewhere derives it from the budget actually spent.
      const skipped = truncateHead(fmtRegion(selectedHashes, selected), {
        maxBytes: Math.max(0, remainingBytes),
        maxLines: Math.max(0, remainingLines),
      });
      if (truncation === undefined && skipped.truncated) truncation = skipped;
      continue;
    }
    const rowSizes = selected.map((line, index) => ({
      lineNumber: plan.startLine + index,
      bytes: Buffer.byteLength(`${selectedHashes[index]}${HASH_SEP}${line}`, "utf-8"),
    }));
    const built = buildWindowSection({
      rowSizes,
      selected,
      selectedHashes,
      startLine: plan.startLine,
      endIdx: plan.endLine,
      totalLines,
      maxBytes: remainingBytes,
      maxTruncLines: remainingLines,
    });
    sections.push(`${header}\n${built.text}`);
    for (const row of built.served) servedRows.push(row);
    remainingLines -= built.text === "" ? 0 : built.text.split("\n").length;
    remainingBytes -= Buffer.byteLength(`${built.text}${header}`, "utf-8");
    if (truncation === undefined && built.truncation) truncation = built.truncation;
  }

  return {
    text: sections.join("\n\n"),
    ...(truncation ? { truncation } : {}),
    // WHY: a multi-window request is N discrete slices, not one stream, so the result carries no root
    // WHY: `nextOffset`: a scalar would invite `offset = nextOffset` and silently re-read a window the
    // WHY: caller never asked to continue. A truncated window says so in its own section text.
    served: [...servedRows].sort((left, right) => left.position - right.position),
  };
}

export async function fmtReadPreview(
  text: string,
  options: { offset?: number; limit?: number; windows?: ReadWindow[] },
  precomputedHashes?: string[],
  path?: string,
  maxLineBytes = MAX_READ_LINE_BYTES,
  maxTruncLines = DEFAULT_MAX_LINES,
): Promise<{
  text: string;
  truncation?: TruncationResult;
  nextOffset?: number;
  served: ServedRow[];
}> {
  const allLines = visLines(text);
  const totalLines = allLines.length;
  const startLine = normPosInt(options.offset, "offset") ?? 1;
  const windows = normWindows(options.windows);
  if (totalLines === 0) {
    // FU-6 (2334352): an empty-file `windows` request reports the first window's offset.
    const emptyStart = windows?.[0]?.offset ?? startLine;
    if (emptyStart === 1) {
      const allHashes =
        precomputedHashes ?? (await (path ? lineHashes(text, path) : lineHashes(text)));
      const emptyLineHash = allHashes[0]!;
      return {
        text: `${emptyLineHash}${HASH_SEP}\n[File is empty. Use edit to insert content.]`,
        served: [{ position: 0, hash: emptyLineHash }],
      };
    }
    return {
      text: `Offset ${emptyStart} is beyond end of file (0 lines total). The file is empty. Use edit to insert content.`,
      served: [],
    };
  }
  // FU-6 (2334352): `windows` wins when both are given — the dispatch runs before the
  // single-window startLine validation, so a past-EOF offset in one window never fails the read.
  if (windows) {
    const allHashes =
      precomputedHashes ?? (await (path ? lineHashes(text, path) : lineHashes(text)));
    return buildWindowedPreview({
      windows,
      allLines,
      allHashes,
      totalLines,
      maxBytes: maxLineBytes,
      maxTruncLines,
    });
  }
  if (startLine > totalLines) {
    return {
      text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
      served: [],
    };
  }
  const limit = normPosInt(options.limit, "limit");
  const endIdx = limit ? Math.min(startLine - 1 + limit, totalLines) : totalLines;
  const selected = allLines.slice(startLine - 1, endIdx);
  const allHashes = precomputedHashes ?? (await (path ? lineHashes(text, path) : lineHashes(text)));
  const selectedHashes = allHashes.slice(startLine - 1, endIdx);
  const formatted = fmtRegion(selectedHashes, selected);
  const maxBytes = maxLineBytes;
  const rowSizes = selected.map((line, index) => ({
    lineNumber: startLine + index,
    bytes: Buffer.byteLength(`${selectedHashes[index]}${HASH_SEP}${line}`, "utf-8"),
  }));
  if (rowSizes.some((row) => row.bytes > maxBytes)) {
    return buildOversizedPreview({
      rowSizes,
      selected,
      selectedHashes,
      startLine,
      totalLines,
      maxBytes,
      maxTruncLines,
    });
  }
  const normal = buildNormalPreview({
    formatted,
    startLine,
    endIdx,
    totalLines,
    maxBytes,
    maxTruncLines,
    selectedHashes,
  });
  return {
    text: normal.preview,
    truncation: normal.truncation.truncated ? normal.truncation : undefined,
    ...(normal.nextOffset !== undefined ? { nextOffset: normal.nextOffset } : {}),
    served: normal.served,
  };
}

// --- FileView public surface (unchanged) ---

export interface FileView {
  text: string;
  hashes: string[];
  served: ServedRow[];
  absolutePath: string;
  truncation?: TruncationResult;
  nextOffset?: number;
  /**
   * The full-read verdict — computed HERE and nowhere else (ADR-0035).
   *
   * True only for an untruncated whole-file read: no `offset`, no `limit` and no requested windows
   * (`undefined`/`[]` both mean none, per `hasRequestedWindows`), and nothing cut by the render.
   * A page that happens to cover every line is still a page.
   *
   * WHY here: the request shape lives in this seam — the consumers of the verdict (session-view's
   * `recordServed`, read-and-serve's drift clear) see only rows, and any verdict re-derived from
   * rows says "full" for a page whose rows turn out dense.
   */
  fullRead: boolean;
  hadUtf8DecodeErrors: boolean;
  bom: string;
  originalEnding: LineEnding;
  normalized: string;
}

export interface PreviewOpts {
  offset?: number;
  limit?: number;
  /** FU-6 (2334352): disjoint ranges in one call; wins over offset/limit when non-empty. */
  windows?: ReadWindow[];
}

export interface ReadViewOpts extends PreviewOpts {
  encoding?: string;
  signal?: AbortSignal;
  reservedHashes?: ReadonlySet<string>;
  retiredHashes?: ReadonlySet<string>;
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> };
}

export async function readView(
  io: FileIO,
  path: string,
  cwd: string,
  opts: ReadViewOpts = {},
): Promise<FileView> {
  const { signal } = opts;
  const absolutePath = await io.resolve(path, cwd, signal);
  const rawText = await io.readText(absolutePath, signal, opts.encoding);
  const { normalized, fileHashes, hadUtf8DecodeErrors, bom, originalEnding } = await normFromText({
    absolutePath,
    rawText,
    displayPath: path,
    signal,
    maxLines: MAX_HASH_LINES,
    reservedHashes: opts.reservedHashes,
    retiredHashes: opts.retiredHashes,
    previous: opts.previous,
  });
  const r = await fmtReadPreview(
    normalized,
    { offset: opts.offset, limit: opts.limit, windows: opts.windows },
    fileHashes,
    absolutePath,
  );
  // The ONE computation of the full-read verdict (ADR-0035): the whole file, no page request, and
  // nothing truncated away. Consumers read `view.fullRead`; none of them re-derives it.
  const fullRead =
    opts.offset === undefined &&
    opts.limit === undefined &&
    !hasRequestedWindows(opts.windows) &&
    !r.truncation?.truncated;
  return {
    text: r.text,
    hashes: fileHashes,
    served: r.served,
    absolutePath,
    truncation: r.truncation,
    nextOffset: r.nextOffset,
    fullRead,
    hadUtf8DecodeErrors,
    bom,
    originalEnding,
    normalized,
  };
}
