/**
 * Adaptive gates for investor catch-up / broker mirror retries.
 *
 * A model lot that never reached the broker must NOT be blindly replayed
 * days later if price has run away or the thesis no longer supports an add.
 * Sells (risk reduction) stay more permissive.
 *
 * Pure helpers — no I/O — so unit tests pin the contract without D1/KV.
 */

/** Stages where an ADD / DCA catch-up must not fire. */
export const CATCHUP_BUY_BLOCK_STAGES = Object.freeze([
  "reduce",
  "exited",
  "exit",
  "research_avoid",
  "research_low",
]);

/** Stages that still support a scale-in / DCA catch-up. */
export const CATCHUP_BUY_OK_STAGES = Object.freeze([
  "accumulate",
  "watch",
  "core_hold",
]);

/**
 * @typedef {object} CatchupGateInput
 * @property {"buy"|"dca"|"add"|"trim"|"exit"|"sell"|string} kind
 * @property {number|null|undefined} lotPrice   Price on the original lot
 * @property {number|null|undefined} livePrice  Current live / headline price
 * @property {string|null|undefined} stage      From timed:investor:scores
 * @property {number|null|undefined} score
 * @property {object|null|undefined} accumZone  { zoneType?, exhaustionWarnings? }
 * @property {number} [maxBuyDriftPct=5]        Skip buy if live > lot × (1+pct/100)
 * @property {number} [minScoreBuy=30]          Aligns with live DCA floor
 * @property {boolean} [force=false]            Operator bypass
 */

/**
 * Evaluate whether a catch-up op should proceed.
 * @param {CatchupGateInput} input
 * @returns {{ allow: boolean, reason: string|null, drift_pct: number|null, detail?: object }}
 */
export function evaluateCatchupThesisGate(input = {}) {
  const force = input.force === true;
  if (force) {
    return { allow: true, reason: null, drift_pct: null, detail: { forced: true } };
  }

  const kind = String(input.kind || "").toLowerCase();
  const isBuy = kind === "buy" || kind === "dca" || kind === "add" || kind === "open";
  const isSell = kind === "sell" || kind === "trim" || kind === "exit" || kind === "close" || kind === "reduce";

  const lotPrice = Number(input.lotPrice);
  const livePrice = Number(input.livePrice);
  const score = input.score == null ? null : Number(input.score);
  const stage = String(input.stage || "").toLowerCase();
  const maxBuyDriftPct = Number.isFinite(Number(input.maxBuyDriftPct))
    ? Number(input.maxBuyDriftPct)
    : 5;
  const minScoreBuy = Number.isFinite(Number(input.minScoreBuy))
    ? Number(input.minScoreBuy)
    : 30;

  let driftPct = null;
  if (Number.isFinite(lotPrice) && lotPrice > 0 && Number.isFinite(livePrice) && livePrice > 0) {
    driftPct = ((livePrice - lotPrice) / lotPrice) * 100;
  }

  // Sells / trims / exits: always allow (risk reduction). Price drift against
  // a reducer is not a reason to leave exposure on the broker.
  if (isSell) {
    return { allow: true, reason: null, drift_pct: driftPct, detail: { side: "sell" } };
  }

  if (!isBuy) {
    return { allow: true, reason: null, drift_pct: driftPct, detail: { side: "unknown" } };
  }

  // --- Buy / DCA / add gates ---

  if (stage && CATCHUP_BUY_BLOCK_STAGES.includes(stage)) {
    return {
      allow: false,
      reason: "stage_blocks_add",
      drift_pct: driftPct,
      detail: { stage, score },
    };
  }

  // If we have a stage and it's not in the OK set (and not empty), be
  // conservative — e.g. research_on_watch without a clear accumulate signal.
  if (stage && !CATCHUP_BUY_OK_STAGES.includes(stage) && !CATCHUP_BUY_BLOCK_STAGES.includes(stage)) {
    // Unknown / research stages: only allow when score is clearly healthy.
    if (score == null || !Number.isFinite(score) || score < Math.max(minScoreBuy, 50)) {
      return {
        allow: false,
        reason: "stage_not_addable",
        drift_pct: driftPct,
        detail: { stage, score },
      };
    }
  }

  if (score != null && Number.isFinite(score) && score < minScoreBuy) {
    return {
      allow: false,
      reason: "score_low",
      drift_pct: driftPct,
      detail: { stage, score, minScoreBuy },
    };
  }

  const zoneType = String(input.accumZone?.zoneType || "").toLowerCase();
  const exhausted = zoneType.includes("exhaust")
    || (Array.isArray(input.accumZone?.exhaustionWarnings)
      && input.accumZone.exhaustionWarnings.length > 0);
  if (exhausted && stage !== "accumulate") {
    return {
      allow: false,
      reason: "zone_exhausted",
      drift_pct: driftPct,
      detail: { stage, zoneType },
    };
  }

  // Price chase: live meaningfully above the original lot print.
  if (driftPct != null && driftPct > maxBuyDriftPct) {
    return {
      allow: false,
      reason: "price_drift_above",
      drift_pct: driftPct,
      detail: {
        lotPrice,
        livePrice,
        maxBuyDriftPct,
        stage,
        score,
      },
    };
  }

  // Missing live price is a soft skip for buys — don't chase blind.
  if (!(Number.isFinite(livePrice) && livePrice > 0)) {
    return {
      allow: false,
      reason: "no_live_price",
      drift_pct: null,
      detail: { lotPrice },
    };
  }

  return {
    allow: true,
    reason: null,
    drift_pct: driftPct,
    detail: { stage, score, lotPrice, livePrice },
  };
}

