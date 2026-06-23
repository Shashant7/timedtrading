import { describe, it, expect } from "vitest";
import {
  buildSignal,
  renderDiscordTitle,
  renderEmailSubject,
  formatTradeCloseTitle,
  formatExitRecommendedTitle,
  classifyActivityEvent,
  traderLaneMeta,
  investorLaneMeta,
} from "./signal-grammar.js";

describe("buildSignal", () => {
  it("marks recommended exit as doing", () => {
    const s = buildSignal({ engine: "trader", execState: "recommended", action: "exit", ticker: "MU" });
    expect(s.mode).toBe("doing");
    expect(s.execState).toBe("recommended");
  });
});

describe("formatTradeCloseTitle", () => {
  it("explains final runner slice after prior trim", () => {
    const title = formatTradeCloseTitle({
      ticker: "MU",
      direction: "LONG",
      status: "WIN",
      pnlPct: 42.97,
      exitPrice: 1097.14,
      trimmedPct: 0.75,
    });
    expect(title).toContain("Full exit +42.97%");
    expect(title).toContain("final 25% runner");
    expect(title).toContain("trimming 75%");
    expect(title).not.toMatch(/Closed 25%/);
  });
});

describe("formatExitRecommendedTitle", () => {
  it("uses recommended exec state grammar", () => {
    expect(formatExitRecommendedTitle("MU")).toContain("RECOMMENDED");
    expect(formatExitRecommendedTitle("MU")).toContain("TRADER · DOING");
  });
});

describe("classifyActivityEvent", () => {
  it("classifies exit signal as recommended doing", () => {
    const c = classifyActivityEvent({ type: "TRADE_EXIT_SIGNAL", ticker: "MU" });
    expect(c.mode).toBe("doing");
    expect(c.execState).toBe("recommended");
  });

  it("classifies filled exit as done doing", () => {
    const c = classifyActivityEvent({ type: "TRADE_EXIT", ticker: "MU" });
    expect(c.mode).toBe("doing");
    expect(c.execState).toBe("done");
  });

  it("classifies investor rebalance add as done doing", () => {
    const c = classifyActivityEvent({
      type: "INVESTOR_SIGNAL",
      ticker: "CRDO",
      investor_alert_type: "position_add",
      shares: 25.1,
      price: 279.05,
    });
    expect(c.label).toBe("ADD");
    expect(c.mode).toBe("doing");
    expect(c.execState).toBe("done");
  });

  it("classifies investor zone alert as watching", () => {
    const c = classifyActivityEvent({
      type: "INVESTOR_SIGNAL",
      ticker: "SOFI",
      investor_alert_type: "accumulation_zone",
    });
    expect(c.label).toBe("WATCH");
    expect(c.mode).toBe("watching");
  });
});

describe("lane meta bands", () => {
  it("marks trader setup as watching", () => {
    expect(traderLaneMeta("setup").band).toBe("watching");
  });
  it("marks trader exiting as doing", () => {
    expect(traderLaneMeta("exiting").band).toBe("doing");
  });
  it("marks investor accumulate as doing", () => {
    expect(investorLaneMeta("accumulate").band).toBe("doing");
  });
});

describe("renderEmailSubject", () => {
  it("uses bracket grammar", () => {
    const subj = renderEmailSubject(buildSignal({
      engine: "trader",
      mode: "doing",
      execState: "done",
      action: "exit",
      ticker: "MU",
      direction: "LONG",
      pnlPct: 42.97,
    }));
    expect(subj).toMatch(/^\[TRADER · DOING\]/);
  });
});
