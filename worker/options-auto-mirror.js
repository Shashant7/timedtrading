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

import { buildOptionsLadder, contractToLadderInput, shouldIndexAutoMirror } from "./options-plays.js";
import { trimSellQty } from "./option-day-trade-plan.js";
import { scoreRootConfluence } from "./root-strategy.js";
import { getThemesForTicker } from "./sector-mapping.js";
import { bridgeResponseIsOk } from "./broker-bridge-client.js";
import {
  DEFAULT_DAILY_LOSS_LIMIT_USD,
  dailyLossLimitFor,
  riskBudgetHasRoom,
  commitRisk,
  releaseRisk,
  settleRisk,
  optionDebitUsd,
} from "./options-risk-budget.js";

const PREF_KEY = (userEmail) => `timed:options:auto-mirror:${String(userEmail || "").toLowerCase()}`;
const DAILY_COUNTER_KEY = (userEmail, date) => `timed:options:auto-mirror:count:${String(userEmail || "").toLowerCase()}:${date}`;
// 2026-06-01 — per-vehicle daily counter so each vehicle's daily_cap is
// enforced independently. The legacy global counter is still bumped for
// the operator dashboard total; both keys live side-by-side.
const DAILY_VEHICLE_COUNTER_KEY = (userEmail, vehicle, date) =>
  `timed:options:auto-mirror:count:${String(userEmail || "").toLowerCase()}:${String(vehicle || "any").toLowerCase()}:${date}`;

// 2026-06-01 — Per-vehicle toggle structure (§1.5 of the trade-aware
// mirror sync design doc).
//
// Each vehicle is INDEPENDENTLY toggleable from Mission Control so the
// operator can roll out one strategy at a time. ALL OPTION ARCHETYPES
// DEFAULT TO OFF. Only equity_long is on by default — it's the lowest-
// risk vehicle (well-understood, defined max-loss = entry-to-SL) and is
// also the closest analog to what the model already simulates.
//
// Per-vehicle caps are tuned for a small-account starter ($5-10k):
//   • equity_long:     $300 per order, 3/day  → ~$900/day theoretical max
//   • long_call:       $200 per order, 2/day  → ~$400/day at risk
//   • long_put:        $200 per order, 2/day  → ~$400/day at risk
//   • vertical_spread: $200 per order, 2/day  → max loss capped by spread width
//   • leaps:           $500 per order, 1/day  → biggest single ticket, but defined loss
//   • straddle:        $300 per order, 1/day  → both legs, max loss is the debit
//   • moonshot:        $100 per order, 1/day  → smallest ticket, gamma play
//
// Naked-short vehicles (short_call, short_put without long-leg cover,
// straddle on the short side, short combos) are NOT listed and CANNOT
// be enabled here. See `NAKED_SHORT_ARCHETYPES` below — the engine
// short-circuits before this prefs map is even consulted.
// long_call / long_put also cover the SPY/QQQ/IWM index day-trade product.
// A single ATM 0-1 DTE index contract routinely costs $1.00-$2.50 = $100-$250,
// so a $75 max-loss cap (calibrated for cheap multi-lot equity options) silently
// blocks essentially every index day-trade at the single-contract floor. Size
// the directional-option defaults for one index contract; the sizer downsizes
// multi-lot paper plays to fit and never exceeds max_per_order_usd.
const VEHICLE_DEFAULTS = {
  equity_long:     { enabled: true,  daily_cap: 3, max_per_order_usd: 300 },
  long_call:       { enabled: false, daily_cap: 2, max_per_order_usd: 300, max_loss_per_order_usd: 250 },
  long_put:        { enabled: false, daily_cap: 2, max_per_order_usd: 300, max_loss_per_order_usd: 250 },
  vertical_spread: { enabled: false, daily_cap: 2, max_per_order_usd: 200, max_loss_per_order_usd: 75 },
  leaps:           { enabled: false, daily_cap: 1, max_per_order_usd: 500, max_loss_per_order_usd: 500 },
  straddle:        { enabled: false, daily_cap: 1, max_per_order_usd: 300, max_loss_per_order_usd: 200 },
  moonshot:        { enabled: false, daily_cap: 1, max_per_order_usd: 100, max_loss_per_order_usd: 100 },
  // Convexity tickets (earnings-prep / gamma lottos). Off until the ticket
  // report card earns it; see worker/convexity-mirror.js.
  lotto:           { enabled: false, daily_cap: 1, max_per_order_usd: 250, max_loss_per_order_usd: 250 },
  index_trend_letf: { enabled: false, daily_cap: 2, max_per_order_usd: 2000 },
};

// "Small account" defaults — exactly what's above. The button in
// Mission Control writes this set as a one-click reset.
export const SMALL_ACCOUNT_VEHICLE_DEFAULTS = JSON.parse(JSON.stringify(VEHICLE_DEFAULTS));

// 2026-06-01 — Hard deferral of naked-short option structures.
//
// "Naked short" = any structure whose worst-case loss is unbounded or
// requires the broker's margin / portfolio-margin allocation to cover.
// Per the operator's explicit decision: "Let's defer supporting naked
// shorts for now, it's dangerous." (sync-design §1, deferred section).
//
// This list is the SHORT-CIRCUIT: the engine rejects any decideAutoMirror
// call whose primary play's archetype is in this set BEFORE checking
// per-vehicle toggles. Naked-short archetypes CANNOT be enabled via
// prefs — adding "short_call: { enabled: true }" to the user's prefs is
// a no-op because the reject happens before we read the prefs.vehicles map.
//
// To re-introduce a vehicle from this set later: remove it from this set,
// add it to VEHICLE_DEFAULTS with `enabled: false`, and wire it into the
// per-vehicle MC UI. Document the risk review in tasks/lessons.md.
export const NAKED_SHORT_ARCHETYPES = new Set([
  "short_call",          // naked call — unbounded upside loss
  "short_put",           // cash-secured-put without cash backing is naked
  "iron_condor_naked",   // condor without long wings = two naked legs
  "short_straddle",
  "short_strangle",
  "short_combo",         // covered_call's short leg is fine because long stock covers
  "covered_call_naked",  // covered_call with no long stock = naked call
]);

const DEFAULT_PREFS = {
  enabled: false,                // master switch
  vehicles: VEHICLE_DEFAULTS,    // per-vehicle toggles + caps
  modes_allowed: ["RIDE"],       // only auto-mirror highest-conviction
  require_st_freshness: ["fresh", "in_motion"], // skip mature ST
  ticker_blocklist: [],
  ticker_allowlist: null,        // null = all; array = only these tickers eligible
  // Legacy fields kept for back-compat with the pre-vehicles schema.
  // Read by maybeAutoMirror as a fallback if a vehicle row is missing.
  // Operators should migrate to the `vehicles` map.
  archetypes_allowed: ["long_call", "long_put", "vertical_spread"],
  daily_cap: 5,
  max_notional_per_order_usd: 5000,
  max_loss_per_order_usd: 2000,
  // Default OFF — keep mirrored index day-trades at 1 lot until the
  // 1-contract flow is proven live. When true, BUY follows the paper
  // book's light/medium/heavy size (1 / 2 / 3), still capped by the
  // vehicle notional.
  index_dt_follow_paper_size: false,
  // Single-lot floor for index day-trades. A contract is the minimum
  // tradeable unit and its debit is the fully-defined max loss. When the
  // sizer cannot fit even one contract inside the (small-account) max-loss
  // throttle, still place ONE lot as long as it stays within the hard
  // max_per_order_usd notional ceiling — otherwise the mirror silently
  // misses every index play whose single ATM contract costs more than the
  // throttle. Set false to require the max-loss cap to be met exactly.
  index_dt_min_one_lot: true,
  // 2026-09-23 — the single limit that governs the index day-trade lane.
  // Count caps there are gone: they capped ACTIVITY, not loss, and two
  // never-filled orders could spend a whole day's allowance in 74 seconds.
  // For a long option the debit is the entire downside, so this is a real
  // dollar stop for the day. 0 = no limit at all. See options-risk-budget.js.
  daily_loss_limit_usd: DEFAULT_DAILY_LOSS_LIMIT_USD,
};

/**
 * Map a strategy archetype to its vehicle key. Most archetypes map 1:1
 * to the vehicle prefs slot, but a few collapse (moonshot_call +
 * moonshot_put → "moonshot"; leap_call + leap_put → "leaps"; etc.).
 *
 * Returns the matching prefs key, or null when the archetype is
 * unrecognized (caller should treat as "not auto-mirrorable").
 */
export function archetypeToVehicleKey(archetype) {
  const a = String(archetype || "").toLowerCase();
  if (!a) return null;
  if (NAKED_SHORT_ARCHETYPES.has(a)) return null; // deferred — never mirror
  if (a === "stock_long")                  return "equity_long";
  if (a === "leap_call" || a === "leap_put") return "leaps";
  if (a === "moonshot_call" || a === "moonshot_put") return "moonshot";
  if (a === "lotto_call" || a === "lotto_put") return "lotto";
  if (a === "long_call")                   return "long_call";
  if (a === "long_put")                    return "long_put";
  if (a === "day_trade_call")              return "long_call";
  if (a === "day_trade_put")               return "long_put";
  if (a === "vertical_spread")             return "vertical_spread";
  if (a === "long_straddle" || a === "long_strangle") return "straddle";
  if (a === "index_trend_letf") return "index_trend_letf";
  return null;
}

