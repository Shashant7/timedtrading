// worker-bridge/bridge-options-risk.js
//
// Per-account daily loss budget for options mirrors.
//
// The operator's day-stop lives in the main worker
// (`worker/options-risk-budget.js`, keyed `timed:options:auto-mirror:risk:
// {email}:{date}`) and is enforced before an order ever reaches the bridge.
// Partner accounts had no equivalent: `daily_loss_limit_usd` was stored on
// the row, defaulted to $500, shown in the UI, and enforced nowhere. Once
// options fan out to partners that gap stops being theoretical.
//
// This does NOT reimplement the budget. It reuses the operator's module
// against BRIDGE_KV so a partner's ledger behaves identically to the Roth's
// — same "consumed = open risk + realised losses", same NY-date rollover,
// same assignment-not-increment idempotency. A second implementation of
// money rules is a second set of rounding, rollover and replay bugs.
//
// SCOPE: mirror targets only. The operator's own account is already gated
// upstream by the main worker; charging it again here would let the bridge
// refuse an order the main worker's ledger had already approved and paid
// for, and the two ledgers would drift on their own separate sources.

import {
  loadRiskState,
  riskBudgetSnapshot,
  commitRisk,
  settleRisk,
  releaseRisk,
  optionStopRiskUsd,
  optionDebitUsd,
  DEFAULT_STOP_FRACTION,
} from "../worker/options-risk-budget.js";
import { dailyLossLimitFromUser } from "./bridge-options-prefs.js";

/**
 * The shared module reads `env.KV_TIMED`. The bridge's namespace is
 * BRIDGE_KV, and partner ledgers must not land in the main worker's
 * namespace where the operator's reconcile cron would try to settle them
 * against mirrors that do not exist for a partner.
 */
export function riskEnvFor(env) {
  return { KV_TIMED: env?.BRIDGE_KV || null };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Ledger identity for one account's position in one signal. */
export function riskAccountId(user) {
  return String(user?.user_id || "").toLowerCase();
}

/**
 * How many contracts this account's remaining day budget can still carry.
 *
 * Caps rather than refuses, matching the rest of the sizing ladder: a
 * partner with room for one contract takes one instead of sitting out. 0
 * remaining means the day is done for that account.
 */
export async function budgetContractsFor(env, user, {
  contracts,
  premium,
  stopFraction = DEFAULT_STOP_FRACTION,
  now = Date.now(),
} = {}) {
  const want = Math.max(0, Math.round(num(contracts)));
  const limitUsd = dailyLossLimitFromUser(user);
  if (!(want > 0)) return { contracts: 0, reason: "invalid_contracts", budget: null };
  if (!(limitUsd > 0)) return { contracts: want, reason: "budget_off", budget: null };

  const accountId = riskAccountId(user);
  const state = await loadRiskState(riskEnvFor(env), accountId, now);
  const budget = riskBudgetSnapshot(state, limitUsd);

  const unitRisk = optionStopRiskUsd(premium, 1, { stopFraction });
  // No priceable risk means no defensible charge; let the notional caps and
  // buying power decide rather than inventing a number for the ledger.
  if (!(unitRisk > 0)) return { contracts: want, reason: "no_premium_for_budget", budget };

  const affordable = Math.floor(budget.remaining_usd / unitRisk);
  if (affordable < 1) {
    return {
      contracts: 0,
      reason: `daily_loss_budget_${Math.round(budget.remaining_usd)}_left_of_${Math.round(limitUsd)}`,
      budget,
    };
  }
  if (affordable < want) {
    return { contracts: affordable, reason: "capped_by_daily_loss_budget", budget };
  }
  return { contracts: want, reason: "within_daily_loss_budget", budget };
}

/**
 * Charge a confirmed partner entry against its day budget.
 *
 * The entry premium is stamped into the open row because, unlike the
 * operator, a partner has no `timed:opt-dt-mirror` record to read a basis
 * back out of when the position closes.
 */
export async function commitPartnerRisk(env, user, signalId, {
  contracts,
  premium,
  ticker = null,
  orderId = null,
  stopFraction = DEFAULT_STOP_FRACTION,
  now = Date.now(),
} = {}) {
  if (!signalId) return null;
  const qty = Math.max(0, Math.round(num(contracts)));
  const usd = optionStopRiskUsd(premium, qty, { stopFraction });
  return commitRisk(riskEnvFor(env), riskAccountId(user), signalId, {
    usd,
    ticker,
    orderId,
    now,
    meta: { basis: num(premium), contracts: qty, stop_fraction: stopFraction },
  });
}

/**
 * Book a partner's close: the closed contracts stop being open risk and
 * become realised P&L, and whatever is still held is re-priced.
 *
 * `heldBefore` comes from the sell guard, which has just read the account's
 * real positions — the same number the order was clamped against.
 */
export async function settlePartnerRisk(env, user, signalId, {
  closedQty,
  closePremium,
  heldBefore = null,
  stopFraction = DEFAULT_STOP_FRACTION,
  now = Date.now(),
} = {}) {
  if (!signalId) return null;
  const accountId = riskAccountId(user);
  const state = await loadRiskState(riskEnvFor(env), accountId, now);
  const open = state?.open?.[signalId];
  if (!open) return null;

  const basis = num(open?.meta?.basis);
  const frac = num(open?.meta?.stop_fraction) || stopFraction;
  const closed = Math.max(0, Math.round(num(closedQty)));
  if (closed <= 0) return null;

  const held = heldBefore != null ? Math.max(0, Math.round(num(heldBefore))) : closed;
  const remainingQty = Math.max(0, held - closed);
  const close = num(closePremium);

  // Without a basis or a close price the honest assumption is the one the
  // position was charged at: it ran to the hard stop.
  const realizedUsd = basis > 0 && close > 0
    ? Math.round((close - basis) * 100 * closed * 100) / 100
    : -optionStopRiskUsd(basis, closed, { stopFraction: frac });

  return settleRisk(riskEnvFor(env), accountId, signalId, {
    realizedUsd,
    remainingRiskUsd: optionStopRiskUsd(basis, remainingQty, { stopFraction: frac }),
    now,
  });
}

/** Give back a charge for an entry that never became a position. */
export async function releasePartnerRisk(env, user, signalId, { now = Date.now() } = {}) {
  if (!signalId) return null;
  return releaseRisk(riskEnvFor(env), riskAccountId(user), signalId, { now });
}

/** Read-only view for /bridge/status and the partner digest. */
export async function partnerRiskSnapshot(env, user, { now = Date.now() } = {}) {
  const limitUsd = dailyLossLimitFromUser(user);
  const state = await loadRiskState(riskEnvFor(env), riskAccountId(user), now);
  return riskBudgetSnapshot(state, limitUsd);
}

export { optionDebitUsd, optionStopRiskUsd, DEFAULT_STOP_FRACTION };
