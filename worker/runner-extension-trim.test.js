import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { assessRunnerExtensionTrim, loadExtensionTrimCfg, nySessionKey } from "./runner-extension-trim.js";

// The motivating case: TSLA LONG from 347.27, first trim 50% at 354.66,
// then Sep 3 held 382-383 for ~2h (+10.3%, ~1.6 ATR above the daily fast
// EMA) with NO rule banking into the strength. It finally trimmed the next
// morning at 359.98 after the gap down.
const TSLA_SEP3 = {
  openTrade: { trimmedPct: 0.5, entryPrice: 347.27 },
  execState: {},
  tickerData: {
    tf_tech: { D: { ema: { ema5: 366.2, ema12: 359.8, ema21: 355.1 } } },
    atr_levels: { atr_day: 10.5 },
  },
  pxNow: 383.0,
  entryPx: 347.27,
  direction: "LONG",
  daCfg: {},
  now: Date.parse("2026-09-03T16:10:00Z"), // 12:10 ET, at the peak
};

describe("assessRunnerExtensionTrim", () => {
  it("banks into the TSLA Sep 3 extension instead of waiting for the giveback", () => {
    const plan = assessRunnerExtensionTrim(TSLA_SEP3);
    expect(plan).toBeTruthy();
    expect(plan.action).toBe("trim");
    expect(plan.reason).toBe("RUNNER_EXTENSION_TRIM");
    expect(plan.newTargetTrimPct).toBe(0.75); // 0.50 + 0.25 step
    expect(plan.pnlPct).toBeGreaterThan(10);
    expect(plan.atrExt).toBeGreaterThanOrEqual(1.5);
  });

  it("holds when profit is below the activation floor", () => {
    const plan = assessRunnerExtensionTrim({
      ...TSLA_SEP3,
      pxNow: 371.0, // +6.8% — green but not deep
    });
    expect(plan).toBeNull();
  });

  it("holds when price is not statistically extended", () => {
    const plan = assessRunnerExtensionTrim({
      ...TSLA_SEP3,
      // +10% pnl but sitting right on the fast EMA (post-consolidation)
      tickerData: {
        tf_tech: { D: { ema: { ema5: 381.5 } } },
        atr_levels: { atr_day: 10.5 },
      },
    });
    expect(plan).toBeNull();
  });

  it("fires at most once per NY session", () => {
    const session = nySessionKey(TSLA_SEP3.now);
    const plan = assessRunnerExtensionTrim({
      ...TSLA_SEP3,
      execState: { extTrimSession: session, extTrimPx: 380.0 },
    });
    expect(plan).toBeNull();
  });

  it("re-fires a later session only on a NEW extension print", () => {
    const nextDay = Date.parse("2026-09-04T15:00:00Z");
    // same-or-lower price than the prior ext trim → no re-fire
    const stale = assessRunnerExtensionTrim({
      ...TSLA_SEP3,
      now: nextDay,
      execState: { extTrimSession: nySessionKey(TSLA_SEP3.now), extTrimPx: 383.0 },
      pxNow: 382.0,
    });
    expect(stale).toBeNull();
    // higher high → allowed again, stepping 0.75 → capped
    const fresh = assessRunnerExtensionTrim({
      ...TSLA_SEP3,
      now: nextDay,
      openTrade: { trimmedPct: 0.5, entryPrice: 347.27 },
      execState: { extTrimSession: nySessionKey(TSLA_SEP3.now), extTrimPx: 383.0 },
      pxNow: 389.0,
    });
    expect(fresh).toBeTruthy();
    expect(fresh.newTargetTrimPct).toBe(0.75);
  });

  it("caps the total trimmed fraction so a runner always survives", () => {
    const plan = assessRunnerExtensionTrim({
      ...TSLA_SEP3,
      openTrade: { trimmedPct: 0.75, entryPrice: 347.27 },
    });
    expect(plan).toBeNull();
  });

  it("mirrors for shorts (extension BELOW the fast EMA)", () => {
    const plan = assessRunnerExtensionTrim({
      openTrade: { trimmedPct: 0.5, entryPrice: 400 },
      execState: {},
      tickerData: {
        tf_tech: { D: { ema: { ema5: 372.0 } } },
        atr_levels: { atr_day: 10 },
      },
      pxNow: 356.0, // +11% short pnl, 1.6 ATR below fast EMA
      entryPx: 400,
      direction: "SHORT",
      daCfg: {},
    });
    expect(plan).toBeTruthy();
    expect(plan.action).toBe("trim");
  });

  it("respects the kill switch and config overrides", () => {
    expect(assessRunnerExtensionTrim({
      ...TSLA_SEP3,
      daCfg: { deep_audit_ext_trim_enabled: "false" },
    })).toBeNull();
    const cfg = loadExtensionTrimCfg({
      deep_audit_ext_trim_min_pnl_pct: "12",
      deep_audit_ext_trim_min_atr_ext: "2.5",
      deep_audit_ext_trim_step_pct: "0.2",
      deep_audit_ext_trim_max_trimmed_pct: "0.6",
    });
    expect(cfg.minPnlPct).toBe(12);
    expect(cfg.minAtrExt).toBe(2.5);
    expect(cfg.stepPct).toBe(0.2);
    expect(cfg.maxTrimmedPct).toBe(0.6);
  });

  it("degrades to null when EMA/ATR inputs are missing (no blind trims)", () => {
    const plan = assessRunnerExtensionTrim({
      ...TSLA_SEP3,
      tickerData: {},
    });
    // Falls back to entry-based ATR estimate + no EMA → null
    expect(plan).toBeNull();
  });
});

