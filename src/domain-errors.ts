/**
 * Domain error registry — the closed, type-safe contract for every
 * model-facing diagnostic. Its imports are pure leaves — no store, no session, no hasher — so any
 * seam can throw without wiring one. (`./unserved-span-message.js` imports nothing, so this stays
 * store-free even though the registry renders the unserved-interior sentences through it.)
 */

import { formatUnservedSpanMessage } from "./unserved-span-message.js";

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
  | "E_ENCODING_UNWRITABLE"
  | "E_ACCESS"
  | "E_NOT_FOUND"
  | "E_UNDO_STALE"
  | "E_UNDO_UNAVAILABLE"
  | "E_UNDO_NOT_RECORDED"
  | "E_UNKNOWN"
  | "E_LARGE_FILE"
  | "E_UNSERVED_RANGE"
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
    /**
     * Reject-and-serve rows behind `servedBlock`, so the assembler records (and therefore leases)
     * exactly the rows the body renders (ADR-0043).
     */
    servedRows: ServedRow[];
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
  if (!payload.servedBlock) return payload.headline;
  return `${payload.headline}\n\n${payload.servedBlock}`;
}

function staleRangeFormat(payload: ErrorPayloadMap["E_STALE_RANGE"]): string {
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
  if (!payload.servedBlock) return payload.headline;
  return `${payload.headline}\nCurrent range:\n${payload.servedBlock}`;
}

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
  if (payload.batch) {
    const base =
      `identical edit (${payload.anchorFrom} → ${payload.anchorTo}) submitted ${payload.count}×, no changes each time. ` +
      `Range already contains this text; resend will reject the batch.`;
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
    remedy: "Use write to clear the file.",
  },
  E_STALE_ANCHOR: {
    audience: "MODEL",
    format: staleAnchorFormat,
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
    remedy: "Read the file and re-target.",
  },
  E_UNVERIFIED_RANGE: {
    audience: "MODEL",
    format: ({ servedBlock }) => `${UNVERIFIED_HEADLINE}\n${FRESH_READ_HEADING}\n${servedBlock}`,
  },
  E_MALFORMED_ANCHOR: {
    audience: "MODEL",
    format: ({ rawAnchor, reason }) => `Invalid anchor "${rawAnchor}": ${reason}.`,
    remedy: "Pass the bare 3-char anchor and retry.",
  },
  E_SUSPICIOUS_TEXT: {
    audience: "MODEL",
    format: suspiciousFormat,
    remedy: "Omit the copied anchors and retry with the same anchors.",
  },
  E_BATCH_ABORT: {
    audience: "MODEL",
    format: batchAbortFormat,
    remedy: "Fix the failing edit, then resubmit the batch.",
  },
  E_NOOP_LOOP: {
    audience: "MODEL",
    format: noopLoopFormat,
  },
  E_UNSUPPORTED_FILE: {
    audience: "MODEL",
    format: unsupportedFormat,
    remedy: "Choose a text file and retry.",
  },
  E_ENCODING_UNWRITABLE: {
    audience: "MODEL",
    format: ({ path, encoding }) =>
      `Cannot write ${path}: it was read as ${encoding}, and this filesystem exposes only a text write that always encodes UTF-8. Writing now would transcode the file silently, and its anchors would no longer describe the bytes on disk. Nothing was written. To migrate this file explicitly, send allow_encoding_migration: "utf8" (no BOM) or "utf8bom" (one leading UTF-8 BOM, which BOM-aware readers decode as UTF-8) on the edit; for a standing choice, set allowEncodingMigration: "utf8" or "utf8bom" in $DSH_HOME/plugins/dsh-better-edit/config.yaml. Otherwise re-encode the file outside the plugin. Then retry.`,
    remedy:
      'Send allow_encoding_migration: "utf8" or "utf8bom" on the edit (or set the standing allowEncodingMigration setting to the same value in $DSH_HOME/plugins/dsh-better-edit/config.yaml), or re-encode the file outside the plugin, then retry.',
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
    remedy: "Re-read the file; the next undo_last_edit will clear the stale history.",
  },
  E_UNDO_UNAVAILABLE: {
    audience: "MODEL",
    format: ({ path, batch }) =>
      batch === true
        ? `Cannot persist undo history to the hash store; the batch was NOT applied and no file was written. Retry the batch, or use write if the store cannot be recovered.`
        : `Cannot persist undo history to the hash store; the edit was NOT applied and ${path} is unchanged. ` +
          `Retry the edit, or use write if the store cannot be recovered.`,
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
  /**
   * Absolute old-file lines the edit replaced unseen, plus the replaced-set denominator the
   * shared formatter quotes. Both are facts; the sentence grammar lives in
   * `./unserved-span-message.js` so this voice and the strict refusal cannot drift.
   */
  W_UNSERVED_INTERIOR: {
    unservedLines: readonly number[];
    replacedLineCount: number;
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
  return formatUnservedSpanMessage({
    voice: "hint",
    unservedLines: payload.unservedLines,
    replacedLineCount: payload.replacedLineCount,
  });
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
 * Prompt-tier divergence footer (issue #177): appended to a locally customized
 * guidance section. Deliberately NOT a `DomainWarningCode` / `WARNING_REGISTRY`
 * member — it has no formatter envelope, must stay two lines
 * (`[USER] [W_PROMPT_DIVERGED]` then one sentence), and reports prompt
 * provenance rather than a tool warning. Keeping the literal here satisfies the
 * arch gate's single-vocabulary rule; the ADR follow-up cites this constant.
 */
export const PROMPT_DIVERGED_NOTICE =
  "[USER] [W_PROMPT_DIVERGED]\nLocal guidance differs from the plugin defaults; follow the local instructions.";

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
 */
export const DEFERRED_PRODUCERS: Readonly<Record<string, AllowlistEntry>> = {};
