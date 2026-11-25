/**
 * Domain error registry — the closed, type-safe contract for every
 * model-facing diagnostic. Zero dependencies: no imports, so any seam can
 * throw without wiring a store, session, or hasher.
 *
 * INVARIANT (the point of this module): a code is never declared without a
 * producer. Every `DomainErrorCode` member must have at least one
 * `new DomainError(code, …)` / `formatError(code, …)` producer in src/
 * (subclass constructions `new EditHashEchoError` / `new BadAnchorError` /
 * `new AnchorMismatchError("E_STALE_ANCHOR", …)` /
 * `new ServedRejectionError({ code, … })` /
 * `new AnchorSpaceExhaustedError(…)` count as producers of their code), or be
 * listed in `DEFERRED_PRODUCERS`, and every code passed at a producer site
 * must be a union member. Asserted BOTH directions in
 * test/arch/domain-error-registry.test.ts. This is what makes the registry a
 * contract instead of a list.
 *
 * COUNT DEVIATION (F4, ratified): this registry's E_* vocabulary is larger
 * than upstream's 19. Upstream has no str_replace_editor shadow; the six
 * shadow codes (E_BLIND_REPLACE, E_UNSUPPORTED, E_BAD_COMMAND, E_FILE_EXISTS,
 * E_NO_MATCH, E_AMBIGUOUS_MATCH) are live model-facing contract per accepted
 * ADR-0015, and E_UNSERVED_RANGE is live contract too (T4 declined its
 * retirement — its producers are reachable, CP1 H1 → `SR@790`). A closed
 * vocabulary that omits live codes is not closed — it just pushes them
 * outside the contract (T4 also deleted four declarations that had no local
 * producer at all; see `DEFERRED_PRODUCERS`).
 * WHY payloads carry facts, not pre-baked strings: the producer already holds
 * the evidence (line numbers, hashes, paths, counts), so the registry owns the
 * neutral sentence and the producer passes values. The one deliberate
 * exception is `E_BAD_PAYLOAD`, whose payload is `{ message }` rendered
 * verbatim — admission-boundary rejections are too heterogeneous for a fixed
 * shape, and the message is the fact.
 *
 * WHY a remedy clause may appear only when it is helpful, unharmful and
 * fail-closed, AND the evidence pins a single cause. When the intent is
 * ambiguous the payload states the fact and carries NO remedy, because an
 * intent-guessing suggestion steers the model's next action. Remedy-free by
 * rule (no `remedy` field on the registry entry):
 * - `E_UNKNOWN`: no cause is knowable at all.
 * - `E_NOOP_LOOP`: the refusal's evidence pins the fact (the range already
 *   contains the text) but not the model's intent, so a remedy clause would
 *   dress a status fact as an action.
 *
 * WHY `remedy` is declaration-only and never rendered into the message: the
 * `format` strings already carry their own retry prose where the evidence pins
 * it. Do not "fix" this by appending `remedy` to the rendered text. The
 * declaration is owned by `DECLARATION_ONLY_FIELDS` below, which the arch oracle
 * pins by identity AND checks for readers (0 today) — so it cannot rot quietly.
 *
 * @module dsh-better-edit/domain-errors
 */

/**
 * Message channel: `formatError` prefixes every rendered error with
 * `[TO <AUDIENCE>]` — the `TO` marks the addressee (who must act), while the
 * remedy text names the action.
 */
export type Audience = "MODEL" | "USER";

/**
 * One served row — position is 0-based, hash is the 3-char anchor. Declared
 * here (not in anchor-pipeline) so the registry stays zero-dependency and the
 * pipeline imports it from here.
 */
export interface ServedRow {
  position: number;
  hash: string;
}

/** WHY: user-facing diagnosis carried as `details.cause` on range-family rejections. */
export type RangeCause =
  | "retirement"
  | "never-served"
  | "served-range staleness"
  | "anchor staleness"
  | "served span";

export type DomainErrorCode =
  | "E_BAD_PAYLOAD"
  | "E_EMPTY_RANGE"
  | "E_STALE_ANCHOR"
  | "E_UNKNOWN_ANCHOR"
  | "E_FOREIGN_ANCHOR"
  | "E_STALE_RANGE"
  | "E_TARGET_LOST"
  | "E_UNVERIFIED_RANGE"
  | "E_MALFORMED_ANCHOR"
  | "E_SUSPICIOUS_TEXT"
  | "E_BATCH_ABORT"
  | "E_NOOP_LOOP"
  | "E_UNSUPPORTED_FILE"
  // The text-only write seam cannot reproduce the recorded encoding byte-for-byte
  // (UTF-16/UTF-32, or a legacy charset with non-ASCII content). A distinct code,
  // never E_STALE_ANCHOR / E_UNSUPPORTED_FILE: the read succeeded, only the write
  // is impossible through `writeText(target, content: string, …)`.
  | "E_ENCODING_UNWRITABLE"
  | "E_ACCESS"
  | "E_NOT_FOUND"
  | "E_UNDO_STALE"
  | "E_UNDO_UNAVAILABLE"
  | "E_UNDO_NOT_RECORDED"
  | "E_UNKNOWN"
  | "E_LARGE_FILE"
  | "E_UNSERVED_RANGE"
  // SHADOW (F4): the str_replace_editor shadow's live model-facing contract
  // (accepted ADR-0015) — blind observation, unimplemented op, bad command,
  // existing file, unmatched/ambiguous old_str. Upstream has no shadow, so
  // upstream's 19 do not cover them; a closed vocabulary that omits live
  // codes is not closed.
  | "E_BLIND_REPLACE"
  | "E_UNSUPPORTED"
  | "E_BAD_COMMAND"
  | "E_FILE_EXISTS"
  | "E_NO_MATCH"
  | "E_AMBIGUOUS_MATCH"
  | "E_STORE_NEWER_VERSION";

/**
 * Applied-tier warning codes — the `[W_*]` line an APPLIED mutation carries. A
 * `[W_*]` line in this union reports a write that landed; `[E_*]` reports a rejection.
 * `formatWarning` is the sole producer of applied-tier `[W_*]` headers and
 * `formatError` the sole composer of `[E_*]` headers: no raw `[E_*]`/`[W_*]` header
 * literal may exist outside this module (asserted in
 * test/arch/domain-error-registry.test.ts).
 *
 * Read-tier codes are NOT members here: they live in `ReadWarningCode` and are produced
 * only by `formatReadWarning`, which renders a bare `[<CODE>]` header because a read
 * reports state observed before any write and therefore addresses no audience.
 */
