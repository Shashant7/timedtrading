import { describe, it, expect } from "vitest";
import {
  isPhantomBreakerTrade,
  loop2ComputePulse,
  loop2EvaluatePulse,
  sumRealizedPnlExcludingPhantoms,
} from "./phase-c-loops.js";

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
