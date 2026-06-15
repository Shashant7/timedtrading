# Active Trader entry stall — DEFINITIVE root cause (2026-06-15)

Built a read-only probe `GET /timed/admin/entry-explain?ticker=X` that replays the
live entry path (deep-audit config + Phase-C loops + portfolio breaker + regime
preload → computeServerSideScores → qualifiesForEnter + classifyKanbanStage) and
returns the first failing gate. Deployed live. It pinned the cause conclusively.

## The cause (overturns BOTH prior theories)
Not Tier-C, not conviction, not loop1, not regime. Every stuck high-rank candidate
is rejected with **`h3_rank_below_transitional_floor` — rank=10 vs rankMin=92**.

`rank=10` is a **freshness cap**. The raw rank is fine (CAT `__rank_trace.finalScore
= 100`), but `_applyFreshnessRankCap` clamps it to `FRESHNESS_RANK_CAP = 10` because
`isQuarantinedByFreshness()` is true — the payload's `_freshness.grade === "STALE"`
(a CRITICAL tf, the 10m, is older than its 30-min SLO).

The system's own monitor agrees: `timed:freshness:summary` = **fresh 10 / aging 2 /
stale 241 of 253, slo_ok=false**. 95% of the universe is quarantined → ranks capped
to 10 → every entry rank-floor rejects them → **zero entries**.

### Why the data is stale (the real defect)
- D1 candle coverage during RTH: only ~10 tickers have a 10m bar inside the 30-min
  SLO; the universe last had a full 10m pass ~2 h ago. 5m/240/D are 0-fresh even
  within 2 h (240 ~3 days stale, D ~3.7 days).
- The candle→D1 sync was **throttled for D1 cost** (`d1SyncLatestBatchFromKV(…, 25)`
  every 15 min; comment at index.js ~91888: "cadence halved… saves D1 writes"). So
  the universe's D1 candles refresh only every several hours — far outside the
  30-min freshness SLO that was added **2026-06-11** (commit `0f048de0` "A2:
  Freshness quarantine"). The freshness feature assumes fresher data than the
  cost-optimized pipeline produces → self-inflicted quarantine of the whole book.
- The candle-chain DO (the designed cost-free fresh path: Alpaca 5m → DO → derive
  10/30/60) is **not keeping the DO fresh**: the DO write path works
  (`/ingest` → `written:79`), and a manual `chain-do-feed` reports `fed:230`, but no
  `[CHAIN-DO-FEED]` log fires on the live `*/1` cron during RTH and scoring still
  reads stale data → hybrid falls back to stale legacy. So `SCORE_CANDLE_SOURCE=
  hybrid_chain` is currently a no-op (always falling back).

### Timeline note
Entries dribbled to 0 around **06-06**; the quarantine (06-11) then hard-locked it.
The 06-11 quarantine is the current dominant blocker; the staleness itself is the
underlying "scores aren't fresh" defect the operator flagged.

## Proof the fix works
CAT raw rank 100 (`__rank_trace.finalScore`), conviction 105. Uncapped, it clears
the transitional floor (92) and the conviction floor (80) → it would ENTER. So
restoring freshness directly restores cadence.

## Fix options (a cost↔freshness decision)
1. **Repair the chain DO feed end-to-end (recommended — respects D1 cost).** Make
   the `*/1` `_feedCandleChainDO` actually persist fresh 5m for the scored universe
   (check the ingest response — it's currently unchecked at index.js ~375 so
   `fed` overcounts), confirm `series-ltf` read + the hybrid recency gate
   (`CANDLE_CHAIN_MAX_EDGE_MIN`) accept it, and confirm `_freshness` is computed on
   the chain bars. Net: 10m fresh from Alpaca/DO with ~zero D1 cost → quarantine
   clears. Most work, best end state.
2. **Widen the D1 candle sync for the scored universe during RTH** (raise the 25-cap
   / shorten cadence) so 10m stays < 30 min. Simple + immediate, but **increases D1
   reads/writes** — directly counter to the 20 B-rows cost concern.
3. **Recalibrate the freshness SLO** to the achievable cadence (e.g. 10m 30→60-75
   min). Fast + reversible, but it widens the "tradeable staleness" window — a
   trading-risk call the operator must make.

Recommendation: (1) as the durable fix; (3) as a reversible interim ONLY with
operator sign-off on the staleness window. Do NOT do (2) given the cost goal.

## Tooling shipped
`GET /timed/admin/entry-explain?ticker=X` (read-only) — live. Use it to confirm the
fix: once data is fresh, `diag.rank` un-caps (10→~100) and `decision.qualifies`
flips true (or surfaces the next real gate).
