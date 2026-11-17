import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  loadHashStore,
  loadServedStore,
  shutdownHashStore,
  type RetiredEntry,
} from "../../src/hash-store.js";
import { DomainError } from "../../src/domain-errors.js";
import {
  _mergeServedRows,
  loadAnchorReservations,
  loadServed,
  recordServed,
  recordServedTruncated,
  retireAnchors,
  driftReported,
  markDriftReported,
  clearDriftReported,
  wipeServedState,
  servedPositionsOf,
} from "../../src/session-view.js";
import { HASH_STORE_VERSION, SERVED_TTL_MS } from "../../src/constants.js";
import { initHasher, contentChecksum } from "../../src/hashline/hasher.js";
import { HASH_SPACE, idxToHash, lineHashesPure } from "../../src/hashline/hash-assign.js";
import { getWritableTempRoot } from "../support/fixtures.js";
import { saveUndo } from "../../src/undo-edit.js";

let tmpHome: string;
beforeAll(async () => {
  await initHasher();
});

describe("served state — record semantics", () => {
  it("round-trips served entries per file and position", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/a.ts", [
        { position: 0, hash: "abc" },
        { position: 1, hash: "def" },
        { position: 2, hash: "ghi" },
      ]);
      expect(await loadServed("sessionA", "/a.ts")).toEqual(["abc", "def", "ghi"]);
    });
  });

  it("returns an empty record for a path with no served entries", async () => {
    await withTempHome(async () => {
      expect(await loadServed("sessionA", "/missing.ts")).toEqual([]);
    });
  });

  it("exposes interior gaps as never-served markers", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [
        { position: 0, hash: "abc" },
        { position: 2, hash: "def" },
      ]);
      expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc", null, "def"]);
    });
  });

  it("exposes leading gaps as never-served markers", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [{ position: 3, hash: "abc" }]);
      expect(await loadServed("sessionA", "/p.ts")).toEqual([null, null, null, "abc"]);
    });
  });

  it("grows the record to the highest served position", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
      await recordServed("sessionA", "/p.ts", [{ position: 5, hash: "def" }]);
      expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc", null, null, null, null, "def"]);
    });
  });

  it("overwrites a previously served position", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "def" }]);
      expect(await loadServed("sessionA", "/p.ts")).toEqual(["def"]);
      expect((await loadServedStore()).getRetiredAnchors("sessionA", "/p.ts")).toEqual(
        new Set(["abc"]),
      );
    });
  });

  it("marks a served position as never-served with a null hash", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [
        { position: 0, hash: "abc" },
        { position: 1, hash: "def" },
        { position: 2, hash: "ghi" },
      ]);
      await recordServed("sessionA", "/p.ts", [{ position: 1, hash: null }]);
      expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc", null, "ghi"]);
      expect((await loadServedStore()).getRetiredAnchors("sessionA", "/p.ts")).toEqual(
        new Set(["def"]),
      );
    });
  });

  it("ignores an empty entries batch", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", []);
      expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
    });
  });

  it("keeps unrelated served records intact when recording another path", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/a.ts", [{ position: 0, hash: "abc" }]);
      await recordServed("sessionA", "/b.ts", [
        { position: 0, hash: "def" },
        { position: 1, hash: "ghi" },
      ]);
      expect(await loadServed("sessionA", "/a.ts")).toEqual(["abc"]);
      expect(await loadServed("sessionA", "/b.ts")).toEqual(["def", "ghi"]);
    });
  });

  it("survives a hash-store shutdown and reopen", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [
        { position: 0, hash: "abc" },
        { position: 2, hash: "def" },
      ]);
      shutdownHashStore();
      expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc", null, "def"]);
    });
  });
});

