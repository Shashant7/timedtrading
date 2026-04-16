import {
  d1EnsureBriefSchema,
  classifyMarketEventKey,
  buildScheduledEventMeta,
  parseSurprise,
} from "./daily-brief.js";
import { tdFetchTickerEarnings, tdFetchEarningsCalendar } from "./twelvedata.js";
import { SECTOR_MAP, TICKER_TYPE_MAP, getSector, getSectorETF } from "./sector-mapping.js";

export const HISTORICAL_MARKET_EVENTS_DEFAULTS = {
  startDate: "2025-07-01",
  endDate: "2026-04-02",
  earningsLimit: 10,
};

export const CURATED_MACRO_EVENTS = [
  { date: "2025-07-11", name: "CPI (Jun 2025)", impact: "high", actual: "2.97", estimate: "3.1", previous: "3.3" },
  { date: "2025-08-14", name: "CPI (Jul 2025)", impact: "high", actual: "2.89", estimate: "2.9", previous: "2.97" },
  { date: "2025-09-10", name: "CPI (Aug 2025)", impact: "high", actual: "2.53", estimate: "2.6", previous: "2.89" },
  { date: "2025-10-15", name: "CPI (Sep 2025)", impact: "high", actual: "2.44", estimate: "2.5", previous: "2.53" },
  { date: "2025-11-13", name: "CPI (Oct 2025)", impact: "high", actual: "2.60", estimate: "2.6", previous: "2.44" },
  { date: "2025-12-11", name: "CPI (Nov 2025)", impact: "high", actual: "2.75", estimate: "2.7", previous: "2.60" },
  { date: "2026-01-15", name: "CPI (Dec 2025)", impact: "high", actual: "2.89", estimate: "2.9", previous: "2.75" },
  { date: "2026-02-12", name: "CPI (Jan 2026)", impact: "high", actual: "3.00", estimate: "2.9", previous: "2.89" },
  { date: "2026-03-12", name: "CPI (Feb 2026)", impact: "high", actual: "2.84", estimate: "2.9", previous: "3.00" },
  { date: "2025-07-15", name: "PPI (Jun 2025)", impact: "high", actual: "2.7", estimate: "2.5", previous: "2.2" },
  { date: "2025-08-12", name: "PPI (Jul 2025)", impact: "high", actual: "2.2", estimate: "2.3", previous: "2.7" },
  { date: "2025-09-12", name: "PPI (Aug 2025)", impact: "high", actual: "1.7", estimate: "1.8", previous: "2.2" },
  { date: "2025-10-14", name: "PPI (Sep 2025)", impact: "high", actual: "1.8", estimate: "1.6", previous: "1.7" },
  { date: "2025-11-14", name: "PPI (Oct 2025)", impact: "high", actual: "2.4", estimate: "2.3", previous: "1.8" },
  { date: "2025-12-12", name: "PPI (Nov 2025)", impact: "high", actual: "3.0", estimate: "2.6", previous: "2.4" },
  { date: "2026-01-14", name: "PPI (Dec 2025)", impact: "high", actual: "3.3", estimate: "3.5", previous: "3.0" },
  { date: "2026-02-13", name: "PPI (Jan 2026)", impact: "high", actual: "3.5", estimate: "3.3", previous: "3.3" },
  { date: "2026-03-13", name: "PPI (Feb 2026)", impact: "high", actual: "3.2", estimate: "3.3", previous: "3.5" },
  { date: "2025-07-30", name: "FOMC Rate Decision (Jul 2025)", impact: "high", actual: "5.25-5.50", estimate: "5.25-5.50", previous: "5.25-5.50" },
  { date: "2025-09-18", name: "FOMC Rate Decision (Sep 2025)", impact: "high", actual: "4.75-5.00", estimate: "5.00-5.25", previous: "5.25-5.50" },
  { date: "2025-11-07", name: "FOMC Rate Decision (Nov 2025)", impact: "high", actual: "4.50-4.75", estimate: "4.50-4.75", previous: "4.75-5.00" },
  { date: "2025-12-18", name: "FOMC Rate Decision (Dec 2025)", impact: "high", actual: "4.25-4.50", estimate: "4.25-4.50", previous: "4.50-4.75" },
  { date: "2026-01-29", name: "FOMC Rate Decision (Jan 2026)", impact: "high", actual: "4.25-4.50", estimate: "4.25-4.50", previous: "4.25-4.50" },
  { date: "2026-03-19", name: "FOMC Rate Decision (Mar 2026)", impact: "high", actual: null, estimate: "4.25-4.50", previous: "4.25-4.50" },
  { date: "2025-07-26", name: "PCE Price Index (Jun 2025)", impact: "high", actual: "2.5", estimate: "2.5", previous: "2.6" },
  { date: "2025-08-30", name: "PCE Price Index (Jul 2025)", impact: "high", actual: "2.5", estimate: "2.5", previous: "2.5" },
  { date: "2025-09-27", name: "PCE Price Index (Aug 2025)", impact: "high", actual: "2.2", estimate: "2.3", previous: "2.5" },
  { date: "2025-10-31", name: "PCE Price Index (Sep 2025)", impact: "high", actual: "2.1", estimate: "2.1", previous: "2.2" },
  { date: "2025-11-27", name: "PCE Price Index (Oct 2025)", impact: "high", actual: "2.3", estimate: "2.3", previous: "2.1" },
  { date: "2025-12-20", name: "PCE Price Index (Nov 2025)", impact: "high", actual: "2.4", estimate: "2.5", previous: "2.3" },
  { date: "2026-01-31", name: "PCE Price Index (Dec 2025)", impact: "high", actual: "2.6", estimate: "2.5", previous: "2.4" },
  { date: "2026-02-28", name: "PCE Price Index (Jan 2026)", impact: "high", actual: "2.5", estimate: "2.5", previous: "2.6" },
  { date: "2025-07-05", name: "Non-Farm Payrolls (Jun 2025)", impact: "high", actual: "206K", estimate: "190K", previous: "218K" },
  { date: "2025-08-01", name: "Non-Farm Payrolls (Jul 2025)", impact: "high", actual: "114K", estimate: "175K", previous: "206K" },
  { date: "2025-09-06", name: "Non-Farm Payrolls (Aug 2025)", impact: "high", actual: "142K", estimate: "165K", previous: "114K" },
  { date: "2025-10-04", name: "Non-Farm Payrolls (Sep 2025)", impact: "high", actual: "254K", estimate: "140K", previous: "142K" },
  { date: "2025-11-01", name: "Non-Farm Payrolls (Oct 2025)", impact: "high", actual: "12K", estimate: "113K", previous: "254K" },
  { date: "2025-12-06", name: "Non-Farm Payrolls (Nov 2025)", impact: "high", actual: "227K", estimate: "200K", previous: "12K" },
  { date: "2026-01-10", name: "Non-Farm Payrolls (Dec 2025)", impact: "high", actual: "256K", estimate: "164K", previous: "227K" },
  { date: "2026-02-07", name: "Non-Farm Payrolls (Jan 2026)", impact: "high", actual: "143K", estimate: "170K", previous: "256K" },
  { date: "2026-03-07", name: "Non-Farm Payrolls (Feb 2026)", impact: "high", actual: "151K", estimate: "160K", previous: "143K" },
  { date: "2025-07-30", name: "GDP Q2 2025 Advance", impact: "high", actual: "2.8", estimate: "2.0", previous: "1.4" },
  { date: "2025-10-30", name: "GDP Q3 2025 Advance", impact: "high", actual: "2.8", estimate: "3.0", previous: "3.0" },
  { date: "2026-01-30", name: "GDP Q4 2025 Advance", impact: "high", actual: "2.3", estimate: "2.6", previous: "3.1" },
  { date: "2025-07-16", name: "Retail Sales (Jun 2025)", impact: "medium", actual: "0.0", estimate: "-0.3", previous: "0.3" },
  { date: "2025-08-15", name: "Retail Sales (Jul 2025)", impact: "medium", actual: "1.0", estimate: "0.3", previous: "0.0" },
  { date: "2025-09-17", name: "Retail Sales (Aug 2025)", impact: "medium", actual: "0.1", estimate: "0.2", previous: "1.0" },
  { date: "2025-10-17", name: "Retail Sales (Sep 2025)", impact: "medium", actual: "0.4", estimate: "0.3", previous: "0.1" },
  { date: "2025-11-15", name: "Retail Sales (Oct 2025)", impact: "medium", actual: "0.4", estimate: "0.3", previous: "0.4" },
  { date: "2025-12-17", name: "Retail Sales (Nov 2025)", impact: "medium", actual: "0.7", estimate: "0.5", previous: "0.4" },
  { date: "2026-01-16", name: "Retail Sales (Dec 2025)", impact: "medium", actual: "0.4", estimate: "0.6", previous: "0.7" },
  { date: "2026-02-14", name: "Retail Sales (Jan 2026)", impact: "medium", actual: "-0.9", estimate: "-0.2", previous: "0.4" },
  { date: "2026-03-17", name: "Retail Sales (Feb 2026)", impact: "medium", actual: "0.2", estimate: "0.6", previous: "-0.9" },
  { date: "2025-07-01", name: "ISM Manufacturing PMI (Jun 2025)", impact: "medium", actual: "48.5", estimate: "49.1", previous: "48.7" },
  { date: "2025-08-01", name: "ISM Manufacturing PMI (Jul 2025)", impact: "medium", actual: "46.8", estimate: "48.8", previous: "48.5" },
  { date: "2025-09-03", name: "ISM Manufacturing PMI (Aug 2025)", impact: "medium", actual: "47.2", estimate: "47.5", previous: "46.8" },
  { date: "2025-10-01", name: "ISM Manufacturing PMI (Sep 2025)", impact: "medium", actual: "47.2", estimate: "47.6", previous: "47.2" },
  { date: "2025-11-01", name: "ISM Manufacturing PMI (Oct 2025)", impact: "medium", actual: "46.5", estimate: "47.6", previous: "47.2" },
  { date: "2025-12-01", name: "ISM Manufacturing PMI (Nov 2025)", impact: "medium", actual: "48.4", estimate: "47.5", previous: "46.5" },
  { date: "2026-01-03", name: "ISM Manufacturing PMI (Dec 2025)", impact: "medium", actual: "49.3", estimate: "48.4", previous: "48.4" },
  { date: "2026-02-03", name: "ISM Manufacturing PMI (Jan 2026)", impact: "medium", actual: "50.9", estimate: "49.5", previous: "49.3" },
  { date: "2026-03-03", name: "ISM Manufacturing PMI (Feb 2026)", impact: "medium", actual: "50.3", estimate: "50.5", previous: "50.9" },
  { date: "2025-08-01", name: "Initial Jobless Claims (week)", impact: "medium", actual: "249K", estimate: "236K", previous: "235K" },
  { date: "2025-10-03", name: "Initial Jobless Claims (week)", impact: "medium", actual: "225K", estimate: "222K", previous: "219K" },
  { date: "2026-01-23", name: "Initial Jobless Claims (week)", impact: "medium", actual: "223K", estimate: "221K", previous: "217K" },
  { date: "2026-02-20", name: "Initial Jobless Claims (week)", impact: "medium", actual: "219K", estimate: "215K", previous: "213K" },
];

