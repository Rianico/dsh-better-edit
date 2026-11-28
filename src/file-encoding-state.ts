/**
 * FileEncodingState — deep module owning the file encoding state round-trip.
 *
 * Single seam for deterministic admission (BOM → strict UTF-8 → autoGuess gate
 * → Top-3 always pushed), canonical encoding enum, version-invalidated memo,
 * and BOM+lineEnding round-trip. Previously scattered across fs-bridge
 * (branching + fallback Map + Top-3), encoding.ts (pure scoring), and
 * file-view/fs-write (stripBOM/detectEnding/encode back). Now one file owns
 * the invariant; deleting it would scatter round-trip fidelity (deep).
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
import { assertNeverEncodingMigrationConsent } from "./encoding-consent.js";
import type { EncodingMigrationConsent, EncodingMigrationTarget } from "./encoding-consent.js";

/**
 * The decode hint a mutating re-read must pass to the byte seam: the encoding
 * recorded by the preceding `read({ encoding })` — but only while the memo still
 * matches the on-disk version, and only for encodings the plain read path cannot
 * reproduce.
 */
export function encodingHintAtVersion(
  filePath: string,
  currentVersion: string | undefined,
): string | undefined {
  invalidateIfStale(filePath, currentVersion);
  const encoding = getEncodingState(filePath)?.encoding;
  if (encoding === undefined || encoding === "utf8" || encoding === "utf8bom") return undefined;
  return encoding;
}

export interface FileEncodingState {
  encoding: string;
  hasBOM: boolean;
  lineEnding?: LineEnding;
  version: string | undefined;
}

const encodingMemo = new Map<string, FileEncodingState>();
const autoGuessFooterMemo = new Map<string, string>();

/**
 * The memo identity of a file: its absolute path, slash-normalized (ADR-0038).
 *
 * This module is the only key construction site. A caller passes whatever path it
 * holds — `FileIO.resolve` already returned `fs.processPath(target)` — and gets
 * the same identity back, so no reader has to probe a second spelling: a memo
 * keyed two ways makes every lookup a ladder and every write a dual write, and
 * the two spellings then have to be kept in sync by hand. Backend canonicaliza-
 * tion (symlink/case, the backend's opaque `targetKey`) is the backend's view of
 * the target, not the memo's identity; it does not belong in this key — which is
 * why every public function here takes `filePath`, never a backend key.
 */
function keyOf(path: string): string {
  return String(path).replace(/\\/g, "/");
}

export function getEncodingState(filePath: string): FileEncodingState | undefined {
  return encodingMemo.get(keyOf(filePath));
}

export function setEncodingState(filePath: string, state: FileEncodingState): void {
  encodingMemo.set(keyOf(filePath), state);
}

export function clearEncodingState(filePath?: string): void {
  if (filePath) encodingMemo.delete(keyOf(filePath));
  else encodingMemo.clear();
}

export function getAutoGuessFooter(filePath: string): string | undefined {
  return autoGuessFooterMemo.get(keyOf(filePath));
}

export function setAutoGuessFooter(filePath: string, footer: string): void {
  autoGuessFooterMemo.set(keyOf(filePath), footer);
}

export function clearAutoGuessFooter(filePath?: string): void {
  if (filePath) autoGuessFooterMemo.delete(keyOf(filePath));
  else autoGuessFooterMemo.clear();
}