describe("served state — incremental hazard sweep", () => {
  it("sweeps the retired entries a partial serve re-observed at their death position", async () => {
    await withTempHome(async () => {
      const sessionKey = "sess-hazard-1";
      const path = "/tmp/hazard-file.txt";
      const N = 20;
      const content = Array.from({ length: N }, (_, i) => `line ${i}`).join("\n");
      const realHashes = lineHashesPure(content);
      await recordServed(
        sessionKey,
        path,
        realHashes.map((h, i) => ({ position: i, hash: h })),
        N,
        {
          hashes: realHashes,
          canons: Array.from({ length: N }, (_, i) => `line${i}`),
          // Setup is the whole file (every hash, in order): a full-read serve.
          fullRead: true,
        },
      );
      const toRetire = realHashes.slice(0, 6);
      await retireAnchors(sessionKey, path, toRetire);
      const newContent = Array.from({ length: N }, (_, i) =>
        i < 6 ? `changed ${i}` : `line ${i}`,
      ).join("\n");
      const newHashes = lineHashesPure(newContent);
      const store = await loadServedStore();
      const entries: RetiredEntry[] = toRetire.map((h, idx) => ({ hash: h, deathPos: idx }));
      store.clearRetiredAnchors(sessionKey, path);
      store.upsertRetiredAnchors(sessionKey, path, JSON.stringify(entries));
      const before = store.getRetiredEntries(sessionKey, path);
      expect(before.length).toBe(6);
      const rows = newHashes.slice(0, 6).map((h, i) => ({ position: i, hash: h }));
      await recordServed(sessionKey, path, rows, N, {
        hashes: newHashes,
        canons: Array.from({ length: N }, (_, i) => (i < 6 ? `changed${i}` : `line${i}`)),
        // The cell's subject: the first six lines, a genuine page — the sweep is what may
        // touch the hazard state here, not the full-read clear.
        fullRead: false,
      });
      const after = store.getRetiredEntries(sessionKey, path);
      expect(after.length).toBe(0);
    });
  });

  it("an appending retirement keeps an existing entry's death position, and the sweep still frees it", async () => {
    await withTempHome(async () => {
      const sessionKey = "sess-append-deathpos-1";
      const path = "/tmp/append-deathpos-file.txt";
      const N = 6;
      const content = Array.from({ length: N }, (_, i) => `line ${i}`).join("\n");
      const hashes = lineHashesPure(content);
      const store = await loadServedStore();
      // Seed the column the way the sweep writes it — object entries carrying a real
      // death position — plus the hazard card that entitles a serve re-observing
      // position 2 to free `AAA` incrementally.
      store.clearRetiredAnchors(sessionKey, path);
      store.upsertRetiredAnchors(sessionKey, path, JSON.stringify([{ hash: "AAA", deathPos: 2 }]));
      store.upsertCards(sessionKey, path, JSON.stringify([2]));

      // The production appending writer (the edit path's retirement).
      await retireAnchors(sessionKey, path, ["BBB"]);

      const afterAppend = store.getRetiredEntries(sessionKey, path);
      expect(afterAppend).toEqual([
        { hash: "AAA", deathPos: 2 },
        { hash: "BBB", deathPos: null },
      ]);

      // A genuinely partial serve re-observing position 2: card 2 is already tracked, so
      // the sweep must free the entry that still knows where it died.
      await recordServed(sessionKey, path, [{ position: 2, hash: hashes[2]! }], N, {
        hashes,
        canons: Array.from({ length: N }, (_, i) => `line${i}`),
        fullRead: false,
      });
      const afterSweep = store.getRetiredEntries(sessionKey, path);
      expect(afterSweep.map((entry) => entry.hash)).toEqual(["BBB"]);
    });
  });

  it("keeps deathPos=null retired entries through a partial sweep and clears them on a full serve", async () => {
    await withTempHome(async () => {
      const sessionKey = "sess-minus1-1";
      const path = "/tmp/minus1-file.txt";
      const N = 10;
      const content = Array.from({ length: N }, (_, i) => `line ${i}`).join("\n");
      const hashes = lineHashesPure(content);
      await recordServed(
        sessionKey,
        path,
        hashes.map((h, i) => ({ position: i, hash: h })),
        N,
        // The whole file, so the seeding serve is a full read.
        { hashes, canons: Array.from({ length: N }, (_, i) => `line${i}`), fullRead: true },
      );
      const store = await loadServedStore();
      const mixed: RetiredEntry[] = [
        { hash: hashes[0]!, deathPos: null },
        { hash: hashes[1]!, deathPos: null },
        { hash: hashes[2]!, deathPos: 2 },
        { hash: hashes[3]!, deathPos: 3 },
        { hash: hashes[4]!, deathPos: 4 },
      ];
      store.clearRetiredAnchors(sessionKey, path);
      store.upsertRetiredAnchors(sessionKey, path, JSON.stringify(mixed));
      const newHashes = lineHashesPure(content);
      const rows = [2, 3].map((i) => ({ position: i, hash: newHashes[i]! }));
      await recordServed(sessionKey, path, rows, N, {
        hashes: newHashes,
        canons: Array.from({ length: N }, (_, i) => `line${i}`),
        // Rows 2-3 of ten: the partial branch the cell is named for.
        fullRead: false,
      });
      const afterPartial = store.getRetiredEntries(sessionKey, path);
      const afterHashes = new Set(afterPartial.map((e) => e.hash));
      expect(afterHashes.has(hashes[0]!)).toBe(true);
      expect(afterHashes.has(hashes[1]!)).toBe(true);
      expect(afterHashes.has(hashes[2]!)).toBe(false);
      expect(afterHashes.has(hashes[3]!)).toBe(false);
      expect(afterHashes.has(hashes[4]!)).toBe(true);
      const fullRows = newHashes.map((h, i) => ({ position: i, hash: h }));
      await recordServed(sessionKey, path, fullRows, N, {
        hashes: newHashes,
        canons: Array.from({ length: N }, (_, i) => `line${i}`),
        // "…and clears them on a full serve": the cell's second half is the full read.
        fullRead: true,
      });
      const afterFull = store.getRetiredEntries(sessionKey, path);
      expect(afterFull.length).toBe(0);
    });
  });

  it("sweeps paged serves death position by death position and tracks them as cards", async () => {
    await withTempHome(async () => {
      const sessionKey = "sess-cards-paged-1";
      const path = "/tmp/cards-paged-file.txt";
      const N = 1000;
      const content = Array.from({ length: N }, (_, i) => `line ${i}`).join("\n");
      const hashes = lineHashesPure(content);
      await recordServed(
        sessionKey,
        path,
        hashes.map((h, i) => ({ position: i, hash: h })),
        N,
        // Seeding serve: the whole 1000-line file, so a full read.
        { hashes, canons: Array.from({ length: N }, (_, i) => `line${i}`), fullRead: true },
      );
      const store = await loadServedStore();
      const retired: RetiredEntry[] = Array.from({ length: N }, (_, i) => ({
        hash: idxToHash((90000 + i) % HASH_SPACE),
        deathPos: i,
      }));
      store.clearRetiredAnchors(sessionKey, path);
      store.upsertRetiredAnchors(sessionKey, path, JSON.stringify(retired));
      try {
        store.clearCards(sessionKey, path);
      } catch {}
      const before = store.getRetiredEntries(sessionKey, path);
      expect(before.length).toBe(N);
      const cardsBefore = store.getCards(sessionKey, path);
      expect(cardsBefore.size).toBe(0);
      const rowsFirst = Array.from({ length: 500 }, (_, i) => ({ position: i, hash: hashes[i]! }));
      await recordServed(sessionKey, path, rowsFirst, N, {
        hashes,
        canons: Array.from({ length: N }, (_, i) => `line${i}`),
        // First half of a paged walk: the sweep, not the full-read clear.
        fullRead: false,
      });
      const afterFirst = store.getRetiredEntries(sessionKey, path);
      expect(afterFirst.length).toBe(500);
      const remainingDeathPos = new Set(afterFirst.map((e) => e.deathPos));
      for (let i = 0; i < 500; i++) expect(remainingDeathPos.has(i)).toBe(false);
      for (let i = 500; i < 1000; i++) expect(remainingDeathPos.has(i)).toBe(true);
      const cardsAfterFirst = store.getCards(sessionKey, path);
      expect(cardsAfterFirst.size).toBe(500);
      for (let i = 0; i < 500; i++) expect(cardsAfterFirst.has(i)).toBe(true);
      const rowsSecond = Array.from({ length: 500 }, (_, i) => ({
        position: 500 + i,
        hash: hashes[500 + i]!,
      }));
      await recordServed(sessionKey, path, rowsSecond, N, {
        hashes,
        canons: Array.from({ length: N }, (_, i) => `line${i}`),
        // Second half of the same paged walk.
        fullRead: false,
      });
      const afterSecond = store.getRetiredEntries(sessionKey, path);
      expect(afterSecond.length).toBe(0);
      const cardsAfterSecond = store.getCards(sessionKey, path);
      expect(cardsAfterSecond.size).toBe(1000);
      for (let i = 0; i < 1000; i++) expect(cardsAfterSecond.has(i)).toBe(true);
      const fullRows = hashes.map((h, i) => ({ position: i, hash: h }));
      await recordServed(sessionKey, path, fullRows, N, {
        hashes,
        canons: Array.from({ length: N }, (_, i) => `line${i}`),
        // The walk's terminal full read: this is the serve that clears cards and retired.
        fullRead: true,
      });
      const cardsAfterFull = store.getCards(sessionKey, path);
      expect(cardsAfterFull.size).toBe(0);
      const retiredAfterFull = store.getRetiredEntries(sessionKey, path);
      expect(retiredAfterFull.length).toBe(0);
    });
  });
});

