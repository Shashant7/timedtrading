/**
 * Which of a scoring tick's changed tickers get their D1 `ticker_latest` row
 * rewritten on THIS tick.
 *
 * 2026-09-23 — the sync was written as "changed tickers only, so ~30-80 a
 * tick". That holds overnight and is false during RTH: every price moves every
 * tick, so the changed set is the whole universe. Measured on tt-engine, the
 * pass cost 73-132s for 32-198 tickers before the open and 280s+ for ~320
 * after it, landing on top of ~270s of scoring and a ~330s entry pass. It is
 * the LAST phase of the tick, so when Cloudflare killed the cron at 900s the
 * sync was what got killed — `[SCORING] deferred tail done` stopped appearing
 * entirely from 13:30 UTC, meaning the rows were not being written at all.
 *
 * D1 `ticker_latest` is a fallback cache; `/timed/all` reads the KV slim index
 * first. So a bounded slice per tick is the right trade, provided the rows that
 * matter are never the ones dropped:
 *
 *   1. `mustSync` — open positions and this tick's stage flips — goes every
 *      tick, whatever the cap
 *   2. the rest rotate on a cursor, so a quiet ticker waits a few ticks
 *      instead of every ticker waiting forever behind a killed invocation
 *
 * The rotation needs a stable order across ticks for the cursor to mean
 * anything. `syms` comes from the snapshot's key order, which follows the
 * universe list the scoring loop walked, so it is stable while the universe is.
 * A universe change shifts the window by a few symbols — it does not starve
 * anything, because the window still sweeps the whole list.
 */

/**
 * @param {object} opts
 * @param {string[]} opts.syms   Changed tickers, in snapshot key order.
 * @param {Set<string>|string[]} [opts.mustSync] Tickers that cannot be deferred.
 * @param {number} [opts.cap]    Max tickers this tick. 0 / absent = no cap.
 * @param {number} [opts.cursor] Rotation cursor from the previous tick.
 * @returns {{batch: string[], must: number, rotated: number, deferred: number,
 *            restCount: number, rotateStart: number, nextCursor: number}}
 */
export function planLatestSyncBatch({ syms, mustSync, cap = 0, cursor = 0 } = {}) {
  const all = Array.isArray(syms) ? syms.filter(Boolean) : [];
  const must0 = mustSync instanceof Set
    ? mustSync
    : new Set(Array.isArray(mustSync) ? mustSync : []);

  const must = [];
  const rest = [];
  for (const sym of all) (must0.has(sym) ? must : rest).push(sym);

  if (!Number.isFinite(cap) || cap <= 0 || all.length <= cap) {
    return {
      batch: must.concat(rest),
      must: must.length,
      rotated: rest.length,
      deferred: 0,
      restCount: rest.length,
      rotateStart: 0,
      nextCursor: 0,
    };
  }

  // Never drop a must-sync row to honour the cap: an open position with a
  // stale D1 fallback row is the failure this whole lane exists to avoid.
  const room = Math.max(0, cap - must.length);
  const take = Math.min(room, rest.length);
  const rotateStart = rest.length
    ? ((Math.trunc(cursor) % rest.length) + rest.length) % rest.length
    : 0;

  const rotated = [];
  for (let i = 0; i < take; i++) rotated.push(rest[(rotateStart + i) % rest.length]);

  return {
    batch: must.concat(rotated),
    must: must.length,
    rotated: rotated.length,
    deferred: rest.length - rotated.length,
    restCount: rest.length,
    rotateStart,
    nextCursor: rest.length ? (rotateStart + rotated.length) % rest.length : 0,
  };
}

/**
 * Where the cursor should sit when the tick only got through part of the plan
 * (the tail hit its deadline). Advancing past symbols that were never written
 * would starve them for a full sweep, so the cursor moves by the number of
 * ROTATED symbols actually processed, not by the number planned.
 *
 * @param {{must: number, restCount: number, rotateStart: number}} plan
 * @param {number} processed Count of `plan.batch` entries actually synced.
 */
export function advanceSyncCursor(plan, processed) {
  const restCount = Number(plan?.restCount) || 0;
  if (!restCount) return 0;
  const done = Math.max(0, (Number(processed) || 0) - (Number(plan?.must) || 0));
  return ((Number(plan?.rotateStart) || 0) + done) % restCount;
}
