# Purge 2.6.0 Trades

## Using curl:

```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/purge-trades-by-version?version=2.6.0&key=YOUR_API_KEY"
```

Replace `YOUR_API_KEY` with your actual API key.

## Expected Response:

```json
{
  "ok": true,
  "message": "Purged 1 trades with version 2.6.0",
  "beforeCount": 1,
  "afterCount": 0,
  "purgedCount": 1,
  "targetVersion": "2.6.0"
}
```
