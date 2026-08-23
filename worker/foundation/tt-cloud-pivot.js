// TT Cloud Pivot — intraday 10m 5/12 curl thin slice (paper first).
// plans/tt-cloud-pivot-slice.plan.md
//
// Geometry from Ripster-style EMA clouds, branded as Timed Trading:
//   10m 5/12 = ride / curl trigger
//   10m 34/50 = bias / risk
//   1H 34/50  = MTF magnet
// Exit anti-giveback: 10m candle loses 5/12 → trim/exit.
//
// 2026-08-21 slices (not a 3m kitchen sink):
//   A. Cloud magnet — next 1H/4H 34/50 (then 72/89) as cover/trim attractor
//   B. Session if/then — catalyst names only: long-over / short-under gate
//   C. Mixed-cloud curl — 10m 5/12 vs 10m 34/50 OK when 1H magnet is ahead
//   D. Ribbon trail — after MFE, ratchet stop to held 5/12 then 34/50
//   E. Day2/3 + leader curl — fresh earnings hold; BTC/ETH/SPY/QQQ fans followers

import { TICKER_PROXY_MAP } from "../sector-mapping.js";
import { isCanonicalCapitalEntryPath } from "./confirm-stack-paper-queue.js";

export const CLOUD_PIVOT_FAMILY = "tt_cloud_pivot";
export const CLOUD_PIVOT_PAPER_SIZE_MULT = 0.1;
export const CLOUD_PIVOT_LEADERS = ["BTCUSD", "ETHUSD", "SPY", "QQQ"];

/** Session windows (America/New_York minutes from midnight). */
export const CLOUD_PIVOT_WINDOWS = {
  open: { startMin: 9 * 60 + 30, endMin: 10 * 60 + 0, label: "open" },
  ten_am: { startMin: 10 * 60 + 0, endMin: 10 * 60 + 45, label: "ten_am" },
  midday: { startMin: 10 * 60 + 45, endMin: 13 * 60 + 30, label: "midday_curl" },
};

const RTH_START_MIN = 9 * 60 + 30;
const RTH_END_MIN = 16 * 60;
const MAGNET_TF_KEYS = [
  ["1H", "1H"],
  ["60", "1H"],
  ["4H", "4H"],
  ["240", "4H"],
];
const MAGNET_BANDS = [
  ["c34_50", "34_50"],
  ["c72_89", "72_89"],
];

