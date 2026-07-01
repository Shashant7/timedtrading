// worker/macro-release-alerts.js
// Detect macro prints (actual lands), generate LLM summary, Discord #general,
// KV overlay payload, and activity-feed row.

import { notifyDiscord } from "./alerts.js";
import { kvGetJSON, kvPutJSON } from "./storage.js";
import { macroEventCanonicalKey } from "./macro-event-canonical.js";
import {
  macroEventHasReleased,
  nyNowParts,
  parseTimeEtMinutes,
} from "./macro-release-time.js";

const RELEASE_KV_PREFIX = "timed:macro:release:";
const RELEASED_FLAG_PREFIX = "timed:macro:released:";
const DEFAULT_MODEL = "gpt-4o-mini";

export function macroEventNormKey(date, name) {
  return macroEventCanonicalKey(date, name);
}

/** Parse headline macro strings (+85K, 0.30%, 7.5M, -55B) to a comparable number. */
export function parseEconNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/,/g, "");
  if (!s) return null;
  const pct = s.includes("%");
  s = s.replace(/%.*$/i, "").trim();
  const m = s.match(/^([+-]?[\d.]+)\s*([kKmMbB])?$/i);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = (m[2] || "").toLowerCase();
  if (suffix === "k") n *= 1e3;
  else if (suffix === "m") n *= 1e6;
  else if (suffix === "b") n *= 1e9;
  return pct ? n : n;
}

/**
 * Guard against broadcasting unverified macro prints. FSD/LLM-extracted
 * `actual` values are only trustworthy for a hard "released" alert when the
 * note reported a value that is genuinely distinct from consensus (a real
 * "X vs Ye" print). An actual that equals the estimate — or has no estimate —
 * is the fabrication signature (the LLM copied a single forecast into both
 * fields), e.g. the Jun S&P Manufacturing PMI that broadcast 55.7/55.7 IN LINE
 * while the real print was 53.9. FRED / curated actuals are authoritative and
 * always trusted (they are not derived from prose).
 */
export function macroReleaseIsTrustworthy(event) {
  const src = String(event?.actual_source || "").toLowerCase();
  if (src === "fred" || src === "curated" || src === "seed") return true;
  const a = parseEconNumber(event?.actual);
  const e = parseEconNumber(event?.estimate);
  if (a == null || e == null) return false;
  const tol = Math.max(Math.abs(e) * 0.001, 1e-9);
  return Math.abs(a - e) > tol;
}

export function classifySurprise(actual, estimate) {
  const a = parseEconNumber(actual);
  const e = parseEconNumber(estimate);
  if (a == null || e == null) {
    return { label: null, direction: null };
  }
  const tol = Math.max(Math.abs(e) * 0.08, 0.02);
  const diff = a - e;
  if (Math.abs(diff) <= tol) return { label: "IN LINE", direction: "inline" };
  return diff > 0
    ? { label: "ABOVE consensus", direction: "above" }
    : { label: "BELOW consensus", direction: "below" };
}

export function surpriseEmbedColor(direction, kind) {
  const k = String(kind || "").toLowerCase();
  const inflation = k === "inflation";
  if (direction === "inline") return 0x94a3b8;
  if (direction === "above") return inflation ? 0xef4444 : 0x22c55e;
  if (direction === "below") return inflation ? 0x22c55e : 0xf59e0b;
  return 0x38bdf8;
}

export function ruleBasedReleaseSummary(event, surprise) {
  const name = event?.name || "Macro release";
  const act = event?.actual ? `Actual ${event.actual}` : "Actual published";
  const est = event?.estimate ? ` vs est ${event.estimate}` : "";
  const prev = event?.previous ? ` (prev ${event.previous})` : "";
  const surp = surprise?.label ? ` — ${surprise.label}.` : ".";
  const kind = String(event?.kind || "").toLowerCase();
  let read = "Watch SPY/QQQ and rates for the first 30–60 minutes after the print.";
  if (kind === "inflation") {
    read = surprise?.direction === "above"
      ? "Hotter-than-expected inflation tends to pressure duration and growth multiples near-term."
      : surprise?.direction === "below"
        ? "Cooler-than-expected inflation often eases rate pressure and supports risk assets."
        : "In-line inflation usually limits immediate macro repricing.";
  } else if (kind === "jobs") {
    read = surprise?.direction === "above"
      ? "Stronger labor data can lift yields and tighten financial conditions."
      : surprise?.direction === "below"
        ? "Softer labor prints often support easier financial conditions."
        : "In-line labor data typically keeps the focus on the next inflation/Fed catalyst.";
  } else if (kind === "fomc") {
    read = "Fed decision days: focus on statement tone, dots, and press-conference guidance.";
  }
  return `${name}: ${act}${est}${prev}${surp} ${read}`.slice(0, 480);
}

