// Daily Brief module — AI-generated morning & evening market analysis
// Publishes to KV (current brief) and D1 (archive), with Finnhub data enrichment.

import { kvGetJSON, kvPutJSON } from "./storage.js";
import { loadCalendar, isEquityHoliday, isEquityEarlyClose } from "./market-calendar.js";
import { sendDailyBriefEmail, getEmailOptedInUsers } from "./email.js";

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
// Finnhub Market News Integration (replaces Alpaca News)
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
 * Fetch recent economic/market-moving news from Finnhub General News API.
 * Filters for economic data releases and macro events.
 * @returns {Array<{headline, summary, source, created_at, url}>}
 */
export async function fetchFinnhubMarketNews(env, fromDate, toDate) {
  const token = env?.FINNHUB_API_KEY;
  if (!token) {
    console.warn("[FINNHUB NEWS] No API key configured (FINNHUB_API_KEY)");
    return [];
  }
  try {
    const fromTs = Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000);
    const toTs = Math.floor(new Date(`${toDate}T23:59:59Z`).getTime() / 1000);
    const url = `${FINNHUB_BASE}/news?category=general&minId=0&token=${token}`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      console.warn(`[FINNHUB NEWS] Fetch failed: ${resp.status}`);
      return [];
    }
    const news = await resp.json();
    if (!Array.isArray(news)) return [];

    // Filter to date range and economic keywords
    const inRange = news.filter(a => {
      const ts = Number(a.datetime) || 0;
      return ts >= fromTs && ts <= toTs;
    });
    console.log(`[FINNHUB NEWS] ${inRange.length} articles in range (${fromDate} to ${toDate})`);

    const econNews = inRange.filter(article => {
      const text = `${article.headline || ""} ${article.summary || ""}`.toLowerCase();
      return ECON_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
    });

    console.log(`[FINNHUB NEWS] ${econNews.length} economic/macro articles found`);
    return econNews.slice(0, 20).map(a => ({
      headline: a.headline || "",
      summary: (a.summary || "").slice(0, 300),
      source: a.source || "",
      created_at: a.datetime ? new Date(a.datetime * 1000).toISOString() : "",
      url: a.url || "",
    }));
  } catch (e) {
    console.error("[FINNHUB NEWS] Error:", String(e).slice(0, 150));
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
  let [
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
    spyCandles,
    spyCandlesH1,
    spyCandlesM5,
    qqqCandles,
    qqqCandlesH1,
    qqqCandlesM5,
    finnhubEconNews,
    ffToday,
    ffYesterday,
    esCandlesH4,
    nqCandlesH4,
    spyCandlesH4,
    qqqCandlesH4,
    esCandlesW,
    spyCandlesW,
    priceFeedRaw,
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
    // SPY candles (daily, hourly, 5m) — day trader levels alongside ES
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "SPY", "D", 20).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "SPY", "60", 50).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "SPY", "5", 100).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    // QQQ candles (daily, hourly, 5m) — day trader levels alongside NQ
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "QQQ", "D", 20).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "QQQ", "60", 50).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "QQQ", "5", 100).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    // Finnhub economic/macro news (today + yesterday)
    fetchFinnhubMarketNews(env, yesterday, today),
    // ForexFactory economic calendar (today)
    fetchForexFactoryCalendar(env, today),
    // ForexFactory economic calendar (yesterday)
    fetchForexFactoryCalendar(env, yesterday),
    // 4H candles for SMC/ICT analysis (BSL, SSL, FVGs)
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "ES1!", "240", 40).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "NQ1!", "240", 40).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "SPY", "240", 40).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "QQQ", "240", 40).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    // Weekly candles for higher-timeframe SMC levels
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "ES1!", "W", 20).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "SPY", "W", 20).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    // Reliable price feed data (TwelveData via cron) for cross-referencing
    kvGetJSON(KV, "timed:prices").catch(() => null),
  ]);

  // Cross-reference: use timed:prices (cron-updated) to validate/supplement ES/NQ data
  const _pf = (priceFeedRaw?.prices || priceFeedRaw) || {};

  // Validate market data — if scoring payload has stale or absurd data, fix using price feed.
  // ES≠SPY and NQ≠QQQ in price scale, but daily change % IS comparable.
  function validateMarketData(data, ticker, proxyTicker, pf, sameScale) {
    if (!data) return data;
    const price = Number(data.price) || 0;
    const dayPct = Number(data.day_change_pct) || 0;
    const pfExact = pf[ticker];
    const pfProxy = pf[proxyTicker];
    const pfData = (pfExact && Number(pfExact.p) > 0) ? pfExact : pfProxy;
    if (!pfData || !Number(pfData.p)) return data;

    const proxyPct = Number(pfData.dp) || 0;
    const needsFix = price <= 0 || Math.abs(dayPct) > 5;
    const ts = Number(data.ts || data.ingest_ts) || 0;
    const ageH = ts > 0 ? (Date.now() - ts) / 3600000 : 999;
    const isStale = ageH > 24;

    if (needsFix || isStale) {
      const reason = needsFix ? `stale (price=${price}, dayPct=${dayPct}%)` : `${ageH.toFixed(0)}h old`;
      console.log(`[BRIEF] ${ticker} data ${reason}. Using ${proxyTicker} change % from price feed.`);

      // Always safe to copy daily change percentage from the chosen feed source.
      data.day_change_pct = proxyPct;
      data._proxied_from = (pfData === pfExact ? ticker : proxyTicker);
      if (Number.isFinite(Number(pfData.pc)) && Number(pfData.pc) > 0) {
        data.prev_close = Number(pfData.pc);
      }

      if (pfData === pfExact || sameScale) {
        // SPY→SPY, QQQ→QQQ: price scales match, copy price and dollar change
        // Also applies to ES1!/NQ1! when exact futures feed is present.
        data.price = Number(pfData.p);
        data.day_change = Number(pfData.dc) || 0;
      } else {
        // ES→SPY proxy: keep original price if >0, estimate dollar change from %
        if (price > 0) {
          data.day_change = +(price * proxyPct / 100).toFixed(2);
        }
      }
    }
    return data;
  }

  esData  = validateMarketData(esData,  "ES1!", "SPY", _pf, false);
  nqData  = validateMarketData(nqData,  "NQ1!", "QQQ", _pf, false);
  spyData = validateMarketData(spyData, "SPY",  "SPY", _pf, true);
  qqqData = validateMarketData(qqqData, "QQQ",  "QQQ", _pf, true);

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

  console.log(`[ECON] Sources: Finnhub today=${todayEcon.length}, yesterday=${yesterdayEcon.length}, week=${weekEcon.length}, FF today=${ffTodayEvents.length}, FF yesterday=${ffYesterdayEvents.length}, Finnhub news=${(finnhubEconNews || []).length}`);

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

  const esTechnical = summarizeTechnical(
    esCandles?.candles || [], esCandlesH1?.candles || [],
    esCandlesM5?.candles || [], esData, esCandlesH4?.candles || [],
    esCandlesW?.candles || []
  );

  const nqTechnical = summarizeTechnical(
    nqCandles?.candles || [], nqCandlesH1?.candles || [],
    nqCandlesM5?.candles || [], nqData, nqCandlesH4?.candles || [], []
  );

  const spyTechnical = summarizeTechnical(
    spyCandles?.candles || [], spyCandlesH1?.candles || [],
    spyCandlesM5?.candles || [], spyData, spyCandlesH4?.candles || [],
    spyCandlesW?.candles || []
  );

  const qqqTechnical = summarizeTechnical(
    qqqCandles?.candles || [], qqqCandlesH1?.candles || [],
    qqqCandlesM5?.candles || [], qqqData, qqqCandlesH4?.candles || [], []
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

  const extractedEs = extract(esData);
  const esSessionClose = type === "evening"
    ? pickCanonicalSessionClose(today, esCandles?.candles || [], esCandlesM5?.candles || [])
    : { price: null, source: null };

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
      ES: extractedEs ? {
        ...extractedEs,
        sessionClose: esSessionClose.price,
        sessionCloseSource: esSessionClose.source,
      } : null,
      NQ: extract(nqData),
      VIX: extract(vixData),
      SPY: extract(spyData),
      QQQ: extract(qqqData),
      IWM: extract(iwmData),
    },
    esTechnical,
    nqTechnical,
    spyTechnical,
    qqqTechnical,
    sectors,
    todayEarnings,
    weekEarnings: weekEarnings.slice(0, 30), // cap for prompt size
    todayEconomicEvents: todayEcon.slice(0, 10),
    yesterdayEconomicEvents: yesterdayEcon.slice(0, 10),
    economicEvents: weekEcon.slice(0, 15),
    openTrades: openTrades.map(t => ({
      ticker: t.ticker, direction: t.direction, pnlPct: t.pnlPct,
      entryPrice: t.entryPrice, status: t.status,
      setupName: t.setupName || t.setup_name || "",
      setupGrade: t.setupGrade || t.setup_grade || "",
      shares: t.shares || 0,
      riskBudget: t.riskBudget || t.risk_budget || 0,
      trimmedPct: t.trimmedPct || t.trimmed_pct || 0,
      sl: t.sl || t.stop_loss || 0,
      tp: t.tp || t.take_profit || 0,
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
    econNews: (finnhubEconNews || []).slice(0, 10),
    morningPrediction: morningBrief?.es_prediction || null,
    morningContent: type === "evening" ? (morningBrief?.content || "").slice(0, 1500) : null,
    priceFeedCrossRef: buildPriceFeedCrossRef(_pf),
    crossAssetContext: buildCrossAssetContext(_pf),
    priceFeedRaw: _pf,
  };
}

function buildPriceFeedCrossRef(pf) {
  if (!pf || typeof pf !== "object") return "Price feed unavailable.";
  const tickers = ["SPY", "QQQ", "VX1!", "ES1!", "NQ1!", "XLE", "XLK", "XLF", "XLU", "XLP", "XLY", "XLI", "GLD", "TLT", "CL1!", "GC1!", "SI1!", "IWM", "DIA"];
  const lines = [];
  for (const sym of tickers) {
    const d = pf[sym];
    if (!d || !Number(d.p)) continue;
    const price = Number(d.p);
    const pct = Number(d.dp) || 0;
    const chg = Number(d.dc) || 0;
    lines.push(`${sym}: $${price.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%, ${chg >= 0 ? "+" : ""}$${chg.toFixed(2)})`);
  }
  return lines.length > 0 ? lines.join("\n") : "Price feed unavailable.";
}

function buildCrossAssetContext(pf) {
  if (!pf || typeof pf !== "object") return null;
  const assets = {
    "CL1! (Crude Oil)": pf["CL1!"],
    "GC1! (Gold)": pf["GC1!"],
    "SI1! (Silver)": pf["SI1!"],
    "VX1! (VIX Futures)": pf["VX1!"],
    "GLD (Gold ETF)": pf["GLD"],
    "TLT (Long Treasuries)": pf["TLT"],
    "IWM (Russell 2000)": pf["IWM"],
  };
  const lines = [];
  for (const [label, d] of Object.entries(assets)) {
    if (!d || !Number(d.p)) continue;
    const price = Number(d.p);
    const pct = Number(d.dp) || 0;
    const dir = pct > 0.5 ? "rallying" : pct < -0.5 ? "declining" : "flat";
    lines.push(`${label}: $${price.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) — ${dir}`);
  }
  if (lines.length === 0) return null;

  const interp = [];
  const cl = pf["CL1!"];
  const gc = pf["GC1!"];
  const tlt = pf["TLT"];
  const vx = pf["VX1!"];
  if (cl && Math.abs(Number(cl.dp) || 0) > 1.5) {
    interp.push(`Crude oil moving ${Number(cl.dp) > 0 ? "sharply higher — watch XLE for sympathy and inflation/rate path implications" : "sharply lower — potential relief for inflation expectations, watch XLE for downside"}`);
  }
  if (gc && Math.abs(Number(gc.dp) || 0) > 1) {
    interp.push(`Gold ${Number(gc.dp) > 0 ? "bid — classic risk-off signal, watch for rotation out of equities" : "selling off — risk-on appetite may be returning"}`);
  }
  if (tlt && Math.abs(Number(tlt.dp) || 0) > 0.8) {
    interp.push(`Long Treasuries (TLT) ${Number(tlt.dp) > 0 ? "rallying — yields dropping, flight to safety" : "declining — yields rising, watch rate-sensitive tech names"}`);
  }
  if (vx && Number(vx.dp) !== 0) {
    const vxPrice = Number(vx.p);
    if (vxPrice > 25) interp.push(`VIX at ${vxPrice.toFixed(1)} — elevated fear, expect wide swings and mean-reversion setups`);
    else if (vxPrice > 20) interp.push(`VIX at ${vxPrice.toFixed(1)} — caution warranted, ranges expanding`);
    else if (vxPrice < 15) interp.push(`VIX at ${vxPrice.toFixed(1)} — low vol, trend-following works, breakouts tend to be cleaner`);
  }
  if (interp.length) {
    lines.push("");
    lines.push("Interpretation:");
    lines.push(...interp.map(i => `- ${i}`));
  }
  return lines.join("\n");
}

function dailyBriefTsMs(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return Number.isFinite(numeric) ? (numeric > 1e12 ? numeric : numeric * 1000) : null;
    }
    const parsed = Date.parse(trimmed.includes("T") ? trimmed : `${trimmed}T00:00:00Z`);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nyDateKeyFromMs(ms) {
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(ms);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function nyMinutesFromMs(ms) {
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(ms);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

function pickCanonicalSessionClose(targetDate, dailyCandles, intradayCandles) {
  const daily = Array.isArray(dailyCandles) ? dailyCandles : [];
  const intraday = Array.isArray(intradayCandles) ? intradayCandles : [];

  const matchedDaily = daily
    .map((candle) => {
      const tsMs = dailyBriefTsMs(candle?.ts ?? candle?.t ?? candle?.time ?? candle?.date);
      return { candle, tsMs, dateKey: nyDateKeyFromMs(tsMs) };
    })
    .filter((row) => row.dateKey === targetDate)
    .sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0));

  const dailyClose = Number(matchedDaily[matchedDaily.length - 1]?.candle?.c);
  if (Number.isFinite(dailyClose) && dailyClose > 0) {
    return { price: dailyClose, source: "daily_candle_close" };
  }

  const intradayRows = intraday
    .map((candle) => {
      const tsMs = dailyBriefTsMs(candle?.ts ?? candle?.t ?? candle?.time ?? candle?.date);
      return {
        candle,
        tsMs,
        dateKey: nyDateKeyFromMs(tsMs),
        nyMinutes: nyMinutesFromMs(tsMs),
      };
    })
    .filter((row) => row.dateKey === targetDate)
    .sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0));

  const beforeCloseRows = intradayRows.filter((row) => Number.isFinite(row.nyMinutes) && row.nyMinutes <= 16 * 60);
  const canonicalRow = beforeCloseRows[beforeCloseRows.length - 1] || intradayRows[intradayRows.length - 1];
  const intradayClose = Number(canonicalRow?.candle?.c);
  if (Number.isFinite(intradayClose) && intradayClose > 0) {
    return {
      price: intradayClose,
      source: beforeCloseRows.length ? "intraday_rth_close" : "intraday_last_close",
    };
  }

  return { price: null, source: null };
}

