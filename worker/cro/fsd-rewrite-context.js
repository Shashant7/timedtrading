// worker/cro/fsd-rewrite-context.js
// Fresh TT model context for FSD publication rewrites.
//
// 2026-07-23 — Research notes cited stale TSLA stop/tp ($373/$338) because
// loadTickerModelContext preferred timed:all:snapshot without freshness
// checks, and rewrites are idempotent. This module:
//   1. Resolves KV via KV_TIMED || KV
//   2. Picks the freshest of snapshot / ticker_latest / timed:latest
//   3. Overlays live timed:prices onto the chosen payload
//   4. Omits trigger/stop/tp when they diverge from live price

/** Max age gap: prefer D1/KV latest over snapshot when newer by this much. */
export const SNAPSHOT_STALE_VS_LATEST_MS = 15 * 60 * 1000;

/** Omit a plan level when |level − live px| / px exceeds this. */
export const LEVEL_DIVERGE_PCT = 0.12;

/** Force-refresh a rewrite when live px drifts this far from rewrite-time px. */
export const REWRITE_PX_DRIFT_PCT = 0.08;

export function resolveTimedKv(env) {
  return env?.KV_TIMED || env?.KV || null;
}

/** Best-effort timestamp (ms) from a ticker payload or row wrapper. */
export function payloadTimestampMs(payload, extraTs = null) {
  if (Number.isFinite(Number(extraTs)) && Number(extraTs) > 0) {
    const e = Number(extraTs);
    // D1 updated_at is usually ms; tolerate seconds.
    return e < 1e12 ? e * 1000 : e;
  }
  if (!payload || typeof payload !== "object") return 0;
  const keys = [
    "ingest_ts", "ts", "updated_at", "scored_at", "asof_ts", "asOfTs",
    "price_ts", "last_update", "timestamp",
  ];
  let best = 0;
  for (const k of keys) {
    const n = Number(payload[k]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const ms = n < 1e12 ? n * 1000 : n;
    if (ms > best) best = ms;
  }
  return best;
}

/**
 * @param {Array<{ source: string, payload: object|null, ts?: number|null }>} candidates
 * @returns {{ source: string, payload: object, ts: number }|null}
 */
export function pickFreshestPayload(candidates) {
  let best = null;
  for (const c of candidates || []) {
    if (!c?.payload || typeof c.payload !== "object") continue;
    const ts = payloadTimestampMs(c.payload, c.ts);
    // Prefer any payload over none; when timestamps tie / missing, later
    // candidates in the list win only if they have a strictly greater ts
    // OR the current best has ts=0 and this one has ts>0.
    if (!best) {
      best = { source: c.source, payload: c.payload, ts };
      continue;
    }
    if (ts > best.ts) {
      best = { source: c.source, payload: c.payload, ts };
    }
  }
  return best;
}

/** Overlay live timed:prices row onto a scoring payload (mutates a shallow copy). */
export function overlayLivePrice(payload, priceRow) {
  if (!payload || typeof payload !== "object") return payload;
  const out = { ...payload };
  if (!priceRow || typeof priceRow !== "object") return out;
  const px = Number(priceRow.p ?? priceRow.price);
  if (!Number.isFinite(px) || px <= 0) return out;
  out.price = px;
  out._live_price = px;
  const dp = Number(priceRow.dp ?? priceRow.day_change_pct);
  const dc = Number(priceRow.dc ?? priceRow.day_change);
  if (Number.isFinite(dp)) {
    out.day_change_pct = dp;
    out.dailyChgPct = dp;
  }
  if (Number.isFinite(dc)) out.day_change = dc;
  const pts = Number(priceRow.t ?? priceRow.ts ?? priceRow.timestamp);
  if (Number.isFinite(pts) && pts > 0) {
    out.price_ts = pts < 1e12 ? pts * 1000 : pts;
  }
  out._live_price_overlaid = true;
  return out;
}

/**
 * Drop trigger/stop/tp that are too far from live price (stale plan book).
 * Returns { payload, omitted: string[], citeLevels: boolean }.
 */
export function sanitizePlanLevels(payload, {
  divergePct = LEVEL_DIVERGE_PCT,
  livePx = null,
} = {}) {
  if (!payload || typeof payload !== "object") {
    return { payload, omitted: [], citeLevels: false };
  }
  const out = { ...payload };
  const px = Number.isFinite(Number(livePx)) && Number(livePx) > 0
    ? Number(livePx)
    : Number(out.price ?? out._live_price);
  const omitted = [];
  if (!Number.isFinite(px) || px <= 0) {
    for (const k of ["trigger_price", "sl", "tp"]) {
      if (Number.isFinite(Number(out[k]))) {
        omitted.push(k);
        delete out[k];
      }
    }
    return { payload: out, omitted, citeLevels: false };
  }

  const tooFar = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return false;
    return Math.abs(n - px) / px > divergePct;
  };

  const hadTrigger = Number.isFinite(Number(out.trigger_price)) && Number(out.trigger_price) > 0;
  const hadSl = Number.isFinite(Number(out.sl)) && Number(out.sl) > 0;
  const hadTp = Number.isFinite(Number(out.tp)) && Number(out.tp) > 0;

  if (tooFar(out.trigger_price)) {
    omitted.push("trigger");
    delete out.trigger_price;
  }
  if (tooFar(out.sl)) {
    omitted.push("stop");
    delete out.sl;
  }
  if (tooFar(out.tp)) {
    omitted.push("tp");
    delete out.tp;
  }

  // If any plan level failed the distance check, drop the whole book.
  // Partial books (e.g. orphaned TP near px after a gap) still mislead.
  if (omitted.length > 0 && (hadTrigger || hadSl || hadTp)) {
    for (const k of ["trigger_price", "sl", "tp"]) {
      if (Number.isFinite(Number(out[k]))) {
        if (k === "trigger_price") omitted.push("trigger");
        if (k === "sl") omitted.push("stop");
        if (k === "tp") omitted.push("tp");
        delete out[k];
      }
    }
  }

  // Geometry: remaining stop+tp must form a valid long or short book.
  const sl = Number(out.sl);
  const tp = Number(out.tp);
  if (Number.isFinite(sl) && Number.isFinite(tp)) {
    const validShort = sl > px && tp < px;
    const validLong = sl < px && tp > px;
    if (!validShort && !validLong) {
      omitted.push("stop", "tp");
      delete out.sl;
      delete out.tp;
    }
  }

  const citeLevels = Number.isFinite(Number(out.trigger_price))
    || Number.isFinite(Number(out.sl))
    || Number.isFinite(Number(out.tp));
  return { payload: out, omitted: [...new Set(omitted)], citeLevels };
}