describe("served state — retired-anchor writer contract", () => {
  function readServedRow(
    home: string,
    sessionKey: string,
    path: string,
  ): { retired: string | null; updated_at: number } {
    const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
    const row = db
      .prepare("SELECT retired, updated_at FROM served WHERE session_id = ? AND path = ?")
      .get(sessionKey, path) as { retired: string | null; updated_at: number } | undefined;
    db.close();
    if (!row) throw new Error(`no served row for ${sessionKey}:${path}`);
    return row;
  }

  it("rejects an invalid retired hash before it reads or writes the column", async () => {
    // WHY the assertion is what it is: ADR-0036 decision 3 says an invalid hash is rejected
    // "whether or not the hash is new", but the "even when already known" half is
    // UNCONSTRUCTIBLE as a black-box case here — `isValidRetiredEntry` and
    // `coerceRetiredEntry` (src/hash-store.ts) both require `HASH_RE`, so the store can never
    // hold an invalid hash that a caller could then re-present as "known". What the ordering
    // guarantees observably is exactly what this cell pins: an invalid argument aborts the
    // call before any read or write, because the validation loop in `addRetiredAnchors`
    // precedes its `getRetiredEntries` read.
    await withTempHome(async (home) => {
      const sessionKey = "sess-invalid-hash-1";
      const path = "/tmp/invalid-hash-file.txt";
      const store = await loadServedStore();
      const seeded = JSON.stringify([{ hash: "AAA", deathPos: 2 }]);
      store.upsertRetiredAnchors(sessionKey, path, seeded);
      expect(readServedRow(home, sessionKey, path).retired).toBe(seeded);

      // The READ half of the ordering claim, pinned directly: `addRetiredAnchors` validates the
      // whole batch before its `getRetiredEntries` read, so a rejected batch never reaches the
      // column. `loadHashStore` is memoized per store path, so this is the very object the call
      // under test reaches.
      const readSpy = vi.spyOn(store, "getRetiredEntries");

      // A lone invalid hash aborts the call …
      await expect(retireAnchors(sessionKey, path, ["bad-hash!"])).rejects.toThrow(
        /Invalid retired hash/,
      );
      // … before the column is read at all …
      expect(readSpy).not.toHaveBeenCalled();
      // … and nothing was written: the column is byte-identical.
      expect(readServedRow(home, sessionKey, path).retired).toBe(seeded);

      // The sharper form: a VALID new hash followed by an invalid one. A writer that appended
      // as it walked the batch would leave `BBB` behind; the validation loop covers the whole
      // batch first, so the reject leaves the column byte-identical — no partial append.
      await expect(retireAnchors(sessionKey, path, ["BBB", "bad-hash!"])).rejects.toThrow(
        /Invalid retired hash/,
      );
      expect(readSpy).not.toHaveBeenCalled();
      expect(readServedRow(home, sessionKey, path).retired).toBe(seeded);
      readSpy.mockRestore();
      expect(store.getRetiredEntries(sessionKey, path)).toEqual([{ hash: "AAA", deathPos: 2 }]);

      // … and the seam the two claims above lean on is LIVE: a valid retirement does read the
      // column. Without this control the `not.toHaveBeenCalled` claims would also pass against a
      // spy that observes nothing (e.g. a store facade that stopped being the memoized object).
      const liveSpy = vi.spyOn(store, "getRetiredEntries");
      await retireAnchors(sessionKey, path, ["CCC"]);
      expect(liveSpy).toHaveBeenCalled();
      liveSpy.mockRestore();
    });
  });

  it("re-retiring a known hash leaves the row untouched, and that no-write is refutable", async () => {
    await withTempHome(async (home) => {
      const sessionKey = "sess-idempotent-retire-1";
      const path = "/tmp/idempotent-retire-file.txt";
      const store = await loadServedStore();
      await retireAnchors(sessionKey, path, ["AAA"]);
      const seeded = readServedRow(home, sessionKey, path);
      expect(JSON.parse(seeded.retired as string)).toEqual([{ hash: "AAA", deathPos: null }]);

      // Same hash, after the clock has demonstrably moved: idempotent retirement is the
      // writer's decision not to upsert, so the row's stamp and column must both stay put.
      await new Promise((r) => setTimeout(r, 5));
      await retireAnchors(sessionKey, path, ["AAA"]);
      const afterRepeat = readServedRow(home, sessionKey, path);
      expect(afterRepeat.updated_at).toBe(seeded.updated_at);
      expect(afterRepeat.retired).toBe(seeded.retired);

      // POSITIVE CONTROL — the assertion above can fail. Upserting that very same column
      // directly, after another few ms, DOES move `updated_at`: the DB clock resolves finer
      // than the gap this cell measures, so the unchanged stamp is the writer's no-write and
      // not a clock artefact.
      await new Promise((r) => setTimeout(r, 5));
      store.upsertRetiredAnchors(sessionKey, path, afterRepeat.retired as string);
      const afterControl = readServedRow(home, sessionKey, path);
      expect(afterControl.updated_at).toBeGreaterThan(afterRepeat.updated_at);
      expect(afterControl.retired).toBe(afterRepeat.retired);
    });
  });
});

