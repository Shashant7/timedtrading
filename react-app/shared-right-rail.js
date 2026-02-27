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
    const { useState, useEffect, useMemo, useRef } = React;
    const API_BASE = deps.API_BASE;
    const getTickerSector = deps.getTickerSector || (() => "");
    const sectorNorm = (deps.normalizeSectorKey != null && typeof deps.normalizeSectorKey === "function")
      ? deps.normalizeSectorKey
      : (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
    const sectorCanon = (deps.sectorKeyToCanonicalName != null && typeof deps.sectorKeyToCanonicalName === "function")
      ? deps.sectorKeyToCanonicalName
      : (k) => k || "";
    const fmtUsd = (deps.fmtUsd != null && typeof deps.fmtUsd === "function")
      ? deps.fmtUsd
      : (v) => (Number.isFinite(Number(v)) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(v)) : "—");
    const fmtUsdAbs = (deps.fmtUsdAbs != null && typeof deps.fmtUsdAbs === "function")
      ? deps.fmtUsdAbs
      : (n) => (Number.isFinite(Number(n)) ? `$${Math.abs(Number(n)).toFixed(2)}` : "—");
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
    function LWChart({ candles: rawCandles, chartTf, overlays, onCrosshair, height: propHeight }) {
      const containerRef = useRef(null);
      const chartInstanceRef = useRef(null);
      const candleSeriesRef = useRef(null);
      const overlaySeriesRef = useRef({});
      const [ohlcHeader, setOhlcHeader] = useState(null);

      const LWC = typeof LightweightCharts !== "undefined" ? LightweightCharts : null;

      // Normalize candles
      const mapped = useMemo(() => {
        if (!rawCandles || rawCandles.length < 2) return [];
        const toSec = (v) => {
          if (!v) return 0;
          const n = Number(v);
          return n > 1e12 ? Math.floor(n / 1000) : n > 1e9 ? n : 0;
        };
        return rawCandles
          .map(c => {
            const ts = toSec(c.ts ?? c.t ?? c.time ?? c.timestamp);
            const o = Number(c.o ?? c.open);
            const h = Number(c.h ?? c.high);
            const l = Number(c.l ?? c.low);
            const cl = Number(c.c ?? c.close);
            if (!ts || !Number.isFinite(o) || !Number.isFinite(h)) return null;
            return { time: ts, open: o, high: h, low: l, close: cl };
          })
          .filter(Boolean)
          .sort((a, b) => a.time - b.time)
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
          result.ema21 = mapped.map((c, i) => ema[i] != null ? { time: c.time, value: ema[i] } : null).filter(Boolean);
        }
        if (overlays.ema48) {
          const ema = computeEMA(closes, 48);
          result.ema48 = mapped.map((c, i) => ema[i] != null ? { time: c.time, value: ema[i] } : null).filter(Boolean);
        }
        if (overlays.ema200) {
          const ema = computeEMA(closes, 200);
          result.ema200 = mapped.map((c, i) => ema[i] != null ? { time: c.time, value: ema[i] } : null).filter(Boolean);
        }

        // SuperTrend (period=10, multiplier=3)
        if (overlays.supertrend && n >= 11) {
          const stP = 10, stM = 3;
          const tr = new Array(n).fill(0);
          for (let i = 1; i < n; i++) tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
          const atr = new Array(n).fill(0);
          for (let i = stP; i < n; i++) {
            let s = 0; for (let j = i - stP; j < i; j++) s += tr[j + 1]; atr[i] = s / stP;
          }
          const upArr = [], dnArr = [], dirArr = [];
          for (let i = 0; i < n; i++) { upArr.push(0); dnArr.push(0); dirArr.push(1); }
          for (let i = stP; i < n; i++) {
            const mid = (highs[i] + lows[i]) / 2;
            let up = mid - stM * atr[i];
            let dn = mid + stM * atr[i];
            if (i > stP) {
              up = (closes[i-1] > upArr[i-1]) ? Math.max(up, upArr[i-1]) : up;
              dn = (closes[i-1] < dnArr[i-1]) ? Math.min(dn, dnArr[i-1]) : dn;
            }
            upArr[i] = up; dnArr[i] = dn;
            if (i > stP) {
              if (dirArr[i-1] === 1) dirArr[i] = closes[i] < upArr[i] ? -1 : 1;
              else dirArr[i] = closes[i] > dnArr[i] ? 1 : -1;
            }
          }
          // SuperTrend as two separate series (bull/bear) for coloring
          result.stBull = mapped.map((c, i) => i >= stP && dirArr[i] === 1 ? { time: c.time, value: upArr[i] } : null).filter(Boolean);
          result.stBear = mapped.map((c, i) => i >= stP && dirArr[i] === -1 ? { time: c.time, value: dnArr[i] } : null).filter(Boolean);
        }

        // TD Sequential
        if (overlays.tdSequential && n >= 14) {
          const PREP_COMP = 4;
          let bullPrep = 0, bearPrep = 0;
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
                  text: String(count),
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
            background: { type: "solid", color: "#0b0e11" },
            textColor: "#6b7280",
            fontSize: 10,
          },
          grid: {
            vertLines: { color: "rgba(38,50,95,0.35)" },
            horzLines: { color: "rgba(38,50,95,0.35)" },
          },
          crosshair: {
            mode: LWC.CrosshairMode.Normal,
            vertLine: { color: "rgba(255,255,255,0.15)", width: 1, style: 2, labelBackgroundColor: "#1e293b" },
            horzLine: { color: "rgba(255,255,255,0.15)", width: 1, style: 2, labelBackgroundColor: "#1e293b" },
          },
          rightPriceScale: {
            borderColor: "rgba(38,50,95,0.5)",
            scaleMargins: { top: 0.05, bottom: 0.05 },
          },
          timeScale: {
            borderColor: "rgba(38,50,95,0.5)",
            timeVisible: !["D", "W", "M"].includes(String(chartTf)),
            secondsVisible: false,
            tickMarkFormatter: (time) => {
              try {
                const d = new Date(time * 1000);
                return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
              } catch { return ""; }
            },
          },
          localization: {
            timeFormatter: (time) => {
              try {
                const d = new Date(time * 1000);
                return d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "America/New_York" });
              } catch { return ""; }
            },
          },
          handleScroll: { vertTouchDrag: false },
        });
        chartInstanceRef.current = chart;

        // Candlestick series — standardized colors across all charts
        const candleSeries = chart.addCandlestickSeries({
          upColor: "#22c55e",
          downColor: "#ef4444",
          borderUpColor: "#22c55e",
          borderDownColor: "#ef4444",
          wickUpColor: "#22c55e",
          wickDownColor: "#ef4444",
        });
        candleSeries.setData(mapped);
        candleSeriesRef.current = candleSeries;

        // Overlay series
        const addedSeries = {};
        if (indicatorData.ema21?.length > 0) {
          const s = chart.addLineSeries({ color: "#fbbf24", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
          s.setData(indicatorData.ema21);
          addedSeries.ema21 = s;
        }
        if (indicatorData.ema48?.length > 0) {
          const s = chart.addLineSeries({ color: "#a78bfa", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
          s.setData(indicatorData.ema48);
          addedSeries.ema48 = s;
        }
        if (indicatorData.ema200?.length > 0) {
          const s = chart.addLineSeries({ color: "#f87171", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
          s.setData(indicatorData.ema200);
          addedSeries.ema200 = s;
        }
        if (indicatorData.stBull?.length > 0) {
          const s = chart.addLineSeries({ color: "#34d399", lineWidth: 2, lineStyle: LWC.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false });
          s.setData(indicatorData.stBull);
          addedSeries.stBull = s;
        }
        if (indicatorData.stBear?.length > 0) {
          const s = chart.addLineSeries({ color: "#f87171", lineWidth: 2, lineStyle: LWC.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false });
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
              c: candleData.close,
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
              chart.applyOptions({ width: w });
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
              chart.applyOptions({ width: w });
            }
            chart.timeScale().fitContent();
          }
          // Safety net for slow portal reflow
          setTimeout(() => {
            if (containerRef.current && chart) {
              const w = containerRef.current.clientWidth;
              if (w > 0) {
                chart.applyOptions({ width: w });
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
        return React.createElement("div", { className: "text-xs text-[#6b7280]" }, "Charts library not loaded.");
      }

      // OHLC header data
      const hdr = ohlcHeader || (mapped.length > 0 ? {
        time: mapped[mapped.length - 1].time,
        o: mapped[mapped.length - 1].open,
        h: mapped[mapped.length - 1].high,
        l: mapped[mapped.length - 1].low,
        c: mapped[mapped.length - 1].close,
      } : null);
      const hdrUp = hdr ? hdr.c >= hdr.o : true;
      const hdrChg = hdr ? hdr.c - hdr.o : 0;
      const hdrPct = hdr && hdr.o ? (hdrChg / hdr.o * 100) : 0;

      // Format time
      let hdrTimeStr = "";
      if (hdr) {
        try {
          const d = new Date(hdr.time * 1000);
          const isDWM = ["D", "W", "M"].includes(String(chartTf));
          hdrTimeStr = isDWM
            ? d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" })
            : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
        } catch {}
      }

      return React.createElement("div", { className: "w-full relative -mx-3 px-3" },
        // Overlay toggles
        React.createElement("div", { className: "flex items-center gap-1.5 mb-1 flex-wrap" },
          [
            { key: "ema21", label: "21 EMA", color: "#fbbf24" },
            { key: "ema48", label: "48 EMA", color: "#a78bfa" },
            { key: "ema200", label: "200 EMA", color: "#f87171" },
            { key: "supertrend", label: "SuperTrend", color: "#34d399" },
            { key: "tdSequential", label: "TD Seq", color: "#f59e0b" },
          ].map(ov =>
            React.createElement("button", {
              key: ov.key,
              onClick: () => onCrosshair?.(ov.key), // toggle overlay via parent
              className: `px-2 py-0.5 rounded text-[9px] font-semibold border transition-all ${
                overlays[ov.key]
                  ? "border-white/20 text-white"
                  : "border-white/[0.06] text-[#555] hover:text-[#6b7280]"
              }`,
              style: overlays[ov.key] ? { borderColor: ov.color + "80", color: ov.color, background: ov.color + "15" } : {},
            }, ov.label)
          )
        ),
        // OHLC header
        hdr && React.createElement("div", { className: "flex items-center gap-2 mb-0.5 text-[10px] font-mono h-5 select-none" },
          React.createElement("span", { className: "text-[#6b7280]" }, hdrTimeStr),
          React.createElement("span", { className: "text-[#6b7280]" }, "O"), React.createElement("span", { className: "text-white" }, hdr.o?.toFixed(2)),
          React.createElement("span", { className: "text-[#6b7280]" }, "H"), React.createElement("span", { className: "text-sky-300" }, hdr.h?.toFixed(2)),
          React.createElement("span", { className: "text-[#6b7280]" }, "L"), React.createElement("span", { className: "text-orange-300" }, hdr.l?.toFixed(2)),
          React.createElement("span", { className: "text-[#6b7280]" }, "C"),
          React.createElement("span", { className: hdrUp ? "text-teal-400 font-semibold" : "text-rose-400 font-semibold" }, hdr.c?.toFixed(2)),
          React.createElement("span", { className: hdrUp ? "text-teal-400" : "text-rose-400" },
            `${hdrUp ? "+" : ""}${hdrChg.toFixed(2)} (${hdrUp ? "+" : ""}${hdrPct.toFixed(2)}%)`)
        ),
        // Chart container
        React.createElement("div", {
          ref: containerRef,
          className: "rounded-lg overflow-hidden",
          style: { height: propHeight || 320, background: "#0b0e11" },
        }),
        // Status bar
        React.createElement("div", { className: "mt-1 text-[10px] text-[#6b7280] flex items-center justify-between" },
          React.createElement("span", null,
            `${["D","W","M"].includes(String(chartTf)) ? (chartTf === "D" ? "Daily" : chartTf === "W" ? "Weekly" : "Monthly") : Number(chartTf) >= 60 ? `${Number(chartTf)/60}H` : `${chartTf}m`} • ${mapped.length} bars`),
          React.createElement("span", { className: "text-[#555] text-[9px]" }, "scroll to zoom • drag to pan"),
        )
      );
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
        effectiveStage = null,
        earningsMap = null,
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

        const [railTab, setRailTab] = useState("ANALYSIS"); // ANALYSIS | TECHNICALS | MODEL | JOURNEY | TRADE_HISTORY | INVESTOR

        // Investor tab: per-ticker data from /timed/investor/ticker
        const [investorData, setInvestorData] = useState(null);
        const [investorLoading, setInvestorLoading] = useState(false);
        const [investorError, setInvestorError] = useState(null);

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
        const chartStateRef = useRef({ totalCandles: 0, visCount: 80, startIdx: 0, vn: 0, candleStep: 0, leftMargin: 10, plotW: 0 });

        // Native (non-passive) wheel listener for zoom — React onWheel is passive and ignores preventDefault
        useEffect(() => {
          const el = chartContainerRef.current;
          if (!el) return;
          const onWheel = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const { totalCandles, visCount, startIdx, vn, candleStep, leftMargin, plotW } = chartStateRef.current;
            if (totalCandles < 2 || plotW <= 0) return;
            const delta = e.deltaY;
            const zoomSpeed = Math.max(1, Math.round(visCount * 0.1));
            const newCount = delta > 0
              ? Math.min(totalCandles, visCount + zoomSpeed)
              : Math.max(10, visCount - zoomSpeed);
            const svgRect = el.getBoundingClientRect();
            const mouseXFrac = Math.max(0, Math.min(1, (e.clientX - svgRect.left - leftMargin) / plotW));
            const candleUnderMouse = startIdx + Math.round(mouseXFrac * vn);
            const newLeft = Math.max(0, Math.min(totalCandles - newCount, candleUnderMouse - Math.round(mouseXFrac * newCount)));
            const newEnd = newLeft + newCount;
            const newEndOff = Math.max(0, totalCandles - newEnd);
            setChartVisibleCount(newCount);
            setChartEndOffset(newEndOff);
          };
          el.addEventListener("wheel", onWheel, { passive: false });
          return () => el.removeEventListener("wheel", onWheel);
        });

        // Window-level mousemove/mouseup for robust drag-to-pan
        useEffect(() => {
          const onMove = (e) => {
            if (!chartDragRef.current) return;
            const { totalCandles, visCount, candleStep } = chartStateRef.current;
            if (candleStep <= 0) return;
            const dx = e.clientX - chartDragRef.current.startX;
            const candlesPanned = Math.round(dx / candleStep);
            const newOffset = Math.max(0, Math.min(totalCandles - visCount, chartDragRef.current.startOffset + candlesPanned));
            setChartEndOffset(newOffset);
          };
          const onUp = () => { chartDragRef.current = null; };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
          return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
        }, []);

        // Model signal data (ticker + sector + market level)
        const [modelSignal, setModelSignal] = useState(null);
        const [chartOverlays, setChartOverlays] = useState({ ema21: true, ema48: true, ema200: false, supertrend: false, tdSequential: false });
        const [chartExpanded, setChartExpanded] = useState(false);

        // Close expanded chart on Escape
        useEffect(() => {
          if (!chartExpanded) return;
          const onKey = (e) => { if (e.key === "Escape") setChartExpanded(false); };
          window.addEventListener("keydown", onKey);
          return () => window.removeEventListener("keydown", onKey);
        }, [chartExpanded]);
        
        // Accordion states (MUST be at component level, not inside IIFE blocks)
        const [scoreExpanded, setScoreExpanded] = useState(true);
        const [emaExpanded, setEmaExpanded] = useState(true);
        const [tpExpanded, setTpExpanded] = useState(true);

        // Price source: always use the ticker prop (same object the Card renders)
        // for price/change display. latestTicker is only for context/scoring data.
        // This guarantees the right rail shows identical values to the card.
        const priceSrc = ticker || {};

        // Prevent stale crosshair data from crashing renders when switching
        // tickers/timeframes/tabs quickly (e.g. clicking Chart right after selecting a ticker).
        useEffect(() => {
          setCrosshair(null);
        }, [tickerSymbol, chartTf, railTab]);

        // Default tab: use initialRailTab when provided (Investor mode → INVESTOR, Trade Tracker → TRADE_HISTORY), else Analysis
        useEffect(() => {
          const def = initialRailTab || "ANALYSIS";
          setRailTab(def === "INVESTOR" ? "INVESTOR" : def);
        }, [tickerSymbol, initialRailTab]);

        useEffect(() => {
          setChartCandles([]);
          setChartError(null);
          setChartLoading(false);
          setChartVisibleCount(80);
          setChartEndOffset(0);
        }, [tickerSymbol]);

        // Fetch investor data when INVESTOR tab is selected
        useEffect(() => {
          const sym = String(tickerSymbol || "").trim().toUpperCase();
          if (railTab !== "INVESTOR" || !sym) {
            setInvestorData(null);
            setInvestorError(null);
            setInvestorLoading(false);
            return;
          }
          let cancelled = false;
          const fetchInvestor = async () => {
            try {
              setInvestorLoading(true);
              setInvestorError(null);
              const res = await fetch(`${API_BASE}/timed/investor/ticker?ticker=${encodeURIComponent(sym)}`, { cache: "no-store" });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const json = await res.json();
              if (!json.ok) throw new Error(json.error || "investor_failed");
              if (!cancelled) setInvestorData({ ticker: sym, ...json });
            } catch (e) {
              if (!cancelled) {
                setInvestorData(null);
                setInvestorError(String(e?.message || e));
              }
            } finally {
              if (!cancelled) setInvestorLoading(false);
            }
          };
          fetchInvestor();
          return () => { cancelled = true; };
        }, [railTab, tickerSymbol]);

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
          const sym = String(tickerSymbol || "")
            .trim()
            .toUpperCase();
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
                cache: "no-store",
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const json = await res.json();
              if (!json.ok) throw new Error(json.error || "candles_failed");
              const candles = Array.isArray(json.candles) ? json.candles : [];
              // Store in cache
              candleCacheRef.current[cacheKey] = { data: candles, ts: Date.now() };
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

        // Fetch model signals (ticker + sector + market level)
        useEffect(() => {
          const sym = String(tickerSymbol || "").trim().toUpperCase();
          if (!sym) { setModelSignal(null); return; }
          let cancelled = false;
          (async () => {
            try {
              const res = await fetch(`${API_BASE}/timed/model/signals`, { cache: "no-store" });
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
                patternMatch: src?.pattern_match || null,
              });
            } catch { /* model signals are a boost, not a gate */ }
          })();
          return () => { cancelled = true; };
        }, [tickerSymbol, latestTicker]);

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
              qs.set("limit", "500");
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
              const res = await fetch(
                `${API_BASE}/timed/trail/performance?ticker=${encodeURIComponent(sym)}`,
                { cache: "no-store" },
              );
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

        // ── Unified direction — single source of truth for the entire Right Rail ──
        // Priority: 1) trade.direction  2) ticker.position_direction  3) HTF state  4) state fallback
        const resolvedDir = (() => {
          // 1. Explicit trade direction (most authoritative)
          const tradeDirStr = String(trade?.direction || "").toUpperCase();
          const tradeStatus = String(trade?.status || "").toUpperCase();
          const tradeIsOpen = trade && (
            tradeStatus === "OPEN" || tradeStatus === "TP_HIT_TRIM" ||
            (!(trade?.exit_ts ?? trade?.exitTs) && tradeStatus !== "WIN" && tradeStatus !== "LOSS")
          );
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
          { k: "5", label: "5m" },
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
              className="bg-[#0b0e11] border border-white/[0.04] rounded-xl w-full h-full flex flex-col shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Scrollable Content Area */}
              <div className="flex-1 overflow-y-auto">
                <div className="sticky top-0 z-30 bg-[#0b0e11] border-b border-white/[0.04] px-5 py-3">
                  {/* ── Row 1: Ticker + Direction (left) | Close/Share (right) ── */}
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <h3 className="text-xl font-bold leading-none">{tickerSymbol}</h3>
                      {(() => {
                        const d = resolvedDir;
                        return (
                          <span className={`inline-flex items-center justify-center px-1.5 py-px rounded text-[9px] font-black tracking-wide ${d === "LONG" ? "bg-cyan-500/80 text-white ring-1 ring-cyan-300/60" : d === "SHORT" ? "bg-rose-600/80 text-white ring-1 ring-rose-400/60" : "bg-white/[0.04] text-[#6b7280]"}`}>
                            {d || "—"}
                          </span>
                        );
                      })()}
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0 ml-2">
                      <button
                        onClick={() => {
                          try {
                            const sym = String(ticker?.ticker || "").toUpperCase();
                            const url = `${window.location.origin}${window.location.pathname}#ticker=${encodeURIComponent(sym)}`;
                            if (navigator.share) {
                              navigator.share({ title: `${sym} — Timed Trading`, url }).catch(() => {
                                navigator.clipboard.writeText(url);
                              });
                            } else {
                              navigator.clipboard.writeText(url).then(() => {
                                const btn = document.getElementById("share-toast-btn");
                                if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = ""; }, 1500); }
                              });
                            }
                          } catch {}
                        }}
                        id="share-toast-btn"
                        className="text-[#6b7280] hover:text-teal-300 transition-colors p-1.5 rounded hover:bg-white/[0.04]"
                        title="Share this ticker"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                      </button>
                      <button
                        onClick={onClose}
                        className="text-[#6b7280] hover:text-white transition-colors text-lg leading-none w-7 h-7 flex items-center justify-center rounded hover:bg-white/[0.04]"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* ── Row 2: Price + Daily Change + EXT (admin only) ── */}
                  {document.body.dataset.userRole === "admin" && (() => {
                    const src = priceSrc;
                    const price = Number(src?._live_price || src?.price || src?.close || 0);
                    if (!price) return null;
                    const priceAge = src._price_updated_at ? (Date.now() - src._price_updated_at) / 60000 : Infinity;
                    const scoreAge = src.data_source_ts ? (Date.now() - src.data_source_ts) / 60000 : Infinity;
                    const freshestAge = Math.min(priceAge, scoreAge);
                    const freshnessColor = freshestAge <= 2 ? "bg-green-400" : freshestAge <= 10 ? "bg-amber-400" : "bg-red-400";
                    const { dayChg, dayPct } = getDailyChange(src) || {};
                    const chgVal = Number(dayChg || dayPct || 0);
                    const chgColor = chgVal >= 0
                      ? (Math.abs(dayPct || 0) >= 3 ? "#4ade80" : "#00e676")
                      : (Math.abs(dayPct || 0) >= 3 ? "#fb7185" : "#f87171");
                    const chgSign = chgVal >= 0 ? "+" : "";
                    const _rrMktOpen = typeof isNyRegularMarketOpen === "function" ? isNyRegularMarketOpen() : false;
                    const ahPct = _rrMktOpen ? null : Number(src?._ah_change_pct);
                    const hasAH = Number.isFinite(ahPct) && ahPct !== 0;
                    return (
                      <div className="flex items-end justify-between mt-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-white font-bold text-lg tabular-nums leading-tight" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}>
                            ${price.toFixed(2)}
                          </span>
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${freshnessColor}`} title={`Updated ${Math.round(freshestAge)}m ago`} />
                        </div>
                        <div className="flex flex-col items-end">
                          {Number.isFinite(dayPct) && (
                            <span className="text-[11px] font-bold tabular-nums leading-tight" style={{ color: chgColor, textShadow: "0 1px 4px rgba(0,0,0,0.7)" }}>
                              {chgSign}{dayPct.toFixed(2)}%
                              {Number.isFinite(dayChg) ? ` (${chgSign}$${Math.abs(dayChg).toFixed(2)})` : ""}
                            </span>
                          )}
                          {hasAH && (
                            <span className={`text-[10px] font-medium tabular-nums leading-tight mt-0.5 ${ahPct >= 0 ? "text-[#00e676]" : "text-rose-400"}`}>
                              <span className="text-[9px] text-gray-400 mr-0.5">EXT</span>
                              {ahPct >= 0 ? "+" : ""}{ahPct.toFixed(2)}%
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* ── Row 3: Entry stats (if open position) ── */}
                  {(() => {
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
                    const entryPct = Number.isFinite(entryPctRaw) ? entryPctRaw
                      : (entryPx > 0 && price > 0 ? (dir === "SHORT" ? ((entryPx - price) / entryPx) * 100 : ((price - entryPx) / entryPx) * 100) : null);
                    if (!Number.isFinite(entryPx) && !Number.isFinite(entryPct)) return null;
                    return (
                      <div className="text-[11px] mt-1 text-cyan-300/90">
                        {Number.isFinite(entryPx) ? `Entry $${Number(entryPx).toFixed(2)}` : "Entry —"}
                        {Number.isFinite(entryPct) ? ` • Since entry ${entryPct >= 0 ? "+" : ""}${entryPct.toFixed(2)}%` : ""}
                      </div>
                    );
                  })()}

                  {/* ── Row 3: Groups + Stage/Ingest ── */}
                  <div className="mt-2 flex items-center gap-3 flex-wrap text-[10px]">
                    {/* Groups */}
                    {(() => {
                      try {
                        const gs = groupsForTicker(ticker.ticker);
                        if (!Array.isArray(gs) || gs.length === 0) return null;
                        const ordered = Array.isArray(GROUP_ORDER)
                          ? [...gs].sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b))
                          : gs;
                        const seen = new Set();
                        return ordered.map((g) => {
                          const label = GROUP_LABELS[g] || g;
                          if (seen.has(label)) return null;
                          seen.add(label);
                          return (
                            <span key={`group-${g}`} className="px-1.5 py-0.5 rounded border bg-white/[0.02] border-white/[0.06] text-[#f0f2f5]">
                              {label}
                            </span>
                          );
                        }).filter(Boolean);
                      } catch { return null; }
                    })()}

                    {/* Ingest age pill — prefer latestTicker (freshness-merged by price feed) */}
                    {(() => {
                      const ingestTime = latestTicker?.ingest_ts || latestTicker?.ingest_time || ticker.ingest_ts || ticker.ingest_time || ticker.ts;
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
                        return <span className={`px-1.5 py-0.5 rounded border font-semibold ${cls}`} title={`Last ingest: ${tv.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}`}>{txt}</span>;
                      } catch { return null; }
                    })()}

                    {/* Stage pill */}
                    {(() => {
                      const useEffectiveStage = effectiveStage != null && String(effectiveStage).trim() !== "";
                      const kanbanStageRaw = useEffectiveStage ? String(effectiveStage).trim() : String(ticker?.kanban_stage || "").trim();
                      const kanbanStage = kanbanStageRaw.toUpperCase();
                      if (!kanbanStage) return null;
                      const kanbanPill = kanbanStage === "EXIT" ? "bg-red-500/15 text-red-300 border-red-500/40"
                        : kanbanStage === "TRIM" ? "bg-yellow-500/15 text-yellow-300 border-yellow-500/40"
                        : kanbanStage === "DEFEND" ? "bg-orange-500/15 text-orange-300 border-orange-500/40"
                        : kanbanStage === "HOLD" ? "bg-blue-500/15 text-blue-300 border-blue-500/40"
                        : kanbanStage === "ENTER_NOW" ? "bg-green-500/15 text-green-300 border-green-500/40"
                        : "bg-white/5 text-[#6b7280] border-white/10";
                      const stageLabel = {
                        "WATCH": "Watch", "SETUP_WATCH": "Setup Watch", "SETUP": "Setup",
                        "FLIP_WATCH": "Flip Watch", "JUST_FLIPPED": "Just Flipped",
                        "ENTER": "Enter", "ENTER_NOW": "Enter Now",
                        "JUST_ENTERED": "Just Entered", "HOLD": "Hold",
                        "DEFEND": "Defend", "TRIM": "Trim", "EXIT": "Exit",
                      }[kanbanStage] || kanbanStage;
                      return <span className={`px-1.5 py-0.5 rounded border font-semibold ${kanbanPill}`}>{stageLabel}</span>;
                    })()}

                    {/* Move status pill (if not suppressed) */}
                    {(() => {
                      const ms = ticker?.move_status && typeof ticker.move_status === "object" ? ticker.move_status : null;
                      const rawStatus = (ms && ms.status) ? String(ms.status).trim() : "";
                      const hasOpenInLedger = Array.isArray(ledgerTrades) && ledgerTrades.some(
                        (t) => String(t?.ticker || "").toUpperCase() === tickerSymbol && t.status !== "WIN" && t.status !== "LOSS"
                      );
                      let status = rawStatus ? String(rawStatus).toUpperCase() : "";
                      if ((status === "NONE" || status === "") && hasOpenInLedger) status = "ACTIVE";
                      const discoveryStages = new Set(["watch", "setup_watch", "setup", "flip_watch", "enter", "enter_now", "just_flipped", ""]);
                      const rawStage = effectiveStage ? String(effectiveStage).trim().toLowerCase() : String(ticker?.kanban_stage || "").trim().toLowerCase();
                      const suppressMove = status === "ACTIVE" && discoveryStages.has(rawStage);
                      if (!status || suppressMove) return null;
                      const pill = status === "INVALIDATED" ? "bg-red-500/15 text-red-300 border-red-500/40" : status === "COMPLETED" ? "bg-purple-500/15 text-purple-300 border-purple-500/40" : "bg-green-500/10 text-green-300 border-green-500/30";
                      const icon = status === "INVALIDATED" ? "⛔" : status === "COMPLETED" ? "✅" : "🟢";
                      return <span className={`px-1.5 py-0.5 rounded border font-semibold ${pill}`}>{icon} {status}</span>;
                    })()}

                    {/* Badges inline with stage/groups row */}
                    {(() => {
                      const flags = ticker?.flags || {};
                      const badges = [];
                      if (isPrimeBubble(ticker)) badges.push({ icon: "💎", label: "Prime", tip: "Prime: Top-ranked setup with high conviction" });
                      if (flags.flip_watch) badges.push({ icon: "🎯", label: "Entry Zone", tip: "Entry Zone: Price is near optimal entry level" });
                      if (flags.momentum_elite) badges.push({ icon: "🔥", label: "MoElite", tip: "MoElite: Elite momentum alignment across timeframes" });
                      if (flags.sq30_on && !flags.sq30_release) badges.push({ icon: "🧨", label: "Squeeze", tip: "Squeeze: Bollinger Band squeeze detected — volatility expansion expected" });
                      if (flags.sq30_release) badges.push({ icon: "⚡", label: "Release", tip: "Release: Squeeze has fired — momentum breakout in progress" });
                      if (badges.length === 0) return null;
                      return badges.map((b, i) => (
                        <span key={`ib-${i}`} className="px-1.5 py-0.5 rounded border bg-white/5 border-white/10 text-[#d1d5db] font-semibold cursor-default" title={b.tip}>{b.icon} {b.label}</span>
                      ));
                    })()}
                  </div>

                  {/* ── Indicator Pills — with inline descriptions ── */}
                  {(() => {
                    const flags = ticker?.flags || {};
                    const pills = [];

                    // ── Indicator Pills ──

                    // Entry Quality score
                    const eqScore = Number(ticker?.entry_quality?.score) || 0;
                    if (eqScore > 0) {
                      const eqColor = eqScore >= 70 ? "bg-[#00c853]/20 text-[#69f0ae] border-[#00e676]/40" : eqScore >= 50 ? "bg-amber-500/20 text-amber-300 border-amber-400/40" : "bg-rose-500/20 text-rose-300 border-rose-400/40";
                      pills.push({ label: `Q:${eqScore}`, cls: eqColor, desc: "Entry Quality", tip: `Entry Quality: Structure=${ticker?.entry_quality?.structure || 0} Momentum=${ticker?.entry_quality?.momentum || 0} Confirm=${ticker?.entry_quality?.confirmation || 0}` });
                    }

                    // Swing Consensus (multi-timeframe alignment)
                    const swingBullCt = Number(ticker?.swing_consensus?.bullish_count) || 0;
                    const swingBearCt = Number(ticker?.swing_consensus?.bearish_count) || 0;
                    const swingDir = ticker?.swing_consensus?.direction || null;
                    const freshCrossTf = ticker?.swing_consensus?.freshest_cross_tf || null;
                    if (swingBullCt > 0 || swingBearCt > 0) {
                      const tfColor = swingDir === "LONG" ? "bg-cyan-500/20 text-cyan-300 border-cyan-400/40" : swingDir === "SHORT" ? "bg-rose-500/20 text-rose-300 border-rose-400/40" : "bg-slate-500/20 text-slate-300 border-slate-400/40";
                      pills.push({ label: `${swingBullCt}/5 TF`, cls: tfColor, desc: "Bullish Timeframes", tip: `Swing Consensus: ${swingBullCt}/5 bullish, ${swingBearCt}/5 bearish${freshCrossTf ? `, fresh ${freshCrossTf} cross` : ""}` });
                    }

                    // Volatility Tier
                    const volTier = String(ticker?.volatility_tier || "");
                    if (volTier) {
                      const vColor = volTier === "LOW" ? "bg-blue-500/15 text-blue-300 border-blue-400/30" : volTier === "MEDIUM" ? "bg-slate-500/15 text-slate-300 border-slate-400/30" : volTier === "HIGH" ? "bg-orange-500/15 text-orange-300 border-orange-400/30" : "bg-red-500/15 text-red-300 border-red-400/30";
                      pills.push({ label: volTier, cls: vColor, desc: "Volatility", tip: `Volatility: ${ticker?.volatility_atr_pct || "?"}% daily ATR` });
                    }

                    // Regime
                    const regimeCombined = ticker?.regime?.combined || null;
                    const regimeLabel = {
                      STRONG_BULL: "Strong Bull", EARLY_BULL: "Early Bull", LATE_BULL: "Late Bull",
                      COUNTER_TREND_BULL: "CT Bull", NEUTRAL: "Neutral", COUNTER_TREND_BEAR: "CT Bear",
                      EARLY_BEAR: "Early Bear", LATE_BEAR: "Late Bear", STRONG_BEAR: "Strong Bear",
                    }[regimeCombined] || null;
                    if (regimeLabel) {
                      const rColor = regimeCombined?.includes("BULL") ? "bg-[#00c853]/15 text-[#69f0ae] border-[#00e676]/30" : regimeCombined?.includes("BEAR") ? "bg-rose-500/15 text-rose-300 border-rose-400/30" : "bg-slate-500/15 text-slate-300 border-slate-400/30";
                      pills.push({ label: regimeLabel, cls: rColor, desc: "Regime", tip: `Regime: Daily=${ticker?.regime?.daily || "?"}, Weekly=${ticker?.regime?.weekly || "?"}` });
                    }

                    // Fresh EMA Cross
                    if (freshCrossTf) {
                      pills.push({ label: `${freshCrossTf}x`, cls: "bg-purple-500/15 text-purple-300 border-purple-400/30", desc: "Fresh Cross", tip: `Fresh EMA cross on ${freshCrossTf}` });
                    }

                    // Strength / exhaustion
                    const strength = String(ticker?.strength || ticker?.move_strength || "").toUpperCase();
                    if (strength) {
                      const sColor = strength === "EXTREME" ? "bg-purple-500/15 text-purple-300 border-purple-500/40" : strength === "STRONG" ? "bg-blue-500/15 text-blue-300 border-blue-500/30" : "bg-white/5 text-[#6b7280] border-white/10";
                      pills.push({ label: strength, cls: sColor, desc: "Strength", tip: `Move Strength: ${strength} — intensity of the current move` });
                    }

                    // Trend
                    const trend = String(ticker?.trend || ticker?.weekly_trend || "").replace(/_/g, " ");
                    if (trend) {
                      const tU = trend.toUpperCase();
                      const tColor = tU.includes("BULL") ? "bg-green-500/15 text-green-300 border-green-500/30" : tU.includes("BEAR") ? "bg-red-500/15 text-red-300 border-red-500/30" : "bg-white/5 text-[#6b7280] border-white/10";
                      const tLabel = trend.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
                      pills.push({ label: tLabel, cls: tColor, desc: "Trend", tip: `Weekly Trend: ${tLabel}` });
                    }

                    if (pills.length === 0) return null;
                    return (
                      <div className="mt-1.5 flex gap-3 flex-wrap text-[10px]">
                        {pills.map((p, i) => (
                          <div key={`ip-${i}`} className="flex flex-col items-center gap-0.5 cursor-default" title={p.tip}>
                            <span className={`px-1.5 py-0.5 rounded border font-semibold ${p.cls}`}>{p.label}</span>
                            <span className="text-[#6b7280] text-[8px] leading-none">{p.desc}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* Right Rail Tabs — single row, no wrapping */}
                  <div className="mt-3 flex items-center gap-1.5 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
                    {[
                      { k: "ANALYSIS", label: "Analysis", proOnly: false },
                      { k: "TECHNICALS", label: "Technicals", proOnly: true },
                      { k: "MODEL", label: "Model", proOnly: true },
                      { k: "JOURNEY", label: "Journey", proOnly: true },
                      {
                        k: "TRADE_HISTORY",
                        label: `Trades (${Array.isArray(ledgerTrades) ? ledgerTrades.length : 0})`,
                        proOnly: true,
                      },
                      { k: "INVESTOR", label: "Investor", proOnly: false },
                    ].map((t) => {
                      const active = railTab === t.k;
                      const locked = t.proOnly && !window._ttIsPro;
                      return (
                        <button
                          key={`rail-tab-${t.k}`}
                          onClick={() => setRailTab(t.k)}
                          className={`px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-all whitespace-nowrap flex-shrink-0 flex items-center gap-1 ${
                            active
                              ? "border-blue-400 bg-blue-500/20 text-blue-200"
                              : locked
                                ? "border-amber-500/20 bg-amber-500/5 text-amber-400/60 hover:text-amber-300"
                                : "border-white/[0.06] bg-white/[0.03] text-[#6b7280] hover:text-white"
                          }`}
                        >
                          {t.label}
                          {locked && <svg className="w-3 h-3 text-amber-400/60" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd"/></svg>}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Padded body content (keeps header top-aligned) */}
                <div className="p-6 pt-4">
                  {!window._ttIsPro && railTab !== "ANALYSIS" && railTab !== "INVESTOR" ? (
                    <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
                      <div className="w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
                        <svg className="w-8 h-8 text-amber-400" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd"/></svg>
                      </div>
                      <div>
                        <h3 className="text-[14px] font-bold text-white mb-1">Pro Feature</h3>
                        <p className="text-[11px] text-gray-400 max-w-[240px]">
                          {railTab === "TECHNICALS" && "Deep multi-timeframe technical analysis with scoring breakdowns across all indicators."}
                          {railTab === "MODEL" && "AI model confidence, signal strength, and entry/exit decision rationale."}
                          {railTab === "JOURNEY" && "Full ticker journey tracking with historical stage transitions and time-in-stage analytics."}
                          {railTab === "TRADE_HISTORY" && "Complete trade ledger with P&L, win rate, and performance analytics."}
                        </p>
                      </div>
                      <button className="px-5 py-2 rounded-full bg-gradient-to-r from-amber-500 to-amber-600 text-white text-[12px] font-bold hover:from-amber-400 hover:to-amber-500 transition-all shadow-lg shadow-amber-500/20"
                        onClick={() => window.dispatchEvent(new CustomEvent("tt-go-pro"))}>
                        Upgrade to Pro
                      </button>
                    </div>
                  ) : railTab === "INVESTOR" ? (
                    /* ═══════════════════════════════════════════════════════════ */
                    /* INVESTOR TAB — Long-term portfolio view (score, stage, Buy Zone, etc.) */
                    /* ═══════════════════════════════════════════════════════════ */
                    (() => {
                      const COMPONENT_LABELS = {
                        weeklyTrend: { label: "Weekly Trend", tip: "Is the stock trending up or down on a weekly basis?", max: 25 },
                        monthlyTrend: { label: "Monthly Trend", tip: "The bigger-picture direction over months", max: 20 },
                        relativeStrength: { label: "Strength vs Market", tip: "How this stock performs compared to the S&P 500", max: 20 },
                        accumulationSignal: { label: "Buy Zone Signal", tip: "Has the stock pulled back to a favorable entry price?", max: 15 },
                        marketHealth: { label: "Market Conditions", tip: "Is the overall market environment supportive?", max: 10 },
                        trendDurability: { label: "Trend Durability", tip: "How long and consistently the trend has held", max: 10 },
                        sectorContext: { label: "Sector Context", tip: "Is this stock's sector in favor right now?", max: 10 },
                      };
                      const getScoreLabel = (s) => s >= 70 ? "Strong" : s >= 50 ? "Mixed" : "Weak";
                      const getTickerSummary = (score, stage) => {
                        if (score >= 70 && stage === "accumulate") return "Strong setup. The system sees a buying opportunity.";
                        if (score >= 70 && stage === "core_hold") return "Strong and steady. The system recommends holding.";
                        if (score >= 70) return "Strong signals across the board.";
                        if (score >= 50 && stage === "accumulate") return "Moderate setup with a buying opportunity. The system suggests smaller sizing.";
                        if (score >= 50 && stage === "watch") return "Mixed signals. The system recommends watching for now.";
                        if (score >= 50 && stage === "core_hold") return "Decent health but not firing on all cylinders. Hold and monitor.";
                        if (score >= 50) return "Mixed signals — some positives, some caution flags.";
                        if (score < 50 && stage === "reduce") return "Weak setup. The system recommends reducing or exiting.";
                        if (score < 50 && stage === "watch") return "Weak signals. The system recommends caution.";
                        if (score < 50) return "Unfavorable conditions. The system advises caution.";
                        return "The system is evaluating this stock.";
                      };
                      const getRsSummary = (rs) => {
                        if (!rs) return null;
                        const pos = [rs.rs1m, rs.rs3m, rs.rs6m].filter(v => Number.isFinite(v) && v > 0).length;
                        const neg = [rs.rs1m, rs.rs3m, rs.rs6m].filter(v => Number.isFinite(v) && v < 0).length;
                        if (pos === 3) return "Outperforming the market across all timeframes.";
                        if (pos >= 2) return "Generally outperforming, with some recent softness.";
                        if (neg === 3) return "Underperforming the market. Relative weakness across the board.";
                        if (neg >= 2) return "Mostly underperforming. The market is doing better.";
                        return "Mixed performance relative to the market.";
                      };
                      const fmtPct = (n) => Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(1)}%` : "—";
                      const SIGNAL_LABELS = { rsi_oversold: "RSI is low (oversold)", above_monthly_ema: "Price above monthly trend line", monthly_trend_intact: "Monthly trend still healthy", weekly_trend_intact: "Weekly trend still healthy", above_weekly_ema: "Price above weekly trend line", rsi_divergence: "Momentum divergence detected", volume_climax: "Unusual selling volume (capitulation)", near_support: "Price near a support level" };

                      if (investorLoading) return <div className="flex items-center justify-center py-12"><div className="loading-spinner" /><span className="ml-2 text-[#6b7280] text-sm">Loading investor data…</span></div>;
                      if (investorError) return <div className="py-8 text-center"><p className="text-red-400 text-sm mb-2">{investorError}</p><p className="text-[#6b7280] text-xs">Investor scores are computed hourly. Try again later.</p></div>;
                      const d = investorData;
                      if (!d) return <div className="py-8 text-center text-[#6b7280] text-sm">No investor data for this ticker yet.</div>;

                      const merged = { ...ticker, ...d };
                      const price = merged.price ?? ticker?.price ?? d?.price;
                      const dc = getDailyChange(merged);
                      const chgPct = dc?.dayPct ?? null;
                      const chgVal = dc?.dayChg ?? null;
                      const score = Number(d.score) || 0;
                      const scoreCls = score >= 70 ? "text-[#00e676]" : score >= 50 ? "text-amber-400" : "text-red-400";
                      const summary = getTickerSummary(score, d.stage);
                      const stageCls = { accumulate: "bg-[#00c853]/15 text-[#34d399] border-[#00c853]/30", core_hold: "bg-blue-500/15 text-[#60a5fa] border-blue-500/30", watch: "bg-amber-500/15 text-[#fbbf24] border-amber-500/30", reduce: "bg-red-500/15 text-[#f87171] border-red-500/30", research: "bg-purple-500/15 text-[#a78bfa] border-purple-500/30", exited: "bg-gray-500/15 text-[#9ca3af] border-gray-500/30" }[d.stage] || "bg-gray-500/15 text-[#9ca3af] border-gray-500/30";

                      return (
                        <div className="space-y-5">
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <div>
                                <div className="text-lg font-bold text-white">{d.ticker}</div>
                                {d.companyName && <div className="text-xs text-[#9ca3af]">{d.companyName}</div>}
                                <div className="text-[10px] text-[#6b7280]">{d.sector || "Unknown"}</div>
                              </div>
                              <div className="text-right">
                                <div className={`flex items-baseline gap-1.5 justify-end text-2xl font-bold ${scoreCls}`}>{score} <span className="text-xs font-semibold">{getScoreLabel(score)}</span></div>
                                <div className="text-[10px] text-[#6b7280]">Investor Score</div>
                              </div>
                            </div>
                            <div className="text-[11px] text-[#9ca3af] mt-2 italic leading-relaxed">{summary}</div>
                          </div>

                          {price != null && Number.isFinite(price) && (
                            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 flex items-center justify-between">
                              <div><div className="text-[10px] text-[#6b7280] uppercase">Price</div><div className="text-lg font-bold text-white tabular-nums">${Number(price).toFixed(2)}</div></div>
                              {(chgPct != null && Number.isFinite(chgPct)) && <div className="text-right"><div className="text-[10px] text-[#6b7280] uppercase">Today</div><div className={`text-lg font-bold tabular-nums ${chgPct >= 0 ? "text-[#00e676]" : "text-red-400"}`}>{chgPct >= 0 ? "+" : ""}{chgPct.toFixed(2)}%</div>{Number.isFinite(chgVal) && <div className={`text-[11px] ${chgVal >= 0 ? "text-[#00e676]/70" : "text-red-400/70"}`}>{chgVal >= 0 ? "+" : "-"}${Math.abs(chgVal).toFixed(2)}</div>}</div>}
                              {d.prevClose != null && Number.isFinite(d.prevClose) && <div className="text-right"><div className="text-[10px] text-[#6b7280] uppercase">Prev Close</div><div className="text-sm font-semibold text-[#9ca3af] tabular-nums">${d.prevClose.toFixed(2)}</div></div>}
                            </div>
                          )}

                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${stageCls}`}>{(d.stage || "research").replace("_", " ")}</span>
                              {d.stage === "accumulate" && <span className="text-[10px] text-[#00e676]/80 bg-[#00c853]/10 px-2 py-0.5 rounded border border-[#00c853]/20">Buy signal — add in small portions</span>}
                              {d.stage === "watch" && <span className="text-[10px] text-amber-400/80 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">The system suggests a small starter position</span>}
                              {d.stage === "reduce" && <span className="text-[10px] text-red-400/80 bg-red-500/10 px-2 py-0.5 rounded border border-red-500/20">Reduce signal — the system recommends trimming</span>}
                            </div>
                            {d.stageReason && <div className="text-[10px] text-[#6b7280]">{d.stageReason}</div>}
                          </div>

                          {d.components && Object.keys(d.components).length > 0 && (
                            <div>
                              <h3 className="text-xs font-semibold text-[#9ca3af] mb-1 uppercase">Score Breakdown</h3>
                              <div className="text-[10px] text-[#4b5563] mb-2.5">How the system arrived at this stock's overall score.</div>
                              <div className="space-y-2">
                                {Object.entries(d.components).map(([k, v]) => {
                                  const meta = COMPONENT_LABELS[k] || { label: k.replace(/([A-Z])/g, " $1").trim(), tip: "", max: 10 };
                                  const maxVal = meta.max || 10;
                                  const pct = v / maxVal;
                                  const dotColor = pct >= 0.6 ? "bg-[#00e676]" : pct >= 0.3 ? "bg-amber-400" : "bg-red-400";
                                  return (
                                    <div key={k} className="flex items-center gap-2" title={meta.tip}>
                                      <span className={`w-1.5 h-1.5 rounded-full ${dotColor} shrink-0`} />
                                      <span className="text-[11px] text-[#9ca3af] w-28 shrink-0">{meta.label}</span>
                                      <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden"><div className="h-full rounded-full bg-[#3b82f6]" style={{ width: `${Math.min(100, (v / maxVal) * 100)}%` }} /></div>
                                      <span className="text-xs text-white w-6 text-right tabular-nums shrink-0">{v}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {d.rs && (
                            <div>
                              <h3 className="text-xs font-semibold text-[#9ca3af] mb-1 uppercase">Performance vs Market</h3>
                              <div className="text-[10px] text-[#4b5563] mb-2.5">{getRsSummary(d.rs)}</div>
                              <div className="grid grid-cols-3 gap-2">
                                <div className="rounded-lg border border-white/[0.06] p-2.5 text-center"><div className="text-[10px] text-[#6b7280]">1 Month</div><div className={`text-sm font-semibold ${d.rs.rs1m >= 0 ? "text-[#00e676]" : "text-red-400"}`}>{fmtPct(d.rs.rs1m)}</div></div>
                                <div className="rounded-lg border border-white/[0.06] p-2.5 text-center"><div className="text-[10px] text-[#6b7280]">3 Months</div><div className={`text-sm font-semibold ${d.rs.rs3m >= 0 ? "text-[#00e676]" : "text-red-400"}`}>{fmtPct(d.rs.rs3m)}</div></div>
                                <div className="rounded-lg border border-white/[0.06] p-2.5 text-center"><div className="text-[10px] text-[#6b7280]">6 Months</div><div className={`text-sm font-semibold ${d.rs.rs6m >= 0 ? "text-[#00e676]" : "text-red-400"}`}>{fmtPct(d.rs.rs6m)}</div></div>
                              </div>
                              {d.rsRank != null && <div className="mt-2.5"><div className="flex items-center justify-between mb-1 text-[11px] text-[#9ca3af]">Outperforms {d.rsRank}% of all tracked stocks</div><div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden"><div className="h-full rounded-full bg-[#3b82f6]" style={{ width: `${Math.min(100, d.rsRank)}%` }} /></div></div>}
                            </div>
                          )}

                          {d.accumZone && (
                            <div>
                              <h3 className="text-xs font-semibold text-[#9ca3af] mb-1 uppercase" title="Has the stock pulled back to an attractive price?">Buy Zone</h3>
                              {d.accumZone.inZone ? (
                                <div className="rounded-lg border border-[#00c853]/30 p-3">
                                  <div className="flex items-center gap-2 mb-1.5"><span className="w-2 h-2 rounded-full bg-[#00e676] animate-pulse" /><span className="text-xs text-[#00e676] font-semibold">In Buy Zone</span><span className="text-[10px] text-[#9ca3af]">{d.accumZone.confidence}% confidence</span></div>
                                  <div className="text-[11px] text-[#9ca3af] leading-relaxed mb-2">The stock dipped to a favorable price without breaking its uptrend.</div>
                                  {d.accumZone.signals?.length > 0 && <div className="flex flex-wrap gap-1">{d.accumZone.signals.map((s, i) => <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-white/[0.04] text-[#9ca3af]">{SIGNAL_LABELS[s] || s.replace(/_/g, " ")}</span>)}</div>}
                                </div>
                              ) : <div className="text-[11px] text-[#6b7280]">Not in a buy zone right now.</div>}
                            </div>
                          )}

                          {d.thesis && (
                            <div>
                              <h3 className="text-xs font-semibold text-[#9ca3af] mb-1 uppercase">Investment Thesis</h3>
                              <div className="text-[10px] text-[#4b5563] mb-2">Why the system is tracking this stock.</div>
                              <div className="text-xs text-[#d1d5db] leading-relaxed mb-2">{d.thesis}</div>
                              {d.thesisInvalidation?.length > 0 && <div><div className="text-[10px] text-[#6b7280] mb-1">What would change this view:</div>{d.thesisInvalidation.map((inv, i) => <div key={i} className="text-[11px] text-red-400/80 pl-2">• {inv}</div>)}</div>}
                            </div>
                          )}
                        </div>
                      );
                    })()
                  ) : railTab === "ANALYSIS" ? (
                    <>
                      {/* ═══════════════════════════════════════════════════════════ */}
                      {/* 1. CONTEXT                                                  */}
                      {/* ═══════════════════════════════════════════════════════════ */}
                      {(() => {
                        const baseCtx =
                          ticker?.context && typeof ticker.context === "object"
                            ? ticker.context
                            : null;
                        const mergedCtx =
                          latestTicker?.context &&
                          typeof latestTicker.context === "object"
                            ? latestTicker.context
                            : null;
                        const ctx = mergedCtx || baseCtx;
                        if (!ctx) return null;
                        const name = ctx.name || ctx.companyName || ctx.company_name;
                        const description =
                          ctx.description ||
                          ctx.businessSummary ||
                          ctx.business_summary;
                        const sector = ctx.sector;
                        const industry = ctx.industry;
                        const country = ctx.country;
                        const marketCap =
                          Number(ctx.market_cap || ctx.marketCap || 0) || 0;
                        const lastEarnTs = Number(ctx.last_earnings_ts || ctx.lastEarningsTs || 0) || 0;
                        const events = ctx.events && typeof ctx.events === "object" ? ctx.events : null;

                        // Merge model signal-level sector info
                        const msSectorData = modelSignal?.sector;
                        const enrichedSector = sector || msSectorData?.sector || null;
                        const enrichedIndustry = industry || null;

                        const fmtDate = (ts) => {
                          if (!ts) return "—";
                          const d = typeof ts === "number" && ts > 1e12
                            ? new Date(ts) : typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
                          if (isNaN(d)) return "—";
                          return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                        };
                        const fmtMCap = (val) => {
                          if (val >= 1e12) return `$${(val / 1e12).toFixed(2)}T`;
                          if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
                          if (val >= 1e6) return `$${(val / 1e6).toFixed(0)}M`;
                          return `$${val.toLocaleString()}`;
                        };
                        const nextEarnTs = Number(events?.next_earnings_ts || 0) || 0;
                        const lastEarnEvt = Number(events?.last_earnings_ts || 0) || lastEarnTs;
                        const showDesc = description && description !== name;

                        // Finnhub upcoming earnings (fresher than context.events)
                        const _rrEarnMap = earningsMap || window._ttEarningsMap;
                        const finnhubEarn = _rrEarnMap?.[String(tickerSymbol).toUpperCase()];
                        const finnhubEarnDate = finnhubEarn?.date;
                        const finnhubEarnHour = finnhubEarn?.hour;
                        const finnhubDaysAway = finnhubEarn?._daysAway;
                        const hasFinnhubEarn = !!finnhubEarn;
                        const isEarningsImminent = hasFinnhubEarn && finnhubDaysAway >= 0 && finnhubDaysAway <= 2;
                        const earnLabel = (() => {
                          if (!hasFinnhubEarn) return null;
                          const d = finnhubDaysAway;
                          if (d === 0) return "Today";
                          if (d === 1) return "Tomorrow";
                          if (d === -1) return "Yesterday";
                          if (d < 0) return `${Math.abs(d)} day${Math.abs(d) !== 1 ? "s" : ""} ago`;
                          return `in ${d} day${d !== 1 ? "s" : ""}`;
                        })();
                        const earnHourLabel = (() => {
                          if (!finnhubEarnHour) return "";
                          const h = String(finnhubEarnHour).toLowerCase();
                          if (h === "bmo" || h === "before market open") return "Before Open";
                          if (h === "amc" || h === "after market close") return "After Close";
                          if (h === "dmh" || h === "during market hours") return "During Hours";
                          return "";
                        })();

                        return (
                          <div className="mb-3 px-2.5 py-2 bg-white/[0.03] border border-white/[0.06] rounded-lg">
                            {name ? (
                              <div className="text-xs font-semibold text-white truncate">{name}</div>
                            ) : null}
                            <div className="text-[10px] text-[#6b7280] mt-0.5">
                              {[enrichedSector, enrichedIndustry, country]
                                .filter(Boolean)
                                .join(" • ") || "—"}
                            </div>
                            {showDesc ? (
                              <div className="mt-1 text-[10px] text-[#6b7280] leading-snug" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                                {description}
                              </div>
                            ) : null}

                            {/* Upcoming earnings callout — prominent when imminent */}
                            {hasFinnhubEarn && (
                              <div className={`mt-1.5 flex items-center gap-2 px-2.5 py-2 rounded-lg border ${isEarningsImminent ? "bg-amber-500/15 border-amber-500/40" : "bg-blue-500/10 border-blue-500/25"}`}>
                                <span className="text-base">📅</span>
                                <div className="min-w-0">
                                  <div className={`text-[11px] font-bold ${isEarningsImminent ? "text-amber-300" : "text-blue-300"}`}>
                                    Earnings {earnLabel}
                                  </div>
                                  <div className="text-[10px] text-[#9ca3af]">
                                    {new Date(finnhubEarnDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                                    {earnHourLabel ? ` · ${earnHourLabel}` : ""}
                                    {finnhubEarn.epsEstimate != null ? ` · Est. $${Number(finnhubEarn.epsEstimate).toFixed(2)}` : ""}
                                  </div>
                                  {finnhubEarn.epsActual != null && finnhubEarn.epsEstimate != null && (
                                    <div className={`text-[10px] font-semibold mt-0.5 ${finnhubEarn.epsActual >= finnhubEarn.epsEstimate ? "text-green-400" : "text-rose-400"}`}>
                                      Reported ${Number(finnhubEarn.epsActual).toFixed(2)} — {finnhubEarn.epsActual >= finnhubEarn.epsEstimate ? "Beat" : "Miss"} by ${Math.abs(finnhubEarn.epsActual - finnhubEarn.epsEstimate).toFixed(2)}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}

                            {(marketCap || (lastEarnEvt && !hasFinnhubEarn) || (nextEarnTs && !hasFinnhubEarn)) ? (
                              <div className={`mt-1.5 grid gap-1.5 text-[10px]`} style={{ gridTemplateColumns: `repeat(${[marketCap, lastEarnEvt && !hasFinnhubEarn, nextEarnTs && !hasFinnhubEarn].filter(Boolean).length}, 1fr)` }}>
                                {marketCap ? (
                                  <div className="p-1.5 bg-white/[0.02] border border-white/[0.06] rounded text-center">
                                    <div className="text-[9px] text-[#6b7280]">MCap</div>
                                    <div className="text-[11px] font-semibold text-white">{fmtMCap(marketCap)}</div>
                                  </div>
                                ) : null}
                                {lastEarnEvt && !hasFinnhubEarn ? (
                                  <div className="p-1.5 bg-white/[0.02] border border-white/[0.06] rounded text-center">
                                    <div className="text-[9px] text-[#6b7280]">Last Earnings</div>
                                    <div className="text-[11px] font-semibold text-white">{fmtDate(lastEarnEvt)}</div>
                                  </div>
                                ) : null}
                                {nextEarnTs && !hasFinnhubEarn ? (
                                  <div className="p-1.5 bg-blue-500/10 border border-blue-500/30 rounded text-center">
                                    <div className="text-[9px] text-blue-400">Next Earnings</div>
                                    <div className="text-[11px] font-semibold text-blue-300">{fmtDate(nextEarnTs)}</div>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })()}

                      {/* ═══════════════════════════════════════════════════════════ */}
                      {/* 1b. REGIME CONTEXT (v3)                                    */}
                      {/* ═══════════════════════════════════════════════════════════ */}
                      {(() => {
                        const rc = String(ticker?.regime_class || "");
                        if (!rc) return null;
                        const rs = Number(ticker?.regime_score) || 0;
                        const rf = ticker?.regime_factors || {};
                        const rp = ticker?.regime_params || {};
                        const rvolMap = ticker?.rvol_map || {};
                        const rv30 = Number(rvolMap?.["30"]?.vr) || 0;
                        const rv1h = Number(rvolMap?.["60"]?.vr) || 0;
                        const rvBest = Math.max(rv30, rv1h);
                        const regBg = rc === "TRENDING" ? "bg-emerald-500/10 border-emerald-500/30" : rc === "CHOPPY" ? "bg-rose-500/10 border-rose-500/30" : "bg-amber-500/10 border-amber-500/30";
                        const regTxt = rc === "TRENDING" ? "text-emerald-300" : rc === "CHOPPY" ? "text-rose-300" : "text-amber-300";
                        const factorKeys = Object.keys(rf);
                        return (
                          <div className={`mb-3 px-2.5 py-2 rounded-lg border ${regBg}`}>
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="flex items-center gap-1.5">
                                <span className={`text-[11px] font-bold ${regTxt}`}>{rc}</span>
                                <span className="text-[10px] text-slate-400">Regime</span>
                              </div>
                              <span className={`text-[11px] font-bold tabular-nums ${regTxt}`}>{rs >= 0 ? "+" : ""}{rs}</span>
                            </div>
                            <div className="grid grid-cols-3 gap-1.5 text-[9px] mb-1.5">
                              <div className="p-1 bg-white/[0.03] rounded text-center">
                                <div className="text-[8px] text-slate-500">RVOL</div>
                                <div className={`font-bold tabular-nums ${rvBest >= 1.5 ? "text-emerald-400" : rvBest >= 0.8 ? "text-white" : "text-rose-400"}`}>{rvBest.toFixed(2)}x</div>
                              </div>
                              <div className="p-1 bg-white/[0.03] rounded text-center">
                                <div className="text-[8px] text-slate-500">Min HTF</div>
                                <div className="font-bold text-white tabular-nums">{rp.minHTFScore ?? "—"}</div>
                              </div>
                              <div className="p-1 bg-white/[0.03] rounded text-center">
                                <div className="text-[8px] text-slate-500">Size</div>
                                <div className="font-bold text-white tabular-nums">{rp.positionSizeMultiplier != null ? `${rp.positionSizeMultiplier}x` : "—"}</div>
                              </div>
                            </div>
                            {factorKeys.length > 0 && (
                              <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[8px] text-slate-400">
                                {factorKeys.slice(0, 6).map(k => (
                                  <span key={k} title={rf[k]}>{k.replace(/_/g," ")}: <span className={`font-semibold ${String(rf[k]).startsWith("+") ? "text-emerald-400" : String(rf[k]).startsWith("-") ? "text-rose-400" : "text-white"}`}>{String(rf[k]).split(" ")[0]}</span></span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* ═══════════════════════════════════════════════════════════ */}
                      {/* 1c. TICKER PROFILE (Three-Tier Awareness)                  */}
                      {/* ═══════════════════════════════════════════════════════════ */}
                      {(() => {
                        const tp = ticker?._ticker_profile;
                        if (!tp || !tp.behavior_type) return null;
                        const bt = String(tp.behavior_type);
                        const btColor = bt === "MOMENTUM" ? "text-blue-300" : bt === "MEAN_REVERT" ? "text-purple-300" : "text-slate-300";
                        const btBg = bt === "MOMENTUM" ? "bg-blue-500/10 border-blue-500/30" : bt === "MEAN_REVERT" ? "bg-purple-500/10 border-purple-500/30" : "bg-slate-500/10 border-slate-500/30";
                        const slM = Number(tp.sl_mult) || 1;
                        const tpM = Number(tp.tp_mult) || 1;
                        const ethAdj = Number(tp.entry_threshold_adj) || 0;
                        const atrPct = Number(tp.atr_pct_p50) || 0;
                        const trendP = Number(tp.trend_persistence) || 0;
                        const ichResp = Number(tp.ichimoku_responsiveness) || 0;
                        return (
                          <div className={`mb-3 px-2.5 py-2 rounded-lg border ${btBg}`}>
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="flex items-center gap-1.5">
                                <span className={`text-[11px] font-bold ${btColor}`}>{bt.replace("_", " ")}</span>
                                <span className="text-[10px] text-slate-400">Profile</span>
                              </div>
                            </div>
                            <div className="grid grid-cols-3 gap-1.5 text-[9px] mb-1.5">
                              <div className="p-1 bg-white/[0.03] rounded text-center">
                                <div className="text-[8px] text-slate-500">ATR%</div>
                                <div className="font-bold text-white tabular-nums">{atrPct > 0 ? `${(atrPct * 100).toFixed(1)}%` : "—"}</div>
                              </div>
                              <div className="p-1 bg-white/[0.03] rounded text-center">
                                <div className="text-[8px] text-slate-500">SL Mult</div>
                                <div className={`font-bold tabular-nums ${slM > 1.05 ? "text-amber-300" : slM < 0.95 ? "text-emerald-300" : "text-white"}`}>{slM.toFixed(2)}x</div>
                              </div>
                              <div className="p-1 bg-white/[0.03] rounded text-center">
                                <div className="text-[8px] text-slate-500">TP Mult</div>
                                <div className={`font-bold tabular-nums ${tpM > 1.05 ? "text-emerald-300" : tpM < 0.95 ? "text-amber-300" : "text-white"}`}>{tpM.toFixed(2)}x</div>
                              </div>
                            </div>
                            <div className="grid grid-cols-3 gap-1.5 text-[9px]">
                              <div className="p-1 bg-white/[0.03] rounded text-center">
                                <div className="text-[8px] text-slate-500">Trend Persist</div>
                                <div className={`font-bold tabular-nums ${trendP >= 0.6 ? "text-emerald-400" : trendP <= 0.35 ? "text-rose-400" : "text-white"}`}>{(trendP * 100).toFixed(0)}%</div>
                              </div>
                              <div className="p-1 bg-white/[0.03] rounded text-center">
                                <div className="text-[8px] text-slate-500">Ichi Resp</div>
                                <div className={`font-bold tabular-nums ${ichResp >= 0.6 ? "text-emerald-400" : ichResp <= 0.35 ? "text-rose-400" : "text-white"}`}>{(ichResp * 100).toFixed(0)}%</div>
                              </div>
                              {ethAdj !== 0 && (
                                <div className="p-1 bg-white/[0.03] rounded text-center">
                                  <div className="text-[8px] text-slate-500">Entry Adj</div>
                                  <div className={`font-bold tabular-nums ${ethAdj > 0 ? "text-amber-300" : "text-emerald-300"}`}>{ethAdj > 0 ? "+" : ""}{ethAdj}</div>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}

                      {/* ═══════════════════════════════════════════════════════════ */}
                      {/* 2. PRIME SETUP BANNER                                      */}
                      {/* ═══════════════════════════════════════════════════════════ */}
                      {prime && (
                        <div className="mb-4 p-3 bg-green-500/20 border-2 border-green-500 rounded-lg text-center font-bold text-green-500 prime-glow">
                          💎 PRIME SETUP 💎
                        </div>
                      )}

                      {/* ═══════════════════════════════════════════════════════════ */}
                      {/* 3. SYSTEM GUIDANCE                                          */}
                      {/* ═══════════════════════════════════════════════════════════ */}
                      <div
                        className={`mb-4 p-4 rounded-lg border-2 ${actionInfo.bg} border-current/30`}
                      >
                        <div className="flex items-center justify-between mb-3">
                          <div className="text-sm text-[#6b7280] font-semibold">
                            System Guidance
                          </div>
                          {(() => {
                            const stage = String(ticker?.kanban_stage || "").toLowerCase();
                            const isEnterLane = stage === "enter_now" || stage === "enter";
                            const blockReason = ticker?.__execution_block_reason || ticker?.__entry_block_reason;
                            if (isEnterLane && blockReason) {
                              return (
                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-400">
                                  Blocked
                                </span>
                              );
                            }
                            if (isEnterLane) {
                              return (
                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-green-500/20 text-green-400">
                                  Enter
                                </span>
                              );
                            }
                            if (decisionSummary) {
                              return (
                                <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${decisionSummary.bg} ${decisionSummary.tone}`}>
                                  {decisionSummary.status}
                                </span>
                              );
                            }
                            return null;
                          })()}
                        </div>
                        <div
                          className={`text-lg font-bold mb-2 ${actionInfo.color}`}
                        >
                          {actionInfo.action}
                        </div>
                        <div className="text-sm text-[#cbd5ff] leading-relaxed">
                          {actionInfo.description}
                        </div>

                        {(() => {
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
                          return (
                            <div className="mt-3 px-3 py-2 rounded bg-amber-500/10 border border-amber-500/30">
                              <span className="text-[10px] text-amber-300/70 font-semibold">Blocked: </span>
                              <span className="text-xs text-amber-200 font-semibold">{formatted}</span>
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
                              <div className="text-xs text-[#6b7280] mb-2 font-semibold">
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

                      {/* ═══════════════════════════════════════════════════════════ */}
                      {/* 3b. SYSTEM ALIGNMENT (calibration-derived)                  */}
                      {/* ═══════════════════════════════════════════════════════════ */}
                      {(() => {
                        const al = (latestTicker || ticker)?._alignment;
                        if (!al || (al.path_win_rate == null && al.rank_bucket_wr == null)) return null;
                        const wr = al.path_win_rate != null ? Number(al.path_win_rate) : null;
                        const wrCls = wr != null ? (wr >= 60 ? "text-emerald-400" : wr >= 45 ? "text-amber-400" : "text-rose-400") : "text-slate-400";
                        const pathLabel = al.entry_path ? al.entry_path.replace(/_/g, " ") : null;
                        const rBucketWr = al.rank_bucket_wr != null ? Number(al.rank_bucket_wr) : null;
                        const pathAction = al.path_action;
                        const pathEnabled = al.path_enabled !== false;
                        return (
                          <div className="mb-4 p-3 rounded-2xl border border-white/[0.08]" style={{background:"rgba(255,255,255,0.03)",backdropFilter:"blur(12px) saturate(1.2)",WebkitBackdropFilter:"blur(12px) saturate(1.2)",boxShadow:"0 2px 12px rgba(0,0,0,0.25), inset 0 0.5px 0 rgba(255,255,255,0.06)"}}>
                            <div className="flex items-center gap-2 mb-3">
                              <div className="w-5 h-5 rounded-md bg-purple-500/20 flex items-center justify-center text-[10px]">📊</div>
                              <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">System Alignment</span>
                            </div>
                            <div className="space-y-2 text-xs">
                              {pathLabel && (
                                <div className="flex items-center justify-between">
                                  <span className="text-slate-400">Entry path</span>
                                  <div className="flex items-center gap-2">
                                    <span className="text-white font-medium capitalize">{pathLabel}</span>
                                    {pathAction && (
                                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${pathAction === "BOOST" ? "bg-emerald-500/20 text-emerald-400" : pathAction === "DISABLE" ? "bg-rose-500/20 text-rose-400" : pathAction === "RESTRICT" ? "bg-amber-500/20 text-amber-400" : "bg-slate-500/20 text-slate-400"}`}>{pathAction}</span>
                                    )}
                                  </div>
                                </div>
                              )}
                              {wr != null && (
                                <div className="flex items-center justify-between">
                                  <span className="text-slate-400">Path win rate</span>
                                  <span className={`font-bold ${wrCls}`}>{wr.toFixed(0)}%</span>
                                </div>
                              )}
                              {al.path_expectancy != null && (
                                <div className="flex items-center justify-between">
                                  <span className="text-slate-400">Path expectancy</span>
                                  <span className={`font-medium ${Number(al.path_expectancy) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{al.path_expectancy}</span>
                                </div>
                              )}
                              {al.path_sqn != null && (
                                <div className="flex items-center justify-between">
                                  <span className="text-slate-400">Path SQN</span>
                                  <span className="text-white font-medium">{Number(al.path_sqn).toFixed(2)}</span>
                                </div>
                              )}
                              {rBucketWr != null && (
                                <div className="flex items-center justify-between">
                                  <span className="text-slate-400">Rank bucket win rate</span>
                                  <span className={`font-bold ${rBucketWr >= 60 ? "text-emerald-400" : rBucketWr >= 45 ? "text-amber-400" : "text-rose-400"}`}>{rBucketWr.toFixed(0)}%</span>
                                </div>
                              )}
                              {!pathEnabled && (
                                <div className="mt-2 px-2 py-1.5 rounded bg-rose-500/10 border border-rose-500/30 text-[10px] text-rose-300 font-semibold">
                                  This entry path is disabled by calibration — proceed with caution.
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}

                      {/* ═══════════════════════════════════════════════════════════ */}
                      {/* 4. MODEL INTELLIGENCE                                      */}
                      {/* ═══════════════════════════════════════════════════════════ */}
                      {(() => {
                        const ms = modelSignal;
                        const pm = (latestTicker || ticker)?.pattern_match;
                        const ts = ms?.ticker;
                        const ss = ms?.sector;
                        const mk = ms?.market;
                        if (!ts && !pm && !mk) return null;

                        const dirColor = (d) => d === "BULLISH" ? "text-[#00e676]" : d === "BEARISH" ? "text-red-400" : "text-slate-400";
                        const dirBg = (d) => d === "BULLISH" ? "bg-[#00c853]/10 border-[#00c853]/30" : d === "BEARISH" ? "bg-red-500/10 border-red-500/30" : "bg-slate-500/10 border-slate-500/30";
                        const regimeBg = (r) => {
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

                        return (
                          <div className="mb-4 p-3 rounded-2xl border border-white/[0.08]" style={{background:"rgba(255,255,255,0.03)",backdropFilter:"blur(12px) saturate(1.2)",WebkitBackdropFilter:"blur(12px) saturate(1.2)",boxShadow:"0 2px 12px rgba(0,0,0,0.25), inset 0 0.5px 0 rgba(255,255,255,0.06)"}}>
                            <div className="flex items-center gap-2 mb-3">
                              <div className="w-5 h-5 rounded-md bg-blue-500/20 flex items-center justify-center text-[10px]">🧠</div>
                              <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Model Intelligence</span>
                            </div>

                            {/* Ticker Signal */}
                            {(ts || pm) && (
                              <div className={`rounded-lg p-2.5 mb-2 border ${dirBg(ts?.direction || pm?.direction)}`}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-[10px] text-slate-400 uppercase font-semibold">Ticker Indicator</span>
                                  <span className={`text-xs font-bold ${dirColor(ts?.direction || pm?.direction)}`}>
                                    {ts?.direction || pm?.direction || "—"}
                                  </span>
                                </div>
                                <div className="flex items-center gap-3 text-[11px]">
                                  <span className="text-slate-400">Net: <span className={`font-semibold ${(ts?.netSignal || pm?.netSignal || 0) > 0 ? "text-[#00e676]" : (ts?.netSignal || pm?.netSignal || 0) < 0 ? "text-red-400" : "text-slate-300"}`}>
                                    {((ts?.netSignal || pm?.netSignal || 0) > 0 ? "+" : "")}{(ts?.netSignal || pm?.netSignal || 0).toFixed(2)}
                                  </span></span>
                                  <span className="text-slate-400">Patterns: <span className="text-white font-semibold">{ts?.bullPatterns || pm?.bullCount || 0}B / {ts?.bearPatterns || pm?.bearCount || 0}S</span></span>
                                </div>
                                {pm?.bestBull && (
                                  <div className="mt-1.5 text-[10px] text-[#69f0ae]/80">
                                    Top: {pm.bestBull.name} ({(pm.bestBull.conf * 100).toFixed(0)}% conf, EV: {pm.bestBull.ev > 0 ? "+" : ""}{pm.bestBull.ev})
                                  </div>
                                )}
                                <div className="mt-1.5 text-[10px] text-slate-400/90 italic leading-snug">
                                  {describeTickerDir(ts?.direction || pm?.direction, ts?.netSignal || pm?.netSignal || 0)}
                                </div>
                              </div>
                            )}

                            {/* Sector + Market in a row */}
                            <div className="grid grid-cols-2 gap-2">
                              {ss && (
                                <div className={`rounded-lg p-2 border ${regimeBg(ss.regime)}`}>
                                  <div className="text-[9px] text-slate-400 uppercase font-semibold mb-0.5">Sector</div>
                                  <div className="text-[11px] font-bold text-white truncate">{ss.sector}</div>
                                  <div className="text-[10px] text-slate-400">{ss.breadthBullPct}% bull · {ss.regime}</div>
                                  <div className="text-[9px] text-slate-400/80 italic mt-0.5">{describeSector(ss.regime, ss.breadthBullPct)}</div>
                                </div>
                              )}
                              {mk && (mk.totalTickers || 0) > 5 && (
                                <div className={`rounded-lg p-2 border ${regimeBg(mk.signal)}`}>
                                  <div className="text-[9px] text-slate-400 uppercase font-semibold mb-0.5">Market</div>
                                  <div className={`text-[11px] font-bold ${mk.signal?.includes("BULL") ? "text-[#00e676]" : mk.signal?.includes("BEAR") ? "text-red-400" : "text-slate-300"}`}>
                                    {mk.signal?.replace(/_/g, " ")}
                                  </div>
                                  <div className="text-[10px] text-slate-400">{mk.breadthBullPct}% breadth</div>
                                  <div className="text-[9px] text-slate-400/80 italic mt-0.5">{describeMarket(mk.signal, mk.breadthBullPct)}</div>
                                </div>
                              )}
                            </div>
                            {mk?.riskFlag && (mk.totalTickers || 0) > 5 && (
                              <div className="mt-2 text-[10px] text-amber-300/80 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
                                {mk.riskFlag}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* ═══════════════════════════════════════════════════════════ */}
                      {/* 5. RISK / REWARD LEVELS                                    */}
                      {/* ═══════════════════════════════════════════════════════════ */}
                      {(() => {
                        // Use position SL/TP when available (correct for SHORT trades)
                        const posSlRaw = ticker?.has_open_position ? Number(ticker?.position_sl) : NaN;
                        const posTpRaw = ticker?.has_open_position ? Number(ticker?.position_tp) : NaN;
                        const sl = Number.isFinite(posSlRaw) && posSlRaw > 0 ? posSlRaw : (ticker.sl ? Number(ticker.sl) : null);
                        // Original SL at trade creation — used to determine if TSL is active
                        const slOrigRaw = Number(trade?.sl_original ?? ticker?.position_sl_original ?? 0);
                        const slOrig = Number.isFinite(slOrigRaw) && slOrigRaw > 0 ? slOrigRaw : null;
                        const price = Number(ticker?.price);
                        const rr = ticker.rr ? Number(ticker.rr) : null;
                        const hasSl = Number.isFinite(sl) && sl > 0;
                        // TSL is active when current SL has moved > 0.5% from original
                        const tslActive = hasSl && slOrig && Math.abs(sl - slOrig) / slOrig > 0.005;

                        // Prefer trade-level tpArray (direction-aware) over ticker-level (may be LONG-only)
                        const tradeTpArr = Array.isArray(trade?.tpArray) && trade.tpArray.length > 0
                          ? trade.tpArray
                          : (Array.isArray(ticker?.tpArray) ? ticker.tpArray : []);
                        const tpTrimRaw = tradeTpArr.length > 0
                          ? Number(tradeTpArr[0]?.price)
                          : Number(ticker?.tp_trim);
                        const tpExitRaw = tradeTpArr.length > 1
                          ? Number(tradeTpArr[1]?.price)
                          : Number(ticker?.tp_exit);
                        const tpRunnerRaw = tradeTpArr.length > 2
                          ? Number(tradeTpArr[2]?.price)
                          : Number(ticker?.tp_runner);
                        // Direction-aware TP sanity: filter out wrong-side TPs.
                        // For SHORT, TPs must be BELOW entry/price. For LONG, ABOVE.
                        const entryPxForTp = Number(ticker?.position_entry || trade?.entry_price || trade?.entryPrice || ticker?.entry_price || ticker?.entry_ref || ticker?.trigger_price) || 0;
                        const tpSane = (raw) => {
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
                        const has3Tier = (Number.isFinite(tpTrim) && tpTrim > 0) || (Number.isFinite(tpExit) && tpExit > 0);

                        const legacyTarget = computeTpTargetPrice(ticker);
                        const legacyMax = computeTpMaxPrice(ticker);
                        const hasLegacy = !has3Tier && (Number.isFinite(legacyTarget) || Number.isFinite(legacyMax));

                        if (!hasSl && !has3Tier && !hasLegacy && !Number.isFinite(rr)) return null;

                        const dir = resolvedDir; // unified direction from top of component
                        // SL% = absolute risk distance from current price
                        const slDistPct = hasSl && Number.isFinite(price) && price > 0
                          ? Math.abs((sl - price) / price) * 100
                          : null;

                        // Compute per-target R:R from current price (requires known direction)
                        const computeTargetRR = (tpVal) => {
                          if (!dir || !hasSl || !Number.isFinite(price) || price <= 0 || !Number.isFinite(tpVal) || tpVal <= 0) return null;
                          const risk = dir === "LONG" ? price - sl : sl - price;
                          const gain = dir === "LONG" ? tpVal - price : price - tpVal;
                          if (risk <= 0 || gain <= 0) return null;
                          return gain / risk;
                        };

                        // Per-target % distance from current price
                        const tpPct = (tpVal) => {
                          if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tpVal) || tpVal <= 0) return null;
                          return Math.abs((tpVal - price) / price) * 100;
                        };

                        const rrTrim = has3Tier ? computeTargetRR(tpTrim) : null;
                        const rrExit = has3Tier ? computeTargetRR(tpExit) : null;
                        const rrRunner = has3Tier ? computeTargetRR(tpRunner) : null;

                        const getProgressToTp = (tpVal) => {
                          if (!dir || !Number.isFinite(price) || price <= 0 || !Number.isFinite(tpVal)) return 0;
                          const slVal = hasSl ? sl : price;
                          const totalMove = Math.abs(tpVal - slVal);
                          if (totalMove <= 0) return 0;
                          const currentMove = dir === "LONG" ? price - slVal : slVal - price;
                          return Math.max(0, Math.min(1, currentMove / totalMove));
                        };
                        const tierCards = [
                          { tp: tpTrim, rr: rrTrim, label: "Take Profit 1", sub: "Trim 60%", icon: "🎯", bg: "bg-yellow-500/10", border: "border-yellow-500/30", text: "text-yellow-400" },
                          { tp: tpExit, rr: rrExit, label: "Take Profit 2", sub: "Exit 85%", icon: "💰", bg: "bg-orange-500/10", border: "border-orange-500/30", text: "text-orange-400" },
                          { tp: tpRunner, rr: rrRunner, label: "Take Profit 3", sub: "Runner", icon: "🚀", bg: "bg-teal-500/10", border: "border-teal-500/30", text: "text-teal-400" },
                        ];
                        return (
                          <div className="mb-4 space-y-2">
                            <div className="text-[10px] text-[#6b7280] font-semibold uppercase tracking-wider">Risk / Reward Levels</div>
                            {hasSl && (
                              <div className="space-y-1.5">
                                {/* Original SL — always shown when SL exists */}
                                <div className={`p-2.5 rounded border flex items-center justify-between ${tslActive ? "bg-white/[0.02] border-white/[0.08]" : "bg-red-500/10 border-red-500/30"}`}>
                                  <span className={`text-xs font-semibold ${tslActive ? "text-[#6b7280]" : "text-red-400"}`}>Stop Loss</span>
                                  <span className={`text-xs font-bold ${tslActive ? "text-[#6b7280]" : "text-red-400"}`}>{tslActive && slOrig ? `$${slOrig.toFixed(2)}` : `$${sl.toFixed(2)}`}</span>
                                  {!tslActive && Number.isFinite(slDistPct) && <span className="text-[9px] text-red-300/70">{slDistPct.toFixed(1)}% risk</span>}
                                  {tslActive && <span className="text-[9px] text-[#4b5563]">original</span>}
                                </div>
                                {/* TSL — only shown when stop has been trailed */}
                                {tslActive && (
                                  <div className="p-2.5 rounded border bg-red-500/10 border-red-500/30 flex items-center justify-between">
                                    <span className="text-xs font-semibold text-red-400" title="Trailing Stop Loss">TSL</span>
                                    <span className="text-xs font-bold text-red-400">${sl.toFixed(2)}</span>
                                    {Number.isFinite(slDistPct) && <span className="text-[9px] text-red-300/70">{slDistPct.toFixed(1)}% risk</span>}
                                  </div>
                                )}
                              </div>
                            )}
                            <div className="space-y-2">
                              {has3Tier ? (
                                tierCards.filter(t => Number.isFinite(t.tp) && t.tp > 0).map((tier, idx) => {
                                  const progress = getProgressToTp(tier.tp);
                                  return (
                                    <div key={idx} className={`p-2.5 rounded border ${tier.bg} ${tier.border}`}>
                                      <div className="flex justify-between items-center mb-1.5">
                                        <div className="flex items-center gap-2">
                                          <span className="text-sm">{tier.icon}</span>
                                          <span className={`text-xs font-semibold ${tier.text}`}>{tier.label}</span>
                                          <span className="text-[10px] text-[#6b7280]">({tier.sub})</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                          <span className={`text-xs font-bold ${tier.text}`}>${tier.tp.toFixed(2)}</span>
                                          {Number.isFinite(tier.rr) && <span className="text-[10px] font-semibold text-blue-400">{tier.rr.toFixed(2)}:1</span>}
                                        </div>
                                      </div>
                                      <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                                        <div className={`h-full ${tier.label.includes("1") ? "bg-yellow-500" : tier.label.includes("2") ? "bg-orange-500" : "bg-teal-500"} transition-all`} style={{ width: `${Math.round(progress * 100)}%` }} />
                                      </div>
                                    </div>
                                  );
                                })
                              ) : hasLegacy ? (
                                <>
                                  {Number.isFinite(legacyTarget) && (
                                    <div className="flex items-center justify-between gap-2 text-xs">
                                      <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-teal-500/10 border border-teal-500/25">
                                        <span className="text-[10px] text-teal-300">Target</span>
                                        <span className="font-bold text-teal-400">${legacyTarget.toFixed(2)}</span>
                                      </div>
                                      {Number.isFinite(tpPct(legacyTarget)) && <span className="text-[9px] text-[#6b7280]">{tpPct(legacyTarget).toFixed(1)}%</span>}
                                    </div>
                                  )}
                                  {Number.isFinite(legacyMax) && Math.abs(legacyMax - (legacyTarget || 0)) > 0.01 && (
                                    <div className="flex items-center justify-between gap-2 text-xs">
                                      <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-teal-500/10 border border-teal-500/25">
                                        <span className="text-[10px] text-teal-300">Stretch</span>
                                        <span className="font-bold text-teal-400">${legacyMax.toFixed(2)}</span>
                                      </div>
                                      {Number.isFinite(tpPct(legacyMax)) && <span className="text-[9px] text-[#6b7280]">{tpPct(legacyMax).toFixed(1)}%</span>}
                                    </div>
                                  )}
                                </>
                              ) : null}
                            </div>
                          </div>
                        );
                      })()}

                      {/* 6-10. Trend Alignment, Swing Analysis, Momentum Elite, Rank, Score + Breakdown */}
                      <div className="space-y-2.5 text-sm">
                        {/* Trend Alignment — moved up under Chart */}
                        {(() => {
                          const emaMap = ticker?.ema_map;
                          if (!emaMap || typeof emaMap !== 'object') return null;
                          const tfDisplayOrder = ['D', '240', '60', '30', '10', '3'];
                          const tfLabels = { 'W': 'Weekly', 'D': 'Daily', '240': '4H', '60': '1H', '30': '30m', '10': '10m', '3': '3m' };
                          const entries = tfDisplayOrder.map(tf => emaMap[tf] ? { tf, ...emaMap[tf] } : null).filter(Boolean);
                          if (entries.length === 0) return null;
                          const depthLabel = (d) => d >= 9 ? 'Strong Uptrend' : d >= 7 ? 'Uptrend' : d >= 5 ? 'Leaning Up' : d >= 4 ? 'Leaning Down' : d >= 2 ? 'Downtrend' : 'Strong Downtrend';
                          const depthColor = (d) => d >= 8 ? 'text-green-400' : d >= 6 ? 'text-green-300/70' : d >= 4 ? 'text-yellow-300' : d >= 2 ? 'text-orange-400' : 'text-red-400';
                          const depthBg = (d) => d >= 8 ? 'bg-green-500/20' : d >= 6 ? 'bg-green-500/10' : d >= 4 ? 'bg-yellow-500/10' : d >= 2 ? 'bg-orange-500/10' : 'bg-red-500/15';
                          const trendWord = (s, m) => {
                            const avg = (s + m) / 2;
                            if (avg > 0.5) return { text: 'Accelerating', cls: 'text-green-400' };
                            if (avg > 0.15) return { text: 'Trending Up', cls: 'text-green-300/80' };
                            if (avg > -0.15) return { text: 'Flat', cls: 'text-slate-400' };
                            if (avg > -0.5) return { text: 'Fading', cls: 'text-orange-400' };
                            return { text: 'Reversing Down', cls: 'text-red-400' };
                          };
                          return (
                            <div className="border-t border-white/[0.06] my-3 pt-3">
                              <button
                                onClick={() => setEmaExpanded?.(!emaExpanded)}
                                className="w-full flex items-center justify-between text-xs text-[#6b7280] mb-2 font-semibold hover:text-white transition-colors"
                              >
                                <span>Trend Alignment</span>
                                <span className="text-base">{emaExpanded ? "▼" : "▶"}</span>
                              </button>
                              {emaExpanded && (
                                <div className="space-y-1.5">
                                  {entries.map(e => {
                                    const trend = trendWord(e.structure, e.momentum);
                                    const pct = Math.round(e.depth * 10);
                                    return (
                                      <div key={e.tf} className={`flex items-center justify-between text-[11px] py-1.5 px-2 rounded-md ${depthBg(e.depth)}`}>
                                        <span className="text-slate-300 font-medium w-12">{tfLabels[e.tf] || e.tf}</span>
                                        <div className="flex-1 mx-2">
                                          <div className="w-full bg-white/[0.06] rounded-full h-1.5 overflow-hidden">
                                            <div
                                              className={`h-full rounded-full transition-all ${e.depth >= 6 ? 'bg-green-500' : e.depth >= 4 ? 'bg-yellow-500' : 'bg-red-500'}`}
                                              style={{ width: `${pct}%` }}
                                            />
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-2 min-w-[110px] justify-end">
                                          <span className={`font-bold ${depthColor(e.depth)}`} title={depthLabel(e.depth)}>
                                            {depthLabel(e.depth)}
                                          </span>
                                          <span className={`text-[9px] font-medium ${trend.cls}`}>
                                            {trend.text}
                                          </span>
                                        </div>
                                      </div>
                                    );
                                  })}
                                  <div className="text-[9px] text-[#4b5563] mt-1.5 px-1">
                                    Bar shows how many EMAs price is above (trend strength). Labels show if trend is accelerating or fading.
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* Swing Analysis Panel — moved up under Trend Alignment */}
                        {(() => {
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
                          return (
                            <div className="border-t border-white/[0.06] my-3 pt-3">
                              <div className="text-xs text-[#6b7280] font-semibold mb-2">Swing Analysis</div>
                              <div className="space-y-2">
                                {eq && (
                                  <div className={`rounded-md p-2 ${eqBg}`}>
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-[10px] text-slate-400 font-medium">Entry Quality</span>
                                      <span className={`text-sm font-bold ${eqCls}`}>{eqScore}/100</span>
                                    </div>
                                    <div className="flex gap-1.5 text-[9px]">
                                      <span className="px-1 py-0.5 rounded bg-white/[0.06] text-slate-300">Struct: {eq.structure || 0}/35</span>
                                      <span className="px-1 py-0.5 rounded bg-white/[0.06] text-slate-300">Mom: {eq.momentum || 0}/35</span>
                                      <span className="px-1 py-0.5 rounded bg-white/[0.06] text-slate-300">Conf: {eq.confirmation || 0}/30</span>
                                    </div>
                                  </div>
                                )}
                                {reg && reg.combined && (
                                  <div className="flex items-center justify-between text-[10px]">
                                    <span className="text-slate-400">Regime</span>
                                    <div className="flex items-center gap-1.5">
                                      <span className={`px-1.5 py-0.5 rounded font-semibold ${
                                        reg.combined.includes("BULL") ? "text-[#69f0ae] bg-[#00c853]/15"
                                        : reg.combined.includes("BEAR") ? "text-rose-300 bg-rose-500/15"
                                        : "text-slate-300 bg-slate-500/15"
                                      }`}>{
                                        ({STRONG_BULL:"Strong Bull",EARLY_BULL:"Early Bull",LATE_BULL:"Late Bull",COUNTER_TREND_BULL:"CT Bull",NEUTRAL:"Neutral",COUNTER_TREND_BEAR:"CT Bear",EARLY_BEAR:"Early Bear",LATE_BEAR:"Late Bear",STRONG_BEAR:"Strong Bear"})[reg.combined] || reg.combined
                                      }</span>
                                      <span className="text-[#6b7280]">D:{reg.daily?.charAt(0).toUpperCase() || "?"} W:{reg.weekly?.charAt(0).toUpperCase() || "?"}</span>
                                    </div>
                                  </div>
                                )}
                                {sc && (
                                  <div className="rounded-md p-2 bg-white/[0.03]">
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-[10px] text-slate-400 font-medium">TF Consensus</span>
                                      <span className={`text-[11px] font-bold ${scDir === "LONG" ? "text-cyan-300" : scDir === "SHORT" ? "text-rose-300" : "text-slate-400"}`}>
                                        {scDir || "NEUTRAL"} ({bullCt}/{5})
                                      </span>
                                    </div>
                                    <div className="flex gap-0.5">
                                      {tfStack.map((tf, i) => (
                                        <div key={i} className={`flex-1 h-1.5 rounded-full ${tf.bias === "bullish" ? "bg-cyan-400" : tf.bias === "bearish" ? "bg-rose-400" : "bg-slate-600"}`}
                                          title={`${tf.tf}: ${tf.bias}${tf.crossDir ? ` (cross ${tf.crossDir})` : ""}`} />
                                      ))}
                                    </div>
                                    <div className="flex justify-between text-[8px] text-[#4b5563] mt-0.5">
                                      {tfStack.map((tf, i) => (
                                        <span key={i}>{tf.tf}</span>
                                      ))}
                                    </div>
                                    {freshTf && (
                                      <div className="text-[9px] text-purple-300 mt-1">
                                        Fresh {freshTf} cross{freshAge != null ? ` (${freshAge}m ago)` : ""}
                                      </div>
                                    )}
                                  </div>
                                )}
                                {volTier && (
                                  <div className="flex items-center justify-between text-[10px]">
                                    <span className="text-slate-400">Volatility</span>
                                    <div className="flex items-center gap-1.5">
                                      <span className={`px-1.5 py-0.5 rounded font-semibold ${volCls}`}>{volTier}</span>
                                      {Number.isFinite(volPct) && <span className="text-[#6b7280]">{volPct}% ATR/px</span>}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                        {/* Momentum Elite */}
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
                            <div className="border-t border-white/[0.06] my-3 pt-3">
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-sm font-extrabold text-purple-300 tracking-wide">🚀 MOMENTUM ELITE</span>
                                <span className="text-[10px] px-2 py-0.5 rounded border bg-purple-500/25 border-purple-400/50 text-purple-200 font-bold">ACTIVE</span>
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

                        {/* Rank */}
                        {rankTotal > 0 && (
                          <div className="flex justify-between items-center py-1 border-b border-white/[0.06]/50">
                            <span className="text-[#6b7280]">Rank</span>
                            <span className="font-semibold">
                              {rankPosition > 0
                                ? `#${rankPosition} of ${rankTotal}`
                                : "—"}
                              {rankAsOfText && (
                                <span className="ml-2 text-[10px] text-[#6b7280] font-normal">
                                  (as of {rankAsOfText})
                                </span>
                              )}
                            </span>
                          </div>
                        )}

                        {/* Score */}
                        <div className="flex justify-between items-center py-1 border-b border-white/[0.06]/50">
                          <span className="text-[#6b7280]">Score</span>
                          <span className="font-semibold text-blue-400 text-lg">
                            {Number.isFinite(displayScore)
                              ? displayScore.toFixed(1)
                              : "—"}
                          </span>
                        </div>

                        {/* Dead code — Model Score removed */}
                        {false && (() => {
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
                            
                            // Strong patterns
                            if (p >= 70 && e >= 15) return { text: "🎯 Strong pattern - high historical win%, favorable reward", color: "text-green-400", bg: "bg-green-500/10" };
                            if (p >= 60 && e >= 10) return { text: "✅ Good setup - favorable odds", color: "text-green-400", bg: "bg-green-500/10" };
                            
                            // Positive but cautious
                            if (e >= 5 && p >= 55) return { text: "🟢 Decent - small edge, manage risk", color: "text-blue-400", bg: "bg-blue-500/10" };
                            if (e >= 0 && p >= 60) return { text: "⚖️ Neutral - breakeven odds", color: "text-yellow-400", bg: "bg-yellow-500/10" };
                            
                            // Warning patterns
                            if (p >= 70 && e < 0) return { text: "⚠️ Too late - missed the entry", color: "text-orange-400", bg: "bg-orange-500/10" };
                            if (e < -5 && p >= 50) return { text: "🛑 Skip - poor risk/reward", color: "text-red-400", bg: "bg-red-500/10" };
                            if (p < 45) return { text: "❌ Avoid - low probability", color: "text-red-400", bg: "bg-red-500/10" };
                            
                            // Default
                            return { text: "🤔 Unclear pattern - use caution", color: "text-gray-400", bg: "bg-gray-500/10" };
                          };
                          
                          const interp4h = has4h ? interpretML(p4h, ev4h) : null;
                          const interp1d = has1d ? interpretML(p1d, ev1d) : null;
                          
                          return (
                            <>
                              {has4h && (
                                <>
                                  <div className="flex justify-between items-center py-1 border-b border-white/[0.06]/50">
                                    <span className="text-[#6b7280]">
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
                                  <div className="flex justify-between items-center py-1 border-b border-white/[0.06]/50">
                                    <span className="text-[#6b7280]">
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
                            <div className="border-t border-white/[0.06] my-3 pt-3">
                              <button
                                onClick={() => setScoreExpanded(!scoreExpanded)}
                                className="w-full flex items-center justify-between text-xs text-[#6b7280] mb-2 font-semibold hover:text-white transition-colors"
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
                                      <span className="text-[#6b7280]">
                                        {comp.label}
                                      </span>
                                      <span
                                        className={`font-semibold ${comp.color}`}
                                      >
                                        {comp.value}
                                      </span>
                                    </div>
                                  ))}
                                  <div className="flex justify-between items-center text-sm mt-2 pt-2 border-t border-white/[0.06]">
                                    <span className="text-[#6b7280] font-semibold">
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

                        {/* Mini Bubble Chart snapshot (ticker position + journey) */}
                        {(() => {
                          const htf = Number(ticker?.htf_score) || 0;
                          const ltf = Number(ticker?.ltf_score) || 0;
                          const domainMax = 50;
                          const size = 140;
                          const margin = 10;
                          const plot = size - 2 * margin;
                          const scale = plot / (2 * domainMax);
                          const ox = margin;
                          const oy = margin;
                          const toX = (l) => ox + (l + domainMax) * scale;
                          const toY = (h) => oy + (domainMax - h) * scale;
                          const trail = Array.isArray(bubbleJourney) ? bubbleJourney : [];
                          const trailPts = trail.slice(-40).map((p) => ({
                            x: toX(Number(p?.ltf_score) || 0),
                            y: toY(Number(p?.htf_score) || 0),
                          })).filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
                          const cx = toX(ltf);
                          const cy = toY(htf);
                          const bubbleColor = htf > 0 ? "#22c55e" : "#ef4444";
                          const pathD = trailPts.length > 1
                            ? trailPts.reduce((acc, pt, i) => acc + (i === 0 ? `M ${pt.x} ${pt.y}` : ` L ${pt.x} ${pt.y}`), "")
                            : null;
                          return (
                            <div className="border-t border-white/[0.06] my-3 pt-3">
                              <div className="text-[10px] text-[#6b7280] font-semibold mb-2">Bubble Chart</div>
                              <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] overflow-hidden" style={{ width: size, height: size }}>
                                <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
                                  <defs>
                                    <pattern id="rr-grid-mini" width="20" height="20" patternUnits="userSpaceOnUse">
                                      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#252b36" strokeWidth="0.5" opacity="0.5" />
                                    </pattern>
                                  </defs>
                                  <rect width="100%" height="100%" fill="url(#rr-grid-mini)" />
                                  {/* Quadrant tints */}
                                  <rect x={ox} y={oy} width={plot / 2} height={plot / 2} fill="rgba(34,197,94,0.08)" stroke="none" />
                                  <rect x={ox + plot / 2} y={oy} width={plot / 2} height={plot / 2} fill="rgba(34,197,94,0.08)" stroke="none" />
                                  <rect x={ox} y={oy + plot / 2} width={plot / 2} height={plot / 2} fill="rgba(239,68,68,0.08)" stroke="none" />
                                  <rect x={ox + plot / 2} y={oy + plot / 2} width={plot / 2} height={plot / 2} fill="rgba(239,68,68,0.08)" stroke="none" />
                                  {/* Axes */}
                                  <line x1={ox + plot / 2} y1={oy} x2={ox + plot / 2} y2={oy + plot} stroke="#8b92a0" strokeWidth="1" opacity="0.6" />
                                  <line x1={ox} y1={oy + plot / 2} x2={ox + plot} y2={oy + plot / 2} stroke="#8b92a0" strokeWidth="1" opacity="0.6" />
                                  {/* Journey path */}
                                  {pathD && (
                                    <path d={pathD} fill="none" stroke="#eab308" strokeWidth="1.5" strokeDasharray="2 2" opacity="0.7" />
                                  )}
                                  {/* Journey points (small dots) */}
                                  {trailPts.slice(0, -1).map((pt, idx) => (
                                    <circle key={`j-${idx}`} cx={pt.x} cy={pt.y} r="2" fill="#eab308" fillOpacity={0.3 + (idx / trailPts.length) * 0.4} stroke="none" />
                                  ))}
                                  {/* Current ticker bubble */}
                                  <circle cx={cx} cy={cy} r="6" fill={bubbleColor} fillOpacity="0.9" stroke="#fff" strokeWidth="1.2" />
                                </svg>
                              </div>
                            </div>
                          );
                        })()}

                      </div>

                    </>
                  ) : null}

                  {railTab === "TECHNICALS" ? (
                    <>
                      {/* Triggers */}
                      <div className="mt-6 pt-6 border-t-2 border-white/[0.06]">
                        <div className="text-sm font-bold text-[#6b7280] mb-4">
                          ⚡ Triggers
                        </div>
                        <div className="p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]">
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
                            <div className="text-xs text-[#6b7280]">
                              No trigger patterns detected.
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Timeframes (Per-TF technicals) */}
                      <div className="mt-6 pt-6 border-t-2 border-white/[0.06]">
                        <div className="text-sm font-bold text-[#6b7280] mb-4">
                          Timeframe Analysis
                        </div>
                        <div className="space-y-2">
                          {tfTech ? (
                            tfOrder.map(({ k, label }) => {
                                const row = tfTech[k] || null;
                                if (!row) return null;
                                const atr = row.atr || null;
                                const ema = row.ema || null;
                                const ph = row.ph || null;
                                const sq = row.sq || null;
                                const rsi = row.rsi || null;

                                const structure = ema && Number.isFinite(Number(ema.structure)) ? Number(ema.structure) : 0;
                                const sig = structure >= 0.3 ? 1 : structure <= -0.3 ? -1 : 0;
                                const sigLabel = sig === 1 ? "Bullish" : sig === -1 ? "Bearish" : "Neutral";
                                const sigColor = sig === 1 ? "text-green-400" : sig === -1 ? "text-red-400" : "text-[#6b7280]";
                                const sigBg = sig === 1 ? "border-green-500/20" : sig === -1 ? "border-red-500/20" : "border-white/[0.06]";

                                const depth = ema && Number.isFinite(Number(ema.depth)) ? Number(ema.depth) : 0;
                                const aboveCount = Math.min(depth, emaLevels.length);
                                const emaTotal = emaLevels.length;

                                const emaSummary = (() => {
                                  if (aboveCount === emaTotal) return "Price above all moving averages — strong uptrend";
                                  if (aboveCount >= 5) return `Price above ${aboveCount} of ${emaTotal} MAs — bullish structure`;
                                  if (aboveCount >= 3) return `Price above ${aboveCount} of ${emaTotal} MAs — mixed, trending sideways`;
                                  if (aboveCount >= 1) return `Price above only ${aboveCount} of ${emaTotal} MAs — weak, mostly below`;
                                  return "Price below all moving averages — deep pullback or downtrend";
                                })();

                                const atrSummary = (() => {
                                  if (!atr) return null;
                                  const side = Number(atr.s);
                                  const lo = Number(atr.lo);
                                  const hi = atr.hi != null ? Number(atr.hi) : null;
                                  if (!Number.isFinite(lo)) return null;
                                  const dir = side === -1 ? "below" : "above";
                                  if (hi != null && Number.isFinite(hi)) {
                                    if (lo <= 0.5) return `Near the mean — price is within normal range`;
                                    if (lo <= 1.5) return `${lo.toFixed(1)}–${hi.toFixed(1)} ATRs ${dir} mean — moderately extended`;
                                    return `${lo.toFixed(1)}–${hi.toFixed(1)} ATRs ${dir} mean — stretched, watch for reversion`;
                                  }
                                  if (lo <= 0.5) return `Near the mean — price is within normal range`;
                                  if (lo <= 1.5) return `${lo.toFixed(1)}+ ATRs ${dir} mean — moderately extended`;
                                  return `${lo.toFixed(1)}+ ATRs ${dir} mean — stretched, watch for reversion`;
                                })();

                                const sqParts = [];
                                if (sq && sq.c) sqParts.push("Compressed");
                                if (sq && sq.s) sqParts.push("Fired");
                                if (sq && sq.r) sqParts.push("Released");
                                const sqSummary = sqParts.length > 0
                                  ? sqParts.join(" → ")
                                  : null;
                                const sqDesc = (() => {
                                  if (sq && sq.r) return "Energy released — momentum expanding";
                                  if (sq && sq.s) return "Squeeze fired — breakout imminent";
                                  if (sq && sq.c) return "Volatility compressed — building energy for a move";
                                  return null;
                                })();

                                const r5 = rsi && rsi.r5 != null ? Number(rsi.r5) : null;
                                const r14 = rsi && rsi.r14 != null ? Number(rsi.r14) : null;
                                const rsiSummary = (() => {
                                  const v = r14 != null ? r14 : r5;
                                  if (v == null) return null;
                                  if (v >= 75) return `RSI ${v.toFixed(0)} — overbought, watch for pullback`;
                                  if (v >= 60) return `RSI ${v.toFixed(0)} — healthy bullish momentum`;
                                  if (v >= 40) return `RSI ${v.toFixed(0)} — neutral, no strong momentum`;
                                  if (v >= 25) return `RSI ${v.toFixed(0)} — weak, approaching oversold`;
                                  return `RSI ${v.toFixed(0)} — oversold, bounce potential`;
                                })();

                                const phaseSummary = (() => {
                                  if (!ph || ph.v == null) return null;
                                  const v = Number(ph.v);
                                  if (!Number.isFinite(v)) return null;
                                  if (v >= 80) return `Phase ${v} — late stage, most of the move is done`;
                                  if (v >= 50) return `Phase ${v} — mid-move, momentum still active`;
                                  if (v >= 20) return `Phase ${v} — early stage, plenty of room`;
                                  return `Phase ${v} — very early or resetting`;
                                })();

                                const phDivSummary = (() => {
                                  const divs = (ph && Array.isArray(ph.div) ? ph.div : []).slice(0, 3);
                                  if (divs.length === 0) return null;
                                  const d = divs[0];
                                  if (d === "B") return "Bullish divergence — price falling but momentum building (potential reversal up)";
                                  if (d === "S") return "Bearish divergence — price rising but momentum fading (potential reversal down)";
                                  return null;
                                })();

                                const tfInterpretation = (() => {
                                  const parts = [];
                                  if (sig === 1) {
                                    if (sq && sq.r) parts.push("Bullish with momentum expanding after squeeze release");
                                    else if (sq && sq.s) parts.push("Bullish — squeeze just fired, breakout starting");
                                    else if (aboveCount >= 5) parts.push("Bullish trend with strong MA support");
                                    else parts.push("Leaning bullish");
                                  } else if (sig === -1) {
                                    if (sq && sq.r) parts.push("Bearish with selling accelerating after squeeze release");
                                    else if (sq && sq.s) parts.push("Bearish — squeeze just fired, breakdown starting");
                                    else if (aboveCount <= 2) parts.push("Bearish trend with price below most MAs");
                                    else parts.push("Leaning bearish");
                                  } else {
                                    if (sq && sq.c) parts.push("Neutral — volatility compressed, waiting for direction");
                                    else parts.push("No clear directional bias on this timeframe");
                                  }
                                  return parts[0] || "";
                                })();

                                return (
                                  <div key={k} className={`rounded-lg p-3 bg-white/[0.02] border ${sigBg}`}>
                                    <div className="flex items-center justify-between mb-1.5">
                                      <span className="text-sm font-bold text-white">{label}</span>
                                      <span className={`text-xs font-semibold px-2 py-0.5 rounded ${sig === 1 ? "bg-green-500/15 text-green-400" : sig === -1 ? "bg-red-500/15 text-red-400" : "bg-white/[0.05] text-[#6b7280]"}`}>{sigLabel}</span>
                                    </div>
                                    <div className="text-[11px] text-slate-300/80 italic mb-2.5 leading-snug">{tfInterpretation}</div>

                                    <div className="space-y-1.5 text-[11px]">
                                      <div className="flex items-start gap-2">
                                        <span className="text-[#6b7280] w-12 shrink-0 pt-px" title="Moving Averages — how many EMAs price is above">MAs</span>
                                        <span className="text-slate-300">{emaSummary}{ema && ema.stack != null ? ` (stack: ${ema.stack})` : ""}</span>
                                      </div>
                                      {atrSummary && (
                                        <div className="flex items-start gap-2">
                                          <span className="text-[#6b7280] w-12 shrink-0 pt-px" title="Average True Range — how far price is from its normal trading range">ATR</span>
                                          <span className="text-slate-300">{atrSummary}</span>
                                        </div>
                                      )}
                                      {rsiSummary && (
                                        <div className="flex items-start gap-2">
                                          <span className="text-[#6b7280] w-12 shrink-0 pt-px" title="Relative Strength Index — momentum oscillator (30=oversold, 70=overbought)">RSI</span>
                                          <span className="text-slate-300">{rsiSummary}{r5 != null && r14 != null ? ` (fast: ${r5.toFixed(0)}, slow: ${r14.toFixed(0)})` : ""}</span>
                                        </div>
                                      )}
                                      {sqSummary && (
                                        <div className="flex items-start gap-2">
                                          <span className="text-[#6b7280] w-12 shrink-0 pt-px" title="Bollinger Band Squeeze — volatility compression that often precedes big moves">Sqz</span>
                                          <span className="text-slate-300">{sqDesc || sqSummary}</span>
                                        </div>
                                      )}
                                      {phaseSummary && (
                                        <div className="flex items-start gap-2">
                                          <span className="text-[#6b7280] w-12 shrink-0 pt-px" title="Phase — how far along the current move is (0=early, 100=late)">Phase</span>
                                          <span className="text-slate-300">{phaseSummary}</span>
                                        </div>
                                      )}
                                      {phDivSummary && (
                                        <div className="flex items-start gap-2">
                                          <span className="text-[#6b7280] w-12 shrink-0 pt-px">Div</span>
                                          <span className={`${(ph?.div?.[0]) === "B" ? "text-green-400/90" : "text-red-400/90"}`}>{phDivSummary}</span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                              })
                          ) : (
                            <div className="text-xs text-[#6b7280] p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]">
                              No per-timeframe technicals available yet.
                            </div>
                          )}
                        </div>
                      </div>

                      {ticker.td_sequential &&
                        (() => {
                          const tdSeq = ticker.td_sequential;
                          const bullPrep = Number(tdSeq.bullish_prep_count || 0);
                          const bearPrep = Number(tdSeq.bearish_prep_count || 0);
                          const bullLeadup = Number(tdSeq.bullish_leadup_count || 0);
                          const bearLeadup = Number(tdSeq.bearish_leadup_count || 0);
                          const hasTd9Bull = tdSeq.td9_bullish === true || tdSeq.td9_bullish === "true";
                          const hasTd9Bear = tdSeq.td9_bearish === true || tdSeq.td9_bearish === "true";
                          const hasTd13Bull = tdSeq.td13_bullish === true || tdSeq.td13_bullish === "true";
                          const hasTd13Bear = tdSeq.td13_bearish === true || tdSeq.td13_bearish === "true";
                          const hasExitLong = tdSeq.exit_long === true || tdSeq.exit_long === "true";
                          const hasExitShort = tdSeq.exit_short === true || tdSeq.exit_short === "true";

                          const tdSummary = (() => {
                            if (hasExitLong) return "Exhaustion signal — the current up-move may be running out of steam. Consider tightening stops.";
                            if (hasExitShort) return "Exhaustion signal — the current down-move may be running out of steam. Watch for a bounce.";
                            if (hasTd13Bull) return "TD13 bullish complete — a strong reversal buy signal. The downtrend is likely exhausted.";
                            if (hasTd13Bear) return "TD13 bearish complete — a strong reversal sell signal. The uptrend is likely exhausted.";
                            if (hasTd9Bull) return "TD9 bullish complete — a potential buy reversal setup. Selling pressure may be near exhaustion.";
                            if (hasTd9Bear) return "TD9 bearish complete — a potential sell reversal setup. Buying pressure may be near exhaustion.";
                            if (bullPrep >= 7) return `Bullish setup ${bullPrep}/9 — nearing completion for a potential buy signal.`;
                            if (bearPrep >= 7) return `Bearish setup ${bearPrep}/9 — nearing completion for a potential sell signal.`;
                            if (bullPrep >= 4) return `Bullish setup building (${bullPrep}/9) — counting consecutive closes below prior close.`;
                            if (bearPrep >= 4) return `Bearish setup building (${bearPrep}/9) — counting consecutive closes above prior close.`;
                            return "No active TD Sequential patterns — the current trend hasn't reached a reversal count yet.";
                          })();

                          return (
                            <div className="mt-6 pt-6 border-t-2 border-white/[0.06]">
                              <div className="text-sm font-bold text-[#6b7280] mb-2">
                                TD Sequential
                              </div>
                              <div className="text-[11px] text-slate-300/80 italic mb-3 leading-snug">{tdSummary}</div>

                              <div className="p-3 bg-white/[0.03] rounded-lg border border-white/[0.06] space-y-2">
                                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                                  <div className="flex justify-between">
                                    <span className="text-[#6b7280]" title="Counts consecutive closes lower than 4 bars ago — a buy setup forms at 9">Buy Setup</span>
                                    <span className={`font-semibold ${bullPrep >= 7 ? "text-yellow-400" : bullPrep >= 4 ? "text-green-400" : "text-[#6b7280]"}`}>{bullPrep}/9</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-[#6b7280]" title="Counts consecutive closes higher than 4 bars ago — a sell setup forms at 9">Sell Setup</span>
                                    <span className={`font-semibold ${bearPrep >= 7 ? "text-yellow-400" : bearPrep >= 4 ? "text-red-400" : "text-[#6b7280]"}`}>{bearPrep}/9</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-[#6b7280]" title="After a completed buy setup, counts 13 bars for a stronger buy signal">Buy Countdown</span>
                                    <span className={`font-semibold ${bullLeadup >= 10 ? "text-yellow-400" : bullLeadup >= 4 ? "text-green-400" : "text-[#6b7280]"}`}>{bullLeadup}/13</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-[#6b7280]" title="After a completed sell setup, counts 13 bars for a stronger sell signal">Sell Countdown</span>
                                    <span className={`font-semibold ${bearLeadup >= 10 ? "text-yellow-400" : bearLeadup >= 4 ? "text-red-400" : "text-[#6b7280]"}`}>{bearLeadup}/13</span>
                                  </div>
                                </div>

                                {(hasTd9Bull || hasTd9Bear || hasTd13Bull || hasTd13Bear) && (
                                  <div className="pt-2 mt-1 border-t border-white/[0.06] space-y-1">
                                    {hasTd9Bull && <div className="flex items-center gap-2 text-xs"><span className="w-2 h-2 rounded-full bg-green-400"></span><span className="text-green-400 font-semibold">TD9 Buy</span><span className="text-[#6b7280]">— setup complete, potential reversal up</span></div>}
                                    {hasTd9Bear && <div className="flex items-center gap-2 text-xs"><span className="w-2 h-2 rounded-full bg-red-400"></span><span className="text-red-400 font-semibold">TD9 Sell</span><span className="text-[#6b7280]">— setup complete, potential reversal down</span></div>}
                                    {hasTd13Bull && <div className="flex items-center gap-2 text-xs"><span className="w-2 h-2 rounded-full bg-green-400"></span><span className="text-green-400 font-semibold">TD13 Buy</span><span className="text-[#6b7280]">— countdown complete, strong buy signal</span></div>}
                                    {hasTd13Bear && <div className="flex items-center gap-2 text-xs"><span className="w-2 h-2 rounded-full bg-red-400"></span><span className="text-red-400 font-semibold">TD13 Sell</span><span className="text-[#6b7280]">— countdown complete, strong sell signal</span></div>}
                                  </div>
                                )}
                              </div>

                              {(hasExitLong || hasExitShort) && (
                                <div className="mt-2 p-3 rounded-lg border-2 bg-red-500/20 border-red-500/50">
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs text-[#6b7280]">Exhaustion Warning</span>
                                    <span className="font-bold text-sm text-red-400">{hasExitLong ? "EXIT LONG" : "EXIT SHORT"}</span>
                                  </div>
                                  <div className="text-[11px] text-[#6b7280] mt-1">
                                    {hasExitLong ? "The current rally shows signs of exhaustion — momentum is fading. Consider taking profits or raising stops." : "The current decline shows signs of exhaustion — selling pressure is fading. Watch for a reversal bounce."}
                                  </div>
                                </div>
                              )}

                              {tdSeq.boost !== undefined && tdSeq.boost !== null && Number(tdSeq.boost) !== 0 && (
                                <div className="mt-2 flex justify-between items-center text-xs px-3 py-2 bg-white/[0.03] rounded-lg border border-white/[0.06]">
                                  <span className="text-[#6b7280]">Score impact from TD Sequential</span>
                                  <span className={`font-semibold ${Number(tdSeq.boost) > 0 ? "text-green-400" : "text-red-400"}`}>{Number(tdSeq.boost) > 0 ? "+" : ""}{Number(tdSeq.boost).toFixed(1)}</span>
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

                          const rsiColor = rsiValue >= 70 ? "text-red-400" : rsiValue <= 30 ? "text-green-400" : rsiValue >= 50 ? "text-yellow-400" : "text-blue-400";
                          const barColor = rsiValue >= 70 ? "bg-red-500" : rsiValue <= 30 ? "bg-green-500" : rsiValue >= 50 ? "bg-yellow-500" : "bg-blue-500";

                          const rsiInterpretation = (() => {
                            if (rsiValue >= 80) return "Extremely overbought — the rally is stretched and a pullback is likely. Caution buying here.";
                            if (rsiValue >= 70) return "Overbought territory — momentum is strong but the move is getting extended. Watch for signs of slowing.";
                            if (rsiValue >= 55) return "Healthy bullish momentum — price is trending up without being overextended. A good zone for trend-following.";
                            if (rsiValue >= 45) return "Neutral momentum — no strong directional pressure. Price is consolidating or transitioning.";
                            if (rsiValue >= 30) return "Weak momentum — price is under pressure but not yet at extreme levels.";
                            if (rsiValue >= 20) return "Oversold territory — selling may be overdone. Watch for a bounce or reversal setup.";
                            return "Extremely oversold — panic selling or capitulation. A snapback rally is possible.";
                          })();

                          return (
                            <div className="mt-6 pt-6 border-t-2 border-white/[0.06]">
                              <div className="text-sm font-bold text-[#6b7280] mb-3">
                                RSI & Divergence
                              </div>

                              <div className="p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]">
                                <div className="flex justify-between items-center mb-1">
                                  <span className="text-xs text-[#6b7280]" title="Relative Strength Index (14-period) — measures momentum on a 0-100 scale. Below 30 is oversold, above 70 is overbought.">RSI (14)</span>
                                  <span className={`font-bold text-lg ${rsiColor}`}>{rsiValue.toFixed(1)}</span>
                                </div>
                                <div className="mt-1.5 h-2 bg-white/[0.04] rounded-full overflow-hidden relative">
                                  <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${rsiValue}%` }} />
                                </div>
                                <div className="flex justify-between text-[9px] text-[#4b5563] mt-0.5">
                                  <span>Oversold</span>
                                  <span>30</span>
                                  <span>50</span>
                                  <span>70</span>
                                  <span>Overbought</span>
                                </div>
                                <div className="mt-2 text-[11px] text-slate-300/80 italic leading-snug">{rsiInterpretation}</div>
                              </div>

                              {divType !== "none" && (
                                <div className={`mt-2 p-3 rounded-lg border-2 ${divType === "bullish" ? "bg-green-500/15 border-green-500/40" : "bg-red-500/15 border-red-500/40"}`}>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs font-semibold text-[#6b7280]">Divergence Detected</span>
                                    <span className={`font-bold text-sm ${divType === "bullish" ? "text-green-400" : "text-red-400"}`}>{divType === "bullish" ? "Bullish" : "Bearish"}</span>
                                  </div>
                                  <div className="text-[11px] text-slate-300/80 leading-snug">
                                    {divType === "bullish"
                                      ? "Price made a lower low but RSI made a higher low — selling momentum is fading even as price drops. This often precedes a reversal upward."
                                      : "Price made a higher high but RSI made a lower high — buying momentum is fading even as price rises. This often precedes a reversal downward."}
                                  </div>
                                  {divStrength > 0 && <div className="text-[10px] text-[#6b7280] mt-1">Signal strength: {divStrength.toFixed(2)}</div>}
                                </div>
                              )}
                            </div>
                          );
                        })()}

                      {/* State, Horizon, Detected Patterns */}
                      <div className="mb-4 p-3 bg-white/[0.03] border-2 border-white/[0.06] rounded-lg">
                        <div className="text-sm font-bold text-[#6b7280] mb-2">
                          Current Position
                        </div>
                        {(() => {
                          const stateTranslations = {
                            "HTF_BULL_LTF_BULL": { label: "Fully Bullish", desc: "Both long-term and short-term trends aligned up — strongest buying condition", color: "text-green-400" },
                            "HTF_BULL_LTF_PULLBACK": { label: "Bullish Pullback", desc: "Long-term trend is up, short-term pulling back — potential buy-the-dip zone", color: "text-yellow-400" },
                            "HTF_BULL_LTF_BEAR": { label: "Bull Trend, Bear Momentum", desc: "Long-term still bullish but short-term momentum has turned down — wait for stabilization", color: "text-yellow-400" },
                            "HTF_BEAR_LTF_BEAR": { label: "Fully Bearish", desc: "Both long-term and short-term trends aligned down — strongest selling condition", color: "text-red-400" },
                            "HTF_BEAR_LTF_PULLBACK": { label: "Bearish Bounce", desc: "Long-term trend is down, short-term bouncing — potential sell-the-rip zone", color: "text-orange-400" },
                            "HTF_BEAR_LTF_BULL": { label: "Bear Trend, Bull Momentum", desc: "Long-term still bearish but short-term momentum has turned up — could be a reversal or dead cat bounce", color: "text-orange-400" },
                          };
                          const raw = ticker.state || "";
                          const translated = stateTranslations[raw] || null;
                          const horizonLabel = (() => {
                            const bucket = String(ticker.horizon_bucket || "").trim().toUpperCase();
                            if (bucket) {
                              if (bucket.includes("SHORT")) return { label: "Short Term", desc: "Expected to play out within days" };
                              if (bucket.includes("SWING")) return { label: "Swing", desc: "Expected to play out over 1-4 weeks" };
                              if (bucket.includes("POSITION")) return { label: "Positional", desc: "Expected to play out over weeks to months" };
                              return { label: bucket.replace("_", " "), desc: "" };
                            }
                            const eta = computeEtaDays(ticker);
                            if (!Number.isFinite(eta)) return null;
                            if (eta <= 7) return { label: "Short Term", desc: `~${eta.toFixed(0)} days remaining` };
                            if (eta <= 30) return { label: "Swing", desc: `~${eta.toFixed(0)} days remaining` };
                            return { label: "Positional", desc: `~${eta.toFixed(0)} days remaining` };
                          })();

                          return (
                            <div className="space-y-2 text-xs">
                              <div>
                                <div className="flex justify-between items-center">
                                  <span className="text-[#6b7280]" title="The combined long-term (HTF) and short-term (LTF) trend state">Market State</span>
                                  <span className={`font-semibold ${translated ? translated.color : "text-white"}`}>{translated ? translated.label : (raw || "—")}</span>
                                </div>
                                {translated && <div className="text-[10px] text-slate-400/80 mt-0.5 leading-snug">{translated.desc}</div>}
                              </div>
                              {horizonLabel && (
                                <div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-[#6b7280]" title="How long the trade setup is expected to take">Time Horizon</span>
                                    <span className="font-semibold text-white">{horizonLabel.label}</span>
                                  </div>
                                  {horizonLabel.desc && <div className="text-[10px] text-slate-400/80 mt-0.5">{horizonLabel.desc}</div>}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                        {detectedPatterns && detectedPatterns.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-white/[0.06]">
                            <div className="text-xs font-semibold text-yellow-400 mb-2">
                              Detected Patterns
                            </div>
                            <div className="space-y-2">
                              {detectedPatterns.map((pattern, idx) => (
                                <div key={`pattern-${idx}`} className="p-2 rounded border bg-white/[0.02] border-white/[0.06]">
                                  <div className="flex items-center justify-between">
                                    <div className="text-xs text-white font-semibold">{pattern.description}</div>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300">{pattern.confidence}</span>
                                  </div>
                                  {pattern.quadrant && <div className="text-[10px] text-[#6b7280] mt-0.5">{pattern.quadrant}</div>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* EMA Cloud Positions */}
                      {(ticker.daily_ema_cloud || ticker.fourh_ema_cloud || ticker.oneh_ema_cloud) &&
                        (() => {
                          const clouds = [
                            { data: ticker.daily_ema_cloud, label: "Daily", emas: "5/8 EMA", desc: "The short-term daily trend cloud" },
                            { data: ticker.fourh_ema_cloud, label: "4H", emas: "8/13 EMA", desc: "The intermediate swing trend cloud" },
                            { data: ticker.oneh_ema_cloud, label: "1H", emas: "13/21 EMA", desc: "The intraday momentum cloud" },
                          ].filter(c => c.data);
                          if (clouds.length === 0) return null;

                          const posDesc = (pos) => {
                            if (pos === "above") return { text: "Above", color: "text-green-400", bg: "bg-green-500/15 border-green-500/30", meaning: "bullish — price is above the cloud, confirming upward momentum" };
                            if (pos === "below") return { text: "Below", color: "text-red-400", bg: "bg-red-500/15 border-red-500/30", meaning: "bearish — price is below the cloud, confirming downward pressure" };
                            return { text: "Inside", color: "text-yellow-400", bg: "bg-yellow-500/15 border-yellow-500/30", meaning: "neutral — price is inside the cloud, direction is uncertain" };
                          };

                          return (
                            <div className="mt-6 pt-6 border-t-2 border-white/[0.06]">
                              <div className="text-sm font-bold text-[#6b7280] mb-2">
                                EMA Clouds
                              </div>
                              <div className="text-[10px] text-slate-400/70 mb-3">EMA clouds show moving average zones — price above = bullish, below = bearish, inside = undecided</div>
                              <div className="space-y-2">
                                {clouds.map(({ data, label, emas, desc }) => {
                                  const p = posDesc(data.position);
                                  return (
                                    <div key={label} className={`p-2.5 rounded-lg border ${p.bg}`}>
                                      <div className="flex items-center justify-between mb-1">
                                        <span className="text-xs font-semibold text-white" title={desc}>{label} <span className="text-[#6b7280] font-normal">({emas})</span></span>
                                        <span className={`text-xs font-bold ${p.color}`}>{p.text}</span>
                                      </div>
                                      <div className="text-[10px] text-slate-400/80">{label} is {p.meaning}</div>
                                      <div className="flex gap-4 mt-1.5 text-[10px] text-[#6b7280]">
                                        <span>Cloud: ${Number(data.lower).toFixed(2)} – ${Number(data.upper).toFixed(2)}</span>
                                        <span>Price: <span className="text-white font-semibold">${Number(data.price).toFixed(2)}</span></span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
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
                            <div className="mt-6 pt-6 border-t-2 border-white/[0.06]">
                              <div className="text-sm font-bold text-[#6b7280] mb-4">
                                Fundamental & Valuation
                              </div>

                              {/* Valuation Signal Badge */}
                              {fund.valuation_signal && (
                                <div
                                  className={`mb-4 p-3 rounded-lg border-2 ${signalBg}`}
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs text-[#6b7280]">
                                      Valuation Indicator
                                    </span>
                                    <span
                                      className={`font-bold text-sm ${signalColor}`}
                                    >
                                      {fund.valuation_signal.toUpperCase()}
                                    </span>
                                  </div>
                                  {fund.valuation_confidence && (
                                    <div className="text-xs text-[#6b7280] mt-1">
                                      Confidence:{" "}
                                      <span className="font-semibold">
                                        {fund.valuation_confidence}
                                      </span>
                                    </div>
                                  )}
                                  {fund.valuation_reasons &&
                                    fund.valuation_reasons.length > 0 && (
                                      <div className="mt-2 pt-2 border-t border-current/30">
                                        <div className="text-[10px] text-[#6b7280] mb-1">
                                          Reasons:
                                        </div>
                                        {fund.valuation_reasons.map(
                                          (reason, idx) => (
                                            <div
                                              key={idx}
                                              className="text-[10px] text-[#6b7280]/80 mb-0.5"
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
                                  <div className="flex justify-between items-center py-1 border-b border-white/[0.06]/50">
                                    <span className="text-[#6b7280]" title="Price-to-Earnings — how much investors pay per $1 of earnings. Lower = cheaper relative to profits.">
                                      P/E Ratio
                                    </span>
                                    <span className="font-semibold">
                                      {Number(fund.pe_ratio).toFixed(2)}
                                    </span>
                                  </div>
                                )}
                                {fund.peg_ratio !== null && (
                                  <div className="flex justify-between items-center py-1 border-b border-white/[0.06]/50">
                                    <span className="text-[#6b7280]" title="P/E divided by earnings growth rate. Below 1.0 = potentially undervalued for its growth. Above 1.5 = expensive.">
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
                                              : "text-[#6b7280]"
                                      }`}
                                    >
                                      {Number(fund.peg_ratio).toFixed(2)}
                                    </span>
                                  </div>
                                )}
                                {fund.eps !== null && (
                                  <div className="flex justify-between items-center py-1 border-b border-white/[0.06]/50">
                                    <span className="text-[#6b7280]" title="Earnings Per Share (trailing 12 months) — how much profit the company earned per share over the past year.">
                                      EPS (TTM)
                                    </span>
                                    <span className="font-semibold">
                                      ${Number(fund.eps).toFixed(2)}
                                    </span>
                                  </div>
                                )}
                                {fund.eps_growth_rate !== null && (
                                  <div className="flex justify-between items-center py-1 border-b border-white/[0.06]/50">
                                    <span className="text-[#6b7280]" title="Year-over-year earnings growth rate. Higher = company is growing profits faster.">
                                      EPS Growth (Annual)
                                    </span>
                                    <span
                                      className={`font-semibold ${
                                        fund.eps_growth_rate > 20
                                          ? "text-green-400"
                                          : fund.eps_growth_rate > 10
                                            ? "text-yellow-400"
                                            : fund.eps_growth_rate > 0
                                              ? "text-[#6b7280]"
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
                                    <div className="flex justify-between items-center py-1 border-b border-white/[0.06]/50">
                                      <span className="text-[#6b7280]" title="Total market value of all outstanding shares. Larger = more established company.">
                                        Market Cap
                                      </span>
                                      <span className="font-semibold">
                                        {formatted}
                                      </span>
                                    </div>
                                  );
                                })()}
                                {fund.industry && (
                                  <div className="flex justify-between items-center py-1 border-b border-white/[0.06]/50">
                                    <span className="text-[#6b7280]">
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
                                  <div className="mb-4 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]">
                                    <div className="text-xs text-[#6b7280] mb-2">
                                      Fair Value
                                    </div>
                                    <div className="flex items-center justify-between mb-2">
                                      <span className="text-sm text-[#6b7280]">
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
                                        <span className="text-xs text-[#6b7280]">
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
                                                  : "text-[#6b7280]"
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
                                        <div className="mt-2 pt-2 border-t border-white/[0.06] text-xs text-[#6b7280]">
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
                                <div className="mb-4 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]">
                                  <div className="text-xs text-[#6b7280] mb-2">
                                    Historical P/E Percentiles
                                  </div>
                                  <div className="grid grid-cols-2 gap-2 text-xs">
                                    {fund.pe_percentiles.p10 !== null && (
                                      <div className="flex justify-between">
                                        <span className="text-[#6b7280]">
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
                                        <span className="text-[#6b7280]">
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
                                        <span className="text-[#6b7280]">
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
                                        <span className="text-[#6b7280]">
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
                                        <span className="text-[#6b7280]">
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
                                      <div className="flex justify-between col-span-2 pt-1 border-t border-white/[0.06]">
                                        <span className="text-[#6b7280]">
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
                                    <div className="mt-2 pt-2 border-t border-white/[0.06] text-xs">
                                      <span className="text-[#6b7280]">
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
                                              : "text-[#6b7280]"
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
                                  <div className="mb-4 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]">
                                    <div className="text-xs text-[#6b7280] mb-1">
                                      Rank Components
                                    </div>
                                    <div className="flex justify-between items-center text-xs">
                                      <span className="text-[#6b7280]">
                                        Base Rank
                                      </span>
                                      <span className="font-semibold">
                                        {ticker.rank_components.base_rank ||
                                          baseScore}
                                      </span>
                                    </div>
                                    <div className="flex justify-between items-center text-xs mt-1">
                                      <span className="text-[#6b7280]">
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
                                    <div className="flex justify-between items-center text-sm mt-2 pt-2 border-t border-white/[0.06]">
                                      <span className="text-[#6b7280] font-semibold">
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

                  {/* CHART tab removed — chart consolidated into ANALYSIS tab */}
                  {false ? (
                    <>
                      <div className="mb-4 p-3 bg-white/[0.03] border-2 border-white/[0.06] rounded-lg">
                        <div className="flex items-center justify-between gap-2 mb-3">
                          <div className="text-sm text-[#6b7280]">Chart (REMOVED)</div>
                          <div className="flex items-center gap-1 flex-wrap">
                            {[
                              { tf: "5", label: "5m" },
                              { tf: "10", label: "10m" },
                              { tf: "30", label: "30m" },
                              { tf: "60", label: "1H" },
                              { tf: "240", label: "4H" },
                              { tf: "D", label: "D" },
                              { tf: "W", label: "W" },
                              { tf: "M", label: "M" },
                            ].map((t) => {
                              const active = String(chartTf) === String(t.tf);
                              return (
                                <button
                                  key={`tf-${t.tf}`}
                                  onClick={() => setChartTf(String(t.tf))}
                                  className={`px-2 py-1 rounded border text-[11px] font-semibold transition-all ${
                                    active
                                      ? "border-blue-400 bg-blue-500/20 text-blue-200"
                                      : "border-white/[0.06] bg-white/[0.02] text-[#6b7280] hover:text-white"
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
                          <div className="text-xs text-[#6b7280]">
                            Loading candles…
                          </div>
                        ) : chartError ? (
                          <div className="text-xs text-yellow-300">
                            Failed to load candles: {chartError}
                          </div>
                        ) : !Array.isArray(chartCandles) ||
                          chartCandles.length < 2 ? (
                          <div className="text-xs text-[#6b7280]">
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

                              // Daily dedup: group by ET calendar date, keep the market-close candle (latest per day)
                              if (String(chartTf) === "D") {
                                const byDate = new Map();
                                for (const c of candles) {
                                  const etDate = new Date(c.__ts_ms - 5 * 3600 * 1000);
                                  const dateKey = `${etDate.getUTCFullYear()}-${String(etDate.getUTCMonth() + 1).padStart(2, "0")}-${String(etDate.getUTCDate()).padStart(2, "0")}`;
                                  const prev = byDate.get(dateKey);
                                  if (!prev || c.__ts_ms > prev.__ts_ms) {
                                    byDate.set(dateKey, { ...c, _dateKey: dateKey });
                                  } else {
                                    prev.h = Math.max(prev.h, c.h);
                                    prev.l = Math.min(prev.l, c.l);
                                  }
                                }
                                candles = Array.from(byDate.values()).sort((a, b) => a.__ts_ms - b.__ts_ms);
                              }

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

                              const totalCandles2 = candles.length;
                              if (totalCandles2 < 2) {
                                return (
                                  <div className="text-xs text-[#6b7280]">
                                    Candle data loaded, but not in expected OHLC format.
                                  </div>
                                );
                              }

                            // TradingView-style viewport (shared zoom/pan state)
                            const visCount2 = Math.max(10, Math.min(totalCandles2, chartVisibleCount));
                            const endIdx2 = Math.max(visCount2, totalCandles2 - chartEndOffset);
                            const startIdx2 = Math.max(0, endIdx2 - visCount2);
                            const visibleCandles2 = candles.slice(startIdx2, endIdx2);
                            const vn2 = visibleCandles2.length;
                            if (vn2 < 1) return null;


                              const lows = visibleCandles2.map((c) => Number(c.l));
                              const highs = visibleCandles2.map((c) => Number(c.h));
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
                            const ctrEl2 = chartContainerRef.current;
                            const ctrW2 = ctrEl2 ? ctrEl2.clientWidth : 500;
                            const W = ctrW2;
                            const plotW = W - leftMargin - rightMargin;
                            const plotH = H;
                            const candleStep = plotW / vn2;
                            const candleW = candleStep * 0.7;
                            const bodyW = candleW * 0.9;
                            const y = (p) => plotH - ((p - minL) / (maxH - minL)) * plotH;

                            const priceStep = (maxH - minL) / 5;
                            const priceTicks = [];
                            for (let i = 0; i <= 5; i++) {
                              priceTicks.push(minL + priceStep * i);
                            }

                            const handleMouseMove = (e) => {
                              if (chartDragRef.current) {
                                const dx = e.clientX - chartDragRef.current.startX;
                                const cp = Math.round(dx / candleStep);
                                setChartEndOffset(Math.max(0, Math.min(totalCandles2 - visCount2, chartDragRef.current.startOffset + cp)));
                                return;
                              }
                              const rect = e.currentTarget.getBoundingClientRect();
                              if (!rect || rect.width <= 0) return;
                              const svgX = e.clientX - rect.left, svgY = e.clientY - rect.top;
                              if (svgX < leftMargin || svgX > W - rightMargin) return;
                              const idx = Math.floor(((svgX - leftMargin) / plotW) * vn2);
                              if (idx >= 0 && idx < vn2) {
                                const c = visibleCandles2[idx];
                                if (!c) return;
                                setCrosshair({ x: svgX, y: svgY, candle: c, price: minL + ((H - svgY) / plotH) * (maxH - minL) });
                              }
                            };
                            const handleMouseDown = (e) => { if (e.button !== 0) return; e.preventDefault(); chartDragRef.current = { startX: e.clientX, startOffset: chartEndOffset }; setCrosshair(null); };
                            const handleMouseUp = () => { chartDragRef.current = null; };
                            const handleWheel = (e) => {
                              e.preventDefault(); e.stopPropagation();
                              const zs = Math.max(1, Math.round(visCount2 * 0.1));
                              const nc = e.deltaY > 0 ? Math.min(totalCandles2, visCount2 + zs) : Math.max(10, visCount2 - zs);
                              const sr = e.currentTarget.getBoundingClientRect();
                              const mxf = (e.clientX - sr.left - leftMargin) / plotW;
                              const cum = startIdx2 + Math.round(mxf * vn2);
                              const nl = Math.max(0, Math.min(totalCandles2 - nc, cum - Math.round(mxf * nc)));
                              setChartVisibleCount(nc); setChartEndOffset(Math.max(0, totalCandles2 - nl - nc));
                            };
                            // OHLC header
                            const hc2 = crosshair?.candle || visibleCandles2[vn2 - 1];
                            const hO2 = Number(hc2?.o), hH2 = Number(hc2?.h), hL2 = Number(hc2?.l), hC2 = Number(hc2?.c);
                            const hChg2 = hC2 - hO2, hPct2 = hO2 > 0 ? (hChg2 / hO2) * 100 : 0, hUp2 = hChg2 >= 0;
                            let hTime2 = "";
                            try { const hTs = Number(hc2?.__ts_ms ?? hc2?.ts); if (Number.isFinite(hTs)) { const d = new Date(hTs); const isDWM = ["D","W","M"].includes(String(chartTf)); hTime2 = isDWM ? d.toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"America/New_York"}) : d.toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZone:"America/New_York"})+" ET"; } } catch {}

                            return (
                              <div className="w-full relative">
                                {/* TradingView-style OHLC header */}
                                <div className="flex items-center gap-2 mb-0.5 text-[10px] font-mono h-5 select-none">
                                  <span className="text-[#6b7280]">{hTime2}</span>
                                  <span className="text-[#6b7280]">O</span><span className="text-white">{hO2.toFixed(2)}</span>
                                  <span className="text-[#6b7280]">H</span><span className="text-sky-300">{hH2.toFixed(2)}</span>
                                  <span className="text-[#6b7280]">L</span><span className="text-orange-300">{hL2.toFixed(2)}</span>
                                  <span className="text-[#6b7280]">C</span>
                                  <span className={hUp2 ? "text-teal-400 font-semibold" : "text-rose-400 font-semibold"}>{hC2.toFixed(2)}</span>
                                  <span className={hUp2 ? "text-teal-400" : "text-rose-400"}>
                                    {hUp2 ? "+" : ""}{hChg2.toFixed(2)} ({hUp2 ? "+" : ""}{hPct2.toFixed(2)}%)
                                  </span>
                                </div>
                                <div
                                  ref={chartContainerRef}
                                  className="rounded border border-white/[0.06] bg-[#0b0e11] overflow-hidden"
                                  style={{ userSelect: "none" }}
                                >
                                  <svg
                                    width={W} height={H} viewBox={`0 0 ${W} ${H}`}
                                    style={{ display: "block", cursor: chartDragRef.current ? "grabbing" : "crosshair" }}
                                    onMouseMove={handleMouseMove}
                                    onMouseDown={handleMouseDown}
                                    onMouseUp={handleMouseUp}
                                    onMouseLeave={() => { setCrosshair(null); chartDragRef.current = null; }}
                                    onWheel={handleWheel}
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
                                  {visibleCandles2.map((c, i) => {
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

                                {/* Tooltip removed - using OHLC header bar instead */}
                                {false && crosshair && crosshair.candle ? (
                                  <div
                                    className="absolute top-2 left-2 px-3 py-2 border border-white/[0.10] rounded-2xl text-[11px] pointer-events-none z-10"
                                    style={{
                                      background: "rgba(255,255,255,0.06)",
                                      backdropFilter: "blur(24px) saturate(1.4)",
                                      WebkitBackdropFilter: "blur(24px) saturate(1.4)",
                                      boxShadow: "0 8px 32px rgba(0,0,0,0.45), inset 0 0.5px 0 rgba(255,255,255,0.08)",
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
                                      <div className="text-[#6b7280]">Price:</div>
                                      <div className="text-yellow-300 font-mono font-semibold">
                                        ${Number(crosshair.price).toFixed(2)}
                                      </div>
                                      <div className="text-[#6b7280]">O:</div>
                                      <div className="text-white font-mono">
                                        ${Number(crosshair.candle.o).toFixed(2)}
                                      </div>
                                      <div className="text-[#6b7280]">H:</div>
                                      <div className="text-sky-300 font-mono">
                                        ${Number(crosshair.candle.h).toFixed(2)}
                                      </div>
                                      <div className="text-[#6b7280]">L:</div>
                                      <div className="text-orange-300 font-mono">
                                        ${Number(crosshair.candle.l).toFixed(2)}
                                      </div>
                                      <div className="text-[#6b7280]">C:</div>
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

                                <div className="mt-2 text-[10px] text-[#6b7280] flex items-center justify-between">
                                  <span>
                                    {String(chartTf) === "D"
                                      ? "Daily"
                                      : String(chartTf) === "W"
                                        ? "Weekly"
                                        : `${chartTf}m`}{" "}
                                    • {vn2}/{totalCandles2} bars
                                  </span>
                                  <span className="text-[#555] text-[9px]">scroll to zoom • drag to pan</span>
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
                      <div className="mb-4 p-3 bg-white/[0.03] border-2 border-white/[0.06] rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-sm text-[#6b7280]">
                            Trade History
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
                        {ledgerTradesLoading ? (
                          <div className="text-xs text-[#6b7280] flex items-center gap-2">
                            <div className="loading-spinner"></div>
                            Loading trades…
                          </div>
                        ) : ledgerTradesError ? (
                          <div className="text-xs text-red-400">
                            Ledger unavailable: {ledgerTradesError}
                          </div>
                        ) : ledgerTrades.length === 0 ? (
                          <div className="text-xs text-[#6b7280]">
                            No trades found for this ticker.
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {/* Ticker P&L Summary */}
                            {(() => {
                              const openTrades = ledgerTrades.filter(t => t.status !== "WIN" && t.status !== "LOSS");
                              const closedTrades = ledgerTrades.filter(t => t.status === "WIN" || t.status === "LOSS");
                              const totalClosedPnl = closedTrades.reduce((s, t) => s + Number(t.pnl || t.pnl_pct || 0), 0);
                              const totalClosedPnlPct = closedTrades.reduce((s, t) => s + Number(t.pnl_pct || 0), 0);
                              const wins = closedTrades.filter(t => Number(t.pnl_pct || t.pnl || 0) > 0).length;
                              const losses = closedTrades.filter(t => Number(t.pnl_pct || t.pnl || 0) < 0).length;
                              const flat = closedTrades.length - wins - losses;
                              const isGain = totalClosedPnlPct >= 0;
                              return (
                                <div className="p-2.5 rounded bg-white/[0.03] border border-white/[0.08] mb-1">
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-[11px] text-[#6b7280] font-medium">
                                      {ledgerTrades.length} trade{ledgerTrades.length !== 1 ? "s" : ""}
                                      {openTrades.length > 0 && <span className="text-blue-400 ml-1">({openTrades.length} open)</span>}
                                    </span>
                                    {closedTrades.length > 0 && (
                                      <span className={`text-sm font-bold ${isGain ? "text-green-400" : "text-red-400"}`}>
                                        {isGain ? "+" : ""}{totalClosedPnlPct.toFixed(2)}%
                                      </span>
                                    )}
                                  </div>
                                  {closedTrades.length > 0 && (
                                    <div className="flex items-center gap-2 text-[10px] text-[#6b7280]">
                                      {wins > 0 && <span className="text-green-400">{wins}W</span>}
                                      {losses > 0 && <span className="text-red-400">{losses}L</span>}
                                      {flat > 0 && <span className="text-[#6b7280]">{flat} flat</span>}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}

                            {/* All trades unified (open + closed, newest first) */}
                            {ledgerTrades.slice(0, 8).map((t) => {
                              const trimmedPct = Number(t.trimmed_pct || t.trimmedPct || 0);
                              const isClosed =
                                t.status === "WIN" ||
                                t.status === "LOSS" ||
                                t.status === "FLAT" ||
                                trimmedPct >= 0.9999;
                              const rawExitPrice = Number(t.exit_price || 0);
                              const exitPriceMissing = isClosed && rawExitPrice <= 0;
                              const pnl = exitPriceMissing ? 0 : Number(t.pnl || 0);
                              const pnlPct = exitPriceMissing ? 0 : Number(t.pnl_pct || 0);
                              const entryPrice = Number(t.entry_price || 0);
                              const exitPrice = rawExitPrice;
                              const trimPrice = Number(t.trim_price || 0);
                              const trimTs = t.trim_ts;
                              const hasTrimmed = trimmedPct > 0;
                              
                              // Qty fields (enriched by backend from positions table)
                              const remainingQty = Number(t.quantity ?? t.shares ?? 0);
                              const entryQty = hasTrimmed && trimmedPct < 1 && remainingQty > 0
                                ? Math.round(remainingQty / (1 - trimmedPct) * 100) / 100
                                : remainingQty;
                              const trimmedQty = hasTrimmed ? Math.round((entryQty * trimmedPct) * 100) / 100 : 0;
                              
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
                                return dir === "LONG"
                                  ? ((exitPrice - entryPrice) / entryPrice) * 100
                                  : ((entryPrice - exitPrice) / entryPrice) * 100;
                              })();
                              const isFlat = isClosed && Math.abs(computedPnlPct) < 0.01;
                              
                              // Status label — FLAT if backend says so OR computed P&L ~ 0
                              const statusLabel = exitPriceMissing ? "ERROR" : (t.status === "FLAT" || isFlat) ? "FLAT" : t.status === "WIN" ? "WIN" : t.status === "LOSS" ? "LOSS" : null;
                              const statusCls = exitPriceMissing
                                ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                                : (t.status === "FLAT" || isFlat)
                                ? "bg-[#6b7280]/20 text-[#9ca3af] border border-[#6b7280]/30"
                                : t.status === "WIN"
                                  ? "bg-green-500/20 text-green-400 border border-green-500/30"
                                  : t.status === "LOSS"
                                    ? "bg-red-500/20 text-red-400 border border-red-500/30"
                                    : null;
                              
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
                              
                              return (
                                <div
                                  key={t.trade_id}
                                  className="p-2.5 bg-white/[0.02] border border-white/[0.06] rounded"
                                >
                                  {/* Header row: Status | Direction | P&L */}
                                  <div className="flex items-center justify-between mb-1.5">
                                    <div className="flex items-center gap-1.5">
                                      {isClosed ? (
                                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${statusCls}`}>
                                          {statusLabel}
                                        </span>
                                      ) : (
                                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-blue-500/15 text-blue-300 border border-blue-500/30">
                                          OPEN
                                        </span>
                                      )}
                                      <span className={`text-[11px] font-semibold ${t.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>
                                        {t.direction}
                                      </span>
                                      {entryQty > 0 && (
                                        <span className="text-[9px] text-[#6b7280]">
                                          {entryQty % 1 === 0 ? entryQty : entryQty.toFixed(2)} shares
                                        </span>
                                      )}
                                      {hasTrimmed && (
                                        <span className="px-1 py-0.5 rounded text-[8px] font-semibold bg-yellow-500/20 text-yellow-300 border border-yellow-500/30">
                                          {Math.round(trimmedPct * 100)}% trimmed{trimmedQty > 0 ? ` (${trimmedQty % 1 === 0 ? trimmedQty : trimmedQty.toFixed(2)} sh)` : ""}
                                        </span>
                                      )}
                                      {exitReasonLabel && (
                                        <span className="px-1 py-0.5 rounded text-[8px] font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30" title={exitReasonRaw}>
                                          {exitReasonLabel}
                                        </span>
                                      )}
                                      {duration && (
                                        <span className="text-[9px] text-[#4b5563]">{duration}</span>
                                      )}
                                    </div>
                                    {isClosed && (
                                      <span className={`text-xs font-bold ${
                                        isFlat ? "text-[#6b7280]" : computedPnlPct >= 0 ? "text-green-400" : "text-red-400"
                                      }`}>
                                        {computedPnlPct >= 0 ? "+" : ""}{computedPnlPct.toFixed(2)}%
                                      </span>
                                    )}
                                  </div>
                                  
                                  {/* Current Price + Daily Change for open trades (admin only) */}
                                  {!isClosed && document.body.dataset.userRole === "admin" && (() => {
                                    const src = priceSrc;
                                    const cp = Number(src?.currentPrice ?? src?.cp ?? 0);
                                    const dayPct = Number(src?.dayPct ?? src?.dailyChangePct ?? 0);
                                    const dayChg = Number(src?.dayChg ?? src?.dailyChange ?? 0);
                                    const slVal = Number(src?.sl ?? t?.sl ?? 0);
                                    const tpVal = Number(src?.tp ?? t?.tp ?? 0);
                                    const isLong = String(t.direction || "").toUpperCase() === "LONG";
                                    const dayUp = dayPct >= 0;
                                    return (
                                      <div className="mb-1.5">
                                        {/* Current price + daily change */}
                                        <div className="flex items-center justify-between mb-1">
                                          <span className="text-[10px] text-[#6b7280]">Current</span>
                                          <div className="flex items-center gap-1.5">
                                            <span className="text-xs text-white font-bold">{cp > 0 ? `$${cp.toFixed(2)}` : "—"}</span>
                                            <span className={`text-[10px] font-semibold ${dayUp ? "text-teal-400" : "text-rose-400"}`}>
                                              {dayUp ? "+" : ""}{dayPct.toFixed(2)}%
                                              {Number.isFinite(dayChg) && dayChg !== 0 ? ` ($${Math.abs(dayChg).toFixed(2)})` : ""}
                                            </span>
                                          </div>
                                        </div>
                                        {/* SL/TSL / TP / Entry row */}
                                        {(() => {
                                          const slOrigVal = Number(t?.sl_original ?? src?.position_sl_original ?? 0);
                                          const slTrailing = slOrigVal > 0 && slVal > 0 && Math.abs(slVal - slOrigVal) / slOrigVal > 0.005;
                                          return (
                                            <div className="flex items-center justify-between text-[10px] mb-1">
                                              <span>
                                                <span className="text-rose-400" title={slTrailing ? "Trailing Stop Loss" : "Stop Loss"}>{slTrailing ? "TSL" : "SL"}</span>{" "}
                                                <span className="text-white font-medium">{slVal > 0 ? `$${slVal.toFixed(2)}` : "—"}</span>
                                              </span>
                                              <span><span className="text-[#6b7280]">EP</span> <span className="text-white font-medium">${entryPrice > 0 ? entryPrice.toFixed(2) : "—"}</span></span>
                                              <span><span className="text-teal-400">TP</span> <span className="text-white font-medium">{tpVal > 0 ? `$${tpVal.toFixed(2)}` : "—"}</span></span>
                                            </div>
                                          );
                                        })()}
                                        {/* Mini progress bar SL → EP → TP */}
                                        {slVal > 0 && tpVal > 0 && cp > 0 && entryPrice > 0 && (() => {
                                          const lo = Math.min(slVal, tpVal);
                                          const hi = Math.max(slVal, tpVal);
                                          const range = hi - lo;
                                          if (range <= 0) return null;
                                          // For SHORT: mirror so SL=left, TP=right (progress toward target)
                                          const rawCpPct = Math.max(0, Math.min(100, ((cp - lo) / range) * 100));
                                          const rawEpPct = Math.max(0, Math.min(100, ((entryPrice - lo) / range) * 100));
                                          const cpPct = isLong ? rawCpPct : (100 - rawCpPct);
                                          const epPct = isLong ? rawEpPct : (100 - rawEpPct);
                                          const isProfit = isLong ? cp >= entryPrice : cp <= entryPrice;
                                          return (
                                            <div className="relative h-2 rounded-full bg-white/[0.06] border border-white/[0.08] overflow-visible">
                                              {/* SL-to-TP fill */}
                                              <div className={`absolute top-0 bottom-0 left-0 rounded-full ${isProfit ? "bg-teal-500/50" : "bg-rose-500/40"}`} style={{width: `${cpPct}%`}} />
                                              {/* EP marker */}
                                              <div className="absolute top-[-2px] bottom-[-2px] w-[2px] bg-white/60 rounded" style={{left: `${epPct}%`}} title={`Entry $${entryPrice.toFixed(2)}`} />
                                              {/* CP marker */}
                                              <div className={`absolute top-[-3px] w-[6px] h-[6px] rounded-full border ${isProfit ? "bg-teal-400 border-teal-300" : "bg-rose-400 border-rose-300"}`} style={{left: `calc(${cpPct}% - 3px)`, top: "-1px"}} title={`Current $${cp.toFixed(2)}`} />
                                            </div>
                                          );
                                        })()}
                                      </div>
                                    );
                                  })()}

                                  {/* Compact details grid */}
                                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                                    <div className="flex justify-between">
                                      <span className="text-[#6b7280]">Entry:</span>
                                      <span className="text-white font-medium">${entryPrice > 0 ? entryPrice.toFixed(2) : "—"}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-[#6b7280]">Date:</span>
                                      <span className="text-[#9ca3af]">{formatDateTime(t.entry_ts)}</span>
                                    </div>
                                    
                                    {/* Qty row for open trades */}
                                    {!isClosed && remainingQty > 0 && (
                                      <div className="flex justify-between col-span-2">
                                        <span className="text-[#6b7280]">Qty:</span>
                                        <span className="text-white font-medium">
                                          {remainingQty % 1 === 0 ? remainingQty : remainingQty.toFixed(2)} shares
                                          {hasTrimmed && <span className="text-yellow-400 ml-1">({Math.round(trimmedPct * 100)}% trimmed)</span>}
                                        </span>
                                      </div>
                                    )}
                                    
                                    {/* Trim row */}
                                    {hasTrimmed && trimPrice > 0 && (
                                      <>
                                        <div className="flex justify-between">
                                          <span className="text-yellow-500">Trim:</span>
                                          <span className="text-yellow-300 font-medium">
                                            ${trimPrice.toFixed(2)}
                                            {trimmedQty > 0 && <span className="text-yellow-400/70 ml-1">({trimmedQty % 1 === 0 ? trimmedQty : trimmedQty.toFixed(2)} sh)</span>}
                                          </span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-yellow-500">Date:</span>
                                          <span className="text-yellow-300/70">{formatDateTime(trimTs)}</span>
                                        </div>
                                      </>
                                    )}
                                    
                                    {/* Exit row */}
                                    {isClosed && (
                                      <>
                                        <div className="flex justify-between">
                                          <span className="text-[#6b7280]">Exit:</span>
                                          <span className={`font-medium ${computedPnlPct >= 0 ? "text-green-400" : "text-red-400"}`}>
                                            ${exitPrice > 0 ? exitPrice.toFixed(2) : "—"}
                                          </span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-[#6b7280]">Date:</span>
                                          <span className="text-[#9ca3af]">{formatDateTime(t.exit_ts)}</span>
                                        </div>
                                        {exitReasonLabel && (
                                          <div className="flex justify-between col-span-2">
                                            <span className="text-purple-400">Reason:</span>
                                            <span className="text-purple-300 font-medium" title={exitReasonRaw}>{exitReasonLabel}</span>
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                            {ledgerTrades.length > 8 && (
                              <div className="text-[10px] text-[#4b5563] text-center">
                                Showing 8 of {ledgerTrades.length} trades
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Completion, Phase, Dynamic ETA */}
                    </>
                  ) : null}

                  {railTab === "MODEL" ? (
                    <>
                      {(() => {
                        const ms = modelSignal;
                        const ts = ms?.ticker;
                        const ss = ms?.sector;
                        const mk = ms?.market;
                        const src = latestTicker || ticker;
                        const pm = ts || src?.pattern_match || ms?.patternMatch;
                        const kanbanMeta = src?.kanban_meta;
                        const patternBoost = src?.__pattern_boost;
                        const patternCaution = src?.__pattern_caution;

                        const hasAnyData = ts || pm || ss || mk;

                        const dirColor = (d) => d === "BULLISH" ? "text-[#00e676]" : d === "BEARISH" ? "text-red-400" : "text-slate-400";
                        const dirBg = (d) => d === "BULLISH" ? "bg-[#00c853]/15 border-[#00c853]/30" : d === "BEARISH" ? "bg-red-500/15 border-red-500/30" : "bg-slate-500/10 border-slate-500/30";

                        const describeDir = (d, net) => {
                          if (d === "BULLISH") return net > 0.4 ? "Strong upward momentum — the model's scoring, patterns, and state all favor higher prices." : "Leaning bullish — more factors point up than down, but conviction isn't extreme.";
                          if (d === "BEARISH") return net < -0.4 ? "Strong downward pressure — the model's scoring, patterns, and state all suggest lower prices." : "Leaning bearish — more factors point down than up, but conviction isn't extreme.";
                          return "Mixed signals — no clear directional edge. The model sees roughly equal bull and bear factors.";
                        };
                        const describeSector = (regime, pct) => {
                          if (regime === "BULLISH") return `${pct}% of sector tickers are trending up — this provides a tailwind for the trade.`;
                          if (regime === "BEARISH") return `Only ${pct}% of sector tickers are bullish — the sector is a headwind.`;
                          return `The sector is mixed with no strong trend — neither helping nor hurting.`;
                        };
                        const describeMarket = (sig, pct) => {
                          if (!sig) return "";
                          if (sig.includes("STRONG_BULL")) return `Broad market rally with ${pct}% of all tickers bullish — a rising tide lifting most boats.`;
                          if (sig.includes("MILD_BULL")) return `Market leaning up with ${pct}% bullish — a modest tailwind.`;
                          if (sig.includes("STRONG_BEAR")) return `Broad market weakness with only ${pct}% bullish — most stocks are under pressure.`;
                          if (sig.includes("MILD_BEAR")) return `Market leaning down with ${pct}% bullish — a mild headwind.`;
                          return `Market is neutral — no strong broad trend either way.`;
                        };

                        const direction = ts?.direction || pm?.direction || null;
                        const netSignal = ts?.netSignal || pm?.netSignal || 0;

                        return (
                          <div className="space-y-3">
                            {/* Ticker-Level Signal */}
                            <div className={`p-3 rounded-lg border ${dirBg(direction)}`}>
                              <div className="flex items-center justify-between mb-1.5">
                                <span className="text-sm font-bold text-[#6b7280]">Ticker Signal</span>
                                {direction && <span className={`text-xs font-bold px-2 py-0.5 rounded ${direction === "BULLISH" ? "bg-green-500/20 text-green-400" : direction === "BEARISH" ? "bg-red-500/20 text-red-400" : "bg-slate-500/15 text-slate-400"}`}>{direction}</span>}
                              </div>
                              {(ts || pm) ? (
                                <>
                                  <div className="text-[11px] text-slate-300/80 italic mb-2 leading-snug">{describeDir(direction, netSignal)}</div>
                                  <div className="space-y-1.5 text-[11px]">
                                    <div className="flex justify-between items-center">
                                      <span className="text-[#6b7280]" title="Overall conviction score from -1 (strongly bearish) to +1 (strongly bullish). Combines pattern matching with the ticker's current scoring state.">Net Signal</span>
                                      <span className={`font-bold ${netSignal > 0 ? "text-[#00e676]" : netSignal < 0 ? "text-red-400" : "text-slate-300"}`}>{netSignal > 0 ? "+" : ""}{netSignal.toFixed(2)}</span>
                                    </div>
                                    {(ts?.bullPatterns != null || pm?.bullCount != null) && (
                                      <div className="flex justify-between items-center">
                                        <span className="text-[#6b7280]" title="How many historical winning patterns (bull vs bear) currently match this ticker's setup.">Patterns Matched</span>
                                        <span className="text-white font-semibold">{ts?.bullPatterns || pm?.bullCount || 0} bull / {ts?.bearPatterns || pm?.bearCount || 0} bear</span>
                                      </div>
                                    )}
                                    {ts?.stateSignal != null && (
                                      <div className="flex justify-between items-center">
                                        <span className="text-[#6b7280]" title="Signal derived from the ticker's current quadrant (HTF/LTF state), kanban stage, and HTF score. Independent of pattern matching.">State Signal</span>
                                        <span className={`font-semibold ${ts.stateSignal > 0 ? "text-green-400" : ts.stateSignal < 0 ? "text-red-400" : "text-slate-400"}`}>{ts.stateSignal > 0 ? "+" : ""}{ts.stateSignal.toFixed(2)}</span>
                                      </div>
                                    )}
                                    {ts?.state && (
                                      <div className="flex justify-between items-center">
                                        <span className="text-[#6b7280]">State</span>
                                        <span className="text-white text-[10px]">{ts.state.replace(/_/g, " ")}</span>
                                      </div>
                                    )}
                                    {ts?.kanbanStage && (
                                      <div className="flex justify-between items-center">
                                        <span className="text-[#6b7280]">Stage</span>
                                        <span className="text-white capitalize">{ts.kanbanStage.replace(/_/g, " ")}</span>
                                      </div>
                                    )}
                                  </div>
                                  {patternBoost && (
                                    <div className="mt-2 p-2 rounded bg-[#00c853]/20 border border-[#00c853]/40 text-[11px] text-[#69f0ae]">Entry confidence boosted to <strong>{patternBoost}</strong> by pattern match</div>
                                  )}
                                  {patternCaution && (
                                    <div className="mt-2 p-2 rounded bg-amber-900/20 border border-amber-700/40 text-[11px] text-amber-300">Caution: strong bear patterns detected (confidence: {patternCaution})</div>
                                  )}
                                </>
                              ) : (
                                <div className="text-[11px] text-slate-400/80 italic leading-snug">
                                  No ticker-level signal available yet. The model evaluates {tickerSymbol} against 17+ patterns every scoring cycle — matches appear when the ticker's state and indicators align with historically profitable setups.
                                </div>
                              )}
                            </div>

                            {/* Sector + Market */}
                            {(ss || (mk && (mk.totalTickers || 0) > 5)) && (
                              <div className="grid grid-cols-2 gap-2">
                                {ss && (
                                  <div className={`p-2.5 rounded-lg border ${ss.regime === "BULLISH" ? "bg-green-500/10 border-green-500/30" : ss.regime === "BEARISH" ? "bg-red-500/10 border-red-500/30" : "bg-slate-500/10 border-slate-500/30"}`}>
                                    <div className="text-[9px] text-slate-400 uppercase font-bold mb-0.5">Sector</div>
                                    <div className="text-[11px] font-bold text-white truncate">{ss.sector}</div>
                                    <div className="text-[10px] text-slate-400 mt-0.5">{ss.breadthBullPct}% bullish · {ss.regime}</div>
                                    <div className="text-[9px] text-slate-400/70 italic mt-1 leading-snug">{describeSector(ss.regime, ss.breadthBullPct)}</div>
                                  </div>
                                )}
                                {mk && (mk.totalTickers || 0) > 5 && (
                                  <div className={`p-2.5 rounded-lg border ${mk.signal?.includes("BULL") ? "bg-green-500/10 border-green-500/30" : mk.signal?.includes("BEAR") ? "bg-red-500/10 border-red-500/30" : "bg-slate-500/10 border-slate-500/30"}`}>
                                    <div className="text-[9px] text-slate-400 uppercase font-bold mb-0.5">Market</div>
                                    <div className={`text-[11px] font-bold ${mk.signal?.includes("BULL") ? "text-[#00e676]" : mk.signal?.includes("BEAR") ? "text-red-400" : "text-slate-300"}`}>{mk.signal?.replace(/_/g, " ")}</div>
                                    <div className="text-[10px] text-slate-400 mt-0.5">{mk.breadthBullPct}% breadth</div>
                                    <div className="text-[9px] text-slate-400/70 italic mt-1 leading-snug">{describeMarket(mk.signal, mk.breadthBullPct)}</div>
                                  </div>
                                )}
                              </div>
                            )}
                            {mk?.riskFlag && (mk.totalTickers || 0) > 5 && (
                              <div className="p-2 text-[11px] text-amber-300/80 bg-amber-500/10 border border-amber-500/20 rounded-lg">{mk.riskFlag}</div>
                            )}

                            {/* Matched Patterns Detail */}
                            {pm && pm.matched && pm.matched.length > 0 && (
                              <div className="p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg">
                                <div className="text-sm font-bold text-[#6b7280] mb-2">Matched Patterns</div>
                                <div className="text-[10px] text-slate-400/70 mb-2">These are historical setups that match the current conditions for {tickerSymbol}.</div>
                                <div className="space-y-1.5">
                                  {pm.matched.map((m, i) => (
                                    <div key={m.id || i} className="flex items-center justify-between bg-[#0d1117] rounded-lg p-2 border border-[#1e2530]">
                                      <div className="flex-1 min-w-0">
                                        <div className="text-xs font-semibold text-white truncate">{m.name}</div>
                                      </div>
                                      <div className="flex items-center gap-2 shrink-0 ml-2">
                                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${m.dir === "UP" ? "bg-[#00c853]/50 text-[#69f0ae]" : "bg-red-900/50 text-red-300"}`}>{m.dir === "UP" ? "Bull" : "Bear"}</span>
                                        <span className="text-[10px] text-[#6b7280]">{(m.conf * 100).toFixed(0)}%</span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Kanban Meta */}
                            {kanbanMeta && kanbanMeta.patternMatch && (
                              <div className="p-2.5 bg-blue-500/10 border border-blue-500/25 rounded-lg">
                                <div className="text-[11px] text-blue-300">This ticker was promoted to Setup by the pattern recognition engine — historical pattern matches triggered the stage advance.</div>
                              </div>
                            )}

                            {/* Explainer when nothing loaded yet */}
                            {!hasAnyData && (
                              <div className="p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg space-y-2">
                                <div className="text-sm font-bold text-[#6b7280]">How the Model Works</div>
                                <div className="text-[11px] text-slate-400/80 leading-relaxed space-y-1.5">
                                  <p>Every scoring cycle, the system evaluates {tickerSymbol} across three levels:</p>
                                  <p><span className="text-white font-semibold">Ticker:</span> Matches the current setup (state, scores, indicators) against 17+ historical winning patterns and computes a net bullish/bearish signal.</p>
                                  <p><span className="text-white font-semibold">Sector:</span> Measures how many tickers in the same sector are trending bullish — providing context on whether the sector is a tailwind or headwind.</p>
                                  <p><span className="text-white font-semibold">Market:</span> Reads the broad market breadth to gauge whether conditions favor risk-on or risk-off positioning.</p>
                                  <p className="text-[10px] text-slate-500 pt-1">Signals appear once the scoring data is loaded. If this is empty, the model endpoint may be temporarily unavailable.</p>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </>
                  ) : null}

                  {railTab === "JOURNEY" ? (
                    <>
                      {/* Performance Overview — powered by daily candle closes */}
                      {(() => {
                        if (candlePerfLoading) {
                          return (
                            <div className="mb-4 p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg text-xs text-[#6b7280] flex items-center gap-2">
                              <div className="loading-spinner"></div>
                              Loading performance…
                            </div>
                          );
                        }

                        const perf = candlePerf?.performance;
                        if (!perf || Object.keys(perf).length === 0) {
                          return (
                            <div className="mb-4 p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg text-xs text-[#6b7280]">
                              Performance data unavailable.
                            </div>
                          );
                        }

                        const sym = String(ticker.ticker).toUpperCase();
                        const periods = [
                          { label: '1D', key: '1D' },
                          { label: '5D', key: '5D' },
                          { label: '15D', key: '15D' },
                          { label: '30D', key: '30D' },
                          { label: '90D', key: '90D' },
                        ];

                        const available = periods
                          .map(p => ({ ...p, data: perf[p.key] }))
                          .filter(p => p.data);

                        if (available.length === 0) return null;

                        const dir = String(ticker.direction || "").toUpperCase();
                        const stage = String(ticker.kanban_stage || "").toLowerCase().replace(/_/g, " ");
                        const isLong = dir === "LONG" || dir === "BULLISH";
                        const isShort = dir === "SHORT" || dir === "BEARISH";

                        const getInterpretation = (changePct, isUp, label) => {
                          const absChg = Math.abs(changePct);
                          const aligned = (isLong && isUp) || (isShort && !isUp);
                          const against = (isLong && !isUp) || (isShort && isUp);

                          let momentum;
                          if (absChg < 2) momentum = "relatively flat";
                          else if (absChg < 5) momentum = isUp ? "modestly higher" : "modestly lower";
                          else if (absChg < 10) momentum = isUp ? "solidly higher" : "notably lower";
                          else if (absChg < 20) momentum = isUp ? "sharply higher" : "sharply lower";
                          else momentum = isUp ? "surging" : "plunging";

                          let base = `${sym} is ${momentum} over ${label} (${isUp ? "+" : ""}${changePct.toFixed(1)}%).`;

                          if (aligned && absChg >= 2) {
                            base += ` This aligns with the ${dir} thesis${stage ? ` — currently in "${stage}" stage` : ""}.`;
                          } else if (against && absChg >= 3) {
                            base += ` This moves against the ${dir} thesis${stage ? ` — "${stage}" stage may need reassessment` : ""}.`;
                          } else if (absChg < 2) {
                            base += stage ? ` Consolidating in "${stage}" stage — waiting for a catalyst.` : " Price is consolidating.";
                          }
                          return base;
                        };

                        return (
                          <div className="mb-4 space-y-3">
                            {available.map(({ label, data }) => {
                              const { changePct, changePoints, isUp, actualDays } = data;
                              return (
                                <div
                                  key={label}
                                  className="p-3 bg-white/[0.03] border-2 border-white/[0.06] rounded-lg"
                                >
                                  <div className="flex items-center justify-between mb-2">
                                    <div>
                                      <span className="text-xs font-bold text-[#6b7280]">{label}</span>
                                      {actualDays != null && (
                                        <span className="ml-1.5 text-[10px] text-[#4b5563]">({actualDays}d ago)</span>
                                      )}
                                    </div>
                                    <div className="text-right">
                                      <div className={`text-lg font-bold ${isUp ? 'text-green-400' : 'text-red-400'}`}>
                                        {isUp ? '+' : ''}{changePct.toFixed(2)}%
                                      </div>
                                      <div className={`text-xs ${isUp ? 'text-green-300/70' : 'text-red-300/70'}`}>
                                        {isUp ? '+' : ''}${changePoints.toFixed(2)} pts
                                      </div>
                                    </div>
                                  </div>
                                  <div className="text-xs text-[#cbd5ff] leading-relaxed bg-white/[0.02] p-2 rounded border border-white/[0.06]/50">
                                    {getInterpretation(changePct, isUp, label)}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}

                      {/* Bubble Journey */}
                      <div className="mb-4 p-3 bg-white/[0.03] border-2 border-white/[0.06] rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-sm font-bold text-[#6b7280]">
                            Scoring Timeline
                          </div>
                          {window._ttIsPro ? (
                            <a
                              href={`index-react.html?timeTravel=1&ticker=${encodeURIComponent(String(tickerSymbol).toUpperCase())}`}
                              className="text-xs px-2 py-1 rounded bg-purple-500/20 border border-purple-500/30 text-purple-300 hover:bg-purple-500/30"
                              title="Open Time Travel"
                            >
                              Time Travel
                            </a>
                          ) : (
                            <button
                              type="button"
                              onClick={() => window.dispatchEvent(new CustomEvent("tt-go-pro"))}
                              className="text-xs px-2 py-1 rounded bg-amber-500/20 border border-amber-500/30 text-amber-300 hover:bg-amber-500/30"
                              title="Time Travel — Pro feature"
                            >
                              Time Travel Pro
                            </button>
                          )}
                        </div>

                        {bubbleJourneyLoading ? (
                          <div className="text-xs text-[#6b7280] flex items-center gap-2"><div className="loading-spinner"></div>Loading trail…</div>
                        ) : bubbleJourneyError ? (
                          <div className="text-xs text-red-400">Trail unavailable: {bubbleJourneyError}</div>
                        ) : bubbleJourney.length === 0 ? (
                          <div className="text-xs text-[#6b7280]">No trail points found for this ticker.</div>
                        ) : (
                          <div className="space-y-0.5 max-h-72 overflow-y-auto pr-1">
                            {(() => {
                              const translateState = (raw) => {
                                const map = {
                                  "HTF_BULL_LTF_BULL": "Fully Bullish",
                                  "HTF_BULL_LTF_PULLBACK": "Bullish, pulling back",
                                  "HTF_BULL_LTF_BEAR": "Bullish trend, bearish momentum",
                                  "HTF_BEAR_LTF_BEAR": "Fully Bearish",
                                  "HTF_BEAR_LTF_PULLBACK": "Bearish, bouncing",
                                  "HTF_BEAR_LTF_BULL": "Bear trend, bullish momentum",
                                };
                                return map[raw] || (raw || "—").replace(/_/g, " ");
                              };
                              const translateStage = (raw) => {
                                const map = {
                                  "watch": "Watch", "flip_watch": "Flip Watch", "just_flipped": "Just Flipped",
                                  "setup": "Setup", "enter": "Enter", "enter_now": "Enter Now",
                                  "just_entered": "Just Entered", "hold": "Hold", "defend": "Defend",
                                  "trim": "Trim", "exit": "Exit", "parked": "Parked",
                                };
                                return map[String(raw || "").toLowerCase()] || raw || "";
                              };
                              const fmtShortDate = (ms) => {
                                if (!Number.isFinite(ms)) return "—";
                                const d = new Date(ms);
                                const mo = d.toLocaleString("en-US", { month: "short" });
                                const day = d.getDate();
                                const h = d.getHours();
                                const m = String(d.getMinutes()).padStart(2, "0");
                                const ampm = h >= 12 ? "PM" : "AM";
                                const h12 = h % 12 || 12;
                                return `${mo} ${day}, ${h12}:${m} ${ampm}`;
                              };
                              const fmtDuration = (ms) => {
                                if (!Number.isFinite(ms) || ms <= 0) return "";
                                const mins = Math.round(ms / 60000);
                                if (mins < 60) return `${mins}m`;
                                const hrs = Math.floor(mins / 60);
                                const rm = mins % 60;
                                if (hrs < 24) return rm > 0 ? `${hrs}h ${rm}m` : `${hrs}h`;
                                const days = Math.floor(hrs / 24);
                                const rh = hrs % 24;
                                return rh > 0 ? `${days}d ${rh}h` : `${days}d`;
                              };

                              const sampled = downsampleByInterval(bubbleJourney, 15 * 60 * 1000).slice().reverse().slice(0, 80);
                              const deduped = [];
                              let prev = null;
                              for (const p of sampled) {
                                if (!prev) { deduped.push(p); prev = p; continue; }
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
                              const allPoints = deduped.slice(0, 60);

                              const groups = [];
                              for (const p of allPoints) {
                                const key = `${p.state || ""}|${p.kanban_stage || ""}`;
                                const last = groups.length > 0 ? groups[groups.length - 1] : null;
                                if (last && last.key === key) {
                                  last.points.push(p);
                                } else {
                                  groups.push({ key, points: [p] });
                                }
                              }

                              return groups.map((g, gIdx) => {
                                const first = g.points[0];
                                const last = g.points[g.points.length - 1];
                                const rawState = first.state || first.quadrant || first.zone || "";
                                const stateLabel = translateState(rawState);
                                const stageLabel = translateStage(first.kanban_stage);

                                const firstTs = Number(first.__ts_ms);
                                const lastTs = Number(last.__ts_ms);
                                const isSingle = g.points.length === 1;
                                const duration = Math.abs(firstTs - lastTs);

                                const scores = g.points.map(p => Number(p.rank)).filter(Number.isFinite);
                                const minScore = scores.length > 0 ? Math.min(...scores) : null;
                                const maxScore = scores.length > 0 ? Math.max(...scores) : null;
                                const scoreStr = minScore != null ? (minScore === maxScore ? String(minScore) : `${minScore}–${maxScore}`) : "—";

                                const htfs = g.points.map(p => Number(p.htf_score)).filter(Number.isFinite);
                                const ltfs = g.points.map(p => Number(p.ltf_score)).filter(Number.isFinite);
                                const htfStr = htfs.length > 0 ? (Math.min(...htfs).toFixed(1) === Math.max(...htfs).toFixed(1) ? htfs[0].toFixed(1) : `${Math.min(...htfs).toFixed(1)} to ${Math.max(...htfs).toFixed(1)}`) : "—";
                                const ltfStr = ltfs.length > 0 ? (Math.min(...ltfs).toFixed(1) === Math.max(...ltfs).toFixed(1) ? ltfs[0].toFixed(1) : `${Math.min(...ltfs).toFixed(1)} to ${Math.max(...ltfs).toFixed(1)}`) : "—";

                                const prevGroup = gIdx > 0 ? groups[gIdx - 1] : null;
                                const transitions = [];
                                if (prevGroup) {
                                  const pFirst = prevGroup.points[0];
                                  const prevRawState = pFirst.state || pFirst.quadrant || pFirst.zone || "";
                                  const prevRawStage = pFirst.kanban_stage || "";
                                  if (rawState !== prevRawState) transitions.push(`${translateState(prevRawState)} → ${stateLabel}`);
                                  if ((first.kanban_stage || "") !== prevRawStage) transitions.push(`${translateStage(prevRawStage)} → ${stageLabel}`);
                                }

                                const latestPointForChart = {
                                  ts: Number.isFinite(firstTs) ? firstTs : null,
                                  htf_score: first.htf_score != null ? Number(first.htf_score) : null,
                                  ltf_score: first.ltf_score != null ? Number(first.ltf_score) : null,
                                  phase_pct: first.phase_pct != null ? Number(first.phase_pct) : null,
                                  completion: first.completion != null ? Number(first.completion) : null,
                                  rank: first.rank != null ? Number(first.rank) : null,
                                  rr: first.rr != null ? Number(first.rr) : null,
                                  state: first.state || null,
                                };
                                const isSelected = selectedJourneyTs != null && g.points.some(p => Number.isFinite(Number(p.__ts_ms)) && Number(p.__ts_ms) === Number(selectedJourneyTs));

                                return (
                                  <div key={`g-${gIdx}`}>
                                    {transitions.length > 0 && (
                                      <div className="py-1 flex items-center gap-1.5">
                                        <div className="flex-1 h-px bg-cyan-500/20"></div>
                                        <span className="text-[9px] text-cyan-400/70 whitespace-nowrap">{transitions.join(" · ")}</span>
                                        <div className="flex-1 h-px bg-cyan-500/20"></div>
                                      </div>
                                    )}
                                    <div
                                      className={`px-2 py-1.5 bg-white/[0.02] border rounded cursor-pointer transition-colors ${isSelected ? "border-cyan-400/80 bg-cyan-500/10" : "border-white/[0.06] hover:border-cyan-400/40 hover:bg-[#16224a]"}`}
                                      onMouseEnter={() => { if (onJourneyHover) onJourneyHover(latestPointForChart); }}
                                      onMouseLeave={() => { if (onJourneyHover) onJourneyHover(null); }}
                                      onClick={() => { if (onJourneySelect) onJourneySelect(latestPointForChart); }}
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="min-w-0">
                                          <div className="text-[10px] text-[#6b7280]">
                                            {isSingle ? fmtShortDate(firstTs) : `${fmtShortDate(firstTs)} – ${fmtShortDate(lastTs)}`}
                                            {!isSingle && duration > 0 && <span className="text-[#4b5563] ml-1">({fmtDuration(duration)})</span>}
                                          </div>
                                          <div className="text-[11px] text-white truncate">
                                            {stateLabel}
                                            {stageLabel && <span className="text-[#6b7280]"> · {stageLabel}</span>}
                                            {!isSingle && <span className="text-[#4b5563] ml-1 text-[9px]">({g.points.length} snapshots)</span>}
                                          </div>
                                        </div>
                                        <div className="text-right text-[10px] text-[#6b7280] whitespace-nowrap shrink-0">
                                          <div>Score <span className="text-white font-semibold">{scoreStr}</span></div>
                                          <div>HTF <span className="text-white font-semibold">{htfStr}</span></div>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              });
                            })()}
                          </div>
                        )}
                      </div>

                      {/* Current State Summary */}
                      <div className="mb-4 p-3 bg-white/[0.03] border border-white/[0.06] rounded-lg">
                        <div className="text-xs text-[#6b7280] mb-2 font-semibold">Where Things Stand</div>
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          <div>
                            <div className="text-[#6b7280] text-[10px]" title="How far along the current move cycle is (0% = just started, 100% = fully played out)">Phase</div>
                            <div className="text-white font-semibold" style={{ color: phaseColor }}>
                              {(phase * 100).toFixed(0)}%
                            </div>
                          </div>
                          <div>
                            <div className="text-[#6b7280] text-[10px]" title="How much of the expected price move has already happened">Completion</div>
                            <div className="text-white font-semibold">
                              {ticker.completion != null ? `${(Number(ticker.completion) * 100).toFixed(0)}%` : "—"}
                            </div>
                          </div>
                          <div>
                            <div className="text-[#6b7280] text-[10px]" title="Estimated time remaining for the current move to play out">ETA</div>
                            <div className="text-white font-semibold">
                              {(() => {
                                const eta = computeEtaDays(ticker);
                                return Number.isFinite(eta) ? `${eta.toFixed(1)}d` : "—";
                              })()}
                            </div>
                          </div>
                        </div>
                        {(() => {
                          const phasePct = Math.round(phase * 100);
                          const completionPct = ticker.completion != null ? Math.round(Number(ticker.completion) * 100) : null;
                          const eta = computeEtaDays(ticker);
                          const parts = [];
                          if (phasePct <= 25) parts.push("Still early in the move cycle");
                          else if (phasePct <= 60) parts.push(`${phasePct}% through the move`);
                          else if (phasePct <= 85) parts.push("Move is maturing");
                          else parts.push("Late stage — most of the move is behind us");
                          if (completionPct != null) {
                            if (completionPct < 30) parts.push("plenty of room left to the target");
                            else if (completionPct < 70) parts.push(`${completionPct}% of the expected move completed`);
                            else parts.push("nearing the target");
                          }
                          if (Number.isFinite(eta)) parts.push(`~${eta.toFixed(1)} days estimated remaining`);
                          return parts.length > 0 ? <div className="mt-2 text-[10px] text-slate-400/80 italic leading-snug">{parts.join(" — ")}.</div> : null;
                        })()}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>

              {/* Fixed Footer */}
              <div className="flex-shrink-0 p-6 pt-4 border-t border-white/[0.06] bg-white/[0.02]">
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