function asDateKey(value, fallback) {
  const raw = String(value || fallback || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function monthChunks(startDate, endDate) {
  const chunks = [];
  let cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const chunkStart = new Date(Date.UTC(year, month, 1));
    const chunkEnd = new Date(Date.UTC(year, month + 1, 0));
    const startKey = chunkStart.toISOString().slice(0, 10) < startDate ? startDate : chunkStart.toISOString().slice(0, 10);
    const endKey = chunkEnd.toISOString().slice(0, 10) > endDate ? endDate : chunkEnd.toISOString().slice(0, 10);
    chunks.push({ startDate: startKey, endDate: endKey });
    cursor = new Date(Date.UTC(year, month + 1, 1));
  }
  return chunks;
}

async function runStatements(db, statements) {
  if (!Array.isArray(statements) || statements.length === 0) return;
  for (const chunk of chunkArray(statements, 100)) {
    await db.batch(chunk);
  }
}

async function loadSnapshotReactions(db, startDate, endDate) {
  const { results } = await db.prepare(
    `SELECT date, spy_pct, offense_avg_pct, defense_avg_pct
     FROM daily_market_snapshots
     WHERE date >= ?1 AND date <= ?2`
  ).bind(startDate, endDate).all();
  const spyByDate = new Map();
  const sectorByDate = new Map();
  for (const row of results || []) {
    const dateKey = asDateKey(row?.date);
    if (!dateKey) continue;
    spyByDate.set(dateKey, Number.isFinite(Number(row?.spy_pct)) ? Number(row.spy_pct) : null);
    const offense = Number(row?.offense_avg_pct);
    const defense = Number(row?.defense_avg_pct);
    sectorByDate.set(
      dateKey,
      Number.isFinite(offense) && Number.isFinite(defense) ? ((offense + defense) / 2) : null,
    );
  }
  return { spyByDate, sectorByDate };
}

function getEligibleEarningsTickers({
  ticker = null,
  offset = 0,
  limit = HISTORICAL_MARKET_EVENTS_DEFAULTS.earningsLimit,
  allTickers = false,
} = {}) {
  const single = String(ticker || "").toUpperCase().trim();
  if (single) return [single];
  const excluded = new Set(["crypto", "sector_etf", "broad_etf", "commodity_etf"]);
  const all = Object.keys(SECTOR_MAP).filter((sym) => !excluded.has(String(TICKER_TYPE_MAP[sym] || "").toLowerCase()));
  if (allTickers) return all;
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.max(1, Math.min(50, Number(limit) || HISTORICAL_MARKET_EVENTS_DEFAULTS.earningsLimit));
  return all.slice(start, start + size);
}

function buildMacroStatements(db, reactions, startDate, endDate, nowTs) {
  const statements = [];
  let seeded = 0;
  for (const ev of CURATED_MACRO_EVENTS) {
    if (!ev?.date || ev.date < startDate || ev.date > endDate) continue;
    const eventKey = classifyMarketEventKey(ev.name, "macro");
    const schedule = buildScheduledEventMeta({
      dateKey: ev.date,
      timeHint: "",
      eventKey,
      eventType: "macro",
      hasActual: ev.actual != null && String(ev.actual).trim() !== "",
    });
    const id = `macro-${ev.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}-${ev.date}`;
    statements.push(
      db.prepare(`
        INSERT INTO market_events (id, date, event_type, event_key, event_name, ticker, impact, source, status, scheduled_ts, scheduled_time_et, session, actual, estimate, previous, surprise_pct, spy_reaction_pct, sector_reaction_pct, brief_note, created_at)
        VALUES (?1,?2,'macro',?3,?4,NULL,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,NULL,?17)
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
          spy_reaction_pct=excluded.spy_reaction_pct,
          sector_reaction_pct=excluded.sector_reaction_pct
      `).bind(
        id,
        ev.date,
        eventKey,
        ev.name,
        ev.impact || "medium",
        "historical_seed_macro",
        schedule.status,
        schedule.scheduledTs,
        schedule.scheduledTimeEt,
        schedule.session,
        ev.actual ?? null,
        ev.estimate ?? null,
        ev.previous ?? null,
        parseSurprise(ev.actual, ev.estimate),
        reactions.spyByDate.get(ev.date) ?? null,
        reactions.sectorByDate.get(ev.date) ?? null,
        nowTs,
      ),
    );
    seeded += 1;
  }
  return { statements, seeded };
}

async function buildEarningsStatements(env, db, reactions, tickers, startDate, endDate, nowTs) {
  const statements = [];
  const errors = [];
  let seeded = 0;
  const seen = new Set();
  const allowedTickers = new Set(tickers);
  const addEvent = (ticker, ev, dateKey) => {
    const sym = String(ticker || "").toUpperCase().trim();
    if (!sym || !allowedTickers.has(sym)) return;
    const epsActual = ev?.eps_actual ?? ev?.epsActual ?? ev?.actual_eps ?? ev?.actual ?? null;
    const epsEstimate = ev?.eps_estimate ?? ev?.epsEstimate ?? ev?.estimate_eps ?? ev?.estimate ?? null;
    if (epsActual == null && epsEstimate == null) return;
    const id = `earn-${sym}-${dateKey}`;
    if (seen.has(id)) return;
    seen.add(id);
    const sector = getSector(sym);
    const sectorEtf = getSectorETF(sector);
    const timeHint = ev?.time || ev?.hour || ev?.when || "";
    const schedule = buildScheduledEventMeta({
      dateKey,
      timeHint,
      eventKey: "EARNINGS",
      eventType: "earnings",
      hasActual: epsActual != null,
    });
    statements.push(
      db.prepare(`
        INSERT INTO market_events (id, date, event_type, event_key, event_name, ticker, impact, source, status, scheduled_ts, scheduled_time_et, session, actual, estimate, previous, surprise_pct, spy_reaction_pct, sector_reaction_pct, brief_note, created_at)
        VALUES (?1,?2,'earnings','EARNINGS',?3,?4,'high',?5,?6,?7,?8,?9,?10,?11,NULL,?12,?13,?14,?15,?16)
        ON CONFLICT(id) DO UPDATE SET
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
          sector_reaction_pct=excluded.sector_reaction_pct,
          brief_note=excluded.brief_note
      `).bind(
        id,
        dateKey,
        `${sym} Earnings`,
        sym,
        "historical_seed_earnings",
        schedule.status,
        schedule.scheduledTs,
        schedule.scheduledTimeEt,
        schedule.session,
        epsActual != null ? `$${epsActual} EPS` : null,
        epsEstimate != null ? `$${epsEstimate} EPS` : null,
        Number.isFinite(Number(ev?.surprise_prc ?? ev?.surprise_pct)) ? Number(ev?.surprise_prc ?? ev?.surprise_pct) : parseSurprise(epsActual, epsEstimate),
        reactions.spyByDate.get(dateKey) ?? null,
        reactions.sectorByDate.get(dateKey) ?? null,
        sector ? `Sector: ${sector}${sectorEtf ? ` (${sectorEtf})` : ""}` : null,
        nowTs,
      ),
    );
    seeded += 1;
  };

  if (tickers.length === 1) {
    const ticker = tickers[0];
    try {
      const res = await tdFetchTickerEarnings(env, ticker);
      if (res?._error) {
        errors.push({ ticker, error: String(res._error) });
      } else {
        const earnings = Array.isArray(res?.earnings) ? res.earnings : [];
        for (const ev of earnings) {
          const dateKey = asDateKey(ev?.date);
          if (!dateKey || dateKey < startDate || dateKey > endDate) continue;
          addEvent(ticker, ev, dateKey);
        }
      }
      // Twelve Data's per-symbol earnings endpoint can intermittently return an
      // empty list even when the same symbol is present in the date-range
      // earnings calendar. Fall back to the calendar feed so focused replay
      // seeding does not silently miss known earnings events for a single ticker.
      if (seeded === 0) {
        for (const chunk of monthChunks(startDate, endDate)) {
          try {
            const calRes = await tdFetchEarningsCalendar(env, chunk.startDate, chunk.endDate);
            if (calRes?._error) {
              errors.push({ ticker, range: `${chunk.startDate}:${chunk.endDate}`, error: String(calRes._error) });
              continue;
            }
            const calendar = calRes?.earnings && typeof calRes.earnings === "object" ? calRes.earnings : {};
            for (const [dateKeyRaw, events] of Object.entries(calendar)) {
              const dateKey = asDateKey(dateKeyRaw);
              if (!dateKey || dateKey < startDate || dateKey > endDate || !Array.isArray(events)) continue;
              for (const ev of events) {
                const evTicker = String(ev?.symbol || ev?.ticker || "").toUpperCase().trim();
                if (evTicker !== ticker) continue;
                addEvent(ticker, ev, dateKey);
              }
            }
            if (seeded > 0) break;
          } catch (err) {
            errors.push({ ticker, range: `${chunk.startDate}:${chunk.endDate}`, error: String(err?.message || err).slice(0, 200) });
          }
        }
      }
    } catch (err) {
      errors.push({ ticker, error: String(err?.message || err).slice(0, 200) });
    }
    return { statements, seeded, errors };
  }

  for (const chunk of monthChunks(startDate, endDate)) {
    try {
      const res = await tdFetchEarningsCalendar(env, chunk.startDate, chunk.endDate);
      if (res?._error) {
        errors.push({ range: `${chunk.startDate}:${chunk.endDate}`, error: String(res._error) });
        continue;
      }
      const calendar = res?.earnings && typeof res.earnings === "object" ? res.earnings : {};
      for (const [dateKeyRaw, events] of Object.entries(calendar)) {
        const dateKey = asDateKey(dateKeyRaw);
        if (!dateKey || dateKey < startDate || dateKey > endDate || !Array.isArray(events)) continue;
        for (const ev of events) {
          const ticker = String(ev?.symbol || ev?.ticker || "").toUpperCase().trim();
          addEvent(ticker, ev, dateKey);
        }
      }
    } catch (err) {
      errors.push({ range: `${chunk.startDate}:${chunk.endDate}`, error: String(err?.message || err).slice(0, 200) });
    }
  }
  return { statements, seeded, errors };
}

export async function seedHistoricalMarketEvents(env, options = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "d1_not_configured" };
  await d1EnsureBriefSchema(env);

  const startDate = asDateKey(options.startDate, HISTORICAL_MARKET_EVENTS_DEFAULTS.startDate);
  const endDate = asDateKey(options.endDate, HISTORICAL_MARKET_EVENTS_DEFAULTS.endDate);
  if (!startDate || !endDate || startDate > endDate) {
    return { ok: false, error: "invalid_date_range" };
  }

  const includeMacro = options.includeMacro !== false;
  const includeEarnings = options.includeEarnings !== false;
  const dryRun = options.dryRun === true;
  const offset = Number.isFinite(Number(options.offset)) ? Math.max(0, Number(options.offset)) : 0;
  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(1, Math.min(50, Number(options.limit)))
    : null;
  const ticker = String(options.ticker || "").toUpperCase().trim() || null;
  const allTickers = options.allTickers === true || (!ticker && options.limit == null && options.offset == null);
  const reactions = await loadSnapshotReactions(db, startDate, endDate);
  const nowTs = Date.now();

  const earningsTickers = includeEarnings
    ? getEligibleEarningsTickers({ ticker, offset, limit, allTickers })
    : [];

  let macroSeeded = 0;
  let earningsSeeded = 0;
  const errors = [];
  const statements = [];

  if (includeMacro) {
    const macro = buildMacroStatements(db, reactions, startDate, endDate, nowTs);
    macroSeeded = macro.seeded;
    statements.push(...macro.statements);
  }

  if (includeEarnings && earningsTickers.length > 0) {
    const earnings = await buildEarningsStatements(env, db, reactions, earningsTickers, startDate, endDate, nowTs);
    earningsSeeded = earnings.seeded;
    statements.push(...earnings.statements);
    errors.push(...earnings.errors);
  }

  if (!dryRun) {
    await runStatements(db, statements);
  }

  return {
    ok: true,
    dryRun,
    startDate,
    endDate,
    includeMacro,
    includeEarnings,
    macroSeeded,
    earningsSeeded,
    earningsTickersProcessed: earningsTickers.length,
    earningsTickerBatch: earningsTickers,
    allTickers,
    offset,
    limit,
    errors,
    statementsPrepared: statements.length,
  };
}
