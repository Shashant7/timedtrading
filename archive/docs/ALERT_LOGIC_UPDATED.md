# Updated Alert & Trade Trigger Logic

## Overview

The alert and trade trigger logic has been **updated to align with the latest model** and now **incorporates Momentum Elite** as a quality signal.

## Key Changes

### 1. Momentum Elite Integration ✅

**Momentum Elite stocks now get:**
- **Relaxed thresholds** (higher quality = more lenient requirements)
- **Additional trigger path** (can trigger on Momentum Elite alone in good setup)
- **Priority consideration** (shown in Discord alerts)

### 2. Enhanced Trigger Logic

**Original trigger:**
- In corridor + corridor aligned + (entered aligned OR EMA_CROSS OR SQUEEZE_RELEASE)

**Enhanced trigger (NEW):**
- Original trigger **OR**
- Momentum Elite + in corridor + corridor aligned

This means Momentum Elite stocks can trigger even without traditional triggers if they're in a good setup.

### 3. Adjusted Thresholds for Momentum Elite

| Threshold | Standard | Momentum Elite | Change |
|-----------|----------|---------------|--------|
| **Min RR** | 1.5 | 1.35 (1.2 min) | -10% |
| **Max Completion** | 0.4 | 0.5 | +25% |
| **Max Phase** | 0.6 | 0.7 | +17% |
| **Min Rank** | 70 | 60 | -10 points |

**Rationale:** Momentum Elite stocks have strong fundamentals, so we can be slightly more lenient on technical thresholds while maintaining quality.

## Alert Conditions (Updated)

### Required Conditions (ALL must pass):

1. **Discord Configuration** ✅
   - `DISCORD_ENABLE` = `"true"`
   - `DISCORD_WEBHOOK_URL` set

2. **Corridor Entry** ✅
   - LONG corridor: HTF > 0, LTF -8 to 12
   - SHORT corridor: HTF < 0, LTF -12 to 8

3. **Corridor Alignment** ✅
   - LONG corridor → Q2 (`HTF_BULL_LTF_BULL`)
   - SHORT corridor → Q3 (`HTF_BEAR_LTF_BEAR`)

4. **Trigger Condition** ✅ (at least ONE):
   - Entered aligned state (Q2/Q3), OR
   - `EMA_CROSS` or `SQUEEZE_RELEASE`, OR
   - Squeeze release flag, OR
   - **NEW:** Momentum Elite in corridor + aligned

5. **Thresholds** ✅ (ALL must pass):
   - RR ≥ 1.5 (1.35 for Momentum Elite)
   - Completion ≤ 0.4 (0.5 for Momentum Elite)
   - Phase ≤ 0.6 (0.7 for Momentum Elite)
   - Rank ≥ 70 (60 for Momentum Elite)

## Simulated Trade Logic (Aligned)

The simulation dashboard now uses **identical logic** to Discord alerts:

- Same corridor requirements
- Same alignment checks
- Same trigger conditions
- Same threshold gates
- **Same Momentum Elite adjustments**

This ensures simulated trades match what would trigger Discord alerts.

## Example Scenarios

### Scenario 1: Standard Stock
- In corridor ✅
- Aligned ✅
- EMA_CROSS trigger ✅
- RR: 1.6 ✅
- Completion: 0.35 ✅
- Phase: 0.55 ✅
- Rank: 72 ✅
- **Result:** Alert fires ✅

### Scenario 2: Momentum Elite Stock
- In corridor ✅
- Aligned ✅
- No traditional trigger ❌
- **BUT:** Momentum Elite ✅
- RR: 1.4 ✅ (1.35 required for ME)
- Completion: 0.45 ✅ (0.5 allowed for ME)
- Phase: 0.65 ✅ (0.7 allowed for ME)
- Rank: 65 ✅ (60 required for ME)
- **Result:** Alert fires ✅ (Momentum Elite trigger path)

### Scenario 3: Momentum Elite with Traditional Trigger
- In corridor ✅
- Aligned ✅
- SQUEEZE_RELEASE ✅
- Momentum Elite ✅
- RR: 1.3 ✅ (1.35 required)
- Completion: 0.38 ✅
- Phase: 0.58 ✅
- Rank: 68 ✅ (60 required)
- **Result:** Alert fires ✅ (meets both paths)

## Impact

### More Alerts Expected
- Momentum Elite stocks can trigger with relaxed thresholds
- Additional trigger path increases opportunities
- Still maintains quality (all thresholds must pass)

### Better Quality Signals
- Momentum Elite stocks are fundamentally strong
- Technical thresholds slightly relaxed but still meaningful
- Combines fundamental + technical analysis

## Testing

Use the debug endpoint to verify:

```bash
curl "https://YOUR-WORKER.workers.dev/timed/alert-debug?ticker=SPY"
```

Look for:
- `momentumElite: true/false`
- `momentumEliteTrigger: true/false`
- `enhancedTrigger: true/false`
- `thresholds.adjusted` vs `thresholds.base`

## Configuration

Thresholds can still be adjusted via environment variables:

```bash
wrangler secret put ALERT_MIN_RR          # Default: 1.5
wrangler secret put ALERT_MAX_COMPLETION  # Default: 0.4
wrangler secret put ALERT_MAX_PHASE       # Default: 0.6
wrangler secret put ALERT_MIN_RANK        # Default: 70
```

Momentum Elite adjustments are calculated as percentages of these base values.

