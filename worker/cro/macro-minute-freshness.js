// worker/cro/macro-minute-freshness.js
//
// First-class guard for Tom Lee's Macro Minute night take. A thin FSD blurb
// or a missed evening post must not silently look like "research is current".
// Status is persisted to KV `timed:cro:mm-freshness` and tombstoned so the
// watchdog / pipeline-health pane can page.

import { splitMacroMinuteBody } from "./vimeo-transcript.js";
import { recordCronFailure, recordCronSuccess } from "../alerts.js";

export const MM_FRESHNESS_KV = "timed:cro:mm-freshness";

/** ET weekday 0=Sun .. 6=Sat and hour 0-23. */
export function etClock(nowMs = Date.now()) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(nowMs));
  const wk = (parts.find((p) => p.type === "weekday") || {}).value || "";
  const hourRaw = Number((parts.find((p) => p.type === "hour") || {}).value);
  const hour = hourRaw === 24 ? 0 : hourRaw;
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dow: map[wk] ?? 0, hour: Number.isFinite(hour) ? hour : 0 };
}

/** ET calendar date (YYYY-MM-DD) plus hour for a timestamp. */
export function etDateParts(ms) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "numeric", hour12: false,
  });
  const parts = dtf.formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const hourRaw = Number(get("hour"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: hourRaw === 24 ? 0 : (Number.isFinite(hourRaw) ? hourRaw : 0),
  };
}

/**
 * Evening after which that day's episode should have landed. Episodes post
 * ~5-7 PM ET and the fsd-evening catch-up runs 8-11 PM ET.
 */
export const MM_SESSION_CUTOFF_ET_HOUR = 22;

/** Consecutive expected evenings that may pass before the desk is stale. */
export const MM_MAX_MISSED_SESSIONS = 2;

/**
 * Days a Macro Minute is actually expected: Monday through Thursday.
 *
 * The show is not daily. Across Jul-Aug 2026 every single Friday was skipped
 * (7 of 7) and weekends never publish, so counting those hours as staleness
 * paged on Sundays for a source that had nothing to publish.
 */
export function isMacroMinuteSessionDay(isoDate) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  if (!y || !m || !d) return false;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow >= 1 && dow <= 4;
}

function addDays(isoDate, n) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * How many expected evening slots have closed with no new episode.
 *
 * Calendar arithmetic rather than elapsed hours, so Fridays, weekends and DST
 * shifts cannot accrue staleness. The publish day itself never counts — it
 * produced an episode.
 */
export function countMissedMacroMinuteSessions(publishedAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(publishedAtMs)) return Infinity;
  const pub = etDateParts(publishedAtMs);
  const now = etDateParts(nowMs);
  let missed = 0;
  let day = addDays(pub.date, 1);
  for (let guard = 0; day <= now.date && guard < 400; guard++) {
    if (isMacroMinuteSessionDay(day)) {
      const closed = day < now.date || now.hour >= MM_SESSION_CUTOFF_ET_HOUR;
      if (closed) missed++;
    }
    day = addDays(day, 1);
  }
  return missed;
}

export function assessMacroMinuteFreshness({
  nowMs = Date.now(),
  publishedAt = null,
  hasTranscript = false,
  charCount = 0,
  maxMissedSessions = MM_MAX_MISSED_SESSIONS,
} = {}) {
  const { dow, hour } = etClock(nowMs);
  const pubMs = Date.parse(publishedAt);
  const ageH = Number.isFinite(pubMs) ? (nowMs - pubMs) / 3600000 : Infinity;
  const missed = countMissedMacroMinuteSessions(pubMs, nowMs);
  const thin = !hasTranscript || Number(charCount) < 1500;
  let status = "fresh";
  if (!publishedAt || !Number.isFinite(pubMs)) status = "missing";
  else if (thin) status = "thin";
  else if (missed >= maxMissedSessions) status = "stale";
  return {
    status,
    age_hours: Number.isFinite(ageH) ? Math.round(ageH * 10) / 10 : null,
    missed_sessions: Number.isFinite(missed) ? missed : null,
    max_missed_sessions: maxMissedSessions,
    has_transcript: !!hasTranscript,
    char_count: Number(charCount) || 0,
    published_at: publishedAt || null,
    et: { dow, hour },
    assessed_at: nowMs,
  };
}

export async function loadLatestMacroMinuteRow(env) {
  try {
    return await env.DB.prepare(`
      SELECT p.pub_id, p.title, p.published_at, p.fetched_at, p.source_url,
             p.fetch_status, p.applied_at, p.proposal_id, p.source,
             IFNULL(t.char_count, 0) AS char_count,
             IFNULL(t.text_full, '') AS text_full,
             IFNULL(t.text_excerpt, '') AS text_excerpt
      FROM cro_publications p
      LEFT JOIN cro_publication_text t ON t.pub_id = p.pub_id
      WHERE p.fetch_status = 'ok'
        AND lower(p.title) LIKE '%macro minute%'
      ORDER BY COALESCE(p.published_at, '') DESC, p.fetched_at DESC
      LIMIT 1
    `).first();
  } catch (_) {
    return null;
  }
}

export async function assessAndPersistMacroMinuteFreshness(env, { nowMs = Date.now(), syncedPubId = null } = {}) {
  const row = await loadLatestMacroMinuteRow(env);
  const split = splitMacroMinuteBody(row?.text_full || "");
  const report = assessMacroMinuteFreshness({
    nowMs,
    publishedAt: row?.published_at || null,
    hasTranscript: split.has_transcript,
    charCount: Number(row?.char_count) || split.transcript.length || 0,
  });
  report.pub_id = row?.pub_id || null;
  report.title = row?.title ? String(row.title).slice(0, 120) : null;
  if (syncedPubId) {
    report.synced_pub_id = syncedPubId;
  } else {
    try {
      const prevRaw = await (env?.KV_TIMED || env?.KV)?.get(MM_FRESHNESS_KV);
      const prev = prevRaw ? JSON.parse(prevRaw) : null;
      if (prev?.synced_pub_id) report.synced_pub_id = prev.synced_pub_id;
    } catch (_) { /* ignore */ }
  }

  try {
    const KV = env?.KV_TIMED || env?.KV;
    if (KV) await KV.put(MM_FRESHNESS_KV, JSON.stringify(report), { expirationTtl: 7 * 86400 });
  } catch (_) { /* never block */ }

  if (report.status === "fresh") {
    recordCronSuccess(env, "macro_minute_freshness").catch(() => {});
  } else if (report.status === "stale" || report.status === "missing") {
    // Say what is actually wrong. "stale age_h=90.1" read like our cron broke
    // when the real condition is Fundstrat not publishing on expected evenings.
    const detail = report.status === "missing"
      ? "no Macro Minute episode found in the research store"
      : `no new episode across ${report.missed_sessions} expected evenings (Mon-Thu)`
        + `; last was ${report.published_at || "unknown"}`;
    recordCronFailure(env, {
      op: "macro_minute_freshness",
      error: `${detail} — source gap, not a pipeline failure`,
      caller: "macro_minute_guard",
    }).catch(() => {});
  } else if (report.status === "thin") {
    recordCronFailure(env, {
      op: "macro_minute_freshness",
      error: `thin char_count=${report.char_count} pub=${report.pub_id || "none"}`,
      caller: "macro_minute_guard",
      skipDiscord: true,
    }).catch(() => {});
  }
  return report;
}
