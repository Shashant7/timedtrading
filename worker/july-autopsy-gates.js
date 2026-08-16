// worker/july-autopsy-gates.js
// July-2026 ST autopsy gate pack — P2 / P3 / P8 / P11 from
// tasks/2026-08-15-july-st-autopsy-feedback.md.
//
// Every gate is driven by a `deep_audit_ja_*` flag and is DEFAULT OFF, so
// deploying this module changes nothing on live. The July-2026 targeted
// backtest flips the flags in preprod model_config per arm.
//
// Gates:
//   G1 ja_opening_gate        — no TT-setup entries before 9:45 ET (P2).
//                               The existing ripster_opening_chase_guard only
//                               covers the momentum path; the July open-chases
//                               (PKG 9:30:20, BRK-B 9:31, XLI 9:31/9:33,
//                               MTB 9:32, GRNI 9:35) all came through the TT
//                               setup family.
//   G2 ja_location_gate       — LONG blocked when PDZ is premium/
//                               premium_approach on BOTH D and 4H with any
//                               adverse divergence active; and blocked when
//                               f4-severe (adverse RSI + phase div) in a
//                               CHOPPY/TRANSITIONAL regime (JCI Jul 15).
//   G3 ja_expected_move_gate  — daily ATR% of price must clear a floor
//                               (default 1.4%) so GRNY/GRNI-class slow movers
//                               stop consuming ST-lane slots (P11).
//   G4 ja_default_deny        — admission results that pass only via
//                               `missing_inputs_default_allow` or
//                               `no_matrix_entry` are rejected instead of
//                               allowed (P8 — the hole Speculative-ATH rode
//                               through all of July).
//
// The post-trim entry floor (P5) lives in worker/index.js management pass
// (`deep_audit_ja_post_trim_floor`), not here — it is an exit-side rule.

const flagOn = (v) =>
  v === true || v === 1 || String(v ?? "").toLowerCase() === "true";

const advCount = (summary) => {
  if (!summary) return 0;
  const n = Number(summary.count);
  if (Number.isFinite(n)) return n;
  if (summary.anyActive) return Array.isArray(summary.tfs) && summary.tfs.length > 0 ? summary.tfs.length : 1;
  return 0;
};

const isPremiumZone = (zone) => {
  const z = String(zone || "").toLowerCase();
  return z === "premium" || z === "premium_approach";
};

/**
 * Entry-side gate pack (G1–G3). Pure, sync.
 *
 * @param {object} args
 * @param {object} args.d         — tickerData (raw) at qualify time
 * @param {object} args.daCfg     — deep-audit config
 * @param {string} args.path      — engine entry path (tt_*)
 * @param {string} args.direction — effective direction LONG/SHORT
 * @param {object} args.etParts   — { hour, minute } Eastern-time parts of asOf
 * @returns {{reason: string, detail: object}|null} block descriptor or null
 */
