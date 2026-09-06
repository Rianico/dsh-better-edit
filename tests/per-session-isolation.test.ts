import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { initHasher } from "../src/hashline/hash-assign.js";
import { shutdownHashStore, loadServedStore } from "../src/hash-store.js";
import * as SessionView from "../src/session-view.js";

async function getWritableTempRoot(): Promise<string> {
  const fallback = join(process.cwd(), ".tmp");
  await mkdir(fallback, { recursive: true });
  return fallback;
}

describe("per-session anchor reservations isolation (ADR-0013)", () => {
  let tmpHome: string;
  beforeAll(async () => {
    await initHasher();
    tmpHome = await mkdtemp(join(await getWritableTempRoot(), "testhome-per-session-"));
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
  });
  afterAll(async () => {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("two sessions with same path do not see each others retired/ served reservations", async () => {
    const path = "/proj/file.ts";
    // sessionA served AAA + retired BBB
    await SessionView.recordServed("sessionA", path, [{ position: 0, hash: "AAA" }], 1, {
      hashes: ["AAA"],
      canons: ["a"],
      snapshotId: "snap1",
    });
    const store: any = await loadServedStore();
    store.upsertRetiredAnchors("sessionA", path, JSON.stringify([{ hash: "BBB", deathPos: 0 }]));
    // sessionB served CCC + retired DDD
    await SessionView.recordServed("sessionB", path, [{ position: 0, hash: "CCC" }], 1, {
      hashes: ["CCC"],
      canons: ["c"],
      snapshotId: "snap2",
    });
    store.upsertRetiredAnchors("sessionB", path, JSON.stringify([{ hash: "DDD", deathPos: 0 }]));

    // Per-session API (new) should isolate
    const resA = await store.getAnchorReservations("sessionA", path);
    const resB = await store.getAnchorReservations("sessionB", path);
    const svResA = await (SessionView as any).loadAnchorReservations("sessionA", path);
    const svResB = await (SessionView as any).loadAnchorReservations("sessionB", path);

    // store level per-session
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

    // SessionView wrapper per-session
    expect(svResA.reservedHashes.has("AAA")).toBe(true);
    expect(svResA.reservedHashes.has("BBB")).toBe(true);
    expect(svResA.reservedHashes.has("CCC")).toBe(false);
    expect(svResB.reservedHashes.has("CCC")).toBe(true);
    expect(svResB.reservedHashes.has("DDD")).toBe(true);
    expect(svResB.reservedHashes.has("AAA")).toBe(false);
  });
});
