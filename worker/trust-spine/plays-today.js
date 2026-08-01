// Trust Spine — unified Today's Plays queue (server-side priority sort).
//
// Thin slices:
//   - confirm_stack_ema21 (plans/confirm-stack-ema21-slice.plan.md)
//   - momentum_continuation (plans/continuation-move-capture-slice.plan.md)
// Experts (sequence, character, RIDE, conviction) are inputs/chips — not modes.

import { hasMomentumContinuation } from "../foundation/continuation-paper-queue.js";

const MODE_RANK = { RIDE: 0, READY: 1, DRIFT: 2, FADE: 3, WAIT: 4, UNKNOWN: 5 };
const PLAY_LABELS = { shares: "Shares", letf: "Leveraged ETF", options: "Options" };
const CONFIRM_FAMILY = "confirm_stack_ema21";
const CONTINUATION_FAMILY = "momentum_continuation";

function playPriority(item) {
  const mode = String(item?.confluence_mode || item?.mode || "UNKNOWN").toUpperCase();
  const tier = String(item?.conviction_tier || item?.tier || "C").toUpperCase();
  const tierBoost = tier === "A" ? 0 : tier === "B" ? 10 : 20;
  const score = Number(item?.confluence_score || item?.score || 0);
  const familyBoost = item?.slice_family === CONFIRM_FAMILY ? -200
    : item?.slice_family === CONTINUATION_FAMILY ? -180
    : 0;
  const confirmBoost = item?.confirm_stack === true ? -50 : 0;
  const contBoost = item?.momentum_continuation === true ? -40 : 0;
  return (MODE_RANK[mode] ?? 5) * 1000 + tierBoost * 10 - score + familyBoost + confirmBoost + contBoost;
}

function boolGate(gates, key) {
  const g = gates?.[key];
  if (!g) return null;
  if (g.fires === true) return true;
  if (g.fires === false) return false;
  return null;
}

/** Pull thin-slice fields from a scored ticker payload (best-effort). */
export function extractSliceFields(t = {}) {
  const life = t._model_lifecycle || t.model_lifecycle || null;
  const play = t._model_play || t.model_play || life?.play || null;
  const playVehicle = play?.play_vehicle || (typeof play === "string" ? play : null) || null;
  const gates = t.setup_gates || null;
  const confirm = boolGate(gates, "stack_full_confirm");
  const runway = boolGate(gates, "gate_runway_full");
  const character = t._business_character || t.business_character
    || t.setup_shadow_business_character || null;
  const convictionTier = t.__conviction_tier || t.conviction_tier || null;
  const convictionScore = t.__conviction_score ?? t.conviction_score ?? null;
  const sequences = Array.isArray(t.setup_sequences) ? t.setup_sequences : [];
  const entryReady = sequences.some((s) => String(s?.status || "").toLowerCase() === "entry_ready");
  const posture = t.setup_shadow_posture?.posture || t.setup_shadow_posture || null;
  const confluenceMode = t.confluence_mode || t._confluence?.mode || t.confluence?.mode || null;
  const paperQ = t._sequence_queue_proposal || null;
  const continuation = t.momentum_continuation === true
    || paperQ?.family === CONTINUATION_FAMILY
    || hasMomentumContinuation(t, {});

  return {
    lifecycle: life ? {
      state: life.state || null,
      label: life.label || null,
      horizon: life.horizon || null,
      intent: life.intent || null,
      why: life.why || null,
    } : null,
    play_vehicle: playVehicle,
    play_label: playVehicle ? (PLAY_LABELS[playVehicle] || playVehicle) : null,
    play_why: play?.why || play?.label || null,
    confirm_stack: confirm,
    momentum_continuation: continuation || null,
    runway_full: runway,
    setup_gate_shadow: t.setup_gate_shadow === true,
    business_character: character?.archetype || null,
    character_lens: character?.technical_lens?.summary || character?.lens_summary || character?.summary || null,
    conviction_tier: convictionTier,
    conviction_score: convictionScore,
    sequence_entry_ready: entryReady,
    sequence_posture: typeof posture === "string" ? posture : null,
    confluence_mode: confluenceMode,
    sequence_paper_queue: paperQ ? {
      state: paperQ.state || "queued",
      paper: paperQ.paper !== false,
      size_mult: paperQ.size_mult ?? 0.1,
      reason: paperQ.reason || null,
      family: paperQ.family || null,
    } : null,
  };
}

