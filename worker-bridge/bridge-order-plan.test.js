import { describe, it, expect } from "vitest";
import {
  normalizeOrderIntent,
  planBrokerOrder,
  classifyIntent,
  summarizeOrderPlan,
} from "./bridge-order-plan.js";
import {
  brokerCapabilities,
  resolveBrokerAccountId,
  resolveBrokerId,
} from "./bridge-brokers.js";

describe("classifyIntent", () => {
  it("maps sides to lifecycle classes", () => {
    expect(classifyIntent("buy")).toBe("open");
    expect(classifyIntent("exit")).toBe("close");
    expect(classifyIntent("sell")).toBe("close");
    expect(classifyIntent("trim")).toBe("reduce");
    expect(classifyIntent("dca_buy")).toBe("add");
  });
});

describe("normalizeOrderIntent", () => {
  it("normalizes an entry with SL/TP", () => {
    const intent = normalizeOrderIntent({
      ticker: "amzn", side: "buy", qty: "17.4", sl: 243.36, tp: 267.28, entry: 251.71,
    });
    expect(intent.symbol).toBe("AMZN");
    expect(intent.qty).toBeCloseTo(17.4, 2);
    expect(intent.lifecycle).toBe("open");
    expect(intent.stop_loss).toBe(243.36);
    expect(intent.take_profit).toBe(267.28);
    expect(intent.order_kind).toBe("market");
  });

  it("maps exit side to sell/close", () => {
    const intent = normalizeOrderIntent({ ticker: "AMZN", side: "exit", qty: 17.4 });
    expect(intent.side).toBe("sell");
    expect(intent.lifecycle).toBe("close");
  });
});

describe("planBrokerOrder — respects each broker's order-type support", () => {
  const entryIntent = normalizeOrderIntent({
    ticker: "AMZN", side: "buy", qty: 17, sl: 243.36, tp: 267.28,
  });

  it("Webull adapter: market entry, protection downgrades to synthetic_engine", () => {
    const plan = planBrokerOrder("webull", entryIntent);
    expect(plan.ok).toBe(true);
    expect(plan.primary.order_type).toBe("market");
    expect(plan.protection.mode).toBe("synthetic_engine");
    expect(plan.downgrades.some((d) => d.field === "protection")).toBe(true);
  });

  it("IBKR native tier: protection uses a native bracket with SL+TP legs", () => {
    const plan = planBrokerOrder("ibkr", entryIntent, { tier: "native" });
    expect(plan.ok).toBe(true);
    expect(plan.protection.mode).toBe("native_bracket");
    expect(plan.protection.legs).toHaveLength(2);
    const stop = plan.protection.legs.find((l) => l.purpose === "stop_loss");
    expect(stop.side).toBe("sell");
    expect(stop.stop_price).toBe(243.36);
  });

  it("IBKR adapter tier (today): market-only, synthetic protection", () => {
    const plan = planBrokerOrder("ibkr", entryIntent);
    expect(plan.protection.mode).toBe("synthetic_engine");
  });

  it("limit request on a market-only adapter downgrades to market", () => {
    const intent = normalizeOrderIntent({ ticker: "AMZN", side: "buy", qty: 10, order_kind: "limit", limit_price: 250 });
    const plan = planBrokerOrder("webull", intent);
    expect(plan.primary.order_type).toBe("market");
    expect(plan.downgrades.some((d) => d.field === "order_kind")).toBe(true);
  });

  it("limit request on IBKR native tier stays limit", () => {
    const intent = normalizeOrderIntent({ ticker: "AMZN", side: "buy", qty: 10, order_kind: "limit", limit_price: 250 });
    const plan = planBrokerOrder("ibkr", intent, { tier: "native" });
    expect(plan.primary.order_type).toBe("limit");
    expect(plan.primary.limit_price).toBe(250);
  });

  it("close/exit orders carry no protection", () => {
    const intent = normalizeOrderIntent({ ticker: "AMZN", side: "exit", qty: 17 });
    const plan = planBrokerOrder("webull", intent);
    expect(plan.ok).toBe(true);
    expect(plan.primary.side).toBe("sell");
    expect(plan.protection.mode).toBe("none");
  });

  it("rejects a short on a broker that disallows shorts (Webull)", () => {
    const intent = normalizeOrderIntent({ ticker: "AMZN", side: "short", qty: 10 });
    const plan = planBrokerOrder("webull", intent);
    expect(plan.ok).toBe(false);
    expect(plan.reject_reason).toBe("shorts_unsupported");
  });

  it("rejects an unknown broker", () => {
    const plan = planBrokerOrder("etrade", entryIntent);
    expect(plan.ok).toBe(false);
    expect(plan.reject_reason).toBe("unknown_broker");
  });

  it("rejects invalid intent (no qty)", () => {
    const plan = planBrokerOrder("webull", normalizeOrderIntent({ ticker: "AMZN", side: "buy", qty: 0 }));
    expect(plan.ok).toBe(false);
    expect(plan.reject_reason).toBe("invalid_intent");
  });

  it("summary line is compact and audit-friendly", () => {
    const plan = planBrokerOrder("webull", entryIntent);
    expect(summarizeOrderPlan(plan)).toContain("webull:buy:17:market");
    expect(summarizeOrderPlan(plan)).toContain("synthetic_engine");
  });
});

describe("resolveBrokerAccountId — agnostic account id", () => {
  it("prefers webull_account_id (previously dropped to 'default')", () => {
    expect(resolveBrokerAccountId({ webull_account_id: "WB123", broker: "webull" })).toBe("WB123");
  });
  it("uses ibkr_account_id", () => {
    expect(resolveBrokerAccountId({ ibkr_account_id: "U555" })).toBe("U555");
  });
  it("uses rh_account_number", () => {
    expect(resolveBrokerAccountId({ rh_account_number: "RH999" })).toBe("RH999");
  });
  it("falls back to 'default' when nothing present", () => {
    expect(resolveBrokerAccountId({})).toBe("default");
    expect(resolveBrokerAccountId(null)).toBe("default");
  });
});

describe("resolveBrokerId", () => {
  it("reads explicit broker, then infers from account fields", () => {
    expect(resolveBrokerId({ broker: "IBKR" })).toBe("ibkr");
    expect(resolveBrokerId({ webull_account_id: "x" })).toBe("webull");
    expect(resolveBrokerId({ ibkr_account_id: "x" })).toBe("ibkr");
    expect(resolveBrokerId({ rh_account_number: "x" })).toBe("robinhood");
    expect(resolveBrokerId({})).toBe(null);
  });
});

describe("brokerCapabilities tiers", () => {
  it("adapter tier is market-only for equity across brokers today", () => {
    for (const b of ["ibkr", "robinhood", "webull"]) {
      const caps = brokerCapabilities(b, "adapter");
      expect(caps.equity.market).toBe(true);
      expect(caps.equity.limit).toBe(false);
      expect(caps.bracket).toBe(false);
    }
  });
  it("native tier exposes the broker's real order-type roadmap", () => {
    expect(brokerCapabilities("ibkr", "native").bracket).toBe(true);
    expect(brokerCapabilities("ibkr", "native").equity.limit).toBe(true);
    expect(brokerCapabilities("webull", "native").equity.limit).toBe(true);
  });
});
