// Alerts module — Discord notifications and proactive alert generation

/** Send Discord notification with embed card styling. */
export async function notifyDiscord(env, embed) {
  const discordEnable = env.DISCORD_ENABLE || "false";
  if (discordEnable !== "true") {
    console.log(
      `[DISCORD] Notifications disabled (DISCORD_ENABLE="${discordEnable}", expected "true")`,
    );
    return { ok: false, skipped: true, reason: "disabled" };
  }
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log(
      `[DISCORD] Webhook URL not configured (DISCORD_WEBHOOK_URL is missing)`,
    );
    return { ok: false, skipped: true, reason: "missing_webhook" };
  }

  console.log(`[DISCORD] Sending notification: ${embed.title || "Untitled"}`);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
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
      };
    }
    console.log(
      `[DISCORD] ✅ Notification sent successfully: ${embed.title || "Untitled"}`,
    );
    return { ok: true, status: response.status };
  } catch (error) {
    console.error(`[DISCORD] Error sending notification:`, {
      error: String(error),
      message: error.message,
      stack: error.stack,
    });
    return { ok: false, error: String(error), message: error.message };
  }
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
    const rawTotal = Number(ctx.newTrimmedPct);
    const rawDelta = Number(ctx.trimDeltaPctRaw);
    const total =
      Number.isFinite(rawTotal) && rawTotal > 1 ? rawTotal / 100 : rawTotal;
    const delta =
      Number.isFinite(rawDelta) && Math.abs(rawDelta) > 1
        ? rawDelta / 100
        : rawDelta;
    if (Number.isFinite(total) && total >= 0.5) return true;
    if (Number.isFinite(delta) && Math.abs(delta) >= 0.2) return true;
    return false;
  }

  if (t === "TRADE_ENTRY") {
    const rr = Number(ctx.rr);
    const rank = Number(ctx.rank);
    const momentumElite = !!ctx.momentumElite;
    if (Number.isFinite(rank) && rank >= 80 && Number.isFinite(rr) && rr >= 2.0)
      return true;
    if (
      momentumElite &&
      Number.isFinite(rank) &&
      rank >= 75 &&
      Number.isFinite(rr) &&
      rr >= 1.6
    )
      return true;
    return false;
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
    footer: { text: "Timed Trading — Investor Intelligence" },
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
    footer: { text: "Timed Trading — Investor Intelligence" },
    timestamp: new Date().toISOString(),
  };
}
