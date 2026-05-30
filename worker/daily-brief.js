// Daily Brief module — AI-generated morning & evening market analysis
// Publishes to KV (current brief) and D1 (archive), with Finnhub data enrichment.

import { kvGetJSON, kvPutJSON } from "./storage.js";
import { loadCalendar, isEquityHoliday, isEquityEarlyClose } from "./market-calendar.js";
import { sendDailyBriefEmail, getEmailOptedInUsers } from "./email.js";
import { tdFetchQuote } from "./twelvedata.js";
import { getStrategyBrief, STRATEGY_VINTAGE, STRATEGY_TITLE } from "./strategy-context.js";
import { scoreRootConfluence } from "./root-strategy.js";
import { computeFuturesPairsState, summarizeFuturesPairs } from "./futures-pairs.js";

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
    // P0.7.158 (2026-05-14) — extend daily_briefs with structured prediction
    // levels per index so the evening evaluator can compute hit/miss without
    // re-parsing the markdown. Each ALTER is idempotent (try/catch). Added
    // as user-requested deferred item: "Was the Daily Brief Predictions
    // correct?" — surfaces in Mission Control after the 4:30 PM ET evaluator.
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN spy_bull_trigger REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN spy_bull_target  REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN spy_bear_trigger REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN spy_bear_target  REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN qqq_bull_trigger REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN qqq_bull_target  REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN qqq_bear_trigger REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN qqq_bear_target  REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN iwm_bull_trigger REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN iwm_bull_target  REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN iwm_bear_trigger REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN iwm_bear_target  REAL`).run(); } catch {}
    // Open price (used as the reference for hit/miss; defaults to overnight close)
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN spy_open  REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN qqq_open  REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN iwm_open  REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN spy_close REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN qqq_close REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN iwm_close REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN spy_score REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN qqq_score REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN iwm_score REAL`).run(); } catch {}
    try { await db.prepare(`ALTER TABLE daily_briefs ADD COLUMN evaluated_at INTEGER`).run(); } catch {}
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

/**
 * Fetch the day's top general market headlines from Finnhub (no econ
 * keyword filter — these are the broad-market stories a trader would
 * skim before the open). Limited to recent items and major sources.
 * Returns a compact { title, source, url, ts } shape that the daily-brief
 * infographic + email + web renderer all consume directly.
 *
 * Companion to fetchFinnhubMarketNews — that one is narrow (CPI /
 * FOMC / NFP keyword filter) and feeds the LLM prompt. This one is
 * broad and renders verbatim under "Top Headlines" so the user has
 * the editorial context that didn't make it into the econ filter.
 *
 * @returns {Array<{ title, source, url, ts, summary }>}  up to 8 items
 */
export async function fetchFinnhubTopHeadlines(env, sinceTs) {
  const token = env?.FINNHUB_API_KEY;
  if (!token) return [];
  try {
    const url = `${FINNHUB_BASE}/news?category=general&minId=0&token=${token}`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      console.warn(`[FINNHUB HEADLINES] Fetch failed: ${resp.status}`);
      return [];
    }
    const news = await resp.json();
    if (!Array.isArray(news)) return [];

    // Prefer the last 18 hours so the morning brief includes overnight
    // moves and the evening brief includes afternoon news. Falls back
    // to "most recent 30" when sinceTs is missing.
    const cutoffTs = Number.isFinite(sinceTs) && sinceTs > 0
      ? sinceTs
      : Math.floor(Date.now() / 1000) - 18 * 3600;

    // Light source-quality filter — major financial publishers go to
    // the top of the list, niche aggregators get demoted.
    const PRIORITY_SOURCES = new Set([
      "reuters", "bloomberg", "cnbc", "wall street journal", "wsj",
      "financial times", "ft", "marketwatch", "barron's", "barrons",
      "the wall street journal", "yahoo", "yahoo finance",
    ]);
    const scored = news
      .filter(a => Number(a.datetime) >= cutoffTs && a.headline)
      .map(a => {
        const src = String(a.source || "").toLowerCase();
        const priority = PRIORITY_SOURCES.has(src) ? 1 : 0;
        return {
          a,
          score: priority * 10000 + Number(a.datetime || 0),
        };
      })
      .sort((x, y) => y.score - x.score)
      .slice(0, 8);

    // De-dupe near-identical headlines (same first ~40 chars).
    const seen = new Set();
    const out = [];
    for (const { a } of scored) {
      const key = String(a.headline || "").toLowerCase().slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        title: String(a.headline || "").trim(),
        source: a.source || "",
        url: a.url || "",
        ts: Number(a.datetime) || 0,
        summary: String(a.summary || "").trim().slice(0, 200),
      });
    }
    console.log(`[FINNHUB HEADLINES] ${out.length} top headlines (cutoff_ts=${cutoffTs})`);
    return out;
  } catch (e) {
    console.error("[FINNHUB HEADLINES] Error:", String(e).slice(0, 150));
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
    finnhubTopHeadlines,
    ffToday,
    ffYesterday,
    esCandlesH4,
    nqCandlesH4,
    spyCandlesH4,
    qqqCandlesH4,
    iwmCandlesH4,
    esCandlesW,
    spyCandlesW,
    qqqCandlesW,
    iwmCandlesW,
    nqCandlesW,
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
    // 2026-05-22 — Top general headlines (broad market stories, no
    // econ keyword filter). Renders under "Top Headlines" in the
    // brief infographic + email; also injected into the prompt as
    // editorial context.
    fetchFinnhubTopHeadlines(env, Math.floor(Date.now() / 1000) - 18 * 3600),
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
    // Weekly candles for higher-timeframe SMC levels + Saty Multi-Day ATR.
    // P0.7.135 (2026-05-12) — added QQQ/IWM/NQ weekly fetches so the
    // Saty Multi-Day Mode anchor (prior weekly close) and weekly ATR(14)
    // can be computed for every index card. Prior to this, only ES + SPY
    // had weekly bars and QQQ/IWM/NQ silently fell back to the
    // dailyATR·√5 path, which was acceptable but loses precision.
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "ES1!", "W", 20).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "SPY", "W", 20).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "QQQ", "W", 20).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "IWM", "W", 20).catch(() => ({ candles: [] }))
      : Promise.resolve({ candles: [] }),
    db && opts.d1GetCandles
      ? opts.d1GetCandles(env, "NQ1!", "W", 20).catch(() => ({ candles: [] }))
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
    // 2026-05-26 — Morning Daily Brief was rendering SPY/QQQ/IWM
    // levels anchored on yesterday's RTH close ($742.72) while live
    // pre-market was already $745.64. Cause: scoring cron skips outside
    // RTH so `timed:latest:{ticker}.price` and `.ts` are still the
    // previous RTH close. The price-feed cron (timed:prices) IS firing
    // in pre-market and has fresh quotes — just not propagated into the
    // scoring payload that the brief uses.
    //
    // Fix: also fix when the price-feed has a STRICTLY FRESHER timestamp
    // than the scoring payload AND the scoring payload is at least 30
    // minutes old. The 30-min floor avoids flapping during RTH when both
    // sources are updating concurrently.
    const pfTs = Number(pfData?.t) || 0;
    const pfFresher = pfTs > 0 && pfTs > ts && ageH * 60 > 30;
    const isStale = ageH > 24 || pfFresher;

    if (needsFix || isStale) {
      const reason = needsFix
        ? `stale (price=${price}, dayPct=${dayPct}%)`
        : (pfFresher
          ? `${ageH.toFixed(1)}h old, price-feed fresher (pf_ts ${Math.round((Date.now() - pfTs) / 60000)}m vs data ${Math.round((Date.now() - ts) / 60000)}m)`
          : `${ageH.toFixed(0)}h old`);
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
  // 2026-05-27 (PR #320) — IWM was MISSING from the validate list.
  // Symptom: SPY/QQQ in the morning brief showed pre-market price
  // (validate refreshed from price-feed) but IWM was stuck at the
  // prior daily close. Same shape as the bug PR #283 fixed for SPY/
  // QQQ — just never extended to IWM. Adding now so all three index
  // ETFs get pre-market refresh consistently.
  iwmData = validateMarketData(iwmData, "IWM",  "IWM", _pf, true);

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

  // Enrich today's earnings tickers with current price, daily change, and chart setup.
  //
  // V15 P0.7.40 (2026-04-30) — TwelveData fallback for non-universe tickers
  //
  // Per user feedback: "Earnings Watch does not show ticker price but shows
  // '$data unavailable', if they are missing in our universe, we can use
  // TwelveData calls to get that info."
  //
  // Strategy:
  //   1. KV first — universe tickers have full state + chart setup metadata
  //   2. For tickers NOT in universe (no KV entry), batch-call TwelveData
  //      /quote in one API hit and enrich with price + day_change_pct only
  //   3. Anything that still fails returns the raw earnings entry (will show
  //      ticker + name + estimates without a price, instead of '$ unavailable')
  //
  // Step 1: enrich from KV
  const earningsKvEnriched = await Promise.all(todayEarningsRaw.map(async (e) => {
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
          _enrichedSource: "kv",
        };
      }
    } catch (_) {}
    return e;
  }));

  // Step 2: collect tickers that need TwelveData fallback (no price yet)
  const needsTd = earningsKvEnriched
    .filter(e => !e.currentPrice && e.symbol)
    .map(e => e.symbol);

  let tdSnapshots = {};
  if (needsTd.length > 0) {
    try {
      const result = await tdFetchQuote(env, [...new Set(needsTd)]);
      tdSnapshots = result?.snapshots || {};
      console.log(`[BRIEF] TwelveData fallback: enriched ${Object.keys(tdSnapshots).length}/${needsTd.length} non-universe earnings tickers`);
    } catch (err) {
      console.warn(`[BRIEF] TwelveData earnings fallback failed:`, String(err?.message || err).slice(0, 200));
    }
  }

  // Step 3: merge TwelveData prices into the enriched earnings list
  const todayEarnings = earningsKvEnriched.map((e) => {
    if (e.currentPrice || !e.symbol) return e;
    const td = tdSnapshots[e.symbol];
    if (!td) return e;
    const price = Number(td.price) || 0;
    const dayChg = Number(td.percentChange) || 0;
    return {
      ...e,
      currentPrice: price > 0 ? price.toFixed(2) : null,
      dayChangePct: dayChg !== 0 ? (dayChg >= 0 ? "+" : "") + dayChg.toFixed(2) + "%" : null,
      chartSetup: null,  // not in our universe — no chart context
      _enrichedSource: "twelvedata",
    };
  });

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
    nqCandlesM5?.candles || [], nqData, nqCandlesH4?.candles || [],
    nqCandlesW?.candles || []
  );

  const spyTechnical = summarizeTechnical(
    spyCandles?.candles || [], spyCandlesH1?.candles || [],
    spyCandlesM5?.candles || [], spyData, spyCandlesH4?.candles || [],
    spyCandlesW?.candles || []
  );

  const qqqTechnical = summarizeTechnical(
    qqqCandles?.candles || [], qqqCandlesH1?.candles || [],
    qqqCandlesM5?.candles || [], qqqData, qqqCandlesH4?.candles || [],
    qqqCandlesW?.candles || []
  );

  const iwmTechnical = summarizeTechnical(
    iwmCandles?.candles || [], iwmCandlesH1?.candles || [],
    iwmCandlesM5?.candles || [], iwmData, iwmCandlesH4?.candles || [],
    iwmCandlesW?.candles || []
  );

  // V15 P0.7.72 — Phase 2 Q1 unification.
  // Build canonical scenarios for the indices using the SAME helper that
  // /timed/ticker-scenario serves to the Right Rail. This guarantees the
  // levels the AI cites in the brief match exactly what the user sees in
  // the chart overlay and Model card.
  let spyScenario = null, qqqScenario = null, iwmScenario = null;
  try {
    const { buildTickerScenario } = await import("./ticker-scenario.js");
    [spyScenario, qqqScenario, iwmScenario] = await Promise.all([
      buildTickerScenario(env, "SPY").catch(() => null),
      buildTickerScenario(env, "QQQ").catch(() => null),
      buildTickerScenario(env, "IWM").catch(() => null),
    ]);
  } catch (e) {
    console.warn("[DailyBrief] canonical scenario import/build failed:", String(e).slice(0, 200));
  }

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
    // V15 P0.7.72 — canonical per-index scenarios (Phase 2 Q1 unification)
    spyScenario,
    qqqScenario,
    iwmScenario,
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
    // 2026-05-22 — Broad market headlines for the brief infographic.
    topHeadlines: (finnhubTopHeadlines || []).slice(0, 6),
    morningPrediction: morningBrief?.es_prediction || null,
    morningContent: type === "evening" ? (morningBrief?.content || "").slice(0, 1500) : null,
    priceFeedCrossRef: buildPriceFeedCrossRef(_pf),
    crossAssetContext: buildCrossAssetContext(_pf),
    priceFeedRaw: _pf,
    // 2026-05-30 — Inheritance fix. The Daily Brief now sees the
    // synthesized 8-layer root-strategy verdict per top-conviction
    // ticker AND the Index Quartet + SMT state — same intelligence
    // that drives the Options engine. Brief prompt references these
    // so the narrative is consistent with what cards / Options Tab
    // display.
    indexQuartetSummary: (() => {
      try {
        const md = {
          ES: _pf?.["ES1!"], NQ: _pf?.["NQ1!"],
          YM: _pf?.["YM1!"], RTY: _pf?.["RTY1!"],
          SPY: _pf?.SPY, QQQ: _pf?.QQQ, DIA: _pf?.DIA, IWM: _pf?.IWM,
          VIX: _pf?.["VX1!"] || _pf?.VIX,
        };
        // Map { p, dp } → { price, dayChangePct, prev_close } shape the
        // futures-pairs module expects.
        const norm = {};
        for (const k of Object.keys(md)) {
          const v = md[k];
          if (!v) continue;
          norm[k] = {
            price: Number(v.p) || null,
            dayChangePct: Number(v.dp) || 0,
            prev_close: Number(v.pc) || null,
            open: Number(v.op) || null,
          };
        }
        if (!norm.ES?.price && norm.SPY?.price) norm.ES = norm.SPY;
        if (!norm.NQ?.price && norm.QQQ?.price) norm.NQ = norm.QQQ;
        if (!norm.YM?.price && norm.DIA?.price) norm.YM = norm.DIA;
        if (!norm.RTY?.price && norm.IWM?.price) norm.RTY = norm.IWM;
        const state = computeFuturesPairsState(norm);
        return state.ok ? summarizeFuturesPairs(state) : null;
      } catch (_) { return null; }
    })(),
    topConfluencePicks: (() => {
      try {
        // Top 5 RIDE/DRIFT/READY/FADE setups by confluence score.
        const arr = [];
        // _pf doesn't have full ticker data — pull from /timed/all via
        // the caller's existing data fetches. For now we leave this null;
        // the cron-driven brief generation populates it from
        // /timed/options/all once that endpoint runs in the same env.
        return arr.length > 0 ? arr : null;
      } catch (_) { return null; }
    })(),
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