export function julyAutopsyGateBlock({ d, daCfg, path, direction, etParts }) {
  if (!daCfg) return null;
  const isLong = String(direction || "").toUpperCase() === "LONG";

  // ── G1: opening window (P2) ──
  if (flagOn(daCfg.deep_audit_ja_opening_gate)) {
    const endMin = Number(daCfg.deep_audit_ja_opening_gate_end_minute) || 45;
    const h = Number(etParts?.hour);
    const m = Number(etParts?.minute);
    if (h === 9 && Number.isFinite(m) && m >= 30 && m < endMin) {
      return {
        reason: "ja_opening_window_block",
        detail: { hour: h, minute: m, end_minute: endMin, path },
      };
    }
  }

  // ── G2: location / adverse divergence (P3) ──
  // tt_htf_reclaim is exempt: a fresh reclaim sits just above the daily
  // EMA-21 — the correct location by definition — but PDZ zone math is
  // range-relative and labels post-pullback reclaims "premium" (CIBR
  // Jul 31 probe: G2 vetoed the reclaim on 9 of 14 bars).
  if (flagOn(daCfg.deep_audit_ja_location_gate) && isLong
      && String(path || "") !== "tt_htf_reclaim") {
    const div = d?.__entry_divergence_summary || {};
    const advRsi = advCount(div.adverse_rsi);
    const advPhase = advCount(div.adverse_phase);
    const zD = String(d?.pdz_zone_D || "").toLowerCase();
    const z4 = String(d?.pdz_zone_4h || "").toLowerCase();
    const regime = String(d?.regime_class || d?.regime?.combined || "").toUpperCase();

    if (isPremiumZone(zD) && isPremiumZone(z4) && (advRsi >= 1 || advPhase >= 1)) {
      return {
        reason: "ja_location_premium_adverse_div_block",
        detail: { pdz_d: zD, pdz_4h: z4, adv_rsi: advRsi, adv_phase: advPhase, path },
      };
    }
    if (advRsi >= 1 && advPhase >= 1
        && (regime.includes("CHOPPY") || regime.includes("TRANSITIONAL"))) {
      return {
        reason: "ja_f4_severe_unstable_regime_block",
        detail: { regime, adv_rsi: advRsi, adv_phase: advPhase, path },
      };
    }
  }

  // ── G3: expected move (P11) ──
  if (flagOn(daCfg.deep_audit_ja_expected_move_gate)) {
    const price = Number(d?.price) || Number(d?._live_price) || 0;
    const atr = Number(d?.atr) || Number(d?.atr_d) || 0;
    const floorPct = Number(daCfg.deep_audit_ja_expected_move_min_atr_pct) || 1.4;
    if (price > 0 && atr > 0) {
      const atrPct = (atr / price) * 100;
      if (atrPct < floorPct) {
        return {
          reason: "ja_expected_move_too_small",
          detail: { atr_pct: Number(atrPct.toFixed(3)), floor_pct: floorPct, path },
        };
      }
    }
  }

  return null;
}

/**
 * P15 — HTF reclaim context detector. True when the ticker is in the
 * "fresh daily EMA-21 reclaim with HTF support" state the operator
 * identified as the highest-quality entry (CIBR Jun 26 / Jul 31).
 * Used twice: (a) as a conviction-floor carve-out — on reclaim days the
 * conviction score is structurally low because the scoring system likes
 * mature trends (CIBR Jul 31 was blocked by focus_conviction_below_floor
 * on all 14 bars of its reclaim day), and (b) by the tt_htf_reclaim
 * trigger, which adds the LTF confirmation on top.
 */
export function isHtfReclaimContext(d, tf, daCfg) {
  const ds = d?.daily_structure || {};
  const pctE21 = Number(ds.pct_above_e21);
  const slope = Number(ds.e21_slope_5d_pct);
  const maxExt = Number(daCfg?.deep_audit_ja_htf_reclaim_max_ext_pct) || 2.5;
  const freshAbove = Number.isFinite(pctE21) && pctE21 >= 0 && pctE21 <= maxExt;
  const slopeOk = !Number.isFinite(slope) || slope > -0.5;
  const trendOk = ds.above_e200 !== false;
  // Tuning pass 2 (2026-08-16, 80-trade Jul+Aug replay analysis):
  // freshness by TIME, not just distance. Winners had a median of 3 daily
  // closes above the EMA-21 before entry; losers 7. Entries hovering
  // above for >5 closes are mid-trend drift, not reclaims (daysAbove>3:
  // 34% WR; <=3: 55%; the <=5 cut kept 9/11 big winners and RAISED total
  // PnL 121.8 -> 127.2 with 12% fewer positions). Backward compatible:
  // when days_above_e21 is absent (older snapshots), do not block.
  const maxDays = Number(daCfg?.deep_audit_ja_htf_reclaim_max_days_above);
  const maxDaysEff = Number.isFinite(maxDays) && maxDays > 0 ? maxDays : 5;
  const daysAbove = Number(ds.days_above_e21);
  const freshInTime = !Number.isFinite(daysAbove) || daysAbove <= maxDaysEff;
  // NOTE (CIBR Jul 31 probe): do NOT require 4H ST/cloud agreement here.
  // The operator's sequence is two-stage — daily EMA-21 reclaim first
  // (Jun 26), 4H trend break days later (Jun 29). On the reclaim day
  // itself the 4H is still bearish by construction; requiring both
  // simultaneously means the fresh-reclaim window never qualifies. The
  // tt_htf_reclaim trigger layers 4H/LTF confirmation on top of this
  // context (4H agreement upgrades confidence).
  return freshAbove && slopeOk && trendOk && freshInTime;
}

