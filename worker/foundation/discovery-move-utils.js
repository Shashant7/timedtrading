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
