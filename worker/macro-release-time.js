// worker/macro-release-time.js
// Shared helpers: has a scheduled macro event officially released yet (ET)?

const MONTH_ABBR = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const DEFAULT_RELEASE_MINUTES = 8 * 60 + 30; // 8:30 AM ET when time is unknown

export function parseTimeEtMinutes(timeEt) {
  const s = String(timeEt || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3].toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

export function nyNowParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  const weekday = get("weekday");
  const isWeekday = weekday && !["Sat", "Sun"].includes(weekday);
  return { date, minutes, isWeekday };
}

/**
 * True once the scheduled ET release time has passed (or the calendar day after
 * for past-dated events). Future-dated events are never released.
 */
export function macroEventHasReleased(event, now = new Date()) {
  if (!event?.date || !/^\d{4}-\d{2}-\d{2}$/.test(event.date)) return false;
  const { date: nyToday, minutes: nowMin } = nyNowParts(now);
  if (event.date > nyToday) return false;
  if (event.date < nyToday) return true;
  const relMin = parseTimeEtMinutes(event.time_et) ?? DEFAULT_RELEASE_MINUTES;
  return nowMin >= relMin;
}

/**
 * Parse the reference month embedded in names like "May JOLTS" or "Jun Empire
 * Manufacturing". Returns { year, month0 } or null when not parseable.
 */
export function parseReferenceMonthFromEventName(name, eventDate) {
  const m = String(name || "").match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i);
  if (!m || !eventDate) return null;
  const month0 = MONTH_ABBR[m[1].toLowerCase()];
  if (month0 == null) return null;
  const eventYear = parseInt(eventDate.slice(0, 4), 10);
  const eventMonth0 = parseInt(eventDate.slice(5, 7), 10) - 1;
  // Dec CPI released mid-Jan → reference year rolls back.
  const year = month0 > eventMonth0 + 1 ? eventYear - 1 : eventYear;
  return { year, month0 };
}

/** FRED obs_date (YYYY-MM-DD) matches the event's named reference month. */
export function fredObsMatchesEventReference(event, obsDate) {
  if (!obsDate || !/^\d{4}-\d{2}-\d{2}$/.test(obsDate)) return false;
  const ref = parseReferenceMonthFromEventName(event?.name, event?.date);
  if (!ref) return false;
  const obsYear = parseInt(obsDate.slice(0, 4), 10);
  const obsMonth0 = parseInt(obsDate.slice(5, 7), 10) - 1;
  return obsYear === ref.year && obsMonth0 === ref.month0;
}

/** Remove premature actuals from events not yet past their ET release time. */
export function stripPreReleaseActuals(events, now = new Date()) {
  for (const e of events || []) {
    if (!e || macroEventHasReleased(e, now)) continue;
    delete e.actual;
    delete e.actual_source;
  }
  return events;
}
