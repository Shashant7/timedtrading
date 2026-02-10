# Rank vs Winning Trades — Analysis

## Summary

**Rank does correlate with trade outcomes** in your data. However, rank is used inconsistently in the Kanban logic, and other signals (RR, trigger type, HTF/LTF) may be as or more important for decision-making.

---

## 1. Empirical Evidence (Ledger Data)

From `GET /timed/ledger/summary` (202 trades, 92 closed):

| Rank Bucket | Closed (W+L) | Wins | Losses | Win Rate | PnL |
|-------------|--------------|------|--------|----------|-----|
| **70-79**   | 19           | 18   | 1      | **94.7%**| +$240 |
| **60-69**   | 35           | 22   | 13     | 62.9%    | -$40  |
| **<60**     | 38           | 12   | 26     | **31.6%**| -$697 |
| **80+**     | 0            | 0    | 0      | —        | (all open) |

**Findings:**
- **Rank 70-79** trades strongly outperform (94.7% win rate, best PnL).
- **Rank <60** trades underperform (31.6% win rate, large negative PnL).
- Your current `ALERT_MIN_RANK = 70` aligns with the best-performing bucket.

**Conclusion:** Rank is predictive of outcomes. Keeping the rank gate at 70 (60 for Momentum Elite) is supported by the data.

---

## 2. Rank vs RR — Which Matters More?

From the same ledger:

| RR Bucket  | Closed | Wins | Losses | Win Rate | PnL    |
|------------|--------|------|--------|----------|--------|
| **2.0+**   | 68     | 35   | 33     | 51.5%    | -$540  |
| **1.5-1.99**| 2     | 0    | 2      | 0%       | -$40   |
| **1.0-1.49**| 1     | 1    | 0      | 100%     | +$28   |
| **<1.0**   | 7      | 16   | 5      | 76.2%    | +$55   |

**Caveat:** Many trades are still open (`unknown` bucket dominates). The RR distribution is skewed (most trades have RR ≥ 2.0). RR alone doesn’t show as clear a pattern as rank in this sample.

---

## 3. Best Setups Analysis — Rank vs Other Signals

From `docs/BEST_SETUPS_ANALYSIS.md` (event-based analysis from trail data):

- **Prime-like** (rank ≥ 75 + corridor + completion < 40% + phase < 60%) has **lift 1.04** — modest improvement over baseline.
- **Corridor entry** and **Q4 (setup bear)** have stronger lift and recall.
- **Winner Signature** (no rank — setup + corridor + early completion) often performs better in combos.

So in the **event-based** analysis:
- **Rank is secondary** to corridor, squeeze patterns, and HTF/LTF dynamics.
- Prime-like (which includes rank) adds value but is not the top driver.

---

## 4. Kanban Enter Now — Potential Logic Bug

Current logic in `classifyKanbanStage`:

```javascript
// Top-ranked tickers (relaxed to 20 so more movement when market moves)
if (rank <= 20) {
  return "enter_now";
}
```

Here `rank` is the **0–100 score** from `computeRank()`. Higher score = better setup.

- `rank <= 20` → **worst setups** (score 0–20).
- Top setups would have scores like 75–95.

This looks reversed. For “top 20 tickers,” you likely want `rank_position <= 20` (position after sorting), not `rank <= 20` (score).

**Recommendation:** Use `rank_position <= 20` (if available) or `rank >= 80` for top setups, not `rank <= 20`.

---

## 5. Where Rank Is Used

| Use Case          | Current Logic           | Role                                      |
|-------------------|-------------------------|-------------------------------------------|
| Alert / trade sim | rank ≥ 70 (ME: 60)      | Gate: blocks low-quality setups           |
| Enter Now lane    | rank ≤ 20               | Likely inverted (see above)               |
| Self-learning     | Best rank bucket match  | Filters tickers to “winning pattern”      |
| Prime setup tag   | rank ≥ 75               | UI tag for high-quality setups            |

---

## 6. Recommendations

1. **Keep the rank gate for alerts** — 70 (60 for ME) is backed by ledger win rates.
2. **Fix Enter Now condition** — Prefer `rank >= 80` or `rank_position <= 20`, not `rank <= 20`.
3. **Avoid over-relying on rank for Kanban** — Combine with:
   - Corridor + trigger (squeeze release, EMA cross)
   - HTF/LTF strength
   - RR, completion, phase
4. **Revisit self-learning rank filter** — It uses rank buckets but needs ≥ 3 trades per bucket; with limited data it can be noisy.
5. **Add RR/trigger analysis** — RR and trigger type also affect outcomes; include them in future analyses.

---

## Data Sources

- Ledger: `GET /timed/ledger/summary?since=0&until=9999999999999`
- Best setups: `scripts/analyze-best-setups.js` → `docs/BEST_SETUPS_ANALYSIS.md`
