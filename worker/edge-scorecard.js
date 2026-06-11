// worker/edge-scorecard.js
// ─────────────────────────────────────────────────────────────────────────────
//  B5 (2026-06-11) — Nightly Edge Scorecard: the "are we good yet" number.
//
//  Computed honestly every night from the live trade ledger + the Signal
//  Outcome Ledger, across MULTIPLE windows (7/30/90d — a single window
//  misleads; see tasks/lessons.md performance-analysis recipe), per
//  setup × direction, vs an SPY buy-hold baseline.
//
//  Outputs ONE KV artifact (`timed:edge:scorecard`) consumed by:
//   • the operator's morning view (GET /timed/admin/edge-scorecard)
//   • the Scrimmage Room scoreboard (C2)
//   • the learning bus — setups bleeding over 90d (n>=10, PF<0.8) are
//     submitted as tier-2 demotion proposals (operator always decides;
//     never auto-applied).
//
//  Pure stats core pinned by worker/edge-scorecard.test.js.
// ─────────────────────────────────────────────────────────────────────────────

import { summarizeSignalOutcomes } from "./signal-outcomes.js";

const DAY_MS = 86400000;

/**
 * Window stats from closed trades. Pure.
 * trades: [{ status: WIN|LOSS|FLAT, pnl, pnl_pct }]
 */
export function computeWindowStats(trades) {
  let wins = 0;
  let losses = 0;
  let flats = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let pnlSum = 0;
  let pnlPctSum = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const t of trades || []) {
    const pnl = Number(t?.pnl) || 0;
    const pnlPct = Number(t?.pnl_pct) || 0;
    pnlSum += pnl;
    pnlPctSum += pnlPct;
    if (t?.status === "WIN") { wins++; grossWin += Math.max(0, pnl); }
    else if (t?.status === "LOSS") { losses++; grossLoss += Math.abs(Math.min(0, pnl)); }
    else flats++;
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const n = wins + losses + flats;
  const decided = wins + losses;
  return {
    n,
    wins,
    losses,
    flats,
    win_rate_pct: decided > 0 ? Math.round((wins / decided) * 1000) / 10 : null,
    profit_factor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? 99 : null),
    pnl_usd: Math.round(pnlSum * 100) / 100,
    expectancy_usd: n > 0 ? Math.round((pnlSum / n) * 100) / 100 : null,
    expectancy_pct: n > 0 ? Math.round((pnlPctSum / n) * 100) / 100 : null,
    max_drawdown_usd: Math.round(maxDrawdown * 100) / 100,
  };
}

/** Setups bleeding badly enough to propose demotion (operator decides). */
export function findDemotionCandidates(perSetup, opts = {}) {
  const minN = Number(opts.minN) || 10;
  const maxPf = Number(opts.maxPf) || 0.8;
  return (perSetup || []).filter((s) =>
    s.stats?.n >= minN
    && s.stats?.profit_factor != null
    && s.stats.profit_factor < maxPf,
  ).map((s) => ({
    setup: s.setup,
    direction: s.direction,
    n: s.stats.n,
    profit_factor: s.stats.profit_factor,
    win_rate_pct: s.stats.win_rate_pct,
    pnl_usd: s.stats.pnl_usd,
  }));
}

/** Honest one-line flags about the current edge state. Pure. */
export function deriveEdgeFlags(windows, spyBaseline) {
  const flags = [];
  const d30 = windows?.d30;
  const d90 = windows?.d90;
  if (d30?.n >= 10 && d30.expectancy_usd != null && d30.expectancy_usd <= 0) {
    flags.push("30d expectancy is non-positive — the engine is not making money this month");
  }
  if (d30?.profit_factor != null && d30.n >= 10 && d30.profit_factor < 1) {
    flags.push(`30d profit factor ${d30.profit_factor} < 1`);
  }
  if (d90?.n >= 20 && spyBaseline?.d90_pct != null && d90.expectancy_pct != null) {
    // Rough apples-to-apples: per-trade expectancy% vs market drift over the window.
    if (d90.pnl_usd <= 0 && spyBaseline.d90_pct > 0) {
      flags.push(`90d P&L flat-to-negative while SPY drifted +${spyBaseline.d90_pct}% — no edge over buy-hold this quarter`);
    }
  }
  if (d30?.max_drawdown_usd != null && d30.pnl_usd != null && d30.max_drawdown_usd > Math.abs(d30.pnl_usd) * 2 && d30.max_drawdown_usd > 500) {
    flags.push(`30d drawdown $${d30.max_drawdown_usd} dwarfs the period P&L — path risk is high`);
  }
  if (flags.length === 0 && d30?.n >= 10) {
    flags.push("no structural red flags in the trailing 30d");
  }
  return flags;
}

