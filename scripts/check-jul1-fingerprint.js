#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);

function getArg(name, fallback = "") {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}

function toMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function fetchJson(url) {
  return fetch(url, { headers: { Accept: "application/json" } }).then(async (resp) => {
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data?.ok === false) {
      throw new Error(data?.error || `${resp.status} ${resp.statusText}`);
    }
    return data;
  });
}

async function loadTrades() {
  const autopsyPath = getArg("--autopsy");
  const runId = getArg("--run-id");
  const apiBase = getArg("--api-base", "https://timed-trading-ingest.shashant.workers.dev");
  const apiKey = getArg("--api-key", "");

  if (autopsyPath) {
    const raw = fs.readFileSync(path.resolve(autopsyPath), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.trades) ? parsed.trades : [];
  }

  if (!runId) {
    throw new Error("Provide --run-id or --autopsy");
  }

  const url = new URL(`${apiBase}/timed/admin/trade-autopsy/trades`);
  url.searchParams.set("run_id", runId);
  if (apiKey) url.searchParams.set("key", apiKey);
  const result = await fetchJson(String(url));
  return Array.isArray(result?.trades) ? result.trades : [];
}

async function main() {
  const outputPath = getArg("--output");
  const intervalMin = Math.max(1, Number(getArg("--interval-min", "15")) || 15);
  const toleranceMs = intervalMin * 60 * 1000;
  const targets = [
    { ticker: "CDNS", direction: "LONG", entry_path: "ripster_momentum", entry_ts: Date.parse("2025-07-01T13:30:00Z") },
    { ticker: "ORCL", direction: "LONG", entry_path: "ripster_momentum", entry_ts: Date.parse("2025-07-01T13:45:00Z") },
    { ticker: "CSX", direction: "LONG", entry_path: "ripster_momentum", entry_ts: Date.parse("2025-07-01T13:45:00Z") },
    { ticker: "ITT", direction: "LONG", entry_path: "ripster_momentum", entry_ts: Date.parse("2025-07-01T14:15:00Z") },
  ];

  const trades = await loadTrades();
  const jul1Trades = trades
    .map((trade) => ({
      trade_id: trade?.trade_id || trade?.id || null,
      ticker: String(trade?.ticker || "").toUpperCase(),
      direction: String(trade?.direction || "").toUpperCase(),
      entry_path: trade?.entry_path || null,
      entry_ts: toMs(trade?.entry_ts),
      status: trade?.status || null,
      run_id: trade?.run_id || null,
    }))
    .filter((trade) => trade.entry_ts && String(new Date(trade.entry_ts).toISOString()).startsWith("2025-07-01"))
    .sort((a, b) => a.entry_ts - b.entry_ts);

  const perTarget = targets.map((target) => {
    const exactTicker = jul1Trades.filter((trade) => trade.ticker === target.ticker);
    const closest = exactTicker
      .map((trade) => ({
        ...trade,
        time_diff_ms: Math.abs(trade.entry_ts - target.entry_ts),
      }))
      .sort((a, b) => a.time_diff_ms - b.time_diff_ms)[0] || null;

    const matched =
      closest &&
      closest.time_diff_ms <= toleranceMs &&
      closest.direction === target.direction &&
      String(closest.entry_path || "") === target.entry_path;

    return {
      ...target,
      tolerance_ms: toleranceMs,
      matched: !!matched,
      observed: closest ? {
        trade_id: closest.trade_id,
        ticker: closest.ticker,
        direction: closest.direction,
        entry_path: closest.entry_path,
        entry_ts: closest.entry_ts,
        time_diff_ms: closest.time_diff_ms,
        status: closest.status,
      } : null,
      issues: closest ? [
        ...(closest.time_diff_ms > toleranceMs ? [`timestamp_drift:${closest.time_diff_ms}`] : []),
        ...(closest.direction !== target.direction ? [`direction:${closest.direction}`] : []),
        ...(String(closest.entry_path || "") !== target.entry_path ? [`entry_path:${closest.entry_path || "missing"}`] : []),
      ] : ["missing_ticker"],
    };
  });

  const matchedCount = perTarget.filter((row) => row.matched).length;
  const earlyWindow = jul1Trades.slice(0, 8).map((trade) => ({
    ticker: trade.ticker,
    direction: trade.direction,
    entry_path: trade.entry_path,
    entry_ts: trade.entry_ts,
    trade_id: trade.trade_id,
  }));
  const unexpectedEarly = earlyWindow.filter((trade) => !targets.some((target) => target.ticker === trade.ticker));

  const result = {
    ok: true,
    contract: "jul1_fingerprint_v1",
    matched_targets: matchedCount,
    total_targets: targets.length,
    parity_passed: matchedCount === targets.length,
    per_target: perTarget,
    early_window: earlyWindow,
    unexpected_early_tickers: unexpectedEarly,
  };

  const rendered = JSON.stringify(result, null, 2);
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), rendered, "utf8");
  }
  process.stdout.write(`${rendered}\n`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
