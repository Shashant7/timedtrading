# 2026-05-23 — Progress recap + Phase 6 / Markov / HMM status

> **STATUS REFRESH 2026-05-26 (after PRs #277–#284).** Major changes
> since this doc was written:
>
> - **Markov / HMM is FULLY LIVE in production**. All three KV keys are
>   populated (`timed:regime:matrix:global`, `timed:regime:hmm:model:v1`,
>   `timed:regime:hmm:latest`). The cron-based bootstrap from PR #279
>   worked — the fetch-handler waitUntil was the wrong context for the
>   long compute. Latest decoded state is `BULL_TREND` (posterior 1.0)
>   with all 5 emission features populated.
> - **trail_5m_facts aggregation is now via the per-ticker light path**
>   (PR #277). The heavy correlated-subquery `INSERT` that silently
>   CPU-timed-out for weeks is disabled behind a flag.
> - **MU stale-price exit incident (2026-05-26)**: closed at $751 vs.
>   market $785+ in pre-market. Two PRs landed:
>     - **PR #283** — OOH POSITION RECONCILE freshness guard. Refetches
>       any quote older than 5 min and uses it; defers if no fresh
>       quote available. Daily Brief stale-price gate broadened to also
>       fire when price-feed is fresher than scoring payload.
>     - **PR #284** — Smart SL: lock-in floor (≥1.5% PnL for breakeven,
>       ≥2.5% PnL for breakeven+) + EXT-hours wick guard (1.0% cushion
>       on top of existing HTF/favorable cushions in pre/post-market).
> - **Portfolio metrics fixes** (PRs #280–#282) closed the headline /
>   Performance Overview mismatch and the investor equity-curve cliff.
> - **Pending list (§5) updated below** — bootstrap + investigate items
>   are struck through; remaining work is HMM→engine wiring, observability,
>   Phase 6 cell-Markov G3 gate, plus the new "raise wick cushion to
>   profile-driven if needed" follow-up from the MU incident.

> **STATUS REFRESH 2026-05-26 evening (PRs #285–#287).**
>
> - **PR #285** — HMM→engine wiring (4 follow-ups in one PR): latent_regime
>   on trade record + CHOP floor 0.35 + macro-regime-flip DEFEND + sizing
>   confidence guard. Closes recap §4 follow-ups #3, #4, #5, #6.
> - **PR #286** — POST /timed/user-tickers observability: structured logs,
>   KV ring buffer (50 attempts), new admin endpoint
>   `GET /timed/admin/user-tickers/recent-attempts`. Closes first bullet
>   of "Other open follow-ups".
> - **PR #287** — Event-risk fixes:
>     a) Macro events now block ENTRIES inside the 6h reduction window
>        (was earnings-only — TLN entered 12:28 PM, trimmed 12:29 PM
>        for PRE_PCE_RISK_REDUCTION on 2026-05-26).
>     b) Event-risk dedup now uses event-identity key (drops trim% from
>        the key). UNP and PCI both fired back-to-back PRE_PCE trim +
>        close on 2026-05-26 9:31 AM ET because the trim% changing
>        between ticks built a fresh dedup key and bypassed the guard.
> - **MU recovery (data fix, no code)** — the stale-price exit from
>   PR #283 was reversed via direct D1 updates: status OPEN, SL reset
>   to original $659.51, trim% / cost basis restored, audit row written
>   to execution_actions, KV `timed:trades:all` updated. Smart-SL from
>   PR #284 prevents recurrence in the same shape.
>
> The lower body below remains the snapshot-in-time for the 2026-05-23
> investigation. Read §5 last for current pending work.

This is the single document that captures: (1) everything shipped over the
recent arc, (2) where the Phase 6 stochastic-methods program stands today,
and (3) the full state of the additive Hidden Markov framework (Phases A/B/C).

It's written so a new contributor — or future-you — can land here and know
exactly what's live, what's flagged-off, what's planned-but-not-built, and
what needs an operator action.

---

## 1. Snapshot — what's live as of 2026-05-23

| System | State |
|---|---|
| Worker auto-deploy on every `main` push | ✅ green for PRs #270–#275 |
| Cloudflare Pages auto-deploy (cache-bust marker fix from PR #269) | ✅ healthy |
| `check-dist.yml` CI workflow | ✅ unbroken by PR #274 (was false-positive failing) |
| Daily Brief (morning + evening) | ✅ sending; observability snapshot per send |
| Trade alert emails — entry / trim / exit | ✅ all three types after PR #271 throttle fix |
| Twelve Data → Alpaca fallback for stale tickers | ✅ live after PR #272 |
| Admin "add to core universe" flow | ✅ live after PR #273 |
| Deep-link `/?ticker=IBM` → right rail | ✅ live after PR #275 |
| Stop-loss leak (P0 from May 19) | ✅ closed; spurious "Hit the stop loss" labels also closed in PR #270 |
| Markov universe-wide P-matrix (Phase A, PR #257) | 🟡 code shipped, **no KV output yet — cron has not produced** |
| Markov behavioral policies (Phase B, PR #258/#260) | 🟡 code shipped, **feature flags OFF in production** |
| HMM latent-regime decode (Phase C, PR #259/#260) | 🟡 code shipped, **never trained — first weekly train fires Sun 2026-05-24 05:00 UTC** |
| Markov UI panels (Today + Right Rail, PR #261) | ✅ shipped (renders only if data is present) |
| Phase 6 cell-Markov G3 admission gate | ⏸ not built — entry criteria from 2026-05-19 doc not met yet |

The Markov/HMM rows above are the meat of §4 and §5 below.

---

## 2. Recent PR arc (chronological, with one-line intent)

Numbers in brackets are the merged PR id.

### CI / deploy infrastructure
- **#196–#199** — Worker deploy workflow fixed (Node 22, `npm install`, `embed-dashboard`, `wrangler-action` arg quoting, path-filter expansion).
- **#247** — Added `.github/workflows/check-dist.yml` to prevent stale Pages builds (later partially broken by #269 then re-fixed by #274).
- **#268** — Stable `.compiled.js` asset names (removed the per-build content-hash suffix in build script).
- **#269** — Permanent per-build cache-bust marker baked into every emitted asset to defeat the Cloudflare Pages CAS-corruption failure mode.
- **#274** — `check-dist.yml` updated to ignore cache-bust marker lines via `git diff -I`.

### P0 stop-loss + execution correctness
- **#217–#221, #223–#229, #231** — Multi-layer SL-leak fix (regex gap, safety-net override, defer-flag clearing, ZOMBIE FIX TDZ, `trimmedPct` double-discount, OOH reconcile bypassing operating-hours gate).
- **#222, #230** — Wrap-up + audit-summary docs for the SL incident.
- **#232** — Trim-at-entry leak: 1.5% PnL floor mirrored across `tt-core-exit.js` / `ripster-exit.js`; ATR ladder anchored to entry instead of prev close.
- **#270** — Spurious `sl_breached` labels and 3-minute exits at small profit fixed (direction-sanity guard in `computeMoveStatus` + waterfall SL resolver in `classifyKanbanStage`).

### CPU performance
- **#233** — Bumped `cpu_ms` for cron in `worker/wrangler.toml`.
- **#234** — Deferred non-critical work to `ctx.waitUntil`; gated OOH RECONCILE and KANBAN CRON.
- **#235** — `_cachedAllTradesForTick` for the */5 cron.
- **#236** — Throttled D1 `ticker_latest` batch sync from 5-min to 15-min; moved TD bar fetch into `waitUntil`.

### Today / Active Trader / Investor / Right Rail UX
- **#200, #201, #202, #219** — Pre-market + EXT prices, brief truncation, unified language, activity strip + bottom-nav badges.
- **#237, #238, #239, #251** — Activity strip across AT/Investor pages, iOS sticky fix, newest-first.
- **#240, #243, #244, #245** — Mobile bias chip, FocusRail mobile layout, Chart view (SL/Current/TP only), MarketPulse above FocusRail.
- **#241, #242** — INTU earnings + EPS estimate display + table overflow.
- **#246** — TD Sequential counts to match TradingView (21-EMA filter + `tv_count` fields).
- **#248** — Bias mismatch fix via `inferModelDirection` helper.
- **#253, #266** — Global ticker search with deep-link `?ticker=`; FocusRail bias-on-left; user-ticker add/remove via search.
- **#261** — Markov UI panels (`MARKET REGIME` pill on Today + Regime Forecast panel in Right Rail Technicals).

### Markov / HMM (full detail in §4)
- **#212** — Phase 6 prep: cell-Markov outcome-split (read-only) module.
- **#257** — Phase A: universe-wide transition matrix + n-step forecast + sanity checks.
- **#258** — Phase B: adaptive chop haircut + position-sizing favor multiplier + dwell-exhaustion.
- **#259** — Phase C: HMM (Baum-Welch + Viterbi) + AI CIO memory integration.
- **#260** — Recovery of orphaned #258/#259 commits onto `main`.
- **#261** — Right Rail + Today UI surfaces for `regime_forecast` and `latent_regime`.
- **#263** — Hotfix `*/5` inside JSDoc breaking esbuild in `regime-markov-compute.js`.

### Data / D1
- **#207** — Trail-facts aggregation hotfix (`worker/lib/trail-facts-light.js` for per-ticker D1-friendly aggregation).
- **#214** — `_deepAuditConfig` lazy-load now includes `"gates"` (was silently disabling Phase 4 G1/G2 on HTTP/queue invocations).
- **#249** — Case-sensitive `existingByTicker` map fix in `/timed/investor/auto-rebalance`.
- **#254** — Added CF, NOW, PM to `SECTOR_MAP`.
- **#255** — D1 cost optimization: write-elision via fingerprint caches; 15-min cadence; `D1_RETENTION_POLICY.md`.
- **#265** — GOLD removed from `SKIP_TICKERS`; DELL added to `SECTOR_MAP`.
- **#272** — Alpaca fallback for `fetchBars` / `fetchAllBars` / `fetchLatestQuotes` whenever Twelve Data returns nothing; IBM added to `SECTOR_MAP`.
- **#273** — Admin endpoints to add/remove tickers to the runtime universe overlay (KV-backed); new `CoreUniverseManager` UI.

### Email + Stripe
- **#250** — Email system audit: Stripe webhook downgrade keys fixed; `shouldDispatchTradeAlertEmail` allows both modes; weekly retro subject; per-send KV observability snapshot; `/timed/admin/email-diagnostic` + `/timed/admin/sendgrid-health` probes.
- **#252** — SendGrid 401 propagation into failure snapshots.
- **#256** — Daily Brief email logo + nav links → `/today.html`.
- **#262, #264, #265** — Daily Brief readability: minimum SPY/QQQ/IWM target distance, news headlines from Finnhub, Discord embed parity with email.
- **#271** — Trade alert email throttle scoped per event type (Entry 1h, Trim 5m, Exit 0).

### Deep links / Pages
- **#267** — Renamed `tt-global-search.js` to `-v2.js` to bypass a Pages CAS issue (later reverted in #268 after stable-name strategy).
- **#275** — Root redirect `/?ticker=IBM` preserves `url.search + url.hash` through to `/today.html`; unauthed deep-link visits forwarded through CF Access so they land on the correct deep-linked URL.

---

## 3. Repo map for the stochastic work

```
worker/lib/
  trajectory-cells.js              # S0 — 640-cell discretization
  trade-trajectories.js            # S1.5/S2 — historical backfill + cohort lookup
  admission-cohort-log.js          # Phase 4 — D1 write of every admission decision
  trigger-hitrate.js               # Phase 2 — ST flip / EMA cross / squeeze hit rates
  stage-markov.js                  # Phase 2 — kanban stage transition matrix
  random-walk-null.js              # Phase 3 — Wiener-style null hypothesis
  cell-markov.js                   # Phase 6 prep — outcome-split divergence (NOT live)
  trail-facts-light.js             # CPU-budget-safe per-ticker aggregator

  regime-markov.js                 # Phase A — transition-matrix math primitives
  regime-markov-compute.js         # Phase A — daily compute + persist to KV
  regime-markov-policy.js          # Phase B — 3 pure policies (chop, favor, dwell)
  regime-hmm.js                    # Phase C — pure HMM (Baum-Welch, Viterbi, log-pdf)
  regime-hmm-features.js           # Phase C — daily emission vector builder
  regime-hmm-compute.js            # Phase C — train (weekly) + decode (daily)

worker/migrations/
  add-trade-trajectories-table.sql
  add-trail-5m-fact-table.sql
  add-admission-cohort-log-table.sql

worker/pipeline/
  tt-core-entry.js                 # G1 + G2 admission gates + SHORT Option A
  sizing.js                        # gatherSizingMultipliers — folds __chop_size_mult
                                   #                          + __regime_favor_mult

worker/index.js                    # ROUTES allowlist, runDataLifecycle, scheduled()
worker/cio/cio-memory.js           # buildCIOMemory + latent_regime field

tasks/2026-05-18-stochastic-research-program.md      # Original spec (§S0..§S6)
tasks/2026-05-18-chop-regime-defense-diagnostic.md   # Phase 5 R3 motivation
tasks/2026-05-19-short-side-blackout-diagnostic.md   # SHORT Option A motivation
tasks/2026-05-19-stochastic-program-phase-wrapup.md  # Phase 1-5 wrap-up + Phase 6 entry criteria
docs/2026-05-23-progress-recap.md                    # (this doc)
```

---

## 4. Markov framework — full status

The stochastic program has **two distinct Markov tracks** that landed in the
same arc but were planned independently:

- **Phase 6 (cell-Markov)** — outcome-split transitions on the bubble-map 640-cell
  state space, intended to power a G3 admission gate ("the cell sequence this
  candidate is on is more often a LOSS than a WIN"). **Code: read-only diagnostic
  only.** Not live; not even close — see entry criteria below.
- **Universe-wide regime Markov (Phases A/B/C)** — single SPY-level state space
  with `HTF_{BULL,BEAR}_LTF_{BULL,BEAR,PULLBACK}` + `CHOPPY` states. Drives
  three behavioral knobs (chop haircut, position sizing favor multiplier,
  dwell-exhaustion gate) and feeds an HMM for a latent macro regime.
  **Code: all shipped.** Feature flags: off. KV output: missing (see §4.2).

### 4.1 Phase 6 (cell-Markov) — what's pending

From `tasks/2026-05-19-stochastic-program-phase-wrapup.md` §6, none of the
entry criteria are met yet:

**Data prerequisites** — not yet measured against current data:
- [ ] `trade_trajectories` backfill coverage ≥ 90% of historical trades with ≥ 1 cell.
- [ ] `cell_markov` outcome-split matrix has ≥ 50 trades per cell for at least the top 30 cells.
- [ ] KL-divergence > 0.3 or χ² p < 0.05 between WIN and LOSS next-state distributions for ≥ 10 cells.

**Engine prerequisites** — partially met:
- [x] Phase 4 G2 cohort-fail block has been live in `gates.cohort_fail_block: true` since PR #210.
- [x] SL leak fully diagnosed and closed (#217–#221, #231, #270).
- [ ] Manual spot-check that G2 hasn't false-positive-rejected high-quality setups across ≥ 5 trading days.

**Behavioral prerequisites** — not yet measured:
- [ ] Phase 4 + Phase 5 R3 combined effect shows ≥ 30% reduction in chop-regime give-back R.
- [ ] Random-walk null confirms cohort edge > 2σ above shuffled baseline.

**Rollout if criteria met**: shadow mode first (≥ 5 days), then live with a
single `gates.cell_markov_divergence_enabled` flag in `model_config`.

The diagnostic endpoint `GET /timed/calibration/cell-markov` exists; results are
read-only.

### 4.2 Universe-wide regime Markov + HMM — what's pending

Three modules + one cron + one read path, all wired but **no KV output exists**.
Verified live this morning:

```
HTTP 404  timed:regime:matrix:global      (Phase A — daily, runDataLifecycle step 8)
HTTP 404  timed:regime:hmm:model:v1       (Phase C — weekly, scheduled() Sun 05:00 UTC)
HTTP 404  timed:regime:hmm:latest         (Phase C — daily,  runDataLifecycle step 9)
```

`runDataLifecycle` runs daily at `0 4 * * *` UTC. PRs #257/#258/#259/#260 all
merged 2026-05-22, so the 2026-05-23 04:00 UTC lifecycle pass should have written
the Markov P-matrix. It didn't. Two probable causes (need a log tail to confirm):

1. **`computeAndPersistRegimeMatrix` is silently no-op'ing** because the
   `trail_5m_facts` aggregation hasn't caught up to 90 days of universe-wide
   coverage post-PR #255 (retention policy added; 365d cap on
   `admission_cohort_log`, `trail_5m_facts`). The compute call requires
   `minObs: 20` per cell — if rows are thin, `summary` will return without
   a write.
2. **The 04:00 UTC cron didn't fire today** for some reason (Cloudflare cron
   reliability issues). The simplest probe is `POST /timed/admin/regime-transitions/rebuild`
   which triggers `computeAndPersistRegimeMatrix` synchronously and returns a
   detailed result; same for `POST /timed/admin/regime-hmm/train` and
   `POST /timed/admin/regime-hmm/decode`.

The HMM model is expected to be 404 until **Sunday 2026-05-24 05:00 UTC** —
that's the first weekly train pass after the #259 deploy. After it fits and
persists, the daily decode in `runDataLifecycle` will start populating
`timed:regime:hmm:latest`.

**Pending operator actions to unblock:**

1. Run `POST /timed/admin/regime-transitions/rebuild` (admin) and inspect the
   response. Expected `total_transitions` > 1000; if `cells_below_min` is
   high, increase the `windowDays` from 90 → 180 in the runDataLifecycle
   call site (`worker/index.js:27296`).
2. Run `POST /timed/admin/regime-hmm/train?window_days=365&num_starts=6` to
   bootstrap the HMM before the Sunday cron.
3. Once both KV keys are populated, run `POST /timed/admin/regime-hmm/decode`
   to seed `timed:regime:hmm:latest`.
4. Verify the UI: open Today and look for the `MARKET REGIME · …` pill above
   Market Pulse; open the Right Rail for any ticker and look for the
   "Regime Forecast" panel under TD Sequential in the Technicals tab.

**Feature-flag state in production `model_config.gates`:**

```jsonc
{
  "pause_gap_reversal_long": true,        // Phase 4 G1 — LIVE
  "cohort_fail_block": true,              // Phase 4 G2 — LIVE
  "cohort_min_n": 15,
  "cohort_wr_floor": 0.4,
  "cohort_pf_floor": 1,
  "short_direction_setup_driven": true,
  "chop_size_haircut_enabled": true,      // Phase 5 R3 — LIVE
  "chop_size_haircut_factor": 0.5
  // Below are wired but NOT set yet — defaults are off:
  // "markov_chop_haircut_adaptive": false,
  // "markov_position_sizing_enabled": false,
  // "cell_markov_divergence_enabled": false
}
```

The Phase B refinements (chop adaptive, position sizing) will not affect a
single trade until the operator sets them to `true`. **And they will no-op
silently even when enabled until the Phase A KV matrix exists.**

### 4.3 Hidden Markov Model (Phase C) — focused walkthrough

Per the user's explicit ask, here's the full HMM detail in one place.

**Math (`worker/lib/regime-hmm.js`):** pure Gaussian-emission HMM with
log-domain `forwardBackward`, `viterbi`, `baumWelch` with multi-start
initialization (default 5 starts, picks the highest log-likelihood),
`logMultivariateGaussianPDF`, `serializeHMM` / `deserializeHMM` for KV.

**Features (`worker/lib/regime-hmm-features.js`):** daily emission vectors built
from SPY 1-day return, VIXY change, breadth (% of universe above 50-EMA), and
sector dispersion. `HMM_D` is the emission dimensionality; `HMM_FEATURE_NAMES`
documents the slot order. `buildEmissionSeries(env, opts)` returns
`{ observations: [[…], […], …], dates: […], skipped: 0 }` over the requested
window.

**Compute (`worker/lib/regime-hmm-compute.js`):** two entry points.
- `trainAndPersistHMM(env, opts)` — fits `K=3` states with `numStarts=6`, max
  iter 150, tolerance 1e-4 (defaults). Persists serialized model + labels
  (`BULL_TREND` / `CHOP` / `BEAR_TREND`, assigned by sorting state means on the
  SPY-1d-return feature so labels are stable across retrains). KV TTL 60d.
- `decodeAndPersistLatentRegime(env)` — loads the model, builds the most
  recent emission point, runs `viterbi` to recover the most-likely state
  sequence, persists the **last** state + posterior to KV. KV TTL 14d.
  No-ops with `{ error: "no_model" }` if the model hasn't been trained yet.

**Cron schedule:**
- Weekly train: `scheduled()` handler reads cron tags via `vc.has(...)`;
  Sundays 05:00 UTC triggers `trainAndPersistHMM(env, { windowDays: 365, numStarts: 6 })`.
- Daily decode: `runDataLifecycle` step 9 calls `decodeAndPersistLatentRegime(env)`
  after the Markov matrix rebuild.

**Per-isolate cache:** `_cachedLatent` keyed against `_cachedAt`,
`CACHE_TTL_MS = 5 * 60 * 1000` so scoring paths can attach `latent_regime`
without per-tick KV round-trips.

**Read path:**
- `worker/index.js:15860–15872` — `buildCIOMemory` enriches the memory blob
  with `latent_regime { state, posterior, decoded_at }` so every CIO evaluation
  has the macro context. Prompt template is unchanged; CIO sees it via the
  memory object.
- `worker/index.js:21220–21942` — `_markovFavorPlan` computed upstream of
  sizing; `__regime_favor_mult` stamped on tickerData when
  `gates.markov_position_sizing_enabled === true`.
- Right Rail Technicals (`react-app/shared-right-rail.js:5674+`) — renders
  `regime_forecast.p_next`, `latent_regime.state`, and the
  `_regime_run_length` / `regime_exhausted` advisory chips.
- Today (`react-app/today.html:1538+`) — "MARKET REGIME · BULL_TREND" pill
  above Market Pulse.

**Admin endpoints:**
- `GET  /timed/admin/regime-transitions` — current P-matrix summary.
- `POST /timed/admin/regime-transitions/rebuild` — force a synchronous compute.
- `GET  /timed/admin/regime-hmm` — current model + last decoded state.
- `POST /timed/admin/regime-hmm/train?window_days=365&num_starts=6` — force a
  retrain (the same call the Sunday cron makes).
- `POST /timed/admin/regime-hmm/decode` — force a decode pass.

**HMM-specific open follow-ups:**

1. **Bootstrap the model** before Sunday's first scheduled train (see §4.2 step 2).
2. **Validate the K=3 labelling** on the first trained model — if SPY 1-day
   return doesn't cleanly separate states, swap the label feature for VIXY
   change (more direction-agnostic and stronger separator empirically).
3. **Promote the posterior to the trade record** — currently `latent_regime`
   only flows into `tickerData` + CIO memory. Once the model is trained,
   stamp the entry-time `latent_regime.state` onto the open trade in D1 so
   we can attribute outcome by macro regime in `trade-autopsy.html`.
4. **Wire the posterior into Phase 5 R3** — if `latent_regime.state === "CHOP"`
   AND `chop_size_haircut_enabled === true`, harden the haircut floor to
   `0.35` instead of the default `0.5`. This is a 1-line change in
   `worker/pipeline/sizing.js` once the latent state is reliably populated.
5. **HMM-driven exit override** — when `latent_regime` flips from `BULL_TREND`
   to `BEAR_TREND` (or vice versa) and an open position is in the wrong
   direction, force a `defend` stage classification. Code path exists for
   `bias_flip_full_*_vs_*` exits; this would add a macro-regime variant.
6. **Decode confidence guard** — `regime_forecast.confidence` is computed
   but not yet thresholded. If `confidence < 0.6`, suppress the
   `MARKET REGIME` pill and skip the Phase B favor multiplier (default to 1.0).

---

## 5. Concrete pending items — single checklist

This consolidates every open follow-up across the arc. Items are written in
the form an operator or contributor can pick up directly.

### Phase 6 (cell-Markov G3 gate)

- [ ] Measure `trade_trajectories` backfill coverage vs. historical trades; backfill the gap if < 90%.
- [ ] Confirm ≥ 30 cells have ≥ 50 trades each in `cell_markov`.
- [ ] Compute KL-divergence or χ² test on WIN vs. LOSS next-state distributions; flag the cells where it's significant.
- [ ] Spot-check `admission_cohort_log` over ≥ 5 trading days for Phase 4 G2 false-positives.
- [ ] Run `GET /timed/calibration/random-walk-null` and confirm cohort edge > 2σ.
- [ ] Build shadow-mode G3 evaluator (writes to `admission_cohort_log` with `mode='shadow'`).
- [ ] Add `gates.cell_markov_divergence_enabled` flag to `model_config` (default `false`).
- [ ] One-week shadow → live flip → one-week watch.

### Universe Markov + HMM (Phases A/B/C) — 2026-05-26 status

- [x] ~~**Bootstrap**: matrix~~ → live (PR #279 cron-based bootstrap fixed the waitUntil time-budget issue from PR #277).
- [x] ~~**Bootstrap**: HMM model~~ → live (`logLikelihood ≈ 2657`, sequence_length 110).
- [x] ~~**Bootstrap**: HMM decode~~ → live (`state=BULL_TREND`, posterior 1.0, 5 features populated).
- [x] ~~**Verify UI**~~ → KV populated; pill + panel render whenever the consumer queries.
- [x] ~~**Investigate** runDataLifecycle missed write~~ → root cause was the heavy correlated-subquery trail_5m_facts INSERT silently CPU-timing-out + the waitUntil context being wrong for the compute. PR #277 fixed the aggregation; PR #279 moved bootstrap to */5 cron context.
- [ ] **Tune** `windowDays` (currently 90) — bump to 180 if `cells_below_min` is high. (Wait for one full week of live observation before deciding.)
- [ ] **Enable** `gates.markov_chop_haircut_adaptive` — code path live, default-off in `model_config`. Operator action: flip via admin once a chop regime appears in live decodes.
- [ ] **Enable** `gates.markov_position_sizing_enabled` — same shape; needs ≥ 5 trading days of `_markovFavorPlan` `meta` audit rows in `admission_cohort_log` before flipping.
- [ ] **Validate** K=3 HMM labelling — first decode shows breadth_pct = 0.25 (only 25% of universe bullish) yet `BULL_TREND` label was assigned. If observed regime label keeps disagreeing with breadth/VIX intuition for >2 weeks, swap label feature from SPY 1-day return → VIXY change (more direction-agnostic separator).
- [x] ~~**Promote** entry-time `latent_regime.state` onto open trade D1 row~~ → PR #286.
- [x] ~~**Wire** latent state into Phase 5 R3 chop haircut floor~~ → PR #286.
- [x] ~~**Wire** macro-regime-flip-vs-position into bias_flip exit family~~ → PR #286.
- [x] ~~**Gate** `regime_forecast.confidence < 0.6` to skip favor multiplier~~ → PR #286 (sizing path). UI suppression at low confidence still pending.

### Other open follow-ups from the arc — 2026-05-26 status

- [ ] Add server-side observability around `POST /timed/user-tickers` so silent frontend failures become visible (mentioned in the IBM-add diagnosis).
- [ ] Promote `[SL_SANITY_SKIP]` / `[MOVE_STATUS_SL_SKIP]` + the new `[EXT WICK GUARD]` (PR #284) + `[HTF GUARD]` log frequencies into a small metrics endpoint so we can see how often each guard is catching real edge cases.
- [ ] Investigate chronic Twelve Data dropouts surfaced by `[PROVIDER_FALLBACK]` logs (PR #272) — chronic offenders may want Alpaca-primary instead of fallback.
- [ ] Build an admin endpoint to flush the Cloudflare Pages content-addressed cache (preempting the failure mode the cache-bust marker now defends against).
- [ ] Adaptive scoring follow-up was deferred when we wrapped the CPU optimizations (#234); pick this back up when the Markov framework is producing (it is now — could revisit).
- [ ] **NEW (MU follow-up)**: surface per-trade pre-market wick events in `admission_cohort_log` so we can measure how often `[EXT WICK GUARD]` saves us vs. PR #284's 1.0% cushion being too tight in any regime.
- [ ] **NEW (MU follow-up)**: the trailing-SL ATR multiplier `_tsm.preTrim` could be widened in EXT hours too — `[TRAILING SL]` log lines from EXT cron ticks should be auditable to see if any current SL placements are being driven by EXT-only price action.

### Newly-shipped since 2026-05-23 — completed PRs

| PR | Subject | Status |
|---|---|---|
| #277 | self-heal Markov/HMM bootstrap + light trail aggregation | ✅ |
| #278 | bootstrap retry-on-failure + diagnostic logs | ✅ |
| #279 | bootstrap from */5 cron instead of fetch waitUntil | ✅ |
| #280 | Portfolio Performance Overview metrics mismatch | ✅ |
| #281 | rebuild react-app-dist after #280 | ✅ |
| #282 | Portfolio ~588 closed count + investor equity cliff | ✅ |
| #283 | stale pre-market price → bogus MU SL exit + Daily Brief levels | ✅ |
| #284 | SL lock-in floor + EXT-hours wick guard | ✅ |
| #286 | HMM→engine wiring: latent_regime onto trade record + chop floor + macro-flip exit + confidence guard | this session |

---

## 6. Worth knowing — non-obvious design choices

- **`SECTOR_MAP` overlay is a soft union, not a hardcode-replacement.** `worker/sector-mapping.js` is still the floor; PR #273's overlay adds on top via `timed:tickers` + `timed:sector_map:{T}` and a per-isolate periodic refresh keyed on `timed:universe:version`. Removals of canonical tickers go through `timed:removed` blocklist (already supported by `loadSectorMappingsFromKV`) so they survive cold-start without a code change.
- **Alpaca fallback (PR #272) is transparent.** Callers of `fetchBars` / `fetchAllBars` / `fetchLatestQuotes` in `worker/data-provider.js` see the same return shape; the fallback only activates when Twelve Data returns zero data for a symbol. Each heal is logged with `[PROVIDER_FALLBACK]` for observability.
- **Cache-bust marker (PR #269) guarantees content-hash uniqueness.** Every build produces a per-run `cache-bust:<ms>:<rand>` marker appended to every dist file so Pages can never serve from a corrupted CAS entry (the 2026-05-22 outage). CI's `check-dist` workflow (PR #274) ignores those lines via `git diff -I`.
- **Phase B policies are pure functions** (`worker/lib/regime-markov-policy.js`). They have no side effects, no async, and all multipliers are clamped (`REGIME_FAVOR_MIN=0.5`, `REGIME_FAVOR_MAX=1.5`, `CHOP_HAIRCUT_MIN=0.25`). Enabling them in production cannot regress a trade beyond ±50% of nominal size.
- **HMM state labels are auto-assigned**, not hardcoded. After `baumWelch` fits K=3 states, `_labelStates` sorts the learned states by their mean SPY 1-day return and assigns `BULL_TREND` → highest, `CHOP` → middle, `BEAR_TREND` → lowest. Stable across retrains, no manual labelling.
- **Throttle keys are per-event-type for trade alerts (PR #271)**. `TRADE_ENTRY` keeps the 1h throttle; `TRADE_TRIM` is 5m; `TRADE_EXIT` has zero throttle so a close-out email is never dropped.
- **Deep-link redirect (PR #275)** preserves `url.search + url.hash` on both the authed `/` → `/today.html` redirect and the unauthed forward through CF Access, so a shared link like `/?ticker=IBM` arrives intact regardless of the recipient's auth state.

---

## 7. Lessons captured in this arc

Most of these are already in `tasks/lessons.md` from previous wrap-ups; the
new ones from this arc:

1. **Cloudflare Pages CAS can go corrupt.** "Uploaded 0 files (77 already uploaded)" is the smoking-gun log line. Always emit a unique build marker so content hashes differ per build (PR #269).
2. **Always preserve query string + hash on server redirects** (PR #275). A deep link is data, not noise.
3. **Per-ticker throttle keys must be event-type-scoped.** A 1-hour-per-ticker single throttle silently drops trim+exit emails after the entry email — fast-cycle trades go dark (PR #271).
4. **Direction-sanity on hard exits is mandatory.** When the live scoring tick recomputes a flipped-direction setup for an open trade, `tickerData.sl` becomes the OTHER direction's SL and spurious `sl_breached` reasons fire. Always validate SL/anchor against trade direction before using them in exit decisions (PR #270).
5. **Frontend asset paths should be stable, content updates should bust caches.** Hashed filenames trip Pages's CAS failure mode; stable names + `?v=…` query plus the build marker are robust (PRs #268, #269).
6. **A new admin form needs both a backend endpoint AND a UI section.** PR #273 ships both for the universe overlay; the IBM-add incident showed that listing tickers in highlight surfaces (UPTICKS, Member List) is not the same as adding them to the universe.