/** Catch-up signal TTL: 4 hours of NY regular session time (ETH excluded). */
export const CATCHUP_SIGNAL_TTL_RTH_MS = 4 * 60 * 60 * 1000;

const RTH_OPEN_MIN = 9 * 60 + 30;  // 9:30 ET
const RTH_CLOSE_MIN = 16 * 60;     // 16:00 ET

/**
 * ET calendar fields for a UTC ms timestamp.
 * @returns {{ y: number, m: number, d: number, mins: number, dow: number }}
 *   dow: 0=Sun … 6=Sat (America/New_York)
 */
export function etPartsFromMs(ms) {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // some engines emit 24:00
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    mins: hour * 60 + Number(map.minute),
    dow: wd[map.weekday] ?? 0,
  };
}

/**
 * Milliseconds of NY RTH (Mon–Fri 9:30–16:00 ET) between fromMs and toMs.
 * Extended hours / overnight / weekends do NOT count. Holiday-aware calendars
 * can inject `isRthDay(etYmd)` — default treats weekdays as RTH days.
 *
 * @param {number} fromMs
 * @param {number} toMs
 * @param {{ isRthDay?: (ymd: string) => boolean }} [opts]
 */
export function rthElapsedMs(fromMs, toMs, opts = {}) {
  const a = Number(fromMs);
  const b = Number(toMs);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;

  const isRthDay = typeof opts.isRthDay === "function"
    ? opts.isRthDay
    : (ymd) => {
      // ymd unused in default — weekday check happens via etParts
      return true;
    };

  // Walk in ~1-day steps using ET midnights approximated via 30-min samples
  // for correctness at DST boundaries without pulling the full calendar.
  let elapsed = 0;
  const STEP = 60 * 1000; // 1 minute
  // Cap iterations (lookback windows are days, not years).
  const maxSteps = Math.min(Math.ceil((b - a) / STEP) + 2, 20 * 24 * 60);
  let t = a;
  for (let i = 0; i < maxSteps && t < b; i++) {
    const next = Math.min(t + STEP, b);
    const mid = t + (next - t) / 2;
    const et = etPartsFromMs(mid);
    const ymd = `${et.y}-${String(et.m).padStart(2, "0")}-${String(et.d).padStart(2, "0")}`;
    const weekday = et.dow >= 1 && et.dow <= 5;
    if (weekday && isRthDay(ymd) && et.mins >= RTH_OPEN_MIN && et.mins < RTH_CLOSE_MIN) {
      elapsed += next - t;
    }
    t = next;
  }
  return elapsed;
}

/**
 * True when the signal is still within the RTH TTL window.
 * `force` bypasses expiry (operator replay).
 */
