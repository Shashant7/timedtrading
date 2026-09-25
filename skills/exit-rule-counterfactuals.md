# Exit-rule counterfactuals (Short Term)

Use this before changing how Short Term trades are cut, locked, or re-entered —
or before answering "should we have held that?". One trade is an anecdote; these
replays put a proposed rule against every live trade it would have touched.

All scripts read production D1 through wrangler (`CLOUDFLARE_API_TOKEN`), use the
hourly bars in `ticker_candles` (`tf = '60'`), and take a few minutes: every
ticker is one wrangler call.

| Question | Script |
|---|---|
| After a max-loss exit, did the trade's own plan hit its target or its stop? | `node scripts/replay-max-loss-exits.mjs` |
| Would a floor scaled to the trade's own risk (K × stop distance) do better than the flat −3/−2.5/−2/−1.5% floor? | `node scripts/replay-max-loss-r-floor.mjs --k 0.4,0.5,0.6` |
| Should a stopped trade re-enter when price reclaims the entry? | `node scripts/replay-max-loss-reclaim-reentry.mjs --window 1,2,3` |
| Would a profit lock (floor = entry + LOCK × peak once up ARM%) stop green-to-red losses? | `node scripts/replay-st-profit-lock.mjs --arm 1.5,2,3 --lock 0,0.25,0.5` |
| What would the signals have made as options? (MODEL — no single-stock marks are stored) | `node scripts/model-st-signals-as-options.mjs` |
| Would Prime trades do better held to their plan stop? (live trades) | `node scripts/replay-max-loss-r-floor.mjs --k 1 --grade Prime` |
| Same question through the full engine (cascade included) | preprod replay with `deep_audit_conviction_*` (`worker/conviction-management.js`), see below |

## Traps

- **Measure from entry, not from the exit.** "After the stop it went to target"
  says nothing about the drawdown on the way. `replay-max-loss-exits` alone made
  an R-scaled floor look like +8 points; replayed from entry it was −7.
- **A counterfactual may only move an exit earlier.** The profit-lock replay
  books the lock only if it fires before the real exit; it never invents a later,
  better exit the trade did not have.
- **Plans need a stop and target.** Only trades with `positions.stop_loss` and
  `take_profit` can be replayed against their own plan (28 of 79 max-loss exits
  on 2026-09-24). Say how many were usable.
- **Same-bar ambiguity is resolved against the rule** (stop before target, arm
  before lock) so a result is never flattered by bar order.

## Findings on record (2026-09-24, 140 live trades since July)

Prompted by P: a Prime Cloud Pivot stopped at −2.7% (`max_loss_time_scaled`, a
10.1% planned stop) that gapped to its target the next session.

- The flat max-loss floor pays for itself. R-scaled floors lose 7–18 points;
  P is the outlier, not the pattern.
- A reclaim re-entry is noise (3–9 trades, −3.5% to +11.8% by window). P's first
  close back through entry was $127 — it gapped past the re-entry.
- Every profit-lock variant loses (−3.8 to −37 points): swing trades dip toward
  entry and then run more often than they round-trip.
- The edge is selection: Cloud Pivot +0.15%/trade (PF 1.14, n=56) and HTF Reclaim
  are positive; Support Bounce, ATH Breakout and Range Reversal are negative, and
  are what takes the book from about +8.6% to −15.4%.
- As modelled 30-DTE ATM options the same signals lose 3–14% per trade: theta and
  spread outweigh a +0.15% average move. Options multiply an edge; they do not
  create one.

## Conviction-aware management (2026-09-25) — negative, stays off

Question: should Prime trades get more room (hold to the structural stop, trail
wider)? Live counterfactual (`--k 1 --grade Prime`, 28 floor-cut Prime trades):
+5.4 pts total, but 18 of 28 ride to the full stop and 5 reach target — the gain
is a handful of trades. The full-engine replay decides it.

Preprod arms, Jul 1 – Sep 24 2026, 24 tickers incl. P / INTC / LITE, 10m, batch
24, model_config synced to prod (grade sizing already on). Realized dollars:

| Arm | Trades | Realized | vs base |
|---|---|---|---|
| base (live rules) | 92 | $6,089 | — |
| floors off for Prime + wider trail + 2x stale clock | 92 | $5,709 | −$381 |
| floors off for Prime + dollar cap raised to planned risk, live trail | 91 | $4,681 | −$1,408 |

- **The percentage floors never bind on Prime.** `HARD_LOSS_CAP`'s $250 leg cuts
  a $23k Prime position at −1.1% first, so turning the floors off alone did
  nothing; only raising the dollar cap to the trade's planned risk
  (`deep_audit_conviction_hlc_to_plan`) holds a trade to structure.
- **Wider trail: every changed trade gave back more from the same peak** (7
  trades, none ran further). The peak was the peak.
- **Holding to plan risk nets ~−$50 directly** (P 9/21 −$315 → +$122, INTC 8/12
  −$260 → +$53, LITE 7/14 −$259 → −$1,049) but costs the rest of the book: after
  LITE's −$1,049 no entries fired for the rest of that session, and the Jul 15
  cluster of winners was missed. Prime realized +$641, everything else −$2,049.
- **The recovered holds were cut small anyway** — P and INTC came back and then
  exited at +0.2–0.7% on the 1.5% ratchet arm / post-trim entry floor. If more
  room is ever worth testing again, it is on the upside (post-trim floor and
  ratchet activation for Prime), not the loss side.
- Run ids `cv-base-2026{07,08,09}`, `cv-conv-*`, `cv-hlc-*` in preprod
  `backtest_run_trades`.
