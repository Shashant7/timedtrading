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
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS daily_market_snapshots (
        date TEXT PRIMARY KEY,
        vix_close REAL,
        vix_state TEXT,
        oil_pct REAL,
        gold_pct REAL,
        tlt_pct REAL,
        spy_pct REAL,
        qqq_pct REAL,
        iwm_pct REAL,
        sector_rotation TEXT,
        offense_avg_pct REAL,
        defense_avg_pct REAL,
        regime_overall TEXT,
        regime_score INTEGER,
        es_prediction TEXT,
        brief_summary TEXT,
        econ_events TEXT,
        created_at INTEGER
      )
    `).run();
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS market_events (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_key TEXT,
        event_name TEXT NOT NULL,
        ticker TEXT,
        impact TEXT,
        source TEXT,
        status TEXT,
        scheduled_ts INTEGER,
        scheduled_time_et TEXT,
        session TEXT,
        actual TEXT,
        estimate TEXT,
        previous TEXT,
        surprise_pct REAL,
        spy_reaction_pct REAL,
        sector_reaction_pct REAL,
        brief_note TEXT,
        created_at INTEGER
      )
    `).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_mkt_events_date ON market_events (date)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_mkt_events_type ON market_events (event_type, date)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_mkt_events_ticker ON market_events (ticker, date)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_mkt_events_key ON market_events (event_key, date)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_mkt_events_schedule ON market_events (status, scheduled_ts)`).run();
    try { await db.prepare(`ALTER TABLE market_events ADD COLUMN event_key TEXT`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE market_events ADD COLUMN source TEXT`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE market_events ADD COLUMN status TEXT`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE market_events ADD COLUMN scheduled_ts INTEGER`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE market_events ADD COLUMN scheduled_time_et TEXT`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE market_events ADD COLUMN session TEXT`).run(); } catch {}
    // Crypto leading indicators (BTC leads SPY/QQQ, ETH leads IWM/Financials)
    try { await db.prepare(`ALTER TABLE daily_market_snapshots ADD COLUMN btc_pct REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_market_snapshots ADD COLUMN eth_pct REAL`).run(); } catch {}
    _briefSchemaReady = true;
  } catch (e) {
    console.error("[DAILY BRIEF] Schema init failed:", String(e).slice(0, 200));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Episodic Market Memory — Snapshot + Event Persistence
// ═══════════════════════════════════════════════════════════════════════

const OFFENSE_SECTORS = ["XLK", "XLY", "XLI"];
const DEFENSE_SECTORS = ["XLU", "XLP", "XLV"];

function classifyVixState(vix) {
  if (vix <= 15) return "low_fear";
  if (vix <= 22) return "normal";
  if (vix <= 30) return "elevated";
  return "fear";
}

function classifySectorRotation(offenseAvg, defenseAvg) {
  const delta = offenseAvg - defenseAvg;
  if (delta > 0.5) return "risk_on";
  if (delta < -0.5) return "risk_off";
  return "balanced";
}

/**
 * Persist a structured market snapshot alongside the Daily Brief.
 * Called from generateDailyBrief() after the brief text is stored.
 */
export async function persistDailyMarketSnapshot(env, data, priceFeed, esPrediction, briefContent) {
  const db = env?.DB;
  if (!db || !data?.today) return;
  await d1EnsureBriefSchema(env);

  const pf = (priceFeed?.prices || priceFeed) || {};
  const num = (sym, field) => Number(pf[sym]?.[field]) || 0;

  const vixClose = num("VIX", "p") || Number(data.market?.VIX?.price) || 0;
  const oilPct = num("CL1!", "dp");
  const goldPct = num("GC1!", "dp");
  const tltPct = num("TLT", "dp");
  const spyPct = num("SPY", "dp") || Number(data.market?.SPY?.day_change_pct) || 0;
  const qqqPct = num("QQQ", "dp") || Number(data.market?.QQQ?.day_change_pct) || 0;
  const iwmPct = num("IWM", "dp") || Number(data.market?.IWM?.day_change_pct) || 0;
  const btcPct = num("BTCUSD", "dp") || num("BTC/USD", "dp");
  const ethPct = num("ETHUSD", "dp") || num("ETH/USD", "dp");

  const offenseAvg = OFFENSE_SECTORS.reduce((s, sym) => s + num(sym, "dp"), 0) / OFFENSE_SECTORS.length;
  const defenseAvg = DEFENSE_SECTORS.reduce((s, sym) => s + num(sym, "dp"), 0) / DEFENSE_SECTORS.length;
  const sectorRotation = classifySectorRotation(offenseAvg, defenseAvg);
  const vixState = classifyVixState(vixClose);

  const regimeOverall = (spyPct > 0.3 && qqqPct > 0.3) ? "risk_on"
    : (spyPct < -0.3 && qqqPct < -0.3) ? "risk_off" : "balanced";
  const regimeScore = Math.round((spyPct + qqqPct) * 10);

  const topEcon = (data.todayEconomicEvents || []).slice(0, 3).map(e => e.event || "").filter(Boolean).join(", ");

  let briefSummary = null;
  if (briefContent) {
    const firstPara = briefContent.split("\n").find(l => l.trim().length > 30);
    if (firstPara) briefSummary = firstPara.trim().slice(0, 200);
  }

  try {
    await db.prepare(`
      INSERT INTO daily_market_snapshots (date, vix_close, vix_state, oil_pct, gold_pct, tlt_pct, spy_pct, qqq_pct, iwm_pct,
        sector_rotation, offense_avg_pct, defense_avg_pct, regime_overall, regime_score, es_prediction, brief_summary, econ_events, btc_pct, eth_pct, created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
      ON CONFLICT(date) DO UPDATE SET
        vix_close=excluded.vix_close, vix_state=excluded.vix_state, oil_pct=excluded.oil_pct,
        gold_pct=excluded.gold_pct, tlt_pct=excluded.tlt_pct, spy_pct=excluded.spy_pct,
        qqq_pct=excluded.qqq_pct, iwm_pct=excluded.iwm_pct, sector_rotation=excluded.sector_rotation,
        offense_avg_pct=excluded.offense_avg_pct, defense_avg_pct=excluded.defense_avg_pct,
        regime_overall=excluded.regime_overall, regime_score=excluded.regime_score,
        es_prediction=excluded.es_prediction, brief_summary=excluded.brief_summary,
        econ_events=excluded.econ_events, btc_pct=excluded.btc_pct, eth_pct=excluded.eth_pct
    `).bind(
      data.today, vixClose, vixState, oilPct, goldPct, tltPct, spyPct, qqqPct, iwmPct,
      sectorRotation, Math.round(offenseAvg * 100) / 100, Math.round(defenseAvg * 100) / 100,
      regimeOverall, regimeScore, esPrediction || null, briefSummary, topEcon || null,
      btcPct || null, ethPct || null, Date.now()
    ).run();
    console.log(`[DAILY BRIEF] Persisted market snapshot for ${data.today}`);
  } catch (e) {
    console.warn("[DAILY BRIEF] Failed to persist market snapshot:", String(e).slice(0, 200));
  }
}

/**
 * Persist scheduled and resolved macro/earnings events for replay/live risk lookup.
 * Called from generateDailyBrief() after the brief text is stored.
 */
export async function persistMarketEvents(env, data, priceFeed) {
  const db = env?.DB;
  if (!db || !data?.today) return;
  await d1EnsureBriefSchema(env);

  const pf = (priceFeed?.prices || priceFeed) || {};
  const spyPct = Number(pf["SPY"]?.dp) || Number(data.market?.SPY?.day_change_pct) || 0;
  const stmts = [];

  const econEvents = [
    ...(data.yesterdayEconomicEvents || []),
    ...(data.todayEconomicEvents || []),
    ...(data.economicEvents || []),
  ].filter(e => e.impact === "high" || e.impact === "medium");
  const econById = new Map();
  for (const e of econEvents) {
    const dateKey = String(e?.date || data.today).slice(0, 10);
    const name = (e.event || "").trim();
    if (!name) continue;
    const id = `${dateKey}:${name.replace(/\s+/g, "_").slice(0, 40)}`;
    econById.set(id, { ...(econById.get(id) || {}), ...e, _dateKey: dateKey, _name: name });
  }
  for (const e of econById.values()) {
    const eventKey = classifyMarketEventKey(e._name, "macro");
    const schedule = buildScheduledEventMeta({
      dateKey: e._dateKey,
      timeHint: e.time || (e.date || "").slice(11),
      eventKey,
      eventType: "macro",
      hasActual: e.actual != null && String(e.actual).trim() !== "",
    });
    const id = `${e._dateKey}:${e._name.replace(/\s+/g, "_").slice(0, 40)}`;
    stmts.push(
      db.prepare(`
        INSERT INTO market_events (id, date, event_type, event_key, event_name, ticker, impact, source, status, scheduled_ts, scheduled_time_et, session, actual, estimate, previous, surprise_pct, spy_reaction_pct, sector_reaction_pct, brief_note, created_at)
        VALUES (?1,?2,?3,?4,?5,NULL,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,NULL,NULL,?17)
        ON CONFLICT(id) DO UPDATE SET
          event_key=excluded.event_key,
          impact=excluded.impact,
          source=excluded.source,
          status=excluded.status,
          scheduled_ts=excluded.scheduled_ts,
          scheduled_time_et=excluded.scheduled_time_et,
          session=excluded.session,
          actual=excluded.actual,
          estimate=excluded.estimate,
          previous=excluded.previous,
          surprise_pct=excluded.surprise_pct,
          spy_reaction_pct=excluded.spy_reaction_pct
      `).bind(
        id, e._dateKey, "macro", eventKey, e._name, e.impact || "medium",
        "daily_brief_econ", schedule.status, schedule.scheduledTs, schedule.scheduledTimeEt, schedule.session,
        e.actual || null, e.estimate || null, e.prev || null,
        e.actual && e.estimate ? parseSurprise(e.actual, e.estimate) : null,
        spyPct, Date.now()
      )
    );
  }

  const earningsEvents = [...(data.weekEarnings || []), ...(data.todayEarnings || [])];
  const earningsById = new Map();
  for (const e of earningsEvents) {
    const sym = (e.symbol || "").toUpperCase().trim();
    if (!sym) continue;
    const dateKey = String(e?.date || data.today).slice(0, 10);
    const id = `${dateKey}:${sym}:earnings`;
    earningsById.set(id, { ...(earningsById.get(id) || {}), ...e, _dateKey: dateKey, _sym: sym });
  }
  for (const e of Array.from(earningsById.values()).slice(0, 60)) {
    const id = `${e._dateKey}:${e._sym}:earnings`;
    const epsActual = Number(e.epsActual) || null;
    const epsEst = Number(e.epsEstimate) || null;
    const surprise = (epsActual != null && epsEst != null && epsEst !== 0)
      ? Math.round(((epsActual - epsEst) / Math.abs(epsEst)) * 10000) / 100
      : null;
    const sectorEtf = pf[e._sectorEtf]?.dp || null;
    const schedule = buildScheduledEventMeta({
      dateKey: e._dateKey,
      timeHint: e.hour,
      eventKey: "EARNINGS",
      eventType: "earnings",
      hasActual: epsActual != null,
    });
    stmts.push(
      db.prepare(`
        INSERT INTO market_events (id, date, event_type, event_key, event_name, ticker, impact, source, status, scheduled_ts, scheduled_time_et, session, actual, estimate, previous, surprise_pct, spy_reaction_pct, sector_reaction_pct, brief_note, created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,NULL,?19)
        ON CONFLICT(id) DO UPDATE SET
          event_key=excluded.event_key,
          impact=excluded.impact,
          source=excluded.source,
          status=excluded.status,
          scheduled_ts=excluded.scheduled_ts,
          scheduled_time_et=excluded.scheduled_time_et,
          session=excluded.session,
          actual=excluded.actual,
          estimate=excluded.estimate,
          surprise_pct=excluded.surprise_pct,
          spy_reaction_pct=excluded.spy_reaction_pct,
          sector_reaction_pct=excluded.sector_reaction_pct
      `).bind(
        id, e._dateKey, "earnings", "EARNINGS", `${e._sym} Earnings`, e._sym, "high",
        "daily_brief_earnings", schedule.status, schedule.scheduledTs, schedule.scheduledTimeEt, schedule.session,
        epsActual != null ? `$${epsActual} EPS` : null,
        epsEst != null ? `$${epsEst} EPS` : null,
        null, surprise, spyPct, sectorEtf != null ? Number(sectorEtf) : null, Date.now()
      )
    );
  }

  if (stmts.length === 0) return;
  try {
    await db.batch(stmts);
    console.log(`[DAILY BRIEF] Persisted ${stmts.length} market events for ${data.today}`);
  } catch (e) {
    console.warn("[DAILY BRIEF] Failed to persist market events:", String(e).slice(0, 200));
  }
}

const MACRO_EVENT_DEFAULT_TIME_ET = {
  CPI: "08:30",
  PPI: "08:30",
  PCE: "08:30",
  NFP: "08:30",
  FOMC: "14:00",
};

export function classifyMarketEventKey(eventName, eventType = "macro") {
  if (eventType === "earnings") return "EARNINGS";
  const name = String(eventName || "").toUpperCase();
  if (!name) return "OTHER";
  if (name.includes("CPI") || name.includes("CONSUMER PRICE INDEX")) return "CPI";
  if (name.includes("PPI") || name.includes("PRODUCER PRICE INDEX")) return "PPI";
  if (name.includes("FOMC") || name.includes("FEDERAL RESERVE")) return "FOMC";
  if (name.includes("PCE") || name.includes("PERSONAL CONSUMPTION")) return "PCE";
  if (name.includes("NFP") || name.includes("NONFARM PAYROLL") || name.includes("NON-FARM PAYROLL")) return "NFP";
  return eventType === "macro" ? "OTHER_MACRO" : "OTHER";
}

function parseClockTimeToMinutesEt(raw, fallbackLabel = "") {
  const label = String(raw || fallbackLabel || "").trim().toLowerCase();
  if (!label) return null;
  if (label === "bmo" || label.includes("before market open") || label.includes("pre-market")) return 8 * 60;
  if (label === "amc" || label.includes("after market close") || label.includes("after-hours")) return 16 * 60 + 5;
  if (label.includes("tentative") || label.includes("all day")) return null;
  let match = label.match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
  if (match) {
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const suffix = String(match[3] || "").toLowerCase();
    if (suffix === "pm" && hour < 12) hour += 12;
    if (suffix === "am" && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return hour * 60 + minute;
  }
  match = label.match(/\b(\d{2})(\d{2})\b/);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return hour * 60 + minute;
  }
  return null;
}

function formatMinutesEt(mins) {
  if (!Number.isFinite(mins)) return null;
  const hour = Math.max(0, Math.min(23, Math.floor(mins / 60)));
  const minute = Math.max(0, Math.min(59, mins % 60));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function classifyEventSession(mins, explicitHint = "") {
  const hint = String(explicitHint || "").trim().toLowerCase();
  if (hint === "bmo" || hint.includes("before market open")) return "bmo";
  if (hint === "amc" || hint.includes("after market close")) return "amc";
  if (!Number.isFinite(mins)) return "unknown";
  if (mins < 9 * 60 + 30) return "premarket";
  if (mins < 16 * 60) return "rth";
  return "afterhours";
}

function tzOffsetMs(ts, timeZone) {
  const d = new Date(Number(ts));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const map = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  const asIso = `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}Z`;
  const wallAsUtc = Date.parse(asIso);
  return wallAsUtc - Number(ts);
}

function nyWallTimeToUtcMs(dayKey, hh = 0, mm = 0, ss = 0) {
  if (!dayKey) return null;
  const H = String(Math.max(0, Math.min(23, Number(hh) || 0))).padStart(2, "0");
  const M = String(Math.max(0, Math.min(59, Number(mm) || 0))).padStart(2, "0");
  const S = String(Math.max(0, Math.min(59, Number(ss) || 0))).padStart(2, "0");
  const t0 = Date.parse(`${dayKey}T${H}:${M}:${S}Z`);
  if (!Number.isFinite(t0)) return null;
  let ts = t0;
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMs(ts, "America/New_York");
    const next = t0 - off;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - ts) < 1000) {
      ts = next;
      break;
    }
    ts = next;
  }
  return ts;
}

