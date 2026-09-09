# Rank driver evaluation — 2026-09-09

**PR:** [#1442](https://github.com/Shashant7/timedtrading/pull/1442).
**Scope:** ranking only. This follows the user's correction: determine whether
each ingredient deserves its points. Correct sorting and aggregate rank
correlation do not answer that question.

Status: implemented and tested on main `88d3398`; not merged or deployed.
Repository default is v1; `deep_audit_rank_formula="v2"` selects the alternate
formula. The production switch and adaptive weights are not visible in the
public exports, so this report does not assume which override is live.

## What changed

### Continued driver review: candidate direction and attribution

The user requested continuation after the first review. GitHub CI on
`3d8f7d6` passed. This iteration retains the ranking-only scope:

- [x] Make state, strength, HMM and TD contributions agree with the actual
      candidate side. Preserve the intentional LTF pullback-depth term only
      within a compatible declared pullback setup; distinguish it in traces.
- [x] Expose individual overlay contributions and cap adjustments at entry.
- [x] Verify actual producer parity, directional perturbations and trace sums.
- [ ] Publish this follow-up in PR #1442 without fitting new weights.

This is a semantic correction pass. Current entry component data remains
unavailable; no additional outcome claim is implied.

The formula contained demonstrable false bonuses, independently of PnL:
missing values looked early, opposing signals earned positive points, duplicate
representations earned multiple bonuses, and EXTREME was mistaken for a
favorable phase change. Those mechanisms are corrected.

The actual v1/v2 implementation now lives in
[`worker/ranking/technical-rank.js`](../worker/ranking/technical-rank.js).
The worker and tests call the same implementation. Signal interpretation lives in
[`rank-drivers.js`](../worker/ranking/rank-drivers.js); this is not a second
approximation of the production formula. New direction metadata in
`detectFlags` preserves the existing flags for other consumers.

Every computed technical score now retains a versioned, score-time component
trace. Entry persistence already copies that trace into `rankTraceJson`.
Diagnostic logging stays sampled. Trigger subparts record direction, applied
points and reasons for neutralizing missing or contradictory evidence. This
makes future component audits possible without recomputing a score after the
entry has acquired a qualification grade.

## Default v1: every contribution

Weights below are the former default values; some are adaptive. “Retained”
means the weight was not retuned, not that predictive value has been proved.

| Driver | Previous rank effect | Finding and action |
| --- | --- | --- |
| Base | +30 | Offset, not a signal. Retained. |
| Data completeness | -10 / -5 / -2 below 70 / 85 / 95 | Data-quality guard. Retained. Presence checks are shallow; empty objects can look complete. This does not establish alpha. |
| Multi-TF EMA structure | -8 to +10 | Aligned/opposed stacks across W/D/4H/1H/30/10. Retained; recompute from current source and candidate side instead of trusting a cached summary. Overlap with state and strength still needs a family ablation. |
| State | aligned +12; pullback +4 | **Follow-up fixed:** award the existing weight only when the state describes the actual candidate side. Derived state is still not independent confirmation; incremental weight value remains unvalidated. |
| HTF strength | up to +10; default thresholds 25/15 | **Follow-up fixed:** opposing magnitude cannot earn supportive strength points. Existing magnitudes apply only in the candidate direction. Trace records aligned/opposed/unknown evidence; exact weights and family overlap remain unvalidated. |
| LTF strength / pullback depth | up to +10; default thresholds 20/12 | **Follow-up fixed:** opposing LTF earns no strength bonus outside a compatible declared pullback setup. Preserve the intentional depth term in that setup and label it as pullback depth, not aligned confirmation. Exact depth weight still requires outcomes. |
| Completion | +15 at <=0.2; +10 at <=0.4; +5 at <=0.6 | **Fixed:** missing/null/blank/invalid is not observed zero. Use valid 0–1 completion, or valid price/trigger/target derivation when absent. Weak-context caps of 9/6 remain. Sizing's helper is unchanged. |
| Phase fraction | +3 at <=0.3; default penalty 30 × excess over 0.5 | **Fixed:** null/blank/invalid no longer earns +3. Require a valid fraction. Overlap with completion/exhaustion remains unvalidated. |
| Squeeze release | summary +2 at 30m, plus direct +6 setup / +2 aligned / -2 other | **Fixed:** one event contribution in the trigger summary, with observed momentum direction. Unknown direction earns zero; opposition gets the existing event weight with negative sign. Duplicate direct bonus retired. |
| Squeeze ON | default +5 | Retained as a compression/readiness hypothesis, only without the 30m release event. Compression alone does not predict trade direction. “21.8% of winners” is not evidence of lift. |
| EMA cross | 1H summary +/-2 plus direct +5; smaller TF weights | **Fixed:** one contribution per event/timeframe. Named and legacy flags resolve to one direction; contradictory directions earn zero. Opposed 1H cross previously could net +3; now -2. Duplicate adaptive `ema_cross_bonus` no longer applies. |
| Buyable dip | summary +/-3 plus direct +7 | **Fixed:** one +/-3 event contribution with known direction. Opposed dip previously could net +4. Legacy directionless flag earns zero. |
| Generic ST flips | +1 at 1H/30m; +0.5 lower TF | **Fixed:** a flip needs direction. Use producer event metadata or Pine-signed ST data; aligned/opposed/unknown are positive/negative/zero. Exact weights remain hypotheses. |
| Lower-TF triggers | squeeze +1 at 10m, +0.5 below; EMA +1 at 10m, +0.5 below | Same direction/deduplication rules. Legacy 5m squeeze fallback now matches its named +0.5 weight. Whole trigger family remains capped at [-6,+12]. |
| Momentum elite | default +15, weak-context cap +6 | **Fixed:** producer used absolute momentum on >=2 frames, including mixed/opposed momentum. Bonus now requires strong frames to agree with the candidate direction. Unknown, mixed and opposed consensus earn zero. Exact bonus size is still unvalidated. |
| Phase-zone change | +2 | **Removed:** producer means “30m or 10m is EXTREME,” not a favorable transition. Keep the original flag for non-rank consumers; trace explains zero. |
| Planned R:R | +4/+7/+10 at 1.2/1.5/2; weak-context +2/+3/+4 | Retained. Planned targets and stops are model outputs, not realized payoff. Needs conditional ablation with observed execution costs. |
| Move status | INVALIDATED -25; COMPLETED -15 | Retained as a suitability guard, not a claim of predictive lift. |
| Weak regime/profile | choppy-selective -8; LATE_BULL -8; EARLY_BEAR -10 | Retained; some penalties stack. Historical associations need regime/time controls and verification that the fields exist before ranking. |
| HTF/LTF disagreement | -5 when opposite and both exceed magnitude 5 | Retained. May partly cancel strength bonuses; evaluate jointly with pullback state, not as isolated additive evidence. |
| Fixed sector prior | materials/metals/energy +3; financials -4; crypto -2 | **Removed:** historical UP proportions were applied to both sides and all periods. Sector/regime-adjusted incremental edge was not established. Gated current-context overlays remain separate. |
| Legacy RSI divergence | bullish +3 to +5 even on shorts; bearish -3 to -1 as strength rises | **Fixed:** sign follows candidate direction; stronger opposing divergence produces a larger penalty. Inactive divergence earns zero. v1 retains its legacy input shape; it does not silently activate multi-TF v2 weights. |
| TD Sequential | producer boost, D/W/M only, unknown TF defaulted to D | **Fixed:** unknown TF is ineligible. **Follow-up:** recompute the same TD recipe from valid per-TF flags/counts for the candidate side, retaining D/W/M weights 1/1.5/2 and the +/-15 aggregate cap. Aggregate-only legacy data needs an explicit matching producer side. The shared producer boost and exit/count fields are preserved. |
| Breakout | daily +20 / ATR +15 / EMA stack +12 / unknown +10 | **Fixed:** only recognized types in `breakout.dir` matching candidate side earn points. Missing/opposed direction and unknown types earn zero. The retained large weights need independent validation. |
| ORB | aligned +10, +5 for 3-window consensus; reclaim -5; day bias +3/-2 | Directional breakout rule retained. **Fixed:** absent day bias no longer accidentally incurs -2. ORB/other breakout/EMA overlap remains unvalidated. |
| HMM multiplier | gated: aligned ×1.05, opposed ×0.93, chop ×0.96 at posterior >=0.6 | **Follow-up fixed:** alignment uses candidate side; confidence must belong to the decoded state, not the maximum probability of another state. Clear obsolete attribution when not applied. Existing multipliers remain unvalidated weights. |

The quoted “Gold Standard” winner percentages in the old trigger comments
lack the required non-winner/non-signal denominator. The inspected
`docs/archive/GOLD_PATTERNS_ANALYSIS.md` covers 15 trades with sparse rank/R:R;
it does not substantiate the advertised trigger percentages. Those comments
were removed from the rank trigger implementation. The separately computed
`gold_score` is not consumed by this rank formula.

## Alternate v2: full inventory and defects

| Driver | Former/default effect | Decision |
| --- | --- | --- |
| Base/state/strength | +30; aligned +12 or setup +6; HTF +3/+6/+10; LTF +5/+8 | Same candidate-side state/strength correction as v1, preserving compatible pullback depth. Existing weights and correlated-input caveat remain. |
| Completeness/move | -10/-5 quality; -25/-15 status | Retained suitability guards. |
| Setup grade | Confirmed +8; Prime +2 | **Retired:** typically assigned after rank and potentially carried from a prior snapshot. It must not feed qualification's result back into its input. |
| RSI divergence | aligned bull +8; aligned bear +5 | Inactive or mixed opposing evidence no longer earns a bonus. Exact side-asymmetric weights remain unvalidated; the historical sample provides no qualifying short-side evidence. |
| Regime | TRENDING +6; TRANSITIONAL -4; CHOPPY -8 | Retained hypothesis. Original code acknowledges post-entry calibration. Serialized `execution_profile_json` is not automatically a live object; field timing/shape must be checked before claiming the term is active. |
| 30m ST alignment | +4 | **Retired:** producer/entry lineage use Pine -1=bull, +1=bear; the formula interpreted it backwards. Correctly decoded alignment underperformed in the old sample. Record corrected direction at zero points, not a newly flipped bonus. |
| R:R | >=7 +12; >=5 +8; >=3 +5; 1.5–3 zero; <1.5 -10 | Retained existing hypothesis. Old selected samples do not validate the large-step thresholds. |
| ATR extension | week >=0.3 aligned -20, else day >=0.3 -10 | Retained; historical unfavorable association supports further study, not precise weights. Unknown candidate side no longer defaults to SHORT. |
| Phase extension | >70 on 1H and D: -8 each; 1H HIGH additional -6 | **Fixed:** extension is signed to trade direction, and the same 1H extension is not penalized twice. HIGH needs a signed value. Live `tf_tech.saty` versus lineage `saty_phase` coverage remains a separate issue; this change does not activate dormant fields wholesale. |
| 30m over-alignment | -4 if signed bias >0.5 | Retained hypothesis; weak live field coverage (`m30` aliases versus actual payload keys). Historical average bias is a different measure from absolute `ltf_score`; do not substitute one for the other. |
| SHORT without SPY downtrend | -8 if fewer than two bearish conditions | **Fixed:** missing macro inputs are unknown, not an observed non-bearish regime. Apply this penalty only with all three inputs observed. |

## Candidate overlays and score caps

Technical rank is still bounded to 0–100 for existing entry gates; raw precision
is retained for ordering. Freshness caps remain authoritative after overlays.

Theme +/-6, fair-value +/-5, harmonic +/-4, combined officer +/-5 and macro
wire +/-4 overlays retain their current gates/weights. They now use the same
candidate side as technical rank, including forming-pair turns against HTF
bias; the old overlay sign used HTF alone. Their predictive value and mutual
overlap have not been established. Individual theme/fair-value/harmonic/officer/macro contributions, shadow values,
and cap/rounding adjustments now reconcile to the final score in the entry
ranking trace. The combined officer score is counted once; its CTO/CRO
subcomponents are not added again. Retiring a fixed sector prior does not validate these
other overlays.

`SCORING_VERSION = 2.1.5-2026-09-09`;
`CANDIDATE_RANK_VERSION = candidate-rank-v3`;
component traces carry `driver_version = rank-drivers-v2`.
Adaptive overrides are parsed into finite numbers before scoring and recorded
in the trace. Numeric strings cannot concatenate into the score; valid zero
is preserved, and invalid overrides fall back to existing defaults.
The scoring-version guard watches the extracted rank/driver modules.

## Follow-up: controlled component examples

These are constructed regression fixtures, not observed trade frequencies or
a PnL simulation. They exercise the actual rank implementation and indicator
producer without fitting new weights.

| Candidate evidence | Before this follow-up | After |
| --- | --- | --- |
| LONG candidate with HTF -25 | HTF +10 | HTF 0, opposed-strength reason |
| LONG with LTF -20 outside a declared pullback | v1 +6 / v2 +8 | LTF 0 |
| LONG with LTF -20 in compatible bullish pullback | v1 +6 / v2 +8 | Preserved, explicitly labeled pullback depth |
| LONG candidate with an old aligned BEAR state | State +12 | State 0 |
| Bullish TD9, produced for LONG, evaluated for SHORT | TD +5 | TD -5; shared producer payload stays +5 |
| Bullish TD prep count 7, evaluated for SHORT | TD +2 | TD 0; a simple sign flip would incorrectly produce -2 |
| LONG turn in an old BEAR pullback state, confident BEAR HMM | ×1.05 | ×0.93 |
| Decoded BULL with probability 0.2, another state at 0.8 | Could qualify for ×1.05 | No multiplier |
| Adaptive early-completion bonus supplied as numeric string | Could concatenate into raw score and saturate rank | Arithmetic numeric addition |

The TD recipe now lives in `worker/td-sequential-boost.js` and is shared
with `computeTDSequential`. Tests compare rank's reconstruction against the
actual multi-TF producer evaluated in both directions across varied candle
series. This preserves the existing producer behavior without confusing its
HTF bias with the candidate's side.

Validation for this follow-up: 3,586 tests / 326 files passed. A subsequent
HMM confidence fixture is included in the final 45 focused tests, which passed.
The first published pass also passed GitHub CI at `3d8f7d6`.
No new outcome data was used and no economic improvement is claimed.

## Entry evidence collected, with limits

Machine-readable results, coverage, side splits, returns, loss rates, medians,
dollar profit factors and matched-cell comparisons are saved in
[`evidence/2026-09-09-rank-driver-audit.json`](evidence/2026-09-09-rank-driver-audit.json).

| Source | Coverage | What it can establish |
| --- | --- | --- |
| Current public `/timed/trades?source=d1`, retrieved Sep 9 | 86 rows, 65 closed with returns; zero entry signal snapshots and zero component traces | Current outcomes are available; component effects cannot be attributed from these rows. The KV view and one detail/evidence lookup also supplied no entry components. This is a filtered book, not the earlier 778-row ledger. |
| Archived v10b final snapshot in repository | 116 rows, 101 closed (July–November 2025); 101 compact snapshots, zero rank component traces | Exploratory associations for stored RSI/ST/ATR/phase/regime/bias fields. Flags, completion, phase fraction, HTF/LTF scores and entry R:R are absent. |
| Older `data/autopsy-current-trades.json` | 190 closed, 184 basic snapshots, ending March 2026 | Filename is not evidence of recency. Basic snapshots lack the richer v1 ingredients, so they were not used to fill missing current inputs. |

Archived input:
`data/trade-analysis/phase-h-v10b-1776787446/final-snapshot/trades-live-premortem.json`.
Canonical JSON SHA-256:
`4b7386b0caf464b7dd62080875bc59c527d0ed2b59acad1f5d98049e14f8cd68`.

These are previously selected, previously examined research trades. Presence
of a snapshot does not prove each field was available before rank; the v2 code
itself acknowledges post-entry calibration. No current quotes, post-entry MFE
or current row-level rank/R:R were substituted as missing entry inputs.
Nearest-trail evidence can lie after entry and is not a valid substitute.

### Historical component comparisons, not weight fitting

Mean returns below are recorded trade percentages. Controls include only
observed non-signal cases; missing data is excluded. Matched cells require at
least three signal and three control observations within the same
direction/setup/entry-month. These are exploratory differences, not causal
estimates or a new holdout.

| Correctly decoded feature | Signal n / mean return | Control n / mean return | Matched cells / mean difference |
| --- | --- | --- | --- |
| Aligned, unopposed RSI divergence | 7 / +1.81% | 84 / -0.06% | 1 / +1.73 percentage points |
| 30m ST aligned (Pine convention) | 16 / -1.30% | 85 / +0.48% | 2 / -0.66 pp |
| Weekly ATR extension in trade direction | 24 / -1.28% | 77 / +0.66% | 2 / -3.01 pp |
| Daily ATR extension in trade direction | 13 / -0.50% | 88 / +0.30% | 1 / -2.24 pp |
| 1H phase >70 in trade direction | 6 / -1.89% | 95 / +0.33% | 0 / not estimable |
| TRENDING regime | 65 / +0.38% | 36 / -0.13% | 4 / +0.61 pp |
| Strong aligned 30m bias | 57 / -0.43% | 44 / +1.01% | 4 / -1.71 pp |

All seven qualifying RSI signals were LONG; this does not validate short RSI
weights. Aligned ST had a 62.5% loss rate versus 38.8% in its control, and
weekly ATR extension 79.2% versus 31.2%. These observations help reject a
misstated rationale and prioritize investigation. They do not justify
optimizing weights on this already-used sample, transferring v2 thresholds
into v1, or claiming current portfolio improvement.

Reproduce without writes to the trading service:

```sh
node scripts/audit-rank-drivers.mjs data/trade-analysis/phase-h-v10b-1776787446/final-snapshot/trades-live-premortem.json > rank-driver-audit.json
```

## Remaining ranking plan for the next agent

1. Obtain a read-only export of immutable entry component traces and entry
   payloads with formula/scoring version, input timestamps, trade side,
   setup, regime and active adaptive weights. The admin trade-autopsy archive
   exposes rank/signal JSON but requires authorized access. Do not use source
   credentials, nearest future snapshots, or current payloads as entry facts.
2. Include eligible-but-unselected/rejected candidates at each decision time.
   A traded-only ledger cannot measure which alternative ranking would have
   selected or how it changes capacity allocation.
3. Freeze a family ablation: (a) state/HTF/LTF/EMA structure and crosses,
   (b) completion/phase/ATR exhaustion, (c) squeeze/momentum, (d) R:R/breakout/
   ORB, (e) regime/context overlays. First remove one family at a time using
   unchanged inputs and recorded exits. Then test incremental terms within
   useful families, conditioning on direction/setup/regime/time. Do not infer
   independent confirmations from several transforms of the same prices.
4. Reserve a fresh, unseen forward window. Require improved net return and
   downside behavior under the same capacity, execution costs, sizing and
   exits, with adequate coverage in both trade directions. Report changes
   to selected names and entries lost at existing rank floors. No weight
   promotion from winner prevalence or this historical table alone.
5. Keep v1/v2 selection and entry thresholds unchanged during review. These
   corrections intentionally lower false scores and may reduce admissions;
   do not “restore” trade volume by lowering rank floors without evidence.

## Verification and completion — first published pass

- [x] Inventory v1/v2 contributions, producer semantics and overlay direction.
- [x] Collect current coverage and historical conditional comparisons.
- [x] Correct false bonuses and retire invalid rationales.
- [x] Save the full evidence table, reusable audit and remaining ranking plan.
- [x] Test the real implementation: 21 new driver tests; 31 focused tests pass.
- [x] Full suite: 3,576 tests across 326 files passed; final focused corrections
      also passed. Syntax, worker bundle, version guard and diff checks passed.
- [x] Update PR #1442 with this report and verified implementation
      (`d772536`; the published Git tree matches the verified local tree).

The existing bundle warning about duplicate `KWEB` is unchanged. No trading
service writes, deployment, merge, sizing change or exit change was performed.
The deliverable improves score validity and auditability; current PnL uplift
has not been demonstrated.
