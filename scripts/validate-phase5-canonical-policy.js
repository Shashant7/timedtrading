#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const WORKER_DIR = path.join(ROOT_DIR, 'worker');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const WORKER_BASE = process.env.WORKER_BASE || 'https://timed-trading-ingest.shashant.workers.dev';
const TIMED_KEY = process.env.TIMED_API_KEY || 'AwesomeSauce';
const DEFAULT_TICKERS = ['CAT', 'AXON', 'BABA', 'TSLA', 'ORCL', 'SPY', 'QQQ', 'IWM'];

const args = process.argv.slice(2);
const getArg = (name, dflt = null) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};
const tickers = String(getArg('tickers', '') || '')
  .split(',')
  .map((t) => t.trim().toUpperCase())
  .filter(Boolean);
const TICKERS = tickers.length ? [...new Set(tickers)] : DEFAULT_TICKERS;

function tsFilePart() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function parseJsonSafe(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
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
        if (attempt < retries) continue;
        return [];
      }
      if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
      if (parsed?.results) return parsed.results;
      return [];
    } catch {
      if (attempt < retries) continue;
      return [];
    }
  }
  return [];
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

function pickReplayDay(ticker) {
  const rows = queryD1(
    `SELECT MAX(date(datetime(bucket_ts/1000,'unixepoch'))) AS day FROM trail_5m_facts WHERE ticker='${ticker}'`
  );
  return rows?.[0]?.day || null;
}

function countTruthy(list) {
  return list.filter(Boolean).length;
}

function loadTickerValidation(ticker) {
  const moveCount = Number(queryD1(`SELECT COUNT(*) AS c FROM ticker_moves WHERE ticker='${ticker}'`)?.[0]?.c || 0);
  const moveJsonCount = Number(queryD1(`SELECT COUNT(*) AS c FROM ticker_moves WHERE ticker='${ticker}' AND move_json IS NOT NULL`)?.[0]?.c || 0);
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
  const runtimePolicy = learning?.runtime_policy || {};
  const archetypes = learning?.archetypes || {};
  const weeklyProfileKeys = [
    'weekly_rsi_mean_long',
    'weekly_rsi_mean_short',
    'weekly_st_aligned_pct_long',
    'weekly_st_aligned_pct_short',
    'weekly_ichimoku_aligned_pct_long',
    'weekly_ichimoku_aligned_pct_short',
  ];
  const ichProfileKeys = [
    'daily_ichimoku_aligned_pct_long',
    'daily_ichimoku_aligned_pct_short',
    'ltf_30m_ichimoku_aligned_pct_long',
    'ltf_30m_ichimoku_aligned_pct_short',
  ];
  const weeklySignalKeys = ['rsi_w', 'st_dir_w', 'ema21_w', 'ema48_w', 'ema_cross_w', 'ichimoku_w'];

  return {
    moveCount,
    moveJsonCount,
    signalCount,
    hasLearningJson: !!learning,
    hasMoveJson: moveJsonCount > 0,
    hasWeeklyProfileKeys: weeklyProfileKeys.every((key) => Object.prototype.hasOwnProperty.call(entryParams, key)),
    hasIchimokuProfileKeys: ichProfileKeys.every((key) => Object.prototype.hasOwnProperty.call(entryParams, key)),
    hasWeeklySignalKeys: !!signalJson && weeklySignalKeys.every((key) => Object.prototype.hasOwnProperty.call(signalJson, key)),
    hasDailyIchimokuSignal: !!signalJson && Object.prototype.hasOwnProperty.call(signalJson, 'ichimoku_d'),
    has30mIchimokuSignal: !!signalJson && Object.prototype.hasOwnProperty.call(signalJson, 'ichimoku_30m'),
    hasArchetypes: !!archetypes.long || !!archetypes.short,
    hasRuntimePolicy: Object.keys(runtimePolicy).length > 0,
    dominantArchetypes: {
      long: entryParams.long_dominant_archetype || null,
      short: entryParams.short_dominant_archetype || null,
    },
    preferredPolicy: {
      entryEngineLong: entryParams.preferred_entry_engine_long || null,
      entryEngineShort: entryParams.preferred_entry_engine_short || null,
      managementEngineLong: entryParams.preferred_management_engine_long || null,
      managementEngineShort: entryParams.preferred_management_engine_short || null,
      guardBundleLong: entryParams.preferred_guard_bundle_long || null,
      guardBundleShort: entryParams.preferred_guard_bundle_short || null,
      exitStyleLong: entryParams.preferred_exit_style_long || null,
      exitStyleShort: entryParams.preferred_exit_style_short || null,
    },
    contextRuleCount: Array.isArray(runtimePolicy.context_rules) ? runtimePolicy.context_rules.length : 0,
    valid:
      !!learning &&
      moveCount > 0 &&
      moveJsonCount > 0 &&
      signalCount > 0 &&
      weeklyProfileKeys.every((key) => Object.prototype.hasOwnProperty.call(entryParams, key)) &&
      ichProfileKeys.every((key) => Object.prototype.hasOwnProperty.call(entryParams, key)) &&
      !!signalJson &&
      weeklySignalKeys.every((key) => Object.prototype.hasOwnProperty.call(signalJson, key)) &&
      Object.prototype.hasOwnProperty.call(signalJson, 'ichimoku_d') &&
      Object.prototype.hasOwnProperty.call(signalJson, 'ichimoku_30m') &&
      (!!archetypes.long || !!archetypes.short) &&
      Object.keys(runtimePolicy).length > 0,
  };
}

