# Active Trader Information Hardening Plan

**Status:** planning contract  
**Created:** 2026-06-17  
**Scope:** Active Trader, Day Trader, indicator parity, signal events,
sequence-aware diagnosis, calibration queue.

---

## 1. Problem statement

The recent candle-chain/freshness work hardens **data as data**: candles must
be fresh, ordered, deduped, and replay/live consistent before any score is
trusted.

The next layer is **data as information**:

1. Are the core indicators computed correctly from those candles?
2. Are indicator events stored as events instead of transient booleans?
3. Can the system read ordered signal sequences rather than one snapshot?
4. Can the model compare the current sequence to historical ticker-specific
   behavior, backtests, discovery misses, calibration tables, and research
   context before choosing a posture or action plan?

The Active Trader model should not behave like a one-frame classifier. A
single snapshot is a picture. A sequence of snapshots is a movie. The engine
needs to diagnose the movie.

---

## 2. Layered hardening model

| Layer | Contract | Failure mode if weak |
|---|---|---|
| **L0 Candle truth** | Fresh, gap-aware, chain-integrity-checked OHLCV across TFs | Correct formulas produce wrong indicators |
| **L1 Indicator truth** | EMA/RSI/ATR/ST/TD/Phase match benchmark outputs | Model learns from bad derived features |
| **L2 Event truth** | Indicator changes are persisted as time-stamped events | Trigger appears/disappears as a one-bar ghost |
| **L3 Sequence truth** | Ordered events become named setup journeys | Engine sees notes, not music |
| **L4 Pattern truth** | Sequences are scored against ticker history and global cohorts | Generic rules ignore ticker personality |
| **L5 Action truth** | Day Trader / Active Trader / Investor get horizon-specific posture | Wrong horizon acts on the right data |

---

## 3. Indicator parity: "once right, always right"

### 3.1 Benchmark source

TradingView remains the practical benchmark source for complex chart
indicators. For a diverse sample set, manually export indicator values for a
fixed period using a TradingView script and commit those exports as immutable
fixtures.

Recommended sample:

- Broad indexes: `SPY`, `QQQ`, `IWM`, `DIA`
- Sector / commodity ETFs: `XLE`, `XLK`, `XLV`, `USO`, `GLD`
- Large-cap trend: `NVDA`, `MSFT`, `META`
- Volatile growth / squeeze names: `TSLA`, `PLTR`, `CVNA`, `MSTR`
- Mean-reversion / healthcare / defensive names: `UNH`, `GILD`, `COST`

Recommended timeframes:

- Daily and Weekly first
- 4H and 1H next
- 30m/15m only after D/W/4H/1H parity is proven

### 3.2 TwelveData role

TwelveData should be used as a parity source where it exposes standard
indicators:

- EMA/SMA
- RSI
- ATR
- MACD / momentum-style primitives if needed

TwelveData does **not** appear to expose a native TD Sequential / DeMark TD9
indicator endpoint. TD Sequential should therefore be cross-checked against
TradingView / golden fixtures, not assumed available from TwelveData.

The Phase Oscillator used by this system is custom, so it also needs golden
fixture tests rather than vendor indicator parity.

### 3.3 Indicator contracts to add

Create deterministic fixtures under a versioned path, for example:

```text
data/indicator-fixtures/v1/
  SPY_D_2026-01-01_2026-06-15.json
  USO_W_2025-01-01_2026-06-15.json
  ...
```

Each fixture should include:

```json
{
  "source": "tradingview_export",
  "ticker": "USO",
  "tf": "D",
  "range": {"start": "2025-01-01", "end": "2026-06-15"},
  "candles_source": "twelvedata|alpaca|tradingview",
  "rows": [
    {
      "ts": 1781553600000,
      "close": 115.47,
      "ema21": 133.03,
      "ema200": 100.74,
      "rsi14": 33.3,
      "supertrend_dir": -1,
      "td_setup_dir": "bullish",
      "td_setup_count": 7,
      "phase_value": -65.9,
      "phase_zone": "ACCUMULATION",
      "phase_leaving": false
    }
  ]
}
```

Required parity tests:

1. Candle input parity: fixture candles vs stored candle chain.
2. EMA/RSI/ATR parity: worker output vs TradingView/TwelveData.
3. SuperTrend parity: worker output vs TradingView export.
4. TD Sequential parity on Daily/Weekly.
5. Phase Oscillator parity on Daily/Weekly/1H.
6. Replay/live parity: same fixture bar produces same worker output in replay
   and live compute paths.

Acceptance:

- Exact match for integer/event fields: TD counts, TD direction, phase zone,
  ST direction.
- Numeric tolerance for floating fields: EMA/RSI/ATR/phase values.
- Any discrepancy must be classified as:
  - candle source mismatch,
  - formula mismatch,
  - timeframe/session alignment mismatch,
  - rounding/display mismatch.