export function buildScheduledEventMeta({ dateKey, timeHint, eventKey, eventType, hasActual }) {
  const fallback = eventType === "earnings"
    ? (String(timeHint || "").trim().toLowerCase() === "bmo" ? "08:00" : String(timeHint || "").trim().toLowerCase() === "amc" ? "16:05" : "")
    : (MACRO_EVENT_DEFAULT_TIME_ET[eventKey] || "");
  const mins = parseClockTimeToMinutesEt(timeHint, fallback);
  const scheduledTimeEt = formatMinutesEt(mins) || (fallback || null);
  const scheduledTs = Number.isFinite(mins)
    ? nyWallTimeToUtcMs(dateKey, Math.floor(mins / 60), mins % 60, 0)
    : null;
  return {
    scheduledTs,
    scheduledTimeEt,
    session: classifyEventSession(mins, timeHint),
    status: hasActual ? "resolved" : "scheduled",
  };
}

export function parseSurprise(actual, estimate) {
  const a = parseFloat(String(actual).replace(/[^0-9.\-]/g, ""));
  const e = parseFloat(String(estimate).replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(a) || !Number.isFinite(e) || e === 0) return null;
  return Math.round(((a - e) / Math.abs(e)) * 10000) / 100;
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
 * Fetch earnings for a specific symbol from Finnhub calendar.
 * Uses the symbol filter param for a targeted lookup.
 */
export async function fetchFinnhubSymbolEarnings(env, symbol, fromDate, toDate) {
  const token = env?.FINNHUB_API_KEY;
  if (!token) return [];
  try {
    const url = `${FINNHUB_BASE}/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${fromDate}&to=${toDate}&token=${token}`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
  } catch {
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
    iwmCandles,
    iwmCandlesH1,
    iwmCandlesM5,
    finnhubEconNews,
    ffToday,
    ffYesterday,
    esCandlesH4,
    nqCandlesH4,
    spyCandlesH4,
    qqqCandlesH4,
    iwmCandlesH4,
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
    // IWM candles (daily, hourly, 5m) — Russell 2000 Day Trader levels
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "IWM", "D", 20).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "IWM", "60", 50).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "IWM", "5", 100).catch(() => ({ candles: [] }))
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
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "IWM", "240", 40).catch(() => ({ candles: [] }))
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
  const investorProfileMap = {};
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
      const investorTickers = [...new Set(investorPositions.map(p => String(p.ticker || '').toUpperCase()).filter(Boolean))];
      if (investorTickers.length > 0) {
        const inClause = investorTickers.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
        const profileRes = await db.prepare(`SELECT ticker, learning_json FROM ticker_profiles WHERE ticker IN (${inClause})`).all().catch(() => ({ results: [] }));
        for (const row of profileRes?.results || []) {
          let learning = null;
          try { learning = typeof row.learning_json === 'string' ? JSON.parse(row.learning_json) : row.learning_json; } catch {}
          if (!learning) continue;
          investorProfileMap[String(row.ticker || '').toUpperCase()] = {
            longArchetype: learning?.entry_params?.long_dominant_archetype || learning?.runtime_policy?.investor?.long_bias_archetype || null,
            stance: learning?.runtime_policy?.investor?.stance || null,
            addOn: learning?.runtime_policy?.investor?.add_on || null,
            risk: learning?.runtime_policy?.investor?.risk || null,
          };
        }
      }
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

  const iwmTechnical = summarizeTechnical(
    iwmCandles?.candles || [], iwmCandlesH1?.candles || [],
    iwmCandlesM5?.candles || [], iwmData, iwmCandlesH4?.candles || [], []
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
    phase_pct: Number(d.phase_pct) || 0,
    regime: d.regimeVocabulary?.executionRegimeClass || d.regime_class || d.regime || "",
    regime_vocabulary: d.regimeVocabulary || null,
    setup_grade: d.setup_grade || "",
    flags: d.flags || {},
    swing_consensus: d.swing_consensus || null,
    tf_tech: d.tf_tech || null,
  } : null;

  const extractedEs = extract(esData);
  const esSessionClose = type === "evening"
    ? pickCanonicalSessionClose(today, esCandles?.candles || [], esCandlesM5?.candles || [], "ES1!")
    : { price: null, source: null };
  const spySessionClose = type === "evening"
    ? pickCanonicalSessionClose(today, spyCandles?.candles || [], spyCandlesM5?.candles || [], "SPY")
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
      SPY: { ...extract(spyData), sessionClose: spySessionClose.price },
      QQQ: extract(qqqData),
      IWM: extract(iwmData),
    },
    esTechnical,
    nqTechnical,
    spyTechnical,
    qqqTechnical,
    iwmTechnical,
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
    investorPositions: investorPositions.map(p => {
      const learned = investorProfileMap[String(p.ticker || '').toUpperCase()] || {};
      return {
        ticker: p.ticker,
        shares: p.total_shares,
        avgEntry: p.avg_entry,
        costBasis: p.cost_basis,
        thesis: p.thesis,
        stage: p.investor_stage,
        archetype: learned.longArchetype || null,
        policy: learned.stance || null,
        addOn: learned.addOn || null,
        riskNote: learned.risk || null,
      };
    }),
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
  const tickers = ["SPY", "QQQ", "VX1!", "ES1!", "NQ1!", "XLE", "XLK", "XLF", "XLU", "XLP", "XLY", "XLI", "GLD", "TLT", "CL1!", "GC1!", "SI1!", "IWM", "DIA", "BTCUSD", "ETHUSD"];
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
    "BTCUSD (Bitcoin)": pf["BTCUSD"],
    "ETHUSD (Ethereum)": pf["ETHUSD"],
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

