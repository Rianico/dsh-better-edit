/**
 * FileEncodingState — deep module owning the file encoding state round-trip.
 *
 * Single seam for deterministic admission (BOM → strict UTF-8 → autoGuess gate
 * → Top-3 always pushed), canonical encoding enum, version-invalidated memo,
 * and BOM+lineEnding round-trip. Previously scattered across fs-bridge
 * (branching + fallback Map + Top-3), encoding.ts (pure scoring), and
 * file-view/fs-write (stripBOM/detectEnding/encode back). Now one file owns
 * the invariant; deleting it would scatter round-trip fidelity (deep).
 *
 * Interface is the test surface: pure decode is tested without filesystem,
 * IO adapters (fs-bridge) are thin. `store-config.autoGuessEncoding` stays the
 * only config knob — this module reads it but does not own it.
 *
 * @module dsh-better-edit/file-encoding-state
 */

import {
  detectBom,
  isValidUtf8,
  decodeBytes,
  encodeText,
  normalizeEncoding,
  top3Candidates,
  chardetTop3Candidates,
} from "./encoding.js";
import type { CandidatePreview } from "./encoding.js";
import { detectEnding, restoreEndings, toLF, type LineEnding } from "./edit-diff.js";
import { DomainError, formatError } from "./domain-errors.js";

/**
 * The decode hint a mutating re-read must pass to the byte seam: the encoding
 * recorded by the preceding `read({ encoding })` — but only while the memo still
 * matches the on-disk version, and only for encodings the plain read path cannot
 * reproduce.
 *
 * `utf8` / `utf8bom` need no hint: BOM sniff + strict UTF-8 (and the bridge's
 * stripped-BOM restore) already decode them to the text the anchors were served
 * for, so asking for a byte reread would only cost an RPC. Everything else
 * (utf16le, windows-1251, GBK, …) is invisible to the plain path — without the
 * hint the mutation re-read decodes lossily or fails, which is the stale-anchor /
 * unsupported-file symptom this hint removes (issue #112).
 *
 * A drifted memo is dropped first, so a changed file is re-detected instead of
 * having the old encoding laundered onto its new bytes.
 */
export function encodingHintAtVersion(
  targetKey: string,
  currentVersion: string | undefined,
): string | undefined {
  invalidateIfStale(targetKey, currentVersion);
  const encoding = encodingMemo.get(targetKey)?.encoding;
  if (encoding === undefined || encoding === "utf8" || encoding === "utf8bom") return undefined;
  return encoding;
}

// ---------------------------------------------------------------------------
// State — per-targetKey, session-TTL, version-invalidated
// ---------------------------------------------------------------------------

export interface FileEncodingState {
  encoding: string;
  hasBOM: boolean;
  lineEnding?: LineEnding;
  version: string | undefined;
}

const encodingMemo = new Map<string, FileEncodingState>();
const autoGuessFooterMemo = new Map<string, string>();

export function getEncodingState(targetKey: string): FileEncodingState | undefined {
  return encodingMemo.get(targetKey);
}

export function setEncodingState(targetKey: string, state: FileEncodingState): void {
  encodingMemo.set(targetKey, state);
}

export function clearEncodingState(targetKey?: string): void {
  if (targetKey) encodingMemo.delete(targetKey);
  else encodingMemo.clear();
}

export function getAutoGuessFooter(targetKey: string): string | undefined {
  return autoGuessFooterMemo.get(targetKey);
}

export function setAutoGuessFooter(targetKey: string, footer: string): void {
  autoGuessFooterMemo.set(targetKey, footer);
}

export function clearAutoGuessFooter(targetKey?: string): void {
  if (targetKey) autoGuessFooterMemo.delete(targetKey);
  else autoGuessFooterMemo.clear();
}

