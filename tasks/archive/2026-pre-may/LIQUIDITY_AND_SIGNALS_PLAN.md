# Liquidity Zones, Setup Stalking & Investor Mode — Master Plan

> Compiled from deep analysis of 231 closed trades (Jul 2025–Mar 2026),  
> full 4H candle backfill (126,263 bars, 203 tickers), and signal-level audits.

---

## Executive Summary

Three analyses revealed massive untapped P&L across entry selection, exit timing, and investor mode:

| Finding | Impact | Status |
|---------|--------|--------|
| **Liquidity zones as price magnets** | +$352/trade P&L delta (4H 3+piv) | Analysis complete |
| **Congested entries near zones** | $2,466 in avoidable losses | Analysis complete |
| **Left money on table (exits before zone)** | 103 of 171 trades exited before MFE | Analysis complete |
| **Setup lead-up signals missing** | No "stalking" phase — only captures current bar | Analysis complete |
| **SHORT logic bugs** | Zero SHORT trades in backtest | **Fixed** |
| **Investor mode replay gaps** | RS ranks & market health hardcoded to 50 | Analysis complete |

**Projected P&L uplift from implementation:** $3,000–$5,500 (on the 231-trade dataset)

---

## Part 1: Liquidity Zone Integration

### Evidence (from 4H 3+ pivot analysis — 1,463 avg bars per ticker)

```
Coverage:           74% of trades had an active zone (171 of 231)
Magnet rate:        42% of trades reached the zone (swept or approached)
MFE hit rate:       68% — price PEAKED at the zone even when we exited early
P&L when reached:   avg +$219/trade
P&L when NOT:       avg -$133/trade
P&L DELTA:          +$352/trade — the strongest signal we've found
Left money:         103 trades exited before their MFE
```

**Entry distance matters:**
```
<1 ATR from zone:   134 trades, 48.5% WR, avg P&L +$13   (congested)
>1 ATR from zone:    37 trades, 56.8% WR, avg P&L +$25   (room to run)
Delta: +8pp WR advantage with room to run
```

**Top congested entry losses (entered <0.5 ATR from zone):**
```
ARRY SHORT  $6.78 → zone $6.75 (0.14 ATR)   → P&L -$1,556
LRN  LONG   $128  → zone $128  (0.25 ATR)   → P&L -$815
PANW SHORT  $174  → zone $174  (0.10 ATR)   → P&L -$432
ELF  LONG   $140  → zone $140  (0.01 ATR)   → P&L -$420
MSTR SHORT  $320  → zone $319  (0.07 ATR)   → P&L -$338
```

**Sensitivity: Which TF & pivot count?**

| TF & Setting | Coverage | Magnet Rate | P&L Delta | MFE Hit |
|---|---|---|---|---|
| **4H (3+ pivots)** ← recommended | **74%** | 42% | **+$352** | **68%** |
| 4H (2+ pivots) | 89% | 43% | +$340 | 70% |
| Daily (2+ pivots) | 70% | 43% | +$280 | 48% |
| Daily (3+ pivots) | 31% | 46% | +$236 | 43% |

**Decision:** Use **4H with 3+ pivots** as primary, Daily as secondary for runners.

---

### Phase 1A: Persist Liquidity Zones in Signal Snapshots

**Why first:** Can't learn from zones unless they're saved with each trade.

**Files:** `worker/index.js` (signal snapshot builder), `worker/indicators.js`

**Steps:**
1. In `assembleTickerData()`, ensure `liq` data from `computeTfBundle()` is propagated to the top-level ticker data for 4H, D, W timeframes
2. In the signal snapshot builder (used at entry, trim, exit), add fields:
   - `liq_4H: { nearest_bs: { level, dist_atr, count }, nearest_ss: { level, dist_atr, count } }`
   - `liq_D: { nearest_bs: { level, dist_atr, count }, nearest_ss: { level, dist_atr, count } }`
   - `liq_W: { nearest_bs: { level, dist_atr, count }, nearest_ss: { level, dist_atr, count } }`
3. This enables post-trade analysis of zone interactions without re-computing from candles

---

### Phase 1B: Liquidity-Aware Entry Quality (Congestion Filter)

**Why:** $2,466 in losses from entries within 0.5 ATR of a zone. 48.5% WR vs 56.8% for entries with room.

**File:** `worker/indicators.js` — `computeEntryQualityScore()`

