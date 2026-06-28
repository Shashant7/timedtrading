#!/usr/bin/env node
// scripts/investor-accuracy-report.mjs
//
// Investor Mode accuracy report. Answers two questions the deep dive
// (tasks/2026-06-28-investor-mode-deep-dive.md) flagged as un-measured:
//
//   1. Is the signal-outcome loop actually grading investor calls now?
//      (resolver-starvation fix, PR #878). Prints the by-source ledger.
//   2. Do FSD picks (GRNY/GRNJ/GRNI holdings) outperform non-FSD names in the
//      realized closed-trade record? — i.e. is anchoring on the Fundstrat
//      buy-list justified? Computes WR / sum P&L / payoff by FSD tier.
//
// Read-only. Usage:
//   TIMED_API_KEY=... node scripts/investor-accuracy-report.mjs [--days=120] [--write]
//
// Caveat: FSD membership/weight is CURRENT (not at-trade-time), so the tier
// split is directional, not point-in-time exact.

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const KEY = process.env.TIMED_API_KEY || process.env.TIMED_TRADING_API_KEY || "";
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) || "").split("=")[1]) || 120;
const WRITE = process.argv.includes("--write");

if (!KEY) { console.error("TIMED_API_KEY (or TIMED_TRADING_API_KEY) required"); process.exit(1); }

