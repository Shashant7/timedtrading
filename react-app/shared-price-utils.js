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

  // ── Volatility-normalized color intensity ──
  // Per-type typical daily range so SPY at +0.7% looks as intense as TSLA at +3%.
  // Override with live ATR when available for per-ticker precision.
  var TYPICAL_DAILY_RANGE = {
    broad_etf: 1.2,
    sector_etf: 1.8,
    value: 1.5,
    large_cap: 2.0,
    growth: 3.5,
    small_cap: 5.0,
    crypto: 5.0,
    crypto_adj: 5.0,
    precious_metal: 2.0,
    commodity_etf: 2.0,
    _default: 2.5,
  };

  // Client-side ticker → type classification (mirrors worker/sector-mapping.js)
  var TICKER_TYPE_MAP = {
    SPY:'broad_etf',QQQ:'broad_etf',IWM:'broad_etf',DIA:'broad_etf',TNA:'broad_etf',
    XLB:'sector_etf',XLC:'sector_etf',XLE:'sector_etf',XLF:'sector_etf',XLI:'sector_etf',
    XLK:'sector_etf',XLP:'sector_etf',XLRE:'sector_etf',XLU:'sector_etf',XLV:'sector_etf',
    XLY:'sector_etf',SOXL:'sector_etf',XHB:'sector_etf',
    GLD:'commodity_etf',SLV:'commodity_etf',USO:'commodity_etf',VIXY:'commodity_etf',
    MSTR:'crypto_adj',COIN:'crypto_adj',HOOD:'crypto_adj',RIOT:'crypto_adj',
    BTCUSD:'crypto',ETHUSD:'crypto',ETHA:'crypto',
    GOLD:'precious_metal',GDX:'precious_metal',IAU:'precious_metal',AGQ:'precious_metal',
    HL:'precious_metal',AU:'precious_metal',RGLD:'precious_metal',CCJ:'precious_metal',
    TSLA:'growth',NVDA:'growth',AMD:'growth',PLTR:'growth',RBLX:'growth',IONQ:'growth',
    APP:'growth',HIMS:'growth',SOFI:'growth',RDDT:'growth',CVNA:'growth',JOBY:'growth',
    RKLB:'growth',NBIS:'growth',IREN:'growth',APLD:'growth',CRWD:'growth',PANW:'growth',
    MDB:'growth',PATH:'growth',NFLX:'growth',AVGO:'growth',ANET:'growth',META:'growth',
    TWLO:'growth',FSLR:'growth',BE:'growth',
    WMT:'value',COST:'value',KO:'value',JPM:'value',GS:'value',PNC:'value',BK:'value',
    MSFT:'value',AAPL:'value',GOOGL:'value',UNH:'value',AMGN:'value',GILD:'value',
    UTHR:'value',CAT:'value',DE:'value',GE:'value',TJX:'value',INTU:'value',CSCO:'value',
    SPGI:'value',WM:'value',TT:'value',ETN:'value',PH:'value',EMR:'value',ULTA:'value',
    MNST:'value',NKE:'value',ACN:'value',
    AMZN:'large_cap',ORCL:'large_cap',BA:'large_cap',LRCX:'large_cap',KLAC:'large_cap',
    CDNS:'large_cap',MU:'large_cap',EXPE:'large_cap',STX:'large_cap',WDC:'large_cap',
    BABA:'large_cap',TSM:'large_cap',CRM:'large_cap',ON:'large_cap',
    BMNR:'small_cap',CRWV:'small_cap',GRNY:'small_cap',XYZ:'small_cap',
  };

  function resolveTickerType(tickerSymbol, tickerType) {
    if (tickerType && TYPICAL_DAILY_RANGE[tickerType]) return tickerType;
    if (tickerSymbol) {
      var sym = String(tickerSymbol).toUpperCase();
      if (TICKER_TYPE_MAP[sym]) return TICKER_TYPE_MAP[sym];
    }
    return "";
  }

  function getNormalizedIntensity(dayPct, tickerType, volatilityAtrPct, tickerSymbol) {
    if (!Number.isFinite(dayPct)) return 0;
    var abs = Math.abs(dayPct);
    if (Number.isFinite(volatilityAtrPct) && volatilityAtrPct > 0.1) {
      return abs / volatilityAtrPct;
    }
    var resolved = resolveTickerType(tickerSymbol, tickerType);
    var range = TYPICAL_DAILY_RANGE[resolved] || TYPICAL_DAILY_RANGE._default;
    return abs / range;
  }

  // Expose on window for consumption by all pages
  window.TimedPriceUtils = {
    getIngestMs: getIngestMs,
    getNyClock: getNyClock,
    isNyRegularMarketOpen: isNyRegularMarketOpen,
    ageLabelFromMinutes: ageLabelFromMinutes,
    getStaleInfo: getStaleInfo,
    getDailyChange: getDailyChange,
    TYPICAL_DAILY_RANGE: TYPICAL_DAILY_RANGE,
    TICKER_TYPE_MAP: TICKER_TYPE_MAP,
    resolveTickerType: resolveTickerType,
    getNormalizedIntensity: getNormalizedIntensity,
  };
})();
