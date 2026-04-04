#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const getArg = (name, fallback = "") => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};

const tickers = (getArg("tickers", "FIX,RBLX,CELH,ETN,ULTA,CAT"))
  .split(",")
  .map((v) => v.trim().toUpperCase())
  .filter(Boolean);
const tfs = (getArg("tfs", "30,60"))
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const startDate = getArg("start", "2025-07-01");
const endDate = getArg("end", "2025-07-31");
const output = getArg("output", "");

const workerDir = path.join(__dirname, "..", "worker");
const startTs = new Date(`${startDate}T00:00:00Z`).getTime();
const endTs = new Date(`${endDate}T23:59:59Z`).getTime();
const latenessMsByTf = { "30": 3 * 24 * 60 * 60 * 1000, "60": 5 * 24 * 60 * 60 * 1000 };

function runQuery(sql) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `cd "${workerDir}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`;
  const raw = execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
  return parsed?.results || [];
}

function fmtDate(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function buildSql(ticker, tf) {
  return `
    SELECT
      '${ticker}' AS ticker,
      '${tf}' AS tf,
      COUNT(CASE WHEN ts >= ${startTs} AND ts <= ${endTs} THEN 1 END) AS in_window_count,
      MIN(CASE WHEN ts >= ${startTs} AND ts <= ${endTs} THEN ts END) AS first_in_window_ts,
      MAX(CASE WHEN ts >= ${startTs} AND ts <= ${endTs} THEN ts END) AS last_in_window_ts,
      MAX(CASE WHEN ts < ${startTs} THEN ts END) AS last_before_window_ts,
      MAX(ts) AS last_any_ts
    FROM ticker_candles
    WHERE ticker='${ticker}' AND tf='${tf}'
  `;
}

function analyzeRow(row) {
  const tf = String(row.tf);
  const inWindowCount = Number(row.in_window_count || 0);
  const firstInWindowTs = Number(row.first_in_window_ts || 0);
  const lastInWindowTs = Number(row.last_in_window_ts || 0);
  const lastBeforeWindowTs = Number(row.last_before_window_ts || 0);
  const lastAnyTs = Number(row.last_any_ts || 0);
  const lateThreshold = startTs + (latenessMsByTf[tf] || 3 * 24 * 60 * 60 * 1000);

  let status = "ok";
  const issues = [];
  if (inWindowCount === 0) {
    status = lastBeforeWindowTs > 0 ? "stale_carry_forward" : "missing";
    issues.push(status);
  } else {
    if (firstInWindowTs > lateThreshold) issues.push("late_start");
    if (lastInWindowTs < endTs - (latenessMsByTf[tf] || 0)) issues.push("stale_end");
    if (issues.length) status = "partial";
  }
  return {
    ticker: row.ticker,
    tf,
    status,
    issues,
    in_window_count: inWindowCount,
    first_in_window_ts: firstInWindowTs || null,
    first_in_window_iso: fmtDate(firstInWindowTs),
    last_in_window_ts: lastInWindowTs || null,
    last_in_window_iso: fmtDate(lastInWindowTs),
    last_before_window_ts: lastBeforeWindowTs || null,
    last_before_window_iso: fmtDate(lastBeforeWindowTs),
    last_any_ts: lastAnyTs || null,
    last_any_iso: fmtDate(lastAnyTs),
  };
}

function main() {
  const rows = [];
  for (const ticker of tickers) {
    for (const tf of tfs) {
      const result = runQuery(buildSql(ticker, tf));
      if (result[0]) rows.push(analyzeRow(result[0]));
    }
  }
  const report = {
    generated_at: new Date().toISOString(),
    start_date: startDate,
    end_date: endDate,
    tickers,
    tfs,
    rows,
    summary: {
      ok: rows.filter((r) => r.status === "ok").length,
      partial: rows.filter((r) => r.status === "partial").length,
      missing: rows.filter((r) => r.status === "missing").length,
      stale_carry_forward: rows.filter((r) => r.status === "stale_carry_forward").length,
    },
  };
  const outPath = output
    ? path.resolve(output)
    : path.resolve("data", `july-htf-window-audit-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(outPath);
  for (const row of rows) {
    console.log(`${row.ticker} ${row.tf}: ${row.status} count=${row.in_window_count} last=${row.last_in_window_iso || row.last_before_window_iso || "n/a"} ${row.issues.join(",")}`);
  }
}

main();
