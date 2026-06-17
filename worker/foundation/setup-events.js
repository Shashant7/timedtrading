// worker/foundation/setup-events.js
// -----------------------------------------------------------------------------
// Phase 2 shadow abstraction: setup-event atoms.
//
// This module is pure and not imported by live trading/scoring paths. It gives
// indicator parity outputs, mock fixtures, and future D1 `setup_events` rows a
// single normalized shape before any sequence detector consumes them.
// -----------------------------------------------------------------------------

export const SETUP_EVENT_VERSION = 1;

export const EVENT_TYPES = Object.freeze([
  "td_setup_progress",
  "td9_complete",
  "td13_complete",
  "phase_entered_extreme",
  "phase_left_extreme",
  "phase_left_accumulation",
  "phase_left_distribution",
  "ema21_reclaim",
  "ema21_reject",
  "ema200_reclaim",
  "ema200_reject",
  "supertrend_flat_opposing",
  "supertrend_flip",
  "supertrend_breakthrough",
  "fvg_created",
  "fvg_filled",
  "fvg_reclaimed",
  "liquidity_swept",
  "liquidity_reclaimed",
  "orb_breakout",
  "orb_failed_breakout",
  "orb_reclaim",
  "rsi_extreme_entered",
  "rsi_extreme_left",
  "rsi_divergence_confirmed",
  "vwap_reclaim",
  "vwap_reject",
  "rvol_spike",
  "rvol_dead_zone_entered",
  "saty_day_gate_test",
  "saty_week_gate_test",
  "timing_extension_watch",
  "timing_compression_watch",
  "research_alignment_shift",
  "pdz_discount_entered",
  "pdz_equilibrium_reached",
  "pdz_premium_entered",
  "squeeze_release",
  "momentum_confirmation",
  "pullback_stabilized",
  "mean_reversion_target_reached",
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const VALID_DIRECTIONS = new Set(["LONG", "SHORT", "NEUTRAL"]);

function cleanToken(v) {
  return String(v || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeDirection(direction) {
  const d = cleanToken(direction);
  if (d === "BULL" || d === "BULLISH" || d === "UP") return "LONG";
  if (d === "BEAR" || d === "BEARISH" || d === "DOWN") return "SHORT";
  if (VALID_DIRECTIONS.has(d)) return d;
  return null;
}

export function normalizeEventType(eventType) {
  return String(eventType || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}

export function setupEventId({ ticker, tf, event_type, direction, event_ts }) {
  return [
    cleanToken(ticker),
    cleanToken(tf || "NA"),
    normalizeEventType(event_type),
    normalizeDirection(direction) || "NA",
    Number(event_ts) || 0,
  ].join(":");
}

export function createSetupEvent(input = {}) {
  const ticker = cleanToken(input.ticker);
  const tf = cleanToken(input.tf || "NA");
  const event_type = normalizeEventType(input.event_type || input.eventType);
  const direction = normalizeDirection(input.direction) || null;
  const event_ts = Number(input.event_ts ?? input.eventTs ?? input.ts);
  const price = Number(input.price);
  const confidence = Number(input.confidence);
  const source = String(input.source || "mock").trim();
  const payload = input.payload_json && typeof input.payload_json === "object"
    ? input.payload_json
    : input.payload && typeof input.payload === "object"
      ? input.payload
      : {};

  const event = {
    v: SETUP_EVENT_VERSION,
    event_id: input.event_id || setupEventId({ ticker, tf, event_type, direction, event_ts }),
    ticker,
    tf,
    event_ts,
    event_type,
    direction,
    price: Number.isFinite(price) ? price : null,
    source,
    confidence: Number.isFinite(confidence) ? confidence : null,
    payload,
  };
  return event;
}

export function validateSetupEvent(event) {
  const errors = [];
  if (!event || typeof event !== "object") return { ok: false, errors: ["event must be an object"] };
  if (Number(event.v) !== SETUP_EVENT_VERSION) errors.push(`v must be ${SETUP_EVENT_VERSION}`);
  if (!event.event_id) errors.push("event_id required");
  if (!event.ticker) errors.push("ticker required");
  if (!event.tf) errors.push("tf required");
  if (!Number.isFinite(Number(event.event_ts))) errors.push("event_ts required");
  if (!EVENT_TYPE_SET.has(event.event_type)) errors.push(`unknown event_type:${event.event_type}`);
  if (event.direction != null && !VALID_DIRECTIONS.has(event.direction)) errors.push(`invalid direction:${event.direction}`);
  if (!event.source) errors.push("source required");
  return { ok: errors.length === 0, errors };
}

export function normalizeSetupEvents(events = [], opts = {}) {
  const normalized = [];
  const errors = [];
  const seen = new Set();
  for (let i = 0; i < (Array.isArray(events) ? events.length : 0); i += 1) {
    const raw = events[i];
    const ev = raw?.v === SETUP_EVENT_VERSION ? raw : createSetupEvent(raw);
    const validation = validateSetupEvent(ev);
    if (!validation.ok) {
      errors.push({ index: i, event: ev, errors: validation.errors });
      if (!opts.keepInvalid) continue;
    }
    if (!opts.keepDuplicates && seen.has(ev.event_id)) continue;
    seen.add(ev.event_id);
    normalized.push(ev);
  }
  normalized.sort((a, b) => (Number(a.event_ts) || 0) - (Number(b.event_ts) || 0) || String(a.event_id).localeCompare(String(b.event_id)));
  return { ok: errors.length === 0, events: normalized, errors };
}

export function filterSetupEvents(events = [], query = {}) {
  const typeSet = query.eventTypes ? new Set(query.eventTypes.map(normalizeEventType)) : null;
  const direction = query.direction ? normalizeDirection(query.direction) : null;
  const ticker = query.ticker ? cleanToken(query.ticker) : null;
  const tfSet = query.tfs ? new Set(query.tfs.map(cleanToken)) : null;
  const fromTs = Number(query.fromTs);
  const toTs = Number(query.toTs);
  return events.filter((ev) => {
    if (ticker && ev.ticker !== ticker) return false;
    if (tfSet && !tfSet.has(ev.tf)) return false;
    if (direction && ev.direction !== direction) return false;
    if (typeSet && !typeSet.has(ev.event_type)) return false;
    if (Number.isFinite(fromTs) && ev.event_ts < fromTs) return false;
    if (Number.isFinite(toTs) && ev.event_ts > toTs) return false;
    return true;
  });
}

export function latestSetupEvent(events = [], query = {}) {
  const matches = filterSetupEvents(events, query);
  return matches.length ? matches[matches.length - 1] : null;
}

export function mockSetupEvent(input = {}) {
  return createSetupEvent({
    ticker: "MOCK",
    tf: "D",
    event_ts: 1,
    event_type: "td_setup_progress",
    direction: "LONG",
    source: "mock",
    ...input,
  });
}
