# Self-Learning Trading Model

## Vision

A closed-loop system that observes market signals, tracks trading decisions and outcomes,
continuously learns which patterns predict profitable moves, and proposes model adjustments
for human approval. The model gets smarter with every trade, every skip, and every false signal.

---

## Phase 1: Initial Pattern Mining (seed the model) ✅

> Completed 2026-02-08

### 1.1 Move Identification Script ✅
- [x] Scan daily candles across all tickers for significant moves (≥5% in 3/5/10/20 day windows)
- [x] Tag each move: ticker, sector, direction, magnitude, duration, start_date, peak_date
- [x] Output: `docs/moves.json` — 17,373 unique moves across 258 tickers
- [x] Cover both UP moves (9,549) and DOWN moves (7,824)
- [x] 4,777 moves within trail coverage period (Oct 2025–Feb 2026)

### 1.2 Lead-Up Pattern Extraction ✅
- [x] For each move (top 500 by magnitude), pull trail_5m_facts for 5 days before
- [x] Extract feature vector: HTF/LTF score trajectories, state transitions, signal flags
- [x] Extract "exhaustion" features: peak state, peak signals
- [x] Output: `docs/pattern_features.json` — 342 moves with trail data, 158 without

### 1.3 Pattern Clustering & Scoring ✅
- [x] Define 22 rule-based archetypes (bullish, bearish, neutral)
- [x] Score each: hit rate, avg return, expected value, directional accuracy
- [x] Identify 41 compound patterns (2-archetype combos) with directional bias
- [x] Feature importance analysis (squeeze_releases = -54.3% lift, had_bull_bull = +15.6% lift)
- [x] Output: `docs/pattern_scores.json`

### 1.4 Findings Report ✅
- [x] Generated `docs/MODEL_FINDINGS.md` with executive summary
- [x] Key findings: Bull State Dominance (75.2% UP, N=165), Squeeze Release Bear (100% DOWN, N=9)
- [x] Sector analysis: Precious Metals 83.3% UP, Crypto 30% UP
- [x] State analysis: HTF_BULL_LTF_BULL = 75.2% UP, HTF_BEAR_LTF_BEAR = 41.7% UP

---

## Phase 2: Prediction & Outcome Tracking (close the loop) ✅

> Completed 2026-02-08

### 2.1 Data Schema ✅
- [x] `model_predictions` table — every signal with full context (scores, flags, confidence)
- [x] `model_outcomes` table — links prediction → actual result (P&L, MFE, MAE, duration)
- [x] `pattern_library` table — living pattern catalog with hit_rate, confidence, status
- [x] `model_changelog` table — audit trail for every model change
- [x] Migration: `worker/migrations/add-model-tables.sql`

### 2.2 Pattern Library Seeded ✅
- [x] 17 patterns seeded from Phase 1 findings (9 bullish, 6 bearish, 2 neutral)
- [x] Each pattern: serialized rule definition, hit rate, sample count, confidence
- [x] Pattern matching engine: `worker/model.js` (evaluateCondition, matchPatterns)
- [x] Script: `scripts/seed-pattern-library.js`

### 2.3 Prediction Logging ✅
- [x] Instrument scoring engine: log prediction on kanban stage change (enter_now, enter, exit, trim)
- [x] Log prediction on state quadrant flip (bear→bull, bull→bear)
- [x] Capture full snapshot: scores, flags, state, rank, completion, phase, sector
- [x] Match against active pattern library at prediction time
- [x] Non-blocking via ctx.waitUntil() — never slows the ingest flow

### 2.4 Outcome Resolution ✅
- [x] Daily cron job (4 AM UTC): resolve expired predictions against actual daily candle prices
- [x] Compute: actual return, max favorable/adverse excursion, time-to-peak
- [x] Hit threshold: ≥2% in predicted direction = hit
- [x] Track: traded / skipped / missed_opportunity
- [x] Auto-update pattern hit rates (Bayesian confidence update)
- [x] Auto-degrade patterns whose hit rate drops below 40%
- [x] Admin endpoint: POST /timed/admin/model-resolve?key=...

### 2.5 API Endpoints ✅
- [x] GET /timed/model/health — predictions, outcomes, patterns, pending changes
- [x] GET /timed/model/predictions?ticker=X&resolved=0&limit=50
- [x] GET /timed/model/patterns?status=active
- [x] POST /timed/admin/model-resolve?key=... — manual prediction resolution trigger

---

## Phase 3: Learning Engine (the model evolves) ✅

> Completed 2026-02-08

### 3.1 Fast Loop (per-outcome) ✅
- [x] On every prediction resolution: update pattern hit rate, Bayesian confidence, auto-degrade
- [x] Implemented in `worker/model.js` → `updatePatternStats()` + `resolveExpiredPredictions()`
- [x] Latency: immediate on resolution (runs inside daily cron + on admin trigger)

### 3.2 Slow Loop (weekly retrospective) ✅
- [x] Script: `scripts/weekly-retrospective.js` (90-day full, 30-day recent window)
- [x] Re-mines 3,357 moves → extracts features from trail_5m_facts → evaluates all 17 patterns
- [x] Pattern discovery: 93 feature combos tested, 14 new uncovered candidates found
- [x] Regime detection: compares recent 30d vs historical 60d UP% per pattern and sector
- [x] Generates `docs/MODEL_HEALTH_REPORT.md` + writes proposals to `model_changelog`
- [x] **Critical finding: REGIME CHANGE DETECTED** (see below)

