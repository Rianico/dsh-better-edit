/**
 * Regression tests for the per-workspace store: every tool call resolves the
 * store at `<workspace>/.dsh_better_edit/` (the workspace being the session
 * cwd carried by `withWorkspace`), and parallel workspaces keep separate
 * stores — snapshots, served rows, and undo history never leak between them.
 * @module dsh-better-edit/workspace-store.test
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withWorkspace, workspaceCwd } from "../../src/workspace.js";
import { hashStorePath } from "../../src/paths.js";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store.js";
import { recordServed, loadServed } from "../../src/served-store.js";
import { lineHashes } from "../../src/hashline/index.js";
import { initHasher } from "../../src/hashline/hasher.js";

function tempWorkspace(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("workspace context", () => {
	it("carries the workspace cwd through the async execution", async () => {
		const cwd = tempWorkspace("dsh-ws-ctx-");
		try {
			let seen: string | undefined;
			await withWorkspace(cwd, async () => {
				seen = workspaceCwd();
			});
			expect(seen).toBe(cwd);
			// outside the context there is no workspace
			expect(workspaceCwd()).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("resolves the store file under <workspace>/.dsh_better_edit when storeDir=workspace", async () => {
		const cwd = tempWorkspace("dsh-ws-path-");
		const prevStore = process.env.DSH_BETTER_EDIT_STORE_DIR;
		process.env.DSH_BETTER_EDIT_STORE_DIR = "workspace";
		const { _resetConfigCache } = await import("../../src/paths.js");
		_resetConfigCache();
		try {
			expect(hashStorePath(cwd)).toBe(
				join(cwd, ".dsh_better_edit", "hash-store.sqlite"),
			);
			await withWorkspace(cwd, async () => {
				await loadHashStore();
			});
			expect(
				existsSync(join(cwd, ".dsh_better_edit", "hash-store.sqlite")),
			).toBe(true);
		} finally {
			if (prevStore === undefined) delete process.env.DSH_BETTER_EDIT_STORE_DIR;
			else process.env.DSH_BETTER_EDIT_STORE_DIR = prevStore;
			const { _resetConfigCache: r } = await import("../../src/paths.js");
			r();
			shutdownHashStore();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("resolves the store file under central runtime/<name>-<hash8> by default", async () => {
		const cwd = tempWorkspace("dsh-ws-path-");
		const prevStore = process.env.DSH_BETTER_EDIT_STORE_DIR;
		delete process.env.DSH_BETTER_EDIT_STORE_DIR;
		const { _resetConfigCache, hashStorePath: hsp } = await import("../../src/paths.js");
		_resetConfigCache();
		const prevDsh = process.env.DSH_HOME;
		const tmpHome = mkdtempSync(join(tmpdir(), "dsh-home-"));
		process.env.DSH_HOME = tmpHome;
		try {
			const p = hsp(cwd);
			expect(p).toContain(join("runtime"));
			expect(p.endsWith("hash-store.sqlite")).toBe(true);
			await withWorkspace(cwd, async () => {
				await loadHashStore();
			});
			expect(existsSync(p)).toBe(true);
		} finally {
			if (prevStore === undefined) delete process.env.DSH_BETTER_EDIT_STORE_DIR;
			else process.env.DSH_BETTER_EDIT_STORE_DIR = prevStore;
			if (prevDsh === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = prevDsh;
			const { _resetConfigCache: r } = await import("../../src/paths.js");
			r();
			shutdownHashStore();
			rmSync(cwd, { recursive: true, force: true });
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});

describe("workspace isolation", () => {
	it("keeps snapshots in separate stores per workspace", async () => {
		await initHasher();
		const a = tempWorkspace("dsh-ws-a-");
		const b = tempWorkspace("dsh-ws-b-");
		const content = "one\ntwo\nthree\n";
		try {
			// Write a snapshot in workspace A only (lineHashes persists it
			// keyed by path + real checksum).
			await withWorkspace(a, async () => {
				await lineHashes(content, join(a, "f.txt"));
			});

			// Workspace B must NOT see A's snapshot (separate store file).
			await withWorkspace(b, async () => {
				const store = await loadHashStore();
				expect(
					store.getSnapshot(join(a, "f.txt"), content, false),
				).toBeUndefined();
			});

			// Workspace A still sees it.
			await withWorkspace(a, async () => {
				const store = await loadHashStore();
				expect(
					store.getSnapshot(join(a, "f.txt"), content, false),
				).toBeDefined();
			});
		} finally {
			shutdownHashStore();
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});
});

describe("stale served tail (regression)", () => {
	it("truncates the served array to the current line count on a whole-file serve, so a surviving hash never claims two positions", async () => {
		await initHasher();
		const ws = tempWorkspace("dsh-ws-tail-");
		const path = join(ws, "f.txt");
		const session = "sess-tail";
		try {
			// Serve an 8-line file (a full read), then a 2-line file (the
			// write auto-read). Before the fix the second serve left the stale
			// positions 2..7 in the array, so the surviving "c" line's hash
			// appeared at BOTH its old position 2 and its new position 1 —
			// and any edit targeting it failed E_RANGE_UNVERIFIED.
			await withWorkspace(ws, async () => {
				const big = "a\nb\nc\nd\ne\nf\ng\nh\n";
				writeFileSync(path, big);
				const bigHashes = await lineHashes(big, path);
				await recordServed(
					session,
					path,
					bigHashes.map((h, i) => ({ position: i, hash: h })),
					bigHashes.length,
				);

				const small = "b\nc\n";
				writeFileSync(path, small);
				const smallHashes = await lineHashes(small, path);
				await recordServed(
					session,
					path,
					smallHashes.map((h, i) => ({ position: i, hash: h })),
					smallHashes.length,
				);

				const served = await loadServed(session, path);
				expect(served.length).toBe(smallHashes.length);
				const counts = new Map<string, number>();
				for (const h of served) {
					if (h === null) continue;
					counts.set(h, (counts.get(h) ?? 0) + 1);
				}
				expect([...counts.values()].every((c) => c === 1)).toBe(true);
			});
		} finally {
			shutdownHashStore();
			rmSync(ws, { recursive: true, force: true });
		}
	});
});
