// worker-bridge/bridge-account-ledger.js
//
// 2026-07-20 — Per-broker-account ledger.
//
// The main worker keeps ONE model book (simulated account per mode). But the
// operator runs multiple REAL accounts (today: 5 Webull + 1 IBKR). This module
// gives every real account its own ledger + position/cash snapshot so the
// broker mirror is tracked per account, not collapsed into a single blob.
//
//   broker_account_ledger    — one row per real fill/close per account
//   broker_account_snapshot  — latest positions + cash per account (sync truth)
//
// All writes are best-effort: a ledger failure must never block an order.

let _schemaReady = false;

export async function ensureAccountLedgerSchema(env) {
  const db = env?.BRIDGE_DB;
  if (!db || _schemaReady) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS broker_account_ledger (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                INTEGER NOT NULL,
        owner_id          TEXT,
        user_id           TEXT,
        broker            TEXT,
        broker_account_id TEXT NOT NULL,
        model_trade_id    TEXT,
        client_order_id   TEXT,
        broker_order_id   TEXT,
        ticker            TEXT,
        side              TEXT,
        event_type        TEXT,
        order_type        TEXT,
        protection_mode   TEXT,
        qty               REAL,
        price             REAL,
        value             REAL,
        status            TEXT,
        reject_reason     TEXT,
        meta_json         TEXT
      )
    `).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_bal_account_ts ON broker_account_ledger(broker_account_id, ts DESC)`,
    ).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_bal_owner_ts ON broker_account_ledger(owner_id, ts DESC)`,
    ).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_bal_trade ON broker_account_ledger(model_trade_id)`,
    ).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS broker_account_snapshot (
        broker_account_id TEXT PRIMARY KEY,
        owner_id          TEXT,
        user_id           TEXT,
        broker            TEXT,
        account_label     TEXT,
        cash_usd          REAL,
        equity_usd        REAL,
        buying_power_usd  REAL,
        positions_json    TEXT,
        positions_count   INTEGER,
        in_sync           INTEGER,
        drift_count       INTEGER,
        drift_json        TEXT,
        synced_at         INTEGER
      )
    `).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_bas_owner ON broker_account_snapshot(owner_id)`,
    ).run();
    _schemaReady = true;
  } catch (e) {
    console.warn("[ACCT_LEDGER] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

/**
 * Record a real broker fill/close/reject against a specific account.
 * `row` fields mirror the columns above; `meta` is JSON-serialized.
 */
export async function recordAccountFill(env, row = {}) {
  const db = env?.BRIDGE_DB;
  if (!db) return { ok: false, skip: "no_db" };
  if (!row.broker_account_id) return { ok: false, skip: "no_account_id" };
  await ensureAccountLedgerSchema(env);
  try {
    const qty = Number(row.qty) || 0;
    const price = Number(row.price) || 0;
    const value = row.value != null ? Number(row.value) : (qty > 0 && price > 0 ? qty * price : 0);
    const res = await db.prepare(`
      INSERT INTO broker_account_ledger
        (ts, owner_id, user_id, broker, broker_account_id, model_trade_id,
         client_order_id, broker_order_id, ticker, side, event_type, order_type,
         protection_mode, qty, price, value, status, reject_reason, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      Number(row.ts) || Date.now(),
      row.owner_id || null,
      row.user_id || null,
      row.broker || null,
      String(row.broker_account_id),
      row.model_trade_id || null,
      row.client_order_id || null,
      row.broker_order_id || null,
      row.ticker || null,
      row.side || null,
      row.event_type || null,
      row.order_type || null,
      row.protection_mode || null,
      qty,
      price,
      value,
      row.status || "ok",
      row.reject_reason || null,
      row.meta ? JSON.stringify(row.meta).slice(0, 4000) : null,
    ).run();
    return { ok: true, id: res?.meta?.last_row_id ?? null };
  } catch (e) {
    console.warn("[ACCT_LEDGER] record failed:", String(e?.message || e).slice(0, 200));
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** Read the ledger for one account or one owner (newest first). */
export async function readAccountLedger(env, { broker_account_id = null, owner_id = null, limit = 100 } = {}) {
  const db = env?.BRIDGE_DB;
  if (!db) return [];
  await ensureAccountLedgerSchema(env);
  try {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    let sql = `SELECT * FROM broker_account_ledger`;
    const binds = [];
    if (broker_account_id) { sql += ` WHERE broker_account_id = ?`; binds.push(String(broker_account_id)); }
    else if (owner_id) { sql += ` WHERE owner_id = ?`; binds.push(String(owner_id)); }
    sql += ` ORDER BY ts DESC LIMIT ?`;
    binds.push(lim);
    const res = await db.prepare(sql).bind(...binds).all();
    return res?.results || [];
  } catch (e) {
    console.warn("[ACCT_LEDGER] read failed:", String(e?.message || e).slice(0, 200));
    return [];
  }
}

/**
 * Upsert the latest positions + cash snapshot for an account. Called by the
 * reconciler so the system always has broker truth per account.
 */
export async function snapshotAccount(env, snap = {}) {
  const db = env?.BRIDGE_DB;
  if (!db || !snap.broker_account_id) return { ok: false, skip: "no_db_or_account" };
  await ensureAccountLedgerSchema(env);
  try {
    const positions = Array.isArray(snap.positions) ? snap.positions : [];
    const drift = Array.isArray(snap.drift) ? snap.drift : [];
    await db.prepare(`
      INSERT INTO broker_account_snapshot
        (broker_account_id, owner_id, user_id, broker, account_label,
         cash_usd, equity_usd, buying_power_usd, positions_json, positions_count,
         in_sync, drift_count, drift_json, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(broker_account_id) DO UPDATE SET
        owner_id=excluded.owner_id, user_id=excluded.user_id, broker=excluded.broker,
        account_label=excluded.account_label, cash_usd=excluded.cash_usd,
        equity_usd=excluded.equity_usd, buying_power_usd=excluded.buying_power_usd,
        positions_json=excluded.positions_json, positions_count=excluded.positions_count,
        in_sync=excluded.in_sync, drift_count=excluded.drift_count,
        drift_json=excluded.drift_json, synced_at=excluded.synced_at
    `).bind(
      String(snap.broker_account_id),
      snap.owner_id || null,
      snap.user_id || null,
      snap.broker || null,
      snap.account_label || null,
      snap.cash_usd != null ? Number(snap.cash_usd) : null,
      snap.equity_usd != null ? Number(snap.equity_usd) : null,
      snap.buying_power_usd != null ? Number(snap.buying_power_usd) : null,
      JSON.stringify(positions).slice(0, 12000),
      positions.length,
      snap.in_sync ? 1 : 0,
      drift.length,
      drift.length ? JSON.stringify(drift).slice(0, 8000) : null,
      Number(snap.synced_at) || Date.now(),
    ).run();
    return { ok: true };
  } catch (e) {
    console.warn("[ACCT_LEDGER] snapshot failed:", String(e?.message || e).slice(0, 200));
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** Read per-account snapshots for an owner (the sync dashboard view). */
export async function readAccountSnapshots(env, { owner_id = null } = {}) {
  const db = env?.BRIDGE_DB;
  if (!db) return [];
  await ensureAccountLedgerSchema(env);
  try {
    let sql = `SELECT * FROM broker_account_snapshot`;
    const binds = [];
    if (owner_id) { sql += ` WHERE owner_id = ?`; binds.push(String(owner_id)); }
    sql += ` ORDER BY synced_at DESC`;
    const res = await db.prepare(sql).bind(...binds).all();
    return (res?.results || []).map((r) => ({
      ...r,
      positions: safeParse(r.positions_json, []),
      drift: safeParse(r.drift_json, []),
    }));
  } catch (e) {
    console.warn("[ACCT_LEDGER] read snapshots failed:", String(e?.message || e).slice(0, 200));
    return [];
  }
}

function safeParse(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch (_) { return fallback; }
}
