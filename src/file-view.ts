/**
 * FileView — deep module owning "what the model sees".
 *
 * Single seam for normalize → hash → render → truncate → served-row
 * selection. Previously split across file-reader, read-render, truncate,
 * file-kind, validation — each shallow (interface≈implementation). Now one
 * file owns the invariant; deleting it would scatter complexity (deep).
 *
 * Private helpers inlined from file-reader (normFromText/fileSnap),
 * read-render (fmtReadPreview), truncate (truncateHead), file-kind
 * (loadFileKindAndText), validation (valKind/valAccess).
 * Old files are shims re-exporting from this seam for compat.
 *
 * Two surfaces:
 *  - `preview` (pure, no IO) — tested without filesystem
 *  - `readView` (IO) — read + normalize + render + truncate + hashes
 *
 * @module dsh-better-edit/file-view
 */

import { constants } from "node:fs";
import { open as fsOpen, stat as fsStat } from "fs/promises";
import { access as fsAccess } from "fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { SNIFF_BYTES, MAX_BYTES, MAX_READ_LINE_BYTES, eLargeFileMsg } from "./constants.js";
import { lineHashes, fmtRegion, HASH_SEP } from "./hashline/index.js";
import { HASH_SPACE } from "./hashline/hash-assign.js";
import { visLines, abortIf, errCode } from "./utils.js";
import { DomainError } from "./domain-errors.js";
import { detectEnding, toLF, stripBOM, type LineEnding } from "./edit-diff.js";
import { resolveTarget, toCwd } from "./paths.js";
import type { FileIO } from "./fs-bridge.js";
import type { ServedRow } from "./hashline/anchor-pipeline.js";
import type { HashStore } from "./hash-store.js";

export const MAX_HASH_LINES = HASH_SPACE;
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

// FU-6 (port of pi-better-edit@2334352; upstream keeps this in src/constants.ts,
// which the FU-6 scope reserves — co-located here with the other read budgets):
// WHY: a multi-window read is still ONE tool result, so the window count is bounded — otherwise
// WHY: `windows` would multiply the auto-read budget by N — and every window draws on the same
// WHY: budget (buildWindowedPreview below).
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

// --- File kind (from file-kind.ts, private) ---

const IMG_TYPES = new Set<string>(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const TEXT_TYPES = new Set<string>([
  "application/rtf",
  "application/xml",
  "application/x-ms-regedit",
]);

function detectTextBom(sample: Uint8Array): string | undefined {
  if (
    sample.length >= 4 &&
    sample[0] === 0xff &&
    sample[1] === 0xfe &&
    sample[2] === 0x00 &&
    sample[3] === 0x00
  )
    return "UTF-32LE";
  if (
    sample.length >= 4 &&
    sample[0] === 0x00 &&
    sample[1] === 0x00 &&
    sample[2] === 0xfe &&
    sample[3] === 0xff
  )
    return "UTF-32BE";
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) return "UTF-16LE";
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) return "UTF-16BE";
  return undefined;
}

function isTextType(mimeType: string): boolean {
  return mimeType.startsWith("text/") || TEXT_TYPES.has(mimeType);
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

export interface LFileText {
  kind: "text";
  text: string;
  // WHY: the load path already stat'd this path; handing the result to the caller keeps the read
  // WHY: path at one `stat` syscall per file instead of re-stat'ing for the snapshot id.
  stats?: FileStats;
  hadUtf8DecodeErrors?: true;
}

export type LFile =
  | { kind: "directory" }
  | { kind: "image"; mimeType: string }
  | LFileText
  | { kind: "binary"; description: string };

export interface LoadFileOptions {
  maxLines?: number;
  displayPath?: string;
}

export async function loadFileKindAndText(
  filePath: string,
  options?: LoadFileOptions,
): Promise<LFile> {
  const pathStat = await fsStat(filePath);
  if (pathStat.isDirectory()) {
    return { kind: "directory" };
  }
  if (!pathStat.isFile()) {
    return {
      kind: "binary",
      description: "unsupported file type",
    };
  }
  if (pathStat.size > MAX_BYTES) {
    return {
      kind: "binary",
      description: `file exceeds ${MAX_BYTES} byte limit`,
    };
  }
  const fileHandle = await fsOpen(filePath, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, SNIFF_BYTES, 0);
    if (bytesRead === 0) {
      return { kind: "text", text: "", stats: pathStat };
    }
    const sample = buffer.subarray(0, bytesRead);
    const textBom = detectTextBom(sample);
    if (textBom) {
      return {
        kind: "binary",
        description: `${textBom} encoded text`,
      };
    }
    const detectedMimeType = (await fileTypeFromBuffer(sample))?.mime;
    if (detectedMimeType !== undefined && !isTextType(detectedMimeType)) {
      if (IMG_TYPES.has(detectedMimeType)) {
        return { kind: "image", mimeType: detectedMimeType };
      }
      return {
        kind: "binary",
        description: detectedMimeType,
      };
    }
    const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
    let hadUtf8DecodeErrors = false;
    let newlineCount = 0;
    const parts: string[] = [];
    function decodeChunk(chunk: Uint8Array, stream: boolean): string {
      const decoded = decoder.decode(chunk, { stream });
      if (!hadUtf8DecodeErrors && decoded.includes("\uFFFD")) {
        hadUtf8DecodeErrors = true;
      }
      if (options?.maxLines !== undefined) {
        for (let i = 0; i < decoded.length; i++) {
          if (decoded.charCodeAt(i) === 10) newlineCount++;
        }
        if (newlineCount > options.maxLines) {
          throw new Error(
            eLargeFileMsg(options.displayPath ?? filePath, newlineCount, options.maxLines),
          );
        }
      }
      return decoded;
    }
    parts.push(decodeChunk(sample, true));
    let position = bytesRead;
    while (true) {
      const { bytesRead: chunkBytesRead } = await fileHandle.read(buffer, 0, SNIFF_BYTES, position);
      if (chunkBytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, chunkBytesRead);
      parts.push(decodeChunk(chunk, true));
      position += chunkBytesRead;
    }
    parts.push(decodeChunk(new Uint8Array(0), false));
    return {
      kind: "text",
      text: parts.join(""),
      stats: pathStat,
      ...(hadUtf8DecodeErrors ? { hadUtf8DecodeErrors: true as const } : {}),
    };
  } finally {
    await fileHandle.close();
  }
}

