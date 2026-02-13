// Compare platform tickers with group tickers
// GRNY/GRNI/GRNJ are loaded dynamically from the ETF sync API.

const groups = {
  UPTICKS: ["TSLA", "STX", "AU", "CLS", "CRS", "VST", "FSLR", "JCI", "ORCL", "AMZN", "BRK-B", "BABA", "WMT", "PH", "GEV", "HII", "CSX", "PWR", "SPGI", "APP", "PANW", "RDDT", "TT", "GLXY", "ETHA", "KO", "GILD", "MTB", "AMGN"],
  SuperGranny: ["META", "NVDA", "AMD", "ANET", "GS"],
  GRNI: [],
  GRNJ: [],
  GRNY: [],
  Social: ["CSCO", "BA", "NKE", "AAPL", "PI", "APLD", "MU", "HOOD", "CCJ", "ULTA", "STX", "SWK", "AEHR", "SLV", "SNDK", "INTC", "SOXL", "IREN", "RKLB", "CRWV", "BE", "ONDS", "ASTS", "LITE", "AGQ", "IBRX", "LRCX", "WDC", "CRVS", "GDXJ", "HL", "MP", "B"],
};

// Load ETF groups dynamically before comparison
async function loadAndRun() {
  try {
    const resp = await fetch('https://timed-trading-ingest.shashant.workers.dev/timed/etf/groups');
    const data = await resp.json();
    if (data.ok && data.groups) {
      for (const [etf, tickers] of Object.entries(data.groups)) {
        if (groups[etf] !== undefined) groups[etf] = tickers;
      }
    }
  } catch (e) {
    console.warn('Failed to load ETF groups, using empty sets:', e);
  }
  runComparison();
}

function runComparison() {
// Get all unique tickers from all groups
const allGroupTickers = new Set();
Object.values(groups).forEach(groupTickers => {
  groupTickers.forEach(ticker => allGroupTickers.add(ticker.toUpperCase()));
});

// Fetch platform tickers
fetch('https://timed-trading-ingest.shashant.workers.dev/timed/tickers')
  .then(res => res.json())
  .then(data => {
    if (!data.ok) {
      console.error('Error fetching platform tickers:', data);
      return;
    }

    const platformTickers = new Set(data.tickers.map(t => t.toUpperCase()));

    // Tickers in platform but not in groups
    const inPlatformNotInGroups = [...platformTickers].filter(t => !allGroupTickers.has(t)).sort();

    // Tickers in groups but not in platform
    const inGroupsNotInPlatform = [...allGroupTickers].filter(t => !platformTickers.has(t)).sort();

    // Tickers in both
    const inBoth = [...platformTickers].filter(t => allGroupTickers.has(t)).sort();

    console.log('='.repeat(60));
    console.log('TICKER COMPARISON REPORT');
    console.log('='.repeat(60));
    console.log(`\nPlatform Tickers: ${platformTickers.size}`);
    console.log(`Group Tickers (unique): ${allGroupTickers.size}`);
    console.log(`Tickers in both: ${inBoth.length}`);
    console.log(`\n`);

    console.log('='.repeat(60));
    console.log(`TICKERS IN PLATFORM BUT NOT IN GROUPS (${inPlatformNotInGroups.length}):`);
    console.log('='.repeat(60));
    if (inPlatformNotInGroups.length > 0) {
      inPlatformNotInGroups.forEach(t => console.log(`  - ${t}`));
    } else {
      console.log('  (none)');
    }

    console.log(`\n`);
    console.log('='.repeat(60));
    console.log(`TICKERS IN GROUPS BUT NOT IN PLATFORM (${inGroupsNotInPlatform.length}):`);
    console.log('='.repeat(60));
    if (inGroupsNotInPlatform.length > 0) {
      inGroupsNotInPlatform.forEach(t => console.log(`  - ${t}`));
    } else {
      console.log('  (none)');
    }

    console.log(`\n`);
    console.log('='.repeat(60));
    console.log('BREAKDOWN BY GROUP:');
    console.log('='.repeat(60));
    Object.entries(groups).forEach(([groupName, groupTickers]) => {
      const groupSet = new Set(groupTickers.map(t => t.toUpperCase()));
      const inPlatform = [...groupSet].filter(t => platformTickers.has(t));
      const notInPlatform = [...groupSet].filter(t => !platformTickers.has(t));
      console.log(`\n${groupName}:`);
      console.log(`  Total: ${groupTickers.length}`);
      console.log(`  In Platform: ${inPlatform.length} - ${inPlatform.join(', ')}`);
      if (notInPlatform.length > 0) {
        console.log(`  Missing: ${notInPlatform.length} - ${notInPlatform.join(', ')}`);
      }
    });
  })
  .catch(err => {
    console.error('Error:', err);
  });
} // end runComparison

loadAndRun();

