#!/usr/bin/env node
// scripts/conviction-sweep.js
// ─────────────────────────────────────────────────────────────────────────────
//  TRACK B — Conviction calibration sweep: "see WHERE conviction was wrong".
//
//  For each closed trade, reconstruct the conviction AT ENTRY (replay-score the
//  ticker as-of entry_ts on PRE-PROD, read computeConvictionScore's breakdown),
//  join to the realized outcome (pnl / win), and produce:
//    (1) a RELIABILITY TABLE  — WR + avg pnl by conviction decile/tier. This is
//        the direct answer to "where was conviction wrong": buckets that should
//        rise monotonically with conviction but don't (high-conviction losers /
//        low-conviction winners).
//    (2) PER-COMPONENT DISCRIMINATION — point-biserial corr of each component
//        (old liquidity/RS/history/… AND the new CIO edge / CTO targets / CRO
//        theme) vs win, so we can re-weight toward what actually separates.
//
//  Two phases:
//    --collect : pull closed trades (live D1, read-only) + fetch conviction
//                as-of entry_ts from the PRE-PROD endpoint
//                GET /timed/admin/conviction-asof?ticker=&asOf=  (TODO: add it +
//                backfill pre-prod candles for the traded tickers over the window).
//                Writes data/parity/2026-conviction-sweep.json.
//    --analyze : read that JSON and print the reliability table + discrimination
//                (this phase is fully runnable once the JSON exists).
//
//  Read-only on live; all replay on pre-prod. No live writes.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) { const k = a.slice(2); const n = process.argv[i + 1]; if (n && !n.startsWith("--")) { args[k] = n; i++; } else args[k] = true; }
}
const PRE = args.pre || process.env.PRE || "https://timed-trading-ingest-preprod.shashant.workers.dev";
const LIVE_DB = args.db || "timed-trading-ledger";
const KEY = process.env.TIMED_TRADING_API_KEY;
const OUT = args.out || "data/parity/2026-conviction-sweep.json";
// trade window (entry_ts >= since). Default: all closed trades (incl the promoted
// backtest — valid outcome data for calibration). Override with --since YYYY-MM-DD.
const sinceMs = args.since ? Date.parse(args.since + "T00:00:00Z") : 0;

function d1Query(db, sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", db, "--remote", "--json", "--command", sql],
    { encoding: "utf-8", maxBuffer: 128 * 1024 * 1024, env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_TOKEN } });
  return (JSON.parse(out.slice(out.indexOf("[")))[0] || {}).results || [];
}

async function collect() {
  if (!KEY) { console.error("TIMED_TRADING_API_KEY required"); process.exit(1); }
  const trades = d1Query(LIVE_DB,
    `SELECT trade_id,ticker,entry_ts,pnl,pnl_pct,(CASE WHEN pnl>0 THEN 1 ELSE 0 END) win FROM trades WHERE exit_ts IS NOT NULL AND pnl IS NOT NULL AND entry_ts>=${sinceMs} ORDER BY entry_ts`);
  console.log(`[collect] ${trades.length} closed trades`);
  const rows = [];
  let ok = 0, miss = 0;
  for (const t of trades) {
    // Conviction as-of entry — requires the pre-prod endpoint + backfilled candles.
    let conv = null;
    try {
      const r = await fetch(`${PRE}/timed/admin/conviction-asof?ticker=${encodeURIComponent(t.ticker)}&asOf=${t.entry_ts}&key=${KEY}`);
      const j = await r.json();
      if (j && j.ok && j.conviction != null) conv = { score: j.conviction, tier: j.tier, components: j.breakdown || {} };
    } catch (_) { /* endpoint not yet available */ }
    if (conv) ok++; else miss++;
    rows.push({ trade_id: t.trade_id, ticker: t.ticker, entry_ts: t.entry_ts, pnl: t.pnl, pnl_pct: t.pnl_pct, win: t.win, conviction: conv });
  }
  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), trades: rows }, null, 2));
  console.log(`[collect] wrote ${OUT} — conviction resolved ${ok}/${rows.length} (missing ${miss}: add /timed/admin/conviction-asof + backfill pre-prod candles)`);
}

