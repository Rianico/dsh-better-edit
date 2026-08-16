import { describe, expect, it } from "vitest";
import { resolveTarget } from "../../src/paths.js";
import { writeAtomic } from "../../src/fs-write.js";
import {
	mkdtemp,
	writeFile,
	rm,
	readFile,
	symlink,
	realpath,
} from "fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWindows = process.platform === "win32";

describe("resolveTarget", () => {
	it("resolves a simple path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-hashline-resolve-"));
		try {
			const filePath = join(dir, "test.txt");
			await writeFile(filePath, "hello", "utf-8");
			const resolved = await resolveTarget(filePath);
			expect(resolved).toBe(await realpath(filePath));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(isWindows)("resolves a symlink to its target", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-hashline-resolve-"));
		try {
			const target = join(dir, "target.txt");
			const link = join(dir, "link.txt");
			await writeFile(target, "hello", "utf-8");
			await symlink("target.txt", link);
			const resolved = await resolveTarget(link);
			expect(resolved).toBe(await realpath(target));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(isWindows)(
		"resolves a path through multiple symlink levels",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "pi-hashline-resolve-"));
			try {
				const target = join(dir, "real.txt");
				const mid = join(dir, "mid.txt");
				const link = join(dir, "link.txt");
				await writeFile(target, "hello", "utf-8");
				await symlink("real.txt", mid);
				await symlink("mid.txt", link);
				const resolved = await resolveTarget(link);
				expect(resolved).toBe(await realpath(target));
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	);

	it("resolves a path with non-existent final component", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-hashline-resolve-"));
		try {
			const nonExistent = join(dir, "nonexistent", "file.txt");
			const resolved = await resolveTarget(nonExistent);
			expect(resolved).toBe(
				join(await realpath(dir), "nonexistent", "file.txt"),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("writeAtomic", () => {
	it("writes content to a new file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-hashline-write-"));
		try {
			const filePath = join(dir, "new.txt");
			await writeAtomic(filePath, "hello world");
			const content = await readFile(filePath, "utf-8");
			expect(content).toBe("hello world");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("overwrites an existing file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-hashline-write-"));
		try {
			const filePath = join(dir, "existing.txt");
			await writeFile(filePath, "old content", "utf-8");
			await writeAtomic(filePath, "new content");
			const content = await readFile(filePath, "utf-8");
			expect(content).toBe("new content");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(isWindows)("writes through a symlink to the target", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-hashline-write-"));
		try {
			const target = join(dir, "target.txt");
			const link = join(dir, "link.txt");
			await writeFile(target, "original", "utf-8");
			await symlink("target.txt", link);
			await writeAtomic(link, "via symlink");
			const content = await readFile(target, "utf-8");
			expect(content).toBe("via symlink");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves file permissions on overwrite", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-hashline-write-"));
		try {
			const filePath = join(dir, "perms.txt");
			await writeFile(filePath, "original", { mode: 0o644 });
			await writeAtomic(filePath, "updated");
			const content = await readFile(filePath, "utf-8");
			expect(content).toBe("updated");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
