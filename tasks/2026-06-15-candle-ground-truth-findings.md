# Candle Ground-Truth — findings & mechanism (2026-06-15)

Operator question: "How do we make sure the timeframe candles match perfectly?
Are we comparing calculated vs source? We have two providers + web search —
ground truth should be easy, it's immutable history."

## The correctness model (refined)

1. **Derived intraday TFs need no external match — consistency is by
   construction.** Deriving 10/15/30/60/240 from one 5m base means a 30m bar is
   *definitionally* its six 5m bars. The shadow reconcile already proved the
   resample reproduces the provider's bars 100% on 10/15/30. So we do NOT
   validate derived TFs against the provider's (internally inconsistent) nm
   fetch — we stop fetching those.

2. **Correctness reduces to the BASE (5m + daily) being complete + faithful**,
   and that is established by **cross-source ground truth**, not single-provider
   self-consistency — because no single provider self-validates.

## What the web spot-check proved (immutable history = easy ground truth)

Web ground truth for **AAPL 2026-06-01** (exa/stockanalysis/chartexchange/advfn
all agree): `O 309.63 · H 310.94 · L 305.02 · C 306.31 · V ~48.85M`.

- **The stored 2026 daily is penny-perfect:** TD daily = `309.63 / 310.94 /
  305.02 / 306.31 / 48,849,900` — exact. The data is good.
- **It caught a bug in OUR reconciler, not the data:** daily bars are stamped at
  **00:00 UTC of the trading day**; grouping them with `etDateStr` shifts 00:00Z
  to the *previous* ET day, so "06-01" showed 06-02's numbers. Fixed
  (`reconcile.js` now keys daily by UTC date, intraday by ET date). Without the
  web cross-check we might have distrusted good data or "fixed" the wrong layer.
- **Volume is not equality-reconcilable:** after the fix, RTH 5m H/L match the
  daily to the penny, but 5m volume is ~75% of the official daily — and the
  extended-hours 5m bars added almost nothing (36.73M vs 36.72M). The gap is the
  **opening/closing auction prints** (+odd-lots), which live in the daily but
  never in intraday bars. So volume is a banded ratio, not an equality check.
- **Legacy artifact:** 2025 daily bars are **duplicated** (one at 00:00Z, one at
  04:00Z = UTC vs ET midnight) — a dual-write the chain's contiguity/dedup
  invariant must kill. 2026 is clean (single bar).

## Mechanism shipped (`worker/foundation/reconcile.js`)

- **`reconcileDailyRollup(base5m, providerDaily)`** — the internal completeness
  check: roll up the 5m base per day and compare to the provider daily.
  **Verdict = High/Low** (price completeness, anchor-independent); **volume =
  banded ratio** (flags only a gross undercount < 50% = truly missing bars,
  tolerating auction-level gaps); O/C optional (auction tolerance). Wired into
  the shard core (`reconcileDaily`) + DO (`/reconcile-daily` + admin proxy).
- **`crossSourceConsensus(sources, {quorum})`** — the cross-provider ground
  truth: where ≥`quorum` independent sources agree (within tol) on H/L/C, that
  is ground truth; any disagreeing source is flagged as an outlier to re-fetch /
  audit. Pure + tested (incl. the real AAPL 06-01 case + a 2-of-3 outlier).

## The ground-truth pipeline (target)

```
ingest 5m + daily (TwelveData)
   → reconcileDailyRollup  (H/L completeness vs daily; gross-volume alarm)
   → crossSourceConsensus  (TwelveData vs Alpaca vs web/exa; ≥2 agree = truth)
        • agree            → accept as ground truth
        • outlier provider → re-fetch that source; if still off, prefer consensus
        • no consensus     → web/exa random audit breaks the tie + alerts
   → contiguity + dedup invariant (kills the 00:00Z/04:00Z daily double-write)
```

## Credentials reality (for the systematic cross-provider check here)
- TwelveData: available + working. Web/exa: available (used above).
- Finnhub: key present (candle endpoint coverage varies by plan).
- **Alpaca: only a single key is injected (no secret) in this environment**, so
  the Alpaca *data* API can't be called directly here. The live worker has the
  Alpaca secret; to run TD-vs-Alpaca systematically on pre-prod, set
  `ALPACA_API_KEY_ID` + `ALPACA_API_SECRET_KEY` on pre-prod (like the
  TWELVEDATA secret). Until then web/exa serves as the independent auditor.

## Recommendations folded into the chain
1. **Normalize daily timestamps to a canonical trading-date anchor on ingest**
   (TD uses 00:00 UTC; Alpaca may differ) so daily bars never mis-align by a day.
2. **Dedup daily** (drop the 00:00Z/04:00Z double-write).
3. **Run `reconcileDailyRollup` on every daily ingest** (cheap completeness gate)
   and **`crossSourceConsensus` on a rolling random sample + all disagreements**,
   with web/exa as the tiebreaker/auditor.
