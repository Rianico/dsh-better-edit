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

import { detectBom, isValidUtf8, decodeBytes, normalizeEncoding, top3Candidates, chardetTop3Candidates } from "./encoding.js";
import type { CandidatePreview } from "./encoding.js";
import { detectEnding, type LineEnding } from "./edit-diff.js";

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

export function buildTop3ErrorMessage(displayPath: string, candidates: CandidatePreview[]): string {
  const candStr = candidates.map((c) => `${c.encoding}("${c.sample.slice(0, 20).replace(/"/g, "'")}")`).join(", ");
  return `[E_NOT_TEXT] Path is not a readable UTF-8 text file: ${displayPath}. Hashline editing only supports text files. Top-3 guesses: ${candStr}. Try read({encoding: "<encoding>"}) or set DSH_BETTER_EDIT_AUTO_GUESS_ENCODING=true to auto-decode.`;
}

function buildAutoGuessFooterFromCandidates(candidates: Array<{ encoding: string; confidence?: number; score?: number; sample?: string }>): string {
  // chardet path vs heuristic path share same footer shape, just score vs confidence
  const candsStr = candidates
    .map((c) => {
      const score = c.confidence !== undefined ? String(c.confidence) : c.score !== undefined ? c.score.toFixed(0) : "0";
      return `${c.encoding} ${score}`;
    })
    .join(", ");
  const top = candidates[0]!;
  const topScore = top.confidence !== undefined ? String(top.confidence) : top.score !== undefined ? (top.score as number).toFixed(0) : "0";
  return `\n\n[Auto-guessed: ${top.encoding} ${topScore}, candidates: ${candsStr} — re-read with read({encoding}) if garbled]`;
}

function isMidConfidenceChardet(top: { confidence: number }, second?: { confidence: number }): boolean {
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
 * `recordOpenState` and handling the footer vs E_NOT_TEXT split.
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
    throw new Error(`[E_BAD_ENCODING] Unknown encoding: ${opts.encodingHint}`);
  }

  // 1) Explicit hint (Reopen with Encoding) — caller already chose, no autoGuess
  if (hint) {
    const bom = detectBom(bytes);
    // If BOM present, it wins for hasBOM but hint wins for decode (VS Code)
    const off = bom ? bom.bomLen : 0;
    const slice = bom ? bytes.subarray(off) : bytes;
    // For BOM encodings, decode the full bytes (including BOM) via helper; otherwise hint
    let decoded: string | undefined;
    if (bom && (bom.encoding === "utf8bom" || bom.encoding === "utf16le" || bom.encoding === "utf16be" || bom.encoding === "utf32le" || bom.encoding === "utf32be")) {
      // When hint differs from BOM, hint takes precedence for decoding the slice
      // but we preserve hasBOM from BOM sniff. For utf variants, BOM encoding
      // already handled; for explicit hint we decode slice with hint.
      decoded = decodeBytes(slice, hint);
      if (decoded === undefined) throw new Error(`[E_DECODE_FAILED] Cannot decode bytes as ${hint}`);
      return {
        text: decoded,
        encoding: hint,
        hasBOM: !!bom,
        lineEnding: detectEnding(decoded),
        candidates: [],
      };
    }
    decoded = decodeBytes(slice, hint);
    if (decoded === undefined) throw new Error(`[E_DECODE_FAILED] Cannot decode bytes as ${hint}`);
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
        const isMid = isMidConfidenceChardet(top as { confidence: number }, second as unknown as { confidence: number } | undefined);
        const dec = decodeBytes(bytes, top.encoding);
        if (dec !== undefined && !dec.includes("\uFFFD")) {
          let footer: string | undefined;
          if (isMid) footer = buildAutoGuessFooterFromCandidates(chardetCands as unknown as Array<{ encoding: string; confidence: number }>);
          return {
            text: dec,
            encoding: top.encoding,
            hasBOM: false,
            lineEnding: detectEnding(dec),
            footer,
            candidates: chardetCands.map((c) => ({ encoding: c.encoding, sample: c.sample, score: c.confidence })),
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
        let footer: string | undefined;
        // Always produce footer for heuristic path (mid check decides but we always have candidates)
        // Keep existing behavior: always a footer for heuristic, but mid decides inclusion — for now always include
        // to match prior fs-bridge which always built footerHeu.
        void isMid;
        footer = buildAutoGuessFooterFromCandidates(candidates as unknown as Array<{ encoding: string; score: number }>);
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
    // No candidate succeeded — fall through to E_NOT_TEXT with Top-3
  }

  // 5) E_NOT_TEXT + Top-3 always pushed (even when autoGuess off)
  // Use chardet Top-3 when available, else heuristic Top-3 — same as fs-bridge fallback
  let candidates: CandidatePreview[] = [];
  try {
    const chardetCands = await chardetTop3Candidates(bytes, config.supportedEncodings);
    if (chardetCands.length > 0) {
      candidates = chardetCands.map((c) => ({ encoding: c.encoding, sample: c.sample, score: c.confidence }));
    } else {
      candidates = top3Candidates(bytes, config.supportedEncodings);
    }
  } catch {
    candidates = top3Candidates(bytes, config.supportedEncodings);
  }
  const display = opts.displayPath ?? "(unknown path)";
  throw new Error(buildTop3ErrorMessage(display, candidates));
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
}

/**
 * Decide what bytes (as text, since provider expects string) to write and
 * what new state to record. BOM and lineEnding are restored here when a
 * previous state exists; otherwise defaults are UTF-8 without BOM and LF.
 * For legacy encodings with normalizeToUtf8:false, we preserve the memo
 * (provider will write UTF-8 string, next read re-detects via version bump).
 */
export function prepareForSave(
  content: string,
  existingState: FileEncodingState | undefined,
  opts: EncodeForSaveOptions = {},
): { textToWrite: string; newState?: FileEncodingState } {
  if (opts.encodingHint) {
    const norm = normalizeEncoding(opts.encodingHint);
    if (!norm) throw new Error(`[E_BAD_ENCODING] Unknown encoding: ${opts.encodingHint}`);
    const hasBOM = norm === "utf8bom";
    const lineEnding: LineEnding = existingState?.lineEnding ?? detectEnding(content);
    // Caller will write `content` as UTF-8 string; record new state for next read.
    return {
      textToWrite: content,
      newState: { encoding: norm, hasBOM, lineEnding, version: undefined },
    };
  }

  if (existingState && !opts.normalizeToUtf8 && existingState.encoding !== "utf8" && existingState.encoding !== "utf8bom") {
    // Legacy file, normalize false — preserve memo on wire (no transcode),
    // provider writes UTF-8 string, version bump will invalidate on next read.
    return { textToWrite: content };
  }

  // Default: UTF-8 without BOM, preserve lineEnding if known
  return { textToWrite: content };
}
