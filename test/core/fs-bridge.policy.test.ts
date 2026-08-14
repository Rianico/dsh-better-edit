/**
 * Regression tests for the `fs/*` event-gate contract on {@link ctxFsIO}: the
 * hashline tools must dispatch `fs/write-intent` before writing and emit
 * `fs/observed` after reads/writes, exactly like the built-in tools — a
 * hashline tool that skipped them would leave the observation policy's version
 * stale and the next built-in write on the file would fail.
 * @module dsh-better-edit/fs-bridge.policy.test
 */

import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { ctxFsIO, type FileIO } from "../../src/fs-bridge.js";

/** A mock `ctx.fs` recording every call and returning scripted results. */
function makeFs(overrides: Partial<Record<string, unknown>> = {}) {
	const calls: string[] = [];
	const fs = {
		resolve: vi.fn(async () => ({
			targetKey: "tk-1",
			displayPath: "/abs/file.txt",
		})),
		processPath: vi.fn(() => "/abs/file.txt"),
		readText: vi.fn(async () => "hello\n"),
		writeText: vi.fn(async () => ({
			version: "v2",
			operation: "update",
			before: "a",
			after: "b",
		})),
		stat: vi.fn(async () => ({ version: "v1" })),
		...overrides,
	};
	return {
		fs,
		calls,
		record(name: string) {
			calls.push(name);
		},
	};
}

/** A mock Cordis context capturing waterfall/emit dispatches. */
function makeCtx() {
	const events: Array<{
		kind: "waterfall" | "emit";
		name: string;
		args: unknown[];
	}> = [];
	const ctx = {
		waterfall: vi.fn(async (name: string, ...args: unknown[]) => {
			events.push({ kind: "waterfall", name, args });
			// The single-slot default: the listener "decides" — simulate a
			// policy returning a version-guarded write intent.
			return { kind: "replaceIfVersion", version: "v1" };
		}),
		emit: vi.fn((name: string, ...args: unknown[]) => {
			events.push({ kind: "emit", name, args });
		}),
	} as unknown as Context;
	return { ctx, events };
}

const exec = { agent: { session: { id: "sess-1" } } } as never;

describe("ctxFsIO writeText", () => {
	it("dispatches fs/write-intent with (target, exec, default) and passes the returned intent to writeText", async () => {
		const { fs } = makeFs();
		const { ctx, events } = makeCtx();
		const io: FileIO = ctxFsIO(fs as never, ctx);

		await io.writeText("/abs/file.txt", "content", undefined, exec);

		const waterfall = events.find(
			(e) => e.kind === "waterfall" && e.name === "fs/write-intent",
		);
		expect(waterfall).toBeTruthy();
		const [target, actor, fallback] = waterfall!.args as [
			unknown,
			unknown,
			unknown,
		];
		expect(target).toMatchObject({ targetKey: "tk-1" });
		expect(actor).toBe(exec);
		expect(typeof fallback).toBe("function");

		expect(fs.writeText).toHaveBeenCalledWith(
			expect.objectContaining({ targetKey: "tk-1" }),
			"content",
			{ kind: "replaceIfVersion", version: "v1" },
			undefined,
		);
	});

	it("emits fs/observed present with the outcome version after a successful write", async () => {
		const { fs } = makeFs();
		const { ctx, events } = makeCtx();
		const io: FileIO = ctxFsIO(fs as never, ctx);

		await io.writeText("/abs/file.txt", "content", undefined, exec);

		const observed = events.find(
			(e) => e.kind === "emit" && e.name === "fs/observed",
		);
		expect(observed).toBeTruthy();
		const [target, observation, actor] = observed!.args as [
			unknown,
			unknown,
			unknown,
		];
		expect(target).toMatchObject({ targetKey: "tk-1" });
		expect(observation).toEqual({ kind: "present", version: "v2" });
		expect(actor).toBe(exec);
	});

	it("uses the bare default (unconditional write) when no policy listener produces an intent", async () => {
		const { fs } = makeFs();
		const { ctx } = makeCtx();
		(ctx.waterfall as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		const io: FileIO = ctxFsIO(fs as never, ctx);

		await io.writeText("/abs/file.txt", "content");

		expect(fs.writeText).toHaveBeenCalledWith(
			expect.objectContaining({ targetKey: "tk-1" }),
			"content",
			undefined,
			undefined,
		);
	});

	it("maps FS_STALE_VERSION onto the hashline E_RANGE_STALE vocabulary", async () => {
		const stale = Object.assign(new Error("stale"), {
			code: "FS_STALE_VERSION",
		});
		const { fs } = makeFs({
			writeText: vi.fn(async () => {
				throw stale;
			}),
		});
		const { ctx } = makeCtx();
		const io: FileIO = ctxFsIO(fs as never, ctx);

		await expect(io.writeText("/abs/file.txt", "x")).rejects.toThrow(
			"[E_RANGE_STALE]",
		);
	});
});

describe("ctxFsIO emitObserved", () => {
	it("stats the target and emits fs/observed present at the current version", async () => {
		const { fs } = makeFs();
		const { ctx, events } = makeCtx();
		const io: FileIO = ctxFsIO(fs as never, ctx);

		await io.emitObserved("/abs/file.txt", exec);

		expect(fs.stat).toHaveBeenCalledWith(
			expect.objectContaining({ targetKey: "tk-1" }),
			undefined,
		);
		const observed = events.find(
			(e) => e.kind === "emit" && e.name === "fs/observed",
		);
		expect(observed).toBeTruthy();
		expect(observed!.args[0]).toMatchObject({ targetKey: "tk-1" });
		expect(observed!.args[1]).toEqual({ kind: "present", version: "v1" });
		expect(observed!.args[2]).toBe(exec);
	});

	it("never throws when the target is gone (a failed observation must not fail the read)", async () => {
		const missing = Object.assign(new Error("gone"), { code: "FS_NOT_FOUND" });
		const { fs } = makeFs({
			stat: vi.fn(async () => {
				throw missing;
			}),
		});
		const { ctx } = makeCtx();
		const io: FileIO = ctxFsIO(fs as never, ctx);

		await expect(
			io.emitObserved("/abs/gone.txt", exec),
		).resolves.toBeUndefined();
	});
});
