// worker-bridge/bridge-equity-sync.js
//
// Connected accounts (mirror on OR off) need live equity + history for the
// Broker Connections value chart. The reconciler only snapshots mirror-on
// accounts; this module fills the gap for every connected account without
// running full drift/fill reconcile.
//
// Freshness rule (2026-08-13): NEVER re-stamp synced_at / portfolio_synced_at
// when reusing a cached value. Re-stamping used to reset the freshness window
// on every page load, so Individual Margin (and other non-mirror accounts)
// kept showing a frozen NLV forever after the first successful fetch.

import { readUser, writeUser } from "./bridge-storage.js";
import { resolveBrokerAccountId, resolveBrokerId } from "./bridge-brokers.js";
import { snapshotAccount, readAccountSnapshots } from "./bridge-account-ledger.js";

const EQUITY_CACHE_FRESH_MS = 60 * 1000;
const EQUITY_CACHE_TTL_SEC = 60 * 60;
/** Align with the Brokers page positions cache — value cards should move with it. */
const SNAP_EQUITY_FRESH_MS = 60 * 1000;
const USER_EQUITY_FRESH_MS = 60 * 1000;

function finiteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normalize broker portfolio payloads into equity / cash / buying power. */
export function extractPortfolioTotals(portfolio) {
  if (!portfolio || portfolio.ok === false) return null;
  const r = portfolio.response || portfolio;
  const acct = (Array.isArray(portfolio.accounts) && portfolio.accounts[0])
    || portfolio.summary
    || r;
  const ccyAssets = Array.isArray(acct?.account_currency_assets)
    ? acct.account_currency_assets
    : (Array.isArray(r?.account_currency_assets) ? r.account_currency_assets : []);
  const usd = ccyAssets.find((a) => String(a?.currency || "").toUpperCase() === "USD")
    || ccyAssets[0]
    || {};

  // Margin accounts often put NLV under currency assets or total_equity /
  // total_market_value rather than total_net_liquidation_value.
  const equity = finiteNumber(
    portfolio.equity
    ?? acct?.netliquidation?.amount ?? acct?.NetLiquidation?.amount
    ?? acct?.equitywithloanvalue?.amount
    ?? acct?.equity?.current ?? acct?.equity
    ?? acct?.net_liquidation ?? acct?.net_liquidation_value
    ?? acct?.total_net_liquidation_value ?? acct?.total_equity
    ?? acct?.total_market_value ?? acct?.total_asset ?? acct?.totalAsset
    ?? usd.net_liquidation_value ?? usd.total_market_value ?? usd.equity
  );
  const cash = finiteNumber(
    portfolio.cash
    ?? acct?.totalcashvalue?.amount ?? acct?.TotalCashValue?.amount
    ?? acct?.availablefunds?.amount
    ?? acct?.cash?.current ?? acct?.cash ?? acct?.total_cash
    ?? acct?.total_cash_balance ?? acct?.totalCash
    ?? usd.cash_balance ?? usd.cash
  );
  const buyingPower = finiteNumber(
    portfolio.buying_power
    ?? acct?.buyingpower?.amount ?? acct?.BuyingPower?.amount ?? acct?.buying_power
    ?? usd.buying_power ?? usd.day_buying_power ?? usd.overnight_buying_power
    ?? acct?.account_currency_assets?.[0]?.buying_power
  );
  const out = {};
  if (equity != null) out.equity_usd = equity;
  if (cash != null) out.cash_usd = cash;
  if (buyingPower != null) out.buying_power_usd = buyingPower;
  return Object.keys(out).length ? out : null;
}

/**
 * Positions + cash estimate used when getPortfolio is rate-limited.
 * Cash+MV is preferred; MV alone is a floor (still better than a frozen NLV).
 */
