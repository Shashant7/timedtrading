// Complementary LTF + HTF forming at different cadences.
//
// Jun–Aug 2026 review: classifyState is only sign(htf)×sign(ltf). Gold
// long wants HTF already green. inferSide("HTF_BEAR_LTF_PULLBACK") is
// SHORT because the string contains BEAR. LTF-only SuperTrend ignition
// dies on HTF *color*. Result: TSLA Aug 13 (LTF +13 / HTF −10, 4H ST
// bull, daily 21 reclaim) never became a long; TEAM sat HTF_BULL_LTF_BULL
// with no continuation play; AAPL June gold-long shape bought the dump.
//
// This module does not replace the 2×2. It adds a forming pair:
//   LTF  (fast: 10m / 30m / 1H)  — constructing
//   HTF  (slow: 4H / D / W)      — forming (turn) OR formed (held)
// Complementary = same side, both clocks alive, weekly/monthly not
// sloping against. HTF score may still be negative on a turn.

const LTF_KEYS = ["10", "30", "1H"];
const HTF_KEYS = ["4H", "D", "W"];

function flagOn(v) {
  if (v == null || v === "") return true; // default ON
  return v === true || v === 1 || String(v).toLowerCase() === "true";
}

function tfRow(t, key) {
  const src = t?.tf_tech;
  if (!src || typeof src !== "object") return null;
  if (src[key]) return src[key];
  const aliases = {
    "10": ["10m", "10M"],
    "15": ["15m", "15M"],
    "30": ["30m", "30M"],
    "1H": ["60", "1h", "60m"],
    "4H": ["240", "4h", "240m"],
    D: ["d", "1d"],
    W: ["w", "1w"],
    M: ["m", "1M"],
  };
  for (const a of aliases[key] || []) {
    if (src[a]) return src[a];
  }
  return null;
}

function stDirSign(row) {
  const raw = row?.stDir;
  if (typeof raw === "number") {
    if (raw < 0) return 1;  // Pine −1 = bull
    if (raw > 0) return -1; // Pine +1 = bear
    return 0;
  }
  if (typeof raw === "string") {
    const up = raw.toUpperCase();
    if (up === "BULL" || up === "LONG" || up === "UP") return 1;
    if (up === "BEAR" || up === "SHORT" || up === "DOWN") return -1;
  }
  return 0;
}

function stSlopeSign(row) {
  const s = Number(row?.stSlope);
  if (!Number.isFinite(s) || Math.abs(s) < 1e-9) return 0;
  return s > 0 ? 1 : -1;
}

function stWith(row, side) {
  const want = side === "LONG" ? 1 : side === "SHORT" ? -1 : 0;
  if (!want || !row) return false;
  return stDirSign(row) === want;
}

function stSlopingAgainst(row, side) {
  const want = side === "LONG" ? 1 : side === "SHORT" ? -1 : 0;
  if (!want || !row) return false;
  return stDirSign(row) === -want && stSlopeSign(row) === -want;
}

function stMagnetAgainst(row, side) {
  const want = side === "LONG" ? 1 : side === "SHORT" ? -1 : 0;
  if (!want || !row) return false;
  return stDirSign(row) === -want && stSlopeSign(row) === 0;
}

function structure(row) {
  const n = Number(row?.ema?.structure);
  return Number.isFinite(n) ? n : null;
}

function cloudWith(row, side) {
  const c = row?.ripster?.c5_12;
  if (!c) return false;
  if (side === "LONG") return !!(c.bull || c.above) && Number(c.fastSlope || 0) >= 0;
  if (side === "SHORT") return !!(c.bear || c.below) && Number(c.fastSlope || 0) <= 0;
  return false;
}

