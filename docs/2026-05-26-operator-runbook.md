# Operator Runbook — Adaptive Scoring + Markov/HMM Decisions

_Created 2026-05-26 as part of PR #302._

This is the single source of truth for operator decisions that the agent **cannot make autonomously** — flag flips that require live-data observation, configuration-tuning calls that depend on cohort maturity, and watch-the-watcher polling of self-diagnostic endpoints.

If you are a future agent: read this BEFORE asking the user what to do.
If you are the user: this page tells you the exact endpoint to poll and the exact flag to flip, with the exact threshold that triggers each decision.

---

## Decision 1 — Flip `gates.markov_chop_haircut_adaptive` to `true`

**What it does:** Replaces the static 30 % position-size haircut applied to CHOP-regime entries with an adaptive haircut sourced from the live HMM posterior (so CHOP confidence of 0.95 haircuts more aggressively than CHOP confidence of 0.62).

**Why it isn't on by default:** The adaptive haircut formula was written assuming the live HMM regularly classifies the market as `CHOP`. Until we have observed at least one CHOP decode in production, flipping this would dead-code the new branch without us being able to confirm it works.

**Decision trigger:** `GET /timed/admin/hmm-labelling-check` returns a JSON body containing `"chop_decoded_at_least_once": true` AND `"days_since_last_chop": <= 7`.

**How to flip:**

```bash
curl -X POST 'https://timed-trading.com/timed/admin/model-config' \
  -H "x-tt-admin: $TT_ADMIN_KEY" \
  -H 'content-type: application/json' \
  --data '{"gates":{"markov_chop_haircut_adaptive": true}}'
```

**Watch:** Daily for one week. If the haircut floor drops position size below 25 % of normal more than 3× per day, flip back to `false` and re-tune.

---

## Decision 2 — Flip `gates.markov_position_sizing_enabled` to `true`

**What it does:** Lets the `_markovFavorPlan` audit data influence live position sizing (not just be recorded in `admission_cohort_log`).

**Why it isn't on by default:** Until we have ≥ 5 trading days of `_markovFavorPlan` rows in `admission_cohort_log`, the favored-vs-disfavored distribution is too noisy for live position sizing to use.

**Decision trigger:** Run this query (D1 admin console):

```sql
SELECT COUNT(DISTINCT date(ts/1000, 'unixepoch')) AS trading_days,
       COUNT(*) AS audit_rows
  FROM admission_cohort_log
 WHERE meta LIKE '%markov_favor_applied%' OR meta LIKE '%markov_favor_skipped%';
```

Flip when `trading_days >= 5` AND `audit_rows >= 30`.

**How to flip:** same `POST /timed/admin/model-config` call as Decision 1, with payload `{"gates":{"markov_position_sizing_enabled": true}}`.

**Watch:** Daily for one week. If two consecutive days show position-size shrink-rate > 40 %, flip back.

---

## Decision 3 — Tune `markov.windowDays` from 90 → 180

**What it does:** Doubles the lookback window for the regime-transition matrix from 90 to 180 trading days. Fewer cells will be `below_min` (insufficient observations) but the matrix will react slower to recent regime shifts.

**Why it isn't on by default:** Premature widening dilutes recent signal. We only do this if the current matrix has too many `cells_below_min`.

**Decision trigger:** `GET /timed/admin/regime-matrix-status` returns a body with `"cells_below_min" >= 6`.

**How to flip:** Update `model_config.markov.windowDays`:

```bash
curl -X POST 'https://timed-trading.com/timed/admin/model-config' \
  -H "x-tt-admin: $TT_ADMIN_KEY" \
  -H 'content-type: application/json' \
  --data '{"markov":{"windowDays": 180}}'
```

Then trigger an immediate rebuild:

```bash
curl -X POST 'https://timed-trading.com/timed/admin/markov-rebuild' \
  -H "x-tt-admin: $TT_ADMIN_KEY"
```

**Watch:** Re-check `cells_below_min` after rebuild. Target: ≤ 3.

---

## Decision 4 — HMM labelling watch

**What it does:** This is a *passive* watch, not a decision per se. The HMM labelling self-check at `GET /timed/admin/hmm-labelling-check` returns a 14-day disagreement streak counter. When the streak hits 14, the HMM is auto-flagged as needing a retrain.

**Decision trigger:** Either:
- `"disagreement_streak_days" >= 14` → action required.
- `"last_train_ts_ms" + 30 * 86_400_000 < now` (i.e. > 30 days since last train) → action required.

**Action when triggered:** force a retrain:

```bash
curl -X POST 'https://timed-trading.com/timed/admin/hmm-train' \
  -H "x-tt-admin: $TT_ADMIN_KEY"
```

Or wait for the next weekly cron (Sundays 04:00 UTC) — it will pick this up automatically.

**Cadence:** poll this endpoint **weekly** (Mondays).

---

## Decision 5 — Flip `gates.adaptive_scoring_v1` to `true` (PR #300)

**What it does:** Enables the Adaptive Scoring Layer 1 multiplier on `computeRank`. See PR #300 for the multiplier table. Default-off; ships in shadow (stamps `__adaptive_v1` on tickerData without changing the score) — wait, no, this is *not* shadow. Layer 1 actively changes the score when the flag is on. The flag-off state means no change.

