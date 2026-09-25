import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

describe("bookTotalPnlPct", () => {
  let bookTotalPnlPct;

  beforeAll(() => {
    require("../react-app/portfolio-book-utils.js");
    bookTotalPnlPct = globalThis.TimedPortfolioBookUtils.bookTotalPnlPct;
  });

  it("uses realized + open over startCash when both known", () => {
    const pct = bookTotalPnlPct(
      { summary: { startCash: 100000, cumRealized: 5000, totalReturnPct: 1 } },
      2500,
      100000,
    );
    expect(pct).toBeCloseTo(7.5, 5);
  });

  it("falls back to equity-curve totalReturnPct when open is unknown", () => {
    expect(bookTotalPnlPct(
      { summary: { startCash: 100000, cumRealized: 5000, totalReturnPct: 4.2 } },
      null,
    )).toBe(4.2);
  });

  it("uses Day Trader sleeve default when startCash missing", () => {
    const pct = bookTotalPnlPct(
      { summary: { cumRealized: 1000 } },
      500,
      25000,
    );
    expect(pct).toBeCloseTo(6, 5);
  });

  it("returns null when nothing usable", () => {
    expect(bookTotalPnlPct(null, null)).toBeNull();
    expect(bookTotalPnlPct({ summary: {} }, undefined)).toBeNull();
  });
});
