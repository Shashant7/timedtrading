import { describe, it, expect } from "vitest";
import { computeFeedWindow } from "./feed-window.js";

// Build a UTC date: (dayOfWeek handled by picking known 2026 dates)
// 2026-06-10 is a Wednesday; 2026-06-14 is a Sunday; 2026-06-13 is a Saturday.
const at = (dateStr, h, m = 0) => new Date(`${dateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);

describe("computeFeedWindow", () => {
  it("runs the FULL feed on weekdays UTC 8-23", () => {
    for (const h of [8, 13, 16, 23]) {
      const w = computeFeedWindow(at("2026-06-10", h, 7));
      expect(w.isPriceFeedCron).toBe(true);
      expect(w.isLightweight).toBe(false);
    }
  });

  it("runs the FULL feed in the ET-evening spillover (Tue-Sat UTC hour <= 1)", () => {
    const w = computeFeedWindow(at("2026-06-10", 0, 30)); // Wed 00:30 UTC
    expect(w.isPriceFeedCron).toBe(true);
    expect(w.isLightweight).toBe(false);
  });

  it("does NOT run the spillover on Monday UTC 0-1 (utcDay 1 excluded)", () => {
    const w = computeFeedWindow(at("2026-06-08", 0, 30)); // Mon 00:30 UTC
    expect(w.isPriceFeedCron).toBe(false);
  });

  it("runs LIGHTWEIGHT overnight (UTC 2-8) only on minute % 5 === 0", () => {
    const on = computeFeedWindow(at("2026-06-10", 4, 10));
    expect(on.isPriceFeedCron).toBe(true);
    expect(on.isLightweight).toBe(true);
    const off = computeFeedWindow(at("2026-06-10", 4, 11));
    expect(off.isPriceFeedCron).toBe(false);
  });

  it("runs LIGHTWEIGHT Sunday evening (UTC >= 22) every minute", () => {
    const w = computeFeedWindow(at("2026-06-14", 22, 3)); // Sun 22:03 UTC
    expect(w.isPriceFeedCron).toBe(true);
    expect(w.isLightweight).toBe(true);
  });

  it("is quiet on Saturday outside the overnight window", () => {
    const w = computeFeedWindow(at("2026-06-13", 14, 0)); // Sat 14:00 UTC
    expect(w.isPriceFeedCron).toBe(false);
  });

  it("exposes utcMinute for the lightweight 30-min refresh gate", () => {
    expect(computeFeedWindow(at("2026-06-10", 12, 42)).utcMinute).toBe(42);
  });
});
