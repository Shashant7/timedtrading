# Recent book review (13–19 Aug 2026)

Operator ask: last few days of activity and trades (lots of losers,
partly a downturn); look at Trade Review; how close are index options
day-trades and movie framing to validation / promotion.

Data: production D1 (`trades`, `trade_reviews`, `signal_outcomes`,
`option_marks`, `investor_lots`, `ai_cio_decisions`, `ticker_latest`)
plus `/timed/admin/options-scorecard`, `/timed/admin/context/shadow-report`,
`/timed/options/all`, `/timed/prices`. Pulled 19 Aug ~22:30 UTC.

---

## 1. Market backdrop — yes, a downturn, but that is not the whole story

SPY peaked ~778 on 12 Aug, printed 767.45 on 17 Aug (−1.3% from the
local high), and closed 19 Aug at **769.06** (+0.21% on the day).
QQQ did the damage: **732 → 716** (−2.2% from 12 Aug; 17 Aug alone
was −1.69%). IWM: 305 → 302. Internals on the 19 Aug payload:
`sector_rotation=risk_off`, defense leading offense by ~1.6%, VIX 17.8
(not a panic). Universe HMM on HII / LLY / SPY is **CHOP posterior
0.993**.

So: a Nasdaq-led pullback inside a high-confidence CHOP regime, not a
crash. A book that is net-long Speculative ATH breakouts and support
bounces will bleed here. The market explains the *direction* of the
P&L. It does not explain why those names were admitted.

---

## 2. Short-term book — the bleed is real and concentrated

Live trades only (`run_id` empty).

### Closed 13–19 Aug

| | |
|---|---|
| n | 25 |
| W / L / F | 4 / 19 / 2 |
| Win rate | **17%** |
| Realized P&L | **−$817** |
| Speculative share | 20 / 25 (−$598) |
| Prior week (7–12 Aug) | 12 closes, 42% WR, −$23 |

By exit date (NY):

| Day | n | W/L | P&L | Names |
|---|---|---|---|---|
| 13 Aug | 3 | 1/1 | +$37 | PH leftover winner +$41, XHB scratch |
| 14 Aug | 4 | 1/2 | −$21 | SN −27, PH −12, RTX +17 |
| 17 Aug | 5 | 1/4 | −$84 | XYZ −83, XLRE −33, HII −31, SPOT −18, **USO +80** |
| 18 Aug | 6 | 0/6 | **−$296** | SNOW −87, TT −76, JCI −47, EMR −33, IYT −29, XYZ −22 |
| 19 Aug | 7 | 1/6 | **−$453** | PH −128, CPER −124, WAL −121, HII −80, RTX +23, GEV −12, SN −11 |

By setup (13–19 closes):

| Setup | n | W | P&L |
|---|---|---|---|
| TT ATH Breakout | 12 | 3 | **−$465** |
| TT Support Bounce | 9 | 1 | −$108 |
| TT HTF Reclaim | 3 | 0 | −$123 |
| TT Range Reversal | 1 | 0 | −$121 |

Exit reasons: 9 `max_loss`, 5 `sl_breached`, 4 cloud-pivot, 2
`mfe_ratchet_giveback`, plus `doctrine_force_exit` (HII),
`STALL_FORCE_CLOSE` (CPER), `POST_TRIM_ENTRY_FLOOR` (WAL),
`thesis_flip_htf` (IYT). One `TP_FULL` (USO).

The three largest losers (PH, CPER, WAL) are all multi-day Speculative
holds that never ran (MFE 0.6–2.0%) and were taken out at the book
stop. That is CHOP + ATH/support coincidence — the same class the
17 Aug movie reframe already named.

### Open now (8)

Mark-to-market **+$681**. LLY +$202 / +5.0% (HTF reclaim, 17 Aug) is
the only real runner. UNP +$147, J +$131, CSX +$98, FLR +$46, AXON
+$29, XLB +$24, TSM +$4. All longs. The open book is covering a
chunk of the closed bleed *if it holds*. CSX already saw MAE −5.9%.

### The engine already tripped

Loop 2 circuit breaker on the 19 Aug HII payload:

```
_loop2Pause.paused = true
reason            = wr_10
last10_wr         = 0.10 (n=10)
today_pnl_pct     = −9.83 (n=7)
profit_factor     = 0.04
expectancy_pct    = −1.28
tripped           ~11:00 ET 19 Aug
```

