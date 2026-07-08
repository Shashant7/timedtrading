// worker/options-shadow.js
//
// Shadow-mode options plays: long call / long put only, attached to equity
// entry signals for calibration before broker execution. Labeled SHADOW in
// Discord/email so it is not confused with model equity guidance.
//
// Env:
//   OPTIONS_SHADOW_MODE=1           — enable shadow plays on entry alerts
//   OPTIONS_SHADOW_PROFILE=aggressive — risk profile for ladder (default aggressive)
//   OPTIONS_SHADOW_FETCH_CHAIN=1    — fetch live Alpaca chain when cache missing
//   OPTIONS_SHADOW_DELTA_FLEX=0.10  — ±delta band when matching chain legs
//   OPTIONS_SHADOW_DTE_FLEX_DAYS=7  — reserved for exp flex (logged, not enforced yet)
//   OPTIONS_ACCOUNT_VALUE           — sizing (shared with options-plays)

import {
  buildOptionsLadder,
  compactOptionsPlay,
  pickExpirationForProfile,
  PROFILE_META,
} from "./options-plays.js";
import { alpacaFetchOptionsChain } from "./alpaca-options.js";

const SHADOW_ARCHETYPES = Object.freeze({
  LONG: "long_call",
  SHORT: "long_put",
});

export function optionsShadowModeEnabled(env) {
  const v = env?.OPTIONS_SHADOW_MODE;
  if (v === "0" || v === "false" || v === "off") return false;
  return v === "1" || v === "true" || v === "on";
}

export function optionsShadowFetchChainEnabled(env) {
  const v = env?.OPTIONS_SHADOW_FETCH_CHAIN;
  if (v === "0" || v === "false" || v === "off") return false;
  // Default ON when shadow mode is enabled — calibration needs real quotes.
  if (v == null || v === "") return true;
  return v === "1" || v === "true" || v === "on";
}

export function shadowProfileFromEnv(env) {
  const p = String(env?.OPTIONS_SHADOW_PROFILE || "aggressive").toLowerCase();
  return PROFILE_META[p] ? p : "aggressive";
}

export function shadowDeltaFlex(env) {
  const n = Number(env?.OPTIONS_SHADOW_DELTA_FLEX);
  return Number.isFinite(n) && n >= 0 && n <= 0.35 ? n : 0.10;
}

/**
 * Suggest a limit price for a debit option buy given bid/ask/mid.
 * Wide spreads (≥15% of mid): anchor at bid + 25% of spread instead of mid.
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

function enrichCompactWithShadowMeta(compact, rawPlay, meta = {}) {
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
    shadow_desk: meta.desk || compact.mode || "trader",
    pricing_source: meta.pricing_source || (meta.chain ? "alpaca_chain" : "bs_estimate"),
    actual_delta: rawPlay?.actual_delta ?? null,
    target_delta: rawPlay?.target_delta ?? null,
    limit_guidance: limit,
    dte: rawPlay?.expiration?.dte ?? null,
  };
}

/**
 * Build a shadow options play (long call or long put only).
 * Async when chain fetch is enabled.
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
}) {
  if (!optionsShadowModeEnabled(env)) return null;
  try {
    const p = Number(price);
    if (!(p > 0)) return null;
    const dir = String(direction || "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
    const isInvestor = String(mode || "").toLowerCase() === "investor";
    if (isInvestor && dir === "SHORT") return null;

    const atrPct = Number(
      tickerData?.atr_pct
        ?? tickerData?.atrPct
        ?? tickerData?.tf_tech?.D?.atr_pct
        ?? 0.025,
    );
    const tp1 = Number.isFinite(Number(tp)) ? Number(tp) : (dir === "LONG" ? p * 1.05 : p * 0.95);
    const sl1 = Number.isFinite(Number(sl)) ? Number(sl) : (dir === "LONG" ? p * 0.97 : p * 1.03);

    // Shadow plays always use trader-style single-leg sizing (no LEAP primary).
    const contract = {
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
    };

    const profile = shadowProfileFromEnv(env);
    const confluence = tickerData?.confluence || tickerData?._confluence || null;
    let chain = tickerData?.options_chain || tickerData?._options_chain || null;
    let pricingSource = chain ? "cached_chain" : "bs_estimate";

    if (!chain && optionsShadowFetchChainEnabled(env) && env) {
      const exp = pickExpirationForProfile(contract, profile);
      const chainRes = await alpacaFetchOptionsChain(env, ticker, exp?.iso || null, {
        strikeRangePct: 0.25,
      });
      if (chainRes?.ok) {
        chain = chainRes;
        pricingSource = "alpaca_chain";
      }
    }

    const ladder = buildOptionsLadder(contract, {
      profile,
      chain,
      confluence,
      themes: contract.themes,
      account_value: Number(env?.OPTIONS_ACCOUNT_VALUE) || undefined,
      targetDelta: confluence?.mode === "RIDE" && profile === "speculator" ? 0.70 : undefined,
    });
    const rawPlay = pickShadowPlayFromLadder(ladder, dir);
    if (!rawPlay) return null;

    const compact = compactOptionsPlay(rawPlay, {
      ticker,
      mode: isInvestor ? "investor" : "trader",
    });
    return enrichCompactWithShadowMeta(compact, rawPlay, {
      desk: isInvestor ? "investor" : "trader",
      pricing_source: pricingSource,
      chain: !!chain,
    });
  } catch (e) {
    try {
      console.warn(`[OPTIONS_SHADOW] build failed for ${ticker}: ${String(e?.message || e).slice(0, 200)}`);
    } catch (_) { /* ignore */ }
    return null;
  }
}

