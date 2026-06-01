// worker-bridge/bridge-notifications.js
//
// 2026-06-01 — Phase E of the trade-aware mirror sync. Per
// tasks/2026-06-01-trade-aware-mirror-sync-design.md §7.
//
// Severity tier routing for drift events:
//
//   info     → bundled into the Daily Owner Email digest (no immediate dispatch)
//   warn     → immediate email to user + in-app banner; dedup'd 1×/day/trade
//   critical → immediate email + operator Discord webhook (no dedup)
//
// Called from the reconciler (`bridge-reconciler.js`) whenever a drift
// classification is persisted with severity ≥ warn. Dedup state lives
// on the manifest row (`last_user_notified_at`, `notification_severity`)
// so we don't spam the user with "still partial fill" emails every
// 5 minutes.
//
// Operator Discord webhook is best-effort: the env var
// BROKER_OPERATOR_DISCORD_WEBHOOK_URL is checked, and a failure to
// post never blocks the reconcile cycle.

import { listConnectedUsers } from "./bridge-storage.js";

const DEDUP_WINDOW_MS = {
  info: 24 * 60 * 60 * 1000,   // daily digest cadence
  warn: 24 * 60 * 60 * 1000,   // one warn per trade per day
  critical: 0,                 // no dedup — every critical event fires
};

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
  if (sev === "critical") return { dispatch: true, reason: "critical_no_dedup" };
  const lastTs = Number(row?.last_user_notified_at) || 0;
  const lastSev = String(row?.notification_severity || "").toLowerCase();
  const window = DEDUP_WINDOW_MS[sev] || 0;
  // Escalate-without-dedup: warn → critical always dispatches even if
  // a warn was sent recently.
  if (sev === "warn" && lastSev === "critical") return { dispatch: false, reason: "downgrade_from_critical_skipped" };
  if (window > 0 && lastTs > 0 && (Date.now() - lastTs) < window) {
    return { dispatch: false, reason: `dedup_within_${window / 1000}s` };
  }
  return { dispatch: true, reason: lastTs === 0 ? "first_emit" : "dedup_window_expired" };
}

/**
 * Build a compact email body describing the drift event. Returns
 * { subject, text, html }. The actual SendGrid send happens on the
 * MAIN worker (bridge worker doesn't have SENDGRID_API_KEY) so this
 * function only renders content.
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
  ];

  if (syncState === "partial_fill") {
    lines.push("The broker filled less than the model intended. Future TRIM/EXIT actions will be scaled proportionally (BROKER_PARTIAL_FILL_MODE=scale).");
  } else if (syncState === "broker_orphan") {
    lines.push("The model has CLOSED this trade but the broker still holds the position. Please close it manually at your broker or contact support.");
  } else if (syncState === "mothership_orphan") {
    lines.push("You closed this position manually at the broker. The mirror is suppressed for this trade; no further actions will be sent.");
  } else if (syncState === "reconcile_error") {
    lines.push("The bridge couldn't fetch your broker positions on the last cycle. We'll retry automatically; persistent failures will escalate.");
  } else if (syncState === "expired") {
    lines.push("This options trade has expired. Manifest archived.");
  }

  const text = `${subject}\n\n${lines.join("\n")}\n\nReview: https://timed-trading.com/account/brokers\n`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.55;color:#1f2937;max-width:560px">
    <h2 style="margin:0 0 10px;color:${sev === "CRITICAL" ? "#b91c1c" : "#a16207"}">${subject.replace(/^\[Timed Trading\] /, "")}</h2>
    <pre style="background:#f3f4f6;padding:12px;border-radius:6px;font-family:Menlo,Monaco,monospace;font-size:12px;white-space:pre-wrap">${lines.join("\n")}</pre>
    <p><a href="https://timed-trading.com/account/brokers" style="color:#2563eb">Review in Mission Control →</a></p>
  </div>`;
  return { subject, text, html };
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
  // Enqueue user-email payload in KV; the MAIN worker drains the queue
  // on its own cron (it has SENDGRID_API_KEY + the unsubscribe HMAC
  // secret bound). This indirection keeps secret surface area in one
  // place and lets the email cron coalesce multiple events per user.
  const KV = env?.BRIDGE_KV;
  if (KV) {
    try {
      const queueKey = `bridge:notify:queue:${Date.now()}:${row.user_id}:${row.trade_id}`;
      await KV.put(queueKey, JSON.stringify({
        user_id: row.user_id,
        trade_id: row.trade_id,
        broker_account_id: row.broker_account_id,
        severity,
        ts: Date.now(),
        content: buildDriftEmailContent(row, severity),
      }), { expirationTtl: 7 * 86400 });
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
export async function buildDailyOwnerDigest(env, user, brokerAdapter) {
  const db = env?.BRIDGE_DB;
  if (!db) return null;
  const userId = String(user?.user_id || "").toLowerCase();
  if (!userId) return null;
  const NYNow = new Date();
  // Compute midnight ET for the user's "today". 5 hr offset is a
  // coarse approximation (handles EST; EDT is off by 1 hr but the
  // digest doesn't depend on minute-perfect boundaries).
  const midnightEt = new Date(NYNow);
  midnightEt.setUTCHours(NYNow.getUTCHours() - 5);
  midnightEt.setUTCHours(0, 0, 0, 0);
  midnightEt.setUTCHours(midnightEt.getUTCHours() + 5);
  const midnightEtMs = midnightEt.getTime();

  // 1. Today's executed bridge actions.
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
  const executed = audit.filter(a => a.action === "place" && a.status === "ok");
  const rejected = audit.filter(a => a.status === "rejected");

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
  // Realized: pull from the audit log's exit-tagged actions if the
  // bridge stamps realized_pnl there. For now we fall back to 0.
  const realized = 0; // Phase E+ to source this from per-trade exit events.
  const equityEnd = Number(portfolio?.equity_usd) || Number(portfolio?.equity) || 0;

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

  return {
    skip: false,
    user_id: userId,
    user_email: user.email || null,
    user_display_name: user.display_name || userId.split("@")[0],
    broker: String(user.broker || "ibkr").toUpperCase(),
    broker_account_id: user.ibkr_account_id || user.rh_account_number || null,
    executed,
    rejected_count: rejected.length,
    positions, options_positions: optionsPositions,
    day_pnl: { realized, unrealized, total: realized + unrealized },
    equity_end: equityEnd,
    open_trades: openTrades,
    audit_total: audit.length,
    generated_at: Date.now(),
  };
}

/**
 * Render the daily digest into { subject, text, html }.
 * Caller (main-worker email cron) feeds this to SendGrid.
 */
