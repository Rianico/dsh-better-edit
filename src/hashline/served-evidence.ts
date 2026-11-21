/**
 * ServedEvidence — deep module owning what a served range can still prove.
 *
 * One entry point: `verifyServedRange` decides whether the anchor pair an edit
 * names is still grounded in the evidence this session was served, and rejects
 * with the echoed window when it is not. Every other decision here is private to
 * that call — the `ServedEvidenceRoute` union answers its three route questions
 * (`owesInteriorScan`, `acceptsInteriorHole`, `checksPosition`), the leased
 * route's boundary interception loses identity before any content question is
 * asked, and `throwUnknownOrForeign` refuses anchors the lease seam cannot place.
 *
 * `verifyRebasedSpan` is exported because two cells pin the leased route directly;
 * it is not a second entry point. `buildRangeEcho`/`fmtServedRows`/`moreRowsHint`
 * render the echo, and `ResolvedRange` is the shape both sides of the edit path
 * carry, so neither side has to import the other.
 *
 * WHY here: the verifier is read-side evidence, but the write path calls it. Kept
 * in anchor-pipeline it closed a cycle through the served mirror and the request
 * contract; as a leaf (domain registry, hash-assign, constants) it closes none.
 *
 * @module dsh-better-edit/hashline/served-evidence
 */

import { DomainError } from "../domain-errors.js";
import type { DomainErrorCode, RangeCause, ServedRow } from "../domain-errors.js";
import { HASH_SEP, canon } from "./hash-assign.js";
import { SERVED_ECHO_CAP } from "../constants.js";

export type ServedCode = "E_STALE_RANGE" | "E_UNSERVED_RANGE";

export class ServedRejectionError extends DomainError<DomainErrorCode> {
  readonly code: ServedCode;
  readonly unservedKind: "boundary" | "interior" | undefined;

  constructor(
    opts:
      | {
          code: "E_STALE_RANGE";
          headline: string;
          servedRows: ServedRow[];
          servedBlock: string;
          cause?: RangeCause;
          firstOffendingLine?: number;
        }
      | {
          code: "E_UNSERVED_RANGE";
          headline: string;
          servedRows: ServedRow[];
          servedBlock: string;
          unservedKind: "boundary" | "interior";
          firstOffendingLine?: number;
        },
  ) {
    if (opts.code === "E_STALE_RANGE") {
      super("E_STALE_RANGE", {
        headline: opts.headline,
        servedRows: opts.servedRows,
        servedBlock: opts.servedBlock,
        ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
        ...(opts.firstOffendingLine !== undefined
          ? { firstOffendingLine: opts.firstOffendingLine }
          : {}),
      });
    } else {
      super("E_UNSERVED_RANGE", {
        headline: opts.headline,
        servedRows: opts.servedRows,
        servedBlock: opts.servedBlock,
        unservedKind: opts.unservedKind,
        ...(opts.firstOffendingLine !== undefined
          ? { firstOffendingLine: opts.firstOffendingLine }
          : {}),
      });
    }
    this.name = "ServedRejectionError";
    this.code = opts.code;
    this.unservedKind = opts.code === "E_UNSERVED_RANGE" ? opts.unservedKind : undefined;
  }
}

export function servedPositionsOf(served: (string | null)[], hash: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < served.length; i++) {
    if (served[i] === hash) out.push(i);
  }
  return out;
}

export function buildRangeEcho(
  startLine: number,
  endLine: number,
  fileHashes: string[],
): ServedRow[] {
  const total = endLine - startLine + 1;
  const shown = Math.min(total, SERVED_ECHO_CAP);
  const rows: ServedRow[] = [];
  for (let ln = startLine; ln < startLine + shown; ln++) {
    rows.push({ position: ln - 1, hash: fileHashes[ln - 1]! });
  }
  return rows;
}

export function fmtServedRows(rows: ServedRow[], fileLines: string[]): string {
  return rows.map((row) => `${row.hash}${HASH_SEP}${fileLines[row.position] ?? ""}`).join("\n");
}
export function moreRowsHint(count: number, tail: string): string {
  return `[... ${count} more — ${tail}]`;
}
function paginationHint(nextOffset: number, more: number): string {
  return moreRowsHint(more, `read offset=${nextOffset}`);
}
/**
 * SAFETY: the read-only identity seam the edit path resolves a served anchor through (CP2-r1,
 * obligation (c)). Production wires it to `served_leases` + `line_lineage`; tests inject plain
 * maps. Nothing here writes: the authoritative `retired_at` writer is materialization.
 */
