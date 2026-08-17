// worker/review/trade-review-schema.js
//
// Trade Review Agent — D1 schema.
//
// Three tables:
//   trade_reviews           one row per LEG (entry / each trim / exit)
//   trade_review_proposals  engine-work one-pagers destined for GitHub
//   exec_memos              approved lessons routed to the CIO/CRO/COO desks
//
// Idempotent CREATE + ALTER, same contract as d1Ensure*Schema in index.js:
// safe to call on every request, cheap after the first call per isolate.

let _ready = false;

const CREATE_REVIEWS = `CREATE TABLE IF NOT EXISTS trade_reviews (
  review_id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL,
  ticker TEXT,
  direction TEXT,
  leg_kind TEXT NOT NULL,
  leg_seq INTEGER NOT NULL DEFAULT 0,
  leg_event_id TEXT,
  leg_ts INTEGER,
  leg_price REAL,
  leg_qty_pct REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  grade TEXT,
  verdict TEXT,
  success_prob REAL,
  headline TEXT,
  capture_json TEXT,
  context_json TEXT,
  analysis_json TEXT,
  model TEXT,
  prompt_version TEXT,
  latency_ms INTEGER,
  error TEXT,
  operator_note TEXT,
  operator_patch_json TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  applied_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const CREATE_PROPOSALS = `CREATE TABLE IF NOT EXISTS trade_review_proposals (
  proposal_id TEXT PRIMARY KEY,
  review_id TEXT,
  trade_id TEXT,
  ticker TEXT,
  kind TEXT NOT NULL DEFAULT 'engine',
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  github_issue_number INTEGER,
  github_url TEXT,
  github_error TEXT,
  agent_dispatched_at INTEGER,
  agent_dispatch_ref TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const CREATE_MEMOS = `CREATE TABLE IF NOT EXISTS exec_memos (
  memo_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  audience TEXT NOT NULL,
  ticker TEXT,
  headline TEXT NOT NULL,
  body_md TEXT,
  evidence_json TEXT,
  weight REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  expires_at INTEGER
)`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_trade_reviews_trade ON trade_reviews(trade_id, leg_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_trade_reviews_status ON trade_reviews(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_trade_reviews_leg_ts ON trade_reviews(leg_ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_trade_review_proposals_status ON trade_review_proposals(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_exec_memos_audience ON exec_memos(status, created_at DESC)`,
];

export async function ensureTradeReviewSchema(env) {
  if (_ready || !env?.DB) return;
  try {
    await env.DB.batch([
      env.DB.prepare(CREATE_REVIEWS),
      env.DB.prepare(CREATE_PROPOSALS),
      env.DB.prepare(CREATE_MEMOS),
      ...INDEXES.map((sql) => env.DB.prepare(sql)),
    ]);
    _ready = true;
  } catch (e) {
    console.warn("[TRADE_REVIEW] schema ensure failed:", String(e?.message || e).slice(0, 160));
  }
}

/** Test seam — lets unit tests re-run the ensure against a fresh mock. */
export function _resetTradeReviewSchemaCache() {
  _ready = false;
}

export const TRADE_REVIEW_TABLES = {
  reviews: "trade_reviews",
  proposals: "trade_review_proposals",
  memos: "exec_memos",
};
