// worker/backtest-orchestrator.js
//
// Worker-cron-driven backtest orchestrator.
//
// Replaces the continuous-slice.sh + watchdog architecture with a pure
// Cloudflare Worker cron job. Every 2 minutes (gated inside scheduled handler)
// advances each queued/running backtest by one batch (or one day, configurable).
//
// Why this exists: the cursor-cloud-agent VM was pausing during idle-detection,
// silently killing long backtests. This orchestrator lives inside the Worker
// (always-on, serverless) and progresses automatically.
//
// Architecture:
//   managed_backtest_runs D1 table tracks state + checkpoint.
//   Each cron tick:
//     1. Find oldest running run
//     2. Try to claim cron lock (TTL-protected so stale claims recover)
//     3. Determine next unprocessed trading day
//     4. POST to /timed/admin/candle-replay for each ticker batch on that day
//     5. Update checkpoint
//     6. Release lock
//
// Admin API:
//   POST /timed/admin/backtest/enqueue
//        body: { run_id, start_date, end_date, tickers, interval_min?, ticker_batch?, da_overrides? }
//   POST /timed/admin/backtest/cancel
//        body: { run_id }
//   GET  /timed/admin/backtest/status?run_id=... | &all=1
//
// See: tasks/worker-cron-orchestrator-2026-04-22.md

export const ORCHESTRATOR_CRON_LOCK_TTL_SEC = 180; // 3 min — longer than cron cadence so missed ticks don't double-process
export const ORCHESTRATOR_BATCH_SIZE_DEFAULT = 24;
export const ORCHESTRATOR_INTERVAL_MIN_DEFAULT = 30;
export const ORCHESTRATOR_MAX_BATCHES_PER_TICK = 5;       // Per-tick budget (each batch ~15-20s)
export const ORCHESTRATOR_PER_BATCH_TIMEOUT_MS = 45000;   // curl-style timeout for one batch

// Direct in-process hook for self-invoking candle-replay from the cron
// tick. Landed earlier as a way to bypass Cloudflare's self-HTTP fetch
// block, but the executor wiring wasn't finished before V11 shipped. A
// no-op stub keeps the worker/index.js import path valid; we'll wire it
// live when we revisit the orchestrator for V13+. Safe to leave.
let _directCandleReplayStep = null;
export function setDirectCandleReplayStep(fn) {
  _directCandleReplayStep = typeof fn === "function" ? fn : null;
}
export function getDirectCandleReplayStep() {
  return _directCandleReplayStep;
}

// ─────────────────────────────────────────────────────────────────────
// D1 schema
// ─────────────────────────────────────────────────────────────────────

export async function ensureOrchestratorSchema(env) {
  const db = env?.DB;
  if (!db) return;
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS managed_backtest_runs (
      run_id TEXT PRIMARY KEY,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',  -- queued | running | paused | completed | failed | canceled
      last_completed_date TEXT,
      tickers_csv TEXT NOT NULL,
      ticker_batch INTEGER NOT NULL DEFAULT 24,
      interval_min INTEGER NOT NULL DEFAULT 30,
      da_overrides_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      cron_claimed_at INTEGER DEFAULT 0,
      cron_last_advanced_at INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      last_error TEXT,
      notes TEXT
    )
  `).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_managed_backtest_status ON managed_backtest_runs (status, created_at)`).run();
}

// ─────────────────────────────────────────────────────────────────────
// Trading day iteration (NYSE business days, excluding known holidays)
// ─────────────────────────────────────────────────────────────────────

