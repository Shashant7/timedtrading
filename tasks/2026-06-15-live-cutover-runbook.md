# Live Cutover Runbook — chain-backed LTF scoring (2026-06-15)

## ✅ CUTOVER COMPLETE (2026-06-15 ~14:10 UTC)
`SCORE_CANDLE_SOURCE=hybrid_chain` + `CANDLE_CHAIN_INGEST=1` deployed to
production. LTF (10/15/30/60) now scores from the chain's **Alpaca-sourced 5m
base** via the DO hot-window; 240/D/W/M stay on the legacy deep stores; per-ticker
fail-safe to legacy. Post-cutover: health ok, **244 tickers scored, 0 cron
failures**, and chain-vs-legacy parity **d_ltf=0 / d_htf=0 / state-equal** on the
sampled basket. **Rollback:** set `SCORE_CANDLE_SOURCE=legacy` in
`worker/wrangler.toml` (both `[vars]` and `[env.production.vars]`) + redeploy.

### ✅ Feed COVERAGE fixed (2026-06-15 ~15:55 UTC)
The first cut left a fixed subset (TSLA/AMZN/SPY/IWM/QQQ) 30–170m stale because
the rotating chunk starved any slice sharing a symbol Alpaca rejects, and the
feed universe (SECTOR_MAP) missed scored benchmarks/open-positions. Rewrote the
feed to: cover the **full SCORED universe** (snapshot keys ∪ SECTOR_MAP ∪
timed:tickers) every */1 tick in independent **sub-batches** (25), skip crypto,
**RTH-gated**, **non-blocking** (waitUntil). Verified: **0/18 stale, all ≤8m**
incl. SPY/IWM/QQQ. The only cron "failures" are the legacy
`freshness_quarantine_*` guard on ABNB/INFL — unrelated to the feed (and the
class of guard the rebuild ultimately retires).

### ✅ Freshness tuning COMPLETE (2026-06-15 ~15:05 UTC)
- Hybrid gate now uses a **recency check** (latest sliced bar within
  `CANDLE_CHAIN_MAX_EDGE_MIN`=25m of asOf) instead of strict full-window
  complete — so the RTH forming edge no longer forces a legacy fallback.
- The DO feed **batch-fetches recent 5m directly from Alpaca** (real-time;
  zero D1 reads) and runs **awaited on the light `*/1` cron** (not the heavy
  `*/5`), chunk 80, full SECTOR_MAP universe ⇒ **all DO edges refresh within
  ~3 min**. Verified live: never-manually-fed tickers (AMD/META/AVGO/INTC/AMZN)
  edge age ~2.6 min; 0 cron failures. The chain is **active during RTH**.
