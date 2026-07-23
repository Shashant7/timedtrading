/**
 * Universe onboard gap classification.
 *
 * Hard gaps = incomplete for trading awareness (missing scoring-TF candles
 * or no usable timed:latest score). These drive the watchdog orphan count.
 *
 * Soft gaps = heal-queue niceties (candle history quality below target, or
 * missing behavioral profile). Thin / new listings (SPCX, GRNI, …) often
 * stay soft forever without meaning the feed is broken.
 */

export function tickerHasUsableScore(latest) {
  if (!latest || typeof latest !== "object") return false;
  const price = Number(latest.price);
  // htf_score === 0 is a real neutral/weak HTF reading — do NOT treat as missing.
  // null/undefined must stay unscored (Number(null) === 0 would false-pass).
  if (latest.htf_score == null || latest.htf_score === "") return false;
  const htf = Number(latest.htf_score);
  return Number.isFinite(price) && price > 0
    && Number.isFinite(htf)
    && latest.sl != null;
}

export function classifyOnboardGap({ missing, hasProfile, hasScore, avgQuality, minQuality }) {
  const missingTfs = Array.isArray(missing) ? missing : [];
  const hard = missingTfs.length > 0 || !hasScore;
  const soft = avgQuality < minQuality || !hasProfile;
  return { hard, soft, needsHeal: hard || soft };
}
