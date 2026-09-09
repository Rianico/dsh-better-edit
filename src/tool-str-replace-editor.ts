/**
 * The dsh `str_replace_editor` shadow: a governed agent-layer replacement for
 * the built-in `@deepseek-ai/dsh-tool-str-replace-editor` with identical
 * contract (`view` / `str_replace` / `insert` / `create`, no new `encoding`
 * param) but routed through the file-encoding-state seam.
 *
 * - `view` is observation: decode via the `ctxFsIO` path (`decodeForOpen`
 *   inside `io.readText`), records file encoding state, emits `fs/observed`,
 *   and never records served state (so it can feed `write` round-trips but
 *   cannot authorize hashline `edit` anchors).
 * - `str_replace` / `insert` without a prior `view`/`read` fail loud with
 *   `E_BLIND_REPLACE` — no disk write.
 * - `create` defaults to UTF-8 without BOM.
 * - `undo_edit` is out of scope → `E_UNSUPPORTED` (use `undo_last_edit`).
 *
 * See ADR-0015.
 * @module dsh-better-edit/tool-str-replace-editor
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { FileIO } from "./fs-bridge.js";
import { getAutoGuessFooter } from "./fs-bridge.js";
import { getEncodingState, invalidateIfStale, prepareForSave, recordOpenState } from "./file-encoding-state.js";
import { stripBOM } from "./edit-diff.js";
import { renderTextWarning } from "./render-text-warning.js";
import { execCwd, withWorkspace } from "./workspace-context.js";
import { abortIf, splitLines } from "./utils.js";

export const STR_REPLACE_EDITOR_DESCRIPTION =
  "View, create, and edit text files by exact string match. Commands: " +
  "`view` {path, view_range?} shows 1-indexed lines; `str_replace` {path, old_str, new_str} " +
  "replaces the unique occurrence of old_str; `insert` {path, insert_line, new_str} inserts " +
  "new line(s) before insert_line (1-indexed, lines+1 appends); `create` {path, file_text} " +
  "creates a new file (fails if it exists). str_replace/insert require a prior view of the " +
  "file in this session (E_BLIND_REPLACE otherwise). Encoding is governed: non-UTF-8 files " +
  "decode via auto-guess when enabled, otherwise fail loud with Top-3 candidates.";

type StrReplaceCommand = "view" | "str_replace" | "insert" | "create" | "undo_edit";

const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  "view",
  "str_replace",
  "insert",
  "create",
  "undo_edit",
]);

function argError(code: string, message: string): Error {
  return new Error(`[MODEL] [${code}] ${message}`);
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw argError("E_BAD_PAYLOAD", `str_replace_editor: "${name}" must be a non-empty string.`);
  }
  return value;
}

function requireViewRange(args: Record<string, unknown>): [number, number] | undefined {
  const value = args["view_range"];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isInteger(value[0]) ||
    !Number.isInteger(value[1]) ||
    (value[0] as number) < 1 ||
    (value[1] as number) < 1 ||
    (value[0] as number) > (value[1] as number)
  ) {
    throw argError(
      "E_BAD_PAYLOAD",
      'str_replace_editor: "view_range" must be [start, end] with 1-indexed positive integers and start <= end.',
    );
  }
  return [value[0] as number, value[1] as number];
}

/**
 * Strict read-first gate: the file must carry file encoding state recorded by
 * a prior `view`/`read` at the current version. Stale memos are invalidated
 * first, so drifted files fail loud instead of editing blind. Never writes.
 */
