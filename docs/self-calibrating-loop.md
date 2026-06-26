# The Self-Calibrating Loop — Build Log, Plan, and Verification

**Status:** Slices A / B / E shipped in PR #851 (merged 2026-06-26). All
behavior-changing levers are **flag-gated OFF** by default — this shipment is
*additive provenance + ready-but-dormant levers*, validated before any capital
behavior changes.

This is the foundation of the north star: a self-driving, self-calibrating
engine that compounds toward multiples of the S&P. You cannot safely cede more
control or scale capital to a system you cannot **prove and attribute** — so we
built the proof layer first.

---

## 1. What was built

### A. Decision provenance — the keystone (`worker/decision-records.js`)
Every trader decision (ENTRY / TRIM / DEFEND / EXIT / SL_TIGHTEN) is now written
to a new D1 table **`decision_records`**, version-pinned with:

- `scoring_version` (`worker/indicators.js` `SCORING_VERSION`)
- `engine_git_sha` (the exact deployed commit — injected by CI at deploy)
- `config_hash` (FNV-1a over the canonical, key-sorted active `model_config` —
  computed once per scoring tick)
- `engine` (`trader` | `investor` — the two engines never blur)
- `conviction_tier`, `reason`, `inputs_json`, `schema_version`

**Why it matters:** before this, trades carried a junk `script_version`
(`alpaca_server_v2.0`), trims/defends stored only price+reason, and DEFEND wrote
no D1 row at all. Looking back, you could not tell a real signal change from a
calc/config change ("we didn't track that / it was a different calc then"). Now
**"why did the engine do X to Y at Z?"** and **"did our change help?"** are
queryable. Hooked into `d1InsertTradeEvent` (covers ENTRY/TRIM/EXIT/SL_TIGHTEN)
and the DEFEND block (`worker/index.js`).

### B. Conviction fusion — trade our edge, not textbook (`worker/conviction.js`)
Fuses signals we already compute but were **discarding in shadow** into one
tier (A/B/C) + size multiplier:

- the **confirm-stack gate** (`stack_full_confirm` = SuperTrend flip + squeeze +
  EMA21 reclaim) — the promotable edge
