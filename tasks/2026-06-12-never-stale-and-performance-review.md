# 2026-06-12 — Never-Stale Hardening + 60-Day Performance Review

Operator ask (2026-06-12): (1) the system must never serve a stale score,
price, or candle unless the provider itself is down; (2) review Discovery,
Analysis, backtests, and the last 60 days of Active Trader + Investor
performance and chart the path to the next level — especially Active Trader.

---

## Part 1 — Today's incident chain (what actually broke)

| Time (ET) | Event |
|---|---|
| morning | 10/15/30m candles going STALE mid-session for ~half the universe (PriceStream writes `timed:prices` only, never D1; bar cron half-sliced 10/15/30 as "stream-redundant") |
| ~14:00 | Investor compute excluded **114/255 tickers (45%)** under the Data Age Contract → `investor_compute_stale_candles` tombstone → Investor scoring visibly broken |
| 18:25 | PR #644 merged: full-universe 10/15/30 every */5 tick, live-quote patching of forming bars, heal budget 8→24, hourly RTH catch-up sweep |
| all day | Heal lane wasted slots retrying exempt symbols (ES1!/NQ1!/BTCUSD/… at 20+ futile attempts) ahead of real equities |

PR #644 fixed the *feed cadence*. This PR closes the four remaining
self-heal gaps (below). As of 21:00 UTC: 251/251 fresh, 0 tombstones.
**The RTH proof comes Monday** — watch `/timed/health → freshness` during
the first session.

### The four gaps closed in this PR

1. **Heal-queue exempt leak** (`worker/index.js` scoring cron). Exempt
   symbols (continuous futures, crypto — `FRESHNESS_EXEMPT_TICKERS`) were
   pushed into the heal queue every tick because the queue read
   `_freshness.grade` directly instead of going through the exemption
   helper. With the old budget of 8, ten permanently-stale exempt symbols
   could starve every real equity out of the heal lane — a direct
   contributor to the 45% investor exclusion. Now skipped, and their
   lingering `freshness_quarantine_*` tombstones self-heal.
2. **Degraded-payload bootstrap gate.** A ticker whose score fails to
   assemble only auto-backfilled when it had ZERO candles. A thin new
   listing (SPCX: D bars present, W/M/intraday missing) tombstoned
   `insufficient_candle_data` forever with no heal. Now: any degraded
   maintained ticker gets a full all-TF backfill, rate-limited 1/6h
   (`timed:freshness:bootstrap:*`).
3. **Freshness-monitor universe scope.** `candle_freshness_60` paged for
   NET at 96.5h — a theme-map symbol nobody maintains that landed in
   `ticker_candles` via a one-off backfill. The 9AM/3PM monitor now only
   pages for SECTOR_MAP + user-added symbols, and its auto-heal stops
   spending TwelveData quota on unmaintained symbols.
4. **Investor compute heal-on-detection.** A ≥25% stale exclusion now
   triggers an immediate chunked 10/30/60/D backfill of the excluded
   tickers (20-min lock) so the cron's existing 3× retry finds them FRESH
   instead of just tombstoning. "Heal where detected."

### Known true provider gaps (not bugs)

- **SPCX** has only ~2 daily bars at BOTH TwelveData and Alpaca — genuinely
  thin new listing. It cannot score until enough history accumulates; the
  new bootstrap lane retries cheaply every 6h and it will come online by
  itself. Expect `score_ticker_SPCX` to reappear (rate-limited 1/hr) until then.
- **Futures/crypto** (ES1!, BTCUSD, …) have no live intraday D1 ingest by
  design — exempt from quarantine, used as reference series only.

---

## Part 2 — 60-day performance review

### Active Trader — the headline numbers (2026-04-13 → 06-12)

