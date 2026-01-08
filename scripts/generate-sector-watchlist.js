#!/usr/bin/env node

/**
 * Generate Sector-Based Watchlist Recommendations
 * 
 * This script fetches top tickers from overweight sectors and generates
 * a watchlist file for TradingView.
 * 
 * Usage:
 *   node scripts/generate-sector-watchlist.js [options]
 * 
 * Options:
 *   --api-key=KEY      Your API key (or set TIMED_API_KEY env var)
 *   --worker-url=URL   Worker URL (default: https://timed-trading-ingest.shashant.workers.dev)
 *   --limit=N          Tickers per sector (default: 10)
 *   --total-limit=N    Total tickers across all sectors (default: 50)
 *   --output=FILE      Output file path (default: tradingview/WATCHLIST_SECTORS.txt)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const WORKER_URL = process.env.WORKER_URL || 'https://timed-trading-ingest.shashant.workers.dev';
const API_KEY = process.env.TIMED_API_KEY || '';
const DEFAULT_LIMIT = 10;
const DEFAULT_TOTAL_LIMIT = 50;
const DEFAULT_OUTPUT = path.join(__dirname, '../tradingview/WATCHLIST_SECTORS.txt');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  apiKey: API_KEY,
  workerUrl: WORKER_URL,
  limit: DEFAULT_LIMIT,
  totalLimit: DEFAULT_TOTAL_LIMIT,
  output: DEFAULT_OUTPUT,
};

args.forEach(arg => {
  if (arg.startsWith('--api-key=')) {
    options.apiKey = arg.split('=')[1];
  } else if (arg.startsWith('--worker-url=')) {
    options.workerUrl = arg.split('=')[1];
  } else if (arg.startsWith('--limit=')) {
    options.limit = parseInt(arg.split('=')[1]);
  } else if (arg.startsWith('--total-limit=')) {
    options.totalLimit = parseInt(arg.split('=')[1]);
  } else if (arg.startsWith('--output=')) {
    options.output = arg.split('=')[1];
  }
});

if (!options.apiKey) {
  console.error('❌ Error: API key required');
  console.error('   Set TIMED_API_KEY environment variable or use --api-key=KEY');
  process.exit(1);
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function fetchRecommendations() {
  const url = `${options.workerUrl}/timed/sectors/recommendations?limit=${options.limit}&totalLimit=${options.totalLimit}`;
  console.log(`📡 Fetching recommendations from ${url}...`);
  
  const result = await httpsGet(url);
  
  if (!result.ok) {
    throw new Error(result.error || 'Failed to fetch recommendations');
  }
  
  return result;
}

async function addToWatchlist(tickers) {
  const url = `${options.workerUrl}/timed/watchlist/add?key=${options.apiKey}`;
  console.log(`📝 Adding ${tickers.length} tickers to watchlist...`);
  
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ tickers });
    
    const urlObj = new URL(url);
    const options_req = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    
    const req = https.request(options_req, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function main() {
  try {
    console.log('🚀 Generating sector-based watchlist recommendations...\n');
    
    // Fetch recommendations
    const result = await fetchRecommendations();
    
    console.log(`✅ Found ${result.recommendations.length} recommendations`);
    console.log(`   Sectors: ${result.sectors.join(', ')}\n`);
    
    // Group by sector for display
    const bySector = {};
    result.recommendations.forEach(rec => {
      if (!bySector[rec.sector]) {
        bySector[rec.sector] = [];
      }
      bySector[rec.sector].push(rec);
    });
    
    console.log('📊 Recommendations by Sector:');
    Object.keys(bySector).forEach(sector => {
      const tickers = bySector[sector];
      console.log(`\n   ${sector} (${tickers.length} tickers):`);
      tickers.forEach(t => {
        console.log(`     - ${t.ticker}: Rank ${t.rank} → ${t.boostedRank} (boost: +${t.sectorBoost})`);
      });
    });
    
    // Extract ticker list
    const tickers = result.recommendations.map(r => r.ticker);
    
    // Write to file
    const outputDir = path.dirname(options.output);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    fs.writeFileSync(options.output, tickers.join('\n') + '\n');
    console.log(`\n💾 Saved ${tickers.length} tickers to ${options.output}`);
    
    // Add to watchlist via API
    const addResult = await addToWatchlist(tickers);
    
    if (addResult.ok) {
      console.log(`\n✅ Successfully added ${addResult.added} tickers to watchlist`);
      if (addResult.alreadyExists > 0) {
        console.log(`   (${addResult.alreadyExists} were already in watchlist)`);
      }
      console.log(`   Total tickers in watchlist: ${addResult.totalTickers}`);
    } else {
      console.error(`\n❌ Failed to add to watchlist: ${addResult.error}`);
    }
    
    console.log('\n✨ Done!');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

main();
