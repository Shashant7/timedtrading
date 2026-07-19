// worker/foundation/sequence-snapshot.js
// -----------------------------------------------------------------------------
// Slim indicator snapshot for timed_trail.payload_json — feeds sequence
// detection / replay mining without storing the full scored payload (~200KB).
// Shadow-only: does not alter scoring math or trade behavior.
// -----------------------------------------------------------------------------

export const SEQUENCE_SNAPSHOT_VERSION = 2; // v2: business_character rides in the movie

export const SEQUENCE_SIGNAL_TFS = Object.freeze(["D", "W", "M", "240", "4H", "60", "1H", "30", "15"]);

const TF_ALIASES = {
  "1H": "60",
  "4H": "240",
  "1D": "D",
  "1W": "W",
  "1M": "M",
};

function pickTfTechRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    rsi: row.rsi ? { r5: row.rsi.r5, slope5: row.rsi.slope5 } : undefined,
    saty: row.saty ? {
      v: row.saty.v,
      l: row.saty.l ? { ...row.saty.l } : undefined,
    } : undefined,
    ema: row.ema ? {
      ema21: row.ema.ema21,
      ema200: row.ema.ema200,
      priceAboveEma21: row.ema.priceAboveEma21,
    } : undefined,
    stDir: row.stDir,
    stSlope: row.stSlope,
    pdz: row.pdz ? { zone: row.pdz.zone, pct: row.pdz.pct } : undefined,
    fvg: row.fvg ? { ib: row.fvg.ib, ibr: row.fvg.ibr } : undefined,
    sq: row.sq ? { s: row.sq.s, r: row.sq.r } : undefined,
    vwapAbove: row.vwapAbove,
    rsiDiv: row.rsiDiv ? {
      bull: row.rsiDiv.bull ? { a: row.rsiDiv.bull.a } : undefined,
      bear: row.rsiDiv.bear ? { a: row.rsiDiv.bear.a } : undefined,
    } : undefined,
    atr: row.atr != null ? row.atr : (row.atr14 != null ? row.atr14 : undefined),
  };
}

function slimTdSequential(td) {
  if (!td || typeof td !== "object") return null;
  const perTf = {};
  const src = td.per_tf && typeof td.per_tf === "object" ? td.per_tf : td;
  for (const [tf, row] of Object.entries(src)) {
    if (!row || typeof row !== "object") continue;
    perTf[tf] = {
      bullish_prep_count: row.bullish_prep_count,
      bearish_prep_count: row.bearish_prep_count,
      bullish_leadup_count: row.bullish_leadup_count,
      bearish_leadup_count: row.bearish_leadup_count,
      td9_bullish: row.td9_bullish,
      td9_bearish: row.td9_bearish,
      td13_bullish: row.td13_bullish,
      td13_bearish: row.td13_bearish,
    };
  }
  return {
    per_tf: perTf,
    td9_bullish: td.td9_bullish,
    td9_bearish: td.td9_bearish,
    td13_bullish: td.td13_bullish,
    td13_bearish: td.td13_bearish,
    bullish_prep_count: td.bullish_prep_count,
    bearish_prep_count: td.bearish_prep_count,
  };
}

function slimTfTech(tfTech) {
  if (!tfTech || typeof tfTech !== "object") return null;
  const out = {};
  for (const tf of SEQUENCE_SIGNAL_TFS) {
    const keys = [tf, TF_ALIASES[tf]].filter(Boolean);
    for (const key of keys) {
      if (tfTech[key]) {
        out[tf] = pickTfTechRow(tfTech[key]);
        break;
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

function slimFlags(flags) {
  if (!flags || typeof flags !== "object") return null;
  const keys = [
    "st_flip", "sq30_release", "momentum_elite", "ema_cross",
    "pdz_zone_D", "pdz_zone_4h", "pdz_zone_1h", "pdz_zone_h1", "pdz_zone_h4",
    "fvg_in_bull_D", "fvg_in_bear_D", "fvg_bull_D", "fvg_bear_D",
  ];
  const out = {};
  for (const k of keys) {
    if (flags[k] != null) out[k] = flags[k];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Build a compact JSON-serializable snapshot for timed_trail.payload_json.
 * Keeps every field the setup-event / sequence detectors read.
 */
export function buildSequenceTrailSnapshot(payload = {}) {
  if (!payload || typeof payload !== "object") return null;

  const snap = {
    _sequence_snapshot_v: SEQUENCE_SNAPSHOT_VERSION,
    _snapshot_kind: "sequence_trail",
    scoring_version: payload.scoring_version || payload._snapshot_v || null,
    ticker: String(payload.ticker || payload.symbol || "").toUpperCase() || null,
    ts: Number(payload.ts ?? payload.ingest_ts) || Date.now(),
    price: payload.price ?? payload.close ?? payload._live_price ?? null,
    close: payload.close ?? payload.price ?? null,
    phase_pct: payload.phase_pct ?? payload.saty_phase_pct ?? null,
    saty_phase_pct: payload.saty_phase_pct ?? payload.phase_pct ?? null,
    state: payload.state ?? null,
    kanban_stage: payload.kanban_stage ?? null,
    htf_score: payload.htf_score ?? null,
    ltf_score: payload.ltf_score ?? null,
    pdz_zone_D: payload.pdz_zone_D ?? null,
    pdz_zone_4h: payload.pdz_zone_4h ?? null,
    td_sequential: slimTdSequential(payload.td_sequential),
    tf_tech: slimTfTech(payload.tf_tech),
    flags: slimFlags(payload.flags),
    orb: payload.orb?.primary ? { primary: { ...payload.orb.primary } } : (payload.orb || null),
    // Business character rides in the movie so replay/mining can stratify
    // technical sequences by what the business IS (steady value vs growth).
    business_character: payload._business_character
      ? {
          archetype: payload._business_character.archetype || null,
          quality_grade: payload._business_character.quality_grade ?? null,
          growth_class: payload._business_character.growth_class ?? null,
          valuation_state: payload._business_character.valuation_state ?? null,
          compounder_tier: payload._business_character.compounder_tier ?? null,
          pullback_means: payload._business_character.technical_lens?.pullback_means ?? null,
          breakout_means: payload._business_character.technical_lens?.breakout_means ?? null,
          confirmation_need: payload._business_character.technical_lens?.confirmation_need ?? null,
          patience: payload._business_character.technical_lens?.patience ?? null,
          summary: payload._business_character.technical_lens?.summary ?? null,
        }
      : null,
  };

  for (const k of Object.keys(snap)) {
    if (snap[k] == null) delete snap[k];
  }
  return snap;
}

export function sequenceTrailSnapshotEnabled(env) {
  const v = env?.SETUP_TRAIL_SNAPSHOT ?? env?.SETUP_EVENTS_WRITE;
  return v === "1" || v === 1 || v === true || String(v || "").toLowerCase() === "true";
}

export function serializeSequenceTrailSnapshot(payload, env, maxBytes = 32768, opts = {}) {
  if (!opts.force && !sequenceTrailSnapshotEnabled(env)) return null;
  const snap = buildSequenceTrailSnapshot(payload);
  if (!snap) return null;
  let json = JSON.stringify(snap);
  if (json.length <= maxBytes) return json;
  // Drop lower-priority TFs if oversized
  const drop = ["15", "M", "W"];
  for (const tf of drop) {
    if (snap.tf_tech?.[tf]) {
      delete snap.tf_tech[tf];
      json = JSON.stringify(snap);
      if (json.length <= maxBytes) return json;
    }
  }
  return json.length <= maxBytes ? json : null;
}
