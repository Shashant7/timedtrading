#!/usr/bin/env node
/**
 * Audit an in-progress Tier A force-replay session — catch scheduling loops
 * (same move_id twice) or sparse payload before hours elapse.
 *
 * Usage:
 *   TIER_A_REPLAY_SINCE=2026-06-20T00:00:00Z node scripts/audit-tier-a-session.mjs \
 *     --out-dir data/setup-mining/move-replay --expected-moves 2
 */

import fs from "node:fs";
import path from "node:path";

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (v == null || v.startsWith("--")) return fallback;
  return v;
}

const OUT_DIR = argValue("--out-dir", "data/setup-mining/move-replay");
const SINCE_RAW = argValue("--since", "") || process.env.TIER_A_REPLAY_SINCE || "";
const EXPECTED = Math.max(1, Number(argValue("--expected-moves", "1")) || 1);
const MIN_PAYLOAD = Number(argValue("--min-payload-ratio", "0.85")) || 0.85;
const MIN_EVENTS = Number(argValue("--min-events", "15")) || 15;
const sinceMs = SINCE_RAW ? Date.parse(SINCE_RAW) : null;

if (!sinceMs || !Number.isFinite(sinceMs)) {
  console.error("audit: --since or TIER_A_REPLAY_SINCE required");
  process.exit(1);
}

const sessionItems = [];
for (const f of fs.readdirSync(OUT_DIR).filter((x) => x.startsWith("summary-") && x.endsWith(".json"))) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8"));
    const summary = j.summary || {};
    const gen = Date.parse(summary.generated_at || "");
    if (!Number.isFinite(gen) || gen < sinceMs) continue;
    for (const it of summary.items || []) {
      if (!it?.move_id) continue;
      sessionItems.push({
        file: f,
        generated_at: summary.generated_at,
        move_id: String(it.move_id),
        ticker: it.ticker,
        events_derived: Number(it.events_derived) || 0,
        payload_ratio: Number(it.payload_ratio) || 0,
        sequence: it.mining?.sequence?.sequence_type || null,
      });
    }
  } catch (_) { /* skip */ }
}

sessionItems.sort((a, b) => String(a.generated_at).localeCompare(String(b.generated_at)));

const byMove = new Map();
for (const it of sessionItems) {
  if (!byMove.has(it.move_id)) byMove.set(it.move_id, []);
  byMove.get(it.move_id).push(it);
}

const uniqueMoves = byMove.size;
const duplicateMoves = [...byMove.entries()].filter(([, rows]) => rows.length > 1);

const report = {
  since: SINCE_RAW,
  summary_files_in_session: sessionItems.length,
  unique_move_ids: uniqueMoves,
  expected_unique: EXPECTED,
  moves: sessionItems.map((it) => ({
    ticker: it.ticker,
    move_id: it.move_id,
    events: it.events_derived,
    payload_ratio: it.payload_ratio,
    sequence: it.sequence,
  })),
};

console.log(JSON.stringify(report, null, 2));

let failed = false;

if (uniqueMoves < EXPECTED) {
  console.error(`AUDIT FAIL: ${uniqueMoves} unique move(s) in session, expected >= ${EXPECTED}`);
  failed = true;
}

if (duplicateMoves.length > 0) {
  console.error("AUDIT FAIL: duplicate move_id(s) in session — scheduling loop suspected:");
  for (const [moveId, rows] of duplicateMoves) {
    console.error(`  ${moveId}: ${rows.length} summaries (${rows.map((r) => r.file).join(", ")})`);
  }
  failed = true;
}

if (EXPECTED >= 2 && uniqueMoves >= 2) {
  const ids = [...byMove.keys()];
  if (ids.length >= 2 && sessionItems.length >= 2) {
    const lastTwo = sessionItems.slice(-2);
    if (lastTwo[0].move_id === lastTwo[1].move_id) {
      console.error("AUDIT FAIL: last two batches processed the same move_id");
      failed = true;
    }
  }
}

for (const it of sessionItems) {
  if (it.payload_ratio > 0 && it.payload_ratio < MIN_PAYLOAD) {
    console.error(`AUDIT FAIL: ${it.ticker} payload_ratio ${it.payload_ratio} < ${MIN_PAYLOAD}`);
    failed = true;
  }
  if (it.events_derived > 0 && it.events_derived < MIN_EVENTS) {
    console.error(`AUDIT WARN: ${it.ticker} events_derived ${it.events_derived} < ${MIN_EVENTS}`);
  }
}

if (failed) {
  console.error("=== Session audit FAILED — stop marathon and fix before continuing ===");
  process.exit(3);
}

console.log(`=== Session audit OK: ${uniqueMoves} distinct move(s), no duplicates ===`);