/** Invalidate memo when FsVersion drifted (ADR-0012). */
export function invalidateIfStale(targetKey: string, currentVersion: string | undefined): void {
  const memo = encodingMemo.get(targetKey);
  if (memo && memo.version !== currentVersion) encodingMemo.delete(targetKey);
}

// ---------------------------------------------------------------------------
// Pure helpers — no IO
// ---------------------------------------------------------------------------

export function buildTop3Description(candidates: CandidatePreview[]): string {
  const candStr = candidates
    .map((c) => `${c.encoding}("${c.sample.slice(0, 20).replace(/"/g, "'")}")`)
    .join(", ");
  return `not readable UTF-8 text — top guesses: ${candStr}; try read({encoding: "<encoding>"}) or set DSH_BETTER_EDIT_AUTO_GUESS_ENCODING=true to auto-decode`;
}
export function buildTop3ErrorMessage(displayPath: string, candidates: CandidatePreview[]): string {
  return formatError("E_UNSUPPORTED_FILE", {
    path: displayPath,
    kind: "binary",
    description: buildTop3Description(candidates),
  });
}

function buildAutoGuessFooterFromCandidates(
  candidates: Array<{ encoding: string; confidence?: number; score?: number; sample?: string }>,
): string {
  // chardet path vs heuristic path share same footer shape, just score vs confidence
  const candsStr = candidates
    .map((c) => {
      const score =
        c.confidence !== undefined
          ? String(c.confidence)
          : c.score !== undefined
            ? c.score.toFixed(0)
            : "0";
      return `${c.encoding} ${score}`;
    })
    .join(", ");
  const top = candidates[0]!;
  const topScore =
    top.confidence !== undefined
      ? String(top.confidence)
      : top.score !== undefined
        ? (top.score as number).toFixed(0)
        : "0";
  return `\n\n[Auto-guessed: ${top.encoding} ${topScore}, candidates: ${candsStr} — re-read with read({encoding}) if garbled]`;
}

function isMidConfidenceChardet(
  top: { confidence: number },
  second?: { confidence: number },
): boolean {
  return top.confidence < 70 || (second !== undefined && top.confidence - second.confidence < 10);
}

function isMidConfidenceHeuristic(best: CandidatePreview, second?: CandidatePreview): boolean {
  return second !== undefined && best.score - second.score < 10;
}

// ---------------------------------------------------------------------------
// Deterministic admission — BOM → strict UTF-8 → autoGuess gate → Top-3
// always surfaced. Pure: takes bytes + config, returns decode or throws.
// ---------------------------------------------------------------------------

export interface DecodeAdmissionConfig {
  autoGuessEncoding: boolean;
  supportedEncodings: string[];
}

export interface DecodeForOpenResult {
  text: string;
  encoding: string;
  hasBOM: boolean;
  lineEnding: LineEnding;
  footer?: string;
  candidates: CandidatePreview[];
}

export interface DecodeForOpenOptions {
  encodingHint?: string;
  displayPath?: string;
}

/**
 * Deterministic admission for a raw byte buffer. No IO, no side effects
 * except Top-3 scoring. Caller owns recording the returned state via
 * `recordOpenState` and handling the footer vs E_UNSUPPORTED_FILE split.
 *
 * Order is fixed: BOM sniff always precedes strict UTF-8, which always
 * precedes guessing. Probabilistic encodings are last resort, gated by
 * `autoGuessEncoding`, but Top-3 is always computed for the error/ footer.
 */