export type DomainWarningCode =
  | "W_NEVER_SERVED_SHAPE"
  | "W_SERVED_PREFIX_MISMATCH"
  | "W_REVERSED_ANCHORS"
  | "W_UNICODE_LITERAL"
  | "W_LITERAL_BYPASS"
  | "W_NOOP"
  | "W_UNSERVED_INTERIOR"
  | "W_EOL_REWRITTEN"
  | "W_ENCODING_MIGRATED";

/**
 * Read-tier warning codes — a SEPARATE tier from `DomainWarningCode`, on purpose.
 *
 * An applied-tier `[W_*]` reports a mutation that landed, so it carries an audience
 * (`[MODEL]`/`[USER]`) naming who must act. A read-tier code reports state OBSERVED
 * before any write: nothing was mutated, so there is no actor to address and the header
 * is bare `[<CODE>]`. Folding the two into one union would force a read notice to carry
 * an audience it does not have.
 */
export type ReadWarningCode = "W_MIXED_EOL";

export interface ErrorPayloadMap {
  E_BAD_PAYLOAD: {
    message: string;
  };
  E_EMPTY_RANGE: Record<string, never>;
  E_STALE_ANCHOR: {
    headline: string;
    servedRows?: ServedRow[];
    servedBlock?: string;
    cause?: RangeCause;
  };
  E_UNKNOWN_ANCHOR: {
    path: string;
    anchors: string[];
  };
  E_FOREIGN_ANCHOR: {
    path: string;
    anchors: string[];
    homes: string[];
  };
  E_STALE_RANGE: {
    headline: string;
    servedRows: ServedRow[];
    servedBlock: string;
    cause?: RangeCause;
    firstOffendingLine?: number;
    // The echoed rows are the CURRENT file's anchors AND a real serve: a rejection that
    // identified the region from the committed snapshot records them (rows + canons +
    // snapshot + leases, ADR-0043), so a retry with them resolves. The payload's rows
    // (`servedRows.length`) carry the distinction — empty means the region is
    // unidentifiable, nothing is recorded, and only a read of the named lines restores it;
    // non-empty means the rows are the named region's current anchors.
  };
  E_TARGET_LOST: {
    servedLine: number;
    path?: string;
    cause: RangeCause;
    firstOffendingLine?: number;
  };
  E_UNVERIFIED_RANGE: {
    servedRows: ServedRow[];
    servedBlock: string;
    cause: RangeCause;
    firstOffendingLine?: number;
  };
  E_MALFORMED_ANCHOR: {
    rawAnchor: string;
    reason: string;
  };
  E_SUSPICIOUS_TEXT: {
    target: "edit" | "write";
    path: string;
    line: number;
    hash: string;
    servedLine: number;
    /**
     * Submission tally. Optional: the edit/write producers hold no tally
     * state, so they omit it and the refusal renders without the submission
     * clause. Present only when a caller tracks resubmissions.
     */
    count?: number;
  };
  E_BATCH_ABORT: {
    /** First failing item: routes the typed path and is the single bullet's index when `failures` is absent. */
    index: number;
    path: string;
    /** Items the call submitted; the verdict renders `<failed> of <total>`. */
    total?: number;
    /** The first failing item's inner failure message (already header-bearing). */
    inner: string;
    /**
     * Serve disposition for the echoed rows (ADR-0043), rendered once under the single
     * bullet. Absent when no serve was attempted (the envelope re-renders no rows).
     */
    serveNote?: string;
    /**
     * Every failing item in order; present only when more than one failed
     * (C: one resubmission fixes every failure). Each item keeps its own
     * `[E_*]` inline in `inner`.
     */
    failures?: Array<{ index: number; inner: string }>;
    /**
     * Union of every failing item's rows, in item order. Machine payload only: the formatter
     * never re-renders rows (ADR-0046) — each inner message owns its own echo.
     */
    servedRows: ServedRow[];
    /** Every failing item's block joined in item order ("" when none). */
    servedBlock: string;
    /** Carried only when every failing item agrees on one diagnosis. */
    cause?: RangeCause;
  };
  E_NOOP_LOOP: {
    ref: string;
    anchorFrom: string;
    anchorTo: string;
    count: number;
    batch: boolean;
    servedBlock: string;
    /**
     * Rowless changed-buffer variant: names the withheld rows and the current-file lines a read would
     * serve. Rendered in place of the range block (`servedBlock === ""`).
     */
    note?: string;
  };
  E_UNSUPPORTED_FILE: {
    path: string;
    kind: "directory" | "binary" | "image";
    description?: string;
  };
  E_ENCODING_UNWRITABLE: {
    path: string;
    /** The encoding recorded when the file was read. */
    encoding: string;
  };
  E_ACCESS: {
    path: string;
    kind: "denied" | "symlink-loop" | "unreachable";
    access?: "read" | "write";
  };
  E_NOT_FOUND: {
    path: string;
  };
  E_UNDO_STALE: {
    path: string;
    reason?: "deleted" | "modified";
  };
  E_UNDO_UNAVAILABLE: {
    path: string;
    batch?: boolean;
  };
  E_UNDO_NOT_RECORDED: {
    path: string;
  };
  E_UNKNOWN: {
    errorName: string;
    message: string;
  };
  E_LARGE_FILE: {
    path?: string;
    limitKind: "lines" | "hash-space";
    lineCount?: number;
    limit: number;
  };
  E_UNSERVED_RANGE: {
    headline: string;
    servedRows: ServedRow[];
    servedBlock: string;
    // Same contract as `E_STALE_RANGE.servedRows`: empty means no row-carrying region exists.
    unservedKind: "boundary" | "interior";
    firstOffendingLine?: number;
    cause?: RangeCause;
  };
  E_BLIND_REPLACE: {
    path: string;
    /** The tool whose observation gate fired: the shadow or the write policy. */
    command: string;
  };
  E_UNSUPPORTED: {
    /** The known-but-unimplemented command (undo_edit). */
    command: string;
  };
  E_BAD_COMMAND: {
    /** The unknown command value (any JSON value the caller sent). */
    command: unknown;
  };
  E_FILE_EXISTS: {
    path: string;
  };
  E_NO_MATCH: {
    path: string;
  };
  E_AMBIGUOUS_MATCH: {
    path: string;
    matches: number;
  };
  E_STORE_NEWER_VERSION: {
    path: string;
    storedVersion: number;
    supportedVersion: number;
  };
}

export interface CodeSpec<P> {
  audience: Audience;
  format: (payload: P) => string;
  remedy?: string;
}

