import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import iconv from "iconv-lite";
import { localIO, clearAutoGuessFooter, clearEncodingState } from "../../src/fs-bridge.js";
import { _resetConfigCache } from "../../src/store-config.js";
import { buildReadTool } from "../../src/tool-read.js";
import { makeExec } from "../support/fixtures.js";

async function readViaTool(io: ReturnType<typeof localIO>, cwd: string, path: string, encoding?: string) {
	const tool = buildReadTool(io);
	const exec = makeExec(cwd, "test-session")({ path, encoding }) as any;
	const result = (await tool.execute({ path, ...(encoding ? { encoding } : {}) }, exec)) as unknown;
	return { result, tool };
}

describe("read tool — encoding integration (replaces manual dsh paste)", () => {
	let dir: string;
	let cwd: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "read-tool-enc-"));
		cwd = dir;
		clearEncodingState();
		clearAutoGuessFooter();
		_resetConfigCache();
		delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
		clearAutoGuessFooter();
		clearEncodingState();
		delete process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING;
		_resetConfigCache();
	});

	it("autoGuess=true: sjis without encoding decodes and warning is second ContentBlock (not hashed)", async () => {
		const p = join(dir, "sjis.txt");
		await writeFile(p, iconv.encode("こんにちは世界\n二行目", "shift_jis"));
		process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
		_resetConfigCache();

		const io = localIO();
		const { result, tool } = await readViaTool(io, cwd, p);
		expect(typeof result).toBe("object");
		const r = result as { text: string; warning?: string };
		expect(r.text).toContain("こんにちは世界");
		expect(r.text).toContain("│"); // hash-anchored
		expect(r.text).not.toContain("Auto-guessed");
		expect(r.warning).toBeDefined();
		expect(r.warning).toContain("Auto-guessed");
		// render splits into two blocks
		const blocks = (tool as any).output.render({ path: p }, result);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].text).toBe(r.text);
		expect(blocks[1].text).toBe(r.warning);
		expect(blocks[0].text).not.toContain("Auto-guessed");
	});

	it("explicit encoding: shift_jis decodes without warning", async () => {
		const p = join(dir, "sjis2.txt");
		await writeFile(p, iconv.encode("こんにちは世界", "shift_jis"));
		process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
		_resetConfigCache();

		const io = localIO();
		const { result, tool } = await readViaTool(io, cwd, p, "shift_jis");
		const r = result as { text: string; warning?: string };
		// explicit path always returns object {text} (no warning), even with autoGuess true
		expect(r.text).toContain("こんにちは世界");
		expect(r.warning).toBeUndefined();
		const blocks = (tool as any).output.render({ path: p }, result);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).not.toContain("Auto-guessed");
	});

	it("autoGuess=false: gbk without encoding returns raw utf-8 with U+FFFD (no Top-3 throw for localIO)", async () => {
		const p = join(dir, "gbk.txt");
		await writeFile(p, iconv.encode("你好世界", "gbk"));
		process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "false";
		_resetConfigCache();

		const io = localIO();
		const { result } = await readViaTool(io, cwd, p);
		const r = result as { text: string; warning?: string };
		// localIO with autoGuess off falls back to readFile utf-8 → contains U+FFFD, no warning
		expect(r.text).toContain("\uFFFD");
		expect(r.warning).toBeUndefined();
		// Top-3 via E_NOT_TEXT is the ctxFsIO (DSH web) path; localIO never throws E_NOT_TEXT for this case
	});

	it("autoGuess=true: gbk without encoding decodes and warning second block", async () => {
		const p = join(dir, "gbk2.txt");
		await writeFile(p, iconv.encode("你好世界 hello", "gbk"));
		process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
		_resetConfigCache();

		const io = localIO();
		const { result, tool } = await readViaTool(io, cwd, p);
		const r = result as { text: string; warning?: string };
		expect(r.text).not.toContain("\uFFFD");
		expect(r.warning).toBeDefined();
		const blocks = (tool as any).output.render({ path: p }, result);
		expect(blocks).toHaveLength(2);
	});

	it("explicit cp1251 decodes without warning even with autoGuess=true", async () => {
		const p = join(dir, "cp.txt");
		await writeFile(p, iconv.encode("Привет мир", "windows-1251"));
		process.env.DSH_BETTER_EDIT_AUTO_GUESS_ENCODING = "true";
		_resetConfigCache();

		const io = localIO();
		const { result, tool } = await readViaTool(io, cwd, p, "windows-1251");
		const r = result as { text: string; warning?: string };
		expect(r.text).toContain("Привет");
		expect(r.warning).toBeUndefined();
		const blocks = (tool as any).output.render({ path: p }, result);
		expect(blocks).toHaveLength(1);
	});
});
