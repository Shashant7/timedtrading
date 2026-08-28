import { describe, it, expect } from "vitest";
import {
  isPhantomBreakerTrade,
  loop1ComputeAdvisoryMap,
  loop1SetupSideKey,
  loop2ComputePulse,
  loop2EvaluatePulse,
  loop2WrHoldoffUntilMs,
  sumRealizedPnlExcludingPhantoms,
} from "./phase-c-loops.js";

describe("loop1 setup × side rollup", () => {
  it("blocks a family when no exact combo has enough samples", () => {
    const cards = {
      "tt_cloud_pivot:trending_up:volatile_runner:L": { wins: 0, losses: 2, samples: 2 },
      "tt_cloud_pivot:choppy:mean_reverter:L": { wins: 1, losses: 2, samples: 3 },
      "tt_cloud_pivot:transitional:unknown:L": { wins: 0, losses: 3, samples: 3 },
    };
    const map = loop1ComputeAdvisoryMap(cards, { loop1_min_samples: 8, loop1_block_wr: 0.30, loop1_raise_bar_wr: 0.45 });
    expect(map["tt_cloud_pivot:trending_up:volatile_runner:L"]).toBeUndefined();
    const roll = map[loop1SetupSideKey("tt_cloud_pivot", "L")];
    expect(roll?.decision).toBe("block");
    expect(roll?.rollup).toBe(true);
    expect(roll?.samples).toBe(8);
  });

  it("prefers an exact combo opinion over the rollup", () => {
    const cards = {
      "tt_htf_reclaim:trending_up:leader:L": { wins: 9, losses: 1, samples: 10 },
    };
    const map = loop1ComputeAdvisoryMap(cards, { loop1_min_samples: 8, loop1_block_wr: 0.30, loop1_raise_bar_wr: 0.45 });
    expect(map["tt_htf_reclaim:trending_up:leader:L"]).toBeUndefined();
    expect(map[loop1SetupSideKey("tt_htf_reclaim", "L")]).toBeUndefined();
  });
});

describe("isPhantomBreakerTrade", () => {
  it("flags fast sl_breached LOSS round-trips (stale entry flap)", () => {
    const t = {
      status: "LOSS",
      entry_ts: 1_000_000,
      exit_ts: 1_000_000 + 2 * 60 * 1000,
      exit_reason: "sl_breached",
      direction: "LONG",
      entry_price: 134.6,
      exit_price: 129.33,
      stop_loss: 123.06,
    };
    expect(isPhantomBreakerTrade(t)).toBe(true);
  });

  it("flags impossible SL hits (exit on favorable side of stop)", () => {
    const t = {
      status: "LOSS",
      entry_ts: 1_000_000,
      exit_ts: 1_000_000 + 60 * 60 * 1000,
      exit_reason: "sl_breached",
      direction: "LONG",
      exit_price: 185.5,
      stop_loss: 183.0,
    };
    expect(isPhantomBreakerTrade(t)).toBe(true);
  });

  it("keeps legitimate losses (held long enough, real stop hit)", () => {
    const t = {
      status: "LOSS",
      entry_ts: 1_000_000,
      exit_ts: 1_000_000 + 3 * 60 * 60 * 1000,
      exit_reason: "sl_breached",
      direction: "LONG",
      exit_price: 98,
      stop_loss: 99,
    };
    expect(isPhantomBreakerTrade(t)).toBe(false);
  });

  it("never excludes wins", () => {
    expect(isPhantomBreakerTrade({
      status: "WIN",
      entry_ts: 1,
      exit_ts: 2,
      exit_reason: "sl_breached",
    })).toBe(false);
  });
});

describe("loop2ComputePulse phantom exclusion", () => {
  const nowMs = Date.UTC(2026, 6, 1, 20, 0, 0);
  const mkLoss = (id, minsAgo) => ({
    status: "LOSS",
    pnl_pct: -3,
    entry_ts: nowMs - minsAgo * 60 * 1000 - 2 * 60 * 1000,
    exit_ts: nowMs - minsAgo * 60 * 1000,
    exit_reason: "sl_breached",
    direction: "LONG",
    exit_price: 100,
    stop_loss: 105,
  });

  it("excludes phantom losses from consec-loss and WR windows", () => {
    const phantoms = [0, 10, 20, 30, 40].map((m) => mkLoss(`p${m}`, m));
    const real = {
      status: "WIN",
      pnl_pct: 2,
      entry_ts: nowMs - 50 * 60 * 60 * 1000,
      exit_ts: nowMs - 49 * 60 * 60 * 1000,
    };
    const withPhantoms = loop2ComputePulse([...phantoms, real], { nowMs, maxAgeHours: 168 });
    expect(withPhantoms.consec_losses).toBe(0);
    expect(withPhantoms.last10_wr).toBe(1);
    expect(withPhantoms.phantom_excluded_n).toBe(5);

    const raw = loop2ComputePulse([...phantoms, real], { nowMs, maxAgeHours: 168, includePhantomTrades: true });
    expect(raw.consec_losses).toBe(5);
    expect(raw.last10_wr).toBeCloseTo(1 / 6, 2);
  });

  it("does not trip consec breaker when only phantom losses would have fired", () => {
    const phantoms = [0, 10, 20, 30, 40].map((m) => mkLoss(`p${m}`, m));
    const pulse = loop2ComputePulse(phantoms, { nowMs, maxAgeHours: 168 });
    const evalRes = loop2EvaluatePulse(pulse, { loop2_breaker_consec_loss: 4 });
    expect(evalRes.trip).toBe(false);
  });
});