**Steps:**
1. Accept `liq_4H` data as a parameter to `computeEntryQualityScore()`
2. For LONG: check nearest buyside zone distance in ATR
   - `< 0.5 ATR` → subtract 10 pts from EQ (congestion penalty)
   - `0.5–1.0 ATR` → subtract 5 pts
   - `1.5–4.0 ATR` → add 5 pts (ideal room to run)
   - `> 4.0 ATR` → neutral (zone too far to be relevant)
3. For SHORT: mirror with nearest sellside zone
4. Log: `[EQ_LIQ] {ticker} {dir} buyside {dist:.1f}ATR → penalty/bonus {pts}`

**Expected impact:** Block or downsize the 19 congested trades → save ~$2,000

---

### Phase 1C: Liquidity-Aware Trim Targets

**Why:** 103 trades left money on table. 68% of the time, MFE actually reached the zone during the trade.

**File:** `worker/index.js` — trim logic + `evaluateRunnerExit()`

**Steps:**
1. At entry, compute `tp_zone_4H` = nearest 4H buyside level (LONG) or sellside level (SHORT)
2. Store `tp_zone_4H` on the trade record (in `_replayTradeState` or execState)
3. **Trim target:** When price reaches within 0.2 ATR of `tp_zone_4H`:
   - If untrimmed → trigger MFE Safety Trim (66% trim)
   - If already trimmed → tighten runner trail to 0.5x ATR (zone is being tested)
4. **Zone swept logic:** If price closes ABOVE (LONG) / BELOW (SHORT) the zone:
   - Zone is consumed — shift target to next zone or Daily zone
   - Tighten trail to 1.0x ATR (magnet is gone, protect gains)
5. Also compute `tp_zone_D` = nearest Daily zone for runner long-range target
   - Runner stays open as long as Daily zone hasn't been reached AND 4H ST supports

**Expected impact:** Capture 20-40% more of MFE on trades that currently exit early

---

### Phase 1D: Liquidity Zone Rejection Filter

**Why:** Entering within 0.5 ATR of a strong zone (4+ pivots) when momentum is weakening is a high-probability loss.

**File:** `worker/index.js` — `qualifiesForEnter()`

**Steps:**
1. After computing entry path and before returning `qualifies: true`:
   - If nearest target zone (buyside for LONG, sellside for SHORT) is `< 0.5 ATR` away AND zone has 4+ pivots:
     - If momentum indicators are weakening (RSI declining, fuel < 50, phase elevated):
       - Return `qualifies: false, reason: "liq_congestion_rejection"`
     - If momentum is strong: allow entry but log warning
2. Track rejections in `_replayBlockedEntries` for backtest diagnostics

---

### Phase 2: Liquidity Sweep as Setup Signal

**Why:** When a liquidity zone is swept (e.g., sellside taken out) and price recovers, it signals institutional accumulation. This is a high-probability entry signal.

**File:** `worker/indicators.js` — new `detectLiquiditySweep()` function

**Steps:**
1. Track zone sweep events: when price dips below sellside zone and then closes back above
2. Emit a `liq_sweep_bull` flag (or `liq_sweep_bear` for buyside sweep + rejection)
3. Wire as positive confirmation in `computeEntryQualityScore()`: +8 pts for sweep recovery
4. Wire as entry path modifier: `liq_sweep` confirmation can substitute for `st_flip` or `ema_cross`

**Note:** This is Phase 2 because it requires validated Phase 1 data to tune properly.

---

## Part 2: Setup Lead-Up Phase ("Lion Stalking")

### Evidence

The system only captures signal state at the moment of entry. It doesn't track the build-up:

| Indicator | Has Recency Tracking? | Used as Positive Setup Signal? |
|---|---|---|
| TD Sequential | Current count only, no "TD9 in last N bars" | Blocker only (exhaustion guard) |
| Phase Oscillator | Current-bar zone exit | Confirmation, not "phase just completed" |
| SuperTrend flips | `stBarsSinceFlip` exists | Danger detection, not "fresh pullback recovery" |
| RSI Divergence | `barsSince` + active (≤10 bars) | Danger signal, not positive reversal |
| EMA Crosses | Timestamp on cross bar only | In flags, no "cross within last N bars" |
| Squeeze | Timestamp on release bar only | Confirmation bonus, no lookback |

### Phase 2A: Add Lookback Features to Bundle

**File:** `worker/indicators.js` — `computeTfBundle()`

