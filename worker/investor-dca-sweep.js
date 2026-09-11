// investor-dca-sweep.js
//
// Pure helpers for the 15:46–16:15 ET DCA side-effect sweep.
// PLTR 2026-09-11: an empty 15:46 pass marked the day clean before
// the 15:50 lot existed, so later ticks skipped the broker heal.

/**
 * True when this pass actually verified today's DCA lots AND the
 * broker mirror (or confirmed there was nothing left to forward).
 * An empty window is "nothing to verify yet", not "all good".
 */
export function dcaSweepShouldMarkClean(out = {}) {
  const lots = Number(out?.lots) || 0;
  if (lots <= 0) return false;
  if (out?.ok !== true) return false;
  if (out?.healed_count) return false;
  if (out?.mirror_checked !== true) return false;
  const catchup = out.catchup;
  // mirror:false / mirror-off leaves catchup null — do not freeze the day.
  if (!catchup || catchup.error) return false;
  if ((catchup.planned || 0) !== 0) return false;
  if ((catchup.forwarded_fail || 0) !== 0) return false;
  return true;
}
