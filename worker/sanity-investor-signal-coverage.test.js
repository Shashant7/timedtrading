// worker/sanity-investor-signal-coverage.test.js
//
// 2026-07-27 — Runtime coverage check that flags investor SELL lots
// which never made it to the broker bridge (the KO PRE_EARNINGS_RISK_
// REDUCTION scenario on 2026-07-27). Compile-time defence lives in
// investor-reducer-mirror-coverage.test.js — that scans the source for
// missing _bridgeMirrorInvestor calls after every investor_lots SELL.
// This runtime check catches the same class of gap when a code path
// exists but isn't exercised by tests until earnings week.

import { describe, it, expect } from "vitest";
import { evaluateInvestorSignalCoverage } from "./sanity-sweep.js";

const nowMs = Date.parse("2026-07-27T14:00:00Z");

function sell({ ticker, minutesAgo, reason = "PRE_EARNINGS_RISK_REDUCTION", position_id = null }) {
  return {
    ticker, position_id, reason,
    ts: nowMs - minutesAgo * 60000,
  };
}
function ringEntry({ ticker, minutesAgo, side = "trim", status = "ok", trade_id = null, error = null, reject_reason = null }) {
  return {
    ticker, side, status, trade_id, error, reject_reason,
    ts: nowMs - minutesAgo * 60000,
  };
}

describe("evaluateInvestorSignalCoverage — the KO event-risk scenario", () => {
  it("FAILS when a recent investor SELL has NO matching bridge ring entry", () => {
    const sells = [sell({ ticker: "KO", minutesAgo: 20, position_id: "inv-KO-auto-1" })];
    const ring = [ringEntry({ ticker: "TT", minutesAgo: 5, side: "trim" })]; // unrelated
    const an = evaluateInvestorSignalCoverage({ sells, ring, nowMs });
    expect(an).toHaveLength(1);
    expect(an[0].severity).toBe("fail");
    expect(an[0].detail).toMatch(/NO matching bridge ring entry/);
    expect(an[0].detail).toMatch(/KO/);
    expect(an[0].missing[0].ticker).toBe("KO");
  });

  it("is OK when the SELL has a successful bridge ring entry within the match window", () => {
    const sells = [sell({ ticker: "KO", minutesAgo: 20 })];
    const ring = [ringEntry({ ticker: "KO", minutesAgo: 20, side: "trim", status: "ok", trade_id: "inv-KO-auto-1" })];
    expect(evaluateInvestorSignalCoverage({ sells, ring, nowMs })).toEqual([]);
  });

  it("WARNS when the ring only has failed entries for the SELL (no success)", () => {
    const sells = [sell({ ticker: "KO", minutesAgo: 20 })];
    const ring = [
      ringEntry({ ticker: "KO", minutesAgo: 20, side: "trim", status: "error", reject_reason: "no_manifest_for_trade" }),
      ringEntry({ ticker: "KO", minutesAgo: 15, side: "trim", status: "error", reject_reason: "no_manifest_for_trade" }),
    ];
    const an = evaluateInvestorSignalCoverage({ sells, ring, nowMs });
    expect(an).toHaveLength(1);
    expect(an[0].severity).toBe("warn");
    expect(an[0].detail).toMatch(/no successful mirror/);
    expect(an[0].failed[0].ticker).toBe("KO");
  });

  it("matches sells against exit/close/reduce ring sides (not just trim)", () => {
    const sells = [sell({ ticker: "KO", minutesAgo: 20 })];
    for (const side of ["sell", "exit", "close", "reduce"]) {
      const ring = [ringEntry({ ticker: "KO", minutesAgo: 20, side, status: "ok" })];
      expect(evaluateInvestorSignalCoverage({ sells, ring, nowMs }), `side=${side}`).toEqual([]);
    }
  });

  it("ignores buy-side ring entries when matching a SELL lot", () => {
    const sells = [sell({ ticker: "KO", minutesAgo: 20 })];
    const ring = [ringEntry({ ticker: "KO", minutesAgo: 20, side: "buy", status: "ok" })];
    const an = evaluateInvestorSignalCoverage({ sells, ring, nowMs });
    expect(an).toHaveLength(1);
    expect(an[0].severity).toBe("fail"); // no reducer ring entry → gap
  });

  it("only checks SELL lots inside the window (default 6h)", () => {
    // 12h ago falls outside the default 6h window → not evaluated.
    const sells = [sell({ ticker: "KO", minutesAgo: 12 * 60 })];
    const ring = [];
    expect(evaluateInvestorSignalCoverage({ sells, ring, nowMs })).toEqual([]);
  });

  it("only matches ring entries within the +/- match window (default 15m)", () => {
    const sells = [sell({ ticker: "KO", minutesAgo: 20 })];
    // 45m older ring entry doesn't count as a match.
    const ring = [ringEntry({ ticker: "KO", minutesAgo: 65, side: "trim", status: "ok" })];
    const an = evaluateInvestorSignalCoverage({ sells, ring, nowMs });
    expect(an).toHaveLength(1);
    expect(an[0].severity).toBe("fail");
  });

  it("summarizes multiple missing tickers in a single alert", () => {
    const sells = [
      sell({ ticker: "KO", minutesAgo: 20, reason: "PRE_EARNINGS_RISK_REDUCTION" }),
      sell({ ticker: "ETN", minutesAgo: 25 }),
      sell({ ticker: "AMAT", minutesAgo: 30 }),
    ];
    const an = evaluateInvestorSignalCoverage({ sells, ring: [], nowMs });
    expect(an).toHaveLength(1);
    expect(an[0].missing).toHaveLength(3);
    // Detail mentions the count + samples the tickers.
    expect(an[0].detail).toMatch(/3 model-side investor SELLs/);
    expect(an[0].detail).toMatch(/KO/);
  });

  it("is quiet when no recent SELLs have fired (no false positives)", () => {
    expect(evaluateInvestorSignalCoverage({ sells: [], ring: [], nowMs })).toEqual([]);
  });

  it("handles a mix of covered and missing lots correctly", () => {
    const sells = [
      sell({ ticker: "KO", minutesAgo: 20 }),   // missing
      sell({ ticker: "ETN", minutesAgo: 25 }),  // covered
    ];
    const ring = [
      ringEntry({ ticker: "ETN", minutesAgo: 25, side: "trim", status: "ok" }),
    ];
    const an = evaluateInvestorSignalCoverage({ sells, ring, nowMs });
    expect(an).toHaveLength(1);
    expect(an[0].missing.map((m) => m.ticker)).toEqual(["KO"]);
  });
});
