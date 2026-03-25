#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const WORKER_DIR = path.join(__dirname, "../worker");
const args = process.argv.slice(2);

function getArg(name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : fallback;
}

const RUN_ID = getArg("--run-id");
const OUT_DIR = getArg("--out-dir");
const TICKERS = String(getArg("--tickers", ""))
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const API_BASE = getArg("--api-base", "https://timed-trading-ingest.shashant.workers.dev");
const API_KEY = getArg("--api-key", "");

if (!RUN_ID || !OUT_DIR) {
  console.error("Usage: node scripts/export-focused-run-artifacts.js --run-id <RUN_ID> --out-dir <DIR> [--tickers CSV] [--api-base URL] [--api-key KEY]");
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

function d1Query(sql) {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  const escaped = oneLine.replace(/"/g, '\\"');
  const raw = execSync(
    `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 },
  );
  const lines = raw.split("\n").filter((l) => !l.startsWith("npm"));
  const parsed = JSON.parse(lines.join("\n"));
  return Array.isArray(parsed) ? parsed[0]?.results || [] : parsed?.results || [];
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fetchJson(url) {
  try {
    return JSON.parse(execSync(`curl -sS "${url}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    }));
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function loadRunTrades() {
  if (API_KEY) {
    const runsTradesUrl = `${API_BASE}/timed/admin/runs/trades?run_id=${encodeURIComponent(RUN_ID)}&limit=10000&key=${encodeURIComponent(API_KEY)}`;
    const apiResult = fetchJson(runsTradesUrl);
    if (apiResult?.ok && Array.isArray(apiResult.trades)) {
      return apiResult.trades;
    }
  }

  try {
    return d1Query(`
      SELECT trade_id, ticker, direction, entry_ts, entry_price, rank, rr, status,
             exit_ts, exit_price, exit_reason, trimmed_pct, pnl, pnl_pct, script_version,
             created_at, updated_at, trim_ts, trim_price, setup_name, setup_grade,
             risk_budget, shares, notional, run_id
      FROM backtest_run_trades
      WHERE run_id = '${RUN_ID.replace(/'/g, "''")}'
      ORDER BY entry_ts DESC
    `);
  } catch (err) {
    return [];
  }
}

function loadRunConfig() {
  if (API_KEY) {
    const runsConfigUrl = `${API_BASE}/timed/admin/runs/config?run_id=${encodeURIComponent(RUN_ID)}&key=${encodeURIComponent(API_KEY)}`;
    const apiResult = fetchJson(runsConfigUrl);
    if (apiResult?.ok && apiResult.config && typeof apiResult.config === "object") {
      const entries = Object.entries(apiResult.config);
      if (entries.length > 0) {
        return { config: apiResult.config, source: "archive_api" };
      }
    }
  }

  try {
    const archivedRows = d1Query(`
      SELECT config_key, config_value
      FROM backtest_run_config
      WHERE run_id = '${RUN_ID.replace(/'/g, "''")}'
      ORDER BY config_key ASC
    `);
    if (archivedRows.length > 0) {
      return {
        config: Object.fromEntries(archivedRows.map((row) => [row.config_key, row.config_value])),
        source: "archive_d1",
      };
    }
  } catch (err) {}

  try {
    const liveRows = d1Query(`
      SELECT config_key, config_value
      FROM model_config
      ORDER BY config_key ASC
    `);
    if (liveRows.length > 0) {
      return {
        config: Object.fromEntries(liveRows.map((row) => [row.config_key, row.config_value])),
        source: "live_model_config_fallback",
      };
    }
  } catch (err) {}

  return { config: {}, source: "unavailable" };
}

function bucketRank(rank) {
  if (!Number.isFinite(rank)) return "unknown";
  if (rank >= 80) return "80+";
  if (rank >= 70) return "70-79";
  if (rank >= 60) return "60-69";
  return "<60";
}

function bucketRr(rr) {
  if (!Number.isFinite(rr)) return "unknown";
  if (rr >= 2.0) return "2.0+";
  if (rr >= 1.5) return "1.5-1.99";
  if (rr >= 1.0) return "1.0-1.49";
  return "<1.0";
}

function summarizeBuckets(trades, keyFn) {
  const map = new Map();
  for (const t of trades) {
    const bucket = keyFn(t);
    if (!map.has(bucket)) {
      map.set(bucket, { bucket, n: 0, wins: 0, losses: 0, pnl: 0 });
    }
    const row = map.get(bucket);
    row.n += 1;
    if (t.status === "WIN") row.wins += 1;
    if (t.status === "LOSS") row.losses += 1;
    if (["WIN", "LOSS", "FLAT"].includes(t.status)) row.pnl += safeNum(t.pnl);
  }
  return Array.from(map.values());
}

const rows = loadRunTrades();
const runConfigBundle = loadRunConfig();
const runConfig = runConfigBundle.config || {};

const trades = rows.map((r) => ({
  ...r,
  rank: Number.isFinite(Number(r.rank)) ? Number(r.rank) : null,
  rr: Number.isFinite(Number(r.rr)) ? Number(r.rr) : null,
  entry_ts: Number.isFinite(Number(r.entry_ts)) ? Number(r.entry_ts) : null,
  exit_ts: Number.isFinite(Number(r.exit_ts)) ? Number(r.exit_ts) : null,
  trim_ts: Number.isFinite(Number(r.trim_ts)) ? Number(r.trim_ts) : null,
  entry_price: Number.isFinite(Number(r.entry_price)) ? Number(r.entry_price) : null,
  exit_price: Number.isFinite(Number(r.exit_price)) ? Number(r.exit_price) : null,
  trim_price: Number.isFinite(Number(r.trim_price)) ? Number(r.trim_price) : null,
  trimmed_pct: safeNum(r.trimmed_pct),
  pnl: safeNum(r.pnl),
  pnlPct: safeNum(r.pnl_pct),
  pnl_pct: safeNum(r.pnl_pct),
  entryPrice: Number.isFinite(Number(r.entry_price)) ? Number(r.entry_price) : null,
  exitPrice: Number.isFinite(Number(r.exit_price)) ? Number(r.exit_price) : null,
  trimPrice: Number.isFinite(Number(r.trim_price)) ? Number(r.trim_price) : null,
  scriptVersion: r.script_version || "unknown",
}));

const closedTrades = trades.filter((t) => ["WIN", "LOSS", "FLAT"].includes(String(t.status || "").toUpperCase()));
const wins = closedTrades.filter((t) => t.status === "WIN");
const losses = closedTrades.filter((t) => t.status === "LOSS");
const grossWin = wins.reduce((s, t) => s + safeNum(t.pnl), 0);
const grossLoss = losses.reduce((s, t) => s + Math.abs(safeNum(t.pnl)), 0);
const closedPnl = closedTrades.reduce((s, t) => s + safeNum(t.pnl), 0);

const ledgerSummary = {
  ok: true,
  since: null,
  until: null,
  run_id: RUN_ID,
  totals: {
    totalTrades: trades.length,
    openTrades: trades.filter((t) => ["OPEN", "TP_HIT_TRIM"].includes(String(t.status || "").toUpperCase())).length,
    closedTrades: closedTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closedTrades.length ? (wins.length / closedTrades.length) * 100 : 0,
    closedPnl,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    expectancy: closedTrades.length ? closedPnl / closedTrades.length : 0,
    grossWin,
    grossLoss,
  },
  breakdown: {
    byRank: summarizeBuckets(trades, (t) => bucketRank(t.rank)),
    byRR: summarizeBuckets(trades, (t) => bucketRr(t.rr)),
    byExitReason: summarizeBuckets(trades, (t) => String(t.exit_reason || "unknown")),
    byTriggerReason: [],
  },
};

const accountSummary = {
  ok: true,
  mode: "trader",
  run_id: RUN_ID,
  startCash: 100000,
  cash: 100000 + closedPnl,
  totalRealized: closedPnl,
  unrealized: 0,
  costBasis: 0,
  markToMarket: 0,
  accountValue: 100000 + closedPnl,
  generated_at: new Date().toISOString(),
};

const losingTradesReport = {
  ok: true,
  run_id: RUN_ID,
  report: TICKERS.map((ticker) => {
    const subset = trades.filter((t) => String(t.ticker || "").toUpperCase() === ticker);
    const closed = subset.filter((t) => ["WIN", "LOSS", "FLAT"].includes(String(t.status || "").toUpperCase()));
    const totalPnl = closed.reduce((s, t) => s + safeNum(t.pnl), 0);
    return {
      ticker,
      total_trades: subset.length,
      closed_trades: closed.length,
      wins: closed.filter((t) => t.status === "WIN").length,
      losses: closed.filter((t) => t.status === "LOSS").length,
      total_pnl: totalPnl,
      avg_pnl_pct: closed.length ? closed.reduce((s, t) => s + safeNum(t.pnl_pct), 0) / closed.length : 0,
    };
  }).sort((a, b) => a.total_pnl - b.total_pnl),
};

const tradesPayload = {
  ok: true,
  count: trades.length,
  totalCount: trades.length,
  version: "all",
  versions: [...new Set(trades.map((t) => t.scriptVersion || "unknown"))],
  trades,
  source: "archive",
  archive_run_id: RUN_ID,
};

fs.writeFileSync(path.join(OUT_DIR, "trades.json"), JSON.stringify(tradesPayload, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "ledger-summary.json"), JSON.stringify(ledgerSummary, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "account-summary.json"), JSON.stringify(accountSummary, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "losing-trades-report.json"), JSON.stringify(losingTradesReport, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "model-config.json"), JSON.stringify({
  ok: true,
  run_id: RUN_ID,
  source: runConfigBundle.source,
  config_key_count: Object.keys(runConfig).length,
  config: runConfig,
}, null, 2));

if (API_KEY) {
  const autopsyUrl = `${API_BASE}/timed/admin/trade-autopsy/trades?run_id=${encodeURIComponent(RUN_ID)}&key=${encodeURIComponent(API_KEY)}`;
  const autopsy = fetchJson(autopsyUrl);
  fs.writeFileSync(path.join(OUT_DIR, "trade-autopsy-trades.json"), JSON.stringify(autopsy, null, 2));
}

console.log(JSON.stringify({
  ok: true,
  run_id: RUN_ID,
  out_dir: OUT_DIR,
  trade_count: trades.length,
  closed_trade_count: closedTrades.length,
  closed_pnl: closedPnl,
  config_key_count: Object.keys(runConfig).length,
  config_source: runConfigBundle.source,
}, null, 2));
