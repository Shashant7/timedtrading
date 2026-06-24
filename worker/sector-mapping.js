// Sector Mapping — 230-ticker active universe
// Maps tickers to their GICS sectors

const SECTOR_MAP = {
  // Consumer Discretionary
  'AMZN': 'Consumer Discretionary',
  'TSLA': 'Consumer Discretionary',
  'TJX': 'Consumer Discretionary',
  'BABA': 'Consumer Discretionary',
  'ULTA': 'Consumer Discretionary',
  'APP': 'Consumer Discretionary',
  'DPZ': 'Consumer Discretionary',
  'H': 'Consumer Discretionary',
  'LRN': 'Consumer Discretionary',
  'NKE': 'Consumer Discretionary',
  'MCD': 'Consumer Discretionary',
  'EXPE': 'Consumer Discretionary',
  'RBLX': 'Consumer Discretionary',
  'LULU': 'Consumer Discretionary',
  'DKNG': 'Consumer Discretionary',
  'CVNA': 'Consumer Discretionary',
  'SWK': 'Consumer Discretionary',
  'JD': 'Consumer Discretionary',
  'KWEB': 'Consumer Discretionary',
  'XYZ': 'Consumer Discretionary',
  'GRNY': 'Consumer Discretionary',

  // Consumer Staples
  'KO': 'Consumer Staples',
  'WMT': 'Consumer Staples',
  'COST': 'Consumer Staples',
  'MNST': 'Consumer Staples',
  'ELF': 'Consumer Staples',
  'CELH': 'Consumer Staples',
  'BG': 'Consumer Staples',
  // 2026-05-22: GRNY/GRNI May 2026 rebalance added PM.
  'PM': 'Consumer Staples',

  // Industrials
  'CAT': 'Industrials',
  'GE': 'Industrials',
  'ETN': 'Industrials',
  'DE': 'Industrials',
  'PH': 'Industrials',
  'CSX': 'Industrials',
  'HII': 'Industrials',
  'GEV': 'Industrials',
  'TT': 'Industrials',
  'PWR': 'Industrials',
  'AWI': 'Industrials',
  'WTS': 'Industrials',
  'DY': 'Industrials',
  'FIX': 'Industrials',
  'ITT': 'Industrials',
  'STRL': 'Industrials',
  'JCI': 'Industrials',
  'IBP': 'Industrials',
  'DCI': 'Industrials',
  'IESC': 'Industrials',
  'BWXT': 'Industrials',
  'BE': 'Industrials',
  'AVAV': 'Industrials',
  'AXON': 'Industrials',
  'MLI': 'Industrials',
  'NXT': 'Industrials',
  'SGI': 'Industrials',
  'CARR': 'Industrials',
  'CW': 'Industrials',
  'FLR': 'Industrials',
  'J': 'Industrials',
  'VMI': 'Industrials',
  'UNP': 'Industrials',
  'ARRY': 'Industrials',
  'BA': 'Industrials',
  'RTX': 'Industrials',
  'EMR': 'Industrials',
  'UPS': 'Industrials',
  'EME': 'Industrials',
  'MTZ': 'Industrials',
  'B': 'Industrials',
  'JOBY': 'Industrials',
  'ASTS': 'Industrials',
  'AYI': 'Industrials',
  'WM': 'Industrials',
  'QXO': 'Industrials',
  'NOC': 'Industrials',
  'RKLB': 'Industrials',

  // Information Technology
  'ACN': 'Information Technology',
  'AAPL': 'Information Technology',
  'MSFT': 'Information Technology',
  'NVDA': 'Information Technology',
  'AVGO': 'Information Technology',
  'AMD': 'Information Technology',
  'ORCL': 'Information Technology',
  // 2026-05-22: GRNY/GRNI May 2026 rebalance added NOW (ServiceNow).
  'NOW': 'Information Technology',
  // 2026-05-22: DELL was being scored but missing from SECTOR_MAP,
  // so it fell into the same degraded path as CF/NOW/PM (see PR #254).
  // Surfaced via the candle_freshness_60 alarm (worst 60m candle
  // 66.5h stale) — adding DELL to the core universe gets it on the
  // price-feed cron + candle backfill rotation.
  'DELL': 'Information Technology',
  // 2026-05-22: admin add-ticker request for IBM via the Ticker
  // Management UI silently failed during the Pages outage chain
  // (see PRs #267, #268, #269). Added to the core universe so it's
  // available to ALL users rather than tucked under one operator's
  // user_tickers slots.
  'IBM': 'Information Technology',
  'KLAC': 'Information Technology',
  'ANET': 'Information Technology',
  'CDNS': 'Information Technology',
  'PANW': 'Information Technology',
  'PLTR': 'Information Technology',
  'MDB': 'Information Technology',
  'PATH': 'Information Technology',
  // 2026-06-11 — SMCI was in ai_infra_compute cohort but missing from
  // SECTOR_MAP, so it never entered /timed/all or the scoring snapshot
  // (SMCI $41 vs $29 stale-price incident).
  'SMCI': 'Information Technology',
  'SNOW': 'Information Technology',
  'ADBE': 'Information Technology',
  'CLS': 'Information Technology',
  'CRS': 'Information Technology',
  'SANM': 'Information Technology',
  'IONQ': 'Information Technology',
  'LITE': 'Information Technology',
  'ON': 'Information Technology',
  'KTOS': 'Information Technology',
  'MSTR': 'Information Technology',
  'LSCC': 'Information Technology',
  'FN': 'Information Technology',
  'SHOP': 'Information Technology',
  'CRM': 'Information Technology',
  'INTC': 'Information Technology',
  'CSCO': 'Information Technology',
  'LRCX': 'Information Technology',
  'CRWD': 'Information Technology',
  'QLYS': 'Information Technology',
  'PEGA': 'Information Technology',
  'IOT': 'Information Technology',
  'MU': 'Information Technology',
  'APLD': 'Information Technology',
  'ARM': 'Information Technology',
  'TSM': 'Information Technology',
  'HUBS': 'Information Technology',
  'INTU': 'Information Technology',
  'STX': 'Information Technology',
  'WDC': 'Information Technology',
  'AGYS': 'Information Technology',
  'IREN': 'Information Technology',
  'PI': 'Information Technology',
  'AEHR': 'Information Technology',
  'SNDK': 'Information Technology',
  'NBIS': 'Information Technology',

  // Communication Services
  'META': 'Communication Services',
  'GOOGL': 'Communication Services',
  'NFLX': 'Communication Services',
  'RDDT': 'Communication Services',
  'SATS': 'Communication Services',
  'TWLO': 'Communication Services',
  'SPOT': 'Communication Services',
  'U': 'Communication Services',

  // Basic Materials
  'ALB': 'Basic Materials',
  'MP': 'Basic Materials',
  'CCJ': 'Basic Materials',
  'RGLD': 'Basic Materials',
  'SN': 'Basic Materials',
  'AU': 'Basic Materials',
  'APD': 'Basic Materials',
  'PKG': 'Basic Materials',
  'PPG': 'Basic Materials',
  // 2026-05-22: GRNY/GRNI May 2026 rebalance added CF (CF Industries — fertilizer).
  'CF': 'Basic Materials',
  'NEU': 'Basic Materials',
  'AA': 'Basic Materials',
  'GOLD': 'Basic Materials',
  'UUUU': 'Basic Materials',

  // Energy
  'VST': 'Energy',
  'FSLR': 'Energy',
  'TLN': 'Energy',
  'WFRD': 'Energy',
  'ENS': 'Energy',
  'CVX': 'Energy',
  'DINO': 'Energy',
  'DTM': 'Energy',
  'OKE': 'Energy',
  'TPL': 'Energy',
  'AR': 'Energy',
  'XOM': 'Energy',

  // Financials
  'JPM': 'Financials',
  'GS': 'Financials',
  'AXP': 'Financials',
  'SPGI': 'Financials',
  'PNC': 'Financials',
  'ALLY': 'Financials',
  'EWBC': 'Financials',
  'WAL': 'Financials',
  'SOFI': 'Financials',
  'HOOD': 'Financials',
  'MTB': 'Financials',
  'BRK-B': 'Financials',
  'COIN': 'Financials',
  'LMND': 'Financials',

  // Health Care
  'AMGN': 'Health Care',
  'GILD': 'Health Care',
  'UTHR': 'Health Care',
  'EXEL': 'Health Care',
  'HALO': 'Health Care',
  'UHS': 'Health Care',
  'VRTX': 'Health Care',
  'ISRG': 'Health Care',
  'UNH': 'Health Care',
  'LLY': 'Health Care',
  'MRK': 'Health Care',
  'ABT': 'Health Care',
  'HIMS': 'Health Care',
  'TEM': 'Health Care',
  'BMNR': 'Health Care',
  'CRWV': 'Health Care',

  // Crypto-Related
  'BTCUSD': 'Crypto',
  'ETHUSD': 'Crypto',
  'GLXY': 'Crypto',
  'RIOT': 'Crypto',
  'ETHA': 'Crypto',

  // Precious Metals
  'GDX': 'Precious Metals',
  'IAU': 'Precious Metals',
  'AGQ': 'Precious Metals',
  'HL': 'Precious Metals',

  // Index ETFs (broad-market trackers — independent risk vehicles)
  'SPY': 'Index ETF',
  'RSP': 'Index ETF',  // Equal-weight S&P 500 — RSP/SPY breadth gauge
  'QQQ': 'Index ETF',
  'IWM': 'Index ETF',
  'DIA': 'Index ETF',
  // CBOE VIX — canonical UI key; timed:latest + prices mirror VX1! (see futures-proxy.js)
  'VIX': 'Index ETF',
  'SOXL': 'Index ETF',
  'TNA': 'Index ETF',
  'SPHB': 'Index ETF',
  'RPG':  'Index ETF',

  // Sector ETFs (mirror underlying sector, double-counts vs sector
  // names so cap should be aware of overlap).
  'XLB': 'Sector ETF',
  'XLC': 'Sector ETF',
  'XLE': 'Sector ETF',
  'XLF': 'Sector ETF',
  'XLI': 'Sector ETF',
  'XLK': 'Sector ETF',
  'XLP': 'Sector ETF',
  'XLRE': 'Sector ETF',
  'XLU': 'Sector ETF',
  'XLV': 'Sector ETF',
  'XLY': 'Sector ETF',
  'XHB': 'Sector ETF',
  // 2026-06-24 — VanEck / iShares semiconductor sector ETFs (admin add SMH).
  'SMH': 'Sector ETF',
  'SOXX': 'Sector ETF',

  // Thematic ETFs (biotech, lithium, inflation, granny shots etc.)
  'GRNJ': 'Thematic ETF',
  'GRNI': 'Thematic ETF',
  'SPCX': 'Thematic ETF', // 2026-06-12 — SPAC & New Issue ETF; thin history, live quote OK
  'IBB':  'Thematic ETF',
  'INFL': 'Thematic ETF',
  'LIT':  'Thematic ETF',

  // Commodity & Volatility ETFs (futures equivalents)
  'GLD': 'Commodity ETF',
  'SLV': 'Commodity ETF',
  'USO': 'Commodity ETF',
  'VIXY': 'Commodity ETF',
  // P0.7.133 — added so the price-feed cron polls UNG (NG1! proxy) and
  // CPER (HG1! proxy). Required for the futures-proxy fallback registry
  // in worker/futures-proxy.js to have data when TV alerts pause.
  'UNG':  'Commodity ETF',
  'CPER': 'Commodity ETF',

};

