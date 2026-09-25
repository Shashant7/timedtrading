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
