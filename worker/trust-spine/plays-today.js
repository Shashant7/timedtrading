// Trust Spine — unified Today's Plays queue (server-side priority sort).
//
// Thin slice (plans/confirm-stack-ema21-slice.plan.md): Confirm-stack EMA21
// runners are first-class queue items. Experts (sequence, character, RIDE,
// conviction) are inputs/chips — not competing modes.

const MODE_RANK = { RIDE: 0, READY: 1, DRIFT: 2, FADE: 3, WAIT: 4, UNKNOWN: 5 };
const PLAY_LABELS = { shares: "Shares", letf: "Leveraged ETF", options: "Options" };

function playPriority(item) {
  const mode = String(item?.confluence_mode || item?.mode || "UNKNOWN").toUpperCase();
  const tier = String(item?.conviction_tier || item?.tier || "C").toUpperCase();
  const tierBoost = tier === "A" ? 0 : tier === "B" ? 10 : 20;
  const score = Number(item?.confluence_score || item?.score || 0);
  // Confirm-stack family sorts ahead of generic ready/options noise.
  const familyBoost = item?.slice_family === "confirm_stack_ema21" ? -200 : 0;
  const confirmBoost = item?.confirm_stack === true ? -50 : 0;
  return (MODE_RANK[mode] ?? 5) * 1000 + tierBoost * 10 - score + familyBoost + confirmBoost;
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
    } : null,
  };
}

/** Family admission: confirm-stack fired (shadow stamp) or explicit flag. */
export function isConfirmStackFamily(t = {}, slice = null) {
  const s = slice || extractSliceFields(t);
  if (s.confirm_stack === true) return true;
  // Fallback: live EMA reclaim + ST flip + squeeze flags when gates missing.
  const flags = t.flags || {};
  const reclaim = !!(flags.ema21_reclaim || t.__pullback_confirmed || flags.ripster_reclaim);
  const stFlip = !!(flags.st_flip_bull || flags.st_flip_bear || flags.supertrend_flip);
  const squeeze = !!(flags.sq30_release || flags.squeeze_release);
  return reclaim && stFlip && squeeze;
}

/**
 * Merge options plays + ready setups + confirm-stack family into one queue.
 */
export function buildTodayPlaysQueue({
  optionsPlays = [],
  readySetups = [],
  confirmStackTickers = [],
  limit = 20,
} = {}) {
  const items = [];

  for (const p of optionsPlays || []) {
    if (!p?.ticker) continue;
    const slice = extractSliceFields(p);
    const family = isConfirmStackFamily(p, slice);
    items.push({
      kind: family ? "confirm_stack" : "options",
      slice_family: family ? "confirm_stack_ema21" : null,
      ticker: String(p.ticker).toUpperCase(),
      direction: p.direction || null,
      mode: p.confluence_mode || p.mode || null,
      confluence_mode: slice.confluence_mode || p.confluence_mode || null,
      confluence_score: p.confluence_score ?? p.score ?? null,
      conviction_tier: slice.conviction_tier || p.conviction_tier || p.__conviction_tier || null,
      archetype: p.primary_archetype || p.archetype || null,
      headline: p.headline || p.label || null,
      confirm_stack: slice.confirm_stack,
      runway_full: slice.runway_full,
      lifecycle: slice.lifecycle,
      play_vehicle: slice.play_vehicle || "options",
      play_label: slice.play_label || "Options",
      play_why: slice.play_why,
      business_character: slice.business_character,
      sequence_entry_ready: slice.sequence_entry_ready,
      sequence_posture: slice.sequence_posture,
      priority: 0,
      source: "options_all",
    });
  }

  for (const s of readySetups || []) {
    if (!s?.ticker) continue;
    const slice = extractSliceFields(s);
    const family = isConfirmStackFamily(s, slice);
    items.push({
      kind: family ? "confirm_stack" : "setup",
      slice_family: family ? "confirm_stack_ema21" : null,
      ticker: String(s.ticker).toUpperCase(),
      direction: s.direction || s.trigger_dir || null,
      mode: s.kanban_stage || s.stage || slice.lifecycle?.state || "READY",
      confluence_mode: slice.confluence_mode || s.confluence_mode || "READY",
      confluence_score: s.rank ?? s.score ?? null,
      conviction_tier: slice.conviction_tier || s.__conviction_tier || null,
      archetype: s.setup_name || s.entry_path || null,
      headline: s.setup_name || s.ticker,
      confirm_stack: slice.confirm_stack,
      runway_full: slice.runway_full,
      lifecycle: slice.lifecycle,
      play_vehicle: slice.play_vehicle,
      play_label: slice.play_label,
      play_why: slice.play_why,
      business_character: slice.business_character,
      sequence_entry_ready: slice.sequence_entry_ready,
      sequence_posture: slice.sequence_posture,
      priority: 0,
      source: "ready_setups",
    });
  }

  // Explicit confirm-stack scan (may include watching/queued, not only ready).
  for (const s of confirmStackTickers || []) {
    if (!s?.ticker) continue;
    const slice = extractSliceFields(s);
    if (!isConfirmStackFamily(s, slice)) continue;
    items.push({
      kind: "confirm_stack",
      slice_family: "confirm_stack_ema21",
      ticker: String(s.ticker).toUpperCase(),
      direction: s.direction || s.trigger_dir || null,
      mode: slice.lifecycle?.state || s.kanban_stage || "watching",
      confluence_mode: slice.confluence_mode || s.confluence_mode || null,
      confluence_score: s.rank ?? s.score ?? null,
      conviction_tier: slice.conviction_tier || s.__conviction_tier || null,
      archetype: s.setup_name || s.entry_path || "confirm_stack_ema21",
      headline: slice.lifecycle?.why || s.setup_name || "Confirm-stack EMA21",
      confirm_stack: true,
      runway_full: slice.runway_full,
      lifecycle: slice.lifecycle,
      play_vehicle: slice.play_vehicle,
      play_label: slice.play_label,
      play_why: slice.play_why,
      business_character: slice.business_character,
      sequence_entry_ready: slice.sequence_entry_ready,
      sequence_posture: slice.sequence_posture,
      sequence_paper_queue: slice.sequence_paper_queue,
      priority: 0,
      source: "confirm_stack_scan",
    });
  }

  for (const it of items) it.priority = playPriority(it);

  items.sort((a, b) => a.priority - b.priority);
  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    // Prefer confirm_stack kind over options/setup for same ticker.
    const key = it.ticker;
    if (seen.has(key)) {
      const prevIdx = deduped.findIndex((x) => x.ticker === key);
      if (prevIdx >= 0 && it.kind === "confirm_stack" && deduped[prevIdx].kind !== "confirm_stack") {
        deduped[prevIdx] = it;
      }
      continue;
    }
    seen.add(key);
    deduped.push(it);
    if (deduped.length >= limit) break;
  }

  const family = deduped.filter((p) => p.slice_family === "confirm_stack_ema21");
  return {
    generated_at: Date.now(),
    count: deduped.length,
    plays: deduped,
    slice: {
      family: "confirm_stack_ema21",
      label: "Confirm-stack EMA21 runners",
      count: family.length,
      plays: family,
      note: "Thin-slice proof family. Experts are chips (sequence, character, play, conviction) — not modes. Capture/MFE attribution is the widen gate, not flag flips.",
    },
  };
}
