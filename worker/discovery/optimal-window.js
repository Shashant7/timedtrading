// worker/discovery/optimal-window.js
//
// Per-ticker optimal analysis window from Move Discovery stats
// (tasks/2026-08-05-context-first-scoring-plan.md, block C).
//
// The frame digest should look back as far as the ticker's moves actually
// take to develop — not a hardcoded 30 days. Derived from COMPLETED moves
// only (no lookahead).

export const WINDOW_MIN_DAYS = 10;
export const WINDOW_MAX_DAYS = 60;
export const WINDOW_DEFAULT_DAYS = 30;
export const LEADIN_MIN_DAYS = 2;
export const LEADIN_MAX_DAYS = 10;
export const LEADIN_DEFAULT_DAYS = 5;

function median(sorted) {
  if (!sorted.length) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Compute the analysis window from move durations.
 * @param {Array<{duration_days?:number, days?:number, window?:number, start_ts?:number, end_ts?:number}>} moves
 * @returns {{ window_days:number, leadin_days:number, sample_n:number, median_duration_days:number|null }}
 */
export function computeOptimalWindow(moves = [], opts = {}) {
  const min = Number(opts.min) || WINDOW_MIN_DAYS;
  const max = Number(opts.max) || WINDOW_MAX_DAYS;
  const dflt = Number(opts.dflt) || WINDOW_DEFAULT_DAYS;

  const durations = (moves || [])
    .map((m) => {
      const d = Number(m.duration_days ?? m.days ?? m.window);
      if (Number.isFinite(d) && d > 0) return d;
      const start = Number(m.start_ts ?? m.first_ts);
      const end = Number(m.end_ts ?? m.last_ts);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        return (end - start) / 86400000;
      }
      return null;
    })
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);

  if (durations.length < 3) {
    return {
      window_days: dflt,
      leadin_days: LEADIN_DEFAULT_DAYS,
      sample_n: durations.length,
      median_duration_days: median(durations),
    };
  }

  const med = median(durations);
  // Window = 2x median move duration + lead-in margin, clamped.
  const leadin = Math.round(Math.min(LEADIN_MAX_DAYS, Math.max(LEADIN_MIN_DAYS, med / 2)));
  const windowDays = Math.round(Math.min(max, Math.max(min, med * 2 + leadin)));

  return {
    window_days: windowDays,
    leadin_days: leadin,
    sample_n: durations.length,
    median_duration_days: Math.round(med * 10) / 10,
  };
}
