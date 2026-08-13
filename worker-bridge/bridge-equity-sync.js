// worker-bridge/bridge-equity-sync.js
//
// Connected accounts (mirror on OR off) need live equity + history for the
// Broker Connections value chart. The reconciler only snapshots mirror-on
// accounts; this module fills the gap for every connected account without
// running full drift/fill reconcile.

import { readUser, writeUser } from "./bridge-storage.js";
import { resolveBrokerAccountId, resolveBrokerId } from "./bridge-brokers.js";
import { snapshotAccount, readAccountSnapshots } from "./bridge-account-ledger.js";

const EQUITY_CACHE_FRESH_MS = 60 * 1000;
const EQUITY_CACHE_TTL_SEC = 60 * 60;
const USER_EQUITY_FRESH_MS = 15 * 60 * 1000;
const SNAP_EQUITY_FRESH_MS = 5 * 60 * 1000;

/** Normalize broker portfolio payloads into equity / cash / buying power. */
export function extractPortfolioTotals(portfolio) {
  if (!portfolio || portfolio.ok === false) return null;
  const r = portfolio.response || portfolio;
  const acct = (Array.isArray(portfolio.accounts) && portfolio.accounts[0])
    || portfolio.summary
    || r;
  const equity = Number(
    portfolio.equity
    ?? acct?.netliquidation?.amount ?? acct?.NetLiquidation?.amount
    ?? acct?.equitywithloanvalue?.amount
    ?? acct?.equity?.current ?? acct?.equity ?? acct?.net_liquidation
    ?? acct?.total_net_liquidation_value ?? acct?.total_asset ?? acct?.totalAsset
  );
  const cash = Number(
    portfolio.cash
    ?? acct?.totalcashvalue?.amount ?? acct?.TotalCashValue?.amount
    ?? acct?.availablefunds?.amount
    ?? acct?.cash?.current ?? acct?.cash ?? acct?.total_cash
    ?? acct?.total_cash_balance ?? acct?.totalCash
  );
  const buyingPower = Number(
    portfolio.buying_power
    ?? acct?.buyingpower?.amount ?? acct?.BuyingPower?.amount ?? acct?.buying_power
    ?? acct?.account_currency_assets?.[0]?.buying_power
  );
  const out = {};
  if (Number.isFinite(equity)) out.equity_usd = equity;
  if (Number.isFinite(cash)) out.cash_usd = cash;
  if (Number.isFinite(buyingPower)) out.buying_power_usd = buyingPower;
  return Object.keys(out).length ? out : null;
}

function equityCacheKey(user) {
  return `bridge:equity:${String(user?.user_id || "").toLowerCase()}`;
}

async function readKvJson(env, key) {
  if (!env?.BRIDGE_KV || !key) return null;
  try {
    return JSON.parse((await env.BRIDGE_KV.get(key)) || "null");
  } catch (_) {
    return null;
  }
}

async function writeKvJson(env, key, value, ttlSec) {
  if (!env?.BRIDGE_KV || !key) return;
  try {
    await env.BRIDGE_KV.put(key, JSON.stringify(value), { expirationTtl: ttlSec });
  } catch (_) { /* best-effort */ }
}

/**
 * Resolve + persist equity for one connected account (mirror on or off).
 * Prefers fresh snapshot / user record / KV cache before calling the broker.
 *
 * @returns {{ ok: boolean, equity_usd: number|null, cash_usd: number|null, source: string, stale?: boolean }}
 */