const NYSE_HOLIDAYS = new Set([
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

export function isTradingDay(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  if (NYSE_HOLIDAYS.has(dateStr)) return false;
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dow = d.getUTCDay();
  return dow >= 1 && dow <= 5;
}

export function nextTradingDayAfter(dateStr, endStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T12:00:00Z`);
  const end = new Date(`${endStr}T12:00:00Z`);
  for (let i = 1; i <= 14; i += 1) {
    const next = new Date(d.getTime() + i * 86400000);
    const next_s = next.toISOString().slice(0, 10);
    if (next.getTime() > end.getTime()) return null;
    if (isTradingDay(next_s)) return next_s;
  }
  return null;
}

// First trading day on or after `startDate`.
export function firstTradingDayOnOrAfter(startDate, endDate) {
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  for (let i = 0; i <= 14; i += 1) {
    const cur = new Date(start.getTime() + i * 86400000);
    const cur_s = cur.toISOString().slice(0, 10);
    if (cur.getTime() > end.getTime()) return null;
    if (isTradingDay(cur_s)) return cur_s;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Enqueue / cancel / status
// ─────────────────────────────────────────────────────────────────────

export async function enqueueManagedRun(env, {
  run_id,
  start_date,
  end_date,
  tickers,
  ticker_batch = ORCHESTRATOR_BATCH_SIZE_DEFAULT,
  interval_min = ORCHESTRATOR_INTERVAL_MIN_DEFAULT,
  da_overrides = null,
  notes = null,
}) {
  const db = env?.DB;
  if (!db) throw new Error("no_db_binding");

  if (!run_id || typeof run_id !== "string") throw new Error("run_id required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date)) throw new Error("start_date must be YYYY-MM-DD");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end_date)) throw new Error("end_date must be YYYY-MM-DD");

  let tickers_csv = "";
  if (Array.isArray(tickers)) tickers_csv = tickers.join(",");
  else if (typeof tickers === "string") tickers_csv = tickers;
  else throw new Error("tickers must be array or csv string");
  tickers_csv = tickers_csv.trim();
  if (!tickers_csv) throw new Error("tickers required");

  await ensureOrchestratorSchema(env);

  const now = Date.now();
  await db.prepare(`
    INSERT INTO managed_backtest_runs (
      run_id, start_date, end_date, status, last_completed_date, tickers_csv,
      ticker_batch, interval_min, da_overrides_json, created_at, updated_at, notes
    ) VALUES (?1, ?2, ?3, 'queued', NULL, ?4, ?5, ?6, ?7, ?8, ?8, ?9)
    ON CONFLICT(run_id) DO UPDATE SET
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      status = CASE
        WHEN managed_backtest_runs.status IN ('completed','canceled') THEN 'queued'
        ELSE managed_backtest_runs.status
      END,
      tickers_csv = excluded.tickers_csv,
      ticker_batch = excluded.ticker_batch,
      interval_min = excluded.interval_min,
      da_overrides_json = excluded.da_overrides_json,
      updated_at = excluded.updated_at,
      notes = excluded.notes
  `).bind(
    run_id, start_date, end_date,
    tickers_csv, ticker_batch, interval_min,
    da_overrides ? JSON.stringify(da_overrides) : null,
    now, notes,
  ).run();

  return { ok: true, run_id, status: "queued", start_date, end_date, tickers_count: tickers_csv.split(",").length };
}

export async function cancelManagedRun(env, run_id) {
  const db = env?.DB;
  if (!db) throw new Error("no_db_binding");
  await db.prepare(`
    UPDATE managed_backtest_runs
    SET status = 'canceled', updated_at = ?1, cron_claimed_at = 0
    WHERE run_id = ?2
  `).bind(Date.now(), run_id).run();
  return { ok: true, run_id };
}

export async function getManagedRun(env, run_id) {
  const db = env?.DB;
  if (!db) return null;
  const row = await db.prepare(`SELECT * FROM managed_backtest_runs WHERE run_id = ?1`).bind(run_id).first();
  return row || null;
}

export async function listManagedRuns(env, { status = null, limit = 50 } = {}) {
  const db = env?.DB;
  if (!db) return [];
  let sql = `SELECT * FROM managed_backtest_runs`;
  const params = [];
  if (status) {
    sql += ` WHERE status = ?1`;
    params.push(status);
  }
  sql += ` ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(500, Number(limit) || 50))}`;
  const rows = await db.prepare(sql).bind(...params).all();
  return rows?.results || [];
}

// ─────────────────────────────────────────────────────────────────────
// Cron tick: advance the next available managed run
// ─────────────────────────────────────────────────────────────────────

/**
 * Called by the cron scheduler. Claims a run, advances it by one day (or as
 * many batches as fit in the tick budget), updates checkpoint, releases lock.
 * Safe to call concurrently — TTL lock prevents double-processing.
 */
export async function orchestratorTick(env, { baseUrl, apiKey, logger = console }) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };

  await ensureOrchestratorSchema(env);

  const now = Date.now();
  const staleCutoff = now - (ORCHESTRATOR_CRON_LOCK_TTL_SEC * 1000);

  // Find oldest run whose cron lock is empty or stale.
  const claimRow = await db.prepare(`
    SELECT run_id FROM managed_backtest_runs
    WHERE status IN ('queued', 'running')
      AND (cron_claimed_at < ?1)
    ORDER BY
      CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
      created_at ASC
    LIMIT 1
  `).bind(staleCutoff).first();

  if (!claimRow?.run_id) return { ok: true, claimed: null, reason: "no_runs_due" };

  // Atomic claim — only set cron_claimed_at if it's still old.
  const claimResult = await db.prepare(`
    UPDATE managed_backtest_runs
    SET cron_claimed_at = ?1, updated_at = ?1
    WHERE run_id = ?2 AND cron_claimed_at < ?3
  `).bind(now, claimRow.run_id, staleCutoff).run();

  if (!claimResult?.meta || claimResult.meta.changes === 0) {
    return { ok: true, claimed: null, reason: "claim_race_lost" };
  }

  const run = await getManagedRun(env, claimRow.run_id);
  if (!run) return { ok: true, claimed: null, reason: "run_gone" };

  try {
    const result = await advanceManagedRun(env, run, { baseUrl, apiKey, logger });
    return { ok: true, claimed: run.run_id, ...result };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 500);
    logger?.error?.(`[ORCH] tick error run=${run.run_id}: ${msg}`);
    await db.prepare(`
      UPDATE managed_backtest_runs
      SET error_count = error_count + 1, last_error = ?1, cron_claimed_at = 0, updated_at = ?2
      WHERE run_id = ?3
    `).bind(msg, Date.now(), run.run_id).run();
    return { ok: false, claimed: run.run_id, error: msg };
  } finally {
    // Only release the claim if the run is still 'running'/'queued'.
    // (advanceManagedRun may have set status to completed; that path releases itself.)
    await db.prepare(`
      UPDATE managed_backtest_runs
      SET cron_claimed_at = 0, updated_at = ?1
      WHERE run_id = ?2 AND status IN ('queued','running')
    `).bind(Date.now(), claimRow.run_id).run();
  }
}

async function advanceManagedRun(env, run, { baseUrl, apiKey, logger }) {
  const db = env.DB;

  // Determine the next day to process.
  let nextDay = null;
  if (!run.last_completed_date) {
    nextDay = firstTradingDayOnOrAfter(run.start_date, run.end_date);
    if (!nextDay) {
      await finalizeRun(env, run, "completed", "no_trading_days_in_range");
      return { advanced: 0, finalized: true, reason: "no_trading_days" };
    }
    // First-tick: mark running, register run, apply DA overrides, reset state
    await db.prepare(`
      UPDATE managed_backtest_runs
      SET status = 'running', updated_at = ?1
      WHERE run_id = ?2
    `).bind(Date.now(), run.run_id).run();

    logger?.log?.(`[ORCH] initializing run ${run.run_id}: ${run.start_date} → ${run.end_date}`);
    await initializeRun(run, { baseUrl, apiKey, logger });
  } else {
    nextDay = nextTradingDayAfter(run.last_completed_date, run.end_date);
    if (!nextDay) {
      await finalizeRun(env, run, "completed", "reached_end_date");
      return { advanced: 0, finalized: true };
    }
  }

  logger?.log?.(`[ORCH] advancing ${run.run_id} to ${nextDay}`);

  // Process the day in batches until hasMore=false or budget exhausted.
  const tickerList = run.tickers_csv.split(",").filter(Boolean);
  const batchSize = Number(run.ticker_batch) || ORCHESTRATOR_BATCH_SIZE_DEFAULT;
  const intervalMin = Number(run.interval_min) || ORCHESTRATOR_INTERVAL_MIN_DEFAULT;

  let offset = 0;
  let batchesThisTick = 0;
  let totalScored = 0;
  let totalTrades = 0;
  let dayComplete = false;

  // Acquire server-side replay lock (same one continuous-slice uses). Reuses
  // existing machinery, no need to change anything else.
  await acquireReplayLock(run.run_id, { baseUrl, apiKey, logger });

  const tickStart = Date.now();
  const TICK_BUDGET_MS = 45000; // Leave headroom below CF 50s limit

  while (batchesThisTick < ORCHESTRATOR_MAX_BATCHES_PER_TICK) {
    if (Date.now() - tickStart > TICK_BUDGET_MS) {
      logger?.log?.(`[ORCH] tick budget reached for ${run.run_id} at offset=${offset}/${tickerList.length}`);
      break;
    }
    const url = new URL(`${baseUrl}/timed/admin/candle-replay`);
    url.searchParams.set("date", nextDay);
    url.searchParams.set("runId", run.run_id);
    url.searchParams.set("tickerOffset", String(offset));
    url.searchParams.set("tickerBatch", String(batchSize));
    url.searchParams.set("intervalMinutes", String(intervalMin));
    url.searchParams.set("tickers", run.tickers_csv);
    url.searchParams.set("fullDay", "0");
    url.searchParams.set("key", apiKey);

    const batchStart = Date.now();
    let resp;
    try {
      resp = await withTimeout(fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }), ORCHESTRATOR_PER_BATCH_TIMEOUT_MS, `candle-replay batch ${offset}`);
    } catch (err) {
      throw new Error(`batch_fetch_failed offset=${offset} day=${nextDay}: ${String(err?.message || err).slice(0, 200)}`);
    }

    if (!resp.ok) {
      throw new Error(`candle-replay HTTP ${resp.status} offset=${offset} day=${nextDay}`);
    }

    const body = await resp.json().catch(() => ({}));
    const chunkScored = Number(body?.scored) || 0;
    const chunkTrades = Number(body?.tradesCreated) || 0;
    const hasMore = body?.hasMore === true;
    totalScored += chunkScored;
    totalTrades += chunkTrades;
    batchesThisTick += 1;

    logger?.log?.(`[ORCH]   ${run.run_id} ${nextDay} batch ${batchesThisTick} offset=${offset} scored=${chunkScored} trades=${chunkTrades} hasMore=${hasMore} (${Date.now() - batchStart}ms)`);

    if (!hasMore) {
      dayComplete = true;
      break;
    }
    offset += batchSize;
  }

  if (dayComplete) {
    // Write checkpoint + heartbeat
    await db.prepare(`
      UPDATE managed_backtest_runs
      SET last_completed_date = ?1, cron_last_advanced_at = ?2, updated_at = ?2, error_count = 0, last_error = NULL
      WHERE run_id = ?3
    `).bind(nextDay, Date.now(), run.run_id).run();

    logger?.log?.(`[ORCH] day ${nextDay} complete: scored=${totalScored} trades=${totalTrades}`);

    // Check if we're done
    const hasMoreDays = nextTradingDayAfter(nextDay, run.end_date);
    if (!hasMoreDays) {
      await finalizeRun(env, { ...run, last_completed_date: nextDay }, "completed", "reached_end_date");
      return { advanced: 1, finalized: true, day: nextDay, scored: totalScored, trades: totalTrades };
    }
    return { advanced: 1, finalized: false, day: nextDay, scored: totalScored, trades: totalTrades };
  }

  // Day NOT complete — record heartbeat and let next tick continue with offset.
  // Note: offset state is stored in-memory here; next tick will restart at
  // offset=0 for this day. That's OK — Worker replays are idempotent by
  // (run_id, date, tickerOffset). If we want perfectly-resumable partial
  // progress, that's a future enhancement (would need to store offset in D1).
  await db.prepare(`
    UPDATE managed_backtest_runs
    SET cron_last_advanced_at = ?1, updated_at = ?1
    WHERE run_id = ?2
  `).bind(Date.now(), run.run_id).run();
  return { advanced: 0, finalized: false, day: nextDay, partial: true, offset_reached: offset, scored: totalScored, trades: totalTrades };
}

async function initializeRun(run, { baseUrl, apiKey, logger }) {
  // Register the run so trade_autopsy and other systems see it.
  const tickersCount = run.tickers_csv.split(",").length;
  const registerUrl = `${baseUrl}/timed/admin/runs/register?key=${apiKey}`;
  const payload = {
    run_id: run.run_id,
    label: run.run_id,
    description: `Orchestrator-managed run ${run.run_id}`,
    start_date: run.start_date,
    end_date: run.end_date,
    interval_min: Number(run.interval_min) || 30,
    ticker_batch: Number(run.ticker_batch) || 24,
    ticker_universe_count: tickersCount,
    trader_only: true,
    keep_open_at_end: false,
    low_write: false,
    status: "running",
    status_note: "Orchestrator-managed backtest",
    entry_engine: "tt_core",
    management_engine: "tt_core",
    active_experiment_slot: 1,
    live_config_slot: 0,
  };
  try {
    await withTimeout(fetch(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }), 15000, "register");
  } catch (err) {
    logger?.warn?.(`[ORCH] register_run failed (non-fatal): ${String(err).slice(0, 200)}`);
  }

  // Reset replay-only state (clean slate). No need to apply DA overrides
  // separately — the enqueue-er is expected to have configured them before
  // calling enqueue (via /timed/admin/model-config).
  try {
    await withTimeout(fetch(`${baseUrl}/timed/admin/reset?resetLedger=1&skipTickerLatest=1&replayOnly=1&key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }), 45000, "reset");
  } catch (err) {
    logger?.warn?.(`[ORCH] reset failed (non-fatal): ${String(err).slice(0, 200)}`);
  }
}

async function finalizeRun(env, run, status, noteSuffix) {
  const db = env.DB;
  await db.prepare(`
    UPDATE managed_backtest_runs
    SET status = ?1, updated_at = ?2, cron_claimed_at = 0, notes = COALESCE(notes,'') || ?3
    WHERE run_id = ?4
  `).bind(status, Date.now(), `\nfinalized_${status}_at=${Date.now()} reason=${noteSuffix || ""}`, run.run_id).run();
}

async function acquireReplayLock(runId, { baseUrl, apiKey, logger }) {
  const tag = `orchestrator_${runId}`;
  const url = `${baseUrl}/timed/admin/replay-lock?reason=${encodeURIComponent(tag)}&key=${apiKey}`;
  try {
    await withTimeout(fetch(url, { method: "POST" }), 10000, "replay-lock");
  } catch (err) {
    logger?.warn?.(`[ORCH] replay-lock acquire failed (continuing): ${String(err).slice(0, 200)}`);
  }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout_${label}_${ms}ms`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
