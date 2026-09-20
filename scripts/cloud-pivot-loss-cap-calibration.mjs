#!/usr/bin/env node
/**
 * Cloud Pivot loss-cap calibration (2026-09-20 weekend review).
 *
 * The weekly governor and the edge scorecard both proposed blocking
 * `TT Cloud Pivot Long`. This sweep exists to answer the question the
 * proposals did not ask: is the long leg edgeless, or is it an exit
 * defect?
 *
 * Input is the closed live record pulled from D1:
 *
 *   wrangler d1 execute --env production --remote timed-trading-ledger --json \
 *     --command "SELECT ticker, entry_path, pnl, pnl_pct, max_favorable_excursion,
 *       max_adverse_excursion, exit_reason, trimmed_pct,
 *       datetime(entry_ts/1000,'unixepoch') entry
 *       FROM trades WHERE setup_name='TT Cloud Pivot' AND status IN ('WIN','LOSS');" \
 *     > cloud-pivot-trades.json
 *
 * Usage:
 *   npx vite-node scripts/cloud-pivot-loss-cap-calibration.mjs --trades cloud-pivot-trades.json
 *
 * The counterfactual is deliberately pessimistic about the cap and
 * generous to the status quo:
 *   - A trade whose MAE is past the cap is re-priced as if it had exited
 *     at the cap, scaled by its own dollars-per-percent.
 *   - Gap-through is modelled: when a trade's realized exit landed at or
 *     past its own MAE (it never got a fill above the low), the cap is
 *     charged an extra slippage allowance rather than assumed to fill.
 *   - Winners that dipped past the cap before working are fully forfeited
 *     at the capped loss. No credit is taken for re-entry.
 */

const SLIPPAGE_PP = 0.35; // extra loss charged when the adverse move gapped

function parseArgs(argv) {
  const out = { trades: null, caps: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--trades") out.trades = argv[i + 1];
    if (argv[i] === "--caps") out.caps = argv[i + 1];
  }
  return out;
}

