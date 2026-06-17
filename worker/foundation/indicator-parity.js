// worker/foundation/indicator-parity.js
// -----------------------------------------------------------------------------
// Shadow-only indicator parity harness.
//
// This module validates golden indicator fixtures and compares them against the
// current worker indicator implementation. It is intentionally not imported by
// live scoring paths. Phase 1 goal: prove "data -> indicators" before changing
// trading logic, weights, or broker behavior.
// -----------------------------------------------------------------------------

import {
  computeTDSequential,
  computeTfBundle,
  superTrendSeries,
} from "../indicators.js";

export const INDICATOR_PARITY_FIXTURE_VERSION = 1;

export const DEFAULT_SUPERTREND_PARAMS = Object.freeze({
  factor: 3.0,
  atrLen: 10,
});

export const SESSION_CLIP_BY_TF = Object.freeze({
  "1": "extended",
  "5": "extended",
  "10": "extended",
  "15": "extended",
  "30": "extended",
  "60": "rth",
  "240": "rth",
  D: "exchange",
  W: "exchange",
  M: "exchange",
});

export const DEFAULT_NUMERIC_TOLERANCE = Object.freeze({
  close: 0.0001,
  ema21: 0.02,
  ema200: 0.05,
  rsi14: 0.05,
  atr14: 0.05,
  phase_value: 0.1,
  saty_phase_value: 0.1,
  vwap: 0.05,
  vwap_dist_pct: 0.02,
  rvol: 0.02,
  pdz_position: 0.005,
  liq_nearest_ss_dist_atr: 0.05,
});

export const DEFAULT_EXACT_FIELDS = Object.freeze([
  "supertrend_dir",
  "td9_bull",
  "td9_bear",
  "td13_bull",
  "td13_bear",
  "td_bull_prep_count",
  "td_bear_prep_count",
  "td_tv_count",
  "td_tv_side",
  "phase_zone",
  "phase_leaving_accum",
  "phase_leaving_distribution",
  "sq_on",
  "sq_release",
  "fvg_in_bull",
  "fvg_in_bear",
  "pdz_zone",
  "orb_15m_direction",
]);

const VALID_SESSION_CLIPS = new Set(["extended", "rth", "exchange", "custom"]);

function normalizeTf(tf) {
  const s = String(tf || "").trim();
  if (s === "1H") return "60";
  if (s === "4H") return "240";
  if (s === "1D") return "D";
  if (s === "1W") return "W";
  if (s === "1M") return "M";
  return s;
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, places = 4) {
  const n = finiteOrNull(v);
  if (n == null) return null;
  const p = 10 ** places;
  return Math.round(n * p) / p;
}

function barTs(bar) {
  return Number(bar?.ts ?? bar?.t ?? bar?.time);
}

function normalizeBars(candles) {
  return (Array.isArray(candles) ? candles : [])
    .map((b) => ({
      ts: barTs(b),
      o: Number(b?.o ?? b?.open),
      h: Number(b?.h ?? b?.high),
      l: Number(b?.l ?? b?.low),
      c: Number(b?.c ?? b?.close),
      v: Number(b?.v ?? b?.volume ?? 0),
      finalized: b?.finalized !== false,
    }))
    .filter((b) => Number.isFinite(b.ts) && Number.isFinite(b.o) && Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c))
    .sort((a, b) => a.ts - b.ts);
}

export function expectedSessionClip(tf) {
  return SESSION_CLIP_BY_TF[normalizeTf(tf)] || "custom";
}

