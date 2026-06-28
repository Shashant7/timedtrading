// worker/signal-outcomes.test.js
// Pins the pure resolution core of the Signal Outcome Ledger.

import { describe, it, expect } from "vitest";
import {
  classifyDirectionalOutcome,
  classifyRelativeOutcome,
  fsdTacticalToSignals,
  isSignalDue,
  optionsPlayToSignal,
  resolveDueSignals,
  expireStaleSignals,
} from "./signal-outcomes.js";

const DAY = 86400000;
const T0 = Date.UTC(2026, 5, 1, 14, 0, 0);

function bar(daysAfter, h, l, c) {
  return { ts: T0 + daysAfter * DAY, h, l, c };
}

describe("classifyDirectionalOutcome — first touch wins", () => {
  const base = {
    direction: "LONG",
    entry_price: 100,
    target_price: 110,
    stop_price: 95,
    published_at: T0,
    due_ts: T0 + 30 * DAY,
  };

  it("target hit before stop → win / A", () => {
    const v = classifyDirectionalOutcome(base, [
      bar(1, 104, 99, 103),
      bar(2, 111, 102, 109), // target touched
      bar(3, 90, 85, 88),    // later crash ignored
    ]);
    expect(v.outcome).toBe("win");
    expect(v.grade).toBe("A");
    expect(v.resolve_note).toBe("target_hit");
    expect(v.outcome_pct).toBeCloseTo(10, 5);
  });

  it("stop hit before target → loss / F", () => {
    const v = classifyDirectionalOutcome(base, [
      bar(1, 102, 94, 96), // stop touched
      bar(2, 115, 100, 114),
    ]);
    expect(v.outcome).toBe("loss");
    expect(v.grade).toBe("F");
    expect(v.resolve_note).toBe("stop_hit");
    expect(v.outcome_pct).toBeCloseTo(-5, 5);
  });

  it("both touched same bar → conservative stop", () => {
    const v = classifyDirectionalOutcome(base, [bar(1, 112, 94, 100)]);
    expect(v.outcome).toBe("loss");
    expect(v.resolve_note).toBe("target_and_stop_same_bar_conservative_stop");
  });

  it("SHORT direction inverts touch logic and sign", () => {
    const v = classifyDirectionalOutcome(
      { ...base, direction: "SHORT", target_price: 92, stop_price: 105 },
      [bar(1, 99, 91, 93)], // target (92) touched by low
    );
    expect(v.outcome).toBe("win");
    expect(v.outcome_pct).toBeCloseTo(8, 5); // 100 → 92 short = +8%
  });

  it("bars after due_ts are ignored", () => {
    const v = classifyDirectionalOutcome(
      { ...base, due_ts: T0 + 2 * DAY },
      [bar(1, 102, 99, 101), bar(2, 103, 100, 102), bar(5, 120, 110, 119)],
    );
    expect(v.resolve_note).toBe("horizon_direction_right"); // +2% at due close
    expect(v.outcome).toBe("win");
    expect(v.grade).toBe("B");
  });
});

describe("classifyDirectionalOutcome — horizon verdicts", () => {
  it("flat inside ±1% → flat / C", () => {
    const v = classifyDirectionalOutcome(
      { direction: "LONG", entry_price: 100, published_at: T0, due_ts: T0 + 5 * DAY },
      [bar(1, 101, 99, 100.5), bar(4, 101, 99.4, 100.4)],
    );
    expect(v.outcome).toBe("flat");
    expect(v.grade).toBe("C");
  });

  it("direction wrong at horizon → loss / D", () => {
    const v = classifyDirectionalOutcome(
      { direction: "LONG", entry_price: 100, published_at: T0, due_ts: T0 + 5 * DAY },
      [bar(4, 99, 95, 96)],
    );
    expect(v.outcome).toBe("loss");
    expect(v.grade).toBe("D");
  });

  it("options breakeven proxy: beyond breakeven → win / B, inside → loss / D", () => {
    const sig = {
      direction: "LONG", entry_price: 100, breakeven: 104,
      published_at: T0, due_ts: T0 + 10 * DAY,
    };
    const win = classifyDirectionalOutcome(sig, [bar(9, 107, 103, 106)]);
    expect(win.outcome).toBe("win");
    expect(win.resolve_note).toBe("expired_beyond_breakeven_underlying_proxy");
    const loss = classifyDirectionalOutcome(sig, [bar(9, 104, 101, 103)]);
    expect(loss.outcome).toBe("loss");
    expect(loss.resolve_note).toBe("expired_inside_breakeven_underlying_proxy");
  });

  it("returns null with no judging bars", () => {
    expect(classifyDirectionalOutcome(
      { direction: "LONG", entry_price: 100, published_at: T0, due_ts: T0 + DAY },
      [],
    )).toBeNull();
  });
});

