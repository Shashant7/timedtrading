#!/usr/bin/env node
// scripts/sync-model-config-to-preprod.js
// ─────────────────────────────────────────────────────────────────────────────
//  Full model_config sync: LIVE -> PRE-PROD (read-only on live, writes ONLY to
//  preprod). Supersedes the partial hardcoded clone in clone-live-to-preprod.sh
//  now that GET /timed/admin/model-config exists (returns up to 500 rows with
//  raw_value, preserving exact serialization).
//
//  Faithful config parity matters: to compare live-vs-replay scores, pre-prod
//  must run with the SAME model_config as live.
//
//  Usage:
//    TIMED_TRADING_API_KEY=... node scripts/sync-model-config-to-preprod.js
//    (optional) LIVE_BASE=... PREPROD_BASE=... DRY_RUN=1 ...
//
//  SAFETY: never writes to live. The POST target is PREPROD_BASE only, whose
//  worker runs with ENVIRONMENT_LABEL=preprod and is fully isolated.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env.LIVE_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const PRE = process.env.PREPROD_BASE || "https://timed-trading-ingest-preprod.shashant.workers.dev";
const KEY = process.env.TIMED_TRADING_API_KEY || process.env.TIMED_API_KEY;
const DRY = process.env.DRY_RUN === "1";

if (!KEY) { console.error("ERROR: TIMED_TRADING_API_KEY (or TIMED_API_KEY) required"); process.exit(2); }
if (/preprod/i.test(LIVE)) { console.error("ERROR: LIVE_BASE looks like preprod — refusing"); process.exit(2); }
if (!/preprod/i.test(PRE)) { console.error("ERROR: PREPROD_BASE must be the preprod worker — refusing to write elsewhere"); process.exit(2); }

async function getJSON(url) {
  const r = await fetch(url, { headers: { "X-TT-Admin-Key": KEY } });
  const t = await r.text();
  try { return { http: r.status, body: JSON.parse(t) }; }
  catch { return { http: r.status, body: t }; }
}

async function main() {
  console.log(`Sync model_config:\n  live=${LIVE}\n  preprod=${PRE}${DRY ? "  (DRY RUN)" : ""}`);

  const live = await getJSON(`${LIVE}/timed/admin/model-config?key=${KEY}`);
  if (!live.body?.ok) { console.error("ERROR: live read failed:", live.http, live.body); process.exit(3); }
  const items = live.body.items || [];
  console.log(`  live keys: ${items.length}`);
  if (items.length >= 500) console.warn("  WARNING: hit the 500-row cap — some keys may be missing. Consider prefix-paged sync.");

  // Preserve exact serialization: send raw_value (the string live stored).
  const updates = items.map((it) => ({
    key: it.key,
    value: it.raw_value != null ? it.raw_value : it.value,
    description: it.description || `synced from live ${new Date().toISOString().slice(0, 10)}`,
  }));

  if (DRY) {
    console.log(`  DRY RUN — would write ${updates.length} keys to preprod. Sample:`);
    console.log("   ", updates.slice(0, 5).map((u) => u.key).join(", "), "...");
    return;
  }

  // Batch to keep request bodies modest.
  const BATCH = 100;
  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const slice = updates.slice(i, i + BATCH);
    const r = await fetch(`${PRE}/timed/admin/model-config?key=${KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-TT-Admin-Key": KEY },
      body: JSON.stringify({ updates: slice }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j?.ok) { console.error(`  batch ${i / BATCH} failed: HTTP ${r.status}`, j); process.exit(4); }
    written += j.written || slice.length;
    console.log(`  wrote ${written}/${updates.length}`);
  }

  // Verify on preprod.
  const pre = await getJSON(`${PRE}/timed/admin/model-config?key=${KEY}`);
  console.log(`  preprod now reports ${pre.body?.count} keys`);
  console.log("DONE — model_config synced live -> preprod (live untouched).");
}

main().catch((e) => { console.error(e); process.exit(1); });