export interface LeaseIdentityView {
  lineId: number;
  servedLineNumber: number;
  servedSnapshotHash: string;
  retiredAt: number | null;
}

/**
 * The lease source a served span is verified against when identity is available.
 * `leaseFor` is a per-anchor lookup; `rebasedLineOf` answers where a leased `line_id` lives in the
 * buffer being edited (the store's `positionsByIdentity`).
 */
export interface LeaseSpanSource {
  leaseFor(anchor: string): LeaseIdentityView | undefined;
  rebasedLineOf(lineId: number): number | undefined;
  /**
   * Other files this session served one anchor for, excluding the file being edited.
   * Backed by the store's `(session_id, anchor)` lookup; it runs on the failure path only,
   * so the happy path pays nothing (upstream b92e0ec:src/hashline/resolve.ts:41-49).
   */
  anchorHomes(anchor: string): string[];
}

/**
 * The served-evidence route: which evidence owns verification of a served span. Constructed
 * EXACTLY ONCE per `verifyServedRange` call from the opt-in `leaseSource` seam, so the
 * leased/mirror conjunction — boundary interception, never-served interior scan, identity-gate
 * route, position-check null handling, and the gate's interior-hole rule — is one value's
 * decisions instead of five comment-enforced presence-tests.
 *
 * The union answers exactly three questions (below): `owesInteriorScan`, `acceptsInteriorHole`
 * and `checksPosition`. The `kind` discriminator itself routes the boundary interception and
 * the identity gate (obligation (c)).
 */
export type ServedEvidenceRoute = { kind: "leased"; source: LeaseSpanSource } | { kind: "mirror" };

function servedEvidenceRoute(leaseSource: LeaseSpanSource | undefined): ServedEvidenceRoute {
  return leaseSource === undefined ? { kind: "mirror" } : { kind: "leased", source: leaseSource };
}

/**
 * Question 1: does this route owe the never-served interior scan (upstream ADR-0024 decision 2)?
 * On the mirror route the mirror is the only evidence, so an interior hole rejects there.
 * The leased route does not scan: the identity gate owns verification — its two boundary
 * leases pin the span's extent, so an interior `null` carries no identity to verify and
 * `acceptsInteriorHole` admits it (decision 1, adopted; supersedes ADR-0019's decline).
 * Rejecting the hole on the scan would shadow the gate and keep taxing correct edits upstream
 * measured at 8/242 calls.
 */
function owesInteriorScan(route: ServedEvidenceRoute): boolean {
  return route.kind === "mirror";
}

/**
 * Question 2: is slot `k` of a `servedLen`-row gate window an interior hole the leased
 * identity gate accepts? Upstream ADR-0024 decision 1 (adopted; supersedes ADR-0019's
 * decline) narrows informed destruction to the boundaries: an unread interior row has no
 * identity to check, and the two verified boundary leases already fix the span's extent, so
 * refusing it only taxed a correct edit. A `null` boundary is the named anchor itself —
 * unverifiable by construction — so it keeps the fail-closed diagnosis. The mirror route
 * answers uniformly: `owesInteriorScan` has already rejected its holes before the gate can
 * be reached.
 */
function acceptsInteriorHole(route: ServedEvidenceRoute, k: number, servedLen: number): boolean {
  return route.kind === "leased" && k !== 0 && k !== servedLen - 1;
}

/**
 * Question 3: does this slot take part in the position comparison? On the leased route a
 * `null` slot carries no evidence to compare and the identity gate has already adjudicated
 * the window (accepting an interior hole per upstream ADR-0024 decision 1); failing the
 * position check on it here would re-shadow the gate. The non-leased route rejects its holes
 * in the interior scan above (decision 2 keeps its interior diagnosis) and compares every
 * slot as before.
 */
function checksPosition(route: ServedEvidenceRoute, slot: string | null): boolean {
  return route.kind !== "leased" || slot !== null;
}

