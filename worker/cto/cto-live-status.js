// worker/cto/cto-live-status.js
// Live honesty layer for CTO probabilistic levels: distance-to-level,
// hit/faded status since the snapshot anchor, and signal_outcomes recording.

import { isNyRegularMarketOpen } from "../market-calendar.js";

const HORIZON_DAYS = 20;

async function kvGetJSON(kv, key) {
  if (!kv) return null;
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Load { SYM: price } from timed:prices KV — session-aware.
 *
 * Outside RTH (overnight / pre-market / post-market) the live overlay MUST use
 * the extended print (`ahp`) so an overnight or pre-market move re-distances the
 * level map in the morning. `p` outside RTH is yesterday's RTH CLOSE (per the
 * price-data-pipeline contract), so using it would show "no movement" until the
 * open. During RTH we MUST use `p` (the live RTH price) — TwelveData returns
 * stale `ahp` while the market is open, so this is gated on the session.
 */
export async function loadLivePriceMap(env) {
  const kv = env?.KV_TIMED || env?.KV;
  const blob = await kvGetJSON(kv, "timed:prices");
  if (!blob) return {};
  const prices = blob.prices || blob;
  let marketOpen = true;
  try { marketOpen = isNyRegularMarketOpen(null); } catch (_) { marketOpen = true; }
  const out = {};
  for (const [sym, row] of Object.entries(prices || {})) {
    const ext = Number(row?.ahp);
    const rth = Number(row?.p ?? row?.price ?? row?.c ?? row?.close);
    const px = (!marketOpen && Number.isFinite(ext) && ext > 0) ? ext : rth;
    if (Number.isFinite(px) && px > 0) out[String(sym).toUpperCase()] = px;
  }
  return out;
}

/**
 * Enrich one magnet level with live distance + status since snapshot anchor.
 * @returns enriched level object or null
 */
export function enrichCTOLevel(level, direction, livePrice, anchorPrice) {
  if (!level) return null;
  const target = Number(level.price);
  const live = Number(livePrice);
  const anchor = Number(anchorPrice);
  const base = {
    label: level.label,
    price: target,
    adj_prob: level.adj_prob ?? level.regime_adjusted_prob,
    distance_pct: level.distance_pct,
    golden_gate: !!level.golden_gate,
  };
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(live) || live <= 0) {
    return { ...base, live_distance_pct: null, level_status: "unknown" };
  }

  const liveDistancePct = Number((((target - live) / live) * 100).toFixed(2));
  let level_status = "open";
  const tol = 0.15; // within 0.15% counts as at level

  if (direction === "up") {
    if (live >= target * (1 - tol / 100)) level_status = "hit";
    else if (Number.isFinite(anchor) && anchor > 0 && live < anchor * (1 - 0.008)) {
      level_status = "faded";
    }
  } else {
    if (live <= target * (1 + tol / 100)) level_status = "hit";
    else if (Number.isFinite(anchor) && anchor > 0 && live > anchor * (1 + 0.008)) {
      level_status = "faded";
    }
  }

  return {
    ...base,
    live_distance_pct: liveDistancePct,
    level_status,
  };
}

/** Summarize whether the paired read is playing out, hit, or fading. */
export function computeCTOReadStatus(item) {
  const up = item?.top_upside;
  const dn = item?.top_downside;
  const upHit = up?.level_status === "hit";
  const dnHit = dn?.level_status === "hit";
  const upFaded = up?.level_status === "faded";
  const dnFaded = dn?.level_status === "faded";
  const lean = item?.lean;
  const kind = item?.read_kind;

  if (kind === "range" || (!lean && kind === "mixed")) {
    if (upHit && dnHit) return { status: "hit", label: "Both magnets touched" };
    if (upHit) return { status: "partial", label: "Upside magnet hit" };
    if (dnHit) return { status: "partial", label: "Downside magnet hit" };
    return { status: "open", label: "Range still in play" };
  }
  if (lean === "up" || kind === "upside") {
    if (upHit) return { status: "confirmed", label: "Upside magnet hit" };
    if (upFaded || dnHit) return { status: "against", label: "Upside lean fading" };
    return { status: "open", label: "Upside lean open" };
  }
  if (lean === "down" || kind === "downside") {
    if (dnHit) return { status: "confirmed", label: "Downside magnet hit" };
    if (dnFaded || upHit) return { status: "against", label: "Downside lean fading" };
    return { status: "open", label: "Downside lean open" };
  }
  return { status: "open", label: "Monitoring" };
}

/** Apply live prices + anchor (snapshot close) to a feed item. */
export function enrichCTOFeedItem(item, livePrice, anchorPrice) {
  if (!item) return item;
  const live = Number(livePrice);
  const anchor = Number(anchorPrice) || Number(item.anchor_price);
  const enriched = {
    ...item,
    live_price: Number.isFinite(live) ? live : null,
    anchor_price: Number.isFinite(anchor) ? anchor : null,
    top_upside: enrichCTOLevel(item.top_upside, "up", live, anchor),
    top_downside: enrichCTOLevel(item.top_downside, "down", live, anchor),
  };
  enriched.read_status = computeCTOReadStatus(enriched);
  return enriched;
}

