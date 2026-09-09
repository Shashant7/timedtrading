---
name: setup-audit
description: Audit Timed Trading setup definitions, overlap and context-conditioned outcomes when improving eligibility or comparing why the same pattern succeeds across tickers.
---

# Setup definition and context audit

Use for setup drivers, thresholds and overlap, not merely aggregate rank
correlation. Read `tasks/2026-09-09-setup-audit.md` for findings and unresolved
contracts. Use `skills/play-catalog.md` for identity and
`skills/backtest-replay.md` before replay. These docs do not grant deployment,
broker or production-replay authority. Public exports need no credentials;
rich current admin snapshots do. Do not extract keys from source.

## Non-obvious invariants

- Executed path owns identity, including noncatalog paths. Only unstamped
  history falls back to setup_name. `tt_cloud_pivot_long/short` must not become
  core `tt_cloud_pivot`; `momentum_score` is not `tt_momentum`.
- Catalog membership does not prove an independent current detector. Check
  actual call sites, including standalone paper entry outside TT Core.
- Structural detection short-circuits ATH/ATL → range → gap → n-test. Earlier
  forming-pair/index routes and later common gates also affect selection.
  Final return order alone is not the priority order.
- Raw shape, qualified trigger, admitted setup and fill are distinct
  populations. Collect rejected/preempted observations as well as fills.
- `__setup_evaluation` is core-only; a rejected core pass can coexist with a
  separate paper fill. Initial cloud triggers are not final admission.
- Reset diagnostic/forced-direction state every pass, including early returns.
- Missing/zero volume does not pass an enabled positive floor. Setup guards
  consume observed volume, not TradeContext's legacy neutral 1.0 defaults.
- A wick is not a held breakout. Preceding-session follow-through uses completed
  preceding closes. Momentum bar-position needs an actual bar. Gap's prior
  decline must not include today's partial reclaim.
- Generic scheduled-risk/catalyst presence earns no Cloud Pivot conviction
  point. Keep session plans; validate a directional, timestamped reaction before
  proposing positive weight. Do not restore admissions by lowering floors.
- Location, neighboring bars, inventory counts and simultaneous indicator flags
  do not prove independent tests, reclaim/sweep events or a preceding sequence.

## Repeatable local analysis

```bash
node scripts/audit-setups.mjs --as-of 2026-09-09T23:59:59Z \
  /path/to/ledger.json /path/to/research-snapshot.json
node node_modules/vitest/vitest.mjs run worker/pipeline/setup-evidence.test.js \
  worker/foundation/play-catalog.test.js worker/pipeline/admission-seam.test.js \
  worker/foundation/tt-cloud-pivot.test.js scripts/audit-setups.test.js
```

The audit only reads local JSON. It requires an explicit as-of, deduplicates by
trade/run, preserves unknown outcomes, excludes later exits and explicitly
post-entry snapshots, and shows setup/side/month comparisons and top-ticker
sensitivity. Unstamped times remain unverified, not proven leakage-free.
Direct Node imports of TT Core encounter legacy CJS interop; use Vitest's
existing transform for producer→context→engine tests.

September 9 evidence has 778 public ledger rows but zero entry snapshots there.
Rich v10b data is selected Jul–Nov 2025 research, mostly pullbacks. Neither
validates current catalyst effects or weekend upgrades. Do not substitute
current ticker data, today's news, or a trail point after entry. Numeric outputs
are associations, not causal or portfolio returns.

## Validation and handoff

Before retuning, pin code/config/profile versions and obtain the candidate
universe. Preregister a small set of within-setup contrasts. Separate entry
effects from sizing, exits and capacity cascades. Use chronological/ticker
holdouts, overlapping-horizon purges, uncertainty and costs. Apply validated
policy proposals through the existing learning-proposals bus only.

For definition fixes: test true/false positives, missing inputs, side symmetry
and actual producer shapes. Run full tests and bundle; bump SCORING_VERSION for
indicator contract changes. New ATH fields require a coherent rescore after an
approved deployment. Verify enabled trace persistence actually writes before
claiming overlap coverage. Save all findings, deferred decisions and validation
status in the task document and PR; avoid the shared todo conflict hotspot.

Sources: `worker/pipeline/setup-evidence.js`, `tt-core-entry.js`,
`trade-context.js`; `worker/indicators.js`; `worker/foundation/play-catalog.js`,
`tt-cloud-pivot.js`, `setup-sequences.js`, `setup-entry-snapshot.js` and
`sequence-snapshot.js`. S09–S12 remain open in the task plan; instrumentation
alone does not resolve those definition questions.
