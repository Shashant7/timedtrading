// worker/foundation/trading-calendar.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION — Trading Calendar (Phase 1 of
//  tasks/2026-06-14-foundation-rebuild-plan.md).
//
//  This is the source of "what bar SHOULD exist right now". The whole
//  freshness-by-construction thesis depends on it: ingestion is scheduled off
//  this calendar (not off "did a cron happen to run"), and coverage/gaps are
//  COMPUTED by comparing present bars to the expected grid this module emits.
//
//  Pure, deterministic, no I/O. US equity RTH sessions (09:30–16:00 ET; early
//  close 13:00 ET on half-days). Holiday + half-day tables are embedded and
//  require annual maintenance (flagged below) until a derivation/feed replaces
//  them — the rebuild prefers an explicit, auditable table over silent guessing.
//
//  Nothing in the live worker imports this yet (additive scaffolding + tests).
// ─────────────────────────────────────────────────────────────────────────────

// Full-day market closures (NYSE/Nasdaq). MAINTAIN ANNUALLY.
const HOLIDAYS = new Set([
  // 2025
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
]);

// Early-close days (market closes 13:00 ET). MAINTAIN ANNUALLY.
const HALF_DAYS = new Set([
  "2025-07-03", "2025-11-28", "2025-12-24",
  "2026-11-27", "2026-12-24",
]);

const MIN = 60_000;

/** ET wall-clock (Y, M[1-12], D, h, m) → UTC ms. DST-correct via Intl offset. */
export function etWallToUtcMs(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(guess))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offset = asUTC - guess;            // ET offset at that instant
  return guess - offset;
}

/** ET calendar date string ("YYYY-MM-DD") for a UTC ms. */
export function etDateStr(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));
}

function parseDateStr(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return { y, m, d };
}

/** Day of week for a date string, in ET (0=Sun..6=Sat). */
export function dayOfWeek(dateStr) {
  const { y, m, d } = parseDateStr(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isHoliday(dateStr) { return HOLIDAYS.has(dateStr); }
export function isHalfDay(dateStr) { return HALF_DAYS.has(dateStr); }

export function isTradingDay(dateStr) {
  const dow = dayOfWeek(dateStr);
  if (dow === 0 || dow === 6) return false;     // weekend
  if (HOLIDAYS.has(dateStr)) return false;
  return true;
}

/** RTH session bounds in UTC ms for a date, or null if not a trading day. */
export function sessionBoundsUtc(dateStr) {
  if (!isTradingDay(dateStr)) return null;
  const { y, m, d } = parseDateStr(dateStr);
  const openMs = etWallToUtcMs(y, m, d, 9, 30);
  const closeMs = HALF_DAYS.has(dateStr)
    ? etWallToUtcMs(y, m, d, 13, 0)
    : etWallToUtcMs(y, m, d, 16, 0);
  return { openMs, closeMs };
}

/** Step a date string by +n days (calendar). */
export function addDays(dateStr, n) {
  const { y, m, d } = parseDateStr(dateStr);
  return etDateStr(Date.UTC(y, m - 1, d, 12) + n * 24 * 60 * MIN); // noon anchor avoids DST edge
}

/** All trading-day date strings in [startDateStr, endDateStr] inclusive. */
export function tradingDaysInRange(startDateStr, endDateStr) {
  const out = [];
  let cur = startDateStr;
  // guard against accidental infinite loop
  for (let i = 0; i < 4000 && cur <= endDateStr; i++) {
    if (isTradingDay(cur)) out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/**
 * Expected intraday bucket-open timestamps (UTC ms) for ONE session, anchored
 * at the session open and stepping by `tfMin`. e.g. 5m → 09:30,09:35,…,15:55.
 * The last bucket open is < close (a bucket covers [open, open+tf)).
 */
export function expectedIntradayBuckets(dateStr, tfMin) {
  const b = sessionBoundsUtc(dateStr);
  if (!b) return [];
  const step = tfMin * MIN;
  const out = [];
  for (let t = b.openMs; t < b.closeMs; t += step) out.push(t);
  return out;
}

const INTRADAY_TF_MIN = { "5": 5, "10": 10, "15": 15, "30": 30, "60": 60, "1H": 60, "240": 240, "4H": 240 };

/**
 * Unified expected grid for a (tf, window). This is what feeds the SeriesView
 * coverage contract (series-contract.js). Calendar-aware, so overnight /
 * weekend / holiday gaps are NEVER counted as missing bars.
 *
 *  - intraday tf ("5".."240"): concat per-session buckets across trading days,
 *    clipped to [startMs, endMs).
 *  - "D": one bucket per trading day at the session open.
 *  - "W": one bucket per ISO-week Monday's session open (weeks with a trading day).
 *  - "M": one bucket per month's first trading-day session open.
 *
 * @returns {number[]} ascending bucket-open timestamps
 */
export function expectedBuckets({ tf, startMs, endMs }) {
  const startDate = etDateStr(startMs);
  const endDate = etDateStr(endMs);
  const days = tradingDaysInRange(startDate, endDate);
  const tfu = String(tf);

  if (INTRADAY_TF_MIN[tfu]) {
    const tfMin = INTRADAY_TF_MIN[tfu];
    const out = [];
    for (const day of days) {
      for (const ts of expectedIntradayBuckets(day, tfMin)) {
        if (ts >= startMs && ts < endMs) out.push(ts);
      }
    }
    return out;
  }

  if (tfu === "D") {
    return days.map((day) => sessionBoundsUtc(day).openMs).filter((ts) => ts >= startMs && ts <= endMs);
  }

  if (tfu === "W") {
    // first trading day of each ISO week (Mon-anchored)
    const seen = new Set();
    const out = [];
    for (const day of days) {
      const dow = dayOfWeek(day);              // 1=Mon..5=Fri
      const monday = addDays(day, -(dow - 1));
      if (!seen.has(monday)) { seen.add(monday); out.push(sessionBoundsUtc(day).openMs); }
    }
    return out.filter((ts) => ts >= startMs && ts <= endMs);
  }

  if (tfu === "M") {
    const seen = new Set();
    const out = [];
    for (const day of days) {
      const ym = day.slice(0, 7);
      if (!seen.has(ym)) { seen.add(ym); out.push(sessionBoundsUtc(day).openMs); }
    }
    return out.filter((ts) => ts >= startMs && ts <= endMs);
  }

  return [];
}