describe("isSignalDue", () => {
  it("expiry_ts wins over horizon", () => {
    expect(isSignalDue({ expiry_ts: T0 + DAY, horizon_days: 99, published_at: T0 }, T0 + 2 * DAY)).toBe(true);
    expect(isSignalDue({ expiry_ts: T0 + 5 * DAY, published_at: T0 }, T0 + 2 * DAY)).toBe(false);
  });
  it("horizon_days from published_at", () => {
    expect(isSignalDue({ horizon_days: 3, published_at: T0 }, T0 + 4 * DAY)).toBe(true);
    expect(isSignalDue({ horizon_days: 3, published_at: T0 }, T0 + 2 * DAY)).toBe(false);
  });
  it("no horizon → never due (caller must set one)", () => {
    expect(isSignalDue({ published_at: T0 }, T0 + 365 * DAY)).toBe(false);
  });
});

describe("fsdTacticalToSignals (B3)", () => {
  const signals = [
    {
      signal: "rsp_spy_breadth_breakout",
      pair: "RSP/SPY",
      direction: "favor_equal_weight_over_cap_weight",
      horizon: "intermediate",
      evidence: "RSP/SPY ratio broke its downtrend.",
    },
    {
      signal: "mags_trendline_break",
      pair: "MAGS",
      direction: "caution_mag7_short_term",
      horizon: "tactical",
      evidence: "MAGS broke its rising trendline on heavy volume.",
    },
    { signal: "no_pair_skipped", pair: "", direction: "favor_x" },
  ];

  it("maps pair calls to relative LONG signals and caution calls to SHORT", () => {
    const rows = fsdTacticalToSignals(signals, { proposalId: "prop-1", publishedAt: T0 });
    expect(rows).toHaveLength(2);

    const rsp = rows[0];
    expect(rsp.ticker).toBe("RSP");
    expect(rsp.direction).toBe("LONG");
    expect(rsp.payload.relative_to).toBe("SPY");
    expect(rsp.horizon_days).toBe(30); // intermediate
    expect(rsp.source).toBe("fsd_tactical");
    expect(rsp.signal_id).toBe("fsd:prop-1:rsp_spy_breadth_breakout");

    const mags = rows[1];
    expect(mags.ticker).toBe("MAGS");
    expect(mags.direction).toBe("SHORT"); // "caution_*"
    expect(mags.payload.relative_to).toBeNull();
    expect(mags.horizon_days).toBe(14); // tactical
  });
});

describe("classifyRelativeOutcome (B3)", () => {
  const sig = { direction: "LONG", published_at: T0, due_ts: T0 + 10 * DAY };

  it("wins when the ratio moves in the favored direction by >=1%", () => {
    const bars = [bar(1, 0, 0, 100), bar(9, 0, 0, 105)]; // RSP +5%
    const ref = [bar(1, 0, 0, 500), bar(9, 0, 0, 505)];  // SPY +1% → ratio +~4%
    const v = classifyRelativeOutcome(sig, bars, ref);
    expect(v.outcome).toBe("win");
    expect(v.resolve_note).toBe("relative_horizon_right");
    expect(v.outcome_pct).toBeGreaterThan(1);
  });

  it("loses when the ratio moves against; SHORT inverts", () => {
    const bars = [bar(1, 0, 0, 100), bar(9, 0, 0, 100)];
    const ref = [bar(1, 0, 0, 500), bar(9, 0, 0, 520)]; // ratio -3.8%
    expect(classifyRelativeOutcome(sig, bars, ref).outcome).toBe("loss");
    expect(classifyRelativeOutcome({ ...sig, direction: "SHORT" }, bars, ref).outcome).toBe("win");
  });

  it("returns null without two aligned bar pairs", () => {
    expect(classifyRelativeOutcome(sig, [bar(1, 0, 0, 100)], [bar(2, 0, 0, 500)])).toBeNull();
  });
});

