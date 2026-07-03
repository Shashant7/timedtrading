// ═══════════════════════════════════════════════════════════════════════════════
// Market Calendar — Single source of truth for trading hours, holidays, sessions
//
// Stocks (equities):  Dynamic via Alpaca /v2/calendar API, cached in KV daily.
// Futures:            Static calendar (CME has no free API); updated once/year.
// Crypto:             24/7, no calendar needed.
//
// Usage:
//   const cal = await loadCalendar(env);     // KV → static fallback
//   isEquityHoliday(cal, "2026-02-16")       // true (Presidents' Day)
//   isWithinOperatingHours(cal)              // true if 4AM-8PM ET weekday
//   isTickerSessionActive(cal, "AAPL")       // true if equity session open
// ═══════════════════════════════════════════════════════════════════════════════

// ── Session Time Constants (ET minutes from midnight) ────────────────────────
export const PM_START    = 240;   // 4:00 AM ET — pre-market opens
export const RTH_OPEN    = 570;   // 9:30 AM ET — regular trading hours open
export const RTH_CLOSE   = 960;   // 4:00 PM ET — regular trading hours close
export const AH_END      = 1200;  // 8:00 PM ET — after-hours ends
export const FUT_OPEN    = 1080;  // 6:00 PM ET — futures open (Sunday evening)
export const FUT_CLOSE   = 1020;  // 5:00 PM ET — futures close (next day)
export const FUT_EARLY   = 780;   // 1:00 PM ET — futures early close
export const CRYPTO_DUR  = 1440;  // 24h — crypto is always open

// ── KV Key ───────────────────────────────────────────────────────────────────
const KV_KEY = "timed:market-calendar";

// ── Futures Static Calendar ──────────────────────────────────────────────────
// CME doesn't offer a free API. These dates follow a predictable pattern
// (day after major holidays). Updated once per year.
const FUTURES_EARLY_CLOSE = new Set([
  // 2025
  "2025-01-20", "2025-02-17", "2025-07-03", "2025-11-28", "2025-12-24",
  // 2026
  "2026-01-20", "2026-02-17", "2026-07-03", "2026-11-27", "2026-12-24",
  // 2027
  "2027-01-19", "2027-02-16", "2027-07-02", "2027-11-26", "2027-12-23",
  // 2028
  "2028-01-18", "2028-02-22", "2028-07-03", "2028-11-24", "2028-12-22",
]);

const FUTURES_FULL_CLOSE = new Set([
  // 2025
  "2025-01-01", "2025-04-18", "2025-12-25",
  // 2026
  "2026-01-01", "2026-04-03", "2026-12-25",
  // 2027
  "2027-01-01", "2027-03-26", "2027-12-25",
  // 2028
  "2028-01-01", "2028-04-14", "2028-12-25",
]);

// ── Equity Holiday Fallback (used when KV cache is missing/stale) ────────────
// This static list is ONLY used as a safety net. Under normal operation,
// holidays are derived dynamically from the Alpaca Calendar API.
const EQUITY_HOLIDAYS_FALLBACK = new Set([
  // 2025
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  // 2028
  "2028-01-01", "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29",
  "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
]);

/** Human-readable US equity holiday names (mirrors EQUITY_HOLIDAYS_FALLBACK dates). */
const EQUITY_HOLIDAY_NAMES = {
  "2025-01-01": "New Year's Day",
  "2025-01-20": "Martin Luther King Jr. Day",
  "2025-02-17": "Presidents' Day",
  "2025-04-18": "Good Friday",
  "2025-05-26": "Memorial Day",
  "2025-06-19": "Juneteenth",
  "2025-07-04": "Independence Day",
  "2025-09-01": "Labor Day",
  "2025-11-27": "Thanksgiving",
  "2025-12-25": "Christmas",
  "2026-01-01": "New Year's Day",
  "2026-01-19": "Martin Luther King Jr. Day",
  "2026-02-16": "Presidents' Day",
  "2026-04-03": "Good Friday",
  "2026-05-25": "Memorial Day",
  "2026-06-19": "Juneteenth",
  "2026-07-03": "Independence Day",
  "2026-09-07": "Labor Day",
  "2026-11-26": "Thanksgiving",
  "2026-12-25": "Christmas",
  "2027-01-01": "New Year's Day",
  "2027-01-18": "Martin Luther King Jr. Day",
  "2027-02-15": "Presidents' Day",
  "2027-03-26": "Good Friday",
  "2027-05-31": "Memorial Day",
  "2027-06-18": "Juneteenth",
  "2027-07-05": "Independence Day",
  "2027-09-06": "Labor Day",
  "2027-11-25": "Thanksgiving",
  "2027-12-24": "Christmas",
  "2028-01-01": "New Year's Day",
  "2028-01-17": "Martin Luther King Jr. Day",
  "2028-02-21": "Presidents' Day",
  "2028-04-14": "Good Friday",
  "2028-05-29": "Memorial Day",
  "2028-06-19": "Juneteenth",
  "2028-07-04": "Independence Day",
  "2028-09-04": "Labor Day",
  "2028-11-23": "Thanksgiving",
  "2028-12-25": "Christmas",
};

