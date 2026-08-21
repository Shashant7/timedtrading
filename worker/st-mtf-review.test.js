import { describe, expect, it } from "vitest";
import {
  aggregateStMtfReview,
  classifyStAtEntry,
  classifyTradeAcrossTfs,
  pickStTreatment,
  recommendStTreatment,
  stClassFromState,
} from "./st-mtf-review.js";
import { superTrendSeries } from "./indicators.js";

function risingBars(n, start = 100) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const c = start + i * 0.4;
    bars.push({
      ts: 1_700_000_000_000 + i * 3_600_000,
      o: c - 0.1,
      h: c + 0.3,
      l: c - 0.3,
      c,
      v: 1000,
    });
  }
  return bars;
}

describe("classifyStAtEntry", () => {
  it("returns insufficient on a short series", () => {
    expect(classifyStAtEntry({ bars: risingBars(8), tradeSide: "LONG" }).class).toBe("insufficient");
  });

  it("labels a rising series as sloping_agree or a hold kind for a long", () => {
    const bars = risingBars(40);
    const hit = classifyStAtEntry({ bars, tradeSide: "LONG" });
    expect(["sloping_agree", "st_hold", "st_flip_retest", "st_pierce_held", "agree_no_setup"]).toContain(hit.class);
    expect(hit.agree).toBe(true);
  });

  it("labels the same rising series against a short", () => {
    const bars = risingBars(40);
    const hit = classifyStAtEntry({ bars, tradeSide: "SHORT" });
    expect(hit.class).toBe("against");
    expect(hit.agree).toBe(false);
  });

  it("splits sloping-against from a flat opposite-side magnet", () => {
    expect(stClassFromState({
      agree: false, sloping: true, slopeAgrees: false, hold: null, magnet: null,
    })).toBe("against");
    expect(stClassFromState({
      agree: false, sloping: false, hold: null,
      magnet: { magnet: true, sideLabel: "LONG" },
    })).toBe("st_magnet");
    expect(stClassFromState({
      agree: false, sloping: false, hold: null, magnet: null,
    })).toBe("flat_against");
  });

  it("computes a Pine SuperTrend dir on the fixture", () => {
    const st = superTrendSeries(risingBars(40), 3.0, 10);
    expect(st.dir[st.dir.length - 1]).toBe(-1);
  });
});

describe("classifyTradeAcrossTfs + aggregate", () => {
  it("marks HTF held vs LTF chase features", () => {
    const bars = risingBars(40);
    const row = classifyTradeAcrossTfs(
      {
        trade_id: "t1",
        ticker: "TEST",
        direction: "LONG",
        status: "WIN",
        pnl_pct: 2.1,
        setup_name: "TT Tt Pullback",
        entry_ts: bars[bars.length - 1].ts,
        exit_ts: bars[bars.length - 1].ts + 3_600_000,
        book: "st",
      },
      { D: bars, W: bars, "30": bars },
    );
    expect(row.per_tf.D.class).not.toBe("insufficient");
    expect(row.win).toBe(true);

    const agg = aggregateStMtfReview([
      row,
      {
        ...row,
        trade_id: "t2",
        win: false,
        status: "LOSS",
        pnl_pct: -1.2,
        htf_held: false,
        ltf_chase: true,
        htf_against: true,
        later_htf_hold: false,
        per_tf: {
          ...row.per_tf,
          D: { ...row.per_tf.D, class: "against" },
          10: { class: "st_flip_extended", held: false, agree: true },
          30: { class: "st_flip_extended", held: false, agree: true },
        },
      },
    ]);
    expect(agg.n).toBe(2);
    expect(agg.baseline.wins).toBe(1);
  });
});

describe("recommendStTreatment / pickStTreatment", () => {
  it("promotes HTF hold and haircuts LTF chase when the lift is there", () => {
    const holdRows = Array.from({ length: 40 }, (_, i) => ({
      win: i < 28,
      pnl_pct: i < 28 ? 1 : -1,
      htf_held: true,
      ltf_chase: false,
      htf_against: false,
      later_htf_hold: false,
      per_tf: { D: { class: "st_hold" }, "6.5H": { class: "st_hold" } },
    }));
    const chaseRows = Array.from({ length: 40 }, (_, i) => ({
      win: i < 12,
      pnl_pct: i < 12 ? 1 : -1,
      htf_held: false,
      ltf_chase: true,
      htf_against: true,
      later_htf_hold: true,
      per_tf: { D: { class: "against" }, 10: { class: "st_flip_extended" } },
    }));
    const agg = aggregateStMtfReview([...holdRows, ...chaseRows]);
    const recs = recommendStTreatment(agg, { minN: 25, lift: 0.04 });
    const ids = recs.map((r) => r.id);
    expect(ids).toContain("prefer_htf_hold");
    expect(ids).toContain("haircut_ltf_chase");
    expect(ids).toContain("include_wm_trigger");
    expect(ids).toContain("promote_6.5H");
    expect(ids).toContain("block_htf_against");
  });

  it("prefers an HTF hold over slope or chase", () => {
    expect(pickStTreatment({ D: { class: "st_flip_retest" }, 10: { class: "st_flip_extended" } }).treatment).toBe("hold");
    expect(pickStTreatment({ D: { class: "st_flip_extended" }, 240: { class: "sloping_agree" } }).treatment).toBe("chase");
    expect(pickStTreatment({ D: { class: "sloping_agree" } }).treatment).toBe("slope");
    expect(pickStTreatment({ D: { class: "st_magnet" }, 240: { class: "sloping_agree" } }).treatment).toBe("slope");
    expect(pickStTreatment({ D: { class: "st_magnet" } }).treatment).toBe("magnet");
  });
});