describe("served state — merge helper (stale-tail invariant)", () => {
  it("drops the stale tail when a serve truncates to the current line count", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [
        { position: 0, hash: "abc" },
        { position: 1, hash: "def" },
        { position: 2, hash: "ghi" },
      ]);
      // The file shrank to 1 line; the new serve must not keep the old
      // tail — a hash held at a position beyond the line count is a
      // stale claim that later makes boundary anchors look ambiguous
      // (E_UNSERVED_RANGE, "served at N positions").
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }], 1);
      expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc"]);
      expect((await loadServedStore()).getRetiredAnchors("sessionA", "/p.ts")).toEqual(
        new Set(["def", "ghi"]),
      );
    });
  });

  it("never leaves a surviving hash at its old position after a truncating serve", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [
        { position: 0, hash: "abc" },
        { position: 1, hash: "def" },
      ]);
      // Post-mutation diff serve: file shrank to 1 line, only "abc" shown.
      await recordServedTruncated("sessionA", "/p.ts", [{ position: 0, hash: "abc" }], 1, 0);
      const served = await loadServed("sessionA", "/p.ts");
      expect(served).toEqual(["abc"]);
      expect(servedPositionsOf(served, "abc")).toEqual([0]);
      expect((await loadServedStore()).getRetiredAnchors("sessionA", "/p.ts")).toEqual(
        new Set(["def"]),
      );
    });
  });

  it("clears re-shaped positions from clearFrom before diff rows land", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [
        { position: 0, hash: "aaa" },
        { position: 1, hash: "bbb" },
        { position: 2, hash: "ccc" },
        { position: 3, hash: "ddd" },
      ]);
      // The edit's first changed line is 1 (0-indexed): the model's
      // view of everything at/after it no longer holds.
      await recordServedTruncated("sessionA", "/p.ts", [{ position: 2, hash: "xxx" }], 4, 1);
      expect(await loadServed("sessionA", "/p.ts")).toEqual(["aaa", null, "xxx"]);
      expect((await loadServedStore()).getRetiredAnchors("sessionA", "/p.ts")).toEqual(
        new Set(["bbb", "ccc", "ddd"]),
      );
    });
  });

  it("rejects invalid rows before anything reaches the store", async () => {
    await withTempHome(async () => {
      expect(() =>
        _mergeServedRows(
          [],
          [
            { position: 0, hash: "abc" },
            { position: 1, hash: "ZZZZ" },
          ],
        ),
      ).toThrow(/Invalid served hash/);
      expect(() => _mergeServedRows([], [{ position: -1, hash: "abc" }])).toThrow(
        /Invalid served position/,
      );
      // The async seam swallows store failures; an invalid batch must be
      // a no-op, never a partial write.
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "ZZZZ" }]);
      expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
    });
  });

  it("trims trailing never-served markers", () => {
    expect(_mergeServedRows([null, null], [])).toEqual([]);
    expect(_mergeServedRows(["abc", null, null], [{ position: 0, hash: "def" }])).toEqual(["def"]);
  });
});

