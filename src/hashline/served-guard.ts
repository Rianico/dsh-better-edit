/**
 * Served-prefix guard tiers — FU-5 port of upstream
 * `pi-better-edit@b92e0ec:src/hashline/served-guard.ts`.
 *
 * Three tiers beside the served-echo refusal gate (owned by
 * `anchor-pipeline.ts`'s `findEditHashEcho`, unchanged here):
 *  - exact reproduction of a served line → the gate refuses (E_SUSPICIOUS_TEXT);
 *  - served anchor, differing content (`W_SERVED_PREFIX_MISMATCH`) → applied-only
 *    note, fires per occurrence, never blocks, never rewrites;
 *  - anchor-shaped prefix never served (`W_NEVER_SERVED_SHAPE`) → shape-only soft
 *    hint, fires regardless of the literal declaration.
 *
 * Evidence adaptation (disclosed in ADR-0025's FU-5 amendment): upstream judges
 * the remainder against lease-derived canon DIGESTS (#151,
 * `canonDigest(remainder) === served_leases.canon_hash`); this tree's parallel
 * evidence is `servedCanons` — raw canon STRINGS recorded at serve time
 * (`read-and-serve.ts:173`), so the comparison is `canon(tail) === servedCanons[pos]`.
 * The tier semantics are identical; only the comparison space differs.
 *
 * Not ported (measured): upstream's `buildServedWritePrefixNote` stage
 * (`lifecycle-hooks/index.ts:188-197`) — the local write channel
 * (`src/write-hook.ts`) is outside this lane's target files; `findServedHashEcho`
 * — the local gate stays `findEditHashEcho`.
 *
 * @module dsh-better-edit/hashline/served-guard
 */

import { formatWarning } from "../domain-errors.js";
import { HASH_CLASS, HASH_SEP, canon } from "./hash-assign.js";

interface ServedPrefixMismatch {
  /** SAFETY: 1-based candidate index within the submitted lines. */
  k: number;
  /** SAFETY: absolute candidate line (`start + k - 1`); equals `k` when `start` is 1. */
  line: number;
  /** SAFETY: the anchor served for this session and file that opens the candidate. */
  anchor: string;
  /** SAFETY: 1-based served position the anchor was served for. */
  servedLine: number;
}

interface ServedAnchorEntry {
  /** SAFETY: 1-based served position that carried the anchor. */
  servedLine: number;
  /** SAFETY: `servedCanons` string for this anchor's line — the served line's canon. */
  canon: string;
}

interface ServedAnchorHit {
  /** SAFETY: 0-based candidate index within the submitted lines. */
  index: number;
  /** SAFETY: the served anchor that opens the candidate. */
  anchor: string;
  /** SAFETY: every served position that carried the anchor, in served order. */
  entries: ServedAnchorEntry[];
  /** SAFETY: `canon` of the candidate's remainder, ready to compare against the entries. */
  candidateCanon: string;
}

/**
 * Owner of the anchor-shape parse for the warn tiers (diff-marker strip, length,
 * separator, class); the class derives from hash-assign's HASH_CLASS, never a copy.
 * Deliberately NOT a repo-wide parser: the sibling accepts (anchor-pipeline's
 * `ANCHOR_ROW_RE`, hash-assign's prefix regexes, `parseRef`) differ in marker classes,
 * error semantics and matching basis (measured FU-R R4) — unifying would change what
 * each accepts.
 */
const ANCHOR_SHAPE_RE = new RegExp(`^${HASH_CLASS}$`);

function anchorShapeFromLine(line: string): { anchor: string; tail: string } | undefined {
  let text = line;
  if (text.length > 0 && (text[0] === "+" || text[0] === "-" || text[0] === " ")) {
    text = text.slice(1);
  }
  if (text.length < 4) return undefined;
  if (text[3] !== HASH_SEP) return undefined;
  const anchor = text.slice(0, 3);
  if (!ANCHOR_SHAPE_RE.test(anchor)) return undefined;
  return { anchor, tail: text.slice(4) };
}

/**
 * SAFETY: Shared anchor index plus candidate scan for the served prefix
 * mismatch tier. Builds the anchor-to-served map once, then parses each
 * candidate (one optional leading diff marker, anchor, separator) in submitted
 * order. Reported ordering never diverges because the tiers share this scan.
 */
function collectServedAnchorHits(
  lines: readonly string[],
  served: readonly (string | null)[],
  servedCanons: readonly (string | null)[],
): ServedAnchorHit[] {
  const byAnchor = new Map<string, ServedAnchorEntry[]>();
  for (let pos = 0; pos < served.length; pos++) {
    const anchor = served[pos];
    if (anchor === null || anchor === undefined) continue;
    const lineCanon = pos < servedCanons.length ? (servedCanons[pos] ?? null) : null;
    if (lineCanon === null) continue;
    const list = byAnchor.get(anchor);
    const entry = { servedLine: pos + 1, canon: lineCanon };
    if (list) list.push(entry);
    else byAnchor.set(anchor, [entry]);
  }
  if (byAnchor.size === 0) return [];
  const hits: ServedAnchorHit[] = [];
  for (let index = 0; index < lines.length; index++) {
    const parsed = anchorShapeFromLine(lines[index]!);
    if (!parsed) continue;
    const entries = byAnchor.get(parsed.anchor);
    if (!entries) continue;
    hits.push({ index, anchor: parsed.anchor, entries, candidateCanon: canon(parsed.tail) });
  }
  return hits;
}

