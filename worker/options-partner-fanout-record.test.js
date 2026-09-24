// worker/options-partner-fanout-record.test.js
//
// The bridge places the operator's option order and every partner mirror in
// one call, answering with the operator's result at the top level and
// `fanout: { accounts, results }` beside it. The main worker never read
// `fanout`, so a partner leg that failed while the operator's filled was
// neither recorded nor said out loud (2026-09-24).

import { describe, it, expect, vi } from "vitest";
import {
  summarizePartnerFanout,
  unmirroredPartnerLegs,
  recordIndexDtMirrorDecision,
  OPT_DT_MIRROR_LOG_KEY,
} from "./options-auto-mirror.js";

vi.mock("./alerts.js", () => ({
  notifyDiscord: vi.fn(async () => ({ ok: true })),
}));

const PARTNER = "shahpritesh206@gmail.com#webull#individual-cash";

function firedWith(results) {
  return {
    ok: true,
    status: 200,
    response: {
      ok: true,
      fill: { status: "filled", filled_qty: 1, order_id: "OP1" },
      fanout: { accounts: results.length, results },
    },
  };
}

function kvEnv() {
  const store = new Map();
  return {
    _store: store,
    KV_TIMED: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); },
      delete: async (k) => { store.delete(k); },
    },
  };
}

describe("summarizePartnerFanout", () => {
  it("returns nothing when there are no partners", () => {
    expect(summarizePartnerFanout({ response: { ok: true } })).toEqual([]);
    expect(summarizePartnerFanout(null)).toEqual([]);
    expect(summarizePartnerFanout({ response: { fanout: { accounts: 0, results: [] } } })).toEqual([]);
  });

  it("grades a filled partner leg as mirrored", () => {
    const [leg] = summarizePartnerFanout(firedWith([{
      user_id: PARTNER,
      ok: true,
      http_status: 200,
      contracts: 1,
      result: { ok: true, fill: { status: "filled", filled_qty: 1, order_id: "P1" } },
    }]));
    expect(leg.account).toBe(PARTNER);
    expect(leg.decision).toBe("mirrored");
    expect(leg.reason).toBeNull();
    expect(leg.contracts).toBe(1);
  });

  it("grades a rejected partner leg as rejected, with the broker's reason", () => {
    const [leg] = summarizePartnerFanout(firedWith([{
      user_id: PARTNER,
      ok: false,
      http_status: 200,
      contracts: 1,
      result: { ok: false, rejected: true, reject_reason: "Please do not place an order repeatedly" },
    }]), { event: "STOP" });
    expect(leg.decision).toBe("rejected");
    expect(leg.reason).toContain("do not place an order repeatedly");
  });

  it("grades a working partner leg as pending, not filled", () => {
    const [leg] = summarizePartnerFanout(firedWith([{
      user_id: PARTNER,
      ok: true,
      contracts: 1,
      result: { ok: true, fill: { status: "working", filled_qty: 0, order_id: "P2" } },
    }]), { event: "EXIT" });
    expect(leg.decision).toBe("pending");
  });

  it("a sizing or budget gate declining an account is skipped, not failed", () => {
    const [leg] = summarizePartnerFanout(firedWith([{
      user_id: PARTNER,
      ok: false,
      skipped: true,
      reason: "account_too_small_to_mirror_9909_account_too_small_for_one_share",
    }]));
    expect(leg.decision).toBe("skipped");
    expect(leg.reason).toContain("account_too_small");
  });

  it("a leg that never got a bridge response is an error", () => {
    const [leg] = summarizePartnerFanout(firedWith([{
      user_id: null,
      owner_email: "shahpritesh206@gmail.com",
      ok: false,
      reason: "fanout_failed",
      detail: "boom",
    }]));
    expect(leg.decision).toBe("error");
    expect(leg.account).toBe("shahpritesh206@gmail.com");
    expect(leg.reason).toBe("fanout_failed");
  });

  it("grades several accounts independently", () => {
    const legs = summarizePartnerFanout(firedWith([
      { user_id: "a#webull#x", ok: true, contracts: 1, result: { ok: true, fill: { status: "filled", filled_qty: 1 } } },
      { user_id: "b#webull#y", ok: false, contracts: 1, result: { ok: false, rejected: true, reject_reason: "no_held_position" } },
    ]), { event: "STOP" });
    expect(legs.map((l) => l.decision)).toEqual(["mirrored", "rejected"]);
  });
});

describe("unmirroredPartnerLegs", () => {
  it("picks out only rejected and error legs", () => {
    const legs = [
      { account: "a", decision: "mirrored" },
      { account: "b", decision: "skipped" },
      { account: "c", decision: "pending" },
      { account: "d", decision: "rejected" },
      { account: "e", decision: "error" },
    ];
    expect(unmirroredPartnerLegs(legs).map((l) => l.account)).toEqual(["d", "e"]);
    expect(unmirroredPartnerLegs([])).toEqual([]);
  });
});

