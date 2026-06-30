import { describe, it, expect } from "vitest";
import { applyFREDActuals } from "./macro-actuals-fred.js";
import {
  fredObsMatchesEventReference,
  macroEventHasReleased,
  parseReferenceMonthFromEventName,
  stripPreReleaseActuals,
} from "./macro-release-time.js";

describe("macroEventHasReleased", () => {
  const jolts = { date: "2026-06-30", time_et: "10:00 AM", name: "May JOLTS Job Openings" };

  it("is false for future calendar dates", () => {
    const now = new Date("2026-06-24T14:00:00.000Z");
    expect(macroEventHasReleased(jolts, now)).toBe(false);
  });

  it("is false on release day before ET time", () => {
    const now = new Date("2026-06-30T13:30:00.000Z"); // 9:30 AM ET (EDT)
    expect(macroEventHasReleased(jolts, now)).toBe(false);
  });

  it("is true on release day after ET time", () => {
    const now = new Date("2026-06-30T14:05:00.000Z"); // 10:05 AM ET
    expect(macroEventHasReleased(jolts, now)).toBe(true);
  });

  it("is true for past release dates", () => {
    const now = new Date("2026-07-01T14:00:00.000Z");
    expect(macroEventHasReleased(jolts, now)).toBe(true);
  });
});

describe("parseReferenceMonthFromEventName", () => {
  it("resolves May reference on a June release", () => {
    expect(parseReferenceMonthFromEventName("May JOLTS Job Openings", "2026-06-30"))
      .toEqual({ year: 2026, month0: 4 });
  });
});

describe("fredObsMatchesEventReference", () => {
  it("matches May obs to May JOLTS", () => {
    const event = { name: "May JOLTS Job Openings", date: "2026-06-30" };
    expect(fredObsMatchesEventReference(event, "2026-05-31")).toBe(true);
    expect(fredObsMatchesEventReference(event, "2026-04-30")).toBe(false);
  });
});

describe("stripPreReleaseActuals", () => {
  it("removes actuals from future and pre-release events", () => {
    const events = [
      { date: "2026-06-30", time_et: "10:00 AM", name: "May JOLTS", actual: "7.4M", actual_source: "fsd" },
      { date: "2026-06-25", time_et: "8:30 AM", name: "May PCE", actual: "+0.2%", actual_source: "fred" },
    ];
    stripPreReleaseActuals(events, new Date("2026-06-30T13:30:00.000Z"));
    expect(events[0].actual).toBeUndefined();
    expect(events[1].actual).toBe("+0.2%");
  });
});

describe("applyFREDActuals release gating", () => {
  const mockEnv = {
    KV: {
      get: async () => JSON.stringify({
        byKey: {
          jolts: { key: "jolts", display: "7.3M", obs_date: "2026-05-31", previous_display: "7.4M" },
        },
      }),
    },
  };

  it("does not apply May JOLTS before 10:00 AM ET on release day", async () => {
    const ev = [{ date: "2026-06-30", time_et: "10:00 AM", name: "May JOLTS Job Openings" }];
    await applyFREDActuals(mockEnv, ev, "2026-06-30", new Date("2026-06-30T13:30:00.000Z"));
    expect(ev[0].actual).toBeUndefined();
  });

  it("applies May JOLTS after 10:00 AM ET on release day", async () => {
    const ev = [{ date: "2026-06-30", time_et: "10:00 AM", name: "May JOLTS Job Openings" }];
    await applyFREDActuals(mockEnv, ev, "2026-06-30", new Date("2026-06-30T14:05:00.000Z"));
    expect(ev[0].actual).toBe("7.3M");
  });

  it("rejects April obs for May JOLTS even after release time", async () => {
    const envApril = {
      KV: {
        get: async () => JSON.stringify({
          byKey: {
            jolts: { key: "jolts", display: "7.4M", obs_date: "2026-04-30" },
          },
        }),
      },
    };
    const ev = [{ date: "2026-06-30", time_et: "10:00 AM", name: "May JOLTS Job Openings" }];
    await applyFREDActuals(envApril, ev, "2026-06-30", new Date("2026-06-30T14:05:00.000Z"));
    expect(ev[0].actual).toBeUndefined();
  });
});
