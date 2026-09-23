// Grading a detector on what it controls, pinned to the live 60-day book.
//
// Every fixture below is verbatim from D1 (exits since 2026-07-25). The book
// baseline over that window is MFE:MAE 1.62 with 50% of entries reaching +2%.

import { describe, it, expect } from "vitest";
import {
  ENTRY_GRADE_MIN_N,
  aggregateMfeCapture,
  diagnoseLayer,
  gradeEntryQuality,
  readExcursions,
  summarizeEntryExcursions,
} from "./entry-quality.js";

/** n rows averaging the given excursions, so the aggregates land on them. */
function cohort(n, mfe, mae, pnlPct = 0) {
  return Array.from({ length: n }, () => ({
    max_favorable_excursion: mfe,
    max_adverse_excursion: -mae,
    pnl_pct: pnlPct,
    status: pnlPct > 0 ? "WIN" : "LOSS",
  }));
}

// Book-wide, 60d: n=106, avg MFE 3.61%, avg MAE 2.23%, ratio 1.62, hit+2% 50%.
const BOOK_BASELINE = summarizeEntryExcursions([
  ...cohort(53, 3.61, 2.23, 0.5),
  ...cohort(53, 3.61, 2.23, -0.5),
]);

describe("readExcursions", () => {
  it("takes the magnitude of MAE whether it is stored signed or not", () => {
    expect(readExcursions({ max_favorable_excursion: 4, max_adverse_excursion: -2 }))
      .toEqual({ mfe: 4, mae: 2 });
    expect(readExcursions({ max_favorable_excursion: 4, max_adverse_excursion: 2 }))
      .toEqual({ mfe: 4, mae: 2 });
  });

  it("accepts the short field spellings the replay rows use", () => {
    expect(readExcursions({ mfe_pct: 3, mae_pct: -1 })).toEqual({ mfe: 3, mae: 1 });
    expect(readExcursions({ maxFavorableExcursion: 3, maxAdverseExcursion: -1 }))
      .toEqual({ mfe: 3, mae: 1 });
  });

  it("returns null without a readable favourable excursion, and tolerates a missing MAE", () => {
    expect(readExcursions({ max_adverse_excursion: -2 })).toBeNull();
    expect(readExcursions({})).toBeNull();
    expect(readExcursions({ max_favorable_excursion: 4 })).toEqual({ mfe: 4, mae: null });
  });
});

describe("summarizeEntryExcursions", () => {
  it("reproduces the book-wide 60d baseline", () => {
    expect(BOOK_BASELINE.n).toBe(106);
    expect(BOOK_BASELINE.avg_mfe_pct).toBe(3.61);
    expect(BOOK_BASELINE.avg_mae_pct).toBe(2.23);
    expect(BOOK_BASELINE.mfe_mae_ratio).toBe(1.62);
  });

  it("counts hit rates at each tradeable-move threshold", () => {
    const rows = [...cohort(3, 6, 2), ...cohort(3, 3, 2), ...cohort(4, 1, 2)];
    const s = summarizeEntryExcursions(rows);
    expect(s.hit_rate_2pct).toBe(60);
    expect(s.hit_rate_5pct).toBe(30);
  });

  it("returns null when no row carries an excursion", () => {
    expect(summarizeEntryExcursions([{ pnl_pct: 1 }])).toBeNull();
    expect(summarizeEntryExcursions([])).toBeNull();
  });
});

