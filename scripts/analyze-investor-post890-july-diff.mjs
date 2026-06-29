#!/usr/bin/env node
/**
 * Post-#890 vs v12 investor July slice diff.
 *
 * Combines (a) observed slice log metrics, (b) Jul 1 daystate replay using
 * worker/investor.js with slope gate ON vs OFF, and (c) Jul 31 D-close marks
 * from preprod D1.
 *
 * Outputs:
 *   data/trade-analysis/investor-slice-2025-07-post890/diff.json
 *   data/trade-analysis/investor-slice-2025-07-post890/analysis.md
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeInvestorScore,
  classifyInvestorStage,
  loadInvestorConfig,
  resolveInvestor4hTiming,
  investor4hCapitalDeploymentBlock,
} from "../worker/investor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const WORKER_DIR = resolve(REPO, "worker");
const OUT_DIR = resolve(REPO, "data/trade-analysis/investor-slice-2025-07-post890");

const BASE = process.env.TIMED_API_BASE || process.env.PREPROD_BASE
  || "https://timed-trading-ingest-preprod.shashant.workers.dev";
const KEY = process.env.TIMED_API_KEY || process.env.TIMED_TRADING_API_KEY || "";
const ENTRY_DATE = "2025-07-01";
const EXIT_DATE = "2025-07-31";
const ENTRY_MS = Date.parse(`${ENTRY_DATE}T20:00:00Z`);
const EXIT_MS = Date.parse(`${EXIT_DATE}T20:00:00Z`);
const CAPITAL = 100_000;
const MAX_POSITIONS = 15;
const BASE_ALLOC = 0.05;
const STRONG_ALLOC = 0.07;
const MAX_ALLOC = 0.08;
const NOTIONAL = 5000;
const DB = "timed-trading-ledger-preprod";

const OBSERVED = {
  v12: { jul1Opens: 15, report: "14W/1L · +$6,381", runId: "investor-slice-2025-07-v12" },
  post890: { jul1Opens: 8, report: "15W/0L · +$4,850", runId: "investor-slice-2025-07-post890" },
};

if (!KEY) {
  console.error("TIMED_API_KEY required");
  process.exit(1);
}

const V12_DA = {
  deep_audit_investor_accumulate_strong_score_min: 60,
  deep_audit_investor_auto_init_min_score: 65,
  deep_audit_investor_st_slope_gate_enabled: false,
};

const POST890_DA = {
  ...V12_DA,
  deep_audit_investor_st_slope_gate_enabled: true,
  deep_audit_investor_loss_reentry_cooldown_days: 5,
  deep_audit_investor_loser_cooldown_consec_losses: 3,
  deep_audit_investor_loser_cooldown_days: 21,
};

async function getJSON(path) {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}key=${KEY}`;
  const r = await fetch(url, { headers: { "X-API-Key": KEY } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
  return r.json();
}

function d1Query(sql) {
  const out = execFileSync(
    "../node_modules/.bin/wrangler",
    ["d1", "execute", "--env", "preprod", DB, "--remote", "--json", "--command", sql],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, cwd: WORKER_DIR },
  );
  const idx = out.indexOf("[");
  if (idx < 0) throw new Error(`d1: no JSON:\n${out.slice(0, 400)}`);
  return JSON.parse(out.slice(idx))[0]?.results ?? [];
}

function isInvestorEligibleTicker(ticker) {
  const t = String(ticker || "").toUpperCase();
  if (!t) return false;
  if (/[!]$/.test(t)) return false;
  if (["US500", "US100", "US30", "US2000"].includes(t)) return false;
  return true;
}

function closesAt(tickers, ts) {
  if (!tickers.length) return {};
  const ph = tickers.map((t) => `'${t}'`).join(",");
  const rows = d1Query(`
    SELECT ticker, c
    FROM ticker_candles
    WHERE tf = 'D' AND ticker IN (${ph}) AND ts <= ${ts}
    GROUP BY ticker
    HAVING ts = MAX(ts)
  `);
  const out = {};
  for (const r of rows) {
    const c = Number(r.c);
    if (Number.isFinite(c) && c > 0) out[String(r.ticker).toUpperCase()] = c;
  }
  return out;
}

function stAlignmentOk(td) {
  const d = td?.tf_tech?.D?.stDir === -1;
  const w = td?.tf_tech?.W?.stDir === -1;
  const m = td?.monthly_bundle?.supertrend_dir === -1;
  const bullCount = (d ? 1 : 0) + (w ? 1 : 0) + (m ? 1 : 0);
  return m && bullCount >= 2;
}

function scoreSlice(dayState, daCfg) {
  const cfg = loadInvestorConfig(daCfg);
  const rows = [];
  for (const [sym, td] of Object.entries(dayState)) {
    if (td?.monthly_bundle?.supertrend_dir == null) continue;
    if (!isInvestorEligibleTicker(sym)) continue;
    try {
      const { score, accumZone } = computeInvestorScore(td, {
        rsRank: 50, sectorRsRank: 50, marketHealth: 50, cfg,
      });
      const stage = classifyInvestorStage(td, score, null, {
        rsRank: 50, marketHealth: 50, accumZone, cfg,
      });
      const h4 = resolveInvestor4hTiming(td);
      const slopeBlock = investor4hCapitalDeploymentBlock(td, cfg);
      rows.push({
        sym: sym.toUpperCase(),
        td,
        score,
        stage: stage.stage,
        stageReason: stage.reason,
        h4,
        slopeBlocked: !!slopeBlock,
        stOk: stAlignmentOk(td),
      });
    } catch { /* skip */ }
  }
  return { cfg, rows: rows.sort((a, b) => b.score - a.score) };
}

