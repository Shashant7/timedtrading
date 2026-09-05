import { describe, it, expect, vi } from "vitest";

vi.mock("./options-auto-mirror.js", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    fireAutoMirror: vi.fn(async () => ({ ok: true, status: 200, response: { fill: { status: "filled", filled_qty: 1, order_id: "wb-1" } } })),
    loadAutoMirrorPrefs: vi.fn(async () => ({
      enabled: true,
      vehicles: { lotto: { enabled: true, daily_cap: 1, max_per_order_usd: 250, max_loss_per_order_usd: 250 } },
    })),
  };
});

import {
  convexityMirrorDecision,
  mirrorContractsFor,
  ticketBuyLimit,
  buildTicketCloseOrder,
  mirrorConvexityTicketEntry,
  mirrorConvexityTicketClose,
  forwardOptionsClose,
} from "./convexity-mirror.js";
import { fireAutoMirror, loadAutoMirrorPrefs } from "./options-auto-mirror.js";
import { isReducerOrder, intentWindowOpen, classifyBridgeOutcome, OPTIONS_CLOSE_KIND } from "./broker-intents.js";

const ticket = {
  id: "cx:DELL:2026-09-04:475C", ticker: "DELL", side: "C", strike: 475, expiration: "2026-09-04",
  entry_premium: 2.1, contracts: 1, mark_premium: 2.1, mirror_contracts: 0,
};

describe("convexityMirrorDecision", () => {
  it("is off until the desk is graded", () => {
    expect(convexityMirrorDecision({ closed_n: 0 })).toMatchObject({ enabled: false, reason: "graded_0_of_20" });
    expect(convexityMirrorDecision({ closed_n: 25, median_pnl_pct: -4, win_rate_pct: 45 }).enabled).toBe(false);
    expect(convexityMirrorDecision({ closed_n: 25, median_pnl_pct: 12, win_rate_pct: 35 }).enabled).toBe(false);
    expect(convexityMirrorDecision({ closed_n: 25, median_pnl_pct: 12, win_rate_pct: 45 }).enabled).toBe(true);
  });
  it("operator flag overrides both ways", () => {
    expect(convexityMirrorDecision({ closed_n: 0 }, { CONVEXITY_MIRROR: "true" })).toMatchObject({ enabled: true, reason: "forced_on" });
    expect(convexityMirrorDecision({ closed_n: 99, median_pnl_pct: 50, win_rate_pct: 80 }, { CONVEXITY_MIRROR: "false" }).enabled).toBe(false);
  });
});

describe("sizing and limits", () => {
  it("never buys a lot the vehicle cap cannot cover", () => {
    expect(mirrorContractsFor({ entry_premium: 2.1, contracts: 1 }, { max_per_order_usd: 250, max_loss_per_order_usd: 250 })).toBe(1);
    expect(mirrorContractsFor({ entry_premium: 3.0, contracts: 1 }, { max_per_order_usd: 250, max_loss_per_order_usd: 250 })).toBe(0);
    expect(mirrorContractsFor({ entry_premium: 0.5, contracts: 4 }, { max_per_order_usd: 250, max_loss_per_order_usd: 100 })).toBe(2);
  });
  it("buy limit is mid plus a tick, capped at the ask", () => {
    expect(ticketBuyLimit(2.1)).toBe(2.16);
    expect(ticketBuyLimit(2.1, 2.12)).toBe(2.12);
    expect(ticketBuyLimit(0.4)).toBe(0.41);
    expect(ticketBuyLimit(4.0)).toBe(4.1);
  });
});

describe("mirrorConvexityTicketEntry", () => {
  it("skips without a grade, places when forced on with the vehicle enabled", async () => {
    const off = await mirrorConvexityTicketEntry({ ADMIN_EMAIL: "op@x" }, ticket, { report: { closed_n: 3 } });
    expect(off.mirror_status).toBe("skipped:graded_3_of_20");
    expect(fireAutoMirror).not.toHaveBeenCalled();

    const on = await mirrorConvexityTicketEntry({ ADMIN_EMAIL: "op@x", CONVEXITY_MIRROR: "true" }, ticket, { report: null });
    expect(on).toMatchObject({ mirror_status: "placed", mirror_contracts: 1, mirror_order_id: "wb-1" });
    const payload = fireAutoMirror.mock.calls[0][2];
    expect(payload).toMatchObject({ vehicle: "lotto", lifecycle: "entry", side: "buy", buy_limit: 2.16 });
    expect(payload.play.legs[0]).toMatchObject({ action: "BUY", optionType: "CALL", strike: 475, qty: 1 });
  });
  it("respects the operator vehicle toggle", async () => {
    loadAutoMirrorPrefs.mockResolvedValueOnce({ enabled: true, vehicles: { lotto: { enabled: false } } });
    const r = await mirrorConvexityTicketEntry({ ADMIN_EMAIL: "op@x", CONVEXITY_MIRROR: "true" }, ticket, {});
    expect(r.mirror_status).toBe("skipped:vehicle_lotto_disabled");
  });
});

describe("ticket close -> options intent", () => {
  it("builds an options_close order the intent ledger accepts, windowed to the options sell window", () => {
    const order = buildTicketCloseOrder({ ...ticket, mirror_contracts: 2 }, { mark: 1.0, reason: "premium_stop", operatorEmail: "op@x" });
    expect(order._kind).toBe(OPTIONS_CLOSE_KIND);
    expect(order.qty).toBe(2);
    expect(order.limit_price).toBeGreaterThan(0);
    expect(order.limit_price).toBeLessThanOrEqual(1.0);
    expect(isReducerOrder(order)).toBe(true);
    const intentRow = { lane: OPTIONS_CLOSE_KIND, qty: 2 };
    // 11:00 ET Thu -> open; 16:30 ET -> closed (equity follow-through would still be open).
    expect(intentWindowOpen(intentRow, new Date("2026-09-03T15:00:00Z"))).toBe(true);
    expect(intentWindowOpen(intentRow, new Date("2026-09-03T20:30:00Z"))).toBe(false);
    expect(intentWindowOpen({ lane: "trader", qty: 2 }, new Date("2026-09-03T20:30:00Z"))).toBe(true);
  });
  it("forwardOptionsClose normalizes a reject so the drain classifies it", async () => {
    fireAutoMirror.mockResolvedValueOnce({ ok: false, status: 400, response: { reject_reason: "position_zero" } });
    const order = buildTicketCloseOrder({ ...ticket, mirror_contracts: 1 }, { mark: 1.0, reason: "expiry", operatorEmail: "op@x" });
    const res = await forwardOptionsClose({}, order);
    expect(res.ok).toBe(false);
    expect(classifyBridgeOutcome(res)).toBe("terminal");
  });
  it("mirrorConvexityTicketClose is a no-op without a broker leg", async () => {
    const r = await mirrorConvexityTicketClose({}, ticket, { mark: 1, reason: "expiry" });
    expect(r).toEqual({ mirrored: false, reason: "no_broker_leg" });
  });
});