function ltfBrokenBoth(t, side) {
  if (side !== "LONG") return false;
  const s15 = structure(tfRow(t, "15"));
  const s30 = structure(tfRow(t, "30"));
  if (s15 == null || s30 == null) return false;
  const bear15 = s15 <= -0.5 || (stDirSign(tfRow(t, "15")) === -1 && s15 < 0);
  const bear30 = s30 <= -0.5 || (stDirSign(tfRow(t, "30")) === -1 && s30 < 0);
  if (!bear15 || !bear30) return false;
  const r15 = Number(tfRow(t, "15")?.rsi?.r5);
  const r30 = Number(tfRow(t, "30")?.rsi?.r5);
  const wash = Math.min(
    Number.isFinite(r15) ? r15 : Infinity,
    Number.isFinite(r30) ? r30 : Infinity,
  );
  if (wash <= 32) return false;
  return true;
}

/**
 * Fast clock: 10m / 30m / 1H constructing in `side`.
 */
export function resolveLtfForming(t, side) {
  const cues = [];
  if (stWith(tfRow(t, "10"), side) || cloudWith(tfRow(t, "10"), side)) cues.push("10_st_or_512");
  const s30 = structure(tfRow(t, "30"));
  const s30With = side === "LONG" ? (s30 ?? -1) >= 0 : (s30 ?? 1) <= 0;
  if (stWith(tfRow(t, "30"), side) || (s30 != null && s30With)) cues.push("30_st_or_struct");
  const s1h = structure(tfRow(t, "1H"));
  const s1hWith = side === "LONG" ? s1h > -0.5 : s1h < 0.5;
  if (stWith(tfRow(t, "1H"), side) || (s1h != null && s1hWith)) cues.push("1h_ok");
  const ltf = Number(t?.ltf_score);
  if (side === "LONG" && Number.isFinite(ltf) && ltf >= 0) cues.push("ltf_score");
  if (side === "SHORT" && Number.isFinite(ltf) && ltf <= 0) cues.push("ltf_score");
  const broken = ltfBrokenBoth(t, side);
  // Hard veto: a clearly-green LTF cannot construct a SHORT pair
  // (TSLA Aug 13 printed LTF +8..+24 while inferSide still SHORT'd the
  // HTF_BEAR substring and faded the turn). Mirror for LONG.
  const opposed = Number.isFinite(ltf) && (
    (side === "LONG" && ltf < -4) || (side === "SHORT" && ltf > 4)
  );
  return {
    forming: !broken && !opposed && cues.length >= 2,
    cadence: "10m/30m/1H",
    cues,
    broken,
    opposed,
  };
}

/**
 * Slow clock: 4H / D / W. `forming` = turn in progress (score may still
 * be the old color). `formed` = HTF already with the side.
 */
export function resolveHtfForming(t, side) {
  const wmAgainst = stSlopingAgainst(tfRow(t, "W"), side)
    || stSlopingAgainst(tfRow(t, "M"), side);
  const ds = t?.daily_structure || {};
  const pctE21 = Number(ds.pct_above_e21);
  const daysAbove = Number(ds.days_above_e21);
  const slope = Number(ds.e21_slope_5d_pct);
  const e21Ok = side === "LONG"
    ? Number.isFinite(pctE21) && pctE21 >= -0.15 && pctE21 <= 3.5
      && (!Number.isFinite(slope) || slope > -0.5)
    : Number.isFinite(pctE21) && pctE21 <= 0.15 && pctE21 >= -3.5
      && (!Number.isFinite(slope) || slope < 0.5);
  const e21Fresh = !Number.isFinite(daysAbove) || daysAbove <= 5;

  const cues = [];
  if (stWith(tfRow(t, "4H"), side)) cues.push("4h_st");
  if (e21Ok && e21Fresh) cues.push("d21_reclaim_or_hold");
  if (stWith(tfRow(t, "D"), side) || stMagnetAgainst(tfRow(t, "D"), side)) cues.push("d_st_with_or_magnet");
  const s4 = structure(tfRow(t, "4H"));
  const sD = structure(tfRow(t, "D"));
  if ((s4 != null && ((side === "LONG" && s4 >= 0) || (side === "SHORT" && s4 <= 0)))
    || (sD != null && ((side === "LONG" && sD >= 0) || (side === "SHORT" && sD <= 0)))) {
    cues.push("htf_structure");
  }

  const htf = Number(t?.htf_score);
  const formed = !wmAgainst && (
    (side === "LONG" && Number.isFinite(htf) && htf > 0 && (stWith(tfRow(t, "D"), side) || stWith(tfRow(t, "W"), side)))
    || (side === "SHORT" && Number.isFinite(htf) && htf < 0 && (stWith(tfRow(t, "D"), side) || stWith(tfRow(t, "W"), side)))
    || (stWith(tfRow(t, "D"), side) && stWith(tfRow(t, "4H"), side) && !wmAgainst)
  );
  const ltfScore = Number(t?.ltf_score);
  const ltfStrong = (side === "LONG" && Number.isFinite(ltfScore) && ltfScore >= 8)
    || (side === "SHORT" && Number.isFinite(ltfScore) && ltfScore <= -8);
  // Two HTF cues is the default. One cue is enough when LTF is already
  // clearly constructing — the slow clock is allowed to lag (TSLA Aug 13
  // real bars often had 4H ST or daily 21, not both, on the first prints).
  const forming = !wmAgainst && (cues.length >= 2 || (cues.length >= 1 && ltfStrong));
  return {
    forming,
    formed,
    cadence: "4H/D/W",
    cues,
    wm_against: wmAgainst,
  };
}

