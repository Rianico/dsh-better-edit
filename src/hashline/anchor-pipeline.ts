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
  canon,
  lineHashesPure,
} from "./hash-assign.js";
import { servedPositionsOf } from "../session-view.js";
import { SERVED_ECHO_CAP } from "../constants.js";
import { NEW_CONTENT_NOT_STRING_MSG, NEW_CONTENT_BODY } from "../constants.js";
import { DomainError, formatWarning, numericAnchorNote } from "../domain-errors.js";
import type { ErrorPayloadMap, ServedRow, DomainErrorCode } from "../domain-errors.js";
import type { EditMode } from "../contract.js";
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

  if (trimmed.includes("│") && trimmed.includes("\n")) {
    const lines = trimmed.split("\n");
    const first = lines[0] ?? "";
    const last = lines[lines.length - 1] ?? "";
    const hashRe = new RegExp(HASH_CLASS);
    const firstMatch = first.match(hashRe);
    const lastMatch = last.match(hashRe);
    const firstHash = firstMatch?.[0] ?? "wUp";
    const lastHash = lastMatch?.[0] ?? "AU6";
    const preview = first.slice(0, 60);
    return {
      rawAnchor: trimmed,
      reason: `anchor_from must be a single bare 3-char hash (e.g. "wUp"), not a block with HASH│. Received ${lines.length} lines starting "${preview}…" — use only the first hash "${firstHash}" as anchor_from and "${lastHash}" as anchor_to, and put the new content (without HASH│) in replace_with.`,
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
  const notFound = mismatches.filter((m) => m.kind === "not_found");
  const ambiguous = mismatches.filter((m) => m.kind === "ambiguous");

  const refList = notFound.map((m) => `"${m.ref.hash}"`).join(", ");
  if (notFound.length > 0) {
    headlines.push(
      // B: a well-formed all-digit anchor that does not resolve lands here;
      // the numeric note steers away from line numbers. E_UNKNOWN_ANCHOR
      // keeps the same note; T4 moves production there when it gains a producer.
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
function firstHashFromBlock(block: string): string | undefined {
  for (const line of block.split("\n")) {
    const m = line.match(ANCHOR_ROW_RE);
    if (m) return m[2]!;
    const bare = line.match(new RegExp(HASH_CLASS));
    if (bare) return bare[0]!;
  }
  return undefined;
}

export function resEdit(edit: HTEdit, _warnings?: string[]): HEdit {
  assertItem(edit as Record<string, unknown>);

  const editLines = parseText(edit.replace_with);
  const bounds = [edit.anchor_from, edit.anchor_to].map((ref) => {
    const trimmed = ref.trim();
    if (trimmed.includes("\n")) {
      const hash = firstHashFromBlock(trimmed);
      if (hash) {
        const lines = trimmed.split("\n").length;
        throw new DomainError("E_MALFORMED_ANCHOR", {
          rawAnchor: trimmed,
          reason: `extracted first hash "${hash}" from ${lines}-line block — use bare "${hash}" next time`,
        });
      }
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
  const locations = stripped.map((s) => `replace_with line ${s.lineIndex + 1}`).join(", ");
  const matchedCount = stripped.filter((s) => s.matched).length;
  const evidence =
    matchedCount === 0
      ? "0 matched — verify literal 'HASH│' content"
      : `${matchedCount}/${stripped.length} matched`;
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

/** @internal — private to anchor-pipeline seam */
function valEdit(
  edit: HEdit,
  fileLines: string[],
  fileHashes: string[],
  warnings: string[],
  signal: AbortSignal | undefined,
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
  const endLine = endResolved.line;
  return {
    resolved: {
      content_lines: edit.content_lines,
      hash_bounds: [startResolved, endResolved],
    },
    mismatches,
  };
}

export function findNewEdge(): undefined {
  return undefined;
}

export { warnUnicodeEsc };

export type ServedCode = "E_STALE_RANGE" | "E_UNSERVED_RANGE";

export type { ServedRow, RangeCause } from "../domain-errors.js";
export class ServedRejectionError extends DomainError<DomainErrorCode> {
  readonly code: ServedCode;
  readonly unservedKind: "boundary" | "interior" | undefined;

  constructor(
    opts:
      | {
          code: "E_STALE_RANGE";
          headline: string;
          servedRows: ServedRow[];
          servedBlock: string;
          firstOffendingLine?: number;
          reread?: boolean;
        }
      | {
          code: "E_UNSERVED_RANGE";
          headline: string;
          servedRows: ServedRow[];
          servedBlock: string;
          /** Same contract as the `E_STALE_RANGE` branch: true omits the retry hint. */
          reread?: boolean;
          unservedKind: "boundary" | "interior";
          firstOffendingLine?: number;
        },
  ) {
    if (opts.code === "E_STALE_RANGE") {
      super("E_STALE_RANGE", {
        headline: opts.headline,
        servedRows: opts.servedRows,
        servedBlock: opts.servedBlock,
        ...(opts.firstOffendingLine !== undefined
          ? { firstOffendingLine: opts.firstOffendingLine }
          : {}),
        ...(opts.reread !== undefined ? { reread: opts.reread } : {}),
      });
    } else {
      super("E_UNSERVED_RANGE", {
        headline: opts.headline,
        servedRows: opts.servedRows,
        servedBlock: opts.servedBlock,
        unservedKind: opts.unservedKind,
        ...(opts.firstOffendingLine !== undefined
          ? { firstOffendingLine: opts.firstOffendingLine }
          : {}),
        ...(opts.reread !== undefined ? { reread: opts.reread } : {}),
      });
    }
    this.name = "ServedRejectionError";
    this.code = opts.code;
    this.unservedKind = opts.code === "E_UNSERVED_RANGE" ? opts.unservedKind : undefined;
  }
}

export function isServedRejection(error: unknown): error is ServedRejectionError {
  return error instanceof ServedRejectionError;
}

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
 * denial downstream) from garbage (→ E_MALFORMED_ANCHOR stands). */
export class BadAnchorError extends DomainError<"E_MALFORMED_ANCHOR"> {
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

export function buildRangeEcho(
  startLine: number,
  endLine: number,
  fileHashes: string[],
): ServedRow[] {
  const total = endLine - startLine + 1;
  const shown = Math.min(total, SERVED_ECHO_CAP);
  const rows: ServedRow[] = [];
  for (let ln = startLine; ln < startLine + shown; ln++) {
    rows.push({ position: ln - 1, hash: fileHashes[ln - 1]! });
  }
  return rows;
}

export function fmtServedRows(rows: ServedRow[], fileLines: string[]): string {
  return rows.map((row) => `${row.hash}${HASH_SEP}${fileLines[row.position] ?? ""}`).join("\n");
}
function paginationHint(nextOffset: number, more: number): string {
  return `[... ${more} more — read offset=${nextOffset}]`;
}
/**
 * SAFETY: the read-only identity seam the edit path resolves a served anchor through (CP2-r1,
 * obligation (c)). Production wires it to `served_leases` + `line_lineage`; tests inject plain
 * maps. Nothing here writes: the authoritative `retired_at` writer is materialization.
 */
export interface LeaseIdentityView {
  lineId: number;
  servedLineNumber: number;
  servedSnapshotHash: string;
  retiredAt: number | null;
}

/**
 * The lease source a served span is verified against when identity is available.
 * `leaseFor` is a per-anchor lookup; `rebasedLineOf` answers where a leased `line_id` lives in the
 * buffer being edited (the store's `positionsByIdentity`).
 */
export interface LeaseSpanSource {
  leaseFor(anchor: string): LeaseIdentityView | undefined;
  rebasedLineOf(lineId: number): number | undefined;
}

/**
 * The identity gate for a served span (obligation (c)) — replaces the unconditional position check
 * when a lease source is present.
 *
 * A **benign shift** — the intended line's bytes are unchanged and only its position moved (exterior
 * drift above the served span) — passes: the served anchor's live lease resolves to the rebased
 * coordinate the edit targets, so the edit applies there with no re-read. A **look-alike rebind** —
 * the named line was deleted and a different line now holds the same bytes — rejects: the leased
 * `line_id` no longer lives at the rebased coordinate, or is gone from the buffer's identity map
 * entirely, so the anchor cannot be reconciled with the line it named.
 *
 * Fail-closed on every arm: an unleased served row (a serve predating lease granting), a retired
 * lease, a coordinate no leased identity occupies, or a window length that changed because an
 * external insert/delete landed strictly inside the span all reject with `E_STALE_RANGE` and the
 * echo rows, so the retry story stays the position check's own. Throwing happens before any write,
 * so a rejection leaves the file byte-identical.
 */
export function verifyRebasedSpan(args: {
  served: (string | null)[];
  servedStart: number;
  servedEnd: number;
  rebasedStart: number;
  rebasedEnd: number;
  leaseSource: LeaseSpanSource;
  echo: string;
  echoRows: ServedRow[];
  where: string;
}): void {
  const { served, leaseSource, echo, echoRows, where } = args;
  const servedLen = args.servedEnd - args.servedStart + 1;
  const rebasedLen = args.rebasedEnd - args.rebasedStart + 1;
  if (rebasedLen !== servedLen) {
    throw new ServedRejectionError({
      code: "E_STALE_RANGE",
      headline: `served span (${servedLen} lines) no longer matches the rebased range (${rebasedLen} lines)${where}.`,
      servedBlock: echo,
      reread: true,
      firstOffendingLine: args.rebasedStart,
      servedRows: echoRows,
    });
  }
  for (let k = 0; k < servedLen; k++) {
    const servedAnchor = served[args.servedStart - 1 + k];
    const currentLine = args.rebasedStart + k;
    // Fail-closed guard: a null row inside the window is an unserved line, and this gate is
    // exported and directly callable, so it must not skip one. Through `verifyServedRange` the
    // interior-null rule already rejected this and the two boundary positions ARE the named
    // anchors — but a future caller can reach it, so it rejects like every other arm (dsh's own
    // interior rule; we deliberately do not adopt upstream's ADR-0024 tolerance).
    if (servedAnchor === null || servedAnchor === undefined) {
      throw new ServedRejectionError({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} is not served; re-read to serve it.`,
        servedBlock: echo,
        reread: true,
        firstOffendingLine: currentLine,
        servedRows: echoRows,
      });
    }
    const lease = leaseSource.leaseFor(servedAnchor);
    if (lease === undefined) {
      throw new ServedRejectionError({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} has no served line identity; re-read to lease it.`,
        servedBlock: echo,
        reread: true,
        firstOffendingLine: currentLine,
        servedRows: echoRows,
      });
    }
    if (lease.retiredAt !== null) {
      throw new ServedRejectionError({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} was retired since it was served. Re-read.`,
        servedBlock: echo,
        reread: true,
        firstOffendingLine: currentLine,
        servedRows: echoRows,
      });
    }
    if (leaseSource.rebasedLineOf(lease.lineId) !== currentLine) {
      throw new ServedRejectionError({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} no longer resolves to the line identity it was served with. Re-read.`,
        servedBlock: echo,
        reread: true,
        firstOffendingLine: currentLine,
        servedRows: echoRows,
      });
    }
  }
}

export function verifyServedRange(args: {
  served: (string | null)[];
  startHash: string;
  endHash: string;
  startLine: number;
  endLine: number;
  fileHashes: string[];
  fileLines: string[];
  filePath?: string;
  servedCanons?: (string | null)[];
  retired?: ReadonlySet<string>;
  /**
   * Present => the identity gate (`verifyRebasedSpan`) replaces the position check below
   * (obligation (c)). Absent => the unconditional position check. Identity only, never a weaker
   * position check.
   */
  leaseSource?: LeaseSpanSource;
}): void {
  const { served, startHash, endHash, startLine, endLine, fileHashes, fileLines, filePath } = args;
  const where = filePath ? ` in ${filePath}` : "";
  const retiredSet = args.retired ?? new Set<string>();
  const servedCanons = args.servedCanons;
  const echoRows = buildRangeEcho(startLine, endLine, fileHashes);
  const totalLen = endLine - startLine + 1;
  const tail =
    echoRows.length < totalLen
      ? `\n${paginationHint(startLine + echoRows.length, totalLen - echoRows.length)}`
      : "";
  const echo = fmtServedRows(echoRows, fileLines) + tail;

  // Tombstone check for boundaries (whole-span S@3==S@3)
  // If hash was freed in this epoch, any reuse is stale even at same pos+same canon.
  // Early reject checks canon change to avoid false positive on same line re-read.
  if (retiredSet.has(startHash) || retiredSet.has(endHash)) {
    const retiredHash = retiredSet.has(startHash) ? startHash : endHash;
    if (servedCanons) {
      const pos = fileHashes.indexOf(retiredHash);
      if (pos >= 0) {
        const servedIdx = served.indexOf(retiredHash);
        const expected = servedIdx >= 0 ? servedCanons[servedIdx] : undefined;
        const actual = canon(fileLines[pos] ?? "");
        if (expected !== undefined && expected !== null && expected !== actual) {
          throw new ServedRejectionError({
            code: "E_STALE_RANGE",
            headline: `anchor "${retiredHash}" was freed since last full read (retired, canon changed from "${expected}" to "${actual}"). Re-read.`,
            servedBlock: echo,
            reread: true,
            firstOffendingLine: pos + 1,
            servedRows: echoRows,
          });
        }
      }
    }
  }

  const startPositions = servedPositionsOf(served, startHash);
  const endPositions = servedPositionsOf(served, endHash);
  const currentLen = endLine - startLine + 1;
  let from: number | undefined;
  let to: number | undefined;
  // Exact-boundary rule (ADR-0018, superseding ADR-0004): each boundary anchor must have
  // EXACTLY one served position. Anything else leaves `from`/`to` undefined and rejects
  // below — there is no candidate-span search that could re-bind onto a look-alike line.
  if (startPositions.length === 1 && endPositions.length === 1) {
    from = Math.min(startPositions[0]!, endPositions[0]!);
    to = Math.max(startPositions[0]!, endPositions[0]!);
  }
  if (from === undefined || to === undefined) {
    const problems: string[] = [];
    if (startPositions.length === 0) {
      problems.push(`anchor_from "${startHash}" has no served position`);
    } else if (startPositions.length > 1) {
      problems.push(`anchor_from "${startHash}" was served at ${startPositions.length} positions`);
    }
    if (endPositions.length === 0) {
      problems.push(`anchor_to "${endHash}" has no served position`);
    } else if (endPositions.length > 1) {
      problems.push(`anchor_to "${endHash}" was served at ${endPositions.length} positions`);
    }
    throw new ServedRejectionError({
      code: "E_UNSERVED_RANGE",
      unservedKind: "boundary",
      headline:
        `cannot verify range against served state${where}: ${problems.join("; ")}. ` +
        `Each boundary anchor must have exactly one served position — no served span is searched ` +
        `for a look-alike line. A full read will re-sync the served mirror; the echoed range below ` +
        `is current content.`,
      servedBlock: echo,
      reread: true,
      servedRows: echoRows,
    });
  }

  for (let i = from; i <= to; i++) {
    if (served[i] === null) {
      throw new ServedRejectionError({
        code: "E_UNSERVED_RANGE",
        unservedKind: "interior",
        headline: `line ${i + 1}${where} was never served.`,
        servedBlock: echo,
        reread: true,
        firstOffendingLine: i + 1,
        servedRows: echoRows,
      });
    }
  }
  const servedLen = to - from + 1;
  if (servedLen !== currentLen) {
    throw new ServedRejectionError({
      code: "E_STALE_RANGE",
      headline: `served span (${servedLen} lines) no longer matches current range (${currentLen} lines)${where}. Re-read.`,
      servedBlock: echo,
      reread: true,
      firstOffendingLine: startLine,
      servedRows: echoRows,
    });
  }
  // Position check or identity gate — the seam is opt-in (obligation (c)).
  //
  // With a lease source, identity decides: `verifyRebasedSpan` checks the whole served window by
  // the leases its anchors were served with, so a benign shift (same bytes, moved position —
  // exterior drift above the span) applies at its rebased coordinate with no re-read, while a
  // look-alike rebind (the named line was deleted and another line now holds its bytes) rejects.
  //
  // Without a lease source the unconditional position check below stands: identity only, never a
  // weaker position check. The pos-free route is REACHABLE on a normal session route (a windowed
  // read never pinned the epoch; a preview/no-store edit carries no leases), which is why this
  // fallback cannot be dropped.
  if (args.leaseSource !== undefined) {
    verifyRebasedSpan({
      served,
      servedStart: from + 1,
      servedEnd: to + 1,
      rebasedStart: startLine,
      rebasedEnd: endLine,
      leaseSource: args.leaseSource,
      echo,
      echoRows,
      where,
    });
  } else if (from !== startLine - 1) {
    throw new ServedRejectionError({
      code: "E_STALE_RANGE",
      headline: `anchor was served at line ${from + 1} but now resolves to line ${startLine}. Re-read.`,
      servedBlock: echo,
      reread: true,
      firstOffendingLine: startLine,
      servedRows: echoRows,
    });
  }
  // Canon check for same-pos different content (collision)
  if (servedCanons) {
    for (let k = 0; k < servedLen; k++) {
      const expected = servedCanons[from + k];
      if (expected !== null && expected !== undefined) {
        const actual = canon(fileLines[startLine - 1 + k] ?? "");
        if (expected !== actual) {
          throw new ServedRejectionError({
            code: "E_STALE_RANGE",
            headline: `line ${startLine + k}${where} canon differs from served (expected "${expected}" vs actual "${actual}").`,
            servedBlock: echo,
            reread: true,
            firstOffendingLine: startLine + k,
            servedRows: echoRows,
          });
        }
      }
    }
  }
  // Tombstone interior check (whole-span) — gated on canon inequality (fail-closed only for different canon)
  for (let k = 0; k < servedLen; k++) {
    const h = fileHashes[startLine - 1 + k];
    if (h && retiredSet.has(h)) {
      const expectedCanon = servedCanons?.[from + k] ?? undefined;
      const actualCanon = canon(fileLines[startLine - 1 + k] ?? "");
      if (expectedCanon !== undefined && expectedCanon !== null && expectedCanon !== actualCanon) {
        throw new ServedRejectionError({
          code: "E_STALE_RANGE",
          headline: `line ${startLine + k}${where} uses retired anchor "${h}" (freed since last full read, canon changed). Re-read.`,
          servedBlock: echo,
          reread: true,
          firstOffendingLine: startLine + k,
          servedRows: echoRows,
        });
      }
    }
  }
  for (let k = 0; k < servedLen; k++) {
    if (served[from + k] !== fileHashes[startLine - 1 + k]) {
      const offendingLine = startLine + k;
      throw new ServedRejectionError({
        code: "E_STALE_RANGE",
        headline: `line ${offendingLine}${where} differs from what was served. Re-read.`,
        servedBlock: echo,
        reread: true,
        firstOffendingLine: offendingLine,
        servedRows: echoRows,
      });
    }
  }
}

export interface ResolvedRange {
  startLine: number;
  endLine: number;
  startHash: string;
  endHash: string;
  delta: number;
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
): {
  content: string;
  firstChangedLine: number | undefined;
  lastChangedLine: number | undefined;
  range: ResolvedRange;
  warnings?: string[];
  noopEdit?: NEdit;
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

  const { resolved: initialResolved, mismatches } = valEdit(
    prefixFixed,
    lineIndex.fileLines,
    fileHashes,
    warnings,
    signal,
  );
  if (mismatches.length || !initialResolved) {
    const { headline, servedBlock, servedRows } = fmtMismatchWithServes(
      mismatches,
      lineIndex.fileLines,
      fileHashes,
      filePath,
    );
    throw new AnchorMismatchError("E_STALE_ANCHOR", { headline, servedRows, servedBlock });
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

  return {
    content: result,
    firstChangedLine: changed?.firstChangedLine,
    lastChangedLine: changed?.lastChangedLine,
    range: resolvedRange(resolved),
    ...(warnings.length ? { warnings } : {}),
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
  return lines.map((line, index) => `${hashes[index]}${HASH_SEP}${line}`).join("\n");
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
