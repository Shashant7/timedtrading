#!/usr/bin/env node
/**
 * Phase 0: Indicator Sanity Check
 *
 * Compares our locally-computed indicators (from worker/indicators.js)
 * against TwelveData's pre-computed indicator endpoints for a sample set.
 *
 * If they diverge, signal fingerprints learned from TwelveData history
 * won't match what we compute live at entry time — breaking the
 * ticker learning system.
 *
 * Usage: TWELVEDATA_API_KEY=xxx node scripts/indicator-sanity-check.js
 *
 * Parameters compared (must match our computeTfBundle defaults):
 *   RSI(14)       — Wilder's smoothing (RMA)
 *   SuperTrend    — factor=3.0, ATR period=10
 *   ATR(14)       — Wilder's RMA
 *   EMA(21)       — standard EMA
 */

const TD_KEY = process.env.TWELVEDATA_API_KEY;
const TD_BASE = "https://api.twelvedata.com";

if (!TD_KEY) {
  console.error("ERROR: TWELVEDATA_API_KEY required");
  console.error("  Usage: TWELVEDATA_API_KEY=xxx node scripts/indicator-sanity-check.js");
  process.exit(1);
}

const TICKERS = ["AAPL", "CAT", "KO", "SMCI", "GLD"];
const TIMEFRAMES = [
  { label: "Daily", tdInterval: "1day", barsNeeded: 300 },
  { label: "30m",   tdInterval: "30min", barsNeeded: 300 },
];
const COMPARE_BARS = 10;
const RATE_LIMIT_MS = 8500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseTs(datetime) {
  const normalized = datetime.replace(" ", "T");
  const suffix = normalized.includes("T") ? "" : "T00:00:00";
  return new Date(normalized + suffix + "Z").getTime();
}

async function tdFetch(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (data.status === "error") throw new Error(`TD API: ${data.message}`);
  return data;
}

async function fetchCandles(symbol, interval, outputsize = 500) {
  const url = `${TD_BASE}/time_series?symbol=${symbol}&interval=${interval}&outputsize=${outputsize}&apikey=${TD_KEY}&order=asc&timezone=UTC`;
  const data = await tdFetch(url);
  return (data.values || []).map(v => ({
    ts: parseTs(v.datetime),
    o: +v.open, h: +v.high, l: +v.low, c: +v.close,
    v: v.volume != null ? +v.volume : null,
  }));
}

async function fetchIndicator(symbol, indicator, interval, params = {}) {
  const qp = new URLSearchParams({
    symbol, interval, apikey: TD_KEY,
    outputsize: "30", order: "asc", timezone: "UTC",
    ...params,
  });
  return await tdFetch(`${TD_BASE}/${indicator}?${qp}`);
}

function compareContinuous(label, ourPairs, tdParsed, tolerancePct) {
  const pairs = [];
  for (const [ts, ourVal] of ourPairs) {
    const match = tdParsed.find(t => t.ts === ts);
    if (!match) continue;
    const theirVal = match.value;
    if (!Number.isFinite(ourVal) || !Number.isFinite(theirVal)) continue;
    const absErr = Math.abs(ourVal - theirVal);
    const pctErr = theirVal !== 0 ? (absErr / Math.abs(theirVal)) * 100 : 0;
    pairs.push({ ts, ours: ourVal, theirs: theirVal, absErr, pctErr });
  }
  if (!pairs.length) return { label, matched: 0, status: "NO_DATA" };

  const meanAbs = pairs.reduce((s, p) => s + p.absErr, 0) / pairs.length;
  const maxAbs  = Math.max(...pairs.map(p => p.absErr));
  const meanPct = pairs.reduce((s, p) => s + p.pctErr, 0) / pairs.length;

  return {
    label, matched: pairs.length,
    meanAbsError: +meanAbs.toFixed(4),
    maxAbsError: +maxAbs.toFixed(4),
    meanPctError: +meanPct.toFixed(3),
    status: meanPct <= tolerancePct ? "PASS" : "WARN",
    samples: pairs.slice(-3),
  };
}

