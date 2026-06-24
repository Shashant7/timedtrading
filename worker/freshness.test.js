// worker/freshness.test.js
// Data Age Contract regression tests — the Freshness Doctrine.
//
// These tests pin the SLO table and grading semantics. If a threshold needs
// to change, change it deliberately in worker/freshness.js AND here, and
// update skills/freshness-doctrine.md.

import { describe, it, expect } from "vitest";
import {
  computeFreshnessBlock,
  buildFreshnessSummary,
  freshnessSloMs,
  isQuarantinedByFreshness,
  isFreshnessExemptTicker,
  classifySessionRollRescore,
  evaluateOpenPositionCandleMap,
  buildTfNewestTsFromCandleCache,
  computeMarketSessionReference,
  effectiveCandleAgeMs,
  GRADE_FRESH,
  GRADE_AGING,
  GRADE_STALE,
} from "./freshness.js";
import { sessionBoundsUtc, tradingDateUtcMs } from "./foundation/trading-calendar.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// A Wednesday 14:30 UTC = 10:30 AM ET (RTH, no DST ambiguity in June).
const RTH_NOW = Date.UTC(2026, 5, 10, 14, 30, 0);
// A Wednesday 02:00 UTC = Tue 10 PM ET (closed).
const OOH_NOW = Date.UTC(2026, 5, 10, 2, 0, 0);
// Saturday 15:00 UTC (weekend).
const WEEKEND_NOW = Date.UTC(2026, 5, 13, 15, 0, 0);

function freshTfMap(nowMs) {
  return {
    M: nowMs - 5 * 24 * HOUR,
    W: nowMs - 2 * 24 * HOUR,
    D: nowMs - 4 * HOUR,
    240: nowMs - 2 * HOUR,
    60: nowMs - 30 * MIN,
    30: nowMs - 10 * MIN,
    15: nowMs - 10 * MIN,
    10: nowMs - 5 * MIN,
  };
}

describe("freshnessSloMs", () => {
  it("is tight during RTH and relaxed out of session", () => {
    expect(freshnessSloMs("10", true, RTH_NOW)).toBe(30 * MIN);
    expect(freshnessSloMs("60", true, RTH_NOW)).toBe(2 * HOUR);
    expect(freshnessSloMs("10", false, OOH_NOW)).toBe(96 * HOUR);
    expect(freshnessSloMs("60", false, OOH_NOW)).toBe(96 * HOUR);
  });

  it("D threshold is weekday 48h / weekend 96h (matches open-position guard)", () => {
    expect(freshnessSloMs("D", true, RTH_NOW)).toBe(48 * HOUR);
    expect(freshnessSloMs("D", false, WEEKEND_NOW)).toBe(96 * HOUR);
  });

  it("returns null for unknown TFs", () => {
    expect(freshnessSloMs("3", true, RTH_NOW)).toBeNull();
  });
});