---

## 4. From indicators to events

An indicator state is not enough. The model needs to know that something
**changed**.

Examples:

| State A | State B | Event |
|---|---|---|
| Daily TD bullish setup count 6 | count 7 | `td_setup_progress` |
| Daily TD bullish setup count 8 | count 9 | `td9_complete` |
| Phase <= -61.8 | Phase > -61.8 | `phase_left_accumulation` |
| Price below EMA21 | close above EMA21 | `ema21_reclaim` |
| ST bearish and flat | price closes through ST with momentum | `st_breakthrough` |
| Price in discount | price returns to equilibrium | `mean_reversion_target_reached` |

### 4.1 Event ledger schema

Add a first-class event stream rather than relying on transient `flags`.

Proposed table:

```sql
CREATE TABLE IF NOT EXISTS setup_events (
  event_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  tf TEXT NOT NULL,
  event_ts INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  direction TEXT,
  price REAL,
  source TEXT NOT NULL,
  confidence REAL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_setup_events_ticker_ts
  ON setup_events(ticker, event_ts);

CREATE INDEX IF NOT EXISTS idx_setup_events_type_ts
  ON setup_events(event_type, event_ts);
```

Minimum event types:

- `td_setup_progress`
- `td9_complete`
- `td13_complete`
- `phase_entered_extreme`
- `phase_left_extreme`
- `phase_left_accumulation`
- `phase_left_distribution`
- `ema21_reclaim`
- `ema21_reject`
- `ema200_reclaim`
- `ema200_reject`
- `supertrend_flat_opposing`
- `supertrend_flip`
- `supertrend_breakthrough`
- `pdz_discount_entered`
- `pdz_equilibrium_reached`
- `pdz_premium_entered`
- `squeeze_release`
- `momentum_confirmation`
- `pullback_stabilized`

Events should be append-only and idempotent:

```text
event_id = ticker + tf + event_type + direction + event_ts
```

---

## 5. From events to sequences

The model should detect named sequences with stages. A sequence can be
"forming" before it becomes actionable.

### 5.1 Canonical mean-reversion reversal sequence

Example: `td_phase_mean_reversion_long`

| Stage | Requirement | Meaning |
|---|---|---|
| 1. Exhaustion forming | Daily or Weekly TD setup >= 7, phase extreme | The selloff is maturing |
| 2. Exhaustion confirmed | Daily/Weekly TD9 or TD13 completes | Reversal window is open |
| 3. Location valid | price in discount / near SSL / near EMA200 / near major support | Reversal has a place to start |
| 4. Phase leaves zone | phase exits accumulation or stops worsening | Selling pressure is changing character |
| 5. Mean reversion target reached | price returns to EMA21 / equilibrium / flat opposing ST | First objective is met |
| 6. Breakthrough with momentum | close through EMA21/ST with volume/momentum | Reversal can become trend |
| 7. Pullback stabilizes | retest holds above reclaimed level | Active Trader entry window |
| 8. Continuation fires | ST/EMA/squeeze confirmation | Open Long candidate |

The short side mirrors this:

`td_phase_mean_reversion_short`

### 5.2 Sequence object

```json
{
  "sequence_id": "USO:td_phase_mean_reversion_long:2026-06-17",
  "ticker": "USO",
  "sequence_type": "td_phase_mean_reversion_long",
  "direction": "LONG",
  "status": "forming|confirmed|entry_ready|invalidated|completed",
  "stage": 5,
  "max_stage": 8,
  "started_ts": 1781200000000,
  "last_event_ts": 1781653600000,
  "events": ["...event_ids"],
  "context": {
    "location": "discount",
    "mean_reversion_target": "ema21",
    "research_alignment": "energy_breakdown|neutral|constructive",
    "ticker_personality": "pullback_player"
  }
}
```

### 5.3 Posture mapping

Use sequence state to produce the simple Trader vocabulary:

| Sequence state | Trader posture |
|---|---|
| no sequence, no edge | Neutral |
| sequence stages 1-4 bullish | Leaning bullish |
| sequence stages 1-4 bearish | Leaning bearish |
| sequence stages 5-7 bullish, not entered | Bullish |
| sequence stages 5-7 bearish, not entered | Bearish |
| open trader position long | Open Long |
| open trader position short | Open Short |

Long/Short are position words, not bias words.

---

## 6. Diagnosis model: "symptoms to disease"

The engine should reason like diagnosis:

- **Cough:** one weak signal, e.g. phase extreme.
- **Itch / mucus / inflammation:** ordered preconditions, e.g. TD count
  progressing, phase worsening, price entering discount, RSI divergence.
