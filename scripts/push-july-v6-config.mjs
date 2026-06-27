#!/usr/bin/env node
/**
 * Push July v6 config — v5 + AMZN unblacklist + lower focus floor for slice parity.
 */
const DRY = process.argv.includes("--dry-run");
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";
const LIVE = process.env.LIVE_BASE || "https://timed-trading-ingest.shashant.workers.dev";

// Keep learning-bus bans except tickers in the locked July 24-ticker universe.
const SLICE_BLACKLIST = "CVNA,ANET,AVGO,BA,AGYS,CSX,XLP,XLV,TSM,WTS";

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
  { key: "deep_audit_earnings_cluster_rank_bypass", value: "93" },
  { key: "deep_audit_earnings_cluster_min_tickers", value: "3" },
  { key: "deep_audit_earnings_cluster_high_rank_floor", value: "100" },
  { key: "deep_audit_earnings_cluster_high_rank_day_pad", value: "3" },
  { key: "deep_audit_doctrine_force_defer_bull_enabled", value: "true" },
  { key: "deep_audit_doctrine_force_defer_min_rank", value: "93" },
  { key: "deep_audit_doctrine_force_defer_max_loss_pct", value: "-2.0" },
  { key: "deep_audit_cohort_sector_etf_pause_enabled", value: "false" },
  { key: "deep_audit_ticker_blacklist", value: SLICE_BLACKLIST },
  { key: "deep_audit_focus_min_entry_conviction", value: "70" },
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
  console.log(`Pushing v6 config (${UPDATES.length} keys)...`);
  for (const u of UPDATES) console.log(`  ${u.key} = ${JSON.stringify(u.value)}`);
  if (DRY) return;
  const live = await pushConfig(LIVE, UPDATES);
  if (!live.ok) throw new Error(JSON.stringify(live));
  console.log("Production ok:", live);
  const { execSync } = await import("child_process");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  execSync(`node ${path.join(path.dirname(fileURLToPath(import.meta.url)), "sync-model-config-to-preprod.mjs")}`, {
    stdio: "inherit",
    env: process.env,
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