Setup demotions are also written: ATH Breakout, Support Bounce, and
Range Reversal (Long) are `blocked` on the enforce list. Those
demotions did **not** stop the 13–18 Aug entries (they fired before
or around the trip). New entries should now be scarce. Do not
override the pause to "get back in."

---

## 3. Why these names got in

CIO last 10d (live, not shadow): 74 ADJUST, 19 REJECT, 10 APPROVE.
Almost every loser in this window was an **ADJUST** (size haircut,
not a hard no):

| Ticker | CIO | Conf | Outcome |
|---|---|---|---|
| PH 17 Aug | ADJUST | 0.79 | LOSS −2.50% |
| HII 17 + 18 Aug | ADJUST | 0.80 / 0.77 | LOSS −2.11 / −2.98 |
| SPOT 17 Aug | ADJUST | 0.82 | LOSS −2.11 |
| XYZ 17 + 18 Aug | ADJUST | 0.86 / 0.79 | LOSS −1.23 / −0.25 |
| SNOW 14 Aug | ADJUST | 0.79 | LOSS −2.09 |
| WAL 13 Aug | ADJUST | 0.78 | LOSS −1.87 |
| CPER 13 Aug | ADJUST | 0.77 | LOSS −1.60 |
| GEV 18 Aug | ADJUST | 0.83 | LOSS −0.94 |
| IYT 18 Aug | ADJUST | 0.83 | LOSS −0.63 |
| RTX 13 + 14 Aug | ADJUST | 0.73 / 0.81 | WIN +0.45 / +0.59 |
| USO 14 Aug | ADJUST | 0.76 | WIN +2.17 |
| LLY 17 Aug | ADJUST | 0.77 | still open +5% |

REJECTs that *did* fire were the right ones: GE / GS on adverse
phase (the 17 Aug movie note called this), SPHB / XLK / GRNY / GRNI
on 30m phase or CHOP+WAIT. The CIO's hard-red-flag path works.
The miss is **ADJUST on Speculative + high-CHOP + ATH/support**.
Markov continuation + "on-thesis July playbook" (Industrials /
defense / Financials overweight) kept talking the desk into
reduced-size longs in a CHOP tape. Reduced size still lost
$80–$128 per name because notional was still a few thousand.

---

## 4. Trade Review — the new TRADE cards are usable; decide them

Closed-only mode is live. 13 `{trade}::TRADE::0` rows from 18–19 Aug
closes, all `status=reviewed`, **none operator-decided**. Older
per-leg rows (ENTRY/TRIM/EXIT) are still in the archive: 33 approved,
17 rejected, 2 deferred.

Per-leg bias that the operator already corrected is still visible on
the old cards: `PREMATURE_EXIT` on max-loss / never-ran names (HII
17 Aug EXIT was approved as premature — that is the XYZ class, and
it is wrong). The new TRADE prompt is better.

Recommended decisions on the 13 TRADE cards (do not rubber-stamp
PREMATURE on a stop that never had a runner):

| Ticker | Agent | Capture | Recommendation |
|---|---|---|---|
| **HII** 18→19 | D BAD_ENTRY | MFE 0.79 / MAE −3.29 / realized −2.98 | **Approve.** Speculative support in CHOP. Never ran. Doctrine force-exit was bookkeeping. |
| **GEV** 18→19 | D BAD_ENTRY | MFE 1.58 / MAE −2.49 / −2.40 | **Approve.** Weak support bounce, bearish LTF, max-loss. |
| **IYT** 18 | D BAD_ENTRY | MFE 0.31 / MAE −0.65 / −0.63 | **Approve.** Same-day CHOP support bounce; thesis-flip was the right out. |
| **EMR** 14→18 | D CORRECT_LOSS | MFE 1.10 / MAE −2.36 / −2.12 | **Approve.** Max-loss on a dead ATH. |
| **RTX** 14→19 | B LEFT_MONEY | MFE 1.94 / realized +0.31 (16% of MFE) | **Approve.** USO-class: location ok, ratchet cut a runner. Only clean LEFT_MONEY in this batch. |
| **PH** 17→19 | C MIXED | MFE 1.04 / MAE −2.60 / −2.50 | **Approve MIXED.** Speculative ATH in CHOP; max-loss was correct. Not premature. |
| **CPER** 13→19 | C MIXED | MFE 0.40 / MAE −2.47 / −1.60 | **Approve MIXED** (or modify → CORRECT_LOSS). Stall close on a never-ran ATH. |
| **WAL** 13→19 | C MIXED | MFE 0.85 / MAE −2.32 / −1.98 | **Approve MIXED.** Range reversal in a down tape; post-trim floor was correct. |
| **SN** 17→19 | C MIXED | MFE 1.91 / MAE −1.88 / −0.65 | **Approve MIXED.** Had a 2% push, ratchet gave it back. Not a location miss. |
| **XYZ** 18 | C MIXED | MFE 1.18 / realized −0.25 | **Approve MIXED.** Cloud-pivot scratch. Do **not** call this premature (the 17 Aug XYZ EXIT reject already made that point). |
| **SNOW** 14→18 | C MIXED | MFE 1.39 / MAE −2.28 / −2.09; post-exit +1.09 | **Approve MIXED.** Max-loss was correct; leftover is noise, not a runner. |
| **JCI** 13→18 | C MIXED | MFE 2.15 then max-loss −2.11 | **Approve MIXED.** Gave back a real MFE; location was speculative ATH. |
| **TT** 13→18 | NA INSUFFICIENT_DATA | no tape | Leave. Thin preprod-style coverage. Do not invent a grade. |

