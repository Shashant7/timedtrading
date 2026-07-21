import { describe, it, expect } from "vitest";
import { recordSilentFailure, readSilentFailures, SILENT_FAILURE_RING_KEY } from "./silent-failure-log.js";

// In-memory KV stub with optional fault injection.
function makeKv({ failGet = false, failPut = false, seed = null } = {}) {
  const map = new Map();
  if (seed != null) map.set(SILENT_FAILURE_RING_KEY, typeof seed === "string" ? seed : JSON.stringify(seed));
  return {
    _map: map,
    async get(k) { if (failGet) throw new Error("kv get boom"); return map.get(k) ?? null; },
    async put(k, v) { if (failPut) throw new Error("kv put boom"); map.set(k, v); },
  };
}

describe("silent-failure-log — durable breadcrumb ring", () => {
  it("records a breadcrumb to KV and reads it back (newest first)", async () => {
    const env = { KV_TIMED: makeKv() };
    await recordSilentFailure(env, { stage: "entry_finalize.parity", ticker: "neu", error: new Error("boom") });
    await recordSilentFailure(env, { stage: "entry_finalize.exec_meta", ticker: "amzn", error: "kaput" });
    const rows = await readSilentFailures(env);
    expect(rows.length).toBe(2);
    expect(rows[0].stage).toBe("entry_finalize.exec_meta");
    expect(rows[0].ticker).toBe("AMZN");
    expect(rows[1].stage).toBe("entry_finalize.parity");
    expect(rows[1].ticker).toBe("NEU");
    expect(String(rows[1].error)).toContain("boom");
    expect(typeof rows[0].ts).toBe("number");
  });

  it("bounds the ring to 100 entries (drops oldest)", async () => {
    const env = { KV_TIMED: makeKv() };
    for (let i = 0; i < 130; i++) {
      await recordSilentFailure(env, { stage: `s${i}`, error: `e${i}` });
    }
    const rows = await readSilentFailures(env, { limit: 500 });
    expect(rows.length).toBe(100);
    expect(rows[0].stage).toBe("s129"); // newest
    expect(rows[99].stage).toBe("s30"); // 100 most-recent kept
  });

  it("filters by stage substring", async () => {
    const env = { KV_TIMED: makeKv() };
    await recordSilentFailure(env, { stage: "entry_finalize.parity", error: "a" });
    await recordSilentFailure(env, { stage: "bridge.forward", error: "b" });
    const rows = await readSilentFailures(env, { stage: "entry_finalize" });
    expect(rows.length).toBe(1);
    expect(rows[0].stage).toBe("entry_finalize.parity");
  });

  it("NEVER throws even when KV.get fails (observability must not add failures)", async () => {
    const env = { KV_TIMED: makeKv({ failGet: true }) };
    const entry = await recordSilentFailure(env, { stage: "x", error: "y" });
    expect(entry.stage).toBe("x");
    // recovery path resets the ring to just this entry
    expect(env.KV_TIMED._map.get(SILENT_FAILURE_RING_KEY)).toContain("\"stage\":\"x\"");
  });

  it("NEVER throws when KV.put fails", async () => {
    const env = { KV_TIMED: makeKv({ failPut: true }) };
    await expect(recordSilentFailure(env, { stage: "x", error: "y" })).resolves.toBeTruthy();
  });

  it("tolerates a corrupt (non-JSON / non-array) ring and self-heals", async () => {
    const env = { KV_TIMED: makeKv({ seed: "not json {{{" }) };
    await recordSilentFailure(env, { stage: "recovered", error: "z" });
    const rows = await readSilentFailures(env);
    expect(rows.length).toBe(1);
    expect(rows[0].stage).toBe("recovered");
  });

  it("returns [] and does not throw when no KV binding is present", async () => {
    const entry = await recordSilentFailure({}, { stage: "no_kv", error: "e" });
    expect(entry.stage).toBe("no_kv");
    expect(await readSilentFailures({})).toEqual([]);
  });

  it("truncates oversized error strings", async () => {
    const env = { KV_TIMED: makeKv() };
    await recordSilentFailure(env, { stage: "big", error: "x".repeat(5000) });
    const rows = await readSilentFailures(env);
    expect(rows[0].error.length).toBeLessThanOrEqual(800);
  });
});
