// worker/sanity-sweep-2026-09-22-incidents.test.js
//
// The 09:04 sweep on 2026-09-22 reported "1 fails · 3 warns · 4 open".
// Three of the four incidents were the sweep misreading a healthy system,
// and the fourth was real but had been filed under a classification that
// guaranteed it would never be retried.
//
// The ring rows below are the verbatim 13-row six-hour window the sweep
// actually evaluated, lifted from the production KV `bridge:client:recent`
// (newest row 2026-09-22T16:11:41Z). Keeping them literal is the point: the
// bugs were all in what the checks BELIEVED about these shapes.

import { describe, it, expect } from "vitest";
import {
  evaluateBrokerRejectDensity,
  isExpectedBridgeReject,
} from "./sanity-sweep.js";
import { ringScaleShortfall } from "./mirror-coverage.js";
import { classifyBridgeOutcome } from "./broker-intents.js";
import {
  clampExitOpsToHoldings,
  exitResidualBelowBrokerMinimum,
} from "./trader-exit-catchup.js";
import { healUnknownSectorMapKeys } from "./registry-alignment.js";

const NOW = 1790093501396; // 2026-09-22T16:11:41Z — newest row in the ring

/** The exact six-hour window the 2026-09-22 sweep evaluated. */
const LIVE_RING = [
  { ts: 1790085878797, ticker: "LITE", side: "trim", status: "error", trade_id: "inv-LITE-auto-1789668205711", qty: 0.5669, reject_reason: "Please do not place an order repeatedly", bridge_scaled_qty: 0.13929 },
  { ts: 1790085878797, ticker: "EXEL", side: "trim", status: "pending", trade_id: "inv-EXEL-auto-1787234562461", qty: 27.65215 },
  { ts: 1790085894781, ticker: "AMZN", side: "sell", status: "ok", trade_id: "inv-AMZN-auto-1787580143836", qty: 24.1458, bridge_scaled_qty: 5.73194 },
  { ts: 1790085910909, ticker: "UNP", side: "exit", status: "error", trade_id: "UNP-1786730641396-bl2td32wf", qty: 1.90357, reject_reason: "no_broker_position" },
  { ts: 1790085922050, ticker: "DPZ", side: "exit", status: "error", trade_id: "DPZ-1787578665830-9812wt90w", qty: 1e-05, reject_reason: "The minimum notional amount of a fractional sell order is $0.01. " },
  { ts: 1790086516017, ticker: "LITE", side: "trim", status: "ok", trade_id: "inv-LITE-auto-1789668205711", qty: 0.5669, bridge_scaled_qty: 0.13929 },
  { ts: 1790086531223, ticker: "EXEL", side: "trim", status: "ok", trade_id: "inv-EXEL-auto-1787234562461", qty: 27.65215, bridge_scaled_qty: 4.39557 },
  { ts: 1790086535786, ticker: "HOOD", side: "buy", status: "ok", trade_id: "inv-HOOD-auto-1790086478840", qty: 50.8155, bridge_scaled_qty: 13 },
  { ts: 1790086542161, ticker: "HOOD", side: "buy", status: "ok", trade_id: "inv-HOOD-auto-1790086478840", qty: 50.8155, bridge_scaled_qty: 13 },
  { ts: 1790088077414, ticker: "JD", side: "exit", status: "error", trade_id: "JD-1787771266981-u2at5rskh", qty: 15.194805194805204, reject_reason: "no_manifest_for_trade" },
  { ts: 1790089456029, ticker: "MU", side: "trim", status: "error", trade_id: "inv-MU-auto-1789653815233", qty: 0.91295, reject_reason: "Please do not place an order repeatedly", bridge_scaled_qty: 0.22386 },
  { ts: 1790093481536, ticker: "P", side: "exit", status: "ok", trade_id: "P-1790010212349-ak4kvq5e1", qty: 13.29963157894738, bridge_scaled_qty: 3 },
  { ts: 1790093501396, ticker: "CVNA", side: "exit", status: "pending", trade_id: "CVNA-1788549015440-k7mm9vxrz", qty: 3.749499265589533 },
];

