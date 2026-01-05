# Timed Trading System

## Architecture, Data Flow, and Scoring Logic

---

## 1. High-Level Overview

The Timed Trading System is a real-time, signal-driven market intelligence platform designed to surface high-quality trade opportunities across assets by combining:
- Multi-timeframe technical signals
- Contextual regime awareness (trend vs pullback)
- Risk/reward validation
- Temporal persistence (trails)
- Visual cognition (quadrant-based bubble chart)

The system is composed of three primary layers:
1. **TradingView Indicator** (Signal Generator)
2. **Cloudflare Worker** (Ingest + Scoring Engine)
3. **Pages UI** (Visualization + Decision Interface)

Each layer is intentionally decoupled but tightly coordinated.

---

## 2. TradingView Indicator (Signal Generation Layer)

### Purpose

The TradingView (TV) indicator is the only component that directly reads price data. Its role is to:
- Detect technical conditions
- Classify market state
- Emit structured, normalized signals
- Remain stateless beyond the chart

### Key Design Principle

> **The indicator does NOT decide trades.**  
> **It describes conditions.**

All decision intelligence is downstream.

---

### 2.1 Indicator Responsibilities

The TV indicator computes and emits:

#### A. Multi-Timeframe Scores
- **HTF Score** (Higher Timeframe Bias)
- **LTF Score** (Lower Timeframe Timing)

These scores are:
- Directional (positive = bullish, negative = bearish)
- Normalized to a bounded range (e.g. −50 → +50)
- Independent but complementary

This allows separation of:
- **Context** (HTF)
- **Entry timing** (LTF)

---

#### B. Market State Classification
Each signal is mapped into one of four canonical states:

| State | Meaning |
|-------|---------|
| `HTF_BULL_LTF_PULLBACK` | Bull trend, pullback → Q1 (Prep) |
| `HTF_BULL_LTF_BULL` | Bull trend, continuation → Q2 (Momentum) |
| `HTF_BEAR_LTF_BEAR` | Bear trend, continuation → Q3 (Momentum) |
| `HTF_BEAR_LTF_PULLBACK` | Bear trend, pullback → Q4 (Prep) |

These states drive quadrant placement in the UI.

---

#### C. Event Flags (Contextual Modifiers)
The indicator may emit boolean flags such as:
- `sq30_on` → squeeze building
- `sq30_release` → squeeze fired
- `phase_dot` → regime confirmation
- `trigger direction` & `reason`

These flags do not override scoring — they annotate it.

---

#### D. Trade Geometry (If Available)
When possible, the indicator includes:
- `trigger_price`
- `stop_loss` (SL)
- `take_profit` (TP)
- `price` (current)
- `eta_days`

These enable downstream risk/reward and completion math.

---

### 2.2 Output Contract (What the Indicator Sends)

Each alert is a JSON payload sent via webhook:

```json
{
  "ticker": "AAPL",
  "ts": 1700000000000,
  "htf_score": 32,
  "ltf_score": -6,
  "state": "HTF_BULL_LTF_PULLBACK",
  "flags": {
    "sq30_on": true,
    "sq30_release": false
  },
  "trigger_price": 182.50,
  "sl": 178.40,
  "tp": 191.20
}
```

This payload is append-only, idempotent, and stateless.

---

## 3. Cloudflare Worker (Ingest + Scoring Engine)

### Purpose

The Worker is the brain of the system.

It:
- Ingests raw signals
- Normalizes and enriches them
- Computes derived metrics
- Stores current state and history
- Serves data to the UI

---

### 3.1 Worker Responsibilities

#### A. Ingestion
- Accepts webhook POSTs from TradingView
- Validates schema
- Normalizes tickers (e.g. BRK-B → BRK.B)
- Timestamps entries

---

#### B. State Storage
The Worker maintains:
- Latest snapshot per ticker
- Trail history (last N points per ticker)
- Top buckets (pre-ranked lists)

This allows:
- Time-based animation
- Path visualization
- Flash detection
- Historical context

---

## 4. Scoring System (Core Logic)

This is the most important section.

---

### 4.1 HTF Score (Higher Timeframe Score)

#### What it Represents

HTF Score answers:

> **"What is the dominant market bias right now?"**

It captures:
- Trend direction
- Strength
- Regime persistence

#### Properties
- Slow-moving
- Resistant to noise
- Contextual anchor

#### Interpretation

