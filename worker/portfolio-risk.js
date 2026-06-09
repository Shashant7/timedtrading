// worker/portfolio-risk.js
//
// P4.S1/S3 (2026-06-09) — portfolio-LEVEL risk controls.
//
// Full-system-review §5: every existing breaker is trade-outcome based
// (Loop 2 = last-10 WR) and every cap is count-based (MAX_OPEN_POSITIONS).
// Nothing watched the model book's EQUITY CURVE (slow bleeds across many
// small losses never trip a WR window) and nothing capped total CAPITAL
// deployed (35 small-cap positions and 35 full-size mega-caps look
// identical to a count cap).
//
// Two controls, both SHADOW-FIRST (compute + log + KV state always;
// entry blocking only when the operator flips the enable flags):
//
//   1. Equity-curve drawdown breaker
//      equity = start_cash + Σ realized PnL + open MTM
//      Trip when drawdown from the trailing 20-day equity high exceeds
//      `portfolio_dd_breaker_pct` (default 5%).
//      Enable enforcement: model_config `portfolio_dd_breaker_enabled`.
//
//   2. Capital budget guard
//      open_notional_pct = Σ |shares × price| / equity
//      Trip when deployed notional exceeds
//      `portfolio_max_open_notional_pct` (default 100%).
//      Enable enforcement: model_config `portfolio_risk_budget_enabled`.
//
// State is written hourly (same cadence as the Loop 2 pulse) to KV
// `phase-c:portfolio-risk`; the */5 scoring preload reads it into
// env._portfolioRiskPause and qualifiesForEnter consults it SYNC —
// mirroring the proven Loop 2 plumbing.

const STATE_KEY = "phase-c:portfolio-risk";
const SAMPLES_KEY = "phase-c:equity-samples";
const SAMPLE_DAYS = 30; // keep 30 daily samples; DD window is 20

const DEFAULTS = {
  dd_breaker_pct: 5,
  max_open_notional_pct: 100,
};

function _num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve a price for a ticker from the timed:prices map shape
 * ({ SYM: { p, pc, ... } }).
 */
