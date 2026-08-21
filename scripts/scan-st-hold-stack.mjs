#!/usr/bin/env node
/**
 * Historical SuperTrend test-and-hold scan (M / W / D / 4H) plus a
 * TSLA this-week autopsy.
 *
 * Same SuperTrend(10,3) and detectSupertrendHoldFromSeries as scoring.
 * Walks every bar (the live detector is last-bar + 12-bar lookback).
 *
 *   node scripts/scan-st-hold-stack.mjs --ticker TSLA
 *   node scripts/scan-st-hold-stack.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectSupertrendHoldFromSeries } from "../worker/supertrend-hold.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "data", "st-hold-scan");
const CACHE_DIR = join(OUT_DIR, "cache");
const TICKERS_FALLBACK = join(ROOT, "data", "eth-stack-scan", "tickers.json");

const BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const KEY = process.env.TIMED_API_KEY || process.env.TIMED_TRADING_API_KEY || "";
const UA = "Mozilla/5.0 (compatible; TimedTradingStHoldScan/1.0)";

const TFS = ["M", "W", "D", "240"];
const LIMITS = { M: 240, W: 500, D: 2000, 240: 2500 };
const LOOKBACK = 12;
const CLUSTER_MS = 25 * 86400000;
const STACK_MS = 40 * 86400000;
const OUTCOME_DAYS = [5, 10, 20, 60];

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return fallback;
}
const ONLY = (flag("ticker") || "").toUpperCase();
const CONCURRENCY = Number(flag("concurrency") || 6);
const WEEK_START = Date.parse("2026-08-17T00:00:00Z");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function iso(t) { return t ? new Date(t).toISOString().slice(0, 10) : null; }

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

function atrSeries(bars, period = 14) {
  const tr = new Array(bars.length).fill(NaN);
  if (!bars.length) return tr;
  tr[0] = bars[0].h - bars[0].l;
  for (let i = 1; i < bars.length; i++) {
    tr[i] = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c),
    );
  }
  return rmaSeries(tr, period);
}

/** Same as worker/indicators.js superTrendSeries(factor=3, atrLen=10). */
function superTrendSeries(bars, factor = 3.0, atrLen = 10) {
  const n = bars.length;
  const line = new Array(n).fill(NaN);
  const dir = new Array(n).fill(0);
  const atr = atrSeries(bars, atrLen);
  const upperBand = new Array(n).fill(NaN);
  const lowerBand = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(atr[i])) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    upperBand[i] = hl2 + factor * atr[i];
    lowerBand[i] = hl2 - factor * atr[i];
  }
  const firstValid = atrLen;
  if (firstValid >= n) return { line, dir, atr };
  dir[firstValid] = -1;
  line[firstValid] = lowerBand[firstValid];
  for (let i = firstValid + 1; i < n; i++) {
    if (!Number.isFinite(upperBand[i]) || !Number.isFinite(lowerBand[i])) {
      dir[i] = dir[i - 1];
      line[i] = line[i - 1];
      continue;
    }
    if (Number.isFinite(lowerBand[i - 1]) && lowerBand[i] < lowerBand[i - 1] && bars[i - 1].c > lowerBand[i - 1]) {
      lowerBand[i] = lowerBand[i - 1];
    }
    if (Number.isFinite(upperBand[i - 1]) && upperBand[i] > upperBand[i - 1] && bars[i - 1].c < upperBand[i - 1]) {
      upperBand[i] = upperBand[i - 1];
    }
    const prevDir = dir[i - 1];
    if (prevDir === -1) {
      if (bars[i].c < lowerBand[i]) { dir[i] = 1; line[i] = upperBand[i]; }
      else { dir[i] = -1; line[i] = lowerBand[i]; }
    } else if (bars[i].c > upperBand[i]) {
      dir[i] = -1;
      line[i] = lowerBand[i];
    } else {
      dir[i] = 1;
      line[i] = upperBand[i];
    }
  }
  return { line, dir, atr };
}

function parseCandles(raw) {
  const rows = Array.isArray(raw) ? raw : (raw?.candles || raw?.result?.candles || []);
  return rows
    .map((c) => ({
      t: Number(c.ts ?? c.time ?? 0),
      o: Number(c.open ?? c.o),
      h: Number(c.high ?? c.h),
      l: Number(c.low ?? c.l),
      c: Number(c.close ?? c.c),
    }))
    .filter((c) => c.t > 0 && Number.isFinite(c.c))
    .sort((a, b) => a.t - b.t);
}

