// worker/foundation/setup-diagnostics-route.js
// -----------------------------------------------------------------------------
// Shadow-only admin diagnostics: timed_trail snapshots -> setup events ->
// sequences -> path forecast. No writes; no live scoring/entry/exit changes.
// -----------------------------------------------------------------------------

import { deriveSetupEventsFromWindow } from "./setup-event-derivation.js";
import { kvGetJSON } from "../storage.js";

const DEFAULT_LIMIT = 240;
const MAX_LIMIT = 2000;
const DEFAULT_LOOKBACK_HOURS = 48;

export function vixRegimeFromValue(vix) {
  const vx = Number(vix);
  if (!Number.isFinite(vx) || vx <= 0) return null;
  if (vx >= 35) return "panic";
  if (vx >= 25) return "high";
  if (vx >= 18) return "elevated";
  return "low";
}

export function buildDiagnosticsContext(snapshot = {}, env = {}) {
  const vix = Number(snapshot._vix ?? snapshot.market_internals?.vix?.price
    ?? snapshot.setup_snapshot?.market_internals?.vix_price);
  const sectorRegime = snapshot._env?._sectorRegime
    || env._sectorRegimeCache?.[snapshot.sector || snapshot._sector]
    || null;
  const sectorPosture = String(
    sectorRegime?.posture
    || sectorRegime?.stance
    || sectorRegime?.state
    || snapshot.sector_posture
    || snapshot._sector_posture
    || snapshot.setup_snapshot?.market_internals?.sector_rotation
    || "",
  ).trim().toLowerCase() || null;

  const researchRaw = snapshot.strategy_alignment
    || snapshot._strategy_alignment
    || snapshot._theme_tilt_shadow
    || snapshot._theme_tilt;
  let researchAlignment = null;
  if (typeof researchRaw === "string") {
    researchAlignment = researchRaw.trim().toLowerCase();
  } else if (Number.isFinite(Number(researchRaw))) {
    const n = Number(researchRaw);
    researchAlignment = n > 0.05 ? "supportive" : n < -0.05 ? "opposed" : "neutral";
  }

  const regimeForecast = snapshot.regime_forecast || null;
  const indexPosture = String(
    snapshot.market_internals?.overall
    || snapshot.setup_snapshot?.market_internals?.overall
    || snapshot.swing_consensus?.regime_combined
    || snapshot.regime_class
    || "",
  ).trim().toLowerCase() || null;

  return {
    vix_regime: vixRegimeFromValue(vix),
    sector_posture: sectorPosture,
    research_alignment: researchAlignment,
    ticker_personality: snapshot.ticker_personality
      || snapshot.execution_profile?.personality
      || snapshot.setup_snapshot?.ticker_personality
      || snapshot._ticker_profile?.behavior_type
      || null,
    index_posture: indexPosture,
    regime_forecast_state: regimeForecast?.state || null,
    regime_forecast_confidence: Number.isFinite(Number(regimeForecast?.confidence))
      ? Number(regimeForecast.confidence)
      : null,
  };
}

export function summarizeTraderPosture(sequences = [], opts = {}) {
  const openPosition = opts.openPosition === true;
  const active = (Array.isArray(sequences) ? sequences : [])
    .filter((s) => s.stage > 0 && s.status !== "invalidated");

  if (!active.length) {
    if (openPosition) {
      const dir = String(opts.openDirection || "LONG").toUpperCase();
      return {
        posture: dir === "SHORT" ? "Open Short" : "Open Long",
        direction: dir,
        sequence_type: null,
        stage: null,
        status: "open_position",
        path_forecast: null,
      };
    }
    return {
      posture: "Neutral",
      direction: "NEUTRAL",
      sequence_type: null,
      stage: 0,
      status: "none",
      path_forecast: null,
    };
  }

  const ranked = [...active].sort((a, b) => (
    (b.stage - a.stage)
    || (String(b.status).length - String(a.status).length)
    || (Number(b.confidence) - Number(a.confidence))
  ));
  const best = ranked[0];
  return {
    posture: openPosition
      ? (best.direction === "SHORT" ? "Open Short" : "Open Long")
      : best.posture,
    direction: best.direction,
    sequence_type: best.sequence_type,
    stage: best.stage,
    status: best.status,
    path_forecast: best.path_forecast,
    sequence_id: best.sequence_id,
  };
}

