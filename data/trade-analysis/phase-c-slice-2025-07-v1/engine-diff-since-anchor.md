# Engine diff since Phase C anchor

| Field | Value |
|---|---|
| Anchor deploy commit | `1d7d8d3` |
| HEAD | `4a8861cb` |
| Generated | 2026-06-28T20:14:02Z |

## Commits touching entry/admission paths

21f6bd73 v12 retry: block index stock paths always + investor month-end close
636f9e63 July v11 + investor day-state seeder (monthly_bundle backfill)
440b066f Wire _earningsClusterWindows onto replay ticker _env (entry gate)
3b2b01df July v7 prep: always merge backdrop earnings clusters, minTickers=3
0104a68a July v6: earnings cluster fallback, doctrine rank fix, AMZN unban
c9b25ece July v5: doctrine defer, high-rank cluster block, index cooldown
60bea999 Fix index model: per-ticker slow-range profiles, stop singles regression
28630797 Index ETF model + July v3 gates (demotion, cluster, capitulation)
87f908c5 fix(setup-mining): write sequence_trail payload on preprod replay
1cb5d087 feat(replay): add sequenceSnapshot=1 candle-replay trail payload mode
cb741854 feat(entry): short-book shadow mode in defensive rotation (Part 3, R4)
9a4ec748 feat(entry): conviction-signal repair + Tier-C suspension + floor dead-knob fix
c6beb767 Capture rate: smart gates + early momentum breakout qualification
5fe81d99 universe(fix): NBIS sector mismatch + ARM/MRVL/SMCI → megacap_tech cohort
af548483 feat(phase4.1): SHORT Option A — setup-driven direction for gap-reversal trigger
643d0e7b feat(trajectory): Phase 4 G1 — pause gap_reversal_long (default OFF)
dfb240d4 calib(p0+p1): May-2026 — megacap unlock, ATH demote, blocklist, doctrine + HLC tightening
d706893b feat(engine): expand continuation_trigger whitelist + aligned-state EQ floor (P0.7.185)
a786c4a6 feat(engine): catch trending mega-cap winners — continuation_trigger PULLBACK extension + gap-reversal anti-falling-knife (P0.7.182 + P0.7.183 + P0.7.184)
b4eb6bee Phase 2.5 — exit-doctrine trendHoldActive short-circuit + tests
0c68d9ca phase-c V15 P0.7.67: TICK/ADD market internals layer + Mar pre-internals baseline
1ac2a67d phase-c V15 P0.7.66: ETF Mastery — Tier 1+2+3 ETF management overhaul
719e19ec phase-c V15 P0.7.65: gave-back doctrine no longer flats winners on noise
f35e9fb4 phase-c V15 P0.7.63: Mar-02 forensics → 3 surgical refinements
6316b42a phase-c V15 P0.7.62: ETF profile + Phase 1 daily-brief fixes + Jan verdict
95b1edfd phase-c V15 P0.7.60: rollback API + fresh-failure / regime-decay doctrine rules
f3cdb1b4 phase-c V15 P0.7.59: Context-aware engine — setup admission + exit doctrine
3940a851 phase-c V15 P0.7.56: anti-chase entry guard + thesis-flip exit
b4fb6242 phase-c: orphan-trade fix + benchmark calibration knobs
8de732e0 phase-c: wire Loop 1 + Loop 2 entry consults into replay path (#66)
55a41a63 Phase C Step 2: replay-candle-batches.js integration
2df930cd Phase C Step 1: entry-selector helper module + tests + counterfactual
f9541299 V15 P0.7.22: capture TD count, PDZ zones, divergence in setup_snapshot
5d1d7bb5 V16 Setups #5 + #2: Gap Reversal + N-Test Support, plus setup-fitness diag
46ee9d63 V16 Setup #1: Range Reversal entry trigger (Ripster Setup #1)
1b496f06 V16 Setup #4 refinement: ETF rvol cohort + follow-through filter
1ff88232 V16 Setup #4: ATH/52w breakout entry trigger (Ripster Setup #4)
b129fa1f V15 P0.7.11: stack-bull conviction carve-out captures LITE-class winners
b7767b54 V15 P0.7.9: restore conviction floor 80 with no-cap mode
f45463b6 V15 P0.7.4: conviction floor 65 -> 70 (PF restored to baseline)

## File stats (1d7d8d3..HEAD)

 worker/phase-c-exit-doctrine.js    |  672 +++++++++++
 worker/phase-c-setup-admission.js  |  382 ++++++
 worker/pipeline/entry-selector.js  |  422 +++++++
 worker/pipeline/index-etf-model.js |  309 +++++
 worker/pipeline/tt-core-entry.js   | 2336 +++++++++++++++++++++++++++++++++++-
 worker/replay-candle-batches.js    |  654 +++++++++-
 6 files changed, 4754 insertions(+), 21 deletions(-)

## Notable path keywords added since anchor (grep HEAD vs anchor)

- `tt_ath_breakout`: anchor=0
0  HEAD=1
- `index_model_stock_path`: anchor=0
0  HEAD=1
- `index_etf_swing`: anchor=0
0  HEAD=15
- `tape_capitulation`: anchor=0
0  HEAD=0
0
- `setup_demotion`: anchor=0
0  HEAD=1

_Re-run: ANCHOR_COMMIT=1d7d8d3 scripts/diff-engine-since-anchor.sh_
