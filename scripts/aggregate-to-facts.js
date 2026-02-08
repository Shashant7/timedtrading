#!/usr/bin/env node
/**
 * Aggregate timed_trail data into trail_5m_facts
 * 
 * Strategy:
 * - Process one ticker at a time to avoid D1 memory limits
 * - For each ticker, process one day at a time
 * - Aggregate 1-minute rows into 5-minute buckets
 * - Calculate OHLC, score ranges, signal flags
 * - Insert into trail_5m_facts
 * 
 * Usage:
 *   node scripts/aggregate-to-facts.js [--dry-run] [--ticker=AAPL] [--since=2026-01-01]
 */

const API_BASE = 'https://timed-trading-ingest.shashant.workers.dev';
const API_KEY = process.env.TIMED_API_KEY || 'AwesomeSauce';

// Parse command line args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SINGLE_TICKER = args.find(a => a.startsWith('--ticker='))?.split('=')[1];
const SINCE_DATE = args.find(a => a.startsWith('--since='))?.split('=')[1];

// Constants
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Helper: Floor timestamp to 5-minute bucket
function bucketTs(ts) {
  return Math.floor(ts / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

// Helper: Format date for display
function formatDate(ts) {
  return new Date(ts).toISOString().split('T')[0];
}

// Helper: API call with retry
async function apiCall(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const maxRetries = 3;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        }
      });
      
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text}`);
      }
      
      return await res.json();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.log(`  Retry ${attempt}/${maxRetries}: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// Get all tickers
async function getTickers() {
  console.log('Fetching ticker list...');
  const data = await apiCall('/timed/tickers');
  return data.tickers || [];
}

