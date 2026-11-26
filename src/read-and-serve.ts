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
import { HASH_SPACE, isPromotableAnchorSpaceExhaustion } from "./hashline/hash-assign.js";
import { formatReadWarning } from "./domain-errors.js";
import { endingName, resolveEffectiveEolFromCounts, terminatorKindsUsed } from "./eol-config.js";
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
import type { LineEndingCounts } from "./edit-diff.js";

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

/**
 * The read tier's mixed-EOL notice, or `undefined` when the pre-image spells one terminator kind
 * (or none).
 *
 * Counts are the RAW pre-image's, so the notice is whole-file by construction: `normFromText`
 * counts once where the bytes are decoded, and `offset`/`limit`/`windows` only decide which rows
 * render. The target is the ending the NEXT write will use, resolved by the same ladder that
 * decides the write itself (`env` > `config` > the file's dominant terminator > the OS) — so the
 * notice and the applied `[W_EOL_REWRITTEN]` can never name different rungs.
 */
function mixedEolWarning(counts: LineEndingCounts): string | undefined {
  if (terminatorKindsUsed(counts) < 2) return undefined;
  const effective = resolveEffectiveEolFromCounts(counts);
  return formatReadWarning("W_MIXED_EOL", {
    ...counts,
    target: endingName(effective.value),
    source: effective.source,
  });
}

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
 * observation recorded (the `read` tool and the write auto-read hook) do that
 * themselves with their exec context.
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
    if (!isPromotableAnchorSpaceExhaustion(e)) throw e;
    const retiredCount = retiredHashes.size;
    const servedCount = servedForNorm.filter((h): h is string => h !== null).length;
    const reservedCount = retiredCount + servedCount;
    try {
      const store = await loadServedStore();
      store.clearRetiredAnchors(sessionKey, absolutePath);
      try {
        store.clearCards(sessionKey, absolutePath);
      } catch {
        // HACK: card state is a cache; the promotion retry proceeds without it
      }
    } catch {
      // HACK: a store fault must not fail the read — the in-memory reservation state carries on (ADR-0020 R2)
    }
    promotionWarning = `Anchor space exhausted (retired ${retiredCount} + served ${servedCount} = ${reservedCount} of ${HASH_SPACE}); promotion cleared retired — re-read recommended, stale-anchor checks degraded until next full read.`;
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
  }
  let servedLanded = true;
  if (view.served.length > 0) {
    const canons = splitLines(view.normalized).map((l) => canon(l));
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
        fullRead: view.fullRead,
        ...(view.retiredHashes === undefined ? {} : { retiredHashes: view.retiredHashes }),
      },
    );
  }
  if (view.fullRead) await clearDriftReported(sessionKey, view.absolutePath);
  const autoFooter = getAutoGuessFooter(view.absolutePath) ?? "";
  const autoWarning = autoFooter || undefined;
  const warning = promotionWarning
    ? autoWarning
      ? `${promotionWarning}\n${autoWarning}`
      : promotionWarning
    : autoWarning;
  const baseText = view.hadUtf8DecodeErrors ? `${view.text}\n\n${UTF8_REWRITE_NOTE}` : view.text;
  const withServeNote = servedLanded ? baseText : `${baseText}\n\n${SERVE_NOT_RECORDED_NOTE}`;
  const readWarning = mixedEolWarning(view.endingCounts);
  const text = readWarning === undefined ? withServeNote : `${withServeNote}\n\n${readWarning}`;
  return {
    text,
    served: view.served,
    hadUtf8DecodeErrors: view.hadUtf8DecodeErrors,
    absolutePath: view.absolutePath,
    warning,
  };
}
