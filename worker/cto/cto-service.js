// worker/cto/cto-service.js
// ─────────────────────────────────────────────────────────────────────────────
//  AI CTO (Chief Technical Officer) — probabilistic level forecasts.
// ─────────────────────────────────────────────────────────────────────────────
//
//  Per-ticker computation:
//    1. Detect recent swing high + swing low (rolling 60 daily bars).
//    2. Project Fibonacci retracement / extension levels (23.6, 38.2, 50,
//       61.8, 78.6, 127.2, 161.8) and ATR ladder (±1, ±2, ±3 ATR).
//    3. Compute pivot-point levels (daily classic pivots).
//    4. For each level, lookup the EMPIRICAL HIT RATE from the ticker's
//       own daily candle history — "from a current-bar-equivalent close,
//       how often did this ticker reach this distance within N bars?".
//       This is the data-science backing the user asked for: golden gate
//       (38.2 → 61.8) close probability comes from THIS ticker's actual
//       past behavior, not an industry rule of thumb.
//    5. Weight each level by Markov regime forecast (current regime →
//       probability the trend continues in the level's direction over
//       the relevant horizon).
//    6. Emit a structured payload: { ticker, current_price, levels: [
//       { kind, label, price, distance_pct, raw_hit_rate, regime_adjusted_prob,
//         confidence_n } ] }.
//
//  Output flows into:
//    • CIO memory Layer 15d (per-ticker probabilistic targets) — preloaded
//      via memoryCache.ctoLevels by the scoring cron.
//    • CRO daily synthesis as the data-science substrate (Phase-6 prompt
//      will be extended to consume the CTO universe summary).
//    • Operator endpoint `GET /timed/cto/ticker?ticker=SYM` for spot-check.
//
//  Persistence:
//    • Per-ticker blob: KV `timed:cto:ticker:{SYM}` (1h TTL)
//    • Universe rollup:  KV `timed:cto:latest`              (1h TTL)
//    • D1 audit table:   cto_level_snapshots                (rolling 30d)

import {
  INDEX_FOCUS,
  KV_LAST_FULL_REFRESH,
  CACHE_TTL_PRIORITY_SEC,
  buildCTORefreshTickers,
  cacheTtlForTicker,
  mergeRollupResults,
  MAX_ELAPSED_MS_FULL,
  MAX_ELAPSED_MS_PRIORITY,
  MAX_ELAPSED_MS_SESSION,
  rollupRowFromCachedPayload,
  resolveScoredUniverseTickers,
} from "./cto-universe.js";
import { backfillItemBarAsOfMs, resolvePredictionAsOfMs } from "./cto-as-of.js";

const KV_LATEST_KEY = "timed:cto:latest";
const KV_TICKER_PREFIX = "timed:cto:ticker:";
const KV_TTL_SECONDS = CACHE_TTL_PRIORITY_SEC;
const CTO_TABLE = "cto_level_snapshots";

const HORIZON_BARS = 20;     // "within ~1 month" — matches the FSD-style
                             // "intermediate" horizon
const SWING_LOOKBACK = 60;   // daily bars for swing high/low detection
const ATR_PERIOD = 14;
const HIT_RATE_LOOKBACK_BARS = 504; // ~2 trading years for hit-rate stats
const MIN_HIT_RATE_SAMPLES = 12;     // below this we lower confidence

