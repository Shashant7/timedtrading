// ETF Holdings Auto-Sync — fetches holdings from grannyshots.com,
// stores in KV, detects rebalances, and provides weight data for scoring.

import { kvGetJSON, kvPutJSON } from "./storage.js";

// ═══════════════════════════════════════════════════════════════════════
// ETF Configuration
// ═══════════════════════════════════════════════════════════════════════

const ETF_SOURCES = {
  GRNY: {
    url: "https://grannyshots.com/grny-holdings/",
    name: "Fundstrat Granny Shots US Large Cap",
  },
  GRNJ: {
    url: "https://grannyshots.com/fundstrat-granny-shots-us-small-mid-cap-etf/grnj-holdings/",
    name: "Fundstrat Granny Shots US Small-Mid Cap",
  },
  GRNI: {
    url: "https://grannyshots.com/fundstrat-granny-shots-us-large-cap-and-income-etf/grni-holdings/",
    name: "Fundstrat Granny Shots US Large Cap & Income",
  },
};

const KV_PREFIX_HOLDINGS = "timed:etf:holdings:";
const KV_GROUPS = "timed:etf:groups";
const KV_WEIGHT_MAP = "timed:etf:weight-map";
const KV_SYNC_META = "timed:etf:sync-meta";

// ═══════════════════════════════════════════════════════════════════════
// HTML Parser — extracts holdings table from grannyshots.com pages
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse a grannyshots.com holdings page HTML into structured holdings data.
 * The table contains: Ticker | CUSIP | Name | Sector | [Type?] | Weight | Shares | Market Value | ...
 * GRNI pages include a "Type" column (Stock/Option) — we filter to Stock only.
 */
function parseHoldingsHTML(html, etfSymbol) {
  const holdings = [];
  if (!html || typeof html !== "string") return holdings;

  // Find all table rows — look for <tr> tags
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let match;
  let isHeaderFound = false;
  let hasTypeColumn = false;

  while ((match = rowRegex.exec(html)) !== null) {
    const rowHTML = match[1];

    // Check for header row to detect column structure
    if (!isHeaderFound && rowHTML.includes("<th")) {
      isHeaderFound = true;
      hasTypeColumn = /<th[^>]*>[\s\S]*?Type[\s\S]*?<\/th>/i.test(rowHTML);
      continue;
    }

    // Extract cells
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHTML)) !== null) {
      // Strip HTML tags and trim whitespace
      const text = cellMatch[1].replace(/<[^>]+>/g, "").trim();
      cells.push(text);
    }
    cellRegex.lastIndex = 0; // reset regex

    if (cells.length < 5) continue;

    // Column layout:
    // Without Type: Ticker, CUSIP, Name, Sector, Weight, Shares, MarketValue, LastPrice, Change
    // With Type:    Ticker, CUSIP, Name, Sector, Type, Weight, Shares, MarketValue, LastPrice, Change
    let ticker, name, sector, type, weightStr, sharesStr, marketValueStr;

    if (hasTypeColumn) {
      [ticker, , name, sector, type, weightStr, sharesStr, marketValueStr] = cells;
    } else {
      [ticker, , name, sector, weightStr, sharesStr, marketValueStr] = cells;
      type = "Stock";
    }

    // Skip options rows (GRNI has options like "AAPL 260220C00270000")
    if (!ticker || ticker.includes(" ") || ticker.length > 6) continue;
    if (type && type !== "Stock") continue;

    // Parse weight (e.g., "2.50%" → 2.50)
    const weight = parseFloat((weightStr || "").replace("%", ""));
    if (!Number.isFinite(weight) || weight <= 0) continue;

    // Parse shares (e.g., "392,596" → 392596)
    const shares = parseInt((sharesStr || "").replace(/,/g, ""), 10) || 0;

    // Parse market value (e.g., "$102,754,151" → 102754151)
    const marketValue = parseFloat((marketValueStr || "").replace(/[$,]/g, "")) || 0;

    holdings.push({
      ticker: ticker.toUpperCase(),
      name: name || "",
      sector: sector || "",
      weight,
      shares,
      marketValue,
    });
  }

  // If the table regex didn't find rows (some pages may use different markup),
  // try a fallback: look for lines that match the pattern "TICKER | ... | N.NN%"
  if (holdings.length === 0) {
    const lines = html.split("\n");
    for (const line of lines) {
      // Match lines like: |AAPL|037833100|Apple Inc.|Information Technology|2.50%|...
      const pipeMatch = line.match(/\|([A-Z]{1,5})\|[^|]+\|([^|]+)\|([^|]+)\|([\d.]+%)/);
      if (pipeMatch) {
        const ticker = pipeMatch[1];
        const name = pipeMatch[2].trim();
        const sector = pipeMatch[3].trim();
        const weight = parseFloat(pipeMatch[4]);
        if (ticker && Number.isFinite(weight) && weight > 0) {
          holdings.push({ ticker, name, sector, weight, shares: 0, marketValue: 0 });
        }
      }
    }
  }

  return holdings;
}

// ═══════════════════════════════════════════════════════════════════════
// Fetch & Sync
// ═══════════════════════════════════════════════════════════════════════