/** Record top magnets into signal_outcomes for forward grading (idempotent). */
export async function recordCTOSignals(env, payload) {
  if (!payload?.ok || payload.from_cache) return { ok: true, skipped: "cache" };
  try {
    const { recordSignal } = await import("../signal-outcomes.js");
    const sym = String(payload.ticker || "").toUpperCase();
    const anchor = Number(payload.current_price);
    const publishedAt = Number(payload.computed_at) || Date.now();
    const asOf = String(payload.as_of_date || publishedAt);
    const up = payload.top_upside?.[0];
    const dn = payload.top_downside?.[0];
    const results = [];

    if (up?.price && Number.isFinite(anchor)) {
      results.push(await recordSignal(env, {
        signal_id: `cto:${sym}:${asOf}:up:${String(up.label || "up").replace(/\s+/g, "_")}`,
        source: "cto_level",
        desk: "research",
        ticker: sym,
        direction: "LONG",
        vehicle: "level",
        published_at: publishedAt,
        thesis: `CTO upside magnet ${up.label} @ ${Number(up.price).toFixed(2)} (${((up.regime_adjusted_prob || 0) * 100).toFixed(0)}% adj)`,
        ref_id: asOf,
        entry_price: anchor,
        target_price: Number(up.price),
        horizon_days: HORIZON_DAYS,
        payload: { side: "upside", label: up.label, adj_prob: up.regime_adjusted_prob },
      }));
    }
    if (dn?.price && Number.isFinite(anchor)) {
      results.push(await recordSignal(env, {
        signal_id: `cto:${sym}:${asOf}:dn:${String(dn.label || "dn").replace(/\s+/g, "_")}`,
        source: "cto_level",
        desk: "research",
        ticker: sym,
        direction: "SHORT",
        vehicle: "level",
        published_at: publishedAt,
        thesis: `CTO downside magnet ${dn.label} @ ${Number(dn.price).toFixed(2)} (${((dn.regime_adjusted_prob || 0) * 100).toFixed(0)}% adj)`,
        ref_id: asOf,
        entry_price: anchor,
        target_price: Number(dn.price),
        horizon_days: HORIZON_DAYS,
        payload: { side: "downside", label: dn.label, adj_prob: dn.regime_adjusted_prob },
      }));
    }
    return { ok: true, recorded: results.filter((r) => r?.ok).length };
  } catch (_) {
    return { ok: false, error_kind: "record_failed" };
  }
}

/** Summarize graded CTO level calls from signal_outcomes. */
export async function loadCTOLearningSummary(env) {
  const db = env?.DB;
  if (!db) return null;
  try {
    const row = await db.prepare(`
      SELECT
        COUNT(*) AS n,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN status = 'resolved' AND outcome = 'win' THEN 1 ELSE 0 END) AS wins
      FROM signal_outcomes
      WHERE source = 'cto_level'
    `).first();
    const n = Number(row?.n) || 0;
    const resolved = Number(row?.resolved) || 0;
    const wins = Number(row?.wins) || 0;
    return {
      forward_signals: n,
      forward_resolved: resolved,
      forward_win_rate_pct: resolved > 0 ? Number(((wins / resolved) * 100).toFixed(1)) : null,
      empirical_note: "Hit % on each row comes from ~2 years of this ticker's daily bars (how often a similar-distance level was reached within ~20 sessions).",
      forward_note: resolved > 0
        ? `${resolved} published CTO magnets graded so far (${wins} reached target before horizon).`
        : "Top magnets are now logged for forward grading; hit rates still come from historical candle math until enough resolve.",
    };
  } catch (_) {
    return null;
  }
}

/** Full enrich pass with KV anchor lookup. */
export async function enrichCTOFeedItemsWithAnchors(env, items) {
  const liveMap = await loadLivePriceMap(env);
  const out = [];
  let kvReads = 0;
  for (const item of items) {
    const sym = String(item.ticker || "").toUpperCase();
    let anchor = Number(item.anchor_price);
    if (!Number.isFinite(anchor) && kvReads < 35) {
      try {
        const raw = await env?.KV?.get(`timed:cto:ticker:${sym}`);
        if (raw) {
          const cached = JSON.parse(raw);
          anchor = Number(cached?.current_price);
        }
      } catch (_) {}
      kvReads += 1;
    }
    out.push(enrichCTOFeedItem(item, liveMap[sym] ?? null, anchor));
  }
  return out;
}

/** Enrich a full per-ticker CTO payload (arrays) with live distance + read status. */
export async function enrichCTOTickerPayload(env, payload) {
  if (!payload?.ticker) return payload;
  const liveMap = await loadLivePriceMap(env);
  const sym = String(payload.ticker || "").toUpperCase();
  const live = liveMap[sym] ?? null;
  const anchor = Number(payload.current_price);
  const up0 = payload.top_upside?.[0] || null;
  const dn0 = payload.top_downside?.[0] || null;
  const enrichedUp = enrichCTOLevel(up0, "up", live, anchor);
  const enrichedDn = enrichCTOLevel(dn0, "down", live, anchor);
  const read_status = computeCTOReadStatus({
    read_kind: payload.read?.kind,
    lean: payload.read?.lean,
    top_upside: enrichedUp,
    top_downside: enrichedDn,
  });
  return {
    ...payload,
    live_price: Number.isFinite(live) ? live : null,
    anchor_price: Number.isFinite(anchor) ? anchor : null,
    read_status,
    top_upside: enrichedUp && up0 ? [{ ...up0, ...enrichedUp }] : payload.top_upside,
    top_downside: enrichedDn && dn0 ? [{ ...dn0, ...enrichedDn }] : payload.top_downside,
  };
}