// Sector Ratings — as of Apr 20, 2026 (Fundstrat OW/N/UW relative to S&P 500).
// Mirrors the definitive copy in worker/index.js. Delta = active weight vs benchmark (%).
const SECTOR_RATINGS = {
  'Industrials':              { rating: 'overweight',  boost: 5,  delta: 2.5  },
  'Information Technology':   { rating: 'overweight',  boost: 5,  delta: 2.5  },
  'Financials':               { rating: 'overweight',  boost: 4,  delta: 2.2  },
  'Basic Materials':          { rating: 'overweight',  boost: 2,  delta: 0.4  },
  'Communication Services':   { rating: 'overweight',  boost: 1,  delta: 0.2  },
  'Consumer Discretionary':   { rating: 'neutral',     boost: 0,  delta: 0.0  },
  'Real Estate':              { rating: 'neutral',     boost: 0,  delta: 0.0  },
  'Utilities':                { rating: 'neutral',     boost: 0,  delta: 0.0  },
  'Energy':                   { rating: 'underweight', boost: -3, delta: -1.6 },
  'Health Care':              { rating: 'underweight', boost: -4, delta: -2.0 },
  'Consumer Staples':         { rating: 'underweight', boost: -5, delta: -4.0 },
  'Index ETF':                { rating: 'neutral',     boost: 0  },
  'Sector ETF':               { rating: 'neutral',     boost: 0  },
  'Thematic ETF':             { rating: 'neutral',     boost: 0  },
  'Commodity ETF':            { rating: 'neutral',     boost: 0  },
  // Legacy single-bucket key kept for backward compat with stored configs.
  'ETF':                      { rating: 'neutral',     boost: 0  },
  'Crypto':                   { rating: 'neutral',     boost: 0  },
  'Precious Metals':          { rating: 'neutral',     boost: 0  },
};

