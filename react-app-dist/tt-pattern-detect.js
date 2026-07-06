/**
 * Candle-based chart pattern detection for ticker cards.
 * Extracted from shared-right-rail.js _rrDetectPatterns; adds icons + tooltips.
 */
(function () {
  "use strict";

  const PATTERN_META = {
    "Bull Flag": {
      icon: "▲",
      tooltip: "Bull flag — brief consolidation after an uptrend; a breakout above the flag often continues the prior move.",
    },
    "Bear Flag": {
      icon: "▼",
      tooltip: "Bear flag — tight consolidation after a decline; a breakdown below the flag often extends the downtrend.",
    },
    "Asc Triangle": {
      icon: "△",
      tooltip: "Ascending triangle — flat resistance with rising lows; bias is bullish on an upside break.",
    },
    "Desc Triangle": {
      icon: "▽",
      tooltip: "Descending triangle — flat support with falling highs; bias is bearish on a downside break.",
    },
    "Double Top": {
      icon: "M",
      tooltip: "Double top — two peaks near the same level; often signals exhaustion and a potential reversal lower.",
    },
    "Double Bottom": {
      icon: "W",
      tooltip: "Double bottom — two lows near the same level; often signals basing and a potential reversal higher.",
    },
    Range: {
      icon: "↔",
      tooltip: "Range — price oscillating between support and resistance; watch for a directional break.",
    },
    "Head & Shoulders": {
      icon: "⌒",
      tooltip: "Head & shoulders — three peaks with a higher center; classic bearish reversal when neckline breaks.",
    },
    "Inv H&S": {
      icon: "⌣",
      tooltip: "Inverse head & shoulders — three troughs with a lower center; classic bullish reversal when neckline breaks.",
    },
    "Cup & Handle": {
      icon: "∪",
      tooltip: "Cup and handle — rounded base followed by a shallow pullback; bullish continuation on handle break.",
    },
    "Wyckoff Spring": {
      icon: "↩",
      tooltip: "Wyckoff spring — false breakdown below support that quickly reclaims; often marks accumulation.",
    },
  };

  function detectSwingPoints(candles, lookback) {
    const highs = [];
    const lows = [];
    for (let i = lookback; i < candles.length - lookback; i++) {
      const h = Number(candles[i].h);
      const l = Number(candles[i].l);
      if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
      let isHigh = true;
      let isLow = true;
      for (let j = 1; j <= lookback; j++) {
        if (Number(candles[i - j].h) >= h || Number(candles[i + j].h) >= h) isHigh = false;
        if (Number(candles[i - j].l) <= l || Number(candles[i + j].l) <= l) isLow = false;
      }
      const ts = candles[i].ts || candles[i].time;
      if (isHigh) highs.push({ idx: i, price: h, ts });
      if (isLow) lows.push({ idx: i, price: l, ts });
    }
    return { highs, lows };
  }

  function fitTrendline(points) {
    if (!points || points.length < 2) return null;
    const n = points.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (const p of points) {
      sumX += p.idx;
      sumY += p.price;
      sumXY += p.idx * p.price;
      sumXX += p.idx * p.idx;
    }
    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-9) return null;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept };
  }

  function detectHeadShoulders(highs, lows, candles) {
    if (highs.length < 3) return null;
    const h3 = highs.slice(-3);
    const [ls, head, rs] = h3;
    const shoulderTol = 0.025;
    const headMinLift = 0.012;
    if (Math.abs(ls.price - rs.price) / ls.price > shoulderTol) return null;
    if (head.price <= ls.price * (1 + headMinLift) || head.price <= rs.price * (1 + headMinLift)) return null;
    if (head.idx <= ls.idx || head.idx >= rs.idx) return null;
    return { type: "Head & Shoulders", idx: rs.idx, ts: rs.ts, bias: "bearish" };
  }

  function detectInvHeadShoulders(highs, lows, candles) {
    if (lows.length < 3) return null;
    const l3 = lows.slice(-3);
    const [ls, head, rs] = l3;
    const shoulderTol = 0.025;
    const headMinDrop = 0.012;
    if (Math.abs(ls.price - rs.price) / ls.price > shoulderTol) return null;
    if (head.price >= ls.price * (1 - headMinDrop) || head.price >= rs.price * (1 - headMinDrop)) return null;
    if (head.idx <= ls.idx || head.idx >= rs.idx) return null;
    return { type: "Inv H&S", idx: rs.idx, ts: rs.ts, bias: "bullish" };
  }

  function detectCupHandle(candles, lows) {
    if (candles.length < 20 || lows.length < 3) return null;
    const recent = candles.slice(-20);
    const closes = recent.map((c) => Number(c.c)).filter(Number.isFinite);
    if (closes.length < 15) return null;
    const mid = Math.floor(closes.length / 2);
    const left = closes.slice(0, mid);
    const right = closes.slice(mid);
    const leftMin = Math.min(...left);
    const rightMin = Math.min(...right);
    const rim = Math.max(closes[0], closes[closes.length - 1]);
    const cupDepth = (rim - Math.min(leftMin, rightMin)) / rim;
    if (cupDepth < 0.06 || cupDepth > 0.35) return null;
    const handle = closes.slice(-5);
    const handlePullback = (Math.max(...handle) - Math.min(...handle)) / rim;
    if (handlePullback < 0.015 || handlePullback > 0.12) return null;
    return {
      type: "Cup & Handle",
      idx: candles.length - 2,
      ts: candles[candles.length - 2]?.ts,
      bias: "bullish",
    };
  }

  function detectWyckoffSpring(candles, lows) {
    if (candles.length < 10 || lows.length < 2) return null;
    const support = lows.slice(-3);
    const floor = Math.min(...support.map((l) => l.price));
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const low = Number(last.l);
    const close = Number(last.c);
    const prevClose = Number(prev?.c);
    if (!Number.isFinite(low) || !Number.isFinite(close) || !Number.isFinite(prevClose)) return null;
    const pierced = low < floor * 0.995;
    const reclaimed = close > floor && close > prevClose;
    if (!pierced || !reclaimed) return null;
    return { type: "Wyckoff Spring", idx: candles.length - 1, ts: last.ts, bias: "bullish" };
  }

  function enrichPattern(p) {
    const meta = PATTERN_META[p.type] || {};
    return {
      ...p,
      icon: meta.icon || "◆",
      tooltip: meta.tooltip || `${p.type} pattern detected on daily candles.`,
    };
  }

  function detectCandlePatterns(rawCandles) {
    if (!Array.isArray(rawCandles) || rawCandles.length < 15) return [];
    const candles = rawCandles.map((c) => ({
      h: c.high !== undefined ? c.high : c.h,
      l: c.low !== undefined ? c.low : c.l,
      c: c.close !== undefined ? c.close : c.c,
      o: c.open !== undefined ? c.open : c.o,
      ts: c.time || c.ts,
    }));
    const { highs, lows } = detectSwingPoints(candles, 2);
    const patterns = [];
    const recentHighs = highs.slice(-5);
    const recentLows = lows.slice(-5);
    const avgPrice = Number(candles[candles.length - 1].c) || 1;
    const slopeThreshold = avgPrice * 0.0005;

    if (recentHighs.length >= 2 && recentLows.length >= 2) {
      const hSlope = (recentHighs[recentHighs.length - 1].price - recentHighs[0].price)
        / (recentHighs[recentHighs.length - 1].idx - recentHighs[0].idx || 1);
      const lSlope = (recentLows[recentLows.length - 1].price - recentLows[0].price)
        / (recentLows[recentLows.length - 1].idx - recentLows[0].idx || 1);

      if (hSlope < -slopeThreshold && Math.abs(lSlope) < slopeThreshold) {
        patterns.push({ type: "Desc Triangle", idx: recentLows[recentLows.length - 1].idx, ts: recentLows[recentLows.length - 1].ts, bias: "bearish" });
      }
      if (lSlope > slopeThreshold && Math.abs(hSlope) < slopeThreshold) {
        patterns.push({ type: "Asc Triangle", idx: recentHighs[recentHighs.length - 1].idx, ts: recentHighs[recentHighs.length - 1].ts, bias: "bullish" });
      }
      if (Math.abs(hSlope) < slopeThreshold && Math.abs(lSlope) < slopeThreshold) {
        const hi = Math.max(...recentHighs.map((h) => h.price));
        const lo = Math.min(...recentLows.map((l) => l.price));
        if ((hi - lo) / lo * 100 < 8) {
          patterns.push({ type: "Range", idx: candles.length - 3, ts: candles[candles.length - 3]?.ts, bias: "neutral" });
        }
      }
      if (hSlope < -slopeThreshold && lSlope < -slopeThreshold && Math.abs(hSlope - lSlope) < slopeThreshold * 2) {
        patterns.push({ type: "Bear Flag", idx: recentLows[recentLows.length - 1].idx, ts: recentLows[recentLows.length - 1].ts, bias: "bearish" });
      }
      if (hSlope > slopeThreshold && lSlope > slopeThreshold && Math.abs(hSlope - lSlope) < slopeThreshold * 2) {
        patterns.push({ type: "Bull Flag", idx: recentHighs[recentHighs.length - 1].idx, ts: recentHighs[recentHighs.length - 1].ts, bias: "bullish" });
      }
    }

    if (recentHighs.length >= 2) {
      const l2 = recentHighs.slice(-2);
      if (Math.abs(l2[0].price - l2[1].price) / l2[0].price < 0.005 && l2[1].idx - l2[0].idx >= 5) {
        patterns.push({ type: "Double Top", idx: l2[1].idx, ts: l2[1].ts, bias: "bearish" });
      }
    }
    if (recentLows.length >= 2) {
      const l2 = recentLows.slice(-2);
      if (Math.abs(l2[0].price - l2[1].price) / l2[0].price < 0.005 && l2[1].idx - l2[0].idx >= 5) {
        patterns.push({ type: "Double Bottom", idx: l2[1].idx, ts: l2[1].ts, bias: "bullish" });
      }
    }

    const hs = detectHeadShoulders(highs, lows, candles);
    if (hs) patterns.push(hs);
    const ihs = detectInvHeadShoulders(highs, lows, candles);
    if (ihs) patterns.push(ihs);
    const cup = detectCupHandle(candles, lows);
    if (cup) patterns.push(cup);
    const spring = detectWyckoffSpring(candles, lows);
    if (spring) patterns.push(spring);

    const seen = new Set();
    return patterns
      .filter((p) => {
        const key = p.type;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3)
      .map(enrichPattern);
  }

  window.TimedPatternDetect = {
    detectCandlePatterns,
    PATTERN_META,
  };
})();

// cache-bust:1783305829712:369547444