describe("loop2 operator reset WR holdoff", () => {
  const closedLosses = Array.from({ length: 10 }, (_, i) => ({
    status: i === 6 ? "WIN" : "LOSS",
    pnl_pct: i === 6 ? 0.2 : -2,
    exit_ts: Date.UTC(2026, 7, 27, 14, i, 0),
  }));

  it("trips wr_10 without a holdoff", () => {
    const pulse = loop2ComputePulse(closedLosses, { nowMs: Date.UTC(2026, 7, 28, 16, 0, 0), maxAgeHours: 168 });
    const evalRes = loop2EvaluatePulse(pulse, {});
    expect(pulse.last10_wr).toBeCloseTo(0.1, 5);
    expect(evalRes.trip).toBe(true);
    expect(evalRes.reason).toMatch(/^wr_/);
  });

  it("defers the same WR trip until holdoff expires", () => {
    const nowMs = Date.UTC(2026, 7, 28, 21, 0, 0);
    const pulse = loop2ComputePulse(closedLosses, { nowMs, maxAgeHours: 168 });
    const holdoff = loop2WrHoldoffUntilMs(nowMs);
    const evalRes = loop2EvaluatePulse(pulse, {}, { nowMs, holdoff_wr_until_ms: holdoff });
    expect(evalRes.trip).toBe(false);
    expect(evalRes.operator_reset_holdoff).toBe(true);
    expect(evalRes.original_reason).toMatch(/^wr_/);
    expect(holdoff).toBeGreaterThan(nowMs);
  });

  it("maps a Friday evening reset to Monday RTH close", () => {
    const fridayEve = Date.UTC(2026, 7, 28, 21, 0, 0);
    const until = loop2WrHoldoffUntilMs(fridayEve);
    // Monday 2026-08-31 16:00 ET = 20:00 UTC
    expect(until).toBe(Date.UTC(2026, 7, 31, 20, 0, 0));
  });

  it("still trips a fresh today-PnL rule during holdoff", () => {
    const nowMs = Date.UTC(2026, 7, 31, 15, 0, 0);
    const today = [
      { status: "LOSS", pnl_pct: -2, exit_ts: Date.UTC(2026, 7, 31, 14, 0, 0) },
      { status: "LOSS", pnl_pct: -2, exit_ts: Date.UTC(2026, 7, 31, 14, 10, 0) },
      { status: "LOSS", pnl_pct: -2, exit_ts: Date.UTC(2026, 7, 31, 14, 20, 0) },
    ];
    const pulse = loop2ComputePulse(today, { nowMs, maxAgeHours: 168 });
    const evalRes = loop2EvaluatePulse(pulse, {}, { nowMs, holdoff_wr_until_ms: Date.UTC(2026, 7, 31, 20, 0, 0) });
    expect(pulse.today_n).toBe(3);
    expect(evalRes.trip).toBe(true);
    expect(evalRes.reason).toMatch(/today_pnl/);
  });
});

describe("sumRealizedPnlExcludingPhantoms", () => {
  it("skips phantom loss dollars but keeps real PnL", () => {
    const rows = [
      { status: "LOSS", pnl: -500, entry_ts: 1, exit_ts: 1 + 120000, exit_reason: "sl_breached", direction: "LONG", exit_price: 110, stop_loss: 105 },
      { status: "WIN", pnl: 300, entry_ts: 1, exit_ts: 1 + 3600000, exit_reason: "tp_hit" },
      { status: "LOSS", pnl: -200, entry_ts: 1, exit_ts: 1 + 7200000, exit_reason: "sl_breached", direction: "LONG", exit_price: 95, stop_loss: 96 },
    ];
    expect(sumRealizedPnlExcludingPhantoms(rows)).toBe(100);
  });
});