function getSector(ticker) {
  return SECTOR_MAP[ticker?.toUpperCase()] || null;
}

function getSectorRating(sector) {
  return SECTOR_RATINGS[sector] || { rating: 'neutral', boost: 0 };
}

function getTickersInSector(sector) {
  return Object.keys(SECTOR_MAP).filter(
    ticker => SECTOR_MAP[ticker] === sector
  );
}

function getAllSectors() {
  return Object.keys(SECTOR_RATINGS);
}

// ═══════════════════════════════════════════════════════════════════════════════
// THEMES — 2026-05-28 (Discovery Phase 3)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Themes are a finer-grained grouping than `sector`. Sectors are FactSet-style
// taxonomy ("Information Technology"); themes are *trade narratives* the
// market actually rotates through ("AI infra memory cycle"). One ticker can
// belong to multiple themes (NVDA is in ai_infra_compute AND ai_infra_semicap
// via its broader chip-cycle exposure).
//
// Used by:
//   - CIO memory L11 — surface "this ticker is in `ai_infra_memory`; theme
//     is ACTIVE today (5/6 peers up >2%)"
//   - Promotion Queue THEME_ACTIVE scoring component (Phase 1 of the queue)
//   - Future: theme-rotation-aware sizing
//
// Curated rather than auto-derived: theme membership is editorial work. Add
// new themes as new narratives emerge.

