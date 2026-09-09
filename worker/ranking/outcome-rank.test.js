import { describe, it, expect } from "vitest";
import { fitOutcomeRank, scoreOutcomeRank, rankFeatures } from "./outcome-rank.js";
import { evaluateOutcomeRank } from "../../scripts/evaluate-outcome-rank.mjs";

const DAY = 86400000, ASOF = Date.parse("2026-07-01T14:00:00Z");
const row = (id, extra = {}) => ({ trade_id: String(id), rank: 85, rr: 2, direction: "LONG",
  entry_path: "tt_n_test_support", status: "WIN", entry_ts: ASOF - 4 * DAY,
  exit_ts: ASOF - 2 * DAY, pnl_pct: 1, pnl: 10, notional: 1000, ...extra });
const history = () => Array.from({ length: 40 }, (_, i) => row(i));

describe("offline outcome ranking contract", () => {
  it("future, equal-time and open outcomes cannot affect an entry prediction", () => {
    const baseline = fitOutcomeRank(history(), ASOF);
    const adversarial = fitOutcomeRank([...history(),
      row("future", { exit_ts: ASOF + DAY, pnl_pct: 100 }),
      row("same", { exit_ts: ASOF, pnl_pct: 100 }),
      row("open", { status: "OPEN", pnl_pct: 100 }),
    ], ASOF);
    expect(adversarial.groups).toEqual(baseline.groups);
    expect(adversarial.total).toEqual(baseline.total);
    expect(adversarial.latestExit).toBeLessThan(ASOF);
    expect(scoreOutcomeRank(row("new"), adversarial, ASOF).score)
      .toBe(scoreOutcomeRank(row("new"), baseline, ASOF).score);
  });

  it("excludes duplicate IDs, replay artifacts, malformed returns and impossible timestamps", () => {
    const fit = fitOutcomeRank([row(1), row(1, { pnl_pct: -10 }),
      row(2, { exit_reason: "replay_end_close" }), row(3, { is_replay: "1" }),
      row(4, { pnl_pct: " " }), row(5, { exit_ts: ASOF - 5 * DAY }), row(6),
    ], ASOF);
    expect(fit.total.n).toBe(1);
    expect(fit.exclusions.duplicate).toBe(2);
  });

  it("falls back for missing, sparse, future or stale evidence", () => {
    const input = row("new"), model = fitOutcomeRank(history(), ASOF);
    expect(scoreOutcomeRank({ ...input, rank: null }, model, ASOF).available).toBe(false);
    expect(scoreOutcomeRank(input, fitOutcomeRank([row(1)], ASOF), ASOF).reason).toBe("insufficient_rank_history");
    expect(scoreOutcomeRank(input, model, ASOF - 1).reason).toBe("future_rank_model");
    expect(scoreOutcomeRank(input, model, ASOF + 2 * DAY).reason).toBe("stale_rank_model");
  });

  it("canonicalizes setup aliases without using outcome-dependent features", () => {
    const a = rankFeatures(row(1));
    const b = rankFeatures(row(1, { entry_path: null, setup_name: "TT Support Bounce",
      setup_grade: "winner", mfe_pct: 100, ticker: "FUTURE_WINNER", exit_reason: "tp_hit" }));
    expect(a).toEqual(b);
  });

  it("deduplicates evaluation rows and does not count missing notional as zero cost", () => {
    const out = evaluateOutcomeRank([...history(),
      row("a", { entry_ts: ASOF, exit_ts: ASOF + DAY, notional: null }),
      row("dup", { entry_ts: ASOF, exit_ts: ASOF + DAY }),
      row("dup", { entry_ts: ASOF, exit_ts: ASOF + DAY }),
    ], { from: ASOF, to: ASOF + DAY });
    expect(out.eligible).toBe(1);
    expect(out.scored).toBe(1);
    expect(out.all.pnl_usd).toBe(10);
    expect(out.all.net_usd).toBeNull();
    expect(out.all.cost_covered).toBe(0);
  });
});
