#!/usr/bin/env node
/**
 * Historical Bar Backfill Script (Alpaca + TwelveData)
 * Fetches historical OHLCV bars and uploads to the worker via /timed/ingest-candles.
 *
 * Usage:
 *   TIMED_API_KEY=AwesomeSauce node scripts/alpaca-backfill.js [--tf D] [--batch 30]
 *   node scripts/alpaca-backfill.js --provider twelvedata --tf D
 *   node scripts/alpaca-backfill.js --tickers AXON,TSM,ARM --tf D
 *
 * Environment:
 *   DATA_PROVIDER          - "twelvedata" (default) or "alpaca"
 *   ALPACA_API_KEY_ID      - Alpaca API Key ID
 *   ALPACA_API_SECRET_KEY  - Alpaca API Secret Key
 *   TWELVEDATA_API_KEY     - TwelveData API Key
 *   TIMED_API_KEY          - Worker API key for ingest
 *   WORKER_BASE            - Worker base URL (default: https://timed-trading-ingest.shashant.workers.dev)
 */

const ALPACA_KEY = process.env.ALPACA_API_KEY_ID || "";
const ALPACA_SECRET = process.env.ALPACA_API_SECRET_KEY || "";
const TD_KEY = process.env.TWELVEDATA_API_KEY || "";
const TIMED_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";
const WORKER_BASE = process.env.WORKER_BASE || "https://timed-trading-ingest.shashant.workers.dev";

const ALPACA_STOCKS_BASE = "https://data.alpaca.markets/v2";
const ALPACA_CRYPTO_BASE = "https://data.alpaca.markets/v1beta3/crypto/us";
const TD_BASE = "https://api.twelvedata.com";

const { SECTOR_MAP } = require("../worker/sector-mapping.js");
const ALL_TICKERS = [...new Set(Object.keys(SECTOR_MAP))];

const CRYPTO_MAP = { "BTCUSD": "BTC/USD", "ETHUSD": "ETH/USD" };
const CRYPTO_TICKERS = new Set(Object.keys(CRYPTO_MAP));

const STOCK_SYM_MAP = { "BRK-B": "BRK.B" };
const REVERSE_STOCK_MAP = Object.fromEntries(Object.entries(STOCK_SYM_MAP).map(([k, v]) => [v, k]));

// ═══════════════════════════════════════════════════════════════════════
// Timeframe configs per provider
// ═══════════════════════════════════════════════════════════════════════

const TF_CONFIGS = {
  "M":   { alpaca: "1Month", td: "1month", daysBack: 365 * 10, limit: 10000, tdSize: 5000 },
  "W":   { alpaca: "1Week",  td: "1week",  daysBack: 365 * 6,  limit: 10000, tdSize: 5000 },
  "D":   { alpaca: "1Day",   td: "1day",   daysBack: 450,       limit: 10000, tdSize: 5000 },
  "240": { alpaca: "4Hour",  td: "4h",     daysBack: 450,       limit: 10000, tdSize: 5000 },
  "60":  { alpaca: "1Hour",  td: "1h",     daysBack: 450,       limit: 10000, tdSize: 5000 },
  "30":  { alpaca: "30Min",  td: "30min",  daysBack: 450,       limit: 10000, tdSize: 5000 },
  "10":  { alpaca: "10Min",  td: "5min",   daysBack: 450,       limit: 10000, tdSize: 5000, aggregate10m: true },
};

// Replay uses M,W,D,240,60,30,10 only. 5m is for live cron (rolling fetch). 1m not used.
const TF_ORDER = ["M", "W", "D", "240", "60", "30", "10"];

// ═══════════════════════════════════════════════════════════════════════
// TwelveData helpers
// ═══════════════════════════════════════════════════════════════════════

const TD_SKIP = new Set(["ES1!","NQ1!","YM1!","RTY1!","CL1!","GC1!","SI1!","HG1!","NG1!","VX1!","US500","SPX"]);

