#!/usr/bin/env node
/**
 * scripts/phase-c-fetch-universe-candles.js
 *
 * Phase 1 prep — fetches D, W, M candles for every tradeable ticker in
 * data/phase-c-deep-dive/universe.json from the live worker's public
 * /timed/candles endpoint and caches each ticker as
 *   data/phase-c-deep-dive/candles/<TICKER>__<TF>.json
 *
 * Read-only against the live worker, idempotent, resumable. Skips a
 * ticker+tf pair if its cache file already exists and is non-empty
 * (delete the file to force re-fetch). Emits a manifest at the end.
 *
 * Notes on coverage as of 2026-05-08:
 *   D : limit=400 covers ~2025-06 → 2026-04 (full Phase C window)
 *   W : limit=200 covers ~2 years
 *   M : limit=200 covers up to ticker IPO; SNDK is short (post-spin-off)
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const UNIVERSE_PATH = path.join(ROOT, "data", "phase-c-deep-dive", "universe.json");
const CANDLE_DIR = path.join(ROOT, "data", "phase-c-deep-dive", "candles");
const MANIFEST = path.join(ROOT, "data", "phase-c-deep-dive", "candles-manifest.json");
const BASE = process.env.TIMED_HOST || "https://timed-trading-ingest.shashant.workers.dev";

const TFS = [
  { tf: "D", limit: 500 },
  { tf: "W", limit: 200 },
  { tf: "M", limit: 200 },
];

const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const RETRIES = 4;

async function fetchCandles(ticker, tf, limit) {
  const safeTicker = encodeURIComponent(ticker);
  const url = `${BASE}/timed/candles?ticker=${safeTicker}&tf=${tf}&limit=${limit}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 25_000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      const text = await res.text();
      if (!res.ok) {
        lastErr = `http_${res.status}: ${text.slice(0, 200)}`;
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("retry-after") || 4);
          await sleep(Math.max(2_000, retryAfter * 1000));
          continue;
        }
      } else {
        const json = JSON.parse(text);
        if (json?.ok && Array.isArray(json.candles)) {
          return { ok: true, candles: json.candles };
        }
        lastErr = `payload_${json?.error || "unknown"}`;
      }
    } catch (e) {
      lastErr = `exception_${String(e?.message || e).slice(0, 200)}`;
    }
    await sleep(2_000 * attempt);
  }
  return { ok: false, error: lastErr };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function safeFile(ticker) { return ticker.replace(/[^A-Za-z0-9.\-]/g, "_"); }

async function processOne(ticker, summary) {
  const result = { ticker };
  for (const { tf, limit } of TFS) {
    const fp = path.join(CANDLE_DIR, `${safeFile(ticker)}__${tf}.json`);
    if (fs.existsSync(fp) && fs.statSync(fp).size > 50) {
      try {
        const cached = JSON.parse(fs.readFileSync(fp, "utf8"));
        result[`${tf}_count`] = (cached?.candles || []).length;
        result[`${tf}_cached`] = true;
        continue;
      } catch {}
    }
    const got = await fetchCandles(ticker, tf, limit);
    if (got.ok) {
      fs.writeFileSync(fp, JSON.stringify({
        ticker,
        tf,
        fetched_at: Date.now(),
        candles: got.candles,
      }));
      result[`${tf}_count`] = got.candles.length;
      summary.fetched++;
    } else {
      result[`${tf}_error`] = got.error;
      summary.failed++;
    }
  }
  return result;
}

async function main() {
  fs.mkdirSync(CANDLE_DIR, { recursive: true });
  const universe = JSON.parse(fs.readFileSync(UNIVERSE_PATH, "utf8"));
  const targets = universe.tickers; // include watch-only (we want SPY/QQQ/IWM/VIXY for context)
  console.log(`[fetch] starting ${targets.length} tickers x ${TFS.length} tfs from ${BASE}`);

  const summary = { total: targets.length, fetched: 0, failed: 0 };
  const results = [];
  let cursor = 0;

  async function worker(id) {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) break;
      const ticker = targets[idx];
      const r = await processOne(ticker, summary);
      results.push(r);
      if ((idx + 1) % 25 === 0 || idx === targets.length - 1) {
        console.log(`[fetch] worker${id} idx=${idx + 1}/${targets.length} fetched=${summary.fetched} failed=${summary.failed} last=${ticker}`);
      }
      // gentle pacing — public endpoint rate limit is 20k/hr but we're polite
      await sleep(60);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const manifest = {
    generated_at: Date.now(),
    base: BASE,
    universe_size: targets.length,
    fetched: summary.fetched,
    failed: summary.failed,
    timeframes: TFS.map((x) => x.tf),
    tickers: results.sort((a, b) => a.ticker.localeCompare(b.ticker)),
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`[fetch] done. manifest=${MANIFEST}`);
}

main().catch((e) => {
  console.error("[fetch] fatal:", e);
  process.exit(1);
});
