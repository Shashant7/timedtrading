import { describe, it, expect } from "vitest";
import {
  atmIvFromChain,
  atmStraddleImpliedMove,
  buildCrushBlock,
  buildEarningsPlay,
  contractCoversPrint,
  crushExitBy,
  enrichEarningsPlayCards,
  formatReportDate,
  ivImpliedMove,
  normalizeReportSession,
  pickBackExpiration,
  postCrushBreakeven,
  realizedVolProxyPct,
  resolveImpliedMove,
  scoreEarningsConfluence,
  STRADDLE_EXPECTED_MOVE_FACTOR,
} from "./earnings-play.js";

const chainAround = (spot) => ({
  ok: true,
  underlying_price: spot,
  calls: [
    { strike: spot - 5, mid: 7.2, implied_volatility: 0.62 },
    { strike: spot, mid: 4.0, implied_volatility: 0.6 },
    { strike: spot + 5, mid: 2.1, implied_volatility: 0.64 },
  ],
  puts: [
    { strike: spot - 5, mid: 2.0, implied_volatility: 0.63 },
    { strike: spot, mid: 3.6, implied_volatility: 0.58 },
    { strike: spot + 5, mid: 6.9, implied_volatility: 0.61 },
  ],
});

describe("report date + session helpers", () => {
  it("formats a trading day without timezone drift", () => {
    expect(formatReportDate("2026-08-27")).toBe("Thu Aug 27");
  });

  it("normalizes vendor hour codes", () => {
    expect(normalizeReportSession("amc")).toBe("AMC");
    expect(normalizeReportSession("Before Market Open")).toBe("BMO");
    expect(normalizeReportSession("")).toBeNull();
  });
});

describe("contractCoversPrint", () => {
  it("lets a same-day expiry trade a before-open print", () => {
    expect(contractCoversPrint({ expirationIso: "2026-08-27", reportDate: "2026-08-27", session: "bmo" })).toBe(true);
  });

  it("requires a later expiry for an after-close print", () => {
    expect(contractCoversPrint({ expirationIso: "2026-08-27", reportDate: "2026-08-27", session: "amc" })).toBe(false);
    expect(contractCoversPrint({ expirationIso: "2026-08-28", reportDate: "2026-08-27", session: "amc" })).toBe(true);
  });

  it("treats an unknown session as after-close", () => {
    expect(contractCoversPrint({ expirationIso: "2026-08-27", reportDate: "2026-08-27", session: null })).toBe(false);
  });

  it("returns null when either date is missing", () => {
    expect(contractCoversPrint({ expirationIso: "", reportDate: "2026-08-27" })).toBeNull();
  });
});

describe("implied move", () => {
  it("prices the move off the ATM straddle", () => {
    const res = atmStraddleImpliedMove({ ...chainAround(100), spot: 100 });
    expect(res.basis).toBe("atm_straddle");
    expect(res.atm_strike).toBe(100);
    expect(res.straddle_mid).toBeCloseTo(7.6, 5);
    expect(res.implied_move_usd).toBeCloseTo(7.6 * STRADDLE_EXPECTED_MOVE_FACTOR, 2);
    expect(res.implied_move_pct).toBeCloseTo(6.46, 1);
    expect(res.iv_atm_pct).toBeCloseTo(59, 0);
  });

  it("returns null when the ATM pair has no usable mid", () => {
    const chain = chainAround(100);
    chain.calls[1].mid = null;
    chain.calls[1].last = null;
    chain.puts[1].mid = null;
    chain.puts[1].last = null;
    // 95 / 105 sit outside the ATM band — an intrinsic-heavy straddle is
    // not a substitute for the real one.
    expect(atmStraddleImpliedMove({ ...chain, spot: 100 })).toBeNull();
    expect(atmStraddleImpliedMove({ calls: [], puts: [], spot: 100 })).toBeNull();
  });

  it("strips intrinsic value when the nearest strike is off spot", () => {
    const chain = {
      calls: [{ strike: 100, mid: 5.0 }],
      puts: [{ strike: 100, mid: 3.0 }],
    };
    const res = atmStraddleImpliedMove({ ...chain, spot: 101 });
    expect(res.implied_move_usd).toBeCloseTo((5.0 + 3.0 - 1) * STRADDLE_EXPECTED_MOVE_FACTOR, 2);
  });

  it("falls back to IV × sqrt(t) when only IV is present", () => {
    const res = ivImpliedMove({ ivPct: 60, spot: 100, days: 4 });
    expect(res.basis).toBe("iv_sqrt_t");
    expect(res.implied_move_pct).toBeCloseTo(60 * Math.sqrt(4 / 365), 2);
  });

  it("prefers the straddle, then IV, then nothing", () => {
    expect(resolveImpliedMove({ chain: chainAround(100), spot: 100, days: 4 }).basis).toBe("atm_straddle");
    const ivOnly = {
      ok: true,
      calls: [{ strike: 100, mid: null, implied_volatility: 0.5 }],
      puts: [],
    };
    expect(resolveImpliedMove({ chain: ivOnly, spot: 100, days: 4 }).basis).toBe("iv_sqrt_t");
    expect(resolveImpliedMove({ chain: { ok: true, calls: [], puts: [] }, spot: 100, days: 4 })).toBeNull();
  });
});

