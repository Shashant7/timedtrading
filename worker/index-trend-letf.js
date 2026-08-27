// worker/index-trend-letf.js
// Index trend / swing lane — SPYU/SPXU share expressions (NOT day-trade options).

import { lookupLETF, DAY_TRADE_TICKERS } from "./options-plays.js";
import {
  pickPreferredLetfTicker,
  getLetfFactor,
  resolveLetfHorizon,
  scoreLetfSuitability,
} from "./letf-vehicles.js";

export const INDEX_TREND_TICKERS = DAY_TRADE_TICKERS;

export function isIndexTrendTicker(ticker) {
  return INDEX_TREND_TICKERS.has(String(ticker || "").toUpperCase());
}

/**
 * Should the model express an index trend via LETF shares (not options)?
 */
export function shouldActivateIndexTrendLetf({
  ticker,
  verdict = null,
  tickerData = {},
  fsdMacro = null,
} = {}) {
  const sym = String(ticker || "").toUpperCase();
  if (!isIndexTrendTicker(sym)) {
    return { activate: false, reason: "not_index_proxy" };
  }

  const timing = verdict?.timing || tickerData?.timing_overlay || {};
  const mode = String(verdict?.mode || "").toUpperCase();
  const side = String(verdict?.side || "").toUpperCase();
  const macro = fsdMacro || timing?.fsd_macro || tickerData?.fsd_macro || null;

  const horizon = resolveLetfHorizon({
    holdIntent: tickerData?.hold_intent || "SWING",
    confluenceMode: mode,
    timingOverlay: timing,
    expectedMovePct: null,
    dayTradeContext: false,
  });

  if (horizon === "avoid_chop") {
    return { activate: false, reason: "chop_regime_letf_decay", horizon };
  }

  const longSignals = macro?.rally_active
    || timing?.add_on_dips
    || timing?.call_opportunity
    || timing?.signals?.includes?.("fsd_rally_dip_buy")
    || timing?.signals?.includes?.("fsd_rally_window")
    || (mode === "RIDE" && side === "LONG")
    || (mode === "DRIFT" && side === "LONG");

  const shortSignals = timing?.put_opportunity
    || timing?.short_opportunity
    || (mode === "FADE" && side === "SHORT")
    || (mode === "RIDE" && side === "SHORT");

  if (longSignals && !shortSignals) {
    return { activate: true, direction: "LONG", reason: "index_trend_long", horizon, macro };
  }
  if (shortSignals && !longSignals) {
    return { activate: true, direction: "SHORT", reason: "index_trend_inverse", horizon, macro };
  }
  if (longSignals && shortSignals) {
    return { activate: false, reason: "mixed_long_short_signals", horizon };
  }
  return { activate: false, reason: "no_trend_signal", horizon };
}

/** Management doctrine — wider than day-trade options; ride, trim, DCA. */
export function buildIndexTrendManagement({
  direction,
  price,
  atrPct = 0.012,
  sl,
  tp1,
  fsdMacro = null,
} = {}) {
  const px = Number(price);
  const atr = Number(atrPct) || 0.012;
  const dir = direction === "SHORT" ? "SHORT" : "LONG";
  const stopPct = Math.max(0.015, atr * 2.5);
  const stopUnderlying = Number.isFinite(sl) && sl > 0
    ? sl
    : (dir === "LONG" ? px * (1 - stopPct) : px * (1 + stopPct));
  const targetUnderlying = Number.isFinite(tp1) && tp1 > 0
    ? tp1
    : (dir === "LONG" ? px * (1 + stopPct * 2) : px * (1 - stopPct * 2));

  const deadlineMs = fsdMacro?.target_deadline_ms || null;
  const deadlineLabel = deadlineMs
    ? new Date(deadlineMs).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : null;

  return {
    lane: "index_trend_letf",
    direction: dir,
    stop_underlying: Math.round(stopUnderlying * 100) / 100,
    target_underlying: Math.round(targetUnderlying * 100) / 100,
    trim_ladder: [
      { at_r: 1, size: 0.25, label: "Trim 25% at +1R" },
      { at_r: 2, size: 0.25, label: "Trim 25% at +2R" },
      { trail_remainder: true, label: "Trail stop on remainder (ST line or breakeven)" },
    ],
    dca_on_dip: !!fsdMacro?.rally_active,
    dca_note: fsdMacro?.rally_active
      ? "Add on compression dips while FSD rally window active (do not average into chop)"
      : null,
    exit_by: deadlineLabel ? `Month-end target (${deadlineLabel}) or invalidation` : "Invalidation or ST flip",
    target_deadline_ms: deadlineMs,
    doctrine_version: "index-trend-letf-1",
  };
}

/**
 * Build an index trend LETF play (share order on SPYU/SPXU/etc.).
 * Parallel to buildLeveragedETFPlay but gated for swing/trend only.
 */
