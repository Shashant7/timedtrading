// Decision provenance — version-pinned record of every trade decision.
// -----------------------------------------------------------------------------
// The keystone of the self-calibrating loop: each ENTRY/TRIM/DEFEND/EXIT/
// SL_TIGHTEN is captured with the exact scoring version, engine build, and a
// hash of the active config that produced it. That lets us answer "why did the
// engine do X to ticker Y at time Z?" AND "did our change help?" without the
// confound of "the calc was different then." Pure helpers here; D1 read/write
// wiring lives in index.js (same pattern as feed/sl-hard-exit.js).
// -----------------------------------------------------------------------------

export const DECISION_RECORD_SCHEMA_VERSION = 1;

/** Canonical, key-sorted JSON so identical config always hashes identically. */
export function canonicalJson(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

/**
 * Load the active deep-audit config subset from D1 and fingerprint it.
 * Mirrors the scoring-cron loader: read all model_config rows, filter in JS
 * (REPLAY_DA_KEYS exceeds D1 bind-param cap). Returns the same hash whether
 * the caller is the five-minute cron or the processTradeSimulation lazy loader.
 */
/** Dynamic demotion markers are written by the edge-scorecard learning bus
 *  (`deep_audit_setup_demotion_<Display>_<dir>=blocked`) and are NOT listed in
 *  REPLAY_DA_KEYS (bind-param cap). Without this prefix pass-through they sit
 *  inert in model_config while checkSetupDemotion always sees undefined. */
const DYNAMIC_DA_PREFIXES = [
  "deep_audit_setup_demotion_",
];

function isAllowedDaKey(key, allowed) {
  if (!key) return false;
  if (allowed.has(key)) return true;
  return DYNAMIC_DA_PREFIXES.some((p) => key.startsWith(p));
}

export async function loadDeepAuditConfigFromDb(db, allowedKeys) {
  const cfg = {};
  if (!db) return { config: cfg, configHash: "" };
  const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys || []);
  if (allowed.size === 0) return { config: cfg, configHash: "" };
  try {
    const rows = (await db.prepare(`SELECT config_key, config_value FROM model_config`).all())?.results || [];
    for (const r of rows) {
      if (!r?.config_key || !isAllowedDaKey(r.config_key, allowed)) continue;
      try {
        cfg[r.config_key] = JSON.parse(r.config_value);
      } catch {
        cfg[r.config_key] = r.config_value;
      }
    }
  } catch (_) {}
  let configHash = "";
  try {
    configHash = computeConfigHash(cfg);
  } catch (_) {}
  return { config: cfg, configHash };
}

/** FNV-1a 32-bit -> 8-hex. A fast, deterministic config fingerprint. */
export function computeConfigHash(cfg) {
  if (!cfg || (typeof cfg === "object" && Object.keys(cfg).length === 0)) return "";
  const str = typeof cfg === "string" ? cfg : canonicalJson(cfg);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const MAX_JSON = 16000; // cap snapshot blobs so a decision row stays small

function toJsonField(v) {
  if (v == null) return null;
  let s;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return null;
  }
  if (s.length > MAX_JSON) s = s.slice(0, MAX_JSON);
  return s;
}

/** Ticker fallback: trade ids are shaped `TICKER-<entryTs>-<rand>`. */
function tickerFromTradeId(tradeId) {
  const s = String(tradeId || "");
  const i = s.indexOf("-");
  return i > 0 ? s.slice(0, i).toUpperCase() : null;
}

/**
 * Build a normalized decision_record row. Returns null if the event is
 * unusable (missing type or timestamp) so the caller can skip the write.
 */
export function buildDecisionRecord(opts = {}) {
  const eventType = String(opts.eventType || opts.event_type || "").toUpperCase();
  const ts = Number(opts.ts);
  if (!eventType || !Number.isFinite(ts) || ts <= 0) return null;

  const tradeId = opts.tradeId ?? opts.trade_id ?? null;
  const ticker = String(opts.ticker || tickerFromTradeId(tradeId) || "").toUpperCase() || null;
  const engine = String(opts.engine || "trader").toLowerCase() === "investor" ? "investor" : "trader";
  const decisionId = `${tradeId || ticker || "?"}:${eventType}:${ts}`;

  return {
    decision_id: decisionId,
    engine,
    trade_id: tradeId != null ? String(tradeId) : null,
    ticker,
    event_type: eventType,
    ts,
    reason: opts.reason != null ? String(opts.reason).slice(0, 240) : null,
    scoring_version: opts.scoringVersion != null ? String(opts.scoringVersion) : null,
    engine_git_sha: opts.engineGitSha != null ? String(opts.engineGitSha) : null,
    config_hash: opts.configHash != null ? String(opts.configHash) : null,
    schema_version: DECISION_RECORD_SCHEMA_VERSION,
    conviction_tier: opts.convictionTier != null ? String(opts.convictionTier) : null,
    inputs_json: toJsonField(opts.inputs),
    gate_trace_json: toJsonField(opts.gateTrace),
    created_at: Number(opts.createdAt) || Date.now(),
  };
}

/** Self-healing schema — CREATE TABLE + indexes (idempotent). */
export const DECISION_RECORDS_DDL = [
  `CREATE TABLE IF NOT EXISTS decision_records (
    decision_id TEXT PRIMARY KEY,
    engine TEXT NOT NULL DEFAULT 'trader',
    trade_id TEXT,
    ticker TEXT,
    event_type TEXT NOT NULL,
    ts INTEGER NOT NULL,
    reason TEXT,
    scoring_version TEXT,
    engine_git_sha TEXT,
    config_hash TEXT,
    schema_version INTEGER NOT NULL DEFAULT 1,
    conviction_tier TEXT,
    inputs_json TEXT,
    gate_trace_json TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_decision_records_trade ON decision_records (trade_id)`,
  `CREATE INDEX IF NOT EXISTS idx_decision_records_ticker_ts ON decision_records (ticker, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_decision_records_engine_ts ON decision_records (engine, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_decision_records_config ON decision_records (config_hash)`,
];

/** Column order for INSERT binding (must match index.js writer). */
export const DECISION_RECORD_COLUMNS = [
  "decision_id", "engine", "trade_id", "ticker", "event_type", "ts", "reason",
  "scoring_version", "engine_git_sha", "config_hash", "schema_version",
  "conviction_tier", "inputs_json", "gate_trace_json", "created_at",
];