- **focus conviction** (existing TA score)
- **daily-EMA21 structure** (the MU bounce pattern)
- the **MR sequence is used only as a wrong-way veto** — never a positive driver
  (it's ubiquitous, ~33% WR on live captures)

Stamped on every entry/defend (→ flows to `decision_records`). Conviction-
weighted sizing is applied at the single sizing point, **gated by
`deep_audit_conviction_fusion_enabled` (default OFF)**.

### C. Bleeder guard — stop the forced exits that bleed (`worker/bleeder-guard.js`)
The ledger is unambiguous: patient/structural exits win; soft "force"/"fast-cut"
exits bleed (`doctrine_force_exit` 4W/54L −$8.5k, `phase_i` fast-cuts 0% WR,
`atr_day_adverse` 3W/23L, `tape_capitulation`). When the higher-timeframe
structure still supports the trade (`assessTrendHealth`: htfIntact +
structuralSupport/pullback, not reversal) and the loss is contained, the guard
**shields these soft exits and holds/defends** instead of force-exiting on noise.
**Never** shields a hard SL / max-loss. Gated by
`deep_audit_bleeder_shield_enabled` (default OFF).

### D. Validation tooling (`scripts/validate-conviction-corpus.mjs`)
Runs the *real* `fuseConviction()` over the existing 362-trade + 211-miss corpus
with a walk-forward (75/25) split, plus a "flip what-if" that applies the
conviction `sizeMult` to the corpus. Artifacts in
`data/setup-mining/conviction-validation/`.

**Tests:** 27 new unit tests; full suite 821 passing.

---

## 2. The flags (and how to flip them safely)

| Flag (`model_config` key) | Default | Effect when ON |
|---|---|---|
| `deep_audit_conviction_fusion_enabled` | OFF | conviction-weighted position sizing |
| `deep_audit_bleeder_shield_enabled` | OFF | shield soft force/fast-cut exits when structure holds |

Both are registered in `REPLAY_DA_KEYS`. **Do not flip either until the forward
validation (section 4) clears its gates.** To flip: set the key to `"true"` in
the `model_config` D1 table (operator action), confirm it loads into
`env._deepAuditConfig` on the next scoring tick, and watch the decision_records
+ ledger under the drawdown governor (soft 15% / hard 25%).

---

## 3. What we learned (validated, not assumed)

**Slice 0 baseline (live simulated book):** 646 trades, 50.5% WR, profit factor
1.89, +$58/trade, net +$37.4k — profitable but thin (we win by letting winners
run ~1.85× losers). **We capture only ~4.8% of qualifying moves** (57 trades vs
662 moves in 60 days) — the breadth gap is the single biggest lever.

**Slice E corpus validation:**
- The confirm-stack gate is a **real selection filter** — gate-fired 59.9% WR /
  +0.44 SQN vs no-gate 54.7% / −0.82; the WR edge **holds out-of-sample**
  (57.1% vs 52.7%).
- **Sizing is not yet justified** — out-of-sample per-trade SQN does not hold
  (+0.58 in-sample → −0.26 OOS).
- **Flip what-if** — conviction sizing improves the corpus sum in every window
  (OOS −11.31 → −8.27, +27%): a consistent risk reduction, but OOS stays
  negative in absolute terms.
- **Re-enrichment is not viable from history** — D1 confirms `rank_trace_json`
  is NULL on all 365 backtest trades, candle depth only reaches 2025-05-06 (too
  shallow for EMA200), and `focus_conviction` was never stored. The EMA21 term
  is already inside the confirm-stack gate, so the only missing input is
  `focus_conviction` — unreconstructible. **The definitive full-input validation
  must come forward from live `decision_records`.**

**Verdict:** keep both flags OFF; the levers are built and ready, the path to
flipping is the live data we now capture.

---

## 4. What's next (the plan)

### Immediate — earn the flip (forward validation)
1. Let `decision_records` accumulate live with full inputs (incl.
   `focus_conviction`, which the corpus lacked).
2. Re-run the validation against that live data (apples-to-apples, version-
   pinned). Promotion gates: out-of-sample SQN ≥ 70% of in-sample, gate-fired
   n ≥ 30, capture-rate up vs the 4.8% baseline.
3. If conviction clears → flip `deep_audit_conviction_fusion_enabled` ON, **live
   small under the governor**. Same for the bleeder guard (compare shielded vs
   force-exited outcomes on real decisions).

### Then — climb the autonomy ladder (L0 → L5)
Each rung is unlocked by *attributed* edge across regimes within the drawdown
budget (full ladder + gates in the plan):
- **Breadth** — we capture 4.8% of moves; take more high-quality shots (the
  biggest lever).
- **Options-first expression** on high-conviction runners (capital efficiency =
  the magnitude lever toward 5–10× the S&P).
- **Close the Reflect loop** — route all `model_config` changes through one
  attributable bus (evidence + rollback + before/after), persist deep-audit
  runs, an automated before/after scorecard joined on `config_hash`/
  `scoring_version` (now possible because of Slice A).

### Cross-cutting — the WHY trail + followability
Assemble the `decision_records` (+ CIO + cohort log) into one timeline per
(ticker, time) for the operator, and a user-facing "why did TT do this?" feed;
unify the notification taxonomy; fix Insights' identity/false promise.

---

## 5. How to see this is working

### Right now (post-deploy)
The CI deploy of #851 (monolith + tt-engine + tt-research) succeeded with the
real `ENGINE_GIT_SHA` injected. `decision_records` is created on the **first
live trade decision** (entry/trim/defend/exit), so it populates once RTH trade
activity or a management DEFEND fires — typically intraday, not pre-market.

### The headline verification — version-pinned decisions accruing
From `worker/`:
```bash
../node_modules/.bin/wrangler d1 execute timed-trading-ledger --env production --remote \
  --command "SELECT engine, event_type, ticker, conviction_tier, scoring_version, engine_git_sha, config_hash, ts \
             FROM decision_records ORDER BY ts DESC LIMIT 20;"
```
**What good looks like:** rows appear with a non-empty `config_hash`, a real
`engine_git_sha` (the deployed short commit — NOT `unset`), `scoring_version`
`2.1.0-…`, a `conviction_tier` on entries, and **DEFEND rows that have no
matching `trade_event`** (proof we now capture the previously-invisible defends).

### Are we trading our edge? (conviction distribution)
```bash
../node_modules/.bin/wrangler d1 execute timed-trading-ledger --env production --remote \
  --command "SELECT conviction_tier, COUNT(*) FROM decision_records \
             WHERE event_type='ENTRY' GROUP BY conviction_tier;"
```

### Did a change help? (attribution — the whole point)
Once two `config_hash` / `scoring_version` epochs exist, outcomes can be grouped
by them apples-to-apples (join `decision_records` ENTRY rows to `trades` on
`trade_id`). This is the query the Reflect loop will automate.

### Re-validate the levers
```bash
node scripts/validate-conviction-corpus.mjs   # corpus walk-forward + flip what-if
```
Read `data/setup-mining/conviction-validation/latest.md`.

### Health / ops
- `https://timed-trading.com/timed/health` (or `…workers.dev/timed/health`)
- Mission Control (admin) — model perf, freshness SLO, cron, CIO.

---

## 6. File index

| Concern | File |
|---|---|
| Provenance helpers (pure) | `worker/decision-records.js` |
| Provenance D1 writer + hooks | `worker/index.js` (`d1InsertDecisionRecord`, `d1InsertTradeEvent`, DEFEND block, config-hash at the two config-load sites) |
| Conviction fusion | `worker/conviction.js` |
| Bleeder guard | `worker/bleeder-guard.js` |
| Flags allowlist | `worker/replay-runtime-setup.js` (`REPLAY_DA_KEYS`) |
| Build-id injection | `.github/workflows/deploy-worker.yml`, `deploy-engine.yml` (`--var ENGINE_GIT_SHA:…`) |
| Validation | `scripts/validate-conviction-corpus.mjs`, `data/setup-mining/conviction-validation/` |
| Tests | `worker/decision-records.test.js`, `worker/conviction.test.js`, `worker/bleeder-guard.test.js` |
