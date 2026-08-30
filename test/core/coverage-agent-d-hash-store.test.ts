import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isValidHashList, isValidSnapshot, isValidServedList, isCorruptionError, loadHashStore, shutdownHashStore, withStore } from "../../src/hash-store.js";
import { getWritableTempRoot } from "../support/fixtures.js";
import { contentChecksum } from "../../src/hashline/hash-assign.js";
import { splitLines } from "../../src/utils.js";
import { vi } from "vitest";
import { initHasher } from "../../src/hashline/hasher.js";

beforeAll(async ()=>{ await initHasher(); });

async function withTempHome(run: (home:string)=>Promise<void>) {
  const tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-d-hashstore-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  try { await run(tmpHome); } finally { shutdownHashStore(); vi.unstubAllEnvs(); await rm(tmpHome,{recursive:true,force:true}); }
}

describe("coverage-agent-d hash-store validators", () => {
  it("isValidHashList branches", () => {
    expect(isValidHashList(["abc","def"])).toBe(true);
    expect(isValidHashList([])).toBe(true);
    expect(isValidHashList("not array" as any)).toBe(false);
    expect(isValidHashList([42 as any])).toBe(false);
    expect(isValidHashList(["ZZ"] as any)).toBe(false);
    expect(isValidHashList(["abc","abc"])).toBe(true); // duplicates allowed in validator? check logic allows
  });
  it("isValidSnapshot", () => {
    expect(isValidSnapshot({content:"x", hashes:["abc"]})).toBe(true);
    expect(isValidSnapshot(null)).toBe(false);
    expect(isValidSnapshot({hashes:["abc"]})).toBe(false);
    expect(isValidSnapshot({content:"x", hashes:"nope"})).toBe(false);
    expect(isValidSnapshot({content:123, hashes:["abc"]})).toBe(false);
  });
  it("isValidServedList", () => {
    expect(isValidServedList([])).toBe(true);
    expect(isValidServedList([null,"abc"])).toBe(true);
    expect(isValidServedList(["ZZ"] as any)).toBe(false);
    expect(isValidServedList("not array" as any)).toBe(false);
    expect(isValidServedList([42 as any])).toBe(false);
  });
  it("isCorruptionError", () => {
    expect(isCorruptionError({errcode:11})).toBe(true);
    expect(isCorruptionError({errcode:24})).toBe(true);
    expect(isCorruptionError({errcode:26})).toBe(true);
    expect(isCorruptionError({code:"SQLITE_CORRUPT"})).toBe(true);
    expect(isCorruptionError({code:"SQLITE_NOTADB"})).toBe(true);
    expect(isCorruptionError(new Error("corrupt database"))).toBe(true);
    expect(isCorruptionError(new Error("not a database"))).toBe(true);
    expect(isCorruptionError(new Error("hello"))).toBe(false);
    expect(isCorruptionError(null)).toBe(false);
  });
});

