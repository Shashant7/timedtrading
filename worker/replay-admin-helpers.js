function asBool(value) {
  if (typeof value === "boolean") return value;
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "y" || raw === "on";
}

export async function resetReplayState(args = {}) {
  const {
    env,
    KV,
    resetLedger = false,
    resetMl = false,
    skipTickerLatest = false,
    now = Date.now(),
    deps = {},
  } = args;
  const {
    kvGetJSON,
    kvPutJSON,
    classifyKanbanStage,
    deriveKanbanMeta,
    d1UpsertTickerLatest,
    d1UpsertTickerIndex,
    REPLAY_TRADES_KV_KEY,
    PORTFOLIO_KEY,
    normTicker,
    ctx,
  } = deps;

  const tickerIndex = skipTickerLatest ? [] : ((await kvGetJSON(KV, "timed:tickers")) || []);
  const tickers = Array.isArray(tickerIndex) ? tickerIndex : [];

  const resetPayload = (payload) => {
    if (!payload || typeof payload !== "object") return payload;
    payload.kanban_stage = null;
    payload.prev_kanban_stage = null;
    payload.prev_kanban_stage_ts = null;
    payload.kanban_meta = null;
    payload.kanban_cycle_enter_now_ts = null;
    payload.kanban_cycle_trigger_ts = null;
    payload.kanban_cycle_side = null;
    payload.entry_price = null;
    payload.entry_ts = null;
    payload.entry_change_pct = null;
    payload.flip_watch_score = null;
    payload.flip_watch_reasons = null;
    payload.flip_watch_until_ts = null;
    payload.move_status = null;
    payload.flags = payload.flags && typeof payload.flags === "object" ? payload.flags : {};
    payload.flags.flip_watch = false;
    for (const key of Object.keys(payload.flags)) {
      if (
        key.startsWith("forced_")
        || key === "recycled_from_archive"
        || key === "move_invalidated"
        || key === "move_completed"
      ) {
        try {
          delete payload.flags[key];
        } catch {}
      }
    }

    try {
      const stage = classifyKanbanStage(payload);
      payload.kanban_stage = stage;
      payload.kanban_meta = deriveKanbanMeta(payload, stage);
    } catch {
      payload.kanban_stage = null;
      payload.kanban_meta = null;
    }

    payload.reset_at = now;
    return payload;
  };

  const kvCleared = [];
  try {
    await KV.delete("timed:trades:all");
    kvCleared.push("timed:trades:all");
  } catch {}
  try {
    await KV.delete(REPLAY_TRADES_KV_KEY);
    kvCleared.push(REPLAY_TRADES_KV_KEY);
  } catch {}
  try {
    await KV.delete("timed:replay:running");
    kvCleared.push("timed:replay:running");
  } catch {}
  try {
    await KV.delete(PORTFOLIO_KEY);
    kvCleared.push(PORTFOLIO_KEY);
  } catch {}
  try {
    await KV.delete("timed:activity:feed");
    kvCleared.push("timed:activity:feed");
  } catch {}

  if (resetMl) {
    try {
      await KV.delete("timed:model:ml_v1");
      kvCleared.push("timed:model:ml_v1");
    } catch {}
    try {
      await KV.delete("timed:model:ml_v1:last_ts");
      kvCleared.push("timed:model:ml_v1:last_ts");
    } catch {}
  }

  const d1Cleared = [];
  try {
    if (env?.DB) {
      try {
        const archiveSql = "UPDATE trades SET status = 'ARCHIVED' WHERE status NOT IN ('WIN', 'LOSS', 'ARCHIVED')";
        const archiveResult = await env.DB.prepare(archiveSql).run();
        d1Cleared.push({ sql: archiveSql, changes: archiveResult?.meta?.changes ?? 0 });
      } catch {}

      if (resetLedger) {
        for (const sql of [
          "DELETE FROM execution_actions",
          "DELETE FROM lots",
          "DELETE FROM positions",
          "DELETE FROM trade_events",
          "DELETE FROM trades",
          "DELETE FROM alerts",
          "DELETE FROM ticker_latest",
          "DELETE FROM account_ledger",
          "DELETE FROM investor_positions",
          "DELETE FROM investor_lots",
          "DELETE FROM portfolio_snapshots",
        ]) {
          try {
            const result = await env.DB.prepare(sql).run();
            d1Cleared.push({ sql, changes: result?.meta?.changes ?? null });
          } catch {}
        }
      }

      if (resetMl) {
        try {
          const result = await env.DB.prepare("DELETE FROM ml_v1_queue").run();
          d1Cleared.push({ sql: "DELETE FROM ml_v1_queue", changes: result?.meta?.changes ?? null });
        } catch {}
      }
    }
  } catch {}

  const results = { processed: 0, updated: 0, skipped: 0, errors: [] };
  for (const tickerLike of tickers) {
    const ticker = normTicker(tickerLike);
    if (!ticker) continue;
    try {
      const latest = await kvGetJSON(KV, `timed:latest:${ticker}`);
      if (!latest || typeof latest !== "object") {
        results.skipped++;
        continue;
      }
      const next = resetPayload({ ...latest });
      await kvPutJSON(KV, `timed:latest:${ticker}`, next);
      try {
        const latestWrite = d1UpsertTickerLatest(env, ticker, next);
        const indexWrite = d1UpsertTickerIndex(env, ticker, next?.ts);
        if (ctx?.waitUntil) {
          ctx.waitUntil(latestWrite);
          ctx.waitUntil(indexWrite);
        }
      } catch {}
      results.updated++;
      results.processed++;
    } catch (error) {
      results.errors.push({ ticker: String(tickerLike), error: String(error?.message || error) });
    }
  }

  return {
    ok: true,
    message: "System reset complete (as-of now).",
    now,
    tickers: { total: tickers.length, ...results },
    kvCleared,
    d1Cleared,
    resetMl: !!resetMl,
    resetLedger: !!resetLedger,
    skipTickerLatest: !!skipTickerLatest,
    note: skipTickerLatest
      ? "Replay-safe reset complete. Trade/portfolio state was cleared without rewriting per-ticker latest payloads."
      : "Lanes recompute from fresh state; new KV simulated trades will be created as new data/alerts come in. D1 ledger is preserved unless resetLedger=1.",
  };
}

