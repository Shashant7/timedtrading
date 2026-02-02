# Score Rename & Enter Now Upgrade Plan

## Overview

Consolidate terminology (`rank` → `score`) and fix Enter Now logic to combine score with other signals, eliminating the rank/rank_position confusion and aligning Kanban behavior with evidence-based patterns.

---

## 1. Terminology

| Current | New | Description |
|---------|-----|-------------|
| `rank` | `score` | 0–100 composite quality score from `computeRank()` — higher = better setup |
| `rank_position` | `position` | 1-based position after sorting by score (1 = best) |
| `ALERT_MIN_RANK` | `ALERT_MIN_SCORE` | Minimum score threshold for alerts (optional rename) |
| `rank_below_min` | `score_below_min` | Blocker label in entry decision |

**Why score?** It’s a 0–100 metric; “score” is clearer than “rank,” which suggests ordinal position.

---

## 2. Scope of Changes

### 2.1 Worker (`worker/index.js`)

| Area | Change |
|------|--------|
| `computeRank()` | Rename to `computeScore()` or keep name but treat output as “score” |
| Payload/response fields | Add `score` (canonical), keep `rank` as deprecated alias during transition |
| `classifyKanbanStage` | Use `score`, fix Enter Now paths, combine with other signals |
| `computeEntryDecision` | Use `score` / `score_below_min` terminology |
| `shouldTriggerTradeSimulation` | Use score terminology |
| Logs, Discord embeds | Use “Score” in user-facing strings |
| Self-learning / rank patterns | Rename to score patterns |

**DB schema:** Keep D1 column names as `rank` for now; no migration. Map `rank` column ↔ `score` in code. Add migration later if desired.

### 2.2 React App (`react-app/*.html`)

| File | Change |
|------|--------|
| `index-react.html` | Use `score` / `position`, update labels and tooltips |
| `simulation-dashboard.html` | Same |
| UI labels | “Score (0–100)” and “Position” instead of “Rank” |

### 2.3 Scripts

| Script | Change |
|--------|--------|
| `clarify-ranking.js` | Update to clarify score vs position |
| `analyze-best-setups.js` | Use `score` in features (if exposing it) |
| `analyze-today.js`, `check-alert-candidates.js`, etc. | Use `score` in logs/output |

### 2.4 Docs

| Doc | Change |
|-----|--------|
| `ALERT_AND_KANBAN_REVIEW.md` | Rewrite for score/position and new Enter Now logic |
| `SCORING_ARCHITECTURE.md` | Terminology update |
| `RANK_VS_WINNING_TRADES_ANALYSIS.md` | Rename to `SCORE_VS_WINNING_TRADES_ANALYSIS.md` |
| `README.md`, `worker/README.md` | Alert thresholds section |

### 2.5 Config

| Config | Change |
|--------|--------|
| `wrangler.toml` | Optional: add `ALERT_MIN_SCORE`; keep `ALERT_MIN_RANK` as alias |
| API responses | Add `score`; keep `rank` for backward compat in Phase 1 |

---

## 3. Enter Now Logic Upgrade

### 3.1 Current (Buggy) Logic

```javascript
// BUG: rank <= 20 selects worst setups (score 0–20)
if (rank <= 20) return "enter_now";

// Other paths: thesis_match, momentum_elite, HTF/LTF strong, corridor + sq30_release
```

### 3.2 New Logic (Score + Other Signals)

**Principle:** Enter Now requires **score plus at least one other signal**. No score-only path.

| Path | Condition | Rationale |
|------|-----------|-----------|
| **1. Top tier + corridor** | (score ≥ 75 OR position ≤ 20) AND in_corridor AND entry_ok | Best setups in corridor |
| **2. Thesis / Momentum Elite** | (thesis_match OR momentum_elite) AND score ≥ min_score | Relaxed for quality names |
| **3. Strong HTF/LTF** | htfAbs ≥ 40 AND ltfAbs ≥ 20 AND score ≥ 70 | Technical alignment |
| **4. Corridor + Squeeze** | in_corridor AND sq30_release AND score ≥ 70 | High-conviction trigger |
| **5. 1H 13/48 EMA Cross + corridor** | in_corridor AND (ema_cross_1h_13_48 OR buyable_dip_1h_13_48) AND score ≥ 68 | Pivot change + pullback opportunity |

