import { seedHistoricalMarketEvents } from "./market-events-seed.js";
import { buildBacktestRunnerContract, normalizeTickerList } from "./backtest-runner-contracts.js";
import { closeReplayPositionsAtDate, resetReplayState } from "./replay-admin-helpers.js";
import { finalizeBacktestRun, validateSentinelBasket } from "./backtest-run-archive-helpers.js";
import { kvGetJSON, kvPutJSON } from "./storage.js";
import { getReplayExecutorRuntime } from "./index.js";

const ACTIVE_JOB_KEY = "backtest_runner:active_job";
const JOB_PREFIX = "backtest_runner:job:";
const LOG_PREFIX = "backtest_runner:logs:";
const MAX_LOG_LINES = 200;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function asBool(value) {
  if (typeof value === "boolean") return value;
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "y" || raw === "on";
}

function asInt(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function cleanText(value, fallback = null) {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function sanitizeTickerList(value) {
  return normalizeTickerList(value).slice(0, 500);
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `backtest_runner_${stamp}_${suffix}`;
}

function isActiveStatus(status) {
  return new Set(["preparing", "seeding", "queued", "running", "retrying", "finalizing", "archiving"]).has(String(status || "").toLowerCase());
}

function buildJobSummary(job) {
  if (!job) return null;
  return {
    run_id: job.runId,
    label: job.label || null,
    description: job.description || null,
    status: job.status,
    phase: job.phase,
    status_note: job.statusNote || null,
    started_at: job.startedAt || null,
    updated_at: job.updatedAt || null,
    ended_at: job.endedAt || null,
    lock: job.lock || null,
    cancel_requested: !!job.cancelRequested,
    retries: asInt(job.retries, 0),
    checkpoint: job.checkpoint || null,
    contract: job.contract || null,
    prep_result: job.prepResult || null,
    seed_result: job.seedResult || null,
    execution_mode: "coordinated_cloud_session_loop_v1",
  };
}

function buildManifest(payload, nowTs) {
  const params = payload?.params && typeof payload.params === "object" && !Array.isArray(payload.params)
    ? payload.params
    : {};
  const configOverride = payload?.config_override && typeof payload.config_override === "object" && !Array.isArray(payload.config_override)
    ? payload.config_override
    : null;
  return {
    runId: payload.run_id,
    label: cleanText(payload.label),
    description: cleanText(payload.description),
    codeRevision: cleanText(payload.code_revision),
    engineSelection: {
      entryEngine: cleanText(payload.entry_engine, "tt_core"),
      managementEngine: cleanText(payload.management_engine, "tt_core"),
      leadingLtf: cleanText(payload.leading_ltf, "10"),
    },
    dataset: {
      startDate: cleanText(payload.start_date),
      endDate: cleanText(payload.end_date),
      intervalMin: asInt(payload.interval_min, 15) || 15,
      tickerBatch: asInt(payload.ticker_batch, 15) || 15,
      tickerUniverseCount: asInt(payload.ticker_universe_count, 0),
      traderOnly: asBool(payload.trader_only),
      keepOpenAtEnd: asBool(payload.keep_open_at_end),
      lowWrite: asBool(payload.low_write),
      tickers: sanitizeTickerList(params?.tickers),
    },
    replayMode: {
      isReplay: true,
      cleanLane: !asBool(payload.resume),
      rehydrationPolicy: asBool(payload.resume) ? "checkpoint_resume" : "fresh_reset",
    },
    config: {
      source: configOverride ? "explicit_override" : (cleanText(params?.config_source_run_id) ? "pinned_run_snapshot" : "registered_snapshot"),
      configSourceRunId: cleanText(params?.config_source_run_id),
      datasetManifest: cleanText(params?.dataset_manifest),
      keyCount: configOverride ? Object.keys(configOverride).length : null,
    },
    runner: {
      driver: "backtest_runner_do",
      cleanSlate: asBool(payload.clean_slate ?? params?.clean_slate),
      seedMarketEvents: asBool(payload.seed_market_events),
      takeOverLock: asBool(payload.take_over_lock),
      executionMode: "coordinated_cloud_session_loop_v1",
    },
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    params,
    createdAt: nowTs,
  };
}

async function ensureBacktestRunnerSchema(env) {
  const db = env?.DB;
  if (!db) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS backtest_runs (run_id TEXT PRIMARY KEY, label TEXT, description TEXT, start_date TEXT, end_date TEXT, interval_min INTEGER, ticker_batch INTEGER, ticker_universe_count INTEGER, trader_only INTEGER DEFAULT 0, keep_open_at_end INTEGER DEFAULT 0, low_write INTEGER DEFAULT 0, status TEXT DEFAULT 'registered', status_note TEXT, live_config_slot INTEGER DEFAULT 0, active_experiment_slot INTEGER DEFAULT 0, is_protected_baseline INTEGER DEFAULT 0, archived_at INTEGER, archived_by TEXT, archived_reason TEXT, tags_json TEXT, params_json TEXT, manifest_json TEXT, metrics_json TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS backtest_run_trades (run_id TEXT NOT NULL, trade_id TEXT NOT NULL, ticker TEXT, direction TEXT, entry_ts INTEGER, entry_price REAL, rank INTEGER, rr REAL, status TEXT, exit_ts INTEGER, exit_price REAL, exit_reason TEXT, trimmed_pct REAL, pnl REAL, pnl_pct REAL, script_version TEXT, created_at INTEGER, updated_at INTEGER, trim_ts INTEGER, trim_price REAL, PRIMARY KEY (run_id, trade_id))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS backtest_run_config (run_id TEXT NOT NULL, config_key TEXT NOT NULL, config_value TEXT, PRIMARY KEY (run_id, config_key))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS backtest_run_validation_artifacts (run_id TEXT NOT NULL, artifact_type TEXT NOT NULL, reference_run_id TEXT, gate_status TEXT, artifact_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (run_id, artifact_type))`),
  ]);
}

async function snapshotConfig(db, runId, configOverride) {
  if (!db || !runId) return;
  if (configOverride && typeof configOverride === "object" && !Array.isArray(configOverride)) {
    await db.prepare(`DELETE FROM backtest_run_config WHERE run_id = ?1`).bind(runId).run();
    const entries = Object.entries(configOverride);
    for (const [configKey, configValue] of entries) {
      await db.prepare(
        `INSERT OR REPLACE INTO backtest_run_config (run_id, config_key, config_value)
         VALUES (?1, ?2, ?3)`
      ).bind(runId, String(configKey), String(configValue ?? "")).run();
    }
    return;
  }
  await db.prepare(
    `INSERT OR IGNORE INTO backtest_run_config (run_id, config_key, config_value)
     SELECT ?1, config_key, config_value FROM model_config`
  ).bind(runId).run();
}

async function updateRunRow(db, runId, patch = {}) {
  if (!db || !runId) return;
  const fields = [];
  const values = [runId];
  let idx = 2;
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = ?${idx++}`);
    values.push(value);
  }
  fields.push(`updated_at = ?${idx++}`);
  values.push(Date.now());
  await db.prepare(`UPDATE backtest_runs SET ${fields.join(", ")} WHERE run_id = ?1`).bind(...values).run();
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function tzOffsetMs(ts, timeZone) {
  const d = new Date(Number(ts));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const map = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
  const asIso = `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}Z`;
  const wallAsUtc = Date.parse(asIso);
  return wallAsUtc - Number(ts);
}

function nyWallTimeToUtcMs(dayKey, hh = 0, mm = 0, ss = 0) {
  if (!dayKey) return null;
  const H = String(Math.max(0, Math.min(23, Number(hh) || 0))).padStart(2, "0");
  const M = String(Math.max(0, Math.min(59, Number(mm) || 0))).padStart(2, "0");
  const S = String(Math.max(0, Math.min(59, Number(ss) || 0))).padStart(2, "0");
  const t0 = Date.parse(`${dayKey}T${H}:${M}:${S}Z`);
  if (!Number.isFinite(t0)) return null;
  let ts = t0;
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMs(ts, "America/New_York");
    const next = t0 - off;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - ts) < 1000) {
      ts = next;
      break;
    }
    ts = next;
  }
  return ts;
}

