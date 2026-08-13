import { describe, it, expect } from "vitest";
import {
  etClock,
  expectedMaxAgeHours,
  assessMacroMinuteFreshness,
} from "./macro-minute-freshness.js";
import { splitMacroMinuteBody } from "./vimeo-transcript.js";

describe("expectedMaxAgeHours", () => {
  it("relaxes over the weekend and allows one skipped weekday session", () => {
    expect(expectedMaxAgeHours(3, 22)).toBe(48);  // Wed 10 PM
    expect(expectedMaxAgeHours(3, 9)).toBe(48);   // Wed morning
    expect(expectedMaxAgeHours(6, 12)).toBe(90);  // Saturday
    expect(expectedMaxAgeHours(1, 9)).toBe(90);   // Monday morning
    expect(expectedMaxAgeHours(1, 19)).toBe(48);  // Monday evening
  });
});

describe("assessMacroMinuteFreshness", () => {
  const wed10am = Date.parse("2026-08-12T14:00:00Z"); // Wed 10 AM ET
  it("marks a same-week transcript fresh during the day", () => {
    const r = assessMacroMinuteFreshness({
      nowMs: wed10am,
      publishedAt: "2026-08-11T17:51:00",
      hasTranscript: true,
      charCount: 4800,
    });
    expect(r.status).toBe("fresh");
  });
  it("marks a blurb-only row thin even if recent", () => {
    const r = assessMacroMinuteFreshness({
      nowMs: wed10am,
      publishedAt: "2026-08-11T17:51:00",
      hasTranscript: false,
      charCount: 600,
    });
    expect(r.status).toBe("thin");
  });
  it("marks a two-day-old episode stale on a weekday", () => {
    const fri10am = Date.parse("2026-08-14T14:00:00Z"); // Fri 10 AM ET
    const r = assessMacroMinuteFreshness({
      nowMs: fri10am,
      publishedAt: "2026-08-11T17:51:00",
      hasTranscript: true,
      charCount: 4800,
    });
    expect(r.status).toBe("stale");
  });
  it("marks missing when there is no published_at", () => {
    expect(assessMacroMinuteFreshness({ nowMs: wed10am }).status).toBe("missing");
  });
});

describe("etClock", () => {
  it("returns a weekday and hour in range", () => {
    const c = etClock(Date.parse("2026-08-13T07:15:00Z"));
    expect(c.dow).toBeGreaterThanOrEqual(0);
    expect(c.dow).toBeLessThanOrEqual(6);
    expect(c.hour).toBeGreaterThanOrEqual(0);
    expect(c.hour).toBeLessThanOrEqual(23);
  });
});

describe("splitMacroMinuteBody", () => {
  it("splits blurb from spoken transcript", () => {
    const s = splitMacroMinuteBody("teaser blurb\n\n--- VIDEO TRANSCRIPT ---\nGood evening, Fundstrat Direct.");
    expect(s.has_transcript).toBe(true);
    expect(s.transcript).toContain("Good evening");
    expect(s.blurb).toContain("teaser");
  });
});
