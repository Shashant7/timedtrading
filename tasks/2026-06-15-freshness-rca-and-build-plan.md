# Score freshness — RCA + proper build plan (2026-06-15)

Consolidated from a long live-debug session (too much live trial-and-error — the
process lesson is below). This is the single source of truth for the "scores not
fresh / investor excluded 93-95%" incident and the candle-chain consumption work.

## Topology ground truth (confirmed via /timed/admin/worker-flags)
Per `skills/worker-topology.md`, one bundle, four workers, role-gated. CONFIRMED
live state:
- **monolith** `timed-trading-ingest`: `engine_external=true` → it does NOT score.
  Has the chain binding + `SCORE_CANDLE_SOURCE=hybrid_chain`. Runs the API, the
  `*/1` feed (keeps the chain DO fresh), and fallback lanes.
- **tt-engine** `worker-engine/`: `WORKER_ROLE=engine`, `engine_enabled=true` →
  **this is the live `*/5` scorer.**
- tt-feed `*/1` feed, tt-research hourly/nightly.

## Root cause #1 — the scorer had no chain (FIXED)
The candle-chain cutover (`SCORE_CANDLE_SOURCE=hybrid_chain` + the
`CANDLE_CHAIN_SHARD` DO binding) was applied to **`worker/wrangler.toml` (the
monolith) only**. `worker-engine/wrangler.toml` — the worker that actually runs
`*/5` scoring — bound the other DOs (PRICE_HUB, etc. via `script_name`) but NOT
`CANDLE_CHAIN_SHARD`, and set no `SCORE_CANDLE_SOURCE`. So on the scorer,
`env.CANDLE_CHAIN_SHARD` was undefined and `SCORE_CANDLE_SOURCE` defaulted to
"legacy" → the `if (SCORE_CANDLE_SOURCE!=="legacy" && env.CANDLE_CHAIN_SHARD)`
branch was skipped → every ticker scored on cost-throttled **stale legacy**
candles → freshness quarantine capped ranks to 10 → the 93-95% investor exclusions
and the 10-day entry stall.

The chain DO itself was fresh the whole time (the monolith's `*/1` feed); the
monolith's HTTP probe proved the chain read path works — which is exactly why this
was invisible: **a failing/skipped path with a silent legacy fallback looks
healthy** (cf. lessons.md "a failing compute that has a fallback is invisible").

**Fix (shipped):** add the cross-script `CANDLE_CHAIN_SHARD` binding
(`script_name="timed-trading-ingest"`, so it reads the SAME DO instances the
monolith feeds) + `SCORE_CANDLE_SOURCE=hybrid_chain` to `worker-engine/wrangler.toml`,
redeploy tt-engine. Verified: tt-engine `has_chain_binding=true`, chain reads
succeed (`timed:debug:chain-read` ok:57, err:0).

## Root cause #2 — freshness still stale after the chain is wired (OPEN)
With the chain wired + reads succeeding, the freshness summary is STILL ~243/253
stale. The `timed:debug:chain-read` diag shows only **~65 of 244** scored tickers
even reach the chain read per `*/5` run (57 ok + 8 empty10), and `fresh` stays ~10.
Hypotheses to confirm IN THE BUILD (with the diagnostics already added — not by
live poking):
1. **Cadence/chunking:** if a run only freshens ~65 tickers, the universe (253)
   cycles slower than the 30-min LTF SLO → perpetually partially stale. Confirm:
   does the `*/5` loop process the full universe or a chunk? (scoringCore reported
   244, which conflicts with 65 chain reads — resolve this.)
2. **Degraded tickers:** computeServerSideScores returning null (insufficient
   candles) keeps the OLD stale `timed:latest` → counts as stale. Count
   `freshnessDegraded` per run.
3. **Critical legacy TF:** the daily (D) is critical + legacy + cost-throttled; if
   it crosses from "aging" to "stale" it quarantines regardless of fresh LTF.

## Proper build plan (do this on the branch, tested, deploy ONCE)
1. **Binding parity check (prevent recurrence):** a startup/health assertion that
   each role worker has EVERY binding its lanes need (engine needs
   CANDLE_CHAIN_SHARD). Surface a tombstone/health field, not a silent fallback.
2. **Resolve RC#2 from the diag fields** (chain-read counts + degraded count +
   per-run ticker count) — already instrumented; read `timed:debug:chain-read` +
   `/timed/admin/worker-flags`. No more live guessing.
3. **If cadence-bound:** make the scorer keep the full universe within the LTF SLO
   — the additive direction (see below), not per-cron full re-derive.
4. **CI guard:** a test that fails if `worker-engine`/`worker-feed` wrangler configs
   lack a binding the monolith has for that role's lanes.

## Additive read (already shipped, keep)
`loadBase5` now loads only the window's date-stamped day-chunks (not the full
retained base); `getSeriesMulti` derives all LTF in one storage pass; `/series-ltf`
caps to 600 bars. Per-read cost is ~3× lower.

## Diagnostics added (read-only; keep as standing tools)
- `GET /timed/admin/entry-explain?ticker=` — first failing entry gate per ticker.
- `GET /timed/admin/chain-getcandles-probe?ticker=` — the exact cron chain+hybrid
  path, per TF (chain vs legacy, bar count, edge age).
- `GET /timed/admin/worker-flags` — role + engine/feed flags + chain wiring + the
  last `timed:debug:chain-read`.
- `POST /timed/admin/build-index-map` / `GET /timed/admin/index-map`.
- `timed:debug:chain-read` KV — per-run chain-read ok/empty/err counts.

## PROCESS LESSON (for me / next agent)
Read `skills/worker-topology.md` BEFORE touching cron/scoring/wrangler — it states
plainly that tt-engine runs `*/5` scoring; that alone would have pointed at the
binding gap on commit one instead of after many live deploys. Diagnose with
read-only probes + KV diag FIRST; deploy the FIX ONCE when proven. Live
trial-and-error on a trading worker is wasteful and risky.