/**
 * Merge a (possibly partial) user prefs object onto VEHICLE_DEFAULTS so
 * the runtime can rely on every vehicle row being present. Operator
 * may save a sparse prefs object (e.g. only the rows they've toggled);
 * we always inflate to the full shape on load.
 */
function _hydrateVehicles(userVehicles) {
  const out = {};
  for (const [key, def] of Object.entries(VEHICLE_DEFAULTS)) {
    out[key] = { ...def, ...(userVehicles?.[key] || {}) };
  }
  return out;
}

/**
 * Load operator's auto-mirror preferences. Always returns the full
 * shape with every vehicle row inflated (so callers can rely on
 * prefs.vehicles[k].enabled being defined for every k).
 */
export async function loadAutoMirrorPrefs(env, userEmail) {
  if (!userEmail) return { ...DEFAULT_PREFS, vehicles: _hydrateVehicles({}) };
  try {
    const raw = await env.KV_TIMED.get(PREF_KEY(userEmail));
    if (!raw) return { ...DEFAULT_PREFS, vehicles: _hydrateVehicles({}) };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      vehicles: _hydrateVehicles(parsed?.vehicles),
    };
  } catch (_) {
    return { ...DEFAULT_PREFS, vehicles: _hydrateVehicles({}) };
  }
}

/**
 * Save operator's auto-mirror preferences. We strip any naked-short
 * vehicle keys the caller might try to slip in (defense-in-depth — the
 * MC UI doesn't expose them but the API surface should refuse them
 * anyway). Always persists the full inflated shape so future reads
 * don't need to merge against DEFAULT_PREFS.
 */
export async function saveAutoMirrorPrefs(env, userEmail, prefs) {
  const incoming = prefs || {};
  // Strip any naked-short vehicle keys (defense in depth — the UI
  // never sends them, but a hand-crafted API call shouldn't bypass
  // the deferral either).
  const sanitizedVehicles = {};
  for (const [k, v] of Object.entries(incoming.vehicles || {})) {
    if (NAKED_SHORT_ARCHETYPES.has(k)) continue;
    if (!Object.prototype.hasOwnProperty.call(VEHICLE_DEFAULTS, k)) continue;
    sanitizedVehicles[k] = v;
  }
  const merged = {
    ...DEFAULT_PREFS,
    ...incoming,
    vehicles: _hydrateVehicles(sanitizedVehicles),
  };
  await env.KV_TIMED.put(PREF_KEY(userEmail), JSON.stringify(merged));
  return merged;
}

/**
 * Decide whether a given Trader event should trigger an auto-mirror.
 * Returns { should_mirror, play?, reason, vehicle? }.
 *
 * Decision order (fail-fast):
 *   1. Master switch + context sanity
 *   2. Ticker blocklist / allowlist
 *   3. Confluence + mode + ST-freshness gates
 *   4. Ladder build → primary play
 *   5. NAKED-SHORT SHORT-CIRCUIT (cannot be overridden)
 *   6. Vehicle resolution (archetype → vehicle key)
 *   7. Per-vehicle enable check
 *   8. Per-vehicle notional + max-loss + daily-cap checks
 *
 * @param {object} ctx - { ticker, traderContract, tickerSnapshot }
 * @param {object} prefs - operator's auto-mirror preferences (use loadAutoMirrorPrefs)
 */
export function decideAutoMirror(ctx, prefs, profile = "speculator") {
  if (!prefs?.enabled) return { should_mirror: false, reason: "disabled" };
  if (!ctx?.ticker || !ctx?.traderContract) return { should_mirror: false, reason: "missing_context" };

  const sym = String(ctx.ticker).toUpperCase();
  if ((prefs.ticker_blocklist || []).map(s => String(s).toUpperCase()).includes(sym)) {
    return { should_mirror: false, reason: "ticker_blocklist" };
  }
  if (Array.isArray(prefs.ticker_allowlist) && prefs.ticker_allowlist.length > 0
      && !prefs.ticker_allowlist.map(s => String(s).toUpperCase()).includes(sym)) {
    return { should_mirror: false, reason: "ticker_not_in_allowlist" };
  }

  const confluence = scoreRootConfluence(ctx.tickerSnapshot || ctx.traderContract);
  if (!confluence) return { should_mirror: false, reason: "confluence_unavailable" };

  if (!(prefs.modes_allowed || []).includes(confluence.mode)) {
    return { should_mirror: false, reason: `mode_${confluence.mode}_not_allowed`, confluence };
  }

  const stFresh = confluence.supertrend_trigger?.freshness;
  if (stFresh && !(prefs.require_st_freshness || []).includes(stFresh)) {
    return { should_mirror: false, reason: `st_freshness_${stFresh}_not_allowed`, confluence };
  }

  // Build ladder + pick the primary play.
  const themes = (() => { try { return getThemesForTicker(sym); } catch (_) { return []; } })();
  const ladderInput = contractToLadderInput(ctx.traderContract, ctx.tickerSnapshot || {}, {
    ticker: sym,
    mode: ctx.traderContract.mode || "trader",
    pricesMap: ctx.pricesMap || null,
    marketOpen: ctx.marketOpen,
  });
  const ladder = buildOptionsLadder(ladderInput, { profile, confluence, themes });
  if (!ladder || !ladder.primary) return { should_mirror: false, reason: "no_primary_play", confluence };

  const primary = ladder.primary;
  const archetype = String(primary.archetype || "");

  // ── NAKED-SHORT SHORT-CIRCUIT ──────────────────────────────────────
  // Cannot be overridden by prefs. See NAKED_SHORT_ARCHETYPES above.
  if (NAKED_SHORT_ARCHETYPES.has(archetype)) {
    return {
      should_mirror: false,
      reason: `naked_short_archetype_deferred:${archetype}`,
      confluence, play: primary,
    };
  }

  // ── Per-vehicle gate ────────────────────────────────────────────────
  const vehicleKey = archetypeToVehicleKey(archetype);
  if (!vehicleKey) {
    return {
      should_mirror: false,
      reason: `archetype_${archetype}_has_no_vehicle_mapping`,
      confluence, play: primary,
    };
  }
  const vehicleRow = prefs.vehicles?.[vehicleKey];
  if (!vehicleRow) {
    return {
      should_mirror: false,
      reason: `vehicle_${vehicleKey}_not_in_prefs`,
      confluence, play: primary, vehicle: vehicleKey,
    };
  }
  if (!vehicleRow.enabled) {
    return {
      should_mirror: false,
      reason: `vehicle_${vehicleKey}_disabled`,
      confluence, play: primary, vehicle: vehicleKey,
    };
  }

  // ── Per-vehicle notional + max-loss gates ──────────────────────────
  const isEquity = vehicleKey === "equity_long";
  const notional = isEquity
    ? (Number(primary.legs?.[0]?.qty || 0) * Number(ladderInput.price || 0))
    : ((Number(primary.premium?.mid) || 0) * 100 * (Number(primary.contracts) || 1));
  if (notional > Number(vehicleRow.max_per_order_usd || 0)) {
    return {
      should_mirror: false,
      reason: `notional_${Math.round(notional)}_exceeds_vehicle_cap_${vehicleRow.max_per_order_usd}`,
      confluence, play: primary, vehicle: vehicleKey,
    };
  }
  const maxLossCap = Number(vehicleRow.max_loss_per_order_usd || 0);
  if (maxLossCap > 0 && Number(primary.max_loss_usd) > maxLossCap) {
    return {
      should_mirror: false,
      reason: `max_loss_${primary.max_loss_usd}_exceeds_vehicle_cap_${maxLossCap}`,
      confluence, play: primary, vehicle: vehicleKey,
    };
  }

  return {
    should_mirror: true,
    play: primary,
    confluence,
    notional_usd: Math.round(notional),
    vehicle: vehicleKey,
    vehicle_cap_per_order_usd: vehicleRow.max_per_order_usd,
    vehicle_daily_cap: vehicleRow.daily_cap,
  };
}

// The reserve-then-release helpers that used to live here
// (`checkAndBumpDailyCounter`, `checkAndBumpVehicleCounter`,
// `releaseDailyCounter`, `releaseVehicleCounter`) are DELETED, not kept for
// a caller that might come back. They bumped on intent and released on a
// non-place, so isolate death between the two ran neither branch and wedged
// `index_trend_letf` at 2/2 with zero orders placed — SPYU, TNA and UDOW
// each skipped `vehicle_daily_cap_2_reached` every five minutes for a full
// session. They also keyed the day off wall clock, ignoring the caller's
// `now`, so a reconcile and a cap check read different days. Use the
// read-only check plus commit-on-place below.

/**
 * Read-only cap check. Pair with `commitEntryCounters` AFTER the bridge
 * confirms a place.
 *
 * Reserve-then-release could not survive isolate death: a BUY bumped the
 * counter, `/bridge/order` never returned, and the release never ran. The
 * slot stayed consumed for the rest of the day. On 2026-09-14
 * `index_trend_letf` sat at 2/2 with ZERO orders placed and zero mirror
 * rows, so SPYU, TNA and UDOW each skipped `vehicle_daily_cap_2_reached`
 * every 5 minutes while the paper books ran on. A cap whose job is to
 * limit orders SENT must count orders that were actually sent; counting
 * intentions means a crash can wedge the lane shut.
 *
 * Trade-off: two entries dispatching concurrently can both pass this
 * check and exceed the cap by one. Per-signal dedup (`entry_already_
 * mirrored`) plus the heal lock keep that rare, and one extra sleeve is a
 * far smaller failure than a whole day of unmirrored signals.
 */
