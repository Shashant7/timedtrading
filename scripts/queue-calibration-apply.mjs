#!/usr/bin/env node
/**
 * Queue calibration / autopsy recommendations on the learning_proposals bus.
 * Idempotent: updates pending rows for the same source+config_key.
 *
 * Usage:
 *   node scripts/queue-calibration-apply.mjs [--dry-run]
 *   node scripts/queue-calibration-apply.mjs --report-id cal_1782508713652
 */
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const workerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../worker");
const DRY_RUN = process.argv.includes("--dry-run");
const reportIdArg = (() => {
  const i = process.argv.indexOf("--report-id");
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

function getConfig(key) {
  const rows = queryD1(`SELECT config_value FROM model_config WHERE config_key = '${key.replace(/'/g, "''")}'`);
  return rows[0]?.config_value ?? null;
}

/** @type {Array<{source:string, kind:string, config_key:string, proposed_value:string, tier:"tier1"|"tier2", note:string, skip_if?:()=>boolean}>} */
const QUEUE = [
  {
    source: "autopsy_live",
    kind: "config_change",
    config_key: "calibrated_sl_atr",
    proposed_value: "0.45",
    tier: "tier1",
    note: "Blend SL ATR 0.3 → 0.45 toward autopsy rec 0.53 (WFO OS negative — partial step only).",
    skip_if: () => {
      const cur = Number(getConfig("calibrated_sl_atr"));
      return Number.isFinite(cur) && cur >= 0.44;
    },
  },
  {
    source: "autopsy_live",
    kind: "config_change",
    config_key: "deep_audit_short_min_rank",
    proposed_value: "80",
    tier: "tier2",
    note: "Autopsy: restrict SHORT to rank>=80 (38 shorts, 47.4% WR). Current 55.",
    skip_if: () => Number(getConfig("deep_audit_short_min_rank")) >= 80,
  },
  {
    source: "autopsy_live",
    kind: "config_change",
    config_key: "deep_audit_time_scaled_max_loss_4h_pct",
    proposed_value: "-2.5",
    tier: "tier1",
    note: "Tighten 4h max-loss floor (autopsy HIGH rec). Current -2.0.",
    skip_if: () => Number(getConfig("deep_audit_time_scaled_max_loss_4h_pct")) <= -2.5,
  },
  {
    source: "edge_scorecard",
    kind: "config_change",
    config_key: "deep_audit_setup_demotion_TT Tt Ath Breakout_long",
    proposed_value: "blocked",
    tier: "tier2",
    note: "90d PF 0.69 / IWM 3-min SL today — approve pending proposal or re-queue.",
  },
  {
    source: "edge_scorecard",
    kind: "config_change",
    config_key: "deep_audit_setup_demotion_TT Tt N Test Support_long",
    proposed_value: "blocked",
    tier: "tier2",
    note: "90d PF 0.19 — high blast radius; GEV open on support bounce. Operator review.",
  },
];

function escapeSql(s) {
  return String(s).replace(/'/g, "''");
}

function upsertProposal(p, evidence) {
  const now = Date.now();
  const key = p.config_key;
  const current = getConfig(key);
  const evidenceJson = escapeSql(JSON.stringify(evidence));

  const existing = queryD1(
    `SELECT id FROM learning_proposals WHERE status = 'pending' AND source = '${escapeSql(p.source)}' AND config_key = '${escapeSql(key)}' ORDER BY created_at DESC LIMIT 1`,
  );
  if (existing.length) {
    const sql = `UPDATE learning_proposals SET proposed_value = '${escapeSql(p.proposed_value)}', evidence_json = '${evidenceJson}', tier = '${p.tier}', current_value = ${current == null ? "NULL" : `'${escapeSql(current)}'`}, created_at = ${now}, note = '${escapeSql(p.note)}' WHERE id = ${existing[0].id}`;
    if (DRY_RUN) {
      console.log(`  [dry-run] UPDATE #${existing[0].id} ${key}`);
      return { action: "updated", id: existing[0].id };
    }
    queryD1(sql);
    return { action: "updated", id: existing[0].id };
  }

  const sql = `INSERT INTO learning_proposals (created_at, source, kind, config_key, current_value, proposed_value, evidence_json, tier, status, note) VALUES (${now}, '${escapeSql(p.source)}', '${escapeSql(p.kind)}', '${escapeSql(key)}', ${current == null ? "NULL" : `'${escapeSql(current)}'`}, '${escapeSql(p.proposed_value)}', '${evidenceJson}', '${p.tier}', 'pending', '${escapeSql(p.note)}')`;
  if (DRY_RUN) {
    console.log(`  [dry-run] INSERT ${p.source} ${key}`);
    return { action: "inserted" };
  }
  queryD1(sql);
  return { action: "inserted" };
}

console.log("\nQueue calibration apply recommendations → learning_proposals\n");
if (reportIdArg) console.log(`  Report reference: ${reportIdArg}\n`);

const evidence = {
  report_id: reportIdArg || "cal_1782508713652",
  queued_at: new Date().toISOString(),
  scope: "live_diagnostic",
  hold: [
    "deep_audit_conviction_fusion_enabled",
    "deep_audit_bleeder_shield_enabled",
    "POST /timed/calibration/apply on diagnostic_only reports (WFO OS SQN negative)",
  ],
};

let queued = 0;
let skipped = 0;
for (const p of QUEUE) {
  if (p.skip_if?.()) {
    console.log(`  SKIP (already satisfied): ${p.config_key || p.note.slice(0, 48)}`);
    skipped++;
    continue;
  }
  const res = upsertProposal(p, { ...evidence, proposal: p.note });
  console.log(`  ${res.action.toUpperCase()} ${p.tier} ${p.config_key}: ${p.note.slice(0, 72)}`);
  queued++;
}

console.log(`\nDone. Queued/updated: ${queued}, skipped: ${skipped}${DRY_RUN ? " (dry-run)" : ""}\n`);
