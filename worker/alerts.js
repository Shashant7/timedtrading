// Alerts module — Discord notifications and proactive alert generation

import {
  BROAD_INDEX_TICKERS,
  evaluateBroadIndexExtensionWatch,
  evaluateBroadIndexCompressionWatch,
} from "./timing-signals.js";
import { computeInvestorActionTier } from "./investor.js";

// ─────────────────────────────────────────────────────────────────────────────
// notifyDiscord LANE ROUTING — 2026-05-28
// ─────────────────────────────────────────────────────────────────────────────
// Three lanes, three Discord channels:
//
//   lane="trade"    (default)  → DISCORD_WEBHOOK_URL            (#trade-signals)
//   lane="general"             → DISCORD_GENERAL_WEBHOOK_URL    (#general)
//   lane="system"              → DISCORD_SYSTEM_WEBHOOK_URL     (#system-alerts)
//
// Trade lane = model-initiated trade lifecycle (Active Trader + Investor):
//   TRADE_ENTRY / TRADE_TRIM / TRADE_EXIT / KANBAN_DEFEND / KANBAN_*,
//   INVESTOR position_trim / position_close / accumulate / thesis alerts.
//
// General lane = editorial / research pulses traders read in #general:
//   Daily Brief (morning + evening), Intraday Pulse, Market Intel (research desk).
//
// System lane = ops noise an operator (not a trader) cares about:
//   cron failures / candle staleness / migration completions /
//   ingest health / reconciliation diffs / config integrity warnings /
//   AI CIO health probes / vision-mismatch warnings.
//
// If a lane-specific webhook is unset, fall back: general → trade,
// system → trade. If DISCORD_WEBHOOK_URL is unset, skip with
// reason="missing_webhook".
//
// Callers tag their lane explicitly: `notifyDiscord(env, embed, "system")`.
// Default is "trade" so existing untagged callers are unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/** Send Discord notification with embed card styling. */
export async function notifyDiscord(env, embed, lane = "trade") {
  const discordEnable = env.DISCORD_ENABLE || "false";
  if (discordEnable !== "true") {
    console.log(
      `[DISCORD] Notifications disabled (DISCORD_ENABLE="${discordEnable}", expected "true")`,
    );
    return { ok: false, skipped: true, reason: "disabled" };
  }

  // Lane → webhook URL resolution
  const _laneRaw = String(lane || "trade").toLowerCase();
  const _laneNorm = _laneRaw === "system" ? "system" : (_laneRaw === "general" ? "general" : "trade");
  const _systemUrl = env.DISCORD_SYSTEM_WEBHOOK_URL || null;
  const _generalUrl = env.DISCORD_GENERAL_WEBHOOK_URL || null;
  const _tradeUrl = env.DISCORD_WEBHOOK_URL || null;
  const url = _laneNorm === "system"
    ? (_systemUrl || _tradeUrl)
    : _laneNorm === "general"
      ? (_generalUrl || _tradeUrl)
      : _tradeUrl;
  // 2026-06-10 — Make lane fallbacks VISIBLE. After the worker
  // decomposition, each dedicated worker (tt-engine / tt-research)
  // carries its own webhook secrets; a missing lane secret silently
  // dumped that lane's content into #trade-signals via the fallback,
  // and a wrong-valued secret misroutes with no trace. This log turns
  // "alerts are going to the wrong channel" from a guess into a
  // one-line wrangler-tail diagnosis.
  if (_laneNorm !== "trade" && url === _tradeUrl && _tradeUrl) {
    console.warn(
      `[DISCORD] lane="${_laneNorm}" FALLBACK → trade webhook (set ${_laneNorm === "system" ? "DISCORD_SYSTEM_WEBHOOK_URL" : "DISCORD_GENERAL_WEBHOOK_URL"} on THIS worker to route correctly)`,
    );
  }
  if (!url) {
    console.log(
      `[DISCORD] No webhook URL for lane="${_laneNorm}" (DISCORD_WEBHOOK_URL=${_tradeUrl ? "set" : "missing"}, DISCORD_GENERAL_WEBHOOK_URL=${_generalUrl ? "set" : "missing"}, DISCORD_SYSTEM_WEBHOOK_URL=${_systemUrl ? "set" : "missing"})`,
    );
    return { ok: false, skipped: true, reason: "missing_webhook", lane: _laneNorm };
  }

  console.log(`[DISCORD lane=${_laneNorm}] Sending: ${embed.title || "Untitled"}`);
  // V15 P0.7.31 (2026-04-30) — Discord webhook avatar + username.
  // 2026-05-28 — Default avatar URL was pointing at /logo-512.png which
  // returns the SPA HTML fallback (Discord then renders its generic
  // default avatar). Switched to the actually-served /logo-discord.png
  // (256x256 PNG, 50 KB, generated from logo.png at build time).
  // System lane gets a different username so it's visually distinct
  // from trade messages even before reading the title.
  const _baseName = env.DISCORD_WEBHOOK_USERNAME || "Timed Trading";
  const _webhookUsername = _laneNorm === "system"
    ? `${_baseName} • Ops`
    : _laneNorm === "general"
      ? `${_baseName} • Intel`
      : _baseName;
  // 2026-05-29 — Discord caches webhook avatars by URL. The system-lane
  // bot kept showing an older avatar even after the source PNG was
  // updated, so we bump a version query param to force a re-fetch.
  // Lane gets its own URL too so trade vs system avatars can diverge
  // if the user ever wants distinct icons.
  const _avatarBase = env.DISCORD_WEBHOOK_AVATAR_URL
    || "https://timed-trading.com/logo-discord.png";
  const _avatarVer = _laneNorm === "system" ? "v3-ops" : (_laneNorm === "general" ? "v3-general" : "v3-trade");
  const _webhookAvatarUrl = `${_avatarBase}${_avatarBase.includes("?") ? "&" : "?"}v=${_avatarVer}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: _webhookUsername,
        avatar_url: _webhookAvatarUrl,
        embeds: [embed],
      }),
    });
    if (!response.ok) {
      const responseText = await response
        .text()
        .catch(() => "Unable to read response");
      console.error(
        `[DISCORD] Failed to send notification: ${response.status} ${response.statusText}`,
        { responseText: responseText.substring(0, 200) },
      );
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        responseText: responseText.substring(0, 200),
        lane: _laneNorm,
      };
    }
    console.log(
      `[DISCORD lane=${_laneNorm}] ✅ Notification sent: ${embed.title || "Untitled"}`,
    );
    return { ok: true, status: response.status, lane: _laneNorm };
  } catch (error) {
    console.error(`[DISCORD lane=${_laneNorm}] Error sending notification:`, {
      error: String(error),
      message: error.message,
      stack: error.stack,
    });
    return { ok: false, error: String(error), message: error.message, lane: _laneNorm };
  }
}

/**
 * 2026-06-01 — Direct-message a Discord user via the TT bot (not a webhook).
 *
 * Why this exists: webhooks can only post into channels, not DMs. For
 * per-user notifications (e.g. mirror-sync drift critical-tier alerts to
 * the broker-account owner) we want the message in the user's inbox, not
 * in a shared #ops channel. The TT bot already runs with full guild
 * privileges (subscriber-role management) so we have the bot token; we
 * just open a DM channel + post into it.
 *
 * Prerequisites for the user to actually receive the DM:
 *   1. They've linked Discord via the existing OAuth flow (stored as
 *      `users.discord_id` in D1).
 *   2. They share at least one guild with the TT bot AND have "Allow
 *      direct messages from server members" enabled (Discord default
 *      is ON). If they've disabled it, this call returns HTTP 403
 *      `Cannot send messages to this user` — we log + skip.
 *   3. The bot has the `applications.commands` + `bot` scope (already
 *      true — same scope set used for `discordAddMemberAndRole`).
 *
 * Two-step Discord API flow:
 *   1. POST /users/@me/channels { recipient_id } → returns DM channel
 *      (creates one if it doesn't exist; idempotent).
 *   2. POST /channels/{channel_id}/messages with the payload.
 *
 * @param {object} env  Worker env (needs DISCORD_BOT_TOKEN)
 * @param {string} discordUserId  The user's Discord ID from D1
 *                                (`users.discord_id` after OAuth link)
 * @param {object} payload  Discord message payload — must have ONE of:
 *                          - content (plain string)
 *                          - embeds (array of embed objects)
 *                          May also include `components` for buttons.
 * @returns {Promise<{ok, status, channel_id?, error?, skipped?}>}
 */
export async function discordDmUser(env, discordUserId, payload) {
  const botToken = env?.DISCORD_BOT_TOKEN;
  if (!botToken) {
    return { ok: false, skipped: true, reason: "no_bot_token" };
  }
  if (!discordUserId) {
    return { ok: false, skipped: true, reason: "no_discord_user_id" };
  }
  if (!payload || (typeof payload !== "object")) {
    return { ok: false, skipped: true, reason: "empty_payload" };
  }
  try {
    // Step 1 — open / look up the DM channel for this user.
    const chanResp = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: {
        "Authorization": `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: String(discordUserId) }),
    });
    if (!chanResp.ok) {
      const errText = await chanResp.text().catch(() => "");
      console.warn(`[DISCORD_DM] open channel failed for ${discordUserId}: ${chanResp.status} ${errText.slice(0, 200)}`);
      return {
        ok: false, status: chanResp.status,
        error: `open_channel_${chanResp.status}: ${errText.slice(0, 200)}`,
      };
    }
    const chan = await chanResp.json().catch(() => null);
    const channelId = chan?.id;
    if (!channelId) {
      return { ok: false, error: "no_channel_id_in_response" };
    }

    // Step 2 — post the message.
    const msgResp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!msgResp.ok) {
      const errText = await msgResp.text().catch(() => "");
      // 50007 = Cannot send messages to this user (DMs disabled or
      // not in a shared guild). Surface explicitly so the caller can
      // fall back to email-only without alarming the operator.
      const dmsDisabled = msgResp.status === 403 && errText.includes("50007");
      console.warn(`[DISCORD_DM] send failed for ${discordUserId}: ${msgResp.status} ${errText.slice(0, 200)}`);
      return {
        ok: false, status: msgResp.status,
        channel_id: channelId,
        error: dmsDisabled
          ? "dms_disabled_by_user"
          : `send_${msgResp.status}: ${errText.slice(0, 200)}`,
        dms_disabled: dmsDisabled,
      };
    }
    console.log(`[DISCORD_DM] sent to ${discordUserId}`);
    return { ok: true, status: msgResp.status, channel_id: channelId };
  } catch (e) {
    console.warn(`[DISCORD_DM] error for ${discordUserId}:`, String(e?.message || e).slice(0, 200));
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * P0.7.154 (2026-05-14) — record a cron / system failure with a forensic
 * trail. Writes a tombstone to KV (so the operator can grep "what failed
 * recently?") and fires a Discord alert (so the operator hears about it
 * within the hour, not when a customer reports it).
 *
 * Both writes are best-effort — if KV is wedged or Discord is down, this
 * helper still returns; never blocks the caller.
 *
 * Tombstone format (KV key `timed:cron:failure:{op}`):
 *   { op, error, ts, caller, count }   // count auto-increments per op
 *
 * `op` should be a short stable label like "investor_hourly" or
 * "daily_brief" — it's used as the KV key suffix.
 */
/**
 * Normalized error signature for dedup: digits are volatile (counts,
 * percentages, ticker tallies), so `Excluded 99/291 (34%)` and
 * `Excluded 221/291 (76%)` are the SAME failure shape. A6 (2026-07-03):
 * the raw string compare paged twice for the Jul 2 incident because the
 * escalating count changed the message every invocation.
 */
export function cronErrorSignature(error) {
  return String(error || "").replace(/\d+(\.\d+)?/g, "#");
}

/** OpenAI billing/quota exhaustion (429 + insufficient_quota / billing copy). */
export function isOpenAiQuotaError(error) {
  const s = String(error || "").toLowerCase();
  if (s === "openai_quota_exceeded") return true;
  return (s.includes("openai 429") || s.includes("openai_quota"))
    && (
      s.includes("quota")
      || s.includes("insufficient_quota")
      || s.includes("billing")
      || s.includes("exceeded your current")
    );
}

/** OpenAI transient rate limit (429 without quota/billing wording). */
export function isOpenAiRateLimitError(error) {
  const s = String(error || "").toLowerCase();
  if (s === "openai_rate_limited") return true;
  return s.includes("openai 429") && !isOpenAiQuotaError(error);
}

/**
 * Normalize AI brief cron errors so quota/rate-limit outages read as
 * billing/degraded skips — not infra failures that page #system-alerts.
 */
export function normalizeBriefCronError(error) {
  if (isOpenAiQuotaError(error)) {
    return {
      error: "openai_quota_exceeded — AI brief skipped (top up OpenAI billing)",
      skipDiscord: true,
      degraded: true,
    };
  }
  if (isOpenAiRateLimitError(error)) {
    return {
      error: "openai_rate_limited — AI brief skipped (retry next slot)",
      skipDiscord: true,
      degraded: true,
    };
  }
  return {
    error: String(error || "unknown").slice(0, 500),
    skipDiscord: false,
    degraded: false,
  };
}

/**
 * Severity band for count-bearing errors: first percentage in the message
 * mapped to 0 (<25%) / 1 (>=25%) / 2 (>=50%) / 3 (>=75%). Null when the
 * message has no percentage. A band INCREASE re-pages even when the
 * normalized signature is unchanged — a 34%→76% regression is materially
 * worse and the operator should hear about it; 34%→38% chatter is not.
 */
export function cronErrorSeverityBand(error) {
  const m = String(error || "").match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct)) return null;
  return pct >= 75 ? 3 : pct >= 50 ? 2 : pct >= 25 ? 1 : 0;
}

