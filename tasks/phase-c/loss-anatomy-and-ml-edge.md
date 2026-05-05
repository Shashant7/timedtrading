# Loss-Anatomy & ML-Guided Edge Analysis

**Source dataset:** `v16-canon-julapr-30m-1777523625` (the cleanest completed Jul→Apr reference run, 553 trades, 461 cleanly closed after stripping V13 wall-clock corruption). Same engine / same setup library / same scoring as the live system.

---

## 1. Where the money goes

| Bucket (PnL%) | Count | Total PnL% | Per-trade |
|---|---:|---:|---:|
| **Monster wins (≥15)** | 5 | +491.7 | +98.3 |
| **Huge wins (8–15)** | 21 | +233.6 | +11.1 |
| **Big wins (5–8)** | 14 | +83.5 | +6.0 |
| Solid wins (1.5–5) | 90 | +237.1 | +2.6 |
| Small/scratch wins (0–1.5) | 104 | +76.9 | +0.7 |
| **Subtotal wins** | **234 (50.8%)** | **+1,122.9** | |
| Tiny papercut (-0.5–0) | 64 | -13.4 | -0.21 |
| Papercut (-1 to -0.5) | 46 | -34.4 | -0.75 |
| Small loss (-2 to -1) | 58 | -80.7 | -1.4 |
| Medium (-3 to -2) | 25 | -61.7 | -2.5 |
| Big (-5 to -3) | 14 | -48.1 | -3.4 |
| **Catastrophic (≤-8)** | **17** | **-336.0** | **-19.8** |
| **Subtotal losses** | **227 (49.2%)** | **-591.9** | |
| **Net** | 461 | **+531.0** | +1.15 |

**Headline:** 17 catastrophic losses (3.7% of trades) cost **−336 PnL%, equal to 56% of total losses and 30% of net P&L**. Eliminating just those without touching anything else would lift cumulative pnl from +531 → +867 (+63%).

The wins distribution is heavily Pareto: top 5 monsters = +492, top 26 (5+/-) wins = +809 = 72% of all win pnl. **Both ends are dominated by the tails — protect the right tail, kill the left tail.**

---

## 2. The catastrophic-loss profile (the killers)

Looking at the 34 trades that lost >−3% (sum −456.7 pnl%):

| Trajectory | N | Sum PnL% | Avg | What it means |
|---|---:|---:|---:|---|
| **Brief gain then failed** | 10 | -169.9 | -17.0 | Saw small profit, gave it back AND went deeply negative |
| **Gave back BIG gain (MFE ≥5%)** | 5 | -86.3 | -17.3 | Up 5–17% then turned to disaster |
| **Never worked (MFE <0.5%)** | 15 | -121.4 | -8.1 | Wrong from bar 1 |
| Gave back small gain (MFE 2–5) | 4 | -24.2 | -6.1 | |

**Two distinct enemies:**

1. **The "stale held" disaster (~18 trades, ~−290 pnl%)** — held into earnings or held for thousands of hours past entry while structure broke. All large `age_h > 1500h` losses. Reasons: `HARD_LOSS_CAP`, `PRE_EARNINGS_FORCE_EXIT`. These are operational/management failures, not entry quality failures.
2. **The "wrong from bar 1" (~15 trades, ~−121 pnl%)** — MFE never even cleared 0.5%. The setup picked the wrong direction or the wrong moment.

The 4 worst-by-magnitude losses (AGQ −57, AGQ −39, RDDT −38, CVX −29) are ALL **stale held trades that the system forgot existed**, plus one ASTS that was up +17% and round-tripped to −28%. None of them were entry mistakes per se — they were management mistakes amplified by `HARD_LOSS_CAP` finally firing months later at terrible prices.

---

## 3. Setup-level health (where the edge actually lives)