| Metric | Value |
|---|---|
| Entries / closed / open | 66 / 63 / 3 |
| Win rate (closed) | **31.7%** (20W / 43L) |
| Realized PnL | **-$3,162** |
| Profit factor | **0.28** |
| Avg win / avg loss | +$60.41 / **-$101.63** |
| Open book MTM | **+$3,304** (GS +2.7%, MU +17.2%, SNDK +23.7%) |
| Direction mix | **65 LONG / 1 SHORT** |
| Median hold | winners 72h, losers 24h |
| Entries since June 5 | **ZERO** (5 straight sessions) |

Weekly: W15 +$504 → W19 **-$1,306** (17 trades, 17.6% WR) → W20 -$988 →
W21 -$564 → W22 -$294 → W23 zero trades. The system progressively traded
less and lost less, then went silent.

### Why Active Trader went mute (June 5–12)

Three stacked causes, in order of impact:

1. **Conviction floor is the binding constraint.** Discovery's own
   gameplan: 58.2% of 297 classified misses are `CONVICTION_TOO_LOW`.
   Capture rate over 60d: **4.1%** of 691 ATR-qualified moves (655
   missed, incl. 25 mega ≥15% LONG moves: SOXL +201%, ARM +157%,
   DELL +123%, STRL +110%).
2. **Funnel telemetry confirms it dried upstream**: the cohort-admission
   log's last candidate is June 8 (DIA) — nothing even reached the smart
   gates in the final 4 sessions.
3. **Data quarantine blocked entries June 11–12**: live-STALE freshness
   hard-blocks `qualifiesForEnter`; with ~half the universe intermittently
   stale during RTH, even qualified setups were data-blocked (fixed today).

### Dead-knob finding (code, important)

`worker/pipeline/tt-core-entry.js` clamps every conviction floor to a
hardcoded minimum — config can RAISE floors but can never LOWER them:

```805:808:worker/pipeline/tt-core-entry.js
      const _tierAFloor = Math.max(110, Number(daCfg.deep_audit_focus_tier_a_floor ?? 110));
      const _tierBFloor = Math.max(80, Number(daCfg.deep_audit_focus_tier_b_floor ?? 80));
      const _tierCFloor = Math.max(75, Number(daCfg.deep_audit_focus_tier_c_floor ?? 75));
      let _entryMinConviction = Math.max(75, Number(daCfg.deep_audit_focus_min_entry_conviction ?? 80));
```

Any discovery/COO proposal to relax `deep_audit_focus_min_entry_conviction`
below 75 silently no-ops. The carve-outs (stack ±5, momentum-breakout −10
floor-70) are the only working relaxation paths. If the operator wants the
floor tunable, the clamps must move to a sane lower bound (e.g. 60) — a
deliberate code change, flagged here rather than made unilaterally.

### Live vs validated — the divergence that matters most

| Setup | All-time (calibration, 302/60/47/46 trades) | Last 60d live |
|---|---|---|
| tt_gap_reversal_long | 59.9% WR, PF 3.38 | **25.0% WR, -$1,273** (20 trades) |
| tt_ath_breakout | 45.7% WR, PF 1.05 | 33.3% WR, -$243 (15) |
| tt_n_test_support | 36.7% WR, PF 1.24 | 46.2% WR, -$591 (13) |
| tt_pullback | 48.9% WR, PF 0.96 | 33.3% WR, -$146 (3) |

The flagship setup halved its WR live. Two candidate explanations, both
actionable:

- **Regime mismatch**: 65/66 entries were LONG while the CRO tactical
  overlay turned defensive ("equities face downward pressure", hot themes
  oil/gas/refiners). Meanwhile the two SHORT reversal plays — all-time
  PF 7.3–8.9 — sat **idle** the whole window (gameplan flags this
  explicitly: `idle_while_tactical_live: true`).
- **Loss-side structure**: 5 exit classes produced 71% of gross losses —
  HARD_LOSS_CAP -$1,240 (5 trades, 0 wins), sl_breached -$684,
  doctrine_force_exit -$631 (6 trades, 0 wins), max_loss -$293,
  atr_day_adverse -$254. HIMX sat 453h (19 days) before the "hard loss
  cap" finally fired — that lane is a slow bleeder, not a circuit breaker.