**Steps:**
1. **TD9 opposite reversal lookback**: Scan last 20 bars for completed TD9 setup in the OPPOSITE direction
   - New fields: `td9_bull_in_20` (boolean), `td9_bear_in_20` (boolean), `td9_bars_ago` (int)
   - A completed sell setup (SP=9) in recent history before a LONG entry is a powerful reversal signal
2. **RSI extreme recovery**: Track if RSI was extreme (<30 or >70) in last 15 bars and has since recovered
   - New fields: `rsi_was_extreme_lo_15` (boolean), `rsi_was_extreme_hi_15` (boolean), `rsi_extreme_bars_ago` (int)
3. **Phase completion lookback**: Check if `satyPhase.leaving` fired in last 10 bars
   - New fields: `phase_left_ext_up_10` (boolean), `phase_left_ext_dn_10` (boolean)
4. **ST flip freshness classification**:
   - `stBarsSinceFlip` already exists but isn't used positively
   - New: `st_flip_fresh` = true if `stBarsSinceFlip` between 3 and 15 (ideal recovery window)
5. **EMA cross recency**: Track bars since last EMA(13)/EMA(48) cross
   - New field: `ema_cross_bars_ago` (int)

---

### Phase 2B: Wire Lookback Features into Entry Quality

**File:** `worker/indicators.js` — `computeEntryQualityScore()`

**Steps:**
1. In the LTF Recovery section, add bonus points:
   - `td9_bull_in_20` (for LONG) or `td9_bear_in_20` (for SHORT): +5 pts ("opposing exhaustion signal")
   - `rsi_was_extreme` + recovery: +4 pts ("bounce from extreme")
   - `phase_left_ext`: +3 pts ("opposing phase completed")
   - `st_flip_fresh` on leading TF: +3 pts ("fresh recovery underway")
   - `ema_cross_bars_ago < 10`: +2 pts ("structural shift recent")
2. Total lookback bonus capped at +12 pts to avoid overweighting

---

### Phase 2C: Persist Lead-Up History in Signal Snapshot

**File:** `worker/index.js` — signal snapshot builder

**Steps:**
1. Add a `leadup` section to `signal_snapshot_json`:
   ```json
   "leadup": {
     "td9_opposite_bars_ago": 12,
     "rsi_extreme_lo_bars_ago": 8,
     "phase_left_ext_up_bars_ago": 5,
     "st_flip_fresh_15m": true,
     "ema_cross_bars_ago_15m": 7
   }
   ```
2. This enables future analysis of which lead-up patterns correlate with winners

---

### Phase 2D: Ticker Personality Profiles (Future)

**Why:** Some tickers build bases before breaking out (CAT, DE), others mean-revert (ELF), others trend strongly (AVGO, TSLA). Knowing the personality allows overrides.

**Approach:**
1. After accumulating 50+ trades per ticker, compute:
   - Average bars to trim, bars to exit
   - Preferred entry path distribution
   - Pullback depth tolerance (how far it dips before resuming)
   - ATR-normalized typical move size
2. Store as `ticker_personality` in KV or D1
3. Use for dynamic SL width (volatile tickers get wider) and hold duration expectations

**This is a longer-term item** — requires enough trade history per ticker.

---

## Part 3: Investor Mode Improvements

### Evidence

| Gap | Impact | Difficulty |
|-----|--------|------------|
| RS ranks hardcoded to 50 in replay | Backtest doesn't reflect relative strength | Medium |
| Market health hardcoded to 50 in replay | No regime context in backtest | Medium |
| No persistent peak_price for trailing stop | Trailing stop resets daily instead of true high-water mark | Easy |
| Daily SuperTrend not used in scoring | Missing intermediate TF signal | Easy |
| No D/W/M SuperTrend alignment gate | No structural filter for entries | Easy |

### Phase 3A: Quick Wins (Easy, High Impact)

**File:** `worker/investor.js`

1. **Add Daily SuperTrend to scoring** (+5 pts max):
   - Daily ST bullish AND aligned with Weekly → +5 pts
   - Daily ST bullish, Weekly neutral → +3 pts
   - Daily ST bearish → +0 (no penalty, just no bonus)

2. **Persist peak_price on investor_positions**:
   - On each scoring cycle, update `peak_price = MAX(peak_price, current_price)`
   - Use for trailing stop: `stop = peak_price * (1 - trail_pct)`
   - Currently resets to `max(price, avg_entry)` each day — misses the true high-water mark

3. **D/W/M SuperTrend alignment gate**:
   - New entries require at least 2 of 3 SuperTrends bullish (D, W, M)
   - Monthly bearish = hard block on new entries (can still hold existing)

