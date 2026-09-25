// worker/replay-asof-bars.test.js

import { describe, it, expect } from "vitest";
import { barsAsOf, formingDailyBar, lastPriorSessionIndex, utcDate } from "./replay-asof-bars.js";

const MIN = 60000;
const OPEN = Date.UTC(2026, 7, 3, 13, 30);          // 09:30 ET, Mon 2026-08-03
const m10 = [];
// 10m RTH bars for Jul 31 (Fri) and Aug 3 (Mon): close = 500 + index.
for (const [day, base] of [[Date.UTC(2026, 6, 31, 13, 30), 100], [OPEN, 200]]) {
  for (let i = 0; i < 39; i++) {
    const c = base + i;
    m10.push({ ts: day + i * 10 * MIN, o: c - 0.5, h: c + 1, l: c - 1, c, v: 10 });
  }
}
// Stored (final) bars, keyed by START like the DB.
const daily = [
  { ts: Date.UTC(2026, 6, 30), o: 90, h: 95, l: 85, c: 92, v: 1 },
  { ts: Date.UTC(2026, 6, 31), o: 99.5, h: 139, l: 99, c: 138, v: 390 },
  { ts: Date.UTC(2026, 6, 31, 4), o: 99.5, h: 139, l: 99, c: 138, v: 390 },   // duplicate stamp
  { ts: Date.UTC(2026, 7, 3), o: 199.5, h: 239, l: 199, c: 238, v: 390 },     // today's FINAL bar
];
const h1 = [
  { ts: OPEN, o: 199.5, h: 206, l: 199, c: 205, v: 60 },                       // 09:30-10:30 final
  { ts: OPEN + 60 * MIN, o: 205.5, h: 212, l: 205, c: 211, v: 60 },
];
const weekly = [
  { ts: Date.UTC(2026, 6, 27), o: 80, h: 139, l: 75, c: 138, v: 1 },
  { ts: Date.UTC(2026, 7, 3), o: 199.5, h: 300, l: 199, c: 290, v: 1 },        // this week's FINAL bar
];
const ctx = (intervalTs) => ({ intervalTs, leadingLtf: "10", ltfCandles: m10, dailyCandles: daily, sessionOpenMs: OPEN });

describe("barsAsOf — what the replay may know at 09:50 ET", () => {
  // Interval 09:40 prices at the 09:40-09:50 bar's close, so asOf = 09:50.
  const at = ctx(OPEN + 10 * MIN);

  it("leaves the leading LTF as it was (bar starting at intervalTs is the price)", () => {
    const b = barsAsOf("10", m10, at);
    expect(b.at(-1).ts).toBe(OPEN + 10 * MIN);
    expect(b.at(-1).c).toBe(201);
  });

  it("builds today's daily bar from what has traded, not the session's final close", () => {
    const b = barsAsOf("D", daily, at);
    expect(b.at(-1)).toMatchObject({ o: 199.5, h: 202, l: 199, c: 201, v: 20 });
    expect(b.filter((x) => utcDate(x.ts) === "2026-07-31")).toHaveLength(2);
    expect(b.some((x) => x.c === 238)).toBe(false);
  });

  it("replaces the in-progress hourly bar with the 10m bars so far", () => {
    const b = barsAsOf("60", h1, at);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ ts: OPEN, o: 199.5, h: 202, l: 199, c: 201, v: 20 });
  });

  it("keeps a bar once it has completed", () => {
    const b = barsAsOf("60", h1, ctx(OPEN + 50 * MIN));      // asOf 10:30
    expect(b[0].c).toBe(205);
    expect(b).toHaveLength(1);
  });

  it("builds this week's bar from the completed days plus today so far", () => {
    const b = barsAsOf("W", weekly, at);
    expect(b).toHaveLength(2);
    expect(b[1]).toMatchObject({ o: 199.5, h: 202, l: 199, c: 201 });
    expect(b[0].c).toBe(138);
  });

  it("drops a forming bar with nothing traded yet", () => {
    const later = [...h1, { ts: OPEN + 120 * MIN, o: 1, h: 1, l: 1, c: 1, v: 1 }];
    expect(barsAsOf("60", later, at)).toHaveLength(1);
  });
});

describe("formingDailyBar / lastPriorSessionIndex", () => {
  it("is null before the first LTF bar closes", () => {
    expect(formingDailyBar({ ltfCandles: m10, asOfMs: OPEN + 5 * MIN, ltfMinutes: 10, sessionOpenMs: OPEN })).toBeNull();
  });

  it("finds the prior session's daily bar for daily-only inputs (VIX)", () => {
    expect(daily[lastPriorSessionIndex(daily, "2026-08-03")].ts).toBe(Date.UTC(2026, 6, 31, 4));
    expect(lastPriorSessionIndex(daily, "2026-07-01")).toBe(-1);
  });
});
