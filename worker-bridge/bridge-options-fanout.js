// worker-bridge/bridge-options-fanout.js
//
// Fan an options order out to opted-in partner accounts.
//
// The equity webhook (`/bridge/order`) has fanned out to mirror
// participants since multi-tenant launched; the options webhook never did,
// so a partner mirrored equity and LETF shares but silently received none
// of the index day trades. That was a documented limitation rather than a
// bug, which is exactly why it survived: nothing reported a miss, because
// nothing had been asked to place.
//
// These helpers are pure so the sizing and clamp rules can be tested
// without a broker. The dispatch itself lives in bridge-index.js.

import { optionsStrategiesOn, dailyLossLimitFromUser } from "./bridge-options-prefs.js";

/** Matches worker/options-risk-budget.js DEFAULT_STOP_FRACTION. */
export const DEFAULT_STOP_FRACTION = 0.5;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function accountEquityUsd(user) {
  return num(user?.equity_usd)
    ?? num(user?.portfolio?.equity_usd)
    ?? num(user?.net_liquidation_usd)
    ?? null;
}

/**
 * Participants that should receive an options order.
 *
 * `listMirrorParticipants` already drops disconnected rows, rows with
 * mirroring off, FUTURES sub-accounts, and the signal owner. Options need
 * one more opt-in on top of that: the account has to have said yes to
 * option strategies, which is a separate toggle from stock mirroring so a
 * partner can authorize shares without authorizing options.
 */
export function optionsMirrorTargets(participants) {
  return (Array.isArray(participants) ? participants : []).filter(
    (u) => u && optionsStrategiesOn(u),
  );
}

/**
 * The account's own per-order dollar cap for this play's vehicle.
 *
 * Partners set this per vehicle in Broker Connections (the live partner
 * row caps long_call and long_put at $500 each). It is the most explicit
 * instruction an account holder gives about options size, so it outranks
 * anything derived from equity.
 */
export function vehicleMaxPerOrderUsd(user, { archetype = null, vehicle = null } = {}) {
  const key = String(vehicle || archetype || "").toLowerCase();
  if (!key) return null;
  const row = user?.options_prefs?.vehicles?.[key];
  const cap = num(row?.max_per_order_usd);
  return cap != null && cap > 0 ? cap : null;
}

/**
 * Contracts a partner account should take for a model order of
 * `modelContracts`.
 *
 * Same relational rule the equity lane uses in computeRelationalQty: scale
 * by account equity over the model book, capped at 1 so a mirror never
 * takes MORE risk than the model. Contracts are integers and a 1DTE index
 * option is a few hundred dollars, so flooring alone sends most partner
 * accounts to zero forever; a one-lot floor keeps the mirror useful, but
 * only when a single contract is inside that account's own day-loss
 * tolerance. Without that second test the floor would quietly hand a small
 * account the operator's position size.
 *
 * Returns `{ contracts: 0, reason }` when the account should sit this out.
 */
export function scaleContractsForAccount({
  modelContracts,
  premium,
  accountEquity,
  modelBookUsd = 100000,
  dailyLossLimitUsd = null,
  maxPerOrderUsd = null,
  stopFraction = DEFAULT_STOP_FRACTION,
} = {}) {
  const model = Math.round(num(modelContracts) || 0);
  if (!(model > 0)) return { contracts: 0, reason: "invalid_model_contracts" };

  const equity = num(accountEquity);
  if (!(equity > 0)) return { contracts: 0, reason: "account_equity_unknown" };

  const book = num(modelBookUsd) > 0 ? num(modelBookUsd) : 100000;
  const ratio = Math.min(1, equity / book);

  const px = num(premium);
  // Per-contract debit. A quoted option premium is per share.
  const unitUsd = px != null && px > 0 ? px * 100 : null;

  // Tightest dollar ceiling this account allows for one ticket.
  //
  // The day-stop is a risk number, not a notional one: a -50% stop means a
  // $1,000 debit puts $500 at risk, so a $500 limit tolerates a $1,000
  // ticket. The per-order cap is already notional and applies as-is. 0 or
  // missing disables either gate, same as the main worker's contract.
  const limit = num(dailyLossLimitUsd);
  const frac = num(stopFraction) > 0 ? num(stopFraction) : DEFAULT_STOP_FRACTION;
  const fromLossLimit = limit != null && limit > 0 ? limit / frac : null;
  const fromOrderCap = num(maxPerOrderUsd) > 0 ? num(maxPerOrderUsd) : null;
  const ceilings = [fromLossLimit, fromOrderCap].filter((v) => v != null);
  const maxDebit = ceilings.length ? Math.min(...ceilings) : null;
  const capReason = fromOrderCap != null && maxDebit === fromOrderCap
    ? "max_per_order_usd"
    : "daily_loss_limit";

  const capped = (reason) => ({
    contracts: 0, reason, ratio, unit_usd: unitUsd, max_debit_usd: maxDebit,
  });

  // An account that set its own ceilings takes the model's size inside
  // them — the same rule the operator's own account follows. Scaling by
  // equity over a $100k model book on top of that pinned every partner to
  // the one-lot floor (a $9.8k account: floor(2 × 0.098) = 0 → 1), and a
  // one-lot sleeve can never trim. The equity ratio stays for an account
  // that set no ceiling at all, which is the case its caution was for.
  if (maxDebit != null && unitUsd == null) {
    return { contracts: 0, reason: "no_premium_to_check_account_caps", ratio };
  }
  const contracts = maxDebit != null ? model : Math.floor(model * ratio);

  if (contracts < 1) {
    if (unitUsd == null) return { contracts: 0, reason: "no_premium_for_one_lot", ratio };
    if (maxDebit != null && unitUsd > maxDebit) return capped(`one_lot_over_${capReason}`);
    return { contracts: 1, reason: "one_lot_floor", ratio, unit_usd: unitUsd };
  }

  if (maxDebit != null && unitUsd != null && unitUsd > 0) {
    const affordable = Math.floor(maxDebit / unitUsd);
    if (affordable < 1) return capped(`one_lot_over_${capReason}`);
    if (affordable < contracts) {
      return {
        contracts: affordable,
        reason: `capped_by_${capReason}`,
        ratio,
        unit_usd: unitUsd,
        max_debit_usd: maxDebit,
      };
    }
  }

  return { contracts, reason: contracts < model ? "scaled" : "full", ratio, unit_usd: unitUsd };
}

