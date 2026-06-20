/**
 * Canonical ticker universe resolver — SINGLE SOURCE OF TRUTH.
 *
 * Background (2026-06-16): the system historically maintained several
 * divergent "ticker lists":
 *   - `GET /timed/tickers` unioned 5 sources (D1 ticker_index, KV
 *     `timed:tickers`, all user_tickers, SECTOR_MAP, MARKET_PULSE_SYMS).
 *   - the scoring cron unioned only 2 (SECTOR_MAP + active user_tickers).
 *   - screener promotion wrote ONLY KV `timed:tickers`, never onboarding
 *     into the scored set.
 * Result: ~29 "orphan" tickers appeared in the registry/Bubble Map but were
 * never scored, clustering at (0,0).
 *
 * Doctrine: the REGISTRY is the source of truth. If a symbol is in the
 * registry, the system MUST be aware of it (i.e. it gets scored). The
 * registry is mutated ONLY through the sanctioned paths:
 *   ADD:    Admin Addition · User Slot Addition · ETF Sync · Screener Promotion
 *   REMOVE: Admin Removal · User Slot Removal · ETF Sync
 *
 * The registry set =
 *   SECTOR_MAP keys  ∪  active user_tickers  ∪  KV `timed:tickers`
 *   ∪  D1 `ticker_index`
 *   − KV `timed:removed`
 *
 * MARKET_PULSE_SYMS (futures/crypto/proxy ETFs) are NOT registry tickers —
 * they are market-context symbols surfaced on the pulse bar and are scored
 * via the price feed, not the HTF/LTF scorer. They are appended only where a
 * caller explicitly opts in (e.g. /timed/all so the pulse bar resolves), and
 * are flagged so consumers can distinguish them.
 */

const _up = (s) => String(s || "").trim().toUpperCase();

/**
 * Pure merge of the registry sources. Order-independent; deduped; sorted;
 * blocklist-filtered. Pass `marketPulse` only when the caller wants the
 * context symbols included (NOT for the scoring universe).
 *
 * @param {object} opts
 * @param {string[]} [opts.sectorMapKeys]
 * @param {string[]} [opts.userTickers]
 * @param {string[]} [opts.kvTickers]       KV `timed:tickers`
 * @param {string[]} [opts.d1IndexTickers]  D1 `ticker_index` (watchlist / admin adds)
 * @param {string[]} [opts.marketPulse] MARKET_PULSE_SYMS (context only)
 * @param {string[]|Set<string>} [opts.removed] KV `timed:removed`
 * @returns {string[]} sorted, uppercased, deduped, blocklist-filtered
 */
export function mergeTickerUniverse({
  sectorMapKeys = [],
  userTickers = [],
  kvTickers = [],
  d1IndexTickers = [],
  marketPulse = [],
  removed = [],
} = {}) {
  const removedSet = removed instanceof Set
    ? new Set([...removed].map(_up))
    : new Set((removed || []).map(_up));
  const out = new Set();
  for (const list of [sectorMapKeys, userTickers, kvTickers, d1IndexTickers, marketPulse]) {
    if (!list) continue;
    for (const t of list) {
      const u = _up(t);
      if (u && !removedSet.has(u)) out.add(u);
    }
  }
  return [...out].sort();
}

/**
 * The SCORED registry — what the scoring cron iterates and what
 * `/timed/tickers` reports. Excludes MARKET_PULSE (context only).
 */
export function resolveScoringUniverse({
  sectorMapKeys = [],
  userTickers = [],
  kvTickers = [],
  d1IndexTickers = [],
  removed = [],
} = {}) {
  return mergeTickerUniverse({ sectorMapKeys, userTickers, kvTickers, d1IndexTickers, removed });
}

/**
 * Load the scored registry from env. Best-effort on each source so a single
 * failing read can't blank the universe.
 *
 * @param {object} env  worker env (KV_TIMED, DB, etc.)
 * @param {object} deps injected accessors (keeps this unit-testable):
 *   - sectorMapKeys: string[]            (Object.keys(SECTOR_MAP))
 *   - getKvTickers:  () => Promise<string[]>  (KV `timed:tickers`)
 *   - getUserTickers:() => Promise<string[]>  (active user slots)
 *   - getD1IndexTickers: () => Promise<string[]>  (D1 `ticker_index`)
 *   - getRemoved:    () => Promise<string[]>  (KV `timed:removed`)
 * @returns {Promise<string[]>}
 */
export async function loadScoringUniverse(env, deps = {}) {
  const {
    sectorMapKeys = [],
    getKvTickers = async () => [],
    getUserTickers = async () => [],
    getD1IndexTickers = async () => [],
    getRemoved = async () => [],
  } = deps;
  const [kvTickers, userTickers, d1IndexTickers, removed] = await Promise.all([
    getKvTickers().catch(() => []),
    getUserTickers().catch(() => []),
    getD1IndexTickers().catch(() => []),
    getRemoved().catch(() => []),
  ]);
  return resolveScoringUniverse({
    sectorMapKeys,
    userTickers: userTickers || [],
    kvTickers: kvTickers || [],
    d1IndexTickers: d1IndexTickers || [],
    removed: removed || [],
  });
}
