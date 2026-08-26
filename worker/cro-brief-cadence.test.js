import { describe, it, expect } from "vitest";
import { shouldRefreshCroForBriefCadence, getCROEtDate } from "./cro/cro-service.js";

describe("shouldRefreshCroForBriefCadence intraday", () => {
  const etToday = getCROEtDate();
  const note = { as_of_date: etToday, produced_at: Date.now() - 30 * 60 * 1000 };

  it("does not refresh intraday when note is fresh even if new FSD landed", () => {
    expect(shouldRefreshCroForBriefCadence("intraday", note, {
      etToday,
      hasNewFsd: true,
      nowMs: Date.now(),
    })).toBe(false);
  });

  it("refreshes intraday when note is stale (>2h)", () => {
    const stale = { as_of_date: etToday, produced_at: Date.now() - 3 * 3600000 };
    expect(shouldRefreshCroForBriefCadence("intraday", stale, {
      etToday,
      hasNewFsd: false,
      nowMs: Date.now(),
    })).toBe(true);
  });
});
