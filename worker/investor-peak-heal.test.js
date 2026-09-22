// worker/investor-peak-heal.test.js
//
// 2026-09-22 — fixing the auto-rebalance SELECT stops peak_price being
// overwritten with spot, but it cannot recover a peak the book already
// forgot. All 20 OPEN Long Term rows were carrying spot (or avg_entry when
// underwater): WTS understated by 10.9%, IWM by 6.4%, LLY by 5.9%. The
// trim-into-strength lane sizes off that number, so until the stored peaks
// are rebuilt it still only sees the extension the tape happens to show
// today. Daily candle highs remember what the column forgot.

import { describe, it, expect } from "vitest";
import { healInvestorPositionPeaks, planInvestorPeakHeal } from "./investor-positions-repair.js";

const DAY = 86400000;
const NOW = 1758500000000;

function makeDb({ positions = [], candles = [] } = {}) {
  const db = { updates: [], positions, candles };
  db.prepare = (sql) => ({
    bind: (...args) => ({
      all: async () => {
        if (/FROM investor_positions/i.test(sql)) return { results: db.positions };
        if (/FROM ticker_candles/i.test(sql)) {
          const [minTs, ...tickers] = args;
          const wanted = new Set(tickers.map(t => String(t).toUpperCase()));
          return {
            results: db.candles.filter(c => c.ts >= minTs && wanted.has(String(c.ticker).toUpperCase())),
          };
        }
        return { results: [] };
      },
      run: async () => {
        const m = /UPDATE investor_positions SET peak_price/i.test(sql);
        if (m) db.updates.push({ peak_price: args[0], updated_at: args[1], id: args[2] });
        return { success: true };
      },
    }),
    all: async () => {
      if (/FROM investor_positions/i.test(sql)) return { results: db.positions };
      return { results: [] };
    },
  });
  return db;
}

function bars(ticker, highs, startTs) {
  return highs.map((h, i) => ({ ticker, ts: startTs + i * DAY, h }));
}

describe("planInvestorPeakHeal", () => {
  it("raises a peak that the candles beat", () => {
    expect(planInvestorPeakHeal({ peak_price: 351.41, avg_entry: 350.03 }, 394.54))
      .toMatchObject({ peak_price: 394.54, before: 351.41, after: 394.54 });
  });

  it("never walks a peak back down", () => {
    // The whole point of the column is that it ratchets. A heal that can
    // lower it is just the original bug with extra steps.
    expect(planInvestorPeakHeal({ peak_price: 141.66, avg_entry: 115.9 }, 124.16)).toBeNull();
    expect(planInvestorPeakHeal({ peak_price: 141.66, avg_entry: 115.9 }, 141.66)).toBeNull();
  });

  it("floors at avg_entry so an underwater row still reports a peak", () => {
    // LLY / AMZN / EMR / GS / DINO were all sitting at avg_entry exactly.
    expect(planInvestorPeakHeal({ peak_price: 0, avg_entry: 1216.28 }, 1100))
      .toMatchObject({ peak_price: 1216.28 });
  });

  it("ignores a missing or nonsense high", () => {
    expect(planInvestorPeakHeal({ peak_price: 100, avg_entry: 90 }, null)).toBeNull();
    expect(planInvestorPeakHeal({ peak_price: 100, avg_entry: 90 }, 0)).toBeNull();
    expect(planInvestorPeakHeal({ peak_price: 100, avg_entry: 90 }, NaN)).toBeNull();
  });
});

