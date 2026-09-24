// worker/options-risk-budget.js
//
// 2026-09-23 — ONE daily loss limit, in dollars, instead of count caps.
//
// The count caps did not limit loss, they limited ACTIVITY, and on
// 2026-09-23 they limited it to zero: two limit buys that never filled
// consumed the whole 2/day `long_put` budget 74 seconds after the open and
// blocked the next nine entries. A cap of "2 trades" says nothing about how
// much money is at stake — two $500 tickets and two $60 tickets look the
// same to it.
//
// For a long option the debit IS the max loss. There is no gap risk, no
// margin call, no overnight hole: pay $118 for a put and $118 is the whole
// downside. That makes a dollar budget exactly computable at entry, which a
// share position's downside is not.
//
// So the budget answers one question — "how much can today still cost?":
//
//     consumed  = open risk right now  +  losses already realised today
//     remaining = limit - consumed
//
// A trade that wins gives its risk back and adds nothing to the loss side,
// so a good day does not throttle itself. A trade that loses converts its
// open risk into realised loss, so a bad day tightens on its own until it
// stops. That is what a daily stop-loss means, and it needs no count cap to
// work.
//
// ── Why this is keyed by signal id, not incremented ──────────────────────
//
// The bug this replaces was a counter that only ever went up. Every fix for
// that shape of bug is a release, and every release can be lost.
//
// This stores a MAP of open commitments keyed by signal id. Committing is
// an assignment and releasing is a delete, so both are idempotent by
// construction — replaying either one changes nothing. There is no
// increment to lose and no decrement to double-apply.
//
// ── Concurrency ──────────────────────────────────────────────────────────
//
// Read-modify-write on a single KV key. Two entries dispatching in the same
// instant can both read the pre-state and one commit can be lost, which
// overshoots the budget by at most one ticket. That is the same tolerance
// `entryCountersHaveRoom` already documents and accepts, and it fails by a
// single sleeve rather than by a wedged lane.

/** Default when the operator has not set one. 0 disables the gate entirely. */
export const DEFAULT_DAILY_LOSS_LIMIT_USD = 1000;

export const RISK_STATE_KEY = (userEmail, date) =>
  `timed:options:auto-mirror:risk:${String(userEmail || "").toLowerCase()}:${date}`;

const dayOf = (now) => new Date(Number(now) || Date.now()).toISOString().slice(0, 10);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function emptyState(date) {
  return { date, realized_pnl_usd: 0, open: {}, placed: [], updated_ts: 0 };
}

export async function loadRiskState(env, userEmail, now = Date.now()) {
  const date = dayOf(now);
  if (!env?.KV_TIMED || !userEmail) return emptyState(date);
  try {
    const raw = await env.KV_TIMED.get(RISK_STATE_KEY(userEmail, date));
    if (!raw) return emptyState(date);
    const parsed = JSON.parse(raw);
    return {
      date,
      realized_pnl_usd: num(parsed?.realized_pnl_usd),
      open: (parsed?.open && typeof parsed.open === "object") ? parsed.open : {},
      placed: Array.isArray(parsed?.placed) ? parsed.placed : [],
      updated_ts: num(parsed?.updated_ts),
    };
  } catch (_) {
    return emptyState(date);
  }
}

async function saveRiskState(env, userEmail, state, now = Date.now()) {
  if (!env?.KV_TIMED || !userEmail) return state;
  const next = { ...state, updated_ts: now };
  // Two days, so a post-midnight reconcile can still settle yesterday.
  await env.KV_TIMED.put(
    RISK_STATE_KEY(userEmail, state.date),
    JSON.stringify(next),
    { expirationTtl: 86400 * 2 },
  );
  return next;
}

/** Resolve the operator's limit. 0 (or absent-and-explicitly-zeroed) = off. */
export function dailyLossLimitFor(prefs) {
  const raw = prefs?.daily_loss_limit_usd;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_DAILY_LOSS_LIMIT_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DAILY_LOSS_LIMIT_USD;
  return n;
}

/**
 * What the day has cost and what is left.
 *
 * Realised GAINS do not increase the allowance beyond the limit — they just
 * stop consuming it. Otherwise a good morning would silently raise the
 * ceiling on the afternoon, which is the opposite of a stop-loss.
 */