// ── Saty ATR Levels — shared helpers (Day Mode + Multi-Day Mode) ───────
//
// Implements Saty Pirzadeh's "Saty ATR Levels" indicator. Two modes:
//   * Day Mode      — anchor = prior daily close, ATR = ATR(14) on daily.
//   * Multi-Day Mode — anchor = prior weekly close, ATR = ATR(14) on weekly.
//
// Saty terminology (P0.7.135 follow-up — corrects the original draft):
//   * Pivot          = Level 0 (the anchor itself — prior period close)
//   * Trigger        = ±0.236 (Saty's smallest level — early break of range)
//   * Golden Gate    = ±0.382 (when price crosses → "GG Open")
//   * Mid            = ±0.500
//   * GG Completion  = ±0.618 (when price touches → "GG Complete")
//   * Stretch        = ±0.786
//   * Range          = ±1.000 (full ATR projection)
//   * Extension      = ±1.236
//   * Far Extension  = ±1.618
//
// Golden Gate states (per Saty's published guidance, confirmed by user):
//   * NEUTRAL     — price inside ±0.382 (no GG event yet)
//   * OPEN_UP     — price has crossed above +0.382 (long GG opened)
//   * OPEN_DOWN   — price has crossed below -0.382 (short GG opened)
//   * COMPLETE_UP — price has touched +0.618 (long GG target hit)
//   * COMPLETE_DN — price has touched -0.618 (short GG target hit)
//
// COMPLETE_* is a strict superset of OPEN_*: once the gate is complete the
// state is COMPLETE_*, but downstream consumers that only care about the
// open/close direction can read `goldenGateDirection` ("UP" / "DOWN" /
// "NEUTRAL") for a 3-state simplification.
//
// Multi-Day Anchor selection:
//   * Source priority: weekly bars when available; otherwise reconstruct
//     from daily bars by walking backward until we cross a week boundary
//     (Sunday → Saturday in NY time, matching CBOE/CME equity weeks).
//
// Multi-Day ATR calculation:
//   * ATR(14) on weekly bars when ≥5 weekly bars are available
//     (Saty's indicator uses RMA but a Wilder TR average over 14 weeks is
//     within rounding for the public-facing levels).
//   * Fallback: dailyATR(14) · √5 — Saty's documented approximation
//     when weekly bars aren't loaded.
//
// Level ladder is identical in both modes:
//   anchor ± ATR · {0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.236, 1.618}
function _nyDateKey(ms) {
  const k = nyDateKeyFromMs(ms);
  return k || null;
}
function _nyDayOfWeek(ms) {
  // 0 = Sunday … 6 = Saturday in NY time.
  if (!Number.isFinite(ms)) return null;
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(ms);
  return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[wd] ?? null;
}
function _candleTsMs(candle) {
  return dailyBriefTsMs(candle?.ts ?? candle?.t ?? candle?.time ?? candle?.date);
}
function _atrWilder(period, candles) {
  const series = Array.isArray(candles) ? candles.filter(Boolean) : [];
  if (series.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < series.length; i++) {
    const h = Number(series[i].h);
    const l = Number(series[i].l);
    const pc = Number(series[i - 1].c);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc)) continue;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length === 0) return 0;
  const n = Math.min(period, trs.length);
  // Wilder's RMA: seed with simple average over first n, then smooth.
  let atr = trs.slice(0, n).reduce((s, x) => s + x, 0) / n;
  for (let i = n; i < trs.length; i++) {
    atr = (atr * (n - 1) + trs[i]) / n;
  }
  return atr;
}
function _resolveWeeklyAnchorFromDaily(dailyCandles, currentPriceTs) {
  // Walk backward through daily bars and pick the close of the LAST bar
  // that belongs to the most recently *completed* week (i.e. the close
  // before this week's Monday). NY-time week boundaries.
  const daily = Array.isArray(dailyCandles) ? dailyCandles : [];
  if (daily.length === 0) return { anchor: 0, anchorDateKey: null };
  const nowMs = Number.isFinite(currentPriceTs) ? currentPriceTs : Date.now();
  const nowDow = _nyDayOfWeek(nowMs);
  if (nowDow == null) return { anchor: Number(daily[daily.length - 1]?.c) || 0, anchorDateKey: null };
  // Days back from "now" to the most recent Saturday (end of last week).
  const daysToLastWeekEnd = nowDow === 0 ? 1 : nowDow; // Sun→1, Mon→1, …, Sat→6
  const lastWeekEndMs = nowMs - daysToLastWeekEnd * 24 * 3600 * 1000;
  const lastWeekEndDateKey = _nyDateKey(lastWeekEndMs);
  // Find the most recent daily bar with NY date <= lastWeekEndDateKey.
  let pick = null;
  for (let i = daily.length - 1; i >= 0; i--) {
    const ts = _candleTsMs(daily[i]);
    const dk = _nyDateKey(ts);
    if (!dk) continue;
    if (dk <= lastWeekEndDateKey) {
      pick = { candle: daily[i], dateKey: dk };
      break;
    }
  }
  if (!pick) {
    // All bars are inside this week — use the earliest one's close as a
    // best-effort fallback (still wrong but bounded).
    pick = { candle: daily[0], dateKey: _nyDateKey(_candleTsMs(daily[0])) };
  }
  return { anchor: Number(pick.candle?.c) || 0, anchorDateKey: pick.dateKey };
}
// Saty's full fib ladder. Used by both Day Mode and Multi-Day Mode.
const SATY_FIBS = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.236, 1.618];

function _satyFibLabel(f) {
  return (f * 100).toFixed(1).replace(/\.0$/, "");
}

function _buildSatyLadder(anchor, atr) {
  const levels = {};
  // Level 0 — the Pivot (Saty's anchor). For Day Mode this is the prior
  // daily close; for Multi-Day Mode it's the prior weekly close. Exposing
  // it as an explicit "0%" key lets any consumer that iterates
  // Object.entries(levels) render it alongside the +/- ladder; the
  // saty.pivot field on the wire payload carries the same value for
  // consumers that want it by name.
  levels["0%"] = anchor;
  for (const f of SATY_FIBS) {
    levels[`+${_satyFibLabel(f)}%`] = anchor + atr * f;
    levels[`-${_satyFibLabel(f)}%`] = anchor - atr * f;
  }
  return levels;
}

// Resolve Saty Golden Gate state from anchor/ATR/price.
// Returns { state, direction, gateOpen, gateComplete, ggLevels: { trigger, gate, mid, ggCompletion, range, ext, farExt } }
function _satyGoldenGateState(anchor, atr, curPx) {
  const ggUp = anchor + atr * 0.382;       // GG Open level (long)
  const ggDn = anchor - atr * 0.382;       // GG Open level (short)
  const ggCompUp = anchor + atr * 0.618;   // GG Completion level (long target)
  const ggCompDn = anchor - atr * 0.618;   // GG Completion level (short target)
  const triggerUp = anchor + atr * 0.236;  // Saty Trigger (smaller break)
  const triggerDn = anchor - atr * 0.236;
  const midUp = anchor + atr * 0.5;
  const midDn = anchor - atr * 0.5;

  let state = "NEUTRAL";
  let direction = "NEUTRAL";
  let gateOpen = false;
  let gateComplete = false;

  if (curPx >= ggCompUp) {
    state = "COMPLETE_UP";
    direction = "UP";
    gateOpen = true;
    gateComplete = true;
  } else if (curPx > ggUp) {
    state = "OPEN_UP";
    direction = "UP";
    gateOpen = true;
  } else if (curPx <= ggCompDn) {
    state = "COMPLETE_DN";
    direction = "DOWN";
    gateOpen = true;
    gateComplete = true;
  } else if (curPx < ggDn) {
    state = "OPEN_DOWN";
    direction = "DOWN";
    gateOpen = true;
  }

  return {
    state,
    direction,
    gateOpen,
    gateComplete,
    ggLevels: {
      triggerUp, triggerDn,
      gateUp: ggUp, gateDn: ggDn,
      midUp, midDn,
      completionUp: ggCompUp, completionDn: ggCompDn,
    },
  };
}

