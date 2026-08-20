import { describe, it, expect } from "vitest";
import {
  nyParts,
  fmtEt,
  isRthEt,
  stIsBull,
  extractIndexTimingIndicators,
  buildDayTradeZoneModel,
  reviveZoneModel,
  summarizeOptionPath,
  summarizeTodStudy,
  buildExecutionClock,
  DEFAULT_TOD_PLAYBOOK,
} from "./option-execution-clock.js";

const ET = "-04:00"; // Aug 2026 is EDT
const ts = (iso) => Date.parse(iso);

describe("ny clock", () => {
  it("formats 10:12 ET", () => {
    expect(fmtEt(ts(`2026-08-20T10:12:00${ET}`))).toBe("10:12");
  });
  it("flags RTH vs overnight", () => {
    expect(isRthEt(ts(`2026-08-20T10:12:00${ET}`))).toBe(true);
    expect(isRthEt(ts(`2026-08-20T04:00:00${ET}`))).toBe(false);
    expect(isRthEt(ts(`2026-08-20T16:00:00${ET}`))).toBe(false);
  });
  it("reads hour 9:30 as RTH start", () => {
    const p = nyParts(ts(`2026-08-20T09:30:00${ET}`));
    expect(p.minutes).toBe(9 * 60 + 30);
  });
});

describe("extractIndexTimingIndicators", () => {
  it("prefers 15m EMA/ST over daily", () => {
    const ind = extractIndexTimingIndicators({
      tf_tech: {
        D: { ema: { ema21: 760 }, stDir: 1 },
        "15": { ema: { ema21: 764.1, priceAboveEma21: true }, stDir: -1 },
      },
    });
    expect(ind.ema21).toBe(764.1);
    expect(ind.tf).toBe("15");
    expect(stIsBull(ind.st_dir)).toBe(true);
    expect(ind.st_label).toBe("long");
  });
});

describe("buildDayTradeZoneModel", () => {
  it("plots a call INV < PB < TGT", () => {
    const z = buildDayTradeZoneModel({
      flavor: "call",
      spot: 765,
      ema21: 764,
      gamePlan: { bear_trigger: 761, bull_target: 772, bull_trigger: 767 },
      invalidation: { underlying_below: 761 },
    });
    expect(z.inv).toBe(761);
    expect(z.tgt).toBe(772);
    expect(z.pb[0]).toBeLessThan(z.pb[1]);
    const live = reviveZoneModel(z, 766);
    expect(live.pct(761)).toBeLessThan(live.pct(772));
    expect(live.price).toBe(766);
  });
  it("plots a put with invalidation above target", () => {
    const z = buildDayTradeZoneModel({
      flavor: "put",
      spot: 765,
      ema21: 766,
      gamePlan: { bull_trigger: 770, bear_target: 758, bear_trigger: 762 },
      invalidation: { underlying_above: 770 },
    });
    expect(z.inv).toBe(770);
    expect(z.tgt).toBe(758);
    const live = reviveZoneModel(z, 765);
    expect(live.pct(758)).toBeLessThan(live.pct(770));
  });
});

describe("summarizeOptionPath", () => {
  it("ignores overnight marks and reports RTH trough/peak", () => {
    const marks = [
      { ts: ts(`2026-08-20T04:00:00${ET}`), mid: 0.10 },
      { ts: ts(`2026-08-20T09:30:00${ET}`), mid: 0.49 },
      { ts: ts(`2026-08-20T09:45:00${ET}`), mid: 1.36 },
      { ts: ts(`2026-08-20T11:45:00${ET}`), mid: 0.45 },
    ];
    const path = summarizeOptionPath(marks, ts(`2026-08-20T12:00:00${ET}`));
    expect(path.peak_et).toBe("09:45");
    expect(path.peak_mid).toBe(1.36);
    expect(path.trough_et).toBe("11:45");
    expect(path.trough_mid).toBe(0.45);
    expect(path.n).toBe(3);
  });
});