export function snapshotFromTrailScalars(row, ticker) {
  const ts = Number(row.ts);
  if (!Number.isFinite(ts)) return null;

  let flags = {};
  try {
    const raw = row.flags_json ?? row.flags;
    if (raw) flags = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    flags = {};
  }

  const sym = String(ticker || row.ticker || "").toUpperCase();
  const pdzD = flags.pdz_zone_D || null;
  const pdz4h = flags.pdz_zone_4h || flags.pdz_zone_h4 || null;
  const pdz1h = flags.pdz_zone_1h || flags.pdz_zone_h1 || pdz4h;

  return {
    ticker: sym,
    ts,
    event_ts: ts,
    price: Number(row.price) || null,
    state: row.state || null,
    kanban_stage: row.kanban_stage || null,
    flags,
    pdz_zone_D: pdzD,
    pdz_zone_4h: pdz4h,
    tf_tech: {
      D: {
        pdz: { zone: pdzD },
        fvg: {
          ib: flags.fvg_in_bull_D ? 1 : 0,
          ibr: flags.fvg_in_bear_D ? 1 : 0,
        },
      },
      "4H": { pdz: { zone: pdz4h } },
      240: { pdz: { zone: pdz4h } },
      60: { pdz: { zone: pdz1h } },
      "1H": { pdz: { zone: pdz1h } },
    },
    _snapshot_source: "trail_scalars",
  };
}

export function parseTrailSnapshotRow(row, ticker) {
  const payloadRaw = row?.payload_json ?? row?.payload;
  let payload = null;
  if (payloadRaw) {
    try {
      payload = typeof payloadRaw === "string" ? JSON.parse(payloadRaw) : payloadRaw;
    } catch {
      payload = null;
    }
  }

  if (payload && typeof payload === "object") {
    const ts = Number(row.ts ?? payload.ts ?? payload.event_ts ?? payload.computedAt);
    if (!Number.isFinite(ts)) return null;

    return {
      ...payload,
      ticker: String(payload.ticker || ticker || row.ticker || "").toUpperCase(),
      ts,
      event_ts: ts,
      price: Number(row.price ?? payload.price ?? payload.close ?? payload._live_price) || payload.price,
      state: row.state ?? payload.state,
      kanban_stage: row.kanban_stage ?? payload.kanban_stage,
      _snapshot_source: "payload_json",
    };
  }

  return snapshotFromTrailScalars(row, ticker);
}

export async function loadTrailSnapshots(db, ticker, opts = {}) {
  const sym = String(ticker || "").toUpperCase();
  if (!sym) return [];
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(opts.limit) || DEFAULT_LIMIT));
  const since = Number.isFinite(Number(opts.since)) ? Number(opts.since) : null;
  const until = Number.isFinite(Number(opts.until)) ? Number(opts.until) : null;
  const lookbackHours = Number.isFinite(Number(opts.lookbackHours))
    ? Number(opts.lookbackHours)
    : DEFAULT_LOOKBACK_HOURS;
  const effectiveSince = since ?? (Date.now() - lookbackHours * 60 * 60 * 1000);

  let query = `SELECT ts, price, state, kanban_stage, payload_json
    FROM timed_trail
    WHERE ticker = ?1 AND payload_json IS NOT NULL AND ts >= ?2`;
  const binds = [sym, effectiveSince];
  if (Number.isFinite(until)) {
    query += ` AND ts <= ?${binds.length + 1}`;
    binds.push(until);
  }
  query += ` ORDER BY ts ASC LIMIT ?${binds.length + 1}`;
  binds.push(limit);

  const rows = (await db.prepare(query).bind(...binds).all())?.results || [];
  const snapshots = [];
  for (const row of rows) {
    const snap = parseTrailSnapshotRow(row, sym);
    if (snap) snapshots.push(snap);
  }
  return snapshots;
}

export async function loadLatestKvSnapshot(kv, ticker) {
  if (!kv) return null;
  const latest = await kvGetJSON(kv, `timed:latest:${String(ticker || "").toUpperCase()}`);
  if (!latest || typeof latest !== "object") return null;
  const ts = Number(latest.ts ?? latest.computedAt ?? latest.updated_at ?? Date.now());
  return {
    ...latest,
    ticker: String(latest.ticker || ticker).toUpperCase(),
    ts,
    event_ts: ts,
  };
}

export async function loadDiagnosticSnapshots(db, kv, ticker, opts = {}) {
  const trail = await loadTrailSnapshots(db, ticker, opts);
  if (trail.length > 0) {
    return { snapshots: trail, source: "timed_trail" };
  }
  if (opts.allowLatestFallback === false) {
    return { snapshots: [], source: "none" };
  }
  const latest = await loadLatestKvSnapshot(kv, ticker);
  if (latest) {
    return { snapshots: [latest], source: "timed_latest" };
  }
  return { snapshots: [], source: "none" };
}

