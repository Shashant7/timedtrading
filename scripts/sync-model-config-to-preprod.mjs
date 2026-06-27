#!/usr/bin/env node
/**
 * Copy model_config rows from production → preprod via admin API.
 * Usage: node scripts/sync-model-config-to-preprod.mjs [--dry-run]
 */
const DRY = process.argv.includes("--dry-run");
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";
const LIVE = process.env.LIVE_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const PREPROD = process.env.PREPROD_BASE || "https://timed-trading-ingest-preprod.shashant.workers.dev";

async function fetchConfig(base, prefix = "") {
  const url = `${base}/timed/admin/model-config${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`;
  const res = await fetch(url, { headers: { "X-API-Key": API_KEY } });
  const data = await res.json();
  if (!data.ok) throw new Error(`${base} fetch failed: ${JSON.stringify(data)}`);
  return data.items || [];
}

async function pushConfig(base, updates) {
  if (!updates.length) return { written: 0 };
  const res = await fetch(`${base}/timed/admin/model-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify({ updates }),
  });
  return res.json();
}

const PREFIXES = ["deep_audit_", "calibrated_", "consensus_", "adaptive_", "ai_cio_", "tier_", "grade_", "lifecycle_"];

async function main() {
  const seen = new Map();
  for (const p of PREFIXES) {
    const items = await fetchConfig(LIVE, p);
    for (const it of items) seen.set(it.key, it);
  }
  const all = await fetchConfig(LIVE, "");
  for (const it of all) {
    if (!seen.has(it.key)) seen.set(it.key, it);
  }
  const updates = [...seen.values()].map((it) => ({
    key: it.key,
    value: it.value,
    description: `sync from production ${new Date().toISOString()}`,
  }));
  console.log(`\nSync ${updates.length} model_config keys: production → preprod\n`);
  if (DRY) {
    console.log(updates.slice(0, 10).map((u) => `  ${u.key}`).join("\n"));
    console.log(`  ... (${updates.length} total, dry-run)\n`);
    return;
  }
  const BATCH = 40;
  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const chunk = updates.slice(i, i + BATCH);
    const r = await pushConfig(PREPROD, chunk);
    if (!r.ok) throw new Error(`preprod push failed: ${JSON.stringify(r)}`);
    written += r.written || chunk.length;
    process.stdout.write(`  batch ${Math.floor(i / BATCH) + 1}: ${chunk.length} keys\r`);
  }
  console.log(`\nDone. Written ${written} keys to preprod.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
