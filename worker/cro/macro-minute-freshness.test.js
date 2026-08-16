import { describe, it, expect } from "vitest";
import {
  etClock,
  etDateParts,
  isMacroMinuteSessionDay,
  countMissedMacroMinuteSessions,
  assessMacroMinuteFreshness,
} from "./macro-minute-freshness.js";
import { splitMacroMinuteBody } from "./vimeo-transcript.js";

const at = (iso) => Date.parse(iso);

describe("isMacroMinuteSessionDay", () => {
  // Macro Minute runs Mon-Thu. Every Friday from Jul 1 to Aug 14 2026 was
  // skipped, so Fridays and weekends are not expected sessions.
  it("counts Monday through Thursday only", () => {
    expect(isMacroMinuteSessionDay("2026-08-10")).toBe(true);  // Mon
    expect(isMacroMinuteSessionDay("2026-08-13")).toBe(true);  // Thu
    expect(isMacroMinuteSessionDay("2026-08-14")).toBe(false); // Fri
    expect(isMacroMinuteSessionDay("2026-08-15")).toBe(false); // Sat
    expect(isMacroMinuteSessionDay("2026-08-16")).toBe(false); // Sun
  });
});

describe("countMissedMacroMinuteSessions", () => {
  const wedEpisode = at("2026-08-12T22:54:01Z"); // Wed 6:54 PM ET

  it("does not count the publish day itself", () => {
    expect(countMissedMacroMinuteSessions(wedEpisode, at("2026-08-12T23:30:00Z"))).toBe(0);
  });

  it("counts an evening only after its cutoff has passed", () => {
    // Thu 10 AM ET — Thursday's slot is still open.
    expect(countMissedMacroMinuteSessions(wedEpisode, at("2026-08-13T14:00:00Z"))).toBe(0);
    // Thu 11 PM ET — Thursday closed with nothing.
    expect(countMissedMacroMinuteSessions(wedEpisode, at("2026-08-14T03:00:00Z"))).toBe(1);
  });

  // The Sunday page: a Wednesday episode plus a skipped Thursday is ONE miss,
  // because Friday and the weekend are not publishing days.
  it("does not accrue misses across Friday or the weekend", () => {
    expect(countMissedMacroMinuteSessions(wedEpisode, at("2026-08-14T21:00:00Z"))).toBe(1); // Fri
    expect(countMissedMacroMinuteSessions(wedEpisode, at("2026-08-15T17:00:00Z"))).toBe(1); // Sat
    expect(countMissedMacroMinuteSessions(wedEpisode, at("2026-08-16T17:00:00Z"))).toBe(1); // Sun
  });

  it("resumes counting on the next Monday evening", () => {
    expect(countMissedMacroMinuteSessions(wedEpisode, at("2026-08-17T14:00:00Z"))).toBe(1); // Mon 10 AM
    expect(countMissedMacroMinuteSessions(wedEpisode, at("2026-08-18T03:00:00Z"))).toBe(2); // Mon 11 PM
  });

  it("counts consecutive mid-week misses", () => {
    const monEpisode = at("2026-08-10T21:00:00Z"); // Mon 5 PM ET
    expect(countMissedMacroMinuteSessions(monEpisode, at("2026-08-12T03:00:00Z"))).toBe(1); // Tue 11 PM
    expect(countMissedMacroMinuteSessions(monEpisode, at("2026-08-13T03:00:00Z"))).toBe(2); // Wed 11 PM
  });

  it("treats an unparseable publish time as infinitely stale", () => {
    expect(countMissedMacroMinuteSessions(NaN, at("2026-08-16T17:00:00Z"))).toBe(Infinity);
  });
});

describe("assessMacroMinuteFreshness", () => {
  const fresh = { hasTranscript: true, charCount: 4800 };

  it("marks a same-week transcript fresh during the day", () => {
    const r = assessMacroMinuteFreshness({
      nowMs: at("2026-08-12T14:00:00Z"),
      publishedAt: "2026-08-11T17:51:00Z",
      ...fresh,
    });
    expect(r.status).toBe("fresh");
  });

  it("marks a blurb-only row thin even if recent", () => {
    const r = assessMacroMinuteFreshness({
      nowMs: at("2026-08-12T14:00:00Z"),
      publishedAt: "2026-08-11T17:51:00Z",
      hasTranscript: false,
      charCount: 600,
    });
    expect(r.status).toBe("thin");
  });

  it("marks two consecutive missed weekday evenings stale", () => {
    const r = assessMacroMinuteFreshness({
      nowMs: at("2026-08-14T14:00:00Z"), // Fri 10 AM ET; Wed + Thu both missed
      publishedAt: "2026-08-11T17:51:00Z",
      ...fresh,
    });
    expect(r.status).toBe("stale");
    expect(r.missed_sessions).toBe(2);
  });

  // The alert that started this: Wed episode, Sunday assessment, 90.4 raw hours.
  it("stays fresh on a Sunday after a Wednesday episode", () => {
    const r = assessMacroMinuteFreshness({
      nowMs: at("2026-08-16T17:00:00Z"),
      publishedAt: "2026-08-12T22:54:01Z",
      ...fresh,
    });
    expect(r.status).toBe("fresh");
    expect(r.missed_sessions).toBe(1);
    expect(r.age_hours).toBeGreaterThan(90); // raw age would have paged
  });

  it("still pages once the following Monday evening also passes", () => {
    const r = assessMacroMinuteFreshness({
      nowMs: at("2026-08-18T03:00:00Z"), // Mon 11 PM ET
      publishedAt: "2026-08-12T22:54:01Z",
      ...fresh,
    });
    expect(r.status).toBe("stale");
    expect(r.missed_sessions).toBe(2);
  });

  it("marks missing when there is no published_at", () => {
    expect(assessMacroMinuteFreshness({ nowMs: at("2026-08-12T14:00:00Z") }).status).toBe("missing");
  });
});

describe("etDateParts", () => {
  it("reports the ET calendar day, not the UTC one", () => {
    // 01:30 UTC Thursday is still Wednesday evening in New York.
    expect(etDateParts(at("2026-08-13T01:30:00Z"))).toEqual({ date: "2026-08-12", hour: 21 });
  });
});

describe("etClock", () => {
  it("returns a weekday and hour in range", () => {
    const c = etClock(at("2026-08-13T07:15:00Z"));
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
