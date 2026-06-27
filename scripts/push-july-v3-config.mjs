#!/usr/bin/env node
/**
 * Push July v3 model_config bundle (index model + improvement gates) to prod,
 * then sync to preprod.
 *
 * Usage: TIMED_API_KEY=... node scripts/push-july-v3-config.mjs [--dry-run]
 */
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const DRY = process.argv.includes("--dry-run");
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";
const LIVE = process.env.LIVE_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const PREPROD = process.env.PREPROD_BASE || "https://timed-trading-ingest-preprod.shashant.workers.dev";

/** @type {Array<{key:string, value:string, note?:string}>} */
const UPDATES = [
  { key: "deep_audit_index_model_enabled", value: "true", note: "Dedicated index entry model" },
  { key: "deep_audit_index_model_tickers", value: "SPY,QQQ,IWM" },
  { key: "deep_audit_index_model_min_rank", value: "95" },
  { key: "deep_audit_index_model_rvol_min", value: "1.0" },
  { key: "deep_audit_index_model_pct_above_e48_min", value: "1.5" },
  { key: "deep_audit_index_model_pct_above_e48_max", value: "4.5" },
  { key: "deep_audit_index_model_e21_slope_min", value: "0.4" },
  { key: "deep_audit_index_model_e21_slope_max", value: "2.0" },
  { key: "deep_audit_index_model_require_m30_reclaim", value: "true" },
  { key: "deep_audit_index_model_pullback_state_only", value: "true" },
  { key: "deep_audit_index_etf_swing_enabled", value: "false", note: "Legacy swing bypass off" },
  { key: "deep_audit_setup_demotion_enforce_paths", value: "tt_n_test_support,tt_range_reversal_long" },
  { key: "deep_audit_setup_demotion_TT Support Bounce_long", value: "blocked" },
  { key: "deep_audit_earnings_cluster_gate_enabled", value: "true" },
  { key: "deep_audit_earnings_cluster_min_tickers", value: "4" },
  { key: "deep_audit_earnings_cluster_rank_bypass", value: "97" },
  { key: "deep_audit_earnings_cluster_day_pad", value: "1" },
  { key: "deep_audit_tape_capitulation_min_loss_pct", value: "-0.5" },
  { key: "deep_audit_tape_capitulation_skip_if_mfe_pct", value: "0.5" },
  { key: "deep_audit_tape_capitulation_skip_index_swing", value: "true" },
];

async function pushConfig(base, updates) {
  const res = await fetch(`${base}/timed/admin/model-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify({ updates: updates.map((u) => ({ key: u.key, value: u.value })) }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${base} push failed: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  console.log(`Pushing ${UPDATES.length} config keys to ${LIVE}${DRY ? " (dry-run)" : ""}...`);
  for (const u of UPDATES) {
    console.log(`  ${u.key} = ${u.value}${u.note ? ` // ${u.note}` : ""}`);
  }
  if (DRY) return;
  const live = await pushConfig(LIVE, UPDATES);
  console.log("Production:", live);
  console.log("Syncing to preprod...");
  execSync(`node ${path.join(path.dirname(fileURLToPath(import.meta.url)), "sync-model-config-to-preprod.mjs")}`, {
    stdio: "inherit",
    env: { ...process.env, TIMED_API_KEY: API_KEY, LIVE_BASE: LIVE, PREPROD_BASE: PREPROD },
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
