import { describe, it, expect } from "vitest";
import { renderTextWarning } from "../../src/render-text-warning.js";
import { buildReadTool } from "../../src/tool-read.js";
import { buildStrReplaceEditorTool } from "../../src/tool-str-replace-editor.js";
import { localIO } from "../../src/fs-bridge.js";

describe("renderTextWarning shared render (report #7)", () => {
	it("renders a bare string as one block", () => {
		expect(renderTextWarning("hello")).toEqual([{ type: "text", text: "hello" }]);
	});

	it("renders {text} as one block and {text,warning} as two blocks", () => {
		expect(renderTextWarning({ text: "body" })).toEqual([{ type: "text", text: "body" }]);
		expect(renderTextWarning({ text: "body", warning: "warn" })).toEqual([
			{ type: "text", text: "body" },
			{ type: "text", text: "warn" },
		]);
	});

	it("read and str_replace_editor output.render agree (read-vs-view parity)", () => {
		const io = localIO();
		const read = buildReadTool(io) as unknown as {
			output: { render: (a: unknown, v: unknown) => unknown };
		};
		const editor = buildStrReplaceEditorTool(io) as unknown as {
			output: { render: (a: unknown, v: unknown) => unknown };
		};
		for (const value of [
			"bare",
			{ text: "body" },
			{ text: "body", warning: "warn" },
		] as const) {
			const expected = renderTextWarning(value);
			expect(read.output.render({}, value)).toEqual(expected);
			expect(editor.output.render({}, value)).toEqual(expected);
		}
	});
});
