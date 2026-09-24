// worker-bridge/bridge-options-risk.test.js
//
// 2026-09-24 — per-account daily loss budget for options mirrors.
//
// `daily_loss_limit_usd` had been stored on every bridge row, defaulted to
// $500 and shown in the UI since the day it was added, and enforced
// nowhere. Harmless while options were operator-only; not harmless once
// they fan out to partners.
//
// The point of this module is that it does NOT reimplement the operator's
// budget — it runs the same one against BRIDGE_KV. These tests exist to
// prove the partner's ledger behaves like the Roth's, so the first two
// assertions below are about equivalence, not about new rules.
import { describe, it, expect } from "vitest";
import {
  budgetContractsFor,
  commitPartnerRisk,
  settlePartnerRisk,
  releasePartnerRisk,
  partnerRiskSnapshot,
  riskEnvFor,
  riskAccountId,
} from "./bridge-options-risk.js";
import { riskBudgetSnapshot, loadRiskState } from "../worker/options-risk-budget.js";

function kv() {
  const s = new Map();
  return {
    store: s,
    get: async (k) => (s.has(k) ? s.get(k) : null),
    put: async (k, v) => { s.set(k, v); },
    delete: async (k) => { s.delete(k); },
    list: async ({ prefix = "" } = {}) => ({
      keys: [...s.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}
const env = () => ({ BRIDGE_KV: kv() });

// Live partner row (2026-09-24): $500 day stop, $500 per-order cap.
const partner = {
  user_id: "shahpritesh206@gmail.com#webull#individual-cash",
  options_prefs: {
    vehicles: { long_put: { enabled: true, max_per_order_usd: 500 } },
    daily_loss_limit_usd: 500,
  },
};
const SIG = "dt:IWM:2026-09-24:2026-09-25:P:279";

describe("the partner ledger is the operator's ledger", () => {
  it("writes to BRIDGE_KV, never the main worker's namespace", () => {
    const e = env();
    expect(riskEnvFor(e).KV_TIMED).toBe(e.BRIDGE_KV);
    expect(riskEnvFor({}).KV_TIMED).toBeNull();
  });

  it("keys the ledger per ACCOUNT, so two partners never share a budget", () => {
    expect(riskAccountId(partner)).toBe(partner.user_id);
    expect(riskAccountId({ user_id: "OTHER@Z.com#webull#x" })).toBe("other@z.com#webull#x");
  });

  it("reports the same snapshot shape the operator's budget does", async () => {
    const e = env();
    const snap = await partnerRiskSnapshot(e, partner);
    expect(snap).toMatchObject({
      limit_usd: 500, open_usd: 0, realized_loss_usd: 0,
      consumed_usd: 0, remaining_usd: 500, enforced: true,
    });
    expect(Object.keys(snap).sort())
      .toEqual(Object.keys(riskBudgetSnapshot({ open: {} }, 500)).sort());
  });
});

describe("budgetContractsFor", () => {
  it("allows the full size on a clean day", async () => {
    const out = await budgetContractsFor(env(), partner, { contracts: 2, premium: 0.64 });
    expect(out.contracts).toBe(2);
    expect(out.budget.remaining_usd).toBe(500);
  });

  it("treats a zero limit as the gate being off", async () => {
    const off = { ...partner, options_prefs: { ...partner.options_prefs, daily_loss_limit_usd: 0 } };
    const out = await budgetContractsFor(env(), off, { contracts: 9, premium: 0.64 });
    expect(out).toMatchObject({ contracts: 9, reason: "budget_off" });
  });

  // Charging the debit rather than the stop distance is the 2026-09-23 bug
  // the operator's module was written to fix; the partner inherits the fix.
  it("charges the stop distance, not the whole debit", async () => {
    const e = env();
    // $2.00 premium = $200 debit a contract, $100 of stop risk at -50%.
    await commitPartnerRisk(e, partner, SIG, { contracts: 2, premium: 2.0 });
    const snap = await partnerRiskSnapshot(e, partner);
    expect(snap.open_usd).toBe(200);
    expect(snap.remaining_usd).toBe(300);
  });

  it("caps the next entry at what the day can still afford", async () => {
    const e = env();
    await commitPartnerRisk(e, partner, SIG, { contracts: 4, premium: 2.0 }); // $400 open
    const out = await budgetContractsFor(e, partner, { contracts: 3, premium: 2.0 });
    expect(out.contracts).toBe(1); // $100 left, $100 a contract
    expect(out.reason).toBe("capped_by_daily_loss_budget");
  });

  it("stops the account for the day once the budget is gone", async () => {
    const e = env();
    await commitPartnerRisk(e, partner, SIG, { contracts: 10, premium: 1.0 }); // $500 open
    const out = await budgetContractsFor(e, partner, { contracts: 1, premium: 1.0 });
    expect(out.contracts).toBe(0);
    expect(out.reason).toMatch(/^daily_loss_budget_0_left_of_500$/);
  });

  it("does not invent a charge when the premium is unpriceable", async () => {
    const out = await budgetContractsFor(env(), partner, { contracts: 2, premium: 0 });
    expect(out).toMatchObject({ contracts: 2, reason: "no_premium_for_budget" });
  });
});

describe("settling a partner close", () => {
  it("gives the risk back on a win, so a good day does not throttle itself", async () => {
    const e = env();
    await commitPartnerRisk(e, partner, SIG, { contracts: 2, premium: 1.0 });
    expect((await partnerRiskSnapshot(e, partner)).remaining_usd).toBe(400);
    // Closed both at 1.60 from 1.00: +$120.
    await settlePartnerRisk(e, partner, SIG, { closedQty: 2, closePremium: 1.6, heldBefore: 2 });
    const snap = await partnerRiskSnapshot(e, partner);
    expect(snap.open_usd).toBe(0);
    expect(snap.realized_pnl_usd).toBe(120);
    expect(snap.remaining_usd).toBe(500);
  });

  it("keeps consuming on a loss, so a bad day tightens until it stops", async () => {
    const e = env();
    await commitPartnerRisk(e, partner, SIG, { contracts: 2, premium: 1.0 });
    await settlePartnerRisk(e, partner, SIG, { closedQty: 2, closePremium: 0.5, heldBefore: 2 });
    const snap = await partnerRiskSnapshot(e, partner);
    expect(snap.realized_loss_usd).toBe(100);
    expect(snap.remaining_usd).toBe(400);
  });

  it("re-prices what is still held after a partial trim", async () => {
    const e = env();
    await commitPartnerRisk(e, partner, SIG, { contracts: 4, premium: 1.0 }); // $200 open
    await settlePartnerRisk(e, partner, SIG, { closedQty: 2, closePremium: 1.5, heldBefore: 4 });
    const snap = await partnerRiskSnapshot(e, partner);
    expect(snap.open_usd).toBe(100); // 2 still held at $50 of stop risk each
    expect(snap.realized_pnl_usd).toBe(100);
  });

  // The basis has to survive the round trip: a partner has no
  // timed:opt-dt-mirror record to recover it from.
  it("remembers the entry basis across the close", async () => {
    const e = env();
    await commitPartnerRisk(e, partner, SIG, { contracts: 1, premium: 0.64 });
    const state = await loadRiskState(riskEnvFor(e), riskAccountId(partner));
    expect(state.open[SIG].meta.basis).toBe(0.64);
  });

  it("assumes the hard stop when no close price is known", async () => {
    const e = env();
    await commitPartnerRisk(e, partner, SIG, { contracts: 2, premium: 1.0 });
    await settlePartnerRisk(e, partner, SIG, { closedQty: 2, closePremium: 0, heldBefore: 2 });
    expect((await partnerRiskSnapshot(e, partner)).realized_loss_usd).toBe(100);
  });

  it("ignores a settle for a position it never charged", async () => {
    const e = env();
    const r = await settlePartnerRisk(e, partner, SIG, { closedQty: 1, closePremium: 1 });
    expect(r).toBeNull();
    expect((await partnerRiskSnapshot(e, partner)).consumed_usd).toBe(0);
  });
});

describe("idempotency and release", () => {
  it("does not double-charge a replayed entry", async () => {
    const e = env();
    await commitPartnerRisk(e, partner, SIG, { contracts: 2, premium: 1.0 });
    await commitPartnerRisk(e, partner, SIG, { contracts: 2, premium: 1.0 });
    expect((await partnerRiskSnapshot(e, partner)).open_usd).toBe(100);
  });

  it("refunds an entry that never became a position", async () => {
    const e = env();
    await commitPartnerRisk(e, partner, SIG, { contracts: 2, premium: 1.0 });
    await releasePartnerRisk(e, partner, SIG);
    expect((await partnerRiskSnapshot(e, partner)).remaining_usd).toBe(500);
  });

  it("keeps two accounts' budgets independent", async () => {
    const e = env();
    const other = { ...partner, user_id: "someone@else.com#webull#individual-cash" };
    await commitPartnerRisk(e, partner, SIG, { contracts: 10, premium: 1.0 });
    expect((await partnerRiskSnapshot(e, partner)).remaining_usd).toBe(0);
    expect((await partnerRiskSnapshot(e, other)).remaining_usd).toBe(500);
  });
});
