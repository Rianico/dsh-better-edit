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
 * COUNT DEVIATION (F4, ratified): this registry carries 26 E_* members, not
 * upstream's 19. Upstream has no str_replace_editor shadow; the six shadow
 * codes (E_BLIND_REPLACE, E_UNSUPPORTED, E_BAD_COMMAND, E_FILE_EXISTS,
 * E_NO_MATCH, E_AMBIGUOUS_MATCH) are live model-facing contract per accepted
 * ADR-0015, plus E_UNSERVED_RANGE which a later ticket retires. A closed
 * vocabulary that omits live codes is not closed — it just pushes them
 * outside the contract.
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
 * - `E_UNKNOWN_ANCHOR`: wrong path, wrong anchors and wrong session are
 *   indistinguishable, so any suggestion would steer on a guess.
 * - `E_FOREIGN_ANCHOR`: the sibling path is the actionable fact and presumes
 *   nothing about which side is wrong.
 * - `E_UNVERIFIED_RANGE`: the served rows are the information and the model
 *   decides from them, so no retry mandate.
 * - `E_NOOP_LOOP`: the refusal's evidence pins the fact (the range already
 *   contains the text) but not the model's intent, so a remedy clause would
 *   dress a status fact as an action.
 *
 * WHY `remedy` is declaration-only and never rendered into the message: the
 * `format` strings already carry their own retry prose where the evidence pins
 * it. Do not "fix" this by appending `remedy` to the rendered text.
 *
 * @module dsh-better-edit/domain-errors
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
  | "tombstone"
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
  | "E_ACCESS"
  | "E_NOT_FOUND"
  | "E_UNDO_STALE"
  | "E_UNDO_UNAVAILABLE"
  | "E_UNKNOWN"
  | "E_LARGE_FILE"
  // RETIRING: E_UNSERVED_RANGE is still produced by the served-verification
  // seam; the range-family ticket retires it (never-served → E_UNVERIFIED_RANGE).
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
 * Applied-tier warning codes. A `[W_*]` line reports an applied mutation;
 * `[E_*]` reports a rejection. `formatWarning` is the sole producer of
 * `[W_*]` headers and `formatError` the sole composer of `[E_*]` headers:
 * no raw `[E_*]`/`[W_*]` header literal may exist outside this module
 * (asserted in test/arch/domain-error-registry.test.ts).
 */
