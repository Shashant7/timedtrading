# Dead-weight ticker report — 2026-09-12

Report only. **Do not auto-remove.** A keep-list must stay human-reviewed.

Smaller backtest pools looking cleaner is mostly selection bias + candidate
density (24-name replay ~5 candidates/day vs ~314-name live ~40–46/day).
Rank / setup-grade / CIO should pick among competitors. Shrinking the live
book does **not** fix the Sep 2026 D1 read bill — that was two bad queries
(`docs/d1-billing-investigation-2026-06-22.md`).

Classifier: `worker/dead-weight-tickers.js`. Rebuild:

```bash
# Cheap tables only. Never GROUP BY ticker_candles.
cd worker
../node_modules/.bin/wrangler d1 execute timed-trading-ledger --env production --remote --json \
  --command "SELECT ticker, first_seen_ts, last_seen_ts FROM ticker_index" > /tmp/dw/ticker_index.json
# …ticker_profiles, ticker_latest (json_extract price/htf_score/sl/rank),
# live trades (run_id IS NULL), user_tickers, investor_positions
node ../scripts/dead-weight-tickers.mjs --dump /tmp/dw/dump.json --out /tmp/dead-weight.json
```

## Snapshot (2026-09-12)

Evidence: `ticker_index` 328, `ticker_latest` 331, `ticker_profiles` 423,
live `trades` 183 names / 1505 rows, `user_tickers` 20, `investor_positions`
75 ticker-status rows. Core map = `SECTOR_MAP` file ∪ inline (258).
Newton `TT_SELECTED` (28) are KEEP.

| Bucket | Count | Meaning |
|---|---:|---|
| KEEP | 225 | Open book, user slot, index/pulse/levered proxy, Newton pick, or a live trade in the last 180 days |
| WATCH | 51 | In the core map, onboarded and scored, but no live trade in 365d (or never). Theme coverage — review one-by-one. |
| DEAD | 55 | Not structural, never a live trade. Mostly unused screener/admin adds. |

### DEAD — unused adds (clearest dead weight)

Scored every cycle, never a live trade, not in the core map:

`AAOI`, `AG`, `ALAB`, `ALNT`, `AMKR`, `CBRS`, `CFR`, `CIEN`, `CIFR`, `DDOG`, `DKS`, `DUOL`, `ECHO`, `ENPH`, `ERAS`, `ESTC`, `FCX`, `FORM`, `FSLY`, `FTNT`, `IDYA`, `IRDM`, `LEU`, `LMT`, `LUNR`, `MKSI`, `MRVL`, `NBIX`, `NET`, `NTRA`, `NVT`, `NXE`, `OKLO`, `OKTA`, `P`, `PGEN`, `RBRK`, `RKT`, `RMBS`, `SEDG`, `SMR`, `SOC`, `SRAD`, `TEAM`, `TENB`, `TTMI`, `VICR`, `VRT`, `WULF`, `ZETA`, `ZM`, `ZS`

### DEAD — broken orphans

`ADD`, `SPX500`, `TICK`

### WATCH — core map idle / never traded

`ADBE`, `AR`, `ARKG`, `AYI`, `BMNR`, `CELH`, `COIN`, `CRM`, `CRWD`, `DINO`, `DRIV`, `DTM`, `EME`, `ENS`, `GILD`, `GOLD`, `HIMS`, `IAU`, `IBM`, `IHE`, `INTU`, `IOT`, `ISRG`, `JETS`, `LRCX`, `MSTR`, `NOC`, `NOW`, `ORCL`, `PM`, `QLYS`, `RKLB`, `SHOP`, `SMCI`, `SMH`, `SOFI`, `SOXX`, `SPCX`, `SPGI`, `TEM`, `TPL`, `UHS`, `UNG`, `UNH`, `UPS`, `UTHR`, `UUUU`, `VRTX`, `WFRD`, `XOM`, `XOP`

## Do not

- Auto-REMOVE from `timed:tickers` / `ticker_index` / `SECTOR_MAP`
- Delete candle history to "save D1"
- Drop an open book, a user slot, or an index/pulse proxy
- Treat this list as a scoring two-tier (not implemented)