describe("recordIndexDtMirrorDecision with partners", () => {
  const ctx = {
    signal_id: "dt:QQQ:2026-09-24:2026-09-25:C:745",
    ticker: "QQQ",
    event: "STOP",
  };

  const partnerRejected = {
    skipped: false,
    fill: { status: "filled", filled_qty: 1, order_id: "OP1" },
    reconcile: { persist: true, pending: false, filledQty: 1, status: "filled" },
    close_qty: 1,
    fired: firedWith([{
      user_id: PARTNER,
      ok: false,
      contracts: 1,
      result: { ok: false, rejected: true, reject_reason: "Please do not place an order repeatedly" },
    }]),
  };

  it("records the partner leg alongside the operator's own decision", async () => {
    const env = kvEnv();
    await recordIndexDtMirrorDecision(env, ctx, partnerRejected);
    const ring = JSON.parse(env._store.get(OPT_DT_MIRROR_LOG_KEY));
    expect(ring).toHaveLength(1);
    expect(ring[0].decision).toBe("mirrored");
    expect(ring[0].partners).toHaveLength(1);
    expect(ring[0].partners[0].account).toBe(PARTNER);
    expect(ring[0].partners[0].decision).toBe("rejected");
  });

  it("pages once for a partner reduce the broker did not take", async () => {
    const { notifyDiscord } = await import("./alerts.js");
    notifyDiscord.mockClear();
    const env = kvEnv();
    await recordIndexDtMirrorDecision(env, ctx, partnerRejected);
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    const [, msg] = notifyDiscord.mock.calls[0];
    expect(msg.title).toContain("Partner STOP not mirrored");
    expect(msg.description).toContain(PARTNER);

    // Deduped per signal, event and account — the reconciler retries every
    // minute and must not retell it every minute.
    notifyDiscord.mockClear();
    await recordIndexDtMirrorDecision(env, ctx, partnerRejected);
    expect(notifyDiscord).not.toHaveBeenCalled();
  });

  it("does not page for a partner ENTRY that did not take", async () => {
    const { notifyDiscord } = await import("./alerts.js");
    notifyDiscord.mockClear();
    const env = kvEnv();
    await recordIndexDtMirrorDecision(env, { ...ctx, event: "BUY" }, {
      ...partnerRejected,
      contracts: 1,
    });
    // A missed entry costs an opportunity; there is no position to strand.
    expect(notifyDiscord).not.toHaveBeenCalled();
  });

  it("does not page when every partner leg took", async () => {
    const { notifyDiscord } = await import("./alerts.js");
    notifyDiscord.mockClear();
    const env = kvEnv();
    await recordIndexDtMirrorDecision(env, ctx, {
      ...partnerRejected,
      fired: firedWith([{
        user_id: PARTNER,
        ok: true,
        contracts: 1,
        result: { ok: true, fill: { status: "filled", filled_qty: 1, order_id: "P1" } },
      }]),
    });
    expect(notifyDiscord).not.toHaveBeenCalled();
  });

  it("omits the partners field entirely when there are none", async () => {
    const env = kvEnv();
    await recordIndexDtMirrorDecision(env, ctx, {
      skipped: false,
      fill: { status: "filled", filled_qty: 1 },
      reconcile: { persist: true, pending: false, filledQty: 1, status: "filled" },
      fired: { ok: true, response: { ok: true, fill: { status: "filled", filled_qty: 1 } } },
    });
    const ring = JSON.parse(env._store.get(OPT_DT_MIRROR_LOG_KEY));
    expect("partners" in ring[0]).toBe(false);
  });

  it("still pages the operator's own rejected reduce as well as the partner's", async () => {
    const { notifyDiscord } = await import("./alerts.js");
    notifyDiscord.mockClear();
    const env = kvEnv();
    await recordIndexDtMirrorDecision(env, ctx, {
      skipped: false,
      fill: { status: "rejected", filled_qty: 0, reason: "order_rejected" },
      reconcile: { persist: false, pending: false, filledQty: 0, status: "rejected", reason: "order_rejected" },
      fired: firedWith([{
        user_id: PARTNER,
        ok: false,
        contracts: 1,
        result: { ok: false, rejected: true, reject_reason: "order_rejected" },
      }]),
    });
    const titles = notifyDiscord.mock.calls.map(([, m]) => m.title);
    expect(titles.some((t) => t.startsWith("STOP not mirrored"))).toBe(true);
    expect(titles.some((t) => t.startsWith("Partner STOP not mirrored"))).toBe(true);
  });
});
