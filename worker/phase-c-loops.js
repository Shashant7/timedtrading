/**
 * Phase C — The Three Loops
 * ==========================
 * Self-adapting feedback loops that turn the engine into a system that
 * watches itself the way a human would. All three loops are gated by
 * individual DA flags so each can be killed independently:
 *
 *   loop1_specialization_enabled    — scorecard at entry time
 *   loop2_circuit_breaker_enabled   — pulse + auto-pause when bleeding
 *   loop3_personality_management_enabled — personality-aware exits
 *
 * Each loop has:
 *   - One canonical KV key (or a small key family) for state
 *   - One pure function the engine calls at the right hook point
 *   - A `loop_event` record appended to entry_signals.loop_events when it
 *     acts, so the monthly verdict can audit it later
 *
 * No surprises:
 *   - Loops are READ-ONLY at entry time except for the scorecard updater
 *     which fires AFTER a trade closes
 *   - Every loop returns a structured decision object so the calling code
 *     can choose to enforce or just log
 *   - Nothing throws — failure modes return "no opinion" so a broken loop
 *     never blocks the engine
 */

// ─────────────────────────────────────────────────────────────────────
// Loop 1 — Specialization Scorecard
// ─────────────────────────────────────────────────────────────────────
// One KV record per (setup × regime × personality × side) combo.
// Records last 20 trade outcomes. At entry time we consult: if the combo's
// last-20 win rate is below the threshold, raise the entry bar (or block).

/* Loop 1 storage: a single KV master key holding a map of all combo
   scorecards. One read per scoring cycle (in cron pre-pass), one
   read-modify-write per closed trade. Eliminates the JIT-fetch problem
   (qualify path is sync; we can't await per-combo). */
const LOOP1_MASTER_KEY = "phase-c:scorecards";
const LOOP1_RING_SIZE = 20;
const LOOP1_DEFAULT_MIN_SAMPLES = 8;     // need 8 samples before any judgment
const LOOP1_DEFAULT_BAR_RAISE_WR = 0.45; // <45% WR → raise the bar
const LOOP1_DEFAULT_BAR_BLOCK_WR = 0.30; // <30% WR → block entirely

/**
 * Combo key string. Stable, lowercase, safe.
 * Combo dimensions:
 *   setup:        entry_path / setup_name (e.g. "tt_pullback")
 *   regime:       regime_class (e.g. "TRENDING_UP")
 *   personality:  ticker_personality (e.g. "VOLATILE_RUNNER")
 *   side:         "L" or "S"
 */
function loop1Key({ setup, regime, personality, side }) {
  const safe = (s) => String(s || "unknown").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const sideKey = String(side || "").toUpperCase().startsWith("S") ? "S" : "L";
  return `${safe(setup)}:${safe(regime)}:${safe(personality)}:${sideKey}`;
}

/**
 * Read the master scorecards map. Returns an object keyed by combo string.
 * Shape per entry:
 *   { ring: [+1,+1,-1,...]  // 1 = win, -1 = loss, 0 = flat
 *     samples: integer (length of ring),
 *     wins: integer,
 *     losses: integer,
 *     last_updated_ms: number }
 */
async function loop1ReadAllScorecards(KV) {
  if (!KV) return {};
  try {
    const raw = await KV.get(LOOP1_MASTER_KEY, { type: "json" });
    return raw && typeof raw === "object" ? raw : {};
  } catch (_) {
    return {};
  }
}

/**
 * Compute the entry-time advisory for every combo in the map.
 * Pre-evaluation lets the sync entry-gate read from a plain object map.
 * Returns: { [comboKey]: { decision, reason, samples, wr } }
 */
