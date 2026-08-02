/**
 * Archive investor positions (opened in a month) into backtest_run_trades
 * so Trade Autopsy can grade long-term / Investor Mode books the same way
 * as monthly trader slices.
 */

export function monthRangeMs(monthStr) {
  const m = String(monthStr || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) {
    throw new Error("month_must_be_YYYY-MM");
  }
  const [y, mo] = m.split("-").map(Number);
  const startMs = Date.UTC(y, mo - 1, 1, 0, 0, 0, 0);
  const endMsExclusive = Date.UTC(y, mo, 1, 0, 0, 0, 0);
  const startDate = `${m}-01`;
  const endDay = new Date(endMsExclusive - 1).getUTCDate();
  const endDate = `${m}-${String(endDay).padStart(2, "0")}`;
  return { startMs, endMsExclusive, startDate, endDate };
}

export function isInvestorAutopsyRunId(runId) {
  const id = String(runId || "").trim().toLowerCase();
  if (!id) return false;
  return id.startsWith("investor-slice-") || id.includes("investor");
}

export function shouldIncludeOpenAutopsyTrades({ runId, includeOpen, tags } = {}) {
  if (includeOpen === true || includeOpen === 1 || includeOpen === "1") return true;
  if (isInvestorAutopsyRunId(runId)) return true;
  const tagList = Array.isArray(tags) ? tags : [];
  if (tagList.some((t) => String(t).toLowerCase() === "investor" || String(t).toLowerCase() === "long_term")) {
    return true;
  }
  return false;
}

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function deriveClosedStatus(pnl) {
  const n = num(pnl, 0);
  if (n > 0) return "WIN";
  if (n < 0) return "LOSS";
  return "FLAT";
}

/**
 * Map one investor position + its lots into a Trade Autopsy / backtest_run_trades row.
 * Uses the first BUY as entry and the last SELL as exit when present.
 */
export function mapInvestorPositionToAutopsyTrade(position, lots = []) {
  const pos = position || {};
  const tradeId = String(pos.id || pos.trade_id || "").trim();
  const ticker = String(pos.ticker || "").trim().toUpperCase();
  if (!tradeId || !ticker) return null;

  const orderedLots = [...(Array.isArray(lots) ? lots : [])].sort(
    (a, b) => (num(a?.ts, 0) - num(b?.ts, 0)),
  );
  const buyLots = orderedLots.filter((l) => String(l?.action || "").toUpperCase() === "BUY" || String(l?.action || "").toUpperCase() === "DCA_BUY");
  const sellLots = orderedLots.filter((l) => String(l?.action || "").toUpperCase() === "SELL");
  const firstBuy = buyLots[0] || null;
  const lastSell = sellLots.length ? sellLots[sellLots.length - 1] : null;

  const entryTs = num(firstBuy?.ts) ?? num(pos.first_entry_ts) ?? num(pos.created_at);
  const entryPrice = num(firstBuy?.price) ?? num(pos.avg_entry);
  const shares = num(firstBuy?.shares) ?? num(pos.total_shares);
  const notional = num(firstBuy?.value) ?? (entryPrice != null && shares != null ? entryPrice * shares : null);

  const posStatus = String(pos.status || "").toUpperCase();
  const isClosed = posStatus === "CLOSED" || lastSell != null || num(pos.closed_at) != null;

  let exitTs = null;
  let exitPrice = null;
  let exitReason = null;
  let pnl = null;
  let pnlPct = null;
  let status = "OPEN";

  if (isClosed && lastSell) {
    exitTs = num(lastSell.ts) ?? num(pos.closed_at);
    exitPrice = num(lastSell.price);
    exitReason = String(lastSell.reason || "investor_exit");
    if (entryPrice != null && exitPrice != null && shares != null) {
      pnl = (exitPrice - entryPrice) * shares;
      pnlPct = entryPrice !== 0 ? ((exitPrice / entryPrice) - 1) * 100 : null;
    }
    status = deriveClosedStatus(pnl);
  } else if (isClosed && !lastSell) {
    // Closed without a sell lot — still surface for grading.
    exitTs = num(pos.closed_at);
    exitReason = "investor_closed";
    status = "FLAT";
  }

  return {
    trade_id: tradeId,
    id: tradeId,
    ticker,
    direction: "LONG",
    status,
    entry_ts: entryTs,
    entry_price: entryPrice,
    entryPrice,
    exit_ts: exitTs,
    exit_price: exitPrice,
    exitPrice,
    exit_reason: exitReason,
    exitReason,
    pnl,
    pnl_pct: pnlPct,
    pnlPct,
    shares,
    notional,
    trimmed_pct: 0,
    setup_name: "Investor Long Term",
    setupName: "Investor Long Term",
    entry_path: "investor_long_term",
    entryPath: "investor_long_term",
    horizon: "long_term",
    mode: "investor",
    investor_stage: pos.investor_stage || null,
    thesis: pos.thesis || null,
  };
}