function pickCanonicalSessionClose(targetDate, dailyCandles, intradayCandles, ticker = "?") {
  const daily = Array.isArray(dailyCandles) ? dailyCandles : [];
  const intraday = Array.isArray(intradayCandles) ? intradayCandles : [];

  const matchedDaily = daily
    .map((candle) => {
      const tsMs = dailyBriefTsMs(candle?.ts ?? candle?.t ?? candle?.time ?? candle?.date);
      return { candle, tsMs, dateKey: nyDateKeyFromMs(tsMs) };
    })
    .filter((row) => row.dateKey === targetDate)
    .sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0));

  if (matchedDaily.length === 0 && daily.length > 0) {
    const availDates = [...new Set(daily.map(c => nyDateKeyFromMs(dailyBriefTsMs(c?.ts ?? c?.t ?? c?.time ?? c?.date))))].filter(Boolean);
    console.warn(`[DAILY BRIEF] ${ticker} no daily candle for ${targetDate}. Available: ${availDates.slice(-5).join(", ")}`);
  }

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

const ANALYST_SYSTEM_PROMPT = `You are an experienced market technician and strategist who has traded through multiple market cycles — from the dot-com bust to the GFC, COVID crash, and the 2022 bear market. You've seen every pattern, every head-fake, every squeeze. You write a daily brief that traders rely on as their personal market technician.

Your PRIMARY audience trades SPY and QQQ. ES (S&P 500 futures) and NQ (Nasdaq futures) are used as proxy references for advanced users — always translate key levels to SPY/QQQ equivalents. VIX (VX1! futures) is always referenced because volatility context tells the larger story.

## Your Identity and Voice

You are NOT writing a one-off analysis. You are the market technician who has been watching this tape every single day. Your brief is a CONTINUATION of an ongoing conversation — you know the context because you've been living it. When you say "we've been stuck in this range for 8 weeks," the reader trusts you because you've been tracking it.

Your voice:
- **First-person plural**: "We're still inside the 560-580 range on SPY that's defined the last 6 weeks." Not "SPY is trading in a range."
- **Experience-backed**: "I've seen this setup before — back in Q4 2023, SPY consolidated in a similar 5% range for 7 weeks before resolving higher. The key difference now is VIX is elevated, which tells me the resolution could go either way."
- **Pattern recognition**: Reference past market analogs when the current structure is similar. "This price action reminds me of March 2023 after the banking crisis — choppy consolidation with VIX between 18-25 before a trend emerged."
- **Honest about uncertainty**: "The honest read right now is that this market doesn't have a clear direction. We've been range-bound for weeks, and the best approach is to play the edges, not chase breakouts in the middle of the range."
- **Calibrated expectations**: Don't expect every breakout to reach the moon. "Yes, SPY poked above 580 yesterday, but with phase at 74% and the 10-day range capped at 582, I wouldn't expect a runaway move from here. More likely a retest of 575 before any meaningful follow-through."

## Communication Style

Write like a trusted mentor: authoritative but approachable. Think veteran trader explaining the game plan to a colleague — not a textbook, not a chatbot.

**Every technical term gets a plain-English translation on first use:**
- Instead of "BSL at 5950" → "**Resistance ceiling at 5950** (a recent high where sellers stepped in — 'buyside liquidity' in trader speak)"
- Instead of "Bullish FVG at 5850-5880" → "**Unfilled gap between 5850-5880** (price moved too fast and left a gap — these tend to get 'filled' as price pulls back)"
- After the first explanation, use the short form going forward

**ALWAYS include the timeframe** when referencing any level:
- "On the daily chart, the key resistance ceiling is 5950"
- "The 4-hour chart shows an unfilled gap between 5850-5880"
- NEVER reference a level without stating which timeframe it comes from

## Continuous Evaluation Framework

This is NOT a fresh analysis every day. You are tracking a running narrative. Your framework:

1. **Where are we in the bigger picture?** — Start with the multi-week/multi-month context. Are we range-bound? In a clear trend? At a major inflection point? If we've been stuck in a 560-580 range for weeks, SAY SO and make that the dominant narrative. Don't treat each day as a clean slate.

2. **What has changed since yesterday?** — What's new today that shifts the thesis? If nothing has changed, say "nothing structurally changed overnight — the same range and levels apply." Don't manufacture drama.

3. **How does today fit into the pattern?** — Use the Multi-Day Change data to paint a picture: "SPY is down 3.2% over 5 sessions, which is the steepest 5-day slide since January. Historically, that kind of concentrated selling has led to a 1-2 day bounce 75% of the time."

4. **Historical pattern comparison** — When the current market structure resembles a known historical pattern, reference it:
   - "The current consolidation pattern in SPY — a 6-week range between 555-580 with declining volume — looks structurally similar to the July-August 2024 trading range that resolved with a 4% move lower before rallying."
   - "QQQ forming a descending triangle on the daily — the last time we saw this pattern was October 2023, which broke down 3% before reversing."
   - Reference specific years and months. Use general seasonality data when relevant.
   - Be clear about probabilities: "Descending triangles break to the downside about 64% of the time, but in bull market regimes, that drops to ~50/50."

5. **Manage expectations** — If we're in a choppy range, don't pretend every small breakout is the start of a new trend. "SPY testing 580 resistance for the third time this month. Even if it clears today, the 582-585 supply zone sits just above. I'd wait for a daily close above 585 before calling this a breakout."

6. **Then the game plan** — Clear, conditional, actionable levels for today's session.

## Analysis Style
- **Conditional**: "If SPY holds above X, then Y. If it breaks below X, expect Z." Always give both scenarios.
- **Specific**: Every claim has a level attached. Never "market may go higher" — always "SPY could rally toward the 590-593 zone."
- **Time-aware**: "I'd expect a retest of 575 by mid-week before any attempt at 582." Give timelines.
- **Contextual**: Zoom out first. If the market has been range-bound for weeks, that IS the story — don't bury it.
- **Non-redundant**: Each section adds unique value. State levels once in the appropriate section.

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

Writing Guidelines (CONCISION IS NON-NEGOTIABLE):
- Write in the voice of a veteran trader DM'ing a colleague. Scannable, decisive, zero filler.
- **Target length: 650-900 words total.** If a sentence doesn't contain a LEVEL, a PROBABILITY, or an ACTIONABLE decision, delete it.
- Every section below has a **hard sentence cap**. DO NOT exceed it. If you need more, you picked the wrong sentences.
- Lead each section with the punchline, then evidence. No "as we discussed" throat-clearing.
- Prefer bullets to paragraphs. Prefer numbers to adjectives. "VIX 19.2, up 1.4 pts" beats "VIX is elevated and ticking higher."
- Reference specific price levels, percentages, and zones — every claim has a number attached.
- CRITICAL: ALL economic data values (CPI, PPI, GDP, etc.) MUST use EXACTLY two decimal places (e.g., 2.40%, 0.30%).
- Logic: Bearish scenarios target prices LOWER than the trigger. Bullish scenarios target HIGHER.
- Do NOT use emojis.
- CRITICAL FORMATTING: Use proper markdown with BLANK LINES before every ## and ### header. Output is rendered via markdown parser.
- For earnings: ALWAYS include current price and daily change, e.g., "ESNT ($148.52, +1.30%)".
- For macro events: One sentence of impact, not a lecture. "CPI prints 8:30 ET — hot read (>3.0%) likely taps SPY 575 support; cool read opens 585 test."
- If a data field is missing, omit the bullet. Do not fill with hedging prose.

## Voice & Format (STYLE GUIDE — inspired by Scott Galloway's Prof G Markets):

Write like an opinionated veteran trader, not a neutral analyst. Every section takes a stance. Every paragraph is 2-4 sentences — one-sentence paragraphs for punctuation. Coin a named concept for today's regime ("ketamine tape", "breadth mirage", "melting-ice-cube rally") and use it as a throughline.

### Section 0: "Today's Three" (MANDATORY OPENER — exactly 3 numbered lines)
A compact TOC at the very top. Each line is one sentence, ≤ 14 words, and ends with the punchline. Emit exactly three lines like:

    1. SPY/QQQ regime: [punchline]
    2. Sector rotation: [punchline]
    3. Today's catalyst: [punchline]

### Section 1: "The Bigger Picture" (3-4 sentences, HARD CAP)
**Editorialized H2 header with a cultural reference or branded phrase**, NOT "The Bigger Picture" — examples: "## The Ketamine Tape", "## Range-Bound Purgatory", "## Breakout, Interrupted".

The punchline, then the why. Lead with regime + duration ("Range-bound 7 weeks between 555-582"), then the pattern forming, the VIX read, and the invalidation trigger. End with a **decisive prediction or take** — not a summary. NO historical-analog prose unless it changes the trade plan.

### Section 2: "What's Changed" (1-2 sentences, HARD CAP)
Editorialized header like "## Overnight Delta" or "## Nothing Burger" (when true). Only the overnight delta. If nothing structurally changed, one sentence: "Overnight quiet — same 565-580 range applies."

### Section 3: "SPY" and "QQQ" (use separate ## for each — TIGHT)
Each header is editorialized: "## SPY: Stuck above 580" not "## SPY". For each ticker, exactly these compact bullet groups. NO paragraphs.

**Bias**: [Bullish / Bearish / Neutral / Range-Bound] — followed by ONE editorial one-liner ("bulls need a daily close > 585 or this is just another tag of resistance")

- Regime/Phase: [regime] · Phase [zone] [pct]% · [setup_grade]
- MTF: HTF [score] / LTF [score] — [ONE short sentence on convergence or divergence]
- Swing Consensus: [direction, strength, aligned TFs]
- Signals: [up to 4 flags, comma-separated]

**Levels** (TF in parens, one line each. Every number paired with a benchmark — ATR% of price, distance from 20-day avg, etc.):
- S: $XXX (D), $XXX (4H)
- R: $XXX (W), $XXX (D)
- Range: $LOW–$HIGH — [how long we've been here]
- Gap: $XXX–$XXX (4H)

**Game Plan** (one bullet per case, each ≤ 20 words):
- Bull: Above $XXX → $XXX → $XXX (confirm by 10:30)
- Bear: Below $XXX → $XXX → $XXX
- Base: [expected range, most likely path, one risk note]

### Section 4: "Futures Reference" (2 lines total — no sub-bullets)
- **ES**: ATR $X.XX · O/N $LOW–$HIGH · Bull above $XXXX → $XXXX · Bear below $XXXX → $XXXX
- **NQ**: ATR $X.XX · O/N $LOW–$HIGH · Bull above $XXXXX → $XXXXX · Bear below $XXXXX → $XXXXX

### Section 5: "Open Positions" (only if trades are provided, 1 bullet per trade)
Format: TICKER LONG/SHORT @ $entry · P&L +X.X% · HOLD/TRIM/EXIT — ≤15 words why.

### Section 6: "Macro & Cross-Asset" (3-4 bullets, one line each)
Connect VIX, crude, gold, TLT, dollar, or sector breadth to the equity thesis. No standalone commentary.

### Section 7: "Week Ahead" (1-2 sentences, HARD CAP)
Editorialized header like "## Week Ahead: CPI Decides". Where we likely close the week + the single biggest catalyst to watch.

### Section 8: "Trade what's there" (CLOSING BOOKEND — 1-2 sentences + P.S.)
Always close with a decisive one-liner that doesn't reference specific levels — a principle the reader can carry into their day. Examples: "Trade what's there, not what you hope for." / "The range will break when it breaks. Not a minute sooner." / "When in doubt, smaller size."

End with a **P.S.** containing ONE of: the biggest event on the calendar this week, a notable trade that's been running in the book, or a single chart callout worth watching. ≤ 2 sentences.

CRITICAL: Do NOT wrap levels in long explanatory prose. Levels must be scannable at a glance. When the market is range-bound, acknowledge it in one sentence — don't force a directional bias.

## Opinion-First Rules (copy Prof G's spine, not his swagger):
- Every section ends with a **prediction or decisive take**, not a summary. "Synergies is Latin for layoffs" energy.
- **Coin one branded phrase per brief** for today's regime and use it 2-3 times as a throughline ("the ketamine tape", "breadth mirage", "melting-ice-cube rally", "trapdoor day"). Make it memorable, not corny.
- Enumerate with "First … Second … Third …" when giving reasons. It's scannable and it commits you.
- Pair every number with a benchmark. "SPY ATR $8.12 (1.38% of price, elevated vs. the 30-day $6.80 avg)" beats "SPY ATR $8.12".
- One-sentence paragraphs are allowed and encouraged for emphasis ("Bold." "Full stop." "Trade it, don't trust it.").
- NEVER use finance-advisor hedging ("it's worth noting", "one might consider", "subject to market conditions"). Be direct.

## Timed Trading Model Reference (how to interpret the signals):

### Scoring Signals:
- **state**: LONG (bullish setup aligned), SHORT (bearish), WATCH (neutral/transitional), FLAT (no signal)
- **htf_score**: Higher-Timeframe score. Above +15 = strong bullish trend, below -15 = bearish. Near 0 = directionless.
- **ltf_score**: Lower-Timeframe score. Divergence between HTF and LTF flags a potential pivot (e.g. HTF bearish but LTF turning positive = early reversal attempt).
- **phase_zone**: "markup" (trending up), "distribution" (topping), "markdown" (trending down), "accumulation" (bottoming), "recovery" (early reversal).
- **phase_pct**: Move completion (0-100%). Below 25% = early, join the trend. 50-75% = maturing, manage risk. Above 75% = extended, expect mean reversion.
- **regime**: TRENDING / CHOPPY / TRANSITIONAL / STRONG_BULL / STRONG_BEAR / EARLY_BULL / EARLY_BEAR / etc. This changes how aggressive the plan should be.
- **rank**: Relative strength score. Higher = stronger vs the universe.
- **setup_grade**: "Prime" (full multi-TF alignment, highest conviction), "Confirmed" (solid), "Early" (speculative, smaller size).

### Multi-Timeframe Technicals (USE THESE — they reveal the true picture):
- **SuperTrend (ST)**: Direction per TF. When Bull across all TFs = strong trend. When mixed (e.g. Bull on 15m, Bear on 4H) = counter-trend bounce or reversal forming.
- **RSI**: Overbought >70, oversold <30 on each TF. Use to calibrate entries: RSI oversold on LTF during a bullish HTF = buy-the-dip setup.
- **EMA Structure**: Positive = bullish alignment (price above stacked EMAs), negative = bearish. Depth = how many EMA layers are aligned.
- **Squeeze**: Bollinger inside Keltner channel = coiling energy. RELEASE with direction tells you where the breakout is headed.
- **Ripster Cloud**: Above = bullish momentum, Below = bearish, InCloud = transitional.
- **Swing Consensus**: Aggregated directional agreement across timeframes. "Bullish, Strong, 4/5 aligned" = high conviction.

### How to synthesize:
1. Start with the REGIME — it sets the baseline (trending = follow, choppy = fade extremes, transitional = be nimble).
2. Check HTF vs LTF alignment — convergence = high conviction, divergence = caution or potential turning point.
3. Read the multi-TF SuperTrend and RSI — these tell you if the short-term and long-term are on the same page.
4. Use Phase to calibrate sizing and aggression — early phase = full size, late phase = defensive.
5. Reference Swing Consensus for final confirmation — if the majority of timeframes agree, lean into it.

CRITICAL: The model data tells the REAL story. When the data says bearish on 4H/D but bullish on 15m, say "short-term bounce within a larger downtrend — trade the bounce with tight stops, not a trend reversal." Be specific about what each TF is telling you.

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

function formatMultiTFContext(sym, mkt) {
  if (!mkt) return `${sym}: No data available.`;
  const lines = [`**${sym}** — $${mkt.price} (${mkt.dayChangePct >= 0 ? "+" : ""}${mkt.dayChangePct?.toFixed(2) || "0.00"}%)`];
  lines.push(`  Model: State=${mkt.state || "N/A"} | HTF=${mkt.htf_score} | LTF=${mkt.ltf_score} | Phase=${mkt.phase_zone || "N/A"} (${mkt.phase_pct || 0}%) | Regime=${mkt.regime || "N/A"} | Grade=${mkt.setup_grade || "N/A"} | Rank=${mkt.rank}`);

  const sc = mkt.swing_consensus;
  if (sc) {
    lines.push(`  Swing Consensus: Direction=${sc.direction || "N/A"} | Strength=${sc.strength || "N/A"} | Score=${sc.score ?? "N/A"} | Aligned TFs=${sc.aligned_count ?? "N/A"}/${sc.total_count ?? "N/A"}`);
  }

  const tf = mkt.tf_tech;
  if (tf) {
    const tfs = ["15", "30", "1H", "4H", "D"];
    const tfLines = [];
    for (const t of tfs) {
      const d = tf[t] || tf[t.toLowerCase()];
      if (!d) continue;
      const parts = [];
      const stDir = d.stDir;
      if (stDir !== undefined) parts.push(`ST=${stDir === -1 || stDir === "bull" ? "Bull" : stDir === 1 || stDir === "bear" ? "Bear" : "Flat"}`);
      if (d.rsi?.r5 != null) parts.push(`RSI=${Math.round(d.rsi.r5)}`);
      if (d.ema?.structure != null) parts.push(`EMA-Str=${Number(d.ema.structure).toFixed(2)}`);
      if (d.ema?.depth != null) parts.push(`EMA-Depth=${d.ema.depth}`);
      if (d.ph?.v != null) parts.push(`Phase=${Number(d.ph.v).toFixed(1)}`);
      const sq = d.squeeze;
      if (sq?.active) parts.push("SQUEEZE");
      if (sq?.release) parts.push(`RELEASE-${sq.releaseDir || "?"}`);
      if (d.ripster?.c72_89?.above) parts.push("Ripster-Above");
      else if (d.ripster?.c72_89?.below) parts.push("Ripster-Below");
      else if (d.ripster?.c72_89?.inCloud) parts.push("Ripster-InCloud");
      if (parts.length > 0) tfLines.push(`    ${t}: ${parts.join(" | ")}`);
    }
    if (tfLines.length > 0) {
      lines.push(`  Multi-TF Technicals:`);
      lines.push(...tfLines);
    }
  }

  const flags = mkt.flags;
  if (flags && typeof flags === "object") {
    const active = Object.entries(flags).filter(([, v]) => v).map(([k]) => k);
    if (active.length > 0) lines.push(`  Active Flags: ${active.join(", ")}`);
  }
  return lines.join("\n");
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
${(() => {
  const keys = ["SPY", "QQQ", "ES", "NQ", "VIX", "IWM", "DIA", "TLT", "GLD", "SLV", "USO", "XLE", "XLF", "XLK", "XLV", "XLI", "XLP", "XLU", "XLB", "XLRE", "XLY", "XLC"];
  const slim = {};
  for (const k of keys) { if (data.market?.[k]) slim[k] = data.market[k]; }
  return JSON.stringify(slim);
})()}

## Price Feed Cross-Reference (TwelveData cron — GROUND TRUTH for daily changes):
${data.priceFeedCrossRef || "Unavailable."}
NOTE: If Market Data and Price Feed disagree on daily change by >1%, trust the Price Feed values. The scoring model payload may be stale from backtesting.

## Cross-Asset Context (USE for Newton-style correlated analysis):
${data.crossAssetContext || "Not available — skip cross-asset section."}
IMPORTANT: If crude, gold, TLT, or VIX are making notable moves (>1%), LEAD with the cross-asset story and explain the equity implications.

## Timed Trading Full Signal Context (MUST reference — this is what our system sees across timeframes):
${["SPY", "QQQ", "ES", "NQ", "VIX", "IWM"].map(sym => formatMultiTFContext(sym, data.market?.[sym])).join("\n\n")}

CRITICAL: Use this multi-timeframe data to paint the REAL picture. If SuperTrend is bearish on 4H and Daily but RSI is oversold on 15m/30m, that's a "pullback within a downtrend" — say so. If EMA structure is strongly positive across all TFs, the trend is intact despite any single-bar weakness. Reference specific TF signals, not just HTF/LTF scores.

## Multi-Day Change Summary (USE THESE for "dropped X% over Y sessions" statements):
${(() => {
  const _summaries = [];
  for (const [_lbl, _tech] of [["ES", data.esTechnical], ["NQ", data.nqTechnical], ["SPY", data.spyTechnical], ["QQQ", data.qqqTechnical], ["IWM", data.iwmTechnical]]) {
    if (!_tech?.structureContext) continue;
    const _sc = _tech.structureContext;
    const _mk = data.market?.[_lbl];
    const _dp = _mk?.dayChangePct;
    _summaries.push(_lbl + ": Today=" + (typeof _dp === "number" ? (_dp >= 0 ? "+" : "") + _dp.toFixed(2) + "%" : "N/A") + " | 5-day=" + (_sc.fiveDayChangePct != null ? (_sc.fiveDayChangePct >= 0 ? "+" : "") + _sc.fiveDayChangePct.toFixed(2) + "% ($" + (_sc.fiveDayChange ?? "N/A") + ")" : "N/A") + " | Trend=" + (_sc.trendBias || "N/A") + " | 10d-range: $" + (_sc.tenDaySwingLow ?? "?") + "-$" + (_sc.tenDaySwingHigh ?? "?"));
  }
  return _summaries.length > 0 ? _summaries.join("\n") : "Unavailable.";
})()}
IMPORTANT: When stating "X dropped Y% over Z sessions", use the 5-day values above. For single-day moves, use the Today value. NEVER estimate or calculate percentages yourself.

## ES Technical Summary (futures):
${JSON.stringify(data.esTechnical)}

## NQ Technical Summary (futures):
${JSON.stringify(data.nqTechnical)}

## SPY Technical Summary (ETF):
${JSON.stringify(data.spyTechnical)}

## QQQ Technical Summary (ETF):
${JSON.stringify(data.qqqTechnical)}

## IWM Technical Summary (Russell 2000 ETF):
${JSON.stringify(data.iwmTechnical)}

## Key Levels & Game Plan — LEAD WITH SMC LEVELS (where price ACTUALLY reacted):
Resistance Ceilings = recent highs where sellers stepped in (BSL). Support Floors = recent lows where buyers appeared (SSL). FVGs = unfilled gaps price often revisits. ALWAYS state the timeframe.
ATR Fib levels are SECONDARY intraday targets. ORB levels (Opening Range High/Low/Mid) add intraday context after the open — if available from the model, include them.

### Game Plan Triggers:
${(() => {
  const lines = [];
  for (const [sym, tech] of [["ES", data.esTechnical], ["NQ", data.nqTechnical], ["SPY", data.spyTechnical], ["IWM", data.iwmTechnical]]) {
    const gp = tech?.atrFibLevels?.gamePlan;
    if (!gp) continue;
    lines.push(`${sym} Bull: above ${gp.bullTrigger} → ${gp.bullTarget} | Bear: below ${gp.bearTrigger} → ${gp.bearTarget}`);
  }
  return lines.length > 0 ? lines.join("\n") : "Use SMC support/resistance levels as triggers.";
})()}
ABSOLUTE RULE: Bearish targets MUST be LOWER than triggers. Bullish targets MUST be HIGHER.

### SPY Key Levels:
${formatSMCForPrompt(data.spyTechnical?.smcLevels)}

### QQQ Key Levels:
${formatSMCForPrompt(data.qqqTechnical?.smcLevels)}

### IWM Key Levels (Russell 2000):
${formatSMCForPrompt(data.iwmTechnical?.smcLevels)}

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
        return `${p.ticker}: ${p.shares} shares @ avg $${p.avgEntry != null ? p.avgEntry.toFixed(2) : "N/A"} (Current: $${_price > 0 ? _price.toFixed(2) : "N/A"}, Today: ${_dayPct !== 0 ? (_dayPct >= 0 ? "+" : "") + _dayPct.toFixed(2) + "%" : "N/A"}, Total Return: ${_unrealPct ? (_unrealPct >= 0 ? "+" : "") + _unrealPct + "%" : "N/A"}, Stage: ${p.stage || "N/A"}${p.archetype ? `, Archetype: ${p.archetype}` : ""}${p.policy ? `, Policy: ${p.policy}` : ""}${p.addOn ? `, Add-on: ${p.addOn}` : ""}${p.riskNote ? `, Risk: ${p.riskNote}` : ""}${p.thesis ? `, Thesis: ${p.thesis.slice(0, 80)}` : ""})`;
      }).join("\n")
    : "No investor positions."}

STYLE RULES: Be direct and actionable. No filler. Every sentence must inform a trading decision. Target ~800 words total.

## Required Sections (IN THIS ORDER):

1. **Market Context** (~150 words) — LEAD WITH THIS. Combine macro backdrop + cross-asset + VIX into one concise picture.
   - Macro regime in one sentence ("Risk-off: selling stocks, buying safe havens").
   - Today's key catalyst (CPI/FOMC/NFP/earnings) — what it means in plain English.
   - VIX level and implication. Cross-asset moves (crude, gold, TLT) if notable (>1%).
   - SPY/QQQ/IWM pre-market snapshot and multi-day trend.
   - Breadth: sectors green vs red, broad or concentrated.

2. **Structure & Scenarios (SPY, QQQ, IWM)** (~100 words each) — Technical heart:
   - Big picture: pullback, breakdown, or consolidation?
   - Key support/resistance ZONES (use SMC levels from data, always state timeframe).
   - Bull/Bear/Base case with specific levels.
   - Futures equivalent (ES/NQ) in parentheses.

3. **Key Levels & Game Plan** (~80 words) — Specific numbers for today:
   - Lead with SMC support/resistance levels (these are where price actually reacted). ATR levels are secondary targets.
   - ORB levels add intraday context after the open.
   - Golden Gate status if applicable.
   - Game plan: bull/bear triggers and targets. ABSOLUTE RULE: bearish targets MUST be LOWER than triggers, bullish targets MUST be HIGHER.
   - Note major data release timing.

4. **Earnings Watch** (~60 words, only if material) — Key earnings today/this week with current price and daily change.

5. **Sector & Themes** (~80 words) — Leading/lagging sectors, WHY (map to drivers), rotation signals, seasonal patterns, breadth.

6. **Active Trader Book** (~80 words) — For each position: ticker, direction, grade, today's change%, P&L, thesis status, action (hold/trim/tighten). New entries and exits briefly noted.

7. **Investor Portfolio** (~80 words) — Each holding: ticker, today's change%, total return%, thesis status. DCA opportunities if any.

End with THREE clear sections:
- **ES Prediction**: One specific, falsifiable prediction for ES. Include expected range.
- **Key Levels to Watch (SPY/QQQ/IWM)**: 3-5 most important levels across all three. For each, plain English: "580 — Support floor (daily). Below 580 → acceleration to 573."
- **Risk Factors**: 1-2 key risks in plain English.`;
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
${(() => {
  const keys = ["SPY", "QQQ", "ES", "NQ", "VIX", "IWM", "DIA", "TLT", "GLD", "SLV", "USO", "XLE", "XLF", "XLK", "XLV", "XLI", "XLP", "XLU", "XLB", "XLRE", "XLY", "XLC"];
  const slim = {};
  for (const k of keys) { if (data.market?.[k]) slim[k] = data.market[k]; }
  return JSON.stringify(slim);
})()}