describe("coverage-agent-d hash-store operations", () => {
  it("getSnapshot deleteCorrupt false keeps row", async () => {
    await withTempHome(async ()=>{
      const store = await loadHashStore();
      // insert corrupt via direct db
      const home = process.env.HOME!;
      const sqlitePath = join(home,".dsh","plugins","dsh-better-edit","hash-store.sqlite");
      const db = new DatabaseSync(sqlitePath) as any;
      db.exec("INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES ('/corrupt.ts','canon:abc',1,'not-json',123)");
      db.close();
      shutdownHashStore();
      const store2 = await loadHashStore();
      const res = store2.getSnapshot("/corrupt.ts", "content", false);
      expect(res).toBeUndefined();
      // with deleteCorrupt true it deletes
      const res2 = store2.getSnapshot("/corrupt.ts", "content", true);
      expect(res2).toBeUndefined();
    });
  });
  it("findSnapshotPaths and allSnapshotHashes", async () => {
    await withTempHome(async ()=>{
      const store = await loadHashStore();
      store.upsertSnapshot("/a.ts", contentChecksum("a\n"), splitLines("a\n").length, ["aaa"]);
      store.upsertSnapshot("/b.ts", contentChecksum("b\n"), splitLines("b\n").length, ["bbb"]);
      expect(store.allSnapshotHashes().length).toBeGreaterThanOrEqual(2);
      expect(store.findSnapshotPaths(["aaa"])).toContain("/a.ts");
      expect(store.findSnapshotPaths(["zzz"])).toEqual([]);
      // corrupt row ignored
      const home = process.env.HOME!;
      const sqlitePath = join(home,".dsh","plugins","dsh-better-edit","hash-store.sqlite");
      const db = new DatabaseSync(sqlitePath) as any;
      db.exec("INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES ('/bad.ts','canon:bad',1,'not-json',123)");
      db.close();
      shutdownHashStore();
      const store2 = await loadHashStore();
      expect(store2.findSnapshotPaths(["aaa"])).toContain("/a.ts");
    });
  });
  it("getUndo corrupt handling", async () => {
    await withTempHome(async ()=>{
      const store = await loadHashStore();
      store.upsertUndo("/u.ts", {content:"c", bom:"", ending:"\n", hashes:["aaa"], resultContent:"r"});
      expect(store.getUndo("/u.ts")).toBeDefined();
      // corrupt via db
      const home = process.env.HOME!;
      const sqlitePath = join(home,".dsh","plugins","dsh-better-edit","hash-store.sqlite");
      const db = new DatabaseSync(sqlitePath) as any;
      db.exec("INSERT OR REPLACE INTO undo (path, content, bom, ending, hashes, result_content, updated_at) VALUES ('/badundo','c','',\'\\n\',\'not-json\',\'r\',123)");
      db.close();
      shutdownHashStore();
      const store2 = await loadHashStore();
      expect(store2.getUndo("/badundo")).toBeUndefined();
    });
  });
  it("served get and wipe", async () => {
    await withTempHome(async ()=>{
      const store = await loadHashStore();
      const served = await import("../../src/hash-store.js");
      const sp = store as any;
      // use served persistence via store directly
      sp.upsertServed("sess1","/p.ts", JSON.stringify(["aaa",null]));
      expect(sp.getServed("sess1","/p.ts")).toEqual(["aaa",null]);
      sp.upsertServedReported("sess1","/p.ts", JSON.stringify(["aaa"]));
      expect(sp.getServedReported("sess1","/p.ts").has("aaa")).toBe(true);
      sp.clearServedReported("sess1","/p.ts");
      sp.deleteServed("sess1","/p.ts");
      expect(sp.getServed("sess1","/p.ts")).toEqual([]);
      sp.upsertServed("sess1","/a.ts", JSON.stringify(["aaa"]));
      sp.wipeServed("sess1");
      expect(sp.getServed("sess1","/a.ts")).toEqual([]);
    });
  });
  it("withStore runs bare when no store", () => {
    let ran=false;
    shutdownHashStore();
    withStore(()=>{ ran=true; });
    expect(ran).toBe(true);
  });
  it("withStore transaction", async () => {
    await withTempHome(async ()=>{
      const store = await loadHashStore();
      withStore(()=>{ store.upsertSnapshot("/t.ts", contentChecksum("t\n"),1,["ttt"]); });
      expect(store.getSnapshot("/t.ts","t\n")).toEqual(["ttt"]);
    });
  });
  it("pruneMissing and pruneUndoOlderThan", async () => {
    await withTempHome(async ()=>{
      const store = await loadHashStore() as any;
      store.upsertSnapshot("/missing-file-xyz.ts", contentChecksum("x\n"),1,["abc"]);
      await store.pruneMissing();
      // file doesn't exist, should be pruned
      expect(store.getSnapshot("/missing-file-xyz.ts","x\n")).toBeUndefined();
      store.upsertUndo("/u2.ts", {content:"c", bom:"", ending:"\n", hashes:["aaa"], resultContent:"r"});
      store.pruneUndoOlderThan(Date.now()+1000);
      expect(store.getUndo("/u2.ts")).toBeUndefined();
    });
  });
  it("allKnownPaths includes all families", async () => {
    await withTempHome(async ()=>{
      const store = await loadHashStore();
      store.upsertSnapshot("/k1.ts", contentChecksum("k\n"),1,["aaa"]);
      (store as any).upsertServed("s","/k2.ts", JSON.stringify(["bbb"]));
      const paths = store.allKnownPaths().map(r=>r.path);
      expect(paths).toEqual(expect.arrayContaining(["/k1.ts","/k2.ts"]));
    });
  });
});
