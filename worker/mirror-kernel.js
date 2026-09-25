// worker/mirror-kernel.js
//
// The entangled mirror kernel (docs/entangled-mirror-design.md).
//
// Five ideas, in the order they matter:
//   1. A model position is mirrored into every account as a SLEEVE — the
//      same position observed at that account's size.
//   2. After entry, the only thing that decides a broker quantity is
//      `sleeveTarget`: the sleeve's opened size times the model's remaining
//      fraction. Every leg, retry and reconciliation converges to it.
//   3. Sleeve quantities are DERIVED from order attempts, never stored. An
//      attempt records the broker's cumulative fill for one order, so every
//      write is "this order has filled N" and re-reading a fill cannot
//      double-count it.
//   4. Every order is recorded before it leaves, under a client_order_id the
//      kernel derives, so any broker order resolves to its model position.
//   5. A mismatch carries one reason from a closed set. Anything else is a
//      defect.
//
// Shared by the main worker (model positions and legs) and the bridge
// (sleeves and attempts). Both bind the same D1 database.

export const KERNEL_TABLES = [
  `CREATE TABLE IF NOT EXISTS model_position (
    position_id TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    signal_id TEXT,
    ticker TEXT,
    instrument_json TEXT,
    opened_qty REAL NOT NULL DEFAULT 0,
    remaining_qty REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    last_seq INTEGER NOT NULL DEFAULT -1,
    last_event TEXT,
    last_leg_ts INTEGER,
    verified_seq INTEGER NOT NULL DEFAULT -1,
    verified_at INTEGER,
    opened_at INTEGER,
    updated_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_model_position_unverified
    ON model_position (lane, verified_seq, last_seq, updated_at)`,
  `CREATE TABLE IF NOT EXISTS model_leg (
    position_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event TEXT NOT NULL,
    remaining_after REAL NOT NULL,
    paper_price REAL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (position_id, seq)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_model_leg_once
    ON model_leg (position_id, event, remaining_after)`,
  `CREATE TABLE IF NOT EXISTS mirror_sleeve (
    position_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    user_id TEXT,
    owner_id TEXT,
    is_owner INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'planned',
    divergence_reason TEXT,
    detail TEXT,
    verified_seq INTEGER NOT NULL DEFAULT -1,
    verified_at INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (position_id, account_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mirror_sleeve_account ON mirror_sleeve (account_id, status)`,
  `CREATE TABLE IF NOT EXISTS mirror_order_attempt (
    client_order_id TEXT PRIMARY KEY,
    position_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    user_id TEXT,
    seq INTEGER,
    attempt INTEGER,
    side TEXT NOT NULL,
    requested_qty REAL,
    filled_qty REAL NOT NULL DEFAULT 0,
    avg_price REAL,
    broker_order_id TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    source TEXT,
    placed_at INTEGER,
    updated_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attempt_position ON mirror_order_attempt (position_id, account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attempt_broker_order ON mirror_order_attempt (broker_order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attempt_status ON mirror_order_attempt (status, updated_at)`,
];

let _schemaReady = null;

/** Idempotent; runs once per isolate. Throws if D1 is unusable. */
export async function ensureMirrorKernelSchema(db) {
  if (!db?.prepare) throw new Error("no_d1");
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    for (const sql of KERNEL_TABLES) await db.prepare(sql).run();
    return true;
  })().catch((e) => { _schemaReady = null; throw e; });
  return _schemaReady;
}

/** Test hook: forget that the schema was ensured. */
export function _resetKernelSchemaForTest() { _schemaReady = null; }

// ── Identity ────────────────────────────────────────────────────────────

/**
 * One round of one day trade. The signal id is the contract and a re-entry
 * on the same contract reuses it; the book's `entry_ts` is stamped at BUY
 * and carried through trim and close, so the pair is unique per round and
 * derivable at every later event.
 */
export function dayTradePositionId(signalId, entryTs) {
  const sid = String(signalId || "").trim();
  const ts = Math.round(Number(entryTs));
  if (!sid || !(ts > 0)) return null;
  return `${sid}@${ts}`;
}

