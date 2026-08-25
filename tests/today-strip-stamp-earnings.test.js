// @vitest-environment jsdom
//
// Renders the Today page with a lotto card that carries an earnings play and
// an index day-trade card, then asserts the two things the operator asked
// for are actually on screen: the published stamp and the earnings block.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import React from "react";
import { act } from "react";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = process.cwd();
const origError = console.error;

const PUBLISHED_AT = Date.now() - 3 * 60 * 1000;

const EARNINGS_PLAY = {
  ticker: "AEHR",
  side: "LONG",
  report_date: "2026-08-27",
  report_date_label: "Thu Aug 27",
  report_session: "AMC",
  days_to_print: 2,
  covers_print: true,
  implied_move_pct: 6.5,
  implied_move_usd: 6.5,
  implied_move_basis: "atm_straddle",
  iv_atm_pct: 59,
  expected_range: { low: 93.5, high: 106.5 },
  target: { underlying: 106.5, basis: "implied_move", note: "Implied-move target" },
  catalyst: "Earnings AMC Thu Aug 27 · 2d out · implied move ±6.5%",
  alignment: {
    score: 78,
    verdict: "CONFLUENT",
    aligned_count: 4,
    against_count: 0,
    summary: "4/4 aligned",
    pillars: [
      { key: "technical", label: "Technical", state: "aligned", points: 38, note: "Confluence READY" },
      { key: "fundamental", label: "Fundamentals", state: "aligned", points: 18, note: "beat rate 100%" },
      { key: "social", label: "Social tape", state: "aligned", points: 13, note: "78% bullish" },
      { key: "research", label: "Research desk", state: "aligned", points: 15, note: "2 mentions today" },
    ],
  },
  crush: {
    severity: "ELEVATED",
    recommendation: "TIGHT_HOLD",
    iv_front_pct: 118,
    iv_post_pct: 54,
    iv_post_basis: "term_structure",
    rv_proxy_pct: 63.5,
    iv_rv_ratio: 1.86,
    crush_pct: 54,
    premium_flat: 0.18,
    premium_flat_pct: -57,
    breakeven_price: 104.2,
    breakeven_move_pct: 4.2,
    covered_by_implied_move: true,
    cushion_ratio: 0.65,
    exit_by: { date: "2026-08-27", label: "the close on Thu Aug 27" },
    note: "Thin cushion: breakeven 4.2% against an implied 6.5% means the print has to land in the upper half of the cone and on the right side.",
  },
  crush_note: "Thin cushion: breakeven 4.2% against an implied 6.5% means the print has to land in the upper half of the cone and on the right side.",
};

const CONVEXITY_PLAY = {
  ticker: "AEHR",
  play_class: "lotto",
  direction: "LONG",
  archetype: "lotto_call",
  strike: 105,
  expiration: { iso: "2026-08-28", dte: 3, label: "Aug 28 (3 DTE)" },
  premium_mid: 0.42,
  max_loss_usd: 50,
  multi_bagger_targets: { "3x_underlying_at": 118 },
  top_target_underlying: 118,
  confluence_mode: "READY",
  confluence_score: 71,
  earnings_prep: true,
  earnings_play: EARNINGS_PLAY,
  headline: "BUY on AEHR 105C Aug 28 (3DTE) — earnings-prep lotto call, premium may go to zero",
  scan_line: "Risk $50 · 3x+ @ $118.00 · Pay ≤ $0.42",
  action: "BUY",
};

const GENERIC_LOTTO = {
  ticker: "CVX",
  play_class: "lotto",
  direction: "LONG",
  archetype: "lotto_call",
  strike: 205,
  expiration: { iso: "2026-08-28", dte: 3, label: "Aug 28 (3 DTE)" },
  premium_mid: 0.91,
  max_loss_usd: 91,
  multi_bagger_targets: { "3x_underlying_at": 206.82 },
  top_target_underlying: 206.82,
  confluence_mode: "READY",
  confluence_score: 64,
  earnings_prep: false,
  shot_reason: "Setup is READY long — floor held, call compression, 5/8 layers, Energy.",
  headline: "BUY on CVX 205C Aug 28 (3DTE) — lotto call, premium may go to zero",
  scan_line: "Risk $91 · 3x+ @ $206.82 · Pay ≤ $0.91",
  action: "BUY",
};

