// worker-bridge/bridge-notifications.js
//
// 2026-06-01 — Phase E of the trade-aware mirror sync. Per
// tasks/2026-06-01-trade-aware-mirror-sync-design.md §7.
//
// Severity tier routing for drift events:
//
//   info     → bundled into the Daily Owner Email digest (no immediate dispatch)
//   warn     → immediate email to user + in-app banner; dedup'd 1×/day/trade
//   critical → immediate email + operator Discord (also dedup'd 1×/day/trade)
//
// Called from the reconciler (`bridge-reconciler.js`) whenever a drift
// classification is persisted with severity ≥ warn. Dedup state lives
// on the manifest row (`last_user_notified_at`, `notification_severity`)
// so we don't spam the user with "still partial fill" emails every
// 5 minutes. Critical used to bypass dedup and re-queued on every
// */5 reconcile → Mirror Sync digests every 5 minutes (2026-07-31).
//
// Operator Discord webhook is best-effort: the env var
// BROKER_OPERATOR_DISCORD_WEBHOOK_URL is checked, and a failure to
// post never blocks the reconcile cycle.
//
// 2026-07-31 — Drift emails:
//   - Never notify on in_sync / "consistent" (false WARN noise).
//   - Queue structured `event` fields so the main-worker drain can
//     coalesce many tickers into ONE Mirror Sync digest email.

import { listConnectedUsers, readUser } from "./bridge-storage.js";
// Pure, no-binding calendar module shared with the main worker. Imported
// rather than copied: the holiday tables already exist in three places with a
// CI parity test (tests/calendar-parity.test.js) guarding them, and a fourth
// copy in the bridge is exactly the drift that test was written to catch.
import { isTradingDay, etDateStr } from "../worker/foundation/trading-calendar.js";

/**
 * 2026-08-11 — Partner notification routing. Accounts belonging to a
 * partner's broker login carry `notify_emails` on their bridge user row
 * (stamped at Webull connect time via partner_email). Actions on those
 * accounts notify every address in the list PLUS the admin
 * (BRIDGE_ADMIN_NOTIFY_EMAIL). Returns null when the row has no
 * notify_emails — callers keep the legacy single-recipient behavior so
 * the operator's own accounts are unaffected.
 */
export function resolveNotifyRecipients(env, userRow) {
  const extras = (Array.isArray(userRow?.notify_emails) ? userRow.notify_emails : [])
    .map((e) => String(e || "").trim().toLowerCase())
    .filter((e) => e.includes("@"));
  const set = new Set(extras);
  // Rows connected before partner_email was stamped (and the operator's own
  // rows) carry no notify_emails. Fall back to the row's owner so the queue
  // item always addresses a real inbox — grouping on a bare user_id like
  // `op@x.com#webull#roth-ira` is not a deliverable address.
  if (!set.size) {
    const owner = ownerEmailForRow(userRow);
    if (owner) set.add(owner);
  }
  if (!set.size) return null;
  const admin = String(env?.BRIDGE_ADMIN_NOTIFY_EMAIL || "").trim().toLowerCase();
  if (admin) set.add(admin);
  return [...set];
}

/**
 * The human inbox that owns a bridge account row. Webull sub-rows carry
 * `owner_email` (not `email`), and their user_id is `{owner}#webull#{slug}`.
 */
export function ownerEmailForRow(userRow) {
  const direct = String(userRow?.email || userRow?.owner_email || "").trim().toLowerCase();
  if (direct.includes("@")) return direct;
  const base = String(userRow?.user_id || "").split("#")[0].trim().toLowerCase();
  return base.includes("@") ? base : null;
}

/** True when this row belongs to the operator/admin rather than a partner. */
export function isAdminOwnedRow(env, userRow) {
  const admin = String(env?.BRIDGE_ADMIN_NOTIFY_EMAIL || "").trim().toLowerCase();
  if (!admin) return true; // no admin configured — preserve legacy content
  const owner = ownerEmailForRow(userRow);
  return !!owner && owner === admin;
}

const DEDUP_WINDOW_MS = {
  info: 24 * 60 * 60 * 1000,   // daily digest cadence
  warn: 24 * 60 * 60 * 1000,   // one warn per trade per day
  critical: 24 * 60 * 60 * 1000, // one critical per trade per day (chronic orphans)
};

/** Sync states that are healthy / informational — never email immediately. */
const NO_EMAIL_SYNC_STATES = new Set(["in_sync", "pending", ""]);

/**
 * Decide whether a fresh drift event should dispatch a notification or
 * be swallowed by the dedup window. Reads manifest row's
 * `last_user_notified_at` + `notification_severity`.
 *
 * Returns { dispatch: bool, reason }.
 */
