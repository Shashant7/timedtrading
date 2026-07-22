import { describe, it, expect } from "vitest";
import { checkAndSetEntryLock, entryLockKey } from "./entry-lock.js";

function makeKv({ failGet = false, failPut = false, seed = null, lockKey = "timed:entry_lock:ETN:LONG" } = {}) {
  const map = new Map();
  if (seed != null) map.set(lockKey, String(seed));
  return {
    _map: map,
    async get(k) { if (failGet) throw new Error("kv get boom"); return map.get(k) ?? null; },
    async put(k, v) { if (failPut) throw new Error("kv put boom"); map.set(k, v); },
  };
}

describe("checkAndSetEntryLock — ETN duplicate-entry regression", () => {
  it("first call passes and sets the lock", async () => {
    const kv = makeKv();
    const now = 1784743050000;
    const r = await checkAndSetEntryLock(kv, { ticker: "ETN", direction: "LONG", now });
    expect(r.ok).toBe(true);
    expect(r.lockKey).toBe("timed:entry_lock:ETN:LONG");
    expect(kv._map.get("timed:entry_lock:ETN:LONG")).toBe(String(now));
  });

  it("second call within the 5-min window is BLOCKED (the ETN repro)", async () => {
    const kv = makeKv();
    const t1 = 1784743043223; // trade 1 timestamp (from live ETN incident)
    const t2 = 1784743050509; // trade 2 timestamp (7.3s later)
    const a = await checkAndSetEntryLock(kv, { ticker: "ETN", direction: "LONG", now: t1 });
    expect(a.ok).toBe(true);
    const b = await checkAndSetEntryLock(kv, { ticker: "ETN", direction: "LONG", now: t2 });
    expect(b.ok).toBe(false);
    expect(b.reason).toBe("recent_entry_lock");
    expect(b.ageSec).toBeGreaterThan(7);
    expect(b.ageSec).toBeLessThan(8);
  });

  it("a call OUTSIDE the 5-min window is allowed (legitimate re-entry)", async () => {
    const kv = makeKv();
    const t1 = 1784700000000;
    const t2 = t1 + 6 * 60 * 1000;
    await checkAndSetEntryLock(kv, { ticker: "ETN", direction: "LONG", now: t1 });
    const b = await checkAndSetEntryLock(kv, { ticker: "ETN", direction: "LONG", now: t2 });
    expect(b.ok).toBe(true);
    // lock refreshed
    expect(kv._map.get("timed:entry_lock:ETN:LONG")).toBe(String(t2));
  });

  it("windowMs can be overridden for shorter tests", async () => {
    const kv = makeKv();
    const t1 = 1784700000000;
    const t2 = t1 + 30 * 1000; // 30s later
    await checkAndSetEntryLock(kv, { ticker: "ETN", direction: "LONG", now: t1, windowMs: 60_000 });
    const b = await checkAndSetEntryLock(kv, { ticker: "ETN", direction: "LONG", now: t2, windowMs: 60_000 });
    expect(b.ok).toBe(false);
  });

  it("different tickers do NOT share a lock", async () => {
    const kv = makeKv();
    const t1 = 1784700000000;
    await checkAndSetEntryLock(kv, { ticker: "ETN", direction: "LONG", now: t1 });
    const b = await checkAndSetEntryLock(kv, { ticker: "XLK", direction: "LONG", now: t1 + 1000 });
    expect(b.ok).toBe(true);
  });

  it("different directions on the same ticker do NOT share a lock (LONG vs SHORT flip)", async () => {
    const kv = makeKv();
    const t1 = 1784700000000;
    await checkAndSetEntryLock(kv, { ticker: "ETN", direction: "LONG", now: t1 });
    const b = await checkAndSetEntryLock(kv, { ticker: "ETN", direction: "SHORT", now: t1 + 1000 });
    expect(b.ok).toBe(true);
  });

  it("fail-OPEN on KV read error (4-hour ENTER_COOLDOWN is the backstop)", async () => {
    const kv = makeKv({ failGet: true });
    const r = await checkAndSetEntryLock(kv, { ticker: "ETN", direction: "LONG", now: 1784700000000 });
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/^lock_error:/);
  });

  it("no-op with no KV binding (dev / test)", async () => {
    const r = await checkAndSetEntryLock(null, { ticker: "ETN", direction: "LONG", now: 1784700000000 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("no_kv");
  });

  it("entryLockKey normalizes ticker + direction case", () => {
    expect(entryLockKey("etn", "long")).toBe("timed:entry_lock:ETN:LONG");
    expect(entryLockKey("ETN", "LONG")).toBe("timed:entry_lock:ETN:LONG");
  });
});