function runReplayValidation(ticker, day) {
  const url = `${WORKER_BASE}/timed/admin/replay-ticker?key=${encodeURIComponent(TIMED_KEY)}&ticker=${encodeURIComponent(ticker)}&date=${encodeURIComponent(day)}&cleanSlate=1&debug=1`;
  const data = readJsonViaCurl(url, 'POST');
  return {
    ok: !!data?.ok,
    source: data?.source || null,
    day,
    rowsProcessed: Number(data?.rowsProcessed || 0),
    tradesCreated: Number(data?.tradesCreated || 0),
    laneCounts: data?.laneCounts || {},
    timelineCount: Array.isArray(data?.timeline) ? data.timeline.length : 0,
    error: data?.error || null,
  };
}

function sampleIntervalSet(totalIntervals) {
  if (!Number.isFinite(totalIntervals) || totalIntervals <= 0) return [0];
  const raw = [0, Math.floor(totalIntervals / 4), Math.floor(totalIntervals / 2), Math.floor((totalIntervals * 3) / 4), totalIntervals - 1];
  return [...new Set(raw.filter((n) => Number.isFinite(n) && n >= 0 && n < totalIntervals))].sort((a, b) => a - b);
}

function fetchIntervalReplay(ticker, day, interval) {
  const url = `${WORKER_BASE}/timed/admin/interval-replay?key=${encodeURIComponent(TIMED_KEY)}&date=${encodeURIComponent(day)}&interval=${interval}&intervalMinutes=5&tickers=${encodeURIComponent(ticker)}&traderOnly=1&skipPayload=1&cleanSlate=1`;
  return readJsonViaCurl(url, 'POST');
}

function summarizeIntervalDiagnostics(ticker, day) {
  const first = fetchIntervalReplay(ticker, day, 0);
  const totalIntervals = Number(first?.totalIntervals || 0);
  const intervals = sampleIntervalSet(totalIntervals || 1);
  const samples = [];
  const reasonCounts = {};

  for (const interval of intervals) {
    const data = interval === 0 ? first : fetchIntervalReplay(ticker, day, interval);
    const diag = (data?.entryDiagnostics || {})[ticker] || {};
    const reason = diag?.reason || null;
    if (reason) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    samples.push({
      interval,
      qualifies: diag?.qualifies ?? null,
      reason,
      path: diag?.path || null,
      engine: diag?.engine || null,
      selectedEngine: diag?.selectedEngine || null,
      engineSource: diag?.engineSource || null,
      scenarioPolicySource: diag?.scenarioPolicySource || null,
      scenarioPolicyMatch: diag?.scenarioPolicyMatch || null,
      scenarioExitStyle: diag?.scenarioExitStyle || null,
      ripsterBias: diag?.ripster_bias || null,
      tradesCreated: Number(data?.tradesCreated || 0),
      stageCounts: data?.stageCounts || {},
      blockReasons: data?.blockReasons || {},
      processDebugCount: Array.isArray(data?.processDebug) ? data.processDebug.length : 0,
    });
  }

  const interesting = samples.filter((sample) =>
    sample.qualifies === true ||
    !!sample.path ||
    !!sample.selectedEngine ||
    !!sample.engineSource ||
    !!sample.scenarioPolicySource
  );

  return {
    totalIntervals,
    sampledIntervals: intervals,
    samples,
    sampledReasonCounts: reasonCounts,
    interestingCount: interesting.length,
    firstInterestingSample: interesting[0] || null,
  };
}

