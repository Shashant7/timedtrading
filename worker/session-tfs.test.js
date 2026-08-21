import { describe, expect, it } from "vitest";
import {
  isNyRthBar,
  nyParts,
  synthesizeNineHourBars,
  synthesizeRthSessionBars,
} from "./session-tfs.js";

function bar(iso, o, h, l, c) {
  return { ts: Date.parse(iso), o, h, l, c, v: 10 };
}

describe("nyParts / RTH window", () => {
  it("treats 09:30–15:30 ET as RTH and 16:00 as closed", () => {
    // 2026-08-20 is a Thursday.
    expect(isNyRthBar(Date.parse("2026-08-20T13:30:00Z"))).toBe(true); // 09:30 ET
    expect(isNyRthBar(Date.parse("2026-08-20T19:30:00Z"))).toBe(true); // 15:30 ET
    expect(isNyRthBar(Date.parse("2026-08-20T20:00:00Z"))).toBe(false); // 16:00 ET
    expect(isNyRthBar(Date.parse("2026-08-20T13:00:00Z"))).toBe(false); // 09:00 ET
  });

  it("reads America/New_York date parts", () => {
    const p = nyParts(Date.parse("2026-08-20T13:30:00Z"));
    expect(p.dateKey).toBe("2026-08-20");
    expect(p.hour).toBe(9);
    expect(p.minute).toBe(30);
  });
});

describe("synthesizeRthSessionBars", () => {
  it("rolls 30m RTH prints into one 6.5H session bar and drops ETH", () => {
    const bars = [
      bar("2026-08-20T12:00:00Z", 10, 10.2, 9.9, 10.1), // 08:00 ET premarket
      bar("2026-08-20T13:30:00Z", 10.2, 10.5, 10.1, 10.4), // 09:30
      bar("2026-08-20T16:00:00Z", 10.4, 11.0, 10.3, 10.8), // 12:00
      bar("2026-08-20T19:30:00Z", 10.8, 10.9, 10.6, 10.7), // 15:30
      bar("2026-08-20T20:30:00Z", 10.7, 10.8, 10.5, 10.6), // 16:30 AH
    ];
    const out = synthesizeRthSessionBars(bars);
    expect(out).toHaveLength(1);
    expect(out[0].o).toBe(10.2);
    expect(out[0].h).toBe(11.0);
    expect(out[0].l).toBe(10.1);
    expect(out[0].c).toBe(10.7);
    expect(out[0].ts).toBe(Date.parse("2026-08-20T13:30:00Z"));
  });
});

describe("synthesizeNineHourBars", () => {
  it("buckets into 00 / 09 / 18 America/New_York", () => {
    const bars = [
      bar("2026-08-20T04:00:00Z", 1, 2, 1, 1.5),   // 00:00 ET
      bar("2026-08-20T08:00:00Z", 1.5, 2.2, 1.4, 2), // 04:00 ET — same 00–09 bucket
      bar("2026-08-20T13:30:00Z", 2, 3, 2, 2.8),     // 09:30 ET — 09–18 bucket
      bar("2026-08-20T22:30:00Z", 2.8, 3.1, 2.7, 3), // 18:30 ET — 18–24 bucket
    ];
    const out = synthesizeNineHourBars(bars);
    expect(out).toHaveLength(3);
    expect(out[0].o).toBe(1);
    expect(out[0].c).toBe(2);
    expect(out[1].o).toBe(2);
    expect(out[1].c).toBe(2.8);
    expect(out[2].o).toBe(2.8);
    expect(out[2].c).toBe(3);
  });
});
