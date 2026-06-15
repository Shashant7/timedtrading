// worker/foundation/resample.test.js
import { describe, it, expect } from "vitest";
import {
  resampleAligned, resampleIntradaySessions,
  resampleDailyToWeekly, resampleDailyToMonthly,
} from "./resample.js";
import { expectedIntradayBuckets, sessionBoundsUtc } from "./trading-calendar.js";

// Build a synthetic full 5m session for 2026-06-12 with deterministic OHLCV.
function session5m(dateStr) {
  return expectedIntradayBuckets(dateStr, 5).map((ts, i) => ({
    ts, o: 100 + i, h: 100 + i + 0.5, l: 100 + i - 0.5, c: 100 + i + 0.2, v: 10,
  }));
}

describe("resample: OHLCV aggregation", () => {
  it("aggregates o=first h=max l=min c=last v=sum", () => {
    const anchor = 0;
    const bars = [
      { ts: 0, o: 10, h: 12, l: 9, c: 11, v: 5 },
      { ts: 300000, o: 11, h: 15, l: 8, c: 14, v: 7 },
    ];
    const out = resampleAligned(bars, 10, anchor); // both into one 10m bucket
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ ts: 0, o: 10, h: 15, l: 8, c: 14, v: 12 });
  });
});

describe("resample: session-anchored intraday derive", () => {
  const base = session5m("2026-06-12");

  it("78x5m → 13x30m, session-anchored at the open", () => {
    const out = resampleIntradaySessions(base, 30);
    expect(out.length).toBe(13);
    expect(out[0].ts).toBe(sessionBoundsUtc("2026-06-12").openMs);
    // first 30m bucket aggregates the first six 5m bars (i=0..5)
    expect(out[0]).toMatchObject({ o: 100, h: 105.5, l: 99.5, v: 60 });
  });

  it("78x5m → 6x60m + a final partial (13:00 last hour) ... 60m count", () => {
    const out = resampleIntradaySessions(base, 60);
    // 6.5h → 6 full 60m buckets + 1 half (15:30-16:00) = 7
    expect(out.length).toBe(7);
  });

  it("is deterministic (same input → identical output)", () => {
    expect(resampleIntradaySessions(base, 30)).toEqual(resampleIntradaySessions(base, 30));
  });

  it("derived 30m bars reconcile exactly to the base they came from", () => {
    const out = resampleIntradaySessions(base, 30);
    // total volume conserved
    const baseVol = base.reduce((s, b) => s + b.v, 0);
    const outVol = out.reduce((s, b) => s + b.v, 0);
    expect(outVol).toBe(baseVol);
  });
});

describe("resample: CANONICAL 60m/240m anchor + self-consistency (pinned)", () => {
  const open = sessionBoundsUtc("2026-06-12").openMs;
  const base = session5m("2026-06-12");

  // Each derived bar must equal the exact aggregate of the base bars inside its
  // [bucketOpen, bucketOpen+tf) window — the "self-consistent by construction"
  // guarantee the chain relies on (not byte-equality to a provider's hourly).
  function assertSelfConsistent(derived, tfMin) {
    const tfMs = tfMin * 60_000;
    for (const bar of derived) {
      const members = base.filter((b) => b.ts >= bar.ts && b.ts < bar.ts + tfMs);
      expect(members.length).toBeGreaterThan(0);
      const o = members[0].o;
      const c = members[members.length - 1].c;
      const h = Math.max(...members.map((m) => m.h));
      const l = Math.min(...members.map((m) => m.l));
      const v = members.reduce((s, m) => s + m.v, 0);
      expect(bar).toMatchObject({ o, h, l, c, v });
    }
  }

  it("60m anchors at the session open (09:30,10:30,…,15:30) with a 15:30–16:00 partial last bar", () => {
    const out = resampleIntradaySessions(base, 60);
    expect(out.length).toBe(7);
    expect(out[0].ts).toBe(open);
    expect(out[6].ts).toBe(open + 6 * 60 * 60_000); // 15:30
    // the last (15:30) bar is a 30-min partial: only six 5m bars (78 - 72)
    const last = base.filter((b) => b.ts >= out[6].ts);
    expect(last.length).toBe(6);
    assertSelfConsistent(out, 60);
  });

  it("240m anchors at 09:30 & 13:30 with a 13:30–16:00 partial", () => {
    const out = resampleIntradaySessions(base, 240);
    expect(out.length).toBe(2);
    expect(out[0].ts).toBe(open);
    expect(out[1].ts).toBe(open + 4 * 60 * 60_000); // 13:30
    assertSelfConsistent(out, 240);
  });

  it("RTH clip: pre/post-market base bars NEVER spawn an out-of-session bucket", () => {
    const sb = sessionBoundsUtc("2026-06-12");
    const withExt = [
      { ts: sb.openMs - 30 * 60_000, o: 1, h: 1, l: 1, c: 1, v: 99 },  // 09:00 pre-market
      ...base,
      { ts: sb.closeMs + 30 * 60_000, o: 9, h: 9, l: 9, c: 9, v: 99 }, // 16:30 after-hours
    ];
    const clipped = resampleIntradaySessions(withExt, 60);
    expect(clipped.length).toBe(7);                 // still exactly the RTH hourly grid
    expect(clipped[0].ts).toBe(sb.openMs);          // no 08:30 bucket
    expect(clipped[clipped.length - 1].ts).toBeLessThan(sb.closeMs); // no 16:30 bucket
    // raw (opt-out) keeps the extended buckets
    const raw = resampleIntradaySessions(withExt, 60, { clipToSession: false });
    expect(raw.length).toBeGreaterThan(7);
  });
});

describe("resample: daily → W/M", () => {
  // 30 consecutive calendar days of daily bars spanning two months.
  const daily = [];
  for (let d = 0; d < 45; d++) {
    const ts = Date.UTC(2026, 4, 15, 13, 30) + d * 24 * 3600 * 1000; // from 2026-05-15
    daily.push({ ts, o: d, h: d + 1, l: d - 1, c: d + 0.5, v: 1 });
  }
  it("monthly groups by calendar month", () => {
    const m = resampleDailyToMonthly(daily);
    expect(m.length).toBe(2); // May + June (spans into late June)
  });
  it("weekly groups by ISO week", () => {
    const w = resampleDailyToWeekly(daily);
    expect(w.length).toBeGreaterThanOrEqual(6);
    expect(w.length).toBeLessThanOrEqual(8);
  });
});
