#!/usr/bin/env node

/**
 * scripts/audit-candle-coverage.js
 *
 * Audits the worker's D1 ticker_candles coverage for the Phase-B 24-ticker
 * universe across all relevant timeframes, month by month for the
 * Jul 2025 - Apr 2026 scope.
 *
 * Reports, per (ticker, tf, month):
 *   - number of bars present
 *   - number of NYSE trading days in the month that have >=1 bar
 *   - the expected minimum count (for 60m / 30m / 15m / 10m / 5m)
 *   - a gap flag if coverage is <80% of expected
 *
 * Output: data/trade-analysis/candle-coverage-audit-2026-04-18/
 *   - audit.json     machine readable
 *   - audit.md       human readable, grouped by cohort
 *   - gaps.csv       only the rows that have gaps (ready for backfill script)
 *
 * Usage:
 *   TIMED_API_KEY=... node scripts/audit-candle-coverage.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";
if (!API_KEY) {
  console.error("TIMED_API_KEY required");
  process.exit(2);
}

// Phase-B universe (same as scripts/build-monthly-backdrop.js + monthly-slice.sh)
const TIER1 = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"];
const TIER2 = ["AGQ", "CDNS", "ETN", "FIX", "GRNY", "HUBS", "IESC", "MTZ", "ON", "PH", "RIOT", "SGI", "SWK", "XLY"];
const UNIVERSE = [...TIER1, ...TIER2];

// TFs that matter for the replay engine. Per product guidance:
//   - 10m is the leading LTF and is sourced from Alpaca.
//   - 15m / 30m / 60m / 240 (4H) / D / W / M come from TwelveData.
//   - 5m / 3m / 1m are not used by the strategy, so they're not audited.
const TFS = ["10", "15", "30", "60", "240", "D", "W", "M"];

// Months in scope (matches plan). March + April included per user request.
const MONTHS = [
  "2025-07", "2025-08", "2025-09", "2025-10", "2025-11",
  "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
];

// NYSE full-day holidays inside scope (same set as monthly-slice.sh).
const HOLIDAYS = new Set([
  "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03",
]);

const RTH_START_H = 13; // 09:30 NY = 13:30 UTC (summer) / 14:30 UTC (winter) — approx for bar counting
const RTH_END_H = 21;   // 16:00 NY

// Expected bars per RTH day for each TF. W and M aren't per-day — their
// expected count is derived from calendar weeks / months in the scope, not
// trading days. The audit computes the ratio differently for those.
const BARS_PER_DAY = {
  "10": 39,   // 6.5h * 6
  "15": 26,   // 6.5h * 4
  "30": 13,   // 6.5h * 2
  "60": 7,    // 6.5h rounded up
  "240": 2,   // 4H = typically 2 bars / day (9:30 + 13:30 NY)
  "D": 1,
  "W": 0,     // special-cased below
  "M": 0,     // special-cased below
};

function isTradingDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (HOLIDAYS.has(dateStr)) return false;
  return true;
}

function monthBounds(ym) {
  const [y, m] = ym.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  const days = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  // Cap at today (UTC) for partial months
  const today = new Date().toISOString().slice(0, 10);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10) > today ? today : end.toISOString().slice(0, 10),
    days: days.filter((d) => d <= today && isTradingDay(d)),
  };
}

function curlJson(url) {
  const raw = execSync(
    `curl -sS -m 30 "${url}"`,
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`JSON parse failed for ${url}: ${err.message}`);
    return null;
  }
}

// The /timed/candles endpoint caps `limit` at 3000 server-side. To audit a
// 10-month window for a ticker with ~78 bars/day of 10m data (~16k bars),
// we have to walk backwards using ?asOfTs=... page by page.
function fetchCandles(ticker, tf, sinceMs, untilMs) {
  const all = [];
  let cursor = untilMs;
  while (cursor > sinceMs) {
    const url = `${API_BASE}/timed/candles?ticker=${encodeURIComponent(ticker)}&tf=${encodeURIComponent(tf)}&limit=3000&asOfTs=${cursor}&key=${encodeURIComponent(API_KEY)}`;
    const d = curlJson(url);
    const page = d?.candles || [];
    if (page.length === 0) break;
    for (const c of page) {
      if (c.ts >= sinceMs && c.ts <= untilMs) all.push(c);
    }
    // Advance cursor to before the oldest bar in this page; if it's already
    // at or before sinceMs we're done.
    const oldestTs = page.reduce((min, c) => Math.min(min, c.ts), Infinity);
    if (!Number.isFinite(oldestTs) || oldestTs <= sinceMs) break;
    cursor = oldestTs - 1;
    if (page.length < 3000) break; // no more to fetch
  }
  // De-dup by ts (shouldn't happen but guard)
  const seen = new Set();
  return all.filter((c) => {
    if (seen.has(c.ts)) return false;
    seen.add(c.ts);
    return true;
  });
}

function countBarsInMonth(candles, start, end) {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T23:59:59Z`);
  const inside = candles.filter((c) => c.ts >= startMs && c.ts <= endMs);
  const daysWithBars = new Set(
    inside
      .map((c) => new Date(c.ts).toISOString().slice(0, 10))
      .filter((d) => isTradingDay(d)),
  );
  return { count: inside.length, daysWithBars: daysWithBars.size };
}

function gapRatio(actual, expected) {
  if (expected <= 0) return 1;
  return actual / expected;
}

async function main() {
  const outDir = path.join(__dirname, "..", "data/trade-analysis/candle-coverage-audit-2026-04-18");
  fs.mkdirSync(outDir, { recursive: true });

  const report = {
    generated_at: new Date().toISOString(),
    universe: UNIVERSE,
    tfs: TFS,
    months: MONTHS,
    rows: [],
  };
  const gaps = []; // {ticker, tf, month, count, expected, days_with_bars, days_in_month}

  console.log(`Auditing ${UNIVERSE.length} tickers × ${TFS.length} TFs × ${MONTHS.length} months = ${UNIVERSE.length * TFS.length * MONTHS.length} cells`);

  // For efficiency, fetch each (ticker, tf) once with a large limit covering the whole scope,
  // then partition into months locally.
  // Scope window: sinceMs = first trading day of Jul 2025 minus a buffer;
  // untilMs = today + 1 day.
  const SINCE_MS = Date.parse("2025-07-01T00:00:00Z");
  const UNTIL_MS = Date.now() + 86400000;

  for (const ticker of UNIVERSE) {
    for (const tf of TFS) {
      let candles;
      try {
        candles = fetchCandles(ticker, tf, SINCE_MS, UNTIL_MS);
      } catch (err) {
        console.warn(`fetch failed ${ticker} ${tf}: ${err.message}`);
        candles = [];
      }
      // For each month, compute coverage stats
      for (const ym of MONTHS) {
        const { start, end, days } = monthBounds(ym);
        const { count, daysWithBars } = countBarsInMonth(candles, start, end);
        let expected;
        if (tf === "W") {
          // Expected weekly bars = number of calendar weeks fully within
          // the month. Each trading week produces exactly one bar.
          // Count distinct Mondays (or any anchor day) in the trading-day list.
          const weekKeys = new Set(
            days.map((d) => {
              const dt = new Date(`${d}T12:00:00Z`);
              const dow = dt.getUTCDay(); // 0..6
              const anchor = new Date(dt);
              anchor.setUTCDate(dt.getUTCDate() - ((dow + 6) % 7)); // Monday
              return anchor.toISOString().slice(0, 10);
            }),
          );
          expected = weekKeys.size;
        } else if (tf === "M") {
          // Exactly one M bar per month if there are any trading days.
          expected = days.length > 0 ? 1 : 0;
        } else {
          expected = days.length * (BARS_PER_DAY[tf] || 0);
        }
        const ratio = gapRatio(count, expected);
        const gap = ratio < 0.8; // flag if under 80% of expected
        const row = {
          ticker,
          tf,
          month: ym,
          days_in_month: days.length,
          days_with_bars: daysWithBars,
          bars: count,
          expected_bars: expected,
          ratio: Math.round(ratio * 100) / 100,
          gap,
        };
        report.rows.push(row);
        if (gap && days.length > 0) gaps.push(row);
      }
      process.stdout.write(".");
    }
    process.stdout.write(`\n${ticker} done\n`);
  }

  // Summary: total cells + gap cells, by ticker, by tf
  const byTicker = {};
  const byTf = {};
  const byTickerTf = {};
  for (const r of report.rows) {
    byTicker[r.ticker] = byTicker[r.ticker] || { total: 0, gap: 0 };
    byTicker[r.ticker].total += 1;
    if (r.gap) byTicker[r.ticker].gap += 1;
    byTf[r.tf] = byTf[r.tf] || { total: 0, gap: 0 };
    byTf[r.tf].total += 1;
    if (r.gap) byTf[r.tf].gap += 1;
    const k = `${r.ticker}|${r.tf}`;
    byTickerTf[k] = byTickerTf[k] || { total: 0, gap: 0, months_with_gap: [] };
    byTickerTf[k].total += 1;
    if (r.gap) {
      byTickerTf[k].gap += 1;
      byTickerTf[k].months_with_gap.push(r.month);
    }
  }

  report.summary = { by_ticker: byTicker, by_tf: byTf };

  fs.writeFileSync(path.join(outDir, "audit.json"), JSON.stringify(report, null, 2));

  // Gap CSV
  const csvLines = ["ticker,tf,month,days_in_month,days_with_bars,bars,expected_bars,ratio"];
  for (const r of gaps) {
    csvLines.push(`${r.ticker},${r.tf},${r.month},${r.days_in_month},${r.days_with_bars},${r.bars},${r.expected_bars},${r.ratio}`);
  }
  fs.writeFileSync(path.join(outDir, "gaps.csv"), csvLines.join("\n") + "\n");

  // Markdown summary
  const md = [];
  md.push("# Candle coverage audit — 2026-04-18");
  md.push("");
  md.push(`- Scope: ${UNIVERSE.length} tickers × ${TFS.length} TFs × ${MONTHS.length} months = **${report.rows.length} cells**`);
  md.push(`- Cells with < 80% of expected bars: **${gaps.length}** (${Math.round(gaps.length / report.rows.length * 100)}%)`);
  md.push("");
  md.push("## Gaps by TF");
  md.push("");
  md.push("| TF | total | gap | % |");
  md.push("|---|---:|---:|---:|");
  for (const tf of TFS) {
    const s = byTf[tf];
    md.push(`| ${tf} | ${s.total} | ${s.gap} | ${Math.round(s.gap / s.total * 100)}% |`);
  }
  md.push("");
  md.push("## Gaps by ticker (worst first)");
  md.push("");
  md.push("| Ticker | total | gap | % |");
  md.push("|---|---:|---:|---:|");
  const sortedTickers = [...UNIVERSE].sort((a, b) => byTicker[b].gap - byTicker[a].gap);
  for (const t of sortedTickers) {
    const s = byTicker[t];
    md.push(`| ${t} | ${s.total} | ${s.gap} | ${Math.round(s.gap / s.total * 100)}% |`);
  }
  md.push("");
  md.push("## Per-ticker × TF gap distribution");
  md.push("");
  md.push("Only showing (ticker, tf) combinations where > 0 months have gaps.");
  md.push("");
  md.push("| Ticker | TF | months with gap |");
  md.push("|---|---|---|");
  for (const k of Object.keys(byTickerTf).sort()) {
    const info = byTickerTf[k];
    if (info.gap === 0) continue;
    const [t, tf] = k.split("|");
    md.push(`| ${t} | ${tf} | ${info.months_with_gap.join(", ")} |`);
  }
  fs.writeFileSync(path.join(outDir, "audit.md"), md.join("\n") + "\n");

  console.log(`\nWrote ${outDir}/audit.json, audit.md, gaps.csv`);
  console.log(`Gap cells: ${gaps.length} / ${report.rows.length}`);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