Operator queue is now **13 cards**, not 76. That is the process
working. Decide this batch; do not drain the deferred ENTRY/TRIM
rows.

Pattern the reviews agree on, and it matches the tape:

1. **Speculative ∧ CHOP ∧ ATH/support = BAD_ENTRY.** HII, GEV, IYT.
2. **Max-loss / stall on a never-ran is CORRECT_LOSS or MIXED, not
   premature.** EMR, CPER, PH, XYZ.
3. **LEFT_MONEY is rare this week.** RTX is the one. USO (already
   approved as LEFT_MONEY on the per-leg cards) is the other.

---

## 5. Investor lane — same stop-forensics class, quieter this week

Lots 10–19 Aug: 12 SELL / 9 BUY / 4 DCA.

`PRIMARY_INVALIDATION_BREACH` still the damage path: TWLO, AMAT,
IESC (14 Aug), CRS, EXEL (11 Aug). META 10 Aug was
`FAILED_ENTRY_RECLAIM` (the movie that *is* working). KO
`MFE_EXTENSION_TRIM` 18 Aug and TJX / FN pre-earnings cuts are
management, not liquidation.

New accumulates: ANET, FN, PWR (14 Aug), PNC, GS (17 Aug), LLY
(18 Aug). NVDA still DCA-ing pullbacks. 12 OPEN / 9 CLOSED in the
recent window. Shallow-breach hold + session-close flags are on
(`deep_audit_investor_shallow_breach_score_hold`,
`deep_audit_investor_require_session_close`). Give them more
closes before judging; do not promote anything else on this lane
while those two are still warming up.

---

## 6. Index options day-trade — not ready to promote

Honest status against the 18 Aug readiness ladder:

| Stage | Flag | Live? | Evidence |
|---|---|---|---|
| 1 Instrumentation | `options_marks_enabled` | **OFF** | `option_marks` row count = **0**. Scorecard `n=0`. Zero `options_day_trade` rows in `signal_outcomes`. |
| 2 Strike/DTE ladder | `options_ladder_tiers` | **OFF** | Today's QQQ card has `tiers: null`. Single ATM 1DTE estimate. |
| 3 Honesty gate | `options_gate_honesty` | OFF (behavior is partial) | SPY / IWM / DIA suppressed today for `day_lean_low_conviction` — the *old* suppress path, not the WAIT-opposing downgrade. |
| 4 Management card | `options_management_card` | OFF | No `option_management` on the live play. |
| 5 Paper auto-mirror | `options_auto_mirror_indices` | OFF | Correct. |
| 6 Index swing | `options_index_swing_enabled` | OFF | Correct. |
| 7 Brief surface | `options_brief_surface` | OFF | Cards are on Today; no 30d record in the brief. |

What *is* live tonight (`/timed/options/all`, cache ~22:20 UTC):

- **QQQ day_trade_call** 722C 1DTE, lean LONG medium, confluence
  DRIFT 26/100, premium **$1.55 estimate_bs_atr_iv** (not chain).
- SPY / IWM / DIA suppressed (NEUTRAL / low / WAIT). That is the
  right call on a CHOP / risk-off day.
- Universe options play is a STX bull-call spread (not an index
  day-trade).