/**
 * A client_order_id derived from what the order is for, recorded before it
 * is sent. 30 characters: inside Webull's documented 32 and its observed
 * 40. A hash cannot collide on a shared prefix, which is how the IWM 278P
 * stop died (a composed id truncated onto another close's id).
 */
export async function kernelClientOrderId({ positionId, seq, accountId, attempt, nonce = null }) {
  const n = nonce ?? crypto.randomUUID();
  const raw = [positionId, seq ?? "", accountId, attempt ?? 1, n].join("|");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `tt${hex.slice(0, 28)}`;
}

// ── The mirror-image rule ───────────────────────────────────────────────

/**
 * Contracts this account should hold now.
 *
 * Never flat while the model is still in: a sleeve too small to divide keeps
 * its lot (`indivisible_lot`), exactly as the model's own one-lot book does
 * at 1R. Pure.
 */
export function sleeveTarget(model, sleeve) {
  const opened = Math.round(Number(sleeve?.opened_qty) || 0);
  if (!(opened > 0)) return 0;
  const mOpened = Number(model?.opened_qty) || 0;
  const mRemaining = Number(model?.remaining_qty) || 0;
  if (!(mRemaining > 0) || !(mOpened > 0)) return 0;
  const raw = opened * (mRemaining / mOpened);
  return Math.min(opened, Math.max(1, Math.round(raw)));
}

/** True when `sleeveTarget` had to keep a lot the model's fraction would sell. */
export function isIndivisibleLot(model, sleeve) {
  const opened = Math.round(Number(sleeve?.opened_qty) || 0);
  const mOpened = Number(model?.opened_qty) || 0;
  const mRemaining = Number(model?.remaining_qty) || 0;
  if (!(opened > 0) || !(mRemaining > 0) || !(mOpened > 0)) return false;
  return Math.round(opened * (mRemaining / mOpened)) < 1;
}

// ── The closed set of divergence reasons ────────────────────────────────

export const DIVERGENCE = Object.freeze({
  INSUFFICIENT_BUYING_POWER: "insufficient_buying_power",
  DAILY_LOSS_BUDGET: "daily_loss_budget",
  VEHICLE_DAILY_CAP: "vehicle_daily_cap",
  PER_ORDER_CAP: "per_order_cap",
  MAX_LOSS_CAP: "max_loss_cap",
  ACCOUNT_TOO_SMALL: "account_too_small",
  LANE_DISABLED: "lane_disabled",
  UNFILLED_AT_LIMIT: "unfilled_at_limit",
  INDIVISIBLE_LOT: "indivisible_lot",
  EXTERNAL_REDUCTION: "external_reduction",
});

const OPEN_REASONS = [
  [/daily_loss_budget/i, DIVERGENCE.DAILY_LOSS_BUDGET],
  [/vehicle_daily_cap|daily_cap_\d+_reached/i, DIVERGENCE.VEHICLE_DAILY_CAP],
  [/max_per_order|per_order|notional_.*exceeds/i, DIVERGENCE.PER_ORDER_CAP],
  [/max_loss|daily_loss_limit/i, DIVERGENCE.MAX_LOSS_CAP],
  [/insufficient|buying_power|\bbp_|cash_for_one/i, DIVERGENCE.INSUFFICIENT_BUYING_POWER],
  [/account_too_small/i, DIVERGENCE.ACCOUNT_TOO_SMALL],
  [/options_not_enabled|user_disabled|lane_disabled|vehicle_.*disabled|kill_switch/i, DIVERGENCE.LANE_DISABLED],
  [/cancel|expired|unfilled/i, DIVERGENCE.UNFILLED_AT_LIMIT],
];

/**
 * Map a raw refusal onto the closed set, or null when it is a defect.
 *
 * An entry may diverge for funds, a cap, the account's own settings, or a
 * limit that never filled. A reduce may diverge only because the holder
 * already sold (`no_held_position` — the SELL guard's clean-read verdict).
 * `positions_unavailable`, a collision, an unmapped broker reject: defects.
 */
