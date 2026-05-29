// Alerts module — Discord notifications and proactive alert generation

// ─────────────────────────────────────────────────────────────────────────────
// notifyDiscord LANE ROUTING — 2026-05-28
// ─────────────────────────────────────────────────────────────────────────────
// Two lanes, two Discord channels:
//
//   lane="trade"  (default)  → DISCORD_WEBHOOK_URL          (trade channel)
//   lane="system"            → DISCORD_SYSTEM_WEBHOOK_URL   (ops / noise)
//
// Trade lane = anything a trader cares about within a session:
//   TRADE_ENTRY / TRADE_TRIM / TRADE_EXIT / KANBAN_DEFEND / KANBAN_*
//   daily brief embeds / weekly investor digest / investor alerts.
//
// System lane = ops noise an operator (not a trader) cares about:
//   cron failures / candle staleness / migration completions /
//   ingest health / reconciliation diffs / config integrity warnings /
//   AI CIO health probes / vision-mismatch warnings.
//
// If DISCORD_SYSTEM_WEBHOOK_URL is unset, system messages fall back to
// the trade webhook (so nothing is dropped). If neither is set, the
// notification is skipped with reason="missing_webhook".
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
  const _laneNorm = String(lane || "trade").toLowerCase() === "system" ? "system" : "trade";
  const _systemUrl = env.DISCORD_SYSTEM_WEBHOOK_URL || null;
  const _tradeUrl = env.DISCORD_WEBHOOK_URL || null;
  // System messages prefer the system webhook; if unset, fall back to
  // the trade webhook (better noisy than dropped). Trade messages never
  // route to the system channel.
  const url = _laneNorm === "system"
    ? (_systemUrl || _tradeUrl)
    : _tradeUrl;
  if (!url) {
    console.log(
      `[DISCORD] No webhook URL for lane="${_laneNorm}" (DISCORD_WEBHOOK_URL=${_tradeUrl ? "set" : "missing"}, DISCORD_SYSTEM_WEBHOOK_URL=${_systemUrl ? "set" : "missing"})`,
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
  const _webhookUsername = _laneNorm === "system" ? `${_baseName} • Ops` : _baseName;
  // 2026-05-29 — Discord caches webhook avatars by URL. The system-lane
  // bot kept showing an older avatar even after the source PNG was
  // updated, so we bump a version query param to force a re-fetch.
  // Lane gets its own URL too so trade vs system avatars can diverge
  // if the user ever wants distinct icons.
  const _avatarBase = env.DISCORD_WEBHOOK_AVATAR_URL
    || "https://timed-trading.com/logo-discord.png";
  const _avatarVer = _laneNorm === "system" ? "v3-ops" : "v3-trade";
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
export async function recordCronFailure(env, opts) {
  const op = String(opts?.op || "unknown").slice(0, 64).replace(/[^a-z0-9_]/gi, "_");
  const error = String(opts?.error || "").slice(0, 500);
  const caller = String(opts?.caller || "").slice(0, 200) || null;
  const ts = Date.now();

  // 1. KV tombstone (with auto-incrementing count per op)
  try {
    const KV = env?.KV_TIMED;
    if (KV) {
      const key = `timed:cron:failure:${op}`;
      let prev = null;
      try { prev = await KV.get(key, "json"); } catch {}
      const count = (Number(prev?.count) || 0) + 1;
      const tombstone = { op, error, ts, caller, count, last_ok_ts: prev?.last_ok_ts || null };
      try {
        await KV.put(key, JSON.stringify(tombstone), { expirationTtl: 7 * 86400 });
      } catch {}
    }
  } catch {}

  // 2. Discord alert (best-effort) — system lane
  // Cron failures are ops noise, not trader-actionable. Route to the
  // system-alerts channel so the trade channel stays clean.
  try {
    if (!opts?.skipDiscord) {
      await notifyDiscord(env, {
        title: `⚠️ Cron Failure: ${op}`,
        description: `\`${error}\``,
        color: 0xef4444,
        timestamp: new Date(ts).toISOString(),
        footer: { text: caller ? `caller=${caller}` : "no caller" },
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

/**
 * Create investor threshold alert embeds.
 *
 * @param {string} type - "thesis_invalidation" | "accumulation_zone" | "rs_breakout" | "rebalancing"
 * @param {object} data - alert-specific data
 * @returns {object} Discord embed
 */
export function createInvestorAlertEmbed(type, data) {
  const ALERT_CONFIGS = {
    thesis_invalidation: {
      color: 0xef4444,
      emoji: "⚠️",
      title: (d) => `${d.ticker}: Investment Thesis Invalidated`,
      description: (d) => `One or more conditions that supported your investment in **${d.ticker}** are no longer valid.`,
      fields: (d) => d.reasons.map(r => ({ name: "Invalidation", value: r, inline: false })),
    },
    accumulation_zone: {
      color: 0x10b981,
      emoji: "🎯",
      title: (d) => `${d.ticker}: Entered Accumulation Zone`,
      description: (d) => `**${d.ticker}** has entered an accumulation zone — a potentially attractive entry point for long-term investors.`,
      fields: (d) => [
        { name: "Investor Score", value: `${d.score || "—"} / 100`, inline: true },
        { name: "Confidence", value: `${d.confidence || "—"}%`, inline: true },
        { name: "RS Rank", value: `${d.rsRank || "—"}th percentile`, inline: true },
        { name: "Signals", value: (d.signals || []).map(s => s.replace(/_/g, " ")).join(", ") || "—", inline: false },
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
      ],
    },
    rebalancing: {
      color: 0xf59e0b,
      emoji: "⚖️",
      title: () => "Portfolio Rebalancing Alert",
      description: () => "Your portfolio may benefit from rebalancing based on current conditions.",
      fields: (d) => (d.suggestions || []).map(s => ({
        name: s.type.replace(/_/g, " ").toUpperCase(),
        value: s.message,
        inline: false,
      })),
    },
  };

  const config = ALERT_CONFIGS[type];
  if (!config) return null;

  return {
    title: `${config.emoji} ${config.title(data)}`,
    description: config.description(data),
    color: config.color,
    fields: config.fields(data),
    footer: { text: "Timed Trading — Investor Intelligence • Not financial advice" },
    timestamp: new Date().toISOString(),
  };
}