export type DomainWarningCode =
  | "W_NEVER_SERVED_SHAPE"
  | "W_SERVED_PREFIX_MISMATCH"
  | "W_REVERSED_ANCHORS"
  | "W_UNICODE_LITERAL"
  | "W_LITERAL_BYPASS"
  | "W_NOOP";

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
    /**
     * True when the rejection demands a fresh read (the headline says
     * "Re-read."): the retry hint is omitted. False/undefined keeps the
     * reject-and-serve retry hint — the echoed rows ARE the retry.
     */
    reread?: boolean;
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
    /** First failing item: routes the typed path and keeps the single-failure envelope byte-identical. */
    index: number;
    path: string;
    /** The first failing item's inner failure message (already header-bearing). */
    inner: string;
    /**
     * Range context for the failed item: either the current on-disk range
     * block or the "Call read()…" fallback. Empty when no range context
     * exists (non-anchor failures) — the merge hint is omitted with it.
     */
    echoBlock: string;
    /**
     * Every failing item in order; present only when more than one failed
     * (C: one resubmission fixes every failure). Each item keeps its own
     * `[E_*]` inline in `inner`.
     */
    failures?: Array<{ index: number; inner: string }>;
    /** Union of every failing item's rows, in item order. */
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
     * Present on engine single rejects: the display path ("in <path>" flavor).
     * The batch ref already names the item, so no index is needed.
     */
    path?: string;
  };
  E_UNSUPPORTED_FILE: {
    path: string;
    kind: "directory" | "binary" | "image";
    description?: string;
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

// WHY: the reject-and-serve retry affordance, owned here so every row-carrying
// WHY: rejection renders it identically.
const RETRY_HINT = "Retry with these anchors (no read needed).";

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
  // headline alone, and `reread: true` still suppresses the retry hint.
  if (!payload.servedBlock) return payload.headline;
  const base = `${payload.headline}\nCurrent range:\n${payload.servedBlock}`;
  return payload.reread === true ? base : `${base}\n${RETRY_HINT}`;
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
  // F7: heading only when rows exist (all current producers carry a block).
  if (!payload.servedBlock) return payload.headline;
  return `${payload.headline}\nCurrent range:\n${payload.servedBlock}\n${RETRY_HINT}`;
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

const BATCH_ATOMICITY_TRAILER =
  "The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied.";

function batchAbortFormat(payload: ErrorPayloadMap["E_BATCH_ABORT"]): string {
  // C: several failures name every failing item in order (one resubmission
  // fixes them all); each item keeps its own `[E_*]` inline in `inner`.
  if (payload.failures !== undefined && payload.failures.length > 1) {
    const parts = payload.failures.map(
      (f) => `edits[${f.index}] (${payload.path}) failed: ${f.inner}`,
    );
    return (
      `${parts.join("; ")}\n${BATCH_ATOMICITY_TRAILER} ` +
      "Fix the failing edits (and any later edits that depend on them), then resubmit the batch."
    );
  }
  const base =
    `edits[${payload.index}] (${payload.path}) failed: ${payload.inner}${payload.echoBlock}\n` +
    BATCH_ATOMICITY_TRAILER;
  // WHY: echoBlock is empty exactly when no range context exists (non-anchor
  // WHY: failures carry no echo), and only a ranged failure can name the edit
  // WHY: to fix — so the merge hint rides on the same condition.
  if (!payload.echoBlock) return base;
  return `${base} Fix the failing edit (and any later edit that depends on it), then resubmit the batch.`;
}

function noopLoopFormat(payload: ErrorPayloadMap["E_NOOP_LOOP"]): string {
  // WHY batch first: the batch ref already names the item (edits[i] (path)),
  // so the batch arm renders from ref and appends the on-disk range when the
  // engine supplies one; the path arm is the engine single-edit flavor.
  if (payload.batch) {
    return (
      `${payload.ref}: identical edit (${payload.anchorFrom} → ${payload.anchorTo}) submitted ${payload.count}×, no changes each time. ` +
      `Range already contains this text; resend will reject the batch.` +
      (payload.servedBlock ? ` Current on-disk range:\n${payload.servedBlock}` : "")
    );
  }
  if (payload.path !== undefined) {
    return (
      `identical edit (${payload.anchorFrom} → ${payload.anchorTo} in ${payload.path}) submitted ${payload.count}×, no changes each time. ` +
      `Range already contains this text; resend will reject. Current range:\n${payload.servedBlock}`
    );
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
    // WHY remedy: a row was served for this path and its line identity is retired, so the served window pins the retry.
    remedy: "Retry with the served rows; no read is needed.",
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
      `line ${servedLine}${path ? ` in ${path}` : ""} no longer resolves to the line identity it was served with.\n` +
      `The line you targeted was deleted or replaced; your anchors describe a version of this file that no longer exists. Read the file and re-target.`,
    // WHY remedy: the leased identity is gone with no surviving window to serve — recovery is a read.
    remedy: "Read the file and re-target.",
  },
  E_UNVERIFIED_RANGE: {
    audience: "MODEL",
    format: ({ servedBlock }) =>
      `a bound of this range no longer resolves to the line identity it was served with.\nCurrent range (fresh read):\n${servedBlock}`,
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
    remedy: "Upgrade dsh-better-edit to the newer version, or point the store at a different directory.",
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
  W_NOOP: {
    ref: string;
    anchorFrom: string;
    anchorTo: string;
    batch: boolean;
    count: number;
    /** Present on engine single warns: the display path ("in <path>" flavor). */
    path?: string;
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
    audience: "USER",
    format: noopWarnFormat,
  },
};

/**
 * SAFETY: the sole producer of `[W_*]` headers. Renders
 * `[<AUDIENCE>] [<W_CODE>] <neutral-observation>` from the registry, so every
 * applied-tier warning carries its machine-readable code and audience by
 * construction.
 */
export function formatWarning<K extends DomainWarningCode>(
  code: K,
  payload: WarningPayloadMap[K],
): string {
  const spec = WARNING_REGISTRY[code] as CodeSpec<WarningPayloadMap[K]>;
  return `[${spec.audience}] [${code}] ${spec.format(payload)}`;
}

/**
 * SAFETY: the sole composer of `[<AUDIENCE>] [<E_CODE>]` prefixes for errors.
 * `DomainError` delegates here, so header construction has exactly one site.
 */
export function formatError<K extends DomainErrorCode>(
  code: K,
  payload: ErrorPayloadMap[K],
): string {
  const spec = ERROR_REGISTRY[code] as CodeSpec<ErrorPayloadMap[K]>;
  return `[${spec.audience}] [${code}] ${spec.format(payload)}`;
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
 * Codes declared by the contract but produced by a later ticket. Shrink-only:
 * a code that gains a producer MUST be removed from this map (the arch oracle
 * fails otherwise).
 */
export const DEFERRED_PRODUCERS: Readonly<Record<string, string>> = {
  E_UNKNOWN_ANCHOR: "range-family ticket (leases)",
  E_FOREIGN_ANCHOR: "range-family ticket (leases)",
  E_TARGET_LOST: "range-family ticket (leases)",
  E_UNVERIFIED_RANGE: "range-family ticket (leases)",
  W_NEVER_SERVED_SHAPE: "range-family ticket (region-scoped serves)",
  W_SERVED_PREFIX_MISMATCH: "range-family ticket (region-scoped serves)",
};