describe("IV crush", () => {
  it("reads post-print volatility off the next expiration when the chain has one", () => {
    const block = buildCrushBlock({
      side: "LONG",
      spot: 100,
      strike: 105,
      entryPremium: 0.42,
      dte: 3,
      daysToPrint: 2,
      ivFrontPct: 120,
      ivBackPct: 55,
      atrPct: 0.04,
      impliedMovePct: 6.5,
      coversPrint: true,
      reportDate: "2026-08-27",
      session: "amc",
    });
    expect(block.iv_post_basis).toBe("term_structure");
    expect(block.crush_pct).toBe(54);
    expect(block.severity).toBe("EXTREME");
    expect(block.breakeven_move_pct).toBeGreaterThan(0);
    expect(block.exit_by.date).toBe("2026-08-27");
  });

  it("falls back to the realized-vol proxy with no back month", () => {
    const block = buildCrushBlock({
      side: "LONG",
      spot: 100,
      strike: 105,
      entryPremium: 0.42,
      dte: 3,
      daysToPrint: 2,
      ivFrontPct: 120,
      atrPct: 0.03,
      impliedMovePct: 6.5,
      coversPrint: true,
      reportDate: "2026-08-27",
      session: "amc",
    });
    expect(block.iv_post_basis).toBe("realized_vol");
    expect(block.rv_proxy_pct).toBe(realizedVolProxyPct(0.03));
    expect(block.iv_rv_ratio).toBeGreaterThan(1.4);
    expect(block.severity).not.toBe("NORMAL");
  });

  it("says exit before the print when the implied move cannot cover the crush", () => {
    const block = buildCrushBlock({
      side: "LONG",
      spot: 100,
      strike: 108,
      entryPremium: 1.4,
      dte: 3,
      daysToPrint: 2,
      ivFrontPct: 140,
      ivBackPct: 45,
      impliedMovePct: 2,
      coversPrint: true,
      reportDate: "2026-08-27",
      session: "amc",
    });
    expect(block.covered_by_implied_move).toBe(false);
    expect(block.recommendation).toBe("EXIT_BEFORE_PRINT");
    expect(block.note).toMatch(/Plan the exit by the close on Thu Aug 27/);
  });

  it("allows holding through when the breakeven sits inside the implied move", () => {
    const block = buildCrushBlock({
      side: "LONG",
      spot: 100,
      strike: 102,
      entryPremium: 0.3,
      dte: 4,
      daysToPrint: 1,
      ivFrontPct: 110,
      ivBackPct: 50,
      impliedMovePct: 9,
      coversPrint: true,
      reportDate: "2026-08-27",
      session: "amc",
    });
    expect(block.covered_by_implied_move).toBe(true);
    expect(block.recommendation).toBe("CAN_HOLD_THROUGH");
    expect(block.cushion_ratio).toBeLessThanOrEqual(0.6);
    expect(block.premium_flat).toBeGreaterThan(0);
  });

  it("calls a breakeven that only just fits inside the implied move a tight hold", () => {
    const block = buildCrushBlock({
      side: "LONG",
      spot: 100,
      strike: 106,
      entryPremium: 0.9,
      dte: 4,
      daysToPrint: 2,
      ivFrontPct: 120,
      ivBackPct: 50,
      impliedMovePct: 7,
      coversPrint: true,
      reportDate: "2026-08-27",
      session: "amc",
    });
    expect(block.recommendation).toBe("TIGHT_HOLD");
    expect(block.cushion_ratio).toBeGreaterThan(0.6);
    expect(block.cushion_ratio).toBeLessThanOrEqual(1);
    expect(block.note).toMatch(/upper half of the cone/);
  });

  it("calls a contract that expires first a run-up trade", () => {
    const block = buildCrushBlock({
      side: "LONG",
      spot: 100,
      strike: 105,
      entryPremium: 0.42,
      dte: 2,
      daysToPrint: 2,
      ivFrontPct: 120,
      ivBackPct: 55,
      impliedMovePct: 6.5,
      coversPrint: false,
      reportDate: "2026-08-27",
      session: "amc",
    });
    expect(block.recommendation).toBe("RUN_UP_ONLY");
    expect(block.breakeven_move_pct).toBeNull();
    expect(block.note).toMatch(/run-up is the whole trade/);
  });

  it("reports UNKNOWN instead of inventing a haircut with no volatility reference", () => {
    const block = buildCrushBlock({
      side: "LONG",
      spot: 100,
      strike: 105,
      entryPremium: 0.42,
      dte: 3,
      daysToPrint: 2,
      coversPrint: true,
      reportDate: "2026-08-27",
      session: "amc",
    });
    expect(block.severity).toBe("UNKNOWN");
    expect(block.recommendation).toBe("UNKNOWN");
    expect(block.crush_pct).toBeNull();
    expect(block.note).toMatch(/unmeasured/);
  });

  it("solves the post-crush breakeven and the flat-price premium", () => {
    const be = postCrushBreakeven({
      spot: 100,
      strike: 105,
      type: "C",
      entryPremium: 2.5,
      daysAfterPrint: 1,
      postCrushIvPct: 45,
    });
    expect(be.premium_flat).toBeLessThan(2.5);
    expect(be.breakeven_price).toBeGreaterThan(100);
    expect(be.breakeven_move_pct).toBeGreaterThan(0);
  });

  it("returns a zero-move breakeven when the premium survives the crush", () => {
    const be = postCrushBreakeven({
      spot: 100,
      strike: 100,
      type: "C",
      entryPremium: 0.05,
      daysAfterPrint: 3,
      postCrushIvPct: 45,
    });
    expect(be.breakeven_move_pct).toBe(0);
  });

  it("names the last session before the print", () => {
    expect(crushExitBy({ reportDate: "2026-08-27", session: "amc" }).date).toBe("2026-08-27");
    // Monday before the open — the previous trading day is the Friday.
    expect(crushExitBy({ reportDate: "2026-08-31", session: "bmo" }).date).toBe("2026-08-28");
  });

  it("picks a back expiration at least a week out", () => {
    const exps = ["2026-08-28", "2026-08-31", "2026-09-04", "2026-09-18"];
    expect(pickBackExpiration(exps, "2026-08-28")).toBe("2026-09-04");
    expect(pickBackExpiration(["2026-08-31"], "2026-08-28")).toBe("2026-08-31");
    expect(pickBackExpiration([], "2026-08-28")).toBeNull();
  });

  it("reads ATM IV off a chain", () => {
    expect(atmIvFromChain({ chain: chainAround(100), spot: 100 })).toBe(60);
    expect(atmIvFromChain({ chain: { calls: [], puts: [] }, spot: 100 })).toBeNull();
  });
});

