# FINDING: Fast-trim bug — TP1 set at 0.618× swingATR (not 1.5× as defaults claim)

**Date:** 2026-04-28
**Severity:** HIGH — affects trim quality on most trades
**Source:** v16-ctx4-jul-oct-1777398500 trade-by-trade analysis

---

## Symptom

User noticed several trades getting trimmed very quickly. Investigation shows:

- **75 trades (35% of all trims)** trim within 2 hours of entry
- **23 trades (11%)** trim on the **very next 30m bar** after entry (30 minutes)
- Trim levels: KTOS at +0.25%, LITE at +0.18%, PLTR at +0.24%, GDX at +0.54%, COIN at +0.58%

These are **noise-level trims** — barely above slippage.

## Cohort comparison

| Cohort | N | WR | PnL | Avg MFE | Avg trim PnL | Per-trade |
|---|---|---|---|---|---|---|
| `instant_30m` | 22 | 68% | +9.76% | +4.61% | +0.96% | **+0.44%** |
| `fast_<2h` | 31 | 58% | +24.30% | +4.57% | +1.05% | **+0.78%** |
| `med_2-24h` | 90 | 54% | +79.13% | +3.99% | +1.28% | **+0.88%** |
| `slow_>24h` | 70 | **80%** | **+187.06%** | **+6.08%** | **+4.87%** | **+2.67%** |

**Slow trims yield 6× higher per-trade outcome than instant trims.** They held longer, MFE built to +6%, and the trim happened at +4.87%.

## Root cause: TWO conflicting TP1 computations in codebase

### Path 1: `worker/indicators.js` — computes precision-engine TPs

```js
// indicators.js:4494-4499
tp_trim   = price + dir * 0.618 * swingATR  // Fibonacci 61.8%
tp_exit   = price + dir * 1.000 * swingATR
tp_runner = price + dir * 1.618 * swingATR
```

Where `swingATR = ATRw OR ATRd * √5 OR ATR1H * √6.5 * √5 OR ATR30 * √13 * √5`.

### Path 2: `worker/index.js` — `THREE_TIER_DEFAULTS` and `build3TierTPArray`

```js
// index.js:12149-12152
const THREE_TIER_DEFAULTS = {
  TRIM:   { minMult: 1.5, maxMult: 2.5, trimPct: 0.50 },
  EXIT:   { minMult: 2.5, maxMult: 4.0, trimPct: 0.90 },
  RUNNER: { minMult: 4.0, maxMult: 7.0, trimPct: 1.0  },
};
// MIN_TP_TRIM_ATR = 1.5 (line 12178)
```

These constants suggest TP1 should be at **1.5× ATR minimum**.

### What actually happens

Looking at `build3TierTPArray()` (line 12666-12715):

```js
const pTrim = Number(tickerData.tp_trim);  // <- comes from indicators.js (0.618 × swingATR)
const pExit = Number(tickerData.tp_exit);
const pRunner = Number(tickerData.tp_runner);
const hasPrecisionTPs = Number.isFinite(pTrim) && pTrim > 0 && ...;

if (hasPrecisionTPs) {
  // Validates direction, then USES THE 0.618 VALUE AS-IS:
  const result = [
    { price: pTrim, trimPct, tier: "TRIM", label: "TRIM TP @ 1.5x ATR", ... },  // <-- WRONG LABEL
```

The label says **"@ 1.5x ATR"** but the `pTrim` value comes from indicators.js at **0.618× swingATR**. The `THREE_TIER_DEFAULTS.TRIM.minMult: 1.5` and `MIN_TP_TRIM_ATR = 1.5` constants are **never enforced** in this code path.

The 1.5x floor only fires in the calibrated path (`getThreeTierConfig()` line 12184-12211), which only activates when `_calibratedTPTiers` is set.

## Why this affects fast-trim trades

When ATR is low (calm tickers, low-vol days), 0.618× swingATR is a tiny absolute distance. Examples:

- KTOS at $56.36, weekly ATR ~$3 → swingATR ~$3 → TP1 = entry + $1.85 (3.3% above)
- But the actual trim happened at $56.50 = +$0.14 from entry (0.25%)

So the **swingATR computation must be returning a much smaller value** than expected for these trades. Possible reasons:
- ATRw is `0` (not yet computed for fresh tickers) → fallback ATRd × √5
- ATRd is small (calm day) → fallback works but produces low value
- Or there's a bug where ATR isn't being passed correctly

Either way, the problem stands: **0.618× of anything is too tight as TP1**. We're trimming on noise.

## Hypothesized impact

If we move TP1 to **1.5× swingATR** (matching the documented "@ 1.5x ATR" label):

- Fast trims (within 30min) would either not happen, OR happen at a more meaningful distance (3-5% gain instead of 0.18%)
- Many trades that currently trim at +0.5% and continue to +5-10% MFE would trim at +3-4% instead
- The "instant_30m" cohort's per-trade outcome could approach the "med_2-24h" cohort's (+0.88% per trade) or better

Estimated impact across 53 fast-trim trades (`instant_30m` + `fast_<2h`):
- Current: +34.06% combined PnL, +0.64%/trade avg
- Projected at 1.5× ATR: ~+80-100% combined PnL, ~+1.5-2%/trade avg

Plus winner-protect: trims at +3-4% instead of +0.5% mean the runner half also has more breathing room.

## Proposed fix (FIX 6)

Two options:

### Option A: Enforce minimum at TP-array build time

```js
// In build3TierTPArray, before using pTrim:
const minTrimDist = Math.max(MIN_TP_TRIM_ATR * atr, entryPrice * 0.015);  // 1.5x ATR or 1.5% of price
const trimDist = Math.abs(pTrim - entryPrice);
if (trimDist < minTrimDist) {
  pTrim = isLong ? entryPrice + minTrimDist : entryPrice - minTrimDist;
}
```

### Option B: Change indicators.js multipliers to match defaults

```js
// indicators.js:4494-4499
tp_trim   = price + dir * 1.5  * swingATR  // was 0.618
tp_exit   = price + dir * 2.5  * swingATR  // was 1.000
tp_runner = price + dir * 4.0  * swingATR  // was 1.618
```

**Option A is safer** — keeps the Fibonacci hierarchy, just enforces a minimum. Option B is a more invasive change.

## Validation plan

1. Pre-shipping: capture v16-ctx4 fast-trim cohort metrics (above table)
2. Apply FIX 6 (option A)
3. Run July smoke at 30m
4. Compare:
   - Fast-trim cohort N (expect to drop significantly — many become regular trims at +3% instead)
   - Total PnL (expect uplift)
   - Total wins (might decrease slightly because fewer "tiny wins" that count as WIN, but per-trade outcome should improve)
   - Top winners (should NOT regress; many could improve)
5. Decide go/no-go

## Cross-reference

Same data source identified earlier:
- FIX 1 (V15 P0.7.15): SMART_RUNNER cloud-hold deferral fix (already committed)
- FIX 2: Winner-protect anchor (TODO)
- FIX 3: Net-negative Ripster setups (TODO)
- FIX 4: Short underrepresentation (TODO)
- FIX 5: Loss cluster (TODO)
- **FIX 6: Fast-trim TP1 floor (THIS finding)**

These will be sequenced after the autopsy completes and a comprehensive prioritized fix list is built.
