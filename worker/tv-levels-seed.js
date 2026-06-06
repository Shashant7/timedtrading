// worker/tv-levels-seed.js
//
// TradingView Pine Seeds encoder — maps /timed/tv-levels payloads into daily
// OHLCV CSV rows (Pine request.seed cannot carry arbitrary strings).
//
// OHLCV semantics (symbol = TICKER, e.g. NVDA):
//   close  = ref price
//   high   = stop
//   low    = tp_trim
//   open   = tp_runner (falls back to tp_exit)
//   volume = rank (integer)
//
// Meta symbol TICKER_META:
//   close  = direction code (1 LONG, -1 SHORT, 0 NEUTRAL)
//   open   = in_universe (1 yes, 0 no)
//   high   = bias code (see BIAS_CODES)
//   low    = stage code (see STAGE_CODES)
//   volume = 0
//
// Level symbols TICKER_LV1 .. TICKER_LV8:
//   close  = level price
//   volume = role code (1 support, 2 resistance, 0 neutral)

export const SEED_REPO_NAME = "seed_timedtrading_levels";

export const BIAS_CODES = {
  BULL_TREND: 1,
  BULL_PULLBACK: 2,
  BEAR_TREND: 3,
  BEAR_BOUNCE: 4,
  NEUTRAL: 0,
};

export const STAGE_CODES = {
  setup: 1,
  enter: 2,
  enter_now: 3,
  in_review: 4,
  defend: 5,
  trim: 6,
  exit: 7,
};

const DIR_CODES = { LONG: 1, SHORT: -1, NEUTRAL: 0 };

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function seedDateTag(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}T`;
}

function csvRow(date, open, high, low, close, volume) {
  return `${date},${open},${high},${low},${close},${volume}`;
}

function roleCode(role) {
  const r = String(role || "").toUpperCase();
  if (r.startsWith("S")) return 1;
  if (r.startsWith("R")) return 2;
  return 0;
}

function sanitizeSeedSymbol(ticker) {
  return String(ticker || "").toUpperCase().replace(/[^A-Z0-9._]/g, "_");
}

/**
 * @param {object} payload — buildTvLevels() result (ok: true)
 * @param {Date} [asOf]
 * @returns {{ symbols: Array<{symbol, description, pricescale, csv}>, date: string }}
 */
export function encodeTvLevelsSeed(payload, asOf = new Date()) {
  const sym = sanitizeSeedSymbol(payload?.ticker);
  if (!sym) return { symbols: [], date: seedDateTag(asOf) };

  const date = seedDateTag(asOf);
  const price = num(payload?.price);
  const stop = num(payload?.stop);
  const tpTrim = num(payload?.tp_trim);
  const tpRunner = num(payload?.tp_runner) || num(payload?.tp_exit);
  const rank = Math.round(num(payload?.rank));
  const dirCode = DIR_CODES[String(payload?.direction || "NEUTRAL").toUpperCase()] ?? 0;
  const biasCode = BIAS_CODES[String(payload?.bias || "NEUTRAL").toUpperCase()] ?? BIAS_CODES.NEUTRAL;
  const stageKey = String(payload?.stage || "setup").toLowerCase();
  const stageCode = STAGE_CODES[stageKey] ?? 0;
  const inUniv = payload?.in_universe ? 1 : 0;

  const pricescale = price > 0 && price < 1 ? 10000 : price >= 1000 ? 100 : 100;

  const symbols = [];

  symbols.push({
    symbol: sym,
    description: `TT levels ${sym}`,
    pricescale,
    csv: csvRow(date, tpRunner, stop, tpTrim, price || tpTrim || stop || 1, rank),
  });

  symbols.push({
    symbol: `${sym}_META`,
    description: `TT meta ${sym}`,
    pricescale: 1,
    csv: csvRow(date, inUniv, biasCode, stageCode, dirCode, 0),
  });

  const levels = Array.isArray(payload?.levels) ? payload.levels.slice(0, 8) : [];
  levels.forEach((lv, idx) => {
    const px = num(lv?.price);
    if (px <= 0) return;
    symbols.push({
      symbol: `${sym}_LV${idx + 1}`,
      description: `TT S/R ${sym} #${idx + 1}`,
      pricescale,
      csv: csvRow(date, px, px, px, px, roleCode(lv?.role)),
    });
  });

  return { symbols, date };
}

/**
 * Build symbol_info JSON for Pine Seeds repo.
 */
export function buildSeedSymbolInfo(symbols, repoName = SEED_REPO_NAME) {
  const list = symbols || [];
  return {
    fileName: `${repoName}.json`,
    body: {
      symbol: list.map((s) => s.symbol),
      pricescale: list.map((s) => s.pricescale),
      description: list.map((s) => String(s.description || s.symbol).slice(0, 128)),
    },
  };
}
