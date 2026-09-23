// worker/trader-exit-catchup.js
//
// 2026-08-27 — Heal Short Term EXITs that wrote D1 but never reached the
// broker (waitUntil torn down on deploy; AMZN 5:07 PM ET). Does NOT buy
// a trade the model already closed (EXPE: no manifest → nothing to sell).

import { catchupTraderExit } from "./broker-bridge-catchup-exit.js";
import { recordBridgeMirrorSkip } from "./broker-bridge-client.js";
import {
  fetchBrokerManifestRows,
  loadBrokerHeldEquityForOwners,
  heldOwnerEmailFor,
  heldForOwner,
  resolveHeldAccount,
  heldQtyFor,
  heldAvgCostFor,
} from "./broker-held-equity.js";
import {
  isNyRegularMarketOpenStatic,
  isEquityBrokerFollowThroughStatic,
} from "./market-calendar.js";

const NOTE_PREFIX = "timed:trader-exit-catchup:";

/** Residual too small for the broker to sell. */
export const EXIT_CATCHUP_FLAT_EPSILON = 1e-6;

/**
 * Webull declines a fractional sell worth less than a cent:
 * "The minimum notional amount of a fractional sell order is $0.01".
 */
export const EXIT_CATCHUP_MIN_SELL_USD = 0.01;

/**
 * Is this residual worth less than the broker will transact?
 *
 * `EXIT_CATCHUP_FLAT_EPSILON` is a SHARE count, but the broker's floor is a
 * NOTIONAL one, so the two only agree by accident. DPZ finished its 09-15
 * exit holding 1e-05 sh — ten times the share epsilon, and four tenths of a
 * cent against a ~$400 print. Catch-up therefore re-offered it every hour
 * from 09-16 to 09-22, collecting an identical rejection each RTH pass and
 * a `fractional_trim_deferred_to_rth` skip each night. Nothing was wrong
 * and nothing could ever go right: no quantity of retries makes $0.004
 * clear a $0.01 floor.
 *
 * Unknown price is NOT dust. Without a price this returns false and the
 * share epsilon decides, so a missing quote can never strand a real exit.
 */
export function exitResidualBelowBrokerMinimum(qty, price, minUsd = EXIT_CATCHUP_MIN_SELL_USD) {
  const q = Number(qty);
  const p = Number(price);
  const floor = Number(minUsd);
  if (!(q > 0) || !Number.isFinite(p) || p <= 0 || !(floor > 0)) return false;
  return q * p < floor;
}

export function rowHoldsReducerQty(row) {
  if (!row) return false;
  // 2026-09-04 (DPZ) — broker HOLDINGS are the truth for exits. The entry
  // preflight rejected for cash and auto-suppressed the manifest, but a
  // later fill left 0.2714 sh at the broker; when the model exited, this
  // suppression check skipped the close and the shares were stranded.
  // Entry-time suppression / rejected state must never block reducing a
  // position the broker actually holds — same doctrine as the index-DT
  // mirror ("closes never cap-gated"). The only gate is real held qty.
  const remaining = Number(row.broker_remaining_qty);
  return Number.isFinite(remaining) && remaining > 1e-9;
}

/**
 * Pair model EXIT ledger rows with broker manifest leftovers.
 * EXPE-class (exit, no manifest) yields no ops. AMZN-class (exit +
 * remaining 0.27) yields one op on the holding account only.
 */
