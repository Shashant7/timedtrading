// worker/playbooks.js
//
// Armed Playbooks — Phase 1 of the context-first scoring plan
// (tasks/2026-08-05-context-first-scoring-plan.md).
//
// Instead of re-deriving "is this a setup?" from scratch every 5 minutes,
// the engine PRE-ARMS specific plays when the frame digest shows price
// approaching a respected structural anchor. Each armed entry carries its
// trigger, invalidation, and confidence, so the per-cycle check collapses
// to "did the trigger fire?". SHADOW ONLY in Phase 1 — trigger events are
// recorded to decision_records (event_type CONTEXT_SHADOW), no capital.
//
// Day-1 shadow revision (2026-08-06): the first live session produced 83
// invalidations and 0 triggers. Three design bugs fixed here:
//   1. Triggers depended on session lows that are not on the payload —
//      now a trigger is a STATE TRANSITION (last_state testing/below →
//      approaching/above), plus a ledger fast path: a fresh held/pending
//      structural_test fact with price already back above the band arms
//      AND triggers on the same cycle (the CAT bounce class).
//   2. daily_ema21_reclaim armed on "below" and ALSO invalidated on
//      "below" — instant churn. Invalidation now uses a DEEP fixed level
//      stamped at arm time (weekly −8%, daily −6% under the anchor), not
//      the state classifier's band edge.
//   3. Lifecycle: armed → triggered | invalidated | expired, one-shot with
//      cooldown (unchanged).

const DAY_MS = 86400000;

export const PLAYBOOKS_VERSION = 2;

export const PLAYBOOK_DEFS = Object.freeze({
  // CAT class: test of a respected Weekly EMA21 (confluence with Weekly ST
  // scores higher), trigger on the reclaim transition or a fresh ledger test.
  weekly_breakout_retest: {
    anchor: "W_EMA21",
    confluenceAnchor: "W_ST",
    armStates: ["approaching", "testing"],
    needsMemory: true, // respect OR >=1 held test
    ttlDays: 21,
    cooldownDays: 5,
    invalidationPct: 8,
    freshTestDays: 10, // ledger structural_test recency for the fast path
    baseConfidence: 45,
  },
  // ANET class: Daily EMA21 with earned respect, trigger on reclaim.
  daily_ema21_reclaim: {
    anchor: "D_EMA21",
    confluenceAnchor: null,
    armStates: ["approaching", "testing", "below"],
    needsRespect: true, // stricter: respect flag required
    ttlDays: 7,
    cooldownDays: 3,
    invalidationPct: 6,
    freshTestDays: 4,
    baseConfidence: 40,
  },
});

const MAX_ARMED = 6;
const RECLAIMED_STATES = ["approaching", "above"];
const UNDER_STATES = ["testing", "below"];

function anchorMemoryOk(def, fa) {
  if (!fa) return false;
  if (def.needsRespect) return fa.respect === true;
  if (def.needsMemory) return fa.respect === true || (Number(fa.held) || 0) >= 1;
  return true;
}

function computeConfidence(def, fa, confluenceFa, frames) {
  let c = def.baseConfidence;
  if (fa.respect) c += 20;
  else c += Math.min(16, (Number(fa.held) || 0) * 8);
  const confluenceLive = confluenceFa
    && ["approaching", "testing"].includes(confluenceFa.state);
  if (confluenceLive) c += 15;
  if (Number(frames?.median_move_pct) >= 8) c += 5;
  if (Number(fa.failed) > 0) c -= 10 * Number(fa.failed);
  return Math.max(0, Math.min(95, Math.round(c)));
}

/** Fresh ledger test of this anchor (held or still pending) inside the window. */
function hasFreshLedgerTest(frames, anchor, maxDays) {
  return (frames?.recent_tests || []).some((t) =>
    t?.anchor === anchor
    && Number(t.days_ago) <= maxDays
    && (t.resolution === "held" || t.resolution === "pending"));
}

function makeEvent(kind, entry, price, now) {
  return {
    kind,
    playbook: entry.playbook,
    anchor: entry.anchor,
    ts: now,
    armed_ts: entry.armed_ts,
    price,
    level: entry.level,
    confidence: entry.confidence,
    confluence: entry.confluence === true,
  };
}

