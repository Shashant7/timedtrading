// Activity-feed de-duplication helpers.
//
// The merged activity feed pulls from three sources that can each describe the
// SAME action: the D1 execution/lots rows, the KV `timed:activity:feed`, and
// per-action `appendActivity` writes. Investor actions in particular surfaced
// twice (operator 2026-06-24: CRDO/RIOT showed duplicate rows) because the D1
// investor_lots row carries a `lot_id` while the KV INVESTOR_SIGNAL append does
// not — so a single primary key never collided.
//
// Strategy: every event yields MULTIPLE candidate keys. An event is a duplicate
// if ANY of its keys was already seen. Investor events get a semantic key
// (ticker + coarse action class + 10-min bucket) so cross-channel copies of the
// same trim/close/buy collapse regardless of which one carries the lot_id.

/** Normalize activity timestamps to epoch ms (feed rows may use seconds). */
export function normalizeActivityTsMs(ts) {
  const n = Number(ts) || 0;
  if (n <= 0) return 0;
  return n > 1e12 ? n : n * 1000;
}

/** Coarse action class for an investor activity event. */
export function investorActionClass(ev) {
  const a = String(ev?.action || ev?.investor_alert_type || ev?.type || "").toUpperCase();
  if (/SELL|TRIM|REDUCE|CLOSE|EXIT/.test(a)) return "sell";
  if (/BUY|ADD|ACCUMULAT|QUEUE|OPEN/.test(a)) return "buy";
  return "other";
}

/** Single primary key (kept for backward-compatible call sites). */
export function activityDedupeKey(ev) {
  if (ev?.lot_id) return `lot:${ev.lot_id}`;
  const tsMs = normalizeActivityTsMs(ev?.ts);
  return `${String(ev?.ticker || "").toUpperCase()}-${String(ev?.type || "").toUpperCase()}-${String(ev?.action || ev?.investor_alert_type || "")}-${Math.floor(tsMs / 60000)}`;
}

/** All candidate dedupe keys for an event (dup if ANY already seen). */
export function activityDedupeKeys(ev) {
  const keys = [];
  if (ev?.lot_id) keys.push(`lot:${ev.lot_id}`);
  const ticker = String(ev?.ticker || "").toUpperCase();
  const isInvestor = ev?.engine === "investor"
    || ev?.mode === "investor"
    || String(ev?.type || "").toUpperCase() === "INVESTOR_SIGNAL"
    || String(ev?.investor_alert_type || "").length > 0;
  if (isInvestor && ticker) {
    const tsMs = normalizeActivityTsMs(ev?.ts);
    keys.push(`inv:${ticker}:${investorActionClass(ev)}:${Math.floor(tsMs / 600000)}`);
  }
  keys.push(activityDedupeKey(ev));
  return keys;
}
