// Shared buying-power ceiling for every sleeve that hits one broker account.
//
// The model books (trader $100k, investor $100k, index DT $25k, LETF ~$2k)
// size independently. They all settle on the same Webull/IBKR cash. Without
// a reservation + tactical holdback, concurrent entries each see 100% of
// the snapshot and the broker returns insufficient funds.

export const WEBULL_MARKET_BUFFER = 1.02;
export const TACTICAL_CASH_RESERVE_PCT = 0.12;
export const RESERVE_TTL_MS = 3 * 60 * 1000;

const TACTICAL_VEHICLES = new Set([
  "long_call",
  "long_put",
  "index_trend_letf",
  "index_dt",
  "straddle",
  "vertical_spread",
  "moonshot",
  "leaps",
]);

export function isTacticalVehicle(vehicle) {
  return TACTICAL_VEHICLES.has(String(vehicle || "").trim().toLowerCase());
}

export function tacticalSleevesEnabled(user) {
  const v = user?.options_prefs?.vehicles || {};
  return ["long_call", "long_put", "index_trend_letf"].some((k) => !!v[k]?.enabled);
}

export function sleeveReservePct(user, vehicle) {
  if (isTacticalVehicle(vehicle)) return 0;
  return tacticalSleevesEnabled(user) ? TACTICAL_CASH_RESERVE_PCT : 0;
}

export function cashCeilingRaw({ cashUsd, buyingPowerUsd }) {
  const vals = [Number(cashUsd), Number(buyingPowerUsd)]
    .filter((n) => Number.isFinite(n) && n > 0);
  return vals.length ? Math.min(...vals) : null;
}

/**
 * Buy-side usable dollars after concurrent reservations and (for core
 * equity) the tactical cash holdback. Reducers return null = no ceiling.
 */
export function usableBuyingPower({
  cashUsd,
  buyingPowerUsd,
  reservedUsd = 0,
  equityUsd = 0,
  reservePct = 0,
  isReducer = false,
} = {}) {
  if (isReducer) return null;
  const raw = cashCeilingRaw({ cashUsd, buyingPowerUsd });
  if (raw == null) return null;
  const reserved = Math.max(0, Number(reservedUsd) || 0);
  const sleeveHold = (Number.isFinite(Number(equityUsd)) && Number(equityUsd) > 0 && reservePct > 0)
    ? Number(equityUsd) * Number(reservePct)
    : 0;
  return Math.max(0, raw - reserved - sleeveHold);
}

export function maxQtyForCeiling({
  usableUsd,
  entryUsd,
  buffer = WEBULL_MARKET_BUFFER,
} = {}) {
  if (!(Number(usableUsd) > 0) || !(Number(entryUsd) > 0)) return 0;
  return Math.floor((Number(usableUsd) / Number(buffer)) / Number(entryUsd));
}

export function optionDebitUsd({ premium, qty } = {}) {
  const p = Number(premium);
  const q = Number(qty);
  if (!(p > 0) || !(q > 0)) return 0;
  return p * 100 * q;
}

function kv(env) {
  return env?.BRIDGE_KV || env?.KV_TIMED || null;
}

/** Same-isolate ledger so one cron tick cannot double-book cash. */
const _local = new Map();

function localRows(accountId, now) {
  const key = String(accountId || "unknown");
  const live = (_local.get(key) || []).filter((r) => now - Number(r.ts || 0) < RESERVE_TTL_MS);
  _local.set(key, live);
  return live;
}

function mergeRows(a, b, now) {
  const byId = new Map();
  for (const r of [...(a || []), ...(b || [])]) {
    if (!r || now - Number(r.ts || 0) >= RESERVE_TTL_MS) continue;
    const id = String(r.id || "");
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev || Number(r.ts) >= Number(prev.ts)) byId.set(id, r);
  }
  return [...byId.values()];
}

export function reserveKey(accountId) {
  return `bridge:cash-reserved:${String(accountId || "unknown")}`;
}

export async function readReservations(env, accountId, now = Date.now()) {
  const store = kv(env);
  let fromKv = [];
  if (store?.get) {
    try {
      const raw = await store.get(reserveKey(accountId));
      const rows = raw ? JSON.parse(raw) : [];
      fromKv = Array.isArray(rows) ? rows : [];
    } catch { /* ignore */ }
  }
  return mergeRows(fromKv, localRows(accountId, now), now);
}

export async function reservedUsd(env, accountId, now = Date.now()) {
  const rows = await readReservations(env, accountId, now);
  return rows.reduce((s, r) => s + (Number(r.usd) || 0), 0);
}

export async function addReservation(env, accountId, { id, usd } = {}, now = Date.now()) {
  const amount = Number(usd);
  if (!(amount > 0) || !accountId) return { ok: false, reserved_usd: 0 };
  const rid = String(id || `${now}`);
  const local = localRows(accountId, now).filter((r) => String(r.id) !== rid);
  local.push({ id: rid, usd: amount, ts: now });
  _local.set(String(accountId), local);
  const next = await readReservations(env, accountId, now);
  const store = kv(env);
  if (store?.put) {
    await store.put(
      reserveKey(accountId),
      JSON.stringify(next),
      { expirationTtl: Math.ceil(RESERVE_TTL_MS / 1000) + 30 },
    );
  }
  return { ok: true, reserved_usd: next.reduce((s, r) => s + (Number(r.usd) || 0), 0) };
}

export function resetLocalReservations() {
  _local.clear();
}

export async function releaseReservation(env, accountId, id, now = Date.now()) {
  if (!accountId || !id) return { ok: false };
  _local.set(
    String(accountId),
    localRows(accountId, now).filter((r) => String(r.id) !== String(id)),
  );
  const next = (await readReservations(env, accountId, now))
    .filter((r) => String(r.id) !== String(id));
  _local.set(String(accountId), next);
  const store = kv(env);
  if (store?.put) {
    await store.put(
      reserveKey(accountId),
      JSON.stringify(next),
      { expirationTtl: Math.ceil(RESERVE_TTL_MS / 1000) + 30 },
    );
  }
  return { ok: true, reserved_usd: next.reduce((s, r) => s + (Number(r.usd) || 0), 0) };
}
