// Compare platform tickers with group tickers

const groups = {
  "Upticks": ["TSLA", "STX", "AU", "CCJ", "CLS", "CRS", "VST", "FSLR", "JCI", "ORCL", "AMZN", "BRK-B", "BABA", "WMT", "PH", "GEV", "HII", "ULTA", "SHOP", "CSX", "PWR", "HOOD", "SPGI", "APP", "PANW", "RDDT", "TT", "GLXY", "ETHA"],
  "Super Granny": ["META", "NVDA", "AMD", "ANET", "GS"],
  "GRNI": ["VST", "TSLA", "TJX", "SPGI", "SOFI", "PWR", "PNC", "PLTR", "PANW", "NVDA", "NFLX", "MSTR", "MSFT", "MNST", "META", "LRCX", "KLAC", "JPM", "HOOD", "GS", "GOOGL", "GEV", "GE", "EXPE", "ETN", "EMR", "DE", "CRWD", "COST", "CDNS", "CAT", "BK", "AXP", "AXON", "AVGO", "ANET", "AMZN", "AMD", "AAPL"],
  "GRNJ": ["RKLB", "LITE", "SN", "ALB", "RDDT", "RGLD", "MTZ", "ON", "ALLY", "DY", "CCJ", "EWBC", "PATH", "WFRD", "WAL", "IESC", "ENS", "TWLO", "MLI", "KTOS", "MDB", "TLN", "EME", "AWI", "IBP", "DCI", "WTS", "FIX", "UTHR", "NBIS", "SGI", "AYI", "RIOT", "NXT", "SANM", "BWXT", "PEGA", "JOBY", "IONQ", "SOFI", "ITT", "STRL", "QLYS", "MP", "GLXY", "HIMS", "IOT", "BE", "NEU", "AVAV", "PSTG", "RBLX"],
  "GRNY": ["GEV", "LRCX", "PNC", "GOOGL", "GS", "META", "MNST", "KLAC", "TJX", "GE", "EXPE", "CAT", "BK", "SPGI", "TSLA", "EMR", "JPM", "AXP", "ANET", "AXON", "AAPL", "NVDA", "AVGO", "PWR", "CDNS", "DE", "MSFT", "COST", "VST", "PLTR", "AMZN", "HOOD", "ETN", "SOFI", "AMD", "PANW", "CRWD", "NFLX", "MSTR"],
  "Social": ["CSCO", "BA", "NKE", "AAPL", "PI", "APLD", "MU"]
};

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

