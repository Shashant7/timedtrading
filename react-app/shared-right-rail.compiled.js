/**
 * Universal Right Rail Ticker Details — shared by Dashboard and Trade Tracker.
 * Usage: const TickerDetailRightRail = window.TickerDetailRightRailFactory(deps);
 * deps must include: React, API_BASE, fmtUsd, fmtUsdAbs, getDailyChange, isPrimeBubble,
 * entryType, getActionDescription, rankScoreForTicker, getRankedTickers, getRankPosition,
 * getRankPositionFromMap, detectPatterns, normalizeTrailPoints, phaseToColor, completionForSize,
 * computeHorizonBucket, computeEtaDays, computeReturnPct, computeRiskPct, computeTpTargetPrice,
 * computeTpMaxPrice, summarizeEntryDecision, getDirectionFromState, getDirection, numFromAny,
 * groupsForTicker, GROUP_ORDER, GROUP_LABELS, TRADE_SIZE, FUTURES_SPECS, getStaleInfo,
 * isNyRegularMarketOpen, downsampleByInterval, getTickerSector,
 * normalizeSectorKey, sectorKeyToCanonicalName.
 */
(function () {
  window.TickerDetailRightRailFactory = function (deps) {
    const React = deps.React;
    const {
      useState,
      useEffect,
      useMemo,
      useRef
    } = React;
    const API_BASE = deps.API_BASE;
    const getTickerSector = deps.getTickerSector || (() => "");
    const sectorNorm = deps.normalizeSectorKey != null && typeof deps.normalizeSectorKey === "function" ? deps.normalizeSectorKey : s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
    const sectorCanon = deps.sectorKeyToCanonicalName != null && typeof deps.sectorKeyToCanonicalName === "function" ? deps.sectorKeyToCanonicalName : k => k || "";
    const fmtUsd = deps.fmtUsd != null && typeof deps.fmtUsd === "function" ? deps.fmtUsd : v => Number.isFinite(Number(v)) ? new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2
    }).format(Number(v)) : "—";
    const fmtUsdAbs = deps.fmtUsdAbs != null && typeof deps.fmtUsdAbs === "function" ? deps.fmtUsdAbs : n => Number.isFinite(Number(n)) ? `$${Math.abs(Number(n)).toFixed(2)}` : "—";
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

    // ═══════════════════════════════════════════════════════════════════════
    // TradingView Lightweight Charts Sub-Component for Right Rail
    // ═══════════════════════════════════════════════════════════════════════
    function LWChart({
      candles: rawCandles,
      chartTf,
      overlays,
      onCrosshair,
      height: propHeight
    }) {
      const containerRef = useRef(null);
      const chartInstanceRef = useRef(null);
      const candleSeriesRef = useRef(null);
      const overlaySeriesRef = useRef({});
      const [ohlcHeader, setOhlcHeader] = useState(null);
      const LWC = typeof LightweightCharts !== "undefined" ? LightweightCharts : null;

      // Normalize candles
      const mapped = useMemo(() => {
        if (!rawCandles || rawCandles.length < 2) return [];
        const toSec = v => {
          if (!v) return 0;
          const n = Number(v);
          return n > 1e12 ? Math.floor(n / 1000) : n > 1e9 ? n : 0;
        };
        return rawCandles.map(c => {
          const ts = toSec(c.ts ?? c.t ?? c.time ?? c.timestamp);
          const o = Number(c.o ?? c.open);
          const h = Number(c.h ?? c.high);
          const l = Number(c.l ?? c.low);
          const cl = Number(c.c ?? c.close);
          if (!ts || !Number.isFinite(o) || !Number.isFinite(h)) return null;
          return {
            time: ts,
            open: o,
            high: h,
            low: l,
            close: cl
          };
        }).filter(Boolean).sort((a, b) => a.time - b.time)
        // Deduplicate timestamps (keep last)
        .filter((c, i, arr) => i === arr.length - 1 || c.time !== arr[i + 1].time);
      }, [rawCandles]);

      // Compute indicator overlays
      const indicatorData = useMemo(() => {
        if (mapped.length < 5) return {};
        const closes = mapped.map(c => c.close);
        const highs = mapped.map(c => c.high);
        const lows = mapped.map(c => c.low);
        const n = closes.length;
        const result = {};

        // EMA computation
        const computeEMA = (data, period) => {
          const k = 2 / (period + 1);
          const out = new Array(data.length).fill(null);
          if (data.length >= period) {
            let s = 0;
            for (let j = 0; j < period; j++) s += data[j];
            out[period - 1] = s / period;
            for (let j = period; j < data.length; j++) out[j] = data[j] * k + out[j - 1] * (1 - k);
          } else {
            out[0] = data[0];
            for (let j = 1; j < data.length; j++) out[j] = data[j] * k + out[j - 1] * (1 - k);
          }
          return out;
        };
        if (overlays.ema21) {
          const ema = computeEMA(closes, 21);
          result.ema21 = mapped.map((c, i) => ema[i] != null ? {
            time: c.time,
            value: ema[i]
          } : null).filter(Boolean);
        }
        if (overlays.ema48) {
          const ema = computeEMA(closes, 48);
          result.ema48 = mapped.map((c, i) => ema[i] != null ? {
            time: c.time,
            value: ema[i]
          } : null).filter(Boolean);
        }
        if (overlays.ema200) {
          const ema = computeEMA(closes, 200);
          result.ema200 = mapped.map((c, i) => ema[i] != null ? {
            time: c.time,
            value: ema[i]
          } : null).filter(Boolean);
        }

        // SuperTrend (period=10, multiplier=3)
        if (overlays.supertrend && n >= 11) {
          const stP = 10,
            stM = 3;
          const tr = new Array(n).fill(0);
          for (let i = 1; i < n; i++) tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
          const atr = new Array(n).fill(0);
          for (let i = stP; i < n; i++) {
            let s = 0;
            for (let j = i - stP; j < i; j++) s += tr[j + 1];
            atr[i] = s / stP;
          }
          const upArr = [],
            dnArr = [],
            dirArr = [];
          for (let i = 0; i < n; i++) {
            upArr.push(0);
            dnArr.push(0);
            dirArr.push(1);
          }
          for (let i = stP; i < n; i++) {
            const mid = (highs[i] + lows[i]) / 2;
            let up = mid - stM * atr[i];
            let dn = mid + stM * atr[i];
            if (i > stP) {
              up = closes[i - 1] > upArr[i - 1] ? Math.max(up, upArr[i - 1]) : up;
              dn = closes[i - 1] < dnArr[i - 1] ? Math.min(dn, dnArr[i - 1]) : dn;
            }
            upArr[i] = up;
            dnArr[i] = dn;
            if (i > stP) {
              if (dirArr[i - 1] === 1) dirArr[i] = closes[i] < upArr[i] ? -1 : 1;else dirArr[i] = closes[i] > dnArr[i] ? 1 : -1;
            }
          }
          // SuperTrend as two separate series (bull/bear) for coloring
          result.stBull = mapped.map((c, i) => i >= stP && dirArr[i] === 1 ? {
            time: c.time,
            value: upArr[i]
          } : null).filter(Boolean);
          result.stBear = mapped.map((c, i) => i >= stP && dirArr[i] === -1 ? {
            time: c.time,
            value: dnArr[i]
          } : null).filter(Boolean);
        }

        // TD Sequential
        if (overlays.tdSequential && n >= 14) {
          const PREP_COMP = 4;
          let bullPrep = 0,
            bearPrep = 0;
          const markers = [];
          for (let i = PREP_COMP; i < n; i++) {
            const cc = closes[i];
            const cComp = closes[i - PREP_COMP];
            bullPrep = cc < cComp ? bullPrep + 1 : 0;
            bearPrep = cc > cComp ? bearPrep + 1 : 0;
            if (bullPrep >= 7 || bearPrep >= 7) {
              const count = bullPrep >= 7 ? bullPrep : bearPrep;
              const isBull = bullPrep >= 7;
              if (count >= 7 && count <= 9) {
                markers.push({
                  time: mapped[i].time,
                  position: isBull ? "belowBar" : "aboveBar",
                  color: isBull ? "#22c55e" : "#ef4444",
                  shape: count === 9 ? "circle" : "arrowUp",
                  text: String(count)
                });
              }
            }
          }
          result.tdMarkers = markers;
        }
        return result;
      }, [mapped, overlays]);

      // Create / update chart
      useEffect(() => {
        if (!containerRef.current || !LWC || mapped.length < 2) return;

        // Create chart
        const chartHeight = propHeight || 320;
        const chart = LWC.createChart(containerRef.current, {
          width: containerRef.current.clientWidth,
          height: chartHeight,
          layout: {
            background: {
              type: "solid",
              color: "#0b0e11"
            },
            textColor: "#6b7280",
            fontSize: 10
          },
          grid: {
            vertLines: {
              color: "rgba(38,50,95,0.35)"
            },
            horzLines: {
              color: "rgba(38,50,95,0.35)"
            }
          },
          crosshair: {
            mode: LWC.CrosshairMode.Normal,
            vertLine: {
              color: "rgba(255,255,255,0.15)",
              width: 1,
              style: 2,
              labelBackgroundColor: "#1e293b"
            },
            horzLine: {
              color: "rgba(255,255,255,0.15)",
              width: 1,
              style: 2,
              labelBackgroundColor: "#1e293b"
            }
          },
          rightPriceScale: {
            borderColor: "rgba(38,50,95,0.5)",
            scaleMargins: {
              top: 0.05,
              bottom: 0.05
            }
          },
          timeScale: {
            borderColor: "rgba(38,50,95,0.5)",
            timeVisible: !["D", "W", "M"].includes(String(chartTf)),
            secondsVisible: false,
            tickMarkFormatter: time => {
              try {
                const d = new Date(time * 1000);
                return d.toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: "America/New_York"
                });
              } catch {
                return "";
              }
            }
          },
          localization: {
            timeFormatter: time => {
              try {
                const d = new Date(time * 1000);
                return d.toLocaleString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                  second: "2-digit",
                  timeZone: "America/New_York"
                });
              } catch {
                return "";
              }
            }
          },
          handleScroll: {
            vertTouchDrag: false
          }
        });
        chartInstanceRef.current = chart;

        // Candlestick series — standardized colors across all charts
        const candleSeries = chart.addCandlestickSeries({
          upColor: "#22c55e",
          downColor: "#ef4444",
          borderUpColor: "#22c55e",
          borderDownColor: "#ef4444",
          wickUpColor: "#22c55e",
          wickDownColor: "#ef4444"
        });
        candleSeries.setData(mapped);
        candleSeriesRef.current = candleSeries;

        // Overlay series
        const addedSeries = {};
        if (indicatorData.ema21?.length > 0) {
          const s = chart.addLineSeries({
            color: "#fbbf24",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false
          });
          s.setData(indicatorData.ema21);
          addedSeries.ema21 = s;
        }
        if (indicatorData.ema48?.length > 0) {
          const s = chart.addLineSeries({
            color: "#a78bfa",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false
          });
          s.setData(indicatorData.ema48);
          addedSeries.ema48 = s;
        }
        if (indicatorData.ema200?.length > 0) {
          const s = chart.addLineSeries({
            color: "#f87171",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false
          });
          s.setData(indicatorData.ema200);
          addedSeries.ema200 = s;
        }
        if (indicatorData.stBull?.length > 0) {
          const s = chart.addLineSeries({
            color: "#34d399",
            lineWidth: 2,
            lineStyle: LWC.LineStyle.Dotted,
            priceLineVisible: false,
            lastValueVisible: false
          });
          s.setData(indicatorData.stBull);
          addedSeries.stBull = s;
        }
        if (indicatorData.stBear?.length > 0) {
          const s = chart.addLineSeries({
            color: "#f87171",
            lineWidth: 2,
            lineStyle: LWC.LineStyle.Dotted,
            priceLineVisible: false,
            lastValueVisible: false
          });
          s.setData(indicatorData.stBear);
          addedSeries.stBear = s;
        }
        // TD Sequential markers
        if (indicatorData.tdMarkers?.length > 0) {
          candleSeries.setMarkers(indicatorData.tdMarkers);
        }
        overlaySeriesRef.current = addedSeries;

        // Crosshair move → OHLC header
        chart.subscribeCrosshairMove(param => {
          if (!param.time || !param.seriesData) {
            setOhlcHeader(null);
            return;
          }
          const candleData = param.seriesData.get(candleSeries);
          if (candleData) {
            setOhlcHeader({
              time: param.time,
              o: candleData.open,
              h: candleData.high,
              l: candleData.low,
              c: candleData.close
            });
          }
        });
        chart.timeScale().fitContent();

        // Resize — use ResizeObserver for portal/modal mount detection + window fallback
        let resizeObserver = null;
        const handleResize = () => {
          if (containerRef.current && chart) {
            const w = containerRef.current.clientWidth;
            if (w > 0) {
              chart.applyOptions({
                width: w
              });
            }
          }
        };
        if (typeof ResizeObserver !== "undefined" && containerRef.current) {
          resizeObserver = new ResizeObserver(handleResize);
          resizeObserver.observe(containerRef.current);
        }
        window.addEventListener("resize", handleResize);

        // Settle: when chart mounts inside a React portal (expanded modal),
        // the container may not have its final width yet. Use rAF to sync.
        requestAnimationFrame(() => {
          if (containerRef.current && chart) {
            const w = containerRef.current.clientWidth;
            if (w > 0) {
              chart.applyOptions({
                width: w
              });
            }
            chart.timeScale().fitContent();
          }
          // Safety net for slow portal reflow
          setTimeout(() => {
            if (containerRef.current && chart) {
              const w = containerRef.current.clientWidth;
              if (w > 0) {
                chart.applyOptions({
                  width: w
                });
              }
            }
          }, 150);
        });
        return () => {
          window.removeEventListener("resize", handleResize);
          if (resizeObserver) resizeObserver.disconnect();
          chart.remove();
          chartInstanceRef.current = null;
          candleSeriesRef.current = null;
          overlaySeriesRef.current = {};
        };
      }, [mapped, indicatorData, chartTf, LWC, propHeight]);
      if (!LWC) {
        return React.createElement("div", {
          className: "text-xs text-[#6b7280]"
        }, "Charts library not loaded.");
      }

      // OHLC header data
      const hdr = ohlcHeader || (mapped.length > 0 ? {
        time: mapped[mapped.length - 1].time,
        o: mapped[mapped.length - 1].open,
        h: mapped[mapped.length - 1].high,
        l: mapped[mapped.length - 1].low,
        c: mapped[mapped.length - 1].close
      } : null);
      const hdrUp = hdr ? hdr.c >= hdr.o : true;
      const hdrChg = hdr ? hdr.c - hdr.o : 0;
      const hdrPct = hdr && hdr.o ? hdrChg / hdr.o * 100 : 0;

      // Format time
      let hdrTimeStr = "";
      if (hdr) {
        try {
          const d = new Date(hdr.time * 1000);
          const isDWM = ["D", "W", "M"].includes(String(chartTf));
          hdrTimeStr = isDWM ? d.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            timeZone: "America/New_York"
          }) : d.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/New_York"
          }) + " ET";
        } catch {}
      }
      return React.createElement("div", {
        className: "w-full relative -mx-3 px-3"
      },
      // Overlay toggles
      React.createElement("div", {
        className: "flex items-center gap-1.5 mb-1 flex-wrap"
      }, [{
        key: "ema21",
        label: "21 EMA",
        color: "#fbbf24"
      }, {
        key: "ema48",
        label: "48 EMA",
        color: "#a78bfa"
      }, {
        key: "ema200",
        label: "200 EMA",
        color: "#f87171"
      }, {
        key: "supertrend",
        label: "SuperTrend",
        color: "#34d399"
      }, {
        key: "tdSequential",
        label: "TD Seq",
        color: "#f59e0b"
      }].map(ov => React.createElement("button", {
        key: ov.key,
        onClick: () => onCrosshair?.(ov.key),
        // toggle overlay via parent
        className: `px-2 py-0.5 rounded text-[9px] font-semibold border transition-all ${overlays[ov.key] ? "border-white/20 text-white" : "border-white/[0.06] text-[#555] hover:text-[#6b7280]"}`,
        style: overlays[ov.key] ? {
          borderColor: ov.color + "80",
          color: ov.color,
          background: ov.color + "15"
        } : {}
      }, ov.label))),
      // OHLC header
      hdr && React.createElement("div", {
        className: "flex items-center gap-2 mb-0.5 text-[10px] font-mono h-5 select-none"
      }, React.createElement("span", {
        className: "text-[#6b7280]"
      }, hdrTimeStr), React.createElement("span", {
        className: "text-[#6b7280]"
      }, "O"), React.createElement("span", {
        className: "text-white"
      }, hdr.o?.toFixed(2)), React.createElement("span", {
        className: "text-[#6b7280]"
      }, "H"), React.createElement("span", {
        className: "text-sky-300"
      }, hdr.h?.toFixed(2)), React.createElement("span", {
        className: "text-[#6b7280]"
      }, "L"), React.createElement("span", {
        className: "text-orange-300"
      }, hdr.l?.toFixed(2)), React.createElement("span", {
        className: "text-[#6b7280]"
      }, "C"), React.createElement("span", {
        className: hdrUp ? "text-teal-400 font-semibold" : "text-rose-400 font-semibold"
      }, hdr.c?.toFixed(2)), React.createElement("span", {
        className: hdrUp ? "text-teal-400" : "text-rose-400"
      }, `${hdrUp ? "+" : ""}${hdrChg.toFixed(2)} (${hdrUp ? "+" : ""}${hdrPct.toFixed(2)}%)`)),
      // Chart container
      React.createElement("div", {
        ref: containerRef,
        className: "rounded-lg overflow-hidden",
        style: {
          height: propHeight || 320,
          background: "#0b0e11"
        }
      }),
      // Status bar
      React.createElement("div", {
        className: "mt-1 text-[10px] text-[#6b7280] flex items-center justify-between"
      }, React.createElement("span", null, `${["D", "W", "M"].includes(String(chartTf)) ? chartTf === "D" ? "Daily" : chartTf === "W" ? "Weekly" : "Monthly" : Number(chartTf) >= 60 ? `${Number(chartTf) / 60}H` : `${chartTf}m`} • ${mapped.length} bars`), React.createElement("span", {
        className: "text-[#555] text-[9px]"
      }, "scroll to zoom • drag to pan")));
    }
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
      effectiveStage = null
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

      // Candle-based performance data (5D/15D/30D/90D from daily candles)
      const [candlePerf, setCandlePerf] = useState(null);
      const [candlePerfLoading, setCandlePerfLoading] = useState(false);
      const [railTab, setRailTab] = useState("ANALYSIS"); // ANALYSIS | TECHNICALS | MODEL | JOURNEY | TRADE_HISTORY

      // Right Rail: multi-timeframe candles chart (fetched on-demand)
      const [chartTf, setChartTf] = useState("10"); // Default to 10m
      const [chartCandles, setChartCandles] = useState([]);
      const [chartLoading, setChartLoading] = useState(false);
      const [chartError, setChartError] = useState(null);
      const [crosshair, setCrosshair] = useState(null);
      const chartScrollRef = useRef(null);
      // TradingView-style zoom & pan state
      const [chartVisibleCount, setChartVisibleCount] = useState(80); // candles visible
      const [chartEndOffset, setChartEndOffset] = useState(0); // 0 = pinned to latest
      const chartContainerRef = useRef(null);
      const chartDragRef = useRef(null); // { startX, startOffset }
      const chartStateRef = useRef({
        totalCandles: 0,
        visCount: 80,
        startIdx: 0,
        vn: 0,
        candleStep: 0,
        leftMargin: 10,
        plotW: 0
      });

      // Native (non-passive) wheel listener for zoom — React onWheel is passive and ignores preventDefault
      useEffect(() => {
        const el = chartContainerRef.current;
        if (!el) return;
        const onWheel = e => {
          e.preventDefault();
          e.stopPropagation();
          const {
            totalCandles,
            visCount,
            startIdx,
            vn,
            candleStep,
            leftMargin,
            plotW
          } = chartStateRef.current;
          if (totalCandles < 2 || plotW <= 0) return;
          const delta = e.deltaY;
          const zoomSpeed = Math.max(1, Math.round(visCount * 0.1));
          const newCount = delta > 0 ? Math.min(totalCandles, visCount + zoomSpeed) : Math.max(10, visCount - zoomSpeed);
          const svgRect = el.getBoundingClientRect();
          const mouseXFrac = Math.max(0, Math.min(1, (e.clientX - svgRect.left - leftMargin) / plotW));
          const candleUnderMouse = startIdx + Math.round(mouseXFrac * vn);
          const newLeft = Math.max(0, Math.min(totalCandles - newCount, candleUnderMouse - Math.round(mouseXFrac * newCount)));
          const newEnd = newLeft + newCount;
          const newEndOff = Math.max(0, totalCandles - newEnd);
          setChartVisibleCount(newCount);
          setChartEndOffset(newEndOff);
        };
        el.addEventListener("wheel", onWheel, {
          passive: false
        });
        return () => el.removeEventListener("wheel", onWheel);
      });

      // Window-level mousemove/mouseup for robust drag-to-pan
      useEffect(() => {
        const onMove = e => {
          if (!chartDragRef.current) return;
          const {
            totalCandles,
            visCount,
            candleStep
          } = chartStateRef.current;
          if (candleStep <= 0) return;
          const dx = e.clientX - chartDragRef.current.startX;
          const candlesPanned = Math.round(dx / candleStep);
          const newOffset = Math.max(0, Math.min(totalCandles - visCount, chartDragRef.current.startOffset + candlesPanned));
          setChartEndOffset(newOffset);
        };
        const onUp = () => {
          chartDragRef.current = null;
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
      }, []);

      // Model signal data (ticker + sector + market level)
      const [modelSignal, setModelSignal] = useState(null);
      const [chartOverlays, setChartOverlays] = useState({
        ema21: true,
        ema48: true,
        ema200: false,
        supertrend: false,
        tdSequential: false
      });
      const [chartExpanded, setChartExpanded] = useState(false);

      // Close expanded chart on Escape
      useEffect(() => {
        if (!chartExpanded) return;
        const onKey = e => {
          if (e.key === "Escape") setChartExpanded(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [chartExpanded]);

      // Accordion states (MUST be at component level, not inside IIFE blocks)
      const [scoreExpanded, setScoreExpanded] = useState(true);
      const [emaExpanded, setEmaExpanded] = useState(true);
      const [tpExpanded, setTpExpanded] = useState(true);

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
        setChartVisibleCount(80);
        setChartEndOffset(0);
      }, [tickerSymbol]);

      // Reset zoom/pan on timeframe change
      useEffect(() => {
        setChartVisibleCount(80);
        setChartEndOffset(0);
      }, [chartTf]);

      // Auto-scroll chart to most recent candle when data loads
      // Use multiple attempts with cleanup to handle rendering timing
      useEffect(() => {
        if (chartCandles.length > 0 && railTab === "ANALYSIS") {
          const scrollToEnd = () => {
            if (chartScrollRef.current) {
              chartScrollRef.current.scrollLeft = chartScrollRef.current.scrollWidth;
            }
          };
          // Immediate attempt
          scrollToEnd();
          // Delayed attempts for after layout computation
          const t1 = setTimeout(scrollToEnd, 50);
          const t2 = setTimeout(scrollToEnd, 200);
          const t3 = setTimeout(scrollToEnd, 500);
          // Use requestAnimationFrame for after-render scroll
          const raf1 = requestAnimationFrame(() => {
            scrollToEnd();
            requestAnimationFrame(scrollToEnd);
          });
          return () => {
            clearTimeout(t1);
            clearTimeout(t2);
            clearTimeout(t3);
            cancelAnimationFrame(raf1);
          };
        }
      }, [chartCandles.length, railTab, chartTf]);

      // In-memory candle cache: key = "TICKER:TF", value = { data, ts }
      const candleCacheRef = useRef({});
      useEffect(() => {
        const sym = String(tickerSymbol || "").trim().toUpperCase();
        if (railTab !== "ANALYSIS" || !sym) return;
        let cancelled = false;
        const run = async () => {
          try {
            setChartLoading(true);
            setChartError(null);
            const tf = String(chartTf || "30");
            const cacheKey = `${sym}:${tf}`;

            // Check cache (60-second TTL)
            const cached = candleCacheRef.current[cacheKey];
            if (cached && Date.now() - cached.ts < 60000) {
              if (!cancelled) setChartCandles(cached.data);
              if (!cancelled) setChartLoading(false);
              return;
            }
            const qs = new URLSearchParams();
            qs.set("ticker", sym);
            qs.set("tf", tf);
            qs.set("limit", "500");
            const res = await fetch(`${API_BASE}/timed/candles?${qs.toString()}`, {
              cache: "no-store"
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.ok) throw new Error(json.error || "candles_failed");
            const candles = Array.isArray(json.candles) ? json.candles : [];
            // Store in cache
            candleCacheRef.current[cacheKey] = {
              data: candles,
              ts: Date.now()
            };
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
        const sym = String(tickerSymbol || "").trim().toUpperCase();
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
            const res = await fetch(`${API_BASE}/timed/latest?${qs.toString()}`, {
              cache: "no-store"
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.ok) throw new Error(json.error || "latest_failed");
            const data = (json.latestData && typeof json.latestData === "object" ? json.latestData : json.data && typeof json.data === "object" ? json.data : null) || null;
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

      // Fetch model signals (ticker + sector + market level)
      useEffect(() => {
        const sym = String(tickerSymbol || "").trim().toUpperCase();
        if (!sym) {
          setModelSignal(null);
          return;
        }
        let cancelled = false;
        (async () => {
          try {
            const res = await fetch(`${API_BASE}/timed/model/signals`, {
              cache: "no-store"
            });
            if (!res.ok) return;
            const json = await res.json();
            if (!json.ok || cancelled) return;
            const tickerSig = (json.ticker || []).find(t => t.ticker === sym);
            const src = latestTicker || ticker;
            const sectorName = src?.sector || tickerSig?.sector || "";
            const sectorSig = (json.sector || []).find(s => s.sector === sectorName);
            setModelSignal({
              ticker: tickerSig || null,
              sector: sectorSig || null,
              market: json.market || null,
              patternMatch: src?.pattern_match || null
            });
          } catch {/* model signals are a boost, not a gate */}
        })();
        return () => {
          cancelled = true;
        };
      }, [tickerSymbol, latestTicker]);
      useEffect(() => {
        const sym = String(tickerSymbol || "").trim().toUpperCase();
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
            const res = await fetch(`${API_BASE}/timed/ledger/trades?${qs.toString()}`, {
              cache: "no-store"
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.ok) throw new Error(json.error || "ledger_trades_failed");
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
        const sym = String(tickerSymbol || "").trim().toUpperCase();
        if (!sym) {
          setBubbleJourney([]);
          setBubbleJourneyError(null);
          setBubbleJourneyLoading(false);
          return;
        }
        let cancelled = false;
        const toMs = v => {
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
            qs.set("limit", "500");
            const res = await fetch(`${API_BASE}/timed/trail?${qs.toString()}`, {
              cache: "no-store"
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.ok) throw new Error(json.error || "trail_failed");
            const raw = Array.isArray(json.trail) ? json.trail : [];
            const normalized = normalizeTrailPoints(raw);
            const withTs = normalized.map(p => {
              const ts = toMs(p.ts ?? p.timestamp ?? p.ingest_ts ?? p.ingest_time);
              if (!Number.isFinite(ts)) return null;
              return {
                ...p,
                __ts_ms: ts
              };
            }).filter(Boolean).sort((a, b) => a.__ts_ms - b.__ts_ms);
            // Keep last 200 for bubble journey table (which self-limits via downsample + slice)
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

        // Also fetch candle-based performance (lightweight, separate from trail)
        const fetchCandlePerf = async () => {
          try {
            setCandlePerfLoading(true);
            const res = await fetch(`${API_BASE}/timed/trail/performance?ticker=${encodeURIComponent(sym)}`, {
              cache: "no-store"
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (json.ok && json.performance) {
              if (!cancelled) setCandlePerf(json);
            }
          } catch {
            // Non-critical: performance section will just not render
          } finally {
            if (!cancelled) setCandlePerfLoading(false);
          }
        };
        fetchCandlePerf();
        return () => {
          cancelled = true;
        };
      }, [tickerSymbol]);
      const safeTicker = ticker && typeof ticker === "object" ? ticker : null;
      const patternFlags = safeTicker?.flags || {};

      // IMPORTANT: Keep hooks unconditional (no early returns before hooks),
      // otherwise React will throw "Rendered more hooks than during the previous render".
      const detectedPatterns = React.useMemo(() => detectPatterns(bubbleJourney, patternFlags || {}), [bubbleJourney, patternFlags]);
      if (!safeTicker || !tickerSymbol) return null;

      // ── Unified direction — single source of truth for the entire Right Rail ──
      // Priority: 1) trade.direction  2) ticker.position_direction  3) HTF state  4) state fallback
      const resolvedDir = (() => {
        // 1. Explicit trade direction (most authoritative)
        const tradeDirStr = String(trade?.direction || "").toUpperCase();
        const tradeStatus = String(trade?.status || "").toUpperCase();
        const tradeIsOpen = trade && (tradeStatus === "OPEN" || tradeStatus === "TP_HIT_TRIM" || !(trade?.exit_ts ?? trade?.exitTs) && tradeStatus !== "WIN" && tradeStatus !== "LOSS");
        if (tradeIsOpen && (tradeDirStr === "LONG" || tradeDirStr === "SHORT")) return tradeDirStr;
        // 2. Server-provided position direction
        const posDirStr = String(ticker?.position_direction || "").toUpperCase();
        if (ticker?.has_open_position && (posDirStr === "LONG" || posDirStr === "SHORT")) return posDirStr;
        // 3. HTF state (primary trend)
        const state = String(ticker?.state || "");
        if (state.startsWith("HTF_BULL")) return "LONG";
        if (state.startsWith("HTF_BEAR")) return "SHORT";
        // 4. Fallback for non-standard states
        if (state.includes("BULL")) return "LONG";
        if (state.includes("BEAR")) return "SHORT";
        return null;
      })();
      const prime = isPrimeBubble(ticker);
      const ent = entryType(ticker);
      const flags = patternFlags;
      const phase = Number(ticker.phase_pct) || 0;
      const phaseColor = phaseToColor(phase);
      const actionInfo = getActionDescription(ticker, trade);
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
            const uncorroborated = ticker.trigger_reason_corroborated === false && (trigReason === "EMA_CROSS_1H_13_48" || trigReason === "EMA_CROSS_30M_13_48");
            items.push(trigTf ? `${trigReason}${trigDir ? " (" + trigDir + ")" : ""} [${trigTf}]${uncorroborated ? " ⚠️ unconfirmed" : ""}` : `${trigReason}${trigDir ? " (" + trigDir + ")" : ""}${uncorroborated ? " ⚠️ unconfirmed" : ""}`);
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
      const tfTech = ticker.tf_tech && typeof ticker.tf_tech === "object" ? ticker.tf_tech : null;
      const tfOrder = [{
        k: "W",
        label: "W"
      }, {
        k: "D",
        label: "D"
      }, {
        k: "4H",
        label: "4H"
      }, {
        k: "1H",
        label: "1H"
      }, {
        k: "30",
        label: "30m"
      }, {
        k: "10",
        label: "10m"
      }, {
        k: "3",
        label: "3m"
      }];
      const emaLevels = [5, 13, 21, 48, 89, 200, 233];
      const divIcon = code => code === "B" ? "🐂" : code === "S" ? "🐻" : "";
      const phaseDotLabel = code => {
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
      const sortedByRank = rankedTickers && rankedTickers.length > 0 ? rankedTickers : getRankedTickers(allLoadedData);
      const rankPosition = getRankPositionFromMap(rankedTickerPositions, tickerSymbol) ?? getRankPosition(sortedByRank, tickerSymbol);
      const totalTickers = sortedByRank.length;
      const rankTotal = Number.isFinite(Number(ticker.rank_total)) && Number(ticker.rank_total) > 0 ? Number(ticker.rank_total) : totalTickers;
      const rankAsOfText = (() => {
        const ms = Number(rankAsOfMs);
        if (!Number.isFinite(ms)) return null;
        try {
          return new Date(ms).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true
          });
        } catch {
          return null;
        }
      })();
      return /*#__PURE__*/React.createElement("div", {
        className: "w-full h-full flex flex-col"
      }, /*#__PURE__*/React.createElement("div", {
        className: "bg-[#0b0e11] border border-white/[0.04] rounded-xl w-full h-full flex flex-col shadow-xl",
        onClick: e => e.stopPropagation()
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex-1 overflow-y-auto"
      }, /*#__PURE__*/React.createElement("div", {
        className: "sticky top-0 z-30 bg-[#0b0e11] border-b border-white/[0.04] px-5 py-3"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-start justify-between"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-2 flex-wrap min-w-0"
      }, /*#__PURE__*/React.createElement("h3", {
        className: "text-xl font-bold leading-none"
      }, tickerSymbol), (() => {
        const d = resolvedDir;
        const color = d === "LONG" ? "text-teal-400" : d === "SHORT" ? "text-rose-400" : "text-[#6b7280]";
        const bg = d === "LONG" ? "bg-teal-500/20" : d === "SHORT" ? "bg-rose-500/20" : "bg-white/[0.04]";
        const label = d === "LONG" ? "📈 LONG" : d === "SHORT" ? "📉 SHORT" : "—";
        return /*#__PURE__*/React.createElement("span", {
          className: `inline-block px-2 py-0.5 rounded-md font-bold text-xs ${bg} ${color} border border-current/30`
        }, label);
      })(), document.body.dataset.userRole === "admin" && (() => {
        const src = latestTicker || ticker;
        const price = Number(src?._live_price || src?.price || src?.close || 0);
        if (!price) return null;
        const priceAge = src._price_updated_at ? (Date.now() - src._price_updated_at) / 60000 : Infinity;
        const scoreAge = src.data_source_ts ? (Date.now() - src.data_source_ts) / 60000 : Infinity;
        const freshestAge = Math.min(priceAge, scoreAge);
        return /*#__PURE__*/React.createElement("span", {
          className: "text-sm text-white font-semibold flex items-center gap-1"
        }, "$", price.toFixed(2), freshestAge <= 2 ? /*#__PURE__*/React.createElement("span", {
          className: "inline-block w-1.5 h-1.5 rounded-full bg-green-400",
          title: `Updated ${Math.round(freshestAge)}m ago`
        }) : freshestAge <= 10 ? /*#__PURE__*/React.createElement("span", {
          className: "inline-block w-1.5 h-1.5 rounded-full bg-amber-400",
          title: `Updated ${Math.round(freshestAge)}m ago`
        }) : /*#__PURE__*/React.createElement("span", {
          className: "inline-block w-1.5 h-1.5 rounded-full bg-red-400",
          title: `Updated ${Math.round(freshestAge)}m ago`
        }));
      })(), document.body.dataset.userRole === "admin" && (() => {
        const src = latestTicker || ticker;
        const {
          dayChg,
          dayPct,
          stale,
          marketOpen
        } = getDailyChange(src);
        if (!Number.isFinite(dayChg) && !Number.isFinite(dayPct)) return null;
        const sign = Number(dayChg || dayPct || 0) >= 0 ? "+" : "-";
        const cls = Number(dayChg || dayPct || 0) >= 0 ? "text-green-400" : "text-red-400";
        const ahPct = Number(src?._ah_change_pct);
        const ahChg = Number(src?._ah_change);
        const hasAH = Number.isFinite(ahPct) && ahPct !== 0;
        return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
          className: `text-xs font-semibold ${cls}`
        }, Number.isFinite(dayChg) ? `${sign}${fmtUsdAbs(dayChg)}` : "", " ", Number.isFinite(dayPct) ? `(${sign}${Math.abs(dayPct).toFixed(2)}%)` : ""), hasAH && /*#__PURE__*/React.createElement("span", {
          className: `text-[10px] font-medium ${ahPct >= 0 ? "text-green-400" : "text-red-400"}`
        }, ahPct >= 0 ? "+" : "", ahPct.toFixed(2), "%", Number.isFinite(ahChg) ? ` ${ahChg >= 0 ? "+" : ""}$${Math.abs(ahChg).toFixed(2)}` : "", /*#__PURE__*/React.createElement("span", {
          className: "ml-0.5 text-[9px] text-[#6b7280]"
        }, "AH")));
      })()), /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-0.5 shrink-0 ml-2"
      }, /*#__PURE__*/React.createElement("button", {
        onClick: () => {
          try {
            const sym = String(ticker?.ticker || "").toUpperCase();
            const url = `${window.location.origin}${window.location.pathname}#ticker=${encodeURIComponent(sym)}`;
            if (navigator.share) {
              navigator.share({
                title: `${sym} — Timed Trading`,
                url
              }).catch(() => {
                navigator.clipboard.writeText(url);
              });
            } else {
              navigator.clipboard.writeText(url).then(() => {
                const btn = document.getElementById("share-toast-btn");
                if (btn) {
                  btn.textContent = "Copied!";
                  setTimeout(() => {
                    btn.textContent = "";
                  }, 1500);
                }
              });
            }
          } catch {}
        },
        id: "share-toast-btn",
        className: "text-[#6b7280] hover:text-teal-300 transition-colors p-1.5 rounded hover:bg-white/[0.04]",
        title: "Share this ticker"
      }, /*#__PURE__*/React.createElement("svg", {
        xmlns: "http://www.w3.org/2000/svg",
        width: "14",
        height: "14",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "2",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }, /*#__PURE__*/React.createElement("path", {
        d: "M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"
      }), /*#__PURE__*/React.createElement("polyline", {
        points: "16 6 12 2 8 6"
      }), /*#__PURE__*/React.createElement("line", {
        x1: "12",
        y1: "2",
        x2: "12",
        y2: "15"
      }))), /*#__PURE__*/React.createElement("button", {
        onClick: onClose,
        className: "text-[#6b7280] hover:text-white transition-colors text-lg leading-none w-7 h-7 flex items-center justify-center rounded hover:bg-white/[0.04]"
      }, "\u2715"))), (() => {
        const stage = String(ticker?.kanban_stage || "");
        const showEntryStats = ["enter_now", "hold", "just_entered", "trim", "exit"].includes(stage);
        if (!showEntryStats) return null;
        const price = numFromAny(ticker?.price);
        const entryPriceRaw = numFromAny(ticker?.entry_price);
        const entryRefRaw = numFromAny(ticker?.entry_ref);
        const triggerRaw = numFromAny(ticker?.trigger_price);
        const entryPx = [entryPriceRaw, entryRefRaw, triggerRaw].find(v => Number.isFinite(v) && v > 0) || null;
        const dir = resolvedDir; // unified direction
        const entryPctRaw = numFromAny(ticker?.entry_change_pct);
        const entryPct = Number.isFinite(entryPctRaw) ? entryPctRaw : entryPx > 0 && price > 0 ? dir === "SHORT" ? (entryPx - price) / entryPx * 100 : (price - entryPx) / entryPx * 100 : null;
        if (!Number.isFinite(entryPx) && !Number.isFinite(entryPct)) return null;
        return /*#__PURE__*/React.createElement("div", {
          className: "text-[11px] mt-1 text-cyan-300/90"
        }, Number.isFinite(entryPx) ? `Entry $${Number(entryPx).toFixed(2)}` : "Entry —", Number.isFinite(entryPct) ? ` • Since entry ${entryPct >= 0 ? "+" : ""}${entryPct.toFixed(2)}%` : "");
      })(), /*#__PURE__*/React.createElement("div", {
        className: "mt-2 flex items-center gap-3 flex-wrap text-[10px]"
      }, (() => {
        try {
          const gs = groupsForTicker(ticker.ticker);
          if (!Array.isArray(gs) || gs.length === 0) return null;
          const ordered = Array.isArray(GROUP_ORDER) ? [...gs].sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b)) : gs;
          const seen = new Set();
          return ordered.map(g => {
            const label = GROUP_LABELS[g] || g;
            if (seen.has(label)) return null;
            seen.add(label);
            return /*#__PURE__*/React.createElement("span", {
              key: `group-${g}`,
              className: "px-1.5 py-0.5 rounded border bg-white/[0.02] border-white/[0.06] text-[#f0f2f5]"
            }, label);
          }).filter(Boolean);
        } catch {
          return null;
        }
      })(), (() => {
        const ingestTime = ticker.ingest_ts || ticker.ingest_time || ticker.ts;
        if (!ingestTime) return null;
        try {
          const tv = typeof ingestTime === "string" ? new Date(ingestTime) : new Date(Number(ingestTime));
          if (isNaN(tv.getTime())) return null;
          const ageMs = Date.now() - tv.getTime();
          const ageMin = Math.floor(ageMs / 60000);
          const ageH = Math.floor(ageMin / 60);
          const ageD = Math.floor(ageH / 24);
          const txt = ageMin < 60 ? `${ageMin}m` : ageH < 24 ? `${ageH}h` : `${ageD}d`;
          const cls = ageMin < 5 ? "text-green-400 border-green-400/30" : ageMin < 60 ? "text-yellow-400 border-yellow-400/30" : "text-orange-400 border-orange-400/30";
          return /*#__PURE__*/React.createElement("span", {
            className: `px-1.5 py-0.5 rounded border font-semibold ${cls}`,
            title: `Last ingest: ${tv.toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              hour12: true
            })}`
          }, txt);
        } catch {
          return null;
        }
      })(), (() => {
        const useEffectiveStage = effectiveStage != null && String(effectiveStage).trim() !== "";
        const kanbanStageRaw = useEffectiveStage ? String(effectiveStage).trim() : String(ticker?.kanban_stage || "").trim();
        const kanbanStage = kanbanStageRaw.toUpperCase();
        if (!kanbanStage) return null;
        const kanbanPill = kanbanStage === "EXIT" ? "bg-red-500/15 text-red-300 border-red-500/40" : kanbanStage === "TRIM" ? "bg-yellow-500/15 text-yellow-300 border-yellow-500/40" : kanbanStage === "DEFEND" ? "bg-orange-500/15 text-orange-300 border-orange-500/40" : kanbanStage === "HOLD" ? "bg-blue-500/15 text-blue-300 border-blue-500/40" : kanbanStage === "ENTER_NOW" ? "bg-green-500/15 text-green-300 border-green-500/40" : "bg-white/5 text-[#6b7280] border-white/10";
        const stageLabel = {
          "WATCH": "Watch",
          "SETUP_WATCH": "Setup Watch",
          "SETUP": "Setup",
          "FLIP_WATCH": "Flip Watch",
          "JUST_FLIPPED": "Just Flipped",
          "ENTER": "Enter",
          "ENTER_NOW": "Enter Now",
          "JUST_ENTERED": "Just Entered",
          "HOLD": "Hold",
          "DEFEND": "Defend",
          "TRIM": "Trim",
          "EXIT": "Exit"
        }[kanbanStage] || kanbanStage;
        return /*#__PURE__*/React.createElement("span", {
          className: `px-1.5 py-0.5 rounded border font-semibold ${kanbanPill}`
        }, stageLabel);
      })(), (() => {
        const ms = ticker?.move_status && typeof ticker.move_status === "object" ? ticker.move_status : null;
        const rawStatus = ms && ms.status ? String(ms.status).trim() : "";
        const hasOpenInLedger = Array.isArray(ledgerTrades) && ledgerTrades.some(t => String(t?.ticker || "").toUpperCase() === tickerSymbol && t.status !== "WIN" && t.status !== "LOSS");
        let status = rawStatus ? String(rawStatus).toUpperCase() : "";
        if ((status === "NONE" || status === "") && hasOpenInLedger) status = "ACTIVE";
        const discoveryStages = new Set(["watch", "setup_watch", "setup", "flip_watch", "enter", "enter_now", "just_flipped", ""]);
        const rawStage = effectiveStage ? String(effectiveStage).trim().toLowerCase() : String(ticker?.kanban_stage || "").trim().toLowerCase();
        const suppressMove = status === "ACTIVE" && discoveryStages.has(rawStage);
        if (!status || suppressMove) return null;
        const pill = status === "INVALIDATED" ? "bg-red-500/15 text-red-300 border-red-500/40" : status === "COMPLETED" ? "bg-purple-500/15 text-purple-300 border-purple-500/40" : "bg-green-500/10 text-green-300 border-green-500/30";
        const icon = status === "INVALIDATED" ? "⛔" : status === "COMPLETED" ? "✅" : "🟢";
        return /*#__PURE__*/React.createElement("span", {
          className: `px-1.5 py-0.5 rounded border font-semibold ${pill}`
        }, icon, " ", status);
      })()), (() => {
        const flags = ticker?.flags || {};
        const pills = [];
        const badges = [];

        // ── Badges (emoji-based, from flags + isPrimeBubble) ──
        if (isPrimeBubble(ticker)) badges.push({
          icon: "💎",
          label: "Prime",
          tip: "Prime: Top-ranked setup with high conviction"
        });
        if (flags.flip_watch) badges.push({
          icon: "🎯",
          label: "Entry Zone",
          tip: "Entry Zone: Price is near optimal entry level"
        });
        if (flags.momentum_elite) badges.push({
          icon: "🔥",
          label: "MoElite",
          tip: "MoElite: Elite momentum alignment across timeframes"
        });
        if (flags.sq30_on && !flags.sq30_release) badges.push({
          icon: "🧨",
          label: "Squeeze",
          tip: "Squeeze: Bollinger Band squeeze detected — volatility expansion expected"
        });
        if (flags.sq30_release) badges.push({
          icon: "⚡",
          label: "Release",
          tip: "Release: Squeeze has fired — momentum breakout in progress"
        });

        // ── Indicator Pills ──

        // Entry Quality score
        const eqScore = Number(ticker?.entry_quality?.score) || 0;
        if (eqScore > 0) {
          const eqColor = eqScore >= 70 ? "bg-[#00c853]/20 text-[#69f0ae] border-[#00e676]/40" : eqScore >= 50 ? "bg-amber-500/20 text-amber-300 border-amber-400/40" : "bg-rose-500/20 text-rose-300 border-rose-400/40";
          pills.push({
            label: `Q:${eqScore}`,
            cls: eqColor,
            desc: "Entry Quality",
            tip: `Entry Quality: Structure=${ticker?.entry_quality?.structure || 0} Momentum=${ticker?.entry_quality?.momentum || 0} Confirm=${ticker?.entry_quality?.confirmation || 0}`
          });
        }

        // Swing Consensus (multi-timeframe alignment)
        const swingBullCt = Number(ticker?.swing_consensus?.bullish_count) || 0;
        const swingBearCt = Number(ticker?.swing_consensus?.bearish_count) || 0;
        const swingDir = ticker?.swing_consensus?.direction || null;
        const freshCrossTf = ticker?.swing_consensus?.freshest_cross_tf || null;
        if (swingBullCt > 0 || swingBearCt > 0) {
          const tfColor = swingDir === "LONG" ? "bg-cyan-500/20 text-cyan-300 border-cyan-400/40" : swingDir === "SHORT" ? "bg-rose-500/20 text-rose-300 border-rose-400/40" : "bg-slate-500/20 text-slate-300 border-slate-400/40";
          pills.push({
            label: `${swingBullCt}/5 TF`,
            cls: tfColor,
            desc: "Bullish Timeframes",
            tip: `Swing Consensus: ${swingBullCt}/5 bullish, ${swingBearCt}/5 bearish${freshCrossTf ? `, fresh ${freshCrossTf} cross` : ""}`
          });
        }

        // Volatility Tier
        const volTier = String(ticker?.volatility_tier || "");
        if (volTier) {
          const vColor = volTier === "LOW" ? "bg-blue-500/15 text-blue-300 border-blue-400/30" : volTier === "MEDIUM" ? "bg-slate-500/15 text-slate-300 border-slate-400/30" : volTier === "HIGH" ? "bg-orange-500/15 text-orange-300 border-orange-400/30" : "bg-red-500/15 text-red-300 border-red-400/30";
          pills.push({
            label: volTier,
            cls: vColor,
            desc: "Volatility",
            tip: `Volatility: ${ticker?.volatility_atr_pct || "?"}% daily ATR`
          });
        }

        // Regime
        const regimeCombined = ticker?.regime?.combined || null;
        const regimeLabel = {
          STRONG_BULL: "Strong Bull",
          EARLY_BULL: "Early Bull",
          LATE_BULL: "Late Bull",
          COUNTER_TREND_BULL: "CT Bull",
          NEUTRAL: "Neutral",
          COUNTER_TREND_BEAR: "CT Bear",
          EARLY_BEAR: "Early Bear",
          LATE_BEAR: "Late Bear",
          STRONG_BEAR: "Strong Bear"
        }[regimeCombined] || null;
        if (regimeLabel) {
          const rColor = regimeCombined?.includes("BULL") ? "bg-[#00c853]/15 text-[#69f0ae] border-[#00e676]/30" : regimeCombined?.includes("BEAR") ? "bg-rose-500/15 text-rose-300 border-rose-400/30" : "bg-slate-500/15 text-slate-300 border-slate-400/30";
          pills.push({
            label: regimeLabel,
            cls: rColor,
            desc: "Regime",
            tip: `Regime: Daily=${ticker?.regime?.daily || "?"}, Weekly=${ticker?.regime?.weekly || "?"}`
          });
        }

        // Fresh EMA Cross
        if (freshCrossTf) {
          pills.push({
            label: `${freshCrossTf}x`,
            cls: "bg-purple-500/15 text-purple-300 border-purple-400/30",
            desc: "Fresh Cross",
            tip: `Fresh EMA cross on ${freshCrossTf}`
          });
        }

        // Strength / exhaustion
        const strength = String(ticker?.strength || ticker?.move_strength || "").toUpperCase();
        if (strength) {
          const sColor = strength === "EXTREME" ? "bg-purple-500/15 text-purple-300 border-purple-500/40" : strength === "STRONG" ? "bg-blue-500/15 text-blue-300 border-blue-500/30" : "bg-white/5 text-[#6b7280] border-white/10";
          pills.push({
            label: strength,
            cls: sColor,
            desc: "Strength",
            tip: `Move Strength: ${strength} — intensity of the current move`
          });
        }

        // Trend
        const trend = String(ticker?.trend || ticker?.weekly_trend || "").replace(/_/g, " ");
        if (trend) {
          const tU = trend.toUpperCase();
          const tColor = tU.includes("BULL") ? "bg-green-500/15 text-green-300 border-green-500/30" : tU.includes("BEAR") ? "bg-red-500/15 text-red-300 border-red-500/30" : "bg-white/5 text-[#6b7280] border-white/10";
          const tLabel = trend.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
          pills.push({
            label: tLabel,
            cls: tColor,
            desc: "Trend",
            tip: `Weekly Trend: ${tLabel}`
          });
        }
        if (pills.length === 0 && badges.length === 0) return null;
        return /*#__PURE__*/React.createElement("div", {
          className: "mt-2 flex flex-col gap-1.5"
        }, badges.length > 0 && /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-1.5 flex-wrap text-[10px]"
        }, badges.map((b, i) => /*#__PURE__*/React.createElement("span", {
          key: `ib-${i}`,
          className: "px-1.5 py-0.5 rounded border bg-white/5 border-white/10 text-[#d1d5db] font-semibold cursor-default",
          title: b.tip
        }, b.icon, " ", b.label))), pills.length > 0 && /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-2 flex-wrap text-[10px]"
        }, pills.map((p, i) => /*#__PURE__*/React.createElement("span", {
          key: `ip-${i}`,
          className: "inline-flex items-center gap-1 cursor-default",
          title: p.tip
        }, /*#__PURE__*/React.createElement("span", {
          className: `px-1.5 py-0.5 rounded border font-semibold ${p.cls}`
        }, p.label), /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280] text-[9px]"
        }, p.desc)))));
      })(), /*#__PURE__*/React.createElement("div", {
        className: "mt-3 flex items-center gap-1.5 overflow-x-auto",
        style: {
          scrollbarWidth: "none"
        }
      }, [{
        k: "ANALYSIS",
        label: "Analysis"
      }, {
        k: "TECHNICALS",
        label: "Technicals"
      }, {
        k: "MODEL",
        label: "Model"
      }, {
        k: "JOURNEY",
        label: "Journey"
      }, {
        k: "TRADE_HISTORY",
        label: `Trades (${Array.isArray(ledgerTrades) ? ledgerTrades.length : 0})`
      }].map(t => {
        const active = railTab === t.k;
        return /*#__PURE__*/React.createElement("button", {
          key: `rail-tab-${t.k}`,
          onClick: () => setRailTab(t.k),
          className: `px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-all whitespace-nowrap flex-shrink-0 ${active ? "border-blue-400 bg-blue-500/20 text-blue-200" : "border-white/[0.06] bg-white/[0.03] text-[#6b7280] hover:text-white"}`
        }, t.label);
      }))), /*#__PURE__*/React.createElement("div", {
        className: "p-6 pt-4"
      }, railTab === "ANALYSIS" ? /*#__PURE__*/React.createElement(React.Fragment, null, (() => {
        const baseCtx = ticker?.context && typeof ticker.context === "object" ? ticker.context : null;
        const mergedCtx = latestTicker?.context && typeof latestTicker.context === "object" ? latestTicker.context : null;
        const ctx = mergedCtx || baseCtx;
        if (!ctx) return null;
        const name = ctx.name || ctx.companyName || ctx.company_name;
        const description = ctx.description || ctx.businessSummary || ctx.business_summary;
        const sector = ctx.sector;
        const industry = ctx.industry;
        const country = ctx.country;
        const marketCap = Number(ctx.market_cap || ctx.marketCap || 0) || 0;
        const lastEarnTs = Number(ctx.last_earnings_ts || ctx.lastEarningsTs || 0) || 0;
        const events = ctx.events && typeof ctx.events === "object" ? ctx.events : null;

        // Merge model signal-level sector info
        const msSectorData = modelSignal?.sector;
        const enrichedSector = sector || msSectorData?.sector || null;
        const enrichedIndustry = industry || null;
        const fmtDate = ts => {
          if (!ts) return "—";
          const d = typeof ts === "number" && ts > 1e12 ? new Date(ts) : typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
          if (isNaN(d)) return "—";
          return d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric"
          });
        };
        const fmtMCap = val => {
          if (val >= 1e12) return `$${(val / 1e12).toFixed(2)}T`;
          if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
          if (val >= 1e6) return `$${(val / 1e6).toFixed(0)}M`;
          return `$${val.toLocaleString()}`;
        };
        const nextEarnTs = Number(events?.next_earnings_ts || 0) || 0;
        const lastEarnEvt = Number(events?.last_earnings_ts || 0) || lastEarnTs;
        const showDesc = description && description !== name;
        return /*#__PURE__*/React.createElement("div", {
          className: "mb-3 px-2.5 py-2 bg-white/[0.03] border border-white/[0.06] rounded-lg"
        }, name ? /*#__PURE__*/React.createElement("div", {
          className: "text-xs font-semibold text-white truncate"
        }, name) : null, /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-[#6b7280] mt-0.5"
        }, [enrichedSector, enrichedIndustry, country].filter(Boolean).join(" • ") || "—"), showDesc ? /*#__PURE__*/React.createElement("div", {
          className: "mt-1 text-[10px] text-[#6b7280] leading-snug",
          style: {
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden"
          }
        }, description) : null, marketCap || lastEarnEvt || nextEarnTs ? /*#__PURE__*/React.createElement("div", {
          className: `mt-1.5 grid gap-1.5 text-[10px]`,
          style: {
            gridTemplateColumns: `repeat(${[marketCap, lastEarnEvt, nextEarnTs].filter(Boolean).length}, 1fr)`
          }
        }, marketCap ? /*#__PURE__*/React.createElement("div", {
          className: "p-1.5 bg-white/[0.02] border border-white/[0.06] rounded text-center"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-[9px] text-[#6b7280]"
        }, "MCap"), /*#__PURE__*/React.createElement("div", {
          className: "text-[11px] font-semibold text-white"
        }, fmtMCap(marketCap))) : null, lastEarnEvt ? /*#__PURE__*/React.createElement("div", {
          className: "p-1.5 bg-white/[0.02] border border-white/[0.06] rounded text-center"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-[9px] text-[#6b7280]"
        }, "Last Earnings"), /*#__PURE__*/React.createElement("div", {
          className: "text-[11px] font-semibold text-white"
        }, fmtDate(lastEarnEvt))) : null, nextEarnTs ? /*#__PURE__*/React.createElement("div", {
          className: "p-1.5 bg-blue-500/10 border border-blue-500/30 rounded text-center"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-[9px] text-blue-400"
        }, "Next Earnings"), /*#__PURE__*/React.createElement("div", {
          className: "text-[11px] font-semibold text-blue-300"
        }, fmtDate(nextEarnTs))) : null) : null);
      })(), prime && /*#__PURE__*/React.createElement("div", {
        className: "mb-4 p-3 bg-green-500/20 border-2 border-green-500 rounded-lg text-center font-bold text-green-500 prime-glow"
      }, "\uD83D\uDC8E PRIME SETUP \uD83D\uDC8E"), /*#__PURE__*/React.createElement("div", {
        className: `mb-4 p-4 rounded-lg border-2 ${actionInfo.bg} border-current/30`
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center justify-between mb-3"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-sm text-[#6b7280] font-semibold"
      }, "System Guidance"), (() => {
        const stage = String(ticker?.kanban_stage || "").toLowerCase();
        const isEnterLane = stage === "enter_now" || stage === "enter";
        const blockReason = ticker?.__execution_block_reason || ticker?.__entry_block_reason;
        if (isEnterLane && blockReason) {
          return /*#__PURE__*/React.createElement("span", {
            className: "px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-400"
          }, "Blocked");
        }
        if (isEnterLane) {
          return /*#__PURE__*/React.createElement("span", {
            className: "px-2 py-0.5 rounded text-[10px] font-semibold bg-green-500/20 text-green-400"
          }, "Enter");
        }
        if (decisionSummary) {
          return /*#__PURE__*/React.createElement("span", {
            className: `px-2 py-0.5 rounded text-[10px] font-semibold ${decisionSummary.bg} ${decisionSummary.tone}`
          }, decisionSummary.status);
        }
        return null;
      })()), /*#__PURE__*/React.createElement("div", {
        className: `text-lg font-bold mb-2 ${actionInfo.color}`
      }, actionInfo.action), /*#__PURE__*/React.createElement("div", {
        className: "text-sm text-[#cbd5ff] leading-relaxed"
      }, actionInfo.description), (() => {
        const raw = ticker?.__execution_block_reason || ticker?.__entry_block_reason;
        if (!raw) return null;
        const rrStage = String(ticker?.kanban_stage || "").toLowerCase();
        if (rrStage !== "enter" && rrStage !== "enter_now") return null;
        const formatted = String(raw).split("+").map(r => {
          const sm = r.match(/^sector_full:(\d+)\/(\d+)\s*(.*)/);
          if (sm) return `Max ${sm[3] || "sector"} positions reached (${sm[1]}/${sm[2]})`;
          const dm = r.match(/^direction_full:(\d+)\/(\d+)\s*(LONG|SHORT)/i);
          if (dm) return `Max ${dm[3].toLowerCase()} positions reached (${dm[1]}/${dm[2]})`;
          const cm = r.match(/^correlated:(\d+)\s+in\s+(.*)/);
          if (cm) return `Too many correlated positions in ${cm[2]} (${cm[1]})`;
          const dl = r.match(/^daily_limit:(\d+)\/(\d+)/);
          if (dl) return `Daily entry limit reached (${dl[1]}/${dl[2]})`;
          if (r === "cooldown") return "Entry cooldown active";
          if (r === "smart_gate") return "Risk management gate";
          if (r === "outside_RTH") return "Outside regular trading hours";
          if (r === "weekend") return "Market closed (weekend)";
          if (r === "same_cycle") return "Already attempted this cycle";
          if (r === "existing_position") return "Position already open";
          if (r === "recent_trade") return "Recent trade on this ticker";
          return r.replace(/_/g, " ");
        }).join(", ");
        return /*#__PURE__*/React.createElement("div", {
          className: "mt-3 px-3 py-2 rounded bg-amber-500/10 border border-amber-500/30"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[10px] text-amber-300/70 font-semibold"
        }, "Blocked: "), /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-amber-200 font-semibold"
        }, formatted));
      })(), (() => {
        const ms = ticker?.move_status && typeof ticker.move_status === "object" ? ticker.move_status : null;
        const reasonsRaw = Array.isArray(ms?.reasons) ? ms.reasons : [];
        const reasons = reasonsRaw.filter(x => x != null && String(x).trim()).slice(0, 5);
        const translateReason = r => {
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
        return /*#__PURE__*/React.createElement("div", {
          className: "mt-3 pt-3 border-t border-current/20"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] mb-2 font-semibold"
        }, "Key Factors:"), /*#__PURE__*/React.createElement("div", {
          className: "space-y-1.5"
        }, reasons.map((reason, idx) => /*#__PURE__*/React.createElement("div", {
          key: `reason-${idx}`,
          className: "flex gap-2 text-xs text-[#cbd5ff]"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-cyan-400"
        }, "\u2022"), /*#__PURE__*/React.createElement("span", null, translateReason(reason))))));
      })()), (() => {
        const ms = modelSignal;
        const pm = (latestTicker || ticker)?.pattern_match;
        const ts = ms?.ticker;
        const ss = ms?.sector;
        const mk = ms?.market;
        if (!ts && !pm && !mk) return null;
        const dirColor = d => d === "BULLISH" ? "text-[#00e676]" : d === "BEARISH" ? "text-red-400" : "text-slate-400";
        const dirBg = d => d === "BULLISH" ? "bg-[#00c853]/10 border-[#00c853]/30" : d === "BEARISH" ? "bg-red-500/10 border-red-500/30" : "bg-slate-500/10 border-slate-500/30";
        const regimeBg = r => {
          if (!r) return "";
          if (r.includes("BULL")) return "bg-[#00c853]/15 border-[#00c853]/40";
          if (r.includes("BEAR")) return "bg-red-500/15 border-red-500/40";
          return "bg-slate-500/10 border-slate-500/30";
        };

        // Plain English descriptions for layman interpretation
        const describeTickerDir = (d, net) => {
          if (d === "BULLISH") return net > 0.4 ? "Strong upward momentum — model and scoring both favor higher prices" : "Leaning bullish — more factors point up than down";
          if (d === "BEARISH") return net < -0.4 ? "Strong downward pressure — model and scoring both suggest lower prices" : "Leaning bearish — more factors point down than up";
          return "Mixed indicators — no clear directional edge right now";
        };
        const describeSector = (regime, pct) => {
          if (regime === "BULLISH") return `${pct}% of sector tickers trending up — sector tailwind`;
          if (regime === "BEARISH") return `Only ${pct}% bullish — sector headwind`;
          return `Sector is mixed — no strong sector-wide trend`;
        };
        const describeMarket = (sig, pct) => {
          if (!sig) return "";
          if (sig.includes("STRONG_BULL")) return `Broad rally — ${pct}% of all tickers bullish`;
          if (sig.includes("MILD_BULL")) return `Market leaning up — ${pct}% bullish`;
          if (sig.includes("STRONG_BEAR")) return `Broad weakness — only ${pct}% of tickers bullish`;
          if (sig.includes("MILD_BEAR")) return `Market leaning down — ${pct}% bullish`;
          return `Market is neutral — no strong trend`;
        };
        return /*#__PURE__*/React.createElement("div", {
          className: "mb-4 p-3 rounded-2xl border border-white/[0.08]",
          style: {
            background: "rgba(255,255,255,0.03)",
            backdropFilter: "blur(12px) saturate(1.2)",
            WebkitBackdropFilter: "blur(12px) saturate(1.2)",
            boxShadow: "0 2px 12px rgba(0,0,0,0.25), inset 0 0.5px 0 rgba(255,255,255,0.06)"
          }
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-2 mb-3"
        }, /*#__PURE__*/React.createElement("div", {
          className: "w-5 h-5 rounded-md bg-blue-500/20 flex items-center justify-center text-[10px]"
        }, "\uD83E\uDDE0"), /*#__PURE__*/React.createElement("span", {
          className: "text-xs font-bold text-slate-300 uppercase tracking-wider"
        }, "Model Intelligence")), (ts || pm) && /*#__PURE__*/React.createElement("div", {
          className: `rounded-lg p-2.5 mb-2 border ${dirBg(ts?.direction || pm?.direction)}`
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between mb-1"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[10px] text-slate-400 uppercase font-semibold"
        }, "Ticker Indicator"), /*#__PURE__*/React.createElement("span", {
          className: `text-xs font-bold ${dirColor(ts?.direction || pm?.direction)}`
        }, ts?.direction || pm?.direction || "—")), /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-3 text-[11px]"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-slate-400"
        }, "Net: ", /*#__PURE__*/React.createElement("span", {
          className: `font-semibold ${(ts?.netSignal || pm?.netSignal || 0) > 0 ? "text-[#00e676]" : (ts?.netSignal || pm?.netSignal || 0) < 0 ? "text-red-400" : "text-slate-300"}`
        }, (ts?.netSignal || pm?.netSignal || 0) > 0 ? "+" : "", (ts?.netSignal || pm?.netSignal || 0).toFixed(2))), /*#__PURE__*/React.createElement("span", {
          className: "text-slate-400"
        }, "Patterns: ", /*#__PURE__*/React.createElement("span", {
          className: "text-white font-semibold"
        }, ts?.bullPatterns || pm?.bullCount || 0, "B / ", ts?.bearPatterns || pm?.bearCount || 0, "S"))), pm?.bestBull && /*#__PURE__*/React.createElement("div", {
          className: "mt-1.5 text-[10px] text-[#69f0ae]/80"
        }, "Top: ", pm.bestBull.name, " (", (pm.bestBull.conf * 100).toFixed(0), "% conf, EV: ", pm.bestBull.ev > 0 ? "+" : "", pm.bestBull.ev, ")"), /*#__PURE__*/React.createElement("div", {
          className: "mt-1.5 text-[10px] text-slate-400/90 italic leading-snug"
        }, describeTickerDir(ts?.direction || pm?.direction, ts?.netSignal || pm?.netSignal || 0))), /*#__PURE__*/React.createElement("div", {
          className: "grid grid-cols-2 gap-2"
        }, ss && /*#__PURE__*/React.createElement("div", {
          className: `rounded-lg p-2 border ${regimeBg(ss.regime)}`
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-[9px] text-slate-400 uppercase font-semibold mb-0.5"
        }, "Sector"), /*#__PURE__*/React.createElement("div", {
          className: "text-[11px] font-bold text-white truncate"
        }, ss.sector), /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-slate-400"
        }, ss.breadthBullPct, "% bull \xB7 ", ss.regime), /*#__PURE__*/React.createElement("div", {
          className: "text-[9px] text-slate-400/80 italic mt-0.5"
        }, describeSector(ss.regime, ss.breadthBullPct))), mk && (mk.totalTickers || 0) > 5 && /*#__PURE__*/React.createElement("div", {
          className: `rounded-lg p-2 border ${regimeBg(mk.signal)}`
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-[9px] text-slate-400 uppercase font-semibold mb-0.5"
        }, "Market"), /*#__PURE__*/React.createElement("div", {
          className: `text-[11px] font-bold ${mk.signal?.includes("BULL") ? "text-[#00e676]" : mk.signal?.includes("BEAR") ? "text-red-400" : "text-slate-300"}`
        }, mk.signal?.replace(/_/g, " ")), /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-slate-400"
        }, mk.breadthBullPct, "% breadth"), /*#__PURE__*/React.createElement("div", {
          className: "text-[9px] text-slate-400/80 italic mt-0.5"
        }, describeMarket(mk.signal, mk.breadthBullPct)))), mk?.riskFlag && (mk.totalTickers || 0) > 5 && /*#__PURE__*/React.createElement("div", {
          className: "mt-2 text-[10px] text-amber-300/80 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1"
        }, mk.riskFlag));
      })(), (() => {
        // Use position SL/TP when available (correct for SHORT trades)
        const posSlRaw = ticker?.has_open_position ? Number(ticker?.position_sl) : NaN;
        const posTpRaw = ticker?.has_open_position ? Number(ticker?.position_tp) : NaN;
        const sl = Number.isFinite(posSlRaw) && posSlRaw > 0 ? posSlRaw : ticker.sl ? Number(ticker.sl) : null;
        // Original SL at trade creation — used to determine if TSL is active
        const slOrigRaw = Number(trade?.sl_original ?? ticker?.position_sl_original ?? 0);
        const slOrig = Number.isFinite(slOrigRaw) && slOrigRaw > 0 ? slOrigRaw : null;
        const price = Number(ticker?.price);
        const rr = ticker.rr ? Number(ticker.rr) : null;
        const hasSl = Number.isFinite(sl) && sl > 0;
        // TSL is active when current SL has moved > 0.5% from original
        const tslActive = hasSl && slOrig && Math.abs(sl - slOrig) / slOrig > 0.005;

        // Prefer trade-level tpArray (direction-aware) over ticker-level (may be LONG-only)
        const tradeTpArr = Array.isArray(trade?.tpArray) && trade.tpArray.length > 0 ? trade.tpArray : Array.isArray(ticker?.tpArray) ? ticker.tpArray : [];
        const tpTrimRaw = tradeTpArr.length > 0 ? Number(tradeTpArr[0]?.price) : Number(ticker?.tp_trim);
        const tpExitRaw = tradeTpArr.length > 1 ? Number(tradeTpArr[1]?.price) : Number(ticker?.tp_exit);
        const tpRunnerRaw = tradeTpArr.length > 2 ? Number(tradeTpArr[2]?.price) : Number(ticker?.tp_runner);
        // Direction-aware TP sanity: filter out wrong-side TPs.
        // For SHORT, TPs must be BELOW entry/price. For LONG, ABOVE.
        const entryPxForTp = Number(ticker?.position_entry || trade?.entry_price || trade?.entryPrice || ticker?.entry_price || ticker?.entry_ref || ticker?.trigger_price) || 0;
        const tpSane = raw => {
          if (!Number.isFinite(raw) || raw <= 0) return NaN;
          if (!resolvedDir) return raw;
          // Check against entry price if available
          if (entryPxForTp > 0) {
            if (resolvedDir === "LONG" && raw <= entryPxForTp) return NaN;
            if (resolvedDir === "SHORT" && raw >= entryPxForTp) return NaN;
          }
          // Also check against current price — TP must not already be passed
          if (Number.isFinite(price) && price > 0) {
            if (resolvedDir === "LONG" && raw <= price) return NaN;
            if (resolvedDir === "SHORT" && raw >= price) return NaN;
          }
          return raw;
        };
        const tpTrim = tpSane(tpTrimRaw);
        const tpExit = tpSane(tpExitRaw);
        const tpRunner = tpSane(tpRunnerRaw);
        const has3Tier = Number.isFinite(tpTrim) && tpTrim > 0 || Number.isFinite(tpExit) && tpExit > 0;
        const legacyTarget = computeTpTargetPrice(ticker);
        const legacyMax = computeTpMaxPrice(ticker);
        const hasLegacy = !has3Tier && (Number.isFinite(legacyTarget) || Number.isFinite(legacyMax));
        if (!hasSl && !has3Tier && !hasLegacy && !Number.isFinite(rr)) return null;
        const dir = resolvedDir; // unified direction from top of component
        // SL% = absolute risk distance from current price
        const slDistPct = hasSl && Number.isFinite(price) && price > 0 ? Math.abs((sl - price) / price) * 100 : null;

        // Compute per-target R:R from current price (requires known direction)
        const computeTargetRR = tpVal => {
          if (!dir || !hasSl || !Number.isFinite(price) || price <= 0 || !Number.isFinite(tpVal) || tpVal <= 0) return null;
          const risk = dir === "LONG" ? price - sl : sl - price;
          const gain = dir === "LONG" ? tpVal - price : price - tpVal;
          if (risk <= 0 || gain <= 0) return null;
          return gain / risk;
        };

        // Per-target % distance from current price
        const tpPct = tpVal => {
          if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tpVal) || tpVal <= 0) return null;
          return Math.abs((tpVal - price) / price) * 100;
        };
        const rrTrim = has3Tier ? computeTargetRR(tpTrim) : null;
        const rrExit = has3Tier ? computeTargetRR(tpExit) : null;
        const rrRunner = has3Tier ? computeTargetRR(tpRunner) : null;
        const getProgressToTp = tpVal => {
          if (!dir || !Number.isFinite(price) || price <= 0 || !Number.isFinite(tpVal)) return 0;
          const slVal = hasSl ? sl : price;
          const totalMove = Math.abs(tpVal - slVal);
          if (totalMove <= 0) return 0;
          const currentMove = dir === "LONG" ? price - slVal : slVal - price;
          return Math.max(0, Math.min(1, currentMove / totalMove));
        };
        const tierCards = [{
          tp: tpTrim,
          rr: rrTrim,
          label: "Take Profit 1",
          sub: "Trim 60%",
          icon: "🎯",
          bg: "bg-yellow-500/10",
          border: "border-yellow-500/30",
          text: "text-yellow-400"
        }, {
          tp: tpExit,
          rr: rrExit,
          label: "Take Profit 2",
          sub: "Exit 85%",
          icon: "💰",
          bg: "bg-orange-500/10",
          border: "border-orange-500/30",
          text: "text-orange-400"
        }, {
          tp: tpRunner,
          rr: rrRunner,
          label: "Take Profit 3",
          sub: "Runner",
          icon: "🚀",
          bg: "bg-teal-500/10",
          border: "border-teal-500/30",
          text: "text-teal-400"
        }];
        return /*#__PURE__*/React.createElement("div", {
          className: "mb-4 space-y-2"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-[#6b7280] font-semibold uppercase tracking-wider"
        }, "Risk / Reward Levels"), hasSl && /*#__PURE__*/React.createElement("div", {
          className: "space-y-1.5"
        }, /*#__PURE__*/React.createElement("div", {
          className: `p-2.5 rounded border flex items-center justify-between ${tslActive ? "bg-white/[0.02] border-white/[0.08]" : "bg-red-500/10 border-red-500/30"}`
        }, /*#__PURE__*/React.createElement("span", {
          className: `text-xs font-semibold ${tslActive ? "text-[#6b7280]" : "text-red-400"}`
        }, "Stop Loss"), /*#__PURE__*/React.createElement("span", {
          className: `text-xs font-bold ${tslActive ? "text-[#6b7280]" : "text-red-400"}`
        }, tslActive && slOrig ? `$${slOrig.toFixed(2)}` : `$${sl.toFixed(2)}`), !tslActive && Number.isFinite(slDistPct) && /*#__PURE__*/React.createElement("span", {
          className: "text-[9px] text-red-300/70"
        }, slDistPct.toFixed(1), "% risk"), tslActive && /*#__PURE__*/React.createElement("span", {
          className: "text-[9px] text-[#4b5563]"
        }, "original")), tslActive && /*#__PURE__*/React.createElement("div", {
          className: "p-2.5 rounded border bg-red-500/10 border-red-500/30 flex items-center justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs font-semibold text-red-400",
          title: "Trailing Stop Loss"
        }, "TSL"), /*#__PURE__*/React.createElement("span", {
          className: "text-xs font-bold text-red-400"
        }, "$", sl.toFixed(2)), Number.isFinite(slDistPct) && /*#__PURE__*/React.createElement("span", {
          className: "text-[9px] text-red-300/70"
        }, slDistPct.toFixed(1), "% risk"))), /*#__PURE__*/React.createElement("div", {
          className: "space-y-2"
        }, has3Tier ? tierCards.filter(t => Number.isFinite(t.tp) && t.tp > 0).map((tier, idx) => {
          const progress = getProgressToTp(tier.tp);
          return /*#__PURE__*/React.createElement("div", {
            key: idx,
            className: `p-2.5 rounded border ${tier.bg} ${tier.border}`
          }, /*#__PURE__*/React.createElement("div", {
            className: "flex justify-between items-center mb-1.5"
          }, /*#__PURE__*/React.createElement("div", {
            className: "flex items-center gap-2"
          }, /*#__PURE__*/React.createElement("span", {
            className: "text-sm"
          }, tier.icon), /*#__PURE__*/React.createElement("span", {
            className: `text-xs font-semibold ${tier.text}`
          }, tier.label), /*#__PURE__*/React.createElement("span", {
            className: "text-[10px] text-[#6b7280]"
          }, "(", tier.sub, ")")), /*#__PURE__*/React.createElement("div", {
            className: "flex items-center gap-2"
          }, /*#__PURE__*/React.createElement("span", {
            className: `text-xs font-bold ${tier.text}`
          }, "$", tier.tp.toFixed(2)), Number.isFinite(tier.rr) && /*#__PURE__*/React.createElement("span", {
            className: "text-[10px] font-semibold text-blue-400"
          }, tier.rr.toFixed(2), ":1"))), /*#__PURE__*/React.createElement("div", {
            className: "h-1.5 bg-white/[0.06] rounded-full overflow-hidden"
          }, /*#__PURE__*/React.createElement("div", {
            className: `h-full ${tier.label.includes("1") ? "bg-yellow-500" : tier.label.includes("2") ? "bg-orange-500" : "bg-teal-500"} transition-all`,
            style: {
              width: `${Math.round(progress * 100)}%`
            }
          })));
        }) : hasLegacy ? /*#__PURE__*/React.createElement(React.Fragment, null, Number.isFinite(legacyTarget) && /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between gap-2 text-xs"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-1.5 px-2 py-1 rounded-lg bg-teal-500/10 border border-teal-500/25"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[10px] text-teal-300"
        }, "Target"), /*#__PURE__*/React.createElement("span", {
          className: "font-bold text-teal-400"
        }, "$", legacyTarget.toFixed(2))), Number.isFinite(tpPct(legacyTarget)) && /*#__PURE__*/React.createElement("span", {
          className: "text-[9px] text-[#6b7280]"
        }, tpPct(legacyTarget).toFixed(1), "%")), Number.isFinite(legacyMax) && Math.abs(legacyMax - (legacyTarget || 0)) > 0.01 && /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between gap-2 text-xs"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-1.5 px-2 py-1 rounded-lg bg-teal-500/10 border border-teal-500/25"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[10px] text-teal-300"
        }, "Stretch"), /*#__PURE__*/React.createElement("span", {
          className: "font-bold text-teal-400"
        }, "$", legacyMax.toFixed(2))), Number.isFinite(tpPct(legacyMax)) && /*#__PURE__*/React.createElement("span", {
          className: "text-[9px] text-[#6b7280]"
        }, tpPct(legacyMax).toFixed(1), "%"))) : null));
      })(), /*#__PURE__*/React.createElement("div", {
        className: "space-y-2.5 text-sm"
      }, (() => {
        const emaMap = ticker?.ema_map;
        if (!emaMap || typeof emaMap !== 'object') return null;
        const tfDisplayOrder = ['D', '240', '60', '30', '10', '3'];
        const tfLabels = {
          'W': 'Weekly',
          'D': 'Daily',
          '240': '4H',
          '60': '1H',
          '30': '30m',
          '10': '10m',
          '3': '3m'
        };
        const entries = tfDisplayOrder.map(tf => emaMap[tf] ? {
          tf,
          ...emaMap[tf]
        } : null).filter(Boolean);
        if (entries.length === 0) return null;
        const depthLabel = d => d >= 9 ? 'Strong Uptrend' : d >= 7 ? 'Uptrend' : d >= 5 ? 'Leaning Up' : d >= 4 ? 'Leaning Down' : d >= 2 ? 'Downtrend' : 'Strong Downtrend';
        const depthColor = d => d >= 8 ? 'text-green-400' : d >= 6 ? 'text-green-300/70' : d >= 4 ? 'text-yellow-300' : d >= 2 ? 'text-orange-400' : 'text-red-400';
        const depthBg = d => d >= 8 ? 'bg-green-500/20' : d >= 6 ? 'bg-green-500/10' : d >= 4 ? 'bg-yellow-500/10' : d >= 2 ? 'bg-orange-500/10' : 'bg-red-500/15';
        const trendWord = (s, m) => {
          const avg = (s + m) / 2;
          if (avg > 0.5) return {
            text: 'Accelerating',
            cls: 'text-green-400'
          };
          if (avg > 0.15) return {
            text: 'Trending Up',
            cls: 'text-green-300/80'
          };
          if (avg > -0.15) return {
            text: 'Flat',
            cls: 'text-slate-400'
          };
          if (avg > -0.5) return {
            text: 'Fading',
            cls: 'text-orange-400'
          };
          return {
            text: 'Reversing Down',
            cls: 'text-red-400'
          };
        };
        return /*#__PURE__*/React.createElement("div", {
          className: "border-t border-white/[0.06] my-3 pt-3"
        }, /*#__PURE__*/React.createElement("button", {
          onClick: () => setEmaExpanded?.(!emaExpanded),
          className: "w-full flex items-center justify-between text-xs text-[#6b7280] mb-2 font-semibold hover:text-white transition-colors"
        }, /*#__PURE__*/React.createElement("span", null, "Trend Alignment"), /*#__PURE__*/React.createElement("span", {
          className: "text-base"
        }, emaExpanded ? "▼" : "▶")), emaExpanded && /*#__PURE__*/React.createElement("div", {
          className: "space-y-1.5"
        }, entries.map(e => {
          const trend = trendWord(e.structure, e.momentum);
          const pct = Math.round(e.depth * 10);
          return /*#__PURE__*/React.createElement("div", {
            key: e.tf,
            className: `flex items-center justify-between text-[11px] py-1.5 px-2 rounded-md ${depthBg(e.depth)}`
          }, /*#__PURE__*/React.createElement("span", {
            className: "text-slate-300 font-medium w-12"
          }, tfLabels[e.tf] || e.tf), /*#__PURE__*/React.createElement("div", {
            className: "flex-1 mx-2"
          }, /*#__PURE__*/React.createElement("div", {
            className: "w-full bg-white/[0.06] rounded-full h-1.5 overflow-hidden"
          }, /*#__PURE__*/React.createElement("div", {
            className: `h-full rounded-full transition-all ${e.depth >= 6 ? 'bg-green-500' : e.depth >= 4 ? 'bg-yellow-500' : 'bg-red-500'}`,
            style: {
              width: `${pct}%`
            }
          }))), /*#__PURE__*/React.createElement("div", {
            className: "flex items-center gap-2 min-w-[110px] justify-end"
          }, /*#__PURE__*/React.createElement("span", {
            className: `font-bold ${depthColor(e.depth)}`,
            title: depthLabel(e.depth)
          }, depthLabel(e.depth)), /*#__PURE__*/React.createElement("span", {
            className: `text-[9px] font-medium ${trend.cls}`
          }, trend.text)));
        }), /*#__PURE__*/React.createElement("div", {
          className: "text-[9px] text-[#4b5563] mt-1.5 px-1"
        }, "Bar shows how many EMAs price is above (trend strength). Labels show if trend is accelerating or fading.")));
      })(), (() => {
        const eq = ticker?.entry_quality;
        const sc = ticker?.swing_consensus;
        const volTier = ticker?.volatility_tier;
        const volPct = ticker?.volatility_atr_pct;
        const reg = ticker?.regime;
        if (!eq && !sc && !volTier && !reg) return null;
        const eqScore = Number(eq?.score) || 0;
        const eqCls = eqScore >= 70 ? "text-green-400" : eqScore >= 50 ? "text-amber-300" : "text-rose-400";
        const eqBg = eqScore >= 70 ? "bg-green-500/15" : eqScore >= 50 ? "bg-amber-500/10" : "bg-rose-500/10";
        const volCls = volTier === "LOW" ? "text-blue-300 bg-blue-500/15" : volTier === "MEDIUM" ? "text-slate-300 bg-slate-500/15" : volTier === "HIGH" ? "text-orange-300 bg-orange-500/15" : "text-red-300 bg-red-500/15";
        const scDir = sc?.direction;
        const bullCt = Number(sc?.bullish_count) || 0;
        const bearCt = Number(sc?.bearish_count) || 0;
        const freshTf = sc?.freshest_cross_tf;
        const freshAge = sc?.freshest_cross_age;
        const tfStack = sc?.tf_stack || [];
        return /*#__PURE__*/React.createElement("div", {
          className: "border-t border-white/[0.06] my-3 pt-3"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] font-semibold mb-2"
        }, "Swing Analysis"), /*#__PURE__*/React.createElement("div", {
          className: "space-y-2"
        }, eq && /*#__PURE__*/React.createElement("div", {
          className: `rounded-md p-2 ${eqBg}`
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between mb-1"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[10px] text-slate-400 font-medium"
        }, "Entry Quality"), /*#__PURE__*/React.createElement("span", {
          className: `text-sm font-bold ${eqCls}`
        }, eqScore, "/100")), /*#__PURE__*/React.createElement("div", {
          className: "flex gap-1.5 text-[9px]"
        }, /*#__PURE__*/React.createElement("span", {
          className: "px-1 py-0.5 rounded bg-white/[0.06] text-slate-300"
        }, "Struct: ", eq.structure || 0, "/35"), /*#__PURE__*/React.createElement("span", {
          className: "px-1 py-0.5 rounded bg-white/[0.06] text-slate-300"
        }, "Mom: ", eq.momentum || 0, "/35"), /*#__PURE__*/React.createElement("span", {
          className: "px-1 py-0.5 rounded bg-white/[0.06] text-slate-300"
        }, "Conf: ", eq.confirmation || 0, "/30"))), reg && reg.combined && /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between text-[10px]"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-slate-400"
        }, "Regime"), /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-1.5"
        }, /*#__PURE__*/React.createElement("span", {
          className: `px-1.5 py-0.5 rounded font-semibold ${reg.combined.includes("BULL") ? "text-[#69f0ae] bg-[#00c853]/15" : reg.combined.includes("BEAR") ? "text-rose-300 bg-rose-500/15" : "text-slate-300 bg-slate-500/15"}`
        }, {
          STRONG_BULL: "Strong Bull",
          EARLY_BULL: "Early Bull",
          LATE_BULL: "Late Bull",
          COUNTER_TREND_BULL: "CT Bull",
          NEUTRAL: "Neutral",
          COUNTER_TREND_BEAR: "CT Bear",
          EARLY_BEAR: "Early Bear",
          LATE_BEAR: "Late Bear",
          STRONG_BEAR: "Strong Bear"
        }[reg.combined] || reg.combined), /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "D:", reg.daily?.charAt(0).toUpperCase() || "?", " W:", reg.weekly?.charAt(0).toUpperCase() || "?"))), sc && /*#__PURE__*/React.createElement("div", {
          className: "rounded-md p-2 bg-white/[0.03]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between mb-1"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[10px] text-slate-400 font-medium"
        }, "TF Consensus"), /*#__PURE__*/React.createElement("span", {
          className: `text-[11px] font-bold ${scDir === "LONG" ? "text-cyan-300" : scDir === "SHORT" ? "text-rose-300" : "text-slate-400"}`
        }, scDir || "NEUTRAL", " (", bullCt, "/", 5, ")")), /*#__PURE__*/React.createElement("div", {
          className: "flex gap-0.5"
        }, tfStack.map((tf, i) => /*#__PURE__*/React.createElement("div", {
          key: i,
          className: `flex-1 h-1.5 rounded-full ${tf.bias === "bullish" ? "bg-cyan-400" : tf.bias === "bearish" ? "bg-rose-400" : "bg-slate-600"}`,
          title: `${tf.tf}: ${tf.bias}${tf.crossDir ? ` (cross ${tf.crossDir})` : ""}`
        }))), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between text-[8px] text-[#4b5563] mt-0.5"
        }, tfStack.map((tf, i) => /*#__PURE__*/React.createElement("span", {
          key: i
        }, tf.tf))), freshTf && /*#__PURE__*/React.createElement("div", {
          className: "text-[9px] text-purple-300 mt-1"
        }, "Fresh ", freshTf, " cross", freshAge != null ? ` (${freshAge}m ago)` : "")), volTier && /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between text-[10px]"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-slate-400"
        }, "Volatility"), /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-1.5"
        }, /*#__PURE__*/React.createElement("span", {
          className: `px-1.5 py-0.5 rounded font-semibold ${volCls}`
        }, volTier), Number.isFinite(volPct) && /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, volPct, "% ATR/px")))));
      })(), (() => {
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
        return /*#__PURE__*/React.createElement("div", {
          className: "border-t border-white/[0.06] my-3 pt-3"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between mb-2"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-sm font-extrabold text-purple-300 tracking-wide"
        }, "\uD83D\uDE80 MOMENTUM ELITE"), /*#__PURE__*/React.createElement("span", {
          className: "text-[10px] px-2 py-0.5 rounded border bg-purple-500/25 border-purple-400/50 text-purple-200 font-bold"
        }, "ACTIVE")), /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-purple-200/70 space-y-0.5"
        }, okAdr && /*#__PURE__*/React.createElement("div", null, "\u2705 ADR(14D) \u2265 $2 \u2022 $", adr14.toFixed(2)), okVol && /*#__PURE__*/React.createElement("div", null, "\u2705 Vol(30D) \u2265 2M \u2022 ", (avgVol30 / 1_000_000).toFixed(2), "M"), okW && /*#__PURE__*/React.createElement("div", null, "\u2705 1W momentum ", w.toFixed(1), "%"), okM && /*#__PURE__*/React.createElement("div", null, "\u2705 1M momentum ", m.toFixed(1), "%"), ok3 && /*#__PURE__*/React.createElement("div", null, "\u2705 3M momentum ", m3.toFixed(1), "%"), ok6 && /*#__PURE__*/React.createElement("div", null, "\u2705 6M momentum ", m6.toFixed(1), "%")));
      })(), rankTotal > 0 && /*#__PURE__*/React.createElement("div", {
        className: "flex justify-between items-center py-1 border-b border-white/[0.06]/50"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-[#6b7280]"
      }, "Rank"), /*#__PURE__*/React.createElement("span", {
        className: "font-semibold"
      }, rankPosition > 0 ? `#${rankPosition} of ${rankTotal}` : "—", rankAsOfText && /*#__PURE__*/React.createElement("span", {
        className: "ml-2 text-[10px] text-[#6b7280] font-normal"
      }, "(as of ", rankAsOfText, ")"))), /*#__PURE__*/React.createElement("div", {
        className: "flex justify-between items-center py-1 border-b border-white/[0.06]/50"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-[#6b7280]"
      }, "Score"), /*#__PURE__*/React.createElement("span", {
        className: "font-semibold text-blue-400 text-lg"
      }, Number.isFinite(displayScore) ? displayScore.toFixed(1) : "—")), false && (() => {
        const ml = ticker?.ml || ticker?.model || ticker?.model_v1 || ticker?.ml_v1 || null;
        if (!ml || typeof ml !== "object") return null;
        const p4h = Number(ml?.p_win_4h ?? ml?.p4h ?? ml?.pWin4h);
        const ev4h = Number(ml?.ev_4h ?? ml?.ev4h);
        const p1d = Number(ml?.p_win_1d ?? ml?.p1d ?? ml?.pWin1d);
        const ev1d = Number(ml?.ev_1d ?? ml?.ev1d);
        const has4h = Number.isFinite(p4h) || Number.isFinite(ev4h);
        const has1d = Number.isFinite(p1d) || Number.isFinite(ev1d);
        if (!has4h && !has1d) return null;
        const fmtPct = x => Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—";
        const fmtEv = x => Number.isFinite(x) ? `${x.toFixed(2)}%` : "—";

        // Plain English interpretation
        const interpretML = (pWin, ev) => {
          const p = Number(pWin) * 100;
          const e = Number(ev);
          if (!Number.isFinite(p) || !Number.isFinite(e)) return null;

          // Strong patterns
          if (p >= 70 && e >= 15) return {
            text: "🎯 Strong pattern - high historical win%, favorable reward",
            color: "text-green-400",
            bg: "bg-green-500/10"
          };
          if (p >= 60 && e >= 10) return {
            text: "✅ Good setup - favorable odds",
            color: "text-green-400",
            bg: "bg-green-500/10"
          };

          // Positive but cautious
          if (e >= 5 && p >= 55) return {
            text: "🟢 Decent - small edge, manage risk",
            color: "text-blue-400",
            bg: "bg-blue-500/10"
          };
          if (e >= 0 && p >= 60) return {
            text: "⚖️ Neutral - breakeven odds",
            color: "text-yellow-400",
            bg: "bg-yellow-500/10"
          };

          // Warning patterns
          if (p >= 70 && e < 0) return {
            text: "⚠️ Too late - missed the entry",
            color: "text-orange-400",
            bg: "bg-orange-500/10"
          };
          if (e < -5 && p >= 50) return {
            text: "🛑 Skip - poor risk/reward",
            color: "text-red-400",
            bg: "bg-red-500/10"
          };
          if (p < 45) return {
            text: "❌ Avoid - low probability",
            color: "text-red-400",
            bg: "bg-red-500/10"
          };

          // Default
          return {
            text: "🤔 Unclear pattern - use caution",
            color: "text-gray-400",
            bg: "bg-gray-500/10"
          };
        };
        const interp4h = has4h ? interpretML(p4h, ev4h) : null;
        const interp1d = has1d ? interpretML(p1d, ev1d) : null;
        return /*#__PURE__*/React.createElement(React.Fragment, null, has4h && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center py-1 border-b border-white/[0.06]/50"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Model (4h)"), /*#__PURE__*/React.createElement("span", {
          className: "font-semibold text-purple-300"
        }, "pWin ", fmtPct(p4h), " \u2022 EV ", fmtEv(ev4h))), interp4h && /*#__PURE__*/React.createElement("div", {
          className: `text-xs py-2 px-3 rounded ${interp4h.bg} border border-${interp4h.color.replace('text-', '')}/30 mb-2`
        }, /*#__PURE__*/React.createElement("span", {
          className: interp4h.color
        }, interp4h.text))), has1d && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center py-1 border-b border-white/[0.06]/50"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Model (1d)"), /*#__PURE__*/React.createElement("span", {
          className: "font-semibold text-purple-300"
        }, "pWin ", fmtPct(p1d), " \u2022 EV ", fmtEv(ev1d))), interp1d && /*#__PURE__*/React.createElement("div", {
          className: `text-xs py-2 px-3 rounded ${interp1d.bg} border border-${interp1d.color.replace('text-', '')}/30 mb-2`
        }, /*#__PURE__*/React.createElement("span", {
          className: interp1d.color
        }, interp1d.text))));
      })(), (() => {
        const breakdown = calculateScoreBreakdown(ticker);
        const breakdownComponents = [{
          label: "Base Score",
          value: breakdown.base,
          color: "text-blue-400"
        }, breakdown.corridor > 0 ? {
          label: "In Corridor",
          value: `+${breakdown.corridor}`,
          color: "text-cyan-400"
        } : null, breakdown.corridorAligned > 0 ? {
          label: "Aligned + Corridor",
          value: `+${breakdown.corridorAligned}`,
          color: "text-green-400"
        } : null, breakdown.htfStrength > 0 ? {
          label: "HTF Strength",
          value: `+${breakdown.htfStrength.toFixed(2)}`,
          color: "text-cyan-400"
        } : null, breakdown.ltfStrength > 0 ? {
          label: "LTF Strength",
          value: `+${breakdown.ltfStrength.toFixed(2)}`,
          color: "text-cyan-400"
        } : null, breakdown.completion !== 0 ? {
          label: "Completion",
          value: breakdown.completion > 0 ? `+${breakdown.completion}` : `${breakdown.completion}`,
          color: breakdown.completion > 0 ? "text-yellow-400" : "text-red-400"
        } : null, breakdown.phase !== 0 ? {
          label: "Phase",
          value: breakdown.phase > 0 ? `+${breakdown.phase}` : `${breakdown.phase}`,
          color: breakdown.phase > 0 ? "text-green-400" : "text-red-400"
        } : null, breakdown.squeezeRelease > 0 ? {
          label: "Squeeze Release (Corridor)",
          value: `+${breakdown.squeezeRelease}`,
          color: "text-purple-400"
        } : null, breakdown.squeezeOn > 0 ? {
          label: "Squeeze On (Corridor)",
          value: `+${breakdown.squeezeOn}`,
          color: "text-yellow-400"
        } : null, breakdown.phaseZoneChange > 0 ? {
          label: "Phase Zone Change",
          value: `+${breakdown.phaseZoneChange}`,
          color: "text-blue-400"
        } : null, breakdown.rr !== 0 ? {
          label: "Risk/Reward",
          value: `+${breakdown.rr}`,
          color: "text-green-400"
        } : null].filter(Boolean);
        return breakdownComponents.length > 0 ? /*#__PURE__*/React.createElement("div", {
          className: "border-t border-white/[0.06] my-3 pt-3"
        }, /*#__PURE__*/React.createElement("button", {
          onClick: () => setScoreExpanded(!scoreExpanded),
          className: "w-full flex items-center justify-between text-xs text-[#6b7280] mb-2 font-semibold hover:text-white transition-colors"
        }, /*#__PURE__*/React.createElement("span", null, "Score Breakdown"), /*#__PURE__*/React.createElement("span", {
          className: "text-base"
        }, scoreExpanded ? "▼" : "▶")), scoreExpanded && /*#__PURE__*/React.createElement("div", {
          className: "space-y-1.5"
        }, breakdownComponents.map((comp, idx) => /*#__PURE__*/React.createElement("div", {
          key: idx,
          className: "flex justify-between items-center text-xs"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, comp.label), /*#__PURE__*/React.createElement("span", {
          className: `font-semibold ${comp.color}`
        }, comp.value))), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center text-sm mt-2 pt-2 border-t border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280] font-semibold"
        }, "Total Score"), /*#__PURE__*/React.createElement("span", {
          className: "text-blue-400 font-bold text-base"
        }, Number.isFinite(breakdown.total) ? breakdown.total.toFixed(1) : "—")))) : null;
      })())) : null, railTab === "TECHNICALS" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
        className: "mt-6 pt-6 border-t-2 border-white/[0.06]"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-sm font-bold text-[#6b7280] mb-4"
      }, "\u26A1 Triggers"), /*#__PURE__*/React.createElement("div", {
        className: "p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
      }, triggerItems.length > 0 ? /*#__PURE__*/React.createElement("div", {
        className: "space-y-2"
      }, triggerItems.slice(0, 12).map((t, idx) => {
        const translateTrigger = raw => {
          const s = String(raw || "").trim();
          const translations = {
            'SQUEEZE_RELEASE_30M': 'Consolidation breakout (30min)',
            'ST_FLIP_30M': 'Momentum flip detected (30min)',
            'ST_FLIP_1H': 'Momentum flip detected (1hr)',
            'EMA_CROSS_1H_13_48': 'Moving average crossover (1hr)',
            'BUYABLE_DIP_1H_13_48': 'Pullback pattern detected (1hr)',
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
        return /*#__PURE__*/React.createElement("div", {
          key: idx,
          className: "flex items-start gap-2 text-xs"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-cyan-400 mt-0.5"
        }, "\u2022"), /*#__PURE__*/React.createElement("span", {
          className: "text-[#f0f2f5] flex-1"
        }, translateTrigger(t)));
      })) : /*#__PURE__*/React.createElement("div", {
        className: "text-xs text-[#6b7280]"
      }, "No trigger patterns detected."))), /*#__PURE__*/React.createElement("div", {
        className: "mt-6 pt-6 border-t-2 border-white/[0.06]"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-sm font-bold text-[#6b7280] mb-4"
      }, "\u23F1 Timeframes"), /*#__PURE__*/React.createElement("div", {
        className: "p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
      }, tfTech ? /*#__PURE__*/React.createElement("div", {
        className: "space-y-3"
      }, tfOrder.map(({
        k,
        label
      }) => {
        const row = tfTech[k] || null;
        const atr = row && row.atr ? row.atr : null;
        const ema = row && row.ema ? row.ema : null;
        const ph = row && row.ph ? row.ph : null;
        const sq = row && row.sq ? row.sq : null;
        const rsi = row && row.rsi ? row.rsi : null;
        const vis = ema && Number.isFinite(Number(ema.vis)) ? Number(ema.vis) : 0;
        const sig = ema && Number.isFinite(Number(ema.sig)) ? Number(ema.sig) : 0;
        const sigLabel = sig === 1 ? "Bullish" : sig === -1 ? "Bearish" : "Neutral";
        const sqIcons = (sq && sq.c ? "🗜️" : "") + (sq && sq.s ? "🧨" : "") + (sq && sq.r ? "⚡️" : "");
        const atrBand = (() => {
          if (!atr) return null;
          const side = Number(atr.s) === -1 ? "-" : "+";
          const lo = atr.lo != null ? String(atr.lo) : null;
          const hi = atr.hi != null ? String(atr.hi) : null;
          if (!lo) return null;
          return hi ? `${side}${lo}–${hi}` : `${side}${lo}+`;
        })();
        const atrLastCross = (() => {
          if (!atr || atr.x == null) return null;
          const dir = atr.xd === "dn" ? "↓" : atr.xd === "up" ? "↑" : "";
          const side = Number(atr.xs) === -1 ? "-" : "+";
          return dir ? `${dir} ${side}${atr.x}` : null;
        })();
        return /*#__PURE__*/React.createElement("div", {
          key: k,
          className: "bg-white/[0.02] border border-white/[0.06] rounded-lg p-3"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between mb-2"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-sm font-semibold text-white"
        }, label), /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] flex items-center gap-2"
        }, /*#__PURE__*/React.createElement("span", null, sqIcons), /*#__PURE__*/React.createElement("span", {
          className: `font-semibold ${sig === 1 ? "text-green-400" : sig === -1 ? "text-red-400" : "text-[#6b7280]"}`
        }, sigLabel))), /*#__PURE__*/React.createElement("div", {
          className: "grid grid-cols-2 gap-3"
        }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
          className: "text-[11px] text-[#6b7280] mb-1"
        }, "ATR band / last cross"), /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-white"
        }, atrBand ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
          className: "font-semibold"
        }, atrBand), atrLastCross ? /*#__PURE__*/React.createElement("span", {
          className: "ml-2 text-[#6b7280]"
        }, atrLastCross) : null) : /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "\u2014"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
          className: "text-[11px] text-[#6b7280] mb-1"
        }, "EMA visibility / stack"), /*#__PURE__*/React.createElement("div", {
          className: "flex flex-wrap gap-1 items-center"
        }, emaLevels.map((n, idx) => {
          const on = (vis & 1 << idx) !== 0;
          return /*#__PURE__*/React.createElement("span", {
            key: n,
            className: `px-1.5 py-0.5 rounded text-[10px] border ${on ? "bg-green-500/15 border-green-500/30 text-green-300" : "bg-red-500/10 border-red-500/30 text-red-300"}`,
            title: `Price ${on ? "≥" : "<"} EMA${n}`
          }, n);
        }), ema && ema.stack != null && /*#__PURE__*/React.createElement("span", {
          className: "ml-2 text-[10px] text-[#6b7280]"
        }, "stack:", " ", /*#__PURE__*/React.createElement("span", {
          className: "text-white font-semibold"
        }, ema.stack))))), /*#__PURE__*/React.createElement("div", {
          className: "grid grid-cols-2 gap-3 mt-3"
        }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
          className: "text-[11px] text-[#6b7280] mb-1"
        }, "Phase Level"), /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-white font-semibold"
        }, ph && ph.v != null ? ph.v : "—"), /*#__PURE__*/React.createElement("div", {
          className: "mt-1.5"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-[#6b7280]"
        }, "Last 5 dots (recent first):"), /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#cbd5ff] mt-0.5"
        }, (() => {
          const dots = (ph && Array.isArray(ph.dots) ? ph.dots : []).slice(0, 5);
          if (dots.length === 0) return "—";
          const dotLabels = dots.map(code => {
            switch (code) {
              case "P100":
                return "+100";
              case "P618":
                return "+61.8";
              case "N618":
                return "-61.8";
              case "N100":
                return "-100";
              default:
                return code || "";
            }
          }).filter(Boolean);
          return dotLabels.join(", ");
        })()))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
          className: "text-[11px] text-[#6b7280] mb-1"
        }, "Divergence"), /*#__PURE__*/React.createElement("div", {
          className: "text-base"
        }, (() => {
          const divs = (ph && Array.isArray(ph.div) ? ph.div : []).slice(0, 3);
          if (divs.length === 0) return /*#__PURE__*/React.createElement("span", {
            className: "text-xs text-[#6b7280]"
          }, "None");
          const mostRecent = divs[0];
          const emoji = mostRecent === "B" ? "🐂" : mostRecent === "S" ? "🐻" : "";
          const label = mostRecent === "B" ? "Bullish" : mostRecent === "S" ? "Bearish" : "";
          const color = mostRecent === "B" ? "text-green-400" : "text-red-400";
          return /*#__PURE__*/React.createElement("div", {
            className: `font-semibold ${color}`
          }, emoji, " ", label);
        })())), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
          className: "text-[11px] text-[#6b7280] mb-1"
        }, "RSI(5/14) / div"), /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-white"
        }, /*#__PURE__*/React.createElement("span", {
          className: "font-semibold"
        }, rsi && rsi.r5 != null ? rsi.r5 : "—"), /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, " ", "/", " "), /*#__PURE__*/React.createElement("span", {
          className: "font-semibold"
        }, rsi && rsi.r14 != null ? rsi.r14 : "—"), /*#__PURE__*/React.createElement("span", {
          className: "ml-2"
        }, (rsi && Array.isArray(rsi.div) ? rsi.div : []).slice(0, 2).map(divIcon).filter(Boolean).join(" "))))));
      })) : /*#__PURE__*/React.createElement("div", {
        className: "text-xs text-[#6b7280]"
      }, "No per-timeframe technicals available yet (update TradingView script + refresh data)."))), ticker.td_sequential && (() => {
        const tdSeq = ticker.td_sequential;
        return /*#__PURE__*/React.createElement("div", {
          className: "mt-6 pt-6 border-t-2 border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-sm font-bold text-[#6b7280] mb-4"
        }, "\uD83D\uDCC8 TD Sequential"), /*#__PURE__*/React.createElement("div", {
          className: "mb-4 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] mb-2"
        }, "Counts"), /*#__PURE__*/React.createElement("div", {
          className: "grid grid-cols-2 gap-2 text-xs"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Bullish Prep:"), /*#__PURE__*/React.createElement("span", {
          className: `font-semibold ${Number(tdSeq.bullish_prep_count || 0) >= 6 ? "text-yellow-400" : Number(tdSeq.bullish_prep_count || 0) >= 3 ? "text-green-400" : "text-[#6b7280]"}`
        }, tdSeq.bullish_prep_count || 0, "/9")), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Bearish Prep:"), /*#__PURE__*/React.createElement("span", {
          className: `font-semibold ${Number(tdSeq.bearish_prep_count || 0) >= 6 ? "text-yellow-400" : Number(tdSeq.bearish_prep_count || 0) >= 3 ? "text-red-400" : "text-[#6b7280]"}`
        }, tdSeq.bearish_prep_count || 0, "/9")), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Bullish Leadup:"), /*#__PURE__*/React.createElement("span", {
          className: `font-semibold ${Number(tdSeq.bullish_leadup_count || 0) >= 6 ? "text-yellow-400" : Number(tdSeq.bullish_leadup_count || 0) >= 3 ? "text-green-400" : "text-[#6b7280]"}`
        }, tdSeq.bullish_leadup_count || 0, "/13")), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Bearish Leadup:"), /*#__PURE__*/React.createElement("span", {
          className: `font-semibold ${Number(tdSeq.bearish_leadup_count || 0) >= 6 ? "text-yellow-400" : Number(tdSeq.bearish_leadup_count || 0) >= 3 ? "text-red-400" : "text-[#6b7280]"}`
        }, tdSeq.bearish_leadup_count || 0, "/13")))), /*#__PURE__*/React.createElement("div", {
          className: "mb-4 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] mb-2"
        }, "TD Sequential Patterns"), /*#__PURE__*/React.createElement("div", {
          className: "space-y-2"
        }, (tdSeq.td9_bullish === true || tdSeq.td9_bullish === "true") && /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-2"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-green-400 font-bold"
        }, "TD9"), /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Bullish (Prep Complete)")), (tdSeq.td9_bearish === true || tdSeq.td9_bearish === "true") && /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-2"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-red-400 font-bold"
        }, "TD9"), /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Bearish (Prep Complete)")), (tdSeq.td13_bullish === true || tdSeq.td13_bullish === "true") && /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-2"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-green-400 font-bold"
        }, "TD13"), /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Bullish (Leadup Complete)")), (tdSeq.td13_bearish === true || tdSeq.td13_bearish === "true") && /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-2"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-red-400 font-bold"
        }, "TD13"), /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Bearish (Leadup Complete)")), !tdSeq.td9_bullish && !tdSeq.td9_bearish && !tdSeq.td13_bullish && !tdSeq.td13_bearish && /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280]"
        }, "No TD9/TD13 patterns active"))), (tdSeq.exit_long === true || tdSeq.exit_long === "true" || tdSeq.exit_short === true || tdSeq.exit_short === "true") && /*#__PURE__*/React.createElement("div", {
          className: `mb-4 p-3 rounded-lg border-2 ${tdSeq.exit_long === true || tdSeq.exit_long === "true" ? "bg-red-500/20 border-red-500/50" : "bg-red-500/20 border-red-500/50"}`
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Exit Indicator"), /*#__PURE__*/React.createElement("span", {
          className: "font-bold text-sm text-red-400"
        }, tdSeq.exit_long === true || tdSeq.exit_long === "true" ? "EXIT LONG" : "EXIT SHORT")), /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] mt-1"
        }, "TD Sequential exhaustion/reversal detected")), tdSeq.boost !== undefined && tdSeq.boost !== null && Number(tdSeq.boost) !== 0 && /*#__PURE__*/React.createElement("div", {
          className: "mb-4 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Score Boost"), /*#__PURE__*/React.createElement("span", {
          className: `font-semibold ${Number(tdSeq.boost) > 0 ? "text-green-400" : "text-red-400"}`
        }, Number(tdSeq.boost) > 0 ? "+" : "", Number(tdSeq.boost).toFixed(1)))));
      })(), ticker.rsi && (() => {
        const rsi = ticker.rsi;
        const rsiValue = Number(rsi.value || 0);
        const rsiLevel = rsi.level || "neutral";
        const divergence = rsi.divergence || {};
        const divType = divergence.type || "none";
        const divStrength = Number(divergence.strength || 0);
        const rsiColor = rsiValue >= 70 ? "text-red-400" : rsiValue <= 30 ? "text-green-400" : rsiValue >= 50 ? "text-yellow-400" : "text-blue-400";
        const levelColor = rsiLevel === "overbought" ? "text-red-400" : rsiLevel === "oversold" ? "text-green-400" : rsiLevel === "bullish" ? "text-yellow-400" : "text-blue-400";
        return /*#__PURE__*/React.createElement("div", {
          className: "mt-6 pt-6 border-t-2 border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-sm font-bold text-[#6b7280] mb-4"
        }, "\uD83D\uDCCA RSI & Divergence"), /*#__PURE__*/React.createElement("div", {
          className: "mb-4 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center mb-2"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "RSI (14)"), /*#__PURE__*/React.createElement("span", {
          className: `font-bold text-lg ${rsiColor}`
        }, rsiValue.toFixed(2))), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Level"), /*#__PURE__*/React.createElement("span", {
          className: `text-xs font-semibold ${levelColor}`
        }, rsiLevel.charAt(0).toUpperCase() + rsiLevel.slice(1))), /*#__PURE__*/React.createElement("div", {
          className: "mt-2 h-2 bg-white/[0.04] rounded-full overflow-hidden"
        }, /*#__PURE__*/React.createElement("div", {
          className: `h-full rounded-full transition-all ${rsiValue >= 70 ? "bg-red-500" : rsiValue <= 30 ? "bg-green-500" : rsiValue >= 50 ? "bg-yellow-500" : "bg-blue-500"}`,
          style: {
            width: `${rsiValue}%`
          }
        })), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between text-[10px] text-[#6b7280] mt-1"
        }, /*#__PURE__*/React.createElement("span", null, "0"), /*#__PURE__*/React.createElement("span", null, "30"), /*#__PURE__*/React.createElement("span", null, "50"), /*#__PURE__*/React.createElement("span", null, "70"), /*#__PURE__*/React.createElement("span", null, "100"))), divType !== "none" && /*#__PURE__*/React.createElement("div", {
          className: `mb-4 p-3 rounded-lg border-2 ${divType === "bullish" ? "bg-green-500/20 border-green-500/50" : "bg-red-500/20 border-red-500/50"}`
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between mb-1"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Divergence"), /*#__PURE__*/React.createElement("span", {
          className: `font-bold text-sm ${divType === "bullish" ? "text-green-400" : "text-red-400"}`
        }, divType === "bullish" ? "🔼 BULLISH" : "🔽 BEARISH")), /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280]"
        }, divType === "bullish" ? "Price lower low, RSI higher low (potential reversal up)" : "Price higher high, RSI lower high (potential reversal down)"), divStrength > 0 && /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] mt-1"
        }, "Strength: ", divStrength.toFixed(2))), divType === "none" && /*#__PURE__*/React.createElement("div", {
          className: "mb-4 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280]"
        }, "No divergence detected")));
      })(), /*#__PURE__*/React.createElement("div", {
        className: "mb-4 p-3 bg-white/[0.03] border-2 border-white/[0.06] rounded-lg"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-sm text-[#6b7280] mb-2"
      }, "State & Horizon"), /*#__PURE__*/React.createElement("div", {
        className: "space-y-2 text-xs"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex justify-between items-center"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-[#6b7280]"
      }, "State"), /*#__PURE__*/React.createElement("span", {
        className: "font-semibold"
      }, ticker.state || "—")), /*#__PURE__*/React.createElement("div", {
        className: "flex justify-between items-center"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-[#6b7280]"
      }, "Horizon"), /*#__PURE__*/React.createElement("span", {
        className: "font-semibold"
      }, (() => {
        const bucket = String(ticker.horizon_bucket || "").trim().toUpperCase();
        if (bucket) return bucket.replace("_", " ");
        const eta = computeEtaDays(ticker);
        if (!Number.isFinite(eta)) return "—";
        if (eta <= 7) return "SHORT TERM";
        if (eta <= 30) return "SWING";
        return "POSITIONAL";
      })()))), detectedPatterns && detectedPatterns.length > 0 && /*#__PURE__*/React.createElement("div", {
        className: "mt-3 pt-3 border-t border-white/[0.06]"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-xs font-semibold text-yellow-400 mb-2"
      }, "Detected Patterns"), /*#__PURE__*/React.createElement("div", {
        className: "space-y-2"
      }, detectedPatterns.map((pattern, idx) => /*#__PURE__*/React.createElement("div", {
        key: `pattern-${idx}`,
        className: "p-2 rounded border bg-white/[0.02] border-white/[0.06]"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center justify-between"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-xs text-white font-semibold"
      }, pattern.description), /*#__PURE__*/React.createElement("span", {
        className: "text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300"
      }, pattern.confidence)), pattern.quadrant && /*#__PURE__*/React.createElement("div", {
        className: "text-[10px] text-[#6b7280] mt-0.5"
      }, pattern.quadrant)))))), (ticker.daily_ema_cloud || ticker.fourh_ema_cloud || ticker.oneh_ema_cloud) && (() => {
        const daily = ticker.daily_ema_cloud;
        const fourH = ticker.fourh_ema_cloud;
        const oneH = ticker.oneh_ema_cloud;
        const getPositionColor = position => {
          if (position === "above") return "text-green-400";
          if (position === "below") return "text-red-400";
          return "text-yellow-400";
        };
        const getPositionEmoji = position => {
          if (position === "above") return "🔼";
          if (position === "below") return "🔽";
          return "➡️";
        };
        return /*#__PURE__*/React.createElement("div", {
          className: "mt-6 pt-6 border-t-2 border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-sm font-bold text-[#6b7280] mb-4"
        }, "\u2601\uFE0F EMA Cloud Positions"), daily && /*#__PURE__*/React.createElement("div", {
          className: "mb-3 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] mb-2 font-semibold"
        }, "Daily (5-8 EMA)"), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center mb-1"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Position"), /*#__PURE__*/React.createElement("span", {
          className: `text-xs font-semibold ${getPositionColor(daily.position)}`
        }, getPositionEmoji(daily.position), " ", daily.position.toUpperCase())), /*#__PURE__*/React.createElement("div", {
          className: "grid grid-cols-2 gap-2 text-xs mt-2"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Upper:"), /*#__PURE__*/React.createElement("span", {
          className: "text-white"
        }, "$", Number(daily.upper).toFixed(2))), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Lower:"), /*#__PURE__*/React.createElement("span", {
          className: "text-white"
        }, "$", Number(daily.lower).toFixed(2))), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between col-span-2"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Price:"), /*#__PURE__*/React.createElement("span", {
          className: "text-white font-semibold"
        }, "$", Number(daily.price).toFixed(2))))), fourH && /*#__PURE__*/React.createElement("div", {
          className: "mb-3 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] mb-2 font-semibold"
        }, "4H (8-13 EMA)"), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center mb-1"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Position"), /*#__PURE__*/React.createElement("span", {
          className: `text-xs font-semibold ${getPositionColor(fourH.position)}`
        }, getPositionEmoji(fourH.position), " ", fourH.position.toUpperCase())), /*#__PURE__*/React.createElement("div", {
          className: "grid grid-cols-2 gap-2 text-xs mt-2"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Upper:"), /*#__PURE__*/React.createElement("span", {
          className: "text-white"
        }, "$", Number(fourH.upper).toFixed(2))), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Lower:"), /*#__PURE__*/React.createElement("span", {
          className: "text-white"
        }, "$", Number(fourH.lower).toFixed(2))), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between col-span-2"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Price:"), /*#__PURE__*/React.createElement("span", {
          className: "text-white font-semibold"
        }, "$", Number(fourH.price).toFixed(2))))), oneH && /*#__PURE__*/React.createElement("div", {
          className: "mb-3 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] mb-2 font-semibold"
        }, "1H (13-21 EMA)"), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center mb-1"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Position"), /*#__PURE__*/React.createElement("span", {
          className: `text-xs font-semibold ${getPositionColor(oneH.position)}`
        }, getPositionEmoji(oneH.position), " ", oneH.position.toUpperCase())), /*#__PURE__*/React.createElement("div", {
          className: "grid grid-cols-2 gap-2 text-xs mt-2"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Upper:"), /*#__PURE__*/React.createElement("span", {
          className: "text-white"
        }, "$", Number(oneH.upper).toFixed(2))), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Lower:"), /*#__PURE__*/React.createElement("span", {
          className: "text-white"
        }, "$", Number(oneH.lower).toFixed(2))), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between col-span-2"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Price:"), /*#__PURE__*/React.createElement("span", {
          className: "text-white font-semibold"
        }, "$", Number(oneH.price).toFixed(2))))));
      })(), ticker.fundamentals && (() => {
        const fund = ticker.fundamentals;
        const hasValuationData = fund.pe_ratio !== null || fund.peg_ratio !== null || fund.eps_growth_rate !== null;
        if (!hasValuationData) return null;
        const valuationSignal = fund.valuation_signal || "fair";
        const signalColor = valuationSignal === "undervalued" ? "text-green-400" : valuationSignal === "overvalued" ? "text-red-400" : "text-yellow-400";
        const signalBg = valuationSignal === "undervalued" ? "bg-green-500/20 border-green-500/50" : valuationSignal === "overvalued" ? "bg-red-500/20 border-red-500/50" : "bg-yellow-500/20 border-yellow-500/50";
        return /*#__PURE__*/React.createElement("div", {
          className: "mt-6 pt-6 border-t-2 border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-sm font-bold text-[#6b7280] mb-4"
        }, "\uD83D\uDCCA Fundamental & Valuation"), fund.valuation_signal && /*#__PURE__*/React.createElement("div", {
          className: `mb-4 p-3 rounded-lg border-2 ${signalBg}`
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Valuation Indicator"), /*#__PURE__*/React.createElement("span", {
          className: `font-bold text-sm ${signalColor}`
        }, fund.valuation_signal.toUpperCase())), fund.valuation_confidence && /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] mt-1"
        }, "Confidence:", " ", /*#__PURE__*/React.createElement("span", {
          className: "font-semibold"
        }, fund.valuation_confidence)), fund.valuation_reasons && fund.valuation_reasons.length > 0 && /*#__PURE__*/React.createElement("div", {
          className: "mt-2 pt-2 border-t border-current/30"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-[#6b7280] mb-1"
        }, "Reasons:"), fund.valuation_reasons.map((reason, idx) => /*#__PURE__*/React.createElement("div", {
          key: idx,
          className: "text-[10px] text-[#6b7280]/80 mb-0.5"
        }, "\u2022 ", reason)))), /*#__PURE__*/React.createElement("div", {
          className: "space-y-2 text-sm mb-4"
        }, fund.pe_ratio !== null && /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center py-1 border-b border-white/[0.06]/50"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "P/E Ratio"), /*#__PURE__*/React.createElement("span", {
          className: "font-semibold"
        }, Number(fund.pe_ratio).toFixed(2))), fund.peg_ratio !== null && /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center py-1 border-b border-white/[0.06]/50"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "PEG Ratio"), /*#__PURE__*/React.createElement("span", {
          className: `font-semibold ${fund.peg_ratio < 0.8 ? "text-green-400" : fund.peg_ratio < 1.0 ? "text-yellow-400" : fund.peg_ratio > 1.5 ? "text-red-400" : "text-[#6b7280]"}`
        }, Number(fund.peg_ratio).toFixed(2))), fund.eps !== null && /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center py-1 border-b border-white/[0.06]/50"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "EPS (TTM)"), /*#__PURE__*/React.createElement("span", {
          className: "font-semibold"
        }, "$", Number(fund.eps).toFixed(2))), fund.eps_growth_rate !== null && /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center py-1 border-b border-white/[0.06]/50"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "EPS Growth (Annual)"), /*#__PURE__*/React.createElement("span", {
          className: `font-semibold ${fund.eps_growth_rate > 20 ? "text-green-400" : fund.eps_growth_rate > 10 ? "text-yellow-400" : fund.eps_growth_rate > 0 ? "text-[#6b7280]" : "text-red-400"}`
        }, Number(fund.eps_growth_rate).toFixed(1), "%")), (() => {
          const marketCap = fund.market_cap;
          const isValid = marketCap !== null && marketCap !== undefined && marketCap !== "" && (typeof marketCap === "number" || typeof marketCap === "string") && !isNaN(Number(marketCap)) && Number(marketCap) > 0;
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
          return /*#__PURE__*/React.createElement("div", {
            className: "flex justify-between items-center py-1 border-b border-white/[0.06]/50"
          }, /*#__PURE__*/React.createElement("span", {
            className: "text-[#6b7280]"
          }, "Market Cap"), /*#__PURE__*/React.createElement("span", {
            className: "font-semibold"
          }, formatted));
        })(), fund.industry && /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center py-1 border-b border-white/[0.06]/50"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Industry"), /*#__PURE__*/React.createElement("span", {
          className: "font-semibold text-xs"
        }, fund.industry))), fund.fair_value_price !== null && fund.fair_value_price > 0 && /*#__PURE__*/React.createElement("div", {
          className: "mb-4 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] mb-2"
        }, "Fair Value"), /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between mb-2"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-sm text-[#6b7280]"
        }, "Fair Value Price"), /*#__PURE__*/React.createElement("span", {
          className: "font-bold text-lg text-blue-400"
        }, "$", Number(fund.fair_value_price).toFixed(2))), fund.premium_discount_pct !== null && /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Premium/Discount"), /*#__PURE__*/React.createElement("span", {
          className: `font-semibold ${fund.premium_discount_pct < -10 ? "text-green-400" : fund.premium_discount_pct < 0 ? "text-yellow-400" : fund.premium_discount_pct > 10 ? "text-red-400" : "text-[#6b7280]"}`
        }, fund.premium_discount_pct > 0 ? "+" : "", Number(fund.premium_discount_pct).toFixed(1), "%")), fund.fair_value_pe && fund.fair_value_pe.preferred && /*#__PURE__*/React.createElement("div", {
          className: "mt-2 pt-2 border-t border-white/[0.06] text-xs text-[#6b7280]"
        }, "Fair P/E:", " ", /*#__PURE__*/React.createElement("span", {
          className: "font-semibold"
        }, Number(fund.fair_value_pe.preferred).toFixed(2)))), fund.pe_percentiles && /*#__PURE__*/React.createElement("div", {
          className: "mb-4 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] mb-2"
        }, "Historical P/E Percentiles"), /*#__PURE__*/React.createElement("div", {
          className: "grid grid-cols-2 gap-2 text-xs"
        }, fund.pe_percentiles.p10 !== null && /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "10th:"), /*#__PURE__*/React.createElement("span", {
          className: "font-semibold"
        }, Number(fund.pe_percentiles.p10).toFixed(1))), fund.pe_percentiles.p25 !== null && /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "25th:"), /*#__PURE__*/React.createElement("span", {
          className: "font-semibold"
        }, Number(fund.pe_percentiles.p25).toFixed(1))), fund.pe_percentiles.p50 !== null && /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "50th (Median):"), /*#__PURE__*/React.createElement("span", {
          className: "font-semibold text-blue-400"
        }, Number(fund.pe_percentiles.p50).toFixed(1))), fund.pe_percentiles.p75 !== null && /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "75th:"), /*#__PURE__*/React.createElement("span", {
          className: "font-semibold"
        }, Number(fund.pe_percentiles.p75).toFixed(1))), fund.pe_percentiles.p90 !== null && /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "90th:"), /*#__PURE__*/React.createElement("span", {
          className: "font-semibold"
        }, Number(fund.pe_percentiles.p90).toFixed(1))), fund.pe_percentiles.avg !== null && /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between col-span-2 pt-1 border-t border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Average:"), /*#__PURE__*/React.createElement("span", {
          className: "font-semibold"
        }, Number(fund.pe_percentiles.avg).toFixed(1)))), fund.pe_percentile_position && /*#__PURE__*/React.createElement("div", {
          className: "mt-2 pt-2 border-t border-white/[0.06] text-xs"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Current Position:", " "), /*#__PURE__*/React.createElement("span", {
          className: `font-semibold ${fund.pe_percentile_position.includes("Bottom") ? "text-green-400" : fund.pe_percentile_position.includes("Top") ? "text-red-400" : "text-[#6b7280]"}`
        }, fund.pe_percentile_position))), ticker.rank_components && ticker.rank_components.valuation_boost !== undefined && ticker.rank_components.valuation_boost !== 0 && /*#__PURE__*/React.createElement("div", {
          className: "mb-4 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#6b7280] mb-1"
        }, "Rank Components"), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center text-xs"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Base Rank"), /*#__PURE__*/React.createElement("span", {
          className: "font-semibold"
        }, ticker.rank_components.base_rank || baseScore)), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center text-xs mt-1"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Valuation Boost"), /*#__PURE__*/React.createElement("span", {
          className: `font-semibold ${ticker.rank_components.valuation_boost > 0 ? "text-green-400" : "text-red-400"}`
        }, ticker.rank_components.valuation_boost > 0 ? "+" : "", ticker.rank_components.valuation_boost)), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between items-center text-sm mt-2 pt-2 border-t border-white/[0.06]"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280] font-semibold"
        }, "Final Rank"), /*#__PURE__*/React.createElement("span", {
          className: "font-bold text-blue-400"
        }, baseScore))));
      })()) : null, false ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
        className: "mb-4 p-3 bg-white/[0.03] border-2 border-white/[0.06] rounded-lg"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center justify-between gap-2 mb-3"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-sm text-[#6b7280]"
      }, "Chart (REMOVED)"), /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-1 flex-wrap"
      }, [{
        tf: "5",
        label: "5m"
      }, {
        tf: "10",
        label: "10m"
      }, {
        tf: "30",
        label: "30m"
      }, {
        tf: "60",
        label: "1H"
      }, {
        tf: "240",
        label: "4H"
      }, {
        tf: "D",
        label: "D"
      }, {
        tf: "W",
        label: "W"
      }, {
        tf: "M",
        label: "M"
      }].map(t => {
        const active = String(chartTf) === String(t.tf);
        return /*#__PURE__*/React.createElement("button", {
          key: `tf-${t.tf}`,
          onClick: () => setChartTf(String(t.tf)),
          className: `px-2 py-1 rounded border text-[11px] font-semibold transition-all ${active ? "border-blue-400 bg-blue-500/20 text-blue-200" : "border-white/[0.06] bg-white/[0.02] text-[#6b7280] hover:text-white"}`,
          title: `Show ${t.label} candles`
        }, t.label);
      }))), chartLoading ? /*#__PURE__*/React.createElement("div", {
        className: "text-xs text-[#6b7280]"
      }, "Loading candles\u2026") : chartError ? /*#__PURE__*/React.createElement("div", {
        className: "text-xs text-yellow-300"
      }, "Failed to load candles: ", chartError) : !Array.isArray(chartCandles) || chartCandles.length < 2 ? /*#__PURE__*/React.createElement("div", {
        className: "text-xs text-[#6b7280]"
      }, "No candles yet for this timeframe. (Waiting for the TradingView candle capture feed.)") : (() => {
        try {
          const toMs = v => {
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
          const norm = c => {
            const tsRaw = c?.ts ?? c?.t ?? c?.time ?? c?.timestamp;
            const tsMs = toMs(tsRaw);
            const o = Number(c?.o ?? c?.open);
            const h = Number(c?.h ?? c?.high);
            const l = Number(c?.l ?? c?.low);
            const cl = Number(c?.c ?? c?.close);
            if (!Number.isFinite(tsMs) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cl)) return null;
            return {
              ...c,
              ts: tsMs,
              __ts_ms: tsMs,
              o,
              h,
              l,
              c: cl
            };
          };
          let candles = (Array.isArray(chartCandles) ? chartCandles : []).slice(-400).map(norm).filter(Boolean);

          // Sort + dedupe/aggregate to prevent duplicate bars (common on W captures).
          candles.sort((a, b) => Number(a.__ts_ms) - Number(b.__ts_ms));

          // Daily dedup: group by ET calendar date, keep the market-close candle (latest per day)
          if (String(chartTf) === "D") {
            const byDate = new Map();
            for (const c of candles) {
              const etDate = new Date(c.__ts_ms - 5 * 3600 * 1000);
              const dateKey = `${etDate.getUTCFullYear()}-${String(etDate.getUTCMonth() + 1).padStart(2, "0")}-${String(etDate.getUTCDate()).padStart(2, "0")}`;
              const prev = byDate.get(dateKey);
              if (!prev || c.__ts_ms > prev.__ts_ms) {
                byDate.set(dateKey, {
                  ...c,
                  _dateKey: dateKey
                });
              } else {
                prev.h = Math.max(prev.h, c.h);
                prev.l = Math.min(prev.l, c.l);
              }
            }
            candles = Array.from(byDate.values()).sort((a, b) => a.__ts_ms - b.__ts_ms);
          }
          const weekStartUtcMs = tsMs => {
            const d0 = new Date(Number(tsMs));
            const day = d0.getUTCDay(); // 0=Sun..6=Sat
            const daysSinceMon = (day + 6) % 7; // Mon->0, Tue->1, ... Sun->6
            const d = new Date(d0.getTime() - daysSinceMon * 24 * 60 * 60 * 1000);
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
                  _last_ts: Number(c.__ts_ms)
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
            candles = Array.from(byWeek.values()).sort((a, b) => Number(a.__ts_ms) - Number(b.__ts_ms)).map(c => {
              const out = {
                ...c
              };
              delete out._last_ts;
              return out;
            });
          } else {
            // Dedupe by timestamp (keep the latest sample per ts)
            const byTs = new Map();
            for (const c of candles) byTs.set(Number(c.__ts_ms), c);
            candles = Array.from(byTs.values()).sort((a, b) => Number(a.__ts_ms) - Number(b.__ts_ms));
          }
          const totalCandles2 = candles.length;
          if (totalCandles2 < 2) {
            return /*#__PURE__*/React.createElement("div", {
              className: "text-xs text-[#6b7280]"
            }, "Candle data loaded, but not in expected OHLC format.");
          }

          // TradingView-style viewport (shared zoom/pan state)
          const visCount2 = Math.max(10, Math.min(totalCandles2, chartVisibleCount));
          const endIdx2 = Math.max(visCount2, totalCandles2 - chartEndOffset);
          const startIdx2 = Math.max(0, endIdx2 - visCount2);
          const visibleCandles2 = candles.slice(startIdx2, endIdx2);
          const vn2 = visibleCandles2.length;
          if (vn2 < 1) return null;
          const lows = visibleCandles2.map(c => Number(c.l));
          const highs = visibleCandles2.map(c => Number(c.h));
          let minL = Math.min(...lows);
          let maxH = Math.max(...highs);
          if (!Number.isFinite(minL) || !Number.isFinite(maxH)) throw new Error("invalid_minmax");
          if (maxH <= minL) {
            maxH = minL + 1;
          }
          const pad = (maxH - minL) * 0.05;
          minL -= pad;
          maxH += pad;
          const H = 320;
          const leftMargin = 5;
          const rightMargin = 65;
          const ctrEl2 = chartContainerRef.current;
          const ctrW2 = ctrEl2 ? ctrEl2.clientWidth : 500;
          const W = ctrW2;
          const plotW = W - leftMargin - rightMargin;
          const plotH = H;
          const candleStep = plotW / vn2;
          const candleW = candleStep * 0.7;
          const bodyW = candleW * 0.9;
          const y = p => plotH - (p - minL) / (maxH - minL) * plotH;
          const priceStep = (maxH - minL) / 5;
          const priceTicks = [];
          for (let i = 0; i <= 5; i++) {
            priceTicks.push(minL + priceStep * i);
          }
          const handleMouseMove = e => {
            if (chartDragRef.current) {
              const dx = e.clientX - chartDragRef.current.startX;
              const cp = Math.round(dx / candleStep);
              setChartEndOffset(Math.max(0, Math.min(totalCandles2 - visCount2, chartDragRef.current.startOffset + cp)));
              return;
            }
            const rect = e.currentTarget.getBoundingClientRect();
            if (!rect || rect.width <= 0) return;
            const svgX = e.clientX - rect.left,
              svgY = e.clientY - rect.top;
            if (svgX < leftMargin || svgX > W - rightMargin) return;
            const idx = Math.floor((svgX - leftMargin) / plotW * vn2);
            if (idx >= 0 && idx < vn2) {
              const c = visibleCandles2[idx];
              if (!c) return;
              setCrosshair({
                x: svgX,
                y: svgY,
                candle: c,
                price: minL + (H - svgY) / plotH * (maxH - minL)
              });
            }
          };
          const handleMouseDown = e => {
            if (e.button !== 0) return;
            e.preventDefault();
            chartDragRef.current = {
              startX: e.clientX,
              startOffset: chartEndOffset
            };
            setCrosshair(null);
          };
          const handleMouseUp = () => {
            chartDragRef.current = null;
          };
          const handleWheel = e => {
            e.preventDefault();
            e.stopPropagation();
            const zs = Math.max(1, Math.round(visCount2 * 0.1));
            const nc = e.deltaY > 0 ? Math.min(totalCandles2, visCount2 + zs) : Math.max(10, visCount2 - zs);
            const sr = e.currentTarget.getBoundingClientRect();
            const mxf = (e.clientX - sr.left - leftMargin) / plotW;
            const cum = startIdx2 + Math.round(mxf * vn2);
            const nl = Math.max(0, Math.min(totalCandles2 - nc, cum - Math.round(mxf * nc)));
            setChartVisibleCount(nc);
            setChartEndOffset(Math.max(0, totalCandles2 - nl - nc));
          };
          // OHLC header
          const hc2 = crosshair?.candle || visibleCandles2[vn2 - 1];
          const hO2 = Number(hc2?.o),
            hH2 = Number(hc2?.h),
            hL2 = Number(hc2?.l),
            hC2 = Number(hc2?.c);
          const hChg2 = hC2 - hO2,
            hPct2 = hO2 > 0 ? hChg2 / hO2 * 100 : 0,
            hUp2 = hChg2 >= 0;
          let hTime2 = "";
          try {
            const hTs = Number(hc2?.__ts_ms ?? hc2?.ts);
            if (Number.isFinite(hTs)) {
              const d = new Date(hTs);
              const isDWM = ["D", "W", "M"].includes(String(chartTf));
              hTime2 = isDWM ? d.toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                timeZone: "America/New_York"
              }) : d.toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZone: "America/New_York"
              }) + " ET";
            }
          } catch {}
          return /*#__PURE__*/React.createElement("div", {
            className: "w-full relative"
          }, /*#__PURE__*/React.createElement("div", {
            className: "flex items-center gap-2 mb-0.5 text-[10px] font-mono h-5 select-none"
          }, /*#__PURE__*/React.createElement("span", {
            className: "text-[#6b7280]"
          }, hTime2), /*#__PURE__*/React.createElement("span", {
            className: "text-[#6b7280]"
          }, "O"), /*#__PURE__*/React.createElement("span", {
            className: "text-white"
          }, hO2.toFixed(2)), /*#__PURE__*/React.createElement("span", {
            className: "text-[#6b7280]"
          }, "H"), /*#__PURE__*/React.createElement("span", {
            className: "text-sky-300"
          }, hH2.toFixed(2)), /*#__PURE__*/React.createElement("span", {
            className: "text-[#6b7280]"
          }, "L"), /*#__PURE__*/React.createElement("span", {
            className: "text-orange-300"
          }, hL2.toFixed(2)), /*#__PURE__*/React.createElement("span", {
            className: "text-[#6b7280]"
          }, "C"), /*#__PURE__*/React.createElement("span", {
            className: hUp2 ? "text-teal-400 font-semibold" : "text-rose-400 font-semibold"
          }, hC2.toFixed(2)), /*#__PURE__*/React.createElement("span", {
            className: hUp2 ? "text-teal-400" : "text-rose-400"
          }, hUp2 ? "+" : "", hChg2.toFixed(2), " (", hUp2 ? "+" : "", hPct2.toFixed(2), "%)")), /*#__PURE__*/React.createElement("div", {
            ref: chartContainerRef,
            className: "rounded border border-white/[0.06] bg-[#0b0e11] overflow-hidden",
            style: {
              userSelect: "none"
            }
          }, /*#__PURE__*/React.createElement("svg", {
            width: W,
            height: H,
            viewBox: `0 0 ${W} ${H}`,
            style: {
              display: "block",
              cursor: chartDragRef.current ? "grabbing" : "crosshair"
            },
            onMouseMove: handleMouseMove,
            onMouseDown: handleMouseDown,
            onMouseUp: handleMouseUp,
            onMouseLeave: () => {
              setCrosshair(null);
              chartDragRef.current = null;
            },
            onWheel: handleWheel
          }, priceTicks.map((p, i) => {
            const yPos = y(p);
            return /*#__PURE__*/React.createElement("g", {
              key: `grid-${i}`
            }, /*#__PURE__*/React.createElement("line", {
              x1: leftMargin,
              y1: yPos,
              x2: W - rightMargin,
              y2: yPos,
              stroke: "rgba(38,50,95,0.5)",
              strokeWidth: "1"
            }), /*#__PURE__*/React.createElement("text", {
              x: W - rightMargin + 6,
              y: yPos + 4,
              fontSize: "11",
              fill: "#8b92a0",
              fontFamily: "monospace"
            }, "$", p.toFixed(2)));
          }), visibleCandles2.map((c, i) => {
            const o = Number(c.o);
            const h = Number(c.h);
            const l = Number(c.l);
            const cl = Number(c.c);
            const up = cl >= o;
            const stroke = up ? "rgba(56,189,248,0.95)" : "rgba(251,146,60,0.95)";
            const fill = up ? "rgba(56,189,248,0.90)" : "rgba(251,146,60,0.90)";
            const cx = leftMargin + i * candleStep + candleStep / 2;
            const yH = y(h);
            const yL = y(l);
            const yO = y(o);
            const yC = y(cl);
            const top = Math.min(yO, yC);
            const bot = Math.max(yO, yC);
            const bodyH = Math.max(1.5, bot - top);
            return /*#__PURE__*/React.createElement("g", {
              key: `c-${Number(c.ts)}-${i}`
            }, /*#__PURE__*/React.createElement("line", {
              x1: cx,
              y1: yH,
              x2: cx,
              y2: yL,
              stroke: stroke,
              strokeWidth: "1.2"
            }), /*#__PURE__*/React.createElement("rect", {
              x: cx - bodyW / 2,
              y: top,
              width: bodyW,
              height: bodyH,
              fill: fill,
              stroke: "none",
              rx: "0.5"
            }));
          }), crosshair ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("line", {
            x1: leftMargin,
            y1: crosshair.y,
            x2: W - rightMargin,
            y2: crosshair.y,
            stroke: "rgba(147,164,214,0.5)",
            strokeWidth: "1",
            strokeDasharray: "4 4"
          }), /*#__PURE__*/React.createElement("line", {
            x1: crosshair.x,
            y1: 0,
            x2: crosshair.x,
            y2: H,
            stroke: "rgba(147,164,214,0.5)",
            strokeWidth: "1",
            strokeDasharray: "4 4"
          }), (() => {
            const yLabel = Math.max(10, Math.min(H - 10, Number(crosshair.y)));
            const price = Number(crosshair.price);
            const priceText = Number.isFinite(price) ? `$${price.toFixed(2)}` : "—";
            return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("rect", {
              x: W - rightMargin + 2,
              y: yLabel - 10,
              width: rightMargin - 4,
              height: 20,
              fill: "rgba(18,26,51,0.92)",
              stroke: "rgba(38,50,95,0.9)",
              strokeWidth: "1",
              rx: "4"
            }), /*#__PURE__*/React.createElement("text", {
              x: W - rightMargin + (rightMargin - 4) / 2,
              y: yLabel + 4,
              fontSize: "11",
              fill: "#fbbf24",
              fontFamily: "monospace",
              fontWeight: "700",
              textAnchor: "middle"
            }, priceText));
          })()) : null)), false && crosshair && crosshair.candle ? /*#__PURE__*/React.createElement("div", {
            className: "absolute top-2 left-2 px-3 py-2 border border-white/[0.10] rounded-2xl text-[11px] pointer-events-none z-10",
            style: {
              background: "rgba(255,255,255,0.06)",
              backdropFilter: "blur(24px) saturate(1.4)",
              WebkitBackdropFilter: "blur(24px) saturate(1.4)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.45), inset 0 0.5px 0 rgba(255,255,255,0.08)"
            }
          }, /*#__PURE__*/React.createElement("div", {
            className: "font-semibold text-white mb-1"
          }, (() => {
            try {
              const ts = Number(crosshair?.candle?.__ts_ms ?? crosshair?.candle?.ts);
              if (!Number.isFinite(ts)) return "—";
              if (String(chartTf) === "W") {
                // Weekly candles: show the start-of-week (Monday) label
                const d0 = new Date(ts);
                const day = d0.getDay(); // 0=Sun..6=Sat
                const daysSinceMon = (day + 6) % 7; // Mon->0, Tue->1, ... Sun->6
                const d = new Date(d0.getTime() - daysSinceMon * 24 * 60 * 60 * 1000);
                d.setHours(0, 0, 0, 0);
                return `Week of ${d.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric"
                })}`;
              }
              const d = new Date(ts);
              return d.toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit"
              });
            } catch {
              return "—";
            }
          })()), /*#__PURE__*/React.createElement("div", {
            className: "grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]"
          }, /*#__PURE__*/React.createElement("div", {
            className: "text-[#6b7280]"
          }, "Price:"), /*#__PURE__*/React.createElement("div", {
            className: "text-yellow-300 font-mono font-semibold"
          }, "$", Number(crosshair.price).toFixed(2)), /*#__PURE__*/React.createElement("div", {
            className: "text-[#6b7280]"
          }, "O:"), /*#__PURE__*/React.createElement("div", {
            className: "text-white font-mono"
          }, "$", Number(crosshair.candle.o).toFixed(2)), /*#__PURE__*/React.createElement("div", {
            className: "text-[#6b7280]"
          }, "H:"), /*#__PURE__*/React.createElement("div", {
            className: "text-sky-300 font-mono"
          }, "$", Number(crosshair.candle.h).toFixed(2)), /*#__PURE__*/React.createElement("div", {
            className: "text-[#6b7280]"
          }, "L:"), /*#__PURE__*/React.createElement("div", {
            className: "text-orange-300 font-mono"
          }, "$", Number(crosshair.candle.l).toFixed(2)), /*#__PURE__*/React.createElement("div", {
            className: "text-[#6b7280]"
          }, "C:"), /*#__PURE__*/React.createElement("div", {
            className: `font-mono font-semibold ${Number(crosshair.candle.c) >= Number(crosshair.candle.o) ? "text-sky-300" : "text-orange-300"}`
          }, "$", Number(crosshair.candle.c).toFixed(2)))) : null, /*#__PURE__*/React.createElement("div", {
            className: "mt-2 text-[10px] text-[#6b7280] flex items-center justify-between"
          }, /*#__PURE__*/React.createElement("span", null, String(chartTf) === "D" ? "Daily" : String(chartTf) === "W" ? "Weekly" : `${chartTf}m`, " ", "\u2022 ", vn2, "/", totalCandles2, " bars"), /*#__PURE__*/React.createElement("span", {
            className: "text-[#555] text-[9px]"
          }, "scroll to zoom \u2022 drag to pan"), /*#__PURE__*/React.createElement("span", {
            className: "font-mono"
          }, "$", minL.toFixed(2), " \u2013 $", maxH.toFixed(2))));
        } catch (e) {
          console.error("[RightRail Chart] render failed:", e);
          return /*#__PURE__*/React.createElement("div", {
            className: "text-xs text-yellow-300"
          }, "Chart render error (data may be malformed). Check console for details.");
        }
      })())) : null, railTab === "TRADE_HISTORY" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
        className: "mb-4 p-3 bg-white/[0.03] border-2 border-white/[0.06] rounded-lg"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center justify-between mb-2"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-sm text-[#6b7280]"
      }, "Trade History"), /*#__PURE__*/React.createElement("a", {
        href: `simulation-dashboard.html?ticker=${encodeURIComponent(String(tickerSymbol).toUpperCase())}`,
        className: "text-xs px-2 py-1 rounded bg-blue-500/20 border border-blue-500/30 text-blue-300 hover:bg-blue-500/30",
        title: "Open full Trade Tracker"
      }, "Open")), ledgerTradesLoading ? /*#__PURE__*/React.createElement("div", {
        className: "text-xs text-[#6b7280] flex items-center gap-2"
      }, /*#__PURE__*/React.createElement("div", {
        className: "loading-spinner"
      }), "Loading trades\u2026") : ledgerTradesError ? /*#__PURE__*/React.createElement("div", {
        className: "text-xs text-red-400"
      }, "Ledger unavailable: ", ledgerTradesError) : ledgerTrades.length === 0 ? /*#__PURE__*/React.createElement("div", {
        className: "text-xs text-[#6b7280]"
      }, "No trades found for this ticker.") : /*#__PURE__*/React.createElement("div", {
        className: "space-y-3"
      }, (() => {
        const openTrades = ledgerTrades.filter(t => t.status !== "WIN" && t.status !== "LOSS");
        const closedTrades = ledgerTrades.filter(t => t.status === "WIN" || t.status === "LOSS");
        const totalClosedPnl = closedTrades.reduce((s, t) => s + Number(t.pnl || t.pnl_pct || 0), 0);
        const totalClosedPnlPct = closedTrades.reduce((s, t) => s + Number(t.pnl_pct || 0), 0);
        const wins = closedTrades.filter(t => Number(t.pnl_pct || t.pnl || 0) > 0).length;
        const losses = closedTrades.filter(t => Number(t.pnl_pct || t.pnl || 0) < 0).length;
        const flat = closedTrades.length - wins - losses;
        const isGain = totalClosedPnlPct >= 0;
        return /*#__PURE__*/React.createElement("div", {
          className: "p-2.5 rounded bg-white/[0.03] border border-white/[0.08] mb-1"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between mb-1"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[11px] text-[#6b7280] font-medium"
        }, ledgerTrades.length, " trade", ledgerTrades.length !== 1 ? "s" : "", openTrades.length > 0 && /*#__PURE__*/React.createElement("span", {
          className: "text-blue-400 ml-1"
        }, "(", openTrades.length, " open)")), closedTrades.length > 0 && /*#__PURE__*/React.createElement("span", {
          className: `text-sm font-bold ${isGain ? "text-green-400" : "text-red-400"}`
        }, isGain ? "+" : "", totalClosedPnlPct.toFixed(2), "%")), closedTrades.length > 0 && /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-2 text-[10px] text-[#6b7280]"
        }, wins > 0 && /*#__PURE__*/React.createElement("span", {
          className: "text-green-400"
        }, wins, "W"), losses > 0 && /*#__PURE__*/React.createElement("span", {
          className: "text-red-400"
        }, losses, "L"), flat > 0 && /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, flat, " flat")));
      })(), ledgerTrades.slice(0, 8).map(t => {
        const trimmedPct = Number(t.trimmed_pct || t.trimmedPct || 0);
        const isClosed = t.status === "WIN" || t.status === "LOSS" || t.status === "FLAT" || trimmedPct >= 0.9999;
        const pnl = Number(t.pnl || 0);
        const pnlPct = Number(t.pnl_pct || 0);
        const entryPrice = Number(t.entry_price || 0);
        const exitPrice = Number(t.exit_price || 0);
        const trimPrice = Number(t.trim_price || 0);
        const trimTs = t.trim_ts;
        const hasTrimmed = trimmedPct > 0;

        // Qty fields (enriched by backend from positions table)
        const remainingQty = Number(t.quantity ?? t.shares ?? 0);
        const entryQty = hasTrimmed && trimmedPct < 1 && remainingQty > 0 ? Math.round(remainingQty / (1 - trimmedPct) * 100) / 100 : remainingQty;
        const trimmedQty = hasTrimmed ? Math.round(entryQty * trimmedPct * 100) / 100 : 0;

        // Human-readable exit reason
        const exitReasonRaw = String(t.exit_reason || "").toLowerCase();
        const exitReasonLabel = (() => {
          if (!exitReasonRaw || !isClosed) return null;
          if (exitReasonRaw.includes("sl_breached")) return "SL Hit";
          if (exitReasonRaw.includes("max_loss")) return "Max Loss";
          if (exitReasonRaw.includes("bias_flip")) return "Bias Flip";
          if (exitReasonRaw.includes("hard_fuse")) return "RSI Extreme";
          if (exitReasonRaw.includes("soft_fuse")) return "RSI Confirmed";
          if (exitReasonRaw.includes("trigger_breached")) return "Trigger Breach";
          if (exitReasonRaw.includes("large_adverse")) return "Adverse Move";
          if (exitReasonRaw.includes("tp_hit")) return "TP Hit";
          if (exitReasonRaw.includes("critical")) return "Critical";
          if (exitReasonRaw) return exitReasonRaw.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
          return null;
        })();

        // Compute P&L% from prices if pnl_pct not available
        const computedPnlPct = (() => {
          if (Math.abs(pnlPct) > 0.001) return pnlPct;
          if (!isClosed || entryPrice <= 0 || exitPrice <= 0) return 0;
          const dir = String(t.direction || "").toUpperCase();
          return dir === "LONG" ? (exitPrice - entryPrice) / entryPrice * 100 : (entryPrice - exitPrice) / entryPrice * 100;
        })();
        const isFlat = isClosed && Math.abs(computedPnlPct) < 0.01;

        // Status label — FLAT if backend says so OR computed P&L ~ 0
        const statusLabel = t.status === "FLAT" || isFlat ? "FLAT" : t.status === "WIN" ? "WIN" : t.status === "LOSS" ? "LOSS" : null;
        const statusCls = t.status === "FLAT" || isFlat ? "bg-[#6b7280]/20 text-[#9ca3af] border border-[#6b7280]/30" : t.status === "WIN" ? "bg-green-500/20 text-green-400 border border-green-500/30" : t.status === "LOSS" ? "bg-red-500/20 text-red-400 border border-red-500/30" : null;
        const formatDateTime = ts => {
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

        // Duration
        const duration = (() => {
          const entryMs = Number(t.entry_ts);
          const exitMs = isClosed ? Number(t.exit_ts) : Date.now();
          if (!entryMs || !exitMs) return null;
          const diffMin = Math.round((exitMs - entryMs) / 60000);
          if (diffMin < 60) return `${diffMin}m`;
          const h = Math.floor(diffMin / 60);
          const m = diffMin % 60;
          return m > 0 ? `${h}h ${m}m` : `${h}h`;
        })();
        return /*#__PURE__*/React.createElement("div", {
          key: t.trade_id,
          className: "p-2.5 bg-white/[0.02] border border-white/[0.06] rounded"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between mb-1.5"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-1.5"
        }, isClosed ? /*#__PURE__*/React.createElement("span", {
          className: `px-1.5 py-0.5 rounded text-[9px] font-semibold ${statusCls}`
        }, statusLabel) : /*#__PURE__*/React.createElement("span", {
          className: "px-1.5 py-0.5 rounded text-[9px] font-semibold bg-blue-500/15 text-blue-300 border border-blue-500/30"
        }, "OPEN"), /*#__PURE__*/React.createElement("span", {
          className: `text-[11px] font-semibold ${t.direction === "LONG" ? "text-green-400" : "text-red-400"}`
        }, t.direction), entryQty > 0 && /*#__PURE__*/React.createElement("span", {
          className: "text-[9px] text-[#6b7280]"
        }, entryQty % 1 === 0 ? entryQty : entryQty.toFixed(2), " shares"), hasTrimmed && /*#__PURE__*/React.createElement("span", {
          className: "px-1 py-0.5 rounded text-[8px] font-semibold bg-yellow-500/20 text-yellow-300 border border-yellow-500/30"
        }, Math.round(trimmedPct * 100), "% trimmed", trimmedQty > 0 ? ` (${trimmedQty % 1 === 0 ? trimmedQty : trimmedQty.toFixed(2)} sh)` : ""), exitReasonLabel && /*#__PURE__*/React.createElement("span", {
          className: "px-1 py-0.5 rounded text-[8px] font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30",
          title: exitReasonRaw
        }, exitReasonLabel), duration && /*#__PURE__*/React.createElement("span", {
          className: "text-[9px] text-[#4b5563]"
        }, duration)), isClosed && /*#__PURE__*/React.createElement("span", {
          className: `text-xs font-bold ${isFlat ? "text-[#6b7280]" : computedPnlPct >= 0 ? "text-green-400" : "text-red-400"}`
        }, computedPnlPct >= 0 ? "+" : "", computedPnlPct.toFixed(2), "%")), !isClosed && (() => {
          const src = latestTicker || ticker;
          const cp = Number(src?.currentPrice ?? src?.cp ?? 0);
          const dayPct = Number(src?.dayPct ?? src?.dailyChangePct ?? 0);
          const dayChg = Number(src?.dayChg ?? src?.dailyChange ?? 0);
          const slVal = Number(src?.sl ?? t?.sl ?? 0);
          const tpVal = Number(src?.tp ?? t?.tp ?? 0);
          const isLong = String(t.direction || "").toUpperCase() === "LONG";
          const dayUp = dayPct >= 0;
          return /*#__PURE__*/React.createElement("div", {
            className: "mb-1.5"
          }, /*#__PURE__*/React.createElement("div", {
            className: "flex items-center justify-between mb-1"
          }, /*#__PURE__*/React.createElement("span", {
            className: "text-[10px] text-[#6b7280]"
          }, "Current"), /*#__PURE__*/React.createElement("div", {
            className: "flex items-center gap-1.5"
          }, /*#__PURE__*/React.createElement("span", {
            className: "text-xs text-white font-bold"
          }, cp > 0 ? `$${cp.toFixed(2)}` : "—"), /*#__PURE__*/React.createElement("span", {
            className: `text-[10px] font-semibold ${dayUp ? "text-teal-400" : "text-rose-400"}`
          }, dayUp ? "+" : "", dayPct.toFixed(2), "%", Number.isFinite(dayChg) && dayChg !== 0 ? ` ($${Math.abs(dayChg).toFixed(2)})` : ""))), (() => {
            const slOrigVal = Number(t?.sl_original ?? src?.position_sl_original ?? 0);
            const slTrailing = slOrigVal > 0 && slVal > 0 && Math.abs(slVal - slOrigVal) / slOrigVal > 0.005;
            return /*#__PURE__*/React.createElement("div", {
              className: "flex items-center justify-between text-[10px] mb-1"
            }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
              className: "text-rose-400",
              title: slTrailing ? "Trailing Stop Loss" : "Stop Loss"
            }, slTrailing ? "TSL" : "SL"), " ", /*#__PURE__*/React.createElement("span", {
              className: "text-white font-medium"
            }, slVal > 0 ? `$${slVal.toFixed(2)}` : "—")), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
              className: "text-[#6b7280]"
            }, "EP"), " ", /*#__PURE__*/React.createElement("span", {
              className: "text-white font-medium"
            }, "$", entryPrice > 0 ? entryPrice.toFixed(2) : "—")), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
              className: "text-teal-400"
            }, "TP"), " ", /*#__PURE__*/React.createElement("span", {
              className: "text-white font-medium"
            }, tpVal > 0 ? `$${tpVal.toFixed(2)}` : "—")));
          })(), slVal > 0 && tpVal > 0 && cp > 0 && entryPrice > 0 && (() => {
            const lo = Math.min(slVal, tpVal);
            const hi = Math.max(slVal, tpVal);
            const range = hi - lo;
            if (range <= 0) return null;
            // For SHORT: mirror so SL=left, TP=right (progress toward target)
            const rawCpPct = Math.max(0, Math.min(100, (cp - lo) / range * 100));
            const rawEpPct = Math.max(0, Math.min(100, (entryPrice - lo) / range * 100));
            const cpPct = isLong ? rawCpPct : 100 - rawCpPct;
            const epPct = isLong ? rawEpPct : 100 - rawEpPct;
            const isProfit = isLong ? cp >= entryPrice : cp <= entryPrice;
            return /*#__PURE__*/React.createElement("div", {
              className: "relative h-2 rounded-full bg-white/[0.06] border border-white/[0.08] overflow-visible"
            }, /*#__PURE__*/React.createElement("div", {
              className: `absolute top-0 bottom-0 left-0 rounded-full ${isProfit ? "bg-teal-500/50" : "bg-rose-500/40"}`,
              style: {
                width: `${cpPct}%`
              }
            }), /*#__PURE__*/React.createElement("div", {
              className: "absolute top-[-2px] bottom-[-2px] w-[2px] bg-white/60 rounded",
              style: {
                left: `${epPct}%`
              },
              title: `Entry $${entryPrice.toFixed(2)}`
            }), /*#__PURE__*/React.createElement("div", {
              className: `absolute top-[-3px] w-[6px] h-[6px] rounded-full border ${isProfit ? "bg-teal-400 border-teal-300" : "bg-rose-400 border-rose-300"}`,
              style: {
                left: `calc(${cpPct}% - 3px)`,
                top: "-1px"
              },
              title: `Current $${cp.toFixed(2)}`
            }));
          })());
        })(), /*#__PURE__*/React.createElement("div", {
          className: "grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Entry:"), /*#__PURE__*/React.createElement("span", {
          className: "text-white font-medium"
        }, "$", entryPrice > 0 ? entryPrice.toFixed(2) : "—")), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Date:"), /*#__PURE__*/React.createElement("span", {
          className: "text-[#9ca3af]"
        }, formatDateTime(t.entry_ts))), !isClosed && remainingQty > 0 && /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between col-span-2"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Qty:"), /*#__PURE__*/React.createElement("span", {
          className: "text-white font-medium"
        }, remainingQty % 1 === 0 ? remainingQty : remainingQty.toFixed(2), " shares", hasTrimmed && /*#__PURE__*/React.createElement("span", {
          className: "text-yellow-400 ml-1"
        }, "(", Math.round(trimmedPct * 100), "% trimmed)"))), hasTrimmed && trimPrice > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-yellow-500"
        }, "Trim:"), /*#__PURE__*/React.createElement("span", {
          className: "text-yellow-300 font-medium"
        }, "$", trimPrice.toFixed(2), trimmedQty > 0 && /*#__PURE__*/React.createElement("span", {
          className: "text-yellow-400/70 ml-1"
        }, "(", trimmedQty % 1 === 0 ? trimmedQty : trimmedQty.toFixed(2), " sh)"))), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-yellow-500"
        }, "Date:"), /*#__PURE__*/React.createElement("span", {
          className: "text-yellow-300/70"
        }, formatDateTime(trimTs)))), isClosed && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Exit:"), /*#__PURE__*/React.createElement("span", {
          className: `font-medium ${computedPnlPct >= 0 ? "text-green-400" : "text-red-400"}`
        }, "$", exitPrice > 0 ? exitPrice.toFixed(2) : "—")), /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Date:"), /*#__PURE__*/React.createElement("span", {
          className: "text-[#9ca3af]"
        }, formatDateTime(t.exit_ts))), exitReasonLabel && /*#__PURE__*/React.createElement("div", {
          className: "flex justify-between col-span-2"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-purple-400"
        }, "Reason:"), /*#__PURE__*/React.createElement("span", {
          className: "text-purple-300 font-medium",
          title: exitReasonRaw
        }, exitReasonLabel)))));
      }), ledgerTrades.length > 8 && /*#__PURE__*/React.createElement("div", {
        className: "text-[10px] text-[#4b5563] text-center"
      }, "Showing 8 of ", ledgerTrades.length, " trades")))) : null, railTab === "MODEL" ? /*#__PURE__*/React.createElement(React.Fragment, null, (() => {
        const src = latestTicker || ticker;
        const pm = src?.pattern_match;
        const kanbanMeta = src?.kanban_meta;
        const patternBoost = src?.__pattern_boost;
        const patternCaution = src?.__pattern_caution;
        return /*#__PURE__*/React.createElement("div", {
          className: "space-y-4"
        }, /*#__PURE__*/React.createElement("div", {
          className: "p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-sm font-bold text-[#6b7280] mb-3"
        }, "\uD83E\uDDE0 Model Signal"), pm ? /*#__PURE__*/React.createElement("div", {
          className: "space-y-3"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Direction"), /*#__PURE__*/React.createElement("span", {
          className: `px-2 py-0.5 rounded text-xs font-bold ${pm.direction === "BULLISH" ? "bg-[#00c853]/50 text-[#69f0ae] border border-[#00c853]/50" : pm.direction === "BEARISH" ? "bg-red-900/50 text-red-300 border border-red-700/50" : "bg-slate-800 text-slate-400 border border-slate-700"}`
        }, pm.direction)), /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Net Signal"), /*#__PURE__*/React.createElement("span", {
          className: `text-sm font-bold ${pm.netSignal > 0 ? "text-[#00e676]" : pm.netSignal < 0 ? "text-red-400" : "text-slate-300"}`
        }, pm.netSignal > 0 ? "+" : "", pm.netSignal.toFixed(3))), /*#__PURE__*/React.createElement("div", {
          className: "flex items-center justify-between"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, "Patterns Matched"), /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-white font-semibold"
        }, pm.bullCount, " bull / ", pm.bearCount, " bear")), patternBoost && /*#__PURE__*/React.createElement("div", {
          className: "p-2 rounded bg-[#00c853]/30 border border-[#00c853]/50 text-xs text-[#69f0ae]"
        }, "Entry confidence boosted to ", /*#__PURE__*/React.createElement("strong", null, patternBoost), " by pattern match"), patternCaution && /*#__PURE__*/React.createElement("div", {
          className: "p-2 rounded bg-amber-900/30 border border-amber-700/50 text-xs text-amber-300"
        }, "Caution: strong bear patterns detected (confidence: ", patternCaution, ")")) : /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#555] italic"
        }, "No pattern matches for this ticker at this time.")), pm && pm.matched && pm.matched.length > 0 && /*#__PURE__*/React.createElement("div", {
          className: "p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-sm font-bold text-[#6b7280] mb-3"
        }, "Matched Patterns"), /*#__PURE__*/React.createElement("div", {
          className: "space-y-2"
        }, pm.matched.map((m, i) => /*#__PURE__*/React.createElement("div", {
          key: m.id || i,
          className: "flex items-center justify-between bg-[#0d1117] rounded-lg p-2 border border-[#1e2530]"
        }, /*#__PURE__*/React.createElement("div", {
          className: "flex-1"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-xs font-semibold text-white"
        }, m.name), /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-[#555]"
        }, m.id)), /*#__PURE__*/React.createElement("div", {
          className: "flex items-center gap-2"
        }, /*#__PURE__*/React.createElement("span", {
          className: `px-1.5 py-0.5 rounded text-[10px] font-bold ${m.dir === "UP" ? "bg-[#00c853]/50 text-[#69f0ae]" : "bg-red-900/50 text-red-300"}`
        }, m.dir), /*#__PURE__*/React.createElement("span", {
          className: "text-xs text-[#6b7280]"
        }, (m.conf * 100).toFixed(0), "%"), /*#__PURE__*/React.createElement("span", {
          className: `text-xs font-semibold ${m.ev > 0 ? "text-[#00e676]" : m.ev < 0 ? "text-red-400" : "text-slate-400"}`
        }, "EV: ", m.ev > 0 ? "+" : "", m.ev)))))), pm && (pm.bestBull || pm.bestBear) && /*#__PURE__*/React.createElement("div", {
          className: "p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-sm font-bold text-[#6b7280] mb-3"
        }, "Strongest Signals"), /*#__PURE__*/React.createElement("div", {
          className: "grid grid-cols-2 gap-3"
        }, pm.bestBull && /*#__PURE__*/React.createElement("div", {
          className: "p-2 bg-[#00c853]/20 border border-[#00c853]/30 rounded-lg"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-[#00e676] uppercase font-bold mb-1"
        }, "Top Bull"), /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-white font-semibold"
        }, pm.bestBull.name), /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-[#69f0ae] mt-1"
        }, (pm.bestBull.conf * 100).toFixed(0), "% confidence \xB7 EV: ", pm.bestBull.ev > 0 ? "+" : "", pm.bestBull.ev)), pm.bestBear && /*#__PURE__*/React.createElement("div", {
          className: "p-2 bg-red-900/20 border border-red-700/30 rounded-lg"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-red-400 uppercase font-bold mb-1"
        }, "Top Bear"), /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-white font-semibold"
        }, pm.bestBear.name), /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-red-300 mt-1"
        }, (pm.bestBear.conf * 100).toFixed(0), "% confidence \xB7 EV: ", pm.bestBear.ev > 0 ? "+" : "", pm.bestBear.ev)))), kanbanMeta && kanbanMeta.patternMatch && /*#__PURE__*/React.createElement("div", {
          className: "p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-sm font-bold text-[#6b7280] mb-2"
        }, "\uD83E\uDDE0 Pattern-Driven Setup"), /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-blue-300"
        }, "This ticker was promoted from Watch to Setup by the model's pattern recognition engine.")), !pm && /*#__PURE__*/React.createElement("div", {
          className: "p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-[#555]"
        }, "The model evaluates ", tickerSymbol, " against 17+ active patterns every scoring cycle. Matches appear when the ticker's scoring state, signals, and indicators align with historically profitable setups.")));
      })()) : null, railTab === "JOURNEY" ? /*#__PURE__*/React.createElement(React.Fragment, null, (() => {
        if (candlePerfLoading) {
          return /*#__PURE__*/React.createElement("div", {
            className: "mb-4 p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg text-xs text-[#6b7280] flex items-center gap-2"
          }, /*#__PURE__*/React.createElement("div", {
            className: "loading-spinner"
          }), "Loading performance\u2026");
        }
        const perf = candlePerf?.performance;
        if (!perf || Object.keys(perf).length === 0) {
          return /*#__PURE__*/React.createElement("div", {
            className: "mb-4 p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg text-xs text-[#6b7280]"
          }, "Performance data unavailable.");
        }
        const sym = String(ticker.ticker).toUpperCase();
        const periods = [{
          label: '1D',
          key: '1D'
        }, {
          label: '5D',
          key: '5D'
        }, {
          label: '15D',
          key: '15D'
        }, {
          label: '30D',
          key: '30D'
        }, {
          label: '90D',
          key: '90D'
        }];
        const available = periods.map(p => ({
          ...p,
          data: perf[p.key]
        })).filter(p => p.data);
        if (available.length === 0) return null;
        const getInterpretation = (changePct, isUp, label) => {
          const absChg = Math.abs(changePct);
          if (absChg < 2) {
            return `${sym} is trading relatively flat over ${label}, showing ${absChg.toFixed(1)}% ${isUp ? 'gain' : 'loss'}. Price action suggests consolidation.`;
          } else if (absChg < 5) {
            return `${sym} is ${isUp ? 'up' : 'down'} ${absChg.toFixed(1)}% over ${label}, showing ${isUp ? 'modest bullish momentum' : 'mild weakness'}.`;
          } else if (absChg < 10) {
            return `${sym} has ${isUp ? 'gained' : 'lost'} ${absChg.toFixed(1)}% in ${label}, indicating ${isUp ? 'strong momentum' : 'significant selling pressure'}.`;
          } else if (absChg < 20) {
            return `${sym} is showing ${isUp ? 'explosive upside' : 'severe downside'} with a ${absChg.toFixed(1)}% ${isUp ? 'rally' : 'decline'} over ${label}.`;
          } else {
            return `${sym} has ${isUp ? 'surged' : 'plunged'} ${absChg.toFixed(1)}% in ${label}—a ${isUp ? 'parabolic' : 'dramatic'} move.`;
          }
        };
        return /*#__PURE__*/React.createElement("div", {
          className: "mb-4 space-y-3"
        }, available.map(({
          label,
          data
        }) => {
          const {
            changePct,
            changePoints,
            isUp,
            actualDays
          } = data;
          return /*#__PURE__*/React.createElement("div", {
            key: label,
            className: "p-3 bg-white/[0.03] border-2 border-white/[0.06] rounded-lg"
          }, /*#__PURE__*/React.createElement("div", {
            className: "flex items-center justify-between mb-2"
          }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
            className: "text-xs font-bold text-[#6b7280]"
          }, label), actualDays != null && /*#__PURE__*/React.createElement("span", {
            className: "ml-1.5 text-[10px] text-[#4b5563]"
          }, "(", actualDays, "d ago)")), /*#__PURE__*/React.createElement("div", {
            className: "text-right"
          }, /*#__PURE__*/React.createElement("div", {
            className: `text-lg font-bold ${isUp ? 'text-green-400' : 'text-red-400'}`
          }, isUp ? '+' : '', changePct.toFixed(2), "%"), /*#__PURE__*/React.createElement("div", {
            className: `text-xs ${isUp ? 'text-green-300/70' : 'text-red-300/70'}`
          }, isUp ? '+' : '', "$", changePoints.toFixed(2), " pts"))), /*#__PURE__*/React.createElement("div", {
            className: "text-xs text-[#cbd5ff] leading-relaxed bg-white/[0.02] p-2 rounded border border-white/[0.06]/50"
          }, getInterpretation(changePct, isUp, label)));
        }));
      })(), /*#__PURE__*/React.createElement("div", {
        className: "mb-4 p-3 bg-white/[0.03] border-2 border-white/[0.06] rounded-lg"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center justify-between mb-2"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-sm text-[#6b7280]"
      }, "Bubble Journey (15m increments)"), /*#__PURE__*/React.createElement("a", {
        href: `index-react.html?timeTravel=1&ticker=${encodeURIComponent(String(tickerSymbol).toUpperCase())}`,
        className: "text-xs px-2 py-1 rounded bg-purple-500/20 border border-purple-500/30 text-purple-300 hover:bg-purple-500/30",
        title: "Open Time Travel (if supported)"
      }, "Time Travel")), bubbleJourneyLoading ? /*#__PURE__*/React.createElement("div", {
        className: "text-xs text-[#6b7280] flex items-center gap-2"
      }, /*#__PURE__*/React.createElement("div", {
        className: "loading-spinner"
      }), "Loading trail\u2026") : bubbleJourneyError ? /*#__PURE__*/React.createElement("div", {
        className: "text-xs text-red-400"
      }, "Trail unavailable: ", bubbleJourneyError) : bubbleJourney.length === 0 ? /*#__PURE__*/React.createElement("div", {
        className: "text-xs text-[#6b7280]"
      }, "No trail points found for this ticker.") : /*#__PURE__*/React.createElement("div", {
        className: "space-y-1 max-h-64 overflow-y-auto pr-1"
      }, (() => {
        // Downsample and then deduplicate by removing consecutive entries
        // where state, kanban_stage, and scores haven't meaningfully changed
        const sampled = downsampleByInterval(bubbleJourney, 15 * 60 * 1000).slice().reverse().slice(0, 80);
        const deduped = [];
        let prev = null;
        for (const p of sampled) {
          if (!prev) {
            deduped.push(p);
            prev = p;
            continue;
          }
          const stateChanged = (p.state || '') !== (prev.state || '');
          const kanbanChanged = (p.kanban_stage || '') !== (prev.kanban_stage || '');
          const htfDelta = Math.abs((Number(p.htf_score) || 0) - (Number(prev.htf_score) || 0));
          const ltfDelta = Math.abs((Number(p.ltf_score) || 0) - (Number(prev.ltf_score) || 0));
          const priceDelta = Math.abs((Number(p.price) || 0) - (Number(prev.price) || 0)) / Math.max(Number(prev.price) || 1, 1);
          if (stateChanged || kanbanChanged || htfDelta >= 1.0 || ltfDelta >= 1.0 || priceDelta >= 0.003) {
            deduped.push(p);
            prev = p;
          }
        }
        return deduped.slice(0, 40);
      })().map((p, idx) => {
        const ts = Number(p.__ts_ms);
        const state = p.state || p.quadrant || p.zone || "—";
        const phasePct = p.phase_pct != null ? `${Math.round(Number(p.phase_pct) * 100)}%` : "—";
        const htf = p.htf_score != null && Number.isFinite(Number(p.htf_score)) ? Number(p.htf_score).toFixed(1) : "—";
        const ltf = p.ltf_score != null && Number.isFinite(Number(p.ltf_score)) ? Number(p.ltf_score).toFixed(1) : "—";
        const rank = p.rank != null ? String(p.rank) : "—";
        const rr = p.rr != null && Number.isFinite(Number(p.rr)) ? Number(p.rr).toFixed(2) : p.rr_at_alert != null && Number.isFinite(Number(p.rr_at_alert)) ? Number(p.rr_at_alert).toFixed(2) : "—";
        const isSelected = selectedJourneyTs != null && Number.isFinite(ts) && Number(ts) === Number(selectedJourneyTs);
        const pointForChart = {
          ts: Number.isFinite(ts) ? ts : null,
          htf_score: p.htf_score != null ? Number(p.htf_score) : null,
          ltf_score: p.ltf_score != null ? Number(p.ltf_score) : null,
          phase_pct: p.phase_pct != null ? Number(p.phase_pct) : null,
          completion: p.completion != null ? Number(p.completion) : null,
          rank: p.rank != null ? Number(p.rank) : null,
          rr: p.rr != null ? Number(p.rr) : null,
          state: p.state || null
        };
        return /*#__PURE__*/React.createElement("div", {
          key: `${ts}-${idx}`,
          className: `px-2 py-1 bg-white/[0.02] border rounded flex items-center justify-between gap-2 cursor-pointer transition-colors ${isSelected ? "border-cyan-400/80 bg-cyan-500/10" : "border-white/[0.06] hover:border-cyan-400/40 hover:bg-[#16224a]"}`,
          onMouseEnter: () => {
            if (onJourneyHover) onJourneyHover(pointForChart);
          },
          onMouseLeave: () => {
            if (onJourneyHover) onJourneyHover(null);
          },
          onClick: () => {
            if (onJourneySelect) onJourneySelect(pointForChart);
          }
        }, /*#__PURE__*/React.createElement("div", {
          className: "min-w-0"
        }, /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-[#6b7280]"
        }, Number.isFinite(ts) ? new Date(ts).toLocaleString() : "—"), /*#__PURE__*/React.createElement("div", {
          className: "text-xs text-white truncate"
        }, state, /*#__PURE__*/React.createElement("span", {
          className: "text-[#4b5563]"
        }, " ", "\u2022", " "), /*#__PURE__*/React.createElement("span", {
          className: "text-[#6b7280]"
        }, "Phase"), " ", phasePct), /*#__PURE__*/React.createElement("div", {
          className: "text-[10px] text-[#6b7280]"
        }, /*#__PURE__*/React.createElement("span", {
          className: "text-[#4b5563]"
        }, "HTF"), " ", /*#__PURE__*/React.createElement("span", {
          className: "text-white font-semibold"
        }, htf), /*#__PURE__*/React.createElement("span", {
          className: "text-[#4b5563]"
        }, " ", "\u2022", " "), /*#__PURE__*/React.createElement("span", {
          className: "text-[#4b5563]"
        }, "LTF"), " ", /*#__PURE__*/React.createElement("span", {
          className: "text-white font-semibold"
        }, ltf))), /*#__PURE__*/React.createElement("div", {
          className: "text-right text-[10px] text-[#6b7280] whitespace-nowrap"
        }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
          className: "text-[#4b5563]"
        }, "Rank"), " ", /*#__PURE__*/React.createElement("span", {
          className: "text-white font-semibold"
        }, rank)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
          className: "text-[#4b5563]"
        }, "RR"), " ", /*#__PURE__*/React.createElement("span", {
          className: "text-white font-semibold"
        }, rr))));
      }))), /*#__PURE__*/React.createElement("div", {
        className: "mb-4 p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-xs text-[#6b7280] mb-2 font-semibold"
      }, "Current Status"), /*#__PURE__*/React.createElement("div", {
        className: "grid grid-cols-3 gap-2 text-xs"
      }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
        className: "text-[#6b7280] text-[10px]"
      }, "Phase"), /*#__PURE__*/React.createElement("div", {
        className: "text-white font-semibold",
        style: {
          color: phaseColor
        }
      }, (phase * 100).toFixed(0), "%")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
        className: "text-[#6b7280] text-[10px]"
      }, "Completion"), /*#__PURE__*/React.createElement("div", {
        className: "text-white font-semibold"
      }, ticker.completion != null ? `${(Number(ticker.completion) * 100).toFixed(0)}%` : "—")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
        className: "text-[#6b7280] text-[10px]"
      }, "ETA"), /*#__PURE__*/React.createElement("div", {
        className: "text-white font-semibold"
      }, (() => {
        const eta = computeEtaDays(ticker);
        return Number.isFinite(eta) ? `${eta.toFixed(1)}d` : "—";
      })()))))) : null)), /*#__PURE__*/React.createElement("div", {
        className: "flex-shrink-0 p-6 pt-4 border-t border-white/[0.06] bg-white/[0.02]"
      }, /*#__PURE__*/React.createElement("a", {
        href: `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tickerSymbol)}`,
        target: "_blank",
        rel: "noopener noreferrer",
        className: "block w-full text-center px-4 py-2 bg-blue-500/20 border border-blue-500 rounded-lg hover:bg-blue-500/30 transition-all hover:scale-105 font-semibold"
      }, "\uD83D\uDCCA Open in TradingView"))));
    };
  };
})();