import { describe, expect, it, beforeAll } from "vitest";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/fs-bridge.js";
import { recordServed, recordServedTruncated } from "../../src/session-view.js";
import { recordEchoServes } from "../../src/hashline/anchor-pipeline.js";
import { loadHashStore, upsertSnapshotFor, type InternalHashStore } from "../../src/hash-store.js";
import { sessionKeyFor } from "../../src/workspace-context.js";
import { withTempFile } from "../support/fixtures.js";
import { initHasher } from "../../src/hashline/hasher.js";
import {
  canon,
  canonDigest,
  contentChecksum,
  lineHashesPure,
} from "../../src/hashline/hash-assign.js";
import { splitLines } from "../../src/utils.js";
import { snapshotHashFor } from "../../src/snapshot-store/lineage-store.js";

beforeAll(async () => {
  await initHasher();
});

async function internalStore(): Promise<InternalHashStore> {
  return (await loadHashStore()) as InternalHashStore;
}

function fullRows(hashes: string[]): { position: number; hash: string }[] {
  return hashes.map((hash, position) => ({ position, hash }));
}

describe("serve leases — read (full read through readAndServe)", () => {
  it("leases every served anchor to the read snapshot's lineage", async () => {
    await withTempFile("serve-read.txt", "one\ntwo\nthree", async ({ cwd, path }) => {
      const sessionKey = sessionKeyFor("serve-read");
      const view = await readAndServe(localIO(), "serve-read.txt", cwd, { sessionKey });
      expect(view.served).toHaveLength(3);
      const anchor = view.served[1]!.hash;
      expect(anchor).toMatch(/^[A-Za-z0-9]{3}$/);
      const store = await internalStore();
      const lease = store.leaseFor(sessionKey, path, anchor);
      expect(lease).toBeDefined();
      expect(lease?.lineId).toBe(2);
      expect(lease?.canonHash).toBe(canonDigest("two"));
      expect(lease?.lineNumber).toBe(2);
      expect(lease?.snapshotHash).toBe(snapshotHashFor("one\ntwo\nthree"));
      expect(lease?.retiredAt).toBeNull();
      const lineage = store.lineageFor(path, lease!.snapshotHash);
      expect(lineage.find((row) => row.anchor === anchor)?.lineId).toBe(lease?.lineId);
    });
  });
});

describe("serve leases — diff (edit-response result through recordServedTruncated)", () => {
  it("binds result rows to the result snapshot", async () => {
    await withTempFile("serve-diff.txt", "one\ntwo\nthree", async ({ path }) => {
      const sessionKey = sessionKeyFor("serve-diff");
      const content = "one\nTWO\nthree";
      const hashes = lineHashesPure(content);
      const store = await internalStore();
      await recordServedTruncated(
        sessionKey,
        path,
        fullRows(hashes),
        3,
        0,
        hashes.map((_, i) => canon(splitLines(content)[i]!)),
        {
          content,
          hashes,
        },
      );
      const lease = store.leaseFor(sessionKey, path, hashes[1]!);
      expect(lease).toBeDefined();
      expect(lease?.canonHash).toBe(canonDigest("TWO"));
      expect(lease?.lineNumber).toBe(2);
      expect(lease?.snapshotHash).toBe(snapshotHashFor(content));
      const lineage = store.lineageFor(path, lease!.snapshotHash);
      expect(lineage.find((row) => row.anchor === hashes[1])?.lineId).toBe(lease?.lineId);
    });
  });
});

describe("serve leases — served-echo (recordEchoServes live vs preview)", () => {
  it("live grants, preview grants nothing", async () => {
    await withTempFile("serve-echo.txt", "one\ntwo", async ({ path }) => {
      const store = await internalStore();
      const content = "one\ntwo";
      const hashes = lineHashesPure(content);
      const rows = fullRows(hashes);
      await recordEchoServes(sessionKeyFor("serve-echo-live"), path, rows, "live", 2, {
        content,
        hashes,
      });
      const live = store.leaseFor(sessionKeyFor("serve-echo-live"), path, hashes[0]!);
      expect(live).toBeDefined();
      expect(live?.lineId).toBe(1);
      expect(live?.lineNumber).toBe(1);
      expect(live?.snapshotHash).toBe(snapshotHashFor(content));
      await recordEchoServes(sessionKeyFor("serve-echo-preview"), path, rows, "preview", 2, {
        content,
        hashes,
      });
      expect(store.leaseFor(sessionKeyFor("serve-echo-preview"), path, hashes[0]!)).toBeUndefined();
    });
  });
});