// WHY: the `Retry with these anchors (no read needed).` affordance was deleted by T6. It was
// WHY: unreachable from production (every producer set `reread: true`), and its premise was
// WHY: false: the echoed rows are the current file's anchors, not serves, so a retry with them
// WHY: rejects at the same site. The retry affordance a payload carries is its rows.

// WHY: 3-char is the hashline anchor width; this module stays zero-dependency
// WHY: so the width is stated, never imported.
const ANCHOR_WIDTH = 3;

function suspiciousSubmission(count: number | undefined): string {
  if (count === undefined) return "";
  const submitted = `(submission ${count}×)`;
  if (count < 2) return ` Nothing was written. ${submitted}`;
  return (
    ` Nothing was written. ${submitted}` +
    ` Identical refusal submitted ${count}× — the bytes still reproduce a served row.` +
    ` Omit the copied anchors from \`replace_with\` and retry with the same anchors, or declare intent with mode: "literal".`
  );
}

function suspiciousFormat(payload: ErrorPayloadMap["E_SUSPICIOUS_TEXT"]): string {
  if (payload.target === "write") {
    return (
      `Refused write to ${payload.path}: line ${payload.line} begins with ` +
      `the exact ${payload.hash}│ anchor served for this session, path, and line ${payload.servedLine}. ` +
      `HASH│ anchors are tool output, not file content. ` +
      // F2: the built-in write tool takes no mode flag, so the write arm
      // must not promise a literal retry — file content only.
      `Retry with file content only (remove the entire copied anchor chain). ` +
      `Re-read the file for fresh anchors if needed.` +
      suspiciousSubmission(payload.count)
    );
  }
  return (
    `Refused edit to ${payload.path}: replacement line ${payload.line} begins with ` +
    `the exact ${payload.hash}│ anchor served for this session, path, and line ${payload.servedLine}. ` +
    `HASH│ anchors are tool output, not file content. ` +
    `Omit the copied anchors from \`replace_with\` and retry with the same anchors, or declare intent with mode: "literal". ` +
    `Re-read the file for fresh anchors if needed.` +
    suspiciousSubmission(payload.count)
  );
}

function unsupportedFormat(payload: ErrorPayloadMap["E_UNSUPPORTED_FILE"]): string {
  if (payload.kind === "directory") {
    return (
      `Path is a directory: ${payload.path}. Pass the text file inside it ` +
      `(a file, never a directory) in "file" and retry.`
    );
  }
  if (payload.kind === "image") {
    return (
      `Path is an image file: ${payload.path}. Hashline edit only supports text files; ` +
      `choose a text file and retry.`
    );
  }
  return (
    `Path is a binary file: ${payload.path} (${payload.description ?? "binary"}). ` +
    `Hashline edit only supports text files; choose a text file and retry.`
  );
}

function accessFormat(payload: ErrorPayloadMap["E_ACCESS"]): string {
  if (payload.kind === "symlink-loop") {
    return (
      `Too many symbolic links while resolving: ${payload.path}. ` +
      `Retry with the real file location.`
    );
  }
  if (payload.kind === "unreachable") {
    return (
      `Cannot access file: ${payload.path}. Verify the "file" value exists and is reachable, ` +
      `then retry.`
    );
  }
  const label = payload.access === "write" ? "not writable" : "not readable";
  return `File is ${label}: ${payload.path}. Fix permissions or choose a writable file and retry.`;
}

function largeFileFormat(payload: ErrorPayloadMap["E_LARGE_FILE"]): string {
  if (payload.limitKind === "hash-space") {
    return (
      `Cannot allocate a unique hash anchor: the file exceeds the ${payload.limit}-line limit ` +
      `for ${ANCHOR_WIDTH}-char hashline anchors. For very large files use write or a non-line-based approach.`
    );
  }
  const observed =
    payload.lineCount === undefined ? `more than ${payload.limit}` : `${payload.lineCount}`;
  const where = payload.path ?? "the file";
  return (
    `${where} has ${observed} lines, exceeding the ${payload.limit}-line edit limit. ` +
    `Hashline editing targets source-sized files; for very large files use write or a non-line-based approach.`
  );
}

function staleAnchorFormat(payload: ErrorPayloadMap["E_STALE_ANCHOR"]): string {
  // F6: stale anchors carry their context block directly — no `Current
  // range:` heading and no retry hint. The headline already says "Re-read
  // for fresh anchors"; appending "Retry with these anchors" would
  // contradict it in the same breath.
  if (!payload.servedBlock) return payload.headline;
  return `${payload.headline}\n\n${payload.servedBlock}`;
}

function staleRangeFormat(payload: ErrorPayloadMap["E_STALE_RANGE"]): string {
  // F7: the `Current range:` heading exists only when there are rows to
  // show; a row-less rejection (e.g. the version-guard arm) renders the
  // headline alone; the payload's rows are its retry affordance.
  if (!payload.servedBlock) return payload.headline;
  return `${payload.headline}\nCurrent range:\n${payload.servedBlock}`;
}

function blindReplaceFormat(payload: ErrorPayloadMap["E_BLIND_REPLACE"]): string {
  if (payload.command === "str_replace_editor") {
    return (
      `str_replace_editor: ${payload.path} has not been viewed in this session ` +
      `(no file encoding state at the current version). Call view first, then retry. Nothing was written.`
    );
  }
  return (
    `${payload.path} has not been observed in this session (read-before-write policy). ` +
    `Call read() first, then retry the edit.`
  );
}

function unservedRangeFormat(payload: ErrorPayloadMap["E_UNSERVED_RANGE"]): string {
  // F7: heading only when rows exist; one rule for both range codes.
  if (!payload.servedBlock) return payload.headline;
  return `${payload.headline}\nCurrent range:\n${payload.servedBlock}`;
}

// WHY: an all-digit anchor is shape evidence pinned to the anchor string itself
// (upstream ADR-0021 decision 4) — not a guess about path versus session — so the note
// states the shape fact in declarative terms. No imperative, no remedy field.
const NUMERIC_ANCHOR_RE = /^\d+$/;

export function numericAnchorNote(anchors: string[]): string {
  const numeric = anchors.filter((anchor) => NUMERIC_ANCHOR_RE.test(anchor));
  if (numeric.length === 0) return "";
  const quoted = numeric.map((anchor) => `"${anchor}"`).join(", ");
  const noun = numeric.length === 1 ? `anchor ${quoted}` : `anchors ${quoted}`;
  const verb = numeric.length === 1 ? "consists" : "consist";
  const resemblance = numeric.length === 1 ? "resembles a line number" : "resemble line numbers";
  return (
    ` Note: ${noun} ${verb} only of digits and ${resemblance}. ` +
    `Edit anchors are 3-character alphanumeric content hashes (e.g. "aB3") served by the read tool, not line numbers.`
  );
}

