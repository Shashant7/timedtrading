import { describe, it, expect } from "vitest";
import {
  normalizeReviewPayload,
  tradeReviewEnabled,
  tradeReviewAutoRun,
  loadTradeReviewConfig,
} from "./trade-review-agent.js";
import { buildTradeReviewUserPrompt } from "./trade-review-prompts.js";
import { condenseSnapshot, pickTimeframe } from "./trade-review-context.js";

describe("normalizeReviewPayload", () => {
  const good = {
    grade: "B",
    verdict: "PREMATURE_EXIT",
    headline: "Exited into the first pullback and left 19% on the table.",
    price_action: "Price held the hourly 233 and resumed.",
    assessment: "The exit trigger fired on a single bar close.",
    probability_of_success: 0.62,
    failure_modes: ["hourly 233 lost", "sector rotation"],
    capture_commentary: "Realized 3.8% against an 8% MFE.",
    should_have_held: true,
    confidence: 0.7,
    engine_findings: [
      { finding: "Exit fires on one bar close", scope: "recurring", kind: "config", config_key: "exit_confirm_bars", proposed_value: "2", rationale: "Two bars would have held." },
    ],
  };

  it("passes a well-formed payload through", () => {
    const out = normalizeReviewPayload(good, "EXIT");
    expect(out.grade).toBe("B");
    expect(out.verdict).toBe("PREMATURE_EXIT");
    expect(out.should_have_held).toBe(true);
    expect(out.engine_findings[0].config_key).toBe("exit_confirm_bars");
  });

  it("rejects a verdict that does not belong to the leg kind", () => {
    // GOOD_TRIM is a TRIM verdict; on an EXIT leg it must not survive.
    const out = normalizeReviewPayload({ ...good, verdict: "GOOD_TRIM" }, "EXIT");
    expect(out.verdict).toBeNull();
  });

  it("rejects invented grades", () => {
    expect(normalizeReviewPayload({ ...good, grade: "A++" }, "EXIT").grade).toBeNull();
    expect(normalizeReviewPayload({ ...good, grade: "excellent" }, "EXIT").grade).toBeNull();
  });

  it("clamps out-of-range probabilities rather than storing them", () => {
    expect(normalizeReviewPayload({ ...good, probability_of_success: 1.4 }, "ENTRY").probability_of_success).toBeNull();
    expect(normalizeReviewPayload({ ...good, probability_of_success: -0.2 }, "ENTRY").probability_of_success).toBeNull();
    expect(normalizeReviewPayload({ ...good, probability_of_success: 0 }, "ENTRY").probability_of_success).toBe(0);
  });

  it("demotes a config finding with no config_key to engine work", () => {
    const out = normalizeReviewPayload({
      ...good,
      engine_findings: [{ finding: "Something vague", kind: "config", config_key: "  ", proposed_value: "2" }],
    }, "EXIT");
    expect(out.engine_findings[0].kind).toBe("engine");
  });

  it("drops malformed findings entirely", () => {
    const out = normalizeReviewPayload({
      ...good,
      engine_findings: [null, "a string", { rationale: "no finding text" }, { finding: "  " }],
    }, "EXIT");
    expect(out.engine_findings).toEqual([]);
  });

  it("survives garbage input without throwing", () => {
    expect(normalizeReviewPayload(null, "ENTRY").grade).toBeNull();
    expect(normalizeReviewPayload("nope", "ENTRY").failure_modes).toEqual([]);
    expect(normalizeReviewPayload({ failure_modes: "not an array" }, "ENTRY").failure_modes).toEqual([]);
  });

  it("caps list lengths and string sizes", () => {
    const out = normalizeReviewPayload({
      ...good,
      headline: "x".repeat(5000),
      failure_modes: Array.from({ length: 40 }, (_, i) => `mode ${i}`),
    }, "EXIT");
    expect(out.headline.length).toBe(200);
    expect(out.failure_modes.length).toBe(8);
  });
});

describe("tradeReviewEnabled", () => {
  it("is off unless the flag is explicitly true", () => {
    expect(tradeReviewEnabled({})).toBe(false);
    expect(tradeReviewEnabled({ _deepAuditConfig: {} })).toBe(false);
    expect(tradeReviewEnabled({ _deepAuditConfig: { trade_review_enabled: "false" } })).toBe(false);
    expect(tradeReviewEnabled({ _deepAuditConfig: { trade_review_enabled: "true" } })).toBe(true);
    expect(tradeReviewEnabled({ _deepAuditConfig: { trade_review_enabled: true } })).toBe(true);
  });
});