/**
 * Discord embed field for a shadow options play.
 */
export function shadowOptionsPlayDiscordField(compact) {
  if (!compact || !compact.shadow || !Array.isArray(compact.lines) || compact.lines.length === 0) {
    return null;
  }
  const deskLabel = String(compact.shadow_desk || compact.mode || "trader").toLowerCase() === "investor"
    ? "Investor"
    : "Trader";
  const dollar = (n) => (n == null ? null : `$${Math.abs(Math.round(n)).toLocaleString()}`);
  const signedDollar = (n) => (n == null ? null : `${n >= 0 ? "+" : "-"}$${Math.abs(Math.round(n)).toLocaleString()}`);

  let value = `**${compact.headline}**\n` + compact.lines.map((l) => `• ${l}`).join("\n");

  const lg = compact.limit_guidance;
  if (lg && lg.mid != null) {
    const spreadLine = lg.spread_pct != null
      ? `Bid $${lg.bid?.toFixed(2) ?? "?"} · Ask $${lg.ask?.toFixed(2) ?? "?"} · Spread ${lg.spread_pct}%`
      : `Mid $${lg.mid.toFixed(2)}`;
    const limitLine = lg.suggested_limit != null
      ? `Suggested LMT: **$${lg.suggested_limit.toFixed(2)}**${lg.wide_spread ? " (wide spread — do not market)" : ""}`
      : null;
    value += `\n\n**Limit order guidance**\n• ${spreadLine}`;
    if (limitLine) value += `\n• ${limitLine}`;
    value += `\n• Pricing: ${compact.pricing_source || "estimate"}`;
  }

  const liveExitParts = [];
  if (compact.est_at_tp?.total_pl_usd != null) {
    liveExitParts.push(`If TP hit (~${compact.est_at_tp.hold_days}d): est. P&L ${signedDollar(compact.est_at_tp.total_pl_usd)}`);
  }
  if (compact.est_at_sl?.total_pl_usd != null) {
    liveExitParts.push(`If SL hit (~${compact.est_at_sl.hold_days}d): est. P&L ${signedDollar(compact.est_at_sl.total_pl_usd)}`);
  }
  if (liveExitParts.length) {
    value += `\n\n**Exit projections (shadow)**\n` + liveExitParts.map((l) => `• ${l}`).join("\n");
  }

  const metrics = [];
  if (compact.net_cost_usd != null) {
    const sign = compact.net_side === "credit" ? "+" : "–";
    metrics.push(`Net ${compact.net_side}: ${sign}${dollar(compact.net_cost_usd)}`);
  }
  if (compact.breakeven != null) metrics.push(`Breakeven: $${compact.breakeven.toFixed(2)}`);
  if (compact.actual_delta != null) metrics.push(`Δ ${(Math.abs(compact.actual_delta) * 100).toFixed(0)}%`);
  if (metrics.length) value += `\n\n${metrics.join(" · ")}`;

  value += `\n\n_Mode: SHADOW — advisory only; no orders placed. For calibration before live options routing._`;

  if (value.length > 1024) value = value.slice(0, 1020).trimEnd() + "…";

  return {
    name: `🔬 Options Play (SHADOW · ${deskLabel})`,
    value,
    inline: false,
  };
}

/**
 * Email HTML block for shadow plays (reuses structure, adds SHADOW banner).
 */
export function shadowOptionsPlayEmailHtml(compact) {
  if (!compact || !compact.shadow) return null;
  const _esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const legsHtml = (compact.lines || []).map((l) =>
    `<li style="margin:0 0 4px;color:rgba(255,255,255,0.85);font-size:12px;font-family:Menlo,Monaco,monospace">${_esc(l)}</li>`,
  ).join("");
  const lg = compact.limit_guidance;
  const limitHtml = lg?.mid != null
    ? `<div style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:12px">Limit: suggested <strong style="color:white">$${lg.suggested_limit?.toFixed(2) ?? lg.mid.toFixed(2)}</strong>${lg.spread_pct != null ? ` · spread ${lg.spread_pct}%` : ""}</div>`
    : "";
  return `
    <div style="margin:0 0 4px;padding:4px 8px;display:inline-block;border:1px solid rgba(168,162,158,0.4);color:rgba(168,162,158,0.95);font-size:10px;letter-spacing:0.1em;text-transform:uppercase">SHADOW — advisory only</div>
    <div style="margin:0 0 6px;color:white;font-size:13px;font-weight:600">${_esc(compact.headline)}</div>
    <ul style="margin:0;padding:0 0 0 18px;list-style:none">${legsHtml}</ul>
    ${limitHtml}
  `;
}

export function shadowPlayToSignalMeta(compact, meta = {}) {
  return {
    ...meta,
    desk: "shadow",
    signal_id: meta.signal_id || `shadow:opt:${meta.ref_id || compact?.ticker || "x"}:${meta.published_at || Date.now()}`,
  };
}