// Get trail data for a ticker within a time range
async function getTrailData(ticker, since, until) {
  const data = await apiCall(`/timed/admin/d1-query?key=${API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({
      query: `SELECT ts, price, htf_score, ltf_score, state, rank, completion, phase_pct, 
                     payload_json
              FROM timed_trail 
              WHERE ticker = ? AND ts >= ? AND ts < ?
              ORDER BY ts ASC`,
      params: [ticker, since, until]
    })
  });
  
  return data.results || [];
}

// Parse flags from payload_json
function extractFlags(payloadJson) {
  try {
    const payload = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson;
    return {
      squeeze_release: payload?.flags?.sq30_release || payload?.sq30_release || false,
      ema_cross: payload?.flags?.ema_cross_1h_13_48 || payload?.ema_cross_1h || false,
      st_flip: payload?.flags?.st_flip_1h || payload?.st_flip || false,
      momentum_elite: payload?.flags?.momentum_elite || payload?.momentum_elite || false,
      flip_watch: payload?.flags?.flip_watch || payload?.flip_watch || false,
      kanban_stage: payload?.kanban_stage || null,
      trade_entered: payload?.entry_ts && payload?.entry_price ? 1 : 0,
      trade_exited: payload?.exit_ts ? 1 : 0
    };
  } catch {
    return {
      squeeze_release: false, ema_cross: false, st_flip: false,
      momentum_elite: false, flip_watch: false, kanban_stage: null,
      trade_entered: 0, trade_exited: 0
    };
  }
}

// Aggregate rows into 5-minute bucket
function aggregateBucket(rows) {
  if (!rows.length) return null;
  
  const first = rows[0];
  const last = rows[rows.length - 1];
  
  // Price OHLC
  const prices = rows.map(r => r.price).filter(p => p != null);
  const priceOpen = prices[0] || null;
  const priceHigh = prices.length ? Math.max(...prices) : null;
  const priceLow = prices.length ? Math.min(...prices) : null;
  const priceClose = prices[prices.length - 1] || null;
  
  // HTF score stats
  const htfScores = rows.map(r => r.htf_score).filter(s => s != null);
  const htfAvg = htfScores.length ? htfScores.reduce((a, b) => a + b, 0) / htfScores.length : null;
  const htfMin = htfScores.length ? Math.min(...htfScores) : null;
  const htfMax = htfScores.length ? Math.max(...htfScores) : null;
  
  // LTF score stats
  const ltfScores = rows.map(r => r.ltf_score).filter(s => s != null);
  const ltfAvg = ltfScores.length ? ltfScores.reduce((a, b) => a + b, 0) / ltfScores.length : null;
  const ltfMin = ltfScores.length ? Math.min(...ltfScores) : null;
  const ltfMax = ltfScores.length ? Math.max(...ltfScores) : null;
  
  // Extract flags from all rows
  const allFlags = rows.map(r => extractFlags(r.payload_json));
  const kanbanStages = allFlags.map(f => f.kanban_stage).filter(Boolean);
  
  return {
    bucket_ts: bucketTs(first.ts),
    price_open: priceOpen,
    price_high: priceHigh,
    price_low: priceLow,
    price_close: priceClose,
    htf_score_avg: htfAvg ? Math.round(htfAvg * 100) / 100 : null,
    htf_score_min: htfMin,
    htf_score_max: htfMax,
    ltf_score_avg: ltfAvg ? Math.round(ltfAvg * 100) / 100 : null,
    ltf_score_min: ltfMin,
    ltf_score_max: ltfMax,
    state: last.state,
    rank: last.rank,
    completion: last.completion,
    phase_pct: last.phase_pct,
    had_squeeze_release: allFlags.some(f => f.squeeze_release) ? 1 : 0,
    had_ema_cross: allFlags.some(f => f.ema_cross) ? 1 : 0,
    had_st_flip: allFlags.some(f => f.st_flip) ? 1 : 0,
    had_momentum_elite: allFlags.some(f => f.momentum_elite) ? 1 : 0,
    had_flip_watch: allFlags.some(f => f.flip_watch) ? 1 : 0,
    kanban_stage_start: kanbanStages[0] || null,
    kanban_stage_end: kanbanStages[kanbanStages.length - 1] || null,
    kanban_changed: new Set(kanbanStages).size > 1 ? 1 : 0,
    trade_entered: allFlags.some(f => f.trade_entered) ? 1 : 0,
    trade_exited: allFlags.some(f => f.trade_exited) ? 1 : 0,
    sample_count: rows.length
  };
}

// Insert aggregated facts into D1
async function insertFacts(ticker, facts) {
  if (!facts.length) return 0;
  
  // Insert in batches of 50 to avoid payload limits
  const BATCH_SIZE = 50;
  let inserted = 0;
  
  for (let i = 0; i < facts.length; i += BATCH_SIZE) {
    const batch = facts.slice(i, i + BATCH_SIZE);
    
    // Build INSERT statement with multiple rows
    const placeholders = batch.map(() => 
      '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).join(', ');
    
    const values = batch.flatMap(f => [
      ticker,
      f.bucket_ts,
      f.price_open,
      f.price_high,
      f.price_low,
      f.price_close,
      f.htf_score_avg,
      f.htf_score_min,
      f.htf_score_max,
      f.ltf_score_avg,
      f.ltf_score_min,
      f.ltf_score_max,
      f.state,
      f.rank,
      f.completion,
      f.phase_pct,
      f.had_squeeze_release,
      f.had_ema_cross,
      f.had_st_flip,
      f.had_momentum_elite,
      f.had_flip_watch,
      f.kanban_stage_start,
      f.kanban_stage_end,
      f.kanban_changed,
      f.sample_count,
      Date.now()
    ]);
    
    const sql = `INSERT OR REPLACE INTO trail_5m_facts 
      (ticker, bucket_ts, price_open, price_high, price_low, price_close,
       htf_score_avg, htf_score_min, htf_score_max,
       ltf_score_avg, ltf_score_min, ltf_score_max,
       state, rank, completion, phase_pct,
       had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite, had_flip_watch,
       kanban_stage_start, kanban_stage_end, kanban_changed,
       sample_count, created_at)
      VALUES ${placeholders}`;
    
    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would insert ${batch.length} facts`);
    } else {
      await apiCall(`/timed/admin/d1-query?key=${API_KEY}`, {
        method: 'POST',
        body: JSON.stringify({ query: sql, params: values })
      });
    }
    
    inserted += batch.length;
  }
  
  return inserted;
}

