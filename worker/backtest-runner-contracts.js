function cleanText(value, fallback = null) {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
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

export function normalizeTickerList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim().toUpperCase())
    .filter(Boolean);
}

export function enumerateWeekdaySessions(startDate, endDate) {
  const start = cleanText(startDate);
  const end = cleanText(endDate);
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    return [];
  }
  const sessions = [];
  let cursor = new Date(`${start}T12:00:00Z`);
  const stop = new Date(`${end}T12:00:00Z`);
  while (cursor <= stop) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) sessions.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return sessions;
}

export function buildBacktestRunnerContract(payload = {}) {
  const params = payload?.params && typeof payload.params === "object" && !Array.isArray(payload.params)
    ? payload.params
    : {};
  const tickers = normalizeTickerList(params?.tickers || payload?.tickers);
  const startDate = cleanText(payload?.start_date);
  const endDate = cleanText(payload?.end_date);
  const sessions = enumerateWeekdaySessions(startDate, endDate);
  const replayMode = cleanText(params?.replay_mode, "candle");
  const intervalMin = Math.max(1, Math.min(30, asInt(payload?.interval_min, asInt(params?.interval_minutes, 15) || 15)));
  const tickerBatch = Math.max(1, Math.min(80, asInt(payload?.ticker_batch, asInt(params?.ticker_batch, 15) || 15)));
  const tickerUniverseCount = Math.max(0, asInt(payload?.ticker_universe_count, tickers.length));
  const estimatedBatchesPerDay = Math.max(1, Math.ceil((tickers.length || tickerUniverseCount || tickerBatch) / tickerBatch));
  const estimatedIntervalsPerDay = Math.floor(390 / intervalMin) + 1;
  return {
    runId: cleanText(payload?.run_id),
    label: cleanText(payload?.label),
    description: cleanText(payload?.description),
    startDate,
    endDate,
    sessions,
    replayMode,
    intervalMin,
    tickerBatch,
    tickerUniverseCount,
    tickers,
    flags: {
      traderOnly: asBool(payload?.trader_only),
      keepOpenAtEnd: asBool(payload?.keep_open_at_end),
      lowWrite: asBool(payload?.low_write),
      seedMarketEvents: asBool(payload?.seed_market_events ?? params?.seed_market_events),
      takeOverLock: asBool(payload?.take_over_lock ?? params?.take_over_lock),
      disableReferenceExecution: asBool(params?.disable_reference_execution),
      cleanSlate: !asBool(payload?.resume),
    },
    executionPlan: {
      estimatedBatchesPerDay,
      estimatedIntervalsPerDay,
      estimatedTotalSteps: sessions.length * (replayMode === "interval" ? estimatedIntervalsPerDay : estimatedBatchesPerDay),
    },
    config: {
      source: cleanText(params?.config_source, payload?.config_source),
      configSourceRunId: cleanText(params?.config_source_run_id, payload?.config_run_id),
      datasetManifest: cleanText(params?.dataset_manifest),
    },
  };
}

export function parseCandleReplayRequest({ url, tickerUniverse = [] } = {}) {
  const dateParam = url.searchParams.get("date");
  if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return { ok: false, error: "date param required (YYYY-MM-DD)", status: 400 };
  }
  const fullDay = url.searchParams.get("fullDay") === "1";
  const tickerOffset = fullDay ? 0 : Math.max(0, asInt(url.searchParams.get("tickerOffset"), 0));
  const tickerBatch = Math.max(1, Math.min(80, asInt(url.searchParams.get("tickerBatch"), 15) || 15));
  const intervalMinutes = Math.max(1, Math.min(30, asInt(url.searchParams.get("intervalMinutes"), 10) || 10));
  const cleanSlate = url.searchParams.get("cleanSlate") === "1";
  const freshRun = url.searchParams.get("freshRun") === "1";
  const disableReferenceExecution = url.searchParams.get("disableReferenceExecution") === "1"
    || (url.searchParams.get("enableReferenceExecution") !== "1" && (freshRun || cleanSlate));
  const trailOnly = url.searchParams.get("trailOnly") === "1";
  const skipTrail = url.searchParams.get("skipTrail") === "1"
    || url.searchParams.get("skipTrailWrite") === "1"
    || url.searchParams.get("lowWrite") === "1";
  const skipInvestor = url.searchParams.get("skipInvestor") === "1" || url.searchParams.get("traderOnly") === "1";
  const skipPayload = url.searchParams.get("skipPayload") !== "0";
  const debugTimeline = url.searchParams.get("debugTimeline") === "1";
  // Phase D analyzer: per-bar block trace. When ?blockChainTrace=1, the
  // response includes `blockChainBars`, one record per rejected bar with
  // (ticker, ts, reason, kanban_stage, state, score). This is the
  // input the Phase-D scripts/compare-block-chains.js consumes to
  // answer the redistribution question that aggregated `blockReasons`
  // counters can't.
  const blockChainTrace = url.searchParams.get("blockChainTrace") === "1";
  const tickerFilter = cleanText(url.searchParams.get("tickers"));
  let allTickers = tickerFilter
    ? tickerFilter.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean)
    : [...tickerUniverse];
  const spyIdx = allTickers.indexOf("SPY");
  if (spyIdx > 0) {
    allTickers.splice(spyIdx, 1);
    allTickers.unshift("SPY");
  }
  const batchTickers = allTickers.slice(tickerOffset, tickerOffset + tickerBatch);
  const hasMore = tickerOffset + tickerBatch < allTickers.length;
  return {
    ok: true,
    request: {
      dateParam,
      fullDay,
      tickerOffset,
      tickerBatch,
      intervalMinutes,
      cleanSlate,
      freshRun,
      disableReferenceExecution,
      trailOnly,
      skipTrail,
      skipInvestor,
      skipPayload,
      debugTimeline,
      blockChainTrace,
      tickerFilter,
      allTickers,
      batchTickers,
      hasMore,
    },
  };
}