describe("optionsPlayToSignal", () => {
  const play = {
    archetype: "long_call",
    label: "Long Call",
    headline: "Long Call · Jun 26",
    breakeven: 108.5,
    expiration: { iso: "2026-06-26", label: "Jun 26" },
    net_cost_usd: 450,
    net_side: "debit",
    max_loss_usd: 450,
    legs: [{ kind: "option", action: "BUY", type: "CALL", strike: 105, expiration: "2026-06-26", qty: 1 }],
  };

  it("derives vehicle, breakeven, and expiry ts", () => {
    const sig = optionsPlayToSignal(play, {
      ticker: "NVDA", direction: "LONG", ref_id: "trade-123",
      underlying_price: 102, target_price: 112, stop_price: 97,
      published_at: T0,
    });
    expect(sig.source).toBe("options_play");
    expect(sig.vehicle).toBe("call");
    expect(sig.breakeven).toBe(108.5);
    expect(sig.expiry_ts).toBe(Date.parse("2026-06-26T21:00:00Z"));
    expect(sig.horizon_days).toBeNull();
    expect(sig.ticker).toBe("NVDA");
  });

  it("spread archetype maps to vehicle=spread; missing expiry falls back to 30d horizon", () => {
    const sig = optionsPlayToSignal(
      { ...play, archetype: "bull_call_spread", expiration: null, legs: [{ kind: "option", type: "CALL", strike: 105 }] },
      { ticker: "SPY", published_at: T0 },
    );
    expect(sig.vehicle).toBe("spread");
    expect(sig.expiry_ts).toBeNull();
    expect(sig.horizon_days).toBe(30);
  });

  it("returns null without a ticker", () => {
    expect(optionsPlayToSignal(play, {})).toBeNull();
  });
});

describe("resolveDueSignals — fair scheduling (anti-starvation)", () => {
  // 2026-06-28 regression: thousands of perpetually-open cto_level rows used to
  // monopolize a single `ORDER BY published_at ASC LIMIT` scan, starving
  // horizon-based sources (investor_action 73 logged / 0 resolved). The
  // resolver must now scan non-cto_level sources in their own query so they
  // are always graded.
  function makeMockDb(capturedSql) {
    const select = (sql) => {
      const s = String(sql);
      if (/source\s*!=\s*'cto_level'/.test(s)) {
        // The investor signal is due (60d horizon, published 70d ago) but has
        // no candles in this mock, so it stays open — we only assert it was
        // SCANNED via its own query, which is the starvation fix.
        return [{
          signal_id: "invaction:entry:pos1:1", source: "investor_action", desk: "investor",
          ticker: "CRDO", direction: "LONG", status: "open",
          published_at: Date.now() - 70 * DAY, horizon_days: 60, expiry_ts: 0,
          entry_price: 100, payload_json: null,
        }];
      }
      if (/source\s*=\s*'cto_level'/.test(s)) {
        return Array.from({ length: 150 }, (_, i) => ({
          signal_id: `cto:X${i}`, source: "cto_level", desk: "research",
          ticker: "SPY", direction: "LONG", status: "open",
          published_at: Date.now() - (300 - i) * DAY, horizon_days: 0, expiry_ts: 0,
          entry_price: 100, payload_json: null,
        }));
      }
      return [];
    };
    return {
      prepare(sql) {
        capturedSql.push(String(sql));
        return {
          bind() { return this; },
          async all() { return { results: select(sql) }; },
          async run() { return { success: true }; },
        };
      },
      async batch(stmts) { return stmts.map(() => ({ success: true })); },
    };
  }

  it("issues a dedicated non-cto_level scan as well as a cto_level scan", async () => {
    const capturedSql = [];
    const env = { DB: makeMockDb(capturedSql) };
    const res = await resolveDueSignals(env, { limit: 150, now: Date.now() });
    expect(res.ok).toBe(true);
    const selects = capturedSql.filter((s) => /FROM signal_outcomes WHERE status = 'open'/.test(s));
    expect(selects.some((s) => /source\s*!=\s*'cto_level'/.test(s))).toBe(true);
    expect(selects.some((s) => /source\s*=\s*'cto_level'/.test(s))).toBe(true);
    // Both populations enter the scan set (1 investor + 150 cto).
    expect(res.scanned).toBe(151);
  });
});

