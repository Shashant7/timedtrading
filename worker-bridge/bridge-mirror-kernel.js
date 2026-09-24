// worker-bridge/bridge-mirror-kernel.js
//
// The bridge's half of the entangled mirror kernel (worker/mirror-kernel.js):
// every options order for every account — operator or partner, entry or
// reduce, placed or refused — is recorded as an attempt against that
// account's sleeve of the model position. The bridge is the one place every
// account's order passes through, which is what makes the attempt table the
// lock that stops two paths selling the same contracts.
//
// Recording is best-effort by construction: a D1 failure logs and returns.
// It must never unplace or block a live order.

import {
  ensureSleeve,
  setSleeveStatus,
  upsertAttempt,
  nextAttemptNumber,
  kernelClientOrderId,
  canonicalDivergence,
  attemptStatusFromFill,
  loadSleeves,
} from "../worker/mirror-kernel.js";
import { resolveBrokerAccountId } from "./bridge-brokers.js";

function warn(what, e) {
  console.warn(`[MIRROR KERNEL] ${what}:`, String(e?.message || e).slice(0, 160));
}

/**
 * Who and what this order is for, or null when it is not a kernel order
 * (no position id — a lane not on the kernel yet, or a pre-kernel payload).
 */
export function kernelContext(env, sanitized, user, { isOwner = false } = {}) {
  const db = env?.BRIDGE_DB;
  const positionId = String(sanitized?.position_id || "").trim();
  if (!db?.prepare || !positionId) return null;
  const accountId = resolveBrokerAccountId(user) || String(user?.user_id || "").toLowerCase() || null;
  if (!accountId) return null;
  const seq = Number.isInteger(sanitized?.leg_seq) ? sanitized.leg_seq : null;
  return {
    db,
    positionId,
    seq,
    accountId,
    userId: String(user?.user_id || sanitized?.user_id || "").toLowerCase() || null,
    ownerId: String(user?.owner_email || "").toLowerCase() || null,
    isOwner: !!isOwner,
    source: sanitized?.source || null,
  };
}

function sideOf(brokerOrder, sanitized) {
  const action = String(
    brokerOrder?.action || sanitized?.play?.legs?.[0]?.action || "BUY",
  ).toUpperCase();
  return action === "SELL" ? "sell" : "buy";
}

/**
 * Assign the order's client_order_id and record it as `sending` BEFORE it
 * goes to the broker. A crash between here and the broker leaves a row whose
 * id is known, so the order can be asked for by id instead of guessed at.
 */
export async function kernelBeforeSend(kctx, brokerOrder, sanitized) {
  if (!kctx || !brokerOrder) return null;
  try {
    await ensureSleeve(kctx.db, kctx);
    const attempt = await nextAttemptNumber(kctx.db, kctx);
    const coid = await kernelClientOrderId({ ...kctx, attempt });
    await upsertAttempt(kctx.db, {
      clientOrderId: coid,
      positionId: kctx.positionId,
      accountId: kctx.accountId,
      userId: kctx.userId,
      seq: kctx.seq,
      attempt,
      side: sideOf(brokerOrder, sanitized),
      requestedQty: Number(brokerOrder.qty) || null,
      status: "sending",
      source: kctx.source,
    });
    brokerOrder.client_order_id = coid;
    return coid;
  } catch (e) {
    warn("attempt not recorded before send", e);
    return null;
  }
}

/**
 * Record how an order ended up: filled, working, refused before sending, or
 * rejected by the broker. Updates the sleeve's status with a reason from the
 * closed set when an entry did not happen.
 */
export async function kernelRecordOutcome(kctx, {
  coid = null, brokerOrder = null, sanitized = null, fill = null, placed = null,
  placeOk = false, rejectReason = null,
} = {}) {
  if (!kctx) return;
  try {
    await ensureSleeve(kctx.db, kctx);
    const side = sideOf(brokerOrder, sanitized);
    let clientOrderId = coid;
    let attempt = null;
    if (!clientOrderId) {
      // Refused before anything was sent. Still an attempt: the account was
      // considered for this leg and the reason belongs on the record.
      attempt = await nextAttemptNumber(kctx.db, kctx);
      clientOrderId = await kernelClientOrderId({ ...kctx, attempt });
    }
    const status = attemptStatusFromFill(fill, { placed: placeOk });
    const filled = status === "filled"
      ? (Number(fill?.filled_qty) > 0 ? Number(fill.filled_qty) : Number(brokerOrder?.qty) || 0)
      : (Number(fill?.filled_qty) || 0);
    const reason = placeOk ? (status === "dead" ? (fill?.reason || fill?.status || null) : null)
      : (rejectReason || fill?.reason || placed?.error || "rejected");
    await upsertAttempt(kctx.db, {
      clientOrderId,
      positionId: kctx.positionId,
      accountId: kctx.accountId,
      userId: kctx.userId,
      seq: kctx.seq,
      attempt,
      side,
      requestedQty: Number(brokerOrder?.qty) || null,
      filledQty: filled,
      avgPrice: fill?.avg_price ?? null,
      brokerOrderId: fill?.order_id || placed?.response?.order_id || placed?.order_id || null,
      status,
      reason,
      source: kctx.source,
    });
    if (side === "buy") await updateEntrySleeve(kctx, { status, reason });
  } catch (e) {
    warn("outcome not recorded", e);
  }
}

async function updateEntrySleeve(kctx, { status, reason }) {
  const [sleeve] = (await loadSleeves(kctx.db, kctx.positionId))
    .filter((s) => s.account_id === kctx.accountId);
  if (sleeve?.opened_qty > 0 || status === "filled") {
    await setSleeveStatus(kctx.db, { ...kctx, status: "open" });
    return;
  }
  if (status !== "rejected" && status !== "dead") return;
  const canonical = canonicalDivergence(reason, "buy");
  await setSleeveStatus(kctx.db, {
    ...kctx,
    status: canonical ? "diverged" : "defect",
    reason: canonical,
    detail: reason,
  });
}

/**
 * An account the fan-out considered and sized out before placing — the loss
 * budget, a cap, an unknown equity. It still gets a sleeve, so "why does
 * this account not hold the model's position" has an answer on the record.
 */
export async function kernelRecordSkip(kctx, reason) {
  if (!kctx) return;
  await kernelRecordOutcome(kctx, {
    brokerOrder: { action: "BUY" },
    placeOk: false,
    rejectReason: reason || "skipped",
  });
}

/**
 * Fold a broker fill read by order id into its attempt. Called wherever an
 * order's status is polled, so the operator's own polls keep every sleeve
 * current too.
 */
export async function kernelApplyPolledFill(db, attemptRow, fill) {
  if (!db || !attemptRow || !fill) return;
  try {
    const status = attemptStatusFromFill(fill);
    await upsertAttempt(db, {
      clientOrderId: attemptRow.client_order_id,
      positionId: attemptRow.position_id,
      accountId: attemptRow.account_id,
      side: attemptRow.side,
      filledQty: status === "filled"
        ? (Number(fill.filled_qty) > 0 ? Number(fill.filled_qty) : Number(attemptRow.requested_qty) || 0)
        : (Number(fill.filled_qty) || 0),
      avgPrice: fill.avg_price ?? null,
      brokerOrderId: fill.order_id || attemptRow.broker_order_id || null,
      status,
      reason: status === "dead" ? String(fill.status || "dead") : null,
    });
  } catch (e) {
    warn("polled fill not recorded", e);
  }
}