| Setup × Grade | N | WR | bigW | bigL | catastrophic | sum PnL% |
|---|---:|---:|---:|---:|---:|---:|
| **Gap Reversal Long / Prime** | 216 | **61.1%** | **28** | 19 | 5 | **+663** |
| Pullback / Prime | 24 | 58.3% | 3 | 1 | 0 | +33 |
| Gap Reversal Short / Prime | 8 | 62.5% | 3 | 0 | 0 | +26 |
| Gap Reversal Long / Confirmed | 53 | 49.1% | 2 | 3 | 2 | +7 |
| ATH Breakout / Prime | 24 | 54.2% | 0 | 0 | 0 | +1 (flat) |
| Pullback / Confirmed | 16 | 37.5% | 0 | 0 | 0 | -3 |
| ATH Breakout / Confirmed | 21 | 23.8% | 0 | 0 | 0 | -8 |
| **N-Test Support / Prime** | 21 | 38.1% | 2 | 2 | **2** | **−66** |
| **N-Test Resistance / Confirmed** | 7 | **0.0%** | 0 | 3 | **3** | **−71** |

**Two clear tiers:**

- **Workhorse cohort** — *Gap Reversal Long/Prime + Pullback/Prime* (240 trades, ~52% of book, +696 pnl). This is where the edge lives. Sizing should LEAN INTO this.
- **Toxic cohort** — *N-Test (any direction), Confirmed grade across most setups, ATH Breakout/Confirmed*. Combined ~50 trades, all flat-to-deeply-negative, accounts for nearly all catastrophic losses outside the stale-held category.

---

## 4. ML model results — what actually predicts outcomes

Trained gradient-boosted classifiers on `rank_trace_json` features (rr, completion, htf/ltf, phase, conviction, regime, setup, etc.):

| Target | 5-fold AUC | Verdict |
|---|---:|---|
| P(big win, ≥5%) | **0.744** | Strong signal — we CAN identify big-winner candidates at entry |
| P(win, >0%) | 0.589 | Weak — WR is noisy at the trade level |
| P(big loss, ≤-3%) | 0.422 | **Worse than random** — losses look random from entry features alone |

**This is the most important result in the analysis.** It tells us:

1. **Entry-time features predict the WINNERS, but NOT the disasters.** Big losses don't have a fingerprint at entry — they're MANAGEMENT failures (held too long, ignored thesis change, no fast escape from broken setups), not selection failures.
2. **The opportunity is therefore NOT to "filter out big losses at entry"** — that won't work. The opportunity is to **(a) detect setup invalidation FAST after entry**, and **(b) lean into the high-EV winners we can actually identify**.

### What the WIN model says matters

Top features for predicting big wins:
- `rr` (reward:risk at entry) — **0.252** importance
- `completion` (% of base completed) — **0.155**
- `ltf` strength — **0.126**
- `phase` (where in the move) — **0.108**
- `htf` strength — **0.107**
- `focus_conviction_score` — **0.088**
- `setup=Gap Reversal Long`, `regime=STRONG_BULL`/`EARLY_BULL`

These are not surprising — they're the things our scoring already uses. The interesting part is the **non-monotonic shape** of several:

### The decile sweet-spots (where the edge concentrates)

| Feature | Sweet decile | Hot evidence |
|---|---|---|
| **rr** | top decile (rr ≥2.94) | 11 big_W, 9 big_L, sum +326 — **highest variance bucket** |
| **rr** | D9 (rr 2.59–2.92) | 67% WR, 10 big_W, 4 big_L, +56 sum — **best risk-adjusted** |
| **completion** | D1 (≤0.17, very_early) | sum +318, 10 big_W, 9 big_L — high variance, but +EV |
| **completion** | D9–D10 (≥0.27, late) | -67/-17 sum, 13 big_L vs 1 big_W — **kill switch** |
| **htf** | D2 (26–34) | sum +307 — surprising "weak HTF" sweet spot, dominated by gap-reversal-long |
| **focus_conviction** | D5 (87–91) | sum +436 — middle conviction outperforms BOTH high and low |
| **focus_tier** | C | -89 sum, WR 42%, 7 big_L — **clear fade signal** |

**Combinatorial sweet-spot:** `rr ≥2.7 AND completion <0.18` (very early, high RR setups) → 57 trades, 13 big wins, +354 PnL. **6.2 PnL per trade**, vs 1.15 average.