// Process a single ticker
async function processTicker(ticker, globalSince) {
  console.log(`\n📊 Processing ${ticker}...`);
  
  // Get date range for this ticker
  const rangeData = await apiCall(`/timed/admin/d1-query?key=${API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({
      query: 'SELECT MIN(ts) as min_ts, MAX(ts) as max_ts, COUNT(*) as cnt FROM timed_trail WHERE ticker = ?',
      params: [ticker]
    })
  });
  
  const range = rangeData.results?.[0];
  if (!range || !range.min_ts) {
    console.log(`  No data for ${ticker}`);
    return { ticker, rows: 0, facts: 0 };
  }
  
  let minTs = range.min_ts;
  if (globalSince) {
    const sinceTs = new Date(globalSince).getTime();
    if (sinceTs > minTs) minTs = sinceTs;
  }
  
  const maxTs = range.max_ts;
  const totalRows = range.cnt;
  
  console.log(`  Date range: ${formatDate(minTs)} to ${formatDate(maxTs)}`);
  console.log(`  Total rows: ${totalRows}`);
  
  let processedRows = 0;
  let totalFacts = 0;
  
  // Process day by day
  let dayStart = new Date(minTs);
  dayStart.setUTCHours(0, 0, 0, 0);
  let currentDay = dayStart.getTime();
  
  while (currentDay <= maxTs) {
    const dayEnd = currentDay + ONE_DAY_MS;
    
    // Fetch day's data
    const rows = await getTrailData(ticker, currentDay, dayEnd);
    
    if (rows.length > 0) {
      // Group by 5-minute buckets
      const buckets = new Map();
      for (const row of rows) {
        const bucket = bucketTs(row.ts);
        if (!buckets.has(bucket)) {
          buckets.set(bucket, []);
        }
        buckets.get(bucket).push(row);
      }
      
      // Aggregate each bucket
      const facts = [];
      for (const [bucket, bucketRows] of buckets) {
        const fact = aggregateBucket(bucketRows);
        if (fact) facts.push(fact);
      }
      
      // Insert facts
      if (facts.length > 0) {
        const inserted = await insertFacts(ticker, facts);
        totalFacts += inserted;
      }
      
      processedRows += rows.length;
      process.stdout.write(`  ${formatDate(currentDay)}: ${rows.length} rows → ${facts.length} facts\r`);
    }
    
    currentDay = dayEnd;
  }
  
  console.log(`\n  ✓ ${ticker}: ${processedRows} rows → ${totalFacts} facts (${(totalFacts / processedRows * 100).toFixed(1)}% compression)`);
  
  return { ticker, rows: processedRows, facts: totalFacts };
}

// Main
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  AGGREGATE TRAIL DATA TO 5-MINUTE FACTS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  if (SINGLE_TICKER) console.log(`Ticker filter: ${SINGLE_TICKER}`);
  if (SINCE_DATE) console.log(`Since: ${SINCE_DATE}`);
  console.log('');
  
  // Get tickers to process
  let tickers;
  if (SINGLE_TICKER) {
    tickers = [SINGLE_TICKER];
  } else {
    tickers = await getTickers();
  }
  
  console.log(`Found ${tickers.length} tickers to process`);
  
  // Process each ticker
  const results = [];
  const startTime = Date.now();
  
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    console.log(`\n[${i + 1}/${tickers.length}] ${ticker}`);
    
    try {
      const result = await processTicker(ticker, SINCE_DATE);
      results.push(result);
    } catch (err) {
      console.error(`  ✗ Error processing ${ticker}: ${err.message}`);
      results.push({ ticker, error: err.message });
    }
  }
  
  // Summary
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const totalRows = results.reduce((sum, r) => sum + (r.rows || 0), 0);
  const totalFacts = results.reduce((sum, r) => sum + (r.facts || 0), 0);
  const errors = results.filter(r => r.error).length;
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  AGGREGATION COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Elapsed time: ${elapsed} minutes`);
  console.log(`Tickers processed: ${results.length - errors}/${tickers.length}`);
  console.log(`Total rows processed: ${totalRows.toLocaleString()}`);
  console.log(`Total facts created: ${totalFacts.toLocaleString()}`);
  console.log(`Compression ratio: ${(totalFacts / totalRows * 100).toFixed(1)}%`);
  if (errors > 0) {
    console.log(`Errors: ${errors}`);
    results.filter(r => r.error).forEach(r => console.log(`  - ${r.ticker}: ${r.error}`));
  }
  console.log('');
  
  if (DRY_RUN) {
    console.log('This was a DRY RUN. No data was written.');
    console.log('Run without --dry-run to perform actual aggregation.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
