#!/usr/bin/env node
/**
 * Cloud Pivot desk — super-minion pass over the scored book.
 * Run via vite-node so CJS sector-mapping interop matches vitest.
 *
 * Stares at 10m 5/12, 10m 34/50, 1H/4H magnets, day2, and BTC/ETH/SPY/QQQ
 * leader curls. Does NOT require an RTH session window (weekend/night watch).
 * Does NOT port the 3m kitchen sink.
 *
 *   node scripts/scan-cloud-pivot-desk.mjs
 *   node scripts/scan-cloud-pivot-desk.mjs --snapshot /tmp/timed-all-snapshot.json
 *   node scripts/scan-cloud-pivot-desk.mjs --limit 16
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildCloudPivotDesk } from "../worker/foundation/tt-cloud-pivot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "data", "cloud-pivot-desk");

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return fallback;
}

const SNAP_PATH = flag("snapshot");
const LIMIT = Number(flag("limit") || 24);
const MIN_SCORE = Number(flag("min-score") || 30);
const FETCH_PATH = flag("fetch-to") || "/tmp/timed-all-snapshot.json";

function loadSnapshot(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const map = raw?.data || raw?.map || raw?.tickers || raw || {};
  if (Array.isArray(map)) {
    return map.map((t) => ({
      sym: String(t?.ticker || "").toUpperCase(),
      t,
    }));
  }
  return Object.entries(map).map(([sym, t]) => ({
    sym: String(sym).toUpperCase(),
    t,
  }));
}

function fetchRemoteSnapshot(outPath) {
  const wrangler = join(ROOT, "node_modules", ".bin", "wrangler");
  const r = spawnSync(wrangler, [
    "kv", "key", "get",
    "--remote",
    "--binding=KV_TIMED",
    "--env", "production",
    "timed:all:snapshot",
  ], {
    cwd: join(ROOT, "worker"),
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout || r.stdout.startsWith("Value not found")) {
    throw new Error(`kv get failed: ${(r.stderr || r.stdout || "").slice(0, 400)}`);
  }
  writeFileSync(outPath, r.stdout);
  return outPath;
}

function fmtPx(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(2) : x.toFixed(4);
}

function lineFor(row) {
  const mag = row.magnet?.px != null
    ? `magnet $${fmtPx(row.magnet.px)} ${row.magnet.label || ""}`.trim()
    : "no HTF magnet";
  const curl = row.curl?.trigger ? row.curl.trigger.replace(/_/g, " ") : "no 10m curl";
  const gate = row.session_plan
    ? (row.direction === "SHORT"
      ? `short under $${fmtPx(row.session_plan.short_under)}`
      : `long over $${fmtPx(row.session_plan.long_over)}`)
    : null;
  const bits = [
    row.ticker,
    row.role,
    row.direction || "—",
    curl,
    mag,
    row.dist_pct != null ? `${row.dist_pct.toFixed(2)}% away` : null,
    gate,
    row.leader_follow?.leader ? `follow ${row.leader_follow.leader}` : null,
    row.day2 ? "day2" : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

function renderReport(desk) {
  const lines = [
    "# Cloud Pivot desk",
    "",
    `Scanned ${desk.scanned} names. Showing ${desk.count} (min score ${MIN_SCORE}).`,
    "Weekend/night still ranks magnets, mixed-cloud, day2, and leaders.",
    "Paper 0.1×. No 3m kitchen sink.",
    "",
    "## Watching",
    "",
    "| Ticker | Role | Dir | Score | 10m | Magnet | Dist | Notes |",
    "|---|---|---|---:|---|---|---:|---|",
  ];
  for (const r of desk.watching) {
    lines.push(`| ${r.ticker} | ${r.role} | ${r.direction || "—"} | ${r.score} | ${r.curl?.trigger || "—"} | ${r.magnet ? `$${fmtPx(r.magnet.px)} ${r.magnet.label}` : "—"} | ${r.dist_pct != null ? r.dist_pct.toFixed(2) + "%" : "—"} | ${(r.why || []).join(", ")} |`);
  }
  lines.push("", "## Leaders", "");
  if (!desk.leaders.length) lines.push("None in the cut.");
  else for (const r of desk.leaders) lines.push(`- ${lineFor(r)}`);
  lines.push("", "## Fires (session or last stamp)", "");
  if (!desk.fires.length) lines.push("None in the cut.");
  else for (const r of desk.fires) lines.push(`- ${lineFor(r)}`);
  lines.push("");
  return lines.join("\n");
}

const snapFile = SNAP_PATH || FETCH_PATH;
if (!SNAP_PATH) {
  console.log("Fetching timed:all:snapshot from production KV…");
  fetchRemoteSnapshot(snapFile);
}

const rows = loadSnapshot(snapFile);
const desk = buildCloudPivotDesk(rows, { limit: LIMIT, minScore: MIN_SCORE });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(desk, null, 2));
writeFileSync(join(OUT_DIR, "report.md"), renderReport(desk));
writeFileSync(join(OUT_DIR, "tickers.json"), JSON.stringify(rows.map((r) => r.sym).sort(), null, 2));

console.log(renderReport(desk));
console.log(`Wrote ${join(OUT_DIR, "report.md")} and summary.json`);
