# Rank driver audit

**WHEN to use:** Changing `computeRank`, `worker/ranking/*`, adaptive rank
weights, or “improving rank.” Also when a ticker’s rank looks high despite
missing data, opposing HTF/LTF, or a stale HTF state.

Read [`tasks/2026-09-09-rank-driver-evaluation.md`](../tasks/2026-09-09-rank-driver-evaluation.md)
**before** adding points.

## The rule

The question is whether each **ingredient** earns its points (producer,
direction, missing-data, duplication) — not whether aggregate sort or
correlation improved. Do not fit new weights on the 2026-09-09 sample.

## Where the formula lives

| Piece | File |
|---|---|
| v1 / v2 technical score | `worker/ranking/technical-rank.js` (`createTechnicalRanker`) |
| Direction / event / TD / RSI helpers | `worker/ranking/rank-drivers.js` |
| Ordering + overlays + kanban batch | `worker/ranking/candidate-rank.js` |
| Armed play side | `worker/ranking/play-side.js` (Cloud Pivot / weekly ST hold) |
| Context conviction | `worker/ranking/context-conviction.js` (quality / theme / news) |
| Conviction score | `worker/focus-tier.js` (`computeConvictionScore`) |
| Worker wiring | `worker/index.js` → `computeRank` / `computeDynamicScore` |
| Version | `SCORING_VERSION` in `worker/indicators.js` |

`worker/ranking/outcome-rank.js` and `scripts/evaluate-outcome-rank.mjs`
are **offline only**. Failed chronological holdout. Do **not** import them
from `worker/index.js`.

## Do not reintroduce

- Missing/null completion or phase treated as early (+15 / +3)
- Opposing HTF/LTF strength or incompatible state earning support points
- Duplicate EMA / dip / squeeze bonuses (summary + direct)
- EXTREME phase as a favorable “zone change” (+2)
- Fixed sector prior (historical UP rates on both sides)
- TD / HMM keyed to HTF instead of **candidate side**
- Numeric-string adaptive weights concatenating into rank
- v2 setup-grade bonus or reversed SuperTrend (+4)
- Second-layer `computeDynamicScore` corridor / squeeze-in-corridor /
  hold-intent / phase-zone-change bonuses on top of `computeRank`

`computeDynamicScore` is technical base + independent overlays
(theme / FV / harmonic / officer / macro), then freshness. Overlay
**side** is rank-trace → armed play (Cloud Pivot / weekly ST hold) →
HTF sign. Theme *membership* does not move rank when today's observed
breadth is 0 (editorial-only stays off). Conviction gets that
membership plus quality / compounder / unsigned FV / news / index
inclusion (`scoreContextConviction`, cap +18 / −8). Scoring cron stamps
`_news_summary` from D1 (`loadNewsSummariesBatch`, 5d). Replay does not
load wall-clock news. Missing is 0.
Do not enable `conviction_fusion`. Do not boost SHORT on a quality-A
compounder.

## Read a trace

On a scored payload / entry:

1. Technical: `__rank_trace.parts[]` — `{ label, delta, reason, role }`
   (`driver_version = rank-drivers-v2`).
2. Overlays / caps: `_ranking.parts[]` (`CANDIDATE_RANK_VERSION =
   candidate-rank-v3`). Must reconcile to `final_score`.
3. Persisted on entry as `rankTraceJson`. Redacted for Members /
   anonymous (`redactTickerMapForTier`).

Legacy snapshots without `*_dir` flag metadata score **0** on those
events until a rescore (`skills/rescore-ticker.md`).

## Copy-paste

```bash
# Driver unit tests
npx vitest run worker/ranking/

# Version guard (must bump SCORING_VERSION when ranking files change)
node scripts/check-scoring-version-bump.mjs --base origin/main

# Exploratory present-vs-absent returns (no trading-service writes)
node scripts/audit-rank-drivers.mjs \
  data/trade-analysis/phase-h-v10b-1776787446/final-snapshot/trades-live-premortem.json \
  > /tmp/rank-driver-audit.json

# Offline outcome challenger (do not wire into the worker)
node scripts/evaluate-outcome-rank.mjs ledger.json 2026-08-01 2026-09-10
```

Evidence snapshot: `tasks/evidence/2026-09-09-rank-driver-audit.json`
(`trace_coverage: 0` on both current book and v10b). Limits in that file
forbid causal / portfolio-PnL claims.

## Deploy

Scoring cron is **tt-engine** (`*/5`). After merge:

```bash
cd /workspace/worker && ../node_modules/.bin/wrangler deploy \
  && ../node_modules/.bin/wrangler deploy --env production
cd /workspace/worker-engine && ../node_modules/.bin/wrangler deploy
```

Confirm `SCORING_VERSION` is `2.1.10-2026-09-10` on a freshly scored
payload. `_news_summary` present when D1 has scored headlines. Expect lower admissions at unchanged rank floors. Confirm
`deep_audit_rank_formula` (`v1` default / `v2` override) before judging
distribution. Do not lower rank floors to “restore” volume.

## Verify

- [ ] Focused ranking tests pass
- [ ] `check-scoring-version-bump.mjs` passes
- [ ] `outcome-rank.js` still has no import from `worker/index.js`
- [ ] After deploy: a rescore writes `__rank_trace` + `_ranking`
- [ ] No `tasks/todo.md` edit on the ranking PR