function loop1ComputeAdvisoryMap(scorecardsMap, daCfg) {
  const minSamples = Number(daCfg?.loop1_min_samples) || LOOP1_DEFAULT_MIN_SAMPLES;
  const raiseWr = Number(daCfg?.loop1_raise_bar_wr) || LOOP1_DEFAULT_BAR_RAISE_WR;
  const blockWr = Number(daCfg?.loop1_block_wr) || LOOP1_DEFAULT_BAR_BLOCK_WR;
  const out = {};
  for (const [combo, card] of Object.entries(scorecardsMap || {})) {
    if (!card || (card.samples || 0) < minSamples) continue; // no opinion
    const wr = (card.wins || 0) / (card.samples || 1);
    if (wr <= blockWr) {
      out[combo] = { decision: "block", reason: `wr_${(wr * 100).toFixed(0)}_below_block`, wr, samples: card.samples };
    } else if (wr <= raiseWr) {
      out[combo] = { decision: "raise_bar", reason: `wr_${(wr * 100).toFixed(0)}_below_raise`, wr, samples: card.samples };
    }
    // No entry written for "allow" — absence implies allow.
  }
  return out;
}

/**
 * Read a single combo (used in tests / inspection only).
 */
async function loop1ReadScorecard(KV, comboKey) {
  const all = await loop1ReadAllScorecards(KV);
  return all[comboKey] || null;
}

/**
 * Update a combo's scorecard after a closed trade.
 * Pass status in {"WIN", "LOSS", "FLAT"}.
 *
 * Uses read-modify-write on the master map. Race: two close events in the
 * same second could lose one update. Acceptable — we're tracking last 20,
 * not exact totals. The next update will pull the merged state.
 */
async function loop1RecordOutcome(KV, ctx, status) {
  if (!KV) return;
  const key = loop1Key(ctx);
  const all = await loop1ReadAllScorecards(KV);
  const card = all[key] || { ring: [], wins: 0, losses: 0, samples: 0 };
  const flag = status === "WIN" ? 1 : status === "LOSS" ? -1 : 0;
  card.ring = Array.isArray(card.ring) ? card.ring : [];
  card.ring.push(flag);
  if (card.ring.length > LOOP1_RING_SIZE) {
    card.ring.shift();
  }
  card.samples = card.ring.length;
  card.wins = card.ring.filter((x) => x === 1).length;
  card.losses = card.ring.filter((x) => x === -1).length;
  card.last_updated_ms = Date.now();
  all[key] = card;
  try {
    await KV.put(LOOP1_MASTER_KEY, JSON.stringify(all));
  } catch (_) {
    /* best-effort; never block the engine */
  }
}

// ─────────────────────────────────────────────────────────────────────
// Loop 2 — Circuit Breaker
// ─────────────────────────────────────────────────────────────────────
// Pulse written hourly to KV. If recent performance is bad, set
// engine_paused=true until next session open. Existing exits keep working;
// new entries are blocked at the gate.

const LOOP2_PULSE_KEY = "phase-c:engine-pulse";
const LOOP2_PAUSE_KEY = "phase-c:engine-paused";
const LOOP2_DEFAULT_BREAKER_WR = 0.30;       // last-10 WR < 30% → trip
const LOOP2_DEFAULT_BREAKER_DAY_PNL = -1.5;  // today PnL < -1.5% → trip
const LOOP2_DEFAULT_BREAKER_CONSEC_LOSS = 4; // 4 consecutive losses → trip

/**
 * Compute the pulse from the most recent N closed trades.
 * `trades` is a chronological list with status, pnl_pct, exit_ts.
 */
