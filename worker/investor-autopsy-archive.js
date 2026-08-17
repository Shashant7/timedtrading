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
  // live-long-term-YYYY-MM books are investor grading archives too.
  return id.startsWith("investor-slice-")
    || id.includes("investor")
    || id.includes("long-term")
    || id.includes("long_term");
}

export function shouldIncludeOpenAutopsyTrades({ runId, includeOpen, tags } = {}) {
  if (includeOpen === true || includeOpen === 1 || includeOpen === "1") return true;
  if (isInvestorAutopsyRunId(runId)) return true;
  const tagList = Array.isArray(tags) ? tags : [];
  // include_open is how a live trader month says "these positions are still
  // running and I want to grade their entries anyway".
  const OPEN_TAGS = new Set(["investor", "long_term", "include_open"]);
  if (tagList.some((t) => OPEN_TAGS.has(String(t).trim().toLowerCase()))) {
    return true;
  }
  return false;
}

function parseJsonObject(raw) {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasRenderableTfSnapshot(snapRaw) {
  const snap = parseJsonObject(snapRaw);
  if (!snap?.tf || typeof snap.tf !== "object") return false;
  return Object.keys(snap.tf).length > 0;
}

/**
 * Map investor decision_records.inputs_json into a Trade Autopsy signal
 * snapshot shape. Investor never wrote trader-style direction_accuracy rows;
 * decision_records are the durable ENTRY/EXIT signal capture for long-term.
 */
export function buildInvestorSignalSnapshotFromDecision(inputs = {}, { eventType = "ENTRY" } = {}) {
  const inp = inputs && typeof inputs === "object" ? inputs : {};
  const h4 = inp.h4_timing && typeof inp.h4_timing === "object" ? inp.h4_timing : null;
  // Prefer full TF grid stamped at decision time (future entries); fall back
  // to 4H-only from h4_timing for older decision_records.
  const tf = (inp.tf && typeof inp.tf === "object") ? { ...inp.tf } : {};
  if (h4 && !tf["4H"]) {
    let supertrend = null;
    if (h4.is4hBull === true) supertrend = 1;
    else if (h4.is4hBear === true) supertrend = -1;
    else if (Number.isFinite(Number(h4.stDir))) {
      // Prefer explicit bull/bear flags; fall back to stDir sign.
      const d = Number(h4.stDir);
      supertrend = d > 0 ? 1 : d < 0 ? -1 : 0;
    }
    let stSlope = null;
    if (h4.stSlopeUp === true) stSlope = 1;
    else if (h4.stSlopeDn === true) stSlope = -1;
    else if (Number.isFinite(Number(h4.stSlope)) && Number(h4.stSlope) !== 0) {
      stSlope = Number(h4.stSlope) > 0 ? 1 : -1;
    }
    tf["4H"] = {
      bias: null,
      signals: {
        ...(supertrend != null ? { supertrend } : {}),
        ...(stSlope != null ? { st_slope: stSlope } : {}),
      },
    };
  }

  const components = inp.components && typeof inp.components === "object" ? inp.components : null;
  const accum = inp.accum_zone && typeof inp.accum_zone === "object" ? inp.accum_zone : null;
  const fsd = inp.fsd && typeof inp.fsd === "object" ? inp.fsd : null;

  return {
    source: "investor_decision_records",
    event_type: String(eventType || "ENTRY").toUpperCase(),
    avg_bias: null,
    tf,
    investor: {
      reason: inp.reason || null,
      stage: inp.stage || null,
      stage_reason: inp.stage_reason || null,
      score: num(inp.score),
      action_tier: inp.action_tier || null,
      sim_eligible: inp.sim_eligible ?? null,
      components,
      accum_zone: accum,
      fsd,
      h4_timing: h4,
      market_health: num(inp.market_health),
      thesis: inp.thesis || null,
      primary_invalidation: inp.primary_invalidation || null,
      auto_rebalance: inp.auto_rebalance || null,
      price: num(inp.price),
      shares: num(inp.shares),
      ts: num(inp.ts),
    },
    lineage: {
      source: "investor_decision_records",
      regime_class: null,
      volatility_tier: null,
      vix_at_entry: null,
    },
  };
}

/**
 * Load ENTRY/EXIT decision_records for investor position ids and attach
 * signal_snapshot_json / exit_snapshot_json when missing.
 */
export async function hydrateInvestorAutopsySignalsFromDecisions(db, trades) {
  const list = Array.isArray(trades) ? trades : [];
  if (!db || !list.length) return list;

  const needIds = [];
  for (const t of list) {
    const id = String(t?.trade_id || t?.id || "").trim();
    if (!id) continue;
    const needEntry = !hasRenderableTfSnapshot(t.signal_snapshot_json) && !parseJsonObject(t.signal_snapshot_json)?.investor;
    const needExit = !hasRenderableTfSnapshot(t.exit_snapshot_json) && !parseJsonObject(t.exit_snapshot_json)?.investor;
    if (needEntry || needExit) needIds.push(id);
  }
  const uniq = [...new Set(needIds)];
  if (!uniq.length) return list;

  const byPosition = new Map(); // position_id -> { ENTRY, EXIT }
  const CHUNK = 40;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const ph = chunk.map((_, idx) => `?${idx + 1}`).join(",");
    let rows = [];
    try {
      const res = await db.prepare(
        `SELECT event_type, trade_id, ts, inputs_json,
                json_extract(inputs_json, '$.position_id') AS position_id
           FROM decision_records
          WHERE engine = 'investor'
            AND event_type IN ('ENTRY', 'EXIT', 'TRIM', 'ADD')
            AND json_extract(inputs_json, '$.position_id') IN (${ph})
          ORDER BY ts ASC`,
      ).bind(...chunk).all();
      rows = res?.results || [];
    } catch (e) {
      // Older D1 without json_extract — fall back to LIKE scan per id.
      for (const id of chunk) {
        try {
          const res = await db.prepare(
            `SELECT event_type, trade_id, ts, inputs_json
               FROM decision_records
              WHERE engine = 'investor'
                AND event_type IN ('ENTRY', 'EXIT', 'TRIM', 'ADD')
                AND inputs_json LIKE ?1
              ORDER BY ts ASC
              LIMIT 20`,
          ).bind(`%"position_id":"${id}"%`).all();
          for (const row of res?.results || []) {
            rows.push({ ...row, position_id: id });
          }
        } catch (_) { /* ignore */ }
      }
    }
    for (const row of rows) {
      const pid = String(row.position_id || "").trim();
      if (!pid) continue;
      const et = String(row.event_type || "").toUpperCase();
      const inputs = parseJsonObject(row.inputs_json) || {};
      const bucket = byPosition.get(pid) || {};
      if (et === "ENTRY" && !bucket.ENTRY) bucket.ENTRY = inputs;
      if ((et === "EXIT" || et === "TRIM") && !bucket.EXIT) bucket.EXIT = inputs;
      // Prefer last EXIT if multiple.
      if (et === "EXIT") bucket.EXIT = inputs;
      byPosition.set(pid, bucket);
    }
  }

  for (const t of list) {
    const id = String(t?.trade_id || t?.id || "").trim();
    const bucket = byPosition.get(id);
    if (!bucket) continue;
    if (bucket.ENTRY && !hasRenderableTfSnapshot(t.signal_snapshot_json) && !parseJsonObject(t.signal_snapshot_json)?.investor) {
      t.signal_snapshot_json = JSON.stringify(buildInvestorSignalSnapshotFromDecision(bucket.ENTRY, { eventType: "ENTRY" }));
    }
    if (bucket.EXIT && !hasRenderableTfSnapshot(t.exit_snapshot_json) && !parseJsonObject(t.exit_snapshot_json)?.investor) {
      t.exit_snapshot_json = JSON.stringify(buildInvestorSignalSnapshotFromDecision(bucket.EXIT, { eventType: "EXIT" }));
    }
  }
  return list;
}

