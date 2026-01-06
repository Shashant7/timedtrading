# Trade Storage Architecture

## Overview

Simulated trades are now stored at the **Worker level** (Cloudflare KV) instead of browser localStorage. This provides better persistence, multi-device access, and version tracking.

## Storage Location

- **Primary**: Cloudflare KV (`timed:trades:all`)
- **Backup**: None (KV is persistent, but consider exports for critical data)
- **Format**: JSON array of trade objects

## API Endpoints

### GET `/timed/trades?version=2.1.0`
Get all trades, optionally filtered by version.

**Query Parameters:**
- `version` (optional): Filter by script version (e.g., "2.1.0", "2.2.0")
  - Omit or use `"all"` to get all trades

**Response:**
```json
{
  "ok": true,
  "count": 42,
  "totalCount": 100,
  "version": "2.1.0",
  "versions": ["2.2.0", "2.1.0", "2.0.0"],
  "trades": [...]
}
```

### POST `/timed/trades?key=YOUR_API_KEY`
Create or update a trade.

**Request Body:**
```json
{
  "id": "AAPL-1234567890",
  "ticker": "AAPL",
  "direction": "LONG",
  "entryPrice": 150.00,
  "entryTime": "2024-01-15T10:30:00.000Z",
  "sl": 148.00,
  "tp": 155.00,
  "rr": 2.5,
  "rank": 85,
  "scriptVersion": "2.1.0",
  "status": "OPEN",
  "pnl": 0,
  "pnlPct": 0,
  ...
}
```

**Response:**
```json
{
  "ok": true,
  "trade": {...},
  "action": "created" // or "updated"
}
```

### DELETE `/timed/trades/:id?key=YOUR_API_KEY`
Delete a trade by ID.

**Response:**
```json
{
  "ok": true,
  "deleted": true,
  "remainingCount": 99
}
```

## Trade Object Structure

```typescript
interface Trade {
  id: string;                    // Unique ID: "TICKER-timestamp"
  ticker: string;                // Stock symbol
  direction: "LONG" | "SHORT";   // Trade direction
  entryPrice: number;            // Entry price
  entryTime: string;             // ISO timestamp
  sl: number;                     // Stop loss
  tp: number;                     // Take profit
  rr: number;                     // Risk/reward ratio
  rank: number;                   // Setup rank
  scriptVersion: string;         // Model version (e.g., "2.1.0")
  state: string;                  // HTF/LTF state
  flags: object;                  // Flags (squeeze, momentum, etc.)
  inCorridor: boolean;            // Was in entry corridor
  status: "OPEN" | "WIN" | "LOSS" | "TP_HIT_TRIM";
  pnl: number;                    // Profit/loss
  pnlPct: number;                 // P&L percentage
  currentPrice?: number;          // Current price (for open trades)
  trimmedPct?: number;            // Trim percentage (0.5 = 50%)
  shares: number;                  // Number of shares
  lastUpdate?: string;            // Last update timestamp
}
```

## Benefits of Worker Storage

### ✅ Persistence
- Survives browser data loss
- Not affected by localStorage limits
- Persistent across devices

### ✅ Multi-Device Access
- Access trades from any device
- Real-time sync (when implemented)
- Shared analytics

### ✅ Version Tracking
- Each trade tagged with `scriptVersion`
- Filter by version for comparison
- Track model performance over time

### ✅ Analytics
- Server-side analytics possible
- Historical data preserved
- Export capabilities

### ✅ Reliability
- Cloudflare KV is highly available
- Automatic backups (Cloudflare handles)
- No browser-specific issues

## Migration from localStorage

**Automatic Migration:**
The simulation dashboard will:
1. Load trades from Worker API on mount
2. If localStorage has old trades, they can be manually migrated
3. All new trades go to Worker automatically

**Manual Migration (if needed):**
```javascript
// One-time script to migrate localStorage trades to Worker
const oldTrades = JSON.parse(localStorage.getItem("simulatedTrades") || "[]");
for (const trade of oldTrades) {
  await fetch(`${API_BASE}/timed/trades?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(trade),
  });
}
```

## Security

- **Authentication**: POST/DELETE require `key` query parameter
- **CORS**: Configured via `CORS_ALLOW_ORIGIN` env var
- **API Key**: Stored in Worker secrets (`TIMED_API_KEY`)

**Note**: Currently using hardcoded API key in dashboard. For production:
- Use environment variables
- Implement user authentication
- Add rate limiting
- Consider user-specific trade storage

## Performance

- **KV Read**: ~1-5ms (very fast)
- **KV Write**: ~5-10ms (very fast)
- **Trade Count**: Supports thousands of trades efficiently
- **Filtering**: Client-side for now (can be server-side if needed)

## Limitations

- **KV Size Limit**: 25MB per namespace (plenty for trades)
- **Write Limits**: 1,000 writes/second (more than enough)
- **No Transactions**: Updates are atomic per key, but no multi-key transactions

## Future Enhancements

1. **User Authentication**: Multi-user support
2. **Real-time Sync**: WebSocket updates
3. **Export/Import**: CSV/JSON export
4. **Analytics API**: Server-side analytics endpoints
5. **Trade Groups**: Organize trades by strategy/portfolio
6. **Backup**: Periodic exports to external storage