function toTdSymbol(s) {
  if (CRYPTO_MAP[s]) return CRYPTO_MAP[s];
  return s;
}
function fromTdSymbol(s) {
  if (s.includes("/")) return s.replace("/", "");
  return s;
}

function aggregate5mTo10m(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return bars;
  const result = [];
  for (let i = 0; i < bars.length - 1; i += 2) {
    const a = bars[i], b = bars[i + 1];
    result.push({
      t: a.t,
      o: a.o,
      h: Math.max(a.h, b.h),
      l: Math.min(a.l, b.l),
      c: b.c,
      v: (a.v || 0) + (b.v || 0),
    });
  }
  return result;
}

async function fetchTwelveDataBars(symbols, tfKey, startISO) {
  const cfg = TF_CONFIGS[tfKey];
  if (!cfg) throw new Error(`Unknown TF: ${tfKey}`);
  if (!TD_KEY) throw new Error("TWELVEDATA_API_KEY not set");

  const filtered = symbols.filter(s => !TD_SKIP.has(s));
  const allBars = {};
  const BATCH = 8;

  for (let i = 0; i < filtered.length; i += BATCH) {
    const batch = filtered.slice(i, i + BATCH);
    const tdSyms = batch.map(toTdSymbol);

    const params = new URLSearchParams({
      symbol: tdSyms.join(","),
      interval: cfg.td,
      apikey: TD_KEY,
      outputsize: String(cfg.tdSize),
      order: "asc",
      timezone: "UTC",
    });
    const startDate = startISO.replace("Z", "").replace("T", " ").slice(0, 19);
    params.set("start_date", startDate);

    const url = `${TD_BASE}/time_series?${params}`;
    let data;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (resp.status === 429) {
          const wait = 60000 * (retry + 1);
          console.warn(`  TD 429 rate limit — waiting ${wait / 1000}s before retry`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (!resp.ok) {
          console.error(`  TD HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
          break;
        }
        data = await resp.json();
        break;
      } catch (e) {
        console.error(`  TD fetch error: ${String(e).slice(0, 150)}`);
        break;
      }
    }
    if (!data) continue;

    function parseBars(values) {
      return values.map(v => {
        const dt = v.datetime || "";
        const ts = dt.includes("T") ? dt : dt + "T00:00:00Z";
        return {
          t: ts.endsWith("Z") ? ts : ts + "Z",
          o: Number(v.open), h: Number(v.high),
          l: Number(v.low), c: Number(v.close),
          v: Number(v.volume) || 0,
        };
      });
    }

    if (tdSyms.length === 1) {
      if (Array.isArray(data.values)) {
        let bars = parseBars(data.values);
        if (cfg.aggregate10m) bars = aggregate5mTo10m(bars);
        allBars[fromTdSymbol(tdSyms[0])] = bars;
      }
    } else {
      for (const [tdSym, symData] of Object.entries(data)) {
        if (tdSym === "status" || !symData?.values) continue;
        let bars = parseBars(symData.values);
        if (cfg.aggregate10m) bars = aggregate5mTo10m(bars);
        allBars[fromTdSymbol(tdSym)] = bars;
      }
    }

    // TwelveData PRO: 8 req/min (free tier); PRO may be higher. Use 8s to stay under 8 req/min.
    if (i + BATCH < filtered.length) {
      await new Promise(r => setTimeout(r, 8000));
    }
  }

  return allBars;
}

// ═══════════════════════════════════════════════════════════════════════
// Alpaca fetcher (unchanged from original)
// ═══════════════════════════════════════════════════════════════════════

async function fetchAlpacaBars(symbols, tfKey, startISO) {
  const cfg = TF_CONFIGS[tfKey];
  if (!cfg) throw new Error(`Unknown TF: ${tfKey}`);

  const stockSymbols = symbols.filter(s => !CRYPTO_TICKERS.has(s));
  const cryptoSymbols = symbols.filter(s => CRYPTO_TICKERS.has(s));
  const allBars = {};

  if (stockSymbols.length > 0) {
    const alpacaStockSyms = stockSymbols.map(s => STOCK_SYM_MAP[s] || s);
    let pageToken = null;
    let pages = 0;
    do {
      const params = new URLSearchParams();
      params.set("symbols", alpacaStockSyms.join(","));
      params.set("timeframe", cfg.alpaca);
      params.set("start", startISO);
      params.set("limit", String(cfg.limit));
      params.set("adjustment", "split");
      params.set("feed", "sip");
      params.set("sort", "asc");
      if (pageToken) params.set("page_token", pageToken);

      const url = `${ALPACA_STOCKS_BASE}/stocks/bars?${params.toString()}`;
      const resp = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": ALPACA_KEY,
          "APCA-API-SECRET-KEY": ALPACA_SECRET,
          "Accept": "application/json",
        },
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error(`  Alpaca Stocks HTTP ${resp.status}: ${text.slice(0, 200)}`);
        break;
      }

      const data = await resp.json();
      const bars = data.bars || {};
      for (const [sym, barArr] of Object.entries(bars)) {
        const ourSym = REVERSE_STOCK_MAP[sym] || sym;
        if (!allBars[ourSym]) allBars[ourSym] = [];
        allBars[ourSym].push(...barArr);
      }
      pageToken = data.next_page_token || null;
      pages++;

      if (pages % 5 === 0) process.stdout.write(`    (page ${pages}...)`);
    } while (pageToken && pages < 100);
  }

  if (cryptoSymbols.length > 0) {
    const alpacaCryptoSyms = cryptoSymbols.map(s => CRYPTO_MAP[s]);
    let pageToken = null;
    let pages = 0;
    do {
      const params = new URLSearchParams();
      params.set("symbols", alpacaCryptoSyms.join(","));
      params.set("timeframe", cfg.alpaca);
      params.set("start", startISO);
      params.set("limit", String(cfg.limit));
      params.set("sort", "asc");
      if (pageToken) params.set("page_token", pageToken);

      const url = `${ALPACA_CRYPTO_BASE}/bars?${params.toString()}`;
      const resp = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": ALPACA_KEY,
          "APCA-API-SECRET-KEY": ALPACA_SECRET,
          "Accept": "application/json",
        },
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error(`  Alpaca Crypto HTTP ${resp.status}: ${text.slice(0, 200)}`);
        break;
      }

      const data = await resp.json();
      const bars = data.bars || {};
      const reverseMap = Object.fromEntries(Object.entries(CRYPTO_MAP).map(([k, v]) => [v, k]));
      for (const [alpacaSym, barArr] of Object.entries(bars)) {
        const ourSym = reverseMap[alpacaSym] || alpacaSym.replace("/", "");
        if (!allBars[ourSym]) allBars[ourSym] = [];
        allBars[ourSym].push(...barArr);
      }
      pageToken = data.next_page_token || null;
      pages++;

      if (pages % 5 === 0) process.stdout.write(`    (page ${pages}...)`);
    } while (pageToken && pages < 100);
  }

  return allBars;
}

// ═══════════════════════════════════════════════════════════════════════
// Upload + main
// ═══════════════════════════════════════════════════════════════════════

async function uploadCandles(ticker, tfKey, candles, retries = 2) {
  const tfCandles = {};
  tfCandles[tfKey] = candles.map(bar => ({
    ts: new Date(bar.t).getTime(),
    o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0,
  }));

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(`${WORKER_BASE}/timed/ingest-candles?key=${TIMED_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, tf_candles: tfCandles }),
      });
      const data = await resp.json();
      return data;
    } catch (e) {
      if (attempt === retries) return { ok: false, error: String(e) };
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

async function fetchActiveTickers() {
  try {
    console.log("Fetching active ticker list from worker...");
    const res = await fetch(`${WORKER_BASE}/timed/tickers`);
    const data = await res.json();
    if (data?.ok && Array.isArray(data.tickers) && data.tickers.length > 0) {
      const activeSet = new Set(data.tickers.map(t => String(t).toUpperCase()));
      const filtered = ALL_TICKERS.filter(t => activeSet.has(t));
      console.log(`  Active tickers: ${data.tickers.length} from worker, ${filtered.length} matched in SECTOR_MAP`);
      return filtered;
    }
    console.warn("  Worker returned empty ticker list, falling back to full SECTOR_MAP");
  } catch (e) {
    console.warn(`  Could not fetch active tickers (${e.message}), falling back to full SECTOR_MAP`);
  }
  return [...new Set(ALL_TICKERS)];
}

async function main() {
  const args = process.argv.slice(2);
  let tfFilter = null;
  let batchSize = 30;
  let tickerFilter = null;
  let provider = process.env.DATA_PROVIDER || "twelvedata";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tf" && args[i + 1]) tfFilter = args[++i];
    if (args[i] === "--batch" && args[i + 1]) batchSize = parseInt(args[++i]);
    if (args[i] === "--tickers" && args[i + 1]) tickerFilter = args[++i].split(",").map(t => t.trim().toUpperCase());
    if (args[i] === "--provider" && args[i + 1]) provider = args[++i].toLowerCase();
  }

  const useTD = provider === "twelvedata" || provider === "td";

  if (useTD && !TD_KEY) {
    console.error("ERROR: TWELVEDATA_API_KEY not set. Export it or use --provider alpaca.");
    process.exit(1);
  }
  if (!useTD && !ALPACA_KEY) {
    console.error("ERROR: ALPACA_API_KEY_ID not set. Export it or use --provider twelvedata.");
    process.exit(1);
  }

  const tfsToProcess = tfFilter ? [tfFilter] : TF_ORDER;
  const tickers = tickerFilter || await fetchActiveTickers();

  console.log(`${useTD ? "TwelveData" : "Alpaca"} Backfill: ${tickers.length} tickers × ${tfsToProcess.length} timeframes`);
  console.log(`Batch size: ${useTD ? 8 : batchSize} symbols per API call`);
  console.log(`Timeframes: ${tfsToProcess.join(", ")}`);
  console.log();

  let totalUpserted = 0;
  let totalErrors = 0;
  const effectiveBatch = useTD ? 8 : batchSize;

  for (const tf of tfsToProcess) {
    const cfg = TF_CONFIGS[tf];
    const start = new Date(Date.now() - cfg.daysBack * 24 * 60 * 60 * 1000).toISOString();
    console.log(`\n== TF: ${tf} (${useTD ? cfg.td : cfg.alpaca}) — fetching from ${start.split("T")[0]} ==`);

    for (let i = 0; i < tickers.length; i += effectiveBatch) {
      const batch = tickers.slice(i, i + effectiveBatch);
      process.stdout.write(`  Batch ${Math.floor(i / effectiveBatch) + 1}/${Math.ceil(tickers.length / effectiveBatch)} (${batch[0]}..${batch[batch.length - 1]}): `);

      try {
        const allBars = useTD
          ? await fetchTwelveDataBars(batch, tf, start)
          : await fetchAlpacaBars(batch, tf, start);
        let batchUpserted = 0;

        for (const [sym, bars] of Object.entries(allBars)) {
          if (!Array.isArray(bars) || bars.length === 0) continue;
          try {
            const result = await uploadCandles(sym, tf, bars);
            if (result.ok) {
              batchUpserted += result.ingested || bars.length;
            } else {
              totalErrors++;
              console.error(`\n    Upload error for ${sym}: ${JSON.stringify(result)}`);
            }
          } catch (e) {
            totalErrors++;
          }
        }

        totalUpserted += batchUpserted;
        console.log(`${Object.keys(allBars).length} symbols, ${batchUpserted} bars uploaded`);
      } catch (e) {
        totalErrors++;
        console.error(`\n    Batch error: ${e.message}`);
      }

      await new Promise(r => setTimeout(r, useTD ? 8000 : 200));
    }
  }

  console.log(`\n========================================`);
  console.log(`DONE: ${totalUpserted} bars upserted, ${totalErrors} errors`);
  console.log(`========================================`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