// point-biserial correlation (continuous x vs binary y)
function pointBiserial(pairs) {
  const n = pairs.length; if (n < 8) return null;
  const ys = pairs.map((p) => p.y), xs = pairs.map((p) => p.x);
  const my = ys.reduce((s, v) => s + v, 0) / n;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const sx = Math.sqrt(xs.reduce((s, v) => s + (v - mx) ** 2, 0) / n);
  if (sx === 0) return 0;
  const cov = pairs.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / n;
  const sy = Math.sqrt(ys.reduce((s, v) => s + (v - my) ** 2, 0) / n);
  return sy === 0 ? 0 : +(cov / (sx * sy)).toFixed(3);
}

function analyze() {
  const { trades } = JSON.parse(readFileSync(OUT, "utf8"));
  const withC = trades.filter((t) => t.conviction && Number.isFinite(t.conviction.score));
  console.log(`[analyze] ${withC.length}/${trades.length} trades have conviction-at-entry`);
  if (withC.length < 20) { console.log("Not enough — run --collect with the as-of endpoint + backfill first."); return; }

  // (1) Reliability table — WR + avg pnl by conviction decile
  const sorted = [...withC].sort((a, b) => a.conviction.score - b.conviction.score);
  const D = 10, per = Math.ceil(sorted.length / D);
  console.log("\n=== RELIABILITY (where conviction was wrong) — by conviction decile ===");
  console.log("decile  conv_range      n   WR%   avgPnL$");
  for (let i = 0; i < D; i++) {
    const g = sorted.slice(i * per, (i + 1) * per); if (!g.length) continue;
    const wr = 100 * g.filter((t) => t.win).length / g.length;
    const avg = g.reduce((s, t) => s + (t.pnl || 0), 0) / g.length;
    const lo = g[0].conviction.score, hi = g[g.length - 1].conviction.score;
    console.log(`${String(i + 1).padStart(6)}  ${(lo + "-" + hi).padEnd(14)} ${String(g.length).padStart(3)}  ${wr.toFixed(0).padStart(4)}  ${avg.toFixed(1).padStart(8)}`);
  }
  const compositeCorr = pointBiserial(withC.map((t) => ({ x: t.conviction.score, y: t.win })));
  console.log(`composite conviction vs win: point-biserial r = ${compositeCorr} (target: clearly > 0 + monotone deciles)`);

  // (2) Per-component discrimination
  const comps = new Set();
  for (const t of withC) for (const k of Object.keys(t.conviction.components || {})) comps.add(k);
  console.log("\n=== PER-COMPONENT DISCRIMINATION (point-biserial vs win) ===");
  const ranked = [...comps].map((c) => {
    const pairs = withC
      .map((t) => { const v = t.conviction.components[c]; const x = (v && typeof v === "object") ? Number(v.pts) : Number(v); return Number.isFinite(x) ? { x, y: t.win } : null; })
      .filter(Boolean);
    return { c, r: pointBiserial(pairs), n: pairs.length };
  }).filter((x) => x.r != null).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  for (const x of ranked) console.log(`${x.c.padEnd(24)} r=${String(x.r).padStart(7)} (n=${x.n})  ${x.r > 0.05 ? "KEEP/UP" : x.r < -0.05 ? "INVERTED→drop/flip" : "noise→down"}`);
  console.log("\nNext: re-weight ∝ discrimination (logistic fit), re-calibrate A/B/C cuts to the new distribution, re-run --analyze, confirm monotone + r>0.");
}

(async () => {
  if (args.analyze) return analyze();
  if (args.collect) return collect();
  console.log("usage: --collect [--since YYYY-MM-DD] [--pre URL]  |  --analyze   (see header)");
})();