async function fetchCandles(ticker, tf) {
  const cache = join(CACHE_DIR, `${ticker}_${tf}.json`);
  const fallback = join(ROOT, "data", "eth-stack-scan", "cache", `${ticker}_${tf}.json`);
  for (const p of [cache, fallback]) {
    if (existsSync(p)) {
      try { return parseCandles(JSON.parse(readFileSync(p, "utf8"))); }
      catch { /* next */ }
    }
  }
  const url = `${BASE}/timed/candles?ticker=${encodeURIComponent(ticker)}&tf=${tf}&limit=${LIMITS[tf] || 800}`;
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
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cache, JSON.stringify(json));
      return parseCandles(json);
    } catch (e) {
      lastErr = e;
      await sleep(400 * (2 ** attempt));
    }
  }
  throw lastErr || new Error(`${ticker} ${tf} failed`);
}

function analyzeTf(bars) {
  if (bars.length < 20) {
    return { n: 0, events: [], last: null, rows: [] };
  }
  const closes = bars.map((b) => b.c);
  const ema21 = emaSeries(closes, 21);
  const atr14 = atrSeries(bars, 14);
  const st = superTrendSeries(bars, 3.0, 10);
  const events = [];
  let prevHeld = false;
  for (let i = 20; i < bars.length; i++) {
    const hit = detectSupertrendHoldFromSeries({
      bars: bars.slice(0, i + 1),
      stDir: st.dir.slice(0, i + 1),
      stLine: st.line.slice(0, i + 1),
      ema21: ema21.slice(0, i + 1),
      atr: atr14[i],
      lookback: LOOKBACK,
    });
    const held = !!(hit && hit.held);
    if (held && !prevHeld) {
      events.push({
        i,
        t: bars[i].t,
        kind: hit.kind,
        side: hit.sideLabel,
        quality: hit.quality,
        line: hit.stLine,
        close: bars[i].c,
        flat: hit.recentlyFlat,
      });
    }
    prevHeld = held;
  }
  const n = bars.length - 1;
  const lastHit = detectSupertrendHoldFromSeries({
    bars, stDir: st.dir, stLine: st.line, ema21, atr: atr14[n], lookback: LOOKBACK,
  });
  const rows = bars.map((b, i) => ({
    t: b.t,
    o: b.o, h: b.h, l: b.l, c: b.c,
    st: st.line[i],
    dir: st.dir[i],
    atr: atr14[i],
    e21: ema21[i],
    distAtr: Number.isFinite(atr14[i]) && atr14[i] > 0 && Number.isFinite(st.line[i])
      ? (b.l - st.line[i]) / atr14[i]
      : null,
  }));
  return {
    n: bars.length,
    first: bars[0].t,
    last: bars[n].t,
    events,
    lastHit,
    rows,
    lastRow: rows[n],
  };
}

function outcomeFromDaily(dRows, signalT) {
  if (!dRows?.length) return null;
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < dRows.length; i++) {
    const d = Math.abs(dRows[i].t - signalT);
    if (d < best) { best = d; idx = i; }
  }
  const px = dRows[idx].c;
  const out = { signalDate: iso(dRows[idx].t), signalPx: px };
  for (const days of OUTCOME_DAYS) {
    const j = Math.min(dRows.length - 1, idx + days);
    const slice = dRows.slice(idx + 1, j + 1).map((r) => r.c);
    const fwd = dRows[j].c;
    const mfe = slice.length ? Math.max(...slice) : px;
    out[`ret${days}d`] = (fwd / px - 1) * 100;
    out[`mfe${days}d`] = (mfe / px - 1) * 100;
  }
  const slice60 = dRows.slice(idx + 1, Math.min(dRows.length, idx + 61)).map((r) => r.c);
  const laterMax = slice60.length ? Math.max(...slice60) : px;
  out.wentHigher = laterMax > px * 1.01;
  out.barsAfter = dRows.length - 1 - idx;
  return out;
}

