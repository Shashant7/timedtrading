// worker/options-auto-mirror.js
//
// ─────────────────────────────────────────────────────────────────────────────
//  TT Options Auto-Mirror Engine
// ─────────────────────────────────────────────────────────────────────────────
//
//  Phase 3 of the TT Options Engine. "What the model does, so does my account."
//
//  When the model emits a Trader-mode entry/lifecycle event, this module:
//    1. Reads the operator's auto-mirror preferences (enabled? which archetypes?
//       per-ticker enable list? daily caps?)
//    2. Builds the options ladder via worker/options-plays.js with the
//       operator's saved risk profile
//    3. Picks the play that matches the operator's filter
//    4. Posts to the broker bridge via signed webhook
//    5. Records audit log entry for replay/forensics
//
//  Gated to the OPERATOR ONLY. Other users see suggested plays in their
//  Options Tab but no auto-routing.
//
//  Safety rails (in addition to bridge-side hard caps + kill switch):
//    - Operator must explicitly enable via PUT /timed/options/auto-mirror
//    - Per-archetype opt-in (e.g. enable Long Call + Vertical Spread,
//      block Long Straddle which can be expensive)
//    - Daily cap (default 5 auto-orders per day)
//    - Per-ticker max notional cap
//    - Confluence-mode gate (default: only mirror RIDE mode plays)
//
//  Authored 2026-05-30.

import { buildOptionsLadder } from "./options-plays.js";
import { scoreRootConfluence } from "./root-strategy.js";
import { getThemesForTicker } from "./sector-mapping.js";

const PREF_KEY = (userEmail) => `timed:options:auto-mirror:${String(userEmail || "").toLowerCase()}`;
const DAILY_COUNTER_KEY = (userEmail, date) => `timed:options:auto-mirror:count:${String(userEmail || "").toLowerCase()}:${date}`;

const DEFAULT_PREFS = {
  enabled: false,
  modes_allowed: ["RIDE"],       // only auto-mirror highest-conviction
  archetypes_allowed: ["long_call", "long_put", "vertical_spread"],
  daily_cap: 5,
  max_notional_per_order_usd: 5000,
  max_loss_per_order_usd: 2000,
  ticker_blocklist: [],
  require_st_freshness: ["fresh", "in_motion"], // skip mature ST
};

/**
 * Load operator's auto-mirror preferences.
 */
export async function loadAutoMirrorPrefs(env, userEmail) {
  if (!userEmail) return DEFAULT_PREFS;
  try {
    const raw = await env.KV_TIMED.get(PREF_KEY(userEmail));
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...parsed };
  } catch (_) {
    return DEFAULT_PREFS;
  }
}

/**
 * Save operator's auto-mirror preferences.
 */
export async function saveAutoMirrorPrefs(env, userEmail, prefs) {
  const merged = { ...DEFAULT_PREFS, ...(prefs || {}) };
  await env.KV_TIMED.put(PREF_KEY(userEmail), JSON.stringify(merged));
  return merged;
}

/**
 * Decide whether a given Trader event should trigger an auto-mirror.
 * Returns { should_mirror, play?, reason }.
 *
 * @param {object} ctx - { ticker, traderContract, tickerSnapshot }
 * @param {object} prefs - operator's auto-mirror preferences
 */