## Price Feed Cross-Reference (TwelveData cron — GROUND TRUTH for daily changes):
${data.priceFeedCrossRef || "Unavailable."}
NOTE: If Market Close Data and Price Feed disagree on daily change by >1%, trust the Price Feed values. The scoring model payload may be stale from backtesting.

## Cross-Asset Context (USE for Newton-style correlated analysis):
${data.crossAssetContext || "Not available — skip cross-asset section."}
IMPORTANT: If crude, gold, TLT, or VIX made notable moves today (>1%), highlight the cross-asset story and explain how it drove or correlated with equity action.

## Timed Trading Full Signal Context at Close (MUST reference — this is what our system sees across timeframes):
${["SPY", "QQQ", "ES", "NQ", "VIX", "IWM"].map(sym => formatMultiTFContext(sym, data.market?.[sym])).join("\n\n")}
CRITICAL: Use the multi-timeframe data to explain WHY the session played out the way it did. Reference specific TF signals (SuperTrend flips, RSI extremes, EMA structure changes) to tell the story of what happened.

## Multi-Day Change Summary (USE THESE for "dropped X% over Y sessions" statements):
${(() => {
  const _s2 = [];
  for (const [_l2, _t2] of [["ES", data.esTechnical], ["NQ", data.nqTechnical], ["SPY", data.spyTechnical], ["QQQ", data.qqqTechnical], ["IWM", data.iwmTechnical]]) {
    if (!_t2?.structureContext) continue;
    const _c2 = _t2.structureContext;
    const _m2 = data.market?.[_l2];
    const _d2 = _m2?.dayChangePct;
    _s2.push(_l2 + ": Today=" + (typeof _d2 === "number" ? (_d2 >= 0 ? "+" : "") + _d2.toFixed(2) + "%" : "N/A") + " | 5-day=" + (_c2.fiveDayChangePct != null ? (_c2.fiveDayChangePct >= 0 ? "+" : "") + _c2.fiveDayChangePct.toFixed(2) + "% ($" + (_c2.fiveDayChange ?? "N/A") + ")" : "N/A") + " | Trend=" + (_c2.trendBias || "N/A"));
  }
  return _s2.length > 0 ? _s2.join("\n") : "Unavailable.";
})()}
IMPORTANT: When stating "X dropped Y% over Z sessions", use the 5-day values above. For single-day moves, use the Today value. NEVER estimate or calculate percentages yourself.

