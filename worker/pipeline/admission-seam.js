// worker/pipeline/admission-seam.js — Packet I slice (F15) of the 2026-09-04
// ledger audit plan.
//
// One catalog-status admission check for every entry path. The prior inline
// check called isPlayPaused(path) with the engine path only:
//   • a mangled or legacy display name ("TT Tt Range Reversal Long") could
//     miss the alias index and slip a PAUSED play through;
//   • a missing/unstamped path silently allowed (missing-input default
//     allow) with no observable reason code.
// This seam resolves play identity from BOTH the engine path and the setup
// name, blocks paused plays, flags restricted ones, and always names its
// outcome so admission decisions are attributable.

import { resolvePlay, canonicalPlayId, PLAY_STATUS } from "../foundation/play-catalog.js";

/**
 * @returns {{
 *   allowed: boolean,
 *   reason: string,           // observable outcome code, set on EVERY result
 *   play_id: string|null,     // canonical id when resolvable
 *   restricted: boolean,      // catalog status=restricted (allowed, flagged)
 *   identity_missing: boolean // no catalog identity could be resolved
 * }}
 */
export function checkPlayAdmission({ entryPath, setupName, direction } = {}) {
  const path = String(entryPath || "").trim();
  const name = String(setupName || "").trim();

  const play = resolvePlay(path, direction) || resolvePlay(name, direction);
  const playId = canonicalPlayId(path, name, direction);

  if (play) {
    if (play.status === PLAY_STATUS.PAUSED) {
      return {
        allowed: false,
        reason: "play_catalog_paused",
        play_id: play.id,
        restricted: false,
        identity_missing: false,
      };
    }
    return {
      allowed: true,
      reason: play.status === PLAY_STATUS.RESTRICTED ? "play_catalog_restricted" : "play_catalog_active",
      play_id: play.id,
      restricted: play.status === PLAY_STATUS.RESTRICTED,
      identity_missing: false,
    };
  }

  if (!path && !name) {
    // Missing-input case. The safe outcome is allow-with-observable-reason:
    // an unstamped identity cannot match a paused cohort (pauses are
    // catalog-keyed), but the decision must be attributable — callers log
    // and stamp this code instead of silently proceeding.
    return {
      allowed: true,
      reason: "unresolved_play_identity_missing_inputs",
      play_id: null,
      restricted: false,
      identity_missing: true,
    };
  }

  // A stamped engine path that is not in the catalog (new/experimental
  // family). Allowed — it cannot be a paused catalog cohort — with the
  // stable path carried through for attribution.
  return {
    allowed: true,
    reason: "play_not_in_catalog",
    play_id: playId || null,
    restricted: false,
    identity_missing: false,
  };
}