/** SAFETY: exact heading for an unverified fresh-read serve — machine-checkable. */
export const FRESH_READ_HEADING = "Current range (fresh read):";

/** SAFETY: one general headline clause for an unplaceable bound — no narration. */
export const UNVERIFIED_HEADLINE =
  "a bound of this range no longer resolves to the line identity it was served with.";

/** SAFETY: recovery sentence for a target-lost rejection — the only retry is a read. */
export const TARGET_LOST_RECOVERY =
  "The line you targeted was deleted or replaced; your anchors describe a version of this file that no longer exists. Read the file and re-target.";

function unknownAnchorFormat(payload: ErrorPayloadMap["E_UNKNOWN_ANCHOR"]): string {
  const anchors = payload.anchors;
  if (anchors.length === 1) {
    return `${payload.path} has not served the anchor "${anchors[0]}"; nothing was written.${numericAnchorNote(anchors)}`;
  }
  if (anchors.length === 0) {
    return `${payload.path} has not served an anchor; nothing was written.`;
  }
  return `${payload.path} has not served the anchors ${anchors.map((a) => `"${a}"`).join(", ")}; nothing was written.${numericAnchorNote(anchors)}`;
}

function foreignHomesDisplay(homes: string[]): string {
  if (homes.length <= 3) return homes.join(", ");
  return `${homes.slice(0, 3).join(", ")} and ${homes.length - 3} more`;
}

function foreignAnchorFormat(payload: ErrorPayloadMap["E_FOREIGN_ANCHOR"]): string {
  const anchors = payload.anchors;
  const noun =
    anchors.length === 1
      ? `the anchor "${anchors[0]}"`
      : `the anchors ${anchors.map((a) => `"${a}"`).join(", ")}`;
  const verb = anchors.length === 1 ? "is" : "are";
  const homes = foreignHomesDisplay(payload.homes);
  if (homes.length === 0) {
    return `${noun} ${verb} inconsistent with ${payload.path}; nothing was written.`;
  }
  return `${noun} ${verb} inconsistent with ${payload.path}; served for ${homes}; nothing was written.`;
}

/** Split an already-rendered error message into its `[E_*]` token and headerless body. */
function splitErrorHeader(inner: string): { code: string | undefined; body: string } {
  const match = /^\[TO (?:MODEL|USER)\] (\[[EW]_[A-Z0-9_]+\]) /.exec(inner);
  if (match === null) return { code: undefined, body: inner };
  return { code: match[1]!, body: inner.slice(match[0].length) };
}

/** Indent every continuation line so one failure stays one list entry. */
function indentContinuation(text: string): string {
  return text.replace(/\n/g, "\n  ");
}

/**
 * One failing item as a structural list entry. The inner `[TO MODEL]` audience prefix is
 * stripped; its `[E_*]` token becomes the entry's code. Row-carrying errors keep the rows
 * their own formatter rendered — the envelope never re-renders them.
 */
function batchAbortItem(index: number, path: string, inner: string): string {
  const { code, body } = splitErrorHeader(inner);
  const label = code === undefined ? "" : ` ${code}`;
  return `- edits[${index}] (${path})${label}: ${indentContinuation(body)}`;
}

/**
 * The verdict is the lead line and each failing item is one list entry, so the atomicity fact
 * frames the payload instead of trailing it. A single failure may append its serve disposition
 * (recorded / not recorded) as one indented sentence; rows are never re-rendered here — the
 * inner error owns the single echo (ADR-0043).
 */
function batchAbortFormat(payload: ErrorPayloadMap["E_BATCH_ABORT"]): string {
  const failures = payload.failures ?? [{ index: payload.index, inner: payload.inner }];
  const failed = failures.length;
  const total = payload.total ?? failed;
  const noun = total === 1 ? "edit" : "edits";
  const lead = `Batch rejected: ${failed} of ${total} ${noun} failed; nothing was written.`;
  const items = failures.map((failure) =>
    batchAbortItem(failure.index, payload.path, failure.inner),
  );
  const note =
    payload.failures === undefined && payload.serveNote !== undefined
      ? `  ${payload.serveNote}`
      : undefined;
  return [lead, ...items, ...(note === undefined ? [] : [note])].join("\n");
}

function noopLoopFormat(payload: ErrorPayloadMap["E_NOOP_LOOP"]): string {
  // WHY batch first: the batch ref already names the item (edits[i] (path)),
  // so the batch arm renders from ref and appends the on-disk range when the
  // engine supplies one. `enforceNoopLoop` is the only producer and always
  // passes `batch: true`; the generic arm below keeps the message defined for
  // a non-batch payload the type still admits.
  if (payload.batch) {
    const base =
      `${payload.ref}: identical edit (${payload.anchorFrom} → ${payload.anchorTo}) submitted ${payload.count}×, no changes each time. ` +
      `Range already contains this text; resend will reject the batch.`;
    // WHY: a changed-buffer refusal is rowless — `note` replaces the range block and says so.
    if (payload.note !== undefined && payload.servedBlock === "") return `${base} ${payload.note}`;
    return base + (payload.servedBlock ? `\nCurrent on-disk range:\n${payload.servedBlock}` : "");
  }
  return (
    `identical edit (${payload.anchorFrom} → ${payload.anchorTo} ${payload.ref}) submitted ${payload.count}×, no changes each time. ` +
    `Range already contains this text; resend will reject.`
  );
}