## ES Technical Summary (futures):
${JSON.stringify(data.esTechnical)}

## NQ Technical Summary (futures):
${JSON.stringify(data.nqTechnical)}

## SPY Technical Summary (ETF):
${JSON.stringify(data.spyTechnical)}

## QQQ Technical Summary (ETF):
${JSON.stringify(data.qqqTechnical)}

## IWM Technical Summary (Russell 2000 ETF):
${JSON.stringify(data.iwmTechnical)}

## Key Levels — Support Floors & Resistance Ceilings:
ALWAYS state the timeframe when referencing levels. SPY/QQQ/IWM first, then futures equivalents.

### SPY Key Levels:
${formatSMCForPrompt(data.spyTechnical?.smcLevels)}

### QQQ Key Levels:
${formatSMCForPrompt(data.qqqTechnical?.smcLevels)}

### IWM Key Levels (Russell 2000):
${formatSMCForPrompt(data.iwmTechnical?.smcLevels)}

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
        return `${p.ticker}: ${p.shares} shares @ avg $${p.avgEntry != null ? p.avgEntry.toFixed(2) : "N/A"} (Close: $${_price > 0 ? _price.toFixed(2) : "N/A"}, Today: ${_dayPct !== 0 ? (_dayPct >= 0 ? "+" : "") + _dayPct.toFixed(2) + "%" : "N/A"}, Total Return: ${_unrealPct ? (_unrealPct >= 0 ? "+" : "") + _unrealPct + "%" : "N/A"}, Stage: ${p.stage || "N/A"}${p.archetype ? `, Archetype: ${p.archetype}` : ""}${p.policy ? `, Policy: ${p.policy}` : ""}${p.addOn ? `, Add-on: ${p.addOn}` : ""}${p.riskNote ? `, Risk: ${p.riskNote}` : ""}${p.thesis ? `, Thesis: ${p.thesis.slice(0, 80)}` : ""})`;
      }).join("\n")
    : "No investor positions."}

