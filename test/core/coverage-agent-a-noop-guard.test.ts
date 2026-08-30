import { describe, it, expect, beforeEach } from "vitest";
import {
  noopPayloadKey,
  trackNoopPayload,
  clearNoopLoop,
  runNoopPolicySync,
  runNoopPolicy,
  NOOP_LOOP_THRESHOLD,
} from "../../src/noop-guard.js";

describe("noop-guard coverage", () => {
  beforeEach(() => {
    // clear tracker for isolation: use distinct paths per test
  });

  it("noopPayloadKey deterministic json array", () => {
    const k1 = noopPayloadKey("/a/b.txt", "aBc", "xYz", "hello");
    const k2 = noopPayloadKey("/a/b.txt", "aBc", "xYz", "hello");
    expect(k1).toBe(k2);
    expect(JSON.parse(k1)).toEqual(["/a/b.txt", "aBc", "xYz", "hello"]);
    const k3 = noopPayloadKey("/a/b.txt", "aBc", "xYz", "different");
    expect(k1).not.toBe(k3);
  });

  it("trackNoopPayload increments same payload, resets on different payload", () => {
    const path = "/tmp/noop-track-" + Math.random();
    const payloadA = JSON.stringify([path, "a", "b", "c"]);
    const payloadB = JSON.stringify([path, "a", "b", "d"]);
    expect(trackNoopPayload(path, payloadA)).toBe(1);
    expect(trackNoopPayload(path, payloadA)).toBe(2);
    expect(trackNoopPayload(path, payloadA)).toBe(3);
    // different payload resets to 1
    expect(trackNoopPayload(path, payloadB)).toBe(1);
    expect(trackNoopPayload(path, payloadB)).toBe(2);
    // back to A resets again because last payload is B
    expect(trackNoopPayload(path, payloadA)).toBe(1);
    clearNoopLoop(path);
    expect(trackNoopPayload(path, payloadA)).toBe(1);
  });

  it("clearNoopLoop removes entry", () => {
    const p = "/tmp/clear-" + Math.random();
    const pay = "payload-x";
    trackNoopPayload(p, pay);
    trackNoopPayload(p, pay);
    clearNoopLoop(p);
    expect(trackNoopPayload(p, pay)).toBe(1);
    // clearing non-existent is no-op
    clearNoopLoop("/non/existent");
  });

  it("runNoopPolicySync proceed when count 1", () => {
    const input: any = {
      absolutePath: "/a.txt",
      removeFrom: "Abc",
      removeTo: "Xyz",
      replacementText: "hi",
      ref: "Abc → Xyz",
      batch: false,
      range: { startLine: 1, endLine: 2 },
      hashes: [],
      lines: [],
      sessionKey: "s1",
    };
    expect(runNoopPolicySync(input, 1)).toEqual({ action: "proceed", count: 1 });
  });

  it("runNoopPolicySync warn at count 2 (single)", () => {
    const input: any = {
      absolutePath: "/a.txt",
      removeFrom: "Abc",
      removeTo: "Xyz",
      replacementText: "hi",
      ref: "Abc → Xyz",
      batch: false,
      range: { startLine: 1, endLine: 2 },
      hashes: [],
      lines: [],
      sessionKey: "s1",
    };
    const res = runNoopPolicySync(input, 2) as any;
    expect(res.action).toBe("warn");
    expect(res.count).toBe(2);
    expect(res.notice).toContain("identical edit");
    expect(res.notice).toContain("Abc");
  });

  it("runNoopPolicySync warn at count 2 (batch)", () => {
    const input: any = {
      absolutePath: "/a.txt",
      removeFrom: "Abc",
      removeTo: "Xyz",
      replacementText: "hi",
      ref: "file.txt:1",
      batch: true,
      range: { startLine: 1, endLine: 2 },
      hashes: [],
      lines: [],
      sessionKey: "s1",
    };
    const res = runNoopPolicySync(input, 2) as any;
    expect(res.action).toBe("warn");
    expect(res.notice).toContain("file.txt:1");
  });

  it("runNoopPolicySync reject at threshold (3) single", () => {
    const input: any = {
      absolutePath: "/a.txt",
      removeFrom: "Abc",
      removeTo: "Xyz",
      replacementText: "hi",
      ref: "Abc → Xyz",
      batch: false,
      range: { startLine: 1, endLine: 2 },
      hashes: [],
      lines: [],
      sessionKey: "s1",
    };
    const res = runNoopPolicySync(input, NOOP_LOOP_THRESHOLD) as any;
    expect(res.action).toBe("reject");
    expect(res.message).toContain("E_NOOP_LOOP");
    expect(res.message).toContain("Abc → Xyz");
  });

  it("runNoopPolicySync reject at threshold batch", () => {
    const input: any = {
      absolutePath: "/a.txt",
      removeFrom: "Abc",
      removeTo: "Xyz",
      replacementText: "hi",
      ref: "file.txt:1",
      batch: true,
      range: { startLine: 1, endLine: 2 },
      hashes: [],
      lines: [],
      sessionKey: "s1",
    };
    const res = runNoopPolicySync(input, 5) as any;
    expect(res.action).toBe("reject");
    expect(res.message).toContain("file.txt:1");
    expect(res.message).toContain("batch");
  });

  it("runNoopPolicy async increments and delegates", async () => {
    const path = "/tmp/async-noop-" + Math.random();
    const input: any = {
      absolutePath: path,
      removeFrom: "Aaa",
      removeTo: "Bbb",
      replacementText: "replacement",
      ref: "Aaa → Bbb",
      batch: false,
      range: { startLine: 1, endLine: 1 },
      hashes: [],
      lines: [],
      sessionKey: "s1",
    };
    clearNoopLoop(path);
    const r1 = await runNoopPolicy(input);
    expect(r1.action).toBe("proceed");
    expect(r1.count).toBe(1);
    const r2 = await runNoopPolicy(input);
    expect(r2.action).toBe("warn");
    expect(r2.count).toBe(2);
    const r3 = await runNoopPolicy(input);
    expect(r3.action).toBe("reject");
    expect(r3.count).toBe(3);
    clearNoopLoop(path);
  });

  it("runNoopPolicySync threshold constant is 3", () => {
    expect(NOOP_LOOP_THRESHOLD).toBe(3);
  });
});