describe("summarizeTodStudy", () => {
  it("falls back to the playbook with thin history", () => {
    const out = summarizeTodStudy([{ ts: ts(`2026-08-20T10:00:00${ET}`), mid: 1, option_symbol: "X" }]);
    expect(out.source).toBe("playbook");
    expect(out.buy_window_et).toBe(DEFAULT_TOD_PLAYBOOK.buy_window_et);
  });
  it("derives windows from several contract-days", () => {
    const marks = [];
    for (let d = 10; d <= 14; d++) {
      const day = `2026-08-${d}`;
      for (let i = 0; i < 8; i++) {
        const hour = 10 + i; // 10:00 trough-ish early, peak later
        marks.push({
          option_symbol: `QQQ${d}C`,
          ts: ts(`${day}T${String(hour).padStart(2, "0")}:00:00${ET}`),
          mid: hour === 10 ? 0.80 : 0.80 + (hour - 10) * 0.15,
        });
      }
    }
    const out = summarizeTodStudy(marks);
    expect(out.source).toBe("option_marks");
    expect(out.n_days).toBe(5);
    expect(out.buy_window_et).toMatch(/10:/);
  });
});

const baseClock = {
  ticker: "SPY",
  flavor: "call",
  strike: 765,
  expiration: { dte: 1, iso: "2026-08-21", label: "1 DTE" },
  spot: 764.2,
  premium: 1.20,
  indicators: { ema21: 764.1, st_dir: -1, st_label: "long", tf: "15" },
  gamePlan: { bear_trigger: 761, bull_target: 772, bull_trigger: 767 },
  management: {
    take_profit_1: { pct: 40, size: 0.5 },
    take_profit_2: { pct: 100, size: 0.5 },
    hard_stop_pct: -50,
    time_stop_et: "15:30",
    invalidation: { underlying_below: 761 },
  },
};

describe("buildExecutionClock", () => {
  it("BUYs a call on a 10:05 pullback into the 21 EMA with ST long", () => {
    const out = buildExecutionClock({
      ...baseClock,
      now: ts(`2026-08-20T10:05:00${ET}`),
    });
    expect(out.action).toBe("BUY");
    expect(out.buy_rule).toMatch(/765C/);
    expect(out.buy_rule).toMatch(/21 EMA/);
    expect(out.sell_rule).toMatch(/15:30/);
    expect(out.zone.inv).toBe(761);
    expect(out.headline).toMatch(/BUY/);
  });

  it("WAITs through the 09:30-09:45 open print", () => {
    const out = buildExecutionClock({
      ...baseClock,
      now: ts(`2026-08-20T09:35:00${ET}`),
    });
    expect(out.action).toBe("WAIT");
    expect(out.why).toMatch(/open/);
  });

  it("SELLs when the underlying loses invalidation", () => {
    const out = buildExecutionClock({
      ...baseClock,
      spot: 760.4,
      now: ts(`2026-08-20T10:20:00${ET}`),
    });
    expect(out.action).toBe("SELL");
    expect(out.why).toMatch(/761/);
  });

  it("SELLs a 0 DTE at the noon time stop", () => {
    const out = buildExecutionClock({
      ...baseClock,
      expiration: { dte: 0, iso: "2026-08-20", label: "0 DTE" },
      management: { ...baseClock.management, time_stop_et: "12:00" },
      now: ts(`2026-08-20T12:05:00${ET}`),
    });
    expect(out.action).toBe("SELL");
    expect(out.why).toMatch(/12:00/);
  });

  it("WAITs when SuperTrend is against a call", () => {
    const out = buildExecutionClock({
      ...baseClock,
      indicators: { ema21: 764.1, st_dir: 1, st_label: "short", tf: "15" },
      now: ts(`2026-08-20T10:05:00${ET}`),
    });
    expect(out.action).toBe("WAIT");
    expect(out.why).toMatch(/SuperTrend/);
  });

  it("WAITs when the contract has already bled from the open peak", () => {
    const marks = [
      { ts: ts(`2026-08-20T09:30:00${ET}`), mid: 0.49 },
      { ts: ts(`2026-08-20T09:45:00${ET}`), mid: 1.36 },
      { ts: ts(`2026-08-20T11:45:00${ET}`), mid: 0.45 },
    ];
    const out = buildExecutionClock({
      ...baseClock,
      premium: 0.45,
      indicators: { ema21: 764.1, st_dir: 1, st_label: "short", tf: "15" },
      marks,
      now: ts(`2026-08-20T11:50:00${ET}`),
    });
    expect(out.path.peak_et).toBe("09:45");
    expect(out.path_note).toMatch(/1\.36/);
    expect(out.action).toBe("WAIT");
  });

  it("does not use you/your in trader-facing copy", () => {
    const out = buildExecutionClock({
      ...baseClock,
      now: ts(`2026-08-20T10:05:00${ET}`),
    });
    const blob = [out.headline, out.why, out.buy_rule, out.sell_rule, out.path_note].join(" ");
    expect(blob.toLowerCase()).not.toMatch(/\byou(r)?\b/);
  });
});
