// worker/opex-calendar.js
// ─────────────────────────────────────────────────────────────────────────────
// Monthly equity options expiration (OpEx) — 3rd Friday of each month.
// Triple witching months: March / June / September / December.
//
// Used by:
//   - macro-events-calendar (Today strip + Daily Brief)
//   - market_events D1 sync (pre-event entry block + risk-reduction trims)
// ─────────────────────────────────────────────────────────────────────────────

/** Calendar YYYY-MM-DD for the 3rd Friday of year/month (1–12). */
export function thirdFridayYmd(year, month1to12) {
  const y = Number(year);
  const m = Number(month1to12);
  if (!Number.isFinite(y) || !(m >= 1 && m <= 12)) return null;
  // UTC noon on the 1st — day-of-month math is calendar-stable.
  const first = new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));
  const dow = first.getUTCDay(); // 0=Sun … 5=Fri
  const firstFridayDom = 1 + ((5 - dow + 7) % 7);
  const day = firstFridayDom + 14;
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isTripleWitchingMonth(month1to12) {
  const m = Number(month1to12);
  return m === 3 || m === 6 || m === 9 || m === 12;
}

export function opexEventName(dateYmd) {
  const m = Number(String(dateYmd || "").slice(5, 7));
  if (isTripleWitchingMonth(m)) {
    return "Monthly Options Expiration (Triple Witching)";
  }
  return "Monthly Options Expiration (OpEx)";
}

/**
 * Equity options expire into the close — stamp 4:00 PM ET as the event
 * timestamp so the pre-event risk window (override hours) covers OpEx day
 * RTH rather than only a morning print.
 */
export const OPEX_EVENT_TIME_ET = "4:00 PM";
export const OPEX_RISK_WINDOW_HOURS = 8; // 8:00 AM → 4:00 PM ET on OpEx day

function monthIter(startYmd, months) {
  const y0 = Number(String(startYmd).slice(0, 4));
  const m0 = Number(String(startYmd).slice(5, 7));
  const out = [];
  for (let i = 0; i < months; i++) {
    const abs = (y0 * 12 + (m0 - 1)) + i;
    out.push({ year: Math.floor(abs / 12), month: (abs % 12) + 1 });
  }
  return out;
}

/**
 * Curated-shaped OpEx rows for the macro calendar:
 * { date, time_et, name, impact, kind }
 */
export function listOpexMacroEvents({ fromDate, toDate, months = 6 } = {}) {
  const from = String(fromDate || "").slice(0, 10);
  const to = String(toDate || "").slice(0, 10);
  const seed = from || new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const { year, month } of monthIter(seed, Math.max(1, months))) {
    const date = thirdFridayYmd(year, month);
    if (!date) continue;
    if (from && date < from) continue;
    if (to && date > to) continue;
    rows.push({
      date,
      time_et: OPEX_EVENT_TIME_ET,
      name: opexEventName(date),
      impact: "high",
      kind: "opex",
      estimate: null,
      actual: null,
      source: "opex_calendar",
    });
  }
  return rows;
}

/**
 * Upsert upcoming OpEx rows into market_events so entry/exit risk gates
 * do not wait on the next Daily Brief persist.
 */
export async function syncOpexIntoMarketEvents(env, { months = 4 } = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, reason: "no_db", upserted: 0 };

  let d1EnsureBriefSchema;
  let buildScheduledEventMeta;
  try {
    ({ d1EnsureBriefSchema, buildScheduledEventMeta } = await import("./daily-brief.js"));
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 120), upserted: 0 };
  }

  try {
    await d1EnsureBriefSchema(env);
  } catch (_) { /* schema best-effort */ }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const events = listOpexMacroEvents({ fromDate: today, months });
  if (!events.length) return { ok: true, upserted: 0 };

  const stmts = [];
  const now = Date.now();
  for (const ev of events) {
    const schedule = buildScheduledEventMeta({
      dateKey: ev.date,
      timeHint: ev.time_et,
      eventKey: "OPEX",
      eventType: "macro",
      hasActual: false,
    });
    const id = `macro-opex-${ev.date}`;
    stmts.push(
      db.prepare(`
        INSERT INTO market_events (
          id, date, event_type, event_key, event_name, ticker, impact, source,
          status, scheduled_ts, scheduled_time_et, session, actual, estimate,
          previous, surprise_pct, spy_reaction_pct, sector_reaction_pct, brief_note, created_at
        ) VALUES (?1,?2,'macro','OPEX',?3,NULL,'high','opex_calendar',?4,?5,?6,?7,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?8)
        ON CONFLICT(id) DO UPDATE SET
          event_key=excluded.event_key,
          event_name=excluded.event_name,
          impact=excluded.impact,
          source=excluded.source,
          status=excluded.status,
          scheduled_ts=excluded.scheduled_ts,
          scheduled_time_et=excluded.scheduled_time_et,
          session=excluded.session
      `).bind(
        id,
        ev.date,
        ev.name,
        schedule.status || "scheduled",
        schedule.scheduledTs,
        schedule.scheduledTimeEt,
        schedule.session || "rth",
        now,
      ),
    );
  }

  try {
    for (let i = 0; i < stmts.length; i += 25) {
      await db.batch(stmts.slice(i, i + 25));
    }
    return { ok: true, upserted: stmts.length };
  } catch (e) {
    console.warn("[OPEX] market_events sync failed:", String(e?.message || e).slice(0, 160));
    return { ok: false, reason: String(e?.message || e).slice(0, 120), upserted: 0 };
  }
}
