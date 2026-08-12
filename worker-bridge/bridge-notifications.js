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
  if (!extras.length) return null;
  const admin = String(env?.BRIDGE_ADMIN_NOTIFY_EMAIL || "").trim().toLowerCase();
  const set = new Set(extras);
  if (admin) set.add(admin);
  return [...set];
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

  // 6. 2026-06-02 — Sanity-sweep summary. The main worker persists the
  // latest sweep to KV under "sanity_sweep:latest" (and "sanity_sweep:
  // fast:latest"). The bridge KV is the same namespace, so we can read
  // it directly. Renders in the digest as "System: 13/14 checks ok ·
  // 1 warn · 0 fail" with any failing/warning check names listed.
  let sanitySummary = null;
  try {
    const kv = env?.BRIDGE_KV || env?.KV_TIMED;
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
    sanity_summary: sanitySummary,
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
    const side = String(t.side || "").toUpperCase();
    const qty = Number(t.qty) || 0;
    const px = t.price_target != null ? ` @ $${Number(t.price_target).toFixed(2)}` : "";
    return `  ${side} ${qty} ${t.ticker}${px}`;
  });
  const positionLines = (digest.positions || []).slice(0, 30).map(p => {
    const qty = Number(p.qty ?? p.position ?? p.quantity) || 0;
    const pnl = Number(p.unrealizedPnl ?? p.unrealized_pnl) || 0;
    const sign = pnl >= 0 ? "+" : "";
    return `  ${String(p.symbol || p.ticker || "?").toUpperCase()}  ${qty} sh  ${sign}$${pnl.toFixed(2)}`;
  });
  const watchLines = (digest.open_trades || []).slice(0, 15).map(t =>
    `  ${t.ticker} · ${t.mode}/${t.instrument_type}${t.options_structure ? `:${t.options_structure}` : ""} · ${t.sync_state}`,
  );

  const text = [
    subject,
    "",
    "═══════════════════════════════════════════════",
    `EXECUTED TODAY (${digest.executed.length})`,
    "═══════════════════════════════════════════════",
    ...(tradeLines.length > 0 ? tradeLines : ["  (no fills)"]),
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
    // 2026-06-02 — Sanity-sweep summary so the operator/user wakes up
    // knowing the system is green (or knows exactly what's red).
    ...(digest.sanity_summary ? [
      "═══════════════════════════════════════════════",
      "SYSTEM HEALTH (sanity sweep)",
      "═══════════════════════════════════════════════",
      `  ${digest.sanity_summary.ok_count} checks ok · ${digest.sanity_summary.warn_count} warn · ${digest.sanity_summary.fail_count} fail${digest.sanity_summary.age_minutes != null ? ` (sweep ${digest.sanity_summary.age_minutes}min old)` : ""}`,
      ...(digest.sanity_summary.failing_checks || []).map(c => `  FAIL ${c.label} — ${c.anomaly}`),
      ...(digest.sanity_summary.warning_checks || []).slice(0, 4).map(c => `  WARN ${c.label} — ${c.anomaly}`),
      "",
    ] : []),
    "═══════════════════════════════════════════════",
    "QUICK LINKS",
    "═══════════════════════════════════════════════",
    "  → Audit log:      https://timed-trading.com/account/brokers#audit",
    "  → Pause mirror:   https://timed-trading.com/account/brokers",
    "  → Daily brief:    https://timed-trading.com/today",
    "",
    "— The Timed Trading System",
    "",
    "This digest is sent because a broker account is connected to",
    "Timed Trading. To stop these digests: settings → email preferences",
    "→ daily account digest.",
  ].filter(Boolean).join("\n");

  const _esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:#1f2937;max-width:640px">
    <h2 style="margin:0 0 8px">Account today</h2>
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
 * Drain the bridge_notify queue. Caller (main worker email cron)
 * coalesces items per user into one Mirror Sync digest and sends.
 *
 * Returns Array<{user_id, severity, event?, content, ...}> ready to send.
 */
export async function drainNotifyQueue(env, { limit = 200, peek = false } = {}) {
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
      // One-shot delete after read — unless peek/preview (send=false).
      if (!peek) await KV.delete(k.name).catch(() => {});
    }
    return out;
  } catch (e) {
    console.warn("[NOTIFY] drainQueue failed:", String(e?.message || e).slice(0, 200));
    return [];
  }
}