What the existing ledger *does* measure: `options_play` shadow
rows attached to **share entries**, graded on the **underlying**.
Last 7d those shadows are a graveyard of the same ST losers
(PH / XHB / XYZ / EMR / HII / WAL / JCI / TT = F / stop_hit).
LLY / SPOT / UNP graded A because the *stock* moved. That is not
a contract scorecard and must not be used to promote index
day-trades.

The SPY 772P the operator liked is still N=1, and we never wrote
a mark on it. Until Stage 1 is on for a couple of sessions we
cannot say "tracking toward 60% contract win rate." We are at
**measurement = 0**.

**Promotion verdict: do not promote. Do not paper-mirror.**
Next action is one flag: `options_marks_enabled=true`. Then a
30-day Alpaca backfill. Then read the scorecard. Ladder / honesty
/ management stay off until that table has numbers.

---

## 7. Movie framing — mechanism is live; the question is still losing; do not promote

Frames v2 is on live payloads (HII / LLY / SPY / QQQ all stamp
`session_min`, `hmm_state`, `hmm_chop`, `high_chop`, `pdz_zone_D`,
`adverse_phase`). Playbook vetoes (`shouldSkipArm`: first 30m RTH,
CHOP posterior ≥ 0.55) are on `main` (PR #1272). Phase 2 is off.
Good.

Shadow report, 7d ending 19 Aug (vs the 17 Aug note):

| Playbook | Trig | Inv | Acted | Fwd median | Pos % | 1d median | 1d pos % |
|---|---|---|---|---|---|---|---|
| daily_ema21_reclaim | 115 | 46 | 7 | **−1.48%** | 36 | **−0.74%** | 43 |
| weekly_breakout_retest | 75 | 24 | 4 | **−0.78%** | 39 | **−2.50%** | 25 |

17 Aug the daily-reclaim 1d slice was the only non-negative
(+0.84%, 64%). It is now negative. Opening window is still worse
than later session (daily reclaim open −1.52% / 30% vs later
−0.81% / 41%). 14d is the same shape (daily reclaim fwd −1.38%).

Acted-on overlap with this week's ST losers: SPOT, GEV, IYT, WAL,
JCI, TT, PNC — several armed in the first 12 minutes. Vetoes skip
*new* arms; books already armed (HII still has
`weekly_breakout_retest` armed from 17 Aug) can still trigger.
The movie is recording the same CHOP tape the snapshot path
already lost on. It is not a second edge.

**Promotion verdict: keep Phase 2 off.** Do not invent more EMA
playbooks. The next 7d report should show *fewer* opening-window
and high-CHOP new arms if the veto is doing its job. If daily
reclaim 1d is still the only (and now failing) slice, leave it
in shadow.

The movies that *do* matter this week are not `_armed_playbooks`:

- Investor `FAILED_ENTRY_RECLAIM` (META 10 Aug) — already live.
- Investor close-vs-wick invalidation — flags on, warming up.
- CHOP persistence as a **veto** — stamped on frames; CIO still
  ADJUSTs through it. That is the capital-path gap, not a movie
  gap.

---

## 8. What to do next (ordered)

1. **Leave Loop 2 paused.** Do not re-open Speculative ATH /
   support / range-reversal longs while universe HMM is CHOP
   ~0.99. The demotions are the right reaction; let them hold.
2. **Decide the 13 TRADE cards** using the table in §4. That is
   the operator loop now. RTX LEFT_MONEY and HII/GEV/IYT
   BAD_ENTRY are the two clean classes.
3. **CIO ADJUST vs CHOP.** The hard-reject path (GE/GS phase)
   works. ADJUST-on-Speculative-in-CHOP is how this week's
   −$817 happened. A config finding from the HII/PH/CPER
   cluster: refuse or hard-haircut Speculative when
   `high_chop=true`, regardless of Markov / July-playbook
   overweight. Route that through Trade Review → tier-2
   proposal, not a live flip from this note.
4. **Flip `options_marks_enabled=true` only.** No other options
   flags. Confirm `dt:QQQ:…` rows appear in `signal_outcomes`
   and `option_marks` starts filling on the 5-min cron. Then
   backfill.
5. **Do not promote the movie.** Re-read the shadow report in
   another 7 sessions. Promotion bar is still "daily reclaim 1d
   is not the only non-negative slice, and acted-on names are
   not the ST loser list."

Not in scope: investor weekly-ST floor ratchet, auto-mirror,
Phase 2, new EMA playbooks, re-enabling ATH/support admission.