export function buildIndexTrendLetfPlay(ctx) {
  const ticker = String(ctx?.ticker || "").toUpperCase();
  if (!isIndexTrendTicker(ticker)) return null;

  const price = Number(ctx?.price);
  if (!Number.isFinite(price) || price <= 0) return null;

  const verdict = ctx?.verdict || null;
  const tickerData = ctx?.tickerData || {};
  const fsdMacro = ctx?.fsd_macro || verdict?.timing?.fsd_macro || tickerData?.fsd_macro || null;
  const themes = ctx?.themes || [];

  const gate = shouldActivateIndexTrendLetf({ ticker, verdict, tickerData, fsdMacro });
  if (!gate.activate) return null;

  const direction = gate.direction;
  const letf = lookupLETF(ticker, themes);
  if (!letf) return null;

  const letfTicker = pickPreferredLetfTicker(letf, direction, {
    fsdMacro: gate.macro || fsdMacro,
    horizon: gate.horizon || "swing_trend",
    timing: verdict?.timing || tickerData?.timing_overlay,
  });
  if (!letfTicker) return null;

  const scored = scoreLetfSuitability({
    direction,
    letfEntry: letf,
    letfTicker,
    tickerData,
    confluence: verdict,
    fsdMacro: gate.macro || fsdMacro,
    expectedMovePct: ctx?.expected_move_pct,
    holdIntent: "SWING",
    dayTradeContext: false,
    passiveProfile: false,
  });

  if (scored.score < 40) return null;

  const factor = getLetfFactor(letfTicker, letf);
  const sl = Number(ctx?.sl);
  const tp1 = Number(ctx?.tp1);
  const management = buildIndexTrendManagement({
    direction,
    price,
    atrPct: ctx?.atrPct,
    sl,
    tp1,
    fsdMacro: gate.macro || fsdMacro,
  });

  const overlayLine = (gate.macro || fsdMacro)?.overlay_line;
  const spxTarget = (gate.macro || fsdMacro)?.spx_target;

  return {
    archetype: "index_trend_letf",
    lane: "index_trend",
    label: direction === "LONG"
      ? `Index Trend · ${letfTicker} (${factor}× long)`
      : `Index Trend · ${letfTicker} (${factor}× inverse)`,
    rationale: [
      `Swing/trend expression on ${ticker} via ${letfTicker} — share order, not a day-trade option.`,
      overlayLine ? `Desk: ${String(overlayLine).slice(0, 120)}` : null,
      spxTarget ? `SPX target ${spxTarget.low}–${spxTarget.high}` : null,
      "Wider stop than day trade; trim into strength; add on FSD compression dips.",
    ].filter(Boolean).join(" "),
    legs: [{ action: "BUY", instrument: "ETF", ticker: letfTicker, qty: 1 }],
    underlying: ticker,
    letf_ticker: letfTicker,
    factor,
    direction,
    contracts: 1,
    suitability: scored.score,
    suitability_reasons: scored.reasons,
    gate_reason: gate.reason,
    horizon: gate.horizon,
    management,
    notes: [
      `${factor}× daily-reset — avoid prolonged chop; this is a trend book, not the Index Day-Trade options strip`,
      management.dca_on_dip ? "DCA adds allowed on compression while macro rally active" : "No DCA — wait for trend clarity",
      `Exit: ${management.exit_by}`,
    ],
    _index_trend: true,
    _not_day_trade: true,
  };
}

/** Build index trend plays for all index proxies in one pass. */
export function buildIndexTrendSection(tickers, opts = {}) {
  const list = Array.isArray(tickers) ? tickers : [];
  const plays = [];
  const suppressed = [];

  for (const sym of INDEX_TREND_TICKERS) {
    const row = list.find((t) => String(t?.ticker || "").toUpperCase() === sym) || { ticker: sym };
    const price = Number(opts.pricesMap?.[sym]?.p ?? row?.price ?? row?._live_price);
    if (!(price > 0)) {
      suppressed.push({ ticker: sym, reason: "no_price" });
      continue;
    }

    let verdict = null;
    try {
      verdict = opts.scoreConfluence?.(row) ?? row?.confluence_verdict ?? null;
    } catch (_) {
      verdict = row?.confluence_verdict ?? null;
    }

    const play = buildIndexTrendLetfPlay({
      ticker: sym,
      price,
      verdict,
      tickerData: row,
      fsd_macro: opts.fsdMacro || row?.fsd_macro,
      atrPct: Number(row?.atr_pct ?? row?.atrPct) || 0.012,
      sl: row?.sl,
      tp1: row?.tp ?? row?.tp1,
      themes: (row?.themes || []).map((x) => (typeof x === "string" ? x : x?.theme)).filter(Boolean),
    });

    if (play) {
      plays.push({
        ticker: sym,
        price,
        direction: play.direction,
        letf_ticker: play.letf_ticker,
        factor: play.factor,
        suitability: play.suitability,
        play,
        confluence_mode: verdict?.mode || null,
      });
    } else {
      const gate = shouldActivateIndexTrendLetf({
        ticker: sym,
        verdict,
        tickerData: row,
        fsdMacro: opts.fsdMacro || row?.fsd_macro,
      });
      suppressed.push({ ticker: sym, reason: gate.reason || "gate_failed", horizon: gate.horizon });
    }
  }

  return {
    index_trend_plays: plays,
    index_trend_suppressed: suppressed,
    index_trend_count: plays.length,
    index_trend_generated_at: Date.now(),
  };
}
