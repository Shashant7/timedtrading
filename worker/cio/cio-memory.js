// worker/cio/cio-memory.js
// 7-layer CIO memory builder + helper functions for episodic context.

import { TICKER_PROXY_MAP } from "../sector-mapping.js";
import { getReferencePriors } from "./cio-reference.js";

function computeCryptoTrend(snapshots, idx) {
  if (idx < 10) return 0;
  const window = snapshots.slice(Math.max(0, idx - 14), idx);
  const btcSum = window.filter(s => s.btc_pct != null).reduce((a, s) => a + Number(s.btc_pct), 0);
  if (Math.abs(btcSum) < 3) return 0;
  return btcSum > 0 ? 1 : -1;
}

export function findSimilarEpisodes(snapshots, current) {
  if (!snapshots || snapshots.length === 0) return [];
  const currentIdx = snapshots.indexOf(current);
  const currentBtcTrend = computeCryptoTrend(snapshots, currentIdx);

  const matches = [];
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    if (s.date === current.date) continue;
    let score = 0;
    if (s.vix_state === current.vix_state) score++;
    if (s.oil_pct != null && current.oil_pct != null &&
        Math.sign(s.oil_pct) === Math.sign(current.oil_pct) &&
        Math.abs(s.oil_pct - current.oil_pct) < 1.5) score++;
    if (s.sector_rotation === current.sector_rotation) score++;
    if (s.regime_overall === current.regime_overall) score++;
    if (currentBtcTrend !== 0) {
      const sBtcTrend = computeCryptoTrend(snapshots, i);
      if (sBtcTrend !== 0 && Math.sign(sBtcTrend) === Math.sign(currentBtcTrend)) score++;
    }
    if (score >= 3) matches.push({ date: s.date, score, snap: s });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 5);
}

export function findRelevantEvents(events, currentDate, sym, proxyMap) {
  if (!events || events.length === 0) return { macro: [], earningsDirect: [], earningsProxy: [] };
  const currentMs = new Date(currentDate + "T16:00:00Z").getTime();
  const lookbackMs = 5 * 86400000;
  const cutoff = currentMs - lookbackMs;
  const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);

  const macro = [];
  const earningsDirect = [];
  const earningsProxy = [];

  const proxyTickers = new Set();
  const proxyEntry = proxyMap?.[sym];
  if (proxyEntry) {
    for (const p of (proxyEntry.peers || [])) proxyTickers.add(p);
    if (proxyEntry.etf) proxyTickers.add(proxyEntry.etf);
  }

  for (const e of events) {
    if (e.date < cutoffDate || e.date > currentDate) continue;
    if (e.event_type === "macro") {
      macro.push(e);
    } else if (e.event_type === "earnings") {
      if (e.ticker === sym) earningsDirect.push(e);
      else if (proxyTickers.has(e.ticker)) earningsProxy.push(e);
    }
  }
  return { macro: macro.slice(0, 5), earningsDirect: earningsDirect.slice(0, 3), earningsProxy: earningsProxy.slice(0, 5) };
}

/**
 * Build 7-layer CIO memory context.
 * @param {string} sym - Ticker symbol
 * @param {string} direction - "LONG" or "SHORT"
 * @param {object} tickerData - Full ticker data object
 * @param {Array} allTrades - All historical trades
 * @param {object} memoryCache - Cached memory data (pathPerf, tickerProfiles, franchise, cioDecisions, marketSnapshots, marketEvents)
 */