/** wrangler --json prints config warnings before the payload. */
export function extractRows(raw) {
  const start = raw.indexOf("[");
  if (start < 0) throw new Error("no JSON array in input");
  const parsed = JSON.parse(raw.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? first ?? [];
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Re-price one closed trade under the proposed cap.
 *
 * The cap is deliberately NOT a whole-life MAE stop. `max_adverse_excursion`
 * spans the entire hold, so a naive cap would forfeit a runner that dipped
 * only AFTER the profit lock had already banked half (RBLX long: +$13.53
 * realized on a -4.37% whole-life MAE). Instead the cap is gated to trades
 * that never proved themselves:
 *
 *   not trimmed  AND  MFE < profit-lock arm  AND  MAE past the cap
 *
 * Once MFE clears the arm, or half is already banked, the existing
 * profit-lock / ribbon-trail machinery owns the exit and the cap stands down.
 */
export function repriceUnderCap(trade, capPct, armPct = 1.2) {
  const pnl = num(trade.pnl);
  const pnlPct = num(trade.pnl_pct);
  const mae = Math.abs(num(trade.max_adverse_excursion));
  const mfe = Math.abs(num(trade.max_favorable_excursion));

  if (num(trade.trimmed_pct) > 0) return pnl; // already banked; lock owns it
  if (mfe >= armPct) return pnl; // armed the profit lock; lock owns it
  if (mae < capPct) return pnl; // never reached the cap

  // Dollars per percentage point for this ticket. Fall back to the MAE
  // leg when the trade closed at ~0% (a flat scratch carries no scale).
  const perPp = Math.abs(pnlPct) > 0.05
    ? Math.abs(pnl / pnlPct)
    : Math.abs(pnl) / Math.max(mae, 0.01);
  if (!Number.isFinite(perPp) || perPp <= 0) return pnl;

  // Did the realized exit land at or past its own worst print? Then the
  // adverse move never offered a fill on the way down and the cap gaps.
  const gapped = pnlPct <= -(mae - 0.05);
  const effective = Math.min(capPct + (gapped ? SLIPPAGE_PP : 0), mae);

  // A cap is a hard exit: the trade ends there whether it would later have
  // recovered to a smaller loss or bled further. Both directions counted.
  return -effective * perPp;
}

function summarize(rows, pnlOf) {
  const wins = rows.filter((r) => pnlOf(r) > 0);
  const losses = rows.filter((r) => pnlOf(r) <= 0);
  const gp = wins.reduce((a, r) => a + pnlOf(r), 0);
  const gl = Math.abs(losses.reduce((a, r) => a + pnlOf(r), 0));
  return {
    n: rows.length,
    wr: rows.length ? (100 * wins.length) / rows.length : 0,
    pnl: rows.reduce((a, r) => a + pnlOf(r), 0),
    pf: gl > 0 ? gp / gl : Infinity,
  };
}

const fmtPf = (pf) => (Number.isFinite(pf) ? pf.toFixed(2) : "inf");

function line(label, s) {
  return `  ${label.padEnd(26)} n=${String(s.n).padEnd(3)} WR=${s.wr.toFixed(1).padStart(5)}%  `
    + `pnl=$${s.pnl.toFixed(2).padStart(8)}  PF=${fmtPf(s.pf).padStart(5)}`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.trades) {
    console.error("usage: --trades <d1-json> [--caps 2,2.5,3]");
    process.exit(1);
  }
  const fs = await import("node:fs");
  const rows = extractRows(fs.readFileSync(args.trades, "utf8"))
    .filter((r) => r.entry_path && String(r.entry_path).startsWith("tt_cloud_pivot"));
  const caps = (args.caps || "1.5,2,2.25,2.5,2.75,3,3.5,4,5")
    .split(",").map(Number).filter((n) => n > 0);

  const sides = [
    ["family (both legs)", () => true],
    ["long leg", (r) => r.entry_path === "tt_cloud_pivot_long"],
    ["short leg", (r) => r.entry_path === "tt_cloud_pivot_short"],
  ];

  console.log("=".repeat(78));
  console.log("CLOUD PIVOT — LIVE RECORD AS TRADED");
  console.log("=".repeat(78));
  for (const [label, pred] of sides) {
    console.log(line(label, summarize(rows.filter(pred), (r) => num(r.pnl))));
  }

  const trimmed = rows.filter((r) => num(r.trimmed_pct) > 0);
  const untrimmed = rows.filter((r) => num(r.trimmed_pct) === 0);
  console.log("\n  -- the split the block proposals missed --");
  console.log(line("trim fired", summarize(trimmed, (r) => num(r.pnl))));
  console.log(line("trim never fired", summarize(untrimmed, (r) => num(r.pnl))));

  console.log(`\n${"=".repeat(78)}`);
  console.log(`LOSS-CAP SWEEP (gap slippage allowance ${SLIPPAGE_PP}pp)`);
  console.log("=".repeat(78));
  for (const [label, pred] of sides) {
    const subset = rows.filter(pred);
    console.log(`\n  ${label}`);
    console.log(`    ${"cap".padEnd(8)}${"n_capped".padEnd(10)}${"pnl".padEnd(12)}${"PF".padEnd(8)}${"WR".padEnd(8)}delta`);
    const base = summarize(subset, (r) => num(r.pnl));
    for (const cap of caps) {
      const priced = new Map(subset.map((r) => [r, repriceUnderCap(r, cap)]));
      const s = summarize(subset, (r) => priced.get(r));
      const nCapped = subset.filter((r) => priced.get(r) !== num(r.pnl)).length;
      console.log(
        `    ${(`${cap}%`).padEnd(8)}${String(nCapped).padEnd(10)}`
        + `$${s.pnl.toFixed(2).padEnd(11)}${fmtPf(s.pf).padEnd(8)}`
        + `${s.wr.toFixed(1).padEnd(8)}${(s.pnl - base.pnl >= 0 ? "+" : "")}$${(s.pnl - base.pnl).toFixed(2)}`,
      );
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log("WHAT EACH CAP TOUCHES — helped vs hurt, trade by trade");
  console.log("=".repeat(78));
  for (const cap of caps) {
    const touched = rows
      .map((r) => ({ r, delta: repriceUnderCap(r, cap) - num(r.pnl) }))
      .filter((x) => Math.abs(x.delta) > 0.005);
    const helped = touched.filter((x) => x.delta > 0);
    const hurt = touched.filter((x) => x.delta < 0);
    const net = touched.reduce((a, x) => a + x.delta, 0);
    console.log(
      `\n  cap ${(`${cap}%`).padEnd(6)} touches ${String(touched.length).padStart(2)}  `
      + `helped ${helped.length} (+$${helped.reduce((a, x) => a + x.delta, 0).toFixed(2)})  `
      + `hurt ${hurt.length} (-$${Math.abs(hurt.reduce((a, x) => a + x.delta, 0)).toFixed(2)})  `
      + `net ${net >= 0 ? "+" : ""}$${net.toFixed(2)}`,
    );
    const forfeitedWinners = touched.filter((x) => num(x.r.pnl) > 0);
    if (forfeitedWinners.length) {
      console.log(`      winners forfeited: ${forfeitedWinners
        .map((x) => `${x.r.ticker} +$${num(x.r.pnl).toFixed(2)}`).join(", ")}`);
    } else {
      console.log("      winners forfeited: none");
    }
    for (const x of touched.sort((a, b) => b.delta - a.delta).slice(0, 4)) {
      console.log(
        `      ${x.r.ticker.padEnd(6)} ${String(x.r.entry_path).replace("tt_cloud_pivot_", "").padEnd(6)}`
        + ` MAE ${num(x.r.max_adverse_excursion).toFixed(2)}%  MFE ${num(x.r.max_favorable_excursion).toFixed(2)}%`
        + `  $${num(x.r.pnl).toFixed(2)} -> $${repriceUnderCap(x.r, cap).toFixed(2)}`
        + `  (${x.delta >= 0 ? "+" : ""}$${x.delta.toFixed(2)})  ${x.r.exit_reason}`,
      );
    }
  }

  orderSafetyAudit(rows, caps);
}

/**
 * The counterfactual above gates on whole-life MFE, but live the engine only
 * knows MFE-so-far at the moment the drawdown hits the cap. `trade_trajectories`
 * stores regime cells, not a price path, so the ordering is not recoverable
 * from the ledger. Rather than assume it away, classify every trade:
 *
 *   order-proof   whole-life MFE < arm, so MFE-so-far was below arm for the
 *                 entire hold and the live decision is identical.
 *   order-safe    already trimmed. A trim only fires on giveback from a peak
 *                 past the arm, so the arm was cleared before the drawdown.
 *   order-RISK    untrimmed and whole-life MFE >= arm. If the drawdown came
 *                 first, live would cap a trade this model leaves alone.
 *
 * The worst case charges every order-RISK trade as if the cap had fired.
 */
export function orderSafetyAudit(rows, caps, armPct = 1.2) {
  console.log(`\n${"=".repeat(78)}`);
  console.log("ORDER-SAFETY AUDIT — MFE/MAE sequence is not in the ledger");
  console.log("=".repeat(78));
  for (const cap of caps) {
    const reach = rows.filter((r) => Math.abs(num(r.max_adverse_excursion)) >= cap);
    const proof = reach.filter((r) => num(r.trimmed_pct) === 0 && Math.abs(num(r.max_favorable_excursion)) < armPct);
    const safe = reach.filter((r) => num(r.trimmed_pct) > 0);
    const risk = reach.filter((r) => num(r.trimmed_pct) === 0 && Math.abs(num(r.max_favorable_excursion)) >= armPct);

    const modelled = rows.reduce((a, r) => a + repriceUnderCap(r, cap, armPct), 0);
    // Worst case: the order-RISK trades get capped too.
    const worst = modelled + risk.reduce((a, r) => {
      const perPp = Math.abs(num(r.pnl_pct)) > 0.05
        ? Math.abs(num(r.pnl) / num(r.pnl_pct))
        : Math.abs(num(r.pnl)) / Math.max(Math.abs(num(r.max_adverse_excursion)), 0.01);
      return a + (-cap * perPp - num(r.pnl));
    }, 0);
    const asTraded = rows.reduce((a, r) => a + num(r.pnl), 0);
    console.log(
      `  cap ${(`${cap}%`).padEnd(6)} reach=${String(reach.length).padStart(2)}`
      + `  order-proof=${String(proof.length).padStart(2)}`
      + `  order-safe(trimmed)=${String(safe.length).padStart(2)}`
      + `  order-RISK=${String(risk.length).padStart(2)}`
      + `   modelled $${modelled.toFixed(2).padStart(7)}`
      + `   worst-case $${worst.toFixed(2).padStart(7)}`
      + `   (as traded $${asTraded.toFixed(2)})`,
    );
    if (risk.length) {
      console.log(`      order-RISK: ${risk
        .map((r) => `${r.ticker}/${String(r.entry_path).replace("tt_cloud_pivot_", "")} MFE ${num(r.max_favorable_excursion).toFixed(2)}% MAE ${num(r.max_adverse_excursion).toFixed(2)}% $${num(r.pnl).toFixed(2)}`)
        .join("; ")}`);
    }
  }
  console.log("\n  A cap is safe to ship when the worst case still beats as-traded.");
}

// vite-node leaves argv[1] relative, so resolve before comparing.
const invokedDirectly = process.argv[1]
  && import.meta.url === (await import("node:url")).pathToFileURL(
    (await import("node:path")).resolve(process.argv[1]),
  ).href;

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
