/**
 * Shared sparkline settings — daily candles for trend readability on cards.
 */
(function () {
  "use strict";

  const TF = "D";
  const LIMIT = 20;

  function buildSparklineUrl(apiBase, sym) {
    const base = String(apiBase || "").replace(/\/$/, "");
    return `${base}/timed/candles?ticker=${encodeURIComponent(sym)}&tf=${TF}&limit=${LIMIT}`;
  }

  function closesFromCandles(candles) {
    if (!Array.isArray(candles)) return [];
    return candles.map((c) => Number(c?.c ?? c?.close)).filter(Number.isFinite);
  }

  function sparkClosesFromCacheEntry(entry) {
    if (Array.isArray(entry)) return entry;
    if (entry && Array.isArray(entry.closes)) return entry.closes;
    return null;
  }

  function sparkCandlesFromCacheEntry(entry) {
    if (entry && Array.isArray(entry.candles)) return entry.candles;
    return null;
  }

  window.TTSparklineConfig = {
    tf: TF,
    limit: LIMIT,
    buildSparklineUrl,
    closesFromCandles,
    sparkClosesFromCacheEntry,
    sparkCandlesFromCacheEntry,
  };
})();

// cache-bust:1783470103572:750047661