const THEMES = {
  // AI infrastructure stack — driver of 2024-2026 mega-cycle.
  // 2026-06-10 — added APLD (Applied Digital: AI datacenter / GPU-cloud
  // operator). It was the operator's canonical example of a theme name
  // ("APLD is one of the top tickers on the viewport — is that valid?")
  // yet sat in no theme, so theme intelligence could never see it.
  ai_infra_compute:  ["NVDA","AMD","AVGO","MRVL","ANET","CIEN","ARM","SMCI","NBIS","CRDO","ALAB","APLD"],
  ai_infra_memory:   ["MU","WDC","STX","SNDK","HIMX"],
  ai_infra_energy:   ["NEE","VST","CEG","PWR","TLN","NXT","AES","BE","CWEN","NRG","FSLR","ENPH","SEDG","ARRY","SHLS"],
  ai_infra_cooling:  ["VRT","MOD","JCI","DOV","BMI"],
  ai_infra_dc_reit:  ["DLR","EQIX","IRM","COR"],
  ai_infra_semicap:  ["AMAT","LRCX","KLAC","ASML","ENTG","KLIC","ONTO","ICHR"],

  // AI software / data infra.
  ai_software:       ["PLTR","SNOW","DDOG","CRWD","ZS","PANW","NOW","NET","S","CFLT","DT","ESTC","TEAM","MDB"],
  ai_consumer:       ["GOOGL","META","MSFT","ORCL","ADBE","CRM"],

  // Space / defense.
  space_tech:        ["RKLB","ASTS","IRDM","SPCE","LUNR"],
  defense:           ["LMT","RTX","NOC","GD","HII","LDOS","BWXT","BA"],

  // Healthcare narratives.
  weight_loss:       ["LLY","NVO","VKTX","ALT","TERN","SLRX"],
  obesity_adjacent:  ["ABBV","AMGN","PFE","REGN"],

  // Crypto + crypto-adjacent.
  crypto_miners:     ["RIOT","MARA","CIFR","WULF","IREN","HUT","BTBT","CLSK","CORZ","GREE"],
  crypto_proxies:    ["COIN","MSTR","HOOD"],
  crypto_etf:        ["IBIT","BITO","ETHE","BTCO","FBTC","ETHA"],

  // Fintech.
  fintech:           ["SOFI","UPST","NU","AFRM","HOOD","PYPL","SQ","TOST","NWG","ADYEY"],
  banks_money_center:["JPM","BAC","WFC","C","GS","MS"],
  banks_regional:    ["KEY","CFG","RF","HBAN","FITB","CMA","ZION","EWBC","BNY"],

  // Energy + commodities.
  oil_gas:           ["XOM","CVX","COP","EOG","DVN","SLB","HAL","OXY","PSX","MPC","VLO"],
  oil_services:      ["SLB","HAL","BKR","NOV","CHX"],
  uranium_nuclear:   ["UEC","DNN","CCJ","NXE","UUUU","SMR","BWXT","LEU","OKLO"],
  refiners:          ["VLO","MPC","PSX","DK","DINO"],
  metals_miners:     ["FCX","NEM","GOLD","AU","AEM","KGC","HMY","AG","RGLD","SAND"],
  uranium_etf:       ["URA","URNM","NLR"],

  // Consumer / cyclical.
  ev_battery:        ["TSLA","RIVN","LCID","CHPT","ALB","LITE","ALU","LAC","SQM"],
  travel_leisure:    ["BKNG","ABNB","MAR","HLT","UAL","DAL","CCL","RCL","NCLH","LVS","WYNN"],
  ecom_logistics:    ["AMZN","SHOP","FDX","UPS","JBHT","ODFL","XPO","CHRW"],

  // Cyber.
  cybersecurity:     ["CRWD","ZS","PANW","NET","S","FTNT","OKTA","CYBR","RBRK","TENB"],

  // Country / cross-region ETFs (Phase 5 — referenced by macro tracker).
  country_us_broad:  ["SPY","RSP","QQQ","IWM","DIA","VTI"],
  country_korea:     ["EWY"],
  country_germany:   ["EWG"],
  country_japan:     ["EWJ","DXJ"],
  country_china:     ["FXI","MCHI","KWEB","ASHR","YINN"],
  country_india:     ["INDA","SMIN","EPI"],
  country_brazil:    ["EWZ","BRZU"],
  country_taiwan:    ["EWT","TSM"],
  country_uk:        ["EWU"],
  country_emerging:  ["EEM","VWO","SPEM"],
  country_developed: ["EFA","VEA","IDEV"],

  // Cross-asset ETFs (Phase 5).
  cross_asset_dollar:["UUP","UDN"],
  cross_asset_gold:  ["GLD","IAU","SGOL"],
  cross_asset_silver:["SLV","SLVO"],
  cross_asset_oil:   ["USO","BNO","UCO"],
  cross_asset_nat_gas:["UNG","BOIL","KOLD"],
  cross_asset_rates: ["TLT","IEF","SHY","TLH"],
  cross_asset_credit:["HYG","LQD","JNK","EMB"],
  cross_asset_fx:    ["FXE","FXY","FXB","FXA","CYB"],
  cross_asset_vix:   ["VXX","UVXY","SVXY","VIXY"],
};

