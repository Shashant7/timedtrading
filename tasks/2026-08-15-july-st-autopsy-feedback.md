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
"block always" since May 4 yet XLI entered live Jul 1 as Confirmed ATH;
Speculative-ATH default-allowed all of July until the WM P0 on Jul 30. A
kill-matrix that leaks is not a kill-matrix. Every setup×grade needs an
explicit row and a **default-deny (or at minimum log-and-flag) posture for
unknown cohorts on the live lane**.

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

## Verification items (before coding)

- [ ] Why did XLI Jul 1 (Confirmed ATH) enter despite `block_when: always`?
      (grade empty at admission time vs lane bypassing `tt-core-entry`)
- [ ] Deploy date + threshold of the live entry fresh-price guard vs the
      Jul 1 INTC trade; does it cover the TT setup path?
- [ ] Whether BREAKEVEN_STOP for BRK-B was skipped by the trimmed-runner
      flag, the protection-stage gate, or the 30m management cadence gate
      (check worker logs / replay).
- [ ] Operator to continue grading remaining July ST trades (27 more) —
      especially the 15:00+ entry cluster and the KO/JCI/DE/WM round-trips.
