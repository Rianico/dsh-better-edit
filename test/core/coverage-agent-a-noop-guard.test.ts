import { describe, it, expect } from "vitest";

import { NOOP_LOOP_THRESHOLD } from "../../src/constants.js";
import { clearNoopLoop, noopPayloadKey, trackNoopPayload } from "../../src/noop-guard.js";
import { enforceNoopLoop } from "../../src/mutation/engine.js";

describe("noop-guard coverage", () => {
  it("noopPayloadKey deterministic json array", () => {
    const k1 = noopPayloadKey("/a/b.txt", "aBc", "xYz", "hello");
    const k2 = noopPayloadKey("/a/b.txt", "aBc", "xYz", "hello");
    expect(k1).toBe(k2);
    expect(JSON.parse(k1)).toEqual(["/a/b.txt", "aBc", "xYz", "hello"]);
    const k3 = noopPayloadKey("/a/b.txt", "aBc", "xYz", "different");
    expect(k1).not.toBe(k3);
  });

  it("trackNoopPayload increments same payload, resets on different payload", () => {
    const session = "coverage-session-" + Math.random();
    const path = "/tmp/noop-track-" + Math.random();
    const payloadA = JSON.stringify([path, "a", "b", "c"]);
    const payloadB = JSON.stringify([path, "a", "b", "d"]);
    expect(trackNoopPayload(session, path, payloadA)).toBe(1);
    expect(trackNoopPayload(session, path, payloadA)).toBe(2);
    expect(trackNoopPayload(session, path, payloadA)).toBe(3);
    // different payload resets to 1
    expect(trackNoopPayload(session, path, payloadB)).toBe(1);
    expect(trackNoopPayload(session, path, payloadB)).toBe(2);
    // back to A resets again because last payload is B
    expect(trackNoopPayload(session, path, payloadA)).toBe(1);
    clearNoopLoop(session, path);
    expect(trackNoopPayload(session, path, payloadA)).toBe(1);
    clearNoopLoop(session, path);
  });

  it("clearNoopLoop removes entry", () => {
    const session = "clear-session-" + Math.random();
    const p = "/tmp/clear-" + Math.random();
    const pay = "payload-x";
    trackNoopPayload(session, p, pay);
    trackNoopPayload(session, p, pay);
    clearNoopLoop(session, p);
    expect(trackNoopPayload(session, p, pay)).toBe(1);
    // clearing non-existent is no-op
    clearNoopLoop(session, "/non/existent");
    clearNoopLoop(session, p);
  });

  it("NOOP_LOOP_THRESHOLD is 3 (the reject tier, not the warn tier)", () => {
    expect(NOOP_LOOP_THRESHOLD).toBe(3);
  });
});

/**
 * ADR-0039: the noop-loop counter is per `(session, file)`, not per file.
 *
 * Pre-fix red probe on the file-wide counter (two sessions, one file, one
 * payload): `session-A=1, session-A=2, session-B=3` — session B's FIRST
 * submission sat at `NOOP_LOOP_THRESHOLD` (3) and was therefore refused for a
 * loop it never ran. Both referents are asserted here: the counter values and
 * the rendered decision `enforceNoopLoop` makes from them.
 */
describe("noop-loop counter is scoped by session (ADR-0039)", () => {
  // WHY per-run tokens: the counter map is process-global, so fixed session keys and a fixed path
  // would let a concurrent/repeat run of this file collide with a leftover entry — the same count
  // read twice or a stale refusal. Every key here is unique per run; nothing else changes.
  const run = Math.random().toString(36).slice(2);
  const path = `/tmp/noop-session-scope/${run}/shared.txt`;
  const sessionA = `session-A-${run}`;
  const sessionB = `session-B-${run}`;
  const payload = JSON.stringify([path, "aBc", "xYz", "same replacement"]);

  it("two sessions on one file keep independent counts", async () => {
    clearNoopLoop(sessionA, path);
    clearNoopLoop(sessionB, path);

    // (a) session A's own repeats advance only A's counter.
    const a1 = trackNoopPayload(sessionA, path, payload);
    const a2 = trackNoopPayload(sessionA, path, payload);
    expect([a1, a2]).toEqual([1, 2]);
    // (b) session B's FIRST submission starts at 1 — not 3 (the pre-fix value).
    const b1 = trackNoopPayload(sessionB, path, payload);
    expect(b1).toBe(1);

    // (c) B's count is below the warn tier: no notice, and no refusal.
    await expect(
      enforceNoopLoop({
        anchorFrom: "aBc",
        anchorTo: "xYz",
        displayPath: "shared.txt",
        index: 0,
        count: b1,
        originalNormalized: "same replacement\n",
      }),
    ).resolves.toBeUndefined();

    // A's third repeat is its own loop: refused with E_NOOP_LOOP.
    const a3 = trackNoopPayload(sessionA, path, payload);
    expect(a3).toBe(3);
    const decision = await enforceNoopLoop({
      anchorFrom: "aBc",
      anchorTo: "xYz",
      displayPath: "shared.txt",
      index: 0,
      count: a3,
      originalNormalized: "same replacement\n",
    });
    expect(decision).toMatchObject({ action: "reject" });

    // (d) clearing A's entry leaves B's counter intact: B continues from its own count.
    clearNoopLoop(sessionA, path);
    expect(trackNoopPayload(sessionB, path, payload)).toBe(2);
    expect(trackNoopPayload(sessionA, path, payload)).toBe(1);

    clearNoopLoop(sessionA, path);
    clearNoopLoop(sessionB, path);
  });
});
