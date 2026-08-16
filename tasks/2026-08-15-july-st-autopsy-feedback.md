# July 2026 Short-Term Autopsy Feedback (operator) — batch 1

Source: operator grading of `live-short-term-2026-07` trades (PKG, BRK-B,
XLI, INTC, MTB) cross-checked against the D1 trade rows
(`backtest_run_trades`, run `live-short-term-2026-07`), the stored
`entry_signals_json` snapshots, and the `ticker_candles` tape.

Companion to [2026-08-04-july-lt-autopsy-feedback.md](2026-08-04-july-lt-autopsy-feedback.md)
(long-term lane). Several failure families appear in BOTH lanes — those are
model-level problems, not lane-level ones (see "Cross-lane synthesis").

---

## Lane scoreboard (July, short-term)

32 trades: **8 W / 22 L / 2 open**. Only **1 of 32 ever trimmed**.
12 trades reached ≥ +1.5% MFE; most round-tripped to breakeven or a loss:

| Ticker | MFE | Final | Ticker | MFE | Final |
|---|---|---|---|---|---|
| KO (Jul 15) | +3.04% | −1.93% | XLK | +2.92% | −0.82% |
| JCI | +2.84% | −3.40% | ETN | +2.38% | −0.13% |
| DE | +3.07% | −2.97% | PPG | +2.57% | +0.03% |
| WM | +2.31% | −3.43% | BRK-B | +2.54% | +0.95% |

Entries cluster in 30–90s bursts from single scan cycles: 3 at the Jul 1
open (9:30:20 / 9:31:07 / 9:31:54), 2 at the Jul 7 open, KO+JCI 11:04,
SPHB+XLK 13:33, HALO+RTX+XLRE 15:02–15:08, DE+WM 15:05–15:06.

---

## Per-trade forensics (operator verdict × engine finding)

### 1. PKG — Jul 1, 9:30:20 AM ET · Gap Reversal (Long) · Confirmed
- **Operator:** not much we could have done; trade didn't play out.
- **Row:** entry 238.28 → STALL_FORCE_CLOSE Jul 7 at 234.97 (−1.39%). MFE +0.65 / MAE −2.12.
- **Engine finding:** entered **20 seconds** after the open. Snapshot showed
  `has_adverse_rsi_div: true`, `daily_adverse_prep: 13`, PDZ
  premium_approach on D and 4H. Even the "no fault" trade was admitted at
  the opening print with adverse context stacked against it. Stall close
  after 6 days was correct capital hygiene.

### 2. BRK-B — Jul 1, 9:31:07 AM ET · Support Bounce · Confirmed
- **Operator:** good entry, good trim. Exit should have been earlier; SL
  should have been near entry after the trim (many cloud + ST supports
  broke across timeframes post-trim).
- **Row:** entry 499.90 → 50% trim Jul 7 9:58 AM at 511.475 (+2.3%) → exit
  Jul 8 10:28 AM at 497.86 (**below entry**) via `phase_i_mfe_dead_money_24h`.
  Net +0.95% on a +2.54% MFE trade.
- **Engine finding:** the runner gave back the entire move over 24.5h and
  the exit was the dead-money *clock*, not structure. Three concrete gaps:
  1. `resolveTradeProtectionStage` (worker/index.js ~9591) recomputes the
     stage **per tick**; the breakeven-lock branch requires `pnlPct >= 0`,
     so the lock dissolves exactly when price crosses back through entry —
     the moment it is needed. Stages are not monotonic/persisted.
  2. `deep_audit_breakeven_skip_trimmed_runner` (~22830) skips the
     BREAKEVEN_STOP entirely for trimmed ≥ 50% runners — exempting exactly
     the cohort the operator wants protected.
  3. A structure exit (`SMART_RUNNER_SUPPORT_BREAK_CLOUD`) exists but did
     not fire ahead of the dead-money clock despite multi-TF cloud/ST
     breaks after the trim.

### 3. XLI — Jul 1, 9:31:54 AM ET · ATH Breakout · Confirmed
- **Operator:** entry/exit 3 minutes apart; chasing right out of the open. Bad entry.
- **Row:** entry 184.88 → `sl_breached` at 182.70, 2m27s later (−1.18%).
- **Engine finding (two independent failures):**
  1. **Stale entry print.** The 9:30 10m bar traded o=184.37 h=184.63
     l=182.72 — the recorded entry 184.88 is *above the bar's traded range*
     and matches the 9:20 pre-market print (185.23 area). The bar was
     already flushing when we "filled".
  2. **Blocked cohort entered anyway.** The admission matrix has had
     `tt_ath_breakout:LONG:Confirmed → block_when: "always"` since
     2026-05-04 (24% WR, no edge), yet this live entry was admitted.
     Either `setup_grade` was empty at admission time (`admitSetup` returns
     `missing_inputs_default_allow`) or the live lane bypassed the
     `tt-core-entry` admission gate. **Needs verification** — this is an
     enforcement gap, not a tuning gap.

### 4. INTC — Jul 1, 11:49:28 AM ET · Support Bounce · Prime
- **Operator:** entry/exit 2 minutes apart; entry does not match price
  action at that point; seemed forced, no support established.
- **Row:** entry 134.60 → `max_loss` at 129.33, 2m13s later (−3.92%). MAE −4.93%.
- **Engine finding:** confirmed — **the entry price was ~2 hours stale**.
  The tape at 11:40–11:50 ET was 129.3–129.5; 134.60 is the 9:30–9:50 open
  range (open candles printed 134.03–135.24). The "max_loss 2 minutes
  later" was the engine catching up to the real price; the trade was a
  phantom fill that never existed at 134.60. Additionally the 10m candles
  for INTC that day are mostly degenerate (o=h=l=c single-quote samples),
  so any "support established" computation was reading flat synthetic bars
  — the operator's "no support established" is literally true in the data.
  The live entry fresh-price guard (worker/index.js ~25897, comment dated
  2026-07-01) either deployed after this trade or its divergence threshold
  missed it — verify deploy date and that it covers the TT setup entry path.

### 5. MTB — Jul 7, 9:32:39 AM ET · ATH Breakout · Speculative
- **Operator:** trade ok but severe drawdown, exited at the drawdown and
  missed the quick recovery. Entry was a pullback that failed to clear the
  previous swing high, then rejected, swept the liquidity below, and
  reversed — we were caught in the middle.
- **Row:** entry 239.92 → `doctrine_force_exit` Jul 8 2:58 PM at 233.48
  (−2.68%). MFE +0.87 / MAE −3.28 — exit landed near the MAE low.
- **Engine finding:**
  1. Entry price 239.92 is the **exact 9:20 pre-market print** (a
     degenerate o=h=l=c bar) — third stale-print entry in this batch.
  2. Structure at entry: 9:10 pre-market swing high 243.42 never cleared;
     entry mid-range under resistance → textbook "caught in the middle".
     Snapshot had adverse 4H phase divergence + premium_approach PDZ.
  3. `tt_ath_breakout:LONG:Speculative` had **no matrix row until
     2026-07-30** (the WM P0) — it default-allowed in July.
  4. Exit side: `doctrine_force_exit` fired into the flush near the lows.
     No sweep-reclaim awareness — the same "exited the drawdown, missed the
     recovery" behavior the LT lane showed on MTZ/ANET.

---

## Batch 2 per-trade forensics (operator feedback 2026-08-15 PM)

### 6. XLI — Jul 7, 9:33:45 AM ET · ATH Breakout · Speculative
- **Operator:** entry and exit 2 minutes apart.
- **Row:** entry 184.21 → `sl_breached` 66 seconds later at 182.59 (−0.88%).
- **Engine finding:** identical failure to XLI Jul 1 — opening chase +
  Speculative ATH breakout (default-allowed until the Jul 30 matrix row).
  Same P1/P2/P8 stack; no new pattern.

### 7. WAL — Jul 7, 10:22:41 AM ET · Support Bounce · Speculative
- **Operator:** entry ok, but WAL is a slow bank stock; exit was right at
  the downside peak with TD9 about to reverse; a trim and exit happened at
  the same time while losing. Use our levels for support/resistance rather
  than a hard loss cap — if entry is so far from prior support that testing
  it produces a hard loss cap, skip the entry. And when the support that
  justified the entry was lost, exit then.
- **Row:** entry 82.63 → `HARD_LOSS_CAP` Jul 8 10:30:41 AM at 79.14
  (−4.22%). **trim_ts is 11 seconds before exit_ts, trim_price = exit_price
  = 79.14** — the "trim" was part of the loss liquidation, not banking.
- **Tape:** Jul 8 flushed 81.08 → 77.89 (11:00 AM low, ~30 min after our
  exit) then V-recovered to 79.3+ by early afternoon. We sold into the
  flush; the operator's "TD9 about to reverse" is visible in the tape.
- **Engine findings:**
  1. **The SL was never the support level.** The SL fallback chain
     (worker/index.js ~25980) is: TradingView SL → adaptive ATR multiple →
     1.5×ATR → flat 2.5%. Structural anchors exist only for
     liquidity-sweep and ORB entries. A *support bounce* setup does not
     anchor its stop to the support that justified the entry.
  2. **HARD_LOSS_CAP is a dollar cap** (`deep_audit_hard_loss_cap`,
     default $250) — pure risk-budget math, zero structure awareness. It
     fired into the flush lows, exactly where a level-based system holds
     or waits for the reclaim test.
  3. Entry snapshot: adverse 15m phase div, PDZ premium_approach D+4H,
     regime TRANSITIONAL, Speculative grade — P3 again.
  4. The trim row pollutes analytics: `trimmed_pct=0.5` on a −4.2% loss
     reads as profit banking in any cohort query.