/**
 * Refuses anchors the lease seam cannot place: the session holds no lease for them in this file.
 * Deterministic precedence, one condition per code — a lease held for ANOTHER file
 * (`E_FOREIGN_ANCHOR`) wins over holding no lease anywhere (`E_UNKNOWN_ANCHOR`). Neither
 * rejection serves rows: with no lease for this file no range can be identified, so there is
 * nothing trustworthy to retry with (port of upstream b92e0ec:src/hashline/lease-resolve.ts:87-118).
 */
function throwUnknownOrForeign(args: {
  filePath?: string;
  refused: string[];
  source: LeaseSpanSource;
}): never {
  const path = args.filePath ?? "this file";
  const refused = [...new Set(args.refused)];
  const homes = [...new Set(refused.flatMap((anchor) => args.source.anchorHomes(anchor)))].sort();
  if (homes.length > 0) {
    throw new DomainError("E_FOREIGN_ANCHOR", { path, anchors: refused, homes });
  }
  throw new DomainError("E_UNKNOWN_ANCHOR", { path, anchors: refused });
}

/**
 * Per-lease line-identity decision (port of upstream b92e0ec:src/hashline/resolve.ts:95-110):
 * a retired lease, or a live lease whose `line_id` has no coordinate in the buffer being
 * edited, is `stale`; otherwise the decision names the rebased line.
 */
function lineIdentityDecision(
  lease: LeaseIdentityView,
  source: LeaseSpanSource,
): { kind: "line"; line: number } | { kind: "stale" } {
  if (lease.retiredAt !== null) return { kind: "stale" };
  const rebased = source.rebasedLineOf(lease.lineId);
  if (rebased === undefined) return { kind: "stale" };
  return { kind: "line", line: rebased };
}

/**
 * The leased-route boundary identity interception (port of upstream
 * b92e0ec:src/hashline/lease-resolve.ts:120-200), running before the served-window gates:
 * a boundary anchor with no lease is lost identity — unknown or foreign, never a content
 * question. A stale boundary serves rows ONLY when exactly one bound is stale AND the survivor
 * is live and unshifted (its rebased coordinate equals its served coordinate — evidence no
 * shift occurred): that one case rejects with `E_UNVERIFIED_RANGE`, the named window echoed as
 * a fresh read; every other stale case rejects with `E_TARGET_LOST`, carrying no rows.
 * The named coordinates are lease-derived (`servedLineNumber`) only — content placement never
 * names a window for a retired bound.
 */
function interceptLeaseBoundaries(args: {
  startHash: string;
  endHash: string;
  fileHashes: string[];
  fileLines: string[];
  filePath?: string;
  leaseSource: LeaseSpanSource;
}): void {
  const { fileHashes, fileLines, leaseSource } = args;
  const fromLease = leaseSource.leaseFor(args.startHash);
  const toLease = leaseSource.leaseFor(args.endHash);
  if (fromLease === undefined || toLease === undefined) {
    throwUnknownOrForeign({
      ...(args.filePath !== undefined ? { filePath: args.filePath } : {}),
      refused: [
        ...(fromLease === undefined ? [args.startHash] : []),
        ...(toLease === undefined ? [args.endHash] : []),
      ],
      source: leaseSource,
    });
  }
  const fromDecision = lineIdentityDecision(fromLease, leaseSource);
  const toDecision = lineIdentityDecision(toLease, leaseSource);
  if (fromDecision.kind === "stale" || toDecision.kind === "stale") {
    const fromLiveUnshifted =
      fromDecision.kind === "line" && fromDecision.line === fromLease.servedLineNumber;
    const toLiveUnshifted =
      toDecision.kind === "line" && toDecision.line === toLease.servedLineNumber;
    const staleServedLine =
      fromDecision.kind === "stale" ? fromLease.servedLineNumber : toLease.servedLineNumber;
    const exactlyOneStale = (fromDecision.kind === "stale") !== (toDecision.kind === "stale");
    const survivorLiveUnshifted =
      fromDecision.kind === "stale" ? toLiveUnshifted : fromLiveUnshifted;
    if (exactlyOneStale && survivorLiveUnshifted) {
      const rawStart = Math.min(fromLease.servedLineNumber, toLease.servedLineNumber);
      const rawEnd = Math.max(fromLease.servedLineNumber, toLease.servedLineNumber);
      const len = fileHashes.length;
      const startLine = Math.max(1, rawStart);
      const endLine = Math.min(len, rawEnd);
      // Collapsed-window guard: fail closed to `E_TARGET_LOST` when the named window
      // collapses (e.g. served startLine 10 against a 4-line file) or misses the file.
      if (len > 0 && startLine <= endLine && rawEnd >= 1 && rawStart <= len) {
        const servedRows = buildRangeEcho(startLine, endLine, fileHashes);
        const totalLen = endLine - startLine + 1;
        const tail =
          servedRows.length < totalLen
            ? `\n${paginationHint(startLine + servedRows.length, totalLen - servedRows.length)}`
            : "";
        throw new DomainError("E_UNVERIFIED_RANGE", {
          servedRows,
          servedBlock: fmtServedRows(servedRows, fileLines) + tail,
          cause: "retirement",
          firstOffendingLine: staleServedLine,
        });
      }
    }
    throw new DomainError("E_TARGET_LOST", {
      servedLine: staleServedLine,
      ...(args.filePath !== undefined ? { path: args.filePath } : {}),
      cause: "retirement",
    });
  }
}