**Decision trigger:** After 5 trading days of monitoring `[RANK-TRACE]` log lines:
- ≥ 80 % of admissions with a non-null `latent_regime.posterior >= 0.6` should have `__adaptive_v1` stamped (sanity check on integration).
- Multiplier distribution should be roughly: 30 % bull_aligned, 30 % bear_aligned, < 10 % counter-trend penalties, balance neutral.

**How to flip:**

```bash
curl -X POST 'https://timed-trading.com/timed/admin/model-config' \
  -H "x-tt-admin: $TT_ADMIN_KEY" \
  -H 'content-type: application/json' \
  --data '{"gates":{"adaptive_scoring_v1": true}}'
```

**Watch:** Daily for one trading week. If admission count drops > 30 % or accept-WR degrades > 5 pp, revert.

---

## Decision 6 — Flip `gates.cell_markov_divergence_enabled` to `true` (PR #301)

**What it does:** Promotes the Phase 6 G3 cell-Markov evaluator from SHADOW mode (record-only) to LIVE mode (actually blocks admission when the cell's loss share exceeds threshold).

**Decision trigger:** After 5 trading days of shadow rows in `admission_cohort_log`:

```sql
WITH shadow AS (
  SELECT id, decision, meta
    FROM admission_cohort_log
   WHERE ts >= unixepoch() - 5*86400
     AND meta LIKE '%"g3_shadow"%'
)
SELECT
  -- accepted but shadow would have blocked:
  SUM(CASE WHEN decision='accept'
            AND meta LIKE '%"would_block":true%' THEN 1 ELSE 0 END) AS shadow_blocked_accepted,
  -- of those, count actual losses vs wins (via JOIN to trades table)
  -- … (operator: join + compute WR)
  COUNT(*) AS total_shadow_rows
FROM shadow;
```

Flip when **WR of shadow-blocked-accepted trades < (overall WR − 10 pp)**. That is the threshold for "shadow correctly identifies losers."

**How to flip:**

```bash
curl -X POST 'https://timed-trading.com/timed/admin/model-config' \
  -H "x-tt-admin: $TT_ADMIN_KEY" \
  -H 'content-type: application/json' \
  --data '{"gates":{"cell_markov_divergence_enabled": true}}'
```

Note: this gate is **defined but not yet read** by the shadow evaluator — a separate small PR will wire the read once Step 6's data is in.

**Watch:** One trading week live. Revert if total accept count drops > 25 % or accept-WR drops > 5 pp.

---

## Decision 7 — UI suppression at low HMM confidence (cosmetic)

**What it does:** Currently the UI surfaces the HMM regime badge even when `posterior < 0.55`. Low-confidence badges look like noise.

**Decision trigger:** User complaint OR > 5 % of admissions per day where `posterior < 0.55`.

**Action:** small frontend PR — add `posterior >= 0.55` gate to the badge render in `react-app/shared-right-rail.js`.

This is cosmetic and low-priority — defer until a user pings it.

---

## Cadence summary

| Cadence | What to poll / check |
|---|---|
| **Daily** (during a 1-week post-flip watch) | The flag you just flipped + accept-WR + admission count |
| **Weekly (Mondays)** | `GET /timed/admin/hmm-labelling-check` |
| **Weekly (Mondays)** | `GET /timed/admin/regime-matrix-status` (look at `cells_below_min`) |
| **Weekly (Mondays)** | `GET /timed/admin/phase6-prereq-status` (look at `ready_for_phase6_g3`) |
| **Monthly** | Re-read this runbook — endpoints may have been added |

---

## Endpoints reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/timed/admin/model-config` | GET / POST | Read or update the live config (gates + tunables). |
| `/timed/admin/markov-rebuild` | POST | Force-rebuild the regime transition matrix. |
| `/timed/admin/hmm-train` | POST | Force-retrain the HMM (otherwise weekly cron). |
| `/timed/admin/hmm-labelling-check` | GET | HMM self-diagnostic + disagreement-streak counter. |
| `/timed/admin/regime-matrix-status` | GET | Matrix cell-count + `cells_below_min` count. |
| `/timed/admin/phase6-prereq-status` | GET | Phase 6 G3 prerequisite checklist (cache freshness, sample size, etc.). |
| `/timed/admin/sl-guard-stats` | GET | SL guard counter snapshot (PR #294). |
| `/timed/admin/provider-fallback-stats` | GET | Provider fallback counter snapshot (PR #298). |
| `/timed/admin/pages-deployments` | GET | Recent Cloudflare Pages deployments + CAS flush trigger (PR #292). |

All admin endpoints require the `x-tt-admin` header set to the value of `TT_ADMIN_KEY` (Cloudflare secret).

---

## See also

- `docs/2026-05-23-progress-recap.md` — full PR history + system state.
- `docs/2026-05-26-adaptive-scoring-spec.md` — Adaptive Scoring spec (Layers 1, 2, 3).
- `tasks/2026-05-19-stochastic-program-phase-wrapup.md` — phased rollout plan for Markov / HMM / cell-Markov work.