/**
 * Advance the armed-playbook state machine one cycle.
 * Pure. Returns { armed, events }; events are trigger/invalidate
 * transitions the caller records as shadow decisions.
 *
 * @param {object} args.frames  frame digest from buildFrameDigest
 * @param {Array}  args.prior   previous cycle's _armed_playbooks
 * @param {number} args.now
 */
export function updateArmedPlaybooks({ frames = null, prior = [], now = Date.now() } = {}) {
  const events = [];
  const out = [];
  const anchors = frames?.anchors || {};
  const price = Number(frames?.price) || null;

  const liveByPlaybook = {};

  // 1) Advance existing entries.
  for (const entry of Array.isArray(prior) ? prior : []) {
    if (!entry || !entry.playbook || !PLAYBOOK_DEFS[entry.playbook]) continue;
    const def = PLAYBOOK_DEFS[entry.playbook];
    const e = { ...entry };

    if (e.status !== "armed") {
      // Dormant (resolved) — keep for cooldown, drop when it lapses.
      const resolvedTs = Number(e.resolved_ts) || Number(e.triggered_ts) || 0;
      if (now - resolvedTs < def.cooldownDays * DAY_MS) {
        out.push(e);
        liveByPlaybook[e.playbook] = e;
      }
      continue;
    }

    const fa = anchors[e.anchor] || null;

    if (now > Number(e.expires_ts)) {
      e.status = "expired";
      e.resolved_ts = now;
      out.push(e);
      liveByPlaybook[e.playbook] = e;
      continue;
    }

    if (fa && fa.level > 0 && price > 0) {
      const lastState = e.last_state || e.armed_state || null;
      // Invalidation: DEEP fixed level from arm time — a routine band
      // breach (state "below") must NOT stand the playbook down; that is
      // the dip a reclaim play exists to wait through.
      if (price < Number(e.invalidation_level)) {
        e.status = "invalidated";
        e.resolved_ts = now;
        events.push(makeEvent("invalidated", e, price, now));
      } else if (UNDER_STATES.includes(lastState) && RECLAIMED_STATES.includes(fa.state)) {
        // Reclaim transition: was at/under the level, now cleared the band.
        e.status = "triggered";
        e.triggered_ts = now;
        e.resolved_ts = now;
        e.trigger_price = price;
        events.push(makeEvent("triggered", e, price, now));
      }
      e.level = fa.level; // levels drift with the EMA
      e.last_state = fa.state;
    }
    out.push(e);
    liveByPlaybook[e.playbook] = e;
  }

  // 2) Arm new entries. A bounce can complete BETWEEN cycles (the CAT
  //    miss), so a fresh ledger test of the anchor with price already back
  //    above the band arms AND triggers on the same cycle.
  if (frames && price > 0) {
    for (const [name, def] of Object.entries(PLAYBOOK_DEFS)) {
      if (liveByPlaybook[name]) continue; // armed or cooling down
      const fa = anchors[def.anchor];
      if (!fa || !(fa.level > 0)) continue;
      const immediate = RECLAIMED_STATES.includes(fa.state)
        && hasFreshLedgerTest(frames, def.anchor, def.freshTestDays);
      if (!immediate && !def.armStates.includes(fa.state)) continue;
      if (!anchorMemoryOk(def, fa)) continue;
      const confluenceFa = def.confluenceAnchor ? anchors[def.confluenceAnchor] : null;
      const confluence = !!(confluenceFa
        && ["approaching", "testing"].includes(confluenceFa.state));
      const entry = {
        v: PLAYBOOKS_VERSION,
        id: `${name}:${def.anchor}`,
        playbook: name,
        anchor: def.anchor,
        status: "armed",
        armed_ts: now,
        expires_ts: now + def.ttlDays * DAY_MS,
        level: fa.level,
        armed_state: fa.state,
        last_state: fa.state,
        trigger: { kind: "reclaim_hold" },
        invalidation_level: Math.round(fa.level * (1 - def.invalidationPct / 100) * 100) / 100,
        confidence: computeConfidence(def, fa, confluenceFa, frames),
        confluence,
      };
      if (immediate) {
        entry.status = "triggered";
        entry.triggered_ts = now;
        entry.resolved_ts = now;
        entry.trigger_price = price;
        events.push(makeEvent("triggered", entry, price, now));
      }
      out.push(entry);
    }
  }

  return { armed: out.slice(0, MAX_ARMED), events };
}