function stretchChase(t, side, htf) {
  const ds = t?.daily_structure || {};
  const pct = Number(ds.pct_above_e21);
  const days = Number(ds.days_above_e21);
  if (side === "LONG" && Number.isFinite(pct) && pct > 4 && Number.isFinite(days) && days > 5 && !htf.formed) {
    return true;
  }
  if (side === "SHORT" && Number.isFinite(pct) && pct < -4 && Number.isFinite(days) && days > 5 && !htf.formed) {
    return true;
  }
  return false;
}

/**
 * @returns {{
 *   complementary: boolean,
 *   side: "LONG"|"SHORT"|null,
 *   mode: "turn"|"continuation"|null,
 *   ltf: object,
 *   htf: object,
 *   reason: string
 * }}
 */
export function resolveFormingPair(t, opts = {}) {
  const empty = (reason) => ({
    complementary: false,
    side: null,
    mode: null,
    ltf: null,
    htf: null,
    reason,
  });
  if (!t || typeof t !== "object") return empty("no_ticker");

  const trySide = (side) => {
    const ltf = resolveLtfForming(t, side);
    const htf = resolveHtfForming(t, side);
    if (!ltf.forming) return { ok: false, ltf, htf, reason: "ltf_not_forming" };
    if (htf.wm_against) return { ok: false, ltf, htf, reason: "htf_wm_against" };
    if (!(htf.forming || htf.formed)) return { ok: false, ltf, htf, reason: "htf_not_forming" };
    if (stretchChase(t, side, htf)) return { ok: false, ltf, htf, reason: "htf_stretch_chase" };
    const mode = htf.formed && Number(t?.htf_score) * (side === "LONG" ? 1 : -1) > 0
      ? "continuation"
      : "turn";
    return { ok: true, ltf, htf, mode, reason: mode === "turn" ? "ltf_fast_htf_slow_turn" : "htf_formed_ltf_reform" };
  };

  const preferred = opts.side === "SHORT" || opts.side === "LONG" ? [opts.side] : ["LONG", "SHORT"];
  for (const side of preferred) {
    const r = trySide(side);
    if (r.ok) {
      return {
        complementary: true,
        side,
        mode: r.mode,
        ltf: r.ltf,
        htf: r.htf,
        reason: r.reason,
      };
    }
  }
  const last = trySide(preferred[0]);
  return {
    complementary: false,
    side: null,
    mode: null,
    ltf: last.ltf,
    htf: last.htf,
    reason: last.reason || "no_pair",
  };
}

export function formingPairEnabled(daCfg) {
  return flagOn(daCfg?.deep_audit_forming_pair_enabled);
}

