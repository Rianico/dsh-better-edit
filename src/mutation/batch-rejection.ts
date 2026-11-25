/**
 * The one batch-rejection assembler (spec #214; ADR-0046).
 *
 * A rejected `edit` call used to be assembled at every throw site: one helper built a part and
 * recorded the rows it carried, another rendered the envelope. Nothing owned the join between
 * "this refusal shows rows" and "this refusal leases them", so a new call site could show anchors
 * it never recorded. This module owns that join: it records every failure's rows, then throws the
 * one shape the call's arity calls for.
 *
 * Arity rule: a one-item call (`total === 1`) throws the failure error itself, so the header code
 * is the actionable code and no batch vocabulary appears. A multi-item call throws one
 * `E_BATCH_ABORT` whose formatter renders the verdict and one bullet per failing item.
 *
 * Omission fails loud: rows with no recorder context throw `TypeError`, never a silent skip.
 */
import { DomainError, type ErrorPayloadMap, type RangeCause } from "../domain-errors.js";
import type { ServedRow } from "../hashline/anchor-pipeline.js";
import { fmtServedRows } from "../hashline/served-evidence.js";
import { splitLines } from "../utils.js";
import { recordRejectionRows } from "./rejection-serve.js";

/**
 * One failing item. `error` owns the diagnosis, its `[E_*]` code and — for a `DomainError` — the
 * rows the verifier measured. `inner` overrides the rendered bullet body when the engine projected
 * the message (the served-or-absent rule, ADR-0042) while `error` keeps the rowless typed
 * diagnosis, so arity one still throws a domain error.
 */
export interface BatchFailure {
  index: number;
  error: Error;
  inner?: string;
}

/**
 * The committed snapshot the rejection's rows were derived from. The recorder needs line canons
 * and the snapshot itself, not a snapshot hash (ADR-0043). Preview is not a separate path:
 * current-file rows stay recordable in a preview (#145).
 */
export interface RejectionRecorder {
  sessionKey: string;
  absolutePath: string;
  content: string;
  hashes: readonly string[];
}

const ROWS_SERVED_NOTE =
  "These rows are the file's current anchors and were recorded as served — retry with them.";
const ROWS_NOT_SERVED_NOTE =
  "These rows are the file's current anchors but were NOT recorded as served — re-read before retrying.";

function carriedRows(failure: BatchFailure): ServedRow[] {
  return failure.error instanceof DomainError ? failure.error.servedRows : [];
}

function renderedInner(failure: BatchFailure): string {
  return failure.inner ?? failure.error.message;
}

function diagnosisOf(failure: BatchFailure): RangeCause | undefined {
  return failure.error instanceof DomainError ? failure.error.cause : undefined;
}

/**
 * Build, record, then throw the one rejection shape.
 *
 * Records once per failure that carries rows. The envelope aggregates those rows for the machine
 * payload but never re-renders them: each inner message owns its own echo (ADR-0046).
 */
export async function throwBatchRejection(args: {
  failures: BatchFailure[];
  total: number;
  path: string;
  record?: RejectionRecorder;
}): Promise<never> {
  const { failures, total, path, record } = args;
  const first = failures[0];
  if (first === undefined) throw new TypeError("throwBatchRejection: failures must not be empty");

  // Fail loud before recording anything: a refusal that shows rows but cannot record them would
  // hand the model anchors it can never reuse.
  if (record === undefined) {
    for (const failure of failures) {
      const rows = carriedRows(failure);
      if (rows.length > 0) {
        throw new TypeError(
          `throwBatchRejection: failure at index ${failure.index} carries ${rows.length} ` +
            "served row(s) but no recorder context was supplied — a rejection that shows rows " +
            "must record them (reject-and-serve). Supply record or route through a context-carrying site.",
        );
      }
    }
  }

  const served: ServedRow[] = [];
  const blocks: string[] = [];
  let serveNote: string | undefined;
  for (const failure of failures) {
    const rows = carriedRows(failure);
    if (rows.length === 0 || record === undefined) continue;
    const landed = await recordRejectionRows({
      sessionKey: record.sessionKey,
      absolutePath: record.absolutePath,
      rows,
      content: record.content,
      hashes: record.hashes,
    });
    // Only one failing item renders the disposition; with several, each bullet owns its rows.
    if (failures.length === 1) serveNote = landed ? ROWS_SERVED_NOTE : ROWS_NOT_SERVED_NOTE;
    served.push(...rows);
    blocks.push(fmtServedRows(rows, splitLines(record.content)));
  }

  if (total === 1) throw first.error;

  const base: ErrorPayloadMap["E_BATCH_ABORT"] = {
    index: first.index,
    path,
    inner: renderedInner(first),
    total,
    ...(serveNote !== undefined ? { serveNote } : {}),
    servedRows: served,
    servedBlock: blocks.join("\n"),
  };
  if (failures.length === 1) {
    const cause = diagnosisOf(first);
    throw new DomainError("E_BATCH_ABORT", {
      ...base,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
  const firstCause = diagnosisOf(first);
  const unanimous =
    firstCause !== undefined && failures.every((f) => diagnosisOf(f) === firstCause);
  throw new DomainError("E_BATCH_ABORT", {
    ...base,
    failures: failures.map((failure) => ({
      index: failure.index,
      inner: renderedInner(failure),
    })),
    ...(unanimous ? { cause: firstCause } : {}),
  });
}
