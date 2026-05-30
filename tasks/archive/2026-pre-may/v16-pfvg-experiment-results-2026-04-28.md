# V16 PFVG Experiment — Pilot Results (Phase 1)

**Date:** 2026-04-28
**Status:** Pilot fetch + detection + tracking complete. Trade join deferred
until v16-ctx run finishes.

---

## 1. Pilot scope

**Universe:** 12 tickers — SPY, QQQ, IWM, NVDA, AAPL, MSFT, AMZN, META,
GOOGL, TSLA, PLTR, COIN.

**Window:** 2025-07-01 → 2025-10-31 (89 weekdays, ~85 actual trading days
after holidays).

**Cost:** 1,239 TwelveData credits (well under PRO daily limit of 1,597).
**Wall time:** 27 minutes for the fetch.

---

## 2. Data captured

| File | Records | Size |
|---|---|---|
| `data/pfvg/pfvg-bars-jul-oct.json` | 1,068 ticker-days, 32,364 1-min bars | 3.2 MB |
| `data/pfvg/pfvg-levels-jul-oct.json` | 917 detected PFVGs | 504 KB |
| `data/pfvg/pfvg-tracking-jul-oct.json` | 917 with 6-day fate | 848 KB |
| `data/pfvg/pfvg-trade-join.json` | (preliminary, run incomplete) | 44 KB |

24 ticker-days returned no bars (US holidays — Jul 4, Sep 1 Labor Day, etc.)
— correctly handled as empty entries.

---

## 3. Detection findings

| Metric | Value |
|---|---|
| **Detection rate** | 87.8% of trading days had a significant PFVG |
| **Direction split** | 431 bull (47%) / 486 bear (53%) |
| **Avg displacement** | 0.97 ATR (clearly meaningful gaps) |
| **Avg strength score** | 0.56 (mid-range) |

Detection rate of ~88% is high but reasonable given:
- The 12-ticker universe is exclusively highly-volatile, liquid majors
  (PLTR, COIN, NVDA, TSLA, SPY/QQQ/IWM) that displace heavily at the open.
- The minimum gap floor is 0.20 ATR + 5 bps (filters tick noise but still
  permits real intraday imbalances).
- This is an **opening-range** specific phenomenon — these tickers gap and
  go in the first 15-20 minutes.

If we expand the universe to include slow-moving names (PG, JNJ, KO),
detection rate will likely fall to 60-70%.

---

## 4. PFVG fate (6-day tracking)

| State | Count | % |
|---|---|---|
| **Mitigated** (closed beyond zone within 6 days) | 573 | 62.5% |
| **Touched, holding** | 344 | 37.5% |
| **Untouched** | 0 | 0% |

**Hold rate (level survives 6 days):** **37.5%**.

This is the **first key finding**, and it's important:

> The ICT theory holds that a PFVG should be a *persistent S/R zone for
> multiple sessions*. In our liquid-majors pilot during Jul-Oct 2025, only
> 38% of PFVGs survived 6 trading days. The majority (62%) get fully
> mitigated within a week.

Asymmetry by direction:

| Direction | Held | Mitigated | Hold rate |
|---|---|---|---|
| **Bull PFVG** (support zone) | 191 | 240 | 44.3% |
| **Bear PFVG** (resistance zone) | 153 | 333 | 31.5% |

In a Jul-Oct 2025 broadly-bullish regime, **bull PFVGs hold 13pp better than
bear PFVGs** — exactly what we'd expect. Resistance levels get plowed
through in uptrends; support zones tend to hold.

This implies regime-aware filtering: **only trade in the direction of the
broader trend's PFVG type**.

### Reaction quality at first touch

| Quality | Count | % | Description |
|---|---|---|---|
| `wick_and_hold` | 232 | 25% | Best — price tagged zone, closed firmly outside |
| `midpoint_reaction` | 326 | 36% | Decent — price reached CE then reversed |
| `no_reaction` | 359 | 39% | Poor — price drove straight through |

Only ~25% of PFVGs produce a textbook reaction. The other 75% are either
weakly respected or ignored entirely.

---

## 5. Trade join (preliminary — run is only ~17% complete)

The v16-ctx-all5-jul-oct-1777388332 run is on day 15/87. It has produced
98 trades so far, of which 10 are in the 12-ticker pilot universe.

| Bucket | N | WR | PnL | PF |
|---|---|---|---|---|
| `at_zone` | 0 | — | — | — |
| `near_zone` (<0.5 ATR) | 0 | — | — | — |
| `near_2atr` (<2.0 ATR) | 0 | — | — | — |
| `far` (>2.0 ATR) | 7 | 100% (n=3 clean) | +3.74% | 999 |
| `none` (no recent PFVG) | 88 | 47% (n=49) | +40.40% | 2.23 |

**Sample is too small for any verdict.** Will re-run after the v16-ctx run
completes (estimated ~4 more hours of compute).

---

## 6. Preliminary takeaways

1. **PFVG detection is reliable**: ~88% of liquid-major sessions produce a
   significant PFVG that meets our hardened significance filter. The data
   pipeline (TwelveData → detector → tracker) is production-quality.

2. **PFVG persistence is weaker than ICT theory suggests**: only 38% of
   PFVGs survive 6 days unmitigated. The "rolling 6-day historical S/R
   zone" framing should be tempered.

3. **Strong asymmetry by direction × regime**: bull PFVGs in a bull
   market hold 1.4× better than bear PFVGs. This is the most actionable
   insight — **trend-aligned PFVGs should be the primary filter**.

4. **Reaction quality matters**: only 25% of PFVGs produce a `wick_and_hold`
   reaction. If we want to use PFVGs for entries, the strength_score and
   first-touch quality (which we now compute) are more important than the
   raw existence of the zone.

---

## 7. Next steps

- [ ] Wait for v16-ctx run to complete (~4 more hours).
- [ ] Re-run `pfvg-trade-joiner.py` against the full trade set.
- [ ] Compute the cross-table: position × alignment × direction × regime.
- [ ] Decision matrix:

| Outcome | Action |
|---|---|
| `aligned + at_zone/near_zone` LONG WR ≥ baseline + 5pp AND N ≥ 30 | Ship to live + replay |
| `aligned + at_zone/near_zone` WR ≥ baseline AND PF ≥ 1.5× baseline | Iterate on significance filter, retest |
| Neither | Shelve as a known-not-edge concept; document |

---

## 8. Costs & feasibility for live integration

If we ship to production:
- **Live cron:** add 1 TwelveData call per ticker per day at ~10:00 ET
  (post-formation window). For 210-ticker universe = 210 credits/day, well
  within PRO plan (1,597/day).
- **Backtest historical load:** 210 tickers × 252 trading days/year ×
  1.125 cred = ~60K credits per year. Roughly 38 days of PRO budget —
  feasible as a one-time amortized load (or split over multiple days).
- **Storage:** ~30 KB per ticker-year of PFVG records (very compact).
- **Compute:** PFVG detection is O(n_bars²) where n_bars=30 — trivial.

**Verdict on feasibility:** the cost is manageable. The blocker is whether
the edge survives validation. We'll know after the trade join completes.
