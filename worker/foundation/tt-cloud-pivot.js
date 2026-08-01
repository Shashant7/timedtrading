// TT Cloud Pivot — intraday 10m 5/12 curl thin slice (paper first).
// plans/tt-cloud-pivot-slice.plan.md
//
// Geometry from Ripster-style EMA clouds, branded as Timed Trading:
//   10m 5/12 = ride / curl trigger
//   10m 34/50 = bias / risk
//   1H 34/50  = MTF magnet
// Exit anti-giveback: 10m candle loses 5/12 → trim/exit.

export const CLOUD_PIVOT_FAMILY = "tt_cloud_pivot";
export const CLOUD_PIVOT_PAPER_SIZE_MULT = 0.1;

/** Session windows (America/New_York minutes from midnight). */
export const CLOUD_PIVOT_WINDOWS = {
  open: { startMin: 9 * 60 + 30, endMin: 10 * 60 + 0, label: "open" },
  ten_am: { startMin: 10 * 60 + 0, endMin: 10 * 60 + 45, label: "ten_am" },
  midday: { startMin: 10 * 60 + 45, endMin: 13 * 60 + 30, label: "midday_curl" },
};

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

function tfRipster(payload, key) {
  return payload?.tf_tech?.[key]?.ripster || null;
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

export function resolveCloudPivotSession(ts = Date.now()) {
  const mins = nyMinutesFromMidnight(ts);
  if (mins == null) return null;
  for (const w of Object.values(CLOUD_PIVOT_WINDOWS)) {
    if (mins >= w.startMin && mins < w.endMin) return w.label;
  }
  return null;
}

function cloudSide(cloud) {
  if (!cloud || typeof cloud !== "object") return null;
  if (cloud.bull === true || cloud.above === true) return "LONG";
  if (cloud.bear === true || cloud.below === true) return "SHORT";
  return null;
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
  const session = resolveCloudPivotSession(asOf);
  if (!session) return null;

  // Opening noise: skip pure momentum chase in first N minutes of RTH for open window.
  const mins = nyMinutesFromMidnight(asOf);
  if (session === "open" && mins != null && mins < (9 * 60 + cfg.openNoiseEndMin)) {
    // Allow only reclaim/cross confirmation, not naked extension — handled below via requireCross.
  }

  const rt10 = tfRipster(payload, "10");
  const rt1H = tfRipster(payload, "1H") || tfRipster(payload, "60");
  if (!rt10?.c5_12) return null;

  const c512 = rt10.c5_12;
  const c3450_10 = rt10.c34_50 || null;
  const c3450_1h = rt1H?.c34_50 || null;
  const c89 = rt10.c8_9 || null;

  const crossUp = c512.crossUp === true;
  const crossDn = c512.crossDn === true;
  const bullRide = !!(c512.bull && (c512.above || c512.inCloud) && num(c512.fastSlope) >= 0);
  const bearRide = !!(c512.bear && (c512.below || c512.inCloud) && num(c512.fastSlope) <= 0);

  let direction = null;
  let trigger = null;
  if (crossUp || (session === "midday_curl" && bullRide && (c512.inCloud || crossUp))) {
    direction = "LONG";
    trigger = crossUp ? "5_12_cross_up" : "5_12_curl_bounce";
  } else if (crossDn || (session === "midday_curl" && bearRide && (c512.inCloud || crossDn))) {
    direction = "SHORT";
    trigger = crossDn ? "5_12_cross_dn" : "5_12_curl_reject";
  } else if (session !== "midday_curl" && bullRide && (crossUp || c89?.crossUp || c89?.bull)) {
    direction = "LONG";
    trigger = "5_12_open_hold";
  } else if (session !== "midday_curl" && bearRide && (crossDn || c89?.crossDn || c89?.bear)) {
    direction = "SHORT";
    trigger = "5_12_open_hold";
  }
  if (!direction) return null;

  // Open window: require an actual cross (avoid noise chase).
  if (session === "open" && !(crossUp || crossDn)) return null;

  const bias10 = cloudSide(c3450_10);
  const bias1h = cloudSide(c3450_1h);
  // Midday curls may flip vs morning bias (Ripster short→long). Soft check:
  // prefer aligned; allow opposed only on midday with a fresh cross.
  const opposed10 = bias10 && bias10 !== direction;
  const opposed1h = bias1h && bias1h !== direction;
  if (session !== "midday_curl" && opposed10 && opposed1h) return null;
  if (session === "midday_curl" && opposed10 && opposed1h && !(crossUp || crossDn)) return null;

  const life = String(payload._model_lifecycle?.state || payload.model_lifecycle?.state || "").toLowerCase();
  if (["bought", "held", "trimming", "exited"].includes(life)) return null;
  const stage = String(payload.kanban_stage || "").toLowerCase();
  if (["just_entered", "hold", "trim", "exit", "exited"].includes(stage)) return null;

  const reasons = [session, trigger];
  if (bias10) reasons.push(`10m_34_50_${bias10.toLowerCase()}`);
  if (bias1h) reasons.push(`1h_34_50_${bias1h.toLowerCase()}`);
  if (opposed10 || opposed1h) reasons.push("mtf_soft_oppose_ok");

  return {
    fires: true,
    family: CLOUD_PIVOT_FAMILY,
    direction,
    session,
    trigger,
    reasons,
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
    ts: Date.now(),
  };
}

export function buildCloudPivotOptionsFirstPlay(payload = {}, daCfg = {}) {
  const enabled = String(daCfg.deep_audit_tt_cloud_pivot_options_first_enabled ?? "true") === "true";
  if (!enabled) return null;
  const det = detectTtCloudPivot(payload, daCfg);
  if (!det?.fires) return null;
  // Intraday curls are natural options expressions when RIDE or midday.
  const mode = String(payload.confluence_mode || payload._confluence?.mode || "").toUpperCase();
  if (mode !== "RIDE" && det.session !== "midday_curl") return null;
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
    return { ...payload, tt_cloud_pivot: true, _cloud_pivot_detect: det };
  }

  const proposal = buildCloudPivotPaperQueueProposal(payload, daCfg);
  const play = buildCloudPivotOptionsFirstPlay(payload, daCfg);
  if (!proposal && !play) {
    const det = detectTtCloudPivot(payload, daCfg);
    if (!det?.fires) return payload;
    return { ...payload, tt_cloud_pivot: true, _cloud_pivot_detect: det };
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
  out._cloud_pivot_detect = detectTtCloudPivot(payload, daCfg);
  return out;
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
  const path = String(trade?.entry_path || trade?.setup_name || tickerData?.__entry_path || "").toLowerCase();
  return path.includes("tt_cloud_pivot") || path.includes("cloud_pivot");
}

/**
 * Family-specific exit — anti-giveback.
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
  const rt1H = tfRipster(tickerData, "1H") || tfRipster(tickerData, "60");
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

  // Pending debounce on payload/position (scoring cycles ≈ bars).
  const prev = Math.max(
    Number(openPosition?.tt_cloud_pivot_pending_5_12) || 0,
    Number(tickerData?.__tt_cloud_pivot_pending_5_12) || 0,
  );
  const pending = lose512 ? prev + 1 : 0;
  if (openPosition) openPosition.tt_cloud_pivot_pending_5_12 = pending;
  if (tickerData) tickerData.__tt_cloud_pivot_pending_5_12 = pending;

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
      metadata: { direction, currentPrice },
    };
  }

  return null;
}
