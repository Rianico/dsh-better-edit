/**
 * The dsh `edit` tool: hash-anchored literal range edits that shadow the
 * built-in `edit` on the agent's own scope layer. Now the sole mutation tool
 * (batch_edit removed, ADR-0007): payload is { file: string, edits: [{anchor_from,anchor_to,replace_with},...] }
 * single-file atomic batch; the file is named explicitly, never inferred (#117).
 * @module dsh-better-edit/tool-edit
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { normalizeRequest as normReq, assertEditRequest, dryRunSchema } from "./contract.js";
import { abortIf } from "./utils.js";
import { execute } from "./mutation.js";
import { EDIT_DESCRIPTION } from "./prompts.js";
import { DomainError } from "./domain-errors.js";
import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./workspace-context.js";
import type { FsSandboxController, FsEscalationArgs } from "./sandbox.js";
import { withWorkspace } from "./workspace-context.js";
import type { PreparedItem } from "./mutation/engine.js";

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
          // #117: null stays wire-admissible so the domain rejects it with
          // E_BAD_PAYLOAD; dsh would otherwise answer INVALID_ARGS before the
          // contract runs. Undocumented and never inferable.
          { type: "null" },
        ],
      },
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
        },
      },
      mode: {
        type: "string",
        enum: ["general", "literal"],
        description:
          'How to treat bytes reproducing served rows: "general" refuses them, "literal" declares them as intended file content',
      },
      dry_run: dryRunSchema,
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
          // `assertEditRequest` narrows the raw args to the normalized contract.
          const req = canonical;
          // #117: a null/absent file is rejected at admission (assertEditRequest);
          // the retired anchor-inference arm never resolves one here.
          const resolvedFile = req.file;
          const sandboxPolicy = await sandbox.resolvePolicy(
            "edit",
            // SAFETY: `resolvePolicy` reads only sandbox_permissions/justification;
            // the file/edits fields are legacy context it ignores.
            { file: resolvedFile, edits: req.edits } as unknown as FsEscalationArgs,
            exec,
          );

          abortIf(signal);
          const items: PreparedItem[] = [];
          for (let index = 0; index < req.edits.length; index++) {
            const e = req.edits[index]!;
            items.push({
              index,
              file: resolvedFile,
              absolutePath: await io.resolve(resolvedFile, cwd, signal),
              anchor_from: e.anchor_from,
              anchor_to: e.anchor_to,
              replace_with: e.replace_with,
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
