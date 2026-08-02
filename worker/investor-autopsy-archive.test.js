import { describe, it, expect } from "vitest";
import {
  monthRangeMs,
  isInvestorAutopsyRunId,
  isLiveAutopsyRunId,
  shouldIncludeOpenAutopsyTrades,
  mapInvestorPositionToAutopsyTrade,
  summarizeAutopsyTrades,
  normalizeImportedInvestorTrades,
  buildInvestorAutopsyRunMeta,
  buildAutopsyRunMeta,
} from "./investor-autopsy-archive.js";

describe("investor-autopsy-archive", () => {
  it("parses month bounds", () => {
    const r = monthRangeMs("2025-07");
    expect(r.startDate).toBe("2025-07-01");
    expect(r.endDate).toBe("2025-07-31");
    expect(r.endMsExclusive).toBeGreaterThan(r.startMs);
    // Jul 1 2025 20:00 UTC (preprod entry) is inside the month window
    expect(1751400000000).toBeGreaterThanOrEqual(r.startMs);
    expect(1751400000000).toBeLessThan(r.endMsExclusive);
  });

  it("detects investor/live autopsy run ids and include-open policy", () => {
    expect(isInvestorAutopsyRunId("investor-slice-2025-07-post890")).toBe(true);
    expect(isInvestorAutopsyRunId("live-long-term-2026-07")).toBe(true);
    expect(isInvestorAutopsyRunId("phase-c-slice-2025-07-v1")).toBe(false);
    expect(isLiveAutopsyRunId("live-short-term-2026-07")).toBe(true);
    expect(shouldIncludeOpenAutopsyTrades({ runId: "investor-slice-2025-07-post890" })).toBe(true);
    expect(shouldIncludeOpenAutopsyTrades({ runId: "live-short-term-2026-07" })).toBe(true);
    expect(shouldIncludeOpenAutopsyTrades({ runId: "phase-c-slice-2025-07-v1" })).toBe(false);
    expect(shouldIncludeOpenAutopsyTrades({ runId: "phase-c-slice-2025-07-v1", includeOpen: true })).toBe(true);
    expect(shouldIncludeOpenAutopsyTrades({ tags: ["investor"] })).toBe(true);
  });

  it("builds live short-term run metadata", () => {
    const meta = buildAutopsyRunMeta({
      runId: "live-short-term-2026-07",
      month: "2026-07",
      tradeCount: 32,
      source: "trades_live",
      mode: "trader",
      horizon: "short_term",
      live: true,
    });
    expect(meta.mode).toBe("trader");
    expect(meta.horizon).toBe("short_term");
    expect(meta.tags).toContain("live");
    expect(meta.tags).toContain("include_open");
    expect(meta.start_date).toBe("2026-07-01");
    expect(meta.end_date).toBe("2026-07-31");
  });

  it("maps closed investor position to WIN/LOSS with entry/exit from lots", () => {
    const trade = mapInvestorPositionToAutopsyTrade(
      {
        id: "inv-pos-AMD-2025-07-01",
        ticker: "AMD",
        status: "CLOSED",
        avg_entry: 136.11,
        first_entry_ts: 1751400000000,
        closed_at: 1753992000000,
        investor_stage: "accumulate",
      },
      [
        { action: "BUY", shares: 36.73, price: 136.11, value: 5000, ts: 1751400000000, reason: "investor_buy" },
        { action: "SELL", shares: 36.73, price: 176.31, value: 6475, ts: 1753992000000, reason: "slice_month_end" },
      ],
    );
    expect(trade.trade_id).toBe("inv-pos-AMD-2025-07-01");
    expect(trade.status).toBe("WIN");
    expect(trade.entry_path).toBe("investor_long_term");
    expect(trade.setup_name).toBe("Investor Long Term");
    expect(trade.exit_reason).toBe("slice_month_end");
    expect(trade.pnl).toBeGreaterThan(0);
    expect(trade.pnl_pct).toBeGreaterThan(0);
  });

  it("keeps OPEN positions as OPEN (no exit)", () => {
    const trade = mapInvestorPositionToAutopsyTrade(
      {
        id: "inv-pos-PH-2025-07-30",
        ticker: "PH",
        status: "OPEN",
        avg_entry: 700,
        total_shares: 7,
        first_entry_ts: 1753833600000,
      },
      [{ action: "BUY", shares: 7, price: 700, value: 4900, ts: 1753833600000, reason: "investor_buy" }],
    );
    expect(trade.status).toBe("OPEN");
    expect(trade.exit_ts).toBeNull();
    expect(trade.pnl).toBeNull();
  });

  it("maps MNST loser correctly", () => {
    const trade = mapInvestorPositionToAutopsyTrade(
      { id: "inv-pos-MNST-2025-07-01", ticker: "MNST", status: "CLOSED", avg_entry: 63.54, first_entry_ts: 1751400000000 },
      [
        { action: "BUY", shares: 78.69, price: 63.54, ts: 1751400000000 },
        { action: "SELL", shares: 78.69, price: 58.75, ts: 1753992000000, reason: "slice_month_end" },
      ],
    );
    expect(trade.status).toBe("LOSS");
    expect(trade.pnl).toBeLessThan(0);
  });

  it("summarizes mixed open/closed books", () => {
    const s = summarizeAutopsyTrades([
      { ticker: "AMD", status: "WIN", pnl: 100, pnl_pct: 10 },
      { ticker: "MNST", status: "LOSS", pnl: -50, pnl_pct: -5 },
      { ticker: "PH", status: "OPEN", pnl: null },
    ]);
    expect(s.total_trades).toBe(3);
    expect(s.open_trades).toBe(1);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.closed_trades).toBe(2);
    expect(s.realized_pnl).toBe(50);
  });

  it("normalizes imported flat trade payloads", () => {
    const rows = normalizeImportedInvestorTrades([
      {
        trade_id: "inv-pos-QQQ-2025-07-01",
        ticker: "QQQ",
        status: "WIN",
        entry_ts: 1751400000000,
        entry_price: 546.99,
        exit_ts: 1753992000000,
        exit_price: 565.01,
        shares: 9.14,
        pnl: 164.6,
        pnl_pct: 3.29,
        exit_reason: "slice_month_end",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("WIN");
    expect(rows[0].entry_path).toBe("investor_long_term");
    expect(rows[0].pnl).toBeCloseTo(164.6, 1);
  });

  it("builds run metadata for autopsy picker", () => {
    const meta = buildInvestorAutopsyRunMeta({
      runId: "investor-slice-2025-07-post890",
      month: "2025-07",
      tradeCount: 15,
      source: "preprod_export",
    });
    expect(meta.tags).toContain("investor");
    expect(meta.start_date).toBe("2025-07-01");
    expect(meta.end_date).toBe("2025-07-31");
    expect(meta.status).toBe("completed");
  });
});