Also: the 2,301-trade cross-run finding "trimmed = the edge" has decayed —
trimmed cohort last 60d is 40% WR and **-$1,260 net**. Trims fire but the
retained runners round-trip.

### Investor — 60-day review

20 open positions, $75.9k cost basis, **-0.67% net** ($-508 MTM). Zero
closed positions. Structure of the book:

- **The June-1 lump**: 11 positions opened in ONE day at the local top of
  the rotation. That batch carries every big loser: AVGO -16.5%,
  FSLR -11.8%, ASTS -20.2%, CLS -14.7%, SATS -8.1% — and also the
  winners CRS +19.2%, IESC +12.7%, WTS +12.0%. Single-day deployment is
  uncompensated timing risk; tranching the same names over 2–3 weeks was
  free risk reduction.
- **Reduce signals ignored**: GOOGL (+19.9%) flagged `reduce` since
  April and IWM (+13.9%) likewise — both still fully held. The stage
  machine produces the right verdicts; nothing executes them.
- **Quality floor on auto-init**: TWLO was auto-initiated at score **50**
  in `watch` stage ("Auto-initiated: watch (score 50)"). Watch-stage
  scores should not deploy capital.
- **DCA off everywhere** (`dca_enabled=0` on all 20) — the down legs
  (FSLR -12%, AVGO -16%) had no accumulation plan despite "accumulate"
  stage labels.
- **Yesterday's outage context**: investor scoring was additionally
  blind for chunks of 06-11/06-12 (the freshness incident), which is why
  it looked dead "until I noticed something."

---

## Part 3 — Next-level plan (ranked)