describe("model_broker_coverage — relational sizing is not a partial mirror", () => {
  // The three rows the sweep called "mirrored only in part". Each is a
  // model-book qty next to a correctly sized ~30% account sleeve.
  const LIVE_ENTRIES = [
    { ticker: "NBIS", qty: 9.98335901386749, bridge_scaled_qty: 3, bridge_scale_reason: null },
    { ticker: "P", qty: 13.29963157894738, bridge_scaled_qty: 3, bridge_scale_reason: null },
    { ticker: "MSFT", qty: 10.0887, bridge_scaled_qty: 3, bridge_scale_reason: null },
  ];

  it("does not flag the NBIS / P / MSFT entries that failed the sweep", () => {
    for (const row of LIVE_ENTRIES) {
      expect(ringScaleShortfall(row), `${row.ticker} should not read as a partial`).toBeNull();
    }
  });

  it("stays quiet for every scaled row in the live window", () => {
    const flagged = LIVE_RING
      .filter((r) => r.bridge_scaled_qty != null)
      .map((r) => ({ ticker: r.ticker, reason: ringScaleShortfall(r) }))
      .filter((r) => r.reason);
    expect(flagged).toEqual([]);
  });

  it("still reports a cap the bridge actually named", () => {
    // TNA W37: 31 shares asked, 5 placed by the concentration ceiling on a
    // $14.8k Roth. The bridge names this one, so it is worth an operator.
    expect(ringScaleShortfall({
      qty: 31, bridge_scaled_qty: 5, bridge_scale_reason: "concentration",
    })).toBe("broker_scaled_to_5_of_31_16pct_concentration");
    expect(ringScaleShortfall({
      qty: 100, bridge_scaled_qty: 10, bridge_scale_reason: "cap_per_order",
    })).toBe("broker_scaled_to_10_of_100_10pct_cap_per_order");
    expect(ringScaleShortfall({
      qty: 20, bridge_scaled_qty: 4, bridge_scale_reason: "cap_per_order+concentration",
    })).toContain("concentration");
  });

  it("ignores fractional rounding and unscaled rows either way", () => {
    expect(ringScaleShortfall({ qty: 10, bridge_scaled_qty: 9.999, bridge_scale_reason: "cap_per_order" })).toBeNull();
    expect(ringScaleShortfall({ qty: 10 })).toBeNull();
  });
});

describe("broker_bridge_bindings — terminal rejects are not bindings failures", () => {
  it("treats the JD and DPZ rejects as expected, and the MU throttle as not", () => {
    expect(isExpectedBridgeReject({ reject_reason: "no_manifest_for_trade" })).toBe(true);
    expect(isExpectedBridgeReject({
      reject_reason: "The minimum notional amount of a fractional sell order is $0.01. ",
    })).toBe(true);
    // Still a real miss: the model trimmed and the broker did not.
    expect(isExpectedBridgeReject({
      reject_reason: "Please do not place an order repeatedly",
    })).toBe(false);
  });

  it("keeps the rejects it already knew, and still fails an actual binding fault", () => {
    expect(isExpectedBridgeReject({ reject_reason: "no_broker_position" })).toBe(true);
    expect(isExpectedBridgeReject({
      reject_reason: "Only limit orders are supported for extended-hours trading",
    })).toBe(true);
    expect(isExpectedBridgeReject({ reject_reason: "hmac_mismatch" })).toBe(false);
    expect(isExpectedBridgeReject({ error: "fetch_error" })).toBe(false);
    expect(isExpectedBridgeReject({})).toBe(false);
  });

  it("replays the live window to no anomaly (was: 3 unresolved of 13)", () => {
    expect(evaluateBrokerRejectDensity({ ring: LIVE_RING, nowMs: NOW })).toEqual([]);
  });

  it("still pages when three genuinely unresolved failures land", () => {
    const ring = [
      { ts: NOW - 1000, ticker: "AAA", side: "buy", status: "error", trade_id: "a", reject_reason: "hmac_mismatch" },
      { ts: NOW - 2000, ticker: "BBB", side: "buy", status: "error", trade_id: "b", reject_reason: "hmac_mismatch" },
      { ts: NOW - 3000, ticker: "CCC", side: "buy", status: "fetch_error", trade_id: "c", error: "ECONNRESET" },
    ];
    const an = evaluateBrokerRejectDensity({ ring, nowMs: NOW });
    expect(an).toHaveLength(1);
    expect(an[0].detail).toContain("3 unresolved bridge mirror failures");
  });
});