export function isCatchupSignalFresh(signalTs, nowMs = Date.now(), opts = {}) {
  if (opts.force === true) return { fresh: true, rth_elapsed_ms: 0, ttl_ms: CATCHUP_SIGNAL_TTL_RTH_MS };
  const from = Number(signalTs);
  const to = Number(nowMs);
  if (!Number.isFinite(from) || from <= 0) {
    return { fresh: false, rth_elapsed_ms: null, ttl_ms: CATCHUP_SIGNAL_TTL_RTH_MS, reason: "bad_signal_ts" };
  }
  const ttl = Number.isFinite(Number(opts.ttlRthMs)) && Number(opts.ttlRthMs) > 0
    ? Number(opts.ttlRthMs)
    : CATCHUP_SIGNAL_TTL_RTH_MS;
  const elapsed = rthElapsedMs(from, to, opts);
  if (elapsed > ttl) {
    return { fresh: false, rth_elapsed_ms: elapsed, ttl_ms: ttl, reason: "signal_expired_rth" };
  }
  return { fresh: true, rth_elapsed_ms: elapsed, ttl_ms: ttl };
}

/**
 * Resolve a live headline price from timed:prices row or timed:latest blob.
 * Prefers RTH `p` / `_live_price` / `price`.
 */
export function resolveCatchupLivePrice(priceRow, latestRow) {
  const fromPrices = Number(priceRow?.p) || Number(priceRow?.price) || 0;
  const fromLatest = Number(latestRow?._live_price)
    || Number(latestRow?.price)
    || Number(latestRow?.close)
    || 0;
  if (fromPrices > 0) return fromPrices;
  if (fromLatest > 0) return fromLatest;
  return null;
}

/**
 * Detect near-duplicate DCA lots (dual-worker race fingerprint).
 * Keep the EARLIER lot; the later twin is the delete candidate.
 *
 * @param {Array<{id:string, position_id:string, ticker:string, shares:number, price:number, reason:string, ts:number, value?:number}>} lots
 * @param {number} [maxGapMs=5000]
 * @returns {Array<{keep_id:string, delete_id:string, ticker:string, position_id:string, shares:number, price:number, value:number, reason:string, gap_ms:number, delete_ts:number}>}
 */
export function findDuplicateDcaLotPairs(lots, maxGapMs = 5000) {
  const sorted = [...(lots || [])].sort((a, b) => {
    const pk = String(a.position_id || a.ticker).localeCompare(String(b.position_id || b.ticker));
    if (pk !== 0) return pk;
    const sa = Math.round((Number(a.shares) || 0) * 1e4);
    const sb = Math.round((Number(b.shares) || 0) * 1e4);
    if (sa !== sb) return sa - sb;
    const pa = Math.round((Number(a.price) || 0) * 100);
    const pb = Math.round((Number(b.price) || 0) * 100);
    if (pa !== pb) return pa - pb;
    const ra = String(a.reason || "").localeCompare(String(b.reason || ""));
    if (ra !== 0) return ra;
    return (Number(a.ts) || 0) - (Number(b.ts) || 0);
  });

  const pairs = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (String(prev.position_id) !== String(cur.position_id)) continue;
    if (String(prev.reason || "") !== String(cur.reason || "")) continue;
    const sharesMatch = Math.abs((Number(prev.shares) || 0) - (Number(cur.shares) || 0)) < 1e-4;
    const priceMatch = Math.abs((Number(prev.price) || 0) - (Number(cur.price) || 0)) < 0.015;
    if (!sharesMatch || !priceMatch) continue;
    const gap = (Number(cur.ts) || 0) - (Number(prev.ts) || 0);
    if (gap < 1 || gap > maxGapMs) continue;
    const shares = Number(cur.shares) || 0;
    const price = Number(cur.price) || 0;
    const value = Number(cur.value) > 0 ? Number(cur.value) : Math.round(shares * price * 100) / 100;
    pairs.push({
      keep_id: String(prev.id),
      delete_id: String(cur.id),
      ticker: String(cur.ticker || "").toUpperCase(),
      position_id: String(cur.position_id || ""),
      shares,
      price,
      value,
      reason: String(cur.reason || ""),
      gap_ms: gap,
      delete_ts: Number(cur.ts) || 0,
    });
  }
  return pairs;
}