#### Regime Change Alert (2026-02-08)
The retrospective revealed a **massive bearish shift** in the recent 30 days:
- **Bull State Dominance**: 79.2% → 39% (dropped 40pp)
- **ST Flip + Bull State**: 88.1% → 33.7% (dropped 54pp)
- **High Momentum Elite**: 85.4% → 27.6% (dropped 58pp)
- **Bull State + Momentum Elite**: 91.3% → 36.6% (dropped 55pp)
- **Sectors**: All degrading — Crypto 0% UP, Financials 0% UP, Tech 34% UP, only Real Estate improving
- 25 proposals written to `model_changelog` for review

### 3.3 Multi-Level Predictions ✅
- [x] **Ticker-level**: Pattern matching against 17 active patterns, net signal scoring
- [x] **Sector-level**: Breadth analysis (bullish/bearish/neutral counts per sector, regime classification)
- [x] **Market-level**: Universe breadth, regime signal (STRONG_BULL/MILD_BULL/NEUTRAL/MILD_BEAR/STRONG_BEAR), risk flags
- [x] Endpoint: `GET /timed/model/signals?level=ticker|sector|market`

---

## Phase 4: Model Governance (human in the loop) ✅ (core)

> Core governance completed 2026-02-08. Dashboard UI is Phase 5 scope.

### 4.1 Change Proposals ✅
- [x] Model proposes, never auto-deploys — all changes go to `model_changelog` as `status='proposed'`
- [x] Degradation proposals: weekly retro detects patterns losing edge (25 proposals from first run)
- [x] New pattern proposals: discovered candidates written as proposals
- [x] Sector/market regime change proposals

### 4.2 Approval Workflow ✅
- [x] `POST /timed/admin/model-approve?key=...&change_id=X&action=approve` — approve a proposal
- [x] `POST /timed/admin/model-approve?key=...&change_id=X&action=reject` — reject a proposal
- [x] Approved changes auto-apply: degrade/promote/retire patterns in `pattern_library`
- [x] `GET /timed/model/changelog?status=proposed` — view pending proposals
- [x] All changes versioned with timestamps, approval status, and who approved

### 4.3 Feedback Integration ✅
- [x] Approved changes update `pattern_library` status (active/degraded/retired)
- [x] Kanban classifier reads from `pattern_library` — data-driven entry confidence boost + pattern-aware promotion
- [x] All changes versioned in `model_changelog` for rollback

---

## Phase 5: Continuous Operation ✅

> Completed 2026-02-08

### 5.1 Model Dashboard UI ✅
- [x] Standalone dashboard page: `react-app/model-dashboard.html`
- [x] **Overview tab**: Health stats (predictions, hit rate, patterns, proposals), market regime card, sector signals table, ticker signals panel
- [x] **Patterns tab**: Full pattern library table (hit rate, N, EV, confidence, status)
- [x] **Proposals tab**: 25 pending proposals with Approve/Reject buttons (governance workflow)
- [x] **Predictions tab**: Recent predictions with resolution status
- [x] Navigation links added to Dashboard and Trade Tracker pages
- [x] CORS fix for wildcard origin (`CORS_ALLOW_ORIGIN = "*"`)

### 5.2 Kanban ← Pattern Library Integration ✅
- [x] **Pattern cache**: In-memory cache refreshes every 5 minutes from D1 `pattern_library`
- [x] **Pattern enrichment**: Every ingest cycle matches ticker against cached patterns
- [x] **Entry confidence boost**: High-confidence bull patterns upgrade entry confidence to "high"
- [x] **Pattern-aware promotion**: Watch → Setup when ≥2 bull patterns match with >55% confidence and positive scores
- [x] **Right rail Model tab**: Shows matched patterns, net signal, strongest bull/bear signals per ticker
- [x] **Kanban meta**: Pattern-promoted setups tagged with 🧠 and model attribution
- [x] `pattern_match` field included in D1 minimal payload for persistence

### 5.3 How It Works (the loop is closed)
```
Market Data → Scoring Engine → Pattern Matching (17 active patterns)
    ↓                              ↓
    ↓                   Kanban Classification (pattern-aware)
    ↓                              ↓
    ↓                    Prediction Logging (D1)
    ↓                              ↓
    ↓                    Trade Execution (paper)
    ↓                              ↓
Daily Cron ──→ Outcome Resolution ──→ Pattern Stats Update
    ↓                              ↓
Weekly Retro ──→ Regime Detection ──→ Proposals to model_changelog
    ↓                              ↓
Human Review ──→ Approve/Reject ──→ Pattern Library Evolves
```

---

## Current Status

- [x] Scoring engine built and deployed
- [x] Daily candle backfill (400+ days, 240+ tickers)
- [x] Intraday candle backfill (3m/5m/10m/30m/60m/4H)
- [x] Trail_5m_facts backfill (85+ days, Oct 2025–Feb 2026)
- [x] Scoring replay complete
- [x] **Phase 1**: Initial Pattern Mining — 17 patterns identified and scored
- [x] **Phase 2**: Prediction & Outcome Tracking — live, logging + resolution loop deployed
- [x] **Phase 3**: Learning Engine — Fast loop + weekly retrospective + multi-level predictions
- [x] **Phase 4**: Model Governance — proposal workflow + approval endpoints
- [x] **Phase 5**: Continuous Operation — dashboard UI + Kanban ← pattern_library integration

### What Happens Next (Autonomous)
The system is now **self-operating**:
1. **During market hours**: Every ingest cycle matches tickers against patterns, logs predictions on state changes
2. **Daily at 4 AM UTC**: Resolves expired predictions, updates pattern hit rates, auto-degrades underperformers
3. **Fridays at 4:15 PM ET**: Automated weekly retrospective proposes degradation/promotion/regime changes
4. **On demand**: Human reviews proposals on the Model Dashboard, approves/rejects to evolve the pattern library
5. **Over time**: Hit rates converge to truth, weak patterns get retired, new patterns get discovered