// --- Validation (from validation.ts, private) ---

export async function valAccess(
  absolutePath: string,
  path: string,
  accessMode: number = constants.R_OK,
): Promise<void> {
  try {
    await fsAccess(absolutePath, accessMode);
  } catch (error: unknown) {
    const code = errCode(error);
    if (code === "ENOENT") {
      throw new DomainError("E_NOT_FOUND", { path });
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new DomainError("E_ACCESS", {
        path,
        kind: "denied",
        access: accessMode & constants.W_OK ? "write" : "read",
      });
    }
    if (code === "ELOOP") {
      throw new DomainError("E_ACCESS", { path, kind: "symlink-loop" });
    }
    throw new DomainError("E_ACCESS", { path, kind: "unreachable" });
  }
}

export function valKind(
  file: LFile,
  path: string,
): asserts file is { kind: "text"; text: string; hadUtf8DecodeErrors?: true } {
  if (file.kind === "directory") {
    throw new DomainError("E_UNSUPPORTED_FILE", { path, kind: "directory" });
  }
  if (file.kind === "binary") {
    throw new DomainError("E_UNSUPPORTED_FILE", {
      path,
      kind: "binary",
      description: file.description,
    });
  }
  if (file.kind === "image") {
    throw new DomainError("E_UNSUPPORTED_FILE", { path, kind: "image" });
  }
}

// --- File reader (from file-reader.ts, private) ---

export interface NormFile {
  absolutePath: string;
  normalized: string;
  bom: string;
  originalEnding: LineEnding;
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

export interface ReadNormOptions {
  signal?: AbortSignal;
  accessMode?: number;
  preloadedFile?: LFile;
  maxLines?: number;
  store?: HashStore;
  noPersist?: boolean;
  reservedHashes?: ReadonlySet<string>;
  retiredHashes?: ReadonlySet<string>;
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> };
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
    fileHashes,
    hadUtf8DecodeErrors: input.hadUtf8DecodeErrors === true,
  };
}

export async function readNormFile(
  path: string,
  cwd: string,
  options?: ReadNormOptions,
): Promise<NormFile> {
  const absolutePath = toCwd(path, cwd);
  const resolvedPath = await resolveTarget(absolutePath);
  const signal = options?.signal;
  const accessMode = options?.accessMode ?? constants.R_OK;
  abortIf(signal);
  await valAccess(resolvedPath, path, accessMode);
  abortIf(signal);
  const file =
    options?.preloadedFile ??
    (await loadFileKindAndText(resolvedPath, {
      maxLines: options?.maxLines,
      displayPath: path,
    }));
  valKind(file, path);
  return normFromText({
    absolutePath: resolvedPath,
    rawText: file.text,
    displayPath: path,
    signal,
    maxLines: options?.maxLines,
    store: options?.store,
    noPersist: options?.noPersist,
    reservedHashes: options?.reservedHashes,
    retiredHashes: options?.retiredHashes,
    hadUtf8DecodeErrors: file.hadUtf8DecodeErrors,
    previous: options?.previous,
  });
}

// --- Read render (from read-render.ts, private) ---

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
 * Validates a `windows` request. `undefined` and `[]` both mean "no windows": the caller falls back
 * to the single-window `offset`/`limit` contract, so an empty array stays backward compatible.
 */