/**
 * SAFETY: Served prefix mismatch — the middle tier beside the served-echo gate.
 *
 * A candidate reports here when it opens with an anchor served for this session
 * and file, yet its remainder canon matches none of the canons recorded for
 * that anchor's served line. Position-agnostic like the gate: `start` only
 * shifts the reported `line` and never narrows matching. Empty or all-null
 * `servedCanons` means no served content to compare against, so the result
 * stays empty — never a shape-only report. Exact reproductions are excluded
 * (the gate owns them), so callers scan for this tier only after the gate stays
 * silent. Pure with no retained state: fires per occurrence, never suppressed.
 */
export function findServedPrefixMismatches(
  lines: readonly string[],
  served: readonly (string | null)[],
  servedCanons: readonly (string | null)[],
  start = 1,
): ServedPrefixMismatch[] {
  const out: ServedPrefixMismatch[] = [];
  for (const hit of collectServedAnchorHits(lines, served, servedCanons)) {
    let exact = false;
    for (const entry of hit.entries) {
      if (entry.canon === hit.candidateCanon) {
        exact = true;
        break;
      }
    }
    if (exact) continue;
    out.push({
      k: hit.index + 1,
      line: start + hit.index,
      anchor: hit.anchor,
      servedLine: hit.entries[0]!.servedLine,
    });
  }
  return out;
}

/**
 * SAFETY: the canonical remedy shared verbatim by both applied-hint builders:
 * the bytes were applied, so a retry is knowably safe, and the remedy names the
 * exact failing shape. Pinned byte-identical by test so builders cannot drift.
 */
export const ANCHOR_PREFIX_REMEDY =
  "If the hash anchor prefix was unintended, `undo_last_edit`, then retry " +
  "with the same `anchor_from`/`anchor_to` and drop the anchor prefix from `replace_with`.";

/**
 * SAFETY: Model note for an applied edit carrying a served prefix mismatch.
 * Applied-only, bytes untouched, never blocks: the post-edit diff already
 * carries the written line, this note only tells the model the prefix
 * reproduces a served anchor with differing content and names the remedy.
 */
export function buildServedEditPrefixNote(args: {
  k: number;
  anchor: string;
  servedLine: number;
}): string {
  return `${formatWarning("W_SERVED_PREFIX_MISMATCH", {
    k: args.k,
    anchor: args.anchor,
    servedLine: args.servedLine,
  })} ${ANCHOR_PREFIX_REMEDY}`;
}

interface NeverServedAnchorShape {
  /** SAFETY: 1-based candidate index within the submitted lines. */
  k: number;
  /** SAFETY: absolute candidate line (`start + k - 1`); equals `k` when `start` is 1. */
  line: number;
  /** SAFETY: the anchor-shaped prefix never served for this session and file. */
  anchor: string;
}

/**
 * SAFETY: Never-served anchor-shaped lines — the soft-hint tier beside the
 * refusal gate and the served prefix mismatch tier.
 *
 * A candidate reports here when it opens with an anchor-shaped prefix
 * (3 alphanumerics plus the separator, after one optional leading diff marker)
 * whose anchor was never served for this session and file. Shape-only by design:
 * the hint never blocks and never rewrites, so evidence gating does not apply.
 * Served anchors are excluded (the gate and the mismatch tier own them).
 * Pure with no retained state: fires per occurrence, never suppressed.
 */
export function findNeverServedAnchorShapes(
  lines: readonly string[],
  served: readonly (string | null)[],
  start = 1,
): NeverServedAnchorShape[] {
  const servedSet = new Set<string>();
  for (const anchor of served) {
    if (anchor !== null && anchor !== undefined) servedSet.add(anchor);
  }
  const out: NeverServedAnchorShape[] = [];
  for (let index = 0; index < lines.length; index++) {
    const parsed = anchorShapeFromLine(lines[index]!);
    if (!parsed) continue;
    if (servedSet.has(parsed.anchor)) continue;
    out.push({ k: index + 1, line: start + index, anchor: parsed.anchor });
  }
  return out;
}

/**
 * SAFETY: Soft hint for an applied edit carrying never-served anchor-shaped lines.
 * Applied-only, bytes untouched, never blocks: the bytes were written as-is with
 * no rewrite. `count` states how many replacement lines match the tool's own row
 * shape with anchors never served for this session and file. The trailing clause
 * is gated on `if ... unintended` — a conditional reference, not an order.
 * FU-R conformance (upstream `mutation-engine/pipeline.ts:1036-1038`): the per-item count
 * travels as data (`neverServedCount`, anchor-pipeline) and the batch engine aggregates,
 * rendering ONE counted hint per CALL — the old per-applied-item rendering is retired.
 * Surfaced through the warnings seam (rendered by warnBlock) on the model-visible channel.
 */
export function buildNeverServedEditHint(args: { count: number }): string {
  return `${formatWarning("W_NEVER_SERVED_SHAPE", { count: args.count })} ${ANCHOR_PREFIX_REMEDY}`;
}
