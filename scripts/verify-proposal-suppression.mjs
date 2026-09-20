#!/usr/bin/env node
/**
 * Replay the nightly scorecard's proposal-submission guards against the live
 * card and the live demotion markers (added 2026-09-20).
 *
 * The submission loop in worker/index.js applies three filters before it files
 * a demotion proposal, and each one was added after a run that should not have
 * produced a row:
 *
 *   1. recovered30d   — the family already healed on the 30d window
 *   2. isCalibrationPlay — protected by role (resolves paper siblings since
 *                          the 2026-09-20 sibling_paths fix)
 *   3. already-at-value  — submitProposal drops a no-op, because a no-op
 *                          applies instantly and leaves 'pending', so the
 *                          pending-dedupe never catches the next copy
 *
 * This imports the same modules the worker runs, so a candidate that reports
 * SUPPRESSED here files nothing tonight.
 *
 * Usage:
 *   curl -s -H "X-API-Key: $TIMED_API_KEY" \
 *     https://timed-trading-ingest.shashant.workers.dev/timed/admin/edge-scorecard \
 *     > /tmp/card.json
 *   wrangler d1 execute --env production --remote timed-trading-ledger --json \
 *     --command "SELECT config_key, config_value FROM model_config
 *                WHERE config_key LIKE 'deep_audit_setup_demotion%';" > /tmp/markers.json
 *   node scripts/verify-proposal-suppression.mjs --card /tmp/card.json --markers /tmp/markers.json
 */

import { readFileSync } from "node:fs";
import { recovered30d } from "../worker/learning-desk-review.js";
import { isCalibrationPlay } from "../worker/foundation/play-catalog.js";
import { demotionProposalConfigKey } from "../worker/pipeline/setup-demotion.js";
import { normalizeConfigValue } from "../worker/learning-proposals.js";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

function markerMap(raw) {
  const start = raw.indexOf("[");
  const rows = JSON.parse(raw.slice(start))[0]?.results ?? [];
  return Object.fromEntries(rows.map((r) => [r.config_key, r.config_value]));
}

/** Mirrors the guard order in the nightly block in worker/index.js. */
export function classifyCandidate(cand, { recoveredKeys, markers }) {
  const key = demotionProposalConfigKey(cand.setup, cand.direction)
    || `deep_audit_setup_demotion_${cand.setup}_${String(cand.direction || "").toLowerCase()}`;
  if (recoveredKeys.has(key)) return { key, filed: false, guard: "recovered30d" };
  if (isCalibrationPlay(cand.setup, cand.direction)) return { key, filed: false, guard: "isCalibrationPlay" };
  const current = markers[key];
  if (current != null && normalizeConfigValue(current) === normalizeConfigValue("blocked")) {
    return { key, filed: false, guard: "already_at_proposed_value" };
  }
  return { key, filed: true, guard: null };
}

function main() {
  const card = JSON.parse(readFileSync(arg("--card"), "utf8"));
  const markers = markerMap(readFileSync(arg("--markers"), "utf8"));
  const recoveredKeys = new Set(
    (card.per_setup_d30 || [])
      .filter((s) => recovered30d(s.stats))
      .map((s) => demotionProposalConfigKey(s.setup, s.direction))
      .filter(Boolean),
  );

  console.log("=".repeat(78));
  console.log("NIGHTLY PROPOSAL SUBMISSION — replayed against the live card");
  console.log("=".repeat(78));
  console.log(`  candidates on the card: ${(card.demotion_candidates || []).length}`);
  console.log(`  live demotion markers : ${Object.keys(markers).length}`);
  console.log(`  recovered-30d keys    : ${recoveredKeys.size}\n`);

  let filed = 0;
  for (const cand of (card.demotion_candidates || []).slice(0, 5)) {
    const r = classifyCandidate(cand, { recoveredKeys, markers });
    if (r.filed) filed += 1;
    console.log(`  ${r.filed ? "FILES" : "SUPPRESSED"}  ${String(cand.setup).padEnd(22)} ${String(cand.direction).padEnd(6)}`
      + ` PF ${String(cand.profit_factor).padEnd(5)} n=${String(cand.n).padEnd(4)} $${cand.pnl_usd}`);
    console.log(`      key   : ${r.key}`);
    console.log(`      marker: ${markers[r.key] ?? "(none)"}`);
    console.log(`      guard : ${r.guard ?? "none — this one is a real proposal"}\n`);
  }
  console.log(`  tonight's run files ${filed} proposal(s).`);
}

// Guarded on the argument rather than on import.meta.url: vite-node resolves
// process.argv[1] relatively, so the usual direct-invocation check never
// matches there and the script silently does nothing.
if (arg("--card")) main();
