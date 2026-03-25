// Sector Mapping — 229-ticker active universe
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
  'KLAC': 'Information Technology',
  'ANET': 'Information Technology',
  'CDNS': 'Information Technology',
  'PANW': 'Information Technology',
  'PLTR': 'Information Technology',
  'MDB': 'Information Technology',
  'PATH': 'Information Technology',
  'PSTG': 'Information Technology',
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
  'BK': 'Financials',
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
  'UNH': 'Healthcare',
  'LLY': 'Healthcare',
  'MRK': 'Healthcare',
  'ABT': 'Healthcare',
  'HIMS': 'Healthcare',
  'TEM': 'Healthcare',
  'BMNR': 'Healthcare',
  'CRWV': 'Healthcare',

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

  // ETFs & Index Tracking
  'SPY': 'ETF',
  'QQQ': 'ETF',
  'IWM': 'ETF',
  'SOXL': 'ETF',
  'TNA': 'ETF',
  'DIA': 'ETF',
  'XHB': 'ETF',
  'XLB': 'ETF',
  'XLC': 'ETF',
  'XLE': 'ETF',
  'XLF': 'ETF',
  'XLI': 'ETF',
  'XLK': 'ETF',
  'XLP': 'ETF',
  'XLRE': 'ETF',
  'XLU': 'ETF',
  'XLV': 'ETF',
  'XLY': 'ETF',

  // Commodity & Volatility ETFs (futures equivalents)
  'GLD': 'Commodity ETF',
  'SLV': 'Commodity ETF',
  'USO': 'Commodity ETF',
  'VIXY': 'Commodity ETF',
};

// Sector Ratings — as of Feb 13, 2026 (S&P Index Weight vs FSI Weight)
const SECTOR_RATINGS = {
  'Healthcare':               { rating: 'neutral',     boost: 0,  spWeight: 8.2,  fsiWeight: 8.2,  delta: 0.0  },
  'Health Care':              { rating: 'neutral',     boost: 0,  spWeight: 8.2,  fsiWeight: 8.2,  delta: 0.0  },
  'Information Technology':   { rating: 'overweight',  boost: 3,  spWeight: 26.7, fsiWeight: 27.1, delta: 0.4  },
  'Energy':                   { rating: 'overweight',  boost: 5,  spWeight: 2.8,  fsiWeight: 5.1,  delta: 2.3  },
  'Financials':               { rating: 'overweight',  boost: 3,  spWeight: 10.8, fsiWeight: 11.4, delta: 0.6  },
  'Industrials':              { rating: 'overweight',  boost: 5,  spWeight: 7.5,  fsiWeight: 9.8,  delta: 2.3  },
  'Utilities':                { rating: 'neutral',     boost: 0,  spWeight: 1.9,  fsiWeight: 1.9,  delta: 0.0  },
  'Communication Services':   { rating: 'neutral',     boost: 0,  spWeight: 8.4,  fsiWeight: 8.4,  delta: 0.0  },
  'Basic Materials':          { rating: 'overweight',  boost: 3,  spWeight: 1.7,  fsiWeight: 3.0,  delta: 1.3  },
  'Consumer Discretionary':   { rating: 'underweight', boost: -3, spWeight: 9.3,  fsiWeight: 7.3,  delta: -2.0 },
  'Consumer Staples':         { rating: 'underweight', boost: -5, spWeight: 5.1,  fsiWeight: 3.0,  delta: -2.1 },
  'Real Estate':              { rating: 'underweight', boost: -3, spWeight: 1.6,  fsiWeight: 0.0,  delta: -1.6 },
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
  'SPY': 'broad_etf', 'QQQ': 'broad_etf', 'IWM': 'broad_etf',
  'TNA': 'broad_etf', 'DIA': 'broad_etf',

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
  'JPM': 'value', 'GS': 'value', 'PNC': 'value', 'BK': 'value',
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
  getSector,
  getSectorRating,
  getSectorETF,
  getTickersInSector,
  getAllSectors,
  getTickerType,
  getProxies,
};