export function canonicalDivergence(rawReason, side) {
  const text = String(rawReason || "").trim();
  if (!text) return null;
  if (String(side || "").toLowerCase() === "sell") {
    return /(^|[^a-z_])no_held_position([^a-z_]|$)/i.test(text) ? DIVERGENCE.EXTERNAL_REDUCTION : null;
  }
  for (const [re, reason] of OPEN_REASONS) if (re.test(text)) return reason;
  return null;
}

// ── Main worker: model positions and legs ───────────────────────────────

const LEG_EVENTS = new Set(["BUY", "TRIM", "EXIT", "STOP"]);

/**
 * Record one model action. Durable before any order goes out: the model's
 * intent must exist even if the isolate dies mid-dispatch.
 *
 * Returns { position_id, seq } or null when there is nothing to record.
 */
export async function recordModelLeg(db, {
  lane = "index_dt",
  signalId,
  entryTs,
  ticker,
  instrument = null,
  event,
  openedQty,
  remainingAfter,
  paperPrice = null,
  now = Date.now(),
} = {}) {
  const ev = String(event || "").toUpperCase();
  if (!LEG_EVENTS.has(ev)) return null;
  const positionId = dayTradePositionId(signalId, entryTs);
  if (!positionId) return null;
  await ensureMirrorKernelSchema(db);
  const opened = Number(openedQty) || 0;
  const remaining = ev === "EXIT" || ev === "STOP" ? 0 : Math.max(0, Number(remainingAfter) || 0);

  await db.prepare(
    `INSERT INTO model_position (position_id, lane, signal_id, ticker, instrument_json,
       opened_qty, remaining_qty, status, opened_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 'open', ?7, ?7)
     ON CONFLICT(position_id) DO NOTHING`,
  ).bind(positionId, lane, signalId, String(ticker || "").toUpperCase() || null,
    instrument ? JSON.stringify(instrument) : null, opened, Number(entryTs) || now).run();

  const existing = await db.prepare(
    `SELECT seq FROM model_leg WHERE position_id = ?1 AND event = ?2 AND remaining_after = ?3`,
  ).bind(positionId, ev, remaining).first();
  if (existing) return { position_id: positionId, seq: Number(existing.seq), duplicate: true };

  const row = await db.prepare(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM model_leg WHERE position_id = ?1`,
  ).bind(positionId).first();
  const seq = Number(row?.next) || 0;
  const status = remaining > 0 ? (ev === "TRIM" ? "trimmed" : "open") : "closed";
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO model_leg (position_id, seq, event, remaining_after, paper_price, ts)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(positionId, seq, ev, remaining, Number(paperPrice) || null, now),
    db.prepare(
      `UPDATE model_position
         SET remaining_qty = ?2, status = ?3, last_seq = MAX(last_seq, ?4),
             last_event = ?5, last_leg_ts = ?6, updated_at = ?6,
             opened_qty = CASE WHEN opened_qty > 0 THEN opened_qty ELSE ?7 END
       WHERE position_id = ?1`,
    ).bind(positionId, remaining, status, seq, ev, now, opened),
  ]);
  return { position_id: positionId, seq };
}

/**
 * Model positions with a reduce the accounts have not all been confirmed at.
 * Oldest first, and not before `settleMs` has passed since the leg — the
 * event path gets the first attempt.
 */
export async function listUnverifiedPositions(db, {
  lane = "index_dt",
  now = Date.now(),
  settleMs = 60_000,
  lookbackMs = 36 * 3600 * 1000,
  limit = 20,
} = {}) {
  await ensureMirrorKernelSchema(db);
  const res = await db.prepare(
    `SELECT * FROM model_position
      WHERE lane = ?1 AND verified_seq < last_seq
        AND last_event IN ('TRIM', 'EXIT', 'STOP')
        AND last_leg_ts <= ?2 AND updated_at >= ?3
      ORDER BY last_leg_ts ASC LIMIT ?4`,
  ).bind(lane, now - settleMs, now - lookbackMs, limit).all();
  return res?.results || [];
}

export async function markPositionVerified(db, positionId, seq, now = Date.now()) {
  await db.prepare(
    `UPDATE model_position SET verified_seq = MAX(verified_seq, ?2), verified_at = ?3
      WHERE position_id = ?1`,
  ).bind(positionId, seq, now).run();
}

// ── Bridge: sleeves and attempts ────────────────────────────────────────

/**
 * Every account's sleeve for a position, with quantities derived from its
 * attempts. `external` rows are the holder's own sales, recorded when a
 * clean holdings read shows less than the sleeve.
 */
export async function loadSleeves(db, positionId) {
  await ensureMirrorKernelSchema(db);
  const res = await db.prepare(
    `SELECT s.position_id, s.account_id, s.user_id, s.owner_id, s.is_owner, s.status,
            s.divergence_reason, s.detail, s.verified_seq, s.verified_at,
            COALESCE(SUM(CASE WHEN a.side = 'buy' THEN a.filled_qty END), 0) AS opened_qty,
            COALESCE(SUM(CASE WHEN a.side = 'buy' THEN a.filled_qty
                              WHEN a.side IN ('sell', 'external') THEN -a.filled_qty END), 0) AS remaining_qty,
            SUM(CASE WHEN a.side = 'buy' THEN a.filled_qty * a.avg_price END)
              / NULLIF(SUM(CASE WHEN a.side = 'buy' AND a.avg_price > 0 THEN a.filled_qty END), 0) AS entry_avg,
            SUM(CASE WHEN a.status IN ('sending', 'working') THEN 1 ELSE 0 END) AS in_flight
       FROM mirror_sleeve s
       LEFT JOIN mirror_order_attempt a
         ON a.position_id = s.position_id AND a.account_id = s.account_id
      WHERE s.position_id = ?1
      GROUP BY s.position_id, s.account_id`,
  ).bind(positionId).all();
  return (res?.results || []).map((r) => ({
    ...r,
    opened_qty: Number(r.opened_qty) || 0,
    remaining_qty: Math.max(0, Number(r.remaining_qty) || 0),
    in_flight: Number(r.in_flight) || 0,
    is_owner: Number(r.is_owner) === 1,
  }));
}

export async function ensureSleeve(db, { positionId, accountId, userId = null, ownerId = null, isOwner = false, now = Date.now() }) {
  await ensureMirrorKernelSchema(db);
  await db.prepare(
    `INSERT INTO mirror_sleeve (position_id, account_id, user_id, owner_id, is_owner, status, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'planned', ?6)
     ON CONFLICT(position_id, account_id) DO UPDATE SET
       user_id = COALESCE(mirror_sleeve.user_id, excluded.user_id),
       owner_id = COALESCE(mirror_sleeve.owner_id, excluded.owner_id),
       is_owner = MAX(mirror_sleeve.is_owner, excluded.is_owner)`,
  ).bind(positionId, accountId, userId, ownerId, isOwner ? 1 : 0, now).run();
}

export async function setSleeveStatus(db, { positionId, accountId, status, reason = null, detail = null, verifiedSeq = null, now = Date.now() }) {
  await db.prepare(
    `UPDATE mirror_sleeve
        SET status = ?3, divergence_reason = ?4, detail = ?5, updated_at = ?6,
            verified_seq = CASE WHEN ?7 IS NULL THEN verified_seq ELSE MAX(verified_seq, ?7) END,
            verified_at = CASE WHEN ?7 IS NULL THEN verified_at ELSE ?6 END
      WHERE position_id = ?1 AND account_id = ?2`,
  ).bind(positionId, accountId, status, reason, detail ? String(detail).slice(0, 300) : null, now, verifiedSeq).run();
}

/** Next attempt number for one sleeve leg. */
export async function nextAttemptNumber(db, { positionId, accountId, seq }) {
  await ensureMirrorKernelSchema(db);
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM mirror_order_attempt
      WHERE position_id = ?1 AND account_id = ?2 AND COALESCE(seq, -1) = COALESCE(?3, -1)`,
  ).bind(positionId, accountId, seq ?? null).first();
  return (Number(row?.n) || 0) + 1;
}