### 8. GRNY — Jul 9, 9:38:05 AM ET · Support Bounce · Confirmed
- **Operator:** entry was actually really good (right exhaustion + support
  bounce); clean exit when support was lost; well executed. But entry,
  trim and stop were all within ~$1 — GRNY moves slow, was basing after a
  run-up, and is rarely a good ST trade. Evaluate how we choose tickers
  that can actually deliver the expected move. Also: many support-bounce
  entries initially work, then lose support, sweep below the 233 EMA (seen
  on 4H), and *then* reverse — fragile intraday support vs true support.
- **Row:** entry 27.64 → 65% trim Jul 13 at 27.8198 (+0.65%) → exit Jul 16
  at 27.57 via dead-money (+0.33% net). Entry/trim/exit span **$0.25 over
  7 days**. MFE +1.37 / MAE −0.29.
- **Engine finding:** execution was fine; *selection* was the error. The
  lane has no expected-move screen — nothing checks that a ticker's
  ATR%/ADR% can pay for its risk and hold time in the ST lane. GRNY
  (personality MIXED, fund-like mover) consumed a slot and 7 days of
  capital for 33 bps.

### 9. KO — Jul 10, 2:03:11 PM ET · ATH Breakout · Confirmed
- **Operator:** entry was really good; the exit seems false — price never
  hit 81.40 on Jul 13, and true support was ~80 anyway. Map support right
  and this trade works. Also: catalyst context should have supported the
  hold (FIFA live event with KO a major sponsor, earnings upcoming, price
  had flirted with the 4H and D 233 EMA and held).
- **Row:** entry 83.39 → `sl_breached` Jul 13 **9:33:57 AM** at
  **81.39998104** (−2.39%).
- **Tape (confirmed phantom):** Jul 13's low was **83.67** — KO never
  traded within 2.7% of 81.40. The exit fired 4 minutes after the open and
  the fill was recorded at the SL *level* (81.39998…), not a market print.
  KO rallied to 84.68 that same morning. **The model booked a fabricated
  −2.39% loss on a trade that was working.**
- **Also:** `tt_ath_breakout:LONG:Confirmed` — the always-blocked cohort —
  entered again (P8 instance #2: XLI Jul 1, KO Jul 10). And KO #2 (Jul 15,
  Speculative, default-allowed pre-Jul-30) reached **+3.04% MFE with zero
  trim** before dying at the same 81.40 level — that second exit was real
  (Jul 17 was a genuine all-day selloff), but the round-trip is P4 again.

---

## Batch 3 per-trade forensics (operator feedback 2026-08-15 PM)

### 10. CIBR — Jul 10, 2:04:31 PM ET · ATH Breakout · Speculative
- **Operator:** good entry (4H ST bounce), nice trim, exit at entry area
  was good protection. But the 200 EMA → 4H 233 EMA bounce began ~3 weeks
  earlier — the trend was mature and we entered near the peak of that
  leg. Our entry level became sellside liquidity; when price failed to
  break above the Daily 5-12 cloud and closed below it, the SSL was the
  draw (exit good). After an SSL sweep, a subsequent support bounce is an
  ideal entry — price has shown promise. CIBR then hit the 233 EMA,
  bounced at 87–88, reclaimed the Daily 5-12 cloud, and ran to 100. **We
  identify a good move, catch a part, and miss the meat.** Why no entry
  Jun 26 (Daily 21 EMA reclaim) or Jun 29 (4H ST break after the reclaim —
  strong confirmation)? With the order block mapped, that entry rides the
  drawdown after a trim and sits +10% now. And the re-entry on the reclaim
  should have caught the second leg. Entry timing and re-entry are
  intertwined — we could have caught both moves or one large move.
- **Row:** entry 91.93 → 50% trim Jul 14 10:20 AM at 94.79 (+3.1%) → exit
  Jul 16 at 92.16 (`PROFIT_GIVEBACK_COOLING_HOLD`, +1.68% net). MFE +4.37 /
  MAE −1.51.
- **Tape verification (daily):** validates the timeline nearly to the day —
  Jun 26 first daily close back above the 21 EMA (85.36) after 8 sessions
  below; Jun 29 +3.7% confirmation thrust (88.50); our Jul 10 entry came
  **14 sessions and +11% into the leg**, 2 sessions before the 95.96 peak;
  the pullback bottomed 86.84–87.29 (Jul 23–28, the 233-EMA area); the
  reclaim fired Jul 31 (91.83) and CIBR ran to 102.20 by Aug 13 —
  **a +11% second leg from right where we exited (92.16), watched from
  flat.** From a Jun 29 entry (~87–88): +16% to the Aug high.
- **Engine findings:**
  1. Entry snapshot again had the warnings: adverse 4H phase divergence +
     premium_approach on D and 4H, MIXED personality — and Speculative ATH
     breakout rode the pre-Jul-30 default-allow hole (P8 instance #3 for
     that cohort in July: XLI Jul 7, MTB Jul 7, KO Jul 15, CIBR Jul 10,
     WM Jul 29).
  2. **Reclaim triggers are not an ST entry family in practice.** The
     Jun 26/29 sequence (HTF EMA reclaim → LTF trend-break confirmation)
     is exactly what the LT lane built after ANET (daily EMA-21
     test/reclaim signal) — the ST lane's first CIBR entry of the whole
     leg was Jul 10, the worst admit point in it. Why `tt_pullback_reclaim`
     never fired Jun 26–30 on CIBR needs a decision-trace check.
  3. **No re-entry doctrine.** After an exit, the only mechanism is a
     5-minute cooldown (worker/index.js ~19921) and passive waiting for a
     fresh setup trigger. Nothing arms a re-entry watch on a mapped level
     (233 EMA test → Daily 5-12 reclaim) for a ticker whose HTF thesis
     stayed intact. KO batch-2 feedback said the same ("if it does work
     later, be on guard and ready to re-enter").
  4. **SSL/liquidity zones are SL-only.** The engine tracks 4H/D
     liquidity zones with `swept` flags but consumes them only for stop
     anchoring at entry — not as entry-quality context (post-sweep support
     bounce preference) and not as memory that our own entry/exit prints
     created liquidity levels.
  5. **NEW data bug — duplicate daily bars.** CIBR's D candles for
     Jul 6–10 exist TWICE (ts at 00:00 UTC and 04:00 UTC, same OHLC,
     different `updated_at` — two day-key conventions from a mid-July
     writer change). Every daily indicator scanning those rows (EMA 21/233,
     RSI, D SuperTrend, swing detection) double-counted that week — the
     exact week of these trades. Ties directly into P13 level accuracy.

---

## Batch 4 per-trade forensics (operator feedback 2026-08-15 PM)

### 11. GRNI — Jul 13, 9:35:11 AM ET · Support Bounce · Speculative
- **Operator:** lasted less than a day on a ticker meant to be held a
  while; it has been in a $1 range for months.
- **Row:** entry 21.28 → `thesis_flip_htf` 4.4h later at 21.12 (−0.75%).
- **Engine finding:** P11 (expected-move screen) + horizon mismatch — the
  ST lane both *selected* a months-long $1-range ticker and then
  *churned* it intraday. Entry at 9:35 (P2), adverse 1h phase div +
  premium_approach + TRANSITIONAL + Speculative (P3).

### 12. UNP — Jul 14, 10:06:53 AM ET · ATH Breakout · Confirmed
- **Operator:** like CIBR — entered mid-trend, and the actual support
  bounce happened as we exited. The bounce (60m 72-89 cloud, held) was
  where the entry should have been — or at minimum hold through it
  knowing it is support. UNP went on to break 300.
- **Row:** entry 289.58 → 65% trim Jul 14 3:29 PM at 291.08 (+0.52%) →
  exit Jul 15 at 285.95 (`early_dead_money_flatten`, −0.10% net).
- **Engine findings:** `tt_ath_breakout:LONG:Confirmed` — **the
  always-blocked cohort's third live July entry** (XLI Jul 1, KO Jul 10,
  UNP Jul 14) — with `daily_adverse_prep: 15` in its own snapshot.
  Mid-leg admit (P14), then the flatten sold **at the mapped support**
  (P6/P13: a clock-family exit with zero awareness it was printing into a
  holding 60m cloud), then no re-entry as UNP ran to 300+ (P16). The
  chart the operator attached shows exit at the pivot low.

### 13. KO #2 — Jul 15, 11:04:27 AM ET · ATH Breakout · Speculative
- **Operator:** re-entry was pre-bounce (early), and the exit looks like
  phantom price again.
- **Engine finding:** confirmed by the P10 audit — the exit was booked
  Jul 17 **9:43 AM** at 81.400009 when the tape's low to that point was
  82.79; 81.40 did not trade until ~1:20 PM. Fill recorded at the SL
  level. Second phantom on the same ticker at the same level. Also
  +3.04% MFE with zero trim before the exit (P4).

### 14. JCI — Jul 15, 11:04:57 AM ET · Range Reversal · Speculative
- **Operator:** bad entry — entered as it was losing trend with EMAs
  crossing down; exited as price stabilized.
