/**
 * The dsh `edit` tool: hash-anchored literal range edits that shadow the
 * built-in `edit` on the agent's own scope layer. Now the sole mutation tool
 * (batch_edit removed, ADR-0007): payload is { path: string|null, edits: [[remove_from,remove_to,replacement_text],...] }
 * single-file atomic batch, null path inference via anchors.
 * @module dsh-better-edit/tool-edit
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  normalizeRequest as normReq,
  assertEditRequest,
} from "./contract.js";
import { abortIf } from "./utils.js";
import { execute } from "./mutation.js";
import { EDIT_DESCRIPTION } from "./prompts.js";
import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./session-view.js";
import type { FsSandboxController, FsEscalationArgs } from "./sandbox.js";
import { withWorkspace } from "./session-view.js";
import { findSnapshotPathsByHashes } from "./hash-store.js";
import { parseHashRef } from "./hashline/anchor-pipeline.js";
import type { PreparedItem } from "./edit-engine.js";

async function resolveNullPath(edits: Array<{ remove_from: string; remove_to: string }>): Promise<{ path: string; warning: string } | undefined> {
  if (edits.length === 0) return undefined;
  const first = edits[0]!;
  try {
    const h1 = parseHashRef(first.remove_from).hash;
    const h2 = parseHashRef(first.remove_to).hash;
    const matches = await findSnapshotPathsByHashes([h1, h2]);
    if (matches.length === 1) {
      return {
        path: matches[0]!,
        warning: `[E_BAD_SHAPE] Autocorrected: missing "path" resolved to ${matches[0]} — the only file whose stored hashes contain both anchors.`,
      };
    }
    if (matches.length > 1) {
      throw new Error(`[E_BAD_SHAPE] Edit request requires a non-empty "path" string; the anchors match multiple known files: ${matches.join(", ")}. Include the intended path.`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("[E_BAD_SHAPE]")) throw e;
    return undefined;
  }
  return undefined;
}

export function buildEditTool(io: FileIO, sandbox: FsSandboxController) {
  return defineTool({
    name: "edit",
    description: EDIT_DESCRIPTION,
    parameters: {
      path: {
        oneOf: [
          { type: "string", description: "File path; null infers it from anchors" },
          { type: "null", description: "null infers path from anchors" },
        ],
      } as unknown as import("@deepseek-ai/dsh-tools").ValueSchemaSpec & { required?: true },
      edits: {
        type: "array",
        description: "Ordered list of edit tuples [remove_from, remove_to, replacement_text] — one edit per tuple, single-file atomic",
        items: { type: "json" as const, description: "[remove_from, remove_to, replacement_text]" } as unknown as import("@deepseek-ai/dsh-tools").ValueSchemaSpec,
      } as unknown as import("@deepseek-ai/dsh-tools").ValueSchemaSpec & { required?: true },
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
        assertEditRequest(canonical);
        const req = canonical as unknown as { path: string | null; edits: Array<{ remove_from: string; remove_to: string; replacement_text: string }> & { [key: symbol]: unknown } };
        let resolvedPath = req.path;
        let pathWarning: string | undefined;
        if (resolvedPath === null) {
          const resolved = await resolveNullPath(req.edits);
          if (resolved) {
            resolvedPath = resolved.path;
            pathWarning = resolved.warning;
          } else {
            throw new Error("[E_BAD_SHAPE] Edit request path is null and could not be inferred from anchors — anchors match no known file. Include the intended path.");
          }
        }
        const sandboxPolicy = await sandbox.resolvePolicy(
          "edit",
          { path: resolvedPath, edits: req.edits } as unknown as FsEscalationArgs,
          exec,
        );

        abortIf(signal);
        const items: PreparedItem[] = [];
        for (let index = 0; index < req.edits.length; index++) {
          const e = req.edits[index]!;
          items.push({
            index,
            path: resolvedPath!,
            absolutePath: await io.resolve(resolvedPath!, cwd, signal),
            remove_from: e.remove_from,
            remove_to: e.remove_to,
            replacement_text: e.replacement_text,
            pathWarning: index === 0 ? pathWarning : undefined,
          });
        }

        // Deep seam: one interface, all lifecycle branching concentrates in Mutation
        return execute({ io, items, sessionKey, signal, exec, sandbox, sandboxPolicy });
      });
    },
  });
}

export function registerEditTool(_rootCtx: Context, agentCtx: Context, io: FileIO, sandbox: FsSandboxController): () => void {
  return agentCtx.tools.register(buildEditTool(io, sandbox));
}