function scanTicker(ticker, series) {
  const byTf = {};
  for (const tf of TFS) byTf[tf] = { tf, ...analyzeTf(series[tf] || []) };
  const dRows = byTf.D.rows || [];

  const anchors = [];
  for (const tf of TFS) {
    for (const e of byTf[tf].events) anchors.push({ tf, ...e });
  }
  anchors.sort((a, b) => a.t - b.t);

  const stacks = [];
  for (const a of anchors) {
    if (stacks.some((s) => Math.abs(s.t - a.t) < CLUSTER_MS)) continue;
    const hit = {};
    for (const tf of TFS) {
      const near = byTf[tf].events.filter((e) => Math.abs(e.t - a.t) <= STACK_MS && e.side === a.side);
      if (near.length) hit[tf] = near[near.length - 1];
    }
    const tfs = Object.keys(hit);
    let tier = null;
    if (tfs.length === 4) tier = "all4";
    else if (hit.M && hit.W && (hit.D || hit["240"])) tier = "htf";
    else if (tfs.length >= 3) tier = "three";
    else continue;
    const signalT = Math.max(...tfs.map((tf) => hit[tf].t));
    stacks.push({
      ticker,
      tier,
      t: a.t,
      side: a.side,
      signalDate: iso(signalT),
      tfs,
      hits: Object.fromEntries(tfs.map((tf) => [tf, {
        date: iso(hit[tf].t), kind: hit[tf].kind, quality: hit[tf].quality, line: hit[tf].line,
      }])),
      outcome: outcomeFromDaily(dRows, signalT),
    });
  }

  return {
    ticker,
    coverage: Object.fromEntries(TFS.map((tf) => [tf, {
      n: byTf[tf].n,
      first: iso(byTf[tf].first),
      last: iso(byTf[tf].last),
      holds: byTf[tf].events.length,
      lastHit: byTf[tf].lastHit,
      lastRow: byTf[tf].lastRow ? {
        date: iso(byTf[tf].lastRow.t),
        c: byTf[tf].lastRow.c,
        st: byTf[tf].lastRow.st,
        dir: byTf[tf].lastRow.dir,
        distAtr: byTf[tf].lastRow.distAtr,
      } : null,
    }])),
    events: Object.fromEntries(TFS.map((tf) => [tf, byTf[tf].events.map((e) => ({
      date: iso(e.t), kind: e.kind, side: e.side, quality: e.quality, line: e.line, close: e.close,
    }))])),
    week: ticker === "TSLA" || ONLY === ticker ? weekAutopsy(byTf) : undefined,
    stacks,
  };
}

