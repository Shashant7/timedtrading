function normalizeLabel(value, fallback = null) {
  const text = String(value || "").trim();
  return text ? text.toUpperCase() : fallback;
}

export function resolveExecutionRegimeClass(value, fallback = "TRANSITIONAL") {
  return normalizeLabel(value, fallback);
}

export function resolveSwingRegimeSnapshot(tickerData) {
  return {
    market: normalizeLabel(tickerData?.regime?.market, null),
    sector: normalizeLabel(tickerData?.regime?.sector, null),
    combined: normalizeLabel(tickerData?.regime?.combined, null),
  };
}

export function resolveMarketVolatilityRegime(vix) {
  const n = Number(vix);
  if (!Number.isFinite(n)) return "UNKNOWN";
  if (n < 15) return "LOW_VOL";
  if (n < 20) return "NORMAL";
  if (n < 25) return "ELEVATED";
  if (n < 30) return "HIGH_VOL";
  return "EXTREME";
}

export function resolveMarketBackdropClass(tickerData) {
  const volatility = resolveMarketVolatilityRegime(Number(tickerData?._vix));
  if (volatility === "HIGH_VOL" || volatility === "EXTREME") return "CRISIS";
  const marketRegimeLabel = normalizeLabel(tickerData?._env?._marketRegime?.regime, "");
  const spyHtf = Number(tickerData?._env?._marketRegime?.htf_score);
  let trendBias = "SIDEWAYS";
  if (Number.isFinite(spyHtf)) {
    if (spyHtf > 5) trendBias = "UPTREND";
    else if (spyHtf < -5) trendBias = "DOWNTREND";
  } else if (marketRegimeLabel.includes("BULL") || marketRegimeLabel.includes("UPTREND")) {
    trendBias = "UPTREND";
  } else if (marketRegimeLabel.includes("BEAR") || marketRegimeLabel.includes("DOWNTREND")) {
    trendBias = "DOWNTREND";
  }
  if (trendBias === "UPTREND" && (volatility === "LOW_VOL" || volatility === "NORMAL")) return "BULL_CALM";
  if (trendBias === "UPTREND") return "BULL_ELEVATED";
  if (trendBias === "DOWNTREND" && (volatility === "LOW_VOL" || volatility === "NORMAL")) return "BEAR_CALM";
  if (trendBias === "DOWNTREND") return "BEAR_ELEVATED";
  return "CHOPPY";
}

export function resolveRegimeVocabulary(tickerData, options = {}) {
  const executionRegimeClass = resolveExecutionRegimeClass(
    tickerData?.regime_class,
    options.executionFallback || "TRANSITIONAL"
  );
  const swingRegimeSnapshot = resolveSwingRegimeSnapshot(tickerData);
  const marketVolatilityRegime = resolveMarketVolatilityRegime(
    tickerData?._vixLevel ?? tickerData?._vix ?? tickerData?._env?._vixLevel
  );
  const marketBackdropClass = resolveMarketBackdropClass(tickerData);
  const marketRegimeLabel = normalizeLabel(tickerData?._env?._marketRegime?.regime, null);
  const marketRegimeScore = Number.isFinite(Number(tickerData?._env?._marketInternals?.score))
    ? Number(tickerData._env._marketInternals.score)
    : null;
  const spyHtf = Number(tickerData?._env?._marketRegime?.htf_score);
  let marketTrendBias = "SIDEWAYS";
  if (Number.isFinite(spyHtf)) {
    if (spyHtf > 5) marketTrendBias = "UPTREND";
    else if (spyHtf < -5) marketTrendBias = "DOWNTREND";
  } else if ((marketRegimeLabel || "").includes("BULL") || (marketRegimeLabel || "").includes("UPTREND")) {
    marketTrendBias = "UPTREND";
  } else if ((marketRegimeLabel || "").includes("BEAR") || (marketRegimeLabel || "").includes("DOWNTREND")) {
    marketTrendBias = "DOWNTREND";
  }

  return {
    executionRegimeClass,
    executionRegimeScore: Number.isFinite(Number(tickerData?.regime_score)) ? Number(tickerData.regime_score) : null,
    swingRegimeSnapshot,
    marketVolatilityRegime,
    marketBackdropClass,
    marketTrendBias,
    marketRegimeLabel,
    marketRegimeScore,
  };
}
