/**
 * The shared read-and-serve operation — now a thin wrapper over FileView.
 *
 * FileView owns normalize → hash → render → truncate → served selection.
 * This module only adds the persistence seam: recordServed + clearDriftReported
 * + UTF-8 rewrite note. Used by the `read` tool and by the write auto-read
 * hook, so the model is always shown fresh anchors the same way.
 * @module dsh-better-edit/read-and-serve
 */

import { abortIf } from "./utils.js";
import { readView } from "./file-view.js";
import { canon } from "./hashline/hash-assign.js";
import { splitLines } from "./utils.js";
import { getAutoGuessFooter } from "./fs-bridge.js";
import { AnchorSpaceExhaustedError, HASH_SPACE } from "./hashline/hash-assign.js";
import {
  recordServed,
  clearDriftReported,
  loadRetiredAnchors,
  loadServed,
  loadServedCanons,
} from "./session-view.js";
import { loadServedStore } from "./hash-store.js";
import type { FileIO } from "./fs-bridge.js";
import type { ReadWindow } from "./file-view.js";
import type { ServedRow } from "./hashline/anchor-pipeline.js";

/** Appended when the file had non-UTF-8 bytes; editing rewrites it as UTF-8. */
export const UTF8_REWRITE_NOTE =
  "[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]";

/**
 * Appended when the read's serve write did not land: the rows are shown, but their anchors are not
 * usable for editing. Goes in `text`, not `warning` — `tool-read` renders both, but the write hook
 * (`src/write-hook.ts`) renders `text` only, and both consumers must see the downgrade.
 */
const SERVE_NOT_RECORDED_NOTE =
  "WARNING: the rows above were NOT recorded as served — their `HASH│` anchors are NOT " +
  "usable for editing. Re-read the file to re-sync before editing.";

export interface ReadAndServeOptions {
  encoding?: string;
  /** The session whose served rows these lines belong to. */
  sessionKey: string;
  signal?: AbortSignal;
  /** Pagination for the rendered preview (undefined = from the start). */
  offset?: number;
  limit?: number;
  /**
   * FU-6 (port of pi-better-edit@2334352): disjoint ranges served in one call; wins over
   * offset/limit when non-empty, `[]` falls back to the plain (full-read) contract.
   */
  windows?: ReadWindow[];
}

export interface ReadAndServeResult {
  /** Optional auto-guess warning, separate block. */
  warning?: string;
  /** The model-facing read text, including the UTF-8 note when applicable. */
  text: string;
  /** The rows recorded as served (empty when nothing was shown). */
  served: ServedRow[];
  hadUtf8DecodeErrors: boolean;
  absolutePath: string;
}

/**
 * Perform one read-and-serve: normalize the file at `rawPath`, render its
 * hashline preview, record the shown rows as served for the session, and clear
 * the reported-drift marks (a fresh read resets them). The returned text
 * carries the UTF-8 rewrite note when the file had decode errors.
 *
 * Emits nothing on the fs-observation gate — callers that need the
 * observation recorded (the `read` tool) do that themselves with their exec
 * context.
 */
