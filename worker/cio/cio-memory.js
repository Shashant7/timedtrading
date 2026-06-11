// worker/cio/cio-memory.js
// 7-layer CIO memory builder + helper functions for episodic context.

import { TICKER_PROXY_MAP, getThemesForTicker, THEMES } from "../sector-mapping.js";
import { getReferencePriors } from "./cio-reference.js";
import { resolveRegimeVocabulary } from "../regime-vocabulary.js";
import { getStrategyForTicker, getTacticalSignals, STRATEGY_VINTAGE, STRATEGY_TITLE } from "../strategy-context.js";
import { scoreRootConfluence } from "../root-strategy.js";

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
  const regimeVocabulary = resolveRegimeVocabulary(tickerData, {
    executionFallback: tickerData?.regime_class || "UNKNOWN",
  });
  const regimeClass = regimeVocabulary.executionRegimeClass;
  if (regimeClass) {
    const regimeTrades = closedTrades.filter(t => t._regime === regimeClass || t.regime_class === regimeClass);
    if (regimeTrades.length >= 3) {
      const rWins = regimeTrades.filter(t => t.status === "WIN").length;
      const rDir = regimeTrades.filter(t => t.direction === direction);
      const rDirWins = rDir.filter(t => t.status === "WIN").length;
      mem.regime_context = {
        regime: regimeClass,
        execution_regime_class: regimeVocabulary.executionRegimeClass,
        swing_regime_snapshot: regimeVocabulary.swingRegimeSnapshot,
        market_volatility_regime: regimeVocabulary.marketVolatilityRegime,
        market_backdrop_class: regimeVocabulary.marketBackdropClass,
        market_trend_bias: regimeVocabulary.marketTrendBias,
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

  // ── Layer 8: Markov regime forecast summary (2026-05-28) ─────────────────
  // The regime_forecast bundle (PRs #308-#311) gives forward-looking
  // probabilities over the universe state space. Memory-side compact summary
  // — the full forecast is also surfaced in the entry/lifecycle proposal so
  // CIO has both the immediate probability snapshot and the longer-horizon
  // continuation view.
  const forecast = tickerData?.regime_forecast;
  if (forecast && typeof forecast === "object") {
    const dirFriendly = (probMap) => {
      if (!probMap) return null;
      const dir = String(direction || "").toUpperCase();
      const keys = dir === "LONG"
        ? ["HTF_BULL_LTF_BULL", "HTF_BULL_LTF_PULLBACK"]
        : dir === "SHORT"
          ? ["HTF_BEAR_LTF_BEAR", "HTF_BEAR_LTF_PULLBACK"]
          : [];
      let s = 0;
      for (const k of keys) {
        const v = Number(probMap[k]);
        if (Number.isFinite(v)) s += v;
      }
      return Math.round(s * 1000) / 1000;
    };
    const summary = {
      current_state: forecast.state || null,
      matrix_source: forecast.matrix_source || null,
      p_5_bar_in_direction: dirFriendly(forecast.p_5_bar),
      p_1h_in_direction: dirFriendly(forecast.p_1h),
      p_1d_in_direction: dirFriendly(forecast.p_1d),
    };
    if (forecast.expanded?.band) summary.completion_band = forecast.expanded.band;
    mem.markov_regime = summary;
  }

  // ── Layer 8b: Move archetype + adaptive lineage (2026-05-28) ─────────────
  // Canonical move policy (Phase 4 / Phase 5) writes a per-ticker archetype
  // recommendation onto tickerData.__learning_policy.recommend. CIO can use
  // the archetype to decide: fast_impulse_fragile = quick-trim bias,
  // slow_grinder = wider stops, etc.
  const lp = tickerData?.__learning_policy?.recommend;
  if (lp && typeof lp === "object") {
    mem.move_archetype = {
      archetype: lp.archetype || null,
      sl_tp_style: lp.sl_tp_style || null,
      trim_run_bias: lp.trim_run_bias || null,
      exit_style: lp.exit_style || null,
      entry_timing: lp.entry_timing || null,
    };
  }

  // ── Layer 8c: Move-phase exhaustion (2026-05-28) ─────────────────────────
  // Late-phase entries are statistically more fragile. Surface phase_pct,
  // completion_pct, and the run-length + exhaustion of the current regime.
  if (tickerData?.regime_exhausted === true || Number(tickerData?._regime_run_length) > 0) {
    mem.regime_run = {
      run_bars: Number(tickerData._regime_run_length) || null,
      exhausted: tickerData.regime_exhausted === true,
      phase_pct: Number.isFinite(Number(tickerData.phase_pct)) ? Math.round(Number(tickerData.phase_pct) * 10) / 10 : null,
      completion_pct: Number.isFinite(Number(tickerData.completion)) ? Math.round(Number(tickerData.completion) * 10) / 10 : null,
    };
  }

  // ── Layer 10: Theme rotation (2026-05-28 — Phase 3) ──────────────────────
  // Surface theme(s) the ticker is in + how many peers are moving today in
  // the same direction. Lets CIO weight "this LONG is in ai_infra_memory
  // and 5/6 memory peers are up >2% today" as confirmation.
  try {
    const themes = getThemesForTicker(sym);
    const livePrices = memoryCache?.livePrices;
    if (themes.length > 0 && livePrices) {
      const themeRows = [];
      const map = livePrices.prices && typeof livePrices.prices === "object" ? livePrices.prices : livePrices;
      for (const theme of themes) {
        const members = THEMES[theme] || [];
        let up = 0, down = 0, hasData = 0;
        const upDetail = [], downDetail = [];
        for (const m of members) {
          if (m === sym) continue;
          const row = map[m];
          if (!row) continue;
          const dp = Number(row.dp ?? row.day_change_pct ?? row.change_pct);
          if (!Number.isFinite(dp)) continue;
          hasData++;
          if (dp >= 2.0) { up++; upDetail.push({ t: m, dp: +dp.toFixed(1) }); }
          else if (dp <= -2.0) { down++; downDetail.push({ t: m, dp: +dp.toFixed(1) }); }
        }
        if (hasData === 0) continue;
        upDetail.sort((a, b) => b.dp - a.dp);
        downDetail.sort((a, b) => a.dp - b.dp);
        const themeActive = (up >= members.length * 0.30) ? "up"
                          : (down >= members.length * 0.30) ? "down" : null;
        themeRows.push({
          theme, members: members.length, has_data: hasData,
          up, down,
          top_up_peers: upDetail.slice(0, 3),
          top_down_peers: downDetail.slice(0, 3),
          active_direction: themeActive,
        });
      }
      if (themeRows.length > 0) {
        mem.theme_rotation = themeRows;
      }
    }
  } catch (_) { /* best-effort */ }

  // ── Layer 12: Insider transactions (2026-05-28 — Phase 4a) ──────────────
  // Pre-loaded into memoryCache.insiderSummaries by the live scoring cron.
  try {
    const ins = memoryCache?.insiderSummaries?.[sym];
    if (ins) {
      mem.insider_activity = {
        high_signal_buys_count: ins.hi_buys_count || 0,
        high_signal_buys_value_usd: ins.hi_buys_value || 0,
        total_buys_count: ins.buys_count || 0,
        total_buys_value_usd: ins.buys_value || 0,
        total_sells_count: ins.sells_count || 0,
        total_sells_value_usd: ins.sells_value || 0,
        net_insider_value_usd: ins.net_value || 0,
      };
    }
  } catch (_) {}

  // ── Layer 13: Macro tilt (2026-05-28 — Phase 5) ─────────────────────────
  // Pre-loaded into memoryCache.macroSnapshot by the live scoring cron.
  try {
    const macro = memoryCache?.macroSnapshot;
    if (macro) {
      mem.macro_tilt = {
        narrative: macro.macro_narrative || null,
        country_top_outperformers: (macro.country_rotation?.top_outperformers || []).slice(0, 3),
        country_top_underperformers: (macro.country_rotation?.top_underperformers || []).slice(0, 3),
        cross_asset_regime: macro.cross_asset_regime ? {
          dollar_20d: macro.cross_asset_regime.dollar_20d,
          gold_20d: macro.cross_asset_regime.gold_20d,
          oil_20d: macro.cross_asset_regime.oil_20d,
          rates_20d: macro.cross_asset_regime.rates_20d,
          credit_20d: macro.cross_asset_regime.credit_20d,
        } : null,
      };
    }
  } catch (_) {}

  // ── Layer 14: News sentiment + catalysts (2026-05-28 — Phase 2) ─────────
  // Pre-loaded into memoryCache.newsSummaries by the live scoring cron.
  try {
    const news = memoryCache?.newsSummaries?.[sym];
    if (news && news.has_data !== false) {
      mem.news_sentiment = {
        count_5d: news.count,
        dominant: news.dominant_sentiment,
        bullish_catalyst_count: news.bullish_catalyst_count,
        bearish_catalyst_count: news.bearish_catalyst_count,
        top_catalyst: news.top_catalyst ? {
          headline: (news.top_catalyst.headline || "").slice(0, 200),
          source: news.top_catalyst.source,
          datetime: news.top_catalyst.datetime,
          sentiment: news.top_catalyst.sentiment,
          catalyst_strength: news.top_catalyst.catalyst_strength,
        } : null,
        latest_3_headlines: (news.latest_3 || []).map((h) => ({
          headline: (h.headline || "").slice(0, 160),
          sentiment: h.sentiment,
          catalyst_strength: h.catalyst_strength,
        })),
      };
    }
  } catch (_) {}

  // ── Layer 9: Discovery context (2026-05-28) ──────────────────────────────
  // Surface what the daily TradingView screener saw, plus the universe
  // coverage-gap diagnostic for this specific ticker. Tells CIO things like:
  //   - "Same ticker appeared in screener top_gainers 4× in last 7 days"
  //     (sustained-momentum signal)
  //   - "This ticker missed 5/12 valid moves in last 14d; dominant reason
  //     was cohort_fail" (known-weak detection — bias toward APPROVE since
  //     the cohort gate may have been over-tight on legitimate setups)
  //   - "Universe capture rate is 62% over last 14d" (broader system health
  //     context)
  // Both data sources are pre-loaded into memoryCache by the live scoring
  // path + replay path; gracefully absent if not provided.
  try {
    const discovery = {};
    // Screener candidate appearances for this symbol.
    const screenerCands = memoryCache?.screenerCandidates;
    if (Array.isArray(screenerCands)) {
      const mine = screenerCands.filter((c) =>
        String(c?.ticker || "").toUpperCase() === sym,
      );
      if (mine.length > 0) {
        const scanTypes = {};
        for (const c of mine) {
          const st = c.scan_type || "unknown";
          scanTypes[st] = (scanTypes[st] || 0) + 1;
        }
        const latest = mine.reduce((acc, c) => (
          (!acc || (c.discovered_at || "") > (acc.discovered_at || "")) ? c : acc
        ), null);
        discovery.screener_appearances = {
          count_last_7d: mine.length,
          scan_types: scanTypes,
          latest_seen: latest?.discovered_at?.slice(0, 10) || null,
          latest_change_pct: Number.isFinite(Number(latest?.change_pct)) ? +Number(latest.change_pct).toFixed(1) : null,
        };
      }
    }
    // Universe coverage-gap summary for this symbol.
    const gapsSummary = memoryCache?.coverageGapsSummary;
    if (gapsSummary && typeof gapsSummary === "object") {
      const mine = gapsSummary?.by_ticker?.[sym];
      if (mine && (mine.big_moves || 0) > 0) {
        discovery.coverage_gap_history = {
          big_moves: mine.big_moves,
          captured: mine.captured,
          gaps: mine.gaps,
          capture_rate_pct: mine.capture_rate_pct,
          dominant_miss_reason: mine.dominant_miss_reason,
          last_gap_day: mine.last_gap_day,
          window_lookback_days: gapsSummary?.window?.lookback_days || null,
        };
      }
      if (Number.isFinite(Number(gapsSummary.universe_capture_rate_pct))) {
        discovery.universe_capture_rate_pct = gapsSummary.universe_capture_rate_pct;
      }
    }
    // 2026-06-10 — Discovery Gameplan (worker/discovery/gameplan.js).
    // The nightly synthesis of WHAT the engine missed and WHY. Gives
    // the CIO system-level context for entry decisions:
    //   - binding_constraint = GENERIC_GATE_VETO → upstream gates are
    //     already rejecting too many valid setups; a borderline entry
    //     that reached the CIO survived an over-tight funnel — lean
    //     APPROVE on otherwise-sound proposals.
    //   - binding_constraint = NO_PLAY_FOR_MOVE → the arsenal itself
    //     has gaps; the proposals the CIO sees are NOT over-filtered.
    //   - one_play_offense → flow is concentrated in one entry path;
    //     value diversification of setups when quality is equal.
    const gameplan = memoryCache?.discoveryGameplan;
    if (gameplan && typeof gameplan === "object") {
      discovery.gameplan = {
        generated: gameplan.generated || null,
        narrative: (gameplan.narrative || "").slice(0, 700),
        binding_constraint: gameplan.binding_constraint || null,
        binding_constraint_pct: gameplan.binding_constraint_pct ?? null,
        capture_rate: gameplan.capture?.capture_rate ?? null,
        one_play_offense: gameplan.playbook_usage?.one_play_offense || false,
        plays_idle: (gameplan.playbook_usage?.plays_idle || []).slice(0, 6),
        top_miss_archetype: gameplan.miss_archetypes?.[0]?.archetype || null,
      };
    }
    if (Object.keys(discovery).length > 0) {
      mem.discovery_context = discovery;
    }
  } catch (_) {
    // Best-effort — discovery enrichment must never break CIO.
  }

  // ── Layer 16: Root Strategy Confluence (2026-05-30) ──────────────────────
  // Synthesized 8-layer verdict from worker/root-strategy.js — the same
  // engine that drives the Options ladder. Now feeds CIO so its
  // ENTRY/LIFECYCLE decisions inherit the fused POV (Lee + Newton +
  // Markov + Huddleston + Carter + DeMark + Ripster + Saty + SMT + VP).
  //
  // CIO can now reason:
  //   "Root verdict is RIDE LONG (75/100), ST fresh, 6/8 layers agree —
  //    APPROVE entry with full size."
  // or:
  //   "Root verdict is WAIT (only 2/8 layers), DRIFT mode at best —
  //    REJECT or downsize."
  try {
    const rootVerdict = scoreRootConfluence(tickerData);
    if (rootVerdict && rootVerdict.ok) {
      mem.root_confluence = {
        mode: rootVerdict.mode,
        side: rootVerdict.side,
        score: rootVerdict.score,
        layers_agreeing: rootVerdict.layers_agreeing,
        layers_total: rootVerdict.layers_total,
        long_strength: rootVerdict.long_strength,
        short_strength: rootVerdict.short_strength,
        supertrend_trigger: rootVerdict.supertrend_trigger?.side
          ? {
              side: rootVerdict.supertrend_trigger.side,
              freshness: rootVerdict.supertrend_trigger.freshness,
              confirmed_tfs: (rootVerdict.supertrend_trigger.confirmed_tfs || []).slice(0, 4),
            }
          : null,
        // Top 3 strongest agreeing layers — surfaces "why" without
        // overwhelming the CIO prompt.
        top_layers: (rootVerdict.layers || [])
          .filter((l) => l.side === rootVerdict.side && l.strength > 0.3)
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 3)
          .map((l) => ({ key: l.key, evidence: l.evidence })),
        actionable_summary: rootVerdict.actionable_summary,
      };
    }
  } catch (_) { /* best-effort */ }

  // ── Layer 15: Strategic stance (2026-05-29 — FSD playbook) ──────────────
  // Surfaces the active editorial playbook (currently Fundstrat 2026 Year
  // Ahead) so CIO can:
  //   - Bias APPROVE on tier-1 theme entries when the playbook is bullish
  //   - Demand stronger justification for off-thesis trades
  //   - Cite the source ("on-thesis: AI compute + MAG7 cohort") in reasoning
  // See worker/strategy-context.js for the schema + how to rev the vintage.
  //
  // 2026-06-01 — Always include strategy_stance (even when stance is
  // "neutral" with no theme matches) so the LLM can never assume "no
  // entry = no playbook signal". Previous behavior omitted the entire
  // block for neutral names — making the LLM blind to the global
  // playbook backdrop for ~60% of the universe. Now every ticker
  // carries playbook context; "neutral" is itself a signal.
  try {
    const strategy = getStrategyForTicker(sym, tickerData, getThemesForTicker);
    if (strategy) {
      mem.strategy_stance = {
        playbook: STRATEGY_TITLE,
        vintage: STRATEGY_VINTAGE,
        stance: strategy.stance || "neutral",
        multiplier: strategy.multiplier || 1.0,
        tier: strategy.tier || null,
        reason: strategy.reason || "no_theme_match_no_sector_tilt",
        sector: strategy.sector || null,
        sector_stance: strategy.sector_stance || "neutral",
        themes_matched: (strategy.themes_matched || []).slice(0, 4),
        smid_bump: !!strategy.smid_applies,
        // Explicit alignment flag so the LLM can branch quickly
        // without inspecting themes/sector/multiplier.
        on_thesis: !!strategy.aligned || ((strategy.themes_matched || []).length > 0),
      };

      // ── Layer 15b: Tactical signals matching this ticker (2026-06-02) ──
      // Surfaces the per-publication rotation overlay for any TIER-1 theme
      // the ticker is part of, plus any sector-overweight signal that
      // applies to its sector. This is the "what changed since the last
      // structural playbook revision" view — keeps the CIO from leaning
      // structurally on a theme that the upstream Daily Technical
      // Strategy just flagged as tactically over- or under-extended.
      try {
        // 2026-06-04 — Prefer the LIVE CRO tactical override (FSD-derived,
        // applied via cro:tactical_overrides and preloaded into
        // memoryCache.tacticalOverride) over the in-code TACTICAL_SIGNALS.
        // Without this, an approved FSD FlashInsight reached the Daily Brief
        // (getTacticalSignalsAsync) but the CIO's per-trade reasoning still
        // saw only the stale in-code list. Falls back to in-code when no
        // override is live or the preload is missing.
        const override = memoryCache?.tacticalOverride || null;
        const liveSignals = Array.isArray(override?.tactical_signals) && override.tactical_signals.length > 0
          ? override.tactical_signals
          : null;
        const base = getTacticalSignals();
        const tactical = liveSignals
          ? {
              vintage: override.tactical_vintage || base.vintage,
              source: override.source || base.source,
              title: override.tactical_title || base.title,
              signals: liveSignals,
              live_override: true,
            }
          : { ...base, live_override: false };
        const tickerThemes = strategy.themes_matched.map(m => m.theme);
        const tickerSector = strategy.sector;
        const matched = [];
        for (const sig of (tactical.signals || [])) {
          const themeHit = (sig.affected_tier1_themes || []).some(t => tickerThemes.includes(t));
          const sectorHit = tickerSector
            && (sig.affected_sectors_overweight || []).includes(tickerSector);
          if (themeHit || sectorHit) {
            matched.push({
              signal: sig.signal,
              pair: sig.pair,
              direction: sig.direction,
              horizon: sig.horizon,
              evidence: sig.evidence,
              action: sig.playbook_action,
              matched_via: themeHit ? "theme" : "sector",
            });
          }
        }
        if (matched.length > 0) {
          mem.tactical_signals = {
            vintage: tactical.vintage,
            source: tactical.source,
            title: tactical.title,
            live_override: tactical.live_override,
            matches: matched.slice(0, 5),
            note: tactical.live_override
              ? "LIVE FSD-derived tactical overlay (CRO-applied) — refines WHEN to lean into a theme, never overrides the structural stance."
              : "Tactical overlay — refines WHEN to lean into a theme, never overrides the structural stance.",
          };
          // B3 (2026-06-11) — MEASURED FSD accuracy from the Signal Outcome
          // Ledger (nightly resolutions of applied tactical calls). Weigh
          // FSD-aligned conviction by what FSD has actually been hitting,
          // not by reputation. Absent until enough calls resolve.
          try {
            const acc = memoryCache?.fsdAccuracy;
            if (acc && Number(acc.total_resolved) > 0) {
              const g = (acc.groups || []).find((x) => x.source === "fsd_tactical") || acc.groups?.[0] || null;
              if (g) {
                mem.tactical_signals.measured_accuracy = {
                  window_days: acc.days || 180,
                  resolved: g.resolved ?? acc.total_resolved,
                  win_rate_pct: g.win_rate ?? null,
                  avg_move_pct: g.avg_pct ?? null,
                  note: "Hit rate of FSD tactical calls graded against candles at horizon. Low sample = treat as anecdote.",
                };
              }
            }
          } catch (_) { /* accuracy attach is best-effort */ }
        }
      } catch (_) {
        // Tactical enrichment is best-effort — never break CIO memory.
      }
    }
  } catch (_) {
    // Strategy enrichment is best-effort — never break CIO memory.
  }

  // ── Layer 15c: CRO research note (2026-06-03) ─────────────────────────────
  // The Chief Research Officer agent produces a daily synthesis note
  // (worker/cro/cro-service.js) that composes FSD intel + cross-asset
  // macro + rotation engine + correlation/breadth + discovery layer into
  // a single verdict + observations payload. The note is preloaded into
  // memoryCache.croNote by the scoring cron so this layer stays
  // synchronous (sync buildCIOMemory has many callers).
  //
  // Surfaces ONLY the per-ticker-relevant slice (verdict + 3 most
  // relevant observations + any drift flag that references this ticker's
  // sector or themes). Keeps the prompt budget tight: ~400 chars typical.
  //
  // Empty / missing → block omitted (LLM gets one less prior, never wrong
  // information). Falls back gracefully when no note has been produced
  // yet (e.g. first deploy / CRO synthesis cron hasn't fired).
  try {
    const note = memoryCache?.croNote;
    if (note && note.verdict) {
      const tickerSector = mem.strategy_stance?.sector || null;
      const tickerThemes = (mem.strategy_stance?.themes_matched || []).map((m) => m.theme);
      // Pick observations that name our sector / themes, otherwise the
      // first three. The verdict is always included.
      const relevant = [];
      for (const o of (note.observations || [])) {
        if (!o?.text) continue;
        const text = String(o.text);
        const hitsSector = tickerSector && text.toLowerCase().includes(tickerSector.toLowerCase());
        const hitsTheme = tickerThemes.some((t) => text.toLowerCase().includes(String(t).toLowerCase()));
        if (hitsSector || hitsTheme) relevant.unshift(o);
        else relevant.push(o);
      }
      const drifts = (note.notable_drifts || []).filter((d) => {
        const s = JSON.stringify(d).toLowerCase();
        return (tickerSector && s.includes(tickerSector.toLowerCase()))
          || tickerThemes.some((t) => s.includes(String(t).toLowerCase()));
      });
      mem.cro_research_note = {
        as_of_date: note.as_of_date,
        verdict: String(note.verdict).slice(0, 600),
        relevant_observations: relevant.slice(0, 3).map((o) => ({
          section: o.section, text: String(o.text).slice(0, 200), source: o.source,
        })),
        drifts: drifts.slice(0, 2).map((d) => ({
          claim: String(d.claim).slice(0, 200),
          drift_from: String(d.drift_from || "").slice(0, 200),
        })),
        note: "Research desk view. Informs CONTEXT, not the trade decision; the engine + structural playbook still own the call.",
      };
    }
  } catch (_) {
    // CRO note enrichment is best-effort — never break CIO memory.
  }

  // ── Layer 15e: Per-ticker FSD research-desk intel (2026-06-06) ───────────
  // Surfaces recent Fundstrat Direct publications that mention this ticker
  // (cashtag-tagged during CRO ingestion). Preloaded into
  // memoryCache.fsdIntelByTicker by cio-memory-loader.js for Investor CIO
  // and lifecycle calls that run outside the scoring cron.
  try {
    const intel = memoryCache?.fsdIntelByTicker?.[String(sym).toUpperCase()];
    if (intel && Number(intel.count) > 0 && Array.isArray(intel.publications)) {
      mem.fsd_research_desk = {
        lookback_days: intel.lookback_days || 14,
        count: intel.count,
        publications: intel.publications.slice(0, 3).map((p) => ({
          pub_id: p.pub_id,
          title: String(p.title || p.headline || "").slice(0, 160),
          category: p.category || p.post_type || null,
          published_at: p.published_at || null,
          summary: String(p.tt_summary || p.summary || "").slice(0, 280),
          playbook_action: p.playbook_action || null,
        })),
        note: "Per-ticker FSD research-desk ingest. CONTEXT for Investor accumulate/trim timing — not a hard override.",
      };
    }
  } catch (_) {
    // FSD intel enrichment is best-effort — never break CIO memory.
  }

  // ── Layer 15b-overlay: live desk tactical overlay headline (2026-06-04) ──
  // Even when no per-ticker tactical signal matches, surface the one-line
  // FSD-derived overlay that is currently live so the CIO always knows the
  // desk's tactical posture for the day. Tiny (~150 chars); omitted when no
  // override is applied. Best-effort.
  try {
    const override = memoryCache?.tacticalOverride || null;
    if (override && (override.tactical_overlay || override.tactical_title)) {
      mem.cro_tactical_overlay = {
        overlay: String(override.tactical_overlay || override.tactical_title).slice(0, 280),
        vintage: override.tactical_vintage || null,
        signals_live: Array.isArray(override.tactical_signals) ? override.tactical_signals.length : 0,
        source: "FSD-derived, CRO-applied",
        note: "Current desk tactical posture. CONTEXT for timing; the structural playbook + engine still own the call.",
      };
    }
    // 2026-06-05 — EDITORIAL sector/theme insights too. A publication like
    // "Healthcare shows strength; watch for bullish seasonality" produces a
    // sector_playbook_update (not always a tactical_signal). Surface the
    // override's sector_notes / theme_notes / risks that match THIS ticker's
    // sector + themes so the CIO applies editorial reads, not just signals.
    if (override) {
      const tSector = mem.strategy_stance?.sector || null;
      const tThemes = (mem.strategy_stance?.themes_matched || []).map((m) => (typeof m === "string" ? m : m.theme));
      const notes = [];
      for (const n of (Array.isArray(override.sector_notes) ? override.sector_notes : [])) {
        if (n?.sector && tSector && String(n.sector).toLowerCase() === String(tSector).toLowerCase() && n.tactical_note) {
          notes.push({ scope: `sector:${n.sector}`, note: String(n.tactical_note).slice(0, 200) });
        }
      }
      for (const n of (Array.isArray(override.theme_notes) ? override.theme_notes : [])) {
        if (n?.theme && tThemes.includes(n.theme) && n.tactical_note) {
          notes.push({ scope: `theme:${n.theme}`, note: String(n.tactical_note).slice(0, 200) });
        }
      }
      const risks = (Array.isArray(override.active_risks_add) ? override.active_risks_add : [])
        .filter((r) => {
          const s = JSON.stringify(r || {}).toLowerCase();
          return (tSector && s.includes(String(tSector).toLowerCase())) || tThemes.some((t) => s.includes(String(t).toLowerCase()));
        })
        .slice(0, 2)
        .map((r) => ({ name: r.name, severity: r.severity, note: String(r.note || "").slice(0, 160) }));
      if (notes.length > 0 || risks.length > 0) {
        mem.cro_editorial_reads = {
          notes: notes.slice(0, 3),
          risks,
          note: "FSD editorial reads for this ticker's sector/theme. Bias commentary + conviction; not a hard trade trigger.",
        };
      }
    }
  } catch (_) {
    // Overlay headline is best-effort — never break CIO memory.
  }

  // ── Layer 15d: CTO probabilistic levels (2026-06-03) ─────────────────────
  // The Chief Technical Officer agent emits per-ticker probability-bearing
  // levels (Fibonacci retracements/extensions, ATR ladder, daily pivots)
  // each weighted by EMPIRICAL HIT RATE from the ticker's own daily-candle
  // history AND biased by Markov regime forecast. This is the data-science
  // substrate the LLM uses when it needs to answer "what's the realistic
  // upside target here?" without leaning on memorized industry rules of
  // thumb.
  //
  // memoryCache.ctoLevels carries the universe-wide rollup; per-ticker
  // detail lives in KV (timed:cto:ticker:SYM) and is fetched lazily via
  // the admin endpoint. Here we surface ONLY this ticker's top upside +
  // downside picks if present — keeps the prompt budget at ~200 chars.
  try {
    const rollup = memoryCache?.ctoLevels;
    if (rollup && Array.isArray(rollup.results)) {
      const tickerRow = rollup.results.find((r) => r?.ticker === String(sym).toUpperCase());
      if (tickerRow && tickerRow.ok && (tickerRow.top_upside?.length || tickerRow.top_downside?.length)) {
        mem.cto_levels = {
          as_of: new Date(rollup.computed_at || 0).toISOString().slice(0, 10),
          narrative: tickerRow.narrative || null,
          top_upside: (tickerRow.top_upside || []).slice(0, 1).map((l) => ({
            label: l.label, price: l.price, distance_pct: l.distance_pct,
            adj_prob: l.regime_adjusted_prob, raw_hit_rate: l.raw_hit_rate,
            samples: l.samples, confidence: l.confidence,
            golden_gate: !!l.golden_gate,
          })),
          top_downside: (tickerRow.top_downside || []).slice(0, 1).map((l) => ({
            label: l.label, price: l.price, distance_pct: l.distance_pct,
            adj_prob: l.regime_adjusted_prob, raw_hit_rate: l.raw_hit_rate,
            samples: l.samples, confidence: l.confidence,
            golden_gate: !!l.golden_gate,
          })),
          note: "Data-science targets — empirical hit-rate × Markov bias. Use for sizing TPs and gauging risk:reward — never replaces the engine's setup-derived targets.",
        };
      }
    }
  } catch (_) {
    // CTO enrichment is best-effort — never break CIO memory.
  }

  /* ── Layer 16: Engine pulse (2026-06-01) ────────────────────────────
     Surfaces the same duration-bias-aware view the Loop 2 breaker uses:
     closed-trade WR + profit factor + expectancy AND the open book's
     unrealized MTM. Without this, the CIO sees `path_performance` /
     `ticker_history` (which look at closed trades only) and inherits
     the same closed-WR-low-because-winners-are-still-open bias the
     breaker has. With this layer, the LLM can reason on combined
     equity directly and avoid "the engine is bleeding" conclusions
     when the open book is up.

     `engine_pulse` is preloaded into memoryCache by the live scoring
     cron (worker/index.js). Empty/missing → block is omitted (the LLM
     gets one less prior, but never wrong information). */
  try {
    const pulse = memoryCache?.enginePulse;
    if (pulse && (pulse.last10_n > 0 || pulse.open_count > 0)) {
      const todayClosed = Number(pulse.today_pnl_pct) || 0;
      const openTodayDelta = Number(pulse.open_today_delta_pct) || 0;
      const combinedToday = todayClosed + openTodayDelta;
      const pf = pulse.profit_factor;
      const pfStr = pf == null ? null
        : (pf === Infinity ? "∞ (no losers in window)" : Number(pf).toFixed(2));
      mem.engine_pulse = {
        // Closed-trade headlines — biased downward when winners are
        // still in the open book; treat as one input, not the verdict.
        closed_wr_pct: pulse.last10_wr != null ? Math.round(pulse.last10_wr * 100) : null,
        closed_window_n: pulse.last10_n || 0,
        today_realized_pct: Number(todayClosed.toFixed(2)),
        consec_losses: pulse.consec_losses || 0,
        // Duration-bias-invariant metrics — preferred for "is the
        // engine actually working?" reasoning.
        profit_factor: pfStr,
        expectancy_pct: pulse.expectancy_pct != null ? Number(pulse.expectancy_pct).toFixed(3) : null,
        // Open-book MTM — the part hidden from closed-only stats.
        open_count: pulse.open_count || 0,
        open_unrealized_pct: pulse.open_count > 0 ? Number(pulse.open_unrealized_pct).toFixed(2) : null,
        open_winners: pulse.open_winners_count || 0,
        open_losers: pulse.open_losers_count || 0,
        // The combined view operators care about.
        combined_today_pct: Number(combinedToday.toFixed(2)),
        // Breaker state so the LLM can see when entries are paused +
        // whether the pause was overridden by the duration-bias check.
        breaker_active: !!(pulse.trip || pulse.paused),
        duration_bias_override: !!pulse.duration_bias_override,
        // Operator hint — the LLM should weight PF + combined_today
        // higher than WR for any "should we keep entering?" reasoning.
        bias_note: "closed_wr is duration-biased downward; profit_factor + combined_today are the unbiased view",
      };
    }
  } catch (_) {
    // Engine pulse enrichment is best-effort — never break CIO memory.
  }

  return mem;
}
