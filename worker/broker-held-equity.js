// broker-held-equity.js
//
// What the broker ACTUALLY holds, per ticker, across the owner's
// mirror-enabled accounts.
//
// 2026-09-14 — the client ring, the mirror rows and the audit table can all
// lose a dispatch, and they lose it in the one case that costs money. SPYU
// W38 dispatched at 13:50:52Z; the worker isolate was torn down before the
// response landed, so the ring row is still `status:"pending"` and no mirror
// row was ever written. The bridge had already placed at Webull, but the
// cancelled inbound request took its `place` audit row with it — the only
// surviving trace is a 9-share FILL in the account ledger and a live
// position. Every model-side record said "never attempted"; the broker said
// "you own 9 shares". A catch-up that trusts the model-side records buys the
// sleeve a second time with real money.
//
// Positions are the one record written by the broker rather than by us, so
// they are the tiebreaker whenever our own breadcrumbs disagree.

const HELD_CACHE_KEY = "timed:broker:held-equity";
/** Long enough to spare the broker on a 5-min heal loop, short enough that a fresh fill is seen on the next tick. */
export const HELD_CACHE_TTL_MS = 90 * 1000;

/**
 * Sum equity share quantities per ticker. Options are skipped (a `SPY 0C`
 * row is not 13 shares of SPY) and only mirror-enabled accounts count —
 * the mirror never trades the others, so their holdings are not ours.
 */
export function heldEquityFromAccounts(accounts = []) {
  const byTicker = {};
  for (const acct of accounts || []) {
    if (acct?.mirror_enabled !== true) continue;
    for (const item of acct?.items || []) {
      const instrument = String(item?.instrument || "equity").toLowerCase();
      if (instrument && instrument !== "equity" && instrument !== "stock") continue;
      const ticker = String(item?.ticker || "").toUpperCase().trim();
      const qty = Number(item?.broker_qty ?? item?.qty);
      if (!ticker || !Number.isFinite(qty) || qty <= 0) continue;
      const prev = byTicker[ticker] || { qty: 0, avg_cost: null, accounts: [] };
      prev.qty += qty;
      const avg = Number(item?.avg_cost);
      if (prev.avg_cost == null && Number.isFinite(avg) && avg > 0) prev.avg_cost = avg;
      prev.accounts.push(String(acct?.account_id || acct?.label || ""));
      byTicker[ticker] = prev;
    }
  }
  return byTicker;
}

async function getBridgeJson(env, path) {
  const bridgeUrl = env?.BROKER_BRIDGE_URL || "https://bridge.internal";
  const svc = env?.BROKER_BRIDGE;
  const opKey = env?.BROKER_BRIDGE_OPERATOR_KEY;
  if (!opKey) return null;
  const url = `${String(bridgeUrl).replace(/\/$/, "")}${path}`;
  const init = { method: "GET", headers: { Authorization: `Bearer ${opKey}` } };
  const resp = svc && typeof svc.fetch === "function"
    ? await svc.fetch(new Request(url, init))
    : await fetch(url, init);
  return await resp.json().catch(() => null);
}

/**
 * Held equity per ticker for the owner's mirror-enabled accounts.
 *
 * Returns null — never `{}` — when the broker could not be reached, so a
 * caller can tell "holds nothing" from "do not know". Guarding money on an
 * unknown must fail closed, and `{}` reads as "holds nothing".
 */
export async function loadBrokerHeldEquity(env, { owner, nowMs = Date.now(), refresh = false } = {}) {
  const ownerEmail = String(owner || env?.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!ownerEmail) return null;
  const KV = env?.KV_TIMED;
  if (!refresh && KV) {
    try {
      const cached = JSON.parse((await KV.get(HELD_CACHE_KEY)) || "null");
      if (cached?.owner === ownerEmail
        && Number.isFinite(Number(cached.ts))
        && nowMs - Number(cached.ts) < HELD_CACHE_TTL_MS
        && cached.held) {
        return cached.held;
      }
    } catch (_) { /* cache is an optimisation only */ }
  }
  let body = null;
  try {
    body = await getBridgeJson(env, `/bridge/positions?owner=${encodeURIComponent(ownerEmail)}`);
  } catch (_) {
    return null;
  }
  if (!body?.ok || !Array.isArray(body.accounts)) return null;
  const held = heldEquityFromAccounts(body.accounts);
  if (KV) {
    try {
      await KV.put(
        HELD_CACHE_KEY,
        JSON.stringify({ owner: ownerEmail, ts: nowMs, held }),
        { expirationTtl: 600 },
      );
    } catch (_) { /* best-effort */ }
  }
  return held;
}

/**
 * Shares the broker holds for one ticker. `null` means the broker could not
 * be asked — callers must treat that as "unknown", not as zero.
 */
export function heldQtyFor(held, ticker) {
  if (!held || typeof held !== "object") return null;
  const row = held[String(ticker || "").toUpperCase().trim()];
  const qty = Number(row?.qty);
  return Number.isFinite(qty) ? qty : 0;
}
