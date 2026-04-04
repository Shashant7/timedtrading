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

function loadRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of ["trades", "rows", "results"]) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
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

function normalizeTs(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickPath(obj, pathStr) {
  const parts = pathStr.split(".");
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object" || !(p in cur)) return null;
    cur = cur[p];
  }
  return cur ?? null;
}

function shallowEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function summarizeRsiDiv(div) {
  if (!div || typeof div !== "object") return null;
  const out = {};
  for (const tf of ["30", "1H", "D"]) {
    const row = div[tf];
    if (!row) continue;
    out[tf] = {
      bear: row.bear ? { active: !!row.bear.active, strength: row.bear.strength ?? null, barsSince: row.bear.barsSince ?? null } : null,
      bull: row.bull ? { active: !!row.bull.active, strength: row.bull.strength ?? null, barsSince: row.bull.barsSince ?? null } : null,
      recentBear: row.recentBear ? { active: !!row.recentBear.active, strength: row.recentBear.strength ?? null, barsSince: row.recentBear.barsSince ?? null } : null,
      recentBull: row.recentBull ? { active: !!row.recentBull.active, strength: row.recentBull.strength ?? null, barsSince: row.recentBull.barsSince ?? null } : null,
    };
  }
  return Object.keys(out).length ? out : null;
}

function summarizeLineage(signalSnap) {
  const sig = parseJsonMaybe(signalSnap) || {};
  const lin = sig.lineage || {};
  return {
    avg_bias: sig.avg_bias ?? null,
    entry_path: lin.entry_path ?? null,
    selected_engine: lin.selected_engine ?? null,
    selected_management_engine: lin.selected_management_engine ?? null,
    engine_source: lin.engine_source ?? null,
    scenario_policy_source: lin.scenario_policy_source ?? null,
    regime_class: lin.regime_class ?? null,
    state: lin.state ?? null,
    market_internals: lin.market_internals ?? null,
    fuel: lin.fuel ?? null,
    ema_depth: lin.ema_depth ?? null,
    danger_score: lin.danger_score ?? null,
    danger_flags: lin.danger_flags ?? null,
    rsi_divergence: summarizeRsiDiv(lin.rsi_divergence),
  };
}

function summarizeExitSnapshot(exitSnap) {
  const snap = parseJsonMaybe(exitSnap) || {};
  return {
    avg_bias: snap.avg_bias ?? null,
    rsi_divergence: summarizeRsiDiv(snap.lineage?.rsi_divergence || snap.rsi_divergence),
    market_internals: snap.lineage?.market_internals ?? snap.market_internals ?? null,
  };
}

function matchCandidate(reference, candidates) {
  const compatible = candidates
    .filter((c) => String(c.ticker || "").toUpperCase() === String(reference.ticker || "").toUpperCase())
    .sort((a, b) => Math.abs((normalizeTs(a.entry_ts) || 0) - normalizeTs(reference.entry_ts)) - Math.abs((normalizeTs(b.entry_ts) || 0) - normalizeTs(reference.entry_ts)));
  return compatible[0] || null;
}

const goldenFile = getArg("golden-autopsy");
const candidateFile = getArg("candidate-autopsy");
const outputFile = getArg("output");

if (!goldenFile || !candidateFile || !outputFile) {
  console.error("Usage: node scripts/compare-action-interval-state.js --golden-autopsy <file> --candidate-autopsy <file> --output <file>");
  process.exit(1);
}

const goldenRows = loadRows(readJson(goldenFile));
const candidateRows = loadRows(readJson(candidateFile));

const details = [];
for (const golden of goldenRows) {
  const candidate = matchCandidate(golden, candidateRows);
  const goldenEntry = summarizeLineage(golden.signal_snapshot_json);
  const candidateEntry = candidate ? summarizeLineage(candidate.signal_snapshot_json) : null;
  const goldenExit = summarizeExitSnapshot(golden.exit_snapshot_json);
  const candidateExit = candidate ? summarizeExitSnapshot(candidate.exit_snapshot_json) : null;
  const entryFieldDiffs = [];
  const exitFieldDiffs = [];
  for (const field of Object.keys(goldenEntry)) {
    if (!shallowEqual(goldenEntry[field], candidateEntry?.[field] ?? null)) {
      entryFieldDiffs.push({
        field,
        golden: goldenEntry[field],
        candidate: candidateEntry?.[field] ?? null,
      });
    }
  }
  for (const field of Object.keys(goldenExit)) {
    if (!shallowEqual(goldenExit[field], candidateExit?.[field] ?? null)) {
      exitFieldDiffs.push({
        field,
        golden: goldenExit[field],
        candidate: candidateExit?.[field] ?? null,
      });
    }
  }
  details.push({
    ticker: golden.ticker,
    golden_trade_id: golden.trade_id,
    candidate_trade_id: candidate?.trade_id || null,
    entry_ts_golden: normalizeTs(golden.entry_ts),
    entry_ts_candidate: normalizeTs(candidate?.entry_ts),
    trim_ts_golden: normalizeTs(golden.trim_ts),
    trim_ts_candidate: normalizeTs(candidate?.trim_ts),
    exit_ts_golden: normalizeTs(golden.exit_ts),
    exit_ts_candidate: normalizeTs(candidate?.exit_ts),
    exit_reason_golden: golden.exit_reason || null,
    exit_reason_candidate: candidate?.exit_reason || null,
    trimmed_pct_golden: golden.trimmed_pct ?? null,
    trimmed_pct_candidate: candidate?.trimmed_pct ?? null,
    entry_diffs: entryFieldDiffs,
    exit_diffs: exitFieldDiffs,
  });
}

const output = {
  generated_at: new Date().toISOString(),
  golden_autopsy: path.resolve(goldenFile),
  candidate_autopsy: path.resolve(candidateFile),
  details,
};

fs.writeFileSync(path.resolve(outputFile), JSON.stringify(output, null, 2));
console.log(path.resolve(outputFile));
console.log(JSON.stringify({
  compared: details.length,
  with_entry_diffs: details.filter((d) => d.entry_diffs.length > 0).length,
  with_exit_diffs: details.filter((d) => d.exit_diffs.length > 0).length,
}));
