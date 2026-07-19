// worker/play-the-move.js
// ─────────────────────────────────────────────────────────────────────────────
//  C1 (2026-06-11) — Play the Move: the vehicle menu.
//
//  Pillar 2 of the product: "We show different ways to play the move."
//  For every qualified signal the engine generates a structured MENU of
//  expressions — pure shares, the options play, the leveraged ETF, a
//  covered-call income angle, the moonshot — each scored for suitability
//  with plain-language reasons, plus the engine's PICK.
//
//  Doctrine:
//   • Deterministic + explainable. No LLM. Suitability is a 0-100 score
//     whose components are listed as reasons.
//   • The engine still EXECUTES shares (simulation lane unchanged). The
//     pick and every rejected alternative are recorded in the Signal
//     Outcome Ledger as counterfactuals — so the data answers "would the
//     options play have beaten the shares play on this same signal?"
//     BEFORE any real multi-vehicle execution is wired.
//   • This is Pillar 3's foundation: BYOB later = filtering this same
//     menu by a user profile and routing to a broker adapter.
//
//  Pure module (the options play + confluence are inputs, built by the
//  caller). Pinned by worker/play-the-move.test.js.
// ─────────────────────────────────────────────────────────────────────────────

import { lookupLETF, shouldActivateMoonshot } from "./options-plays.js";

/** Canonical play vehicles the model may shoot (user-facing pref + scorecard). */
export const PLAY_VEHICLES = Object.freeze(["shares", "letf", "options"]);

export const PLAY_VEHICLE_LABELS = Object.freeze({
  shares: "Shares",
  letf: "Leveraged ETF",
  options: "Options",
});

export const DEFAULT_PLAY_PREFS = Object.freeze({
  // Model may choose any of the three. User prefs can narrow later (BYOB).
  allowed_vehicles: ["shares", "letf", "options"],
});

export function playVehicleLabel(vehicle) {
  const v = normalizePlayVehicle(vehicle) || String(vehicle || "").toLowerCase();
  return PLAY_VEHICLE_LABELS[v] || (v ? String(v) : null);
}

/** Pull model play from a trade row / signal snapshot (open or closed). */
export function extractModelPlayFromTrade(trade) {
  if (!trade) return null;
  if (trade._model_play || trade.model_play || trade.__model_play) {
    return trade._model_play || trade.model_play || trade.__model_play;
  }
  let snap = trade.signal_snapshot || trade.signal_snapshot_json || null;
  if (typeof snap === "string") {
    try { snap = JSON.parse(snap); } catch { snap = null; }
  }
  const menu = snap?.lineage?.vehicle_menu || snap?.vehicle_menu || null;
  const pick = menu?.pick || trade.vehicle_pick || null;
  if (!pick) return null;
  const playVehicle = normalizePlayVehicle(pick.play_vehicle || pick.vehicle);
  if (!playVehicle) return null;
  return {
    play_vehicle: playVehicle,
    menu_vehicle: pick.vehicle || playVehicle,
    label: pick.label || playVehicleLabel(playVehicle),
    suitability: pick.suitability ?? null,
    why: pick.why || null,
    letf_ticker: pick.letf_ticker || null,
    archetype: pick.archetype || null,
    expected_move_pct: menu?.expected_move_pct ?? null,
  };
}

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Map menu / archetype labels → shares | letf | options. */
export function normalizePlayVehicle(raw) {
  const v = String(raw || "").toLowerCase().trim();
  if (!v) return null;
  if (v === "shares" || v === "equity" || v === "equity_long" || v === "stock") return "shares";
  if (v === "letf" || v === "leveraged_etf" || v === "levered_etf") return "letf";
  if (
    v === "options" || v === "option" || v === "call" || v === "put"
    || v === "long_call" || v === "long_put" || v === "leap" || v === "spread"
    || v === "moonshot" || v === "covered_call" || v.includes("call") || v.includes("put")
  ) return "options";
  return null;
}