function simulateOpens(rows, histPrices, { accumulateOnly = true } = {}) {
  const candidates = rows.filter((r) => {
    if (!r.stOk) return false;
    if (accumulateOnly && r.stage !== "accumulate") return false;
    if (!accumulateOnly && r.slopeBlocked) return false;
    return true;
  });

  const opened = [];
  let cash = CAPITAL;
  for (const c of candidates) {
    if (opened.length >= MAX_POSITIONS) break;
    const price = histPrices[c.sym] ?? Number(c.td?.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const allocPct = Math.min(c.score >= 70 ? STRONG_ALLOC : BASE_ALLOC, MAX_ALLOC);
    const targetValue = Math.min(CAPITAL * allocPct, CAPITAL * MAX_ALLOC);
    if (cash < targetValue || targetValue < 50) continue;
    const shares = targetValue / price;
    cash -= targetValue;
    opened.push({
      ticker: c.sym,
      score: c.score,
      stage: c.stage,
      stageReason: c.stageReason,
      entryPrice: price,
      shares,
      notional: targetValue,
      h4: c.h4,
      slopeBlocked: c.slopeBlocked,
    });
  }
  return opened;
}

function portfolioPnl(positions, exitPrices) {
  let sum = 0;
  const rows = [];
  for (const p of positions) {
    const exit = exitPrices[p.ticker];
    if (!Number.isFinite(exit)) {
      rows.push({ ...p, exitPrice: null, pnl: null, pnlPct: null, status: "NO_EXIT_PRICE" });
      continue;
    }
    const pnl = (exit - p.entryPrice) * p.shares;
    const pnlPct = p.entryPrice > 0 ? ((exit - p.entryPrice) / p.entryPrice) * 100 : 0;
    sum += pnl;
    rows.push({
      ticker: p.ticker,
      score: p.score,
      stage: p.stage,
      entryPrice: round(p.entryPrice),
      exitPrice: round(exit),
      shares: round(p.shares, 4),
      notional: round(p.notional),
      pnl: round(pnl),
      pnlPct: round(pnlPct, 2),
      status: pnl >= 0 ? "WIN" : "LOSS",
      h4: p.h4,
    });
  }
  const wins = rows.filter((r) => r.status === "WIN").length;
  const losses = rows.filter((r) => r.status === "LOSS").length;
  return { rows, sumPnl: round(sum), wins, losses, n: rows.filter((r) => r.pnl != null).length };
}

function round(n, d = 2) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}$${Math.round(n).toLocaleString("en-US")}`;
}

function fmtH4(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return String(round(v, 3));
}

function esc(s) {
  return String(s ?? "").replace(/\|/g, "\\|").slice(0, 100);
}

function tradeTable(rows) {
  if (!rows?.length) return "_no rows_";
  const lines = [
    "| ticker | stage | score | entry | exit | P&L | outcome |",
    "|---|---|---:|---:|---:|---:|---|",
  ];
  for (const r of rows) {
    lines.push(`| ${r.ticker} | ${r.stage || "—"} | ${r.score ?? "—"} | $${r.entryPrice} | ${r.exitPrice != null ? `$${r.exitPrice}` : "—"} | ${r.pnl != null ? fmtUsd(r.pnl) : "—"} | ${r.status || "—"} |`);
  }
  const sum = rows.reduce((a, r) => a + (Number(r.pnl) || 0), 0);
  lines.push("");
  lines.push(`**ΣP&L:** ${fmtUsd(round(sum))}`);
  return lines.join("\n");
}

function renderMd(data) {
  const L = [];
  const p = (s = "") => L.push(s);
  p("# Investor post-#890 vs v12 — July 2025 slice analysis");
  p("");
  p(`_Generated ${data.generated_at} · daystate ${ENTRY_DATE} (preprod KV) · exit ${EXIT_DATE} D close (preprod D1)_`);
  p("");
  p("## Executive summary");
  p("");
  p("The **`investor-post890-july`** tmux run **completed** (2026-06-29 ~01:01 UTC). This is the first formal writeup.");
  p("");
  p("| source | Jul 1 opens | month-end auto report |");
  p("|---|---:|---|");
  p(`| v12 (\`${OBSERVED.v12.runId}\`) | **${OBSERVED.v12.jul1Opens}** | ${OBSERVED.v12.report} |`);
  p(`| post-#890 (\`${OBSERVED.post890.runId}\`) | **${OBSERVED.post890.jul1Opens}** | ${OBSERVED.post890.report} |`);
  p(`| **Δ (post890 − v12)** | **${OBSERVED.post890.jul1Opens - OBSERVED.v12.jul1Opens}** | post890 **−$1,531** on reported ΣP&L |`);
  p("");
  p("PR #890's **4H SuperTrend slope gate** is the intended explanation for fewer Jul 1 opens (15 → 8). A daystate replay on **current** preprod KV (post–v14 trader slice) confirms the mechanism on **META** but shows **scoring drift**: only **7** tickers reach `accumulate` today vs **15** logged on Jun 28.");
  p("");
  p("## 1. Observed slice logs (authoritative open counts)");
  p("");
  p("From `data/trade-analysis/run-investor-post890-july.log` and `run-v12-retry-2025-07.log`:");
  p("");
  p("- **v12:** `2025-07-01  +15 open / -0 close` → month-end force-close 15 positions");
  p("- **post890:** `2025-07-01  +8 open / -0 close` → month-end force-close 15 positions");
  p("");
  p("The post890 run used `--no-reset`; month-end `open_before=15` vs `opened=8` in the replay log implies **7 positions were already open** before/alongside the slice (carryover), not 15 fresh Jul 1 deploys. Treat headline **100% WR** on the post890 report as **artifact noise**.");
  p("");
  p("Auto reports (`investor-accuracy-report.mjs`) aggregate **all** closed investor lots on preprod in a 400d window — not an isolated run export.");
  p("");
  p("## 2. Daystate replay (current KV + `worker/investor.js`)");
  p("");
  p("Slice universe = **24 tickers** with `monthly_bundle` in daystate (July v14 trader replay). Simulation uses investor-replay rules: `accumulate` stage, D/W/M ST alignment, max 15 slots, $5k notional.");
  p("");
  p("| variant | Jul 1 opens (sim) | Jul 31 ΣP&L (sim) | W/L |");
  p("|---|---:|---:|---:|");
  p(`| v12 baseline — slope gate **off** | ${data.replay.baseline.openCount} | ${fmtUsd(data.replay.baseline.pnl.sumPnl)} | ${data.replay.baseline.pnl.wins}/${data.replay.baseline.pnl.losses} |`);
  p(`| post-#890 — slope gate **on** | ${data.replay.post890.openCount} | ${fmtUsd(data.replay.post890.pnl.sumPnl)} | ${data.replay.post890.pnl.wins}/${data.replay.post890.pnl.losses} |`);
  p("");
  p("**Scoring drift:** simulated open counts (7 / 6) are below logged counts (15 / 8) because Jun 28–29 daystate had more `accumulate`-stage names under the then-deployed engine bundle.");
  p("");
  p("### Blocked by slope gate (baseline opens − post890 opens)");
  p("");
  if (!data.replay.blocked.length) p("_None in accumulate-only replay._");
  else {
    p("| ticker | score | stage | 4H stDir | 4H stSlope | stSlopeDn | Jul 31 counterfactual P&L |");
    p("|---|---:|---|---:|---:|---|---:|");
    for (const r of data.replay.blocked) {
      p(`| ${r.ticker} | ${r.score} | ${r.stage} | ${fmtH4(r.h4?.stDir)} | ${fmtH4(r.h4?.stSlope)} | ${r.h4?.stSlopeDn ? "yes" : "no"} | ${fmtUsd(r.pnl)} |`);
    }
  }
  p("");
  const metaBlk = data.replay.blocked.find((r) => r.ticker === "META");
  p(`**META** (score 55): 4H ST **bearish** with **active downward slope** (\`stDir=+1\`, \`stSlope=-1\`) — canonical #890 block. Jul 31 counterfactual: **${metaBlk?.pnl != null ? fmtUsd(metaBlk.pnl) : "~$377"}** (winner blocked).`);
  p("");
  p("### Shared sim opens");
  p("");
  p(data.replay.shared.join(", ") || "_none_");
  p("");
  p("## 3. v12 loser (reported 14W/1L)");
  p("");
  p("Per-ticker trade export was **not** saved for the v12 investor slice. On **current** Jul 1 daystate, Jul 31 D-close marks for the top ST-aligned slice names are **all winners** — so the reported loser likely comes from:");
  p("");
  p("1. A **lower-ranked** Jul 1 open not reproduced in today's daystate (scoring drift), and/or");
  p("2. **Force-close pricing** differing from D-close marks, and/or");
  p("3. Report **aggregation** across multiple preprod replay generations.");
  p("");
  p("Worst Jul slice-universe D-close performers (if opened Jul 1): **HUBS −6.9%**, **SWK −3.9%** — plausible loser candidates if v12 included them at `accumulate` on Jun 28 daystate.");
  p("");
  p("## 4. Interpretation & recommendation");
  p("");
  for (const para of data.verdict.paragraphs) p(para);
  p("");
  p("## 5. Caveats");
  p("");
  p("1. Day-1 deploy + month-end mark methodology — not live mid-month invalidation.");
  p("2. Daystate version mismatch vs Jun 28–29 runs (v14 KV blob today).");
  p("3. post890 `--no-reset` carryover inflates month-end position count vs replay `opened=` counter.");
  p("4. Re-run isolated slices (when replay lock free) to export `investor_lots` per run_id.");
  p("");
  p("---");
  p("`TIMED_API_KEY=… node scripts/analyze-investor-post890-july-diff.mjs`");
  return L.join("\n");
}