// ═══════════════════════════════════════════════════════════════════════
// SMC / ICT Level Detection: Liquidity Sweeps, Fair Value Gaps
// ═══════════════════════════════════════════════════════════════════════

function detectSwingLevels(candles, lookback = 2) {
  if (!candles || candles.length < lookback * 2 + 1) return { bsl: [], ssl: [] };
  const bsl = [], ssl = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = Number(candles[i].h);
    const l = Number(candles[i].l);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    let isSwingHigh = true, isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (Number(candles[i - j].h) >= h || Number(candles[i + j].h) >= h) isSwingHigh = false;
      if (Number(candles[i - j].l) <= l || Number(candles[i + j].l) <= l) isSwingLow = false;
    }
    const rnd = (v) => Math.round(v * 100) / 100;
    if (isSwingHigh) bsl.push({ level: rnd(h), idx: i, ts: Number(candles[i].ts || 0) });
    if (isSwingLow) ssl.push({ level: rnd(l), idx: i, ts: Number(candles[i].ts || 0) });
  }
  return { bsl: bsl.slice(-5), ssl: ssl.slice(-5) };
}

function detectFVGs(candles) {
  if (!candles || candles.length < 3) return { bullish: [], bearish: [] };
  const bullish = [], bearish = [];
  const rnd = (v) => Math.round(v * 100) / 100;
  for (let i = 2; i < candles.length; i++) {
    const curLow = Number(candles[i].l);
    const prevHigh = Number(candles[i - 2].h);
    const curHigh = Number(candles[i].h);
    const prevLow = Number(candles[i - 2].l);
    if (!Number.isFinite(curLow) || !Number.isFinite(prevHigh)) continue;
    if (curLow > prevHigh) {
      bullish.push({ top: rnd(curLow), bottom: rnd(prevHigh), midpoint: rnd((curLow + prevHigh) / 2), idx: i });
    }
    if (curHigh < prevLow) {
      bearish.push({ top: rnd(prevLow), bottom: rnd(curHigh), midpoint: rnd((prevLow + curHigh) / 2), idx: i });
    }
  }
  return { bullish: bullish.slice(-3), bearish: bearish.slice(-3) };
}

function computeSMCLevels(dailyCandles, fourHourCandles, hourlyCandles, weeklyCandles) {
  const result = {};
  const tfMap = { weekly: weeklyCandles, daily: dailyCandles, "4h": fourHourCandles, "1h": hourlyCandles };
  for (const [tf, candles] of Object.entries(tfMap)) {
    if (!candles || candles.length < 5) continue;
    const lookback = tf === "weekly" ? 2 : tf === "daily" ? 2 : 3;
    const swings = detectSwingLevels(candles, lookback);
    const fvgs = detectFVGs(candles);
    result[tf] = { ...swings, fvgs };
  }
  return result;
}

