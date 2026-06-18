# Setup Event Name Map v1

**Status:** audit-backed mapping  
**Created:** 2026-06-18  
**Purpose:** map shadow `event_type` names to shipped payload fields, compute
functions, and consumers before any D1 `setup_events` writes or sequence
promotion.

Companion docs:

- [`active-trader-information-hardening-plan.md`](active-trader-information-hardening-plan.md)
- [`signal-family-catalog-v1.md`](signal-family-catalog-v1.md)

Shadow modules:

- `worker/foundation/setup-events.js` — event atom contract
- `worker/foundation/setup-event-derivation.js` — snapshot diff bridge
- `worker/foundation/setup-sequences.js` — sequence detector
- `worker/foundation/setup-diagnostics-route.js` — admin read path

Admin diagnostic: `GET /timed/admin/setup-diagnostics?ticker=XYZ`

---

## Field alias traps (read before SQL/cohort filters)

| Canonical derivation field | Live `td_sequential.per_tf` | `setup_snapshot.td_seq` |
|---|---|---|
| `bullish_prep_count` | `bullish_prep_count` | `bull_prep` |
| `bearish_prep_count` | `bearish_prep_count` | `bear_prep` |
| `td9_bullish` | `td9_bullish` | `td9_bull` |
| `td9_bearish` | `td9_bearish` | `td9_bear` |
| `td13_bullish` | `td13_bullish` | `td13_bull` |
| `td13_bearish` | `td13_bearish` | `td13_bear` |

| PDZ source | Daily | 4H |
|---|---|---|
| `tf_tech.{TF}.pdz.zone` | `D` | `4H` / `240` |
| Top-level payload | `pdz_zone_D` | `pdz_zone_4h` |
| `setup_snapshot.pdz` | `pdz.D` | `pdz.h4` (not `pdz.4h`) |

---

## Event map

| event_type | Shipped field(s) | Derivation | Horizons | Tests |
|---|---|---|---|---|
| `td_setup_progress` | `td_sequential.per_tf.{TF}.bullish_prep_count` / `bearish_prep_count` (aliases: `bull_prep`, `bear_prep`) | `deriveSetupEvents` when count >= 7 and rising | Active Trader D/W/60 | `setup-event-derivation.test.js` |
| `td9_complete` | `td9_bullish` / `td9_bearish` (alias: `td9_bull` / `td9_bear`) | edge-detect on TD9 boolean | Active Trader | same |
| `td13_complete` | `td13_bullish` / `td13_bearish` | edge-detect on TD13 boolean | Active Trader | same |
| `phase_entered_extreme` | `tf_tech.{TF}.saty.v` | abs(value) >= 61.8 entry | Active Trader | same |
| `phase_left_accumulation` | `tf_tech.{TF}.saty.l.accum` or cross above -61.8 | edge-detect | Active Trader | same |
| `phase_left_distribution` | `tf_tech.{TF}.saty.l.distrib` or cross below +61.8 | edge-detect | Active Trader | same |
| `phase_left_extreme` | `tf_tech.{TF}.saty.l.extDn` / `extUp` | edge-detect | Active Trader | same |
| `rsi_extreme_entered` | `tf_tech.{TF}.rsi.r5` | RSI <= 30 (long) / >= 70 (short) | Active Trader | same |
| `rsi_extreme_left` | `tf_tech.{TF}.rsi.r5` | exit extreme zone | Active Trader | same |
| `rsi_divergence_confirmed` | `tf_tech.{TF}.rsiDiv.bull.a` / `bear.a` | edge-detect | Active Trader | same |
| `ema21_reclaim` / `ema21_reject` | price vs `tf_tech.{TF}.ema.ema21` | cross detection | Active Trader | same |
| `ema200_reclaim` / `ema200_reject` | price vs `tf_tech.{TF}.ema.ema200` | cross detection | Active Trader | same |
| `supertrend_flip` | `tf_tech.{TF}.stDir` | sign change | Active Trader | same |
| `pdz_discount_entered` | PDZ zone includes `discount` | zone transition | Active Trader | same |
| `pdz_premium_entered` | PDZ zone includes `premium` | zone transition | Active Trader | same |
| `pdz_equilibrium_reached` | PDZ zone `equilibrium` from discount/premium | zone transition | Active Trader | same |
| `fvg_filled` | `tf_tech.{TF}.fvg.ib` / `ibr` | edge-detect | Active Trader | same |
| `squeeze_release` | `tf_tech.{TF}.sq.r` | edge-detect | Active Trader | same |
| `vwap_reclaim` / `vwap_reject` | `tf_tech.{TF}.vwapAbove` | boolean flip | Day Trader first | same |
| `orb_breakout` | `orb.primary.breakout` | session ORB | Day Trader / Active | same |
| `orb_reclaim` | `orb.primary.reclaim` | edge-detect | Day Trader / Active | same |
| `orb_failed_breakout` | `orb.primary.fakeout` | edge-detect | Day Trader / Active | same |
| `mean_reversion_target_reached` | price vs EMA21 after exhaustion events | window-level derivation | Active Trader | same |
| `pullback_stabilized` | hold above/below EMA21 for N snapshots post reclaim | window-level derivation | Active Trader | same |

### Shipped but not yet mapped to events

| Shipped signal | Existing path | Notes |
|---|---|---|
| `detectMeanReversionTD9` | `worker/indicators.js` | maps to TD9 + phase family; do not invent parallel name |
| `mean_reversion_pdz` | sizing / entry context | sequence location stage input |
| `computeTimingOverlay` | `worker/timing-signals.js` | Day Trader horizon; `timing_extension_watch` / `timing_compression_watch` reserved |
| `flags.st_flip_*`, `flags.fvg_*`, `flags.liq_*` | `detectFlags` | normalize before D1 ledger |
| `flags.sq30_release`, `flags.sq1h_release` | squeeze release | overlaps `squeeze_release` event |

---

## Sequence families (Phase 3 shadow)

| sequence_type | Stage events consumed | Posture mapping |
|---|---|---|
| `td_phase_mean_reversion_long` | exhaustion -> location -> phase leave -> target -> breakthrough -> pullback -> continuation | stages 1-4 Leaning bullish; 5-7 Bullish; 8 + open position Open Long |
| `td_phase_mean_reversion_short` | mirror with premium / distribution / reject paths | stages 1-4 Leaning bearish; 5-7 Bearish; 8 Open Short |

Path forecast context inputs (shadow v1): `vix_regime`, `sector_posture`,
`research_alignment`, `ticker_personality`, `index_posture`,
`regime_forecast_state`, `regime_forecast_confidence`.

Historical cohort matching (Phase 4) is **not** wired yet.

---

## Idempotency contract

```text
event_id = ticker + tf + event_type + direction + event_ts
```

Re-running `deriveSetupEvents(prev, cur)` on the same pair must not duplicate
events. Re-running `deriveSetupEventsFromWindow` on the same sorted window
must produce the same deduped `event_id` set.
