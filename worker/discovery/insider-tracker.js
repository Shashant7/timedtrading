// worker/discovery/insider-tracker.js
//
// 2026-05-28 — Discovery Phase 4a.
//
// Pulls insider transactions (Form 4 filings) from Finnhub for tickers that
// matter to us: open positions, in-review tickers, and screener candidates
// that are queued for promotion review. Insider buying — especially from
// CEOs, CFOs, Directors, and 10% Owners — is one of the highest-signal
// leading indicators in the public domain.
//
// Data flow:
//   GH Action / scheduled cron → fetchAndStoreInsiderTransactions(env, tickers)
//     → Finnhub /stock/insider-transactions?symbol=… per ticker, batched
//     → D1 INSERT OR IGNORE into insider_transactions (UNIQUE constraint
//       prevents duplicates across re-runs)
//   CIO eval cycle → loadRecentInsiderSummary(env, sym)
//     → returns compact summary for memory L12
//   Promotion Queue → loadRecentInsiderSummary(env, sym)
//     → contributes INSIDER_BUY scoring component

const FINNHUB_BASE = "https://finnhub.io/api/v1";

// Insiders we weight as high-signal (Form 4 transaction_codes "P" = purchase,
// title contains one of these). Pure shareholders / "Officer Other" entries
// are noise; we filter them.
const HIGH_SIGNAL_TITLES = [
  "ceo", "chief executive",
  "cfo", "chief financial",
  "coo", "chief operating",
  "cto", "chief technology",
  "cio", "chief information",
  "cmo", "chief marketing",
  "president", "chairman", "vice chairman",
  "director", "board",
  "10%", "10 percent", "ten percent",
  "executive officer", "principal officer",
];

function isHighSignalInsider(title) {
  const t = String(title || "").toLowerCase();
  return HIGH_SIGNAL_TITLES.some((kw) => t.includes(kw));
}

function isPurchaseCode(code) {
  // Form 4 transaction codes: P = open-market purchase, A = grant/award (not a buy signal)
  // We treat P (and rare M-converted exercises followed by S that net long) as the buy signal.
  // S = sale, F = tax withholding, G = gift — informational.
  const c = String(code || "").toUpperCase();
  return c === "P";
}

function isSaleCode(code) {
  const c = String(code || "").toUpperCase();
  return c === "S";
}

