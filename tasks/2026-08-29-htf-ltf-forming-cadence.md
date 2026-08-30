# LTF + complementary HTF forming (different cadences)

Shipped on `cursor/htf-ltf-forming-cadence-dbdd`. Companion diagnosis:
`tasks/2026-08-29-june-present-move-review.md` (PR #1383).

## What changed

`worker/mtf-forming.js` — `resolveFormingPair`:

| Clock | TFs | Meaning |
|---|---|---|
| LTF (fast) | 10m / 30m / 1H | Constructing (ST / 5-12 / structure / score) |
| HTF (slow) | 4H / D / W | Forming (turn: 4H ST, daily 21, D magnet) or formed (score+ST already with) |

Complementary = same side, LTF forming, HTF forming **or** formed, weekly/monthly ST not sloping against. HTF score may still be negative on a turn. LTF structure cues are side-aware so a bullish 30m/1H stack cannot count as SHORT forming. Stretch chase (`pct_above_e21 > 4` and `days_above_e21 > 5` unless HTF already formed) is not complementary.

Wired to:

1. `inferSide` — `HTF_BEAR_LTF_PULLBACK` is no longer auto-SHORT when the pair is a long turn (TSLA Aug 13).
2. SuperTrend trigger — parked daily bear is not `htf_against` when the pair is complementary (`freshness = htf_forming`).
3. Snapshot stamp — `assembleTickerData` writes `_mtf_forming`.
4. Entry — `tt_forming_pair` before the pullback/momentum reject cascade.

Kill switch (default ON): `deep_audit_forming_pair_enabled` and
`deep_audit_forming_pair_entry` in `REPLAY_DA_KEYS`.

Does **not** fire AAPL-June dumps (15m+30m structure broken).

## Verify

```
npx vitest run worker/mtf-forming.test.js worker/supertrend-hold.test.js worker/foundation/play-catalog.test.js worker/discovery/gameplan.test.js
```

## Preprod (2026-08-29)

- Worker: `timed-trading-ingest-preprod` version `2b929f0a-b1a7-473f-977b-d59ed2644aa3` from this branch. **Not** deployed to prod.
- Flags ON: `deep_audit_forming_pair_enabled`, `deep_audit_forming_pair_entry`.
- Copied prod Jun–Aug 2026 candles for TEAM / TSLA / AAPL (10/15/30/60/240/D/W/M/5). TEAM 10m now ends 2026-08-28 (was 2026-06-18).
- ON arms ran 2026-08-29. 30m, TEAM/TSLA/AAPL, ticker-batch=3.

### ON results (not the OFF control)

| Run | Trades | What filled | TEAM |
|---|---|---|---|
| `forming-pair-team-jul-on` | 3 | All **TSLA SHORT** `tt_forming_pair` (Jul 20 +$22, Jul 22 +$81, Jul 27 −$1). Realized **+$102**. | **0**. Jul 8–15 blocks: conviction floor (50/84), then rank/tier/oppose. Jul 13+ often `HTF_BULL_LTF_BULL` with rank 72–100 and conviction still under the floor. |
| `forming-pair-team-aug-on` | 1 | **AAPL LONG** `tt_forming_pair` Aug 28, **+$206 `replay_end_close`** (open mark, not realized). | **0**. Aug 3–13 is `HTF_BULL_LTF_BULL` (htf +22..+33) and dies on conviction / rank / consensus. |

TSLA Aug 13 printed the review shape (`HTF_BEAR_LTF_PULLBACK`, LTF +8..+24, HTF −10) and still died on `focus_tier_c_below_c_floor` / `h3_rank_below_transitional_floor` — not on BEAR-substring SHORT.

**Verdict:** the new path fires (TSLA shorts, late AAPL long). TEAM-style continuation is still gated **above** `tt_forming_pair` by conviction/rank. Do not lower the 60 accumulate floor from this.

## Floor carve-out (2026-08-29, live-model slice)

Complementary clocks were not the bind. Conviction/rank/tier-C sit in
front of `tt_forming_pair`. Carve-outs (mirrors reclaim P15, **LONG only**):

| Gate | Forming-pair LONG complementary |
|---|---|
| `focus_conviction_below_floor` | floor → `deep_audit_forming_pair_conviction_floor` (default 40, hard min 35) |
| `focus_tier_c_suspended` / `focus_tier_c_below_c_floor` | bypass |
| `h3_rank_below_transitional_floor` | bypass |
| `h3_consensus_below_min` | bypass |
| `v15_veto_all_signals_oppose` | **kept** (catastrophe veto) |

SHORT is excluded so TEAM Jul 8 `HTF_BEAR_LTF_BEAR` cannot fade the rip.
AAPL June dumps stay dead (15m+30m structure broken → not complementary).
`tt_forming_pair` is also exempt from `ja_location_gate` (PDZ labels early
legs premium, same as `tt_htf_reclaim`).

Flags (default ON): `deep_audit_forming_pair_floors`,
`deep_audit_forming_pair_conviction_floor`.

Canaries this slice must catch on preprod Jul+Aug ON v2:

- **TEAM** Jul 13+ continuation LONG
- **TSLA** Aug 13 turn LONG (not only the July shorts)
- **AAPL** valid complementary longs; June dump still 0

Do **not** implement Discovery's global 60→55 accumulate floor.

## Bias / parked HTF color (TSLA Aug 13)

Jul ON v2 caught TEAM longs and AAPL longs. Aug ON v2 TEAM continued to fill,
but TSLA Aug 13 cleared the new floors and then died on `tt_bias_not_aligned`
all 14 bars — daily 20/21 cloud still the old color (the turn). Complementary
LONG now qualifies **before** cloud-bias (`before_bias: true`). Parked daily
ST is also not `tt_daily_st_conflict` in forming-pair context.

Aug ON v3–v5 still shorted TSLA Aug 13 (`thesis_flip_htf` / `doctrine_force_exit`)
even after inferSide was LONG on the live fill snapshot (`htf -10`, `ltf +15.7`,
4H ST bull). The bind was persist, not qualify: `tt_forming_pair` has no
`long`/`short` suffix, so `processTradeSimulation` used `getTradeDirection(state)`
(BEAR substring → SHORT). `resolveEntryPersistDirection` now writes inferSide.

### August ON v6 (persist fix, preprod `cc223f03`)

Zero shorts. Canaries all LONG `tt_forming_pair`:

| Ticker | n | Realized $ | Open mark $ | Turn / continuation |
|---|---|---|---|---|
| TEAM | 7 | +39 | +858 (`replay_end_close` Aug 26 @ 168.26) | Continuation from Aug 3 @ 105.93 |
| TSLA | 5 | +244 | 0 | **Aug 13 14:30 LONG @ 333.69, +$284** (was SHORT in v3–v5). Aug 10 also LONG @ 329.66. |
| AAPL | 7 | +126 | +207 | Complementary longs; no dump shape in August |

Book realized ~+$409; open mark ~+$1,065.

**Management (hold winners, this slice):** TEAM Aug 3/7/24 were `max_loss` same-day −2%; Aug 10/18 were `RUNNER_TOP_FORMATION_1H` flatten at +3.5/+4.6%. The Aug 26 hold (`replay_end_close` +16% @ 190.37) is the proof. Forming-pair LONGs now defer those day-trade fuses (plus doctrine / thesis flip / parked daily `ema_regime_reversed` / Trend-Hold giveback set) while HTF structure holds. 1H runner-top trims instead of flattening. Catastrophe floor stays −6%. `PHASE_LEAVE*` still fires (TSLA Aug 13 +$284). Do not enable global `deep_audit_trend_hold_enabled`. Flag: `deep_audit_forming_pair_hold_winners` (default ON). Identity is the ticket `entry_path`.

### August ON v7 (hold-winners, preprod `8f3021cb`)

Zero shorts. Same three canaries, fewer TEAM chops:

| Ticker | n | Realized $ | Open mark $ | What changed vs v6 |
|---|---|---|---|---|
| TEAM | 5 | +193 | +857 (Aug 26 @ 168.26 → 190.37) | Aug 3 held 3d, 85% trim @ 109.70, leftover SL **+$194** (was same-day `max_loss` −$157). Aug 7 held 11d, MFE 13.5%, 90% trim @ 166.44, leftover SL **+$214** (was same-day `max_loss` −$213). Aug 24 `max_loss` still fired (structure said no). |
| TSLA | 5 | +186 | 0 | **Aug 13 14:30 LONG @ 333.69, +$285 `PHASE_LEAVE_100`**. Aug 17 `ema_regime_reversed` deferred; `bias_flip_full_bear_vs_long` took the next exit. |
| AAPL | 7 | −83 | +207 | Doctrine deferred on Aug 6; `phase_i_mfe_cut_8h` then cut −$180. |

Book realized ~+$297 (v6 was +$409 because it re-entered after those max_loss cuts and harvested 1H tops). TEAM realized +$193 vs +$39. Do not enable global Trend-Hold. Do not deploy this hold-winners revision to production until the operator signs off — live already has the persist-only build.

### TEAM Aug 24 autopsy (v7 → v8)

Exit bar (2026-08-25 17:00, `max_loss` −2.31% @ 167.74): `HTF_BULL_LTF_PULLBACK`, **HTF +32.7**, LTF −23.7, daily 21 **+8.33% / +7.56% slope**. Next fill Aug 26 @ 168.26 rode to 190.

`ltfBrokenBoth` (15m+30m bear, RSI not washed) treated that shake like AAPL June. Hold now lets LTF-broken through when HTF is still with the long and the daily 21 is not lost. AAPL June stays dead (`pct_above_e21` −1.8).

### August ON v8 (Aug 24 shake hold, preprod `90a2ca08`)

TEAM Aug 24 @ 171.71 is no longer `max_loss`. Held through MAE −4.5%, 50% trim @ 177.62, `replay_end_close` @ 190.37 **+$1,164** (+12.9%, MFE 13.5%). The Aug 26 re-entry at 168 is gone — one position rode the rest of the rip.

| Ticker | n | Realized $ | Open mark $ | Note |
|---|---|---|---|---|
| TEAM | 4 | +402 | +1,164 | Aug 3/7 same-day max_loss still gone. Aug 24 hold is the new mark. |
| TSLA | 6 | −52 | 0 | Aug 13 `PHASE_LEAVE` +$285 intact. Aug 25 then died `phase_i_mfe_cut_8h` −$233 (v7 was a scratch POST_TRIM). |
| AAPL | 7 | −83 | +207 | Unchanged vs v7. |

Book realized ~+$268 / open ~+$1,370. TEAM total (realized+open) **+$1,566** vs v7 +$1,051. Zero shorts. Do not enable global Trend-Hold. Do not deploy to production until the operator signs off.

```
scripts/monthly-slice.sh \
  --month=2026-07 \
  --run-id=forming-pair-team-jul-on \
  --label=forming-pair-team-jul-on \
  --tickers=TEAM,TSLA,AAPL \
  --ticker-batch=3 \
  --interval-minutes=30 \
  --watchdog-seconds=900 \
  --block-chain \
  --api-base=https://timed-trading-ingest-preprod.shashant.workers.dev
```