export function renderDailyOwnerDigestEmail(digest) {
  if (!digest || digest.skip) return null;
  const totalSign = digest.day_pnl.total >= 0 ? "+" : "";
  const totalUsd = `$${Math.abs(digest.day_pnl.total).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const pctOfEquity = digest.equity_end > 0
    ? (digest.day_pnl.total / digest.equity_end * 100).toFixed(2) + "%"
    : "—";

  const subject = `[Timed Trading] Your account today — ${digest.executed.length} trade${digest.executed.length === 1 ? "" : "s"}, ${totalSign}${totalUsd} (${totalSign}${pctOfEquity})`;

  const tradeLines = digest.executed.map(t => {
    const et = new Date(Number(t.ts)).toLocaleString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York", hour12: false });
    const side = String(t.side || "").toUpperCase();
    const value = t.estimated_value ? `$${Number(t.estimated_value).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "?";
    return `  ${et} ET   ${side.padEnd(5)} ${Number(t.qty) || "?"} sh  ${t.ticker} @ $${Number(t.price_target).toFixed(2)} = ${value}`;
  });

  const positionLines = (digest.positions || []).map(p => {
    const ticker = String(p.contractDesc ?? p.symbol ?? p.ticker ?? "—").toUpperCase();
    const qty = Number(p.position ?? p.qty ?? 0);
    const avg = Number(p.avgCost ?? p.avg_cost ?? 0);
    const upl = Number(p.unrealizedPnl ?? p.unrealized_pnl ?? 0);
    const uplSign = upl >= 0 ? "+" : "";
    return `  ${ticker.padEnd(5)} ${String(qty).padEnd(5)} sh   avg $${avg.toFixed(2)}   unrealized ${uplSign}$${Math.abs(upl).toFixed(0)}`;
  });

  const watchLines = (digest.open_trades || []).map(t => {
    const left = `${t.ticker} (${t.mode}/${t.instrument_type}${t.options_structure ? ":" + t.options_structure : ""})`;
    return `  • ${left.padEnd(34)} model ${t.model_intended_qty || "?"} | broker ${t.broker_remaining_qty || "?"} | ${t.sync_state}`;
  });

  const text = [
    subject,
    "",
    `Hi ${digest.user_display_name},`,
    "",
    `Here's what happened in your ${digest.broker} account${digest.broker_account_id ? ` ${digest.broker_account_id}` : ""} today.`,
    "",
    "═══════════════════════════════════════════════",
    `EXECUTED TRADES (${digest.executed.length})`,
    "═══════════════════════════════════════════════",
    ...(tradeLines.length > 0 ? tradeLines : ["  (no trades today)"]),
    "",
    digest.rejected_count > 0 ? `(${digest.rejected_count} order(s) rejected at preflight — see audit log)` : "",
    "",
    "═══════════════════════════════════════════════",
    `OPEN POSITIONS (${(digest.positions || []).length}${digest.options_positions?.length ? ` + ${digest.options_positions.length} options` : ""})`,
    "═══════════════════════════════════════════════",
    ...(positionLines.length > 0 ? positionLines : ["  (no open equity positions)"]),
    "",
    "═══════════════════════════════════════════════",
    "DAY P&L",
    "═══════════════════════════════════════════════",
    `  Realized:   $${digest.day_pnl.realized.toFixed(2)}`,
    `  Unrealized: $${digest.day_pnl.unrealized.toFixed(2)}`,
    `  Total day:  ${totalSign}${totalUsd}  (${totalSign}${pctOfEquity})`,
    `  Equity end: $${Number(digest.equity_end).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    "",
    "═══════════════════════════════════════════════",
    "WHAT WE'RE WATCHING TOMORROW",
    "═══════════════════════════════════════════════",
    ...(watchLines.length > 0 ? watchLines : ["  (no open mirror trades)"]),
    "",
    "═══════════════════════════════════════════════",
    "QUICK LINKS",
    "═══════════════════════════════════════════════",
    "  → Audit log:      https://timed-trading.com/account/brokers#audit",
    "  → Pause mirror:   https://timed-trading.com/account/brokers",
    "  → Daily brief:    https://timed-trading.com/today",
    "",
    "— The Timed Trading System",
    "",
    "You're receiving this because your broker account is connected to",
    "Timed Trading. To stop these digests: settings → email preferences",
    "→ daily account digest.",
  ].filter(Boolean).join("\n");

  const _esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:#1f2937;max-width:640px">
    <h2 style="margin:0 0 8px">Your account today</h2>
    <p style="color:#6b7280;margin:0 0 16px">${digest.broker}${digest.broker_account_id ? ` · ${_esc(digest.broker_account_id)}` : ""}</p>
    <div style="background:${digest.day_pnl.total >= 0 ? "#ecfdf5" : "#fef2f2"};border-left:4px solid ${digest.day_pnl.total >= 0 ? "#10b981" : "#ef4444"};padding:12px 14px;margin:0 0 14px;border-radius:4px">
      <div style="font-size:22px;font-weight:700;color:${digest.day_pnl.total >= 0 ? "#065f46" : "#991b1b"}">${totalSign}${totalUsd} (${totalSign}${pctOfEquity})</div>
      <div style="font-size:11px;color:#6b7280;margin-top:3px">Realized $${digest.day_pnl.realized.toFixed(2)} · Unrealized $${digest.day_pnl.unrealized.toFixed(2)} · Equity end $${Number(digest.equity_end).toLocaleString("en-US", { maximumFractionDigits: 0 })}</div>
    </div>
    <pre style="background:#f3f4f6;padding:12px;border-radius:6px;font-family:Menlo,Monaco,monospace;font-size:11px;white-space:pre-wrap">${_esc(text)}</pre>
  </div>`;

  return { subject, text, html };
}

/**
 * Drain the bridge_notify queue and emit one digest payload per user
 * with their queued events appended to the body. Caller (main worker
 * email cron) is responsible for the actual SendGrid send.
 *
 * Returns Array<{user_id, severity, content, ...}> ready to send.
 */
export async function drainNotifyQueue(env, { limit = 200 } = {}) {
  const KV = env?.BRIDGE_KV;
  if (!KV) return [];
  try {
    const list = await KV.list({ prefix: "bridge:notify:queue:", limit });
    const out = [];
    for (const k of (list.keys || [])) {
      const raw = await KV.get(k.name);
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw));
      } catch (_) {}
      // One-shot: delete after read.
      await KV.delete(k.name).catch(() => {});
    }
    return out;
  } catch (e) {
    console.warn("[NOTIFY] drainQueue failed:", String(e?.message || e).slice(0, 200));
    return [];
  }
}
