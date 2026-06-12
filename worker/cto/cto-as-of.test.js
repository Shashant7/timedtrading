import { describe, it, expect } from "vitest";
import { asOfDateToCloseMs, backfillItemBarAsOfMs, resolvePredictionAsOfMs } from "./cto-as-of.js";

describe("cto-as-of", () => {
  it("converts as_of_date to daily close anchor ms", () => {
    const ms = asOfDateToCloseMs("2026-06-11");
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThan(0);
  });

  it("backfills bar_as_of_ms from as_of_date when missing", () => {
    const item = { ticker: "ARM", as_of_date: "2026-06-11" };
    backfillItemBarAsOfMs(item);
    expect(Number(item.bar_as_of_ms)).toBeGreaterThan(0);
  });

  it("resolves prediction as-of from items with only as_of_date", () => {
    const ms = resolvePredictionAsOfMs([
      { ticker: "A", as_of_date: "2026-06-10" },
      { ticker: "B", as_of_date: "2026-06-11" },
    ]);
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBe(asOfDateToCloseMs("2026-06-11"));
  });

  it("prefers explicit prediction_as_of_ms on feed object", () => {
    const explicit = Date.UTC(2026, 5, 11, 21, 0, 0);
    const ms = resolvePredictionAsOfMs({
      prediction_as_of_ms: explicit,
      items: [{ as_of_date: "2026-01-01" }],
    });
    expect(ms).toBe(explicit);
  });
});