export function riskBudgetSnapshot(state, limitUsd) {
  const openRows = Object.values(state?.open || {});
  const openUsd = openRows.reduce((s, r) => s + Math.max(0, num(r?.usd)), 0);
  const realized = num(state?.realized_pnl_usd);
  const realizedLossUsd = Math.max(0, -realized);
  const consumedUsd = openUsd + realizedLossUsd;
  const limit = Math.max(0, num(limitUsd));
  return {
    limit_usd: limit,
    open_usd: Math.round(openUsd * 100) / 100,
    open_count: openRows.length,
    // How many day trades reached the broker today. This lives here rather
    // than on the shared daily counters because the day-trade lane must not
    // consume an allowance the Trader lane still gates on.
    placed_count: Array.isArray(state?.placed) ? state.placed.length : 0,
    realized_pnl_usd: Math.round(realized * 100) / 100,
    realized_loss_usd: Math.round(realizedLossUsd * 100) / 100,
    consumed_usd: Math.round(consumedUsd * 100) / 100,
    remaining_usd: limit > 0 ? Math.round(Math.max(0, limit - consumedUsd) * 100) / 100 : null,
    enforced: limit > 0,
  };
}

/**
 * Read-only gate. Mirrors `entryCountersHaveRoom`: the commit happens after
 * the broker accepts, so a crash between the two cannot consume budget.
 */
export async function riskBudgetHasRoom(env, userEmail, { riskUsd = 0, limitUsd = 0, now = Date.now() } = {}) {
  const limit = Math.max(0, num(limitUsd));
  const state = await loadRiskState(env, userEmail, now);
  const snap = riskBudgetSnapshot(state, limit);
  if (!snap.enforced) return { ok: true, budget: snap };
  const want = Math.max(0, num(riskUsd));
  if (want > snap.remaining_usd) {
    return {
      ok: false,
      skipped: true,
      reason: `daily_loss_budget_${Math.round(snap.remaining_usd)}_left_of_${Math.round(limit)}_needs_${Math.round(want)}`,
      budget: snap,
    };
  }
  return { ok: true, budget: snap };
}

/**
 * Record what a CONFIRMED broker place put at risk. Assignment, not
 * increment — replaying the same signal id is a no-op rather than a
 * double-charge.
 */
export async function commitRisk(env, userEmail, signalId, { usd, vehicle = null, ticker = null, now = Date.now() } = {}) {
  if (!env?.KV_TIMED || !userEmail || !signalId) return null;
  const state = await loadRiskState(env, userEmail, now);
  state.open = { ...state.open, [signalId]: { usd: Math.max(0, num(usd)), vehicle, ticker, ts: now } };
  // Deduped, so the day's tally stays right under replay like everything
  // else here.
  if (!state.placed.includes(signalId)) state.placed = [...state.placed, signalId];
  return saveRiskState(env, userEmail, state, now);
}

/**
 * Give the risk back because the order never became a position — cancelled,
 * rejected, or gone. No P&L: nothing was ever owned. Delete, so a replay is
 * a no-op.
 */
export async function releaseRisk(env, userEmail, signalId, { now = Date.now() } = {}) {
  if (!env?.KV_TIMED || !userEmail || !signalId) return null;
  const state = await loadRiskState(env, userEmail, now);
  if (!(signalId in (state.open || {}))) return state;
  const open = { ...state.open };
  delete open[signalId];
  state.open = open;
  return saveRiskState(env, userEmail, state, now);
}

/**
 * A position closed, wholly or partly. The closed portion stops being open
 * risk and becomes realised P&L; whatever is still held stays open at its
 * original per-contract debit.
 *
 * `realizedUsd` is signed — a win is positive and reduces the day's loss.
 */
export async function settleRisk(env, userEmail, signalId, { realizedUsd = 0, remainingRiskUsd = 0, now = Date.now() } = {}) {
  if (!env?.KV_TIMED || !userEmail || !signalId) return null;
  const state = await loadRiskState(env, userEmail, now);
  const open = { ...state.open };
  const prev = open[signalId];
  const remain = Math.max(0, num(remainingRiskUsd));
  if (remain > 0) {
    open[signalId] = { ...(prev || {}), usd: remain, ts: now };
  } else {
    delete open[signalId];
  }
  state.open = open;
  state.realized_pnl_usd = num(state.realized_pnl_usd) + num(realizedUsd);
  return saveRiskState(env, userEmail, state, now);
}

/**
 * Max loss of a long-option ticket. The debit is the whole downside, so the
 * premium actually paid (or the ceiling we are willing to pay, before a fill
 * tells us better) times 100 times the lot count IS the risk.
 */
export function optionDebitUsd(premium, contracts) {
  const px = num(premium);
  const qty = Math.max(0, Math.round(num(contracts)));
  if (!(px > 0) || qty <= 0) return 0;
  return Math.round(px * 100 * qty * 100) / 100;
}