export function shouldDispatchDriftNotification(row, severity) {
  const sev = String(severity || "").toLowerCase();
  if (!["info", "warn", "critical"].includes(sev)) return { dispatch: false, reason: "invalid_severity" };

  // Already auto-suppressed — operator was notified; stop the 5-min spam.
  if (Number(row?.mirror_suppressed) === 1) {
    return { dispatch: false, reason: "mirror_suppressed" };
  }

  // 2026-07-31 — Never page "model closed and broker flat — consistent"
  // as WARN. That state is healthy; stale-row emits used to surface it.
  const syncState = String(row?.sync_state || "").toLowerCase();
  const note = String(row?.sync_note || "");
  if (NO_EMAIL_SYNC_STATES.has(syncState) || /\bconsistent\b/i.test(note)) {
    return { dispatch: false, reason: "in_sync_no_notify" };
  }

  const lastTs = Number(row?.last_user_notified_at) || 0;
  const lastSev = String(row?.notification_severity || "").toLowerCase();
  const window = DEDUP_WINDOW_MS[sev] || 0;
  // Downgrade after critical: don't re-page as warn inside the window.
  if (sev === "warn" && lastSev === "critical") {
    return { dispatch: false, reason: "downgrade_from_critical_skipped" };
  }
  // Escalate warn → critical once inside the window (severity change).
  if (sev === "critical" && lastSev === "warn" && lastTs > 0
      && window > 0 && (Date.now() - lastTs) < window) {
    return { dispatch: true, reason: "escalate_warn_to_critical" };
  }
  if (window > 0 && lastTs > 0 && (Date.now() - lastTs) < window) {
    return { dispatch: false, reason: `dedup_within_${window / 1000}s` };
  }
  return { dispatch: true, reason: lastTs === 0 ? "first_emit" : "dedup_window_expired" };
}

/** Plain-language guidance for a sync state (compliance: no "you/your"). */
export function meaningForSyncState(syncState) {
  switch (String(syncState || "").toLowerCase()) {
    case "partial_fill":
      return "The broker filled less than the model intended. Future TRIM/EXIT actions will be scaled proportionally.";
    case "broker_orphan":
      return "The model CLOSED this trade but the broker still holds a position. Close the leftover shares at the broker, or contact support.";
    case "mothership_orphan":
      return "The position was closed manually at the broker. The mirror is suppressed for this trade; no further actions will be sent.";
    case "reconcile_error":
      return "The bridge could not fetch broker positions on the last cycle. It will retry automatically; persistent failures escalate.";
    case "expired":
      return "This options trade has expired. The manifest is archived.";
    case "untracked":
      return "Broker holdings are not tied to an open model trade. Review Mission Control before acting.";
    default:
      return "Mirror sync needs attention. Review the broker connection in Mission Control.";
  }
}

/**
 * Build a compact single-event email body (legacy / preview). Returns
 * { subject, text, html }. The drain path prefers the consolidated
 * digest in worker/email.js (`buildMirrorSyncDigestEmail`).
 */