/**
 * Write one attempt at its current state. Idempotent: `filled_qty` is the
 * broker's CUMULATIVE fill for this order, so writing it again is harmless.
 */
export async function upsertAttempt(db, {
  clientOrderId, positionId, accountId, userId = null, seq = null, attempt = null,
  side, requestedQty = null, filledQty = 0, avgPrice = null, brokerOrderId = null,
  status, reason = null, source = null, now = Date.now(),
}) {
  await ensureMirrorKernelSchema(db);
  await db.prepare(
    `INSERT INTO mirror_order_attempt (client_order_id, position_id, account_id, user_id, seq, attempt,
       side, requested_qty, filled_qty, avg_price, broker_order_id, status, reason, source, placed_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
     ON CONFLICT(client_order_id) DO UPDATE SET
       filled_qty = MAX(mirror_order_attempt.filled_qty, excluded.filled_qty),
       avg_price = COALESCE(excluded.avg_price, mirror_order_attempt.avg_price),
       broker_order_id = COALESCE(excluded.broker_order_id, mirror_order_attempt.broker_order_id),
       status = excluded.status,
       reason = COALESCE(excluded.reason, mirror_order_attempt.reason),
       updated_at = excluded.updated_at`,
  ).bind(clientOrderId, positionId, accountId, userId, seq, attempt, side,
    requestedQty, Number(filledQty) || 0, Number(avgPrice) > 0 ? Number(avgPrice) : null,
    brokerOrderId, status, reason ? String(reason).slice(0, 200) : null, source, now).run();
}

