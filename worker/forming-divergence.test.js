import { describe, it, expect } from "vitest";
import { detectFormingSeriesDivergence, detectSeriesDivergence } from "./indicators.js";

// ─────────────────────────────────────────────────────────────────────────────
// Forming divergence (2026-08-16, NEU Jul 21 autopsy).
//
// The confirmed detector needs the second swing pivot to have `pivotLookback`
// bars printed to its RIGHT before it exists, so a divergence forming at the
// current high — price above the last confirmed swing high while the
// oscillator fails to follow — is invisible exactly when the entry decision
// is being made. These tests pin that gap and the forming detector's rules.
// ─────────────────────────────────────────────────────────────────────────────

/** Build bars from an array of highs; lows/open/close derived. */
function barsFromHighs(highs) {
  return highs.map((h, i) => ({ o: h - 0.5, h, l: h - 1, c: h - 0.3, ts: i }));
}

/** Build bars from an array of lows; highs derived, flat enough to avoid high pivots. */
function barsFromLows(lows) {
  return lows.map((l, i) => ({ o: l + 0.5, h: l + 1, l, c: l + 0.3, ts: i }));
}

describe("detectFormingSeriesDivergence — bearish at the right edge", () => {
  // Confirmed swing high at idx 10 (h=15, osc=70). Price then dips and
  // pushes to a NEW high at idx 18 (h=16) with the oscillator at 60 —
  // classic bearish divergence forming at the current high.
  const highs = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 15, 12, 11, 11, 10, 10, 13, 14, 16, 15.5];
  const osc = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 70, 55, 52, 52, 50, 50, 56, 58, 60, 59];
  const bars = barsFromHighs(highs);

  it("flags the forming bearish divergence the confirmed detector cannot see", () => {
    const confirmed = detectSeriesDivergence(bars, osc, 5, 10);
    expect(confirmed.bear).toBeNull(); // idx 18 not a confirmed pivot yet

    const forming = detectFormingSeriesDivergence(bars, osc, 5, 3);
    expect(forming.bear).not.toBeNull();
    expect(forming.bear.strength).toBe(10); // 70 - 60
    expect(forming.bear.barsSince).toBe(1); // new high was one bar ago
    expect(forming.bear.forming).toBe(true);
  });

  it("stays silent when the oscillator confirms the new high", () => {
    const oscConfirming = osc.map((v, i) => (i >= 16 ? 75 : v));
    const forming = detectFormingSeriesDivergence(bars, oscConfirming, 5, 3);
    expect(forming.bear).toBeNull();
  });

  it("stays silent when price has not exceeded the last confirmed swing high", () => {
    const highsNoBreak = highs.map((h, i) => (i >= 16 ? Math.min(h, 14.5) : h));
    const forming = detectFormingSeriesDivergence(barsFromHighs(highsNoBreak), osc, 5, 3);
    expect(forming.bear).toBeNull();
  });

  it("ignores a stale right-edge extreme (older than maxAge)", () => {
    // New high at idx 20 (unconfirmable: only 4 right bars), then 4 quiet
    // bars — the extreme is 4 bars old with maxAge 3.
    const highsStale = [...highs.slice(0, 20), 16.2, 10, 10, 10, 10];
    const oscStale = [...osc.slice(0, 20), 60, 50, 50, 50, 50];
    const forming = detectFormingSeriesDivergence(barsFromHighs(highsStale), oscStale, 5, 3);
    expect(forming.bear).toBeNull();
  });
});

describe("detectFormingSeriesDivergence — bullish at the right edge", () => {
  // Confirmed swing low at idx 10 (l=5, osc=30). Price undercuts to a new
  // low at idx 18 (l=4) with the oscillator HIGHER at 40 — bullish
  // divergence forming at the current low.
  const lows = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 5, 8, 9, 9, 10, 10, 7, 6, 4, 4.5];
  const osc = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 30, 45, 48, 48, 50, 50, 44, 42, 40, 41];
  const bars = barsFromLows(lows);

  it("flags the forming bullish divergence", () => {
    const forming = detectFormingSeriesDivergence(bars, osc, 5, 3);
    expect(forming.bull).not.toBeNull();
    expect(forming.bull.strength).toBe(10); // 40 - 30
    expect(forming.bull.barsSince).toBe(1);
  });

  it("stays silent when the oscillator makes a lower low too", () => {
    const oscConfirming = osc.map((v, i) => (i >= 16 ? 25 : v));
    const forming = detectFormingSeriesDivergence(bars, oscConfirming, 5, 3);
    expect(forming.bull).toBeNull();
  });
});

describe("detectFormingSeriesDivergence — degenerate inputs", () => {
  it("returns nulls on short or missing series", () => {
    expect(detectFormingSeriesDivergence(null, null, 5, 3)).toEqual({ bear: null, bull: null });
    expect(detectFormingSeriesDivergence([{ h: 1, l: 0 }], [50], 5, 3)).toEqual({ bear: null, bull: null });
  });

  it("returns nulls when there is no confirmed pivot yet", () => {
    const bars = barsFromHighs([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    const osc = bars.map(() => 50);
    expect(detectFormingSeriesDivergence(bars, osc, 5, 3)).toEqual({ bear: null, bull: null });
  });
});