describe("computeFreshnessBlock — grading", () => {
  it("grades FRESH when all TFs are within SLO", () => {
    const block = computeFreshnessBlock(freshTfMap(RTH_NOW), {
      nowMs: RTH_NOW,
      marketOpen: true,
    });
    expect(block.grade).toBe(GRADE_FRESH);
    expect(block.enforced).toBe(true);
    expect(block.stale_tfs).toEqual([]);
    expect(block.missing_tfs).toEqual([]);
  });

  it("grades AGING on a soft breach of a critical TF", () => {
    const map = freshTfMap(RTH_NOW);
    map["60"] = RTH_NOW - 3 * HOUR; // SLO 2h, hard 4h → aging
    const block = computeFreshnessBlock(map, { nowMs: RTH_NOW, marketOpen: true });
    expect(block.grade).toBe(GRADE_AGING);
    expect(block.aging_tfs).toContain("60");
  });

  it("grades STALE on a hard breach of a critical TF", () => {
    const map = freshTfMap(RTH_NOW);
    map.D = tradingDateUtcMs("2026-05-20"); // several sessions behind June 10 RTH
    const block = computeFreshnessBlock(map, { nowMs: RTH_NOW, marketOpen: true });
    expect(block.grade).toBe(GRADE_STALE);
    expect(block.stale_tfs).toContain("D");
  });

  it("grades STALE when D or 60 are missing entirely", () => {
    const map = freshTfMap(RTH_NOW);
    map["60"] = 0;
    const block = computeFreshnessBlock(map, { nowMs: RTH_NOW, marketOpen: true });
    expect(block.grade).toBe(GRADE_STALE);
    expect(block.missing_tfs).toContain("60");
  });

  it("missing non-backbone TFs (10m) degrade to AGING, not STALE", () => {
    const map = freshTfMap(RTH_NOW);
    map["10"] = 0;
    const block = computeFreshnessBlock(map, { nowMs: RTH_NOW, marketOpen: true });
    expect(block.grade).toBe(GRADE_AGING);
  });

  it("intraday TFs do NOT quarantine over a normal weekend gap", () => {
    // Friday 4 PM ET close → Saturday 11 AM ET = ~19h gap on every intraday TF.
    const friClose = Date.UTC(2026, 5, 12, 20, 0, 0);
    const map = {
      D: friClose - 7 * HOUR,
      60: friClose,
      30: friClose,
      10: friClose,
      W: friClose - 3 * 24 * HOUR,
      M: friClose - 9 * 24 * HOUR,
      240: friClose,
      15: friClose,
    };
    const block = computeFreshnessBlock(map, { nowMs: WEEKEND_NOW, marketOpen: false });
    expect(block.grade).toBe(GRADE_FRESH);
  });

  it("Juneteenth long weekend — Thursday session close stays FRESH on Saturday", () => {
    // 2026-06-18 Thu last session → 2026-06-19 Fri Juneteenth (closed) → Sat 2026-06-20
    const thuBounds = sessionBoundsUtc("2026-06-18");
    expect(thuBounds).not.toBeNull();
    const thuClose = thuBounds.closeMs;
    const satNow = Date.UTC(2026, 5, 20, 15, 0, 0);
    const sessionRef = computeMarketSessionReference(satNow);
    expect(sessionRef.last_trading_day).toBe("2026-06-18");
    expect(sessionRef.next_trading_day).toBe("2026-06-22");

    const map = {
      D: tradingDateUtcMs("2026-06-18"),
      60: thuClose - 30 * MIN,
      30: thuClose - 30 * MIN,
      10: 0,
      15: 0,
      W: tradingDateUtcMs("2026-06-12"),
      M: tradingDateUtcMs("2026-05-01"),
      240: thuClose - 2 * HOUR,
    };
    const block = computeFreshnessBlock(map, {
      nowMs: satNow,
      marketOpen: false,
      sessionRef,
    });
    expect(block.grade).toBe(GRADE_FRESH);
    expect(block.missing_tfs).not.toContain("10");
    expect(isQuarantinedByFreshness({ ticker: "LSCC", _freshness: block })).toBe(false);
    expect(effectiveCandleAgeMs("D", map.D, satNow, false, sessionRef)).toBe(0);
  });

  it("monthly bar in current ET month reads as age 0 mid-month", () => {
    const june1 = tradingDateUtcMs("2026-06-01");
    const june23 = Date.UTC(2026, 5, 23, 15, 0, 0);
    expect(effectiveCandleAgeMs("M", june1, june23, false, null)).toBe(0);
  });

  it("monthly bar from prior month measures lag from current month start", () => {
    const may1 = tradingDateUtcMs("2026-05-01");
    const june23 = Date.UTC(2026, 5, 23, 15, 0, 0);
    const june1 = tradingDateUtcMs("2026-06-01");
    const age = effectiveCandleAgeMs("M", may1, june23, false, null);
    expect(age).toBe(june23 - june1);
  });

  it("worst offender is SLO-relative, not absolute age", () => {
    const map = freshTfMap(RTH_NOW);
    map["10"] = RTH_NOW - 50 * MIN; // 50min vs 30min SLO → rel 1.67
    map.D = RTH_NOW - 50 * HOUR;    // 50h vs 48h SLO → rel 1.04
    const block = computeFreshnessBlock(map, { nowMs: RTH_NOW, marketOpen: true });
    expect(block.worst.tf).toBe("10");
  });
});

describe("computeFreshnessBlock — replay mode", () => {
  it("stamps a diagnostic block that is never enforced", () => {
    const asOf = Date.UTC(2025, 8, 18, 15, 0, 0);
    const map = freshTfMap(asOf);
    map.D = asOf - 200 * HOUR; // would be STALE live (calendar-unaware replay)
    const block = computeFreshnessBlock(map, { nowMs: asOf, mode: "replay", marketOpen: true });
    expect(block.mode).toBe("replay");
    expect(block.enforced).toBe(false);
    expect(block.grade).toBe(GRADE_STALE); // diagnosed...
    expect(isQuarantinedByFreshness({ _freshness: block })).toBe(false); // ...but not quarantined
  });
});

