# V14 Forensic Pattern: Fading into Support — Saty ATR Level Awareness

**Surfaced by:** H SHORT 2026-04-07 14:00 — entered $142.27, hit hard-loss cap at $158.48 = **-11.39% LOSS**
**Run:** `v14-fullrun-julapr-1777074817`

## What the user observed

The H short entered as the price was approaching a key Saty ATR level on the daily timeframe (Prev Close ATR — visible as a major confluence in the screenshot). At that level, price could go either way; we shorted with no clear confirmation and it ripped against us.

Three signals were saying "no" to the short that we ignored or didn't even compute:

1. **Saty ATR confluence near a key level** (Prev Close, ±61.8, ±100). Price approaching one of these is high-probability mean-reversion territory — a **bad place to fade**.
2. **Sloping Phase Line** (against the proposed direction).
3. **Sloping RSI** (against the proposed direction).

User direction: "Lets note this and see if other losses share a similar pattern and winners don't, where we may need to learn from it."

## Hypothesis to test post-run

> **Trades that enter against a confluence of (a) Saty ATR key level + (b) phase-line slope opposing entry direction + (c) RSI slope opposing entry direction — disproportionately produce LOSSES.**

If true, this becomes a hard entry-block (or conviction-deduction) rule.

## V14 data we already have

The H SHORT trade record shows:
- `rank=99` (top of legacy rank — passed all rank gates)
- `conv=63 tier=B` (passed conviction gate at Tier B threshold)
- `setup_grade=Prime` (highest grade)
- 5 of 6 conviction signals were positive; only `relative_strength=0` flagged weakness
- **No signal flagged "approaching a key ATR level against direction"**
- **No signal flagged "phase-line slope opposing entry"**
- **No signal flagged "RSI slope opposing entry"**

So the trade looked great by every gate we have. It was wrong because we were missing the right data.

## Forensic audit plan (run after V14 completes)

### Step 1 — population segmentation

Bucket all V14 trades into three groups by terminal pnl:

- **BIG_LOSS** (pnl <= -3%) — the H-class losses we're trying to prevent
- **BIG_WIN** (pnl >= +3%) — the trades we want more of
- **NEUTRAL** (-3% < pnl < +3%) — control group

### Step 2 — compute Saty ATR proximity at entry

For each trade, derive these from the daily candle at entry_ts:

```
prev_close = previous_day.close
atr_d = current_day.atr_14
levels = {
  prev_close,
  prev_close + 0.382*atr_d,  prev_close - 0.382*atr_d,   # 38.2%
  prev_close + 0.618*atr_d,  prev_close - 0.618*atr_d,   # 61.8% (key)
  prev_close + 1.000*atr_d,  prev_close - 1.000*atr_d,   # 100%  (key)
  prev_close + 1.272*atr_d,  prev_close - 1.272*atr_d,
  prev_close + 1.618*atr_d,  prev_close - 1.618*atr_d,
}
proximity = min(|entry_price - L| / atr_d for L in levels)
nearest_level = the L that minimized
direction_to_level = sign(nearest_level - entry_price)  # +1 if level above, -1 below
```

**The fade-trap predicate:** trade is **shorting INTO a level above** OR **longing INTO a level below**, within 0.25 ATR.
```
fade_trap = (
  (direction == "SHORT" and direction_to_level > 0 and proximity < 0.25) or
  (direction == "LONG"  and direction_to_level < 0 and proximity < 0.25)
)
```

### Step 3 — compute slope opposition

Phase line and RSI slopes already exist in tickerData (`phase_score`, `rsi`). For the entry interval and the prior 3-5 intervals, compute:

```
phase_slope = ema(phase_score, 5) trend (bps/bar)
rsi_slope   = ema(rsi, 5) trend (bps/bar)

phase_opposes_entry = (
  (direction == "LONG"  and phase_slope < 0) or
  (direction == "SHORT" and phase_slope > 0)
)
rsi_opposes_entry = analogous
```

### Step 4 — cross-tab

```
                 Fade-trap=Y   Fade-trap=N
BIG_LOSS         X             Y
BIG_WIN          A             B
NEUTRAL          M             N

                 Phase-opposes=Y   Phase-opposes=N
BIG_LOSS
BIG_WIN

                 All 3 against=Y   any 2 against=Y    none
BIG_LOSS
BIG_WIN
```

If `BIG_LOSS / total | fade_trap=Y` >> `BIG_WIN / total | fade_trap=Y`, we have a kill rule.

### Step 5 — derive the gate

Three escalating responses depending on signal strength:

- **Soft penalty** (single condition fires): conviction score -10 pts → may push Tier B → C, blocked
- **Hard block** (2 of 3 fire): refuse entry regardless of rank/conviction
- **Reverse signal** (all 3 fire AND on the fade side): the original setup is mis-direction; either reject or invert

### Step 6 — implement as conviction signals

Add three new signals to `worker/focus-tier.js`:

- `signal 7 — saty_atr_proximity`: -10 pts if fade_trap=true, +5 pts if NEAR a level in the SAME direction (riding momentum through the level), 0 otherwise
- `signal 8 — phase_alignment`: -10 pts if phase opposes entry direction, +5 pts if aligned
- `signal 9 — rsi_alignment`: -5 pts if RSI opposes, +3 pts if aligned

Now conviction range becomes 0-130 (was 0-100); recompute Tier thresholds accordingly.

## What I expect to find

Given the H trade and the H Jan 14 LONG and H Jul 21 LONG (both losses, both with sloping-against indicators), I expect at least 2 of 3 conditions will be predictive of BIG_LOSS, and the combination will be highly predictive.

If the data confirms it, this is the largest single quality improvement we can make — directly addressing the "fewer trades, bigger wins" goal because it cuts the fattest loss tail.

## Code refs

- `worker/focus-tier.js` — where new signals will live
- `worker/indicators.js:1038` — `e21_slope_5bar_pct` already computed; need to add Saty ATR level proximity
- `worker/index.js:6664` — V13 hard pnl floor (which DID fire on H, capping the loss at -4.5% effectively but exit price slipped to -11% due to gap-overnight)

## H trade evidence summary (3 H trades, all losses)

| Date | Dir | Entry | Exit | PnL | Conv | Reason |
|------|-----|-------|------|-----|------|--------|
| 2025-07-21 | LONG | $148.80 | $147.74 | -0.01% | 70/B | SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE |
| 2026-01-14 | LONG | $168.25 | $162.94 | -0.99% | 70/B | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 2026-04-07 | SHORT | $142.27 | $158.48 | **-11.39%** | 63/B | HARD_LOSS_CAP |

H is also a 3-loss-in-a-row ticker with consistent Tier B (never Tier A). A separate signal: maybe **3 consecutive losses on a ticker should auto-block further entries for N days** until conditions clearly change. Conviction signal #6 (history) already does this somewhat but requires n>=3 with WR<30%, and our cold-start logic (`insufficient_history`) defaults to 10 pts which currently wouldn't penalize. Could add a "this-ticker-has-N-consecutive-losses-recent" hard penalty.

## Status

**Captured for post-V14 audit.** Will be the first analysis pass after V14 finishes (~22:30 UTC Saturday).