export async function decodeForOpen(
  bytes: Uint8Array,
  config: DecodeAdmissionConfig,
  opts: DecodeForOpenOptions = {},
): Promise<DecodeForOpenResult> {
  const hint = opts.encodingHint ? normalizeEncoding(opts.encodingHint) : undefined;
  if (opts.encodingHint && !hint) {
    throw new DomainError("E_BAD_PAYLOAD", { message: `Unknown encoding: ${opts.encodingHint}` });
  }

  // 1) Explicit hint (Reopen with Encoding) — caller already chose, no autoGuess
  if (hint) {
    const bom = detectBom(bytes);
    // If BOM present, it wins for hasBOM but hint wins for decode (VS Code)
    const off = bom ? bom.bomLen : 0;
    const slice = bom ? bytes.subarray(off) : bytes;
    // For BOM encodings, decode the full bytes (including BOM) via helper; otherwise hint
    let decoded: string | undefined;
    if (
      bom &&
      (bom.encoding === "utf8bom" ||
        bom.encoding === "utf16le" ||
        bom.encoding === "utf16be" ||
        bom.encoding === "utf32le" ||
        bom.encoding === "utf32be")
    ) {
      // When hint differs from BOM, hint takes precedence for decoding the slice
      // but we preserve hasBOM from BOM sniff. For utf variants, BOM encoding
      // already handled; for explicit hint we decode slice with hint.
      decoded = decodeBytes(slice, hint);
      if (decoded === undefined)
        throw new DomainError("E_UNSUPPORTED_FILE", {
          path: opts.displayPath ?? "(unknown path)",
          kind: "binary",
          description: `cannot decode bytes as ${hint}`,
        });
      return {
        text: decoded,
        encoding: hint,
        hasBOM: !!bom,
        lineEnding: detectEnding(decoded),
        candidates: [],
      };
    }
    decoded = decodeBytes(slice, hint);
    if (decoded === undefined)
      throw new DomainError("E_UNSUPPORTED_FILE", {
        path: opts.displayPath ?? "(unknown path)",
        kind: "binary",
        description: `cannot decode bytes as ${hint}`,
      });
    return {
      text: decoded,
      encoding: hint,
      hasBOM: !!bom,
      lineEnding: detectEnding(decoded),
      candidates: [],
    };
  }

  // 2) BOM sniff — deterministic, before UTF-8
  const bom = detectBom(bytes);
  if (bom) {
    const decoded = decodeBytes(bytes, bom.encoding);
    if (decoded !== undefined) {
      return {
        text: decoded,
        encoding: bom.encoding,
        hasBOM: true,
        lineEnding: detectEnding(decoded),
        candidates: [],
      };
    }
  }

  // 3) Strict UTF-8 fatal:true — deterministic
  if (isValidUtf8(bytes)) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      text,
      encoding: "utf8",
      hasBOM: false,
      lineEnding: detectEnding(text),
      candidates: [],
    };
  }

  // 4) AutoGuess gate — probabilistic, last resort
  if (config.autoGuessEncoding) {
    // Try chardet first (Top-1 with footer for mid-confidence)
    try {
      const chardetCands = await chardetTop3Candidates(bytes, config.supportedEncodings);
      if (chardetCands.length > 0) {
        const top = chardetCands[0]!;
        const second = chardetCands[1];
        const isMid = isMidConfidenceChardet(top, second);
        const dec = decodeBytes(bytes, top.encoding);
        if (dec !== undefined && !dec.includes("\uFFFD")) {
          let footer: string | undefined;
          if (isMid) footer = buildAutoGuessFooterFromCandidates(chardetCands);
          return {
            text: dec,
            encoding: top.encoding,
            hasBOM: false,
            lineEnding: detectEnding(dec),
            footer,
            candidates: chardetCands.map((c) => ({
              encoding: c.encoding,
              sample: c.sample,
              score: c.confidence,
            })),
          };
        }
      }
    } catch {
      // best-effort
    }

    const candidates = top3Candidates(bytes, config.supportedEncodings);
    if (candidates.length > 0) {
      const best = candidates[0]!;
      const second = candidates[1];
      const isMid = isMidConfidenceHeuristic(best, second);
      const dec = decodeBytes(bytes, best.encoding);
      if (dec !== undefined) {
        // Always produce footer for heuristic path (mid check decides but we always have candidates)
        // Keep existing behavior: always a footer for heuristic, but mid decides inclusion — for now always include
        // to match prior fs-bridge which always built footerHeu.
        void isMid;
        const footer = buildAutoGuessFooterFromCandidates(candidates);
        return {
          text: dec,
          encoding: best.encoding,
          hasBOM: false,
          lineEnding: detectEnding(dec),
          footer,
          candidates,
        };
      }
    }
    // No candidate succeeded — fall through to E_UNSUPPORTED_FILE with Top-3
  }

  // 5) E_UNSUPPORTED_FILE + Top-3 always pushed (even when autoGuess off)
  // Use chardet Top-3 when available, else heuristic Top-3 — same as fs-bridge fallback
  let candidates: CandidatePreview[] = [];
  try {
    const chardetCands = await chardetTop3Candidates(bytes, config.supportedEncodings);
    if (chardetCands.length > 0) {
      candidates = chardetCands.map((c) => ({
        encoding: c.encoding,
        sample: c.sample,
        score: c.confidence,
      }));
    } else {
      candidates = top3Candidates(bytes, config.supportedEncodings);
    }
  } catch {
    candidates = top3Candidates(bytes, config.supportedEncodings);
  }
  const display = opts.displayPath ?? "(unknown path)";
  throw new DomainError("E_UNSUPPORTED_FILE", {
    path: display,
    kind: "binary",
    description: buildTop3Description(candidates),
  });
}

