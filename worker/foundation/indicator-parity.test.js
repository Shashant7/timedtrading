import { describe, expect, it } from "vitest";
import {
  compareParityRows,
  computeWorkerParityRow,
  expectedSessionClip,
  runParityFixture,
  validateParityFixture,
} from "./indicator-parity.js";

const DAY = 24 * 60 * 60 * 1000;
const start = Date.UTC(2026, 0, 1);

function syntheticBars(n = 80) {
  const out = [];
  let close = 100;
  for (let i = 0; i < n; i += 1) {
    const wave = Math.sin(i / 5) * 1.2;
    close += 0.18 + wave * 0.08;
    const open = close - 0.15;
    const high = close + 1 + (i % 3) * 0.1;
    const low = close - 1 - (i % 2) * 0.1;
    out.push({
      ts: start + i * DAY,
      o: Number(open.toFixed(4)),
      h: Number(high.toFixed(4)),
      l: Number(low.toFixed(4)),
      c: Number(close.toFixed(4)),
      v: 1_000_000 + i * 1000,
    });
  }
  return out;
}

function fixtureBase() {
  const candles = syntheticBars();
  const rowTs = candles[candles.length - 1].ts;
  return {
    fixture_version: 1,
    source: "synthetic_contract",
    ticker: "SYNTH",
    tf: "D",
    session_clip: "exchange",
    range: { start: "2026-01-01", end: "2026-03-21" },
    candles,
    rows: [
      {
        ts: rowTs,
        expected: {
          // Filled by tests after computing current worker output.
        },
      },
    ],
  };
}

describe("indicator parity fixture contract", () => {
  it("declares the canonical session clip by timeframe", () => {
    expect(expectedSessionClip("10")).toBe("extended");
    expect(expectedSessionClip("15")).toBe("extended");
    expect(expectedSessionClip("60")).toBe("rth");
    expect(expectedSessionClip("240")).toBe("rth");
    expect(expectedSessionClip("D")).toBe("exchange");
    expect(expectedSessionClip("W")).toBe("exchange");
  });

  it("rejects fixtures with the wrong session clip for the timeframe", () => {
    const f = fixtureBase();
    f.tf = "15";
    f.session_clip = "rth";
    const validation = validateParityFixture(f);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(" ")).toMatch(/session_clip rth does not match expected extended/);
  });

  it("validates a well-formed fixture shell", () => {
    const validation = validateParityFixture(fixtureBase());
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("computes a worker parity row with the expected signal fields", () => {
    const f = fixtureBase();
    const computed = computeWorkerParityRow({
      ticker: f.ticker,
      tf: f.tf,
      candles: f.candles,
      asOfTs: f.rows[0].ts,
    });
    expect(computed.ok).toBe(true);
    expect(computed.actual).toMatchObject({
      close: expect.any(Number),
      ema21: expect.any(Number),
      rsi14: expect.any(Number),
      atr14: expect.any(Number),
      supertrend_dir: expect.any(Number),
      td_bull_prep_count: expect.any(Number),
      td_bear_prep_count: expect.any(Number),
      phase_value: expect.any(Number),
      saty_phase_value: expect.any(Number),
      sq_on: expect.any(Boolean),
      pdz_position: expect.any(Number),
      fvg_in_bull: expect.any(Boolean),
      fvg_in_bear: expect.any(Boolean),
    });
  });

  it("reports numeric and exact mismatches clearly", () => {
    const result = compareParityRows(
      { ema21: 100, td9_bull: false },
      { ema21: 101, td9_bull: true },
      { numericTolerance: { ema21: 0.01 }, exactFields: ["td9_bull"] },
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      { field: "ema21", kind: "numeric", expected: 101, actual: 100, tolerance: 0.01 },
      { field: "td9_bull", kind: "exact", expected: true, actual: false },
    ]);
  });

  it("passes a self-consistency fixture generated from the worker output", () => {
    const f = fixtureBase();
    const computed = computeWorkerParityRow({
      ticker: f.ticker,
      tf: f.tf,
      candles: f.candles,
      asOfTs: f.rows[0].ts,
    });
    expect(computed.ok).toBe(true);
    f.rows[0].expected = {
      ema21: computed.actual.ema21,
      rsi14: computed.actual.rsi14,
      atr14: computed.actual.atr14,
      supertrend_dir: computed.actual.supertrend_dir,
      td_bull_prep_count: computed.actual.td_bull_prep_count,
      td_bear_prep_count: computed.actual.td_bear_prep_count,
      phase_zone: computed.actual.phase_zone,
      sq_on: computed.actual.sq_on,
    };

    const parity = runParityFixture(f);
    expect(parity.ok).toBe(true);
    expect(parity.rows[0].mismatches).toEqual([]);
  });
});
