import { describe, it, expect } from "vitest";
import { enrichMacroPreviousFromFRED } from "./macro-actuals-fred.js";

describe("enrichMacroPreviousFromFRED", () => {
  it("sets pre-release previous from the latest published FRED headline", async () => {
    const env = {
      KV: {
        get: async () => JSON.stringify({
          byKey: {
            jolts: {
              key: "jolts",
              display: "7.4M",
              obs_date: "2026-04-01",
              previous_display: "7.1M",
            },
          },
        }),
      },
    };
    const events = [{
      date: "2026-06-30",
      time_et: "10:00 AM",
      name: "May JOLTS Job Openings",
    }];
    const now = new Date("2026-06-30T13:00:00.000Z"); // 9:00 AM ET, before release
    await enrichMacroPreviousFromFRED(env, events, now);
    expect(events[0].previous).toBe("7.4M");
  });

  it("uses previous_display after release when actual is present", async () => {
    const env = {
      KV: {
        get: async () => JSON.stringify({
          byKey: {
            jolts: {
              key: "jolts",
              display: "7.2M",
              obs_date: "2026-05-01",
              previous_display: "7.4M",
            },
          },
        }),
      },
    };
    const events = [{
      date: "2026-06-30",
      time_et: "10:00 AM",
      name: "May JOLTS Job Openings",
      actual: "7.2M",
    }];
    const now = new Date("2026-06-30T14:30:00.000Z"); // 10:30 AM ET
    await enrichMacroPreviousFromFRED(env, events, now);
    expect(events[0].previous).toBe("7.4M");
  });
});