STYLE RULES: Be direct and actionable. No filler. Every sentence must inform a trading decision. Target ~800 words total.

## Required Sections (IN THIS ORDER):

1. **Session Recap & Context** (~150 words) — LEAD WITH THIS. Combine macro drivers + cross-asset + VIX into one picture.
   - What drove today: narrative theme in one sentence.
   - Key data releases: actual vs consensus in plain English.
   - VIX close and implication for tomorrow. Cross-asset moves if notable.
   - SPY/QQQ/IWM: close vs open, character of the move, breadth.

2. **ES Prediction Scorecard** (~30 words) — Grade morning prediction: HIT, PARTIAL, or MISS. One sentence.

3. **Structural Update (SPY, QQQ, IWM)** (~100 words each) — Did today confirm or negate the thesis?
   - Key levels tested (use SMC levels, state timeframe).
   - Updated bull/bear thresholds for tomorrow.
   - Futures equivalents in parentheses.

4. **Session Review & Levels** (~60 words) — ATR performance, actual vs expected range. After-hours earnings if material.

5. **Sector & Themes** (~60 words) — Leading/lagging and WHY. Rotation signals, breadth verdict.

6. **Looking Ahead** (~80 words) — Primary thesis for next 1-3 sessions with specific SPY/QQQ/IWM levels and time dimension.

7. **Active Trader Report** (~80 words) — Each position: ticker, today's change%, P&L, thesis status, action. Entries/exits/trims briefly.

8. **Investor Portfolio** (~80 words) — Each holding: ticker, today's change%, total return%, thesis status. DCA opportunities.