- **Throat infection:** confirmed sequence, e.g. TD9 + phase leaving + reclaim.
- **Treatment plan:** Day Trader mean reversion, Active Trader pullback entry,
  Investor hold/reduce depending on horizon.

This means every event should carry:

- what changed,
- what it changed from,
- how quickly it changed,
- where price was when it changed,
- whether that location historically matters for this ticker,
- what usually happens next.

---

## 7. Expected onset and path forecast

Diagnosis answers **what condition is forming**. The next question is:

> Given this diagnosis, what is the likely onset, path, and use of time?

If a ticker is exhausted, the system should not stop at "reversal likely." It
should estimate whether the next path is more likely to be:

- sharp reversal,
- slow drift / basing,
- failed bounce then continuation,
- violent squeeze,
- multi-day pullback before entry,
- thesis-changing breakdown / breakout.

### 7.1 Path archetypes

Every confirmed sequence should emit a path forecast:

```json
{
  "path_forecast": {
    "primary_path": "sharp_reversal|drift_base|failed_bounce|squeeze|pullback_then_continue|trend_continuation",
    "direction": "LONG|SHORT|NEUTRAL",
    "time_to_onset_bars": {"p25": 2, "median": 5, "p75": 9},
    "time_to_target_bars": {"p25": 6, "median": 14, "p75": 24},
    "expected_first_target": "ema21|equilibrium|supertrend|prior_low|prior_high|vwap",
    "pullback_expected": true,
    "confidence": 0.62,
    "matched_cohort": "td9_phase_discount_high_vix_energy",
    "sample_size": 41
  }
}
```

The forecast must include **time**, not just price:

- time from exhaustion to first reversal attempt,
- time from reversal attempt to mean-reversion target,
- time from target to pullback/retest,
- time window where the edge decays,
- expected hold time by horizon.

### 7.2 Macro and sector context

The same pattern can have different expected paths under different context.

Examples:

| Pattern | Context | Likely path difference |
|---|---|---|
| Exhaustion + phase leaving | high VIX + risk-off tape | sharper reversal attempts but higher failure/whipsaw risk |
| Exhaustion + phase leaving | low VIX + supportive sector | slower, cleaner drift/base and continuation |
| Energy TD exhaustion | research desk calling Energy breakdown | bounce may be tactical only; mean-reversion target may be the exit, not a new long thesis |
| Short exhaustion in high-beta growth | market risk-on + sector leadership | squeeze risk higher; shorts need faster invalidation |
| Bearish setup in weak sector | high VIX + sector underweight | downside follow-through window can extend beyond first target |

Minimum context dimensions:

- VIX regime: low, elevated, high, panic.
- Index posture: risk-on, balanced, risk-off.
- Sector posture: leading, neutral, lagging, underweight.
- Research desk alignment: supportive, neutral, opposed.
- Breadth / rotation: broadening, narrowing, defensive.
- Ticker personality: pullback player, volatile runner, slow grinder,
  mean reverter, trend follower.
- Liquidity/volatility: ATR percentile, RVOL, gap behavior.

### 7.3 Bidirectional symmetry

Patterns must work both ways.

For longs:

- selling exhaustion,
- discount / support location,
- phase leaves accumulation,
- reclaim or breakthrough,
- pullback holds,
- continuation fires.

For shorts:

- buying exhaustion,
- premium / resistance location,
- phase leaves distribution,
- rejection or breakdown,
- bounce fails,
- continuation lower fires.

The short side is not just "inverse long." Context matters:

- high VIX can accelerate downside but also create violent short-covering,
- low VIX can make shorts drift slowly and require patience,
- sector weakness can extend downside targets,
- crowded bearish research can make first downside target a cover zone.

### 7.4 Historical cohort matching

For every active sequence, the engine should query historical analogs:

```text
same ticker first → same sector/personality → same market regime → global cohort
```

The cohort should answer:

1. How often did this pattern reverse sharply?
2. How often did it drift/base first?
3. What was median time to first target?
4. What was median time to invalidation?
5. Did the move need a pullback/retest before continuation?
6. Did high VIX / sector weakness / research opposition change the path?
7. Did the pattern work differently for longs vs shorts?

### 7.5 Horizon translation

The same diagnosis/path forecast should translate differently by horizon:

| Horizon | Uses path forecast to decide |
|---|---|
| **Day Trader** | likely next intraday move, time-to-onset, scalp target, no-chase warning |
| **Active Trader** | whether to wait for pullback stabilization or enter on confirmation |
| **Investor** | whether the move is tactical noise, add opportunity, or thesis warning |

Example:

```text
Diagnosis: Daily TD9 + phase left accumulation near discount.
Path forecast: 62% drift/base before continuation; median 5 bars to EMA21.
Day Trader: prepare for mean-reversion bounce; do not chase if already at EMA21.
Active Trader: wait for pullback hold after EMA21 reclaim.
Investor: tactical only unless Weekly/Monthly thesis also turns.
```

