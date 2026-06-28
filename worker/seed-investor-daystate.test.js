import { describe, it, expect } from "vitest";
import {
  buildMonthlyBundleFromBars,
  mergeMonthlyIntoTickerRow,
  sliceCandlesBeforeTs,
  enrichInvestorDayState,
} from "./seed-investor-daystate.js";

function synthMonthlyBars(n, startTs = 1704067200000) {
  const monthMs = 30 * 86400000;
  const bars = [];
  for (let i = 0; i < n; i++) {
    const px = 100 + i * 2;
    bars.push({ ts: startTs + i * monthMs, o: px, h: px + 1, l: px - 1, c: px, v: 1e6 });
  }
  return bars;
}

describe("buildMonthlyBundleFromBars", () => {
  it("returns monthly_bundle with supertrend_dir when >=15 bars", () => {
    const mb = buildMonthlyBundleFromBars(synthMonthlyBars(20));
    expect(mb).toBeTruthy();
    expect([-1, 1, 0]).toContain(mb.supertrend_dir);
  });

  it("returns null when fewer than 15 bars", () => {
    expect(buildMonthlyBundleFromBars(synthMonthlyBars(10))).toBeNull();
  });
});

describe("mergeMonthlyIntoTickerRow", () => {
  it("writes monthly_bundle and tf_tech.M.stDir", () => {
    const bars = synthMonthlyBars(20);
    const bM = { stDir: -1, stLine: 120, rsi: 55, emaDepth: 6, emaStructure: 0.5, emaMomentum: 0.1, e200: 100, atr14: 2, phaseOsc: 1, px: 130 };
    const mb = buildMonthlyBundleFromBars(bars);
    const row = mergeMonthlyIntoTickerRow({ price: 130, tf_tech: { D: { stDir: -1 } } }, mb, bM);
    expect(row.monthly_bundle.supertrend_dir).toBe(-1);
    expect(row.tf_tech.M.stDir).toBe(-1);
  });
});

describe("sliceCandlesBeforeTs", () => {
  it("keeps bars at-or-before beforeTs", () => {
    const bars = [{ ts: 100 }, { ts: 200 }, { ts: 300 }];
    expect(sliceCandlesBeforeTs(bars, 200).length).toBe(2);
  });
});

describe("enrichInvestorDayState", () => {
  it("patches tickers missing monthly_bundle", async () => {
    const dayState = {
      AAPL: { price: 200, tf_tech: { D: { stDir: -1 }, W: { stDir: -1 } } },
      MSFT: { price: 400, monthly_bundle: { supertrend_dir: -1 } },
    };
    const fakeD1 = async (_env, _sym, _tfConfigs, _opts) => ({
      M: { ok: true, candles: synthMonthlyBars(20) },
    });
    const res = await enrichInvestorDayState({
      env: {},
      dayState,
      dateParam: "2025-07-01",
      tickers: ["AAPL", "MSFT"],
      d1GetCandlesAllTfs: fakeD1,
    });
    expect(res.ok).toBe(true);
    expect(res.patched).toBe(1);
    expect(res.skippedHasBundle).toBe(1);
    expect(dayState.AAPL.monthly_bundle?.supertrend_dir).toBeDefined();
  });
});
