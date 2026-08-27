// worker/cro/fsd-macro-context.js
// FSD macro rally context — bridges tactical overlay → timing, options, root L1.

export const SPX_PROSE_RE = /\bS&P\s*500\b/gi;
export const SPX_TARGET_RE = /\b(?:S&P\s*500|SPX|\^SPX)\b[^.\n]{0,120}?\b([\d,]{3,5})\s*[-–]\s*([\d,]{5})\b/i;
export const SPX_SINGLE_TARGET_RE = /\b(?:S&P\s*500|SPX|\^SPX)\b[^.\n]{0,120}?\b([\d,]{4,5})\b/i;
export const ETH_HISTORICAL_GAIN_RE = />\s*167\s*%|167\s*%\s*subsequent/i;

/** Normalize extractor directions so index *targets* read risk-on, not stretched-caution. */
export function normalizeTacticalSignalDirections(signals = []) {
  return (signals || []).map((s) => {
    const sig = String(s?.signal || "").toLowerCase();
    const pair = String(s?.pair || "").toUpperCase();
    const dir = String(s?.direction || "").toLowerCase();
    const isIndex = sig.includes("spx_target") || pair.includes("SPX") || pair.includes("^SPX");
    const isCryptoLead = sig.includes("crypto") || pair.includes("ETH") || pair.includes("BTC");
    if (isIndex && (dir === "bullish_stretched" || dir === "caution_short_term")) {
      return { ...s, direction: "bullish_target" };
    }
    if (isCryptoLead && dir === "bullish_stretched") {
      return { ...s, direction: "fsd_rally_window" };
    }
    return s;
  });
}

/** Parse "7,900-8,000" or single "8,000" SPX target from prose. */
export function parseSpxTargetRange(text) {
  const blob = String(text || "");
  if (!blob) return null;
  let m = blob.match(SPX_TARGET_RE);
  if (m) {
    const low = Number(String(m[1]).replace(/,/g, ""));
    const high = Number(String(m[2]).replace(/,/g, ""));
    if (Number.isFinite(low) && Number.isFinite(high) && high > low) {
      return { low, high, mid: (low + high) / 2 };
    }
  }
  m = blob.match(SPX_SINGLE_TARGET_RE);
  if (m) {
    const val = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(val) && val > 1000) return { low: val, high: val, mid: val };
  }
  return null;
}

/** Merge macro contexts — month-end SPX targets persist across newer tactical notes. */
export function mergeFsdMacroContexts(...contexts) {
  const valid = contexts.filter((c) => c && typeof c === "object");
  if (!valid.length) return null;

  const now = Date.now();
  const merged = { ...valid[0] };
  const signalKeys = new Set((merged.signals || []).map((s) => String(s?.signal || "")));

  for (const ctx of valid.slice(1)) {
    if (ctx.spx_target && !merged.spx_target) merged.spx_target = ctx.spx_target;
    if (ctx.rally_active) merged.rally_active = true;
    if (ctx.crypto_leadership) merged.crypto_leadership = true;
    if (ctx.target_month_end) merged.target_month_end = true;
    if (ctx.spx_target && ctx.target_deadline_ms) {
      merged.target_deadline_ms = Math.max(
        Number(merged.target_deadline_ms) || 0,
        Number(ctx.target_deadline_ms) || 0,
      );
    }
    for (const s of (ctx.signals || [])) {
      const k = String(s?.signal || "");
      if (k && !signalKeys.has(k)) {
        signalKeys.add(k);
        merged.signals = [...(merged.signals || []), s];
      }
    }
    if (!merged.overlay_line && ctx.overlay_line) merged.overlay_line = ctx.overlay_line;
    if (!merged.pub_id && ctx.pub_id) merged.pub_id = ctx.pub_id;
  }

  // Month-end index target still inside its window → rally stays on even if the
  // live KV overlay is a newer single-name note (e.g. NVDA earnings).
  if (merged.spx_target && Number(merged.target_deadline_ms) > now) {
    merged.rally_active = true;
    merged.target_month_end = true;
  }

  return merged;
}

