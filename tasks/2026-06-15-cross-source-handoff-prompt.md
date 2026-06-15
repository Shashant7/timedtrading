# Handoff Prompt — Cross-Source Candle Ground Truth (post-Alpaca-secret)

> Paste the block below to a new agent once `ALPACA_API_KEY_ID` +
> `ALPACA_API_SECRET_KEY` have been added to the **pre-prod** environment.

```text
You are continuing the "Timed Trading" foundation rebuild (candle-chain-first).
A previous session built the chain core + a cross-source ground-truth mechanism;
your job is to run the SYSTEMATIC two-provider (TwelveData vs Alpaca) + web
ground-truth check now that the Alpaca secret is available, then advance the
candle chain toward shadow ingestion. Work autonomously; this is a background
agent (no live user). Today's date context: ~2026-06-15.

═══════════════════════════════════════════════════════════════════════════
HARD GUARDRAILS (non-negotiable)
═══════════════════════════════════════════════════════════════════════════
- NEVER touch live trade state, live D1, live KV, live positions, or the live
  worker `timed-trading-ingest`. Reads from live are read-only only.
- Do ALL work on PRE-PROD (`timed-trading-ingest-preprod.shashant.workers.dev`,
  isolated: own D1/KV, no crons, EXECUTION_MODE=simulation, email/Discord off)
  or locally. Verify the host/DB name on every mutating command.
- The candle-chain Durable Object is DORMANT (no cron). Do NOT wire it into any
  live ingestion lane without explicit operator approval.
- Do NOT deploy to live / run `npm run deploy` / `wrangler deploy --env=production`.
  Deploying to PRE-PROD (`npm run deploy:preprod`) is fine.
- Stay on the current git branch; commit per logical change; push every
  iteration; update the PR. Do not force-push/amend.

═══════════════════════════════════════════════════════════════════════════
READ FIRST (in order)
═══════════════════════════════════════════════════════════════════════════
1. tasks/2026-06-14-foundation-rebuild-plan.md         (the whole plan)
2. tasks/2026-06-14-phase0-parity-baseline-result.md   (baseline: 45/45 diverge)
3. tasks/2026-06-15-phase1b-shadow-reconcile-result.md (derive-from-5m validated)
4. tasks/2026-06-15-candle-ground-truth-findings.md    (THIS task's context)
5. worker/foundation/README.md                          (module map)
6. AGENTS.md + CONTEXT.md                                (repo onboarding)

═══════════════════════════════════════════════════════════════════════════
CURRENT STATE
═══════════════════════════════════════════════════════════════════════════
- Git branch: cursor/foundation-phase1-candle-chain-ce87 (PR #657). Continue on
  it (or a stacked branch off it). Other open PRs: #651 plan, #652 Phase 0 +
  baseline, #654 pre-prod sync tooling.
- Foundation modules (pure, tested; NOT imported by the live worker → zero live
  behavior change):
    worker/foundation/series-contract.js     SeriesView + coverage/complete
    worker/foundation/indicator-contract.js  pure indicators, refuse on gaps
    worker/foundation/score-contract.js      score gate (UNSCORABLE on stale)
    worker/foundation/parity.js              live-vs-replay diff core
    worker/foundation/trading-calendar.js    expected-bars grid (DST-correct)
    worker/foundation/resample.js            5m base -> 10/15/30/60/240; D->W/M
    worker/foundation/candle-chain.js        ingest/integrity/derive/retention
    worker/foundation/candle-chain-shard.js  per-shard core (storage-injected)
    worker/foundation/candle-chain-do.js     CandleChainShard Durable Object
    worker/foundation/reconcile.js           reconcileDailyRollup + crossSourceConsensus
  Scripts: scripts/parity-baseline.js, scripts/candle-chain-shadow-reconcile.js,
           scripts/sync-model-config-to-preprod.js
- Pre-prod is synced to live: current code deployed, all 479 model_config keys
  cloned, TWELVEDATA_API_KEY secret set, CandleChainShard DO deployed (dormant,
  migration v6). The 45-ticker review basket has candles backfilled
  (data/parity/2026-06-12-basket.txt). A 10-ticker sample also has 5m.
- Tests: `npm test` (vitest). Full suite was 423/423 green. Keep it green.

KEY FINDINGS you are building on (from finding #4 doc):
- Deriving 10/15/30 from a 5m base reproduces the provider's bars 100%;
  60m/240m differ by anchor convention only (resample math is correct).
- The 2026 daily data is penny-perfect vs web ground truth. Daily bars are
  stamped at 00:00 UTC of the trading day (reconcile.js keys daily by UTC date;
  intraday by ET date — do not regress this).
- Volume is NOT equality-reconcilable (auction prints are in the daily but not
  intraday bars); reconcileDailyRollup uses High/Low as the verdict + a banded
  volume ratio. crossSourceConsensus(sources,{quorum}) returns ground truth when
  >=quorum sources agree and flags outliers.
- Legacy 2025 daily bars are DUPLICATED (00:00Z + 04:00Z dual-write); 2026 clean.

═══════════════════════════════════════════════════════════════════════════
YOUR TASKS (in order)
═══════════════════════════════════════════════════════════════════════════
1. CONFIRM the Alpaca secret is on pre-prod. Probe:
     curl -s -X POST "$PRE/timed/admin/alpaca-backfill?startDate=2026-06-01&endDate=2026-06-12&tf=D&ticker=AAPL&provider=alpaca&key=$TIMED_TRADING_API_KEY"
   Expect ok:true (not "data_provider_not_configured"). If it fails, STOP and
   report that the Alpaca secret still isn't set on pre-prod.

2. BUILD scripts/cross-source-ground-truth.js — fetch the same daily (and 5m)
   bars for the basket from THREE independent sources and run
   crossSourceConsensus (worker/foundation/reconcile.js):
     • TwelveData: already in pre-prod D1 (read via `wrangler d1 execute
       timed-trading-ledger-preprod --remote --json --command "SELECT ..."`),
       or direct https://api.twelvedata.com/time_series (TWELVE_DATA_API_KEY).
     • Alpaca: direct data API https://data.alpaca.markets/v2/stocks/{sym}/bars
       ?timeframe=1Day&start=...&end=...  headers APCA-API-KEY-ID /
       APCA-API-SECRET-KEY (the new secrets). Read-only; do NOT write to D1.
     • Web/exa: the WebSearch tool as the independent auditor / tiebreaker for a
       random sample and for any disagreement.
   For each (ticker, day): consensus on H/L/C (quorum 2, priceTol ~0.02). Report
   per-provider agreement %, the outlier provider per case, and any day with no
   consensus. Write data/parity/2026-06-cross-source.json + a short writeup in
   tasks/. Spot-check ~3 random results against WebSearch to confirm.

3. From the results, decide the canonical source-of-truth policy (e.g., "accept
   when TD+Alpaca agree; else web-audit") and document it. If a provider is
   systematically off (like the legacy daily duplication), file the concrete fix.

4. CANDLE-CHAIN follow-ups surfaced earlier (do as scoped, tested, additive):
   a. Pin the canonical 60m/240m anchor in resample.js (session top-of-hour with
      an explicit partial-last-bar 15:30-16:00 rule) + a self-consistency test.
   b. Normalize daily-bar timestamps to a canonical trading-date anchor on
      ingest in candle-chain-shard.js + dedup the 00:00Z/04:00Z double-write.
   c. Wire reconcileDailyRollup + crossSourceConsensus as a base-fidelity gate
      the chain runs on ingest (DORMANT/shadow; never blocks live).

5. ADVANCE toward Phase 2 (only after 1-4): run the candle chain in SHADOW on
   pre-prod beside the current per-TF store (calendar-driven ingest feeding the
   DO), prove the chain's own coverage report shows zero gaps for a sustained
   window, then RE-RUN the parity baseline (scripts/parity-baseline.js per
   tasks/2026-06-14-phase0-parity-baseline-result.md) and confirm the
   score/conviction divergence collapses vs the 45/45 baseline. Report the delta.

═══════════════════════════════════════════════════════════════════════════
MECHANICS / GOTCHAS (learned the hard way)
═══════════════════════════════════════════════════════════════════════════
- Env: $TIMED_TRADING_API_KEY (admin), $CLOUDFLARE_API_TOKEN (wrangler).
  PRE=https://timed-trading-ingest-preprod.shashant.workers.dev
  LIVE=https://timed-trading-ingest.shashant.workers.dev  (read-only!)
- Backfill 5m EXPLICITLY: the system's `tf=all` does NOT include 5m (finest
  stored TF is 10m). Use `&tf=5&provider=twelvedata`. 5m IS available from TD.
- candle-replay processes only ~15 tickers per call — run in batches of <=15.
- Read raw candles: wrangler d1 execute timed-trading-ledger-preprod --remote
  --json --command "SELECT tf,ts,o,h,l,c,v FROM ticker_candles WHERE ticker='X'
  AND tf='5' AND ts>=<ms> AND ts<<ms> ORDER BY ts".
- DO admin proxy (dormant): POST /timed/admin/candle-chain with
  {action:ingest|series|integrity|reconcile-daily|tickers|retention, ...}.
- Daily ts convention = 00:00 UTC of the trading day; intraday = session time.
- npm install first (better-sqlite3, vitest, wrangler are devDeps). Node 22.
- `npm test` must stay green; add tests for everything new.

DEFINITION OF DONE for this handoff: a committed cross-source ground-truth
report (TD vs Alpaca vs web) across the basket with a documented source-of-truth
policy, plus the 60m/240m anchor + daily-normalization fixes, all tested, on the
branch with an updated PR. Do NOT enable any live behavior.
```