// Build a reverse index ticker → [themes] for O(1) lookup.
const _THEMES_BY_TICKER = (() => {
  const out = {};
  for (const [theme, syms] of Object.entries(THEMES)) {
    for (const s of syms) {
      const k = String(s || "").toUpperCase();
      if (!k) continue;
      if (!out[k]) out[k] = [];
      out[k].push(theme);
    }
  }
  return out;
})();

function getThemesForTicker(ticker) {
  return _THEMES_BY_TICKER[String(ticker || "").toUpperCase()] || [];
}

function getTickersInTheme(theme) {
  return THEMES[theme] || [];
}

function getAllThemes() {
  return Object.keys(THEMES);
}

// Theme is "active" when ≥ thresholdPct of its members moved > moveThresholdPct
// in the same direction today. `livePriceMap` is the timed:prices KV blob shape:
//   { [SYM]: { dp: dayChangePct, ... } }
function computeThemeActivity(themeName, livePriceMap, opts = {}) {
  const moveThreshPct = Number(opts.moveThresholdPct) || 2.0;
  const minActivePct = Number(opts.minActivePct) || 0.30;
  const members = THEMES[themeName] || [];
  if (members.length === 0) return null;
  const map = (livePriceMap && typeof livePriceMap === "object")
    ? (livePriceMap.prices && typeof livePriceMap.prices === "object" ? livePriceMap.prices : livePriceMap)
    : null;
  if (!map) return { theme: themeName, members: members.length, has_data: 0, up: 0, down: 0, top_up: [], top_down: [], active: false };
  let up = 0, down = 0, hasData = 0;
  const upDetail = [], downDetail = [];
  for (const sym of members) {
    const row = map[sym];
    if (!row) continue;
    const dp = Number(row.dp ?? row.day_change_pct ?? row.change_pct);
    if (!Number.isFinite(dp)) continue;
    hasData++;
    if (dp >= moveThreshPct) {
      up++;
      upDetail.push({ ticker: sym, dp: Math.round(dp * 10) / 10 });
    } else if (dp <= -moveThreshPct) {
      down++;
      downDetail.push({ ticker: sym, dp: Math.round(dp * 10) / 10 });
    }
  }
  upDetail.sort((a, b) => b.dp - a.dp);
  downDetail.sort((a, b) => a.dp - b.dp);
  const activeDir = (up >= members.length * minActivePct) ? "up"
                  : (down >= members.length * minActivePct) ? "down"
                  : null;
  return {
    theme: themeName,
    members: members.length,
    has_data: hasData,
    up,
    down,
    top_up: upDetail.slice(0, 5),
    top_down: downDetail.slice(0, 5),
    active: !!activeDir,
    active_direction: activeDir,
  };
}