/**
 * Smart poll interval for the Today macro strip (ms).
 * Aggressive near scheduled release windows; relaxed otherwise.
 */
export function computeMacroPollSchedule(events, now = new Date()) {
  const { date: today, minutes: nowMin, isWeekday } = nyNowParts(now);
  if (!isWeekday) return { poll_interval_ms: 900_000, reason: "weekend" };

  let interval = 900_000; // 15 min default
  let reason = "idle";
  let next_window_min = null;

  for (const e of events || []) {
    if (!e || e.date !== today) continue;
    const relMin = parseTimeEtMinutes(e.time_et);
    if (relMin == null) continue;
    const diff = relMin - nowMin; // negative = before release
    if (next_window_min == null || diff < next_window_min) next_window_min = diff;

    if (e.actual && e.release?.summary) {
      interval = Math.min(interval, 300_000);
      reason = "released";
      continue;
    }
    if (e.actual && !e.release?.summary) {
      interval = Math.min(interval, 120_000);
      reason = "awaiting_summary";
      continue;
    }
    // 15 min before → 45 min after: poll every 60s
    if (diff >= -15 && diff <= 45) {
      interval = Math.min(interval, 60_000);
      reason = "release_window";
    } else if (diff >= -120 && diff < -15) {
      interval = Math.min(interval, 120_000);
      reason = "pre_release";
    } else if (diff > 45 && diff <= 180) {
      interval = Math.min(interval, 180_000);
      reason = "post_release";
    }
  }

  return {
    poll_interval_ms: interval,
    reason,
    next_window_min,
    server_now_ms: now.getTime(),
  };
}

async function callOpenAI(env, systemPrompt, userPrompt) {
  const key = env?.OPENAI_API_KEY;
  if (!key) return { ok: false, error_kind: "no_openai_key" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: env?.OPENAI_MODEL || DEFAULT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_completion_tokens: 220,
        temperature: 0.3,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return { ok: false, error_kind: `openai_${resp.status}` };
    const json = await resp.json();
    return { ok: true, content: String(json.choices?.[0]?.message?.content || "").trim() };
  } catch (e) {
    return { ok: false, error_kind: e?.name === "AbortError" ? "openai_timeout" : "openai_exception" };
  } finally {
    clearTimeout(t);
  }
}

async function generateReleaseSummary(env, event, surprise) {
  const fallback = ruleBasedReleaseSummary(event, surprise);
  const llm = await callOpenAI(
    env,
    "Write 2-3 sentences summarizing a US macro data release for active traders. Plain language. No second-person pronouns. Mention actual vs estimate and likely SPY/rates reaction. No trade calls or position advice.",
    JSON.stringify({
      name: event.name,
      date: event.date,
      time_et: event.time_et,
      kind: event.kind,
      impact: event.impact,
      actual: event.actual,
      estimate: event.estimate,
      previous: event.previous || null,
      surprise: surprise?.label || null,
    }),
  );
  if (llm.ok && llm.content) return { summary: llm.content.slice(0, 520), source: "llm" };
  return { summary: fallback, source: "rule" };
}

async function appendMacroActivity(KV, row) {
  if (!KV) return;
  const key = "timed:activity:feed";
  const now = Date.now();
  const feed = (await kvGetJSON(KV, key)) || [];
  feed.unshift({
    ...row,
    ts: row.ts || now,
    id: `macro-${row.ticker || "MACRO"}-${now}-${Math.random().toString(36).slice(2, 7)}`,
  });
  const filtered = feed.filter((e) => Number(e.ts) > now - 7 * 86400000).slice(0, 500);
  await kvPutJSON(KV, key, filtered);
}

