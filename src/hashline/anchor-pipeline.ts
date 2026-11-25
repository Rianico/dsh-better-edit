/**
 * AnchorPipeline — deep module owning the anchor autofix chain.
 *
 * Single ordering invariant (private):
 *   swapReversed → stripBare → stripDiff → valEdit → verifyServed → resToSpan
 *
 * This seam co-locates the ordering invariant. Public surface is two functions:
 *   resEdit  — pre-validation (tool-layer, no file state)
 *   applyEdit — full pipeline (file + hashes + served verification)
 *
 * Private to this seam (not re-exported): stripBarePrefixes, stripDiffPrefixes,
 * swapReversedRanges, valEdit, warnUnicodeEsc,
 * resAnchorFromMap, assertAligned, etc. They remain exported from resolve.ts
 * for backwards compat but are marked @internal and should be imported via this
 * module only.
 *
 * The served-evidence verdict lives in served-evidence.ts (ADR-0037): this seam
 * calls `verifyServedRange` and owns nothing it decides.
 *
 * @module dsh-better-edit/hashline/anchor-pipeline
 */

import { abortIf, splitLines, rejectUnknownFields, clipLine } from "../utils.js";
import {
  HASH_CLASS,
  HL_BARE_PREFIX_RE,
  HL_PREFIX_PLUS_RE,
  HL_PREFIX_MINUS_RE,
  HASH_SEP,
  ANCHOR_LEN,
  ALPH_RE,
  lineHashesPure,
  canon,
} from "./hash-assign.js";
import { NEW_CONTENT_NOT_STRING_MSG, NEW_CONTENT_BODY } from "../constants.js";
import { DomainError, formatWarning, numericAnchorNote } from "../domain-errors.js";
import type { SpanMode } from "../span-mode.js";
import type { ErrorPayloadMap, ServedRow, DomainErrorCode } from "../domain-errors.js";
import { fmtServedRows, verifyServedRange } from "./served-evidence.js";
import type { LeaseSpanSource, ResolvedRange } from "./served-evidence.js";
import {
  buildServedEditPrefixNote,
  findNeverServedAnchorShapes,
  findServedPrefixMismatches,
} from "./served-guard.js";
import type { EditMode } from "../edit-mode.js";
export type Anchor = { hash: string };

function diagRef(ref: string): { rawAnchor: string; reason: string } {
  const trimmed = ref.trim();

  if (!trimmed.length) {
    return { rawAnchor: trimmed, reason: 'Expected a 3-char alphanumeric anchor (e.g. "aB3").' };
  }

  if (/^\d+/.test(trimmed)) {
    return {
      rawAnchor: trimmed,
      reason: 'Use the hash alone (e.g. "aB3") — no line numbers or trailing content.',
    };
  }

  if (trimmed.includes("│")) {
    return {
      rawAnchor: trimmed,
      reason:
        'anchor_from and anchor_to must contain the 3-char hash only — remove everything from "│" onward.',
    };
  }

  return {
    rawAnchor: trimmed,
    reason: 'Expected a 3-char alphanumeric anchor (e.g. "aB3").',
  };
}

function parseRef(ref: string): Anchor {
  const trimmed = ref.trim();

  if (trimmed.length === ANCHOR_LEN && ALPH_RE.test(trimmed)) {
    return { hash: trimmed };
  }

  const diag = diagRef(ref);
  throw new DomainError("E_MALFORMED_ANCHOR", { rawAnchor: diag.rawAnchor, reason: diag.reason });
}
export const parseHashRef = parseRef;

export function parseText(edit: string): string[] {
  if (typeof edit !== "string") {
    throw new Error(NEW_CONTENT_NOT_STRING_MSG);
  }
  const normalized = edit.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") return [];
  if (/^\n+$/.test(normalized)) return new Array(normalized.length).fill("");
  return normalized.split("\n");
}

export type RAnchor = {
  line: number;
  hash: string;
  hashMatched: boolean;
};

export type HEdit = { content_lines: string[]; hash_bounds: [Anchor, Anchor] };
export type RHEdit = {
  content_lines: string[];
  hash_bounds: [RAnchor, RAnchor];
};

interface HMismatch {
  ref: Anchor;
  kind: "not_found" | "ambiguous";
  candidates?: number[];
  context?: RAnchor;
}

export interface NEdit {
  loc: string;
  currentContent: string;
}

export type HTEdit = {
  replace_with: string;
  anchor_from: string;
  anchor_to: string;
};