- **Row:** entry 142.50 → `max_loss` Jul 17 at 137.655 (−3.40%). MFE
  +2.84 untrimmed.
- **Engine finding:** the most damning admit in the lane: the snapshot
  had **`is_f4_severe: true` (adverse RSI div AND adverse phase div,
  weekly-strongest)** in a CHOPPY regime, Speculative grade — and it was
  admitted anyway. Same 11:04 batch cycle as KO #2 (P7). Exit fill also
  flagged marginal in the P10 audit (9:34 AM opening window, 0.16% below
  tape).

### 15. PPG — Jul 16, 12:21:09 PM ET · Range Reversal · Confirmed
- **Operator:** trim well done, exit fair, entry ok (trying to reverse up).
- **Row:** entry 118.23 → 50% trim Jul 17 at 120.83 (+2.2%) → runner
  exited `max_loss` Jul 20 at 115.69 (−2.15% below entry); net +0.03%.
- **Engine finding:** cleanest illustration of P5 — a well-executed +2.2%
  trim followed by the runner riding to a *max_loss* below entry because
  no post-trim floor exists. The trade's entire profit was one flag away
  from being banked.

---

## Mark Newton August Upticks — external reference (ingested)

Publication `1549439` ("Upticks – August 2026", `cro_publication_text`)
carries exact two-tier levels per ticker plus thesis:

| Ticker | Price 8/13 | Support (near / max-decline) | Resistance (initial / target) |
|---|---|---|---|
| GOOGL | 346.36 | 335 / 315 | 384 / 408 (450 eventual) |
| BA | 230.33 | 222 / 205 | 241 / 267 |
| VLO | 342.92 | 291 / 269 | 385 / 424 |
| CVX | 197.70 | 165 / 151 | 248 / 303 |