/** Family admission: confirm-stack fired (shadow stamp) or explicit flag. */
export function isConfirmStackFamily(t = {}, slice = null) {
  const s = slice || extractSliceFields(t);
  if (s.confirm_stack === true) return true;
  const flags = t.flags || {};
  const reclaim = !!(flags.ema21_reclaim || t.__pullback_confirmed || flags.ripster_reclaim);
  const stFlip = !!(flags.st_flip_bull || flags.st_flip_bear || flags.supertrend_flip);
  const squeeze = !!(flags.sq30_release || flags.squeeze_release);
  return reclaim && stFlip && squeeze;
}

export function isContinuationFamily(t = {}, slice = null) {
  const s = slice || extractSliceFields(t);
  if (s.confirm_stack === true) return false; // confirm-stack wins
  if (s.momentum_continuation === true) return true;
  if (s.sequence_paper_queue?.family === CONTINUATION_FAMILY) return true;
  return hasMomentumContinuation(t, {});
}

function resolveFamily(t, slice) {
  if (isConfirmStackFamily(t, slice)) return CONFIRM_FAMILY;
  if (isContinuationFamily(t, slice)) return CONTINUATION_FAMILY;
  return null;
}

function pushPlay(items, base) {
  items.push({ ...base, priority: 0 });
}

/**
 * Merge options plays + ready setups + family scans into one queue.
 */