End with TWO sections:
- **Key Levels to Watch (SPY/QQQ/IWM)**: 3-5 most important levels across all three. Plain English.
- **Risk Factors**: 1-2 key risks for tomorrow.`;
}

/**
 * Call OpenAI to generate a daily brief.
 * @returns {string} Markdown content
 */
async function callOpenAI(env, systemPrompt, userPrompt) {
  const apiKey = env?.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const model = env?.DAILY_BRIEF_MODEL || "gpt-5.4";
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
      max_completion_tokens: 4000,
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
  const iwmFib = data.iwmTechnical?.atrFibLevels;
  if (esFib?.levels) fields.push(fmtFib(esFib, "ES / SPX Day Trader Levels"));
  if (spyFib?.levels) fields.push(fmtFib(spyFib, "SPY Day Trader Levels"));
  if (nqFib?.levels) fields.push(fmtFib(nqFib, "NQ Day Trader Levels"));
  if (iwmFib?.levels) fields.push(fmtFib(iwmFib, "IWM Day Trader Levels"));
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
/**
 * Build a compact structured snapshot that the Daily Brief UI renders
 * as an infographic above the markdown body. Surfaces the same data the
 * AI sees so users can glance the regime without reading the wall.
 *
 * Shape is intentionally small and UI-friendly:
 *   {
 *     headline: { date, type, regime, vixLevel, vixBucket, breadthGreen, breadthTotal },
 *     indices: [ { sym, price, chgPct, atr, goldenGate, dayAtr, levels: { "+38.2%": n, ... } } ],
 *     sectors: [ { sym, chgPct, status } ],
 *     macro: [ { label, value, hint } ],
 *     events: [ { date, when, title, severity, kind } ],
 *     risks: [string],
 *     opportunities: [string],
 *   }
 *
 * Everything is derived directly from `data` (already gathered) — no
 * extra API calls.
 */
function buildBriefInfographic(data, type) {
  if (!data || typeof data !== "object") return null;
  const today = String(data.today || "");
  const vixD = data.market?.VIX || {};
  const vixLevel = Number(vixD.price) || Number(vixD.sessionClose) || null;
  const vixBucket = vixLevel == null
    ? null
    : vixLevel < 15 ? "calm"
      : vixLevel < 20 ? "normal"
        : vixLevel < 25 ? "elevated"
          : vixLevel < 30 ? "high"
            : "panic";
  const sectors = Array.isArray(data.sectors) ? data.sectors : [];
  const sectorMini = sectors.map(s => {
    const chg = Number(s.changePct ?? s.chgPct ?? s.pct);
    return {
      sym: s.symbol || s.sym,
      chgPct: Number.isFinite(chg) ? Math.round(chg * 100) / 100 : null,
      status: Number.isFinite(chg)
        ? (chg > 0.3 ? "strong" : chg > 0 ? "green" : chg > -0.3 ? "weak" : "red")
        : "unknown",
    };
  }).filter(x => x.sym);
  const breadthGreen = sectorMini.filter(s => (s.chgPct ?? 0) > 0).length;
  const breadthTotal = sectorMini.length;

  const _normLevels = (tech) => {
    if (!tech || !tech.atrFibLevels) return null;
    const l = tech.atrFibLevels;
    return {
      anchor: l.anchor,
      dayAtr: l.dayAtr,
      currentPrice: l.currentPrice,
      goldenGate: l.goldenGate || "NEUTRAL",
      goldenGateNote: l.goldenGateNote || null,
      levels: l.levels || {},
      gamePlan: l.gamePlan || null,
    };
  };
  const _extract = (sym, md, tech) => {
    if (!md) return null;
    const price = Number(md.price);
    const chg = Number(md.changePct ?? md.dp);
    const atr = Number(tech?.atr14 ?? tech?.atr);
    return {
      sym,
      price: Number.isFinite(price) ? Math.round(price * 100) / 100 : null,
      chgPct: Number.isFinite(chg) ? Math.round(chg * 100) / 100 : null,
      atr: Number.isFinite(atr) ? Math.round(atr * 100) / 100 : null,
      levels: _normLevels(tech),
    };
  };
  const indices = [
    _extract("SPY", data.market?.SPY, data.spyTechnical),
    _extract("QQQ", data.market?.QQQ, data.qqqTechnical),
    _extract("IWM", data.market?.IWM, data.iwmTechnical),
  ].filter(Boolean);

  const pf = data.priceFeedRaw || {};
  const _macroFor = (sym, label, hint) => {
    const d = pf[sym];
    if (!d) return null;
    const price = Number(d.p);
    const pct = Number(d.dp);
    if (!Number.isFinite(price)) return null;
    return {
      sym,
      label,
      value: Math.round(price * 100) / 100,
      chgPct: Number.isFinite(pct) ? Math.round(pct * 100) / 100 : null,
      hint: hint || null,
    };
  };
  const macro = [
    vixLevel != null ? { sym: "VIX", label: "VIX", value: Math.round(vixLevel * 100) / 100, bucket: vixBucket, hint: `Volatility ${vixBucket || ""}`.trim() } : null,
    _macroFor("CL1!", "Crude", "Oil > equities rotation cue"),
    _macroFor("GC1!", "Gold", "Risk-off flow"),
    _macroFor("TLT", "Bonds", "Falling TLT = rising yields = tech pressure"),
    _macroFor("DXY", "Dollar", "Stronger USD = multinational headwind"),
  ].filter(Boolean);

  const todayEconomic = (data.todayEconomicEvents || []).slice(0, 6).map(e => ({
    date: (e.date || "").slice(0, 10),
    when: e.time || null,
    title: e.title || e.event || "",
    severity: e.impact || e.severity || "medium",
    kind: "macro",
  }));
  const todayEarnings = (data.todayEarnings || []).slice(0, 8).map(e => ({
    date: today,
    when: e.hour || (e.session === "bmo" ? "Before Open" : e.session === "amc" ? "After Close" : null),
    title: `${(e.ticker || e.symbol || "").toUpperCase()} earnings`,
    severity: "medium",
    kind: "earnings",
  }));
  const events = [...todayEconomic, ...todayEarnings];

  const risks = [];
  const opps = [];
  if (vixBucket === "high" || vixBucket === "panic") risks.push(`VIX ${vixLevel} — wider ranges, reduce size`);
  if (breadthTotal > 0 && breadthGreen <= 3) risks.push(`Narrow breadth: ${breadthGreen}/${breadthTotal} sectors green`);
  if (breadthTotal > 0 && breadthGreen >= 8) opps.push(`Broad breadth: ${breadthGreen}/${breadthTotal} sectors green`);
  for (const idx of indices) {
    if (!idx) continue;
    const gg = idx.levels?.goldenGate;
    if (gg === "OPEN_UP") opps.push(`${idx.sym} Golden Gate OPEN_UP`);
    else if (gg === "OPEN_DOWN") risks.push(`${idx.sym} Golden Gate OPEN_DOWN`);
  }
  for (const e of events) {
    if (e.severity === "high") risks.push(`${e.title} today${e.when ? " @ " + e.when : ""}`);
  }

  const openCount = (data.openTrades || []).length;
  const regime = data.market?.SPY?.regime_class || data.regime_class || null;

  return {
    date: today,
    type,
    generated_at: Date.now(),
    headline: {
      date: today,
      type,
      regime,
      vix: vixLevel != null ? { level: vixLevel, bucket: vixBucket } : null,
      breadth: breadthTotal > 0 ? { green: breadthGreen, total: breadthTotal } : null,
      openTrades: openCount,
    },
    indices,
    sectors: sectorMini,
    macro,
    events,
    risks: risks.slice(0, 5),
    opportunities: opps.slice(0, 5),
  };
}

/**
 * Pull Galloway-style "Today's Three" TOC out of the generated markdown.
 * Expects the model to emit exactly three numbered lines near the top
 * ("1. SPY/QQQ regime: …") — if it doesn't, returns null and the
 * infographic falls back to the metric badges.
 */
function extractTopThree(content) {
  if (!content || typeof content !== "string") return null;
  const head = content.slice(0, 1600);
  // Capture the first three consecutive "1." / "2." / "3." lines
  // anywhere in the leading section (tolerates optional bold/emph).
  const lines = head.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const picks = [];
  for (const line of lines) {
    const m = line.match(/^([123])\.\s*\*{0,2}(.+?)\*{0,2}\s*$/);
    if (!m) continue;
    const num = Number(m[1]);
    if (num !== picks.length + 1) continue;
    const text = m[2].replace(/^[-\s*_]+/, "").trim();
    if (text.length < 3) continue;
    // Split label/punchline on first colon if present
    const ci = text.indexOf(":");
    const label = ci > 0 ? text.slice(0, ci).trim() : null;
    const body = ci > 0 ? text.slice(ci + 1).trim() : text;
    picks.push({ n: num, label, body });
    if (picks.length === 3) break;
  }
  return picks.length === 3 ? picks : null;
}

/** Extract the closing one-liner ("Trade what's there, not what you hope for.") */
function extractClosingLine(content) {
  if (!content || typeof content !== "string") return null;
  const tail = content.slice(-800);
  // Look for a line after a section 8 header or directly before P.S.
  const psIdx = tail.search(/\n\s*\*?\*?P\.S\.?/i);
  const zone = psIdx > 0 ? tail.slice(0, psIdx) : tail;
  const lines = zone.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // Take the last non-header line that looks like a decisive statement
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l)) continue;
    if (/^[-*]\s/.test(l)) continue;
    if (l.length < 20 || l.length > 140) continue;
    return l.replace(/^\*+|\*+$/g, "").trim();
  }
  return null;
}

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
        console.warn(`[DAILY BRIEF] ES sessionClose missing (source: ${data.market.ES.sessionCloseSource}), falling back to live price`);
        esClose = Number(data.market.ES.price);
      }
      // Guard: if the live price diverges significantly from SPY-implied ES
      // (extended-hours drift), prefer the last known RTH-session price
      if (Number.isFinite(esClose) && data.market.SPY?.sessionClose) {
        const spyClose = Number(data.market.SPY.sessionClose);
        if (Number.isFinite(spyClose) && spyClose > 0) {
          const impliedES = spyClose * 10;
          const drift = Math.abs(esClose - impliedES) / impliedES;
          if (drift > 0.005) {
            console.warn(`[DAILY BRIEF] ES close ${esClose} drifts ${(drift * 100).toFixed(2)}% from SPY-implied ${impliedES.toFixed(0)} — possible extended-hours price`);
          }
        }
      }
    }

    const now = Date.now();
    const briefId = `${data.today}-${type}`;

    // 5. Store in KV (current brief + structured infographic snapshot)
    let infographic = null;
    try {
      infographic = buildBriefInfographic(data, type);
      // Extract Galloway-style "Today's Three" TOC from the markdown so the
      // infographic headline strip can render it as 3 punchy badges above
      // the body. The prompt asks the model to emit exactly:
      //   1. SPY/QQQ regime: …
      //   2. Sector rotation: …
      //   3. Today's catalyst: …
      // We grep the first 800 chars for the numbered list and expose it.
      if (infographic) {
        infographic.topThree = extractTopThree(content);
        infographic.closingLine = extractClosingLine(content);
      }
    } catch (e) {
      console.warn("[DAILY BRIEF] infographic build error:", String(e).slice(0, 120));
    }
    const current = (await kvGetJSON(KV, "timed:daily-brief:current")) || {};
    current[type] = {
      id: briefId,
      date: data.today,
      type,
      content,
      esPrediction,
      publishedAt: now,
      infographic,
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

    // 7b. Persist structured market snapshot + events for CIO episodic memory
    if (db) {
      const _pf = data.priceFeedRaw || {};
      persistDailyMarketSnapshot(env, data, _pf, esPrediction, content).catch(e =>
        console.warn("[DAILY BRIEF] Snapshot persistence error:", String(e).slice(0, 100))
      );
      persistMarketEvents(env, data, _pf).catch(e =>
        console.warn("[DAILY BRIEF] Events persistence error:", String(e).slice(0, 100))
      );
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
      if (optedInUsers.length) {
        const briefPayload = { type, content, date: data.today, esPrediction };
        const results = await Promise.allSettled(
          optedInUsers.map(u => sendDailyBriefEmail(env, u.email, briefPayload))
        );
        const sent = results.filter(r => r.status === "fulfilled" && r.value?.ok).length;
        const failed = results.length - sent;
        console.log(`[DAILY BRIEF] ${prefKey} emails: ${sent} sent, ${failed} failed (${optedInUsers.length} recipients)`);
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

const INTRADAY_SYSTEM_PROMPT = `You are a veteran market technician writing real-time flash insights for active traders — think Mark Newton at Fundstrat. You've traded through every market cycle and you call it like you see it. Your insights land in a live feed that traders check throughout the session.