export async function entryCountersHaveRoom(env, userEmail, vehicle, { vehicleCap = 0, globalCap = 0, now = Date.now() } = {}) {
  const date = new Date(Number(now) || Date.now()).toISOString().slice(0, 10);
  const read = async (key) => Number(await env?.KV_TIMED?.get(key)) || 0;
  if (Number(vehicleCap) > 0) {
    const current = await read(DAILY_VEHICLE_COUNTER_KEY(userEmail, vehicle, date));
    if (current >= Number(vehicleCap)) {
      return {
        ok: false,
        skipped: true,
        reason: `vehicle_daily_cap_${vehicleCap}_reached_for_${vehicle}`,
        counter: { allowed: false, current, cap: Number(vehicleCap), vehicle },
      };
    }
  }
  if (Number(globalCap) > 0) {
    const current = await read(DAILY_COUNTER_KEY(userEmail, date));
    if (current >= Number(globalCap)) {
      return {
        ok: false,
        skipped: true,
        reason: `daily_cap_${globalCap}_reached`,
        counter: { allowed: false, current, cap: Number(globalCap) },
      };
    }
  }
  return { ok: true };
}

/** KV key for a vehicle's day counter — lets a lane reconcile its own value. */
export function vehicleCounterKeyFor(userEmail, vehicle, date = new Date().toISOString().slice(0, 10)) {
  return DAILY_VEHICLE_COUNTER_KEY(userEmail, vehicle, date);
}

async function bumpCounter(env, key) {
  if (!env?.KV_TIMED || !key) return 0;
  const current = Number(await env.KV_TIMED.get(key)) || 0;
  await env.KV_TIMED.put(key, String(current + 1), { expirationTtl: 86400 * 2 });
  return current + 1;
}

/** Count a CONFIRMED broker place against today's vehicle + global caps. */
export async function commitEntryCounters(env, userEmail, vehicle, { vehicleCap = 0, globalCap = 0, now = Date.now() } = {}) {
  const date = new Date(Number(now) || Date.now()).toISOString().slice(0, 10);
  const out = {};
  if (Number(vehicleCap) > 0) {
    out.vehicle = await bumpCounter(env, DAILY_VEHICLE_COUNTER_KEY(userEmail, vehicle, date));
  }
  if (Number(globalCap) > 0) {
    out.global = await bumpCounter(env, DAILY_COUNTER_KEY(userEmail, date));
  }
  return out;
}

/**
 * Give a slot back when an entry order ended WITHOUT becoming a position.
 *
 * This is not the reserve-then-release pattern deleted above, and the
 * difference is what makes it safe. That one bumped on INTENT and released on
 * a guess, so losing the release wedged the lane. This one bumps only on a
 * confirmed broker place and releases only on a second confirmed broker fact —
 * the order is cancelled, rejected, or gone. Losing the release leaves the
 * slot consumed, which is the restrictive direction: it can never hand out
 * more orders than the cap allows, only fewer.
 *
 * Floors at 0 so a double release cannot mint slots.
 */
export async function releaseEntryCounters(env, userEmail, vehicle, { vehicleCap = 0, globalCap = 0, now = Date.now() } = {}) {
  const date = new Date(Number(now) || Date.now()).toISOString().slice(0, 10);
  const drop = async (key) => {
    if (!env?.KV_TIMED || !key) return 0;
    const current = Number(await env.KV_TIMED.get(key)) || 0;
    const next = Math.max(0, current - 1);
    await env.KV_TIMED.put(key, String(next), { expirationTtl: 86400 * 2 });
    return next;
  };
  const out = {};
  if (Number(vehicleCap) > 0) {
    out.vehicle = await drop(DAILY_VEHICLE_COUNTER_KEY(userEmail, vehicle, date));
  }
  if (Number(globalCap) > 0) {
    out.global = await drop(DAILY_COUNTER_KEY(userEmail, date));
  }
  return out;
}

/** HTTP success alone is not an accepted broker order. */
export function optionsMirrorDispatchAccepted(fired) {
  return bridgeResponseIsOk(fired?.response, fired?.ok === true);
}

/**
 * Read per-vehicle counters for display (Mission Control "Today" column).
 * Returns a map of vehicle → count. Does not bump.
 */
export async function readVehicleCountersToday(env, userEmail) {
  const date = new Date().toISOString().slice(0, 10);
  const out = {};
  for (const vehicleKey of Object.keys(VEHICLE_DEFAULTS)) {
    try {
      const key = DAILY_VEHICLE_COUNTER_KEY(userEmail, vehicleKey, date);
      out[vehicleKey] = Number(await env.KV_TIMED.get(key)) || 0;
    } catch (_) {
      out[vehicleKey] = 0;
    }
  }
  return out;
}

/**
 * Fire the auto-mirror webhook to the broker bridge.
 *
 * Contract (must match worker-bridge/bridge-index.js
 * `requireWebhookSignature` + bridge-crypto.js `hmacVerify`):
 *   - header `x-bridge-signature`
 *   - BASE64-encoded HMAC-SHA256 over the raw body
 *   - main-worker secret name is BROKER_BRIDGE_HMAC_KEY (same value as
 *     the bridge's BRIDGE_INTERNAL_HMAC_KEY)
 *
 * The original implementation used the bridge-side env var name, a hex
 * digest, and a different header — every call 401'd at the bridge.
 */
async function signedBridgePost(env, userEmail, path, payload) {
  const bridgeUrl = (env.BROKER_BRIDGE_URL || env.BRIDGE_URL || "https://tt-broker-bridge.shashant.workers.dev").replace(/\/$/, "");
  const hmacKey = env.BROKER_BRIDGE_HMAC_KEY || env.BRIDGE_INTERNAL_HMAC_KEY;
  if (!hmacKey) return { ok: false, error: "missing_hmac_key" };
  const body = JSON.stringify({
    user_id: userEmail,
    ...payload,
    ts: Date.now(),
  });
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(hmacKey),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  let sigStr = "";
  const sigArr = new Uint8Array(sigBuf);
  for (let i = 0; i < sigArr.length; i++) sigStr += String.fromCharCode(sigArr[i]);
  const sig = btoa(sigStr);
  // 2026-07-21 — Prefer the BROKER_BRIDGE service binding to bypass
  // Cloudflare's worker-to-worker loop detection. A plain fetch to the
  // bridge's workers.dev URL trips CF error 1042 and comes back as HTTP 404,
  // so the options auto-mirror order silently never reaches the bridge —
  // the identical failure fixed in forwardOrderToBridge. Falls back to HTTP
  // fetch when the binding is absent (local dev).
  const svc = env?.BROKER_BRIDGE;
  const hasSvc = !!(svc && typeof svc.fetch === "function");
  const reqUrl = `${bridgeUrl}${path}`;
  const reqInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-signature": sig,
    },
    body,
  };
  const r = hasSvc
    ? await svc.fetch(new Request(reqUrl, reqInit))
    : await fetch(reqUrl, reqInit);
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, response: json, transport: hasSvc ? "service-binding" : "http" };
}

export async function fireAutoMirror(env, userEmail, payload) {
  return signedBridgePost(env, userEmail, "/bridge/options/order", payload);
}

export async function queryAutoMirrorOrderStatus(env, userEmail, { order_id, requested_qty } = {}) {
  return signedBridgePost(env, userEmail, "/bridge/options/order/status", {
    order_id,
    requested_qty,
  });
}

export async function cancelAutoMirrorOrder(env, userEmail, { order_id } = {}) {
  return signedBridgePost(env, userEmail, "/bridge/options/order/cancel", { order_id });
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

  const counterOk = await checkMirrorCounters(
    env,
    operatorEmail,
    prefs,
    decision.vehicle,
    prefs.vehicles?.[decision.vehicle] || { daily_cap: decision.vehicle_daily_cap },
  );
  if (!counterOk.ok) return counterOk;

  // Fire.
  const fired = await fireAutoMirror(env, operatorEmail, {
    trade_id: ctx.traderContract?.trade_id || ctx.traderContract?.tradeId || null,
    ticker: ctx.ticker,
    play: decision.play,
    vehicle: decision.vehicle,
    confluence_verdict: decision.confluence,
    source: "auto_mirror",
  });
  if (optionsMirrorDispatchAccepted(fired)) {
    const committed = await commitEntryCounters(env, operatorEmail, decision.vehicle, counterOk.caps);
    decision._vehicle_counter = committed.vehicle ?? null;
    decision._global_counter = committed.global ?? null;
  }

  return {
    skipped: false,
    fired,
    confluence_mode: decision.confluence?.mode,
    archetype: decision.play?.archetype,
    vehicle: decision.vehicle,
    notional_usd: decision.notional_usd,
    daily_counter: decision._global_counter || null,
    vehicle_counter: decision._vehicle_counter || null,
  };
}

/**
 * Index 0/1 DTE day-trade BUY → operator broker mirror.
 * Gated: master auto-mirror switch, per-vehicle long_call/long_put,
 * options_auto_mirror_indices flag, SPY/QQQ/IWM only.
 *
 * Stage 5b exits (TRIM / EXIT / STOP) use maybeAutoMirrorIndexDayTradeEvent.
 */
export async function maybeAutoMirrorIndexDayTrade(env, ctx = {}) {
  return maybeAutoMirrorIndexDayTradeEvent(env, { ...ctx, event: "BUY" });
}

export function indexDtMirrorKey(signalId) {
  return `timed:opt-dt-mirror:${String(signalId || "").trim()}`;
}

/** Standard US equity-option tick: $0.05 at/above $3, else $0.01. */
export function optionTick(premium) {
  return Number(premium) >= 3 ? 0.05 : 0.01;
}