/**
 * The identity gate for a served span (obligation (c)) — replaces the unconditional position check
 * when a lease source is present.
 *
 * A **benign shift** — the intended line's bytes are unchanged and only its position moved (exterior
 * drift above the served span) — passes: the served anchor's live lease resolves to the rebased
 * coordinate the edit targets, so the edit applies there with no re-read. A **look-alike rebind** —
 * the named line was deleted and a different line now holds the same bytes — rejects: the leased
 * `line_id` no longer lives at the rebased coordinate, or is gone from the buffer's identity map
 * entirely, so the anchor cannot be reconciled with the line it named.
 *
 * Fail-closed arms, all `E_STALE_RANGE` with the echo rows: a window length that changed because
 * an external insert/delete landed strictly inside the span, a truncated mirror slot (no served row
 * left to reconcile), a never-served boundary row (the named anchor itself, unverifiable without a
 * served row), an unleased served row (a serve predating lease granting), a retired lease, or a
 * coordinate no leased identity occupies. An interior mirror row the span never served (`null`) is
 * accepted (upstream ADR-0024 decision 1, adopted; supersedes ADR-0019's decline): it carries no
 * identity to verify and the two boundary leases plus the window-length check pin the span's extent.
 * Throwing happens before any write, so a rejection leaves the file byte-identical.
 */
