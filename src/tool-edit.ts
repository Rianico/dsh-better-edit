/**
 * The dsh `edit` tool: hash-anchored literal range edits that shadow the
 * built-in `edit` on the agent's own scope layer. Now the sole mutation tool
 * (batch_edit removed, ADR-0007): payload is { file: string|null, edits: [{anchor_from,anchor_to,replace_with},...] }
 * single-file atomic batch, legacy null file inference via anchors.
 * @module dsh-better-edit/tool-edit
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { normalizeRequest as normReq, assertEditRequest } from "./contract.js";
import { abortIf } from "./utils.js";
import { execute } from "./mutation.js";
import { EDIT_DESCRIPTION } from "./prompts.js";
import { codeOf } from "./utils.js";
import { DomainError, formatError } from "./domain-errors.js";
import type { EditMode } from "./contract.js";
import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./workspace-context.js";
import type { FsSandboxController, FsEscalationArgs } from "./sandbox.js";
import { withWorkspace } from "./workspace-context.js";
import { findSnapshotPathsByHashes } from "./hash-store.js";
import { parseHashRef } from "./hashline/anchor-pipeline.js";
import type { PreparedItem } from "./edit-engine.js";

async function resolveNullPath(
  edits: Array<{ anchor_from: string; anchor_to: string }>,
): Promise<{ file: string; warning: string } | undefined> {
  if (edits.length === 0) return undefined;
  const first = edits[0]!;
  try {
    const h1 = parseHashRef(first.anchor_from).hash;
    const h2 = parseHashRef(first.anchor_to).hash;
    const matches = await findSnapshotPathsByHashes([h1, h2]);
    if (matches.length === 1) {
      return {
        file: matches[0]!,
        warning: formatError("E_BAD_PAYLOAD", {
          message: `Autocorrected: missing "file" resolved to ${matches[0]} — the only file whose stored hashes contain both anchors.`,
        }),
      };
    }
    if (matches.length > 1) {
      throw new DomainError("E_BAD_PAYLOAD", {
        message: `Edit request requires a non-empty "file" string; the anchors match multiple known files: ${matches.join(", ")}. Include the intended file.`,
      });
    }
  } catch (e) {
    if (codeOf(e) === "E_BAD_PAYLOAD") throw e;
    return undefined;
  }
  return undefined;
}

/**
 * E_UNKNOWN producer: the edit tool boundary is where raw unexpected errors
 * surface. DomainError members and aborts pass through untouched; anything else
 * becomes a typed E_UNKNOWN with its name + first line.
 */
function wrapUnexpected(error: unknown, signal: AbortSignal | undefined): never {
  if (error instanceof DomainError) throw error;
  if (signal?.aborted) throw error;
  if (error instanceof Error && error.message === "Operation aborted") throw error;
  const errorName = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  throw new DomainError("E_UNKNOWN", { errorName, message });
}

export function buildEditTool(io: FileIO, sandbox: FsSandboxController) {
  return defineTool({
    name: "edit",
    description: EDIT_DESCRIPTION,
    parameters: {
      file: {
        oneOf: [
          { type: "string", description: "Text file to edit (a file, never a directory)" },
          { type: "null", description: "null infers the file from anchors" },
        ],
      } as unknown as import("@deepseek-ai/dsh-tools").ValueSchemaSpec & { required?: true },
      edits: {
        type: "array",
        description:
          "Ordered list of edit items — one edit per item, single-file atomic; each item is a named object, legacy tuples still fold pre-validation",
        items: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                anchor_from: { type: "string", required: true },
                anchor_to: { type: "string", required: true },
                replace_with: { type: "string", required: true },
              },
            },
            { type: "array", items: { type: "string" } },
          ],
        } as unknown as import("@deepseek-ai/dsh-tools").ValueSchemaSpec,
      } as unknown as import("@deepseek-ai/dsh-tools").ValueSchemaSpec & { required?: true },
      mode: {
        type: "string",
        enum: ["general", "literal"],
        description:
          'How to treat bytes reproducing served rows: "general" refuses them, "literal" declares them as intended file content',
      } as unknown as import("@deepseek-ai/dsh-tools").ValueSchemaSpec,
      ...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      return withWorkspace(execCwd(exec), async () => {
        try {
          const cwd = execCwd(exec);
          const sessionKey = execSessionKey(exec);
          const signal = exec.signal;

          const canonical = normReq(args);
          assertEditRequest(canonical);
          const req = canonical as unknown as {
            file: string | null;
            mode?: EditMode;
            edits: Array<{ anchor_from: string; anchor_to: string; replace_with: string }> & {
              [key: symbol]: unknown;
            };
          };
          let resolvedFile = req.file;
          let fileWarning: string | undefined;
          if (resolvedFile === null) {
            const resolved = await resolveNullPath(req.edits);
            if (resolved) {
              resolvedFile = resolved.file;
              fileWarning = resolved.warning;
            } else {
              throw new DomainError("E_BAD_PAYLOAD", {
                message:
                  "Edit request file is null and could not be inferred from anchors — anchors match no known file. Include the intended file.",
              });
            }
          }
          const sandboxPolicy = await sandbox.resolvePolicy(
            "edit",
            { file: resolvedFile, edits: req.edits } as unknown as FsEscalationArgs,
            exec,
          );

          abortIf(signal);
          const items: PreparedItem[] = [];
          for (let index = 0; index < req.edits.length; index++) {
            const e = req.edits[index]!;
            items.push({
              index,
              file: resolvedFile!,
              absolutePath: await io.resolve(resolvedFile!, cwd, signal),
              anchor_from: e.anchor_from,
              anchor_to: e.anchor_to,
              replace_with: e.replace_with,
              fileWarning: index === 0 ? fileWarning : undefined,
              ...(req.mode !== undefined ? { mode: req.mode } : {}),
            });
          }

          // Deep seam: one interface, all lifecycle branching concentrates in Mutation
          return execute({ io, items, sessionKey, signal, exec, sandbox, sandboxPolicy });
        } catch (error: unknown) {
          throw wrapUnexpected(error, exec.signal);
        }
      });
    },
  });
}

export function registerEditTool(
  _rootCtx: Context,
  agentCtx: Context,
  io: FileIO,
  sandbox: FsSandboxController,
): () => void {
  return agentCtx.tools.register(buildEditTool(io, sandbox));
}
