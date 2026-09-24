import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canon,
  lineHashesPure,
  ServedRejectionError,
  verifyServedRange,
  type LeaseSpanSource,
} from "../../src/hashline/index.js";
import { initHasher } from "../../src/hashline/hasher.js";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store.js";
import { execPipeline } from "../../src/mutation.js";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import { codeOf } from "../../src/utils.js";
import { extractHash, getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";

beforeAll(async () => {
  await initHasher();
});

async function getWritableTempRoot(): Promise<string> {
  const fallback = join(process.cwd(), ".tmp");
  await mkdir(fallback, { recursive: true });
  return fallback;
}

const LINES = Array.from({ length: 10 }, (_, i) => `line ${i}`);
const CONTENT = LINES.join("\n") + "\n";

/** The served span shifted down: a line above it was inserted out of band. */
const INSERT_ABOVE = `prepended\n${CONTENT}`;
/** The served span shifted up: the line above it was deleted out of band. */
const DELETE_ABOVE = `gone\n${CONTENT}`;

function anchorOfRendered(text: string, line: string): string {
  return extractHash(
    getText(text)
      .split("\n")
      .find((row) => row.endsWith(`│${line}`))!,
  );
}

/** Rejection code of a thrown call, or undefined when it did not throw. */
function codeOfCall(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ServedRejectionError);
    return codeOf(error);
  }
}

describe("lease-resolve seam — identity replaces the position check (obligation (c))", () => {
  let tmpHome: string;
  beforeAll(async () => {
    tmpHome = await mkdtemp(join(await getWritableTempRoot(), "testhome-cp2-"));
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
  });
  afterAll(async () => {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("applies a benign exterior insert above the served span (rebased coordinate, no re-read)", async () => {
    await withTempFile("insert.txt", CONTENT, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const anchor = anchorOfRendered(
        await readTool.execute("read", { path: "insert.txt" }),
        "line 5",
      );

      await writeFile(path, INSERT_ABOVE, "utf-8");
      await editTool.execute("benign-insert", {
        path: "insert.txt",
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: "line 5 changed",
      });

      expect(await readFile(path, "utf-8")).toBe(
        INSERT_ABOVE.replace("line 5\n", "line 5 changed\n"),
      );
    });
  });

  it("applies a benign exterior delete above the served span", async () => {
    await withTempFile("delete.txt", DELETE_ABOVE, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const anchor = anchorOfRendered(
        await readTool.execute("read", { path: "delete.txt" }),
        "line 5",
      );

      await writeFile(path, CONTENT, "utf-8");
      await editTool.execute("benign-delete", {
        path: "delete.txt",
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: "line 5 changed",
      });

      expect(await readFile(path, "utf-8")).toBe(CONTENT.replace("line 5\n", "line 5 changed\n"));
    });
  });

  it("rejects E_UNSERVED_RANGE when the anchor was never served in this session", async () => {
    await withTempFile("never.txt", CONTENT, async ({ cwd, path }) => {
      const { editTool } = setupIntegrationTest(cwd);
      // Served to ANOTHER session: this session's mirror holds nothing for the file.
      const elsewhere = await readAndServe(localIO(), "never.txt", cwd, {
        sessionKey: "some-other-session",
      });
      const neverServed = elsewhere.served[4]!.hash;

      let error: unknown;
      try {
        await editTool.execute("never-served", {
          path: "never.txt",
          anchor_from: neverServed,
          anchor_to: neverServed,
          replace_with: "changed",
        });
      } catch (e) {
        error = e;
      }
      // Rejects as it did before the seam: the boundary anchor has no served position, so the
      // exact-boundary rule throws before the identity gate is ever reached.
      expect(error).toBeDefined();
      expect(String((error as Error).message)).toMatch(/E_UNSERVED_RANGE/);
      expect(await readFile(path, "utf-8")).toBe(CONTENT);
    });
  });

  it("keeps the position check when a preview edit carries no lease source", async () => {
    await withTempFile("preview.txt", CONTENT, async ({ cwd, path }) => {
      // Both the serve and the edit go through the ambient store (no workspace exec here), so the
      // served mirror and its leases are visible to `execPipeline`.
      const store = await loadHashStore();
      const servedRead = await readAndServe(localIO(), "preview.txt", cwd, {
        sessionKey: "test-session",
      });
      const anchor = servedRead.served[5]!.hash;
      expect(servedRead.served[5]!.position).toBe(5);

      await writeFile(path, INSERT_ABOVE, "utf-8");

      const params = {
        file: "preview.txt",
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: "line 5 changed",
      } as const;

      // Preview (noPersist) builds no lease source, so the unconditional position check runs and
      // the benign shift still rejects — the fallback is stricter, never weaker.
      await expect(
        execPipeline(localIO(), params, cwd, {
          sessionKey: "test-session",
          store,
          noPersist: true,
        }),
      ).rejects.toThrow(/E_STALE_RANGE/);
      expect(await readFile(path, "utf-8")).toBe(INSERT_ABOVE);

      // Control: the same edit with a live store DOES build the source and applies. `execPipeline`
      // computes the result without writing, so the assertion is on the returned buffer.
      const applied = await execPipeline(localIO(), params, cwd, {
        sessionKey: "test-session",
        store,
      });
      expect(applied.result).toBe(INSERT_ABOVE.replace("line 5\n", "line 5 changed\n"));
      expect(await readFile(path, "utf-8")).toBe(INSERT_ABOVE);
    });
  });
});

