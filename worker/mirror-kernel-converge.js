// worker/mirror-kernel-converge.js
//
// The main worker's driver for the kernel converge: every model position
// with a reduce that has not been confirmed in every account is priced off
// live marks and sent to the bridge, which sells each account down to its
// sleeve's target and verifies against live holdings.
//
// This is how "the stop actually happened at the broker" is established —
// not by a fill echo on one account, but by each account's own holdings.

import {
  listUnverifiedPositions,
  listPendingMirrorDispatches,
  markMirrorDispatchDispatched,
  markPositionVerified,
} from "./mirror-kernel.js";

/** After this long without every account confirmed, someone is told. */
export const CONVERGE_ALERT_AFTER_MS = 10 * 60 * 1000;

/** Accounts that are not yet where the model is, for a message. */
export function unconvergedAccounts(results = []) {
  return (results || []).filter((r) => r.action !== "verified" && r.action !== "never_opened");
}

export function describeConvergeLag(pos, results) {
  const behind = unconvergedAccounts(results);
  const lines = behind.map((r) => {
    const who = r.is_owner ? "owner" : (r.user_id || r.account_id);
    const held = r.held == null ? "holdings unreadable" : `holds ${r.held}, target ${r.target ?? "?"}`;
    const why = r.sold && !r.sold.ok ? ` — sell refused (${r.sold.reason || "rejected"})` : (r.reason ? ` — ${r.reason}` : "");
    return `• ${who}: ${r.action}, ${held}${why}`;
  });
  return [
    `${pos.last_event} ${pos.signal_id}: ${results.length - behind.length}/${results.length} accounts confirmed at the model's size.`,
    ...lines,
    "The converge retries every minute during the sell window.",
  ].join("\n");
}

async function alertOnce(env, key, embed) {
  try {
    if (await env.KV_TIMED?.get(key)) return false;
    await env.KV_TIMED?.put(key, "1", { expirationTtl: 86400 });
    const { notifyDiscord } = await import("./alerts.js");
    await notifyDiscord(env, embed, "system");
    return true;
  } catch (_) { return false; }
}

