// ═══════════════════════════════════════════════════════════════════════════
// worker/overlay-provenance.js — Phase C3 of the stabilization plan
// (tasks/2026-07-03-holiday-weekend-stabilization-plan.md, Objective 2).
//
// PRINCIPLE: advisory inputs age like fish, not wine. Every overlay (the CRO
// tactical override blob distilled from FSD publications, and any future
// advisory input) carries provenance — issued_at, expires_at, status — and
// EXPIRY IS ENFORCED CENTRALLY at read time. A consumer can no longer quote
// a matured "semis stalling" note three weeks later, because the loaders
// hand it an already-filtered view.
//
// Status lifecycle:  active → maturing (last 25% of life) → expired
//
// Default lifetimes by horizon (calendar days — FSD publishes on calendar
// cadence, not trading sessions):
//   tactical      10d   (FSD tactical overlays refresh ~weekly)
//   intermediate  30d
//   structural    90d   (stance changes persist until the next regime call)
//
// Explicit `expires_at` on the blob or a signal ALWAYS wins over defaults.
// Pure module — no I/O. The KV loaders wrap these helpers.
// ═══════════════════════════════════════════════════════════════════════════

const DAY = 24 * 60 * 60 * 1000;

export const OVERLAY_TTL_BY_HORIZON = Object.freeze({
  tactical: 10 * DAY,
  intermediate: 30 * DAY,
  structural: 90 * DAY,
});

export const OVERLAY_DEFAULT_TTL_MS = OVERLAY_TTL_BY_HORIZON.tactical;
const MATURING_FRACTION = 0.75; // last 25% of life = "maturing"

export const OVERLAY_STATUS = Object.freeze({
  ACTIVE: "active",
  MATURING: "maturing",
  EXPIRED: "expired",
});

/** Resolve when the overlay was issued. */
export function overlayIssuedAt(blob) {
  if (!blob || typeof blob !== "object") return 0;
  const explicit = Number(blob.issued_at);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const applied = Number(blob.applied_at);
  if (Number.isFinite(applied) && applied > 0) return applied;
  // tactical_vintage is a YYYY-MM-DD publication date.
  const vintage = Date.parse(String(blob.tactical_vintage || ""));
  if (Number.isFinite(vintage) && vintage > 0) return vintage;
  return 0;
}

/** TTL for a horizon string (unknown → tactical default). */
export function ttlForHorizon(horizon) {
  return OVERLAY_TTL_BY_HORIZON[String(horizon || "").toLowerCase()] || OVERLAY_DEFAULT_TTL_MS;
}

/**
 * Resolve when the overlay expires. Explicit blob-level expires_at wins;
 * otherwise issued_at + the LONGEST horizon present among its signals
 * (a blob carrying a structural stance change should not die with its
 * tactical lines — per-signal filtering below handles the short ones).
 */
export function overlayExpiresAt(blob) {
  if (!blob || typeof blob !== "object") return 0;
  const explicit = Number(blob.expires_at);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const issued = overlayIssuedAt(blob);
  if (!issued) return 0;
  let ttl = OVERLAY_DEFAULT_TTL_MS;
  const horizons = new Set(
    (Array.isArray(blob.tactical_signals) ? blob.tactical_signals : [])
      .map((s) => String(s?.horizon || "").toLowerCase()).filter(Boolean),
  );
  const hasStanceChanges = (blob.sector_stance_changes || []).length > 0
    || (blob.theme_stance_changes || []).length > 0;
  if (hasStanceChanges) horizons.add("structural");
  for (const h of horizons) ttl = Math.max(ttl, ttlForHorizon(h));
  return issued + ttl;
}

/** Status of the whole blob at `nowMs`. Unknown issue date → active (fail open, logged by caller). */
export function overlayStatus(blob, nowMs = Date.now()) {
  const issued = overlayIssuedAt(blob);
  const expires = overlayExpiresAt(blob);
  if (!issued || !expires) return OVERLAY_STATUS.ACTIVE;
  if (nowMs >= expires) return OVERLAY_STATUS.EXPIRED;
  if (nowMs >= issued + (expires - issued) * MATURING_FRACTION) return OVERLAY_STATUS.MATURING;
  return OVERLAY_STATUS.ACTIVE;
}

/** Per-signal expiry: explicit signal.expires_at, else issued + horizon TTL. */
export function signalExpired(signal, issuedAt, nowMs = Date.now()) {
  const explicit = Number(signal?.expires_at);
  if (Number.isFinite(explicit) && explicit > 0) return nowMs >= explicit;
  if (!issuedAt) return false;
  return nowMs >= issuedAt + ttlForHorizon(signal?.horizon);
}

/**
 * The central read-time filter. Returns:
 *   null                     — blob missing or fully expired (consumers fall
 *                              back to the in-code baseline playbook)
 *   { ...blob, _provenance } — active/maturing view with per-signal expiry
 *                              applied (matured tactical lines dropped even
 *                              while structural stances live on)
 */
export function filterActiveOverlay(blob, nowMs = Date.now()) {
  if (!blob || typeof blob !== "object") return null;
  const status = overlayStatus(blob, nowMs);
  if (status === OVERLAY_STATUS.EXPIRED) return null;

  const issued = overlayIssuedAt(blob);
  const expires = overlayExpiresAt(blob);
  const signals = Array.isArray(blob.tactical_signals) ? blob.tactical_signals : [];
  const liveSignals = signals.filter((s) => !signalExpired(s, issued, nowMs));
  const droppedSignals = signals.length - liveSignals.length;

  return {
    ...blob,
    tactical_signals: liveSignals,
    _provenance: {
      status,
      issued_at: issued || null,
      expires_at: expires || null,
      age_days: issued ? Math.round((nowMs - issued) / DAY * 10) / 10 : null,
      remaining_days: expires ? Math.max(0, Math.round((expires - nowMs) / DAY * 10) / 10) : null,
      signals_dropped: droppedSignals,
    },
  };
}

/**
 * Backfill provenance fields onto a blob at WRITE time (cro-apply). Keeps
 * whatever the proposal already set; fills issued_at/expires_at defaults so
 * every new overlay is born with a lifespan.
 */
export function stampOverlayProvenance(blob, nowMs = Date.now()) {
  if (!blob || typeof blob !== "object") return blob;
  const out = { ...blob };
  if (!Number(out.issued_at)) out.issued_at = overlayIssuedAt(out) || nowMs;
  if (!Number(out.expires_at)) out.expires_at = overlayExpiresAt(out) || (Number(out.issued_at) + OVERLAY_DEFAULT_TTL_MS);
  return out;
}
