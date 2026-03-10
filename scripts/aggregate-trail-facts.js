#!/usr/bin/env node
/**
 * aggregate-trail-facts.js — Aggregate timed_trail → trail_5m_facts in JS
 *
 * The worker's runDataLifecycle SQL aggregation hits D1's row-read limits
 * with large backfill datasets. This script reads timed_trail per ticker,
 * groups in JS, and batch-inserts into trail_5m_facts.
 *
 * Usage:
 *   node scripts/aggregate-trail-facts.js [--tickers SATS,J,OKE,...] [--all]
 */

const { execSync } = require("child_process");
const path = require("path");

const WORKER_DIR = path.join(__dirname, "../worker");
const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};
const ALL = args.includes("--all");
const TICKERS_CSV = getArg("tickers", null);

function d1Query(sql, retries = 3) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const raw = execSync(cmd, { maxBuffer: 100 * 1024 * 1024, encoding: "utf-8" });
      const lines = raw.split("\n").filter(l => !l.startsWith("npm warn"));
      const parsed = JSON.parse(lines.join("\n"));
      if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
      if (parsed?.results) return parsed.results;
      return [];
    } catch (e) {
      if (attempt < retries) { execSync("sleep 2"); continue; }
      console.error("D1 query failed:", e.message?.slice(0, 200));
      return [];
    }
  }
  return [];
}