| HTF Score | Meaning |
|-----------|---------|
| +30 to +50 | Strong bull regime |
| +10 to +30 | Bullish |
| −10 to +10 | Neutral / chop |
| −30 to −10 | Bearish |
| −50 to −30 | Strong bear regime |

---

### 4.2 LTF Score (Lower Timeframe Score)

#### What it Represents

LTF Score answers:

> **"Is this a good time to act inside the larger context?"**

It captures:
- Pullbacks
- Momentum bursts
- Exhaustion

#### Properties
- Fast-moving
- Sensitive
- Entry-focused

---

### 4.3 Quadrant Logic (HTF × LTF)

The Cartesian combination of HTF and LTF produces four regimes:

| Quadrant | HTF | LTF | Meaning |
|----------|-----|-----|---------|
| Q1 | Bull | Pullback | Long prep zone |
| Q2 | Bull | Bull | Long momentum |
| Q3 | Bear | Bear | Short momentum |
| Q4 | Bear | Pullback | Short prep zone |

This is why the UI is a 2-axis plane, not a list.

---

### 4.4 Corridor Logic (Entry Zones)

Not all quadrant positions are tradable.

The system defines corridors — narrow LTF bands where entries are valid.

**Long Corridor**
- HTF > 0
- LTF ∈ [−8, +12]

**Short Corridor**
- HTF < 0
- LTF ∈ [−12, +8]

Only tickers inside corridors are considered entry-eligible.

---

### 4.5 Risk/Reward (RR) Score

RR is computed when SL and TP are present:

```
RR = |TP - price| / |price - SL|
```

**Usage**
- Filters low-quality setups
- Does NOT affect HTF/LTF scores
- Used for eligibility + ranking

---

### 4.6 Completion Score (Bubble Size)

Bubble size represents progress toward TP, not time:

```
completion = clamp( (price − trigger) / (TP − trigger), 0 → 1 )
```

**Why this matters:**
- Big bubbles ≠ good entries
- Small bubbles = early opportunity
- Completion > threshold hides late trades

---

### 4.7 Rank Score

Rank is a composite quality score, typically derived from:
- HTF magnitude
- RR
- Phase confirmation
- Signal cleanliness
- Historical reliability

Rank is ordinal, not absolute.

---

## 5. Pages UI (Decision Interface)

### Purpose

The UI is not a dashboard — it is a decision workspace.

Its goals:
- Compress complexity into spatial intuition
- Let the trader see regime, timing, and quality
- Prevent over-trading and late entries

---

### 5.1 Bubble Chart

Each bubble represents one ticker.

**Axes**
- X = LTF Score
- Y = HTF Score

(or swapped)

**Visual Encoding**

| Feature | Meaning |
|---------|---------|
| Bubble size | Completion toward TP |
| Color | Phase % |
| Opacity | Data freshness + eligibility |
| Border glow | Squeeze state |
| Flash | Active squeeze in corridor |
| Label | Smart visibility |

---

### 5.2 Trails

Trails show how a ticker moved through regimes.

They answer:

> **"Did this drift into the corridor, or snap into it?"**

This helps distinguish:
- Structured setups
- Random spikes

---

### 5.3 Groups (Meta-Filters)

Groups are orthogonal overlays, not scoring inputs.

Examples:
- UPTICKS
- S&P Sectors
- Custom baskets

A ticker can belong to multiple groups simultaneously.

Groups help answer:

> **"Is this a single name — or sector-wide behavior?"**

---

### 5.4 Blink Guard (Stability Logic)

The UI includes a blink guard that prevents:
- Empty fetch flashes
- Network jitter resets

But:
- Filter changes intentionally bypass it
- Live data glitches do not

This preserves cognitive continuity.

---

## 6. End-to-End Data Flow

```
TradingView Indicator
  ↓ (webhook JSON)
Cloudflare Worker
  ├─ normalize
  ├─ score
  ├─ store snapshot
  ├─ store trail
  └─ expose APIs
        ↓
Pages UI
  ├─ fetch
  ├─ filter
  ├─ visualize
  ├─ animate
  └─ assist decision
```

---

## 7. Design Philosophy (Why This Works)

- **Scores, not signals**
- **Geometry, not lists**
- **Context before timing**
- **Quality before quantity**
- **Visual memory over alerts**

This system is intentionally:
- Hard to over-trade
- Easy to wait
- Focused on where price is in its lifecycle

---

## 8. Future Extensions (Optional)

- ML-weighted rank refinement
- Regime-adaptive corridor widths
- Time-decay weighting
- Portfolio-aware filtering
- Auto-journal snapshots