export const ERROR_REGISTRY: { [K in DomainErrorCode]: CodeSpec<ErrorPayloadMap[K]> } = {
  E_BAD_PAYLOAD: {
    audience: "MODEL",
    format: ({ message }) => message,
  },
  E_EMPTY_RANGE: {
    audience: "MODEL",
    format: () =>
      "Cannot empty a non-empty file via edit. Use `write` if you need to clear the file.",
    // WHY remedy: the resolved edit empties a non-empty file, so clearing belongs to write.
    remedy: "Use write to clear the file.",
  },
  E_STALE_ANCHOR: {
    audience: "MODEL",
    format: staleAnchorFormat,
    // WHY remedy: the anchors did not resolve against the current file (unresolved or
    // ambiguous in `valEdit`), and context rows are shown only when one anchor resolved —
    // so the only fail-closed recovery is a read.
    remedy: "Read the file again for fresh anchors, then retry.",
  },
  E_UNKNOWN_ANCHOR: {
    audience: "MODEL",
    format: unknownAnchorFormat,
  },
  E_FOREIGN_ANCHOR: {
    audience: "MODEL",
    format: foreignAnchorFormat,
  },
  E_STALE_RANGE: {
    audience: "MODEL",
    format: staleRangeFormat,
  },
  E_TARGET_LOST: {
    audience: "MODEL",
    format: ({ servedLine, path }) =>
      `line ${servedLine}${path ? ` in ${path}` : ""} no longer resolves to the line identity it was served with.\n${TARGET_LOST_RECOVERY}`,
    // WHY remedy: the leased identity is gone with no surviving window to serve — servedLine
    // names the dead line, so recovery is a read (upstream b92e0ec:src/domain-errors.ts:381).
    remedy: "Read the file and re-target.",
  },
  E_UNVERIFIED_RANGE: {
    audience: "MODEL",
    format: ({ servedBlock }) => `${UNVERIFIED_HEADLINE}\n${FRESH_READ_HEADING}\n${servedBlock}`,
  },
  E_MALFORMED_ANCHOR: {
    audience: "MODEL",
    format: ({ rawAnchor, reason }) => `Invalid anchor "${rawAnchor}": ${reason}`,
    // WHY remedy: the parse rejected the token before any resolution — rawAnchor and reason name the shape failure.
    remedy: "Pass the bare 3-char anchor and retry.",
  },
  E_SUSPICIOUS_TEXT: {
    audience: "MODEL",
    format: suspiciousFormat,
    // WHY remedy: the replacement reproduces a served hash echo for this session, path and line — target, hash and servedLine pin the row.
    // F2/F10.4: no mode:"literal" promise here — the built-in write tool
    // takes no mode flag, so the declared remedy stays truthful for both targets.
    remedy: "Omit the copied anchors and retry with the same anchors.",
  },
  E_BATCH_ABORT: {
    audience: "MODEL",
    format: batchAbortFormat,
    // WHY remedy: the item index and path pin the failing edit of the rejected batch.
    remedy: "Fix the failing edit, then resubmit the batch.",
  },
  E_NOOP_LOOP: {
    audience: "MODEL",
    format: noopLoopFormat,
  },
  E_UNSUPPORTED_FILE: {
    audience: "MODEL",
    format: unsupportedFormat,
    // WHY remedy: detection classified the target — kind (directory, binary or image) proves it is not an editable text file.
    remedy: "Choose a text file and retry.",
  },
  E_ENCODING_UNWRITABLE: {
    audience: "MODEL",
    format: ({ path, encoding }) =>
      `Cannot write ${path}: it was read as ${encoding}, and this filesystem exposes only a text write that always encodes UTF-8. Writing now would transcode the file silently, and its anchors would no longer describe the bytes on disk. Nothing was written. Set normalizeToUtf8: true (DSH_BETTER_EDIT_NORMALIZE_TO_UTF8=true) to migrate the file to UTF-8 explicitly, then retry.`,
    // WHY remedy: the recorded encoding proves the text seam cannot reproduce it, and normalizeToUtf8 is the one setting that makes the write legal.
    remedy: "Set normalizeToUtf8: true to migrate the file to UTF-8 explicitly, then retry.",
  },
  E_ACCESS: {
    audience: "MODEL",
    format: accessFormat,
  },
  E_NOT_FOUND: {
    audience: "MODEL",
    format: ({ path }) =>
      `File not found: ${path}. Check the "file" value (a text file, never a directory); ` +
      `use ls on the parent directory and retry with the corrected file.`,
    // WHY remedy: the filesystem answered not-found — path names a file that does not exist to edit.
    remedy: "Use ls on the parent directory and retry with the corrected file.",
  },
  E_UNDO_STALE: {
    audience: "MODEL",
    format: ({ path, reason }) =>
      reason === "deleted"
        ? `cannot undo on ${path}: file no longer exists.`
        : `cannot undo on ${path}: file modified after edit — undo would overwrite changes.`,
  },
  E_UNDO_NOT_RECORDED: {
    audience: "MODEL",
    format: ({ path }) =>
      `Reverted ${path} on disk, but the hash store could not record the revert — the previous ` +
      `undo history is still in place and the stored snapshot still describes the pre-revert file. ` +
      `The file no longer matches the recorded post-edit content, so the next undo_last_edit ` +
      `clears that history as stale.`,
    // WHY remedy: the file is already reverted and the pair is intact; the next undo reconciles
    // the pair against the reverted file and terminates, so no store repair is required.
    remedy: "Re-read the file; the next undo_last_edit will clear the stale history.",
  },
  E_UNDO_UNAVAILABLE: {
    audience: "MODEL",
    format: ({ path, batch }) =>
      batch === true
        ? `Cannot persist undo history to the hash store; the batch was NOT applied and no file was written. Retry the batch, or use write if the store cannot be recovered.`
        : `Cannot persist undo history to the hash store; the edit was NOT applied and ${path} is unchanged. ` +
          `Retry the edit, or use write if the store cannot be recovered.`,
    // WHY remedy: the hash store persist failed with the edit unapplied and the file unchanged, so retrying the edit is safe.
    remedy: "Retry the edit.",
  },
  E_UNKNOWN: {
    audience: "MODEL",
    format: ({ errorName, message }) =>
      `unexpected ${errorName}: ${message.split("\n")[0]!.slice(0, 300)}`,
  },
  E_LARGE_FILE: {
    audience: "MODEL",
    format: largeFileFormat,
    // WHY remedy: the named limit was exceeded — limitKind (lines with lineCount, or hash-space) and limit pin the capacity.
    remedy: "Use write or a non-line-based approach for very large files.",
  },
  E_UNSERVED_RANGE: {
    audience: "MODEL",
    format: unservedRangeFormat,
  },
  E_BLIND_REPLACE: {
    audience: "MODEL",
    format: blindReplaceFormat,
  },
  E_UNSUPPORTED: {
    audience: "MODEL",
    format: ({ command }) =>
      `str_replace_editor ${command} is not implemented — use undo_last_edit.`,
  },
  E_BAD_COMMAND: {
    audience: "MODEL",
    format: ({ command }) =>
      `str_replace_editor: unknown command ${JSON.stringify(command)} — expected one of view, str_replace, insert, create, undo_edit.`,
  },
  E_FILE_EXISTS: {
    audience: "MODEL",
    format: ({ path }) => `str_replace_editor: cannot create ${path} — file already exists.`,
  },
  E_NO_MATCH: {
    audience: "MODEL",
    format: ({ path }) => `str_replace_editor: old_str not found in ${path}. Nothing was written.`,
  },
  E_AMBIGUOUS_MATCH: {
    audience: "MODEL",
    format: ({ path, matches }) =>
      `str_replace_editor: old_str has multiple matches (${matches}) in ${path} — must match exactly once. Narrow old_str with more context. Nothing was written.`,
  },
  E_STORE_NEWER_VERSION: {
    audience: "MODEL",
    format: ({ path, storedVersion, supportedVersion }) =>
      `The hash store at ${path} was written by a newer dsh-better-edit (store schema ${storedVersion}; this build supports ${supportedVersion}). Nothing was written — this build refuses to touch a newer store. Upgrade dsh-better-edit to the newer version, or point the store at a different directory.`,
    // WHY remedy: the stamp proves a newer writer owns the file and this build cannot read it — upgrade or retarget pins the recovery.
    remedy:
      "Upgrade dsh-better-edit to the newer version, or point the store at a different directory.",
  },
};

