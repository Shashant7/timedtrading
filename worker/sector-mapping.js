// Sector Mapping for S&P 500 Stocks
// Maps tickers to their GICS sectors

const SECTOR_MAP = {
  // Consumer Discretionary
  'AMZN': 'Consumer Discretionary',
  'TSLA': 'Consumer Discretionary',
  'NKE': 'Consumer Discretionary',
  'TJX': 'Consumer Discretionary',
  'HD': 'Consumer Discretionary',
  'MCD': 'Consumer Discretionary',
  'SBUX': 'Consumer Discretionary',
  'LOW': 'Consumer Discretionary',
  'NFLX': 'Consumer Discretionary',
  'BKNG': 'Consumer Discretionary',
  'CMG': 'Consumer Discretionary',
  'ABNB': 'Consumer Discretionary',
  'EXPE': 'Consumer Discretionary',
  'RBLX': 'Consumer Discretionary',
  'ULTA': 'Consumer Discretionary',
  'SHOP': 'Consumer Discretionary',
  'COST': 'Consumer Discretionary',
  'LULU': 'Consumer Discretionary',
  'DKNG': 'Consumer Discretionary',
  'CVNA': 'Consumer Discretionary',
  'W': 'Consumer Discretionary',
  'WMT': 'Consumer Discretionary',
  'CELH': 'Consumer Discretionary',
  'MNST': 'Consumer Discretionary',
  'SWK': 'Consumer Discretionary',
  'BABA': 'Consumer Discretionary',
  'JD': 'Consumer Discretionary',
  'GRAB': 'Consumer Discretionary',
  'KWEB': 'Consumer Discretionary',
  'KO': 'Consumer Staples',
  'WM': 'Industrials',
  
  // Industrials
  'CAT': 'Industrials',
  'GE': 'Industrials',
  'BA': 'Industrials',
  'HON': 'Industrials',
  'RTX': 'Industrials',
  'EMR': 'Industrials',
  'ETN': 'Industrials',
  'DE': 'Industrials',
  'PH': 'Industrials',
  'CSX': 'Industrials',
  'UNP': 'Industrials',
  'UPS': 'Industrials',
  'FDX': 'Industrials',
  'LMT': 'Industrials',
  'NOC': 'Industrials',
  'GD': 'Industrials',
  'TT': 'Industrials',
  'PWR': 'Industrials',
  'AWI': 'Industrials',
  'WTS': 'Industrials',
  'DY': 'Industrials',
  'FIX': 'Industrials',
  'ITT': 'Industrials',
  'STRL': 'Industrials',
  'AXON': 'Industrials',
  'JCI': 'Industrials',
  'HII': 'Industrials',
  'BWXT': 'Industrials',
  'KTOS': 'Industrials',
  'AVAV': 'Industrials',
  'EME': 'Industrials',
  'MTZ': 'Industrials',
  'ENS': 'Industrials',
  'DCI': 'Industrials',
  'B': 'Industrials',
  'IBP': 'Industrials',
  'IESC': 'Industrials',
  'GEV': 'Industrials',
  'JOBY': 'Industrials',
  'RKLB': 'Industrials',
  'ASTS': 'Industrials',
  
  // Information Technology
  'AAPL': 'Information Technology',
  'MSFT': 'Information Technology',
  'NVDA': 'Information Technology',
  'AVGO': 'Information Technology',
  'AMD': 'Information Technology',
  'ORCL': 'Information Technology',
  'CRM': 'Information Technology',
  'ADBE': 'Information Technology',
  'INTC': 'Information Technology',
  'CSCO': 'Information Technology',
  'QCOM': 'Information Technology',
  'TXN': 'Information Technology',
  'AMAT': 'Information Technology',
  'LRCX': 'Information Technology',
  'KLAC': 'Information Technology',
  'ANET': 'Information Technology',
  'CDNS': 'Information Technology',
  'CRWD': 'Information Technology',
  'PANW': 'Information Technology',
  'PLTR': 'Information Technology',
  'MDB': 'Information Technology',
  'PATH': 'Information Technology',
  'QLYS': 'Information Technology',
  'PEGA': 'Information Technology',
  'IOT': 'Information Technology',
  'PSTG': 'Information Technology',
  'MU': 'Information Technology',
  'APLD': 'Information Technology',
  'APP': 'Information Technology',
  'ARM': 'Information Technology',
  'TSM': 'Information Technology',
  'ON': 'Information Technology',
  'SMCI': 'Information Technology',
  'HUBS': 'Information Technology',
  'WDAY': 'Information Technology',
  'INTU': 'Information Technology',
  'CLS': 'Information Technology',
  'LITE': 'Information Technology',
  'STX': 'Information Technology',
  'WDC': 'Information Technology',
  'SNDK': 'Information Technology',
  'AGYS': 'Information Technology',
  'SANM': 'Information Technology',
  'IONQ': 'Information Technology',
  'IREN': 'Information Technology',
  'SPOT': 'Communication Services',
  'U': 'Communication Services',
  'LMND': 'Financials',
  'MSTR': 'Information Technology',
  'COIN': 'Financials',
  'IBKR': 'Financials',
  'MTB': 'Financials',
  'OPEN': 'Real Estate',
  'NXT': 'Real Estate',
  'PYPL': 'Financials',
  'TLN': 'Utilities',
  'WFRD': 'Energy',
  'PI': 'Information Technology',
  'SGI': 'Industrials',
  'MLI': 'Industrials',
  'CRS': 'Basic Materials',
  'AEHR': 'Information Technology',
  'AYI': 'Industrials',
  'TEM': 'Healthcare',
  
  // Communication Services
  'META': 'Communication Services',
  'GOOGL': 'Communication Services',
  'GOOG': 'Communication Services',
  'NFLX': 'Communication Services',
  'DIS': 'Communication Services',
  'CMCSA': 'Communication Services',
  'VZ': 'Communication Services',
  'T': 'Communication Services',
  'TWLO': 'Communication Services',
  'RDDT': 'Communication Services',
  
  // Basic Materials
  'LIN': 'Basic Materials',
  'APD': 'Basic Materials',
  'ECL': 'Basic Materials',
  'SHW': 'Basic Materials',
  'PPG': 'Basic Materials',
  'FCX': 'Basic Materials',
  'NEM': 'Basic Materials',
  'ALB': 'Basic Materials',
  'MP': 'Basic Materials',
  'NEU': 'Basic Materials',
  'AU': 'Basic Materials',
  'CCJ': 'Basic Materials',
  'RGLD': 'Basic Materials',
  'SN': 'Basic Materials',
  
  // Energy
  'XOM': 'Energy',
  'CVX': 'Energy',
  'SLB': 'Energy',
  'EOG': 'Energy',
  'COP': 'Energy',
  'MPC': 'Energy',
  'PSX': 'Energy',
  'VST': 'Energy',
  'FSLR': 'Energy',
  
  // Financials
  'JPM': 'Financials',
  'BAC': 'Financials',
  'WFC': 'Financials',
  'GS': 'Financials',
  'MS': 'Financials',
  'C': 'Financials',
  'AXP': 'Financials',
  'COF': 'Financials',
  'SPGI': 'Financials',
  'BRK.B': 'Financials',
  'MCO': 'Financials',
  'BLK': 'Financials',
  'SCHW': 'Financials',
  'PNC': 'Financials',
  'BK': 'Financials',
  'TFC': 'Financials',
  'USB': 'Financials',
  'ALLY': 'Financials',
  'EWBC': 'Financials',
  'WAL': 'Financials',
  'SOFI': 'Financials',
  'HOOD': 'Financials',
  
  // Real Estate
  'AMT': 'Real Estate',
  'PLD': 'Real Estate',
  'EQIX': 'Real Estate',
  'PSA': 'Real Estate',
  'WELL': 'Real Estate',
  'SPG': 'Real Estate',
  'O': 'Real Estate',
  'DLR': 'Real Estate',
  'VICI': 'Real Estate',
  'EXPI': 'Real Estate',
  
  // Healthcare
  'UNH': 'Healthcare',
  'JNJ': 'Healthcare',
  'LLY': 'Healthcare',
  'ABBV': 'Healthcare',
  'MRK': 'Healthcare',
  'TMO': 'Healthcare',
  'ABT': 'Healthcare',
  'DHR': 'Healthcare',
  'BMY': 'Healthcare',
  'AMGN': 'Healthcare',
  'GILD': 'Healthcare',
  'REGN': 'Healthcare',
  'VRTX': 'Healthcare',
  'BIIB': 'Healthcare',
  'UTHR': 'Healthcare',
  'HIMS': 'Healthcare',
  'NBIS': 'Healthcare',
  
  // Utilities
  'NEE': 'Utilities',
  'DUK': 'Utilities',
  'SO': 'Utilities',
  'D': 'Utilities',
  'AEP': 'Utilities',
  'SRE': 'Utilities',
  'EXC': 'Utilities',
  'XEL': 'Utilities',
  'WEC': 'Utilities',
  'ES': 'Utilities',
  'PEG': 'Utilities',
  'ETR': 'Utilities',
  'FE': 'Utilities',
  'AEE': 'Utilities',

  // ETFs & Index Tracking
  'QQQ': 'ETF',
  'SPY': 'ETF',
  'IWM': 'ETF',
  'SOXL': 'ETF',
  'TNA': 'ETF',
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
  'AAPU': 'ETF',

  // Crypto-Related
  'BTCUSD': 'Crypto',
  'ETHUSD': 'Crypto',
  'GLXY': 'Crypto',
  'BTBT': 'Crypto',
  'RIOT': 'Crypto',
  'ETHA': 'Crypto',
  'ETHT': 'Crypto',

  // Precious Metals
  'GOLD': 'Precious Metals',
  // 'SILVER': 'Precious Metals',  // removed — non-Alpaca
  'GLD': 'Precious Metals',
  'GDX': 'Precious Metals',
  'GDXJ': 'Precious Metals',
  'IAU': 'Precious Metals',
  'SLV': 'Precious Metals',
  'AGQ': 'Precious Metals',
  'HL': 'Precious Metals',
  'UUUU': 'Basic Materials',

  // Small/Micro Cap
  'BMNR': 'Healthcare',
  // 'CRCL': 'Healthcare',  // removed — non-Alpaca
  'CRVS': 'Healthcare',
  'CRWV': 'Healthcare',
  'FIG': 'Financials',
  'GRNY': 'Consumer Discretionary',
  'IBRX': 'Healthcare',
  'NBIS': 'Healthcare',
  'ONDS': 'Information Technology',
  'SBET': 'Consumer Discretionary',
  'BE': 'Industrials',
  'XYZ': 'Consumer Discretionary',
};