/**
 * Close limit for a day-trade SELL.
 * TRIM stays at mid (passive). EXIT / STOP hit the live bid so the
 * flatten is marketable; if bid is missing or >60% below mid (stale),
 * price one tick under mid.
 */
export function marketableCloseLimit({ event, mid, bid, tick } = {}) {
  const ev = String(event || "").toUpperCase();
  const m = Number(mid);
  if (!(m > 0)) return null;
  const t = Number(tick) > 0 ? Number(tick) : optionTick(m);
  if (ev === "TRIM") return Math.round(m * 100) / 100;
  const b = Number(bid);
  const bidUsable = b > 0 && b >= m * 0.40;
  const raw = bidUsable ? b : Math.max(t, m - t);
  const px = Math.min(m, raw);
  return Math.round(Math.max(t, px) * 100) / 100;
}

export function extractMirrorFill(fired, requestedQty = 1) {
  const res = fired?.response || {};
  const fill = res.fill || res.broker_response?.fill || null;
  const placed = res.broker_response || null;
  const mock = !!(res.mock || res.dry_run || placed?.mock || fill?.mock);
  const requested = Math.max(1, Math.round(Number(requestedQty) || 1));
  if (mock) {
    return {
      status: "filled",
      filled_qty: requested,
      mock: true,
      order_id: fill?.order_id || res.order_id || placed?.response?.order_id || null,
    };
  }
  if (fill) {
    const qty = Number(fill.filled_qty);
    return {
      status: String(fill.status || (qty > 0 ? "filled" : "working")).toLowerCase(),
      filled_qty: Number.isFinite(qty) ? qty : null,
      order_id: fill.order_id || fill.broker_order_id || null,
    };
  }
  if (!optionsMirrorDispatchAccepted(fired)) {
    return {
      status: "rejected",
      filled_qty: 0,
      reason: res.reject_reason || res.reason || res.error || placed?.error || fired?.error || "rejected",
    };
  }
  // Place accepted, no fill echo (tests + Webull pitfall) — assume filled.
  return { status: "filled", filled_qty: requested, assumed: true };
}

export function reconcileIndexDtFill({ event, requestedQty, fill } = {}) {
  const status = String(fill?.status || "unknown").toLowerCase();
  const requested = Math.max(1, Math.round(Number(requestedQty) || 1));
  const qty = Number(fill?.filled_qty);
  if (status === "rejected" || status === "cancelled") {
    return { persist: false, pending: false, filledQty: 0, status, reason: `order_${status}` };
  }
  if (fill?.mock || fill?.assumed) {
    return { persist: true, pending: false, filledQty: requested, status: "filled" };
  }
  if (status === "working" || status === "unknown") {
    return {
      persist: false,
      pending: true,
      filledQty: 0,
      status: "working",
      order_id: fill?.order_id || null,
    };
  }
  if (status === "partial" && qty > 0) {
    return { persist: true, pending: qty < requested, filledQty: Math.round(qty), status: "partial" };
  }
  if (status === "filled") {
    return { persist: true, pending: false, filledQty: qty > 0 ? Math.round(qty) : requested, status: "filled" };
  }
  return { persist: false, pending: true, filledQty: 0, status };
}

export function resolveIndexDtEntryContracts({ prefs, play, book, size, vehicleRow } = {}) {
  const follow = prefs?.index_dt_follow_paper_size === true
    || vehicleRow?.follow_paper_size === true;
  if (!follow) return 1;
  const raw = Number(book?.contracts) || Number(size?.contracts) || Number(play?.contracts) || 1;
  let q = Math.max(1, Math.min(3, Math.round(raw)));
  const mid = Number(play?.premium?.mid) || 0;
  const cap = Number(vehicleRow?.max_per_order_usd) || 0;
  if (cap > 0 && mid > 0) {
    while (q > 1 && mid * 100 * q > cap) q -= 1;
  }
  return q;
}

/**
 * Adaptive index day-trade entry sizing.
 *
 * A long single-leg option's debit IS its max loss, so the effective
 * per-order dollar budget is the tighter of the notional cap
 * (max_per_order_usd) and the risk cap (max_loss_per_order_usd). Downsize
 * the desired lot count (1, or the paper book's 1-3 when follow_paper_size
 * is on) to the largest qty that fits that budget.
 *
 * When even one contract exceeds the (small-account) max-loss throttle, a
 * single lot is still placed as long as its debit stays within the hard
 * max_per_order_usd ceiling (index_dt_min_one_lot, default on) — this is
 * the resilience floor that stops the mirror from silently missing every
 * index day-trade whose ATM contract costs more than the throttle. If a
 * single lot cannot fit even the notional ceiling, the entry is skipped
 * with a precise, actionable reason.
 *
 * Pure. Returns { contracts, cost_per_contract_usd, budget_usd, fits,
 * over_max_loss, downsized, desired, reason }.
 */
export function planIndexDtEntrySizing({ prefs, vehicleRow, play, book, size, buyLimit } = {}) {
  const follow = prefs?.index_dt_follow_paper_size === true
    || vehicleRow?.follow_paper_size === true;
  const desired = follow
    ? Math.max(1, Math.min(3, Math.round(
        Number(book?.contracts) || Number(size?.contracts) || Number(play?.contracts) || 1,
      )))
    : 1;

  const mid = Number(buyLimit) > 0 ? Number(buyLimit) : (Number(play?.premium?.mid) || 0);
  const costPer = mid > 0 ? Math.round(mid * 100) : 0;
  const notionalCap = Number(vehicleRow?.max_per_order_usd) || 0;
  const maxLossCap = Number(vehicleRow?.max_loss_per_order_usd) || 0;

  // Missing premium — cannot reason about dollars; keep the desired size and
  // let the downstream notional guard catch anything absurd.
  if (!(costPer > 0)) {
    return {
      contracts: desired, cost_per_contract_usd: 0, budget_usd: null,
      fits: true, over_max_loss: false, downsized: false, desired, reason: null,
    };
  }

  const caps = [notionalCap, maxLossCap].filter((c) => c > 0);
  const budget = caps.length ? Math.min(...caps) : Infinity;
  let contracts = Math.min(desired, Math.max(0, Math.floor(budget / costPer)));
  let overMaxLoss = false;

  if (contracts < 1) {
    const allowSingle = prefs?.index_dt_min_one_lot !== false;
    const notionalOk = notionalCap <= 0 || costPer <= notionalCap;
    if (allowSingle && notionalOk) {
      contracts = 1;
      overMaxLoss = maxLossCap > 0 && costPer > maxLossCap;
    } else {
      const reason = notionalCap > 0 && costPer > notionalCap
        ? `index_dt_one_lot_notional_${costPer}_over_max_per_order_${notionalCap}`
        : `index_dt_one_lot_max_loss_${costPer}_over_cap_${maxLossCap || Math.round(budget) || 0}`;
      return {
        contracts: 0, cost_per_contract_usd: costPer,
        budget_usd: Number.isFinite(budget) ? budget : null,
        fits: false, over_max_loss: true, downsized: false, desired, reason,
      };
    }
  }

  return {
    contracts,
    cost_per_contract_usd: costPer,
    budget_usd: Number.isFinite(budget) ? budget : null,
    fits: true,
    over_max_loss: overMaxLoss,
    downsized: contracts < desired,
    desired,
    reason: null,
  };
}

/** Human-readable note describing an adaptive-sizing outcome, or null. */
export function describeIndexDtSizingNote(sizing) {
  if (!sizing) return null;
  const bits = [];
  if (sizing.downsized && sizing.desired > sizing.contracts) {
    bits.push(`downsized ${sizing.desired}\u2192${sizing.contracts} lot to fit $${sizing.budget_usd} budget`);
  }
  if (sizing.over_max_loss && sizing.cost_per_contract_usd > 0) {
    bits.push(`1 lot debit $${sizing.cost_per_contract_usd} above the max-loss cap, within the per-order limit`);
  }
  return bits.length ? bits.join(" \u00b7 ") : null;
}

export function scaleIndexDtEntryPlay(play, { contracts, limit } = {}) {
  if (!play) return play;
  const q = Math.max(1, Math.round(Number(contracts) || 1));
  const mid = Number(limit) > 0 ? Number(limit) : (Number(play.premium?.mid) || 0);
  const px = mid > 0 ? Math.round(mid * 100) / 100 : null;
  return {
    ...play,
    contracts: q,
    max_loss_usd: px != null ? Math.round(px * 100 * q) : play.max_loss_usd,
    premium: { ...(play.premium || {}), mid: px ?? play.premium?.mid },
    legs: (play.legs || []).map((leg) => ({
      ...leg,
      qty: q,
      premium_mid: px ?? leg.premium_mid,
      leg_cost_usd: px != null ? Math.round(px * 100 * q) : leg.leg_cost_usd,
    })),
  };
}

async function pollFillIfNeeded(env, operatorEmail, fill, requestedQty) {
  if (!fill || fill.status !== "working" || !fill.order_id) return fill;
  try {
    const polled = await queryAutoMirrorOrderStatus(env, operatorEmail, {
      order_id: fill.order_id,
      requested_qty: requestedQty,
    });
    const next = polled?.response?.fill;
    if (!next) return fill;
    return {
      ...fill,
      status: String(next.status || fill.status).toLowerCase(),
      filled_qty: next.filled_qty ?? fill.filled_qty,
      order_id: next.order_id || fill.order_id,
      mock: !!(next.mock || fill.mock),
      polled: true,
    };
  } catch {
    return fill;
  }
}