/** Invalidate memo when FsVersion drifted (ADR-0012). */
export function invalidateIfStale(filePath: string, currentVersion: string | undefined): void {
  const key = keyOf(filePath);
  const memo = encodingMemo.get(key);
  if (memo && memo.version !== currentVersion) encodingMemo.delete(key);
}

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

  if (hint) {
    const bom = detectBom(bytes);
    const off = bom ? bom.bomLen : 0;
    const slice = bom ? bytes.subarray(off) : bytes;
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

  if (config.autoGuessEncoding) {
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
      // HACK: best-effort probe — a failure falls through to the heuristic
    }

    const candidates = top3Candidates(bytes, config.supportedEncodings);
    if (candidates.length > 0) {
      const best = candidates[0]!;
      const second = candidates[1];
      const isMid = isMidConfidenceHeuristic(best, second);
      const dec = decodeBytes(bytes, best.encoding);
      if (dec !== undefined) {
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
  }

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

export function recordOpenState(
  filePath: string,
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
  setEncodingState(filePath, state);
  return state;
}

export function recordFooter(filePath: string, footer: string | undefined): void {
  if (footer) setAutoGuessFooter(filePath, footer);
}

export interface EncodeForSaveOptions {
  encodingHint?: string;
  /**
   * The resolved migration consent for this write (#209), or absent to fall back to the legacy
   * `normalizeToUtf8` spelling. The callers resolve the one ladder
   * (`resolveEncodingMigrationConsent`); this seam only honours the answer.
   */
  migrationConsent?: EncodingMigrationConsent;
  /** Pre-#209 spelling of the `"utf8"` consent; `true` still migrates, `false` still just refuses. */
  normalizeToUtf8?: boolean;
  currentVersion?: string | undefined;
  /** Model-facing path for the round-trip refusal. */
  displayPath?: string;
  /**
   * The one terminator this write must use (#169), resolved by the caller from the pre-image.
   * It outranks the memo — the IO seam re-prepares the text against a memo that still describes
   * the OLD ending, so without this override a planned rewrite would be undone on the way out.
   */
  lineEnding?: LineEnding;
}

/** Shared UTF-8 BOM marker — single source for the BOM round-trip seam.
 * Prefer `prepareForSave` / `stripBOM` over re-implementing this check. */
export const UTF8_BOM = "\uFEFF";

/**
 * The codec a migration edit abandoned (#191). Recorded once, at the save seam
 * (`prepareForSave`, legacy-recorded arm with a non-faithful body), and forwarded
 * through the undo pair — never recomputed downstream, so the undo disclosure cannot
 * disagree with the write that migrated the file.
 *
 * `hasBOM` is the recorded FILE property, never text-level `stripBOM`: a legacy BOM
 * (e.g. utf16le's FF FE) is a byte image a UTF-8 string write cannot reproduce.
 */
export interface EncodingMigration {
  readonly encoding: string;
  readonly hasBOM: boolean;
}

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
 * The memo entry for a converted file: exactly the UTF-8 shape the consent chose (#209).
 * Exhaustive over the target union so a third target cannot silently reuse one of these.
 */
function utf8TargetState(
  target: EncodingMigrationTarget,
  lineEnding: LineEnding,
): FileEncodingState {
  switch (target) {
    case "utf8":
      return { encoding: "utf8", hasBOM: false, lineEnding, version: undefined };
    case "utf8bom":
      return { encoding: "utf8bom", hasBOM: true, lineEnding, version: undefined };
    default:
      return assertNeverEncodingMigrationConsent(target);
  }
}

/**
 * Decide what bytes (as text, since the write seam takes a string) to write and
 * what new state to record. BOM and lineEnding are restored here when a state
 * exists; otherwise defaults are UTF-8 without BOM and LF.
 *
 * ROUND-TRIP VERDICT: the bridge's only write is `writeText(target, content:
 */
export function prepareForSave(
  content: string,
  existingState: FileEncodingState | undefined,
  opts: EncodeForSaveOptions = {},
): { textToWrite: string; newState?: FileEncodingState; migration?: EncodingMigration } {
  const displayPath = opts.displayPath ?? "(unknown path)";
  const consent: EncodingMigrationConsent =
    opts.migrationConsent ?? (opts.normalizeToUtf8 === true ? "utf8" : "refuse");

  if (opts.encodingHint) {
    const norm = normalizeEncoding(opts.encodingHint);
    if (!norm)
      throw new DomainError("E_BAD_PAYLOAD", { message: `Unknown encoding: ${opts.encodingHint}` });
    const hintFaithful =
      (norm === "utf8" || norm === "utf8bom" || isByteFaithfulAsUtf8(content, norm)) &&
      !(existingState?.hasBOM === true && norm !== "utf8bom");
    if (!hintFaithful)
      throw new DomainError("E_ENCODING_UNWRITABLE", { path: displayPath, encoding: norm });
    const hasBOM = norm === "utf8bom";
    const lineEnding: LineEnding =
      opts.lineEnding ?? existingState?.lineEnding ?? detectEnding(content);
    const textToWrite =
      opts.lineEnding !== undefined ? restoreEndings(toLF(content), opts.lineEnding) : content;
    return {
      textToWrite,
      newState: { encoding: norm, hasBOM, lineEnding, version: undefined },
    };
  }

  if (!existingState) {
    if (opts.lineEnding !== undefined) {
      const textToWrite = restoreEndings(toLF(content), opts.lineEnding);
      const hasBOM = textToWrite.startsWith(UTF8_BOM);
      return {
        textToWrite,
        newState: {
          encoding: hasBOM ? "utf8bom" : "utf8",
          hasBOM,
          lineEnding: opts.lineEnding,
          version: undefined,
        },
      };
    }
    return { textToWrite: content };
  }

  const recorded = existingState.encoding;
  const lineEnding: LineEnding =
    opts.lineEnding ?? existingState.lineEnding ?? detectEnding(content);

  if (recorded !== "utf8" && recorded !== "utf8bom") {
    const body = restoreEndings(toLF(content), lineEnding);
    const faithful = !existingState.hasBOM && isByteFaithfulAsUtf8(body, recorded);
    if (faithful) {
      return {
        textToWrite: body,
        newState: { encoding: "utf8", hasBOM: false, lineEnding, version: undefined },
      };
    }
    if (consent === "refuse") {
      throw new DomainError("E_ENCODING_UNWRITABLE", { path: displayPath, encoding: recorded });
    }
    const migration: EncodingMigration = { encoding: recorded, hasBOM: existingState.hasBOM };
    const newState = utf8TargetState(consent, lineEnding);
    const textToWrite = newState.hasBOM
      ? `${UTF8_BOM}${body.startsWith(UTF8_BOM) ? body.slice(1) : body}`
      : body;
    return { textToWrite, newState, migration };
  }

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