export function buildCIOMemory(sym, direction, tickerData, allTrades, memoryCache) {
  const mem = {};
  const closedTrades = (allTrades || []).filter(t => t.status === "WIN" || t.status === "LOSS" || t.status === "FLAT");

  // Layer 1: Ticker history
  const tickerTrades = closedTrades.filter(t => (t.ticker || "").toUpperCase() === sym);
  if (tickerTrades.length > 0) {
    const wins = tickerTrades.filter(t => t.status === "WIN").length;
    const pnls = tickerTrades.map(t => Number(t.pnlPct || t.pnl_pct) || 0);
    const avgPnl = pnls.reduce((s, v) => s + v, 0) / pnls.length;
    const exitReasons = {};
    for (const t of tickerTrades) {
      const r = t.exitReason || t.exit_reason || "unknown";
      exitReasons[r] = (exitReasons[r] || 0) + 1;
    }
    const topExits = Object.entries(exitReasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
    const last3 = tickerTrades.slice(-3).map(t => ({
      dir: t.direction, pnl_pct: (Number(t.pnlPct || t.pnl_pct) || 0).toFixed(1) + "%",
      exit: t.exitReason || t.exit_reason || "?"
    }));
    mem.ticker_history = {
      trades: tickerTrades.length, wins, wr: Math.round((wins / tickerTrades.length) * 100),
      avg_pnl_pct: +avgPnl.toFixed(2), top_exits: topExits, last_3: last3
    };
  }

  // Layer 2: Regime context
  const regimeClass = tickerData?.regime_class;
  if (regimeClass) {
    const regimeTrades = closedTrades.filter(t => t._regime === regimeClass || t.regime_class === regimeClass);
    if (regimeTrades.length >= 3) {
      const rWins = regimeTrades.filter(t => t.status === "WIN").length;
      const rDir = regimeTrades.filter(t => t.direction === direction);
      const rDirWins = rDir.filter(t => t.status === "WIN").length;
      mem.regime_context = {
        regime: regimeClass,
        wr_all: Math.round((rWins / regimeTrades.length) * 100),
        trades_all: regimeTrades.length,
        wr_dir: rDir.length >= 2 ? Math.round((rDirWins / rDir.length) * 100) : null,
        trades_dir: rDir.length,
        direction
      };
    }
  }

  // Layer 3: Entry path track record
  const pathKey = tickerData?.__entry_path;
  if (pathKey && memoryCache?.pathPerf) {
    const pp = memoryCache.pathPerf.get(pathKey) || memoryCache.pathPerf[pathKey];
    if (pp && Number(pp.total_trades) >= 3) {
      mem.path_performance = {
        path: pathKey,
        wr: Math.round(Number(pp.win_rate || 0) * 100),
        avg_pnl_pct: Number(pp.avg_pnl_pct) || 0,
        total_trades: pp.total_trades,
        enabled: pp.enabled !== 0
      };
    }
  }

  // Layer 3b: Reference-intel priors (feature-flagged memory cache payload)
  try {
    const sector = tickerData?.sector || tickerData?.sector_name || null;
    const refPriors = getReferencePriors(sym, direction, pathKey || "unknown", sector, memoryCache?.referenceFeatures);
    if (refPriors) {
      mem.reference_priors = refPriors;
    }
  } catch (_) {
    // Best-effort only: reference priors should never break CIO memory construction.
  }

  // Layer 4: Ticker personality + Franchise/Blacklist
  const profile = tickerData?._ticker_profile || memoryCache?.tickerProfiles?.[sym];
  if (profile) {
    mem.ticker_profile = {
      behavior: profile.behavior_type,
      trend_persistence: profile.trend_persistence,
      sl_mult: profile.recommended_sl_mult,
      tp_mult: profile.recommended_tp_mult
    };
  }
  const franchise = memoryCache?.franchise;
  if (franchise) {
    if (franchise.blacklist?.includes(sym)) {
      const tickerStats = mem.ticker_history;
      mem.franchise_status = `BLACKLISTED${tickerStats ? `: ${tickerStats.wr}% WR over ${tickerStats.trades} trades` : ""}`;
    } else if (franchise.whitelist?.includes(sym)) {
      mem.franchise_status = "FRANCHISE";
    }
  }

  // Layer 5: CIO self-accuracy
  const cioDecisions = memoryCache?.cioDecisions || [];
  if (cioDecisions.length >= 3) {
    const approved = cioDecisions.filter(d => d.decision === "APPROVE" || d.decision === "ADJUST");
    const approvedWithOutcome = approved.filter(d => d.trade_outcome);
    const approvedWins = approvedWithOutcome.filter(d => d.trade_outcome === "WIN").length;
    const rejections = cioDecisions.filter(d => d.decision === "REJECT");
    mem.cio_track_record = {
      total: cioDecisions.length,
      approved: approved.length,
      approved_wr: approvedWithOutcome.length >= 2
        ? Math.round((approvedWins / approvedWithOutcome.length) * 100) : null,
      rejections: rejections.length,
      last_3_rejects: rejections.slice(-3).map(d => ({
        ticker: d.ticker, reason: (d.reasoning || "").slice(0, 60),
        correct: d.trade_outcome === undefined ? null : d.trade_outcome !== "WIN"
      }))
    };
  }

  // Layer 6: Episodic market context
  const snapshots = memoryCache?.marketSnapshots || [];
  const todaySnap = snapshots.find(s => s.date === tickerData?._date) || snapshots[snapshots.length - 1];
  if (todaySnap) {
    const todayIdx = snapshots.indexOf(todaySnap);

    let cryptoLeadSignal = null;
    if (todayIdx >= 10) {
      const btc14 = snapshots.slice(Math.max(0, todayIdx - 14), todayIdx)
        .filter(s => s.btc_pct != null).reduce((acc, s) => acc + Number(s.btc_pct), 0);
      const btc28 = snapshots.slice(Math.max(0, todayIdx - 28), todayIdx)
        .filter(s => s.btc_pct != null).reduce((acc, s) => acc + Number(s.btc_pct), 0);
      const eth14 = snapshots.slice(Math.max(0, todayIdx - 14), todayIdx)
        .filter(s => s.eth_pct != null).reduce((acc, s) => acc + Number(s.eth_pct), 0);

      const parts = [];
      if (Math.abs(btc14) > 3) {
        const trend = btc14 > 0 ? "up" : "down";
        parts.push(`BTC trailing 2wk: ${btc14 >= 0 ? "+" : ""}${btc14.toFixed(1)}% (${trend})`);
      }
      if (Math.abs(btc28) > 5) {
        const trend = btc28 > 0 ? "up" : "down";
        parts.push(`BTC trailing 4wk: ${btc28 >= 0 ? "+" : ""}${btc28.toFixed(1)}% (${trend})`);
      }
      if (Math.abs(eth14) > 5) {
        const trend = eth14 > 0 ? "up" : "down";
        parts.push(`ETH trailing 2wk: ${eth14 >= 0 ? "+" : ""}${eth14.toFixed(1)}% (${trend})`);
      }
      if (parts.length > 0) {
        const btcBearish = btc14 < -5 || btc28 < -10;
        const btcBullish = btc14 > 5 || btc28 > 10;
        const signal = btcBearish ? "Crypto weakness (2-4wk lead) suggests equity downside ahead."
          : btcBullish ? "Crypto strength (2-4wk lead) suggests equity upside ahead." : null;
        cryptoLeadSignal = parts.join(". ") + (signal ? " " + signal : "");
      }
    }

    mem.market_backdrop = {
      today: `VIX ${todaySnap.vix_close || "?"} (${todaySnap.vix_state || "?"}), oil ${todaySnap.oil_pct >= 0 ? "+" : ""}${todaySnap.oil_pct || 0}%, ` +
             `${todaySnap.sector_rotation || "balanced"}. SPY ${todaySnap.spy_pct >= 0 ? "+" : ""}${todaySnap.spy_pct || 0}%.`,
    };
    if (cryptoLeadSignal) mem.market_backdrop.crypto_leading = cryptoLeadSignal;

    const episodes = findSimilarEpisodes(snapshots, todaySnap);
    if (episodes.length >= 2) {
      const epDates = episodes.map(e => e.date);
      const avgSpy = episodes.reduce((s, e) => s + (Number(e.snap.spy_pct) || 0), 0) / episodes.length;
      const epTrades = closedTrades.filter(t => {
        const tradeDate = t._date || (t.entry_ts ? new Date(Number(t.entry_ts)).toISOString().slice(0, 10) : null);
        return epDates.includes(tradeDate) && t.direction === direction;
      });
      const epWins = epTrades.filter(t => t.status === "WIN").length;
      mem.market_backdrop.similar_episodes = `${episodes.length} similar days. Avg SPY ${avgSpy >= 0 ? "+" : ""}${avgSpy.toFixed(1)}%.` +
        (epTrades.length >= 2 ? ` ${direction}s in those: ${Math.round((epWins / epTrades.length) * 100)}% WR (${epTrades.length} trades).` : "");

      const symInEp = epTrades.filter(t => (t.ticker || "").toUpperCase() === sym);
      if (symInEp.length > 0) {
        const symEpWins = symInEp.filter(t => t.status === "WIN").length;
        mem.market_backdrop.ticker_in_episodes = `${sym} in similar conditions: ${symEpWins}/${symInEp.length} wins.`;
      }
    }
  }

  // Layer 7: Event-driven context
  const events = memoryCache?.marketEvents || [];
  const currentDate = tickerData?._date || new Date().toISOString().slice(0, 10);
  const relevant = findRelevantEvents(events, currentDate, sym, TICKER_PROXY_MAP);

  if (relevant.macro.length > 0 || relevant.earningsDirect.length > 0 || relevant.earningsProxy.length > 0) {
    mem.events = {};

    if (relevant.macro.length > 0) {
      const top = relevant.macro[0];
      mem.events.macro_today = `${top.event_name}${top.actual ? ": " + top.actual : ""}` +
        (top.estimate ? ` vs ${top.estimate} est` : "") +
        (top.spy_reaction_pct != null ? `. SPY ${top.spy_reaction_pct >= 0 ? "+" : ""}${top.spy_reaction_pct.toFixed(1)}%` : "") + ".";

      const sameMacro = events.filter(e => e.event_type === "macro" &&
        e.event_name === top.event_name && e.date < currentDate).slice(-3);
      if (sameMacro.length >= 2) {
        const postDirTrades = closedTrades.filter(t => {
          const td = t._date || (t.entry_ts ? new Date(Number(t.entry_ts)).toISOString().slice(0, 10) : null);
          return td && sameMacro.some(m => {
            const diff = (new Date(td).getTime() - new Date(m.date).getTime()) / 86400000;
            return diff >= 0 && diff <= 2;
          }) && t.direction === direction;
        });
        if (postDirTrades.length >= 2) {
          const pdWins = postDirTrades.filter(t => t.status === "WIN").length;
          mem.events.post_event_pattern = `After ${top.event_name}: ${direction} WR ${Math.round((pdWins / postDirTrades.length) * 100)}% (${postDirTrades.length} trades).`;
        }
      }
    }

    if (relevant.earningsDirect.length > 0) {
      const e = relevant.earningsDirect[0];
      mem.events.earnings_direct = `${sym} reported${e.surprise_pct != null ? ` (${e.surprise_pct >= 0 ? "+" : ""}${e.surprise_pct.toFixed(1)}% surprise)` : ""}` +
        `: ${e.actual || "N/A"} vs ${e.estimate || "N/A"} est.`;
    }

    if (relevant.earningsProxy.length > 0) {
      const proxyNames = relevant.earningsProxy.map(e => e.ticker).filter(Boolean);
      const top = relevant.earningsProxy[0];
      mem.events.earnings_proxy = `Proxy ${proxyNames.join(", ")} reported recently.` +
        (top.surprise_pct != null ? ` ${top.ticker}: ${top.surprise_pct >= 0 ? "+" : ""}${top.surprise_pct.toFixed(1)}% surprise.` : "");

      const proxyTrades = closedTrades.filter(t => {
        const td = t._date || (t.entry_ts ? new Date(Number(t.entry_ts)).toISOString().slice(0, 10) : null);
        return td && (t.ticker || "").toUpperCase() === sym && t.direction === direction &&
          relevant.earningsProxy.some(ep => {
            const diff = (new Date(td).getTime() - new Date(ep.date).getTime()) / 86400000;
            return diff >= 0 && diff <= 5;
          });
      });
      if (proxyTrades.length >= 2) {
        const ptWins = proxyTrades.filter(t => t.status === "WIN").length;
        mem.events.proxy_trade_history = `${direction} on ${sym} within 5d of proxy earnings: ${ptWins}/${proxyTrades.length} wins.`;
      }
    }
  }

  return mem;
}
