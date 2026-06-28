#!/usr/bin/env node
/**
 * Push July v4 config — per-ticker index model, revert singles demotion.
 */
const DRY = process.argv.includes("--dry-run");
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";
const LIVE = process.env.LIVE_BASE || "https://timed-trading-ingest.shashant.workers.dev";

const UPDATES = [
  { key: "deep_audit_index_model_enabled", value: "true" },
  { key: "deep_audit_index_model_tickers", value: "SPY,QQQ,IWM" },
  // Revert global singles demotion — index-only blocks in code
  { key: "deep_audit_setup_demotion_enforce_paths", value: "tt_n_test_support,tt_range_reversal_long" },
  { key: "deep_audit_setup_demotion_index_only", value: "true" },
  { key: "deep_audit_setup_demotion_TT Support Bounce_long", value: "" },
  // Keep tape + cluster tuning that helped
  { key: "deep_audit_tape_capitulation_min_loss_pct", value: "-0.5" },
  { key: "deep_audit_tape_capitulation_skip_if_mfe_pct", value: "0.5" },
  { key: "deep_audit_tape_capitulation_skip_index_swing", value: "true" },
  { key: "deep_audit_earnings_cluster_gate_enabled", value: "true" },
  { key: "deep_audit_earnings_cluster_rank_bypass", value: "98" },
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
  console.log(`Pushing v4 config (${UPDATES.length} keys)...`);
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
