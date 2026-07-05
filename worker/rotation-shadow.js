// ═══════════════════════════════════════════════════════════════════════════
// worker/rotation-shadow.js — Phase C4 of the stabilization plan
// (Objective 2: thematic propagation → action, SHADOW MODE).
//
// When an ACTIVE overlay (C3-filtered — provenance enforced) calls a
// rotation ("semis stalling, rotate into Mag 7 / software"), the book
// should not just take note — it should act: tighten stops into profit,
// trim, or flag a hedge. This engine computes those actions and LOGS them
// (KV ring + console) without touching the book. Promotion to live
// execution happens only after the operator has watched a week of sane
// shadow output (plan working agreement).
//
// Inputs per open position:
//   • overlay stance for the position's sector + themes
//     (underweight stance, or a bearish tactical/theme note)
//   • the position's journey direction (C2 `_journey.features.direction`)
//   • unrealized PnL
//
// Decision matrix (LONG positions; SHORT mirrors):
//   overlay bearish on sector/theme +
//     journey deteriorating + in profit   → TIGHTEN_SL_PROFIT_LOCK
//     journey deteriorating + at/under BE → TRIM_OR_EXIT_REVIEW
//     journey improving/flat + in profit  → TIGHTEN_SL_BREAKEVEN
//     journey improving/flat + under BE   → HEDGE_REVIEW (investor lane)
//                                           / WATCH_CLOSE (trader lane)
//   overlay bullish on sector/theme      → no action (adds are the entry
//                                           engine's job, not the shadow's)
//
// Pure compute first; the runner wires KV/D1 and is invoked from the
// hourly cron lane.
// ═══════════════════════════════════════════════════════════════════════════

import { kvGetJSON, kvPutJSON } from "./storage.js";
import { getSector, getThemesForTicker } from "./sector-mapping.js";

export const ROTATION_SHADOW_KV_KEY = "timed:rotation:shadow";
const RING_MAX = 200;
const BEARISH_NOTE_RE = /stall|profit.?tak|weak|fade|trim|underweight|rotat(e|ion)\s+(out|away)|de.?risk|caution|pullback risk|top(ping)?\b/i;

/** Stance the ACTIVE overlay expresses for a sector/theme name. Pure. */
export function overlayStanceFor(overlay, name) {
  if (!overlay || !name) return { stance: "none", note: null, source: null };
  const n = String(name).toLowerCase();

  for (const ch of overlay.sector_stance_changes || []) {
    if (String(ch?.sector || "").toLowerCase() === n) {
      return { stance: String(ch.new_stance || "neutral").toLowerCase(), note: ch.rationale_short || null, source: "sector_stance" };
    }
  }
  for (const ch of overlay.theme_stance_changes || []) {
    if (String(ch?.theme || "").toLowerCase() === n) {
      return { stance: String(ch.new_stance || "neutral").toLowerCase(), note: ch.rationale_short || null, source: "theme_stance" };
    }
  }
  for (const note of overlay.sector_notes || []) {
    if (String(note?.sector || "").toLowerCase() === n && BEARISH_NOTE_RE.test(String(note?.tactical_note || ""))) {
      return { stance: "bearish_note", note: String(note.tactical_note).slice(0, 200), source: "sector_note" };
    }
  }
  for (const note of overlay.theme_notes || []) {
    if (String(note?.theme || "").toLowerCase() === n && BEARISH_NOTE_RE.test(String(note?.tactical_note || ""))) {
      return { stance: "bearish_note", note: String(note.tactical_note).slice(0, 200), source: "theme_note" };
    }
  }
  return { stance: "none", note: null, source: null };
}

function isBearishStance(stance) {
  return stance === "underweight" || stance === "bearish_note";
}

/**
 * Compute shadow actions for one position. Pure.
 * position: { ticker, lane: "trader"|"investor", direction, entryPrice,
 *             currentPrice, trimmedPct }
 * latest:   the ticker's timed:latest payload (journey riding on it)
 */
