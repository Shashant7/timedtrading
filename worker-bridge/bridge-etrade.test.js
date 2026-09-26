import { describe, it, expect } from "vitest";
import * as Etrade from "./bridge-etrade.js";
import { brokerMeta, resolveBrokerId, resolveBrokerAccountId } from "./bridge-brokers.js";
import { normalizeOrderIntent, planBrokerOrder } from "./bridge-order-plan.js";
import { etradeConsumerConfigured, etradeApiBase } from "./bridge-etrade-config.js";

describe("E*TRADE registry", () => {
  it("lists etrade as scaffold with market equity adapter", () => {
    const meta = brokerMeta("etrade");
    expect(meta?.label).toBe("E*TRADE");
    expect(meta?.status).toBe("scaffold");
    expect(meta?.capabilities?.adapter?.equity?.market).toBe(true);
  });

  it("resolves broker id + account from user row", () => {
    const user = { broker: "etrade", etrade_account_id: "ET-123" };
    expect(resolveBrokerId(user)).toBe("etrade");
    expect(resolveBrokerAccountId(user)).toBe("ET-123");
  });
});

describe("E*TRADE mock adapter", () => {
  const env = { BROKER_BRIDGE_MOCK: "true" };
  const user = { broker: "etrade", etrade_account_id: "MOCK_ETRADE" };

  it("reviews and places mock equity orders", async () => {
    const order = { ticker: "AAPL", side: "buy", qty: 2 };
    const preview = await Etrade.reviewOrder(env, user, order);
    expect(preview.ok).toBe(true);
    expect(preview.mock).toBe(true);
    const placed = await Etrade.placeOrder(env, user, order);
    expect(placed.ok).toBe(true);
    expect(placed.response.order_id).toMatch(/^MOCK-ET-/);
    expect(placed.response.filled_qty).toBe(2);
  });

  it("returns empty mock positions + portfolio", async () => {
    const port = await Etrade.getPortfolio(env, user);
    expect(port.ok).toBe(true);
    expect(port.response.equity).toBe(100000);
    const pos = await Etrade.getEquityPositions(env, user);
    expect(pos.ok).toBe(true);
    expect(pos.positions).toEqual([]);
  });

  it("plans a market buy for etrade", () => {
    const intent = normalizeOrderIntent({ ticker: "MSFT", side: "buy", qty: 1 });
    const plan = planBrokerOrder("etrade", intent);
    expect(plan.ok).toBe(true);
    expect(plan.primary.order_type).toBe("market");
  });
});

describe("E*TRADE config", () => {
  it("defaults to sandbox API host", () => {
    expect(etradeApiBase({})).toBe("https://apisb.etrade.com");
    expect(etradeApiBase({ ETRADE_SANDBOX: "false" })).toBe("https://api.etrade.com");
  });

  it("requires both consumer key and secret", () => {
    expect(etradeConsumerConfigured({})).toBe(false);
    expect(etradeConsumerConfigured({ ETRADE_CONSUMER_KEY: "k" })).toBe(false);
    expect(etradeConsumerConfigured({
      ETRADE_CONSUMER_KEY: "k",
      ETRADE_CONSUMER_SECRET: "s",
    })).toBe(true);
  });
});