Level *sources* he uses: weekly trendlines from multi-year lows,
consolidation-base boundaries, prior breakout retests, high-volume
breakdown levels, air pockets ("any break of $305 wouldn't have much
support until March lows just above $240" — CLS), timed with
monthly/weekly RSI divergence and DeMark exhaustion.

**The deletions validate our July losses:**
- **MTB deleted** — monthly RSI > 70 with negative divergence vs the 2024
  runup + weekly AND monthly DeMark exhaustion present after the run. That
  is precisely the profile our Jul 7 MTB long chased (we even had the 4H
  adverse phase div in our own snapshot and ignored it).
- **TT deleted** — high-volume breakdown undercutting the year's support;
  structure deteriorating despite the July bounce. Our Jul 24 TT long took
  **−5.39% MAE** to scrape out +0.22%.

Newton's framework and our own captured signals *agree*; the model just
doesn't consult either at admission or for stop placement.

---

## Overarching patterns (what actually needs refining)

**P1 — Entry price integrity (3 of 5 graded trades).** Stale quotes used
as fills: INTC ~2h stale (−4% instant), XLI above the traded range, MTB an
exact pre-market print. Compounding it, intraday candles are often
quote-sampled (o=h=l=c), so support/structure detection reads flat
synthetic bars. **A model cannot be evaluated, let alone improved, while
entries execute on phantom prices.** This is refinement zero.

**P2 — Opening-window chasing.** 5 of 32 entries inside the first 5
minutes; all 5 losses or dead money. An opening-noise guard exists
(`ripster_opening_chase_guard`, blocks before 9:45) but **only on the
Ripster momentum path** — the TT setup family (`tt_ath_breakout`,
`tt_gap_reversal_long`, `tt_n_test_support`) has no opening gate. The LT
lane got `investorLtfEntryStabilizationBlock` for the same disease; the ST
lane never did.

**P3 — Location-blind admits.** 4 of 6 graded entries carried an *active
adverse divergence* (RSI or phase) at entry, and **all 6** were in
premium / premium_approach PDZ on D and 4H — buying the top of the dealing
range. The signals were captured in `entry_signals_json` and ignored by
admission. MTB's "failed to clear prior swing high" is the same family:
no proof-of-structure requirement (clear the last swing / establish above
cloud) before a long admit.

**P4 — No profit banking in the ST lane.** 1 trim in 32 trades. Eight
trades reached ≥ +2.3% MFE; the lane banked almost none of it (KO +3.04 →
−1.93, JCI +2.84 → −3.40, DE +3.07 → −2.97). The LT lane got the MFE
extension trim (ANET item 9); the ST lane has no equivalent first-target
bank.

**P5 — Post-trim protection is not a ratchet.** Protection stages are
recomputed per tick and dissolve when `pnlPct` dips negative;
`deep_audit_breakeven_skip_trimmed_runner` exempts trimmed runners from
BREAKEVEN_STOP. Net effect: BRK-B's runner rode +2.3% back to below entry.
The operator's rule is simple and correct: **after the trim, the floor is
entry** — persist it on the trade row (monotonic, same arm/fire movie
pattern as ANET primary invalidation).

**P6 — Time-based forced exits fire at the lows.** `doctrine_force_exit`,
`phase_i_mfe_dead_money_24h`, and friends are clocks, not structure. MTB
was force-exited into a liquidity sweep that reversed immediately; BRK-B
waited for a 24h clock while structure had already broken a day of cloud/ST
supports. Exits need the sweep→reclaim-or-fail sequence (arm on the flush
below a swept low, fire on failed reclaim, stand down on reclaim) — the
movie pattern already built for ANET.

**P7 — Correlated batch admits.** Entries arrive in 30–90s bursts from one
scan cycle (open Jul 1 ×3, open Jul 7 ×2, 11:04 ×2, 13:33 ×2, 15:05 ×3).
One bad market moment multiplies across simultaneous fills; DE+WM (Jul 29
15:05–15:06) both lost ~−3% on the same move. No per-cycle admission cap
or correlation/beta-overlap guard exists.

**P8 — Admission enforcement gaps.** `admitSetup` default-allows when the
grade is missing and when no matrix row exists. Confirmed-ATH has been
"block always" since May 4 yet XLI entered live Jul 1 as Confirmed ATH
**and KO entered Jul 10 as Confirmed ATH**; Speculative-ATH
default-allowed all of July until the WM P0 on Jul 30 (XLI Jul 7, MTB
Jul 7, KO Jul 15, WM Jul 29 all rode through the hole). A kill-matrix that
leaks is not a kill-matrix. Every setup×grade needs an explicit row and a
**default-deny (or at minimum log-and-flag) posture for unknown cohorts on
the live lane**.

**P9 — Stops are risk-budget math, not levels (operator's "first place I
would start").** The SL fallback chain (worker/index.js ~25980) is
TradingView SL → adaptive ATR multiple → 1.5×ATR → flat 2.5%;
HARD_LOSS_CAP is a flat dollar cap ($250 default). Structural stop anchors
exist ONLY for liquidity-sweep and ORB entries. So a *support bounce*
entry (WAL) carries a stop that knows nothing about the support that
justified the entry:
- when that support breaks, nothing fires (the structure thesis is dead
  but the ATR stop is still alive), and
- the eventual exit is a % / $ cap that lands wherever the flush happens
  to be — WAL's fired at the downside peak with TD9 reversal loading.
The engine *already builds* a weighted structural levels list (V15
P0.7.54, worker/index.js ~50008: PDZ swings, daily pivots, prior session
range, 52w, EMAs) — but it is **display-only**; the trade engine never
consumes it for entry geometry or stops.
**Corollary (operator rule): risk-geometry veto at admission** — if the
distance from entry to the nearest *real* support ≈ the hard-loss-cap
distance, the entry should not be taken (unless closer support is forming
and we are riding momentum).

**P10 — Exit-side price integrity (audited: 4 of 30 July exits are
phantom).** Full-lane audit (exit price vs the ±45-min 10m tape range):

| Trade | Exit time | Booked exit | Actual tape | Booked P&L |
|---|---|---|---|---|
| KO #1 | Jul 13 **9:33 AM ET** | 81.40 (`sl_breached`) | 83.71–84.68 (2.75% below tape) | −2.39% fabricated |
| JCI | Jul 17 **9:34 AM ET** | 137.66 (`max_loss`) | 137.88–141.61 (0.16% below) | −3.40% (marginal) |
| KO #2 | Jul 17 **9:43 AM ET** | 81.40 (`sl_breached`) | 82.79–85.68 (1.68% below tape) | −1.93% fabricated* |
| XLRE | Jul 24 5:32 PM ET | 45.94 (`TP_FULL`) | 46.04 (thin AH tape) | +1.92% (minor) |

\* KO #2's 81.40 did eventually trade — **four hours later** during the
real afternoon selloff. The booked exit happened at 9:43 AM at a price
that had not printed.

Three signatures: (1) all material phantoms fired **in the opening
minutes** — the same quote-noise window driving the P2 chase entries; (2)
fills are booked **at the SL level itself** (81.39998104, 81.400009), not
at a market print; (3) both KO trades were killed by the same phantom
level twice. Entry AND exit fills must be verified against the real tape
(candle-range confirmation or double-quote) before a close commits, and
exits must record an actual market print. **The lane scoreboard is
polluted — every calibration loop reading July results is learning from
fabricated losses.**

**P11 — No expected-move screen at selection (GRNY).** Entry/trim/stop
within $0.25 over 7 days. Nothing in admission checks that the ticker's
ATR%/ADR% and personality can pay for the ST lane's risk, hold time, and
capital slot. Slow movers (GRNY, WAL-class banks, KO-class grinders per
their own personality tags — SLOW_GRINDER was *in the KO snapshot*) need
either a wider-horizon lane or a pass.

**P12 — Ledger semantics: liquidation "trims".** WAL's 50% trim 11 seconds
before its HARD_LOSS_CAP at the identical price is a liquidation artifact
recorded as a trim. Any analytics on trimmed_pct (including our own P4
finding) are contaminated by these rows. Trim rows must be
profit-banking events only.

**P13 — Fragile vs true support (operator's core theme).** The
support-bounce family keys off levels that "work intraday" but sit above
the real HTF liquidity level; price loses the fragile level, sweeps below
the 4H 233 EMA, then reverses (GRNY exit pattern, WAL's 77.89 sweep,
MU/MTZ in the LT doc). True support needs HTF anchoring (4H/D/W swings,
233 EMA confluence, volume-confirmed levels), two-tier structure (near
support / max-decline — Newton's format), and air-pocket awareness
("break of X has no support until Y"). Our own levels engine has most of
the raw inputs; it lacks tiering, volume confirmation, and any consumer.

**P14 — Leg-maturity blindness (CIBR).** Nothing measures where in the
move an entry sits. CIBR admitted 14 sessions and +11% into a leg, 2
sessions from its peak, with the 4H adverse phase div already flagging
maturity in our own snapshot. Newton's MTB deletion is the same concept
at HTF scale (RSI divergence + exhaustion after the runup = don't chase).
Admission needs a leg-age / distance-from-origin input: sessions since
the HTF reclaim that started the leg, % extension off the anchor EMA
(21/233), and exhaustion prep — chase entries demote or pass.

**P15 — Reclaim confirmations don't produce ST entries.** The highest
quality entry sequence the operator identified — HTF EMA reclaim (Jun 26)
→ trend-break confirmation (Jun 29, 4H ST break after the reclaim) — is
not something the ST lane trades. The LT lane already built the daily
EMA-21 test/reclaim signal (ANET); the ST lane's first entry of the
entire CIBR leg was Jul 10, the worst admit point in it. "We identify a
good move, catch a part, and miss the meat" — the model's entries are
timed by setup-trigger *coincidence*, not by the reclaim sequence that
defines where the move starts.

**P16 — No re-entry doctrine.** Post-exit there is a 5-minute cooldown
and passive hope that a fresh trigger fires. CIBR's Jul 31 Daily 5-12
reclaim after the 233-EMA test at 87–88 was a mapped, textbook re-entry —
+11% to 102 from exactly where we had exited two weeks earlier — and
nothing was watching. Same ask as KO ("be on guard and ready to
re-enter"). Needs a post-exit watch state (the movie pattern again): when
an exit happens but the HTF thesis stays intact, arm re-entry triggers at
the mapped levels (order block, 233 EMA, cloud reclaim) with the ticker's
prior-trade context attached.

**P17 — Liquidity zones are stop-plumbing, not context.** Swept-zone
data exists (4H/D, `swept` flags) but is consumed only for SL anchoring.
The operator's read: our entry price *became* SSL; the failure at the
Daily 5-12 cloud made that SSL the draw; and **after the sweep, the next
support bounce is a high-quality entry** (price has shown promise). That
post-sweep-bounce preference — and memory that our own prints create
liquidity — exists nowhere in admission.

**P18 — Duplicate daily bars (new data-integrity bug).** CIBR D candles
Jul 6–10 are stored twice under two midnight conventions (00:00 vs 04:00
UTC). Daily EMAs/RSI/SuperTrend/swing detection double-counted that week.
Scope unknown — needs a cross-ticker duplicate audit and a writer fix.
Every level and indicator inaccuracy the operator is pointing at (P13)
gets amplified by bugs like this.

---

## Cross-lane synthesis (vs the LT July doc)

The same three failure families appear independently in both lanes, which
makes them model-level:

1. **Rushing the first print** — LT doc: "Long-term horizon does not
   excuse rushing"; ST lane: 5 opening-window chases. One stabilization
   doctrine should govern all lanes.
2. **Entering under unbroken structure** — TWLO (LT: failed swing high →
   trim signal) and MTB (ST: never cleared prior swing high → caught in
   middle). The model has no "prove it" requirement: clear the reference
   swing / establish above cloud before admitting.
3. **Exiting drawdowns at the lows instead of the reclaim-or-fail test** —
   MU/MTZ/ANET (LT) and MTB (ST). The arm/fire movie pattern exists (ANET
   item 7) but is not generalized to the forced-exit family.

New in this batch (not seen in LT): **entry price integrity (P1)** and
**no profit banking on the ST lane (P4)**.

---

## Engine response (proposed — confirm before implementing)

1. **P1 first: entry integrity gate.** Before any TT-setup entry: fetch a
   fresh quote AND require the last N intraday bars to be non-degenerate
   (real OHLC, not o=h=l=c samples). Refuse with `entry_price_stale` /
   `candle_stream_degenerate` otherwise. Verify the 2026-07-01 fresh-price
   guard's deploy date, threshold, and coverage of the TT path.
2. **Opening stabilization for the ST lane.** No TT-setup entries before
   ~9:45 unless a reclaim-confirmed trigger; mirror
   `investorLtfEntryStabilizationBlock` semantics.
3. **Location + structure admit gates.** Veto (or demote grade of) LONG
   admits when PDZ is premium* on D/4H **and** an adverse divergence is
   active; require the reference swing high cleared (or 10m established
   above cloud) for breakout-family setups.
4. **ST first-target trim + entry-floor ratchet.** Bank a standard trim at
   first target; on trim, persist `post_trim_floor = entry` on the trade
   row; floor only ratchets up; remove the per-tick `pnlPct >= 0`
   dependence; revisit `deep_audit_breakeven_skip_trimmed_runner`.
5. **Generalize the sweep-reclaim exit movie.** Forced-exit reasons
   (`doctrine_force_exit`, dead-money family) that trigger below a swept
   low must arm-and-wait for the failed reclaim, not market-exit into the
   flush.
6. **Runner structure-break exit.** Multi-TF cloud/ST break after a trim
   exits the runner ahead of any dead-money clock (BRK-B).
7. **Per-cycle admission cap + correlation guard.**
8. **Matrix hygiene.** Explicit row for every setup×grade; default-deny
   unknown cohorts on live; alert when a blocked cohort somehow enters
   (enforcement tripwire, not just tuning).
9. **Level-anchored stops (P9/P13 — operator's stated starting point).**
   - Build the two-tier support model per ticker (near support /
     max-decline) from HTF structure: 4H/D/W swings, 233 EMA confluence,
     volume-at-level, air-pocket detection. Wire the *existing* levels
     engine (P0.7.54) into the trade engine — it is currently display-only.
   - Support-bounce entries: SL anchors just below the support that
     justified the entry; **support lost = thesis dead = exit**, ahead of
     any % / $ cap.
   - Risk-geometry veto at admission: entry-to-true-support distance ≥
     hard-loss-cap distance → skip (unless closer support forming +
     momentum).
   - Strategy audit: map every TT setup to the timeframe whose levels it
     must key off (which TF's support defines a "support bounce"; which
     swing defines an "ATH breakout" retest floor).
10. **Exit-fill integrity (P10).** Before committing an SL-breach close:
    confirm the breach against the live candle (low ≤ SL for longs) or a
    second independent quote; record the actual market print as the exit
    price, never the SL level itself. Backfill audit: rescan July exits
    for fills outside the bar's true range (KO Jul 13 found; are there
    others?) and correct the lane scoreboard before any calibration
    consumes it.
11. **Expected-move screen (P11).** Admission requires the ticker's
    ATR%/ADR% × typical hold to clear a minimum expected-move floor for
    the ST lane; SLOW_GRINDER / MIXED personalities route to the
    longer-horizon lane or pass.
12. **Trim semantics (P12).** A trim recorded within N seconds of a
    terminal exit at ≈ the same price is a liquidation tranche — record
    it as part of the exit, not a trim.
13. **Expert-level ingestion (Newton/Upticks).** Parse "Support- $X, $Y;
    Resistance- $A, $B" + thesis from ingested Upticks/Newton
    publications into per-ticker `expert_levels` with provenance. Use as
    (a) a validation benchmark for our levels engine (are our computed
    tiers near his?), (b) confluence weight at admission/exit, (c) a
    catalyst/context feed (his exhaustion calls on MTB flagged our exact
    July mistake in advance of our trade being graded).
14. **Catalyst context on holds (KO).** Attach known catalysts (event
    sponsorships/live events, earnings proximity, HTF EMA holds like the
    4H/D 233 test-and-hold) to the trade record at entry so hold/exit
    decisions can weigh "why this move exists" — the operator's
    "this should work and why" doctrine — instead of trading naked levels.
15. **Reclaim-sequence entry family for the ST lane (P15).** Promote the
    HTF-reclaim → LTF-confirmation sequence (daily EMA-21 reclaim, then
    4H ST break / 5-12 establish) to a first-class ST entry trigger with
    order-block/233 referenced stops — the entry the operator wanted on
    CIBR Jun 26/29. Reuse the LT lane's ANET reclaim machinery.
16. **Leg-age gate at admission (P14).** Compute sessions-since-reclaim +
    % extension off anchor EMA for the active leg; late-leg chases (like
    CIBR Jul 10 at 14 sessions / +11%) demote to pass unless a fresh
    consolidation/re-anchor has formed.
17. **Post-exit re-entry watch (P16).** On exit with HTF thesis intact,
    arm a per-ticker re-entry movie: watch mapped levels (order block,
    233 EMA, D 5-12 cloud reclaim); trigger re-entry on reclaim-confirm;
    expire on thesis break. Would have captured CIBR's +11% second leg
    and KO's post-phantom recovery.
18. **Post-sweep bounce preference + liquidity memory (P17).** Feed
    swept-zone events into admission: a support bounce *after* an SSL
    sweep upgrades quality (GRNY/CIBR observation); persist our own
    entry/exit prints as liquidity levels in ticker memory.
19. **Daily-bar dedupe + writer fix (P18).** Audit `ticker_candles`
    tf='D' for duplicate (ticker, date) rows across midnight conventions;
    dedupe; fix the writer to one canonical day key; re-verify daily
    indicators for the affected window.

## Consolidated verdict (batches 1–4, 15 graded trades)

Every graded trade reduces to five root causes:

| Root cause | Trades hit | Patterns |
|---|---|---|
| **Price/data integrity** (stale entries, phantom exits, degenerate candles, duplicate daily bars) | INTC, XLI×2, MTB, KO×2, JCI, CIBR-adjacent | P1, P10, P18 |
| **Location/timing-blind admission** (premium zone + adverse divs + leg maturity + opening window + matrix leaks) | PKG, XLI×2, MTB, WAL, GRNI, JCI, CIBR, UNP, KO | P2, P3, P8, P14 |
| **Stops/exits are math, not structure** (ATR/$ caps, clock exits, exits into support/flush) | WAL, MTB, UNP, BRK-B | P6, P9, P13 |
| **No banking / no floor / no re-entry** (MFE round-trips, post-trim giveback, missed second legs) | KO#2, JCI, DE, WM, PPG, BRK-B, CIBR, UNP | P4, P5, P16 |
| **Selection/horizon mismatch** (slow movers in the ST lane) | GRNY, GRNI, KO | P11 |

The lane's July record (8W/22L) overstates the model's badness (phantom
losses) AND understates its potential (CIBR/UNP/KO were correctly
identified moves whose meat was missed). Both distortions come from the
same place: the engine trades its signals without structure (levels,
legs, liquidity) and without verifying its own prices.

---

## Targeted July-2026 backtest (approved 2026-08-15 — execution plan)

**Goal:** replay July 2026 on the ST lane's traded universe with a
flag-gated "autopsy gate pack", baseline vs gates-on, and measure: blocked
bad admits, preserved good trades, post-trim floor effect.

**Gate pack (all default-OFF `deep_audit_ja_*` flags — live unaffected):**
1. `ja_opening_gate` — no TT-setup entries before 9:45 ET (P2).
2. `ja_location_gate` — block LONG when PDZ premium/premium_approach on
   BOTH D and 4H with any adverse divergence active; block `is_f4_severe`
   in CHOPPY/TRANSITIONAL regimes (P3).
3. `ja_expected_move_gate` — block when daily ATR% of price < floor
   (default 1.4%) (P11).
4. `ja_default_deny` — admission returning `missing_inputs_default_allow`
   / `no_matrix_entry` rejects instead of allowing (P8).
5. `ja_post_trim_floor` — after any trim, remainder exits at
   entry−0.15% floor, bypassing the trimmed-runner skip (P5).

(Level-anchored stops P9/P13, reclaim entries P15, re-entry watch P16 are
larger builds — deliberately NOT in this pack; they need the levels-engine
work first.)

**Mechanism (per tasks/lessons.md 2026-04-17 backtest lessons):**
- **Preprod only** (`--env=preprod`, own D1 `timed-trading-ledger-preprod`
  + own KV): replays poison `ticker_candles`/`/timed/all` if run on prod,
  and prod D1 already tripped the billing read threshold.
- **Direct loop, never the DO runner**: `scripts/monthly-slice.sh
  --month=2026-07 --api-base=<preprod>` (PID lock, single-writer guard on
  `timed:replay:lock`, watchdog, resume-from-checkpoint, clean-slate).
- **Pinned config**: flags set in preprod `model_config` per arm (preprod
  is isolated); never send `config_override` in replay bodies.
- **Data prep**: preprod candles end 2026-06-08 → backfill Jun 9–Aug 1
  for the targeted universe (~30 tickers × all TFs, ~100–150k rows,
  batched INSERTs; trivial reads from prod).
- **Cost control**: targeted universe only (the ~28 July-traded tickers +
  SPY/QQQ), 30m interval (the proven cadence), one month, two arms. No
  unbounded scans; all candle reads are PK-range queries.
- **Compare**: `backtest_run_trades` for run A (baseline) vs run B
  (gates-on): trades blocked (which graded losers disappear), trades kept
  (BRK-B/CIBR/PPG-class winners must survive), net PnL, MFE capture,
  post-trim giveback.

## Backtest execution log (2026-08-15)

- **Prep:** preprod deployed from this branch; live model_config synced
  (500-key cap warning noted); candles Jun 9 → Aug 1 backfilled for the
  28-ticker universe + SPY/QQQ/IWM/VIX + sector ETFs (221,801 rows,
  duplicate-D bars deduped on copy); `daily_market_snapshots` (44) +
  `market_events` (1,321) + 38/39 ticker_profiles copied (NEU profile row
  failed; runs on defaults).
- **Baseline (`ja-baseline-jul26`)**: 22 sessions, 30m cadence, clean
  finalize. **15 trades, 4W/11L, sum −1.95%.** Confirmed-ATH cohort
  entered 4× (GRNY, UNP, MTB, BRK-B) — the P8 leak reproduces in replay.
- **Gates-on v1 (`ja-gates-jul26`)**: INVALID — trades identical to
  baseline. Root cause: `REPLAY_DA_KEYS` allowlist filtered the new
  `ja_*` flags out of replay config. Fixed (allowlist + redeploy), run
  discarded.
- **Gates-on v2 (`ja-gates-jul26-v2`, all 5 gates)**: blocking every
  TT-setup entry through mid-month (0 trades vs baseline's 8 by Jul 13),
  including the baseline's winners.
- **FINDING (P8 root cause, behaviorally confirmed):**
  `deep_audit_setup_admission_enabled` is "true" and the matrix rows are
  correct — but always-blocked cohorts still enter because **`setup_grade`
  is empty at admission time** (graded later, before the D1 write).
  `admitSetup` returns `missing_inputs_default_allow` for essentially
  every TT-setup entry → **the admission matrix has been a no-op on this
  lane**. `ja_default_deny` therefore blocks *all* TT entries (correct
  per its spec, too blunt as a bundle) — the real fix is computing the
  grade *before* admission, then default-deny becomes a safety tripwire.
- **Gates-on v2 final: 0 trades in 22 sessions.** The full pack (incl.
  G4) suppresses the entire month — G4 alone is a lane-wide kill switch
  while the grade-timing hole exists.
- **Arm 3 (`ja-gates-nodeny-jul26`, G1+G2+G3+G5, default-deny off):**
  **11 trades, 5W/6L (45% WR vs baseline 27%), sum −5.35%.**

### Arm 3 vs baseline — trade-level

| Effect | Detail |
|---|---|
| Blocked (6) | JCI SB −0.54, AMZN ATH −0.83, GRNY SB −0.40, GRNY SB −0.58, BRK-B ATH −0.08 — **5 losses removed**; NEU SB +0.47 (a 9:30:00 open entry — G1 blocked it on principle) |
| Post-trim floor saves | EXEL −0.67 → **+0.23**; AMZN Jul 20 −0.02 → **+0.15** |
| Post-trim floor costs | UNP +1.64 → +0.14 (floor cut the dip that later recovered); AMZN Jul 9 +0.80 → +0.63 |
| Reshuffle hazard | Blocking JCI's 10:00 support bounce freed the slot for a **JCI Confirmed-ATH entry at 13:00 that lost −4.35%** — a cohort the admission matrix is supposed to kill on sight |

### Verdict

1. **The tactical gates work**: win rate 27% → 45%; 5 of 6 blocked trades
   were losses; the one blocked winner was an opening-chase the operator's
   own doctrine rejects.
2. **The headline PnL (−5.35 vs −1.95) is worse for exactly one reason**:
   the slot freed by a correct block was refilled by a blocked-cohort
   trade (JCI Confirmed-ATH, −4.35%) that only entered because of the
   grade-at-admission hole. Excluding that single leak, arm 3 = −1.00%
   vs baseline −1.95% with half the losers. **The admission-grade timing
   fix is the P0** — every other gate's benefit is capped until the
   matrix actually enforces.
3. **G4 sequencing**: default-deny is correct as a tripwire but must ship
   AFTER grade-before-admission, not alongside (it currently
   default-denies everything because everything is grade-less at
   admission).
4. **G5 nuance matches the operator's own MTB feedback**: a hard floor
   sometimes exits into a dip that recovers (UNP). Next iteration: floor
   arms at the flush and fires on failed reclaim (the sweep-reclaim movie)
   instead of market-exiting at the level.

## Offense slice results (2026-08-16 — "what gets us real improvement")

The defensive gate pack alone could only pull a losing month toward zero.
The offense slice attacks the actual gap: the entries the model never
takes. Implemented (all flag-gated, default OFF):

1. **`tt_htf_reclaim` entry family (P15)** — fresh daily EMA-21 reclaim
   (price within 2.5% of the level = leg-age freshness built in) + LTF
   confirmation; 4H agreement upgrades confidence. SL anchors just below
   the reclaimed level (P9's first structure-referenced stop).
2. **The gate gauntlet teardown** — the reason entries were always late.
   Probing CIBR's Jul 31 reclaim day found SIX stacked mature-trend-biased
   gates rejecting it on every bar: conviction floor (scored 42-70 vs 80 —
   the conviction model rewards mature trends and is documented
   non-discriminating), Tier-C suspension, Tier-C floor, transitional rank
   floor (reclaim-day rank 53-61), consensus minimum, and pullback-depth.
   Plus our own G2 location gate (PDZ math labels post-pullback reclaims
   "premium"). Each got a reclaim-context carve-out — in BOTH gate
   implementations (index.js `qualifiesForEnter` AND pipeline
   `tt-core-entry`; they are duplicated).
3. **Wildcard grade admission (P8 fix)** — `setup:DIR:*` rows apply each
   family's strictest policy when the grade is unknown at admission.
   Works as designed, but enforcing canon policy (ATH breakout only in
   STRONG_BULL + rr≥2) suppressed August's +64% ATH-driven month —
   **the canon calibration itself is regime-misaligned** (kept OFF in the
   tactical config pending recalibration).

### Results (preprod replays, 24 tickers scored, 30m cadence, same data both arms)

> **Universe correction (2026-08-16):** these runs passed 28 tickers with
> `--ticker-batch=24`, and the direct loop TRUNCATES rather than chunks —
> only the first 24 were ever scored (`scored = intervals x tickers`
> confirms it, and NVDA/DE/WM/CF never appear in any arm). Every arm used
> the same 24, so arm-vs-arm comparisons hold; the universe label does not.
> See [skills/backtest-replay.md](../skills/backtest-replay.md).

| Window | Baseline | Tactical (gates + reclaim + floor, no wildcard) |
|---|---|---|
| July 2026 | 15 trades, 4W/11L, **−1.95%** | 62 trades, 26W/36L, **+54.54%** |
| Aug 3–14 2026 | 11 trades, 8W/3L, **+64.23%** | 30 trades, 18W/12L, **+84.71%** |

- **CIBR HTF Reclaim Jul 30 → +32.1%** — the exact meat-of-the-move
  capture from the operator's feedback (the lane's real July trade on the
  same leg made +1.68%). A failed first reclaim attempt Jul 20 lost −1.60%
  — small, structure-stopped.
- HTF Reclaim July: 57 trades, +53.85% at 42% WR — the asymmetry the
  operator described: small stops at the reclaimed level, occasional
  large runners (SPHB +17.1, RPG +36.6, KO +8.7, XLRE +6.7, MTB +5.4 in
  August).
- POST_TRIM_ENTRY_FLOOR banked several marginal reclaims at small
  positives instead of round-trips.

### Honest caveats

- Big winners exit as `replay_end_close` (open at window end) — real but
  unrealized; both arms use identical management so the comparison holds.
- The reclaim family is untuned: 36 July losses include repeated attempts
  on the same tickers (XLI/WAL/TT/PKG) — needs a per-ticker failed-reclaim
  cooldown and possibly a market-regime filter.
- Replay fills are 30m-snapshot based; absolute magnitudes are replay
  artifacts. Arm-vs-arm deltas are the signal.
- Everything remains flag-gated OFF in production.

### Execution learnings (for the next replay session)

- `REPLAY_DA_KEYS` allowlist silently filters new config keys from replay.
- The conviction/tier gates exist TWICE (index.js `qualifiesForEnter` +
  pipeline); patches must land in both.
- Preprod candle depth matters: tickers outside the original clone had no
  daily history → `daily_structure` null → regimes/EMA logic blind. Deep
  backfill (2y D, W/M, 2026 4H) required before daily-structure features
  can replay.

## Tuning pass + go-live staging (2026-08-16)

### Backtested-trade evaluation (80 reclaim trades across Jul + Aug)

- **Loss anatomy**: 46 losses totaling −45.3 (avg −0.99) vs 34 wins
  totaling +153 — the asymmetry comes from structural stops at the
  reclaimed level. Management exits (`tt_cloud_pivot_5_12_close_exit`,
  `thesis_flip_htf`) correctly cut failed reclaims in 4–30h at small size.
- **Winner concentration on market turn days**: Jul 30 12:00 produced
  CIBR +32.1, JCI +18.5, BRK-B +11.1 simultaneously — SPY's own
  sweep-reverse day (Jul 29 −1.42% flush → Jul 30 +0.77% reclaim). Do NOT
  cap same-cycle reclaim admits.
- **Market-filter idea REJECTED by data**: SPY was *below* its daily
  EMA-21 on the biggest winner day (Jul 30) and *above* it during the
  Jul 1/Jul 14 loss clusters. Every SPY-posture filter tested on paper
  removes more winner than loser. Not shipped.
- **Failed-reclaim cooldown VALIDATED NEGATIVE at 72h**: July replay
  +54.5% → +20.5%. It removed the intended repeat losses (GRNY/GRNI/XLRE/
  EXEL, ~1%) but the slot-reshuffle cascade re-sequenced mid-July entries
  and a shifted JCI loss-exit then cooldown-blocked the Jul 30 +18.5%
  re-entry. August: +86.96% vs +84.71 (neutral-positive in trend).
  **Shipped as a knob, default 0 (disabled)**; revisit with a
  high-confidence override (allow re-entry inside cooldown when 4H is
  supportive).
- **Worst-loss driver identified**: entries at max extension (2.5% above
  the EMA-21) put the structural stop ~3.5% away (SPHB −4.4). The
  extension cap is already a config knob
  (`deep_audit_ja_htf_reclaim_max_ext_pct`); tightening to 2.0 is a
  candidate for the next validation cycle — not changed blind.

### Go-live configuration (staged in PROD model_config 2026-08-16)

The validated tactical set — exactly the config that produced
July +54.54% / Aug +84.71%:

| Flag | Value |
|---|---|
| `deep_audit_ja_opening_gate` | true |
| `deep_audit_ja_location_gate` | true (reclaim path exempt) |
| `deep_audit_ja_expected_move_gate` | true (ATR% ≥ 1.4) |
| `deep_audit_ja_post_trim_floor` | true (entry −0.15%) |
| `deep_audit_ja_htf_reclaim_entry` | true (+ conviction/tier/rank/consensus carve-outs) |
| `deep_audit_ja_grade_wildcard` | **false** (pending canon ATH recalibration) |
| `deep_audit_ja_default_deny` | **false** (pending grade-before-admission) |
| `deep_audit_ja_htf_reclaim_cooldown_hours` | 0 (validated negative at 72h) |

**The flags are INERT on the current live bundle** (its `REPLAY_DA_KEYS`
allowlist predates them) — they arm automatically when the new code
deploys. Go-live sequence:

1. Merge the PR → CI deploys monolith + tt-engine (+ feed/research) from
   `main` (`deploy-worker.yml` / `deploy-engine.yml`). Manual fallback:
   `cd worker && wrangler deploy && wrangler deploy --env production`,
   then `cd worker-engine && wrangler deploy`.
2. Verify: `/timed/health` ok on monolith + tt-engine; next */5 scoring
   cron clean; `wrangler tail` (or decision records) shows
   `ja_*` block reasons and/or `tt_htf_reclaim` evaluations.
3. Monday-open watch: [JA_RECLAIM_COOLDOWN] should NOT appear (disabled);
   opening gate must show blocks before 9:45 ET; first reclaim entries
   carry `setup_name = TT HTF Reclaim` with SL just below the daily
   EMA-21.
4. **Rollback = config-only**: set the five true flags to "false"
   (no deploy needed, next cron cycle picks it up).

## Tuning pass 2 — loss-pattern analysis (2026-08-16, operator-directed)

Full feature reconstruction for all 80 reclaim trades (Jul + Aug tactical
arms): ticker daily structure at entry, SPY posture, VIX (VX1! futures),
HMM input proxies, sequence, timing.

### What separates the 46 losses from the 34 wins

| Feature | Winners | Losers | Verdict |
|---|---|---|---|
| **Days above EMA-21 before entry** | median 3 | median 7 | **THE signal** — ≤3: 55% WR; >3: 34% WR. Entries hovering above e21 for weeks (MTB: 51 days) are drift, not reclaims |
| Distance above EMA-21 | 1.11% | 1.72% | mild (2.0 cap tested: overfit risk, kept 2.5) |
| Prior-day ticker return | +0.44% | −0.14% | real but cuts SPHB +17.1 (entered after −1.9% day); not shipped |
| SPY above its EMA-21 | 37% WR when true | **71% WR when false** | inverted! Reclaims work best on market turn days (Jul 30, Aug 3); any "SPY must be healthy" filter destroys the best trades |
| VIX (VX1!) level | 18.2 | 18.1 | non-discriminating (all trades in the 17–20 band) |
| VIX 5-day change | — | — | WR unchanged, but rising-VIX trades paid +6.7 total vs +115.1 for flat/falling → future SIZING modifier, not a filter |
| Sequence (nth attempt, prior result) | 2.83 | 2.64 | **no signal** — confirms the cooldown was the wrong tool |
| rr, completion, phase, hour, 4H prep | — | — | no separation |
| MAE | −0.37 | −1.43 | winners never go against entry — structural stops working |

**HMM**: only the latest state is persisted (`timed:regime:hmm:latest`,
BULL_TREND/CHOP/BEAR_TREND from SPY ret/ATR, VIX, breadth, dispersion).
Its input features were tested via proxies above — the SPY-posture
inversion means a naive "HMM says BULL" filter would cut the turn-day
winners. A proper historical decode (per-date states) is future work;
expectations low given the proxy results.

### Shipped: time-freshness (`days_above_e21 ≤ 5`)

`indicators.js` now computes consecutive prior daily closes above the
EMA-21 (`daily_structure.days_above_e21`); `isHtfReclaimContext` requires
≤ 5 (config `deep_audit_ja_htf_reclaim_max_days_above`). Simulated on the
80: kept 9/11 big winners, removed 2× more loss than win, PnL 121.8 →
127.2 with 12% fewer positions.

### Validation replays (same mechanism as before)

| Window | Baseline | Tactical v1 (live) | v1 + freshness |
|---|---|---|---|
| July | −1.95 | +54.54 (62t, 42% WR) | +44.27 (47t, 45% WR) |
| Aug 3–14 | +64.23 | +84.71 (30t, 60% WR) | **+77.58 (21t, 71% WR)** |

Freshness trades −17 total PnL in this path for +10-11 pts WR, ~30% fewer
positions, and per-trade expectancy 1.51 → 1.79. The July gap is one
cascade casualty (JCI Jul 30 +18.5 — days-above 0, NOT blocked by the
rule; the reshuffled sequence took a different JCI trade Jul 22 and the
Jul 30 re-entry never re-triggered — same replay path-dependence seen in
every arm pair). Direct rule measurement: removed 19 losses (−17.2) vs
10 wins (+24.5, of which +18.5 was the cascade, not the rule).

**Decision: ship freshness at default 5** — definitionally correct
(a "reclaim" 51 days above the level is not a reclaim), higher expectancy
and WR, relaxable via config.

### Go-live status

Tactical v1 went LIVE 2026-08-16 ~05:45 UTC (merge → CI deployed monolith
+ tt-engine; pre-staged flags armed). Freshness (this pass) rides the next
merge.

## Experiments: cadence + limits (2026-08-16, operator-directed)

### 1. 10m vs 30m replay cadence (freshness build, normal limits)

| Window | 30m | 10m |
|---|---|---|
| July | 47t, 45% WR, +44.27% | **51t, 57% WR, +56.34%** |
| Aug 3–14 | 21t, 71% WR, +77.58% | **24t, 75% WR, +80.08%** |
| Total | +121.9 | **+136.4** |

10m wins both windows on both WR and PnL — finer entry resolution catches
reclaim triggers earlier (BRK-B +14.4 vs +11.3, new NEU +8.0 winner) and
the historical "10m hurts" lesson (P0.7.17: exits tripping intra-bar
wicks) no longer applies because the 30m management-cadence gate holds
exits to 30m boundaries regardless of scoring cadence.

**Interpretation — no live change needed**: the LIVE engine already scores
every 5 minutes (*/5 cron on tt-engine), so live entry detection is
ALREADY finer than the 30m replays. The experiment's real conclusions:
(a) live should behave at least as well as the 10m replays, which are the
better predictor; (b) **adopt 10m as the standard validation cadence**
(3× replay cost, materially closer to live behavior).

### 2. No slot / sector / direction limits (30m, freshness build)

Bypassed smart gates 0–3 (position cap 35, proportional sector cap,
same-direction 25, correlation quality gate) + disabled the cluster
throttle. Result: **a wash** — July 47t +44.50% (vs +44.27% with limits),
August byte-identical (21t +77.58%). At the 24-ticker scored universe the caps
never bind; they are not the constraint. Caveat for later: on the full
~200-ticker live universe, sector caps and the cluster throttle are more
likely to bind exactly on turn days (Jul 30 / Aug 3 pattern where winners
cluster) — retest with a full-universe replay before trusting them there.
The bypass flag (`deep_audit_ja_no_slot_sector_limits`, default OFF) stays
as experiment infrastructure.

### 3. Universe scaling — the biggest live/replay deviation

Measured directly from live daily candles (314 tickers with daily history,
312 of them with 30+ bars, so the freshness rule computes for effectively
the whole universe — it will not silently no-op in production).

Reclaim-context candidates per session (`0 ≤ pct_above_e21 ≤ 2.5` and
`days_above_e21 ≤ 5`, i.e. the `isHtfReclaimContext` pre-filter):

| Window | Replay universe (24 scored) | Full live universe | Ratio |
|---|---|---|---|
| July 2026 | 5.0/day (17.9%) | 39.7/day (12.8%) | **7.9x** |
| Aug 3–14 | 6.5/day (23.2%) | 46.4/day (14.9%) | **7.1x** |

The validated arms took 2.1 entries/day on average and never more than 5
reclaim entries in a single session. Live will see ~8x the candidate
supply against the same 35-position cap.

This is not a sizing detail, it is a selection problem: the reclaim family
deliberately bypasses the conviction, Tier-C, rank and consensus gates
(they are mature-trend biased and structurally reject fresh reclaims), so
**nothing ranks these candidates**. At 5 candidates/day that was harmless.
At 40/day the open slots go to whichever ticker the scoring cycle reaches
first, not to the best setup — a behaviour no replay has exercised.

**Shipped guardrail**: `deep_audit_ja_reclaim_daily_max` (default 5, the
max any validated session produced; 0 disables) caps new reclaim entries
per NY trading day, keeping live inside the envelope that was actually
measured. Ranking the candidates properly is the follow-up; the budget is
the stopgap that makes the first live week interpretable.

## CORRECTION: every headline PnL above was wrong (2026-08-16)

While building a dollar-denominated results table, the `pnl` column stopped
reconciling with `notional`. Root cause in
`closeReplayPositionsAtDate` (`worker/replay-admin-helpers.js`): the
end-of-window mark recomputed share count from the legacy `TRADE_SIZE`
($1,000) constant, while the realized trim carry on the same row was booked
on the REAL position. Two different scales in one number:

- `pnl` (dollars) came out ~`notional/1000` too small (~10x low).
- `pnl_pct` was **inflated** for any trimmed position open at the window
  edge, because a real-dollar carry was divided by a $1,000 base.

Blast radius: `replay_end_close` rows only — 55 of 385 ja-* rows, but they
carried 658 of the ~700 points of reported "sum PnL %". Every other exit
reason reconciles exactly (`pnl = pnl_pct * notional / 100`). Closed trades
were always right; the open marks were not.

**Concretely: CIBR Jul 30, reported "+32.14% / $321", actually made
+3.99% / $477 on its $11,955 position** (entry 89.29, half banked ~5%
higher, remainder marked 91.83). The move was real; the 32% was not.

Fixed + regression-tested (`worker/replay-close-sizing.test.js`). Existing
rows are NOT rewritten — they are restated below by reconstructing the true
figure from `shares`/`notional`.

### Restated results — true dollars on the $100k replay book

`PORTFOLIO_START_CASH = 100000`, so dollars are directly portfolio return.
"Realized" = trades that actually closed; "open mark" = still open at the
window edge, marked at last close (unrealized, path-dependent).

| Window | Arm | Trades | WR | **Total $** | Realized $ | Open-mark $ |
|---|---|---|---|---|---|---|
| July | baseline (30m) | 15 | 33% | **−323** | −324 | +2 |
| July | gates only, no-deny (30m) | 11 | 45% | **−715** | −715 | 0 |
| July | tactical v1 = LIVE (30m) | 62 | 42% | **+597** | −377 | +974 |
| July | v1 + freshness (30m) | 47 | 45% | **+1,441** | +754 | +687 |
| July | v1 + freshness (10m) | 51 | 57% | **+2,088** | +1,345 | +743 |
| July | + 72h cooldown (30m) | 59 | 41% | **−1,183** | −1,852 | +669 |
| July | no slot/sector limits (30m) | 47 | 47% | **+1,427** | +740 | +687 |
| Aug 3–14 | baseline (30m) | 11 | 73% | **+2,428** | +1,642 | +786 |
| Aug 3–14 | tactical v1 = LIVE (30m) | 30 | 60% | **+1,717** | +514 | +1,202 |
| Aug 3–14 | v1 + freshness (30m) | 21 | 71% | **+1,787** | +737 | +1,049 |
| Aug 3–14 | v1 + freshness (10m) | 24 | 75% | **+2,359** | +1,370 | +989 |
| Aug 3–14 | + 72h cooldown (30m) | 29 | 62% | **+1,738** | +504 | +1,234 |

### What the correction changes about our conclusions

1. **Magnitudes collapse.** "July +54.54% / August +84.71%" is really
   +0.6% / +1.7% of the book. The direction of every arm-vs-arm comparison
   survives; the size does not. Sum-of-per-trade-percent was never a
   portfolio return and should not be quoted again.
2. **August baseline BEATS tactical v1** (+2,428 vs +1,717). The earlier
   read ("tactical improved August +64 → +85") was purely the artifact:
   tactical held 10 open positions at the window edge vs baseline's 4, and
   open marks were the inflated ones. In a strong-tape sample the extra
   reclaim entries diluted a concentrated ATH-driven month.
3. **Freshness is now unambiguously good** — better in BOTH windows on
   total dollars (Jul +1,441 vs +597; Aug +1,787 vs +1,717) and much
   better on realized dollars (Jul +754 vs −377). See the August question
   below.
4. **Tactical v1 alone (what is live right now) is thin**: +597 July,
   −711 vs baseline in August → net ~+209 across six weeks. Most of its
   apparent edge was open marks. Freshness is what makes the pack pay.
5. **The 72h cooldown is confirmed bad** (−1,183 July, realized −1,852).
   Staying at default 0.
6. **Realized vs unrealized is the honest lens.** Even in the best arm,
   a third to a half of the total sits in open marks the live engine will
   actually have to manage. Judge future arms on realized dollars first.

### The August "84.71 → 77.58" question, answered

That pair was sum-of-percent, not win rate (WR went 60% → 71%). On
corrected dollars August freshness is **+1,787 vs +1,717 — better, not
worse.** Direct measurement of the 10 trades freshness removed:

| Removed trade | True $ |
|---|---|
| KO Aug 7 (open mark) | +128 |
| MTB Aug 11 (open mark) | +99 |
| MTB Aug 6, UNP Aug 13 | +25, +19 |
| JCI, XLI, TT, PKG, BRK-B, KO Aug 3 | −8, −32, −33, −41, −86, −126 |
| **Net** | **−55** |

The rule removed a net *loser*. The two "big winners" it appeared to cost
us (reported +$1,051 and +$650) are +$128 and +$99 once sized correctly —
and MTB had been above its EMA-21 for 51 days, i.e. not a reclaim by our
own definition. **No meaningful difference; the change is an improvement.**
## 5m cadence ladder + cadence-matched baseline (2026-08-16)

Two questions the earlier experiments could not answer: does replaying at
the live 5m cadence change the picture, and is the new pack actually
better than what is live today when both run at the SAME cadence (every
prior baseline was 30m while the tactical arms were compared at 10m).

**Setup.** 5m at 24 tickers/request trips the Workers CPU ceiling
(HTTP 503 `error code: 1102`) on busy days and retries do not clear it, so
this ladder runs at `--ticker-batch=10` — the first 10 names
(PKG, BRK-B, XLI, INTC, MTB, WAL, GRNY, KO, CIBR, GRNI). Every arm below
uses that identical 10-ticker slice, so they are directly comparable to
each other but not to the 24-ticker arms above.

### Does 5m beat 10m? No — they are the same

| Window | 10m | 5m | Delta |
|---|---|---|---|
| July | 18t, 56% WR, **$1,648** | 18t, 56% WR, **$1,679** | +$31 |
| Aug 3–14 | 9t, 67% WR, **$705** | 9t, 67% WR, **$716** | +$11 |

Identical trade counts and win rates in both windows; the ~2% dollar edge
is marginally better fill timing on the same trades. So the cadence effect
is real but it saturates: **30m → 10m matters, 10m → 5m does not.**

Practical consequence: **10m stays the standard validation cadence.** It is
CPU-safe at batch 24, ~3x faster in wall clock, and faithfully represents
live's 5m scoring. No reason to pay for 5m replays again.

### Is the pack better than live? Yes in July, a wash in August

Baseline = every `ja_*` flag off, i.e. the model as it behaved before this
work. Same 10 tickers, same 5m cadence, same tape.

| Window | Baseline | Tactical + freshness | Delta |
|---|---|---|---|
| July | 9t, 22% WR, **−$1,000** | 18t, 56% WR, **+$1,679** | **+$2,679** |
| Aug 3–14 | 9t, 78% WR, **+$905** | 9t, 67% WR, **+$716** | −$189 |
| **Total** | **−$95** | **+$2,395** | **+$2,490** |

Realized-only (open marks excluded): July −$84 → +$937; August +$835 →
+$820. Net realized **+$1,006**, so the result does not depend on how the
window boundary happens to mark open positions.

Read: the pack earns its keep in chop and on turn days, which is exactly
where the old model bled (July baseline: 22% WR, −$1,000). In a strong
trending tape (August) the baseline's concentrated ATH trades are already
good and the extra reclaim entries neither help nor hurt much. That is the
right shape for a defensive+selective change — it raises the floor rather
than the ceiling.

## Go-live plan for Monday (2026-08-17) — minimal deviation

### Where we actually stand

Tactical v1 is LIVE (merged + deployed 2026-08-16 ~05:45 UTC). Restated on
true sizing it is **thin**: +$597 July, and −$711 vs baseline in August —
net ~+$209 across six weeks, most of it unrealized marks. **Freshness is
the change that makes the pack pay** (July +$1,441 at 24 tickers; and in
the cadence-matched 5m test, +$2,679 vs baseline in July). It is NOT yet
on `main`.

### Ship (in this order)

1. **PR #1256 — freshness + reclaim daily budget.** The freshness rule is
   the validated edge; the budget is the guardrail that keeps live inside
   the envelope we measured (see universe scaling: ~8x more candidates
   live than in replay). Merging both together is the point — freshness
   without the budget ships an unranked family into an 8x-larger pool.
2. **PR #1257 — replay PnL sizing fix.** Zero live-path impact, but every
   future model decision reads these numbers.

### Keep OFF (unchanged)

| Flag | Value | Why |
|---|---|---|
| `deep_audit_ja_grade_wildcard` | false | enforcing canon ATH policy suppressed August's ATH-driven month; the canon calibration is regime-misaligned |
| `deep_audit_ja_default_deny` | false | still a lane-wide kill switch until grade-before-admission lands |
| `deep_audit_ja_htf_reclaim_cooldown_hours` | 0 | validated negative (July −$1,183) |
| `deep_audit_ja_no_slot_sector_limits` | false | experiment infrastructure only; the caps are the safety rail that matters most at live universe size |

### Known live-vs-replay deviations, ranked

1. **Universe 8x** (~40-46 reclaim candidates/day live vs ~5 in replay).
   Mitigated by `deep_audit_ja_reclaim_daily_max=5`. **This is the one to
   watch on Monday.** If the budget binds every day, the family is
   demand-constrained and needs real ranking, not a bigger budget.
2. **Fills.** Replay fills at candle snapshots; live crosses real spreads,
   and the July audit found 4 of 30 exits outside the true tape (P10).
   Expect live to underperform replay on identical decisions.
3. **Open marks.** 40-60% of replay P&L sat in positions still open at the
   window edge. Live has to actually manage those exits; the exit engine
   is unchanged and is not what this work validated.
4. **Cadence.** Live 5m vs validation 10m — measured as immaterial above.
5. **Slot/sector caps.** Non-binding in replay, will bind live. Untested
   interaction; the budget reduces the pressure.

### Monday watch list

- `[JA_RECLAIM_BUDGET]` — how often it fires. Never = fine; every day =
  the family is over-supplied and selection is unranked.
- `[JA_RECLAIM_COOLDOWN]` — must NOT appear (disabled).
- Opening gate blocking entries before 09:45 ET.
- First reclaim entries carry `setup_name = TT HTF Reclaim` with SL just
  below the daily EMA-21, and `days_above_e21 <= 5` on the entry snapshot.
- Realized P&L per closed trade vs the replay's realized figures — the
  open-mark component is where replay flatters itself.

### Rollback

Config-only, no deploy: set `deep_audit_ja_htf_reclaim_entry` to `false`
(kills the new entry family, keeps the defensive gates), or set all five
tactical flags false to return to baseline. Next cron cycle picks it up.
Tighten rather than kill: `deep_audit_ja_reclaim_daily_max=1..2`, or
`deep_audit_ja_htf_reclaim_max_days_above=3` (the 55% WR cut).

## Verification items (before coding)

- [ ] Why did XLI Jul 1 (Confirmed ATH) enter despite `block_when: always`?
      (grade empty at admission time vs lane bypassing `tt-core-entry`)
- [ ] Deploy date + threshold of the live entry fresh-price guard vs the
      Jul 1 INTC trade; does it cover the TT setup path?
- [ ] Whether BREAKEVEN_STOP for BRK-B was skipped by the trimmed-runner
      flag, the protection-stage gate, or the 30m management cadence gate
      (check worker logs / replay).
- [ ] Operator to continue grading remaining July ST trades — especially
      the 15:00+ entry cluster and the JCI/DE/WM round-trips.
- [ ] (Batch 2) How did the KO/JCI phantom opening-minute quotes get
      through — same feed path as the INTC stale entry? One integrity fix
      may cover both sides.
- [x] (Batch 2) Phantom-exit audit DONE: 4 of 30 exits outside the true
      tape range (see P10 table). KO ×2 + JCI fabricated in the opening
      minutes; both KO fills booked at the SL level itself. Remaining
      follow-up: correct the lane scoreboard / flag these rows before any
      calibration consumes them, and run the same audit on
      `live-long-term-2026-07` + August-to-date.
- [ ] (Batch 2) Compare our levels-engine output for GOOGL/BA/VLO/CVX
      against Newton's August tiers as the first accuracy benchmark.
- [ ] (Batch 3) Decision-trace check: why did `tt_pullback_reclaim` (or
      any trigger) not fire on CIBR Jun 26–30 after the daily EMA-21
      reclaim + 4H ST break? Universe/scan coverage vs trigger conditions.
- [ ] (Batch 3) Cross-ticker duplicate daily-bar audit (P18): how many
      tickers/dates have double D rows? Which indicators consumed them
      during July?