export async function recordCronFailure(env, opts) {
  const op = String(opts?.op || "unknown").slice(0, 64).replace(/[^a-z0-9_]/gi, "_");
  const error = String(opts?.error || "").slice(0, 500);
  const caller = String(opts?.caller || "").slice(0, 200) || null;
  const ts = Date.now();

  // 1. KV tombstone (with auto-incrementing count per op)
  let count = 1;
  let prev = null;
  try {
    const KV = env?.KV_TIMED;
    if (KV) {
      const key = `timed:cron:failure:${op}`;
      try { prev = await KV.get(key, "json"); } catch {}
      count = (Number(prev?.count) || 0) + 1;
      const tombstone = { op, error, ts, caller, count, last_ok_ts: prev?.last_ok_ts || null };
      try {
        await KV.put(key, JSON.stringify(tombstone), { expirationTtl: 7 * 86400 });
      } catch {}
    }
  } catch {}

  // 2. Discord alert (best-effort) — system lane
  // Cron failures are ops noise, not trader-actionable. Route to the
  // system-alerts channel so the trade channel stays clean.
  // Dedup (2026-06-17 noise report, refined 2026-07-03 / plan A6): page on
  //   - the first failure of a run (count === 1), or
  //   - a NORMALIZED signature change (digits stripped — a different failure
  //     shape, not the same failure with a different count), or
  //   - a severity-band escalation (25/50/75% thresholds) for count-bearing
  //     errors. De-escalation and recovery are signaled by recordCronSuccess,
  //     not by another page.
  try {
    const sig = cronErrorSignature(error);
    const prevSig = prev?.error ? cronErrorSignature(prev.error) : null;
    const sigChanged = prevSig === null || prevSig !== sig;
    const band = cronErrorSeverityBand(error);
    const prevBand = prev?.error ? cronErrorSeverityBand(prev.error) : null;
    const bandEscalated = band !== null && prevBand !== null && band > prevBand;
    if (!opts?.skipDiscord && (count === 1 || sigChanged || bandEscalated)) {
      await notifyDiscord(env, {
        title: `⚠️ Cron Failure: ${op}`,
        description: `\`${error}\``,
        color: 0xef4444,
        timestamp: new Date(ts).toISOString(),
        footer: { text: `${caller ? `caller=${caller}` : "no caller"}${bandEscalated ? " · severity escalated" : ""}` },
      }, "system");
    }
  } catch {}

  return { ok: true, op, ts };
}

