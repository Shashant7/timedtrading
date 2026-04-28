# V16 PFVG (First Presented Fair Value Gap) — Standalone Experiment

**Status:** Active
**Date:** 2026-04-28
**Owner:** ICT framework integration into Timed Trading

---

## 1. Why standalone (vs in-loop)

Forcing 1-min OHLCV into the live replay path costs:

- A new D1 timeframe (1m) ~ 50–100x storage of D1 daily candles
- A new fetch path on every tick (live cron) and every replay batch
- New eviction/retention policy

If the analysis shows weak edge, the cost is wasted. **A pre-flight standalone
experiment** lets us prove the edge before investing in pipeline plumbing.

The current `v16-ctx-all5-jul-oct-1777388332` smoke run already captures rich
context (regime, MTF, R:R, cross-asset, event proximity). We add PFVG levels
**out-of-band** and join them to those trades after the fact.

---

## 2. Hypothesis

> The first significant 3-bar Fair Value Gap formed in the first 30 minutes of
> NY session (9:30–10:00 ET) acts as a **persistent intraday support /
> resistance level for up to 6 trading sessions**. Trades initiated near a
> *fresh, untouched, aligned-with-bias* PFVG outperform the baseline in WR,
> PF, and R-multiple.

Falsifiable predictions:
- Mitigation rate (price closes through the zone within 6 days) < 40% in
  uptrending names. (If it's 80%+, PFVG is not a stable level.)
- Reaction rate at midpoint touch > 55% (price respects the CE).
- Bullish PFVG-aligned LONG entries (where PFVG is below price, untouched)
  show ≥ +5pp uplift in WR vs LONG entries with no fresh PFVG.

---

## 3. Detection algorithm (matches user spec)

### Time window
- **Start:** 09:30 ET (13:30 UTC during DST, 14:30 UTC standard time)
- **End:** 10:00 ET
- **Bar TF:** 1-minute. Six 5-minute bars or thirty 1-minute bars.

### FVG pattern (3-bar)
For bars i, i-1, i-2:
- **Bullish FVG**: `bar[i].low > bar[i-2].high` → zone = [bar[i-2].high, bar[i].low]
- **Bearish FVG**: `bar[i].high < bar[i-2].low` → zone = [bar[i].high, bar[i-2].low]

Only candidates where all 3 bars are inside the 9:30–10:00 window are kept.

### Significance filters (require ≥1)
1. **Displacement**: gap size ≥ 0.30 × ATR(5m, 14)
2. **Range expansion**: middle bar's range ≥ 1.5× average range of prior 6 bars
3. **Structure break**: middle bar broke the high (bullish) or low (bearish) of prior 30 bars

### Selection mode (default)
`FIRST_VALID` — first FVG that passes the significance filter.
Configurable: `LARGEST_GAP`, `STRUCTURE_BREAK_PRIORITY`.

### Stored fields per PFVG
```
{
  ticker, date, session_id,
  direction: "bull" | "bear",
  top, bottom, midpoint,
  detection_ts, expiration_ts (= +6 trading days),
  significance: { displacement_atr, range_expansion, structure_break },
  strength_score: 0-1 composite
}
```

---

## 4. Interaction tracking

For 6 trading days after detection, on each daily bar (or higher-resolution if
available), track:

- **state**: `untouched` | `touched_holding` | `mitigated` | `invalidated`
- **first_touch_ts**: first time price entered the zone
- **bullish PFVG mitigated**: any close below `bottom` (strict mode: 2 closes)
- **bearish PFVG mitigated**: any close above `top` (strict mode: 2 closes)
- **invalidation_ts**: ts of mitigation

Reaction quality at first touch:
- **wick_and_hold**: price tagged zone, closed back outside (favorable)
- **midpoint_reaction**: price reached CE then reversed
- **no_reaction**: passed straight through

---

## 5. Pilot scope

**Universe (Phase 1):** Top 30 tickers by trade volume in current run
(SPY, QQQ, IWM, NVDA, AAPL, AMZN, META, MSFT, GOOGL, TSLA, AVGO, AMD, COIN,
PLTR, MSTR, MU, CRWD, NFLX, SHOP, LITE, AXON, HOOD, RKLB, CCJ, JPM, GS, XLK,
XLF, XLE, GLD).

**Window:** 2025-07-01 → 2025-10-31 (87 trading days). Same as live run for
clean cross-reference.

**Total fetches:** 30 tickers × 87 days = 2,610 ticker-days.
With TD batched 8 per call: ~330 API calls. PRO is 8 req/min → ~42 min.

If results are positive, expand to full 210-ticker universe (~285 min one-time).

---

## 6. Phase 2 — analysis joins to trade outcomes

Cross-reference v16-ctx run trades against PFVG levels:

For every trade in the run:
1. Find the PFVG record for that ticker on the trade's entry date (or up to
   5 prior trading days).
2. Compute distance: `(entry_price - PFVG.midpoint) / atr_d`
3. Bucket: `at_zone` (within zone), `near_zone` (<0.5 ATR), `far` (>0.5 ATR).
4. Bucket alignment: `aligned` (LONG + bull PFVG below entry / SHORT + bear
   PFVG above entry), `opposed`, `none`.
5. Compute WR/PnL/PF per bucket.

**Decision criteria (go / no-go for production integration):**
- `aligned + at/near zone` LONG WR ≥ baseline LONG WR + 5pp
- `aligned + at/near zone` PnL/trade ≥ 1.3× baseline
- N ≥ 30 trades in the favorable bucket

If criteria met → ship to live + replay. If not → publish post-mortem and
either iterate the significance filter or shelve.

---

## 7. Deliverables

| File | Purpose |
|---|---|
| `scripts/pfvg-fetcher.py` | TwelveData 1-min loader for 9:30–10:00 ET window |
| `scripts/pfvg-detector.py` | 3-bar FVG detection + significance filter |
| `scripts/pfvg-tracker.py` | Mitigation/invalidation/reaction tracking |
| `scripts/pfvg-trade-joiner.py` | Joins PFVG levels with v16-ctx run trades |
| `scripts/pfvg-experiment.py` | Orchestrator: run pilot end-to-end |
| `data/pfvg/pfvg-levels-2025-jul-oct.json` | Detected PFVG levels |
| `data/pfvg/pfvg-tracking-2025-jul-oct.json` | Mitigation/reaction state |
| `data/pfvg/pfvg-trade-join.json` | Per-trade PFVG context |
| `tasks/v16-pfvg-experiment-results-2026-04-28.md` | Findings + go/no-go |

---

## 8. Non-goals (this experiment)

- ❌ Wiring PFVG into the worker (replay or live) — only after positive results
- ❌ Multi-timeframe PFVG (yearly/quarterly/monthly) — Phase 3
- ❌ PFVG strength scoring model — only basic composite for V1
- ❌ Volume imbalance integration — Phase 3

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| TwelveData PRO doesn't have 1m intraday history far back enough | Cap historical window. PRO has 5y of 1min for major tickers. |
| Rate limit / throttling | 8s sleep between batches (already in `worker/twelvedata.js`). Retries with backoff. |
| Sparse PFVG (few significant gaps form) | Track frequency in pilot; relax significance filter if rate < 30% of days. |
| Look-ahead leak | All PFVG detection uses bars only inside 9:30–10:00 window. Tracking uses only bars **after** detection time. |
