/**
 * Evidence-based dead-weight ticker classification.
 *
 * Report only — never mutates the registry. A keep-list must stay
 * human-reviewed: open books, index/pulse proxies, and user slots
 * are KEEP even if they never printed a short-term trade.
 *
 * Do not feed this from ticker_candles GROUP BY. That scan is the
 * D1 bill (Sep 2026). Use ticker_index, ticker_latest, ticker_profiles,
 * live trades, investor_positions, and user_tickers.
 */

export const RECENT_LIVE_TRADE_MS = 180 * 24 * 60 * 60 * 1000;
export const WATCH_IDLE_MS = 365 * 24 * 60 * 60 * 1000;

export const STRUCTURAL_PROXIES = new Set([
  "SPY", "QQQ", "IWM", "DIA", "RSP",
  "VIX", "VIXY", "VX1!",
  "GLD", "SLV", "USO",
  "BTCUSD", "ETHUSD",
  "ES1!", "NQ1!", "RTY1!", "YM1!",
  "CL1!", "GC1!", "SI1!",
  "XLK", "XLF", "XLE", "XLV", "XLI",
  "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC",
  "SOXL", "TQQQ", "UDOW", "SQQQ", "TNA", "UPRO", "SPXL",
]);

const OPEN_TRADE = new Set(["OPEN", "TP_HIT_TRIM"]);

function up(s) {
  return String(s || "").trim().toUpperCase();
}

export function isStructuralProxy(ticker, extra = []) {
  const sym = up(ticker);
  if (!sym) return false;
  if (STRUCTURAL_PROXIES.has(sym)) return true;
  if (sym.endsWith("1!")) return true;
  for (const x of extra) {
    if (up(x) === sym) return true;
  }
  return false;
}

export function hasUsableLatestScore(latest) {
  if (!latest || typeof latest !== "object") return false;
  const price = Number(latest.price ?? latest.htf_price);
  if (latest.htf_score == null || latest.htf_score === "") return false;
  const htf = Number(latest.htf_score);
  const rank = latest.rank == null || latest.rank === "" ? null : Number(latest.rank);
  return Number.isFinite(price) && price > 0
    && Number.isFinite(htf)
    && (latest.sl != null || (Number.isFinite(rank) && rank > 0));
}

/**
 * @param {object} facts
 * @param {string} facts.ticker
 * @param {boolean} [facts.inSectorMap]
 * @param {boolean} [facts.isUserSlot]
 * @param {boolean} [facts.isPriorityPick]
 * @param {boolean} [facts.hasProfile]
 * @param {boolean} [facts.hasUsableScore]
 * @param {number} [facts.openLiveTrades]
 * @param {number} [facts.liveTradeCount]
 * @param {number|null} [facts.lastLiveEntryTs]
 * @param {boolean} [facts.openInvestor]
 * @param {number} [facts.investorPositionCount]
 * @param {string[]} [facts.extraProxies]
 * @param {number} [now]
 */
export function classifyDeadWeightTicker(facts = {}, now = Date.now()) {
  const ticker = up(facts.ticker);
  const inSectorMap = !!facts.inSectorMap;
  const isUserSlot = !!facts.isUserSlot;
  const isPriorityPick = !!facts.isPriorityPick;
  const hasProfile = !!facts.hasProfile;
  const hasUsableScore = !!facts.hasUsableScore;
  const openLive = Number(facts.openLiveTrades) || 0;
  const liveCount = Number(facts.liveTradeCount) || 0;
  const lastEntry = Number(facts.lastLiveEntryTs) || 0;
  const openInvestor = !!facts.openInvestor;
  const investorCount = Number(facts.investorPositionCount) || 0;
  const proxy = isStructuralProxy(ticker, facts.extraProxies);

  const reasons = [];
  const keep = [];

  if (proxy) keep.push("structural_proxy");
  if (isPriorityPick) keep.push("priority_pick");
  if (isUserSlot) keep.push("user_slot");
  if (openLive > 0) keep.push("open_live_trade");
  if (openInvestor) keep.push("open_investor");
  if (investorCount > 0 && !openInvestor) keep.push("investor_history");
  if (lastEntry > 0 && (now - lastEntry) <= RECENT_LIVE_TRADE_MS) {
    keep.push("recent_live_trade");
  }

  if (keep.length) {
    return {
      ticker,
      bucket: "KEEP",
      reason: keep.join("+"),
      reasons: keep,
      inSectorMap,
      hasProfile,
      hasUsableScore,
      liveTradeCount: liveCount,
      lastLiveEntryTs: lastEntry || null,
    };
  }

  const idle = liveCount === 0
    || (lastEntry > 0 && (now - lastEntry) > WATCH_IDLE_MS);
  const healthy = hasProfile && hasUsableScore;

  if (inSectorMap && healthy && idle) {
    reasons.push(liveCount === 0 ? "core_never_traded" : "core_idle_365d");
    return {
      ticker,
      bucket: "WATCH",
      reason: reasons[0],
      reasons,
      inSectorMap,
      hasProfile,
      hasUsableScore,
      liveTradeCount: liveCount,
      lastLiveEntryTs: lastEntry || null,
    };
  }

  if (!idle) {
    // Older than 180d but newer than 365d, no open book — still KEEP-adjacent.
    reasons.push("live_trade_within_year");
    return {
      ticker,
      bucket: "KEEP",
      reason: "live_trade_within_year",
      reasons,
      inSectorMap,
      hasProfile,
      hasUsableScore,
      liveTradeCount: liveCount,
      lastLiveEntryTs: lastEntry || null,
    };
  }

  if (!inSectorMap && liveCount === 0) {
    if (!healthy) reasons.push("broken_orphan");
    else reasons.push("unused_add");
  } else if (inSectorMap && !healthy) {
    reasons.push("core_broken_onboard");
  } else {
    reasons.push("stale_add");
  }

  return {
    ticker,
    bucket: "DEAD",
    reason: reasons[0],
    reasons,
    inSectorMap,
    hasProfile,
    hasUsableScore,
    liveTradeCount: liveCount,
    lastLiveEntryTs: lastEntry || null,
  };
}

export function classifyDeadWeightUniverse(rows, now = Date.now()) {
  const classified = (rows || []).map((r) => classifyDeadWeightTicker(r, now));
  const byBucket = { KEEP: [], WATCH: [], DEAD: [] };
  for (const row of classified) byBucket[row.bucket].push(row);
  for (const k of Object.keys(byBucket)) {
    byBucket[k].sort((a, b) => a.ticker.localeCompare(b.ticker));
  }
  return {
    generated_at: now,
    counts: {
      total: classified.length,
      KEEP: byBucket.KEEP.length,
      WATCH: byBucket.WATCH.length,
      DEAD: byBucket.DEAD.length,
    },
    byBucket,
    rows: classified.sort((a, b) => a.ticker.localeCompare(b.ticker)),
  };
}
