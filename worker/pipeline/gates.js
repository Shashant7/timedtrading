// worker/pipeline/gates.js
// Universal gates that apply to ALL entry engines.
// These are hard blockers — if any fails, no engine is consulted.

export function runUniversalGates(ctx) {
  const { side, scores, rvol, regime, config, ticker, state } = ctx;
  const rParams = regime.params || {};
  const daCfg = config.deepAudit || {};

  // Gate 1: RVOL Dead Zone — volume too thin for any reliable signal
  const rvolDeadZone = rParams.rvolDeadZone ?? 0.4;
  if (rvol.best < rvolDeadZone) {
    return {
      pass: false,
      reason: "rvol_dead_zone",
      rvol: rvol.best,
      threshold: rvolDeadZone,
      regime: regime.class,
    };
  }

  // Gate 2: SHORT minimum rank (applies to all engines)
  const daShortMinRank = Number(daCfg.deep_audit_short_min_rank) || 0;
  const shortMinRankEff = (config.engine === "ripster_core" && config.ripsterTuneV2 && side === "SHORT")
    ? Math.max(55, daShortMinRank - 7)
    : daShortMinRank;
  if (shortMinRankEff > 0 && side === "SHORT" && scores.rank < shortMinRankEff) {
    const isBearConfirmed = state.includes("BEAR");
    if (!isBearConfirmed) {
      return {
        pass: false,
        reason: "da_short_rank_too_low",
        rank: scores.rank,
        required: shortMinRankEff,
      };
    }
  }

  // Gate 3: Ticker blacklist (applies to all engines)
  const daBlacklist = daCfg.deep_audit_ticker_blacklist;
  if (Array.isArray(daBlacklist) && daBlacklist.length > 0) {
    if (daBlacklist.includes(ticker)) {
      return { pass: false, reason: "da_ticker_blacklisted", ticker };
    }
  }

  return { pass: true };
}