// ---------------------------------------------------------------------------
// Recording helpers — caller supplies targetKey + version after decode
// ---------------------------------------------------------------------------

export function recordOpenState(
  targetKey: string,
  text: string,
  encoding: string,
  hasBOM: boolean,
  version: string | undefined,
): FileEncodingState {
  const state: FileEncodingState = {
    encoding,
    hasBOM,
    lineEnding: detectEnding(text),
    version,
  };
  setEncodingState(targetKey, state);
  return state;
}

export function recordFooter(targetKey: string, footer: string | undefined): void {
  if (footer) setAutoGuessFooter(targetKey, footer);
}

// ---------------------------------------------------------------------------
// Save side — invert state, handle hasBOM + lineEnding, memo update
// ---------------------------------------------------------------------------

export interface EncodeForSaveOptions {
  encodingHint?: string;
  normalizeToUtf8?: boolean;
  currentVersion?: string | undefined;
  /** Model-facing path for the round-trip refusal. */
  displayPath?: string;
}

/** Shared UTF-8 BOM marker — single source for the BOM round-trip seam.
 * Prefer `prepareForSave` / `stripBOM` over re-implementing this check. */
export const UTF8_BOM = "\uFEFF";

/**
 * True when the text's UTF-8 byte image is byte-identical to its byte image
 * under `encoding` — an ASCII-only file in a single-byte charset, where the
 * text-only write seam reproduces the original bytes exactly. Checking bytes
 * (not the encoding name) is what keeps that file editable.
 *
 * This is a property of the TEXT only. A recorded `hasBOM` is a property of the
 * FILE and is checked separately at the call site: the legacy BOM bytes cannot be
 * reproduced by a UTF-8 string write (a UTF-8 BOM is a different byte image).
 */
export function isByteFaithfulAsUtf8(text: string, encoding: string): boolean {
  if (encoding === "utf8" || encoding === "utf8bom") return true;
  const encoded = encodeText(text, encoding);
  if (encoded === undefined) return false;
  const utf8 = new TextEncoder().encode(text);
  if (encoded.length !== utf8.length) return false;
  for (let i = 0; i < utf8.length; i += 1) if (encoded[i] !== utf8[i]) return false;
  return true;
}

