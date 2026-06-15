// worker/foundation/reconcile.test.js
import { describe, it, expect } from "vitest";
import { reconcileDailyRollup, crossSourceConsensus } from "./reconcile.js";
import { expectedIntradayBuckets } from "./trading-calendar.js";

// Build a synthetic 5m session and the matching "provider daily" bar.
function session5m(dateStr, base = 100) {
  return expectedIntradayBuckets(dateStr, 5).map((ts, i) => ({
    ts, o: base + i, h: base + i + 0.5, l: base + i - 0.5, c: base + i + 0.2, v: 10,
  }));
}
function trueDaily(dateStr, bars) {
  // exact aggregate of the session (what a faithful provider daily should be)
  let o = bars[0].o, h = bars[0].h, l = bars[0].l, c = bars[bars.length - 1].c, v = 0;
  for (const b of bars) { if (b.h > h) h = b.h; if (b.l < l) l = b.l; v += b.v; }
  return { ts: bars[0].ts, o, h, l, c, v };
}

describe("reconcileDailyRollup (calculated-from-5m vs provider daily)", () => {
  it("matches when the 5m base is complete and faithful", () => {
    const bars = session5m("2026-06-12");
    const r = reconcileDailyRollup(bars, [trueDaily("2026-06-12", bars)]);
    expect(r.ok).toBe(true);
    expect(r.matched).toBe(1);
    expect(r.mismatched).toBe(0);
  });

  it("flags a missing 5m bar via High (price completeness is the verdict)", () => {
    const full = session5m("2026-06-12");
    const provDaily = trueDaily("2026-06-12", full);  // provider saw the full day
    const gappy = full.filter((b, i) => i !== full.length - 1); // dropped the highest/last bar
    const r = reconcileDailyRollup(gappy, [provDaily]);
    expect(r.ok).toBe(false);
    const fields = r.mismatches.map((m) => m.field);
    expect(fields).toContain("high");          // dropped the max bar → caught
    expect(fields).not.toContain("volume");    // one bar isn't a gross undercount
  });

  it("tolerates auction-level volume gaps but flags a GROSS undercount", () => {
    const full = session5m("2026-06-12");
    const provDaily = trueDaily("2026-06-12", full);
    // ~80% of volume present (auction-like gap): no volume flag
    provDaily.v = provDaily.v / 0.8;
    expect(reconcileDailyRollup(full, [provDaily]).mismatches.some((m) => m.field === "volume")).toBe(false);
    // only ~30% of volume present (truly missing bars): volume flag fires
    const provBig = trueDaily("2026-06-12", full); provBig.v = provBig.v / 0.3;
    expect(reconcileDailyRollup(full, [provBig]).mismatches.some((m) => m.field === "volume")).toBe(true);
  });

  it("tolerates Open/Close auction differences by default (H/L/V only)", () => {
    const bars = session5m("2026-06-12");
    const prov = trueDaily("2026-06-12", bars);
    prov.o = prov.o + 0.5;  // auction open differs from first 5m open
    prov.c = prov.c - 0.5;  // auction close differs from last 5m close
    const r = reconcileDailyRollup(bars, [prov]);
    expect(r.ok).toBe(true); // O/C not gated by default
  });

  it("gates on O/C when requireOpenClose=true", () => {
    const bars = session5m("2026-06-12");
    const prov = trueDaily("2026-06-12", bars);
    prov.c = prov.c - 5;
    const r = reconcileDailyRollup(bars, [prov], { requireOpenClose: true });
    expect(r.ok).toBe(false);
    expect(r.mismatches.some((m) => m.field === "close")).toBe(true);
  });

  it("reports days present intraday but missing a provider daily bar", () => {
    const bars = session5m("2026-06-12");
    const r = reconcileDailyRollup(bars, []); // no provider daily at all
    expect(r.missing_daily).toBe(1);
    expect(r.matched).toBe(0);
  });
});

describe("crossSourceConsensus (cross-provider ground truth)", () => {
  // Real AAPL 2026-06-01 ground truth verified via web: H 310.94 L 305.02 C 306.31
  it("accepts when >=2 independent sources agree", () => {
    const r = crossSourceConsensus({
      td: { h: 310.94, l: 305.02, c: 306.31 },
      web: { h: 310.94, l: 305.02, c: 306.31 },
    });
    expect(r.agreed).toBe(true);
    expect(r.consensus.h).toBeCloseTo(310.94);
    expect(r.outliers).toEqual([]);
  });

  it("flags the disagreeing provider as the outlier (2-of-3 quorum)", () => {
    const r = crossSourceConsensus({
      td: { h: 310.94, l: 305.02, c: 306.31 },
      alpaca: { h: 310.93, l: 305.03, c: 306.30 }, // within tol of td
      bad: { h: 315.45, l: 306.69, c: 315.20 },     // a day-shifted/wrong source
    });
    expect(r.agreed).toBe(true);
    expect(r.outliers).toContain("bad");
    expect(r.outliers).not.toContain("td");
  });

  it("reports no consensus when sources scatter / quorum unmet", () => {
    const r = crossSourceConsensus({
      a: { h: 310.94, l: 305.02, c: 306.31 },
      b: { h: 315.45, l: 306.69, c: 315.20 },
    }, { quorum: 2 });
    expect(r.agreed).toBe(false);
    expect(r.consensus.h).toBeNull();
  });

  it("uses a RELATIVE band at high prices (a few cents on a ~$950 5m bar agree)", () => {
    // MU 5m 2026-06-08 ground truth: TD vs Alpaca differed by 0.02-0.25 on ~$955,
    // i.e. < 0.03% — real agreement, not a disagreement.
    const hi = {
      td: { h: 961.75, l: 953.0, c: 954.87 },
      alpaca: { h: 962.0, l: 953.0, c: 954.87 }, // H differs $0.25 (~0.026%)
    };
    // absolute-only floor would flag it...
    expect(crossSourceConsensus(hi, { relTol: 0 }).agreed).toBe(false);
    // ...the default relative band (5 bps) correctly accepts it.
    expect(crossSourceConsensus(hi).agreed).toBe(true);
    expect(crossSourceConsensus(hi).consensus.h).toBeGreaterThan(961);
  });

  it("still flags a genuine gross disagreement at high prices", () => {
    const r = crossSourceConsensus({
      td: { h: 961.75, l: 953.0, c: 954.87 },
      alpaca: { h: 980.0, l: 953.0, c: 954.87 }, // H off by ~2% → real outlier
    });
    expect(r.field_agreement.h).toBe(1);
    expect(r.consensus.h).toBeNull();
  });
});
