/**
 * The dsh `undo_last_edit` tool: reverts the last hashline edit on a file,
 * only when the file still matches the stored post-edit content — a later
 * external write clears the history instead of being overwritten.
 * @module dsh-better-edit/tool-undo
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { toLF, stripBOM, genDiff, restoreEndings } from "./edit-diff.js";
import { visLines, splitLines, codeOf } from "./utils.js";
import { DomainError, formatError } from "./domain-errors.js";
import { assertUndoRequest } from "./contract.js";
import { normalizeRequest as normReq } from "./contract.js";
import { loadHashStore, withStore, type InternalHashStore } from "./hash-store.js";
import {
  AnchorSpaceExhaustedError,
  HASH_SPACE,
  canon,
  contentChecksum,
} from "./hashline/hash-assign.js";
import { lineHashes } from "./hashline/hash.js";
import { changedRange } from "./hashline/anchor-pipeline.js";
import { getUndo, clearUndo } from "./undo-edit.js";
import {
  loadAnchorReservations,
  loadServedStore,
  recordServedTruncated,
  retireAnchorsInStore,
} from "./session-view.js";
import { UNDO_DESCRIPTION } from "./prompts.js";
import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./workspace-context.js";
import type { FsSandboxController, FsEscalationArgs } from "./sandbox.js";
import { withWorkspace } from "./workspace-context.js";

function isAnchorSpaceExhausted(e: unknown): boolean {
  return (
    e instanceof AnchorSpaceExhaustedError ||
    (e instanceof Error && e.message.includes("probing failed over"))
  );
}

/**
 * Anchor-space exhaustion guard mirrored from the edit path (`retryLineHashesWithPromotion` in
 * src/mutation/engine.ts): clear this (session, path)'s retired anchors once to promote hash space
 * and retry; a retry that still exhausts is a typed hard capacity refusal, never a raw probe error.
 */
async function hashWithAnchorSpacePromotion(
  fn: () => Promise<string[]>,
  onPromote: () => Promise<void> | void,
): Promise<string[]> {
  try {
    return await fn();
  } catch (error) {
    if (!isAnchorSpaceExhausted(error)) throw error;
    await onPromote();
    try {
      return await fn();
    } catch (retryError) {
      if (isAnchorSpaceExhausted(retryError))
        throw new DomainError("E_LARGE_FILE", { limitKind: "hash-space", limit: HASH_SPACE });
      throw retryError;
    }
  }
}

/**
 * Register the `undo_last_edit` tool on the calling agent's scope.
 * @param _rootCtx - host context.
 * @param agentCtx - the agent's scoped context (own scope layer).
 * @param io - the filesystem bridge.
 * @returns the exact disposer that unregisters the tool.
 */