export function estimateEquityFromHoldings(positions, cashUsd = null) {
  let mv = 0;
  let n = 0;
  for (const p of positions || []) {
    const v = finiteNumber(p?.market_value ?? p?.marketValue);
    if (v == null) continue;
    mv += v;
    n += 1;
  }
  const cash = finiteNumber(cashUsd);
  if (n && cash != null) return mv + cash;
  if (n && mv > 0) return mv;
  if (!n && cash != null && cash >= 0) return cash;
  return null;
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
 * Prefers a still-fresh broker stamp; otherwise calls getPortfolio. Cached
 * reuse NEVER rewrites synced_at (that was freezing Brokers page values).
 *
 * @returns {{ ok: boolean, equity_usd: number|null, cash_usd: number|null, source: string, stale?: boolean }}
 */
export async function refreshAccountEquitySnapshot(env, user, {
  adapter = null,
  positions = null,
  force = false,
  existingSnap = null,
  maxStaleMs = SNAP_EQUITY_FRESH_MS,
} = {}) {
  const brokerAccountId = resolveBrokerAccountId(user);
  if (!brokerAccountId || !user?.user_id) {
    return { ok: false, equity_usd: null, cash_usd: null, source: "no_account" };
  }

  const now = Date.now();
  const freshMs = Number.isFinite(Number(maxStaleMs)) ? Number(maxStaleMs) : SNAP_EQUITY_FRESH_MS;
  let equity = null;
  let cash = null;
  let buyingPower = null;
  let source = "none";
  let stale = false;

  const snapEq = existingSnap ? finiteNumber(existingSnap.equity_usd) : null;
  const snapAge = existingSnap ? now - (Number(existingSnap.synced_at) || 0) : Infinity;
  if (!force && snapEq != null && snapAge >= 0 && snapAge < freshMs) {
    equity = snapEq;
    cash = finiteNumber(existingSnap.cash_usd);
    buyingPower = finiteNumber(existingSnap.buying_power_usd);
    source = "snapshot";
  }

  if (equity == null) {
    const userEq = finiteNumber(user?.equity_usd);
    const userAge = now - (Number(user?.portfolio_synced_at) || 0);
    if (!force && userEq != null && userAge >= 0 && userAge < Math.min(freshMs, USER_EQUITY_FRESH_MS)) {
      equity = userEq;
      cash = finiteNumber(user.cash_usd);
      buyingPower = finiteNumber(user.buying_power_usd);
      source = "user_record";
    }
  }

  if (equity == null) {
    const cached = await readKvJson(env, equityCacheKey(user));
    const cacheAge = now - (Number(cached?.ts) || 0);
    if (cached && finiteNumber(cached.equity_usd) != null && cacheAge < EQUITY_CACHE_FRESH_MS) {
      equity = Number(cached.equity_usd);
      cash = finiteNumber(cached.cash_usd);
      buyingPower = finiteNumber(cached.buying_power_usd);
      source = "kv_fresh";
    } else if (cached && finiteNumber(cached.equity_usd) != null && cacheAge < EQUITY_CACHE_TTL_SEC * 1000) {
      // Keep as fallback if the live broker call fails — do NOT treat as fresh.
      equity = Number(cached.equity_usd);
      cash = finiteNumber(cached.cash_usd);
      buyingPower = finiteNumber(cached.buying_power_usd);
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

  // Rate-limited getPortfolio: prefer cash + live position MVs over a frozen NLV.
  if ((equity == null || stale) && Array.isArray(positions) && positions.length) {
    const estimate = estimateEquityFromHoldings(positions, cash ?? user?.cash_usd ?? existingSnap?.cash_usd);
    if (estimate != null) {
      // Only override when we have nothing, or the estimate clearly moves.
      if (equity == null || Math.abs(estimate - equity) > Math.max(1, Math.abs(equity) * 0.002)) {
        equity = estimate;
        source = "positions_estimate";
        stale = false;
      }
    }
  }

  if (!Number.isFinite(equity)) {
    return { ok: false, equity_usd: null, cash_usd: null, source, stale };
  }

  // Persist only on a true refresh. Reusing a still-fresh snapshot/user/kv
  // value must NOT rewrite synced_at — that was the Brokers page freeze bug.
  const shouldPersist = source === "broker" || source === "positions_estimate";
  if (shouldPersist) {
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
  maxStaleMs = SNAP_EQUITY_FRESH_MS,
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
      maxStaleMs,
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
