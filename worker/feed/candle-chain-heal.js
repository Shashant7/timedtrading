// ═══════════════════════════════════════════════════════════════════════════
// worker/feed/candle-chain-heal.js — proactive candle-chain continuity.
//
// Companion to the display-staleness doctrine (feed-outputs.summarizeValueStale
// / MU-WDC-SOXL 2026-07-07). Prices flow every second; candles must flow with
// them. A real trading platform never renders an empty chart just because it
// hasn't backfilled — it stores as it goes, and heals gaps on detection.
//
// This module solves two failure modes that were leaking past the existing
// backfill lanes:
//
//  1. Broken chains — a ticker enters `timed:tickers` (screener promotion,
//     theme add) but its D/W/M/240/60/… candles never get seeded. Scoring
//     quarantines the payload with `missing_tfs: ["10","15","30","240","M",
//     "W","D"]` and it stays that way until the nightly onboard heal.
//     (BG, BABA, B, BE, AYI, BA — Jul 7 snapshot).
//
//  2. Silent staleness — a ticker's D/240 is intact but the ingest lane hasn't
//     touched it in hours; freshness marks it AGING then STALE. The existing
//     scoring-cron heal runs on tt-engine only, so during a tt-engine outage
//     candles rot indefinitely.
//
// The heal lane is called from the price-feed cron (`*/1`, runs on tt-feed +
// monolith fallback) with a small per-tick budget so it never dominates CPU
// or D1 request-count budgets. Bounded, priority-first, rotating.
// ═══════════════════════════════════════════════════════════════════════════

import { kvGetJSON, kvPutJSON } from "../storage.js";

/** Timeframes we heal from REST when they're missing/stale (order = priority). */
const HEAL_TFS = ["D", "60", "30", "10", "240", "W", "M"];

/** Watchdog paging threshold: <20 chain-gaps is expected churn, >=20 is bad. */
export const CHAIN_GAP_ALARM_THRESHOLD = 20;

/**
 * Normalize chain-gap backlog state for health surfaces and cron paging.
 * A small queue is expected while new symbols are being seeded; a queue at
 * the threshold means the bounded heal budget is not catching up.
 */
export function summarizeChainGapBacklog(candidates = [], result = null) {
  const count = Array.isArray(candidates) ? candidates.length : 0;
  const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
  return {
    candidates_count: count,
    threshold: CHAIN_GAP_ALARM_THRESHOLD,
    alarm_active: count >= CHAIN_GAP_ALARM_THRESHOLD,
    attempted: Array.isArray(result?.attempted) ? result.attempted.length : 0,
    healed: Array.isArray(result?.healed) ? result.healed.length : 0,
    failed,
  };
}

/** Extract stale-chain candidates from the freshness summary. */
export function extractChainGapCandidates(summary) {
  const out = [];
  if (!summary || typeof summary !== "object") return out;
  const seen = new Set();
  for (const row of (summary.stale_tickers || [])) {
    const ticker = String(row?.ticker || "").toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    const missing = Array.isArray(row?.missing_tfs) ? row.missing_tfs : [];
    const stale = Array.isArray(row?.stale_tfs) ? row.stale_tfs : [];
    if (missing.length === 0 && stale.length === 0) continue;
    seen.add(ticker);
    out.push({
      ticker,
      missing,
      stale,
      needs_full_onboard: missing.includes("D") && missing.includes("10"),
    });
  }
  return out;
}

/** New tickers = in current universe list, not in the last-snapshot set. */
export function detectNewTickers(current, previous) {
  const cur = new Set((current || []).map((t) => String(t || "").toUpperCase()).filter(Boolean));
  const prev = new Set((previous || []).map((t) => String(t || "").toUpperCase()).filter(Boolean));
  const out = [];
  for (const t of cur) if (!prev.has(t)) out.push(t);
  return out;
}

/**
 * Heal detected chain gaps from REST. `deps.backfill(env, [ticker], tf, opts)`
 * is the injected provider call so this module stays a pure orchestrator.
 *
 * Budget: up to `maxTickers` per tick (default 6); each ticker heals its top-N
 * missing/stale TFs. Priority tickers (open positions) go first, then rotate
 * the remainder so the tail can't starve.
 */
