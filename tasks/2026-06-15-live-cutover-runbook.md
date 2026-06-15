# Live Cutover Runbook — chain-backed LTF scoring (2026-06-15)

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