describe("served state — session isolation", () => {
  it("keeps two sessions' served records for the same path independent", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
      await recordServed("sessionB", "/p.ts", [{ position: 0, hash: "def" }]);
      expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc"]);
      expect(await loadServed("sessionB", "/p.ts")).toEqual(["def"]);
    });
  });

  it("wipes only the targeted session's served records", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/a.ts", [{ position: 0, hash: "abc" }]);
      await recordServed("sessionB", "/a.ts", [{ position: 0, hash: "def" }]);
      await wipeServedState("sessionA");
      expect(await loadServed("sessionA", "/a.ts")).toEqual([]);
      expect(await loadServed("sessionB", "/a.ts")).toEqual(["def"]);
    });
  });

  it("keeps reported drift sets per session", async () => {
    await withTempHome(async () => {
      await markDriftReported("sessionA", "/p.ts", ["abc"]);
      await markDriftReported("sessionB", "/p.ts", ["def"]);
      expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set(["abc"]));
      expect(await driftReported("sessionB", "/p.ts")).toEqual(new Set(["def"]));
    });
  });

  it("sees no served rows for a session that recorded nothing", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
      expect(await loadServed("sessionB", "/p.ts")).toEqual([]);
    });
  });

  it("keeps one path's retired set disjoint from a second session's", async () => {
    await withTempHome(async () => {
      const path = "/proj/file.ts";
      await recordServed("sessionA", path, [{ position: 0, hash: "AAA" }], 1, {
        hashes: ["AAA"],
        canons: ["a"],
        // A one-line file served whole; the cell asserts reservations, not serve shape.
        fullRead: true,
      });
      const store = await loadServedStore();
      store.upsertRetiredAnchors("sessionA", path, JSON.stringify([{ hash: "BBB", deathPos: 0 }]));
      await recordServed("sessionB", path, [{ position: 0, hash: "CCC" }], 1, {
        hashes: ["CCC"],
        canons: ["c"],
        // Same one-line whole-file serve, second session.
        fullRead: true,
      });
      store.upsertRetiredAnchors("sessionB", path, JSON.stringify([{ hash: "DDD", deathPos: 0 }]));
      const resA = store.getAnchorReservations("sessionA", path);
      const resB = store.getAnchorReservations("sessionB", path);
      const svResA = await loadAnchorReservations("sessionA", path);
      const svResB = await loadAnchorReservations("sessionB", path);
      expect(resA.reservedHashes.has("AAA")).toBe(true);
      expect(resA.reservedHashes.has("BBB")).toBe(true);
      expect(resA.reservedHashes.has("CCC")).toBe(false);
      expect(resA.reservedHashes.has("DDD")).toBe(false);
      expect(resA.retiredHashes.has("BBB")).toBe(true);
      expect(resA.retiredHashes.has("DDD")).toBe(false);
      expect(resB.reservedHashes.has("CCC")).toBe(true);
      expect(resB.reservedHashes.has("DDD")).toBe(true);
      expect(resB.reservedHashes.has("AAA")).toBe(false);
      expect(resB.reservedHashes.has("BBB")).toBe(false);
      expect(resB.retiredHashes.has("DDD")).toBe(true);
      expect(resB.retiredHashes.has("BBB")).toBe(false);
      expect(svResA.reservedHashes.has("AAA")).toBe(true);
      expect(svResA.reservedHashes.has("BBB")).toBe(true);
      expect(svResA.reservedHashes.has("CCC")).toBe(false);
      expect(svResB.reservedHashes.has("CCC")).toBe(true);
      expect(svResB.reservedHashes.has("DDD")).toBe(true);
      expect(svResB.reservedHashes.has("AAA")).toBe(false);
    });
  });
});

