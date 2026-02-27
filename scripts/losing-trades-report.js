#!/usr/bin/env node
/**
 * Generate a report of all losing trades with signal snapshots at entry.
 * For manual review: label as "valid loss" vs "bad trade" to demote signals.
 *
 * Usage: TIMED_API_KEY=your_key node scripts/losing-trades-report.js [--json] [--out FILE]
 */
const API_BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";

const args = process.argv.slice(2);
const outJson = args.includes("--json");
const outIdx = args.indexOf("--out");
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;

function msToDate(ms) {
  if (!Number.isFinite(ms)) return "?";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const pad = (s) => String(s).padStart(2, "0");
  return `${get("year")}-${pad(get("month"))}-${pad(get("day"))} ${pad(get("hour"))}:${pad(get("minute"))}:${pad(get("second"))} ET`;
}

function formatSignals(snap) {
  if (!snap) return "(no snapshot)";
  try {
    const parsed = typeof snap === "string" ? JSON.parse(snap) : snap;
    if (!parsed?.tf || typeof parsed.tf !== "object") return "(empty)";
    const lines = [];
    for (const [tf, data] of Object.entries(parsed.tf)) {
      const sigs = data?.signals;
      if (!sigs || typeof sigs !== "object") continue;
      const parts = [];
      for (const [k, v] of Object.entries(sigs)) {
        if (v != null && Number.isFinite(v)) parts.push(`${k}=${v}`);
      }
      if (parts.length) lines.push(`  ${tf}: ${parts.join(", ")}`);
    }
    return lines.length ? lines.join("\n") : "(no signals)";
  } catch {
    return "(parse error)";
  }
}

async function main() {
  const url = `${API_BASE}/timed/admin/losing-trades-report?key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url);
  const json = await res.json();

  if (!json.ok) {
    console.error("Error:", json.error || "request_failed");
    if (json.error === "not_found") {
      console.error("Hint: Deploy the worker first (wrangler deploy) so the losing-trades-report endpoint is available.");
    }
    process.exit(1);
  }

  const trades = json.trades || [];

  if (outJson || outFile?.endsWith(".json")) {
    const payload = { generated_at: new Date().toISOString(), count: trades.length, trades };
    const str = JSON.stringify(payload, null, 2);
    if (outFile) {
      const fs = await import("fs");
      fs.writeFileSync(outFile, str, "utf8");
      console.log(`Wrote ${trades.length} losing trades to ${outFile}`);
    } else {
      console.log(str);
    }
    return;
  }

  // Human-readable report
  const lines = [
    "╔══════════════════════════════════════════════════════════════════════════════╗",
    "║  LOSING TRADES REPORT — Signal snapshots at entry for manual review        ║",
    "╚══════════════════════════════════════════════════════════════════════════════╝",
    "",
    `Total losing trades: ${trades.length}`,
    "",
  ];

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    lines.push("────────────────────────────────────────────────────────────────────────────");
    lines.push(`${i + 1}. ${t.ticker} ${t.direction}`);
    lines.push(`   Entry:  ${msToDate(t.entry_ts)} @ $${t.entry_price}`);
    lines.push(`   Exit:   ${msToDate(t.exit_ts)} @ $${t.exit_price}`);
    lines.push(`   P&L:    $${t.pnl ?? "?"} (${t.pnl_pct != null ? t.pnl_pct.toFixed(2) : "?"}%)`);
    if (t.exit_reason) lines.push(`   Reason: ${t.exit_reason}`);
    if (t.entry_path) lines.push(`   Path:   ${t.entry_path}`);
    lines.push("   Signals at entry:");
    lines.push(formatSignals(t.signal_snapshot_json));
    lines.push("");
  }

  const report = lines.join("\n");
  if (outFile) {
    const fs = await import("fs");
    fs.writeFileSync(outFile, report, "utf8");
    console.log(`Wrote report (${trades.length} trades) to ${outFile}`);
  } else {
    console.log(report);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
