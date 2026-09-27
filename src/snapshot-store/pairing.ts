/**
 * Scaled recursive patience pairing (spec §5.2): aligns a previous snapshot's lines to the
 * current snapshot's lines so `line_id`s survive reorders, inserts, and deletes.
 *
 * The engine has four phases, all fail-closed: an ambiguous interval pairs nothing rather
 * than guessing coordinates.
 *
 *   1. Locally unique canon anchors become candidate pins (`findUniquePins`).
 *   2. The candidate pins' minimal-displacement LIS backbone is their unconditional
 *      intersection across every maximum-length, minimum-Δ subsequence
 *      (`findStablePinBackbone`, two-pass DP over patience-sorted ranks).
 *   3. Pinless rigid runs with identical canon sequences zip pairwise (Probe N).
 *   4. Bounded leaf intervals align on a unique LCS embedding only: a pairing is emitted when
 *      it lies on every maximal traceback path, so an interval with several optimal pairings
 *      stays UNPAIRED / RETIRED.
 *
 * When the backbone is empty the interval falls straight through to leaf handling: the
 * engine never recurses on identical bounds, so alignment cannot starve the scan budget.
 *
 * Invariant: `prevLines` and `currLines` are contiguous ascending 1-based line numbers
 * (spec §5.2 descriptor shape), so a descriptor's index + 1 is its line number.
 *
 * @module dsh-better-edit/snapshot-store/pairing
 */

export interface LineDescriptor {
  lineNumber: number;
  canonHash: string;
}

export interface AnchorPin {
  prevLine: number;
  currLine: number;
}

export interface PairingOptions {
  /**
   * WHY: production callers omit this so the dynamic `MAX(100000, 4*(prev+curr))` guard
   * WHY: applies; tests inject a tiny budget to prove the guard halts alignment instead of
   * WHY: silently recursing past it.
   */
  scanBudget?: number;
}

interface LcsAlignment {
  /** True only when the interval has exactly one maximum pairing, i.e. every optimal pair is forced. */
  isUnique: boolean;
  pairs: [number, number][];
}

const MAX_LEAF_LINES = 2000;
const MAX_LEAF_CELLS = 4_000_000;
const MIN_SCAN_BUDGET = 100_000;
const BUDGET_LINES_FACTOR = 4;
const MAXIMAL_PAIRING_CAP = 2;

/** Dynamic scan budget: `MAX(100000, 4 * (prevLines + currLines))` (spec §5.1/§5.2). */
export function pairingScanBudget(prevCount: number, currCount: number): number {
  return Math.max(MIN_SCAN_BUDGET, BUDGET_LINES_FACTOR * (prevCount + currCount));
}

/** First index whose value is `>= target` in an ascending array. */
function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface WeightedPin {
  prevLine: number;
  currLine: number;
  displacement: number;
}

/**
 * WHY: per-rank prefix-min indexes keep the minimal-displacement LIS at O(m log m): a
 * WHY: Fenwick over each rank's compressed `currLine` coordinates answers "min displacement of a
 * WHY: length-(k-1) subsequence ending before this coordinate" in O(log m) without an O(m²)
 * WHY: scan over predecessors.
 */
class RankDisplacementIndex {
  private readonly sorted: number[];
  private readonly tree: Float64Array;

  constructor(values: number[]) {
    this.sorted = [...new Set(values)].sort((a, b) => a - b);
    this.tree = new Float64Array(this.sorted.length + 1);
    this.tree.fill(Infinity);
  }

  queryBelow(value: number): number {
    let idx = lowerBound(this.sorted, value);
    let best = Infinity;
    while (idx > 0) {
      const candidate = this.tree[idx]!;
      if (candidate < best) best = candidate;
      idx -= idx & -idx;
    }
    return best;
  }

  update(value: number, candidate: number): void {
    let idx = lowerBound(this.sorted, value) + 1;
    const size = this.sorted.length;
    while (idx <= size) {
      if (candidate < this.tree[idx]!) this.tree[idx] = candidate;
      idx += idx & -idx;
    }
  }
}

/**
 * Forward pass of the ∩LIS_minΔ DP (spec §3.4.3): for every pin, the length of the longest
 * strictly increasing `currLine` subsequence ending at it and the minimum total `|prevLine -
 * currLine|` displacement among those. Patience sorting fixes the lengths; per-rank Fenwick
 * indexes carry the displacement minima.
 */