describe("scoreEarningsConfluence", () => {
  const strongLong = {
    side: "LONG",
    confluence: { mode: "RIDE", side: "LONG", timing: { call_opportunity: true } },
    fundamentals: {
      earnings: { beat_rate_pct: 100, avg_surprise_pct: 12, estimates_up: true, guidance_higher: true },
      growth: { eps_growth_pct: 44, rev_growth_pct: 31 },
    },
    social: { has_data: true, bull_ratio_pct: 78, message_count_24h: 120, reddit: { spike_ratio: 3.1 } },
    fsd: { publications: [{ pub_id: "p1", published_at: Date.now() - 3600_000 }] },
  };

  it("calls a fully stacked long CONFLUENT", () => {
    const res = scoreEarningsConfluence(strongLong);
    expect(res.verdict).toBe("CONFLUENT");
    expect(res.against_count).toBe(0);
    expect(res.aligned_count).toBe(4);
    expect(res.score).toBeGreaterThanOrEqual(65);
  });

  it("marks the fundamental pillar against when the record fights the side", () => {
    const res = scoreEarningsConfluence({ ...strongLong, side: "SHORT" });
    const fund = res.pillars.find((p) => p.key === "fundamental");
    const tech = res.pillars.find((p) => p.key === "technical");
    expect(fund.state).toBe("against");
    expect(tech.state).toBe("against");
    expect(res.verdict).not.toBe("CONFLUENT");
  });

  it("stays THIN when nothing but a WAIT verdict is known", () => {
    const res = scoreEarningsConfluence({ side: "LONG", confluence: { mode: "WAIT", side: "LONG" } });
    expect(res.verdict).toBe("THIN");
    expect(res.pillars.filter((p) => p.state === "unknown")).toHaveLength(3);
  });
});

