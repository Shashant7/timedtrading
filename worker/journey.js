// ═══════════════════════════════════════════════════════════════════════════
// worker/journey.js — the snapshot chain (Objective 2, Phase C1+C2 of
// tasks/2026-07-03-holiday-weekend-stabilization-plan.md).
//
// PRINCIPLE: a score is a frame; decisions need the film. Every */5 scoring
// tick appends a compact KEYFRAME per ticker (score, state, stage, bubble-map
// cell, phase/completion, freshness grade, price) when something meaningful
// changed (or on a 30-min heartbeat). The rolling window rides ON the scored
// payload (`_journey.recent`) so downstream consumers get journey features
// with zero extra reads; the durable chain lands in D1 `score_keyframes`
// for UI rendering (Phase D "the story") and cross-ticker analysis (C5).
//
// Cell discretization is DELIBERATELY the same as the trade-trajectory
// research program (worker/lib/trajectory-cells.js) — "how a bubble travels
// between corridors and quadrants" uses one vocabulary everywhere.
//
// Pure functions first (unit-testable, no I/O); D1 helpers at the bottom.
// ═══════════════════════════════════════════════════════════════════════════

import { cellOfFact } from "./lib/trajectory-cells.js";

export const JOURNEY_VERSION = 1;

const MIN = 60 * 1000;
const HEARTBEAT_MS = 30 * MIN;      // append at least every 30 min while scoring
const SCORE_DELTA_MIN = 5;          // |score delta| that forces a keyframe
const RECENT_MAX = 48;              // ring size on the payload (~1-2 sessions)
export const KEYFRAME_RETENTION_MS = 45 * 24 * 60 * 60 * 1000; // D1 purge horizon

/** Compact keyframe from a scored payload. Pure. */
export function buildKeyframe(payload, nowMs = Date.now()) {
  if (!payload || typeof payload !== "object") return null;
  const score = Number(payload.score ?? payload.rank);
  const cell = cellOfFact({
    state: payload.state,
    rank: payload.rank,
    completion: payload.completion,
    phase_pct: payload.phase_pct,
  }, { skipNeutral: false });
  return {
    t: nowMs,
    px: Number(payload._live_price ?? payload.price ?? payload.close) || null,
    sc: Number.isFinite(score) ? Math.round(score * 10) / 10 : null,
    htf: Number.isFinite(Number(payload.htf_score)) ? Math.round(Number(payload.htf_score) * 10) / 10 : null,
    ltf: Number.isFinite(Number(payload.ltf_score)) ? Math.round(Number(payload.ltf_score) * 10) / 10 : null,
    st: payload.state || null,
    kb: payload.kanban_stage || null,
    cell,
    ph: Number.isFinite(Number(payload.phase_pct)) ? Math.round(Number(payload.phase_pct) * 1000) / 1000 : null,
    cp: Number.isFinite(Number(payload.completion)) ? Math.round(Number(payload.completion) * 1000) / 1000 : null,
    fg: payload._freshness?.grade || null,
  };
}

/** Should this keyframe be appended to the chain? Pure. */
export function shouldAppendKeyframe(lastKf, kf) {
  if (!kf) return false;
  if (!lastKf) return true;
  if (kf.t - Number(lastKf.t || 0) >= HEARTBEAT_MS) return true;
  if ((kf.kb || null) !== (lastKf.kb || null)) return true;
  if ((kf.st || null) !== (lastKf.st || null)) return true;
  if ((kf.cell || null) !== (lastKf.cell || null)) return true;
  if (Number.isFinite(kf.sc) && Number.isFinite(lastKf.sc)
      && Math.abs(kf.sc - lastKf.sc) >= SCORE_DELTA_MIN) return true;
  return false;
}

/**
 * Journey features from the recent keyframe ring. Pure.
 * Slopes are score units per hour (positive = improving).
 */
export function computeJourneyFeatures(recent, nowMs = Date.now()) {
  const ring = Array.isArray(recent) ? recent.filter((k) => k && Number(k.t) > 0) : [];
  if (ring.length === 0) return null;
  const latest = ring[ring.length - 1];

  const slopeOver = (windowMs) => {
    const cutoff = nowMs - windowMs;
    // Oldest keyframe inside the window (ring is time-ordered).
    const base = ring.find((k) => k.t >= cutoff);
    if (!base || base.t >= latest.t) return null;
    if (!Number.isFinite(base.sc) || !Number.isFinite(latest.sc)) return null;
    const hours = (latest.t - base.t) / (60 * MIN);
    if (hours <= 0) return null;
    return Math.round(((latest.sc - base.sc) / hours) * 100) / 100;
  };

  // Stage dwell: how long has the CURRENT kanban stage been held?
  let stageChangedAt = null;
  for (let i = ring.length - 1; i >= 0; i--) {
    if ((ring[i].kb || null) !== (latest.kb || null)) break;
    stageChangedAt = ring[i].t;
  }

  // Corridor path: last distinct cells (most recent last), with entry times.
  const path = [];
  for (const k of ring) {
    if (!k.cell) continue;
    if (path.length === 0 || path[path.length - 1].cell !== k.cell) {
      path.push({ cell: k.cell, t: k.t });
    }
  }

  const slope1h = slopeOver(75 * MIN);       // 60m window + tick tolerance
  const slope1d = slopeOver(26 * 60 * MIN);  // ~1 trading day incl. overnight

  let direction = "flat";
  const s = Number.isFinite(slope1h) ? slope1h : (Number.isFinite(slope1d) ? slope1d : 0);
  if (s >= 1) direction = "improving";
  else if (s <= -1) direction = "deteriorating";

  return {
    score_slope_1h: slope1h,
    score_slope_1d: slope1d,
    direction,
    stage: latest.kb || null,
    stage_changed_at: stageChangedAt,
    time_in_stage_min: stageChangedAt ? Math.round((nowMs - stageChangedAt) / MIN) : null,
    cell: latest.cell || null,
    cell_path: path.slice(-6),
    cell_transitions: Math.max(0, path.length - 1),
    keyframes: ring.length,
    span_min: ring.length >= 2 ? Math.round((latest.t - ring[0].t) / MIN) : 0,
  };
}