export function planTraderExitCatchup({ exits = [], manifests = [], closedTradeIds = [] } = {}) {
  const byTrade = new Map();
  for (const row of manifests) {
    const id = String(row?.trade_id || "").trim();
    if (!id) continue;
    if (!byTrade.has(id)) byTrade.set(id, []);
    byTrade.get(id).push(row);
  }
  const ops = [];
  const seen = new Set();
  const pushOp = (row, ex = null) => {
    const tid = String(row?.trade_id || ex?.position_id || ex?.trade_id || "").trim();
    if (!tid || !rowHoldsReducerQty(row)) return;
    const key = `${tid}|${row.user_id}|${row.broker_account_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    ops.push({
      trade_id: tid,
      ticker: String(row.ticker || ex?.ticker || "").toUpperCase(),
      user_id: row.user_id,
      broker_account_id: row.broker_account_id,
      qty: Number(row.broker_remaining_qty),
      price: Number(ex?.price) || null,
      exit_ts: Number(ex?.ts) || 0,
    });
  };
  for (const ex of exits) {
    const tid = String(ex?.position_id || ex?.trade_id || "").trim();
    if (!tid) continue;
    for (const row of byTrade.get(tid) || []) pushOp(row, ex);
  }
  // Leftover remaining on a stale OPEN sleeve after the mothership trade
  // already closed (ULTA prior lot 2026-09-10 — EXIT was older than 72h).
  const closed = closedTradeIds instanceof Set ? closedTradeIds : new Set(closedTradeIds);
  for (const row of manifests) {
    const tid = String(row?.trade_id || "").trim();
    const modelClosed = String(row.model_status || "").toUpperCase() === "CLOSED"
      || closed.has(tid);
    if (!modelClosed) continue;
    pushOp(row);
  }
  return ops;
}

/**
 * The broker holds ONE position per (ACCOUNT, ticker); the manifest holds
 * one sleeve per (model trade, account). Several stale sleeves routinely
 * claim the same residual — 2026-09-14 the live plan wanted to sell PH
 * 0.13612 four times, DPZ 0.2714 twice and XLRE 1.35379 twice against a Roth
 * that held exactly one of each. Selling every claim shorts the account with
 * real money, and the zombie claims also fill the hourly `max_ops` window
 * forever, which is why a genuinely missed EXIT never got a turn.
 *
 * So spend a budget per (account, ticker), newest exit first.
 *
 * The budget used to be per TICKER against owner-only holdings, which
 * conflated three separate broker accounts into one pot. Every mirror-enabled
 * account tracks the model with quantities relational to account size, so the
 * same ticker legitimately has one sleeve per account — and the first sleeve
 * processed drained the pot for all of them. NBIS 2026-09-22: the owner's
 * 2-share exit consumed the whole 2-share budget and the partner's 1-share
 * exit was dropped as `broker_position_already_flat`. It was one of 8
 * positions worth $2,656 that the model had closed and the partner's cash
 * account still held.
 *
 * Budget ladder, most to least trustworthy. Each rung is narrower than the
 * one below it, and unknown never means zero:
 *   1. this account's own holdings — exact, and catches a manifest row whose
 *      `broker_remaining_qty` is stale because the sell already filled
 *      (the owner's NBIS sleeve still claimed 2 against a flat account).
 *   2. this OWNER's per-ticker holdings, shared by that owner's accounts we
 *      could not resolve individually.
 *   3. the largest claim on this (account, ticker) — the broker could not be
 *      asked at all. Under-sells (recoverable next hour) rather than
 *      over-sells (not), and still collapses sibling sleeves to one.
 */
export function clampExitOpsToHoldings(ops = [], holdings = null, {
  minSellUsd = EXIT_CATCHUP_MIN_SELL_USD,
} = {}) {
  const ordered = [...(ops || [])].sort((a, b) => (
    (Number(b?.exit_ts) || 0) - (Number(a?.exit_ts) || 0)
    || (Number(b?.qty) || 0) - (Number(a?.qty) || 0)
  ));
  const byAccount = holdings?.byAccount || null;
  const ownerOf = (op) => heldOwnerEmailFor(op?.user_id);
  // Which budget an op spends from. A resolved account gets its own; the
  // unresolved accounts of one owner share that owner's per-ticker pot so
  // they cannot each spend it in full.
  const scopeOf = (op) => {
    const acct = resolveHeldAccount(byAccount, {
      userId: op?.user_id,
      brokerAccountId: op?.broker_account_id,
    });
    if (acct) return { key: acct.id, held: acct.held, resolved: true };
    const owner = ownerOf(op);
    return { key: `owner:${owner}`, held: heldForOwner(holdings, owner), resolved: false };
  };
  const budgets = new Map();
  const budgetFor = (scope, ticker) => {
    const key = `${scope.key}|${ticker}`;
    if (budgets.has(key)) return budgets.get(key);
    const heldQty = heldQtyFor(scope.held, ticker);
    const start = heldQty == null
      ? Math.max(0, ...ordered
        .filter((op) => String(op?.ticker || "").toUpperCase() === ticker
          && scopeOf(op).key === scope.key)
        .map((op) => Number(op?.qty) || 0))
      : heldQty;
    budgets.set(key, start);
    return start;
  };
  const kept = [];
  const dropped = [];
  for (const op of ordered) {
    const ticker = String(op?.ticker || "").toUpperCase();
    const scope = scopeOf(op);
    const want = Number(op?.qty) || 0;
    const room = budgetFor(scope, ticker);
    const qty = Math.min(want, room);
    const heldQty = heldQtyFor(scope.held, ticker);
    if (!(qty > EXIT_CATCHUP_FLAT_EPSILON)) {
      dropped.push({
        ...op,
        held_qty: heldQty,
        held_scope: scope.key,
        skip: "broker_position_already_flat",
      });
      continue;
    }
    // Cost basis stands in for a quote here on purpose: the question is
    // whether the residual is worth a cent, not what it is worth.
    const px = Number(op?.price) > 0 ? Number(op.price) : heldAvgCostFor(scope.held, ticker);
    if (exitResidualBelowBrokerMinimum(qty, px, minSellUsd)) {
      dropped.push({
        ...op,
        held_qty: heldQty,
        held_scope: scope.key,
        residual_usd: qty * Number(px),
        skip: "broker_min_notional_dust",
      });
      continue;
    }
    budgets.set(`${scope.key}|${ticker}`, room - qty);
    kept.push(qty === want ? op : { ...op, qty, claimed_qty: want, clamped: true });
  }
  return { ops: kept, dropped };
}

async function loadExits(env, sinceMs) {
  if (!env?.DB?.prepare) return [];
  try {
    const r = await env.DB.prepare(
      `SELECT position_id, ticker, ts, qty, price
         FROM account_ledger
        WHERE mode = 'trader' AND event_type = 'EXIT' AND ts >= ?1
        ORDER BY ts DESC LIMIT 80`,
    ).bind(sinceMs).all();
    return r?.results || [];
  } catch (_) {
    return [];
  }
}

async function loadClosedTradeIds(env, tradeIds) {
  const closed = new Set();
  if (!env?.DB?.prepare) return closed;
  const unique = [...new Set((tradeIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  for (const id of unique.slice(0, 80)) {
    try {
      const r = await env.DB.prepare(
        `SELECT trade_id FROM trades WHERE trade_id = ?1 AND exit_ts IS NOT NULL LIMIT 1`,
      ).bind(id).first();
      if (r?.trade_id) closed.add(String(r.trade_id));
    } catch (_) { /* best-effort */ }
  }
  return closed;
}

async function loadManifests(env) {
  const rows = await fetchBrokerManifestRows(env, { limit: 400 });
  return (rows || []).filter((row) => Number(row?.broker_remaining_qty) > 1e-9);
}

/**
 * One note per SLEEVE, not per trade. The owner's sleeve and a partner's
 * sleeve share a trade_id, so a trade-keyed note let whichever account was
 * healed first speak for the others.
 */
function noteKeyFor(op) {
  const acct = String(op?.broker_account_id || op?.user_id || "").trim().toLowerCase();
  return `${NOTE_PREFIX}${op?.trade_id}${acct ? `|${acct}` : ""}`;
}

async function recentlyNoted(env, op) {
  try {
    const raw = await env?.KV_TIMED?.get(noteKeyFor(op));
    return !!raw;
  } catch (_) {
    return false;
  }
}

async function noteCatchup(env, op, kind) {
  try {
    await env?.KV_TIMED?.put(
      noteKeyFor(op),
      JSON.stringify({ kind, ts: Date.now() }),
      { expirationTtl: 6 * 3600 },
    );
  } catch (_) { /* best-effort */ }
}

export async function runTraderExitCatchup(env, opts = {}) {
  const dryRun = opts.dry_run !== false;
  const hours = Math.min(168, Math.max(1, Number(opts.hours) || 72));
  const maxOps = Math.min(24, Math.max(1, Number(opts.max_ops) || 8));
  const now = opts.now instanceof Date ? opts.now : new Date();
  const sinceMs = Date.now() - hours * 3600 * 1000;
  const exits = Array.isArray(opts.exits) ? opts.exits : await loadExits(env, sinceMs);
  const manifests = Array.isArray(opts.manifests) ? opts.manifests : await loadManifests(env);
  const leftoverIds = manifests.map((row) => String(row?.trade_id || "").trim()).filter(Boolean);
  const closedTradeIds = opts.closedTradeIds instanceof Set || Array.isArray(opts.closedTradeIds)
    ? opts.closedTradeIds
    : await loadClosedTradeIds(env, leftoverIds);
  const claimed = planTraderExitCatchup({ exits, manifests, closedTradeIds });
  // Ask every tenant with a sleeve in the plan, not just the admin. The
  // owner's broker cannot answer for the partner's account, and treating
  // "did not ask" as "holds nothing" is what cancelled the partner's sells.
  const ownerEmails = [...new Set(
    claimed.map((op) => heldOwnerEmailFor(op?.user_id)).filter(Boolean),
  )];
  const held = opts.held !== undefined
    ? opts.held
    : await loadBrokerHeldEquityForOwners(env, { owners: ownerEmails, nowMs: Date.now() });
  const minSellUsd = Number(opts.min_sell_usd ?? env?.BROKER_MIN_SELL_NOTIONAL_USD)
    || EXIT_CATCHUP_MIN_SELL_USD;
  const { ops: planned, dropped } = clampExitOpsToHoldings(claimed, held, { minSellUsd });
  const rth = isNyRegularMarketOpenStatic(now);
  const eth = isEquityBrokerFollowThroughStatic(now);
  const results = dropped.map((op) => ({ ...op, ok: false }));

  for (const op of planned.slice(0, maxOps)) {
    const qty = Number(op.qty);
    if (!rth && qty < 1) {
      if (!dryRun) {
        const already = await recentlyNoted(env, op);
        if (!already) {
          await recordBridgeMirrorSkip(env, {
            ticker: op.ticker,
            side: "exit",
            reason: "fractional_trim_deferred_to_rth",
            trade_id: op.trade_id,
            qty,
            meta: { source: "trader_exit_catchup" },
          });
          await noteCatchup(env, op, "deferred_rth");
        }
      }
      results.push({ ...op, ok: false, skip: "fractional_trim_deferred_to_rth" });
      continue;
    }
    if (!rth && !eth) {
      results.push({ ...op, ok: false, skip: "equity_ah_too_late_for_broker" });
      continue;
    }
    if (dryRun) {
      results.push({ ...op, ok: true, dry_run: true });
      continue;
    }
    const out = await catchupTraderExit(env, {
      trade_id: op.trade_id,
      dry_run: false,
      user_id: op.user_id,
      broker_account_id: op.broker_account_id,
      qty: op.qty,
      price: op.price,
      reason: opts.reason || "trader_exit_catchup",
    });
    results.push({ ...op, ok: !!out?.ok, bridge: out });
    if (out?.ok) await noteCatchup(env, op, "forwarded");
  }

  // Report knowledge per tenant. A single boolean hid the case this whole
  // lane exists for: the owner answered, the partner did not, and the
  // partner's sleeves were budgeted as flat.
  const unknownOwners = held?.owners
    ? ownerEmails.filter((e) => held.owners[e]?.held == null)
    : (held == null ? ownerEmails : []);

  return {
    ok: true,
    dry_run: dryRun,
    planned: planned.length,
    claimed: claimed.length,
    flat_dropped: dropped.length,
    dust_dropped: dropped.filter((op) => op.skip === "broker_min_notional_dust").length,
    held_known: unknownOwners.length === 0,
    owners: ownerEmails,
    owners_unknown: unknownOwners,
    results,
    forwarded: results.filter((r) => r.ok && !r.dry_run && !r.skip).length,
  };
}
