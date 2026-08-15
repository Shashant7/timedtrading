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
  if (flagOn(daCfg.deep_audit_ja_location_gate) && isLong) {
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

export default { julyAutopsyGateBlock, julyAutopsyDefaultDeny };
