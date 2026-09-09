/**
 * Shared output-render seam for the `{ text, warning? }` tool payload.
 *
 * `read` (tool-read.ts) and `str_replace_editor` view (tool-str-replace-editor.ts)
 * previously carried verbatim copies of this render closure, so a warning-format
 * change had to be made in two places (report #7). Both now delegate here.
 * @module dsh-better-edit/render-text-warning
 */

export type TextWarningValue = { text: string; warning?: string } | string;

export type TextBlock = { type: "text"; text: string };

/**
 * Render a `{ text, warning? }` payload (or bare string) as content blocks:
 * string input yields a single text block, object input yields the text block
 * plus a second block when `warning` is present.
 */
export function renderTextWarning(value: TextWarningValue): TextBlock[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  const blocks: TextBlock[] = [{ type: "text", text: value.text }];
  if (value.warning) blocks.push({ type: "text", text: value.warning });
  return blocks;
}
