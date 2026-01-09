# Sector & Fundamental Data Integration

## Summary
This document describes the integration of sector classification and fundamental data (P/E ratio, EPS, Market Cap) from TradingView into the Timed Trading system.

---

## 1. Pine Script Updates

### Added Fields to JSON Alert
The Pine Script (`TimedTrading_ScoreEngine.pine`) now includes:

- **`sector`**: GICS sector name from TradingView (e.g., "Industrials", "Information Technology")
- **`industry`**: Industry classification from TradingView
- **`eps`**: Earnings Per Share (TTM) - tries multiple EPS fields (diluted, basic, reported)
- **`pe_ratio`**: Price-to-Earnings ratio (calculated as `price / eps` if EPS is available)
- **`market_cap`**: Total Market Capitalization (FQ - fiscal quarter)

### Implementation Details
- Uses `syminfo.sector` and `syminfo.industry` for sector/industry data
- Uses `request.financial()` for fundamental data:
  - `EARNINGS_PER_SHARE_BASIC`, `EARNINGS_PER_SHARE_DILUTED`, `EARNINGS_PER_SHARE` (TTM)
  - `TOTAL_MARKET_CAP` (FQ)
- Calculates P/E ratio when both price and EPS are available
- Fields are optional (only included if data is available)

### Example JSON Output
```json
{
  "ts": 1704067200000,
  "ticker": "CAT",
  "sector": "Industrials",
  "industry": "Construction Machinery",
  "eps": 12.50,
  "pe_ratio": 28.50,
  "market_cap": 150000000000,
  "htf_score": 15.5,
  "ltf_score": 5.2,
  ...
}
```

---

## 2. Worker Ingest Endpoint Updates

### Auto-Population of SECTOR_MAP
When TradingView sends sector data:
1. **Automatic Mapping**: If a ticker's sector is provided, it's automatically added to `SECTOR_MAP`
2. **KV Persistence**: Sector mappings are stored in KV at `timed:sector_map:{ticker}` for persistence
3. **Lazy Loading**: On worker startup, sector mappings are loaded from KV into memory

### Fundamental Data Storage
- **In-Memory**: Fundamental data is stored in the `payload.fundamentals` object:
  ```json
  {
    "pe_ratio": 28.50,
    "eps": 12.50,
    "market_cap": 150000000000,
    "industry": "Construction Machinery"
  }
  ```
- **KV Persistence**: Fundamentals are stored separately in KV at `timed:fundamentals:{ticker}` for historical tracking

### Code Changes
- **Location**: `worker/index.js`
- **Function**: `loadSectorMappingsFromKV()` - loads sector mappings on startup
- **Ingest Logic**: Auto-populates `SECTOR_MAP` and stores fundamentals when TradingView data is received

---

## 3. Benefits

### Automatic Sector Classification
- **No Manual Mapping**: TradingView automatically provides sector data
- **Always Up-to-Date**: Sector classifications stay current as companies change sectors
- **Reduced Maintenance**: No need to manually maintain `SECTOR_MAP` for new tickers

### Fundamental Analysis Integration
- **P/E Ratio**: Helps identify overvalued/undervalued stocks
- **EPS**: Tracks earnings performance
- **Market Cap**: Identifies large-cap vs. small-cap opportunities
- **Industry Context**: Provides industry-specific context for analysis

### Enhanced Scoring (Future)
- Can incorporate P/E ratio into ranking (e.g., penalize extremely high P/E stocks)
- Can use market cap for position sizing adjustments
- Can filter by fundamental criteria (e.g., only stocks with P/E < 30)

---

## 4. API Endpoints

### Existing Endpoints (Enhanced)
- `GET /timed/latest?ticker=XYZ` - Now includes `fundamentals` object if available
- `GET /timed/all` - All tickers now include sector and fundamentals if available

### New Endpoints (Already Existed)
- `GET /timed/sectors` - Returns all sectors and their ratings
- `GET /timed/sectors/:sector/tickers` - Returns top tickers in a sector
- `GET /timed/sectors/recommendations` - Returns top tickers across overweight sectors

---

## 5. Usage Examples

### Check Sector for a Ticker
```bash
curl "https://timed-trading-ingest.shashant.workers.dev/timed/latest?ticker=CAT" | jq '.sector'
# Output: "Industrials"
```

### Get Fundamentals
```bash
curl "https://timed-trading-ingest.shashant.workers.dev/timed/latest?ticker=CAT" | jq '.fundamentals'
# Output:
# {
#   "pe_ratio": 28.50,
#   "eps": 12.50,
#   "market_cap": 150000000000,
#   "industry": "Construction Machinery"
# }
```

### Filter by Sector
```bash
curl "https://timed-trading-ingest.shashant.workers.dev/timed/sectors/Industrials/tickers?limit=10"
```

---

## 6. Data Flow

```
TradingView Alert
    ↓
Pine Script adds sector + fundamentals to JSON
    ↓
POST /timed/ingest
    ↓
Worker receives data
    ↓
Auto-populates SECTOR_MAP (if sector provided)
    ↓
Stores fundamentals in KV (timed:fundamentals:{ticker})
    ↓
Stores sector mapping in KV (timed:sector_map:{ticker})
    ↓
Data available via API endpoints
```

---

## 7. Next Steps

### Immediate
- ✅ Sector data auto-population working
- ✅ Fundamental data collection working
- ✅ Data persistence in KV

### Phase 2 (See PHASE_2_NEWS_SENTIMENT_PLAN.md)
- Add NewsAPI for financial news
- Add Reddit API for sentiment tracking
- Optional: Twitter/X API integration
- Enhance scoring with sentiment data

### Future Enhancements
- Use P/E ratio in ranking algorithm
- Filter trades by fundamental criteria
- Historical fundamental data tracking
- Sector rotation analysis

---

## 8. Testing

### Verify Sector Auto-Population
1. Send a test alert with a new ticker that includes `sector` field
2. Check that `SECTOR_MAP` is updated
3. Verify KV storage at `timed:sector_map:{ticker}`

### Verify Fundamental Data
1. Send a test alert with `pe_ratio`, `eps`, `market_cap` fields
2. Check that `fundamentals` object is created
3. Verify KV storage at `timed:fundamentals:{ticker}`

### Verify API Endpoints
1. Query `/timed/latest?ticker=XYZ` and verify sector/fundamentals appear
2. Query `/timed/sectors` and verify all sectors are listed
3. Query `/timed/sectors/:sector/tickers` and verify tickers are returned

---

## 9. Troubleshooting

### Sector Not Appearing
- **Check**: TradingView alert includes `sector` field
- **Check**: KV storage at `timed:sector_map:{ticker}`
- **Check**: Worker logs for `[SECTOR AUTO-MAP]` messages

### Fundamentals Not Appearing
- **Check**: TradingView alert includes `pe_ratio`, `eps`, or `market_cap` fields
- **Check**: KV storage at `timed:fundamentals:{ticker}`
- **Note**: Some tickers may not have fundamental data available in TradingView

### P/E Ratio Missing
- **Check**: Both `price` and `eps` must be available
- **Check**: EPS must be > 0 (cannot divide by zero)
- **Note**: P/E ratio is calculated, not fetched directly

---

## 10. References

- **Pine Script File**: `tradingview/TimedTrading_ScoreEngine.pine`
- **Worker File**: `worker/index.js`
- **Sector Mapping**: `worker/index.js` (SECTOR_MAP object)
- **Phase 2 Plan**: `docs/PHASE_2_NEWS_SENTIMENT_PLAN.md`