/**
 * Build the full scorecard (D1 + KV reads). Returns the artifact; caller
 * persists + routes proposals.
 */
export async function buildEdgeScorecard(env, opts = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error_kind: "no_db" };
  const now = Number(opts.now) || Date.now();
  const since90 = now - 90 * DAY_MS;

  let rows = [];
  try {
    rows = (await db.prepare(
      `SELECT ticker, direction, setup_name, setup_grade, status, pnl, pnl_pct, exit_reason, exit_ts
         FROM trades
        WHERE status IN ('WIN','LOSS','FLAT') AND exit_ts >= ?1
        ORDER BY exit_ts ASC LIMIT 3000`
    ).bind(since90).all())?.results || [];
  } catch (e) {
    return { ok: false, error_kind: "trades_read_failed", hint: String(e?.message || e).slice(0, 200) };
  }

  const inWindow = (days) => rows.filter((r) => Number(r.exit_ts) >= now - days * DAY_MS);
  const windows = {
    d7: computeWindowStats(inWindow(7)),
    d30: computeWindowStats(inWindow(30)),
    d90: computeWindowStats(rows),
  };

  // Per setup × direction over 90d.
  const bySetup = new Map();
  for (const r of rows) {
    const key = `${r.setup_name || "unknown"}|${r.direction || "?"}`;
    if (!bySetup.has(key)) bySetup.set(key, []);
    bySetup.get(key).push(r);
  }
  const perSetup = [...bySetup.entries()]
    .map(([key, list]) => {
      const [setup, direction] = key.split("|");
      return { setup, direction, stats: computeWindowStats(list) };
    })
    .filter((s) => s.stats.n >= 3)
    .sort((a, b) => (b.stats.pnl_usd || 0) - (a.stats.pnl_usd || 0));

  // Exit-reason aggregates (where the money actually comes from / leaks).
  const byExit = new Map();
  for (const r of rows) {
    const key = String(r.exit_reason || "unknown");
    if (!byExit.has(key)) byExit.set(key, []);
    byExit.get(key).push(r);
  }
  const perExitReason = [...byExit.entries()]
    .map(([reason, list]) => ({ reason, stats: computeWindowStats(list) }))
    .filter((x) => x.stats.n >= 3)
    .sort((a, b) => (b.stats.pnl_usd || 0) - (a.stats.pnl_usd || 0));

  // SPY buy-hold baseline per window from D candles.
  const spyBaseline = {};
  try {
    const spy = (await db.prepare(
      `SELECT ts, c FROM ticker_candles WHERE ticker = 'SPY' AND tf = 'D' AND ts >= ?1 ORDER BY ts ASC LIMIT 200`
    ).bind(since90 - 5 * DAY_MS).all())?.results || [];
    const closeAtOrAfter = (ts) => spy.find((b) => Number(b.ts) >= ts)?.c;
    const lastClose = spy.length ? Number(spy[spy.length - 1].c) : null;
    for (const [label, days] of [["d7_pct", 7], ["d30_pct", 30], ["d90_pct", 90]]) {
      const start = Number(closeAtOrAfter(now - days * DAY_MS));
      spyBaseline[label] = (Number.isFinite(start) && start > 0 && Number.isFinite(lastClose))
        ? Math.round(((lastClose - start) / start) * 10000) / 100
        : null;
    }
  } catch { /* baseline best-effort */ }

  // Per-desk / per-source published-call grades from the Signal Outcome Ledger.
  let signalGroups = null;
  try {
    const sum = await summarizeSignalOutcomes(env, { days: 90 });
    if (sum?.ok) signalGroups = sum.groups;
  } catch { /* best-effort */ }

  const demotionCandidates = findDemotionCandidates(perSetup);
  const flags = deriveEdgeFlags(windows, spyBaseline);

  return {
    ok: true,
    computed_at: now,
    windows,
    per_setup: perSetup.slice(0, 30),
    per_exit_reason: perExitReason.slice(0, 20),
    spy_baseline: spyBaseline,
    signal_groups: signalGroups,
    demotion_candidates: demotionCandidates,
    flags,
  };
}