export async function healChainGaps(env, ctx, candidates, deps = {}, opts = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (list.length === 0) return { healed: [], attempted: [], failed: [], candidates_count: 0 };
  const priority = new Set(
    (opts.priorityTickers || []).map((t) => String(t || "").toUpperCase()).filter(Boolean),
  );
  const maxTickers = Math.max(1, Math.min(20, Number(opts.maxTickers) || 6));
  const nowMs = Date.now();

  const priList = list.filter((c) => priority.has(c.ticker));
  const restList = list.filter((c) => !priority.has(c.ticker));
  const rot = Number.isFinite(Number(opts.rotationOffset))
    ? Math.abs(Math.trunc(Number(opts.rotationOffset)))
    : Math.floor(nowMs / 60000);
  const start = restList.length > 0 ? rot % restList.length : 0;
  const rotated = [...restList.slice(start), ...restList.slice(0, start)];
  const targets = [...priList, ...rotated].slice(0, maxTickers);

  const backfill = typeof deps.backfill === "function" ? deps.backfill : null;
  const onboard = typeof deps.onboard === "function"
    ? deps.onboard
    : (typeof deps.onboardTicker === "function" ? deps.onboardTicker : null);
  const attempted = [];
  const healed = [];
  const failed = [];

  for (const cand of targets) {
    const t = cand.ticker;
    attempted.push(t);
    try {
      if (cand.needs_full_onboard && onboard) {
        // Full chain — D/W/M/240/60/30/10/5 with a longer lookback so the
        // ticker becomes scorable in the current tick.
        await onboard(env, t, { sinceDays: 730 });
        healed.push({ ticker: t, mode: "onboard" });
        continue;
      }
      if (!backfill) continue;
      const tfs = [...new Set([...(cand.missing || []), ...(cand.stale || [])])]
        .filter((tf) => HEAL_TFS.includes(String(tf)));
      if (tfs.length === 0) continue;
      for (const tf of tfs) {
        const sinceDays = tf === "W" ? 90 : tf === "M" ? 400 : tf === "D" ? 30 : 5;
        try { await backfill(env, [t], String(tf), { sinceDays }); } catch (_) {}
      }
      healed.push({ ticker: t, mode: "backfill", tfs });
    } catch (e) {
      failed.push({ ticker: t, error: String(e?.message || e).slice(0, 150) });
    }
  }

  if (attempted.length > 0) {
    console.log(
      `[CANDLE_CHAIN_HEAL] attempted=${attempted.length} healed=${healed.length} failed=${failed.length}`
      + (healed.length ? ` — ${healed.map((h) => `${h.ticker}:${h.mode}`).join(",")}` : "")
      + (failed.length ? ` — FAILED: ${failed.map((f) => f.ticker).join(",")}` : ""),
    );
  }

  if (ctx && typeof ctx.waitUntil === "function" && env?.KV_TIMED) {
    ctx.waitUntil(kvPutJSON(env.KV_TIMED, "timed:candle_chain_heal:last", {
      ts: nowMs,
      attempted,
      healed,
      failed,
      candidates_count: list.length,
    }).catch(() => {}));
  }

  return { healed, attempted, failed, candidates_count: list.length };
}

/**
 * Diff the current universe list against the last-observed snapshot in KV; any
 * ticker present now but absent then is a new addition that needs a full
 * candle backfill. Idempotent — the snapshot is bumped only after the backfill
 * attempt so a crashed tick retries next minute.
 */
export async function onboardNewUniverseTickers(env, ctx, currentUniverse, deps = {}, opts = {}) {
  if (!env?.KV_TIMED) return { new_count: 0 };
  const KV = env.KV_TIMED;
  let previous = [];
  try {
    const raw = await kvGetJSON(KV, "timed:candle_chain:universe_seen");
    if (Array.isArray(raw)) previous = raw;
    else if (Array.isArray(raw?.list)) previous = raw.list;
  } catch (_) {}
  const news = detectNewTickers(currentUniverse, previous);
  if (news.length === 0) return { new_count: 0 };
  const maxOnboard = Math.max(1, Math.min(8, Number(opts.maxOnboard) || 4));
  const target = news.slice(0, maxOnboard);
  console.log(`[CANDLE_CHAIN_HEAL] Detected ${news.length} new universe ticker(s), onboarding ${target.length}: ${target.join(",")}`);
  const onboard = typeof deps.onboard === "function"
    ? deps.onboard
    : (typeof deps.onboardTicker === "function" ? deps.onboardTicker : null);
  let onboarded = 0;
  if (onboard) {
    for (const t of target) {
      try {
        await onboard(env, t, { sinceDays: 730 });
        onboarded++;
      } catch (e) {
        console.warn(`[CANDLE_CHAIN_HEAL] Onboard failed for ${t}:`, String(e?.message || e).slice(0, 150));
      }
    }
  }
  // Bump the snapshot regardless — a permanently failing onboard shouldn't
  // block detection of NEXT new tickers. Reappears if freshness marks them.
  try {
    await kvPutJSON(KV, "timed:candle_chain:universe_seen", {
      ts: Date.now(),
      list: (currentUniverse || []).map((t) => String(t || "").toUpperCase()).filter(Boolean),
    });
  } catch (_) {}
  return { new_count: news.length, onboarded, target };
}