export async function convergeIndexDtPositions(env, {
  now = Date.now(),
  limit = 10,
  resolvePremium = null,
  converge = null,
  applyOwnerFill = null,
} = {}) {
  const out = { due: 0, verified: [], sold: [], behind: [], skipped: [], errors: [] };
  const db = env?.DB;
  const operatorEmail = env?.ADMIN_EMAIL;
  if (!db?.prepare || !operatorEmail) return out;

  const mirror = await import("./options-auto-mirror.js");
  const readPremium = resolvePremium || (async (c) => {
    const { resolveLiveOptionPremium, buildOccSymbol } = await import("./options-marks.js");
    return resolveLiveOptionPremium(env, {
      ticker: c.ticker, expirationIso: c.expiration, right: c.right, strike: c.strike,
      optionSymbol: buildOccSymbol(c.ticker, c.expiration, c.right, c.strike), now,
    });
  });
  const send = converge || ((payload) => mirror.convergeKernelPosition(env, operatorEmail, payload));
  const ownerFill = applyOwnerFill || ((sid, args) => mirror.applyKernelOwnerFill(env, sid, args));

  let due;
  try {
    due = await listUnverifiedPositions(db, { now, limit });
  } catch (e) {
    out.errors.push({ reason: `list_failed:${String(e?.message || e).slice(0, 80)}` });
    return out;
  }
  // Dual-path: the outbox is the durable "must dispatch" ledger. Promote
  // pending rows as soon as converge is about to touch them (or already has
  // them via listUnverifiedPositions). Queue fan-out will consume this list
  // later; today it only proves the producer side.
  try {
    const pending = await listPendingMirrorDispatches(db, { now, limit });
    out.outbox_pending = pending.length;
    const dueIds = new Set(due.map((p) => p.position_id));
    for (const row of pending) {
      if (dueIds.has(row.position_id) && row.status === "pending") {
        await markMirrorDispatchDispatched(db, row.position_id, Number(row.seq), now);
      }
    }
  } catch (e) {
    out.errors.push({ reason: `outbox_list_failed:${String(e?.message || e).slice(0, 80)}` });
  }
  out.due = due.length;

  for (const pos of due) {
    const contract = mirror.parseIndexDtSignalId(pos.signal_id);
    if (!contract) { out.skipped.push({ position_id: pos.position_id, reason: "unparseable_signal_id" }); continue; }
    const quote = await readPremium(contract).catch(() => null);
    const mid = Number(quote?.mid);
    if (!(mid > 0)) { out.skipped.push({ position_id: pos.position_id, reason: "no_live_premium" }); continue; }
    const bid = Number(quote?.bid) || null;
    const limitPrice = mirror.marketableCloseLimit({ event: pos.last_event, mid, bid });
    const bookedRef = mirror.marketableCloseReference({ mid, bid });
    const closePlay = mirror.buildIndexDayTradeClosePlay({
      archetype: contract.flavor === "put" ? "day_trade_put" : "day_trade_call",
      ticker: contract.ticker,
      _day_trade_flavor: contract.flavor,
      strikes: { primary: contract.strike },
      expiration: { iso: contract.expiration },
      legs: [{ action: "BUY", optionType: contract.right === "P" ? "PUT" : "CALL", strike: contract.strike, expiration: contract.expiration, qty: 1 }],
    }, {
      ticker: contract.ticker, strike: contract.strike, expiration: { iso: contract.expiration },
      flavor: contract.flavor, qty: 1, limitPrice, event: pos.last_event, signalId: pos.signal_id,
    });
    if (!closePlay) { out.skipped.push({ position_id: pos.position_id, reason: "no_close_play" }); continue; }

    let res;
    try {
      res = await send({
        position_id: pos.position_id,
        trade_id: pos.signal_id,
        ticker: contract.ticker,
        leg_seq: Number(pos.last_seq),
        model: { opened_qty: Number(pos.opened_qty), remaining_qty: Number(pos.remaining_qty) },
        close_play: closePlay,
      });
    } catch (e) {
      out.errors.push({ position_id: pos.position_id, reason: String(e?.message || e).slice(0, 120) });
      continue;
    }
    const body = res?.response || {};
    if (!res?.ok || !body.ok) {
      out.errors.push({ position_id: pos.position_id, reason: body.error || body.reason || `http_${res?.status}` });
      continue;
    }
    const results = Array.isArray(body.results) ? body.results : [];

    for (const r of results) {
      if (r.action === "sell" && r.sold?.ok) {
        out.sold.push({ position_id: pos.position_id, account_id: r.account_id, qty: r.sold.qty, is_owner: r.is_owner });
        const filled = Number(r.sold.fill?.filled_qty) || (String(r.sold.fill?.status || "") === "filled" ? r.sold.qty : 0);
        if (r.is_owner && filled > 0) {
          const avg = Number(r.sold.fill?.avg_price);
          await ownerFill(pos.signal_id, {
            filledQty: filled,
            price: avg > 0 ? avg : bookedRef,
            event: pos.last_event,
          }).catch(() => null);
        }
      }
    }

    if (body.all_verified) {
      await markPositionVerified(db, pos.position_id, Number(pos.last_seq), now);
      out.verified.push(pos.position_id);
      continue;
    }
    const behind = unconvergedAccounts(results);
    out.behind.push({ position_id: pos.position_id, accounts: behind.map((r) => ({ account_id: r.account_id, action: r.action, reason: r.reason || r.sold?.reason || null })) });
    if (now - Number(pos.last_leg_ts || now) >= CONVERGE_ALERT_AFTER_MS) {
      await alertOnce(env, `timed:mirror-kernel:lag-alert:${pos.position_id}:${pos.last_seq}`, {
        title: `${pos.last_event} not confirmed in every account — ${contract.ticker}`,
        description: describeConvergeLag(pos, results).slice(0, 1800),
        color: 0xD64545,
      });
    }
  }
  return out;
}
