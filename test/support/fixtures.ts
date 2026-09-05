/**
 * Test fixtures for dsh-better-edit. The tools are driven through the same
 * builders the plugin registers, over a local-filesystem IO bridge, with a
 * fake dsh {@link ToolExecution} carrying the session cwd and a stable test
 * session key. `withTempFile`/`withTempDir` isolate the hash store (and undo
 * history) under a temp home so tests never touch the developer's real
 * `~/.dsh`.
 * @module dsh-better-edit/test-fixtures
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, afterAll, vi } from "vitest";
import type { ToolExecution, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { initHasher } from "../../src/hashline/index.js";
import { shutdownHashStore } from "../../src/hash-store.js";
import { localIO, type FileIO } from "../../src/fs-bridge.js";
import { buildEditTool } from "../../src/tool-edit.js";
import { buildReadTool } from "../../src/tool-read.js";
// batch_edit removed (ADR-0007) — shim via edit tuples for test compatibility
import { buildUndoTool } from "../../src/tool-undo.js";
import { FsSandboxController } from "../../src/sandbox.js";

export async function getWritableTempRoot(): Promise<string> {
	const fallback = join(process.cwd(), ".tmp");
	await mkdir(fallback, { recursive: true });
	return fallback;
}

export async function setupTestHome(): Promise<{
	home: string;
	testPath: string;
	cleanup: () => Promise<void>;
}> {
	await initHasher();
	const tmpHome = await mkdtemp(join(await getWritableTempRoot(), "testhome-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
	const testPath = join(tmpHome, "test.txt");
	return {
		home: tmpHome,
		testPath,
		cleanup: async () => {
			shutdownHashStore();
			vi.unstubAllEnvs();
			await rm(tmpHome, { recursive: true, force: true });
		},
	};
}

export function useTestHome(): { testPath: string } {
	const state: { testPath: string } = { testPath: "" };
	let cleanup: (() => Promise<void>) | undefined;

	beforeAll(async () => {
		const s = await setupTestHome();
		state.testPath = s.testPath;
		cleanup = s.cleanup;
	});

	afterAll(async () => {
		await cleanup?.();
	});

	return state;
}

export function withHome(home: string | undefined): () => void {
	const previousHome = process.env.HOME;
	const previousDsh = process.env.DSH_HOME;
	if (home === undefined) delete process.env.HOME;
	else process.env.HOME = home;
	if (home === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = join(home, ".dsh");
	return () => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousDsh === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousDsh;
	};
}

async function freshCwd(): Promise<{ cwd: string; restoreHome: () => void }> {
	const cwd = await mkdtemp(
		join(await getWritableTempRoot(), "dsh-hashline-test-"),
	);
	return { cwd, restoreHome: withHome(cwd) };
}

export async function withTempFile(
	name: string,
	content: string,
	run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
	const { cwd, restoreHome } = await freshCwd();
	const path = join(cwd, name);
	try {
		await writeFile(path, content, "utf-8");
		await run({ cwd, path });
	} finally {
		shutdownHashStore();
		await rm(cwd, { recursive: true, force: true });
		restoreHome();
	}
}

export async function withTempBytes(
	name: string,
	bytes: Uint8Array,
	run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
	const { cwd, restoreHome } = await freshCwd();
	const path = join(cwd, name);
	try {
		await writeFile(path, bytes);
		await run({ cwd, path });
	} finally {
		shutdownHashStore();
		await rm(cwd, { recursive: true, force: true });
		restoreHome();
	}
}

export async function withTempSubdir(
	name: string,
	run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
	const { cwd, restoreHome } = await freshCwd();
	const path = join(cwd, name);
	try {
		await mkdir(path, { recursive: true });
		await run({ cwd, path });
	} finally {
		shutdownHashStore();
		await rm(cwd, { recursive: true, force: true });
		restoreHome();
	}
}

export async function withTempDir(
	prefix: string,
	run: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(await getWritableTempRoot(), prefix));
	const restoreHome = withHome(dir);
	try {
		await run(dir);
	} finally {
		shutdownHashStore();
		await rm(dir, { recursive: true, force: true });
		restoreHome();
	}
}

export async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(await getWritableTempRoot(), prefix));
	process.env.HOME = dir;
	process.env.DSH_HOME = join(dir, ".dsh");
	return dir;
}

/** A fake dsh tool-execution for the current test cwd and session. */
export function makeExec(
	cwd: string,
	sessionKey = "test-session",
): (args: unknown) => ToolExecution {
	return (args: unknown) =>
		({
			signal: new AbortController().signal,
			agent: {
				id: sessionKey,
				session: { id: sessionKey, header: { cwd } },
			},
			arguments: args,
		}) as unknown as ToolExecution;
}