- Re-run the offset=20 older-window 5m batch that hit a 502 during the initial TD
  backfill (now superseded by Alpaca; verify those tickers' 5m depth).

---


Status after this session:
- **Deployed to PRODUCTION** (`timed-trading-ingest`, default + production envs):
  the D1 prev-close cache (bill relief), the dormant candle-chain foundation, and
  the admin endpoints (`chain-score-shadow`, `alpaca-bars-readonly`). **Live
  scoring behavior UNCHANGED** — `SCORE_CANDLE_SOURCE` is unset ⇒ legacy. Health
  ok, 0 cron failures.
- Branch `cursor/foundation-phase1-candle-chain-ce87` merged `main` in (470 tests
  green). **PR to merge → #661.**

## What the cutover does
Flip the **LTF (10/15/30/60)** candle source for the live score from the
drift-prone per-TF store to the candle chain (one 5m base, consistent by
construction). HTF (240/D/W/M) stays on its deep stores (hybrid — deep HTF from
5m is ~50–100× storage). Proven on pre-prod: htf identical, ltf≈0, state 5/5.

## Prerequisite found on live
Live already ingests 5m continuously, but only ~2–3 weeks deep. The LTF EMA
stack (60m e233 ≈ 33 trading days) needs **~2 months of 5m**. Today some tickers
converge (GS d_ltf 0.2, MU 0) and some don't (AAPL 19.1, AEHR −20, NVDA −16.2)
purely on 5m depth.

## DEPLOYED STATE (2026-06-15, after this session)
- **Live (`timed-trading-ingest`, both envs):** the cutover wiring is DEPLOYED
  but OFF (`SCORE_CANDLE_SOURCE` unset ⇒ legacy). Verified live unchanged (AAPL
  htf 15.1/ltf −16.8), health ok, 0 cron failures. Bill-relief cache active.
- **Fail-safe hybrid + DO `/series-ltf` batch action + `resolveScoreGetCandles`
  wired at the scoring cron (index.js ~92543).** 473 tests green.
- **DO-backed path VALIDATED on pre-prod** (DO seeded ~2mo 5m for AAPL/NFLX/TSLA):
  `mode=hybrid_do` → **d_ltf=0, d_htf=0, state equal** — the exact code the live
  cron runs when flagged reproduces legacy scores byte-for-byte.
- **Live 5m backfill RUNNING** (background, `/tmp/bf5m.log`) — ~2 months for the
  universe, batched. (One transient 502 on the offset=20 older-window batch to
  re-run.)

## ALL MACHINERY NOW BUILT + DEPLOYED LIVE (OFF) — go-live is operator flags
Added + deployed (both envs, dormant):
- Ongoing DO 5m ingest lane `_feedCandleChainDO` wired into the `*/5` cron via
  `ctx.waitUntil`, gated `CANDLE_CHAIN_INGEST` (default OFF). Rotates ~40
  tickers/tick, reads a 4h 5m window from D1, pushes to the per-shard DO.
- `POST /timed/admin/chain-do-feed?force=1&windowHours=<H>&max=<N>&tickers=<csv>`
  — runs the feed on-demand; with a WIDE window it doubles as the **bulk DO seed**.
- Validated on pre-prod: feed `fed>0`, DO 5m base `complete 468/468`; the
  DO-backed score path (`mode=hybrid_do`) = legacy (d_ltf=0, d_htf=0, state eq).

## CRITICAL FINDING (2026-06-15, live validation) — 5m base MUST be Alpaca-sourced
Live validation surfaced the decisive correctness point: the chain's LTF must
derive from an **Alpaca-sourced 5m base**, because the legacy 10m the backtest
used is **Alpaca-sourced** in production. With a TwelveData 5m base the live
shadow showed **AAPL d_ltf 13.9** (others 2-5). After re-backfilling AAPL's 5m
via **Alpaca**, the live shadow showed **d_ltf 0, state equal** — exact parity.
- Fixed `alpacaBackfill` to support `tf=5` (its `startDates` map lacked `"5"` ⇒
  silently upserted 0). Deployed live.
- **Universe-wide Alpaca 5m re-backfill is RUNNING** (tmux `bf5ma`,
  `/tmp/bf5ma.log`, `scripts/backfill-5m-universe-alpaca.sh`). It REPLACES the
  earlier TD 5m so the chain LTF matches the Alpaca/backtest basis.

## GO-LIVE SEQUENCE (operator; reversible) — REVISED
0. **Wait for the Alpaca 5m re-backfill** (`grep DONE-5M-ALPACA /tmp/bf5ma.log`).
   (The earlier TD-based 5m must be superseded by Alpaca everywhere.)
Set the two flags as Cloudflare **Workers → timed-trading-ingest → Settings →
Variables** (reversible without redeploy), or in `wrangler.toml`
`[env.production.vars]` + redeploy.

1. (superseded by step 0 — Alpaca 5m re-backfill)
2. **Bulk-seed the live DO** (≈2 months of 5m → DO), chunked to stay under the
   subrequest limit — repeat ~8× (the KV cursor rotates):
   `for i in $(seq 1 8); do curl -s -XPOST "$LIVE/timed/admin/chain-do-feed?force=1&windowHours=1500&max=40&key=$KEY"; done`
3. **Verify live parity** on the basket:
   `GET /timed/admin/chain-score-shadow?ticker=<T>&mode=hybrid_do` → expect
   `d_ltf≈0, state_equal=true`. Any ticker not yet seeded simply falls back to legacy.
4. **Enable ongoing freshness:** set `CANDLE_CHAIN_INGEST=1`. (Tuning: raise the
   feed chunk size / window if RTH edge-staleness causes too many legacy
   fallbacks — each ticker currently refreshes ~every 35 min.)
5. **Flip the score source:** set `SCORE_CANDLE_SOURCE=hybrid_chain`. Watch
   `chain-score-shadow` diffs stay ~0 and trades/alerts look normal.
   **Rollback:** set `SCORE_CANDLE_SOURCE=legacy` (instant, no redeploy).

## Clean cutover steps (in order)

1. **Merge PR #661** → `main` (foundation + cache + cutover scaffolding; all
   dormant/default-OFF; 470 tests green). [operator]

2. **Backfill deep 5m (~2 months) for all live tickers** so every LTF stack
   matches legacy. Paginated (TD caps ~5000 bars/call). Write-only, additive;
   ~2-month window keeps storage bounded (LTF needs months, not years).
   `POST /timed/admin/alpaca-backfill?tf=5&ticker=<T>&provider=twelvedata&startDate=2026-04-15&endDate=<today>`
   (loop the universe in date chunks). [agent or operator]

3. **Wire `resolveScoreGetCandles(env, {legacy, chain})`** into the scoring cron's
   `computeServerSideScores(...)` call, with `chain` = a **DO-backed** getCandles
   (reads the 5m base from the per-shard DO hot-window, NOT D1 — this is what
   keeps the cutover from increasing D1 reads). Default OFF (no-op). Deploy. Also
   enable the DO 5m ingest lane so the DO stays fresh. [agent → operator deploy]

4. **Verify hybrid parity on LIVE**: for the basket,
   `GET /timed/admin/chain-score-shadow?ticker=<T>&mode=hybrid` and confirm
   `d_ltf ≈ 0`, `state_equal=true` universally. [agent, read-only]

5. **Flip the flag on a canary**: set `SCORE_CANDLE_SOURCE=hybrid_chain` (worker
   var). Watch the live shadow diff stay ~0 for a cycle, confirm trades/alerts
   look normal, then it's live. **Reversible**: set back to `legacy`. [operator]

## Rollback
Set `SCORE_CANDLE_SOURCE=legacy` (or unset) and the score path is back on the
legacy candle source instantly — no redeploy needed.

## Remaining after cutover (Track A complete → then Track B)
- Prod-confirm D1 rows-read drop (DO hot-window serves LTF derivation).
- Optional: same-day 240 freshness via recent-5m derive reconciled to the stored
  deep 240 at close.
- Track B (#649 Active Trader) — already partially merged on main; resume its
  validations once scores are fresh.