export async function ensureInsiderTransactionsSchema(env) {
  const db = env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS insider_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        insider_name TEXT,
        insider_title TEXT,
        transaction_date TEXT,
        transaction_code TEXT,
        shares INTEGER,
        price REAL,
        total_value REAL,
        filing_url TEXT,
        fetched_at INTEGER,
        UNIQUE(ticker, insider_name, transaction_date, transaction_code, shares)
      )
    `).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_insider_ticker_date ON insider_transactions (ticker, transaction_date DESC)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_insider_fetched ON insider_transactions (fetched_at DESC)`).run();
  } catch (e) {
    console.warn("[INSIDER] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

// Pull insider transactions from Finnhub for a single ticker. Returns array of
// raw transaction objects (no DB writes; caller decides whether to persist).
async function fetchInsiderTransactionsForTicker(env, ticker, opts = {}) {
  const token = env?.FINNHUB_API_KEY;
  if (!token) return { ok: false, error: "no_finnhub_api_key" };
  const lookbackDays = Math.max(1, Math.min(180, Number(opts.lookbackDays) || 30));
  const to = new Date();
  const from = new Date(Date.now() - lookbackDays * 86400000);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);
  const url = `${FINNHUB_BASE}/stock/insider-transactions?symbol=${encodeURIComponent(ticker)}&from=${fromStr}&to=${toStr}&token=${token}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      return { ok: false, error: `finnhub_${resp.status}`, ticker };
    }
    const json = await resp.json();
    const rows = Array.isArray(json?.data) ? json.data : [];
    return { ok: true, ticker, rows, raw_count: rows.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), ticker };
  }
}

// Fetch + persist insider transactions for a list of tickers. Throttled to
// stay inside Finnhub free-tier quota (60 calls/min). Returns { upserted,
// errors, per_ticker_counts }.
export async function fetchAndStoreInsiderTransactions(env, tickers, opts = {}) {
  if (!Array.isArray(tickers) || tickers.length === 0) {
    return { ok: false, error: "tickers_required" };
  }
  await ensureInsiderTransactionsSchema(env);
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };

  const throttleMs = Math.max(0, Number(opts.throttleMs) || 1100); // 60/min cap
  const lookbackDays = Math.max(1, Math.min(180, Number(opts.lookbackDays) || 30));
  let upserted = 0, errors = 0;
  const perTicker = {};

  for (let i = 0; i < tickers.length; i++) {
    const t = String(tickers[i] || "").toUpperCase();
    if (!t) continue;
    const r = await fetchInsiderTransactionsForTicker(env, t, { lookbackDays });
    if (!r.ok) {
      errors++;
      perTicker[t] = { error: r.error };
      if (i + 1 < tickers.length) await new Promise(r => setTimeout(r, throttleMs));
      continue;
    }
    const fetchedAt = Date.now();
    let tickerUpserted = 0;
    for (const row of r.rows) {
      // Finnhub schema (current): { name, share, change, filingDate,
      // transactionDate, transactionCode, transactionPrice, position }
      const insiderName = String(row.name || "").slice(0, 200);
      const insiderTitle = String(row.position || "").slice(0, 200);
      const txDate = String(row.transactionDate || row.filingDate || "").slice(0, 10);
      const txCode = String(row.transactionCode || "").slice(0, 4);
      const shares = Math.abs(Math.round(Number(row.share || row.shares || row.change) || 0));
      const price = Number(row.transactionPrice || row.price) || null;
      const totalValue = (price && shares) ? +(price * shares).toFixed(2) : null;
      if (!insiderName || !txDate || !txCode || !shares) continue;
      try {
        await db.prepare(`
          INSERT OR IGNORE INTO insider_transactions
            (ticker, insider_name, insider_title, transaction_date, transaction_code,
             shares, price, total_value, filing_url, fetched_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
        `).bind(
          t, insiderName, insiderTitle, txDate, txCode,
          shares, price, totalValue, null, fetchedAt,
        ).run();
        tickerUpserted++;
      } catch (e) {
        // Mostly UNIQUE collisions on re-runs — silent
      }
    }
    upserted += tickerUpserted;
    perTicker[t] = { fetched: r.raw_count, upserted: tickerUpserted };
    if (i + 1 < tickers.length) await new Promise(r => setTimeout(r, throttleMs));
  }

  return { ok: true, tickers: tickers.length, upserted, errors, per_ticker: perTicker };
}

// Load compact summary of recent insider activity for one ticker, used by
// CIO memory L12 + Promotion Queue INSIDER_BUY scoring.
export async function loadRecentInsiderSummary(env, ticker, opts = {}) {
  const db = env?.DB;
  const sym = String(ticker || "").toUpperCase();
  if (!db || !sym) return null;
  const lookbackDays = Math.max(1, Math.min(180, Number(opts.lookbackDays) || 30));
  const minValueUsd = Math.max(0, Number(opts.minValueUsd) || 0);
  try {
    const cutoff = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
    const rows = (await db.prepare(`
      SELECT insider_name, insider_title, transaction_date, transaction_code,
             shares, price, total_value
        FROM insider_transactions
       WHERE ticker = ?1 AND transaction_date >= ?2
       ORDER BY transaction_date DESC
       LIMIT 100
    `).bind(sym, cutoff).all().catch(() => ({ results: [] })))?.results || [];
    if (rows.length === 0) {
      return { ticker: sym, lookback_days: lookbackDays, buys: [], sells: [], has_data: false };
    }
    const buys = [], sells = [];
    let totalBuyValue = 0, totalSellValue = 0;
    let highSignalBuyValue = 0, highSignalBuyCount = 0;
    for (const r of rows) {
      const value = Number(r.total_value) || 0;
      if (minValueUsd > 0 && value < minValueUsd) continue;
      const entry = {
        date: r.transaction_date,
        name: r.insider_name,
        title: r.insider_title,
        shares: r.shares,
        value: Math.round(value),
        high_signal: isHighSignalInsider(r.insider_title),
      };
      if (isPurchaseCode(r.transaction_code)) {
        buys.push(entry);
        totalBuyValue += value;
        if (entry.high_signal) {
          highSignalBuyValue += value;
          highSignalBuyCount++;
        }
      } else if (isSaleCode(r.transaction_code)) {
        sells.push(entry);
        totalSellValue += value;
      }
    }
    return {
      ticker: sym,
      lookback_days: lookbackDays,
      has_data: true,
      buys: {
        count: buys.length,
        total_value: Math.round(totalBuyValue),
        high_signal_count: highSignalBuyCount,
        high_signal_value: Math.round(highSignalBuyValue),
        top_3: buys.slice(0, 3),
      },
      sells: {
        count: sells.length,
        total_value: Math.round(totalSellValue),
        top_3: sells.slice(0, 3),
      },
      net_value: Math.round(totalBuyValue - totalSellValue),
    };
  } catch (e) {
    console.warn(`[INSIDER] loadRecentInsiderSummary failed for ${sym}:`, String(e?.message || e).slice(0, 150));
    return null;
  }
}

// Batch-load summaries for multiple tickers in a single query (used by the
// Promotion Queue + CIO live cache preload).
export async function loadInsiderSummariesBatch(env, tickers, opts = {}) {
  const db = env?.DB;
  if (!db || !Array.isArray(tickers) || tickers.length === 0) return {};
  const lookbackDays = Math.max(1, Math.min(180, Number(opts.lookbackDays) || 30));
  const cutoff = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const symSet = new Set(tickers.map((t) => String(t || "").toUpperCase()).filter(Boolean));
  try {
    // Load all rows in one query (filter in JS) to avoid bind-param overflow.
    const rows = (await db.prepare(`
      SELECT ticker, insider_name, insider_title, transaction_date, transaction_code,
             shares, total_value
        FROM insider_transactions
       WHERE transaction_date >= ?1
       ORDER BY transaction_date DESC
       LIMIT 5000
    `).bind(cutoff).all().catch(() => ({ results: [] })))?.results || [];
    const out = {};
    for (const t of symSet) out[t] = { ticker: t, buys_value: 0, buys_count: 0, hi_buys_value: 0, hi_buys_count: 0, sells_value: 0, sells_count: 0 };
    for (const r of rows) {
      const t = String(r.ticker || "").toUpperCase();
      if (!symSet.has(t)) continue;
      const value = Number(r.total_value) || 0;
      const hi = isHighSignalInsider(r.insider_title);
      if (isPurchaseCode(r.transaction_code)) {
        out[t].buys_count++;
        out[t].buys_value += value;
        if (hi) { out[t].hi_buys_count++; out[t].hi_buys_value += value; }
      } else if (isSaleCode(r.transaction_code)) {
        out[t].sells_count++;
        out[t].sells_value += value;
      }
    }
    for (const t of Object.keys(out)) {
      out[t].buys_value = Math.round(out[t].buys_value);
      out[t].hi_buys_value = Math.round(out[t].hi_buys_value);
      out[t].sells_value = Math.round(out[t].sells_value);
      out[t].net_value = out[t].buys_value - out[t].sells_value;
      if (out[t].buys_count === 0 && out[t].sells_count === 0) delete out[t];
    }
    return out;
  } catch (e) {
    console.warn("[INSIDER] loadInsiderSummariesBatch failed:", String(e?.message || e).slice(0, 150));
    return {};
  }
}