describe("loadTradeReviewConfig", () => {
  function envWithRows(rows, calls = { n: 0 }) {
    return {
      calls,
      DB: {
        prepare() {
          calls.n += 1;
          return { bind: () => ({ all: async () => ({ results: rows }) }) };
        },
      },
    };
  }

  it("hydrates the reviewer flags on paths that never loaded the deep-audit config", async () => {
    // Admin HTTP requests and the 22:00 cron arrive with an empty
    // _deepAuditConfig, which used to read as "feature off" regardless of
    // what model_config said.
    const env = envWithRows([
      { config_key: "trade_review_enabled", config_value: "true" },
      { config_key: "trade_review_auto_run", config_value: "true" },
      { config_key: "trade_review_batch", config_value: "12" },
    ]);
    expect(tradeReviewEnabled(env)).toBe(false);
    await loadTradeReviewConfig(env);
    expect(tradeReviewEnabled(env)).toBe(true);
    expect(tradeReviewAutoRun(env)).toBe(true);
    expect(env._deepAuditConfig.trade_review_batch).toBe(12);
  });

  it("only hits D1 once per isolate", async () => {
    const calls = { n: 0 };
    const env = envWithRows([{ config_key: "trade_review_enabled", config_value: "true" }], calls);
    await loadTradeReviewConfig(env);
    await loadTradeReviewConfig(env);
    await loadTradeReviewConfig(env);
    expect(calls.n).toBe(1);
  });

  it("leaves the feature off when the lookup throws", async () => {
    const env = {
      DB: { prepare() { throw new Error("no such table: model_config"); } },
    };
    await loadTradeReviewConfig(env);
    expect(tradeReviewEnabled(env)).toBe(false);
    expect(tradeReviewAutoRun(env)).toBe(false);
  });
});

describe("pickTimeframe", () => {
  it("scales resolution to the hold time", () => {
    expect(pickTimeframe(2 * 86400000)).toBe("10");
    expect(pickTimeframe(9 * 86400000)).toBe("60");
    expect(pickTimeframe(60 * 86400000)).toBe("D");
  });
});

describe("condenseSnapshot", () => {
  it("keeps the per-timeframe read and drops the rest", () => {
    const out = condenseSnapshot(JSON.stringify({
      avg_bias: 0.4,
      noise: { lots: "of it" },
      tf: {
        "15m": { bias: -0.9, signals: { supertrend: -1, ema_structure: -1, rsi: 38.4, junk: 1 } },
        "1H": { bias: 0.4, signals: { supertrend: 1, rsi: 55 } },
      },
    }));
    expect(Object.keys(out)).toEqual(["15m", "1H"]);
    expect(out["15m"]).toEqual({ bias: -0.9, supertrend: -1, st_slope: null, ema_cross: null, ema_structure: -1, rsi: 38.4 });
  });

  it("returns null when there is no tf grid", () => {
    expect(condenseSnapshot(null)).toBeNull();
    expect(condenseSnapshot("not json")).toBeNull();
    expect(condenseSnapshot(JSON.stringify({ tf: {} }))).toBeNull();
  });
});

