#!/usr/bin/env node
/**
 * Enrich active-universe ticker learning/profiles in validated batches.
 *
 * Usage examples:
 *   node scripts/enrich-active-ticker-profiles.js
 *   node scripts/enrich-active-ticker-profiles.js --batch-size 5 --replay-count 2
 *   node scripts/enrich-active-ticker-profiles.js --tickers CAT,TSLA --replay-count 2
 *   node scripts/enrich-active-ticker-profiles.js --resume data/ticker-enrichment-2026-03-23T00-00-00.json
 */

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const WORKER_DIR = path.join(ROOT_DIR, 'worker');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const WORKER_BASE = process.env.WORKER_BASE || 'https://timed-trading-ingest.shashant.workers.dev';
const TIMED_KEY = process.env.TIMED_API_KEY || 'AwesomeSauce';
const { SECTOR_MAP } = require('../worker/sector-mapping.js');

const args = process.argv.slice(2);
const getArg = (name, dflt = null) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};
const hasFlag = (name) => args.includes(`--${name}`);
const toInt = (value, dflt) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : dflt;
};

const EXPLICIT_TICKERS = String(getArg('tickers', '') || '')
  .split(',')
  .map((t) => t.trim().toUpperCase())
  .filter(Boolean);
const SINCE_DATE = getArg('since', '2020-01-01');
const MIN_ATR = String(getArg('min-atr', '3'));
const BATCH_SIZE = Math.max(1, toInt(getArg('batch-size', '10'), 10));
const BATCH_INDEX = Math.max(0, toInt(getArg('batch-index', '0'), 0));
const START = Math.max(0, toInt(getArg('start', String(BATCH_INDEX * BATCH_SIZE)), BATCH_INDEX * BATCH_SIZE));
const LIMIT = hasFlag('all') ? null : Math.max(1, toInt(getArg('limit', String(BATCH_SIZE)), BATCH_SIZE));
const REPLAY_COUNT = hasFlag('skip-replay') ? 0 : Math.max(0, toInt(getArg('replay-count', '0'), 0));
const RESUME_PATH = getArg('resume', null);
const MANIFEST_PATH = getArg('manifest', null);
const STOP_ON_ERROR = hasFlag('stop-on-error');

const t0 = Date.now();
function elapsed() {
  return `${((Date.now() - t0) / 1000).toFixed(1)}s`;
}
function tsFilePart() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
function tail(text, maxLen = 4000) {
  if (!text) return '';
  return text.length > maxLen ? text.slice(-maxLen) : text;
}
function parseJsonSafe(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}
function sleep(ms) {
  execSync(`sleep ${Math.max(0, ms / 1000)}`);
}
function readJsonViaCurl(url, method = 'GET') {
  try {
    const cmd = method === 'POST'
      ? `curl -sS -X POST "${url}"`
      : `curl -sS "${url}"`;
    const raw = execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    return parseJsonSafe(raw, null);
  } catch {
    return null;
  }
}

function queryD1(sql, retries = 3) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const raw = execSync(cmd, { maxBuffer: 100 * 1024 * 1024, encoding: 'utf8' });
      const parsed = JSON.parse(raw);
      if (parsed?.error) {
        if (attempt < retries) {
          sleep(2000);
          continue;
        }
        return [];
      }
      if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
      if (parsed?.results) return parsed.results;
      return [];
    } catch {
      if (attempt < retries) {
        sleep(2000);
        continue;
      }
      return [];
    }
  }
  return [];
}

function writeManifest(manifestPath, manifest) {
  manifest.updated_at = new Date().toISOString();
  const summary = {
    total: manifest.results.length,
    validated: manifest.results.filter((r) => r.status === 'validated' || r.status === 'replay_validated').length,
    replay_validated: manifest.results.filter((r) => r.status === 'replay_validated').length,
    failed: manifest.results.filter((r) => /failed/.test(r.status)).length,
    skipped: manifest.results.filter((r) => r.status === 'skipped_completed').length,
  };
  manifest.summary = summary;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function loadManifest(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) return null;
  return parseJsonSafe(fs.readFileSync(manifestPath, 'utf8'), null);
}

