# V16 Refinement Validation Methodology

Created: 2026-04-27
Owner: Calibration loop
Trigger: Saty MTF framework assessment + user concern about filtering out
real winners with concordance gates.

## Core principle

**Every proposed entry filter MUST be tested by re-scoring all trades from
the V15 P0.7 baseline run BEFORE shipping.** The questions to answer:

1. **Does this filter let through our winners?** (Recall on PnL > 0)
2. **Does this filter cut our losers?** (Precision on PnL <= 0)
3. **What's the net portfolio impact?** (Filter PnL = sum of trades that
   would've passed) vs baseline.
4. **Are there setup archetypes we'd lose?** (e.g., all reversal trades)

A filter is only worth shipping when it removes proportionally more loss
than win — measured in dollars, not trade count.

---

## Required scorecard (per proposed filter)

For every candidate refinement, produce this table:

| Cohort | Trades (count) | Win rate | Total PnL | Avg PnL | Avg MFE |
|---|---:|---:|---:|---:|---:|
| Baseline (all V15 P0.7 trades) | N | XX.X% | $$$ | $$$ | $$$ |
| Would-Pass (filter says enter) | N1 | XX.X% | $$$ | $$$ | $$$ |
| Would-Block (filter says skip) | N2 | XX.X% | $$$ | $$$ | $$$ |

The filter is good when:
- **Would-Pass.WR > Baseline.WR by >= 5pp** (real lift, not noise)
- **Would-Pass.PnL >= Baseline.PnL × 0.85** (we keep ≥85% of total profits)
- **Would-Block.PnL <= 0** (the blocked cohort is net negative)

The filter is BAD when:
- It blocks any single trade with PnL > +5% (we lost a runner)
- Would-Pass.PnL < Baseline.PnL × 0.70 (we lost too much)
- It blocks an entire setup family (e.g. zero `tt_pullback` would pass)

---

## Categorization required

For every winner blocked by a candidate filter, classify it by:

- **Setup name**: `tt_pullback`, `tt_momentum`, `tt_index_etf_swing`, etc.
- **Entry archetype**: continuation, reversal, breakout, retest, fade
- **MTF agreement at entry**: how many of M/W/D/4H/H agreed with the
  trade direction
- **Conviction tier**: A/B/C
- **Outcome**: PnL, MFE, exit reason

A filter that blocks a high-MFE winner where the M/W/D didn't agree is
TELLING US SOMETHING — those trades may be exceptional setups (mean
reversion at major support, post-earnings gap continuation against
the longer-TF trend, etc.) that our framework hasn't yet named.

---

## V16 specific concerns to validate

### P2: Top-down concordance gate (M/W/D agreement)

**Hypothesis:** Trades where M/W/D directions all agree with the entry
have higher WR and avg PnL than trades where they disagree.

**Risk:** Reversal trades, mean-reversion setups, post-earnings pops,
oversold bounces all enter against the longer-TF trend. These are real
setup families with their own edge — filtering them out indiscriminately
would gut a chunk of our profit.

**Required test (before shipping):**
1. Tag every V15 P0.7 trade with its M/W/D agreement count at entry.
2. Build the scorecard above for filter "require >= 2 of 3 agree".
3. Build it for "require all 3 agree" (stricter).
4. **List every winner with PnL > +3% that would be blocked.** If any
   of those reveal a setup family (e.g., "post-FOMC bounce" or "Tuesday
   gap-up reversal"), DO NOT ship the gate as a hard block. Instead:
   - Treat MTF agreement as a CONVICTION INPUT (+5/+10 points), not a
     gate.
   - Or: gate only when ALL of M/W/D disagree (3 of 3 against), not
     when 2/3 agree.
5. Compute Would-Pass.PnL vs Baseline.PnL. Must be ≥85%.

### P1: Macro event blocks (FOMC, CPI, NFP)

**Hypothesis:** Trades opened in the 24h pre-FOMC have lower WR / higher
volatility / worse outcomes than non-event days.

**Risk:** FOMC days can have huge breakouts after the announcement.
Blocking the entire window may miss the post-event move.

**Required test:**
1. Tag every V15 P0.7 trade with `hours_to_fomc` and `hours_to_cpi`.
2. Build the scorecard for "block trades within 24h pre-FOMC".
3. Build it for "block trades within 24h around FOMC (+/- 24h)".
4. Build it for "block ONLY new entries 4h before FOMC, allow 4h after".
5. Pick the variant that maximizes WR lift while keeping ≥90% of
   baseline PnL.

### P4: Anchored ATR exit targets

**Hypothesis:** Using +1/+2 Monthly ATR as TP targets instead of fixed
% targets captures more of big moves.

**Risk:** If our entry timing systematically targets weaker levels,
ATR-anchored TPs may either be too far (never hit) or trigger giveback
similar to current trim_runner pattern.

**Required test:**
1. For every V15 P0.7 winner, compute where its +1 / +2 Monthly ATR
   levels were at entry.
2. Compare actual exit price to those levels — was the actual exit
   below or above the +1 ATR? Did MFE reach +2 ATR?
3. Re-simulate trim/exit using ATR-anchored levels and compare PnL,
   capture %, and runner duration.
4. Ship only if median PnL improves AND no big winners are clipped
   prematurely.

---

## How this wires into the engine

When we eventually ship V16 changes, each filter must come with:

1. **A `validation_report.md`** in `tasks/` with the scorecard above.
2. **A DA-keyed kill switch** (e.g., `deep_audit_v16_concordance_gate_enabled`)
   so we can turn it off live without redeploying.
3. **A regression smoke** in `data/trade-analysis/` capturing the
   target trades to check after deploy.

---

## Filed under

- `tasks/v16-saty-mtf-framework-spec.md` (to be created post-V15 run)
- `tasks/calibration-skill-framework.md` (the larger calibration loop)