/**
 * For archived trader books, brda may be empty while live direction_accuracy
 * still has the entry/exit snapshots (live-short-term-2026-07 case).
 */
export async function hydrateAutopsySignalsFromDirectionAccuracy(db, trades) {
  const list = Array.isArray(trades) ? trades : [];
  if (!db || !list.length) return list;

  const needIds = list
    .filter((t) => !hasRenderableTfSnapshot(t?.signal_snapshot_json) || !hasRenderableTfSnapshot(t?.exit_snapshot_json))
    .map((t) => String(t?.trade_id || t?.id || "").trim())
    .filter(Boolean);
  const uniq = [...new Set(needIds)];
  if (!uniq.length) return list;

  const byId = new Map();
  const CHUNK = 80;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const ph = chunk.map((_, idx) => `?${idx + 1}`).join(",");
    try {
      const { results } = await db.prepare(
        `SELECT trade_id, signal_snapshot_json, exit_snapshot_json, entry_path,
                max_favorable_excursion, max_adverse_excursion, tf_stack_json, ts
           FROM direction_accuracy
          WHERE trade_id IN (${ph})
          ORDER BY COALESCE(ts, 0) DESC`,
      ).bind(...chunk).all();
      for (const row of results || []) {
        const id = String(row.trade_id || "").trim();
        if (!id || byId.has(id)) continue; // first = newest
        byId.set(id, row);
      }
    } catch (_) { /* table missing — noop */ }
  }

  for (const t of list) {
    const id = String(t?.trade_id || t?.id || "").trim();
    const da = byId.get(id);
    if (!da) continue;
    if (!hasRenderableTfSnapshot(t.signal_snapshot_json) && da.signal_snapshot_json) {
      t.signal_snapshot_json = da.signal_snapshot_json;
    }
    if (!hasRenderableTfSnapshot(t.exit_snapshot_json) && da.exit_snapshot_json) {
      t.exit_snapshot_json = da.exit_snapshot_json;
    }
    if (!t.entry_path && da.entry_path) t.entry_path = da.entry_path;
    if (t.max_favorable_excursion == null && da.max_favorable_excursion != null) {
      t.max_favorable_excursion = da.max_favorable_excursion;
    }
    if (t.max_adverse_excursion == null && da.max_adverse_excursion != null) {
      t.max_adverse_excursion = da.max_adverse_excursion;
    }
    if (!t.tf_stack_json && da.tf_stack_json) t.tf_stack_json = da.tf_stack_json;
  }
  return list;
}