/** pi-hashline-compatible wrapper: execute(id, params, signal, onUpdate, ctx) → { content } */
function wrapTool(
	tool: { execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> },
	makeExecFor: (args: unknown) => unknown,
): {
	execute(
		_callId: string,
		params: unknown,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		_ctx?: unknown,
	): Promise<{
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
		details?: Record<string, unknown>;
	}>;
} {
	return {
		async execute(_callId, params) {
			const result = await tool.execute(params, makeExecFor(params)) as unknown;
			if (typeof result === "string") return { content: [{ type: "text", text: result }] };
			if (result && typeof result === "object" && "text" in (result as Record<string, unknown>)) {
				const r = result as { text: string; warning?: string };
				const blocks: Array<{ type: "text"; text: string }> = [{ type: "text", text: r.text }];
				if (r.warning) blocks.push({ type: "text", text: r.warning });
				return { content: blocks };
			}
			return { content: [{ type: "text", text: String(result) }] };
		},
	};
}

/**
 * A sandbox controller for tests: no confining backend, so no escalation
 * fields are advertised and `resolvePolicy` returns undefined (unconfined).
 */
function makeTestSandbox() {
	return new FsSandboxController({
		fs: { sandboxMode: undefined },
		get: () => undefined,
	} as never);
}

/** Drive the dsh tool builders end-to-end over a temp cwd, with a stable session key. */
export function setupIntegrationTest(cwd: string, io: FileIO = localIO()) {
	const sessionKey = "test-session";
	const makeExecFor = makeExec(cwd, sessionKey);
	const sandbox = makeTestSandbox();
	const editTool = buildEditTool(io, sandbox);
	function wrapEdit(tool: ReturnType<typeof buildEditTool>) {
		const base = wrapTool(tool, makeExecFor);
		return {
			async execute(_callId: string, params: unknown) {
				const rec = params as Record<string, unknown>;
				if (rec && "edits" in rec) {
					return (base as any).execute(_callId, params);
				}
				// old shape {path, remove_from,...} → {path, edits:[[h,h,t]]}
				if (rec && typeof rec.remove_from === "string") {
					const converted = {
						path: (rec.path ?? (rec as any).file_path ?? null) as string | null,
						edits: [[rec.remove_from, rec.remove_to, rec.replacement_text]],
					};
					return (base as any).execute(_callId, converted);
				}
				return (base as any).execute(_callId, params);
			},
		} as unknown as ReturnType<typeof wrapTool>;
	}
	const tools = {
		read: wrapTool(buildReadTool(io), makeExecFor),
		edit: wrapEdit(editTool),
		batch_edit: {
			async execute(_callId: string, params: unknown) {
				const rec = params as { edits?: Array<{ path?: string; file_path?: string; remove_from: string; remove_to: string; replacement_text: string }> };
				const edits = rec.edits ?? [];
				if (edits.length === 0) throw new Error("[E_BAD_PAYLOAD] batch_edit shim: edits empty");
				const path = (edits[0] as any).path ?? (edits[0] as any).file_path ?? null;
				// verify all same file (new edit is single-file)
				for (const e of edits) {
					const ep = (e as any).path ?? (e as any).file_path ?? path;
					if (ep !== path) throw new Error("[E_BAD_PAYLOAD] batch_edit shim: cross-file batches removed — use one edit call per file");
				}
				const tuples = edits.map(e => [e.remove_from, e.remove_to, e.replacement_text] as [string,string,string]);
				const text = await editTool.execute({ path, edits: tuples } as unknown as never, { signal: new AbortController().signal, agent: { id: sessionKey, session: { id: sessionKey, header: { cwd } } } } as unknown as never);
				return { content: [{ type: "text", text: String(text) }] };
			},
		} as unknown as ReturnType<typeof wrapTool>,
		undo_last_edit: wrapTool(buildUndoTool(io, sandbox), makeExecFor),
	};
	return {
		io,
		sessionKey,
		makeExecFor,
		ctx: { cwd } as unknown,
		getTool: (name: string) => (tools as Record<string, unknown>)[name],
		readTool: tools.read,
		editTool: tools.edit,
	};
}

/** Read-only harness: just the hashline `read` tool. */
export function setupReadTest(cwd: string) {
	const io: FileIO = localIO();
	const sessionKey = "test-session";
	const makeExecFor = makeExec(cwd, sessionKey);
	return {
		io,
		sessionKey,
		ctx: { cwd } as unknown,
		readTool: wrapTool(buildReadTool(io), makeExecFor),
	};
}

export function getText(result: { content: Array<{ text?: string }> }): string {
	return result.content[0]?.text ?? "";
}

export function extractHash(line: string): string {
	return line.split("│")[0]!;
}

export function expectedEditContent(
	lines: string[],
	s: number,
	e: number,
	repl: string[],
	trailingNewline: boolean,
): string {
	const expected = [...lines.slice(0, s - 1), ...repl, ...lines.slice(e)].join(
		"\n",
	);
	if (trailingNewline) return expected + "\n";
	if (
		e === lines.length &&
		repl.length === 0 &&
		s >= 2 &&
		lines[s - 2]!.length === 0
	) {
		return expected + "\n";
	}
	return expected;
}

export async function makeTag(
	content: string,
	line: number,
	path: string,
): Promise<{ hash: string }> {
	const { lineHashes } = await import("../../src/hashline/index.js");
	const hashes = await lineHashes(content, path);
	return { hash: hashes[line - 1]! };
}
