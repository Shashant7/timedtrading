// Daily Brief module — AI-generated morning & evening market analysis
// Publishes to KV (current brief) and D1 (archive), with Finnhub data enrichment.

import { kvGetJSON, kvPutJSON } from "./storage.js";
import { loadCalendar, isEquityHoliday, isEquityEarlyClose } from "./market-calendar.js";

// ═══════════════════════════════════════════════════════════════════════
// D1 Schema
// ═══════════════════════════════════════════════════════════════════════

let _briefSchemaReady = false;

export async function d1EnsureBriefSchema(env) {
  if (_briefSchemaReady) return;
  const db = env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS daily_briefs (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        es_prediction TEXT,
        es_prediction_correct INTEGER,
        es_close REAL,
        published_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_daily_briefs_date ON daily_briefs (date DESC)
    `).run();
    _briefSchemaReady = true;
  } catch (e) {
    console.error("[DAILY BRIEF] Schema init failed:", String(e).slice(0, 200));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Finnhub Integration
// ═══════════════════════════════════════════════════════════════════════

const FINNHUB_BASE = "https://finnhub.io/api/v1";

/**
 * Fetch earnings calendar from Finnhub.
 * Returns array of { symbol, date, hour, epsEstimate, epsActual, revenueEstimate, revenueActual }
 */
export async function fetchFinnhubEarnings(env, fromDate, toDate) {
  const token = env?.FINNHUB_API_KEY;
  if (!token) {
    console.warn("[FINNHUB] No API key configured (FINNHUB_API_KEY)");
    return [];
  }
  try {
    const url = `${FINNHUB_BASE}/calendar/earnings?from=${fromDate}&to=${toDate}&token=${token}`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) {
      console.warn(`[FINNHUB] Earnings fetch failed: ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    const events = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
    console.log(`[FINNHUB] Earnings calendar: ${events.length} events (${fromDate} to ${toDate})`);
    return events;
  } catch (e) {
    console.error("[FINNHUB] Earnings error:", String(e).slice(0, 150));
    return [];
  }
}

/**
 * Fetch economic calendar from Finnhub.
 * Returns array of { country, event, time, impact, actual, estimate, prev, unit }
 */
export async function fetchFinnhubEconomicCalendar(env, fromDate, toDate) {
  const token = env?.FINNHUB_API_KEY;
  if (!token) {
    return { events: [], _debug: { error: "no_token", keys: [], sample: "" } };
  }
  try {
    const url = `${FINNHUB_BASE}/calendar/economic?from=${fromDate}&to=${toDate}&token=${token}`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      console.warn(`[FINNHUB] Economic calendar fetch failed: ${resp.status} ${errBody.slice(0, 200)}`);
      return { events: [], _debug: { error: `http_${resp.status}`, keys: [], sample: errBody.slice(0, 500) } };
    }
    const data = await resp.json();
    // Finnhub may return data under "economicCalendar" or "result" key
    let events = [];
    if (Array.isArray(data?.economicCalendar)) {
      events = data.economicCalendar;
    } else if (data?.economicCalendar?.result && Array.isArray(data.economicCalendar.result)) {
      events = data.economicCalendar.result;
    } else if (Array.isArray(data?.result)) {
      events = data.result;
    }
    const rawInfo = { keys: Object.keys(data || {}), sample: JSON.stringify(data).slice(0, 500), eventCount: events.length };
    console.log(`[FINNHUB] Economic calendar: ${events.length} events (${fromDate} to ${toDate}), raw keys: ${rawInfo.keys.join(",")}`);
    if (events.length === 0) console.log(`[FINNHUB] Econ raw response:`, rawInfo.sample);
    if (events.length > 0) console.log(`[FINNHUB] First econ event:`, JSON.stringify(events[0]).slice(0, 200));
    return { events, _debug: rawInfo };
  } catch (e) {
    console.error("[FINNHUB] Economic calendar error:", String(e).slice(0, 150));
    return { events: [], _debug: { error: String(e).slice(0, 200), keys: [], sample: "" } };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ForexFactory Economic Calendar Scraper
// ═══════════════════════════════════════════════════════════════════════

const FF_IMPACT_MAP = { "High": "high", "Medium": "medium", "Low": "low" };

/**
 * Scrape ForexFactory economic calendar for today's US events.
 * Uses KV cache (1-hour TTL) to avoid repeated scraping.
 * Falls back gracefully if ForexFactory is unreachable or changes layout.
 */
export async function fetchForexFactoryCalendar(env, dateStr) {
  const KV = env?.KV_TIMED;
  const cacheKey = `timed:econ-cal:${dateStr}`;

  // Check KV cache first
  if (KV) {
    try {
      const cached = await KV.get(cacheKey, "json");
      if (cached && Array.isArray(cached.events)) {
        console.log(`[FF] Cache hit for ${dateStr}: ${cached.events.length} events`);
        return cached.events;
      }
    } catch (_) { /* cache miss */ }
  }

  try {
    // ForexFactory calendar URL for a specific day
    const url = `https://www.forexfactory.com/calendar?day=${dateStr}`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      console.warn(`[FF] Fetch failed: ${resp.status}`);
      return [];
    }
    const html = await resp.text();
    const events = parseForexFactoryHTML(html, dateStr);
    console.log(`[FF] Parsed ${events.length} events for ${dateStr}`);

    // Validate: only cache if events have reasonable economic values
    // (not timestamps or huge numbers from bad parsing)
    const validEvents = events.filter(e => {
      if (!e.actual && !e.estimate && !e.prev) return true; // no data yet is fine
      const vals = [e.actual, e.estimate, e.prev].filter(v => v != null);
      // Economic values should be small numbers (< 1000), not timestamps
      return vals.every(v => {
        const n = parseFloat(String(v).replace(/[%KMB,]/g, ""));
        return isNaN(n) || Math.abs(n) < 1000;
      });
    });

    // Cache in KV for 1 hour
    if (KV && validEvents.length > 0) {
      try {
        await KV.put(cacheKey, JSON.stringify({ events: validEvents, ts: Date.now() }), { expirationTtl: 3600 });
      } catch (_) { /* KV write failure is non-fatal */ }
    }

    return validEvents;
  } catch (e) {
    console.warn(`[FF] Scrape error: ${String(e).slice(0, 150)}`);
    return [];
  }
}

/**
 * Parse ForexFactory HTML calendar page for economic events.
 * Extracts: time, currency, impact, event, actual, forecast, previous
 */