/**
 * Reduce qty for a mirror account.
 *
 * The model sends the qty IT is closing. A partner who scaled down on the
 * way in holds fewer contracts, so the model's qty would trip the sell
 * guard's `sell_qty_exceeds_held` and the partner would be left holding a
 * position the model has already exited — the same stranded-position
 * failure the operator hit on 2026-09-24, just one tenant over.
 *
 * Clamping down can never over-sell, so a reduce is clamped rather than
 * refused. Nothing to close is `0`, which the caller reports and skips.
 * This asymmetry is deliberate and applies to mirror targets ONLY: the
 * operator's own reduce qty is reconciled by the main worker against
 * `timed:opt-dt-mirror`, and silently shrinking it there would hide drift
 * that lane is built to surface.
 */
export function clampReduceToHeld(requestedQty, heldQty) {
  const want = Math.round(num(requestedQty) || 0);
  const held = Math.round(num(heldQty) || 0);
  if (!(want > 0)) return { qty: 0, reason: "no_reduce_requested" };
  if (!(held > 0)) return { qty: 0, reason: "no_held_position" };
  if (held < want) return { qty: held, reason: "clamped_to_held", requested_qty: want, held_qty: held };
  return { qty: want, reason: "full", held_qty: held };
}

/**
 * Mid premium of a model play, per share.
 *
 * `play.premium` is an object (`{ mid }`) on every order the day-trade
 * lane builds, so reading it as a number yields NaN and silently disables
 * every premium-priced rule downstream.
 */
export function modelPremiumMid(play) {
  return num(play?.premium?.mid)
    ?? num(play?.legs?.[0]?.premium_mid)
    ?? num(play?.legs?.[0]?.limit_price)
    ?? num(play?.limit_price)
    ?? num(play?.premium)
    ?? null;
}

/** Contracts the model is trading, from wherever the play carries it. */
export function modelContractsOf(play) {
  return Math.round(num(play?.legs?.[0]?.qty) || num(play?.contracts) || 1);
}

/**
 * Per-account order payload. Mirrors perAccountPayload() on the equity
 * side: own user_id, own account, and an idempotency key suffixed with the
 * account so the same model trade can be claimed once PER account instead
 * of the first target consuming the claim for everyone.
 *
 * Size has to be written onto the LEG as well as `contracts`:
 * playToWebullOptionOrder reads `leg.qty` first and only falls back to
 * `play.contracts`, so setting `contracts` alone would hand the partner
 * the operator's size while every log claimed it had been scaled down.
 */
export function optionsMirrorPayload(payload, user, { contracts = null } = {}) {
  const acctId = String(user?.webull_account_id || user?.ibkr_account_id || user?.user_id || "");
  let coid = payload?.client_order_id || null;
  if (coid) {
    const base = String(coid).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 28);
    const suffix = acctId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
    coid = `${base}${suffix ? `-${suffix}` : ""}`.slice(0, 40);
  }
  let play = payload?.play;
  const qty = Math.round(num(contracts) || 0);
  if (play && qty > 0) {
    play = { ...play, contracts: qty };
    if (Array.isArray(play.legs) && play.legs.length) {
      play.legs = play.legs.map((leg) => ({ ...leg, qty }));
    }
    if (num(play.max_loss_usd) != null) {
      const unit = modelPremiumMid(play);
      if (unit != null && unit > 0) play.max_loss_usd = Math.round(unit * 100 * qty);
    }
  }
  return {
    ...payload,
    user_id: String(user?.user_id || "").toLowerCase(),
    play,
    ...(coid ? { client_order_id: coid } : {}),
  };
}

export { accountEquityUsd, dailyLossLimitFromUser };
