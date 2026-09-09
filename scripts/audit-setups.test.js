import { describe, it, expect } from "vitest";
import { auditSetupExport } from "./audit-setups.mjs";

const NOW = Date.parse("2026-09-09T20:00:00Z");
const row = (id, over = {}) => ({
  trade_id: id, direction: "LONG", ticker: "TEST", entry_ts: NOW - 86400000,
  exit_ts: NOW - 1000, status: "WIN", pnl: 10, pnl_pct: 1,
  entry_path: "tt_cloud_pivot_long", setup_name: "TT Cloud Pivot", ...over,
});
const audit = rows => auditSetupExport({ trades: rows }, { asOfTs: NOW });

describe("read-only setup audit", () => {
  it("keeps paper/core separate and records misleading exported identity", () => {
    const report = audit([
      row("paper", { canonical_play_id: "tt_cloud_pivot" }),
      row("core", { entry_path: "tt_cloud_pivot" }),
    ]);
    expect(report.by_setup_side).toHaveLength(2);
    expect(report.exported_identity_disagreements).toBe(1);
  });
  it("deduplicates per run, excludes open/future exits and keeps missing PnL unknown", () => {
    const a = row("a");
    const report = audit([a, a, row("open", { status: "OPEN" }), row("future", { exit_ts: NOW + 1 }), row("missing", { pnl: null, pnl_pct: "" })]);
    expect(report.duplicates_removed).toBe(1);
    expect(report.future_closed_excluded).toBe(1);
    expect(report.closed).toMatchObject({ n: 2, pnl_observed: 1, return_observed: 1, mean_return_pct: 1 });
  });
  it("does not infer a clean context, no catalyst, or a sequence from absent snapshots", () => {
    const report = audit([row("a")]);
    expect(report.entry_evidence.signal_snapshots).toBe(0);
    expect(report.context_coverage.catalyst_asof_verified).toEqual({ observed: 0, unknown: 1 });
    expect(report.context_coverage.adverse_rsi.observed).toBe(0);
    expect(report.conditional_comparisons).toEqual([]);
  });
  it("rejects explicitly post-entry snapshots and requires an explicit as-of", () => {
    const a = row("a");
    a.signal_snapshot_json = JSON.stringify({ ts: a.entry_ts + 1, lineage: { regime_class: "TRENDING" } });
    const report = audit([a]);
    expect(report.future_entry_snapshots_excluded).toBe(1);
    expect(report.entry_evidence.signal_snapshots).toBe(0);
    expect(() => auditSetupExport([])).toThrow(/as-of/);
  });
  it("handles empty exports without inventing dates or returns", () => {
    const report = audit([]);
    expect(report.first_entry).toBeNull();
    expect(report.last_closed_exit).toBeNull();
    expect(report.closed.mean_return_pct).toBeNull();
  });
});
