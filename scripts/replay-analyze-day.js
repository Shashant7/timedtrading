#!/usr/bin/env node
/**
 * Full replay + deep analysis for one or more tickers on a date.
 * Calls replay-ticker-d1 with debug=1 for each ticker and writes an analysis report.
 *
 * Usage:
 *   TIMED_API_KEY=key DATE=2026-02-02 node scripts/replay-analyze-day.js
 *   Or set TIMED_API_KEY in .env in project root (loaded automatically if present).
 */
const fs = require("fs");
const path = require("path");
// Optional: load .env from project root so TIMED_API_KEY can be set there
try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const buf = fs.readFileSync(envPath, "utf8");
    buf.split("\n").forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    });
  }
} catch (_) {}

const API_BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";
const DATE = process.env.DATE || "";
const TICKERS_STR = process.env.TICKERS || "AAPL,AMD";
const CLEAN_SLATE = process.env.CLEAN_SLATE === "1" || process.env.CLEAN_SLATE === "true";

function nyTradingDayKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function replayTicker(ticker, dayKey) {
  const params = new URLSearchParams({
    key: API_KEY,
    date: dayKey,
    ticker: ticker,
    debug: "1",
  });
  if (CLEAN_SLATE) params.set("cleanSlate", "1");
  const url = `${API_BASE}/timed/admin/replay-ticker-d1?${params}`;
  const resp = await fetch(url, { method: "POST" });
  return resp.json();
}

function formatTime(ts) {
  if (ts == null || !Number.isFinite(ts)) return "—";
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function reportMarkdown(ticker, data) {
  const lines = [];
  lines.push(`## ${ticker} — ${data.day}`);
  lines.push("");
  lines.push(`- Rows processed: ${data.rowsProcessed || 0}`);
  lines.push(`- Trades created: ${data.tradesCreated || 0}`);
  lines.push(`- Lane counts: ${JSON.stringify(data.laneCounts || {})}`);
  lines.push(`- Prev period seeded: ${data.prevPeriodSeeded === true}`);
  lines.push("");

  if (!data.analysis) {
    lines.push("No analysis (run with debug=1).");
    return lines.join("\n");
  }

  const a = data.analysis;
  lines.push("### Summary");
  lines.push(`- Enter Now moments: **${a.enterNowCount || 0}**`);
  lines.push(`- Forced to Watch (missing trigger): ${a.forcedWatchCount || 0}`);
  lines.push(`- Forced to Enter Now (cycle gate): ${a.forcedEnterNowCount || 0}`);
  lines.push(`- First-bar-of-day bridge: ${a.firstBarBridgeCount || 0}`);
  lines.push("");

  const rows = a.rows || [];
  const enterNowRows = rows.filter((r) => r.finalStage === "enter_now");
  if (enterNowRows.length > 0) {
    lines.push("### Enter Now moments (and why trade did/didn't fire)");
    lines.push("");
    lines.push("| Time | Stage→Final | ShouldTrigger | Blockers | Rank | RR | Comp | Trigger |");
    lines.push("|------|------------|---------------|----------|------|-----|------|---------|");
    enterNowRows.forEach((r) => {
      const blockers = (r.blockers || []).join("; ") || "—";
      const compPct = r.comp != null ? (r.comp * 100).toFixed(0) + "%" : "—";
      lines.push(`| ${formatTime(r.ts)} | ${r.stage}→${r.finalStage} | ${r.shouldTrigger} | ${blockers} | ${r.rank ?? "—"} | ${r.rr ?? "—"} | ${compPct} | ${r.trigger_reason || "—"} |`);
    });
    lines.push("");
  }

  const forced = rows.filter((r) => r.forcedReason);
  if (forced.length > 0) {
    lines.push("### Forced lane changes (stage would be hold/trim but we forced watch/enter_now)");
    lines.push("");
    forced.slice(0, 30).forEach((r) => {
      lines.push(`- ${formatTime(r.ts)} **${r.forcedReason}** — raw stage=${r.stage} → final=${r.finalStage} state=${r.state}`);
    });
    if (forced.length > 30) lines.push(`- ... and ${forced.length - 30} more`);
    lines.push("");
  }

  const watchInCorridor = rows.filter(
    (r) => r.finalStage === "watch" && (r.state === "HTF_BULL_LTF_BULL" || r.state === "HTF_BEAR_LTF_BEAR")
  );
  if (watchInCorridor.length > 0 && watchInCorridor.length <= 15) {
    lines.push("### Watch (momentum in corridor) — possible missed ENTER_NOW");
    lines.push("");
    watchInCorridor.forEach((r) => {
      lines.push(`- ${formatTime(r.ts)} state=${r.state} rank=${r.rank} trigger_reason=${r.trigger_reason || "—"}`);
    });
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  if (!API_KEY) {
    console.error("TIMED_API_KEY is required");
    process.exit(1);
  }
  const dayKey = DATE && /^\d{4}-\d{2}-\d{2}$/.test(DATE) ? DATE : nyTradingDayKey();
  const tickers = TICKERS_STR.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (tickers.length === 0) {
    console.error("TICKERS is required (e.g. TICKERS=AAPL,AMD)");
    process.exit(1);
  }

  console.log("# Replay + Entry Analysis");
  console.log("");
  console.log(`Date: **${dayKey}** | Tickers: ${tickers.join(", ")} | Clean slate: ${CLEAN_SLATE}`);
  console.log("");

  for (const ticker of tickers) {
    const data = await replayTicker(ticker, dayKey);
    if (!data.ok) {
      console.log(`## ${ticker}`);
      console.log("");
      console.log("Error:", JSON.stringify(data, null, 2));
      console.log("");
      continue;
    }
    console.log(reportMarkdown(ticker, data));
    console.log("");
  }

  console.log("---");
  console.log("See docs/ENTRY_RULES_AND_ANALYSIS.md for rule reference.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