/** Summarize technical structure from candles for any instrument (ES, NQ, etc.) */
function summarizeTechnical(dailyCandles, hourlyCandles, fiveMinCandles, latestData, fourHourCandles, weeklyCandles) {
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

    // Pre-validated game plan targets so the AI doesn't produce impossible combos
    const oHi = overnightRange?.high || curPrice;
    const oLo = overnightRange?.low || curPrice;
    const allBullTargets = fibs.map(f => rnd(anchor + dayAtr * f)).filter(t => t > oHi);
    const allBearTargets = fibs.map(f => rnd(anchor - dayAtr * f)).filter(t => t < oLo);
    atrFibLevels.gamePlan = {
      bullTrigger: rnd(oHi),
      bullTarget: allBullTargets[0] || rnd(anchor + dayAtr * 1.0),
      bearTrigger: rnd(oLo),
      bearTarget: allBearTargets[0] || rnd(anchor - dayAtr * 1.0),
    };
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

  // SMC / ICT Levels: Buyside/Sellside Liquidity + Fair Value Gaps
  const smcLevels = computeSMCLevels(dailyCandles, fourHourCandles, hourlyCandles, weeklyCandles);

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
    smcLevels,
    vixPrice: Number(latestData?.price) || null,
    state: latestData?.state || "",
    phaseZone: latestData?.phase_zone || "",
  };
}

/** Backward compat wrapper for ES */
function summarizeES(dailyCandles, hourlyCandles, latestData) {
  return summarizeTechnical(dailyCandles, hourlyCandles, null, latestData, null);
}

// ═══════════════════════════════════════════════════════════════════════
// AI Prompt Construction & Generation
// ═══════════════════════════════════════════════════════════════════════

const ANALYST_SYSTEM_PROMPT = `You are a senior market strategist writing a daily brief for a community of traders and investors — ranging from experienced professionals to people learning the markets for the first time.

Your PRIMARY audience trades SPY and QQQ. ES (S&P 500 futures) and NQ (Nasdaq futures) are used as proxy references for advanced users — always translate key levels to SPY/QQQ equivalents. VIX (VX1! futures) is always referenced because volatility context tells the larger story.

## Your Communication Style

You write like a trusted mentor: authoritative but approachable. Think professional trader explaining the game plan to a friend over coffee — not a textbook.

**Every technical term gets a plain-English translation on first use:**
- Instead of "BSL at 5950" → write: "**Resistance ceiling at 5950** (this is a recent high where sellers have stepped in before — in trader jargon, 'buyside liquidity')"
- Instead of "SSL at 5800" → write: "**Support floor at 5800** (this is a recent low where buyers have shown up — traders call this 'sellside liquidity')"
- Instead of "Bullish FVG at 5850-5880" → write: "**Unfilled gap between 5850-5880** (price moved so fast it left a gap — these gaps often get 'filled' as price comes back to test them)"
- After the first explanation, you can use the short form (e.g., "the 5950 resistance ceiling") without re-explaining

**ALWAYS include the timeframe** when referencing any level:
- "On the daily chart, the key resistance ceiling is 5950"
- "The 4-hour chart shows an unfilled gap between 5850-5880"
- "On the weekly chart, the broader support floor sits at 5700"
- NEVER reference a level without specifying which timeframe it comes from (Daily, 4H, 1H, Weekly)

## Analysis Framework

1. **Lead with the story** — What is the market backdrop? What's driving price? Risk factors and macro context come FIRST. Paint the picture before diving into levels.
2. **Then show market reaction** — How are SPY, QQQ, and VIX responding to this backdrop? What does volatility tell us?
3. **Then present the plan** — Clear, conditional action plan. "If SPY holds above X, look for Y. If it breaks below X, expect Z."

Your analysis style:
- **Conditional**: "If SPY holds above X, then Y is the next target. If it breaks below X, expect Z." Always give both scenarios.
- **Specific**: Every claim has a price level attached. Never say "market may go higher" — say "SPY could rally toward the 590-593 zone."
- **Time-aware**: "Near-term weakness into March 10 before a potential bounce" — give a timeline, not just direction.
- **Contextual**: Zoom out to the larger trend first. If the market has been selling off for 5 days, LEAD with that reality.
- **Non-redundant**: State ATR fib levels once in the Day Trader section. In the Structure section, focus on swing levels and key zones. Each section adds unique value.

## SPY/QQQ Focus (CRITICAL)
- SPY and QQQ are the PRIMARY instruments. All key levels, scenarios, and action plans should be stated in SPY/QQQ terms first.
- ES/NQ (futures) are secondary — mention them as "for futures traders, the equivalent ES level is X" or in a compact futures reference section.
- Do NOT lead with ES/NQ analysis and then translate to SPY/QQQ. Lead with SPY/QQQ and optionally note futures equivalents.

## SPY/QQQ Hyper-Profile (DATA-BACKED — use these real statistics to contextualize guidance)

### SPY Behavioral DNA
- **Daily Range**: Average 1.14% ($7.05). Median 0.88%. In high-vol regimes, ranges expand to 1.89x normal (avg range ~1.88%).
- **ATR(14)**: Typically $8-10. When elevated above $10, expect wider intraday swings.
- **Gap Behavior**: Gaps fill same-day 56.5% of the time. Large gaps (>0.3%) fill only 34-46%. Gap-down days close above their open 62% of the time (strong gap-fade tendency for shorts).
- **Intraday Structure**: First hour captures 61% of daily range. First-hour direction predicts the day's direction 85% of the time. Activity decays sharply into the 12-1pm lunch lull (range drops 50% from open). Last hour (3pm) shows slight positive bias.
- **Hourly Sweet Spots**: 9:30-10:30 ET is the action zone (0.60% avg range). 10-11 AM often sees continuation. 12-2 PM is dead zone. 3-4 PM can see late squeezes.
- **Day-of-Week**: Monday is strongest (+0.36%, 70% win rate). Thursday is weakest (-0.23%). Wednesday has widest ranges.
- **After Big Moves**: After a >1% down day, next day averages +0.80% with 76% win rate (strong mean-reversion bounce). After a >1% up day, next day is still slightly positive (+0.10%).
- **Calendar**: Last 3 days of month slightly negative. March historically weakest (37% win rate). May-June strongest stretch.
- **Streaks**: Average winning streak 2.3 days, losing streak 1.9 days. Max winning streak 9 days.

### QQQ Behavioral DNA
- **Daily Range**: Average 1.46% ($8.02). 1.28x wider than SPY. In high-vol, ranges expand similarly.
- **Beta to SPY**: 1.16. Correlation 0.97. Same-direction days: 91%. QQQ has the bigger move 76% of those days.
- **Gap Behavior**: Gaps fill 53% same-day. Gap-down fade tendency: 59% close above open.
- **Intraday Structure**: First hour captures 67% of daily range. First-hour direction predicts day 81%. Even more front-loaded than SPY.
- **Big Move Amplification**: On SPY >+1% days, QQQ amplifies 1.20x. On SPY <-1% days, QQQ amplifies 1.21x. Tech fear drives QQQ harder on down days.
- **Day-of-Week**: Monday strongest (+0.51%, 70% WR). Thursday weakest (-0.29%). Wednesday has widest ranges (1.62%).
- **When QQQ leads SPY higher**: Risk-on signal — institutional money rotating into growth/tech. When QQQ lags: defensive rally, be cautious with longs.

### Futures Proxy Translation
- **ES (S&P 500 futures)**: Tracks SPY almost 1:1 but trades 23 hours/day. Overnight ES moves set the gap for SPY at open. ES levels = SPY × 10 (approximately).
- **NQ (Nasdaq futures)**: Tracks QQQ. NQ levels ≈ QQQ × 40. NQ is the "fear amplifier" — when NQ gaps down hard pre-market, expect QQQ weakness at open.
- **SPX**: Cash index, not directly tradeable. Use for level references when options traders reference strike prices.

### Day-Trader Translation Rules
- ALWAYS state the expected ATR-based range: "SPY's 14-day ATR is $X, implying a $LOW-$HIGH range from yesterday's close of $Y"
- Reference the first-hour predictive power: "If SPY holds above $X by 10:30 AM, history says the day closes in that direction 85% of the time"
- After big down days (>1%), explicitly note the mean-reversion setup: "After yesterday's -X% drop, SPY has historically bounced +0.8% the next day with 76% probability"
- Note the Monday strength bias when applicable
- In high-vol regimes, warn traders to widen their targets and stops: "With ATR elevated at $X, expect a wider-than-normal $Y range today"

## Phase Completion Context
When the Timed Trading model shows a "Phase" percentage for SPY or QQQ:
- Phase < 25%: Early in the move — trend-following setups are highest probability.
- Phase 25-50%: Move is building momentum — look for pullback entries to join the trend.
- Phase 50-75%: Move is maturing — tighten stops, look for trim opportunities.
- Phase > 75%: Extended — expect mean reversion. Fade signals become valid.
Reference Phase when discussing whether to initiate new positions or tighten existing ones.

## Active Position Guidance (CRITICAL)
When open trades are provided, you MUST discuss each one:
- Is the thesis still intact based on today's price action?
- What should the trader watch for: hold, trim, or exit?
- Reference the trade's setup grade (Prime/Confirmed/Early) — Prime setups deserve more patience.
- If P&L is significantly positive (>2%), suggest whether to lock in partial profits.
- If P&L is negative, assess whether the stop level is still appropriate.

## VIX / Volatility Context (ALWAYS INCLUDE)
- VIX is your best friend — it tells the larger story. ALWAYS reference VIX levels and what they imply:
  - VIX below 15: Low fear, trend-following works, breakouts are clean
  - VIX 15-20: Normal caution, ranges expand, be selective
  - VIX 20-25: Elevated anxiety, expect wider swings, reduce size
  - VIX above 25: Fear mode, mean-reversion plays, gap-and-go setups
  - Rising VIX + falling SPY: Classic risk-off, expect continued pressure
  - Falling VIX + rising SPY: Risk-on, lean bullish
  - VIX divergence (VIX falling while SPY drops): Market is not panicking yet, may be short-term

Writing Guidelines:
- Write in a professional yet accessible style with clear section headers using markdown ##
- Reference specific price levels, percentages, and zones
- CRITICAL: ALL economic data values (CPI, PPI, GDP, etc.) MUST use EXACTLY two decimal places (e.g., 2.40%, 0.30%)
- Logic: Bearish scenarios must target prices LOWER than the trigger level. Bullish scenarios must target HIGHER.
- Keep total length to 2000-3000 words
- Do NOT use emojis
- CRITICAL FORMATTING: Use proper markdown with BLANK LINES before every ## and ### header. Use bullet lists (- item) on separate lines. Output is rendered via markdown parser.
- For earnings: ALWAYS include current price and daily change, e.g., "ESNT ($148.52, +1.30%)"
- For macro events: Explain the IMPACT — what it means for the average trader, not just the data point

Timed Trading Scoring Model Reference (ALWAYS reference these signals):
- **state**: LONG (bullish setup), SHORT (bearish setup), WATCH (neutral), or FLAT (no signal)
- **htf_score**: Higher-Timeframe score (0-100). Above 65 = strong bullish trend, below 40 = bearish pressure
- **ltf_score**: Lower-Timeframe score (0-100). Divergence between HTF and LTF indicates potential reversals
- **phase_zone**: Market phase — "markup" (trending up), "distribution" (topping), "markdown" (trending down), "accumulation" (bottoming), "recovery" (early reversal)
- **phase_pct**: How far along the current move is (0% = just started, 100% = fully extended). Use this to calibrate risk.
- **rank**: Ticker strength relative to universe (higher = stronger)
- **flags**: Active signals — golden_gate_up/down, supertrend_flip, ema_cross, rs_new_high, accum_zone, st_flip_bull/bear, rsi_div_bull/bear, momentum_elite, squeeze_release
- **setup_grade**: Trade quality grading — "Prime" (highest confidence, full alignment), "Confirmed" (solid setup, standard management), "Early" (speculative, tighter management)
- **liquidity zones**: Buyside (resistance ceilings where longs target) and Sellside (support floors where shorts target) detected on 4H, Daily, Weekly charts

CRITICAL: Reference scoring model signals (state, HTF/LTF scores, phase zone, phase_pct) when analyzing direction. When HTF is strong but LTF is weak (or vice versa), discuss the divergence. When phase_pct is above 75%, note the extended nature of the move.

## ANTI-HALLUCINATION RULES (ABSOLUTE — NEVER VIOLATE):
1. **ONLY use numbers from the provided data.** If a field is null, 0, or missing — say "data unavailable."
2. **NEVER fabricate percentage changes.** Use the Multi-Day Change Summary. A normal session move for SPY is 0.3-1.5%. Moves >3% are rare — flag them or check against Price Feed.
3. **NEVER invent specific price levels** that aren't in the technical data.
4. **NEVER fabricate narratives.** If no news headlines are provided, say so. Do NOT invent events.
5. **Cross-reference check**: If Market Data and Price Feed disagree by >1%, trust Price Feed values.
6. **Sanity bounds**: SPY daily moves >3% and QQQ >4% are rare. Flag or verify.

## Cross-Asset Correlation (Newton-Style — CRITICAL)
ALWAYS connect the dots across asset classes. Don't just describe equity price action in isolation — show the web of causation:

- **Crude Oil (CL1!) → Equities**: Crude spikes → XLE rallies, but inflation fears pressure tech. Crude drops → potential relief for rate-sensitive growth. If crude is making a notable move (>1.5%), LEAD with it and explain the equity impact.
- **Gold (GC1!, GLD) → Risk Sentiment**: Gold rallying = risk-off flows. "Gold pushing toward $2,350 suggests the market is seeking safety — not a great environment for aggressive equity longs." If gold is dropping, it signals risk appetite returning.
- **Treasury Yields (TLT proxy) → Tech/Growth**: TLT rallying = yields falling = good for growth/tech. TLT selling off = yields rising = pressure on long-duration assets. Always note the direction and equity implication.
- **VIX → Position Sizing**: Always reference VIX as it contextualizes EVERYTHING. A breakout with VIX at 14 is a very different trade than a breakout with VIX at 28.
- **US Dollar**: Stronger dollar = headwind for multinationals and commodities. Weaker dollar = tailwind for EM-exposed names and commodity plays.
- **Breadth**: Count sectors green vs red. Narrow leadership (only tech green) vs broad-based (8/11 green). Say so explicitly — breadth confirms or denies the move.
- **Safe haven vs risk-on rotation**: Defensive sectors (XLU, XLP) outperforming vs cyclicals (XLI, XLF, XLY) outperforming. This tells the story of what type of money is flowing.
- **Be specific**: "Crude oil reversing off $82 with a hammer on the 4H chart — if this holds, expect XLE to stabilize and some relief for SPY near 585." Not just "oil is moving."
- **Pattern callouts**: When a correlated asset forms a notable technical pattern (Ichimoku cloud test, Fibonacci retracement, candlestick reversal), NAME the pattern with timeframe and level.`;

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