describe("buildEarningsPlay", () => {
  const base = {
    ticker: "aehr",
    side: "LONG",
    spot: 100,
    event: { date: "2026-08-27", hour: "amc", days_to_print: 2 },
    expiration: { iso: "2026-08-28", dte: 3 },
    impliedMove: { implied_move_pct: 6.5, implied_move_usd: 6.5, iv_atm_pct: 59, basis: "atm_straddle" },
    confluence: { mode: "READY", side: "LONG", timing: { call_opportunity: true } },
    now: Date.parse("2026-08-25T15:00:00Z"),
  };

  it("names the catalyst, the range, and the implied-move target", () => {
    const block = buildEarningsPlay(base);
    expect(block.ticker).toBe("AEHR");
    expect(block.report_session).toBe("AMC");
    expect(block.covers_print).toBe(true);
    expect(block.catalyst).toBe("Earnings AMC Thu Aug 27 · 2d out · implied move ±6.5%");
    expect(block.expected_range).toEqual({ low: 93.5, high: 106.5 });
    expect(block.target.underlying).toBe(106.5);
    expect(block.target.basis).toBe("implied_move");
    expect(block.crush.severity).toBe("UNKNOWN");
    expect(block.crush_note).toBe(block.crush.note);
  });

  it("says today instead of 0d out on same-day AMC", () => {
    const block = buildEarningsPlay({
      ...base,
      ticker: "INTU",
      side: "SHORT",
      event: { date: "2026-08-25", hour: "amc", days_to_print: 0 },
      expiration: { iso: "2026-08-28", dte: 3 },
    });
    expect(block.catalyst).toMatch(/Earnings AMC Tue Aug 25 · today/);
    expect(block.days_to_print).toBe(0);
    expect(block.covers_print).toBe(true);
  });

  it("carries the crush read when the strike, premium and back month are known", () => {
    const block = buildEarningsPlay({
      ...base,
      strike: 105,
      entryPremium: 0.42,
      ivBackPct: 55,
      atrPct: 0.04,
      impliedMove: { ...base.impliedMove, iv_atm_pct: 120 },
    });
    expect(block.crush.iv_post_basis).toBe("term_structure");
    expect(block.crush.crush_pct).toBe(54);
    expect(block.crush.severity).toBe("EXTREME");
    expect(["EXIT_BEFORE_PRINT", "CAN_HOLD_THROUGH"]).toContain(block.crush.recommendation);
    expect(block.crush.exit_by.label).toBe("the close on Thu Aug 27");
  });

  it("flips the target below spot for a put", () => {
    const block = buildEarningsPlay({ ...base, side: "SHORT" });
    expect(block.target.underlying).toBe(93.5);
  });

  it("warns when the contract expires before the print", () => {
    const block = buildEarningsPlay({ ...base, expiration: { iso: "2026-08-27", dte: 2 } });
    expect(block.covers_print).toBe(false);
    expect(block.crush_note).toMatch(/expires before the print/);
  });

  it("says so instead of guessing when the chain is unavailable", () => {
    const block = buildEarningsPlay({
      ...base,
      impliedMove: null,
      multiBaggerTargets: { "3x_underlying_at": 118 },
    });
    expect(block.implied_move_pct).toBeNull();
    expect(block.catalyst).toMatch(/implied move unavailable/);
    expect(block.expected_range).toBeNull();
    expect(block.target).toEqual({
      underlying: 118,
      basis: "premium_multiple",
      note: "Premium-multiple target — no chain quote to imply a move",
    });
  });

  it("returns null without a report date", () => {
    expect(buildEarningsPlay({ ...base, event: { hour: "amc" } })).toBeNull();
  });
});

