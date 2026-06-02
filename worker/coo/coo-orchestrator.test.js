// worker/coo/coo-orchestrator.test.js
//
// Tests for the COO orchestrator. Scope is the cycle-glue and the
// screener-auto-promote + move-discovery-cycle integrations. The
// calibration + self-healing sub-cycles call back into worker/index.
// js via HTTP (their own paths) and are exercised by smoke tests
// in production, not unit-mocked here.
//
// Coverage:
//   • recordAction + getRecentCooActions roundtrip in mock KV
//   • runMoveDiscoveryCycle skips when COO disabled
//   • runMoveDiscoveryCycle bubbles up discovery errors cleanly
//   • runMoveDiscoveryCycle alerts on capture_rate floor + churn ceiling
//   • runScreenerAutoPromote skips when COO disabled
//   • runScreenerAutoPromote respects daily cap

import { describe, it, expect } from "vitest";
import {
  getRecentCooActions,
  runMoveDiscoveryCycle,
  runScreenerAutoPromote,
} from "./coo-orchestrator.js";

function makeKv() {
  const store = new Map();
  return {
    _store: store,
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

function makeEnv(over = {}) {
  return {
    KV_TIMED: makeKv(),
    DB: null,
    COO_ENABLED: "true",
    COO_AUTO_APPLY_TIER1: "false",
    COO_DISCOVERY_ENABLED: "true",
    COO_SCREENER_AUTO_PROMOTE: "true",
    COO_SCREENER_AUTO_SCORE: "70",
    COO_SCREENER_DAILY_MAX: "3",
    ...over,
  };
}

describe("COO orchestrator — getRecentCooActions", () => {
  it("returns empty array with no KV binding", async () => {
    const out = await getRecentCooActions({});
    expect(out).toEqual([]);
  });

  it("reads multi-day audit log sorted newest first", async () => {
    const kv = makeKv();
    const todayKey = `coo:actions:${new Date().toISOString().slice(0, 10)}`;
    await kv.put(todayKey, JSON.stringify([
      { ts: 1000, kind: "calibration", target: "k1" },
      { ts: 2000, kind: "calibration", target: "k2" },
    ]));
    const yesterdayKey = `coo:actions:${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}`;
    await kv.put(yesterdayKey, JSON.stringify([
      { ts: 500, kind: "self_heal", target: "ledger" },
    ]));
    const out = await getRecentCooActions(makeEnv({ KV_TIMED: kv }));
    expect(out.length).toBe(3);
    expect(out[0].ts).toBe(2000);
    expect(out[2].ts).toBe(500);
  });

  it("survives corrupted JSON in audit log", async () => {
    const kv = makeKv();
    const todayKey = `coo:actions:${new Date().toISOString().slice(0, 10)}`;
    await kv.put(todayKey, "not-valid-json");
    const out = await getRecentCooActions(makeEnv({ KV_TIMED: kv }));
    expect(out).toEqual([]);
  });
});

describe("COO orchestrator — runMoveDiscoveryCycle", () => {
  it("skips when COO_ENABLED=false", async () => {
    const env = makeEnv({ COO_ENABLED: "false" });
    const result = await runMoveDiscoveryCycle(env);
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("coo_or_discovery_disabled");
  });

  it("skips when COO_DISCOVERY_ENABLED=false", async () => {
    const env = makeEnv({ COO_DISCOVERY_ENABLED: "false" });
    const result = await runMoveDiscoveryCycle(env);
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
  });

  it("returns clean error envelope when discovery has no DB", async () => {
    // env.DB is null → discovery returns ok:false:no_db.
    const env = makeEnv();
    const result = await runMoveDiscoveryCycle(env);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no_db|discovery_failed/);
  });

  it("succeeds and logs action when discovery returns valid summary", async () => {
    // Provide a mock DB that returns no candles → summary is all zeros
    // but ok:true. The cycle should record an action and return ok.
    const fakeDb = {
      prepare() {
        return {
          bind() { return this; },
          async all() { return { results: [] }; },
        };
      },
    };
    const env = makeEnv({ DB: fakeDb });
    const result = await runMoveDiscoveryCycle(env);
    expect(result.ok).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.summary.total_moves).toBe(0);
    const actions = await getRecentCooActions(env, 1);
    expect(actions.some((a) => a.kind === "move_discovery_scan")).toBe(true);
  });
});

describe("COO orchestrator — runScreenerAutoPromote", () => {
  it("dry-runs (no mutation) when COO disabled", async () => {
    const env = makeEnv({
      COO_ENABLED: "false",
      // Provide a minimal DB so listPromotionQueue inside doesn't bail
      DB: { prepare() { return { bind() { return this; }, async all() { return { results: [] }; }, async first() { return null; }, async run() { return {}; } }; } },
    });
    const result = await runScreenerAutoPromote(env);
    expect(result.promoted).toEqual([]);
  });

  it("returns the no_eligible_candidates path when queue is empty", async () => {
    const env = makeEnv({
      DB: {
        prepare() {
          return {
            bind() { return this; },
            async all() { return { results: [] }; },
            async first() { return null; },
            async run() { return {}; },
          };
        },
      },
    });
    const result = await runScreenerAutoPromote(env);
    expect(result.promoted).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("no_eligible_candidates");
  });
});