const DAY_TRADE_PLAY = {
  ticker: "SPY",
  direction: "LONG",
  price: 640,
  strike: 641,
  day_trade: true,
  day_trade_dte: 0,
  confluence_mode: "RIDE",
  day_lean: "LONG",
  primary: { _day_trade_flavor: "call", strikes: { primary: 641 }, expiration: { iso: "2026-08-25", dte: 0 } },
  execution: {
    action: "BUY",
    display_action: "BUY",
    headline: "BUY SPY 641C",
    why: "5m EMA21 + SuperTrend up",
    premium_band: { premium: 1.2, display_buy_ceil: 1.35 },
    contract: { flavor: "call", strike: 641, exp_bit: "Aug 25" },
    rr: { trim: 1.5, exit: 1.9 },
  },
};

// QQQ: model is still holding an older 500C position while the fresh signal
// is a 502C — the strip must show the held position as its OWN card.
const DAY_TRADE_PLAY_HELD = {
  ticker: "QQQ",
  direction: "LONG",
  price: 500,
  strike: 502,
  day_trade: true,
  day_trade_dte: 1,
  confluence_mode: "WAIT",
  day_lean: "LONG",
  primary: { _day_trade_flavor: "call", strikes: { primary: 502 }, expiration: { iso: "2026-08-26", dte: 1 } },
  execution: {
    action: "WAIT",
    display_action: "WAIT",
    premium_band: { premium: 0.9, display_buy_ceil: 1.0 },
    contract: { flavor: "call", strike: 502, exp_bit: "Aug 26" },
    rr: { trim: 1.4, exit: 1.8 },
  },
  position: {
    signal_id: "dt:QQQ:2026-08-25:2026-08-26:C:500",
    status: "open",
    flavor: "call",
    strike: 500,
    expiration: { iso: "2026-08-26", dte: 1, label: "Aug 26 (1DTE)" },
    entry_premium: 0.74,
    last_premium: 0.9,
    peak_premium: 1.1,
    contracts: 3,
    contracts_remaining: 3,
    size_label: "heavy",
    held_overnight: false,
    profit_lock_armed: false,
    pnl_pct: 21.6,
  },
};

function loadScript(relPath) {
  const src = readFileSync(join(ROOT, relPath), "utf8");
  // eslint-disable-next-line no-eval
  globalThis.eval(src);
}