/**
 * Mirror of recordCronFailure that records a successful run. Resets the
 * KV tombstone count and stamps `last_ok_ts` so persistent-failure
 * detection later can compute "how long has this been broken?".
 */
export async function recordCronSuccess(env, op) {
  try {
    const KV = env?.KV_TIMED;
    if (!KV) return;
    const safe = String(op || "unknown").slice(0, 64).replace(/[^a-z0-9_]/gi, "_");
    const key = `timed:cron:failure:${safe}`;
    let prev = null;
    try { prev = await KV.get(key, "json"); } catch {}
    if (!prev || (prev.count || 0) === 0) return;
    await KV.put(key, JSON.stringify({
      op: safe, error: null, ts: prev.ts, caller: prev.caller,
      count: 0, last_ok_ts: Date.now(),
    }), { expirationTtl: 7 * 86400 });
  } catch {}
}

/** Get Discord alert mode: "critical" (default) or "all". */
export function getDiscordAlertMode(env) {
  const raw = String(env?.DISCORD_ALERT_MODE || "critical")
    .trim()
    .toLowerCase();
  return raw === "all" ? "all" : "critical";
}

/** Whether to send a Discord alert for the given type and context. */
export function shouldSendDiscordAlert(env, type, ctx = {}) {
  const mode = getDiscordAlertMode(env);
  if (mode === "all") return true;
  const t = String(type || "").toUpperCase();

  if (t === "TRADE_EXIT") return true;

  if (t === "TRADE_TRIM") {
    /* P0.7.129 (2026-05-11) — User report: 'Activity Feed and
       Notification Feed have more events than Discord.' The previous
       critical-mode filter required total trimmed ≥ 50% OR delta ≥ 20%
       to send a Discord alert, which suppressed the small step-trims
       (0.1% / 0.5%) the engine fires for defensive risk management.
       Those trims STILL appeared in the activity feed and notifications,
       creating an unexplained gap.
       New rule: send every TRIM that delivers ANY meaningful realized
       movement (delta ≥ 1% of position OR total ≥ 10%). Sub-1% delta
       trims (typically score-recalibration noise) are still skipped to
       avoid spamming Discord. The 1-minute KV dedupe in
       `shouldSendTradeDiscordEvent` continues to coalesce rapid-fire
       trims on the same trade. */
    const rawTotal = Number(ctx.newTrimmedPct);
    const rawDelta = Number(ctx.trimDeltaPctRaw);
    const total =
      Number.isFinite(rawTotal) && rawTotal > 1 ? rawTotal / 100 : rawTotal;
    const delta =
      Number.isFinite(rawDelta) && Math.abs(rawDelta) > 1
        ? rawDelta / 100
        : rawDelta;
    if (Number.isFinite(total) && total >= 0.10) return true;        // total ≥ 10%
    if (Number.isFinite(delta) && Math.abs(delta) >= 0.01) return true; // delta ≥ 1%
    return false;
  }

  if (t === "TRADE_ENTRY") {
    // 2026-05-27 (PR #328) — Always alert on entry.
    //
    // User report: 'I see the Active Trader Lane has GS as an open
    // trade and in Defend lane. But I did not see any alert for it,
    // it is not in the activity stream nor discord.'
    //
    // Root cause: this filter previously required rank≥80 AND rr≥2.0
    // (or momentum_elite path rank≥75 + rr≥1.6) for the Discord alert
    // to fire. GS entered below those thresholds → Discord suppressed.
    // Combined with the user's observation that the activity strip was
    // also missing the entry (separate but related visibility gap),
    // entries below the 'critical' threshold became invisible.
    //
    // The 'critical_only' mode was originally designed to reduce noise
    // when Discord alerts were dispatched for many event types. But
    // TRADE_ENTRY is bounded (~3-10 entries/day max) — spam isn't a
    // concern — and visibility into EVERY trade is more valuable than
    // skipping low-rank ones. Matches the TRADE_EXIT semantic above
    // which always returns true.
    return true;
  }

  // Kanban lane transitions (aligned with 7-lane system)
  if (t === "KANBAN_ENTER") return true;
  if (t === "KANBAN_ENTER_NOW") return true; // Legacy alias → maps to KANBAN_ENTER
  if (t === "KANBAN_DEFEND") return true;
  if (t === "KANBAN_TRIM") return true;
  if (t === "KANBAN_EXIT") return true;

  // Deprecated: folded into kanban/trade embeds
  if (t === "KANBAN_JUST_ENTERED") return false; // Redundant with TRADE_ENTRY
  if (t === "FLIP_WATCH") return false;
  if (t === "TDSEQ_DEFENSE") return false;          // Folded into KANBAN_DEFEND
  if (t === "TD9_EXIT") return false;                // Folded into TRADE_EXIT
  if (t === "TD9_ENTRY") return false;               // Folded into KANBAN_ENTER
  if (t === "SYSTEM") return false;
  if (t === "ALERT_ENTRY") return false;             // Folded into KANBAN_ENTER

  return false;
}

