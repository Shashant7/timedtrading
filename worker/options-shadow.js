// worker/options-shadow.js
//
// Shadow-mode trade expression ladder on equity entry signals:
//   1. Shares (conservative)
//   2. Leveraged ETF when mapped (risk on)
//   3. Long call / long put — three calibration tiers (extra risk on)
// Labeled SHADOW in Discord/email — advisory only, no broker orders.
//
// Env:
//   OPTIONS_SHADOW_MODE=1            — enable on entry alerts
//   OPTIONS_SHADOW_FETCH_CHAIN=1     — Alpaca chain when cache missing (default on)
//   OPTIONS_DEFAULT_PROFILE          — model default profile (trader; see buildEntryOptionsPlay)
//   OPTIONS_ACCOUNT_VALUE            — sizing

import {
  buildOptionsLadder,
  buildLeveragedETFPlay,
  compactOptionsPlay,
  lookupLETF,
  pickExpirationForProfile,
  PROFILE_META,
} from "./options-plays.js";
import { alpacaFetchOptionsChain } from "./alpaca-options.js";

const SHADOW_ARCHETYPES = Object.freeze({
  LONG: "long_call",
  SHORT: "long_put",
});

/** Three calibration tiers shown alongside each entry signal. */
export const SHADOW_TIER_DEFS = Object.freeze([
  { key: "default", label: "Model default", deltaOffset: 0, scanLoosest: false },
  { key: "loose", label: "Looser", deltaOffset: -0.15, scanLoosest: false },
  { key: "loosest", label: "Loosest valid", deltaOffset: 0, scanLoosest: true },
]);

const LOOSEST_DELTA_CANDIDATES = [0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];

function computeDollarsAtRisk(env) {
  const accountValue = Number(env?.OPTIONS_ACCOUNT_VALUE) || 100_000;
  const riskBudgetPct = 0.005;
  return Math.max(50, accountValue * riskBudgetPct);
}

function normalizeThemes(tickerData) {
  return (tickerData?.themes || [])
    .map((x) => (typeof x === "string" ? x : x?.theme))
    .filter(Boolean);
}

