/** Pure bubble-map visual encode helpers (mirrored in shared-bubble-chart.js). */

export const ALIGN_FILL = {
  bull_aligned: "#22c55e",
  bull_mixed: "#22c55e",
  pullback: "#eab308",
  bear_aligned: "#b91c1c",
  bear_mixed: "#b91c1c",
  neutral: "#64748b",
};

/** Align state → fill bucket (legend semantics).
 * Production emits HTF_{BULL|BEAR}_LTF_{BULL|BEAR|PULLBACK}.
 * HTF_BEAR_LTF_PULLBACK is the bounce/mixed cell (HTF bear, LTF recovering) —
 * NOT the yellow pullback bucket (that is HTF_BULL_LTF_PULLBACK only).
 */
export function classifyAlignmentBucket(state, htfScore, ltfScore) {
  const s = String(state || "").toUpperCase();
  const h = Number(htfScore);
  const l = Number(ltfScore);

  if (s === "HTF_BULL_LTF_BULL") {
    // Soft mix: aligned label but LTF not convincingly with HTF.
    if (Number.isFinite(l) && l < 8) return "bull_mixed";
    return "bull_aligned";
  }
  if (s === "HTF_BEAR_LTF_BEAR") {
    if (Number.isFinite(l) && l > -8) return "bear_mixed";
    return "bear_aligned";
  }
  // Bull pullback (HTF bull, LTF weak) — yellow.
  if (
    s === "HTF_BULL_LTF_PULLBACK"
    || s === "HTF_BULL_LTF_BEAR_PULLBACK"
    || s === "HTF_BULL_LTF_BEAR"
  ) {
    return "pullback";
  }
  // Bear bounce / mixed (HTF bear, LTF lifting) — red + diameter.
  if (
    s === "HTF_BEAR_LTF_PULLBACK"
    || s === "HTF_BEAR_LTF_BULL_BOUNCE"
    || s === "HTF_BEAR_LTF_BULL"
    || s.includes("BOUNCE")
    || s.includes("REVERSAL")
  ) {
    return "bear_mixed";
  }
  if (s.includes("PULLBACK")) {
    return s.startsWith("HTF_BEAR") ? "bear_mixed" : "pullback";
  }
  if (s.startsWith("HTF_BULL")) return "bull_mixed";
  if (s.startsWith("HTF_BEAR")) return "bear_mixed";
  if (Number.isFinite(h) && Number.isFinite(l)) {
    if (h > 8 && l > 8) return "bull_aligned";
    if (h < -8 && l < -8) return "bear_aligned";
    if (h > 8 && l < -4) return "pullback";
    if (h < -8 && l > 4) return "bear_mixed";
    if (h > 4) return "bull_mixed";
    if (h < -4) return "bear_mixed";
  }
  return "neutral";
}

/** Current price → Target 2 (tp_exit) vs SL. */
export function resolveBubbleRr(tickerLike) {
  const rrRaw = tickerLike?.rr != null ? Number(tickerLike.rr) : NaN;
  if (Number.isFinite(rrRaw) && rrRaw > 0) return rrRaw;
  const price = Number(tickerLike?.price ?? tickerLike?.close ?? tickerLike?.c);
  const sl = Number(tickerLike?.sl);
  let tp = Number(tickerLike?.tp_exit);
  if (!Number.isFinite(tp) || tp <= 0) tp = Number(tickerLike?.tp_runner);
  if (!(price > 0) || !(sl > 0) || !(tp > 0)) return 0.5;
  const risk = Math.abs(price - sl);
  if (!(risk > 0)) return 0.5;
  return Math.abs(tp - price) / risk;
}

export function resolveBubbleProbability(tickerLike) {
  const conv = Number(
    tickerLike?.focus_conviction_score
      ?? tickerLike?.__focus_conviction_score
      ?? tickerLike?.conviction,
  );
  if (Number.isFinite(conv) && conv > 0) return Math.max(0, Math.min(100, conv));
  const conf = Number(tickerLike?.regime_forecast?.confidence);
  if (Number.isFinite(conf) && conf > 0) {
    return conf <= 1 ? Math.round(conf * 100) : Math.max(0, Math.min(100, conf));
  }
  return null;
}

export function probabilityStrokeStyle(probability) {
  // Low + medium share no-stroke; only high conviction gets a solid outline.
  if (probability == null || !Number.isFinite(probability) || probability < 70) {
    return { tier: "none", stroke: "none", strokeWidth: 0, dash: null };
  }
  return { tier: "high", stroke: "rgba(255,255,255,0.95)", strokeWidth: 2, dash: null };
}

export function resolveBubbleOrigin(tickerLike) {
  const recent = tickerLike?._journey?.recent;
  if (!Array.isArray(recent) || recent.length < 2) return null;
  const nowHtf = Number(tickerLike?.htf_score);
  const nowLtf = Number(tickerLike?.ltf_score);
  for (let i = recent.length - 2; i >= 0; i--) {
    const k = recent[i];
    const h = Number(k?.htf);
    const l = Number(k?.ltf);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    if (!Number.isFinite(nowHtf) || !Number.isFinite(nowLtf)) return { htf: h, ltf: l };
    if (Math.abs(h - nowHtf) + Math.abs(l - nowLtf) >= 2.5) return { htf: h, ltf: l };
  }
  const k = recent[recent.length - 2];
  const h = Number(k?.htf);
  const l = Number(k?.ltf);
  if (Number.isFinite(h) && Number.isFinite(l)) return { htf: h, ltf: l };
  return null;
}

export function resolveBubbleForecastTarget(tickerLike) {
  const fc = tickerLike?.regime_forecast;
  const dist = fc?.p_1d || fc?.p_next;
  if (!dist || typeof dist !== "object") return null;
  let best = null;
  let bestP = 0;
  for (const [st, p] of Object.entries(dist)) {
    const n = Number(p);
    if (Number.isFinite(n) && n > bestP) {
      bestP = n;
      best = st;
    }
  }
  if (!best || bestP < 0.22) return null;
  const key = String(best).toUpperCase();
  if (key.includes("PULLBACK") || (key.includes("BULL") && key.includes("BEAR") && key.indexOf("BULL") < key.indexOf("BEAR"))) {
    return { htf: 24, ltf: -14, state: key, p: bestP };
  }
  if (key.includes("BOUNCE") || (key.includes("BEAR") && key.includes("BULL") && key.indexOf("BEAR") < key.indexOf("BULL"))) {
    return { htf: -24, ltf: 14, state: key, p: bestP };
  }
  if (key.includes("BULL") && !key.includes("BEAR")) return { htf: 28, ltf: 18, state: key, p: bestP };
  if (key.includes("BEAR") && !key.includes("BULL")) return { htf: -28, ltf: -18, state: key, p: bestP };
  return null;
}