function _px(priceMap, ticker) {
  const p = priceMap?.[String(ticker || "").toUpperCase()];
  const v = Number(p?.p);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Compute current model-book equity + deployed notional.
 *
 * @param {Array} openRows [{ ticker, direction, shares, entry_price }]
 * @param {object} priceMap timed:prices `prices` object
 * @param {number} realizedPnl Σ pnl over closed live trades
 * @param {number} startCash
 */
export function computeBookState(openRows, priceMap, realizedPnl, startCash) {
  let openMtm = 0;
  let openNotional = 0;
  let priced = 0;
  for (const r of openRows || []) {
    const shares = Number(r.shares) || 0;
    const entry = Number(r.entry_price) || 0;
    if (shares <= 0 || entry <= 0) continue;
    const px = _px(priceMap, r.ticker) ?? entry; // stale feed → flat MTM, notional still counted
    const dir = String(r.direction || "LONG").toUpperCase() === "SHORT" ? -1 : 1;
    openMtm += shares * (px - entry) * dir;
    openNotional += Math.abs(shares * px);
    priced++;
  }
  const equity = (Number(startCash) || 0) + (Number(realizedPnl) || 0) + openMtm;
  return {
    equity: +equity.toFixed(2),
    open_mtm: +openMtm.toFixed(2),
    open_notional: +openNotional.toFixed(2),
    open_count: (openRows || []).length,
    open_priced: priced,
    open_notional_pct: equity > 0 ? +((openNotional / equity) * 100).toFixed(1) : null,
  };
}

/**
 * Append today's equity sample (one per NY day, last write wins) and
 * return the trailing 20-day high.
 */
export async function updateEquitySamples(KV, equity, nowMs = Date.now()) {
  let samples = [];
  try {
    const raw = await KV.get(SAMPLES_KEY);
    samples = raw ? JSON.parse(raw) : [];
  } catch (_) { samples = []; }
  const day = new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const idx = samples.findIndex((s) => s.day === day);
  // Track the intraday HIGH per day so a fast same-day drawdown is
  // measured against today's peak, not the first sample of the day.
  if (idx >= 0) samples[idx].equity = Math.max(Number(samples[idx].equity) || 0, equity);
  else samples.push({ day, equity });
  samples.sort((a, b) => (a.day < b.day ? -1 : 1));
  if (samples.length > SAMPLE_DAYS) samples = samples.slice(-SAMPLE_DAYS);
  try {
    await KV.put(SAMPLES_KEY, JSON.stringify(samples), { expirationTtl: 90 * 86400 });
  } catch (_) { /* best-effort */ }
  const window = samples.slice(-20);
  const high = window.reduce((m, s) => Math.max(m, Number(s.equity) || 0), 0);
  return { samples: window.length, trailing_high: high };
}

/**
 * Full hourly evaluation. Computes book state, updates the equity
 * ring, evaluates both trips, persists state to KV.
 *
 * @returns state object (also written to KV STATE_KEY)
 */
export async function evaluatePortfolioRisk(env, { openRows, priceMap, realizedPnl, startCash, daCfg = {} }) {
  const KV = env?.KV_TIMED || env?.KV;
  const book = computeBookState(openRows, priceMap, realizedPnl, startCash);
  const { samples, trailing_high } = KV
    ? await updateEquitySamples(KV, book.equity)
    : { samples: 0, trailing_high: book.equity };

  const ddPct = trailing_high > 0
    ? +(((trailing_high - book.equity) / trailing_high) * 100).toFixed(2)
    : 0;

  const ddThreshold = _num(daCfg.portfolio_dd_breaker_pct, DEFAULTS.dd_breaker_pct);
  const notionalThreshold = _num(daCfg.portfolio_max_open_notional_pct, DEFAULTS.max_open_notional_pct);
  // 2026-06-09 operator decision: enforcement defaults ON ("informed,
  // not responsible") — a trip blocks new entries and pages Discord.
  // Set the model_config keys to "false" to drop back to shadow mode.
  const ddEnforced = String(daCfg.portfolio_dd_breaker_enabled ?? "true") === "true";
  const budgetEnforced = String(daCfg.portfolio_risk_budget_enabled ?? "true") === "true";

  // DD trip needs at least 5 daily samples — a fresh ring would treat
  // the first red day as a 100%-confidence drawdown signal.
  const ddTrip = samples >= 5 && ddPct >= ddThreshold;
  const budgetTrip = book.open_notional_pct != null && book.open_notional_pct >= notionalThreshold;

  const state = {
    computed_at: Date.now(),
    ...book,
    equity_trailing_high: +trailing_high.toFixed(2),
    equity_samples: samples,
    dd_pct: ddPct,
    dd_threshold_pct: ddThreshold,
    dd_trip: ddTrip,
    dd_enforced: ddEnforced,
    notional_threshold_pct: notionalThreshold,
    budget_trip: budgetTrip,
    budget_enforced: budgetEnforced,
    // The flag qualifiesForEnter actually consults: trip AND enforce.
    block_new_entries: (ddTrip && ddEnforced) || (budgetTrip && budgetEnforced),
    block_reason: ddTrip && ddEnforced
      ? `portfolio_dd_${ddPct}pct_vs_${ddThreshold}pct`
      : budgetTrip && budgetEnforced
        ? `capital_budget_${book.open_notional_pct}pct_vs_${notionalThreshold}pct`
        : null,
  };

  if (KV) {
    try {
      await KV.put(STATE_KEY, JSON.stringify(state), { expirationTtl: 6 * 3600 });
    } catch (_) { /* best-effort */ }
  }
  return state;
}

/** Read the hourly state for the scoring preload (mirrors loop2ReadPause). */
export async function readPortfolioRisk(KV) {
  try {
    const raw = await KV.get(STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}
