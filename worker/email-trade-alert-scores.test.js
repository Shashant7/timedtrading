import { describe, it, expect } from "vitest";
import { collectTradeAlertSignalQualityLines, sendTradeAlertEmail } from "./email.js";
import { buildPaperLaneEmailAlert } from "./paper-lane-notify.js";

const TQQQ_EXIT = {
  type: "TRADE_EXIT",
  ticker: "TQQQ",
  direction: "LONG",
  price: 69.59,
  entry: 70.04,
  exit: 69.59,
  pnlPct: -0.64,
  exitReason: "underlying_invalidation",
  setup_name: "TT Index Swings LETF",
  rank: 81,
  conviction_score: 74,
  conviction_tier: "B",
  rr: 2.2,
  mode: "trader",
  trade_id: "TQQQ:LONG:2026-W3",
  action_ts: Date.parse("2026-09-10T18:00:00Z"),
};

describe("trade alert signal quality", () => {
  it("collects rank + conviction + R:R when lines are absent", () => {
    const lines = collectTradeAlertSignalQualityLines({
      rank: 81,
      conviction_score: 74,
      conviction_tier: "B",
      rr: 2.2,
    });
    expect(lines).toEqual([
      "Signal Strength (Rank): 81/100",
      "Conviction: 74 (B)",
      "Risk/Reward: 2.2:1",
    ]);
  });

  it("renders Signal Quality on a TQQQ Index Swings close email", async () => {
    const r = await sendTradeAlertEmail({ EMAIL_RETURN_BODY: true }, "ops@example.com", TQQQ_EXIT);
    expect(r.ok).toBe(true);
    expect(r.html).toContain("Signal Quality");
    expect(r.html).toContain("81/100");
    expect(r.html).toContain("Conviction");
    expect(r.html).toContain("74");
    expect(r.html).toContain("(B)");
    expect(r.text).toContain("Signal quality:");
    expect(r.text).toContain("Signal Strength (Rank): 81/100");
  });

  it("omits Signal Quality when an exit has no scores", async () => {
    const r = await sendTradeAlertEmail({ EMAIL_RETURN_BODY: true }, "ops@example.com", {
      type: "TRADE_EXIT",
      ticker: "TQQQ",
      direction: "LONG",
      price: 69.59,
      entry: 70.04,
      exit: 69.59,
      pnlPct: -0.64,
      mode: "trader",
    });
    expect(r.html).not.toContain("Signal Quality");
    expect(r.text).not.toContain("Signal quality:");
  });

  it("keeps Signal Quality on entries", async () => {
    const r = await sendTradeAlertEmail({ EMAIL_RETURN_BODY: true }, "ops@example.com", {
      type: "TRADE_ENTRY",
      ticker: "AAPL",
      direction: "LONG",
      price: 175.5,
      entry: 175.5,
      rank: 78,
      conviction_score: 72,
      conviction_tier: "B",
      mode: "trader",
    });
    expect(r.html).toContain("Signal Quality");
    expect(r.html).toContain("78/100");
  });
});

describe("paper-lane exit scores", () => {
  it("pulls rank/conviction off the Index Swings book for the close email", () => {
    const alert = buildPaperLaneEmailAlert({
      engine: "index_trend_letf",
      event: "EXIT",
      ticker: "QQQ",
      vehicleTicker: "TQQQ",
      direction: "LONG",
      price: 69.59,
      qty: 12,
      reason: "underlying_invalidation",
      signal_id: "TQQQ:LONG:2026-W3",
      book: {
        entry_letf_price: 70.04,
        shares: 12,
        shares_remaining: 0,
        rank: 81,
        conviction_score: 74,
        conviction_tier: "B",
        rr: 2.2,
      },
    });
    expect(alert.type).toBe("TRADE_EXIT");
    expect(alert.rank).toBe(81);
    expect(alert.conviction_score).toBe(74);
    expect(alert.conviction_tier).toBe("B");
    expect(alert.signal_quality_lines).toEqual([
      "Signal Strength (Rank): 81/100",
      "Conviction: 74 (B)",
      "Risk/Reward: 2.2:1",
    ]);
  });

  it("uses live ticker scores when the book was never stamped", () => {
    const alert = buildPaperLaneEmailAlert({
      engine: "index_trend_letf",
      event: "STOP",
      ticker: "QQQ",
      vehicleTicker: "TQQQ",
      direction: "LONG",
      price: 69.59,
      book: { entry_letf_price: 70.04, shares: 12 },
      tickerData: {
        rank: 64,
        __focus_conviction_score: 71,
        __focus_tier: "b",
      },
      play: { suitability: 82 },
    });
    expect(alert.rank).toBe(64);
    expect(alert.conviction_score).toBe(71);
    expect(alert.conviction_tier).toBe("B");
    expect(alert.signal_quality_lines.some((l) => l.includes("LETF Suitability: 82/100"))).toBe(true);
  });
});
