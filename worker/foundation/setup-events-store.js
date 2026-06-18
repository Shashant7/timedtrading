// worker/foundation/setup-events-store.js
// -----------------------------------------------------------------------------
// Tier 2B: D1 setup_events ledger — append-only, idempotent event persistence.
// Gated by env.SETUP_EVENTS_WRITE; does not alter live scoring/trades.
// -----------------------------------------------------------------------------

import { deriveSetupEvents } from "./setup-event-derivation.js";
import { normalizeSetupEvents } from "./setup-events.js";

export const SETUP_EVENTS_SCHEMA_VERSION = 1;

export function setupEventsWriteEnabled(env) {
  const v = env?.SETUP_EVENTS_WRITE;
  return v === "1" || v === 1 || v === true || String(v).toLowerCase() === "true";
}

export function scoringVersionFromPayload(payload = {}) {
  return payload?.scoring_version || payload?._snapshot_v || null;
}

export function eventsFromSnapshotPair(prevSnapshot, currentSnapshot, opts = {}) {
  const source = opts.source || "scoring_cron";
  const version = scoringVersionFromPayload(currentSnapshot);
  const pairEvents = prevSnapshot
    ? deriveSetupEvents(prevSnapshot, currentSnapshot, { ...opts, bootstrap: false, source })
    : deriveSetupEvents(null, currentSnapshot, { ...opts, bootstrap: true, source });

  return normalizeSetupEvents(pairEvents.map((ev) => ({
    ...ev,
    payload: {
      ...(ev.payload || {}),
      scoring_version: version,
    },
  }))).events;
}

export function setupEventToDbBind(event) {
  return [
    event.event_id,
    event.ticker,
    event.tf,
    Number(event.event_ts),
    event.event_type,
    event.direction || null,
    Number.isFinite(Number(event.price)) ? Number(event.price) : null,
    event.source,
    Number.isFinite(Number(event.confidence)) ? Number(event.confidence) : null,
    JSON.stringify(event.payload || {}),
    Date.now(),
  ];
}

export async function ensureSetupEventsSchema(db) {
  if (!db) return { ok: false, skipped: true, reason: "no_db" };
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS setup_events (
      event_id TEXT PRIMARY KEY,
      ticker TEXT NOT NULL,
      tf TEXT NOT NULL,
      event_ts INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      direction TEXT,
      price REAL,
      source TEXT NOT NULL,
      confidence REAL,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    )`,
  ).run();
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_setup_events_ticker_ts ON setup_events (ticker, event_ts)`,
  ).run();
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_setup_events_type_ts ON setup_events (event_type, event_ts)`,
  ).run();
  return { ok: true };
}

export async function persistSetupEvents(db, events = []) {
  const normalized = normalizeSetupEvents(events).events;
  if (!normalized.length) return { ok: true, written: 0, skipped: 0 };

  let written = 0;
  let skipped = 0;
  const CHUNK = 40;
  for (let i = 0; i < normalized.length; i += CHUNK) {
    const chunk = normalized.slice(i, i + CHUNK);
    const stmts = chunk.map((ev) => db.prepare(
      `INSERT OR IGNORE INTO setup_events
        (event_id, ticker, tf, event_ts, event_type, direction, price, source, confidence, payload_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(...setupEventToDbBind(ev)));
    const results = await db.batch(stmts);
    for (const r of results || []) {
      const changes = Number(r?.meta?.changes || 0);
      if (changes > 0) written += 1;
      else skipped += 1;
    }
  }
  return { ok: true, written, skipped, total: normalized.length };
}

export async function loadSetupEvents(db, opts = {}) {
  const ticker = String(opts.ticker || "").toUpperCase();
  const since = Number(opts.since);
  const until = Number(opts.until);
  const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 500));
  if (!ticker) return [];

  let sql = `SELECT event_id, ticker, tf, event_ts, event_type, direction, price, source, confidence, payload_json, created_at
             FROM setup_events WHERE ticker = ?1`;
  const binds = [ticker];
  if (Number.isFinite(since)) {
    sql += ` AND event_ts >= ?${binds.length + 1}`;
    binds.push(since);
  }
  if (Number.isFinite(until)) {
    sql += ` AND event_ts <= ?${binds.length + 1}`;
    binds.push(until);
  }
  sql += ` ORDER BY event_ts ASC LIMIT ?${binds.length + 1}`;
  binds.push(limit);

  const rows = await db.prepare(sql).bind(...binds).all();
  return (rows?.results || []).map((row) => ({
    v: 1,
    event_id: row.event_id,
    ticker: row.ticker,
    tf: row.tf,
    event_ts: Number(row.event_ts),
    event_type: row.event_type,
    direction: row.direction,
    price: row.price != null ? Number(row.price) : null,
    source: row.source,
    confidence: row.confidence != null ? Number(row.confidence) : null,
    payload: (() => {
      try { return JSON.parse(row.payload_json || "{}"); } catch { return {}; }
    })(),
  }));
}

export async function maybePersistSetupEventsFromTick(env, ticker, prevPayload, currentPayload, opts = {}) {
  if (!setupEventsWriteEnabled(env)) {
    return { ok: true, skipped: true, reason: "write_disabled" };
  }
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db" };

  await ensureSetupEventsSchema(db);
  const events = eventsFromSnapshotPair(prevPayload, currentPayload, {
    source: opts.source || "scoring_cron",
    tdTfs: opts.tdTfs || ["D", "W", "60"],
    signalTfs: opts.signalTfs || ["D", "60", "30"],
  });
  if (!events.length) return { ok: true, written: 0, skipped: 0 };
  return persistSetupEvents(db, events);
}

export function dbRowToSetupEvent(row) {
  if (!row) return null;
  let payload = {};
  try {
    payload = typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : (row.payload || {});
  } catch {
    payload = {};
  }
  return {
    v: 1,
    event_id: row.event_id,
    ticker: row.ticker,
    tf: row.tf,
    event_ts: Number(row.event_ts),
    event_type: row.event_type,
    direction: row.direction,
    price: row.price != null ? Number(row.price) : null,
    source: row.source,
    confidence: row.confidence != null ? Number(row.confidence) : null,
    payload,
  };
}
