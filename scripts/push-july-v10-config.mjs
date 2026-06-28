#!/usr/bin/env node
/**
 * Push July v10 config — PRE-PROD ONLY (backtest lane; never touches live).
 *
 * v10 = v6 base + one principled SELECTIVITY lever:
 *   deep_audit_focus_min_entry_conviction  70 → 74
 *
 * Rationale (tasks/.../v9 verdict): the anchor's edge is selectivity (25 trades
 * @ 76% WR). v6 (26 @ 65%) traded ~3 marginal losers the anchor avoided; v9
 * (rank_bypass loosening) went the WRONG way — 43 @ 42%. The honest path to lift
 * WR is to RAISE the conviction floor so the lowest-conviction entries (the
 * marginal losers) don't fire, NOT to blacklist July's specific losers
 * (overfit). 74 trims roughly the weakest ~15% of entries while keeping the
 * high-conviction winners.
 *
 * Usage: TIMED_API_KEY=... node scripts/push-july-v10-config.mjs [--dry-run]
 */
const DRY = process.argv.includes("--dry-run");
const API_KEY = process.env.TIMED_API_KEY || process.env.TIMED_TRADING_API_KEY || "AwesomeSauce";
const PREPROD = process.env.PREPROD_BASE || "https://timed-trading-ingest-preprod.shashant.workers.dev";

// Keep learning-bus bans except tickers in the locked July 24-ticker universe.
const SLICE_BLACKLIST = "CVNA,ANET,AVGO,BA,AGYS,CSX,XLP,XLV,TSM,WTS";

// v6 base, verbatim, EXCEPT focus conviction 70 → 74 (the v10 selectivity lever).
const UPDATES = [
  { key: "deep_audit_index_model_enabled", value: "true" },
  { key: "deep_audit_index_model_tickers", value: "SPY,QQQ,IWM" },
  { key: "deep_audit_index_model_reentry_cooldown_hours", value: "48" },
  { key: "deep_audit_setup_demotion_enforce_paths", value: "tt_n_test_support,tt_range_reversal_long" },
  { key: "deep_audit_setup_demotion_index_only", value: "true" },
  { key: "deep_audit_setup_demotion_TT Support Bounce_long", value: "" },
  { key: "deep_audit_tape_capitulation_min_loss_pct", value: "-0.5" },
  { key: "deep_audit_tape_capitulation_skip_if_mfe_pct", value: "0.5" },
  { key: "deep_audit_tape_capitulation_skip_index_swing", value: "true" },
  { key: "deep_audit_earnings_cluster_gate_enabled", value: "true" },
  { key: "deep_audit_earnings_cluster_rank_bypass", value: "0" },
  { key: "deep_audit_earnings_cluster_min_tickers", value: "3" },
  { key: "deep_audit_earnings_cluster_high_rank_floor", value: "100" },
  { key: "deep_audit_earnings_cluster_high_rank_day_pad", value: "3" },
  { key: "deep_audit_doctrine_force_defer_bull_enabled", value: "true" },
  { key: "deep_audit_doctrine_force_defer_min_rank", value: "93" },
  { key: "deep_audit_doctrine_force_defer_max_loss_pct", value: "-2.0" },
  { key: "deep_audit_cohort_sector_etf_pause_enabled", value: "false" },
  { key: "deep_audit_ticker_blacklist", value: SLICE_BLACKLIST },
  { key: "deep_audit_focus_min_entry_conviction", value: "74" },   // v10: 70 → 74 (selectivity)
];

async function pushConfig(base, updates) {
  const res = await fetch(`${base}/timed/admin/model-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify({ updates: updates.map((u) => ({ key: u.key, value: u.value })) }),
  });
  return res.json();
}

async function main() {
  console.log(`Pushing v10 config (${UPDATES.length} keys) to PRE-PROD ONLY: ${PREPROD}`);
  for (const u of UPDATES) console.log(`  ${u.key} = ${JSON.stringify(u.value)}`);
  if (DRY) return;
  const pre = await pushConfig(PREPROD, UPDATES);
  if (!pre.ok) throw new Error(JSON.stringify(pre));
  console.log("Pre-prod ok:", JSON.stringify(pre).slice(0, 200));
}

main().catch((e) => { console.error(e); process.exit(1); });