describe("expireStaleSignals — bound the backlog (pit-stop heal)", () => {
  it("issues a bulk UPDATE retiring stale horizon-less open rows", async () => {
    const captured = [];
    const env = {
      DB: {
        prepare(sql) {
          captured.push(String(sql));
          return {
            bind(...args) { this._args = args; return this; },
            async run() { return { meta: { changes: 3742 } }; },
            async all() { return { results: [] }; },
          };
        },
      },
    };
    const res = await expireStaleSignals(env, { now: Date.now(), maxAgeDays: 30 });
    expect(res.ok).toBe(true);
    expect(res.expired).toBe(3742);
    const upd = captured.find((s) => /UPDATE signal_outcomes/.test(s));
    expect(upd).toBeTruthy();
    expect(/status = 'expired'/.test(upd)).toBe(true);
    // Targets only horizon-less (no expiry, no horizon) open rows past the cutoff.
    expect(/expiry_ts IS NULL OR expiry_ts <= 0/.test(upd)).toBe(true);
    expect(/horizon_days IS NULL OR horizon_days <= 0/.test(upd)).toBe(true);
    expect(/published_at < /.test(upd)).toBe(true);
  });

  it("is a no-op when maxAgeDays is not set", async () => {
    let called = false;
    const env = { DB: { prepare() { called = true; return { bind() { return this; }, async run() { return {}; } }; } } };
    const res = await expireStaleSignals(env, { now: Date.now() });
    expect(res.expired).toBe(0);
    expect(called).toBe(false);
  });
});

describe("resolveDueSignals — drain mode (pit-stop heal)", () => {
  it("expires stale levels then loops the scan until a pass makes no progress", async () => {
    const DAY = 86400000;
    const now = Date.parse("2026-06-28T22:00:00Z");
    let expireCalls = 0;
    let scanRound = 0;
    // First scan round returns a due investor signal (resolves with no candles →
    // stays open, but counts as scanned); to exercise the loop we make round 1
    // resolve via a touched cto level, then round 2 returns empty → stop.
    const env = {
      DB: {
        prepare(sql) {
          const s = String(sql);
          return {
            bind() { return this; },
            async run() {
              if (/UPDATE signal_outcomes\s+SET status = 'expired'/.test(s)) { expireCalls++; return { meta: { changes: 1200 } }; }
              return { meta: { changes: 0 } };
            },
            async all() {
              if (/source = 'cto_level'/.test(s)) {
                scanRound++;
                // Round 1: a horizoned, DUE cto level (resolves). Round 2+: empty → stop.
                if (scanRound === 1) {
                  return { results: [{
                    signal_id: "cto:AAA", source: "cto_level", desk: "research",
                    ticker: "AAA", direction: "LONG", status: "open",
                    published_at: now - 30 * DAY, horizon_days: 14, expiry_ts: 0,
                    entry_price: 100, target_price: 105, stop_price: 95, payload_json: null,
                  }] };
                }
                return { results: [] };
              }
              if (/source != 'cto_level'/.test(s)) return { results: [] };
              if (/ticker_candles/.test(s)) {
                // A bar inside the [publish, publish+14d] window that touches the
                // target (105) → early-resolve win.
                return { results: [{ ts: now - 20 * DAY, h: 106, l: 99, c: 105 }] };
              }
              return { results: [] };
            },
            async batch() { return []; },
          };
        },
        async batch() { return []; },
      },
    };
    const res = await resolveDueSignals(env, { drain: true, expireStaleDays: 30, now });
    expect(res.ok).toBe(true);
    expect(res.expired).toBe(1200);   // bulk-expiry ran
    expect(expireCalls).toBe(1);
    expect(res.resolved).toBe(1);     // the touched cto level graded
    expect(res.batches).toBeGreaterThanOrEqual(2); // looped past the productive round
  });
});