// The guard lives entirely in execState, so the CALLER's write order is part
// of the rule. `processTradeSimulation` stamped the guard into a local
// (`_extExec`), persisted that, and left `execState` pointing at the
// pre-trim object — then the runner-stale block and the smart-runner-exit
// block persisted `execState` again later in the SAME pass. Their gate is a
// snapshot of `trimmedPct` taken before this trim, so from the second step
// onward they overwrote the guard with a copy that had no `extTrimSession`.
describe("the call site must adopt the stamped state, not just persist it", () => {
  /** One 5-min pass: assess, trim, stamp, then the two later persists. */
  function runPass({ adoptStampedState }, stored) {
    let execState = { ...stored };
    const openTrade = { trimmedPct: 0.5, entryPrice: 347.27 };
    const plan = assessRunnerExtensionTrim({ ...TSLA_SEP3, openTrade, execState });
    if (plan) {
      const stamped = {
        ...execState,
        lastTrimMs: TSLA_SEP3.now,
        extTrimSession: plan.diag.session,
        extTrimPx: TSLA_SEP3.pxNow,
      };
      if (adoptStampedState) execState = stamped;
    }
    // Later in the same pass: ratchetRunnerPeak reports a new peak (which is
    // exactly the extension condition), then the smart-runner-exit block
    // touches its own counter. Both persist `execState`.
    execState = { ...execState, runnerPeakPrice: TSLA_SEP3.pxNow };
    execState = { ...execState, runnerC512CloseBelowCount: 1 };
    return { plan, persisted: execState };
  }

  it("re-fires in the same session when the stamp is only persisted (the bug)", () => {
    const first = runPass({ adoptStampedState: false }, {});
    expect(first.plan.action).toBe("trim");
    expect(first.persisted.extTrimSession).toBeUndefined();
    // Next tick reads what the pass persisted — the guard is gone.
    const second = runPass({ adoptStampedState: false }, first.persisted);
    expect(second.plan).toBeTruthy();
  });

  it("holds for the rest of the session once the stamp is adopted (the fix)", () => {
    const first = runPass({ adoptStampedState: true }, {});
    expect(first.plan.action).toBe("trim");
    expect(first.persisted.extTrimSession).toBe(nySessionKey(TSLA_SEP3.now));
    expect(first.persisted.extTrimPx).toBe(TSLA_SEP3.pxNow);
    const second = runPass({ adoptStampedState: true }, first.persisted);
    expect(second.plan).toBeNull();
  });

  it("assigns the stamped object back to execState in worker/index.js", async () => {
    const src = await readFile(new URL("./index.js", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("RUNNER EXTENSION TRIM"));
    const stamp = block.indexOf("extTrimSession: _extPlan.diag.session");
    expect(stamp).toBeGreaterThan(-1);
    // The stamp must be built into `execState` itself, not a local the later
    // persists will ignore.
    expect(block.slice(Math.max(0, stamp - 400), stamp)).toMatch(/execState\s*=\s*\{/);
    expect(block.slice(stamp, stamp + 400)).not.toMatch(/execKey,\s*_extExec/);
  });
});