describe("enrichEarningsPlayCards", () => {
  const env = { KV_TIMED: { get: async () => null } };

  it("only touches earnings-prep cards and stops at the cap", async () => {
    const calls = [];
    const cards = ["AAA", "BBB", "CCC", "DDD"].map((t) => ({
      ticker: t,
      earnings_prep: true,
      direction: "LONG",
      expiration: { iso: "2026-08-28", dte: 3 },
    }));
    cards.push({ ticker: "EEE", earnings_prep: false, direction: "LONG", expiration: { iso: "2026-08-28", dte: 3 } });
    const eventBySym = Object.fromEntries(
      ["AAA", "BBB", "CCC", "DDD", "EEE"].map((t) => [t, { date: "2026-08-27", hour: "amc", days_to_print: 2 }]),
    );
    await enrichEarningsPlayCards(env, cards, {
      eventBySym,
      spotBySym: { AAA: 100, BBB: 50, CCC: 20, DDD: 10 },
      fetchChain: async (_env, sym) => {
        calls.push(sym);
        return chainAround(100);
      },
    });
    expect(calls).toEqual(["AAA", "BBB", "CCC"]);
    expect(cards.filter((c) => c.earnings_play)).toHaveLength(3);
    expect(cards[4].earnings_play).toBeUndefined();
  });

  it("skips a card with no known report date", async () => {
    const cards = [{ ticker: "AAA", earnings_prep: true, direction: "LONG", expiration: { iso: "2026-08-28", dte: 3 } }];
    await enrichEarningsPlayCards(env, cards, { eventBySym: {}, fetchChain: async () => chainAround(100) });
    expect(cards[0].earnings_play).toBeUndefined();
  });

  it("keeps the 4H wait why on a same-day AMC card", async () => {
    const cards = [{
      ticker: "INTU",
      earnings_prep: true,
      h4_close_pending: true,
      direction: "SHORT",
      expiration: { iso: "2026-08-28", dte: 3 },
    }];
    await enrichEarningsPlayCards(env, cards, {
      eventBySym: { INTU: { date: "2026-08-25", hour: "amc", days_to_print: 0 } },
      spotBySym: { INTU: 670 },
      fetchChain: async () => chainAround(670),
    });
    expect(cards[0].earnings_play?.days_to_print).toBe(0);
    expect(cards[0].shot_reason).toMatch(/4H still open/);
  });

  it("still builds the block when the chain fetch fails", async () => {
    const cards = [{
      ticker: "AAA",
      earnings_prep: true,
      direction: "LONG",
      expiration: { iso: "2026-08-28", dte: 3 },
      multi_bagger_targets: { "3x_underlying_at": 130 },
    }];
    await enrichEarningsPlayCards(env, cards, {
      eventBySym: { AAA: { date: "2026-08-27", hour: "amc", days_to_print: 2 } },
      spotBySym: { AAA: 100 },
      fetchChain: async () => { throw new Error("vendor down"); },
    });
    expect(cards[0].earnings_play.implied_move_pct).toBeNull();
    expect(cards[0].earnings_play.target.basis).toBe("premium_multiple");
  });
});