// Sector Ratings — as of Feb 13, 2026 (S&P Index Weight vs FSI Weight)
const SECTOR_RATINGS = {
  'Healthcare':               { rating: 'overweight',  boost: 5,  spWeight: 8.2,  fsiWeight: 10.1, delta: 1.9  },
  'Information Technology':   { rating: 'overweight',  boost: 3,  spWeight: 26.7, fsiWeight: 27.1, delta: 0.4  },
  'Energy':                   { rating: 'overweight',  boost: 5,  spWeight: 2.8,  fsiWeight: 5.1,  delta: 2.3  },
  'Financials':               { rating: 'overweight',  boost: 3,  spWeight: 10.8, fsiWeight: 11.4, delta: 0.6  },
  'Industrials':              { rating: 'overweight',  boost: 5,  spWeight: 7.5,  fsiWeight: 9.8,  delta: 2.3  },
  'Utilities':                { rating: 'neutral',     boost: 0,  spWeight: 1.9,  fsiWeight: 1.9,  delta: 0.0  },
  'Communication Services':   { rating: 'neutral',     boost: 0,  spWeight: 8.4,  fsiWeight: 8.4,  delta: 0.0  },
  'Basic Materials':          { rating: 'neutral',     boost: 0,  spWeight: 1.7,  fsiWeight: 1.7,  delta: 0.0  },
  'Consumer Discretionary':   { rating: 'underweight', boost: -3, spWeight: 9.3,  fsiWeight: 7.3,  delta: -2.0 },
  'Consumer Staples':         { rating: 'underweight', boost: -5, spWeight: 5.1,  fsiWeight: 3.0,  delta: -2.1 },
  'Real Estate':              { rating: 'underweight', boost: -3, spWeight: 1.6,  fsiWeight: 0.0,  delta: -1.6 },
  'ETF':                      { rating: 'neutral',     boost: 0  },
  'Crypto':                   { rating: 'neutral',     boost: 0  },
  'Precious Metals':          { rating: 'neutral',     boost: 0  },
};