async function fetchActiveTickers() {
  if (EXPLICIT_TICKERS.length) {
    return { tickers: uniq(EXPLICIT_TICKERS), source: 'explicit' };
  }
  console.log(`[${elapsed()}] Fetching active universe from ${WORKER_BASE}/timed/tickers ...`);
  try {
    const res = await fetch(`${WORKER_BASE}/timed/tickers`);
    const data = await res.json();
    if (data?.ok && Array.isArray(data.tickers) && data.tickers.length > 0) {
      const tickers = uniq(data.tickers.map((t) => String(t).trim().toUpperCase())).sort();
      console.log(`[${elapsed()}] Active universe loaded via fetch: ${tickers.length} tickers`);
      return { tickers, source: 'worker_active_universe' };
    }
  } catch (e) {
    console.warn(`[${elapsed()}] Fetch API failed for active universe (${String(e.message || e)}), trying curl fallback`);
  }

  const curlData = readJsonViaCurl(`${WORKER_BASE}/timed/tickers`);
  if (curlData?.ok && Array.isArray(curlData.tickers) && curlData.tickers.length > 0) {
    const tickers = uniq(curlData.tickers.map((t) => String(t).trim().toUpperCase())).sort();
    console.log(`[${elapsed()}] Active universe loaded via curl: ${tickers.length} tickers`);
    return { tickers, source: 'worker_active_universe_curl' };
  }

  console.warn(`[${elapsed()}] Worker ticker list unavailable, falling back to sector map`);
  return { tickers: uniq(Object.keys(SECTOR_MAP)).sort(), source: 'sector_map_fallback' };
}

function runNodeScript(scriptName, scriptArgs) {
  const scriptPath = path.join(ROOT_DIR, 'scripts', scriptName);
  const startedAt = Date.now();
  const proc = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    timeout: 60 * 60 * 1000,
    env: process.env,
  });
  return {
    ok: proc.status === 0,
    status: proc.status,
    signal: proc.signal,
    elapsed_ms: Date.now() - startedAt,
    stdout_tail: tail(proc.stdout || ''),
    stderr_tail: tail(proc.stderr || ''),
    error: proc.error ? String(proc.error.message || proc.error) : null,
    command: [path.relative(ROOT_DIR, scriptPath), ...scriptArgs].join(' '),
  };
}

function pickReplayDay(ticker) {
  const rows = queryD1(
    `SELECT MAX(date(datetime(bucket_ts/1000,'unixepoch'))) AS day FROM trail_5m_facts WHERE ticker='${ticker}'`
  );
  return rows?.[0]?.day || null;
}

async function runReplayValidation(ticker, day) {
  const url = `${WORKER_BASE}/timed/admin/replay-ticker?key=${encodeURIComponent(TIMED_KEY)}&ticker=${encodeURIComponent(ticker)}&date=${encodeURIComponent(day)}&cleanSlate=1&debug=1`;
  let data = null;
  try {
    const resp = await fetch(url, { method: 'POST' });
    data = await resp.json();
  } catch (_) {
    data = readJsonViaCurl(url, 'POST');
  }
  if (!data) {
    return {
      ok: false,
      day,
      source: null,
      rowsProcessed: 0,
      tradesCreated: 0,
      laneCounts: {},
      error: 'replay_request_failed',
      detail: null,
    };
  }
  return {
    ok: !!data?.ok,
    day,
    source: data?.source || null,
    rowsProcessed: Number(data?.rowsProcessed || 0),
    tradesCreated: Number(data?.tradesCreated || 0),
    laneCounts: data?.laneCounts || {},
    error: data?.error || null,
    detail: data?.detail || null,
  };
}