## Your Voice
First-person, authoritative, direct. You have a view and you own it.
- "We're seeing crude back off about $3 from highs while both the dollar and yields are lower. Sectors like Financials, Energy, and Discretionary are all up over 1% — 10 of 11 sectors are higher today."
- "SPX remains part of the current downtrend from late February which would require SPX to exceed 6775 to have confidence of a larger rally. Structurally, 6845 is the line in the sand."
- "This looks premature, and I expect the bounce likely will stall out by end of week, technically speaking."

## Cross-Asset Storytelling (CRITICAL — this is what separates you)
ALWAYS connect the dots. Every equity move has a cause — find it:
- **Crude Oil (CL1!)**: If crude is moving >1%, LEAD with it. "WTI crude's peak last Sunday looks to extend down to $89-90 this week before stabilizing and pushing back to $105-115 over the next few weeks. The next 2-3 days look bearish for crude, and should coincide with equities pushing even higher by end of week."
- **Gold (GC1!)**: Risk barometer. "Gold breaking above $2,350 tells me the market is seeking safety — not the time for aggressive equity longs."
- **Treasury Yields / TLT**: Rate narrative. "Yields falling with TLT rallying = tailwind for growth/tech. If TLT is moving, explain why and what it means for SPY/QQQ."
- **VIX (VX1!)**: ALWAYS referenced. "VIX at 22 and declining says the fear is dissipating — supportive of further equity gains near-term."
- **Dollar**: "Both the US Dollar and Treasury yields are lower — that's a setup for risk assets to push higher."
- **Sector breadth**: "10 of 11 sectors higher, only Industrials lagging due to JBHT, RTX weakness. That's broad-based buying."

## Technical Precision
- Name specific patterns with timeframe and level: "SPY forming a descending triangle on the 1H with support at 565 and descending resistance from 582."
- Reference the TT scoring model signals: "Our model has SPY in markdown phase at 72% completion with HTF at -18 — telling me the downtrend is maturing but not yet exhausted."
- Reference swing levels, regime, and multi-TF alignment when the data supports it.
- When the TT Universe has notable movers, call them out: "Top movers in our universe today: NVDA +3.2%, TSLA +2.8% — tech is leading this bounce."

## Expectation Management
Don't overpromise. If we're in a range, say so:
- "The bigger pattern still likely leads up next week, but I expect it will prove to be negative for equities into early April before resolution."
- "This bounce will likely stall by end of week — technically, SPX needs to clear 6775 before I'm confident in a larger rally."

## Format
Write 2-4 tight paragraphs (300-500 words total):
1. **Lead with the cross-asset story** — what's driving the tape right now? Connect crude, gold, yields, dollar, VIX to equities.
2. **Equity action + TT model context** — how are SPY/QQQ/ES/NQ responding? What's the regime? What is phase telling us? Any notable TT universe movers?
3. **Levels and near-term outlook** — specific prices, timeframe for the view (next 1-3 sessions). What's the invalidation?
4. **The one thing to watch** — what would change the thesis?

## Rules
- Use ONLY provided data. If a field is null, skip it — never fabricate.
- ALWAYS include VIX context.
- ALWAYS reference specific price levels.
- Do NOT use emojis. Markdown headers sparingly (one ## at most for a section break).
- Keep under 500 words — this is a flash, not a brief.
- Be concise, be specific, be Newton.`;


function buildIntradayPrompt(data) {
  const lines = [];
  lines.push(`## Intraday Flash — ${data.today} at ${data.currentTimeET}`);
  lines.push("");

  // Cross-asset prices (crude, gold, VIX, yields, dollar, sectors)
  if (data.priceFeedCrossRef) {
    lines.push("### Real-Time Prices (Ground Truth)");
    lines.push(data.priceFeedCrossRef);
    lines.push("");
  }

  if (data.crossAssetContext) {
    lines.push("### Cross-Asset Context (Crude, Gold, TLT, VIX, IWM)");
    lines.push(data.crossAssetContext);
    lines.push("");
  }

  // Full multi-TF signal context for key tickers
  lines.push("### TT Model Signal Context");
  const keyTickers = ["SPY", "QQQ", "ES", "NQ", "VIX", "IWM"];
  for (const sym of keyTickers) {
    const m = data.market?.[sym] || data.market?.[sym + "1!"];
    if (!m) continue;
    lines.push(formatMultiTFContext(sym, m));
    lines.push("");
  }

  // Sector heatmap — how many sectors are green vs red
  if (data.sectors) {
    lines.push("### Sector Breadth");
    lines.push(typeof data.sectors === "string" ? data.sectors : JSON.stringify(data.sectors, null, 1));
    lines.push("");
  }

  // TT Universe top movers
  if (data.ttUniverseMovers) {
    lines.push("### TT Universe Notable Movers");
    lines.push(data.ttUniverseMovers);
    lines.push("");
  }

  // SPY/QQQ technical with levels
  if (data.spyTechnical) {
    const spyTech = typeof data.spyTechnical === "string" ? data.spyTechnical : JSON.stringify(data.spyTechnical, null, 1);
    lines.push("### SPY Technical Levels");
    lines.push(spyTech.slice(0, 2000));
    lines.push("");
  }
  if (data.qqqTechnical) {
    const qqqTech = typeof data.qqqTechnical === "string" ? data.qqqTechnical : JSON.stringify(data.qqqTechnical, null, 1);
    lines.push("### QQQ Technical Levels");
    lines.push(qqqTech.slice(0, 2000));
    lines.push("");
  }
  if (data.iwmTechnical) {
    const iwmTech = typeof data.iwmTechnical === "string" ? data.iwmTechnical : JSON.stringify(data.iwmTechnical, null, 1);
    lines.push("### IWM Technical Levels");
    lines.push(iwmTech.slice(0, 2000));
    lines.push("");
  }

  // Multi-day change context for continuity
  const _mdLines = [];
  for (const [_lbl, _tech] of [["SPY", data.spyTechnical], ["QQQ", data.qqqTechnical], ["IWM", data.iwmTechnical]]) {
    const sc = typeof _tech === "object" ? _tech?.structureContext : null;
    const _mk = data.market?.[_lbl];
    if (sc && _mk) {
      _mdLines.push(`${_lbl}: Today=${typeof _mk.dayChangePct === "number" ? (_mk.dayChangePct >= 0 ? "+" : "") + _mk.dayChangePct.toFixed(2) + "%" : "?"} | 5d=${sc.fiveDayChangePct != null ? (sc.fiveDayChangePct >= 0 ? "+" : "") + sc.fiveDayChangePct.toFixed(2) + "%" : "?"} | Trend=${sc.trendBias || "?"} | 10d Range: $${sc.tenDaySwingLow || "?"}-$${sc.tenDaySwingHigh || "?"}`);
    }
  }
  if (_mdLines.length > 0) {
    lines.push("### Multi-Day Context");
    lines.push(..._mdLines);
    lines.push("");
  }

  // Morning brief for continuity
  if (data.morningContent) {
    lines.push("### Morning Brief (for continuity — reference what was expected and compare to what's happened)");
    lines.push(data.morningContent.slice(0, 1000));
    lines.push("");
  }

  // Active trades
  const openCount = data.openTrades?.length || 0;
  if (openCount > 0) {
    lines.push(`### Active Trades (${openCount} open)`);
    for (const t of data.openTrades.slice(0, 10)) {
      lines.push(`- ${t.ticker} ${t.direction} entry=$${t.entry_price?.toFixed?.(2) || "?"} pnl=${t.pnl_pct?.toFixed?.(1) || "?"}%`);
    }
    lines.push("");
  }

  lines.push("Write the flash insight. Lead with the cross-asset story driving the tape. Connect to equity action using our model signals. Give specific levels and a clear 1-3 session outlook. Under 500 words.");
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
          data.morningContent = morningRow.content.slice(0, 1000);
        }
      } catch (_) {}
    }

    // Gather TT universe top movers from timed:prices KV
    try {
      const priceData = await kvGetJSON(KV, "timed:prices");
      if (priceData && typeof priceData === "object") {
        const movers = [];
        const skipTickers = new Set(["SPY", "QQQ", "VX1!", "ES1!", "NQ1!", "VIX", "IWM", "DIA", "XLE", "XLK", "XLF", "XLU", "XLP", "XLY", "XLI", "XLV", "XLB", "XLRE", "XLC", "GLD", "TLT", "CL1!", "GC1!", "SI1!"]);
        for (const [ticker, d] of Object.entries(priceData)) {
          if (skipTickers.has(ticker) || !d || typeof d !== "object") continue;
          const pct = Number(d.dp) || 0;
          const price = Number(d.p) || 0;
          if (price > 0 && Math.abs(pct) > 1.5) {
            movers.push({ ticker, pct, price });
          }
        }
        movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
        const topMovers = movers.slice(0, 10);
        if (topMovers.length > 0) {
          const gainers = topMovers.filter(m => m.pct > 0).map(m => `${m.ticker} $${m.price.toFixed(2)} (+${m.pct.toFixed(1)}%)`);
          const losers = topMovers.filter(m => m.pct < 0).map(m => `${m.ticker} $${m.price.toFixed(2)} (${m.pct.toFixed(1)}%)`);
          const parts = [];
          if (gainers.length > 0) parts.push(`Top Gainers: ${gainers.join(", ")}`);
          if (losers.length > 0) parts.push(`Top Losers: ${losers.join(", ")}`);
          data.ttUniverseMovers = parts.join("\n");
        }
      }
    } catch (_) {}

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