function computeLengthAndMinDisplacement(pins: WeightedPin[]): {
  lengths: number[];
  displacements: number[];
} {
  const count = pins.length;
  const lengths: number[] = Array.from({ length: count }, () => 0);
  const displacements: number[] = Array.from({ length: count }, () => 0);
  if (count === 0) return { lengths, displacements };

  const tails: number[] = [];
  for (let i = 0; i < count; i++) {
    const currLine = pins[i]!.currLine;
    const slot = lowerBound(tails, currLine);
    lengths[i] = slot + 1;
    if (slot === tails.length) tails.push(currLine);
    else tails[slot] = currLine;
  }

  const rankValues: number[][] = Array.from({ length: tails.length }, () => []);
  for (let i = 0; i < count; i++) rankValues[lengths[i]! - 1]!.push(pins[i]!.currLine);
  const indexes = rankValues.map((values) => new RankDisplacementIndex(values));

  for (let i = 0; i < count; i++) {
    const pin = pins[i]!;
    const rank = lengths[i]!;
    let shortest = pin.displacement;
    if (rank > 1) {
      // WHY: the predecessor with rank-1 is guaranteed to have been processed already
      // WHY: (pins arrive in ascending prevLine), so a finite minimum always exists when rank > 1.
      const predecessor = indexes[rank - 2]!.queryBelow(pin.currLine);
      if (predecessor !== Infinity) shortest += predecessor;
    }
    displacements[i] = shortest;
    indexes[rank - 1]!.update(pin.currLine, shortest);
  }

  return { lengths, displacements };
}

function pinDisplacement(pin: AnchorPin): number {
  return Math.abs(pin.prevLine - pin.currLine);
}

/**
 * Candidate Anchor Pins: a canon that occurs exactly once in `prev[pStart..pEnd]` and
 * exactly once in `curr[cStart..cEnd]` (spec §3.4.1). Every other line is duplicated or
 * absent on one side, so pairing it would guess.
 */
export function findUniquePins(
  prevLines: LineDescriptor[],
  currLines: LineDescriptor[],
  pStart: number,
  pEnd: number,
  cStart: number,
  cEnd: number,
): AnchorPin[] {
  const prevCounts = new Map<string, number>();
  for (let p = pStart; p <= pEnd; p++) {
    const key = prevLines[p - 1]!.canonHash;
    prevCounts.set(key, (prevCounts.get(key) ?? 0) + 1);
  }
  const currCounts = new Map<string, number>();
  const currPositions = new Map<string, number>();
  for (let c = cStart; c <= cEnd; c++) {
    const key = currLines[c - 1]!.canonHash;
    currCounts.set(key, (currCounts.get(key) ?? 0) + 1);
    currPositions.set(key, c);
  }

  const pins: AnchorPin[] = [];
  for (let p = pStart; p <= pEnd; p++) {
    const key = prevLines[p - 1]!.canonHash;
    if (prevCounts.get(key) !== 1 || currCounts.get(key) !== 1) continue;
    const currLine = currPositions.get(key);
    if (currLine === undefined) continue;
    pins.push({ prevLine: p, currLine });
  }
  return pins;
}

/**
 * Unconditional intersection of every maximum-length, minimum-displacement increasing
 * subsequence of `pins` (spec §3.4.3). Pins arrive sorted by ascending `prevLine`; the
 * backward pass mirrors the forward pass over negated `currLine` coordinates.
 *
 * A pin belongs to the intersection iff it lies on a minimal-displacement LIS *and* no
 * other minimal-displacement pin shares its rank — otherwise a competing optimal
 * subsequence could bypass it.
 */
export function findStablePinBackbone(pins: AnchorPin[]): AnchorPin[] {
  const count = pins.length;
  if (count === 0) return [];

  const weighted: WeightedPin[] = pins.map((pin) => ({
    prevLine: pin.prevLine,
    currLine: pin.currLine,
    displacement: pinDisplacement(pin),
  }));
  const forward = computeLengthAndMinDisplacement(weighted);

  const reversed: WeightedPin[] = weighted
    .map((pin) => ({
      prevLine: pin.prevLine,
      currLine: -pin.currLine,
      displacement: pin.displacement,
    }))
    .reverse();
  const backward = computeLengthAndMinDisplacement(reversed);

  const lengths = forward.lengths;
  const displacements = forward.displacements;
  const suffixLengths: number[] = Array.from({ length: count }, () => 0);
  const suffixDisplacements: number[] = Array.from({ length: count }, () => 0);
  for (let i = 0; i < count; i++) {
    const j = count - 1 - i;
    suffixLengths[i] = backward.lengths[j]!;
    suffixDisplacements[i] = backward.displacements[j]!;
  }

  let bestLength = 0;
  for (let i = 0; i < count; i++) if (lengths[i]! > bestLength) bestLength = lengths[i]!;

  let bestDisplacement = Infinity;
  for (let i = 0; i < count; i++) {
    if (lengths[i]! + suffixLengths[i]! - 1 !== bestLength) continue;
    const total = displacements[i]! + suffixDisplacements[i]! - weighted[i]!.displacement;
    if (total < bestDisplacement) bestDisplacement = total;
  }

  const optimalAtRank = new Map<number, number>();
  const optimal: boolean[] = Array.from({ length: count }, () => false);
  for (let i = 0; i < count; i++) {
    if (lengths[i]! + suffixLengths[i]! - 1 !== bestLength) continue;
    const total = displacements[i]! + suffixDisplacements[i]! - weighted[i]!.displacement;
    if (total !== bestDisplacement) continue;
    optimal[i] = true;
    const rank = lengths[i]!;
    optimalAtRank.set(rank, (optimalAtRank.get(rank) ?? 0) + 1);
  }

  const stable: AnchorPin[] = [];
  for (let i = 0; i < count; i++) {
    if (!optimal[i]) continue;
    if (optimalAtRank.get(lengths[i]!) !== 1) continue;
    stable.push(pins[i]!);
  }
  return stable;
}

