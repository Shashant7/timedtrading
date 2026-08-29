# June–present 2026 move review

Window: **2026-06-01 → 2026-08-28**. Question: what did followed names
actually do, which existing scores/signals would have flagged each move,
and why the engine does not use the universe + multi-timeframe stack to
spot a move forming on LTF with HTF confluence.

Sources (pulled 2026-08-29): live `timed:move-discovery` (COO, generated
2026-08-28T22:08Z, 60-day ATR scan), weekly ≥10% autopsy (8 weeks from
2026-07-06), coverage-gaps (60d), production D1 `trades` / `investor_lots`
/ `ticker_candles` (tf=`D`) / `trail_5m_facts`. Companion movies already
on disk: July ST/LT autopsies, 13–19 Aug book review, TSLA week movie,
ST MTF review.

This is diagnosis, not a scoring rewrite.

---

## Verdict in one page

The tape from June through late August had three distinct movies. The
book ran one offense the whole time: **long ATH-breakout + support
bounce**. Capture of ATR-qualified moves in the rolling 60d window is
**3.3%** (19 partial + 5 churned of 582; 0 full). Weekly ≥10% range
moves: **1%** touched (10 of 1019). Canary names (NBIS, BE, DELL, MU,
CRDO, OKLO): **45 / 45 missed**.

The MTF data is on the snapshot. It is used as a **veto**, not as a
**detector**. `classifyState()` is only `sign(htf) × sign(ltf)`. Gold
long wants HTF already green. Continuation (`tt_momentum`, `tt_reclaim`,
`tt_mean_revert`) and almost all shorts sat idle. So:

- When LTF turns first and HTF is still red (TSLA Aug 13–21), `enter_now`
  stays 0.
- When HTF and LTF are already aligned for weeks (TEAM Jul–Aug), there
  is no continuation play to fire.
- When HTF is still green and LTF is washing out (AAPL June), the gold
  path *does* fire — on the dump.