describe("isQuarantinedByFreshness", () => {
  it("quarantines only live STALE", () => {
    const stale = computeFreshnessBlock(
      { ...freshTfMap(RTH_NOW), D: tradingDateUtcMs("2026-05-20") },
      { nowMs: RTH_NOW, marketOpen: true },
    );
    const fresh = computeFreshnessBlock(freshTfMap(RTH_NOW), { nowMs: RTH_NOW, marketOpen: true });
    expect(isQuarantinedByFreshness({ _freshness: stale })).toBe(true);
    expect(isQuarantinedByFreshness({ _freshness: fresh })).toBe(false);
    expect(isQuarantinedByFreshness({})).toBe(false);
    expect(isQuarantinedByFreshness(null)).toBe(false);
  });

  it("does not quarantine stream-blocklisted / continuous-future symbols", () => {
    const stale = computeFreshnessBlock(
      { "10": RTH_NOW - 10 * HOUR },
      { nowMs: RTH_NOW, marketOpen: true },
    );
    expect(isFreshnessExemptTicker("BTCUSD")).toBe(true);
    expect(isFreshnessExemptTicker("ES1!")).toBe(true);
    expect(isFreshnessExemptTicker("AAPL")).toBe(false);
    expect(isQuarantinedByFreshness({ ticker: "BTCUSD", _freshness: stale })).toBe(false);
    expect(isQuarantinedByFreshness({ ticker: "AAPL", _freshness: stale })).toBe(true);
  });
});

describe("buildFreshnessSummary", () => {
  it("aggregates counts, percentiles, and worst offender", () => {
    const freshBlock = computeFreshnessBlock(freshTfMap(RTH_NOW), {
      nowMs: RTH_NOW,
      marketOpen: true,
    });
    const staleBlock = computeFreshnessBlock(
      { ...freshTfMap(RTH_NOW), D: tradingDateUtcMs("2026-05-20") },
      { nowMs: RTH_NOW, marketOpen: true },
    );
    const summary = buildFreshnessSummary(
      [
        { ticker: "AAPL", block: freshBlock },
        { ticker: "MSFT", block: freshBlock },
        { ticker: "DELL", block: staleBlock },
      ],
      { nowMs: RTH_NOW },
    );
    expect(summary.total).toBe(3);
    expect(summary.fresh).toBe(2);
    expect(summary.stale).toBe(1);
    expect(summary.slo_ok).toBe(false);
    expect(summary.stale_tickers[0].ticker).toBe("DELL");
    expect(summary.worst.ticker).toBe("DELL");
    expect(summary.per_tf_ages.D.n).toBe(3);
  });

  it("reports slo_ok when nothing is stale", () => {
    const freshBlock = computeFreshnessBlock(freshTfMap(RTH_NOW), {
      nowMs: RTH_NOW,
      marketOpen: true,
    });
    const summary = buildFreshnessSummary([{ ticker: "AAPL", block: freshBlock }]);
    expect(summary.slo_ok).toBe(true);
  });
});

describe("classifySessionRollRescore", () => {
  it("flags v1 freshness and stale-while-closed payloads", () => {
    const satNow = Date.UTC(2026, 5, 20, 15, 0, 0);
    const sessionRef = computeMarketSessionReference(satNow);
    expect(classifySessionRollRescore(null, sessionRef)).toBe("missing");
    expect(classifySessionRollRescore({}, sessionRef)).toBe("freshness_contract_stale");
    expect(classifySessionRollRescore({ _freshness: { v: 1, grade: GRADE_STALE } }, sessionRef))
      .toBe("freshness_contract_stale");
    expect(classifySessionRollRescore({
      _freshness: {
        v: 2,
        grade: GRADE_STALE,
        checked_at: Date.UTC(2026, 5, 18, 14, 0, 0),
      },
    }, sessionRef)).toBe("stale_while_market_closed");
    expect(classifySessionRollRescore({
      _freshness: { v: 2, grade: GRADE_FRESH, checked_at: satNow },
    }, sessionRef)).toBeNull();
    const thuMid = Date.UTC(2026, 5, 18, 14, 0, 0);
    expect(classifySessionRollRescore({
      _freshness: { v: 2, grade: GRADE_FRESH, checked_at: thuMid },
    }, sessionRef)).toBe("freshness_predates_last_session");
  });
});

describe("evaluateOpenPositionCandleMap", () => {
  it("treats last-session bars as fresh over Juneteenth weekend", () => {
    const thuBounds = sessionBoundsUtc("2026-06-18");
    const satNow = Date.UTC(2026, 5, 20, 15, 0, 0);
    const sessionRef = computeMarketSessionReference(satNow);
    const evalResult = evaluateOpenPositionCandleMap({
      D: tradingDateUtcMs("2026-06-18"),
      60: thuBounds.closeMs - 30 * 60 * 1000,
      240: thuBounds.closeMs - 2 * 60 * 60 * 1000,
    }, { nowMs: satNow, sessionRef, marketOpen: false });
    expect(evalResult.stale).toBe(false);
  });
});

describe("buildTfNewestTsFromCandleCache", () => {
  it("extracts newest ts per tf from cache rows", () => {
    const ts = buildTfNewestTsFromCandleCache({
      D: { candles: [{ ts: 100 }, { ts: 250 }] },
      60: { candles: [{ ts: 200 }] },
    });
    expect(ts.D).toBe(250);
    expect(ts["60"]).toBe(200);
    expect(ts["10"]).toBe(0);
  });
});
