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
  isActionableFeedEvent,
  isActionableNotification,
  shouldNotifyKanbanStageTransition,
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
    expect(title).toContain("Exit: MU LONG");
    expect(title).toContain("Full exit +42.97%");
    expect(title).toContain("final 25% runner");
    expect(title).toContain("trimming 75%");
    expect(title).not.toMatch(/Closed 25%/);
    expect(title).not.toContain("DOING");
  });
});

describe("formatExitRecommendedTitle", () => {
  it("uses Warning label for exit recommendations", () => {
    expect(formatExitRecommendedTitle("MU")).toContain("Warning");
    expect(formatExitRecommendedTitle("MU")).toContain("Exit recommended");
    expect(formatExitRecommendedTitle("MU")).not.toContain("DOING");
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
      action: "MODEL · ON RADAR",
    });
    expect(c.label).toBe("WATCH");
    expect(c.mode).toBe("watching");
  });

  it("classifies investor accumulate-ready as recommended doing", () => {
    const c = classifyActivityEvent({
      type: "INVESTOR_SIGNAL",
      ticker: "SOFI",
      investor_alert_type: "accumulation_zone",
      action: "MODEL · QUEUE",
    });
    expect(c.label).toBe("QUEUE");
    expect(c.execState).toBe("recommended");
    expect(c.mode).toBe("doing");
  });

  it("classifies investor rebalance open as BOUGHT done doing", () => {
    const c = classifyActivityEvent({
      type: "INVESTOR_SIGNAL",
      ticker: "FIX",
      investor_alert_type: "position_open",
      shares: 3.58,
      price: 1957.31,
    });
    expect(c.label).toBe("BOUGHT");
    expect(c.mode).toBe("doing");
    expect(c.execState).toBe("done");
  });
});

describe("isActionableFeedEvent", () => {
  it("excludes trader exit signal advisories", () => {
    expect(isActionableFeedEvent({ type: "TRADE_EXIT_SIGNAL", ticker: "PKG" })).toBe(false);
    expect(isActionableFeedEvent({ type: "KANBAN_EXIT", ticker: "PKG" })).toBe(false);
  });

  it("includes trader lot fills and investor executions", () => {
    expect(isActionableFeedEvent({ type: "TRADE_EXIT", ticker: "MU" })).toBe(true);
    expect(isActionableFeedEvent({
      type: "INVESTOR_SIGNAL",
      ticker: "CRDO",
      investor_alert_type: "position_add",
    })).toBe(true);
  });

  it("excludes passive on-radar investor alerts", () => {
    expect(isActionableFeedEvent({
      type: "INVESTOR_SIGNAL",
      ticker: "FSLR",
      action: "MODEL · ON RADAR",
      investor_alert_type: "accumulation_zone",
    })).toBe(false);
    expect(isActionableFeedEvent({
      type: "INVESTOR_SIGNAL",
      ticker: "NVDA",
      action: "MODEL · WATCH",
      investor_alert_type: "rs_breakout",
    })).toBe(false);
  });

  it("excludes investor reduce/queue/review warnings", () => {
    expect(isActionableFeedEvent({
      type: "INVESTOR_SIGNAL",
      ticker: "TWLO",
      action: "MODEL · REDUCE",
      investor_alert_type: "thesis_invalidation",
    })).toBe(false);
    expect(isActionableFeedEvent({
      type: "INVESTOR_SIGNAL",
      ticker: "SOFI",
      action: "MODEL · QUEUE",
      investor_alert_type: "accumulation_zone",
    })).toBe(false);
    expect(isActionableFeedEvent({
      type: "INVESTOR_SIGNAL",
      ticker: "SPY",
      action: "MODEL · REVIEW",
      investor_alert_type: "rebalancing",
    })).toBe(false);
  });

  it("includes executed investor rebalance fills", () => {
    expect(isActionableFeedEvent({
      type: "INVESTOR_SIGNAL",
      ticker: "FIX",
      action: "MODEL · BOUGHT",
      investor_alert_type: "position_open",
    })).toBe(true);
    expect(isActionableFeedEvent({
      type: "INVESTOR_SIGNAL",
      ticker: "TWLO",
      action: "MODEL · EXITED",
      investor_alert_type: "position_close",
    })).toBe(true);
  });
});

describe("isActionableNotification", () => {
  it("excludes passive investor, setup kanban, and lane advisories", () => {
    expect(isActionableNotification({
      type: "investor_signal",
      title: "INVESTOR · ON RADAR: FSLR",
    })).toBe(false);
    expect(isActionableNotification({
      type: "kanban",
      title: "Setup: AAPL",
      body: "AAPL moved to setup (from new)",
    })).toBe(false);
    expect(isActionableNotification({
      type: "kanban",
      title: "Exit signal: PKG",
      body: "PKG moved to exit (from defend)",
    })).toBe(false);
    expect(isActionableNotification({
      type: "kanban",
      title: "Under Review: MU",
      body: "MU moved to in_review (from enter)",
    })).toBe(false);
  });

  it("includes executed trade alerts only", () => {
    expect(isActionableNotification({ type: "trade_entry", title: "Enter MU" })).toBe(true);
    expect(isActionableNotification({ type: "trade_exit", title: "Exit PKG LONG" })).toBe(true);
    expect(isActionableNotification({ type: "trade_trim", title: "Trim MU" })).toBe(true);
  });

  it("excludes investor reduce warnings from bell", () => {
    expect(isActionableNotification({
      type: "investor_signal",
      title: "INVESTOR · REDUCE: TWLO",
      body: "The TT Investor model moved TWLO to Reduce",
    })).toBe(false);
  });

  it("includes executed investor fills in bell", () => {
    expect(isActionableNotification({
      type: "investor_signal",
      title: "INVESTOR · BOUGHT: FIX",
    })).toBe(true);
    expect(isActionableNotification({
      type: "investor_signal",
      title: "INVESTOR · EXITED: TWLO",
    })).toBe(true);
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
  it("uses simple action grammar without DOING prefix", () => {
    const subj = renderEmailSubject(buildSignal({
      engine: "trader",
      mode: "doing",
      execState: "done",
      action: "exit",
      ticker: "MU",
      direction: "LONG",
      pnlPct: 42.97,
    }));
    expect(subj).toMatch(/^Exit MU LONG/);
    expect(subj).not.toContain("DOING");
  });

  it("uses Warning for recommended exits", () => {
    const subj = renderEmailSubject(buildSignal({
      engine: "trader",
      execState: "recommended",
      action: "exit",
      ticker: "GEV",
    }));
    expect(subj).toContain("Warning");
    expect(subj).not.toContain("DOING");
  });
});

describe("shouldNotifyKanbanStageTransition", () => {
  it("blocks exit advisory outside RTH", () => {
    expect(shouldNotifyKanbanStageTransition("exit", false)).toBe(false);
    expect(shouldNotifyKanbanStageTransition("exit", true)).toBe(true);
  });

  it("allows hold transitions regardless of session", () => {
    expect(shouldNotifyKanbanStageTransition("hold", false)).toBe(true);
    expect(shouldNotifyKanbanStageTransition("just_entered", false)).toBe(true);
  });
});