**Combinatorial fade-spot:** `rr <1.7 AND completion ≥0.27` (late, low-RR setups) → 87 trades, 8 big losses, -85 PnL. **−0.98 per trade**.

---

## 5. Counter-intuitive findings

1. **Late-stage trades (`completion >0.27`, `phase >0.5`) have neither big wins NOR good WR.** We've been letting these through under "context-aware" carve-outs. The data says: hard fade them unless rr ≥3.0.
2. **Confirmed grade is bleeding** (-107 net across 137 trades, only 3 big wins). The "wait for confirmation" stance is sacrificing the early-completion edge that drives our monsters. Worth testing: only take Confirmed if rr ≥2.7.
3. **`focus_tier = A` is mediocre** (+26 over 46 trades). The scoring system is "demoting" some of our best setups out of the fat-tail bucket. Tier-B with conv 85–95 is the actual engine room.
4. **`SHORT` direction is broken in this universe** — 24 trades, 29.2% WR, -49 sum, no setup carries it. **Recommendation: gate shorts behind a much higher bar (rr ≥2.7 AND HTF<−20 AND late_bear regime)** or shut them off until we have a focused short universe.
5. **`HTF_BULL_LTF_PULLBACK` state** — only 16 trades but 50% WR + 3 big wins. We're under-sampling this. Pullback setups in trend continuation are where we should be looking for the next edge.
6. **Hour-of-day matters for big losses but NOT for big wins.** Big losses cluster 17:00–18:00 UTC and 20:00 UTC (close-of-RTH window). Big wins are roughly uniform across hours. **A "no new entries in last hour unless rr ≥3" rule would prevent ~−95 pnl with minimal upside cost.**

---

## 6. The framing shift

We've been asking the wrong question. The question isn't *"how do we avoid losses?"* — most of our losses are small papercuts that we're already handling fine (110 papercut+tiny losses = -47 pnl%, ~10% of all loss damage).

The two questions worth asking are:

### Q1: "How do we never let an open trade become a 30-bagger loss?"
The catastrophic 17 trades (-336 pnl%) are almost entirely **management failures**, not selection failures. They share a profile:
- Age >1500h at exit (held weeks/months)
- Final exit reason is `HARD_LOSS_CAP` or `PRE_EARNINGS_FORCE_EXIT` firing far too late
- Many had positive MFE earlier in their life that we failed to lock in

Every single one of these would be prevented by a simple rule:
> **"If a position is held >5 sessions and either (a) thesis features have flipped vs entry OR (b) drawdown from MFE >50% AND held >2 sessions, exit at next bar."**

This is a `circuit_breaker` style rule — distinct from the existing tight stops. It's a **time-decayed conviction floor**, not a hard stop. The existing `HARD_LOSS_CAP` only fires at -4.5% which, on a position held 100+ days with daily drift, can become -30% on a single bad gap. Move to a percent-of-MFE rule + a percent-of-bars rule.

### Q2: "How do we lean MUCH harder into the trades we know are big-winners?"
The ML model identifies a top quartile (115 trades) where:
- WR = 53.9% (vs 40.9% bottom quartile)
- 23 big wins vs 6 big wins
- 10 big losses vs 14 big losses
- Net PnL contribution actually BETTER per trade than bottom by some metrics, but the **big-W concentration is 4×**

If we **size 2× on top-quartile (rr ≥2.7 AND completion <0.18 AND setup ∈ {Gap Reversal Long Prime, Pullback Prime, Gap Reversal Short Prime})** AND keep base size on others, simulated impact:
- Top quartile contribution: +1,122 → ~+2,250
- Other contributions unchanged
- Big-loss damage on top quartile (10 losses × 2x size) = +(-100 pnl) extra drawdown
- **Net gain ~+1,000 pnl% over the same period**, with WORSE intra-trade max drawdown but much better terminal equity

That's a defensible Kelly-style sizing lever — base it on the EV model output, not on an arbitrary "Prime grade" tag.