export function summarizeTickerForPrompt(sym, t, {
  source = null,
  omittedLevels = [],
  citeLevels = true,
} = {}) {
  if (!t) return null;
  const parts = [`${sym}:`];
  const _num = (v, fix = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(fix) : null);
  if (_num(t.price ?? t._live_price)) parts.push(`px=$${_num(t.price ?? t._live_price)}`);
  if (_num(t.day_change_pct ?? t.dailyChgPct)) parts.push(`day=${_num(t.day_change_pct ?? t.dailyChgPct)}%`);
  if (t.regime_class) parts.push(`regime=${String(t.regime_class).replace(/_/g, " ")}`);
  if (t.kanban_stage) parts.push(`stage=${String(t.kanban_stage)}`);
  if (t.state) parts.push(`htf=${String(t.state).replace(/_/g, " ")}`);
  if (_num(t.score, 0)) parts.push(`score=${_num(t.score, 0)}`);
  if (_num(t.conviction, 0)) parts.push(`conv=${_num(t.conviction, 0)}`);
  if (_num(t.rank_position, 0)) parts.push(`R${_num(t.rank_position, 0)}`);
  if (_num(t.rr)) parts.push(`rr=${_num(t.rr)}`);
  if (citeLevels) {
    if (_num(t.trigger_price)) parts.push(`trigger=${_num(t.trigger_price)}`);
    if (_num(t.sl)) parts.push(`stop=${_num(t.sl)}`);
    if (_num(t.tp)) parts.push(`tp=${_num(t.tp)}`);
  }
  if (t._ticker_profile?.behavior_type) parts.push(`profile=${t._ticker_profile.behavior_type}`);
  if (t.latent_regime?.state) parts.push(`hmm=${String(t.latent_regime.state).replace(/_/g, " ")}`);
  if (Array.isArray(t.flags) && t.flags.length > 0) parts.push(`flags=${t.flags.slice(0, 3).join(",")}`);
  if (source) parts.push(`src=${source}`);
  if (omittedLevels.length > 0) {
    parts.push(`(model levels omitted — stale vs live price: ${omittedLevels.join(",")}; do NOT invent trigger/stop/TP)`);
  }
  return parts.length > 1 ? parts.join(" ") : null;
}