// ── Schema ────────────────────────────────────────────────────────────────────
export async function ensureCTOSchema(env) {
  const db = env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ${CTO_TABLE} (
        snapshot_id    TEXT PRIMARY KEY,
        ticker         TEXT NOT NULL,
        as_of_date     TEXT NOT NULL,
        produced_at    INTEGER NOT NULL,
        current_price  REAL,
        atr14          REAL,
        swing_high     REAL,
        swing_low      REAL,
        regime         TEXT,
        regime_p_up_5b REAL,
        regime_p_dn_5b REAL,
        levels_json    TEXT,
        narrative      TEXT
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_${CTO_TABLE}_ticker_date
      ON ${CTO_TABLE} (ticker, as_of_date DESC)
    `).run();
  } catch (e) {
    console.warn("[CTO] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

// ── Candle loaders ────────────────────────────────────────────────────────────
async function loadDailyCandles(env, ticker, bars = HIT_RATE_LOOKBACK_BARS) {
  const db = env?.DB;
  if (!db) return [];
  const sinceMs = Date.now() - (bars + 30) * 86400000;
  try {
    const rows = await db.prepare(
      `SELECT ts, o, h, l, c FROM ticker_candles
        WHERE ticker = ?1 AND tf = 'D' AND ts >= ?2
        ORDER BY ts ASC`,
    ).bind(String(ticker).toUpperCase(), sinceMs).all();
    return (rows?.results || []).map((r) => {
      const ts = Number(r.ts);
      return {
        ts: ts > 1e12 ? ts : ts * 1000,
        o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c),
      };
    }).filter((c) => Number.isFinite(c.c) && c.c > 0);
  } catch (_) { return []; }
}

// ── Math helpers ──────────────────────────────────────────────────────────────
function computeATR(candles, period = ATR_PERIOD) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function detectSwings(candles, lookback = SWING_LOOKBACK) {
  if (!candles || candles.length === 0) return { high: null, low: null, highIdx: -1, lowIdx: -1 };
  const slice = candles.slice(-lookback);
  let high = -Infinity, low = Infinity, highIdx = -1, lowIdx = -1;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i].h > high) { high = slice[i].h; highIdx = i; }
    if (slice[i].l < low) { low = slice[i].l; lowIdx = i; }
  }
  return { high, low, highIdx, lowIdx, lookback: slice.length };
}

// ── Level generators ──────────────────────────────────────────────────────────
function fibLevels(swingLow, swingHigh, currentPrice) {
  const range = swingHigh - swingLow;
  if (range <= 0) return [];
  // Direction of the current move: where is price relative to mid?
  const mid = (swingLow + swingHigh) / 2;
  const direction = currentPrice >= mid ? "up_off_low" : "down_off_high";
  const ratios = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.272, 1.618];
  const levels = [];
  for (const r of ratios) {
    // Retracements measured from the appropriate anchor.
    if (direction === "up_off_low") {
      // Price is in the upper half of the swing — Fibs are extensions
      // above the swing high projecting the next leg up.
      const ext = swingHigh + r * range;
      if (ext > currentPrice) {
        levels.push({ kind: "fib_extension_up", ratio: r, label: `Fib ext +${(r * 100).toFixed(1)}%`, price: ext });
      }
      // Also include retracements DOWN from swing high (potential targets if reversal).
      const ret = swingHigh - r * range;
      if (ret < currentPrice) {
        levels.push({ kind: "fib_retracement_down", ratio: r, label: `Fib ret ${(r * 100).toFixed(1)}%`, price: ret });
      }
    } else {
      // Price is in the lower half — Fibs extend DOWN below swing low,
      // and retracements project up from the swing low.
      const ext = swingLow - r * range;
      if (ext < currentPrice) {
        levels.push({ kind: "fib_extension_down", ratio: r, label: `Fib ext -${(r * 100).toFixed(1)}%`, price: ext });
      }
      const ret = swingLow + r * range;
      if (ret > currentPrice) {
        levels.push({ kind: "fib_retracement_up", ratio: r, label: `Fib ret ${(r * 100).toFixed(1)}%`, price: ret });
      }
    }
  }
  // Tag the canonical "golden gate" range (38.2 → 61.8) for callers.
  for (const lv of levels) {
    if (lv.ratio === 0.382 || lv.ratio === 0.5 || lv.ratio === 0.618) {
      lv.golden_gate = true;
    }
  }
  return levels;
}

function atrLevels(currentPrice, atr) {
  if (!atr || atr <= 0) return [];
  const out = [];
  for (const mult of [1, 1.5, 2, 3]) {
    out.push({ kind: "atr_up", label: `+${mult.toFixed(1)} ATR`, price: currentPrice + mult * atr, atr_mult: mult });
    out.push({ kind: "atr_down", label: `-${mult.toFixed(1)} ATR`, price: currentPrice - mult * atr, atr_mult: mult });
  }
  return out;
}

function pivotLevels(prevDay) {
  if (!prevDay) return [];
  const { h, l, c } = prevDay;
  const P = (h + l + c) / 3;
  const R1 = 2 * P - l;
  const S1 = 2 * P - h;
  const R2 = P + (h - l);
  const S2 = P - (h - l);
  const R3 = h + 2 * (P - l);
  const S3 = l - 2 * (h - P);
  return [
    { kind: "pivot", label: "P",  price: P  },
    { kind: "pivot", label: "R1", price: R1 },
    { kind: "pivot", label: "S1", price: S1 },
    { kind: "pivot", label: "R2", price: R2 },
    { kind: "pivot", label: "S2", price: S2 },
    { kind: "pivot", label: "R3", price: R3 },
    { kind: "pivot", label: "S3", price: S3 },
  ];
}

// ── Empirical hit-rate computation ────────────────────────────────────────────
// For each level, scan history: from each historical close, did the
// instrument's high (for upside levels) or low (for downside levels) reach
// the level within `horizon` bars? Return hits / opportunities.
function empiricalHitRate(candles, level, currentPrice, horizon = HORIZON_BARS) {
  if (!candles || candles.length < 60) return { hit_rate: null, samples: 0 };
  // The level represents a distance from current price; convert to a
  // percentage offset and apply against each historical close.
  const distancePct = (level.price - currentPrice) / currentPrice;
  if (!Number.isFinite(distancePct) || Math.abs(distancePct) < 1e-6) return { hit_rate: 1.0, samples: candles.length };
  const isUpside = distancePct > 0;
  let hits = 0, opportunities = 0;
  // Walk all but the last `horizon` bars.
  const N = candles.length;
  const limit = N - horizon;
  for (let i = 0; i < limit; i++) {
    const ref = candles[i].c;
    if (!Number.isFinite(ref) || ref <= 0) continue;
    const targetPx = ref * (1 + distancePct);
    let hit = false;
    for (let j = 1; j <= horizon; j++) {
      const b = candles[i + j];
      if (!b) break;
      if (isUpside && b.h >= targetPx) { hit = true; break; }
      if (!isUpside && b.l <= targetPx) { hit = true; break; }
    }
    opportunities++;
    if (hit) hits++;
  }
  const hitRate = opportunities > 0 ? hits / opportunities : null;
  return { hit_rate: hitRate, samples: opportunities };
}

// ── Markov regime bias ────────────────────────────────────────────────────────
// Load the ticker's per-ticker Markov matrix forecast if it exists
// (Phase 6 of regime-markov-compute writes these as
// `timed:regime:matrix:ticker:{SYM}`); otherwise fall back to the universe
// matrix at `timed:regime:matrix:global`.
async function loadMarkovBias(env, ticker) {
  if (!env?.KV) return null;
  try {
    const perTickerKey = `timed:regime:matrix:ticker:${String(ticker).toUpperCase()}`;
    let raw = await env.KV.get(perTickerKey);
    let source = "ticker";
    if (!raw) {
      raw = await env.KV.get("timed:regime:matrix:global");
      source = "global";
    }
    if (!raw) return null;
    const m = JSON.parse(raw);
    // Pull the 5-bar / 20-bar bull-vs-bear probabilities. The matrix
    // shape we ship today exposes these via `forecastBundle`-style keys
    // when present, or as top-level `p_5_bar` arrays.
    const fc = m?.forecast || m?.current_forecast || null;
    if (!fc) return { source, raw_matrix_keys: Object.keys(m).slice(0, 12) };
    return {
      source,
      state: fc.state || null,
      p_up_5_bar: Number(fc.p_up_5_bar ?? fc.p_5_bar_up ?? 0.5),
      p_dn_5_bar: Number(fc.p_dn_5_bar ?? fc.p_5_bar_dn ?? 0.5),
      p_up_20_bar: Number(fc.p_up_20_bar ?? fc.p_20_bar_up ?? 0.5),
      p_dn_20_bar: Number(fc.p_dn_20_bar ?? fc.p_20_bar_dn ?? 0.5),
      computed_at: m?.computed_at || null,
    };
  } catch (_) { return null; }
}

function regimeBiasMultiplier(bias, isUpside, horizonBars) {
  // No data → neutral.
  if (!bias) return 1.0;
  const p_up = horizonBars <= 6 ? Number(bias.p_up_5_bar || 0.5) : Number(bias.p_up_20_bar || 0.5);
  // 0.5 = neutral. Scale to ±50% multiplier when regime is extreme.
  const skew = (isUpside ? p_up : (1 - p_up)) - 0.5;     // -0.5..+0.5
  return Math.max(0.5, Math.min(1.5, 1 + skew));         // 0.5x..1.5x
}

// ── Per-ticker compute ────────────────────────────────────────────────────────
export async function computeCTOForTicker(env, ticker, {
  horizon = HORIZON_BARS,
  force = false,
  cacheTtlSeconds = KV_TTL_SECONDS,
  openPositions = null,
} = {}) {
  await ensureCTOSchema(env);
  const sym = String(ticker).toUpperCase();
  const ttlSec = Number(cacheTtlSeconds) > 0
    ? Number(cacheTtlSeconds)
    : cacheTtlForTicker(sym, { openPositions });

  if (!force) {
    try {
      const raw = await env?.KV?.get(KV_TICKER_PREFIX + sym);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached && (Date.now() - (cached.computed_at || 0)) < ttlSec * 1000) {
          return { ok: true, from_cache: true, ...cached };
        }
      }
    } catch (_) {}
  }

  const candles = await loadDailyCandles(env, sym);
  // 2026-06-03 — Lowered minimum from SWING_LOOKBACK + 10 (= 70 bars)
  // to 30 bars. The old gate failed silently for newly-listed names and
  // any ticker missing 2-3 months of D-tf history in `ticker_candles`,
  // which was what zeroed out the entire CTO rollup. With 30 bars we
  // still have enough for ATR + a coarse swing; empirical hit-rates
  // collapse to small-sample disclaimers (the `low_sample` flag below).
  const MIN_BARS = 30;
  if (!candles || candles.length < MIN_BARS) {
    return { ok: false, error_kind: "insufficient_candles", ticker: sym, bars: candles?.length || 0, required: MIN_BARS };
  }
  const lowSample = candles.length < SWING_LOOKBACK + 10;
  const current = candles[candles.length - 1];
  const prevDay = candles[candles.length - 2] || null;
  const atr = computeATR(candles);
  const swings = detectSwings(candles);
  if (swings.high === null || swings.low === null) {
    return { ok: false, error_kind: "swings_failed", ticker: sym };
  }

  const candidateLevels = [
    ...fibLevels(swings.low, swings.high, current.c),
    ...atrLevels(current.c, atr),
    ...pivotLevels(prevDay),
  ];

  // Bound the list — we don't need every level if there are 30+.
  // Keep the 16 closest to current price by absolute distance.
  candidateLevels.sort((a, b) => Math.abs(a.price - current.c) - Math.abs(b.price - current.c));
  const trimmed = candidateLevels.slice(0, 16);

  const markovBias = await loadMarkovBias(env, sym);

  const levels = trimmed.map((lv) => {
    const distancePct = (lv.price - current.c) / current.c;
    const isUpside = distancePct > 0;
    const emp = empiricalHitRate(candles, lv, current.c, horizon);
    const biasMult = regimeBiasMultiplier(markovBias, isUpside, horizon);
    const adjusted = emp.hit_rate != null ? Math.max(0, Math.min(1, emp.hit_rate * biasMult)) : null;
    const confidence = emp.samples >= MIN_HIT_RATE_SAMPLES ? (emp.samples >= 80 ? "high" : "medium") : "low";
    return {
      kind: lv.kind,
      label: lv.label,
      price: Number(lv.price.toFixed(4)),
      distance_pct: Number((distancePct * 100).toFixed(2)),
      raw_hit_rate: emp.hit_rate != null ? Number(emp.hit_rate.toFixed(3)) : null,
      regime_adjusted_prob: adjusted != null ? Number(adjusted.toFixed(3)) : null,
      regime_bias_mult: Number(biasMult.toFixed(2)),
      confidence,
      samples: emp.samples,
      golden_gate: !!lv.golden_gate,
      atr_mult: lv.atr_mult || null,
      direction: isUpside ? "up" : "down",
    };
  });

  // Top-3 most-probable upside + downside picks for the LLM summary.
  const ups = levels.filter((l) => l.direction === "up" && l.regime_adjusted_prob != null)
                    .sort((a, b) => b.regime_adjusted_prob - a.regime_adjusted_prob).slice(0, 3);
  const dns = levels.filter((l) => l.direction === "down" && l.regime_adjusted_prob != null)
                    .sort((a, b) => b.regime_adjusted_prob - a.regime_adjusted_prob).slice(0, 3);

  // Generate a one-line narrative for the LLM to cite. The "golden gate"
  // shorthand from the user request comes through here.
  const ggLong = levels.find((l) => l.golden_gate && l.direction === "up" && l.kind.includes("retracement"));
  const ggShort = levels.find((l) => l.golden_gate && l.direction === "down" && l.kind.includes("retracement"));
  const narrativeParts = [];
  if (ggLong) narrativeParts.push(`golden-gate up (${ggLong.label} ${ggLong.price.toFixed(2)}): ${(ggLong.regime_adjusted_prob * 100).toFixed(0)}% adj prob`);
  if (ggShort) narrativeParts.push(`golden-gate down (${ggShort.label} ${ggShort.price.toFixed(2)}): ${(ggShort.regime_adjusted_prob * 100).toFixed(0)}% adj prob`);
  if (ups.length > 0) narrativeParts.push(`top upside: ${ups[0].label} @ ${ups[0].price.toFixed(2)} (${(ups[0].regime_adjusted_prob * 100).toFixed(0)}%)`);
  if (dns.length > 0) narrativeParts.push(`top downside: ${dns[0].label} @ ${dns[0].price.toFixed(2)} (${(dns[0].regime_adjusted_prob * 100).toFixed(0)}%)`);
  const narrative = narrativeParts.join(" | ");

  const payload = {
    ticker: sym,
    as_of_date: new Date(current.ts > 1e12 ? current.ts : current.ts * 1000).toISOString().slice(0, 10),
    bar_as_of_ms: current.ts > 1e12 ? current.ts : current.ts * 1000,
    computed_at: Date.now(),
    current_price: Number(current.c.toFixed(4)),
    atr14: atr ? Number(atr.toFixed(4)) : null,
    swing_high: Number(swings.high.toFixed(4)),
    swing_low: Number(swings.low.toFixed(4)),
    swing_lookback: swings.lookback,
    horizon_bars: horizon,
    markov: markovBias || null,
    levels,
    top_upside: ups,
    top_downside: dns,
    narrative,
    read: interpretCTORead(ups[0], dns[0]),
    bars: candles.length,
    low_sample: lowSample,
  };

  const kvExpireSec = Math.max(ttlSec * 2, 3600);
  try {
    await env?.KV?.put(KV_TICKER_PREFIX + sym, JSON.stringify(payload), { expirationTtl: kvExpireSec });
  } catch (_) {}

  // D1 audit row (fresh compute only — cache hits return above).
  try {
    const snapshotId = `${sym}_${payload.as_of_date}_${Date.now().toString(36)}`;
    await env.DB.prepare(`
      INSERT INTO ${CTO_TABLE}
        (snapshot_id, ticker, as_of_date, produced_at, current_price, atr14,
         swing_high, swing_low, regime, regime_p_up_5b, regime_p_dn_5b, levels_json, narrative)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
    `).bind(
      snapshotId, sym, payload.as_of_date, payload.computed_at,
      payload.current_price, payload.atr14, payload.swing_high, payload.swing_low,
      markovBias?.state || null,
      markovBias?.p_up_5_bar ?? null,
      markovBias?.p_dn_5_bar ?? null,
      JSON.stringify(levels).slice(0, 32000),
      narrative.slice(0, 1000),
    ).run();
  } catch (_) {}

  try {
    const { recordCTOSignals } = await import("./cto-live-status.js");
    await recordCTOSignals(env, { ok: true, from_cache: false, ...payload });
  } catch (_) {}

  return { ok: true, from_cache: false, ...payload };
}

// ── Universe cron entry point ────────────────────────────────────────────────
/**
 * Compute CTO levels for the scored universe (SECTOR_MAP + user-added tickers).
 * Tiered refresh: indices + open positions hourly; remainder daily.
 */
export { INDEX_FOCUS } from "./cto-universe.js";

function toRollupRow(t, r) {
  return {
    ticker: t,
    ok: !!r.ok,
    from_cache: !!r.from_cache,
    error_kind: r.ok ? null : (r.error_kind || "unknown"),
    bars: r.bars || null,
    as_of_date: r.as_of_date || null,
    bar_as_of_ms: r.bar_as_of_ms || null,
    anchor_price: r.current_price ?? null,
    narrative: r.narrative || null,
    top_upside: (r.top_upside || []).slice(0, 1),
    top_downside: (r.top_downside || []).slice(0, 1),
    low_sample: !!r.low_sample,
  };
}

/** How to read the paired upside/downside chips shown in the level map. */
export function interpretCTORead(topUpside, topDownside, { leanThreshold = 0.12 } = {}) {
  const upP = Number(topUpside?.regime_adjusted_prob ?? topUpside?.adj_prob);
  const dnP = Number(topDownside?.regime_adjusted_prob ?? topDownside?.adj_prob);
  const upPx = Number(topUpside?.price);
  const dnPx = Number(topDownside?.price);
  if (!Number.isFinite(upP) && !Number.isFinite(dnP)) {
    return { kind: "none", label: null, lean: null, prob_spread: null, range_pct: null, blurb: null };
  }
  const spread = Math.abs((Number.isFinite(upP) ? upP : 0) - (Number.isFinite(dnP) ? dnP : 0));
  const bothStrong = (upP >= 0.55) && (dnP >= 0.55);
  let rangePct = null;
  if (Number.isFinite(upPx) && Number.isFinite(dnPx) && upPx > dnPx) {
    const mid = (upPx + dnPx) / 2;
    if (mid > 0) rangePct = Number((((upPx - dnPx) / mid) * 100).toFixed(1));
  }
  if (bothStrong && spread < leanThreshold) {
    return {
      kind: "range",
      label: "Range map",
      lean: null,
      prob_spread: Number(spread.toFixed(3)),
      range_pct: rangePct,
      blurb: rangePct != null
        ? `Both magnets sit in a ${rangePct.toFixed(1)}% band and each hit often historically — read as chop between levels, not a directional pick.`
        : "Both nearby levels hit often — read as a range between upside and downside magnets, not a directional pick.",
    };
  }
  if (Number.isFinite(upP) && Number.isFinite(dnP) && upP - dnP >= leanThreshold) {
    return {
      kind: "upside",
      label: "Upside lean",
      lean: "up",
      prob_spread: Number(spread.toFixed(3)),
      range_pct: rangePct,
      blurb: `Upside ${topUpside?.label || "level"} (${(upP * 100).toFixed(0)}%) leads downside (${(dnP * 100).toFixed(0)}%) — prioritize the upper magnet when they conflict.`,
    };
  }
  if (Number.isFinite(dnP) && Number.isFinite(upP) && dnP - upP >= leanThreshold) {
    return {
      kind: "downside",
      label: "Downside lean",
      lean: "down",
      prob_spread: Number(spread.toFixed(3)),
      range_pct: rangePct,
      blurb: `Downside ${topDownside?.label || "level"} (${(dnP * 100).toFixed(0)}%) leads upside (${(upP * 100).toFixed(0)}%) — prioritize the lower magnet when they conflict.`,
    };
  }
  const lean = upP > dnP ? "up" : dnP > upP ? "down" : null;
  return {
    kind: "mixed",
    label: lean === "up" ? "Upside edge" : lean === "down" ? "Downside edge" : "Compare sides",
    lean,
    prob_spread: Number(spread.toFixed(3)),
    range_pct: rangePct,
    blurb: "Use the higher hit-rate side as the primary magnet; these are historical tags, not entries.",
  };
}

/** Pick the primary magnet for ranking / UI (lean-aware). */
export function pickLeadingCTOMagnet(item) {
  const lean = item?.lean;
  const kind = item?.read_kind;
  if (lean === "up" || kind === "upside") return item?.top_upside || null;
  if (lean === "down" || kind === "downside") return item?.top_downside || null;
  const upP = Number(item?.top_upside?.adj_prob) || 0;
  const dnP = Number(item?.top_downside?.adj_prob) || 0;
  return upP >= dnP ? (item?.top_upside || null) : (item?.top_downside || null);
}

/**
 * Composite attractiveness for the PML top-30: probability, actionable
 * distance (early vs exhausted), move confirmation, remaining room.
 */
export function scoreCTOFeedItem(item) {
  const leading = pickLeadingCTOMagnet(item);
  const prob = Number(leading?.adj_prob) || Math.max(
    Number(item?.top_upside?.adj_prob) || 0,
    Number(item?.top_downside?.adj_prob) || 0,
  );
  const rawDist = Number(leading?.live_distance_pct ?? leading?.distance_pct);
  const dist = Number.isFinite(rawDist) ? Math.abs(rawDist) : null;
  const levelSt = leading?.level_status;

  let distScore = 0.5;
  if (levelSt === "hit") distScore = 0.12;
  else if (levelSt === "faded") distScore = 0.22;
  else if (dist != null) {
    if (dist < 0.35) distScore = 0.5;
    else if (dist <= 1.5) distScore = 0.95;
    else if (dist <= 4) distScore = 1.0;
    else if (dist <= 8) distScore = 0.78;
    else if (dist <= 15) distScore = 0.48;
    else distScore = 0.28;
  }

  const rs = item?.read_status?.status;
  let confirmScore = 0.55;
  if (rs === "confirmed") confirmScore = 1.0;
  else if (rs === "partial") confirmScore = 0.88;
  else if (rs === "open") confirmScore = 0.68;
  else if (rs === "hit") confirmScore = 0.72;
  else if (rs === "against") confirmScore = 0.18;

  let potentialScore = 0.45;
  if (levelSt === "hit") potentialScore = 0.08;
  else if (levelSt === "faded") potentialScore = 0.15;
  else if (dist != null) potentialScore = Math.min(dist / 8, 1);

  const score = prob * 0.45 + distScore * 0.25 + confirmScore * 0.15 + potentialScore * 0.15;
  return Number(score.toFixed(4));
}

/** Merge rollup rows with per-ticker KV so the feed can reach top 30. */
export async function gatherCTOFeedCandidateRows(env, rollup, { maxKvReads = 150 } = {}) {
  const byTicker = new Map();
  for (const row of rollup?.results || []) {
    if (!row?.ok) continue;
    byTicker.set(String(row.ticker || "").toUpperCase(), row);
  }
  const scored = await resolveScoredUniverseTickers(env);
  const candidates = [...new Set([...INDEX_FOCUS, ...scored])];
  let kvReads = 0;
  for (const sym of candidates) {
    if (byTicker.has(sym)) continue;
    if (kvReads >= maxKvReads) break;
    const cached = await loadCTOForTicker(env, sym);
    const row = rollupRowFromCachedPayload(sym, cached);
    if (row) byTicker.set(sym, row);
    kvReads += 1;
  }
  return Array.from(byTicker.values());
}

/** Rank feed items: index focus pinned, then top movers by composite score. */
export function rankCTOFeedItems(items, { limit = 30 } = {}) {
  const cap = Math.max(1, Number(limit) || 30);
  const scored = (items || []).map((it) => ({
    ...it,
    sort_score: scoreCTOFeedItem(it),
    sort_prob: Math.max(
      Number(it?.top_upside?.adj_prob) || 0,
      Number(it?.top_downside?.adj_prob) || 0,
    ),
  }));
  const byScore = (a, b) => (b.sort_score || 0) - (a.sort_score || 0);
  const indexes = scored.filter((it) => it.is_index).sort(byScore);
  const movers = scored.filter((it) => !it.is_index).sort(byScore);
  const moverSlots = Math.max(0, cap - indexes.length);
  return [...indexes, ...movers.slice(0, moverSlots)].slice(0, cap);
}

function rowToFeedItem(row) {
  const sym = String(row.ticker || "").toUpperCase();
  const up = row.top_upside?.[0] || null;
  const dn = row.top_downside?.[0] || null;
  const read = interpretCTORead(up, dn);
  return {
    ticker: sym,
    narrative: row.narrative || null,
    as_of_date: row.as_of_date || null,
    bar_as_of_ms: row.bar_as_of_ms || null,
    anchor_price: row.anchor_price ?? null,
    read_kind: read.kind,
    read_label: read.label,
    read_blurb: read.blurb,
    prob_spread: read.prob_spread,
    range_pct: read.range_pct,
    lean: read.lean,
    top_upside: up ? {
      label: up.label,
      price: up.price,
      adj_prob: up.regime_adjusted_prob,
      distance_pct: up.distance_pct,
      golden_gate: !!up.golden_gate,
    } : null,
    top_downside: dn ? {
      label: dn.label,
      price: dn.price,
      adj_prob: dn.regime_adjusted_prob,
      distance_pct: dn.distance_pct,
      golden_gate: !!dn.golden_gate,
    } : null,
    is_index: INDEX_FOCUS.has(sym),
    sort_prob: Math.max(Number(up?.regime_adjusted_prob) || 0, Number(dn?.regime_adjusted_prob) || 0),
  };
}

/** Slim user-safe feed for Today / Now surfaces (mirrors CRO feed pattern). */
export function buildCTOFeedItemsFromRollup(rollup, { limit = 30 } = {}) {
  const rows = Array.isArray(rollup?.results) ? rollup.results : [];
  const items = rows.filter((row) => row?.ok).map(rowToFeedItem);
  return rankCTOFeedItems(items, { limit });
}

export async function buildPublicCTOFeed(env, { limit = 30 } = {}) {
  const rollup = await loadCTOUniverse(env);
  if (!rollup) return { ok: false, error_kind: "no_rollup_yet" };
  const rows = await gatherCTOFeedCandidateRows(env, rollup);
  let items = rows.filter((row) => row?.ok).map(rowToFeedItem);
  let kvReads = 0;
  for (const item of items) {
    if (item.bar_as_of_ms) continue;
    if (kvReads >= 40) break;
    const cached = await loadCTOForTicker(env, item.ticker);
    if (cached?.bar_as_of_ms) {
      item.bar_as_of_ms = cached.bar_as_of_ms;
      item.as_of_date = cached.as_of_date || item.as_of_date;
    }
    backfillItemBarAsOfMs(item);
    kvReads += 1;
  }
  for (const item of items) backfillItemBarAsOfMs(item);
  const prediction_as_of_ms = resolvePredictionAsOfMs(items, rollup.computed_at || Date.now());
  const headlines = Array.isArray(rollup.headlines) ? rollup.headlines.slice(0, 12) : [];
  const basePayload = {
    ok: true,
    generated_at: rollup.computed_at || Date.now(),
    prediction_as_of_ms,
    horizon_bars: HORIZON_BARS,
    horizon_note: `Empirical hit rates ask whether price reaches each magnet within ~${HORIZON_BARS} trading sessions (~1 month).`,
    tickers_processed: rollup.tickers_processed || 0,
    tickers_ok: rows.length,
    tickers_candidates: rows.length,
    headlines,
    items,
    count: items.length,
  };
  const enriched = await enrichPublicCTOFeed(env, basePayload);
  enriched.items = rankCTOFeedItems(enriched.items, { limit });
  enriched.count = enriched.items.length;
  try {
    const { syncCTOFeedKv } = await import("./cto-feed-kv.js");
    await syncCTOFeedKv(env, enriched);
  } catch (_) { /* best-effort */ }
  return enriched;
}

/** Apply live price + hit/faded status on every feed response. */
export async function enrichPublicCTOFeed(env, feed) {
  if (!feed?.items?.length) return feed;
  const { enrichCTOFeedItemsWithAnchors, loadCTOLearningSummary } = await import("./cto-live-status.js");
  const items = await enrichCTOFeedItemsWithAnchors(env, feed.items);
  const learning = await loadCTOLearningSummary(env);
  return {
    ...feed,
    items,
    learning,
    live_as_of_ms: Date.now(),
  };
}

/**
 * Compute CTO levels for the scored universe (tiered refresh).
 * @param {"priority"|"full"|"all"} mode
 *   priority — indices + open positions, hourly, 1h cache
 *   full     — rest of scored universe, daily, 24h cache
 *   all      — entire scored universe (admin override)
 */
export async function runCTOUniverse(env, {
  tickers: tickersOverride = null,
  limit = null,
  forceRefresh = false,
  mode = "all",
  maxElapsedMs = null,
  surfaced = null,
} = {}) {
  await ensureCTOSchema(env);

  const previousRollup = await loadCTOUniverse(env);
  let universeMeta = null;
  let tickers = tickersOverride;

  if (!tickers || tickers.length === 0) {
    universeMeta = await buildCTORefreshTickers(env, { mode, limit, surfaced });
    tickers = universeMeta.tickers;
  }

  const scored = universeMeta?.scored || await resolveScoredUniverseTickers(env);
  const openPositionsSet = universeMeta?.openPositionsSet || null;
  // Surfaced movers get the 1h priority TTL during a session pass so gap-day
  // levels re-anchor hourly instead of riding the 24h cache.
  const extraSet = universeMeta?.extraSet || null;
  const rollupUniverse = [...new Set([
    ...scored,
    ...INDEX_FOCUS,
    ...(universeMeta?.openPositions || []),
  ])].sort();
  const elapsedBudget = maxElapsedMs ?? (
    mode === "priority" ? MAX_ELAPSED_MS_PRIORITY
    : mode === "session" ? MAX_ELAPSED_MS_SESSION
    : MAX_ELAPSED_MS_FULL
  );

  const t0 = Date.now();
  const processed = [];
  let stoppedEarly = false;
  let cacheHits = 0;
  let computed = 0;

  for (const t of tickers) {
    if (Date.now() - t0 >= elapsedBudget) {
      stoppedEarly = true;
      break;
    }
    try {
      const ttl = cacheTtlForTicker(t, { openPositions: openPositionsSet, extra: extraSet });
      const r = await computeCTOForTicker(env, t, {
        force: !!forceRefresh,
        cacheTtlSeconds: ttl,
        openPositions: openPositionsSet,
      });
      if (r.from_cache) cacheHits += 1;
      else if (r.ok || r.error_kind) computed += 1;
      processed.push(toRollupRow(t, r));
    } catch (e) {
      computed += 1;
      processed.push({
        ticker: t,
        ok: false,
        error_kind: "exception",
        error: String(e?.message || e).slice(0, 150),
      });
    }
  }

  const results = mergeRollupResults(rollupUniverse, processed, previousRollup);

  // On full/all passes, backfill any rollup names still missing via KV (bounded).
  if (mode !== "priority" && results.length < rollupUniverse.length) {
    const have = new Set(results.map((r) => r.ticker));
    let kvReads = 0;
    const KV_BACKFILL_CAP = 40;
    for (const sym of rollupUniverse) {
      if (have.has(sym)) continue;
      if (kvReads >= KV_BACKFILL_CAP) break;
      if (Date.now() - t0 >= elapsedBudget) break;
      const cached = await loadCTOForTicker(env, sym);
      const row = rollupRowFromCachedPayload(sym, cached);
      if (row) {
        results.push(row);
        have.add(sym);
      }
      kvReads += 1;
    }
    results.sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));
  }

  const headlines = [];
  for (const r of results) {
    if (!r.ok) continue;
    const up = r.top_upside?.[0];
    const dn = r.top_downside?.[0];
    if (up && up.regime_adjusted_prob >= 0.6) {
      headlines.push(`${r.ticker} ${up.label} @ ${up.price.toFixed(2)} → ${(up.regime_adjusted_prob * 100).toFixed(0)}% adj prob (regime-aligned upside)`);
    }
    if (dn && dn.regime_adjusted_prob >= 0.6) {
      headlines.push(`${r.ticker} ${dn.label} @ ${dn.price.toFixed(2)} → ${(dn.regime_adjusted_prob * 100).toFixed(0)}% adj prob (regime-aligned downside)`);
    }
  }

  const rollup = {
    computed_at: Date.now(),
    elapsed_ms: Date.now() - t0,
    mode,
    tickers_requested: tickers.length,
    tickers_processed: processed.length,
    tickers_ok: results.filter((r) => r.ok).length,
    tickers_in_rollup: results.length,
    scored_universe_size: scored.length,
    rollup_universe_size: rollupUniverse.length,
    cache_hits: cacheHits,
    computed,
    stopped_early: stoppedEarly,
    force_refresh: !!forceRefresh,
    headlines: headlines.slice(0, 20),
    results,
  };

  try {
    await env.KV.put(KV_LATEST_KEY, JSON.stringify(rollup), { expirationTtl: 4 * 3600 });
  } catch (_) {}

  if (mode === "full" || mode === "all") {
    try {
      await env.KV.put(KV_LAST_FULL_REFRESH, String(Date.now()), { expirationTtl: 7 * 86400 });
    } catch (_) {}
  }

  try {
    await buildPublicCTOFeed(env, { limit: 30 });
  } catch (_) { /* feed sync best-effort */ }

  return { ok: true, ...rollup };
}

// ── Read helpers ──────────────────────────────────────────────────────────────
export async function loadCTOForTicker(env, ticker) {
  try {
    const raw = await env?.KV?.get(KV_TICKER_PREFIX + String(ticker).toUpperCase());
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

export async function loadCTOUniverse(env) {
  try {
    const raw = await env?.KV?.get(KV_LATEST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

// ── Compact addendum for CIO + Daily Brief (mirror of cro-service helper) ────
export async function getCTOBriefAddendum(env, { topN = 6 } = {}) {
  const rollup = await loadCTOUniverse(env);
  if (!rollup || !rollup.headlines || rollup.headlines.length === 0) {
    return "## CTO Probabilistic Levels (no fresh universe-wide rollup; per-ticker probabilities still available via /timed/cto/ticker).";
  }
  return [
    `## CTO Probabilistic Levels — universe rollup ${new Date(rollup.computed_at).toISOString().slice(0, 10)} (${rollup.tickers_ok}/${rollup.tickers_processed} tickers)`,
    ...rollup.headlines.slice(0, topN).map((h) => `• ${h}`),
    "Use these as data-backed price targets (empirical hit-rate × Markov regime bias). NOT as trade signals — the engine + CIO own that.",
  ].join("\n");
}