---

## 8. Horizon-specific outputs

### Day Trader

Question: **What is likely soon?**

Use:

- intraday + daily exhaustion forming,
- TD/phase compression/extension,
- opening range / VWAP / liquidity sweeps,
- ticker-specific reaction history to the same sequence.

Output:

- Neutral / Leaning bullish / Leaning bearish / Bullish / Bearish
- expected next move window,
- invalidation level,
- mean-reversion target,
- "prepare, do not chase" guidance when exhaustion is forming.

### Active Trader

Question: **Is there a 1-5 day trade forming or ready?**

Use:

- Daily/4H/1H sequence state,
- expected onset/path forecast,
- pullback stabilization after reclaim,
- ST/EMA confirmation,
- PDZ location,
- historical sequence outcome for this ticker/cohort.

Output:

- posture,
- entry trigger,
- stop/targets,
- reason this is a setup vs just a bounce.

### Investor

Question: **Does this affect the multi-week/month thesis?**

Use:

- Monthly/Weekly/Daily trend,
- RS rank,
- thesis invalidation,
- research desk regime,
- whether expected path is tactical or thesis-changing,
- whether Trader reversal is tactical or thesis-changing.

Output:

- Accumulate / Core Hold / Watch / Reduce / Avoid.

---

## 9. Calibration exercise queue

Weights likely need a focused recalibration after data/indicator hardening.
Do not recalibrate weights until L0/L1 parity is proven.

### 9.1 Calibration inputs

- Closed Trader trades with entry/exit/MFE/MAE.
- Missed moves from discovery.
- `timed_trail` snapshots.
- Recomputed indicator event sequences from candle history.
- Research desk regime tags.
- Ticker personality profiles.

### 9.2 Calibration outputs

- sequence hit rate,
- average MFE before MAE,
- time-to-target,
- time-to-onset,
- path archetype distribution,
- edge half-life / decay window,
- pullback-stabilization success rate,
- false-positive rate by ticker personality,
- best confirmation trigger per sequence,
- revised posture thresholds.

### 9.3 Questions to answer

1. Which TD/phase sequences predict a tradable reversal vs a dead-cat bounce?
2. Does Daily TD9 + Weekly TD7 behave differently than Daily TD9 alone?
3. What is the best confirmation after phase leaves extreme:
   - EMA21 reclaim,
   - ST breakthrough,
   - squeeze release,
   - RSI divergence confirmation,
   - VWAP reclaim?
4. Which tickers reverse immediately vs require retest/pullback?
5. How long does the edge survive after TD9/TD13 completion?
6. Which research desk regimes amplify or suppress the sequence?
7. Which macro/sector regimes change path shape from sharp reversal to drift?
8. Which patterns are symmetrical for shorts, and which require different
   confirmation/invalidation logic?

---

## 10. Implementation phases

### Phase 1 — Indicator parity contract

- Build TradingView export script.
- Export fixture set.
- Add parity tests for EMA/RSI/ATR/ST/TD/Phase.
- Document accepted tolerances.

### Phase 2 — Event ledger

- Normalize existing `flags`, `triggers[]`, TD, Phase, EMA, ST, PDZ into
  append-only `setup_events`.
- Backfill events from historical candles for the fixture universe.
- Add event idempotency tests.

### Phase 3 — Sequence detector

- Implement first two sequence families:
  - `td_phase_mean_reversion_long`
  - `td_phase_mean_reversion_short`
- Emit sequence status/stage into ticker payload.
- Map sequence status to Trader posture.

### Phase 4 — Path forecast model

- Attach macro/sector/research/ticker-personality context to active sequences.
- Build historical cohorts and path archetype distributions.
- Emit time-to-onset, time-to-target, edge-decay, and expected pullback/retest
  fields into the sequence object.

### Phase 5 — Historical mining

- Replay event sequences across full backtest history.
- Join to closed trades and missed moves.
- Produce reliability tables by ticker, sector, personality, and regime.

### Phase 6 — Calibration and promotion

- Recalibrate weights after indicator/event parity.
- Promote only sequences that pass replay/live parity and out-of-sample gates.
- Add sequence explanations to right rail and daily/day-trade outputs.

---

## 11. Non-negotiables

1. **Indicator parity before weight calibration.**
2. **Events before sequences.**
3. **Sequences before path forecasts.**
4. **Path forecasts before model weights.**
5. **Horizon separation:** Day Trader, Active Trader, Investor cannot share a
   single posture without context.
6. **Long/Short are position labels. Bullish/Bearish are bias labels.**
7. **Patterns must be validated bidirectionally; shorts are first-class.**
8. **No production action from a new sequence until replay/live parity passes.**