// ── Equity Early Close Fallback ──────────────────────────────────────────────
// Days when EQUITY markets close at 1:00 PM ET instead of 4:00 PM.
//
// 2026-07-03 RCA: this table previously listed 2026-07-02, 2027-07-02,
// 2027-12-23, 2028-12-22 as equity early closes. Those are SIFMA *bond
// market* recommendations / non-events — NYSE & Nasdaq trade FULL sessions
// on those dates (2021/2023 precedent: when Jul 4 or Dec 25 observance
// falls Fri/Mon, the adjacent Thu/Fri is a full day). The bogus 2026-07-02
// entry shut the live-candle sync at 1 PM while freshness SLOs stayed on
// RTH thresholds → the universe-wide stale-candle pages at 2 PM. Equity
// early closes are ONLY: day before/after July 4 when Jul 4 is a weekday,
// day after Thanksgiving, and Christmas Eve when it's a trading day.
const EQUITY_EARLY_CLOSE_FALLBACK = new Set([
  // 2025
  "2025-07-03", "2025-11-28", "2025-12-24",
  // 2026 (Jul 4 = Sat → Fri Jul 3 is a FULL holiday, no early close)
  "2026-11-27", "2026-12-24",
  // 2027 (Jul 4 = Sun → Mon Jul 5 holiday; Dec 25 = Sat → Fri Dec 24 holiday)
  "2027-11-26",
  // 2028 (Jul 4 = Tue → Mon Jul 3 early close; Dec 24 = Sun, no early close)
  "2028-07-03", "2028-11-24",
]);

// ── Crypto Symbols ───────────────────────────────────────────────────────────
const CRYPTO_SYMS = new Set([
  "BTCUSD", "ETHUSD", "BTCUSDT", "ETHUSDT", "BTC", "ETH",
]);

// ── Futures Symbols ──────────────────────────────────────────────────────────
const FUTURES_SUFFIXES = ["1!"];
const FUTURES_BASE = new Set([
  "ES", "NQ", "YM", "RTY", "CL", "GC", "SI", "HG", "NG",
  "ES1!", "NQ1!", "YM1!", "RTY1!", "CL1!", "GC1!", "SI1!", "HG1!", "NG1!",
  "MES1!", "MNQ1!", "MYM1!", "M2K1!",
]);

// ═══════════════════════════════════════════════════════════════════════════════
// Calendar Object Structure
// ═══════════════════════════════════════════════════════════════════════════════
//
// {
//   equity: { "2026-02-17": { open: "09:30", close: "16:00" }, ... },
//   equityHolidays: Set(["2026-02-16", ...]),
//   equityEarlyClose: Set(["2026-11-27", ...]),
//   futuresEarlyClose: Set([...]),
//   futuresFullClose: Set([...]),
//   fetchedAt: 1771329000000,
//   source: "alpaca" | "static",
// }

// ═══════════════════════════════════════════════════════════════════════════════
// Fetch & Cache (called by daily cron)
// ═══════════════════════════════════════════════════════════════════════════════

