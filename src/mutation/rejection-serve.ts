/**
 * Record a rejection's echoed rows as a serve (ADR-0043).
 *
 * Invariant (non-negotiable): `rows` must be current-file coordinates derived from the
 * committed on-disk snapshot (`content`/`hashes`), never rows from a working buffer or a
 * rendered preview. The parameter list makes the unsafe inputs unrepresentable — the only
 * caller ({@link throwBatchRejection} in `./batch-rejection.js`) passes the call's pre-batch
 * snapshot plus the rows each failing item carries.
 *
 * All-or-nothing duplicate gate (ADR-0043): the echo's anchors come from the edit path's
 * content-addressed assignment, which can differ from the read path's served-stable one.
 */
import { canon } from "../hashline/hash-assign.js";
import type { ServedRow } from "../hashline/anchor-pipeline.js";
import { loadServed, recordServed } from "../session-view.js";
import { splitLines } from "../utils.js";

export async function recordRejectionRows(args: {
  sessionKey: string;
  absolutePath: string;
  /** Current-file 0-based rows from the rejection's own echo (never a buffer echo). */
  rows: readonly ServedRow[];
  /** The committed on-disk snapshot those rows were derived from. */
  content: string;
  /** That snapshot's full line-hash array, parallel to `content`. */
  hashes: readonly string[];
}): Promise<boolean> {
  if (args.rows.length === 0) return true;
  const lines = splitLines(args.content);
  if (lines.length !== args.hashes.length) return false;
  const served = await loadServed(args.sessionKey, args.absolutePath);
  const window = new Set(args.rows.map((row) => row.position));
  const positionsByHash = new Map<string, number[]>();
  served.forEach((hash, position) => {
    if (hash === null) return;
    const positions = positionsByHash.get(hash);
    if (positions === undefined) positionsByHash.set(hash, [position]);
    else positions.push(position);
  });
  for (const row of args.rows) {
    const positions = positionsByHash.get(row.hash);
    if (positions !== undefined && positions.some((position) => !window.has(position)))
      return false;
  }
  return recordServed(args.sessionKey, args.absolutePath, [...args.rows], lines.length, {
    hashes: args.hashes,
    canons: lines.map((line) => canon(line)),
    content: args.content,
    fullRead: false,
  });
}