describe("serve leases — truncated (served span only)", () => {
  it("leases served anchors; outside-span anchors have no lease", async () => {
    await withTempFile("serve-trunc.txt", "a\nb\nc\nd", async ({ path }) => {
      const sessionKey = sessionKeyFor("serve-trunc");
      const content = "a\nb\nc\nd";
      const hashes = lineHashesPure(content);
      const store = await internalStore();
      await recordServedTruncated(
        sessionKey,
        path,
        [
          { position: 0, hash: hashes[0]! },
          { position: 1, hash: hashes[1]! },
        ],
        4,
        0,
        hashes.map((_, i) => canon(splitLines(content)[i]!)),
        { content, hashes },
      );
      const served = store.leaseFor(sessionKey, path, hashes[0]!);
      expect(served).toBeDefined();
      expect(served?.lineNumber).toBe(1);
      expect(served?.snapshotHash).toBe(snapshotHashFor(content));
      expect(store.leaseFor(sessionKey, path, hashes[3]!)).toBeUndefined();
    });
  });
});

describe("serve leases — undo (tool-undo plumbing directly)", () => {
  it("materializes lineage through upsertSnapshotFor and leases the restored rows", async () => {
    await withTempFile("serve-undo.txt", "alpha\nbeta", async ({ path }) => {
      const sessionKey = sessionKeyFor("serve-undo");
      const undoContent = "alpha\nbeta";
      const restoredHashes = lineHashesPure(undoContent);
      const store = await internalStore();
      // Mirror of tool-undo.ts: persist=false hashing leaves no lineage, so the
      // restore path materializes it explicitly, then serves the dense rows.
      await upsertSnapshotFor(
        path,
        contentChecksum(undoContent),
        splitLines(undoContent).length,
        restoredHashes,
        undoContent,
      );
      const lineage = store.lineageFor(path, snapshotHashFor(undoContent));
      expect(lineage).toHaveLength(2);
      await recordServedTruncated(
        sessionKey,
        path,
        fullRows(restoredHashes),
        2,
        0,
        splitLines(undoContent).map((line) => canon(line)),
        { content: undoContent, hashes: restoredHashes },
      );
      const lease = store.leaseFor(sessionKey, path, restoredHashes[0]!);
      expect(lease).toBeDefined();
      expect(lease?.lineId).toBe(1);
      expect(lease?.lineNumber).toBe(1);
      expect(lease?.snapshotHash).toBe(snapshotHashFor(undoContent));
    });
  });
});

describe("serve leases — bind to the named snapshot, never latest", () => {
  it("rows served from v1 resolve through v1's lineage after v2 exists", async () => {
    await withTempFile("serve-bind.txt", "alpha\nbeta\ngamma", async ({ path }) => {
      const sessionKey = sessionKeyFor("serve-bind");
      const store = await internalStore();
      const v1 = "alpha\nbeta\ngamma";
      const v2 = "alpha\nBETA\ngamma";
      const v1hashes = lineHashesPure(v1);
      const v2hashes = lineHashesPure(v2);
      expect(v2hashes[1]).not.toBe(v1hashes[1]);
      await recordServed(sessionKey, path, fullRows(v1hashes), 3, {
        hashes: v1hashes,
        content: v1,
      });
      await recordServed(sessionKey, path, fullRows(v2hashes), 3, {
        hashes: v2hashes,
        content: v2,
      });
      // v2's commit retired v1-beta's line (absent from v2's lineage).
      expect(store.leaseFor(sessionKey, path, v1hashes[1]!)?.retiredAt).not.toBeNull();
      // Same-session re-serve revives through upsert conflict (retired_at = NULL).
      await recordServed(sessionKey, path, fullRows(v1hashes), 3, {
        hashes: v1hashes,
        content: v1,
      });
      expect(store.leaseFor(sessionKey, path, v1hashes[1]!)?.retiredAt).toBeNull();
      // Re-serve v1 rows under a fresh session: adopt + grant must bind v1's
      // snapshot, not v2's. Fresh session matters: a reused session would still
      // show the earlier v1 grant and mask a mis-resolved re-serve.
      const reSession = sessionKeyFor("serve-bind-reserve");
      await recordServed(reSession, path, fullRows(v1hashes), 3, {
        hashes: v1hashes,
        content: v1,
      });
      const lease = store.leaseFor(reSession, path, v1hashes[1]!);
      expect(lease).toBeDefined();
      expect(lease?.snapshotHash).toBe(snapshotHashFor(v1));
      expect(lease?.snapshotHash).not.toBe(snapshotHashFor(v2));
      expect(lease?.lineId).toBe(2);
      expect(lease?.lineNumber).toBe(2);
      expect(lease?.canonHash).toBe(canonDigest("beta"));
    });
  });
});
