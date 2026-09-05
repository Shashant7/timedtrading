// shared-vehicle-quote.js — Kanban quote + POSITION bar for paper vehicles.
// Options use the contract premium path. LETF uses the vehicle print.
// Never feed getHeadlinePrice (underlying) into an option/LETF card.
(function () {
  "use strict";

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function paperLane(ticker, trade) {
    return String(ticker?._paper_lane || trade?._paper_lane || "").toLowerCase();
  }

  function instrumentOf(ticker, trade) {
    return String(trade?.instrument || ticker?.instrument || "").toLowerCase();
  }

  function vehicleLabel(ticker, trade) {
    return String(ticker?._vehicle_label || trade?._vehicle_label || trade?._vehicle_ticker || "");
  }

  function isOptionVehicle(ticker, trade) {
    const t = trade || ticker?._openTrade || null;
    if (instrumentOf(ticker, t) === "option") return true;
    if (paperLane(ticker, t) === "index_day_trade") return true;
    if (num(t?.entry_premium) || num(t?.last_premium) || num(ticker?._live_premium)) return true;
    return /\d+[CP]\b/i.test(vehicleLabel(ticker, t));
  }

  function isLetfVehicle(ticker, trade) {
    const t = trade || ticker?._openTrade || null;
    if (instrumentOf(ticker, t) === "letf") return true;
    return paperLane(ticker, t) === "index_swing";
  }

  // Drop levels that are clearly a different unit (premium $1 vs QQQ $570).
  function sameUnit(px, ep) {
    const a = num(px);
    const b = num(ep);
    if (!a || !b) return false;
    const r = a / b;
    return r >= 0.15 && r <= 8;
  }

  function livePremium(ticker, trade) {
    const t = trade || {};
    return num(t.mark_price)
      || num(t.current_price)
      || num(t.last_premium)
      || num(ticker?._live_premium)
      || num(ticker?.price);
  }

  function entryPremium(trade) {
    return num(trade?.entry_premium) || num(trade?.entry_price) || num(trade?.entryPrice);
  }

  function quoteFromLevels(live, ep) {
    let dayPct = null;
    let dayChg = null;
    if (live && ep) {
      dayPct = ((live - ep) / ep) * 100;
      dayChg = live - ep;
    }
    const dir = dayPct == null || Math.abs(dayPct) < 0.05 ? "flat" : dayPct > 0 ? "up" : "dn";
    return { price: live, dayPct, dayChg, dir, extLine: null };
  }

  function optionQuote(ticker, trade) {
    const live = livePremium(ticker, trade);
    const ep = entryPremium(trade);
    return { ...quoteFromLevels(live, ep), kind: "option" };
  }

  function letfQuote(ticker, trade) {
    const t = trade || {};
    const live = num(t.mark_price) || num(t.current_price) || num(ticker?.price);
    const ep = num(t.entry_price) || num(t.entryPrice);
    return { ...quoteFromLevels(live, ep), kind: "letf" };
  }

  function collectOptionTargets(trade, ep) {
    const tps = [];
    const seen = new Set();
    const pushTp = (px) => {
      const n = num(px?.price ?? px);
      if (!n || n <= ep || !sameUnit(n, ep) || seen.has(n)) return;
      seen.add(n);
      tps.push(n);
    };
    if (Array.isArray(trade?.tpArray)) trade.tpArray.forEach(pushTp);
    else if (Array.isArray(trade?.tp_array)) trade.tp_array.forEach(pushTp);
    pushTp(trade?.trim_premium);
    pushTp(trade?.exit_premium);
    pushTp(trade?.tp);
    pushTp(trade?.take_profit);
    return tps;
  }

  // Long premium for both calls and puts — the book profits when the
  // contract mark rises, regardless of underlying direction.
  function optionProgressBar(trade, livePx) {
    const ep = entryPremium(trade);
    const live = num(livePx) || livePremium(null, trade);
    if (!ep || !live) return null;

    const slRaw = num(trade?.stop_premium)
      || num(trade?.trail_stop_premium)
      || num(trade?.sl)
      || num(trade?.stop_loss)
      || (ep * 0.5);
    const slToUse = (slRaw && sameUnit(slRaw, ep) && slRaw < ep * 1.02) ? slRaw : null;
    const tps = collectOptionTargets(trade, ep);

    const allPx = [ep, live, slToUse, ...tps].filter((p) => Number.isFinite(p) && p > 0);
    if (allPx.length < 2) return null;
    const min = Math.min(...allPx);
    const max = Math.max(...allPx);
    const padding = (max - min) * 0.05 || 0.05;
    const lo = min - padding;
    const hi = max + padding;
    const xPct = (px) => Math.max(0, Math.min(100, ((px - lo) / (hi - lo)) * 100));
    const pnlPct = ((live - ep) / ep) * 100;
    const ticks = [];
    if (slToUse) ticks.push({ px: slToUse, label: "SL", color: "var(--ds-dn)" });
    ticks.push({ px: ep, label: "E", color: "var(--ds-text-muted)" });
    tps.forEach((tp, i) => ticks.push({ px: tp, label: `T${i + 1}`, color: "var(--ds-up)" }));
    ticks.sort((a, b) => a.px - b.px);
    return { xPct, pnlPct, ticks, ep, curX: xPct(live) };
  }

  function pickOpenTrade(ticker, bookTrade) {
    if (ticker?._paper_lane || isOptionVehicle(ticker, ticker?._openTrade) || isLetfVehicle(ticker, ticker?._openTrade)) {
      return ticker?._openTrade || bookTrade || null;
    }
    return bookTrade || ticker?._openTrade || null;
  }

  const api = {
    num,
    sameUnit,
    isOptionVehicle,
    isLetfVehicle,
    livePremium,
    entryPremium,
    optionQuote,
    letfQuote,
    optionProgressBar,
    pickOpenTrade,
  };

  if (typeof window !== "undefined") window.TimedVehicleQuote = api;
  if (typeof globalThis !== "undefined") globalThis.TimedVehicleQuote = api;
})();

// cache-bust:1788615708089:706333049