export function resolveAllowedPlayVehicles(prefs = {}) {
  const raw = prefs.allowed_vehicles || prefs.allowedVehicles || DEFAULT_PLAY_PREFS.allowed_vehicles;
  const list = (Array.isArray(raw) ? raw : String(raw).split(","))
    .map((x) => normalizePlayVehicle(x))
    .filter((x) => PLAY_VEHICLES.includes(x));
  return list.length ? [...new Set(list)] : [...PLAY_VEHICLES];
}

/**
 * Build the vehicle menu for a qualified signal.
 *
 * @param {Object} p
 *   ticker, direction (LONG/SHORT), price, sl, tp        — trade geometry
 *   tickerData                                            — scored payload
 *   optionsPlay                                           — compactOptionsPlay (or null)
 *   mode                                                  — "trader" | "investor"
 * @returns {Object} { expected_move_pct, entries[], pick } or null
 */
export function buildVehicleMenu(p = {}) {
  const ticker = String(p.ticker || "").toUpperCase();
  const direction = String(p.direction || "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
  const price = Number(p.price) || 0;
  const tp = Number(p.tp) || 0;
  const sl = Number(p.sl) || 0;
  const t = p.tickerData || {};
  const mode = String(p.mode || "trader").toLowerCase();
  if (!ticker || !(price > 0)) return null;

  const allowed = resolveAllowedPlayVehicles(p.playPrefs || p.prefs || t._play_prefs || {});
  const sgn = direction === "LONG" ? 1 : -1;
  const expectedMovePct = tp > 0 ? Math.round(((tp - price) / price) * sgn * 1000) / 10 : null;
  const holdIntent = String(t.hold_intent || t.horizon_bucket || "SWING").toUpperCase();
  const completion = Number(t.completion);
  const entries = [];

  // ── Shares — the baseline expression ─────────────────────────────────────
  {
    let score = 70;
    const reasons = ["always-available baseline; linear exposure, no theta, no reset decay"];
    if (expectedMovePct != null && expectedMovePct < 4) {
      score += 10;
      reasons.push(`modest expected move (${expectedMovePct}%) — leverage adds risk faster than reward`);
    }
    if (holdIntent === "POSITION") {
      score += 5;
      reasons.push("position-horizon hold favors unleveraged carry");
    }
    entries.push({
      vehicle: "shares",
      label: `${direction === "LONG" ? "Buy" : "Short"} ${ticker} shares`,
      suitability: clampScore(score),
      reasons,
    });
  }

  // ── Options — the engine's recommended play (when one was built) ─────────
  if (p.optionsPlay && typeof p.optionsPlay === "object") {
    const play = p.optionsPlay;
    let score = 50;
    const reasons = [];
    if (expectedMovePct != null && expectedMovePct >= 5) {
      score += 20;
      reasons.push(`expected move ${expectedMovePct}% — convexity pays when the move is large`);
    }
    if (play.target_clears_breakeven === true) {
      score += 12;
      reasons.push("the trade target clears the option breakeven");
    } else if (play.target_clears_breakeven === false) {
      score -= 15;
      reasons.push("target does NOT clear breakeven — premium drag eats the move");
    }
    if (play.max_loss_usd != null) {
      score += 5;
      reasons.push(`defined max loss $${Math.abs(play.max_loss_usd)}`);
    }
    if (String(play.archetype || "").includes("leap")) {
      score += 3;
      reasons.push("LEAP behaves like leveraged shares with defined risk");
    }
    entries.push({
      vehicle: "option",
      archetype: play.archetype || null,
      label: play.headline || play.label || "Options play",
      play,
      suitability: clampScore(score),
      reasons,
    });
  }

  // ── Leveraged ETF — when a mapped LETF exists ─────────────────────────────
  {
    const themes = (t.themes || []).map((x) => (typeof x === "string" ? x : x?.theme)).filter(Boolean);
    const letf = lookupLETF(ticker, themes);
    const letfTicker = letf ? (direction === "LONG" ? letf.long : letf.short) : null;
    if (letf && letfTicker) {
      let score = 45;
      const reasons = [`${letf.factor}x exposure via ${letfTicker} (${letf.note})`];
      const htf = Number(t.htf_score) || 0;
      const aligned = String(t.state || "") === (direction === "LONG" ? "HTF_BULL_LTF_BULL" : "HTF_BEAR_LTF_BEAR");
      if (Math.abs(htf) >= 15 && aligned) {
        score += 15;
        reasons.push("strong aligned trend — daily-reset compounding works FOR the position");
      }
      if (holdIntent === "POSITION") {
        score -= 12;
        reasons.push("long holds suffer daily-reset decay in chop");
      } else {
        reasons.push("daily-reset decay: not a buy-and-forget instrument");
      }
      entries.push({
        vehicle: "letf",
        letf_ticker: letfTicker,
        factor: letf.factor,
        label: `${direction === "LONG" ? "Buy" : "Buy"} ${letfTicker} (${letf.factor}x ${direction === "LONG" ? "bull" : "bear"})`,
        suitability: clampScore(score),
        reasons,
      });
    }
  }

  // ── Covered call — the income angle (owned / investor context) ───────────
  {
    const owned = !!p.owned || mode === "investor";
    if (owned && direction === "LONG" && tp > price) {
      let score = 38;
      const reasons = ["income on an owned position: sell the upside that the model says is limited"];
      if (Number.isFinite(completion) && completion >= 0.6) {
        score += 15;
        reasons.push(`move ${Math.round(completion * 100)}% complete — capped upside costs little`);
      }
      const fvPremium = Number(t._fair_value?.fv_premium_pct);
      if (Number.isFinite(fvPremium) && fvPremium >= 15) {
        score += 10;
        reasons.push(`trading ${Math.round(fvPremium)}% above fair value — rich strikes are good sells`);
      }
      entries.push({
        vehicle: "covered_call",
        label: `Sell covered calls near $${Math.round(tp * 100) / 100}`,
        strike_zone: tp,
        expiry_guidance: "~30 DTE, roll on strength",
        suitability: clampScore(score),
        reasons,
      });
    }
  }

  // ── Moonshot — RIDE-gated multi-bagger expression ─────────────────────────
  try {
    const confluence = t.confluence_verdict || t._confluence || null;
    const moon = shouldActivateMoonshot({ confluence, tickerData: t, profile: "speculator" });
    const active = moon === true || moon?.activate === true || moon?.active === true;
    if (active) {
      entries.push({
        vehicle: "moonshot",
        label: "Moonshot: far-dated OTM convexity",
        suitability: clampScore(45 + (expectedMovePct != null && expectedMovePct >= 8 ? 15 : 0)),
        reasons: [
          "confluence mode RIDE with the underlying already in motion",
          "small premium, asymmetric payoff — sized as risk capital only",
        ],
      });
    }
  } catch (_) { /* moonshot gate is best-effort */ }

  if (entries.length === 0) return null;

  // Annotate every entry with canonical play_vehicle for prefs + scorecard.
  for (const e of entries) {
    e.play_vehicle = normalizePlayVehicle(e.vehicle) || e.vehicle;
  }

  // Pref filter: model only shoots among allowed vehicles (default = all three).
  const candidates = entries.filter((e) => {
    const pv = e.play_vehicle;
    if (PLAY_VEHICLES.includes(pv)) return allowed.includes(pv);
    // Non-core expressions (covered_call/moonshot) fold into options when allowed.
    return allowed.includes("options") && normalizePlayVehicle(e.vehicle) === "options";
  });
  const pool = candidates.length ? candidates : entries.filter((e) => e.vehicle === "shares");

  // ── The engine's pick — highest suitability, shares wins ties ────────────
  const ranked = [...pool].sort((a, b) =>
    (b.suitability - a.suitability) || (a.vehicle === "shares" ? -1 : 1),
  );
  const pick = ranked[0];
  const playVehicle = normalizePlayVehicle(pick.vehicle) || "shares";

  return {
    generated_at: Date.now(),
    ticker,
    direction,
    mode,
    expected_move_pct: expectedMovePct,
    hold_intent: holdIntent,
    allowed_vehicles: allowed,
    entries,
    pick: {
      vehicle: pick.vehicle,
      play_vehicle: playVehicle,
      label: pick.label,
      suitability: pick.suitability,
      why: pick.reasons?.[0] || null,
      letf_ticker: pick.letf_ticker || null,
      archetype: pick.archetype || null,
    },
  };
}

/**
 * Ledger rows for the menu's counterfactuals: every NON-shares entry gets
 * graded on underlying terms so the data answers "would the alternative
 * have beaten the shares trade on this same signal?" The shares leg is the
 * actual trade — already graded by the trades ledger.
 */
export function vehicleMenuToCounterfactualSignals(menu, meta = {}) {
  if (!menu || !Array.isArray(menu.entries)) return [];
  const out = [];
  const refId = String(meta.tradeId || `${menu.ticker}:${menu.generated_at}`);
  for (const e of menu.entries) {
    if (e.vehicle === "shares") continue;
    out.push({
      signal_id: `vmenu:${refId}:${e.vehicle}`,
      source: "vehicle_counterfactual",
      desk: menu.mode === "investor" ? "investor" : "swing",
      ticker: menu.ticker,
      // Covered call profits when upside stalls → opposite-direction thesis.
      direction: e.vehicle === "covered_call"
        ? (menu.direction === "LONG" ? "SHORT" : "LONG")
        : menu.direction,
      vehicle: e.vehicle === "option" ? (e.archetype || "option") : e.vehicle,
      published_at: menu.generated_at,
      thesis: `${e.label} · suitability ${e.suitability} · pick=${menu.pick?.vehicle === e.vehicle}`,
      ref_id: refId,
      entry_price: Number(meta.price) || null,
      target_price: Number(meta.tp) || null,
      stop_price: Number(meta.sl) || null,
      breakeven: e.vehicle === "option" ? (Number(e.play?.breakeven) || null) : null,
      expiry_ts: e.vehicle === "option" && e.play?.expiration?.iso
        ? Date.parse(`${e.play.expiration.iso}T21:00:00Z`) || null
        : null,
      horizon_days: e.vehicle === "option" && e.play?.expiration?.iso ? null : 10,
      payload: {
        suitability: e.suitability,
        picked: menu.pick?.vehicle === e.vehicle,
        play_vehicle: normalizePlayVehicle(e.vehicle),
      },
    });
  }
  return out;
}

/**
 * First-class MODEL PLAY signal — the vehicle the model chose.
 * Dogfood scorecard keys on source='model_play' × vehicle ∈ {shares,letf,options}.
 * Shares picks grade off the live trade; letf/options grade as counterfactuals
 * until multi-vehicle execution is live.
 */
export function vehicleMenuToModelPlaySignal(menu, meta = {}) {
  if (!menu?.pick?.vehicle) return null;
  const playVehicle = normalizePlayVehicle(menu.pick.play_vehicle || menu.pick.vehicle) || "shares";
  const refId = String(meta.tradeId || `${menu.ticker}:${menu.generated_at}`);
  const pickEntry = (menu.entries || []).find((e) => e.vehicle === menu.pick.vehicle) || {};
  return {
    signal_id: `model_play:${refId}`,
    source: "model_play",
    desk: menu.mode === "investor" ? "investor" : "swing",
    ticker: menu.ticker,
    direction: menu.direction,
    vehicle: playVehicle,
    published_at: menu.generated_at,
    thesis: `${menu.pick.label} · ${menu.pick.why || "model pick"}`,
    ref_id: refId,
    entry_price: Number(meta.price) || null,
    target_price: Number(meta.tp) || null,
    stop_price: Number(meta.sl) || null,
    breakeven: playVehicle === "options" ? (Number(pickEntry.play?.breakeven) || null) : null,
    expiry_ts: playVehicle === "options" && pickEntry.play?.expiration?.iso
      ? Date.parse(`${pickEntry.play.expiration.iso}T21:00:00Z`) || null
      : null,
    horizon_days: playVehicle === "options" ? null : (playVehicle === "letf" ? 10 : 15),
    payload: {
      play_vehicle: playVehicle,
      menu_vehicle: menu.pick.vehicle,
      label: menu.pick.label,
      suitability: menu.pick.suitability,
      why: menu.pick.why,
      letf_ticker: menu.pick.letf_ticker || pickEntry.letf_ticker || null,
      archetype: menu.pick.archetype || pickEntry.archetype || null,
      expected_move_pct: menu.expected_move_pct ?? null,
      executed_vehicle: meta.executedVehicle || "shares",
      allowed_vehicles: menu.allowed_vehicles || PLAY_VEHICLES,
    },
  };
}

/** Compact stamp for lifecycle / trade event / UI. */
export function modelPlayLineage(menu) {
  if (!menu?.pick) return null;
  const playVehicle = normalizePlayVehicle(menu.pick.play_vehicle || menu.pick.vehicle) || "shares";
  return {
    play_vehicle: playVehicle,
    menu_vehicle: menu.pick.vehicle,
    label: menu.pick.label || null,
    suitability: menu.pick.suitability ?? null,
    why: menu.pick.why || null,
    letf_ticker: menu.pick.letf_ticker || null,
    archetype: menu.pick.archetype || null,
    expected_move_pct: menu.expected_move_pct ?? null,
    allowed_vehicles: menu.allowed_vehicles || PLAY_VEHICLES,
  };
}

/**
 * Dogfood scorecard — performance of model play picks by vehicle.
 * Uses signal_outcomes where source='model_play'.
 */
export function summarizeModelPlayGroups(groups = []) {
  const byVehicle = { shares: emptyPlayBucket(), letf: emptyPlayBucket(), options: emptyPlayBucket() };
  for (const g of groups || []) {
    if (String(g.source) !== "model_play") continue;
    const pv = normalizePlayVehicle(g.vehicle);
    if (!pv || !byVehicle[pv]) continue;
    const b = byVehicle[pv];
    b.n += Number(g.n) || 0;
    b.resolved += Number(g.resolved) || 0;
    b.wins += Number(g.wins) || 0;
    b.losses += Number(g.losses) || 0;
    b.flats += Number(g.flats) || 0;
    if (g.avg_pct != null && Number.isFinite(Number(g.avg_pct))) {
      b._pct_sum += Number(g.avg_pct) * (Number(g.resolved) || 0);
      b._pct_n += Number(g.resolved) || 0;
    }
  }
  const vehicles = PLAY_VEHICLES.map((v) => finalizePlayBucket(v, byVehicle[v]));
  const totals = finalizePlayBucket("all", vehicles.reduce((acc, r) => {
    acc.n += r.n; acc.resolved += r.resolved; acc.wins += r.wins;
    acc.losses += r.losses; acc.flats += r.flats;
    if (r.avg_pct != null && r.resolved > 0) {
      acc._pct_sum += r.avg_pct * r.resolved;
      acc._pct_n += r.resolved;
    }
    return acc;
  }, emptyPlayBucket()));
  return { vehicles, totals };
}

function emptyPlayBucket() {
  return { n: 0, resolved: 0, wins: 0, losses: 0, flats: 0, _pct_sum: 0, _pct_n: 0 };
}

function finalizePlayBucket(vehicle, b) {
  const closed = (b.wins || 0) + (b.losses || 0);
  const avgPct = b._pct_n > 0 ? Math.round((b._pct_sum / b._pct_n) * 100) / 100 : null;
  const sumPct = b._pct_n > 0 ? Math.round(b._pct_sum * 100) / 100 : null;
  return {
    play_vehicle: vehicle,
    label: playVehicleLabel(vehicle) || vehicle,
    n: b.n,
    resolved: b.resolved,
    open: Math.max(0, (b.n || 0) - (b.resolved || 0)),
    wins: b.wins,
    losses: b.losses,
    flats: b.flats,
    win_rate: closed > 0 ? Math.round((b.wins / closed) * 1000) / 10 : null,
    // "How much" — avg and sum of underlying outcome_pct across resolved plays.
    avg_pct: avgPct,
    sum_pct: sumPct,
    expectancy_pct: avgPct,
  };
}