export function summarizeAutopsyTrades(trades) {
  const list = Array.isArray(trades) ? trades : [];
  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  let openTrades = 0;
  let realizedPnl = 0;
  const tickers = new Set();
  const winPcts = [];
  const lossPcts = [];
  for (const t of list) {
    const sym = String(t?.ticker || "").toUpperCase();
    if (sym) tickers.add(sym);
    const st = String(t?.status || "").toUpperCase();
    if (st === "OPEN" || st === "TP_HIT_TRIM") {
      openTrades += 1;
      continue;
    }
    const pnl = num(t?.pnl, 0);
    realizedPnl += pnl;
    const pct = num(t?.pnl_pct ?? t?.pnlPct);
    if (st === "WIN" || pnl > 0) {
      wins += 1;
      if (pct != null) winPcts.push(pct);
    } else if (st === "LOSS" || pnl < 0) {
      losses += 1;
      if (pct != null) lossPcts.push(pct);
    } else {
      breakevens += 1;
    }
  }
  const closed = wins + losses + breakevens;
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  return {
    total_tickers_traded: tickers.size,
    total_trades: list.length,
    wins,
    losses,
    breakevens,
    open_trades: openTrades,
    closed_trades: closed,
    win_rate: closed > 0 ? wins / closed : 0,
    realized_pnl: realizedPnl,
    realized_pnl_pct: 0,
    avg_win_pct: avg(winPcts),
    avg_loss_pct: avg(lossPcts),
  };
}

/**
 * Build autopsy trade rows from D1 investor tables for positions opened in month.
 * includeOpen=true keeps still-OPEN positions (default true).
 */
export async function loadInvestorAutopsyTradesFromDb(db, { month, includeOpen = true } = {}) {
  const { startMs, endMsExclusive } = monthRangeMs(month);
  const { results: positions } = await db.prepare(
    `SELECT id, ticker, status, avg_entry, total_shares, cost_basis,
            first_entry_ts, closed_at, investor_stage, thesis, created_at
       FROM investor_positions
      WHERE first_entry_ts >= ?1 AND first_entry_ts < ?2
      ORDER BY first_entry_ts ASC, ticker ASC`,
  ).bind(startMs, endMsExclusive).all();

  const rows = [];
  for (const pos of positions || []) {
    if (!includeOpen && String(pos.status || "").toUpperCase() === "OPEN") continue;
    const { results: lots } = await db.prepare(
      `SELECT id, position_id, ticker, action, shares, price, value, ts, reason
         FROM investor_lots
        WHERE position_id = ?1
        ORDER BY ts ASC`,
    ).bind(pos.id).all();
    const trade = mapInvestorPositionToAutopsyTrade(pos, lots || []);
    if (trade) rows.push(trade);
  }
  return rows;
}

/**
 * Accept pre-built trade objects (cross-env import) and normalize them.
 */
export function normalizeImportedInvestorTrades(trades) {
  const out = [];
  for (const raw of Array.isArray(trades) ? trades : []) {
    if (raw?.lots || raw?.position) {
      const mapped = mapInvestorPositionToAutopsyTrade(raw.position || raw, raw.lots || []);
      if (mapped) out.push(mapped);
      continue;
    }
    const mapped = mapInvestorPositionToAutopsyTrade(
      {
        id: raw.trade_id || raw.id,
        ticker: raw.ticker,
        status: raw.status === "OPEN" ? "OPEN" : (raw.exit_ts || raw.exit_price ? "CLOSED" : raw.status),
        avg_entry: raw.entry_price ?? raw.entryPrice,
        total_shares: raw.shares,
        first_entry_ts: raw.entry_ts,
        closed_at: raw.exit_ts,
        investor_stage: raw.investor_stage,
        thesis: raw.thesis,
      },
      [
        raw.entry_ts != null
          ? {
              action: "BUY",
              shares: raw.shares,
              price: raw.entry_price ?? raw.entryPrice,
              value: raw.notional,
              ts: raw.entry_ts,
              reason: "import_entry",
            }
          : null,
        raw.exit_ts != null
          ? {
              action: "SELL",
              shares: raw.shares,
              price: raw.exit_price ?? raw.exitPrice,
              value: null,
              ts: raw.exit_ts,
              reason: raw.exit_reason || raw.exitReason || "import_exit",
            }
          : null,
      ].filter(Boolean),
    );
    if (mapped) {
      // Preserve explicit status/pnl from importer when present.
      if (raw.status) mapped.status = String(raw.status).toUpperCase();
      if (raw.pnl != null) mapped.pnl = num(raw.pnl);
      if (raw.pnl_pct != null || raw.pnlPct != null) {
        mapped.pnl_pct = num(raw.pnl_pct ?? raw.pnlPct);
        mapped.pnlPct = mapped.pnl_pct;
      }
      out.push(mapped);
    }
  }
  return out;
}