describe("buildTradeReviewUserPrompt", () => {
  const context = {
    trade: { ticker: "HALO", direction: "LONG" },
    engine_claim: {
      setup_name: "TT Support Bounce", setup_grade: "A", entry_path: "tt_n_test_support",
      rank: 3, rr: 2.4, stop_loss: 74.2, take_profit: 88, levels_source: "decision_record",
      exit_reason: "ST_FLIP",
      cio_decision: { decision: "APPROVE", confidence: 0.7, reasoning: "Clean base." },
    },
    leg: { kind: "EXIT", seq: 0, ts: 1786000000000, price: 81, qty_pct: 50, reason: "ST_FLIP", from_receipt: true },
    prior_legs: [{ kind: "ENTRY", seq: 0, ts: 1785000000000, price: 77.93, qty_pct: 100, reason: "entry" }],
    tape: {
      timeframe: "60", bar_count: 120,
      geometry: { sl_distance_pct: 4.8, tp_distance_pct: 12.9, rr: 2.7, entry_in_bar_range: 0.35 },
      capture: {
        entry: { ts: 1785000000000, price: 77.93 },
        exit: { ts: 1786000000000, price: 81, reason: "ST_FLIP" },
        bars_in_trade: 40, bars_after_exit: 60,
        mfe_pct: 8.35, mae_pct: -1.2, heat_before_payoff_pct: -1.2,
        realized_pct: 3.94, realized_usd: 300, capture_ratio: 0.47,
        post_exit_pct: 23.4, post_exit_extreme_ts: 1787000000000, lookahead_days: 10,
        big_move: { from_ts: 1784000000000, from_price: 77, to_ts: 1787000000000, to_price: 100, pct: 29.87 },
        big_move_capture_ratio: 0.132,
        stored_mfe_pct: 8.4,
      },
    },
    signals_at_entry: { "1H": { bias: 0.6, supertrend: 1, ema_structure: 0.8, rsi: 58 } },
    signals_at_exit: { "1H": { bias: -0.2, supertrend: -1, ema_structure: 0.3, rsi: 46 } },
  };

  const prompt = buildTradeReviewUserPrompt(context);

  it("leads with the leg under review", () => {
    expect(prompt.startsWith("LEG UNDER REVIEW: EXIT on HALO LONG")).toBe(true);
  });

  it("labels the engine's story as a claim, not evidence", () => {
    expect(prompt).toContain("ENGINE CLAIM (the assertion you are grading — not evidence)");
    expect(prompt).toContain("TT Support Bounce");
  });

  it("states the capture facts including what was left after the exit", () => {
    expect(prompt).toContain("MFE 8.35%");
    expect(prompt).toContain("Capture of the in-trade MFE: 47%");
    expect(prompt).toContain("DOMINANT MOVE in the window: 29.87%");
    expect(prompt).toContain("Share of that dominant move captured: 13%");
    expect(prompt).toContain("price still ran 23.40% in the trade's favour");
  });

  it("flags a mismatch between the engine's MFE and the tape's", () => {
    const drifted = JSON.parse(JSON.stringify(context));
    drifted.tape.capture.stored_mfe_pct = 20;
    expect(buildTradeReviewUserPrompt(drifted)).toContain("DISCREPANCY");
    // Within tolerance → no noise.
    expect(prompt).not.toContain("DISCREPANCY");
  });

  it("warns when the leg was reconstructed rather than received", () => {
    const synth = JSON.parse(JSON.stringify(context));
    synth.leg.from_receipt = false;
    expect(buildTradeReviewUserPrompt(synth)).toContain("reconstructed from trade summary columns");
  });

  it("includes the prior legs so a trim is judged in context", () => {
    expect(prompt).toContain("LEGS ALREADY EXECUTED ON THIS TRADE");
    expect(prompt).toContain("ENTRY at 77.9300");
  });

  it("states candle coverage and stays quiet when it is adequate", () => {
    expect(prompt).toContain("Candle coverage while the position was open: 40 bars, plus 60 after the exit");
    expect(prompt).not.toContain("WARNING: the tape barely covers");
  });

  it("warns and steers to INSUFFICIENT_DATA when the tape is too thin", () => {
    const thin = JSON.parse(JSON.stringify(context));
    thin.tape.capture.bars_in_trade = 1;
    const p = buildTradeReviewUserPrompt(thin);
    expect(p).toContain("WARNING: the tape barely covers this trade");
    expect(p).toContain("INSUFFICIENT_DATA");
  });

  it("distinguishes a move still running at the exit from one that began after it", () => {
    // Fixture's big move spans the exit → "still running".
    expect(prompt).toContain("still running when the position was closed");

    const after = JSON.parse(JSON.stringify(context));
    after.tape.capture.big_move.from_ts = after.tape.capture.exit.ts + 1000;
    const p = buildTradeReviewUserPrompt(after);
    expect(p).toContain("BEGAN AFTER the exit");
    expect(p).toContain("whether re-entry was the missed action");
  });

  it("refuses to grade a stop it could not attribute to this trade", () => {
    const noLevels = JSON.parse(JSON.stringify(context));
    noLevels.tape.geometry = { stop_loss: null, take_profit: null, entry_in_bar_range: 0.35 };
    const p = buildTradeReviewUserPrompt(noLevels);
    expect(p).toContain("NOT RECOVERABLE for this trade");
    expect(p).not.toContain("→ R:R");
  });

  it("says a missing dominant move is uncomputed, not absent", () => {
    const noBig = JSON.parse(JSON.stringify(context));
    noBig.tape.capture.big_move = null;
    const p = buildTradeReviewUserPrompt(noBig);
    expect(p).toContain("NOT COMPUTABLE");
    expect(p).toContain("Do not conclude there was no move");
  });

  it("omits the exit read for entry legs", () => {
    const entry = JSON.parse(JSON.stringify(context));
    entry.leg.kind = "ENTRY";
    const p = buildTradeReviewUserPrompt(entry);
    expect(p).not.toContain("MULTI-TIMEFRAME READ AT EXIT");
    expect(p).toContain("MULTI-TIMEFRAME READ AT ENTRY");
  });
});
