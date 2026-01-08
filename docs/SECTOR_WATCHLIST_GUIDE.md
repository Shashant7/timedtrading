# Sector-Based Watchlist Guide

## Overview

This guide explains how to use the sector ratings system to identify and add the best tickers from favored sectors to your TradingView watchlist.

## Sector Ratings

Current sector ratings from VIP analysts:

| Sector | Rating | Boost |
|--------|--------|-------|
| Consumer Discretionary | Neutral | 0 |
| **Industrials** | **Overweight** | +5 |
| Information Technology | Neutral | 0 |
| Communication Services | Neutral | 0 |
| Basic Materials | Neutral | 0 |
| **Energy** | **Overweight** | +5 |
| **Financials** | **Overweight** | +5 |
| Real Estate | Underweight | -3 |
| **Healthcare** | **Overweight** | +5 |
| **Utilities** | **Overweight** | +5 |

## API Endpoints

### 1. Get All Sectors

```bash
GET /timed/sectors
```

Returns all sectors with their ratings and ticker counts.

**Example:**
```bash
curl https://timed-trading-ingest.shashant.workers.dev/timed/sectors
```

**Response:**
```json
{
  "ok": true,
  "sectors": [
    {
      "sector": "Industrials",
      "rating": "overweight",
      "boost": 5,
      "tickerCount": 24
    },
    ...
  ]
}
```

### 2. Get Top Tickers in a Sector

```bash
GET /timed/sectors/:sector/tickers?limit=10
```

Returns top tickers in a specific sector, ranked by technical score + sector boost.

**Example:**
```bash
curl "https://timed-trading-ingest.shashant.workers.dev/timed/sectors/Industrials/tickers?limit=10"
```

**Response:**
```json
{
  "ok": true,
  "sector": "Industrials",
  "rating": { "rating": "overweight", "boost": 5 },
  "limit": 10,
  "tickers": [
    {
      "ticker": "CAT",
      "rank": 71,
      "boostedRank": 76,
      "sector": "Industrials",
      "sectorRating": "overweight",
      "sectorBoost": 5,
      "price": 603.62,
      "htf_score": 15.5,
      "ltf_score": 5.2,
      ...
    },
    ...
  ]
}
```

### 3. Get Recommendations Across All Overweight Sectors

```bash
GET /timed/sectors/recommendations?limit=10&totalLimit=50
```

Returns top tickers across all overweight sectors, sorted by boosted rank.

**Parameters:**
- `limit`: Tickers per sector (default: 10)
- `totalLimit`: Total tickers across all sectors (default: 50)

**Example:**
```bash
curl "https://timed-trading-ingest.shashant.workers.dev/timed/sectors/recommendations?limit=10&totalLimit=50"
```

### 4. Add Tickers to Watchlist

```bash
POST /timed/watchlist/add?key=YOUR_API_KEY
Content-Type: application/json

{
  "tickers": ["CAT", "JPM", "XOM", ...]
}
```

Adds tickers to the system's watchlist (so TradingView can collect data for them).

**Example:**
```bash
curl -X POST \
  "https://timed-trading-ingest.shashant.workers.dev/timed/watchlist/add?key=YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tickers": ["CAT", "JPM", "XOM"]}'
```

## Using the Helper Script

The easiest way to generate a watchlist is using the helper script:

```bash
# Set your API key
export TIMED_API_KEY=your_api_key_here

# Generate recommendations and add to watchlist
node scripts/generate-sector-watchlist.js

# Or with custom options
node scripts/generate-sector-watchlist.js \
  --limit=15 \
  --total-limit=75 \
  --output=tradingview/WATCHLIST_SECTORS.txt
```

**What it does:**
1. Fetches top tickers from all overweight sectors
2. Saves ticker list to a file (for TradingView watchlist import)
3. Adds tickers to the system watchlist via API

## Manual Workflow

### Step 1: Get Recommendations

```bash
curl "https://timed-trading-ingest.shashant.workers.dev/timed/sectors/recommendations?limit=10&totalLimit=50" \
  | jq -r '.recommendations[].ticker' \
  > watchlist_tickers.txt
```

### Step 2: Add to Watchlist

```bash
# Create JSON payload
TICKERS=$(cat watchlist_tickers.txt | jq -R -s -c 'split("\n")[:-1]')
curl -X POST \
  "https://timed-trading-ingest.shashant.workers.dev/timed/watchlist/add?key=YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"tickers\": $TICKERS}"
```

### Step 3: Import to TradingView

1. Copy tickers from `watchlist_tickers.txt`
2. In TradingView, go to Watchlist → Create New Watchlist
3. Paste tickers (one per line)
4. Save

## How Ranking Works

Tickers are ranked using:

1. **Base Technical Rank**: Your existing HTF/LTF scoring system
2. **Sector Boost**: Added based on sector rating
   - Overweight: +5 rank boost
   - Neutral: 0 boost
   - Underweight: -3 rank penalty
3. **Final Rank**: Base Rank + Sector Boost

**Example:**
- CAT has base rank of 71
- Industrials sector is overweight (+5 boost)
- Final boosted rank: 76

## Sector Mapping

The system includes mappings for ~200+ S&P 500 stocks across all sectors. To add more tickers:

1. Edit `worker/index.js`
2. Add ticker to `SECTOR_MAP` object
3. Deploy worker

## Updating Sector Ratings

To update sector ratings:

1. Edit `SECTOR_RATINGS` in `worker/index.js`
2. Deploy worker
3. Rankings will automatically reflect new ratings

## Best Practices

1. **Start Conservative**: Use `limit=10` per sector initially
2. **Focus on Overweight**: Prioritize overweight sectors
3. **Monitor Performance**: Track how sector-boosted stocks perform
4. **Regular Updates**: Update watchlist weekly/monthly as ratings change
5. **Combine with Fundamentals**: Use P/E and PEG data when available

## Next Steps

1. **Run the script** to generate initial watchlist
2. **Import to TradingView** and set up alerts
3. **Monitor performance** of sector-boosted stocks
4. **Iterate** based on results

## Troubleshooting

**No tickers returned?**
- Check if tickers have data in the system (they need to have been ingested at least once)
- Verify sector mapping includes your tickers

**Tickers not being added?**
- Check API key is correct
- Verify ticker symbols are valid (uppercase, no special characters)

**Rankings seem off?**
- Remember rankings are based on technical scores + sector boost
- Tickers need recent data to have accurate rankings