export function verifyRebasedSpan(args: {
  served: (string | null)[];
  servedStart: number;
  servedEnd: number;
  rebasedStart: number;
  rebasedEnd: number;
  /** The leased evidence route — this gate is what the leased kind owns. */
  route: Extract<ServedEvidenceRoute, { kind: "leased" }>;
  echo: string;
  echoRows: ServedRow[];
  where: string;
}): void {
  const { served, route, echo, echoRows, where } = args;
  const leaseSource = route.source;
  const servedLen = args.servedEnd - args.servedStart + 1;
  const rebasedLen = args.rebasedEnd - args.rebasedStart + 1;
  if (rebasedLen !== servedLen) {
    throw new ServedRejectionError({
      code: "E_STALE_RANGE",
      headline: `served span (${servedLen} lines) no longer matches the rebased range (${rebasedLen} lines)${where}.`,
      servedBlock: echo,
      firstOffendingLine: args.rebasedStart,
      servedRows: echoRows,
      cause: "served-range staleness",
    });
  }
  for (let k = 0; k < servedLen; k++) {
    const servedAnchor = served[args.servedStart - 1 + k];
    const currentLine = args.rebasedStart + k;
    // WHY: the served window can come from the leases' own `servedLineNumber` because a truncated
    // serve dropped the mirror rows it no longer covers: the lease outlives the mirror. An
    // absent slot is that missing record, never "this line was never served", so the span
    // fails closed on the truth (the served record cannot be reconciled) and the current
    // range is served for a fresh read.
    if (servedAnchor === undefined) {
      throw new ServedRejectionError({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} has no served mirror row left; the served window was truncated.`,
        servedBlock: echo,
        firstOffendingLine: currentLine,
        servedRows: echoRows,
        cause: "served-range staleness",
      });
    }
    if (servedAnchor === null) {
      // WHY: the interior-accept / boundary-reject split is the route's `acceptsInteriorHole`
      // decision (upstream ADR-0024 decision 1, adopted; supersedes ADR-0019's decline) — see
      // its doc for why an unread interior row passes and a `null` boundary keeps the
      // fail-closed diagnosis.
      if (!acceptsInteriorHole(route, k, servedLen)) {
        throw new ServedRejectionError({
          code: "E_STALE_RANGE",
          headline: `line ${currentLine}${where} was never served.`,
          servedBlock: echo,
          firstOffendingLine: currentLine,
          servedRows: echoRows,
          cause: "never-served",
        });
      }
      continue;
    }
    const lease = leaseSource.leaseFor(servedAnchor);
    if (lease === undefined) {
      throw new ServedRejectionError({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} has no served line identity.`,
        servedBlock: echo,
        firstOffendingLine: currentLine,
        servedRows: echoRows,
        cause: "never-served",
      });
    }
    // WHY: two distinct diagnoses, one per condition: a terminal lease is a `retirement` — the
    // identity is gone and only a re-read revives it — while a live lease whose `lineId` no
    // longer sits at its expected coordinate is drift between the served record and the
    // rebased span.
    if (lease.retiredAt !== null) {
      throw new ServedRejectionError({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} no longer resolves to the line identity it was served with.`,
        servedBlock: echo,
        firstOffendingLine: currentLine,
        servedRows: echoRows,
        cause: "retirement",
      });
    }
    if (leaseSource.rebasedLineOf(lease.lineId) !== currentLine) {
      throw new ServedRejectionError({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} no longer resolves to the line identity it was served with.`,
        servedBlock: echo,
        firstOffendingLine: currentLine,
        servedRows: echoRows,
        cause: "served-range staleness",
      });
    }
  }
}

