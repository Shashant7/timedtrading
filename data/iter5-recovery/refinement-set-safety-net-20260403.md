# Safety-Net Refinement Set

Generated: 2026-04-03

## Evidence Anchor

- Golden run: `backtest_2025-07-01_2025-08-08@2026-03-31T13:20:22.786Z`
- Candidate lane: `backtest_2025-07-01_2026-04-02@2026-04-03T13:50:12.590Z`
- Candidate evidence: `data/iter5-recovery/safety-net-evidence-20260403.json`
- Parity report: `data/iter5-recovery/golden-vs-safety-net-parity-20260403.json`
- Diagnostic report: `data/iter5-recovery/trade-diagnostic-safety-net-20260403.md`

## What The Current Candidate Proves

1. This lane is a useful safety net, not a promotable golden replacement.
   - Candidate trades: `33`
   - Closed PnL: about `$3554.86`
   - It captures real winners, but the Jul/Aug basket diverges too far from the golden contract.

2. Jul/Aug parity is materially broken in the preserved lane.
   - Basket parity: `33.33%`
   - Entry timing parity: `4.17%`
   - Lifecycle parity: `0%`
   - Missing golden trades: `16`
   - Spurious Jul/Aug trades: `13`

3. The current lane is overfiring the wrong names while missing key golden checkpoints.
   - Missing: `MTZ`, `RIOT`, `IESC`, `ON`, `ETN`, `AGQ`, `PANW`, `GDX`, `PH`, `SWK`, `B`, `IREN`, `GRNY`, `PLTR`, `WDC`
   - Spurious: `ULTA`, `BK`, `CDNS`, `STRL`, `SLV`, `CLS`, `ORCL`, `FN`, `H`, `TWLO`, `AMGN`, `GEV`

4. The drift is not only entry selection; runner/trim intent drift is also real.
   - `FIX`: golden `deferred_exit_st15_flip`, candidate `BREAKEVEN_STOP`
   - `PH`: golden `deferred_exit_st15_flip`, candidate `sl_breached`
   - `KWEB`: golden `deferred_exit_st15_flip`, candidate missing equivalent lifecycle
   - `GRNY` and `AU`: path/engine metadata drifted enough that the current lane does not even present comparable lifecycle records

## Minimal Refinements Before Rerun

1. Make the Jul 1 fingerprint a hard checkpoint, not a manual inspection step.
   - Use the new `scripts/check-jul1-fingerprint.js` artifact from both focused and full harnesses.
   - Do not trust any new lane unless the earliest Jul 1 contract stops showing wholesale substitution.

2. Keep the replay pinned to frozen inputs.
   - Use the recovered config snapshot, not live merged `model_config`.
   - Keep historical `market_events` seeded before replay.
   - Use the unified focused/full harness semantics added in this pass.

3. Reduce entry substitution before making broader engine changes.
   - Prioritize restoring the missing golden names before tuning exits again.
   - Treat the spurious basket as evidence that the current lane is still too permissive on selection, especially around `tt_momentum` and `tt_pullback` substitutions.

4. Preserve runner intent once a correct entry is taken.
   - The new context-aware exit layer should defer oscillator exhaustion when structure is intact and event risk is not elevated.
   - The next validation lane must explicitly watch `FIX`, `PH`, `KWEB`, `GDX`, and `PLTR` for `defer/defend` behavior versus blunt breakeven or early stop behavior.

5. Treat null lifecycle metadata as invalid parity evidence.
   - `null` `entry_path` / engine metadata on candidate rows means those trades are not trustworthy for lifecycle comparison.
   - Any next lane that still produces null execution-path metadata should be rejected before deeper trade-for-trade tuning.

## Next Rerun Contract

The next clean trader rerun should only be trusted if it satisfies all of the following:

- Historical events were seeded and the run stayed on the frozen config.
- The Jul 1 fingerprint artifact improves materially from `0/4`.
- Missing golden names begin reappearing without replacing them with a new spurious basket.
- `FIX` no longer degrades from a positive excursion into `BREAKEVEN_STOP`.
- `PH` and `PLTR` regain deferred-runner behavior instead of premature protection.