export async function refreshAccountEquitySnapshot(env, user, {
  adapter = null,
  positions = null,
  force = false,
  existingSnap = null,
} = {}) {
  const brokerAccountId = resolveBrokerAccountId(user);
  if (!brokerAccountId || !user?.user_id) {
    return { ok: false, equity_usd: null, cash_usd: null, source: "no_account" };
  }

  const now = Date.now();
  let equity = null;
  let cash = null;
  let buyingPower = null;
  let source = "none";
  let stale = false;

  const snapEq = existingSnap ? Number(existingSnap.equity_usd) : NaN;
  const snapAge = existingSnap ? now - (Number(existingSnap.synced_at) || 0) : Infinity;
  if (!force && Number.isFinite(snapEq) && snapAge >= 0 && snapAge < SNAP_EQUITY_FRESH_MS) {
    equity = snapEq;
    cash = Number.isFinite(Number(existingSnap.cash_usd)) ? Number(existingSnap.cash_usd) : null;
    buyingPower = Number.isFinite(Number(existingSnap.buying_power_usd))
      ? Number(existingSnap.buying_power_usd) : null;
    source = "snapshot";
  }

  if (equity == null) {
    const userEq = Number(user?.equity_usd);
    const userAge = now - (Number(user?.portfolio_synced_at) || 0);
    if (!force && Number.isFinite(userEq) && userAge >= 0 && userAge < USER_EQUITY_FRESH_MS) {
      equity = userEq;
      cash = Number.isFinite(Number(user.cash_usd)) ? Number(user.cash_usd) : null;
      buyingPower = Number.isFinite(Number(user.buying_power_usd)) ? Number(user.buying_power_usd) : null;
      source = "user_record";
    }
  }

  if (equity == null) {
    const cached = await readKvJson(env, equityCacheKey(user));
    const cacheAge = now - (Number(cached?.ts) || 0);
    if (cached && Number.isFinite(Number(cached.equity_usd)) && cacheAge < EQUITY_CACHE_FRESH_MS) {
      equity = Number(cached.equity_usd);
      cash = Number.isFinite(Number(cached.cash_usd)) ? Number(cached.cash_usd) : null;
      buyingPower = Number.isFinite(Number(cached.buying_power_usd)) ? Number(cached.buying_power_usd) : null;
      source = "kv_fresh";
    } else if (cached && Number.isFinite(Number(cached.equity_usd)) && cacheAge < EQUITY_CACHE_TTL_SEC * 1000) {
      // Keep as fallback if the live broker call fails.
      equity = Number(cached.equity_usd);
      cash = Number.isFinite(Number(cached.cash_usd)) ? Number(cached.cash_usd) : null;
      buyingPower = Number.isFinite(Number(cached.buying_power_usd)) ? Number(cached.buying_power_usd) : null;
      source = "kv_stale";
      stale = true;
    }
  }

  const needLive = force || equity == null || source === "kv_stale" || source === "none";
  if (needLive && adapter && typeof adapter.getPortfolio === "function") {
    try {
      const portfolio = await adapter.getPortfolio(env, user);
      const totals = extractPortfolioTotals(portfolio);
      if (totals && Number.isFinite(totals.equity_usd)) {
        equity = totals.equity_usd;
        cash = Number.isFinite(totals.cash_usd) ? totals.cash_usd : cash;
        buyingPower = Number.isFinite(totals.buying_power_usd) ? totals.buying_power_usd : buyingPower;
        source = "broker";
        stale = false;
        await writeKvJson(env, equityCacheKey(user), {
          ts: now,
          equity_usd: equity,
          cash_usd: cash,
          buying_power_usd: buyingPower,
        }, EQUITY_CACHE_TTL_SEC);
      }
    } catch (e) {
      console.warn(
        `[EQUITY_SYNC] getPortfolio failed for ${user.user_id}:`,
        String(e?.message || e).slice(0, 160),
      );
    }
  }

  if (!Number.isFinite(equity)) {
    return { ok: false, equity_usd: null, cash_usd: null, source, stale };
  }

  // Persist onto the user row so sizing / portfolio UIs stay warm.
  try {
    const fresh = (await readUser(env, user.user_id)) || { ...user };
    fresh.equity_usd = equity;
    if (Number.isFinite(cash)) fresh.cash_usd = cash;
    if (Number.isFinite(buyingPower)) fresh.buying_power_usd = buyingPower;
    fresh.portfolio_synced_at = now;
    await writeUser(env, user.user_id, fresh);
  } catch (_) { /* best-effort */ }

  const posRows = Array.isArray(positions)
    ? positions.map((p) => ({
      ticker: String(p.symbol || p.ticker || "").toUpperCase(),
      qty: Number(p.qty ?? p.position ?? p.quantity) || 0,
      avg_cost: Number(p.avg_cost ?? p.avgCost ?? p.avg_price) || null,
      market_value: Number(p.market_value ?? p.marketValue) || null,
      unrealized_pnl: Number(p.unrealized_pnl ?? p.unrealizedPnl) || null,
    })).filter((p) => p.ticker)
    : (Array.isArray(existingSnap?.positions) ? existingSnap.positions : []);

  try {
    await snapshotAccount(env, {
      broker_account_id: brokerAccountId,
      owner_id: user.owner_email || String(user.user_id).split("#")[0] || null,
      user_id: user.user_id,
      broker: resolveBrokerId(user) || user.broker || null,
      account_label: user.webull_account_label || user.webull_account_class || user.account_label || null,
      cash_usd: Number.isFinite(cash) ? cash : null,
      equity_usd: equity,
      buying_power_usd: Number.isFinite(buyingPower) ? buyingPower : null,
      positions: posRows,
      // View-only accounts are not under mirror sync; don't claim drift.
      in_sync: existingSnap ? !!existingSnap.in_sync : true,
      drift: Array.isArray(existingSnap?.drift) ? existingSnap.drift : [],
      synced_at: now,
    });
  } catch (e) {
    console.warn(
      `[EQUITY_SYNC] snapshot failed for ${brokerAccountId}:`,
      String(e?.message || e).slice(0, 160),
    );
  }

  return {
    ok: true,
    equity_usd: equity,
    cash_usd: Number.isFinite(cash) ? cash : null,
    buying_power_usd: Number.isFinite(buyingPower) ? buyingPower : null,
    source,
    stale,
  };
}

/**
 * Ensure every connected account for an owner has a fresh-enough equity
 * snapshot + history point. Used by /bridge/positions and /bridge/equity-curve.
 */
export async function ensureConnectedAccountsEquity(env, accounts, {
  adapterFor = null,
  force = false,
  positionsByUserId = null,
} = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (!list.length) return { ok: true, refreshed: 0, accounts: [] };

  let snapByAcct = new Map();
  try {
    const owners = [...new Set(list.map((a) =>
      String(a?.owner_email || String(a?.user_id || "").split("#")[0] || "").toLowerCase()
    ).filter(Boolean))];
    for (const owner of owners) {
      const snaps = await readAccountSnapshots(env, { owner_id: owner });
      for (const s of snaps) snapByAcct.set(String(s.broker_account_id), s);
    }
  } catch (_) { /* optional */ }

  const out = [];
  let refreshed = 0;
  for (const acct of list) {
    const brokerId = String(resolveBrokerAccountId(acct) || "");
    const adapter = typeof adapterFor === "function" ? adapterFor(acct) : null;
    const positions = positionsByUserId?.get?.(String(acct.user_id))
      || positionsByUserId?.get?.(brokerId)
      || null;
    const res = await refreshAccountEquitySnapshot(env, acct, {
      adapter,
      positions,
      force,
      existingSnap: snapByAcct.get(brokerId) || null,
    });
    if (res.ok) refreshed += 1;
    out.push({
      user_id: acct.user_id,
      broker_account_id: brokerId || null,
      ...res,
    });
  }
  return { ok: true, refreshed, accounts: out };
}
