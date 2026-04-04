# Replay Refinement Set

Generated: 2026-04-03

## Evidence Anchor

- Golden run: `backtest_2025-07-01_2025-08-08@2026-03-31T13:20:22.786Z`
- Historical full-run bridge: `backtest_2025-07-01_2026-03-31@2026-03-31T21:26:48.269Z`
- Joined diagnostic: `data/iter5-recovery/trade-diagnostic-report-mar31.md`

## What The Evidence Says

1. The golden Jul/Aug basket is reproducible by a historical full run.
   - Basket parity: `100%`
   - Entry timing parity: `100%`
   - Lifecycle parity: `91.67%`

2. The highest-confidence current problems are harness validity and observability.
   - Missing or broken historical `market_events` seeding invalidates earnings-aware exits.
   - Trade Autopsy visibility was making July trades hard to inspect and could mix wrong sources.
   - The next lane must stay pinned to the frozen recovered config, not live merged state.

3. No broad `tt_core` rewrite is justified by the evidence gathered in this pass.
   - Only `2` overlap trades in the golden window showed lifecycle drift (`GRNY`, `GDX`).
   - The bigger issue in Jul/Aug is `13` spurious trades, which is better explained by harness/config scope than by missing baseline logic.

## Concrete Refinements To Apply

1. Historical event seeding is mandatory before replay.
   - Use `POST /timed/admin/backfill-market-events`.
   - `scripts/backfill-market-events.js` is now the canonical batch client for this route.
   - `scripts/full-backtest.sh` now seeds `market_events` automatically before candle backfill unless `--skip-market-events` is explicitly set.

2. Keep Trade Autopsy scoped and navigable.
   - Default to the live replay when a run is active.
   - Show explicit source/run labeling.
   - Support oldest-first ordering so July trades remain easy to inspect.

3. Keep the replay lane pinned to the frozen recovered config.
   - Use `configs/julaug-golden-parity-v2-20260402.json` for the next validation lane.
   - Do not merge live `model_config` into the run-scoped archive for this recovery path.

4. Defer deeper engine changes until the next valid seeded replay confirms a real behavioral gap.
   - Monitor `GRNY` and `GDX` lifecycle drift specifically.
   - Monitor event-protection checkpoints such as `LRN` and other earnings-sensitive names.
   - If seeded replay still shows the same misses, then promote those into targeted exit-management changes.