describe("verifyRebasedSpan — the gate's arms", () => {
  const FILE_LINES = ["alpha", "beta", "gamma", "delta"];
  const FILE_HASHES = lineHashesPure(FILE_LINES.join("\n"));
  // Served when the span sat one line lower: the line above it has since been deleted, so the
  // served positions (1, 2) and the rebased positions (1, 2) disagree by one.
  const SERVED: (string | null)[] = ["hGone", ...FILE_HASHES];
  const SERVED_CANONS = [canon("gone"), ...FILE_LINES.map((line) => canon(line))];

  function leaseSource(overrides?: {
    retired?: boolean;
    rebasedLineOf?: (lineId: number) => number | undefined;
  }): LeaseSpanSource {
    const lineIds: Record<string, number> = {
      [FILE_HASHES[0]!]: 11,
      [FILE_HASHES[1]!]: 12,
    };
    const positions = new Map([
      [11, 1],
      [12, 2],
    ]);
    return {
      currentSnapshotHash: "C",
      leaseFor: (anchor) => {
        const lineId = lineIds[anchor];
        if (lineId === undefined) return undefined;
        return {
          lineId,
          servedLineNumber: lineId - 9,
          servedSnapshotHash: "S",
          retiredAt: overrides?.retired === true ? 1 : null,
        };
      },
      rebasedLineOf: overrides?.rebasedLineOf ?? ((lineId) => positions.get(lineId)),
    };
  }

  function verify(leaseSource?: LeaseSpanSource): void {
    verifyServedRange({
      served: SERVED,
      servedCanons: SERVED_CANONS,
      startHash: FILE_HASHES[0]!,
      endHash: FILE_HASHES[1]!,
      startLine: 1,
      endLine: 2,
      fileHashes: [...FILE_HASHES],
      fileLines: [...FILE_LINES],
      ...(leaseSource === undefined ? {} : { leaseSource }),
    });
  }

  it("is opt-in: without a lease source the position check still rejects the shift", () => {
    // Falsifier: drop the `else` in `verifyServedRange`'s position check (make it run even with a
    // source) and this still passes — but the benign-shift test above goes red instead. Drop the
    // position check entirely and this assertion goes red.
    expect(codeOfCall(() => verify())).toBe("E_STALE_RANGE");
  });

  it("accepts the benign shift when the leased identity lives at the rebased coordinate", () => {
    // Falsifier: make the gate ignore `rebasedLineOf` (accept every live lease) — the look-alike
    // rebind test (test/core/deleted-twin-anchor.test.ts) goes red instead.
    expect(codeOfCall(() => verify(leaseSource()))).toBeUndefined();
  });

  it("rejects when the leased line sits at a different coordinate (look-alike rebind)", () => {
    // The leased identity resolves to the SERVED coordinate, not the rebased one: the bytes moved
    // but the identity did not follow, which is the rebind shape.
    const stale = leaseSource({
      rebasedLineOf: (lineId) => (lineId === 11 ? 2 : lineId === 12 ? 3 : undefined),
    });
    expect(codeOfCall(() => verify(stale))).toBe("E_STALE_RANGE");
  });

  it("rejects when the served row holds no lease (a serve predating lease granting)", () => {
    const unleased: LeaseSpanSource = {
      currentSnapshotHash: "C",
      leaseFor: () => undefined,
      rebasedLineOf: () => 1,
    };
    expect(codeOfCall(() => verify(unleased))).toBe("E_STALE_RANGE");
  });

  it("rejects when the leased line was retired", () => {
    expect(codeOfCall(() => verify(leaseSource({ retired: true })))).toBe("E_STALE_RANGE");
  });

  it("does not mutate the served mirror", () => {
    const before = [...SERVED];
    expect(codeOfCall(() => verify(leaseSource()))).toBeUndefined();
    expect(codeOfCall(() => verify(leaseSource({ retired: true })))).toBe("E_STALE_RANGE");
    expect(SERVED).toEqual(before);
    expect(SERVED_CANONS).toEqual([canon("gone"), ...FILE_LINES.map((line) => canon(line))]);
  });
});
