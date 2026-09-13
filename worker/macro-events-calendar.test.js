import { describe, it, expect } from "vitest";
import {
  CURATED_UPCOMING_MACRO,
  getUpcomingMacroEvents,
  isFomcDecisionName,
  isWeekendYmd,
  resolveMacroPersistDate,
  snapKnownMacroDate,
} from "./macro-events-calendar.js";

function stubDb(selectRows = []) {
  return {
    prepare(sql) {
      const stmt = {
        bind() {
          return {
            all: async () => ({ results: /FROM market_events/i.test(sql) && /SELECT date, event_name/i.test(sql) ? selectRows : [] }),
            first: async () => null,
            run: async () => ({ meta: { changes: 0 } }),
          };
        },
        all: async () => ({ results: selectRows }),
        first: async () => null,
        run: async () => ({ meta: { changes: 0 } }),
      };
      return stmt;
    },
    batch: async () => {},
  };
}

function stubEnv({ fsdEvents = [], d1Rows = [] } = {}) {
  const byKey = {};
  for (const e of fsdEvents) {
    byKey[`${e.date}|${String(e.name).toLowerCase()}`] = e;
  }
  return {
    KV: {
      get: async () => JSON.stringify({ byKey, updated_at: 1 }),
    },
    DB: stubDb(d1Rows),
  };
}

describe("CURATED_UPCOMING_MACRO", () => {
  it("includes the rest of 2026 FOMC decision days", () => {
    const fomc = CURATED_UPCOMING_MACRO.filter((e) => e.kind === "fomc").map((e) => e.date);
    expect(fomc).toContain("2026-09-16");
    expect(fomc).toContain("2026-10-28");
    expect(fomc).toContain("2026-12-09");
  });
});

describe("isFomcDecisionName", () => {
  it("matches decision copy and skips minutes", () => {
    expect(isFomcDecisionName("FOMC rate decision")).toBe(true);
    expect(isFomcDecisionName("Sep FOMC Rate Decision + SEP")).toBe(true);
    expect(isFomcDecisionName("FOMC Minutes")).toBe(false);
    expect(isFomcDecisionName("Sep Empire Manufacturing")).toBe(false);
  });
});

describe("snapKnownMacroDate", () => {
  it("snaps a Sunday-dated FOMC decision onto Wed Sep 16", () => {
    const snapped = snapKnownMacroDate({ date: "2026-09-13", name: "FOMC rate decision" });
    expect(snapped.date).toBe("2026-09-16");
    expect(snapped.date_raw).toBe("2026-09-13");
    expect(snapped.date_snapped).toBe("curated_fomc");
  });

  it("snaps meeting-day-1 FOMC onto the decision day", () => {
    const snapped = snapKnownMacroDate({ date: "2026-09-15", name: "FOMC rate decision" });
    expect(snapped.date).toBe("2026-09-16");
  });

  it("leaves the published decision day alone", () => {
    const snapped = snapKnownMacroDate({ date: "2026-09-16", name: "Sep FOMC Rate Decision + SEP" });
    expect(snapped.date).toBe("2026-09-16");
    expect(snapped.date_snapped).toBeUndefined();
  });

  it("does not remap FOMC minutes onto a decision day", () => {
    const snapped = snapKnownMacroDate({ date: "2026-10-07", name: "FOMC Minutes" });
    expect(snapped.date).toBe("2026-10-07");
    expect(snapped.date_snapped).toBeUndefined();
  });

  it("does not move non-FOMC prints", () => {
    const snapped = snapKnownMacroDate({ date: "2026-09-15", name: "Sep Empire Manufacturing" });
    expect(snapped.date).toBe("2026-09-15");
  });

  it("drops a weekend FOMC with no curated decision nearby", () => {
    expect(isWeekendYmd("2027-01-03")).toBe(true);
    expect(snapKnownMacroDate({ date: "2027-01-03", name: "FOMC rate decision" })).toBeNull();
  });
});

describe("resolveMacroPersistDate", () => {
  it("rewrites Friday-brief FOMC dates before INSERT", () => {
    expect(resolveMacroPersistDate({ event: "FOMC rate decision", date: "2026-09-13" }, "2026-09-11")).toBe("2026-09-16");
    expect(resolveMacroPersistDate({ event: "FOMC rate decision", date: "2026-09-15" }, "2026-09-11")).toBe("2026-09-16");
  });

  it("drops an unsnappable weekend FOMC instead of writing Sunday", () => {
    expect(resolveMacroPersistDate({ event: "FOMC rate decision", date: "2027-01-03" }, "2027-01-03")).toBeNull();
  });
});

describe("getUpcomingMacroEvents FOMC snap", () => {
  it("does not label Sunday as FOMC today when FSD dated the decision Sep 13", async () => {
    const env = stubEnv({
      fsdEvents: [
        { date: "2026-09-13", name: "FOMC rate decision", impact: "high", kind: "fomc" },
        { date: "2026-09-15", name: "Sep Empire Manufacturing", impact: "medium", kind: "manufacturing" },
      ],
    });
    const out = await getUpcomingMacroEvents(env, { days: 10, today: "2026-09-13" });
    const fomc = (out.events || []).filter((e) => isFomcDecisionName(e.name));
    expect(fomc).toHaveLength(1);
    expect(fomc[0].date).toBe("2026-09-16");
    expect(fomc[0].is_today).toBe(false);
    const empire = (out.events || []).find((e) => /empire/i.test(e.name));
    expect(empire?.date).toBe("2026-09-15");
    expect(empire?.is_today).toBe(false);
  });

  it("snaps a D1 Sunday FOMC row onto the curated decision day", async () => {
    const env = stubEnv({
      d1Rows: [
        {
          date: "2026-09-13",
          event_name: "FOMC rate decision",
          scheduled_time_et: "14:00",
          event_key: "FOMC",
          source: "daily_brief_econ",
          impact: "high",
        },
        {
          date: "2026-09-15",
          event_name: "Sep Empire Manufacturing Survey",
          scheduled_time_et: "08:30",
          event_key: "OTHER_MACRO",
          source: "daily_brief_econ",
          impact: "medium",
        },
      ],
    });
    const out = await getUpcomingMacroEvents(env, { days: 10, today: "2026-09-13" });
    const fomc = (out.events || []).filter((e) => isFomcDecisionName(e.name));
    expect(fomc).toHaveLength(1);
    expect(fomc[0].date).toBe("2026-09-16");
    expect(fomc[0].is_today).toBe(false);
  });
});