/**
 * Decide what bytes (as text, since the write seam takes a string) to write and
 * what new state to record. BOM and lineEnding are restored here when a state
 * exists; otherwise defaults are UTF-8 without BOM and LF.
 *
 * ROUND-TRIP VERDICT: the bridge's only write is `writeText(target, content:
 * string, …)`, which every backend encodes as UTF-8. So the save side can
 * restore BOM + line ending for the UTF-8 family, and can write a legacy file
 * only when its UTF-8 byte image is identical (ASCII-only). Anything else
 * throws `E_ENCODING_UNWRITABLE` BEFORE the write, because writing UTF-8 would
 * silently transcode the file and leave the anchors describing other bytes.
 * `normalizeToUtf8: true` is the explicit migration: write UTF-8 and record
 * `utf8` so the next read agrees with the bytes.
 */
export function prepareForSave(
  content: string,
  existingState: FileEncodingState | undefined,
  opts: EncodeForSaveOptions = {},
): { textToWrite: string; newState?: FileEncodingState } {
  const displayPath = opts.displayPath ?? "(unknown path)";
  const normalize = opts.normalizeToUtf8 === true;

  if (opts.encodingHint) {
    const norm = normalizeEncoding(opts.encodingHint);
    if (!norm)
      throw new DomainError("E_BAD_PAYLOAD", { message: `Unknown encoding: ${opts.encodingHint}` });
    // A non-UTF-8 hint names an encoding the UTF-8 text write cannot reproduce
    // except byte-faithfully; a recorded BOM adds bytes it cannot reproduce at all.
    const hintFaithful =
      (norm === "utf8" || norm === "utf8bom" || isByteFaithfulAsUtf8(content, norm)) &&
      !(existingState?.hasBOM === true && norm !== "utf8bom");
    if (!hintFaithful)
      throw new DomainError("E_ENCODING_UNWRITABLE", { path: displayPath, encoding: norm });
    const hasBOM = norm === "utf8bom";
    const lineEnding: LineEnding = existingState?.lineEnding ?? detectEnding(content);
    // Caller writes `content` as a UTF-8 string; record what the next read detects.
    return {
      textToWrite: content,
      newState: { encoding: norm, hasBOM, lineEnding, version: undefined },
    };
  }

  if (!existingState) {
    // New file, no memo: UTF-8, caller's own line endings.
    return { textToWrite: content };
  }

  const recorded = existingState.encoding;
  const lineEnding: LineEnding = existingState.lineEnding ?? detectEnding(content);

  if (recorded !== "utf8" && recorded !== "utf8bom") {
    const body = restoreEndings(toLF(content), lineEnding);
    // A recorded BOM on a non-UTF-8 encoding means bytes the text write cannot
    // reproduce (e.g. read({ encoding: "windows-1251" }) on a UTF-8-BOM file, or
    // utf16le's FF FE), so even an ASCII body is not byte-faithful there.
    const faithful = !existingState.hasBOM && isByteFaithfulAsUtf8(body, recorded);
    if (!normalize && !faithful) {
      throw new DomainError("E_ENCODING_UNWRITABLE", { path: displayPath, encoding: recorded });
    }
    // Migration (normalizeToUtf8) or a byte-faithful legacy image: both land UTF-8
    // bytes, so the memo must describe UTF-8 — never a stale utf16le/legacy name.
    return {
      textToWrite: body,
      newState: { encoding: "utf8", hasBOM: false, lineEnding, version: undefined },
    };
  }

  // UTF-8 family: restore the recorded BOM + lineEnding via the shared seam so
  // governed writers (e.g. the str_replace_editor shadow) don't re-implement the
  // round-trip locally and diverge on future lineEnding evolution.
  // Only add, never strip: a missing BOM means UTF-8 without BOM.
  let textToWrite = restoreEndings(toLF(content), lineEnding);
  if (existingState.hasBOM && !textToWrite.startsWith(UTF8_BOM)) {
    textToWrite = `${UTF8_BOM}${textToWrite}`;
  }
  const hasBOM = textToWrite.startsWith(UTF8_BOM);
  return {
    textToWrite,
    newState: { encoding: hasBOM ? "utf8bom" : "utf8", hasBOM, lineEnding, version: undefined },
  };
}
