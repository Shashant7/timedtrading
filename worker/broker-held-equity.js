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

/**
 * The app user behind a manifest `user_id` / positions `account_id`.
 *
 * A partner's sleeves are keyed by the SUFFIXED id
 * (`partner@example.com#webull#individual-cash`) while the owner's fan-out
 * sleeves are keyed by the bare email, so the suffix is the only thing
 * standing between "two accounts" and "two people". `/bridge/positions` is
 * scoped by owner, so the base email is what decides whose broker to ask.
 */
export function heldOwnerEmailFor(userId) {
  return String(userId || "").trim().toLowerCase().split("#")[0] || "";
}

/** Every id a positions account answers to, lowercased. */
export function heldAccountKeys(acct) {
  const keys = new Set();
  for (const k of ["broker_account_id", "webull_account_id", "ibkr_account_id", "rh_account_number", "account_id"]) {
    const v = acct?.[k];
    if (v != null && String(v).trim()) keys.add(String(v).trim().toLowerCase());
  }
  return keys;
}

/**
 * Held equity per ticker, kept SEPARATE per broker account.
 *
 * `heldEquityFromAccounts` sums across accounts, which is the right answer
 * for "does anyone hold this" and the wrong one for "how much may this
 * sleeve sell". The broker holds one position per (account, ticker); a
 * budget spent from a cross-account total lets whichever sleeve is
 * processed first consume shares that live in somebody else's account.
 * 2026-09-22 that dropped the partner's 1-share NBIS exit as
 * `broker_position_already_flat` because the owner's 2-share exit had
 * already emptied the shared budget, and left 8 positions worth $2,656
 * stranded in the partner's cash account.
 */
export function heldEquityByAccount(accounts = []) {
  const out = {};
  for (const acct of accounts || []) {
    if (acct?.mirror_enabled !== true) continue;
    const keys = [...heldAccountKeys(acct)];
    if (!keys.length) continue;
    const held = {};
    for (const item of acct?.items || []) {
      const instrument = String(item?.instrument || "equity").toLowerCase();
      if (instrument && instrument !== "equity" && instrument !== "stock") continue;
      const ticker = String(item?.ticker || "").toUpperCase().trim();
      const qty = Number(item?.broker_qty ?? item?.qty);
      if (!ticker || !Number.isFinite(qty) || qty <= 0) continue;
      const prev = held[ticker] || { qty: 0, avg_cost: null };
      prev.qty += qty;
      const avg = Number(item?.avg_cost);
      if (prev.avg_cost == null && Number.isFinite(avg) && avg > 0) prev.avg_cost = avg;
      held[ticker] = prev;
    }
    // One canonical entry per account, reachable under every alias, so a
    // sleeve keyed by broker_account_id and one keyed by the suffixed
    // user_id resolve to the SAME budget rather than to two.
    out[keys[0]] = { id: keys[0], keys, held };
    for (const k of keys.slice(1)) out[k] = out[keys[0]];
  }
  return out;
}

/**
 * Which per-account holdings entry a manifest sleeve belongs to, or null
 * when the broker never reported an account we can tie it to. Null means
 * UNKNOWN — callers must not read it as "holds nothing".
 */