async function requireObserved(
  io: FileIO,
  absolutePath: string,
  displayPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const version = await io.statVersion(absolutePath, signal);
  invalidateIfStale(absolutePath, version);
  if (!getEncodingState(absolutePath)) {
    throw argError(
      "E_BLIND_REPLACE",
      `str_replace_editor: ${displayPath} has not been viewed in this session (no file encoding state at the current version). Call view first, then retry. Nothing was written.`,
    );
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** Shared-seam save restoration: BOM + lineEnding via `prepareForSave`.
 * Replaces the former local `restoreBom` so the shadow can't diverge from
 * the file-encoding-state round-trip (report #2). */
function restoreForSave(content: string, absolutePath: string): string {
  return prepareForSave(content, getEncodingState(absolutePath)).textToWrite;
}

function autoGuessWarning(absolutePath: string, rawPath: string): string | undefined {
  return getAutoGuessFooter(absolutePath) ?? getAutoGuessFooter(rawPath) ?? getAutoGuessFooter(absolutePath.replace(/\\/g, "/")) ?? undefined;
}

export function buildStrReplaceEditorTool(io: FileIO) {
  return defineTool({
    name: "str_replace_editor",
    description: STR_REPLACE_EDITOR_DESCRIPTION,
    parameters: {
      command: {
        type: "string",
        required: true,
        description: "One of: view, str_replace, insert, create, undo_edit",
      },
      path: {
        type: "string",
        required: true,
        description: "File path",
      },
      view_range: {
        type: "json",
        description: "[start, end] 1-indexed inclusive line range for view",
      } as unknown as import("@deepseek-ai/dsh-tools").ValueSchemaSpec,
      old_str: {
        type: "string",
        description: "Exact string to replace (must occur exactly once) for str_replace",
      },
      new_str: {
        type: "string",
        description: "Replacement text for str_replace, or line(s) to insert for insert",
      },
      insert_line: {
        type: "number",
        description: "1-indexed line to insert before (lines+1 appends) for insert",
      },
      file_text: {
        type: "string",
        description: "Full content for create",
      },
    },
    output: {
      schema: {
        type: "object",
        properties: { text: { type: "string", required: true }, warning: { type: "string" } },
        additionalProperties: false,
      },
      render: (_args, value) =>
        renderTextWarning(value as { text: string; warning?: string } | string),
    },
    async execute(args, exec) {
      return withWorkspace(execCwd(exec), async () => {
        const cwd = execCwd(exec);
        const signal = exec.signal;
        const rec = (args ?? {}) as Record<string, unknown>;
        const command = rec["command"];
        if (typeof command !== "string" || !KNOWN_COMMANDS.has(command)) {
          throw argError(
            "E_BAD_COMMAND",
            `str_replace_editor: unknown command ${JSON.stringify(command)} — expected one of view, str_replace, insert, create, undo_edit.`,
          );
        }
        const cmd = command as StrReplaceCommand;
        if (cmd === "undo_edit") {
          throw new Error(
            "[MODEL] [E_UNSUPPORTED] str_replace_editor undo_edit is not implemented — use undo_last_edit.",
          );
        }
        const rawPath = requireString(rec, "path");
        abortIf(signal);
        const absolutePath = await io.resolve(rawPath, cwd, signal);

        if (cmd === "view") {
          const text = await io.readText(absolutePath, signal);
          // Observation only: encoding state is recorded by readText;
          // served state is never touched here.
          // NOTE (report #10): the readText + emitObserved pair costs two
          // RPCs by design — readText decodes + records encoding state with
          // no session, while emitObserved emits fs/observed with exec + a
          // fresh stat version. Piggy-backing would need readText to take
          // exec / return a version (FileIO contract break); same pattern
          // as tool-read.ts, so documented, not collapsed.
          await io.emitObserved(absolutePath, exec, signal);
          const display = stripBOM(text).text;
          const range = requireViewRange(rec);
          let out = display;
          if (range) {
            const lines = splitLines(display);
            const total = lines.length === 1 && lines[0] === "" ? 0 : lines.length;
            const [start, end] = range;
            if (total === 0) {
              out = "[File is empty.]";
            } else if (start > total) {
              out = `View range [${start}, ${end}] is beyond end of file (${total} lines total).`;
            } else {
              out = lines.slice(start - 1, Math.min(end, total)).join("\n");
              if (end < total) {
                out += `\n\n[Showing lines ${start}-${Math.min(end, total)} of ${total}. Use view_range to continue.]`;
              }
            }
          }
          const warning = autoGuessWarning(absolutePath, rawPath);
          return warning ? { text: out, warning } : { text: out };
        }

        if (cmd === "create") {
          const fileText = requireString(rec, "file_text");
          const ver = await io.statVersion(absolutePath, signal);
          const exists = ver !== undefined;
          if (exists) {
            throw argError(
              "E_FILE_EXISTS",
              `str_replace_editor: cannot create ${rawPath} — file already exists.`,
            );
          }
          // Governed default: UTF-8 without BOM (no memo → no BOM).
          await io.writeText(absolutePath, fileText, signal, exec);
          try {
            const version = await io.statVersion(absolutePath, signal);
            recordOpenState(absolutePath, fileText, "utf8", false, version);
          } catch {
            // best-effort: the write succeeded; state is a hint.
          }
          return { text: `Created ${rawPath}.` };
        }

        // str_replace / insert — strict read-first gate, no disk write on failure.
        // NOTE (report #9): requireObserved's statVersion + the readText below
        // cost two RPCs by design — the stat invalidates stale encoding memos
        // BEFORE the read so a drifted file fails loud with E_BLIND_REPLACE
        // without paying for the read, and collapsing them (Promise.all or
        // skipping the stat) reintroduces TOCTOU: a stale memo could authorize
        // an edit on drifted bytes. Returning the version from readText would
        // need a FileIO contract break for an unmeasured hot-path nit; same
        // pattern as the view double-RPC above, so documented, not collapsed.
        await requireObserved(io, absolutePath, rawPath, signal);
        const current = await io.readText(absolutePath, signal);

        if (cmd === "str_replace") {
          const oldStr = requireString(rec, "old_str");
          if (!("new_str" in rec) || typeof rec["new_str"] !== "string") {
            throw argError(
              "E_BAD_PAYLOAD",
              'str_replace_editor: "new_str" must be a string for str_replace.',
            );
          }
          const newStr = rec["new_str"] as string;
          const matches = countOccurrences(current, oldStr);
          if (matches === 0) {
            throw argError(
              "E_NO_MATCH",
              `str_replace_editor: old_str not found in ${rawPath}. Nothing was written.`,
            );
          }
          if (matches > 1) {
            throw argError(
              "E_AMBIGUOUS_MATCH",
              `str_replace_editor: old_str has multiple matches (${matches}) in ${rawPath} — must match exactly once. Narrow old_str with more context. Nothing was written.`,
            );
          }
          const next = restoreForSave(current.replace(oldStr, newStr), absolutePath);
          await io.writeText(absolutePath, next, signal, exec);
          return { text: `Replaced 1 occurrence in ${rawPath}.` };
        }

        // insert
        const line = rec["insert_line"];
        if (!Number.isInteger(line) || (line as number) < 1) {
          throw argError(
            "E_BAD_PAYLOAD",
            'str_replace_editor: "insert_line" must be a positive integer for insert.',
          );
        }
        if (!("new_str" in rec) || typeof rec["new_str"] !== "string") {
          throw argError(
            "E_BAD_PAYLOAD",
            'str_replace_editor: "new_str" must be a string for insert.',
          );
        }
        const insertText = rec["new_str"] as string;
        const insertAt = line as number;
        const stripped = stripBOM(current).text;
        const endsWithNL = stripped.endsWith("\n");
        const body = endsWithNL ? stripped.slice(0, -1) : stripped;
        const lines = stripped.length === 0 ? [] : body.split("\n");
        if (insertAt > lines.length + 1) {
          throw argError(
            "E_BAD_PAYLOAD",
            `str_replace_editor: insert_line ${insertAt} is beyond end of file (${lines.length} lines). Nothing was written.`,
          );
        }
        const added = insertText.split("\n");
        lines.splice(insertAt - 1, 0, ...added);
        let out2 = lines.join("\n");
        if (endsWithNL && out2.length > 0) out2 += "\n";
        const next = restoreForSave(out2, absolutePath);
        await io.writeText(absolutePath, next, signal, exec);
        return { text: `Inserted ${added.length} line(s) at line ${insertAt} in ${rawPath}.` };
      });
    },
  });
}

/** Register the shadow `str_replace_editor` on the calling agent's scope (own layer). */
export function registerStrReplaceEditorTool(
  agentCtx: { tools: { register(def: unknown): () => void } },
  io: FileIO,
): () => void {
  return agentCtx.tools.register(buildStrReplaceEditorTool(io));
}