/**
 * Fill missing autopsy signal snapshots for a trade list.
 * Trader path → direction_accuracy; investor path → decision_records.
 */
export async function hydrateAutopsyTradeSignals(db, trades, { runId } = {}) {
  const list = Array.isArray(trades) ? trades : [];
  if (!db || !list.length) return list;
  await hydrateAutopsySignalsFromDirectionAccuracy(db, list);
  if (isInvestorAutopsyRunId(runId) || list.some((t) => String(t?.entry_path || "").includes("investor") || t?.mode === "investor")) {
    await hydrateInvestorAutopsySignalsFromDecisions(db, list);
  }
  return list;
}

function num(v, fallback = null) {
  // Number(null) and Number("") are both 0, which would turn a NULL closed_at
  // into a real close timestamp and archive every open position as closed.
  if (v == null || v === "") return fallback;
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
  const closedAt = num(pos.closed_at);
  const isClosed = posStatus === "CLOSED" || lastSell != null || (closedAt != null && closedAt > 0);

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

  // Prefer stamped entry_provenance_json (includes TF grid for post-2026-08 entries).
  let signalSnapshot = null;
  const prov = pos.entry_provenance_json || pos.entryProvenanceJson || null;
  if (prov) {
    try {
      const parsed = typeof prov === "string" ? JSON.parse(prov) : prov;
      if (parsed && typeof parsed === "object") {
        signalSnapshot = buildInvestorSignalSnapshotFromDecision(
          { ...parsed, reason: parsed.stage_reason || parsed.reason || "investor_entry" },
          { eventType: "ENTRY" },
        );
      }
    } catch (_) { signalSnapshot = null; }
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
    signal_snapshot_json: signalSnapshot ? JSON.stringify(signalSnapshot) : null,
    entry_provenance_json: typeof prov === "string" ? prov : (prov ? JSON.stringify(prov) : null),
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
            first_entry_ts, closed_at, investor_stage, thesis, created_at,
            entry_provenance_json
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
  try {
    await db.prepare(`DELETE FROM backtest_run_direction_accuracy WHERE run_id = ?1`).bind(rid).run();
  } catch (_) { /* brda table may be missing on older envs */ }

  let brdaCount = 0;
  for (const trade of list) {
    await archiveTrade(env, rid, trade);
    const wrote = await archiveInvestorAutopsyDirectionAccuracy(db, rid, trade);
    if (wrote) brdaCount += 1;
  }

  return {
    ok: true,
    run_id: rid,
    month,
    count: list.length,
    brda_count: brdaCount,
    summary,
    autopsy_url: autopsyUrl,
  };
}

/**
 * Persist Autopsy signal snapshots into backtest_run_direction_accuracy so
 * future investor books are self-contained (no on-read hydrate required).
 */
export async function archiveInvestorAutopsyDirectionAccuracy(db, runId, trade) {
  if (!db || !runId || !trade) return false;
  const tradeId = String(trade.trade_id || trade.id || "").trim();
  if (!tradeId) return false;
  const entrySnap = trade.signal_snapshot_json
    || (trade.signal_snapshot ? (() => {
      try { return JSON.stringify(trade.signal_snapshot); } catch (_) { return null; }
    })() : null);
  const exitSnap = trade.exit_snapshot_json
    || (trade.exit_snapshot ? (() => {
      try { return JSON.stringify(trade.exit_snapshot); } catch (_) { return null; }
    })() : null);
  if (!entrySnap && !exitSnap) return false;
  const ticker = String(trade.ticker || "").toUpperCase() || null;
  let ts = Number(trade.entry_ts);
  if (!Number.isFinite(ts) || ts <= 0) ts = Date.now();
  if (ts < 1e12) ts = ts * 1000;
  const entryPath = trade.entry_path || "investor_long_term";
  const exitReason = trade.exit_reason || null;
  try {
    await db.prepare(
      `INSERT OR REPLACE INTO backtest_run_direction_accuracy
         (run_id, trade_id, ticker, ts, signal_snapshot_json, exit_snapshot_json,
          entry_path, exit_reason)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      String(runId),
      tradeId,
      ticker,
      ts,
      entrySnap,
      exitSnap,
      entryPath,
      exitReason,
    ).run();
    return true;
  } catch (e) {
    console.warn("[INVESTOR_AUTOPSY] brda archive failed:", String(e?.message || e).slice(0, 140));
    return false;
  }
}
