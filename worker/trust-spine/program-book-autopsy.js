// Full-book autopsy: core vs paper experiments.
// Answers "are experiments polluting the backtested core?" by splitting
// fills on entry_path (canonical) vs family stamps, and flagging coincident
// paper stamps on a core path (the AXON crush class).

import { computeWindowStats } from "../edge-scorecard.js";
import { canonicalPlayId, playLabel } from "../foundation/play-catalog.js";
import { isCanonicalCapitalEntryPath } from "../foundation/confirm-stack-paper-queue.js";
import {
  classifyProgram,
  classifyClock,
  PROGRAM_LABELS,
  PROGRAM_ORDER,
  CONFIRM_STACK_FAMILY,
  CLOUD_PIVOT_FAMILY,
  CONTINUATION_FAMILY,
  CORE_PROGRAM,
} from "./program-timing.js";

const EXPERIMENT_KEYS = new Set([
  CONFIRM_STACK_FAMILY,
  CLOUD_PIVOT_FAMILY,
  CONTINUATION_FAMILY,
]);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function absMae(v) {
  const n = num(v);
  return n == null ? null : Math.abs(n);
}

function mean(arr) {
  if (!arr.length) return null;
  return Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 1000) / 1000;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 1000) / 1000;
}

function etMonth(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  const ms = n < 1e12 ? n * 1000 : n;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(ms));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return y && m ? `${y}-${m}` : "unknown";
}

