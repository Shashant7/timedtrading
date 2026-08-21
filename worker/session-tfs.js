// Session-scale timeframes synthesized from existing 30m / 60m bars.
//
// 6.5H — one bar per NYSE regular session (09:30–16:00 America/New_York).
//         That is the cash-session chart: one SuperTrend step per trading day
//         without overnight prints contaminating the line.
// 9H   — three America/New_York buckets (00:00, 09:00, 18:00). The 09:00–18:00
//         bar is RTH plus the first two hours of after-hours.
//
// Pure. No indicator math — callers run SuperTrend / EMAs on the result.

export const SESSION_6_5H = "6.5H";
export const SESSION_9H = "9H";

const NY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function nyParts(ts) {
  const ms = Number(ts);
  if (!Number.isFinite(ms)) return null;
  const parts = {};
  for (const p of NY_FMT.formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const minute = Number(parts.minute);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  if (![hour, minute, year, month, day].every(Number.isFinite)) return null;
  return {
    year,
    month,
    day,
    hour,
    minute,
    dateKey: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

export function isNyRthBar(ts) {
  const p = nyParts(ts);
  if (!p) return false;
  const mins = p.hour * 60 + p.minute;
  // Include the 09:30 open bar; exclude the 16:00 print (session already closed).
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function aggregateGroup(bars, ts) {
  if (!Array.isArray(bars) || !bars.length) return null;
  const sorted = [...bars].sort((a, b) => Number(a.ts) - Number(b.ts));
  let h = -Infinity;
  let l = Infinity;
  let v = 0;
  for (const b of sorted) {
    const bh = Number(b.h);
    const bl = Number(b.l);
    if (Number.isFinite(bh) && bh > h) h = bh;
    if (Number.isFinite(bl) && bl < l) l = bl;
    v += Number(b.v) || 0;
  }
  const o = Number(sorted[0].o);
  const c = Number(sorted[sorted.length - 1].c);
  if (![o, h, l, c].every(Number.isFinite) || h === -Infinity || l === Infinity) return null;
  return { ts, o, h, l, c, v };
}

/**
 * One OHLC bar per NYSE RTH session from 30-minute (or finer RTH) bars.
 * `ts` is the first included print of that session.
 */
export function synthesizeRthSessionBars(bars) {
  if (!Array.isArray(bars) || !bars.length) return [];
  const groups = new Map();
  for (const b of bars) {
    const ts = Number(b?.ts);
    if (!Number.isFinite(ts) || !isNyRthBar(ts)) continue;
    const p = nyParts(ts);
    if (!p) continue;
    if (!groups.has(p.dateKey)) groups.set(p.dateKey, []);
    groups.get(p.dateKey).push(b);
  }
  const out = [];
  for (const key of [...groups.keys()].sort()) {
    const grp = groups.get(key);
    const firstTs = Math.min(...grp.map((b) => Number(b.ts)).filter(Number.isFinite));
    const agg = aggregateGroup(grp, firstTs);
    if (agg) out.push(agg);
  }
  return out;
}

/**
 * 9-hour bars aligned to America/New_York midnight: 00:00, 09:00, 18:00.
 * `ts` is the first included print in the bucket.
 */
export function synthesizeNineHourBars(bars) {
  if (!Array.isArray(bars) || !bars.length) return [];
  const groups = new Map();
  for (const b of bars) {
    const ts = Number(b?.ts);
    const p = nyParts(ts);
    if (!p) continue;
    const bucketHour = Math.floor(p.hour / 9) * 9;
    const key = `${p.dateKey}T${String(bucketHour).padStart(2, "0")}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const out = [];
  for (const key of [...groups.keys()].sort()) {
    const grp = groups.get(key);
    const firstTs = Math.min(...grp.map((x) => Number(x.ts)).filter(Number.isFinite));
    const agg = aggregateGroup(grp, firstTs);
    if (agg) out.push(agg);
  }
  return out;
}