/** Generate proactive alerts from tickers and trades (TP approaching, SL approaching, etc.). */
export function generateProactiveAlerts(allTickers, allTrades) {
  const alerts = [];

  const openTrades = allTrades.filter(
    (t) => t.status === "OPEN" || t.status === "TP_HIT_TRIM",
  );

  openTrades.forEach((trade) => {
    const currentPrice = Number(trade.currentPrice || trade.entryPrice || 0);
    const tp = Number(trade.tp || 0);
    const sl = Number(trade.sl || 0);
    const entryPrice = Number(trade.entryPrice || 0);
    const direction = trade.direction || "LONG";

    if (tp > 0 && currentPrice > 0 && sl > 0 && entryPrice > 0) {
      let pctToTP = 0;
      if (direction === "LONG") {
        const distanceToTP = tp - currentPrice;
        const totalDistance = tp - entryPrice;
        pctToTP = totalDistance > 0 ? (distanceToTP / totalDistance) * 100 : 0;
      } else {
        const distanceToTP = currentPrice - tp;
        const totalDistance = entryPrice - tp;
        pctToTP = totalDistance > 0 ? (distanceToTP / totalDistance) * 100 : 0;
      }
      if (pctToTP > 0 && pctToTP <= 5) {
        alerts.push({
          type: "TP_APPROACHING",
          priority: "high",
          ticker: trade.ticker,
          message: `${trade.ticker} is within ${pctToTP.toFixed(1)}% of TP ($${tp.toFixed(2)}). Current: $${currentPrice.toFixed(2)}. Consider trimming 50% at TP.`,
          currentPrice,
          tp,
          pctToTP,
        });
      }
    }
  });

  openTrades.forEach((trade) => {
    const currentPrice = Number(trade.currentPrice || trade.entryPrice || 0);
    const sl = Number(trade.sl || 0);
    const entryPrice = Number(trade.entryPrice || 0);
    const direction = trade.direction || "LONG";

    if (sl > 0 && currentPrice > 0 && entryPrice > 0) {
      let pctToSL = 0;
      if (direction === "LONG") {
        const distanceToSL = currentPrice - sl;
        const totalDistance = entryPrice - sl;
        pctToSL = totalDistance > 0 ? (distanceToSL / totalDistance) * 100 : 0;
      } else {
        const distanceToSL = sl - currentPrice;
        const totalDistance = sl - entryPrice;
        pctToSL = totalDistance > 0 ? (distanceToSL / totalDistance) * 100 : 0;
      }
      if (pctToSL > 0 && pctToSL <= 5) {
        alerts.push({
          type: "SL_APPROACHING",
          priority: "high",
          ticker: trade.ticker,
          message: `⚠️ ${trade.ticker} is within ${pctToSL.toFixed(1)}% of SL ($${sl.toFixed(2)}). Current: $${currentPrice.toFixed(2)}. Monitor closely.`,
          currentPrice,
          sl,
          pctToSL,
        });
      }
    }
  });

  allTickers.forEach((ticker) => {
    const matchingTrade = openTrades.find((t) => t.ticker === ticker.ticker);
    if (matchingTrade && ticker.completion > 0.8) {
      alerts.push({
        type: "HIGH_COMPLETION",
        priority: "medium",
        ticker: ticker.ticker,
        message: `${ticker.ticker} has reached ${(ticker.completion * 100).toFixed(0)}% completion. Consider trimming 50-75% to lock in profits.`,
        completion: ticker.completion,
      });
    }
  });

  allTickers.forEach((ticker) => {
    const matchingTrade = openTrades.find((t) => t.ticker === ticker.ticker);
    if (matchingTrade && ticker.phase_pct > 0.75) {
      alerts.push({
        type: "LATE_PHASE",
        priority: "medium",
        ticker: ticker.ticker,
        message: `${ticker.ticker} is in late phase (${(ticker.phase_pct * 100).toFixed(0)}%). Risk of reversal increasing. Consider trimming or tightening stops.`,
        phasePct: ticker.phase_pct,
      });
    }
  });

  const newPrimeSetups = allTickers.filter(
    (t) =>
      t.rank >= 75 &&
      t.rr >= 1.5 &&
      t.completion < 0.4 &&
      t.phase_pct < 0.6 &&
      !openTrades.find((ot) => ot.ticker === t.ticker),
  );
  if (newPrimeSetups.length > 0) {
    alerts.push({
      type: "NEW_OPPORTUNITY",
      priority: "high",
      ticker: "MULTIPLE",
      message: `🎯 ${newPrimeSetups.length} new prime setups detected: ${newPrimeSetups.slice(0, 5).map((t) => t.ticker).join(", ")}. Consider monitoring for entry.`,
      setups: newPrimeSetups.slice(0, 5).map((t) => ({
        ticker: t.ticker,
        rank: t.rank,
        rr: t.rr,
      })),
    });
  }

  const momentumEliteSetups = allTickers.filter(
    (t) =>
      t.flags?.momentum_elite &&
      t.rank >= 70 &&
      !openTrades.find((ot) => ot.ticker === t.ticker),
  );
  if (momentumEliteSetups.length > 0) {
    alerts.push({
      type: "MOMENTUM_ELITE",
      priority: "high",
      ticker: "MULTIPLE",
      message: `🚀 ${momentumEliteSetups.length} Momentum Elite setups available: ${momentumEliteSetups.slice(0, 5).map((t) => t.ticker).join(", ")}. High-quality opportunities.`,
      setups: momentumEliteSetups.slice(0, 5).map((t) => ({
        ticker: t.ticker,
        rank: t.rank,
        rr: t.rr,
      })),
    });
  }

  const indexSnapshots = {};
  allTickers.forEach((t) => {
    const sym = String(t?.ticker || "").toUpperCase();
    if (BROAD_INDEX_TICKERS.has(sym)) indexSnapshots[sym] = t;
  });
  const indexWatch = evaluateBroadIndexExtensionWatch(indexSnapshots);
  if (indexWatch.active) {
    alerts.push({
      type: "INDEX_EXTENSION_WATCH",
      priority: "high",
      ticker: "INDEX",
      message: indexWatch.headline || "Broad index extension watch active — trim winners, stage puts on confirm.",
      breadth: indexWatch.breadth,
      avg_score: indexWatch.avg_score,
      detail: indexWatch.detail,
    });
  }

  const compressionWatch = evaluateBroadIndexCompressionWatch(indexSnapshots);
  if (compressionWatch.active) {
    alerts.push({
      type: "INDEX_COMPRESSION_WATCH",
      priority: "high",
      ticker: "INDEX",
      message: compressionWatch.headline || "Broad index compression watch active — add on dips, stage calls on confirm.",
      breadth: compressionWatch.breadth,
      avg_score: compressionWatch.avg_score,
      detail: compressionWatch.detail,
    });
  }

  allTickers.forEach((ticker) => {
    const sym = String(ticker?.ticker || "").toUpperCase();
    const overlay = ticker?.timing_overlay;
    if (!overlay) return;

    if (overlay.trim_winners) {
      const matchingTrade = openTrades.find((tr) => tr.ticker === sym && (tr.direction || "LONG") === "LONG");
      if (matchingTrade) {
        const posture = overlay.posture || "CAUTION";
        if (posture === "DUMP_WATCH" || posture === "RISK_OFF" || (overlay.extension_score || 0) >= 50) {
          alerts.push({
            type: "TIMING_TRIM_WINNERS",
            priority: posture === "DUMP_WATCH" ? "high" : "medium",
            ticker: sym,
            message: `${sym} TIME THE TOP (${posture}, ${overlay.extension_score || 0}/100) — trim open LONG into strength. ${overlay.flash_detail || ""}`.trim(),
            extension_score: overlay.extension_score,
            posture,
          });
        }
      }
    }

    if (overlay.add_on_dips) {
      const matchingShort = openTrades.find((tr) => tr.ticker === sym && (tr.direction || "LONG") === "SHORT");
      if (matchingShort) {
        const posture = overlay.posture || "ACCUMULATE_CAUTION";
        if (posture === "RALLY_WATCH" || posture === "RISK_ON_BUY" || (overlay.compression_score || 0) >= 50) {
          alerts.push({
            type: "TIMING_ADD_ON_DIPS",
            priority: posture === "RALLY_WATCH" ? "high" : "medium",
            ticker: sym,
            message: `${sym} TIME THE BOTTOM (${posture}, ${overlay.compression_score || 0}/100) — cover shorts / add LONG on weakness. ${overlay.flash_detail || ""}`.trim(),
            compression_score: overlay.compression_score,
            posture,
          });
        }
      }
    }
  });

  return alerts.sort((a, b) => {
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    return priorityOrder[b.priority] - priorityOrder[a.priority];
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
// INVESTOR ALERTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a weekly investor digest Discord embed.
 *
 * @param {object} opts
 * @param {object} marketHealth - { score, regime, breadth }
 * @param {object} prevMarketHealth - previous week's market health (or null)
 * @param {object[]} stageChanges - [{ ticker, from, to }]
 * @param {object[]} topAccumulate - [{ ticker, score, rsRank }]
 * @param {object} sectorRotation - { improved: [], declined: [] }
 * @param {object} portfolioSummary - { totalValue, weeklyChangePct, bestTicker, worstTicker }
 * @returns {object} Discord embed
 */
export function createWeeklyDigestEmbed({
  marketHealth = {},
  prevMarketHealth = null,
  stageChanges = [],
  topAccumulate = [],
  sectorRotation = {},
  portfolioSummary = null,
}) {
  const color = marketHealth.regime === "RISK_ON" ? 0x10b981
    : marketHealth.regime === "RISK_OFF" ? 0xef4444
    : 0xf59e0b;

  const healthDelta = prevMarketHealth
    ? `(${marketHealth.score > prevMarketHealth.score ? "+" : ""}${marketHealth.score - prevMarketHealth.score} from last week)`
    : "";

  const fields = [];

  // Market Health
  fields.push({
    name: "Market Health",
    value: `**${marketHealth.score || "—"}** / 100 — ${marketHealth.regime || "CAUTIOUS"} ${healthDelta}\n` +
      `Breadth: ${marketHealth.breadth?.pctAboveW200 || "—"}% above Weekly 200 EMA`,
    inline: false,
  });

  // Portfolio summary
  if (portfolioSummary) {
    const pnlEmoji = portfolioSummary.weeklyChangePct >= 0 ? "📈" : "📉";
    fields.push({
      name: `${pnlEmoji} Portfolio Summary`,
      value: `Value: $${(portfolioSummary.totalValue || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}\n` +
        `Weekly: ${portfolioSummary.weeklyChangePct >= 0 ? "+" : ""}${(portfolioSummary.weeklyChangePct || 0).toFixed(1)}%\n` +
        `Best: ${portfolioSummary.bestTicker || "—"} | Worst: ${portfolioSummary.worstTicker || "—"}`,
      inline: false,
    });
  }

  // Stage changes
  if (stageChanges.length > 0) {
    const changeLines = stageChanges.slice(0, 8).map(c => {
      const arrow = c.to === "accumulate" ? "🟢" : c.to === "reduce" ? "🔴" : c.to === "watch" ? "🟡" : "⚪";
      return `${arrow} **${c.ticker}**: ${c.from} → ${c.to}`;
    });
    if (stageChanges.length > 8) changeLines.push(`...and ${stageChanges.length - 8} more`);
    fields.push({
      name: "Stage Changes",
      value: changeLines.join("\n"),
      inline: false,
    });
  }

  // Top accumulate candidates
  if (topAccumulate.length > 0) {
    const lines = topAccumulate.slice(0, 5).map(t =>
      `**${t.ticker}** — Score ${t.score}, RS Rank ${t.rsRank || "—"}`
    );
    fields.push({
      name: "🎯 Top Accumulation Opportunities",
      value: lines.join("\n"),
      inline: false,
    });
  }

  // Sector rotation
  if (sectorRotation.improved?.length > 0 || sectorRotation.declined?.length > 0) {
    const lines = [];
    if (sectorRotation.improved?.length > 0) {
      lines.push(`📈 Improving: ${sectorRotation.improved.join(", ")}`);
    }
    if (sectorRotation.declined?.length > 0) {
      lines.push(`📉 Declining: ${sectorRotation.declined.join(", ")}`);
    }
    fields.push({
      name: "Sector Rotation",
      value: lines.join("\n"),
      inline: false,
    });
  }

  return {
    title: "📊 Weekly Investor Digest",
    description: `Your weekly summary for the week ending ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.`,
    color,
    fields,
    footer: { text: "Timed Trading — Investor Intelligence • Not financial advice" },
    timestamp: new Date().toISOString(),
  };
}

/* 2026-06-01 — Investor alert action helper.

   Operator: "Can we make them more apparent that it is an Investor
   Signal to accumulate or whichever signal it is. As you can tell, it
   seems vague on how one should react to these signals."

   Derives a single-word ACTION verb that the alert title + body can
   prominently surface, plus a plain-language one-line guide. The
   action is computed from (type, zoneType, score, rsRank) so it stays
   in lockstep with the engine's actual intent rather than asking the
   user to translate "Momentum-Runner Zone Confirmed" into "ok so
   what do I do?". */
export function deriveInvestorAlertAction(type, data = {}) {
  const sym = String(data?.ticker || "ticker").toUpperCase();
  if (type === "thesis_invalidation") {
    return {
      verb: "MODEL · REDUCE",
      color: "#ef4444",
      tone: "danger",
      one_liner: `The TT Investor model moved ${sym} to Reduce — one or more supporting conditions no longer hold. The model portfolio would trim or exit on the next rebalance cycle. Informational only; not investment advice.`,
    };
  }
  if (type === "accumulation_zone") {
    const z = String(data?.zoneType || "").toLowerCase();
    const score = Number(data?.score) || 0;
    const tier = data?.actionTier || computeInvestorActionTier({
      stage: "accumulate",
      score: data?.score,
      simEligible: data?.simEligible,
      accumZone: { inZone: data?.inZone !== false },
      position: data?.position || {},
    });
    const rebalanceReady = tier === "act_now" || tier === "ready";
    if (z === "momentum_runner" || z.includes("exhaustion") || z.includes("momentum_runner")) {
      return {
        verb: "MODEL · ON RADAR",
        color: "#f5c25c",
        tone: "watch",
        one_liner: `**${sym}** logged a ${z.replace(/_/g, " ")} zone (score ${score}/100). On Radar — the model monitors for a cleaner setup; rebalance adds only when execution-ready.`,
      };
    }
    if (rebalanceReady) {
      return {
        verb: "MODEL · QUEUE",
        color: "#10b981",
        tone: "buy",
        one_liner: `**${sym}** entered the Queue lane (score ${score}/100). The model portfolio may buy on the next hourly rebalance pass if still qualified — queue order is tranched (max 3 new names per session), so a name may wait several sessions. Not a manual buy order.`,
      };
    }
    return {
      verb: "MODEL · ON RADAR",
      color: "#f5c25c",
      tone: "watch",
      one_liner: `**${sym}** entered a buy zone (score ${score}/100) but is not rebalance-ready yet — shown on Radar until trend alignment confirms.`,
    };
  }
  if (type === "rs_breakout") {
    return {
      verb: "MODEL · WATCH",
      color: "#3b82f6",
      tone: "info",
      one_liner: `${sym} relative strength hit a new ${data?.period || "3-month"} high vs SPY in the TT model. RS alone is not an entry trigger — the model waits for an accumulation zone or pullback setup.`,
    };
  }
  if (type === "rebalancing") {
    return {
      verb: "MODEL · REVIEW",
      color: "#f59e0b",
      tone: "info",
      one_liner: "The TT Investor model portfolio composition drifted from its targets. Review the dashboard suggestions — informational context only.",
    };
  }
  if (type === "position_open") {
    const val = Number(data.value) || (Number(data.shares) * Number(data.price));
    const valBit = Number.isFinite(val) && val > 0 ? ` · $${Math.round(val).toLocaleString()}` : "";
    return {
      verb: "MODEL · BOUGHT",
      color: "#10b981",
      tone: "buy",
      one_liner: `**${sym}** opened — ${data.shares ?? "?"} shares at $${Number(data.price || 0).toFixed(2)}${valBit}. Executed rebalance buy.`,
    };
  }
  if (type === "position_add") {
    return {
      verb: "MODEL · ADD",
      color: "#10b981",
      tone: "buy",
      one_liner: `**${sym}** scale-in — ${data.shares ?? "?"} shares at $${Number(data.price || 0).toFixed(2)}. Executed rebalance add.`,
    };
  }
  if (type === "position_trim") {
    return {
      verb: "MODEL · TRIMMED",
      color: "#f59e0b",
      tone: "warning",
      one_liner: `The TT Investor model portfolio trimmed ${data.shares ?? "?"} shares of ${sym} at $${Number(data.price || 0).toFixed(2)} — executed rebalance. Remaining size reflects the model's current lane.`,
    };
  }
  if (type === "position_close") {
    return {
      verb: "MODEL · EXITED",
      color: "#ef4444",
      tone: "danger",
      one_liner: `The TT Investor model portfolio closed ${sym} (${data.shares ?? "?"} shares at $${Number(data.price || 0).toFixed(2)}). Model lane is now Exited.`,
    };
  }
  return { verb: "MODEL · INFO", color: "#9ca3af", tone: "info", one_liner: "TT Investor model signal — informational only." };
}

/** Email/Discord masthead copy for accumulation-zone alerts — keyed off action tier. */
export function deriveInvestorAccumulationAlertCopy(data = {}, action = null) {
  const act = action || deriveInvestorAlertAction("accumulation_zone", data);
  const sym = String(data?.ticker || "ticker").toUpperCase();
  const score = Number(data?.score) || 0;
  const z = String(data?.zoneType || "").toLowerCase().replace(/_/g, " ");
  if (act.verb === "MODEL · QUEUE") {
    return {
      subjectBase: `${sym} — Entered Queue`,
      headline: "Entered Queue",
      lede: `<strong>${sym}</strong> entered the Queue lane (score ${score}/100). The model portfolio may buy on the next hourly rebalance pass if still qualified — not a manual buy order.`,
      ledePlain: `**${sym}** entered the Queue lane (score ${score}/100). The model portfolio may buy on the next hourly rebalance pass if still qualified — not a manual buy order.`,
    };
  }
  if (z.includes("momentum runner") || z.includes("exhaustion")) {
    return {
      subjectBase: `${sym} — On Radar (${z})`,
      headline: "On Radar — Zone Detected",
      lede: `<strong>${sym}</strong> logged a ${z} condition. On Radar — the model monitors for a cleaner setup; rebalance adds only when execution-ready.`,
      ledePlain: `**${sym}** logged a ${z} condition. On Radar — the model monitors for a cleaner setup; rebalance adds only when execution-ready.`,
    };
  }
  return {
    subjectBase: `${sym} — On Radar (Buy Zone Detected)`,
    headline: "On Radar — Buy Zone Detected",
    lede: `<strong>${sym}</strong> entered a buy zone (score ${score}/100) but is not rebalance-ready yet — shown on Radar until trend alignment confirms.`,
    ledePlain: `**${sym}** entered a buy zone (score ${score}/100) but is not rebalance-ready yet — shown on Radar until trend alignment confirms.`,
  };
}

/**
 * Create investor threshold alert embeds.
 *
 * @param {string} type - "thesis_invalidation" | "accumulation_zone" | "rs_breakout" | "rebalancing"
 * @param {object} data - alert-specific data
 * @returns {object} Discord embed
 */
export function createInvestorAlertEmbed(type, data) {
  /* 2026-06-01 — Prepend `INVESTOR · <ACTION>` to the title and add an
     Action field at the top of every embed so the reader instantly
     knows (a) this is the Investor system, not Trader, and (b) what
     the engine wants them to do. Operator feedback: title + body
     used to read as "Momentum-Runner Zone Confirmed" which is
     descriptive of the SETUP but says nothing about USER ACTION. */
  const _action = deriveInvestorAlertAction(type, data);
  const ALERT_CONFIGS = {
    thesis_invalidation: {
      color: 0xef4444,
      emoji: "⚠️",
      title: (d) => `${d.ticker}: Model Thesis Shift`,
      description: (d) => `The TT Investor model no longer sees valid supporting conditions for **${d.ticker}**.`,
      fields: (d) => d.reasons.map(r => ({ name: "Model invalidation", value: r, inline: false }))
        .concat(d.cio_reasoning ? [{ name: "AI CIO guidance", value: String(d.cio_reasoning).slice(0, 900), inline: false }] : []),
    },
    accumulation_zone: {
      color: 0x10b981,
      emoji: "🎯",
      title: (d) => {
        const copy = deriveInvestorAccumulationAlertCopy(d, _action);
        return `${d.ticker}: ${copy.headline}`;
      },
      description: (d) => deriveInvestorAccumulationAlertCopy(d, _action).ledePlain,
      fields: (d) => [
        { name: "Investor Score", value: `${d.score || "—"} / 100`, inline: true },
        { name: "Confidence", value: `${d.confidence || "—"}%`, inline: true },
        { name: "RS Rank", value: `${d.rsRank || "—"}th percentile`, inline: true },
        { name: "Zone Type", value: String(d.zoneType || "—").replace(/_/g, " "), inline: true },
        { name: "Signals", value: (d.signals || []).map(s => s.replace(/_/g, " ")).join(", ") || "—", inline: false },
        // Make it clear this is informational, not an auto-executed order.
        { name: "Note", value: "TT Investor model signal — the model portfolio tracks this in simulation. Informational only, not an executed order.", inline: false },
        ...(d.cio_reasoning ? [{ name: "AI CIO guidance", value: String(d.cio_reasoning).slice(0, 900), inline: false }] : []),
      ],
    },
    rs_breakout: {
      color: 0x3b82f6,
      emoji: "🚀",
      title: (d) => `${d.ticker}: Relative Strength Breakout`,
      description: (d) => `**${d.ticker}** relative strength line hit a new ${d.period || "3-month"} high vs SPY. Outperforming ${d.rsRank || "—"}% of the universe.`,
      fields: (d) => [
        { name: "RS Rank", value: `${d.rsRank || "—"}th percentile`, inline: true },
        { name: "3M Return vs SPY", value: `${d.rs3m >= 0 ? "+" : ""}${(d.rs3m || 0).toFixed(1)}%`, inline: true },
        { name: "Investor Score", value: `${d.score || "—"}`, inline: true },
        ...(d.cio_reasoning ? [{ name: "AI CIO guidance", value: String(d.cio_reasoning).slice(0, 900), inline: false }] : []),
      ],
    },
    rebalancing: {
      color: 0xf59e0b,
      emoji: "⚖️",
      title: () => "Portfolio Rebalancing Alert",
      description: () => "The TT Investor model portfolio composition drifted from its targets.",
      fields: (d) => (d.suggestions || []).map(s => ({
        name: s.type.replace(/_/g, " ").toUpperCase(),
        value: s.message,
        inline: false,
      })),
    },
    position_open: {
      color: 0x10b981,
      emoji: "🟢",
      title: (d) => `${d.ticker}: New Position Opened`,
      description: (d) => {
        const val = Number(d.value) || (Number(d.shares) * Number(d.price));
        const valBit = Number.isFinite(val) && val > 0 ? ` · $${Math.round(val).toLocaleString()}` : "";
        return `**${d.ticker}** — the model portfolio opened a new position (${Number(d.shares || 0).toFixed(2)} sh @ $${Number(d.price || 0).toFixed(2)}${valBit}). Executed rebalance buy.`;
      },
      fields: (d) => [
        { name: "Shares", value: `${Number(d.shares || 0).toFixed(2)}`, inline: true },
        { name: "Price", value: `$${Number(d.price || 0).toFixed(2)}`, inline: true },
        { name: "Value", value: `$${Number(d.value || (Number(d.shares) * Number(d.price)) || 0).toFixed(2)}`, inline: true },
        { name: "Stage", value: String(d.stage || "—").replace(/_/g, " "), inline: true },
        { name: "Investor Score", value: d.score != null ? `${d.score}/100` : "—", inline: true },
        { name: "Note", value: "Executed rebalance — model simulation fill, not a manual order.", inline: false },
        ...(d.cio_reasoning ? [{ name: "AI CIO guidance", value: String(d.cio_reasoning).slice(0, 900), inline: false }] : []),
      ],
    },
    position_add: {
      color: 0x10b981,
      emoji: "➕",
      title: (d) => `${d.ticker}: Position Added`,
      description: (d) => `**${d.ticker}** — scale-in executed by the Investor auto-rebalance engine (${Number(d.shares || 0).toFixed(2)} sh @ $${Number(d.price || 0).toFixed(2)}).`,
      fields: (d) => [
        { name: "Shares Added", value: `${Number(d.shares || 0).toFixed(2)}`, inline: true },
        { name: "Price", value: `$${Number(d.price || 0).toFixed(2)}`, inline: true },
        { name: "Value", value: `$${Number(d.value || (Number(d.shares) * Number(d.price)) || 0).toFixed(2)}`, inline: true },
        { name: "Stage", value: String(d.stage || "—").replace(/_/g, " "), inline: true },
        { name: "Investor Score", value: d.score != null ? `${d.score}/100` : "—", inline: true },
        { name: "Note", value: "Executed rebalance — model simulation fill, not a manual order.", inline: false },
        ...(d.cio_reasoning ? [{ name: "AI CIO guidance", value: String(d.cio_reasoning).slice(0, 900), inline: false }] : []),
      ],
    },
    position_trim: {
      color: 0xf59e0b,
      emoji: "🟠",
      title: (d) => `${d.ticker}: TRIMMED — partial reduce`,
      description: (d) => `**${d.ticker}** — partial reduce executed. Sold ${Number(d.shares || 0).toFixed(2)} sh @ $${Number(d.price || 0).toFixed(2)}. Position remains open at reduced size.`,
      fields: (d) => [
        { name: "Shares Sold", value: `${Number(d.shares || 0).toFixed(2)}`, inline: true },
        { name: "Price", value: `$${Number(d.price || 0).toFixed(2)}`, inline: true },
        { name: "Value", value: `$${Number(d.value || 0).toFixed(2)}`, inline: true },
        { name: "Realized P&L", value: d.pnl != null ? `$${Number(d.pnl).toFixed(2)}` : "—", inline: true },
        { name: "Remaining", value: d.remaining != null ? `${Number(d.remaining).toFixed(2)} sh` : "—", inline: true },
        { name: "Reason", value: String(d.reasonLabel || d.reason || "—").replace(/_/g, " "), inline: false },
        // 2026-06-11 — event-risk trims carry the concrete catalyst and,
        // when the AI CIO reviewed the trim, its reasoning — so a trim
        // into earnings reads as a considered decision, not a mechanical
        // one (operator feedback after the IWM/TWLO signals).
        ...(d.event_label ? [{ name: "Catalyst", value: String(d.event_label), inline: true }] : []),
        ...(d.cio_reasoning ? [{ name: "AI CIO review", value: String(d.cio_reasoning).slice(0, 900), inline: false }] : []),
      ],
    },
    position_close: {
      color: 0xef4444,
      emoji: "🔴",
      title: (d) => `${d.ticker}: EXITED — full close`,
      description: (d) => `**${d.ticker}** — full exit executed. Sold ${Number(d.shares || 0).toFixed(2)} sh @ $${Number(d.price || 0).toFixed(2)}. Model no longer holds this name.`,
      fields: (d) => [
        { name: "Shares Sold", value: `${Number(d.shares || 0).toFixed(2)}`, inline: true },
        { name: "Price", value: `$${Number(d.price || 0).toFixed(2)}`, inline: true },
        { name: "Value", value: `$${Number(d.value || 0).toFixed(2)}`, inline: true },
        { name: "Realized P&L", value: d.pnl != null ? `$${Number(d.pnl).toFixed(2)}` : "—", inline: true },
        { name: "Reason", value: String(d.reasonLabel || d.reason || "—").replace(/_/g, " "), inline: false },
        ...(Number(d.invalidation_price) > 0 ? [{ name: "Invalidation floor", value: `$${Number(d.invalidation_price).toFixed(2)}`, inline: true }] : []),
        ...(d.event_label ? [{ name: "Catalyst", value: String(d.event_label), inline: true }] : []),
        ...(d.cio_reasoning ? [{ name: "AI CIO review", value: String(d.cio_reasoning).slice(0, 900), inline: false }] : []),
      ],
    },
  };

  const config = ALERT_CONFIGS[type];
  if (!config) return null;

  // Prepend INVESTOR · <ACTION> to the title so it's instantly clear
  // this is an Investor-system alert (not Trader) AND what the engine
  // wants the user to do. The base title (e.g. "Momentum-Runner Zone
  // Confirmed") becomes the secondary line via title concatenation.
  const sym = String(data?.ticker || "").toUpperCase();
  const _baseTitle = config.title(data);
  const _shortHeadline = _baseTitle.replace(new RegExp(`^${sym}:\\s*`, "i"), "").trim();
  const _modeLabel = String(_action.verb || "").includes("QUEUE")
    || String(_action.verb || "").includes("BOUGHT")
    || String(_action.verb || "").includes("ADD")
    || String(_action.verb || "").includes("TRIMMED")
    || String(_action.verb || "").includes("EXITED")
    || String(_action.verb || "").includes("REDUCE")
    ? "DOING"
    : "WATCHING";
  const _actionTitle = `${config.emoji} **${sym}** · INVESTOR · ${_modeLabel} · ${_action.verb.replace(/^MODEL ·\s*/, "")}`;

  // Insert an Action field at the very top so the reader sees it before
  // scrolling. Skip it when its one-liner just restates the description
  // (accumulation_zone derives both from the same lede) — the title +
  // description already carry the action, so the extra field is noise.
  const _descText = String(config.description(data) || "").replace(/\*\*/g, "").trim().toLowerCase();
  const _oneLiner = String(_action.one_liner || "").replace(/\*\*/g, "").trim();
  const _oneLinerNorm = _oneLiner.toLowerCase();
  const _normalize = (s) => s.replace(/\(score[^)]*\)/g, "").replace(/[^a-z]+/g, " ").trim();
  const _redundant = type === "accumulation_zone"
    || (_oneLinerNorm.length > 0 && _normalize(_descText) === _normalize(_oneLinerNorm));
  const _fields = [
    ...(_redundant ? [] : [{
      name: `▶ ${sym} — ${_action.verb}`,
      value: _action.one_liner,
      inline: false,
    }]),
    ...config.fields(data),
  ];

  return {
    title: _actionTitle,
    description: config.description(data),
    color: type === "accumulation_zone"
      ? (_action.tone === "buy" ? 0x10b981 : _action.tone === "watch" ? 0xf5c25c : config.color)
      : (type === "position_open" || type === "position_add")
        ? 0x10b981
        : config.color,
    fields: _fields,
    footer: { text: "Timed Trading — Investor Intelligence • Not financial advice" },
    timestamp: new Date().toISOString(),
  };
}
