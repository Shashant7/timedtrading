import { describe, it, expect } from "vitest";
import {
  nyParts,
  fmtEt,
  isRthEt,
  stIsBull,
  extractIndexTimingIndicators,
  timingFromM5Candles,
  computePremiumValueBand,
  buildDayTradeZoneModel,
  reviveZoneModel,
  summarizeOptionPath,
  peakMidSinceEntry,
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
  it("prefers 5m EMA/ST over 15m and daily", () => {
    const ind = extractIndexTimingIndicators({
      tf_tech: {
        D: { ema: { ema21: 760 }, stDir: 1 },
        "15": { ema: { ema21: 764.1, priceAboveEma21: true }, stDir: -1 },
        "5": { ema: { ema21: 763.4, priceAboveEma21: false }, stDir: 1 },
      },
    });
    expect(ind.ema21).toBe(763.4);
    expect(ind.tf).toBe("5");
    expect(stIsBull(ind.st_dir)).toBe(false);
    expect(ind.st_label).toBe("short");
  });
  it("falls back to 15m when 5m is missing", () => {
    const ind = extractIndexTimingIndicators({
      tf_tech: {
        D: { ema: { ema21: 760 }, stDir: 1 },
        "15": { ema: { ema21: 764.1, priceAboveEma21: true }, stDir: -1 },
      },
    });
    expect(ind.ema21).toBe(764.1);
    expect(ind.tf).toBe("15");
    expect(stIsBull(ind.st_dir)).toBe(true);
  });

  it("rejects a stale 10m 21 that is >1.5% from live spot", () => {
    const ind = extractIndexTimingIndicators({
      tf_tech: {
        "10": { ema: { ema21: 777.97 }, stDir: -1 },
        "15": { ema: { ema21: 764.2 }, stDir: -1 },
      },
    }, { spot: 765.15 });
    expect(ind.ema21).toBe(764.2);
    expect(ind.tf).toBe("15");
  });

  it("does not use a lone stale 10m 21 as the clock EMA", () => {
    const ind = extractIndexTimingIndicators({
      tf_tech: { "10": { ema: { ema21: 777.97 }, stDir: -1 } },
    }, { spot: 765.15 });
    expect(ind.tf).not.toBe("10");
    expect(ind.ema21).not.toBe(777.97);
  });
});

describe("timingFromM5Candles", () => {
  it("returns live 5m EMA21 + SuperTrend from D1 bars", () => {
    const bars = [];
    let ts = Date.parse("2026-09-02T13:30:00.000Z");
    for (let i = 0; i < 40; i++) {
      const c = 750 + i * 0.4;
      bars.push({ ts: ts + i * 300000, o: c - 0.1, h: c + 0.15, l: c - 0.2, c, v: 1000 });
    }
    const ind = timingFromM5Candles(bars);
    expect(ind).not.toBeNull();
    expect(ind.tf).toBe("5");
    expect(ind.source).toBe("live_m5");
    expect(ind.ema21).toBeGreaterThan(750);
    expect(ind.st_label).toBe("long");
  });

  it("returns null when there are not enough 5m bars", () => {
    expect(timingFromM5Candles([{ c: 760 }, { c: 761 }])).toBeNull();
  });
});

