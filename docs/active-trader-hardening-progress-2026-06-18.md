# Active Trader Hardening — Progress Snapshot (2026-06-18)

**Contract:** [`active-trader-information-hardening-plan.md`](active-trader-information-hardening-plan.md)

This is an operator/agent status page. It does not change runtime behavior.

---

## Layer status

| Layer | Contract | Status | Notes |
|---|---|---|---|
| **L0** Candle truth | Fresh, gap-aware chain | Shipped (foundation rebuild) | Chain DO + hybrid scoring path live behind flags |
| **L1** Signal truth | Indicator parity vs fixtures | In progress | SPY/IWM/QQQ clean on ST 10,3; fixtures not committed yet |
| **L2** Event truth | Persisted setup events | Shadow only | Pure modules + admin diagnostics; no D1 writes |
| **L3** Sequence truth | Named setup journeys | Shadow only | `td_phase_mean_reversion_{long,short}` detector |
| **L4** Pattern truth | Cohort path forecasts | Stub | Rule-based `path_forecast` with macro context fields |
| **L5** Action truth | Horizon-specific posture | Not promoted | Diagnostics return `trader_posture`; live kanban unchanged |

---

## Phase checklist

### Phase 1 — Indicator parity

- [x] TradingView export script + harness (`indicator-parity.js`)
- [x] Initial 10-ticker export run documented
- [x] SPY/IWM/QQQ subset clean (ST 10,3, TD, Phase, FVG edge fix)
- [ ] Committed fixture JSON under `data/indicator-fixtures/v1/`
- [ ] Full 10-ticker re-export with Lux TD13 + rolling VWAP columns
- [ ] ATR anchor TF fixture exports (3M/12M bundles)

### Phase 2 — Event ledger

- [x] Shadow event atoms (`setup-events.js`)
- [x] Snapshot diff bridge (`setup-event-derivation.js`)
- [x] Signal family catalog
- [x] Event name map (`setup-event-name-map-v1.md`)
- [x] Admin diagnostics route (`GET /timed/admin/setup-diagnostics`)
- [x] Schema alias normalization (`td9_bull`, `bull_prep`, `pdz.h4`, …)
- [ ] D1 `setup_events` table + backfill (blocked until parity gate)
- [ ] Dedupe audit vs existing `rank_trace_json.setup_snapshot`

### Phase 3 — Sequence detector

- [x] Shadow long/short mean-reversion sequences
- [x] Window-level derivation (`deriveSetupEventsFromWindow`)
- [x] Admin diagnostics returns sequences + `trader_posture`
- [ ] Shadow attach to ticker payload (still blocked by non-negotiable #10)
- [ ] Right-rail / kanban copy (after replay parity)

### Phase 4 — Path forecast

- [x] Stub path archetypes with VIX/sector/research/personality context
- [x] Markov `regime_forecast` fields in diagnostics context
- [ ] Historical cohort tables (same ticker -> personality -> regime -> global)
- [ ] Time-to-onset/target from replay mining

### Phase 5–6 — Mining + calibration

- [x] Read-only replay mining module (`setup-replay-mining.js`)
- [x] CLI: `scripts/mine-setup-sequences.mjs` (trades + trail -> reliability tables)
- [x] Run mining on live/pre-prod closed trades and review tables — preprod: [setup-mining-preprod-run-2026-06-18.md](setup-mining-preprod-run-2026-06-18.md); **prod:** [setup-mining-prod-run-2026-06-18.md](setup-mining-prod-run-2026-06-18.md) (50/50 join via `trail_5m_facts`; 0 sequences until TD/payload depth)
- [x] CLI `--trail-source 5m` for `trail_5m_facts` + D1-direct trades fetch
- [x] Tier 1 legacy `rank_trace` mining (`--analysis-mode legacy|combined`) — see [setup-events-combined-path-2026-06-18.md](setup-events-combined-path-2026-06-18.md)
- [x] Tier 2B `setup_events` D1 ledger + cron hook (`SETUP_EVENTS_WRITE=1`) + admin routes
- [x] Tier 3 backfill script (`scripts/backfill-setup-events.mjs`) — fixtures, trades, discovery cohorts
- [ ] Calibration queue (blocked on Phase 1 fixture acceptance)

---

## Non-negotiables still enforced

1. No production entry/exit/sizing changes from sequences until replay/live parity passes.
2. Events before sequences; sequences before path weights.
3. Name parity: new events map to shipped detectors or are flagged net-new.

---

## Next recommended actions

1. Re-export full 10-ticker TradingView parity set; commit accepted fixtures only.
2. Enable `SETUP_EVENTS_WRITE=1` on preprod; run fixture backfill + verify `GET /timed/admin/setup-events`.
3. Export Discovery report JSON; run `--cohort discovery` backfill + mining on SHOULD_HAVE_ENTERED misses.
