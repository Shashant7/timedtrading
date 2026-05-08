#!/usr/bin/env node
/**
 * Phase 1.2 — Forensic data fetcher for Trend-Hold candidate tickers.
 *
 * Reads the 50 TH-candidate tickers from data/cohort-segmentation.json,
 * then for each ticker fetches and caches to disk:
 *   - 4H candles (tf=4H) via /timed/candles
 *   - Fundamentals via /timed/admin/fundamentals
 *   - (Daily candles already cached at data/universe-cache/<T>-D.json)
 *
 * Idempotent — skips tickers whose cache files already exist unless
 * --refresh is passed. Throttled at 5 req/sec to stay polite.
 *
 * Env: TIMED_TRADING_API_KEY (or TIMED_API_KEY) required for fundamentals.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/workspace';
const COHORT_JSON = path.join(ROOT, 'data/cohort-segmentation.json');
const CACHE_4H = path.join(ROOT, 'data/forensic/4h-candles');
const CACHE_FUND = path.join(ROOT, 'data/forensic/fundamentals');

const WORKER_BASE = 'https://timed-trading-ingest.shashant.workers.dev';
const API_KEY = process.env.TIMED_TRADING_API_KEY || process.env.TIMED_API_KEY;

const REFRESH = process.argv.includes('--refresh');
// TwelveData fundamentals (/statistics) are 50 credits per call. With
// 62 tickers we burn ~3100 credits — enough to hit standard-tier rate
// limits. Use a slower throttle (1.2s) so the worker's TD client doesn't
// trip the per-minute quota.
const MIN_INTERVAL_MS = process.argv.includes('--slow') ? 1200 : 200;

// Also include reference / counter-example tickers for context (user-named
// tickers that did NOT make the TH cohort — useful to anchor the deep dive).
const REFERENCE_TICKERS = ['AMD', 'AEHR', 'NVDA', 'AMZN', 'TSLA', 'NFLX', 'META', 'AVGO', 'PLTR', 'PANW', 'SPY', 'QQQ'];

// ---------------------------------------------------------------------------
let lastReq = 0;
async function throttle() {
  const now = Date.now();
  const wait = MIN_INTERVAL_MS - (now - lastReq);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastReq = Date.now();
}

async function httpGetJson(url, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    await throttle();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'phase-c-forensic/1.0' } });
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('Retry-After') || 0);
        const wait = Math.max(ra * 1000, 2000 * Math.pow(2, attempt));
        console.error(`  http ${res.status} retry in ${(wait/1000).toFixed(1)}s (${url.slice(0, 80)})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === retries - 1) throw e;
      const wait = 2000 * Math.pow(2, attempt);
      console.error(`  net err ${e.message} retry in ${(wait/1000).toFixed(1)}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error('exhausted retries');
}

// ---------------------------------------------------------------------------
function loadCandidates() {
  const j = JSON.parse(fs.readFileSync(COHORT_JSON, 'utf8'));
  const ths = j.rows.filter(r => r.trend_hold_candidate).map(r => r.ticker);
  return Array.from(new Set([...ths, ...REFERENCE_TICKERS])).sort();
}

async function fetch4H(ticker) {
  const out = path.join(CACHE_4H, `${ticker}-4H.json`);
  if (fs.existsSync(out) && !REFRESH) return { skipped: true };
  const url = `${WORKER_BASE}/timed/candles?ticker=${encodeURIComponent(ticker)}&tf=4H&limit=2500`;
  const j = await httpGetJson(url);
  if (!j.ok) return { error: j.error || 'no_ok' };
  const candles = (j.candles || []).slice().sort((a, b) => a.ts - b.ts);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ ticker, candles }, null, 0));
  return { written: candles.length };
}

async function fetchFundamentals(ticker) {
  const out = path.join(CACHE_FUND, `${ticker}.json`);
  if (fs.existsSync(out) && !REFRESH) return { skipped: true };
  if (!API_KEY) return { error: 'no_api_key' };
  // Bypass server-side cache so we don't get a stale api_error replay.
  const url = `${WORKER_BASE}/timed/admin/fundamentals?ticker=${encodeURIComponent(ticker)}&refresh=1&key=${encodeURIComponent(API_KEY)}`;
  const j = await httpGetJson(url);
  if (!j.ok) return { error: j.error || 'no_ok' };
  // Detect TD api_error to surface partial-payload failures so the caller
  // can retry instead of caching a sector-less payload as 'success'.
  const errs = j.errors || {};
  if (errs.profile === 'api_error' || errs.statistics === 'api_error' || errs.earnings === 'api_error') {
    return { error: `td_api_error: ${JSON.stringify(errs)}` };
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(j, null, 0));
  return { written: true };
}

async function main() {
  const tickers = loadCandidates();
  console.error(`[forensic-fetch] candidates=${tickers.length} (TH set + reference + counter-examples)`);
  console.error(tickers.join(', '));
  let f4 = { written: 0, skipped: 0, errors: 0 };
  let ff = { written: 0, skipped: 0, errors: 0 };

  for (let i = 0; i < tickers.length; i++) {
    const tk = tickers[i];
    try {
      const r1 = await fetch4H(tk);
      if (r1.error) { f4.errors++; console.error(`  4H ${tk} ERR: ${r1.error}`); }
      else if (r1.skipped) f4.skipped++;
      else { f4.written++; console.error(`  4H ${tk} ${r1.written} bars`); }
    } catch (e) { f4.errors++; console.error(`  4H ${tk} ${e.message}`); }

    try {
      const r2 = await fetchFundamentals(tk);
      if (r2.error) { ff.errors++; console.error(`  FN ${tk} ERR: ${r2.error}`); }
      else if (r2.skipped) ff.skipped++;
      else { ff.written++; console.error(`  FN ${tk} OK`); }
    } catch (e) { ff.errors++; console.error(`  FN ${tk} ${e.message}`); }

    if ((i + 1) % 10 === 0) {
      console.error(`  [${i + 1}/${tickers.length}] 4H written=${f4.written} skipped=${f4.skipped} err=${f4.errors} | FN written=${ff.written} skipped=${ff.skipped} err=${ff.errors}`);
    }
  }
  console.error('---');
  console.error(`4H : written=${f4.written}  skipped=${f4.skipped}  errors=${f4.errors}`);
  console.error(`FUN: written=${ff.written}  skipped=${ff.skipped}  errors=${ff.errors}`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