export function buildUndoTool(io: FileIO, sandbox: FsSandboxController) {
  return defineTool({
    name: "undo_last_edit",
    description: UNDO_DESCRIPTION,
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the file to undo",
      },
      ...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      return withWorkspace(execCwd(exec), async () => {
        const cwd = execCwd(exec);
        const sessionKey = execSessionKey(exec);
        const signal = exec.signal;

        const canonical = normReq(args);
        assertUndoRequest(canonical);
        const path = canonical.path;
        const absolutePath = await io.resolve(path, cwd, signal);
        // SAFETY: canonical validated by assertUndoRequest; shape is compatible with FsEscalationArgs (path + optional sandbox fields) — narrowing for sandbox.resolvePolicy
        const sandboxPolicy = await sandbox.resolvePolicy(
          "undo_last_edit",
          canonical as unknown as FsEscalationArgs,
          exec,
        );

        const undo = await getUndo(absolutePath);
        if (!undo) {
          return `No undo history for ${path}. There is no previous edit to revert.`;
        }

        let currentRaw: string;
        try {
          currentRaw = await io.readText(absolutePath, signal);
        } catch (error) {
          if (codeOf(error) === "E_NOT_FOUND") {
            await clearUndo(absolutePath);
            return formatError("E_UNDO_STALE", { path, reason: "deleted" });
          }
          throw error;
        }
        if (currentRaw !== undo.bom + restoreEndings(undo.resultContent, undo.originalEnding)) {
          await clearUndo(absolutePath);
          return formatError("E_UNDO_STALE", { path, reason: "modified" });
        }

        const { text: currentStripped } = stripBOM(currentRaw);
        const currentNormalized = toLF(currentStripped);
        // Per-session reservations: retired/ served are per (session, path) per ADR-0013; file snapshots stay global last-writer-wins
        const reservations = await loadAnchorReservations(sessionKey, absolutePath);
        // Anchor-space promotion mirrors the edit path (src/mutation/engine.ts): on exhaustion,
        // clear this (session, path)'s retired anchors to free hash space and retry once; a retry
        // that still exhausts is a hard capacity refusal (E_LARGE_FILE hash-space). The in-memory
        // reservation sets track the cleared store so the restore rehash below sees them too.
        let reservedHashes = new Set(reservations.reservedHashes);
        let retiredHashes = new Set(reservations.retiredHashes);
        const promoteRetiredForAnchorSpace = async (): Promise<void> => {
          try {
            const store = await loadServedStore();
            store.clearRetiredAnchors(sessionKey, absolutePath);
            try {
              store.clearCards(sessionKey, absolutePath);
            } catch {
              // Best-effort: card state is a cache; the retry proceeds without it.
            }
          } catch {
            // Best-effort: a store fault here must not fail the undo — the retry proceeds on the
            // in-memory reservation state (ADR-0020 R2, promotion/wipe arm).
          }
          const served = new Set([...reservedHashes].filter((h) => !retiredHashes.has(h)));
          retiredHashes = new Set();
          reservedHashes = served;
        };
        const currentHashes = await hashWithAnchorSpacePromotion(
          () =>
            lineHashes(
              currentNormalized,
              absolutePath,
              undefined,
              undefined,
              false,
              reservedHashes,
              retiredHashes,
            ),
          promoteRetiredForAnchorSpace,
        );
        const retiredOriginalHashes = new Set(
          undo.hashes.filter((hash) => retiredHashes.has(hash)),
        );
        const restoredHashes = await hashWithAnchorSpacePromotion(
          () =>
            lineHashes(
              undo.content,
              absolutePath,
              {
                content: undo.content,
                hashes: undo.hashes,
                removedHashes: retiredOriginalHashes,
              },
              undefined,
              false,
              new Set([...reservedHashes, ...currentHashes]),
              retiredHashes,
            ),
          promoteRetiredForAnchorSpace,
        );
        // WHY: #96 (pi-better-edit@665a05d, upstream #173) — the summary counts come from the
        // WHY: source line multisets, never from the rendered projection: a deleted run past
        // WHY: DIFF_REMOVED_CAP collapses behind a marker row at context 0, so counting `-` rows
        // WHY: underreported the restored lines. A line the edit added is one present in the
        // WHY: current file beyond its occurrence count in `undo.content`; a removed line is the
        // WHY: converse. Collapsed and expanded projections therefore report identical counts.
        const remainingUndoCounts = new Map<string, number>();
        for (const line of visLines(undo.content)) {
          remainingUndoCounts.set(line, (remainingUndoCounts.get(line) ?? 0) + 1);
        }
        let linesAddedByEdit = 0;
        for (const line of visLines(currentNormalized)) {
          const remaining = remainingUndoCounts.get(line) ?? 0;
          if (remaining > 0) remainingUndoCounts.set(line, remaining - 1);
          else linesAddedByEdit++;
        }
        let linesRemovedByEdit = 0;
        for (const remaining of remainingUndoCounts.values()) linesRemovedByEdit += remaining;
        const undoDiffResult = genDiff(
          currentNormalized,
          undo.content,
          1,
          restoredHashes,
          currentHashes,
        );
        const undoDiff = undoDiffResult.diff;
        const undoDenseRows: typeof undoDiffResult.servedRows = [];
        for (let i = 0; i < restoredHashes.length; i++) {
          undoDenseRows.push({ position: i, hash: restoredHashes[i]! });
        }
        const restoredRange = changedRange(currentNormalized, undo.content);
        const restoredSet = new Set(restoredHashes);
        // WHY (#98, port of upstream CAND-3): retirement waits for the write. Committing it
        // before `writeText` let a failed revert leave anchors retired for a file that still
        // holds them — a torn store state with no later read likely to notice.
        const retiredByUndo = currentHashes.filter((hash) => !restoredSet.has(hash));

        try {
          await io.writeText(
            absolutePath,
            undo.bom + restoreEndings(undo.content, undo.originalEnding),
            signal,
            exec,
            sandboxPolicy,
          );
        } catch (error) {
          throw sandbox.mapError(error, sandboxPolicy);
        }

        // The file is reverted; the store state must move as ONE unit: the snapshot/lineage adopt
        // (`upsertSnapshot`), the retirement of the anchors the revert freed, and the undo-pair
        // clear (`deleteUndoPair`) are all-or-nothing. `withStore` routes every call through the
        // store's single re-entrant transaction owner (the store was just loaded for this
        // workspace, so `currentStore()` is that same handle). Fail loud: a cleared pair over an
        // un-adopted snapshot, or a revert without its retirement, is a desync no later read or
        // edit can see.
        // SAFETY: loadHashStore returns the InternalHashStore
        // (HashStore & ServedPersistence & LineageStore); its public return type is narrowed, and
        // this unit needs the served face for the retirement that commits with the adopt.
        const store = (await loadHashStore()) as InternalHashStore;
        try {
          withStore(() => {
            store.upsertSnapshot(
              absolutePath,
              contentChecksum(undo.content),
              splitLines(undo.content).length,
              restoredHashes,
              undo.content,
            );
            retireAnchorsInStore(store, sessionKey, absolutePath, retiredByUndo);
            store.deleteUndoPair(absolutePath);
          });
        } catch (error) {
          // Not a swallow: the raw cause is logged for diagnosis, then the tool fails loud.
          console.error("Failed to record the undo restore in the hash store:", error);
          throw new DomainError("E_UNDO_NOT_RECORDED", { path });
        }

        const parts: string[] = [`Undone last edit on ${path}.`];
        if (linesAddedByEdit > 0 || linesRemovedByEdit > 0) {
          parts.push(
            `Removed ${linesAddedByEdit} line(s) that were added and restored ${linesRemovedByEdit} line(s) that were removed.`,
          );
        }
        // The serve write is a SECOND unit, deliberately outside the committed pair: a fault
        // here must not roll the revert back. But it decides whether the anchors below are
        // usable, so the claim is made only when the serve landed.
        let serveLanded = true;
        if (undoDenseRows.length > 0) {
          serveLanded = await recordServedTruncated(
            sessionKey,
            absolutePath,
            undoDenseRows,
            splitLines(undo.content).length,
            restoredRange?.firstChangedLine ?? undoDiffResult.firstChangedLine ?? 0,
            splitLines(undo.content).map((l) => canon(l)),
            { content: undo.content, hashes: restoredHashes },
          );
        }

        parts.push(
          serveLanded
            ? "File reverted to previous state. The post-edit diff rows carry the restored file\u2019s fresh anchors for follow-up edits."
            : "File reverted to previous state. WARNING: the restored file\u2019s fresh anchors were NOT recorded as served — the diff rows below are NOT usable anchors and no edit can be based on them. Re-read the file before editing it.",
        );

        return [parts.join("\n"), "", "Diff of the revert:", "", undoDiff].join("\n");
      });
    },
  });
}

/**
 * Register the hashline tool on the calling agent’s scope (own layer).
 */
export function registerUndoTool(
  _rootCtx: Context,
  agentCtx: Context,
  io: FileIO,
  sandbox: FsSandboxController,
): () => void {
  return agentCtx.tools.register(buildUndoTool(io, sandbox));
}
