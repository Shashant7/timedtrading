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
};

// Sector Ratings (from VIP analysts)
const SECTOR_RATINGS = {
  'Consumer Discretionary': { rating: 'neutral', boost: 0 },
  'Industrials': { rating: 'overweight', boost: 5 },
  'Information Technology': { rating: 'neutral', boost: 0 },
  'Communication Services': { rating: 'neutral', boost: 0 },
  'Basic Materials': { rating: 'neutral', boost: 0 },
  'Energy': { rating: 'overweight', boost: 5 },
  'Financials': { rating: 'overweight', boost: 5 },
  'Real Estate': { rating: 'underweight', boost: -3 },
  'Healthcare': { rating: 'overweight', boost: 5 },
  'Utilities': { rating: 'overweight', boost: 5 },
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

module.exports = {
  SECTOR_MAP,
  SECTOR_RATINGS,
  getSector,
  getSectorRating,
  getTickersInSector,
  getAllSectors,
};