/**
 * Bounded leaf alignment (spec §3.4.4). Uniqueness is **embedding-level**: a pairing survives
 * only when it lies on every maximal traceback path, and an interval with more than one maximum
 * pairing pairs nothing (its lines stay UNPAIRED / RETIRED).
 *
 * `pairingCount` is the exact number of maximum pairings (embeddings) of the optimal LCS in the
 * sub-interval, capped at 2 so the decision stays polynomial. It deliberately counts neither
 * distinct canon strings nor DP orderings:
 * - A repeated canon that can be matched in two places counts twice, although the LCS string is
 *   the same: `[A, A, A]` vs `[A, A]` counts 3, not 1.
 * - Two orderings of down/right skips around the same matched lines count once, because they are
 *   the same embedding: `[A, X, B]` vs `[A, Y, B]` counts 1, not 2.
 *
 * The recurrence is a first-pair decomposition. For the region starting at `(i, j)` with optimal
 * length `target`, every maximum pairing either matches `i` with `j` (only possible when the
 * canons agree, and then it extends a maximum pairing of `(i + 1, j + 1)`), or leaves at least
 * one of the two lines unmatched, which is a maximum pairing of `(i + 1, j)` and/or `(i, j + 1)`
 * at the same length. The overlap of those two jump regions is subtracted, so each pairing is
 * counted exactly once. The cap is applied after the inclusion-exclusion subtraction, and because
 * `|A ∪ B| == 1` forces `A` and `B` to be the same singleton, the `=== 1` test that drives
 * `isUnique` stays exact under the cap.
 */
export function computeLCSPaths(
  prevLines: LineDescriptor[],
  currLines: LineDescriptor[],
  pStart: number,
  pEnd: number,
  cStart: number,
  cEnd: number,
): LcsAlignment {
  const pCount = pEnd - pStart + 1;
  const cCount = cEnd - cStart + 1;
  const stride = cCount + 1;
  const suffix = new Int32Array((pCount + 1) * stride);
  const pairingCount = new Int32Array((pCount + 1) * stride);

  for (let i = pCount - 1; i >= 0; i--) {
    const pKey = prevLines[pStart - 1 + i]!.canonHash;
    const row = i * stride;
    const nextRow = row + stride;
    for (let j = cCount - 1; j >= 0; j--) {
      const cKey = currLines[cStart - 1 + j]!.canonHash;
      const diagonal = suffix[nextRow + j + 1]!;
      suffix[row + j] =
        pKey === cKey ? diagonal + 1 : Math.max(suffix[nextRow + j]!, suffix[row + j + 1]!);
    }
  }

  for (let i = pCount; i >= 0; i--) {
    for (let j = cCount; j >= 0; j--) {
      const index = i * stride + j;
      if (i === pCount || j === cCount) {
        pairingCount[index] = 1;
        continue;
      }
      const target = suffix[index]!;
      if (target === 0) {
        pairingCount[index] = 1;
        continue;
      }
      const diagonal = suffix[(i + 1) * stride + (j + 1)]!;
      const down = suffix[(i + 1) * stride + j]!;
      const right = suffix[i * stride + (j + 1)]!;
      const diagonalCount = pairingCount[(i + 1) * stride + (j + 1)]!;
      let total = 0;
      if (down === target) total += pairingCount[(i + 1) * stride + j]!;
      if (right === target) total += pairingCount[i * stride + (j + 1)]!;
      if (diagonal === target) total -= diagonalCount;
      const pKey = prevLines[pStart - 1 + i]!.canonHash;
      const cKey = currLines[cStart - 1 + j]!.canonHash;
      if (pKey === cKey && diagonal + 1 === target) total += diagonalCount;
      pairingCount[index] = total > MAXIMAL_PAIRING_CAP ? MAXIMAL_PAIRING_CAP : total;
    }
  }

  const isUnique = pairingCount[0] === 1;
  const pairs: [number, number][] = [];
  if (isUnique) {
    let i = 0;
    let j = 0;
    while (i < pCount && j < cCount) {
      const target = suffix[i * stride + j]!;
      if (target === 0) break;
      const diagonal = suffix[(i + 1) * stride + (j + 1)]!;
      const pKey = prevLines[pStart - 1 + i]!.canonHash;
      const cKey = currLines[cStart - 1 + j]!.canonHash;
      // WHY: with `pairingCount[i][j] === 1` each step has exactly one pairing-optimal
      // WHY: continuation, so this preference order reproduces *the* unique embedding. A canon
      // WHY: match that preserves the optimum must be in it (a maximum path through that pair
      // WHY: would otherwise be a second embedding), and when skipping both lines is optimal
      // WHY: the unique embedding can only continue inside `(i + 1, j + 1)`.
      if (pKey === cKey && diagonal + 1 === target) {
        pairs.push([pStart + i, cStart + j]);
        i++;
        j++;
        continue;
      }
      if (diagonal === target) {
        i++;
        j++;
        continue;
      }
      if (suffix[(i + 1) * stride + j] === target) {
        i++;
        continue;
      }
      j++;
    }
  }

  return { isUnique, pairs };
}