export function computeShadowActionForPosition(position, latest, overlay, hooks = {}) {
  const sym = String(position?.ticker || "").toUpperCase();
  if (!sym || !overlay) return null;

  const sectorFor = hooks.getSectorForTicker || getSector;
  const themesFor = hooks.getThemesForTicker || getThemesForTicker;
  const sector = sectorFor(sym);
  const themes = themesFor(sym) || [];

  // First bearish overlay hit wins (sector first, then themes).
  let hit = null;
  const sectorStance = overlayStanceFor(overlay, sector);
  if (isBearishStance(sectorStance.stance)) {
    hit = { scope: "sector", name: sector, ...sectorStance };
  } else {
    for (const theme of themes) {
      const ts = overlayStanceFor(overlay, theme);
      if (isBearishStance(ts.stance)) {
        hit = { scope: "theme", name: theme, ...ts };
        break;
      }
    }
  }
  if (!hit) return null;

  const dirLong = String(position.direction || "LONG").toUpperCase() !== "SHORT";
  // A SHORT position in a sector the overlay is bearish on is aligned —
  // the rotation call supports it; nothing to defend.
  if (!dirLong) return null;

  const entry = Number(position.entryPrice) || 0;
  const px = Number(position.currentPrice)
    || Number(latest?._live_price ?? latest?.price ?? latest?.close) || 0;
  const pnlPct = entry > 0 && px > 0 ? ((px - entry) / entry) * 100 : null;
  const inProfit = Number.isFinite(pnlPct) && pnlPct > 0.5;
  const journeyDir = latest?._journey?.features?.direction || "flat";
  const deteriorating = journeyDir === "deteriorating";

  let action, urgency;
  if (deteriorating && inProfit) {
    action = "TIGHTEN_SL_PROFIT_LOCK"; urgency = "high";
  } else if (deteriorating) {
    action = "TRIM_OR_EXIT_REVIEW"; urgency = "high";
  } else if (inProfit) {
    action = "TIGHTEN_SL_BREAKEVEN"; urgency = "medium";
  } else {
    action = position.lane === "investor" ? "HEDGE_REVIEW" : "WATCH_CLOSE";
    urgency = "low";
  }

  return {
    ticker: sym,
    lane: position.lane || "trader",
    direction: dirLong ? "LONG" : "SHORT",
    action,
    urgency,
    matched: { scope: hit.scope, name: hit.name, stance: hit.stance, source: hit.source },
    overlay_ref: overlay.proposal_id || overlay.pub_id || null,
    overlay_note: hit.note,
    journey_direction: journeyDir,
    pnl_pct: Number.isFinite(pnlPct) ? Math.round(pnlPct * 100) / 100 : null,
    reason: `${hit.scope} "${hit.name}" ${hit.stance === "bearish_note" ? `flagged: ${hit.note}` : hit.stance}; journey ${journeyDir}${Number.isFinite(pnlPct) ? `; pnl ${pnlPct.toFixed(1)}%` : ""}`,
  };
}

/** Compute the full shadow pass. Pure. */
export function computeRotationShadow(positions, latestBySym, overlay, nowMs = Date.now(), hooks = {}) {
  if (!overlay) return { actions: [], overlay_ref: null };
  const actions = [];
  for (const pos of positions || []) {
    const latest = latestBySym?.[String(pos?.ticker || "").toUpperCase()] || null;
    const act = computeShadowActionForPosition(pos, latest, overlay, hooks);
    if (act) actions.push({ ...act, ts: nowMs });
  }
  return { actions, overlay_ref: overlay.proposal_id || overlay.pub_id || null };
}

// ───────────────────────────────────────────────────────────────────────────
// Runner — hourly cron lane. Loads the C3-filtered overlay, open trader
// trades (KV) + investor positions (D1), each ticker's timed:latest, then
// logs + persists the would-be actions. NEVER mutates the book.
// ───────────────────────────────────────────────────────────────────────────

export async function runRotationShadow(env, deps = {}) {
  const KV = env?.KV_TIMED || env?.KV;
  if (!KV) return { skipped: "no_kv" };

  let overlay = null;
  try {
    const raw = await KV.get("cro:tactical_overrides");
    if (raw) {
      const { filterActiveOverlay } = await import("./overlay-provenance.js");
      overlay = filterActiveOverlay(JSON.parse(raw));
    }
  } catch (_) {}
  if (!overlay) return { skipped: "no_active_overlay" };

  const positions = [];
  try {
    const trades = (await kvGetJSON(KV, "timed:trades:all")) || [];
    for (const t of trades) {
      if (t?.status === "OPEN" || t?.status === "TP_HIT_TRIM") {
        positions.push({
          ticker: t.ticker, lane: "trader", direction: t.direction,
          entryPrice: Number(t.entryPrice) || 0, trimmedPct: Number(t.trimmedPct) || 0,
        });
      }
    }
  } catch (_) {}
  try {
    if (env?.DB) {
      const { results } = await env.DB.prepare(
        `SELECT ticker, avg_entry FROM investor_positions WHERE status = 'OPEN' LIMIT 60`,
      ).all().catch(() => ({ results: [] }));
      for (const r of results || []) {
        positions.push({ ticker: r.ticker, lane: "investor", direction: "LONG", entryPrice: Number(r.avg_entry) || 0 });
      }
    }
  } catch (_) {}
  if (positions.length === 0) return { skipped: "no_open_positions" };

  const latestBySym = {};
  for (const pos of positions) {
    const sym = String(pos.ticker || "").toUpperCase();
    if (!latestBySym[sym]) {
      latestBySym[sym] = await kvGetJSON(KV, `timed:latest:${sym}`);
    }
  }

  const { actions, overlay_ref } = computeRotationShadow(positions, latestBySym, overlay, Date.now(), deps.hooks || {});

  // Persist to the shadow ring (dedup per ticker+action per overlay per day).
  const ring = (await kvGetJSON(KV, ROTATION_SHADOW_KV_KEY)) || [];
  const dayKey = new Date().toISOString().slice(0, 10);
  const seen = new Set(ring.map((a) => `${a.day}|${a.ticker}|${a.action}|${a.overlay_ref}`));
  let appended = 0;
  for (const act of actions) {
    const key = `${dayKey}|${act.ticker}|${act.action}|${overlay_ref}`;
    if (seen.has(key)) continue;
    ring.push({ ...act, day: dayKey, mode: "shadow" });
    appended++;
    console.log(`[ROTATION_SHADOW] ${act.lane} ${act.ticker}: WOULD ${act.action} — ${act.reason}`);
  }
  if (appended > 0) {
    await kvPutJSON(KV, ROTATION_SHADOW_KV_KEY, ring.slice(-RING_MAX), 30 * 86400);
  }
  return { ok: true, positions: positions.length, actions: actions.length, appended, overlay_ref };
}
