#!/usr/bin/env node
/**
 * Replace inline TickerDetailRightRail in simulation-dashboard.html with factory call.
 */
const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "../react-app/simulation-dashboard.html");
let html = fs.readFileSync(filePath, "utf8");

const blockStart = `      // ─────────────────────────────────────────────────────────────
      // Unified Ticker Detail Right Rail Component
      // Reusable component that shows comprehensive ticker information
      // and optionally trade history if a trade is associated
      // ─────────────────────────────────────────────────────────────
      function TickerDetailRightRail({`;

const blockEnd = `        );
      }

      function TradeRow({ trade, tickerData, onTickerClick, onTradeClick }) {`;

const factoryCall = `      // Universal Right Rail (shared component from shared-right-rail.js)
      const TickerDetailRightRail = window.TickerDetailRightRailFactory({
        React,
        API_BASE,
        fmtUsd,
        fmtUsdAbs,
        getDailyChange,
        isPrimeBubble,
        entryType,
        getActionDescription,
        rankScoreForTicker,
        getRankedTickers,
        getRankPosition,
        getRankPositionFromMap,
        detectPatterns,
        normalizeTrailPoints,
        phaseToColor,
        completionForSize,
        computeHorizonBucket,
        computeEtaDays,
        computeReturnPct,
        computeRiskPct,
        computeTpTargetPrice,
        computeTpMaxPrice,
        summarizeEntryDecision,
        getDirectionFromState,
        getDirection,
        numFromAny,
        groupsForTicker,
        GROUP_ORDER,
        GROUP_LABELS,
        TRADE_SIZE,
        FUTURES_SPECS,
        getStaleInfo,
        isNyRegularMarketOpen,
        downsampleByInterval,
      });
`;

const startIdx = html.indexOf(blockStart);
if (startIdx === -1) {
  console.error("Could not find block start in simulation-dashboard");
  process.exit(1);
}
const endIdx = html.indexOf(blockEnd, startIdx);
if (endIdx === -1) {
  console.error("Could not find block end in simulation-dashboard");
  process.exit(1);
}
const before = html.slice(0, startIdx);
const after = html.slice(endIdx); // starts with "      function TradeRow..."
html = before + factoryCall + after;
fs.writeFileSync(filePath, html);
console.log("Wired Trade Tracker to use shared Right Rail");
