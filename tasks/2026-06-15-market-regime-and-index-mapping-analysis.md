# Market regime + per-index benchmark mapping — analysis (2026-06-15)

Operator read: "market near close, ran up all session, likely needs to cool off;
just did an HTF EMA cross to the upside — transitional may be right." This analysis
checks that against the live regime engine and evaluates mapping tickers to a
specific index (SPY/QQQ/IWM/DIA).

## TL;DR
The read is **half right — the tape is BIFURCATED**. Cap-weighted SPY/QQQ are
transitional/cooling (your read), but small-cap/value/equal-weight (IWM/DIA/RSP)
are in **strong confirmed uptrends**. Two mechanisms are over-restricting longs:
(1) live never computes the market cycle, so the entry gate defaults to the strict
"transitional" floor; (2) every ticker is benchmarked to SPY — the *weakest* index
right now — even though the stuck candidates track IWM/DIA.

## Live index regimes (2026-06-15 ~17:55 UTC)
| Index | regime_class | reg_score | htf_score | ema_reg_d | swing combined | cycle (SPY formula) |
|---|---|---|---|---|---|---|
| SPY | TRANSITIONAL | 4 | **5.2** | 2 | NEUTRAL | uptrend* |
| QQQ | TRANSITIONAL | 3 | **15.3** | 2 | NEUTRAL | uptrend* |
| IWM | TRENDING | 9 | **38.9** | 2 | LATE_BULL | uptrend |
| DIA | TRENDING | 10 | **34.1** | 2 | LATE_BULL | uptrend |
| RSP | TRENDING | 9 | **41.7** | 2 | STRONG_BULL | uptrend |

VIX (VX1!) ~19 (moderate/elevated). *SPY/QQQ `ema_regime_daily=2` so the cycle
*formula* says uptrend, but their `regime_class` (chop) is TRANSITIONAL and htf is
weak (5–15) — i.e. a fresh, not-yet-confirmed stack, consistent with the operator
read. **RSP (equal-weight) 41.7 vs SPY (cap-weight) 5.2 is the breadth tell**: the
average stock is far stronger than the cap-weighted index → mega-cap leaders are
consolidating while breadth runs. Classic rotation / breadth-led advance.

## How the engine decides "transitional" (and the bug)
- `_marketRegime` is a **SPY-only** snapshot (`timed:latest:SPY` → regime_class,
  regime_score, htf_score, ema_regime_daily, combined). Not QQQ/IWM/DIA/RSP.
- The entry h3 gate (`tt-core-entry.js`) reads `ctx.market.monthlyCycle`:
  - `uptrend` ⇒ floors only **shorts** (longs free).
  - `downtrend` ⇒ floors longs (rank ≥ 98 + 4H bull).
  - `transitional`/`""` ⇒ floors **both** sides at `deep_audit_regime_transitional_rank_min = 92`.
- In **replay**, cycle is derived from SPY: `ema_regime_daily≥2 OR htf≥15 → uptrend;
  ≤-2 OR ≤-15 → downtrend; else transitional`.
- **In LIVE, `env._monthlyCycle` is NEVER assigned** (grep-confirmed). So live always
  hits the `""` → transitional branch ⇒ the **92 long-floor applies to every name**,
  even though SPY's own `ema_regime_daily=2` would classify as **uptrend** (no long
  floor) under the replay formula. This is a replay→live parity gap — exactly the
  class of "live ≠ backtest" bug the foundation rebuild targets.

## Ticker → index correlation (daily log-returns, ~90d)
| Ticker | SPY | QQQ | IWM | DIA | Best fit |
|---|---|---|---|---|---|
| CAT | 0.64 | 0.59 | **0.73** | 0.69 | IWM |
| CW | 0.64 | 0.56 | **0.72** | 0.60 | IWM |
| EME | 0.63 | 0.58 | **0.69** | 0.58 | IWM |
| GE | 0.56 | 0.44 | 0.59 | **0.65** | DIA |
| RTX | 0.38 | 0.23 | 0.44 | **0.54** | DIA |
| CARR | 0.45 | 0.37 | 0.49 | **0.52** | DIA |
| INTC | 0.52 | **0.65** | 0.52 | 0.29 | QQQ |
| STX | 0.57 | **0.63** | 0.57 | 0.39 | QQQ |
| NVDA | **0.70** | 0.69 | 0.56 | 0.51 | SPY/QQQ |
| AMZN | **0.68** | 0.63 | 0.60 | 0.59 | SPY |

Index cross-corr: SPY~QQQ 0.94 (nearly identical, both mega-cap); QQQ~DIA **0.72**
and IWM distinct (≤0.85) — i.e. QQQ vs DIA vs IWM are different enough to matter.

**The stuck entry candidates are precisely the mis-benchmarked ones.** CAT/CW/EME
track **IWM** (0.69–0.73), GE/RTX/CARR track **DIA** (0.52–0.65) — both TRENDING
indices (htf 34–39) — yet they're gated against **SPY** (transitional, htf 5.2) and
hit the 92 floor. Benchmark them to their home index and they sit in a confirmed
uptrend (longs unfloored).

## Recommendations
1. **Close the live cycle gap (quick, reversible, parity fix).** Compute
   `env._monthlyCycle` in the live scoring cron with the SAME SPY formula replay
   uses, and thread it to `ctx.market.monthlyCycle`. Effect today: SPY edr=2 ⇒
   cycle "uptrend" ⇒ the 92 long-floor stops applying to longs. Makes live match
   backtest. (Caveat: SPY-only still understates breadth — see #2.)
2. **Per-index benchmark mapping (the better fix the operator asked for).** Assign
   each ticker a "home index" and use THAT index's regime for the directional
   cycle/gate (and ideally relative strength), instead of SPY-for-all:
   - Seed by membership: DIA = Dow 30; QQQ = Nasdaq-100; IWM = small/mid; SPY = default.
   - Refine by trailing beta/correlation (table above), recomputed periodically and
     cached (e.g. `timed:ticker-index-map`).
   - Pick the cycle from the mapped index; require a real divergence margin before
     overriding SPY so it stays conservative.
3. **Breadth-aware market backdrop.** For the market-level regime, blend SPY with
   RSP/IWM/DIA (or take the median index cycle) so a breadth-led advance isn't
   masked by cap-weighted lag. RSP is already ingested.

Net: the operator's "transitional" call is correct for the mega-cap complex, but the
engine is applying that label (and SPY's weakness) to the *whole* universe — including
the IWM/DIA names that are in clear uptrends. #1 restores live≡backtest; #2 fixes the
benchmark mis-attribution. Neither is shipped yet — awaiting go-ahead (these change
live entry discipline).