/** Build macro context from a tactical override blob. */
export function parseMacroContextFromOverlay(override) {
  if (!override || typeof override !== "object") return null;
  const signals = normalizeTacticalSignalDirections(override.tactical_signals || []);
  const overlayText = [
    override.tactical_overlay,
    override.tactical_title,
    ...(signals.map((s) => `${s.signal} ${s.evidence || ""} ${s.playbook_action || ""}`)),
  ].filter(Boolean).join("\n");

  const spxTarget = parseSpxTargetRange(overlayText);
  const hasIndexTarget = !!spxTarget || signals.some((s) =>
    String(s.signal || "").includes("spx_target")
    || String(s.pair || "").toUpperCase().includes("SPX"),
  );
  const hasCryptoLead = ETH_HISTORICAL_GAIN_RE.test(overlayText)
    || signals.some((s) => String(s.signal || "").includes("crypto") || String(s.pair || "").includes("ETH"));
  const rallyActive = hasIndexTarget || hasCryptoLead || signals.some((s) => {
    const d = String(s.direction || "").toLowerCase();
    return d === "bullish_target" || d === "fsd_rally_window" || d === "buy_the_dip_rally";
  });

  const now = Date.now();
  const monthEnd = endOfCurrentMonthUtc(now);

  return {
    rally_active: rallyActive,
    spx_target: spxTarget,
    crypto_leadership: hasCryptoLead,
    target_month_end: rallyActive && !!spxTarget,
    target_deadline_ms: monthEnd,
    overlay_line: String(override.tactical_overlay || override.tactical_title || "").slice(0, 300),
    pub_id: override.pub_id || null,
    proposal_id: override.proposal_id || null,
    applied_at: override.applied_at || override.issued_at || null,
    signals,
  };
}

function endOfCurrentMonthUtc(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 21, 0, 0, 0);
}

/** Pick options expiry nearest month-end target (for index rally plays). */
export function pickMonthEndRallyExpiration(now = Date.now(), fsdMacro = null) {
  if (!fsdMacro?.target_month_end) return null;
  const deadline = Number(fsdMacro.target_deadline_ms) || endOfCurrentMonthUtc(now);
  const minDte = 2;
  const maxDte = Math.max(minDte, Math.ceil((deadline - now) / 86400000));
  if (maxDte < minDte) return null;

  // Prefer the Friday on or just before month-end.
  const target = new Date(deadline);
  const dow = target.getUTCDay();
  const offset = (dow + 2) % 7; // Fri=5 → 0 when already Fri
  const friday = new Date(target.getTime() - offset * 86400000);
  friday.setUTCHours(21, 0, 0, 0);
  let dte = Math.round((friday.getTime() - now) / 86400000);
  while (dte < minDte) {
    friday.setUTCDate(friday.getUTCDate() + 7);
    dte = Math.round((friday.getTime() - now) / 86400000);
  }
  if (dte > maxDte + 7) return null;
  const iso = friday.toISOString().slice(0, 10);
  const label = friday.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return { iso, dte, label: `${label} (${dte}DTE · month-end rally)` };
}

export function isIndexProxyTicker(ticker) {
  const INDEX_PROXY_TICKERS = new Set(["SPY", "SPYU", "SPXL", "SPXS", "SPXU", "RSP", "QQQ", "TQQQ", "SQQQ", "IWM", "DIA", "ES", "ES1!", "NQ", "NQ1!"]);
  return INDEX_PROXY_TICKERS.has(String(ticker || "").toUpperCase());
}

/** Meaningful dip vs recent high for FSD buy-the-dip window. */
export function isFsdDipBuySetup(tickerData, fsdMacro, { minPullbackPct = 0.003 } = {}) {
  if (!fsdMacro?.rally_active) return false;
  const px = Number(tickerData?.price ?? tickerData?._live_price);
  if (!(px > 0)) return false;
  const dayChg = Number(tickerData?.day_change_pct ?? tickerData?.dailyChgPct);
  const fiveDay = Number(tickerData?.fiveDayChangePct ?? tickerData?.structureContext?.fiveDayChangePct);
  const compressions = tickerData?.timing_overlay?.compressions?.length
    ?? (Array.isArray(tickerData?.compressions) ? tickerData.compressions.length : 0);
  const callOpp = !!tickerData?.timing_overlay?.call_opportunity;
  const addDips = !!tickerData?.timing_overlay?.add_on_dips;

  if (callOpp || addDips || compressions >= 1) return true;
  if (Number.isFinite(dayChg) && dayChg <= -minPullbackPct * 100) return true;
  if (Number.isFinite(fiveDay) && fiveDay <= -1.5) return true;
  return false;
}