export function buildInvestorAutopsyRunMeta({ runId, month, tradeCount, source }) {
  const { startDate, endDate } = monthRangeMs(month);
  return {
    run_id: runId,
    label: runId,
    description: `Investor (long-term) positions opened in ${month} — Trade Autopsy grading book`,
    start_date: startDate,
    end_date: endDate,
    tags: ["investor", "long_term", "trade-autopsy", month],
    params: {
      horizon: "long_term",
      mode: "investor",
      source: source || "investor_positions",
      opened_in_month: month,
      trade_count: tradeCount,
    },
    status: "completed",
  };
}

/**
 * Persist investor autopsy trades into backtest_runs / metrics / backtest_run_trades.
 * `archiveTrade(env, runId, trade)` should be the worker's d1ArchiveRunTrade (or equivalent).
 */
export async function persistInvestorAutopsyArchive(env, {
  runId,
  month,
  trades,
  source = "investor_positions",
  archiveTrade,
} = {}) {
  const db = env?.DB;
  if (!db) throw new Error("d1_not_configured");
  const rid = String(runId || "").trim();
  if (!rid) throw new Error("run_id_required");
  if (typeof archiveTrade !== "function") throw new Error("archiveTrade_required");

  const list = Array.isArray(trades) ? trades : [];
  const meta = buildInvestorAutopsyRunMeta({
    runId: rid,
    month,
    tradeCount: list.length,
    source,
  });
  const summary = summarizeAutopsyTrades(list);
  const now = Date.now();
  const tagsJson = JSON.stringify(meta.tags);
  const paramsJson = JSON.stringify(meta.params);
  const autopsyUrl = `/trade-autopsy.html?run_id=${encodeURIComponent(rid)}`;

  await db.prepare(
    `INSERT OR REPLACE INTO backtest_runs (
       run_id, label, description, start_date, end_date, interval_min, ticker_batch,
       ticker_universe_count, trader_only, keep_open_at_end, low_write, status, status_note,
       live_config_slot, active_experiment_slot, is_protected_baseline, tags_json, params_json,
       manifest_json, metrics_json, created_at, started_at, ended_at, updated_at
     ) VALUES (
       ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?21,?21,?21
     )`,
  ).bind(
    rid,
    meta.label,
    meta.description,
    meta.start_date,
    meta.end_date,
    1440,
    0,
    summary.total_tickers_traded,
    0,
    1,
    0,
    "completed",
    `investor autopsy archive · opened in ${month} · n=${list.length}`,
    0,
    0,
    0,
    tagsJson,
    paramsJson,
    JSON.stringify({
      runId: rid,
      label: meta.label,
      horizon: "long_term",
      mode: "investor",
      opened_in_month: month,
      source,
    }),
    JSON.stringify(summary),
    now,
  ).run();

  await db.prepare(
    `INSERT OR REPLACE INTO backtest_run_metrics (
       run_id, total_tickers_traded, total_trades, wins, losses, breakevens, open_trades,
       closed_trades, win_rate, realized_pnl, realized_pnl_pct, avg_win_pct, avg_loss_pct,
       classifications_json, by_status_json, autopsy_url, updated_at
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
  ).bind(
    rid,
    summary.total_tickers_traded,
    summary.total_trades,
    summary.wins,
    summary.losses,
    summary.breakevens,
    summary.open_trades,
    summary.closed_trades,
    summary.win_rate,
    summary.realized_pnl,
    summary.realized_pnl_pct,
    summary.avg_win_pct,
    summary.avg_loss_pct,
    null,
    JSON.stringify({
      WIN: summary.wins,
      LOSS: summary.losses,
      FLAT: summary.breakevens,
      OPEN: summary.open_trades,
    }),
    autopsyUrl,
    now,
  ).run();

  // Replace prior archive rows for this run so re-imports are idempotent.
  await db.prepare(`DELETE FROM backtest_run_trades WHERE run_id = ?1`).bind(rid).run();

  for (const trade of list) {
    await archiveTrade(env, rid, trade);
  }

  return {
    ok: true,
    run_id: rid,
    month,
    count: list.length,
    summary,
    autopsy_url: autopsyUrl,
  };
}
