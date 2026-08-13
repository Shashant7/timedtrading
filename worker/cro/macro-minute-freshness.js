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

/**
 * How old the latest spoken MM may be before we call it stale.
 * Weekday after 10 PM ET: tonight's episode should already be in.
 * Weekday daytime: yesterday evening is OK.
 * Weekend / Monday morning: Friday's episode is OK.
 */
export function expectedMaxAgeHours(etDow, etHour) {
  const dow = Number(etDow);
  const hour = Number(etHour);
  if (dow === 0 || dow === 6) return 90;
  if (dow === 1 && hour < 18) return 90;
  if (hour >= 22) return 8;
  return 30;
}

export function assessMacroMinuteFreshness({
  nowMs = Date.now(),
  publishedAt = null,
  hasTranscript = false,
  charCount = 0,
} = {}) {
  const { dow, hour } = etClock(nowMs);
  const maxAgeH = expectedMaxAgeHours(dow, hour);
  const pubMs = Date.parse(publishedAt);
  const ageH = Number.isFinite(pubMs) ? (nowMs - pubMs) / 3600000 : Infinity;
  const thin = !hasTranscript || Number(charCount) < 1500;
  let status = "fresh";
  if (!publishedAt || !Number.isFinite(pubMs)) status = "missing";
  else if (thin) status = "thin";
  else if (ageH > maxAgeH) status = "stale";
  return {
    status,
    age_hours: Number.isFinite(ageH) ? Math.round(ageH * 10) / 10 : null,
    max_age_hours: maxAgeH,
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
    recordCronFailure(env, {
      op: "macro_minute_freshness",
      error: `${report.status} age_h=${report.age_hours} pub=${report.pub_id || "none"}`,
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