function loop2ComputePulse(trades, opts = {}) {
  const window = Number(opts.window) || 10;
  // `nowMs` lets the backtest replay anchor "today" to the simulated date
  // instead of the wall-clock date. Live cron leaves it undefined so it
  // continues to use real Date.now().
  const nowMs = Number(opts.nowMs) || Date.now();
  const closed = (Array.isArray(trades) ? trades : [])
    .filter((t) => {
      const s = String(t.status || "").toUpperCase();
      return s === "WIN" || s === "LOSS" || s === "FLAT";
    })
    .sort((a, b) => Number(a.exit_ts || 0) - Number(b.exit_ts || 0));
  const last = closed.slice(-window);
  const wins = last.filter((t) => String(t.status).toUpperCase() === "WIN").length;
  const last10WR = last.length > 0 ? wins / last.length : null;

  // Today P&L: sum pnl_pct of trades that exited today (NY tz, but UTC date is fine for engine purposes)
  const todayBoundaryMs = (() => {
    const d = new Date(nowMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  })();
  const todayClosed = closed.filter(
    (t) => Number(t.exit_ts || 0) >= todayBoundaryMs && Number(t.exit_ts || 0) <= nowMs
  );
  const todayPnl = todayClosed.reduce((s, t) => s + (Number(t.pnl_pct) || 0), 0);

  // Consecutive losses going back from most recent
  let consecLoss = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    if (String(closed[i].status).toUpperCase() === "LOSS") consecLoss += 1;
    else break;
  }

  return {
    last10_wr: last10WR,
    last10_n: last.length,
    today_pnl_pct: todayPnl,
    today_n: todayClosed.length,
    consec_losses: consecLoss,
    pulse_ts_ms: nowMs,
  };
}

/**
 * Decide whether to trip the breaker. Returns one of:
 *   { trip: false }
 *   { trip: true, reason: "wr_low_25%" | "today_pnl_-2.0%" | "consec_5" }
 */
function loop2EvaluatePulse(pulse, daCfg) {
  const wrCap = Number(daCfg?.loop2_breaker_wr) || LOOP2_DEFAULT_BREAKER_WR;
  const dayCap = Number(daCfg?.loop2_breaker_day_pnl) || LOOP2_DEFAULT_BREAKER_DAY_PNL;
  const consecCap = Number(daCfg?.loop2_breaker_consec_loss) || LOOP2_DEFAULT_BREAKER_CONSEC_LOSS;
  if (pulse.last10_n >= 10 && pulse.last10_wr != null && pulse.last10_wr < wrCap) {
    return { trip: true, reason: `wr_${(pulse.last10_wr * 100).toFixed(0)}` };
  }
  if (pulse.today_n >= 3 && pulse.today_pnl_pct < dayCap) {
    return { trip: true, reason: `today_pnl_${pulse.today_pnl_pct.toFixed(2)}` };
  }
  if (pulse.consec_losses >= consecCap) {
    return { trip: true, reason: `consec_${pulse.consec_losses}` };
  }
  return { trip: false };
}

/**
 * Persist the pulse + (when tripped) the pause flag.
 * Pause auto-clears on next session open via TTL (live) or via an
 * explicit simulated-time check in `loop2ReadPause` (backtest).
 *
 * In backtest, `nowMs` is the simulated end-of-day timestamp so the
 * `tripped_at_ms` is in simulated time, not wall clock. The reader uses
 * the same nowMs to decide if the pause has expired (next session open).
 */
async function loop2WritePulse(KV, pulse, evaluation, daCfg, opts = {}) {
  if (!KV) return;
  if (String(daCfg?.loop2_circuit_breaker_enabled ?? "false") !== "true") return;
  const nowMs = Number(opts.nowMs) || Date.now();
  try {
    await KV.put(LOOP2_PULSE_KEY, JSON.stringify({ ...pulse, ...evaluation }), {
      expirationTtl: 3 * 24 * 60 * 60, // 3 days, plenty for review
    });
    if (evaluation.trip) {
      await KV.put(
        LOOP2_PAUSE_KEY,
        JSON.stringify({
          paused: true,
          reason: evaluation.reason,
          tripped_at_ms: nowMs,
          pulse,
        }),
        { expirationTtl: 18 * 60 * 60 }, // 18h: covers overnight; auto-clear next morning (live wall-clock)
      );
    }
  } catch (_) {}
}