function compareDirection(label, ourPairs, tdParsed) {
  const pairs = [];
  for (const [ts, ourVal] of ourPairs) {
    const match = tdParsed.find(t => t.ts === ts);
    if (!match || match.value === 0) continue;
    pairs.push({ ts, ours: ourVal, theirs: match.value, agree: ourVal === match.value });
  }
  if (!pairs.length) return { label, matched: 0, status: "NO_DATA" };

  const agree = pairs.filter(p => p.agree).length;
  const pct = +(agree / pairs.length * 100).toFixed(1);

  return {
    label, matched: pairs.length, agree, pct,
    status: pct >= 90 ? "PASS" : "WARN",
    samples: pairs.slice(-5),
  };
}

function logResult(r) {
  if (r.status === "NO_DATA") {
    console.log(`    ? ${r.label}: NO DATA (timestamps didn't match)`);
    return;
  }
  if (r.pct != null) {
    const icon = r.pct >= 90 ? "✓" : "✗";
    console.log(`    ${icon} ${r.label}: agree=${r.agree}/${r.matched} (${r.pct}%) — ${r.status}`);
  } else {
    const icon = r.status === "PASS" ? "✓" : "✗";
    console.log(`    ${icon} ${r.label}: mean_err=${r.meanAbsError}, mean_pct=${r.meanPctError}%, max_err=${r.maxAbsError}, matched=${r.matched} — ${r.status}`);
  }
  if (r.samples && r.samples.length > 0) {
    for (const s of r.samples.slice(-2)) {
      const d = new Date(s.ts).toISOString().slice(0, 16);
      if (s.agree != null) {
        console.log(`      ${d}: ours=${s.ours} theirs=${s.theirs} ${s.agree ? "✓" : "✗"}`);
      } else {
        console.log(`      ${d}: ours=${(+s.ours).toFixed(4)} theirs=${(+s.theirs).toFixed(4)} err=${s.pctErr.toFixed(3)}%`);
      }
    }
  }
}

function isPass(r) {
  if (r.status === "NO_DATA") return null;
  return r.status === "PASS";
}

