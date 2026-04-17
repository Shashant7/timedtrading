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
  // Accept JSON-array, CSV, or bare single-ticker strings so that pinned
  // backtest_run_config values like "ABT" or "[\"ABT\"]" behave identically.
  // Previously this gate only fired when the value was already an Array, which
  // silently bypassed the blacklist any time JSON.parse() fell through to the
  // raw string form during replay runtime loading.
  const daBlacklistRaw = daCfg.deep_audit_ticker_blacklist;
  const daBlacklist = Array.isArray(daBlacklistRaw)
    ? daBlacklistRaw.map((t) => String(t || "").trim().toUpperCase()).filter(Boolean)
    : typeof daBlacklistRaw === "string" && daBlacklistRaw.trim().length > 0
      ? daBlacklistRaw.split(",").map((t) => String(t || "").trim().toUpperCase()).filter(Boolean)
      : [];
  if (daBlacklist.length > 0) {
    const symNorm = String(ticker || "").toUpperCase();
    if (daBlacklist.includes(symNorm)) {
      return { pass: false, reason: "da_ticker_blacklisted", ticker: symNorm };
    }
  }

  return { pass: true };
}