describe("healInvestorPositionPeaks", () => {
  it("rebuilds the understated peaks the dropped column left behind", async () => {
    const entry = NOW - 60 * DAY;
    const db = makeDb({
      positions: [
        { id: "p-wts", ticker: "WTS", avg_entry: 350.03, peak_price: 351.41, first_entry_ts: entry },
        { id: "p-iwm", ticker: "IWM", avg_entry: 266.22, peak_price: 285.72, first_entry_ts: entry },
      ],
      candles: [
        ...bars("WTS", [360, 394.54, 351], entry),
        ...bars("IWM", [290, 305.18, 285], entry),
      ],
    });

    const res = await healInvestorPositionPeaks(db, { now: NOW });

    expect(res.open_count).toBe(2);
    expect(res.healed_count).toBe(2);
    expect(res.healed).toEqual([
      { id: "p-wts", ticker: "WTS", before: 351.41, after: 394.54 },
      { id: "p-iwm", ticker: "IWM", before: 285.72, after: 305.18 },
    ]);
    expect(db.updates).toEqual([
      { peak_price: 394.54, updated_at: NOW, id: "p-wts" },
      { peak_price: 305.18, updated_at: NOW, id: "p-iwm" },
    ]);
  });

  it("is a no-op on the second pass", async () => {
    // It runs on every investor compute, so it has to settle. If it kept
    // writing it would be another cron burning D1 writes forever.
    const entry = NOW - 30 * DAY;
    const db = makeDb({
      positions: [{ id: "p1", ticker: "KO", avg_entry: 83.33, peak_price: 87.29, first_entry_ts: entry }],
      candles: bars("KO", [88, 92.49, 87], entry),
    });

    const first = await healInvestorPositionPeaks(db, { now: NOW });
    expect(first.healed_count).toBe(1);

    db.positions[0].peak_price = 92.49;
    const second = await healInvestorPositionPeaks(db, { now: NOW });
    expect(second.healed_count).toBe(0);
    expect(db.updates).toHaveLength(1);
  });

  it("does not inherit the high of a previous hold on the same ticker", async () => {
    // A re-entered ticker has candles above its new entry window. The peak
    // belongs to this hold, not to the one that already closed.
    const oldEntry = NOW - 200 * DAY;
    const newEntry = NOW - 10 * DAY;
    const db = makeDb({
      positions: [
        { id: "p-old", ticker: "PLTR", avg_entry: 100, peak_price: 0, first_entry_ts: oldEntry },
        { id: "p-new", ticker: "NVDA", avg_entry: 209.04, peak_price: 0, first_entry_ts: newEntry },
      ],
      candles: [
        ...bars("PLTR", [120, 188.37, 150], oldEntry),
        // NVDA spiked to 400 long before this position opened.
        ...bars("NVDA", [400, 390], oldEntry),
        ...bars("NVDA", [220, 234.76, 227], newEntry),
      ],
    });

    const res = await healInvestorPositionPeaks(db, { now: NOW });
    const byId = new Map(res.healed.map(h => [h.id, h.after]));
    expect(byId.get("p-pltr") ?? byId.get("p-old")).toBe(188.37);
    expect(byId.get("p-new")).toBe(234.76);
  });

  it("respects dryRun", async () => {
    const entry = NOW - 20 * DAY;
    const db = makeDb({
      positions: [{ id: "p1", ticker: "MU", avg_entry: 983.39, peak_price: 1044.84, first_entry_ts: entry }],
      candles: bars("MU", [1000, 1064.49], entry),
    });

    const res = await healInvestorPositionPeaks(db, { dryRun: true, now: NOW });
    expect(res.healed_count).toBe(1);
    expect(db.updates).toEqual([]);
  });

  it("skips rows it cannot window or price instead of guessing", async () => {
    const db = makeDb({
      positions: [
        { id: "p-nots", ticker: "JPM", avg_entry: 352.83, peak_price: 0, first_entry_ts: 0 },
        { id: "p-nocandle", ticker: "MSFT", avg_entry: 495.57, peak_price: 0, first_entry_ts: NOW - DAY },
      ],
      candles: [],
    });

    const res = await healInvestorPositionPeaks(db, { now: NOW });
    expect(res.healed_count).toBe(0);
    expect(db.updates).toEqual([]);
    expect(res.skipped.map(s => s.reason).sort())
      .toEqual(["no_candles_since_entry", "no_first_entry_ts"]);
  });

  it("survives an empty book and a missing DB", async () => {
    expect((await healInvestorPositionPeaks(null, { now: NOW })).healed_count).toBe(0);
    const db = makeDb({ positions: [] });
    expect((await healInvestorPositionPeaks(db, { now: NOW })).healed_count).toBe(0);
  });
});