**R1 — Data plane (this PR + #644).** Entries were data-blocked 2 of the
last 5 sessions. No strategy tuning matters while inputs quarantine
mid-session. Verify Monday during RTH: `curl /timed/health | jq .freshness`
should hold `slo_ok=true` through the session.

**R2 — Run the floor experiment instead of debating the floor.**
The conviction floor is simultaneously (a) the binding constraint at 58.2%
of misses and (b) NOT protecting live WR (31.7% at floor 80). Replay the
last 60d at floors 70/75/80 with current guards (the focused-iter5
equal-scope methodology), pick by PF + max-drawdown, not WR. Pre-req: the
clamp fix above so 70 is even reachable. Expected outcome based on the
miss archetypes: floor stays ~75–80 for chop but the **momentum/volatility
carve-outs widen** (the 25 missed mega movers were trending, high-RVOL
names — exactly what `deep_audit_volatility_expansion_*` and the new
early-momentum qualification target).

**R3 — Fix the loss asymmetry at the entry, not the exit.** At 31.7% WR
the book needs avg-win/avg-loss > 2.2 to break even; it ran 0.59. The
HARD_LOSS_CAP cohort (0 wins, -$1,240) consists of entries that never
worked from bar one. Run the loss-autopsy replay on those 5 + the 6
doctrine_force_exit trades: what did conviction/tier/regime say at entry?
If (as the direction mix suggests) they were late LONGs into a defensive
tape, the cheapest fix is a **CRO-tilt entry gate**: when the tactical
overlay is defensive, require tier-A conviction for LONG entries (knob
exists conceptually via `_theme_tilt`; today it only reorders the funnel).

**R4 — Turn the short book on when the tape says so.** All-time
tt_gap_reversal_short PF 8.86, tt_range_reversal_short idle — while the
window's tactical was defensive, the engine fired 65 LONGs and 1 SHORT.
The SPY-downtrend gate (`deep_audit_short_requires_spy_downtrend`) plus
ticker-bearish-daily requirement is calibrated for crash tape, not
rotation tape. Proposal: allow SHORT in `defensive rotation` tactical
regime when the ticker's SECTOR is one of the flagged-weak themes and the
ticker is below its daily EMA21 — shadow-mode first (log would-be entries
for 2 weeks, then review).

**R5 — Protect runner profits after trim.** Trimmed cohort went from "the
edge" (+$208k across 2,301 archived trades) to -$1,260/60d. The
RUNNER_STALE_FORCE_CLOSE + time-decaying shields exist; what's missing is
a post-trim breakeven ratchet: after TP_HIT_TRIM, SL moves to entry +
fees immediately (not at MFE ≥1%). Cheap config-level change, high PF
impact at current WR.

**R6 — Investor execution discipline.** Four mechanical changes:
(a) max 3 new positions per day (tranche the rest);
(b) execute `reduce` verdicts with an actual 25–33% trim after N sessions
in-stage (CIO lifecycle Phase 1 was already scoped for investor trims);
(c) auto-init floor: accumulate-stage + score ≥65 only (TWLO case);
(d) enable DCA tranches on accumulate-stage positions so down legs buy.

**R7 — Setup-name hygiene.** "TT Tt Gap Reversal Long", "TT Setup", and
null setup_names are still flowing into D1 in the last 60 days — they
fragment loop1/cohort learning (the same setup splits into 3 keys).
The PR #432/#434 write-time fix needs the remaining upstream caller traced
(logs were added; check `_trimSetupNameForDir` swap logs).

**R8 — Make the discovery loop's output binding.** The nightly gameplan
correctly identified everything in this review (capture 4.1%, conviction
binding, idle shorts, mega-miss archetype) — it just has no teeth. Wire
its tier-2 knob proposals into a weekly operator review ritual (15 min:
approve/decline queue + capture trend). The loop is already deduped on
the learning_proposals bus; what's missing is the cadence.

### What was deliberately NOT changed here

No entry gates, floors, or strategy knobs were touched — those are tier-2
decisions for the operator (R2–R6 above give the exact sequence). This PR
is the data plane (Goal 1) + this review (Goal 2).

---

## Part 4 — Signal autopsy + exit-clip quantification (2026-06-12 evening)

Executed per the revised sequence (operator-approved). Data: the 63
closed trades' D1 rows (`rank_trace_json` carries
`focus_conviction_score` for 45 of them) + 16,430 60m candles for the 43
traded tickers, used to compute true MFE/MAE per trade and 5-day
post-exit continuation.

### Finding 1 — the conviction signal does NOT discriminate live

| | n | mean conviction | median |
|---|---|---|---|
| Winners | 13 | 83.7 | 92 |
| Losers | 32 | 84.5 | 84.5 |

- `corr(conviction, win) = -0.02`; `corr(conviction, pnl_pct) = +0.07`.
- The **93+ bucket** (highest conviction, n=19): 31.6% WR, **-$892**.
- Tier C (exploratory wide net, n=16): 25% WR, **-$1,657** — a pure drain.

This is the composite-rank story (Pearson +0.002, V11 forensic)
repeating on rank's replacement. Caveat: n=45 is small — but the shape
(no separation anywhere in the distribution, worst bucket = highest
conviction) means **threshold tuning (old R2) cannot work**. The floor
replay sweep is cancelled in favor of signal repair: the conviction
breakdown's live inputs need re-weighting against live outcomes (note
`sector: no_sector_data` and `spy_baseline_missing` appear in stored
breakdowns — some component signals were running on missing data, which
is itself a freshness-class bug worth fixing first).

### Finding 2 — losses are manufactured by give-back, not bad entries

Across 55 measurable closed trades: **avg MFE +2.38% vs avg realized
-0.69%** — three points of round-trip per trade.

- 14 trades reached **MFE ≥ +2%** … and closed at **avg -0.09%**.
- The HARD_LOSS_CAP cohort averaged **+6.45% MFE** before dying at
  -3.77% (HIMX peaked **+26.85%**, closed -5.84% after 453h). The
  earlier R3 hypothesis ("entries that never worked") is **wrong** —
  these entries worked, then the engine watched the entire gain plus a
  loss evaporate.