function buildSessionReplayUrl(job, sessionDate, cleanSlate = false) {
  const manifest = job?.contract?.manifest || {};
  const params = manifest?.params || {};
  const tickers = Array.isArray(params?.tickers) ? params.tickers : [];
  const url = new URL("https://internal/timed/admin/candle-replay");
  url.searchParams.set("date", String(sessionDate));
  if (tickers.length) url.searchParams.set("tickers", tickers.join(","));
  url.searchParams.set("intervalMinutes", String(manifest?.dataset?.intervalMin || 15));
  url.searchParams.set("freshRun", "1");
  url.searchParams.set("runId", String(job?.runId || ""));
  url.searchParams.set("skipInvestor", manifest?.dataset?.traderOnly ? "1" : "0");
  if (params?.disable_reference_execution || params?.disableReferenceExecution) {
    url.searchParams.set("disableReferenceExecution", "1");
  }
  if (cleanSlate) {
    url.searchParams.set("cleanSlate", "1");
  }
  return url;
}

export class BacktestRunner {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/start") return this.handleStart(request);
      if (request.method === "POST" && url.pathname === "/cancel") return this.handleCancel(request);
      if (request.method === "POST" && url.pathname === "/finalize") return this.handleFinalize(request);
      if (request.method === "POST" && url.pathname === "/validate-sentinels") return this.handleValidateSentinels(request);
      if (request.method === "GET" && url.pathname === "/status") return this.handleStatus(url);
      if (request.method === "GET" && url.pathname === "/logs") return this.handleLogs(url);
      if (request.method === "GET" && url.pathname === "/artifacts") return this.handleArtifacts(url);
      return json({ ok: false, error: "not_found" }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err).slice(0, 400) }, 500);
    }
  }

  async alarm() {
    const activeJob = await this.getActiveJob();
    if (!activeJob || !isActiveStatus(activeJob.status)) return;
    await this.runActiveJob(activeJob);
  }

  async handleStart(request) {
    const body = await request.json().catch(() => ({}));
    return this.state.blockConcurrencyWhile(async () => {
      await ensureBacktestRunnerSchema(this.env);
      const db = this.env?.DB;
      const KV = this.env?.KV_TIMED;
      if (!db) return json({ ok: false, error: "no_db" }, 500);
      if (!KV) return json({ ok: false, error: "no_kv" }, 500);

      const activeJob = await this.getActiveJob();
      if (activeJob && isActiveStatus(activeJob.status)) {
        return json({
          ok: false,
          error: "runner_busy",
          detail: "A coordinated backtest is already active.",
          active: buildJobSummary(activeJob),
        }, 409);
      }

      const runId = cleanText(body?.run_id, makeRunId());
      const now = Date.now();
      const tags = Array.isArray(body?.tags) ? body.tags : ["cloud-backtest-runner"];
      const params = body?.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? { ...body.params }
        : {};
      const tickers = normalizeTickerList(params?.tickers || body?.tickers).slice(0, 500);
      if (tickers.length) params.tickers = tickers;
      params.runner_driver = "backtest_runner_do";
      params.execution_mode = "coordinated_cloud_session_loop_v1";
      params.seed_market_events = asBool(body?.seed_market_events);
      params.clean_slate = asBool(body?.clean_slate ?? params?.clean_slate);
      params.take_over_lock = asBool(body?.take_over_lock);
      params.validate_sentinels = asBool(body?.validate_sentinels ?? params?.validate_sentinels);

      const lockReason = `backtest_runner:${runId}`;
      const existingLock = await KV.get("timed:replay:lock");
      if (existingLock && !asBool(body?.take_over_lock)) {
        return json({
          ok: false,
          error: "replay_lock_active",
          detail: existingLock,
        }, 409);
      }
      const lockValue = `${lockReason}@${new Date(now).toISOString()}`;
      await KV.put("timed:replay:lock", lockValue, { expirationTtl: 86400 });

      const payload = {
        ...body,
        run_id: runId,
        tags,
        params,
        status: "running",
        status_note: "BacktestRunner preparing coordinated run",
      };
      const manifest = buildManifest(payload, now);
      const runnerContract = buildBacktestRunnerContract({
        ...payload,
        ticker_universe_count: payload?.ticker_universe_count ?? tickers.length,
      });
      if (!runnerContract?.startDate || !runnerContract?.endDate || !runnerContract?.sessions?.length) {
        return json({
          ok: false,
          error: "invalid_run_window",
          detail: "A coordinated backtest needs a valid weekday-backed start and end date range.",
        }, 400);
      }
      const firstSession = runnerContract.sessions[0] || null;

      const job = {
        runId,
        label: cleanText(body?.label),
        description: cleanText(body?.description),
        status: "preparing",
        phase: "preparing",
        statusNote: "BacktestRunner preparing coordinated run",
        startedAt: now,
        updatedAt: now,
        endedAt: null,
        cancelRequested: false,
        retries: 0,
        lock: lockValue,
        configOverride: body?.config_override && typeof body.config_override === "object" && !Array.isArray(body.config_override)
          ? body.config_override
          : null,
        checkpoint: {
          phase: "preparing",
          current_day: firstSession,
          session_index: 0,
          current_batch: 0,
          current_interval: null,
        },
        contract: {
          manifest,
          runner: runnerContract,
        },
        prepResult: null,
        seedResult: null,
      };

      await db.prepare(`UPDATE backtest_runs SET active_experiment_slot = 0 WHERE active_experiment_slot = 1`).run().catch(() => {});
      await db.prepare(
        `INSERT OR REPLACE INTO backtest_runs
         (run_id, label, description, start_date, end_date, interval_min, ticker_batch, ticker_universe_count, trader_only, keep_open_at_end, low_write, status, status_note, live_config_slot, active_experiment_slot, is_protected_baseline, tags_json, params_json, manifest_json, created_at, started_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, 1, 0, ?14, ?15, ?16, ?17, ?17, ?17)`
      ).bind(
        runId,
        job.label,
        job.description,
        cleanText(body?.start_date),
        cleanText(body?.end_date),
        asInt(body?.interval_min, 15) || 15,
        asInt(body?.ticker_batch, 15) || 15,
        asInt(body?.ticker_universe_count, tickers.length || 0),
        asBool(body?.trader_only) ? 1 : 0,
        asBool(body?.keep_open_at_end) ? 1 : 0,
        asBool(body?.low_write) ? 1 : 0,
        "running",
        job.statusNote,
        JSON.stringify(tags),
        JSON.stringify(params),
        JSON.stringify(manifest),
        now,
      ).run();
      await snapshotConfig(db, runId, body?.config_override);

      await this.saveJob(job);
      await this.appendLog(runId, "info", "runner_start", "BacktestRunner claimed the run lifecycle and replay lock.", {
        lock: lockValue,
      });

      if (params.clean_slate) {
        job.phase = "preparing";
        job.status = "running";
        job.statusNote = "Resetting replay state for a clean lane";
        job.updatedAt = Date.now();
        job.checkpoint = { ...job.checkpoint, phase: "preparing", prep: "clean_slate_reset" };
        await this.saveJob(job);
        await updateRunRow(db, runId, {
          status: "running",
          status_note: job.statusNote,
          params_json: JSON.stringify({ ...params, runner_checkpoint: job.checkpoint }),
        });
        await this.appendLog(runId, "info", "prep_start", "Resetting replay state before coordinated execution.", {
          clean_slate: true,
        });
        const prepResult = await resetReplayState({
          env: this.env,
          KV,
          now: Date.now(),
          resetLedger: true,
          skipTickerLatest: true,
          deps: {
            kvGetJSON: async () => null,
            kvPutJSON: async () => null,
            classifyKanbanStage: () => null,
            deriveKanbanMeta: () => null,
            d1UpsertTickerLatest: async () => null,
            d1UpsertTickerIndex: async () => null,
            REPLAY_TRADES_KV_KEY: "timed:trades:replay",
            PORTFOLIO_KEY: "timed:portfolio:v1",
            normTicker: (value) => String(value || "").trim().toUpperCase(),
          },
        });
        job.prepResult = prepResult;
        job.updatedAt = Date.now();
        await this.appendLog(
          runId,
          prepResult?.ok ? "info" : "warn",
          "prep_complete",
          prepResult?.ok ? "Replay state reset completed." : "Replay state reset did not complete cleanly.",
          prepResult,
        );
      }

      if (asBool(body?.seed_market_events)) {
        job.phase = "seeding";
        job.status = "running";
        job.statusNote = "Seeding market events";
        job.updatedAt = Date.now();
        job.checkpoint = { ...job.checkpoint, phase: "seeding" };
        await this.saveJob(job);
        await updateRunRow(db, runId, {
          status: "running",
          status_note: "BacktestRunner seeding market events",
          params_json: JSON.stringify({ ...params, runner_checkpoint: job.checkpoint }),
        });
        await this.appendLog(runId, "info", "seed_start", "Starting market-event seeding before replay execution.", {
          start_date: cleanText(body?.start_date),
          end_date: cleanText(body?.end_date),
          tickers,
        });
        let seedResult;
        if (tickers.length > 0) {
          const macroResult = await seedHistoricalMarketEvents(this.env, {
            startDate: cleanText(body?.start_date),
            endDate: cleanText(body?.end_date),
            includeMacro: true,
            includeEarnings: false,
          });
          const earningsResults = [];
          for (const ticker of tickers) {
            earningsResults.push(await seedHistoricalMarketEvents(this.env, {
              startDate: cleanText(body?.start_date),
              endDate: cleanText(body?.end_date),
              includeMacro: false,
              includeEarnings: true,
              ticker,
            }));
          }
          seedResult = {
            ok: macroResult?.ok !== false && earningsResults.every((result) => result?.ok !== false),
            mode: "macro_plus_targeted_earnings",
            macro: macroResult,
            earnings: earningsResults,
            tickers,
          };
        } else {
          seedResult = await seedHistoricalMarketEvents(this.env, {
            startDate: cleanText(body?.start_date),
            endDate: cleanText(body?.end_date),
            allTickers: true,
          });
        }
        job.seedResult = seedResult;
        job.updatedAt = Date.now();
        await this.appendLog(
          runId,
          seedResult?.ok ? "info" : "warn",
          "seed_complete",
          seedResult?.ok ? "Market-event seeding completed." : "Market-event seeding did not complete cleanly.",
          seedResult,
        );
      }

      job.phase = "queued";
      job.status = "queued";
      job.statusNote = "Coordinator queued the run and scheduled cloud replay execution.";
      job.updatedAt = Date.now();
      job.checkpoint = {
        ...job.checkpoint,
        phase: "queued",
        execution_mode: "coordinated_cloud_session_loop_v1",
      };
      await this.saveJob(job);
      await updateRunRow(db, runId, {
        status: "queued",
        status_note: job.statusNote,
        params_json: JSON.stringify({ ...params, runner_checkpoint: job.checkpoint, prep_result: job.prepResult, seed_result: job.seedResult }),
      });
      await this.appendLog(runId, "info", "runner_queued", "Run registered, queued, and scheduled for coordinated cloud replay.", {
        run_id: runId,
      });
      await this.state.storage.setAlarm(Date.now() + 100);

      return json({
        ok: true,
        run_id: runId,
        job: buildJobSummary(job),
      });
    });
  }

  async handleCancel(request) {
    const body = await request.json().catch(() => ({}));
    return this.state.blockConcurrencyWhile(async () => {
      const db = this.env?.DB;
      const KV = this.env?.KV_TIMED;
      if (!db) return json({ ok: false, error: "no_db" }, 500);
      if (!KV) return json({ ok: false, error: "no_kv" }, 500);
      const activeJob = await this.getActiveJob();
      const runId = cleanText(body?.run_id, activeJob?.runId);
      if (!runId) return json({ ok: false, error: "run_id_required" }, 400);
      const job = (await this.getJob(runId)) || activeJob;
      if (!job) return json({ ok: false, error: "not_found" }, 404);
      const now = Date.now();
      job.cancelRequested = true;
      job.status = "cancelled";
      job.phase = "cancelled";
      job.statusNote = cleanText(body?.reason, "Cancelled from BacktestRunner");
      job.updatedAt = now;
      job.endedAt = now;
      job.checkpoint = { ...(job.checkpoint || {}), phase: "cancelled" };
      await this.saveJob(job);
      await updateRunRow(db, runId, {
        status: "cancelled",
        status_note: job.statusNote,
        ended_at: now,
        active_experiment_slot: 0,
      });
      const currentLock = await KV.get("timed:replay:lock");
      if (currentLock && currentLock === job.lock) {
        await KV.delete("timed:replay:lock");
      }
      await this.state.storage.delete(ACTIVE_JOB_KEY);
      await this.appendLog(runId, "warn", "runner_cancelled", job.statusNote, {
        run_id: runId,
      });
      return json({ ok: true, run_id: runId, job: buildJobSummary(job) });
    });
  }

  async handleStatus(url) {
    const runId = cleanText(url.searchParams.get("run_id"));
    const activeJob = await this.getActiveJob();
    const selectedJob = runId ? await this.getJob(runId) : activeJob;
    let runRow = null;
    if (this.env?.DB && (runId || activeJob?.runId)) {
      const lookupRunId = runId || activeJob?.runId;
      runRow = await this.env.DB.prepare(
        `SELECT run_id, label, description, status, status_note, created_at, started_at, ended_at, updated_at, manifest_json, params_json
         FROM backtest_runs
         WHERE run_id = ?1`
      ).bind(lookupRunId).first().catch(() => null);
    }
    return json({
      ok: true,
      active: buildJobSummary(activeJob),
      job: buildJobSummary(selectedJob),
      run: runRow || null,
      locked: !!(await this.env?.KV_TIMED?.get?.("timed:replay:lock")),
    });
  }

  async handleFinalize(request) {
    const body = await request.json().catch(() => ({}));
    return this.state.blockConcurrencyWhile(async () => {
      const db = this.env?.DB;
      const KV = this.env?.KV_TIMED;
      if (!db) return json({ ok: false, error: "no_db" }, 500);
      await ensureBacktestRunnerSchema(this.env);
      const result = await finalizeBacktestRun(db, body);
      if (result?.ok) {
        const runId = cleanText(body?.run_id);
        const job = runId ? await this.getJob(runId) : null;
        if (job) {
          const now = Date.now();
          job.status = String(result?.status || "completed");
          job.phase = "finalized";
          job.statusNote = cleanText(body?.status_note, "BacktestRunner finalized run archive");
          job.updatedAt = now;
          job.endedAt = now;
          job.checkpoint = { ...(job.checkpoint || {}), phase: "finalized" };
          await this.saveJob(job);
          const currentLock = await KV?.get?.("timed:replay:lock");
          if (currentLock && currentLock === job.lock) await KV.delete("timed:replay:lock");
          await this.appendLog(runId, "info", "runner_finalize", "BacktestRunner finalized run archive.", {
            archived: result?.archived || null,
          });
        }
      }
      return json(result, result?.httpStatus || (result?.ok ? 200 : 500));
    });
  }

  async handleValidateSentinels(request) {
    const body = await request.json().catch(() => ({}));
    return this.state.blockConcurrencyWhile(async () => {
      const db = this.env?.DB;
      if (!db) return json({ ok: false, error: "no_db" }, 500);
      await ensureBacktestRunnerSchema(this.env);
      const result = await validateSentinelBasket(db, body);
      if (result?.ok) {
        await this.appendLog(String(result.run_id || body?.run_id || ""), "info", "runner_validate_sentinels", "BacktestRunner generated sentinel validation artifact.", {
          reference_run_id: result?.reference_run_id || null,
        });
      }
      return json(result, result?.httpStatus || (result?.ok ? 200 : 500));
    });
  }

  async handleLogs(url) {
    const runId = cleanText(url.searchParams.get("run_id"));
    const activeJob = await this.getActiveJob();
    const targetRunId = runId || activeJob?.runId;
    if (!targetRunId) return json({ ok: false, error: "run_id_required" }, 400);
    const limit = Math.max(1, Math.min(200, asInt(url.searchParams.get("limit"), 50) || 50));
    const logs = await this.getLogs(targetRunId);
    return json({
      ok: true,
      run_id: targetRunId,
      logs: logs.slice(-limit),
    });
  }

  async handleArtifacts(url) {
    const runId = cleanText(url.searchParams.get("run_id"));
    if (!runId) return json({ ok: false, error: "run_id_required" }, 400);
    const db = this.env?.DB;
    if (!db) return json({ ok: false, error: "no_db" }, 500);
    const [tradeCountRow, configCountRow, validationCountRow] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS cnt FROM backtest_run_trades WHERE run_id = ?1`).bind(runId).first().catch(() => null),
      db.prepare(`SELECT COUNT(*) AS cnt FROM backtest_run_config WHERE run_id = ?1`).bind(runId).first().catch(() => null),
      db.prepare(`SELECT COUNT(*) AS cnt FROM backtest_run_validation_artifacts WHERE run_id = ?1`).bind(runId).first().catch(() => null),
    ]);
    return json({
      ok: true,
      run_id: runId,
      artifacts: {
        counts: {
          trades: asInt(tradeCountRow?.cnt, 0),
          config: asInt(configCountRow?.cnt, 0),
          validations: asInt(validationCountRow?.cnt, 0),
        },
        urls: {
          detail: `/timed/admin/runs/detail?run_id=${encodeURIComponent(runId)}`,
          trades: `/timed/admin/runs/trades?run_id=${encodeURIComponent(runId)}`,
          config: `/timed/admin/runs/config?run_id=${encodeURIComponent(runId)}`,
          validations: `/timed/admin/runs/validations?run_id=${encodeURIComponent(runId)}`,
        },
      },
    });
  }

  async runActiveJob(job) {
    return this.state.blockConcurrencyWhile(async () => {
      const db = this.env?.DB;
      const KV = this.env?.KV_TIMED;
      if (!db || !KV || !job?.runId) return;

      const sessions = Array.isArray(job?.contract?.runner?.sessions) ? job.contract.runner.sessions : [];
      const sessionIndex = Math.max(0, Number(job?.checkpoint?.session_index || 0));
      if (sessionIndex >= sessions.length) {
        await this.finishActiveJob(job, { db, KV, sessions });
        return;
      }

      const sessionDate = sessions[sessionIndex];
      const manifest = job?.contract?.manifest || {};
      const params = manifest?.params || {};
      const replayUrl = buildSessionReplayUrl(
        job,
        sessionDate,
        sessionIndex === 0 && params?.clean_slate === true,
      );
      const requestBody = job?.configOverride ? { config_override: job.configOverride } : {};

      job.phase = "running";
      job.status = "running";
      job.statusNote = `Replaying ${sessionDate} (${sessionIndex + 1}/${sessions.length})`;
      job.updatedAt = Date.now();
      job.checkpoint = {
        ...(job.checkpoint || {}),
        phase: "running",
        current_day: sessionDate,
        session_index: sessionIndex,
      };
      await this.saveJob(job);
      await updateRunRow(db, job.runId, {
        status: "running",
        status_note: job.statusNote,
        params_json: JSON.stringify({ ...params, runner_checkpoint: job.checkpoint }),
      });
      await this.appendLog(job.runId, "info", "runner_session_start", `Starting replay session for ${sessionDate}.`, {
        session_index: sessionIndex,
        session_date: sessionDate,
        mode: "native_executor",
      });

      try {
        const { executeCandleReplayStep } = getReplayExecutorRuntime();
        const replayRequest = new Request(replayUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const replayResponse = await executeCandleReplayStep({
          req: replayRequest,
          env: { ...this.env, KV },
          url: replayUrl,
          body: requestBody,
        });
        const data = await replayResponse.json().catch(() => ({ ok: false, error: "invalid_native_replay_response" }));
        if (!replayResponse.ok || data?.ok === false) {
          throw new Error(String(data?.error || `http_${replayResponse.status}`));
        }
        job.retries = 0;
        job.updatedAt = Date.now();
        job.checkpoint = {
          ...(job.checkpoint || {}),
          phase: "running",
          current_day: sessionDate,
          session_index: sessionIndex + 1,
          last_result: {
            date: sessionDate,
            scored: Number(data?.scored || 0),
            tradesCreated: Number(data?.tradesCreated || 0),
            totalTrades: Number(data?.totalTrades || 0),
            errorsCount: Number(data?.errorsCount || 0),
          },
        };
        await this.saveJob(job);
        await updateRunRow(db, job.runId, {
          status: "running",
          status_note: `Completed replay session ${sessionDate}`,
          params_json: JSON.stringify({ ...params, runner_checkpoint: job.checkpoint }),
        });
        await this.appendLog(job.runId, "info", "runner_session_complete", `Completed replay session for ${sessionDate}.`, {
          session_index: sessionIndex,
          session_date: sessionDate,
          scored: Number(data?.scored || 0),
          trades_created: Number(data?.tradesCreated || 0),
          total_trades: Number(data?.totalTrades || 0),
        });
        await this.state.storage.setAlarm(Date.now() + 100);
      } catch (error) {
        job.retries = Number(job?.retries || 0) + 1;
        job.updatedAt = Date.now();
        const retryable = job.retries < 3;
        job.status = retryable ? "retrying" : "failed";
        job.phase = retryable ? "running" : "failed";
        job.statusNote = retryable
          ? `Replay session ${sessionDate} failed; retry ${job.retries}/3 pending`
          : `Replay session ${sessionDate} failed`;
        job.checkpoint = {
          ...(job.checkpoint || {}),
          phase: job.phase,
          current_day: sessionDate,
          session_index: sessionIndex,
          last_error: String(error?.message || error),
        };
        await this.saveJob(job);
        await updateRunRow(db, job.runId, {
          status: job.status,
          status_note: job.statusNote,
          ended_at: retryable ? null : Date.now(),
          active_experiment_slot: retryable ? 1 : 0,
          params_json: JSON.stringify({ ...params, runner_checkpoint: job.checkpoint }),
        });
        await this.appendLog(job.runId, retryable ? "warn" : "error", "runner_session_error", job.statusNote, {
          session_index: sessionIndex,
          session_date: sessionDate,
          error: String(error?.message || error),
        });
        if (retryable) {
          await this.state.storage.setAlarm(Date.now() + (job.retries * 2000));
        } else {
          if ((await KV.get("timed:replay:lock")) === job.lock) {
            await KV.delete("timed:replay:lock");
          }
          await this.state.storage.delete(ACTIVE_JOB_KEY);
        }
      }
    });
  }

  async finishActiveJob(job, { db, KV, sessions }) {
    const manifest = job?.contract?.manifest || {};
    const params = manifest?.params || {};
    const lastSession = sessions[sessions.length - 1] || manifest?.dataset?.endDate || null;

    if (!manifest?.dataset?.keepOpenAtEnd && lastSession) {
      job.phase = "finalizing";
      job.status = "finalizing";
      job.statusNote = `Closing replay positions at ${lastSession} market close`;
      job.updatedAt = Date.now();
      await this.saveJob(job);
      await updateRunRow(db, job.runId, {
        status: "running",
        status_note: job.statusNote,
        params_json: JSON.stringify({ ...params, runner_checkpoint: job.checkpoint }),
      });
      const closeResult = await closeReplayPositionsAtDate({
        env: this.env,
        KV,
        db,
        dateParam: lastSession,
        runIdParam: job.runId,
        deps: {
          d1EnsureBacktestRunsSchema: ensureBacktestRunnerSchema,
          nyWallTimeToUtcMs,
          kvGetJSON,
          kvPutJSON,
          clamp,
          TRADE_SIZE: 1000,
        },
      });
      await this.appendLog(job.runId, closeResult?.ok ? "info" : "warn", "runner_closeout", "Replay position closeout finished.", closeResult);
    }

    const finalizeResult = await finalizeBacktestRun(db, {
      run_id: job.runId,
      label: job.label,
      description: job.description,
      status: "completed",
      status_note: "BacktestRunner completed coordinated cloud replay",
      preserve_registered_config: manifest?.config?.source !== "registered_snapshot",
    });
    if (finalizeResult?.ok && params?.validate_sentinels) {
      const validationResult = await validateSentinelBasket(db, { run_id: job.runId });
      await this.appendLog(job.runId, validationResult?.ok ? "info" : "warn", "runner_post_validate", "Sentinel validation finished.", validationResult);
    }

    job.status = finalizeResult?.ok ? "completed" : "failed";
    job.phase = finalizeResult?.ok ? "finalized" : "failed";
    job.statusNote = finalizeResult?.ok ? "BacktestRunner completed coordinated run" : String(finalizeResult?.error || "finalization_failed");
    job.updatedAt = Date.now();
    job.endedAt = Date.now();
    job.checkpoint = {
      ...(job.checkpoint || {}),
      phase: job.phase,
      session_index: sessions.length,
      current_day: lastSession,
      finalize_result: finalizeResult?.ok ? { archived: finalizeResult.archived || null } : null,
    };
    await this.saveJob(job);
    await updateRunRow(db, job.runId, {
      status: job.status,
      status_note: job.statusNote,
      ended_at: job.endedAt,
      active_experiment_slot: 0,
      params_json: JSON.stringify({ ...params, runner_checkpoint: job.checkpoint }),
    });
    if ((await KV.get("timed:replay:lock")) === job.lock) {
      await KV.delete("timed:replay:lock");
    }
    await this.state.storage.delete(ACTIVE_JOB_KEY);
    await this.appendLog(job.runId, finalizeResult?.ok ? "info" : "error", "runner_complete", job.statusNote, finalizeResult);
  }

  async getActiveJob() {
    return (await this.state.storage.get(ACTIVE_JOB_KEY)) || null;
  }

  async getJob(runId) {
    if (!runId) return null;
    return (await this.state.storage.get(`${JOB_PREFIX}${runId}`)) || null;
  }

  async saveJob(job) {
    if (!job?.runId) return;
    await this.state.storage.put(`${JOB_PREFIX}${job.runId}`, job);
    if (isActiveStatus(job.status)) {
      await this.state.storage.put(ACTIVE_JOB_KEY, job);
    } else {
      const active = await this.getActiveJob();
      if (active?.runId === job.runId) await this.state.storage.delete(ACTIVE_JOB_KEY);
    }
  }

  async getLogs(runId) {
    if (!runId) return [];
    return (await this.state.storage.get(`${LOG_PREFIX}${runId}`)) || [];
  }

  async appendLog(runId, level, event, message, meta = null) {
    if (!runId) return;
    const current = await this.getLogs(runId);
    const next = [
      ...current,
      {
        ts: Date.now(),
        level: cleanText(level, "info"),
        event: cleanText(event, "event"),
        message: cleanText(message, ""),
        meta: meta && typeof meta === "object" ? meta : meta ?? null,
      },
    ].slice(-MAX_LOG_LINES);
    await this.state.storage.put(`${LOG_PREFIX}${runId}`, next);
  }
}