function computeSatyMultiDayLevels({ weeklyCandles, dailyCandles, currentPrice, dayAtr14Fallback }) {
  const weekly = Array.isArray(weeklyCandles) ? weeklyCandles : [];
  const daily = Array.isArray(dailyCandles) ? dailyCandles : [];
  const curPx = Number(currentPrice) || 0;
  if (curPx <= 0 || daily.length === 0) return null;

  // 1) Anchor — prior weekly close.
  let anchor = 0;
  let anchorSource = null;
  if (weekly.length >= 2) {
    // Last fully-closed weekly bar = weekly[length - 2] (length - 1 may
    // be the in-progress current week).
    anchor = Number(weekly[weekly.length - 2]?.c) || 0;
    anchorSource = "weekly_bar";
  }
  if (anchor <= 0) {
    const fallback = _resolveWeeklyAnchorFromDaily(daily, _candleTsMs(daily[daily.length - 1]) || Date.now());
    anchor = fallback.anchor;
    anchorSource = "daily_walkback";
  }
  if (anchor <= 0) return null;

  // 2) Weekly ATR(14).
  let weekAtr = 0;
  let atrSource = null;
  if (weekly.length >= 5) {
    weekAtr = _atrWilder(14, weekly);
    atrSource = "weekly_atr14";
  }
  if (weekAtr <= 0) {
    const dayAtr = Number(dayAtr14Fallback) > 0 ? Number(dayAtr14Fallback) : _atrWilder(14, daily);
    weekAtr = dayAtr * Math.sqrt(5);
    atrSource = "day_atr_sqrt5";
  }
  if (weekAtr <= 0) return null;

  // 3) Saty fib ladder.
  const levels = _buildSatyLadder(anchor, weekAtr);

  // 4) Golden Gate state (Saty's ±0.382 = GG Open, ±0.618 = GG Completion).
  const gg = _satyGoldenGateState(anchor, weekAtr, curPx);

  const _r = (v) => Math.round(v * 100) / 100;
  const goldenGateNote = (() => {
    if (gg.state === "COMPLETE_UP") return `Week price ${_r(curPx)} has touched the +61.8% GG completion at ${_r(gg.ggLevels.completionUp)} — Saty Multi-Day long Golden Gate is COMPLETE. Stretch +78.6% ${_r(anchor + weekAtr * 0.786)}, range +100% ${_r(anchor + weekAtr)}.`;
    if (gg.state === "OPEN_UP") return `Week price ${_r(curPx)} above the +38.2% Golden Gate at ${_r(gg.ggLevels.gateUp)} — long GG OPEN. Completion target +61.8% ${_r(gg.ggLevels.completionUp)}, mid +50% ${_r(gg.ggLevels.midUp)}.`;
    if (gg.state === "COMPLETE_DN") return `Week price ${_r(curPx)} has touched the -61.8% GG completion at ${_r(gg.ggLevels.completionDn)} — Saty Multi-Day short Golden Gate is COMPLETE. Stretch -78.6% ${_r(anchor - weekAtr * 0.786)}, range -100% ${_r(anchor - weekAtr)}.`;
    if (gg.state === "OPEN_DOWN") return `Week price ${_r(curPx)} below the -38.2% Golden Gate at ${_r(gg.ggLevels.gateDn)} — short GG OPEN. Completion target -61.8% ${_r(gg.ggLevels.completionDn)}, mid -50% ${_r(gg.ggLevels.midDn)}.`;
    return `Week price ${_r(curPx)} inside the weekly Golden Gate (±38.2% gates ${_r(gg.ggLevels.gateDn)} – ${_r(gg.ggLevels.gateUp)}). Saty Triggers ±23.6% at ${_r(gg.ggLevels.triggerDn)} – ${_r(gg.ggLevels.triggerUp)}.`;
  })();

  // 5) Week-close GG probability — same heuristic as before but operating
  // on the corrected anchor/ATR. Probability of *completing* the gate
  // (touching +/-61.8%) given current position and time remaining.
  const _atrUsedAbs = Math.abs(curPx - anchor);
  const _atrUsed = weekAtr > 0 ? _atrUsedAbs / weekAtr : 0;
  const dow = _nyDayOfWeek(Date.now());
  // Trading days remaining INCLUDING today: Mon→5, Tue→4, Wed→3, Thu→2, Fri→1, Sat/Sun→1.
  const _daysRemaining = dow == null ? 1 : Math.max(1, 6 - Math.max(1, Math.min(5, dow)));
  const _weekTimeRemaining = _daysRemaining / 5;
  const wggUpProb = (() => {
    if (curPx <= gg.ggLevels.gateUp) return 0;
    const target = gg.ggLevels.completionUp;
    if (curPx >= target) return 1;
    const dist = (target - curPx) / weekAtr;
    return Math.max(0, Math.min(1, 0.5 + (_weekTimeRemaining - dist) * 0.5));
  })();
  const wggDnProb = (() => {
    if (curPx >= gg.ggLevels.gateDn) return 0;
    const target = gg.ggLevels.completionDn;
    if (curPx <= target) return 1;
    const dist = (curPx - target) / weekAtr;
    return Math.max(0, Math.min(1, 0.5 + (_weekTimeRemaining - dist) * 0.5));
  })();
  const wProb = gg.direction === "UP" ? wggUpProb : gg.direction === "DOWN" ? wggDnProb : 0;

  return {
    anchor,
    weekAtr,
    dayAtrInWeekTerms: 0, // filled in by caller
    currentPrice: curPx,
    levels,
    goldenGate: gg.state,                  // legacy — kept for back-compat
    goldenGateState: gg.state,             // canonical — NEUTRAL/OPEN_*/COMPLETE_*
    goldenGateDirection: gg.direction,     // NEUTRAL/UP/DOWN (ignores complete)
    goldenGateOpen: gg.gateOpen,           // bool
    goldenGateComplete: gg.gateComplete,   // bool
    goldenGateNote,
    goldenGateProbability: {
      week: Math.round(wProb * 100) / 100,
      weekLabel: wProb >= 0.6 ? "HIGH" : wProb >= 0.3 ? "MODERATE" : "LOW",
      weekAtrUsedPct: Math.round(_atrUsed * 100),
      daysRemaining: _daysRemaining,
    },
    saty: {
      mode: "multi_day",
      anchorSource,
      atrSource,
      weeklyBarsAvailable: weekly.length,
      fibLadder: SATY_FIBS,
      // Per-Saty named levels:
      pivot:      anchor,                                                          // Level 0 (anchor)
      trigger:    { up: gg.ggLevels.triggerUp,    dn: gg.ggLevels.triggerDn },     // ±23.6%
      gate:       { up: gg.ggLevels.gateUp,       dn: gg.ggLevels.gateDn },        // ±38.2% (Golden Gate)
      mid:        { up: gg.ggLevels.midUp,        dn: gg.ggLevels.midDn },         // ±50%
      completion: { up: gg.ggLevels.completionUp, dn: gg.ggLevels.completionDn },  // ±61.8% (GG Completion)
    },
  };
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
  // V15 P0.7.96 — anchor MUST be the most recent SESSION close (= yesterday
  // for pre-market, today's prev close for RTH). The previous logic used
  // recent[length-2].c which is the day-BEFORE-yesterday's close whenever
  // recent[length-1] is yesterday's bar — that's the bug that made the
  // SPY brief render anchor=$701.66 while live price was $733.83 and the
  // game-plan target ended up on the wrong side of the current price.
  // Prefer latestData.prev_close (canonical, fed by the price pipeline)
  // and fall back to the candle heuristic only if it isn't available.
  const lastCandle = recent[recent.length - 1];
  const prevDayCandle = recent[recent.length - 2];
  const anchor = Number(latestData?.prev_close)
    || Number(latestData?.prevClose)
    || (lastCandle && Number(lastCandle.c))
    || (prevDayCandle && Number(prevDayCandle.c))
    || (pivots?.prevClose || last);
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
    // P0.7.135 (2026-05-12) — Saty Day Mode.
    // Day Mode anchors on prior daily close (Saty spec: prior session close)
    // and uses the daily ATR(14) we already computed above. This block was
    // already structurally correct on those two axes; the upgrade here is
    // (a) full Saty fib ladder including 0.786 / 1.236 / 1.618, and
    // (b) proper GG terminology (Trigger / GG Open / GG Completion) so the
    // Day card matches the Multi-Day card's vocabulary.
    const dayLevels = _buildSatyLadder(anchor, dayAtr);
    const curPrice = Number(latestData?.price) || 0;
    const dayGg = curPrice > 0 ? _satyGoldenGateState(anchor, dayAtr, curPrice) : null;

    atrFibLevels = {
      anchor: rnd(anchor),
      dayAtr: rnd(dayAtr),
      m5Atr: rnd(m5Atr),
      currentPrice: curPrice || null,
      levels: {},
    };
    for (const k of Object.keys(dayLevels)) atrFibLevels.levels[k] = rnd(dayLevels[k]);

    if (dayGg) {
      const _l = dayGg.ggLevels;
      atrFibLevels.goldenGate = dayGg.state;                  // legacy — back-compat
      atrFibLevels.goldenGateState = dayGg.state;             // NEUTRAL/OPEN_*/COMPLETE_*
      atrFibLevels.goldenGateDirection = dayGg.direction;     // NEUTRAL/UP/DOWN
      atrFibLevels.goldenGateOpen = dayGg.gateOpen;
      atrFibLevels.goldenGateComplete = dayGg.gateComplete;
      atrFibLevels.goldenGateNote = (() => {
        if (dayGg.state === "COMPLETE_UP") return `Price ${rnd(curPrice)} has touched the +61.8% GG completion at ${rnd(_l.completionUp)} — Saty Day long Golden Gate is COMPLETE. Stretch +78.6% ${rnd(anchor + dayAtr * 0.786)}, range +100% ${rnd(anchor + dayAtr)}.`;
        if (dayGg.state === "OPEN_UP") return `Price ${rnd(curPrice)} above the +38.2% Golden Gate at ${rnd(_l.gateUp)} — long GG OPEN. Completion target +61.8% ${rnd(_l.completionUp)}, mid +50% ${rnd(_l.midUp)}.`;
        if (dayGg.state === "COMPLETE_DN") return `Price ${rnd(curPrice)} has touched the -61.8% GG completion at ${rnd(_l.completionDn)} — Saty Day short Golden Gate is COMPLETE. Stretch -78.6% ${rnd(anchor - dayAtr * 0.786)}, range -100% ${rnd(anchor - dayAtr)}.`;
        if (dayGg.state === "OPEN_DOWN") return `Price ${rnd(curPrice)} below the -38.2% Golden Gate at ${rnd(_l.gateDn)} — short GG OPEN. Completion target -61.8% ${rnd(_l.completionDn)}, mid -50% ${rnd(_l.midDn)}.`;
        return `Price ${rnd(curPrice)} inside the daily Golden Gate (±38.2% gates ${rnd(_l.gateDn)} – ${rnd(_l.gateUp)}). Saty Triggers ±23.6% at ${rnd(_l.triggerDn)} – ${rnd(_l.triggerUp)}.`;
      })();
      atrFibLevels.saty = {
        mode: "day",
        anchorSource: latestData?.prev_close ? "prev_close_field" : "candle_fallback",
        atrSource: "day_atr14",
        fibLadder: SATY_FIBS,
        pivot:      rnd(anchor),                                             // Level 0 (prior daily close)
        trigger:    { up: rnd(_l.triggerUp),    dn: rnd(_l.triggerDn) },     // ±23.6%
        gate:       { up: rnd(_l.gateUp),       dn: rnd(_l.gateDn) },        // ±38.2% (Golden Gate)
        mid:        { up: rnd(_l.midUp),        dn: rnd(_l.midDn) },         // ±50%
        completion: { up: rnd(_l.completionUp), dn: rnd(_l.completionDn) },  // ±61.8% (GG Completion)
      };
    }

    // V15 P0.7.42 (2026-04-30) — Golden Gate close probability
    //
    // Per user request: "We should reference both the DAY ATR Levels and the
    // MultiDay ATR Levels and the probability of closing GG for the day as
    // well as for the week."
    //
    // Day-close probability heuristic: combines distance-to-target,
    // momentum (price > anchor + bias), session timing (more time =
    // more chance to reach), and ATR exhaustion (how much of dayAtr
    // already used up). Returns a probability 0-1 with a label
    // (LOW < 30%, MODERATE 30-60%, HIGH > 60%).
    if (curPrice > 0) {
      const _atrUsedAbs = Math.abs(curPrice - anchor);
      const _atrUsed = dayAtr > 0 ? _atrUsedAbs / dayAtr : 0;  // fraction of day ATR consumed
      // Time elapsed in RTH (0-1): use UTC clock since cron runs in UTC
      const _now = new Date();
      const _utcHour = _now.getUTCHours() + _now.getUTCMinutes() / 60;
      // RTH 13:30 UTC (9:30 ET EDT) → 20:00 UTC (4:00 PM ET EDT). Approx.
      let _sessionFrac = (_utcHour - 13.5) / (20 - 13.5);
      _sessionFrac = Math.max(0, Math.min(1, _sessionFrac));
      // P0.7.140 (2026-05-13) — bug fix: this block referenced `upGate`
      // and `dnGate` which were defined inline by the OLD atrFibLevels
      // path. The Saty Day Mode rewrite (P0.7.135) replaced that path
      // with a single _satyGoldenGateState() call returning a `dayGg`
      // object — but this probability block wasn't migrated, leaving
      // `upGate`/`dnGate` as stale references. Daily-brief generation
      // crashed with "ReferenceError: upGate is not defined" every
      // morning since the rewrite landed. Pull the gates from dayGg
      // with a fallback to the raw anchor + ATR projection in case
      // dayGg is null (e.g. curPrice missing earlier in the block).
      const upGate = dayGg?.ggLevels?.gateUp ?? (anchor + dayAtr * 0.382);
      const dnGate = dayGg?.ggLevels?.gateDn ?? (anchor - dayAtr * 0.382);
      // Distance from the active gate target (50%/61.8% past the gate)
      // If GG is OPEN_UP, target is +50%-+61.8%; if NEUTRAL, both gates equal
      const _ggUpProb = (() => {
        if (curPrice <= upGate) return 0;  // GG not open up
        const targetPrice = anchor + dayAtr * 0.5;
        if (curPrice >= targetPrice) return 1;  // already there
        const distToTarget = (targetPrice - curPrice) / dayAtr;  // fraction of dayAtr
        // Probability decays with distance, increases with time remaining + momentum
        const timeRemaining = 1 - _sessionFrac;
        // Heuristic: base 0.5 if just past gate, scale by (timeRemaining * (1 - distToTarget))
        return Math.max(0, Math.min(1, 0.5 + (timeRemaining - distToTarget) * 0.5));
      })();
      const _ggDnProb = (() => {
        if (curPrice >= dnGate) return 0;
        const targetPrice = anchor - dayAtr * 0.5;
        if (curPrice <= targetPrice) return 1;
        const distToTarget = (curPrice - targetPrice) / dayAtr;
        const timeRemaining = 1 - _sessionFrac;
        return Math.max(0, Math.min(1, 0.5 + (timeRemaining - distToTarget) * 0.5));
      })();
      const ggCloseProb = atrFibLevels.goldenGate === "OPEN_UP"
        ? _ggUpProb
        : atrFibLevels.goldenGate === "OPEN_DOWN" ? _ggDnProb : 0;
      atrFibLevels.goldenGateProbability = {
        day: rnd(ggCloseProb * 100) / 100,  // 0-1
        dayLabel: ggCloseProb >= 0.6 ? "HIGH"
                : ggCloseProb >= 0.3 ? "MODERATE"
                : "LOW",
        atrUsedPct: rnd(_atrUsed * 100),
        sessionElapsedPct: rnd(_sessionFrac * 100),
      };
    }

    // V15 P0.7.96 — game plan triggers + targets, with strict invariant
    // that bullTarget > bullTrigger > curPrice and bearTarget < bearTrigger
    // < curPrice. The previous logic could produce target-on-the-wrong-side
    // when the overnight range was missing or the price had drifted >1 ATR
    // from anchor.
    //
    // Trigger logic:
    //   bullTrigger = max(overnight high, curPrice + 0.25*ATR)
    //   bearTrigger = min(overnight low,  curPrice - 0.25*ATR)
    // Target logic: pick the FIRST fib level past the trigger that is
    //   at least a meaningful distance away; if none qualifies,
    //   project trigger ± 0.75*ATR.
    //
    // 2026-05-22 — Minimum target gap fix. The original `Math.max(bullTgt,
    // rnd(bullTrig + 0.01))` floor only guaranteed $0.01 of separation,
    // so when the overnight high coincided with a fib (e.g. bullTrig=$746.50
    // and the next up-fib was $746.92) the brief read "Bull break above
    // $746.50 opens $746.92" — a useless $0.42 "target". Now we require
    // the target to be at least max(0.4 * dayAtr, 0.30% of price) above
    // the trigger. If the nearest fib doesn't satisfy, walk the fib
    // ladder until one does; if even the top fib is too close, fall
    // back to trigger + 0.75 * dayAtr. Mirrored for bear side.
    const oHi = overnightRange?.high || curPrice;
    const oLo = overnightRange?.low || curPrice;
    const bullTrig = Math.max(rnd(oHi), rnd(curPrice + dayAtr * 0.25));
    const bearTrig = Math.min(rnd(oLo), rnd(curPrice - dayAtr * 0.25));
    // P0.7.140 (2026-05-13) — bug fix: same root cause as the upGate
    // ReferenceError above. The Saty Day Mode rewrite removed the local
    // `fibs` array (renamed to module-level SATY_FIBS) but this game-plan
    // block kept reading the dead local. Use SATY_FIBS directly.
    const allUpFibs = SATY_FIBS.map(f => rnd(anchor + dayAtr * f));
    const allDnFibs = SATY_FIBS.map(f => rnd(anchor - dayAtr * f));
    const _MIN_GAP = Math.max(dayAtr * 0.40, curPrice * 0.003);
    // Walk fibs in order; first one ≥ trigger + _MIN_GAP wins.
    const bullTargetFib = allUpFibs.find(t => t >= bullTrig + _MIN_GAP);
    // Bear side: walk reversed; first fib ≤ trigger - _MIN_GAP wins.
    const bearTargetFib = allDnFibs.slice().reverse().find(t => t <= bearTrig - _MIN_GAP);
    const bullTgt = bullTargetFib != null ? bullTargetFib : rnd(bullTrig + Math.max(dayAtr * 0.75, _MIN_GAP));
    const bearTgt = bearTargetFib != null ? bearTargetFib : rnd(bearTrig - Math.max(dayAtr * 0.75, _MIN_GAP));
    atrFibLevels.gamePlan = {
      bullTrigger: bullTrig,
      bullTarget:  Math.max(bullTgt, rnd(bullTrig + _MIN_GAP)),
      bearTrigger: bearTrig,
      bearTarget:  Math.min(bearTgt, rnd(bearTrig - _MIN_GAP)),
      min_gap: rnd(_MIN_GAP),
    };
  }

  // ── Multi-day (Weekly) ATR Levels — Saty ATR Levels · Multi-Day Mode ──
  //
  // P0.7.135 (2026-05-12) — Rewritten to follow Saty Pirzadeh's "Saty
  // ATR Levels" indicator (Multi-Day Trader Mode) instead of the previous
  // ad-hoc 5-day-TR projection.
  //
  // Saty Multi-Day Mode spec:
  //   * ANCHOR  = previous weekly CLOSE (close of the most recently
  //     completed weekly bar, i.e. last Friday's close).
  //   * ATR     = ATR(14) computed on WEEKLY bars (Wilder's true range
  //     averaged over 14 weekly bars).  When fewer than 5 weekly bars are
  //     available the function falls back to dailyATR(14) · √5 — Saty's
  //     own documented approximation when weekly data isn't loaded.
  //   * LEVELS  = anchor ± ATR · {0.236, 0.382, 0.5, 0.618, 0.786, 1.0,
  //     1.236, 1.618}.  ±0.382 is the "Lower Trigger" and ±0.618 is the
  //     "Upper Trigger" — the band between them is Saty's Golden Gate.
  //
  // Why the rewrite (the previous code had three real bugs):
  //   1. Anchor was `last5[0]?.o` — the OPEN of the candle 5 daily bars
  //      back, NOT prior week's close. With even mildly stale daily data
  //      the anchor drifted weeks behind price (SPY showing wkAnchor
  //      $677 while price was $739, observed 2026-05-12).
  //   2. ATR was an average of last-5-day TR — that's a *daily* ATR, not
  //      a weekly ATR. Saty Multi-Day uses ATR of weekly bars.
  //   3. Fib set was missing 0.786, 1.236, 1.618 — Saty's full Multi-Day
  //      ladder includes those for swing targets and stretch extensions.
  //
  // V15 P0.7.62 fix retained: `rnd` is declared locally to avoid the
  // earlier ReferenceError that crashed brief generation.
  let multiDayAtrLevels = null;
  if (recent.length >= 5 && anchor > 0) {
    const rnd = (v) => Math.round(v * 100) / 100;
    multiDayAtrLevels = computeSatyMultiDayLevels({
      weeklyCandles: Array.isArray(weeklyCandles) ? weeklyCandles : [],
      dailyCandles,
      currentPrice: Number(latestData?.price) || 0,
      dayAtr14Fallback: atr14,
    });
    if (multiDayAtrLevels) {
      // Round display fields (helper returns raw numbers so internal math
      // stays precise; the wire format expects 2-dp values).
      multiDayAtrLevels.anchor = rnd(multiDayAtrLevels.anchor);
      multiDayAtrLevels.weekAtr = rnd(multiDayAtrLevels.weekAtr);
      multiDayAtrLevels.dayAtrInWeekTerms = rnd(atr14 * Math.sqrt(5));
      for (const k of Object.keys(multiDayAtrLevels.levels)) {
        multiDayAtrLevels.levels[k] = rnd(multiDayAtrLevels.levels[k]);
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
    multiDayAtrLevels,
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

**Levels** (CRITICAL — must be CURRENT-PRICE-AWARE):
- ALWAYS reference the CURRENT/PREMARKET price (from "Market Data" section). If SPY is trading at $718 and your daily-chart data shows $712 as "resistance", that level is now SUPPORT (price is above it). Re-classify levels relative to current price.
- Support = price BELOW current. Resistance = price ABOVE current. If a level was crossed in pre-market, it flipped sides.
- TF in parens, one line each. Every number paired with a benchmark.
- S: $XXX (D), $XXX (4H)        ← MUST be below current price
- R: $XXX (W), $XXX (D)         ← MUST be above current price
- Range: $LOW–$HIGH — [where current price sits in this range, e.g. "stretched at top", "midrange"]
- Gap: $XXX–$XXX (4H) [filled / unfilled / pre-market filled]

**Game Plan** (one bullet per case, each ≤ 22 words):
- Bull case: HOLD ABOVE $XXX → targets $XXX, then $XXX (invalidate below $XXX). Read as "if held above X, target Y then Z".
- Bear case: BREAK BELOW $XXX → targets $XXX, then $XXX (invalidate above $XXX).
- Base case: [most likely range today, ATR% of current price, single risk note]
- IMPORTANT: Bull trigger must be NEAR or ABOVE current price (we're waiting for a hold/breakout). Bear trigger must be NEAR or BELOW current price (we're waiting for a breakdown). Targets must be in the trigger's direction (Bull targets > Bull trigger; Bear targets < Bear trigger).

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
- **EMA Cloud**: Above = bullish momentum, Below = bearish, InCloud = transitional. Refer to it as "EMA Cloud" or "the cloud" in your output — never name a specific indicator author.
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

## Cross-Asset Correlation (CRITICAL)
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
      if (d.ripster?.c72_89?.above) parts.push("EMA-Cloud-Above");
      else if (d.ripster?.c72_89?.below) parts.push("EMA-Cloud-Below");
      else if (d.ripster?.c72_89?.inCloud) parts.push("EMA-Cloud-InCloud");
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

// 2026-05-29 — Area A. Section-order override appended to both
// morning + evening prompts. The earlier sections in the prompt
// cover data + tone in detail; this block at the end FORCES the
// output structure the user asked for, in plain-English retail-
// friendly language, including SPY/QQQ/IWM scorecards alongside
// ES, combined Key Levels + Structure with chart placeholders,
// and named sector references (not 3-letter codes).
function buildRetailFriendlyOutputSpec(type) {
  const isEvening = type === "evening";
  const orderHeader = isEvening
    ? "EVENING BRIEF — REQUIRED SECTION ORDER (override any earlier structural instructions)"
    : "MORNING BRIEF — REQUIRED SECTION ORDER (override any earlier structural instructions)";

  // Section list per type
  const sections = isEvening
    ? `1. **Session Recap & Context** (~100 words)
2. **Sector Themes** (~80 words)
3. **ES Prediction Scorecard** (today's call vs what actually happened — exact same format for SPY, QQQ, IWM)
4. **SPY Prediction Scorecard** (same shape as ES)
5. **QQQ Prediction Scorecard** (same shape as ES)
6. **IWM Prediction Scorecard** (same shape as ES)
7. **Key Levels & Structural Update** (combined — bullets per index with the structural note alongside the levels. Insert [CHART: SPY], [CHART: QQQ], [CHART: IWM] placeholders so the renderer can drop charts in)
8. **Looking Ahead** (~80 words)
9. **Risk Factors** (1-2 key risks, ≤20 words each)
10. **Active Trader Report** (~80 words — per position: ticker, today's chg%, P&L, thesis status, action)
11. **Investor Portfolio** (~80 words — per holding: ticker, today's chg%, total return%, thesis status, DCA opportunities)`
    : `1. **Market Context** (~100 words)
2. **Sector Themes** (~80 words)
3. **Earnings Watch & Macro News** (today's reports + any macro releases / Fed speakers)
4. **ES Prediction** (today's game plan — exact same format for SPY, QQQ, IWM)
5. **SPY Prediction** (same shape as ES)
6. **QQQ Prediction** (same shape as ES)
7. **IWM Prediction** (same shape as ES)
8. **Key Levels & Game Plan** (combined — bullets per index with structure + scenario alongside the levels. Insert [CHART: SPY], [CHART: QQQ], [CHART: IWM] placeholders so the renderer can drop charts in)
9. **Risk Factors** (1-2 key risks, ≤20 words each)
10. **Active Trader Report** (~80 words — per position: ticker, today's chg%, P&L, thesis status, action)
11. **Investor Portfolio** (~80 words — per holding: ticker, today's chg%, total return%, thesis status, DCA opportunities)`;

  return `

## ${orderHeader}

The brief MUST be output in exactly this order, with each section as its own ## heading:

${sections}

## Retail-Friendly Language Rules (apply to ALL sections above):

- **Spell out sector names.** "Technology (XLK)" not "XLK". "Energy (XLE)" not "XLE". On second mention, the bare ticker is fine.
- **When you reference cross-asset moves, explain WHY they matter to equity traders.** Don't say "XLK's relationship with crude and gold" — say "Technology stocks usually weaken when crude oil spikes (energy costs hit margins) and gold rallies (recession fear). Today both moved against tech."
- **Translate jargon.** First time you use any of these, parenthetically define them: SMC, FVG, BSL/SSL, ATR, RSI, MACD, OPEX, VWAP, SuperTrend, EMA. Example: "Fair Value Gap (FVG — an unfilled price gap from a fast move that often gets revisited)".
- **Lead with WHAT IT MEANS, then the data.** Bad: "SPY closed at $755.27, ATR 7.02, above the 50d EMA at $742." Good: "SPY held its rising 50-day average and closed near the high of the day — a bullish read for the next session."
- **Per-index Prediction Scorecards (sections 3-6 evening, 4-7 morning) MUST use the SAME schema as ES** so they can be compared at a glance. For each index produce:
  - One narrative sentence (the prose)
  - Bull above $X → $Y target (+Z%)
  - Bear below $X → $Y target (-Z%)
  - Range today: $LOW – $HIGH
  - For EVENING: also include "Result: [HIT / MISS / WORKING / NEITHER]" so the scorecard is honest about what happened.
- **Chart placeholders** in section 7/8: write \`[CHART: SPY]\` on its own line where you want the SPY 15m or daily chart to render. Same for QQQ, IWM. The renderer will substitute with an actual chart. Put the chart RIGHT NEXT TO the commentary for that index — interleave, don't batch all charts at the end.
- **Active Trader / Investor Portfolio** sections must reference the actual open positions list provided in the data. Each row ≤ 25 words.

CRITICAL: This output spec overrides any contradictory structure earlier in this prompt. The 11 sections, in this order, are the required output.
`;
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

${getStrategyBrief()}

REQUIRED: At least once per Brief (typically in the Big Picture or Sector Spotlight section), explicitly tie observed action back to the active playbook above — e.g. "Tech leadership today fits our overweight stance on AI compute and the Phase-1 back-ended rally thesis," or "Healthcare weakness aligns with our neutral stance — earnings growth is the lone outright negative this quarter." This anchors the Brief in our written strategy so users learn the playbook as they read.

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

## Cross-Asset Context (USE for cross-asset correlated analysis):
${data.crossAssetContext || "Not available — skip cross-asset section."}
IMPORTANT: If crude, gold, TLT, or VIX are making notable moves (>1%), LEAD with the cross-asset story and explain the equity implications.

## Index Quartet (ES/NQ/YM/RTY + VIX) — the institutional liquidity grid:
${data.indexQuartetSummary || "Quartet data unavailable."}
USE this to gate single-name calls: if ES+NQ are bullish but YM+RTY diverge, mention the rotation. If the SMT block is firing (one index swept a marked level while others refused), surface the reversal bias.

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

### Game Plan Triggers + Day Gate (THESE ARE THE EXACT NUMBERS THE USER SEES ON-SCREEN):
The "Game Plan" card on the live app renders the BULL/BEAR triggers + targets below.
The "Day Gate" row renders the mid + ±38.2% bounds below. The per-ETF Prediction
sentence at the bottom of the brief MUST use these exact numbers and labels so
the prose, the card, and the per-ETF Prediction all speak the same language.

${(() => {
  const lines = [];
  // 2026-05-27 (PR #320) — Include LIVE/PRE-MARKET current price
  // for each ETF so the AI substitutes the right value in the
  // "@$[currentPrice]" template placeholder downstream.
  // ETF-data maps: SPY/QQQ/IWM come from validateMarketData() above,
  // which patches `price` from the price-feed when scoring payload
  // is stale (handles pre-market / extended-hours correctly).
  const _curPxMap = {
    ES:  Number(data.market?.ES?.price) || null,
    NQ:  Number(data.market?.NQ?.price) || null,
    SPY: Number(data.market?.SPY?.price) || null,
    QQQ: Number(data.market?.QQQ?.price) || null,
    IWM: Number(data.market?.IWM?.price) || null,
  };
  for (const [sym, tech] of [["ES", data.esTechnical], ["NQ", data.nqTechnical], ["SPY", data.spyTechnical], ["QQQ", data.qqqTechnical], ["IWM", data.iwmTechnical]]) {
    const af = tech?.atrFibLevels;
    const gp = af?.gamePlan;
    if (!gp) continue;
    const mid = af?.anchor;
    const dn38 = af?.levels?.["-38.2%"];
    const up38 = af?.levels?.["+38.2%"];
    const range = (Number.isFinite(dn38) && Number.isFinite(up38))
      ? `expected day range $${dn38}–$${up38} (Day Gate)`
      : "";
    const curPx = _curPxMap[sym];
    const curStr = Number.isFinite(curPx) && curPx > 0 ? `current $${curPx.toFixed(2)}` : "";
    const midStr = Number.isFinite(mid) ? `Saty pivot $${mid}` : "";
    const head = [curStr, midStr, range].filter(Boolean).join(" · ");
    lines.push(`${sym}: ${head}${head ? " | " : ""}BULL break above $${gp.bullTrigger} → target $${gp.bullTarget} | BEAR break below $${gp.bearTrigger} → target $${gp.bearTarget}`);
  }
  return lines.length > 0 ? lines.join("\n") : "Use SMC support/resistance levels as triggers.";
})()}
ABSOLUTE RULES:
- Bearish targets MUST be LOWER than triggers. Bullish targets MUST be HIGHER.
- The "Expected range" you cite for SPY/QQQ/IWM at the end of the brief MUST equal the Day Gate
  range printed above for that ETF — verbatim. The card on screen shows these exact bounds; if
  your sentence shows different bounds the user sees two contradictory numbers and loses trust.
- BULL break / BEAR break / mid / Day Gate are the ONLY level vocabulary allowed in the per-ETF
  Prediction sentence. Do NOT invent SMC level names ("4-hour gap", "ORB high", "Daily Pivot")
  in the Prediction sentence — those belong in the Bigger Picture / SPY-QQQ sections above.

### Golden Gate Status (V15 P0.7.42 — Day & Week probabilities):
For each index, show BOTH the day GG state and the multi-day (weekly) GG state. The probability heuristic blends ATR usage, time-of-session, and distance to target. Use HIGH/MODERATE/LOW labels in the prose; quote the % prob if material.
${(() => {
  const lines = [];
  for (const [sym, tech] of [["SPY", data.spyTechnical], ["QQQ", data.qqqTechnical], ["IWM", data.iwmTechnical]]) {
    if (!tech) continue;
    const day = tech.atrFibLevels;
    const week = tech.multiDayAtrLevels;
    const dayGg = day?.goldenGate || "?";
    const weekGg = week?.goldenGate || "?";
    const dayProb = day?.goldenGateProbability;
    const weekProb = week?.goldenGateProbability;
    const dayLine = dayProb
      ? `Day GG ${dayGg} (${dayProb.dayLabel} ${(dayProb.day * 100).toFixed(0)}% prob to close gate; ATR used ${dayProb.atrUsedPct}%, session ${dayProb.sessionElapsedPct}% elapsed)`
      : `Day GG ${dayGg}`;
    const weekLine = weekProb
      ? `Week GG ${weekGg} (${weekProb.weekLabel} ${(weekProb.week * 100).toFixed(0)}% prob to close week gate; weekly ATR used ${weekProb.weekAtrUsedPct}%, ${weekProb.daysRemaining}d remaining)`
      : `Week GG ${weekGg}`;
    lines.push(`${sym}: ${dayLine} | ${weekLine}`);
  }
  return lines.length > 0 ? lines.join("\n") : "(No GG data)";
})()}

### Multi-Day (Weekly) ATR Levels — for swing context:
${(() => {
  const lines = [];
  for (const [sym, tech] of [["SPY", data.spyTechnical], ["QQQ", data.qqqTechnical], ["IWM", data.iwmTechnical]]) {
    const w = tech?.multiDayAtrLevels;
    if (!w) continue;
    const lvls = w.levels || {};
    lines.push(`${sym} weekAnchor=${w.anchor} weekATR=${w.weekAtr} | up: +38.2%=${lvls["+38.2%"]} +50%=${lvls["+50%"]} +61.8%=${lvls["+61.8%"]} | dn: -38.2%=${lvls["-38.2%"]} -50%=${lvls["-50%"]} -61.8%=${lvls["-61.8%"]}`);
  }
  return lines.length > 0 ? lines.join("\n") : "(N/A)";
})()}

### Canonical Index Scenarios (V15 P0.7.72 — Phase 2 Q1 unification)
The objects below are the SINGLE SOURCE OF TRUTH for SPY/QQQ/IWM levels.
The Right Rail Model card on the live app reads from the EXACT same
endpoint, so the levels you cite below MUST match these values verbatim.
Do NOT compute your own levels from the technical summaries above when a
canonical scenario is provided — quote these prices directly.

If a level is in \`support[]\`, it is BELOW current price.
If a level is in \`resistance[]\`, it is ABOVE current price.
NEVER cite a "resistance" that is below the current price — that's support.

#### SPY canonical scenario:
${data.spyScenario && data.spyScenario.ok ? JSON.stringify(data.spyScenario, null, 1) : "(unavailable — fall back to SMC levels below)"}

#### QQQ canonical scenario:
${data.qqqScenario && data.qqqScenario.ok ? JSON.stringify(data.qqqScenario, null, 1) : "(unavailable — fall back to SMC levels below)"}

#### IWM canonical scenario:
${data.iwmScenario && data.iwmScenario.ok ? JSON.stringify(data.iwmScenario, null, 1) : "(unavailable — fall back to SMC levels below)"}

### Legacy SMC fallback (use ONLY when the canonical scenario above is unavailable):

#### SPY Key Levels:
${formatSMCForPrompt(data.spyTechnical?.smcLevels)}

#### QQQ Key Levels:
${formatSMCForPrompt(data.qqqTechnical?.smcLevels)}

#### IWM Key Levels (Russell 2000):
${formatSMCForPrompt(data.iwmTechnical?.smcLevels)}

#### ES Key Levels (for futures traders):
${formatSMCForPrompt(data.esTechnical?.smcLevels)}

#### NQ Key Levels (for futures traders):
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

## Top Broad-Market Headlines (general — for editorial context only):
${(data.topHeadlines || []).length > 0
    ? data.topHeadlines.map(h => `- ${h.title}${h.source ? ` (${h.source})` : ""}`).join("\n")
    : "No broad-market headlines available."}
> If a headline materially affects today's setup, weave it into the Bigger Picture editorial (≤ 1 sentence). Otherwise IGNORE — these are for the reader, not for the brief body.

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

End with FIVE clear sections (in this exact order):

- **ES Prediction**: One specific, falsifiable prediction for ES. Include expected range.

- **SPY Prediction**: TWO blocks — first a one-sentence day-trade narrative
  (mirroring the ES Prediction style above), then the 4-line structured block.

  Block A — prose sentence (≤ 45 words, MUST start with the literal label
  "**SPY Prediction**:" so the extractor finds it). Describe the expected
  intraday price action: ranges, trigger reclaims, fade/extension scenarios.
  Use the same falsifiable specificity as the ES Prediction. Example shape:

  "**SPY Prediction**: SPY stays inside the expected day range of \\$[dayLow]-\\$[dayHigh]
   early, then resolves higher only if it reclaims \\$[bullTrigger]; otherwise
   expect rotation around \\$[pivot] and a late fade toward \\$[bearTarget]."

  Block B — the 4-line structured trigger block (kept for visual scanning):

  "**SPY @ \\$[currentPrice]** · Range today \\$[dayLow]–\\$[dayHigh]
   ▲ **Bull above \\$[bullTrigger] → \\$[bullTarget]**
   ▼ **Bear below \\$[bearTrigger] → \\$[bearTarget]**
   Lean: [BULL|BEAR|NEUTRAL] — [≤ 10 words explaining why]."

  IMPORTANT: [currentPrice] MUST be the "current $X.XX" value from the
  Game Plan block above (the LIVE / pre-market price), NOT the Saty
  pivot. This is what the user is comparing against the triggers.
  2026-05-27 (PR #320) fix — previously this template used the Saty
  pivot (= prior daily close) which made the "@$X" anchor look like
  yesterday's stale data in pre-market.

  Rules:
  - Block A FIRST, then Block B (blank line between).
  - Keep the 4-line structure exactly. No extra prose AFTER the Lean line.
  - The "Lean" line is a one-call directional read: BULL, BEAR, or NEUTRAL.
  - The "why" must be ≤ 10 words and concrete (e.g. "VIX cooling + breadth firm",
    "GG above, no overnight catalyst").

- **QQQ Prediction**: Same two-block shape (prose sentence + 4-line structured),
  QQQ numbers from the Game Plan block.

- **IWM Prediction**: Same two-block shape (prose sentence + 4-line structured),
  IWM numbers from the Game Plan block.

- **Risk Factors**: 1–2 key risks, each ≤ 20 words. Plain English. No hedge words.

CRITICAL on the per-ETF predictions:
- The Game Plan card on screen shows the same mid / Range / Bull / Bear numbers.
  The Prediction MUST cite IDENTICAL numbers with IDENTICAL labels.
- Triggers and targets are specific prices, never vague phrases.
- If bullTarget - bullTrigger is less than 0.4% of the price, the level math
  is wrong upstream — flag it as "[level needs review]" rather than emitting
  a meaningless tight pair. Same for the bear side.
- Expected range MUST be a real low–high pair AND must equal the Day Gate bounds for that ETF.
- Bullish targets MUST be ABOVE current price; bearish targets MUST be BELOW. No exceptions.
- DO NOT invent SMC level names ("4-hour gap", "ORB high", "daily pivot") in the Prediction
  sentence — those belong in the earlier SPY / QQQ structure section.
${buildRetailFriendlyOutputSpec("morning")}`;
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

${getStrategyBrief()}

REQUIRED: Reference the active playbook above when explaining sector rotation / leadership patterns of the day — e.g. "Energy + Materials led today, consistent with our overweight stance and the Iran-war supply-shock pathway in our active risk register." Tie the day's tape back to the written thesis so the user learns the playbook narratively as they read.

## Index Quartet (ES/NQ/YM/RTY + VIX):
${data.indexQuartetSummary || "Quartet data unavailable."}
USE this to explain leadership and rotation in the recap. If SMT fired today, lead with that reversal narrative.

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

## Cross-Asset Context (USE for cross-asset correlated analysis):
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

## Top Broad-Market Headlines (general — for editorial context):
${(data.topHeadlines || []).length > 0
    ? data.topHeadlines.map(h => `- ${h.title}${h.source ? ` (${h.source})` : ""}`).join("\n")
    : "No broad-market headlines available."}

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
- **Risk Factors**: 1-2 key risks for tomorrow.
${buildRetailFriendlyOutputSpec("evening")}`;
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
      const triggerMatch = line.match(/(?:break(?:s)? above|reclaim(?:s)?|hold(?:s)? above|opens? above|Bull above)\s+\$?([\d,.]+)/i);
      const target = findTargetPrice(line) ?? (() => {
        // 2026-05-22 — also catch the new compact shape:
        //   "Bull above $746.50 → $749.00"
        const arrowMatch = line.match(/(?:Bull above|break(?:s)? above)\s+\$?[\d,.]+\s*(?:→|->)\s*\$?([\d,.]+)/i);
        return arrowMatch ? parseFloat(arrowMatch[1].replace(/,/g, "")) : null;
      })();
      if (triggerMatch && target != null) {
        const trigger = parseFloat(triggerMatch[1].replace(/,/g, ""));
        if (Number.isFinite(trigger) && Number.isFinite(target) && target < trigger) {
          console.warn(`[BRIEF SANITIZE] Dropped invalid bullish line: trigger=${trigger}, target=${target}, line="${line.slice(0, 120)}"`);
          continue;
        }
        // 2026-05-22 — too-tight gap. If bull target is within 0.4% of
        // the trigger, the level upstream is bad — replace the prose
        // with a clear "level review needed" marker so the user knows
        // we didn't ship a noise level masquerading as a target.
        if (Number.isFinite(trigger) && Number.isFinite(target) && trigger > 0) {
          const gapPct = (target - trigger) / trigger;
          if (gapPct > 0 && gapPct < 0.004) {
            console.warn(`[BRIEF SANITIZE] Tight bull pair detected (gap=${(gapPct * 100).toFixed(2)}% trigger=${trigger} target=${target}) — flagging for review`);
            out.push(line.replace(/\$?[\d,.]+(\s*(?:→|->|opens)\s*)\$?[\d,.]+/, `$${trigger}$1[level needs review]`));
            continue;
          }
        }
      }
    }

    // Mirror the bull too-tight check for the bear side ("Bear below … → …").
    const isBearTight = /\bBear below\b/i.test(line) || /break(?:s)? below/i.test(lower);
    if (isBearTight) {
      const bearArrow = line.match(/(?:Bear below|break(?:s)? below)\s+\$?([\d,.]+)\s*(?:→|->|opens?)\s*\$?([\d,.]+)/i);
      if (bearArrow) {
        const trig = parseFloat(bearArrow[1].replace(/,/g, ""));
        const tgt  = parseFloat(bearArrow[2].replace(/,/g, ""));
        if (Number.isFinite(trig) && Number.isFinite(tgt) && trig > 0 && tgt < trig) {
          const gapPct = (trig - tgt) / trig;
          if (gapPct > 0 && gapPct < 0.004) {
            console.warn(`[BRIEF SANITIZE] Tight bear pair detected (gap=${(gapPct * 100).toFixed(2)}% trigger=${trig} target=${tgt}) — flagging for review`);
            out.push(line.replace(/\$?[\d,.]+(\s*(?:→|->|opens)\s*)\$?[\d,.]+/, `$${trig}$1[level needs review]`));
            continue;
          }
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
function buildDiscordBriefEmbed(type, data, content, esPrediction, spyPrediction, qqqPrediction, iwmPrediction, infographic) {
  const isMorning = type === "morning";
  const fields = [];
  const m = data.market || {};

  // ── Helper: format a price/change pair ──────────────────────────────────
  const fmtMkt = (sym, d) => {
    if (!d) return null;
    const px = d.price?.toFixed?.(2) ?? d.price ?? "—";
    const chg = Number(d.dayChangePct);
    const chgStr = Number.isFinite(chg) ? `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%` : "";
    return `${sym} ${px}${chgStr ? ` (${chgStr})` : ""}`;
  };
  const fmtFib = (fib, label) => {
    if (!fib || !fib.levels) return null;
    const lvl = fib.levels;
    const fibStr = [
      `38.2: ${lvl["-38.2%"] ?? "—"} / ${lvl["+38.2%"] ?? "—"}`,
      `50.0: ${lvl["-50%"] ?? "—"} / ${lvl["+50%"] ?? "—"}`,
      `61.8: ${lvl["-61.8%"] ?? "—"} / ${lvl["+61.8%"] ?? "—"}`,
    ].join("  •  ");
    const gate = fib.goldenGate === "OPEN_UP" ? "🟢 Open Up"
      : fib.goldenGate === "OPEN_DOWN" ? "🔴 Open Down"
      : "⚪ Neutral";
    return { name: `${label}  (ATR ${fib.dayAtr?.toFixed?.(1) ?? "—"} · ${gate})`, value: fibStr, inline: false };
  };
  const fib = {
    es:  data.esTechnical?.atrFibLevels,
    spy: data.spyTechnical?.atrFibLevels,
    nq:  data.nqTechnical?.atrFibLevels,
    qqq: data.qqqTechnical?.atrFibLevels,
    iwm: data.iwmTechnical?.atrFibLevels,
  };

  // ── Description: Today's Three + closing line ────────────────────────────
  // These come from the AI content (extracted in generateDailyBrief) and
  // give the reader the 3-sentence "why today matters" before the numbers.
  let description = "";
  const topThree = infographic?.topThree;
  if (Array.isArray(topThree) && topThree.length === 3) {
    description = topThree.map(t => `**${t.n}.** ${t.label ? `**${t.label}:** ` : ""}${t.body}`).join("\n");
  }
  const closingLine = infographic?.closingLine;
  if (closingLine) {
    description += (description ? "\n\n" : "") + `_"${closingLine}"_`;
  }

  // ── 1. Market Snapshot — ES / NQ / SPY / QQQ / IWM ─────────────────────
  const mktParts = [
    fmtMkt("ES", m.ES), fmtMkt("NQ", m.NQ),
    fmtMkt("SPY", m.SPY), fmtMkt("QQQ", m.QQQ), fmtMkt("IWM", m.IWM),
  ].filter(Boolean);
  if (mktParts.length > 0) {
    // Split across two lines for readability: futures first, ETFs second
    const futuresPart = [fmtMkt("ES", m.ES), fmtMkt("NQ", m.NQ)].filter(Boolean).join(" | ");
    const etfPart = [fmtMkt("SPY", m.SPY), fmtMkt("QQQ", m.QQQ), fmtMkt("IWM", m.IWM)].filter(Boolean).join(" | ");
    const snapshotVal = [futuresPart, etfPart].filter(Boolean).join("\n");
    if (snapshotVal) fields.push({ name: "Market Snapshot", value: snapshotVal, inline: false });
  }

  // ── 2. Index Outlook — compact direction chips per ETF ───────────────────
  // Derived from the engine's golden-gate bias (reliable structured data)
  // rather than AI text extraction. Always shows even if predictions fail.
  const gateLabel = (g) => g === "OPEN_UP" ? "🟢 Open Up" : g === "OPEN_DOWN" ? "🔴 Open Down" : "⚪ Neutral";
  const outlookParts = [
    fib.spy?.goldenGate ? `SPY ${gateLabel(fib.spy.goldenGate)}` : null,
    fib.qqq?.goldenGate ? `QQQ ${gateLabel(fib.qqq.goldenGate)}` : null,
    fib.iwm?.goldenGate ? `IWM ${gateLabel(fib.iwm.goldenGate)}` : null,
  ].filter(Boolean);
  if (outlookParts.length > 0) {
    fields.push({ name: "Today's Outlook", value: outlookParts.join("  ·  "), inline: false });
  }

  // ── 3. Predictions (ES / SPY / QQQ / IWM) ───────────────────────────────
  // 2026-05-22 — Predictions now ship as the compact 4-line block from
  // PR #262 ( **SPY @ $X** · Range $Y-$Z / ▲ Bull above ... / ▼ Bear
  // below ... / Lean: ... ). Discord supports **bold** and Unicode
  // arrows natively so the block renders exactly as intended. The
  // 1024-char field limit is plenty for the new format (~120-180 chars
  // each), so we drop the slice(0, 380) ceiling — truncating mid-line
  // would break the structure.
  const _fitField = (s) => String(s || "").slice(0, 1000);
  if (esPrediction)   fields.push({ name: "📈 ES Prediction",  value: _fitField(esPrediction),  inline: false });
  if (spyPrediction)  fields.push({ name: "📊 SPY Prediction", value: _fitField(spyPrediction), inline: false });
  if (qqqPrediction)  fields.push({ name: "📊 QQQ Prediction", value: _fitField(qqqPrediction), inline: false });
  if (iwmPrediction)  fields.push({ name: "📊 IWM Prediction", value: _fitField(iwmPrediction), inline: false });

  // ── 4. Top Headlines (PR #264) ───────────────────────────────────────────
  // Top broad-market headlines from Finnhub (Reuters / Bloomberg / WSJ
  // etc.). Up to 4, each a single line. Hides when the headline feed
  // is empty / missing (no FINNHUB_API_KEY etc.).
  const _headlines = Array.isArray(infographic?.topHeadlines) ? infographic.topHeadlines : [];
  if (_headlines.length > 0) {
    const headlineStr = _headlines.slice(0, 4).map(h => {
      const t = String(h.title || "").slice(0, 110);
      const s = h.source ? ` _(${h.source})_` : "";
      return `• ${t}${s}`;
    }).join("\n");
    fields.push({ name: "📰 Top Headlines", value: headlineStr.slice(0, 1000), inline: false });
  }

  // ── 5. ATR Reference Levels (compact) ────────────────────────────────────
  // 2026-05-22 — Demoted to a single compact line per ETF. Predictions
  // above already carry actionable bull/bear triggers + targets; the
  // full 38.2/50/61.8 fib pair is reference-only — it doesn't deserve
  // its own oversized block. Keep it for traders who want the Saty
  // ladder, but make it scannable.
  const fmtFibCompact = (fib, label) => {
    if (!fib || !fib.levels) return null;
    const lvl = fib.levels;
    const gate = fib.goldenGate === "OPEN_UP" ? "🟢" : fib.goldenGate === "OPEN_DOWN" ? "🔴" : "⚪";
    return `${gate} ${label}: ±38.2% ${lvl["-38.2%"] ?? "—"} / ${lvl["+38.2%"] ?? "—"} · ±61.8% ${lvl["-61.8%"] ?? "—"} / ${lvl["+61.8%"] ?? "—"}`;
  };
  const refLines = [
    fmtFibCompact(fib.es,  "ES"),
    fmtFibCompact(fib.spy, "SPY"),
    fmtFibCompact(fib.nq,  "NQ"),
    fmtFibCompact(fib.qqq, "QQQ"),
    fmtFibCompact(fib.iwm, "IWM"),
  ].filter(Boolean);
  if (refLines.length > 0) {
    fields.push({
      name: "ATR Reference Levels",
      value: refLines.join("\n").slice(0, 1000),
      inline: false,
    });
  }

  // ── 5. Economic Events ───────────────────────────────────────────────────
  const econEvents = (data.todayEconomicEvents || []).slice(0, 3);
  if (econEvents.length > 0) {
    const econStr = econEvents.map(e => {
      const parts = [e.event];
      if (e.actual   != null && e.actual   !== "") parts.push(`Act: ${e.actual}${e.unit || ""}`);
      if (e.estimate != null && e.estimate !== "") parts.push(`Est: ${e.estimate}${e.unit || ""}`);
      if (e.prev     != null && e.prev     !== "") parts.push(`Prev: ${e.prev}${e.unit || ""}`);
      return parts.join(", ");
    }).join("\n");
    fields.push({ name: "Economic Data", value: econStr, inline: false });
  }

  // ── 6. Open Positions ────────────────────────────────────────────────────
  if (data.openTrades && data.openTrades.length > 0) {
    const posStr = data.openTrades.slice(0, 5).map(t =>
      `${t.ticker} ${t.direction}${t.pnlPct != null ? ` ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(1)}%` : ""}`
    ).join(" | ");
    fields.push({ name: "Open Positions", value: posStr, inline: false });
  }

  return {
    title: isMorning ? `☀️ Morning Brief — ${data.today}` : `🌙 Evening Brief — ${data.today}`,
    description: description || undefined,
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
    // Upstream builder (line ~1029) emits `dayChangePct`. Older schemas
    // used `changePct` / `chgPct` / `pct`. Accept all of them so the
    // infographic doesn't render 0/11 when upstream field name changes.
    const chg = Number(
      s.dayChangePct ?? s.day_change_pct ?? s.changePct ?? s.chgPct ?? s.pct
    );
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
      goldenGateProbability: l.goldenGateProbability || null,
      levels: l.levels || {},
      gamePlan: l.gamePlan || null,
    };
  };
  // V15 P0.7.42 — multi-day (weekly) ATR Fib levels mirror
  const _normWeeklyLevels = (tech) => {
    if (!tech || !tech.multiDayAtrLevels) return null;
    const w = tech.multiDayAtrLevels;
    return {
      anchor: w.anchor,
      weekAtr: w.weekAtr,
      currentPrice: w.currentPrice,
      goldenGate: w.goldenGate || "NEUTRAL",
      goldenGateNote: w.goldenGateNote || null,
      goldenGateProbability: w.goldenGateProbability || null,
      levels: w.levels || {},
    };
  };
  // V15 P0.7.96 — Overlay the canonical ticker-scenario over the per-tech
  // payload. The legacy `summarizeTechnical()` path (a) anchors fibs to
  // recent[length-2].c which is two sessions stale during pre-market, and
  // (b) has a game-plan fallback that produces invalid bull/bear pairs
  // (target on the wrong side of the trigger) when no overnight range is
  // available. The canonical scenario (worker/ticker-scenario.js) has
  // already been fixed to use prev_close + swing-reclaim levels and is
  // shared with the right rail. Prefer its values when present.
  const _extract = (sym, md, tech, scenario) => {
    if (!md && !scenario) return null;
    // Prefer scenario.price (live, includes pre-market) over md.price
    // (which is often the cached RTH-close snapshot).
    const livePrice = Number(scenario?.price) || Number(md?.price);
    const chg = Number(md?.changePct ?? md?.dp);
    const atr = Number(scenario?.atr14 ?? tech?.atr14 ?? tech?.atr);
    const baseLevels = _normLevels(tech);
    let mergedLevels = baseLevels;
    if (scenario?.ok && scenario?.game_plan) {
      // Use scenario's game plan + current price; keep tech's fib map
      // (anchor/levels object) for the DAY GATE bar so we don't lose
      // the existing visualization, but override the gamePlan + currentPrice.
      const gp = scenario.game_plan;
      mergedLevels = {
        ...(baseLevels || {}),
        currentPrice: Number.isFinite(livePrice) ? livePrice : (baseLevels?.currentPrice ?? null),
        gamePlan: {
          bullTrigger: Number(gp.bull_trigger) || null,
          bullTarget:  Number(gp.bull_target)  || null,
          bearTrigger: Number(gp.bear_trigger) || null,
          bearTarget:  Number(gp.bear_target)  || null,
        },
      };
    } else if (baseLevels?.gamePlan) {
      // Fallback: validate the legacy game-plan and drop it if the
      // bull/bear sides are inverted (target on the wrong side of trigger).
      const gp = baseLevels.gamePlan;
      const bullValid = Number.isFinite(gp.bullTrigger) && Number.isFinite(gp.bullTarget) && gp.bullTarget > gp.bullTrigger;
      const bearValid = Number.isFinite(gp.bearTrigger) && Number.isFinite(gp.bearTarget) && gp.bearTarget < gp.bearTrigger;
      if (!bullValid || !bearValid) {
        mergedLevels = { ...baseLevels, gamePlan: null };
      }
    }
    return {
      sym,
      price: Number.isFinite(livePrice) ? Math.round(livePrice * 100) / 100 : null,
      chgPct: Number.isFinite(chg) ? Math.round(chg * 100) / 100 : null,
      atr: Number.isFinite(atr) ? Math.round(atr * 100) / 100 : null,
      levels: mergedLevels,
      weeklyLevels: _normWeeklyLevels(tech),
      bias: scenario?.bias || null,
    };
  };
  const indices = [
    _extract("SPY", data.market?.SPY, data.spyTechnical, data.spyScenario),
    _extract("QQQ", data.market?.QQQ, data.qqqTechnical, data.qqqScenario),
    _extract("IWM", data.market?.IWM, data.iwmTechnical, data.iwmScenario),
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
    // 2026-05-22 — Top broad-market headlines (Reuters / Bloomberg / WSJ etc.)
    // surfaced verbatim in the infographic + email + web brief renderer.
    // Already capped to 6 in gatherDailyBriefData; we trim to 4 for the
    // visible block (compactness) and keep the full list available
    // through the data structure.
    topHeadlines: Array.isArray(data?.topHeadlines)
      ? data.topHeadlines.slice(0, 4).map(h => ({
          title: String(h.title || "").slice(0, 140),
          source: h.source || "",
          url: h.url || "",
          ts: Number(h.ts) || null,
        }))
      : [],
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
  // Take the last non-header line that looks like a decisive statement.
  // A "decisive statement" must look like a self-contained sentence:
  //   1) starts with a capital letter or quote / number — NOT lowercase
  //      (lowercase-starting lines are word-wrapped continuations of
  //      a previous paragraph; that's how the Today hero card ended up
  //      showing 'ward $708.37. Expected range: ...' — the tail of
  //      'toward $708.37' that got soft-wrapped onto its own line).
  //   2) ends with terminal punctuation (.!?) or a closing quote — not
  //      a hyphen / colon / comma / open paren.
  //   3) is not a bare number, level snippet, or 'Expected range:' line.
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l)) continue;
    if (/^[-*]\s/.test(l)) continue;
    if (l.length < 20 || l.length > 140) continue;
    const cleaned = l.replace(/^\*+|\*+$/g, "").trim();
    // Reject continuations of a previous sentence (the bug source).
    if (/^[a-z]/.test(cleaned)) continue;
    // Reject lines that don't end with terminal punctuation.
    if (!/[.!?'"”’)]$/.test(cleaned)) continue;
    // Reject pure level / range fragments that aren't real one-liners.
    if (/^Expected range\s*:/i.test(cleaned)) continue;
    if (/^\$?\d[\d.,\s$–\-]*$/.test(cleaned)) continue;
    return cleaned;
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
      // P0.7.154 (2026-05-14) — persist a stub so the operator has a
      // forensic artifact when the brief silently doesn't generate.
      // Without this, "why was there no morning brief?" forces a log
      // dive. With this, /timed/admin/daily-brief?type=morning returns
      // the stub and surfaces the failure reason inline.
      const _stubBlob = {
        ok: false,
        type,
        error: "ai_response_too_short",
        ai_content_length: content?.length || 0,
        prompt_length: (prompt || "").length,
        ts: Date.now(),
        date_et: data?.date_et || null,
      };
      try {
        const KV = env?.KV_TIMED;
        if (KV) {
          await KV.put(
            `timed:brief:stub:${type}:${data?.date_et || "unknown"}`,
            JSON.stringify(_stubBlob),
            { expirationTtl: 3 * 86400 },
          );
        }
      } catch {}
      return { ok: false, error: "ai_response_too_short", stub: _stubBlob };
    }

    // 3. Extract per-instrument predictions (one specific actionable
    //    sentence per ETF, parallel structure to the existing ES line).
    //    P0.7.129 — added SPY/QQQ/IWM extraction so the in-app brief and
    //    the Discord embed can surface a clean prediction for each ETF
    //    instead of just the raw ATR fib levels.
    //
    //    The model is instructed (in buildMorningPrompt) to emit a
    //    `**SPY Prediction**: …` / `**QQQ Prediction**: …` /
    //    `**IWM Prediction**: …` line matching the ES one. We capture
    //    each independently so we don't lose any if one is missing.
    function extractPredictionLine(label) {
      // 2026-05-26 — Prediction Scorecard MISS false-positive fix.
      //
      // The original two regexes both REQUIRED a colon after the label:
      //     `**ES Prediction**:` OR `ES Prediction:`
      //
      // But the model frequently emits the prediction as a MARKDOWN HEADING
      // with no colon:
      //     `## ES Prediction\nES likely spends the morning above 7523.24…`
      //
      // The heading rendered fine on the page (markdown-rendered) but
      // extractPredictionLine returned null. Morning brief stored
      // es_prediction=NULL → evening Prediction Scorecard rendered
      // "MISS — no morning ES prediction was provided" even though the
      // prediction was live in the brief content.
      //
      // Fix: add a third regex that matches `## Label Prediction\n<body>`
      // (heading-style, no colon) BEFORE falling back to the original
      // bullet/bold patterns. Heading body is captured up to the next
      // heading line or double newline.

      // 1) Heading style: `## ES Prediction` or `### ES Prediction` (no colon),
      //    followed by newline + body until the next heading/blank line.
      const reH = new RegExp(
        `^#{1,6}\\s+${label}\\s+Prediction\\s*$\\n+([\\s\\S]+?)(?=\\n\\s*\\n|\\n\\s*#{1,6}\\s|\\n\\s*\\*\\*[A-Z]|$)`,
        "im",
      );
      const mH = content.match(reH);
      if (mH && mH[1]) {
        const body = mH[1].trim();
        if (body) return body;
      }

      // 2) Bold + colon: `**Label Prediction**: body` (original primary).
      const re = new RegExp(
        `(?:\\*\\*)?${label}\\s+Prediction(?:\\*\\*)?\\s*:\\s*([\\s\\S]+?)(?:\\n\\s*\\n|\\n\\s*[#*\\-]|\\n\\s*\\*\\*[A-Z])`,
        "i",
      );
      const m = content.match(re);
      if (m && m[1]) return m[1].trim().replace(/\s+$/g, "");

      // 3) Single-line bold + colon (fallback for tight inline output).
      const re2 = new RegExp(
        `(?:\\*\\*)?${label}\\s+Prediction(?:\\*\\*)?\\s*:\\s*(.+?)(?:\\n|$)`,
        "i",
      );
      const m2 = content.match(re2);
      if (m2 && m2[1]) return m2[1].trim();

      // 4) Last-ditch: `**Label Prediction**\n<body>` (bold heading, no colon).
      const re3 = new RegExp(
        `\\*\\*${label}\\s+Prediction\\*\\*\\s*\\n+([\\s\\S]+?)(?=\\n\\s*\\n|\\n\\s*#{1,6}\\s|\\n\\s*\\*\\*[A-Z]|$)`,
        "i",
      );
      const m3 = content.match(re3);
      if (m3 && m3[1]) return m3[1].trim();

      return null;
    }
    const esPrediction  = extractPredictionLine("ES");
    const spyPrediction = extractPredictionLine("SPY");
    const qqqPrediction = extractPredictionLine("QQQ");
    const iwmPrediction = extractPredictionLine("IWM");

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
      // P0.7.129 — per-ETF predictions surfaced alongside the existing ES one.
      spyPrediction,
      qqqPrediction,
      iwmPrediction,
      publishedAt: now,
      infographic,
    };
    await kvPutJSON(KV, "timed:daily-brief:current", current);

    // 6. Update badge timestamp
    await kvPutJSON(KV, "timed:daily-brief:badge", { ts: now, type, date: data.today });

    // 7. Archive in D1
    if (db) {
      await d1EnsureBriefSchema(env);
      // P0.7.158 — capture per-index bull/bear trigger + target levels from the
      // infographic's gamePlan so the evening evaluator can compute hit-rate
      // without re-parsing the markdown. Falls back to NULL if any index lacks
      // a gamePlan (rare; typically means scenario didn't load for that index).
      const _indices = (infographic && infographic.indices) || [];
      const _gp = (sym) => {
        const r = _indices.find(i => String(i?.sym || "").toUpperCase() === sym);
        return (r && r.levels && r.levels.gamePlan) ? r.levels.gamePlan : null;
      };
      const _open = (sym) => {
        const r = _indices.find(i => String(i?.sym || "").toUpperCase() === sym);
        const px = Number(r?.levels?.currentPrice ?? r?.price ?? r?.last);
        return Number.isFinite(px) ? px : null;
      };
      const spyGp = _gp("SPY"), qqqGp = _gp("QQQ"), iwmGp = _gp("IWM");
      await db.prepare(`
        INSERT INTO daily_briefs (
          id, date, type, content, es_prediction, es_prediction_correct, es_close,
          spy_bull_trigger, spy_bull_target, spy_bear_trigger, spy_bear_target,
          qqq_bull_trigger, qqq_bull_target, qqq_bear_trigger, qqq_bear_target,
          iwm_bull_trigger, iwm_bull_target, iwm_bear_trigger, iwm_bear_target,
          spy_open, qqq_open, iwm_open,
          published_at, created_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, NULL, ?6,
          ?7, ?8, ?9, ?10,
          ?11, ?12, ?13, ?14,
          ?15, ?16, ?17, ?18,
          ?19, ?20, ?21,
          ?22, ?23
        )
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          es_prediction = excluded.es_prediction,
          es_close = excluded.es_close,
          spy_bull_trigger = COALESCE(excluded.spy_bull_trigger, daily_briefs.spy_bull_trigger),
          spy_bull_target  = COALESCE(excluded.spy_bull_target,  daily_briefs.spy_bull_target),
          spy_bear_trigger = COALESCE(excluded.spy_bear_trigger, daily_briefs.spy_bear_trigger),
          spy_bear_target  = COALESCE(excluded.spy_bear_target,  daily_briefs.spy_bear_target),
          qqq_bull_trigger = COALESCE(excluded.qqq_bull_trigger, daily_briefs.qqq_bull_trigger),
          qqq_bull_target  = COALESCE(excluded.qqq_bull_target,  daily_briefs.qqq_bull_target),
          qqq_bear_trigger = COALESCE(excluded.qqq_bear_trigger, daily_briefs.qqq_bear_trigger),
          qqq_bear_target  = COALESCE(excluded.qqq_bear_target,  daily_briefs.qqq_bear_target),
          iwm_bull_trigger = COALESCE(excluded.iwm_bull_trigger, daily_briefs.iwm_bull_trigger),
          iwm_bull_target  = COALESCE(excluded.iwm_bull_target,  daily_briefs.iwm_bull_target),
          iwm_bear_trigger = COALESCE(excluded.iwm_bear_trigger, daily_briefs.iwm_bear_trigger),
          iwm_bear_target  = COALESCE(excluded.iwm_bear_target,  daily_briefs.iwm_bear_target),
          spy_open = COALESCE(daily_briefs.spy_open, excluded.spy_open),
          qqq_open = COALESCE(daily_briefs.qqq_open, excluded.qqq_open),
          iwm_open = COALESCE(daily_briefs.iwm_open, excluded.iwm_open),
          published_at = excluded.published_at
      `).bind(
        briefId, data.today, type, content, esPrediction, esClose,
        spyGp?.bullTrigger ?? null, spyGp?.bullTarget ?? null, spyGp?.bearTrigger ?? null, spyGp?.bearTarget ?? null,
        qqqGp?.bullTrigger ?? null, qqqGp?.bullTarget ?? null, qqqGp?.bearTrigger ?? null, qqqGp?.bearTarget ?? null,
        iwmGp?.bullTrigger ?? null, iwmGp?.bullTarget ?? null, iwmGp?.bearTrigger ?? null, iwmGp?.bearTarget ?? null,
        _open("SPY"), _open("QQQ"), _open("IWM"),
        now, now
      ).run();
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
      // Pass infographic so topThree/closingLine appear in the description.
      const embed = buildDiscordBriefEmbed(type, data, content, esPrediction, spyPrediction, qqqPrediction, iwmPrediction, infographic);
      await opts.notifyDiscord(env, embed).catch(e =>
        console.warn("[DAILY BRIEF] Discord notification failed:", String(e).slice(0, 100))
      );
    }

    // 9. In-app notification (broadcast to all users)
    if (opts.d1InsertNotification) {
      // P0.7.129 — prefer the SPY prediction (broadest reach) for the
      // notification body. Falls back to ES, then a generic message.
      const notifBody = spyPrediction || esPrediction
        || `${type === "morning" ? "Morning" : "Evening"} brief published.`;
      await opts.d1InsertNotification(env, {
        email: null, type: "daily_brief",
        title: `${type === "morning" ? "Morning" : "Evening"} Brief — ${data.today}`,
        body: notifBody,
        link: "/daily-brief.html",
      }).catch(() => {});
    }

    // 10. Email daily brief to opted-in users
    const prefKey = type === "morning" ? "daily_brief_morning" : "daily_brief_evening";
    // 2026-05-21 — Observability. The user reported "I haven't received the
    // Daily Brief via email in a few days." Without runtime access there's
    // no way to tell whether (a) the cron never fired, (b) the recipient
    // set was empty, or (c) SendGrid rejected. Stash a compact snapshot of
    // the last send attempt in KV so the admin Mission Control / Email
    // Diagnostic endpoint can show exactly what happened and when.
    let _emailReport = { ok: false, recipients: 0, sent: 0, failed: 0, reason: "not_attempted" };
    try {
      const optedInUsers = await getEmailOptedInUsers(env, prefKey);
      _emailReport.recipients = optedInUsers.length;
      if (!optedInUsers.length) {
        _emailReport.reason = "no_opted_in_users";
        console.log(`[DAILY BRIEF] ${prefKey} emails: 0 recipients — nobody is currently opted in to this brief`);
      } else {
        // 2026-04-23: pass the structured infographic snapshot so the email
        // renders the same Today's-Three / headline badges / index cards /
        // events / risks / closing-line treatment as the web Daily Brief.
        const briefPayload = { type, content, date: data.today, esPrediction, infographic };
        const results = await Promise.allSettled(
          optedInUsers.map(u => sendDailyBriefEmail(env, u.email, briefPayload))
        );
        const sent = results.filter(r => r.status === "fulfilled" && r.value?.ok).length;
        const failed = results.length - sent;
        _emailReport.sent = sent;
        _emailReport.failed = failed;
        _emailReport.ok = sent > 0 && failed === 0;
        _emailReport.reason = sent > 0 ? (failed === 0 ? "ok" : "partial_failure") : "all_failed";
        // Capture up to 5 failure reasons so the admin can spot bad emails
        // / sendgrid rejects without grepping logs. Include `details`
        // (SendGrid response body, first 300 chars) so a 401 can be
        // distinguished between "key revoked" / "scope missing" /
        // "from address unverified" without needing wrangler tail.
        const failures = [];
        for (let i = 0; i < results.length && failures.length < 5; i++) {
          const r = results[i];
          const u = optedInUsers[i];
          if (r.status === "rejected") {
            failures.push({ to: u?.email, error: String(r.reason).slice(0, 200) });
          } else if (r.value && !r.value.ok) {
            failures.push({
              to: u?.email,
              error: r.value.error || "unknown",
              details: r.value.details ? String(r.value.details).slice(0, 300) : undefined,
            });
          }
        }
        if (failures.length) _emailReport.failure_samples = failures;
        console.log(`[DAILY BRIEF] ${prefKey} emails: ${sent} sent, ${failed} failed (${optedInUsers.length} recipients)`);
      }
    } catch (e) {
      _emailReport.reason = "exception";
      _emailReport.error = String(e?.message || e).slice(0, 200);
      console.warn("[DAILY BRIEF] Email dispatch failed:", String(e?.message || e).slice(0, 150));
    }
    // Persist the last-run snapshot. Admin endpoint reads this to render
    // a "Daily Brief Email Health" panel without needing tail access.
    try {
      const snap = {
        type, prefKey, date: data?.today || null,
        finishedAt: Date.now(),
        ..._emailReport,
      };
      await env?.KV_TIMED?.put(`timed:email:daily_brief:lastrun:${type}`, JSON.stringify(snap), {
        // Keep a month of history for the admin panel (overwritten on every
        // run, but TTL guards against an indefinitely-stuck stale value).
        expirationTtl: 30 * 24 * 3600,
      });
    } catch (e) {
      console.warn("[DAILY BRIEF] failed to persist email lastrun snapshot:", String(e?.message || e).slice(0, 120));
    }

    return { ok: true, id: briefId, elapsed, chars: content.length, email: _emailReport };
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
// INTRADAY FLASH BRIEF — real-time market insights in a technician's voice
// ═══════════════════════════════════════════════════════════════════════

const INTRADAY_SYSTEM_PROMPT = `You are a veteran market technician writing real-time flash insights for active traders. You've traded through every market cycle and you call it like you see it. Your voice is institutional — clear, direct, evidence-driven, never attributing to any external strategist or firm by name. Your insights land in a live feed that traders check throughout the session.

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
- Be concise, be specific, be a veteran technician.`;


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

  lines.push(`Write the flash insight.

CRITICAL OUTPUT FORMAT (2026-05-29 — Area A):

1. **First line MUST be a TLDR.** Single sentence, ≤ 25 words, lead with the lean.
   Example formats:
     "TLDR: Bull bias intact — SPY held 750.46 reclaim, tech leading, weak crude is the tailwind."
     "TLDR: Risk-off creep — VIX up 8%, breadth flipping red, watch for SPY 745 lose to confirm."
   No preamble before the TLDR. No "Today we see…". Just "TLDR: <lean>".

2. After the TLDR, leave one blank line, then write the flash insight body.

3. Lead the body with the cross-asset story driving the tape. Connect to equity
   action using our model signals. Give specific levels and a clear 1-3 session
   outlook. Under 400 words.

4. Spell out sector names on first mention ("Technology (XLK)", "Energy (XLE)").
   Translate jargon (SMC, FVG, ATR, RSI) the first time. Lead with WHAT IT MEANS,
   then the data.`);
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
    //
    // P0.7.153 (2026-05-14) — BUG FIX. The KV blob shape is
    //   { prices: { TICKER: {...}, ... }, ts, ... }
    // Iterating Object.entries(priceData) at the top level only
    // sees keys like "prices", "ts" — never the actual ticker rows
    // — so this loop produced ZERO movers. Fix: drill into
    // `priceData.prices` first.
    try {
      const priceData = await kvGetJSON(KV, "timed:prices");
      const priceMap = (priceData && typeof priceData === "object")
        ? (priceData.prices && typeof priceData.prices === "object" ? priceData.prices : priceData)
        : null;
      if (priceMap && typeof priceMap === "object") {
        const movers = [];
        const skipTickers = new Set(["SPY", "QQQ", "VX1!", "ES1!", "NQ1!", "VIX", "IWM", "DIA", "XLE", "XLK", "XLF", "XLU", "XLP", "XLY", "XLI", "XLV", "XLB", "XLRE", "XLC", "GLD", "TLT", "CL1!", "GC1!", "SI1!"]);
        for (const [ticker, d] of Object.entries(priceMap)) {
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
      // P0.7.154 (2026-05-14) — persist a stub so silent intraday-flash
      // failures leave a forensic trail. Same pattern as morning brief.
      const _stubBlob = {
        ok: false,
        type: "intraday",
        error: "ai_response_too_short",
        ai_content_length: content?.length || 0,
        prompt_length: (prompt || "").length,
        ts: Date.now(),
        date_et: data?.date_et || null,
      };
      try {
        const KV = env?.KV_TIMED;
        if (KV) {
          await KV.put(
            `timed:brief:stub:intraday:${data?.date_et || "unknown"}-${Date.now()}`,
            JSON.stringify(_stubBlob),
            { expirationTtl: 3 * 86400 },
          );
        }
      } catch {}
      return { ok: false, error: "ai_response_too_short", stub: _stubBlob };
    }

    // 2026-04-23: attach a compact "pulse" infographic to the intraday
    // entry — same data shape as the full daily infographic but the
    // frontend renders it as a single strip (VIX / breadth / SPY / QQQ
    // / IWM / open trades) since intraday is a quick-hit update.
    let intradayInfographic = null;
    try {
      intradayInfographic = buildBriefInfographic(data, "intraday");
      if (intradayInfographic) {
        intradayInfographic.topThree = extractTopThree(content);
        intradayInfographic.closingLine = extractClosingLine(content);
        intradayInfographic.compact = true; // signals UI to render strip, not full block
      }
    } catch (e) {
      console.warn("[INTRADAY BRIEF] infographic build error:", String(e).slice(0, 120));
    }

    const now = Date.now();
    const entry = {
      id: `intraday-${data.today}-${now}`,
      date: data.today,
      timeET: data.currentTimeET,
      content,
      publishedAt: now,
      infographic: intradayInfographic,
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

    // 2026-05-29 — Area A: dispatch Intraday Pulse to Discord (TRADE
    // lane — these are market-pulse insights for traders, not ops
    // noise). The TLDR sentence is the embed description so readers
    // get the lean at a glance in the channel; the full body is
    // linked via the brief permalink.
    if (opts.notifyDiscord) {
      try {
        const tldr = (() => {
          // First line of the brief, stripped of any "TLDR:" prefix.
          const firstLine = String(content || "").split(/\r?\n/)[0].trim();
          return firstLine.replace(/^TLDR:\s*/i, "").slice(0, 380);
        })();
        const brandColor = 0x9A7BFF; // violet — same as the in-app Intraday Flash chip
        const embed = {
          title: `Intraday Pulse · ${data.currentTimeET || "now"}`,
          description: tldr || "Flash insight published.",
          url: `https://timed-trading.com/daily-brief#${entry.id}`,
          color: brandColor,
          timestamp: new Date(now).toISOString(),
          footer: { text: "Timed Trading · Intraday Pulse" },
        };
        await opts.notifyDiscord(env, embed, "trade").catch(e =>
          console.warn("[INTRADAY BRIEF] Discord dispatch failed:", String(e?.message || e).slice(0, 200)),
        );
      } catch (e) {
        console.warn("[INTRADAY BRIEF] Discord prep failed:", String(e?.message || e).slice(0, 200));
      }
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
