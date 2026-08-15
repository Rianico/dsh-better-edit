/**
 * Regression tests for the per-workspace store: every tool call resolves the
 * store at `<workspace>/.dsh_better_edit/` (the workspace being the session
 * cwd carried by `withWorkspace`), and parallel workspaces keep separate
 * stores — snapshots, served rows, and undo history never leak between them.
 * @module dsh-better-edit/workspace-store.test
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withWorkspace, workspaceCwd } from "../../src/workspace.js";
import { hashStorePath } from "../../src/paths.js";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store.js";
import { getSnapshot } from "../../src/snapshot-store.js";
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

	it("resolves the store file under <workspace>/.dsh_better_edit", async () => {
		const cwd = tempWorkspace("dsh-ws-path-");
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
			shutdownHashStore();
			rmSync(cwd, { recursive: true, force: true });
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
					getSnapshot(store, join(a, "f.txt"), content, false),
				).toBeUndefined();
			});

			// Workspace A still sees it.
			await withWorkspace(a, async () => {
				const store = await loadHashStore();
				expect(
					getSnapshot(store, join(a, "f.txt"), content, false),
				).toBeDefined();
			});
		} finally {
			shutdownHashStore();
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});
});