function d1Exec(sql, retries = 3) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const raw = execSync(cmd, { maxBuffer: 100 * 1024 * 1024, encoding: "utf-8" });
      const lines = raw.split("\n").filter(l => !l.startsWith("npm warn"));
      const parsed = JSON.parse(lines.join("\n"));
      const meta = Array.isArray(parsed) ? parsed[0]?.meta : parsed?.meta;
      return { ok: true, changes: meta?.changes ?? 0 };
    } catch (e) {
      if (attempt < retries) { execSync("sleep 2"); continue; }
      return { ok: false, error: e.message?.slice(0, 200) };
    }
  }
  return { ok: false };
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║   Trail → 5m Facts Aggregation (JS)          ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  let tickers;
  if (ALL) {
    const rows = d1Query("SELECT DISTINCT ticker FROM timed_trail ORDER BY ticker");
    tickers = rows.map(r => r.ticker);
  } else if (TICKERS_CSV) {
    tickers = TICKERS_CSV.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
  } else {
    const rows = d1Query(
      `SELECT t.ticker, COUNT(*) as trail_rows FROM timed_trail t
       LEFT JOIN (SELECT DISTINCT ticker FROM trail_5m_facts) f ON t.ticker = f.ticker
       WHERE f.ticker IS NULL
       GROUP BY t.ticker ORDER BY trail_rows DESC`
    );
    tickers = rows.map(r => r.ticker);
    if (tickers.length === 0) {
      console.log("  No tickers need aggregation (all timed_trail tickers already in trail_5m_facts).");
      return;
    }
    console.log(`  Found ${tickers.length} tickers with trail data but no 5m facts.`);
  }

  console.log(`  Processing ${tickers.length} tickers: ${tickers.join(", ")}\n`);
  const startTime = Date.now();
  let totalInserted = 0;

  for (let ti = 0; ti < tickers.length; ti++) {
    const ticker = tickers[ti];
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    process.stdout.write(`  [${ti + 1}/${tickers.length}] ${ticker} (${elapsed}m)... `);

    // Read all trail rows for this ticker in chunks
    let allRows = [];
    let offset = 0;
    const CHUNK = 10000;
    while (true) {
      const rows = d1Query(
        `SELECT ts, price, htf_score, ltf_score, state, rank, completion, phase_pct, flags_json, kanban_stage
         FROM timed_trail WHERE ticker='${ticker}' ORDER BY ts LIMIT ${CHUNK} OFFSET ${offset}`
      );
      allRows = allRows.concat(rows);
      if (rows.length < CHUNK) break;
      offset += CHUNK;
    }

    if (allRows.length === 0) {
      console.log("no rows, skip");
      continue;
    }

    // Group into 5-minute buckets
    const buckets = new Map();
    for (const r of allRows) {
      const ts = Number(r.ts);
      const bucket = Math.floor(ts / 300000) * 300000;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(r);
    }

    // Build INSERT values
    const inserts = [];
    for (const [bucket, rows] of buckets) {
      const prices = rows.map(r => Number(r.price)).filter(Number.isFinite);
      const htfs = rows.map(r => Number(r.htf_score)).filter(Number.isFinite);
      const ltfs = rows.map(r => Number(r.ltf_score)).filter(Number.isFinite);
      const avg = arr => arr.length ? +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2) : 0;

      const firstRow = rows[0];
      const lastRow = rows[rows.length - 1];
      const flagsStr = rows.map(r => r.flags_json || "").join(" ");

      const sq = flagsStr.includes("squeeze_release") || flagsStr.includes("sq30_release") ? 1 : 0;
      const emaCross = flagsStr.includes("ema_cross") ? 1 : 0;
      const stFlip = flagsStr.includes("st_flip") ? 1 : 0;
      const moElite = flagsStr.includes("momentum_elite") ? 1 : 0;
      const flipWatch = flagsStr.includes("flip_watch") ? 1 : 0;

      // Extract last row's EMA regime and PDZ from flags_json
      let emaRegime = 0, pdzZone = "unknown", pdzPct = 50;
      try {
        const lastFlags = JSON.parse(lastRow.flags_json || "{}");
        if (lastFlags.ema_regime_D != null) emaRegime = Number(lastFlags.ema_regime_D) || 0;
        if (lastFlags.pdz_zone_D) pdzZone = lastFlags.pdz_zone_D;
        if (lastFlags.pdz_pct_D != null) pdzPct = Number(lastFlags.pdz_pct_D) || 50;
      } catch (_) {}

      const lastState = lastRow.state || "unknown";
      const maxRank = Math.max(...rows.map(r => Number(r.rank) || 0));
      const maxComp = Math.max(...rows.map(r => Number(r.completion) || 0));
      const maxPhase = Math.max(...rows.map(r => Number(r.phase_pct) || 0));
      const ksStart = firstRow.kanban_stage || "unknown";
      const ksEnd = lastRow.kanban_stage || "unknown";
      const ksChanged = ksStart !== ksEnd ? 1 : 0;

      const esc = (s) => String(s).replace(/'/g, "''");

      inserts.push(
        `('${ticker}',${bucket},${prices[0] || 0},${Math.max(...(prices.length ? prices : [0]))},${Math.min(...(prices.length ? prices : [0]))},${prices[prices.length - 1] || 0},` +
        `${avg(htfs)},${Math.min(...(htfs.length ? htfs : [0]))},${Math.max(...(htfs.length ? htfs : [0]))},` +
        `${avg(ltfs)},${Math.min(...(ltfs.length ? ltfs : [0]))},${Math.max(...(ltfs.length ? ltfs : [0]))},` +
        `'${esc(lastState)}',${maxRank},${maxComp},${maxPhase},` +
        `${sq},${emaCross},${stFlip},${moElite},${flipWatch},` +
        `${emaRegime},0,0,` +
        `'${esc(pdzZone)}',${pdzPct},0,0,0,0,` +
        `'${esc(ksStart)}','${esc(ksEnd)}',${ksChanged},` +
        `${rows.length},${Date.now()})`
      );
    }

    // Batch INSERT (D1 has a SQL length limit, chunk to ~50 rows per INSERT)
    const BATCH = 50;
    let inserted = 0;
    for (let i = 0; i < inserts.length; i += BATCH) {
      const chunk = inserts.slice(i, i + BATCH);
      const sql = `INSERT OR REPLACE INTO trail_5m_facts
        (ticker, bucket_ts, price_open, price_high, price_low, price_close,
         htf_score_avg, htf_score_min, htf_score_max,
         ltf_score_avg, ltf_score_min, ltf_score_max,
         state, rank, completion, phase_pct,
         had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite, had_flip_watch,
         ema_regime_D, had_ema_cross_5_48, had_ema_cross_13_21,
         pdz_zone, pdz_pct, fvg_bull_count, fvg_bear_count, liq_bs_count, liq_ss_count,
         kanban_stage_start, kanban_stage_end, kanban_changed,
         sample_count, created_at)
        VALUES ${chunk.join(",\n")}`;
      const res = d1Exec(sql);
      if (res.ok) inserted += res.changes;
    }

    // Clean up timed_trail for this ticker
    let deleted = 0;
    while (true) {
      const res = d1Exec(`DELETE FROM timed_trail WHERE rowid IN (SELECT rowid FROM timed_trail WHERE ticker='${ticker}' LIMIT 5000)`);
      deleted += res.changes || 0;
      if (!res.ok || (res.changes || 0) < 5000) break;
    }

    totalInserted += inserted;
    console.log(`${allRows.length} rows → ${buckets.size} buckets → ${inserted} facts (${deleted} trail cleaned)`);
  }

  const totalMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║   COMPLETE                                   ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`  Tickers: ${tickers.length}`);
  console.log(`  Facts inserted: ${totalInserted.toLocaleString()}`);
  console.log(`  Time: ${totalMin} minutes\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
