#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PROFILE_RESOLUTION_PATH = path.join(ROOT, "worker/profile-resolution.js");

function getArg(name, fallback = null) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const API_BASE = getArg("--api-base", "https://timed-trading-ingest.shashant.workers.dev");
const API_KEY = getArg("--api-key", "AwesomeSauce");
const OUTPUT_JSON = getArg("--output-json", path.join(ROOT, "data/regime-config-decision/regime-evidence-matrix.json"));
const OUTPUT_MD = getArg("--output-md", path.join(ROOT, "data/regime-config-decision/regime-evidence-matrix.md"));
const RUN_IDS = String(getArg("--run-ids", ""))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const USE_LIVE = hasFlag("--live") || RUN_IDS.length === 0;

function execJson(command) {
  const raw = execSync(command, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function fetchJson(url) {
  return execJson(`curl -sS "${url}"`);
}

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeLabel(value, fallback = "UNKNOWN") {
  const text = String(value || "").trim();
  return text ? text.toUpperCase() : fallback;
}

function toMs(value) {
  const n = toNum(value, null);
  if (n == null || n <= 0) return null;
  return n < 1e12 ? Math.trunc(n * 1000) : Math.trunc(n);
}

function monthKey(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return "UNKNOWN";
  return new Date(ts).toISOString().slice(0, 7);
}

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function mean(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function extractObjectLiteral(fileText, constName) {
  const anchor = `const ${constName} =`;
  const startIdx = fileText.indexOf(anchor);
  if (startIdx < 0) return null;
  const braceIdx = fileText.indexOf("{", startIdx);
  if (braceIdx < 0) return null;
  let depth = 0;
  let endIdx = braceIdx;
  let inString = false;
  let stringChar = "";
  for (let i = braceIdx; i < fileText.length; i += 1) {
    const ch = fileText[i];
    const prev = fileText[i - 1];
    if (inString) {
      if (ch === stringChar && prev !== "\\") {
        inString = false;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) {
      endIdx = i;
      break;
    }
  }
  return fileText.slice(braceIdx, endIdx + 1);
}

function loadStaticProfileArtifacts() {
  const source = fs.readFileSync(PROFILE_RESOLUTION_PATH, "utf8");
  const profileMapLiteral = extractObjectLiteral(source, "STATIC_BEHAVIOR_PROFILE_MAP");
  const profilesLiteral = extractObjectLiteral(source, "STATIC_BEHAVIOR_PROFILES");
  if (!profileMapLiteral || !profilesLiteral) {
    throw new Error("Unable to parse static profile maps from worker/profile-resolution.js");
  }
  return {
    profileMap: vm.runInNewContext(`(${profileMapLiteral})`),
    profiles: vm.runInNewContext(`(${profilesLiteral})`),
  };
}

const STATIC_PROFILE_ARTIFACTS = loadStaticProfileArtifacts();

function resolveVixTier(vixValue) {
  const n = toNum(vixValue, null);
  if (n == null) return "UNKNOWN";
  if (n < 15) return "LOW_VOL";
  if (n < 20) return "NORMAL";
  if (n < 25) return "ELEVATED";
  if (n < 30) return "HIGH_VOL";
  return "EXTREME";
}

function firstNonEmpty(candidates, fallback = null) {
  for (const candidate of candidates) {
    const text = typeof candidate === "string" ? candidate.trim() : candidate;
    if (text != null && text !== "") return text;
  }
  return fallback;
}

function getPath(obj, pathParts) {
  let cursor = obj;
  for (const part of pathParts) {
    if (!cursor || typeof cursor !== "object" || !(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function firstPath(obj, pathSets) {
  for (const pathParts of pathSets) {
    const value = getPath(obj, pathParts);
    if (value != null && value !== "") return value;
  }
  return null;
}

function normalizeTrade(rawTrade) {
  const signal = parseJsonMaybe(rawTrade.signal_snapshot_json) || {};
  const exitSignal = parseJsonMaybe(rawTrade.exit_snapshot_json) || {};
  const lineage = signal.lineage || {};
  const ticker = normalizeLabel(rawTrade.ticker, "");
  const staticProfileKey = normalizeLabel(
    firstNonEmpty([
      firstPath(lineage, [["ticker_character", "static_behavior_profile", "key"]]),
      STATIC_PROFILE_ARTIFACTS.profileMap[ticker],
      "default",
    ]),
    "DEFAULT"
  );
  const learnedPersonality = normalizeLabel(
    firstNonEmpty([
      firstPath(lineage, [["ticker_character", "learned_profile", "personality"]]),
      firstPath(lineage, [["ticker_character", "learned_profile", "behavior_type"]]),
      lineage.learned_behavior_type,
    ]),
    null
  );
  const executionRegimeClass = normalizeLabel(
    firstNonEmpty([
      lineage.regime_class,
      firstPath(signal, [["market", "regime", "executionClass"]]),
      firstPath(signal, [["market", "regime", "execution_class"]]),
      firstPath(signal, [["regime", "executionClass"]]),
      firstPath(signal, [["regime", "execution_class"]]),
      firstPath(signal, [["ctx", "regime", "class"]]),
      firstPath(signal, [["ctx", "regime", "executionClass"]]),
    ]),
    "UNKNOWN"
  );
  const swingCombined = normalizeLabel(
    firstNonEmpty([
      firstPath(signal, [["market", "regime", "swingCombined"]]),
      firstPath(signal, [["market", "regime", "swing_combined"]]),
      firstPath(signal, [["regime", "combined"]]),
      firstPath(signal, [["regime", "swing"]]),
      lineage.regime_combined,
    ]),
    "UNKNOWN"
  );
  const marketBackdropClass = normalizeLabel(
    firstNonEmpty([
      lineage.market_backdrop_class,
      firstPath(signal, [["market", "backdropClass"]]),
      firstPath(signal, [["market", "backdrop_class"]]),
    ]),
    "UNKNOWN"
  );
  const vixAtEntry = firstNonEmpty([
    lineage.vix_at_entry,
    firstPath(signal, [["market", "vix", "value"]]),
    firstPath(signal, [["market", "vix"]]),
    firstPath(signal, [["vix", "value"]]),
    firstPath(signal, [["vix"]]),
  ]);
  const staticProfile = STATIC_PROFILE_ARTIFACTS.profiles[String(staticProfileKey || "").toLowerCase()] || null;
  return {
    trade_id: rawTrade.trade_id || null,
    run_id: rawTrade.run_id || null,
    ticker,
    direction: normalizeLabel(rawTrade.direction, "UNKNOWN"),
    status: normalizeLabel(rawTrade.status, "UNKNOWN"),
    entry_ts: toMs(rawTrade.entry_ts),
    exit_ts: toMs(rawTrade.exit_ts),
    pnl: toNum(rawTrade.pnl, 0) || 0,
    pnl_pct: toNum(rawTrade.pnl_pct ?? rawTrade.pnlPct, 0) || 0,
    exit_reason: firstNonEmpty([rawTrade.exit_reason], "UNKNOWN"),
    setup_grade: normalizeLabel(rawTrade.setup_grade, "UNKNOWN"),
    entry_path: firstNonEmpty([rawTrade.entry_path, lineage.entry_path], "UNKNOWN"),
    entry_quality_score: toNum(rawTrade.entry_quality_score ?? lineage.entry_quality_score, null),
    execution_profile_name: firstNonEmpty([rawTrade.execution_profile_name], null),
    execution_regime_class: executionRegimeClass,
    vix_tier: resolveVixTier(vixAtEntry),
    swing_combined: swingCombined,
    market_backdrop_class: marketBackdropClass,
    static_profile_key: staticProfileKey,
    static_profile_label: staticProfile?.label || staticProfileKey,
    learned_personality: learnedPersonality,
    policy_profile_class: learnedPersonality ? `LEARNED_${learnedPersonality}` : `STATIC_${staticProfileKey}`,
    signal_snapshot_json: signal,
    exit_snapshot_json: exitSignal,
  };
}

function buildBucketStats(rows, keyName) {
  const buckets = new Map();
  for (const row of rows) {
    const bucket = String(row[keyName] || "UNKNOWN");
    if (!buckets.has(bucket)) {
      buckets.set(bucket, {
        bucket,
        closed_trades: 0,
        wins: 0,
        losses: 0,
        net_pnl: 0,
        gross_profit: 0,
        gross_loss: 0,
        avg_win: 0,
        avg_loss: 0,
        avg_pnl: 0,
      });
    }
    const entry = buckets.get(bucket);
    entry.closed_trades += 1;
    entry.net_pnl += row.pnl;
    if (row.pnl > 0) {
      entry.wins += 1;
      entry.gross_profit += row.pnl;
    } else if (row.pnl < 0) {
      entry.losses += 1;
      entry.gross_loss += row.pnl;
    }
  }
  const totalLossAbs = rows
    .filter((row) => row.pnl < 0)
    .reduce((sum, row) => sum + Math.abs(row.pnl), 0);
  return [...buckets.values()]
    .map((bucket) => ({
      bucket: bucket.bucket,
      closed_trades: bucket.closed_trades,
      wins: bucket.wins,
      losses: bucket.losses,
      win_rate_pct: bucket.closed_trades ? round((bucket.wins / bucket.closed_trades) * 100, 1) : 0,
      net_pnl: round(bucket.net_pnl, 2),
      avg_pnl: round(bucket.net_pnl / bucket.closed_trades, 2),
      avg_win: bucket.wins ? round(bucket.gross_profit / bucket.wins, 2) : 0,
      avg_loss: bucket.losses ? round(bucket.gross_loss / bucket.losses, 2) : 0,
      profit_factor: bucket.gross_loss < 0 ? round(bucket.gross_profit / Math.abs(bucket.gross_loss), 2) : null,
      loss_share_pct: totalLossAbs > 0 ? round((Math.abs(Math.min(bucket.net_pnl, 0)) / totalLossAbs) * 100, 1) : 0,
    }))
    .sort((a, b) => {
      if (b.closed_trades !== a.closed_trades) return b.closed_trades - a.closed_trades;
      return (b.net_pnl || 0) - (a.net_pnl || 0);
    });
}

function summarizeRun(runMeta, tradeRows) {
  const normalized = tradeRows.map(normalizeTrade);
  const closedTrades = normalized.filter((trade) => !["OPEN", "TP_HIT_TRIM"].includes(trade.status));
  const wins = closedTrades.filter((trade) => trade.pnl > 0);
  const losses = closedTrades.filter((trade) => trade.pnl < 0);
  const totalLossAbs = losses.reduce((sum, trade) => sum + Math.abs(trade.pnl), 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = losses.reduce((sum, trade) => sum + trade.pnl, 0);
  const monthlyRows = closedTrades.map((trade) => ({ ...trade, month: monthKey(trade.entry_ts) }));
  const topLossTickers = buildBucketStats(
    losses.map((trade) => ({ ...trade, loss_ticker: trade.ticker })),
    "loss_ticker"
  )
    .map((row) => ({
      ticker: row.bucket,
      losses: row.closed_trades,
      net_pnl: row.net_pnl,
      loss_share_pct: totalLossAbs > 0 ? round((Math.abs(row.net_pnl) / totalLossAbs) * 100, 1) : 0,
    }))
    .sort((a, b) => a.net_pnl - b.net_pnl)
    .slice(0, 10);
  const topWinners = [...wins]
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 10)
    .map((trade) => ({
      ticker: trade.ticker,
      direction: trade.direction,
      pnl: round(trade.pnl, 2),
      pnl_pct: round(trade.pnl_pct, 2),
      setup_grade: trade.setup_grade,
      execution_regime_class: trade.execution_regime_class,
      policy_profile_class: trade.policy_profile_class,
      entry_path: trade.entry_path,
    }));
  const topLosers = [...losses]
    .sort((a, b) => a.pnl - b.pnl)
    .slice(0, 10)
    .map((trade) => ({
      ticker: trade.ticker,
      direction: trade.direction,
      pnl: round(trade.pnl, 2),
      pnl_pct: round(trade.pnl_pct, 2),
      setup_grade: trade.setup_grade,
      execution_regime_class: trade.execution_regime_class,
      policy_profile_class: trade.policy_profile_class,
      entry_path: trade.entry_path,
      exit_reason: trade.exit_reason,
    }));
  const months = buildBucketStats(monthlyRows, "month").sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
  const byExecutionRegime = buildBucketStats(closedTrades, "execution_regime_class");
  const byVixTier = buildBucketStats(closedTrades, "vix_tier");
  const byStaticProfile = buildBucketStats(closedTrades, "static_profile_key");
  const byPolicyProfileClass = buildBucketStats(closedTrades, "policy_profile_class");
  const bySetupGrade = buildBucketStats(closedTrades, "setup_grade");
  const byEntryPath = buildBucketStats(closedTrades, "entry_path");
  const knownExecutionRegime = closedTrades.filter((trade) => trade.execution_regime_class !== "UNKNOWN").length;
  const knownVixTier = closedTrades.filter((trade) => trade.vix_tier !== "UNKNOWN").length;
  const knownSwingCombined = closedTrades.filter((trade) => trade.swing_combined !== "UNKNOWN").length;
  const negativeMonths = months.filter((row) => row.net_pnl < 0);
  const severeRegimeBuckets = byExecutionRegime.filter((row) => row.bucket !== "UNKNOWN" && row.closed_trades >= 5 && row.net_pnl < 0);
  const severeProfileBuckets = byStaticProfile.filter((row) => row.bucket !== "UNKNOWN" && row.closed_trades >= 5 && row.net_pnl < 0);
  const severeTickerBuckets = topLossTickers.filter((row) => row.losses >= 2 || row.loss_share_pct >= 15);
  const crownJewelThreshold = wins.length ? [...wins].sort((a, b) => b.pnl - a.pnl)[Math.max(0, Math.floor(wins.length * 0.1) - 1)]?.pnl || 0 : 0;
  const crownJewelWinners = wins
    .filter((trade) => trade.pnl >= crownJewelThreshold)
    .map((trade) => ({
      ticker: trade.ticker,
      pnl: round(trade.pnl, 2),
      execution_regime_class: trade.execution_regime_class,
      static_profile_key: trade.static_profile_key,
      policy_profile_class: trade.policy_profile_class,
    }));

  const overlayAssessment = {
    universal_baseline_only: {
      status: negativeMonths.length <= 1 && severeProfileBuckets.length === 0 ? "viable" : "rejected",
      reasons: [
        negativeMonths.length > 1 ? `${negativeMonths.length} monthly buckets are net negative` : null,
        severeProfileBuckets.length > 0 ? `${severeProfileBuckets.length} profile buckets show persistent negative PnL` : null,
      ].filter(Boolean),
    },
    regime_overlay: {
      status: knownExecutionRegime / Math.max(closedTrades.length, 1) >= 0.5
        ? (severeRegimeBuckets.length > 0 || negativeMonths.length > 1 ? "recommended" : "not_needed_yet")
        : (negativeMonths.length > 1 ? "proxy_supported_but_needs_better_regime_coverage" : "insufficient_evidence"),
      reasons: [
        severeRegimeBuckets.length > 0 ? `${severeRegimeBuckets.length} execution-regime buckets are negative with usable sample size` : null,
        negativeMonths.length > 1 ? "month-level instability suggests environment sensitivity" : null,
        knownExecutionRegime / Math.max(closedTrades.length, 1) < 0.5 ? "current run has incomplete archived execution-regime coverage" : null,
      ].filter(Boolean),
    },
    regime_plus_profile_overlay: {
      status: severeProfileBuckets.length > 0 ? "recommended" : "not_needed_yet",
      reasons: [
        severeProfileBuckets.length > 0 ? `${severeProfileBuckets.length} static profile classes are negative with at least 5 closed trades` : null,
        severeTickerBuckets.length > 0 ? "ticker outliers exist, but profile concentration is still the preferred layer before symbol exceptions" : null,
      ].filter(Boolean),
    },
    symbol_exceptions: {
      status: severeTickerBuckets.length > 0 ? "diagnostic_only" : "not_needed_yet",
      reasons: [
        severeTickerBuckets.length > 0 ? `${severeTickerBuckets.length} tickers are concentrated enough to review as exceptions` : null,
        "promote only after baseline, regime, and profile overlays fail to explain the failure mode",
      ].filter(Boolean),
    },
  };

  return {
    run_id: runMeta.run_id,
    label: runMeta.label || runMeta.run_id,
    source: runMeta.source,
    trade_count_total: normalized.length,
    closed_count: closedTrades.length,
    wins: wins.length,
    losses: losses.length,
    win_rate_pct: closedTrades.length ? round((wins.length / closedTrades.length) * 100, 1) : 0,
    realized_pnl: round(closedTrades.reduce((sum, trade) => sum + trade.pnl, 0), 2),
    gross_profit: round(grossProfit, 2),
    gross_loss: round(grossLoss, 2),
    profit_factor: grossLoss < 0 ? round(grossProfit / Math.abs(grossLoss), 2) : null,
    avg_win: wins.length ? round(grossProfit / wins.length, 2) : 0,
    avg_loss: losses.length ? round(grossLoss / losses.length, 2) : 0,
    expectancy_per_closed_trade: closedTrades.length ? round(closedTrades.reduce((sum, trade) => sum + trade.pnl, 0) / closedTrades.length, 2) : 0,
    coverage: {
      execution_regime_class_pct: closedTrades.length ? round((knownExecutionRegime / closedTrades.length) * 100, 1) : 0,
      vix_tier_pct: closedTrades.length ? round((knownVixTier / closedTrades.length) * 100, 1) : 0,
      swing_combined_pct: closedTrades.length ? round((knownSwingCombined / closedTrades.length) * 100, 1) : 0,
    },
    evidence_matrix: {
      by_month: months,
      by_execution_regime_class: byExecutionRegime,
      by_vix_tier: byVixTier,
      by_static_profile: byStaticProfile,
      by_policy_profile_class: byPolicyProfileClass,
      by_setup_grade: bySetupGrade,
      by_entry_path: byEntryPath,
      top_loss_tickers: topLossTickers,
    },
    winner_retention_check: {
      crown_jewel_threshold_pnl: round(crownJewelThreshold, 2),
      crown_jewel_winners: crownJewelWinners,
    },
    top_winners: topWinners,
    top_losers: topLosers,
    overlay_assessment: overlayAssessment,
  };
}

function buildPromotionRules() {
  return [
    {
      layer: "baseline",
      promote_when: "The same failure mode appears across multiple months or across at least two distinct profile classes, and the fix does not reduce crown-jewel winner retention.",
    },
    {
      layer: "regime_overlay",
      promote_when: "The issue clusters in one canonical execution regime or VIX tier across at least two windows, and the overlay improves profit factor or net PnL without removing top-decile winners.",
    },
    {
      layer: "profile_overlay",
      promote_when: "A profile class remains persistently weak after baseline and regime tuning, with enough closed trades to avoid one-symbol overfitting.",
    },
    {
      layer: "symbol_exception",
      promote_when: "The ticker remains an outlier after profile-level treatment and the failure mode is repeated, durable, and not explained by a broader regime or profile bucket.",
    },
  ];
}

function buildMarkdown(report) {
  const lines = [];
  lines.push("# Regime Evidence Matrix");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push("");
  lines.push("## Authoritative Policy Axis");
  lines.push("");
  lines.push("- Primary tuning axis: `MarketContext.regime.executionClass`");
  lines.push("- Secondary context: `MarketContext.vix.tier`");
  lines.push("- Diagnostic-only context: `swingCombined` and `marketBackdropClass`");
  lines.push("- Ticker adaptation axis: static behavior profile first, learned personality second");
  lines.push("");
  for (const run of report.runs) {
    lines.push(`## ${run.label}`);
    lines.push("");
    lines.push(`- Run ID: \`${run.run_id}\``);
    lines.push(`- Source: \`${run.source}\``);
    lines.push(`- Closed trades: \`${run.closed_count}\``);
    lines.push(`- Win rate: \`${run.win_rate_pct}%\``);
    lines.push(`- Realized PnL: \`$${run.realized_pnl}\``);
    lines.push(`- Profit factor: \`${run.profit_factor}\``);
    lines.push("");
    lines.push("### Coverage");
    lines.push("");
    lines.push(`- Execution regime coverage: \`${run.coverage.execution_regime_class_pct}%\``);
    lines.push(`- VIX tier coverage: \`${run.coverage.vix_tier_pct}%\``);
    lines.push(`- Swing regime coverage: \`${run.coverage.swing_combined_pct}%\``);
    lines.push("");
    lines.push("### Monthly Stability");
    lines.push("");
    for (const row of run.evidence_matrix.by_month) {
      lines.push(`- \`${row.bucket}\`: ${row.closed_trades} closed, ${row.win_rate_pct}% WR, $${row.net_pnl}`);
    }
    lines.push("");
    lines.push("### Profile Concentration");
    lines.push("");
    for (const row of run.evidence_matrix.by_static_profile.slice(0, 6)) {
      lines.push(`- \`${row.bucket}\`: ${row.closed_trades} closed, ${row.win_rate_pct}% WR, $${row.net_pnl}, loss share ${row.loss_share_pct}%`);
    }
    lines.push("");
    lines.push("### Overlay Assessment");
    lines.push("");
    for (const [key, value] of Object.entries(run.overlay_assessment)) {
      lines.push(`- \`${key}\`: ${value.status}${value.reasons.length ? ` — ${value.reasons.join("; ")}` : ""}`);
    }
    lines.push("");
  }
  lines.push("## Promotion Rules");
  lines.push("");
  for (const rule of report.promotion_rules) {
    lines.push(`- \`${rule.layer}\`: ${rule.promote_when}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function resolveLiveRunMeta() {
  const liveUrl = `${API_BASE}/timed/admin/runs/live?key=${encodeURIComponent(API_KEY)}`;
  const livePayload = fetchJson(liveUrl);
  if (!livePayload?.ok) {
    throw new Error(`Unable to fetch live run state: ${livePayload?.error || "unknown_error"}`);
  }
  const active = livePayload?.read_model?.active || livePayload?.run || livePayload?.active || livePayload?.live || {};
  const runId = String(active.active_run_id || active.run_id || "").trim();
  if (!runId) throw new Error("No active run_id found for --live mode");
  return {
    run_id: runId,
    label: active.label || runId,
    source: "live",
    trades_url: `${API_BASE}/timed/admin/trade-autopsy/trades?live=1&key=${encodeURIComponent(API_KEY)}`,
  };
}

function resolveArchiveRunMeta(runId) {
  return {
    run_id: runId,
    label: runId,
    source: "archive",
    trades_url: `${API_BASE}/timed/admin/trade-autopsy/trades?run_id=${encodeURIComponent(runId)}&key=${encodeURIComponent(API_KEY)}`,
  };
}

function loadRunTrades(runMeta) {
  const payload = fetchJson(runMeta.trades_url);
  if (!payload?.ok || !Array.isArray(payload.trades)) {
    throw new Error(`Unable to fetch trades for ${runMeta.run_id}: ${payload?.error || "unknown_error"}`);
  }
  return payload.trades;
}

function main() {
  const runMetas = USE_LIVE ? [resolveLiveRunMeta()] : RUN_IDS.map(resolveArchiveRunMeta);
  const runs = runMetas.map((runMeta) => summarizeRun(runMeta, loadRunTrades(runMeta)));
  const report = {
    generated_at: new Date().toISOString(),
    selection: {
      mode: USE_LIVE ? "live" : "archive",
      run_ids: runMetas.map((meta) => meta.run_id),
    },
    runs,
    promotion_rules: buildPromotionRules(),
  };
  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.mkdirSync(path.dirname(OUTPUT_MD), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(OUTPUT_MD, buildMarkdown(report));
  console.log(JSON.stringify({
    ok: true,
    output_json: path.resolve(OUTPUT_JSON),
    output_md: path.resolve(OUTPUT_MD),
    runs: runs.map((run) => ({
      run_id: run.run_id,
      label: run.label,
      win_rate_pct: run.win_rate_pct,
      realized_pnl: run.realized_pnl,
      regime_coverage_pct: run.coverage.execution_regime_class_pct,
      profile_overlay_status: run.overlay_assessment.regime_plus_profile_overlay.status,
      regime_overlay_status: run.overlay_assessment.regime_overlay.status,
    })),
  }, null, 2));
}

main();