function formatSMCForPrompt(smcLevels) {
  if (!smcLevels || Object.keys(smcLevels).length === 0) return "No SMC data available.";
  const parts = [];
  for (const [tf, data] of Object.entries(smcLevels)) {
    const tfLabel = tf === "weekly" ? "Weekly chart" : tf === "daily" ? "Daily chart" : tf === "4h" ? "4-Hour chart" : "1-Hour chart";
    const lines = [`${tfLabel}:`];
    if (data.bsl?.length > 0) {
      lines.push(`  Resistance Ceilings (BSL — recent highs where selling pressure may return): ${data.bsl.map(s => s.level).join(", ")}`);
    }
    if (data.ssl?.length > 0) {
      lines.push(`  Support Floors (SSL — recent lows where buying interest may appear): ${data.ssl.map(s => s.level).join(", ")}`);
    }
    if (data.fvgs?.bullish?.length > 0) {
      lines.push(`  Unfilled Gap Below (Bullish FVG — price may dip to fill this zone): ${data.fvgs.bullish.map(f => `${f.bottom}-${f.top}`).join(", ")}`);
    }
    if (data.fvgs?.bearish?.length > 0) {
      lines.push(`  Unfilled Gap Above (Bearish FVG — price may rally to fill this zone): ${data.fvgs.bearish.map(f => `${f.bottom}-${f.top}`).join(", ")}`);
    }
    if (lines.length > 1) parts.push(lines.join("\n"));
  }
  return parts.length > 0 ? parts.join("\n") : "No significant levels detected.";
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

## Price Feed Cross-Reference (TwelveData cron — GROUND TRUTH for daily changes):
${data.priceFeedCrossRef || "Unavailable."}
NOTE: If Market Data and Price Feed disagree on daily change by >1%, trust the Price Feed values. The scoring model payload may be stale from backtesting.

## Cross-Asset Context (USE for Newton-style correlated analysis):
${data.crossAssetContext || "Not available — skip cross-asset section."}
IMPORTANT: If crude, gold, TLT, or VIX are making notable moves (>1%), LEAD with the cross-asset story and explain the equity implications.

## Timed Trading Scoring Model Signals (MUST reference in your analysis):
${Object.entries(data.market).filter(([, v]) => v).map(([sym, v]) => {
  const parts = [`${sym}: State=${v.state || "N/A"}, HTF=${v.htf_score}, LTF=${v.ltf_score}, Phase=${v.phase_zone || "N/A"}, Rank=${v.rank}`];
  if (v.flags && Object.keys(v.flags).length > 0) parts.push(`Flags=[${Object.entries(v.flags).filter(([,f]) => f).map(([k]) => k).join(", ")}]`);
  return parts.join(", ");
}).join("\n")}

## Multi-Day Change Summary (USE THESE for "dropped X% over Y sessions" statements):
${(() => {
  const _summaries = [];
  for (const [_lbl, _tech] of [["ES", data.esTechnical], ["NQ", data.nqTechnical], ["SPY", data.spyTechnical], ["QQQ", data.qqqTechnical]]) {
    if (!_tech?.structureContext) continue;
    const _sc = _tech.structureContext;
    const _mk = data.market?.[_lbl];
    const _dp = _mk?.dayChangePct;
    _summaries.push(_lbl + ": Today=" + (typeof _dp === "number" ? (_dp >= 0 ? "+" : "") + _dp.toFixed(2) + "%" : "N/A") + " | 5-day=" + (_sc.fiveDayChangePct != null ? (_sc.fiveDayChangePct >= 0 ? "+" : "") + _sc.fiveDayChangePct.toFixed(2) + "% ($" + (_sc.fiveDayChange ?? "N/A") + ")" : "N/A") + " | Trend=" + (_sc.trendBias || "N/A") + " | 10d-range: $" + (_sc.tenDaySwingLow ?? "?") + "-$" + (_sc.tenDaySwingHigh ?? "?"));
  }
  return _summaries.length > 0 ? _summaries.join("\n") : "Unavailable.";
})()}
IMPORTANT: When stating "X dropped Y% over Z sessions", use the 5-day values above. For single-day moves, use the Today value. NEVER estimate or calculate percentages yourself.

## ES Technical Summary (futures; use for ES and approximate SPX — same scale):
${JSON.stringify(data.esTechnical, null, 1)}

## NQ Technical Summary (futures):
${JSON.stringify(data.nqTechnical, null, 1)}

## SPY Technical Summary (ETF — day trader levels alongside ES/SPX):
${JSON.stringify(data.spyTechnical, null, 1)}

## QQQ Technical Summary (ETF — day trader levels alongside NQ):
${JSON.stringify(data.qqqTechnical, null, 1)}

## PRE-VALIDATED Game Plan (USE THESE EXACT TRIGGERS & TARGETS):
${(() => {
  const gp = data.esTechnical?.atrFibLevels?.gamePlan;
  if (!gp) return "No game plan available — use SSL/BSL levels instead.";
  return `ES Bullish: If price opens above ${gp.bullTrigger} and holds → target ${gp.bullTarget}
ES Bearish: If price breaks below ${gp.bearTrigger} → target ${gp.bearTarget}`;
})()}
${(() => {
  const gp = data.nqTechnical?.atrFibLevels?.gamePlan;
  if (!gp) return "";
  return `NQ Bullish: If price opens above ${gp.bullTrigger} and holds → target ${gp.bullTarget}
NQ Bearish: If price breaks below ${gp.bearTrigger} → target ${gp.bearTarget}`;
})()}

## Key Levels — Support Floors & Resistance Ceilings:
These levels come from recent price swings and gaps on different timeframes. ALWAYS state the timeframe when referencing them.
- "Resistance Ceilings" = recent highs where sellers stepped in (BSL in trader jargon). Price may stall or reverse here.
- "Support Floors" = recent lows where buyers appeared (SSL). Price may bounce here.
- "Unfilled Gaps" (FVGs) = zones where price moved too fast and left a gap. These gaps often get "filled" as price returns to test them.

### SPY Key Levels:
${formatSMCForPrompt(data.spyTechnical?.smcLevels)}

### QQQ Key Levels:
${formatSMCForPrompt(data.qqqTechnical?.smcLevels)}

### ES Key Levels (for futures traders):
${formatSMCForPrompt(data.esTechnical?.smcLevels)}

### NQ Key Levels (for futures traders):
${formatSMCForPrompt(data.nqTechnical?.smcLevels)}

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

## Market-Moving News Headlines:
${(data.econNews || []).length > 0
    ? data.econNews.map(n => `- [${(n.created_at || "").slice(0, 16)}] ${n.headline}${n.summary ? " — " + n.summary.slice(0, 150) : ""}`).join("\n")
    : "No major economic/macro news headlines found."}

## Active Trader — Open Positions:
${data.openTrades.length > 0
    ? data.openTrades.map(t => {
        const _pf = data.priceFeedRaw || {};
        const _td = _pf[t.ticker] || {};
        const _dayPct = Number(_td.dp) || 0;
        const _price = Number(_td.p) || 0;
        const _setup = t.setupName || "N/A";
        const _grade = t.setupGrade || "N/A";
        const _shares = Number(t.shares) || 0;
        const _trimPct = Number(t.trimmedPct) || 0;
        const _sl = Number(t.sl) || 0;
        const _tp = Number(t.tp) || 0;
        return `${t.ticker} (${t.direction}, Setup: ${_setup}, Grade: ${_grade}, Entry: $${t.entryPrice ?? "N/A"}, Current: $${_price > 0 ? _price.toFixed(2) : "N/A"}, Today: ${_dayPct !== 0 ? (_dayPct >= 0 ? "+" : "") + _dayPct.toFixed(2) + "%" : "N/A"}, P&L: ${t.pnlPct != null ? t.pnlPct.toFixed(1) + "%" : "N/A"}, Shares: ${_shares > 0 ? Math.round(_shares) : "N/A"}${_trimPct > 0 ? `, Trimmed: ${Math.round(_trimPct * 100)}%` : ""}${_sl > 0 ? `, SL: $${_sl.toFixed(2)}` : ""}${_tp > 0 ? `, TP: $${_tp.toFixed(2)}` : ""})`;
      }).join("\n")
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
    ? data.investorPositions.map(p => {
        const _pf = data.priceFeedRaw || {};
        const _td = _pf[p.ticker] || {};
        const _dayPct = Number(_td.dp) || 0;
        const _price = Number(_td.p) || 0;
        const _unrealPct = (_price > 0 && p.avgEntry > 0) ? ((_price - p.avgEntry) / p.avgEntry * 100).toFixed(1) : null;
        return `${p.ticker}: ${p.shares} shares @ avg $${p.avgEntry != null ? p.avgEntry.toFixed(2) : "N/A"} (Current: $${_price > 0 ? _price.toFixed(2) : "N/A"}, Today: ${_dayPct !== 0 ? (_dayPct >= 0 ? "+" : "") + _dayPct.toFixed(2) + "%" : "N/A"}, Total Return: ${_unrealPct ? (_unrealPct >= 0 ? "+" : "") + _unrealPct + "%" : "N/A"}, Stage: ${p.stage || "N/A"}${p.thesis ? `, Thesis: ${p.thesis.slice(0, 80)}` : ""})`;
      }).join("\n")
    : "No investor positions."}

## Required Sections (IN THIS ORDER):

1. **Risk Factors & Market Backdrop** — LEAD WITH THIS. What is the backdrop story? What should traders be aware of BEFORE they look at charts?
   - If there's a major economic release today (CPI, PPI, NFP, FOMC, GDP): explain what it means in plain English. "CPI came in at 2.40% vs the expected 2.30% — that means inflation is running slightly hotter than Wall Street expected, which makes it less likely the Fed will cut rates soon. That's typically bad for stocks."
   - If yesterday had a major release, discuss lingering impact.
   - List key upcoming events this week that could move markets.
   - If news headlines mention geopolitical risks, tariffs, policy changes — explain the potential market impact.
   - State the macro regime clearly: "We are in a risk-off environment where traders are selling stocks and buying safe havens" or "The trend is bullish and dips are being bought."
   - REMINDER: ONLY cite data from the provided sections. If no news headlines are available, say so.

2. **Cross-Asset Correlation & Volatility** — Connect the dots BEFORE diving into equities:
   - **VIX Check**: ALWAYS start with where VIX is and what it tells us. "VIX at 18 suggests moderate anxiety — expect wider-than-normal intraday swings."
   - **Cross-Asset Moves**: If crude oil, gold, TLT (treasuries), or other correlated assets are making notable moves, LEAD with them. "Crude oil rallying 2.3% off $80 support with an intraday hammer pattern — this is driving XLE higher and taking pressure off SPY." Be specific: name the pattern, level, and equity implication.
   - **SPY & QQQ snapshot**: Where did they close? How are they trading pre-market? What's the multi-day trend?
   - **Breadth**: Count sectors green vs red. Is the move broad-based or concentrated? "Only 2 of 11 sectors are green today — this is a broad selloff."
   - **Intermarket Flows**: XLE moves = crude. XLU/XLP leading = defensive rotation. XLF leading = rate play. GLD bid = risk-off. TLT rallying = yields dropping.

3. **Structure & Scenario Analysis (SPY & QQQ)** — The technical heart of the brief. Analyze in SPY/QQQ terms FIRST:
   - **Where are we in the bigger picture?** Is this a pullback within an uptrend? A breakdown? A consolidation?
   - **Key Zones** (not single levels — zones): "SPY has support in the 580-583 zone where buyers showed up last week" or "QQQ faces resistance at 490-495 where it stalled twice before"
   - **Support Floors & Resistance Ceilings**: Reference the levels from the data. ALWAYS state the timeframe. "On the daily chart, the support floor sits at 580 — this is a recent swing low where buyers stepped in. If SPY drops below this level, it could accelerate lower toward the 4-hour chart support at 575."
   - **Unfilled Gaps**: If FVGs exist, note them with timeframe. "The 4-hour chart shows an unfilled gap between 585-588 — price may dip to test this zone before continuing higher."
   - **Bull Case**: "If SPY holds above 583 and pushes through 590, the next target is the 595-598 zone."
   - **Bear Case**: "If SPY breaks below 580, expect a move toward 573-575 where the next support floor sits."
   - **Base Case**: Your most probable scenario. "My base case: SPY tests the 580-583 support zone, finds buyers, and works its way back toward 590 by end of week."
   - **For futures traders**: Briefly note equivalent ES/NQ levels: "For futures traders: the SPY 583 support translates to approximately ES 5830."

4. **Day Trader Levels & Game Plan** — Specific numbers for today's session:
   - **SPY Levels**: ATR Fib levels (38.2%, 50%, 61.8%, 100%) above and below yesterday's close. These define today's intraday playing field.
   - **QQQ Levels**: Same treatment.
   - **For Futures Traders**: ES and NQ ATR Fib levels in a compact section.
   - **Golden Gate Status**: If price crossed the 38.2% ATR level, call it out — "SPY opened strong, already above the 38.2% level — next targets are 50% and 61.8%."
   - **Game Plan**: Use the PRE-VALIDATED triggers and targets translated to SPY/QQQ.
     - ABSOLUTE RULE: Bearish targets MUST be LOWER than bearish triggers. Bullish targets MUST be HIGHER than bullish triggers.
   - **Key Liquidity Levels**: Support floors and resistance ceilings from the key levels data, WITH timeframes.
   - Note any major data release timing that could cause volatility spikes.

5. **Earnings Watch** — Key earnings today and this week. Include current price and daily change for each ticker.

6. **Sector & Cross-Asset Spotlight** — Which sectors are leading/lagging and WHY?
   - Map moves to macro drivers. "XLE up because crude is rallying on supply concerns." "XLU outperforming suggests traders are rotating to safety."
   - Breadth assessment: broad or narrow participation?

7. **Trader's Almanac** — Seasonal patterns, OPEX effects, historical tendencies.

8. **Active Trader Book** — MUST include daily change% for each ticker mentioned:
   - Open positions: For each trade, include: ticker, direction, setup name, grade (Prime/Confirmed/Early), entry price, current price, today's change%, total P&L, shares, SL/TP if available. For each:
     - Is the thesis still intact based on today's action?
     - What should the trader do: hold, prepare to trim, or tighten stops?
     - Prime grade setups deserve more patience; Early grade setups should be managed tighter.
   - New entries: What setup triggered it? What grade? How many shares?
   - Yesterday's exits: Winners or losers? What was the exit reason?
   - Trims/Defends: Risk management logic.
   - IMPORTANT: For each ticker, always note TODAY'S daily change% so traders can see how their positions are moving right now.

9. **Investor Portfolio** — MUST include daily change% and total return for each holding:
   - Each holding: ticker, shares, avg entry, current price, today's change%, total return%, stage, thesis status.
   - Any DCA opportunities? Any thesis changes?
   - IMPORTANT: Make this visually rich with callouts. "AAPL ($185.50, +1.20% today, +15.3% total return) — thesis intact."

End with FOUR clear sections:
- **Swing Trader Takeaway**: Actionable SPY/QQQ levels: "Looking to buy SPY dips at 580-583 for a rally to 590." Include a TIME target: "into end of week."
- **ES Prediction**: One specific, falsifiable prediction for ES. Include expected range.
- **Key Levels to Watch (SPY)**: The 3-5 most important SPY levels. For each, explain what happens there in plain English: "580 — Support floor (daily chart). If SPY holds here, buyers are in control. Below 580, expect acceleration to 573."
- **Risk Factors**: 1-2 key risks. Explain them so anyone can understand: "If the inflation report comes in hot, the Fed is less likely to cut rates, which would pressure stocks lower."`;
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

## Price Feed Cross-Reference (TwelveData cron — GROUND TRUTH for daily changes):
${data.priceFeedCrossRef || "Unavailable."}
NOTE: If Market Close Data and Price Feed disagree on daily change by >1%, trust the Price Feed values. The scoring model payload may be stale from backtesting.

## Cross-Asset Context (USE for Newton-style correlated analysis):
${data.crossAssetContext || "Not available — skip cross-asset section."}
IMPORTANT: If crude, gold, TLT, or VIX made notable moves today (>1%), highlight the cross-asset story and explain how it drove or correlated with equity action.

## Timed Trading Scoring Model Signals at Close (MUST reference in your analysis):
${Object.entries(data.market).filter(([, v]) => v).map(([sym, v]) => {
  const parts = [`${sym}: State=${v.state || "N/A"}, HTF=${v.htf_score}, LTF=${v.ltf_score}, Phase=${v.phase_zone || "N/A"}, Rank=${v.rank}`];
  if (v.flags && Object.keys(v.flags).length > 0) parts.push(`Flags=[${Object.entries(v.flags).filter(([,f]) => f).map(([k]) => k).join(", ")}]`);
  return parts.join(", ");
}).join("\n")}

## Multi-Day Change Summary (USE THESE for "dropped X% over Y sessions" statements):
${(() => {
  const _s2 = [];
  for (const [_l2, _t2] of [["ES", data.esTechnical], ["NQ", data.nqTechnical], ["SPY", data.spyTechnical], ["QQQ", data.qqqTechnical]]) {
    if (!_t2?.structureContext) continue;
    const _c2 = _t2.structureContext;
    const _m2 = data.market?.[_l2];
    const _d2 = _m2?.dayChangePct;
    _s2.push(_l2 + ": Today=" + (typeof _d2 === "number" ? (_d2 >= 0 ? "+" : "") + _d2.toFixed(2) + "%" : "N/A") + " | 5-day=" + (_c2.fiveDayChangePct != null ? (_c2.fiveDayChangePct >= 0 ? "+" : "") + _c2.fiveDayChangePct.toFixed(2) + "% ($" + (_c2.fiveDayChange ?? "N/A") + ")" : "N/A") + " | Trend=" + (_c2.trendBias || "N/A"));
  }
  return _s2.length > 0 ? _s2.join("\n") : "Unavailable.";
})()}
IMPORTANT: When stating "X dropped Y% over Z sessions", use the 5-day values above. For single-day moves, use the Today value. NEVER estimate or calculate percentages yourself.

## ES Technical Summary (futures; use for ES and approximate SPX — same scale):
${JSON.stringify(data.esTechnical, null, 1)}

## NQ Technical Summary (futures):
${JSON.stringify(data.nqTechnical, null, 1)}

## SPY Technical Summary (ETF — day trader levels alongside ES/SPX):
${JSON.stringify(data.spyTechnical, null, 1)}

## QQQ Technical Summary (ETF — day trader levels alongside NQ):
${JSON.stringify(data.qqqTechnical, null, 1)}

## Key Levels — Support Floors & Resistance Ceilings:
ALWAYS state the timeframe when referencing levels. SPY/QQQ first, then futures equivalents.

### SPY Key Levels:
${formatSMCForPrompt(data.spyTechnical?.smcLevels)}

### QQQ Key Levels:
${formatSMCForPrompt(data.qqqTechnical?.smcLevels)}

### ES Key Levels (for futures traders):
${formatSMCForPrompt(data.esTechnical?.smcLevels)}

### NQ Key Levels (for futures traders):
${formatSMCForPrompt(data.nqTechnical?.smcLevels)}

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

## Market-Moving News Headlines:
${(data.econNews || []).length > 0
    ? data.econNews.map(n => `- [${(n.created_at || "").slice(0, 16)}] ${n.headline}${n.summary ? " — " + n.summary.slice(0, 150) : ""}`).join("\n")
    : "No major economic/macro news headlines found."}

## After-Hours Earnings:
${data.todayEarnings.filter(e => e.hour === "amc").length > 0
    ? data.todayEarnings.filter(e => e.hour === "amc").map(e => `${e.symbol}: EPS Est: ${e.epsEstimate ?? "N/A"}${e.epsActual != null ? `, EPS Actual: ${e.epsActual}` : ", Results pending"}, Rev Est: ${e.revenueEstimate ? "$" + (e.revenueEstimate / 1e9).toFixed(1) + "B" : "N/A"}${e.revenueActual ? `, Rev Actual: $${(e.revenueActual / 1e9).toFixed(1)}B` : ""}`).join("\n")
    : "No major after-hours earnings today."}

## Active Trader — Open Positions (EOD):
${data.openTrades.length > 0
    ? data.openTrades.map(t => {
        const _pf = data.priceFeedRaw || {};
        const _td = _pf[t.ticker] || {};
        const _dayPct = Number(_td.dp) || 0;
        const _price = Number(_td.p) || 0;
        const _setup = t.setupName || "N/A";
        const _grade = t.setupGrade || "N/A";
        const _shares = Number(t.shares) || 0;
        const _trimPct = Number(t.trimmedPct) || 0;
        const _sl = Number(t.sl) || 0;
        const _tp = Number(t.tp) || 0;
        return `${t.ticker} (${t.direction}, Setup: ${_setup}, Grade: ${_grade}, Entry: $${t.entryPrice ?? "N/A"}, Close: $${_price > 0 ? _price.toFixed(2) : "N/A"}, Today: ${_dayPct !== 0 ? (_dayPct >= 0 ? "+" : "") + _dayPct.toFixed(2) + "%" : "N/A"}, P&L: ${t.pnlPct != null ? t.pnlPct.toFixed(1) + "%" : "N/A"}, Shares: ${_shares > 0 ? Math.round(_shares) : "N/A"}${_trimPct > 0 ? `, Trimmed: ${Math.round(_trimPct * 100)}%` : ""}${_sl > 0 ? `, SL: $${_sl.toFixed(2)}` : ""}${_tp > 0 ? `, TP: $${_tp.toFixed(2)}` : ""})`;
      }).join("\n")
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
    ? data.investorPositions.map(p => {
        const _pf = data.priceFeedRaw || {};
        const _td = _pf[p.ticker] || {};
        const _dayPct = Number(_td.dp) || 0;
        const _price = Number(_td.p) || 0;
        const _unrealPct = (_price > 0 && p.avgEntry > 0) ? ((_price - p.avgEntry) / p.avgEntry * 100).toFixed(1) : null;
        return `${p.ticker}: ${p.shares} shares @ avg $${p.avgEntry != null ? p.avgEntry.toFixed(2) : "N/A"} (Close: $${_price > 0 ? _price.toFixed(2) : "N/A"}, Today: ${_dayPct !== 0 ? (_dayPct >= 0 ? "+" : "") + _dayPct.toFixed(2) + "%" : "N/A"}, Total Return: ${_unrealPct ? (_unrealPct >= 0 ? "+" : "") + _unrealPct + "%" : "N/A"}, Stage: ${p.stage || "N/A"}${p.thesis ? `, Thesis: ${p.thesis.slice(0, 80)}` : ""})`;
      }).join("\n")
    : "No investor positions."}

## Required Sections (IN THIS ORDER):

1. **Risk Factors & Session Backdrop** — LEAD WITH THIS. What drove today's session from a macro perspective?
   - If there was a major economic release today: explain the numbers vs consensus in plain English. "CPI came in at 2.40% vs the expected 2.30% — inflation running hotter than expected, making rate cuts less likely."
   - Geopolitical developments, tariff changes, Fed commentary — explain the market impact.
   - What was the narrative theme? "Risk-off day driven by tariff fears" or "Risk-on rotation as inflation cooled."

2. **Cross-Asset Correlation & Volatility** — Connect the dots across today's session:
   - **VIX**: Where did it close? What does it tell us for tomorrow? "VIX at 22 suggests elevated anxiety heading into tomorrow."
   - **Cross-Asset Moves**: If crude oil, gold, TLT, or other correlated assets made notable moves today, explain how they drove or correlated with equity action. Be specific with patterns and levels.
   - **SPY & QQQ**: Where did they close vs open? What was the character of the move?
   - **Breadth**: Count sectors green vs red. Was it broad-based or concentrated?

3. **ES Prediction Scorecard** — Grade the morning prediction (HIT, PARTIAL, MISS). What was predicted vs what happened?

4. **Structural Update (SPY & QQQ)** — Use SPY/QQQ terms FIRST:
   - Did today confirm or negate the morning thesis?
   - Key levels tested — "SPY held the daily chart support floor at 580 all session" or "broke below 575, turning it into a resistance ceiling."
   - **Unfilled Gaps**: Were any filled today? Which remain open as potential targets?
   - Updated bull/bear thresholds for tomorrow.
   - For futures traders, note ES/NQ equivalents.

5. **Day Trader Session Review** — How did ATR levels perform? Actual range vs expected ATR?

6. **Macro & Data Impact** — Deep-dive on any data released today. Upcoming releases.

7. **After-Hours Earnings** — Reports and impact.

8. **Sector & Cross-Asset Analysis** — Leading/lagging sectors and WHY. Rotation signals. Breadth verdict.

9. **Looking Ahead: What Happens Next** — Most valuable section:
   - **Primary Thesis**: Most probable scenario for next 1-3 sessions, in SPY/QQQ terms.
   - **Risk Factors**: What could derail the thesis? Explain in plain English.
   - **Specific Levels**: In SPY/QQQ. "Looking to buy SPY dips at 580-583 for a rally to 590."
   - ALWAYS include a TIME DIMENSION.

10. **Active Trader Session Report** — MUST include daily change% for each ticker:
    - Each position: ticker, today's change%, total P&L, thesis status.
    - Entries, exits, trims with context.

11. **Investor Portfolio Update** — MUST include daily change% and total return for each holding:
    - "AAPL ($185.50, +1.20% today, +15.3% total return) — thesis intact."
    - DCA opportunities?

End with THREE sections:
- **Swing Trader Positioning**: What should position traders do going into tomorrow? Use SPY/QQQ levels.
- **Key Levels to Watch (SPY)**: 3-5 most important SPY support/resistance levels. For each, explain in plain English: "580 — Support floor (daily chart). Held today. If it breaks tomorrow, expect acceleration to 573."
- **Key Levels to Watch (QQQ)**: Same treatment for QQQ.`;
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
      temperature: 0.35,
      max_tokens: 6000,
    }),
    signal: AbortSignal.timeout(90000), // 90s timeout for larger model
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenAI ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const json = await resp.json();
  const raw = json.choices?.[0]?.message?.content || "";
  return sanitizeBriefContent(raw);
}