export function buildDriftEmailContent(row, severity) {
  const sev = String(severity || "").toUpperCase();
  const ticker = row.ticker || "—";
  const mode = String(row.mode || "trader");
  const inst = String(row.instrument_type || "equity");
  const syncState = row.sync_state || "unknown";
  const note = row.sync_note || "";

  const subjectPrefix = sev === "CRITICAL" ? "URGENT" : "Heads-up";
  const subject = `[Timed Trading] ${subjectPrefix} — ${ticker} ${mode}/${inst} ${syncState}`;

  const lines = [
    `Severity: ${sev}`,
    `Ticker:   ${ticker}`,
    `Mode:     ${mode}`,
    `Instrument: ${inst}${row.options_structure ? `:${row.options_structure}` : ""}`,
    `Sync state: ${syncState}`,
    `Detail:   ${note}`,
    "",
    "What this means:",
    meaningForSyncState(syncState),
  ];

  const text = `${subject}\n\n${lines.join("\n")}\n\nReview: https://timed-trading.com/account/brokers\n`;
  // Preview fallback (dark brand tones). Production drain prefers
  // worker/email.js `buildMirrorSyncDigestEmail` for the live send.
  const accent = sev === "CRITICAL" ? "#ef4444" : "#f59e0b";
  const html = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;line-height:1.55;color:#e5e7eb;max-width:560px;background:#0b0e11;padding:20px">
    <div style="background:#111318;border:1px solid #1e2128;border-radius:12px;padding:24px 22px">
      <h2 style="margin:0 0 12px;color:${accent};font-family:Georgia,serif;font-size:20px">${subject.replace(/^\[Timed Trading\] /, "")}</h2>
      <pre style="background:#0b0e11;padding:12px;border-radius:8px;border:1px solid #1e2128;font-family:Menlo,Monaco,monospace;font-size:12px;white-space:pre-wrap;color:#9ca3af">${lines.join("\n")}</pre>
      <p style="margin:14px 0 0"><a href="https://timed-trading.com/account/brokers" style="color:#00c853;font-weight:700;text-decoration:none">Review in Mission Control →</a></p>
    </div>
  </div>`;
  return { subject, text, html };
}

/** Normalize a queued notify item into a digest event row. */
export function notifyItemToEvent(item) {
  if (!item || typeof item !== "object") return null;
  const ev = item.event && typeof item.event === "object" ? item.event : null;
  const ticker = String(ev?.ticker || item.ticker || "").toUpperCase();
  const syncState = String(ev?.sync_state || item.sync_state || "").toLowerCase();
  if (!ticker && !syncState) return null;
  return {
    severity: String(item.severity || "warn").toLowerCase(),
    ticker: ticker || "—",
    mode: String(ev?.mode || item.mode || "trader"),
    instrument_type: String(ev?.instrument_type || item.instrument_type || "equity"),
    options_structure: ev?.options_structure || item.options_structure || null,
    sync_state: syncState || "unknown",
    sync_note: String(ev?.sync_note || item.sync_note || ""),
    trade_id: item.trade_id || ev?.trade_id || null,
    broker_account_id: item.broker_account_id || ev?.broker_account_id || null,
    broker_remaining_qty: ev?.broker_remaining_qty ?? item.broker_remaining_qty ?? null,
    ts: item.ts || Date.now(),
  };
}

/**
 * Group drained queue items by recipient (user_email || user_id).
 * Pure — used by the main-worker drain to coalesce into one email.
 */
export function groupNotifyItemsByUser(items) {
  const map = new Map();
  for (const item of items || []) {
    const key = String(item?.user_email || item?.user_id || "").toLowerCase().trim();
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

/**
 * Post a critical drift event to the operator's Discord webhook.
 * Best-effort. Returns { ok, status?, error? }.
 */
export async function postOperatorDiscord(env, row, severity) {
  const url = env?.BROKER_OPERATOR_DISCORD_WEBHOOK_URL;
  if (!url) return { ok: false, error: "no_webhook_configured" };
  const sev = String(severity || "").toUpperCase();
  const color = sev === "CRITICAL" ? 15548997 : sev === "WARN" ? 16753920 : 3447003;
  const fields = [
    { name: "User", value: String(row.user_id || "—").slice(0, 64), inline: true },
    { name: "Trade ID", value: String(row.trade_id || "—").slice(0, 64), inline: true },
    { name: "Ticker", value: String(row.ticker || "—"), inline: true },
    { name: "Mode", value: String(row.mode || "—"), inline: true },
    { name: "Instrument", value: row.options_structure ? `${row.instrument_type}:${row.options_structure}` : String(row.instrument_type || "—"), inline: true },
    { name: "Sync state", value: String(row.sync_state || "—"), inline: true },
  ];
  if (row.sync_note) fields.push({ name: "Detail", value: String(row.sync_note).slice(0, 900), inline: false });
  const payload = {
    embeds: [{
      title: `${sev} drift — ${row.ticker || "?"} ${row.sync_state || "?"}`,
      color,
      timestamp: new Date().toISOString(),
      fields,
    }],
  };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Mark the manifest row as notified so subsequent reconciler passes
 * within the dedup window skip the notification.
 */
export async function markManifestNotified(env, userId, tradeId, brokerAccountId, severity) {
  const db = env?.BRIDGE_DB;
  if (!db) return false;
  try {
    await db.prepare(`
      UPDATE mirror_trade_manifest
         SET last_user_notified_at = ?4,
             notification_severity = ?5,
             updated_at = ?4
       WHERE user_id = ?1 AND trade_id = ?2 AND broker_account_id = ?3
    `).bind(
      String(userId).toLowerCase(),
      String(tradeId),
      String(brokerAccountId || "default"),
      Date.now(),
      String(severity).toLowerCase(),
    ).run();
    return true;
  } catch (e) {
    console.warn("[NOTIFY] markNotified failed:", String(e?.message || e).slice(0, 200));
    return false;
  }
}

/**
 * Top-level entry from the reconciler. Decides whether to dispatch,
 * fires the operator Discord (critical only), enqueues the user
 * email payload, and stamps the manifest. The actual user email send
 * is done by the MAIN worker via a queued payload (the bridge worker
 * doesn't carry SENDGRID_API_KEY).
 *
 * @param {object} env
 * @param {object} row    Manifest row (post-classify)
 * @param {string} severity  info / warn / critical
 * @returns {object} { dispatched, channels, dedup_reason? }
 */
export async function emitDriftNotification(env, row, severity) {
  const decision = shouldDispatchDriftNotification(row, severity);
  if (!decision.dispatch) {
    return { dispatched: false, dedup_reason: decision.reason };
  }
  const channels = [];
  // Critical → operator Discord (best-effort).
  if (String(severity).toLowerCase() === "critical") {
    try {
      const r = await postOperatorDiscord(env, row, severity);
      if (r.ok) channels.push("operator_discord");
    } catch (_) {}
  }
  // Enqueue structured event + legacy content. Main-worker drain
  // coalesces all events for a user into ONE Mirror Sync digest.
  // Partner accounts (notify_emails on the bridge user row) enqueue one
  // item per recipient — partner + admin each get their own digest.
  const KV = env?.BRIDGE_KV;
  if (KV) {
    try {
      const userRow = await readUser(env, row.user_id).catch(() => null);
      const recipients = resolveNotifyRecipients(env, userRow);
      const event = {
        ticker: row.ticker || null,
        mode: row.mode || null,
        instrument_type: row.instrument_type || null,
        options_structure: row.options_structure || null,
        sync_state: row.sync_state || null,
        sync_note: row.sync_note || null,
        trade_id: row.trade_id || null,
        broker_account_id: row.broker_account_id || null,
        broker_remaining_qty: row.broker_remaining_qty ?? null,
      };
      const payload = {
        user_id: row.user_id,
        trade_id: row.trade_id,
        broker_account_id: row.broker_account_id,
        severity,
        ts: Date.now(),
        event,
        content: buildDriftEmailContent(row, severity),
      };
      if (recipients) {
        for (let i = 0; i < recipients.length; i++) {
          const queueKey = `bridge:notify:queue:${Date.now()}:${row.user_id}:${row.trade_id}:r${i}`;
          await KV.put(queueKey, JSON.stringify({ ...payload, user_email: recipients[i] }),
            { expirationTtl: 7 * 86400 });
        }
      } else {
        const queueKey = `bridge:notify:queue:${Date.now()}:${row.user_id}:${row.trade_id}`;
        await KV.put(queueKey, JSON.stringify(payload), { expirationTtl: 7 * 86400 });
      }
      channels.push("user_email_queued");
    } catch (e) {
      console.warn("[NOTIFY] queue write failed:", String(e?.message || e).slice(0, 200));
    }
  }
  await markManifestNotified(env, row.user_id, row.trade_id, row.broker_account_id, severity);
  return { dispatched: true, channels };
}

// ════════════════════════════════════════════════════════════════════
// Daily Owner Email digest (§13)
// ════════════════════════════════════════════════════════════════════

/**
 * Build the per-user daily digest payload. Returns null when the
 * skip-if-quiet rule fires.
 *
 * Inputs gathered for each user:
 *   - Today's bridge audit entries (executed trades + rejects)
 *   - Current broker positions snapshot (equity + options)
 *   - Day P&L (realized + unrealized)
 *   - Tomorrow's outlook (manifest open rows)
 */
/** Midnight America/New_York as epoch ms (handles EST/EDT). */
export function midnightNyMs(nowMs = Date.now()) {
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const targetDay = dateFmt.format(new Date(nowMs)); // YYYY-MM-DD in NY
  let t = nowMs - (nowMs % 60_000);
  while (dateFmt.format(new Date(t)) === targetDay) t -= 60_000;
  return t + 60_000; // first minute of the NY calendar day
}

function _normalizeDigestAction(row) {
  const kind = String(row.kind || row.event_type || row.action || "").toLowerCase();
  const side = String(row.side || "").toUpperCase();
  const qty = Number(row.qty) || 0;
  const ticker = String(row.ticker || row.symbol || "?").toUpperCase();
  const px = row.price != null ? Number(row.price)
    : (row.price_target != null ? Number(row.price_target) : null);
  let label = "TRADE";
  if (kind === "adopt_position" || kind === "adopt" || kind === "sync") label = "SYNC";
  else if (kind === "exit" || side === "SELL" || side === "TRIM" || side === "EXIT") label = "SELL";
  else if (kind === "entry" || kind === "fill" || kind === "partial_fill" || kind === "place"
    || side === "BUY" || side === "LONG") label = "BUY";
  else if (side) label = side;
  return {
    ts: Number(row.ts) || 0,
    ticker,
    side: side || label,
    qty,
    price: Number.isFinite(px) ? px : null,
    status: row.status || "ok",
    trade_id: row.trade_id || row.model_trade_id || null,
    kind: label === "SYNC" ? "sync" : "fill",
    label,
    source: row.source || "unknown",
  };
}

/**
 * Whether the daily Account digest should be built for this moment.
 *
 * The digest cron fires at 21:30 UTC every day, which is after the close on
 * the same ET date — so on weekends and market holidays it produced a "0 fills
 * / No fills or syncs today" email that only restated unchanged positions.
 * Limiting to trading days keeps the inbox to days the account could actually
 * have moved. Half-days still send: the market traded.
 *
 * Only gates the scheduled build; the admin preview route stays available so a
 * digest can be rendered on demand any day.
 */
export function shouldBuildDailyDigest(nowMs = Date.now(), { ignoreCalendar = false } = {}) {
  const etDate = etDateStr(nowMs);
  if (ignoreCalendar) return { send: true, et_date: etDate, reason: "calendar_override" };
  if (!isTradingDay(etDate)) {
    return { send: false, et_date: etDate, reason: "not_a_trading_day" };
  }
  return { send: true, et_date: etDate, reason: "trading_day" };
}

/** BUY / SELL for a ledger row, or null when the row moves no shares. */
export function ledgerRowSide(row) {
  const side = String(row?.side || "").toUpperCase();
  const evt = String(row?.event_type || "").toUpperCase();
  if (side === "SELL" || side === "TRIM" || side === "EXIT" || evt === "EXIT") return "SELL";
  if (side === "BUY" || side === "LONG" || evt === "ENTRY") return "BUY";
  // FILL / PARTIAL_FILL rows carry direction only on `side`; without it the
  // row cannot be attributed to either leg.
  return null;
}

/**
 * Realized P&L for today's sells, using a weighted-average cost basis walked
 * forward over the account's full fill history.
 *
 * The digest previously hardcoded realized to 0 because no per-lot basis was
 * stored, so a day with sells still reported "Realized $0.00". Walking the
 * ledger gives a basis without a schema change.
 *
 * The ledger only goes back to its own creation, so a sell can cover more
 * shares than the walk ever saw bought. Each sell is therefore priced in two
 * parts: the shares the recorded buys cover, at the book's weighted average,
 * and any residual at the live broker average cost. A residual with neither
 * basis is left out of the total and counted, so the figure is reported as
 * partial rather than resting on a fabricated cost.
 *
 * @param {Array} history  ledger rows ASC by ts (whole account history)
 * @param {object} opts    { sinceMs, avgCostByTicker }
 */
export function computeRealizedFromLedger(history, { sinceMs = 0, avgCostByTicker = {} } = {}) {
  const book = new Map(); // ticker -> { shares, cost }
  let realized = 0;
  let sellCount = 0;
  let unattributed = 0;
  let estimated = 0;

  for (const row of (history || [])) {
    const side = ledgerRowSide(row);
    if (!side) continue;
    const ticker = String(row.ticker || "").toUpperCase();
    const qty = Math.abs(Number(row.qty));
    const price = Number(row.price);
    if (!ticker || !(qty > 0) || !Number.isFinite(price) || price <= 0) continue;
    const ts = Number(row.ts) || 0;

    const lot = book.get(ticker) || { shares: 0, cost: 0 };
    if (side === "BUY") {
      lot.shares += qty;
      lot.cost += qty * price;
      book.set(ticker, lot);
      continue;
    }

    // SELL — split into the portion the recorded buys cover and the residual.
    const bookAvg = lot.shares > 0 ? lot.cost / lot.shares : null;
    const fromBook = Math.min(qty, lot.shares);
    const residual = qty - fromBook;
    if (fromBook > 0) {
      lot.cost -= fromBook * bookAvg;
      lot.shares -= fromBook;
      if (lot.shares <= 1e-9) { lot.shares = 0; lot.cost = 0; }
      book.set(ticker, lot);
    }

    if (ts < sinceMs) continue;
    sellCount++;

    let pnl = 0;
    let covered = 0;
    if (fromBook > 0) {
      pnl += (price - bookAvg) * fromBook;
      covered += fromBook;
    }
    if (residual > 1e-9) {
      // Shares the ledger never saw bought — price them off the broker's own
      // average cost when the position is still open enough to report one.
      const fallback = Number(avgCostByTicker?.[ticker]);
      if (Number.isFinite(fallback) && fallback > 0) {
        pnl += (price - fallback) * residual;
        covered += residual;
        estimated++;
      }
    }
    if (covered <= 1e-9) { unattributed++; continue; }
    if (covered + 1e-9 < qty) unattributed++; // only part of the sell had a basis
    realized += pnl;
  }

  return {
    realized: Math.round(realized * 100) / 100,
    sell_count: sellCount,
    unattributed_sells: unattributed,
    estimated_sells: estimated,
    // Partial when any of today's sold shares had no cost basis at all.
    partial: unattributed > 0,
  };
}

export async function buildDailyOwnerDigest(env, user, brokerAdapter) {
  const db = env?.BRIDGE_DB;
  if (!db) return null;
  const userId = String(user?.user_id || "").toLowerCase();
  if (!userId) return null;
  const midnightEtMs = midnightNyMs(Date.now());
  const brokerAccountId = user.webull_account_id || user.ibkr_account_id || user.rh_account_number || null;

  // 1. Today's executed actions — audit places + adopts AND account-ledger
  // fills. Counting only `bridge_audit.place` missed AUTO-SYNC adopts and
  // ledger ENTRY/EXIT rows, which is why digests said "0 trades" on days
  // with new entries.
  let audit = [];
  try {
    const r = await db.prepare(`
      SELECT ts, ticker, action, side, qty, price_target, estimated_value,
             status, reject_reason, trade_id
        FROM bridge_audit
       WHERE user_id = ?1 AND ts >= ?2
       ORDER BY ts ASC LIMIT 200
    `).bind(userId, midnightEtMs).all().catch(() => ({ results: [] }));
    audit = r?.results || [];
  } catch (_) {}
  const rejected = audit.filter(a => a.status === "rejected" || a.action === "reject");

  let ledger = [];
  try {
    await import("./bridge-account-ledger.js").then((m) => m.ensureAccountLedgerSchema(env)).catch(() => {});
    const sql = brokerAccountId
      ? `SELECT ts, ticker, side, qty, price, value, status, event_type,
                model_trade_id, broker_account_id, user_id
           FROM broker_account_ledger
          WHERE ts >= ?1 AND status = 'ok'
            AND (user_id = ?2 OR broker_account_id = ?3)
            AND UPPER(COALESCE(event_type, '')) IN ('ENTRY','EXIT','FILL','PARTIAL_FILL')
          ORDER BY ts ASC LIMIT 200`
      : `SELECT ts, ticker, side, qty, price, value, status, event_type,
                model_trade_id, broker_account_id, user_id
           FROM broker_account_ledger
          WHERE ts >= ?1 AND status = 'ok' AND user_id = ?2
            AND UPPER(COALESCE(event_type, '')) IN ('ENTRY','EXIT','FILL','PARTIAL_FILL')
          ORDER BY ts ASC LIMIT 200`;
    const stmt = db.prepare(sql);
    const r = await (brokerAccountId
      ? stmt.bind(midnightEtMs, userId, String(brokerAccountId)).all()
      : stmt.bind(midnightEtMs, userId).all()
    ).catch(() => ({ results: [] }));
    ledger = r?.results || [];
  } catch (_) {}

  const fromAudit = audit
    .filter((a) => a.status === "ok" && (a.action === "place" || a.action === "adopt_position"))
    .map((a) => _normalizeDigestAction({
      ...a,
      kind: a.action === "adopt_position" ? "sync" : "fill",
      price: a.price_target,
      source: "audit",
    }));
  const fromLedger = ledger.map((r) => _normalizeDigestAction({
    ...r,
    kind: String(r.event_type || "").toUpperCase() === "EXIT" ? "exit" : "entry",
    source: "ledger",
  }));

  // Dedupe: same ticker+qty+side within 2 minutes across audit/ledger.
  const executed = [];
  const seen = new Set();
  for (const row of [...fromAudit, ...fromLedger].sort((a, b) => a.ts - b.ts)) {
    const bucket = Math.floor(row.ts / 120000);
    const key = `${row.kind}|${row.ticker}|${row.side}|${row.qty}|${bucket}`;
    if (seen.has(key)) continue;
    seen.add(key);
    executed.push(row);
  }

  // 2. Current broker snapshot.
  let positions = [];
  let optionsPositions = [];
  let portfolio = null;
  try {
    if (typeof brokerAdapter?.getPortfolio === "function") {
      const r = await brokerAdapter.getPortfolio(env, user);
      if (r?.ok) portfolio = r.portfolio || r;
    }
    if (typeof brokerAdapter?.getEquityPositions === "function") {
      const r = await brokerAdapter.getEquityPositions(env, user);
      if (r?.ok) positions = r.positions || [];
    }
    if (typeof brokerAdapter?.getOptionsPositions === "function") {
      const r = await brokerAdapter.getOptionsPositions(env, user);
      if (r?.ok) optionsPositions = r.positions || [];
    }
  } catch (_) {}

  // 3. Skip-if-quiet rule.
  const quiet = executed.length === 0 && positions.length === 0 && optionsPositions.length === 0;
  if (quiet && String(user?.daily_digest_always_send || "false").toLowerCase() !== "true") {
    return { skip: true, reason: "quiet_day" };
  }

  // 4. Day P&L.
  const unrealized = positions.reduce((acc, p) => acc + (Number(p.unrealizedPnl) || Number(p.unrealized_pnl) || 0), 0)
    + optionsPositions.reduce((acc, p) => acc + (Number(p.unrealizedPnl) || Number(p.unrealized_pnl) || 0), 0);

  // Realized — walk the account's whole fill history to build a weighted-average
  // cost basis, then price today's sells against it. Live broker average cost
  // covers positions adopted before the ledger existed.
  const avgCostByTicker = {};
  for (const p of positions) {
    const sym = String(p.ticker || p.symbol || "").toUpperCase();
    const avg = Number(p.avg_cost ?? p.avgCost ?? p.average_cost);
    if (sym && Number.isFinite(avg) && avg > 0) avgCostByTicker[sym] = avg;
  }
  let realizedInfo = { realized: 0, sell_count: 0, unattributed_sells: 0, partial: false };
  try {
    const histSql = brokerAccountId
      ? `SELECT ts, ticker, side, qty, price, event_type
           FROM broker_account_ledger
          WHERE status = 'ok' AND (user_id = ?1 OR broker_account_id = ?2)
            AND UPPER(COALESCE(event_type, '')) IN ('ENTRY','EXIT','FILL','PARTIAL_FILL')
          ORDER BY ts ASC LIMIT 5000`
      : `SELECT ts, ticker, side, qty, price, event_type
           FROM broker_account_ledger
          WHERE status = 'ok' AND user_id = ?1
            AND UPPER(COALESCE(event_type, '')) IN ('ENTRY','EXIT','FILL','PARTIAL_FILL')
          ORDER BY ts ASC LIMIT 5000`;
    const hs = db.prepare(histSql);
    const hr = await (brokerAccountId
      ? hs.bind(userId, String(brokerAccountId)).all()
      : hs.bind(userId).all()
    ).catch(() => ({ results: [] }));
    realizedInfo = computeRealizedFromLedger(hr?.results || [], {
      sinceMs: midnightEtMs,
      avgCostByTicker,
    });
  } catch (e) {
    console.warn(`[DAILY DIGEST] realized computation failed for ${userId}: ${String(e?.message || e).slice(0, 160)}`);
  }
  const realized = realizedInfo.realized;
  const equityEnd = Number(portfolio?.equity_usd) || Number(portfolio?.equity) || 0;
  const fillCount = executed.filter((e) => e.kind === "fill").length;
  const syncCount = executed.filter((e) => e.kind === "sync").length;

  // 5. Tomorrow's outlook — open manifest rows.
  let openTrades = [];
  try {
    const r = await db.prepare(`
      SELECT ticker, mode, instrument_type, options_structure,
             model_intended_qty, broker_remaining_qty, sync_state
        FROM mirror_trade_manifest
       WHERE user_id = ?1 AND model_status = 'OPEN'
       ORDER BY updated_at DESC LIMIT 20
    `).bind(userId).all().catch(() => ({ results: [] }));
    openTrades = r?.results || [];
  } catch (_) {}

  // 6. 2026-06-02 — Sanity-sweep summary. The main worker persists the
  // latest sweep to KV under "sanity_sweep:latest" (and "sanity_sweep:
  // fast:latest"). The bridge KV is the same namespace, so we can read
  // it directly. Renders in the digest as "System: 13/14 checks ok ·
  // 1 warn · 0 fail" with any failing/warning check names listed.
  // Internal system-health checks are operator diagnostics — a partner's
  // account digest must not carry them.
  let sanitySummary = null;
  try {
    const kv = isAdminOwnedRow(env, user) ? (env?.BRIDGE_KV || env?.KV_TIMED) : null;
    if (kv) {
      const raw = await kv.get("sanity_sweep:latest");
      if (raw) {
        const sweep = JSON.parse(raw);
        const failing = (sweep.checks || []).filter(c => c.status === "fail");
        const warning = (sweep.checks || []).filter(c => c.status === "warn");
        sanitySummary = {
          ok_count: sweep.summary?.ok_count || 0,
          warn_count: sweep.summary?.warn_count || 0,
          fail_count: sweep.summary?.fail_count || 0,
          age_minutes: sweep.ts ? Math.round((Date.now() - sweep.ts) / 60000) : null,
          failing_checks: failing.map(c => ({ id: c.id, label: c.label, anomaly: (c.anomalies?.[0]?.detail || "").slice(0, 200) })),
          warning_checks: warning.map(c => ({ id: c.id, label: c.label, anomaly: (c.anomalies?.[0]?.detail || "").slice(0, 200) })),
        };
      }
    }
  } catch (_) { /* sanity summary is best-effort; never block the digest */ }

  return {
    skip: false,
    user_id: userId,
    user_email: user.email || ownerEmailForRow(user),
    user_display_name: user.display_name || userId.split("@")[0],
    broker: String(user.broker || "ibkr").toUpperCase(),
    broker_account_id: brokerAccountId,
    executed,
    fill_count: fillCount,
    sync_count: syncCount,
    rejected_count: rejected.length,
    positions, options_positions: optionsPositions,
    day_pnl: {
      realized,
      unrealized,
      total: realized + unrealized,
      realized_sell_count: realizedInfo.sell_count,
      realized_partial: realizedInfo.partial,
      realized_unattributed_sells: realizedInfo.unattributed_sells,
      realized_estimated_sells: realizedInfo.estimated_sells,
    },
    equity_end: equityEnd,
    open_trades: openTrades,
    audit_total: audit.length,
    sanity_summary: sanitySummary,
    generated_at: Date.now(),
  };
}

function _digestActionHeadline(digest) {
  const fills = Number(digest.fill_count ?? digest.executed?.filter?.((e) => e.kind !== "sync").length) || 0;
  const syncs = Number(digest.sync_count ?? digest.executed?.filter?.((e) => e.kind === "sync").length) || 0;
  const parts = [];
  if (fills) parts.push(`${fills} fill${fills === 1 ? "" : "s"}`);
  if (syncs) parts.push(`${syncs} sync${syncs === 1 ? "" : "s"}`);
  if (!parts.length) parts.push("0 fills");
  return parts.join(", ");
}

/**
 * Render the daily digest into { subject, text, html }.
 * Main-worker drain prefers `buildDailyOwnerDigestEmail` in email.js
 * (branded layout + unsubscribe) when `digest_summary` is present.
 */
export function renderDailyOwnerDigestEmail(digest) {
  if (!digest || digest.skip) return null;
  const total = Number(digest.day_pnl?.total) || 0;
  const totalSign = total >= 0 ? "+" : "";
  const totalUsd = `$${Math.abs(total).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const pctOfEquity = digest.equity_end > 0
    ? (total / digest.equity_end * 100).toFixed(2) + "%"
    : "—";
  const actionHeadline = _digestActionHeadline(digest);
  const subject = `[Timed Trading] Account today — ${actionHeadline}, ${totalSign}${totalUsd} (${totalSign}${pctOfEquity})`;

  const tradeLines = (digest.executed || []).map((t) => {
    const label = t.label || String(t.side || "").toUpperCase() || "TRADE";
    const qty = Number(t.qty) || 0;
    const px = t.price != null ? ` @ $${Number(t.price).toFixed(2)}`
      : (t.price_target != null ? ` @ $${Number(t.price_target).toFixed(2)}` : "");
    return `  ${label} ${qty} ${t.ticker}${px}`;
  });
  const positionLines = (digest.positions || []).slice(0, 30).map((p) => {
    const qty = Number(p.qty ?? p.position ?? p.quantity) || 0;
    const pnl = Number(p.unrealizedPnl ?? p.unrealized_pnl) || 0;
    const sign = pnl >= 0 ? "+" : "";
    return `  ${String(p.symbol || p.ticker || "?").toUpperCase()}  ${qty} sh  ${sign}$${pnl.toFixed(2)}`;
  });
  const watchLines = (digest.open_trades || []).slice(0, 15).map((t) =>
    `  ${t.ticker} · ${t.mode}/${t.instrument_type}${t.options_structure ? `:${t.options_structure}` : ""} · ${t.sync_state}`,
  );

  const text = [
    subject,
    "",
    `EXECUTED TODAY (${(digest.executed || []).length})`,
    ...(tradeLines.length > 0 ? tradeLines : ["  (none)"]),
    digest.rejected_count > 0 ? `(${digest.rejected_count} order(s) rejected at preflight)` : "",
    "",
    `OPEN POSITIONS (${(digest.positions || []).length}${digest.options_positions?.length ? ` + ${digest.options_positions.length} options` : ""})`,
    ...(positionLines.length > 0 ? positionLines : ["  (no open equity positions)"]),
    "",
    "DAY P&L",
    `  Realized:   $${Number(digest.day_pnl?.realized || 0).toFixed(2)}`,
    `  Unrealized: $${Number(digest.day_pnl?.unrealized || 0).toFixed(2)}`,
    `  Total day:  ${totalSign}${totalUsd}  (${totalSign}${pctOfEquity})`,
    `  Equity end: $${Number(digest.equity_end).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    "",
    "OPEN MIRROR SLEEVES",
    ...(watchLines.length > 0 ? watchLines : ["  (none)"]),
    "",
    ...(digest.sanity_summary ? [
      "SYSTEM HEALTH (sanity sweep)",
      `  ${digest.sanity_summary.ok_count} ok · ${digest.sanity_summary.warn_count} warn · ${digest.sanity_summary.fail_count} fail`,
      "",
    ] : []),
    "QUICK LINKS",
    "  Broker Connections: https://timed-trading.com/broker-connections.html",
    "  Email preferences:  https://timed-trading.com/my-account.html#email",
    "  Daily brief:        https://timed-trading.com/today",
    "",
    "— Timed Trading",
    "Manage email preferences at timed-trading.com/my-account.html#email",
  ].filter(Boolean).join("\n");

  // Lightweight branded HTML for bridge preview / fallback. Drain re-renders
  // with worker/email.js emailLayout when digest_summary is queued.
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pnlColor = total >= 0 ? "#34d399" : "#ef4444";
  const rowHtml = (digest.executed || []).slice(0, 40).map((t) => {
    const label = esc(t.label || t.side || "TRADE");
    const qty = Number(t.qty) || 0;
    const px = t.price != null ? ` @ $${Number(t.price).toFixed(2)}` : "";
    return `<tr><td style="padding:6px 0;color:#e5e7eb;font-size:13px">${label} <strong>${esc(t.ticker)}</strong></td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-family:Menlo,Consolas,monospace;font-size:12px">${qty}${esc(px)}</td></tr>`;
  }).join("");
  const posHtml = (digest.positions || []).slice(0, 25).map((p) => {
    const qty = Number(p.qty ?? p.position ?? p.quantity) || 0;
    const pnl = Number(p.unrealizedPnl ?? p.unrealized_pnl) || 0;
    const sign = pnl >= 0 ? "+" : "";
    const col = pnl >= 0 ? "#34d399" : "#ef4444";
    return `<tr><td style="padding:5px 0;color:#e5e7eb;font-size:12px">${esc(String(p.symbol || p.ticker || "?").toUpperCase())}</td><td style="padding:5px 0;text-align:right;color:#9ca3af;font-family:Menlo,Consolas,monospace;font-size:11px">${qty} sh</td><td style="padding:5px 0;text-align:right;color:${col};font-family:Menlo,Consolas,monospace;font-size:11px">${sign}$${pnl.toFixed(2)}</td></tr>`;
  }).join("");

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0b0e11;font-family:'Helvetica Neue',Arial,sans-serif;color:#e5e7eb">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0e11"><tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
  <tr><td style="padding:20px 24px;text-align:center">
    <img src="https://timed-trading.com/logo-discord.png" alt="TT" width="32" height="32" style="display:inline-block;width:32px;height:32px;border-radius:8px;vertical-align:middle;border:0">
    <span style="margin-left:8px;font-size:16px;font-weight:700;color:white;vertical-align:middle;letter-spacing:-0.03em">Timed Trading</span>
  </td></tr>
  <tr><td style="background:#111318;border:1px solid #1e2128;border-radius:12px;padding:28px 24px">
    <h2 style="margin:0 0 4px;font-size:20px;color:#e5e7eb;font-family:Georgia,serif">Account today</h2>
    <p style="margin:0 0 16px;color:#9ca3af;font-size:13px">${esc(digest.broker)}${digest.broker_account_id ? ` · ${esc(digest.broker_account_id)}` : ""} · ${esc(actionHeadline)}</p>
    <div style="background:#0b0e11;border:1px solid #1e2128;border-radius:10px;padding:16px 18px;margin:0 0 20px">
      <div style="font-size:26px;font-weight:700;color:${pnlColor};font-family:Menlo,Consolas,monospace">${totalSign}${totalUsd} <span style="font-size:14px">(${totalSign}${pctOfEquity})</span></div>
      <div style="font-size:11px;color:#6b7280;margin-top:6px">Realized $${Number(digest.day_pnl?.realized || 0).toFixed(2)} · Unrealized $${Number(digest.day_pnl?.unrealized || 0).toFixed(2)} · Equity $${Number(digest.equity_end).toLocaleString("en-US", { maximumFractionDigits: 0 })}</div>
    </div>
    <p style="margin:0 0 8px;font-size:11px;font-weight:700;color:#6b7280;letter-spacing:0.08em;text-transform:uppercase">Executed today</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px">${rowHtml || `<tr><td style="color:#6b7280;font-size:12px;padding:6px 0">No fills or syncs today</td></tr>`}</table>
    <p style="margin:0 0 8px;font-size:11px;font-weight:700;color:#6b7280;letter-spacing:0.08em;text-transform:uppercase">Open positions</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px">${posHtml || `<tr><td style="color:#6b7280;font-size:12px;padding:6px 0">No open equity positions</td></tr>`}</table>
    <p style="margin:16px 0 0;font-size:12px">
      <a href="https://timed-trading.com/broker-connections.html" style="color:#00c853;font-weight:700;text-decoration:none">Broker Connections →</a>
      &nbsp;&nbsp;
      <a href="https://timed-trading.com/my-account.html#email" style="color:#9ca3af;text-decoration:underline">Email preferences</a>
    </p>
  </td></tr>
  <tr><td style="padding:24px;text-align:center">
    <p style="margin:0 0 8px;font-size:12px;color:#6b7280">Timed Trading · <a href="https://timed-trading.com" style="color:#6b7280">timed-trading.com</a></p>
    <p style="margin:0;font-size:11px;color:#6b7280"><a href="https://timed-trading.com/my-account.html#email" style="color:#6b7280;text-decoration:underline">Manage email preferences</a></p>
    <p style="margin:8px 0 0;font-size:10px;color:#6b7280">This is not financial advice. For educational purposes only.</p>
  </td></tr>
</table></td></tr></table></body></html>`;

  return { subject, text, html };
}

/**
 * Drain the bridge_notify queue. Caller (main worker email cron)
 * coalesces items per user into one Mirror Sync digest and sends.
 *
 * Returns Array<{user_id, severity, event?, content, ...}> ready to send.
 */
export async function drainNotifyQueue(env, { limit = 200, peek = false } = {}) {
  const KV = env?.BRIDGE_KV;
  if (!KV) return [];
  // Two producers write to this queue: drift notifications
  // (`bridge:notify:queue:`) and the 21:30 UTC daily owner digest
  // (`bridge:notify:daily:`). Draining only the first left every daily
  // digest to expire unsent.
  const prefixes = ["bridge:notify:queue:", "bridge:notify:daily:"];
  const out = [];
  for (const prefix of prefixes) {
    try {
      const list = await KV.list({ prefix, limit });
      for (const k of (list.keys || [])) {
        const raw = await KV.get(k.name);
        if (!raw) continue;
        try {
          out.push(JSON.parse(raw));
        } catch (_) {}
        // One-shot delete after read — unless peek/preview (send=false).
        if (!peek) await KV.delete(k.name).catch(() => {});
      }
    } catch (e) {
      console.warn(`[NOTIFY] drainQueue failed for ${prefix}:`, String(e?.message || e).slice(0, 200));
    }
  }
  return out;
}
