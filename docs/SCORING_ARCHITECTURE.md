# Scoring Architecture Overview

## Current Architecture

### 1. Pine Script (TradingView)
**Calculates:**
- ✅ HTF Scores (Higher Timeframe)
  - Weekly, Daily, 4H, 1H scores
  - Blended with volatility-adjusted weights
- ✅ LTF Scores (Lower Timeframe)
  - 30m, 10m, 3m scores
  - Blended with session-aware weights
- ✅ State (HTF_BULL_LTF_BULL, etc.)
- ✅ Phase percentage
- ✅ Completion percentage
- ✅ Trigger events (squeeze release, EMA cross)
- ✅ TP/SL levels

**Sends to Worker:**
```json
{
  "htf_score": 15.5,
  "ltf_score": 5.2,
  "state": "HTF_BULL_LTF_PULLBACK",
  "phase_pct": 0.30,
  "completion": 0.15,
  "flags": { "sq30_release": true, ... }
}
```

### 2. Worker
**Receives from Pine Script:**
- HTF/LTF scores (already calculated)
- State, phase, completion, flags

**Calculates:**
- ✅ **Base Rank/Score** (`computeRank()`)
  - Uses HTF/LTF scores from payload
  - Adds bonuses for alignment, setup, squeeze, phase, RR
  - Adds Momentum Elite boost (+20 points)
  - Result: 0-100 score
  
- ✅ **Risk/Reward (RR)**
  - Calculates if not provided in payload
  - Uses TP, SL, and current price

- ✅ **Momentum Elite Status**
  - Worker-based calculation with caching
  - Checks price, market cap, ADR, volume, momentum %

- ✅ **Derived Metrics**
  - Staleness buckets
  - Market type detection
  - State transitions

**Stores:**
- Latest snapshot per ticker
- Trail history
- Momentum Elite cache
- Pre-computed ranks

### 3. UI (React)
**Receives from Worker:**
- Pre-computed base rank
- All ticker data

**Calculates:**
- ✅ **Dynamic Rank** (`computeDynamicRank()`)
  - Starts with base rank from worker
  - Adds real-time bonuses:
    - Corridor status (+10)
    - Squeeze release (+8)
    - Good RR (+2-8)
    - Early phase (+3-6)
    - Low completion (+5)
  - Result: Can exceed 100 (e.g., 110)

## Scoring Flow

```
┌─────────────┐
│ Pine Script │
│             │ → Calculates HTF/LTF scores
│             │ → Calculates state, phase, completion
└─────────────┘
       ↓
┌─────────────┐
│   Worker    │
│             │ → Receives HTF/LTF scores
│             │ → Calculates Base Rank (0-100)
│             │ → Calculates Momentum Elite
│             │ → Caches results
└─────────────┘
       ↓
┌─────────────┐
│     UI      │
│             │ → Receives Base Rank
│             │ → Calculates Dynamic Rank (can exceed 100)
│             │ → Displays rankings
└─────────────┘
```

## What Could Be Moved to Worker?

### Currently in Pine Script (Could Move):
- HTF/LTF score calculation
- State determination
- Phase calculation
- Completion calculation

### Why Keep in Pine Script?
- **Real-time**: Calculated on every bar close
- **TradingView data**: Direct access to price/volume/indicators
- **Efficiency**: Pine Script is optimized for technical analysis
- **No external dependencies**: Works offline

### Why Move to Worker?
- **Caching**: Calculate once, serve many times
- **External data**: Access to market cap, fundamentals
- **Consistency**: Single source of truth
- **History**: Track score changes over time

## Recommendation

**Keep HTF/LTF in Pine Script** because:
1. Real-time calculation is needed
2. TradingView has best access to price data
3. Pine Script is optimized for technical analysis

**Keep Base Rank in Worker** because:
1. Combines multiple data sources (Pine Script + external APIs)
2. Can cache and optimize
3. Single source of truth for ranking

**Keep Dynamic Rank in UI** because:
1. Real-time bonuses based on current view
2. User-specific filtering
3. Fast client-side calculation

## Summary

| Component | Location | What It Does |
|-----------|----------|--------------|
| HTF/LTF Scores | Pine Script | Technical analysis on multiple timeframes |
| Base Rank | Worker | Combines scores + bonuses (0-100) |
| Dynamic Rank | UI | Adds real-time bonuses (can exceed 100) |
| Momentum Elite | Worker | External data + caching |

The worker handles the **base scoring/ranking**, but it **depends on HTF/LTF scores from Pine Script**. This is a good separation of concerns:
- Pine Script = Technical analysis engine
- Worker = Data enrichment + ranking engine
- UI = Presentation + real-time bonuses