---

### Phase 3B: Replay Fidelity

**File:** `worker/investor.js` — replay/backtest path

1. **Compute RS ranks from historical candles**:
   - During investor replay, for each day, compute each ticker's RS vs SPY using the available candle data
   - Replace the hardcoded `rsRank: 50` with actual computed percentile
   - This makes investor backtest results meaningful

2. **Compute market health from replay data**:
   - Use the universe of tickers scored that day to compute market breadth
   - `healthScore = pctAbove200dEMA * 0.4 + pctBullishWeeklyST * 0.3 + avgRSI * 0.3`
   - Replace hardcoded 50 with this computed value

3. **Wire thesis health check in replay**:
   - The `checkThesisHealth()` function exists but is disconnected during replay
   - Connect it so investor replay can also exit positions that fail thesis checks

---

## Part 4: Already Completed (Reference)

### SHORT Logic Bugs — FIXED

| Bug | What Happened | Fix Applied |
|-----|---------------|-------------|
| `ema_regime_early_short` used `hasStFlipBull` | Bullish ST flip as SHORT confirmation = wrong direction | Changed to `flags.st_flip_bear` (line 3326) |
| DA-4 `deep_audit_min_htf_score` blocked ALL shorts | `htf < daMinHtf` with positive threshold blocks all negative HTF | Made direction-aware: SHORTs need `htf <= -daMinHtf` |
| GOLD SHORT thresholds too strict | Required `htf >= 35` and `ltf >= 25` | Relaxed to `htf >= 30`, `ltf >= 22`, added RSI divergence |

### Other Recent Fixes (Applied)

- **Entry Quality Inversion** — New EQ formula rewards HTF foundation + LTF pullback recovery
- **Stall Force-Close** — Untrimmed trades closed after 36 hours
- **1H+30m Fully Extended Downgrade** — Confidence reduction, not hard block
- **4H candle backfill** — 126,263 bars uploaded via TwelveData (450 days, 203 tickers)

---

## Implementation Priority

| # | Phase | Impact | Effort | Dependencies |
|---|-------|--------|--------|-------------|
| 1 | **1A: Persist liquidity in snapshots** | Foundation | Small | None |
| 2 | **1B: EQ congestion penalty** | -$2,000 in losses | Small | 1A |
| 3 | **1C: Liquidity-aware trim targets** | +$2,000-3,000 P&L | Medium | 1A |
| 4 | **3A: Investor quick wins** | Better investor results | Small | None |
| 5 | **1D: Rejection filter** | Fewer bad entries | Small | 1A |
| 6 | **2A: Lookback features** | Smarter entry signals | Medium | None |
| 7 | **2B: Wire lookback into EQ** | Better entry quality | Small | 6 |
| 8 | **3B: Replay fidelity** | Meaningful investor backtest | Medium | None |
| 9 | **2: Liquidity sweep signal** | New entry catalyst | Medium | 1A, validated |
| 10 | **2D: Ticker personality** | Per-ticker optimization | Large | Trade history |

**Phases 1-5 can be implemented in a single sprint and validated with one backtest.**
**Phases 6-8 are independent and can be parallelized.**
**Phases 9-10 require validated data from earlier phases.**

---

## Validation Plan

After implementing Phases 1A–1D + 2A–2B:
1. Run `calibrated-v4` backtest (Jul 2025 – Dec 2025, 5m interval)
2. Compare vs `calibrated-v3` baseline:
   - Win Rate target: maintain 70%+ (currently ~70%)
   - P&L target: +40% improvement (~$5,000 → ~$7,000+)
   - Congested entry losses: should drop by $2,000+
   - Avg MFE capture: should increase from 56% to 70%+
3. Review liquidity zone data in signal snapshots — verify zones are saved correctly
4. Review entry quality scores — verify congestion penalty is firing on the right trades
5. If results positive, deploy to live system

---

## Files Modified

| File | Phases | Changes |
|------|--------|---------|
| `worker/indicators.js` | 1A, 1B, 2A, 2B | EQ scoring + lookback features + liq propagation |
| `worker/index.js` | 1A, 1C, 1D, 2C | Signal snapshot + trim targets + rejection filter |
| `worker/investor.js` | 3A, 3B | Scoring + replay fidelity |
| `react-app/trade-autopsy.html` | Display | Show liquidity zone data in modal |
| `react-app/simulation-dashboard.html` | Display | Show zone proximity in trade details |
