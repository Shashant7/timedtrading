import { describe, it, expect } from "vitest";
import {
  monthRangeMs,
  isInvestorAutopsyRunId,
  shouldIncludeOpenAutopsyTrades,
  mapInvestorPositionToAutopsyTrade,
  summarizeAutopsyTrades,
  normalizeImportedInvestorTrades,
  buildInvestorAutopsyRunMeta,
  buildInvestorSignalSnapshotFromDecision,
  hydrateInvestorAutopsySignalsFromDecisions,
  hydrateAutopsySignalsFromDirectionAccuracy,
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

  it("detects investor autopsy run ids and include-open policy", () => {
    expect(isInvestorAutopsyRunId("investor-slice-2025-07-post890")).toBe(true);
    expect(isInvestorAutopsyRunId("live-long-term-2026-07")).toBe(true);
    expect(isInvestorAutopsyRunId("phase-c-slice-2025-07-v1")).toBe(false);
    expect(shouldIncludeOpenAutopsyTrades({ runId: "investor-slice-2025-07-post890" })).toBe(true);
    expect(shouldIncludeOpenAutopsyTrades({ runId: "live-long-term-2026-07" })).toBe(true);
    expect(shouldIncludeOpenAutopsyTrades({ runId: "phase-c-slice-2025-07-v1" })).toBe(false);
    expect(shouldIncludeOpenAutopsyTrades({ runId: "phase-c-slice-2025-07-v1", includeOpen: true })).toBe(true);
    expect(shouldIncludeOpenAutopsyTrades({ tags: ["investor"] })).toBe(true);
  });

  it("builds investor signal snapshot from decision_records inputs", () => {
    const snap = buildInvestorSignalSnapshotFromDecision({
      reason: "auto_entry_accumulate",
      stage: "accumulate",
      stage_reason: "compounder_dip_buy",
      score: 75,
      components: { weeklyTrend: 17, monthlyTrend: 20 },
      accum_zone: { signals: ["monthly_trend_bullish"] },
      h4_timing: { timeframe: "4H", stDir: -1, is4hBull: true, is4hBear: false },
      fsd: { isPick: true, tier: "core" },
    }, { eventType: "ENTRY" });
    expect(snap.source).toBe("investor_decision_records");
    expect(snap.investor.score).toBe(75);
    expect(snap.tf["4H"].signals.supertrend).toBe(1);
    expect(snap.investor.accum_zone.signals).toContain("monthly_trend_bullish");
  });

  it("hydrates missing snapshots from mocked decision_records", async () => {
    const trades = [
      { trade_id: "inv-NBIS-auto-1", ticker: "NBIS", signal_snapshot_json: null, exit_snapshot_json: null },
    ];
    const db = {
      prepare(sql) {
        return {
          bind() { return this; },
          async all() {
            if (String(sql).includes("decision_records")) {
              return {
                results: [
                  {
                    event_type: "ENTRY",
                    position_id: "inv-NBIS-auto-1",
                    inputs_json: JSON.stringify({
                      position_id: "inv-NBIS-auto-1",
                      score: 75,
                      stage: "accumulate",
                      reason: "auto_entry_accumulate",
                      h4_timing: { is4hBull: true, stDir: 1 },
                      components: { weeklyTrend: 10 },
                    }),
                  },
                  {
                    event_type: "EXIT",
                    position_id: "inv-NBIS-auto-1",
                    inputs_json: JSON.stringify({
                      position_id: "inv-NBIS-auto-1",
                      score: 70,
                      stage: "watch",
                      reason: "PRIMARY_INVALIDATION_BREACH",
                      auto_rebalance: { breach_label: "Weekly ATR support", breach_pct: -9.4 },
                    }),
                  },
                ],
              };
            }
            return { results: [] };
          },
        };
      },
    };
    await hydrateInvestorAutopsySignalsFromDecisions(db, trades);
    const entry = JSON.parse(trades[0].signal_snapshot_json);
    const exit = JSON.parse(trades[0].exit_snapshot_json);
    expect(entry.investor.score).toBe(75);
    expect(exit.investor.reason).toBe("PRIMARY_INVALIDATION_BREACH");
  });

  it("hydrates trader archives from direction_accuracy fallback", async () => {
    const trades = [
      { trade_id: "AMZN-1", signal_snapshot_json: null, exit_snapshot_json: null },
    ];
    const db = {
      prepare() {
        return {
          bind() { return this; },
          async all() {
            return {
              results: [{
                trade_id: "AMZN-1",
                signal_snapshot_json: JSON.stringify({ tf: { D: { bias: 0.5, signals: { ema_cross: 1 } } } }),
                exit_snapshot_json: JSON.stringify({ tf: { D: { bias: -0.2, signals: { ema_cross: -1 } } } }),
                entry_path: "ripster_cloud",
                ts: 100,
              }],
            };
          },
        };
      },
    };
    await hydrateAutopsySignalsFromDirectionAccuracy(db, trades);
    expect(JSON.parse(trades[0].signal_snapshot_json).tf.D.signals.ema_cross).toBe(1);
    expect(JSON.parse(trades[0].exit_snapshot_json).tf.D.signals.ema_cross).toBe(-1);
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
