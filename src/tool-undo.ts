/**
 * The dsh `undo_last_edit` tool: reverts the last hashline edit on a file,
 * only when the file still matches the stored post-edit content — a later
 * external write clears the history instead of being overwritten.
 * @module dsh-better-edit/tool-undo
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { toLF, stripBOM, genDiff, restoreEndings } from "./edit-diff.js";
import { cntDiff, splitLines, codeOf } from "./utils.js";
import { DomainError, formatError } from "./domain-errors.js";
import { assertUndoRequest } from "./contract.js";
import { normalizeRequest as normReq } from "./contract.js";
import { loadHashStore, withStore } from "./hash-store.js";
import { canon, contentChecksum } from "./hashline/hash-assign.js";
import { lineHashes } from "./hashline/hash.js";
import { changedRange } from "./hashline/anchor-pipeline.js";
import { getUndo, clearUndo } from "./undo-edit.js";
import { loadAnchorReservations, recordServedTruncated, retireAnchors } from "./session-view.js";
import { UNDO_DESCRIPTION } from "./prompts.js";
import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./workspace-context.js";
import type { FsSandboxController, FsEscalationArgs } from "./sandbox.js";
import { withWorkspace } from "./workspace-context.js";

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
          const message = error instanceof Error ? error.message : String(error);
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
        const currentHashes = await lineHashes(
          currentNormalized,
          absolutePath,
          undefined,
          undefined,
          false,
          reservations.reservedHashes,
          reservations.retiredHashes,
        );
        const retiredOriginalHashes = new Set(
          undo.hashes.filter((hash) => reservations.retiredHashes.has(hash)),
        );
        const blockedRestoreHashes = new Set(reservations.reservedHashes);
        for (const hash of currentHashes) blockedRestoreHashes.add(hash);
        const restoredHashes = await lineHashes(
          undo.content,
          absolutePath,
          {
            content: undo.content,
            hashes: undo.hashes,
            removedHashes: retiredOriginalHashes,
          },
          undefined,
          false,
          blockedRestoreHashes,
          reservations.retiredHashes,
        );
        const diffResult = genDiff(undo.content, currentNormalized, 0, undefined, undo.hashes);
        const linesAddedByEdit = cntDiff(diffResult.diff, "+");
        const linesRemovedByEdit = cntDiff(diffResult.diff, "-");
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
        await retireAnchors(
          sessionKey,
          absolutePath,
          currentHashes.filter((hash) => !restoredSet.has(hash)),
        );

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

        // The file is reverted; the store pair must move as ONE unit: the snapshot/lineage
        // adopt (`upsertSnapshot`) and the undo-pair clear (`deleteUndoPair`) are both-or-neither.
        // `withStore` routes both calls through the store's single re-entrant transaction owner
        // (the store was just loaded for this workspace, so `currentStore()` is that same handle).
        // Fail loud: a cleared pair over an un-adopted snapshot is a desync no later read/edit can see.
        const store = await loadHashStore();
        try {
          withStore(() => {
            store.upsertSnapshot(
              absolutePath,
              contentChecksum(undo.content),
              splitLines(undo.content).length,
              restoredHashes,
              undo.content,
            );
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
