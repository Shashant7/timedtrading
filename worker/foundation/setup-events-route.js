// worker/foundation/setup-events-route.js
// Admin routes for setup_events ledger (read + shadow backfill).

import { deriveSetupEventsFromWindow } from "./setup-event-derivation.js";
import { parseTrailSnapshotRow } from "./setup-diagnostics-route.js";
import {
  ensureSetupEventsSchema,
  loadSetupEvents,
  persistSetupEvents,
  setupEventsWriteEnabled,
} from "./setup-events-store.js";

function corsJson(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...(corsHeaders || {}) },
  });
}

export async function handleSetupEventsGet(req, env, url, corsHeaders) {
  const db = env?.DB;
  if (!db) return corsJson({ ok: false, error: "no_db" }, 500, corsHeaders);

  const ticker = String(url.searchParams.get("ticker") || "").toUpperCase();
  if (!ticker) return corsJson({ ok: false, error: "ticker_required" }, 400, corsHeaders);

  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const limit = url.searchParams.get("limit");

  await ensureSetupEventsSchema(db);
  const events = await loadSetupEvents(db, {
    ticker,
    since: since != null ? Number(since) : null,
    until: until != null ? Number(until) : null,
    limit: limit != null ? Number(limit) : 500,
  });

  return corsJson({
    ok: true,
    shadow: true,
    ticker,
    count: events.length,
    write_enabled: setupEventsWriteEnabled(env),
    events,
  }, 200, corsHeaders);
}

export async function handleSetupEventsBackfill(req, env, url, corsHeaders) {
  const db = env?.DB;
  if (!db) return corsJson({ ok: false, error: "no_db" }, 500, corsHeaders);

  const dryRun = url.searchParams.get("dryRun") === "1";
  if (!dryRun && !setupEventsWriteEnabled(env)) {
    return corsJson({
      ok: false,
      error: "setup_events_write_disabled",
      hint: "Set SETUP_EVENTS_WRITE=1 on the worker or pass dryRun=1",
    }, 403, corsHeaders);
  }

  const ticker = String(url.searchParams.get("ticker") || "").toUpperCase();
  const since = Number(url.searchParams.get("since"));
  const until = Number(url.searchParams.get("until"));
  const trailSource = String(url.searchParams.get("trailSource") || "5m").toLowerCase();
  const eventSource = String(url.searchParams.get("source") || "admin_backfill").slice(0, 64);

  if (!ticker || !Number.isFinite(since) || !Number.isFinite(until)) {
    return corsJson({ ok: false, error: "ticker_since_until_required" }, 400, corsHeaders);
  }

  let rows;
  if (trailSource === "5m") {
    const res = await db.prepare(
      `SELECT bucket_ts, price_close, state, kanban_stage_end, phase_pct, pdz_zone, pdz_pct,
              fvg_bull_count, fvg_bear_count, ema_regime_D, had_squeeze_release, had_ema_cross,
              had_st_flip, had_momentum_elite
       FROM trail_5m_facts WHERE ticker = ?1 AND bucket_ts >= ?2 AND bucket_ts <= ?3
       ORDER BY bucket_ts ASC LIMIT 2000`,
    ).bind(ticker, since, until).all();
    rows = res?.results || [];
  } else if (trailSource === "snap" || trailSource === "payload") {
    const snapRes = await db.prepare(
      `SELECT ts, price, state, kanban_stage, phase_pct, flags_json, payload_json
       FROM timed_trail WHERE ticker = ?1 AND payload_json IS NOT NULL
         AND ts >= ?2 AND ts <= ?3
       ORDER BY ts ASC LIMIT 2000`,
    ).bind(ticker, since, until).all();
    rows = snapRes?.results || [];
    if (!rows.length) {
      const res = await db.prepare(
        `SELECT ts, price, state, kanban_stage, phase_pct, flags_json, payload_json
         FROM timed_trail WHERE ticker = ?1 AND ts >= ?2 AND ts <= ?3
         ORDER BY ts ASC LIMIT 2000`,
      ).bind(ticker, since, until).all();
      rows = res?.results || [];
    }
  } else {
    const res = await db.prepare(
      `SELECT ts, price, state, kanban_stage, phase_pct, flags_json, payload_json
       FROM timed_trail WHERE ticker = ?1 AND ts >= ?2 AND ts <= ?3
       ORDER BY ts ASC LIMIT 2000`,
    ).bind(ticker, since, until).all();
    rows = res?.results || [];
  }

  const snapshots = [];
  for (const row of rows) {
    const snap = parseTrailSnapshotRow(row, ticker);
    if (snap) snapshots.push(snap);
  }

  const derived = deriveSetupEventsFromWindow(snapshots, {
    bootstrapFirst: true,
    source: eventSource,
    tdTfs: ["D", "W", "60"],
    signalTfs: ["D", "60", "30"],
  });

  if (dryRun) {
    return corsJson({
      ok: true,
      dryRun: true,
      ticker,
      trail_source: trailSource,
      trail_rows: rows.length,
      snapshots: snapshots.length,
      events_derived: derived.events.length,
      sequences: derived.sequences?.length || 0,
    }, 200, corsHeaders);
  }

  await ensureSetupEventsSchema(db);
  const persist = await persistSetupEvents(db, derived.events);
  return corsJson({
    ok: true,
    ticker,
    trail_source: trailSource,
    trail_rows: rows.length,
    snapshots: snapshots.length,
    events_derived: derived.events.length,
    persist,
  }, 200, corsHeaders);
}
