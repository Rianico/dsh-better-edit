import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  canon,
  lineHashesPure,
  ServedRejectionError,
  verifyServedRange,
  verifyRebasedSpan,
  type LeaseSpanSource,
} from "../../src/hashline/index.js";
import { DomainError } from "../../src/domain-errors.js";
import { initHasher } from "../../src/hashline/hash-assign.js";
import {
  loadHashStore,
  shutdownHashStore,
  type HashStore,
  type InternalHashStore,
} from "../../src/hash-store.js";
import { makeLeaseSource } from "../../src/mutation/engine.js";
import { loadServed, loadServedCanons } from "../../src/session-view.js";
import { hashStorePath } from "../../src/store-tenancy.js";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import { codeOf, splitLines } from "../../src/utils.js";
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

/** The T3a contract fixture: two byte-identical lines, the first externally deleted. */
const TWIN_CONTENT_A =
  "export function alpha() {\n" +
  "  return compute(value);\n" +
  "}\n" +
  "\n" +
  "export function beta() {\n" +
  "  return compute(value);\n" +
  "}\n";
const TWIN_CONTENT_B = TWIN_CONTENT_A.replace("  return compute(value);\n", "");

function anchorOfRendered(result: { content: Array<{ text?: string }> }, line: string): string {
  return extractHash(
    getText(result)
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

/** The ServedRejectionError a call must throw; fails the test when it does not throw. */
function rejectionFrom(fn: () => void): ServedRejectionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ServedRejectionError);
    return error as ServedRejectionError;
  }
  throw new Error("expected a ServedRejectionError, none was thrown");
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

  it("rejects E_UNKNOWN_ANCHOR when the anchor was never served in this session", async () => {
    await withTempFile("never.txt", CONTENT, async ({ cwd, path }) => {
      const { editTool } = setupIntegrationTest(cwd);
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
      expect(error).toBeDefined();
      expect(String((error as Error).message)).toMatch(/E_UNKNOWN_ANCHOR/);
      expect(await readFile(path, "utf-8")).toBe(CONTENT);
    });
  });

  it("rejects E_FOREIGN_ANCHOR when the anchor is leased to another file in this session", async () => {
    await withTempFile("home.ts", CONTENT, async ({ cwd, path }) => {
      const foreign = join(cwd, "foreign.ts");
      await writeFile(foreign, CONTENT, "utf-8");
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const anchor = anchorOfRendered(
        await readTool.execute("read", { path: "home.ts" }),
        "line 5",
      );

      let error: unknown;
      try {
        await editTool.execute("foreign", {
          path: "foreign.ts",
          anchor_from: anchor,
          anchor_to: anchor,
          replace_with: "changed",
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      const message = String((error as Error).message);
      expect(message).toMatch(/E_FOREIGN_ANCHOR/);
      expect(message).toContain("served for");
      expect(message).toContain("home.ts");
      expect(await readFile(foreign, "utf-8")).toBe(CONTENT);
      expect(await readFile(path, "utf-8")).toBe(CONTENT);
    });
  });
});

describe("verifyRebasedSpan — the gate's arms", () => {
  const FILE_LINES = ["alpha", "beta", "gamma", "delta"];
  const FILE_HASHES = lineHashesPure(FILE_LINES.join("\n"));
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
      anchorHomes: () => [],
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
    expect(codeOfCall(() => verify())).toBe("E_STALE_RANGE");
  });

  it("accepts the benign shift when the leased identity lives at the rebased coordinate", () => {
    expect(codeOfCall(() => verify(leaseSource()))).toBeUndefined();
  });

  it("rejects when the leased line sits at a different coordinate (look-alike rebind)", () => {
    const stale = leaseSource({
      rebasedLineOf: (lineId) => (lineId === 11 ? 2 : lineId === 12 ? 3 : undefined),
    });
    expect(codeOfCall(() => verify(stale))).toBe("E_STALE_RANGE");
  });

  it("rejects an unleased boundary at the interception with E_UNKNOWN_ANCHOR (FU-4)", () => {
    const unleased: LeaseSpanSource = {
      leaseFor: () => undefined,
      rebasedLineOf: () => 1,
      anchorHomes: () => [],
    };
    let thrown: unknown;
    try {
      verify(unleased);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).not.toBeInstanceOf(ServedRejectionError);
    const error = thrown as DomainError;
    expect(codeOf(error)).toBe("E_UNKNOWN_ANCHOR");
    expect(error.servedRows).toEqual([]);
    expect(String(error.message)).toContain("has not served the anchors");
  });

  it("verifyRebasedSpan rejects a served row that holds no lease (direct call)", () => {
    const unleased: LeaseSpanSource = {
      leaseFor: () => undefined,
      rebasedLineOf: () => 1,
      anchorHomes: () => [],
    };
    const error = rejectionFrom(() =>
      verifyRebasedSpan({
        served: [FILE_HASHES[0]!, FILE_HASHES[1]!],
        servedStart: 1,
        servedEnd: 2,
        rebasedStart: 1,
        rebasedEnd: 2,
        route: { kind: "leased", source: unleased },
        echo: "echo-block",
        echoRows: [{ position: 0, hash: FILE_HASHES[0]! }],
        where: " in x.ts",
      }),
    );
    expect(codeOf(error)).toBe("E_STALE_RANGE");
    expect(String(error.message)).toContain("has no served line identity.");
    expect(error.details.cause).toBe("never-served");
  });

  it("verifyRebasedSpan rejects a retired leased row (direct call)", () => {
    const error = rejectionFrom(() =>
      verifyRebasedSpan({
        served: [FILE_HASHES[0]!, FILE_HASHES[1]!],
        servedStart: 1,
        servedEnd: 2,
        rebasedStart: 1,
        rebasedEnd: 2,
        route: { kind: "leased", source: leaseSource({ retired: true }) },
        echo: "echo-block",
        echoRows: [{ position: 0, hash: FILE_HASHES[0]! }],
        where: " in x.ts",
      }),
    );
    expect(codeOf(error)).toBe("E_STALE_RANGE");
    expect(String(error.message)).toContain(
      "no longer resolves to the line identity it was served with.",
    );
    expect(error.details.cause).toBe("retirement");
  });

  it("rejects a retired boundary at the interception with E_TARGET_LOST, no rows (FU-4)", () => {
    let thrown: unknown;
    try {
      verify(leaseSource({ retired: true }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).not.toBeInstanceOf(ServedRejectionError);
    const error = thrown as DomainError;
    expect(codeOf(error)).toBe("E_TARGET_LOST");
    expect(error.servedRows).toEqual([]);
    expect(String(error.message)).toContain(
      "no longer resolves to the line identity it was served with.",
    );
    expect(String(error.message)).toContain("Read the file and re-target.");
  });

  it("rejects another file's leased boundary at the interception with E_FOREIGN_ANCHOR (FU-4)", () => {
    const foreign: LeaseSpanSource = {
      leaseFor: () => undefined,
      rebasedLineOf: () => 1,
      anchorHomes: () => ["other.ts"],
    };
    let thrown: unknown;
    try {
      verify(foreign);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).not.toBeInstanceOf(ServedRejectionError);
    const error = thrown as DomainError;
    expect(codeOf(error)).toBe("E_FOREIGN_ANCHOR");
    expect(error.servedRows).toEqual([]);
    expect(String(error.message)).toContain(
      "are inconsistent with this file; served for other.ts; nothing was written.",
    );
  });

  it("rejects with E_UNVERIFIED_RANGE echoing the window when one bound is stale and the survivor is unshifted (FU-4)", () => {
    const oneStale: LeaseSpanSource = {
      leaseFor: (anchor) => {
        const lineId = anchor === FILE_HASHES[0] ? 11 : anchor === FILE_HASHES[1] ? 12 : undefined;
        if (lineId === undefined) return undefined;
        return {
          lineId,
          servedLineNumber: lineId - 9,
          servedSnapshotHash: "S",
          retiredAt: null,
        };
      },
      rebasedLineOf: (lineId) => (lineId === 12 ? 3 : undefined),
      anchorHomes: () => [],
    };
    let thrown: unknown;
    try {
      verify(oneStale);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).not.toBeInstanceOf(ServedRejectionError);
    const error = thrown as DomainError;
    expect(codeOf(error)).toBe("E_UNVERIFIED_RANGE");
    expect(error.servedRows).toEqual([
      { position: 1, hash: FILE_HASHES[1] },
      { position: 2, hash: FILE_HASHES[2] },
    ]);
    expect(String(error.message)).toContain(
      "a bound of this range no longer resolves to the line identity it was served with.",
    );
    expect(String(error.message)).toContain("Current range (fresh read):");
    expect(String(error.message)).toContain("│beta");
    expect(String(error.message)).toContain("│gamma");
    expect(error.details.cause).toBe("retirement");
    expect(error.firstOffendingLine).toBe(2);
  });

  it("emits E_TARGET_LOST when the live bound shifted (one stale, one moved)", () => {
    const movedSurvivor: LeaseSpanSource = {
      leaseFor: (anchor) => {
        if (anchor === FILE_HASHES[0])
          return { lineId: 11, servedLineNumber: 2, servedSnapshotHash: "S", retiredAt: 1 };
        if (anchor === FILE_HASHES[1])
          return { lineId: 12, servedLineNumber: 3, servedSnapshotHash: "S", retiredAt: null };
        return undefined;
      },
      rebasedLineOf: (lineId) => (lineId === 12 ? 4 : undefined),
      anchorHomes: () => [],
    };
    let thrown: unknown;
    try {
      verify(movedSurvivor);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).not.toBeInstanceOf(ServedRejectionError);
    const error = thrown as DomainError;
    expect(codeOf(error)).toBe("E_TARGET_LOST");
    expect(error.servedRows).toEqual([]);
    expect(String(error.message)).toMatch(/line 2/);
    expect(String(error.message)).not.toMatch(/line 4/);
    expect(error.details.cause).toBe("retirement");
  });

  it("fails closed to E_TARGET_LOST when the fresh-read window collapses outside the file (collapsed-window guard)", () => {
    const beyond: LeaseSpanSource = {
      leaseFor: (anchor) => {
        if (anchor === FILE_HASHES[0])
          return { lineId: 19, servedLineNumber: 10, servedSnapshotHash: "S", retiredAt: null };
        if (anchor === FILE_HASHES[1])
          return { lineId: 20, servedLineNumber: 11, servedSnapshotHash: "S", retiredAt: null };
        return undefined;
      },
      rebasedLineOf: (lineId) => (lineId === 20 ? 11 : undefined),
      anchorHomes: () => [],
    };
    let thrown: unknown;
    try {
      verify(beyond);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    const error = thrown as DomainError;
    expect(codeOf(error)).toBe("E_TARGET_LOST");
    expect(error.servedRows).toEqual([]);
    expect(String(error.message)).toContain("line 10");
  });

  it("does not mutate the served mirror", () => {
    const before = [...SERVED];
    expect(codeOfCall(() => verify(leaseSource()))).toBeUndefined();
    expect(() => verify(leaseSource({ retired: true }))).toThrow(/E_TARGET_LOST/);
    expect(SERVED).toEqual(before);
    expect(SERVED_CANONS).toEqual([canon("gone"), ...FILE_LINES.map((line) => canon(line))]);
  });

  const HOLED: (string | null)[] = [
    "hGone",
    FILE_HASHES[0]!,
    null,
    FILE_HASHES[2]!,
    FILE_HASHES[3]!,
  ];
  const HOLED_CANONS = [canon("gone"), canon("alpha"), null, canon("gamma"), canon("delta")];
  function holedSource(): LeaseSpanSource {
    const holedIds: Record<string, number> = { [FILE_HASHES[0]!]: 11, [FILE_HASHES[2]!]: 13 };
    const holedPositions = new Map([
      [11, 1],
      [13, 3],
    ]);
    return {
      leaseFor: (anchor) => {
        const lineId = holedIds[anchor];
        if (lineId === undefined) return undefined;
        return {
          lineId,
          servedLineNumber: lineId - 9,
          servedSnapshotHash: "S",
          retiredAt: null,
        };
      },
      rebasedLineOf: (lineId) => holedPositions.get(lineId),
      anchorHomes: () => [],
    };
  }

  it("accepts an unread interior row between two leased boundaries (upstream ADR-0024 decision 1)", () => {
    expect(
      codeOfCall(() =>
        verifyRebasedSpan({
          served: HOLED,
          servedStart: 2,
          servedEnd: 4,
          rebasedStart: 1,
          rebasedEnd: 3,
          route: { kind: "leased", source: holedSource() },
          echo: "echo-block",
          echoRows: [{ position: 0, hash: FILE_HASHES[0]! }],
          where: " in x.ts",
        }),
      ),
    ).toBeUndefined();
  });

  it("accepts the same hole end-to-end through verifyServedRange with a lease source", () => {
    expect(
      codeOfCall(() =>
        verifyServedRange({
          served: HOLED,
          servedCanons: HOLED_CANONS,
          startHash: FILE_HASHES[0]!,
          endHash: FILE_HASHES[2]!,
          startLine: 1,
          endLine: 3,
          fileHashes: [...FILE_HASHES],
          fileLines: [...FILE_LINES],
          leaseSource: holedSource(),
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects a never-served boundary row — a two-row window is all boundary (decision 1 keeps it fail-closed)", () => {
    const error = rejectionFrom(() =>
      verifyRebasedSpan({
        served: [null, FILE_HASHES[1]!],
        servedStart: 1,
        servedEnd: 2,
        rebasedStart: 1,
        rebasedEnd: 2,
        route: { kind: "leased", source: leaseSource() },
        echo: "echo-block",
        echoRows: [{ position: 0, hash: FILE_HASHES[0]! }],
        where: " in x.ts",
      }),
    );
    expect(codeOf(error)).toBe("E_STALE_RANGE");
    expect(String(error.message)).toContain("line 1 in x.ts was never served.");
    expect(error.details.cause).toBe("never-served");
  });

  it("rejects a truncated window slot — the mirror row is gone, the lease outlives it", () => {
    const error = rejectionFrom(() =>
      verifyRebasedSpan({
        served: [FILE_HASHES[0]!],
        servedStart: 1,
        servedEnd: 2,
        rebasedStart: 1,
        rebasedEnd: 2,
        route: { kind: "leased", source: leaseSource() },
        echo: "echo-block",
        echoRows: [{ position: 0, hash: FILE_HASHES[0]! }],
        where: " in x.ts",
      }),
    );
    expect(codeOf(error)).toBe("E_STALE_RANGE");
    expect(String(error.message)).toContain(
      "line 2 in x.ts has no served mirror row left; the served window was truncated.",
    );
    expect(error.details.cause).toBe("served-range staleness");
  });

  it("rejects a window whose served and rebased lengths disagree", () => {
    let thrown: unknown;
    try {
      verifyRebasedSpan({
        served: SERVED,
        servedStart: 2,
        servedEnd: 2,
        rebasedStart: 1,
        rebasedEnd: 2,
        route: { kind: "leased", source: leaseSource() },
        echo: "echo-block",
        echoRows: [{ position: 0, hash: FILE_HASHES[0]! }],
        where: " in x.ts:1-2",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ServedRejectionError);
    const error = thrown as ServedRejectionError;
    expect(codeOf(error)).toBe("E_STALE_RANGE");
    expect(error.servedRows.length).toBeGreaterThan(0);
    expect(String(error.message)).not.toContain("Retry with these anchors");
  });
});

describe("resolution is read-only (runtime)", () => {
  const LEASE_COLUMNS =
    "SELECT session_id, file_path, anchor, line_id, canon_hash, served_snapshot_hash, " +
    "served_line_number, updated_at, retired_at FROM served_leases ORDER BY anchor";
  const MIRROR_COLUMNS =
    "SELECT session_id, file_path, hashes, reported, retired, canons, cards FROM served_session_meta " +
    "ORDER BY session_id, file_path";

  function storeRows(): string {
    const db = new DatabaseSync(hashStorePath());
    try {
      return JSON.stringify({
        leases: db.prepare(LEASE_COLUMNS).all(),
        mirror: db.prepare(MIRROR_COLUMNS).all(),
      });
    } finally {
      db.close();
    }
  }

  it("writes nothing when the gate accepts a benign shift", async () => {
    await withTempFile("ro-accept.txt", CONTENT, async ({ cwd }) => {
      const sessionKey = "test-session";
      const absolutePath = join(cwd, "ro-accept.txt");
      const servedRead = await readAndServe(localIO(), "ro-accept.txt", cwd, { sessionKey });
      const anchor = servedRead.served[5]!.hash;

      const before = storeRows();

      const shiftedLines = ["prepended", ...LINES];
      const shiftedContent = shiftedLines.join("\n");
      const shiftedHashes = lineHashesPure(shiftedContent);
      expect(shiftedHashes[6]).toBe(anchor);

      const source = makeLeaseSource(
        await loadHashStore(),
        sessionKey,
        absolutePath,
        shiftedContent,
      );
      expect(source).toBeDefined();
      const served = await loadServed(sessionKey, absolutePath);
      const servedCanons = await loadServedCanons(sessionKey, absolutePath);
      expect(
        codeOfCall(() =>
          verifyServedRange({
            served,
            servedCanons,
            startHash: anchor,
            endHash: anchor,
            startLine: 7,
            endLine: 7,
            fileHashes: shiftedHashes,
            fileLines: shiftedLines,
            leaseSource: source,
          }),
        ),
      ).toBeUndefined();

      expect(storeRows()).toBe(before);
    });
  });

  it("writes nothing when the boundary identity is gone (E_TARGET_LOST via the interception)", async () => {
    await withTempFile("ro-reject.txt", TWIN_CONTENT_A, async ({ cwd }) => {
      const sessionKey = "test-session";
      const absolutePath = join(cwd, "ro-reject.txt");
      const servedRead = await readAndServe(localIO(), "ro-reject.txt", cwd, { sessionKey });
      const anchor = servedRead.served[1]!.hash;

      const before = storeRows();

      const rebindLines = splitLines(TWIN_CONTENT_B);
      const source = makeLeaseSource(
        await loadHashStore(),
        sessionKey,
        absolutePath,
        TWIN_CONTENT_B,
      );
      expect(source).toBeDefined();
      const served = await loadServed(sessionKey, absolutePath);
      const servedCanons = await loadServedCanons(sessionKey, absolutePath);
      let thrown: unknown;
      try {
        verifyServedRange({
          served,
          servedCanons,
          startHash: anchor,
          endHash: anchor,
          startLine: 5,
          endLine: 5,
          fileHashes: lineHashesPure(TWIN_CONTENT_B),
          fileLines: rebindLines,
          leaseSource: source,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DomainError);
      expect(thrown).not.toBeInstanceOf(ServedRejectionError);
      expect(codeOf(thrown as DomainError)).toBe("E_TARGET_LOST");

      expect(storeRows()).toBe(before);
    });
  });
});

describe("identityPositions degrade signal — log-once warn (KEEL K-1)", () => {
  async function withThrowingIdentityRead<T>(store: HashStore, run: () => Promise<T>): Promise<T> {
    const internal = store as unknown as InternalHashStore;
    const original = internal.positionsByIdentity;
    internal.positionsByIdentity = () => {
      throw new Error("K-1: simulated lineage read failure");
    };
    try {
      return await run();
    } finally {
      internal.positionsByIdentity = original;
    }
  }

  it("warns exactly once per file on the first degrade and stays silent on repeats", async () => {
    await withTempFile("k1-degrade.txt", CONTENT, async ({ cwd }) => {
      const absolutePath = join(cwd, "k1-degrade.txt");
      const store = await loadHashStore();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await withThrowingIdentityRead(store, async () => {
          expect(makeLeaseSource(store, "k1-session", absolutePath, CONTENT)).toBeUndefined();
          expect(makeLeaseSource(store, "k1-session", absolutePath, CONTENT)).toBeUndefined();
        });
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]?.[0]);
        expect(message).toMatch(/^dsh-better-edit: /);
        expect(message).toContain(absolutePath);
        expect(message).toContain("K-1: simulated lineage read failure");
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("the edit still applies under the degrade — signal added, behavior unchanged", async () => {
    await withTempFile("k1-edit.txt", CONTENT, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const anchor = anchorOfRendered(
        await readTool.execute("read", { path: "k1-edit.txt" }),
        "line 5",
      );
      const store = await loadHashStore(cwd);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await withThrowingIdentityRead(store, async () => {
          await editTool.execute("k1-degraded-edit", {
            path: "k1-edit.txt",
            anchor_from: anchor,
            anchor_to: anchor,
            replace_with: "line 5 changed",
          });
          expect(warn).toHaveBeenCalledTimes(1);
          expect(String(warn.mock.calls[0]?.[0])).toMatch(/^dsh-better-edit: /);
        });
      } finally {
        warn.mockRestore();
      }
      expect(await readFile(path, "utf-8")).toBe(CONTENT.replace("line 5\n", "line 5 changed\n"));
    });
  });
});