export function verifyServedRange(args: {
  served: (string | null)[];
  startHash: string;
  endHash: string;
  startLine: number;
  endLine: number;
  fileHashes: string[];
  fileLines: string[];
  filePath?: string;
  servedCanons?: (string | null)[];
  retired?: ReadonlySet<string>;
  /**
   * Present => the leased evidence route (identity gate `verifyRebasedSpan` replaces the position
   * check below, obligation (c)); absent => the mirror route with its unconditional position
   * check. Identity only, never a weaker position check. Turns into the single
   * `ServedEvidenceRoute` value at the top of the body — the rest of the function never
   * presence-tests this argument.
   */
  leaseSource?: LeaseSpanSource;
}): void {
  const { served, startHash, endHash, startLine, endLine, fileHashes, fileLines, filePath } = args;
  // The one route construction (obligation (c)): every leased/mirror decision below consults
  // this value, so the conjunction cannot drift site by site.
  const route = servedEvidenceRoute(args.leaseSource);
  const where = filePath ? ` in ${filePath}` : "";
  const retiredSet = args.retired ?? new Set<string>();
  const servedCanons = args.servedCanons;
  const echoRows = buildRangeEcho(startLine, endLine, fileHashes);
  const totalLen = endLine - startLine + 1;
  const tail =
    echoRows.length < totalLen
      ? `\n${paginationHint(startLine + echoRows.length, totalLen - echoRows.length)}`
      : "";
  const echo = fmtServedRows(echoRows, fileLines) + tail;

  // Retired-anchor check for boundaries (whole-span S@3==S@3) — the freed-hash concept, named
  // `retired` here since ADR-0013 (ADR-0028 records the vocabulary ruling).
  // If hash was freed in this epoch, any reuse is stale even at same pos+same canon.
  // Early reject checks canon change to avoid false positive on same line re-read.
  if (retiredSet.has(startHash) || retiredSet.has(endHash)) {
    const retiredHash = retiredSet.has(startHash) ? startHash : endHash;
    if (servedCanons) {
      const pos = fileHashes.indexOf(retiredHash);
      if (pos >= 0) {
        const servedIdx = served.indexOf(retiredHash);
        const expected = servedIdx >= 0 ? servedCanons[servedIdx] : undefined;
        const actual = canon(fileLines[pos] ?? "");
        if (expected !== undefined && expected !== null && expected !== actual) {
          throw new ServedRejectionError({
            code: "E_STALE_RANGE",
            headline: `anchor "${retiredHash}" was freed since last full read (retired, canon changed from "${expected}" to "${actual}"). Re-read.`,
            servedBlock: echo,
            firstOffendingLine: pos + 1,
            servedRows: echoRows,
          });
        }
      }
    }
  }

  // The leased route resolves boundaries through the lease seam FIRST (upstream
  // b92e0ec:src/hashline/lease-resolve.ts:120-200): a missing or stale boundary lease rejects
  // before content placement can substitute a look-alike for the lost identity. The non-leased
  // route keeps mirror placement alone (upstream's non-leased analogue,
  // served-verification.ts:745, is the zero-position arm below).
  if (route.kind === "leased") {
    interceptLeaseBoundaries({
      startHash,
      endHash,
      fileHashes,
      fileLines,
      ...(filePath !== undefined ? { filePath } : {}),
      leaseSource: route.source,
    });
  }

  const startPositions = servedPositionsOf(served, startHash);
  const endPositions = servedPositionsOf(served, endHash);
  const currentLen = endLine - startLine + 1;
  let from: number | undefined;
  let to: number | undefined;
  // Exact-boundary rule (ADR-0018, superseding ADR-0004): each boundary anchor must have
  // EXACTLY one served position. Anything else leaves `from`/`to` undefined and rejects
  // below — there is no candidate-span search that could re-bind onto a look-alike line.
  if (startPositions.length === 1 && endPositions.length === 1) {
    from = Math.min(startPositions[0]!, endPositions[0]!);
    to = Math.max(startPositions[0]!, endPositions[0]!);
  }
  if (from === undefined || to === undefined) {
    const missing = [
      ...new Set([
        ...(startPositions.length === 0 ? [startHash] : []),
        ...(endPositions.length === 0 ? [endHash] : []),
      ]),
    ];
    if (missing.length > 0) {
      // A boundary anchor the mirror never placed was never served for this file: the
      // rejection carries no rows — with nothing served there is nothing trustworthy to
      // retry with, only a read restores grounding (port of upstream
      // b92e0ec:src/hashline/served-verification.ts:729-749).
      throw new DomainError("E_UNKNOWN_ANCHOR", {
        path: filePath ?? "this file",
        anchors: missing,
      });
    }
    const problems: string[] = [];
    if (startPositions.length > 1) {
      problems.push(`anchor_from "${startHash}" was served at ${startPositions.length} positions`);
    }
    if (endPositions.length > 1) {
      problems.push(`anchor_to "${endHash}" was served at ${endPositions.length} positions`);
    }
    throw new ServedRejectionError({
      code: "E_UNSERVED_RANGE",
      unservedKind: "boundary",
      headline:
        `cannot verify range against served state${where}: ${problems.join("; ")}. ` +
        `Each boundary anchor must have exactly one served position — no served span is searched ` +
        `for a look-alike line. A full read will re-sync the served mirror; the echoed range below ` +
        `is current content.`,
      servedBlock: echo,
      servedRows: echoRows,
    });
  }

  // The never-served interior scan is the mirror route's evidence rule (upstream ADR-0024
  // decision 2); the leased route skips it because the identity gate owns interior holes
  // there (decision 1) — the full rationale lives on `owesInteriorScan`.
  if (owesInteriorScan(route)) {
    for (let i = from; i <= to; i++) {
      if (served[i] === null) {
        throw new ServedRejectionError({
          code: "E_UNSERVED_RANGE",
          unservedKind: "interior",
          headline: `line ${i + 1}${where} was never served.`,
          servedBlock: echo,
          firstOffendingLine: i + 1,
          servedRows: echoRows,
        });
      }
    }
  }
  const servedLen = to - from + 1;
  if (servedLen !== currentLen) {
    throw new ServedRejectionError({
      code: "E_STALE_RANGE",
      headline: `served span (${servedLen} lines) no longer matches current range (${currentLen} lines)${where}. Re-read.`,
      servedBlock: echo,
      firstOffendingLine: startLine,
      servedRows: echoRows,
    });
  }
  // Position check or identity gate — the seam is opt-in (obligation (c)).
  //
  // With a lease source, identity decides: `verifyRebasedSpan` checks the whole served window by
  // the leases its anchors were served with, so a benign shift (same bytes, moved position —
  // exterior drift above the span) applies at its rebased coordinate with no re-read, while a
  // look-alike rebind (the named line was deleted and another line now holds its bytes) rejects.
  //
  // Without a lease source the unconditional position check below stands: identity only, never a
  // weaker position check. The pos-free route is REACHABLE on a normal session route (a windowed
  // read never pinned the epoch; a preview/no-store edit carries no leases), which is why this
  // fallback cannot be dropped.
  if (route.kind === "leased") {
    verifyRebasedSpan({
      served,
      servedStart: from + 1,
      servedEnd: to + 1,
      rebasedStart: startLine,
      rebasedEnd: endLine,
      route,
      echo,
      echoRows,
      where,
    });
  } else if (from !== startLine - 1) {
    throw new ServedRejectionError({
      code: "E_STALE_RANGE",
      headline: `anchor was served at line ${from + 1} but now resolves to line ${startLine}. Re-read.`,
      servedBlock: echo,
      firstOffendingLine: startLine,
      servedRows: echoRows,
    });
  }
  // Canon check for same-pos different content (collision)
  if (servedCanons) {
    for (let k = 0; k < servedLen; k++) {
      const expected = servedCanons[from + k];
      if (expected !== null && expected !== undefined) {
        const actual = canon(fileLines[startLine - 1 + k] ?? "");
        if (expected !== actual) {
          throw new ServedRejectionError({
            code: "E_STALE_RANGE",
            headline: `line ${startLine + k}${where} canon differs from served (expected "${expected}" vs actual "${actual}").`,
            servedBlock: echo,
            firstOffendingLine: startLine + k,
            servedRows: echoRows,
          });
        }
      }
    }
  }
  // Retired-anchor interior check (whole-span) — gated on canon inequality (fail-closed only for different canon)
  for (let k = 0; k < servedLen; k++) {
    const h = fileHashes[startLine - 1 + k];
    if (h && retiredSet.has(h)) {
      const expectedCanon = servedCanons?.[from + k] ?? undefined;
      const actualCanon = canon(fileLines[startLine - 1 + k] ?? "");
      if (expectedCanon !== undefined && expectedCanon !== null && expectedCanon !== actualCanon) {
        throw new ServedRejectionError({
          code: "E_STALE_RANGE",
          headline: `line ${startLine + k}${where} uses retired anchor "${h}" (freed since last full read, canon changed). Re-read.`,
          servedBlock: echo,
          firstOffendingLine: startLine + k,
          servedRows: echoRows,
        });
      }
    }
  }
  for (let k = 0; k < servedLen; k++) {
    // The leased route's `null` skip is `checksPosition`'s decision (the identity gate already
    // adjudicated the hole); the mirror route's holes rejected in the scan above.
    if (!checksPosition(route, served[from + k])) continue;
    // The served anchor must still name this line. #138 split identity from alignment: anchors key on
    // the RAW line, so an external formatter's edge-whitespace rewrite rotates the anchor at an
    // unchanged served position while the CANON still names the same line — the tolerance this
    // equality used to carry implicitly (anchors were canon-derived, so equal anchor ⇔ equal canon).
    // Compare the canon directly: a canon change still rejects here, and a missing canon record
    // (`servedCanons` absent, a pre-canon serve) keeps the strict anchor equality — fail closed.
    const sameAnchor = served[from + k] === fileHashes[startLine - 1 + k];
    const servedCanonAt = servedCanons?.[from + k];
    const currentCanon = canon(fileLines[startLine - 1 + k] ?? "");
    if (
      !sameAnchor &&
      (servedCanonAt === undefined || servedCanonAt === null || servedCanonAt !== currentCanon)
    ) {
      const offendingLine = startLine + k;
      throw new ServedRejectionError({
        code: "E_STALE_RANGE",
        headline: `line ${offendingLine}${where} differs from what was served. Re-read.`,
        servedBlock: echo,
        firstOffendingLine: offendingLine,
        servedRows: echoRows,
      });
    }
  }
}

export interface ResolvedRange {
  startLine: number;
  endLine: number;
  startHash: string;
  endHash: string;
  delta: number;
}