/**
 * Remove or fix contradictory game plan sentences.
 * Catches bearish scenarios where the target price is above the trigger level,
 * and bullish scenarios where the target is below the trigger.
 */
function sanitizeBriefContent(text) {
  if (!text || typeof text !== "string") return text;

  // Extract 4-5 digit price-like numbers (e.g. 6850.52, 19400)
  const extractPrices = (s) => {
    const nums = [];
    const re = /\b(\d{3,5}(?:\.\d{1,2})?)\b/g;
    let m;
    while ((m = re.exec(s)) !== null) nums.push(parseFloat(m[1]));
    return nums;
  };

  // Find the target price, handling patterns like "target -38.2% at 6850.52"
  const findTargetPrice = (line) => {
    // Pattern: "target ... at PRICE" (handles "target -38.2% at 6850.52")
    const atMatch = line.match(/target.*?\bat\s+(\d{3,5}(?:\.\d{1,2})?)\b/i);
    if (atMatch) return parseFloat(atMatch[1]);
    // Pattern: "target PRICE" (direct)
    const directMatch = line.match(/target\s+(\d{3,5}(?:\.\d{1,2})?)\b/i);
    if (directMatch) return parseFloat(directMatch[1]);
    // Pattern: "toward PRICE"
    const towardMatch = line.match(/toward\s+(\d{3,5}(?:\.\d{1,2})?)\b/i);
    if (towardMatch) return parseFloat(towardMatch[1]);
    return null;
  };

  const lines = text.split("\n");
  const out = [];
  for (const line of lines) {
    const lower = line.toLowerCase();

    // Detect bearish game plan lines
    const isBearish = /bear|break(?:s)? below|reject|fails? to hold|loses?|sells? off/i.test(lower)
      && /target|toward|head|aim/i.test(lower);

    if (isBearish) {
      const triggerMatch = line.match(/(?:break(?:s)? below|fails? to hold|loses?|rejects?\s+at)\s+([\d,.]+)/i);
      const target = findTargetPrice(line);
      if (triggerMatch && target != null) {
        const trigger = parseFloat(triggerMatch[1].replace(/,/g, ""));
        if (Number.isFinite(trigger) && Number.isFinite(target) && target > trigger) {
          console.warn(`[BRIEF SANITIZE] Dropped invalid bearish line: trigger=${trigger}, target=${target}, line="${line.slice(0, 120)}"`);
          continue;
        }
      }
    }

    // Detect bullish game plan lines
    const isBullish = /bull|break(?:s)? above|reclaim|hold(?:s)? above/i.test(lower)
      && /target|toward|head|aim/i.test(lower);

    if (isBullish) {
      const triggerMatch = line.match(/(?:break(?:s)? above|reclaim(?:s)?|hold(?:s)? above|opens? above)\s+([\d,.]+)/i);
      const target = findTargetPrice(line);
      if (triggerMatch && target != null) {
        const trigger = parseFloat(triggerMatch[1].replace(/,/g, ""));
        if (Number.isFinite(trigger) && Number.isFinite(target) && target < trigger) {
          console.warn(`[BRIEF SANITIZE] Dropped invalid bullish line: trigger=${trigger}, target=${target}, line="${line.slice(0, 120)}"`);
          continue;
        }
      }
    }

    out.push(line);
  }
  return out.join("\n").trim();
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

  // ATR Fibonacci Levels — ES (and SPX same scale), SPY, NQ, QQQ
  const fmtFib = (fib, label) => {
    if (!fib || !fib.levels) return null;
    const lvl = fib.levels;
    const fibStr = [
      `38.2%: ${lvl["-38.2%"] ?? "—"} / ${lvl["+38.2%"] ?? "—"}`,
      `50%: ${lvl["-50%"] ?? "—"} / ${lvl["+50%"] ?? "—"}`,
      `61.8%: ${lvl["-61.8%"] ?? "—"} / ${lvl["+61.8%"] ?? "—"}`,
    ].join("\n");
    const gate = fib.goldenGate === "OPEN_UP" ? "🟢 OPEN UP"
      : fib.goldenGate === "OPEN_DOWN" ? "🔴 OPEN DOWN"
      : "⚪ Neutral";
    return { name: `${label} (ATR ${fib.dayAtr?.toFixed?.(1) ?? "—"})`, value: `${gate}\n${fibStr}` };
  };
  const esFib = data.esTechnical?.atrFibLevels;
  const spyFib = data.spyTechnical?.atrFibLevels;
  const nqFib = data.nqTechnical?.atrFibLevels;
  const qqqFib = data.qqqTechnical?.atrFibLevels;
  if (esFib?.levels) fields.push(fmtFib(esFib, "ES / SPX Day Trader Levels"));
  if (spyFib?.levels) fields.push(fmtFib(spyFib, "SPY Day Trader Levels"));
  if (nqFib?.levels) fields.push(fmtFib(nqFib, "NQ Day Trader Levels"));
  if (qqqFib?.levels) fields.push(fmtFib(qqqFib, "QQQ Day Trader Levels"));

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
      esClose = Number(data.market.ES.sessionClose);
      if (!Number.isFinite(esClose) || esClose <= 0) {
        esClose = Number(data.market.ES.price);
      }
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

    // 10. Email daily brief to opted-in users
    const prefKey = type === "morning" ? "daily_brief_morning" : "daily_brief_evening";
    try {
      const optedInUsers = await getEmailOptedInUsers(env, prefKey);
      const briefPayload = { type, content, date: data.today, esPrediction };
      let emailSent = 0;
      for (const u of optedInUsers) {
        sendDailyBriefEmail(env, u.email, briefPayload)
          .then(r => { if (r.ok) emailSent++; })
          .catch(() => {});
      }
      if (optedInUsers.length) {
        console.log(`[DAILY BRIEF] Queued ${optedInUsers.length} ${prefKey} emails`);
      }
    } catch (e) {
      console.warn("[DAILY BRIEF] Email dispatch failed:", String(e?.message || e).slice(0, 150));
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
    await kvPutJSON(KV, "timed:daily-brief:intraday", []);
    console.log("[DAILY BRIEF] Cleared current brief + intraday (3 AM cleanup)");
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

// ═══════════════════════════════════════════════════════════════════════
// INTRADAY FLASH BRIEF — Newton-style real-time market insights
// ═══════════════════════════════════════════════════════════════════════

const INTRADAY_SYSTEM_PROMPT = `You are a senior technical strategist writing intraday flash insights — concise, real-time market updates for active traders. Think Mark Newton at Fundstrat Direct.

## Your Style
- **Cross-asset storytelling**: Connect DXY, Crude Oil, Gold, Treasury yields, VIX to equity price action. Example: "Crude oil reversing off $120 after a massive intraday hammer — if this holds, expect relief for equities as energy-driven inflation fears ease."
- **Specific technical callouts**: Name the pattern (hammer, engulfing, Ichimoku cloud test, Fibonacci retracement). Always include the timeframe and price level.
- **Actionable conviction**: "I expect SPY to bounce toward 585-588, but cannot make the case for a push above 590 until VIX breaks below 18."
- **Candid risk framing**: "Given the extent of the recent breakdown, it's hard to make the call for a full recovery — a 2-3 day bounce is more likely before another leg down."
- **No hedge-speak**: Don't say "markets could go up or down." Take a view, explain why, and give the invalidation level.

## Format
Write 2-4 paragraphs. Each paragraph covers a different angle:
1. **Lead with the most notable cross-asset move** — what's driving the tape right now?
2. **Equity reaction** — how are SPY/QQQ responding? What pattern is forming on the intraday chart?
3. **Key levels and targets** — specific prices for the next 1-3 sessions. Include the invalidation.
4. **What to watch** — the one thing that would change the thesis.

## Data Rules
- Use ONLY the provided data. If a field is null or missing, skip it.
- Reference the TT scoring model signals when relevant (HTF/LTF scores, state, phase zone).
- VIX context is ALWAYS relevant — include it.
- Keep it under 600 words. This is a flash insight, not a full brief.
- Do NOT use emojis. Use markdown headers (##) sparingly — one or two at most.
- ALWAYS reference specific price levels from the data. Never say "higher" without a target.`;

function buildIntradayPrompt(data) {
  const lines = [];
  lines.push(`## Intraday Flash — ${data.today} at ${data.currentTimeET}`);
  lines.push("");

  if (data.priceFeedCrossRef) {
    lines.push("### Real-Time Prices");
    lines.push(data.priceFeedCrossRef);
    lines.push("");
  }

  if (data.crossAssetContext) {
    lines.push("### Cross-Asset Context");
    lines.push(data.crossAssetContext);
    lines.push("");
  }

  const keyTickers = ["SPY", "QQQ", "ES1!", "NQ1!", "VX1!"];
  for (const sym of keyTickers) {
    const m = data.market?.[sym];
    if (!m) continue;
    const parts = [`${sym}: price=$${m.price}`];
    if (m.dayChangePct) parts.push(`day=${m.dayChangePct}%`);
    if (m.state) parts.push(`state=${m.state}`);
    if (m.htf_score) parts.push(`htf=${m.htf_score}`);
    if (m.ltf_score) parts.push(`ltf=${m.ltf_score}`);
    if (m.phase_zone) parts.push(`phase=${m.phase_zone}`);
    if (m.rank) parts.push(`rank=${m.rank}`);
    lines.push(parts.join(", "));
  }
  lines.push("");

  if (data.spyTechnical) {
    lines.push("### SPY Technical (from scoring engine)");
    lines.push(data.spyTechnical.slice(0, 1500));
    lines.push("");
  }
  if (data.qqqTechnical) {
    lines.push("### QQQ Technical (from scoring engine)");
    lines.push(data.qqqTechnical.slice(0, 1500));
    lines.push("");
  }

  if (data.sectors) {
    lines.push("### Sector Heatmap");
    lines.push(data.sectors);
    lines.push("");
  }

  if (data.morningContent) {
    lines.push("### Morning Brief Context (for continuity)");
    lines.push(data.morningContent.slice(0, 800));
    lines.push("");
  }

  const openCount = data.openTrades?.length || 0;
  if (openCount > 0) {
    lines.push(`### Active Trades (${openCount} open)`);
    for (const t of data.openTrades.slice(0, 10)) {
      lines.push(`- ${t.ticker} ${t.direction} entry=$${t.entry_price?.toFixed?.(2) || "?"} pnl=${t.pnl_pct?.toFixed?.(1) || "?"}%`);
    }
    lines.push("");
  }

  lines.push("Write a concise intraday flash insight (2-4 paragraphs, under 600 words). Lead with the most notable cross-asset move driving the tape right now. Connect to equity action. Give specific levels and a clear near-term view.");

  return lines.join("\n");
}

export async function generateIntradayBrief(env, opts = {}) {
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false, error: "no_kv" };

  console.log("[INTRADAY BRIEF] Generating flash insight...");
  const start = Date.now();

  try {
    const data = await gatherDailyBriefData(env, "intraday", opts);
    if (data.error) return { ok: false, error: data.error };

    const nowET = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
    const timeParts = new Date(nowET);
    const hours = timeParts.getHours();
    const mins = timeParts.getMinutes();
    data.currentTimeET = `${hours > 12 ? hours - 12 : hours}:${String(mins).padStart(2, "0")} ${hours >= 12 ? "PM" : "AM"} ET`;

    const db = env?.DB;
    if (db) {
      try {
        const morningRow = await db.prepare(
          "SELECT content FROM daily_briefs WHERE date = ?1 AND type = 'morning' LIMIT 1"
        ).bind(data.today).first();
        if (morningRow?.content) {
          data.morningContent = morningRow.content.slice(0, 800);
        }
      } catch (_) {}
    }

    const prompt = buildIntradayPrompt(data);
    const content = await callOpenAI(env, INTRADAY_SYSTEM_PROMPT, prompt);
    if (!content || content.length < 50) {
      return { ok: false, error: "ai_response_too_short" };
    }

    const now = Date.now();
    const entry = {
      id: `intraday-${data.today}-${now}`,
      date: data.today,
      timeET: data.currentTimeET,
      content,
      publishedAt: now,
    };

    const currentIntraday = (await kvGetJSON(KV, "timed:daily-brief:intraday")) || [];
    const todayEntries = currentIntraday.filter(
      (e) => e.date === data.today
    );
    todayEntries.push(entry);
    await kvPutJSON(KV, "timed:daily-brief:intraday", todayEntries);

    await kvPutJSON(KV, "timed:daily-brief:badge", { ts: now, type: "intraday", date: data.today });

    if (db) {
      await d1EnsureBriefSchema(env);
      await db.prepare(`
        INSERT INTO daily_briefs (id, date, type, content, es_prediction, published_at, created_at)
        VALUES (?1, ?2, 'intraday', ?3, NULL, ?4, ?5)
        ON CONFLICT(id) DO UPDATE SET content = excluded.content, published_at = excluded.published_at
      `).bind(entry.id, data.today, content, now, now).run();
    }

    const elapsed = Date.now() - start;
    console.log(`[INTRADAY BRIEF] Flash insight generated in ${elapsed}ms (${content.length} chars)`);
    return { ok: true, id: entry.id, elapsed, chars: content.length };
  } catch (e) {
    console.error("[INTRADAY BRIEF] Generation failed:", String(e).slice(0, 300));
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/** GET /timed/daily-brief/intraday — returns today's flash insights */
export async function handleGetIntradayBriefs(env) {
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false, error: "no_kv" };
  const entries = (await kvGetJSON(KV, "timed:daily-brief:intraday")) || [];
  return { ok: true, entries };
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
