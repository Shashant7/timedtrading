// worker/foundation/discovery-move-utils.js
// Normalize move-discovery report rows (API may omit start_ts).

export function discoveryMoveAnchorTs(move = {}) {
  const direct = Number(move.start_ts ?? move.startTs);
  if (Number.isFinite(direct)) return direct;
  if (move.start_date) {
    const t = Date.parse(`${move.start_date}T14:30:00.000Z`);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export function discoveryMoveEndTs(move = {}) {
  const direct = Number(move.end_ts ?? move.endTs);
  if (Number.isFinite(direct)) return direct;
  if (move.end_date) {
    const t = Date.parse(`${move.end_date}T20:00:00.000Z`);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export function enrichDiscoveryMove(move = {}) {
  const start_ts = discoveryMoveAnchorTs(move);
  const end_ts = discoveryMoveEndTs(move);
  return {
    ...move,
    start_ts: start_ts ?? move.start_ts,
    end_ts: end_ts ?? move.end_ts,
    move_id: move.move_id || (start_ts ? `${move.ticker}:${start_ts}` : `${move.ticker}:${move.start_date || "unknown"}`),
  };
}

export function filterMissedDiscoveryMoves(moves = []) {
  return moves
    .filter((m) => String(m.capture || "").toUpperCase() === "MISSED")
    .map(enrichDiscoveryMove)
    .filter((m) => Number.isFinite(Number(m.start_ts)));
}

export function discoveryMoveStartDate(move = {}) {
  if (move.start_date) return String(move.start_date).slice(0, 10);
  const ts = discoveryMoveAnchorTs(move);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString().slice(0, 10);
}

export function discoveryMoveEndDate(move = {}) {
  if (move.end_date) return String(move.end_date).slice(0, 10);
  const ts = discoveryMoveEndTs(move);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString().slice(0, 10);
}

export function subtractCalendarDays(dateStr, days) {
  const base = String(dateStr || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return null;
  const n = Math.max(0, Number(days) || 0);
  const d = new Date(`${base}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function moveReplayDateRange(move = {}, opts = {}) {
  const preDays = Number.isFinite(Number(opts.preEntryDays))
    ? Number(opts.preEntryDays)
    : 5;
  const startDate = discoveryMoveStartDate(move);
  const endDate = discoveryMoveEndDate(move) || startDate;
  if (!startDate) return { startDate: null, endDate: null, sessions: [] };
  const replayStart = subtractCalendarDays(startDate, preDays) || startDate;
  const sessions = enumerateWeekdaySessions(replayStart, endDate);
  return { startDate: replayStart, endDate, sessions };
}

export function enumerateWeekdaySessions(startDate, endDate) {
  const start = String(startDate || "").slice(0, 10);
  const end = String(endDate || "").slice(0, 10);
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    return [];
  }
  const sessions = [];
  let cursor = new Date(`${start}T12:00:00Z`);
  const stop = new Date(`${end}T12:00:00Z`);
  while (cursor <= stop) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) sessions.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return sessions;
}