function deriveAssessment(record) {
  const issues = [];
  if (!record.schema.valid) issues.push('schema_incomplete');
  if (!record.replay.ok || record.replay.rowsProcessed <= 0) issues.push('replay_integrity_failed');
  if (record.intervalDiagnostics.interestingCount === 0) issues.push('no_policy_signal_in_sampled_intervals');
  return {
    readyForBroaderRollout: issues.length === 0,
    issues,
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push('# Phase 5 Canonical Policy Validation');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Replay date(s): ${[...new Set(report.results.map((r) => r.replay.day).filter(Boolean))].join(', ')}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Tickers checked: ${report.summary.tickerCount}`);
  lines.push(`- Schema-valid tickers: ${report.summary.schemaValid}`);
  lines.push(`- Replay-integrity passes: ${report.summary.replayValid}`);
  lines.push(`- Tickers with sampled policy signal: ${report.summary.policySignalObserved}`);
  lines.push(`- Ready for broader rollout now: ${report.summary.readyForBroaderRollout}`);
  lines.push('');
  lines.push('## Results');
  lines.push('');
  for (const result of report.results) {
    lines.push(`### ${result.ticker}`);
    lines.push('');
    lines.push(`- Dominant archetypes: long=${result.schema.dominantArchetypes.long || 'n/a'}, short=${result.schema.dominantArchetypes.short || 'n/a'}`);
    lines.push(`- Preferred long policy: entry=${result.schema.preferredPolicy.entryEngineLong || 'n/a'}, management=${result.schema.preferredPolicy.managementEngineLong || 'n/a'}, guard=${result.schema.preferredPolicy.guardBundleLong || 'n/a'}, exit=${result.schema.preferredPolicy.exitStyleLong || 'n/a'}`);
    lines.push(`- Schema valid: ${result.schema.valid}`);
    lines.push(`- Replay integrity: ok=${result.replay.ok}, rows=${result.replay.rowsProcessed}, trades=${result.replay.tradesCreated}, source=${result.replay.source || 'n/a'}`);
    lines.push(`- Sampled policy signal observed: ${result.intervalDiagnostics.interestingCount > 0}`);
    if (result.intervalDiagnostics.firstInterestingSample) {
      const sample = result.intervalDiagnostics.firstInterestingSample;
      lines.push(`- First interesting sampled interval: ${sample.interval} reason=${sample.reason || 'n/a'} path=${sample.path || 'n/a'} selectedEngine=${sample.selectedEngine || 'n/a'} engineSource=${sample.engineSource || 'n/a'} scenarioPolicySource=${sample.scenarioPolicySource || 'n/a'}`);
    } else {
      const reasons = Object.entries(result.intervalDiagnostics.sampledReasonCounts)
        .map(([reason, count]) => `${reason}:${count}`)
        .join(', ');
      lines.push(`- Sampled blocker reasons: ${reasons || 'none captured'}`);
    }
    lines.push(`- Assessment: ${result.assessment.readyForBroaderRollout ? 'pass' : 'needs_iteration'} (${result.assessment.issues.join(', ') || 'no issues'})`);
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const results = [];

  for (const ticker of TICKERS) {
    const schema = loadTickerValidation(ticker);
    const replayDay = pickReplayDay(ticker);
    const replay = replayDay
      ? runReplayValidation(ticker, replayDay)
      : { ok: false, source: null, day: null, rowsProcessed: 0, tradesCreated: 0, laneCounts: {}, timelineCount: 0, error: 'no_replay_day' };
    const intervalDiagnostics = replayDay
      ? summarizeIntervalDiagnostics(ticker, replayDay)
      : { totalIntervals: 0, sampledIntervals: [], samples: [], sampledReasonCounts: {}, interestingCount: 0, firstInterestingSample: null };
    const record = { ticker, schema, replay, intervalDiagnostics };
    record.assessment = deriveAssessment(record);
    results.push(record);
    console.log(`[phase5] ${ticker}: schema=${schema.valid} replay=${replay.ok && replay.rowsProcessed > 0} policySignal=${intervalDiagnostics.interestingCount > 0}`);
  }

  const summary = {
    tickerCount: results.length,
    schemaValid: countTruthy(results.map((r) => r.schema.valid)),
    replayValid: countTruthy(results.map((r) => r.replay.ok && r.replay.rowsProcessed > 0)),
    policySignalObserved: countTruthy(results.map((r) => r.intervalDiagnostics.interestingCount > 0)),
    readyForBroaderRollout: countTruthy(results.map((r) => r.assessment.readyForBroaderRollout)),
  };

  const report = {
    generated_at: generatedAt,
    worker_base: WORKER_BASE,
    tickers: TICKERS,
    summary,
    results,
  };

  const stem = `phase5-canonical-policy-validation-${tsFilePart()}`;
  const jsonPath = path.join(DATA_DIR, `${stem}.json`);
  const mdPath = path.join(DATA_DIR, `${stem}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, toMarkdown(report));

  console.log(`\nSaved JSON: ${jsonPath}`);
  console.log(`Saved MD:   ${mdPath}`);
}

main();
