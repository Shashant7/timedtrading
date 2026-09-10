// Shared by the legacy scoring report and offline regression tests.
function measureOutcome(trail, entryIdx, direction, holdBars) {
  const entry = trail[entryIdx];
  const entryPrice = entry.price;
  const endIdx = Math.min(trail.length - 1, entryIdx + holdBars);

  let mfe = 0;       // Max Favorable Excursion (best unrealized gain)
  let mae = 0;       // Max Adverse Excursion (worst unrealized drawdown)
  let tp1FirstTs = null;
  let slFirstTs = null;
  let firstBarrier = null;
  let exitPrice = entryPrice;
  let exitTs = entry.ts;

  for (let i = entryIdx + 1; i <= endIdx; i++) {
    const p = trail[i];
    if (!Number.isFinite(p.price) || p.price <= 0) continue;

    const pnlPct = direction === "LONG"
      ? (p.price - entryPrice) / entryPrice
      : (entryPrice - p.price) / entryPrice;

    // First passage, not timestamps of the eventual extrema. A later rally
    // cannot undo a stop which was touched earlier in this observed path.
    if (pnlPct >= 0.00618 && tp1FirstTs === null) {
      tp1FirstTs = p.ts;
      if (firstBarrier === null) firstBarrier = "target";
    }
    if (pnlPct <= -0.015 && slFirstTs === null) {
      slFirstTs = p.ts;
      if (firstBarrier === null) firstBarrier = "stop";
    }

    if (pnlPct > mfe) { mfe = pnlPct; }
    if (pnlPct < mae) { mae = pnlPct; }

    exitPrice = p.price;
    exitTs = p.ts;
  }

  const finalPnlPct = direction === "LONG"
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice;

  // Fixed percentage barriers; these are not ATR-based levels.
  // TP1 = 0.618%, TP2 = 1.0%, XP = 1.618%
  // SL = -1.5% adverse
  const hitTP1 = mfe >= 0.00618; // 0.618% gain
  const hitTP2 = mfe >= 0.01;    // 1.0% gain
  const hitXP  = mfe >= 0.01618; // 1.618% gain
  const hitSL  = mae <= -0.015;  // 1.5% adverse

  // Observed trail prices only: intrabar crossings are not reconstructed.
  const isWin = firstBarrier === "target";
  const isLoss = firstBarrier === "stop";

  return {
    entryPrice,
    exitPrice,
    entryTs: entry.ts,
    exitTs,
    finalPnlPct,
    mfe,
    mae,
    hitTP1,
    hitTP2,
    hitXP,
    hitSL,
    isWin,
    isLoss,
    firstBarrier,
    tp1FirstTs,
    slFirstTs,
    completeWindow: entryIdx + holdBars < trail.length,
    holdMinutes: (exitTs - entry.ts) / 60000,
  };
}

module.exports = { measureOutcome };
