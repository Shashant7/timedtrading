#!/usr/bin/env node
/**
 * Historical scan: ETHUSD-like bounce stack.
 *
 * Template (ETHUSD Jul 2026):
 *   TD Sequential flashed 13 then 9 (bullish) on M / W / D / 4H,
 *   233 EMA reclaim on 4H or above,
 *   then at least mean-reverted or went higher.
 * Phase Leaving is annotated only — operator confirmed it was not a signal.
 *
 * Reconstructs TD / Saty phase / EMA233 from stored candles — same formulas
 * as worker/indicators.js (computeTDSequential, satyPhaseSeries, emaSeries).
 * Walks every bar; last-bar-only flags are useless for history.
 *
 * Usage:
 *   node scripts/scan-eth-td-phase-233.mjs --ticker ETHUSD
 *   node scripts/scan-eth-td-phase-233.mjs
 *   node scripts/scan-eth-td-phase-233.mjs --refresh-tickers
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "data", "eth-stack-scan");
const CACHE_DIR = join(OUT_DIR, "cache");

const BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const KEY = process.env.TIMED_API_KEY || process.env.TIMED_TRADING_API_KEY || "";
const UA = "Mozilla/5.0 (compatible; TimedTradingEthStackScan/1.0)";

const TFS = ["M", "W", "D", "240"];
const LIMITS = { M: 240, W: 500, D: 2000, 240: 2500 };
const TD13_THEN_9_WINDOW = 12;
const PHASE_LOOKBACK_BARS = { M: 6, W: 10, D: 25, 240: 40 };
/** ETH monthly never hit official −61.8 (June 2026 trough −33). Washout turn-up uses TF-scaled floors. */
const PHASE_WASH = { M: -20, W: -40, D: -50, 240: -50 };
const PHASE_TURN_LIFT = { M: 8, W: 10, D: 12, 240: 12 };
const RECLAIM_PAD_MS = 25 * 86400000;
const CLUSTER_DEDUP_MS = 25 * 86400000;
const OUTCOME_DAYS = [5, 10, 20, 60];

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return fallback;
}
const ONLY = (flag("ticker") || "").toUpperCase();
const CONCURRENCY = Number(flag("concurrency") || 6);
const REFRESH_TICKERS = args.includes("--refresh-tickers");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Same as worker/indicators.js emaSeries — SMA seed, NaN until warm. */
function emaSeries(closes, period) {
  const out = new Array(closes.length).fill(NaN);
  if (!closes || closes.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  out[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    out[i] = closes[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function rmaSeries(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const alpha = 1 / period;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += (Number.isFinite(values[i]) ? values[i] : 0);
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    const v = Number.isFinite(values[i]) ? values[i] : 0;
    out[i] = alpha * v + (1 - alpha) * out[i - 1];
  }
  return out;
}

function trSeries(bars) {
  const out = new Array(bars.length).fill(NaN);
  if (!bars.length) return out;
  out[0] = bars[0].h - bars[0].l;
  for (let i = 1; i < bars.length; i++) {
    const hl = bars[i].h - bars[i].l;
    const hc = Math.abs(bars[i].h - bars[i - 1].c);
    const lc = Math.abs(bars[i].l - bars[i - 1].c);
    out[i] = Math.max(hl, hc, lc);
  }
  return out;
}

function atrSeries(bars, period = 14) {
  return rmaSeries(trSeries(bars), period);
}

/** Same as satyPhaseSeries in indicators.js — returns the osc array. */
function satyPhaseOsc(bars, closes) {
  const e21 = emaSeries(closes, 21);
  const atr = atrSeries(bars, 14);
  const raw = closes.map((c, i) => {
    if (Number.isFinite(e21[i]) && Number.isFinite(atr[i]) && atr[i] > 0) {
      return ((c - e21[i]) / (3.0 * atr[i])) * 100.0;
    }
    return NaN;
  });
  return emaSeries(raw.map((v) => (Number.isFinite(v) ? v : 0)), 3);
}

function barMs(c) {
  const raw = c.ts ?? c.time ?? c.t;
  if (raw != null && Number.isFinite(Number(raw))) {
    const n = Number(raw);
    return n < 1e12 ? n * 1000 : n;
  }
  if (c.date) {
    const s = String(c.date);
    return Date.parse(s.length <= 10 ? `${s}T00:00:00Z` : s);
  }
  return 0;
}

/**
 * Walk computeTDSequential state and emit every TD9 (prep==9) and TD13
 * (leadup==13). Lead-up: starts at 1 on prep completion, increments when
 * close < low[2] (bull) / close > high[2] (bear), persists otherwise.
 */
function walkTdEvents(bars) {
  const PREP_LEN = 9;
  const PREP_COMP = 4;
  const LEADUP_LEN = 13;
  const LEADUP_COMP = 2;
  const events = [];
  if (!bars || bars.length < PREP_COMP + PREP_LEN) return events;

  let bullPrep = 0;
  let bearPrep = 0;
  let bullLead = 0;
  let bearLead = 0;

  for (let i = PREP_COMP; i < bars.length; i++) {
    const c = bars[i].c;
    const cComp = bars[i - PREP_COMP].c;
    bullPrep = c < cComp ? bullPrep + 1 : 0;
    bearPrep = c > cComp ? bearPrep + 1 : 0;

    if (i >= LEADUP_COMP) {
      const lowComp = bars[i - LEADUP_COMP].l;
      const highComp = bars[i - LEADUP_COMP].h;
      if (bearPrep === PREP_LEN) bullLead = 0;
      else if (bullPrep === PREP_LEN) bullLead = 1;
      else if (bullLead > 0 && c < lowComp) bullLead += 1;

      if (bullPrep === PREP_LEN) bearLead = 0;
      else if (bearPrep === PREP_LEN) bearLead = 1;
      else if (bearLead > 0 && c > highComp) bearLead += 1;
    }

    if (bullPrep === PREP_LEN) events.push({ i, t: bars[i].t, side: "bull", kind: 9 });
    if (bearPrep === PREP_LEN) events.push({ i, t: bars[i].t, side: "bear", kind: 9 });
    if (bullLead === LEADUP_LEN) events.push({ i, t: bars[i].t, side: "bull", kind: 13 });
    if (bearLead === LEADUP_LEN) events.push({ i, t: bars[i].t, side: "bear", kind: 13 });
  }
  return events;
}

function pairs13Then9(events, side = "bull", windowBars = TD13_THEN_9_WINDOW) {
  const thirteens = events.filter((e) => e.side === side && e.kind === 13);
  const nines = events.filter((e) => e.side === side && e.kind === 9);
  const pairs = [];
  for (const n of nines) {
    const prior = thirteens.filter((x) => x.i < n.i && n.i - x.i <= windowBars);
    if (prior.length) pairs.push({ nine: n, thirteen: prior[prior.length - 1] });
  }
  return pairs;
}

function walkPhaseLeaves(osc, times) {
  const leaves = [];
  for (let i = 1; i < osc.length; i++) {
    const p = osc[i - 1];
    const c = osc[i];
    if (!Number.isFinite(p) || !Number.isFinite(c)) continue;
    if (p <= -100 && c > -100) leaves.push({ i, t: times[i], type: "extDn", osc: c });
    if (p <= -61.8 && c > -61.8) leaves.push({ i, t: times[i], type: "accum", osc: c });
    if (p >= 100 && c < 100) leaves.push({ i, t: times[i], type: "extUp", osc: c });
    if (p >= 61.8 && c < 61.8) leaves.push({ i, t: times[i], type: "distrib", osc: c });
  }
  return leaves;
}

function walk233Reclaim(closes, times) {
  const ema = emaSeries(closes, 233);
  const events = [];
  for (let i = 1; i < closes.length; i++) {
    if (!Number.isFinite(ema[i]) || !Number.isFinite(ema[i - 1])) continue;
    if (closes[i - 1] < ema[i - 1] && closes[i] >= ema[i]) {
      events.push({ i, t: times[i], ema: ema[i], close: closes[i] });
    }
  }
  return { ema, events };
}

function parseCandles(raw) {
  const rows = Array.isArray(raw)
    ? raw
    : (raw?.candles || raw?.result?.candles || raw?.data || []);
  return rows
    .map((c) => ({
      t: barMs(c),
      o: Number(c.open ?? c.o),
      h: Number(c.high ?? c.h),
      l: Number(c.low ?? c.l),
      c: Number(c.close ?? c.c),
    }))
    .filter((c) => c.t > 0 && Number.isFinite(c.c) && Number.isFinite(c.h) && Number.isFinite(c.l))
    .sort((a, b) => a.t - b.t);
}

async function fetchCandles(ticker, tf) {
  const cache = join(CACHE_DIR, `${ticker}_${tf}.json`);
  if (existsSync(cache)) {
    try { return parseCandles(JSON.parse(readFileSync(cache, "utf8"))); }
    catch { /* refetch */ }
  }
  const limit = LIMITS[tf] || 800;
  const url = `${BASE}/timed/candles?ticker=${encodeURIComponent(ticker)}&tf=${tf}&limit=${limit}`;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "X-API-Key": KEY, "User-Agent": UA } });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${ticker} ${tf} HTTP ${res.status}`);
        await sleep(400 * (2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`${ticker} ${tf} HTTP ${res.status}`);
      const json = await res.json();
      const bars = parseCandles(json);
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cache, JSON.stringify(json));
      return bars;
    } catch (e) {
      lastErr = e;
      await sleep(400 * (2 ** attempt));
    }
  }
  throw lastErr || new Error(`${ticker} ${tf} failed`);
}

function analyzeTf(bars) {
  if (!bars.length) {
    return { n: 0, td: [], pairs: [], leaves: [], reclaim: [], ema21: [], times: [], closes: [] };
  }
  const closes = bars.map((b) => b.c);
  const times = bars.map((b) => b.t);
  const td = walkTdEvents(bars);
  const osc = satyPhaseOsc(bars, closes);
  const { events: reclaim } = walk233Reclaim(closes, times);
  return {
    n: bars.length,
    first: times[0],
    last: times[times.length - 1],
    td,
    pairs: pairs13Then9(td, "bull"),
    leaves: walkPhaseLeaves(osc, times),
    reclaim,
    ema21: emaSeries(closes, 21),
    times,
    closes,
    osc,
  };
}

function nearestBar(times, t) {
  let best = -1;
  let bestAbs = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(times[i] - t);
    if (d < bestAbs) { bestAbs = d; best = i; }
  }
  return best;
}

function leavesNear(tfA, t) {
  const padBars = PHASE_LOOKBACK_BARS[tfA.tf] || 20;
  const idx = nearestBar(tfA.times, t);
  if (idx < 0) return [];
  return tfA.leaves.filter((L) => {
    if (L.type !== "extDn" && L.type !== "accum") return false;
    return Math.abs(L.i - idx) <= padBars;
  });
}

/** Official oversold leave, or osc trough below a TF washout floor then a lift. */
function phaseTurnNear(tfA, t) {
  const official = leavesNear(tfA, t);
  const pad = PHASE_LOOKBACK_BARS[tfA.tf] || 20;
  const idx = nearestBar(tfA.times, t);
  if (idx < 0) {
    return { official, turned: false, types: [], trough: null, at: null };
  }
  const lo = Math.max(0, idx - pad);
  const troughHi = Math.min((tfA.osc || []).length - 1, idx + 1);
  const liftHi = Math.min((tfA.osc || []).length - 1, idx + pad);
  let minV = Infinity;
  let minI = -1;
  for (let i = lo; i <= troughHi; i++) {
    const v = tfA.osc[i];
    if (Number.isFinite(v) && v < minV) { minV = v; minI = i; }
  }
  let lifted = false;
  const wash = PHASE_WASH[tfA.tf] ?? -50;
  const liftNeed = PHASE_TURN_LIFT[tfA.tf] ?? 10;
  if (minI >= 0 && minV <= wash) {
    let maxAfter = -Infinity;
    for (let i = minI + 1; i <= liftHi; i++) {
      if (Number.isFinite(tfA.osc[i]) && tfA.osc[i] > maxAfter) maxAfter = tfA.osc[i];
    }
    lifted = Number.isFinite(maxAfter) && (maxAfter - minV) >= liftNeed;
  }
  const types = official.length
    ? [...new Set(official.map((x) => x.type))]
    : (lifted ? ["turn"] : []);
  const at = official.length
    ? iso(official[official.length - 1].t)
    : (lifted ? iso(tfA.times[Math.min(liftHi, minI + 1)]) : null);
  return {
    official,
    turned: official.length > 0 || lifted,
    types,
    trough: minI >= 0 && Number.isFinite(minV) ? { at: iso(tfA.times[minI]), osc: +minV.toFixed(2) } : null,
    at,
  };
}

function reclaimNear(tfA, t) {
  return tfA.reclaim.filter((r) => Math.abs(r.t - t) <= RECLAIM_PAD_MS);
}

function outcomeFromDaily(dA, signalT) {
  const idx = nearestBar(dA.times, signalT);
  if (idx < 0 || !dA.closes[idx]) return null;
  const px = dA.closes[idx];
  const out = { signalDate: new Date(dA.times[idx]).toISOString().slice(0, 10), signalPx: px };
  for (const days of OUTCOME_DAYS) {
    const j = Math.min(dA.closes.length - 1, idx + days);
    const fwd = dA.closes[j];
    const slice = dA.closes.slice(idx + 1, j + 1);
    const mfe = slice.length ? Math.max(...slice) : px;
    const mae = slice.length ? Math.min(...slice) : px;
    out[`ret${days}d`] = (fwd / px - 1) * 100;
    out[`mfe${days}d`] = (mfe / px - 1) * 100;
    out[`mae${days}d`] = (mae / px - 1) * 100;
  }
  const slice60 = dA.closes.slice(idx + 1, Math.min(dA.closes.length, idx + 61));
  const laterMax = slice60.length ? Math.max(...slice60) : px;
  const laterLast20 = dA.closes[Math.min(dA.closes.length - 1, idx + 20)];
  const wentHigher = laterMax > px * 1.01 || (laterLast20 != null && laterLast20 > px);
  const e21 = dA.ema21[idx];
  let meanReverted = false;
  if (Number.isFinite(e21) && px < e21) {
    const gap = e21 - px;
    for (let k = idx + 1; k <= Math.min(dA.closes.length - 1, idx + 20); k++) {
      const e = dA.ema21[k];
      if (!Number.isFinite(e)) continue;
      if (dA.closes[k] >= e) { meanReverted = true; break; }
      if (gap > 0 && (e - dA.closes[k]) / gap <= 0.5) { meanReverted = true; break; }
    }
  }
  out.wentHigher = wentHigher;
  out.meanReverted = meanReverted;
  out.success = wentHigher || meanReverted;
  out.barsAfter = dA.closes.length - 1 - idx;
  return out;
}

function iso(t) { return t ? new Date(t).toISOString().slice(0, 10) : null; }

function scanTicker(ticker, series) {
  const byTf = {};
  for (const tf of TFS) {
    byTf[tf] = { tf, ...analyzeTf(series[tf] || []) };
  }
  const dA = byTf.D;

  const anchors = [];
  for (const tf of TFS) {
    for (const p of byTf[tf].pairs) {
      anchors.push({ tf, t: p.nine.t, pair: p });
    }
  }
  anchors.sort((a, b) => a.t - b.t);

  const clusters = [];
  for (const a of anchors) {
    if (clusters.some((c) => Math.abs(c.t - a.t) < CLUSTER_DEDUP_MS)) continue;

    const tdHit = {};
    for (const tf of TFS) {
      const near = byTf[tf].pairs.filter((p) => Math.abs(p.nine.t - a.t) <= RECLAIM_PAD_MS);
      if (near.length) tdHit[tf] = { thirteen: iso(near[0].thirteen.t), nine: iso(near[0].nine.t) };
    }

    const phaseHit = {};
    const phaseTurn = {};
    for (const tf of TFS) {
      const near = leavesNear(byTf[tf], a.t);
      if (near.length) {
        const types = [...new Set(near.map((x) => x.type))];
        phaseHit[tf] = { types, at: iso(near[near.length - 1].t) };
      }
      const turn = phaseTurnNear(byTf[tf], a.t);
      if (turn.turned) {
        phaseTurn[tf] = { types: turn.types, at: turn.at, trough: turn.trough };
      }
    }

    const reclaimHit = {};
    for (const tf of ["240", "D", "W", "M"]) {
      const near = reclaimNear(byTf[tf], a.t);
      if (near.length) reclaimHit[tf] = { at: iso(near[0].t), close: near[0].close };
    }

    const tdTfs = Object.keys(tdHit);
    const phaseTfs = Object.keys(phaseHit);
    const turnTfs = Object.keys(phaseTurn);
    const reclaim4hPlus = ["240", "D", "W", "M"].filter((tf) => reclaimHit[tf]);

    const hasTd13Then9 = tdTfs.length > 0;
    const hasReclaim = reclaim4hPlus.length > 0;
    const tdMonthly = !!tdHit.M;
    const tdWeekly = !!tdHit.W;
    const tdHigher = tdMonthly || tdWeekly;
    if (!hasTd13Then9 || !hasReclaim) continue;

    // Phase Leaving is context, not a gate (operator 2026-08-21).
    let tier = "ltf";
    if (tdMonthly) tier = "monthly";
    else if (tdWeekly) tier = "weekly";

    const latestReclaim = Math.max(0, ...Object.values(reclaimHit).map((p) => Date.parse(`${p.at}T00:00:00Z`) || 0));
    const signalT = Math.max(a.t, latestReclaim);
    const oc = outcomeFromDaily(dA, signalT);

    clusters.push({
      ticker,
      tier,
      t: a.t,
      anchorTf: a.tf,
      td9: iso(a.t),
      td13: iso(a.pair.thirteen.t),
      signalDate: oc?.signalDate || iso(signalT),
      tdHit,
      phaseHit,
      phaseTurn,
      reclaimHit,
      tdTfs,
      tdHigher,
      phaseTfs,
      turnTfs,
      reclaimTfs: reclaim4hPlus,
      outcome: oc,
    });
  }

  return {
    ticker,
    coverage: Object.fromEntries(TFS.map((tf) => [tf, {
      n: byTf[tf].n,
      first: iso(byTf[tf].first),
      last: iso(byTf[tf].last),
      td9bull: byTf[tf].td.filter((e) => e.side === "bull" && e.kind === 9).length,
      td13bull: byTf[tf].td.filter((e) => e.side === "bull" && e.kind === 13).length,
      pairs: byTf[tf].pairs.length,
      phaseBullLeaves: byTf[tf].leaves.filter((l) => l.type === "extDn" || l.type === "accum").length,
      reclaim233: byTf[tf].reclaim.length,
    }])),
    tdEvents: ONLY === ticker ? Object.fromEntries(TFS.map((tf) => [tf, byTf[tf].td.map((e) => ({
      date: iso(e.t), side: e.side, kind: e.kind,
    }))])) : undefined,
    clusters,
  };
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = { error: String(e?.message || e), ticker: items[idx] }; }
      await sleep(40);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
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

function loadTickersFromKv() {
  const wrangler = join(ROOT, "node_modules", ".bin", "wrangler");
  const out = execFileSync(
    wrangler,
    ["kv", "key", "get", "--binding=KV_TIMED", "--env", "production", "--remote", "--text", "timed:tickers"],
    { cwd: join(ROOT, "worker"), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  const list = JSON.parse(out);
  return [...new Set((Array.isArray(list) ? list : []).map((t) => String(t).toUpperCase()).filter(Boolean))].sort();
}

function loadTickers() {
  const p = join(OUT_DIR, "tickers.json");
  if (!REFRESH_TICKERS && existsSync(p)) {
    return JSON.parse(readFileSync(p, "utf8"));
  }
  const list = loadTickersFromKv();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(p, JSON.stringify(list, null, 2));
  return list;
}

function summarize(results) {
  const ok = results.filter((r) => r && !r.error);
  const allClusters = ok.flatMap((r) => r.clusters || []);
  const byTier = {};
  for (const c of allClusters) {
    byTier[c.tier] = byTier[c.tier] || [];
    byTier[c.tier].push(c);
  }
  const names = (arr) => [...new Set(arr.map((c) => c.ticker))].sort();
  const hitRate = (arr) => {
    const scored = arr.filter((c) => c.outcome && c.outcome.barsAfter >= 10);
    const win = scored.filter((c) => c.outcome.success);
    return {
      setups: arr.length,
      names: names(arr).length,
      scored: scored.length,
      success: win.length,
      pct: scored.length ? +(100 * win.length / scored.length).toFixed(1) : null,
      wentHigher: scored.filter((c) => c.outcome.wentHigher).length,
      meanReverted: scored.filter((c) => c.outcome.meanReverted).length,
      avgRet20: scored.length ? +(scored.reduce((s, c) => s + (c.outcome.ret20d || 0), 0) / scored.length).toFixed(2) : null,
      avgMfe20: scored.length ? +(scored.reduce((s, c) => s + (c.outcome.mfe20d || 0), 0) / scored.length).toFixed(2) : null,
      avgRet60: scored.length ? +(scored.reduce((s, c) => s + (c.outcome.ret60d || 0), 0) / scored.length).toFixed(2) : null,
      ret20Up: scored.filter((c) => (c.outcome.ret20d || 0) > 0).length,
      ret60Up: scored.filter((c) => (c.outcome.ret60d || 0) > 0).length,
      mfe20ge5: scored.filter((c) => (c.outcome.mfe20d || 0) >= 5).length,
    };
  };

  const htf = [...(byTier.monthly || []), ...(byTier.weekly || [])];
  const uniqueBest = [];
  const seen = new Set();
  for (const tier of ["monthly", "weekly", "ltf"]) {
    for (const c of (byTier[tier] || [])) {
      if (seen.has(c.ticker)) continue;
      seen.add(c.ticker);
      uniqueBest.push(c);
    }
  }

  return {
    tickersScanned: ok.length,
    errors: results.filter((r) => r?.error).length,
    clusters: allClusters.length,
    uniqueNamesAny: names(allClusters).length,
    uniqueNamesHtf: names(htf).length,
    byTier: {
      monthly: hitRate(byTier.monthly || []),
      weekly: hitRate(byTier.weekly || []),
      htf: hitRate(htf),
      ltf: hitRate(byTier.ltf || []),
      any: hitRate(allClusters),
    },
    uniqueBestHit: hitRate(uniqueBest),
    names: {
      monthly: names(byTier.monthly || []),
      weekly: names(byTier.weekly || []),
      htf: names(htf),
      ltf: names(byTier.ltf || []),
      any: names(allClusters),
    },
  };
}

function mdReport(summary, results) {
  const ok = results.filter((r) => r && !r.error);
  const eth = ok.find((r) => r.ticker === "ETHUSD");
  const all = ok.flatMap((r) => r.clusters || []).sort((a, b) =>
    String(a.signalDate).localeCompare(String(b.signalDate)) || a.ticker.localeCompare(b.ticker)
  );
  const htf = all.filter((c) => c.tier === "monthly" || c.tier === "weekly");
  const monthly = all.filter((c) => c.tier === "monthly");
  const weekly = all.filter((c) => c.tier === "weekly");
  const lines = [];
  const row = (c) => {
    const o = c.outcome || {};
    return `| ${c.ticker} | ${c.signalDate} | ${c.tier} | ${c.tdTfs.join(",")} | ${c.td13} → ${c.td9} | ${c.reclaimTfs.join(",")} | ${o.ret20d != null ? o.ret20d.toFixed(1) + "%" : "—"} | ${o.mfe20d != null ? o.mfe20d.toFixed(1) + "%" : "—"} | ${o.ret60d != null ? o.ret60d.toFixed(1) + "%" : "—"} |`;
  };

  lines.push("# ETHUSD-like TD 13→9 + 233 reclaim");
  lines.push("");
  lines.push(`Scanned **${summary.tickersScanned}** tickers over stored D / W / M / 4H candles.`);
  lines.push("");
  lines.push("## What was required");
  lines.push("");
  lines.push("Same reconstruction as scoring (`computeTDSequential`, EMA 233), walked every bar:");
  lines.push("");
  lines.push("- **TD 13 then 9** (bullish Sequential) on Monthly, Weekly, Daily, or 4H — prep-9 after lead-up-13, within 12 bars on that TF.");
  lines.push("- **233 reclaim** on 4H or above (4H / D / W; monthly 233 is almost never computable).");
  lines.push("- **Outcome** from the daily close at the later of TD9 and the 233 reclaim: closed-higher +20d / +60d is the honest bar. “Went higher or mean-reverted” is kept only as a loose check.");
  lines.push("");
  lines.push("**Phase Leaving is not a signal.** Operator confirmed 2026-08-21. Official Saty leave (`extDn` −100 / `accum` −61.8) never printed on ETH monthly (June 2026 trough −33). It is stored as context only and does not gate or clock the stack.");
  lines.push("");
  lines.push("| Tier | Meaning |");
  lines.push("|---|---|");
  lines.push("| **monthly** | TD13→9 on Monthly + 233 on 4H+ |");
  lines.push("| **weekly** | TD13→9 on Weekly (no monthly pair in-window) + 233 on 4H+ |");
  lines.push("| **ltf** | TD13→9 only on Daily or 4H + 233 on 4H+ |");
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  const m = summary.byTier.monthly;
  const w = summary.byTier.weekly;
  const h = summary.byTier.htf;
  const a = summary.byTier.any;
  lines.push(`- **Monthly TD13→9 + 233 (ETH July template):** ${m.names} names / ${m.setups} setups. Closed higher +20d **${m.ret20Up}/${m.scored}**, +60d **${m.ret60Up}/${m.scored}**. Avg +20d ${m.avgRet20}%, +60d ${m.avgRet60}%.`);
  lines.push(`- **Weekly TD13→9 + 233:** ${w.names} names / ${w.setups} setups. Closed higher +20d **${w.ret20Up}/${w.scored}**, +60d **${w.ret60Up}/${w.scored}**. Avg +20d ${w.avgRet20}%, +60d ${w.avgRet60}%.`);
  lines.push(`- **HTF (monthly or weekly) + 233:** ${h.names} names / ${h.setups} setups. Closed higher +20d **${h.ret20Up}/${h.scored}**, +60d **${h.ret60Up}/${h.scored}**. Avg +20d ${h.avgRet20}%, +60d ${h.avgRet60}%.`);
  lines.push(`- **Any TF TD13→9 + 233:** ${a.names} names / ${a.setups} setups. Closed higher +20d **${a.ret20Up}/${a.scored}**, +60d **${a.ret60Up}/${a.scored}**. Avg +20d ${a.avgRet20}%, +60d ${a.avgRet60}%.`);
  lines.push("");
  if (eth) {
    lines.push("## ETHUSD sanity");
    lines.push("");
    lines.push("Coverage: " + TFS.map((tf) => `${tf} ${eth.coverage[tf].n} bars ${eth.coverage[tf].first}→${eth.coverage[tf].last}`).join("; ") + ".");
    lines.push("");
    lines.push("| Date | Tier | TD TFs | TD13 → TD9 | 233 | +20d | +60d |");
    lines.push("|---|---|---|---|---|---:|---:|");
    for (const c of eth.clusters) {
      const o = c.outcome || {};
      lines.push(`| ${c.signalDate} | ${c.tier} | ${c.tdTfs.join(",")} | ${c.td13} → ${c.td9} | ${c.reclaimTfs.join(",")} | ${o.ret20d != null ? o.ret20d.toFixed(1) + "%" : "—"} | ${o.ret60d != null ? o.ret60d.toFixed(1) + "%" : "—"} |`);
    }
    lines.push("");
  }
  lines.push("## Monthly TD13→9 + 233");
  lines.push("");
  if (!monthly.length) {
    lines.push("_none_");
  } else {
    lines.push("| Ticker | Date | Tier | TD | TD13 → TD9 | 233 | +20d | MFE20 | +60d |");
    lines.push("|---|---|---|---|---|---|---:|---:|---:|");
    for (const c of monthly) lines.push(row(c));
  }
  lines.push("");
  lines.push("## Weekly TD13→9 + 233");
  lines.push("");
  if (!weekly.length) {
    lines.push("_none_");
  } else {
    lines.push("| Ticker | Date | Tier | TD | TD13 → TD9 | 233 | +20d | MFE20 | +60d |");
    lines.push("|---|---|---|---|---|---|---:|---:|---:|");
    for (const c of weekly) lines.push(row(c));
  }
  lines.push("");
  lines.push("## Names — monthly");
  lines.push("");
  lines.push(summary.names.monthly.length ? summary.names.monthly.join(", ") : "_none_");
  lines.push("");
  lines.push("## Names — HTF (monthly or weekly)");
  lines.push("");
  lines.push(summary.names.htf.length ? summary.names.htf.join(", ") : "_none_");
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  lines.push("- 4H history starts ~Aug 2024 for most names (ETHUSD 4H from Aug 2025). Monthly 233 is not in the data.");
  lines.push("- Daily store starts 2022 for most equity names; weekly ~2019; monthly much longer.");
  lines.push("- Phase Leaving is annotated in the raw dump only. It does not admit or reject a stack.");
  lines.push("- Forward returns use daily closes after the later of TD9 and the 233 reclaim. Crypto / vol ETFs / equity are mixed in the averages.");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  if (!KEY) {
    console.error("TIMED_API_KEY / TIMED_TRADING_API_KEY required");
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  let tickers = loadTickers();
  if (ONLY) tickers = tickers.includes(ONLY) ? [ONLY] : [ONLY];
  console.log(`scan ${tickers.length} tickers  concurrency=${CONCURRENCY}`);

  const results = await mapPool(tickers, CONCURRENCY, async (ticker, idx) => {
    const series = {};
    for (const tf of TFS) {
      series[tf] = await fetchCandles(ticker, tf);
    }
    const r = scanTicker(ticker, series);
    if ((idx + 1) % 10 === 0 || ticker === "ETHUSD" || ONLY) {
      console.log(`  ${idx + 1}/${tickers.length} ${ticker} clusters=${r.clusters.length}`);
    }
    return r;
  });

  const summary = summarize(results);
  writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify({ summary, results }, null, 2));
  writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  const md = mdReport(summary, results);
  writeFileSync(join(OUT_DIR, "report.md"), md);
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n" + md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