// Get sector for a ticker
function getSector(ticker) {
  return SECTOR_MAP[ticker?.toUpperCase()] || null;
}

// Get sector rating
function getSectorRating(sector) {
  return SECTOR_RATINGS[sector] || { rating: 'neutral', boost: 0 };
}

// Get all tickers in a sector
function getTickersInSector(sector) {
  return Object.keys(SECTOR_MAP).filter(
    ticker => SECTOR_MAP[ticker] === sector
  );
}

// Get all sectors
function getAllSectors() {
  return Object.keys(SECTOR_RATINGS);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TICKER TYPE CLASSIFICATION (Phase 3a)
//
// Classifies tickers into investment type categories for swing trading:
//   sector_etf:     Sector-tracking ETFs (XLK, XLF, etc.)
//   broad_etf:      Broad market ETFs (SPY, QQQ, IWM)
//   large_cap:      Blue-chip, well-established companies
//   growth:         High-growth, high-beta names
//   value:          Value-oriented, defensive names
//   crypto_adj:     Crypto-adjacent equities (MSTR, COIN, HOOD)
//   crypto:         Direct crypto exposure
//   precious_metal: Gold/silver miners and ETFs
//   small_cap:      Small/micro cap names
// ═══════════════════════════════════════════════════════════════════════════════

const TICKER_TYPE_MAP = {
  // Sector ETFs
  'XLB': 'sector_etf', 'XLC': 'sector_etf', 'XLE': 'sector_etf',
  'XLF': 'sector_etf', 'XLI': 'sector_etf', 'XLK': 'sector_etf',
  'XLP': 'sector_etf', 'XLRE': 'sector_etf', 'XLU': 'sector_etf',
  'XLV': 'sector_etf', 'XLY': 'sector_etf', 'SOXL': 'sector_etf',

  // Broad ETFs
  'SPY': 'broad_etf', 'QQQ': 'broad_etf', 'IWM': 'broad_etf',
  'AAPU': 'broad_etf', 'TNA': 'broad_etf',

  // Crypto-adjacent equities
  'MSTR': 'crypto_adj', 'COIN': 'crypto_adj', 'HOOD': 'crypto_adj',
  'RIOT': 'crypto_adj', 'GLXY': 'crypto_adj',

  // Direct crypto
  'BTCUSD': 'crypto', 'ETHUSD': 'crypto', 'ETHA': 'crypto', 'ETHT': 'crypto',

  // Precious metals
  'GOLD': 'precious_metal', 'GLD': 'precious_metal', 'GDX': 'precious_metal',
  'GDXJ': 'precious_metal', 'IAU': 'precious_metal', 'SLV': 'precious_metal',
  'AGQ': 'precious_metal', 'HL': 'precious_metal', 'AU': 'precious_metal',
  'RGLD': 'precious_metal', 'CCJ': 'precious_metal',

  // Growth / High-beta
  'TSLA': 'growth', 'NVDA': 'growth', 'AMD': 'growth', 'PLTR': 'growth',
  'RBLX': 'growth', 'IONQ': 'growth', 'APP': 'growth', 'HIMS': 'growth',
  'SOFI': 'growth', 'RDDT': 'growth', 'CVNA': 'growth', 'JOBY': 'growth',
  'RKLB': 'growth', 'NBIS': 'growth', 'IREN': 'growth', 'APLD': 'growth',
  'CRWD': 'growth', 'PANW': 'growth', 'MDB': 'growth', 'PATH': 'growth',
  'NFLX': 'growth', 'AVGO': 'growth', 'ANET': 'growth', 'META': 'growth',
  'W': 'growth', 'TWLO': 'growth', 'FSLR': 'growth', 'BE': 'growth',

  // Value / Defensive
  'WMT': 'value', 'COST': 'value', 'KO': 'value', 'BRK-B': 'value',
  'JPM': 'value', 'GS': 'value', 'PNC': 'value', 'BK': 'value',
  'MSFT': 'value', 'AAPL': 'value', 'GOOGL': 'value', 'GOOG': 'value',
  'JNJ': 'value', 'UNH': 'value', 'AMGN': 'value', 'GILD': 'value',
  'UTHR': 'value', 'CAT': 'value', 'DE': 'value', 'GE': 'value',
  'TJX': 'value', 'INTU': 'value', 'CSCO': 'value', 'SPGI': 'value',
  'WM': 'value', 'TT': 'value', 'ETN': 'value', 'PH': 'value',
  'EMR': 'value', 'ULTA': 'value', 'MNST': 'value', 'NKE': 'value',

  // Large cap (not in growth or value above)
  'AMZN': 'large_cap', 'ORCL': 'large_cap', 'BA': 'large_cap',
  'LRCX': 'large_cap', 'KLAC': 'large_cap', 'CDNS': 'large_cap',
  'MU': 'large_cap', 'EXPE': 'large_cap', 'STX': 'large_cap',
  'WDC': 'large_cap', 'BABA': 'large_cap', 'TSM': 'large_cap',
  'CRM': 'large_cap', 'ON': 'large_cap',

  // Small/Micro cap
  'BMNR': 'small_cap', 'CRVS': 'small_cap', 'CRWV': 'small_cap',
  'FIG': 'small_cap', 'GRNY': 'small_cap', 'IBRX': 'small_cap',
  'ONDS': 'small_cap', 'SBET': 'small_cap', 'XYZ': 'small_cap',
};

/**
 * Get ticker investment type.
 * Falls back to sector-based heuristic if not explicitly mapped.
 * @param {string} ticker
 * @returns {string} type label
 */
function getTickerType(ticker) {
  const t = ticker?.toUpperCase();
  if (!t) return 'unknown';
  if (TICKER_TYPE_MAP[t]) return TICKER_TYPE_MAP[t];
  // Heuristic fallback based on sector
  const sector = SECTOR_MAP[t];
  if (!sector) return 'unknown';
  if (sector === 'ETF') return 'broad_etf';
  if (sector === 'Crypto') return 'crypto';
  if (sector === 'Precious Metals') return 'precious_metal';
  return 'large_cap'; // default for known stocks not explicitly typed
}

module.exports = {
  SECTOR_MAP,
  SECTOR_RATINGS,
  TICKER_TYPE_MAP,
  getSector,
  getSectorRating,
  getTickersInSector,
  getAllSectors,
  getTickerType,
};
