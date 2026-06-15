# Cross-Source Ground Truth — TD vs Alpaca vs Web (2026-06-15)

The systematic two-provider + web ground-truth check the candle-ground-truth
findings doc owed once the Alpaca secret landed on pre-prod. Establishes the
canonical source-of-truth policy for the candle chain's base fidelity.

Read-only throughout: nothing was written to D1/KV. Alpaca is fetched via a new
read-only worker proxy (`GET /timed/admin/alpaca-bars-readonly`) so the pre-prod
candle store is never polluted. TwelveData is fetched directly from
`time_series`. Web/exa is the independent auditor/tiebreaker.

Tool: `scripts/cross-source-ground-truth.js`.
Reports: `data/parity/2026-06-cross-source.json` (daily),
`data/parity/2026-06-cross-source-5m.json` (5m sample).

## Setup
- Basket: the 45-ticker review basket (`data/parity/2026-06-12-basket.txt`).
- Window: 2026-06-01 → 2026-06-12 (10 trading days).
- Consensus: `crossSourceConsensus({td, alpaca}, {fields:[h,l,c], quorum:2})`
  with tolerance = max(absolute $0.02, relative 5 bps of price).

## Result — DAILY (the ground-truth anchor)

**447 / 450 (ticker, day) cases agree on H/L/C = 99.33%.** 0 missing once the
TwelveData `end_date`-exclusive boundary is corrected (it drops the final day;
the runner bumps it by one). Volume: median Alpaca/TD ratio = **1.0006** — daily
volume IS cross-source reconcilable (both SIP-consolidated, auctions included),
unlike the intraday-rollup-vs-daily case (auction gap).

All 3 disagreements are **INFL** (Horizon Kinetics Inflation Beneficiaries ETF,
a thin ~150-300k ADV name):

| day | TD H/L/C | Alpaca H/L/C | web/exa truth | winner |
|---|---|---|---|---|
| 06-02 | 52.34 / 51.78 / 52.31 | 52.34 / 51.58 / **52.28** | close 52.28 (Yahoo) | **Alpaca** |
| 06-03 | 52.38 / 52.00 / 52.00 | **52.42 / 51.95 / 52.03** | 52.42 / 51.95 / 52.03 (exa) | **Alpaca** |
| 06-04 | 52.575 / 52.29 / 52.45 | 52.595 / **52.11** / 52.45 | (low side, thin) | Alpaca (L) |

In every audited INFL case the **web ground truth matches Alpaca, not
TwelveData** — TD's daily H/L/C for this thin ETF is a few cents (≈0.2-0.4%) off
the SIP-consolidated truth.

## Result — 5m (focused sample: AAPL, MU, GS, NFLX, INFL; 06-08→06-09)

**771 / 772 RTH-intersection bars agree = 99.87%** (volume median ratio 1.0015).

Crucial methodology finding: at an **absolute** $0.02 tolerance the same data
scored only 92.75% — but the "disagreements" were sub-0.05% wick deltas on
high-priced names (MU ~$950, where $0.02 is ~0.002%). A **relative** tolerance
(5 bps) is the correct comparator at the bar level; it was added to
`crossSourceConsensus` (`relTol`, unit-tested). The lone residual is — again —
INFL (close off $0.03 on a $51 bar).

## Web spot-checks (independent confirmation)
- AAPL 2026-06-09: web O 300.28 / H 300.75 / L 287.78 / C 290.55 — both
  providers match to the penny (an agreed case). ✓
- GS 2026-06-11 (~$1,035): web O 1013.50 / H 1036.92 / L 1000.45 / C 1035.64 —
  agreed case confirmed at high price. ✓
- INFL 06-02/03: web sides with Alpaca (above). ✓

## CANONICAL SOURCE-OF-TRUTH POLICY (decision)

1. **Base provider = TwelveData** (unchanged; it is the system SoT and is
   penny-faithful for all liquid names — 447/450 daily, 771/772 5m).
2. **Accept a finalized bar as ground truth when TD and Alpaca agree** within
   max($0.02, 5 bps). This covers ≈99.3% of daily and ≈99.9% of 5m bars with no
   further work.
3. **On TD-vs-Alpaca disagreement, web/exa is the tiebreaker.** Empirically for
   thin ETFs (INFL) the web auditor sided with **Alpaca** every time, so the
   operational rule is: *when they disagree, prefer the source matching the web
   auditor; absent a web read, prefer Alpaca's SIP-consolidated bar for thin
   instruments.* Flag the disagreeing (ticker, day) for audit; do not silently
   pick one.
4. **Volume is reconcilable at the DAILY level across providers** (ratio ≈1.00),
   but NOT between an intraday roll-up and the daily bar (auction prints) — keep
   `reconcileDailyRollup`'s banded-volume verdict for the intraday→daily check
   and treat cross-provider daily volume as an equality check.
5. **Tolerance must be price-relative**, not a flat absolute, anywhere bar-level
   OHLC are compared (now the default in `crossSourceConsensus`).

## Concrete fixes filed from this check
- [x] `crossSourceConsensus` relative tolerance (`relTol`, default 5 bps) — done,
  tested.
- [x] Read-only Alpaca proxy endpoint so cross-source checks never pollute the
  candle store — done (`/timed/admin/alpaca-bars-readonly`).
- [ ] TwelveData thin-ETF daily H/L/C drift (INFL class): not a chain bug; it is
  a provider-fidelity gap. Mitigation = policy #3 (Alpaca/web override on
  disagreement). No engine change needed now (INFL is macro-context, not a
  primary trade instrument), but the consensus gate should log these.
- Daily timestamp normalization + 00:00Z/04:00Z dedup and the 60/240 anchor pin
  are tracked as separate chain follow-ups (see the candle-chain commits).

## Reproduce
```bash
TIMED_TRADING_API_KEY=... TWELVE_DATA_API_KEY=... \
node scripts/cross-source-ground-truth.js \
  --basket data/parity/2026-06-12-basket.txt \
  --start 2026-06-01 --end 2026-06-12 --tf D \
  --out data/parity/2026-06-cross-source.json
```