export async function fetchAndCacheCalendar(env) {
  const apiKey = env?.ALPACA_API_KEY_ID;
  const apiSecret = env?.ALPACA_API_SECRET_KEY;
  const baseUrl = env?.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";

  if (!apiKey || !apiSecret) {
    console.warn("[MARKET-CAL] Missing Alpaca credentials, using static fallback");
    return _buildStaticCalendar("missing_credentials");
  }

  const today = new Date();
  const start = _formatDate(today);
  const endDate = new Date(today.getTime() + 90 * 86400000);
  const end = _formatDate(endDate);

  try {
    // 2026-07-03 (stabilization plan A2) — prod ran on the static fallback
    // for weeks because the nightly fetch failed silently. The /v2/calendar
    // endpoint exists on BOTH hosts but a live-only key 401s on paper-api
    // (and vice versa), so try the configured base URL first, then the
    // alternate host before giving up.
    const altUrl = baseUrl.includes("paper-api")
      ? "https://api.alpaca.markets"
      : "https://paper-api.alpaca.markets";
    const headers = {
      "APCA-API-KEY-ID": apiKey,
      "APCA-API-SECRET-KEY": apiSecret,
      "Accept": "application/json",
    };
    let resp = await fetch(`${baseUrl}/v2/calendar?start=${start}&end=${end}`, { headers });
    let usedHost = baseUrl;
    if (!resp.ok && (resp.status === 401 || resp.status === 403)) {
      console.warn(`[MARKET-CAL] Alpaca calendar HTTP ${resp.status} on ${baseUrl}; retrying ${altUrl}`);
      resp = await fetch(`${altUrl}/v2/calendar?start=${start}&end=${end}`, { headers });
      usedHost = altUrl;
    }

    if (!resp.ok) {
      const bodySnippet = (await resp.text().catch(() => "")).slice(0, 120);
      console.error(`[MARKET-CAL] Alpaca calendar HTTP ${resp.status} (${usedHost}): ${bodySnippet}`);
      return _buildStaticCalendar(`http_${resp.status}:${bodySnippet}`);
    }

    const tradingDays = await resp.json();
    if (!Array.isArray(tradingDays) || tradingDays.length === 0) {
      console.warn("[MARKET-CAL] Alpaca returned empty calendar");
      return _buildStaticCalendar("empty_calendar");
    }

    // Build the equity trading day map
    const equity = {};
    const earlyCloseDates = new Set();
    for (const day of tradingDays) {
      const d = day.date;
      const open = day.open;  // "09:30"
      const close = day.close; // "16:00" or "13:00" for early close
      equity[d] = { open, close };
      if (close !== "16:00") {
        earlyCloseDates.add(d);
      }
    }

    // Derive holidays: generate all weekdays in range, subtract trading days
    const tradingDaySet = new Set(tradingDays.map(d => d.date));
    const holidays = new Set();
    const cursor = new Date(today);
    cursor.setHours(0, 0, 0, 0);
    while (cursor <= endDate) {
      const dow = cursor.getDay(); // 0=Sun, 6=Sat
      if (dow !== 0 && dow !== 6) {
        const ds = _formatDate(cursor);
        if (!tradingDaySet.has(ds)) {
          holidays.add(ds);
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    const cal = {
      equity,
      equityHolidays: holidays,
      equityEarlyClose: earlyCloseDates,
      futuresEarlyClose: FUTURES_EARLY_CLOSE,
      futuresFullClose: FUTURES_FULL_CLOSE,
      fetchedAt: Date.now(),
      source: "alpaca",
      range: { start, end },
    };

    // Cache to KV
    const KV = env?.KV_TIMED;
    if (KV) {
      const serializable = {
        ...cal,
        equityHolidays: [...holidays],
        equityEarlyClose: [...earlyCloseDates],
        futuresEarlyClose: [...FUTURES_EARLY_CLOSE],
        futuresFullClose: [...FUTURES_FULL_CLOSE],
      };
      await KV.put(KV_KEY, JSON.stringify(serializable), { expirationTtl: 7 * 86400 });
      console.log(`[MARKET-CAL] Cached ${tradingDays.length} trading days, ${holidays.size} holidays, ${earlyCloseDates.size} early closes`);
    }

    return cal;
  } catch (e) {
    console.error("[MARKET-CAL] Fetch failed:", String(e).slice(0, 200));
    return _buildStaticCalendar(`fetch_error:${String(e?.message || e).slice(0, 120)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Load Calendar (called at start of each cron/request)
// ═══════════════════════════════════════════════════════════════════════════════

export async function loadCalendar(env) {
  const KV = env?.KV_TIMED;
  if (!KV) return _buildStaticCalendar();

  try {
    const raw = await KV.get(KV_KEY, "json");
    if (raw && raw.fetchedAt && (Date.now() - raw.fetchedAt) < 48 * 3600000) {
      // Rehydrate Sets from arrays
      return {
        equity: raw.equity || {},
        equityHolidays: new Set(raw.equityHolidays || []),
        equityEarlyClose: new Set(raw.equityEarlyClose || []),
        futuresEarlyClose: new Set(raw.futuresEarlyClose || []),
        futuresFullClose: new Set(raw.futuresFullClose || []),
        fetchedAt: raw.fetchedAt,
        source: raw.source || "kv_cache",
        range: raw.range,
      };
    }
  } catch (_) {}

  return _buildStaticCalendar();
}

function _buildStaticCalendar(fallbackReason = null) {
  return {
    equity: {},
    equityHolidays: EQUITY_HOLIDAYS_FALLBACK,
    equityEarlyClose: EQUITY_EARLY_CLOSE_FALLBACK,
    futuresEarlyClose: FUTURES_EARLY_CLOSE,
    futuresFullClose: FUTURES_FULL_CLOSE,
    fetchedAt: 0,
    source: "static",
    // Why the dynamic fetch fell back (A2 observability) — null when the
    // static calendar was requested directly (no creds is one such reason).
    fallback_reason: fallbackReason,
  };
}

// ── Cached market-open resolver (A4, 2026-07-03 stabilization plan) ─────────
// The Jul 2 incident: the feed gated live-candle sync on THIS calendar while
// the freshness grader derived market-open from the foundation calendar —
// a disagreement meant "feed off, SLO strict" and the universe went STALE.
// Freshness stamping (computeServerSideScores) now resolves market-open here
// too, via this per-isolate 5-minute cache (one KV read per 5 min, not per
// ticker). Explicit `opts.marketOpen` from callers still wins.
let _marketOpenCalCache = { cal: null, at: 0 };

export async function resolveMarketOpenCached(env, nowMs = Date.now()) {
  try {
    if (!_marketOpenCalCache.cal || nowMs - _marketOpenCalCache.at > 5 * 60 * 1000) {
      _marketOpenCalCache = { cal: await loadCalendar(env), at: nowMs };
    }
    return isNyRegularMarketOpen(_marketOpenCalCache.cal, new Date(nowMs));
  } catch (_) {
    return undefined; // caller falls back to its own session source
  }
}

export function _resetMarketOpenCacheForTests() {
  _marketOpenCalCache = { cal: null, at: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Query Functions (pure — operate on a calendar object)
// ═══════════════════════════════════════════════════════════════════════════════

/** Is this date a US equity market holiday? */
export function isEquityHoliday(cal, dateStr) {
  return cal.equityHolidays.has(dateStr);
}

/** Display name for a US equity market holiday, or null if not a holiday / unknown date. */
export function getEquityHolidayName(cal, dateStr) {
  if (!dateStr) return null;
  if (!isEquityHoliday(cal, dateStr)) return null;
  return EQUITY_HOLIDAY_NAMES[dateStr] || null;
}

/** Is this date an equity early close day (1 PM ET)? */
export function isEquityEarlyClose(cal, dateStr) {
  return cal.equityEarlyClose.has(dateStr);
}

/** Get equity hours for a trading day. Returns null for holidays. */
export function getEquityHours(cal, dateStr) {
  if (cal.equity[dateStr]) return cal.equity[dateStr];
  if (cal.equityHolidays.has(dateStr)) return null;
  return { open: "09:30", close: "16:00" }; // default
}

/** Is this date a futures full-close day? */
export function isFuturesFullClose(cal, dateStr) {
  return cal.futuresFullClose.has(dateStr);
}

/** Is this date a futures early-close day? */
export function isFuturesEarlyClose(cal, dateStr) {
  return cal.futuresEarlyClose.has(dateStr);
}

/** Find the previous equity trading day (skips weekends and holidays). */
export function previousTradingDay(cal, dateStr) {
  const [yr, mo, dy] = dateStr.split("-").map(Number);
  let d = new Date(yr, mo - 1, dy);
  for (let i = 0; i < 10; i++) {
    d.setDate(d.getDate() - 1);
    const ds = _formatDate(d);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !isEquityHoliday(cal, ds)) return ds;
  }
  return dateStr; // fallback
}

// ═══════════════════════════════════════════════════════════════════════════════
// Session Functions
// ═══════════════════════════════════════════════════════════════════════════════

/** Get Eastern Time parts from a Date object. */
export function getEasternParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const obj = {};
  for (const p of parts) obj[p.type] = p.value;
  return {
    weekday: obj.weekday || "",
    hour: Number(obj.hour || 0),
    minute: Number(obj.minute || 0),
  };
}

/** Get ET date string (YYYY-MM-DD) for a Date object. */
export function getETDateStr(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Get ET minutes from midnight for a Date object. */
export function getETMinutes(date = new Date()) {
  const { hour, minute } = getEasternParts(date);
  return hour * 60 + minute;
}

/**
 * Operating hours gate: 4 AM - 8 PM ET weekdays, excluding market holidays.
 * All crons should skip processing outside this window.
 */
export function isWithinOperatingHours(cal, now = new Date()) {
  const { weekday, hour, minute } = getEasternParts(now);
  if (["Sat", "Sun"].includes(weekday)) return false;
  const dateStr = getETDateStr(now);
  if (isEquityHoliday(cal, dateStr)) return false;
  const mins = hour * 60 + minute;
  return mins >= PM_START && mins < AH_END; // 4:00 AM - 7:59 PM ET
}

/** Is NY regular market currently open? (9:30 AM - 4:00 PM ET, weekdays, non-holiday) */
export function isNyRegularMarketOpen(cal, now = new Date()) {
  const { weekday } = getEasternParts(now);
  if (["Sat", "Sun"].includes(weekday)) return false;
  const dateStr = getETDateStr(now);
  if (isEquityHoliday(cal, dateStr)) return false;
  const mins = getETMinutes(now);
  // Check for early close
  if (isEquityEarlyClose(cal, dateStr)) {
    return mins >= RTH_OPEN && mins < FUT_EARLY; // 9:30 AM - 1:00 PM
  }
  return mins >= RTH_OPEN && mins < RTH_CLOSE; // 9:30 AM - 4:00 PM
}

/**
 * Per-ticker session check: is this ticker's market currently active?
 * Used by session-aware append to skip stale data outside sessions.
 */
export function isTickerSessionActive(cal, sym, now = new Date()) {
  // Crypto: always active (24/7)
  if (isCrypto(sym)) return true;

  const etMins = getETMinutes(now);
  const dateStr = getETDateStr(now);
  const { weekday } = getEasternParts(now);
  const isSat = weekday === "Sat";
  const isSun = weekday === "Sun";
  const isFri = weekday === "Fri";

  // Futures: 6 PM ET Sunday – 5 PM ET Friday
  if (isFutures(sym)) {
    if (isFuturesFullClose(cal, dateStr)) return false;
    if (isSat) return false;
    if (isSun) return etMins >= FUT_OPEN; // after 6 PM Sunday
    if (isFri) return etMins < FUT_CLOSE; // before 5 PM Friday
    if (isFuturesEarlyClose(cal, dateStr)) return etMins < FUT_EARLY; // before 1 PM
    return true; // Mon-Thu: futures open all day
  }

  // Stocks: 4 AM – 8 PM ET on weekdays (PM + RTH + AH)
  if (isEquityHoliday(cal, dateStr)) return false;
  if (isSat || isSun) return false;
  return etMins >= PM_START && etMins < AH_END;
}

/** Classify timestamp into session type: PM, RTH, AH, CLOSED */
export function getSessionType(etMins) {
  if (etMins >= PM_START && etMins < RTH_OPEN) return "PM";
  if (etMins >= RTH_OPEN && etMins < RTH_CLOSE) return "RTH";
  if (etMins >= RTH_CLOSE && etMins < AH_END) return "AH";
  return "CLOSED";
}

// ═══════════════════════════════════════════════════════════════════════════════
// Ticker Classification Helpers
// ═══════════════════════════════════════════════════════════════════════════════

export function isCrypto(sym) {
  return CRYPTO_SYMS.has(sym) || sym.endsWith("USD") || sym.endsWith("USDT");
}

export function isFutures(sym) {
  return FUTURES_BASE.has(sym) || sym.endsWith("1!");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function _formatDate(d) {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  return `${yr}-${mo}-${dy}`;
}
