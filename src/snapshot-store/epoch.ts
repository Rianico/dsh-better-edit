/**
 * Single owner of the snapshot-epoch shape: a committed `file_snapshots.snapshot_hash` is
 * `${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}` (ADR-0041, ADR-0054).
 *
 * The two axes are independent evidence, and this module never conflates them. Raw-byte anchors
 * survive a canon-only change, so anchor reuse asks the generation alone. The canon evidence stored
 * beside an anchor — lineage and lease `canon_hash`, and the `line_id`s paired through it — is only
 * comparable to today's digest under the canon that wrote it, so every seam that reuses that
 * evidence asks the full epoch.
 *
 * Ref: docs/adr/0041-anchor-identity-from-raw-bytes.md,
 * docs/adr/0054-snapshot-epoch-fence.md
 * @module dsh-better-edit/snapshot-store/epoch
 */
import { ANCHOR_GENERATION, CANON_VERSION } from "../hashline/hash-assign.js";

/** The three components of a snapshot cache key. */
export interface SnapshotEpoch {
  canonVersion: number;
  anchorGeneration: number;
  checksum: string;
}

/**
 * Splits a snapshot cache key into its components. `undefined` unless the key carries exactly three
 * `:`-separated parts whose first two are integers, so the retired two-part shape `<canon>:<checksum>`,
 * a future widened key and malformed text are all unparseable rather than silently foreign.
 */
export function parseSnapshotEpoch(hash: string | null | undefined): SnapshotEpoch | undefined {
  if (hash === null || hash === undefined) return undefined;
  const parts = hash.split(":");
  if (parts.length !== 3) return undefined;
  const [canon, generation, checksum] = parts;
  if (canon === undefined || generation === undefined || checksum === undefined) return undefined;
  if (!/^\d+$/.test(canon) || !/^\d+$/.test(generation)) return undefined;
  return {
    canonVersion: Number(canon),
    anchorGeneration: Number(generation),
    checksum,
  };
}

/** The epoch without a trailing separator — the `meta` stamp value shape. */
export function snapshotEpochKey(): string {
  return `${CANON_VERSION}:${ANCHOR_GENERATION}`;
}

/** The prefix every current-epoch snapshot key starts with — the checksum left out. */
export function snapshotEpochPrefix(): string {
  return `${snapshotEpochKey()}:`;
}

/**
 * Whether a snapshot key names the current epoch on BOTH axes. Gates every seam that reuses the
 * canon evidence a snapshot stored, because that evidence is only comparable under the canon that
 * wrote it.
 */
export function isCurrentSnapshotEpoch(hash: string | null | undefined): hash is string {
  const epoch = parseSnapshotEpoch(hash);
  return (
    epoch !== undefined &&
    epoch.canonVersion === CANON_VERSION &&
    epoch.anchorGeneration === ANCHOR_GENERATION
  );
}

/**
 * Whether the raw anchors are still derivable at the same generation. Gates anchor reuse only:
 * anchors are a function of the raw bytes, which no canon change can move.
 */
export function isCurrentRawAnchorGeneration(generation: number | null | undefined): boolean {
  return generation === ANCHOR_GENERATION;
}
