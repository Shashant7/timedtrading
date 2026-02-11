/**
 * Shared price utility functions — single source of truth for daily change,
 * staleness detection, and market-hours logic.
 *
 * Used by: index-react.html (Dashboard), simulation-dashboard.html (Trades),
 *          shared-right-rail.js (via dependency injection from parent page).
 *
 * Exposes: window.TimedPriceUtils = { getIngestMs, getNyClock, isNyRegularMarketOpen,
 *          ageLabelFromMinutes, getStaleInfo, getDailyChange }
 */
(function () {
  "use strict";

  function getIngestMs(src) {
    const raw = src?.ingest_ts ?? src?.ingest_time ?? src?.ts;
    if (raw == null) return null;
    const msRaw =
      typeof raw === "number" ? raw : new Date(String(raw)).getTime();
    // Heuristic: if seconds, convert to ms
    const ms =
      typeof msRaw === "number" && msRaw > 0 && msRaw < 1e12
        ? msRaw * 1000
        : msRaw;
    return Number.isFinite(ms) ? ms : null;
  }

  function getNyClock(now) {
    if (now === undefined) now = new Date();
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(now);
      const get = (type) => parts.find((p) => p.type === type)?.value;
      const weekday = get("weekday") || "";
      const hour = Number(get("hour"));
      const minute = Number(get("minute"));
      return {
        weekday,
        hour: Number.isFinite(hour) ? hour : null,
        minute: Number.isFinite(minute) ? minute : null,
      };
    } catch {
      return { weekday: "", hour: null, minute: null };
    }
  }

  function isNyRegularMarketOpen(now) {
    if (now === undefined) now = new Date();
    const { weekday, hour, minute } = getNyClock(now);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return true; // fail open (don't hide data)
    const wd = String(weekday || "").toLowerCase();
    const isWeekday =
      wd.startsWith("mon") ||
      wd.startsWith("tue") ||
      wd.startsWith("wed") ||
      wd.startsWith("thu") ||
      wd.startsWith("fri");
    if (!isWeekday) return false;
    const mins = hour * 60 + minute;
    const open = 9 * 60 + 30; // 9:30 ET
    const close = 16 * 60; // 16:00 ET
    return mins >= open && mins <= close;
  }

  function ageLabelFromMinutes(ageMin) {
    const m = Number(ageMin);
    if (!Number.isFinite(m) || m < 0) return null;
    if (m >= 60 * 24) return `${Math.round(m / (60 * 24))}d`;
    if (m >= 120) return `${Math.round(m / 60)}h`;
    return `${Math.round(m)}m`;
  }

  function getStaleInfo(src, opts) {
    const maxAgeMin = (opts && opts.maxAgeMin) || 90;
    const staleness = String(src?.staleness || "").toUpperCase();
    const ingestMs = getIngestMs(src);
    const ageMin = Number.isFinite(ingestMs)
      ? (Date.now() - ingestMs) / 60000
      : null;
    const staleByFlag = staleness && staleness !== "FRESH";
    const staleByAge = Number.isFinite(ageMin) && ageMin > maxAgeMin;
    const isStale = !!(staleByFlag || staleByAge);
    return {
      staleness: staleness || null,
      ingestMs,
      ageMin: Number.isFinite(ageMin) ? ageMin : null,
      ageLabel: ageLabelFromMinutes(ageMin),
      staleByFlag: !!staleByFlag,
      staleByAge: !!staleByAge,
      isStale,
    };
  }

  function getDailyChange(t) {
    const marketOpen = isNyRegularMarketOpen();

    // ── Live price feed data (from /timed/prices) ──
    // If we have fresh live price data, use it directly — it's more reliable than
    // derived values from scoring snapshots.
    const livePrice = Number(t?._live_price);
    const livePrevClose = Number(t?._live_prev_close);
    const liveDailyChange = Number(t?._live_daily_change);
    const liveDailyChangePct = Number(t?._live_daily_change_pct);
    const priceAge = t?._price_updated_at
      ? (Date.now() - t._price_updated_at) / 60000
      : Infinity;

    if (
      Number.isFinite(livePrice) &&
      livePrice > 0 &&
      Number.isFinite(liveDailyChangePct) &&
      priceAge < 5
    ) {
      return {
        dayChg: liveDailyChange,
        dayPct: liveDailyChangePct,
        stale: { isStale: false, ageMin: priceAge },
        marketOpen,
        livePrice: true,
      };
    }

    // ── Fallback to scoring snapshot data ──
    // In after-hours/weekends, allow a wider "fresh" window so we can still show
    // daily change for analysis.  We still treat explicit STALE flags as stale.
    const maxAgeMin = marketOpen ? 90 : 72 * 60;
    const stale = getStaleInfo(t, { maxAgeMin });
    // During market hours: do not show daily change if stale.
    // Outside market hours: allow stale-by-age (but not stale-by-flag) so the UI
    // isn't blank.
    if (stale.isStale && (marketOpen || stale.staleByFlag)) {
      return { dayChg: null, dayPct: null, stale, marketOpen };
    }
    const price = Number(t?.price);
    const pickNum = function (obj, keys) {
      for (var i = 0; i < keys.length; i++) {
        var v = Number(obj?.[keys[i]]);
        if (Number.isFinite(v)) return v;
      }
      return null;
    };
    const prevClose = pickNum(t, [
      "prev_close",
      "previous_close",
      "prior_close",
      "yclose",
      "close_prev",
    ]);
    // Prefer explicit daily-change fields from ingest (Heartbeat Pine emits these).
    // However, some stored "latest" snapshots can carry a stale/incorrect
    // prev_close-derived day_change_pct. So we treat "change/change_pct" as a
    // safe fallback *only when* the day_* values look absurd.
    var dayChg = pickNum(t, [
      "day_change",
      "daily_change",
      "session_change",
      "change",
      "chg",
      "ch",
    ]);
    var dayPct = pickNum(t, [
      "day_change_pct",
      "daily_change_pct",
      "session_change_pct",
      "change_pct",
      "pct_change",
      "chp",
    ]);

    const altChg = pickNum(t, ["change", "session_change"]);
    const altPct = pickNum(t, [
      "change_pct",
      "pct_change",
      "session_change_pct",
    ]);
    const looksAbsurd = function (pct) {
      return Number.isFinite(pct) && Math.abs(pct) > 5;
    };
    const looksSane = function (pct) {
      return Number.isFinite(pct) && Math.abs(pct) <= 5;
    };

    // If day_* is present but looks wrong, fall back to change/change_pct when it
    // looks sane.  Also handle the more common failure mode: day_* and change_*
    // disagree (often due to a bad prev_close anchor).
    const pctDisagrees =
      Number.isFinite(dayPct) &&
      Number.isFinite(altPct) &&
      (dayPct >= 0 !== altPct >= 0 || Math.abs(dayPct - altPct) >= 1.5);
    if ((looksAbsurd(dayPct) && looksSane(altPct)) || pctDisagrees) {
      if (Number.isFinite(altPct)) dayPct = altPct;
      // Also switch $ change to avoid mismatched "$ + %".
      if (Number.isFinite(altChg)) dayChg = altChg;
    }

    // If missing, compute like a watchlist using prev close.
    if (
      !Number.isFinite(dayChg) &&
      !Number.isFinite(dayPct) &&
      Number.isFinite(price) &&
      price > 0 &&
      Number.isFinite(prevClose) &&
      prevClose > 0
    ) {
      dayChg = price - prevClose;
      dayPct = (dayChg / prevClose) * 100;
    }

    // If only one of (abs, pct) is present, compute the other using current price
    if (
      !Number.isFinite(dayChg) &&
      Number.isFinite(dayPct) &&
      Number.isFinite(price) &&
      price > 0
    ) {
      const p = dayPct / 100;
      if (Number.isFinite(p) && Math.abs(p) < 5) {
        const prev = price / (1 + p);
        const abs = price - prev;
        dayChg = Number.isFinite(abs) ? abs : null;
      }
    }
    if (
      !Number.isFinite(dayPct) &&
      Number.isFinite(dayChg) &&
      Number.isFinite(price) &&
      price > 0
    ) {
      const prev = price - dayChg;
      if (Number.isFinite(prev) && Math.abs(prev) > 1e-9) {
        dayPct = (dayChg / prev) * 100;
      }
    }
    return { dayChg, dayPct, stale, marketOpen };
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