Lowering `accumulate_strong_score_min` 60 → 55 (current Discovery
gameplan #1) would have bought more June-1 investor baskets, not TEAM
or TSLA. Do not apply that knob from this review.

---

## 1. What the followed tape actually did

Daily closes from `ticker_candles` (tf=`D`). June 1 / June 30 / Jul 31 /
Aug 28.

### June — growth dump, small-cap / industrial hold

| Name | Jun 1 | Jun 30 | Jun % | Book |
|---|---|---|---|---|
| SPY | 758.54 | 746.77 | −1.6 | SPY ATH long Jun 2, stagnant scratch |
| QQQ | 742.74 | 736.40 | −0.9 | QQQ support long Jun 22, stopped |
| IWM | 288.98 | 300.45 | **+4.0** | 3 IWM longs, mixed |
| NVDA | 224.36 | 200.09 | −10.8 | range-reversal long Jun 22 @ 209.90 → 194.83 (−$245) |
| AAPL | 306.31 | 289.36 | −5.5 | ATH long Jun 5 @ 310.25 → 288.49 HARD_LOSS_CAP (−$312) |
| AMZN | 261.26 | 238.34 | −8.8 | none |
| PLTR | 160.65 | 116.67 | −27.4 | none |
| TEAM | 115.95 | 77.79 | −32.9 | none |
| CRM | 209.60 | 156.66 | −25.3 | none |
| TSLA | 415.88 | 420.60 | +1.1 | investor trim only (PRE_CPI) |
| GEV | 950.54 | 1174.86 | **+23.6** | support long Jun 26 @ 1073, still open Aug 28 @ 911 |
| AXON | 476.88 | 560.61 | **+17.6** | later partial |
| PH | 823.30 | 978.12 | **+18.8** | later churned |
| RTX | 174.41 | 189.73 | **+8.8** | later churned |
| IESC | 677.43 | 734.66 | +8.5 | investor accumulate Jun 1 @ 666 |

June ST book: **14 live trades, 4W / 9L / 1 open, −$865**. Paths:
ATH 6 / pullback 3 / n-test 3 / range-reversal 2. All LONG. Short
plays idle while PLTR/TEAM/CRM/NVDA sold off.

Investor Jun 1 15:00 UTC: auto_entry_accumulate basket (CRS, IESC,
FSLR, WTS, ASTS, TSM, SATS, RIOT, AVGO, IREN, …). Jun 8–9:
PRE_CPI_RISK_REDUCTION trims across the book. That is score-threshold
deploy, not LTF timing.

### July — washout then violent rebounds

QQQ 736 → 688 (−6.6% July). TSLA 421 → 311. NBIS 276 → 190 after a
Jul 1 gap (276 → 229). AAOI 148 → 94. TEAM 78 → 101 (base of the
later rip). AMZN 238 → 272 (+14%; Jul 31 +15% day is a coverage-gap
miss). GEV 1175 → 990 (gave back the June run).

ST book: **32 live, 9W / 23L, −$1,259**. Still ATH + n-test. July
autopsies already named the failure: first-print entries, LTF broken,
no 5-12 curl, investor HTF score without LTF stabilization.

### August — CHOP + Nasdaq pullback + a few real movies

SPY 747 → 769. QQQ 688 → 716 (still below June). TEAM **101 → 190**.
CRM **184 → 256**. PLTR **123 → 186**. IESC **745 → 310 (−58%)**.
TSLA 311 → 349 via the Aug 13–21 21-reclaim (week movie: 327 → 363).
NBIS spiked to 281 week of Aug 10, then back to 209.

ST book: **80 live, 16W / 42L / 22 open, ~flat $**. New paper:
cloud-pivot long 17 (−$136) / short 17 (+$194). Core still ATH 19
(−$478) and n-test 19 (+$507, concentrated). 13–19 Aug closed 25 at
**17% WR / −$817**.

---

## 2. Capture vs the moves (live Discovery)

Rolling 60d ending 2026-08-28 (almost no June — 5 stored misses start
in June; the June dump is outside this scoreboard).

| | |
|---|---|
| Moves (≥3× ATR, windows 5/10/20/40d, 200 tickers) | 582 |
| Unique tickers | 184 |
| Full / partial / churned / missed | **0 / 19 / 5 / 558** |
| Capture rate | 3.3% |
| Missed UP / DOWN (big) | 350 / 208 (317 / 177) |
| Binding constraint (gameplan) | **CONVICTION_TOO_LOW 143 / 159** |
| Diagnosis (top 150 misses) | low_htf 68 · qualification_gap 60 · low_rank 15 · wrong_state 6 · **no_signals 0 · should_have_entered 0** |

Partial/churn names only: AXON, EMR, ETN, GE, HII, JD, MTB, PH, PKG,
RPG, RTX, SPOT, UNP. Industrials and a couple of mega-cap cousins —
not TEAM, NBIS, AAOI, CRWV, PLTR, CRM, IESC, TSLA.

Mega (≥15%) missed longs (examples): TEAM +137% (Jul 23–Aug 28) and
+94% (Jul 8–Aug 13), NBIS +87%, AAOI +80%, CRWV +77%, BMNR +73%,
ESTC +60%, AU +56%, PLTR +52%, CRM +54%. Mega shorts: IESC −61% /
−59% / −53%.

Weekly autopsy (Jul 6–Aug 28, |week range| ≥ 10%): 1019 moves, 4
touched, 6 partial. Miss-reason mix is **current snapshot**, not
as-of-the-move, and **TICK/ADD leaked in** (weekly autopsy does not
use `isDiscoveryEligibleTicker`). Treat 389 confirm_lag / 382
low_rank / 216 wrong_state as directional only. Canary 100% miss is
still real: those names are tradeable and the book never overlapped
the week.

Coverage-gaps (single-day ≥3× ATR, 60d): 28 days, **0 captured**, 27
labeled `not_scored` (no admission-cohort row that day). Includes
AMZN 2026-07-31 +15.3%.

---

## 3. What the existing stack would have shown

### How state and confluence actually work

`computeWeightedHTFScore`: M 10 / W 20 / D 40 / 4H 30 (+ Ichimoku
blend). `computeWeightedLTFScore`: 1H 50 / 30m 30 / 10m 20. Both
exist on every scored snapshot.

`classifyState(htf, ltf)` is four buckets from the **signs only**:

| | LTF ≥ 0 | LTF < 0 |
|---|---|---|
| HTF ≥ 0 | HTF_BULL_LTF_BULL | HTF_BULL_LTF_PULLBACK |
| HTF < 0 | HTF_BEAR_LTF_PULLBACK | HTF_BEAR_LTF_BEAR |

There is no "forming" state. Pullback means "scores disagree," not
"higher-low on 30m against a held daily 21."

Gold long (`worker/index.js`): HTF_BULL_LTF_PULLBACK with `h ≥ 10`
and `l ∈ [−15, 5]`, or a corridor with `h > 0`. Gold short: blow-off
HTF_BULL_LTF_BULL with `h ≥ 25` and `l ≥ 15`. LTF-only SuperTrend
ignition is **vetoed on HTF color** (`computeSupertrendTrigger`,
`freshness = htf_against`) unless weekly/monthly slope agrees.

8-layer `scoreRootConfluence` + ST slope → RIDE/READY/DRIFT/FADE/WAIT.
That is opportunity-plus-trigger, not a universe scan for LTF-form +
HTF-compatible.

Post-July gates (`ltfStructureBlock`, `tapeAlignmentBlock`, investor
233-reclaim / LTF stabilize) **block bad longs**. They do not emit
"this name is forming."

### Three trail-backed movies

**TEAM Jul 8–Aug 13 (+94%, MISSED).** 2531 trail buckets: avg HTF
**+8.6**, LTF **+7.2**, rank **71**. Signals: 193 ST flips, 308 EMA
crosses, 103 squeezes. State mix: **1509 HTF_BULL_LTF_BULL** (htf
+16 / ltf +16 / rank 78), 402 HTF_BULL_LTF_PULLBACK. The name was
aligned for most of the rip. `tt_momentum` did not run. Diagnosis
`no_signals = 0` is correct — the miss is admission/play, not
blindness.

**TSLA Aug 13–21 (21-reclaim ride, enter_now=0).** Dominant
**HTF_BEAR_LTF_PULLBACK** (461 buckets, htf −9.6, ltf **+13.3**,
rank 64). That is exactly "LTF already with the move, HTF still
red." 4H ST had been bull since Aug 7; daily 21 reclaimed Aug 13.
Gold long cannot fire. Friday cloud-pivot printed after $357.

**AAPL Jun 5–30 (ATH long into the dump).** After the Jun 5 fill,
trail is **590 HTF_BULL_LTF_PULLBACK** (htf +14.4, ltf −16.7) vs
337 HTF_BULL_LTF_BULL. The gold-long shape and a rolling-over
mega-cap look the same to `classifyState`. The book bought the
label.

### What each indicator family was for

| Tool | What it is good at | What it did Jun–Aug |
|---|---|---|
| HTF/LTF scores + 2×2 state | Regime color | Vetoed TSLA; stayed green on AAPL dump; sat aligned on TEAM with no play |
| SuperTrend MTF | Slope-with is the closed-book edge (W/M +3.6 / +6.3pp) | LTF-only trigger dies on HTF color; daily flip is late (TSLA Fri) |
| Daily 21 reclaim / 4H ST | The actual TSLA entry | Visible on the CTO card; not an entry path |
| 8-layer confluence | RIDE vs WAIT | TSLA WAIT 2/8 while 4H ST was already bull |
| TT ATH / n-test | Breakout and dip-buy | The only plays that ran; bled in CHOP; missed continuation |
| Cloud pivot / confirm-stack | LTF 5-12 + 1H | Paper, often after the break |
| Investor accumulate ≥60 | HTF score deploy | Jun 1 basket; July LT autopsy: no 10m ST / 5-12 / 233 |
| Discovery / gameplan | Rear-view ATR scoreboard | 3.3% capture; first rec is a score-floor cut |

---

## 4. What is missing

Not "more candles" and not "a lower rank floor."

1. **A forming detector, not another veto.** Walk the scoring universe
   on the */5 cron and emit a watch when LTF is *constructing* (30m/1H
   HL or 5-12 curl, 10m ST slope-with) **and** HTF is *compatible*
   (weekly/monthly not sloping against; daily 21 holding or reclaiming;
   4H ST already with the move) even if `htf_score` is still negative.
   That is the TSLA Aug 13 print. Today that state is
   `HTF_BEAR_LTF_PULLBACK` → gold long false → `enter_now` 0.

2. **A continuation play that is allowed to fire.** TEAM spent weeks in
   `HTF_BULL_LTF_BULL` with rank 78 and a pile of ST/EMA/squeeze prints.
   `tt_momentum` / `tt_reclaim` / `tt_mean_revert` are in `KNOWN_PLAYS`
   and idle. Offense concentration: ATH + n-test (~60% of Jun–Aug live
   fills). Aligned trend is treated as "too late / 29% WR corridor"
   from a Jan–Feb replay, so the engine waits for a pullback that
   never comes or chases ATH instead.

3. **HTF color must stop being a hard veto of LTF ignition when
   swing TFs already agree.** `computeSupertrendTrigger` already
   exempts weekly/monthly slope. It still zeros an LTF-only trigger
   on a *parked* daily bear. TSLA's daily ST was the magnet, not the
   start gun (ST MTF review + week movie).

4. **Gold long must not treat every HTF_BULL_LTF_PULLBACK as a buy.**
   AAPL June was that state while price made lower highs. The July
   `ltfStructureBlock` (15m+30m broken, hourly not strong) is the
   right *shape* of fix; it is a block on speculative ATH/support,
   not a rewrite of `classifyState`.

5. **Short corridor is the wrong movie for a cascade.** Gold short
   wants a blow-off (`HTF_BULL_LTF_BULL` overextended). June
   PLTR/TEAM/CRM and August IESC were HTF already rolling or
   `HTF_BEAR_*`. `tt_atl_breakdown` / gap-reversal short / range
   short idle. IESC −58% Jun 30 → Aug 28 had no short overlap.

6. **Discovery cannot spot a forming move.** Nightly ATR scan is
   rear-view (move already ≥3× ATR over 5–40d). Officers get a
   gameplan about *missed* moves. Nothing in the 5-minute path asks
   "which of the ~250 names is forming right now?"

7. **Do not take the 60 → 55 accumulate rec.** 558 in-universe misses
   are not "score was 58." TEAM's average rank in the rip was 71.
   Investor Jun 1 already deployed on score. The July LT autopsy is
   the counter-example.

---

## 5. Direct answer: why the list + MTF cannot "spot the move"

It can see the pieces. It is wired so that "spot" means "HTF score
already agrees, rank cleared, a TT setup that is ATH or support
qualified, and ST trigger not HTF-against."

A move that is *forming* fails that sentence on purpose:

- LTF forming while HTF is still red → state is not gold long; ST
  trigger is `htf_against`.
- LTF and HTF already aligned → gold path wants a pullback;
  momentum is idle; ATH is the only long that fires, often late or
  into CHOP.
- HTF still green while LTF is breaking → gold long *succeeds* and
  the book buys the dump.

That is not a data-provider gap and not a universe-coverage gap
(`missed_out_of_universe = 0`). It is a **play + state-machine gap**.
The list is scored every five minutes. The 2×2 and the gold corridor
throw away the forming window, and the play catalog does not have a
live continuation or a live "HTF-compatible LTF turn" entry.

---

## 6. If a thin slice is next (not in this PR)

Keep it one play, shadow first, no score-floor cut.

- **Forming-long watch** (TSLA Aug 13 archetype): `HTF_BEAR_LTF_PULLBACK`
  + 4H ST slope long + daily 21 reclaim or hold + weekly ST not
  sloping against → stamp `_armed_playbooks` / desk strip. Do not
  auto-size until a replay month (Jul+Aug) is green.
- **Continuation-long watch** (TEAM Jul archetype): `HTF_BULL_LTF_BULL`
  for N hours, rank ≥ 60, W/M ST not against, not stretched >1.5 ATR
  off daily 21 → allow `tt_momentum` or a defined 21-reclaim add.
  Measure vs the idle-play row, not vs ATH.
- Hygiene: filter TICK/ADD from weekly autopsy the same way
  `isDiscoveryEligibleTicker` already filters Discovery.

Replay before any live size. The July ST book already showed what
happens when a new long path inherits ATH admission holes.
