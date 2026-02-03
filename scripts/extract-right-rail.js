#!/usr/bin/env node
/**
 * Extracts TickerDetailRightRail from index-react.html and writes
 * react-app/shared-right-rail.js with a factory that injects deps.
 */
const fs = require("fs");
const path = require("path");

const indexPath = path.join(__dirname, "../react-app/index-react.html");
const outPath = path.join(__dirname, "../react-app/shared-right-rail.js");

const html = fs.readFileSync(indexPath, "utf8");
const lines = html.split("\n");

// Find start: "      function TickerDetailRightRail({"
let startIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("function TickerDetailRightRail({") && lines[i].trimStart().startsWith("function TickerDetailRightRail")) {
    startIdx = i;
    break;
  }
}
if (startIdx === -1) {
  console.error("Could not find TickerDetailRightRail start");
  process.exit(1);
}

// Find end: "      }" before "      // Legacy TickerDetails"
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (lines[i].includes("// Legacy TickerDetails") && lines[i].trimStart().startsWith("//")) {
    // Component ends at the previous non-empty line that is "      }"
    for (let j = i - 1; j >= startIdx; j--) {
      const t = lines[j].trim();
      if (t === "}") {
        endIdx = j;
        break;
      }
    }
    break;
  }
}
if (endIdx === -1) {
  console.error("Could not find TickerDetailRightRail end");
  process.exit(1);
}

const componentLines = lines.slice(startIdx, endIdx + 1);
// Skip first line "      function TickerDetailRightRail({" so body starts with "        ticker,"
let componentBody = componentLines.slice(1).join("\n");

// Add initialRailTab to props (after selectedJourneyTs = null,)
componentBody = componentBody.replace(
  /selectedJourneyTs = null,\s*\}\) => \{/,
  "selectedJourneyTs = null,\n        initialRailTab = null,\n      }) => {"
);

// Default to Analysis when switching tickers -> use initialRailTab when provided
componentBody = componentBody.replace(
  /\/\/ Default to Analysis when switching tickers\s*useEffect\(\(\) => \{\s*setRailTab\("ANALYSIS"\);\s*\}, \[tickerSymbol\]\);/,
  `// Default tab: use initialRailTab when provided (e.g. Trade Tracker), else Analysis when switching tickers
        useEffect(() => {
          setRailTab(initialRailTab || "ANALYSIS");
        }, [tickerSymbol, initialRailTab]);`
);

// Wrap in factory (prologue ends with "return function TickerDetailRightRail({" so body starts with "        ticker,")
const factoryPrologue = `/**
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
`;

const out = factoryPrologue + componentBody + `
  };
})();
`;

fs.writeFileSync(outPath, out, "utf8");
console.log("Wrote", outPath, "(" + out.split("\n").length + " lines)");
