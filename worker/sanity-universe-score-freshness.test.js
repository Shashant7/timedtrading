// worker/sanity-universe-score-freshness.test.js
//
// 2026-09-22 — /timed/all returned 330 tickers whose prices were seconds old
// and whose scores were days old: 267 last scored 2026-09-19, 48 last scored
// 2026-09-12, 14 futures and freshly-onboarded symbols current. Rank, stage,
// SL and TP on NVDA were all four days stale under a live quote.
//
// Every existing check passed. cron_tick_alive in particular reported ok,
// because the heartbeat is stamped at the top of the tick and survives a tick
// that dies later. The counts below are the production ones.

import { describe, it, expect } from "vitest";
import {
  classifyUniverseScoreStaleness,
  SCORE_OPEN_GRACE_MS,
} from "./sanity-sweep.js";

const NOW = Date.parse("2026-09-22T20:30:00Z"); // after the cash close
const SESSION_OPEN = Date.parse("2026-09-22T13:30:00Z");

const closedSession = {
  market_open: false,
  last_trading_day: "2026-09-22",
  last_rth_open_ms: SESSION_OPEN,
};
const openSession = { ...closedSession, market_open: true };

describe("universe scoring freshness", () => {
  it("fails on the 2026-09-22 universe", () => {
    // Verbatim from production D1, the same aggregate the check runs:
    //   SELECT COUNT(*), SUM(ts >= 1790083800000), MAX(ts) FROM ticker_latest
    //   -> 332 | 8 | 1790122827881
    // Eight of 332 scored during the session, and those eight were futures
    // and newly-onboarded symbols, not the trading universe.
    const out = classifyUniverseScoreStaleness({
      total: 332,
      freshCount: 8,
      newestTs: 1790122827881,
      sessionRef: closedSession,
      now: NOW,
    });
    expect(out?.severity).toBe("fail");
    expect(out.detail).toContain("324/332");
    expect(out.detail).toContain("2026-09-22 open");
  });

  it("reports how old the newest score is", () => {
    const out = classifyUniverseScoreStaleness({
      total: 330,
      freshCount: 14,
      newestTs: Date.parse("2026-09-19T19:02:12Z"), // NVDA's stale rank
      sessionRef: closedSession,
      now: NOW,
    });
    expect(out.detail).toContain("316/330");
    expect(out.detail).toContain("73h old");
  });

  it("stays quiet when the pass is landing", () => {
    expect(classifyUniverseScoreStaleness({
      total: 330, freshCount: 330, newestTs: NOW - 4 * 60000,
      sessionRef: closedSession, now: NOW,
    })).toBeNull();
    // A handful of exempt symbols lagging is not an outage.
    expect(classifyUniverseScoreStaleness({
      total: 330, freshCount: 300, newestTs: NOW - 4 * 60000,
      sessionRef: closedSession, now: NOW,
    })).toBeNull();
  });

  it("warns before it fails", () => {
    const warn = classifyUniverseScoreStaleness({
      total: 330, freshCount: 230, newestTs: NOW - 90 * 60000,
      sessionRef: closedSession, now: NOW,
    });
    expect(warn?.severity).toBe("warn");
  });

  it("gives the pass room to finish after the bell", () => {
    const justOpened = SESSION_OPEN + 5 * 60000;
    expect(classifyUniverseScoreStaleness({
      total: 330, freshCount: 0, newestTs: SESSION_OPEN - 86400000,
      sessionRef: openSession, now: justOpened,
    })).toBeNull();
    // Once the grace window is spent it reports.
    const later = SESSION_OPEN + SCORE_OPEN_GRACE_MS + 60000;
    expect(classifyUniverseScoreStaleness({
      total: 330, freshCount: 0, newestTs: SESSION_OPEN - 86400000,
      sessionRef: openSession, now: later,
    })?.severity).toBe("fail");
  });

  it("does not fire on a weekend or holiday just because time passed", () => {
    // Saturday: the reference session is Friday's, and Friday's pass landed.
    const saturday = Date.parse("2026-09-26T18:00:00Z");
    const fridayRef = {
      market_open: false,
      last_trading_day: "2026-09-25",
      last_rth_open_ms: Date.parse("2026-09-25T13:30:00Z"),
    };
    expect(classifyUniverseScoreStaleness({
      total: 330, freshCount: 330,
      newestTs: Date.parse("2026-09-25T19:55:00Z"),
      sessionRef: fridayRef, now: saturday,
    })).toBeNull();
  });

  it("calls an empty ticker_latest an outage", () => {
    expect(classifyUniverseScoreStaleness({
      total: 0, freshCount: 0, newestTs: null,
      sessionRef: closedSession, now: NOW,
    })?.severity).toBe("fail");
  });

  it("says nothing without a session reference", () => {
    expect(classifyUniverseScoreStaleness({
      total: 330, freshCount: 0, newestTs: null,
      sessionRef: { market_open: false, last_rth_open_ms: null }, now: NOW,
    })).toBeNull();
  });
});
