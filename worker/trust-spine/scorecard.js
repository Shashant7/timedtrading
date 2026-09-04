// Trust Spine — attribution scorecard (config_hash epochs → outcomes).

export function scoreEpochMetrics(epochRows = [], tradeRows = []) {
  const byHash = {};
  for (const t of tradeRows || []) {
    const h = t.config_hash || "unknown";
    if (!byHash[h]) byHash[h] = { wins: 0, losses: 0, pnl: 0, n: 0 };
    const pnl = Number(t.pnl) || 0;
    byHash[h].pnl += pnl;
    byHash[h].n += 1;
    if (pnl > 0) byHash[h].wins += 1;
    else if (pnl < 0) byHash[h].losses += 1;
  }

  const epochs = (epochRows || []).map((e) => {
    const h = e.config_hash;
    const perf = byHash[h] || { wins: 0, losses: 0, pnl: 0, n: 0 };
    const closed = perf.wins + perf.losses;
    const wr = closed > 0 ? +(perf.wins / closed * 100).toFixed(1) : null;
    return {
      config_hash: h,
      decision_rows: Number(e.decisions) || 0,
      entries: Number(e.entries) || 0,
      closed_trades: closed,
      win_rate: wr,
      net_pnl: +perf.pnl.toFixed(2),
    };
  });

  // F24 (2026-09-04 ledger audit) — the old bar (2 epochs, ANY epoch with
  // 5 closes) could declare the loop "ready" on five trades of evidence.
  // Readiness now requires two epochs that EACH have a minimum closed
  // sample, at least one of them with attributed decision rows — a loop
  // whose epochs never recorded decisions has nothing to learn from.
  const CLOSED_LOOP_MIN_TRADES_PER_EPOCH = 15;
  const qualifyingEpochs = epochs.filter(
    (e) => e.closed_trades >= CLOSED_LOOP_MIN_TRADES_PER_EPOCH,
  );
  return {
    generated_at: Date.now(),
    epoch_count: epochs.length,
    epochs,
    closed_loop_ready:
      qualifyingEpochs.length >= 2
      && qualifyingEpochs.some((e) => e.decision_rows > 0),
    closed_loop_min_trades_per_epoch: CLOSED_LOOP_MIN_TRADES_PER_EPOCH,
  };
}