describe("served state — session wipe keeps snapshots and undo", () => {
  it("removes all served records while keeping snapshots and undo", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await recordServed("sessionA", "/a.ts", [{ position: 0, hash: "abc" }]);
      await recordServed("sessionA", "/b.ts", [{ position: 1, hash: "def" }]);
      store.upsertSnapshot("/a.ts", contentChecksum("a\n"), 1, ["abc"]);
      await saveUndo("/u.ts", {
        content: "old",
        bom: "",
        originalEnding: "\n",
        hashes: ["UVW"],
        resultContent: "new",
      });

      await wipeServedState("sessionA");

      expect(await loadServed("sessionA", "/a.ts")).toEqual([]);
      expect(await loadServed("sessionA", "/b.ts")).toEqual([]);
      expect(store.getSnapshot("/a.ts", "a\n")).toEqual(["abc"]);
      expect(store.getUndo("/u.ts")).toBeDefined();
    });
  });
});

describe("served state — corrupt row handling", () => {
  async function corruptServed(
    home: string,
    sessionKey: string,
    path: string,
    value: string,
  ): Promise<void> {
    const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
    db.prepare("UPDATE served SET hashes = ? WHERE session_id = ? AND path = ?").run(
      value,
      sessionKey,
      path,
    );
    db.close();
  }

  it("treats a row with unparseable hashes as an empty record and deletes it", async () => {
    await withTempHome(async (home) => {
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "AAA" }]);
      await corruptServed(home, "sessionA", "/p.ts", "not json");
      shutdownHashStore();
      expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const remaining = check
        .prepare("SELECT COUNT(*) AS n FROM served WHERE session_id = ? AND path = ?")
        .get("sessionA", "/p.ts") as { n: number };
      check.close();
      expect(remaining.n).toBe(0);
    });
  });

  it("treats a row with malformed hash strings as an empty record and deletes it", async () => {
    await withTempHome(async (home) => {
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "AAA" }]);
      await corruptServed(home, "sessionA", "/p.ts", '["ZZ", "ZZZZ", "a!b"]');
      shutdownHashStore();
      expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const remaining = check
        .prepare("SELECT COUNT(*) AS n FROM served WHERE session_id = ? AND path = ?")
        .get("sessionA", "/p.ts") as { n: number };
      check.close();
      expect(remaining.n).toBe(0);
    });
  });

  it("treats a row with non-string entries as an empty record and deletes it", async () => {
    await withTempHome(async (home) => {
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "AAA" }]);
      await corruptServed(home, "sessionA", "/p.ts", "[42]");
      shutdownHashStore();
      expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const remaining = check
        .prepare("SELECT COUNT(*) AS n FROM served WHERE session_id = ? AND path = ?")
        .get("sessionA", "/p.ts") as { n: number };
      check.close();
      expect(remaining.n).toBe(0);
    });
  });
});