async function main() {
  const ind = await import("../worker/indicators.js");
  const { rsiSeries, superTrendSeries, atrSeries, emaSeries } = ind;

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Indicator Sanity Check: Local vs TwelveData            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`\nTickers: ${TICKERS.join(", ")}`);
  console.log(`Timeframes: ${TIMEFRAMES.map(t => t.label).join(", ")}`);
  console.log(`Comparing last ${COMPARE_BARS} bars per indicator\n`);
  console.log("Parameters:");
  console.log("  RSI:        period=14 (Wilder's RMA)");
  console.log("  SuperTrend: factor=3.0, ATR period=10");
  console.log("  ATR:        period=14 (Wilder's RMA)");
  console.log("  EMA:        period=21");
  console.log("\nAcceptance thresholds:");
  console.log("  RSI:     mean % error < 2.0%");
  console.log("  ST Line: mean % error < 0.5%");
  console.log("  ST Dir:  agreement >= 90%");
  console.log("  ATR:     mean % error < 1.0%");
  console.log("  EMA:     mean % error < 0.5%");
  console.log(`\n(Rate limit: ~${RATE_LIMIT_MS / 1000}s between API calls)`);
  console.log("Estimated runtime: ~6 minutes\n");

  let totalPass = 0, totalWarn = 0, totalChecks = 0;

  for (const ticker of TICKERS) {
    console.log(`\n═══ ${ticker} ═══`);

    for (const tf of TIMEFRAMES) {
      console.log(`\n  ${tf.label}:`);

      let candles;
      try {
        candles = await fetchCandles(ticker, tf.tdInterval, tf.barsNeeded);
      } catch (e) {
        console.log(`    SKIP: failed to fetch candles — ${e.message}`);
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      if (candles.length < 50) {
        console.log(`    SKIP: only ${candles.length} candles (need 50+)`);
        continue;
      }
      console.log(`    Fetched ${candles.length} candles`);

      // ── RSI(14) ──
      await sleep(RATE_LIMIT_MS);
      try {
        const td = await fetchIndicator(ticker, "rsi", tf.tdInterval, { time_period: "14" });
        const tdParsed = (td.values || []).map(v => ({ ts: parseTs(v.datetime), value: +v.rsi }));
        const closes = candles.map(b => b.c);
        const ours = rsiSeries(closes, 14);
        const ourPairs = candles.map((b, i) => [b.ts, ours[i]]).filter(([, v]) => Number.isFinite(v));
        const r = compareContinuous("RSI(14)", ourPairs.slice(-COMPARE_BARS), tdParsed, 2.0);
        logResult(r);
        const p = isPass(r); if (p !== null) { totalChecks++; if (p) totalPass++; else totalWarn++; }
      } catch (e) { console.log(`    ✗ RSI(14): ERROR — ${e.message}`); }

      // ── SuperTrend (factor=3, period=10) ──
      await sleep(RATE_LIMIT_MS);
      try {
        const td = await fetchIndicator(ticker, "supertrend", tf.tdInterval, { multiplier: "3", period: "10" });
        const candleByTs = new Map(candles.map(b => [b.ts, b]));
        const tdValues = td.values || [];
        const tdLineParsed = [];
        const tdDirParsed = [];
        for (const v of tdValues) {
          const ts = parseTs(v.datetime);
          const stVal = +(v.supertrend || 0);
          tdLineParsed.push({ ts, value: stVal });
          const bar = candleByTs.get(ts);
          if (bar && stVal > 0) {
            tdDirParsed.push({ ts, value: stVal < bar.c ? -1 : 1 });
          }
        }
        const st = superTrendSeries(candles, 3.0, 10);
        const ourLinePairs = candles.map((b, i) => [b.ts, st.line[i]]).filter(([, v]) => Number.isFinite(v));
        const ourDirPairs = candles.map((b, i) => [b.ts, st.dir[i]]).filter(([, v]) => v !== 0);

        const rLine = compareContinuous("ST Line", ourLinePairs.slice(-COMPARE_BARS), tdLineParsed, 0.5);
        const rDir = compareDirection("ST Dir", ourDirPairs.slice(-COMPARE_BARS), tdDirParsed);
        logResult(rLine);
        logResult(rDir);
        for (const r of [rLine, rDir]) {
          const p = isPass(r); if (p !== null) { totalChecks++; if (p) totalPass++; else totalWarn++; }
        }
      } catch (e) { console.log(`    ✗ SuperTrend: ERROR — ${e.message}`); }

      // ── ATR(14) ──
      await sleep(RATE_LIMIT_MS);
      try {
        const td = await fetchIndicator(ticker, "atr", tf.tdInterval, { time_period: "14" });
        const tdParsed = (td.values || []).map(v => ({ ts: parseTs(v.datetime), value: +v.atr }));
        const ours = atrSeries(candles, 14);
        const ourPairs = candles.map((b, i) => [b.ts, ours[i]]).filter(([, v]) => Number.isFinite(v));
        const r = compareContinuous("ATR(14)", ourPairs.slice(-COMPARE_BARS), tdParsed, 1.0);
        logResult(r);
        const p = isPass(r); if (p !== null) { totalChecks++; if (p) totalPass++; else totalWarn++; }
      } catch (e) { console.log(`    ✗ ATR(14): ERROR — ${e.message}`); }

      // ── EMA(21) ──
      await sleep(RATE_LIMIT_MS);
      try {
        const td = await fetchIndicator(ticker, "ema", tf.tdInterval, { time_period: "21" });
        const tdParsed = (td.values || []).map(v => ({ ts: parseTs(v.datetime), value: +v.ema }));
        const closes = candles.map(b => b.c);
        const ours = emaSeries(closes, 21);
        const ourPairs = candles.map((b, i) => [b.ts, ours[i]]).filter(([, v]) => Number.isFinite(v));
        const r = compareContinuous("EMA(21)", ourPairs.slice(-COMPARE_BARS), tdParsed, 0.5);
        logResult(r);
        const p = isPass(r); if (p !== null) { totalChecks++; if (p) totalPass++; else totalWarn++; }
      } catch (e) { console.log(`    ✗ EMA(21): ERROR — ${e.message}`); }

      await sleep(2000);
    }
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log(`║  SUMMARY: ${totalPass} PASS / ${totalWarn} WARN / ${totalChecks} total checks`);
  if (totalWarn === 0 && totalChecks > 0) {
    console.log("║  ALL CHECKS PASSED — indicators are aligned             ║");
    console.log("║  Safe to use TwelveData indicators for historical data  ║");
  } else if (totalWarn > 0) {
    console.log("║  SOME WARNINGS — review divergences above               ║");
    console.log("║  May need parameter adjustments before proceeding       ║");
  } else {
    console.log("║  NO DATA — check API key and connectivity               ║");
  }
  console.log("╚══════════════════════════════════════════════════════════╝");
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
