/**
 * Universe onboard gap classification.
 *
 * Hard gaps = incomplete for trading awareness (missing scoring-TF candles
 * or no usable timed:latest score). These drive the watchdog orphan count.
 *
 * Soft gaps = heal-queue niceties (missing behavioral profile, or
 * incomplete TF coverage that is not yet a hard orphan).
 * Thin = every scoring TF has bars + score + profile, but history depth
 * is below the quality target. Thin / new listings (SPCX, SKHY, …) stay
 * thin forever without meaning the feed is broken — do not heal-loop them.
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
  // All scoring TFs have bars + a usable score + a profile. History depth
  // below the 80-quality target is expected for thin / young listings
  // (SKHY, SPCX, …) and must not keep the heal cron in permanent "partial".
  const onboarded = missingTfs.length === 0 && !!hasScore && !!hasProfile;
  const qualityShort = Number(avgQuality) < Number(minQuality);
  const thin = onboarded && qualityShort;
  const soft = !onboarded && (qualityShort || !hasProfile);
  return { hard, soft, thin, needsHeal: hard || soft };
}
