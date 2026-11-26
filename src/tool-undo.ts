/**
 * The dsh `undo_last_edit` tool: reverts the last hashline edit on a file,
 * only when the file still matches the stored post-edit content — a later
 * external write clears the history instead of being overwritten.
 * @module dsh-better-edit/tool-undo
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { toLF, stripBOM, genDiff, restoreEndings } from "./edit-diff.js";
import { visLines, splitLines, codeOf } from "./utils.js";
import { DomainError, formatError } from "./domain-errors.js";
import { assertUndoRequest } from "./contract.js";
import { normalizeRequest as normReq } from "./contract.js";
import { loadHashStore, withStore, type InternalHashStore } from "./hash-store.js";
import {
  HASH_SPACE,
  canon,
  contentChecksum,
  isPromotableAnchorSpaceExhaustion,
} from "./hashline/hash-assign.js";
import { lineHashes } from "./hashline/hash.js";
import { changedRange } from "./hashline/anchor-pipeline.js";
import { getUndo, clearUndo } from "./undo-edit.js";
import {
  loadAnchorReservations,
  loadServedStore,
  recordServedTruncated,
  retireAnchorsInStore,
  unretireAnchorsInStore,
} from "./session-view.js";
import { UNDO_DESCRIPTION } from "./prompts.js";
import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./workspace-context.js";
import type { FsSandboxController, FsEscalationArgs } from "./sandbox.js";
import { withWorkspace } from "./workspace-context.js";
import { encodingHintAtVersion, getEncodingState, prepareForSave } from "./file-encoding-state.js";
import { resolveEncodingMigrationConsent } from "./encoding-consent.js";
import { loadConfig } from "./store-config.js";
import { endingName } from "./eol-config.js";

/**
 * Anchor-space exhaustion guard mirrored from the edit path (`retryLineHashesWithPromotion` in
 * src/mutation/engine.ts): clear this (session, path)'s retired anchors once to promote hash space
 * and retry; a retry that still exhausts is a typed hard capacity refusal, never a raw probe error.
 * The exhaustion test itself is shared (`isPromotableAnchorSpaceExhaustion`) — see its docblock
 * for why promotion's question is narrower than "is this exhaustion".
 */