describe("served state — schema versioning", () => {
  it("preserves served rows, snapshots and undo when the stored version is newer", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "XYZ" }]);
      store.upsertSnapshot("/p.ts", contentChecksum("x\n"), 1, ["XYZ"]);
      await saveUndo("/u.ts", {
        content: "old",
        bom: "",
        originalEnding: "\n",
        hashes: ["UVW"],
        resultContent: "new",
      });
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      db.prepare("UPDATE meta SET value = '999' WHERE key = 'version'").run();
      db.close();

      const failure = await loadServed("sessionA", "/p.ts").then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DomainError);
      expect((failure as DomainError).code).toBe("E_STORE_NEWER_VERSION");

      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const version = check.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined;
      expect(version?.value).toBe("999");
      const servedRow = check
        .prepare("SELECT hashes FROM served WHERE session_id = ? AND path = ?")
        .get("sessionA", "/p.ts") as { hashes: string };
      expect(JSON.parse(servedRow.hashes)).toEqual(["XYZ"]);
      const snapshots = check.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as {
        n: number;
      };
      expect(snapshots.n).toBe(1);
      const undos = check.prepare("SELECT COUNT(*) AS n FROM undo").get() as { n: number };
      expect(undos.n).toBe(1);
      check.close();

      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(false);
    });
  });

  it("rebuilds a pre-session-keyed served table into the session-partitioned schema", async () => {
    await withTempHome(async (home) => {
      await mkdir(configHome(home), { recursive: true });
      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta (key, value) VALUES ('version', '5')");
      db.exec(
        "CREATE TABLE served (path TEXT PRIMARY KEY, hashes TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      );
      db.close();
      await markDriftReported("sessionA", "/p.ts", ["abc"]);
      expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set(["abc"]));
    });
  });

  it("preserves served rows and rebound sources when adding the retired column", async () => {
    await withTempHome(async (home) => {
      const path = join(home, "rebound.txt");
      const content = "new\nold\n";
      await writeFile(path, content, "utf-8");
      const initialStore = await loadHashStore();
      await recordServed("sessionA", path, [{ position: 0, hash: "AAA" }]);
      initialStore.upsertSnapshot(path, contentChecksum(content), 2, ["BBB", "AAA"]);
      await saveUndo(path, {
        content: "old\nnew\n",
        bom: "",
        originalEnding: "\n",
        hashes: ["BBB", "AAA"],
        resultContent: content,
      });
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      db.exec("ALTER TABLE served DROP COLUMN retired");
      db.close();

      const store = await loadServedStore();
      expect(store.getAnchorReservations("sessionA", path).reservedHashes).toEqual(
        new Set(["AAA"]),
      );
      // The retired-column upgrade is non-destructive (ADR-0017): snapshot and undo
      // rows survive; only the missing column is backfilled.
      expect((await loadHashStore()).getSnapshot(path, content)).toEqual(["BBB", "AAA"]);
      expect((await loadHashStore()).getUndo(path)).toEqual({
        content: "old\nnew\n",
        bom: "",
        ending: "\n",
        hashes: ["BBB", "AAA"],
        resultContent: content,
      });
      store.upsertRetiredAnchors("sessionA", path, JSON.stringify(["BBB"]));
      expect(store.getRetiredAnchors("sessionA", path)).toEqual(new Set(["BBB"]));
    });
  });
});

describe("served state — pruneMissing", () => {
  it("removes served records for files that no longer exist", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await recordServed("sessionA", "/gone.ts", [{ position: 0, hash: "ZZZ" }]);
      await store.pruneMissing();
      expect(await loadServed("sessionA", "/gone.ts")).toEqual([]);
    });
  });

  it("keeps served records for files that still exist", async () => {
    await withTempHome(async (home) => {
      const existing = join(home, "keep.ts");
      await writeFile(existing, "keep\n", "utf-8");
      const store = await loadHashStore();
      await recordServed("sessionA", existing, [{ position: 0, hash: "KEP" }]);
      await store.pruneMissing();
      expect(await loadServed("sessionA", existing)).toEqual(["KEP"]);
    });
  });

  it("prunes served-only records for files with no snapshot or undo row", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await recordServed("sessionA", "/orphan.ts", [{ position: 0, hash: "ORG" }]);
      await store.pruneMissing();
      expect(await loadServed("sessionA", "/orphan.ts")).toEqual([]);
    });
  });

  it("prunes served records alongside snapshots and undo in one pass", async () => {
    await withTempHome(async (home) => {
      const existing = join(home, "keep.ts");
      await writeFile(existing, "keep\n", "utf-8");
      const store = await loadHashStore();
      await recordServed("sessionA", existing, [{ position: 0, hash: "KEP" }]);
      await recordServed("sessionA", "/gone.ts", [{ position: 0, hash: "GON" }]);
      store.upsertSnapshot(existing, contentChecksum("keep\n"), 1, ["KEP"]);
      store.upsertSnapshot("/gone.ts", contentChecksum("gone\n"), 1, ["GON"]);
      await saveUndo(existing, {
        content: "old",
        bom: "",
        originalEnding: "\n",
        hashes: ["KEP"],
        resultContent: "new",
      });
      await saveUndo("/gone.ts", {
        content: "old",
        bom: "",
        originalEnding: "\n",
        hashes: ["GON"],
        resultContent: "new",
      });
      await store.pruneMissing();

      expect(await loadServed("sessionA", existing)).toEqual(["KEP"]);
      expect(await loadServed("sessionA", "/gone.ts")).toEqual([]);
      expect(store.getSnapshot(existing, "keep\n")).toEqual(["KEP"]);
      expect(store.getSnapshot("/gone.ts", "gone\n")).toBeUndefined();
      expect(store.getUndo(existing)).toBeDefined();
      expect(store.getUndo("/gone.ts")).toBeUndefined();
    });
  });
});

