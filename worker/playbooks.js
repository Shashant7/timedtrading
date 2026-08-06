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
// Lifecycle: armed → triggered | invalidated | expired. One-shot: after
// resolution the entry stays (dormant) until its cooldown lapses, which
// prevents re-arm flapping on the same test.

const DAY_MS = 86400000;

export const PLAYBOOKS_VERSION = 1;

export const PLAYBOOK_DEFS = Object.freeze({
  // CAT class: week-low test of a respected Weekly EMA21 (confluence with
  // Weekly ST scores higher), trigger on the reclaim bounce.
  weekly_breakout_retest: {
    anchor: "W_EMA21",
    confluenceAnchor: "W_ST",
    armStates: ["approaching", "testing"],
    needsMemory: true, // respect OR >=1 held test
    ttlDays: 21,
    cooldownDays: 5,
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
    baseConfidence: 40,
  },
});

const MAX_ARMED = 6;

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
    && ["approaching", "testing", "reclaiming"].includes(confluenceFa.state);
  if (confluenceLive) c += 15;
  if (Number(frames?.median_move_pct) >= 8) c += 5;
  if (Number(fa.failed) > 0) c -= 10 * Number(fa.failed);
  return Math.max(0, Math.min(95, Math.round(c)));
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
    if (fa && fa.level > 0) e.level = fa.level; // levels drift with the EMA

    if (now > Number(e.expires_ts)) {
      e.status = "expired";
      e.resolved_ts = now;
      out.push(e);
      liveByPlaybook[e.playbook] = e;
      continue;
    }

    if (fa) {
      const deepBelow = fa.state === "below";
      const reclaimed = fa.state === "reclaiming";
      if (deepBelow) {
        e.status = "invalidated";
        e.resolved_ts = now;
        events.push({
          kind: "invalidated", playbook: e.playbook, anchor: e.anchor,
          ts: now, price, level: e.level, confidence: e.confidence,
          confluence: e.confluence === true,
        });
      } else if (reclaimed) {
        e.status = "triggered";
        e.triggered_ts = now;
        e.resolved_ts = now;
        e.trigger_price = price;
        events.push({
          kind: "triggered", playbook: e.playbook, anchor: e.anchor,
          ts: now, price, level: e.level, confidence: e.confidence,
          confluence: e.confluence === true,
        });
      }
    }
    out.push(e);
    liveByPlaybook[e.playbook] = e;
  }

  // 2) Arm new entries. A bounce can move approach→test→reclaim BETWEEN
  //    scoring cycles (the CAT miss), so "reclaiming" arms AND triggers on
  //    the same cycle instead of requiring a prior armed state.
  if (frames && price > 0) {
    for (const [name, def] of Object.entries(PLAYBOOK_DEFS)) {
      if (liveByPlaybook[name]) continue; // armed or cooling down
      const fa = anchors[def.anchor];
      if (!fa || !(fa.level > 0)) continue;
      const immediate = fa.state === "reclaiming";
      if (!immediate && !def.armStates.includes(fa.state)) continue;
      if (!anchorMemoryOk(def, fa)) continue;
      const confluenceFa = def.confluenceAnchor ? anchors[def.confluenceAnchor] : null;
      const confluence = !!(confluenceFa
        && ["approaching", "testing", "reclaiming"].includes(confluenceFa.state));
      const confidence = computeConfidence(def, fa, confluenceFa, frames);
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
        trigger: { kind: "reclaim_hold" },
        invalidation_level: Math.round(fa.level * (1 - 0.05) * 100) / 100,
        confidence,
        confluence,
      };
      if (immediate) {
        entry.status = "triggered";
        entry.triggered_ts = now;
        entry.resolved_ts = now;
        entry.trigger_price = price;
        events.push({
          kind: "triggered", playbook: name, anchor: def.anchor,
          ts: now, price, level: fa.level, confidence, confluence,
        });
      }
      out.push(entry);
    }
  }

  return { armed: out.slice(0, MAX_ARMED), events };
}
