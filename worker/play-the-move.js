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

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
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

  // ── The engine's pick — highest suitability, shares wins ties ────────────
  const ranked = [...entries].sort((a, b) =>
    (b.suitability - a.suitability) || (a.vehicle === "shares" ? -1 : 1),
  );
  const pick = ranked[0];

  return {
    generated_at: Date.now(),
    ticker,
    direction,
    mode,
    expected_move_pct: expectedMovePct,
    hold_intent: holdIntent,
    entries,
    pick: {
      vehicle: pick.vehicle,
      label: pick.label,
      suitability: pick.suitability,
      why: pick.reasons?.[0] || null,
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
      payload: { suitability: e.suitability, picked: menu.pick?.vehicle === e.vehicle },
    });
  }
  return out;
}