export async function loadMacroRelease(env, normKey) {
  const KV = env?.KV_TIMED || env?.KV;
  if (!KV || !normKey) return null;
  try {
    return await kvGetJSON(KV, `${RELEASE_KV_PREFIX}${normKey}`);
  } catch (_) {
    return null;
  }
}

export async function mergeMacroReleasesIntoEvents(env, events, now = new Date()) {
  const out = [];
  for (const e of events || []) {
    if (!macroEventHasReleased(e, now)) {
      out.push(e);
      continue;
    }
    const key = macroEventNormKey(e.date, e.name);
    const release = await loadMacroRelease(env, key);
    out.push(release ? { ...e, release } : e);
  }
  return out;
}

/**
 * Fire Discord + KV overlay when an event's actual first appears.
 * Idempotent per normKey + actual value.
 */
export async function processMacroReleaseAlerts(env, { events = [], today = null } = {}) {
  const KV = env?.KV_TIMED || env?.KV;
  const ny = nyNowParts();
  const todayStr = today || ny.date;
  const results = { checked: 0, alerted: 0, skipped: 0, errors: [] };

  for (const event of events || []) {
    if (!event?.actual || !event?.date || event.date > todayStr) continue;
    if (event.date < todayStr) continue; // only alert same-day prints
    if (!macroEventHasReleased(event)) continue;
    // Never broadcast an unverified LLM-extracted print (fabricated / copied
    // forecast). Authoritative FRED/curated actuals always pass.
    if (!macroReleaseIsTrustworthy(event)) {
      results.skipped += 1;
      continue;
    }
    results.checked += 1;

    const normKey = macroEventNormKey(event.date, event.name);
    const flagKey = `${RELEASED_FLAG_PREFIX}${normKey}`;
    let priorFlag = null;
    try {
      priorFlag = await KV?.get(flagKey);
    } catch (_) {}

    const actualStr = String(event.actual).trim();
    if (priorFlag === actualStr) {
      results.skipped += 1;
      continue;
    }

    const surprise = classifySurprise(event.actual, event.estimate);
    const { summary, source } = await generateReleaseSummary(env, event, surprise);
    const releasedAt = Date.now();
    const payload = {
      norm_key: normKey,
      name: event.name,
      date: event.date,
      time_et: event.time_et || null,
      kind: event.kind || null,
      impact: event.impact || null,
      actual: event.actual,
      estimate: event.estimate || null,
      previous: event.previous || null,
      actual_source: event.actual_source || null,
      surprise_label: surprise.label,
      surprise_direction: surprise.direction,
      summary,
      summary_source: source,
      released_at: releasedAt,
    };

    try {
      await kvPutJSON(KV, `${RELEASE_KV_PREFIX}${normKey}`, payload, 86400 * 14);
      await KV.put(flagKey, actualStr, { expirationTtl: 86400 * 7 });
    } catch (err) {
      results.errors.push(String(err?.message || err).slice(0, 120));
      continue;
    }

    const fields = [
      { name: "Actual", value: String(event.actual), inline: true },
    ];
    if (event.estimate) fields.push({ name: "Est", value: String(event.estimate), inline: true });
    if (event.previous) fields.push({ name: "Prev", value: String(event.previous), inline: true });
    if (surprise.label) fields.push({ name: "Surprise", value: surprise.label, inline: true });

    await notifyDiscord(env, {
      title: `${event.name} — released`,
      description: summary,
      fields,
      color: surpriseEmbedColor(surprise.direction, event.kind),
      footer: { text: "Timed Trading · Macro release" },
    }, "general").catch((err) => {
      results.errors.push(`discord:${String(err?.message || err).slice(0, 80)}`);
    });

    await appendMacroActivity(KV, {
      type: "MACRO_PRINT",
      event: "MACRO_PRINT",
      ticker: "MACRO",
      title: event.name,
      body: summary,
      actual: event.actual,
      estimate: event.estimate || null,
      surprise: surprise.label,
      ts: releasedAt,
    }).catch(() => {});

    results.alerted += 1;
  }

  return results;
}