/**
 * Fetch and parse holdings for a single ETF from grannyshots.com.
 */
export async function fetchETFHoldings(symbol) {
  const source = ETF_SOURCES[symbol];
  if (!source) return { ok: false, error: `Unknown ETF: ${symbol}` };

  try {
    const resp = await fetch(source.url, {
      headers: {
        "User-Agent": "TimedTrading/1.0 (ETF Holdings Sync)",
        Accept: "text/html",
      },
    });

    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status} from ${source.url}` };
    }

    const html = await resp.text();
    const holdings = parseHoldingsHTML(html, symbol);

    if (holdings.length === 0) {
      return { ok: false, error: `No holdings parsed from ${source.url}` };
    }

    return {
      ok: true,
      symbol,
      name: source.name,
      holdings,
      count: holdings.length,
      fetchedAt: Date.now(),
    };
  } catch (e) {
    return { ok: false, error: `Fetch failed for ${symbol}: ${String(e).slice(0, 200)}` };
  }
}

/**
 * Detect changes between old and new holdings for rebalance alerts.
 * Returns { added, removed, reweighted, unchanged }.
 */
function diffHoldings(oldHoldings, newHoldings) {
  const oldMap = new Map((oldHoldings || []).map(h => [h.ticker, h]));
  const newMap = new Map((newHoldings || []).map(h => [h.ticker, h]));

  const added = [];
  const removed = [];
  const reweighted = [];

  // Check for new or reweighted tickers
  for (const [ticker, newH] of newMap) {
    const oldH = oldMap.get(ticker);
    if (!oldH) {
      added.push({ ticker, weight: newH.weight, name: newH.name });
    } else if (Math.abs(newH.weight - oldH.weight) >= 0.5) {
      reweighted.push({
        ticker,
        oldWeight: oldH.weight,
        newWeight: newH.weight,
        delta: +(newH.weight - oldH.weight).toFixed(2),
      });
    }
  }

  // Check for removed tickers
  for (const [ticker, oldH] of oldMap) {
    if (!newMap.has(ticker)) {
      removed.push({ ticker, weight: oldH.weight, name: oldH.name });
    }
  }

  return {
    added,
    removed,
    reweighted,
    hasChanges: added.length > 0 || removed.length > 0 || reweighted.length > 0,
  };
}

/**
 * Build a Discord embed for rebalance changes.
 */
function buildRebalanceEmbed(etfSymbol, diff) {
  const lines = [];

  if (diff.added.length > 0) {
    lines.push("**Added:**");
    for (const a of diff.added) {
      lines.push(`  + ${a.ticker} (${a.weight.toFixed(2)}%) — ${a.name}`);
    }
  }
  if (diff.removed.length > 0) {
    lines.push("**Removed:**");
    for (const r of diff.removed) {
      lines.push(`  - ${r.ticker} (was ${r.weight.toFixed(2)}%) — ${r.name}`);
    }
  }
  if (diff.reweighted.length > 0) {
    lines.push("**Reweighted (>0.5% change):**");
    for (const w of diff.reweighted) {
      const arrow = w.delta > 0 ? "+" : "";
      lines.push(`  ${w.ticker}: ${w.oldWeight.toFixed(2)}% -> ${w.newWeight.toFixed(2)}% (${arrow}${w.delta}%)`);
    }
  }

  return {
    title: `ETF Rebalance Detected: ${etfSymbol}`,
    description: lines.join("\n"),
    color: 0x00c853, // green from brand kit
    footer: { text: `Granny Shots ETF Sync` },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Sync all 3 ETFs: fetch, parse, diff, store, and optionally notify Discord.
 */
export async function syncAllETFHoldings(env, opts = {}) {
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false, error: "no_kv" };

  const start = Date.now();
  const results = {};
  const allGroups = {};
  const weightMap = {};
  const rebalanceEmbeds = [];

  for (const symbol of Object.keys(ETF_SOURCES)) {
    console.log(`[ETF SYNC] Fetching ${symbol}...`);
    const result = await fetchETFHoldings(symbol);

    if (!result.ok) {
      console.error(`[ETF SYNC] ${symbol} failed:`, result.error);
      results[symbol] = { ok: false, error: result.error };
      continue;
    }

    // Load previous holdings for diff
    const prevHoldings = await kvGetJSON(KV, `${KV_PREFIX_HOLDINGS}${symbol}`);
    const prevTickers = (prevHoldings?.holdings || []);

    // Diff for rebalance detection
    const diff = diffHoldings(prevTickers, result.holdings);
    if (diff.hasChanges) {
      console.log(`[ETF SYNC] ${symbol} rebalance detected: +${diff.added.length} -${diff.removed.length} ~${diff.reweighted.length}`);
      rebalanceEmbeds.push(buildRebalanceEmbed(symbol, diff));
    }

    // Store full holdings
    await kvPutJSON(KV, `${KV_PREFIX_HOLDINGS}${symbol}`, {
      symbol,
      name: ETF_SOURCES[symbol].name,
      holdings: result.holdings,
      count: result.count,
      syncedAt: Date.now(),
    });

    // Build groups and weight map
    allGroups[symbol] = result.holdings.map(h => h.ticker);
    for (const h of result.holdings) {
      if (!weightMap[h.ticker]) weightMap[h.ticker] = {};
      weightMap[h.ticker][symbol] = h.weight;
    }

    results[symbol] = {
      ok: true,
      count: result.count,
      rebalance: diff.hasChanges ? diff : null,
    };
  }

  // Store groups and weight map
  await kvPutJSON(KV, KV_GROUPS, allGroups);
  await kvPutJSON(KV, KV_WEIGHT_MAP, weightMap);

  // Store sync metadata
  await kvPutJSON(KV, KV_SYNC_META, {
    lastSync: Date.now(),
    elapsed: Date.now() - start,
    results,
  });

  // Send Discord notifications for rebalances
  if (rebalanceEmbeds.length > 0 && opts.notifyDiscord) {
    for (const embed of rebalanceEmbeds) {
      await opts.notifyDiscord(env, embed).catch(e =>
        console.warn("[ETF SYNC] Discord notification failed:", String(e).slice(0, 100))
      );
    }
  }

  const elapsed = Date.now() - start;
  console.log(`[ETF SYNC] Complete in ${elapsed}ms:`, JSON.stringify(results));

  return { ok: true, elapsed, results };
}

// ═══════════════════════════════════════════════════════════════════════
// Weight Lookup (for scoring)
// ═══════════════════════════════════════════════════════════════════════

// Module-level cache for the weight map (refreshed per scoring cycle)
let _etfWeightMapCache = null;
let _etfWeightMapCacheTs = 0;
const ETF_WEIGHT_CACHE_TTL = 5 * 60 * 1000; // 5 min

/**
 * Get ETF weight data for a ticker.
 * Returns { etfs: [{ symbol, weight }], maxWeight, etfCount } or null if not in any ETF.
 */
export async function getETFWeightForTicker(env, ticker) {
  const KV = env?.KV_TIMED;
  if (!KV) return null;

  // Refresh cache if stale
  if (!_etfWeightMapCache || Date.now() - _etfWeightMapCacheTs > ETF_WEIGHT_CACHE_TTL) {
    _etfWeightMapCache = (await kvGetJSON(KV, KV_WEIGHT_MAP)) || {};
    _etfWeightMapCacheTs = Date.now();
  }

  const sym = String(ticker || "").toUpperCase();
  const weights = _etfWeightMapCache[sym];
  if (!weights || typeof weights !== "object") return null;

  const etfs = Object.entries(weights).map(([symbol, weight]) => ({ symbol, weight }));
  if (etfs.length === 0) return null;

  const maxWeight = Math.max(...etfs.map(e => e.weight));
  return { etfs, maxWeight, etfCount: etfs.length };
}

/**
 * Compute the ETF weight boost for scoring.
 * - Weight >= 3%: +3
 * - Weight 2-3%: +2
 * - Weight < 2%: +1
 * - In multiple ETFs: +1 bonus
 * - Not in any ETF: 0
 */
export function computeETFWeightBoost(etfData) {
  if (!etfData || !etfData.etfs || etfData.etfs.length === 0) return 0;

  const maxWeight = etfData.maxWeight || 0;
  let boost = 0;

  if (maxWeight >= 3) boost = 3;
  else if (maxWeight >= 2) boost = 2;
  else if (maxWeight > 0) boost = 1;

  // Cross-ETF conviction bonus
  if (etfData.etfCount > 1) boost += 1;

  return boost;
}

/**
 * Load the full weight map into memory (for bulk scoring cycles).
 * Returns the raw map: { "AAPL": { GRNY: 2.50, GRNI: 2.55 }, ... }
 */
export async function loadETFWeightMap(env) {
  const KV = env?.KV_TIMED;
  if (!KV) return {};
  return (await kvGetJSON(KV, KV_WEIGHT_MAP)) || {};
}

// ═══════════════════════════════════════════════════════════════════════
// API Handlers
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /timed/etf/groups — returns { GRNY: [...], GRNJ: [...], GRNI: [...] }
 */
export async function handleGetETFGroups(env) {
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false, error: "no_kv" };

  const groups = await kvGetJSON(KV, KV_GROUPS);
  if (!groups) {
    return { ok: true, groups: {}, synced: false, message: "No ETF data synced yet. Run /timed/etf/sync first." };
  }
  return { ok: true, groups };
}

/**
 * GET /timed/etf/holdings/:symbol — returns full holdings for one ETF
 */
export async function handleGetETFHoldings(env, symbol) {
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false, error: "no_kv" };

  const sym = String(symbol || "").toUpperCase();
  if (!ETF_SOURCES[sym]) {
    return { ok: false, error: `Unknown ETF: ${sym}. Valid: ${Object.keys(ETF_SOURCES).join(", ")}` };
  }

  const data = await kvGetJSON(KV, `${KV_PREFIX_HOLDINGS}${sym}`);
  if (!data) {
    return { ok: true, symbol: sym, holdings: [], synced: false, message: "No data yet. Run /timed/etf/sync." };
  }

  return { ok: true, ...data };
}