export function loadCloudPivotConfig(daCfg = {}) {
  const enabled = String(daCfg.deep_audit_tt_cloud_pivot_paper_queue_enabled ?? "true") === "true";
  const exitEnabled = String(daCfg.deep_audit_tt_cloud_pivot_exit_enabled ?? "true") === "true";
  const raw = Number(daCfg.deep_audit_tt_cloud_pivot_paper_size_mult);
  const sizeMult = Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : CLOUD_PIVOT_PAPER_SIZE_MULT;
  const openNoiseEnd = Number(daCfg.deep_audit_tt_cloud_pivot_opening_noise_end_minute);
  return {
    enabled,
    exitEnabled,
    sizeMult,
    openNoiseEndMin: Number.isFinite(openNoiseEnd) && openNoiseEnd >= 0 ? openNoiseEnd : 45,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Reject null/"" so Number(null)===0 cannot look like a real price or DTE. */
function finiteOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstFinite(...vals) {
  for (const v of vals) {
    const n = finiteOrNull(v);
    if (n != null) return n;
  }
  return null;
}

function tfRipster(payload, key) {
  return payload?.tf_tech?.[key]?.ripster || null;
}

function tfRipsterAny(payload, keys) {
  for (const k of keys) {
    const rt = tfRipster(payload, k);
    if (rt) return rt;
  }
  return null;
}

/** NY minutes from midnight for a ms timestamp. */
export function nyMinutesFromMidnight(ts = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(new Date(ts));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = String(get("weekday") || "");
  if (wd === "Sat" || wd === "Sun") return null;
  let hour = Number(get("hour"));
  const minute = Number(get("minute"));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  // Some engines return 24 for midnight
  if (hour === 24) hour = 0;
  return hour * 60 + minute;
}

export function resolveCloudPivotSession(ts = Date.now(), opts = {}) {
  const mins = nyMinutesFromMidnight(ts);
  if (mins == null) return null;
  for (const w of Object.values(CLOUD_PIVOT_WINDOWS)) {
    if (mins >= w.startMin && mins < w.endMin) return w.label;
  }
  if (mins < RTH_START_MIN || mins >= RTH_END_MIN) return null;
  if (opts.allowDay2) return "day2_curl";
  if (opts.allowLeader) return "leader_curl";
  return null;
}

function cloudSide(cloud) {
  if (!cloud || typeof cloud !== "object") return null;
  if (cloud.bull === true || cloud.above === true) return "LONG";
  if (cloud.bear === true || cloud.below === true) return "SHORT";
  return null;
}

export function cloudPivotMarkPx(payload = {}, fallback = null) {
  return firstFinite(
    payload._live_price,
    payload.price,
    payload.close,
    payload.p,
    fallback,
  );
}

function cloudPivotAtr(payload = {}) {
  return firstFinite(
    payload.atr,
    payload.atr14,
    payload.__atr,
    payload.tf_tech?.["10"]?.atr,
    payload.tf_tech?.D?.atr,
  );
}

export function earningsSessionsAgo(payload = {}) {
  return firstFinite(
    payload.days_to_earnings,
    payload.earnings_dte,
    payload.earningsDte,
    payload.daysToEarnings,
  );
}

/** Upcoming (0..2) or just-reported (0..-2) catalyst window. */
export function hasLiveCatalyst(payload = {}) {
  const dte = earningsSessionsAgo(payload);
  if (dte != null && dte <= 2 && dte >= -2) {
    return { kind: "earnings", dte };
  }
  const ev = payload.event_risk || payload._event_risk || payload.event_risk_window;
  if (ev === true) return { kind: "event_risk", dte: null };
  if (ev && typeof ev === "object" && (ev.active || ev.armed || ev.window || ev.reason)) {
    return { kind: "event_risk", dte: dte };
  }
  return null;
}

/** Post-print hold: earnings/guidance ≤2 sessions old and 1H 34/50 still a side. */
export function isDay2CurlEligible(payload = {}) {
  const dte = earningsSessionsAgo(payload);
  if (dte == null || dte > 0 || dte < -2) return false;
  const c1h = tfRipsterAny(payload, ["1H", "60"])?.c34_50;
  return !!cloudSide(c1h);
}

function pickPivots(payload = {}) {
  return payload.pivots
    || payload.ticker_scenario?.pivots
    || payload.scenario?.pivots
    || payload.prediction_levels?.pivots
    || payload.prediction_levels
    || null;
}

/**
 * Catalyst-only session card: bias / support / resistance / long_over / short_under.
 * Soft gate — never shrinks the non-catalyst book.
 */
export function buildCloudSessionPlan(payload = {}, direction = null) {
  const cat = hasLiveCatalyst(payload);
  if (!cat) return null;
  const c1h = tfRipsterAny(payload, ["1H", "60"])?.c34_50 || null;
  const piv = pickPivots(payload);
  const pmh = firstFinite(
    payload.premarket_high,
    payload.pm_high,
    payload.premarketHigh,
    payload.ah_high,
    piv?.prevHigh,
  );
  const pdl = firstFinite(
    payload.prev_day_low,
    payload.pd_low,
    payload.prev_low,
    payload.prevLow,
    piv?.prevLow,
    payload.day_low,
  );
  const r1 = firstFinite(piv?.r1, piv?.R1, piv?.resistance, piv?.pivot_r1);
  const s1 = firstFinite(piv?.s1, piv?.S1, piv?.support, piv?.pivot_s1);
  const resistance = firstFinite(pmh, r1, c1h?.hi);
  const support = firstFinite(pdl, s1, c1h?.lo);
  // If/then gate is PMH/PDL + pivots. 1H cloud is the magnet, not a second
  // hard gate — only fall back to the 1H edge when no session level exists
  // and price is still on the wrong side of that edge.
  const px = cloudPivotMarkPx(payload);
  let longOver = firstFinite(pmh, r1);
  if (longOver == null) {
    const hi = finiteOrNull(c1h?.hi);
    const lo = finiteOrNull(c1h?.lo);
    // Only a breakout gate when price is still under the whole 1H band.
    if (hi != null && px != null && lo != null && px < lo) longOver = hi;
  }
  let shortUnder = firstFinite(pdl, s1);
  if (shortUnder == null) {
    const lo = finiteOrNull(c1h?.lo);
    const hi = finiteOrNull(c1h?.hi);
    if (lo != null && px != null && hi != null && px > hi) shortUnder = lo;
  }
  const bias = direction || cloudSide(c1h) || null;
  if (longOver == null && shortUnder == null && support == null && resistance == null) {
    return null;
  }
  return {
    bias,
    support,
    resistance,
    long_over: longOver,
    short_under: shortUnder,
    catalyst: cat.kind,
    dte: cat.dte,
  };
}

export function sessionPlanAllows(plan, direction, price) {
  if (!plan) return true;
  const px = finiteOrNull(price);
  const dir = String(direction || "").toUpperCase();
  if (dir === "LONG") {
    const gate = finiteOrNull(plan.long_over);
    if (gate == null || px == null) return true;
    return px >= gate * 0.999;
  }
  if (dir === "SHORT") {
    const gate = finiteOrNull(plan.short_under);
    if (gate == null || px == null) return true;
    return px <= gate * 1.001;
  }
  return true;
}

function magnetTol(price, atr) {
  const px = finiteOrNull(price);
  if (px == null || px <= 0) return 0;
  const atrN = finiteOrNull(atr);
  return Math.max(px * 0.0015, atrN != null ? atrN * 0.1 : 0);
}

/**
 * Next 1H then 4H 34/50 (then 72/89) band as attractor.
 * LONG = first band above (near edge = lo); SHORT = first band below (near edge = hi).
 * In-cloud: far edge (hi for long / lo for short) is the push-through.
 */
export function resolveCloudMagnet(payload = {}, direction = null, priceIn = null) {
  const px = cloudPivotMarkPx(payload, priceIn);
  if (px == null) return null;
  const dir = String(direction || cloudSide(tfRipsterAny(payload, ["1H", "60"])?.c34_50) || "").toUpperCase();
  if (dir !== "LONG" && dir !== "SHORT") return null;

  const seen = new Set();
  for (const [tfKey, tfLabel] of MAGNET_TF_KEYS) {
    const rt = tfRipster(payload, tfKey);
    if (!rt) continue;
    for (const [bandKey, bandLabel] of MAGNET_BANDS) {
      const stamp = `${tfLabel}_${bandLabel}`;
      if (seen.has(stamp)) continue;
      const cloud = rt[bandKey];
      const lo = finiteOrNull(cloud?.lo);
      const hi = finiteOrNull(cloud?.hi);
      if (lo == null || hi == null || hi < lo) continue;
      seen.add(stamp);

      const inCloud = px >= lo && px <= hi;
      const overhead = lo > px;
      const under = hi < px;
      let tagPx = null;
      let ahead = false;
      if (dir === "LONG") {
        if (overhead) {
          tagPx = lo;
          ahead = true;
        } else if (inCloud) {
          tagPx = hi;
          ahead = true;
        }
      } else if (under) {
        tagPx = hi;
        ahead = true;
      } else if (inCloud) {
        tagPx = lo;
        ahead = true;
      }
      if (tagPx == null) continue;
      return {
        px: tagPx,
        lo,
        hi,
        tf: tfLabel,
        band: bandLabel,
        label: stamp,
        direction: dir,
        ahead,
        in_cloud: inCloud,
      };
    }
  }
  return null;
}

export function cloudMagnetTagged(price, magnet, atr) {
  const px = finiteOrNull(price);
  const mag = finiteOrNull(magnet?.px);
  if (px == null || mag == null) return false;
  return Math.abs(px - mag) <= magnetTol(px, atr);
}

function cloudSlopingAgainst(cloud, direction) {
  if (!cloud || typeof cloud !== "object") return false;
  const slope = firstFinite(cloud.fastSlope, cloud.slowSlope);
  const dir = String(direction || "").toUpperCase();
  if (dir === "LONG") {
    return !!(cloud.bear || cloud.below) && slope != null && slope < 0;
  }
  if (dir === "SHORT") {
    return !!(cloud.bull || cloud.above) && slope != null && slope > 0;
  }
  return false;
}

/** 10m 5/12 cross or curl ride — used by detect and leader fan-out. */
export function detectTenMinCurl(payload = {}) {
  const rt10 = tfRipster(payload, "10");
  const c512 = rt10?.c5_12;
  if (!c512) return null;
  const crossUp = c512.crossUp === true;
  const crossDn = c512.crossDn === true;
  const bullRide = !!(c512.bull && (c512.above || c512.inCloud) && num(c512.fastSlope) >= 0);
  const bearRide = !!(c512.bear && (c512.below || c512.inCloud) && num(c512.fastSlope) <= 0);
  if (crossUp || bullRide) {
    return { direction: "LONG", trigger: crossUp ? "5_12_cross_up" : "5_12_curl_bounce", cross: crossUp, ride: bullRide };
  }
  if (crossDn || bearRide) {
    return { direction: "SHORT", trigger: crossDn ? "5_12_cross_dn" : "5_12_curl_reject", cross: crossDn, ride: bearRide };
  }
  return null;
}

export function cloudPivotFollowersOf(leaderSym) {
  const L = String(leaderSym || "").toUpperCase();
  if (!L) return [];
  const out = new Set();
  const map = TICKER_PROXY_MAP || {};
  const self = map[L];
  if (Array.isArray(self?.leads)) {
    for (const f of self.leads) if (f) out.add(String(f).toUpperCase());
  }
  if (Array.isArray(self?.peers)) {
    for (const p of self.peers) if (p) out.add(String(p).toUpperCase());
  }
  for (const [sym, meta] of Object.entries(map)) {
    const S = String(sym).toUpperCase();
    if (S === L) continue;
    if (String(meta?.crypto_proxy || "").toUpperCase() === L) {
      out.add(S);
      if (Array.isArray(meta?.peers)) {
        for (const p of meta.peers) if (p) out.add(String(p).toUpperCase());
      }
    }
  }
  out.delete(L);
  return [...out];
}

/**
 * Stamp `_cloud_leader_follow` on same-side follower curls when a leader prints 10m 5/12.
 * `rows` is `[{ sym, t }]`. Mutates ticker objects in place.
 */
export function annotateCloudPivotLeaderFollows(rows = []) {
  const bySym = new Map();
  for (const row of rows || []) {
    const sym = String(row?.sym || row?.ticker || row?.t?.ticker || "").toUpperCase();
    const t = row?.t || row;
    if (!sym || !t || typeof t !== "object") continue;
    bySym.set(sym, t);
  }
  for (const leader of CLOUD_PIVOT_LEADERS) {
    const leadTd = bySym.get(leader);
    if (!leadTd) continue;
    const leadCurl = detectTenMinCurl(leadTd);
    if (!leadCurl?.direction) continue;
    leadTd._cloud_leader = {
      role: "leader",
      symbol: leader,
      direction: leadCurl.direction,
      trigger: leadCurl.trigger,
    };
    for (const f of cloudPivotFollowersOf(leader)) {
      const fol = bySym.get(f);
      if (!fol) continue;
      const folCurl = detectTenMinCurl(fol);
      if (!folCurl || folCurl.direction !== leadCurl.direction) continue;
      fol._cloud_leader_follow = {
        leader,
        direction: leadCurl.direction,
        trigger: folCurl.trigger,
      };
    }
  }
}

function curlSession(session) {
  return session === "midday_curl" || session === "day2_curl" || session === "leader_curl";
}

/**
 * Pure detector for tt_cloud_pivot.
 * @returns {null|{ fires, direction, session, reasons[], clouds }}
 */
export function detectTtCloudPivot(payload = {}, daCfg = {}, opts = {}) {
  const cfg = loadCloudPivotConfig(daCfg);
  if (!cfg.enabled) return null;
  if (!payload || typeof payload !== "object") return null;

  const prior = payload._sequence_queue_proposal;
  if (prior?.family === "confirm_stack_ema21" && prior?.paper) return null;

  const asOf = Number(opts.asOfTs || payload.ts || payload.ingest_ts || Date.now());
  const day2Eligible = isDay2CurlEligible(payload);
  const leaderFollow = payload._cloud_leader_follow || null;
  const session = resolveCloudPivotSession(asOf, {
    allowDay2: day2Eligible,
    allowLeader: !!(leaderFollow?.direction),
  });
  if (!session) return null;

  // Opening noise: skip pure momentum chase in first N minutes of RTH for open window.
  const mins = nyMinutesFromMidnight(asOf);
  if (session === "open" && mins != null && mins < (9 * 60 + cfg.openNoiseEndMin)) {
    // Allow only reclaim/cross confirmation, not naked extension — handled below via requireCross.
  }

  const rt10 = tfRipster(payload, "10");
  const rt1H = tfRipsterAny(payload, ["1H", "60"]);
  if (!rt10?.c5_12) return null;

  const c512 = rt10.c5_12;
  const c3450_10 = rt10.c34_50 || null;
  const c3450_1h = rt1H?.c34_50 || null;
  const c89 = rt10.c8_9 || null;

  const crossUp = c512.crossUp === true;
  const crossDn = c512.crossDn === true;
  const bullRide = !!(c512.bull && (c512.above || c512.inCloud) && num(c512.fastSlope) >= 0);
  const bearRide = !!(c512.bear && (c512.below || c512.inCloud) && num(c512.fastSlope) <= 0);
  const allowCurlHold = curlSession(session);

  let direction = null;
  let trigger = null;
  if (crossUp || (allowCurlHold && bullRide && (c512.inCloud || crossUp))) {
    direction = "LONG";
    trigger = crossUp ? "5_12_cross_up" : "5_12_curl_bounce";
  } else if (crossDn || (allowCurlHold && bearRide && (c512.inCloud || crossDn))) {
    direction = "SHORT";
    trigger = crossDn ? "5_12_cross_dn" : "5_12_curl_reject";
  } else if (session !== "midday_curl" && session !== "day2_curl" && bullRide && (crossUp || c89?.crossUp || c89?.bull)) {
    direction = "LONG";
    trigger = "5_12_open_hold";
  } else if (session !== "midday_curl" && session !== "day2_curl" && bearRide && (crossDn || c89?.crossDn || c89?.bear)) {
    direction = "SHORT";
    trigger = "5_12_open_hold";
  }
  if (!direction) return null;

  // Open window: require an actual cross (avoid noise chase).
  if (session === "open" && !(crossUp || crossDn)) return null;

  const px = cloudPivotMarkPx(payload);
  const magnet = resolveCloudMagnet(payload, direction, px);
  const plan = buildCloudSessionPlan(payload, direction);
  if (plan && !sessionPlanAllows(plan, direction, px)) return null;

  const bias10 = cloudSide(c3450_10);
  const bias1h = cloudSide(c3450_1h);
  const opposed10 = bias10 && bias10 !== direction;
  const opposed1h = bias1h && bias1h !== direction;
  const magnetAhead = magnet?.ahead === true;
  const oneHSlopingAgainst = cloudSlopingAgainst(c3450_1h, direction);
  // Mixed-cloud: 10m 5/12 against 10m 34/50 is OK when the 1H band is the magnet.
  // Veto only when 1H is sloping against AND nothing overhead/under is left to tag.
  if (oneHSlopingAgainst && !magnetAhead) return null;
  if (session !== "midday_curl" && session !== "day2_curl" && opposed10 && opposed1h && !magnetAhead) {
    return null;
  }
  if (session === "midday_curl" && opposed10 && opposed1h && !(crossUp || crossDn) && !magnetAhead) {
    return null;
  }

  const life = String(payload._model_lifecycle?.state || payload.model_lifecycle?.state || "").toLowerCase();
  if (["bought", "held", "trimming", "exited"].includes(life)) return null;
  const stage = String(payload.kanban_stage || "").toLowerCase();
  if (["just_entered", "hold", "trim", "exit", "exited"].includes(stage)) return null;

  const reasons = [session, trigger];
  if (bias10) reasons.push(`10m_34_50_${bias10.toLowerCase()}`);
  if (bias1h) reasons.push(`1h_34_50_${bias1h.toLowerCase()}`);
  if (opposed10 && magnetAhead) reasons.push("mixed_cloud_curl");
  else if (opposed10 || opposed1h) reasons.push("mtf_soft_oppose_ok");
  if (magnetAhead && magnet?.label) reasons.push(`magnet_${magnet.label}`);
  if (plan?.catalyst) reasons.push(`catalyst_${plan.catalyst}`);
  if (leaderFollow?.leader && leaderFollow.direction === direction) {
    reasons.push(`leader_follow_${String(leaderFollow.leader).toLowerCase()}`);
  }

  return {
    fires: true,
    family: CLOUD_PIVOT_FAMILY,
    direction,
    session,
    trigger,
    reasons,
    cloud_magnet: magnet,
    session_plan: plan,
    leader_follow: leaderFollow && leaderFollow.direction === direction ? leaderFollow : null,
    clouds: {
      c5_12: {
        bull: !!c512.bull,
        bear: !!c512.bear,
        crossUp,
        crossDn,
        inCloud: !!c512.inCloud,
        fastSlope: num(c512.fastSlope),
      },
      c34_50_10: bias10,
      c34_50_1h: bias1h,
    },
  };
}

export function hasTtCloudPivot(payload = {}, daCfg = {}) {
  return payload?.tt_cloud_pivot === true
    || payload?._sequence_queue_proposal?.family === CLOUD_PIVOT_FAMILY
    || payload?.slice_family === CLOUD_PIVOT_FAMILY
    || payload?._cloud_pivot_detect?.fires === true
    || !!detectTtCloudPivot(payload, daCfg)?.fires;
}

function attachCloudContext(out, payload, det) {
  const magnet = det?.cloud_magnet || resolveCloudMagnet(payload, det?.direction);
  const plan = det?.session_plan || buildCloudSessionPlan(payload, det?.direction);
  if (magnet) out._cloud_magnet = magnet;
  if (plan) out._cloud_session_plan = plan;
  if (det?.leader_follow) out._cloud_leader_follow = det.leader_follow;
  if (payload?._cloud_leader) out._cloud_leader = payload._cloud_leader;
  return out;
}

export function buildCloudPivotPaperQueueProposal(payload = {}, daCfg = {}) {
  const cfg = loadCloudPivotConfig(daCfg);
  if (!cfg.enabled) return null;
  const det = detectTtCloudPivot(payload, daCfg);
  if (!det?.fires) return null;
  return {
    state: "queued",
    family: CLOUD_PIVOT_FAMILY,
    paper: true,
    size_mult: cfg.sizeMult,
    reason: `tt_cloud_pivot:${det.reasons.slice(0, 4).join("+")}`,
    direction: det.direction,
    session: det.session,
    trigger: det.trigger,
    tt_cloud_pivot: true,
    cloud_magnet: det.cloud_magnet || null,
    session_plan: det.session_plan || null,
    ts: Date.now(),
  };
}

export function buildCloudPivotOptionsFirstPlay(payload = {}, daCfg = {}) {
  const enabled = String(daCfg.deep_audit_tt_cloud_pivot_options_first_enabled ?? "true") === "true";
  if (!enabled) return null;
  const det = detectTtCloudPivot(payload, daCfg);
  if (!det?.fires) return null;
  // Intraday curls are natural options expressions when RIDE or midday/day2.
  const mode = String(payload.confluence_mode || payload._confluence?.mode || "").toUpperCase();
  if (mode !== "RIDE" && !curlSession(det.session)) return null;
  return {
    play_vehicle: "options",
    vehicle: "options",
    why: "tt_cloud_pivot_options_first",
    family: CLOUD_PIVOT_FAMILY,
    paper: true,
    ts: Date.now(),
  };
}

/**
 * Stamp cloud pivot. Priority: confirm-stack > tt_cloud_pivot > momentum_continuation.
 */
export function stampTtCloudPivotThinSlice(payload, daCfg = {}) {
  if (!payload || typeof payload !== "object") return payload;
  const existingProp = payload._sequence_queue_proposal;
  if (existingProp?.family === "confirm_stack_ema21") {
    const det = detectTtCloudPivot(
      { ...payload, _sequence_queue_proposal: null },
      daCfg,
    );
    if (!det?.fires) return payload;
    return attachCloudContext(
      { ...payload, tt_cloud_pivot: true, _cloud_pivot_detect: det },
      payload,
      det,
    );
  }

  const proposal = buildCloudPivotPaperQueueProposal(payload, daCfg);
  const play = buildCloudPivotOptionsFirstPlay(payload, daCfg);
  if (!proposal && !play) {
    const det = detectTtCloudPivot(payload, daCfg);
    if (!det?.fires) return payload;
    return attachCloudContext(
      { ...payload, tt_cloud_pivot: true, _cloud_pivot_detect: det },
      payload,
      det,
    );
  }

  const out = { ...payload, tt_cloud_pivot: true };
  const canTakeProposal = !existingProp
    || existingProp.family === CLOUD_PIVOT_FAMILY
    || existingProp.family === "momentum_continuation";
  if (proposal && canTakeProposal) out._sequence_queue_proposal = proposal;
  if (play) {
    const existing = out._model_play || out.__model_play;
    if (!existing || existing.paper === true || !existing.play_vehicle
      || existing.family === "momentum_continuation") {
      out._model_play = { ...(existing || {}), ...play };
    }
  }
  const det = detectTtCloudPivot(payload, daCfg);
  out._cloud_pivot_detect = det;
  return attachCloudContext(out, payload, det);
}

export function cloudPivotPaperSizeMult(tickerData, daCfg = {}) {
  const proposal = tickerData?._sequence_queue_proposal;
  if (!proposal?.paper || proposal.family !== CLOUD_PIVOT_FAMILY) return 1;
  const cfg = loadCloudPivotConfig(daCfg);
  if (!cfg.enabled) return 1;
  const m = Number(proposal.size_mult);
  return Number.isFinite(m) && m > 0 && m <= 1 ? m : cfg.sizeMult;
}

/** True when an open trade belongs to this family. */
export function isTtCloudPivotTrade(trade = {}, tickerData = null) {
  if (!trade && !tickerData) return false;
  const path = String(
    trade?.entry_path
    || trade?.__entry_path
    || tickerData?.__entry_path
    || "",
  ).toLowerCase().trim();
  // Canonical core paths keep their own exits. A coincident paper stamp
  // must not overlay Cloud Pivot 5/12 / 34/50 exits on Support Bounce / ATH.
  if (path && isCanonicalCapitalEntryPath(path) && !path.includes("cloud_pivot")) {
    return false;
  }
  const fam = String(
    trade?.slice_family
    || trade?.entry_family
    || trade?.__entry_family
    || trade?.model_play?.family
    || trade?.__model_play?.family
    || tickerData?.slice_family
    || tickerData?._sequence_queue_proposal?.family
    || tickerData?.__model_play?.family
    || tickerData?._model_play?.family
    || "",
  );
  if (fam === CLOUD_PIVOT_FAMILY) return true;
  const name = String(trade?.setup_name || tickerData?.__entry_path || path || "").toLowerCase();
  return name.includes("tt_cloud_pivot") || name.includes("cloud_pivot");
}

function isTighterStop(direction, nextPx, prevPx) {
  const next = finiteOrNull(nextPx);
  if (next == null) return false;
  const prev = finiteOrNull(prevPx);
  if (prev == null) return true;
  return direction === "LONG" ? next > prev + 1e-9 : next < prev - 1e-9;
}

function persistRibbon(openPosition, tickerData, ribbon) {
  if (openPosition && typeof openPosition === "object") {
    openPosition.tt_cloud_pivot_ribbon = ribbon;
    if (ribbon?.trail_px != null) openPosition.tt_cloud_pivot_trail_px = ribbon.trail_px;
  }
  if (tickerData && typeof tickerData === "object") {
    tickerData.__tt_cloud_pivot_ribbon = ribbon;
  }
}

/**
 * Family-specific exit — anti-giveback + magnet cover + ribbon trail.
 * @returns {null|{ stage, reason, family, metadata }}
 */
export function evaluateTtCloudPivotExit(ctx = {}) {
  const {
    tickerData,
    openPosition,
    direction: dirIn,
    currentPrice,
    pnlPct,
    positionAgeMin,
    trimmedPct,
    daCfg = {},
  } = ctx;
  const cfg = loadCloudPivotConfig(daCfg);
  if (!cfg.exitEnabled) return null;
  if (!isTtCloudPivotTrade(openPosition, tickerData)) return null;

  const direction = String(dirIn || openPosition?.direction || "LONG").toUpperCase() === "SHORT"
    ? "SHORT" : "LONG";
  const rt10 = tfRipster(tickerData, "10");
  const rt1H = tfRipsterAny(tickerData, ["1H", "60"]);
  const c512 = rt10?.c5_12;
  if (!c512) return null;

  const lose512 = direction === "LONG"
    ? !!(c512.crossDn || (c512.bear && c512.below))
    : !!(c512.crossUp || (c512.bull && c512.above));

  const c34_10 = rt10?.c34_50;
  const c34_1h = rt1H?.c34_50;
  const lose3450Mtf = direction === "LONG"
    ? !!((c34_10?.bear || c34_10?.below) && (c34_1h?.bear || c34_1h?.below))
    : !!((c34_10?.bull || c34_10?.above) && (c34_1h?.bull || c34_1h?.above));

  const age = Number(positionAgeMin) || 0;
  const pnl = Number(pnlPct) || 0;
  const trimmed = Number(trimmedPct) || 0;
  const px = firstFinite(currentPrice, cloudPivotMarkPx(tickerData));
  const atr = cloudPivotAtr(tickerData);
  const mfe = Math.abs(firstFinite(
    ctx.mfePct,
    openPosition?.maxFavorableExcursion,
    openPosition?.max_favorable_excursion,
    openPosition?.mfePct,
    openPosition?.__tradeRef?.maxFavorableExcursion,
    tickerData?.__mfe_pct,
  ) || 0);

  // Pending debounce on payload/position (scoring cycles ≈ bars).
  const prev = Math.max(
    Number(openPosition?.tt_cloud_pivot_pending_5_12) || 0,
    Number(tickerData?.__tt_cloud_pivot_pending_5_12) || 0,
  );
  const pending = lose512 ? prev + 1 : 0;
  if (openPosition) openPosition.tt_cloud_pivot_pending_5_12 = pending;
  if (tickerData) tickerData.__tt_cloud_pivot_pending_5_12 = pending;

  const magnet = tickerData?._cloud_magnet
    || resolveCloudMagnet(tickerData, direction, px);
  if (age >= 5 && px != null && cloudMagnetTagged(px, magnet, atr)) {
    const meta = { direction, currentPrice: px, magnet, mfePct: mfe };
    if (pnl > 0.2 && trimmed < 0.5) {
      return {
        stage: "trim",
        reason: "tt_cloud_pivot_magnet_tag_trim",
        family: CLOUD_PIVOT_FAMILY,
        metadata: meta,
      };
    }
    if (trimmed >= 0.5) {
      return {
        stage: "exit",
        reason: "tt_cloud_pivot_magnet_tag_cover",
        family: CLOUD_PIVOT_FAMILY,
        metadata: meta,
      };
    }
  }

  // Primary Ripster rule: lose 5/12 → get out (after brief confirm).
  if (age >= 10 && lose512) {
    if (pending < 2) {
      return {
        stage: "defend",
        reason: "tt_cloud_pivot_5_12_pending",
        family: CLOUD_PIVOT_FAMILY,
        metadata: { pending, direction },
      };
    }
    if (pnl > 0.3 && trimmed < 0.5) {
      return {
        stage: "trim",
        reason: "tt_cloud_pivot_5_12_close_trim",
        family: CLOUD_PIVOT_FAMILY,
        metadata: { pnlPct: pnl, direction },
      };
    }
    return {
      stage: "exit",
      reason: "tt_cloud_pivot_5_12_close_exit",
      family: CLOUD_PIVOT_FAMILY,
      metadata: { pnlPct: pnl, direction },
    };
  }

  if (age >= 30 && lose3450Mtf) {
    return {
      stage: "exit",
      reason: "tt_cloud_pivot_34_50_mtf_exit",
      family: CLOUD_PIVOT_FAMILY,
      metadata: { direction, currentPrice: px },
    };
  }

  // Ribbon trail: after MFE, ratchet stop to last held 5/12, then 34/50.
  // Does not replace the hard 5/12-loss exit above.
  if (age >= 10 && !lose512 && mfe >= 0.5 && px != null) {
    const held512 = direction === "LONG"
      ? finiteOrNull(c512.lo)
      : finiteOrNull(c512.hi);
    const held34 = direction === "LONG"
      ? firstFinite(c34_10?.lo, c34_1h?.lo)
      : firstFinite(c34_10?.hi, c34_1h?.hi);
    const use34 = mfe >= 1.2 && held34 != null;
    const trailPx = use34 ? held34 : held512;
    const band = use34 ? "34_50" : "5_12";
    const stillHeld = direction === "LONG"
      ? (trailPx != null && px > trailPx)
      : (trailPx != null && px < trailPx);
    const prevRibbon = openPosition?.tt_cloud_pivot_ribbon
      || tickerData?.__tt_cloud_pivot_ribbon
      || null;
    const prevTrail = firstFinite(
      prevRibbon?.trail_px,
      openPosition?.tt_cloud_pivot_trail_px,
      openPosition?.sl,
      openPosition?.stop_loss,
    );
    if (stillHeld && isTighterStop(direction, trailPx, prevTrail)) {
      const ribbon = { band, trail_px: trailPx, mfePct: mfe, ts: Date.now() };
      persistRibbon(openPosition, tickerData, ribbon);
      return {
        stage: "defend",
        reason: "tt_cloud_pivot_ribbon_trail",
        family: CLOUD_PIVOT_FAMILY,
        metadata: { direction, trail_px: trailPx, band, mfePct: mfe },
      };
    }
  }

  return null;
}

/**
 * Session-free tape read. Ripster's minions still stare on nights/weekends;
 * detectTtCloudPivot stays gated to RTH windows for paper entries.
 */
export function inspectTtCloudPivot(payload = {}) {
  if (!payload || typeof payload !== "object") return null;
  const px = cloudPivotMarkPx(payload);
  const curl = detectTenMinCurl(payload);
  const rt10 = tfRipster(payload, "10");
  const rt1h = tfRipsterAny(payload, ["1H", "60"]);
  if (!rt10?.c5_12 && !rt1h?.c34_50) return null;
  const bias10 = cloudSide(rt10?.c34_50);
  const bias1h = cloudSide(rt1h?.c34_50);
  const direction = curl?.direction || bias1h || bias10 || null;
  const magnet = resolveCloudMagnet(payload, direction, px);
  const plan = buildCloudSessionPlan(payload, direction);
  const atr = cloudPivotAtr(payload);
  let distPct = null;
  if (px != null && magnet?.px != null && px > 0) {
    distPct = (Math.abs(px - magnet.px) / px) * 100;
  }
  const approaching = distPct != null && distPct <= 0.40;
  const mixed = !!(curl?.direction && bias10 && bias10 !== curl.direction);
  return {
    px,
    atr,
    direction,
    curl,
    bias10,
    bias1h,
    mixed,
    magnet,
    dist_pct: distPct,
    approaching,
    tagged: px != null && cloudMagnetTagged(px, magnet, atr),
    session_plan: plan,
    day2: isDay2CurlEligible(payload),
    catalyst: hasLiveCatalyst(payload),
    one_h_sloping_against: cloudSlopingAgainst(rt1h?.c34_50, direction),
    leader: payload._cloud_leader || null,
    leader_follow: payload._cloud_leader_follow || null,
  };
}

export function rankCloudPivotDeskRow(ticker, payload = {}, opts = {}) {
  const insp = inspectTtCloudPivot(payload);
  const det = opts.skipDetect ? null : detectTtCloudPivot(payload, opts.daCfg || {}, opts);
  const fires = !!(det?.fires || payload.tt_cloud_pivot === true
    || payload._cloud_pivot_detect?.fires === true);
  if (!insp) {
    if (!fires) return null;
    return {
      ticker: String(ticker || payload.ticker || "").toUpperCase(),
      role: "fire",
      score: 100,
      direction: det?.direction || payload._cloud_pivot_detect?.direction || null,
      why: ["fires"],
      fires: true,
      session: det?.session || payload._cloud_pivot_detect?.session || null,
      px: cloudPivotMarkPx(payload),
      curl: null,
      bias10: null,
      bias1h: null,
      mixed: false,
      magnet: payload._cloud_magnet || null,
      dist_pct: null,
      approaching: false,
      session_plan: payload._cloud_session_plan || null,
      day2: false,
      leader: payload._cloud_leader || null,
      leader_follow: payload._cloud_leader_follow || null,
    };
  }
  let score = 0;
  const why = [];
  if (fires) { score += 100; why.push("fires"); }
  if (insp.curl) { score += 20; why.push(insp.curl.trigger); }
  if (insp.magnet?.ahead) { score += 20; why.push(`magnet_${insp.magnet.label}`); }
  if (insp.tagged) { score += 18; why.push("magnet_tag"); }
  else if (insp.approaching) { score += 25; why.push("magnet_close"); }
  else if (insp.dist_pct != null && insp.dist_pct <= 1.0) { score += 12; why.push("magnet_near"); }
  if (insp.mixed && insp.magnet?.ahead) { score += 15; why.push("mixed_cloud"); }
  if (insp.day2) { score += 20; why.push("day2"); }
  if (insp.leader) { score += 25; why.push(`leader_${insp.leader.symbol || ticker}`); }
  if (insp.leader_follow) { score += 20; why.push(`follow_${insp.leader_follow.leader}`); }
  if (insp.session_plan) { score += 10; why.push("ifthen"); }
  if (insp.curl && insp.bias1h && insp.curl.direction === insp.bias1h) {
    score += 8;
    why.push("1h_aligned");
  }
  if (insp.one_h_sloping_against && !insp.magnet?.ahead) {
    score -= 40;
    why.push("1h_against_no_magnet");
  }

  let role = "watch";
  if (fires) role = "fire";
  else if (insp.leader) role = "leader";
  else if (insp.leader_follow && insp.curl) role = "follow";
  else if (insp.session_plan && (insp.curl || insp.approaching)) role = "catalyst";
  else if (score >= 40) role = "stalk";

  return {
    ticker: String(ticker || payload.ticker || "").toUpperCase(),
    role,
    score,
    direction: det?.direction || insp.direction || null,
    why,
    fires,
    session: det?.session || null,
    px: insp.px,
    curl: insp.curl,
    bias10: insp.bias10,
    bias1h: insp.bias1h,
    mixed: insp.mixed,
    magnet: insp.magnet,
    dist_pct: insp.dist_pct,
    approaching: insp.approaching,
    session_plan: insp.session_plan,
    day2: insp.day2,
    leader: insp.leader,
    leader_follow: insp.leader_follow,
  };
}

/**
 * Book-wide Cloud Pivot desk — the super-minion pass.
 * Annotates leader/follower curls, then ranks fire / stalk / leader / if-then.
 */
export function buildCloudPivotDesk(rows = [], opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  try { annotateCloudPivotLeaderFollows(list); } catch { /* */ }
  const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : 30;
  const limit = Math.min(Math.max(Number(opts.limit) || 24, 1), 80);
  const items = [];
  for (const row of list) {
    const sym = String(row?.sym || row?.ticker || row?.t?.ticker || "").toUpperCase();
    const t = row?.t && typeof row.t === "object" ? row.t : row;
    if (!sym || !t || typeof t !== "object") continue;
    const ranked = rankCloudPivotDeskRow(sym, t, opts);
    if (!ranked || ranked.score < minScore) continue;
    items.push(ranked);
  }
  items.sort((a, b) => (b.score - a.score) || a.ticker.localeCompare(b.ticker));
  const watching = items.slice(0, limit);
  return {
    generated_at: Date.now(),
    scanned: list.length,
    count: watching.length,
    watching,
    fires: watching.filter((x) => x.role === "fire"),
    leaders: watching.filter((x) => x.role === "leader" || x.role === "follow" || x.leader || x.leader_follow),
    catalysts: watching.filter((x) => x.role === "catalyst" || x.session_plan),
    stalks: watching.filter((x) => x.role === "stalk"),
  };
}

/**
 * Day-trade strip grammar for a Cloud Desk watch row.
 * FIRE → BUY (paper); everything else stays WAIT.
 */
export function cloudDeskPlanCopy(w = {}) {
  const ticker = String(w.ticker || "").toUpperCase();
  const role = String(w.role || "watch").toLowerCase();
  const dir = String(w.direction || "").toUpperCase();
  const magPx = Number(w.magnet?.px);
  const magBit = Number.isFinite(magPx) && magPx > 0 ? `$${magPx.toFixed(2)}` : "";
  const action = role === "fire" ? "BUY" : "WAIT";
  const leader = String(w.leader_follow?.leader || w.leader?.symbol || "").toUpperCase();
  const playWord = role === "fire" ? "Cloud Pivot fire, paper size"
    : role === "leader" ? "leader curl"
    : role === "follow" ? `follow ${leader || "leader"}`
    : role === "catalyst" ? "catalyst if/then"
    : role === "stalk" ? "magnet stalk"
    : "desk watch";
  const punchBits = [playWord];
  if (magBit) punchBits.push(`toward ${magBit}`);
  const punch = `${action} on ${ticker} — ${punchBits.join(" ")}`.replace(/\s+/g, " ").trim();
  const plan = w.session_plan;
  const gatePx = dir === "SHORT" ? Number(plan?.short_under) : Number(plan?.long_over);
  const scan = [
    role === "fire" ? "Paper 0.1\u00d7" : "Watch only",
    magBit ? `magnet ${magBit}` : null,
    Number.isFinite(gatePx) && gatePx > 0
      ? (dir === "SHORT" ? `short < $${gatePx.toFixed(2)}` : `long > $${gatePx.toFixed(2)}`)
      : null,
    w.day2 ? "day2" : null,
    w.mixed ? "mixed cloud OK" : null,
    leader && role !== "follow" ? `lead ${leader}` : null,
    w.session ? String(w.session).replace(/_/g, " ") : "10m 5/12",
  ].filter(Boolean).join(" \u00b7 ");
  return { action, role, punch, scan, magBit, leader };
}
