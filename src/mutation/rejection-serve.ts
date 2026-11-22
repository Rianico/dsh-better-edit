/**
 * Record a rejection's echoed rows as a serve (ADR-0043).
 *
 * Invariant (non-negotiable): `rows` must be current-file coordinates derived from the
 * committed on-disk snapshot (`content`/`hashes`), never rows from a working buffer or a
 * rendered preview. The parameter list makes the unsafe inputs unrepresentable — the only
 * caller ({@link collectAbortPart} in `./engine.ts`) passes the call's pre-batch snapshot
 * plus the rows the verifier built from that snapshot.
 *
 * All-or-nothing duplicate gate (ADR-0043): the echo's anchors come from the edit path's
 * content-addressed assignment, which can differ from the read path's served-stable one.
 * If a recorded hash is already served at a position OUTSIDE the recorded window, writing
 * it would put one anchor at two mirror positions — the duplicate-anchor state ADR-0018
 * removed the heal for — so nothing is recorded and the message names the read instead.
 * The mirror is therefore either untouched or exactly the recorded window.
 *
 * WHY this exists at all (ADR-0043 supersedes T3f's deletion of `recordEchoServes`): T3f's
 * recorder called `recordServed` with rows only — no line count, no canons, no snapshot — so
 * `grantServeLeases` bailed early and the recorded anchors were unusable. The serve triple
 * passed here is the same one a windowed `read` sends, so the rows, canons, snapshot and
 * leases land in one unit and a retry with an echoed anchor resolves.
 *
 * `fullRead: false` keeps the full-read effects (retired-anchor clear, hazard cards, whole
 * canon array) off a rejection: a refusal names one window, never the whole file.
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
  // Nothing to record, so nothing can fail: vacuously landed.
  if (args.rows.length === 0) return true;
  const lines = splitLines(args.content);
  if (lines.length !== args.hashes.length) return false;
  // Duplicate gate: a hash already served OUTSIDE the window would land at a second
  // position. Same position + same hash is a re-record of what the mirror holds — fine.
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
