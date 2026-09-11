import { describe, it, expect } from "vitest";
import {
  loadRotationSnapshot,
  runRotationSnapshot,
  SNAPSHOT_PERSIST_TTL_SECONDS,
  SNAPSHOT_TTL_SECONDS,
} from "./rotation-engine.js";

function makeKv() {
  const store = new Map();
  const puts = [];
  return {
    _store: store,
    _puts: puts,
    async get(k) { return store.get(k) ?? null; },
    async put(k, v, opts) {
      store.set(k, v);
      puts.push({ k, opts });
    },
  };
}

function makeEnv(over = {}) {
  return {
    KV: makeKv(),
    DB: null,
    ...over,
  };
}

describe("rotation snapshot persistence", () => {
  it("keeps recompute freshness at 30 min and persists the KV row for 7 days", () => {
    expect(SNAPSHOT_TTL_SECONDS).toBe(30 * 60);
    expect(SNAPSHOT_PERSIST_TTL_SECONDS).toBe(7 * 24 * 3600);
  });

  it("writes the snapshot with the 7-day persist TTL", async () => {
    const env = makeEnv();
    const snap = await runRotationSnapshot(env, { force: true });
    expect(snap.ok).toBe(true);
    expect(env.KV._puts[0].k).toBe("timed:cro:rotation-snapshot");
    expect(env.KV._puts[0].opts.expirationTtl).toBe(SNAPSHOT_PERSIST_TTL_SECONDS);
    const loaded = await loadRotationSnapshot(env);
    expect(loaded.computed_at).toBe(snap.computed_at);
  });

  it("computes on read when the cache is empty", async () => {
    const env = makeEnv();
    const missing = await loadRotationSnapshot(env);
    expect(missing).toBe(null);
    const computed = await loadRotationSnapshot(env, { computeIfMissing: true });
    expect(computed.ok).toBe(true);
    expect(computed.universe_size).toBeGreaterThan(0);
    expect(env.KV._puts.length).toBe(1);
  });

  it("reads from KV_TIMED when env.KV is unset", async () => {
    const kv = makeKv();
    await kv.put("timed:cro:rotation-snapshot", JSON.stringify({
      ok: true, computed_at: 1, headlines: ["cached"],
    }));
    const loaded = await loadRotationSnapshot({ KV_TIMED: kv });
    expect(loaded.headlines).toEqual(["cached"]);
  });
});
