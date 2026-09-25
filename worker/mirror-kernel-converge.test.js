// worker/mirror-kernel-converge.test.js — the main worker's converge driver.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { d1Sqlite } from "./test-support/d1-sqlite.js";
import { recordModelLeg, _resetKernelSchemaForTest } from "./mirror-kernel.js";
import {
  convergeIndexDtPositions,
  describeConvergeLag,
  unconvergedAccounts,
  CONVERGE_ALERT_AFTER_MS,
} from "./mirror-kernel-converge.js";

vi.mock("./alerts.js", () => ({ notifyDiscord: vi.fn(async () => ({ ok: true })) }));

const SID = "dt:IWM:2026-09-24:2026-09-25:P:279";
const T0 = Date.UTC(2026, 8, 24, 14, 0, 0);
const PID = `${SID}@${T0}`;

function kv() {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, _m: m };
}

async function seedStop(db, stopAt) {
  await recordModelLeg(db, { signalId: SID, entryTs: T0, ticker: "IWM", event: "BUY", openedQty: 2, remainingAfter: 2, now: T0 });
  await recordModelLeg(db, { signalId: SID, entryTs: T0, ticker: "IWM", event: "STOP", openedQty: 2, remainingAfter: 0, now: stopAt });
}

const quote = async () => ({ mid: 0.5, bid: 0.48 });

describe("convergeIndexDtPositions", () => {
  let env;
  beforeEach(() => {
    _resetKernelSchemaForTest();
    env = { DB: d1Sqlite(), KV_TIMED: kv(), ADMIN_EMAIL: "op@x.com" };
  });

  it("sends each due position with the model's size and a marketable close", async () => {
    await seedStop(env.DB, T0 + 60_000);
    const sent = [];
    const out = await convergeIndexDtPositions(env, {
      now: T0 + 3 * 60_000,
      resolvePremium: quote,
      converge: async (p) => { sent.push(p); return { ok: true, response: { ok: true, all_verified: false, results: [] } }; },
    });
    expect(out.due).toBe(1);
    expect(sent[0]).toMatchObject({
      position_id: PID, trade_id: SID, leg_seq: 1,
      model: { opened_qty: 2, remaining_qty: 0 },
    });
    expect(sent[0].close_play.legs[0]).toMatchObject({ action: "SELL", optionType: "PUT", strike: 279 });
    // Through the 0.48 bid by the cushion.
    expect(sent[0].close_play.premium.mid).toBeLessThan(0.48);
  });

  it("marks the position verified once every account is confirmed", async () => {
    await seedStop(env.DB, T0 + 60_000);
    const verified = async () => ({ ok: true, response: { ok: true, all_verified: true, results: [
      { account_id: "A", action: "verified" }, { account_id: "B", action: "never_opened" },
    ] } });
    const first = await convergeIndexDtPositions(env, { now: T0 + 3 * 60_000, resolvePremium: quote, converge: verified });
    expect(first.verified).toEqual([PID]);
    const again = await convergeIndexDtPositions(env, { now: T0 + 4 * 60_000, resolvePremium: quote, converge: verified });
    expect(again.due).toBe(0);
  });

  it("books an owner-account converge sell into the lane's own ledger", async () => {
    await seedStop(env.DB, T0 + 60_000);
    const applyOwnerFill = vi.fn(async () => ({ applied: true }));
    await convergeIndexDtPositions(env, {
      now: T0 + 3 * 60_000,
      resolvePremium: quote,
      applyOwnerFill,
      converge: async () => ({ ok: true, response: { ok: true, all_verified: false, results: [
        { account_id: "A", is_owner: true, action: "sell", sold: { ok: true, qty: 2, fill: { status: "filled", filled_qty: 2, avg_price: 0.47 } } },
        { account_id: "B", is_owner: false, action: "sell", sold: { ok: true, qty: 2, fill: { status: "filled", filled_qty: 2 } } },
      ] } }),
    });
    expect(applyOwnerFill).toHaveBeenCalledTimes(1);
    expect(applyOwnerFill).toHaveBeenCalledWith(SID, { filledQty: 2, price: 0.47, event: "STOP" });
  });

  it("pages once when an account is still not flat ten minutes after the stop", async () => {
    const { notifyDiscord } = await import("./alerts.js");
    notifyDiscord.mockClear();
    await seedStop(env.DB, T0 + 60_000);
    const behind = async () => ({ ok: true, response: { ok: true, all_verified: false, results: [
      { account_id: "A", is_owner: true, action: "verified", held: 0, target: 0 },
      { account_id: "B", user_id: "p@x.com#webull#cash", action: "sell", held: 2, target: 0, sold: { ok: false, reason: "positions_unavailable" } },
    ] } });
    await convergeIndexDtPositions(env, { now: T0 + 5 * 60_000, resolvePremium: quote, converge: behind });
    expect(notifyDiscord).not.toHaveBeenCalled();
    const late = T0 + 60_000 + CONVERGE_ALERT_AFTER_MS + 1;
    await convergeIndexDtPositions(env, { now: late, resolvePremium: quote, converge: behind });
    await convergeIndexDtPositions(env, { now: late + 60_000, resolvePremium: quote, converge: behind });
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    const [, embed] = notifyDiscord.mock.calls[0];
    expect(embed.description).toContain("1/2 accounts confirmed");
    expect(embed.description).toContain("sell refused (positions_unavailable)");
  });

  it("skips a position it cannot price rather than guessing", async () => {
    await seedStop(env.DB, T0 + 60_000);
    const converge = vi.fn();
    const out = await convergeIndexDtPositions(env, {
      now: T0 + 3 * 60_000, resolvePremium: async () => ({ mid: null }), converge,
    });
    expect(converge).not.toHaveBeenCalled();
    expect(out.skipped[0].reason).toBe("no_live_premium");
  });

  it("does nothing without D1 or an operator", async () => {
    expect((await convergeIndexDtPositions({ KV_TIMED: kv() })).due).toBe(0);
  });
});