/**
 * Read the current pause state. Returns { paused, reason, tripped_at_ms }
 * or { paused: false } if no pause is active.
 *
 * In backtest, pass `nowMs` (the simulated current time). The pause is
 * considered active for ~18 simulated hours after the trip, then this
 * function returns { paused: false } even though the KV record still
 * exists. Live cron leaves nowMs undefined and falls through to the
 * 18h KV TTL.
 */
async function loop2ReadPause(KV, opts = {}) {
  if (!KV) return { paused: false };
  try {
    const raw = await KV.get(LOOP2_PAUSE_KEY, { type: "json" });
    if (raw && raw.paused) {
      const nowMs = Number(opts?.nowMs) || 0;
      const trippedAt = Number(raw.tripped_at_ms) || 0;
      // Backtest: clear after 18 simulated hours to mirror live TTL behavior.
      if (nowMs > 0 && trippedAt > 0 && (nowMs - trippedAt) > 18 * 60 * 60 * 1000) {
        return { paused: false, reason: "simulated_ttl_expired", tripped_at_ms: trippedAt };
      }
      return raw;
    }
  } catch (_) {}
  return { paused: false };
}

/**
 * Entry-time consult. Returns { allow: true } unless the breaker is
 * currently tripped (in which case the entry is blocked).
 */
async function loop2AdviseEntry(KV, daCfg) {
  if (String(daCfg?.loop2_circuit_breaker_enabled ?? "false") !== "true") {
    return { allow: true, reason: "loop2_disabled" };
  }
  const pause = await loop2ReadPause(KV);
  if (pause.paused) {
    return {
      allow: false,
      reason: `breaker_tripped_${pause.reason}`,
      loop_event: { loop: 2, action: "block", reason: pause.reason },
    };
  }
  return { allow: true };
}

/**
 * Manual reset (admin / scheduled at session open). Clears the pause.
 */