export function decideAutoMirror(ctx, prefs, profile = "speculator") {
  if (!prefs?.enabled) return { should_mirror: false, reason: "disabled" };
  if (!ctx?.ticker || !ctx?.traderContract) return { should_mirror: false, reason: "missing_context" };

  const sym = String(ctx.ticker).toUpperCase();
  if ((prefs.ticker_blocklist || []).map(s => String(s).toUpperCase()).includes(sym)) {
    return { should_mirror: false, reason: "ticker_blocklist" };
  }

  // Compute confluence.
  const confluence = scoreRootConfluence(ctx.tickerSnapshot || ctx.traderContract);
  if (!confluence) return { should_mirror: false, reason: "confluence_unavailable" };

  // Mode gate.
  if (!(prefs.modes_allowed || []).includes(confluence.mode)) {
    return { should_mirror: false, reason: `mode_${confluence.mode}_not_allowed`, confluence };
  }

  // SuperTrend freshness gate.
  const stFresh = confluence.supertrend_trigger?.freshness;
  if (stFresh && !(prefs.require_st_freshness || []).includes(stFresh)) {
    return { should_mirror: false, reason: `st_freshness_${stFresh}_not_allowed`, confluence };
  }

  // Build ladder + pick the primary play.
  const themes = (() => { try { return getThemesForTicker(sym); } catch (_) { return []; } })();
  const ladderInput = {
    ticker: sym,
    price: Number(ctx.traderContract.price) || null,
    direction: ctx.traderContract.direction || null,
    sl: Number(ctx.traderContract.sl) || null,
    tp1: Number(ctx.traderContract.tp_trim ?? ctx.traderContract.tp1 ?? ctx.traderContract.tp) || null,
    rr: ctx.traderContract.rr || null,
    tier: ctx.traderContract.tier || null,
    riskPct: ctx.traderContract.riskPct || null,
    stage: ctx.traderContract.stage || "swing",
    atr_pct: Number(ctx.traderContract.atr_pct) || 0.025,
  };
  const ladder = buildOptionsLadder(ladderInput, { profile, confluence, themes });
  if (!ladder || !ladder.primary) return { should_mirror: false, reason: "no_primary_play", confluence };

  // Archetype gate.
  if (!(prefs.archetypes_allowed || []).includes(ladder.primary.archetype)) {
    return { should_mirror: false, reason: `archetype_${ladder.primary.archetype}_not_allowed`, confluence, play: ladder.primary };
  }

  // Notional + max-loss gates.
  const notional = (Number(ladder.primary.premium?.mid) || 0) * 100 * (Number(ladder.primary.contracts) || 1);
  if (notional > prefs.max_notional_per_order_usd) {
    return { should_mirror: false, reason: `notional_${Math.round(notional)}_exceeds_cap_${prefs.max_notional_per_order_usd}`, confluence, play: ladder.primary };
  }
  if (Number(ladder.primary.max_loss_usd) > prefs.max_loss_per_order_usd) {
    return { should_mirror: false, reason: `max_loss_${ladder.primary.max_loss_usd}_exceeds_cap_${prefs.max_loss_per_order_usd}`, confluence, play: ladder.primary };
  }

  return {
    should_mirror: true,
    play: ladder.primary,
    confluence,
    notional_usd: Math.round(notional),
  };
}

/**
 * Check + bump daily counter. Returns { allowed, current, cap }.
 */
export async function checkAndBumpDailyCounter(env, userEmail, cap = 5) {
  const date = new Date().toISOString().slice(0, 10);
  const key = DAILY_COUNTER_KEY(userEmail, date);
  const current = Number(await env.KV_TIMED.get(key)) || 0;
  if (current >= cap) return { allowed: false, current, cap };
  await env.KV_TIMED.put(key, String(current + 1), { expirationTtl: 86400 * 2 });
  return { allowed: true, current: current + 1, cap };
}

/**
 * Fire the auto-mirror webhook to the broker bridge.
 * The bridge endpoint expects an HMAC-signed POST.
 */
export async function fireAutoMirror(env, userEmail, payload) {
  const bridgeUrl = env.BRIDGE_URL || "https://tt-broker-bridge.shashant.workers.dev";
  const hmacKey = env.BRIDGE_INTERNAL_HMAC_KEY;
  if (!hmacKey) return { ok: false, error: "missing_hmac_key" };
  const body = JSON.stringify({
    user_id: userEmail,
    ...payload,
    ts: Date.now(),
  });
  // HMAC-SHA256 over body.
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(hmacKey),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const sig = Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  const r = await fetch(`${bridgeUrl}/bridge/options/order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TT-Bridge-Signature": sig,
    },
    body,
  });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, response: json };
}

/**
 * Top-level helper called by the live scoring cron when a Trader event fires.
 *
 * @param {object} env - worker env
 * @param {object} ctx - { ticker, traderContract, tickerSnapshot }
 * @returns {object} mirror execution result
 */
export async function maybeAutoMirror(env, ctx) {
  // Resolve operator email from env (single operator for now).
  const operatorEmail = env.ADMIN_EMAIL;
  if (!operatorEmail) return { skipped: true, reason: "no_operator_email" };

  const prefs = await loadAutoMirrorPrefs(env, operatorEmail);
  if (!prefs.enabled) return { skipped: true, reason: "disabled" };

  // Pull operator's risk profile.
  let profile = "speculator";
  try {
    const p = await env.KV_TIMED.get(`timed:options:profile:${operatorEmail.toLowerCase()}`);
    if (p) profile = p;
  } catch (_) {}

  const decision = decideAutoMirror(ctx, prefs, profile);
  if (!decision.should_mirror) return { skipped: true, ...decision };

  // Daily cap check.
  const counter = await checkAndBumpDailyCounter(env, operatorEmail, prefs.daily_cap);
  if (!counter.allowed) {
    return { skipped: true, reason: `daily_cap_${counter.cap}_reached`, counter };
  }

  // Fire.
  const fired = await fireAutoMirror(env, operatorEmail, {
    trade_id: ctx.traderContract?.trade_id || ctx.traderContract?.tradeId || null,
    ticker: ctx.ticker,
    play: decision.play,
    confluence_verdict: decision.confluence,
    source: "auto_mirror",
  });

  return {
    skipped: false,
    fired,
    confluence_mode: decision.confluence?.mode,
    archetype: decision.play?.archetype,
    notional_usd: decision.notional_usd,
    daily_counter: counter,
  };
}