**Constants (env or code):**

- `ENTER_NOW_MIN_SCORE` = 70 (or reuse `ALERT_MIN_RANK`)
- `ENTER_NOW_TOP_SCORE` = 75 (for “top tier” path)
- `ENTER_NOW_TOP_POSITION` = 20 (top 20 by position)

**Pseudocode:** (entry decision gate already ensures we skip if blocked)

```javascript
const score = Number(tickerData?.score ?? tickerData?.rank) ?? 0;  // backward compat
const position = Number(tickerData?.position ?? tickerData?.rank_position);
const ent = entryType(tickerData);
const inCorridor = !!ent?.corridor;

// Path 1: Top tier + corridor (never score alone)
if ((score >= 75 || (position > 0 && position <= 20)) && inCorridor)
  return "enter_now";

// Path 2: Thesis / Momentum Elite (with score gate)
if ((flags.thesis_match || flags.momentum_elite) && score >= 60)
  return "enter_now";

// Path 3: Strong HTF/LTF
if (htfAbs >= 40 && ltfAbs >= 20 && score >= 70)
  return "enter_now";

// Path 4: Corridor + Squeeze
if (inCorridor && flags.sq30_release && score >= 70)
  return "enter_now";

// Path 5: 1H 13/48 EMA Cross — pivot change + pullback opportunity
const ema1H1348 = !!flags.ema_cross_1h_13_48;
const buyableDip1H = !!flags.buyable_dip_1h_13_48;
if (inCorridor && (ema1H1348 || buyableDip1H) && score >= 68)
  return "enter_now";
```

**Note:** The hard gate `if (edAction === "ENTRY" && !edOk) return "watch"` runs first, so we never reach these paths when entry is blocked.

---

## 3.3 Trigger Contributions to Score (computeRank / computeScore)

**Current state:** Triggers already feed into score via `triggerSummaryAndScore()` and direct flag bonuses in `computeRank()`:

| Trigger | Current contribution | Notes |
|---------|----------------------|-------|
| 1H 13/48 EMA Cross | +4 (triggers[]) or +2 (flags fallback) | Via triggerSummaryAndScore + computeRank |
| Buyable Dip 1H 13/48 | +5 (triggers[]) or +5 (flags) | Pullback toward 1H 13 EMA after cross |
| Squeeze Release 30m | +6 (triggers[]) or +4 (flags) | — |
| 30m 13/48 EMA Cross | +2 (triggers[]) | — |

**Proposed upgrade:** Increase weight of 1H 13/48 EMA Cross so it better reflects "strong pivot change and pullback opportunity":

| Trigger | Current | Proposed | Rationale |
|---------|---------|----------|-----------|
| 1H 13/48 EMA Cross | +2 (flag) / +4 (triggers) | **+5** (flag) / **+6** (triggers) | Stronger pivot/confirmation signal |
| Buyable Dip 1H 13/48 | +5 | **+7** | Pullback entry opportunity — premium signal |

**Implementation:**

1. In `triggerSummaryAndScore()`: bump `matchSide("EMA_CROSS_1H_13_48_BULL", ...)` from 4 → 6; `BUYABLE_DIP_1H_13_48` from 5 → 7.
2. In `computeRank()` (flags fallback): bump `ema_cross_1h_13_48` from 2 → 5; `buyable_dip_1h_13_48` from 5 → 7.
3. Review `triggerSummaryAndScore` cap (currently max 12); consider raising to ~18 if needed for additive trigger contributions.

---

## 4. API Response Shape

### Phase 1 (Backward Compatible)

```json
{
  "ticker": "AAPL",
  "score": 82,
  "rank": 82,
  "position": 3,
  "rank_position": 3
}
```