async function loop2ResetBreaker(KV) {
  if (!KV) return;
  try { await KV.delete(LOOP2_PAUSE_KEY); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────
// Loop 3 — Personality-Aware Management
// ─────────────────────────────────────────────────────────────────────
// Personality (VOLATILE_RUNNER, PULLBACK_PLAYER, MEAN_REVERT, SLOW_GRINDER)
// modulates exit decisions. Each rule is a small pure function the existing
// kanban classifier consults.

const LOOP3_PROFILES = {
  VOLATILE_RUNNER: {
    // Aggressive: cut a flat trade fast (30 min), but let winners run further
    flat_cut_min_age_minutes: 30,
    mfe_peak_lock_retrace_pct: 0.6,   // give back up to 60% of MFE before lock
    trim_on_tp1: false,                // let it run to TP2/TP3
  },
  PULLBACK_PLAYER: {
    // Patient: pullbacks need room to reaccumulate
    flat_cut_min_age_minutes: 240,    // 4h before considering a flat cut
    mfe_peak_lock_retrace_pct: 0.4,   // tighter lock — pullback plays revert
    trim_on_tp1: true,
  },
  MEAN_REVERT: {
    // Decisive: TP hits = done
    flat_cut_min_age_minutes: 120,
    mfe_peak_lock_retrace_pct: 0.3,   // very tight lock
    trim_on_tp1: true,                 // force a trim at TP1
    force_full_exit_on_tp2: true,
  },
  SLOW_GRINDER: {
    // Patient: grinders need 1-2 days
    flat_cut_min_age_minutes: 60 * 24, // 24h before considering flat-cut
    mfe_peak_lock_retrace_pct: 0.5,
    trim_on_tp1: false,
  },
  // Fallback for tickers without a classification
  __DEFAULT: {
    flat_cut_min_age_minutes: 120,
    mfe_peak_lock_retrace_pct: 0.5,
    trim_on_tp1: false,
  },
};

/**
 * Profile lookup. Always returns an object (uses __DEFAULT for unknowns).
 */
function loop3ProfileFor(personality) {
  const key = String(personality || "").toUpperCase();
  return LOOP3_PROFILES[key] || LOOP3_PROFILES.__DEFAULT;
}

/**
 * Should an open trade with no MFE be cut for being flat?
 * Called from the existing fast-cut logic. Returns boolean PLUS the
 * profile that governed the decision so the loop log can audit it.
 *
 * `ageMinutes` = minutes since trade opened
 */
function loop3ShouldCutFlat(daCfg, personality, ageMinutes, mfePct) {
  if (String(daCfg?.loop3_personality_management_enabled ?? "false") !== "true") {
    return { cut: false, reason: "loop3_disabled" };
  }
  if (mfePct > 0.2) {
    // not flat — let other exits handle it
    return { cut: false, reason: "not_flat" };
  }
  const profile = loop3ProfileFor(personality);
  if (ageMinutes >= profile.flat_cut_min_age_minutes) {
    return {
      cut: true,
      reason: `personality_flat_cut_${String(personality || "DEFAULT").toLowerCase()}`,
      profile,
      loop_event: { loop: 3, action: "flat_cut", personality, age_min: ageMinutes },
    };
  }
  return { cut: false, reason: `under_age_${ageMinutes}_of_${profile.flat_cut_min_age_minutes}` };
}

/**
 * Should we lock profits via peak-trim given the personality?
 * Returns boolean + the threshold used.
 */
function loop3ShouldPeakLock(daCfg, personality, mfePct, currentRetracePct) {
  if (String(daCfg?.loop3_personality_management_enabled ?? "false") !== "true") {
    return { lock: false, reason: "loop3_disabled" };
  }
  if (mfePct < 1.0) return { lock: false, reason: "mfe_below_1pct" };
  const profile = loop3ProfileFor(personality);
  if (currentRetracePct >= profile.mfe_peak_lock_retrace_pct) {
    return {
      lock: true,
      reason: `peak_lock_${String(personality || "DEFAULT").toLowerCase()}`,
      threshold: profile.mfe_peak_lock_retrace_pct,
      loop_event: { loop: 3, action: "peak_lock", personality, retrace: currentRetracePct },
    };
  }
  return { lock: false, reason: `retrace_${currentRetracePct.toFixed(2)}_under_${profile.mfe_peak_lock_retrace_pct}` };
}

/**
 * On TP1 hit: should we force a trim? (MEAN_REVERT and PULLBACK_PLAYER yes,
 * VOLATILE_RUNNER and SLOW_GRINDER let it run)
 */
function loop3ShouldTrimAtTp1(daCfg, personality) {
  if (String(daCfg?.loop3_personality_management_enabled ?? "false") !== "true") {
    return { trim: false, reason: "loop3_disabled" };
  }
  const profile = loop3ProfileFor(personality);
  return {
    trim: profile.trim_on_tp1 === true,
    reason: profile.trim_on_tp1 ? `trim_${String(personality || "DEFAULT").toLowerCase()}` : `let_run_${String(personality || "DEFAULT").toLowerCase()}`,
    loop_event: profile.trim_on_tp1
      ? { loop: 3, action: "trim_tp1", personality }
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────

export {
  // Loop 1
  loop1Key,
  loop1ReadAllScorecards,
  loop1ComputeAdvisoryMap,
  loop1ReadScorecard,
  loop1RecordOutcome,
  // Loop 2
  loop2ComputePulse,
  loop2EvaluatePulse,
  loop2WritePulse,
  loop2ReadPause,
  loop2AdviseEntry,
  loop2ResetBreaker,
  // Loop 3
  loop3ProfileFor,
  loop3ShouldCutFlat,
  loop3ShouldPeakLock,
  loop3ShouldTrimAtTp1,
  // Constants for tests / inspection
  LOOP1_MASTER_KEY,
  LOOP2_PULSE_KEY,
  LOOP2_PAUSE_KEY,
  LOOP3_PROFILES,
};
