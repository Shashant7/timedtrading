#!/usr/bin/env node
/**
 * Replay the shipped Cloud Pivot exit evaluator against real tickets.
 *
 * Two questions, both answered against the live ledger's own numbers:
 *   1. Would the loss cap have caught the 2026-09-04 deep losers?
 *   2. Does it leave the currently open trimmed runners alone?
 *
 * Usage: npx vite-node scripts/verify-cloud-pivot-loss-cap.mjs
 */

import {
  evaluateTtCloudPivotExit,
  loadCloudPivotConfig,
  CLOUD_PIVOT_FAMILY,
} from "../worker/foundation/tt-cloud-pivot.js";

/**
 * A payload with healthy clouds in the trade's direction, so nothing but the
 * loss cap or the profit lock can fire. The 5/12 print is deliberately absent
 * on one case to prove the cap does not wait for it.
 */
function payload({ direction = "LONG", with512 = true } = {}) {
  const long = direction === "LONG";
  const c5_12 = with512
    ? { bull: long, bear: !long, above: !long, below: long, inCloud: false, crossUp: false, crossDn: false }
    : null;
  return {
    tf_tech: {
      10: { ripster: { c5_12, c34_50: { bull: long, bear: !long, above: long, below: !long } } },
      "1H": { ripster: { c34_50: { bull: long, bear: !long, above: long, below: !long } } },
    },
  };
}

function evaluate(t) {
  return evaluateTtCloudPivotExit({
    tickerData: payload({ direction: t.direction, with512: t.with512 !== false }),
    openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: t.direction },
    direction: t.direction,
    currentPrice: 100,
    pnlPct: t.pnlPct,
    mfePct: t.mfe,
    positionAgeMin: t.ageMin ?? 400,
    trimmedPct: t.trimmed ?? 0,
    daCfg: {},
  });
}

// The four 2026-09-04 tickets that ran past -5%, at the drawdown the cap
// would have seen (their realized exit percent), plus the two still open.
const CLOSED_DISASTERS = [
  { ticker: "EXPE", direction: "LONG", pnlPct: -6.25, mfe: 0.96, trimmed: 0, realized: -54.00 },
  { ticker: "ULTA", direction: "LONG", pnlPct: -5.13, mfe: 0.10, trimmed: 0, realized: -27.14 },
  { ticker: "TSLA", direction: "SHORT", pnlPct: -5.83, mfe: 0.00, trimmed: 0, realized: -24.72 },
  { ticker: "BG", direction: "SHORT", pnlPct: -6.15, mfe: 0.00, trimmed: 0, realized: -15.42 },
];

// Pulled live: SELECT ticker, entry_path, pnl_pct, max_favorable_excursion,
// trimmed_pct FROM trades WHERE setup_name='TT Cloud Pivot' AND status='OPEN'
const OPEN_BOOK = [
  { ticker: "CVNA", direction: "SHORT", pnlPct: 5.76, mfe: 13.13, trimmed: 0.75 },
  { ticker: "JD", direction: "SHORT", pnlPct: 4.17, mfe: 7.44, trimmed: 0.5 },
];

// Winners that dipped deep AFTER banking half — the case an ungated
// whole-life MAE cap would have destroyed.
const PROVEN_RUNNERS = [
  { ticker: "RBLX", direction: "LONG", pnlPct: -4.37, mfe: 5.68, trimmed: 0.5, realized: 13.53 },
  { ticker: "CAT", direction: "LONG", pnlPct: -2.03, mfe: 21.55, trimmed: 0, realized: -20.19 },
  { ticker: "TJX", direction: "LONG", pnlPct: -3.98, mfe: 12.43, trimmed: 0, realized: -54.99 },
];

const cfg = loadCloudPivotConfig({});
console.log("shipped defaults: loss cap %s%%  (enabled=%s)  profit-lock arm %s%%",
  (cfg.lossCapPct * 100).toFixed(2), cfg.lossCapEnabled, (cfg.profitLockArmPct * 100).toFixed(2));

let failures = 0;
function report(label, rows, expectCap) {
  console.log(`\n${label}`);
  console.log(`  ${"ticker".padEnd(8)}${"dir".padEnd(7)}${"drawdown".padEnd(11)}${"MFE".padEnd(9)}${"trim".padEnd(7)}${"verdict".padEnd(34)}result`);
  for (const t of rows) {
    const dec = evaluate(t);
    const capped = dec?.reason === "tt_cloud_pivot_loss_cap";
    const ok = capped === expectCap;
    if (!ok) failures += 1;
    console.log(
      `  ${t.ticker.padEnd(8)}${t.direction.padEnd(7)}`
      + `${`${t.pnlPct}%`.padEnd(11)}${`${t.mfe}%`.padEnd(9)}${String(t.trimmed).padEnd(7)}`
      + `${String(dec?.reason ?? "(no family exit)").padEnd(34)}${ok ? "PASS" : "FAIL"}`
      + (t.realized != null ? `   [realized $${t.realized}]` : ""),
    );
  }
}

report("1. 2026-09-04 deep losers — the cap MUST fire", CLOSED_DISASTERS, true);
report("2. Currently open trimmed runners — the cap MUST NOT fire", OPEN_BOOK, false);
report("3. Trades that proved themselves — the profit lock owns these, not the cap", PROVEN_RUNNERS, false);

console.log("\n4. The cap must not wait on a 10m 5/12 print (the TJX-class bug)");
const noPrint = evaluate({ ticker: "EXPE", direction: "LONG", pnlPct: -6.25, mfe: 0.96, with512: false });
const noPrintOk = noPrint?.reason === "tt_cloud_pivot_loss_cap";
if (!noPrintOk) failures += 1;
console.log(`  5/12 print absent, drawdown -6.25%, MFE 0.96% -> ${noPrint?.reason ?? "(no family exit)"}  ${noPrintOk ? "PASS" : "FAIL"}`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