describe("gradeEntryQuality: the verdict is always relative to the same book", () => {
  it("confirms Cloud Pivot SHORT — twice the book's opportunity-to-heat", () => {
    // Live: n=25, MFE 5.19%, MAE 1.55%, ratio 3.34, hit+2% 64%.
    const g = gradeEntryQuality(cohort(25, 5.19, 1.55, 1.57), BOOK_BASELINE);
    expect(g.mfe_mae_ratio).toBe(3.35);
    expect(g.entry_edge).toBe("confirmed");
    expect(g.vs_baseline.mfe_mae_ratio_x).toBeGreaterThan(2);
  });

  it("confirms Support Bounce even though the trades lost money", () => {
    // Live: n=24, MFE 3.93%, MAE 2.17%, ratio 1.81, hit+2% 54.2%, and it
    // realized +0.20% — a 5% capture. The ENTRY is better than the book.
    const g = gradeEntryQuality(cohort(24, 3.93, 2.17, 0.2), BOOK_BASELINE);
    expect(g.entry_edge).toBe("confirmed");
    expect(g.vs_baseline.hit_rate_2pct_delta).toBeGreaterThanOrEqual(0);
  });

  it("calls ATH Breakout absent — it walks into more heat than opportunity", () => {
    // Live: n=20, MFE 1.78%, MAE 2.29%, ratio 0.78, hit+2% 35%.
    const g = gradeEntryQuality(cohort(20, 1.78, 2.29, -0.68), BOOK_BASELINE);
    expect(g.mfe_mae_ratio).toBeLessThan(1);
    expect(g.entry_edge).toBe("absent");
  });

  it("calls Cloud Pivot LONG neutral — marginal entries, not blind ones", () => {
    // Live: n=27, MFE 3.76%, MAE 2.54%, ratio 1.48, hit+2% 48.1%. Slightly
    // under the book on both axes, nowhere near the absent threshold.
    const g = gradeEntryQuality(cohort(27, 3.76, 2.54, -1.12), BOOK_BASELINE);
    expect(g.entry_edge).toBe("neutral");
  });

  it("refuses to grade a sample too small to mean anything", () => {
    const g = gradeEntryQuality(cohort(ENTRY_GRADE_MIN_N - 1, 9, 1), BOOK_BASELINE);
    expect(g.entry_edge).toBe("insufficient");
  });

  it("reports the numbers but withholds a verdict with no baseline", () => {
    const g = gradeEntryQuality(cohort(20, 5, 2));
    expect(g.mfe_mae_ratio).toBe(2.5);
    expect(g.entry_edge).toBe("ungraded");
    expect(g.vs_baseline).toBeNull();
  });

  it("does not let one soft axis condemn a detector", () => {
    // Well above the book on opportunity, a hair under on hit rate.
    const rows = [...cohort(15, 8, 2, 1), ...cohort(6, 1.5, 2, -1)];
    const g = gradeEntryQuality(rows, BOOK_BASELINE);
    expect(g.vs_baseline.mfe_mae_ratio_x).toBeGreaterThan(1);
    expect(g.entry_edge).not.toBe("absent");
  });
});

describe("aggregateMfeCapture: management's grade", () => {
  it("is total kept over total offered", () => {
    expect(aggregateMfeCapture([
      { max_favorable_excursion: 10, pnl_pct: 4 },
      { max_favorable_excursion: 10, pnl_pct: 2 },
    ])).toBe(0.3);
  });

  it("cannot be swung by a trade that never moved", () => {
    // ULTA: +0.104% peak, -5.13% close. As a per-trade ratio it is -49.21.
    const withUlta = aggregateMfeCapture([
      ...cohort(46, 5, 2, 2),
      { max_favorable_excursion: 0.104, pnl_pct: -5.13 },
    ]);
    const withoutUlta = aggregateMfeCapture(cohort(46, 5, 2, 2));
    expect(Math.abs(withUlta - withoutUlta)).toBeLessThan(0.03);
  });

  it("returns null when nothing moved favourably", () => {
    expect(aggregateMfeCapture([{ max_favorable_excursion: 0, pnl_pct: -1 }])).toBeNull();
  });
});

describe("diagnoseLayer: which layer owns the loss", () => {
  it("blames management when good entries are not converted", () => {
    // The Support Bounce case: entries beat the book, 5% of it is kept.
    const d = diagnoseLayer("confirmed", 0.051);
    expect(d.owner).toBe("management");
    expect(d.verdict).toBe("fix_management");
    expect(d.why).toMatch(/do NOT demote/);
  });

  it("blames management for a marginal entry too, not the detector", () => {
    // Cloud Pivot LONG: neutral entries, -29% capture. Still an exit problem.
    const d = diagnoseLayer("neutral", -0.287);
    expect(d.owner).toBe("management");
    expect(d.verdict).toBe("fix_management");
  });

  it("blames the entry only when the signal is not finding moves", () => {
    const d = diagnoseLayer("absent", -0.385);
    expect(d.owner).toBe("entry");
    expect(d.verdict).toBe("retire_or_rework_detector");
  });

  it("calls a confirmed, converting family a widen candidate", () => {
    const d = diagnoseLayer("confirmed", 0.396);
    expect(d.owner).toBe("none");
    expect(d.verdict).toBe("widen_candidate");
  });

  it("does not promote a merely-neutral detector that happens to convert", () => {
    const d = diagnoseLayer("neutral", 0.5);
    expect(d.verdict).toBe("keep_running");
  });

  it("routes nowhere while the evidence is thin", () => {
    expect(diagnoseLayer("insufficient", -0.9).owner).toBe("none");
    expect(diagnoseLayer(null, -0.9).verdict).toBe("keep_running");
  });

  it("does not read a missing capture number as a passing one", () => {
    const d = diagnoseLayer("confirmed", null);
    expect(d.verdict).toBe("fix_management");
  });
});
