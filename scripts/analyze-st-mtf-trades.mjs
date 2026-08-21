#!/usr/bin/env node
/**
 * Reconstruct SuperTrend at entry for closed ST + investor trades
 * across 10m / 30m / 1H / 4H / D / W / M plus synthesized 6.5H / 9H.
 *
 *   node scripts/analyze-st-mtf-trades.mjs
 *   node scripts/analyze-st-mtf-trades.mjs --skip-fetch
 *   node scripts/analyze-st-mtf-trades.mjs --limit-tickers=20
 *
 * Requires TIMED_API_KEY (or TIMED_TRADING_API_KEY). Caches candles under
 * data/st-mtf-review/cache/ (gitignored).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateStMtfReview,
  classifyTradeAcrossTfs,
  NATIVE_REVIEW_TFS,
  recommendStTreatment,
} from "../worker/st-mtf-review.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "data", "st-mtf-review");
const CACHE = path.join(OUT, "cache");
const BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const KEY = process.env.TIMED_API_KEY || process.env.TIMED_TRADING_API_KEY || "";

const args = process.argv.slice(2);
const SKIP_FETCH = args.includes("--skip-fetch");
const limitArg = args.find((a) => a.startsWith("--limit-tickers="));
const LIMIT_TICKERS = limitArg ? Number(limitArg.split("=")[1]) : 0;
const CONCURRENCY = 8;

const TF_LIMIT = { 10: 400, 30: 800, 60: 800, 240: 400, D: 400, W: 160, M: 80 };
const WARMUP_MS = {
  10: 3 * 86400000,
  30: 20 * 86400000,
  60: 40 * 86400000,
  240: 80 * 86400000,
  D: 220 * 86400000,
  W: 800 * 86400000,
  M: 2000 * 86400000,
};

function ensureDirs() {
  fs.mkdirSync(CACHE, { recursive: true });
}

function extractJsonArray(text, afterKey) {
  const key = `"${afterKey}"`;
  const keyAt = text.indexOf(key);
  if (keyAt < 0) return null;
  const start = text.indexOf("[", keyAt + key.length);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function d1Json(sql) {
  const wrangler = path.join(ROOT, "node_modules", ".bin", "wrangler");
  const out = execFileSync(
    wrangler,
    ["d1", "execute", "timed-trading-ledger", "--env", "production", "--remote", "--json", "--command", sql],
    { cwd: path.join(ROOT, "worker"), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const raw = extractJsonArray(out, "results");
  if (!raw) throw new Error(`D1 parse failed: ${out.slice(0, 240)}`);
  return JSON.parse(raw);
}

function loadTrades() {
  const p = path.join(OUT, "trades.json");
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  const rows = d1Json(
    `SELECT trade_id, ticker, direction, entry_ts, entry_price, exit_ts, exit_price,
            status, pnl, pnl_pct, setup_name, setup_grade, exit_reason
       FROM trades WHERE status IN ('WIN','LOSS') ORDER BY entry_ts`,
  );
  fs.writeFileSync(p, JSON.stringify(rows));
  return rows;
}

function loadInvestor() {
  const p = path.join(OUT, "investor.json");
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  const positions = d1Json(
    `SELECT id, ticker, status, avg_entry, first_entry_ts, last_entry_ts,
            closed_at, cost_basis, total_shares, investor_stage, peak_price
       FROM investor_positions WHERE status = 'CLOSED'`,
  );
  const lots = d1Json(
    `SELECT position_id, ticker, action, shares, price, value, ts, reason
       FROM investor_lots ORDER BY ts`,
  );
  const lotsByPos = new Map();
  for (const lot of lots) {
    const id = lot.position_id;
    if (!lotsByPos.has(id)) lotsByPos.set(id, []);
    lotsByPos.get(id).push(lot);
  }
  const closed = [];
  for (const pos of positions) {
    const posLots = lotsByPos.get(pos.id) || [];
    const sells = posLots.filter((l) => String(l.action).toUpperCase() === "SELL");
    const lastSell = sells[sells.length - 1];
    const entry = Number(pos.avg_entry);
    const exitPx = Number(lastSell?.price);
    const pnlPct = Number.isFinite(entry) && entry > 0 && Number.isFinite(exitPx)
      ? ((exitPx - entry) / entry) * 100
      : null;
    closed.push({
      trade_id: `inv-${pos.id}`,
      ticker: pos.ticker,
      direction: "LONG",
      entry_ts: Number(pos.first_entry_ts) || Number(posLots[0]?.ts),
      entry_price: entry,
      exit_ts: Number(pos.closed_at) || Number(lastSell?.ts),
      exit_price: exitPx,
      status: Number.isFinite(pnlPct) && pnlPct > 0 ? "WIN" : "LOSS",
      pnl_pct: pnlPct,
      setup_name: `Investor ${pos.investor_stage || "CLOSED"}`,
      book: "investor",
    });
  }
  fs.writeFileSync(p, JSON.stringify(closed));
  return closed;
}

async function fetchCandles(ticker, tf, asOfTs, limit) {
  const cacheKey = `${ticker}_${tf}_${asOfTs}_${limit}.json`;
  const cachePath = path.join(CACHE, cacheKey);
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  }
  const url = `${BASE}/timed/candles?ticker=${encodeURIComponent(ticker)}&tf=${encodeURIComponent(tf)}&limit=${limit}&asOfTs=${asOfTs}`;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, {
        headers: {
          "X-API-Key": KEY,
          "User-Agent": "Mozilla/5.0 (compatible; TimedTradingStMtfReview/1.0)",
        },
      });
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error(`candles ${ticker} ${tf} HTTP ${r.status}`);
        await new Promise((res) => setTimeout(res, 400 * (2 ** attempt)));
        continue;
      }
      if (!r.ok) throw new Error(`candles ${ticker} ${tf} HTTP ${r.status}`);
      const data = await r.json();
      const candles = data.candles || data.result?.candles || [];
      fs.writeFileSync(cachePath, JSON.stringify(candles));
      return candles;
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 400 * (2 ** attempt)));
    }
  }
  throw lastErr || new Error(`candles ${ticker} ${tf} failed`);
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

function tickerWindows(trades) {
  const map = new Map();
  for (const t of trades) {
    const tk = String(t.ticker || "").toUpperCase();
    if (!tk) continue;
    const entry = Number(t.entry_ts);
    const exit = Number(t.exit_ts) || entry;
    if (!map.has(tk)) map.set(tk, { ticker: tk, minEntry: entry, maxExit: exit });
    else {
      const row = map.get(tk);
      row.minEntry = Math.min(row.minEntry, entry);
      row.maxExit = Math.max(row.maxExit, exit);
    }
  }
  return [...map.values()];
}

async function loadCandlesForTicker(row) {
  const candles = {};
  for (const tf of NATIVE_REVIEW_TFS) {
    const asOf = row.maxExit + 2 * 86400000;
    const limit = TF_LIMIT[tf];
    try {
      let series = await fetchCandles(row.ticker, tf, asOf, limit);
      const needFrom = row.minEntry - (WARMUP_MS[tf] || 0);
      const oldest = series[0]?.ts;
      if (Number.isFinite(oldest) && oldest > needFrom && (tf === "10" || tf === "30")) {
        const extra = await fetchCandles(row.ticker, tf, oldest - 1, limit);
        series = [...extra, ...series];
      }
      candles[tf] = series;
    } catch (e) {
      console.warn(`  warn ${row.ticker} ${tf}: ${e.message}`);
      candles[tf] = [];
    }
  }
  return candles;
}

function fmtPct(x) {
  if (!Number.isFinite(x)) return "n/a";
  return `${(x * 100).toFixed(1)}%`;
}

function fmtRow(stat) {
  if (!stat) return "—";
  const lift = stat.lift_wr == null ? "" : ` lift ${stat.lift_wr >= 0 ? "+" : ""}${fmtPct(stat.lift_wr)}`;
  return `n=${stat.n} WR ${fmtPct(stat.wr)} avg ${stat.avg_pnl_pct.toFixed(2)}%${lift}`;
}

function renderReport(agg, recs, meta) {
  const lines = [];
  lines.push("# SuperTrend MTF review — closed book");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()}. ${meta.n_st} short-term closes + ${meta.n_inv} investor closes across ${meta.tickers} tickers.`);
  lines.push("");
  lines.push("Pine SuperTrend: `-1` bull / `+1` bear. Classes: hold, flip-retest, pierce-held, flip-extended (chase), sloping-agree, flat-no-test, against.");
  lines.push("");
  lines.push("## Baseline");
  lines.push("");
  lines.push(`- All: ${fmtRow(agg.baseline)}`);
  for (const [book, s] of Object.entries(agg.by_book)) {
    lines.push(`- ${book}: ${fmtRow(s)}`);
  }
  lines.push("");
  lines.push("## Composite features");
  lines.push("");
  lines.push("| Feature | Result |");
  lines.push("|---|---|");
  for (const [k, s] of Object.entries(agg.by_feature)) {
    lines.push(`| ${k} | ${fmtRow(s)} |`);
  }
  lines.push("");
  lines.push("## SuperTrend class by timeframe");
  lines.push("");
  lines.push("| TF | Class | Result |");
  lines.push("|---|---|---|");
  const keys = Object.keys(agg.by_tf_class).sort((a, b) => {
    const sa = agg.by_tf_class[a];
    const sb = agg.by_tf_class[b];
    return (sb.n - sa.n) || a.localeCompare(b);
  });
  for (const key of keys) {
    const s = agg.by_tf_class[key];
    if (s.n < 8) continue;
    const [tf, cls] = key.split("::");
    lines.push(`| ${tf} | ${cls} | ${fmtRow(s)} |`);
  }
  lines.push("");
  lines.push("## Setup mix");
  lines.push("");
  const setups = Object.entries(agg.by_setup).sort((a, b) => b[1].n - a[1].n);
  for (const [name, s] of setups.slice(0, 16)) {
    lines.push(`- ${name}: ${fmtRow(s)}`);
  }
  lines.push("");
  lines.push("## Recommended treatment");
  lines.push("");
  for (const r of recs) {
    lines.push(`- **${r.id}**: ${r.action}`);
  }
  lines.push("");
  return lines.join("\n");
}

(async () => {
  if (!KEY && !SKIP_FETCH) {
    console.error("TIMED_API_KEY required unless --skip-fetch");
    process.exit(1);
  }
  ensureDirs();
  const st = loadTrades().map((t) => ({ ...t, book: "st" }));
  const inv = loadInvestor();
  let trades = [...st, ...inv].filter((t) => Number.isFinite(Number(t.entry_ts)));
  let windows = tickerWindows(trades);
  if (LIMIT_TICKERS > 0) {
    const keep = new Set(windows.slice(0, LIMIT_TICKERS).map((w) => w.ticker));
    windows = windows.filter((w) => keep.has(w.ticker));
    trades = trades.filter((t) => keep.has(String(t.ticker).toUpperCase()));
  }
  console.log(`trades=${trades.length} tickers=${windows.length}`);

  const candleMap = {};
  if (!SKIP_FETCH) {
    let done = 0;
    await mapPool(windows, CONCURRENCY, async (row) => {
      candleMap[row.ticker] = await loadCandlesForTicker(row);
      done += 1;
      if (done % 10 === 0 || done === windows.length) {
        console.log(`  candles ${done}/${windows.length}`);
      }
    });
    fs.writeFileSync(path.join(OUT, "candles-index.json"), JSON.stringify(Object.keys(candleMap)));
  } else {
    for (const row of windows) {
      const candles = {};
      for (const tf of NATIVE_REVIEW_TFS) {
        const matches = fs.readdirSync(CACHE).filter((f) => f.startsWith(`${row.ticker}_${tf}_`));
        const merged = [];
        for (const f of matches) {
          merged.push(...JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8")));
        }
        merged.sort((a, b) => a.ts - b.ts);
        const seen = new Set();
        candles[tf] = merged.filter((b) => {
          if (seen.has(b.ts)) return false;
          seen.add(b.ts);
          return true;
        });
      }
      candleMap[row.ticker] = candles;
    }
  }

  const classified = [];
  for (const t of trades) {
    const tk = String(t.ticker).toUpperCase();
    classified.push(classifyTradeAcrossTfs(t, candleMap[tk] || {}));
  }
  const agg = aggregateStMtfReview(classified);
  const recs = recommendStTreatment(agg);
  const report = renderReport(agg, recs, {
    n_st: st.length,
    n_inv: inv.length,
    tickers: windows.length,
  });
  fs.writeFileSync(path.join(OUT, "classified.json"), JSON.stringify(classified));
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ agg, recs }, null, 2));
  fs.writeFileSync(path.join(OUT, "report.md"), report);
  fs.writeFileSync(path.join(ROOT, "tasks", "2026-08-21-st-mtf-review.md"), report);
  console.log(report);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
