import { describe, expect, it } from "vitest";
import { lineHashes, resEdit, applyEdit } from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("indentation difference — no boundary auto-fix (removed)", () => {
  it("keeps leading duplication (no auto-fix) when indentation matches exactly", async () => {
    const file = "  foo\nbar\n  baz";
    const hashes = await lineHashes(file, home.testPath);
    const result = applyEdit(file, resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "  foo\n  bar" },
    ));
    expect(result.content).toBe("  foo\n  foo\n  bar\n  baz");
    expect(result.autoFixes ?? []).toHaveLength(0);
  });

  it("keeps leading duplication (no auto-fix) when both indentation and content match", async () => {
    const file = "  foo\n  bar\n  baz";
    const hashes = await lineHashes(file, home.testPath);
    const result = applyEdit(file, resEdit(
      { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "  foo\n  new" },
    ));
    expect(result.content).toBe("  foo\n  foo\n  new\n  baz");
    expect(result.autoFixes ?? []).toHaveLength(0);
  });
});