function buildSharesExpression({
  ticker, direction, price, sl, tp, shares, notional, env, mode,
}) {
  const p = Number(price);
  if (!(p > 0)) return null;
  const dir = String(direction || "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
  const sl1 = Number.isFinite(Number(sl)) ? Number(sl) : (dir === "LONG" ? p * 0.97 : p * 1.03);
  const tp1 = Number.isFinite(Number(tp)) ? Number(tp) : (dir === "LONG" ? p * 1.05 : p * 0.95);
  let qty = Number(shares);
  if (!(qty > 0) && Number(notional) > 0) qty = Math.floor(Number(notional) / p);
  if (!(qty > 0)) {
    const dar = computeDollarsAtRisk(env);
    const riskPerShare = Math.abs(p - sl1) || 1;
    qty = Math.max(1, Math.floor(dar / riskPerShare));
  }
  const desk = String(mode || "").toLowerCase() === "investor" ? "investor" : "trader";
  const raw = {
    archetype: dir === "LONG" ? "stock_long" : "stock_short",
    label: dir === "LONG" ? "Stock (Long)" : "Stock (Short)",
    rationale: `Plain stock ${dir === "LONG" ? "long" : "short"} at $${p.toFixed(2)}. No leverage, no time decay.`,
    legs: [{ action: dir === "LONG" ? "BUY" : "SELL_SHORT", instrument: "STOCK", qty }],
    max_loss_usd: Math.round(Math.abs(p - sl1) * qty),
    max_gain_usd: dir === "LONG" ? Math.round(Math.abs(tp1 - p) * qty) : null,
    notes: ["No expiration", "Conservative baseline expression"],
  };
  const compact = compactOptionsPlay(raw, { ticker, mode: desk });
  if (!compact) return null;
  return {
    ...compact,
    shadow: true,
    expression_key: "shares",
    expression_label: "Conservative",
    shadow_desk: desk,
  };
}

function buildLetfExpression({
  ticker, direction, price, sl, tp, tickerData, env, mode,
}) {
  const p = Number(price);
  if (!(p > 0)) return null;
  const dir = String(direction || "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
  const sl1 = Number.isFinite(Number(sl)) ? Number(sl) : (dir === "LONG" ? p * 0.97 : p * 1.03);
  const tp1 = Number.isFinite(Number(tp)) ? Number(tp) : (dir === "LONG" ? p * 1.05 : p * 0.95);
  const themes = normalizeThemes(tickerData);
  const letfMeta = lookupLETF(ticker, themes);
  if (!letfMeta) return null;
  const letfTicker = dir === "SHORT" ? letfMeta.short : letfMeta.long;
  if (!letfTicker) return null;
  const desk = String(mode || "").toLowerCase() === "investor" ? "investor" : "trader";
  const raw = buildLeveragedETFPlay({
    ticker,
    price: p,
    sl: sl1,
    tp1,
    direction: dir,
    dollars_at_risk: computeDollarsAtRisk(env),
    themes,
  });
  if (!raw) return null;
  const compact = compactOptionsPlay(raw, { ticker: letfTicker, mode: desk });
  if (!compact) return null;
  return {
    ...compact,
    shadow: true,
    expression_key: "letf",
    expression_label: "Risk on",
    letf_ticker: letfTicker,
    letf_factor: letfMeta.factor,
    underlying: ticker,
    shadow_desk: desk,
  };
}

export function optionsShadowModeEnabled(env) {
  const v = env?.OPTIONS_SHADOW_MODE;
  if (v === "0" || v === "false" || v === "off") return false;
  return v === "1" || v === "true" || v === "on";
}

export function optionsShadowFetchChainEnabled(env) {
  const v = env?.OPTIONS_SHADOW_FETCH_CHAIN;
  if (v === "0" || v === "false" || v === "off") return false;
  if (v == null || v === "") return true;
  return v === "1" || v === "true" || v === "on";
}

/** Profile the model uses for entry options plays (matches buildEntryOptionsPlay). */
export function modelOptionsProfile(env, mode) {
  const isInvestor = String(mode || "").toLowerCase() === "investor";
  const p = String(
    isInvestor ? "moderate" : (env?.OPTIONS_DEFAULT_PROFILE || "speculator"),
  ).toLowerCase();
  return PROFILE_META[p] ? p : (isInvestor ? "moderate" : "speculator");
}

/**
 * Mirror buildOptionsLadder targetDelta from confluence + profile.
 */
export function modelTargetDelta({ profile, confluence, ticker, isInvestor }) {
  const sym = String(ticker || "").toUpperCase();
  const indexTickers = new Set(["SPY", "QQQ", "IWM", "DIA"]);
  const isIndexTrader = indexTickers.has(sym) && !isInvestor;
  const verdictMode = confluence?.mode || "UNKNOWN";

  if (isIndexTrader) {
    if (profile === "speculator") return verdictMode === "FADE" ? 0.30 : 0.45;
    if (profile === "aggressive") return 0.50;
    if (profile === "conservative") return 0.70;
  }
  if (verdictMode === "RIDE") {
    return profile === "speculator" ? 0.70 : 0.50;
  }
  if (verdictMode === "FADE") return 0.30;
  return 0.50;
}

/**
 * Suggest a limit price for a debit option buy given bid/ask/mid.
 */
export function suggestOptionLimitPrice({ bid, ask, mid, action = "BUY" }) {
  const m = Number(mid);
  if (!(m > 0)) return null;
  const b = Number(bid);
  const a = Number(ask);
  if (Number.isFinite(b) && Number.isFinite(a) && b > 0 && a > 0 && a >= b) {
    const spread = a - b;
    const spreadPct = (spread / m) * 100;
    const wide = spreadPct >= 15;
    const isBuy = String(action || "BUY").toUpperCase() !== "SELL";
    const suggested = isBuy
      ? (wide ? b + spread * 0.25 : m)
      : (wide ? a - spread * 0.25 : m);
    return {
      bid: b,
      ask: a,
      mid: m,
      spread_pct: Math.round(spreadPct * 10) / 10,
      suggested_limit: Math.round(suggested * 100) / 100,
      wide_spread: wide,
      order_type: "LMT",
    };
  }
  return {
    bid: Number.isFinite(b) ? b : null,
    ask: Number.isFinite(a) ? a : null,
    mid: m,
    spread_pct: null,
    suggested_limit: m,
    wide_spread: false,
    order_type: "LMT",
  };
}

function pickShadowPlayFromLadder(ladder, direction) {
  if (!ladder) return null;
  const dir = String(direction || "").toUpperCase();
  const want = dir === "SHORT" ? SHADOW_ARCHETYPES.SHORT : SHADOW_ARCHETYPES.LONG;
  const items = Array.isArray(ladder.ladder) ? ladder.ladder : [];
  const match = items.find((s) => s?.archetype === want);
  if (match) return match;
  if (ladder.primary?.archetype === want) return ladder.primary;
  return null;
}

function enrichTierCompact(compact, rawPlay, meta = {}) {
  if (!compact) return null;
  const optLeg = (rawPlay?.legs || []).find((l) => l?.optionType) || null;
  const limit = suggestOptionLimitPrice({
    bid: optLeg?.premium_bid ?? rawPlay?.premium?.bid,
    ask: optLeg?.premium_ask ?? rawPlay?.premium?.ask,
    mid: optLeg?.premium_mid ?? rawPlay?.premium?.mid,
    action: optLeg?.action || "BUY",
  });
  return {
    ...compact,
    shadow: true,
    expression_key: "options",
    expression_label: "Extra risk on",
    shadow_tier: meta.tier_key || null,
    shadow_tier_label: meta.tier_label || null,
    shadow_desk: meta.desk || compact.mode || "trader",
    pricing_source: meta.pricing_source || "bs_estimate",
    actual_delta: rawPlay?.actual_delta ?? rawPlay?.target_delta ?? null,
    target_delta: rawPlay?.target_delta ?? null,
    limit_guidance: limit,
    dte: rawPlay?.expiration?.dte ?? null,
    target_clears_breakeven: rawPlay?.target_clears_breakeven ?? compact.target_clears_breakeven ?? null,
  };
}

function buildContract({ ticker, direction, price, sl, tp, tickerData }) {
  const p = Number(price);
  const dir = String(direction || "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
  const atrPct = Number(
    tickerData?.atr_pct
      ?? tickerData?.atrPct
      ?? tickerData?.tf_tech?.D?.atr_pct
      ?? 0.025,
  );
  const tp1 = Number.isFinite(Number(tp)) ? Number(tp) : (dir === "LONG" ? p * 1.05 : p * 0.95);
  const sl1 = Number.isFinite(Number(sl)) ? Number(sl) : (dir === "LONG" ? p * 0.97 : p * 1.03);
  return {
    ticker,
    direction: dir,
    price: p,
    sl: sl1,
    tp1,
    tp: tp1,
    atr_pct: atrPct,
    mode: "trader",
    stage: "swing",
    earnings_dte: tickerData?.earnings_dte ?? tickerData?.earningsDte,
    themes: tickerData?.themes || [],
    dir,
  };
}

function ladderForTier(contract, tierDef, {
  profile,
  chain,
  confluence,
  env,
  baseDelta,
  direction,
  ticker,
  mode,
}) {
  const desk = String(mode || "").toLowerCase() === "investor" ? "investor" : "trader";
  const isInvestor = desk === "investor";

  if (tierDef.scanLoosest) {
    for (const delta of LOOSEST_DELTA_CANDIDATES) {
      const ladder = buildOptionsLadder(contract, {
        profile,
        chain,
        confluence,
        themes: contract.themes,
        account_value: Number(env?.OPTIONS_ACCOUNT_VALUE) || undefined,
        targetDelta: delta,
      });
      const raw = pickShadowPlayFromLadder(ladder, direction);
      if (!raw) continue;
      if (raw.target_clears_breakeven === false) continue;
      const compact = compactOptionsPlay(raw, { ticker, mode: desk });
      const enriched = enrichTierCompact(compact, raw, {
        tier_key: tierDef.key,
        tier_label: tierDef.label,
        desk,
        pricing_source: chain ? "alpaca_chain" : "bs_estimate",
      });
      if (enriched) return { rawPlay: raw, compact: enriched, target_delta: delta };
    }
    return null;
  }

  const delta = Math.max(0.25, baseDelta + (tierDef.deltaOffset || 0));
  const ladder = buildOptionsLadder(contract, {
    profile,
    chain,
    confluence,
    themes: contract.themes,
    account_value: Number(env?.OPTIONS_ACCOUNT_VALUE) || undefined,
    targetDelta: delta,
  });
  const raw = pickShadowPlayFromLadder(ladder, direction);
  if (!raw) return null;
  const compact = compactOptionsPlay(raw, { ticker, mode: desk });
  const enriched = enrichTierCompact(compact, raw, {
    tier_key: tierDef.key,
    tier_label: tierDef.label,
    desk,
    pricing_source: chain ? "alpaca_chain" : "bs_estimate",
  });
  return enriched ? { rawPlay: raw, compact: enriched, target_delta: delta } : null;
}

/**
 * Build ranked shadow expression ladder for an entry signal.
 * Returns { shadow, expressions[], tiers[], ticker, mode, shadow_desk } or null.
 */
export async function buildShadowOptionsPlayAsync({
  ticker,
  direction,
  price,
  sl,
  tp,
  mode,
  tickerData,
  env,
  shares,
  notional,
}) {
  if (!optionsShadowModeEnabled(env)) return null;
  try {
    const p = Number(price);
    if (!(p > 0)) return null;
    const isInvestor = String(mode || "").toLowerCase() === "investor";
    const dir = String(direction || "").toUpperCase();
    if (isInvestor && dir === "SHORT") return null;

    const contract = buildContract({ ticker, direction, price, sl, tp, tickerData });
    const profile = modelOptionsProfile(env, mode);
    const confluence = tickerData?.confluence || tickerData?._confluence || null;
    let chain = tickerData?.options_chain || tickerData?._options_chain || null;

    if (!chain && optionsShadowFetchChainEnabled(env) && env) {
      const exp = pickExpirationForProfile(contract, profile);
      const chainRes = await alpacaFetchOptionsChain(env, ticker, exp?.iso || null, {
        strikeRangePct: 0.25,
      });
      if (chainRes?.ok) chain = chainRes;
    }

    const baseDelta = modelTargetDelta({
      profile,
      confluence,
      ticker,
      isInvestor,
    });

    const desk = isInvestor ? "investor" : "trader";
    const expressions = [];

    const sharesExpr = buildSharesExpression({
      ticker, direction: contract.dir, price: p, sl: contract.sl, tp: contract.tp1,
      shares, notional, env, mode,
    });
    if (sharesExpr) expressions.push(sharesExpr);

    const letfExpr = buildLetfExpression({
      ticker, direction: contract.dir, price: p, sl: contract.sl, tp: contract.tp1,
      tickerData, env, mode,
    });
    if (letfExpr) expressions.push(letfExpr);

    const tiers = [];
    for (const tierDef of SHADOW_TIER_DEFS) {
      const built = ladderForTier(contract, tierDef, {
        profile,
        chain,
        confluence,
        env,
        baseDelta,
        direction: contract.dir,
        ticker,
        mode,
      });
      if (built?.compact) {
        const optExpr = {
          expression_key: "options",
          expression_label: "Extra risk on",
          tier_key: tierDef.key,
          tier_label: tierDef.label,
          target_delta: built.target_delta,
          profile,
          ...built.compact,
        };
        tiers.push(optExpr);
        expressions.push(optExpr);
      }
    }

    if (!expressions.length) return null;

    const primary = expressions[0];
    return {
      shadow: true,
      shadow_ranked: true,
      shadow_ladder: true,
      expressions,
      tiers,
      ticker,
      mode: desk,
      shadow_desk: desk,
      // Back-compat for callers expecting a single compact play object
      ...primary,
    };
  } catch (e) {
    try {
      console.warn(`[OPTIONS_SHADOW] build failed for ${ticker}: ${String(e?.message || e).slice(0, 200)}`);
    } catch (_) { /* ignore */ }
    return null;
  }
}

function formatTierBlock(tier, idx) {
  const lines = [];
  const rank = idx + 1;
  const label = tier.expression_label
    ? `${tier.expression_label}${tier.tier_label ? ` · ${tier.tier_label}` : ""}`
    : (tier.tier_label || tier.shadow_tier_label || "Play");
  lines.push(`**${rank}. ${label}** (${tier.headline || tier.label || "play"})`);
  if (Array.isArray(tier.lines) && tier.lines.length) {
    lines.push(tier.lines.map((l) => `  • ${l}`).join("\n"));
  }
  const lg = tier.limit_guidance;
  if (lg?.suggested_limit != null) {
    const spread = lg.spread_pct != null ? ` · spread ${lg.spread_pct}%` : "";
    lines.push(`  LMT **$${lg.suggested_limit.toFixed(2)}**${spread}${lg.wide_spread ? " · wide — no market" : ""}`);
  }
  if (tier.actual_delta != null) {
    lines.push(`  Δ ${(Math.abs(tier.actual_delta) * 100).toFixed(0)}% · profile ${tier.profile || "—"}`);
  }
  if (tier.letf_factor != null && tier.letf_ticker) {
    lines.push(`  ${tier.letf_factor}× via ${tier.letf_ticker} on ${tier.underlying || tier.ticker || "underlying"}`);
  }
  if (tier.target_clears_breakeven === false) {
    lines.push("  ⚠️ TP below breakeven");
  }
  return lines.join("\n");
}

function shadowBundleItems(bundle) {
  if (Array.isArray(bundle?.expressions) && bundle.expressions.length) return bundle.expressions;
  if (Array.isArray(bundle?.tiers) && bundle.tiers.length) return bundle.tiers;
  return bundle?.lines ? [bundle] : [];
}

/**
 * Discord embed field — all ranked shadow tiers in one advisory block.
 */
export function shadowOptionsPlayDiscordField(bundle) {
  if (!bundle?.shadow) return null;
  const items = shadowBundleItems(bundle);
  if (!items.length) return null;

  const deskLabel = String(bundle.shadow_desk || bundle.mode || "trader").toLowerCase() === "investor"
    ? "Investor"
    : "Trader";

  let value = items.map((t, i) => formatTierBlock(t, i)).join("\n\n");
  value += `\n\n_Mode: SHADOW — advisory only; no orders placed. Shares → LETF (when mapped) → ranked long call/put calibration._`;

  if (value.length > 1024) value = value.slice(0, 1020).trimEnd() + "…";

  return {
    name: `🔬 Trade Expression Ladder (SHADOW · ${deskLabel}) · ${items.length} plays`,
    value,
    inline: false,
  };
}

export function shadowOptionsPlayEmailHtml(bundle) {
  if (!bundle?.shadow) return null;
  const items = shadowBundleItems(bundle);
  if (!items.length) return null;

  const _esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const blocks = items.map((t, i) => {
    const label = t.expression_label
      ? `${t.expression_label}${t.tier_label ? ` · ${t.tier_label}` : ""}`
      : (t.tier_label || t.shadow_tier_label || "Play");
    const legs = (t.lines || []).map((l) =>
      `<li style="margin:0 0 4px;color:rgba(255,255,255,0.85);font-size:12px;font-family:Menlo,Monaco,monospace">${_esc(l)}</li>`,
    ).join("");
    const lg = t.limit_guidance;
    const lmt = lg?.suggested_limit != null
      ? `<div style="font-size:12px;color:rgba(255,255,255,0.8)">LMT $${lg.suggested_limit.toFixed(2)}${lg.spread_pct != null ? ` · spread ${lg.spread_pct}%` : ""}</div>`
      : "";
    return `<div style="margin:0 0 12px"><div style="color:white;font-size:13px;font-weight:600">${i + 1}. ${_esc(label)}</div><ul style="margin:4px 0;padding:0 0 0 18px;list-style:none">${legs}</ul>${lmt}</div>`;
  }).join("");

  return `
    <div style="margin:0 0 8px;padding:4px 8px;display:inline-block;border:1px solid rgba(168,162,158,0.4);color:rgba(168,162,158,0.95);font-size:10px;letter-spacing:0.1em;text-transform:uppercase">SHADOW — advisory only</div>
    ${blocks}
  `;
}

export function shadowPlayToSignalMeta(compact, meta = {}) {
  const expr = compact?.expression_key || "options";
  const tier = compact?.tier_key || compact?.shadow_tier || "default";
  const prefix = expr === "options" ? `shadow:opt:${tier}` : `shadow:${expr}`;
  return {
    ...meta,
    desk: "shadow",
    signal_id: meta.signal_id || `${prefix}:${meta.ref_id || compact?.ticker || "x"}:${meta.published_at || Date.now()}`,
  };
}

export function shadowTiersForLedger(bundle) {
  if (Array.isArray(bundle?.expressions) && bundle.expressions.length) return bundle.expressions;
  if (bundle?.tiers?.length) return bundle.tiers;
  return bundle ? [bundle] : [];
}