function mockFetch() {
  window.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/timed/options/convexity")) {
      return {
        ok: true,
        json: async () => ({ ok: true, count: 2, plays: [CONVEXITY_PLAY, GENERIC_LOTTO], generated_at: PUBLISHED_AT }),
      };
    }
    if (u.includes("/timed/options/all")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          plays: [],
          day_trade_plays: [DAY_TRADE_PLAY, DAY_TRADE_PLAY_HELD],
          day_trade_suppressed: [],
          day_trade_count: 2,
          day_trade_generated_at: PUBLISHED_AT,
          generated_at: PUBLISHED_AT,
        }),
      };
    }
    if (u.includes("/timed/all")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            AEHR: { ticker: "AEHR", price: 100, prev_close: 98, rank: 4, score: 71 },
            CVX: { ticker: "CVX", price: 203.09, prev_close: 205.26, rank: 8, score: 64 },
            SPY: { ticker: "SPY", price: 640, prev_close: 638, rank: 1, score: 60 },
            QQQ: { ticker: "QQQ", price: 500, prev_close: 498, rank: 2, score: 55 },
          },
        }),
      };
    }
    if (u.includes("/timed/tickers")) {
      return { ok: true, json: async () => ({ tickers: ["AEHR", "CVX", "SPY"] }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
}

describe("Today strips — published stamp + lotto earnings play", () => {
  beforeAll(async () => {
    console.error = () => {};
    window.React = React;
    window.ReactDOM = require("react-dom/client");
    window.TimedAuthGate = ({ children }) =>
      children({ email: "test@timedtrading.test", role: "admin", tier: "pro", subscription_status: "active" });
    window._ttIsPro = true;
    window._ttIsAdmin = true;
    window.TTFetchCache = {
      get: async (url) => (await window.fetch(url)).json(),
      peek: () => null,
      put: () => {},
      invalidate: () => {},
      subscribe: () => () => {},
    };
    window.TimedBubbleChart = { getRankedTickers: () => [], BubbleChart: () => null };
    mockFetch();

    const container = document.createElement("div");
    container.id = "root";
    document.body.appendChild(container);

    loadScript("react-app/shared-price-utils.js");
    loadScript("react-app/investor-nav-badge.js");
    loadScript("react-app/shared-rail-helpers.js");
    loadScript("react-app/shared-verdict-ui.js");
    // Both strips render through TTLaneCard in production; without it they
    // fall back to a plan-only card and the chip row never renders.
    loadScript("react-app/shared-lane-card.js");
    loadScript("react-app-dist/today.compiled.js");

    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
  });

  afterAll(() => {
    console.error = origError;
  });

  it("stamps both fast strips with a published time", () => {
    const stamps = [...document.querySelectorAll(".tt-strip-stamp")];
    expect(stamps.length).toBeGreaterThanOrEqual(2);
    for (const el of stamps) {
      expect(el.textContent).toMatch(/^Published \d{1,2}:\d{2} (AM|PM) ET · (just now|\d+m ago)/);
      expect(el.classList.contains("tt-strip-stamp--stale")).toBe(false);
      expect(el.getAttribute("title")).toMatch(/^Compiled /);
    }
  });

  it("shows the catalyst, implied move, confluence, and target on the lotto card", () => {
    const text = document.body.textContent || "";
    expect(text).toContain("EARN Aug 27 AMC");
    expect(text).toContain("AMC Thu Aug 27 (2d)");
    expect(text).toContain("±6.5% ($6.50)");
    expect(text).toContain("CONFLUENT · 4/4 aligned");
    expect(text).toContain("$106.50");
  });

  it("flags the IV crush with the post-print breakeven and the exit session", () => {
    const text = document.body.textContent || "";
    expect(text).toContain("ELEVATED · -57% at flat");
    expect(text).toContain("4.2% post-print");
    expect(text).toContain("close Thu Aug 27");
    expect(text).toMatch(/Thin cushion: breakeven 4\.2% against an implied 6\.5%/);
  });

  it("shows model status and a clear action chip on the index day-trade card", () => {
    const text = document.body.textContent || "";
    expect(text).toMatch(/BUY on SPY 641C Aug 25 \(0DTE\) — day-trade call/);
    // Confluence mode chip (model status).
    expect(text).toContain("RIDE");
    // One authoritative action chip — no confusing BUY/LONG/WAIT triple.
    expect(text).toContain("BUY CALL");
    // Structured, non-wrapping fact grid carries the live premium.
    expect(text).toContain("$1.20");
    expect(document.querySelector(".tt-dt-plan__facts")).toBeTruthy();
  });

  it("renders the open position as its own card when the held strike differs", () => {
    const text = document.body.textContent || "";
    // Separate held-position card (500C) distinct from the fresh 502C signal.
    const posCard = document.querySelector(".tt-strip-card--position");
    expect(posCard).toBeTruthy();
    expect(posCard.textContent).toContain("HOLDING QQQ 500C");
    // Live P&L badge on the held position (entry 0.74 → 0.90 ≈ +22%).
    expect(text).toContain("HELD +22%");
  });

  it("shows a brief why on a non-earnings lotto and never labels it 0 DTE", () => {
    const text = document.body.textContent || "";
    expect(text).toContain("Setup is READY long — floor held, call compression, 5/8 layers, Energy.");
    expect(text).toContain("Aug 28 (3 DTE)");
    expect(text).not.toMatch(/CVX[\s\S]{0,240}0 DTE/);
  });
});