- `SMART_RUNNER_SUPPORT_BREAK_CLOUD`: avg MFE **+11.22%**, realized
  +0.45% — the support-break shield gives back ~10.8 points waiting for
  structural confirmation (AA +17.9%→+0.7%, INTC +9.5%→0.0%,
  TSM +9.3%→+0.7%, OKE +8.2%→+0.4%).

**Counterfactual** (conservative: once MFE ≥ 2%, a trail locks 40% of
peak, ignoring nothing else): the same 55 trades go from **-$2,602 to
+$436** (+$3,037), with only 12 trades changed; WR 34.5% → 41.8%. No
entry-side change comes close to this per unit of risk.

### Finding 3 — the fast-cut lanes systematically cut future winners

5-day post-exit continuation in the trade's direction, by exit lane:

| Exit lane | n | avg realized | avg post-5d continuation |
|---|---|---|---|
| atr_week_618_full_exit | 6 | +0.10% | **+8.25%** |
| phase_i_mfe_fast_cut_2h | 3 | -1.09% | **+8.01%** |
| atr_day_adverse_382_cut | 3 | -0.81% | **+7.16%** |
| v13_hard_pnl_floor | 1 | -5.21% | **+12.40%** |
| HARD_LOSS_CAP | 5 | -3.77% | +6.69% |
| doctrine_force_exit | 6 | -1.28% | +3.66% |

The trades were directionally right; the engine's patience was
mis-calibrated in both directions at once — too impatient before the
move (fast-cuts), too patient after the peak (no ratchet).

### Revised priority order (supersedes Part 3 where they conflict)

1. **MFE ratchet — the one change the data demands.** Once a trade's
   MFE crosses ~2%, trail a floor at 40–50% of peak MFE (gap-risk
   accepted), pre-trim AND post-trim, all exit lanes subordinate to it.
   Validate via equal-scope replay; counterfactual above says +$3k/60d
   and +7pts WR. Subsumes old R5 and the HARD_LOSS_CAP fix.
2. **Conviction signal repair, not threshold tuning.** Fix the
   missing-input components first (`no_sector_data`,
   `spy_baseline_missing` in live breakdowns), then re-weight against
   live outcomes. Suspend Tier C entries until the signal discriminates
   (16 trades, -$1,657, 25% WR is paying for exploration that teaches
   nothing while the score is noise).
3. **Fast-cut lane review** with the post-exit table above as the
   indictment: each lane keeps/loosens/loses its trigger based on
   replayed expectancy including the continuation it currently forfeits.
4. Direction/regime orientation + investor mechanics — unchanged from
   Part 3 (R4, R6, R7).

---

## Part 5 — Implementation pass (2026-06-13)

Operator follow-up: "awake our Active Trade Engine and refresh the configs
with the data findings." #648 shipped only priority 1 (the MFE ratchet).
This pass works through the rest of the revised order + the open R-items.
Every change is **config-gated with safe defaults** and registered in
`REPLAY_DA_KEYS` + the HTTP lazy-load list so it hot-reloads and replays.

### Shipped