describe("computePremiumValueBand", () => {
  it("pins a 763P at $0.50 when the expected close is 762.50", () => {
    const band = computePremiumValueBand({
      strike: 763,
      flavor: "put",
      spot: 762.84,
      expectedClose: 762.50,
      premium: 0.35,
      dte: 1,
      now: ts(`2026-08-20T10:05:00${ET}`),
    });
    expect(band.pin).toBe(0.5);
    expect(band.buy_ceil).toBe(0.5);
    expect(band.expected_close).toBe(762.5);
    expect(band.under).toBeLessThanOrEqual(0.4);
    expect(band.over).toBeGreaterThan(0.5);
    expect(band.over).toBeLessThan(0.9);
    expect(band.band).toBe("under");
  });
  it("marks 0.95 as rich vs a 0.50 pin", () => {
    const band = computePremiumValueBand({
      strike: 763,
      flavor: "put",
      spot: 762.84,
      expectedClose: 762.50,
      premium: 0.95,
      dte: 1,
      now: ts(`2026-08-20T15:50:00${ET}`),
    });
    expect(band.buy_ceil).toBe(0.5);
    expect(band.band).toBe("over");
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

describe("peakMidSinceEntry", () => {
  it("ignores the pre-entry session high", () => {
    const marks = [
      { ts: ts(`2026-08-20T09:35:00${ET}`), mid: 2.00 },
      { ts: ts(`2026-08-20T10:20:00${ET}`), mid: 1.40 },
      { ts: ts(`2026-08-20T11:00:00${ET}`), mid: 1.15 },
    ];
    const peak = peakMidSinceEntry(marks, ts(`2026-08-20T10:05:00${ET}`), ts(`2026-08-20T11:10:00${ET}`));
    expect(peak).toBe(1.40);
  });

  it("returns null when the book has no entry_ts", () => {
    const marks = [{ ts: ts(`2026-08-20T10:20:00${ET}`), mid: 1.40 }];
    expect(peakMidSinceEntry(marks, null, ts(`2026-08-20T11:10:00${ET}`))).toBeNull();
  });
});

describe("summarizeTodStudy", () => {
  it("falls back to the playbook with thin history", () => {
    const out = summarizeTodStudy([{ ts: ts(`2026-08-20T10:00:00${ET}`), mid: 1, option_symbol: "X" }]);
    expect(out.source).toBe("playbook");
    expect(out.buy_window_et).toBe(DEFAULT_TOD_PLAYBOOK.buy_window_et);
  });
  it("ignores late-session theta death as a buy trough", () => {
    const marks = [];
    for (let d = 10; d <= 16; d++) {
      const day = `2026-08-${d}`;
      // Open spike, then grind to zero into the close — losing 0DTE.
      const pts = [
        ["09:30", 1.40],
        ["10:00", 1.10],
        ["11:00", 0.80],
        ["12:00", 0.50],
        ["13:00", 0.30],
        ["14:00", 0.18],
        ["15:30", 0.04],
      ];
      for (const [hm, mid] of pts) {
        marks.push({
          option_symbol: `SPY${d}P`,
          ts: ts(`${day}T${hm}:00${ET}`),
          mid,
        });
      }
    }
    const out = summarizeTodStudy(marks);
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
    expect(out.sell_rule).toMatch(/15:45/);
    expect(out.sell_rule).toMatch(/\$/);
    expect(out.hold_overnight).toBe(false);
    expect(out.rr.positive).toBe(true);
    expect(out.zone.inv).toBe(761);
    expect(out.headline).toMatch(/BUY/);
  });

  it("WAITs when tape agrees but leftover R:R is below 1:1", () => {
    const out = buildExecutionClock({
      ticker: "SPY",
      flavor: "put",
      strike: 763,
      expiration: { dte: 1, iso: "2026-08-21", label: "1 DTE" },
      spot: 762.84,
      premium: 0.45,
      indicators: { ema21: 763.1, st_dir: 1, st_label: "short", tf: "5" },
      gamePlan: { bear_target: 762.50, bear_trigger: 764, bull_trigger: 766 },
      management: {
        take_profit_1: { pct: 50, size: 0.5 },
        take_profit_2: { pct: 100, size: 0.5 },
        hard_stop_pct: -50,
        time_stop_et: "15:45",
        invalidation: { underlying_above: 766 },
      },
      now: ts(`2026-08-20T10:05:00${ET}`),
    });
    expect(out.action).toBe("WAIT");
    expect(out.rr.positive).toBe(false);
    expect(out.rr.trim).toBeGreaterThan(0.53);
    expect(out.why).toMatch(/R:R/);
  });

  it("WAITs through the 09:30-09:45 open print", () => {
    const out = buildExecutionClock({
      ...baseClock,
      now: ts(`2026-08-20T09:35:00${ET}`),
    });
    expect(out.action).toBe("WAIT");
    expect(out.why).toMatch(/open/);
  });

  it("WAITs at 06:30 ET even when SuperTrend agrees and premium is cheap", () => {
    const out = buildExecutionClock({
      ticker: "QQQ",
      flavor: "call",
      strike: 720,
      expiration: { dte: 1, iso: "2026-08-22", label: "1 DTE" },
      spot: 716.44,
      premium: 1.45,
      indicators: { ema21: 715.8, st_dir: -1, st_label: "long", tf: "5" },
      gamePlan: { bear_trigger: 710, bull_target: 725, bull_trigger: 718 },
      management: {
        take_profit_1: { pct: 50, size: 0.5 },
        take_profit_2: { pct: 100, size: 0.5 },
        hard_stop_pct: -50,
        time_stop_et: "15:45",
        invalidation: { underlying_below: 710 },
      },
      now: ts(`2026-08-21T06:30:00${ET}`),
    });
    expect(out.action).toBe("WAIT");
    expect(out.why).toMatch(/09:30/);
    expect(out.why).toMatch(/not tradeable/i);
    expect(out.headline).toMatch(/Aug 22/);
    expect(out.headline).toMatch(/1 DTE/);
    expect(out.scan_line).toMatch(/Aug 22/);
    expect(out.contract.exp_bit).toBe("Aug 22");
  });

  it("names the expiration on a 10:05 BUY punchline", () => {
    const out = buildExecutionClock({
      ...baseClock,
      now: ts(`2026-08-20T10:05:00${ET}`),
    });
    expect(out.action).toBe("BUY");
    expect(out.headline).toMatch(/Aug 21/);
    expect(out.scan_line).toMatch(/Debit ≤/);
    expect(out.scan_line).toMatch(/15:45/);
    expect(out.scan_line).toMatch(/collect trim/);
  });

  it("does not gate an overnight trim at the open", () => {
    const out = buildExecutionClock({
      ...baseClock,
      premium: 1.80,
      now: ts(`2026-08-21T09:35:00${ET}`),
      openBook: {
        status: "open",
        held_overnight: true,
        entry_premium: 1.20,
        trim_premium: 1.80,
        exit_premium: 2.40,
        entry_ts: ts(`2026-08-20T15:50:00${ET}`),
      },
    });
    expect(out.action).toBe("TRIM");
    expect(out.sell_kind).toBe("open_trim");
    expect(out.carry_overnight).toBe(true);
    expect(out.why).toMatch(/09:45/);
    expect(out.why).not.toMatch(/first pullback/);
  });

  it("takes an overnight exit at the open when 2R prints", () => {
    const out = buildExecutionClock({
      ...baseClock,
      premium: 2.40,
      now: ts(`2026-08-21T09:35:00${ET}`),
      openBook: {
        status: "trimmed",
        held_overnight: true,
        entry_premium: 1.20,
        trim_premium: 1.80,
        exit_premium: 2.40,
        entry_ts: ts(`2026-08-20T15:50:00${ET}`),
      },
    });
    expect(out.action).toBe("SELL");
    expect(out.sell_kind).toBe("open_exit");
    expect(out.why).toMatch(/profit-taking/);
  });

  it("keeps overnight trim/exit live at the open even if 1R has not printed", () => {
    const out = buildExecutionClock({
      ...baseClock,
      premium: 1.40,
      now: ts(`2026-08-21T09:35:00${ET}`),
      openBook: {
        status: "open",
        held_overnight: true,
        entry_premium: 1.20,
        trim_premium: 1.80,
        exit_premium: 2.40,
        entry_ts: ts(`2026-08-20T15:50:00${ET}`),
      },
    });
    expect(out.action).toBe("WAIT");
    expect(out.carry_overnight).toBe(true);
    expect(out.why).toMatch(/live from 09:30/);
    expect(out.why).not.toMatch(/wait for the first pullback/i);
  });

  it("SELLs when the underlying loses invalidation and a book is open", () => {
    const out = buildExecutionClock({
      ...baseClock,
      spot: 760.4,
      openBook: { status: "open", entry_premium: 1.20, entry_ts: ts(`2026-08-20T09:45:00${ET}`) },
      now: ts(`2026-08-20T10:20:00${ET}`),
    });
    expect(out.action).toBe("SELL");
    expect(out.display_action).toBe("FLAT");
    expect(out.why).toMatch(/761/);
  });

  it("WAITs on invalidation at 06:30 ET — flatten at the 09:30 cash open", () => {
    const out = buildExecutionClock({
      ...baseClock,
      spot: 760.4,
      now: ts(`2026-08-21T06:30:00${ET}`),
    });
    expect(out.action).toBe("WAIT");
    expect(out.sell_kind).toBeNull();
    expect(out.why).toMatch(/09:30/);
    expect(out.why).toMatch(/not in premarket/);
    expect(out.headline).toMatch(/flatten at 09:30/);
  });

  it("SELLs invalidation at 09:30 ET when a book is open, not earlier", () => {
    const out = buildExecutionClock({
      ...baseClock,
      spot: 760.4,
      openBook: { status: "open", entry_premium: 1.20, entry_ts: ts(`2026-08-20T15:50:00${ET}`), held_overnight: true },
      now: ts(`2026-08-21T09:30:00${ET}`),
    });
    expect(out.action).toBe("SELL");
    expect(out.sell_kind).toBe("invalidation");
    expect(out.why).toMatch(/761/);
  });

  it("does not SELL after 16:15 ET", () => {
    const out = buildExecutionClock({
      ...baseClock,
      spot: 760.4,
      now: ts(`2026-08-20T16:15:00${ET}`),
    });
    expect(out.action).toBe("WAIT");
    expect(out.why).toMatch(/16:15/);
  });

  it("SELLs a 0 DTE at the noon time stop when a book is open", () => {
    const out = buildExecutionClock({
      ...baseClock,
      expiration: { dte: 0, iso: "2026-08-20", label: "0 DTE" },
      management: { ...baseClock.management, time_stop_et: "12:00" },
      openBook: { status: "open", entry_premium: 1.20, entry_ts: ts(`2026-08-20T09:45:00${ET}`) },
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

  it("exposes the post-entry mark high for profit-lock, not the pre-entry peak", () => {
    const marks = [
      { ts: ts(`2026-08-20T09:35:00${ET}`), mid: 2.00 },
      { ts: ts(`2026-08-20T10:20:00${ET}`), mid: 1.40 },
      { ts: ts(`2026-08-20T11:00:00${ET}`), mid: 1.15 },
    ];
    const out = buildExecutionClock({
      ...baseClock,
      premium: 1.15,
      marks,
      openBook: {
        status: "open",
        entry_premium: 1.10,
        entry_ts: ts(`2026-08-20T10:05:00${ET}`),
      },
      now: ts(`2026-08-20T11:10:00${ET}`),
    });
    expect(out.path.peak_mid).toBe(2.00);
    expect(out.path_peak_since_entry).toBe(1.40);
  });

  it("does not use you/your in trader-facing copy", () => {
    const out = buildExecutionClock({
      ...baseClock,
      now: ts(`2026-08-20T10:05:00${ET}`),
    });
    const blob = [out.headline, out.scan_line, out.why, out.buy_rule, out.sell_rule, out.path_note, out.dte_note].join(" ");
    expect(blob.toLowerCase()).not.toMatch(/\byou(r)?\b/);
  });

  it("WAITs when tape agrees but premium is rich vs the pin", () => {
    const out = buildExecutionClock({
      ticker: "SPY",
      flavor: "put",
      strike: 763,
      expiration: { dte: 1, iso: "2026-08-21", label: "1 DTE" },
      spot: 762.84,
      premium: 0.95,
      indicators: { ema21: 763.1, st_dir: 1, st_label: "short", tf: "5" },
      gamePlan: { bear_target: 762.50, bear_trigger: 764, bull_trigger: 766 },
      management: {
        take_profit_1: { pct: 40, size: 0.5 },
        take_profit_2: { pct: 100, size: 0.5 },
        hard_stop_pct: -50,
        time_stop_et: "16:15",
        invalidation: { underlying_above: 766 },
      },
      now: ts(`2026-08-20T10:05:00${ET}`),
    });
    expect(out.action).toBe("WAIT");
    expect(out.premium_band.band).toBe("over");
    expect(out.premium_band.buy_ceil).toBe(0.5);
    expect(out.why).toMatch(/rich vs FMV/);
  });

  it("SELLs 0 DTE after 15:15 when a book is open, even if SuperTrend still agrees", () => {
    const out = buildExecutionClock({
      ...baseClock,
      expiration: { dte: 0, iso: "2026-08-20", label: "0 DTE" },
      management: { ...baseClock.management, time_stop_et: "12:00" },
      openBook: { status: "open", entry_premium: 1.20, entry_ts: ts(`2026-08-20T09:45:00${ET}`) },
      now: ts(`2026-08-20T15:20:00${ET}`),
    });
    expect(out.action).toBe("SELL");
    expect(out.why).toMatch(/force-liquidation/);
    expect(out.dte_note).toMatch(/15:15/);
  });

  it("SELLs 1 DTE by 15:45 when leftover R:R does not justify overnight and a book is open", () => {
    const out = buildExecutionClock({
      ticker: "SPY",
      flavor: "put",
      strike: 763,
      expiration: { dte: 1, iso: "2026-08-21", label: "1 DTE" },
      spot: 762.9,
      premium: 0.38,
      indicators: { ema21: 763.05, st_dir: 1, st_label: "short", tf: "5" },
      gamePlan: { bear_target: 762.50, bear_trigger: 764, bull_trigger: 766 },
      management: {
        take_profit_1: { pct: 50, size: 0.5 },
        take_profit_2: { pct: 100, size: 0.5 },
        hard_stop_pct: -50,
        time_stop_et: "15:45",
        invalidation: { underlying_above: 766 },
      },
      openBook: { status: "open", entry_premium: 0.38, entry_ts: ts(`2026-08-20T10:00:00${ET}`) },
      now: ts(`2026-08-20T15:50:00${ET}`),
    });
    expect(out.action).toBe("SELL");
    expect(out.display_action).toBe("FLAT");
    expect(out.sell_kind).toBe("session_close");
    expect(out.hold_overnight).toBe(false);
    expect(out.headline).toMatch(/^FLAT /);
    expect(out.why).toMatch(/15:45/);
  });

  it("WAITs at session flatten when no live book is open", () => {
    const out = buildExecutionClock({
      ticker: "SPY",
      flavor: "put",
      strike: 763,
      expiration: { dte: 1, iso: "2026-08-21", label: "1 DTE" },
      spot: 762.9,
      premium: 0.38,
      indicators: { ema21: 763.05, st_dir: 1, st_label: "short", tf: "5" },
      gamePlan: { bear_target: 762.50, bear_trigger: 764, bull_trigger: 766 },
      management: {
        take_profit_1: { pct: 50, size: 0.5 },
        take_profit_2: { pct: 100, size: 0.5 },
        hard_stop_pct: -50,
        time_stop_et: "15:45",
        invalidation: { underlying_above: 766 },
      },
      now: ts(`2026-08-20T15:50:00${ET}`),
    });
    expect(out.action).toBe("WAIT");
    expect(out.display_action).toBe("WAIT");
    expect(out.sell_kind).toBeNull();
    expect(out.why).toMatch(/still open/i);
  });

  it("holds 1 DTE overnight when leftover R:R is still ≥ 1", () => {
    const out = buildExecutionClock({
      ...baseClock,
      now: ts(`2026-08-20T15:50:00${ET}`),
    });
    expect(out.hold_overnight).toBe(true);
    expect(out.action).not.toBe("SELL");
    expect(out.why).toMatch(/overnight|Too late/i);
  });

  it("WAITs a premarket put when cash is above prior close and OR is still forming", () => {
    const out = buildExecutionClock({
      ticker: "SPY",
      flavor: "put",
      strike: 758,
      expiration: { dte: 1, iso: "2026-09-03", label: "1 DTE" },
      spot: 762.4,
      premium: 1.2,
      indicators: { ema21: 762.2, st_dir: 1, st_label: "short", tf: "5" },
      gamePlan: {
        lean: "SHORT",
        bear_target: 754,
        bull_trigger: 764.2,
        or_resolved: false,
        overnight_mid: 761.2,
        prev_close: 761.78,
        inv_put: 764.49,
      },
      now: ts(`2026-09-02T09:50:00${ET}`),
    });
    expect(out.action).toBe("WAIT");
    expect(out.why).toMatch(/opening range is still forming/i);
  });

  it("invalidates a put at prior close while the OR is still forming", () => {
    const out = buildExecutionClock({
      ticker: "SPY",
      flavor: "put",
      strike: 758,
      expiration: { dte: 1, iso: "2026-09-03", label: "1 DTE" },
      spot: 762.4,
      premium: 1.2,
      indicators: { ema21: 762.2, st_dir: 1, st_label: "short", tf: "5" },
      gamePlan: {
        lean: "SHORT",
        bull_trigger: 764.2,
        or_resolved: false,
        overnight_mid: 761.2,
        prev_close: 761.78,
        inv_put: 761.78,
      },
      now: ts(`2026-09-02T09:50:00${ET}`),
    });
    expect(out.action).toBe("WAIT");
    expect(out.why).toMatch(/reclaimed \$761\.78/i);
  });

  it("invalidates a put on structural reclaim, not the chasing bull trigger", () => {
    const out = buildExecutionClock({
      ticker: "SPY",
      flavor: "put",
      strike: 758,
      expiration: { dte: 1, iso: "2026-09-03", label: "1 DTE" },
      spot: 765.5,
      premium: 0.4,
      indicators: { ema21: 763.1, st_dir: -1, st_label: "long", tf: "5" },
      gamePlan: {
        lean: "SHORT",
        bull_trigger: 766.8,
        inv_put: 764.49,
        or_resolved: true,
        prev_close: 761.78,
      },
      now: ts(`2026-09-02T10:20:00${ET}`),
    });
    expect(out.action).toBe("WAIT");
    expect(out.why).toMatch(/reclaimed \$764\.49/i);
  });

  // 2026-09-03 autopsy: brief bull trigger tagged at the open, bull target
  // by ~11:15, but the 1-min lane waited for an EMA pullback and BOUGHT at
  // 15:06 — after the move was done. Trigger-pierce + anti-chase fix.
  it("BUYs a call on a fresh bull-trigger pierce even when extended above the 21 EMA", () => {
    const out = buildExecutionClock({
      ticker: "SPY",
      flavor: "call",
      strike: 769,
      expiration: { dte: 1, iso: "2026-09-04", label: "1 DTE" },
      // Through bull trigger 767.82, only ~40% of the way to 771.42,
      // but >0.40% above the 21 EMA so the old pullback gate would WAIT.
      spot: 769.3,
      premium: 1.35,
      indicators: { ema21: 766.0, st_dir: -1, st_label: "long", tf: "5" },
      gamePlan: {
        lean: "LONG",
        bull_trigger: 767.82,
        bull_target: 771.42,
        bear_trigger: 764.48,
        bear_target: 754.02,
      },
      management: {
        take_profit_1: { pct: 50, size: 0.5 },
        take_profit_2: { pct: 100, size: 0.5 },
        hard_stop_pct: -50,
        time_stop_et: "15:45",
        invalidation: { underlying_below: 764.48 },
      },
      now: ts(`2026-09-03T09:50:00${ET}`),
    });
    expect(out.action).toBe("BUY");
    expect(out.entry_mode).toBe("trigger_pierce");
    expect(out.trigger.pierced).toBe(true);
    expect(out.trigger.fresh).toBe(true);
    expect(out.trigger.target_tagged).toBe(false);
    expect(out.why).toMatch(/pierced the bull trigger/i);
    expect(out.headline).toMatch(/trigger \$767\.82/);
  });

  it("WAITs on a late EMA pullback after the bull target is already tagged (Sep 3 autopsy)", () => {
    const out = buildExecutionClock({
      ticker: "SPY",
      flavor: "call",
      strike: 777,
      expiration: { dte: 1, iso: "2026-09-04", label: "1 DTE" },
      // Spot past bull target; sitting on the 21 EMA at 15:06 — the old
      // clock would BUY here. Must WAIT: the brief move is done.
      spot: 773.54,
      premium: 0.63,
      indicators: { ema21: 773.2, st_dir: -1, st_label: "long", tf: "5" },
      gamePlan: {
        lean: "LONG",
        bull_trigger: 767.82,
        bull_target: 771.42,
        bear_trigger: 764.48,
        bear_target: 754.02,
      },
      management: {
        take_profit_1: { pct: 50, size: 0.5 },
        take_profit_2: { pct: 100, size: 0.5 },
        hard_stop_pct: -50,
        time_stop_et: "15:45",
        invalidation: { underlying_below: 764.48 },
      },
      now: ts(`2026-09-03T15:06:00${ET}`),
    });
    expect(out.action).toBe("WAIT");
    expect(out.entry_mode).toBeNull();
    expect(out.trigger.target_tagged).toBe(true);
    expect(out.why).toMatch(/already tagged/i);
    expect(out.why).toMatch(/771\.42/);
  });

  it("BUYs a put on a fresh bear-trigger pierce while extended below the 21 EMA", () => {
    const out = buildExecutionClock({
      ticker: "QQQ",
      flavor: "put",
      strike: 710,
      expiration: { dte: 1, iso: "2026-09-04", label: "1 DTE" },
      spot: 709.4,
      premium: 1.10,
      indicators: { ema21: 712.8, st_dir: 1, st_label: "short", tf: "5" },
      gamePlan: {
        lean: "SHORT",
        bull_trigger: 714.0,
        bull_target: 718.0,
        bear_trigger: 710.5,
        bear_target: 705.0,
      },
      management: {
        take_profit_1: { pct: 50, size: 0.5 },
        take_profit_2: { pct: 100, size: 0.5 },
        hard_stop_pct: -50,
        time_stop_et: "15:45",
        invalidation: { underlying_above: 714.0 },
      },
      now: ts(`2026-09-03T10:05:00${ET}`),
    });
    expect(out.action).toBe("BUY");
    expect(out.entry_mode).toBe("trigger_pierce");
    expect(out.why).toMatch(/pierced the bear trigger/i);
  });
});