/**
 * Minimum profit an EXHAUSTION-driven trim must have before it may cut the
 * position, expressed relative to what the ticker normally moves in a day.
 *
 * Why: the exhaustion trims used a flat +0.5% floor, and the protective
 * first-trim guard (which requires +1.0% and a mature move) was applied ONLY
 * to SLOW_GRINDER personalities. That is inverted — the names that travel
 * furthest got the least protection:
 *   HALO (VOLATILE_RUNNER) trimmed 50% at +0.74% via TD_HTF_EXHAUSTION on a
 *   move that ran to +8.35% MFE, capturing 9% of it.
 *   NEU  (MODERATE)        trimmed 50% at +0.59% via ATR_RANGE_EXHAUST
 *   12 minutes after entry.
 * Across the live July/August book, 7 of 17 trims fired below +0.75%.
 *
 * A trim at half a percent on a name with a 3% daily range is banking noise,
 * not exhaustion. Scaling the floor by daily ATR% makes the threshold mean
 * the same thing on a slow ETF and on a volatile runner.
 *
 * Returns the required profit percent. `deep_audit_ja_exhaust_trim_atr_frac`
 * of 0 disables the scaling and restores the flat floor.
 */
export function exhaustTrimMinProfitPct(d, daCfg, absFloorPct = 0.5) {
  // DEFAULT 0 (DISABLED) — VALIDATED NEGATIVE 2026-08-16.
  // The July 10m replay arm with this at 0.35 scored $1,143 vs the
  // baseline's $2,088 (realized $402 vs $1,345, WR 57% -> 48%). Raising the
  // floor moved 6 trades from trimmed to untrimmed and the trimmed cohort's
  // average fell from +2.27% to +1.16%.
  //
  // The reason is that in this book the early trim IS the profit mechanism:
  // trimmed trades finish 28/34 winners (+2.27% avg), untrimmed 1/17
  // (-1.22% avg). HALO — an early trim capping an 8.35% move — is the
  // exception, not the rule, and the giveback there was on the RUNNER leg
  // after the trim, not the trim itself. The correct fix is a
  // structure-referenced stop on the post-trim runner, not a later trim.
  const frac = Number(daCfg?.deep_audit_ja_exhaust_trim_atr_frac);
  const fracEff = Number.isFinite(frac) ? frac : 0;
  if (!(fracEff > 0)) return absFloorPct;

  const price = Number(d?.price) || Number(d?._live_price) || 0;
  const atr = Number(d?.atr) || Number(d?.atr_d) || 0;
  if (!(price > 0) || !(atr > 0)) return absFloorPct;

  const atrPct = (atr / price) * 100;
  const cap = Number(daCfg?.deep_audit_ja_exhaust_trim_max_floor_pct);
  const capEff = Number.isFinite(cap) && cap > 0 ? cap : 2.5;
  return Math.min(capEff, Math.max(absFloorPct, atrPct * fracEff));
}

/**
 * G4 — default-deny for admission holes (P8). Call with the admitSetup
 * result: when the only reason a cohort is allowed is a missing grade or a
 * missing matrix row, reject instead.
 *
 * @returns {{reason: string, detail: object}|null}
 */
export function julyAutopsyDefaultDeny(daCfg, admission) {
  if (!flagOn(daCfg?.deep_audit_ja_default_deny)) return null;
  if (!admission || admission.allow !== true) return null;
  const r = String(admission.reason || "");
  if (r === "missing_inputs_default_allow" || r === "no_matrix_entry") {
    return {
      reason: "ja_admission_default_deny",
      detail: { admission_reason: r, matched_key: admission.matched_key || null },
    };
  }
  return null;
}

export default {
  julyAutopsyGateBlock,
  julyAutopsyDefaultDeny,
  isHtfReclaimContext,
  exhaustTrimMinProfitPct,
};
