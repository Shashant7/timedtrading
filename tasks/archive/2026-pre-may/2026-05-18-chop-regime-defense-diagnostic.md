# 2026-05-18 — Chop-regime give-back diagnostic
**Question from owner:** "Our strategy is sucking hard right now. The market is exhausted and is pulling back and backing-and-filling. How do we not keep getting burnt and lose so much after we had something really good going. What is missing here?"

**TL;DR:** The system *can* see the regime (it computes a `regime_class` of `TRENDING / TRANSITIONAL / CHOPPY` per ticker), but on the live TT-Core engine path it does almost nothing differently when that classifier turns negative. New entries don't get throttled or down-sized, the workhorse setup keeps firing at full conviction, the loss-cap fires on entries that the filter never should have accepted, and there's no weekly drawdown circuit-breaker. The April peak was a regime fit, not a structural edge that's failing — May / last-90-days proves the engine is statistically flat the moment the tape stops trending up cleanly. This doc names every gap with file/line refs and proposes a sequenced rollout to close them.

---

## 1. Reality check — the numbers

From `tasks/may-2026-performance-analysis.md` (PR #194 source-of-truth):

| Window | Trades | W/L | WR% | Net | PF | Expectancy |
|---|---|---|---|---|---|---|
| Last 7 days | 9 | 2/6 | **22%** | **-$526** | **0.11** | -$58 |
| May 2026 | 14 | 3/10 | **21%** | **-$1,069** | **0.06** | -$76 |
| April 2026 | 20 | 13/7 | 65% | **+$3,259** | 9.13 | +$163 |
| March 2026 | 39 | 14/25 | 36% | **-$3,005** | 0.37 | -$77 |
| Last 90 days | 107 | 48/58 | 45% | **+$190** | 1.02 | +$2 |
| All-time | 598 | 309/288 | 52% | +$39,155 | 2.00 | +$65 |

Three out of the last three months have been losers or net-flat. April was the only good month, and it gave back all of March's loss only because trend conditions returned briefly. The "good run" was a regime alignment, not a structural improvement.

**Where the bleed concentrates (90-day exit-reason):**

| Exit reason | n | WR% | Net | Avg/trade |
|---|---|---|---|---|
| `doctrine_force_exit` | 17 | **12%** | **-$2,107** | -$124 |
| `hard_loss_cap` | 3 | **0%** | **-$1,771** | **-$590** |
| `tape_capitulation_force_exit` | 12 | 42% | -$773 | -$64 |
| `atr_day_adverse_382_cut` | 4 | 0% | -$593 | -$148 |
| Two families together | 20 | — | **-$3,878** | — |

The protective machinery (`profit_giveback_stage_hold`, `smart_runner_*`, `atr_week_618_*`) is working — `tp_full` shows +$2,116 / 8 trades / 100% WR. **What is failing is the entry filter.** `doctrine_force_exit` and `hard_loss_cap` are firing on positions that shouldn't have been opened in chop / transition.

---

## 2. What the system already does well

Each item below already exists in code today. The system is not blind to regime — it just doesn't *act* on what it sees on the live path.

- **Swing regime label (`regime.combined`)** — `STRONG_BULL / EARLY_BULL / LATE_BULL / NEUTRAL / EARLY_BEAR / LATE_BEAR / STRONG_BEAR` from daily+weekly pivot structure. `worker/indicators.js:3037`.
- **Chop classifier (`regime_class`)** — `TRENDING / TRANSITIONAL / CHOPPY` with a -15..+15 score and factor breakdown. `worker/indicators.js:4959`.
- **Market internals** — VIX state + offense-vs-defense sector spread fed into a market-internals score. `worker/replay-candle-prep.js:145`.
- **Phase C admission matrix** — per-setup `allow_only_in` regime lists. ATH breakout is correctly already restricted to bull regimes with `min_rr 2.0 / min_conviction 4` (PR #194). `worker/phase-c-setup-admission.js:114`.
- **Earnings proximity block** — 48h pre-earnings block on new entries (when `eventRisk.eventType === "earnings"`). `worker/pipeline/tt-core-entry.js:539`.
- **Breakeven stop + giveback tighten + HLC** — once MFE > threshold, stop ratchets to entry; severe-giveback exit; hard-loss-cap defaults $250 / 4% after 15-min hold. `worker/index.js:18627`, `:18910`.
- **Cluster throttle** — if ≥5 entries fire within 60min, keep only the top-3 by rank × RR. `worker/phase-c-cluster-throttle.js:33`.
- **Loop-2 circuit breaker (partial)** — pauses entries on low last-10 WR or bad today-PnL or consecutive losses. `worker/phase-c-loops.js:246`.

---

## 3. The gaps (why the bleed continues)

Each gap below is the **specific reason** the system keeps taking damage in chop. Numbered for cross-reference in §4.

### G1. TT-Core admission ignores `regime_class`

The live admission path keys off `regime.combined` (`STRONG_BULL` etc.) only:

```366:368:worker/pipeline/tt-core-entry.js
        const _regimeForAdmission = String(
          d?.regime?.combined ?? d?.regime_combined ?? ""
        ).toUpperCase().trim();
```

`regime_class === "CHOPPY"` / `"TRANSITIONAL"` is never consulted in admission. So when SPY's swing label is still `EARLY_BULL` but the chop classifier is screaming TRANSITIONAL or CHOPPY, the engine keeps admitting full-conviction continuation longs and they fail intraday. This is the structural mismatch between "swing label says bull" and "intraday tape says chop."

### G2. Workhorse Prime is "always allow"

```60:64:worker/phase-c-setup-admission.js
  "tt_gap_reversal_long:LONG:Prime": {
    block_when: null,
    reason: "workhorse — always allow",
```

`gap_reversal_long:Prime` is the highest-volume setup and explicitly never gated on regime. In a chop tape, this becomes the dominant *source* of the bleed — and `gap_reversal_long` 90-day PF dropped from all-time 2.98 to **1.31** with a 51% WR. The setup is still net positive, but the contribution in chop alone is negative.

### G3. Legacy defenses are wired off for TT-Core

```4999:5002:worker/index.js
  const _skipLegacyGates = entryEngine === "ripster_core" || entryEngine === "tt_core";

  const _daConfigFull = d?._env?._deepAuditConfig || {};
  const _daConfig = _skipLegacyGates ? {} : _daConfigFull;
```

`_skipLegacyGates` is true for TT-Core (the engine `MANAGEMENT_ENGINE = "tt_core"` in `wrangler.toml:78`). That short-circuits these mechanisms entirely on the live path:

- `da_vix_ceiling` (block entries when VIX > 32) — `worker/index.js:5044`
- `strong_bull_overextended` (STRONG_BULL + `completion > 0.40` long block) — `worker/index.js:5421`
- `multi_tier_choppy` (block when ≥2 of market/sector/ticker are CHOPPY) — `worker/index.js:5437`
- `spy_bearish_long_blocked` + `__spy_size_mult = 0.5` when SPY is moderately bearish — `worker/index.js:5457`
- `choppy_regime_rank_floor` (raise minimum rank in CHOPPY/TRANSITIONAL) — `worker/index.js:4427`

These were intentionally turned off when TT-Core became the engine in the assumption that they would be re-implemented inside `tt-core-entry.js`. They were not. So all the user's defensive `model_config` knobs (VIX ceiling, regime size multiplier, multi-tier chop, choppy rank floor) are silently no-ops today.

### G4. Exit doctrine doesn't have a chop mode

```445:456:worker/phase-c-exit-doctrine.js
  if (regimeFlippedOpposite(direction, entryRegime, currentRegime)
      && ageSessions >= params.force_exit_min_age_sessions
      && _pnl <= params.force_exit_pnl_threshold) {
    return {
      action: "force_exit",
      force_exit: true,
```

`chooseExitDoctrine` only flips to force-exit on **swing** regime flip. It doesn't have a "chop classifier turned negative → tighten exits or downgrade to scalp mode" branch. Combined with G1, this means: chop tape → keep admitting → keep holding to swing stop → `doctrine_force_exit` fires once per losing 1-3 day hold (-$124/trade × 17 trades = -$2,107 in 90d).

### G5. Loop-2 has no weekly drawdown guard

```213:216:worker/phase-c-loops.js
  const todayClosed = closedAll.filter(
    (t) => Number(t.exit_ts || 0) >= todayBoundaryMs && Number(t.exit_ts || 0) <= nowMs
  );
  const todayPnl = todayClosed.reduce((s, t) => s + (Number(t.pnl_pct) || 0), 0);
```

The circuit breaker only sums **today's** trade PnL. After a 7-day bleed (-$526) the today bucket resets every midnight and the breaker never trips. There's no rolling 5-trading-day or week-to-date guard.

### G6. Size is binary (block or full) — no chop-aware size haircut

There's no intermediate path between "qualify" and "reject" that says "qualify at half size during CHOPPY." `tasks/lessons.md` explicitly notes: *"wider stops without smaller size worsens chop losses"* — and that's exactly what's happening. We admit at full size, hit the wider chop-time stop, take the full loss.

### G7. Short side has been silent for 30 days

```77:84:tasks/may-2026-performance-analysis.md
| Last 30 days | 23 ($+889) | **0** ($0) |
**The model has not opened a single short in 30 days.** Yet `gap_reversal_short` is the highest-PF setup in the entire book (PF 8.86, 11 trades all-time).
```

This isn't risk control failing — it's an opportunity miss. Every red month (March, May, intraday May) had bearish setups that would have caught the down move. The system is structurally biased long during chop precisely when shorts have the edge. This is a separate investigation (universe filter / short-side rank floor / regime classifier bias) but it's part of "what's missing."

---

## 4. Recommendations — smallest blast radius first

Each item is **one focused PR**. Numbered so we can sequence and measure independently.

### R1 — Restore the VIX ceiling on TT-Core (1 line + config) ⭐ first

**Code:** `worker/index.js:4999-5002`. Stop blanket-zeroing `_daConfig` for TT-Core; either pass the full `_daConfigFull` through, or copy at minimum these three keys into a TT-Core-aware allow list: `deep_audit_vix_ceiling`, `deep_audit_regime_size_mult`, `choppy_regime_rank_floor`.

**Blast radius:** Tiny — one conditional. **Impact:** Restores the gate the user thought was on. **Risk:** If `model_config` has stale ceilings, may briefly suppress entries; mitigated by config-side knob.

### R2 — Add `regime_class` chop block on continuation Prime setups

**Code:** `worker/pipeline/tt-core-entry.js:~366` (after `_regimeForAdmission`). When `regime_class ∈ {CHOPPY, TRANSITIONAL}` AND the setup is a **continuation** path (`tt_ath_breakout`, `tt_gap_reversal_long` Prime, `tt_pullback_continuation`), require either `+1 conviction grade` OR reject. Reversal paths (`tt_gap_reversal_short`, `range_reversal_long`) are exempt — they thrive in chop.

**Blast radius:** Medium — affects entry rate. **Impact:** Per the May data (gap_reversal_long PF dropped from 2.98 → 1.31), this is where ~$1.5K/quarter of bleed lives.

### R3 — Chop-aware size haircut (NOT a block)

**Code:** Same hook as R2. When `regime_class === CHOPPY`, set `d.__chop_size_mult = 0.5` and have the position sizer multiply through. Solves G6 directly. Lessons doc explicitly warns wider stops + full size in chop is the worst case — this fixes it.

**Blast radius:** Medium — entries still fire, just smaller. **Impact:** ~50% loss reduction on chop-period entries (assuming same WR, half size).

### R4 — Weekly drawdown breaker in Loop-2

**Code:** `worker/phase-c-loops.js:loop2ComputePulse` (~176) + `loop2EvaluatePulse` (~246). Add `last5d_pnl_pct` (last 5 trading days of closed trades) and trip when below e.g. -2.0%. Pause new entries until the next green day.

**Blast radius:** Small — only adds a pause condition. **Impact:** Prevents a 7-day -$500 streak from becoming a 14-day -$1,500 streak. Today's bucket resets at midnight which is why this is missing.

### R5 — Exit doctrine "chop mode" branch

**Code:** `worker/phase-c-exit-doctrine.js:chooseExitDoctrine` (~375). Pass `regimeClass` as a new arg; when `CHOPPY` AND position age > 4 sessions AND PnL < -1R, downgrade to `defend` (trim) instead of waiting for the full `force_exit_pnl_threshold` to fire `doctrine_force_exit` at -$124 avg.

**Blast radius:** Higher — touches exit logic. **Impact:** Targets the largest single bleed (`doctrine_force_exit` -$2,107 / 90d).

### R6 — Re-open the short side

**Investigation, not a code patch yet.** Trace why `tt_gap_reversal_short` hasn't fired in 30 days. Candidates per `tasks/may-2026-performance-analysis.md:80`:
- Universe filter dropping bearish profiles
- Regime classifier short-side bias
- Rank gate too high on short setups (long-side cutoff used for both)

**Blast radius:** Depends on root cause. **Impact:** `gap_reversal_short` is PF 8.86 — even 2-3 trades / mo recovers $200-500.

### R7 — Repair the calibration VIX/regime enrichment

**Code:** Calibration aggregator. The diagnostic report has empty `vix_buckets` and only `unknown` in `regime_filters` (per PR #194's analysis doc §6). Until this is fixed we cannot **measure** how each setup performs by VIX bucket, which means future calibrations are flying blind.

**Blast radius:** Reporting only — no live behavior change. **Impact:** Unlocks every regime-conditional knob in R1–R5.

---

## 5. Sequenced rollout (proposed)

Two soak periods so we can attribute impact. Each step is one PR. **Recommend starting with R1+R7 immediately, R4 within a week, R2/R3 after one week of clean signal, R5/R6 once we have a calibration baseline.**

| Step | PR | Soak | Why this order |
|---|---|---|---|
| 1 | R1 (VIX ceiling restore for TT-Core) + R7 (calibration enrichment) | 3 days | R1 is the smallest fix that restores a user-expected behavior. R7 unlocks measurement. |
| 2 | R4 (weekly DD breaker) | 5 days | Pure safety net, no per-trade behavior change. |
| 3 | R3 (chop size haircut) | 5–7 days | Half-size keeps the entry signal alive while cutting tail. |
| 4 | R2 (chop block on continuation Prime) | 7–14 days | After R3 we can compare full-size-chop vs half-size-chop vs blocked-chop with the calibration enrichment from R7. |
| 5 | R5 (exit doctrine chop mode) | 14 days | Highest-leverage but biggest exit-logic change — should land last so we can isolate the effect. |
| 6 | R6 (short side investigation) | Separate track | Belongs in a calibration sweep, not a tactical PR. |

---

## 6. Open questions (only the owner can answer)

1. **Risk budget shape** — When the chop classifier flips, would you rather **reduce frequency** (R2 block), **reduce size** (R3 haircut), or **both**? Lessons file warns against full-size + wider chop stops; that points to R3 first, R2 as a secondary tightener.

2. **Workhorse protection** — Are you willing to *throttle* `gap_reversal_long:Prime` (the system's biggest source of trades) during CHOPPY, knowing it cuts trade count in exchange for cutting the bleed? Without this, R1+R3+R4 will help but `gap_reversal_long` remains the dominant chop loss.

3. **SHORT philosophy** — Recent product narrative is "bear-only shorts" (the source of the strong all-time PF). May made the case for *tactical* shorts in late-bull exhaustion (`LATE_BULL` + risk-off internals). Are tactical shorts on the table? If yes, R6 graduates from "investigation" to "first-class admission path."

4. **Truth model for regime** — When **ticker swing** regime, **SPY** regime, **chop class**, and **internals** disagree, **which wins**? Especially for exits (R5). Current code mostly believes the ticker's swing label — which is exactly why we hold longs into chop.

5. **Loop-2 stringency** — Current breaker uses **summed per-trade `pnl_pct`** which is a proxy for dollar drawdown but undersized for big-dollar trades. Is dollar-based (NAV %) the right threshold for R4, or is the existing per-trade % proxy good enough?

6. **Earnings sizing** — Today's 48h block is binary. Should *post*-earnings open positions also carry a vol haircut for 1-3 days, given how often post-earnings gaps trigger `doctrine_force_exit`?

---

## 7. What this doc IS and IS NOT

**IS:** A diagnosis of why a profitable engine is bleeding in a regime it didn't structurally adapt to. The gaps named in §3 are all real, all in active code paths, and each has a file/line reference.

**IS NOT:** A code change. This doc deliberately ships only as a planning artifact — exit/admission/sizing logic changes need explicit owner approval and should land one at a time so the impact is measurable. The recommended first PR is R1 (the smallest possible code surface that restores a behavior the owner already expects to be in place) plus R7 (reporting only).

**Cross-references:**
- `tasks/may-2026-performance-analysis.md` — source numbers, PR #194 calibration plan.
- `tasks/lessons.md` (May 14–17 block) — cohort traps, the "wider stops + full size = worse chop loss" lesson.
- `tasks/phase-c/monthly-verdicts/2026-05-phase-c-stage1.md` — automated monthly slice; 0 closed trades in window, illustrates calibration plumbing gaps that R7 unlocks.