export async function listInFlightAttempts(db, { positionId, accountId }) {
  await ensureMirrorKernelSchema(db);
  const res = await db.prepare(
    `SELECT * FROM mirror_order_attempt
      WHERE position_id = ?1 AND account_id = ?2 AND status IN ('sending', 'working')`,
  ).bind(positionId, accountId).all();
  return res?.results || [];
}

export async function findAttemptByBrokerOrder(db, brokerOrderId) {
  if (!brokerOrderId) return null;
  await ensureMirrorKernelSchema(db);
  return db.prepare(
    `SELECT * FROM mirror_order_attempt WHERE broker_order_id = ?1 OR client_order_id = ?1 LIMIT 1`,
  ).bind(String(brokerOrderId)).first();
}

/** Attempt status from a normalized broker fill. */
export function attemptStatusFromFill(fill, { placed = true } = {}) {
  if (!placed) return "rejected";
  const s = String(fill?.status || "").toLowerCase();
  if (s === "filled" || fill?.mock || fill?.assumed) return "filled";
  if (s === "partial" || s === "partially_filled") return "working";
  if (s === "rejected" || s === "cancelled" || s === "canceled" || s === "expired") return "dead";
  return "working";
}

// ── Converge: one sleeve, one decision ──────────────────────────────────

/**
 * What to do with one sleeve. Pure.
 *
 * `held` is the account's live holding of the contract from a CLEAN read;
 * null means the read failed and nothing may be concluded.
 *
 * Returns one of:
 *   { action: "wait",     reason }            an order is still in flight
 *   { action: "unknown",  reason }            holdings unreadable (defect if it lasts)
 *   { action: "reanchor", external_qty }      holder sold on their own
 *   { action: "sell",     qty, target }       reduce toward target
 *   { action: "verified", target }            at target on a clean read
 */
export function planSleeveConverge({ model, sleeve, held }) {
  if (sleeve?.in_flight > 0) return { action: "wait", reason: "order_in_flight" };
  if (held == null || !Number.isFinite(Number(held))) return { action: "unknown", reason: "holdings_unreadable" };
  const h = Math.max(0, Math.round(Number(held)));
  const remaining = Math.max(0, Math.round(Number(sleeve?.remaining_qty) || 0));
  const target = sleeveTarget(model, sleeve);
  if (h < remaining) return { action: "reanchor", external_qty: remaining - h, target };
  const current = Math.min(remaining, h);
  if (current > target) return { action: "sell", qty: current - target, target };
  return {
    action: "verified",
    target,
    ...(isIndivisibleLot(model, sleeve) ? { divergence: DIVERGENCE.INDIVISIBLE_LOT } : {}),
  };
}