function validateTicker(ticker) {
  const moveCount = Number(queryD1(`SELECT COUNT(*) AS c FROM ticker_moves WHERE ticker='${ticker}'`)?.[0]?.c || 0);
  const signalCount = Number(
    queryD1(`SELECT COUNT(*) AS c FROM ticker_move_signals WHERE move_id IN (SELECT id FROM ticker_moves WHERE ticker='${ticker}')`)?.[0]?.c || 0
  );
  const learningRaw = queryD1(`SELECT learning_json FROM ticker_profiles WHERE ticker='${ticker}' LIMIT 1`)?.[0]?.learning_json || null;
  const learning = parseJsonSafe(learningRaw, null);
  const signalRaw = queryD1(
    `SELECT signals_json FROM ticker_move_signals WHERE move_id IN (SELECT id FROM ticker_moves WHERE ticker='${ticker}') ORDER BY ts DESC LIMIT 1`
  )?.[0]?.signals_json || null;
  const signalJson = parseJsonSafe(signalRaw, null);

  const entryParams = learning?.entry_params || {};
  const hasWeeklyProfileKeys = [
    'weekly_rsi_mean_long',
    'weekly_rsi_mean_short',
    'weekly_st_aligned_pct_long',
    'weekly_st_aligned_pct_short',
    'weekly_ichimoku_aligned_pct_long',
    'weekly_ichimoku_aligned_pct_short',
  ].every((key) => Object.prototype.hasOwnProperty.call(entryParams, key));
  const hasIchimokuProfileKeys = [
    'daily_ichimoku_aligned_pct_long',
    'daily_ichimoku_aligned_pct_short',
    'ltf_30m_ichimoku_aligned_pct_long',
    'ltf_30m_ichimoku_aligned_pct_short',
  ].every((key) => Object.prototype.hasOwnProperty.call(entryParams, key));
  const hasWeeklySignalKeys = !!signalJson && [
    'rsi_w', 'st_dir_w', 'ema21_w', 'ema48_w', 'ema_cross_w', 'ichimoku_w',
  ].every((key) => Object.prototype.hasOwnProperty.call(signalJson, key));
  const hasDailyIchimokuSignal = !!signalJson && Object.prototype.hasOwnProperty.call(signalJson, 'ichimoku_d');
  const has30mIchimokuSignal = !!signalJson && Object.prototype.hasOwnProperty.call(signalJson, 'ichimoku_30m');

  return {
    moveCount,
    signalCount,
    hasLearningJson: !!learning,
    hasWeeklyProfileKeys,
    hasIchimokuProfileKeys,
    hasWeeklySignalKeys,
    hasDailyIchimokuSignal,
    has30mIchimokuSignal,
    valid:
      !!learning &&
      moveCount > 0 &&
      signalCount > 0 &&
      hasWeeklyProfileKeys &&
      hasIchimokuProfileKeys &&
      hasWeeklySignalKeys &&
      hasDailyIchimokuSignal &&
      has30mIchimokuSignal,
  };
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`Missing data directory: ${DATA_DIR}`);
  }

  const prior = loadManifest(RESUME_PATH);
  const manifestPath = MANIFEST_PATH || RESUME_PATH || path.join(DATA_DIR, `ticker-enrichment-${tsFilePart()}.json`);
  const universe = await fetchActiveTickers();
  const completed = new Set((prior?.results || []).filter((r) => /validated|skipped_completed/.test(r.status)).map((r) => r.ticker));
  const orderedUniverse = universe.tickers.filter(Boolean).sort();
  const candidates = orderedUniverse.filter((ticker) => !completed.has(ticker));
  const selected = LIMIT == null ? candidates.slice(START) : candidates.slice(START, START + LIMIT);

  const manifest = prior || {
    generated_at: new Date().toISOString(),
    worker_base: WORKER_BASE,
    source: universe.source,
    since: SINCE_DATE,
    min_atr: MIN_ATR,
    batch_size: BATCH_SIZE,
    batch_index: BATCH_INDEX,
    start: START,
    limit: LIMIT,
    replay_count: REPLAY_COUNT,
    stop_on_error: STOP_ON_ERROR,
    universe_count: orderedUniverse.length,
    results: [],
  };
  manifest.selected_tickers = selected;
  writeManifest(manifestPath, manifest);

  console.log(`\n=== Active-Universe Ticker Enrichment ===`);
  console.log(`Source:        ${universe.source}`);
  console.log(`Universe:      ${orderedUniverse.length} tickers`);
  console.log(`Selected:      ${selected.length} tickers`);
  console.log(`Batch start:   ${START}`);
  console.log(`Batch limit:   ${LIMIT == null ? 'ALL' : LIMIT}`);
  console.log(`Replay sample: ${REPLAY_COUNT}`);
  console.log(`Manifest:      ${manifestPath}\n`);

  let replaySlotsRemaining = REPLAY_COUNT;

  for (const ticker of selected) {
    const existing = manifest.results.find((r) => r.ticker === ticker);
    if (existing && /validated|skipped_completed/.test(existing.status)) {
      console.log(`[${elapsed()}] ${ticker}: skipping, already completed in manifest`);
      continue;
    }

    console.log(`[${elapsed()}] ${ticker}: running learning rebuild...`);
    const result = {
      ticker,
      started_at: new Date().toISOString(),
      status: 'started',
    };

    const learningRun = runNodeScript('build-ticker-learning.js', ['--ticker', ticker, '--since', SINCE_DATE, '--min-atr', MIN_ATR]);
    result.learning = learningRun;
    if (!learningRun.ok) {
      result.status = 'learning_failed';
      result.ended_at = new Date().toISOString();
      manifest.results = manifest.results.filter((r) => r.ticker !== ticker).concat(result);
      writeManifest(manifestPath, manifest);
      console.error(`[${elapsed()}] ${ticker}: learning rebuild failed`);
      if (STOP_ON_ERROR) break;
      continue;
    }

    console.log(`[${elapsed()}] ${ticker}: running profile rebuild...`);
    const profileRun = runNodeScript('build-ticker-profiles.js', ['--ticker', ticker]);
    result.profile = profileRun;
    if (!profileRun.ok) {
      result.status = 'profile_failed';
      result.ended_at = new Date().toISOString();
      manifest.results = manifest.results.filter((r) => r.ticker !== ticker).concat(result);
      writeManifest(manifestPath, manifest);
      console.error(`[${elapsed()}] ${ticker}: profile rebuild failed`);
      if (STOP_ON_ERROR) break;
      continue;
    }

    console.log(`[${elapsed()}] ${ticker}: validating D1 enrichment...`);
    result.validation = validateTicker(ticker);
    if (!result.validation.valid) {
      result.status = 'validation_failed';
      result.ended_at = new Date().toISOString();
      manifest.results = manifest.results.filter((r) => r.ticker !== ticker).concat(result);
      writeManifest(manifestPath, manifest);
      console.error(`[${elapsed()}] ${ticker}: validation failed`);
      if (STOP_ON_ERROR) break;
      continue;
    }

    result.status = 'validated';

    if (replaySlotsRemaining > 0) {
      const replayDay = pickReplayDay(ticker);
      if (replayDay) {
        console.log(`[${elapsed()}] ${ticker}: replay-validating ${replayDay} ...`);
        result.replay = await runReplayValidation(ticker, replayDay);
        if (result.replay.ok && result.replay.rowsProcessed > 0) {
          result.status = 'replay_validated';
          replaySlotsRemaining--;
        } else {
          result.status = 'replay_failed';
        }
      } else {
        result.replay = { ok: false, day: null, error: 'no_trail_5m_facts_day' };
        result.status = 'replay_failed';
      }
    }

    result.ended_at = new Date().toISOString();
    manifest.results = manifest.results.filter((r) => r.ticker !== ticker).concat(result);
    writeManifest(manifestPath, manifest);
    console.log(`[${elapsed()}] ${ticker}: ${result.status}`);

    if (STOP_ON_ERROR && /failed/.test(result.status)) break;
  }

  console.log(`\nDone. Manifest saved to ${manifestPath}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