async function hashWithAnchorSpacePromotion(
  fn: () => Promise<string[]>,
  onPromote: () => Promise<void> | void,
): Promise<string[]> {
  try {
    return await fn();
  } catch (error) {
    if (!isPromotableAnchorSpaceExhaustion(error)) throw error;
    await onPromote();
    try {
      return await fn();
    } catch (retryError) {
      if (isPromotableAnchorSpaceExhaustion(retryError))
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
        const sandboxPolicy = await sandbox.resolvePolicy(
          "undo_last_edit",
          // SAFETY: canonical validated by assertUndoRequest; shape is compatible with FsEscalationArgs (path + optional sandbox fields) — narrowing for sandbox.resolvePolicy
          canonical as unknown as FsEscalationArgs,
          exec,
        );

        const undo = await getUndo(absolutePath);
        if (!undo) {
          return `No undo history for ${path}. There is no previous edit to revert.`;
        }
        const effectiveEnding = undo.effectiveEnding ?? undo.originalEnding;

        let currentRaw: string;
        try {
          const currentVersion = await io.statVersion(absolutePath, signal);
          const encodingHint = encodingHintAtVersion(absolutePath, currentVersion);
          currentRaw = await io.readText(absolutePath, signal, encodingHint);
        } catch (error) {
          if (codeOf(error) === "E_NOT_FOUND") {
            await clearUndo(absolutePath);
            return formatError("E_UNDO_STALE", { path, reason: "deleted" });
          }
          throw error;
        }
        const expectedResult = restoreEndings(undo.resultContent, effectiveEnding);
        const matchesMigratedTarget =
          undo.migration !== undefined && stripBOM(currentRaw).text === expectedResult;
        if (currentRaw !== undo.bom + expectedResult && !matchesMigratedTarget) {
          await clearUndo(absolutePath);
          return formatError("E_UNDO_STALE", { path, reason: "modified" });
        }

        const { text: currentStripped } = stripBOM(currentRaw);
        const currentNormalized = toLF(currentStripped);
        const reservations = await loadAnchorReservations(sessionKey, absolutePath);
        let reservedHashes = new Set(reservations.reservedHashes);
        let retiredHashes = new Set(reservations.retiredHashes);
        const promoteRetiredForAnchorSpace = async (): Promise<void> => {
          try {
            const store = await loadServedStore();
            store.clearRetiredAnchors(sessionKey, absolutePath);
            try {
              store.clearCards(sessionKey, absolutePath);
            } catch {
              // HACK: card state is a cache; the retry proceeds without it
            }
          } catch {
            // HACK: a store fault must not fail the undo — the in-memory reservation state carries on (ADR-0020 R2)
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
        const restoredHashes = await hashWithAnchorSpacePromotion(
          () =>
            lineHashes(
              undo.content,
              absolutePath,
              { content: undo.content, hashes: undo.hashes },
              undefined,
              false,
              new Set([...reservedHashes, ...currentHashes]),
              retiredHashes,
            ),
          promoteRetiredForAnchorSpace,
        );
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
        const revivedByUndo = [...restoredSet].filter((hash) => retiredHashes.has(hash));
        const retiredByUndo = currentHashes.filter((hash) => !restoredSet.has(hash));
        const recorded = getEncodingState(absolutePath) ?? {
          encoding: undo.bom ? "utf8bom" : "utf8",
          hasBOM: undo.bom !== "",
          lineEnding: undo.originalEnding,
          version: undefined,
        };
        const prepared = prepareForSave(undo.content, recorded, {
          migrationConsent: resolveEncodingMigrationConsent(undefined, loadConfig()),
          displayPath: path,
          lineEnding: effectiveEnding,
        });

        try {
          await io.writeText(
            absolutePath,
            prepared.textToWrite,
            signal,
            exec,
            sandboxPolicy,
            undefined,
            {
              lineEnding: effectiveEnding,
            },
          );
        } catch (error) {
          throw sandbox.mapError(error, sandboxPolicy);
        }

        // SAFETY: loadHashStore returns the InternalHashStore
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
            unretireAnchorsInStore(store, sessionKey, absolutePath, revivedByUndo);
            store.deleteUndoPair(absolutePath);
          });
        } catch (error) {
          console.error("Failed to record the undo restore in the hash store:", error);
          throw new DomainError("E_UNDO_NOT_RECORDED", { path });
        }

        const parts: string[] = [`Undone last edit on ${path}.`];
        if (linesAddedByEdit > 0 || linesRemovedByEdit > 0) {
          parts.push(
            `Removed ${linesAddedByEdit} line(s) that were added and restored ${linesRemovedByEdit} line(s) that were removed.`,
          );
        }
        if (undo.preImageMixed) {
          parts.push(
            `Restored at ${endingName(effectiveEnding)}; the pre-edit mixture is not restored.`,
          );
        }
        if (undo.migration !== undefined) {
          parts.push(
            undo.migration.hasBOM
              ? `Restored as UTF-8; the pre-edit ${undo.migration.encoding} encoding and its BOM are not restored.`
              : `Restored as UTF-8; the pre-edit ${undo.migration.encoding} encoding is not restored.`,
          );
        }
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
            ? "File reverted to previous state. The post-edit diff rows carry the restored file\u2019s original anchors for follow-up edits."
            : "File reverted to previous state. WARNING: the restored file\u2019s original anchors were NOT recorded as served — the diff rows below are NOT usable anchors and no edit can be based on them. Re-read the file before editing it.",
        );

        return [parts.join("\n"), "", "Diff of the revert:", "", undoDiff].join("\n");
      });
    },
  });
}
