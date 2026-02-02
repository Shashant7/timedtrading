# Trade Conditions Comparison: "Trading Opportunity" vs "Trade Entered"

## Key Differences

### 1. **Threshold Source**

**Trading Opportunity (Discord Alert):**
- Uses **Environment Variables**:
  - `ALERT_MIN_RR` (default: 1.5)
  - `ALERT_MAX_COMPLETION` (default: 0.4)
  - `ALERT_MAX_PHASE` (default: 0.6)
  - `ALERT_MIN_RANK` (default: 70)
- **Configurable** via Cloudflare Dashboard

**Trade Entered (Trade Simulation):**
- Uses **Hardcoded Values**:
  - `baseMinRR = 1.5`
  - `baseMaxComp = 0.4`
  - `baseMaxPhase = 0.6`
  - `baseMinRank = 70`
- **NOT configurable** - always uses these values

### 2. **RR Calculation**

**Trading Opportunity:**
- Uses `computeRRAtTrigger(payload)` - **recalculates RR at trigger_price**
- More accurate for alert evaluation
- Example: Trigger at $177.52, current at $182.68 → uses RR at trigger ($5.80) not current ($0.21)

**Trade Entered:**
- Uses `payload.rr` directly - **uses RR from payload**
- May be less accurate if price moved after trigger

### 3. **Trigger Condition Logic**

**Trading Opportunity:**
```javascript
shouldConsiderAlert =
  (enteredCorridor && corridorAlignedOK && (enteredAligned || trigOk || sqRel)) ||
  (inCorridor && ((corridorAlignedOK && (enteredAligned || trigOk || sqRel)) || (sqRel && side)))
```
- Considers **enteredCorridor** separately (ticker just entered corridor)
- More nuanced logic for corridor entry vs already in corridor

**Trade Entered:**
```javascript
shouldConsiderAlert =
  inCorridor &&
  corridorAlignedOK &&
  (enteredAligned || trigOk || sqRelease || hasTrigger)
```
- Checks `hasTrigger` (trigger_price && trigger_ts exist)
- Simpler logic - doesn't distinguish between entering vs already in corridor

### 4. **Momentum Elite Handling**

**Both:**
- Relax thresholds for Momentum Elite stocks
- Same adjustments: RR (1.2), Completion (0.5), Phase (0.7), Rank (60)

### 5. **Additional Requirements**

**Trade Entered:**
- Requires `price`, `sl`, and `tp` to exist
- Skips futures tickers
- These checks happen BEFORE threshold evaluation

**Trading Opportunity:**
- No additional data requirements beyond what's in payload

## Summary

| Aspect | Trading Opportunity | Trade Entered |
|--------|-------------------|--------------|
| **Thresholds** | Environment Variables | Hardcoded |
| **RR Calculation** | Recalculated at trigger | From payload |
| **Trigger Logic** | More nuanced (entered vs in) | Simpler (includes hasTrigger) |
| **Configurable** | Yes (via Dashboard) | No |
| **Data Requirements** | Basic payload | Requires price, sl, tp |

## Impact

**Current Behavior:**
- If `ALERT_MIN_RANK=60` but trade simulation uses `baseMinRank=70`:
  - Ticker with rank 65 → **Trading Opportunity** fires ✅
  - Ticker with rank 65 → **Trade Entered** does NOT fire ❌

**Recommendation:**
- Make trade simulation use environment variables OR
- Ensure both use the same thresholds for consistency