async function getJSON(path) {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}key=${KEY}`;
  const r = await fetch(url, { headers: { "X-API-Key": KEY } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
  return r.json();
}

// ── FSD weight map from the 3 holdings endpoints ───────────────────────────
async function buildFsdWeightMap() {
  const map = {}; // TICKER -> { GRNY: w, GRNJ: w, GRNI: w }
  for (const etf of ["GRNY", "GRNJ", "GRNI"]) {
    try {
      const d = await getJSON(`/timed/etf/holdings/${etf}`);
      for (const h of (d.holdings || [])) {
        const tk = String(h.ticker || "").toUpperCase();
        if (!tk) continue;
        (map[tk] = map[tk] || {})[etf] = Number(h.weight) || 0;
      }
    } catch (e) { console.error(`  warn: ${etf} holdings: ${e.message}`); }
  }
  return map;
}

function fsdTier(weights) {
  if (!weights) return "none";
  const vals = Object.values(weights).filter((w) => Number.isFinite(w) && w > 0);
  if (vals.length === 0) return "none";
  const max = Math.max(...vals);
  if (max >= 3 || vals.length >= 2) return "strong";
  if (max >= 1) return "core";
  return "light";
}

function stat(rows) {
  const pnls = rows.map((t) => Number(t.pnl)).filter((p) => Number.isFinite(p));
  const w = pnls.filter((p) => p > 0), l = pnls.filter((p) => p < 0);
  const sum = pnls.reduce((a, b) => a + b, 0);
  const avgW = w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0;
  const avgL = l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0;
  return {
    n: pnls.length, wins: w.length, losses: l.length,
    wr: pnls.length ? (100 * w.length / pnls.length) : 0,
    sum, avgW, avgL, payoff: avgL ? avgW / Math.abs(avgL) : (avgW > 0 ? Infinity : 0),
  };
}

const fmt = (s) => `n=${s.n} · W/L ${s.wins}/${s.losses} · WR ${s.wr.toFixed(0)}% · ΣP&L ${s.sum >= 0 ? "+" : ""}$${s.sum.toFixed(0)} · payoff ${Number.isFinite(s.payoff) ? s.payoff.toFixed(2) : "∞"}`;

(async () => {
  console.error(`[investor-accuracy] base=${BASE} days=${DAYS}`);
  const out = [];
  const p = (s = "") => { out.push(s); console.log(s); };

  p(`# Investor Mode — Accuracy Report`);
  p(``);
  p(`_Generated ${new Date().toISOString()} · window ${DAYS}d · base ${BASE}_`);
  p(``);

  // 1. Signal-outcome loop health
  p(`## 1. Signal-outcome loop (is grading running?)`);
  p(``);
  try {
    const so = await getJSON(`/timed/admin/signal-outcomes?days=${DAYS}`);
    const groups = so?.summary?.groups || [];
    p(`| source | desk | n | resolved | open | win_rate |`);
    p(`|---|---|---:|---:|---:|---:|`);
    for (const g of groups) {
      p(`| ${g.source} | ${g.desk} | ${g.n} | ${g.resolved} | ${g.open} | ${g.win_rate ?? "—"} |`);
    }
    const inv = groups.find((g) => g.source === "investor_action");
    p(``);
    if (inv) {
      p(inv.resolved > 0
        ? `Investor signals are grading: **${inv.resolved}/${inv.n}** resolved (WR ${inv.win_rate ?? "—"}).`
        : `Investor signals logged (**${inv.n}**) but **0 resolved** — all younger than the 60-day horizon. They grade as they mature (resolver no longer starved per PR #878).`);
    } else {
      p(`No investor_action rows in window.`);
    }
  } catch (e) { p(`_signal-outcomes unavailable: ${e.message}_`); }
  p(``);

  // 2. Realized closed-trade record by FSD tier
  p(`## 2. Realized investor record by FSD tier`);
  p(``);
  p(`_Does anchoring on the Fundstrat buy-list pay? FSD membership is current (not at-trade-time) — directional._`);
  p(``);
  try {
    const [tradesResp, fsdMap] = await Promise.all([
      getJSON(`/timed/ledger/trades?mode=investor&status=closed&limit=2000`),
      buildFsdWeightMap(),
    ]);
    const closed = (tradesResp.trades || []).filter(
      (t) => t.pnl != null && (t.exit_ts || String(t.status || "").toUpperCase() !== "OPEN"),
    );
    const byTier = { strong: [], core: [], light: [], none: [] };
    for (const t of closed) {
      const tier = fsdTier(fsdMap[String(t.ticker || "").toUpperCase()]);
      byTier[tier].push(t);
    }
    const fsdAll = [...byTier.strong, ...byTier.core, ...byTier.light];
    p(`| cohort | ${"".padEnd(2)} |`);
    p(`|---|---|`);
    p(`| **All closed** | ${fmt(stat(closed))} |`);
    p(`| **FSD picks (any)** | ${fmt(stat(fsdAll))} |`);
    p(`| — strong | ${fmt(stat(byTier.strong))} |`);
    p(`| — core | ${fmt(stat(byTier.core))} |`);
    p(`| — light | ${fmt(stat(byTier.light))} |`);
    p(`| **Non-FSD** | ${fmt(stat(byTier.none))} |`);
    p(``);
    const fsdStat = stat(fsdAll), nonStat = stat(byTier.none);
    if (fsdStat.n >= 5 && nonStat.n >= 5) {
      const wrDelta = (fsdStat.wr - nonStat.wr).toFixed(0);
      p(`**FSD vs non-FSD:** WR ${fsdStat.wr.toFixed(0)}% vs ${nonStat.wr.toFixed(0)}% (${wrDelta >= 0 ? "+" : ""}${wrDelta}pts), `
        + `avg P&L/trade $${(fsdStat.sum / Math.max(1, fsdStat.n)).toFixed(0)} vs $${(nonStat.sum / Math.max(1, nonStat.n)).toFixed(0)}. `
        + `${fsdStat.wr > nonStat.wr ? "Anchoring on the FSD buy-list is supported by the realized record." : "FSD tier did not out-perform in this sample — revisit the relief sizing."}`);
    } else {
      p(`_Not enough closed trades per cohort for a confident split (need ≥5 each)._`);
    }
  } catch (e) { p(`_closed-trade record unavailable: ${e.message}_`); }
  p(``);
  p(`---`);
  p(`_Re-run: \`TIMED_API_KEY=… node scripts/investor-accuracy-report.mjs --days=${DAYS}\`_`);

  if (WRITE) {
    const dir = resolve(REPO, "data/trade-analysis");
    mkdirSync(dir, { recursive: true });
    const f = resolve(dir, `investor-accuracy-${new Date().toISOString().slice(0, 10)}.md`);
    writeFileSync(f, out.join("\n"));
    console.error(`[investor-accuracy] wrote ${f}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
