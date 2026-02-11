(function () {
  "use strict";

  // ── Ingest timestamp ──
  function getIngestMs(t) {
    var s = t?.scored_at || t?.updated_at || t?.timestamp;
    if (!s) return 0;
    if (typeof s === "number") return s > 1e12 ? s : s * 1000;
    var d = new Date(s);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  // ── NY clock helpers ──
  function getNyClock() {
    var s = new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour12: false,
    });
    var parts = s.split(", ");
    var t = (parts[1] || "").split(":");
    var hr = parseInt(t[0] || "0");
    var mn = parseInt(t[1] || "0");
    var sec = parseInt(t[2] || "0");
    var dParts = (parts[0] || "").split("/");
    var dow = new Date(
      Number(dParts[2]),
      Number(dParts[0]) - 1,
      Number(dParts[1]),
    ).getDay();
    return { hr: hr, mn: mn, sec: sec, dow: dow, totalMin: hr * 60 + mn };
  }

  function isNyRegularMarketOpen() {
    var c = getNyClock();
    if (c.dow === 0 || c.dow === 6) return false;
    var m = c.totalMin;
    return m >= 570 && m < 960;
  }

  // ── Age label (e.g. "3m ago") ──
  function ageLabelFromMinutes(ageMin) {
    if (!Number.isFinite(ageMin) || ageMin < 0) return "";
    if (ageMin < 1) return "just now";
    if (ageMin < 60) return Math.round(ageMin) + "m ago";
    if (ageMin < 1440) return Math.round(ageMin / 60) + "h ago";
    return Math.round(ageMin / 1440) + "d ago";
  }

  // ── Stale detection ──
  function getStaleInfo(t, opts) {
    var maxAgeMin =
      opts && opts.maxAgeMin != null ? opts.maxAgeMin : 90;
    var result = { isStale: false, ageMin: null, staleByFlag: false };
    var staleFlag = t?.stale || t?.is_stale || false;
    if (staleFlag === true || staleFlag === 1 || staleFlag === "true") {
      result.staleByFlag = true;
      result.isStale = true;
    }
    var ims = getIngestMs(t);
    if (ims > 0) {
      result.ageMin = (Date.now() - ims) / 60000;
      if (result.ageMin > maxAgeMin) result.isStale = true;
    } else {
      result.isStale = true;
    }
    return result;
  }

  // ── Daily change — hardened, single-source-of-truth implementation ──
  //
  // Strategy:  ALWAYS compute daily change from (currentPrice, prevClose).
  // Never blindly trust pre-computed dp/dc fields — they can be poisoned by
  // stale overlays or missing Alpaca previousDailyBar data.
  //
  // Priority for prevClose:
  //   1. Alpaca live feed pc  (_live_prev_close, from /timed/prices)
  //   2. Scoring snapshot prev_close (from heartbeat/capture ingest)
  //   3. Derive from day_change fields:  prevClose = price - day_change
  //
  // Priority for currentPrice:
  //   1. Alpaca live price   (_live_price)
  //   2. Ticker price field  (price)
  //   3. Ticker close field  (close)
  //
  function getDailyChange(t) {
    var marketOpen = isNyRegularMarketOpen();

    // ── Resolve current price ──
    var price = 0;
    var priceKeys = ["_live_price", "price", "close"];
    for (var pi = 0; pi < priceKeys.length; pi++) {
      var pv = Number(t?.[priceKeys[pi]]);
      if (Number.isFinite(pv) && pv > 0) { price = pv; break; }
    }
    if (!(price > 0)) return { dayChg: null, dayPct: null, stale: { isStale: true }, marketOpen };

    // ── Resolve prevClose ──
    var prevClose = 0;
    // Source 1: Alpaca live feed
    var livePc = Number(t?._live_prev_close);
    if (Number.isFinite(livePc) && livePc > 0) prevClose = livePc;
    // Source 2: scoring snapshot
    if (!(prevClose > 0)) {
      var pcKeys = ["prev_close", "previous_close", "prior_close", "yclose", "close_prev"];
      for (var ci = 0; ci < pcKeys.length; ci++) {
        var cv = Number(t?.[pcKeys[ci]]);
        if (Number.isFinite(cv) && cv > 0) { prevClose = cv; break; }
      }
    }
    // Source 3: derive from day_change if available
    if (!(prevClose > 0)) {
      var dayChgField = Number(t?.day_change ?? t?.daily_change ?? t?.change);
      if (Number.isFinite(dayChgField) && Math.abs(dayChgField) > 0.001) {
        var derived = price - dayChgField;
        if (Number.isFinite(derived) && derived > 0) prevClose = derived;
      }
    }
    // Source 4: derive from day_change_pct if available (last resort before giving up)
    if (!(prevClose > 0)) {
      var pctField = Number(t?.day_change_pct ?? t?.daily_change_pct ?? t?.change_pct ?? t?.pct_change);
      if (Number.isFinite(pctField) && Math.abs(pctField) > 0.01) {
        var derivedPc = price / (1 + pctField / 100);
        if (Number.isFinite(derivedPc) && derivedPc > 0) prevClose = derivedPc;
      }
    }

    // ── Sanity check: if prevClose gives extreme daily change (>10%) but a ──
    // ── stored day_change_pct is available and saner, derive prevClose from it ──
    if (prevClose > 0 && price > 0) {
      var computedPctAbs = Math.abs((price - prevClose) / prevClose * 100);
      var storedPctRaw = Number(t?.day_change_pct ?? t?.daily_change_pct ?? t?.change_pct);
      var storedPctAbs = Number.isFinite(storedPctRaw) ? Math.abs(storedPctRaw) : NaN;
      if (computedPctAbs > 10 && Number.isFinite(storedPctAbs) && storedPctAbs < computedPctAbs && storedPctAbs < 15) {
        var betterPc = price / (1 + storedPctRaw / 100);
        if (Number.isFinite(betterPc) && betterPc > 0) prevClose = Math.round(betterPc * 100) / 100;
      }
    }

    // ── Compute daily change ──
    if (prevClose > 0) {
      var chg = Math.round((price - prevClose) * 100) / 100;
      var pct = Math.round(((price - prevClose) / prevClose) * 10000) / 100;

      // Determine staleness
      var priceAge = t?._price_updated_at
        ? (Date.now() - t._price_updated_at) / 60000
        : Infinity;
      var hasLiveData = Number.isFinite(priceAge) && priceAge < (marketOpen ? 30 : 180);
      var staleInfo = hasLiveData
        ? { isStale: priceAge > 5, ageMin: priceAge }
        : getStaleInfo(t, { maxAgeMin: marketOpen ? 90 : 72 * 60 });

      return { dayChg: chg, dayPct: pct, stale: staleInfo, marketOpen, livePrice: hasLiveData };
    }

    // ── Last resort: use pre-computed fields from scoring snapshot ──
    var maxAgeMin = marketOpen ? 90 : 72 * 60;
    var stale = getStaleInfo(t, { maxAgeMin: maxAgeMin });
    if (stale.isStale && (marketOpen || stale.staleByFlag)) {
      return { dayChg: null, dayPct: null, stale: stale, marketOpen };
    }

    var pickNum = function (obj, keys) {
      for (var i = 0; i < keys.length; i++) {
        var v = Number(obj?.[keys[i]]);
        if (Number.isFinite(v)) return v;
      }
      return null;
    };

    var dayChg = pickNum(t, ["day_change", "daily_change", "session_change", "change", "chg", "ch"]);
    var dayPct = pickNum(t, ["day_change_pct", "daily_change_pct", "session_change_pct", "change_pct", "pct_change", "chp"]);

    // Cross-check: if day_* and change_* disagree, prefer the saner one
    var altChg = pickNum(t, ["change", "session_change"]);
    var altPct = pickNum(t, ["change_pct", "pct_change", "session_change_pct"]);
    if (Number.isFinite(dayPct) && Number.isFinite(altPct)) {
      var disagrees = (dayPct >= 0 !== altPct >= 0) || Math.abs(dayPct - altPct) >= 1.5;
      if (disagrees && Math.abs(altPct) <= 5) {
        dayPct = altPct;
        if (Number.isFinite(altChg)) dayChg = altChg;
      }
    }

    // If only one of ($, %) exists, compute the other
    if (!Number.isFinite(dayChg) && Number.isFinite(dayPct) && price > 0) {
      var p = dayPct / 100;
      if (Math.abs(p) < 5) dayChg = price - (price / (1 + p));
    }
    if (!Number.isFinite(dayPct) && Number.isFinite(dayChg) && price > 0) {
      var prev = price - dayChg;
      if (prev > 0) dayPct = (dayChg / prev) * 100;
    }

    return { dayChg: dayChg, dayPct: dayPct, stale: stale, marketOpen };
  }

  // Expose on window for consumption by all pages
  window.TimedPriceUtils = {
    getIngestMs: getIngestMs,
    getNyClock: getNyClock,
    isNyRegularMarketOpen: isNyRegularMarketOpen,
    ageLabelFromMinutes: ageLabelFromMinutes,
    getStaleInfo: getStaleInfo,
    getDailyChange: getDailyChange,
  };
})();