export function validateParityFixture(fixture) {
  const errors = [];
  if (!fixture || typeof fixture !== "object") {
    return { ok: false, errors: ["fixture must be an object"] };
  }
  if (Number(fixture.fixture_version) !== INDICATOR_PARITY_FIXTURE_VERSION) {
    errors.push(`fixture_version must be ${INDICATOR_PARITY_FIXTURE_VERSION}`);
  }
  if (!fixture.ticker) errors.push("ticker required");
  const tf = normalizeTf(fixture.tf);
  if (!tf) errors.push("tf required");
  const sessionClip = String(fixture.session_clip || "");
  if (!VALID_SESSION_CLIPS.has(sessionClip)) errors.push("session_clip must be extended|rth|exchange|custom");
  const expectedClip = expectedSessionClip(tf);
  if (sessionClip && expectedClip !== "custom" && sessionClip !== expectedClip) {
    errors.push(`session_clip ${sessionClip} does not match expected ${expectedClip} for tf ${tf}`);
  }
  if (!fixture.source) errors.push("source required");
  const stParams = fixture.indicator_params?.supertrend;
  if (stParams) {
    const factor = Number(stParams.factor);
    const atrLen = Number(stParams.atr_len ?? stParams.atrLen);
    if (!Number.isFinite(factor) || factor <= 0) errors.push("indicator_params.supertrend.factor must be > 0");
    if (!Number.isInteger(atrLen) || atrLen < 1) errors.push("indicator_params.supertrend.atr_len must be an integer >= 1");
  }
  if (!fixture.range || !fixture.range.start || !fixture.range.end) errors.push("range.start/range.end required");
  const candles = normalizeBars(fixture.candles);
  if (candles.length === 0) errors.push("candles[] required");
  if (!Array.isArray(fixture.rows) || fixture.rows.length === 0) errors.push("rows[] required");
  if (Array.isArray(fixture.rows)) {
    fixture.rows.forEach((row, idx) => {
      if (!Number.isFinite(Number(row?.ts))) errors.push(`rows[${idx}].ts required`);
      if (!row?.expected || typeof row.expected !== "object") errors.push(`rows[${idx}].expected object required`);
    });
  }
  return { ok: errors.length === 0, errors };
}

export function computeWorkerParityRow({ ticker, tf, candles, asOfTs = null, htfBull = true, indicatorParams = null }) {
  const normalizedTf = normalizeTf(tf);
  const bars = normalizeBars(candles);
  if (bars.length === 0) {
    return { ok: false, error: "no_valid_candles", ticker, tf: normalizedTf, actual: null };
  }
  const asOf = Number(asOfTs) || bars[bars.length - 1].ts;
  const window = bars.filter((b) => b.ts <= asOf);
  if (window.length === 0) {
    return { ok: false, error: "no_candles_at_asof", ticker, tf: normalizedTf, actual: null };
  }

  const bundle = computeTfBundle(window);
  const td = computeTDSequential(window, normalizedTf, { htfBull });
  if (!bundle) {
    return { ok: false, error: "bundle_unavailable", ticker, tf: normalizedTf, actual: null };
  }

  const saty = bundle.satyPhase || {};
  const pdz = bundle.pdz || {};
  const fvg = bundle.fvg || {};
  const liq = bundle.liq || {};
  const rsiDiv = bundle.rsiDiv || {};
  const stParams = indicatorParams?.supertrend || {};
  const stFactor = Number.isFinite(Number(stParams.factor)) ? Number(stParams.factor) : DEFAULT_SUPERTREND_PARAMS.factor;
  const stAtrLen = Number.isInteger(Number(stParams.atr_len ?? stParams.atrLen))
    ? Number(stParams.atr_len ?? stParams.atrLen)
    : DEFAULT_SUPERTREND_PARAMS.atrLen;
  const customSt = (stFactor === DEFAULT_SUPERTREND_PARAMS.factor && stAtrLen === DEFAULT_SUPERTREND_PARAMS.atrLen)
    ? null
    : superTrendSeries(window, stFactor, stAtrLen);
  const stDir = customSt ? customSt.dir[customSt.dir.length - 1] : bundle.stDir;
  const stLine = customSt ? customSt.line[customSt.line.length - 1] : bundle.stLine;

  return {
    ok: true,
    ticker: String(ticker || "").toUpperCase(),
    tf: normalizedTf,
    asOfTs: asOf,
    actual: {
      close: round(bundle.px, 4),
      ema21: round(bundle.e21, 4),
      ema200: round(bundle.e200, 4),
      rsi14: round(bundle.rsi, 4),
      atr14: round(bundle.atr14, 4),
      supertrend_dir: Number.isFinite(Number(stDir)) ? Number(stDir) : null,
      supertrend_line: round(stLine, 4),
      supertrend_factor: stFactor,
      supertrend_atr_len: stAtrLen,
      worker_supertrend_dir: Number.isFinite(Number(bundle.stDir)) ? Number(bundle.stDir) : null,
      worker_supertrend_line: round(bundle.stLine, 4),
      td9_bull: !!td.td9_bullish,
      td9_bear: !!td.td9_bearish,
      td13_bull: !!td.td13_bullish,
      td13_bear: !!td.td13_bearish,
      td_bull_prep_count: Number(td.bullish_prep_count) || 0,
      td_bear_prep_count: Number(td.bearish_prep_count) || 0,
      td_tv_count: Number(td.tv_count) || 0,
      td_tv_side: td.tv_count_side || null,
      phase_value: round(bundle.phaseOsc, 4),
      phase_zone: bundle.phaseZone || null,
      saty_phase_value: round(saty.value, 4),
      saty_phase_zone: saty.zone || null,
      phase_leaving_accum: !!saty.leaving?.accum,
      phase_leaving_distribution: !!saty.leaving?.distrib,
      sq_on: !!bundle.sqOn,
      sq_release: !!bundle.sqRelease,
      vwap: round(bundle.vwap, 4),
      vwap_dist_pct: round(bundle.vwapDistPct, 4),
      rvol: round(bundle.volRatio, 4),
      pdz_zone: pdz.zone || null,
      pdz_position: round(pdz.pct, 4),
      fvg_in_bull: !!fvg.inBullGap,
      fvg_in_bear: !!fvg.inBearGap,
      liq_nearest_ss_dist_atr: round(liq.nearestSellsideDist, 4),
      rsi_bear_divergence: !!rsiDiv.bear?.active,
      rsi_bull_divergence: !!rsiDiv.bull?.active,
    },
  };
}