| Item | Change | Default behavior |
|---|---|---|
| **P1 MFE ratchet** | Already in `main` (#648), on by default | `deep_audit_mfe_ratchet_enabled=true`, activation 2.0%, lock 0.40. **Validation still owed** (see below). |
| **P2c dead-knob** | Floor clamps in BOTH entry paths now use a tunable absolute min `deep_audit_focus_floor_hard_min` (default 60) instead of hardcoded `Math.max(75/80/110)`. Config can finally LOWER a floor. | Floors unchanged (still 80) unless operator lowers them. |
| **P2a Tier-C suspension** | `deep_audit_focus_suspend_tier_c` (default **true**) rejects Tier-C entries (`focus_tier_c_suspended`) in both paths. | Tier-C OFF — stops the 25% WR / -$1,657 drain. Reversible. |
| **P2b conviction inputs** | `_sector`/`_sector_rating` resolved from static `SECTOR_MAP`/`SECTOR_RATINGS` before conviction compute (kills `no_sector_data`); `scoreSector` also reads env-backed `ctx.sectorRating`; sector + RS components stamp `input_missing` so residual gaps are auditable in `rank_trace`. | Sector signal now resolves for every maintained ticker. |
| **P3 fast-cut lanes** | `deep_audit_phase_i_fast_cut_enabled` master kill-switch + tunable Tier-1 age window (`..._tier1_min_age_h`/`_max_age_h`, default 2/4). | Behavior unchanged; lanes now disable-able without a deploy. |
| **R4 short shadow** | `evaluateShortShadow()` logs `[SHORT_SHADOW]` + stamps `d.__short_shadow` when, in a defensive regime, a flagged-weak-sector ticker below daily EMA21 is suppressed by the SPY-downtrend gate. **Observation-only** — never changes the decision. `deep_audit_short_shadow_enabled` (default true). | Shorts still NOT taken; we now collect the 2-week evidence. |
| **R6 investor** | (a) max 3 new positions/ET day (KV counter across cycles); (b) reduce trim after 2 confirmed sessions at 30%; (c) auto-init floor = accumulate stage + score ≥ 65 (kills the TWLO/watch case); (d) DCA enabled on accumulate inits (2% monthly). All via `loadInvestorConfig`. | New discipline ON by default; all reversible. |
| **R7 setup-name** | `d1UpsertTrade` treats `entry_path` as authoritative, heals the `TT Tt` artifact / key-mismatch, and logs `[SETUP_NAME]` with `trade_id`/`ticker`/`entry_path` on every heal + every null/`TT Setup` write so the upstream caller is finally traceable in logs. | Clean `setup_name` to D1; tracing for the remaining source. |

### Owed — requires the replay harness / live data (NOT runnable in CI)

1. **MFE ratchet validation.** Equal-scope replay of the last 60d to confirm
   the +$3,037 / +7pt-WR counterfactual, plus the **Monday RTH proof** that
   the open book (GS/MU/SNDK) does not get force-clipped on deploy. The code
   ships on; this is the confirmation step.
2. **Conviction re-weighting.** P2b fixed the *inputs*; re-weighting the
   component scores against live outcomes (corr currently -0.02) needs the
   closed-trade ledger + a replay sweep. Tier-C stays suspended until the
   re-weighted signal separates winners from losers.
3. **Fast-cut lane final tuning.** The kill-switch + tunable window are in;
   the keep/loosen/kill decision per lane (using the continuation table)
   is a replay-expectancy call.
4. **Short shadow review.** After ~2 weeks of `[SHORT_SHADOW]` logs, review
   would-be-short expectancy before relaxing the live SPY-downtrend gate for
   rotation tape.

### New config keys (defaults preserve or implement the findings)

```
# Entry / conviction
deep_audit_focus_floor_hard_min            60       # absolute clamp (was hardcoded 75/80)
deep_audit_focus_suspend_tier_c            true     # suspend the Tier-C drain
# Exits
deep_audit_phase_i_fast_cut_enabled        true     # master kill-switch
deep_audit_phase_i_fast_cut_tier1_min_age_h 2
deep_audit_phase_i_fast_cut_tier1_max_age_h 4
# Short shadow (log-only)
deep_audit_short_shadow_enabled            true
deep_audit_short_shadow_require_defensive  true
# Investor discipline
deep_audit_investor_max_new_positions_per_day 3
deep_audit_investor_auto_init_require_accumulate true
deep_audit_investor_auto_init_min_score       65
deep_audit_investor_reduce_trim_min_sessions  2
deep_audit_investor_reduce_trim_pct           0.30
deep_audit_investor_auto_dca_on_accumulate    true
```
