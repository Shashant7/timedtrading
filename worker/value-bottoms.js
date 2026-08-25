// worker/value-bottoms.js
// ─────────────────────────────────────────────────────────────────────────────
//  Value / Bottoming strip (2026-08-25) — "price below fair value + bottoming
//  tech + constructive investor bias."
//
//  Composes fields already on timed:investor:scores (fairValue, timing_primary,
//  accumZone, compounder.dip_buy, investor score, FSD pick) into a ranked list
//  for Today + a Signal Outcome Ledger writer so published names get graded.
//
//  Pure module — no I/O. Pinned by worker/value-bottoms.test.js.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86400000;
export const VALUE_BOTTOM_HORIZON_DAYS = 60;
export const VALUE_BOTTOM_MIN_SCORE = 42;

const MOMENTUM_ZONE_TYPES = new Set(["momentum_runner", "momentum_runner_exhausted"]);
const OVERSOLD_ZONE_HINTS = [
  "weekly_oversold",
  "phase_accumulation",
  "weekly_breakout_retest",
  "td_buy",
  "rsi_div",
  "pdz_discount",
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nyYmd(ms = Date.now()) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function fairValueBlock(row) {
  return row?.fairValue || row?.fair_value || null;
}

function qualityMult(grade) {
  const g = String(grade || "").toUpperCase();
  if (g === "A") return 1;
  if (g === "B") return 0.85;
  if (g === "C") return 0.6;
  return 0;
}

function isOversoldAccum(accumZone) {
  if (!accumZone || typeof accumZone !== "object") return false;
  const zt = String(accumZone.zoneType || accumZone.zone_type || "").toLowerCase();
  if (MOMENTUM_ZONE_TYPES.has(zt)) return false;
  if (OVERSOLD_ZONE_HINTS.some((h) => zt.includes(h))) return true;
  const signals = Array.isArray(accumZone.signals) ? accumZone.signals : [];
  return signals.some((s) => OVERSOLD_ZONE_HINTS.some((h) => String(s).toLowerCase().includes(h)));
}

function hasTechnicalBottom(row) {
  const primary = String(row?.timing_primary || row?.timingPrimary || "").toUpperCase();
  if (primary === "BOTTOM") return true;
  const playbook = String(row?.timing_playbook || "").toUpperCase();
  if (playbook === "TIME_BOTTOM") return true;
  if (row?.compounder?.dip_buy === true) return true;
  if (isOversoldAccum(row?.accumZone || row?.accum_zone)) return true;
  return false;
}

/**
 * Soft gate: trading below fair value with usable quality, not a bare
 * momentum-runner near ATH, and some technical bottom / dip evidence.
 */
export function passesValueBottomGates(row) {
  if (!row || typeof row !== "object") return false;
  const fv = fairValueBlock(row);
  if (!fv || fv.stale === true) return false;
  if (String(fv.fv_class || "").toLowerCase() !== "discount") return false;
  const prem = num(fv.fv_premium_pct);
  if (!(prem != null && prem <= -10)) return false;
  if (qualityMult(fv.quality_grade) <= 0) return false;

  const zt = String((row.accumZone || row.accum_zone)?.zoneType || "").toLowerCase();
  if (zt === "momentum_runner_exhausted") return false;
  // Bare momentum_runner near ATH is not a value bottom unless timing or dip agrees.
  if (zt === "momentum_runner") {
    const primary = String(row.timing_primary || "").toUpperCase();
    const dip = row?.compounder?.dip_buy === true;
    if (primary !== "BOTTOM" && String(row.timing_playbook || "").toUpperCase() !== "TIME_BOTTOM" && !dip) {
      return false;
    }
  }

  return hasTechnicalBottom(row);
}

/**
 * Composite 0–100: value depth (~35) + bottom strength (~40) + bias (~25).
 */
export function scoreValueBottom(row) {
  if (!passesValueBottomGates(row)) return null;
  const fv = fairValueBlock(row);
  const prem = Math.abs(num(fv.fv_premium_pct) || 0);
  const qMult = qualityMult(fv.quality_grade);
  const valuePts = Math.min(35, (Math.min(prem, 35) / 35) * 35 * qMult)
    + (fv.growth_detected === true ? 3 : 0);

  let bottomPts = 0;
  const primary = String(row.timing_primary || "").toUpperCase();
  if (primary === "BOTTOM" || String(row.timing_playbook || "").toUpperCase() === "TIME_BOTTOM") {
    bottomPts += 22;
  }
  if (row?.compounder?.dip_buy === true) bottomPts += 10;
  const az = row.accumZone || row.accum_zone || {};
  if (isOversoldAccum(az)) {
    bottomPts += Math.min(18, (Number(az.confidence) || 40) * 0.18);
  }
  bottomPts = Math.min(40, bottomPts);

  let biasPts = 0;
  const invScore = num(row.score);
  if (invScore != null) biasPts += Math.min(15, Math.max(0, (invScore - 50) * 0.5));
  const stage = String(row.stage || "").toLowerCase();
  if (stage === "accumulate") biasPts += 5;
  else if (stage === "watch" || stage === "core_hold") biasPts += 2;
  if (row?.fsd?.isPick === true || (row?.fsd?.tier && row.fsd.tier !== "none")) biasPts += 5;
  biasPts = Math.min(25, biasPts);

  const total = Math.round(Math.min(100, valuePts + bottomPts + biasPts));
  return {
    score: total,
    parts: {
      value: Math.round(valuePts * 10) / 10,
      bottom: Math.round(bottomPts * 10) / 10,
      bias: Math.round(biasPts * 10) / 10,
    },
  };
}

function resolvePrice(row, priceMap) {
  const sym = String(row?.ticker || "").toUpperCase();
  const fromMap = priceMap?.[sym];
  const p = num(fromMap?.p) || num(fromMap?.price) || num(row?.price) || num(row?.position?.mark);
  return p != null && p > 0 ? p : null;
}

function resolveStop(row) {
  return num(row.thesisInvalidationPrice)
    || num(row.thesis_invalidation_price)
    || num(row.primaryInvalidation?.price)
    || num(row.primary_invalidation?.price)
    || null;
}

function resolveTarget(row) {
  const fv = fairValueBlock(row);
  return num(fv?.fair_value) || null;
}

/**
 * Rank investor score rows into a publishable Value Bottoms list.
 */
export function rankValueBottoms(scoreRows, opts = {}) {
  const limit = Math.max(1, Math.min(40, Number(opts.limit) || 16));
  const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : VALUE_BOTTOM_MIN_SCORE;
  const priceMap = opts.priceMap || {};
  const nowMs = Number(opts.nowMs) > 0 ? Number(opts.nowMs) : Date.now();
  const out = [];

  for (const raw of Array.isArray(scoreRows) ? scoreRows : []) {
    const ticker = String(raw?.ticker || "").toUpperCase();
    if (!ticker) continue;
    const scored = scoreValueBottom(raw);
    if (!scored || scored.score < minScore) continue;
    const fv = fairValueBlock(raw);
    const price = resolvePrice(raw, priceMap);
    const target = resolveTarget(raw);
    const stop = resolveStop(raw);
    out.push({
      ticker,
      companyName: raw.companyName || raw.company_name || null,
      sector: raw.sector || null,
      bottoming_value_score: scored.score,
      score_parts: scored.parts,
      price,
      fair_value: fv?.fair_value ?? null,
      fv_premium_pct: fv?.fv_premium_pct ?? null,
      fv_class: fv?.fv_class ?? null,
      quality_grade: fv?.quality_grade ?? null,
      growth_detected: fv?.growth_detected === true,
      investor_score: num(raw.score),
      stage: raw.stage || null,
      stage_reason: raw.stageReason || raw.stage_reason || null,
      timing_primary: raw.timing_primary || null,
      timing_playbook: raw.timing_playbook || null,
      accum_zone_type: (raw.accumZone || raw.accum_zone)?.zoneType || null,
      dip_buy: raw?.compounder?.dip_buy === true,
      fsd: raw.fsd || null,
      thesis: raw.thesis ? String(raw.thesis).slice(0, 280) : null,
      primary_invalidation: stop,
      target_price: target,
      stop_price: stop,
      action_tier: raw.actionTier?.tier || raw.action_tier?.tier || null,
      ranked_at: nowMs,
    });
  }

  out.sort((a, b) => {
    if (b.bottoming_value_score !== a.bottoming_value_score) {
      return b.bottoming_value_score - a.bottoming_value_score;
    }
    return (a.fv_premium_pct ?? 0) - (b.fv_premium_pct ?? 0);
  });

  return out.slice(0, limit);
}

export function buildValueBottomsPayload(rows, opts = {}) {
  const holdings = Array.isArray(rows) ? rows : [];
  return {
    ok: true,
    count: holdings.length,
    computedAt: Number(opts.computedAt) || Date.now(),
    ymd: opts.ymd || nyYmd(opts.computedAt || Date.now()),
    holdings,
  };
}

/**
 * Map a ranked value-bottom row into a Signal Outcome Ledger record.
 * Idempotent id: valuebottom:{YYYY-MM-DD-ET}:{TICKER}
 */
export function valueBottomToSignal(row, meta = {}) {
  if (!row || typeof row !== "object") return null;
  const ticker = String(row.ticker || "").toUpperCase();
  if (!ticker) return null;
  const publishedAt = Number(meta.published_at) || Number(row.ranked_at) || Date.now();
  const ymd = meta.ymd || nyYmd(publishedAt);
  const entry = num(row.price) || num(meta.entry_price);
  const target = num(row.target_price) || num(row.fair_value);
  const stop = num(row.stop_price) || num(row.primary_invalidation);
  const discount = num(row.fv_premium_pct);
  const thesisBits = [
    discount != null ? `${discount.toFixed(0)}% below FV` : null,
    row.quality_grade ? `quality ${row.quality_grade}` : null,
    row.timing_primary === "BOTTOM" ? "TIME_BOTTOM" : null,
    row.dip_buy ? "dip_buy" : null,
    row.accum_zone_type || null,
  ].filter(Boolean);
  return {
    signal_id: `valuebottom:${ymd}:${ticker}`,
    source: "value_bottom",
    desk: "investor",
    ticker,
    direction: "LONG",
    vehicle: "equity",
    published_at: publishedAt,
    thesis: (row.thesis || thesisBits.join(" · ") || `Value bottom ${ticker}`).slice(0, 500),
    ref_id: ymd,
    entry_price: entry,
    target_price: target,
    stop_price: stop,
    horizon_days: VALUE_BOTTOM_HORIZON_DAYS,
    payload: {
      bottoming_value_score: row.bottoming_value_score ?? null,
      score_parts: row.score_parts || null,
      fv_premium_pct: row.fv_premium_pct ?? null,
      fv_class: row.fv_class ?? null,
      quality_grade: row.quality_grade ?? null,
      timing_primary: row.timing_primary ?? null,
      accum_zone_type: row.accum_zone_type ?? null,
      stage: row.stage ?? null,
      dip_buy: row.dip_buy === true,
    },
  };
}

export function overlayValueBottomsPrices(payload, priceMap = {}) {
  if (!payload || typeof payload !== "object") return payload;
  const holdings = (payload.holdings || []).map((row) => {
    const sym = String(row?.ticker || "").toUpperCase();
    const px = resolvePrice({ ...row, ticker: sym }, priceMap);
    return px != null ? { ...row, price: px } : { ...row };
  });
  return { ...payload, holdings, count: holdings.length };
}
