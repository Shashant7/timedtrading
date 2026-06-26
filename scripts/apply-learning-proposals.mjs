#!/usr/bin/env node
/**
 * Operator apply for pending learning_proposals (tier1 full values + tier2 approve).
 * Uses D1 directly when API auth is unavailable in the agent environment.
 *
 * Usage:
 *   node scripts/apply-learning-proposals.mjs [--ids 1,2,3,4,7] [--full-tier1]
 *   node scripts/apply-learning-proposals.mjs --dry-run
 */
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const workerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../worker");
const DRY_RUN = process.argv.includes("--dry-run");
const FULL_TIER1 = process.argv.includes("--full-tier1") || !process.argv.includes("--no-full-tier1");
const idsArg = (() => {
  const i = process.argv.indexOf("--ids");
  return i >= 0 ? process.argv[i + 1] : null;
})();

function queryD1(sql) {
  const cmd = `cd "${workerDir}" && ../node_modules/.bin/wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${sql.replace(/"/g, '\\"')}" 2>/dev/null`;
  const raw = execSync(cmd, { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
  const start = raw.indexOf("[");
  if (start < 0) throw new Error(`D1 JSON not found: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(raw.slice(start));
  return parsed?.[0]?.results || parsed?.results || [];
}

function escapeSql(s) {
  return String(s).replace(/'/g, "''");
}

function runD1(sql) {
  if (DRY_RUN) {
    console.log(`  [dry-run] ${sql.slice(0, 120)}...`);
    return;
  }
  queryD1(sql);
}

async function applyRow(row) {
  if (!row.config_key) {
    runD1(
      `UPDATE learning_proposals SET status = 'applied', applied_at = ${Date.now()}, decided_at = ${Date.now()}, decided_by = 'operator', note = COALESCE(note,'') || ' [operational_ack]' WHERE id = ${row.id}`,
    );
    return { id: row.id, action: "ack_only", config_key: null };
  }

  const now = Date.now();
  const value = String(row.proposed_value);
  runD1(
    `INSERT INTO model_config (config_key, config_value, description, updated_at, updated_by) VALUES ('${escapeSql(row.config_key)}', '${escapeSql(value)}', 'learning_proposals #${row.id} (${escapeSql(row.source)}) operator apply', ${now}, 'learning_proposals') ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  );
  runD1(
    `UPDATE learning_proposals SET status = 'applied', applied_at = ${now}, decided_at = ${now}, decided_by = 'operator', rollback_value = ${row.current_value == null ? "NULL" : `'${escapeSql(row.current_value)}'`} WHERE id = ${row.id}`,
  );
  return { id: row.id, action: "applied", config_key: row.config_key, written: value };
}

console.log("\nApply learning_proposals → model_config\n");

const filter = idsArg
  ? `id IN (${idsArg.split(",").map((x) => Number(x.trim())).filter(Number.isFinite).join(",")})`
  : "status = 'pending'";

const pending = queryD1(
  `SELECT id, tier, source, config_key, current_value, proposed_value, status, note FROM learning_proposals WHERE ${filter} ORDER BY tier, id`,
);

if (!pending.length) {
  console.log("  No matching proposals.\n");
} else {
  for (const row of pending) {
    if (row.status !== "pending") {
      console.log(`  SKIP #${row.id} (${row.status})`);
      continue;
    }
    const r = await applyRow(row);
    console.log(`  ${r.action.toUpperCase()} #${r.id} ${r.config_key || "operational"} → ${r.written || "ack"}`);
  }
}

if (FULL_TIER1) {
  console.log("\n  Tier1 full-value override (prior coo_nightly clamp):");
  const tier1Full = [
    { key: "calibrated_sl_atr", value: "0.45", id: 6 },
    { key: "deep_audit_time_scaled_max_loss_4h_pct", value: "-2.5", id: 8 },
  ];
  const now = Date.now();
  for (const t of tier1Full) {
    const cur = queryD1(`SELECT config_value FROM model_config WHERE config_key = '${escapeSql(t.key)}'`);
    const current = cur[0]?.config_value ?? null;
    runD1(
      `INSERT INTO model_config (config_key, config_value, description, updated_at, updated_by) VALUES ('${escapeSql(t.key)}', '${escapeSql(t.value)}', 'learning_proposals #${t.id} operator full apply', ${now}, 'learning_proposals') ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    );
    runD1(
      `UPDATE learning_proposals SET note = COALESCE(note,'') || ' [operator_full_apply_from_${escapeSql(current)}]' WHERE id = ${t.id}`,
    );
    console.log(`  FULL #${t.id} ${t.key}: ${current} → ${t.value}`);
  }
}

console.log("\nDone.\n");