describe("served state — reported drift set", () => {
  it("merges reported hashes per file", async () => {
    await withTempHome(async () => {
      await markDriftReported("sessionA", "/a.ts", ["abc", "def"]);
      await markDriftReported("sessionA", "/a.ts", ["def", "ghi"]);
      expect(await driftReported("sessionA", "/a.ts")).toEqual(new Set(["abc", "def", "ghi"]));
    });
  });

  it("returns an empty set for a path with no reported data", async () => {
    await withTempHome(async () => {
      expect(await driftReported("sessionA", "/missing.ts")).toEqual(new Set());
    });
  });

  it("ignores malformed reported data", async () => {
    await withTempHome(async (home) => {
      await markDriftReported("sessionA", "/p.ts", ["abc"]);
      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      db.prepare("UPDATE served SET reported = 'not json' WHERE session_id = ? AND path = ?").run(
        "sessionA",
        "/p.ts",
      );
      db.close();
      expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set());
    });
  });

  it("clears the reported set for a path", async () => {
    await withTempHome(async () => {
      await markDriftReported("sessionA", "/p.ts", ["abc"]);
      await clearDriftReported("sessionA", "/p.ts");
      expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set());
    });
  });

  it("survives a hash-store shutdown and reopen", async () => {
    await withTempHome(async () => {
      await markDriftReported("sessionA", "/p.ts", ["abc"]);
      shutdownHashStore();
      expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set(["abc"]));
    });
  });

  it("is wiped alongside the served table for the same session", async () => {
    await withTempHome(async () => {
      await markDriftReported("sessionA", "/a.ts", ["abc"]);
      await markDriftReported("sessionB", "/a.ts", ["def"]);
      await wipeServedState("sessionA");
      expect(await driftReported("sessionA", "/a.ts")).toEqual(new Set());
      expect(await driftReported("sessionB", "/a.ts")).toEqual(new Set(["def"]));
    });
  });

  it("is pruned when the file no longer exists", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await markDriftReported("sessionA", "/gone.ts", ["abc"]);
      await store.pruneMissing();
      expect(await driftReported("sessionA", "/gone.ts")).toEqual(new Set());
    });
  });
});

describe("served state — TTL sweep", () => {
  async function ageServedRow(
    home: string,
    sessionKey: string,
    path: string,
    updatedAt: number,
  ): Promise<void> {
    const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
    db.prepare("UPDATE served SET updated_at = ? WHERE session_id = ? AND path = ?").run(
      updatedAt,
      sessionKey,
      path,
    );
    db.close();
  }

  it("prunes served rows older than the TTL on store open", async () => {
    await withTempHome(async (home) => {
      await recordServed("sessionA", "/p.ts", [
        { position: 0, hash: "abc" },
        { position: 2, hash: "def" },
      ]);
      shutdownHashStore();
      await ageServedRow(home, "sessionA", "/p.ts", Date.now() - SERVED_TTL_MS - 1000);
      expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
      const check = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const remaining = check
        .prepare("SELECT COUNT(*) AS n FROM served WHERE session_id = ? AND path = ?")
        .get("sessionA", "/p.ts") as { n: number };
      check.close();
      expect(remaining.n).toBe(0);
    });
  });

  it("keeps a fresh served row across a close/reopen cycle so a pi -c continuation can verify against it", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [
        { position: 0, hash: "abc" },
        { position: 2, hash: "def" },
      ]);
      shutdownHashStore();
      expect(await loadServed("sessionA", "/p.ts")).toEqual(["abc", null, "def"]);
    });
  });

  it("prunes an old row of one session while keeping another session's fresh row", async () => {
    await withTempHome(async (home) => {
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abc" }]);
      await recordServed("sessionB", "/p.ts", [{ position: 0, hash: "def" }]);
      shutdownHashStore();
      await ageServedRow(home, "sessionA", "/p.ts", Date.now() - SERVED_TTL_MS - 1000);
      expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
      expect(await loadServed("sessionB", "/p.ts")).toEqual(["def"]);
    });
  });
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-served-test-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
  vi.stubEnv("XDG_CONFIG_HOME", "");
  try {
    await run(tmpHome);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  }
}

function configHome(home: string): string {
  return join(home, ".dsh", "plugins", "dsh-better-edit");
}

function sqlitePath(home: string): string {
  return join(configHome(home), "hash-store.sqlite");
}
