import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import { join } from "node:path";
import { loadFileKindAndText } from "../../src/file-kind.js";
import { withTempFile } from "../support/fixtures.js";

describe("loadFileKindAndText", () => {
	it("reads a text file and returns its content", async () => {
		await withTempFile("sample.txt", "hello\nworld\n", async ({ cwd }) => {
			const result = await loadFileKindAndText(join(cwd, "sample.txt"));
			expect(result.kind).toBe("text");
			if (result.kind === "text") {
				expect(result.text).toBe("hello\nworld\n");
				expect(result.hadUtf8DecodeErrors).toBeUndefined();
			}
		});
	});

	it("returns empty text for an empty file", async () => {
		await withTempFile("empty.txt", "", async ({ cwd }) => {
			const result = await loadFileKindAndText(join(cwd, "empty.txt"));
			expect(result.kind).toBe("text");
			if (result.kind === "text") {
				expect(result.text).toBe("");
			}
		});
	});

	it("detects a directory", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const dirPath = join(cwd, "subdir");
			await mkdir(dirPath);
			const result = await loadFileKindAndText(dirPath);
			expect(result.kind).toBe("directory");
		});
	});

	it("allows null bytes in text content (valid in JS string literals)", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const binPath = join(cwd, "binary.bin");
			await writeFile(binPath, Buffer.from([0x48, 0x00, 0x65, 0x6c, 0x6c, 0x6f]));
			const result = await loadFileKindAndText(binPath);
			expect(result.kind).toBe("text");
		});
	});

	it("detects non-UTF-8 bytes and flags hadUtf8DecodeErrors", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const legacyPath = join(cwd, "legacy.bin");
			await writeFile(legacyPath, Buffer.from([0x61, 0x62, 0x63, 0x80, 0x81]));
			const result2 = await loadFileKindAndText(legacyPath);
			expect(result2.kind).toBe("text");
			if (result2.kind === "text") {
				expect(result2.hadUtf8DecodeErrors).toBe(true);
			}
		});
	});

	it("rejects UTF-16LE with BOM as binary", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const path = join(cwd, "utf16le.txt");
			await writeFile(path, Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]));
			const result = await loadFileKindAndText(path);
			expect(result.kind).toBe("binary");
			if (result.kind === "binary") {
				expect(result.description).toContain("UTF-16LE");
			}
		});
	});

	it("rejects UTF-16BE with BOM as binary", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const path = join(cwd, "utf16be.txt");
			await writeFile(path, Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]));
			const result = await loadFileKindAndText(path);
			expect(result.kind).toBe("binary");
			if (result.kind === "binary") {
				expect(result.description).toContain("UTF-16BE");
			}
		});
	});

	it("rejects UTF-32LE with BOM as binary", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const path = join(cwd, "utf32le.txt");
			await writeFile(path, Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x68, 0x00, 0x00, 0x00]));
			const result = await loadFileKindAndText(path);
			expect(result.kind).toBe("binary");
			if (result.kind === "binary") {
				expect(result.description).toContain("UTF-32LE");
			}
		});
	});

	it("rejects UTF-32BE with BOM as binary", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const path = join(cwd, "utf32be.txt");
			await writeFile(path, Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x68]));
			const result = await loadFileKindAndText(path);
			expect(result.kind).toBe("binary");
			if (result.kind === "binary") {
				expect(result.description).toContain("UTF-32BE");
			}
		});
	});
});


describe("loadFileKindAndText — maxLines early bailout", () => {
  it("rejects files exceeding maxLines during decode", async () => {
    await withTempFile("many-lines.txt", Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n"), async ({ cwd }) => {
      const path = join(cwd, "many-lines.txt");
      await expect(
        loadFileKindAndText(path, { maxLines: 5 }),
      ).rejects.toThrow(/\[E_LARGE_FILE\].*more than 5 lines/);
    });
  });

  it("uses displayPath in the error message when provided", async () => {
    await withTempFile("many-lines.txt", Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n"), async ({ cwd }) => {
      const path = join(cwd, "many-lines.txt");
      await expect(
        loadFileKindAndText(path, { maxLines: 5, displayPath: "many-lines.txt" }),
      ).rejects.toThrow(/\[E_LARGE_FILE\] many-lines\.txt/);
    });
  });

  it("accepts files at the boundary", async () => {
    await withTempFile("ok-lines.txt", Array.from({ length: 5 }, (_, i) => `line${i}`).join("\n"), async ({ cwd }) => {
      const path = join(cwd, "ok-lines.txt");
      const result = await loadFileKindAndText(path, { maxLines: 5 });
      expect(result.kind).toBe("text");
    });
  });

  it("counts CRLF line endings towards the limit", async () => {
    await withTempFile("crlf-lines.txt", "a", async ({ path }) => {
      const { writeFile } = await import("fs/promises");
      await writeFile(path, Array.from({ length: 8 }, (_, i) => `line${i}`).join("\r\n"), "utf-8");
      await expect(
        loadFileKindAndText(path, { maxLines: 5 }),
      ).rejects.toThrow(/\[E_LARGE_FILE\]/);
    });
  });

  it("is a no-op when maxLines is omitted", async () => {
    await withTempFile("plain-lines.txt", Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n"), async ({ cwd }) => {
      const result = await loadFileKindAndText(join(cwd, "plain-lines.txt"));
      expect(result.kind).toBe("text");
    });
  });
});
