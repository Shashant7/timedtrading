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
| After a trim, the remainder comes back to entry: floor, hold to plan, or wait for an hourly close? | `node scripts/replay-post-trim-floor.mjs` |
| When price reaches our plan stop, does the context (gap, volume, RSI, phase, reclaim) say it will recover? Where do our stops sit vs recent swings? | `node scripts/replay-stop-context.mjs [--rows]` |
| Would a stop beyond the prior 5/10-day swing do better at equal dollar risk? | `node scripts/replay-stop-placement.mjs [--buffer 0.1 --cap 3]` |

The last three read the plan from the ENTRY event (`trade_events.meta_json.sl_price` /
`tp_price`) — `positions.stop_loss` is the TRAILED stop — via `scripts/lib/trade-tape.mjs`.

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

## Post-trim floor, stop-touch context, stop placement (2026-09-25)

Live trades May – Sep 2026 (188 with a plan), 10m tape.

**Post-trim entry floor** (`deep_audit_ja_post_trim_floor`, ON): 48 trimmed
trades brought the remainder back to entry. From that touch, 26 went on to the
full plan stop and 11 to target — the floor is mostly right. Remainder P&L, % of
entry: floor −31.0 · hold to plan −38.7 · floor at half the risk −27.9 · floor
on an HOURLY close −24.8 (best, +6.2 pts / 48 trades on the half still held).
Two things cost more than the rule itself: fills average −0.65% against a
−0.15% design (overnight gaps: JD −2.1, GEV −2.0, LULU −2.0), and the trim is
taken at +0.5–0.7% on most trades, so "trim then floor at entry" caps a trade
near breakeven unless it runs. The hourly-close variant is NOT replay-testable
yet — see the look-ahead trap in `skills/backtest-replay.md`.

**What happens at our stop** (83 plan-stop touches before target):

- Price that reaches the stop keeps going: 13 recover to entry (16%), 57 trade
  0.5R further first. Holding with a 0.5R backstop averages −1.28R vs −1.02R
  exiting at the touch; waiting for a bar close is −1.16R. Exit on the touch.
- "Oversold / exhausted at the stop" is the NORMAL state, not a signal: 60 of 76
  touches had 10m RSI ≤ 30 (a stop is reached by a selloff). Recovery 15%
  oversold vs 25% not; 1H phase ≤ −61.8: 18% vs 15%. No edge.
- Gap-through (9) and heavy-volume breaks (4) did not fail more than quiet
  touches — everything fails ~70%. The one weak signal: a touch bar that CLOSES
  back above the stop recovers 25% vs 9%, but holding those only breaks even
  (−1.01R vs −1.02R).
- 45 of 83 touches are in the first 30 minutes (opening gaps / flushes); they
  recover LESS (13%) — do not defer opening stops.
- Existing breach guards are all pierce-depth tolerances (FVG/PDZ 0.5%, HTF
  trend 0.5% RTH, ext-hours wick, opening wick OFF, hourly-EMA233 band ON), none
  reads RSI / phase / LTF reversal — and the data says none should.

**Where the stop sits matters more than how price behaves at it.** 76 of 188
plan stops were INSIDE the prior 5-day swing range. Those were touched 50% of
the time and recovered 10 of 38 (noise); stops beyond the swing were touched
40% and recovered 3 of 45 (beyond the 10-day swing: 1 of 34). Stops under 1
daily ATR: touched 55%, 9 of 34 recovered. Median stop 1.32 daily ATR.

Candle replay (stop/target only, equal dollar risk): moving inside-swing stops
0.1 ATR beyond the 5-day swing, capped at 3 ATR, took the 57 moved trades from
−21.7R to +0.2R, robust to buffer / cap / horizon. **The full engine said no**
(`deep_audit_stop_beyond_swing_*`, `worker/structural-stop.js`, OFF): arm
`cv-ss-*` $4,658 realized vs $6,089. In the engine the plan stop is rarely the
loss exit — `HARD_LOSS_CAP` ($250, 12 trades, −$3,482 in the baseline), max_loss
and dead-money cut losers first — so a wider stop mostly means risk-based sizing
buys 11% less, and the same 28 ratchet winners made $2,034 less. Lesson: a
stop-placement counterfactual that replays only stop/target measures a stop
the engine does not use; check which exit actually takes the losses first.