export function resolveHeldAccount(byAccount, { userId, brokerAccountId } = {}) {
  if (!byAccount || typeof byAccount !== "object") return null;
  for (const candidate of [brokerAccountId, userId]) {
    const key = String(candidate || "").trim().toLowerCase();
    if (key && byAccount[key]) return byAccount[key];
  }
  return null;
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
 * Did every mirror-enabled account actually answer with its positions?
 *
 * `/bridge/positions` reports per-account success, not per-request: a
 * rate-limited or throwing `getEquityPositions` sets `positions_error` on
 * that account, coerces its positions to `[]` (`if (brokerPositions ===
 * null) brokerPositions = []`), and STILL returns `{ ok: true, accounts:
 * [...] }` overall — the envelope is about the bridge being reachable, not
 * about the broker having answered. Summing `items` across those accounts
 * yields `{}`, which is the one value this module promises never to
 * return.
 *
 * `positions_stale` counts as not answering too. It means the live fetch
 * failed and the endpoint degraded to a snapshot up to an hour old. For
 * rendering a page an aged number beats an error, but this module exists
 * to guard money against records that say "never attempted" while the
 * broker says "you own 9 shares" — and a snapshot taken before the fill
 * says exactly that. Deferring costs one tick; double-buying is real
 * money and cannot be undone.
 */
export function heldAccountsAnswered(accounts = []) {
  const blind = [];
  for (const acct of accounts || []) {
    if (acct?.mirror_enabled !== true) continue;
    const reason = acct?.positions_error
      || (acct?.positions_stale ? (acct?.positions_stale_reason || "positions_stale") : null);
    if (reason) blind.push({ account: String(acct?.account_id || acct?.label || "?"), reason: String(reason) });
  }
  return { ok: blind.length === 0, blind };
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
  const answered = heldAccountsAnswered(body.accounts);
  if (!answered.ok) {
    // Unknown, so return unknown — and do NOT cache it. Caching `{}` for
    // the 90s freshness window would keep every heal loop reading "the
    // broker holds nothing" long after the broker started answering.
    console.warn("[HELD-EQUITY] positions unavailable for "
      + `${answered.blind.length} mirror-enabled account(s): `
      + answered.blind.map(b => `${b.account}=${b.reason}`).join(", ").slice(0, 300));
    return null;
  }
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
 * Held equity for EVERY mirroring tenant, not just the owner.
 *
 * `loadBrokerHeldEquity` asks `/bridge/positions?owner=<admin>`, so the only
 * holdings it can ever see are the owner's. Every mirror-enabled account is
 * supposed to track the model with quantities relational to account size, so
 * a heal lane that budgets reduces against owner-only holdings is blind to
 * two thirds of the book — and being blind reads as "flat", which silently
 * cancels the partner's sell.
 *
 * Each owner is resolved independently and fails closed on its own: an owner
 * whose broker could not be asked gets `held: null` rather than `{}`, so one
 * rate-limited account cannot make another owner's sleeves look sold.
 */
export async function loadBrokerHeldEquityForOwners(env, { owners = [], nowMs = Date.now(), refresh = false } = {}) {
  const emails = [...new Set(
    (owners || []).map((o) => heldOwnerEmailFor(o)).filter(Boolean),
  )];
  if (!emails.length) {
    const fallback = heldOwnerEmailFor(env?.ADMIN_EMAIL);
    if (fallback) emails.push(fallback);
  }
  const out = { owners: {}, byAccount: {}, unknown: [] };
  for (const email of emails) {
    let body = null;
    try {
      body = await getBridgeJson(env, `/bridge/positions?owner=${encodeURIComponent(email)}`);
    } catch (_) { body = null; }
    if (!body?.ok || !Array.isArray(body.accounts)) {
      out.owners[email] = { held: null, byAccount: {} };
      out.unknown.push(email);
      continue;
    }
    const answered = heldAccountsAnswered(body.accounts);
    if (!answered.ok) {
      console.warn(`[HELD-EQUITY] positions unavailable for ${email}: `
        + answered.blind.map((b) => `${b.account}=${b.reason}`).join(", ").slice(0, 300));
      out.owners[email] = { held: null, byAccount: {} };
      out.unknown.push(email);
      continue;
    }
    const byAccount = heldEquityByAccount(body.accounts);
    out.owners[email] = { held: heldEquityFromAccounts(body.accounts), byAccount };
    for (const [key, entry] of Object.entries(byAccount)) {
      if (!out.byAccount[key]) out.byAccount[key] = entry;
    }
  }
  out.nowMs = nowMs;
  out.refresh = refresh;
  return out;
}

/** Per-ticker holdings for one owner, or null when that owner is unknown. */
export function heldForOwner(holdings, owner) {
  const email = heldOwnerEmailFor(owner);
  if (!holdings || typeof holdings !== "object") return null;
  if (!holdings.owners) return holdings; // legacy per-ticker map
  return holdings.owners[email]?.held ?? null;
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

/**
 * The broker's own average cost for a held ticker, or null.
 *
 * Only good enough to answer order-of-magnitude questions ("is this residual
 * worth a cent?"), never to price an order — cost basis is not a quote.
 */
export function heldAvgCostFor(held, ticker) {
  if (!held || typeof held !== "object") return null;
  const row = held[String(ticker || "").toUpperCase().trim()];
  const avg = Number(row?.avg_cost);
  return Number.isFinite(avg) && avg > 0 ? avg : null;
}

/**
 * Manifest rows: one sleeve per (model trade, broker account). Callers that
 * need per-account detail use these directly; callers that only need "did
 * the broker ever hold this trade" use `loadBrokerSleeves`.
 *
 * Never filter on `remaining=1`. ULTA 2026-09-10 still held 0.07902 on a
 * suppressed lot and that filter hid the sleeve from the catch-up.
 */
export async function fetchBrokerManifestRows(env, { limit = 400 } = {}) {
  try {
    const body = await getBridgeJson(env, `/bridge/manifest?limit=${Number(limit) || 400}`);
    return Array.isArray(body?.rows) ? body.rows : null;
  } catch (_) {
    return null;
  }
}

function sleeveKey(tradeId) {
  return String(tradeId || "").trim().replace(/^inv-/, "").toLowerCase();
}

/**
 * Per-model-trade broker sleeves, summed across accounts.
 *
 * Per-ticker holdings cannot answer "did the broker ever mirror THIS
 * trade": on 2026-09-14 the Roth held 0.2714 DPZ and 3.55 KO, so the
 * per-ticker check called the DPZ and KO trader EXITs actionable — but the
 * holdings belonged to older lots and an investor DCA sleeve, and the
 * exited trades had no sleeve at all. Their entries never mirrored, so
 * their exits have nothing to sell and page forever.
 *
 * Returns null when the bridge could not be reached.
 */
export async function loadBrokerSleeves(env, { limit = 400 } = {}) {
  const rows = await fetchBrokerManifestRows(env, { limit });
  if (!rows) return null;
  const bySleeve = {};
  for (const row of rows) {
    const key = sleeveKey(row?.trade_id);
    if (!key) continue;
    const prev = bySleeve[key] || { filled: 0, remaining: 0, accounts: 0 };
    prev.filled += Math.max(0, Number(row?.broker_filled_qty) || 0);
    prev.remaining += Math.max(0, Number(row?.broker_remaining_qty) || 0);
    prev.accounts += 1;
    bySleeve[key] = prev;
  }
  return bySleeve;
}

/**
 * `{ filled, remaining }` for one model trade, or null when sleeves are
 * unknown. An absent sleeve in a known map is `{ filled: 0, remaining: 0 }`
 * — the broker was asked and has never heard of the trade.
 */
export function sleeveFor(sleeves, tradeId) {
  if (!sleeves || typeof sleeves !== "object") return null;
  const key = sleeveKey(tradeId);
  if (!key) return null;
  return sleeves[key] || { filled: 0, remaining: 0, accounts: 0 };
}
