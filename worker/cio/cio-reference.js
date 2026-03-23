// worker/cio/cio-reference.js
// Reference-memory helpers for CIO priors and neighbor context.

function asObj(v) {
  return v && typeof v === "object" ? v : null;
}

function asNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function getReferencePriors(sym, direction, entryPath, sector, referenceFeatures) {
  const root = asObj(referenceFeatures);
  const priors = asObj(root?.priors);
  if (!priors) return null;

  const keyTicker = String(sym || "").toUpperCase();
  const keyTickerDir = `${keyTicker}|${String(direction || "").toUpperCase()}`;
  const keyPathDir = `${String(entryPath || "unknown")}|${String(direction || "").toUpperCase()}`;
  const keySectorDir = `${String(sector || "unknown")}|${String(direction || "").toUpperCase()}`;

  const ticker = asObj(priors?.ticker?.[keyTicker]);
  const tickerDirection = asObj(priors?.ticker_direction?.[keyTickerDir]);
  const pathDirection = asObj(priors?.entry_path_direction?.[keyPathDir]);
  const sectorDirection = asObj(priors?.sector_direction?.[keySectorDir]);
  if (!ticker && !tickerDirection && !pathDirection && !sectorDirection) return null;

  // Weighted confidence prior (prefer path+ticker-direction, fallback ticker/sector).
  const cPath = asNum(pathDirection?.confidence_prior, NaN);
  const cTDir = asNum(tickerDirection?.confidence_prior, NaN);
  const cTicker = asNum(ticker?.confidence_prior, NaN);
  const cSector = asNum(sectorDirection?.confidence_prior, NaN);

  const vals = [];
  if (Number.isFinite(cPath)) vals.push({ w: 0.4, v: cPath });
  if (Number.isFinite(cTDir)) vals.push({ w: 0.3, v: cTDir });
  if (Number.isFinite(cTicker)) vals.push({ w: 0.2, v: cTicker });
  if (Number.isFinite(cSector)) vals.push({ w: 0.1, v: cSector });
  let merged = null;
  if (vals.length > 0) {
    const sw = vals.reduce((s, x) => s + x.w, 0) || 1;
    merged = vals.reduce((s, x) => s + x.w * x.v, 0) / sw;
  }

  return {
    ticker,
    ticker_direction: tickerDirection,
    entry_path_direction: pathDirection,
    sector_direction: sectorDirection,
    merged_confidence_prior: Number.isFinite(merged) ? Math.max(0, Math.min(1, +merged.toFixed(4))) : null,
  };
}

