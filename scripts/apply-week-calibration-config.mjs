#!/usr/bin/env node
/**
 * Apply week-calibration model_config keys to production D1.
 * Idempotent INSERT OR REPLACE per key.
 */
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const workerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../worker");

const CONFIG = {
  deep_audit_repeat_churn_guard_enabled: "true",
  deep_audit_repeat_churn_guard_include_tickers: JSON.stringify(["GRNY", "PH", "CRDO", "MOD", "GRNJ"]),
  deep_audit_repeat_churn_guard_global: "true",
  deep_audit_repeat_churn_max_same_day_sl: "2",
  deep_audit_repeat_churn_cooldown_hours: "8",
  deep_audit_range_reversal_block_adverse_phase: "true",
  deep_audit_ath_breakout_confirm_gate_enabled: "true",
  deep_audit_ath_breakout_min_confirm_minutes: "5",
  deep_audit_ath_breakout_min_confirm_count: "3",
  deep_audit_pullback_low_liquidity_cap_enabled: "true",
  deep_audit_pullback_low_liquidity_min_avg_vol: "500000",
  deep_audit_pullback_low_liquidity_max_notional_pct_adv: "0.001",
  deep_audit_pullback_low_liquidity_max_notional_floor: "2500",
};

function run(sql) {
  const cmd = `cd "${workerDir}" && ../node_modules/.bin/wrangler d1 execute --env production timed-trading-ledger --remote --command "${sql.replace(/"/g, '\\"')}"`;
  execSync(cmd, { stdio: "inherit" });
}

console.log("\nApplying week-calibration model_config keys...\n");
for (const [key, value] of Object.entries(CONFIG)) {
  const sql = `INSERT OR REPLACE INTO model_config (config_key, config_value, updated_at) VALUES ('${key}', '${value.replace(/'/g, "''")}', ${Date.now()})`;
  console.log(`  ${key} = ${value}`);
  run(sql);
}
console.log("\nDone.\n");
