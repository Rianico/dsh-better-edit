import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sessionKeyFor } from "../../src/workspace-context.js";
import { mkdtemp, writeFile, mkdir, rm, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { canonicalSync, canonicalAsync } from "../../src/canonical-path.js";
import { _mergeServedRows, servedPositionsOf, currentPositionOfDrifted, computeDrift, DRIFT_NOTICE_HEADING } from "../../src/session-view.js";
import { expand, _resetConfigCache, loadConfig, DEFAULT_CONFIG_YAML } from "../../src/store-config.js";
import { lineHashesPure } from "../../src/hashline/hash-assign.js";
import { lineHashes } from "../../src/hashline/hash.js";
import { initHasher } from "../../src/hashline/hasher.js";
import { HASH_RE } from "../../src/hashline/hash-assign.js";

describe("coverage-agent-d canonical-path", () => {
  it("canonicalSync resolves simple path", async () => {
    const tmp = await mkdtemp(join(tmpdir(),"canon-"));
    const f = join(tmp,"a.txt");
    await writeFile(f,"hi");
    const resolved = canonicalSync(f);
    expect(resolved.endsWith("a.txt")).toBe(true);
    // symlink with relative target to avoid /var symlink loop on macOS
    const link = join(tmp,"link.txt");
    await symlink("a.txt", link);
    const linkResolved = canonicalSync(link);
    expect(linkResolved.endsWith("a.txt")).toBe(true);
    // ENOENT lexical tail
    expect(canonicalSync(join(tmp,"nope","sub.txt"))).toContain("nope");
    await rm(tmp,{recursive:true,force:true});
  });
  it("canonicalSync ELOOP detection", async () => {
    const tmp = await mkdtemp(join(tmpdir(),"canon-"));
    const a = join(tmp,"a");
    const b = join(tmp,"b");
    await symlink(b,a);
    await symlink(a,b);
    let err: any; try { canonicalSync(a); } catch(e){ err=e; } expect(err?.code).toBe("ELOOP");
    await rm(tmp,{recursive:true,force:true});
  });
  it("canonicalAsync mirrors sync", async () => {
    const tmp = await mkdtemp(join(tmpdir(),"canon-"));
    const f = join(tmp,"a.txt");
    await writeFile(f,"hi");
    const aResolved = await canonicalAsync(f);
    expect(aResolved.endsWith("a.txt")).toBe(true);
    const link = join(tmp,"link.txt");
    await symlink("a.txt", link);
    const laResolved = await canonicalAsync(link);
    expect(laResolved.endsWith("a.txt")).toBe(true);
    expect(await canonicalAsync(join(tmp,"nope","x"))).toContain("nope");
    await rm(tmp,{recursive:true,force:true});
  });
  it("canonicalAsync ELOOP", async () => {
    const tmp = await mkdtemp(join(tmpdir(),"canon-"));
    const a = join(tmp,"a"); const b = join(tmp,"b");
    await symlink(b,a); await symlink(a,b);
    let err2:any; try { await canonicalAsync(a); } catch(e){ err2=e; } expect(err2?.code).toBe("ELOOP");
    await rm(tmp,{recursive:true,force:true});
  });
});

describe("coverage-agent-d session-view", () => {
  it("sessionKeyFor fallback", () => {
    const a = sessionKeyFor("my-id");
    expect(a).toBe("my-id");
    const b = sessionKeyFor("");
    expect(typeof b).toBe("string");
    const c = sessionKeyFor(undefined);
    expect(typeof c).toBe("string");
    // second call returns same fallback
    expect(sessionKeyFor(undefined)).toBe(c);
  });
  it("_mergeServedRows branches", () => {
    const cur: (string|null)[] = ["aaa","bbb",null];
    // truncate
    expect(_mergeServedRows(cur, [{position:0,hash:"ccc"}], {truncateTo:2})).toEqual(["ccc","bbb"]);
    // clearFrom
    // clearFrom with trailing null pop: ["aaa",null,null] pops to ["aaa"]
    expect(_mergeServedRows(["aaa","bbb","ccc"], [], {clearFrom:1})).toEqual(["aaa"]);
    // heal duplicate
    const withDup = _mergeServedRows(["aaa","bbb"], [{position:2, hash:"aaa"}]);
    expect(withDup[0]).toBeNull();
    expect(withDup[2]).toBe("aaa");
    // invalid position
    expect(()=>_mergeServedRows([], [{position:-1,hash:"aaa"}])).toThrow();
    expect(()=>_mergeServedRows([], [{position:0,hash:"ZZ"}])).toThrow();
    // null hash clears
    const r = _mergeServedRows(["aaa","bbb"], [{position:0, hash:null}]);
    expect(r[0]).toBeNull();
    // trailing null pop
    expect(_mergeServedRows(["aaa",null], [{position:1,hash:null}])).toEqual(["aaa"]);
  });
  it("servedPositionsOf", () => {
    expect(servedPositionsOf(["aaa","bbb","aaa"], "aaa")).toEqual([0,2]);
    expect(servedPositionsOf([], "aaa")).toEqual([]);
  });
  it("currentPositionOfDrifted", () => {
    const served = ["aaa","bbb","ccc"];
    const posMap = new Map([["aaa",0],["bbb",1],["ccc",2]]);
    const surviving = new Set(["aaa","ccc"]);
    // below
    expect(currentPositionOfDrifted(served, posMap, surviving, 1, 0)).toBe(1);
    // above
    expect(currentPositionOfDrifted(["bbb","aaa","ccc"], new Map([["aaa",10],["ccc",11]]), new Set(["aaa","ccc"]), 0, 0)).toBe(9);
    // fallback
    expect(currentPositionOfDrifted(["aaa"], new Map(), new Set(), 0, 5)).toBe(5);
  });
  it("computeDrift branches", () => {
    // no drift
    expect(computeDrift({served:["aaa"], resultHashes:["aaa"], resultLines:["line"], range:{startHash:"aaa", endHash:"aaa", startLine:1, endLine:1, delta:0} as any, reported:new Set()})).toBeUndefined();
    // all reported: served has bbb outside range, result does not contain bbb
    const r = computeDrift({served:["aaa","bbb"], resultHashes:["aaa"], resultLines:["a"], range:{startHash:"aaa", endHash:"aaa", startLine:1, endLine:1, delta:0} as any, reported:new Set(["bbb"])});
    expect(r?.allAlreadyReported).toBe(true);
    expect(r?.text).toContain("already reported");
    // drifted with window
    const hashes = ["h0","h1","h2","h3"];
    const lines = ["l0","l1","l2","l3"];
    const r2 = computeDrift({served:["hX","h0","h1"], resultHashes:hashes, resultLines:lines, range:{startHash:"h0", endHash:"h1", startLine:2, endLine:3, delta:0} as any, reported:new Set(), cap:10});
    expect(r2).toBeDefined();
    expect(r2!.total).toBe(1);
  });
});

describe("coverage-agent-d store-config", () => {
  beforeEach(()=>_resetConfigCache());
  afterEach(()=>{ _resetConfigCache(); vi.unstubAllEnvs(); });
  it("expand", () => {
    const home = process.env.HOME || "/tmp";
    expect(expand("~")).toBe(home);
    expect(expand("~/foo")).toBe(home+"/foo");
    expect(expand("/abs")).toBe("/abs");
    expect(expand("relative")).toBe("relative");
  });
  it("loadConfig defaults", () => {
    vi.stubEnv("HOME", tmpdir());
    _resetConfigCache();
    const cfg = loadConfig();
    expect(cfg.storeDir).toBe("central");
    expect(cfg.autoGitignore).toBe(false);
  });
  it("loadConfig env overrides", () => {
    vi.stubEnv("DSH_BETTER_EDIT_STORE_DIR", "central");
    vi.stubEnv("DSH_BETTER_EDIT_AUTO_GITIGNORE", "true");
    vi.stubEnv("DSH_BETTER_EDIT_AUTO_GUESS_ENCODING", "true");
    vi.stubEnv("DSH_BETTER_EDIT_NORMALIZE_TO_UTF8", "false");
    vi.stubEnv("DSH_BETTER_EDIT_SUPPORTED_ENCODINGS", "[gbk, big5]");
    _resetConfigCache();
    const cfg = loadConfig();
    expect(cfg.autoGitignore).toBe(true);
    expect(cfg.autoGuessEncoding).toBe(true);
    // cached
    const cfg2 = loadConfig();
    expect(cfg2).toBe(cfg);
    _resetConfigCache();
  });
  it("loadConfig env invalid warns and fallback", () => {
    vi.stubEnv("DSH_BETTER_EDIT_STORE_DIR", "relative/bogus");
    vi.stubEnv("DSH_BETTER_EDIT_AUTO_GITIGNORE", "notbool");
    _resetConfigCache();
    const cfg = loadConfig();
    expect(cfg.storeDir).toBe("central");
  });
  it("DEFAULT_CONFIG_YAML exists", () => {
    expect(DEFAULT_CONFIG_YAML).toContain("storeDir");
  });
});

describe("coverage-agent-d hash-assign", () => {
  beforeEach(async()=>{ await initHasher(); });
  it("mkHashList and lineHashes basics", async () => {
    const hashes = await lineHashes("a\nb\nc", "/tmp/f.txt");
    expect(hashes.length).toBe(3);
    expect(hashes.every(h=>HASH_RE.test(h))).toBe(true);
    // empty
    const empty = await lineHashes("", "/tmp/empty.txt");
    expect(empty.length).toBe(1);
  });
  it("lineHashes with store and noPersist", async () => {
    const h1 = await lineHashes("hello\nworld", "/tmp/f2.txt", undefined, undefined, false);
    const h2 = await lineHashes("hello\nworld", "/tmp/f2.txt", undefined, undefined, true);
    expect(h1).toEqual(h2);
  });
});