function resAnchorFromMap(ref: Anchor, hashIndex: Map<string, number[]>): RAnchor | HMismatch {
  const hashMatches = hashIndex.get(ref.hash);
  if (!hashMatches || hashMatches.length === 0) {
    return { ref, kind: "not_found" };
  }
  if (hashMatches.length === 1) {
    return {
      line: hashMatches[0]!,
      hash: ref.hash,
      hashMatched: true,
    };
  }
  return { ref, kind: "ambiguous", candidates: hashMatches };
}

function assertAligned(fileLines: string[], fileHashes: string[], ctx: string): void {
  if (fileHashes.length !== fileLines.length) {
    throw new Error(
      `${ctx}: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
    );
  }
}

function fmtMismatchWithServes(
  mismatches: HMismatch[],
  fileLines: string[],
  fileHashes: string[],
  filePath?: string,
): { headline: string; servedBlock: string; servedRows: ServedRow[] } {
  const headlines: string[] = [];
  const blocks: string[] = [];
  const servedRows: ServedRow[] = [];
  const seen = new Set<number>();
  const pushRow = (ln: number) => {
    if (ln < 1 || ln > fileLines.length) return;
    const position = ln - 1;
    if (seen.has(position)) return;
    seen.add(position);
    servedRows.push({ position, hash: fileHashes[ln - 1]! });
  };
  const notFoundRaw = mismatches.filter((m) => m.kind === "not_found");
  const ambiguousRaw = mismatches.filter((m) => m.kind === "ambiguous");
  // WHY: a rejection counts and names distinct anchors, never bounds — one single-line edit
  // submits one anchor as both bounds, so both slots report the same mismatch.
  const notFound = [...new Map(notFoundRaw.map((m) => [m.ref.hash, m])).values()];
  const ambiguous = [...new Map(ambiguousRaw.map((m) => [m.ref.hash, m])).values()];

  const refList = notFound.map((m) => `"${m.ref.hash}"`).join(", ");
  if (notFound.length > 0) {
    headlines.push(
      // B: a well-formed all-digit anchor that does not resolve lands here;
      // the numeric note steers away from line numbers (T4 deleted the
      // E_UNKNOWN_ANCHOR declaration — this headline is now the note's only home).
      `${notFound.length} stale anchor${notFound.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}: ${refList}. Re-read for fresh anchors.${numericAnchorNote(notFound.map((m) => m.ref.hash))}`,
    );
    for (const m of notFound) {
      const ctx = m.context;
      if (!ctx) continue;
      const from = Math.max(1, ctx.line - 1);
      const to = Math.min(fileLines.length, ctx.line + 1);
      const rows: string[] = [];
      for (let ln = from; ln <= to; ln++) {
        rows.push(`    ${ln}: ${fileHashes[ln - 1]}│${clipLine(fileLines[ln - 1] ?? "")}`);
        pushRow(ln);
      }
      blocks.push(
        `  Current context around resolved anchor "${ctx.hash}" (line ${ctx.line}):\n${rows.join("\n")}`,
      );
    }
  }
  if (ambiguous.length > 0) {
    headlines.push(
      `${ambiguous.length} ambiguous anchor${ambiguous.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}. Re-read for fresh anchors.`,
    );
    for (const m of ambiguous) {
      const sample = (m.candidates ?? []).slice(0, 5);
      const more =
        (m.candidates?.length ?? 0) > sample.length
          ? `, ... (+${(m.candidates?.length ?? 0) - sample.length} more)`
          : "";
      const lines = sample
        .map((line) => {
          const content = clipLine(fileLines[line - 1] ?? "");
          pushRow(line);
          return `    ${line}: ${fileHashes[line - 1]}│${content}`;
        })
        .join("\n");
      blocks.push(`  Hash "${m.ref.hash}" matches lines ${sample.join(", ")}${more}.\n${lines}`);
    }
  }
  return { headline: headlines.join("\n\n"), servedBlock: blocks.join("\n\n"), servedRows };
}
const ITEM_KS = new Set(["replace_with", "anchor_from", "anchor_to"]);

function assertItem(edit: Record<string, unknown>): void {
  rejectUnknownFields(
    edit,
    ITEM_KS,
    "Edit",
    "The edit takes only { replace_with, anchor_from, anchor_to }.",
  );

  if ("anchor_from" in edit && typeof edit.anchor_from !== "string") {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `Field "anchor_from" must be an anchor string (3-char hash).`,
    });
  }
  if ("anchor_to" in edit && typeof edit.anchor_to !== "string") {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `Field "anchor_to" must be an anchor string (3-char hash).`,
    });
  }
  if (!("replace_with" in edit)) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `The edit requires a "replace_with" field. Provide the replacement text (use "" to delete).`,
    });
  }
  if (typeof edit.replace_with !== "string") {
    throw new DomainError("E_BAD_PAYLOAD", { message: NEW_CONTENT_BODY });
  }
  if (typeof edit.anchor_from !== "string" || typeof edit.anchor_to !== "string") {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `The edit requires "anchor_from" and "anchor_to" anchor strings (3-char hashes from read output).`,
    });
  }
}

const ANCHOR_ROW_RE = new RegExp(`^([+-]?)(${HASH_CLASS})│`);

export function resEdit(edit: HTEdit, _warnings?: string[]): HEdit {
  assertItem(edit as Record<string, unknown>);

  const editLines = parseText(edit.replace_with);
  const bounds = [edit.anchor_from, edit.anchor_to].map((ref) => {
    const trimmed = ref.trim();
    // #108: a pasted block carries no verified coordinate — refuse by SHAPE, naming no
    // extracted hash. The old first-3-char-alnum-run guess minted a pseudo-anchor whose
    // "use bare <hash> next time" hint steered the model into an unrelated line.
    if (trimmed.includes("\n")) {
      const lines = trimmed.split("\n").length;
      throw new DomainError("E_MALFORMED_ANCHOR", {
        // Redacted, upstream shape: never echo the pasted block back into the transcript.
        rawAnchor: `${lines}-line block`,
        reason: `anchor_from/anchor_to must be a single bare 3-char hash — the anchor read() served beside the one line you mean. You passed a ${lines}-line block; pass that bare hash, or re-read the file.`,
      });
    }
    const match = trimmed.match(ANCHOR_ROW_RE);
    if (match) {
      let reason: string;
      if (match[1] === "+") {
        reason = `stripped diff-preview marker from anchor_from/anchor_to — pass the bare anchor.`;
      } else if (match[1] === "-") {
        reason = `stripped leading "-" marker from anchor_from/anchor_to — pass the bare anchor.`;
      } else {
        reason = `stripped "HASH│" prefix from anchor_from/anchor_to — pass the bare anchor.`;
      }
      // Channel rule: the model must retry with the bare anchor → MODEL audience via the registry.
      throw new DomainError("E_MALFORMED_ANCHOR", { rawAnchor: trimmed, reason });
    }
    return ref;
  }) as [string, string];
  return {
    content_lines: editLines,
    hash_bounds: [parseHashRef(bounds[0]), parseHashRef(bounds[1])],
  };
}

function warnUnicodeEsc(edit: HEdit, warnings: string[]): void {
  const index = edit.content_lines.findIndex((line) => /\\uDDDD/i.test(line));
  if (index !== -1) {
    warnings.push(formatWarning("W_UNICODE_LITERAL", { line: index + 1 }));
  }
}

/** @internal — private to anchor-pipeline seam; do not import directly, use anchor-pipeline.ts */
function stripBarePrefixes(edit: HEdit, fileHashes: string[], _warnings: string[]): HEdit {
  const fileHashSet = new Set(fileHashes);
  const stripped: { lineIndex: number; matched: boolean }[] = [];
  const contentLines = edit.content_lines.map((line, lineIndex) => {
    const match = line.match(HL_BARE_PREFIX_RE);
    if (!match) return line;
    stripped.push({ lineIndex, matched: fileHashSet.has(match[1]!) });
    return line.slice(match[0].length);
  });
  if (stripped.length === 0) return edit;
  const matchedCount = stripped.filter((s) => s.matched).length;
  // #63 supersedes #24's 0-matched arm: no stripped prefix is a file anchor, so the
  // lines are literal content — pass the edit through UNCHANGED (prefixes intact).
  // Arms with matched >= 1 keep throwing; the call-site echo routing still governs.
  // FU-5: the applied-bytes warn tiers (served-guard.ts) name this write-through.
  if (matchedCount === 0) return edit;
  const locations = stripped.map((s) => `replace_with line ${s.lineIndex + 1}`).join(", ");
  const evidence = `${matchedCount}/${stripped.length} matched`;
  if (matchedCount === stripped.length) {
    throw new BadAnchorError(
      locations,
      `stripped "HASH│" prefix from ${locations} (${evidence}) — use bare content without HASH│ next time.`,
      { ...edit, content_lines: contentLines },
    );
  }
  throw new BadAnchorError(locations, `stripped "HASH│" prefix from ${locations} (${evidence}).`, {
    ...edit,
    content_lines: contentLines,
  });
}

/** @internal — private to anchor-pipeline seam */
function stripDiffPrefixes(edit: HEdit, _warnings: string[]): HEdit {
  const stripped: number[] = [];
  const contentLines = edit.content_lines.map((line, lineIndex) => {
    const plus = line.match(HL_PREFIX_PLUS_RE);
    if (plus) {
      stripped.push(lineIndex);
      return line.slice(plus[0].length);
    }
    const minus = line.match(HL_PREFIX_MINUS_RE);
    if (minus) {
      stripped.push(lineIndex);
      return line.slice(minus[0].length);
    }
    return line;
  });
  if (stripped.length === 0) return edit;
  const locations = stripped.map((i) => `replace_with line ${i + 1}`).join(", ");
  throw new BadAnchorError(locations, `stripped diff-preview marker from ${locations}.`, {
    ...edit,
    content_lines: contentLines,
  });
}

/** @internal — private to anchor-pipeline seam */
function swapReversedRanges(edit: HEdit, fileHashes: string[], warnings: string[]): HEdit {
  const lineByHash = new Map<string, number>();
  for (let i = 0; i < fileHashes.length; i++) {
    lineByHash.set(fileHashes[i]!, i + 1);
  }
  const [startRef, endRef] = edit.hash_bounds;
  const startLine = lineByHash.get(startRef.hash);
  const endLine = lineByHash.get(endRef.hash);
  if (startLine === undefined || endLine === undefined || startLine <= endLine) {
    return edit;
  }
  warnings.push(
    formatWarning("W_REVERSED_ANCHORS", { fromHash: startRef.hash, toHash: endRef.hash }),
  );
  return { ...edit, hash_bounds: [endRef, startRef] as [Anchor, Anchor] };
}

/**
 * The lease-backed anchor fallback for a line whose BYTES moved but whose CANON did not (#138).
 *
 * WHY it exists: anchor identity now keys on the raw line, so an external formatter's re-indent
 * rotates the anchor the current file derives — yet the anchor the model holds still names the same
 * line. The lease remembers the `line_id`, `positionsByIdentity` rebases that id onto the current
 * buffer (canon-keyed pairing), and the canon recorded for that served anchor is the evidence.
 *
 * WHY it cannot widen identity: a byte change that moves the CANON (an interior rewrite, a token
 * merged onto the line) fails the canon comparison and declines, so the stale-anchor refusal and
 * every fail-closed case keep their verdict. An ambiguous serve of the same anchor, a retired lease,
 * a missing lease and an out-of-range rebase all decline the same way.
 *
 * WHY the fallback is `not_found`-only: an AMBIGUOUS anchor found twice in the file is never
 * resolved through a lease — ambiguity stays a refusal.
 */
function leaseAnchorLineResolver(args: {
  leaseSource: LeaseSpanSource | undefined;
  served: (string | null)[] | undefined;
  servedCanons: (string | null)[] | undefined;
  fileLines: string[];
}): ((hash: string) => number | undefined) | undefined {
  const { leaseSource, served, servedCanons, fileLines } = args;
  if (leaseSource === undefined || served === undefined) return undefined;
  return (hash: string): number | undefined => {
    let servedIndex = -1;
    for (let i = 0; i < served.length; i++) {
      if (served[i] !== hash) continue;
      // Served twice: the anchor does not name ONE line, so nothing may be inferred from a lease.
      if (servedIndex >= 0) return undefined;
      servedIndex = i;
    }
    if (servedIndex < 0) return undefined;
    const servedCanon = servedCanons?.[servedIndex];
    if (servedCanon === null || servedCanon === undefined) return undefined;
    const lease = leaseSource.leaseFor(hash);
    if (lease === undefined || lease.retiredAt !== null) return undefined;
    const line = leaseSource.rebasedLineOf(lease.lineId);
    if (line === undefined || line < 1 || line > fileLines.length) return undefined;
    // The canon decides "same line after a reformat": equal canon → the reformat case; different
    // canon → a different line, and the caller's stale-anchor refusal stands.
    if (canon(fileLines[line - 1]!) !== servedCanon) return undefined;
    return line;
  };
}

/** @internal — private to anchor-pipeline seam */
function valEdit(
  edit: HEdit,
  fileLines: string[],
  fileHashes: string[],
  _warnings: string[],
  signal: AbortSignal | undefined,
  resolveFromLease?: (hash: string) => number | undefined,
): {
  resolved: RHEdit | undefined;
  mismatches: HMismatch[];
} {
  assertAligned(fileLines, fileHashes, "valEdit");
  const mismatches: HMismatch[] = [];

  const hashIndex = new Map<string, number[]>();
  for (let i = 0; i < fileHashes.length; i++) {
    const h = fileHashes[i]!;
    const list = hashIndex.get(h) ?? [];
    list.push(i + 1);
    hashIndex.set(h, list);
  }

  const tryResolve = (ref: Anchor): RAnchor | undefined => {
    const result = resAnchorFromMap(ref, hashIndex);
    if ("kind" in result) {
      if (result.kind === "not_found") {
        const leasedLine = resolveFromLease?.(ref.hash);
        if (leasedLine !== undefined) {
          return { line: leasedLine, hash: ref.hash, hashMatched: true };
        }
      }
      mismatches.push(result);
      return undefined;
    }
    return result;
  };

  abortIf(signal);
  const startResolved = tryResolve(edit.hash_bounds[0]);
  const endResolved = tryResolve(edit.hash_bounds[1]);
  if (!startResolved || !endResolved) {
    if (!startResolved && endResolved) {
      const startMismatch = mismatches.findLast((m) => m.ref === edit.hash_bounds[0]);
      if (startMismatch && startMismatch.kind === "not_found") startMismatch.context = endResolved;
    } else if (startResolved && !endResolved) {
      const endMismatch = mismatches.findLast((m) => m.ref === edit.hash_bounds[1]);
      if (endMismatch && endMismatch.kind === "not_found") endMismatch.context = startResolved;
    }
    return { resolved: undefined, mismatches };
  }
  // Reversal always heals upstream in swapReversedRanges (which runs before
  // valEdit in applyEdit): when both anchors resolve, startLine <= endLine is
  // guaranteed, so no refusal arm exists here. Anchors carry no order — only
  // the resolved lines of the anchor_from/anchor_to slot pair matter.
  return {
    resolved: {
      content_lines: edit.content_lines,
      hash_bounds: [startResolved, endResolved],
    },
    mismatches,
  };
}

export type { ServedRow, RangeCause } from "../domain-errors.js";

// F8: narrowed to the codes the reject-and-serve branches actually handle —
// the class's meaning is type-enforced instead of carried by convention.
export class AnchorMismatchError extends DomainError<DomainErrorCode> {
  constructor(code: "E_STALE_ANCHOR" | "E_SUSPICIOUS_TEXT", payload: ErrorPayloadMap[typeof code]) {
    super(code, payload);
    this.name = "AnchorMismatchError";
  }
}
/** Thrown when replace_with carries anchor-syntax garbage (HASH│/diff-preview prefixes).
 * Carries the stripped edit so applyEdit can distinguish served-echo (→ E_SUSPICIOUS_TEXT
 * denial downstream) from garbage (→ E_MALFORMED_ANCHOR stands). @internal — instances
 * cross the seam as DomainError<"E_MALFORMED_ANCHOR">; the symbol has no importer. */
class BadAnchorError extends DomainError<"E_MALFORMED_ANCHOR"> {
  readonly stripped: HEdit;
  constructor(rawAnchor: string, reason: string, stripped: HEdit) {
    super("E_MALFORMED_ANCHOR", { rawAnchor, reason });
    this.name = "BadAnchorError";
    this.stripped = stripped;
  }
}
export function isAnchorMismatch(error: unknown): error is AnchorMismatchError {
  return error instanceof AnchorMismatchError;
}

export function findEditHashEcho(
  replacementLines: string[],
  served: readonly (string | null)[],
  startLine: number,
): { k: number; hash: string } | undefined {
  for (let k = 0; k < replacementLines.length; k++) {
    const pos = startLine + k - 1;
    if (
      pos < served.length &&
      served[pos] !== null &&
      replacementLines[k]!.startsWith(served[pos]! + HASH_SEP)
    ) {
      return { k: k + 1, hash: served[pos]! };
    }
  }
  return undefined;
}

/**
 * Served-echo refusal: the replacement reproduces a row actually served for
 * this session, path, and line. A DomainError<"E_SUSPICIOUS_TEXT"> whose
 * code, message header and audience agree — while staying instanceof
 * AnchorMismatchError so the existing reject-and-serve branches (which catch
 * AnchorMismatchError / ServedRejectionError) keep recognising it.
 */
export class EditHashEchoError extends AnchorMismatchError {
  constructor(payload: ErrorPayloadMap["E_SUSPICIOUS_TEXT"]) {
    super("E_SUSPICIOUS_TEXT", payload);
    this.name = "EditHashEchoError";
  }
}

type LIdx = {
  fileLines: string[];
  lineStarts: number[];
};

export function buildIdx(content: string): LIdx {
  const fileLines = splitLines(content);
  const lineStarts: number[] = [];
  let offset = 0;

  for (let index = 0; index < fileLines.length; index++) {
    lineStarts.push(offset);
    offset += fileLines[index]!.length;
    if (index < fileLines.length - 1) {
      offset += 1;
    }
  }

  return {
    fileLines,
    lineStarts,
  };
}

type RESpan = {
  kind: "replace";
  start: number;
  end: number;
  replacement: string;
};

type NoopSpan = {
  kind: "noop";
  loc: string;
  currentContent: string;
};
function assertNotEmpty(originalContent: string, result: string): void {
  if (originalContent.length > 0 && result.length === 0) {
    throw new DomainError("E_EMPTY_RANGE", {});
  }
}

function resToSpan(edit: RHEdit, content: string, lineIndex: LIdx): RESpan | NoopSpan {
  const { fileLines, lineStarts } = lineIndex;

  const startLine = edit.hash_bounds[0].line;
  const endLine = edit.hash_bounds[1].line;
  const originalLines = fileLines.slice(startLine - 1, endLine);
  if (
    originalLines.length === edit.content_lines.length &&
    originalLines.every((line, lineIndex) => line === edit.content_lines[lineIndex])
  ) {
    return {
      kind: "noop",
      loc: edit.hash_bounds[0].hash,
      currentContent: originalLines.join("\n"),
    };
  }

  if (edit.content_lines.length > 0) {
    return {
      kind: "replace",
      start: lineStarts[startLine - 1]!,
      end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
      replacement: edit.content_lines.join("\n"),
    };
  }

  if (startLine === 1 && endLine === fileLines.length) {
    return {
      kind: "replace",
      start: 0,
      end: content.length,
      replacement: "",
    };
  }

  if (endLine < fileLines.length) {
    return {
      kind: "replace",
      start: lineStarts[startLine - 1]!,
      end: lineStarts[endLine]!,
      replacement: "",
    };
  }

  if (content.endsWith("\n")) {
    return {
      kind: "replace",
      start: lineStarts[startLine - 1]!,
      end: content.length,
      replacement: "",
    };
  }

  const prevLine = startLine >= 2 ? fileLines[startLine - 2] : undefined;
  return {
    kind: "replace",
    start:
      prevLine !== undefined && prevLine.length === 0
        ? lineStarts[startLine - 1]!
        : Math.max(0, lineStarts[startLine - 1]! - 1),
    end: content.length,
    replacement: "",
  };
}

function assemble(content: string, span: RESpan, signal: AbortSignal | undefined): string {
  abortIf(signal);
  return content.slice(0, span.start) + span.replacement + content.slice(span.end);
}

export function applyEdit(
  content: string,
  edit: HEdit,
  signal?: AbortSignal,
  precomputedHashes?: string[],
  filePath?: string,
  served?: (string | null)[],
  servedCanons?: (string | null)[],
  retired?: ReadonlySet<string>,
  mode?: EditMode,
  leaseSource?: LeaseSpanSource,
  spanMode?: SpanMode,
): {
  content: string;
  firstChangedLine: number | undefined;
  lastChangedLine: number | undefined;
  range: ResolvedRange;
  warnings?: string[];
  noopEdit?: NEdit;
  neverServedCount?: number;
} {
  abortIf(signal);

  const lineIndex = buildIdx(content);
  const fileHashes = precomputedHashes ?? lineHashesPure(content);
  const warnings: string[] = [];
  const literal = mode === "literal";
  let bypassNoted = false;
  const noteLiteralBypass = (): void => {
    if (!bypassNoted) {
      bypassNoted = true;
      warnings.push(formatWarning("W_LITERAL_BYPASS", {}));
    }
  };

  const rangeFixed = swapReversedRanges(edit, fileHashes, warnings);
  let prefixFixed: HEdit;
  try {
    prefixFixed = stripDiffPrefixes(stripBarePrefixes(rangeFixed, fileHashes, warnings), warnings);
  } catch (error) {
    if (!(error instanceof BadAnchorError) || !served) throw error;
    // Anchor-syntax garbage that is actually served-echo belongs to the
    // E_SUSPICIOUS_TEXT guard below: re-check the stripped + raw lines at the
    // resolved start line and throw the echo denial; otherwise E_MALFORMED_ANCHOR stands.
    const stripped = error.stripped;
    const lineByHash = new Map<string, number>();
    for (let i = 0; i < fileHashes.length; i++) lineByHash.set(fileHashes[i]!, i + 1);
    const startLine = lineByHash.get(stripped.hash_bounds[0].hash);
    const echo =
      (startLine !== undefined
        ? findEditHashEcho(edit.content_lines, served, startLine)
        : undefined) ??
      (startLine !== undefined
        ? findEditHashEcho(stripped.content_lines, served, startLine)
        : undefined);
    if (echo) {
      if (literal) {
        // Declared literal bytes are the intent: apply the raw edit verbatim
        // (prefixes intact), not the stripped form. Non-echo garbage still
        // throws BadAnchorError below via `throw error`.
        prefixFixed = rangeFixed;
        noteLiteralBypass();
      } else {
        throw new EditHashEchoError({
          target: "edit",
          path: filePath ?? "(unknown file)",
          line: echo.k,
          hash: echo.hash,
          servedLine: startLine! + echo.k - 1,
        });
      }
    } else {
      throw error;
    }
  }

  // The lease-backed fallback for a held anchor whose bytes moved but whose canon did not (#138).
  // Built once per call: it is only consulted for an anchor the file's own hashes do not carry.
  const resolveFromLease = leaseAnchorLineResolver({
    leaseSource,
    served,
    servedCanons,
    fileLines: lineIndex.fileLines,
  });
  const { resolved: initialResolved, mismatches } = valEdit(
    prefixFixed,
    lineIndex.fileLines,
    fileHashes,
    warnings,
    signal,
    resolveFromLease,
  );
  if (mismatches.length || !initialResolved) {
    const { headline, servedBlock, servedRows } = fmtMismatchWithServes(
      mismatches,
      lineIndex.fileLines,
      fileHashes,
      filePath,
    );
    // WHY: "anchor staleness" now has a producer — this arm IS "the anchor no longer names a current
    // line"; payload-only (staleAnchorFormat ignores it), so the batch envelope forwards/promotes it.
    throw new AnchorMismatchError("E_STALE_ANCHOR", {
      headline,
      servedRows,
      servedBlock,
      cause: "anchor staleness",
    });
  }

  warnUnicodeEsc(prefixFixed, warnings);

  const resolved = initialResolved;

  if (served) {
    const startLineEcho = resolved.hash_bounds[0].line;
    const rawEcho = findEditHashEcho(edit.content_lines, served, startLineEcho);
    let echo = rawEcho;
    if (!echo) echo = findEditHashEcho(resolved.content_lines, served, startLineEcho);
    if (!echo) echo = findEditHashEcho(prefixFixed.content_lines, served, startLineEcho);
    if (echo) {
      if (literal) {
        noteLiteralBypass();
      } else {
        throw new EditHashEchoError({
          target: "edit",
          path: filePath ?? "(unknown file)",
          line: echo.k,
          hash: echo.hash,
          servedLine: startLineEcho + echo.k - 1,
        });
      }
    }
    const startAnchor = resolved.hash_bounds[0];
    const endAnchor = resolved.hash_bounds[1];
    verifyServedRange({
      served,
      startHash: startAnchor.hash,
      endHash: endAnchor.hash,
      startLine: startAnchor.line,
      endLine: endAnchor.line,
      fileHashes,
      fileLines: lineIndex.fileLines,
      filePath,
      servedCanons,
      retired,
      leaseSource,
      ...(spanMode !== undefined ? { spanMode } : {}),
    });
  }

  const spanResult = resToSpan(resolved, content, lineIndex);
  if (spanResult.kind === "noop") {
    return {
      content,
      firstChangedLine: undefined,
      lastChangedLine: undefined,
      range: resolvedRange(resolved),
      ...(warnings.length ? { warnings } : {}),
      noopEdit: {
        loc: spanResult.loc,
        currentContent: spanResult.currentContent,
      },
    };
  }

  const result = assemble(content, spanResult, signal);
  assertNotEmpty(content, result);
  const changed = changedRange(content, result);

  // FU-5 (§4.7 conformance, upstream apply.ts:387-427): the 0-matched literal
  // write-through (#63/ADR-0025) keeps writing, and these tiers name what was
  // written. Middle tier stays evidence-gated (`if (served)`): with no served
  // content it reports nothing by construction. Soft-hint tier is shape-only
  // and runs against an empty served set when served is absent — it fires
  // regardless of the literal declaration (the declaration covers served rows,
  // not never-served shapes). Never blocks, never rewrites, keeps no state.
  // FU-R (upstream apply.ts:399-401): the offending count travels as structured
  // data (`neverServedCount`); the engine aggregates across batch items and renders
  // one counted hint per call — this layer never renders the hint string itself.
  let neverServedCount = 0;
  if (served) {
    for (const mismatch of findServedPrefixMismatches(
      resolved.content_lines,
      served,
      servedCanons ?? [],
      1,
    )) {
      warnings.push(
        buildServedEditPrefixNote({
          k: mismatch.k,
          anchor: mismatch.anchor,
          servedLine: mismatch.servedLine,
        }),
      );
    }
  }
  const neverServed = findNeverServedAnchorShapes(resolved.content_lines, served ?? [], 1);
  if (neverServed.length > 0) {
    neverServedCount = neverServed.length;
  }

  return {
    content: result,
    firstChangedLine: changed?.firstChangedLine,
    lastChangedLine: changed?.lastChangedLine,
    range: resolvedRange(resolved),
    ...(warnings.length ? { warnings } : {}),
    ...(neverServedCount > 0 ? { neverServedCount } : {}),
  };
}

function resolvedRange(resolved: RHEdit): ResolvedRange {
  const [start, end] = resolved.hash_bounds;
  return {
    startLine: start.line,
    endLine: end.line,
    startHash: start.hash,
    endHash: end.hash,
    delta: resolved.content_lines.length - (Math.abs(end.line - start.line) + 1),
  };
}

export function fmtRegion(hashes: string[], lines: string[]): string {
  if (hashes.length !== lines.length) {
    throw new Error(
      `fmtRegion: hashes.length (${hashes.length}) must match lines.length (${lines.length}).`,
    );
  }
  // One renderer (ADR-0037): the guard above is this entry point's own fail-loud invariant; the
  // row kernel lives in served-evidence so the read echo and the region render cannot drift.
  return fmtServedRows(
    hashes.map((hash, index) => ({ position: index, hash })),
    lines,
  );
}

export function changedRange(
  original: string,
  result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
  if (original === result) return null;

  if (original.length === 0) {
    return {
      firstChangedLine: 1,
      lastChangedLine: splitLines(result).length,
    };
  }

  const originalLines = splitLines(original);
  const resultLines = splitLines(result);

  if (
    originalLines.length === resultLines.length &&
    originalLines.every((line, index) => line === resultLines[index])
  ) {
    return null;
  }

  const minLen = Math.min(originalLines.length, resultLines.length);
  let first = 0;
  while (first < minLen && originalLines[first] === resultLines[first]) {
    first++;
  }
  let lastOrig = originalLines.length - 1;
  let lastRes = resultLines.length - 1;
  while (
    lastOrig >= first &&
    lastRes >= first &&
    originalLines[lastOrig] === resultLines[lastRes]
  ) {
    lastOrig--;
    lastRes--;
  }
  return {
    firstChangedLine: first + 1,
    lastChangedLine: Math.max(first, lastRes) + 1,
  };
}

// ---------------------------------------------------------------------------
// Sealed seam — single public entry for hashline (Candidate 5)
// HashAssign allocation + hash persistence re-exported here so callers import
// only from anchor-pipeline. Private modules (hash-assign, hash, hasher,
// alphabet, pure, parse, apply, resolve, served) are @internal and guarded
// by biome noRestrictedImports. Deleting this re-export block would scatter
// the hashline surface again — it concentrates (deep).
// ---------------------------------------------------------------------------
export {
  HASH_RE,
  HASH_CLASS,
  HASH_SEP,
  ANCHOR_LEN,
  ALPH_RE,
  ALPH,
  HASH_LEN,
  HASH_SPACE,
  MAX_HASH_LINES,
  HASH_PROBE_STRIDE,
  CANON_VERSION,
  canon,
  lineHashesPure,
  mapStableHashes,
  initHasher,
  contentChecksum,
} from "./hash-assign.js";
export { lineHashes } from "./hash.js";