function prettySetup(name) {
  const labeled = playLabel(name);
  if (labeled) return labeled;
  if (!name) return "(none)";
  let s = String(name).replace(/^TT\s+/i, "").replace(/^tt[_\s]+/i, "").trim();
  s = s.replace(/[_]+/g, " ").replace(/\s+/g, " ");
  s = s.replace(/\(\s*(long|short)\s*\)/ig, (_, d) => d);
  s = s.replace(/\b\w+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return s || "(none)";
}

function isUnstampedPath(path) {
  return !path || path === "(unstamped)" || path === "(null)";
}

function sizeLane(notional) {
  const n = num(notional);
  if (n == null || n <= 0) return "unknown";
  if (n < 2000) return "crushed_<2k";
  if (n < 8000) return "mid_2k_8k";
  return "fullish_>=8k";
}

/**
 * Dual classification:
 *  - program: experiment family or core
 *  - coincident: core canonical path that also carried a paper-family stamp
 */
export function classifyBookFill(trade = {}, decision = {}) {
  const path = String(trade.entry_path || "").trim();
  const stamped = classifyProgram(decision, trade);
  const canonical = isCanonicalCapitalEntryPath(path)
    && !EXPERIMENT_KEYS.has(path);
  const experiment = EXPERIMENT_KEYS.has(stamped);

  if (canonical && experiment) {
    return {
      program: CORE_PROGRAM,
      family_stamp: stamped,
      coincident_paper: true,
      lane: "core_coincident",
    };
  }
  if (experiment) {
    return {
      program: stamped,
      family_stamp: stamped,
      coincident_paper: false,
      lane: stamped,
    };
  }
  return {
    program: CORE_PROGRAM,
    family_stamp: null,
    coincident_paper: false,
    lane: path || "core",
  };
}

function toFill(trade, decision = {}) {
  const cls = classifyBookFill(trade, decision);
  const status = String(trade.status || "").toUpperCase();
  const closed = status === "WIN" || status === "LOSS" || status === "FLAT";
  const mfe = num(trade.max_favorable_excursion);
  const mae = absMae(trade.max_adverse_excursion);
  const pnlPct = num(trade.pnl_pct);
  const clock = classifyClock(trade.entry_ts);
  const keep = (pnlPct != null && mfe != null && mfe > 0)
    ? Math.round((pnlPct / mfe) * 1000) / 1000
    : null;
  return {
    trade_id: trade.trade_id,
    ticker: String(trade.ticker || "").toUpperCase(),
    direction: String(trade.direction || "").toUpperCase(),
    status,
    closed,
    pnl: num(trade.pnl) || 0,
    pnl_pct: pnlPct || 0,
    mfe: mfe != null && mfe > 0 ? mfe : null,
    mae,
    keep,
    notional: num(trade.notional),
    shares: num(trade.shares),
    entry_ts: num(trade.entry_ts),
    exit_reason: trade.exit_reason || "(none)",
    setup_name: prettySetup(trade.setup_name),
    setup_grade: trade.setup_grade || "(none)",
    entry_path: trade.entry_path || "(unstamped)",
    play_id: canonicalPlayId(trade.entry_path, trade.setup_name, trade.direction) || "(none)",
    sector: trade.sector || "(none)",
    month: etMonth(trade.entry_ts),
    size_lane: sizeLane(trade.notional),
    ...cls,
    ...clock,
  };
}

function summarize(fills) {
  const closed = fills.filter((f) => f.closed);
  const stats = computeWindowStats(closed.map((f) => ({
    status: f.status,
    pnl: f.pnl,
    pnl_pct: f.pnl_pct,
  })));
  const { n: _closedN, ...rest } = stats;
  const notionals = fills.map((f) => f.notional).filter((v) => v != null && v > 0);
  return {
    n: fills.length,
    open: fills.length - closed.length,
    closed: closed.length,
    ...rest,
    avg_mfe_pct: mean(closed.map((f) => f.mfe).filter((v) => v != null)),
    avg_mae_pct: mean(closed.map((f) => f.mae).filter((v) => v != null)),
    avg_keep: mean(closed.map((f) => f.keep).filter((v) => v != null)),
    avg_notional: mean(notionals),
    median_notional: median(notionals),
  };
}

function groupSummaries(fills, keyFn, { limit = 0, sort = "pnl" } = {}) {
  const map = new Map();
  for (const f of fills) {
    const key = keyFn(f);
    if (key == null || key === "") continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  let rows = [...map.entries()].map(([key, list]) => ({ key, ...summarize(list) }));
  if (sort === "pnl") rows.sort((a, b) => (a.pnl_usd || 0) - (b.pnl_usd || 0));
  else if (sort === "n") rows.sort((a, b) => b.n - a.n);
  else if (sort === "key") rows.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  if (limit > 0) rows = rows.slice(0, limit);
  return rows;
}

function tickerRows(fills, { winners = false, limit = 15, neverWon = false } = {}) {
  const rows = groupSummaries(fills.filter((f) => f.closed), (f) => f.ticker, { sort: "pnl" });
  if (neverWon) {
    return rows
      .filter((r) => r.closed >= 3 && (r.wins || 0) === 0 && (r.pnl_usd || 0) < 0)
      .sort((a, b) => (a.pnl_usd || 0) - (b.pnl_usd || 0))
      .slice(0, limit);
  }
  if (winners) {
    return rows.filter((r) => (r.pnl_usd || 0) > 0).sort((a, b) => (b.pnl_usd || 0) - (a.pnl_usd || 0)).slice(0, limit);
  }
  return rows.filter((r) => (r.pnl_usd || 0) < 0).sort((a, b) => (a.pnl_usd || 0) - (b.pnl_usd || 0)).slice(0, limit);
}

/**
 * @param {object} args
 * @param {Array} args.trades live trade rows
 * @param {Array} args.decisions ENTRY decision rows (or extracts)
 */
export function buildBookAutopsyReport({ trades = [], decisions = [] } = {}) {
  const byId = new Map();
  for (const d of decisions || []) {
    if (!d?.trade_id) continue;
    if (String(d.event_type || "ENTRY").toUpperCase() !== "ENTRY") continue;
    byId.set(String(d.trade_id), d);
  }

  const fills = (trades || []).map((t) => toFill(t, byId.get(String(t.trade_id)) || {
    inputs_json: t.slice_family || t.entry_family
      ? JSON.stringify({ slice_family: t.slice_family || t.entry_family })
      : undefined,
  }));

  const core = fills.filter((f) => f.program === CORE_PROGRAM);
  const experiments = fills.filter((f) => f.program !== CORE_PROGRAM);
  const coincident = fills.filter((f) => f.coincident_paper);
  const byProgram = {};
  for (const p of PROGRAM_ORDER) {
    byProgram[p] = {
      label: PROGRAM_LABELS[p] || p,
      ...summarize(fills.filter((f) => f.program === p)),
    };
  }

  const firstExpTs = experiments
    .map((f) => f.entry_ts)
    .filter((v) => v != null)
    .sort((a, b) => a - b)[0] || null;
  const firstFamilyTs = [...experiments, ...coincident]
    .map((f) => f.entry_ts)
    .filter((v) => v != null)
    .sort((a, b) => a - b)[0] || null;
  const firstStampedTs = fills
    .filter((f) => !isUnstampedPath(f.entry_path))
    .map((f) => f.entry_ts)
    .filter((v) => v != null)
    .sort((a, b) => a - b)[0] || null;

  const unstamped = core.filter((f) => isUnstampedPath(f.entry_path));
  const stampedClean = core.filter((f) => !isUnstampedPath(f.entry_path) && !f.coincident_paper);
  const stampedAll = core.filter((f) => !isUnstampedPath(f.entry_path));
  const coreBeforeStamp = firstStampedTs ? core.filter((f) => f.entry_ts < firstStampedTs) : core;
  const coreAfterStamp = firstStampedTs ? core.filter((f) => f.entry_ts >= firstStampedTs) : [];
  const coreBeforeFamily = firstFamilyTs ? core.filter((f) => f.entry_ts < firstFamilyTs) : core;
  const coreAfterFamily = firstFamilyTs ? core.filter((f) => f.entry_ts >= firstFamilyTs) : [];
  const coreBeforeExp = firstExpTs ? core.filter((f) => f.entry_ts < firstExpTs) : [];
  const coreAfterExp = firstExpTs ? core.filter((f) => f.entry_ts >= firstExpTs) : core;

  const blended = summarize(fills);
  const coreOnly = summarize(core);
  const expOnly = summarize(experiments);
  const coinOnly = summarize(coincident);
  const openFills = fills.filter((f) => !f.closed);

  return {
    ok: true,
    fills: fills.length,
    generated_at: Date.now(),
    first_experiment_ts: firstExpTs,
    first_family_stamp_ts: firstFamilyTs,
    first_stamped_path_ts: firstStampedTs,
    headline: {
      blended,
      core: coreOnly,
      experiments: expOnly,
      coincident: coinOnly,
      unstamped: summarize(unstamped),
      stamped_clean: summarize(stampedClean),
      stamped_all: summarize(stampedAll),
      pollution: {
        usd_drag: Math.round(((blended.pnl_usd || 0) - (coreOnly.pnl_usd || 0)) * 100) / 100,
        expectancy_pct_drag: (blended.expectancy_pct != null && coreOnly.expectancy_pct != null)
          ? Math.round((blended.expectancy_pct - coreOnly.expectancy_pct) * 100) / 100
          : null,
        win_rate_drag: (blended.win_rate_pct != null && coreOnly.win_rate_pct != null)
          ? Math.round((blended.win_rate_pct - coreOnly.win_rate_pct) * 10) / 10
          : null,
        coincident_n: coincident.length,
        coincident_pnl_usd: coinOnly.pnl_usd,
        standalone_experiment_n: experiments.length,
        note: "usd_drag = blended − core (standalone experiment $ only). Coincident paper stamps stay in CORE. If those  coincident rows are mis-read as experiments, the experiment book looks worse than it is.",
      },
    },
    programs: byProgram,
    core: {
      by_entry_path: groupSummaries(core, (f) => f.entry_path, { sort: "n" }),
      by_play: groupSummaries(core, (f) => f.play_id, { sort: "n" }),
      by_setup: groupSummaries(core, (f) => f.setup_name, { sort: "pnl" }),
      by_setup_winners: groupSummaries(core, (f) => f.setup_name, { sort: "pnl" })
        .filter((r) => (r.pnl_usd || 0) > 0)
        .sort((a, b) => (b.pnl_usd || 0) - (a.pnl_usd || 0))
        .slice(0, 12),
      by_setup_losers: groupSummaries(core, (f) => f.setup_name, { sort: "pnl" })
        .filter((r) => (r.pnl_usd || 0) < 0)
        .slice(0, 12),
      by_grade: groupSummaries(core, (f) => f.setup_grade, { sort: "n" }),
      by_session: groupSummaries(core, (f) => f.session_label, { sort: "n" }),
      by_direction: groupSummaries(core, (f) => f.direction, { sort: "n" }),
      by_month: groupSummaries(core, (f) => f.month, { sort: "key" }),
      by_exit: groupSummaries(core, (f) => f.exit_reason, { sort: "n" }),
      by_exit_pnl: groupSummaries(core, (f) => f.exit_reason, { sort: "pnl" }),
      by_sector: groupSummaries(core, (f) => f.sector, { sort: "pnl" }),
      winners: tickerRows(core, { winners: true, limit: 15 }),
      losers: tickerRows(core, { winners: false, limit: 15 }),
      never_won: tickerRows(core, { neverWon: true, limit: 15 }),
      stamped_clean_by_path: groupSummaries(stampedClean, (f) => f.entry_path, { sort: "n" }),
      experiment_named_exits: groupSummaries(
        core.filter((f) => /cloud_pivot|confirm_stack|paper/i.test(String(f.exit_reason || ""))),
        (f) => f.exit_reason,
        { sort: "n" },
      ),
      before_experiments: summarize(coreBeforeExp),
      after_experiments: summarize(coreAfterExp),
      before_stamped_path: summarize(coreBeforeStamp),
      after_stamped_path: summarize(coreAfterStamp),
      before_family_stamp: summarize(coreBeforeFamily),
      after_family_stamp: summarize(coreAfterFamily),
    },
    eras: {
      unstamped: summarize(unstamped),
      stamped_clean: summarize(stampedClean),
      coincident: coinOnly,
      stamped_all: summarize(stampedAll),
    },
    experiments: {
      by_program: PROGRAM_ORDER.filter((p) => p !== CORE_PROGRAM).map((p) => ({
        key: p,
        label: PROGRAM_LABELS[p],
        ...summarize(fills.filter((f) => f.program === p)),
      })),
      by_setup: groupSummaries(experiments, (f) => f.setup_name, { sort: "pnl" }),
      by_session: groupSummaries(experiments, (f) => f.session_label, { sort: "n" }),
      by_month: groupSummaries(experiments, (f) => f.month, { sort: "key" }),
      by_exit: groupSummaries(experiments, (f) => f.exit_reason, { sort: "n" }),
      winners: tickerRows(experiments, { winners: true, limit: 15 }),
      losers: tickerRows(experiments, { winners: false, limit: 15 }),
      coincident,
    },
    coincident: {
      by_entry_path: groupSummaries(coincident, (f) => f.entry_path, { sort: "n" }),
      by_family: groupSummaries(coincident, (f) => f.family_stamp || "(none)", { sort: "n" }),
      by_setup: groupSummaries(coincident, (f) => f.setup_name, { sort: "n" }),
      by_session: groupSummaries(coincident, (f) => f.session_label, { sort: "n" }),
      by_size: groupSummaries(coincident, (f) => f.size_lane, { sort: "n" }),
      by_ticker: groupSummaries(coincident, (f) => f.ticker, { sort: "n" }).slice(0, 20),
      winners: tickerRows(coincident, { winners: true, limit: 10 }),
      losers: tickerRows(coincident, { winners: false, limit: 10 }),
    },
    open_trades: openFills.map((f) => ({
      ticker: f.ticker,
      entry_path: f.entry_path,
      family_stamp: f.family_stamp,
      notional: f.notional,
      entry_ts: f.entry_ts,
    })),
    overlap_tickers: overlapTickers(core, experiments),
  };
}

function overlapTickers(core, experiments) {
  const coreBy = new Map();
  for (const f of core) {
    if (!coreBy.has(f.ticker)) coreBy.set(f.ticker, []);
    coreBy.get(f.ticker).push(f);
  }
  const rows = [];
  const seen = new Set();
  for (const f of experiments) {
    if (seen.has(f.ticker) || !coreBy.has(f.ticker)) continue;
    seen.add(f.ticker);
    rows.push({
      ticker: f.ticker,
      core: summarize(coreBy.get(f.ticker)),
      experiment: summarize(experiments.filter((x) => x.ticker === f.ticker)),
    });
  }
  rows.sort((a, b) => (a.core.pnl_usd + a.experiment.pnl_usd) - (b.core.pnl_usd + b.experiment.pnl_usd));
  return rows;
}

export { PROGRAM_LABELS, PROGRAM_ORDER, CORE_PROGRAM };