export interface WarningPayloadMap {
  W_NEVER_SERVED_SHAPE: {
    count: number;
  };
  W_SERVED_PREFIX_MISMATCH: {
    k: number;
    anchor: string;
    servedLine: number;
  };
  W_REVERSED_ANCHORS: {
    fromHash: string;
    toHash: string;
  };
  W_UNICODE_LITERAL: {
    line: number;
  };
  W_LITERAL_BYPASS: Record<string, never>;
  /**
   * An applied write normalized the file's terminators. The spellings are inlined on purpose:
   * importing `LineEnding` (edit-diff) or `EolSource` (eol-config) here would cycle those modules
   * back through this registry. The real guard is the call site — `formatWarning("W_EOL_REWRITTEN",
   * { target: endingName(effectiveEnding), source: effectiveEol.source, … })` in
   * `src/mutation/engine.ts` — where `tsc` fails if `EolSource` or `endingName` drift from these
   * spellings.
   */
  W_EOL_REWRITTEN: {
    target: "LF" | "CRLF" | "CR";
    source: "env" | "config" | "file" | "system";
    /** How many pre-image terminators the write re-spelled; never zero when this warning fires. */
    changed: number;
  };
  W_NOOP: {
    ref: string;
    anchorFrom: string;
    anchorTo: string;
    batch: boolean;
    count: number;
    /** Present on engine single warns: the display path ("in <path>" flavor). */
    path?: string;
  };
  W_UNSERVED_INTERIOR: {
    count: number;
    from: number;
    to: number;
  };
  /**
   * A migration edit moved a legacy file to UTF-8. Spellings inlined on purpose,
   * exactly as `W_EOL_REWRITTEN` inlines them: importing `EncodingMigration`
   * (file-encoding-state) here would cycle that module back through this registry.
   * The real guard is the call site — `formatWarning("W_ENCODING_MIGRATED",
   * { path: displayPath, ...migration })` in `src/mutation.ts` — where `tsc` fails
   * if `EncodingMigration` drifts from these spellings.
   */
  W_ENCODING_MIGRATED: {
    path: string;
    encoding: string;
    hasBOM: boolean;
  };
}

/**
 * Read-tier warning payloads. The counts are the RAW pre-image's terminators, taken once where
 * the bytes are decoded, so they describe the file as observed — never a page's slice of it.
 *
 * The spellings are inlined on purpose, exactly as `W_EOL_REWRITTEN` inlines them: importing
 * `LineEnding` (edit-diff) or `EolSource` (eol-config) here would cycle those modules back
 * through this registry. The real guard is the call site —
 * `formatReadWarning("W_MIXED_EOL", { …, target: endingName(effective.value), source:
 * effective.source })` in `src/read-and-serve.ts` — where `tsc` fails if `EolSource` or
 * `endingName` drift from these spellings.
 */
export interface ReadWarningPayloadMap {
  W_MIXED_EOL: {
    crlf: number;
    lf: number;
    cr: number;
    target: "LF" | "CRLF" | "CR";
    source: "env" | "config" | "file" | "system";
  };
}

function neverServedShapeFormat(payload: WarningPayloadMap["W_NEVER_SERVED_SHAPE"]): string {
  if (payload.count === 1) {
    return (
      "1 replacement line opens with an anchor-shaped token " +
      "never served for this session and file. Applied verbatim."
    );
  }
  return (
    `${payload.count} replacement lines open with anchor-shaped tokens ` +
    "never served for this session and file. Applied verbatim."
  );
}

function servedPrefixMismatchFormat(
  payload: WarningPayloadMap["W_SERVED_PREFIX_MISMATCH"],
): string {
  return (
    `Line ${payload.k} begins with the exact ${payload.anchor}│ anchor ` +
    `served for this session and file for line ${payload.servedLine}, ` +
    "but its content differs from what was served. Applied verbatim."
  );
}

function noopWarnFormat(payload: WarningPayloadMap["W_NOOP"]): string {
  if (payload.batch) {
    return (
      `Notice: ${payload.ref} — identical edit no-op'd twice; ` +
      "range already has this text. Resend will reject the batch."
    );
  }
  if (payload.path !== undefined) {
    return (
      `Notice: identical edit (${payload.anchorFrom} → ${payload.anchorTo} in ${payload.path}) ` +
      "no-op'd twice; range already has this text. Resend will reject."
    );
  }
  return (
    `Notice: identical edit (${payload.anchorFrom} → ${payload.anchorTo} ${payload.ref}) ` +
    "no-op'd twice; range already has this text. Resend will reject."
  );
}

function unservedInteriorFormat(payload: WarningPayloadMap["W_UNSERVED_INTERIOR"]): string {
  return (
    `Span replaced ${payload.count} unserved interior line(s) (lines ${payload.from}-${payload.to}). ` +
    "Edits should only modify lines previously read and served (enforced under strict mode); " +
    "verify this uninspected replacement was intended."
  );
}

function encodingMigratedFormat(payload: WarningPayloadMap["W_ENCODING_MIGRATED"]): string {
  return (
    `Migrated ${payload.path} from ${payload.encoding} ` +
    `(${payload.hasBOM ? "with BOM" : "no BOM"}) to UTF-8. ` +
    `Undo restores the text, not the encoding.`
  );
}

function eolRewrittenFormat(payload: WarningPayloadMap["W_EOL_REWRITTEN"]): string {
  return (
    `EOL normalized to ${payload.target} (${payload.source}): ` +
    `${payload.changed} terminators changed. Undo restores normalized content.`
  );
}