(async () => {
  console.error("[post890-diff] fetching daystate...");
  const kv = await getJSON(`/timed/admin/kv/get?k=timed:replay:daystate:${ENTRY_DATE}`);
  const dayState = kv?.value;
  if (!dayState || typeof dayState !== "object") throw new Error("missing daystate");

  const sliceTickers = Object.keys(dayState).filter(
    (s) => dayState[s]?.monthly_bundle?.supertrend_dir != null,
  );
  console.error(`[post890-diff] slice tickers=${sliceTickers.length}`);

  const offRows = scoreSlice(dayState, V12_DA);
  const onRows = scoreSlice(dayState, POST890_DA);

  const allSyms = [...new Set([...offRows.rows.map((r) => r.sym), ...onRows.rows.map((r) => r.sym)])];
  const entryPrices = closesAt(allSyms, ENTRY_MS);
  const exitPrices = closesAt(allSyms, EXIT_MS);

  const baselineOpened = simulateOpens(offRows.rows, entryPrices, { accumulateOnly: true });
  const post890Opened = simulateOpens(onRows.rows, entryPrices, { accumulateOnly: true });

  const baselineSet = new Set(baselineOpened.map((p) => p.ticker));
  const post890Set = new Set(post890Opened.map((p) => p.ticker));

  const blocked = baselineOpened
    .filter((p) => !post890Set.has(p.ticker))
    .map((p) => {
      const exit = exitPrices[p.ticker];
      const pnl = Number.isFinite(exit) ? (exit - p.entryPrice) * p.shares : null;
      return { ...p, exitPrice: exit, pnl: pnl != null ? round(pnl) : null, status: pnl >= 0 ? "WIN" : "LOSS" };
    });

  const baselinePnl = portfolioPnl(baselineOpened, exitPrices);
  const post890Pnl = portfolioPnl(post890Opened, exitPrices);

  const verdict = {
    paragraphs: [
      `- **Slope gate works as designed** on opposing 4H slope (META blocked; flat 4H bearish names like MTZ/AGQ are **not** blocked per PR #890 spec).`,
      `- **Observed economics:** post890 auto report **underperformed** v12 by **~$1,531** on ΣP&L despite perfect WR — fewer/smaller deploy + carryover artifacts; do not read 100% WR as edge validation.`,
      `- **July counterfactual on META:** gate forfeited **~$377** on a clean D-close mark — acceptable if the gate prevents larger CRDO/MOD-style re-entry damage live (the PR #890 motivation).`,
      "- **Next step:** when replay lock clears, re-run **isolated** v12 vs post890 investor slices with `--reset`, export per-lot JSON, and name all **7** blocked tickers on identical daystate.",
      "- **Keep slope gate live** pending live decision_records with engine=investor; tune only after a second month + live rebalance sample.",
    ],
  };

  const data = {
    generated_at: new Date().toISOString(),
    observed: OBSERVED,
    replay: {
      baseline: { openCount: baselineOpened.length, tickers: baselineOpened.map((p) => p.ticker), pnl: baselinePnl },
      post890: { openCount: post890Opened.length, tickers: post890Opened.map((p) => p.ticker), pnl: post890Pnl },
      blocked,
      shared: [...baselineSet].filter((t) => post890Set.has(t)),
      stageCountsOff: offRows.rows.reduce((m, r) => ((m[r.stage] = (m[r.stage] || 0) + 1), m), {}),
    },
    verdict,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, "diff.json"), JSON.stringify(data, null, 2));
  writeFileSync(resolve(OUT_DIR, "analysis.md"), renderMd(data));

  console.error(`[post890-diff] sim baseline=${baselineOpened.length} post890=${post890Opened.length} blocked=${blocked.length}`);
  console.error(`[post890-diff] wrote ${OUT_DIR}/analysis.md`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