function normWindows(windows: ReadWindow[] | undefined): ReadWindow[] | undefined {
  if (windows === undefined || windows.length === 0) return undefined;
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
// through the SAME pipeline a single-window read uses, so a window degrades exactly like the
// same range read alone. Single-window behavior is unchanged (pinned by read-preview tests).

function oversizedWarning(oversized: { lineNumber: number }[]): {
  lineLabel: string;
  verb: string;
  addresses: string;
} {
  const lineLabel =
    oversized.length === 1
      ? `Line ${oversized[0]!.lineNumber}`
      : `Lines ${oversized.map((row) => row.lineNumber).join(", ")}`;
  const verb = oversized.length === 1 ? "exceeds" : "exceed";
  const addresses = oversized.map((row) => `${row.lineNumber}p`).join(";");
  return { lineLabel, verb, addresses };
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
      ? `[Line ${row.lineNumber} is ${formatSize(row.bytes)}, exceeds ${formatSize(maxBytes)}; content not shown. Use bash: sed -n '${row.lineNumber}p' <path> | head -c ${maxBytes}]`
      : fmtRegion([selectedHashes[index]!], [selected[index]!]),
  );
  const skippedTruncation = truncateHead(rows.join("\n"), { maxBytes, maxLines: maxTruncLines });
  const shownRowCount =
    skippedTruncation.content === "" ? 0 : skippedTruncation.content.split("\n").length;
  const lastShownLine = shownRowCount > 0 ? startLine + shownRowCount - 1 : startLine - 1;
  const { lineLabel, verb, addresses } = oversizedWarning(oversized);
  const warning = `[${lineLabel} ${verb} ${formatSize(maxBytes)}; content not shown because hashline anchors require full lines. Inspect with bash: sed -n '${addresses}' <path> | head -c ${maxBytes}]`;
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

/**
 * Renders one window through the same oversized/truncation pipeline a single-window read uses, so a
 * window inside a multi-window request degrades exactly like the same range read alone.
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
 * Multi-window read (one tool result, several disjoint ranges). Sections render in the caller's
 * order — the order is part of the request, so it is never sorted — while every window draws on ONE
 * shared byte/line budget so N windows cannot multiply the auto-read budget by N. Rows are served
 * only for the lines actually shown, and overlapping windows collapse to one served row per line.
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
  const hashByPosition = new Map<number, string>();
  let truncation: TruncationResult | undefined;
  let remainingBytes = maxBytes;
  let remainingLines = maxTruncLines;

  for (const window of windows) {
    if (window.offset > totalLines) {
      sections.push(
        `Offset ${window.offset} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
      );
      continue;
    }
    const endIdx = Math.min(window.offset - 1 + window.limit, totalLines);
    const header = windowHeader(window.offset, endIdx, totalLines);
    const selected = allLines.slice(window.offset - 1, endIdx);
    const selectedHashes = allHashes.slice(window.offset - 1, endIdx);
    if (remainingBytes <= 0 || remainingLines <= 0) {
      sections.push(
        `${header}\n[Read budget exhausted; this window is not shown. Re-read it on its own.]`,
      );
      // WHY: `metrics.truncated` must be honest when the shared budget cut a window away, so the
      // WHY: same function that reports truncation elsewhere derives it from the budget actually spent.
      const skipped = truncateHead(fmtRegion(selectedHashes, selected), {
        maxBytes: Math.max(0, remainingBytes),
        maxLines: Math.max(0, remainingLines),
      });
      if (truncation === undefined && skipped.truncated) truncation = skipped;
      continue;
    }
    const rowSizes = selected.map((line, index) => ({
      lineNumber: window.offset + index,
      bytes: Buffer.byteLength(`${selectedHashes[index]}${HASH_SEP}${line}`, "utf-8"),
    }));
    const built = buildWindowSection({
      rowSizes,
      selected,
      selectedHashes,
      startLine: window.offset,
      endIdx,
      totalLines,
      maxBytes: remainingBytes,
      maxTruncLines: remainingLines,
    });
    sections.push(`${header}\n${built.text}`);
    for (const row of built.served) hashByPosition.set(row.position, row.hash);
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
    served: [...hashByPosition.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([position, hash]) => ({ position, hash })),
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

export async function preview(
  content: string,
  hashes: string[],
  opts: PreviewOpts = {},
  absolutePath?: string,
): Promise<{
  text: string;
  served: ServedRow[];
  truncation?: TruncationResult;
  nextOffset?: number;
}> {
  return fmtReadPreview(content, opts, hashes, absolutePath);
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
  return {
    text: r.text,
    hashes: fileHashes,
    served: r.served,
    absolutePath,
    truncation: r.truncation,
    nextOffset: r.nextOffset,
    hadUtf8DecodeErrors,
    bom,
    originalEnding,
    normalized,
  };
}