describe("describing a lag", () => {
  it("lists only the accounts that are behind", () => {
    const results = [
      { account_id: "A", action: "verified" },
      { account_id: "B", action: "wait", reason: "order_in_flight", held: 2, target: 0 },
      { account_id: "C", action: "unknown", held: null, reason: "holdings_unreadable" },
    ];
    expect(unconvergedAccounts(results).map((r) => r.account_id)).toEqual(["B", "C"]);
    const text = describeConvergeLag({ last_event: "STOP", signal_id: SID }, results);
    expect(text).toContain("1/3 accounts confirmed");
    expect(text).toContain("holdings unreadable");
  });
});

describe("applyKernelOwnerFill", () => {
  function kvStore(seed = {}) {
    const m = new Map(Object.entries(seed));
    return {
      get: async (k) => (m.has(k) ? m.get(k) : null),
      getWithMetadata: async (k) => ({ value: m.has(k) ? m.get(k) : null, metadata: null }),
      put: async (k, v) => { m.set(k, v); },
      delete: async (k) => { m.delete(k); },
      list: async () => ({ keys: [], list_complete: true }),
      _m: m,
    };
  }

  it("brings the lane's mirror to what the owner's account now holds", async () => {
    const { applyKernelOwnerFill } = await import("./options-auto-mirror.js");
    const KV = kvStore({
      [`timed:opt-dt-mirror:${SID}`]: JSON.stringify({
        entry_fired: true, contracts: 2, contracts_remaining: 2, entry_premium: 0.64,
      }),
    });
    const r = await applyKernelOwnerFill({ KV_TIMED: KV, ADMIN_EMAIL: "op@x.com" }, SID, {
      filledQty: 2, price: 0.47, event: "STOP",
    });
    expect(r).toMatchObject({ applied: true, remaining: 0 });
    const saved = JSON.parse(KV._m.get(`timed:opt-dt-mirror:${SID}`));
    expect(saved).toMatchObject({ contracts_remaining: 0, exit_fired: true, exit_via: "kernel_converge", exit_premium: 0.47 });
  });

  it("leaves a lane with no mirrored entry alone", async () => {
    const { applyKernelOwnerFill } = await import("./options-auto-mirror.js");
    const r = await applyKernelOwnerFill({ KV_TIMED: kvStore(), ADMIN_EMAIL: "op@x.com" }, SID, { filledQty: 1, price: 1 });
    expect(r.applied).toBe(false);
  });
});
