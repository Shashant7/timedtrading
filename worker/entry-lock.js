// worker/entry-lock.js
//
// 2026-07-22 — Per-(ticker+direction) entry-idempotency lock.
//
// WHY: Trade-id generation in processTradeSimulation uses Math.random(), so
// two callers that read execState BEFORE either has updated `lastEnterMs`
// will BOTH create trade rows for the same model decision. ETN hit this on
// 2026-07-22: two OPEN trades 7s apart with different trade_ids, two Discord
// alerts, two bridge forwards, and one orphan phantom trade left over after
// dedup_reconcile. The execState cooldown fires too late — it's updated
// AFTER trade creation, so a concurrent second call reads a stale lastEnterMs
// and passes the cooldown gate. We need a KV lock checked + set BEFORE trade
// creation so a second concurrent call sees the first's lock.
//
// This module is exported so the exact semantics are unit-testable in
// isolation without hauling in the giant processTradeSimulation pipeline.

const ENTRY_LOCK_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const ENTRY_LOCK_TTL_SEC = 24 * 60 * 60;    // 24h — self-heals if the window
                                            // bug lets one slip through.

export function entryLockKey(ticker, direction) {
  return `timed:entry_lock:${String(ticker || "").toUpperCase()}:${String(direction || "").toUpperCase()}`;
}

/**
 * Check the entry lock and, if fresh, block. Otherwise refresh it and allow.
 *
 * @param {object} KV - Workers KV binding
 * @param {object} opts
 * @param {string} opts.ticker
 * @param {string} opts.direction  "LONG" | "SHORT"
 * @param {number} opts.now         Date.now() from the caller
 * @param {number} [opts.windowMs]  default 5 minutes
 * @returns {Promise<{ ok: boolean, reason?: string, ageSec?: number, lockKey: string }>}
 *   ok=true  → no recent lock; caller may proceed (lock refreshed).
 *   ok=false → recent lock held; caller must skip this entry.
 */
export async function checkAndSetEntryLock(KV, { ticker, direction, now, windowMs = ENTRY_LOCK_WINDOW_MS } = {}) {
  const lockKey = entryLockKey(ticker, direction);
  if (!KV) return { ok: true, lockKey, reason: "no_kv" };
  try {
    const existing = await KV.get(lockKey);
    const lockTs = existing ? Number(existing) : 0;
    if (Number.isFinite(lockTs) && lockTs > 0 && (now - lockTs) < windowMs) {
      return {
        ok: false,
        reason: "recent_entry_lock",
        ageSec: Math.round((now - lockTs) / 100) / 10,
        lockKey,
      };
    }
    await KV.put(lockKey, String(now), { expirationTtl: ENTRY_LOCK_TTL_SEC });
    return { ok: true, lockKey };
  } catch (e) {
    // Fail OPEN — a busted KV read must not block trading. The 4-hour
    // ENTER_COOLDOWN in processTradeSimulation is the belt-and-suspenders.
    return { ok: true, lockKey, reason: `lock_error:${String(e?.message || e).slice(0, 80)}` };
  }
}
