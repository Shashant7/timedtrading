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
