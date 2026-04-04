#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);

function getArg(name, fallback = "") {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeFile(filePath, content) {
  const full = path.resolve(filePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function exitFamily(reason) {
  const s = String(reason || "").toUpperCase();
  if (!s) return "unknown";
  if (s.includes("TP_FULL")) return "tp_full";
  if (s.includes("PROFIT_GIVEBACK")) return "profit_giveback";
  if (s.includes("PHASE_LEAVE")) return "phase_leave";
  if (s.includes("TD_EXHAUSTION")) return "td_exhaustion";
  if (s.includes("SUPPORT_BREAK")) return "support_break";
  if (s.includes("SL_BREACHED") || s.includes("MAX_LOSS") || s.includes("HARD_LOSS_CAP") || s.includes("TRIGGER_BREACHED")) return "loss_protect";
  if (s.includes("REPLAY_END_CLOSE")) return "replay_end_close";
  if (s.includes("PRE_EARNINGS")) return "pre_earnings";
  if (s.includes("PRE_") && s.includes("RISK_REDUCTION")) return "macro_risk_reduction";
  if (s.includes("ST15_FLIP")) return "st15_flip";
  if (s.includes("RIPSTER_34_50_LOST_MTF")) return "ripster_mtf";
  if (s.includes("SOFT_FUSE")) return "soft_fuse";
  if (s.includes("BREAKEVEN")) return "breakeven";
  return "other";
}

function tradeMatchKey(trade) {
  return `${trade?.ticker || ""}|${trade?.direction || ""}|${trade?.entry_ts || ""}`;
}

function toDateKey(ts) {
  const n = toNum(ts);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString().slice(0, 10);
}

function metricPack(trade) {
  const pnlPct = toNum(trade?.pnl_pct, 0);
  const mfe = toNum(trade?.max_favorable_excursion, null);
  const mae = toNum(trade?.max_adverse_excursion, null);
  const givebackPct = Number.isFinite(mfe) ? +(mfe - pnlPct).toFixed(4) : null;
  const capturePct = Number.isFinite(mfe) && Math.abs(mfe) > 1e-9 ? +((pnlPct / mfe) * 100).toFixed(2) : null;
  return {
    pnl_pct: pnlPct,
    mfe_pct: mfe,
    mae_pct: mae,
    giveback_from_mfe_pct: givebackPct,
    mfe_capture_pct: capturePct,
  };
}

function buildNearestReferenceMap(referenceTrades) {
  const byTickerDir = new Map();
  for (const trade of referenceTrades) {
    const key = `${trade.ticker}|${trade.direction}`;
    if (!byTickerDir.has(key)) byTickerDir.set(key, []);
    byTickerDir.get(key).push(trade);
  }
  for (const rows of byTickerDir.values()) {
    rows.sort((a, b) => Number(a.entry_ts || 0) - Number(b.entry_ts || 0));
  }
  return (trade) => {
    const key = `${trade.ticker}|${trade.direction}`;
    const candidates = byTickerDir.get(key) || [];
    if (candidates.length === 0) return null;
    return candidates.reduce((best, row) => {
      if (!best) return row;
      return Math.abs(Number(row.entry_ts || 0) - Number(trade.entry_ts || 0)) < Math.abs(Number(best.entry_ts || 0) - Number(trade.entry_ts || 0))
        ? row
        : best;
    }, null);
  };
}

function classifyRecommendation({ reference, candidate, parityDetail, bucket }) {
  if (bucket === "missing_golden_trade") return "missing_trade_needs_restore";
  if (bucket === "spurious_current_trade") return "entry_should_be_blocked";
  if (!candidate) return "review_needed";
  const exitFam = exitFamily(candidate.exit_reason);
  const refExitFam = exitFamily(reference?.exit_reason);
  const mfe = toNum(candidate.max_favorable_excursion, null);
  const pnlPct = toNum(candidate.pnl_pct, 0);
  if (pnlPct < 0 && Number.isFinite(mfe) && mfe > 0.75) return "cut_loser_after_positive_excursion";
  if (pnlPct < 0 && exitFam === "loss_protect") return "entry_should_be_blocked_or_pretrimmed";
  if (exitFam !== refExitFam && refExitFam === "st15_flip") return "winner_extension_missing";
  if (exitFam !== refExitFam && refExitFam === "pre_earnings") return "event_risk_protection_missing";
  if (Number.isFinite(mfe) && mfe - pnlPct > 1.5 && pnlPct > 0) return "winner_gave_back_too_much";
  if (parityDetail && parityDetail.path_match === false) return "entry_path_mismatch";
  return "track_but_no_change";
}

const referenceEvidenceFile = getArg("reference-evidence");
const candidateEvidenceFile = getArg("candidate-evidence");
const parityFile = getArg("parity");
const ledgerSummaryFile = getArg("ledger-summary");
const outputJsonFile = getArg("output-json");
const outputMdFile = getArg("output-md");

if (!referenceEvidenceFile || !candidateEvidenceFile || !parityFile || !outputJsonFile || !outputMdFile) {
  console.error("Usage: node scripts/build-trade-diagnostic-report.js --reference-evidence <file> --candidate-evidence <file> --parity <file> --ledger-summary <file> --output-json <file> --output-md <file>");
  process.exit(1);
}

const referenceEvidence = readJson(referenceEvidenceFile);
const candidateEvidence = readJson(candidateEvidenceFile);
const parity = readJson(parityFile);
const ledgerSummary = ledgerSummaryFile ? readJson(ledgerSummaryFile) : null;

const referenceTrades = Array.isArray(referenceEvidence?.trades) ? referenceEvidence.trades : [];
const candidateTrades = Array.isArray(candidateEvidence?.trades) ? candidateEvidence.trades : [];
const parityDetails = Array.isArray(parity?.details) ? parity.details : [];
const paritySpurious = Array.isArray(parity?.spurious_trades) ? parity.spurious_trades : [];

const referenceByTradeId = new Map(referenceTrades.map((trade) => [String(trade.trade_id || ""), trade]));
const candidateByTradeId = new Map(candidateTrades.map((trade) => [String(trade.trade_id || ""), trade]));
const nearestReferenceFor = buildNearestReferenceMap(referenceTrades);

const overlapRows = parityDetails.map((detail) => {
  const reference = referenceByTradeId.get(String(detail.reference_trade_id || "")) || null;
  const candidate = candidateByTradeId.get(String(detail.candidate_trade_id || "")) || null;
  const matched = !!detail.matched && !!candidate;
  const bucket = matched
    ? (detail.trim_parity && detail.exit_family_match && Math.abs(Number(detail.entry_delta_min || 0)) <= 20 ? "overlap_trade_stable" : "overlap_trade_with_lifecycle_drift")
    : "missing_golden_trade";
  const goldenKey = reference ? tradeMatchKey(reference) : null;
  return {
    bucket,
    ticker: reference?.ticker || detail.ticker || candidate?.ticker || null,
    direction: reference?.direction || detail.direction || candidate?.direction || null,
    nearest_golden_match_key: goldenKey,
    golden_trade_id: reference?.trade_id || detail.reference_trade_id || null,
    candidate_trade_id: candidate?.trade_id || detail.candidate_trade_id || null,
    entry_timing_delta_min: matched ? Number(detail.entry_delta_min || 0) : null,
    exit_timing_delta_min: matched ? toNum(detail.exit_delta_min, null) : null,
    trim_timing_delta_min: matched ? toNum(detail.trim_delta_min, null) : null,
    golden_exit_family: exitFamily(reference?.exit_reason),
    candidate_exit_family: exitFamily(candidate?.exit_reason),
    golden_exit_reason: reference?.exit_reason || null,
    candidate_exit_reason: candidate?.exit_reason || null,
    golden: reference ? metricPack(reference) : null,
    candidate: candidate ? metricPack(candidate) : null,
    path_match: matched ? !!detail.path_match : false,
    exit_family_match: matched ? !!detail.exit_family_match : false,
    trim_parity: matched ? !!detail.trim_parity : false,
    recommendation: classifyRecommendation({ reference, candidate, parityDetail: detail, bucket }),
  };
});

const spuriousRows = paritySpurious.map((row) => {
  const candidate = candidateByTradeId.get(String(row.trade_id || "")) || row;
  const reference = nearestReferenceFor(candidate);
  return {
    bucket: "spurious_current_trade",
    ticker: candidate?.ticker || null,
    direction: candidate?.direction || null,
    nearest_golden_match_key: reference ? tradeMatchKey(reference) : null,
    golden_trade_id: reference?.trade_id || null,
    candidate_trade_id: candidate?.trade_id || null,
    entry_timing_delta_min: reference ? +(((Number(candidate.entry_ts || 0) - Number(reference.entry_ts || 0)) / 60000).toFixed(2)) : null,
    exit_timing_delta_min: null,
    trim_timing_delta_min: null,
    golden_exit_family: reference ? exitFamily(reference.exit_reason) : null,
    candidate_exit_family: exitFamily(candidate?.exit_reason),
    golden_exit_reason: reference?.exit_reason || null,
    candidate_exit_reason: candidate?.exit_reason || null,
    golden: reference ? metricPack(reference) : null,
    candidate: candidate ? metricPack(candidate) : null,
    path_match: false,
    exit_family_match: false,
    trim_parity: false,
    recommendation: classifyRecommendation({ reference, candidate, parityDetail: null, bucket: "spurious_current_trade" }),
  };
});

const candidateWindowEnd = toNum(referenceEvidence?.window?.end_entry_ts, null);
const postWindowLosers = candidateTrades
  .filter((trade) => Number(trade?.entry_ts || 0) > Number(candidateWindowEnd || 0) && toNum(trade?.pnl, 0) < 0)
  .map((trade) => ({
    bucket: "post_window_loser",
    ticker: trade.ticker,
    direction: trade.direction,
    date: toDateKey(trade.entry_ts),
    candidate_trade_id: trade.trade_id,
    candidate_exit_family: exitFamily(trade.exit_reason),
    candidate_exit_reason: trade.exit_reason || null,
    candidate: metricPack(trade),
    recommendation: classifyRecommendation({ reference: nearestReferenceFor(trade), candidate: trade, parityDetail: null, bucket: "post_window_loser" }),
  }))
  .sort((a, b) => toNum(a?.candidate?.pnl_pct, 0) - toNum(b?.candidate?.pnl_pct, 0));

const bucketSummary = {};
for (const row of [...overlapRows, ...spuriousRows]) {
  bucketSummary[row.bucket] = (bucketSummary[row.bucket] || 0) + 1;
}

const recommendationSummary = {};
for (const row of [...overlapRows, ...spuriousRows, ...postWindowLosers]) {
  recommendationSummary[row.recommendation] = (recommendationSummary[row.recommendation] || 0) + 1;
}

const output = {
  generated_at: new Date().toISOString(),
  reference_run_id: referenceEvidence?.run_id || null,
  candidate_run_id: candidateEvidence?.run_id || null,
  summary: {
    golden_trade_count: referenceTrades.length,
    candidate_trade_count: candidateTrades.length,
    bucket_summary: bucketSummary,
    recommendation_summary: recommendationSummary,
    parity_counts: parity?.counts || null,
    parity: parity?.parity || null,
    ledger_exit_breakdown: ledgerSummary?.breakdown?.byExitReason || null,
  },
  overlap_rows: overlapRows,
  spurious_rows: spuriousRows,
  post_window_losers: postWindowLosers.slice(0, 25),
};

const driftRows = overlapRows.filter((row) => row.bucket === "overlap_trade_with_lifecycle_drift");
const missingRows = overlapRows.filter((row) => row.bucket === "missing_golden_trade");
const topPostWindowLosers = postWindowLosers.slice(0, 10);
const ledgerExitRows = Array.isArray(ledgerSummary?.breakdown?.byExitReason) ? ledgerSummary.breakdown.byExitReason : [];

const md = [
  "# Trade Diagnostic Report",
  "",
  `Generated: ${output.generated_at}`,
  "",
  "## Scope",
  "",
  `- Golden anchor: \`${output.reference_run_id}\``,
  `- Candidate full run: \`${output.candidate_run_id}\``,
  `- Golden trade count: ${referenceTrades.length}`,
  `- Candidate trade count: ${candidateTrades.length}`,
  "",
  "## Golden Window Parity",
  "",
  `- Basket parity: ${((toNum(parity?.parity?.basket_pct, 0) || 0) * 100).toFixed(2)}%`,
  `- Entry timing parity: ${((toNum(parity?.parity?.entry_timing_pct, 0) || 0) * 100).toFixed(2)}%`,
  `- Lifecycle parity: ${((toNum(parity?.parity?.lifecycle_pct, 0) || 0) * 100).toFixed(2)}%`,
  `- Stable overlap trades: ${bucketSummary.overlap_trade_stable || 0}`,
  `- Drifted overlap trades: ${bucketSummary.overlap_trade_with_lifecycle_drift || 0}`,
  `- Missing golden trades: ${bucketSummary.missing_golden_trade || 0}`,
  `- Spurious Jul/Aug trades: ${bucketSummary.spurious_current_trade || 0}`,
  "",
  "## Highest-Confidence Drift Trades",
  "",
  ...driftRows.slice(0, 12).map((row) =>
    `- ${row.ticker}: golden \`${row.golden_exit_reason}\` vs candidate \`${row.candidate_exit_reason}\`; giveback=${row.candidate?.giveback_from_mfe_pct ?? "n/a"} pct-points; recommendation=${row.recommendation}`
  ),
  "",
  "## Missing Golden Trades",
  "",
  ...(missingRows.length
    ? missingRows.map((row) => `- ${row.ticker}: restore missing trade path; nearest key=${row.nearest_golden_match_key || "n/a"}`)
    : ["- None."]),
  "",
  "## Spurious Jul/Aug Trades",
  "",
  ...(spuriousRows.length
    ? spuriousRows.slice(0, 15).map((row) => `- ${row.ticker}: candidate exit \`${row.candidate_exit_reason}\`; nearest golden=${row.nearest_golden_match_key || "none"}; recommendation=${row.recommendation}`)
    : ["- None."]),
  "",
  "## Post-Window Losses",
  "",
  ...(topPostWindowLosers.length
    ? topPostWindowLosers.map((row) => `- ${row.ticker} ${row.date || ""}: exit \`${row.candidate_exit_reason}\`, pnl_pct=${row.candidate?.pnl_pct ?? "n/a"}, mfe=${row.candidate?.mfe_pct ?? "n/a"}, mae=${row.candidate?.mae_pct ?? "n/a"}, recommendation=${row.recommendation}`)
    : ["- None."]),
  "",
  "## Candidate Exit Families",
  "",
  ...(ledgerExitRows.length
    ? ledgerExitRows.slice(0, 12).map((row) => `- ${row.bucket}: n=${row.n}, pnl=${Number(row.pnl || 0).toFixed(2)}`)
    : ["- No ledger summary provided."]),
  "",
  "## Refinement Readout",
  "",
  "- The golden Jul/Aug basket is still historically reproducible, so the main regressions are validity and harness drift first.",
  "- Event-risk seeding must be present before replay or earnings-sensitive names will not get pre-event protection.",
  "- Autopsy needs to stay clearly scoped to live replay KV or archived run data so July trades are observable and wall-clock contamination stays out.",
  "- The next rerun should stay pinned to the frozen recovered config rather than merging live model state.",
  "",
].join("\n");

writeFile(outputJsonFile, JSON.stringify(output, null, 2));
writeFile(outputMdFile, md);

console.log(path.resolve(outputJsonFile));
console.log(path.resolve(outputMdFile));
