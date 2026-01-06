# Data Versioning and Migration

## Overview

The system now includes automatic version detection and data migration when the TradingView script version changes. This ensures that old data from previous script versions is purged and fresh data is collected with the new scoring model.

## How It Works

### 1. Version Tracking

- **Pine Script** includes `SCRIPT_VERSION = "2.1.0"` in the JSON payload
- **Worker** stores the current version in KV: `timed:data_version`
- **Automatic Migration** triggers when versions don't match

### 2. Automatic Migration

When a new script version is deployed:

1. **First payload** with new version triggers migration
2. **Archive created** - Old data snapshot stored (kept for 30 days)
3. **Data purged** - All ticker data, trails, momentum data cleared
4. **Version updated** - New version stored in KV
5. **Discord notification** - Optional alert about migration

### 3. What Gets Purged

- ✅ Latest data for all tickers (`timed:latest:*`)
- ✅ Trail history (`timed:trail:*`)
- ✅ Momentum Elite data (`timed:momentum:*`)
- ✅ State tracking (`timed:prevstate:*`)
- ✅ Ticker index (rebuilds automatically)

### 4. What Gets Archived

- Version number
- Migration timestamp
- Ticker count
- Sample of tickers (first 10)

## Updating the Version

### Step 1: Update Pine Script

In `TimedTrading_ScoreEngine_Enhanced.pine`:

```pinescript
// Change this when you update the scoring model
SCRIPT_VERSION = "2.2.0"  // Increment version number
```

### Step 2: Deploy TradingView Script

- Copy updated script to TradingView
- Save and apply to watchlist
- Alerts will start sending new version

### Step 3: Migration Happens Automatically

- First alert with new version triggers migration
- Old data is purged
- New data starts fresh

## Manual Operations

### Check Current Version

```bash
curl "https://YOUR-WORKER.workers.dev/timed/version"
```

Response:
```json
{
  "ok": true,
  "storedVersion": "2.1.0",
  "expectedVersion": "2.1.0",
  "match": true
}
```

### Manual Purge (Emergency)

If you need to manually purge all data:

```bash
curl -X POST "https://YOUR-WORKER.workers.dev/timed/purge?key=YOUR_API_KEY"
```

Response:
```json
{
  "ok": true,
  "message": "Data purged successfully",
  "purged": 42,
  "tickerCount": 42,
  "version": "2.1.0"
}
```

⚠️ **Warning**: This will delete ALL data. Use with caution.

### Check Health (Includes Version)

```bash
curl "https://YOUR-WORKER.workers.dev/timed/health"
```

Response:
```json
{
  "ok": true,
  "now": 1704067200000,
  "lastIngestMs": 1704067100000,
  "minutesSinceLast": 1.67,
  "tickers": 42,
  "dataVersion": "2.1.0",
  "expectedVersion": "2.1.0"
}
```

## Version Numbering

Use semantic versioning: `MAJOR.MINOR.PATCH`

- **MAJOR**: Breaking changes to data model
- **MINOR**: New features, backward compatible
- **PATCH**: Bug fixes, backward compatible

Examples:
- `2.1.0` → `2.1.1` (bug fix, no migration needed if you want)
- `2.1.0` → `2.2.0` (new feature, migration recommended)
- `2.1.0` → `3.0.0` (breaking change, migration required)

## Best Practices

1. **Increment version** when you change:
   - Scoring algorithm
   - Data structure
   - Calculation methods
   - Field names/types

2. **Don't increment** for:
   - Visual changes only
   - Comments/documentation
   - Minor bug fixes (unless data structure changes)

3. **Test migration** on a small watchlist first

4. **Monitor Discord** for migration notifications

5. **Check health endpoint** after deployment to verify version

## Troubleshooting

### Migration Not Triggering

- Check that `SCRIPT_VERSION` in Pine Script matches `CURRENT_DATA_VERSION` in worker
- Verify payload includes `script_version` field
- Check worker logs for version comparison

### Data Not Purging

- Verify version numbers are different
- Check KV permissions
- Review worker logs for errors

### Want to Skip Migration

If you want to keep old data and just update version:

1. Manually set version in KV:
   ```bash
   # Use worker console or manual KV update
   # Set timed:data_version to new version
   ```

2. Or update `CURRENT_DATA_VERSION` in worker to match old version

## Example Migration Flow

```
1. Deploy script with SCRIPT_VERSION = "2.2.0"
2. First alert arrives with version "2.2.0"
3. Worker detects stored version is "2.1.0"
4. Migration triggered:
   - Archive created: timed:archive:2.1.0:1704067200000
   - All data purged
   - Version updated to "2.2.0"
5. Discord notification sent
6. New data starts collecting with version "2.2.0"
```

## Archive Retention

Archives are kept for **30 days**, then automatically deleted. This gives you time to:
- Verify migration worked
- Check old data if needed
- Debug any issues

To keep archives longer, modify the TTL in `checkAndMigrate()` function.