export function compareParityRows(actual, expected, opts = {}) {
  const numericTolerance = { ...DEFAULT_NUMERIC_TOLERANCE, ...(opts.numericTolerance || {}) };
  const exactFields = opts.exactFields || DEFAULT_EXACT_FIELDS;
  const mismatches = [];

  for (const [field, tolerance] of Object.entries(numericTolerance)) {
    if (expected[field] == null) continue;
    const a = finiteOrNull(actual?.[field]);
    const e = finiteOrNull(expected[field]);
    if (e == null) continue;
    if (a == null || Math.abs(a - e) > tolerance) {
      mismatches.push({ field, kind: "numeric", expected: e, actual: a, tolerance });
    }
  }

  for (const field of exactFields) {
    if (expected[field] == null) continue;
    const a = actual?.[field];
    const e = expected[field];
    if (a !== e) mismatches.push({ field, kind: "exact", expected: e, actual: a });
  }

  return { ok: mismatches.length === 0, mismatches };
}

export function runParityFixture(fixture, opts = {}) {
  const validation = validateParityFixture(fixture);
  if (!validation.ok) return { ok: false, validation, rows: [] };
  const rows = fixture.rows.map((row) => {
    const computed = computeWorkerParityRow({
      ticker: fixture.ticker,
      tf: fixture.tf,
      candles: fixture.candles,
      asOfTs: row.ts,
      htfBull: row.htf_bull !== false,
      indicatorParams: fixture.indicator_params || null,
    });
    if (!computed.ok) return { ts: row.ts, ok: false, error: computed.error, mismatches: [] };
    const comparison = compareParityRows(computed.actual, row.expected, opts);
    return { ts: row.ts, ok: comparison.ok, actual: computed.actual, expected: row.expected, mismatches: comparison.mismatches };
  });
  return {
    ok: rows.every((r) => r.ok),
    validation,
    rows,
  };
}