describe("MU — a Webull submit throttle must be retried, not retired", () => {
  it("classifies PLACE_ORDER_REPEAT as transient so the intent survives", () => {
    expect(classifyBridgeOutcome({
      ok: false,
      http_status: 200,
      response: { reject_reason: "Please do not place an order repeatedly" },
    })).toBe("transient");
  });

  it("leaves the other 2xx outcomes exactly as they were", () => {
    // A bare 2xx with nothing to act on still retires — the BG EXIT loop.
    expect(classifyBridgeOutcome({ ok: false, http_status: 200, response: {} })).toBe("terminal");
    expect(classifyBridgeOutcome({
      ok: false, http_status: 200, response: { reject_reason: "no_manifest_for_trade" },
    })).toBe("terminal");
    expect(classifyBridgeOutcome({ ok: true })).toBe("placed");
  });
});

describe("DPZ — a residual worth less than a cent is flat", () => {
  it("knows 1e-05 DPZ shares cannot clear a $0.01 floor", () => {
    expect(exitResidualBelowBrokerMinimum(1e-05, 400)).toBe(true);
  });

  it("does not call an unknown price dust", () => {
    expect(exitResidualBelowBrokerMinimum(1e-05, null)).toBe(false);
    expect(exitResidualBelowBrokerMinimum(1e-05, 0)).toBe(false);
  });

  it("leaves a real sub-share exit alone", () => {
    // The 09-15 DPZ exit that worked: 0.2714 sh ≈ $108.
    expect(exitResidualBelowBrokerMinimum(0.2714, 400)).toBe(false);
    // A penny stock sleeve is still tradeable at a large share count.
    expect(exitResidualBelowBrokerMinimum(50, 0.02)).toBe(false);
  });

  it("drops the DPZ op instead of re-offering it every hour", () => {
    const ops = [{
      trade_id: "DPZ-1787578665830-9812wt90w",
      ticker: "DPZ",
      qty: 1e-05,
      price: null,
      exit_ts: 0,
    }];
    const held = { DPZ: { qty: 1e-05, avg_cost: 398.12 } };
    const { ops: kept, dropped } = clampExitOpsToHoldings(ops, held);
    expect(kept).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].skip).toBe("broker_min_notional_dust");
    expect(dropped[0].residual_usd).toBeLessThan(0.01);
  });

  it("still dispatches a genuine leftover on the same ticker", () => {
    const ops = [{ trade_id: "t1", ticker: "DPZ", qty: 0.2714, price: 398.12, exit_ts: 1 }];
    const held = { DPZ: { qty: 0.2714, avg_cost: 398.12 } };
    const { ops: kept, dropped } = clampExitOpsToHoldings(ops, held);
    expect(kept).toHaveLength(1);
    expect(dropped).toEqual([]);
  });

  it("does not strand an exit when the broker could not be read", () => {
    // held == null: no price, no holdings. The op must survive.
    const ops = [{ trade_id: "t1", ticker: "AMZN", qty: 0.5, price: null, exit_ts: 1 }];
    const { ops: kept } = clampExitOpsToHoldings(ops, null);
    expect(kept).toHaveLength(1);
  });
});

describe("registry_alignment — a ticker with no overlay has nothing to heal", () => {
  function fakeKv(store) {
    const deletes = [];
    return {
      deletes,
      async get(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
      async delete(key) { deletes.push(key); delete store[key]; },
    };
  }

  it("does not report tickers that never had an overlay", async () => {
    const kv = fakeKv({});
    const healed = await healUnknownSectorMapKeys(kv, ["AA", "ABT", "ACN", "ADBE", "AGQ"]);
    expect(healed).toEqual([]);
    expect(kv.deletes).toEqual([]);
  });

  it("still deletes an overlay that really is Unknown", async () => {
    const kv = fakeKv({
      "timed:sector_map:AA": "Unknown",
      "timed:sector_map:ABT": "n/a",
      "timed:sector_map:ACN": "",
      "timed:sector_map:ADBE": "Information Technology",
    });
    const healed = await healUnknownSectorMapKeys(kv, ["AA", "ABT", "ACN", "ADBE", "NOKEY"]);
    expect(healed).toEqual(["AA", "ABT", "ACN"]);
    expect(kv.deletes).toEqual([
      "timed:sector_map:AA",
      "timed:sector_map:ABT",
      "timed:sector_map:ACN",
    ]);
  });

  it("settles to a no-op on the next sweep", async () => {
    const store = { "timed:sector_map:AA": "Unknown" };
    const kv = fakeKv(store);
    const tickers = ["AA", "ABT", "ACN"];
    expect(await healUnknownSectorMapKeys(kv, tickers)).toEqual(["AA"]);
    expect(await healUnknownSectorMapKeys(kv, tickers)).toEqual([]);
  });
});