/**
 * Build a single-leg SELL play for broker close / trim mirror.
 */
export function buildIndexDayTradeClosePlay(play, {
  ticker,
  strike,
  expiration,
  flavor,
  qty,
  limitPrice,
  event,
  signalId,
} = {}) {
  const sym = String(ticker || play?.ticker || "").toUpperCase();
  const leg = play?.legs?.[0];
  if (!sym || !leg) return null;
  const flav = String(flavor || play._day_trade_flavor || "").toLowerCase();
  const isPut = flav === "put";
  const K = Number(strike) || Number(play.strikes?.primary) || Number(leg.strike);
  const exp = expiration?.iso || leg.expiration || play.expiration?.iso;
  const q = Math.max(1, Math.round(Number(qty) || 1));
  const limit = Number(limitPrice);
  if (!(K > 0) || !exp || !(limit > 0)) return null;
  const optType = isPut ? "PUT" : "CALL";
  const closePlay = {
    archetype: play.archetype || (isPut ? "day_trade_put" : "day_trade_call"),
    label: `Close ${sym} ${K}${isPut ? "P" : "C"} (${String(event || "EXIT").toUpperCase()})`,
    ticker: sym,
    trade_id: signalId || null,
    legs: [{
      action: "SELL",
      optionType: optType,
      strike: K,
      expiration: exp,
      qty: q,
      premium_mid: Math.round(limit * 100) / 100,
      side_label: "credit",
    }],
    strikes: { primary: K },
    expiration: expiration || play.expiration,
    premium: { mid: Math.round(limit * 100) / 100 },
    contracts: q,
    max_loss_usd: Math.round(limit * 100 * q),
    _day_trade_close: true,
    _close_event: String(event || "EXIT").toLowerCase(),
  };
  return closePlay;
}

export function computeIndexDayTradeCloseQty(event, book) {
  const ev = String(event || "").toUpperCase();
  if (ev === "TRIM") {
    const trimQty = Number(book?.trim_sell_qty);
    if (Number.isFinite(trimQty) && trimQty > 0) return Math.round(trimQty);
    return trimSellQty(book?.contracts);
  }
  const remain = Number(book?.contracts_remaining);
  if (Number.isFinite(remain) && remain > 0) return Math.round(remain);
  const all = Number(book?.contracts);
  return Number.isFinite(all) && all > 0 ? Math.round(all) : 1;
}