/**
 * Renders the terminator kinds the bytes actually use, in the fixed display order `CRLF`, `LF`,
 * `CR`. A kind whose count is zero is omitted (it is not spelled "0"), so the list names exactly
 * what the pre-image spells; the target/source clause is the rung the next write will use.
 */
function mixedEolFormat(payload: ReadWarningPayloadMap["W_MIXED_EOL"]): string {
  const kinds = [
    { name: "CRLF", count: payload.crlf },
    { name: "LF", count: payload.lf },
    { name: "CR", count: payload.cr },
  ]
    .filter((kind) => kind.count > 0)
    .map((kind) => `${kind.count} ${kind.name}`);
  return `Mixed EOL: ${kinds.join(", ")}. All edits normalize to ${payload.target} (${payload.source}).`;
}

export const WARNING_REGISTRY: {
  [K in DomainWarningCode]: CodeSpec<WarningPayloadMap[K]>;
} = {
  W_NEVER_SERVED_SHAPE: {
    audience: "MODEL",
    format: neverServedShapeFormat,
  },
  W_SERVED_PREFIX_MISMATCH: {
    audience: "MODEL",
    format: servedPrefixMismatchFormat,
  },
  W_REVERSED_ANCHORS: {
    audience: "USER",
    format: ({ fromHash, toHash }) =>
      `anchor_from/anchor_to were reversed (${fromHash} after ${toHash}); ` +
      "healed and applied with the range swapped.",
  },
  W_UNICODE_LITERAL: {
    audience: "USER",
    format: ({ line }) => `Literal \\uDDDD detected on replacement line ${line}; applied verbatim.`,
  },
  W_LITERAL_BYPASS: {
    audience: "USER",
    format: () => "served-echo check bypassed by literal declaration.",
  },
  W_NOOP: {
    audience: "MODEL",
    format: noopWarnFormat,
  },
  W_UNSERVED_INTERIOR: {
    audience: "MODEL",
    format: unservedInteriorFormat,
  },
  W_EOL_REWRITTEN: {
    audience: "MODEL",
    format: eolRewrittenFormat,
  },
  W_ENCODING_MIGRATED: {
    audience: "MODEL",
    format: encodingMigratedFormat,
  },
};

/**
 * SAFETY: the applied tier's sole producer of `[W_*]` headers (`formatReadWarning` owns
 * the read tier). Renders `[<AUDIENCE>] [<W_CODE>] <neutral-observation>` from the
 * registry, so every applied-tier warning carries its machine-readable code and audience
 * by construction.
 *
 * PURE by contract (T6 CP2, F2): a formatter carries no state. The deferral
 * witnesses below are INJECTED (`AllowlistTrigger.holds(fired)`), never accumulated —
 * a module-global "did it fire?" latch made a guard's verdict depend on whether an
 * earlier test happened to render the warning, so a witness satisfiable by another
 * test's side effect proved nothing about the guard that consumed it. The witness is
 * derived by the test layer from a source scan (`test/support/arch-scan.ts`,
 * `firedWarnings`) — a READ, so the verdict is a pure function of the tree and cannot
 * depend on evaluation order or on a test-only reset hook.
 */
export function formatWarning<K extends DomainWarningCode>(
  code: K,
  payload: WarningPayloadMap[K],
): string {
  const spec = WARNING_REGISTRY[code] as CodeSpec<WarningPayloadMap[K]>;
  return `[${spec.audience}] [${code}] ${spec.format(payload)}`;
}

/**
 * The read tier's registry: codes that report observed state and carry no audience, so their
 * entries hold a formatter and nothing else. Kept separate from `WARNING_REGISTRY` by contract —
 * the applied tier's `CodeSpec` carries an `audience` because an applied notice addresses an
 * actor, and a read notice has none.
 */
const READ_WARNING_REGISTRY: {
  [K in ReadWarningCode]: { format: (payload: ReadWarningPayloadMap[K]) => string };
} = {
  W_MIXED_EOL: {
    format: mixedEolFormat,
  },
};

/**
 * SAFETY: the read tier's sole producer of `[W_*]` headers — bare `[<CODE>]`, with NO audience
 * prefix, because a read warning reports state OBSERVED before any write. It never composes an
 * applied-tier notice and `formatWarning` never composes a read-tier one.
 */
export function formatReadWarning<K extends ReadWarningCode>(
  code: K,
  payload: ReadWarningPayloadMap[K],
): string {
  const spec = READ_WARNING_REGISTRY[code];
  return `[${code}] ${spec.format(payload)}`;
}

/**
 * SAFETY: the sole composer of `[TO <AUDIENCE>] [<E_CODE>]` prefixes for errors.
 * `DomainError` delegates here, so header construction has exactly one site.
 */
export function formatError<K extends DomainErrorCode>(
  code: K,
  payload: ErrorPayloadMap[K],
): string {
  const spec = ERROR_REGISTRY[code] as CodeSpec<ErrorPayloadMap[K]>;
  return `[TO ${spec.audience}] [${code}] ${spec.format(payload)}`;
}

export class DomainError<K extends DomainErrorCode = DomainErrorCode> extends Error {
  readonly code: K;
  readonly audience: Audience;
  readonly payload: ErrorPayloadMap[K];
  readonly servedRows: ServedRow[];
  readonly servedBlock: string;
  readonly cause?: RangeCause;
  readonly firstOffendingLine?: number;
  readonly details: { cause?: RangeCause; code: K };

  constructor(code: K, payload: ErrorPayloadMap[K]) {
    super(formatError(code, payload));
    this.name = "DomainError";
    this.code = code;
    this.audience = (ERROR_REGISTRY[code] as CodeSpec<ErrorPayloadMap[K]>).audience;
    this.payload = payload;
    const fields = payload as {
      servedRows?: ServedRow[];
      servedBlock?: string;
      cause?: RangeCause;
      firstOffendingLine?: number;
    };
    this.servedRows = fields.servedRows ?? [];
    this.servedBlock = fields.servedBlock ?? "";
    if (fields.cause !== undefined) this.cause = fields.cause;
    if (fields.firstOffendingLine !== undefined) {
      this.firstOffendingLine = fields.firstOffendingLine;
    }
    this.details = {
      code,
      ...(fields.cause !== undefined ? { cause: fields.cause } : {}),
    };
  }
}