export function buildTodayPlaysQueue({
  optionsPlays = [],
  readySetups = [],
  confirmStackTickers = [],
  continuationTickers = [],
  limit = 20,
} = {}) {
  const items = [];

  for (const p of optionsPlays || []) {
    if (!p?.ticker) continue;
    const slice = extractSliceFields(p);
    const family = resolveFamily(p, slice);
    pushPlay(items, {
      kind: family === CONFIRM_FAMILY ? "confirm_stack"
        : family === CONTINUATION_FAMILY ? "momentum_continuation" : "options",
      slice_family: family,
      ticker: String(p.ticker).toUpperCase(),
      direction: p.direction || null,
      mode: p.confluence_mode || p.mode || null,
      confluence_mode: slice.confluence_mode || p.confluence_mode || null,
      confluence_score: p.confluence_score ?? p.score ?? null,
      conviction_tier: slice.conviction_tier || p.conviction_tier || p.__conviction_tier || null,
      archetype: p.primary_archetype || p.archetype || null,
      headline: p.headline || p.label || null,
      confirm_stack: slice.confirm_stack,
      momentum_continuation: slice.momentum_continuation,
      runway_full: slice.runway_full,
      lifecycle: slice.lifecycle,
      play_vehicle: slice.play_vehicle || "options",
      play_label: slice.play_label || "Options",
      play_why: slice.play_why,
      business_character: slice.business_character,
      sequence_entry_ready: slice.sequence_entry_ready,
      sequence_posture: slice.sequence_posture,
      source: "options_all",
    });
  }

  for (const s of readySetups || []) {
    if (!s?.ticker) continue;
    const slice = extractSliceFields(s);
    const family = resolveFamily(s, slice);
    pushPlay(items, {
      kind: family === CONFIRM_FAMILY ? "confirm_stack"
        : family === CONTINUATION_FAMILY ? "momentum_continuation" : "setup",
      slice_family: family,
      ticker: String(s.ticker).toUpperCase(),
      direction: s.direction || s.trigger_dir || null,
      mode: s.kanban_stage || s.stage || slice.lifecycle?.state || "READY",
      confluence_mode: slice.confluence_mode || s.confluence_mode || "READY",
      confluence_score: s.rank ?? s.score ?? null,
      conviction_tier: slice.conviction_tier || s.__conviction_tier || null,
      archetype: s.setup_name || s.entry_path || null,
      headline: s.setup_name || s.ticker,
      confirm_stack: slice.confirm_stack,
      momentum_continuation: slice.momentum_continuation,
      runway_full: slice.runway_full,
      lifecycle: slice.lifecycle,
      play_vehicle: slice.play_vehicle,
      play_label: slice.play_label,
      play_why: slice.play_why,
      business_character: slice.business_character,
      sequence_entry_ready: slice.sequence_entry_ready,
      sequence_posture: slice.sequence_posture,
      source: "ready_setups",
    });
  }

  for (const s of confirmStackTickers || []) {
    if (!s?.ticker) continue;
    const slice = extractSliceFields(s);
    if (!isConfirmStackFamily(s, slice)) continue;
    pushPlay(items, {
      kind: "confirm_stack",
      slice_family: CONFIRM_FAMILY,
      ticker: String(s.ticker).toUpperCase(),
      direction: s.direction || s.trigger_dir || null,
      mode: slice.lifecycle?.state || s.kanban_stage || "watching",
      confluence_mode: slice.confluence_mode || s.confluence_mode || null,
      confluence_score: s.rank ?? s.score ?? null,
      conviction_tier: slice.conviction_tier || s.__conviction_tier || null,
      archetype: s.setup_name || s.entry_path || CONFIRM_FAMILY,
      headline: slice.lifecycle?.why || s.setup_name || "Confirm-stack EMA21",
      confirm_stack: true,
      momentum_continuation: slice.momentum_continuation,
      runway_full: slice.runway_full,
      lifecycle: slice.lifecycle,
      play_vehicle: slice.play_vehicle,
      play_label: slice.play_label,
      play_why: slice.play_why,
      business_character: slice.business_character,
      sequence_entry_ready: slice.sequence_entry_ready,
      sequence_posture: slice.sequence_posture,
      sequence_paper_queue: slice.sequence_paper_queue,
      source: "confirm_stack_scan",
    });
  }

  for (const s of continuationTickers || []) {
    if (!s?.ticker) continue;
    const slice = extractSliceFields(s);
    if (!isContinuationFamily(s, slice)) continue;
    pushPlay(items, {
      kind: "momentum_continuation",
      slice_family: CONTINUATION_FAMILY,
      ticker: String(s.ticker).toUpperCase(),
      direction: s.direction || s.trigger_dir || slice.sequence_paper_queue?.direction || null,
      mode: slice.lifecycle?.state || s.kanban_stage || "watching",
      confluence_mode: slice.confluence_mode || s.confluence_mode || null,
      confluence_score: s.rank ?? s.score ?? null,
      conviction_tier: slice.conviction_tier || s.__conviction_tier || null,
      archetype: s.setup_name || s.entry_path || CONTINUATION_FAMILY,
      headline: slice.lifecycle?.why || s.setup_name || "Momentum continuation",
      confirm_stack: false,
      momentum_continuation: true,
      runway_full: slice.runway_full,
      lifecycle: slice.lifecycle,
      play_vehicle: slice.play_vehicle,
      play_label: slice.play_label,
      play_why: slice.play_why,
      business_character: slice.business_character,
      sequence_entry_ready: slice.sequence_entry_ready,
      sequence_posture: slice.sequence_posture,
      sequence_paper_queue: slice.sequence_paper_queue,
      source: "continuation_scan",
    });
  }

  for (const it of items) it.priority = playPriority(it);

  items.sort((a, b) => a.priority - b.priority);
  const kindRank = { confirm_stack: 0, momentum_continuation: 1, options: 2, setup: 3 };
  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    const key = it.ticker;
    if (seen.has(key)) {
      const prevIdx = deduped.findIndex((x) => x.ticker === key);
      if (prevIdx >= 0) {
        const prev = deduped[prevIdx];
        if ((kindRank[it.kind] ?? 9) < (kindRank[prev.kind] ?? 9)) {
          deduped[prevIdx] = it;
        }
      }
      continue;
    }
    seen.add(key);
    deduped.push(it);
    if (deduped.length >= limit) break;
  }

  const confirmPlays = deduped.filter((p) => p.slice_family === CONFIRM_FAMILY);
  const contPlays = deduped.filter((p) => p.slice_family === CONTINUATION_FAMILY);
  const familyPlays = [...confirmPlays, ...contPlays];

  return {
    generated_at: Date.now(),
    count: deduped.length,
    plays: deduped,
    // Backward-compat: `slice` remains confirm-stack primary.
    slice: {
      family: CONFIRM_FAMILY,
      label: "Confirm-stack EMA21 runners",
      count: confirmPlays.length,
      plays: familyPlays,
      note: "Thin-slice families: confirm-stack + momentum continuation. Capture/MFE attribution is the widen gate.",
    },
    slices: {
      [CONFIRM_FAMILY]: {
        family: CONFIRM_FAMILY,
        label: "Confirm-stack EMA21",
        count: confirmPlays.length,
        plays: confirmPlays,
      },
      [CONTINUATION_FAMILY]: {
        family: CONTINUATION_FAMILY,
        label: "Momentum continuation",
        count: contPlays.length,
        plays: contPlays,
      },
    },
  };
}
