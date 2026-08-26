// worker/openai-spend.js
// Unified OpenAI spend tracking + brief-cron retry scheduling.

import { normalizeBriefCronError, isOpenAiQuotaError, recordBriefCronOutcome } from "./alerts.js";

const SPEND_KV_PREFIX = "timed:openai:spend:";
const SPEND_TTL_SEC = 90 * 86400; // ~13 weeks retention

/** ISO week key (UTC): `2026-W34` */
export function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Conservative per-call USD estimate (matches CIO lifecycle gate tiers). */
export function estimatedCostUsd(model, usage = {}) {
  const pt = Number(usage.prompt_tokens ?? usage.promptTokens);
  const ct = Number(usage.completion_tokens ?? usage.completionTokens);
  if (Number.isFinite(pt) && Number.isFinite(ct) && (pt > 0 || ct > 0)) {
    const m = String(model || "").toLowerCase();
    let inputPer1M = 0.15;
    let outputPer1M = 0.60;
    if (m.startsWith("gpt-5")) {
      inputPer1M = 2.5;
      outputPer1M = 10.0;
    } else if (m.includes("gpt-4o") && !m.includes("mini")) {
      inputPer1M = 2.5;
      outputPer1M = 10.0;
    } else if (m.includes("mini")) {
      inputPer1M = 0.15;
      outputPer1M = 0.60;
    }
    return (pt / 1e6) * inputPer1M + (ct / 1e6) * outputPer1M;
  }
  const m = String(model || "").toLowerCase();
  if (m.startsWith("gpt-5")) return 0.04;
  if (m.startsWith("gpt-4o")) return m.includes("mini") ? 0.001 : 0.003;
  if (m.startsWith("o1")) return 0.012;
  return 0.001;
}

async function readWeekBlob(env, weekKey) {
  const KV = env?.KV_TIMED;
  if (!KV) return { week: weekKey, features: {}, total_usd: 0, total_calls: 0 };
  try {
    const raw = await KV.get(`${SPEND_KV_PREFIX}${weekKey}`, "json");
    if (raw && typeof raw === "object") {
      return {
        week: weekKey,
        features: raw.features || {},
        total_usd: Number(raw.total_usd) || 0,
        total_calls: Number(raw.total_calls) || 0,
        updated_at: raw.updated_at || null,
      };
    }
  } catch (_) { /* best effort */ }
  return { week: weekKey, features: {}, total_usd: 0, total_calls: 0 };
}

/**
 * Record estimated OpenAI spend for a product feature (weekly rollup).
 * @param {string} feature e.g. daily_brief_morning, news_sentiment, cio_lifecycle
 */
