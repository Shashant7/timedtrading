#!/usr/bin/env node
/**
 * Seed pre-prod model_config from the frozen Phase C anchor snapshot
 * (`phase-c-slice-2025-07-v1` backtest_run_config on production D1).
 *
 * The anchor used Phase-A package keys (144 at run time), NOT today's 455+
 * deep_audit_* prod sync. Pushing only 21 deep_audit knobs (v6/v12) cannot
 * restore anchor admission — this script replays the full frozen snapshot plus
 * explicit guard keys that cancel known post-anchor index ETF overrides.
 *
 * Usage:
 *   TIMED_API_KEY=... node scripts/seed-phase-a-anchor-config.mjs [--dry-run]
 *   [--snapshot=path/to/frozen_config.json]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const DRY = process.argv.includes("--dry-run");
const snapArg = process.argv.find((a) => a.startsWith("--snapshot="));
const SNAPSHOT = snapArg
  ? path.resolve(REPO, snapArg.split("=").slice(1).join("="))
  : path.join(REPO, "data/trade-analysis/phase-c-slice-2025-07-v1/frozen_config.json");

const API_KEY = process.env.TIMED_API_KEY || process.env.TIMED_TRADING_API_KEY || "";
const LIVE = process.env.LIVE_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const PREPROD = process.env.PREPROD_BASE || "https://timed-trading-ingest-preprod.shashant.workers.dev";

/** Keys added after anchor that unlock index churn — force OFF on pre-prod. */
const POST_ANCHOR_GUARDS = [
  { key: "deep_audit_index_model_enabled", value: "false", note: "no dedicated index model" },
  { key: "deep_audit_index_etf_swing_enabled", value: "false", note: "v2 unlock revert" },
  { key: "deep_audit_pullback_min_bearish_count_index_etf", value: "", note: "unset override → default 2" },
  { key: "deep_audit_pullback_non_prime_min_rank_index_etf", value: "", note: "unset override → default 90" },
  { key: "deep_audit_pullback_min_bearish_count_index_etf_tickers", value: "", note: "unset T6 CSV" },
];

async function fetchRunConfig(runId, base) {
  const url = `${base}/timed/admin/runs/config?run_id=${encodeURIComponent(runId)}&key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) throw new Error(`fetch ${runId} @ ${base}: ${JSON.stringify(data)}`);
  return data.config || {};
}

async function pushConfig(base, updates) {
  if (!updates.length) return { written: 0 };
  const BATCH = 40;
  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const chunk = updates.slice(i, i + BATCH);
    const res = await fetch(`${base}/timed/admin/model-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
      body: JSON.stringify({
        updates: chunk.map((u) => ({
          key: u.key,
          value: u.value,
          description: u.description || u.note || "phase-a anchor seed",
        })),
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`push failed: ${JSON.stringify(data)}`);
    written += data.written || chunk.length;
  }
  return { written };
}

async function loadSnapshotConfig() {
  if (fs.existsSync(SNAPSHOT)) {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
    const cfg = raw.config || raw;
    console.log(`Loaded snapshot: ${SNAPSHOT} (${Object.keys(cfg).length} keys)`);
    return cfg;
  }
  console.log(`Snapshot missing; fetching phase-c-slice-2025-07-v1 from ${LIVE}...`);
  const cfg = await fetchRunConfig("phase-c-slice-2025-07-v1", LIVE);
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, JSON.stringify({ run_id: "phase-c-slice-2025-07-v1", config: cfg }, null, 2));
  console.log(`Wrote ${SNAPSHOT}`);
  return cfg;
}

async function main() {
  if (!API_KEY) {
    console.error("TIMED_API_KEY required");
    process.exit(1);
  }

  const anchorCfg = await loadSnapshotConfig();
  const merged = new Map(Object.entries(anchorCfg).map(([k, v]) => [k, String(v ?? "")]));
  for (const g of POST_ANCHOR_GUARDS) merged.set(g.key, g.value);

  const updates = [...merged.entries()].map(([key, value]) => ({
    key,
    value,
    description: `phase-a anchor seed ${new Date().toISOString()}`,
  }));

  console.log(`\nSeeding pre-prod with ${updates.length} keys (${Object.keys(anchorCfg).length} anchor + ${POST_ANCHOR_GUARDS.length} guards)\n`);
  for (const g of POST_ANCHOR_GUARDS) console.log(`  GUARD ${g.key} = ${JSON.stringify(g.value)}  // ${g.note}`);
  if (DRY) {
    console.log(`\n(dry-run; first 10 keys: ${updates.slice(0, 10).map((u) => u.key).join(", ")}...)\n`);
    return;
  }

  const r = await pushConfig(PREPROD, updates);
  console.log(`\nPre-prod ok: written=${r.written}\n`);
  console.log("NOTE: pre-prod may still carry deep_audit_* keys NOT in the anchor snapshot.");
  console.log("      Worker-side index stock-path block (v12) is required for full parity.");
  console.log("      Run calibration-diff-anchor.mjs after seeding to inspect overlap.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