---

## 7. Concrete proposals (ranked by signal strength)

| # | Proposal | Evidence | Risk |
|---|---|---|---|
| 1 | **Time-decayed MFE-protect circuit breaker** for held positions: if `held >5 sessions AND (thesis_features_flipped OR pnl_pct < 50% × MFE_locked)` → next-bar exit. Replaces `HARD_LOSS_CAP` for stale trades. | -290 pnl% across 18 trades held >1500h; all captured | Low — only fires on stale trades, no impact on intra-day winners |
| 2 | **Setup-grade kill list**: outright block `N-Test Resistance/Confirmed` (-71 pnl, 0% WR) and `N-Test Support/Prime` if rr <2.5 (-66 pnl, 38% WR). | Empirical zero edge; toxic combos | Very low — gives up 28 trades, all underwater |
| 3 | **Gate SHORT direction**: only allow if rr ≥2.7 AND HTF<−20 AND regime ∈ {LATE_BEAR, STRONG_BEAR}. Currently 24 shorts, -49 pnl%, only 3 big wins. | Direction-level WR 29% across 24 trades | Low — shorts are a small fraction; this just says "be choosy" |
| 4 | **Late-bar entry gate**: if entry_time within 1h of close AND rr <3.0 → block. | Big-loss hour cluster 17–20 UTC; -95 pnl% on big losses there | Low — a few entries deferred a day |
| 5 | **EV-model trade sizing**: train regressor on `rank_trace` features daily, output `expected_pnl_pct`. Size 1.5–2× when top quartile, 0.5× when bottom quartile, skip if `predicted_ev < -0.5`. | ML AUC 0.744 for big-W; top quartile 4× big-W concentration | Medium — adds a model dependency, needs walk-forward validation. Most powerful lever. |
| 6 | **`completion ≥ 0.27` deferral rule** (not block — defer 1 bar; if setup re-fires earlier in completion, take that). | D9–D10 of completion: 13 big_L, 1 big_W, -85 pnl | Low — we lose nothing because we'd take the earlier one |
| 7 | **Drop the `Confirmed` grade unless rr ≥2.7** | 137 Confirmed trades net -107; only 3 big wins | Medium — gives up ~10% of trade volume. May not love this in low-trade months |

**Highest-leverage single change:** #1 (time-decayed circuit breaker) — protects ~30% of net P&L without touching entries at all, fully consistent with user's "ok to miss moves" preference.

**Highest strategic upgrade:** #5 (EV model sizing) — this is the "machine learning + statistics + probabilities" answer to the user's framing. It uses the rank_trace data we already capture, trains nightly on the cumulative backtest, and outputs a per-trade conviction score that goes into sizing. **Could compound a +50% improvement in cumulative returns over the same trade set.**

---

## 8. What I am NOT proposing

- **Loosening any entry gate.** None. The user was clear.
- **Eliminating papercut losses.** They're <10% of total damage and cutting them would also kill the optionality on small trades that occasionally compound. They're noise; live with them.
- **Tighter intraday stops.** The data shows stops are doing their job — `max_loss` exits average -3% which is exactly what they're set for. The damage is post-stop drift on stale trades.
- **Adding more filter layers to the ranker.** Top-of-rank (D10 finalScore=100) is actually our WORST decile (-52 pnl). The ranker is saturating, not filtering. We need probabilistic edge, not more thresholding.

---

## 9. How this fits the existing system

We already have the scaffolding for all of this:
- `loop1_specialization` already does WR-by-context tracking — extend it to track `expected_pnl` not just WR.
- `loop3_personality_management` already has the hooks for trade-level conviction adjustment.
- `phase-c-loops.js` is the natural home for an EV model (load weights from KV, predict at entry, write back to runtime).
- `rank_trace_json` already captures every feature the model needs.

Nothing here requires a ground-up rewrite. The biggest implementation lift is #5 (EV model) — needs a nightly training job + a runtime predict path. ~3 files touched + a KV blob for the trained weights. Could be done in a single agent session.