async function loadIndexDtMirror(env, signalId) {
  if (!env?.KV_TIMED || !signalId) return null;
  try {
    const raw = await env.KV_TIMED.get(indexDtMirrorKey(signalId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function saveIndexDtMirror(env, signalId, patch) {
  if (!env?.KV_TIMED || !signalId) return;
  const prev = await loadIndexDtMirror(env, signalId) || {};
  const merged = { ...prev, ...patch, signal_id: signalId, ts: Date.now() };
  // Mirror the pending flag into KV metadata. `list` returns metadata for
  // free, so the sweep can find the handful of unfilled orders without a
  // GET per mirror — three days of signals is ~100 keys and the sweep runs
  // every pass.
  const pendingEntry = !!(merged.entry_pending && !merged.entry_fired && merged.entry_order_id);
  await env.KV_TIMED.put(indexDtMirrorKey(signalId), JSON.stringify(merged), {
    expirationTtl: 3 * 86400,
    metadata: { pe: pendingEntry ? 1 : 0 },
  });
}

// A 0/1 DTE entry limit that has not filled in this long is stale. The setup
// that justified the price is gone, the lane re-evaluates every ~5 minutes, so
// two missed passes is the signal. Leaving it working is not the neutral
// choice: it holds a daily-cap slot AND it can still fill hours later into a
// thesis the model has already abandoned.
export const PENDING_ENTRY_STALE_MS = 10 * 60 * 1000;

/**
 * What a pending entry consumed. New mirrors record `entry_caps` at place
 * time, which is the honest answer — the caps in force when the slot was
 * taken. Mirrors written before that field existed have to fall back to the
 * caps in force NOW, because the alternative is releasing nothing and leaving
 * the lane wedged on the exact orders this was written to unwedge.
 */
async function entryCapsForMirror(env, operatorEmail, mirror, vehicle) {
  if (mirror?.entry_caps && (mirror.entry_caps.vehicleCap || mirror.entry_caps.globalCap)) {
    return mirror.entry_caps;
  }
  try {
    const prefs = await loadAutoMirrorPrefs(env, operatorEmail);
    return mirrorCapsFor(prefs, prefs?.vehicles?.[vehicle]);
  } catch (_) {
    return {};
  }
}

/**
 * Decide what a pending (placed, unfilled) entry order IS now, and make the
 * broker and the counters agree with the answer.
 *
 * 2026-09-23 — before this, the only thing that ever re-read a pending entry
 * was a close event arriving for the SAME signal id. When the paper book
 * closed a signal whose entry had not filled, the close was skipped with
 * `entry_fill_pending` and nothing looked at the order again: the mirror sat
 * on `working` forever, the broker kept a live buy, and the daily-cap slot it
 * had consumed was never returned. Two such orders at 13:46 and 13:47 used up
 * the whole 2/day `long_put` budget and blocked the next nine entries.
 *
 * Returns { outcome, mirror } with outcome one of:
 *   not_pending | filled | gone | cancelled | working
 */
export async function resolvePendingIndexDtEntry(env, operatorEmail, signalId, mirror, {
  cancelIfWorking = false,
  now = Date.now(),
  staleMs = PENDING_ENTRY_STALE_MS,
  deps = {},
} = {}) {
  const poll = deps.pollFill || pollFillIfNeeded;
  const cancel = deps.cancelOrder || cancelAutoMirrorOrder;
  if (!mirror?.entry_pending || mirror.entry_fired || !mirror.entry_order_id) {
    return { outcome: "not_pending", mirror };
  }

  const qty = Number(mirror.contracts) || 1;
  const orderId = mirror.entry_order_id;
  const vehicle = mirror.vehicle || (mirror.flavor === "call" ? "long_call" : "long_put");
  const caps = deps.caps || await entryCapsForMirror(env, operatorEmail, mirror, vehicle);

  const markFilled = async (rec) => {
    const patch = {
      entry_fired: true,
      entry_pending: false,
      contracts: rec.filledQty,
      contracts_remaining: rec.filledQty,
      entry_fill_status: rec.status,
    };
    await saveIndexDtMirror(env, signalId, patch);
    return { outcome: "filled", mirror: { ...mirror, ...patch } };
  };

  // Clearing state and releasing the slot must happen together — a cleared
  // mirror with a consumed slot is exactly the wedge this function exists to
  // undo.
  //
  // The re-read is the idempotency guard. A close event and the per-pass
  // sweep can reach the same order at once, and both would see `working`,
  // both would cancel, and both would release — handing out a slot the cap
  // never authorised. Whoever clears `entry_pending` first owns the release.
  const markGone = async (outcome, status) => {
    const fresh = await loadIndexDtMirror(env, signalId);
    const stillOurs = fresh?.entry_pending !== false;
    const patch = { entry_placed: false, entry_pending: false, entry_fired: false, entry_fill_status: status };
    await saveIndexDtMirror(env, signalId, patch);
    if (stillOurs) {
      try { await releaseEntryCounters(env, operatorEmail, vehicle, { ...caps, now }); } catch (_) { /* slot stays consumed — fails restrictive */ }
    }
    // Nothing was ever owned, so there is no P&L — the money simply comes
    // back. Keyed by signal id, so replaying this is a no-op.
    try { await releaseRisk(env, operatorEmail, signalId, { now }); } catch (_) { /* budget stays consumed — fails restrictive */ }
    return { outcome, mirror: { ...mirror, ...patch } };
  };

  const polled = await poll(env, operatorEmail, { status: "working", order_id: orderId }, qty);
  const rec = reconcileIndexDtFill({ event: "BUY", requestedQty: qty, fill: polled });
  if (rec.persist) return markFilled(rec);
  if (rec.status === "rejected" || rec.status === "cancelled") return markGone("gone", rec.status);

  const placedAt = Number(mirror.entry_placed_at) || Number(mirror.ts) || 0;
  const stale = placedAt > 0 && (now - placedAt) >= staleMs;
  if (!cancelIfWorking && !stale) return { outcome: "working", mirror };

  const res = await cancel(env, operatorEmail, { order_id: orderId });
  if (res?.ok && res?.response?.cancelled !== false) return markGone("cancelled", "cancelled");

  // The cancel lost a race with a fill, or the broker refused. Either way the
  // order may now be a real position, so re-read it before deciding. Never
  // release a slot on a failed cancel.
  const after = await poll(env, operatorEmail, { status: "working", order_id: orderId }, qty);
  const recAfter = reconcileIndexDtFill({ event: "BUY", requestedQty: qty, fill: after });
  if (recAfter.persist) return markFilled(recAfter);
  if (recAfter.status === "rejected" || recAfter.status === "cancelled") return markGone("gone", recAfter.status);
  return { outcome: "working", mirror };
}

/**
 * Resolve every pending entry, independent of whether the paper book still
 * has anything to say about it. This is the half that makes the lane
 * self-healing: the per-signal path below only runs when a close event
 * arrives, and the signal whose entry never filled is precisely the one that
 * stops producing events.
 */
export async function sweepPendingIndexDtEntries(env, operatorEmail, {
  now = Date.now(), staleMs = PENDING_ENTRY_STALE_MS, maxPages = 4, maxResolve = 10,
} = {}) {
  if (!env?.KV_TIMED || !operatorEmail) return { checked: 0, resolved: [], fresh: 0, youngestMs: Infinity };
  // `indexDtMirrorKey("")` is `timed:opt-dt-mirror:` with the colon, which
  // does NOT match the hyphenated decision-log key `timed:opt-dt-mirror-log`.
  const prefix = indexDtMirrorKey("");

  // Candidates come from list metadata where it exists. Mirrors written
  // before the metadata was added have none, so an absent flag means
  // "unknown, go read it" rather than "not pending".
  const candidates = [];
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    let listed;
    try {
      listed = await env.KV_TIMED.list({ prefix, limit: 1000, cursor });
    } catch (_) {
      break;
    }
    for (const k of listed?.keys || []) {
      if (k?.metadata && Object.prototype.hasOwnProperty.call(k.metadata, "pe") && !k.metadata.pe) continue;
      const signalId = String(k?.name || "").slice(prefix.length);
      if (signalId) candidates.push(signalId);
    }
    if (listed?.list_complete !== false || !listed?.cursor) break;
    cursor = listed.cursor;
  }

  const resolved = [];
  let checked = 0;
  let fresh = 0;
  let youngestMs = Infinity;
  for (const signalId of candidates) {
    if (checked >= maxResolve) break;
    const mirror = await loadIndexDtMirror(env, signalId);
    if (!mirror?.entry_pending || mirror.entry_fired || !mirror.entry_order_id) continue;
    checked++;
    // "Fresh" = young enough that a normal fill is still plausible. Only
    // those are worth sub-minute polling; an order past the stale window is
    // getting cancelled, and re-asking every few seconds will not change
    // that. The loop below uses this to decide whether to keep spinning.
    const placedAt = Number(mirror.entry_placed_at) || Number(mirror.ts) || 0;
    if (placedAt > 0 && (now - placedAt) < staleMs) fresh++;
    if (placedAt > 0) youngestMs = Math.min(youngestMs, Math.max(0, now - placedAt));
    try {
      const r = await resolvePendingIndexDtEntry(env, operatorEmail, signalId, mirror, { now, staleMs });
      if (r.outcome !== "working") resolved.push({ signal_id: signalId, outcome: r.outcome });
    } catch (e) {
      resolved.push({ signal_id: signalId, outcome: `error:${String(e?.message || e).slice(0, 60)}` });
    }
  }
  return { checked, resolved, fresh, youngestMs };
}

/** Per-isolate guard so two cron ticks cannot run overlapping loops. */
let _dtReconcileLoopBusy = false;

// Two cadences, because the two situations are different. A marketable
// limit either fills within seconds or it is not going to, so the first
// minute of an order's life is worth asking about constantly. After that a
// fill is a price event that could land at any time, and catching it within
// fifteen seconds is plenty — while asking every five would triple the load
// on a broker LIST endpoint for the rest of the order's life. Getting
// rate-limited would stop reconciliation altogether, which is the failure
// this whole lane exists to prevent.
export const DT_RECONCILE_FAST_TICK_MS = 5000;
export const DT_RECONCILE_SLOW_TICK_MS = 15000;
export const DT_RECONCILE_FAST_WINDOW_MS = 60000;
export const DT_RECONCILE_BUDGET_MS = 50000;

/**
 * Reconcile pending day-trade entries CONTINUOUSLY, not once a minute.
 *
 * A day trade is the fastest-moving thing the model runs and a mirror that
 * disagrees with the broker is the most expensive way to be wrong: a 0/1
 * DTE contract that filled without the model noticing has no TRIM, no EXIT
 * and no stop — it just sits there until it expires. Cloudflare's cron
 * floor is one minute, so the tick itself keeps polling for the rest of the
 * minute rather than waiting for the next one.
 *
 * It costs nothing when there is nothing to do: with no pending entries the
 * first sweep is a single KV list and the loop returns immediately. It only
 * spins while an order is young enough to still fill normally, so it is
 * self-terminating — a stale order gets cancelled on the next pass and the
 * loop stops with it.
 */
export async function runPendingIndexDtReconcileLoop(env, operatorEmail, {
  fastTickMs = DT_RECONCILE_FAST_TICK_MS,
  slowTickMs = DT_RECONCILE_SLOW_TICK_MS,
  fastWindowMs = DT_RECONCILE_FAST_WINDOW_MS,
  budgetMs = DT_RECONCILE_BUDGET_MS,
  staleMs = PENDING_ENTRY_STALE_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  clock = () => Date.now(),
} = {}) {
  if (!env?.KV_TIMED || !operatorEmail) return { passes: 0, watched: 0, resolved: [], reason: "not_configured" };
  if (_dtReconcileLoopBusy) return { passes: 0, watched: 0, resolved: [], reason: "already_running" };
  _dtReconcileLoopBusy = true;
  const started = clock();
  const resolved = [];
  let passes = 0;
  let watched = 0;
  try {
    for (;;) {
      passes++;
      const r = await sweepPendingIndexDtEntries(env, operatorEmail, { now: clock(), staleMs });
      if (r.resolved?.length) resolved.push(...r.resolved);
      watched = Math.max(watched, r.checked || 0);
      // Nothing pending, or nothing that could still fill in the next few
      // seconds. Either way another poll now buys nothing.
      if (!r.checked || !r.fresh) return { passes, watched, resolved, reason: "settled" };
      const tickMs = r.youngestMs < fastWindowMs ? fastTickMs : slowTickMs;
      if ((clock() - started) + tickMs >= budgetMs) {
        return { passes, watched, resolved, reason: "budget_exhausted" };
      }
      await sleep(tickMs);
    }
  } finally {
    _dtReconcileLoopBusy = false;
  }
}

/**
 * Move a closed portion of a mirrored day trade from "open risk" to
 * "realised P&L" in the daily loss budget.
 *
 * The entry debit per contract is the cost basis. Anything still held stays
 * on the books at that basis, so a partial trim does not release risk it is
 * still carrying.
 *
 * A mirror written before `entry_premium` existed has no basis to work
 * from. Releasing the whole commitment there would understate the day's
 * loss, so it is left open instead and expires with the key at end of day —
 * restrictive, like every other fallback in this lane.
 */
async function settleIndexDtRisk(env, operatorEmail, signalId, mirror, { closedQty, closePremium, remainingQty }) {
  const basis = Number(mirror?.entry_premium) || 0;
  if (!(basis > 0)) return null;
  const sold = Math.max(0, Math.round(Number(closedQty) || 0));
  const out = Number(closePremium) || 0;
  const realizedUsd = (out - basis) * 100 * sold;
  const remainingRiskUsd = optionDebitUsd(basis, remainingQty);
  try {
    return await settleRisk(env, operatorEmail, signalId, { realizedUsd, remainingRiskUsd });
  } catch (_) {
    return null; // budget stays as-is — fails restrictive
  }
}

async function gateIndexDayTradeMirror(env, ctx = {}) {
  const operatorEmail = env.ADMIN_EMAIL;
  if (!operatorEmail) return { ok: false, skipped: true, reason: "no_operator_email" };

  const ticker = String(ctx?.ticker || "").toUpperCase();
  const play = ctx?.play;
  if (!ticker || !play) return { ok: false, skipped: true, reason: "missing_context" };

  const archetype = String(play.archetype || "").toLowerCase()
    || (String(play._day_trade_flavor || "").toLowerCase() === "put" ? "day_trade_put" : "day_trade_call");

  const flagOn = ctx.indicesFlagOn === true;
  const indexGate = shouldIndexAutoMirror({
    ticker,
    archetype,
    tier: ctx.tier || "gamma",
    scorecardTierWinRate: ctx.scorecardTierWinRate ?? null,
    flagOn,
  });
  if (!indexGate.should_mirror) {
    return { ok: false, skipped: true, reason: indexGate.reason || "index_gate_blocked" };
  }

  const prefs = await loadAutoMirrorPrefs(env, operatorEmail);
  if (!prefs.enabled) return { ok: false, skipped: true, reason: "disabled" };

  const vehicleKey = archetypeToVehicleKey(archetype);
  if (!vehicleKey) return { ok: false, skipped: true, reason: `archetype_${archetype}_no_vehicle` };

  const vehicleRow = prefs.vehicles?.[vehicleKey];
  if (!vehicleRow?.enabled) {
    return { ok: false, skipped: true, reason: `vehicle_${vehicleKey}_disabled`, vehicle: vehicleKey };
  }

  return {
    ok: true,
    operatorEmail,
    ticker,
    play,
    archetype,
    prefs,
    vehicleKey,
    vehicleRow,
  };
}

function mirrorCapsFor(prefs, vehicleRow) {
  return {
    vehicleCap: Number(vehicleRow?.daily_cap || 0),
    globalCap: Number(prefs?.daily_cap) || 0,
  };
}

/**
 * Read-only cap gate. The commit happens once the broker accepts, so a
 * crash between dispatch and bookkeeping cannot consume a slot — this
 * lane shares the GLOBAL counter with index_trend, so a leak here wedges
 * that lane too.
 */
async function checkMirrorCounters(env, operatorEmail, prefs, vehicleKey, vehicleRow) {
  const caps = mirrorCapsFor(prefs, vehicleRow);
  const room = await entryCountersHaveRoom(env, operatorEmail, vehicleKey, caps);
  return room.ok ? { ok: true, caps } : { ...room, caps };
}

/**
 * Stage 5b — index day-trade lifecycle mirror (BUY / TRIM / EXIT / STOP).
 * PROTECT is paper-only (stop raised, no broker order).
 *
 * Safety invariants:
 *   - Daily caps gate ENTRIES ONLY. A close is risk-reducing — it must
 *     never be blocked by a cap or the broker is left holding a position
 *     the model already exited. Counters bump AFTER all entry checks
 *     pass, immediately before the entry fires.
 *   - Close qty is capped by the MIRRORED remaining qty (what the broker
 *     actually holds), never the paper book's contracts — the paper book
 *     can be 2-3 lots while the mirrored entry bought 1.
 *   - Entry dedup via mirror state: one mirrored BUY per signal id even
 *     if the paper book is lost and the BUY event re-fires.
 */
// 2026-08-25 — Index DT mirror decision log. Every BUY/TRIM/EXIT/STOP the
// model produces records whether it was mirrored and, if not, WHY — so the
// Broker Connections timeline can explain a "NOT MIRRORED" options row
// (auto-mirror off, vehicle disabled, globally paused, exit with no mirrored
// entry, …) the same way equity skips already do, instead of a mystery pill.
export const OPT_DT_MIRROR_LOG_KEY = "timed:opt-dt-mirror-log";
const OPT_DT_MIRROR_LOG_MAX = 120;

/**
 * Derive the operator-facing outcome from a mirror result. A skip is not the
 * only "did not reach the broker" case: a fire can reject, stay working, or
 * throw. Collapsing everything to mirrored/skipped left rejected/pending/error
 * outcomes as a bare "NOT MIRRORED" with no reason on the timeline.
 *
 * Returns { decision, reason, note, contracts } where decision ∈
 * { mirrored, placed, pending, rejected, skipped, error }.
 */
export function deriveMirrorDecision(result = {}) {
  const sizingNote = describeIndexDtSizingNote(result?.sizing);
  const contracts = Number.isFinite(Number(result?.contracts))
    ? Number(result.contracts)
    : (Number.isFinite(Number(result?.close_qty)) ? Number(result.close_qty) : null);

  if (result?.error) {
    return { decision: "error", reason: `mirror_error:${String(result.error).slice(0, 120)}`, note: sizingNote, contracts };
  }
  if (result?.skipped === true) {
    return { decision: "skipped", reason: result?.reason || "skipped", note: sizingNote, contracts };
  }

  // skipped === false → an order was attempted. Read the real fill outcome.
  const rec = result?.reconcile || {};
  const fill = result?.fill || {};
  const status = String(rec.status || fill.status || "").toLowerCase();
  if (fill.mock || fill.assumed || status === "filled" || rec.persist === true) {
    return { decision: "mirrored", reason: null, note: sizingNote, contracts };
  }
  if (rec.pending === true || status === "working" || status === "unknown") {
    return { decision: "pending", reason: "order_working", note: sizingNote, contracts };
  }
  if (status === "rejected" || status === "cancelled" || rec.persist === false) {
    return {
      decision: "rejected",
      reason: fill.reason || result?.reason || `order_${status || "rejected"}`,
      note: sizingNote,
      contracts,
    };
  }
  return { decision: "placed", reason: null, note: sizingNote, contracts };
}

export async function recordIndexDtMirrorDecision(env, ctx = {}, result = {}) {
  if (!env?.KV_TIMED) return;
  const signalId = String(ctx?.signal_id || "").trim();
  const event = String(ctx?.event || "BUY").toUpperCase();
  if (!signalId || event === "PROTECT") return;
  const { decision, reason, note, contracts } = deriveMirrorDecision(result);
  const entry = {
    signal_id: signalId,
    ticker: String(ctx?.ticker || "").toUpperCase(),
    event,
    side: event === "BUY" ? "buy" : "sell",
    decision,
    reason: decision === "mirrored" ? null : (reason || null),
    note: note || null,
    contracts: contracts != null ? contracts : null,
    ts: Date.now(),
  };
  try {
    const raw = await env.KV_TIMED.get(OPT_DT_MIRROR_LOG_KEY);
    let ring = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(ring)) ring = [];
    // One entry per (signal, event) — keep the latest decision.
    ring = ring.filter((r) => !(String(r?.signal_id) === signalId
      && String(r?.event).toUpperCase() === event));
    ring.push(entry);
    if (ring.length > OPT_DT_MIRROR_LOG_MAX) ring = ring.slice(-OPT_DT_MIRROR_LOG_MAX);
    await env.KV_TIMED.put(OPT_DT_MIRROR_LOG_KEY, JSON.stringify(ring), { expirationTtl: 3 * 86400 });
  } catch (_) { /* telemetry only — never block a mirror on it */ }
}

export async function maybeAutoMirrorIndexDayTradeEvent(env, ctx = {}) {
  let result;
  try {
    result = await runIndexDayTradeMirror(env, ctx);
  } catch (err) {
    // An exception in the gate / fire must still record a decision — otherwise
    // the timeline shows a bare "NOT MIRRORED" with no reason. Surface it.
    result = { skipped: true, error: String(err?.message || err).slice(0, 160), reason: "mirror_error" };
  }
  try { await recordIndexDtMirrorDecision(env, ctx, result); } catch (_) { /* best-effort */ }
  return result;
}

async function runIndexDayTradeMirror(env, ctx = {}) {
  const event = String(ctx.event || "BUY").toUpperCase();
  if (event === "PROTECT") return { skipped: true, reason: "protect_no_broker_action" };

  const gate = await gateIndexDayTradeMirror(env, ctx);
  if (!gate.ok) return gate;

  const {
    operatorEmail, ticker, play, archetype, prefs, vehicleKey, vehicleRow,
  } = gate;
  const signalId = String(ctx.signal_id || "").trim();

  if (event === "BUY") {
    if (signalId) {
      const existing = await loadIndexDtMirror(env, signalId);
      if (existing?.entry_fired || existing?.entry_placed) {
        return { skipped: true, reason: "entry_already_mirrored" };
      }
    }

    const buyLimit = ctx.execution?.premium_band?.display_buy_ceil
      ?? ctx.execution?.premium_band?.buy_ceil
      ?? null;
    // Adaptive sizing: downsize to fit both the notional and the max-loss
    // budget; keep a single-lot floor bounded by the hard notional ceiling.
    const sizing = planIndexDtEntrySizing({
      prefs,
      vehicleRow,
      play,
      book: ctx.book,
      size: ctx.size || ctx.book?.size || ctx.execution?.size,
      buyLimit,
    });
    if (!sizing.fits) {
      return { skipped: true, reason: sizing.reason, vehicle: vehicleKey, sizing };
    }
    const entryContracts = sizing.contracts;
    const entryPlay = scaleIndexDtEntryPlay(play, { contracts: entryContracts, limit: buyLimit });
    // Final hard guard — a single lot must never breach the notional ceiling.
    const notional = (Number(entryPlay.premium?.mid) || 0) * 100 * entryContracts;
    const notionalCap = Number(vehicleRow.max_per_order_usd || 0);
    if (notionalCap > 0 && notional > notionalCap) {
      return {
        skipped: true,
        reason: `notional_${Math.round(notional)}_exceeds_vehicle_cap_${notionalCap}`,
        vehicle: vehicleKey,
        sizing,
      };
    }

    // 2026-09-23 — ONE limit governs this lane, and it is measured in
    // dollars. The count caps are gone: "2 per day" capped activity, not
    // loss, and on 2026-09-23 two limit orders that never filled spent the
    // entire allowance 74 seconds after the open. For a long option the
    // debit is the whole downside, so the budget is a real stop for the day.
    //
    // Risk is priced at the limit we are willing to PAY, not the mid — the
    // budget must never be flattered by a price we might not get.
    const entryRiskUsd = optionDebitUsd(
      buyLimit ?? entryPlay.premium?.mid ?? play.premium?.mid,
      entryContracts,
    );
    const lossLimitUsd = dailyLossLimitFor(prefs);
    const budgetOk = await riskBudgetHasRoom(env, operatorEmail, {
      riskUsd: entryRiskUsd,
      limitUsd: lossLimitUsd,
    });
    if (!budgetOk.ok) return { ...budgetOk, vehicle: vehicleKey, risk_usd: entryRiskUsd };

    // Counters still move so the operator dashboard keeps its per-vehicle
    // and per-day totals, but nothing reads them as a gate any more.
    const counterOk = await checkMirrorCounters(env, operatorEmail, prefs, vehicleKey, vehicleRow);

    const fired = await fireAutoMirror(env, operatorEmail, {
      trade_id: signalId || null,
      ticker,
      play: entryPlay,
      vehicle: vehicleKey,
      confluence_verdict: ctx.confluence || null,
      source: "auto_mirror_index_dt",
      lifecycle: "entry",
      side: "buy",
      execution_action: ctx.execution?.action || null,
      buy_limit: buyLimit,
    });

    let fill = extractMirrorFill(fired, entryContracts);
    fill = await pollFillIfNeeded(env, operatorEmail, fill, entryContracts);
    const rec = reconcileIndexDtFill({ event: "BUY", requestedQty: entryContracts, fill });
    // A working limit still occupies the broker, so it counts like a fill.
    if (rec.persist || rec.pending) {
      await commitEntryCounters(env, operatorEmail, vehicleKey, counterOk.caps);
      // Charge the budget the moment the broker has the order. A working
      // limit is real exposure: it can fill at any second, and until it is
      // resolved the money behind it is not available to anything else.
      if (signalId) {
        await commitRisk(env, operatorEmail, signalId, {
          usd: entryRiskUsd, vehicle: vehicleKey, ticker,
        });
      }
    }

    // Per-contract debit, so a later close can work out what was actually
    // lost or made instead of assuming the whole ticket went to zero.
    const entryPremium = Number(buyLimit ?? entryPlay.premium?.mid) || 0;

    if (signalId && rec.persist) {
      await saveIndexDtMirror(env, signalId, {
        entry_fired: true,
        entry_placed: true,
        ticker,
        contracts: rec.filledQty,
        contracts_remaining: rec.filledQty,
        strike: ctx.strike ?? play.strikes?.primary,
        flavor: play._day_trade_flavor,
        entry_order_id: fill.order_id || null,
        entry_fill_status: rec.status,
        entry_premium: entryPremium,
        entry_risk_usd: entryRiskUsd,
        vehicle: vehicleKey,
      });
    } else if (signalId && rec.pending) {
      await saveIndexDtMirror(env, signalId, {
        entry_fired: false,
        entry_placed: true,
        entry_pending: true,
        ticker,
        contracts: entryContracts,
        contracts_remaining: 0,
        strike: ctx.strike ?? play.strikes?.primary,
        flavor: play._day_trade_flavor,
        entry_order_id: fill.order_id || rec.order_id || null,
        entry_fill_status: rec.status,
        entry_premium: entryPremium,
        entry_risk_usd: entryRiskUsd,
        // What this order consumed, so whatever resolves it later can give
        // the slot back without having to re-derive the prefs it was sized
        // against. `entry_placed_at` is the staleness clock — `ts` moves on
        // every save, so it cannot answer "how long has this been working".
        entry_placed_at: Date.now(),
        vehicle: vehicleKey,
        entry_caps: counterOk.caps || null,
      });
    }

    return {
      skipped: false, fired, fill, reconcile: rec,
      vehicle: vehicleKey, archetype, event, contracts: rec.filledQty || entryContracts,
      sizing,
    };
  }

  // ── Stage 5b closes (TRIM / EXIT / STOP) — marketable limit sells.
  // NEVER cap-gated: closing risk must not be blocked by a daily counter.
  if (!signalId) return { skipped: true, reason: "no_signal_id" };

  let mirror = await loadIndexDtMirror(env, signalId);

  if (mirror?.entry_pending && !mirror.entry_fired && mirror.entry_order_id) {
    // EXIT and STOP are the model abandoning the thesis. A buy that is still
    // working at that moment must not survive it — on a 0/1 DTE contract it
    // can fill hours later with nothing left to manage it. TRIM is not
    // terminal, so it only lets a stale order age out.
    const terminal = event === "EXIT" || event === "STOP";
    const r = await resolvePendingIndexDtEntry(env, operatorEmail, signalId, mirror, {
      cancelIfWorking: terminal,
    });
    if (r.outcome === "filled") {
      mirror = r.mirror;
    } else if (r.outcome === "cancelled") {
      return { skipped: true, reason: "entry_order_cancelled_unfilled" };
    } else if (r.outcome === "gone") {
      return { skipped: true, reason: "entry_fill_rejected" };
    } else {
      return { skipped: true, reason: "entry_fill_pending" };
    }
  }

  if (!mirror?.entry_fired) return { skipped: true, reason: "no_mirrored_entry" };

  if (event === "TRIM" && mirror.trim_fired) return { skipped: true, reason: "trim_already_mirrored" };
  if ((event === "EXIT" || event === "STOP") && mirror.exit_fired) {
    return { skipped: true, reason: "exit_already_mirrored" };
  }

  // A still-working close must not stack a second SELL. Poll; retry only if rejected.
  const pendingKey = event === "TRIM" ? "trim" : "exit";
  if (mirror[`${pendingKey}_pending`] && mirror[`${pendingKey}_order_id`]) {
    const polled = await pollFillIfNeeded(env, operatorEmail, {
      status: "working", order_id: mirror[`${pendingKey}_order_id`],
    }, Number(mirror[`${pendingKey}_qty`]) || 1);
    const rec = reconcileIndexDtFill({
      event, requestedQty: Number(mirror[`${pendingKey}_qty`]) || 1, fill: polled,
    });
    if (rec.persist) {
      const remainingAfter = Math.max(0, (Number(mirror.contracts_remaining) || 0) - rec.filledQty);
      const patch = event === "TRIM"
        ? { trim_fired: true, trim_pending: false, trim_qty: rec.filledQty, contracts_remaining: remainingAfter }
        : { exit_fired: true, exit_pending: false, exit_qty: rec.filledQty, contracts_remaining: remainingAfter };
      await saveIndexDtMirror(env, signalId, patch);
      await settleIndexDtRisk(env, operatorEmail, signalId, mirror, {
        closedQty: rec.filledQty,
        closePremium: Number(mirror[`${pendingKey}_premium`]) || 0,
        remainingQty: remainingAfter,
      });
      return { skipped: true, reason: `${pendingKey}_fill_confirmed`, reconcile: rec };
    }
    if (rec.pending) return { skipped: true, reason: `${pendingKey}_still_working` };
    // rejected — fall through and replace the working order
  }

  // Broker-side remaining qty — what the mirrored entry actually bought,
  // minus any mirrored trim. The paper book may hold more contracts than
  // the mirror; selling the paper qty would oversell into a naked short.
  const mirroredTotal = Number(mirror.contracts) || 1;
  const mirroredRemaining = Number.isFinite(Number(mirror.contracts_remaining))
    ? Math.max(0, Math.round(Number(mirror.contracts_remaining)))
    : Math.max(0, mirroredTotal - (Number(mirror.trim_qty) || 0));
  if (mirroredRemaining <= 0) {
    return { skipped: true, reason: "mirror_position_already_flat" };
  }

  const book = ctx.book || {};
  const paperQty = computeIndexDayTradeCloseQty(event, book);
  // TRIM sells the smaller of the paper trim qty and the mirrored trim qty;
  // EXIT / STOP always flattens the full mirrored remainder.
  const qty = event === "TRIM"
    ? Math.min(Math.max(1, trimSellQty(mirroredTotal)), Math.max(1, paperQty), mirroredRemaining)
    : mirroredRemaining;
  const mid = Number(ctx.premium);
  const bid = Number(ctx.bid ?? ctx.execution?.premium_band?.bid ?? play?.premium?.bid ?? play?.legs?.[0]?.premium_bid);
  const limitPrice = marketableCloseLimit({ event, mid, bid });
  if (!(limitPrice > 0)) return { skipped: true, reason: "no_close_limit" };

  // A 1-lot mirror cannot partial-trim — skip the broker trim and let the
  // model's EXIT/STOP flatten it (paper PROTECT already moved the stop).
  if (event === "TRIM" && mirroredRemaining <= 1 && mirroredTotal <= 1) {
    return { skipped: true, reason: "mirror_single_lot_no_trim" };
  }

  const closePlay = buildIndexDayTradeClosePlay(play, {
    ticker,
    strike: ctx.strike ?? book.strike ?? play.strikes?.primary,
    expiration: ctx.expiration ?? book.expiration ?? play.expiration,
    flavor: ctx.flavor ?? book.flavor ?? play._day_trade_flavor,
    qty,
    limitPrice,
    event,
    signalId,
  });
  if (!closePlay) return { skipped: true, reason: "close_play_build_failed" };

  const lifecycle = event === "TRIM" ? "reduce" : "close";
  const fired = await fireAutoMirror(env, operatorEmail, {
    trade_id: signalId,
    ticker,
    play: closePlay,
    vehicle: vehicleKey,
    source: "auto_mirror_index_dt_close",
    lifecycle,
    side: event === "TRIM" ? "trim" : "exit",
    close_event: event,
    close_reason: ctx.reason || null,
    close_qty: qty,
    limit_price: limitPrice,
  });

  let fill = extractMirrorFill(fired, qty);
  fill = await pollFillIfNeeded(env, operatorEmail, fill, qty);
  const rec = reconcileIndexDtFill({ event, requestedQty: qty, fill });

  if (rec.persist) {
    const remainingAfter = Math.max(0, mirroredRemaining - rec.filledQty);
    const patch = event === "TRIM"
      ? { trim_fired: true, trim_pending: false, trim_qty: rec.filledQty, trim_premium: limitPrice, contracts_remaining: remainingAfter }
      : { exit_fired: true, exit_pending: false, exit_qty: rec.filledQty, exit_premium: limitPrice, exit_event: event, contracts_remaining: remainingAfter };
    await saveIndexDtMirror(env, signalId, patch);
    // The contracts just sold stop being open risk and become realised P&L;
    // whatever is still held stays open at its original debit. A win gives
    // the day its allowance back, a loss keeps consuming it — which is what
    // makes this a stop-loss rather than a trade counter.
    await settleIndexDtRisk(env, operatorEmail, signalId, mirror, {
      closedQty: rec.filledQty, closePremium: limitPrice, remainingQty: remainingAfter,
    });
  } else if (rec.pending) {
    const patch = event === "TRIM"
      ? { trim_pending: true, trim_qty: qty, trim_order_id: fill.order_id || rec.order_id || null, trim_premium: limitPrice }
      : { exit_pending: true, exit_qty: qty, exit_order_id: fill.order_id || rec.order_id || null, exit_premium: limitPrice, exit_event: event };
    await saveIndexDtMirror(env, signalId, patch);
  }

  return {
    skipped: false, fired, fill, reconcile: rec,
    vehicle: vehicleKey, archetype, event, close_qty: rec.filledQty || qty, limit_price: limitPrice,
  };
}