export function formingPairEntryEnabled(daCfg) {
  return flagOn(daCfg?.deep_audit_forming_pair_enabled)
    && flagOn(daCfg?.deep_audit_forming_pair_entry);
}

export function formingPairFloorsEnabled(daCfg) {
  return formingPairEntryEnabled(daCfg)
    && flagOn(daCfg?.deep_audit_forming_pair_floors);
}

export function isFormingPairEntryPath(path) {
  return String(path || "").toLowerCase().startsWith("tt_forming_pair");
}

export function formingPairHoldEnabled(daCfg) {
  return formingPairEntryEnabled(daCfg)
    && flagOn(daCfg?.deep_audit_forming_pair_hold_winners);
}

const FORMING_PAIR_HARD_FLOOR_DEFAULT = -6;

const FORMING_PAIR_DEFERRED_EXITS = new Set([
  "max_loss",
  "max_loss_time_scaled",
  "max_loss_pdz_window_expired",
  "max_loss_momentum_buffered",
  "max_loss_time_scaled_momentum_buffered",
  "RUNNER_TOP_FORMATION_1H",
  "doctrine_force_exit",
  "thesis_flip_htf",
  "ema_regime_reversed",
  // Trend-Hold suppress list — applied from bar 1 (no 5% MFE promote).
  "HARD_FUSE_RSI_EXTREME",
  "hard_fuse_rsi_extreme",
  "PROFIT_GIVEBACK",
  "PROFIT_GIVEBACK_STAGE_HOLD",
  "PROFIT_GIVEBACK_COOLING_HOLD",
  "SMART_RUNNER_SUPPORT_BREAK_CLOUD",
  "mfe_decay_structural_flatten",
  "ST_FLIP_4H_CLOSE",
  "st_flip_4h_close",
  "ripster_72_89_1h_structural_break",
  // Next-in-line after doctrine / ema_regime defer (Aug ON v7–v8).
  "phase_i_mfe_fast_cut_zero_mfe",
  "phase_i_mfe_fast_cut_2h",
  "phase_i_mfe_cut_4h",
  "phase_i_mfe_cut_8h",
  "phase_i_mfe_dead_money_24h",
  "phase_i_mfe_stale_72h",
  "bias_flip_full_bear_vs_long",
]);

function isDeferredFormingPairReason(why) {
  if (FORMING_PAIR_DEFERRED_EXITS.has(why)) return true;
  // Whole Phase-I MFE clock is a day-trade fuse on a swing.
  return why.startsWith("phase_i_mfe_");
}

export function isFormingPairOpenTrade(trade) {
  if (!trade || typeof trade !== "object") return false;
  const path = String(
    trade.entry_path
    || trade.entryPath
    || trade.__entry_path
    || trade.__tradeRef?.entry_path
    || trade.__tradeRef?.entryPath
    || "",
  );
  return isFormingPairEntryPath(path);
}

/**
 * HTF still with the long. LTF dump-broken only kills the hold
 * when the slow clock has also lost the daily 21 (AAPL June).
 *
 * TEAM Aug 24–25 printed LTF −24 / 15m+30m bear on a −2.3% shake
 * while HTF was +33 and daily 21 was +8% / +7.5% slope. Treating
 * that as `ltf.broken` flattened a rip that then ran 168 → 190.
 */
export function formingPairStructureHolds(d, side = "LONG") {
  if (!d || side !== "LONG") return false;
  const htf = resolveHtfForming(d, side);
  if (htf.wm_against) return false;
  const ds = d?.daily_structure || {};
  const pctE21 = Number(ds.pct_above_e21);
  const e21Lost = Number.isFinite(pctE21) && pctE21 < -0.15;
  const htfWith = htf.formed
    || (Number.isFinite(Number(d?.htf_score)) && Number(d.htf_score) > 0 && !e21Lost);
  const ltf = resolveLtfForming(d, side);
  if (ltf.broken && (e21Lost || !htfWith)) return false;
  if (htfWith || htf.forming) return true;
  const pair = d?._mtf_forming?.complementary
    ? d._mtf_forming
    : resolveFormingPair(d, { side });
  return !!(pair?.complementary && pair.side === side && !pair.ltf?.broken);
}