function weekAutopsy(byTf) {
  const out = {};
  for (const tf of TFS) {
    const rows = (byTf[tf].rows || []).filter((r) => r.t >= WEEK_START - (tf === "M" || tf === "W" ? 90 * 86400000 : 0));
    const recent = tf === "M" ? rows.slice(-6) : tf === "W" ? rows.slice(-8) : rows.slice(-12);
    out[tf] = {
      lastHit: byTf[tf].lastHit,
      eventsThisWindow: (byTf[tf].events || []).filter((e) => e.t >= WEEK_START - 14 * 86400000).map((e) => ({
        date: iso(e.t), kind: e.kind, side: e.side, quality: e.quality, line: e.line, close: e.close,
      })),
      bars: recent.map((r) => ({
        date: iso(r.t),
        o: +r.o.toFixed(2), h: +r.h.toFixed(2), l: +r.l.toFixed(2), c: +r.c.toFixed(2),
        st: Number.isFinite(r.st) ? +r.st.toFixed(2) : null,
        dir: r.dir === -1 ? "BULL" : r.dir === 1 ? "BEAR" : "?",
        test: Number.isFinite(r.distAtr) && r.distAtr <= 0.15 && r.distAtr >= -0.50,
        holdClose: Number.isFinite(r.st) && Number.isFinite(r.atr) && r.c >= r.st - 0.08 * r.atr && r.dir === -1,
        distAtr: Number.isFinite(r.distAtr) ? +r.distAtr.toFixed(2) : null,
      })),
    };
  }
  return out;
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

function loadTickers() {
  const p = join(OUT_DIR, "tickers.json");
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  if (existsSync(TICKERS_FALLBACK)) {
    const list = JSON.parse(readFileSync(TICKERS_FALLBACK, "utf8"));
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(p, JSON.stringify(list, null, 2));
    return list;
  }
  return ["TSLA", "ETHUSD"];
}

function hitRate(arr) {
  const names = [...new Set(arr.map((c) => c.ticker))].sort();
  const scored = arr.filter((c) => c.outcome && c.outcome.barsAfter >= 10);
  return {
    setups: arr.length,
    names: names.length,
    scored: scored.length,
    ret20Up: scored.filter((c) => (c.outcome.ret20d || 0) > 0).length,
    ret60Up: scored.filter((c) => (c.outcome.ret60d || 0) > 0).length,
    avgRet20: scored.length ? +(scored.reduce((s, c) => s + (c.outcome.ret20d || 0), 0) / scored.length).toFixed(2) : null,
    avgRet60: scored.length ? +(scored.reduce((s, c) => s + (c.outcome.ret60d || 0), 0) / scored.length).toFixed(2) : null,
    list: names,
  };
}

function summarize(results) {
  const ok = results.filter((r) => r && !r.error);
  const stacks = ok.flatMap((r) => r.stacks || []);
  const by = { all4: [], htf: [], three: [] };
  for (const s of stacks) if (by[s.tier]) by[s.tier].push(s);
  const perTf = {};
  for (const tf of TFS) {
    perTf[tf] = {
      names: ok.filter((r) => (r.events?.[tf] || []).length).length,
      events: ok.reduce((n, r) => n + (r.events?.[tf] || []).length, 0),
    };
  }
  return {
    tickersScanned: ok.length,
    errors: results.filter((r) => r?.error).length,
    perTf,
    all4: hitRate(by.all4),
    htf: hitRate(by.htf),
    three: hitRate(by.three),
  };
}

function mdReport(summary, results) {
  const ok = results.filter((r) => r && !r.error);
  const tsla = ok.find((r) => r.ticker === "TSLA");
  const lines = [];
  lines.push("# SuperTrend test-and-hold (M / W / D / 4H)");
  lines.push("");
  lines.push(`Scanned **${summary.tickersScanned}** tickers. Detector is the live one (\`detectSupertrendHoldFromSeries\`, SuperTrend 10,3). Walked every bar.`);
  lines.push("");
  lines.push("A hold is a test of the ST line (low within +0.15/−0.50 ATR of a bull line, or high of a bear line) plus a close that holds. Stacked = hold events of the same side on multiple TFs inside 40 calendar days.");
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  lines.push(`- **All four TFs (M+W+D+4H):** ${summary.all4.names} names / ${summary.all4.setups} setups. Closed higher +20d **${summary.all4.ret20Up}/${summary.all4.scored}**, +60d **${summary.all4.ret60Up}/${summary.all4.scored}**. Avg +20d ${summary.all4.avgRet20}%, +60d ${summary.all4.avgRet60}%.`);
  lines.push(`- **HTF (M+W plus D or 4H):** ${summary.htf.names} names / ${summary.htf.setups} setups. Closed higher +20d **${summary.htf.ret20Up}/${summary.htf.scored}**, +60d **${summary.htf.ret60Up}/${summary.htf.scored}**.`);
  lines.push(`- **Any three TFs:** ${summary.three.names} names / ${summary.three.setups} setups.`);
  lines.push(`- Per-TF hold events: M ${summary.perTf.M.events} on ${summary.perTf.M.names} names; W ${summary.perTf.W.events} / ${summary.perTf.W.names}; D ${summary.perTf.D.events} / ${summary.perTf.D.names}; 4H ${summary.perTf["240"].events} / ${summary.perTf["240"].names}.`);
  lines.push("");
  if (summary.all4.list.length) {
    lines.push("## Names — all four TFs");
    lines.push("");
    lines.push(summary.all4.list.join(", "));
    lines.push("");
  }
  if (summary.htf.list.length) {
    lines.push("## Names — HTF (M+W + D or 4H)");
    lines.push("");
    lines.push(summary.htf.list.join(", "));
    lines.push("");
  }
  if (tsla) {
    lines.push("## TSLA this week");
    lines.push("");
    lines.push("Live snapshot (2026-08-21): price **364.66**, kanban **watch**, investor **research_low / 35**, confluence **WAIT 16/100** (2 long / 2 short). `st_hold_setup` is **null**. Only 30m carries `st_pierce_held`. Monthly ST bull **216.7** (flat, $148 below). Weekly ST bear **426.54** (flat, $62 above). Daily ST bull **310.26** (sloping, $54 below). 4H ST bull **340.9** (sloping, $24 below).");
    lines.push("");
    lines.push("RIDE needs 6 of 8 layers. A SuperTrend hold only upgrades READY→RIDE when those layers are already there. TSLA has 2.");
    lines.push("");
    if (tsla.week) {
      for (const tf of TFS) {
        const w = tsla.week[tf];
        lines.push(`### ${tf === "240" ? "4H" : tf}`);
        lines.push("");
        const lh = w.lastHit;
        lines.push(lh
          ? `Last-bar detector: **${lh.kind}** ${lh.sideLabel || lh.side} q=${lh.quality} held=${lh.held} line=${lh.stLine} (${lh.testBarsAgo} bars ago).`
          : "Last-bar detector: **null** (no test / hold / extended flip in the 12-bar lookback).");
        if (w.eventsThisWindow.length) {
          lines.push("");
          lines.push("Holds in/near this window: " + w.eventsThisWindow.map((e) => `${e.date} ${e.kind} ${e.side} @ ${e.line}`).join("; ") + ".");
        }
        lines.push("");
        lines.push("| Date | H | L | C | ST | Dir | Dist ATR | Test? |");
        lines.push("|---|---:|---:|---:|---:|---|---:|---|");
        for (const b of w.bars) {
          lines.push(`| ${b.date} | ${b.h} | ${b.l} | ${b.c} | ${b.st ?? "—"} | ${b.dir} | ${b.distAtr ?? "—"} | ${b.test ? "yes" : ""} |`);
        }
        lines.push("");
      }
    }
    lines.push("### Why it was not caught");
    lines.push("");
    lines.push("1. **No stacked M/W/D/4H hold this week.** Monthly bull ST is far below (~$124 reconstructed / $217 live). Weekly is **bear** far above (~$469 / $427). Cash traded the $330s–$360s and never tagged either HTF line.");
    lines.push("2. **Daily was a Friday flip, not a hold.** Mon–Thu daily ST was bear at **$356.78**. Highs were $345 / $345 / $351.62 / $347 — they approached from below (~1.2–1.7 ATR away) and never entered the 0.15 ATR test band. Friday close $363 flipped daily ST to bull at ~$310. That is a stretch-through flip, not a flat-line test-and-hold.");
    lines.push("3. **4H this week rode above a rising bull ST** (line $322→$341, lows $335–$345, +1.4 to +2.8 ATR). No test. The only nearby 4H hold was a **SHORT** on 2026-08-04.");
    lines.push("4. **Live detector is last-bar + 12 bars**, so a 4H test two days ago expires. After the Friday flip it returns **null** on M/W/D/4H (not even `st_flip_extended` — distance to the 21 EMA did not clear the 1.5 ATR chase flag). Only 30m shows `st_pierce_held`.");
    lines.push("5. **Confluence is WAIT 16/100.** RIDE needs 6 of 8 layers; TSLA has 2. A hold cannot ignite RIDE below that. Investor is research_low / 35; last investor book is exited; last tape trade was a May gap-reversal loss from $441.");
    lines.push("6. **What the desk did publish** (2026-08-17): CTO magnets from $339 — upside P $342.95, downside S1 $334.65. Cash is now $364. Level note, not an ST-hold entry.");
    lines.push("");
  }
  const stacks = ok.flatMap((r) => r.stacks || []).sort((a, b) => String(a.signalDate).localeCompare(String(b.signalDate)));
  const show = stacks.filter((s) => s.tier === "all4" || s.tier === "htf");
  if (show.length) {
    lines.push("## Stacked holds");
    lines.push("");
    lines.push("| Ticker | Date | Tier | Side | TFs | +20d | +60d |");
    lines.push("|---|---|---|---|---|---:|---:|");
    for (const s of show) {
      const o = s.outcome || {};
      lines.push(`| ${s.ticker} | ${s.signalDate} | ${s.tier} | ${s.side} | ${s.tfs.join(",")} | ${o.ret20d != null ? o.ret20d.toFixed(1) + "%" : "—"} | ${o.ret60d != null ? o.ret60d.toFixed(1) + "%" : "—"} |`);
    }
    lines.push("");
  }
  lines.push("## Caveats");
  lines.push("");
  lines.push("- 4H history is short (~late 2025). Monthly 233/ST needs a long sample; most names have it.");
  lines.push("- The walk emits a hold on the first bar the last-bar detector flips to held. Consecutive holds are one event.");
  lines.push("- Forward returns use daily closes after the last TF in the stack.");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  if (!KEY) {
    console.error("TIMED_API_KEY required");
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  let tickers = loadTickers();
  if (ONLY) tickers = [ONLY];
  console.log(`scan ${tickers.length} tickers`);
  const results = await mapPool(tickers, CONCURRENCY, async (ticker, idx) => {
    const series = {};
    for (const tf of TFS) series[tf] = await fetchCandles(ticker, tf);
    const r = scanTicker(ticker, series);
    if ((idx + 1) % 10 === 0 || ticker === "TSLA" || ONLY) {
      console.log(`  ${idx + 1}/${tickers.length} ${ticker} stacks=${r.stacks.length} holds M/W/D/4H=${TFS.map((tf) => (r.events[tf] || []).length).join("/")}`);
    }
    return r;
  });
  const summary = summarize(results);
  writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify({ summary, results }, null, 2));
  writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  const md = mdReport(summary, results);
  writeFileSync(join(OUT_DIR, "report.md"), md);
  console.log(JSON.stringify(summary, null, 2));
  if (ONLY) {
    const tsla = results.find((r) => r.ticker === ONLY);
    console.log(JSON.stringify({ coverage: tsla?.coverage, week: tsla?.week, stacks: tsla?.stacks }, null, 2));
  }
  console.log("\n" + md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