- `score`: canonical 0–100 value
- `rank`: deprecated alias for `score`
- `position`: canonical 1-based position
- `rank_position`: deprecated alias for `position`

### Phase 2 (After UI/Clients Migrate)

- Remove `rank` and `rank_position` from responses.

---

## 5. Implementation Phases

### Phase 1: Add Score, Fix Enter Now (Low Risk)

1. In worker ingest/output: add `score` = `rank`, add `position` = `rank_position`
2. Fix Enter Now in `classifyKanbanStage`:
   - Use `score` (fallback to `rank`)
   - Use `position` (fallback to `rank_position`)
   - Replace buggy `rank <= 20` with new combined logic
3. Update `ALERT_AND_KANBAN_REVIEW.md`
4. Deploy and verify Kanban lanes

### Phase 2: Rename Internal Terminology (Medium Risk)

1. Rename `computeRank` → `computeScore` (or leave name, document as score)
2. Replace `payload.rank` with `payload.score` in ingest path
3. Update logs, blockers (`rank_below_min` → `score_below_min`)
4. Update Discord embeds and other user-facing text

### Phase 3: Full Migration (Optional)

1. React app: use only `score` and `position`
2. Scripts: use `score` / `position`
3. Remove `rank` / `rank_position` from API responses
4. Add `ALERT_MIN_SCORE`; deprecate `ALERT_MIN_RANK`
5. DB: optional migration `rank` → `score` in column names (lower priority)

---

## 6. Verification Checklist

- [ ] Enter Now lane shows high-quality setups only (no score 0–20)
- [ ] Alert/trade sim still uses score ≥ 70 (60 for ME)
- [ ] Prime setup tag still works (score ≥ 75)
- [ ] Self-learning rank/score patterns still run
- [ ] Ledger summary `byRank` (or `byScore`) buckets unchanged
- [ ] Discord embeds display “Score” correctly
- [ ] No regressions in corridor, trigger, or HTF/LTF logic
- [ ] 1H 13/48 EMA Cross setups surface in Enter Now when in corridor with score ≥ 68

---

## 7. File-by-File Checklist

### Worker

- [ ] `classifyKanbanStage`: new Enter Now logic, use score/position, add Path 5 (1H 13/48 EMA Cross + corridor)
- [ ] `triggerSummaryAndScore`: bump 1H 13/48 EMA Cross +4→6, Buyable Dip +5→7
- [ ] `computeRank`: bump ema_cross_1h_13_48 +2→5, buyable_dip_1h_13_48 +5→7
- [ ] `computeEntryDecision`: score terminology, blocker `score_below_min`
- [ ] `shouldTriggerTradeSimulation`: use score
- [ ] Ingest path: set `payload.score = payload.rank` (or replace)
- [ ] Response builders: add `score`, `position` alongside `rank`, `rank_position`
- [ ] `computeRank` / `computeScore`: decide rename
- [ ] Self-learning: `rankPatterns` → `scorePatterns`
- [ ] Discord formatting: “Score” instead of “Rank”

### React

- [ ] Use `score` and `position` in UI
- [ ] Update tooltips and labels
- [ ] Fix any hardcoded `rank <= 10` (or similar) in filters

### Docs

- [ ] `ALERT_AND_KANBAN_REVIEW.md`: full rewrite for new logic
- [ ] `SCORING_ARCHITECTURE.md`: terminology
- [ ] `RANK_VS_WINNING_TRADES_ANALYSIS.md`: rename or update

---

## 8. Rollback

If issues occur:

1. Revert Enter Now logic to previous behavior (but fix `rank <= 20` → `score >= 75` or `position <= 20`)
2. Keep `score` / `position` in responses as additive; no removal of `rank` / `rank_position` until stable

---

## 9. Dependencies

- `position` is only set when data comes from `/timed/all` (or equivalent) where tickers are sorted. Single-ticker or ingest paths may not have it.
- When `position` is missing: rely on `score` only for Path 1 (e.g. `score >= 75`).
