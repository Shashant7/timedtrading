# Playbook / setup audit (19 Aug 2026)

Operator: evaluate every setup and playbook; refine or purge; ground them
in tried-and-true expert patterns; treat timeframes as a sequence (10m
event should mean something on 30m / 1H).

This is the scorecard. Live capital changes from this note:

- Loop 2 stays paused (`wr_10`). ATH Breakout / Support Bounce /
  Range Reversal (Long) stay `blocked` on the enforce list.
- CIO now **REJECTS** Speculative (or grade-unknown) ATH / support /
  range-reversal longs in high-confidence CHOP, and 10m chases opposed
  on both 30m and 1H. Prompt + deterministic `applyCioContextVerdict`.
- Movie Phase 2 stays off. Re-read the shadow report after more sessions.
- `deep_audit_ja_grade_wildcard` stays **false** (parked because it
  suppressed the +64 Aug ATH month). Empty-grade admission remains a
  hole; CIO is the last line until grade-before-admission lands.
- `deep_audit_ja_ltf_structure_confirm` is already **true** (15m+30m
  broken structure blocks LONGs unless 1H is strong or LTF RSI is a
  washout). That *is* the 15m/30m/1H sequence gate.

No setup is deleted in this pass. Purge here means "do not re-enable
after Loop 2 lifts until the keep-criteria below are met."

---

## Expert map (what the books actually say)

| Source | Pattern | What "good" looks like | What we must not do |
|---|---|---|---|
| Edwards & Magee / Bulkowski | Breakout | Stage-2 advance, volume expansion, close above resistance, optional throwback that holds | Buy every ATH print in a range/CHOP tape |
| Minervini (VCP / SEPA) | Tightening base → pivot | Volatility contracts, RS leadership, Stage 2, volume dry-up then expansion | Speculative breakouts with no contraction, no RS |
| Al Brooks | Always-in + H1/H2 | Higher-TF always-in first; LTF entry is a pullback in that direction | 10m signal against 30m/1H always-in |
| Linda Raschke | 3-1-2 / Holy Grail / 2B | 20-EMA pullback in a trend; failed breakout (2B) fades the first break | Support bounce with no trend, first-break ATH |
| Elder triple screen | Weekly/daily filter → LTF trigger | Higher TF trend, lower TF entry. Never trade LTF against HTF | Isolated 10m cloud cross |
| Wyckoff | Spring / SOS / LPS | Spring under support that reclaims; SOS on volume after accumulation | Buying the breakdown and calling it a bounce |
| Crabel / opening-range | ORB | Wait for the opening range to print; first 30m is noise | Arm or enter in the first 30m (already `shouldSkipArm` + `ja_opening_gate`) |

Our names are standard patterns. The miss is **admission without the
expert's qualifiers** (trend stage, HTF always-in, volume/RS, sequence).

---

## Short-term setups

| Setup | Expert analog | 13–19 Aug | Verdict | Keep criteria |
|---|---|---|---|---|
| **TT ATH Breakout** | Magee breakout / Minervini pivot | 12 / −$465 | **Purge from CHOP and Speculative.** Prime-only in EARLY/STRONG_BULL + RR≥2 + conviction B4+ already in the matrix. Do not lift Loop 2 block until a 30d Prime-only slice is +EV. | HTF always-in long (1H+D ST bull), RS leadership, not CHOP≥0.55, not opening window |
| **TT Support Bounce** (n-test) | Raschke Holy Grail / Wyckoff LPS | 9 / −$108 | **Refine, do not re-enable Speculative.** `ja_n_test_confirm_required` is on. Treat as a 30m/1H hold of a respected level, not a 10m wick. | Daily/1H structure intact, LTF not mid-breakdown (`ltf_structure_confirm`), bounce after a test not a chase |
| **TT Range Reversal (Long)** | Brooks H2 / 2B fade | 1 / −$121 (WAL) | **Purge until CHOP posterior < 0.6.** Canon was already 33% WR. | Range actually defined (not a falling knife), 2B/H2 on 30m+, RR≥2.5 |
| **TT HTF Reclaim** | Wyckoff SOS / Brooks always-in flip | 3 / −$123 (XYZ×2, SPOT) | **Keep / refine.** This is the family that matches the books. Losers this week were still CHOP. | Reclaim of a respected Daily/Weekly EMA after a held test; 1H confirms; not first 30m |
| **TT Gap Reversal** | Crabel / opening drive fade | not in this week's bleed | **Keep.** Canon workhorse. | Existing matrix |
| **Index ETF swing** | HTF always-in on SPY/QQQ/IWM | n/a this week | **Keep, Prime only.** | Already restricted |

---

## Armed movie playbooks (shadow)

| Playbook | Expert analog | 7d shadow (19 Aug) | Verdict |
|---|---|---|---|
| `daily_ema21_reclaim` | Raschke Holy Grail (daily 21) | 115 trig, fwd −1.48%, 1d −0.74% | **Stay shadow.** Sequence of approaching→testing→above is not an entry (already in `playbooks.js`). Needs HTF always-in + not-CHOP + not-opening. |
| `weekly_breakout_retest` | Magee throwback / Minervini pivot retest | 75 trig, fwd −0.78%, 1d −2.50% | **Stay shadow.** Same vetoes. Do not invent more EMA playbooks. |

Phase 2 stays off. Promotion bar is still: daily reclaim 1d is not the
only (and now failing) non-negative slice, and acted-on names are not
the ST loser list.

---

## Multi-timeframe sequence (what "correlation" means here)

Brooks / Elder: a 10m event is a **trigger**, not a thesis. The thesis
lives one or two timeframes up.

| If this prints… | Then we need… | Already in the engine | New this pass |
|---|---|---|---|
| 10m 5/12 cloud cross | 30m ST *or* 1H ST with the trade | `cloud_alignment` on the CIO proposal | `mtf_sequence` stamp + REJECT when 10m trigger is opposed on **both** 30m and 1H in CHOP |
| 15m + 30m structure broken | 1H strong, or LTF RSI washout (RTX class) | `deep_audit_ja_ltf_structure_confirm` **ON** | — |
| Daily EMA21 reclaim (movie) | Weekly not broken; not opening; not CHOP | `shouldSkipArm` | stays shadow |
| Weekly EMA21 retest | Daily reclaim, not a mid-week chase | movie confluence + memory | stays shadow |

We are **not** looking for the same candle pattern cloned onto every TF
(that is noise). We are looking for **agreement of direction**: LTF
trigger inside an HTF always-in. That is the sequence.

---

## What we will not do

- Re-enable ATH / support / range-reversal while universe HMM is CHOP ~0.99.
- Flip `deep_audit_ja_grade_wildcard` (operator parked it after it ate
  a good August ATH month). Fix is grade-before-admission, not a wildcard.
- Promote movie Phase 2 or add new EMA playbooks.
- Treat ADJUST as the CIO's job on a bad location.

---

## Next measurement

After Loop 2 unpauses, read 30d by setup **and** by `mtf_sequence.confirm_count`
(0 / 1 / 2+). Keep only rows where confirm_count ≥ 2 is +EV. That is the
purge test, not a feeling.