// WHY: only registry members route the typed path — this guard keeps
// WHY: errno-style codes (ENOENT, EACCES) and unknown strings out of the
// WHY: domain contract. The `E_` prefix plus registry membership check means
// WHY: errno codes without an underscore after E (ENOENT, EACCES, EPERM,
// WHY: ELOOP) can never match, and underscored non-members fail the lookup.
export function isDomainErrorCode(code: unknown): code is DomainErrorCode {
  return typeof code === "string" && code.startsWith("E_") && code in ERROR_REGISTRY;
}

/** Warning analogue of `isDomainErrorCode`: only registry members qualify. */
export function isDomainWarningCode(code: unknown): code is DomainWarningCode {
  return typeof code === "string" && code.startsWith("W_") && code in WARNING_REGISTRY;
}

/**
 * A trigger must be CHECKABLE, not a phrase. `text` names the artifact whose
 * change makes this entry actionable — a queue line (`Q-T<n>`), an issue
 * (`#NN`), an absorb branch (`absorb/<branch>`), or a `src/` path — and
 * `holds(fired)` is a predicate that must remain true while the entry exists. The
 * witness is INJECTED, never read from module state: production carries no latch, so
 * the same source yields the same verdict in any evaluation order (T6 CP2, F2). The
 * arch oracle supplies its own, independently derived witness and asserts both
 * (`AllowlistEntry` is the two-referents rule in type form; see
 * `test/support/arch-scan.ts`).
 */
export interface AllowlistTrigger {
  readonly text: string;
  /** `fired` = codes whose producer became visible to the caller's witness scan. */
  readonly holds: (fired: ReadonlySet<string>) => boolean;
}

/**
 * An allowlist entry. `owner` must be an ADDRESSABLE identity — **a bare `T6` is
 * not an identity**: `docs/absorption-plan.md:35` gives T6 to the README+CONTEXT
 * merge while the T4 brief gives it to multi-window read, so the id collides
 * across lanes (T4 CP1-r5 G7).
 */
export interface AllowlistEntry {
  readonly owner: string;
  readonly trigger: AllowlistTrigger;
}

/** Owners and trigger texts must start with one of these addressable forms. */
export const ADDRESSABLE_OWNER_RE = /^(#\d{1,5}|Q-T\d+|absorb\/[a-z0-9-]+|src\/[a-z0-9./-]+)\b/;

/**
 * Registry fields that are declared but never rendered, keyed by field name.
 * `owner`/`trigger` are identities (see `AllowlistEntry`); the arch oracle pins
 * this map by identity against its own copy **and** independently computes the
 * "still declaration-only" predicate (0 readers of `.<field>` across `src/`).
 */
export const DECLARATION_ONLY_FIELDS: Readonly<Record<string, AllowlistEntry>> = {
  remedy: {
    owner: "src/domain-errors.ts",
    trigger: {
      text: "src/domain-errors.ts",
      holds: () => Object.values(ERROR_REGISTRY).some((spec) => "remedy" in spec),
    },
  },
};

/**
 * Codes declared by the contract but produced by a later ticket. Shrink-only:
 * a code that gains a producer MUST be removed from this map (the arch oracle
 * fails otherwise).
 *
 * Upstream parity is NOT a reason to keep a code nothing can produce — and it
 * is not a reason to hide one either. T4 (CP1-r3) removed four declarations
 * that had zero local producers, zero reachable messages and no nameable local
 * owner. FU-4 (absorb/follow-upstream, upstream `pi-better-edit@b92e0ec`)
 * re-introduced all four WITH their producers — per-code decision: **adopt the
 * upstream diagnostic** (the alternative, mapping onto `E_STALE_RANGE` /
 * `E_UNSERVED_RANGE`, is what ADR-0022 recorded and what this absorb
 * supersedes):
 *
 * | ported upstream diagnostic | upstream producer (pi-better-edit@b92e0ec) | local producer |
 * |---|---|---|
 * | `E_FOREIGN_ANCHOR` | `lease-resolve.ts:116` | `served-evidence.ts` (`throwUnknownOrForeign`, boundary placement) |
 * | `E_UNKNOWN_ANCHOR` | `lease-resolve.ts:118`, `served-verification.ts:745` | `served-evidence.ts` (boundary placement, pre-gate) |
 * | `E_UNVERIFIED_RANGE` | `lease-resolve.ts:186`, `served-verification.ts:187` | `served-evidence.ts` (pre-gate stale-boundary arm) |
 * | `E_TARGET_LOST` | `served-verification.ts:170`, `lease-resolve.ts:196` | `served-evidence.ts` (pre-gate stale-boundary arm) |
 *
 * The upstream column is scoped to the upstream tree (`pi-better-edit@b92e0ec`): its
 * `served-verification.ts` never existed downstream, so those cites never named a local
 * file. The local column did move — the four arms live in `served-evidence.ts` (ADR-0037).
 *
 * Their owner is `"upstream absorb"` and their trigger is the absorb that
 * ports the corresponding producer. When that happens, reintroduce the code
 * WITH its producer: the union member is gone, so the port will not compile
 * until the absorber records a per-code decision (adopt the upstream
 * diagnostic, or map it onto `E_STALE_RANGE` / `E_UNSERVED_RANGE` /
 * `E_STALE_ANCHOR`). `docs/absorption-plan.md` ("Debt — T4 …") carries the
 * same record for the next absorb.
 *
 * ── IDENTITY, NOT SHAPE (T4 CP1-r4/r5; T6 R15) ──
 * `owner` and `trigger.text` below are pinned BY IDENTITY in
 * `test/arch/domain-error-registry.test.ts` (C7/C16), so changing one is a
 * deliberate edit that must touch the test — never a silent one. T6 replaced the
 * lane-letter owner (`Q-T6`) with the addressable producer seam, and the
 * `holds: () => isDomainWarningCode(…)` with a predicate over an INJECTED witness:
 * `holds(fired)` is false exactly when a producer for that code is visible to the
 * caller's scan (T6 CP2 F2). Production keeps no state, so the verdict cannot be
 * satisfied by another test's earlier firing — the defect the first form had. The arch
 * oracle derives the witness from source (a read) and recomputes the same producer scan
 * as its independent second referent.
 *
 * FU-5 (absorb/follow-upstream, upstream `pi-better-edit@b92e0ec` §4.7) landed the
 * two deferred `W_*` producers in `src/hashline/served-guard.ts` — per the shrink-only
 * rule above both entries are removed. The map is empty; the mechanism and the
 * identity pins stay for the next deferral.
 */
export const DEFERRED_PRODUCERS: Readonly<Record<string, AllowlistEntry>> = {};