/**
 * Trend-Hold lesson applied to forming-pair before the 5% MFE promote:
 * do not flatten a swing on day-trade fuses while the slow clock holds.
 * PHASE_LEAVE / TD / soft-fuse / hard floor still exit.
 */
export function shouldDeferFormingPairExit({
  trade,
  tickerData,
  daCfg,
  reason,
  pnlPct,
  direction,
} = {}) {
  if (!formingPairHoldEnabled(daCfg)) return { defer: false, reason: "hold_off" };
  const dir = String(direction || trade?.direction || "LONG").toUpperCase();
  if (dir !== "LONG") return { defer: false, reason: "not_long" };
  // Identity from the ticket, never the live card (Cloud Pivot lesson).
  if (!isFormingPairOpenTrade(trade)) {
    return { defer: false, reason: "not_forming_pair" };
  }
  const why = String(reason || "");
  if (!isDeferredFormingPairReason(why)) {
    return { defer: false, reason: "reason_not_deferred" };
  }
  const hardRaw = Number(daCfg?.deep_audit_forming_pair_hard_floor_pct);
  const floor = Number.isFinite(hardRaw) && hardRaw < 0
    ? hardRaw
    : FORMING_PAIR_HARD_FLOOR_DEFAULT;
  if (Number.isFinite(Number(pnlPct)) && Number(pnlPct) <= floor) {
    return { defer: false, reason: "hard_floor" };
  }
  if (!formingPairStructureHolds(tickerData, "LONG")) {
    return { defer: false, reason: "structure_broken" };
  }
  return { defer: true, reason: `forming_pair_hold(${why})` };
}

const FORMING_PAIR_CONVICTION_FLOOR_DEFAULT = 40;
const FORMING_PAIR_CONVICTION_FLOOR_HARD_MIN = 35;

/**
 * LONG-only floor carve-out context (mirrors reclaim P15).
 *
 * TEAM Jul 8 printed HTF_BEAR_LTF_BEAR (a SHORT continuation shape) on
 * the first days of a +94% rip. Lowering SHORT floors would buy that
 * fade. The three canaries we need — TEAM Jul 13+ continuation, TSLA
 * Aug 13 turn, valid AAPL longs — are all LONG. AAPL June dumps stay
 * out because LTF 15m+30m is broken (not complementary).
 */
export function isFormingPairFloorContext(d, daCfg, side) {
  if (!formingPairFloorsEnabled(daCfg)) return false;
  if (side && side !== "LONG") return false;
  const stamped = d?._mtf_forming;
  const pair = stamped?.complementary ? stamped : resolveFormingPair(d, { side: "LONG" });
  if (!pair?.complementary || pair.side !== "LONG") return false;
  if (pair.ltf?.broken) return false;
  return true;
}

export function applyFormingPairConvictionCarveout(floor, d, daCfg, side) {
  if (!isFormingPairFloorContext(d, daCfg, side)) return floor;
  const raw = Number(daCfg?.deep_audit_forming_pair_conviction_floor);
  const target = Number.isFinite(raw) && raw > 0
    ? raw
    : FORMING_PAIR_CONVICTION_FLOOR_DEFAULT;
  return Math.min(Number(floor) || 0, Math.max(FORMING_PAIR_CONVICTION_FLOOR_HARD_MIN, target));
}

/** Parked HTF color is not a veto when the slow clock is forming with the trigger. */
export function formingPairExemptsHtfColorVeto(pair, triggerSide) {
  if (!pair?.complementary || !triggerSide || triggerSide === "NEUTRAL") return false;
  if (pair.side !== triggerSide) return false;
  return pair.htf?.forming === true || pair.mode === "turn";
}