// Returns the activity payload for ALL themes a ticker is in.
function getTickerThemeActivity(ticker, livePriceMap, opts = {}) {
  const themes = getThemesForTicker(ticker);
  if (themes.length === 0) return null;
  return themes.map((t) => computeThemeActivity(t, livePriceMap, opts)).filter(Boolean);
}

// Returns all currently-active themes, sorted by activity strength.
function activeThemesNow(livePriceMap, opts = {}) {
  const out = [];
  for (const t of Object.keys(THEMES)) {
    const r = computeThemeActivity(t, livePriceMap, opts);
    if (r?.active) out.push(r);
  }
  out.sort((a, b) => Math.max(b.up, b.down) - Math.max(a.up, a.down));
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TICKER TYPE CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

const TICKER_TYPE_MAP = {
  // Sector ETFs
  'XLB': 'sector_etf', 'XLC': 'sector_etf', 'XLE': 'sector_etf',
  'XLF': 'sector_etf', 'XLI': 'sector_etf', 'XLK': 'sector_etf',
  'XLP': 'sector_etf', 'XLRE': 'sector_etf', 'XLU': 'sector_etf',
  'XLV': 'sector_etf', 'XLY': 'sector_etf', 'SOXL': 'sector_etf',
  'XHB': 'sector_etf',

  // Broad ETFs
  'SPY': 'broad_etf', 'RSP': 'broad_etf', 'QQQ': 'broad_etf', 'IWM': 'broad_etf',
  'TNA': 'broad_etf', 'DIA': 'broad_etf',
  'RPG': 'broad_etf', 'SPHB': 'broad_etf',

  // Thematic ETFs
  'IBB':  'thematic_etf', 'INFL': 'thematic_etf',
  'LIT':  'thematic_etf', 'GRNJ': 'thematic_etf',
  'GRNI': 'thematic_etf',

  // Commodity ETFs
  'GLD': 'commodity_etf', 'SLV': 'commodity_etf',
  'USO': 'commodity_etf', 'VIXY': 'commodity_etf',

  // Crypto-adjacent equities
  'MSTR': 'crypto_adj', 'COIN': 'crypto_adj', 'HOOD': 'crypto_adj',
  'RIOT': 'crypto_adj', 'GLXY': 'crypto_adj',

  // Direct crypto
  'BTCUSD': 'crypto', 'ETHUSD': 'crypto', 'ETHA': 'crypto',

  // Precious metals
  'GOLD': 'precious_metal', 'GDX': 'precious_metal',
  'IAU': 'precious_metal', 'AGQ': 'precious_metal',
  'HL': 'precious_metal', 'AU': 'precious_metal',
  'RGLD': 'precious_metal', 'CCJ': 'precious_metal',

  // Growth / High-beta
  'TSLA': 'growth', 'NVDA': 'growth', 'AMD': 'growth', 'PLTR': 'growth',
  'RBLX': 'growth', 'IONQ': 'growth', 'APP': 'growth', 'HIMS': 'growth',
  'SOFI': 'growth', 'RDDT': 'growth', 'CVNA': 'growth', 'JOBY': 'growth',
  'RKLB': 'growth', 'NBIS': 'growth', 'IREN': 'growth', 'APLD': 'growth',
  'CRWD': 'growth', 'PANW': 'growth', 'MDB': 'growth', 'PATH': 'growth',
  'NFLX': 'growth', 'AVGO': 'growth', 'ANET': 'growth', 'META': 'growth',
  'TWLO': 'growth', 'FSLR': 'growth', 'BE': 'growth',

  // Value / Defensive
  'WMT': 'value', 'COST': 'value', 'KO': 'value', 'BRK-B': 'value',
  'JPM': 'value', 'GS': 'value', 'PNC': 'value', 'ALLY': 'value',
  'MSFT': 'value', 'AAPL': 'value', 'GOOGL': 'value',
  'UNH': 'value', 'AMGN': 'value', 'GILD': 'value',
  'UTHR': 'value', 'CAT': 'value', 'DE': 'value', 'GE': 'value',
  'TJX': 'value', 'INTU': 'value', 'CSCO': 'value', 'SPGI': 'value',
  'WM': 'value', 'TT': 'value', 'ETN': 'value', 'PH': 'value',
  'EMR': 'value', 'ULTA': 'value', 'MNST': 'value', 'NKE': 'value',
  'ACN': 'value',

  // Large cap
  'AMZN': 'large_cap', 'ORCL': 'large_cap', 'BA': 'large_cap',
  'LRCX': 'large_cap', 'KLAC': 'large_cap', 'CDNS': 'large_cap',
  'MU': 'large_cap', 'EXPE': 'large_cap', 'STX': 'large_cap',
  'WDC': 'large_cap', 'BABA': 'large_cap', 'TSM': 'large_cap',
  'CRM': 'large_cap', 'ON': 'large_cap',

  // Small/Micro cap
  'BMNR': 'small_cap', 'CRWV': 'small_cap', 'GRNY': 'small_cap',
  'XYZ': 'small_cap',
};

function getTickerType(ticker) {
  const t = ticker?.toUpperCase();
  if (!t) return 'unknown';
  if (TICKER_TYPE_MAP[t]) return TICKER_TYPE_MAP[t];
  const sector = SECTOR_MAP[t];
  if (!sector) return 'unknown';
  if (sector === 'ETF') return 'broad_etf';
  if (sector === 'Crypto') return 'crypto';
  if (sector === 'Precious Metals') return 'precious_metal';
  return 'large_cap';
}

const SECTOR_ETF_MAP = {
  "Information Technology": "XLK",
  "Consumer Discretionary": "XLY",
  "Communication Services": "XLC",
  "Healthcare": "XLV",
  "Health Care": "XLV",
  "Financials": "XLF",
  "Industrials": "XLI",
  "Consumer Staples": "XLP",
  "Energy": "XLE",
  "Utilities": "XLU",
  "Real Estate": "XLRE",
  "Basic Materials": "XLB",
};

function getSectorETF(sector) {
  return SECTOR_ETF_MAP[sector] || null;
}

const TICKER_PROXY_MAP = {
  // Semiconductor cluster
  NVDA: { peers: ["AMD", "AVGO", "MRVL", "QCOM"], etf: "SOXL", sector_etf: "XLK" },
  AMD:  { peers: ["NVDA", "AVGO", "MRVL"], etf: "SOXL", sector_etf: "XLK" },
  AVGO: { peers: ["NVDA", "AMD", "MRVL"], etf: "SOXL", sector_etf: "XLK" },
  MRVL: { peers: ["NVDA", "AMD", "AVGO"], etf: "SOXL", sector_etf: "XLK" },
  QCOM: { peers: ["NVDA", "AMD", "AVGO"], etf: "SOXL", sector_etf: "XLK" },

  // Mega-cap tech
  AAPL: { peers: ["MSFT", "GOOGL"], etf: "QQQ", sector_etf: "XLK" },
  MSFT: { peers: ["AAPL", "GOOGL", "CRM"], etf: "QQQ", sector_etf: "XLK" },
  GOOGL:{ peers: ["META", "MSFT"], etf: "QQQ", sector_etf: "XLC" },
  META: { peers: ["GOOGL", "SNAP", "PINS"], etf: "QQQ", sector_etf: "XLC" },

  // E-commerce / Cloud
  AMZN: { peers: ["WMT", "TGT", "COST", "SHOP"], etf: "XLY", sector_etf: "XLY" },
  SHOP: { peers: ["AMZN", "SQ", "MELI"], etf: "QQQ", sector_etf: "XLK" },

  // EV / Auto
  TSLA: { peers: ["RIVN", "NIO", "LI"], etf: "XLY", sector_etf: "XLY" },

  // Energy cluster
  XOM:  { peers: ["CVX", "COP", "SLB"], etf: "XLE", commodity: "CL1!" },
  CVX:  { peers: ["XOM", "COP"], etf: "XLE", commodity: "CL1!" },
  COP:  { peers: ["XOM", "CVX"], etf: "XLE", commodity: "CL1!" },
  SLB:  { peers: ["HAL", "BKR"], etf: "XLE", commodity: "CL1!" },

  // Financials cluster
  JPM:  { peers: ["GS", "BAC", "MS"], etf: "XLF", sector_etf: "XLF" },
  GS:   { peers: ["JPM", "MS"], etf: "XLF", sector_etf: "XLF" },
  BAC:  { peers: ["JPM", "WFC", "C"], etf: "XLF", sector_etf: "XLF" },

  // Defense / Aerospace
  LMT:  { peers: ["RTX", "NOC", "GD", "BA"], etf: "ITA", sector_etf: "XLI" },
  RTX:  { peers: ["LMT", "NOC", "GD"], etf: "ITA", sector_etf: "XLI" },
  BA:   { peers: ["LMT", "RTX", "GE"], etf: "ITA", sector_etf: "XLI" },

  // Healthcare / Biotech
  LLY:  { peers: ["NVO", "ABBV", "JNJ"], etf: "XBI", sector_etf: "XLV" },
  UNH:  { peers: ["CI", "HUM", "ELV"], etf: "XLV", sector_etf: "XLV" },

  // Gold miners
  GLD:  { peers: ["SLV", "GDX"], commodity: "GC1!" },
  NEM:  { peers: ["GOLD", "AEM"], etf: "GDX", commodity: "GC1!" },
  RGLD: { peers: ["NEM", "GOLD", "AEM"], etf: "GDX", commodity: "GC1!" },

  // AI / Software cluster
  PLTR: { peers: ["AI", "SNOW", "DDOG"], etf: "QQQ", sector_etf: "XLK" },
  CRM:  { peers: ["NOW", "WDAY", "HUBS"], etf: "QQQ", sector_etf: "XLK" },
  NOW:  { peers: ["CRM", "WDAY"], etf: "QQQ", sector_etf: "XLK" },

  // Retail
  WMT:  { peers: ["COST", "TGT", "AMZN"], etf: "XLP", sector_etf: "XLP" },
  COST: { peers: ["WMT", "TGT"], etf: "XLP", sector_etf: "XLP" },

  // Industrials / Infra
  CAT:  { peers: ["DE", "CNH"], etf: "XLI", sector_etf: "XLI" },
  DE:   { peers: ["CAT", "CNH"], etf: "XLI", sector_etf: "XLI" },

  // Broad index ETFs — RSP/SPY is the equal-weight vs cap-weight breadth gauge
  SPY: { peers: ["RSP", "QQQ", "IWM", "DIA"], etf: "SPY", gauge_pair: "RSP/SPY" },
  RSP: { peers: ["SPY", "QQQ", "IWM", "DIA"], etf: "RSP", gauge_pair: "RSP/SPY" },

  // Crypto — leading indicators for equities
  // BTC leads SPY/QQQ (risk-on/risk-off barometer)
  // ETH leads IWM/Financials (speculative risk appetite)
  BTCUSD: { peers: ["ETHUSD"], leads: ["SPY", "QQQ"], etf: "QQQ" },
  ETHUSD: { peers: ["BTCUSD"], leads: ["IWM", "XLF"], etf: "IWM" },

  // Equities that correlate with crypto sentiment
  COIN: { peers: ["MSTR", "MARA", "RIOT"], etf: "QQQ", sector_etf: "XLF", crypto_proxy: "BTCUSD" },
  MSTR: { peers: ["COIN", "MARA"], etf: "QQQ", crypto_proxy: "BTCUSD" },
};

function getProxies(ticker) {
  return TICKER_PROXY_MAP[ticker] || null;
}

module.exports = {
  SECTOR_MAP,
  SECTOR_RATINGS,
  SECTOR_ETF_MAP,
  TICKER_TYPE_MAP,
  TICKER_PROXY_MAP,
  THEMES,
  getSector,
  getSectorRating,
  getSectorETF,
  getTickersInSector,
  getAllSectors,
  getTickerType,
  getProxies,
  // 2026-05-28 — Discovery Phase 3 theme helpers
  getThemesForTicker,
  getTickersInTheme,
  getAllThemes,
  computeThemeActivity,
  getTickerThemeActivity,
  activeThemesNow,
};