export async function recordOpenAiSpend(env, feature, opts = {}) {
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false, error: "no_kv" };
  const feat = String(feature || "unknown").slice(0, 64).replace(/[^a-z0-9_]/gi, "_");
  const model = opts.model || null;
  const usd = Number(opts.usd) > 0
    ? Number(opts.usd)
    : estimatedCostUsd(model, {
      prompt_tokens: opts.prompt_tokens ?? opts.promptTokens,
      completion_tokens: opts.completion_tokens ?? opts.completionTokens,
    });
  if (!(usd > 0)) return { ok: true, skipped: "zero_usd" };
  const weekKey = isoWeekKey();
  const blob = await readWeekBlob(env, weekKey);
  const cur = blob.features[feat] || { usd: 0, calls: 0, models: {} };
  cur.usd = Math.round((Number(cur.usd) + usd) * 1e6) / 1e6;
  cur.calls = (Number(cur.calls) || 0) + 1;
  if (model) {
    const mk = String(model).slice(0, 32);
    cur.models[mk] = (Number(cur.models[mk]) || 0) + 1;
  }
  blob.features[feat] = cur;
  blob.total_usd = Math.round((Object.values(blob.features).reduce((s, f) => s + Number(f.usd || 0), 0)) * 1e4) / 1e4;
  blob.total_calls = Object.values(blob.features).reduce((s, f) => s + Number(f.calls || 0), 0);
  blob.updated_at = Date.now();
  try {
    await KV.put(`${SPEND_KV_PREFIX}${weekKey}`, JSON.stringify(blob), { expirationTtl: SPEND_TTL_SEC });
    return { ok: true, week: weekKey, feature: feat, usd_added: usd };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/** Weekly feature-by-dollar report (current week + prior weeks). */
export async function getWeeklyOpenAiSpendReport(env, opts = {}) {
  const weeksBack = Math.max(1, Math.min(12, Number(opts.weeks) || 4));
  const weeks = [];
  const now = new Date();
  for (let i = 0; i < weeksBack; i++) {
    const d = new Date(now.getTime() - i * 7 * 86400000);
    const wk = isoWeekKey(d);
    const blob = await readWeekBlob(env, wk);
    const features = Object.entries(blob.features || {})
      .map(([feature, row]) => ({
        feature,
        usd: Math.round(Number(row.usd || 0) * 100) / 100,
        calls: Number(row.calls) || 0,
        models: row.models || {},
      }))
      .sort((a, b) => b.usd - a.usd);
    weeks.push({
      week: wk,
      total_usd: Math.round(Number(blob.total_usd || 0) * 100) / 100,
      total_calls: blob.total_calls || 0,
      features,
      updated_at: blob.updated_at || null,
    });
  }

  // CIO monthly cap visibility (legacy KV — folded into report header).
  let cio_monthly_usd = 0;
  let cio_monthly_cap = null;
  try {
    const d = new Date();
    const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const raw = await env?.KV_TIMED?.get(`ai_cio:spend:${monthKey}`);
    cio_monthly_usd = Number(raw) || 0;
    const capRaw = env?.AI_CIO_MONTHLY_USD_CAP ?? env?._deepAuditConfig?.ai_cio_monthly_usd_cap;
    if (capRaw != null) cio_monthly_cap = Number(capRaw) || 50;
  } catch (_) { /* optional */ }

  return {
    ok: true,
    generated_at: Date.now(),
    current_week: weeks[0]?.week || isoWeekKey(),
    weeks,
    cio_monthly_usd: Math.round(cio_monthly_usd * 100) / 100,
    cio_monthly_cap_usd: cio_monthly_cap,
    note: "USD estimates use token usage when available; otherwise conservative flat per-call estimates.",
  };
}

const BRIEF_RETRY_DELAY_MS = 5 * 60 * 1000;

/** True when a failed brief cron should get a single delayed retry (not quota). */
export function shouldScheduleBriefRetry(outcome) {
  if (!outcome || outcome.ok || outcome.skipped === "already_generated") return false;
  const err = outcome.error || outcome.error_kind || "unknown";
  if (isOpenAiQuotaError(err)) return false;
  const norm = normalizeBriefCronError(err);
  if (norm.requiresOperatorAction) return false;
  return true;
}

/**
 * Schedule ONE brief retry after 5 minutes (Workers waitUntil + sleep).
 * Quota failures are never retried — billing must be restored first.
 */
export function scheduleBriefCronRetry(ctx, env, op, retryFn) {
  if (!ctx?.waitUntil || typeof retryFn !== "function") return;
  const safeOp = String(op || "brief").slice(0, 64).replace(/[^a-z0-9_]/gi, "_");
  ctx.waitUntil((async () => {
    await new Promise((r) => setTimeout(r, BRIEF_RETRY_DELAY_MS));
    const KV = env?.KV_TIMED;
    const retryKey = `timed:brief:retry:${safeOp}:${new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })}`;
    try {
      if (KV) {
        const prior = await KV.get(retryKey, "json");
        if (prior?.attempted) {
          console.log(`[BRIEF RETRY] Skip ${safeOp} — retry already attempted today`);
          return;
        }
        await KV.put(retryKey, JSON.stringify({ attempted: true, scheduled_at: Date.now() }), { expirationTtl: 86400 });
      }
      console.log(`[BRIEF RETRY] Running delayed retry for ${safeOp}...`);
      const result = await retryFn();
      console.log(`[BRIEF RETRY] ${safeOp}: ${result?.ok ? "OK" : result?.error || "failed"} (${result?.elapsed || 0}ms)`);
      await recordBriefCronOutcome(env, safeOp, result);
    } catch (e) {
      console.error(`[BRIEF RETRY] ${safeOp} threw:`, String(e?.message || e).slice(0, 200));
      await recordBriefCronOutcome(env, safeOp, { ok: false, error: String(e?.message || e), caller: "brief_retry" });
    }
  })());
}