/**
 * Build prompt line + meta from already-loaded candidate payloads + live price row.
 * Pure — used by tests and by loadTickerModelContext.
 */
export function buildFreshTickerContext(sym, {
  snapshotPayload = null,
  snapshotTs = null,
  latestPayload = null,
  latestTs = null,
  timedLatestPayload = null,
  timedLatestTs = null,
  priceRow = null,
  divergePct = LEVEL_DIVERGE_PCT,
} = {}) {
  const S = String(sym || "").toUpperCase();
  if (!S) return { summary: null, meta: null };

  const picked = pickFreshestPayload([
    { source: "snapshot", payload: snapshotPayload, ts: snapshotTs },
    { source: "ticker_latest", payload: latestPayload, ts: latestTs },
    { source: "timed_latest", payload: timedLatestPayload, ts: timedLatestTs },
  ]);

  if (!picked) {
    // Price-only fallback
    if (priceRow && Number.isFinite(Number(priceRow.p ?? priceRow.price))) {
      const px = Number(priceRow.p ?? priceRow.price);
      const dp = Number(priceRow.dp ?? priceRow.day_change_pct);
      const parts = [`${S}:`, `px=$${px.toFixed(2)}`];
      if (Number.isFinite(dp)) parts.push(`day=${dp.toFixed(2)}%`);
      parts.push("(live price — full desk snapshot syncing)");
      return {
        summary: parts.join(" "),
        meta: { ticker: S, px, source: "timed_prices", ts: payloadTimestampMs(priceRow), citeLevels: false, omitted: [] },
      };
    }
    return { summary: null, meta: null };
  }

  let payload = overlayLivePrice(picked.payload, priceRow);
  const livePx = Number(payload.price ?? payload._live_price);
  const sanitized = sanitizePlanLevels(payload, { divergePct, livePx });
  payload = sanitized.payload;

  const summary = summarizeTickerForPrompt(S, payload, {
    source: picked.source,
    omittedLevels: sanitized.omitted,
    citeLevels: sanitized.citeLevels,
  });

  return {
    summary,
    meta: {
      ticker: S,
      px: Number.isFinite(livePx) ? livePx : null,
      sl: Number.isFinite(Number(payload.sl)) ? Number(payload.sl) : null,
      tp: Number.isFinite(Number(payload.tp)) ? Number(payload.tp) : null,
      trigger: Number.isFinite(Number(payload.trigger_price)) ? Number(payload.trigger_price) : null,
      source: picked.source,
      ts: Math.max(picked.ts, payloadTimestampMs(payload)),
      citeLevels: sanitized.citeLevels,
      omitted: sanitized.omitted,
    },
  };
}

export function rewriteMetaNeedsRefresh(metaTicker, livePx, {
  driftPct = REWRITE_PX_DRIFT_PCT,
} = {}) {
  const base = Number(metaTicker?.px);
  const live = Number(livePx);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(live) || live <= 0) return false;
  return Math.abs(live - base) / base >= driftPct;
}