/**
 * Advance a payload's journey with the current tick. Pure.
 * Returns { journey, appended } — `appended` is the new keyframe (for the
 * D1 chain) or null when the tick was within tolerance of the last frame.
 */
export function updateJourney(prevJourney, payload, nowMs = Date.now()) {
  const kf = buildKeyframe(payload, nowMs);
  const prevRecent = Array.isArray(prevJourney?.recent) ? prevJourney.recent : [];
  const lastKf = prevRecent.length ? prevRecent[prevRecent.length - 1] : null;

  if (!shouldAppendKeyframe(lastKf, kf)) {
    // No new frame — keep the chain, refresh features against "now".
    return {
      journey: {
        v: JOURNEY_VERSION,
        recent: prevRecent,
        features: computeJourneyFeatures(prevRecent, nowMs),
      },
      appended: null,
    };
  }

  const recent = [...prevRecent, kf].slice(-RECENT_MAX);
  return {
    journey: {
      v: JOURNEY_VERSION,
      recent,
      features: computeJourneyFeatures(recent, nowMs),
    },
    appended: kf,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// D1 durable chain — score_keyframes
// ───────────────────────────────────────────────────────────────────────────

let _journeySchemaReady = false;

export async function ensureJourneySchema(env) {
  if (_journeySchemaReady) return true;
  const db = env?.DB;
  if (!db) return false;
  try {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS score_keyframes (
        ticker TEXT NOT NULL,
        ts INTEGER NOT NULL,
        score REAL, htf REAL, ltf REAL,
        state TEXT, stage TEXT, cell TEXT,
        phase REAL, completion REAL, grade TEXT, price REAL,
        PRIMARY KEY (ticker, ts)
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_score_keyframes_ts ON score_keyframes (ts)`),
    ]);
    _journeySchemaReady = true;
    return true;
  } catch (e) {
    console.warn("[JOURNEY] schema ensure failed:", String(e?.message || e).slice(0, 150));
    return false;
  }
}

/** Batch-insert appended keyframes: [{ ticker, kf }]. Idempotent. */
export async function persistKeyframes(env, rows) {
  const db = env?.DB;
  const list = (rows || []).filter((r) => r?.ticker && r?.kf);
  if (!db || list.length === 0) return { inserted: 0 };
  if (!(await ensureJourneySchema(env))) return { inserted: 0, skipped: "no_schema" };
  let inserted = 0;
  const CHUNK = 80;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK).map(({ ticker, kf }) =>
      db.prepare(
        `INSERT OR REPLACE INTO score_keyframes
         (ticker, ts, score, htf, ltf, state, stage, cell, phase, completion, grade, price)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
      ).bind(
        String(ticker).toUpperCase(), kf.t, kf.sc, kf.htf, kf.ltf,
        kf.st, kf.kb, kf.cell, kf.ph, kf.cp, kf.fg, kf.px,
      ),
    );
    try {
      await db.batch(chunk);
      inserted += chunk.length;
    } catch (e) {
      console.warn(`[JOURNEY] keyframe batch ${i / CHUNK} failed:`, String(e?.message || e).slice(0, 150));
    }
  }
  return { inserted };
}

/** Nightly retention purge. */
export async function purgeOldKeyframes(env, nowMs = Date.now()) {
  const db = env?.DB;
  if (!db) return { deleted: 0 };
  if (!(await ensureJourneySchema(env))) return { deleted: 0 };
  try {
    const res = await db.prepare(`DELETE FROM score_keyframes WHERE ts < ?1`)
      .bind(nowMs - KEYFRAME_RETENTION_MS).run();
    return { deleted: res?.meta?.changes ?? 0 };
  } catch (e) {
    console.warn("[JOURNEY] purge failed:", String(e?.message || e).slice(0, 150));
    return { deleted: 0, error: String(e?.message || e).slice(0, 150) };
  }
}

/** Read a ticker's chain (ascending), default last 200 frames. */
export async function readKeyframes(env, ticker, opts = {}) {
  const db = env?.DB;
  const sym = String(ticker || "").toUpperCase();
  if (!db || !sym) return [];
  if (!(await ensureJourneySchema(env))) return [];
  const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 200));
  const sinceMs = Number(opts.sinceMs) || 0;
  try {
    const { results } = await db.prepare(
      `SELECT ticker, ts, score, htf, ltf, state, stage, cell, phase, completion, grade, price
       FROM (SELECT * FROM score_keyframes WHERE ticker = ?1 AND ts >= ?2 ORDER BY ts DESC LIMIT ?3)
       ORDER BY ts ASC`,
    ).bind(sym, sinceMs, limit).all();
    return results || [];
  } catch (e) {
    console.warn(`[JOURNEY] read failed for ${sym}:`, String(e?.message || e).slice(0, 150));
    return [];
  }
}
