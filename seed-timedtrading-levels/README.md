# Pine Seeds — Timed Trading Levels

This folder mirrors the [TradingView Pine Seeds](https://github.com/tradingview-pine-seeds/docs) layout for `request.seed()` integration with `TimedTrading_Levels_Overlay.pine`.

## Important — Pine Seeds provisioning

TradingView **paused creation of new Pine Seed repositories**. This folder is ready to push once the operator has an **existing TV-provisioned seed fork** (contact pine.seeds@tradingview.com). Until then, use **TT Sync paste** mode in the indicator.

## Repository name

The GitHub repo must be named exactly:

```
seed_timedtrading_levels
```

Pine calls it with:

```pine
request.seed("seed_timedtrading_levels", syminfo.ticker, close)
```

TV chart symbol: `SEED_<ACCOUNT>_TIMEDTRADING_LEVELS:<TICKER>` (account = GitHub username).

## Generate data

From the monorepo root:

```bash
TIMED_TRADING_API_KEY=... node scripts/sync-tv-levels-seed.mjs
```

Optional:

```bash
node scripts/sync-tv-levels-seed.mjs --tickers AAPL,NVDA,MSFT --out seed-timedtrading-levels
TV_SEED_LIMIT=50 node scripts/sync-tv-levels-seed.mjs   # cap universe size
```

Writes:

- `data/<SYMBOL>.csv` — daily OHLCV rows
- `symbol_info/seed_timedtrading_levels.json` — symbol registry

## OHLCV encoding

| Symbol | `close` | `high` | `low` | `open` | `volume` |
|--------|---------|--------|-------|--------|----------|
| `NVDA` | price | stop | tp_trim | tp_runner | rank |
| `NVDA_META` | dir code | in_univ | bias code | stage code | 0 |
| `NVDA_LV1`..`8` | level price | (same) | (same) | (same) | role code |

Direction: 1=LONG, -1=SHORT, 0=NEUTRAL. Role: 1=support, 2=resistance.

## Deploy to TradingView

1. Fork your TV-provisioned empty seed repo (keep the original name).
2. Copy `data/` + `symbol_info/` into the fork; commit.
3. Run the **Check data** GitHub Action (validates + uploads to TV storage).
4. In TradingView, add indicator → Mode = **GitHub Seed**.

Data updates daily; re-run the sync script and push when levels change materially.
