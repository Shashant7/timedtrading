/**
 * Universal Right Rail Ticker Details — shared by Dashboard and Trade Tracker.
 * Usage: const TickerDetailRightRail = window.TickerDetailRightRailFactory(deps);
 * deps must include: React, API_BASE, fmtUsd, fmtUsdAbs, getDailyChange, isPrimeBubble,
 * entryType, getActionDescription, rankScoreForTicker, getRankedTickers, getRankPosition,
 * getRankPositionFromMap, detectPatterns, normalizeTrailPoints, phaseToColor, completionForSize,
 * computeHorizonBucket, computeEtaDays, computeReturnPct, computeRiskPct, computeTpTargetPrice,
 * computeTpMaxPrice, summarizeEntryDecision, getDirectionFromState, getDirection, numFromAny,
 * groupsForTicker, GROUP_ORDER, GROUP_LABELS, TRADE_SIZE, FUTURES_SPECS, getStaleInfo,
 * isNyRegularMarketOpen, downsampleByInterval.
 */
(function () {
  window.TickerDetailRightRailFactory = function (deps) {
    const React = deps.React;
    const { useState, useEffect, useMemo, useRef } = React;
    const API_BASE = deps.API_BASE;
    const fmtUsd = deps.fmtUsd;
    const fmtUsdAbs = deps.fmtUsdAbs;
    const getDailyChange = deps.getDailyChange;
    const isPrimeBubble = deps.isPrimeBubble;
    const entryType = deps.entryType;
    const getActionDescription = deps.getActionDescription;
    const rankScoreForTicker = deps.rankScoreForTicker;
    const getRankedTickers = deps.getRankedTickers;
    const getRankPosition = deps.getRankPosition;
    const getRankPositionFromMap = deps.getRankPositionFromMap;
    const detectPatterns = deps.detectPatterns;
    const normalizeTrailPoints = deps.normalizeTrailPoints;
    const phaseToColor = deps.phaseToColor;
    const completionForSize = deps.completionForSize;
    const computeHorizonBucket = deps.computeHorizonBucket;
    const computeEtaDays = deps.computeEtaDays;
    const computeReturnPct = deps.computeReturnPct;
    const computeRiskPct = deps.computeRiskPct;
    const computeTpTargetPrice = deps.computeTpTargetPrice;
    const computeTpMaxPrice = deps.computeTpMaxPrice;
    const summarizeEntryDecision = deps.summarizeEntryDecision;
    const getDirectionFromState = deps.getDirectionFromState;
    const getDirection = deps.getDirection;
    const numFromAny = deps.numFromAny;
    const groupsForTicker = deps.groupsForTicker;
    const GROUP_ORDER = deps.GROUP_ORDER;
    const GROUP_LABELS = deps.GROUP_LABELS;
    const TRADE_SIZE = deps.TRADE_SIZE;
    const FUTURES_SPECS = deps.FUTURES_SPECS || {};
    const getStaleInfo = deps.getStaleInfo;
    const isNyRegularMarketOpen = deps.isNyRegularMarketOpen;
    const downsampleByInterval = deps.downsampleByInterval;

    return function TickerDetailRightRail({
        ticker,
        trade = null,
        onClose,
        allLoadedData = null,
        rankedTickers = null,
        rankedTickerPositions = null,
        rankAsOfMs = null,
        sectors = [],
        onJourneyHover = null,
        onJourneySelect = null,
        selectedJourneyTs = null,
        initialRailTab = null,
      }) {
        const tickerSymbol = ticker?.ticker ? String(ticker.ticker) : "";

        // Fetch full latest payload for Right Rail (ensures `context` shows even when /timed/all is context-light).
        const [latestTicker, setLatestTicker] = useState(null);
        const [latestTickerLoading, setLatestTickerLoading] = useState(false);
        const [latestTickerError, setLatestTickerError] = useState(null);

        const [ledgerTrades, setLedgerTrades] = useState([]);
        const [ledgerTradesLoading, setLedgerTradesLoading] = useState(false);
        const [ledgerTradesError, setLedgerTradesError] = useState(null);

        const [bubbleJourney, setBubbleJourney] = useState([]);
        const [bubbleJourneyLoading, setBubbleJourneyLoading] = useState(false);
        const [bubbleJourneyError, setBubbleJourneyError] = useState(null);

        const [railTab, setRailTab] = useState("ANALYSIS"); // ANALYSIS | CHART | TECHNICALS | JOURNEY | TRADE_HISTORY

        // Right Rail: multi-timeframe candles chart (fetched on-demand)
        const [chartTf, setChartTf] = useState("60"); // Default to 1H
        const [chartCandles, setChartCandles] = useState([]);
        const [chartLoading, setChartLoading] = useState(false);
        const [chartError, setChartError] = useState(null);
        const [crosshair, setCrosshair] = useState(null);
        const chartScrollRef = useRef(null);
        
        // Accordion states (MUST be at component level, not inside IIFE blocks)
        const [scoreExpanded, setScoreExpanded] = useState(false);
        const [tpExpanded, setTpExpanded] = useState(false);

        // Prevent stale crosshair data from crashing renders when switching
        // tickers/timeframes/tabs quickly (e.g. clicking Chart right after selecting a ticker).
        useEffect(() => {
          setCrosshair(null);
        }, [tickerSymbol, chartTf, railTab]);

        // Default tab: use initialRailTab when provided (e.g. Trade Tracker), else Analysis when switching tickers
        useEffect(() => {
          setRailTab(initialRailTab || "ANALYSIS");
        }, [tickerSymbol, initialRailTab]);

        useEffect(() => {
          setChartCandles([]);
          setChartError(null);
          setChartLoading(false);
        }, [tickerSymbol]);

        // Auto-scroll chart to most recent candle when data loads
        useEffect(() => {
          if (chartScrollRef.current && chartCandles.length > 0 && railTab === "ANALYSIS") {
            setTimeout(() => {
              if (chartScrollRef.current) {
                chartScrollRef.current.scrollLeft = chartScrollRef.current.scrollWidth;
              }
            }, 100);
          }
        }, [chartCandles.length, railTab]);

        useEffect(() => {
          const sym = String(tickerSymbol || "")
            .trim()
            .toUpperCase();
          if (railTab !== "ANALYSIS" || !sym) return;

          let cancelled = false;
          const run = async () => {
            try {
              setChartLoading(true);
              setChartError(null);
              const qs = new URLSearchParams();
              qs.set("ticker", sym);
              qs.set("tf", String(chartTf || "30"));
              qs.set("limit", "200");
              const res = await fetch(`${API_BASE}/timed/candles?${qs.toString()}`, {
                cache: "no-store",
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const json = await res.json();
              if (!json.ok) throw new Error(json.error || "candles_failed");
              const candles = Array.isArray(json.candles) ? json.candles : [];
              if (!cancelled) setChartCandles(candles);
            } catch (e) {
              if (!cancelled) {
                setChartCandles([]);
                setChartError(String(e?.message || e));
              }
            } finally {
              if (!cancelled) setChartLoading(false);
            }
          };
          run();
          return () => {
            cancelled = true;
          };
        }, [railTab, tickerSymbol, chartTf]);

        useEffect(() => {
          const sym = String(tickerSymbol || "")
            .trim()
            .toUpperCase();
          if (!sym) {
            setLatestTicker(null);
            setLatestTickerError(null);
            setLatestTickerLoading(false);
            return;
          }

          let cancelled = false;
          const fetchLatest = async () => {
            try {
              setLatestTickerLoading(true);
              setLatestTickerError(null);
              const qs = new URLSearchParams();
              qs.set("ticker", sym);
              const res = await fetch(
                `${API_BASE}/timed/latest?${qs.toString()}`,
                { cache: "no-store" },
              );
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const json = await res.json();
              if (!json.ok) throw new Error(json.error || "latest_failed");
              const data =
                (json.latestData && typeof json.latestData === "object"
                  ? json.latestData
                  : json.data && typeof json.data === "object"
                    ? json.data
                    : null) || null;
              if (!cancelled) setLatestTicker(data);
            } catch (e) {
              if (!cancelled) {
                setLatestTicker(null);
                setLatestTickerError(String(e?.message || e));
              }
            } finally {
              if (!cancelled) setLatestTickerLoading(false);
            }
          };
          fetchLatest();
          return () => {
            cancelled = true;
          };
        }, [tickerSymbol]);

        useEffect(() => {
          const sym = String(tickerSymbol || "")
            .trim()
            .toUpperCase();
          if (!sym) {
            setLedgerTrades([]);
            setLedgerTradesError(null);
            setLedgerTradesLoading(false);
            return;
          }

          let cancelled = false;
          const fetchLedgerTrades = async () => {
            try {
              setLedgerTradesLoading(true);
              setLedgerTradesError(null);
              const qs = new URLSearchParams();
              qs.set("ticker", sym);
              qs.set("limit", "20");
              const res = await fetch(
                `${API_BASE}/timed/ledger/trades?${qs.toString()}`,
                { cache: "no-store" },
              );
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const json = await res.json();
              if (!json.ok)
                throw new Error(json.error || "ledger_trades_failed");
              const trades = Array.isArray(json.trades) ? json.trades : [];
              // Filter out archived trades
              const activeTrades = trades.filter(t => {
                const status = String(t.status || "").toUpperCase();
                return status !== "ARCHIVED";
              });
              if (!cancelled) setLedgerTrades(activeTrades);
            } catch (e) {
              if (!cancelled) {
                setLedgerTrades([]);
                setLedgerTradesError(String(e.message || e));
              }
            } finally {
              if (!cancelled) setLedgerTradesLoading(false);
            }
          };

          fetchLedgerTrades();
          return () => {
            cancelled = true;
          };
        }, [tickerSymbol]);

        useEffect(() => {
          const sym = String(tickerSymbol || "")
            .trim()
            .toUpperCase();
          if (!sym) {
            setBubbleJourney([]);
            setBubbleJourneyError(null);
            setBubbleJourneyLoading(false);
            return;
          }

          let cancelled = false;

          const toMs = (v) => {
            if (v == null) return NaN;
            if (typeof v === "number") return v;
            const n = Number(v);
            if (Number.isFinite(n)) return n;
            const d = new Date(String(v));
            const ms = d.getTime();
            return Number.isFinite(ms) ? ms : NaN;
          };

          const fetchBubbleJourney = async () => {
            try {
              setBubbleJourneyLoading(true);
              setBubbleJourneyError(null);
              const qs = new URLSearchParams();
              qs.set("ticker", sym);
              // Server may return oldest->newest; grab a reasonable window and sort client-side.
              qs.set("limit", "250");
              const res = await fetch(
                `${API_BASE}/timed/trail?${qs.toString()}`,
                {
                  cache: "no-store",
                },
              );
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const json = await res.json();
              if (!json.ok) throw new Error(json.error || "trail_failed");
              const raw = Array.isArray(json.trail) ? json.trail : [];
              const normalized = normalizeTrailPoints(raw);
              const withTs = normalized
                .map((p) => {
                  const ts = toMs(
                    p.ts ?? p.timestamp ?? p.ingest_ts ?? p.ingest_time,
                  );
                  if (!Number.isFinite(ts)) return null;
                  return { ...p, __ts_ms: ts };
                })
                .filter(Boolean)
                .sort((a, b) => a.__ts_ms - b.__ts_ms);
              // Keep more history for Journey time-period analysis
              const last200 = withTs.slice(-200);
              if (!cancelled) setBubbleJourney(last200);
            } catch (e) {
              if (!cancelled) {
                setBubbleJourney([]);
                setBubbleJourneyError(String(e.message || e));
              }
            } finally {
              if (!cancelled) setBubbleJourneyLoading(false);
            }
          };

          fetchBubbleJourney();
          return () => {
            cancelled = true;
          };
        }, [tickerSymbol]);

        const safeTicker =
          ticker && typeof ticker === "object" ? ticker : null;
        const patternFlags = safeTicker?.flags || {};

        // IMPORTANT: Keep hooks unconditional (no early returns before hooks),
        // otherwise React will throw "Rendered more hooks than during the previous render".
        const detectedPatterns = React.useMemo(
          () => detectPatterns(bubbleJourney, patternFlags || {}),
          [bubbleJourney, patternFlags],
        );

        if (!safeTicker || !tickerSymbol) return null;

        const prime = isPrimeBubble(ticker);
        const ent = entryType(ticker);
        const flags = patternFlags;
        const phase = Number(ticker.phase_pct) || 0;
        const phaseColor = phaseToColor(phase);
        const actionInfo = getActionDescription(ticker);
        const decisionSummary = summarizeEntryDecision(ticker);

        const triggerItems = (() => {
          const items = [];

          // Prefer explicit triggers from script payload
          if (Array.isArray(ticker.triggers)) {
            for (const t of ticker.triggers) {
              if (typeof t === "string" && t.trim()) items.push(t.trim());
            }
          }

          // Fallback to known fields/flags (backward compatible)
          if (items.length === 0) {
            const trigReason = String(ticker.trigger_reason || "").trim();
            const trigDir = String(ticker.trigger_dir || "").trim();
            const trigTf = String(ticker.trigger_tf || "").trim();
            if (trigReason) {
              const uncorroborated =
                ticker.trigger_reason_corroborated === false &&
                (trigReason === "EMA_CROSS_1H_13_48" ||
                  trigReason === "EMA_CROSS_30M_13_48");
              items.push(
                trigTf
                  ? `${trigReason}${trigDir ? " (" + trigDir + ")" : ""} [${trigTf}]${
                      uncorroborated ? " ⚠️ unconfirmed" : ""
                    }`
                  : `${trigReason}${trigDir ? " (" + trigDir + ")" : ""}${
                      uncorroborated ? " ⚠️ unconfirmed" : ""
                    }`,
              );
            }
            if (flags.sq30_release) items.push("SQUEEZE_RELEASE_30M");
            if (flags.st_flip_30m) items.push("ST_FLIP_30M");
            if (flags.st_flip_1h) items.push("ST_FLIP_1H");
            if (flags.ema_cross_1h_13_48) items.push("EMA_CROSS_1H_13_48");
            if (flags.buyable_dip_1h_13_48) items.push("BUYABLE_DIP_1H_13_48");
          }

          // Dedup
          return Array.from(new Set(items));
        })();
        const tfTech =
          ticker.tf_tech && typeof ticker.tf_tech === "object"
            ? ticker.tf_tech
            : null;
        const tfOrder = [
          { k: "W", label: "W" },
          { k: "D", label: "D" },
          { k: "4H", label: "4H" },
          { k: "1H", label: "1H" },
          { k: "30", label: "30m" },
          { k: "10", label: "10m" },
          { k: "3", label: "3m" },
        ];
        const emaLevels = [5, 13, 21, 48, 89, 200, 233];
        const divIcon = (code) =>
          code === "B" ? "🐂" : code === "S" ? "🐻" : "";
        const phaseDotLabel = (code) => {
          switch (code) {
            case "P100":
              return "↘︎ +100";
            case "P618":
              return "↘︎ +61.8";
            case "N618":
              return "↗︎ -61.8";
            case "N100":
              return "↗︎ -100";
            default:
              return code || "";
          }
        };

        const baseScore = Number(ticker.rank) || 0;
        const displayScore = rankScoreForTicker(ticker);
        const sortedByRank =
          rankedTickers && rankedTickers.length > 0
            ? rankedTickers
            : getRankedTickers(allLoadedData);
        const rankPosition =
          getRankPositionFromMap(rankedTickerPositions, tickerSymbol) ??
          getRankPosition(sortedByRank, tickerSymbol);
        const totalTickers = sortedByRank.length;
        const rankTotal =
          Number.isFinite(Number(ticker.rank_total)) &&
          Number(ticker.rank_total) > 0
            ? Number(ticker.rank_total)
            : totalTickers;

        const rankAsOfText = (() => {
          const ms = Number(rankAsOfMs);
          if (!Number.isFinite(ms)) return null;
          try {
            return new Date(ms).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            });
          } catch {
            return null;
          }
        })();

        return (
          <div className="w-full h-full flex flex-col">
            <div
              className="bg-[#13171e] border-2 border-[#252b36] rounded-xl w-full h-full flex flex-col shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Scrollable Content Area */}
              <div className="flex-1 overflow-y-auto">
                <div className="sticky top-0 z-30 bg-[#13171e] border-b border-[#252b36] px-6 py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-xl font-bold">{tickerSymbol}</h3>
                      {ticker.price && (
                        <div className="text-sm text-white mt-1">
                          ${Number(ticker.price).toFixed(2)}
                        </div>
                      )}
                      {(() => {
                        const { dayChg, dayPct, stale, marketOpen } =
                          getDailyChange(ticker);
                        if (
                          !Number.isFinite(dayChg) &&
                          !Number.isFinite(dayPct)
                        )
                          return null;
                        const sign =
                          Number(dayChg || dayPct || 0) >= 0 ? "+" : "-";
                        const cls =
                          Number(dayChg || dayPct || 0) >= 0
                            ? "text-green-400"
                            : "text-red-400";
                        return (
                          <div className={`text-xs mt-0.5 ${cls}`}>
                            {Number.isFinite(dayChg)
                              ? `${sign}${fmtUsdAbs(dayChg)}`
                              : "—"}{" "}
                            {Number.isFinite(dayPct)
                              ? `(${sign}${Math.abs(dayPct).toFixed(2)}%)`
                              : ""}
                            {!marketOpen && (
                              <span className="ml-2 text-[10px] text-[#8b92a0]">
                                AH
                                {stale?.ageLabel
                                  ? ` • as of ${stale.ageLabel}`
                                  : ""}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                      {(() => {
                        const stage = String(ticker?.kanban_stage || "");
                        const showEntryStats =
                          stage === "enter_now" ||
                          stage === "hold" ||
                          stage === "just_entered" ||
                          stage === "trim" ||
                          stage === "exit";
                        if (!showEntryStats) return null;
                        const price = numFromAny(ticker?.price);
                        const entryPriceRaw = numFromAny(ticker?.entry_price);
                        const entryRefRaw = numFromAny(ticker?.entry_ref);
                        const triggerRaw = numFromAny(ticker?.trigger_price);
                        const entryPx =
                          Number.isFinite(entryPriceRaw) && entryPriceRaw > 0
                            ? entryPriceRaw
                            : Number.isFinite(entryRefRaw) && entryRefRaw > 0
                              ? entryRefRaw
                              : Number.isFinite(triggerRaw) && triggerRaw > 0
                                ? triggerRaw
                                : null;
                        const dir = getDirectionFromState(ticker);
                        const entryPctRaw = numFromAny(
                          ticker?.entry_change_pct,
                        );
                        const entryPct = Number.isFinite(entryPctRaw)
                          ? entryPctRaw
                          : Number.isFinite(entryPx) &&
                              entryPx > 0 &&
                              Number.isFinite(price) &&
                              price > 0
                            ? dir === "SHORT"
                              ? ((entryPx - price) / entryPx) * 100
                              : ((price - entryPx) / entryPx) * 100
                            : null;
                        if (
                          !Number.isFinite(entryPx) &&
                          !Number.isFinite(entryPct)
                        )
                          return null;
                        return (
                          <div className="text-[11px] mt-1 text-cyan-300/90">
                            {Number.isFinite(entryPx)
                              ? `Entry $${Number(entryPx).toFixed(2)}`
                              : "Entry —"}
                            {Number.isFinite(entryPct)
                              ? ` • Since entry ${entryPct >= 0 ? "+" : ""}${entryPct.toFixed(2)}%`
                              : ""}
                          </div>
                        );
                      })()}
                      
                      {/* Bias - Inline */}
                      {(() => {
                        const dir = getDirection(ticker);
                        return (
                          <div className="mt-2">
                            <span
                              className={`inline-block px-3 py-1 rounded-lg font-bold text-sm ${dir.bg} ${dir.color} border border-current/30`}
                            >
                              {dir.text === "LONG"
                                ? "📈 LONG"
                                : dir.text === "SHORT"
                                  ? "📉 SHORT"
                                  : dir.text}
                            </span>
                          </div>
                        );
                      })()}
                      
                      {/* Groups - Inline */}
                      {(() => {
                        try {
                          const gs = groupsForTicker(ticker.ticker);
                          if (!Array.isArray(gs) || gs.length === 0)
                            return null;
                          const ordered = Array.isArray(GROUP_ORDER)
                            ? [...gs].sort(
                                (a, b) =>
                                  GROUP_ORDER.indexOf(a) -
                                  GROUP_ORDER.indexOf(b),
                              )
                            : gs;
                          return (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {ordered.map((g) => {
                                const label = GROUP_LABELS[g] || g;
                                const isSocial = g === "Social";
                                return (
                                  <span
                                    key={`group-${g}`}
                                    className={`text-[9px] px-1.5 py-0.5 rounded border ${
                                      isSocial
                                        ? "bg-purple-500/15 border-purple-500/40 text-purple-200"
                                        : "bg-[#13171e] border-[#252b36] text-[#f0f2f5]"
                                    }`}
                                  >
                                    {label}
                                  </span>
                                );
                              })}
                            </div>
                          );
                        } catch {
                          return null;
                        }
                      })()}
                    </div>
                    <button
                      onClick={onClose}
                      className="text-[#8b92a0] hover:text-white transition-colors text-xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-[#252b36]"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Last Ingest Date/Time */}
                  {(() => {
                    const ingestTime =
                      ticker.ingest_ts || ticker.ingest_time || ticker.ts;
                    if (!ingestTime) return null;
                    try {
                      const timeValue =
                        typeof ingestTime === "string"
                          ? new Date(ingestTime)
                          : new Date(Number(ingestTime));
                      if (isNaN(timeValue.getTime())) return null;
                      const displayDate = timeValue.toLocaleDateString(
                        "en-US",
                        {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        },
                      );
                      const displayTime = timeValue.toLocaleTimeString(
                        "en-US",
                        {
                          hour: "numeric",
                          minute: "2-digit",
                          hour12: true,
                        },
                      );
                      const ageMs = Date.now() - timeValue.getTime();
                      const ageMinutes = Math.floor(ageMs / 60000);
                      const ageHours = Math.floor(ageMinutes / 60);
                      const ageDays = Math.floor(ageHours / 24);
                      let ageText;
                      let ageColor = "text-green-400";
                      if (ageMinutes < 5) {
                        ageText = `${ageMinutes}m ago`;
                        ageColor = "text-green-400";
                      } else if (ageMinutes < 60) {
                        ageText = `${ageMinutes}m ago`;
                        ageColor = "text-yellow-400";
                      } else if (ageHours < 24) {
                        ageText = `${ageHours}h ago`;
                        ageColor =
                          ageHours < 2 ? "text-yellow-400" : "text-orange-400";
                      } else {
                        ageText = `${ageDays}d ago`;
                        ageColor = "text-red-400";
                      }
                      return (
                        <div className="mt-2 text-xs flex items-center gap-2">
                          <span className="text-[#8b92a0]">Last Ingest:</span>
                          <span className="text-white font-semibold">
                            {displayDate} {displayTime}
                          </span>
                          <span className={`font-semibold ${ageColor}`}>
                            ({ageText})
                          </span>
                        </div>
                      );
                    } catch {
                      return null;
                    }
                  })()}

                  {/* Move status (Active / Invalidated / Completed) */}
                  {(() => {
                    const ms =
                      ticker?.move_status &&
                      typeof ticker.move_status === "object"
                        ? ticker.move_status
                        : null;
                    if (!ms || !ms.status) return null;

                    const status = String(ms.status || "").toUpperCase();
                    const severity = String(ms.severity || "").toUpperCase();
                    const reasonsRaw = Array.isArray(ms.reasons)
                      ? ms.reasons
                      : [];
                    const marketOpen = isNyRegularMarketOpen();
                    const staleInfo = getStaleInfo(ticker, {
                      maxAgeMin: marketOpen ? 90 : 72 * 60,
                    });

                    const pretty = (r) => {
                      const key = String(r || "").trim();
                      const map = {
                        sl_breached: "SL breached",
                        tp_reached: "TP reached",
                        daily_ema_regime_break: "Daily EMA regime break",
                        ichimoku_regime_break: "Ichimoku regime break",
                        late_cycle: "Late-cycle",
                        overextended: "Overextended",
                        left_entry_corridor: "Left entry corridor",
                      };
                      return map[key] || key.replace(/_/g, " ");
                    };

                    const pill =
                      status === "INVALIDATED"
                        ? "bg-red-500/15 text-red-300 border-red-500/40"
                        : status === "COMPLETED"
                          ? "bg-purple-500/15 text-purple-300 border-purple-500/40"
                          : "bg-green-500/10 text-green-300 border-green-500/30";

                    const icon =
                      status === "INVALIDATED"
                        ? "⛔"
                        : status === "COMPLETED"
                          ? "✅"
                          : "🟢";

                    const reasons = reasonsRaw
                      .filter((x) => x != null)
                      .map((x) => String(x))
                      .filter((x) => x.trim())
                      .slice(0, 8);

                    const freshnessLabel = (() => {
                      const isStale = !!staleInfo?.isStale;
                      const age = staleInfo?.ageLabel
                        ? ` (${staleInfo.ageLabel})`
                        : "";
                      return `${isStale ? "Stale" : "Fresh"}${age}`;
                    })();
                    const freshnessCls = staleInfo?.isStale
                      ? "text-yellow-300"
                      : "text-green-300";
                    const headlineReason =
                      reasons.length > 0 ? pretty(reasons[0]) : null;
                    const kanbanStageRaw = String(
                      ticker?.kanban_stage || "",
                    ).trim();
                    const kanbanStage = kanbanStageRaw
                      ? kanbanStageRaw.toUpperCase()
                      : "";
                    const kanbanPill =
                      kanbanStage === "EXIT"
                        ? "bg-red-500/15 text-red-300 border-red-500/40"
                        : kanbanStage === "TRIM"
                          ? "bg-yellow-500/15 text-yellow-300 border-yellow-500/40"
                          : kanbanStage === "DEFEND"
                            ? "bg-orange-500/15 text-orange-300 border-orange-500/40"
                            : kanbanStage === "HOLD"
                              ? "bg-blue-500/15 text-blue-300 border-blue-500/40"
                              : kanbanStage === "ENTER_NOW"
                                ? "bg-green-500/15 text-green-300 border-green-500/40"
                                : "bg-white/5 text-[#8b92a0] border-white/10";

                    return (
                      <div className="mt-2">
                        <div className="flex items-center gap-2 flex-wrap text-[11px]">
                          <span className="text-[#8b92a0]">Move:</span>
                          <span
                            className={`px-2 py-0.5 rounded border font-semibold ${pill}`}
                          >
                            {icon} {status}
                            {severity ? (
                              <span className="ml-1 text-[10px] opacity-80">
                                ({severity})
                              </span>
                            ) : null}
                          </span>
                          {kanbanStage ? (
                            <>
                              <span className="text-[#8b92a0]">Action:</span>
                              <span
                                className={`px-2 py-0.5 rounded border font-semibold ${kanbanPill}`}
                              >
                                {kanbanStage}
                              </span>
                            </>
                          ) : null}
                        </div>
                        <div className="mt-1 text-[10px] text-[#5c6475]">
                          <span className={`font-semibold ${freshnessCls}`}>
                            {freshnessLabel}
                          </span>
                          {(status === "INVALIDATED" ||
                            status === "COMPLETED") &&
                          headlineReason ? (
                            <span>
                              {" "}
                              •{" "}
                              <span className="text-[#8b92a0]">
                                {status === "INVALIDATED"
                                  ? "Invalidated"
                                  : "Completed"}
                                :
                              </span>{" "}
                              <span className="text-[#f0f2f5]">
                                {headlineReason}
                              </span>
                            </span>
                          ) : null}
                          {status === "ACTIVE" &&
                          headlineReason &&
                          severity &&
                          severity !== "NONE" ? (
                            <span>
                              {" "}
                              • <span className="text-[#8b92a0]">
                                Reason:
                              </span>{" "}
                              <span className="text-[#f0f2f5]">
                                {headlineReason}
                              </span>
                            </span>
                          ) : null}
                        </div>
                        {status === "INVALIDATED" && reasons.length > 0 ? (
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {reasons.map((r, idx) => (
                              <span
                                key={`inv-reason-${idx}`}
                                className="px-2 py-0.5 rounded border border-red-500/20 bg-red-500/10 text-[10px] text-red-200"
                              >
                                {pretty(r)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {status === "COMPLETED" && reasons.length > 0 ? (
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {reasons.map((r, idx) => (
                              <span
                                key={`comp-reason-${idx}`}
                                className="px-2 py-0.5 rounded border border-purple-500/20 bg-purple-500/10 text-[10px] text-purple-200"
                              >
                                {pretty(r)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })()}

                  {/* Right Rail Tabs */}
                  <div className="mt-3 flex items-center gap-2 flex-wrap">
                    {[
                      { k: "ANALYSIS", label: "Analysis" },
                      { k: "TECHNICALS", label: "Technicals" },
                      { k: "JOURNEY", label: "Journey" },
                      {
                        k: "TRADE_HISTORY",
                        label: `Trade History (${Array.isArray(ledgerTrades) ? ledgerTrades.length : 0})`,
                      },
                    ].map((t) => {
                      const active = railTab === t.k;
                      return (
                        <button
                          key={`rail-tab-${t.k}`}
                          onClick={() => setRailTab(t.k)}
                          className={`px-3 py-1 rounded-lg border text-[11px] font-semibold transition-all ${
                            active
                              ? "border-blue-400 bg-blue-500/20 text-blue-200"
                              : "border-[#252b36] bg-[#1a1f28] text-[#8b92a0] hover:text-white"
                          }`}
                        >
                          {t.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Padded body content (keeps header top-aligned) */}
                <div className="p-6 pt-4">
                  {railTab === "ANALYSIS" ? (
                    <>
                      {/* Context (optional enrichment from /timed/ingest-context) */}
                      {(() => {
                        const baseCtx =
                          ticker?.context && typeof ticker.context === "object"
                            ? ticker.context
                            : null;
                        const latestCtx =
                          latestTicker?.context &&
                          typeof latestTicker.context === "object"
                            ? latestTicker.context
                            : null;
                        const ctx =
                          baseCtx || latestCtx
                            ? { ...(baseCtx || {}), ...(latestCtx || {}) }
                            : null;
                        if (!ctx) return null;
                        const clean = (v) =>
                          v == null
                            ? ""
                            : String(v)
                                // Some capture strings can contain stray control chars (e.g. \r),
                                // which render oddly in the browser.
                                .replace(/\\r/g, "r")
                                .replace(/\r/g, "r")
                                .trim();

                        const name = clean(ctx.name);
                        const description = clean(ctx.description);
                        const sector = clean(ctx.sector);
                        const industry = clean(ctx.industry);
                        const country = clean(ctx.country);
                        const tr =
                          ctx.technical_rating &&
                          typeof ctx.technical_rating === "object"
                            ? ctx.technical_rating
                            : null;
                        const trStatus =
                          tr && tr.status ? String(tr.status) : null;
                        const trValue =
                          tr && Number.isFinite(Number(tr.value))
                            ? Number(tr.value)
                            : null;
                        const events =
                          ctx.events && typeof ctx.events === "object"
                            ? ctx.events
                            : null;
                        const lastEarnTs =
                          events &&
                          Number.isFinite(Number(events.last_earnings_ts))
                            ? Number(events.last_earnings_ts)
                            : null;
                        const lastDivTs =
                          events &&
                          Number.isFinite(Number(events.last_dividend_ts))
                            ? Number(events.last_dividend_ts)
                            : null;

                        const fmtDate = (ms) => {
                          if (!Number.isFinite(Number(ms))) return "—";
                          try {
                            return new Date(Number(ms)).toLocaleDateString(
                              "en-US",
                              {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              },
                            );
                          } catch {
                            return "—";
                          }
                        };

                        return (
                          <div className="mb-4 p-3 bg-[#1a1f28] border-2 border-[#252b36] rounded-lg">
                            <div className="text-sm text-[#8b92a0] mb-2">
                              Context
                            </div>
                            {latestTickerLoading ? (
                              <div className="text-xs text-[#5c6475]">
                                Loading context…
                              </div>
                            ) : null}
                            {latestTickerError ? (
                              <div className="text-xs text-yellow-300">
                                Context unavailable: {latestTickerError}
                              </div>
                            ) : null}
                            {name ? (
                              <div className="text-sm font-semibold text-white leading-snug">
                                {name}
                              </div>
                            ) : null}
                            {description ? (
                              <div className="mt-1 text-xs text-[#8b92a0] leading-snug">
                                {description}
                              </div>
                            ) : null}
                            <div className="mt-1 text-[11px] text-[#8b92a0]">
                              {[sector, industry, country]
                                .filter(Boolean)
                                .join(" • ") || "—"}
                            </div>

                            {(trStatus || trValue != null || lastEarnTs || events?.next_earnings_ts) ? (
                              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                                {(trStatus || trValue != null) ? (
                                  <div className="p-2 bg-[#13171e] border border-[#252b36] rounded">
                                    <div className="text-[9px] text-[#8b92a0] mb-1" title="Normalized score: 0=Strong Sell, 0.5=Neutral, 1=Strong Buy">
                                      Tech Rating {trValue != null ? `(${trValue.toFixed(2)})` : ''}
                                    </div>
                                    <div className="text-xs font-semibold text-white no-ligatures">
                                      {trStatus || "—"}
                                    </div>
                                  </div>
                                ) : null}
                                {events?.next_earnings_ts ? (
                                  <div className="p-2 bg-blue-500/10 border border-blue-500/30 rounded">
                                    <div className="text-[9px] text-blue-400 mb-1">
                                      Next Earnings
                                    </div>
                                    <div className="text-xs font-semibold text-white">
                                      {fmtDate(events.next_earnings_ts)}
                                    </div>
                                  </div>
                                ) : lastEarnTs ? (
                                  <div className="p-2 bg-[#13171e] border border-[#252b36] rounded">
                                    <div className="text-[9px] text-[#8b92a0] mb-1">
                                      Last Earnings
                                    </div>
                                    <div className="text-xs font-semibold text-white">
                                      {fmtDate(lastEarnTs)}
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })()}

                      {prime && (
                        <div className="mb-4 p-3 bg-green-500/20 border-2 border-green-500 rounded-lg text-center font-bold text-green-500 prime-glow">
                          ⭐ PRIME SETUP ⭐
                        </div>
                      )}

                      {/* Sector and Rating */}
                      {(() => {
                        const tickerSectorRaw =
                          getTickerSector(ticker.ticker) ||
                          ticker.sector ||
                          ticker.fundamentals?.sector ||
                          "";
                        const sectorKey = normalizeSectorKey(tickerSectorRaw);
                        if (sectorKey && sectors.length > 0) {
                          const sectorInfo = sectors.find((s) => {
                            const name = s?.sector || s?.name || "";
                            return normalizeSectorKey(name) === sectorKey;
                          });
                          const displaySector =
                            sectorInfo?.sector ||
                            sectorInfo?.name ||
                            sectorKeyToCanonicalName(sectorKey);
                          const rating = String(
                            sectorInfo?.rating || "neutral",
                          ).toLowerCase();
                          const boost =
                            sectorInfo?.boost != null
                              ? Number(sectorInfo.boost)
                              : null;
                          // Match emojis used in the filter pills
                          const emoji =
                            rating === "overweight"
                              ? "💪"
                              : rating === "underweight"
                                ? "👎"
                                : "😒";
                          return (
                            <div className="mb-4 p-3 bg-[#1a1f28] border-2 border-[#252b36] rounded-lg">
                              <div className="text-sm text-[#8b92a0] mb-2">
                                Sector
                              </div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-base">{emoji}</span>
                                <span className="font-semibold text-white text-sm">
                                  {displaySector}
                                </span>
                                <span
                                  className={`text-[10px] px-2 py-0.5 rounded ${
                                    rating === "overweight"
                                      ? "bg-green-500/20 text-green-400"
                                      : rating === "underweight"
                                        ? "bg-red-500/20 text-red-400"
                                        : "bg-[#252b36] text-[#8b92a0]"
                                  }`}
                                >
                                  {rating.charAt(0).toUpperCase() +
                                    rating.slice(1)}
                                </span>
                                {Number.isFinite(boost) && boost !== 0 && (
                                  <span className="text-[9px] text-[#8b92a0]">
                                    Boost {boost > 0 ? `+${boost}` : boost}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        }
                        return null;
                      })()}

                      {/* Merged Guidance + System Decision */}
                      <div
                        className={`mb-4 p-4 rounded-lg border-2 ${actionInfo.bg} border-current/30`}
                      >
                        <div className="flex items-center justify-between mb-3">
                          <div className="text-sm text-[#8b92a0] font-semibold">
                            System Guidance
                          </div>
                          {decisionSummary && (
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold ${decisionSummary.bg} ${decisionSummary.tone}`}
                            >
                              {decisionSummary.status}
                            </span>
                          )}
                        </div>
                        <div
                          className={`text-lg font-bold mb-2 ${actionInfo.color}`}
                        >
                          {actionInfo.action}
                        </div>
                        <div className="text-sm text-[#cbd5ff] leading-relaxed">
                          {actionInfo.description}
                        </div>
                        
                        {/* Stop Loss, Target Prices, R:R */}
                        {(() => {
                          const sl = ticker.sl ? Number(ticker.sl) : null;
                          const tpTarget = computeTpTargetPrice(ticker);
                          const tpMax = computeTpMaxPrice(ticker);
                          const rr = ticker.rr ? Number(ticker.rr) : null;
                          
                          const hasTargets = Number.isFinite(sl) || Number.isFinite(tpTarget) || Number.isFinite(tpMax) || Number.isFinite(rr);
                          if (!hasTargets) return null;
                          
                          return (
                            <div className="mt-3 pt-3 border-t border-current/20">
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                {Number.isFinite(sl) && (
                                  <div className="p-2 bg-red-500/10 border border-red-500/30 rounded">
                                    <div className="text-[10px] text-red-300 mb-0.5">Stop Loss</div>
                                    <div className="font-semibold text-red-400">${sl.toFixed(2)}</div>
                                  </div>
                                )}
                                {Number.isFinite(tpTarget) && (
                                  <div className="p-2 bg-green-500/10 border border-green-500/30 rounded">
                                    <div className="text-[10px] text-green-300 mb-0.5">Target Price</div>
                                    <div className="font-semibold text-green-400">${tpTarget.toFixed(2)}</div>
                                  </div>
                                )}
                                {Number.isFinite(tpMax) && Math.abs(tpMax - (tpTarget || 0)) > 0.01 && (
                                  <div className="p-2 bg-green-500/10 border border-green-500/30 rounded">
                                    <div className="text-[10px] text-green-300 mb-0.5">Stretch Goal</div>
                                    <div className="font-semibold text-green-400">${tpMax.toFixed(2)}</div>
                                  </div>
                                )}
                                {Number.isFinite(rr) && (
                                  <div className="p-2 bg-blue-500/10 border border-blue-500/30 rounded">
                                    <div className="text-[10px] text-blue-300 mb-0.5">Risk:Reward</div>
                                    <div className="font-semibold text-blue-400">{rr.toFixed(2)}:1</div>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                        {/* Plain English Reasons */}
                        {(() => {
                          const ms = ticker?.move_status && typeof ticker.move_status === "object" ? ticker.move_status : null;
                          const reasonsRaw = Array.isArray(ms?.reasons) ? ms.reasons : [];
                          const reasons = reasonsRaw.filter((x) => x != null && String(x).trim()).slice(0, 5);
                          
                          const translateReason = (r) => {
                            const key = String(r || "").trim().toLowerCase();
                            const translations = {
                              'sl_breached': 'Stop loss price was hit',
                              'tp_reached': 'Target price was reached',
                              'daily_ema_regime_break': 'Price broke below key moving average support',
                              'ichimoku_regime_break': 'Trend structure weakened significantly',
                              'late_cycle': 'Move is in late stage, risk of reversal',
                              'overextended': 'Price stretched too far too fast',
                              'left_entry_corridor': 'Price moved outside ideal entry zone',
                              'corridor': 'Price is in ideal entry zone',
                              'aligned': 'All timeframes show same direction',
                              'prime': 'Setup meets all quality criteria',
                              'sq30_release': 'Consolidation breakout detected',
                              'momentum_elite': 'Stock has strong fundamental momentum',
                              'high_rank': 'Ranks highly vs other opportunities',
                              'good_rr': 'Favorable risk vs reward ratio'
                            };
                            return translations[key] || key.replace(/_/g, ' ');
                          };
                          
                          if (reasons.length === 0) return null;
                          
                          return (
                            <div className="mt-3 pt-3 border-t border-current/20">
                              <div className="text-xs text-[#8b92a0] mb-2 font-semibold">
                                Key Factors:
                              </div>
                              <div className="space-y-1.5">
                                {reasons.map((reason, idx) => (
                                  <div key={`reason-${idx}`} className="flex gap-2 text-xs text-[#cbd5ff]">
                                    <span className="text-cyan-400">•</span>
                                    <span>{translateReason(reason)}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                      </div>

                      {/* Score and Ranking */}
                      <div className="space-y-2.5 text-sm">
                        <div className="flex justify-between items-center py-1 border-b border-[#252b36]/50">
                          <span className="text-[#8b92a0]">Score</span>
                          <span className="font-semibold text-blue-400 text-lg">
                            {Number.isFinite(displayScore)
                              ? displayScore.toFixed(1)
                              : "—"}
                          </span>
                        </div>
                        {rankTotal > 0 && (
                          <div className="flex justify-between items-center py-1 border-b border-[#252b36]/50">
                            <span className="text-[#8b92a0]">Rank</span>
                            <span className="font-semibold">
                              {rankPosition > 0
                                ? `#${rankPosition} of ${rankTotal}`
                                : "—"}
                              {rankAsOfText && (
                                <span className="ml-2 text-[10px] text-[#8b92a0] font-normal">
                                  (as of {rankAsOfText})
                                </span>
                              )}
                            </span>
                          </div>
                        )}
                        {/* Model Score (Worker-provided) */}
                        {(() => {
                          const ml =
                            ticker?.ml ||
                            ticker?.model ||
                            ticker?.model_v1 ||
                            ticker?.ml_v1 ||
                            null;
                          if (!ml || typeof ml !== "object") return null;
                          const p4h = Number(
                            ml?.p_win_4h ?? ml?.p4h ?? ml?.pWin4h,
                          );
                          const ev4h = Number(ml?.ev_4h ?? ml?.ev4h);
                          const p1d = Number(
                            ml?.p_win_1d ?? ml?.p1d ?? ml?.pWin1d,
                          );
                          const ev1d = Number(ml?.ev_1d ?? ml?.ev1d);
                          const has4h =
                            Number.isFinite(p4h) || Number.isFinite(ev4h);
                          const has1d =
                            Number.isFinite(p1d) || Number.isFinite(ev1d);
                          if (!has4h && !has1d) return null;
                          const fmtPct = (x) =>
                            Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—";
                          const fmtEv = (x) =>
                            Number.isFinite(x) ? `${x.toFixed(2)}%` : "—";
                          
                          // Plain English interpretation
                          const interpretML = (pWin, ev) => {
                            const p = Number(pWin) * 100;
                            const e = Number(ev);
                            if (!Number.isFinite(p) || !Number.isFinite(e)) return null;
                            
                            // Strong signals
                            if (p >= 70 && e >= 15) return { text: "🎯 Strong buy - high win%, great reward", color: "text-green-400", bg: "bg-green-500/10" };
                            if (p >= 60 && e >= 10) return { text: "✅ Good setup - favorable odds", color: "text-green-400", bg: "bg-green-500/10" };
                            
                            // Positive but cautious
                            if (e >= 5 && p >= 55) return { text: "🟢 Decent - small edge, manage risk", color: "text-blue-400", bg: "bg-blue-500/10" };
                            if (e >= 0 && p >= 60) return { text: "⚖️ Neutral - breakeven odds", color: "text-yellow-400", bg: "bg-yellow-500/10" };
                            
                            // Warning signals
                            if (p >= 70 && e < 0) return { text: "⚠️ Too late - missed the entry", color: "text-orange-400", bg: "bg-orange-500/10" };
                            if (e < -5 && p >= 50) return { text: "🛑 Skip - poor risk/reward", color: "text-red-400", bg: "bg-red-500/10" };
                            if (p < 45) return { text: "❌ Avoid - low probability", color: "text-red-400", bg: "bg-red-500/10" };
                            
                            // Default
                            return { text: "🤔 Unclear signal - use caution", color: "text-gray-400", bg: "bg-gray-500/10" };
                          };
                          
                          const interp4h = has4h ? interpretML(p4h, ev4h) : null;
                          const interp1d = has1d ? interpretML(p1d, ev1d) : null;
                          
                          return (
                            <>
                              {has4h && (
                                <>
                                  <div className="flex justify-between items-center py-1 border-b border-[#252b36]/50">
                                    <span className="text-[#8b92a0]">
                                      Model (4h)
                                    </span>
                                    <span className="font-semibold text-purple-300">
                                      pWin {fmtPct(p4h)} • EV {fmtEv(ev4h)}
                                    </span>
                                  </div>
                                  {interp4h && (
                                    <div className={`text-xs py-2 px-3 rounded ${interp4h.bg} border border-${interp4h.color.replace('text-', '')}/30 mb-2`}>
                                      <span className={interp4h.color}>{interp4h.text}</span>
                                    </div>
                                  )}
                                </>
                              )}
                              {has1d && (
                                <>
                                  <div className="flex justify-between items-center py-1 border-b border-[#252b36]/50">
                                    <span className="text-[#8b92a0]">
                                      Model (1d)
                                    </span>
                                    <span className="font-semibold text-purple-300">
                                      pWin {fmtPct(p1d)} • EV {fmtEv(ev1d)}
                                    </span>
                                  </div>
                                  {interp1d && (
                                    <div className={`text-xs py-2 px-3 rounded ${interp1d.bg} border border-${interp1d.color.replace('text-', '')}/30 mb-2`}>
                                      <span className={interp1d.color}>{interp1d.text}</span>
                                    </div>
                                  )}
                                </>
                              )}
                            </>
                          );
                        })()}
                        
                        {/* Momentum Elite (near scores) */}
                        {(() => {
                          const mp = ticker?.momentum_pct || {};
                          const hasMomentumData =
                            mp.week != null ||
                            mp.month != null ||
                            mp.three_months != null ||
                            mp.six_months != null;
                          const adr14 = Number(ticker?.adr_14);
                          const avgVol30 = Number(ticker?.avg_vol_30);
                          
                          if (!hasMomentumData && !flags.momentum_elite) return null;

                          const okAdr = Number.isFinite(adr14) && adr14 >= 2;
                          const okVol = Number.isFinite(avgVol30) && avgVol30 >= 2_000_000;

                          const w = mp.week != null ? Number(mp.week) : null;
                          const m = mp.month != null ? Number(mp.month) : null;
                          const m3 = mp.three_months != null ? Number(mp.three_months) : null;
                          const m6 = mp.six_months != null ? Number(mp.six_months) : null;
                          const okW = Number.isFinite(w) && w >= 10;
                          const okM = Number.isFinite(m) && m >= 25;
                          const ok3 = Number.isFinite(m3) && m3 >= 50;
                          const ok6 = Number.isFinite(m6) && m6 >= 100;
                          const okAnyMomentum = okW || okM || ok3 || ok6;

                          const okBase = okAdr && okVol;
                          const computedElite = okBase && okAnyMomentum;
                          const elite = !!flags.momentum_elite || computedElite;

                          const fmtVol = (v) => {
                            const n = Number(v);
                            if (!Number.isFinite(n) || n <= 0) return "—";
                            if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
                            if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
                            return String(Math.round(n));
                          };
                          
                          if (!elite) return null;

                          return (
                            <div className="border-t border-[#252b36] my-3 pt-3">
                              <div className="flex items-center gap-2 mb-2">
                                <span className="text-xs text-purple-300 font-bold">🚀 Momentum Elite</span>
                                <span className="text-[9px] px-1.5 py-0.5 rounded border bg-purple-500/20 border-purple-500/40 text-purple-200">
                                  ACTIVE
                                </span>
                              </div>
                              <div className="grid grid-cols-2 gap-1.5 text-[9px]">
                                {Number.isFinite(w) && (
                                  <div className="flex justify-between">
                                    <span className="text-[#8b92a0]">1W:</span>
                                    <span className={`font-semibold ${okW ? 'text-green-400' : 'text-[#8b92a0]'}`}>
                                      {w.toFixed(1)}%
                                    </span>
                                  </div>
                                )}
                                {Number.isFinite(m) && (
                                  <div className="flex justify-between">
                                    <span className="text-[#8b92a0]">1M:</span>
                                    <span className={`font-semibold ${okM ? 'text-green-400' : 'text-[#8b92a0]'}`}>
                                      {m.toFixed(1)}%
                                    </span>
                                  </div>
                                )}
                                {Number.isFinite(m3) && (
                                  <div className="flex justify-between">
                                    <span className="text-[#8b92a0]">3M:</span>
                                    <span className={`font-semibold ${ok3 ? 'text-green-400' : 'text-[#8b92a0]'}`}>
                                      {m3.toFixed(1)}%
                                    </span>
                                  </div>
                                )}
                                {Number.isFinite(m6) && (
                                  <div className="flex justify-between">
                                    <span className="text-[#8b92a0]">6M:</span>
                                    <span className={`font-semibold ${ok6 ? 'text-green-400' : 'text-[#8b92a0]'}`}>
                                      {m6.toFixed(1)}%
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                        {/* Score Breakdown (Accordion) */}
                        {(() => {
                          const breakdown = calculateScoreBreakdown(ticker);
                          const breakdownComponents = [
                            {
                              label: "Base Score",
                              value: breakdown.base,
                              color: "text-blue-400",
                            },
                            breakdown.corridor > 0
                              ? {
                                  label: "In Corridor",
                                  value: `+${breakdown.corridor}`,
                                  color: "text-cyan-400",
                                }
                              : null,
                            breakdown.corridorAligned > 0
                              ? {
                                  label: "Aligned + Corridor",
                                  value: `+${breakdown.corridorAligned}`,
                                  color: "text-green-400",
                                }
                              : null,
                            breakdown.htfStrength > 0
                              ? {
                                  label: "HTF Strength",
                                  value: `+${breakdown.htfStrength.toFixed(2)}`,
                                  color: "text-cyan-400",
                                }
                              : null,
                            breakdown.ltfStrength > 0
                              ? {
                                  label: "LTF Strength",
                                  value: `+${breakdown.ltfStrength.toFixed(2)}`,
                                  color: "text-cyan-400",
                                }
                              : null,
                            breakdown.completion !== 0
                              ? {
                                  label: "Completion",
                                  value:
                                    breakdown.completion > 0
                                      ? `+${breakdown.completion}`
                                      : `${breakdown.completion}`,
                                  color:
                                    breakdown.completion > 0
                                      ? "text-yellow-400"
                                      : "text-red-400",
                                }
                              : null,
                            breakdown.phase !== 0
                              ? {
                                  label: "Phase",
                                  value:
                                    breakdown.phase > 0
                                      ? `+${breakdown.phase}`
                                      : `${breakdown.phase}`,
                                  color:
                                    breakdown.phase > 0
                                      ? "text-green-400"
                                      : "text-red-400",
                                }
                              : null,
                            breakdown.squeezeRelease > 0
                              ? {
                                  label: "Squeeze Release (Corridor)",
                                  value: `+${breakdown.squeezeRelease}`,
                                  color: "text-purple-400",
                                }
                              : null,
                            breakdown.squeezeOn > 0
                              ? {
                                  label: "Squeeze On (Corridor)",
                                  value: `+${breakdown.squeezeOn}`,
                                  color: "text-yellow-400",
                                }
                              : null,
                            breakdown.phaseZoneChange > 0
                              ? {
                                  label: "Phase Zone Change",
                                  value: `+${breakdown.phaseZoneChange}`,
                                  color: "text-blue-400",
                                }
                              : null,
                            breakdown.rr !== 0
                              ? {
                                  label: "Risk/Reward",
                                  value: `+${breakdown.rr}`,
                                  color: "text-green-400",
                                }
                              : null,
                          ].filter(Boolean);

                          return breakdownComponents.length > 0 ? (
                            <div className="border-t border-[#252b36] my-3 pt-3">
                              <button
                                onClick={() => setScoreExpanded(!scoreExpanded)}
                                className="w-full flex items-center justify-between text-xs text-[#8b92a0] mb-2 font-semibold hover:text-white transition-colors"
                              >
                                <span>Score Breakdown</span>
                                <span className="text-base">{scoreExpanded ? "▼" : "▶"}</span>
                              </button>
                              {scoreExpanded && (
                                <div className="space-y-1.5">
                                  {breakdownComponents.map((comp, idx) => (
                                    <div
                                      key={idx}
                                      className="flex justify-between items-center text-xs"
                                    >
                                      <span className="text-[#8b92a0]">
                                        {comp.label}
                                      </span>
                                      <span
                                        className={`font-semibold ${comp.color}`}
                                      >
                                        {comp.value}
                                      </span>
                                    </div>
                                  ))}
                                  <div className="flex justify-between items-center text-sm mt-2 pt-2 border-t border-[#252b36]">
                                    <span className="text-[#8b92a0] font-semibold">
                                      Total Score
                                    </span>
                                    <span className="text-blue-400 font-bold text-base">
                                      {Number.isFinite(breakdown.total)
                                        ? breakdown.total.toFixed(1)
                                        : "—"}
                                    </span>
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : null;
                        })()}

                        {/* Momentum Elite (Compact) */}
                        {(() => {
                          const mp = ticker?.momentum_pct || {};
                          const adr14 = Number(ticker?.adr_14);
                          const avgVol30 = Number(ticker?.avg_vol_30);
                          const w = mp.week != null ? Number(mp.week) : null;
                          const m = mp.month != null ? Number(mp.month) : null;
                          const m3 = mp.three_months != null ? Number(mp.three_months) : null;
                          const m6 = mp.six_months != null ? Number(mp.six_months) : null;
                          
                          const okAdr = Number.isFinite(adr14) && adr14 >= 2;
                          const okVol = Number.isFinite(avgVol30) && avgVol30 >= 2_000_000;
                          const okW = Number.isFinite(w) && w >= 10;
                          const okM = Number.isFinite(m) && m >= 25;
                          const ok3 = Number.isFinite(m3) && m3 >= 50;
                          const ok6 = Number.isFinite(m6) && m6 >= 100;
                          const okAnyMomentum = okW || okM || ok3 || ok6;
                          const okBase = okAdr && okVol;
                          const computedElite = okBase && okAnyMomentum;
                          const elite = !!flags.momentum_elite || computedElite;
                          
                          if (!elite) return null;
                          
                          return (
                            <div className="border-t border-[#252b36] my-3 pt-3">
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-xs text-[#8b92a0] font-semibold">🚀 Momentum Elite</span>
                                <span className="text-[10px] px-2 py-0.5 rounded border bg-purple-500/20 border-purple-500/40 text-purple-200">
                                  ACTIVE
                                </span>
                              </div>
                              <div className="text-[10px] text-purple-200/70 space-y-0.5">
                                {okAdr && <div>✅ ADR(14D) ≥ $2 • ${adr14.toFixed(2)}</div>}
                                {okVol && <div>✅ Vol(30D) ≥ 2M • {(avgVol30 / 1_000_000).toFixed(2)}M</div>}
                                {okW && <div>✅ 1W momentum {w.toFixed(1)}%</div>}
                                {okM && <div>✅ 1M momentum {m.toFixed(1)}%</div>}
                                {ok3 && <div>✅ 3M momentum {m3.toFixed(1)}%</div>}
                                {ok6 && <div>✅ 6M momentum {m6.toFixed(1)}%</div>}
                              </div>
                            </div>
                          );
                        })()}

                        {/* TP Levels Array (Accordion) */}
                        {(() => {
                          const tpLevels = ticker.tp_levels || [];
                          if (!Array.isArray(tpLevels) || tpLevels.length === 0) return null;
                          
                          // Extract prices from tp_levels (handle both object and number formats)
                          const tpPrices = tpLevels
                            .map((tpItem) => {
                              if (
                                typeof tpItem === "object" &&
                                tpItem !== null &&
                                tpItem.price != null
                              ) {
                                return {
                                  price: Number(tpItem.price),
                                  source: tpItem.source || "ATR Level",
                                  type: tpItem.type || "ATR_FIB",
                                  timeframe: tpItem.timeframe || "D",
                                  label: tpItem.label || "TP",
                                };
                              }
                              return {
                                price:
                                  typeof tpItem === "number"
                                    ? Number(tpItem)
                                    : Number(tpItem),
                                source: "ATR Level",
                                type: "ATR_FIB",
                                timeframe: "D",
                                label: "TP",
                              };
                            })
                            .filter(
                              (p) => Number.isFinite(p.price) && p.price > 0,
                            );

                          if (tpPrices.length === 0) return null;
                          
                          // Sort by price (ascending for LONG, descending for SHORT)
                          const direction = ticker.state?.includes("BULL")
                            ? "LONG"
                            : ticker.state?.includes("BEAR")
                              ? "SHORT"
                              : null;
                          const isLong = direction === "LONG";
                          tpPrices.sort((a, b) =>
                            isLong ? a.price - b.price : b.price - a.price,
                          );

                          return (
                            <div className="border-t border-[#252b36] my-3 pt-3">
                              <button
                                onClick={() => setTpExpanded(!tpExpanded)}
                                className="w-full flex items-center justify-between text-xs text-[#8b92a0] mb-2 font-semibold hover:text-white transition-colors"
                              >
                                <span>TP Levels ({tpPrices.length})</span>
                                <span className="text-base">{tpExpanded ? "▼" : "▶"}</span>
                              </button>
                              {tpExpanded && (
                                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                                  {tpPrices.map((tpItem, idx) => {
                                    const tf = tpItem.timeframe || "D";
                                    const tfLabel =
                                      tf === "W"
                                        ? "W"
                                        : tf === "D"
                                          ? "D"
                                          : tf === "240" || tf === "4H"
                                            ? "4H"
                                            : tf;
                                    return (
                                      <div
                                        key={idx}
                                        className="flex justify-between items-center text-xs bg-[#1a1f28] rounded px-2 py-1.5 border border-[#252b36]/30"
                                      >
                                        <div className="flex items-center gap-2">
                                          <span className="text-green-400 font-semibold">
                                            ${tpItem.price.toFixed(2)}
                                          </span>
                                          <span className="text-[#8b92a0] text-[10px]">
                                            {tpItem.source !== "ATR Level"
                                              ? tpItem.source
                                              : ""}
                                            {tpItem.timeframe
                                              ? ` (${tfLabel})`
                                              : ""}
                                          </span>
                                        </div>
                                        <span className="text-[#8b92a0] text-[10px]">
                                          {tpItem.type !== "ATR_FIB"
                                            ? tpItem.type
                                            : ""}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>

                      {/* Chart */}
                      <div className="mb-4 p-3 bg-[#1a1f28] border-2 border-[#252b36] rounded-lg">
                        <div className="flex items-center justify-between gap-2 mb-3">
                          <div className="text-sm text-[#8b92a0]">Chart</div>
                          <div className="flex items-center gap-1 flex-wrap">
                            {[
                              { tf: "1", label: "1m" },
                              { tf: "3", label: "3m" },
                              { tf: "5", label: "5m" },
                              { tf: "10", label: "10m" },
                              { tf: "30", label: "30m" },
                              { tf: "60", label: "1H" },
                              { tf: "240", label: "4H" },
                              { tf: "D", label: "D" },
                              { tf: "W", label: "W" },
                            ].map((t) => {
                              const active = String(chartTf) === String(t.tf);
                              return (
                                <button
                                  key={`tf-${t.tf}`}
                                  onClick={() => setChartTf(String(t.tf))}
                                  className={`px-2 py-1 rounded border text-[11px] font-semibold transition-all ${
                                    active
                                      ? "border-blue-400 bg-blue-500/20 text-blue-200"
                                      : "border-[#252b36] bg-[#13171e] text-[#8b92a0] hover:text-white"
                                  }`}
                                  title={`Show ${t.label} candles`}
                                >
                                  {t.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {chartLoading ? (
                          <div className="text-xs text-[#8b92a0]">
                            Loading candles…
                          </div>
                        ) : chartError ? (
                          <div className="text-xs text-yellow-300">
                            Failed to load candles: {chartError}
                          </div>
                        ) : !Array.isArray(chartCandles) ||
                          chartCandles.length < 2 ? (
                          <div className="text-xs text-[#8b92a0]">
                            No candles yet for this timeframe.
                          </div>
                        ) : (
                          (() => {
                            try {
                              const toMs = (v) => {
                                if (v == null) return NaN;
                                if (typeof v === "number") {
                                  return v > 1e12 ? v : v * 1000;
                                }
                                const n = Number(v);
                                if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
                                const d = new Date(String(v));
                                const ms = d.getTime();
                                return Number.isFinite(ms) ? ms : NaN;
                              };

                              const norm = (c) => {
                                const tsRaw = c?.ts ?? c?.t ?? c?.time ?? c?.timestamp;
                                const tsMs = toMs(tsRaw);
                                const o = Number(c?.o ?? c?.open);
                                const h = Number(c?.h ?? c?.high);
                                const l = Number(c?.l ?? c?.low);
                                const cl = Number(c?.c ?? c?.close);
                                if (
                                  !Number.isFinite(tsMs) ||
                                  !Number.isFinite(o) ||
                                  !Number.isFinite(h) ||
                                  !Number.isFinite(l) ||
                                  !Number.isFinite(cl)
                                )
                                  return null;
                                return { ...c, ts: tsMs, __ts_ms: tsMs, o, h, l, c: cl };
                              };

                              let candles = (Array.isArray(chartCandles) ? chartCandles : [])
                                .slice(-400)
                                .map(norm)
                                .filter(Boolean);

                              candles.sort((a, b) => Number(a.__ts_ms) - Number(b.__ts_ms));

                              const weekStartUtcMs = (tsMs) => {
                                const d0 = new Date(Number(tsMs));
                                const day = d0.getUTCDay();
                                const daysSinceMon = (day + 6) % 7;
                                const d = new Date(
                                  d0.getTime() - daysSinceMon * 24 * 60 * 60 * 1000,
                                );
                                d.setUTCHours(0, 0, 0, 0);
                                return d.getTime();
                              };

                              if (String(chartTf) === "W") {
                                const byWeek = new Map();
                                for (const c of candles) {
                                  const wk = weekStartUtcMs(c.__ts_ms);
                                  const prev = byWeek.get(wk);
                                  if (!prev) {
                                    byWeek.set(wk, {
                                      ts: wk,
                                      __ts_ms: wk,
                                      o: Number(c.o),
                                      h: Number(c.h),
                                      l: Number(c.l),
                                      c: Number(c.c),
                                      _last_ts: Number(c.__ts_ms),
                                    });
                                  } else {
                                    prev.h = Math.max(Number(prev.h), Number(c.h));
                                    prev.l = Math.min(Number(prev.l), Number(c.l));
                                    if (Number(c.__ts_ms) >= Number(prev._last_ts)) {
                                      prev.c = Number(c.c);
                                      prev._last_ts = Number(c.__ts_ms);
                                    }
                                  }
                                }
                                candles = Array.from(byWeek.values())
                                  .sort((a, b) => Number(a.__ts_ms) - Number(b.__ts_ms))
                                  .map((c) => {
                                    const out = { ...c };
                                    delete out._last_ts;
                                    return out;
                                  });
                              } else {
                                const byTs = new Map();
                                for (const c of candles) byTs.set(Number(c.__ts_ms), c);
                                candles = Array.from(byTs.values()).sort(
                                  (a, b) => Number(a.__ts_ms) - Number(b.__ts_ms),
                                );
                              }

                              const n = candles.length;
                              if (n < 2) {
                                return (
                                  <div className="text-xs text-[#8b92a0]">
                                    Candle data loaded, but not in expected format.
                                  </div>
                                );
                              }

                              const lows = candles.map((c) => Number(c.l));
                              const highs = candles.map((c) => Number(c.h));
                              let minL = Math.min(...lows);
                              let maxH = Math.max(...highs);
                              if (!Number.isFinite(minL) || !Number.isFinite(maxH))
                                throw new Error("invalid_minmax");
                              if (maxH <= minL) {
                                maxH = minL + 1;
                              }
                              const pad = (maxH - minL) * 0.05;
                              minL -= pad;
                              maxH += pad;

                            const H = 280;
                            const leftMargin = 10;
                            const rightMargin = 70;
                            const candleW = 8;
                            const candleGap = 2;
                            const candleStep = candleW + candleGap;
                            const plotW = n * candleStep;
                            const W = plotW + leftMargin + rightMargin;
                            const plotH = H;
                            const y = (p) =>
                              plotH - ((p - minL) / (maxH - minL)) * plotH;
                            const bodyW = candleW * 0.9;

                            const priceStep = (maxH - minL) / 5;
                            const priceTicks = [];
                            for (let i = 0; i <= 5; i++) {
                              priceTicks.push(minL + priceStep * i);
                            }

                              const handleMouseMove = (e) => {
                                const svg = e.currentTarget;
                                const rect = svg.getBoundingClientRect();
                                if (!rect || rect.width <= 0 || rect.height <= 0) return;
                                
                                const pt = svg.createSVGPoint();
                                pt.x = e.clientX;
                                pt.y = e.clientY;
                                const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());
                                const svgX = svgP.x;
                                const svgY = svgP.y;
                                
                                if (svgX < leftMargin || svgX > W - rightMargin) return;
                                const idx = Math.floor(((svgX - leftMargin) / plotW) * n);
                                if (idx >= 0 && idx < n) {
                                  const c = candles[idx];
                                  if (!c) return;
                                  const price =
                                    minL + ((H - svgY) / plotH) * (maxH - minL);
                                  setCrosshair({ x: svgX, y: svgY, candle: c, price });
                                }
                              };

                            return (
                              <div className="w-full relative -mx-3 px-3">
                                <div
                                  ref={chartScrollRef}
                                  className="overflow-x-auto overflow-y-hidden bg-[#0c0f14]"
                                  style={{
                                    scrollbarWidth: "thin",
                                    scrollbarColor: "#252b36 #0c0f14",
                                    WebkitOverflowScrolling: "touch"
                                  }}
                                >
                                  <svg
                                    width={W}
                                    height={H}
                                    viewBox={`0 0 ${W} ${H}`}
                                    style={{ display: "block" }}
                                    className="cursor-crosshair"
                                    onMouseMove={handleMouseMove}
                                    onMouseLeave={() => setCrosshair(null)}
                                  >
                                  {priceTicks.map((p, i) => {
                                    const yPos = y(p);
                                    return (
                                      <g key={`grid-${i}`}>
                                        <line
                                          x1={leftMargin}
                                          y1={yPos}
                                          x2={W - rightMargin}
                                          y2={yPos}
                                          stroke="rgba(38,50,95,0.5)"
                                          strokeWidth="1"
                                        />
                                        <text
                                          x={W - rightMargin + 6}
                                          y={yPos + 4}
                                          fontSize="11"
                                          fill="#8b92a0"
                                          fontFamily="monospace"
                                        >
                                          ${p.toFixed(2)}
                                        </text>
                                      </g>
                                    );
                                  })}

                                  {candles.map((c, i) => {
                                    const o = Number(c.o);
                                    const h = Number(c.h);
                                    const l = Number(c.l);
                                    const cl = Number(c.c);
                                    const up = cl >= o;
                                    const stroke = up
                                      ? "rgba(56,189,248,0.95)"
                                      : "rgba(251,146,60,0.95)";
                                    const fill = up
                                      ? "rgba(56,189,248,0.90)"
                                      : "rgba(251,146,60,0.90)";

                                    const cx = leftMargin + i * candleStep + candleStep / 2;
                                    const yH = y(h);
                                    const yL = y(l);
                                    const yO = y(o);
                                    const yC = y(cl);
                                    const top = Math.min(yO, yC);
                                    const bot = Math.max(yO, yC);
                                    const bodyH = Math.max(1.5, bot - top);

                                    return (
                                      <g key={`c-${Number(c.ts)}-${i}`}>
                                        <line
                                          x1={cx}
                                          y1={yH}
                                          x2={cx}
                                          y2={yL}
                                          stroke={stroke}
                                          strokeWidth="1.2"
                                        />
                                        <rect
                                          x={cx - bodyW / 2}
                                          y={top}
                                          width={bodyW}
                                          height={bodyH}
                                          fill={fill}
                                          stroke="none"
                                          rx="0.5"
                                        />
                                      </g>
                                    );
                                  })}

                                  {crosshair ? (
                                    <>
                                      <line
                                        x1={leftMargin}
                                        y1={crosshair.y}
                                        x2={W - rightMargin}
                                        y2={crosshair.y}
                                        stroke="rgba(147,164,214,0.5)"
                                        strokeWidth="1"
                                        strokeDasharray="4 4"
                                      />
                                      <line
                                        x1={crosshair.x}
                                        y1={0}
                                        x2={crosshair.x}
                                        y2={H}
                                        stroke="rgba(147,164,214,0.5)"
                                        strokeWidth="1"
                                        strokeDasharray="4 4"
                                      />
                                      {(() => {
                                        const yLabel = Math.max(
                                          10,
                                          Math.min(H - 10, Number(crosshair.y)),
                                        );
                                        const price = Number(crosshair.price);
                                        const priceText = Number.isFinite(price)
                                          ? `$${price.toFixed(2)}`
                                          : "—";
                                        return (
                                          <g>
                                            <rect
                                              x={W - rightMargin + 2}
                                              y={yLabel - 10}
                                              width={rightMargin - 4}
                                              height={20}
                                              fill="rgba(18,26,51,0.92)"
                                              stroke="rgba(38,50,95,0.9)"
                                              strokeWidth="1"
                                              rx="4"
                                            />
                                            <text
                                              x={W - rightMargin + (rightMargin - 4) / 2}
                                              y={yLabel + 4}
                                              fontSize="11"
                                              fill="#fbbf24"
                                              fontFamily="monospace"
                                              fontWeight="700"
                                              textAnchor="middle"
                                            >
                                              {priceText}
                                            </text>
                                          </g>
                                        );
                                      })()}
                                    </>
                                  ) : null}
                                  </svg>
                                </div>

                                {crosshair && crosshair.candle ? (
                                  <div
                                    className="absolute top-2 left-2 px-3 py-2 bg-[#13171e]/95 border border-[#252b36] rounded-lg text-[11px] pointer-events-none z-10"
                                    style={{
                                      backdropFilter: "blur(8px)",
                                      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                                    }}
                                  >
                                    <div className="font-semibold text-white mb-1">
                                      {(() => {
                                        try {
                                          const ts = Number(
                                            crosshair?.candle?.__ts_ms ??
                                              crosshair?.candle?.ts,
                                          );
                                          if (!Number.isFinite(ts)) return "—";
                                          const d = new Date(ts);
                                          return d.toLocaleString("en-US", {
                                            month: "short",
                                            day: "numeric",
                                            hour: "numeric",
                                            minute: "2-digit",
                                          });
                                        } catch {
                                          return "—";
                                        }
                                      })()}
                                    </div>
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                                      <div className="text-[#8b92a0]">O:</div>
                                      <div className="text-white font-mono">
                                        ${Number(crosshair.candle.o).toFixed(2)}
                                      </div>
                                      <div className="text-[#8b92a0]">H:</div>
                                      <div className="text-sky-300 font-mono">
                                        ${Number(crosshair.candle.h).toFixed(2)}
                                      </div>
                                      <div className="text-[#8b92a0]">L:</div>
                                      <div className="text-orange-300 font-mono">
                                        ${Number(crosshair.candle.l).toFixed(2)}
                                      </div>
                                      <div className="text-[#8b92a0]">C:</div>
                                      <div
                                        className={`font-mono font-semibold ${
                                          Number(crosshair.candle.c) >=
                                          Number(crosshair.candle.o)
                                            ? "text-sky-300"
                                            : "text-orange-300"
                                        }`}
                                      >
                                        ${Number(crosshair.candle.c).toFixed(2)}
                                      </div>
                                    </div>
                                  </div>
                                ) : null}

                                <div className="mt-2 text-[10px] text-[#8b92a0] flex items-center justify-between">
                                  <span>
                                    {String(chartTf) === "D"
                                      ? "Daily"
                                      : String(chartTf) === "W"
                                        ? "Weekly"
                                        : `${chartTf}m`}{" "}
                                    • {candles.length} bars
                                  </span>
                                  <span className="font-mono">
                                    ${minL.toFixed(2)} – ${maxH.toFixed(2)}
                                  </span>
                                </div>
                              </div>
                            );
                            } catch (e) {
                              console.error("[RightRail Chart] render failed:", e);
                              return (
                                <div className="text-xs text-yellow-300">
                                  Chart render error. Check console for details.
                                </div>
                              );
                            }
                          })()
                        )}
                      </div>
                    </>
                  ) : null}

                  {railTab === "TECHNICALS" ? (
                    <>
                      {/* Triggers */}
                      <div className="mt-6 pt-6 border-t-2 border-[#252b36]">
                        <div className="text-sm font-bold text-[#8b92a0] mb-4">
                          ⚡ Triggers
                        </div>
                        <div className="p-3 bg-[#1a1f28] rounded-lg border border-[#252b36]">
                          {triggerItems.length > 0 ? (
                            <div className="space-y-2">
                              {triggerItems.slice(0, 12).map((t, idx) => {
                                const translateTrigger = (raw) => {
                                  const s = String(raw || "").trim();
                                  const translations = {
                                    'SQUEEZE_RELEASE_30M': 'Consolidation breakout (30min)',
                                    'ST_FLIP_30M': 'Momentum flip detected (30min)',
                                    'ST_FLIP_1H': 'Momentum flip detected (1hr)',
                                    'EMA_CROSS_1H_13_48': 'Moving average crossover (1hr)',
                                    'BUYABLE_DIP_1H_13_48': 'Pullback entry opportunity (1hr)',
                                    'EMA_CROSS_30M_13_48': 'Moving average crossover (30min)'
                                  };
                                  
                                  // Check for exact match first
                                  if (translations[s]) return translations[s];
                                  
                                  // Pattern matching for complex triggers
                                  if (s.includes('EMA_CROSS') && s.includes('BULL')) {
                                    return s.replace(/EMA_CROSS_(\w+)_\d+_\d+.*BULL.*/i, 'Bullish moving average cross ($1)');
                                  }
                                  if (s.includes('EMA_CROSS') && s.includes('BEAR')) {
                                    return s.replace(/EMA_CROSS_(\w+)_\d+_\d+.*BEAR.*/i, 'Bearish moving average cross ($1)');
                                  }
                                  if (s.includes('SQUEEZE_RELEASE')) {
                                    return 'Consolidation breakout';
                                  }
                                  if (s.includes('ST_FLIP')) {
                                    return 'Momentum flip detected';
                                  }
                                  
                                  // Keep unconfirmed warning
                                  if (s.includes('⚠️')) {
                                    const base = s.replace('⚠️ unconfirmed', '').trim();
                                    return `${translateTrigger(base)} (unconfirmed)`;
                                  }
                                  
                                  // Fallback: make it readable
                                  return s.replace(/_/g, ' ').toLowerCase();
                                };
                                
                                return (
                                  <div
                                    key={idx}
                                    className="flex items-start gap-2 text-xs"
                                  >
                                    <span className="text-cyan-400 mt-0.5">•</span>
                                    <span className="text-[#f0f2f5] flex-1">{translateTrigger(t)}</span>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="text-xs text-[#8b92a0]">
                              No trigger signals detected.
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Timeframes (Per-TF technicals) */}
                      <div className="mt-6 pt-6 border-t-2 border-[#252b36]">
                        <div className="text-sm font-bold text-[#8b92a0] mb-4">
                          ⏱ Timeframes
                        </div>
                        <div className="p-3 bg-[#1a1f28] rounded-lg border border-[#252b36]">
                          {tfTech ? (
                            <div className="space-y-3">
                              {tfOrder.map(({ k, label }) => {
                                const row = tfTech[k] || null;
                                const atr = row && row.atr ? row.atr : null;
                                const ema = row && row.ema ? row.ema : null;
                                const ph = row && row.ph ? row.ph : null;
                                const sq = row && row.sq ? row.sq : null;
                                const rsi = row && row.rsi ? row.rsi : null;

                                const vis =
                                  ema && Number.isFinite(Number(ema.vis))
                                    ? Number(ema.vis)
                                    : 0;
                                const sig =
                                  ema && Number.isFinite(Number(ema.sig))
                                    ? Number(ema.sig)
                                    : 0;
                                const sigLabel =
                                  sig === 1
                                    ? "Bullish"
                                    : sig === -1
                                      ? "Bearish"
                                      : "Neutral";

                                const sqIcons =
                                  (sq && sq.c ? "🗜️" : "") +
                                  (sq && sq.s ? "🧨" : "") +
                                  (sq && sq.r ? "⚡️" : "");

                                const atrBand = (() => {
                                  if (!atr) return null;
                                  const side = Number(atr.s) === -1 ? "-" : "+";
                                  const lo =
                                    atr.lo != null ? String(atr.lo) : null;
                                  const hi =
                                    atr.hi != null ? String(atr.hi) : null;
                                  if (!lo) return null;
                                  return hi
                                    ? `${side}${lo}–${hi}`
                                    : `${side}${lo}+`;
                                })();

                                const atrLastCross = (() => {
                                  if (!atr || atr.x == null) return null;
                                  const dir =
                                    atr.xd === "dn"
                                      ? "↓"
                                      : atr.xd === "up"
                                        ? "↑"
                                        : "";
                                  const side =
                                    Number(atr.xs) === -1 ? "-" : "+";
                                  return dir ? `${dir} ${side}${atr.x}` : null;
                                })();

                                return (
                                  <div
                                    key={k}
                                    className="bg-[#13171e] border border-[#252b36] rounded-lg p-3"
                                  >
                                    <div className="flex items-center justify-between mb-2">
                                      <div className="text-sm font-semibold text-white">
                                        {label}
                                      </div>
                                      <div className="text-xs text-[#8b92a0] flex items-center gap-2">
                                        <span>{sqIcons}</span>
                                        <span
                                          className={`font-semibold ${
                                            sig === 1
                                              ? "text-green-400"
                                              : sig === -1
                                                ? "text-red-400"
                                                : "text-[#8b92a0]"
                                          }`}
                                        >
                                          {sigLabel}
                                        </span>
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-3">
                                      <div>
                                        <div className="text-[11px] text-[#8b92a0] mb-1">
                                          ATR band / last cross
                                        </div>
                                        <div className="text-xs text-white">
                                          {atrBand ? (
                                            <>
                                              <span className="font-semibold">
                                                {atrBand}
                                              </span>
                                              {atrLastCross ? (
                                                <span className="ml-2 text-[#8b92a0]">
                                                  {atrLastCross}
                                                </span>
                                              ) : null}
                                            </>
                                          ) : (
                                            <span className="text-[#8b92a0]">
                                              —
                                            </span>
                                          )}
                                        </div>
                                      </div>

                                      <div>
                                        <div className="text-[11px] text-[#8b92a0] mb-1">
                                          EMA visibility / stack
                                        </div>
                                        <div className="flex flex-wrap gap-1 items-center">
                                          {emaLevels.map((n, idx) => {
                                            const on = (vis & (1 << idx)) !== 0;
                                            return (
                                              <span
                                                key={n}
                                                className={`px-1.5 py-0.5 rounded text-[10px] border ${
                                                  on
                                                    ? "bg-green-500/15 border-green-500/30 text-green-300"
                                                    : "bg-red-500/10 border-red-500/30 text-red-300"
                                                }`}
                                                title={`Price ${on ? "≥" : "<"} EMA${n}`}
                                              >
                                                {n}
                                              </span>
                                            );
                                          })}
                                          {ema && ema.stack != null && (
                                            <span className="ml-2 text-[10px] text-[#8b92a0]">
                                              stack:{" "}
                                              <span className="text-white font-semibold">
                                                {ema.stack}
                                              </span>
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-3 mt-3">
                                      <div>
                                        <div className="text-[11px] text-[#8b92a0] mb-1">
                                          Phase Level
                                        </div>
                                        <div className="text-xs text-white font-semibold">
                                          {ph && ph.v != null ? ph.v : "—"}
                                        </div>
                                        <div className="mt-1.5">
                                          <div className="text-[10px] text-[#8b92a0]">
                                            Last 5 dots (recent first):
                                          </div>
                                          <div className="text-xs text-[#cbd5ff] mt-0.5">
                                            {(() => {
                                              const dots = (ph && Array.isArray(ph.dots) ? ph.dots : []).slice(0, 5);
                                              if (dots.length === 0) return "—";
                                              
                                              const dotLabels = dots.map((code) => {
                                                switch (code) {
                                                  case "P100": return "+100";
                                                  case "P618": return "+61.8";
                                                  case "N618": return "-61.8";
                                                  case "N100": return "-100";
                                                  default: return code || "";
                                                }
                                              }).filter(Boolean);
                                              
                                              return dotLabels.join(", ");
                                            })()}
                                          </div>
                                        </div>
                                      </div>
                                      <div>
                                        <div className="text-[11px] text-[#8b92a0] mb-1">
                                          Divergence
                                        </div>
                                        <div className="text-base">
                                          {(() => {
                                            const divs = (ph && Array.isArray(ph.div) ? ph.div : []).slice(0, 3);
                                            if (divs.length === 0) return <span className="text-xs text-[#8b92a0]">None</span>;
                                            
                                            const mostRecent = divs[0];
                                            const emoji = mostRecent === "B" ? "🐂" : mostRecent === "S" ? "🐻" : "";
                                            const label = mostRecent === "B" ? "Bullish" : mostRecent === "S" ? "Bearish" : "";
                                            const color = mostRecent === "B" ? "text-green-400" : "text-red-400";
                                            
                                            return (
                                              <div className={`font-semibold ${color}`}>
                                                {emoji} {label}
                                              </div>
                                            );
                                          })()}
                                        </div>
                                      </div>
                                      <div>
                                        <div className="text-[11px] text-[#8b92a0] mb-1">
                                          RSI(5/14) / div
                                        </div>
                                        <div className="text-xs text-white">
                                          <span className="font-semibold">
                                            {rsi && rsi.r5 != null
                                              ? rsi.r5
                                              : "—"}
                                          </span>
                                          <span className="text-[#8b92a0]">
                                            {" "}
                                            /{" "}
                                          </span>
                                          <span className="font-semibold">
                                            {rsi && rsi.r14 != null
                                              ? rsi.r14
                                              : "—"}
                                          </span>
                                          <span className="ml-2">
                                            {(rsi && Array.isArray(rsi.div)
                                              ? rsi.div
                                              : []
                                            )
                                              .slice(0, 2)
                                              .map(divIcon)
                                              .filter(Boolean)
                                              .join(" ")}
                                          </span>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="text-xs text-[#8b92a0]">
                              No per-timeframe technicals available yet (update
                              TradingView script + refresh data).
                            </div>
                          )}
                        </div>
                      </div>

                      {ticker.td_sequential &&
                        (() => {
                          const tdSeq = ticker.td_sequential;
                          return (
                            <div className="mt-6 pt-6 border-t-2 border-[#252b36]">
                              <div className="text-sm font-bold text-[#8b92a0] mb-4">
                                📈 TD Sequential
                              </div>

                              {/* Counts */}
                              <div className="mb-4 p-3 bg-[#1a1f28] rounded-lg border border-[#252b36]">
                                <div className="text-xs text-[#8b92a0] mb-2">
                                  Counts
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-xs">
                                  <div className="flex justify-between">
                                    <span className="text-[#8b92a0]">
                                      Bullish Prep:
                                    </span>
                                    <span
                                      className={`font-semibold ${
                                        Number(tdSeq.bullish_prep_count || 0) >=
                                        6
                                          ? "text-yellow-400"
                                          : Number(
                                                tdSeq.bullish_prep_count || 0,
                                              ) >= 3
                                            ? "text-green-400"
                                            : "text-[#8b92a0]"
                                      }`}
                                    >
                                      {tdSeq.bullish_prep_count || 0}/9
                                    </span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-[#8b92a0]">
                                      Bearish Prep:
                                    </span>
                                    <span
                                      className={`font-semibold ${
                                        Number(tdSeq.bearish_prep_count || 0) >=
                                        6
                                          ? "text-yellow-400"
                                          : Number(
                                                tdSeq.bearish_prep_count || 0,
                                              ) >= 3
                                            ? "text-red-400"
                                            : "text-[#8b92a0]"
                                      }`}
                                    >
                                      {tdSeq.bearish_prep_count || 0}/9
                                    </span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-[#8b92a0]">
                                      Bullish Leadup:
                                    </span>
                                    <span
                                      className={`font-semibold ${
                                        Number(
                                          tdSeq.bullish_leadup_count || 0,
                                        ) >= 6
                                          ? "text-yellow-400"
                                          : Number(
                                                tdSeq.bullish_leadup_count || 0,
                                              ) >= 3
                                            ? "text-green-400"
                                            : "text-[#8b92a0]"
                                      }`}
                                    >
                                      {tdSeq.bullish_leadup_count || 0}/13
                                    </span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-[#8b92a0]">
                                      Bearish Leadup:
                                    </span>
                                    <span
                                      className={`font-semibold ${
                                        Number(
                                          tdSeq.bearish_leadup_count || 0,
                                        ) >= 6
                                          ? "text-yellow-400"
                                          : Number(
                                                tdSeq.bearish_leadup_count || 0,
                                              ) >= 3
                                            ? "text-red-400"
                                            : "text-[#8b92a0]"
                                      }`}
                                    >
                                      {tdSeq.bearish_leadup_count || 0}/13
                                    </span>
                                  </div>
                                </div>
                              </div>

                              {/* Signals */}
                              <div className="mb-4 p-3 bg-[#1a1f28] rounded-lg border border-[#252b36]">
                                <div className="text-xs text-[#8b92a0] mb-2">
                                  Signals
                                </div>
                                <div className="space-y-2">
                                  {(tdSeq.td9_bullish === true ||
                                    tdSeq.td9_bullish === "true") && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-green-400 font-bold">
                                        TD9
                                      </span>
                                      <span className="text-xs text-[#8b92a0]">
                                        Bullish (Prep Complete)
                                      </span>
                                    </div>
                                  )}
                                  {(tdSeq.td9_bearish === true ||
                                    tdSeq.td9_bearish === "true") && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-red-400 font-bold">
                                        TD9
                                      </span>
                                      <span className="text-xs text-[#8b92a0]">
                                        Bearish (Prep Complete)
                                      </span>
                                    </div>
                                  )}
                                  {(tdSeq.td13_bullish === true ||
                                    tdSeq.td13_bullish === "true") && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-green-400 font-bold">
                                        TD13
                                      </span>
                                      <span className="text-xs text-[#8b92a0]">
                                        Bullish (Leadup Complete)
                                      </span>
                                    </div>
                                  )}
                                  {(tdSeq.td13_bearish === true ||
                                    tdSeq.td13_bearish === "true") && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-red-400 font-bold">
                                        TD13
                                      </span>
                                      <span className="text-xs text-[#8b92a0]">
                                        Bearish (Leadup Complete)
                                      </span>
                                    </div>
                                  )}
                                  {!tdSeq.td9_bullish &&
                                    !tdSeq.td9_bearish &&
                                    !tdSeq.td13_bullish &&
                                    !tdSeq.td13_bearish && (
                                      <div className="text-xs text-[#8b92a0]">
                                        No TD9/TD13 signals active
                                      </div>
                                    )}
                                </div>
                              </div>

                              {/* Exit Signals */}
                              {(tdSeq.exit_long === true ||
                                tdSeq.exit_long === "true" ||
                                tdSeq.exit_short === true ||
                                tdSeq.exit_short === "true") && (
                                <div
                                  className={`mb-4 p-3 rounded-lg border-2 ${
                                    tdSeq.exit_long === true ||
                                    tdSeq.exit_long === "true"
                                      ? "bg-red-500/20 border-red-500/50"
                                      : "bg-red-500/20 border-red-500/50"
                                  }`}
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs text-[#8b92a0]">
                                      Exit Signal
                                    </span>
                                    <span className="font-bold text-sm text-red-400">
                                      {tdSeq.exit_long === true ||
                                      tdSeq.exit_long === "true"
                                        ? "EXIT LONG"
                                        : "EXIT SHORT"}
                                    </span>
                                  </div>
                                  <div className="text-xs text-[#8b92a0] mt-1">
                                    TD Sequential exhaustion/reversal detected
                                  </div>
                                </div>
                              )}

                              {/* Boost */}
                              {tdSeq.boost !== undefined &&
                                tdSeq.boost !== null &&
                                Number(tdSeq.boost) !== 0 && (
                                  <div className="mb-4 p-3 bg-[#1a1f28] rounded-lg border border-[#252b36]">
                                    <div className="flex justify-between items-center">
                                      <span className="text-xs text-[#8b92a0]">
                                        Score Boost
                                      </span>
                                      <span
                                        className={`font-semibold ${
                                          Number(tdSeq.boost) > 0
                                            ? "text-green-400"
                                            : "text-red-400"
                                        }`}
                                      >
                                        {Number(tdSeq.boost) > 0 ? "+" : ""}
                                        {Number(tdSeq.boost).toFixed(1)}
                                      </span>
                                    </div>
                                  </div>
                                )}
                            </div>
                          );
                        })()}

                      {/* RSI & Divergence */}
                      {ticker.rsi &&
                        (() => {
                          const rsi = ticker.rsi;
                          const rsiValue = Number(rsi.value || 0);
                          const rsiLevel = rsi.level || "neutral";
                          const divergence = rsi.divergence || {};
                          const divType = divergence.type || "none";
                          const divStrength = Number(divergence.strength || 0);

                          const rsiColor =
                            rsiValue >= 70
                              ? "text-red-400"
                              : rsiValue <= 30
                                ? "text-green-400"
                                : rsiValue >= 50
                                  ? "text-yellow-400"
                                  : "text-blue-400";
                          const levelColor =
                            rsiLevel === "overbought"
                              ? "text-red-400"
                              : rsiLevel === "oversold"
                                ? "text-green-400"
                                : rsiLevel === "bullish"
                                  ? "text-yellow-400"
                                  : "text-blue-400";

                          return (
                            <div className="mt-6 pt-6 border-t-2 border-[#252b36]">
                              <div className="text-sm font-bold text-[#8b92a0] mb-4">
                                📊 RSI & Divergence
                              </div>

                              {/* RSI Value */}
                              <div className="mb-4 p-3 bg-[#1a1f28] rounded-lg border border-[#252b36]">
                                <div className="flex justify-between items-center mb-2">
                                  <span className="text-xs text-[#8b92a0]">
                                    RSI (14)
                                  </span>
                                  <span
                                    className={`font-bold text-lg ${rsiColor}`}
                                  >
                                    {rsiValue.toFixed(2)}
                                  </span>
                                </div>
                                <div className="flex justify-between items-center">
                                  <span className="text-xs text-[#8b92a0]">
                                    Level
                                  </span>
                                  <span
                                    className={`text-xs font-semibold ${levelColor}`}
                                  >
                                    {rsiLevel.charAt(0).toUpperCase() +
                                      rsiLevel.slice(1)}
                                  </span>
                                </div>
                                {/* RSI Visual Bar */}
                                <div className="mt-2 h-2 bg-[#252b36] rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full transition-all ${
                                      rsiValue >= 70
                                        ? "bg-red-500"
                                        : rsiValue <= 30
                                          ? "bg-green-500"
                                          : rsiValue >= 50
                                            ? "bg-yellow-500"
                                            : "bg-blue-500"
                                    }`}
                                    style={{ width: `${rsiValue}%` }}
                                  />
                                </div>
                                <div className="flex justify-between text-[10px] text-[#8b92a0] mt-1">
                                  <span>0</span>
                                  <span>30</span>
                                  <span>50</span>
                                  <span>70</span>
                                  <span>100</span>
                                </div>
                              </div>

                              {/* Divergence */}
                              {divType !== "none" && (
                                <div
                                  className={`mb-4 p-3 rounded-lg border-2 ${
                                    divType === "bullish"
                                      ? "bg-green-500/20 border-green-500/50"
                                      : "bg-red-500/20 border-red-500/50"
                                  }`}
                                >
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs text-[#8b92a0]">
                                      Divergence
                                    </span>
                                    <span
                                      className={`font-bold text-sm ${
                                        divType === "bullish"
                                          ? "text-green-400"
                                          : "text-red-400"
                                      }`}
                                    >
                                      {divType === "bullish"
                                        ? "🔼 BULLISH"
                                        : "🔽 BEARISH"}
                                    </span>
                                  </div>
                                  <div className="text-xs text-[#8b92a0]">
                                    {divType === "bullish"
                                      ? "Price lower low, RSI higher low (potential reversal up)"
                                      : "Price higher high, RSI lower high (potential reversal down)"}
                                  </div>
                                  {divStrength > 0 && (
                                    <div className="text-xs text-[#8b92a0] mt-1">
                                      Strength: {divStrength.toFixed(2)}
                                    </div>
                                  )}
                                </div>
                              )}
                              {divType === "none" && (
                                <div className="mb-4 p-3 bg-[#1a1f28] rounded-lg border border-[#252b36]">
                                  <div className="text-xs text-[#8b92a0]">
                                    No divergence detected
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                      {/* State, Horizon, Detected Patterns */}
                      <div className="mb-4 p-3 bg-[#1a1f28] border-2 border-[#252b36] rounded-lg">
                        <div className="text-sm text-[#8b92a0] mb-2">
                          State & Horizon
                        </div>
                        <div className="space-y-2 text-xs">
                          <div className="flex justify-between items-center">
                            <span className="text-[#8b92a0]">State</span>
                            <span className="font-semibold">
                              {ticker.state || "—"}
                            </span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-[#8b92a0]">Horizon</span>
                            <span className="font-semibold">
                              {(() => {
                                const bucket = String(
                                  ticker.horizon_bucket || "",
                                )
                                  .trim()
                                  .toUpperCase();
                                if (bucket) return bucket.replace("_", " ");
                                const eta = computeEtaDays(ticker);
                                if (!Number.isFinite(eta)) return "—";
                                if (eta <= 7) return "SHORT TERM";
                                if (eta <= 30) return "SWING";
                                return "POSITIONAL";
                              })()}
                            </span>
                          </div>
                        </div>
                        {detectedPatterns && detectedPatterns.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-[#252b36]">
                            <div className="text-xs font-semibold text-yellow-400 mb-2">
                              Detected Patterns
                            </div>
                            <div className="space-y-2">
                              {detectedPatterns.map((pattern, idx) => (
                                <div
                                  key={`pattern-${idx}`}
                                  className="p-2 rounded border bg-[#13171e] border-[#252b36]"
                                >
                                  <div className="flex items-center justify-between">
                                    <div className="text-xs text-white font-semibold">
                                      {pattern.description}
                                    </div>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300">
                                      {pattern.confidence}
                                    </span>
                                  </div>
                                  {pattern.quadrant && (
                                    <div className="text-[10px] text-[#8b92a0] mt-0.5">
                                      {pattern.quadrant}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* EMA Cloud Positions */}
                      {(ticker.daily_ema_cloud ||
                        ticker.fourh_ema_cloud ||
                        ticker.oneh_ema_cloud) &&
                        (() => {
                          const daily = ticker.daily_ema_cloud;
                          const fourH = ticker.fourh_ema_cloud;
                          const oneH = ticker.oneh_ema_cloud;

                          const getPositionColor = (position) => {
                            if (position === "above") return "text-green-400";
                            if (position === "below") return "text-red-400";
                            return "text-yellow-400";
                          };

                          const getPositionEmoji = (position) => {
                            if (position === "above") return "🔼";
                            if (position === "below") return "🔽";
                            return "➡️";
                          };

                          return (
                            <div className="mt-6 pt-6 border-t-2 border-[#252b36]">
                              <div className="text-sm font-bold text-[#8b92a0] mb-4">
                                ☁️ EMA Cloud Positions
                              </div>

                              {daily && (
                                <div className="mb-3 p-3 bg-[#1a1f28] rounded-lg border border-[#252b36]">
                                  <div className="text-xs text-[#8b92a0] mb-2 font-semibold">
                                    Daily (5-8 EMA)
                                  </div>
                                  <div className="flex justify-between items-center mb-1">
                                    <span className="text-xs text-[#8b92a0]">
                                      Position
                                    </span>
                                    <span
                                      className={`text-xs font-semibold ${getPositionColor(
                                        daily.position,
                                      )}`}
                                    >
                                      {getPositionEmoji(daily.position)}{" "}
                                      {daily.position.toUpperCase()}
                                    </span>
                                  </div>
                                  <div className="grid grid-cols-2 gap-2 text-xs mt-2">
                                    <div className="flex justify-between">
                                      <span className="text-[#8b92a0]">
                                        Upper:
                                      </span>
                                      <span className="text-white">
                                        ${Number(daily.upper).toFixed(2)}
                                      </span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-[#8b92a0]">
                                        Lower:
                                      </span>
                                      <span className="text-white">
                                        ${Number(daily.lower).toFixed(2)}
                                      </span>
                                    </div>
                                    <div className="flex justify-between col-span-2">
                                      <span className="text-[#8b92a0]">
                                        Price:
                                      </span>
                                      <span className="text-white font-semibold">
                                        ${Number(daily.price).toFixed(2)}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              )}

                              {fourH && (
                                <div className="mb-3 p-3 bg-[#1a1f28] rounded-lg border border-[#252b36]">
                                  <div className="text-xs text-[#8b92a0] mb-2 font-semibold">
                                    4H (8-13 EMA)
                                  </div>
                                  <div className="flex justify-between items-center mb-1">
                                    <span className="text-xs text-[#8b92a0]">
                                      Position
                                    </span>
                                    <span
                                      className={`text-xs font-semibold ${getPositionColor(
                                        fourH.position,
                                      )}`}
                                    >
                                      {getPositionEmoji(fourH.position)}{" "}
                                      {fourH.position.toUpperCase()}
                                    </span>
                                  </div>
                                  <div className="grid grid-cols-2 gap-2 text-xs mt-2">
                                    <div className="flex justify-between">
                                      <span className="text-[#8b92a0]">
                                        Upper:
                                      </span>
                                      <span className="text-white">
                                        ${Number(fourH.upper).toFixed(2)}
                                      </span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-[#8b92a0]">
                                        Lower:
                                      </span>
                                      <span className="text-white">
                                        ${Number(fourH.lower).toFixed(2)}
                                      </span>
                                    </div>
                                    <div className="flex justify-between col-span-2">
                                      <span className="text-[#8b92a0]">
                                        Price:
                                      </span>
                                      <span className="text-white font-semibold">
                                        ${Number(fourH.price).toFixed(2)}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              )}

                              {oneH && (
                                <div className="mb-3 p-3 bg-[#1a1f28] rounded-lg border border-[#252b36]">
                                  <div className="text-xs text-[#8b92a0] mb-2 font-semibold">
                                    1H (13-21 EMA)
                                  </div>
                                  <div className="flex justify-between items-center mb-1">
                                    <span className="text-xs text-[#8b92a0]">
                                      Position
                                    </span>
                                    <span
                                      className={`text-xs font-semibold ${getPositionColor(
                                        oneH.position,
                                      )}`}
                                    >
                                      {getPositionEmoji(oneH.position)}{" "}
                                      {oneH.position.toUpperCase()}
                                    </span>
                                  </div>
                                  <div className="grid grid-cols-2 gap-2 text-xs mt-2">
                                    <div className="flex justify-between">
                                      <span className="text-[#8b92a0]">
                                        Upper:
                                      </span>
                                      <span className="text-white">
                                        ${Number(oneH.upper).toFixed(2)}
                                      </span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-[#8b92a0]">
                                        Lower:
                                      </span>
                                      <span className="text-white">
                                        ${Number(oneH.lower).toFixed(2)}
                                      </span>
                                    </div>
                                    <div className="flex justify-between col-span-2">
                                      <span className="text-[#8b92a0]">
                                        Price:
                                      </span>
                                      <span className="text-white font-semibold">
                                        ${Number(oneH.price).toFixed(2)}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                      {/* Fundamental & Valuation Metrics */}
                      {ticker.fundamentals &&
                        (() => {
                          const fund = ticker.fundamentals;
                          const hasValuationData =
                            fund.pe_ratio !== null ||
                            fund.peg_ratio !== null ||
                            fund.eps_growth_rate !== null;

                          if (!hasValuationData) return null;

                          const valuationSignal =
                            fund.valuation_signal || "fair";
                          const signalColor =
                            valuationSignal === "undervalued"
                              ? "text-green-400"
                              : valuationSignal === "overvalued"
                                ? "text-red-400"
                                : "text-yellow-400";
                          const signalBg =
                            valuationSignal === "undervalued"
                              ? "bg-green-500/20 border-green-500/50"
                              : valuationSignal === "overvalued"
                                ? "bg-red-500/20 border-red-500/50"
                                : "bg-yellow-500/20 border-yellow-500/50";

                          return (
                            <div className="mt-6 pt-6 border-t-2 border-[#252b36]">
                              <div className="text-sm font-bold text-[#8b92a0] mb-4">
                                📊 Fundamental & Valuation
                              </div>

                              {/* Valuation Signal Badge */}
                              {fund.valuation_signal && (
                                <div
                                  className={`mb-4 p-3 rounded-lg border-2 ${signalBg}`}
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs text-[#8b92a0]">
                                      Valuation Signal
                                    </span>
                                    <span
                                      className={`font-bold text-sm ${signalColor}`}
                                    >
                                      {fund.valuation_signal.toUpperCase()}
                                    </span>
                                  </div>
                                  {fund.valuation_confidence && (
                                    <div className="text-xs text-[#8b92a0] mt-1">
                                      Confidence:{" "}
                                      <span className="font-semibold">
                                        {fund.valuation_confidence}
                                      </span>
                                    </div>
                                  )}
                                  {fund.valuation_reasons &&
                                    fund.valuation_reasons.length > 0 && (
                                      <div className="mt-2 pt-2 border-t border-current/30">
                                        <div className="text-[10px] text-[#8b92a0] mb-1">
                                          Reasons:
                                        </div>
                                        {fund.valuation_reasons.map(
                                          (reason, idx) => (
                                            <div
                                              key={idx}
                                              className="text-[10px] text-[#8b92a0]/80 mb-0.5"
                                            >
                                              • {reason}
                                            </div>
                                          ),
                                        )}
                                      </div>
                                    )}
                                </div>
                              )}

                              {/* Basic Metrics */}
                              <div className="space-y-2 text-sm mb-4">
                                {fund.pe_ratio !== null && (
                                  <div className="flex justify-between items-center py-1 border-b border-[#252b36]/50">
                                    <span className="text-[#8b92a0]">
                                      P/E Ratio
                                    </span>
                                    <span className="font-semibold">
                                      {Number(fund.pe_ratio).toFixed(2)}
                                    </span>
                                  </div>
                                )}
                                {fund.peg_ratio !== null && (
                                  <div className="flex justify-between items-center py-1 border-b border-[#252b36]/50">
                                    <span className="text-[#8b92a0]">
                                      PEG Ratio
                                    </span>
                                    <span
                                      className={`font-semibold ${
                                        fund.peg_ratio < 0.8
                                          ? "text-green-400"
                                          : fund.peg_ratio < 1.0
                                            ? "text-yellow-400"
                                            : fund.peg_ratio > 1.5
                                              ? "text-red-400"
                                              : "text-[#8b92a0]"
                                      }`}
                                    >
                                      {Number(fund.peg_ratio).toFixed(2)}
                                    </span>
                                  </div>
                                )}
                                {fund.eps !== null && (
                                  <div className="flex justify-between items-center py-1 border-b border-[#252b36]/50">
                                    <span className="text-[#8b92a0]">
                                      EPS (TTM)
                                    </span>
                                    <span className="font-semibold">
                                      ${Number(fund.eps).toFixed(2)}
                                    </span>
                                  </div>
                                )}
                                {fund.eps_growth_rate !== null && (
                                  <div className="flex justify-between items-center py-1 border-b border-[#252b36]/50">
                                    <span className="text-[#8b92a0]">
                                      EPS Growth (Annual)
                                    </span>
                                    <span
                                      className={`font-semibold ${
                                        fund.eps_growth_rate > 20
                                          ? "text-green-400"
                                          : fund.eps_growth_rate > 10
                                            ? "text-yellow-400"
                                            : fund.eps_growth_rate > 0
                                              ? "text-[#8b92a0]"
                                              : "text-red-400"
                                      }`}
                                    >
                                      {Number(fund.eps_growth_rate).toFixed(1)}%
                                    </span>
                                  </div>
                                )}
                                {(() => {
                                  const marketCap = fund.market_cap;
                                  const isValid =
                                    marketCap !== null &&
                                    marketCap !== undefined &&
                                    marketCap !== "" &&
                                    (typeof marketCap === "number" ||
                                      typeof marketCap === "string") &&
                                    !isNaN(Number(marketCap)) &&
                                    Number(marketCap) > 0;
                                  if (!isValid) return null;
                                  const numCap = Number(marketCap);
                                  let formatted;
                                  if (numCap >= 1e12) {
                                    formatted = `$${(numCap / 1e12).toFixed(2)}T`;
                                  } else if (numCap >= 1e9) {
                                    formatted = `$${(numCap / 1e9).toFixed(2)}B`;
                                  } else if (numCap >= 1e6) {
                                    formatted = `$${(numCap / 1e6).toFixed(2)}M`;
                                  } else {
                                    formatted = `$${numCap.toLocaleString()}`;
                                  }
                                  return (
                                    <div className="flex justify-between items-center py-1 border-b border-[#252b36]/50">
                                      <span className="text-[#8b92a0]">
                                        Market Cap
                                      </span>
                                      <span className="font-semibold">
                                        {formatted}
                                      </span>
                                    </div>
                                  );
                                })()}
                                {fund.industry && (
                                  <div className="flex justify-between items-center py-1 border-b border-[#252b36]/50">
                                    <span className="text-[#8b92a0]">
                                      Industry
                                    </span>
                                    <span className="font-semibold text-xs">
                                      {fund.industry}
                                    </span>
                                  </div>
                                )}
                              </div>

                              {/* Fair Value */}
                              {fund.fair_value_price !== null &&
                                fund.fair_value_price > 0 && (
                                  <div className="mb-4 p-3 bg-[#1a1f28] rounded-lg border border-[#252b36]">
                                    <div className="text-xs text-[#8b92a0] mb-2">
                                      Fair Value
                                    </div>
                                    <div className="flex items-center justify-between mb-2">
                                      <span className="text-sm text-[#8b92a0]">
                                        Fair Value Price
                                      </span>
                                      <span className="font-bold text-lg text-blue-400">
                                        $
                                        {Number(fund.fair_value_price).toFixed(
                                          2,
                                        )}
                                      </span>
                                    </div>
                                    {fund.premium_discount_pct !== null && (
                                      <div className="flex items-center justify-between">
                                        <span className="text-xs text-[#8b92a0]">
                                          Premium/Discount
                                        </span>
                                        <span
                                          className={`font-semibold ${
                                            fund.premium_discount_pct < -10
                                              ? "text-green-400"
                                              : fund.premium_discount_pct < 0
                                                ? "text-yellow-400"
                                                : fund.premium_discount_pct > 10
                                                  ? "text-red-400"
                                                  : "text-[#8b92a0]"
                                          }`}
                                        >
                                          {fund.premium_discount_pct > 0
                                            ? "+"
                                            : ""}
                                          {Number(
                                            fund.premium_discount_pct,
                                          ).toFixed(1)}
                                          %
                                        </span>
                                      </div>
                                    )}
                                    {fund.fair_value_pe &&
                                      fund.fair_value_pe.preferred && (
                                        <div className="mt-2 pt-2 border-t border-[#252b36] text-xs text-[#8b92a0]">
                                          Fair P/E:{" "}
                                          <span className="font-semibold">
                                            {Number(
                                              fund.fair_value_pe.preferred,
                                            ).toFixed(2)}
                                          </span>
                                        </div>
                                      )}
                                  </div>
                                )}

                              {/* Historical P/E Percentiles */}
                              {fund.pe_percentiles && (
                                <div className="mb-4 p-3 bg-[#1a1f28] rounded-lg border border-[#252b36]">
                                  <div className="text-xs text-[#8b92a0] mb-2">
                                    Historical P/E Percentiles
                                  </div>
                                  <div className="grid grid-cols-2 gap-2 text-xs">
                                    {fund.pe_percentiles.p10 !== null && (
                                      <div className="flex justify-between">
                                        <span className="text-[#8b92a0]">
                                          10th:
                                        </span>
                                        <span className="font-semibold">
                                          {Number(
                                            fund.pe_percentiles.p10,
                                          ).toFixed(1)}
                                        </span>
                                      </div>
                                    )}
                                    {fund.pe_percentiles.p25 !== null && (
                                      <div className="flex justify-between">
                                        <span className="text-[#8b92a0]">
                                          25th:
                                        </span>
                                        <span className="font-semibold">
                                          {Number(
                                            fund.pe_percentiles.p25,
                                          ).toFixed(1)}
                                        </span>
                                      </div>
                                    )}
                                    {fund.pe_percentiles.p50 !== null && (
                                      <div className="flex justify-between">
                                        <span className="text-[#8b92a0]">
                                          50th (Median):
                                        </span>
                                        <span className="font-semibold text-blue-400">
                                          {Number(
                                            fund.pe_percentiles.p50,
                                          ).toFixed(1)}
                                        </span>
                                      </div>
                                    )}
                                    {fund.pe_percentiles.p75 !== null && (
                                      <div className="flex justify-between">
                                        <span className="text-[#8b92a0]">
                                          75th:
                                        </span>
                                        <span className="font-semibold">
                                          {Number(
                                            fund.pe_percentiles.p75,
                                          ).toFixed(1)}
                                        </span>
                                      </div>
                                    )}
                                    {fund.pe_percentiles.p90 !== null && (
                                      <div className="flex justify-between">
                                        <span className="text-[#8b92a0]">
                                          90th:
                                        </span>
                                        <span className="font-semibold">
                                          {Number(
                                            fund.pe_percentiles.p90,
                                          ).toFixed(1)}
                                        </span>
                                      </div>
                                    )}
                                    {fund.pe_percentiles.avg !== null && (
                                      <div className="flex justify-between col-span-2 pt-1 border-t border-[#252b36]">
                                        <span className="text-[#8b92a0]">
                                          Average:
                                        </span>
                                        <span className="font-semibold">
                                          {Number(
                                            fund.pe_percentiles.avg,
                                          ).toFixed(1)}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                  {fund.pe_percentile_position && (
                                    <div className="mt-2 pt-2 border-t border-[#252b36] text-xs">
                                      <span className="text-[#8b92a0]">
                                        Current Position:{" "}
                                      </span>
                                      <span
                                        className={`font-semibold ${
                                          fund.pe_percentile_position.includes(
                                            "Bottom",
                                          )
                                            ? "text-green-400"
                                            : fund.pe_percentile_position.includes(
                                                  "Top",
                                                )
                                              ? "text-red-400"
                                              : "text-[#8b92a0]"
                                        }`}
                                      >
                                        {fund.pe_percentile_position}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Valuation Boost in Rank */}
                              {ticker.rank_components &&
                                ticker.rank_components.valuation_boost !==
                                  undefined &&
                                ticker.rank_components.valuation_boost !==
                                  0 && (
                                  <div className="mb-4 p-3 bg-[#1a1f28] rounded-lg border border-[#252b36]">
                                    <div className="text-xs text-[#8b92a0] mb-1">
                                      Rank Components
                                    </div>
                                    <div className="flex justify-between items-center text-xs">
                                      <span className="text-[#8b92a0]">
                                        Base Rank
                                      </span>
                                      <span className="font-semibold">
                                        {ticker.rank_components.base_rank ||
                                          baseScore}
                                      </span>
                                    </div>
                                    <div className="flex justify-between items-center text-xs mt-1">
                                      <span className="text-[#8b92a0]">
                                        Valuation Boost
                                      </span>
                                      <span
                                        className={`font-semibold ${
                                          ticker.rank_components
                                            .valuation_boost > 0
                                            ? "text-green-400"
                                            : "text-red-400"
                                        }`}
                                      >
                                        {ticker.rank_components
                                          .valuation_boost > 0
                                          ? "+"
                                          : ""}
                                        {ticker.rank_components.valuation_boost}
                                      </span>
                                    </div>
                                    <div className="flex justify-between items-center text-sm mt-2 pt-2 border-t border-[#252b36]">
                                      <span className="text-[#8b92a0] font-semibold">
                                        Final Rank
                                      </span>
                                      <span className="font-bold text-blue-400">
                                        {baseScore}
                                      </span>
                                    </div>
                                  </div>
                                )}
                            </div>
                          );
                        })()}

                      {/* Trade Journey (Ledger trades) */}
                    </>
                  ) : null}

                  {railTab === "CHART" ? (
                    <>
                      <div className="mb-4 p-3 bg-[#1a1f28] border-2 border-[#252b36] rounded-lg">
                        <div className="flex items-center justify-between gap-2 mb-3">
                          <div className="text-sm text-[#8b92a0]">Chart</div>
                          <div className="flex items-center gap-1 flex-wrap">
                            {[
                              { tf: "1", label: "1m" },
                              { tf: "3", label: "3m" },
                              { tf: "5", label: "5m" },
                              { tf: "10", label: "10m" },
                              { tf: "30", label: "30m" },
                              { tf: "60", label: "1H" },
                              { tf: "240", label: "4H" },
                              { tf: "D", label: "D" },
                              { tf: "W", label: "W" },
                            ].map((t) => {
                              const active = String(chartTf) === String(t.tf);
                              return (
                                <button
                                  key={`tf-${t.tf}`}
                                  onClick={() => setChartTf(String(t.tf))}
                                  className={`px-2 py-1 rounded border text-[11px] font-semibold transition-all ${
                                    active
                                      ? "border-blue-400 bg-blue-500/20 text-blue-200"
                                      : "border-[#252b36] bg-[#13171e] text-[#8b92a0] hover:text-white"
                                  }`}
                                  title={`Show ${t.label} candles`}
                                >
                                  {t.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {chartLoading ? (
                          <div className="text-xs text-[#8b92a0]">
                            Loading candles…
                          </div>
                        ) : chartError ? (
                          <div className="text-xs text-yellow-300">
                            Failed to load candles: {chartError}
                          </div>
                        ) : !Array.isArray(chartCandles) ||
                          chartCandles.length < 2 ? (
                          <div className="text-xs text-[#8b92a0]">
                            No candles yet for this timeframe. (Waiting for the
                            TradingView candle capture feed.)
                          </div>
                        ) : (
                          (() => {
                            try {
                              const toMs = (v) => {
                                if (v == null) return NaN;
                                if (typeof v === "number") {
                                  // Heuristic: seconds vs ms
                                  return v > 1e12 ? v : v * 1000;
                                }
                                const n = Number(v);
                                if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
                                const d = new Date(String(v));
                                const ms = d.getTime();
                                return Number.isFinite(ms) ? ms : NaN;
                              };

                              const norm = (c) => {
                                const tsRaw = c?.ts ?? c?.t ?? c?.time ?? c?.timestamp;
                                const tsMs = toMs(tsRaw);
                                const o = Number(c?.o ?? c?.open);
                                const h = Number(c?.h ?? c?.high);
                                const l = Number(c?.l ?? c?.low);
                                const cl = Number(c?.c ?? c?.close);
                                if (
                                  !Number.isFinite(tsMs) ||
                                  !Number.isFinite(o) ||
                                  !Number.isFinite(h) ||
                                  !Number.isFinite(l) ||
                                  !Number.isFinite(cl)
                                )
                                  return null;
                                return { ...c, ts: tsMs, __ts_ms: tsMs, o, h, l, c: cl };
                              };

                              let candles = (Array.isArray(chartCandles) ? chartCandles : [])
                                .slice(-400)
                                .map(norm)
                                .filter(Boolean);

                              // Sort + dedupe/aggregate to prevent duplicate bars (common on W captures).
                              candles.sort((a, b) => Number(a.__ts_ms) - Number(b.__ts_ms));

                              const weekStartUtcMs = (tsMs) => {
                                const d0 = new Date(Number(tsMs));
                                const day = d0.getUTCDay(); // 0=Sun..6=Sat
                                const daysSinceMon = (day + 6) % 7; // Mon->0, Tue->1, ... Sun->6
                                const d = new Date(
                                  d0.getTime() - daysSinceMon * 24 * 60 * 60 * 1000,
                                );
                                d.setUTCHours(0, 0, 0, 0);
                                return d.getTime();
                              };

                              if (String(chartTf) === "W") {
                                // If the backend sends multiple snapshots within a week, aggregate them
                                // into a single weekly candle: O=first, H=max, L=min, C=last.
                                const byWeek = new Map(); // weekStartMs -> candle
                                for (const c of candles) {
                                  const wk = weekStartUtcMs(c.__ts_ms);
                                  const prev = byWeek.get(wk);
                                  if (!prev) {
                                    byWeek.set(wk, {
                                      ts: wk,
                                      __ts_ms: wk,
                                      o: Number(c.o),
                                      h: Number(c.h),
                                      l: Number(c.l),
                                      c: Number(c.c),
                                      _last_ts: Number(c.__ts_ms),
                                    });
                                  } else {
                                    prev.h = Math.max(Number(prev.h), Number(c.h));
                                    prev.l = Math.min(Number(prev.l), Number(c.l));
                                    if (Number(c.__ts_ms) >= Number(prev._last_ts)) {
                                      prev.c = Number(c.c);
                                      prev._last_ts = Number(c.__ts_ms);
                                    }
                                  }
                                }
                                candles = Array.from(byWeek.values())
                                  .sort((a, b) => Number(a.__ts_ms) - Number(b.__ts_ms))
                                  .map((c) => {
                                    const out = { ...c };
                                    delete out._last_ts;
                                    return out;
                                  });
                              } else {
                                // Dedupe by timestamp (keep the latest sample per ts)
                                const byTs = new Map();
                                for (const c of candles) byTs.set(Number(c.__ts_ms), c);
                                candles = Array.from(byTs.values()).sort(
                                  (a, b) => Number(a.__ts_ms) - Number(b.__ts_ms),
                                );
                              }

                              const n = candles.length;
                              if (n < 2) {
                                return (
                                  <div className="text-xs text-[#8b92a0]">
                                    Candle data loaded, but it’s not in the expected OHLC format yet.
                                    (Waiting for valid captures.)
                                  </div>
                                );
                              }

                              const lows = candles.map((c) => Number(c.l));
                              const highs = candles.map((c) => Number(c.h));
                              let minL = Math.min(...lows);
                              let maxH = Math.max(...highs);
                              if (!Number.isFinite(minL) || !Number.isFinite(maxH))
                                throw new Error("invalid_minmax");
                              if (maxH <= minL) {
                                maxH = minL + 1;
                              }
                              const pad = (maxH - minL) * 0.05;
                              minL -= pad;
                              maxH += pad;

                            const H = 320;
                            const leftMargin = 5;
                            const rightMargin = 65;
                            const candleW = 8; // Fixed candle width
                            const candleGap = 2; // Gap between candles
                            const candleStep = candleW + candleGap;
                            const plotW = n * candleStep;
                            const W = plotW + leftMargin + rightMargin;
                            const plotH = H;
                            const y = (p) =>
                              plotH - ((p - minL) / (maxH - minL)) * plotH;
                            const bodyW = candleW * 0.9;

                            const priceStep = (maxH - minL) / 5;
                            const priceTicks = [];
                            for (let i = 0; i <= 5; i++) {
                              priceTicks.push(minL + priceStep * i);
                            }

                              const handleMouseMove = (e) => {
                                const svg = e.currentTarget;
                                const rect = svg.getBoundingClientRect();
                                if (!rect || rect.width <= 0 || rect.height <= 0) return;
                                
                                // Get mouse position relative to SVG element
                                const mx = e.clientX - rect.left;
                                const my = e.clientY - rect.top;
                                
                                // Use SVG's getScreenCTM() for accurate coordinate mapping
                                const pt = svg.createSVGPoint();
                                pt.x = e.clientX;
                                pt.y = e.clientY;
                                const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());
                                const svgX = svgP.x;
                                const svgY = svgP.y;
                                
                                if (svgX < leftMargin || svgX > W - rightMargin) return;
                                const idx = Math.floor(((svgX - leftMargin) / plotW) * n);
                                if (idx >= 0 && idx < n) {
                                  const c = candles[idx];
                                  if (!c) return;
                                  const price =
                                    minL + ((H - svgY) / plotH) * (maxH - minL);
                                  setCrosshair({ x: svgX, y: svgY, candle: c, price });
                                }
                              };

                            return (
                              <div className="w-full relative">
                                <div
                                  ref={chartScrollRef}
                                  className="overflow-x-auto overflow-y-hidden rounded border border-[#252b36] bg-[#0c0f14] scrollbar-hide"
                                  style={{
                                    scrollbarWidth: "thin",
                                    scrollbarColor: "#252b36 #0c0f14"
                                  }}
                                >
                                  <svg
                                    viewBox={`0 0 ${W} ${H}`}
                                    preserveAspectRatio="none"
                                    style={{ minWidth: `${Math.max(760, W)}px`, width: `${W}px`, height: "320px" }}
                                    className="cursor-crosshair"
                                    role="img"
                                    aria-label="Candlestick chart"
                                    onMouseMove={handleMouseMove}
                                    onMouseLeave={() => setCrosshair(null)}
                                  >
                                  {/* Price grid lines */}
                                  {priceTicks.map((p, i) => {
                                    const yPos = y(p);
                                    return (
                                      <g key={`grid-${i}`}>
                                        <line
                                          x1={leftMargin}
                                          y1={yPos}
                                          x2={W - rightMargin}
                                          y2={yPos}
                                          stroke="rgba(38,50,95,0.5)"
                                          strokeWidth="1"
                                        />
                                        <text
                                          x={W - rightMargin + 6}
                                          y={yPos + 4}
                                          fontSize="11"
                                          fill="#8b92a0"
                                          fontFamily="monospace"
                                        >
                                          ${p.toFixed(2)}
                                        </text>
                                      </g>
                                    );
                                  })}

                                  {/* Candles */}
                                  {candles.map((c, i) => {
                                    const o = Number(c.o);
                                    const h = Number(c.h);
                                    const l = Number(c.l);
                                    const cl = Number(c.c);
                                    const up = cl >= o;
                                    const stroke = up
                                      ? "rgba(56,189,248,0.95)"
                                      : "rgba(251,146,60,0.95)";
                                    const fill = up
                                      ? "rgba(56,189,248,0.90)"
                                      : "rgba(251,146,60,0.90)";

                                    const cx = leftMargin + i * candleStep + candleStep / 2;
                                    const yH = y(h);
                                    const yL = y(l);
                                    const yO = y(o);
                                    const yC = y(cl);
                                    const top = Math.min(yO, yC);
                                    const bot = Math.max(yO, yC);
                                    const bodyH = Math.max(1.5, bot - top);

                                    return (
                                      <g key={`c-${Number(c.ts)}-${i}`}>
                                        <line
                                          x1={cx}
                                          y1={yH}
                                          x2={cx}
                                          y2={yL}
                                          stroke={stroke}
                                          strokeWidth="1.2"
                                        />
                                        <rect
                                          x={cx - bodyW / 2}
                                          y={top}
                                          width={bodyW}
                                          height={bodyH}
                                          fill={fill}
                                          stroke="none"
                                          rx="0.5"
                                        />
                                      </g>
                                    );
                                  })}

                                  {/* Crosshair */}
                                  {crosshair ? (
                                    <>
                                      <line
                                        x1={leftMargin}
                                        y1={crosshair.y}
                                        x2={W - rightMargin}
                                        y2={crosshair.y}
                                        stroke="rgba(147,164,214,0.5)"
                                        strokeWidth="1"
                                        strokeDasharray="4 4"
                                      />
                                      <line
                                        x1={crosshair.x}
                                        y1={0}
                                        x2={crosshair.x}
                                        y2={H}
                                        stroke="rgba(147,164,214,0.5)"
                                        strokeWidth="1"
                                        strokeDasharray="4 4"
                                      />
                                      {/* Crosshair price label (right side) */}
                                      {(() => {
                                        const yLabel = Math.max(
                                          10,
                                          Math.min(H - 10, Number(crosshair.y)),
                                        );
                                        const price = Number(crosshair.price);
                                        const priceText = Number.isFinite(price)
                                          ? `$${price.toFixed(2)}`
                                          : "—";
                                        return (
                                          <g>
                                            <rect
                                              x={W - rightMargin + 2}
                                              y={yLabel - 10}
                                              width={rightMargin - 4}
                                              height={20}
                                              fill="rgba(18,26,51,0.92)"
                                              stroke="rgba(38,50,95,0.9)"
                                              strokeWidth="1"
                                              rx="4"
                                            />
                                            <text
                                              x={W - rightMargin + (rightMargin - 4) / 2}
                                              y={yLabel + 4}
                                              fontSize="11"
                                              fill="#fbbf24"
                                              fontFamily="monospace"
                                              fontWeight="700"
                                              textAnchor="middle"
                                            >
                                              {priceText}
                                            </text>
                                          </g>
                                        );
                                      })()}
                                    </>
                                  ) : null}
                                  </svg>
                                </div>

                                {/* Crosshair tooltip */}
                                {crosshair && crosshair.candle ? (
                                  <div
                                    className="absolute top-2 left-2 px-3 py-2 bg-[#13171e]/95 border border-[#252b36] rounded-lg text-[11px] pointer-events-none z-10"
                                    style={{
                                      backdropFilter: "blur(8px)",
                                      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                                    }}
                                  >
                                    <div className="font-semibold text-white mb-1">
                                      {(() => {
                                        try {
                                          const ts = Number(
                                            crosshair?.candle?.__ts_ms ??
                                              crosshair?.candle?.ts,
                                          );
                                          if (!Number.isFinite(ts)) return "—";
                                          if (String(chartTf) === "W") {
                                            // Weekly candles: show the start-of-week (Monday) label
                                            const d0 = new Date(ts);
                                            const day = d0.getDay(); // 0=Sun..6=Sat
                                            const daysSinceMon = (day + 6) % 7; // Mon->0, Tue->1, ... Sun->6
                                            const d = new Date(
                                              d0.getTime() - daysSinceMon * 24 * 60 * 60 * 1000,
                                            );
                                            d.setHours(0, 0, 0, 0);
                                            return `Week of ${d.toLocaleDateString("en-US", {
                                              month: "short",
                                              day: "numeric",
                                              year: "numeric",
                                            })}`;
                                          }
                                          const d = new Date(ts);
                                          return d.toLocaleString("en-US", {
                                            month: "short",
                                            day: "numeric",
                                            hour: "numeric",
                                            minute: "2-digit",
                                          });
                                        } catch {
                                          return "—";
                                        }
                                      })()}
                                    </div>
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                                      <div className="text-[#8b92a0]">Price:</div>
                                      <div className="text-yellow-300 font-mono font-semibold">
                                        ${Number(crosshair.price).toFixed(2)}
                                      </div>
                                      <div className="text-[#8b92a0]">O:</div>
                                      <div className="text-white font-mono">
                                        ${Number(crosshair.candle.o).toFixed(2)}
                                      </div>
                                      <div className="text-[#8b92a0]">H:</div>
                                      <div className="text-sky-300 font-mono">
                                        ${Number(crosshair.candle.h).toFixed(2)}
                                      </div>
                                      <div className="text-[#8b92a0]">L:</div>
                                      <div className="text-orange-300 font-mono">
                                        ${Number(crosshair.candle.l).toFixed(2)}
                                      </div>
                                      <div className="text-[#8b92a0]">C:</div>
                                      <div
                                        className={`font-mono font-semibold ${
                                          Number(crosshair.candle.c) >=
                                          Number(crosshair.candle.o)
                                            ? "text-sky-300"
                                            : "text-orange-300"
                                        }`}
                                      >
                                        ${Number(crosshair.candle.c).toFixed(2)}
                                      </div>
                                    </div>
                                  </div>
                                ) : null}

                                <div className="mt-2 text-[10px] text-[#8b92a0] flex items-center justify-between">
                                  <span>
                                    {String(chartTf) === "D"
                                      ? "Daily"
                                      : String(chartTf) === "W"
                                        ? "Weekly"
                                        : `${chartTf}m`}{" "}
                                    • {candles.length} bars
                                  </span>
                                  <span className="font-mono">
                                    ${minL.toFixed(2)} – ${maxH.toFixed(2)}
                                  </span>
                                </div>
                              </div>
                            );
                            } catch (e) {
                              console.error("[RightRail Chart] render failed:", e);
                              return (
                                <div className="text-xs text-yellow-300">
                                  Chart render error (data may be malformed). Check console for details.
                                </div>
                              );
                            }
                          })()
                        )}
                      </div>
                    </>
                  ) : null}

                  {railTab === "TRADE_HISTORY" ? (
                    <>
                      <div className="mb-4 p-3 bg-[#1a1f28] border-2 border-[#252b36] rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-sm text-[#8b92a0]">
                            Trade Journey
                          </div>
                          <a
                            href={`simulation-dashboard.html?ticker=${encodeURIComponent(
                              String(tickerSymbol).toUpperCase(),
                            )}`}
                            className="text-xs px-2 py-1 rounded bg-blue-500/20 border border-blue-500/30 text-blue-300 hover:bg-blue-500/30"
                            title="Open full Trade Tracker"
                          >
                            Open
                          </a>
                        </div>
                        {(() => {
                          const stage = String(
                            ticker?.kanban_stage || "",
                          ).trim();
                          if (!stage) return null;
                          const up = stage.toLowerCase();
                          const label = up.replaceAll("_", " ").toUpperCase();
                          const cls =
                            up === "exit"
                              ? "bg-red-500/15 text-red-300 border-red-500/40"
                              : up === "trim"
                                ? "bg-yellow-500/15 text-yellow-300 border-yellow-500/40"
                                : up === "defend"
                                  ? "bg-orange-500/15 text-orange-300 border-orange-500/40"
                                  : up === "hold"
                                    ? "bg-blue-500/15 text-blue-300 border-blue-500/40"
                                    : up === "enter_now"
                                      ? "bg-green-500/15 text-green-300 border-green-500/40"
                                      : "bg-white/5 text-[#8b92a0] border-white/10";
                          return (
                            <div className="mb-2 text-[11px] flex items-center gap-2">
                              <span className="text-[#8b92a0]">Now:</span>
                              <span
                                className={`px-2 py-0.5 rounded border font-semibold ${cls}`}
                              >
                                {label}
                              </span>
                              <span className="text-[#5c6475]">
                                (ledger may still show an open trade while we
                                are in an exit lane)
                              </span>
                            </div>
                          );
                        })()}
                        {ledgerTradesLoading ? (
                          <div className="text-xs text-[#8b92a0] flex items-center gap-2">
                            <div className="loading-spinner"></div>
                            Loading ledger trades…
                          </div>
                        ) : ledgerTradesError ? (
                          <div className="text-xs text-red-400">
                            Ledger unavailable: {ledgerTradesError}
                          </div>
                        ) : ledgerTrades.length === 0 ? (
                          <div className="text-xs text-[#8b92a0]">
                            No ledger trades found for this ticker.
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {ledgerTrades.slice(0, 5).map((t) => {
                              const isClosed =
                                t.status === "WIN" || t.status === "LOSS";
                              const pnl = Number(t.pnl || 0);
                              const entryPrice = Number(t.entry_price || 0);
                              const exitPrice = Number(t.exit_price || 0);
                              const quantity = Number(t.quantity || 0);
                              
                              const formatDateTime = (ts) => {
                                if (!ts) return "—";
                                try {
                                  const d = new Date(Number(ts));
                                  return d.toLocaleString('en-US', {
                                    month: 'short',
                                    day: 'numeric',
                                    hour: 'numeric',
                                    minute: '2-digit',
                                    hour12: true
                                  });
                                } catch {
                                  return "—";
                                }
                              };
                              
                              return (
                                <div
                                  key={t.trade_id}
                                  className="p-3 bg-[#13171e] border border-[#252b36] rounded"
                                >
                                  {/* Header: Status and P&L */}
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                      {isClosed ? (
                                        <span
                                          className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                            t.status === "WIN"
                                              ? "bg-green-500/20 text-green-400 border border-green-500/30"
                                              : "bg-red-500/20 text-red-400 border border-red-500/30"
                                          }`}
                                        >
                                          {t.status}
                                        </span>
                                      ) : (
                                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-500/15 text-blue-300 border border-blue-500/30">
                                          OPEN
                                        </span>
                                      )}
                                      <span
                                        className={`text-xs font-semibold ${
                                          t.direction === "LONG"
                                            ? "text-green-400"
                                            : "text-red-400"
                                        }`}
                                      >
                                        {t.direction}
                                      </span>
                                    </div>
                                    {isClosed && (
                                      <div
                                        className={`text-sm font-bold ${
                                          pnl >= 0
                                            ? "text-green-400"
                                            : "text-red-400"
                                        }`}
                                      >
                                        {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                                      </div>
                                    )}
                                  </div>
                                  
                                  {/* Entry */}
                                  <div className="space-y-1 text-xs">
                                    <div className="flex items-center justify-between">
                                      <span className="text-[#8b92a0]">Entered:</span>
                                      <span className="text-white font-semibold">
                                        {formatDateTime(t.entry_ts)}
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-[#8b92a0]">Entry Price:</span>
                                      <span className="text-green-400 font-semibold">
                                        ${entryPrice > 0 ? entryPrice.toFixed(2) : "—"}
                                      </span>
                                    </div>
                                    {quantity > 0 && (
                                      <div className="flex items-center justify-between">
                                        <span className="text-[#8b92a0]">Quantity:</span>
                                        <span className="text-white font-semibold">
                                          {quantity.toFixed(0)} shares
                                        </span>
                                      </div>
                                    )}
                                    
                                    {/* Exit (if closed) */}
                                    {isClosed && (
                                      <>
                                        <div className="border-t border-[#252b36]/50 my-1.5"></div>
                                        <div className="flex items-center justify-between">
                                          <span className="text-[#8b92a0]">Exited:</span>
                                          <span className="text-white font-semibold">
                                            {formatDateTime(t.exit_ts)}
                                          </span>
                                        </div>
                                        <div className="flex items-center justify-between">
                                          <span className="text-[#8b92a0]">Exit Price:</span>
                                          <span className="text-red-400 font-semibold">
                                            ${exitPrice > 0 ? exitPrice.toFixed(2) : "—"}
                                          </span>
                                        </div>
                                      </>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                            {ledgerTrades.length > 5 && (
                              <div className="text-[10px] text-[#5c6475] text-center">
                                Showing 5 of {ledgerTrades.length} recent trades
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Completion, Phase, Dynamic ETA */}
                    </>
                  ) : null}

                  {railTab === "JOURNEY" ? (
                    <>
                      {/* Performance Overview */}
                      {(() => {
                        const currentPrice = Number(ticker.price);
                        if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;
                        
                        // Calculate performance for different time periods
                        const calculatePerformance = (daysBack) => {
                          const now = Date.now();
                          const cutoff = now - (daysBack * 24 * 60 * 60 * 1000);
                          
                          // Find price at cutoff from bubbleJourney (closest to cutoff time, going back)
                          let oldPrice = null;
                          if (Array.isArray(bubbleJourney) && bubbleJourney.length > 0) {
                            // Get all valid points with timestamps and prices
                            const validPoints = bubbleJourney
                              .map(p => ({
                                ts: Number(p.__ts_ms || p.ts),
                                price: Number(p.price)
                              }))
                              .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.price) && p.price > 0)
                              .sort((a, b) => a.ts - b.ts); // Ascending: oldest first
                            
                            if (validPoints.length === 0) return null;
                            
                            // Find closest point at or before cutoff
                            let closestPoint = null;
                            for (const p of validPoints) {
                              if (p.ts <= cutoff) {
                                closestPoint = p;
                              } else {
                                break; // Since sorted, we can stop
                              }
                            }
                            
                            // If no point before cutoff, use oldest available
                            if (!closestPoint && validPoints.length > 0) {
                              closestPoint = validPoints[0];
                            }
                            
                            if (closestPoint) {
                              oldPrice = closestPoint.price;
                            }
                          }
                          
                          if (!oldPrice) return null;
                          
                          const changePct = ((currentPrice - oldPrice) / oldPrice) * 100;
                          const changePoints = currentPrice - oldPrice;
                          
                          return {
                            oldPrice,
                            changePct,
                            changePoints,
                            isUp: changePct >= 0
                          };
                        };
                        
                        const periods = [
                          { label: 'Today', days: 1 },
                          { label: '5D', days: 5 },
                          { label: '15D', days: 15 },
                          { label: '30D', days: 30 },
                          { label: '90D', days: 90 }
                        ];
                        
                        const performanceData = periods.map(p => ({
                          ...p,
                          perf: calculatePerformance(p.days)
                        })).filter(p => p.perf !== null);
                        
                        if (performanceData.length === 0) {
                          return (
                            <div className="mb-4 p-3 bg-[#1a1f28] border border-[#252b36] rounded-lg text-xs text-[#8b92a0]">
                              Performance data loading... Check back after we collect more history.
                            </div>
                          );
                        }
                        
                        return (
                          <div className="mb-4 space-y-3">
                            {performanceData.map((item, idx) => {
                              const { label, days, perf } = item;
                              const { changePct, changePoints, isUp } = perf;
                              
                              // Generate LLM-style interpretation
                              const getInterpretation = () => {
                                const absChg = Math.abs(changePct);
                                const tickerSymbol = String(ticker.ticker).toUpperCase();
                                
                                if (absChg < 2) {
                                  return `${tickerSymbol} is trading relatively flat over the past ${label.toLowerCase()}, showing ${absChg.toFixed(1)}% ${isUp ? 'gain' : 'loss'}. Price action suggests consolidation.`;
                                } else if (absChg < 5) {
                                  return `${tickerSymbol} is ${isUp ? 'up' : 'down'} ${absChg.toFixed(1)}% over the past ${label.toLowerCase()}, showing ${isUp ? 'modest bullish momentum' : 'mild weakness'}. Watch for ${isUp ? 'continuation or profit-taking' : 'support levels'}.`;
                                } else if (absChg < 10) {
                                  return `${tickerSymbol} has ${isUp ? 'gained' : 'lost'} ${absChg.toFixed(1)}% in the past ${label.toLowerCase()}, indicating ${isUp ? 'strong momentum' : 'significant selling pressure'}. ${isUp ? 'Momentum players may be accumulating' : 'Consider risk management'}.`;
                                } else if (absChg < 20) {
                                  return `${tickerSymbol} is showing ${isUp ? 'explosive' : 'severe'} ${isUp ? 'upside' : 'downside'} with a ${absChg.toFixed(1)}% ${isUp ? 'rally' : 'decline'} over ${label.toLowerCase()}. ${isUp ? 'High volatility suggests strong interest' : 'Caution warranted at these levels'}.`;
                                } else {
                                  return `${tickerSymbol} has ${isUp ? 'surged' : 'plunged'} ${absChg.toFixed(1)}% in ${label.toLowerCase()}—a ${isUp ? 'parabolic' : 'dramatic'} move. ${isUp ? 'Extreme momentum, watch for exhaustion' : 'Oversold conditions may present opportunity'}.`;
                                }
                              };
                              
                              return (
                                <div
                                  key={label}
                                  className="p-3 bg-[#1a1f28] border-2 border-[#252b36] rounded-lg"
                                >
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-xs font-bold text-[#8b92a0]">{label}</span>
                                    <div className="text-right">
                                      <div className={`text-lg font-bold ${isUp ? 'text-green-400' : 'text-red-400'}`}>
                                        {isUp ? '+' : ''}{changePct.toFixed(2)}%
                                      </div>
                                      <div className={`text-xs ${isUp ? 'text-green-300/70' : 'text-red-300/70'}`}>
                                        {isUp ? '+' : ''}${changePoints.toFixed(2)} pts
                                      </div>
                                    </div>
                                  </div>
                                  <div className="text-xs text-[#cbd5ff] leading-relaxed bg-[#13171e] p-2 rounded border border-[#252b36]/50">
                                    {getInterpretation()}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}

                      {/* Bubble Journey (15m increments) */}
                      <div className="mb-4 p-3 bg-[#1a1f28] border-2 border-[#252b36] rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-sm text-[#8b92a0]">
                            Bubble Journey (15m increments)
                          </div>
                          <a
                            href={`index-react.html?timeTravel=1&ticker=${encodeURIComponent(
                              String(tickerSymbol).toUpperCase(),
                            )}`}
                            className="text-xs px-2 py-1 rounded bg-purple-500/20 border border-purple-500/30 text-purple-300 hover:bg-purple-500/30"
                            title="Open Time Travel (if supported)"
                          >
                            Time Travel
                          </a>
                        </div>

                        {bubbleJourneyLoading ? (
                          <div className="text-xs text-[#8b92a0] flex items-center gap-2">
                            <div className="loading-spinner"></div>
                            Loading trail…
                          </div>
                        ) : bubbleJourneyError ? (
                          <div className="text-xs text-red-400">
                            Trail unavailable: {bubbleJourneyError}
                          </div>
                        ) : bubbleJourney.length === 0 ? (
                          <div className="text-xs text-[#8b92a0]">
                            No trail points found for this ticker.
                          </div>
                        ) : (
                          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                            {downsampleByInterval(bubbleJourney, 15 * 60 * 1000)
                              .slice()
                              .reverse()
                              .slice(0, 40)
                              .map((p, idx) => {
                                const ts = Number(p.__ts_ms);
                                const state =
                                  p.state || p.quadrant || p.zone || "—";
                                const phasePct =
                                  p.phase_pct != null
                                    ? `${Math.round(Number(p.phase_pct) * 100)}%`
                                    : "—";
                                const htf =
                                  p.htf_score != null &&
                                  Number.isFinite(Number(p.htf_score))
                                    ? Number(p.htf_score).toFixed(1)
                                    : "—";
                                const ltf =
                                  p.ltf_score != null &&
                                  Number.isFinite(Number(p.ltf_score))
                                    ? Number(p.ltf_score).toFixed(1)
                                    : "—";
                                const rank =
                                  p.rank != null ? String(p.rank) : "—";
                                const rr =
                                  p.rr != null && Number.isFinite(Number(p.rr))
                                    ? Number(p.rr).toFixed(2)
                                    : p.rr_at_alert != null &&
                                        Number.isFinite(Number(p.rr_at_alert))
                                      ? Number(p.rr_at_alert).toFixed(2)
                                      : "—";
                                const isSelected =
                                  selectedJourneyTs != null &&
                                  Number.isFinite(ts) &&
                                  Number(ts) === Number(selectedJourneyTs);

                                const pointForChart = {
                                  ts: Number.isFinite(ts) ? ts : null,
                                  htf_score:
                                    p.htf_score != null
                                      ? Number(p.htf_score)
                                      : null,
                                  ltf_score:
                                    p.ltf_score != null
                                      ? Number(p.ltf_score)
                                      : null,
                                  phase_pct:
                                    p.phase_pct != null
                                      ? Number(p.phase_pct)
                                      : null,
                                  completion:
                                    p.completion != null
                                      ? Number(p.completion)
                                      : null,
                                  rank: p.rank != null ? Number(p.rank) : null,
                                  rr: p.rr != null ? Number(p.rr) : null,
                                  state: p.state || null,
                                };
                                return (
                                  <div
                                    key={`${ts}-${idx}`}
                                    className={`px-2 py-1 bg-[#13171e] border rounded flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                                      isSelected
                                        ? "border-cyan-400/80 bg-cyan-500/10"
                                        : "border-[#252b36] hover:border-cyan-400/40 hover:bg-[#16224a]"
                                    }`}
                                    onMouseEnter={() => {
                                      if (onJourneyHover)
                                        onJourneyHover(pointForChart);
                                    }}
                                    onMouseLeave={() => {
                                      if (onJourneyHover) onJourneyHover(null);
                                    }}
                                    onClick={() => {
                                      if (onJourneySelect)
                                        onJourneySelect(pointForChart);
                                    }}
                                  >
                                    <div className="min-w-0">
                                      <div className="text-[10px] text-[#8b92a0]">
                                        {Number.isFinite(ts)
                                          ? new Date(ts).toLocaleString()
                                          : "—"}
                                      </div>
                                      <div className="text-xs text-white truncate">
                                        {state}
                                        <span className="text-[#5c6475]">
                                          {" "}
                                          •{" "}
                                        </span>
                                        <span className="text-[#8b92a0]">
                                          Phase
                                        </span>{" "}
                                        {phasePct}
                                      </div>
                                      <div className="text-[10px] text-[#8b92a0]">
                                        <span className="text-[#5c6475]">
                                          HTF
                                        </span>{" "}
                                        <span className="text-white font-semibold">
                                          {htf}
                                        </span>
                                        <span className="text-[#5c6475]">
                                          {" "}
                                          •{" "}
                                        </span>
                                        <span className="text-[#5c6475]">
                                          LTF
                                        </span>{" "}
                                        <span className="text-white font-semibold">
                                          {ltf}
                                        </span>
                                      </div>
                                    </div>
                                    <div className="text-right text-[10px] text-[#8b92a0] whitespace-nowrap">
                                      <div>
                                        <span className="text-[#5c6475]">
                                          Rank
                                        </span>{" "}
                                        <span className="text-white font-semibold">
                                          {rank}
                                        </span>
                                      </div>
                                      <div>
                                        <span className="text-[#5c6475]">
                                          RR
                                        </span>{" "}
                                        <span className="text-white font-semibold">
                                          {rr}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                          </div>
                        )}
                      </div>

                      {/* Current State Summary */}
                      <div className="mb-4 p-3 bg-[#1a1f28] border border-[#252b36] rounded-lg">
                        <div className="text-xs text-[#8b92a0] mb-2 font-semibold">Current Status</div>
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          <div>
                            <div className="text-[#8b92a0] text-[10px]">Phase</div>
                            <div className="text-white font-semibold" style={{ color: phaseColor }}>
                              {(phase * 100).toFixed(0)}%
                            </div>
                          </div>
                          <div>
                            <div className="text-[#8b92a0] text-[10px]">Completion</div>
                            <div className="text-white font-semibold">
                              {ticker.completion != null
                                ? `${(Number(ticker.completion) * 100).toFixed(0)}%`
                                : "—"}
                            </div>
                          </div>
                          <div>
                            <div className="text-[#8b92a0] text-[10px]">ETA</div>
                            <div className="text-white font-semibold">
                              {(() => {
                                const eta = computeEtaDays(ticker);
                                return Number.isFinite(eta) ? `${eta.toFixed(1)}d` : "—";
                              })()}
                            </div>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>

              {/* Fixed Footer */}
              <div className="flex-shrink-0 p-6 pt-4 border-t border-[#252b36] bg-[#13171e]">
                <a
                  href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(
                    tickerSymbol,
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full text-center px-4 py-2 bg-blue-500/20 border border-blue-500 rounded-lg hover:bg-blue-500/30 transition-all hover:scale-105 font-semibold"
                >
                  📊 Open in TradingView
                </a>
              </div>
            </div>
          </div>
        );
      }
  };
})();