export async function closeReplayPositionsAtDate(args = {}) {
  const {
    env,
    KV,
    db,
    dateParam,
    runIdParam = "",
    deps = {},
  } = args;
  const {
    d1EnsureBacktestRunsSchema,
    nyWallTimeToUtcMs,
    kvGetJSON,
    kvPutJSON,
    clamp,
    TRADE_SIZE,
  } = deps;

  if (!db) return { ok: false, error: "no_db" };
  if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return { ok: false, error: "date required (YYYY-MM-DD)" };
  }

  const exitMs = nyWallTimeToUtcMs(dateParam, 16, 0, 0) || (new Date(`${dateParam}T21:00:00Z`).getTime());

  const tradeSelectColumns = (useFallbackLifecycleColumns = false, useFallbackRunIdColumn = false) => `
      SELECT trade_id, ticker, direction, entry_price, entry_ts, pnl, trimmed_pct,
             rank, rr, script_version, created_at, updated_at,
             ${useFallbackLifecycleColumns ? "NULL AS trim_ts, NULL AS trim_price," : "trim_ts, trim_price,"}
             ${useFallbackLifecycleColumns ? "NULL AS setup_name, NULL AS setup_grade, NULL AS risk_budget, NULL AS shares, NULL AS notional," : "setup_name, setup_grade, risk_budget, shares, notional,"}
             ${useFallbackRunIdColumn ? "NULL AS run_id" : "run_id"}
        FROM trades
  `;

  const archiveSelectColumns = (useFallbackLifecycleColumns = false, useFallbackRunIdColumn = false) => `
           SELECT ${useFallbackRunIdColumn ? "?1" : "COALESCE(run_id, ?1)"}, trade_id, ticker, direction, entry_ts, entry_price,
                  rank, rr, status, exit_ts, exit_price, exit_reason, trimmed_pct, pnl,
                  pnl_pct, script_version, created_at, updated_at,
                  ${useFallbackLifecycleColumns ? "NULL AS trim_ts, NULL AS trim_price," : "trim_ts, trim_price,"}
                  ${useFallbackLifecycleColumns ? "NULL AS setup_name, NULL AS setup_grade, NULL AS risk_budget, NULL AS shares, NULL AS notional" : "setup_name, setup_grade, risk_budget, shares, notional"}
             FROM trades
  `;

  async function loadTradeRows(sql, bindArgs = []) {
    try {
      return (await db.prepare(sql).bind(...bindArgs).all())?.results || [];
    } catch (error) {
      const msg = String(error?.message || error || "");
      if (!/no such column/i.test(msg)) throw error;
      let fallbackSql = sql
        .replace(tradeSelectColumns(false, false), tradeSelectColumns(/trim_ts|trim_price|setup_name|shares|notional/i.test(msg), /run_id/i.test(msg)))
        .replace(archiveSelectColumns(false, false), archiveSelectColumns(/trim_ts|trim_price|setup_name|shares|notional/i.test(msg), /run_id/i.test(msg)));
      if (/run_id/i.test(msg)) {
        fallbackSql = fallbackSql
          .replace(/AND \(run_id = \?1 OR trade_id IN \(([^)]+)\)\)/g, "AND trade_id IN ($1)")
          .replace(/AND run_id = \?1/g, "");
      }
      return (await db.prepare(fallbackSql).bind(...bindArgs).all())?.results || [];
    }
  }

  if (runIdParam) {
    await d1EnsureBacktestRunsSchema(env);
  }

  const archivedTradeIds = new Set();
  if (runIdParam) {
    try {
      const archivedRows = (await db.prepare(
        `SELECT trade_id FROM backtest_run_trades WHERE run_id = ?1`
      ).bind(runIdParam).all())?.results || [];
      for (const row of archivedRows) {
        const tradeId = String(row?.trade_id || "").trim();
        if (tradeId) archivedTradeIds.add(tradeId);
      }
    } catch (error) {
      console.warn("[CLOSE-REPLAY] archive trade lookup failed:", error);
    }
  }

  let openRows = [];
  if (runIdParam && archivedTradeIds.size > 0) {
    const ids = [...archivedTradeIds];
    const CHUNK = 90;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, idx) => `?${idx + 2}`).join(",");
      const rows = await loadTradeRows(
        `${tradeSelectColumns(false)}
          WHERE (status NOT IN ('WIN','LOSS','FLAT') OR status IS NULL)
            AND (run_id = ?1 OR trade_id IN (${placeholders}))`,
        [runIdParam, ...chunk],
      );
      openRows.push(...rows);
    }
  } else if (runIdParam) {
    openRows = await loadTradeRows(
      `${tradeSelectColumns(false)}
        WHERE (status NOT IN ('WIN','LOSS','FLAT') OR status IS NULL)
          AND run_id = ?1`,
      [runIdParam],
    );
  } else {
    openRows = await loadTradeRows(
      `${tradeSelectColumns(false)}
        WHERE status NOT IN ('WIN','LOSS','FLAT') OR status IS NULL`,
      [],
    );
  }

  const replayPrices = new Map();
  try {
    const priceRows = (await db.prepare(
      `SELECT ticker, price_close FROM trail_5m_facts WHERE bucket_ts <= ?1 ORDER BY bucket_ts DESC`
    ).bind(exitMs).all())?.results || [];
    for (const row of priceRows) {
      const sym = String(row.ticker).toUpperCase();
      if (!replayPrices.has(sym) && Number(row.price_close) > 0) {
        replayPrices.set(sym, Number(row.price_close));
      }
    }
  } catch {}
  try {
    const dateStart = exitMs - 5 * 86400000;
    const candleRows = (await db.prepare(
      `SELECT ticker, c FROM ticker_candles WHERE tf = 'D' AND ts >= ?1 AND ts <= ?2 ORDER BY ts DESC`
    ).bind(dateStart, exitMs).all())?.results || [];
    for (const row of candleRows) {
      const sym = String(row.ticker).toUpperCase();
      if (!replayPrices.has(sym) && Number(row.c) > 0) {
        replayPrices.set(sym, Number(row.c));
      }
    }
  } catch {}

  const stmts = [];
  let closed = 0;
  const details = [];

  const buildTradeCloseUpdate = (includeRunId = true) => `
      UPDATE trades
         SET status = ?1,
             exit_ts = ?2,
             exit_price = ?3,
             exit_reason = ?4,
             pnl = ?5,
             pnl_pct = ?6,
             updated_at = ?7${includeRunId ? `,
             run_id = COALESCE(run_id, ?8)` : ""}
       WHERE trade_id = ?${includeRunId ? "9" : "8"}
  `;

  for (const row of openRows) {
    const sym = String(row.ticker).toUpperCase();
    const entryPx = Number(row.entry_price);
    const lastPx = replayPrices.get(sym) || (KV ? Number((await kvGetJSON(KV, `timed:latest:${sym}`))?.price) || 0 : 0) || entryPx;
    const dir = String(row.direction).toUpperCase() === "SHORT" ? -1 : 1;
    const shares = entryPx > 0 ? TRADE_SIZE / entryPx : 0;
    const trimPct = Number(row.trimmed_pct) || 0;
    const remainingShares = shares * Math.max(0, 1 - trimPct);
    const realizedCarry = Number(row.pnl) || 0;
    const pnl = realizedCarry + ((lastPx - entryPx) * remainingShares * dir);
    const pnlPct = entryPx > 0 && shares > 0 ? (pnl / (entryPx * shares)) * 100 : 0;
    const status = pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "FLAT";

    stmts.push({
      includeRunId: true,
      args: [status, exitMs, lastPx, "replay_end_close", pnl, pnlPct, exitMs, runIdParam || null, row.trade_id],
    });
    details.push({ ticker: sym, dir: dir === 1 ? "LONG" : "SHORT", entryPx, exitPx: lastPx, pnl: Math.round(pnl * 100) / 100, status });
    closed++;
  }

  for (let i = 0; i < stmts.length; i += 100) {
    const chunk = stmts.slice(i, i + 100);
    try {
      await db.batch(chunk.map((stmt) => db.prepare(buildTradeCloseUpdate(stmt.includeRunId)).bind(...stmt.args)));
    } catch (error) {
      const msg = String(error?.message || error || "");
      if (!/no such column: run_id/i.test(msg)) throw error;
      await db.batch(chunk.map((stmt) => {
        const fallbackArgs = stmt.includeRunId ? stmt.args.slice(0, 7).concat(stmt.args[8]) : stmt.args;
        return db.prepare(buildTradeCloseUpdate(false)).bind(...fallbackArgs);
      }));
    }
  }

  try {
    const kvTrades = await kvGetJSON(KV, "timed:trades:all") || [];
    for (const trade of kvTrades) {
      const status = String(trade.status || "").toUpperCase();
      if (status !== "WIN" && status !== "LOSS" && status !== "FLAT") {
        const entryPx = Number(trade.entryPrice);
        const sym = String(trade.ticker).toUpperCase();
        const lastPx = replayPrices.get(sym) || entryPx;
        const dir = String(trade.direction).toUpperCase() === "SHORT" ? -1 : 1;
        const shares = Number(trade.shares) || (entryPx > 0 ? TRADE_SIZE / entryPx : 0);
        const trimPct = clamp(Number(trade.trimmedPct ?? trade.trimmed_pct ?? 0), 0, 1);
        const remainingShares = shares * Math.max(0, 1 - trimPct);
        const realizedCarry = Number.isFinite(Number(trade.realizedPnl))
          ? Number(trade.realizedPnl)
          : (Number.isFinite(Number(trade.pnl)) ? Number(trade.pnl) : 0);
        const pnl = realizedCarry + ((lastPx - entryPx) * remainingShares * dir);
        trade.status = pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "FLAT";
        trade.exitPrice = lastPx;
        trade.exit_ts = exitMs;
        trade.exitReason = "replay_end_close";
        trade.pnl = pnl;
        trade.realizedPnl = pnl;
        trade.pnlPct = entryPx > 0 ? (pnl / (entryPx * shares)) * 100 : 0;
      }
    }
    await kvPutJSON(KV, "timed:trades:all", kvTrades);
  } catch (error) {
    console.warn("[CLOSE-REPLAY] KV update failed:", error);
  }

  let archiveSynced = 0;
  if (runIdParam && openRows.length > 0) {
    const tradeIds = openRows.map((row) => String(row?.trade_id || "").trim()).filter(Boolean);
    const CHUNK = 90;
    for (let i = 0; i < tradeIds.length; i += CHUNK) {
      const chunk = tradeIds.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, idx) => `?${idx + 2}`).join(",");
      try {
        const syncRes = await db.prepare(
          `INSERT OR REPLACE INTO backtest_run_trades
            (run_id, trade_id, ticker, direction, entry_ts, entry_price, rank, rr, status,
             exit_ts, exit_price, exit_reason, trimmed_pct, pnl, pnl_pct, script_version,
             created_at, updated_at, trim_ts, trim_price, setup_name, setup_grade,
             risk_budget, shares, notional)
           ${archiveSelectColumns(false)}
            WHERE trade_id IN (${placeholders})`
        ).bind(runIdParam, ...chunk).run();
        archiveSynced += Number(syncRes?.meta?.changes || 0);
      } catch (error) {
        const msg = String(error?.message || error || "");
        if (/no such column/i.test(msg)) {
          try {
            const syncRes = await db.prepare(
              `INSERT OR REPLACE INTO backtest_run_trades
                (run_id, trade_id, ticker, direction, entry_ts, entry_price, rank, rr, status,
                 exit_ts, exit_price, exit_reason, trimmed_pct, pnl, pnl_pct, script_version,
                 created_at, updated_at, trim_ts, trim_price, setup_name, setup_grade,
                 risk_budget, shares, notional)
               ${archiveSelectColumns(/trim_ts|trim_price|setup_name|shares|notional/i.test(msg), /run_id/i.test(msg))}
                WHERE trade_id IN (${placeholders})`
            ).bind(runIdParam, ...chunk).run();
            archiveSynced += Number(syncRes?.meta?.changes || 0);
            continue;
          } catch (fallbackError) {
            console.warn("[CLOSE-REPLAY] archive sync fallback failed:", fallbackError);
          }
        }
        console.warn("[CLOSE-REPLAY] archive sync failed:", error);
      }
    }
  }

  let posClosed = 0;
  try {
    const openPos = (await db.prepare(
      `SELECT position_id FROM positions WHERE status = 'OPEN'`
    ).all())?.results || [];
    if (openPos.length > 0) {
      const posStmts = openPos.map((position) =>
        db.prepare(
          `UPDATE positions SET status = 'CLOSED', total_qty = 0, closed_at = ?1, updated_at = ?1 WHERE position_id = ?2`
        ).bind(exitMs, position.position_id)
      );
      for (let i = 0; i < posStmts.length; i += 100) {
        await db.batch(posStmts.slice(i, i + 100));
      }
      posClosed = openPos.length;
    }
  } catch (error) {
    console.warn("[CLOSE-REPLAY] positions sync failed:", error);
  }

  const totalPnl = details.reduce((sum, detail) => sum + detail.pnl, 0);
  return {
    ok: true,
    closed,
    posClosed,
    archiveSynced,
    run_id: runIdParam || null,
    message: closed === 0 && posClosed === 0 ? "no open positions" : undefined,
    exitDate: dateParam,
    exitMs,
    totalPnl: Math.round(totalPnl * 100) / 100,
    details: details.slice(0, 50),
  };
}

export function parseQueryBool(searchParams, key) {
  return asBool(searchParams?.get?.(key));
}