function parseForexFactoryHTML(html, dateStr) {
  if (!html || typeof html !== "string") return [];
  const events = [];

  // ForexFactory uses <tr class="calendar__row"> for each event
  // Each row has cells: date, time, currency, impact, event, actual, forecast, previous
  const rowRegex = /<tr[^>]*class="[^"]*calendar__row[^"]*calendar_row[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  // Also try a simpler pattern if the above doesn't match
  const simpleRowRegex = /<tr[^>]*class="[^"]*calendar[_-]row[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;

  let rowMatch;
  const rowPattern = rowRegex.exec(html) ? rowRegex : simpleRowRegex;
  rowPattern.lastIndex = 0;

  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const rowHTML = rowMatch[1];

    // Extract all cell contents
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHTML)) !== null) {
      const text = cellMatch[1]
        .replace(/<[^>]+>/g, " ")  // strip HTML tags
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      cells.push(text);
    }
    cellRegex.lastIndex = 0;

    if (cells.length < 6) continue;

    // Detect impact from class names or span content
    let impact = "low";
    if (/high|red/i.test(rowHTML)) impact = "high";
    else if (/medium|orange|yellow/i.test(rowHTML)) impact = "medium";

    // Detect currency
    const currency = cells.find(c => /^(USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF|CNY)$/i.test(c)) || "";

    // Only keep USD events
    if (currency.toUpperCase() !== "USD") continue;

    // Try to extract structured data
    // Cells typically: [time, currency, impact_icon, event_name, actual, forecast, previous]
    // But exact order varies; use heuristics
    const eventName = cells.find(c => c.length > 10 && !/^\d/.test(c) && !/^(USD|EUR)$/i.test(c)) || "";
    if (!eventName) continue;

    // Find numeric values (actual, forecast, previous)
    const numericCells = cells.filter(c => /^-?[\d.]+[%KMB]?$/.test(c.replace(/,/g, "")));
    const actual = numericCells[0] || null;
    const forecast = numericCells[1] || null;
    const previous = numericCells[2] || null;

    // Find time
    const timeCell = cells.find(c => /^\d{1,2}:\d{2}(am|pm)?$/i.test(c)) || "";

    events.push({
      date: dateStr,
      time: timeCell,
      country: "US",
      event: eventName,
      impact,
      actual,
      estimate: forecast,
      prev: previous,
      unit: "",
    });
  }

  // Keyword fallback REMOVED — it was the root cause of false positives.
  // The old approach searched the ENTIRE page text for "CPI m/m" etc.,
  // matching sidebar/navigation/ads content from other dates. This caused
  // the Daily Brief to report CPI releases on days without CPI data.
  // Now ForexFactory only returns events found via structured HTML row parsing.
  // Finnhub API is the primary source of truth for which events happened on which date.
  if (events.length === 0) {
    console.log(`[FF] No structured rows parsed for ${dateStr} — returning empty (keyword fallback disabled)`);
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════
// Alpaca News Integration (for economic data releases)
// ═══════════════════════════════════════════════════════════════════════

const ECON_KEYWORDS = [
  "CPI", "consumer price index", "inflation",
  "PPI", "producer price index",
  "FOMC", "federal reserve", "interest rate", "rate decision", "rate cut", "rate hike",
  "NFP", "nonfarm payroll", "non-farm payroll", "jobs report", "employment",
  "GDP", "gross domestic product",
  "retail sales", "consumer spending",
  "PCE", "personal consumption",
  "ISM", "manufacturing index",
  "jobless claims", "unemployment",
  "housing starts", "building permits",
  "trade balance", "import prices", "export prices",
];

/**
 * Fetch recent economic/market-moving news from Alpaca News API.
 * Filters for economic data releases and macro events.
 * @returns {Array<{headline, summary, source, created_at, url}>}
 */
export async function fetchAlpacaEconNews(env, fromDate, toDate) {
  const keyId = env?.ALPACA_API_KEY_ID;
  const secret = env?.ALPACA_API_SECRET_KEY;
  if (!keyId || !secret) {
    console.warn("[ALPACA NEWS] No API keys configured");
    return [];
  }
  try {
    // Alpaca News API v1beta1
    const params = new URLSearchParams({
      start: `${fromDate}T00:00:00Z`,
      end: `${toDate}T23:59:59Z`,
      sort: "desc",
      limit: "50",
      include_content: "false",
    });
    const url = `https://data.alpaca.markets/v1beta1/news?${params.toString()}`;
    const resp = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secret,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      console.warn(`[ALPACA NEWS] Fetch failed: ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    const news = Array.isArray(data?.news) ? data.news : [];
    console.log(`[ALPACA NEWS] Fetched ${news.length} articles (${fromDate} to ${toDate})`);

    // Filter to economic/macro news using keyword matching
    const econNews = news.filter(article => {
      const text = `${article.headline || ""} ${article.summary || ""}`.toLowerCase();
      return ECON_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
    });

    console.log(`[ALPACA NEWS] ${econNews.length} economic/macro articles found`);
    return econNews.map(a => ({
      headline: a.headline || "",
      summary: (a.summary || "").slice(0, 300),
      source: a.source || "",
      created_at: a.created_at || "",
      url: a.url || "",
    }));
  } catch (e) {
    console.error("[ALPACA NEWS] Error:", String(e).slice(0, 150));
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Date Helpers
// ═══════════════════════════════════════════════════════════════════════

/** Get current ET date string (YYYY-MM-DD) and components */
function getETDate(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const etStr = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
  return etStr;
}

/** Get ET day of week (0=Sun, 6=Sat) */
function getETDayOfWeek(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(d);
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  for (const p of parts) {
    if (p.type === "weekday") return dayMap[p.value] ?? 0;
  }
  return 0;
}

/** Get ET weekday label (e.g. "Friday") */
function getETWeekdayLabel(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(d);
}

/** Format date as YYYY-MM-DD */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Get Monday and Friday of the current week for a given date */
function getWeekRange(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const dow = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  const friday = new Date(monday);
  friday.setUTCDate(monday.getUTCDate() + 4);
  return { from: fmtDate(monday), to: fmtDate(friday) };
}

// ═══════════════════════════════════════════════════════════════════════
// Market Data Aggregation
// ═══════════════════════════════════════════════════════════════════════

const MARKET_PULSE_SYMS = ["ES1!", "NQ1!", "SPY", "QQQ", "IWM", "VX1!"];
const SECTOR_ETFS = ["XLK", "XLF", "XLY", "XLP", "XLC", "XLI", "XLB", "XLE", "XLRE", "XLU", "XLV"];

/**
 * Gather all market data needed for a daily brief.
 * @param {object} env - Worker environment
 * @param {"morning"|"evening"} type
 * @param {object} opts - { SECTOR_MAP, d1GetCandles }
 */
export async function gatherDailyBriefData(env, type, opts = {}) {
  const KV = env?.KV_TIMED;
  const db = env?.DB;
  if (!KV) return { error: "no_kv" };

  const today = getETDate();
  const { from: weekStart, to: weekEnd } = getWeekRange(today);
  const yesterday = new Date(new Date(today + "T12:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);

  // Calendar context for Friday / holiday awareness
  const cal = env ? await loadCalendar(env).catch(() => null) : null;
  const dayOfWeek = getETDayOfWeek();
  const isFriday = dayOfWeek === 5;
  const isHoliday = cal ? isEquityHoliday(cal, today) : false;
  const isEarlyClose = cal ? isEquityEarlyClose(cal, today) : false;
  const dayOfWeekLabel = getETWeekdayLabel();

  // Parallel data fetching
  const [
    esData, nqData, vixData, spyData, qqqData, iwmData,
    sectorDataArr,
    tradesRaw,
    earningsWeek,
    econWeekRaw,
    morningBrief,
    esCandles,
    esCandlesH1,
    esCandlesM5,
    nqCandles,
    nqCandlesH1,
    nqCandlesM5,
    alpacaEconNews,
    ffToday,
    ffYesterday,
  ] = await Promise.all([
    // Market pulse tickers
    kvGetJSON(KV, "timed:latest:ES1!").catch(() => null),
    kvGetJSON(KV, "timed:latest:NQ1!").catch(() => null),
    kvGetJSON(KV, "timed:latest:VIX").catch(() => null),
    kvGetJSON(KV, "timed:latest:SPY").catch(() => null),
    kvGetJSON(KV, "timed:latest:QQQ").catch(() => null),
    kvGetJSON(KV, "timed:latest:IWM").catch(() => null),
    // Sector ETFs
    Promise.all(SECTOR_ETFS.map(async (sym) => {
      const d = await kvGetJSON(KV, `timed:latest:${sym}`).catch(() => null);
      return { sym, data: d };
    })),
    // Open trades (Active Trader)
    kvGetJSON(KV, "timed:trades:all").catch(() => []),
    // Finnhub earnings (this week)
    fetchFinnhubEarnings(env, weekStart, weekEnd),
    // Finnhub economic calendar (this week)
    fetchFinnhubEconomicCalendar(env, weekStart, weekEnd),
    // Previous morning brief (for evening reflection)
    type === "evening" && db
      ? db.prepare("SELECT es_prediction, content FROM daily_briefs WHERE id = ?1")
          .bind(`${today}-morning`).first().catch(() => null)
      : Promise.resolve(null),
    // ES daily candles (last 20 days)
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "ES1!", "D", 20).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    // ES hourly candles (last 50)
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "ES1!", "60", 50).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    // ES 5-min candles (last 100 for overnight/premarket range)
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "ES1!", "5", 100).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    // NQ daily candles (last 20 days)
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "NQ1!", "D", 20).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    // NQ hourly candles (last 50)
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "NQ1!", "60", 50).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    // NQ 5-min candles (last 100)
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "NQ1!", "5", 100).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    // Alpaca economic/macro news (today + yesterday)
    fetchAlpacaEconNews(env, yesterday, today),
    // ForexFactory economic calendar (today)
    fetchForexFactoryCalendar(env, today),
    // ForexFactory economic calendar (yesterday)
    fetchForexFactoryCalendar(env, yesterday),
  ]);

  // Process sector performance
  const sectors = SECTOR_ETFS.map(sym => {
    const d = sectorDataArr.find(s => s.sym === sym)?.data;
    return {
      sym,
      price: Number(d?.price) || 0,
      dayChangePct: Number(d?.day_change_pct) || 0,
      dayChange: Number(d?.day_change) || 0,
      state: d?.state || "",
    };
  }).sort((a, b) => Math.abs(b.dayChangePct) - Math.abs(a.dayChangePct));

  // Filter earnings to our universe or major S&P 500 names
  const sectorMap = opts.SECTOR_MAP || {};
  const ourTickers = new Set(Object.keys(sectorMap));
  const todayEarningsRaw = earningsWeek.filter(e => (e.date || "").slice(0, 10) === today);
  const weekEarnings = earningsWeek.filter(e =>
    ourTickers.has(e.symbol) ||
    (e.revenueEstimate && e.revenueEstimate > 1e9) // large-cap fallback
  );

  // Enrich today's earnings tickers with current price, daily change, and chart setup
  const todayEarnings = await Promise.all(todayEarningsRaw.map(async (e) => {
    try {
      const latestData = await kvGetJSON(KV, `timed:latest:${e.symbol}`).catch(() => null);
      if (latestData) {
        const price = Number(latestData.price) || 0;
        const dayChg = Number(latestData.day_change_pct) || 0;
        const state = latestData.state || "";
        const htfScore = Number(latestData.htf_score) || 0;
        const ltfScore = Number(latestData.ltf_score) || 0;
        const phaseZone = latestData.phase_zone || "";
        return {
          ...e,
          currentPrice: price > 0 ? price.toFixed(2) : null,
          dayChangePct: dayChg !== 0 ? (dayChg >= 0 ? "+" : "") + dayChg.toFixed(2) + "%" : null,
          chartSetup: state ? `${state}, HTF: ${htfScore.toFixed(0)}, LTF: ${ltfScore.toFixed(0)}, Phase: ${phaseZone}` : null,
        };
      }
    } catch (_) {}
    return e;
  }));

  // ── Economic Data: Finnhub (primary, structured API) + ForexFactory (supplement) ──
  // Finnhub returns structured calendar data with correct dates — reliable.
  // ForexFactory scraping is fragile: HTML changes, keyword fallback can match
  // events from sidebars/navigation (e.g. CPI from last week showing as "today").
  // Strategy: use Finnhub as source of truth for WHICH events happened today;
  // supplement with ForexFactory actuals only when the event name matches.
  const econWeek = Array.isArray(econWeekRaw?.events) ? econWeekRaw.events : (Array.isArray(econWeekRaw) ? econWeekRaw : []);
  const usEcon = econWeek.filter(e =>
    e.country === "US" && (e.impact === "high" || e.impact === "medium")
  );
  const dateOf = (e) => (e.date || "").slice(0, 10);

  // Finnhub events for today, yesterday, and rest of week
  let todayEcon = usEcon.filter(e => dateOf(e) === today);
  let yesterdayEcon = usEcon.filter(e => dateOf(e) === yesterday);
  const weekEcon = usEcon.filter(e => dateOf(e) !== today && dateOf(e) !== yesterday);

  // Supplement Finnhub today's events with ForexFactory actuals (if available)
  // Only merge if the event name fuzzy-matches — prevents false positives
  const ffTodayEvents = Array.isArray(ffToday) ? ffToday.filter(e => e.impact === "high" || e.impact === "medium") : [];
  const ffYesterdayEvents = Array.isArray(ffYesterday) ? ffYesterday.filter(e => e.impact === "high" || e.impact === "medium") : [];
  if (ffTodayEvents.length > 0 && todayEcon.length > 0) {
    const finnhubNames = new Set(todayEcon.map(e => (e.event || "").toLowerCase()));
    for (const ffe of ffTodayEvents) {
      const ffName = (ffe.event || "").toLowerCase();
      const matched = todayEcon.find(fe => ffName.includes((fe.event || "").toLowerCase().slice(0, 10)));
      if (matched && ffe.actual && !matched.actual) {
        matched.actual = ffe.actual;
        matched.estimate = matched.estimate || ffe.estimate;
        matched.prev = matched.prev || ffe.prev;
      }
    }
  }
  // If Finnhub returned nothing for today but ForexFactory has events,
  // cross-validate: only include FF events that are NOT in the week list
  // (prevents last week's CPI showing as today's release)
  if (todayEcon.length === 0 && ffTodayEvents.length > 0) {
    const weekNames = new Set(weekEcon.map(e => (e.event || "").toLowerCase()));
    const validated = ffTodayEvents.filter(e => {
      const name = (e.event || "").toLowerCase();
      return !weekNames.has(name);
    });
    if (validated.length > 0) {
      todayEcon = validated;
      console.log(`[ECON] Using ${validated.length} FF-only events for today (cross-validated against week)`);
    }
  }
  // Same for yesterday
  if (yesterdayEcon.length === 0 && ffYesterdayEvents.length > 0) {
    yesterdayEcon = ffYesterdayEvents;
  }

  console.log(`[ECON] Sources: Finnhub today=${todayEcon.length}, yesterday=${yesterdayEcon.length}, week=${weekEcon.length}, FF today=${ffTodayEvents.length}, FF yesterday=${ffYesterdayEvents.length}, Alpaca news=${(alpacaEconNews || []).length}`);

  // Open trades summary
  const trades = Array.isArray(tradesRaw) ? tradesRaw : [];
  const openTrades = trades.filter(t => t.status === "OPEN" || t.status === "TP_HIT_TRIM");

  // ── Today's trade activity from D1 (for brief enrichment) ──────────
  let todayTradeEntries = [];
  let todayTradeExits = [];
  let todayTradeTrimsDefends = [];
  let investorPositions = [];
  if (db) {
    const todayStart = new Date(today + "T00:00:00Z").getTime();
    const todayEnd = todayStart + 86400000;
    // For morning brief, also include yesterday's exits for context
    const yesterdayStart = todayStart - 86400000;
    try {
      const [entryRes, exitRes, trimRes, investorRes] = await Promise.all([
        db.prepare(
          "SELECT te.*, t.ticker, t.direction, t.rank, t.rr, t.status AS trade_status FROM trade_events te JOIN trades t ON te.trade_id = t.trade_id WHERE te.type = 'ENTRY' AND te.ts >= ?1 AND te.ts < ?2 ORDER BY te.ts DESC"
        ).bind(todayStart, todayEnd).all().catch(() => ({ results: [] })),
        db.prepare(
          "SELECT te.*, t.ticker, t.direction, t.pnl_pct, t.exit_reason, t.status AS trade_status FROM trade_events te JOIN trades t ON te.trade_id = t.trade_id WHERE te.type = 'EXIT' AND te.ts >= ?1 AND te.ts < ?2 ORDER BY te.ts DESC"
        ).bind(type === "morning" ? yesterdayStart : todayStart, todayEnd).all().catch(() => ({ results: [] })),
        db.prepare(
          "SELECT te.*, t.ticker, t.direction, t.status AS trade_status FROM trade_events te JOIN trades t ON te.trade_id = t.trade_id WHERE te.type IN ('TRIM', 'DEFEND') AND te.ts >= ?1 AND te.ts < ?2 ORDER BY te.ts DESC"
        ).bind(todayStart, todayEnd).all().catch(() => ({ results: [] })),
        db.prepare(
          "SELECT * FROM investor_positions WHERE status = 'OPEN' ORDER BY total_shares * COALESCE(avg_entry, 0) DESC LIMIT 20"
        ).all().catch(() => ({ results: [] })),
      ]);
      todayTradeEntries = (entryRes?.results || []).slice(0, 10);
      todayTradeExits = (exitRes?.results || []).slice(0, 10);
      todayTradeTrimsDefends = (trimRes?.results || []).slice(0, 10);
      investorPositions = (investorRes?.results || []).slice(0, 20);
    } catch (e) {
      console.error("[BRIEF] Error fetching trade events/investor positions:", e);
    }
  }

  // ES technical summary from candles (enhanced with 5-min for overnight range)
  const esTechnical = summarizeTechnical(
    esCandles?.candles || [], esCandlesH1?.candles || [],
    esCandlesM5?.candles || [], esData
  );

  // NQ technical summary from candles
  const nqTechnical = summarizeTechnical(
    nqCandles?.candles || [], nqCandlesH1?.candles || [],
    nqCandlesM5?.candles || [], nqData
  );

  // Build result
  const extract = (d) => d ? {
    price: Number(d.price) || 0,
    dayChangePct: Number(d.day_change_pct) || 0,
    dayChange: Number(d.day_change) || 0,
    state: d.state || "",
    rank: Number(d.rank) || 0,
    htf_score: Number(d.htf_score) || 0,
    ltf_score: Number(d.ltf_score) || 0,
    phase_zone: d.phase_zone || "",
    flags: d.flags || {},
  } : null;

  return {
    today,
    type,
    weekRange: { from: weekStart, to: weekEnd },
    calendar: {
      dayOfWeekLabel,
      isFriday,
      isHoliday,
      isEarlyClose,
    },
    market: {
      ES: extract(esData),
      NQ: extract(nqData),
      VIX: extract(vixData),
      SPY: extract(spyData),
      QQQ: extract(qqqData),
      IWM: extract(iwmData),
    },
    esTechnical,
    nqTechnical,
    sectors,
    todayEarnings,
    weekEarnings: weekEarnings.slice(0, 30), // cap for prompt size
    todayEconomicEvents: todayEcon.slice(0, 10),
    yesterdayEconomicEvents: yesterdayEcon.slice(0, 10),
    economicEvents: weekEcon.slice(0, 15),
    openTrades: openTrades.map(t => ({
      ticker: t.ticker, direction: t.direction, pnlPct: t.pnlPct,
      entryPrice: t.entryPrice, status: t.status,
    })).slice(0, 15),
    // Today's trade activity (Active Trader)
    todayEntries: todayTradeEntries.map(e => ({
      ticker: e.ticker, direction: e.direction, price: e.price,
      rank: e.rank, rr: e.rr, reason: e.reason,
      meta: e.meta_json ? (typeof e.meta_json === "string" ? JSON.parse(e.meta_json) : e.meta_json) : null,
    })),
    todayExits: todayTradeExits.map(e => ({
      ticker: e.ticker, direction: e.direction, price: e.price,
      pnlPct: e.pnl_pct, exitReason: e.exit_reason || e.reason,
      tradeStatus: e.trade_status,
    })),
    todayTrimsDefends: todayTradeTrimsDefends.map(e => ({
      ticker: e.ticker, direction: e.direction, type: e.type, price: e.price,
      qtyPctDelta: e.qty_pct_delta, qtyPctTotal: e.qty_pct_total,
      reason: e.reason,
    })),
    // Investor portfolio positions
    investorPositions: investorPositions.map(p => ({
      ticker: p.ticker, shares: p.total_shares, avgEntry: p.avg_entry,
      costBasis: p.cost_basis, thesis: p.thesis, stage: p.investor_stage,
    })),
    alpacaEconNews: (alpacaEconNews || []).slice(0, 10),
    morningPrediction: morningBrief?.es_prediction || null,
    morningContent: type === "evening" ? (morningBrief?.content || "").slice(0, 1500) : null,
  };
}

/** Summarize technical structure from candles for any instrument (ES, NQ, etc.) */
function summarizeTechnical(dailyCandles, hourlyCandles, fiveMinCandles, latestData) {
  if (!dailyCandles || dailyCandles.length < 5) return { available: false };

  const recent = dailyCandles.slice(-10);
  const closes = recent.map(c => Number(c.c)).filter(Number.isFinite);
  if (closes.length < 5) return { available: false };

  const hi = Math.max(...closes);
  const lo = Math.min(...closes);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];

  // True Range ATR from daily candles: max(H-L, |H-prevC|, |L-prevC|)
  // Matches the client-side ATR in fetchAtrFibLevels for consistency
  let atrSum = 0;
  let atrCount = 0;
  for (let i = 1; i < recent.length; i++) {
    const h = Number(recent[i].h);
    const l = Number(recent[i].l);
    const pc = Number(recent[i - 1].c);
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (tr > 0) { atrSum += tr; atrCount++; }
  }
  const atr14 = atrCount > 0 ? atrSum / atrCount : 0;

  // Recent hourly structure
  const h1Closes = (hourlyCandles || []).slice(-20).map(c => Number(c.c)).filter(Number.isFinite);
  const h1Hi = h1Closes.length > 0 ? Math.max(...h1Closes) : null;
  const h1Lo = h1Closes.length > 0 ? Math.min(...h1Closes) : null;

  // Previous session high/low/close for pivot points
  const prevDaily = recent.length >= 2 ? recent[recent.length - 2] : null;
  let pivots = null;
  if (prevDaily) {
    const pH = Number(prevDaily.h);
    const pL = Number(prevDaily.l);
    const pC = Number(prevDaily.c);
    if (Number.isFinite(pH) && Number.isFinite(pL) && Number.isFinite(pC)) {
      const pp = (pH + pL + pC) / 3;
      pivots = {
        pp: Math.round(pp * 100) / 100,
        r1: Math.round((2 * pp - pL) * 100) / 100,
        r2: Math.round((pp + (pH - pL)) * 100) / 100,
        s1: Math.round((2 * pp - pH) * 100) / 100,
        s2: Math.round((pp - (pH - pL)) * 100) / 100,
        prevHigh: pH,
        prevLow: pL,
        prevClose: pC,
      };
    }
  }

  // Overnight / pre-market range from 5-min candles
  // Filter to candles from the extended session: after 4:00 PM ET (21:00 UTC) yesterday
  // through 9:30 AM ET (14:30 UTC) today. This gives the true overnight range.
  let overnightRange = null;
  if (fiveMinCandles && fiveMinCandles.length > 0) {
    const now = new Date();
    // Today 14:30 UTC = 9:30 AM ET (RTH open)
    const rthOpenToday = new Date(now);
    rthOpenToday.setUTCHours(14, 30, 0, 0);
    // Yesterday 21:00 UTC = 4:00 PM ET (RTH close)
    const rthCloseYesterday = new Date(rthOpenToday);
    rthCloseYesterday.setUTCDate(rthCloseYesterday.getUTCDate() - 1);
    rthCloseYesterday.setUTCHours(21, 0, 0, 0);
    // If today is Monday, go back to Friday
    const dayOfWeek = now.getUTCDay();
    if (dayOfWeek === 1) { // Monday → Friday close
      rthCloseYesterday.setUTCDate(rthCloseYesterday.getUTCDate() - 2);
    }
    const rthCloseTs = rthCloseYesterday.getTime();
    const rthOpenTs = rthOpenToday.getTime();

    // Filter 5-min candles to overnight session only
    const overnightCandles = fiveMinCandles.filter(c => {
      const ts = Number(c.ts || c.t);
      return ts >= rthCloseTs && ts < rthOpenTs;
    });

    // Fallback: if no candles match the timestamp filter, use the last 60 candles
    const m5ForRange = overnightCandles.length >= 3 ? overnightCandles : fiveMinCandles.slice(-60);
    const m5Highs = m5ForRange.map(c => Number(c.h)).filter(Number.isFinite);
    const m5Lows = m5ForRange.map(c => Number(c.l)).filter(Number.isFinite);
    if (m5Highs.length > 0) {
      overnightRange = {
        high: Math.round(Math.max(...m5Highs) * 100) / 100,
        low: Math.round(Math.min(...m5Lows) * 100) / 100,
      };
    }
  }

  // ── ATR Fibonacci Day Trader Levels ──────────────────────────────────
  // Compute session ATR from 5-min candles, then project Fibonacci levels
  // from the previous daily close (anchor). These are tighter, more
  // actionable than traditional pivot levels for intraday trading.
  let atrFibLevels = null;
  // Use previous daily close as anchor — matches the client-side chart levels exactly
  const prevDayCandle = recent[recent.length - 2];
  const anchor = prevDayCandle ? Number(prevDayCandle.c) : (pivots?.prevClose || last);
  if (anchor > 0 && atr14 > 0) {
    // Use the daily true-range ATR directly (already computed above)
    const dayAtr = atr14;

    // Also compute 5m ATR for micro-level reference
    let m5Atr = 0;
    if (fiveMinCandles && fiveMinCandles.length >= 14) {
      const m5ForAtr = fiveMinCandles.slice(-14);
      let m5AtrSum = 0;
      for (const c of m5ForAtr) {
        const h = Number(c.h), l = Number(c.l);
        m5AtrSum += Math.abs(h - l);
      }
      m5Atr = m5AtrSum / m5ForAtr.length;
    }

    const rnd = (v) => Math.round(v * 100) / 100;
    // Match client-side fibs exactly (no 0.786)
    const fibs = [0.236, 0.382, 0.500, 0.618, 1.0];

    atrFibLevels = {
      anchor: rnd(anchor),
      dayAtr: rnd(dayAtr),
      m5Atr: rnd(m5Atr),
      currentPrice: Number(latestData?.price) || null,
      levels: {},
    };

    for (const f of fibs) {
      const label = (f * 100).toFixed(1).replace(/\.0$/, "");
      atrFibLevels.levels[`+${label}%`] = rnd(anchor + dayAtr * f);
      atrFibLevels.levels[`-${label}%`] = rnd(anchor - dayAtr * f);
    }

    // Golden Gate detection: has price already crossed the 38.2% level pre-9AM?
    const curPrice = Number(latestData?.price) || 0;
    const upGate = anchor + dayAtr * 0.382;
    const dnGate = anchor - dayAtr * 0.382;
    if (curPrice > 0) {
      if (curPrice > upGate) {
        atrFibLevels.goldenGate = "OPEN_UP";
        atrFibLevels.goldenGateNote = `Price ${rnd(curPrice)} has crossed +38.2% at ${rnd(upGate)}. Target +50% at ${rnd(anchor + dayAtr * 0.5)} and +61.8% at ${rnd(anchor + dayAtr * 0.618)}.`;
      } else if (curPrice < dnGate) {
        atrFibLevels.goldenGate = "OPEN_DOWN";
        atrFibLevels.goldenGateNote = `Price ${rnd(curPrice)} has crossed -38.2% at ${rnd(dnGate)}. Target -50% at ${rnd(anchor - dayAtr * 0.5)} and -61.8% at ${rnd(anchor - dayAtr * 0.618)}.`;
      } else {
        atrFibLevels.goldenGate = "NEUTRAL";
        atrFibLevels.goldenGateNote = `Price ${rnd(curPrice)} is between the 38.2% gates (${rnd(dnGate)} - ${rnd(upGate)}). Watch for a breakout.`;
      }
    }
  }

  // ── Multi-day Structure Context ──────────────────────────────────────
  // Provides the AI with swing-level context for scenario analysis
  const rnd2 = (v) => Math.round(v * 100) / 100;
  let structureContext = null;
  if (recent.length >= 5) {
    const allCloses = recent.map(c => Number(c.c));
    const allHighs = recent.map(c => Number(c.h));
    const allLows = recent.map(c => Number(c.l));

    // 5-day trend: is price making higher highs/higher lows or lower?
    const c5 = allCloses.slice(-5);
    const fiveDayChange = c5[c5.length - 1] - c5[0];
    const fiveDayChangePct = ((fiveDayChange / c5[0]) * 100);
    const recentHigherHighs = allHighs.slice(-4).every((h, i) => i === 0 || h >= allHighs[allHighs.length - 4 + i - 1]);
    const recentLowerLows = allLows.slice(-4).every((l, i) => i === 0 || l <= allLows[allLows.length - 4 + i - 1]);

    // Key swing levels from 10 daily candles
    const swingHigh = Math.max(...allHighs);
    const swingLow = Math.min(...allLows);

    // Weekly candle approximation (last 5 trading days)
    const weekCandles = dailyCandles.slice(-5);
    const weekOpen = Number(weekCandles[0]?.o || weekCandles[0]?.c);
    const weekHigh = Math.max(...weekCandles.map(c => Number(c.h)));
    const weekLow = Math.min(...weekCandles.map(c => Number(c.l)));
    const weekClose = Number(weekCandles[weekCandles.length - 1]?.c);

    structureContext = {
      fiveDayChange: rnd2(fiveDayChange),
      fiveDayChangePct: rnd2(fiveDayChangePct),
      trendBias: recentHigherHighs ? "HIGHER_HIGHS" : recentLowerLows ? "LOWER_LOWS" : "MIXED",
      tenDaySwingHigh: rnd2(swingHigh),
      tenDaySwingLow: rnd2(swingLow),
      weeklyCandleApprox: {
        open: rnd2(weekOpen),
        high: rnd2(weekHigh),
        low: rnd2(weekLow),
        close: rnd2(weekClose),
        bodyType: weekClose > weekOpen ? "BULLISH" : weekClose < weekOpen ? "BEARISH" : "DOJI",
        rangePct: rnd2(((weekHigh - weekLow) / weekLow) * 100),
      },
    };
  }

  return {
    available: true,
    lastClose: last,
    prevClose: prev,
    tenDayHigh: hi,
    tenDayLow: lo,
    atr14: Math.round(atr14 * 100) / 100,
    hourlyRange: h1Hi != null ? { high: h1Hi, low: h1Lo } : null,
    pivots,
    overnightRange,
    atrFibLevels,
    structureContext,
    vixPrice: Number(latestData?.price) || null,
    state: latestData?.state || "",
    phaseZone: latestData?.phase_zone || "",
  };
}

/** Backward compat wrapper for ES */
function summarizeES(dailyCandles, hourlyCandles, latestData) {
  return summarizeTechnical(dailyCandles, hourlyCandles, null, latestData);
}

// ═══════════════════════════════════════════════════════════════════════
// AI Prompt Construction & Generation
// ═══════════════════════════════════════════════════════════════════════

const ANALYST_SYSTEM_PROMPT = `You are a senior market strategist and Head of Technical Strategy at a top-tier macro research firm (think Mark Newton at FS Insight, Tom Lee, or a CMT-level analyst). You write daily briefs for an active trading desk that includes both swing traders AND intraday/day traders.

Your analysis style is:
- **Structural**: You think in terms of wave counts (Elliott Wave), measured moves, Fibonacci retracements/extensions, and pattern completions. You identify whether moves are impulsive or corrective.
- **Conditional**: You present "if X, then Y; if not, then Z" scenarios. Always give both the bull case AND the bear case with specific invalidation levels.
- **Specific**: Every claim has a price level, percentage, or data point attached. Never say "market may go higher" — say "a bounce toward the 6894-6918 resistance zone is likely before a decision point."
- **Time-aware**: You reference timeframes and durations — "near-term weakness into 2/20 before a rebound into early March" rather than just "weakness expected."
- **Contextual**: You zoom out to the larger trend before zooming in. "Despite huge micro-volatility, the larger trend since November has been neutral/range-bound between X and Y."

Writing Guidelines:
- Write in a professional, authoritative yet accessible style with clear section headers using markdown ##
- Reference specific price levels, percentages, zones (e.g., "6894-6918 resistance zone"), and data points
- For ES/NQ projections: analyze the STRUCTURE of recent price action:
  - Is this a three-wave corrective move or a five-wave impulse? What does that imply?
  - Where are key support/resistance zones (not just single levels — zones)?
  - What do bulls need to see vs what do bears need to see? State specific prices.
  - Reference EMAs (21, 48, 200), SuperTrend levels, any visible FVGs (Fair Value Gaps), and VIX context
  - Give a clear directional thesis WITH invalidation: "Bullish above X, targeting Y. Below X, bearish toward Z."
- For day trading levels: provide SPECIFIC numbers: ATR Fibonacci levels (38.2%, 50%, 61.8% of daily ATR), overnight high/low, previous session high/low/close, and Golden Gate status
- For earnings: note pre-market/after-hours timing and surprise vs estimate. ALWAYS include the current price (CP) and daily change in parentheses next to the ticker, e.g., "ESNT ($148.52, +1.30%)". When chart setup data is available, add a brief technical assessment.
- For macro/economic events: explain the MARKET IMPACT — especially for major releases (CPI, PPI, FOMC, NFP, GDP, etc.)
  - When actual data is available: compare to estimate and previous, explain what it means for rate expectations, risk appetite, and sector rotation
  - Note if the release happened pre-market and how futures reacted
- Include 1-2 Trader's Almanac insights when relevant (seasonal patterns, historical tendencies for this time of year)
- End each brief with clear, actionable takeaways for BOTH swing traders and day traders
- Use ticker symbols in CAPS (e.g., AAPL, ES1!)
- Format percentage changes inline like: AAPL +2.30%, XLK -1.10%
- CRITICAL: ALL economic data values (CPI, PPI, GDP, etc.) MUST use EXACTLY two decimal places (e.g., 2.40%, 0.30%, not 2.4%, 0.3%). Copy values EXACTLY as provided.
- Keep total length to 1500-2500 words — be thorough, not terse
- Do NOT use emojis

Timed Trading Scoring Model Reference (ALWAYS reference these signals):
- **state**: Current model signal state — LONG (bullish setup), SHORT (bearish setup), WATCH (neutral, waiting for confirmation), or FLAT (no position/signal)
- **htf_score**: Higher-Timeframe composite score (0-100). Incorporates weekly/monthly trend alignment, EMAs, SuperTrend, and macro health. Above 65 = strong bullish structure, below 40 = bearish pressure.
- **ltf_score**: Lower-Timeframe composite score (0-100). Incorporates intraday/daily momentum, mean-reversion signals, and short-term breadth. Divergence between HTF and LTF scores indicates potential reversals.
- **phase_zone**: Current market phase classification — e.g., "markup" (trending up), "distribution" (topping), "markdown" (trending down), "accumulation" (basing/bottoming), "recovery" (early reversal)
- **rank**: Overall ticker rank relative to the universe (higher = stronger)
- **flags**: Active signal flags — e.g., golden_gate_up/down (ATR breakout), supertrend_flip, ema_cross, rs_new_high, accum_zone

CRITICAL: You MUST explicitly reference our scoring model signals (state, HTF/LTF scores, phase zone) when analyzing market direction and structure. These are the primary quantitative signals that drive our analysis and trading decisions. When the HTF score is strong but LTF is weak (or vice versa), discuss the divergence and what it implies. Always mention the current state and phase zone for ES and NQ.`;

function fmtEconValue(val, unit) {
  if (val == null || val === "") return null;
  const s = String(val).replace(/[%]/g, "").trim();
  const n = parseFloat(s);
  if (Number.isFinite(n)) {
    // Format to 2 decimal places for consistency
    const formatted = n.toFixed(2);
    const suffix = (unit === "%" || String(val).includes("%")) ? "%" : (unit || "");
    return `${formatted}${suffix}`;
  }
  return `${val}${unit || ""}`;
}

function fmtEconEvent(e) {
  const dateStr = (e.date || "").slice(0, 10);
  const timeStr = e.time || (e.date || "").slice(11) || "";
  const datePart = dateStr ? `[${dateStr}${timeStr ? " " + timeStr : ""}] ` : "";
  const parts = [`${datePart}${e.event} — Impact: ${e.impact}`];
  const actual = fmtEconValue(e.actual, e.unit);
  const estimate = fmtEconValue(e.estimate, e.unit);
  const prev = fmtEconValue(e.prev, e.unit);
  if (actual) parts.push(`Actual: ${actual}`);
  if (estimate) parts.push(`Est: ${estimate}`);
  if (prev) parts.push(`Prev: ${prev}`);
  if (actual && estimate) {
    const diff = parseFloat(String(e.actual).replace(/[%]/g, "")) - parseFloat(String(e.estimate).replace(/[%]/g, ""));
    if (Number.isFinite(diff)) parts.push(diff > 0 ? "(ABOVE consensus)" : diff < 0 ? "(BELOW consensus)" : "(IN LINE)");
  }
  return parts.join(", ");
}

function buildMorningPrompt(data) {
  const cal = data.calendar || {};
  const calNote = cal.isHoliday
    ? "US equity markets are CLOSED today (holiday). Acknowledge this in your opening and focus on futures/overnight context and next trading day."
    : cal.isEarlyClose
      ? "US equity markets have an EARLY CLOSE today (1:00 PM ET). Mention this and any positioning implications."
      : cal.isFriday
        ? "Today is Friday. Acknowledge weekend positioning, typical Friday flows, and reduced liquidity into the close where relevant."
        : "";
  return `Generate the MORNING BRIEF for ${data.today} (${cal.dayOfWeekLabel || "weekday"}) (published by 9:00 AM ET).
${calNote ? `\n## Calendar context (MUST acknowledge where relevant):\n${calNote}\n` : ""}

## Market Data (as of pre-market):
${JSON.stringify(data.market, null, 1)}

## Timed Trading Scoring Model Signals (MUST reference in your analysis):
${Object.entries(data.market).filter(([, v]) => v).map(([sym, v]) => {
  const parts = [`${sym}: State=${v.state || "N/A"}, HTF=${v.htf_score}, LTF=${v.ltf_score}, Phase=${v.phase_zone || "N/A"}, Rank=${v.rank}`];
  if (v.flags && Object.keys(v.flags).length > 0) parts.push(`Flags=[${Object.entries(v.flags).filter(([,f]) => f).map(([k]) => k).join(", ")}]`);
  return parts.join(", ");
}).join("\n")}

## ES Technical Summary:
${JSON.stringify(data.esTechnical, null, 1)}

## NQ Technical Summary:
${JSON.stringify(data.nqTechnical, null, 1)}

## Sector ETF Performance (sorted by magnitude):
${data.sectors.map(s => `${s.sym}: ${s.dayChangePct >= 0 ? "+" : ""}${s.dayChangePct.toFixed(2)}% ($${s.price.toFixed(2)})`).join("\n")}

## Earnings Today:
${data.todayEarnings.length > 0
    ? data.todayEarnings.map(e => {
        const pricePart = e.currentPrice ? ` ($${e.currentPrice}${e.dayChangePct ? " " + e.dayChangePct : ""})` : "";
        const chartPart = e.chartSetup ? `, Chart Setup: ${e.chartSetup}` : "";
        return `${e.symbol}${pricePart}: ${e.hour === "bmo" ? "Pre-Market" : e.hour === "amc" ? "After-Hours" : e.hour || "TBD"}, EPS Est: ${e.epsEstimate ?? "N/A"}, Rev Est: ${e.revenueEstimate ? "$" + (e.revenueEstimate / 1e9).toFixed(1) + "B" : "N/A"}${e.epsActual != null ? `, EPS Actual: ${e.epsActual}` : ""}${chartPart}`;
      }).join("\n")
    : "No major earnings today."}

## Earnings This Week:
${data.weekEarnings.length > 0
    ? data.weekEarnings.slice(0, 15).map(e => `${e.symbol} (${e.date}, ${e.hour === "bmo" ? "Pre-Market" : e.hour === "amc" ? "After-Hours" : e.hour || "TBD"})`).join(", ")
    : "Light earnings week."}

## TODAY'S Economic Data Releases (CRITICAL — analyze these in detail):
${data.todayEconomicEvents.length > 0
    ? data.todayEconomicEvents.map(fmtEconEvent).join("\n")
    : "No major US economic releases today."}

## YESTERDAY'S Economic Data (still influencing today's price action):
${data.yesterdayEconomicEvents.length > 0
    ? data.yesterdayEconomicEvents.map(fmtEconEvent).join("\n")
    : "No major US economic releases yesterday."}

## Other Economic Events This Week (US, Medium-High Impact):
${data.economicEvents.length > 0
    ? data.economicEvents.map(fmtEconEvent).join("\n")
    : "No additional major US economic events this week."}

## Market-Moving News Headlines (from Alpaca News):
${(data.alpacaEconNews || []).length > 0
    ? data.alpacaEconNews.map(n => `- [${(n.created_at || "").slice(0, 16)}] ${n.headline}${n.summary ? " — " + n.summary.slice(0, 150) : ""}`).join("\n")
    : "No major economic/macro news headlines found."}

## Active Trader — Open Positions:
${data.openTrades.length > 0
    ? data.openTrades.map(t => `${t.ticker} (${t.direction}, Entry: $${t.entryPrice ?? "N/A"}, P&L: ${t.pnlPct != null ? t.pnlPct.toFixed(1) + "%" : "N/A"}, Status: ${t.status})`).join("\n")
    : "No open Active Trader positions."}

## Active Trader — New Entries Today:
${(data.todayEntries || []).length > 0
    ? data.todayEntries.map(e => `${e.ticker} ${e.direction} @ $${e.price ?? "N/A"} (Rank: ${e.rank ?? "N/A"}, R:R: ${e.rr != null ? e.rr.toFixed(1) : "N/A"}, Reason: ${e.reason || "Signal"})`).join("\n")
    : "No new entries today."}

## Active Trader — Yesterday's Exits:
${(data.todayExits || []).length > 0
    ? data.todayExits.map(e => `${e.ticker} ${e.direction} @ $${e.price ?? "N/A"} (P&L: ${e.pnlPct != null ? e.pnlPct.toFixed(1) + "%" : "N/A"}, Reason: ${e.exitReason || "N/A"}, Result: ${e.tradeStatus})`).join("\n")
    : "No recent exits."}

## Active Trader — Trims & Defends Today:
${(data.todayTrimsDefends || []).length > 0
    ? data.todayTrimsDefends.map(e => `${e.type}: ${e.ticker} ${e.direction} @ $${e.price ?? "N/A"} (${e.type === "TRIM" ? `Trimmed ${e.qtyPctDelta ?? "?"}%, Total trimmed: ${e.qtyPctTotal ?? "?"}%` : `SL tightened`}, Reason: ${e.reason || "N/A"})`).join("\n")
    : "No trims or defends today."}

## Investor Portfolio — Current Holdings:
${(data.investorPositions || []).length > 0
    ? data.investorPositions.map(p => `${p.ticker}: ${p.shares} shares @ avg $${p.avgEntry != null ? p.avgEntry.toFixed(2) : "N/A"} (Stage: ${p.stage || "N/A"}${p.thesis ? `, Thesis: ${p.thesis.slice(0, 80)}` : ""})`).join("\n")
    : "No investor positions."}

## Required Sections:
1. **Market Context & Macro** — Start with the BIG PICTURE. What is the dominant regime right now? (Trending, range-bound, volatile?) What macro forces are driving it? If today has a major economic release (CPI, PPI, NFP, FOMC, GDP, etc.), LEAD with it: explain the numbers vs consensus, what it means for Fed policy / rate cuts, how futures reacted, and sector implications. If yesterday had a major release, discuss lingering impact. Note upcoming releases this week.

2. **Structure & Scenario Analysis (ES & NQ)** — This is the MOST IMPORTANT section. Analyze like a CMT-level strategist:
   - **Current Structure**: Is this week's decline (or rally) a three-wave corrective move or a five-wave impulse? What does the pattern imply? Reference the prior swing levels and whether they held/broke.
   - **Key Zones** (not just single levels): e.g., "Resistance zone at 6894-6918" or "Support cluster at 5940-5960 (confluence of 50-day EMA + prior swing low)"
   - **Bull Case**: What do bulls need to see? Specify price levels. "Bulls need ES to reclaim 6918 to negate the bearish count. Above there, 6950-6975 becomes the target."
   - **Bear Case**: What do bears need? "If ES fails to hold 6830, the next leg down targets 6750-6780 zone. A break below 6750 would confirm a five-wave decline."
   - **Base Case / Primary Thesis**: Your most probable scenario with conditional logic: "My base case: a bounce into the 6894-6918 zone before stalling. If this is a three-wave correction, we should see a higher low above 6830 by mid-next-week."
   - **Time Context**: When? "Near-term weakness into Feb 20 before a rebound into early March" — give a timeline, not just direction.
   - Reference VIX (elevated = wider ranges, compressed = breakout pending), EMAs, and any visible pattern setups.

3. **Day Trader Levels & Game Plan** — Use the ATR Fibonacci levels for BOTH ES and NQ:
   - **ATR Fib Levels**: List the 38.2%, 50%, 61.8%, and 100% ATR levels above and below the anchor (prev close). These define the intraday playing field.
   - **Golden Gate Status**: If OPEN_UP or OPEN_DOWN, highlight prominently — price has crossed the 38.2% ATR level, so target the 50% and 61.8%.
   - **Overnight/pre-market range**: key reference for the opening print
   - **Conditional Game Plan**: Write it as a decision tree:
     "If ES opens above [overnight high] and holds the +23.6% ATR at $XXXX → bullish bias, target +38.2% at $XXXX, then +50% at $XXXX"
     "If ES rejects at [level] and breaks below the overnight low at $XXXX → bearish, target -38.2% at $XXXX"
   - Note any major data release timing that could cause volatility spikes (e.g., "CPI at 8:30 AM — expect elevated volatility, wait for the first 15-min candle to close before committing")

4. **Earnings Watch** — What tickers have earnings today and this week? Pre-market or after-hours? Any pre-market results? Key names to watch.

5. **Sector Spotlight** — Which sectors are leading/lagging? Any notable rotations? What does sector breadth tell us about market health?

6. **Trader's Almanac** — Seasonal patterns, options expiry effects, historical tendencies for this date/week/month. If it's a notable calendar week (OPEX, month-end, quarter-end), mention how that historically affects price action.

7. **Active Trader Book** — If we have open positions, entries, or exits:
   - Discuss each OPEN position briefly: what's the thesis, how is it performing, should we hold/trim/exit?
   - For NEW ENTRIES today: explain WHY we entered — what setup triggered it (rank, R:R, signals)?
   - For YESTERDAY'S EXITS: were they winners or losers? What can we learn?
   - For TRIMS/DEFENDS: explain the risk management logic.

8. **Investor Portfolio** — If we have investor holdings:
   - Brief update on each holding's performance and whether the long-term thesis is intact.
   - Note any notable price action on holdings today.
   - Any DCA opportunities based on current levels?

End with TWO clear sections:
- **Swing Trader Takeaway**: What should position traders be doing today? (Holding, adding, reducing, hedging?)
- **ES Prediction**: One specific, falsifiable prediction line like: "ES Prediction: Bounce toward 6894-6918 resistance zone before stalling. Bullish above 6918, bearish below 6830. Expected range: 6830-6920."`;
}

function buildEveningPrompt(data) {
  const cal = data.calendar || {};
  const calNote = cal.isHoliday
    ? "US equity markets were CLOSED today (holiday). Focus on futures/overnight and next trading day."
    : cal.isEarlyClose
      ? "US equity markets had an EARLY CLOSE today (1:00 PM ET). Mention this when summarizing the session."
      : cal.isFriday
        ? "Today was Friday. Acknowledge week-in-review, weekend positioning, and any Monday outlook where relevant."
        : "";
  return `Generate the EVENING BRIEF for ${data.today} (${cal.dayOfWeekLabel || "weekday"}) (published by 5:00 PM ET).
${calNote ? `\n## Calendar context (MUST acknowledge where relevant):\n${calNote}\n` : ""}

## Market Close Data:
${JSON.stringify(data.market, null, 1)}

## Timed Trading Scoring Model Signals at Close (MUST reference in your analysis):
${Object.entries(data.market).filter(([, v]) => v).map(([sym, v]) => {
  const parts = [`${sym}: State=${v.state || "N/A"}, HTF=${v.htf_score}, LTF=${v.ltf_score}, Phase=${v.phase_zone || "N/A"}, Rank=${v.rank}`];
  if (v.flags && Object.keys(v.flags).length > 0) parts.push(`Flags=[${Object.entries(v.flags).filter(([,f]) => f).map(([k]) => k).join(", ")}]`);
  return parts.join(", ");
}).join("\n")}

## ES Technical Summary:
${JSON.stringify(data.esTechnical, null, 1)}

## NQ Technical Summary:
${JSON.stringify(data.nqTechnical, null, 1)}

## Sector ETF Performance (sorted by magnitude):
${data.sectors.map(s => `${s.sym}: ${s.dayChangePct >= 0 ? "+" : ""}${s.dayChangePct.toFixed(2)}% ($${s.price.toFixed(2)})`).join("\n")}

## This Morning's ES Prediction:
${data.morningPrediction || "No morning prediction available."}

## This Morning's Full Brief Summary (first 1000 chars):
${data.morningContent ? data.morningContent.slice(0, 1000) : "Morning brief not available."}

## Today's Economic Data Releases:
${data.todayEconomicEvents.length > 0
    ? data.todayEconomicEvents.map(fmtEconEvent).join("\n")
    : "No major US economic releases today."}

## Yesterday's Economic Data:
${data.yesterdayEconomicEvents.length > 0
    ? data.yesterdayEconomicEvents.map(fmtEconEvent).join("\n")
    : "No major US economic releases yesterday."}

## Market-Moving News Headlines (from Alpaca News):
${(data.alpacaEconNews || []).length > 0
    ? data.alpacaEconNews.map(n => `- [${(n.created_at || "").slice(0, 16)}] ${n.headline}${n.summary ? " — " + n.summary.slice(0, 150) : ""}`).join("\n")
    : "No major economic/macro news headlines found."}

## After-Hours Earnings:
${data.todayEarnings.filter(e => e.hour === "amc").length > 0
    ? data.todayEarnings.filter(e => e.hour === "amc").map(e => `${e.symbol}: EPS Est: ${e.epsEstimate ?? "N/A"}${e.epsActual != null ? `, EPS Actual: ${e.epsActual}` : ", Results pending"}, Rev Est: ${e.revenueEstimate ? "$" + (e.revenueEstimate / 1e9).toFixed(1) + "B" : "N/A"}${e.revenueActual ? `, Rev Actual: $${(e.revenueActual / 1e9).toFixed(1)}B` : ""}`).join("\n")
    : "No major after-hours earnings today."}

## Active Trader — Open Positions (EOD):
${data.openTrades.length > 0
    ? data.openTrades.map(t => `${t.ticker} (${t.direction}, Entry: $${t.entryPrice ?? "N/A"}, P&L: ${t.pnlPct != null ? t.pnlPct.toFixed(1) + "%" : "N/A"}, Status: ${t.status})`).join("\n")
    : "No open Active Trader positions."}

## Active Trader — Entries Today:
${(data.todayEntries || []).length > 0
    ? data.todayEntries.map(e => `${e.ticker} ${e.direction} @ $${e.price ?? "N/A"} (Rank: ${e.rank ?? "N/A"}, R:R: ${e.rr != null ? e.rr.toFixed(1) : "N/A"}, Reason: ${e.reason || "Signal"})`).join("\n")
    : "No new entries today."}

## Active Trader — Exits Today:
${(data.todayExits || []).length > 0
    ? data.todayExits.map(e => `${e.ticker} ${e.direction} @ $${e.price ?? "N/A"} (P&L: ${e.pnlPct != null ? e.pnlPct.toFixed(1) + "%" : "N/A"}, Reason: ${e.exitReason || "N/A"}, Result: ${e.tradeStatus})`).join("\n")
    : "No exits today."}

## Active Trader — Trims & Defends Today:
${(data.todayTrimsDefends || []).length > 0
    ? data.todayTrimsDefends.map(e => `${e.type}: ${e.ticker} ${e.direction} @ $${e.price ?? "N/A"} (${e.type === "TRIM" ? `Trimmed ${e.qtyPctDelta ?? "?"}%, Total: ${e.qtyPctTotal ?? "?"}%` : `SL tightened`}, Reason: ${e.reason || "N/A"})`).join("\n")
    : "No trims or defends today."}

## Investor Portfolio — Current Holdings:
${(data.investorPositions || []).length > 0
    ? data.investorPositions.map(p => `${p.ticker}: ${p.shares} shares @ avg $${p.avgEntry != null ? p.avgEntry.toFixed(2) : "N/A"} (Stage: ${p.stage || "N/A"}${p.thesis ? `, Thesis: ${p.thesis.slice(0, 80)}` : ""})`).join("\n")
    : "No investor positions."}

## Required Sections:
1. **Market Recap & Session Narrative** — Tell the STORY of today's session. Don't just list numbers — explain the narrative arc: How did we open? What drove the morning action? Was there a reversal? What triggered it? Lead with the most market-moving event. Reference specific times when key moves occurred.

2. **ES Prediction Scorecard** — Was our morning prediction correct? Grade it honestly (HIT, PARTIAL, MISS). What was predicted vs what happened? Why did reality differ from the forecast (if it did)? What can we learn from this for future predictions?

3. **Structural Update (ES & NQ)** — Now that today's session is complete, update the structural picture:
   - Has the structure changed? Did today confirm or negate our morning thesis?
   - Where are we in the larger pattern? (e.g., "Today's bounce confirms wave 4 is still developing. Wave 5 lower into the 6750 zone may still be ahead.")
   - Key levels that were tested — did they hold? "The 6830 support held all day, setting up a potential failed breakdown."
   - Updated bull/bear thresholds for tomorrow.

4. **Day Trader Session Review** — How did the ATR Fibonacci levels perform today? Did price respect the levels? Which levels acted as support/resistance? What was today's range vs expected ATR? Any notable intraday patterns (failed breakdowns, V-reversals, range compression)?

5. **Macro & Data Impact** — If any major economic data was released today, deep-dive on the impact: how did markets react in the first 30 minutes? Did the reaction hold or reverse? What does the data mean for the Fed path and rate expectations going forward?

6. **After-Hours Earnings** — Any after-hours reports and their impact? Key numbers vs estimates.

7. **Sector Analysis** — Which sectors led/lagged today and WHY? Any notable rotation patterns? What does sector breadth tell us (narrow leadership = fragile, broad participation = healthy)?

8. **Looking Ahead: Next Week Setup** — This is the strategic section. Looking at the weekly candle that's forming:
   - What does this week's price action tell us about next week's probable direction?
   - Key events next week (economic calendar, earnings, OPEX, etc.)
   - Specific levels to watch: "If ES starts next week above 6900, the bounce has legs toward 6950-6975. Below 6830 and we're likely heading to test the February lows."
   - Time-based expectations: "I expect a potential retest of [level] early next week before the next directional move by mid-week."

9. **Active Trader Session Report** — Segmented review of our trading book today:
   - **Entries**: What did we enter today and WHY? Reference the setup quality, rank, R:R, and what signals were active. Was it a good entry in hindsight?
   - **Exits**: What did we exit and WHY? Hit TP? Hit SL? Signal reversal? Was it a winner or loser? What can we learn?
   - **Trims/Defends**: What did we trim or defend and WHY? Explain the risk management logic.
   - **Open Positions EOD**: Brief status update on each open position — is the thesis still intact? P&L status?

10. **Investor Portfolio Update** — If we have investor holdings:
    - How did each holding perform today?
    - Is the long-term thesis still intact?
    - Any DCA opportunities at current levels?
    - Any notable company news or earnings affecting holdings?

End with TWO sections:
- **Swing Trader Positioning**: What should position traders do going into tomorrow/next week? (Hold, add, reduce, hedge, wait?)
- **Key Levels to Watch**: A clean list of the 3-5 most important support and resistance levels for ES going into the next session.`;
}

/**
 * Call OpenAI to generate a daily brief.
 * @returns {string} Markdown content
 */
async function callOpenAI(env, systemPrompt, userPrompt) {
  const apiKey = env?.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const model = env?.DAILY_BRIEF_MODEL || "gpt-4o";
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.65,
      max_tokens: 5000,
    }),
    signal: AbortSignal.timeout(90000), // 90s timeout for larger model
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenAI ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const json = await resp.json();
  return json.choices?.[0]?.message?.content || "";
}

// ═══════════════════════════════════════════════════════════════════════
// Discord Embed Builder
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a structured Discord embed for the daily brief notification.
 * Uses embed fields for clean layout on mobile Discord.
 */
function buildDiscordBriefEmbed(type, data, content, esPrediction) {
  const isMorning = type === "morning";
  const fields = [];

  // Market Snapshot
  const m = data.market || {};
  const fmtMkt = (sym, d) => d ? `${sym} ${d.price?.toFixed?.(2) ?? d.price} (${d.dayChangePct >= 0 ? "+" : ""}${d.dayChangePct?.toFixed?.(2) ?? "0"}%)` : null;
  const mktParts = [
    fmtMkt("ES", m.ES), fmtMkt("NQ", m.NQ), fmtMkt("VX1!", m["VX1!"]),
  ].filter(Boolean);
  if (mktParts.length > 0) {
    fields.push({ name: "Market Snapshot", value: mktParts.join(" | "), inline: false });
  }

  // ATR Fibonacci Levels (from ES technical)
  const esFib = data.esTechnical?.atrFibLevels;
  if (esFib && esFib.levels) {
    const lvl = esFib.levels;
    const fibStr = [
      `38.2%: ${lvl["-38.2%"] ?? "—"} / ${lvl["+38.2%"] ?? "—"}`,
      `50%: ${lvl["-50%"] ?? "—"} / ${lvl["+50%"] ?? "—"}`,
      `61.8%: ${lvl["-61.8%"] ?? "—"} / ${lvl["+61.8%"] ?? "—"}`,
    ].join("\n");
    const gate = esFib.goldenGate === "OPEN_UP" ? "🟢 Golden Gate OPEN UP"
      : esFib.goldenGate === "OPEN_DOWN" ? "🔴 Golden Gate OPEN DOWN"
      : "⚪ Neutral";
    fields.push({
      name: `ES Day Trader Levels (ATR ${esFib.dayAtr?.toFixed?.(1) ?? "—"})`,
      value: `${gate}\n${fibStr}`,
      inline: false,
    });
  }

  // Economic Events
  const econEvents = (data.todayEconomicEvents || []).slice(0, 3);
  if (econEvents.length > 0) {
    const econStr = econEvents.map(e => {
      const parts = [e.event];
      if (e.actual != null && e.actual !== "") parts.push(`Act: ${e.actual}${e.unit || ""}`);
      if (e.estimate != null && e.estimate !== "") parts.push(`Est: ${e.estimate}${e.unit || ""}`);
      if (e.prev != null && e.prev !== "") parts.push(`Prev: ${e.prev}${e.unit || ""}`);
      return parts.join(", ");
    }).join("\n");
    fields.push({ name: "Economic Data", value: econStr, inline: false });
  }

  // ES Prediction
  if (esPrediction) {
    fields.push({ name: "ES Prediction", value: esPrediction.slice(0, 200), inline: false });
  }

  // Open Positions Summary
  if (data.openTrades && data.openTrades.length > 0) {
    const posStr = data.openTrades.slice(0, 5).map(t =>
      `${t.ticker} ${t.direction} ${t.pnlPct != null ? (t.pnlPct >= 0 ? "+" : "") + t.pnlPct.toFixed(1) + "%" : ""}`
    ).join(" | ");
    fields.push({ name: "Open Positions", value: posStr, inline: false });
  }

  return {
    title: isMorning
      ? `☀️ Morning Brief — ${data.today}`
      : `🌙 Evening Brief — ${data.today}`,
    color: isMorning ? 0xf59e0b : 0x6366f1,
    fields,
    footer: { text: "Timed Trading • Daily Brief" },
    timestamp: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Brief Generation & Storage
// ═══════════════════════════════════════════════════════════════════════

/**
 * Generate and store a daily brief.
 * @param {object} env - Worker environment
 * @param {"morning"|"evening"} type
 * @param {object} opts - { SECTOR_MAP, d1GetCandles, notifyDiscord }
 */
export async function generateDailyBrief(env, type, opts = {}) {
  const KV = env?.KV_TIMED;
  const db = env?.DB;
  if (!KV) return { ok: false, error: "no_kv" };

  console.log(`[DAILY BRIEF] Generating ${type} brief...`);
  const start = Date.now();

  try {
    // 1. Gather data
    const data = await gatherDailyBriefData(env, type, opts);
    if (data.error) return { ok: false, error: data.error };

    // 2. Build prompt and call AI
    const prompt = type === "morning" ? buildMorningPrompt(data) : buildEveningPrompt(data);
    const content = await callOpenAI(env, ANALYST_SYSTEM_PROMPT, prompt);
    if (!content || content.length < 100) {
      return { ok: false, error: "ai_response_too_short" };
    }

    // 3. Extract ES prediction (look for the prediction line)
    let esPrediction = null;
    const predMatch = content.match(/ES Prediction[:\s]*(.+?)(?:\n|$)/i);
    if (predMatch) esPrediction = predMatch[1].trim();

    // 4. For evening brief, get ES close and score morning prediction
    let esClose = null;
    if (type === "evening" && data.market.ES) {
      esClose = data.market.ES.price;
    }

    const now = Date.now();
    const briefId = `${data.today}-${type}`;

    // 5. Store in KV (current brief)
    const current = (await kvGetJSON(KV, "timed:daily-brief:current")) || {};
    current[type] = {
      id: briefId,
      date: data.today,
      type,
      content,
      esPrediction,
      publishedAt: now,
    };
    await kvPutJSON(KV, "timed:daily-brief:current", current);

    // 6. Update badge timestamp
    await kvPutJSON(KV, "timed:daily-brief:badge", { ts: now, type, date: data.today });

    // 7. Archive in D1
    if (db) {
      await d1EnsureBriefSchema(env);
      await db.prepare(`
        INSERT INTO daily_briefs (id, date, type, content, es_prediction, es_prediction_correct, es_close, published_at, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          es_prediction = excluded.es_prediction,
          es_close = excluded.es_close,
          published_at = excluded.published_at
      `).bind(briefId, data.today, type, content, esPrediction, esClose, now, now).run();
    }

    const elapsed = Date.now() - start;
    console.log(`[DAILY BRIEF] ${type} brief generated in ${elapsed}ms (${content.length} chars)`);

    // 8. Send Discord notification (structured embed)
    if (opts.notifyDiscord) {
      const embed = buildDiscordBriefEmbed(type, data, content, esPrediction);
      await opts.notifyDiscord(env, embed).catch(e =>
        console.warn("[DAILY BRIEF] Discord notification failed:", String(e).slice(0, 100))
      );
    }

    // 9. In-app notification (broadcast to all users)
    if (opts.d1InsertNotification) {
      await opts.d1InsertNotification(env, {
        email: null, type: "daily_brief",
        title: `${type === "morning" ? "Morning" : "Evening"} Brief — ${data.today}`,
        body: esPrediction || `${type === "morning" ? "Morning" : "Evening"} brief published.`,
        link: "/daily-brief.html",
      }).catch(() => {});
    }

    return { ok: true, id: briefId, elapsed, chars: content.length };
  } catch (e) {
    console.error(`[DAILY BRIEF] ${type} generation failed:`, String(e).slice(0, 300));
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/**
 * Cleanup: remove previous day's brief from KV (runs at 3 AM ET).
 * Archives remain in D1.
 */
export async function cleanupDailyBrief(env) {
  const KV = env?.KV_TIMED;
  if (!KV) return;
  try {
    await kvPutJSON(KV, "timed:daily-brief:current", {});
    console.log("[DAILY BRIEF] Cleared current brief (3 AM cleanup)");
  } catch (e) {
    console.warn("[DAILY BRIEF] Cleanup failed:", String(e).slice(0, 100));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// API Helpers (called from index.js route handlers)
// ═══════════════════════════════════════════════════════════════════════

/** GET /timed/daily-brief — returns current brief from KV */
export async function handleGetBrief(env) {
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false, error: "no_kv" };
  const current = (await kvGetJSON(KV, "timed:daily-brief:current")) || {};
  return { ok: true, brief: current };
}

/** GET /timed/daily-brief/badge — returns latest badge timestamp */
export async function handleGetBadge(env) {
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false };
  const badge = (await kvGetJSON(KV, "timed:daily-brief:badge")) || null;
  return { ok: true, badge };
}

/** GET /timed/daily-brief/archive?month=2026-02 — returns past briefs from D1 */
export async function handleGetArchive(env, month) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };
  await d1EnsureBriefSchema(env);

  // If month provided, filter to that month; otherwise last 30 days
  let rows;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    rows = await db.prepare(`
      SELECT id, date, type, es_prediction, es_prediction_correct, es_close, published_at
      FROM daily_briefs
      WHERE date LIKE ?1
      ORDER BY date DESC, type ASC
    `).bind(`${month}%`).all();
  } else {
    rows = await db.prepare(`
      SELECT id, date, type, es_prediction, es_prediction_correct, es_close, published_at
      FROM daily_briefs
      ORDER BY date DESC, type ASC
      LIMIT 60
    `).all();
  }

  return { ok: true, briefs: rows?.results || [] };
}

/** GET /timed/daily-brief/archive/:id — returns a single archived brief */
export async function handleGetArchiveBrief(env, briefId) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };
  await d1EnsureBriefSchema(env);

  const row = await db.prepare(`
    SELECT * FROM daily_briefs WHERE id = ?1
  `).bind(briefId).first();

  return row ? { ok: true, brief: row } : { ok: false, error: "not_found" };
}

/** POST /timed/daily-brief/predict — mark ES prediction as correct/incorrect */
export async function handleMarkPrediction(env, briefId, correct) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };
  await d1EnsureBriefSchema(env);

  const val = correct === "1" || correct === 1 || correct === true ? 1 : 0;
  await db.prepare(`
    UPDATE daily_briefs SET es_prediction_correct = ?1 WHERE id = ?2
  `).bind(val, briefId).run();

  return { ok: true, id: briefId, correct: val };
}
