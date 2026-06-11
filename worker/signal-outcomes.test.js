// worker/signal-outcomes.test.js
// Pins the pure resolution core of the Signal Outcome Ledger.

import { describe, it, expect } from "vitest";
import {
  classifyDirectionalOutcome,
  isSignalDue,
  optionsPlayToSignal,
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