export function runSetupDiagnostics(snapshots = [], opts = {}) {
  const result = deriveSetupEventsFromWindow(snapshots, {
    ...opts,
    source: opts.source || "shadow_trail_diagnostics",
  });

  const activeSequences = (result.sequences || []).filter((s) => s.stage > 0);
  const pathForecasts = activeSequences.map((s) => ({
    sequence_id: s.sequence_id,
    sequence_type: s.sequence_type,
    direction: s.direction,
    status: s.status,
    stage: s.stage,
    posture: s.posture,
    path_forecast: s.path_forecast,
  }));
  const traderPosture = summarizeTraderPosture(result.sequences, opts.postureOpts || {});

  const latest = result.latest || snapshots[snapshots.length - 1] || null;
  const windowTs = snapshots.map((s) => Number(s.ts)).filter(Number.isFinite);

  return {
    shadow: true,
    snapshot_count: snapshots.length,
    window: {
      since_ts: windowTs.length ? Math.min(...windowTs) : null,
      until_ts: windowTs.length ? Math.max(...windowTs) : null,
      limit: opts.limit ?? DEFAULT_LIMIT,
    },
    context_used: opts.context || {},
    events: result.events,
    event_history: result.event_history,
    sequences: result.sequences,
    path_forecasts: pathForecasts,
    active_sequences: activeSequences,
    trader_posture: traderPosture,
    latest_summary: latest ? {
      ts: latest.ts ?? latest.event_ts,
      price: latest.price,
      state: latest.state,
      kanban_stage: latest.kanban_stage,
    } : null,
  };
}

export async function handleSetupDiagnosticsRoute({
  req,
  env,
  url,
  requireKeyOrAdmin,
  sendJSON,
  corsHeaders,
  normTicker,
} = {}) {
  const authFail = await requireKeyOrAdmin(req, env);
  if (authFail) return authFail;

  const db = env?.DB;
  if (!db) {
    return sendJSON({ ok: false, error: "d1_not_configured" }, 503, corsHeaders(env, req));
  }

  try {
    const ticker = normTicker(String(url.searchParams.get("ticker") || "").trim());
    if (!ticker) {
      return sendJSON({ ok: false, error: "missing_ticker" }, 400, corsHeaders(env, req));
    }

    const sinceRaw = url.searchParams.get("since");
    const untilRaw = url.searchParams.get("until");
    const limitRaw = url.searchParams.get("limit");
    const lookbackRaw = url.searchParams.get("lookbackHours");
    const bootstrapParam = url.searchParams.get("bootstrapFirst");
    const includeEmpty = url.searchParams.get("includeEmpty") === "1";
    const allowLatestFallback = url.searchParams.get("allowLatestFallback") !== "0";
    const kv = env.KV_TIMED || env.KV;

    const loaded = await loadDiagnosticSnapshots(db, kv, ticker, {
      since: sinceRaw ? Number(sinceRaw) : null,
      until: untilRaw ? Number(untilRaw) : null,
      limit: limitRaw ? Number(limitRaw) : DEFAULT_LIMIT,
      lookbackHours: lookbackRaw ? Number(lookbackRaw) : DEFAULT_LOOKBACK_HOURS,
      allowLatestFallback,
    });

    if (loaded.snapshots.length === 0) {
      return sendJSON({
        ok: false,
        error: "no_snapshots",
        ticker,
        hint: "no timed_trail.payload_json rows in window and no timed:latest KV payload — need fresh ingest or widen lookbackHours/since",
      }, 404, corsHeaders(env, req));
    }

    const latestSnapshot = loaded.snapshots[loaded.snapshots.length - 1];
    const context = buildDiagnosticsContext(latestSnapshot, env);
    const effectiveBootstrap = bootstrapParam === "1"
      || (bootstrapParam == null && loaded.source === "timed_latest" && loaded.snapshots.length === 1);
    const diagnostics = runSetupDiagnostics(loaded.snapshots, {
      context,
      bootstrapFirst: effectiveBootstrap,
      includeEmptySequences: includeEmpty,
      limit: limitRaw ? Number(limitRaw) : DEFAULT_LIMIT,
    });

    return sendJSON({
      ok: true,
      ticker,
      snapshot_source: loaded.source,
      ...diagnostics,
    }, 200, corsHeaders(env, req));
  } catch (e) {
    return sendJSON({
      ok: false,
      error: String(e?.message || e).slice(0, 400),
      stack: String(e?.stack || "").slice(0, 300),
    }, 500, corsHeaders(env, req));
  }
}
