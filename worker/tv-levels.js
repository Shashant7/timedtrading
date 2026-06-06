// worker/tv-levels.js
//
// Compact TradingView overlay payload. Pine Script cannot call HTTP, so
// operators copy `compact` from GET /timed/tv-levels into the indicator
// "TT Sync string" input.

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function biasFromState(state) {
  const s = String(state || "").toUpperCase();
  if (s === "HTF_BULL_LTF_PULLBACK") return "BULL_PULLBACK";
  if (s === "HTF_BULL_LTF_BULL") return "BULL_TREND";
  if (s === "HTF_BEAR_LTF_BEAR") return "BEAR_TREND";
  if (s === "HTF_BEAR_LTF_PULLBACK") return "BEAR_BOUNCE";
  return "NEUTRAL";
}

function encodeLevelChunk(level) {
  const price = num(level?.price);
  if (price == null) return null;
  const label = String(level?.label || level?.kind || "Level").replace(/[|;]/g, " ").slice(0, 40);
  const role = String(level?.role || "").toUpperCase().startsWith("S") ? "S"
    : String(level?.role || "").toUpperCase().startsWith("R") ? "R"
    : "N";
  return `${price}:${label}:${role}`;
}

/**
 * Build compact pipe string for Pine overlay parser.
 * TTV1|in_univ|dir|bias|stage|rank|stop|tp1|tp2|tp3|levels...
 */
export function formatTvLevelsCompact(payload) {
  const levels = (payload?.levels || [])
    .map(encodeLevelChunk)
    .filter(Boolean)
    .join(";");
  const fields = [
    "TTV1",
    payload?.in_universe ? "1" : "0",
    String(payload?.direction || "NEUTRAL"),
    String(payload?.bias || "NEUTRAL"),
    String(payload?.stage || "setup"),
    String(num(payload?.rank) ?? ""),
    num(payload?.stop) != null ? String(payload.stop) : "",
    num(payload?.tp_trim) != null ? String(payload.tp_trim) : "",
    num(payload?.tp_exit) != null ? String(payload.tp_exit) : "",
    num(payload?.tp_runner) != null ? String(payload.tp_runner) : "",
    levels,
  ];
  return fields.join("|");
}

/**
 * @param {object} deps
 * @param {(env,ticker)=>Promise<object|null>} deps.buildTraderPredictionContract
 * @param {(env,ticker)=>Promise<object|null>} [deps.buildTickerScenario]
 * @param {(ticker:string)=>boolean} deps.isInUniverse
 */
export async function buildTvLevels(env, ticker, deps) {
  const sym = String(ticker || "").toUpperCase().trim();
  if (!sym) return { ok: false, error: "missing_ticker" };

  const inUniverse = deps.isInUniverse(sym);
  const contract = await deps.buildTraderPredictionContract(env, sym);
  if (!contract) {
    return {
      ok: false,
      error: "prediction_not_found",
      ticker: sym,
      in_universe: inUniverse,
    };
  }

  let scenario = null;
  if (typeof deps.buildTickerScenario === "function") {
    try {
      scenario = await deps.buildTickerScenario(env, sym);
    } catch (_) { /* optional */ }
  }

  const targets = Array.isArray(contract?.targets) ? contract.targets : [];
  const findTarget = (label) => {
    const row = targets.find((t) => String(t?.label || "").toLowerCase() === label);
    return num(row?.price);
  };

  const payload = {
    ticker: sym,
    in_universe: inUniverse,
    direction: contract?.direction || "NEUTRAL",
    bias: scenario?.bias || biasFromState(contract?.state),
    stage: contract?.kanban_stage || contract?.stage || "setup",
    rank: num(contract?.rank),
    price: num(contract?.price),
    stop: num(contract?.risk?.stop_loss),
    tp_trim: findTarget("trim"),
    tp_exit: findTarget("exit"),
    tp_runner: findTarget("runner"),
    rr: num(contract?.risk?.rr),
    confidence: contract?.confidence || null,
    action_label: contract?.action_label || null,
    levels: Array.isArray(contract?.levels)
      ? contract.levels.slice(0, 8).map((l) => ({
        price: num(l?.price),
        label: l?.label || l?.kind || "Level",
        role: l?.role || "neutral",
      })).filter((l) => l.price != null)
      : [],
    generated_at: new Date().toISOString(),
    source: "tv-levels.v1",
  };

  return {
    ok: true,
    ...payload,
    compact: formatTvLevelsCompact(payload),
    paste_hint: "Copy the compact field into TradingView → TimedTrading Levels Overlay → TT Sync string",
  };
}
