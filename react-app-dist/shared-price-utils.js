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
    // ET calendar date as "YYYY-MM-DD" (for the holiday / half-day tables)
    var dateStr =
      dParts[2] +
      "-" + ("0" + dParts[0]).slice(-2) +
      "-" + ("0" + dParts[1]).slice(-2);
    return { hr: hr, mn: mn, sec: sec, dow: dow, totalMin: hr * 60 + mn, dateStr: dateStr };
  }

  // NYSE/Nasdaq full closures + 13:00 ET early closes. MAINTAIN ANNUALLY.
  // MUST stay in sync with worker/market-calendar.js and
  // worker/foundation/trading-calendar.js — CI enforces parity
  // (tests/calendar-parity.test.js). Bug fixed 2026-07-03: this module
  // was weekday+time only, so every page treated the Jul 4 holiday
  // (and Juneteenth, etc.) as a live RTH session.
  var US_MARKET_HOLIDAYS = {
    "2025-01-01": 1, "2025-01-20": 1, "2025-02-17": 1, "2025-04-18": 1, "2025-05-26": 1,
    "2025-06-19": 1, "2025-07-04": 1, "2025-09-01": 1, "2025-11-27": 1, "2025-12-25": 1,
    "2026-01-01": 1, "2026-01-19": 1, "2026-02-16": 1, "2026-04-03": 1, "2026-05-25": 1,
    "2026-06-19": 1, "2026-07-03": 1, "2026-09-07": 1, "2026-11-26": 1, "2026-12-25": 1,
    "2027-01-01": 1, "2027-01-18": 1, "2027-02-15": 1, "2027-03-26": 1, "2027-05-31": 1,
    "2027-06-18": 1, "2027-07-05": 1, "2027-09-06": 1, "2027-11-25": 1, "2027-12-24": 1,
    "2028-01-01": 1, "2028-01-17": 1, "2028-02-21": 1, "2028-04-14": 1, "2028-05-29": 1,
    "2028-06-19": 1, "2028-07-04": 1, "2028-09-04": 1, "2028-11-23": 1, "2028-12-25": 1,
  };
  var US_MARKET_HALF_DAYS = {
    "2025-07-03": 1, "2025-11-28": 1, "2025-12-24": 1,
    "2026-11-27": 1, "2026-12-24": 1,
    "2027-11-26": 1,
    "2028-07-03": 1, "2028-11-24": 1,
  };

  function isNyRegularMarketOpen() {
    var c = getNyClock();
    if (c.dow === 0 || c.dow === 6) return false;
    if (US_MARKET_HOLIDAYS[c.dateStr]) return false;
    var m = c.totalMin;
    var closeMin = US_MARKET_HALF_DAYS[c.dateStr] ? 780 : 960; // 1 PM early close
    return m >= 570 && m < closeMin;
  }

  /** Weekday pre-market window (04:00–09:30 ET), excluding holidays. */
  function isNyPreMarket() {
    if (isNyRegularMarketOpen()) return false;
    var c = getNyClock();
    if (c.dow === 0 || c.dow === 6) return false;
    if (US_MARKET_HOLIDAYS[c.dateStr]) return false;
    return c.totalMin >= 240 && c.totalMin < 570;
  }

  /** KV /timed/prices poll rows carry vendor session fields; bare WS ticks do not. */
  function isAuthoritativeRthPoll(p) {
    if (!p || typeof p !== "object") return false;
    if (Number(p.ahp) > 0) return true;
    if (Number(p.pc) > 0) return true;
    if (Number.isFinite(Number(p.dc))) return true;
    if (Number.isFinite(Number(p.dp))) return true;
    return false;
  }

  /** Alpaca tick_batch dayChg* during PRE is vs prev close (pre-market gap), not RTH session. */
  function shouldApplyDayChangeFromTick(p, marketOpen) {
    if (marketOpen) return true;
    if (isAuthoritativeRthPoll(p)) return true;
    var session = String(p && p.session || "").toUpperCase();
    return session !== "PRE" && session !== "AH";
  }

  // Price feed freshness — uses q_ts (vendor quote) / p_ts, NOT poll t.
  // GS: cron refreshed t every minute while p stuck at Jun-16 1090.
  function getPriceReceiptAgeMs(t) {
    var ts = Number(t?._quote_receipt_ts) || Number(t?._price_value_ts);
    if (!(ts > 0)) return Infinity;
    return Date.now() - ts;
  }

  // Legacy alias — same receipt clock (q_ts / p_ts), not poll t.
  var getPriceValueAgeMs = getPriceReceiptAgeMs;

  function isPriceFeedFresh(t) {
    var maxMs = isNyRegularMarketOpen() ? 10 * 60 * 1000 : 26 * 60 * 60 * 1000;
    return getPriceReceiptAgeMs(t) <= maxMs;
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
  // Headline price for ticker cards — session-aware single source of truth.
  // RTH open: live tick. Outside RTH: today's RTH close (close/price), never
  // the pre/post-market print (_live_price may carry that after a price poll).
  // Extended hours belong on the EXT line via getExtChange().
  function getHeadlinePrice(t) {
    if (!t || typeof t !== "object") return null;
    var marketOpen = isNyRegularMarketOpen();
    if (marketOpen) {
      var live = Number(t._live_price);
      if (live > 0 && isPriceFeedFresh(t)) return live;
      var openPx = Number(t.price ?? t.close);
      // Flap guard: a scoring snapshot can leave price/close == prev_close
      // (yesterday's reference). During RTH, rendering that as the headline
      // makes the card oscillate between prev-day and live. Prefer the live
      // tick when the fallback is essentially the prior close.
      var rthPrev = Number(t.prev_close ?? t.previous_close ?? t.pc ?? t._live_prev_close);
      if (live > 0 && rthPrev > 0 && openPx > 0
          && Math.abs(openPx - rthPrev) / rthPrev < 0.001
          && Math.abs(live - rthPrev) / rthPrev > 0.001) {
        return live;
      }
      if (openPx > 0) return openPx;
      return live > 0 ? live : null;
    }
    var px = Number(t.price ?? t._live_price);
    var live = Number(t._live_price);
    var close = Number(t.close);
    var prev = Number(t.prev_close ?? t.previous_close ?? t.pc ?? t._live_prev_close);
    var ahPx = Number(t._ah_price);
    // Last completed session RTH close (timed:prices `p`) — never stale `pc`.
    var sessionClose = Number(t._rth_session_close);
    if (sessionClose > 0) return sessionClose;
    // Extended-print guard: WS ticks can park the AH last on _live_price while
    // close still holds today's RTH session print — headline must stay on close.
    if (close > 0 && ahPx > 0 && live > 0
        && Math.abs(live - ahPx) / ahPx < 0.001
        && Math.abs(close - ahPx) / ahPx > 0.001) {
      return close;
    }
    // Stale snapshot guard: /timed/all can leave price == prev_close while
    // usePriceFeed has already locked today's RTH close on _live_price (GS).
    if (live > 0 && px > 0 && Math.abs(live - px) > 0.001 && prev > 0
        && Math.abs(px - prev) / prev < 0.001 && Math.abs(live - prev) / prev > 0.001) {
      px = live;
    }
    // Stale close guard: scoring blobs sometimes leave close == prev_close
    // (yesterday's reference) even after today's session. Prefer the live
    // feed price when close looks poisoned (DELL / card stale-close lesson).
    if (close > 0 && prev > 0 && Math.abs(close - prev) / prev < 0.0005
        && px > 0 && Math.abs(px - prev) / prev > 0.001) {
      return px;
    }
    if (close > 0) return close;
    if (px > 0) return px;
    return prev > 0 ? prev : null;
  }

  // ── Stock-split heal (mirrors worker/feed/prev-close-reconcile.js) ──
  var SPLIT_RATIOS = [10, 5, 4, 3, 2, 1.5, 0.5, 1 / 3, 0.25, 0.2, 0.1];
  var SPLIT_RATIO_TOL = 0.10;

  function isOpenSplitArtifact(price, prevClose, dailyOpen) {
    var p = Number(price);
    var pc = Number(prevClose);
    var open = Number(dailyOpen);
    if (!(p > 0 && pc > 0 && open > 0)) return false;
    return Math.abs(p - pc) / pc > 0.35
      && Math.abs(open - p) / p < 0.08
      && Math.abs(open - pc) / pc > 0.35;
  }

  function healPrevCloseForSplit(price, prevClose, dailyOpen) {
    var p = Number(price);
    var pc = Number(prevClose);
    var open = Number(dailyOpen);
    if (!(p > 0 && pc > 0)) return prevClose;
    var rawDpAbs = Math.abs((p - pc) / pc * 100);
    if (rawDpAbs < 35) return prevClose;
    var ratio = p / pc;
    var openArtifact = isOpenSplitArtifact(p, pc, open);
    var bestPc = 0;
    var bestAbsDp = Infinity;
    var consider = function (r) {
      if (!(r > 0)) return;
      var scaledPc = pc * r;
      if (!(scaledPc > 0)) return;
      var absDp = Math.abs((p - scaledPc) / scaledPc * 100);
      if (absDp >= 25) return;
      var ratioNear = Math.abs(ratio - r) / r < SPLIT_RATIO_TOL;
      if (!ratioNear && !openArtifact) return;
      if (absDp < 0.5 && !openArtifact && ratio < 1.2) return;
      if (absDp < bestAbsDp) {
        bestAbsDp = absDp;
        bestPc = Math.round(scaledPc * 100) / 100;
      }
    };
    if (ratio > 8 && ratio < 15) consider(10);
    for (var ri = 0; ri < SPLIT_RATIOS.length; ri++) consider(SPLIT_RATIOS[ri]);
    return bestPc > 0 ? bestPc : prevClose;
  }

  function getDailyChange(t) {
    var marketOpen = isNyRegularMarketOpen();

    // ── Resolve current price (session-aware) ──
    var price = getHeadlinePrice(t) || 0;
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

    // ── Stock split: rescale vendor prev_close on wrong scale (CRWD 4:1, MLI 2:1) ──
    if (prevClose > 0 && price > 0) {
      var dailyOpen = Number(t?.open ?? t?.daily_open ?? t?.dailyOpen ?? 0);
      prevClose = healPrevCloseForSplit(price, prevClose, dailyOpen);
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
    SPY:'broad_etf',RSP:'broad_etf',QQQ:'broad_etf',IWM:'broad_etf',DIA:'broad_etf',TNA:'broad_etf',
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
    WMT:'value',COST:'value',KO:'value',JPM:'value',GS:'value',PNC:'value',
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

  // ── Position sizing helpers (V15 P0.7.71) ─────────────────────────────────
  //
  // The system sizes every trade as a % of account, but the UI historically
  // showed only "X shares @ $Y" — leaving users unable to map our trade to
  // their own account. These helpers produce a uniform "context object" used
  // by the Right Rail Active Position card, the Open Trades table, the kanban
  // cards, and the Discord webhook formatter.
  //
  // Reference: PORTFOLIO_START_CASH (worker constant) is $100k. The live
  // engine uses *current* accountValue when sizing, so when the account is
  // $140k a 5% risk trade is bigger than when it was $100k. We display the
  // pct against the accountValue used at entry (when known) so users can
  // translate to their own account by multiplying by their starting capital.
  //
  // Usage:
  //   var ctx = TimedPriceUtils.computePositionContext({
  //     shares: 47.2,
  //     entryPrice: 148.50,
  //     accountValue: 140086,   // optional; defaults to 100k baseline
  //     riskBudget: 0.05,       // optional; if known, overrides notional/acct calc
  //     direction: "LONG",
  //   });
  //   ctx.sharesText      → "47 sh"
  //   ctx.notionalText    → "$7,011"
  //   ctx.pctText         → "5.0% of acct"
  //   ctx.scaleHint       → "≈ $50 risk per $1k of your account"
  //   ctx.optionsHint     → "≈ 1-2 ATM contracts (~$300-600 premium for 30-day)"
  //
  function _safeNum(v, fallback) {
    var n = Number(v);
    return Number.isFinite(n) ? n : (fallback != null ? fallback : 0);
  }

  function _fmtUsd(v) {
    if (!Number.isFinite(v)) return "—";
    var abs = Math.abs(v);
    if (abs >= 1000) return "$" + Math.round(v).toLocaleString("en-US");
    return "$" + v.toFixed(0);
  }

  function _fmtShares(v) {
    if (!Number.isFinite(v) || v <= 0) return "0 sh";
    if (v < 1) return v.toFixed(2) + " sh"; // fractional crypto
    if (v < 10) return v.toFixed(1) + " sh";
    return Math.round(v).toString() + " sh";
  }

  // Used as the canonical reference when no accountValue is supplied. Keep
  // this in lockstep with worker `PORTFOLIO_START_CASH`.
  var SYSTEM_REFERENCE_ACCOUNT = 100000;

  function computePositionContext(input) {
    input = input || {};
    var shares = _safeNum(input.shares, 0);
    var entryPrice = _safeNum(input.entryPrice, 0);
    var accountValue = _safeNum(input.accountValue, SYSTEM_REFERENCE_ACCOUNT) || SYSTEM_REFERENCE_ACCOUNT;
    var riskBudget = _safeNum(input.riskBudget, 0);

    var notional = shares > 0 && entryPrice > 0 ? shares * entryPrice : 0;
    var pctOfAccount = accountValue > 0 && notional > 0
      ? (notional / accountValue) * 100
      : (riskBudget > 0 ? riskBudget * 100 : 0);

    // Risk per $1k of user's own account, in dollars
    // e.g. if pctOfAccount = 5.0%, scaling to $1k means $50 notional per $1k
    var perThousand = pctOfAccount > 0 ? (pctOfAccount / 100) * 1000 : 0;

    var scaleHint = "";
    if (perThousand > 0) {
      scaleHint = "≈ " + _fmtUsd(perThousand) + " per $1k of your account";
    }

    // Rough options translation: a 30-day ATM call/put on a $100 stock
    // typically costs ~3-5% of underlying (varies wildly by IV). We give
    // a contracts-and-premium hint so users get a ballpark, not a strike.
    var optionsHint = "";
    if (notional > 0 && entryPrice > 0) {
      // 1 contract = 100 shares of underlying
      var contracts = Math.max(1, Math.round(shares / 100));
      // Premium estimate: ~4% of underlying notional for 30-day ATM
      var premiumLow = Math.round(notional * 0.03);
      var premiumHigh = Math.round(notional * 0.06);
      if (contracts === 1) {
        optionsHint = "options: ~1 ATM contract (~" + _fmtUsd(premiumLow) + "-" + _fmtUsd(premiumHigh) + " premium for 30-day)";
      } else {
        optionsHint = "options: ~" + contracts + " ATM contracts (~" + _fmtUsd(premiumLow) + "-" + _fmtUsd(premiumHigh) + " premium for 30-day)";
      }
    }

    return {
      shares: shares,
      notional: notional,
      pctOfAccount: pctOfAccount,
      accountValue: accountValue,
      perThousand: perThousand,
      sharesText: _fmtShares(shares),
      notionalText: _fmtUsd(notional),
      pctText: pctOfAccount > 0 ? pctOfAccount.toFixed(1) + "% of acct" : "",
      scaleHint: scaleHint,
      optionsHint: optionsHint,
    };
  }

  // Merge parent-page ticker row with /timed/latest payload for display.
  // Prefer whichever source has the fresher price-feed overlay.
  function mergePriceSrc(primary, secondary) {
    var a = primary || {};
    var b = secondary || {};
    var out = {};
    var k;
    for (k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = b[k]; }
    for (k in a) { if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k]; }
    var aPts = Number(a._price_updated_at) || Number(a.ts) || 0;
    var bPts = Number(b._price_updated_at) || Number(b.ts) || 0;
    var fresher = bPts > aPts ? b : a;
    var liveKeys = [
      "_live_price", "_live_prev_close", "_price_updated_at",
      "_rth_session_close",
      "_ah_price", "_ah_change", "_ah_change_pct",
      "day_change", "day_change_pct", "price", "close",
    ];
    for (var i = 0; i < liveKeys.length; i++) {
      var key = liveKeys[i];
      if (fresher[key] != null) out[key] = fresher[key];
    }
    // Never let a stale /timed/latest price roll back a fresher live feed
    // (SMCI rail header flicker: parent had ~$29 from WS, latest had $41).
    var aLive = Number(a._live_price);
    var bLive = Number(b._live_price);
    var outPx = Number(out.price);
    if (aLive > 0 && aPts >= bPts && outPx > 0 && Math.abs(aLive - outPx) / aLive > 0.05) {
      out.price = aLive;
      out.close = aLive;
      out._live_price = aLive;
      out._price_updated_at = aPts;
    } else if (bLive > 0 && bPts > aPts && outPx > 0 && Math.abs(bLive - outPx) / bLive > 0.05) {
      out.price = bLive;
      out.close = bLive;
      out._live_price = bLive;
      out._price_updated_at = bPts;
    }
    if (!out.ticker) out.ticker = a.ticker || b.ticker;
    if (!isNyRegularMarketOpen()) {
      var ah = Number(out._ah_price);
      var livePx = Number(out._live_price);
      var closePx = Number(out.close);
      if (closePx > 0 && ah > 0 && livePx > 0
          && Math.abs(livePx - ah) / ah < 0.001
          && Math.abs(closePx - ah) / ah > 0.001) {
        out._live_price = closePx;
        out.price = closePx;
      }
    }
    return out;
  }

  // Today's RTH session close — baseline for extended-hours % (vs TradingView).
  // Never use prev_close when today's move is known from the live feed or dp.
  function getRthSessionClose(t) {
    if (!t || typeof t !== "object") return 0;
    if (!isPriceFeedFresh(t)) return 0;

    var anchor = Number(t._rth_session_close);
    if (anchor > 0) return anchor;

    var live = Number(t._live_price);
    var close = Number(t.close);
    var price = Number(t.price);
    var prev = Number(t.prev_close ?? t.previous_close ?? t.pc ?? t._live_prev_close);

    if (live > 0 && prev > 0 && Math.abs(live - prev) / prev > 0.001) return live;
    if (close > 0 && prev > 0 && Math.abs(close - prev) / prev > 0.001) return close;
    if (price > 0 && prev > 0 && Math.abs(price - prev) / prev > 0.001) return price;

    var dc = getDailyChange(t);
    if (prev > 0 && Number.isFinite(dc?.dayPct) && Math.abs(dc.dayPct) > 0.05) {
      return Math.round(prev * (1 + dc.dayPct / 100) * 100) / 100;
    }

    var dayPct = Number(t.day_change_pct ?? t.daily_change_pct ?? t.change_pct);
    if (prev > 0 && Number.isFinite(dayPct) && Math.abs(dayPct) > 0.05) {
      return Math.round(prev * (1 + dayPct / 100) * 100) / 100;
    }

    if (live > 0) return live;
    if (close > 0) return close;
    if (price > 0) return price;
    return prev > 0 ? prev : 0;
  }

  function extPctMirrorsRthSession(pct, t) {
    var rthPct = Number(getDailyChange(t)?.dayPct);
    if (!Number.isFinite(pct) || !Number.isFinite(rthPct)) return false;
    if (Math.abs(rthPct) < 1.0) return false;
    return Math.abs(pct - rthPct) <= Math.max(0.25, Math.abs(rthPct) * 0.08);
  }

  // Stale scoring snapshot: close == prev_close but ahp carries today's print;
  // deriving EXT off prev_close reproduces RTH day change as fake AH (GS +6.84%).
  function extDerivedFromStaleRthBaseline(t, headline, pct) {
    var prev = Number(t.prev_close ?? t.previous_close ?? t.pc ?? t._live_prev_close);
    if (!(prev > 0 && headline > 0)) return false;
    if (Math.abs(headline - prev) / prev >= 0.001) return false;
    if (extPctMirrorsRthSession(pct, t)) return true;
    var ahdp = Number(t._ah_change_pct ?? t.extended_percent_change);
    if (!Number.isFinite(ahdp) || Math.abs(ahdp) < 3.0) return false;
    return Math.abs(pct - ahdp) <= Math.max(0.3, Math.abs(ahdp) * 0.05);
  }

  // Extended-hours change resolver — single source of truth for
  // pre-market / after-hours display across cards + right rail.
  // Returns { pct, price, chg } or null.
  function getExtChange(t) {
    if (isNyRegularMarketOpen()) return null;
    if (!isPriceFeedFresh(t)) return null;
    var sym = String(t && t.ticker || "").toUpperCase();
    if (sym === "BTCUSD" || sym === "ETHUSD") return null;

    var headline = getRthSessionClose(t) || getHeadlinePrice(t) || 0;
    var pct = Number(
      t && t._ah_change_pct != null ? t._ah_change_pct :
      t && t.extended_percent_change != null ? t.extended_percent_change :
      NaN
    );
    var px = Number(
      t && t._ah_price != null ? t._ah_price :
      t && t.extended_price != null ? t.extended_price :
      NaN
    );
    var chg = Number(
      t && t._ah_change != null ? t._ah_change :
      t && t.extended_change != null ? t.extended_change :
      NaN
    );

    var hasDistinctExtPx = headline > 0 && px > 0 && Math.abs(px - headline) > 0.001;

    // When the extended print differs from today's RTH close, derive % from
    // price — never trust cached ahdp if it disagrees (GS: ahp below close
    // but stale ahdp still +0.66%).
    if (hasDistinctExtPx) {
      pct = Math.round(((px - headline) / headline) * 10000) / 100;
      chg = Math.round((px - headline) * 100) / 100;
      if (extDerivedFromStaleRthBaseline(t, headline, pct) || extPctMirrorsRthSession(pct, t)) {
        return null;
      }
      // GS @ 1090: cached ahp can be last session's RTH close while headline
      // moved; stale ahdp still carries +6.84% RTH move. Suppress when the
      // cached pct disagrees materially with the price-derived EXT move.
      var cachedAhdp = Number(t._ah_change_pct ?? t.extended_percent_change);
      if (Number.isFinite(cachedAhdp) && Math.abs(cachedAhdp) > 3
          && Math.abs(cachedAhdp - pct) > Math.max(2, Math.abs(pct) * 2)) {
        return null;
      }
    } else if (headline > 0 && Number.isFinite(pct) && Math.abs(pct) >= 0.05 && !(px > 0)) {
      // Reject ahdp that mirrors RTH day change (GS +6.84% EXT bleed when AH flat).
      if (extPctMirrorsRthSession(pct, t)) {
        return null;
      }
      // No extended print — fall back to cached ahdp only when ahp is absent.
      px = Math.round(headline * (1 + pct / 100) * 100) / 100;
      if (!Number.isFinite(chg)) chg = Math.round((px - headline) * 100) / 100;
      hasDistinctExtPx = Math.abs(px - headline) > 0.001;
    } else if (headline > 0 && px > 0 && !Number.isFinite(pct)) {
      pct = Math.round(((px - headline) / headline) * 10000) / 100;
      chg = Math.round((px - headline) * 100) / 100;
      hasDistinctExtPx = Math.abs(px - headline) > 0.001;
    }

    if (!hasDistinctExtPx) return null;
    if (!(px > 0)) return null;

    // GS zombie: stale snapshot _ah_price (old RTH close) vs fresh headline.
    if (headline > 0 && Math.abs(px - headline) / headline > 0.04) {
      var livePx = Number(t._live_price ?? t.price ?? t.close);
      if (livePx > 0 && Math.abs(px - livePx) / livePx > 0.04) return null;
    }

    // Cross-session stale guard (e.g. CRDO extended_price lagging RTH).
    // Suppress only when the extended print disagrees with today's session
    // direction — large same-direction AH pops (earnings AMC) must pass.
    if (headline > 0) {
      var driftPct = ((px - headline) / headline) * 100;
      var absDrift = Math.abs(driftPct);
      var dayPct = Number(getDailyChange(t)?.dayPct);
      var dirDisagree = Number.isFinite(dayPct)
        && Math.abs(dayPct) > 1.5
        && Math.sign(dayPct) !== Math.sign(driftPct);
      if (absDrift > 4 && dirDisagree) return null;
    }

    return {
      pct: pct,
      price: px,
      chg: Number.isFinite(chg) ? chg : null,
    };
  }

  /**
   * Bubble map fill + drift — session-aware price move for color/intensity.
   * RTH: daily change vs prev close (getDailyChange).
   * Outside RTH: extended-hours move vs today's RTH close when available.
   */
  function getBubbleFillChange(t) {
    if (isNyRegularMarketOpen()) {
      var dc = getDailyChange(t);
      return {
        pct: dc.dayPct,
        chg: dc.dayChg,
        source: "rth",
        hasData: Number.isFinite(dc.dayPct),
      };
    }
    var ext = getExtChange(t);
    if (ext && Number.isFinite(ext.pct)) {
      return {
        pct: ext.pct,
        chg: ext.chg,
        source: "ext",
        hasData: true,
      };
    }
    var dcFallback = getDailyChange(t);
    return {
      pct: dcFallback.dayPct,
      chg: dcFallback.dayChg,
      source: "rth",
      hasData: Number.isFinite(dcFallback.dayPct),
    };
  }

  /**
   * Authoritative model direction for a ticker, mirroring the server-side
   * `inferTraderDirection()` in worker/index.js (around line 38236). Returns
   * "LONG", "SHORT", or "" (unknown).
   *
   * Why this exists (2026-05-21):
   *   The right rail's bias chip was reading `ticker.state` (HTF_BULL / HTF_BEAR)
   *   on first render, then re-rendering after /timed/prediction-contract
   *   resolved with a different direction (`swing_consensus.direction` /
   *   `trigger_dir` based). For NVDA: state=HTF_BULL but swing_consensus=BEARISH,
   *   so the chip flipped from "LONG BIAS" → "SHORT BIAS" a few hundred ms
   *   after open. The Today card showed BULL the whole time because it ALSO
   *   read `state`. The user's expectation is that whichever direction the
   *   model is actually recommending should be shown everywhere — first paint
   *   and ever after. Computing the same priority order client-side from the
   *   already-cached snapshot fields eliminates the flip and makes the card
   *   and rail agree on every page.
   *
   * Priority (matches worker):
   *   1. swing_consensus.direction  ("BULLISH" / "BEARISH" / "LONG" / "SHORT")
   *   2. trigger_dir                 ("LONG" / "SHORT")
   *   3. state                       (contains "BEAR" → SHORT, else LONG)
   *
   * Callers that need a hard-trade override (open position direction) should
   * apply it BEFORE calling this (right rail does).
   */
  function inferModelDirection(t) {
    if (!t || typeof t !== "object") return "";
    var consensus = t.swing_consensus || {};
    var cd = String(consensus.direction || "").toUpperCase();
    if (cd === "BULLISH" || cd === "LONG") return "LONG";
    if (cd === "BEARISH" || cd === "SHORT") return "SHORT";
    var trig = String(t.trigger_dir || "").toUpperCase();
    if (trig === "LONG" || trig === "SHORT") return trig;
    var state = String(t.state || "").toUpperCase();
    if (state.indexOf("BEAR") !== -1) return "SHORT";
    if (state.indexOf("BULL") !== -1) return "LONG";
    return "";
  }

  function _num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Live book only — positions table rows, not promoted/backtest ledger ghosts. */
  function isTradeOpen(tr) {
    if (!tr || typeof tr !== "object") return false;
    var status = String(tr.status || "").toUpperCase();
    var exitTs = tr.exit_ts ?? tr.exitTs ?? 0;
    var trimmedPct = Number(tr.trimmed_pct ?? tr.trimmedPct ?? 0);
    if (status === "WIN" || status === "LOSS" || status === "FLAT" || status === "ARCHIVED" || status === "CLOSED" || status === "CANCELED") return false;
    if (exitTs) return false;
    if (trimmedPct >= 0.9999) return false;
    // Require explicit open status — empty status lets promoted ledger ghosts through.
    return status === "OPEN" || status === "TP_HIT_TRIM";
  }

  function isDiscoveryKanbanStage(stage) {
    var s = String(stage || "").toLowerCase();
    return s === "setup" || s === "setup_watch" || s === "flip_watch" || s === "in_review"
      || s === "enter" || s === "enter_now" || s === "just_flipped" || s === "watch";
  }

  /** Strip ghost OPEN_* posture from discovery-lane tickers unless a live trade is verified. */
  function sanitizeTickerOpenPosture(t, openTrade) {
    if (!t || typeof t !== "object") return t;
    var openTr = isTradeOpen(openTrade) ? openTrade : (isTradeOpen(t._openTrade) ? t._openTrade : null);
    if (openTr) {
      return Object.assign({}, t, {
        _openTrade: openTr,
        has_open_position: true,
        position_direction: openTr.direction || t.position_direction || null,
      });
    }
    var stage = String(t.kanban_stage || t._effectiveKanbanStage || "").toLowerCase();
    if (!isDiscoveryKanbanStage(stage)) {
      return Object.assign({}, t, { _openTrade: null });
    }
    var next = Object.assign({}, t, { _openTrade: null, has_open_position: false });
    var raw = String(next.trader_posture || next.traderPosture || next.posture || "").toUpperCase().replace(/\s+/g, "_");
    if (raw === "OPEN_LONG" || raw === "OPEN_SHORT") {
      delete next.trader_posture;
      delete next.traderPosture;
      if (String(next.posture || "").toUpperCase().indexOf("OPEN_") === 0) delete next.posture;
    }
    if (next.posture_label && /open\s+(long|short)/i.test(String(next.posture_label))) {
      delete next.posture_label;
    }
    return next;
  }

  function inferTraderPosture(t) {
    if (!t || typeof t !== "object") {
      return { posture: "NEUTRAL", label: "NEUTRAL", direction: "", strength: "neutral", reason: "no_data" };
    }

    var rawPosture = String(t.trader_posture || t.traderPosture || t.posture || "").toUpperCase();
    if (rawPosture) {
      rawPosture = rawPosture.replace(/\s+/g, "_");
      if (rawPosture === "OPEN_LONG") {
        return { posture: "OPEN_LONG", label: "Open Long", direction: "LONG", strength: "open", reason: "server" };
      }
      if (rawPosture === "OPEN_SHORT") {
        return { posture: "OPEN_SHORT", label: "Open Short", direction: "SHORT", strength: "open", reason: "server" };
      }
      if (rawPosture === "LEAN_LONG" || rawPosture === "LONG_LEAN") {
        return { posture: "LEAN_LONG", label: "Leaning bullish", direction: "LONG", strength: "lean", reason: "server" };
      }
      if (rawPosture === "LEAN_SHORT" || rawPosture === "SHORT_LEAN") {
        return { posture: "LEAN_SHORT", label: "Leaning bearish", direction: "SHORT", strength: "lean", reason: "server" };
      }
      if (rawPosture === "LONG") {
        return { posture: "LONG", label: "Bullish", direction: "LONG", strength: "confirmed", reason: "server" };
      }
      if (rawPosture === "SHORT") {
        return { posture: "SHORT", label: "Bearish", direction: "SHORT", strength: "confirmed", reason: "server" };
      }
    if (rawPosture === "NEUTRAL" || rawPosture === "WAIT") {
      return { posture: "NEUTRAL", label: "Neutral", direction: "", strength: "neutral", reason: "server" };
    }
    }

    // Open position wins over Bullish/Bearish lean (MU trim lane, GS hold).
    var openTr = t._openTrade;
    if (isTradeOpen(openTr)) {
      var odir = String(openTr.direction || "").toUpperCase();
      if (odir === "LONG" || odir === "SHORT") {
        return {
          posture: odir === "LONG" ? "OPEN_LONG" : "OPEN_SHORT",
          label: odir === "LONG" ? "Open Long" : "Open Short",
          direction: odir,
          strength: "open",
          reason: "open_trade",
        };
      }
    }
    if (t.has_open_position) {
      var pdir = String(t.position_direction || "").toUpperCase();
      if (pdir === "LONG" || pdir === "SHORT") {
        return {
          posture: pdir === "LONG" ? "OPEN_LONG" : "OPEN_SHORT",
          label: pdir === "LONG" ? "Open Long" : "Open Short",
          direction: pdir,
          strength: "open",
          reason: "has_open_position",
        };
      }
    }

    var stage = String(t.kanban_stage || t.stage || "").toLowerCase();
    var isActionableStage = stage === "enter" || stage === "enter_now" || stage === "just_flipped" || stage === "in_review";
    var isManagementStage = stage === "hold" || stage === "active" || stage === "just_entered" || stage === "trim" || stage === "defend";
    var modelDir = inferModelDirection(t);
    var consensus = t.swing_consensus || {};
    var cd = String(consensus.direction || "").toUpperCase();
    if (cd === "BULLISH") cd = "LONG";
    if (cd === "BEARISH") cd = "SHORT";
    var avgBias = _num(consensus.avg_bias != null ? consensus.avg_bias : consensus.avgBias);
    var bullishCount = _num(consensus.bullish_count != null ? consensus.bullish_count : consensus.bullishCount) || 0;
    var bearishCount = _num(consensus.bearish_count != null ? consensus.bearish_count : consensus.bearishCount) || 0;
    var htf = _num(t.htf_score);
    var ltf = _num(t.ltf_score);
    var absBias = avgBias == null ? 0 : Math.abs(avgBias);
    var biasDir = avgBias == null || Math.abs(avgBias) < 0.15 ? "" : avgBias > 0 ? "LONG" : "SHORT";

    var conf = t.confluence_verdict || {};
    var confMode = String(conf.mode || "").toUpperCase();
    var confSide = String(conf.side || "").toUpperCase();
    var rootWait = confMode === "WAIT" || confSide === "NEUTRAL";
    var weakConviction = Number(t.focus_conviction_score ?? t.__focus_conviction_score ?? 0) > 0
      && Number(t.focus_conviction_score ?? t.__focus_conviction_score ?? 0) < 50;

    if (isActionableStage || isManagementStage) {
      var confirmedDir = cd === "LONG" || cd === "SHORT" ? cd : modelDir;
      if (confirmedDir === "LONG" || confirmedDir === "SHORT") {
        if (isManagementStage && isTradeOpen(openTr)) {
          return {
            posture: confirmedDir === "LONG" ? "OPEN_LONG" : "OPEN_SHORT",
            label: confirmedDir === "LONG" ? "Open Long" : "Open Short",
            direction: confirmedDir,
            strength: "open",
            reason: "management_stage",
          };
        }
        return { posture: confirmedDir, label: confirmedDir === "LONG" ? "Bullish" : "Bearish", direction: confirmedDir, strength: "confirmed", reason: "actionable_stage" };
      }
    }

    if (biasDir && absBias >= 0.3 && (!cd || cd !== biasDir)) {
      return {
        posture: biasDir === "LONG" ? "LEAN_LONG" : "LEAN_SHORT",
        label: biasDir === "LONG" ? "Leaning bullish" : "Leaning bearish",
        direction: biasDir,
        strength: "lean",
        reason: "swing_consensus"
      };
    }

    if ((rootWait || weakConviction) && !cd) {
      if (biasDir && absBias >= 0.15) {
        return {
          posture: biasDir === "LONG" ? "LEAN_LONG" : "LEAN_SHORT",
          label: biasDir === "LONG" ? "Leaning bullish" : "Leaning bearish",
          direction: biasDir,
          strength: "lean",
          reason: rootWait ? "root_wait" : "low_conviction"
        };
      }
      return { posture: "NEUTRAL", label: "Neutral", direction: "", strength: "neutral", reason: rootWait ? "root_wait" : "low_conviction" };
    }

    if (cd === "LONG" || cd === "SHORT") {
      if (stage === "watch" || stage === "setup" || stage === "setup_watch" || stage === "flip_watch") {
        return {
          posture: cd === "LONG" ? "LEAN_LONG" : "LEAN_SHORT",
          label: cd === "LONG" ? "Leaning bullish" : "Leaning bearish",
          direction: cd,
          strength: "lean",
          reason: "watch_stage"
        };
      }
      return { posture: cd, label: cd === "LONG" ? "Bullish" : "Bearish", direction: cd, strength: "confirmed", reason: "consensus_direction" };
    }

    if (biasDir) {
      return {
        posture: biasDir === "LONG" ? "LEAN_LONG" : "LEAN_SHORT",
        label: biasDir === "LONG" ? "Leaning bullish" : "Leaning bearish",
        direction: biasDir,
        strength: "lean",
        reason: "weak_consensus"
      };
    }

    if (modelDir === "LONG" || modelDir === "SHORT") {
      var conflict = Number.isFinite(htf) && Number.isFinite(ltf) && Math.sign(htf) !== Math.sign(ltf);
      if (conflict || bullishCount + bearishCount === 0) {
        return { posture: "NEUTRAL", label: "Neutral", direction: "", strength: "neutral", reason: conflict ? "htf_ltf_conflict" : "no_consensus" };
      }
      return {
        posture: modelDir === "LONG" ? "LEAN_LONG" : "LEAN_SHORT",
        label: modelDir === "LONG" ? "Leaning bullish" : "Leaning bearish",
        direction: modelDir,
        strength: "lean",
        reason: "state_fallback"
      };
    }

    return { posture: "NEUTRAL", label: "Neutral", direction: "", strength: "neutral", reason: "balanced" };
  }

  /** Bubble map + right rail share the same trader posture contract. */
  function resolveBubblePosture(t, openTrade) {
    var next = sanitizeTickerOpenPosture(t, openTrade);
    if (isTradeOpen(openTrade)) next._openTrade = openTrade;
    return inferTraderPosture(next);
  }

  function getBubbleBiasDirection(t, openTrade) {
    return resolveBubblePosture(t, openTrade).direction || "";
  }

  /**
   * Higher-TF structural bias for Key Levels / Trade Plan labels.
   * Weekly ST direction + slope beats tactical compression timing when posture
   * is Neutral (e.g. NFLX: bearish weekly ST sloping down at 233 EMA support).
   */
  function inferStructuralBiasFromTicker(t) {
    if (!t || typeof t !== "object") return "";
    const tfm = t.tf_tech || {};
    const tfW = tfm.W || null;
    const tfD = tfm.D || null;

    const stDir = (row) => Number(row?.stDir);
    const stSlope = (row) => Number(row?.stSlope);

    const wDir = stDir(tfW);
    const wSlope = stSlope(tfW);
    if (Number.isFinite(wDir) && wDir > 0 && wSlope === -1) return "SHORT";
    if (Number.isFinite(wDir) && wDir < 0 && wSlope === 1) return "LONG";
    if (Number.isFinite(wDir) && wDir > 0 && Math.abs(wSlope) !== 1) return "SHORT";
    if (Number.isFinite(wDir) && wDir < 0 && Math.abs(wSlope) !== 1) return "LONG";

    const phaseZ = String(tfD?.phase?.z || t.phase_zone || "").toUpperCase();
    if (phaseZ.includes("DISTRIBUTION") || phaseZ === "EXTREME_UP" || phaseZ.includes("MARKDOWN")) {
      return "SHORT";
    }
    if (phaseZ.includes("ACCUMULATION") || phaseZ === "EXTREME_DOWN") {
      return "LONG";
    }

    const state = String(t.state || "").toUpperCase();
    if (state.startsWith("HTF_BEAR")) return "SHORT";
    if (state.startsWith("HTF_BULL")) return "LONG";

    return inferModelDirection(t);
  }

  /**
   * Merge a price-feed tick onto an existing row.
   * RTH: headline = live tick (p).
   * Outside RTH: headline = RTH close; extended print rides _ah_* only.
   */
  function applyPriceFeedOverlay(existing, p, marketOpen) {
    var feedP = Number(p && p.p);
    if (!(feedP > 0)) return null;

    if (marketOpen) {
      var openOverlay = { price: feedP, _live_price: feedP };
      var openAhp = Number(p.ahp);
      if (Number.isFinite(openAhp) && openAhp > 0) {
        openOverlay._ah_price = openAhp;
        var openAhdc = Number(p.ahdc);
        var openAhdp = Number(p.ahdp);
        if (Number.isFinite(openAhdc)) openOverlay._ah_change = openAhdc;
        if (Number.isFinite(openAhdp)) openOverlay._ah_change_pct = openAhdp;
      }
      return openOverlay;
    }

    var ahp = Number(p.ahp);
    var hasKvExt = Number.isFinite(ahp) && ahp > 0;
    var existingClose = Number(
      (existing && existing.close) ?? (existing && existing._live_price) ?? (existing && existing.price)
    );
    var session = String(p.session || "").toUpperCase();
    var inExtSession = session === "AH" || session === "PRE";

    if (hasKvExt) {
      var kvOverlay = {
        price: feedP, close: feedP, _live_price: feedP, _ah_price: ahp,
        _rth_session_close: feedP,
      };
      var ahdc = Number(p.ahdc);
      var ahdp = Number(p.ahdp);
      if (Number.isFinite(ahdc)) kvOverlay._ah_change = ahdc;
      if (Number.isFinite(ahdp)) kvOverlay._ah_change_pct = ahdp;
      return kvOverlay;
    }

    if (isAuthoritativeRthPoll(p)) {
      return { price: feedP, close: feedP, _live_price: feedP, _rth_session_close: feedP };
    }

    var anchor = Number(existing && existing._rth_session_close);
    var printLooksExt = existingClose > 0 && Math.abs(feedP - existingClose) > 0.001;
    if (printLooksExt || inExtSession) {
      var rthClose = anchor > 0 ? anchor : (existingClose > 0 ? existingClose : feedP);
      var extOverlay = {
        price: rthClose, close: rthClose, _live_price: rthClose, _ah_price: feedP,
      };
      if (anchor > 0) extOverlay._rth_session_close = anchor;
      var extChg = Number(p.ahdc != null ? p.ahdc : p.ahChg);
      var extPct = Number(p.ahdp != null ? p.ahdp : p.ahChgPct);
      if (Number.isFinite(extChg)) {
        extOverlay._ah_change = extChg;
      } else if (rthClose > 0) {
        extOverlay._ah_change = Math.round((feedP - rthClose) * 100) / 100;
      }
      if (Number.isFinite(extPct)) {
        extOverlay._ah_change_pct = extPct;
      } else if (rthClose > 0) {
        extOverlay._ah_change_pct = Math.round(((feedP - rthClose) / rthClose) * 10000) / 100;
      }
      return extOverlay;
    }

    return { price: feedP, close: feedP, _live_price: feedP, _rth_session_close: feedP };
  }

  // Expose on window for consumption by all pages
  window.TimedPriceUtils = {
    getIngestMs: getIngestMs,
    getNyClock: getNyClock,
    isNyRegularMarketOpen: isNyRegularMarketOpen,
    isNyPreMarket: isNyPreMarket,
    isAuthoritativeRthPoll: isAuthoritativeRthPoll,
    shouldApplyDayChangeFromTick: shouldApplyDayChangeFromTick,
    ageLabelFromMinutes: ageLabelFromMinutes,
    getStaleInfo: getStaleInfo,
    getHeadlinePrice: getHeadlinePrice,
    getRthSessionClose: getRthSessionClose,
    isPriceFeedFresh: isPriceFeedFresh,
    getPriceValueAgeMs: getPriceValueAgeMs,
    mergePriceSrc: mergePriceSrc,
    applyPriceFeedOverlay: applyPriceFeedOverlay,
    getDailyChange: getDailyChange,
    getExtChange: getExtChange,
    getBubbleFillChange: getBubbleFillChange,
    inferModelDirection: inferModelDirection,
    inferStructuralBiasFromTicker: inferStructuralBiasFromTicker,
    inferTraderPosture: inferTraderPosture,
    resolveBubblePosture: resolveBubblePosture,
    getBubbleBiasDirection: getBubbleBiasDirection,
    isTradeOpen: isTradeOpen,
    isDiscoveryKanbanStage: isDiscoveryKanbanStage,
    sanitizeTickerOpenPosture: sanitizeTickerOpenPosture,
    TYPICAL_DAILY_RANGE: TYPICAL_DAILY_RANGE,
    TICKER_TYPE_MAP: TICKER_TYPE_MAP,
    resolveTickerType: resolveTickerType,
    getNormalizedIntensity: getNormalizedIntensity,
    SYSTEM_REFERENCE_ACCOUNT: SYSTEM_REFERENCE_ACCOUNT,
    computePositionContext: computePositionContext,
    // Exposed for tests/calendar-parity.test.js — keep in sync with the
    // worker calendars (see comment above US_MARKET_HOLIDAYS).
    _calendarTables: {
      holidays: US_MARKET_HOLIDAYS,
      halfDays: US_MARKET_HALF_DAYS,
    },
  };
})();

// cache-bust:1784035454988:347915862