/**
 * Fail-closed monotonicity assertion (spec §3.8): paired coordinates must be strictly
 * increasing in both snapshots, so a later previous line can never map to an earlier
 * current line.
 */
export function assertMonotonicPairing(pairing: Map<number, number>): void {
  const sorted = [...pairing.entries()].sort((a, b) => a[0] - b[0]);
  let lastCurr = 0;
  for (const [prev, curr] of sorted) {
    if (curr <= lastCurr) {
      throw new Error(`Pairing monotonicity violation: ${prev} -> ${curr} <= ${lastCurr}`);
    }
    lastCurr = curr;
  }
}

/**
 * Pair previous snapshot lines to current snapshot lines (spec §5.2), returning
 * `prevLineNumber -> currLineNumber`. Unpaired lines are omitted, which retires their
 * `line_id`s fail-closed downstream.
 */
export function pairSnapshots(
  prevLines: LineDescriptor[],
  currLines: LineDescriptor[],
  options?: PairingOptions,
): Map<number, number> {
  const pairing = new Map<number, number>();
  let scanBudget = options?.scanBudget ?? pairingScanBudget(prevLines.length, currLines.length);

  function alignRecursive(pStart: number, pEnd: number, cStart: number, cEnd: number): void {
    if (pStart > pEnd || cStart > cEnd) return;

    const intervalLength = pEnd - pStart + 1 + (cEnd - cStart + 1);
    if (scanBudget < intervalLength) return;
    scanBudget -= intervalLength;

    const candidatePins = findUniquePins(prevLines, currLines, pStart, pEnd, cStart, cEnd);
    if (candidatePins.length > 0) {
      const stablePins = findStablePinBackbone(candidatePins);
      if (stablePins.length > 0) {
        let pCursor = pStart;
        let cCursor = cStart;
        for (const pin of stablePins) {
          alignRecursive(pCursor, pin.prevLine - 1, cCursor, pin.currLine - 1);
          pairing.set(pin.prevLine, pin.currLine);
          pCursor = pin.prevLine + 1;
          cCursor = pin.currLine + 1;
        }
        alignRecursive(pCursor, pEnd, cCursor, cEnd);
        return;
      }
      // WHY: contested candidate pins leave the backbone empty. Recursing on identical
      // WHY: bounds here would never shrink the interval; fall through to leaf handling
      // WHY: instead so progress and the scan budget are both guaranteed.
    }

    const pCount = pEnd - pStart + 1;
    const cCount = cEnd - cStart + 1;

    if (pCount === cCount) {
      let identical = true;
      for (let i = 0; i < pCount; i++) {
        if (prevLines[pStart - 1 + i]!.canonHash !== currLines[cStart - 1 + i]!.canonHash) {
          identical = false;
          break;
        }
      }
      if (identical) {
        // WHY: equal counts with an identical canon sequence is a pure shift of a rigid
        // WHY: run: the only sound pairing is the positional zip (spec §3.5.1, Probe N).
        for (let i = 0; i < pCount; i++) pairing.set(pStart + i, cStart + i);
        return;
      }
    }

    if (pCount > MAX_LEAF_LINES || cCount > MAX_LEAF_LINES || pCount * cCount > MAX_LEAF_CELLS) {
      return;
    }

    const lcs = computeLCSPaths(prevLines, currLines, pStart, pEnd, cStart, cEnd);
    if (lcs.isUnique) {
      for (const [prevLine, currLine] of lcs.pairs) pairing.set(prevLine, currLine);
    }
  }

  alignRecursive(1, prevLines.length, 1, currLines.length);
  assertMonotonicPairing(pairing);
  return pairing;
}