export async function readAndServe(
  io: FileIO,
  rawPath: string,
  cwd: string,
  options: ReadAndServeOptions,
): Promise<ReadAndServeResult> {
  const { sessionKey, signal } = options;
  abortIf(signal);
  const absolutePath = await io.resolve(rawPath, cwd, signal);
  let retiredHashes = await loadRetiredAnchors(sessionKey, absolutePath);
  const servedForNorm = await loadServed(sessionKey, absolutePath);
  const servedCanons = await loadServedCanons(sessionKey, absolutePath);
  // Build previous for stable reuse (S): served filtered + canons reconstruction.
  // #62 alignment gate: the reconstructed arrays carry the SERVED index as the line
  // position, which equals the real line number only when the mirror is dense — the
  // `row.position === index` half of the `isFullRead` predicate (session-view.ts).
  // With holes (a partial mirror), `mapStableHashes` would match compressed indices
  // against whole-file positions and reshuffle anchors of an UNCHANGED file; pass
  // `previous = undefined` instead and take the content-addressed snapshot path
  // (hash.ts cache), which is deterministic for unchanged content.
  let previous: { content: string; hashes: string[]; removedHashes?: Set<string> } | undefined;
  if (servedForNorm.every((h) => h !== null)) {
    const filteredHashes: string[] = [];
    const filteredCanons: string[] = [];
    for (let i = 0; i < servedForNorm.length; i++) {
      const h = servedForNorm[i];
      if (h !== null) {
        filteredHashes.push(h);
        filteredCanons.push(servedCanons[i] ?? "");
      }
    }
    if (filteredHashes.length > 0) {
      // Reconstruct previous content from canons — canon is idempotent and whitespace-insensitive (ADR-0002: canon strips ASCII whitespace, so "a b" and "a  b" share canon and hash). Joining filteredCanons preserves reuse correctness for mapStableHashes nearest-canon matching; byte-fidelity of whitespace is not required for anchor stability, only canon equality.
      const prevContent = filteredCanons.join("\n");
      previous = {
        content: prevContent,
        hashes: filteredHashes,
        removedHashes: new Set(retiredHashes),
      };
    }
  }
  let reservedHashes = new Set<string>([
    ...retiredHashes,
    ...servedForNorm.filter((h): h is string => h !== null),
  ]);
  let reservations = { reservedHashes, retiredHashes };
  let promotionWarning: string | undefined;
  let view;
  try {
    view = await readView(io, rawPath, cwd, {
      encoding: options.encoding,
      offset: options.offset,
      limit: options.limit,
      windows: options.windows,
      signal,
      reservedHashes: reservations.reservedHashes,
      retiredHashes: reservations.retiredHashes,
      previous,
    });
  } catch (e: unknown) {
    if (
      e instanceof AnchorSpaceExhaustedError ||
      (e instanceof Error && e.message.includes("probing failed over"))
    ) {
      const retiredCount = retiredHashes.size;
      const servedCount = servedForNorm.filter((h): h is string => h !== null).length;
      const reservedCount = retiredCount + servedCount;
      // Major GC promotion: clear retired for this (session,path), keep served/canons
      try {
        const store = await loadServedStore();
        store.clearRetiredAnchors(sessionKey, absolutePath);
        try {
          store.clearCards(sessionKey, absolutePath);
        } catch {
          // Best-effort: card state is a cache; the promotion retry below proceeds without it.
        }
      } catch {
        // Best-effort: a store fault here must not fail the read — the retry proceeds on the
        // in-memory reservation state (ADR-0020 R2, promotion/wipe arm).
      }
      // Soft promotion notice: plain non-header text (no [E_] code, no audience).
      promotionWarning = `Anchor space exhausted (retired ${retiredCount} + served ${servedCount} = ${reservedCount} of ${HASH_SPACE}); promotion cleared retired — re-read recommended, stale-anchor checks degraded until next full read.`;
      // Retry ignoring retired (served only) — also drop removedHashes from previous
      retiredHashes = new Set<string>();
      reservedHashes = new Set<string>([...servedForNorm.filter((h): h is string => h !== null)]);
      reservations = { reservedHashes, retiredHashes };
      if (previous) previous = { content: previous.content, hashes: previous.hashes };
      view = await readView(io, rawPath, cwd, {
        encoding: options.encoding,
        offset: options.offset,
        limit: options.limit,
        windows: options.windows,
        signal,
        reservedHashes: reservations.reservedHashes,
        retiredHashes: reservations.retiredHashes,
        previous,
      });
    } else {
      throw e;
    }
  }
  let servedLanded = true;
  if (view.served.length > 0) {
    const canons = splitLines(view.normalized).map((l) => canon(l));
    const canonServed = canons.map((canonText) => canonText as string | null);
    // Pad or trim canons to served length? For now use canons for full file
    const fullCanons: (string | null)[] = [];
    for (let i = 0; i < view.hashes.length; i++) {
      fullCanons.push(canons[i] ?? null);
    }
    servedLanded = await recordServed(
      sessionKey,
      view.absolutePath,
      view.served,
      view.hashes.length,
      {
        hashes: view.hashes,
        canons: fullCanons,
        content: view.normalized,
      },
    );
  }
  // #69: epoch lifecycle belongs to full reads — a partial (paged or
  // truncated) read merges window rows only and must not clear the
  // drift-reported marks; only a full read resets them.
  // FU-6 (2334352) WHY: `windows: []` falls back to a full read in the preview, so the full-read
  // contract has to follow the same rule — otherwise an empty array silently skips the drift clear
  // that a full read owes. A non-empty multi-window read serves sparse rows, never the full file.
  const hasWindows = Array.isArray(options.windows) && options.windows.length > 0;
  const isFullRead =
    options.offset === undefined &&
    options.limit === undefined &&
    !hasWindows &&
    !view.truncation?.truncated;
  if (isFullRead) await clearDriftReported(sessionKey, view.absolutePath);
  const autoFooter =
    getAutoGuessFooter(view.absolutePath) ??
    getAutoGuessFooter(rawPath) ??
    getAutoGuessFooter(view.absolutePath.replace(/\\/g, "/")) ??
    "";
  const autoWarning = autoFooter || undefined;
  const warning = promotionWarning
    ? autoWarning
      ? `${promotionWarning}\n${autoWarning}`
      : promotionWarning
    : autoWarning;
  const baseText = view.hadUtf8DecodeErrors ? `${view.text}\n\n${UTF8_REWRITE_NOTE}` : view.text;
  // The serve write is a second unit: a fault there must not fail the read, but it does decide
  // whether the anchors above are usable — so the claim is downgraded in the one channel both
  // consumers render.
  const text = servedLanded ? baseText : `${baseText}\n\n${SERVE_NOT_RECORDED_NOTE}`;
  return {
    text,
    served: view.served,
    hadUtf8DecodeErrors: view.hadUtf8DecodeErrors,
    absolutePath: view.absolutePath,
    warning,
  };
}
