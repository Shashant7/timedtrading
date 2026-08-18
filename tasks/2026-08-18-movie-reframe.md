# Movie reframe (2026-08-18)

The hunch is right: the movie *mechanism* is fine. What it is looking
for is the wrong question after scoring and logic were refined.

This note applies the short-term July autopsy, the investor stop
forensics, and the 17 Aug live book to `_frames` / `_armed_playbooks`.
Phase 2 (Investor reads the movie live) stays **off**.

---

## 1. What the movie is today

Phase 1 (shadow) stamps two objects on every scored payload:

| Object | What it actually asks |
|---|---|
| `_frames` | Where is price vs Weekly EMA21 / Weekly ST / Daily EMA21 right now? |
| `_armed_playbooks` | Did that state just transition testing/below → approaching/above? If yes, fire `weekly_breakout_retest` or `daily_ema21_reclaim`. |

Those two playbooks are the CAT (weekly retest) and ANET (daily EMA21
reclaim) investor slices. They are real classes. They are not the
desk's current failure mode.

Shadow report (7d, as of the 17 Aug book): 222 triggers, 46
invalidations, engine acted on 11. Same-day forward median **negative**
(−0.13% / −0.21%). Daily reclaim 1d is the only slice that is not
dead (+0.84%, 64%). Opening-window triggers are worse than the rest.

The infrastructure did its job: it recorded transitions, it did not
silently no-op, and the ledger fast-path fixed the day-1 "session low
is not on the payload" bug. The question it asks is too narrow to
matter, and on the days it fires it is not beating the snapshot path
(~45% same-day).

---

## 2. What ST and LT actually taught

### Short-term (July autopsy + 17 Aug)

Losers were not "missed Weekly EMA21 reclaims." They were:

- **CHOP + speculative support / ATH / HTF-reclaim coincidence.**
  Snapshot + CIO ADJUST already cleared HII / SPOT / SN / XLRE. The
  movie's EMA transition would have armed the same names.
- **Opening-window chases.** Five of the July ST misses printed in
  the first ~30 minutes. Session minute is a first-class feature;
  EMA state is not.
- **Adverse phase / RSI trajectory.** GE/GS 17 Aug: CIO hard-rejected
  on W-bear phase 34.3 / 31.3. The movie never saw that. Sequence
  here means *the print is 2–3 bars old and still printing*, not
  "price crossed a band."
- **Never-ran location.** XYZ cloud-pivot −1.23% with MFE −0.05%.
  A reclaim trigger would have been a second way to enter the same
  bad location.
- **Giveback path, not exit label.** USO paid +2.17% TP_FULL and
  still LEFT_MONEY because trims/exit cut a runner that was in
  motion. The movie has no MFE/MAE path on an open position.

### Long-term (investor stop forensics)

- **Close vs wick.** ANET Jul 16: a live mark through Weekly ATR at
  2pm while support held. `resolvePrimaryInvalidationMovie` already
  requires a close/hold-below. That *is* a movie, and it is the
  right one. Frames/playbooks do not encode it.
- **Failed-reclaim exit.** MTZ: underwater → near BE → reject should
  exit. Sequence matters. `_inv_movie` / `_failed_reclaim` already
  watch it. EMA-reclaim *entry* sequence is the opposite problem.
- **Shallow weekly-ST breach while SPY is above its 21.** 44 of 47
  investor closes were `PRIMARY_INVALIDATION_BREACH` at a median
  1.29% penetration; 18 of 23 recovered inside 20 sessions. The
  movie that matters on the way out is *dwell below + failed reclaim
  + SPY regime*, not "Daily EMA21 approaching."
- **2+ cycle confirm.** Reclaim-as-entry is only real after the
  level holds a second cycle. Day-1 shadow treated a single
  transition as a trigger. That is the CAT/ANET class, and even
  there the live shadow is not yet evidence to promote.

---

## 3. Does sequence even matter?

Yes — for a short list. No — as a general entry doctrine.

**Sequence matters for:**

1. **Reclaim confirm (2+ cycles)** on a respected HTF anchor after a
   held test. This is CAT/ANET. Keep it in shadow. Do not let a
   single 5-min print arm capital.
2. **Failed-reclaim exit** (underwater → BE reject, or sweep → fail
   to recapture). Already on the investor lane.
3. **Invalidation close vs wick.** Already on the investor lane.
4. **CHOP dwell.** HMM `CHOP` posterior staying high across cycles
   is a veto, not a setup. Conjunction with speculative grade is
   the 17 Aug loser signature.
5. **MFE giveback path on an open book.** USO-class LEFT_MONEY:
   trim/exit while the dominant move is still running. This is a
   management movie, not an entry movie.
6. **Session minute.** First ~30m of RTH is a skip, not a trigger
   window.

**Sequence does not matter as:**

> approaching → testing → above Weekly EMA21 = enter

That is what Phase 1 measures. Same-day forward is negative. The
refined scorer + CIO already have a better snapshot answer for
"is this a support bounce / ATH break / HTF reclaim right now?"
The movie should not re-ask that with a slower, thinner lens.

---

## 4. How the movie should be viewed

Watch **conjunctions and trajectories**, not a single anchor state.

| Watch | Why | Already exist? |
|---|---|---|
| HMM CHOP persistence (`latent_regime.state=CHOP` + posterior ≥0.55) | 17 Aug speculative-in-CHOP losers | On payload; now stamped on `_frames` |
| Adverse phase/RSI **trajectory** (strength + bars_ago on 30m+) | GE/GS CIO rejects | On payload; now stamped as `adverse_phase` |
| PDZ premium/discount **over time** | Location-blind admission | `pdz_zone_D` now on `_frames` |
| Session minute | Opening-window chases | `session_min` now on `_frames`; new arms skipped if `< 30` |
| Open-position MFE/MAE path | LEFT_MONEY vs CORRECT_LOSS | Capture math lives in Trade Review, not frames |
| Failed-reclaim / close-confirm invalidation | Investor exits | `_inv_movie`, `_failed_reclaim` — leave them |
| Speculative ∧ CHOP | Conjunction that snapshot+CIO already catch | Do not add a third entry path |

Playbooks stay shadow. New arms now skip opening-window and
high-confidence CHOP so the shadow report stops counting the
classes we already know are wrong. Existing armed books can still
invalidate or expire.

**Do not promote Phase 2.** Investor already has the movies that
the LT autopsy says matter. Wiring `_armed_playbooks` into live
investor entry would reintroduce the CAT/ANET trigger as a
general entry, which is the mistake.

---

## 5. What changed in code (this PR)

- `worker/frames.js` v2 stamps `session_min`, `hmm_state` /
  `hmm_chop` / `high_chop`, `pdz_zone_D`, `adverse_phase`.
- `worker/playbooks.js` `shouldSkipArm()` vetoes new arms in the
  first 30 minutes of RTH and when HMM CHOP posterior ≥ 0.55.
- No live capital path. No Phase 2. Shadow report will start
  showing fewer opening-window / CHOP triggers; that is the point.

Next measurement: another 7d shadow-report after deploy. If daily
reclaim 1d stays the only non-negative slice, keep it shadow and
do not invent more EMA playbooks.
