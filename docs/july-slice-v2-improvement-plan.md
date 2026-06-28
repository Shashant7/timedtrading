# July slice v2 — improvement plan

> Source: counterfactual analysis of `phase-d-slice-2025-07-v2` (42 trades)
> vs anchor `phase-c-slice-2025-07-v1` (25 trades).
> Artifacts: `data/trade-analysis/phase-d-slice-2025-07-v2/trades.json`.

## Problem statement

v2 matches anchor **return** (+25.64% vs +26.05%) but **fails on quality**
(45% WR vs 76%). The gap is not spread across all paths — it concentrates in
two buckets:

| Cohort | Trades | WR | Sum pnl_pct | Share of damage |
|--------|--------|-----|-------------|-----------------|
| **Index (SPY/QQQ/IWM)** | 15 | 20.0% | **−4.59%** | Primary drag |
| Non-index | 27 | 59.3% | **+30.23%** | Carries portfolio |
| `tape_capitulation_force_exit` (all tickers) | 13 | — | **−3.75%** | Secondary bleed |

Non-index performance alone would **beat the anchor** on WR and PnL. The July
regression is almost entirely **index participation + scratch exits on weak
index holds**.

---

## Path scorecard (v2)

| Entry path | n | WR | Sum pnl_pct | Action |
|------------|---|-----|-------------|--------|
| `tt_ath_breakout` | 17 | 58.8% | +23.35 | **Keep on singles**; block/tighten on index |
| `tt_pullback` | 13 | 38.5% | +2.21 | Keep singles; index pullbacks are net negative |
| `tt_n_test_support` | 8 | 37.5% | +0.22 | Demote on index; marginal elsewhere |
| `tt_range_reversal_long` | 4 | 25.0% | −0.14 | Block in STRONG_BULL (matrix should; verify replay) |

**Do not blanket-block ATH breakout.** Learning-bus demotion of ATH would cut
the best-performing cohort on single names (+23.35% from 11 non-index ATH
trades at 72.7% WR).

---

## Counterfactual simulations (same trade ledger)

These filter **existing** trades — they estimate how much each lever removes
damage without re-running the engine. Replays are required to confirm.

| Filter | Trades | WR | Sum pnl_pct |
|--------|--------|-----|-------------|
| Baseline v2 | 42 | 45.2% | +25.64% |
| Remove index entries | 27 | **59.3%** | **+30.23%** |
| Remove index + support + range reversal | 18 | **66.7%** | **+28.43%** |
| Remove index + no capitulation exits* | 19 | **73.7%** | **+33.04%** |
| Anchor v1 | 25 | 76.0% | +26.05% |

\*Capitulation counterfactual is optimistic — those trades would have stayed
open longer; use as an upper bound, not a promise.

**Highest-confidence lever:** stop index ETF entries (returns to ~anchor trade
count with better WR and higher PnL).

---

## Recommended changes (priority order)

### P0 — Revert index ETF unlock (est. +4.6 pp pnl, +14 pp WR)

**Why:** Phase C anchor had **zero** index entries by design (pullback depth +
rank floor 90). v2 synced config enabled T6-style overrides:

- `deep_audit_pullback_min_bearish_count_index_etf` (relaxes depth gate)
- `deep_audit_pullback_non_prime_min_rank_index_etf` (lowers rank floor)
- `deep_audit_index_etf_swing_enabled=true` (Phase E swing trigger)

**IWM alone:** 7 trades, 0% WR, −4.20% — more damage than any single name.

**Config actions (pick one bundle):**

```text
# Option A — hard off (matches anchor behavior)
deep_audit_index_etf_swing_enabled = false
# Remove or unset index pullback overrides so defaults apply:
deep_audit_pullback_min_bearish_count_index_etf = (unset → falls back to 2)
deep_audit_pullback_non_prime_min_rank_index_etf = (unset → falls back to 90)
```

```text
# Option B — keep swing path but much pickier (if index exposure is desired)
deep_audit_index_etf_swing_min_score = 95        # was 92
deep_audit_index_etf_swing_rvol_min = 1.2        # was 0.7
deep_audit_pullback_min_bearish_count_index_etf = 2  # stop relaxing to 0/1
```

**Validation:** Re-run `phase-d-slice-2025-07-v3` on preprod after config
sync. Target: ≤28 trades, WR ≥ 60%, sum pnl_pct ≥ +26%.

---

### P1 — Block support bounce + range reversal on index ETFs

**Why:** IWM took support (rank 67, 98) and range reversal entries — all
losers. Singles support is marginal (+0.22% on 8 trades) but not catastrophic.

**Config / code:**

- Add `deep_audit_block_setups_index_etf=tt_n_test_support,tt_range_reversal_long`
  OR wire admission-matrix block for index tickers on those paths.
- Enforce existing matrix: `tt_range_reversal_long:LONG:Prime` allows only
  `NEUTRAL, EARLY_BULL, COUNTER_TREND_BULL` — July is 82% STRONG_BULL; verify
  why IWM/META range entries fired (regime label mismatch in replay?).

**Est. impact:** −6 trades, WR +2–4 pp (marginal on top of P0).

---

### P2 — Wire setup demotion keys (selective, not blanket ATH)

**Why:** `deep_audit_setup_demotion_*=blocked` keys are written by the learning
bus but **never read at entry** — only the KV admission matrix applies.

**Wire in `tt-core-entry.js` before `admitSetup()`:**

```javascript
const demotionKey = `deep_audit_setup_demotion_${path}_${effectiveDir.toLowerCase()}`;
if (String(daCfg[demotionKey] || "").toLowerCase() === "blocked") {
  // reject entry
}
```

**Important:** Applied demotions include ATH and support. For July:

- **Apply support demotion** — aligns with path scorecard.
- **Do NOT apply ATH demotion globally** — would cut +23% winners on singles.
- Consider demotion keys scoped by ticker cohort (`index_etf`) instead.

---

### P3 — Tune tape capitulation force exit on index / young trades

**Why:** 13 exits at net −3.75%. Rule today (`index.js` ~9395):

- `shouldTightenLongsForTape(tape)` AND `pnlPct < 0` AND `ageMin >= 60`

Many are **small scratches** on index names that never developed (SPY −0.20%,
QQQ −0.17/−0.26%, IWM −0.14/−0.16%). Capitulation is doing its job on
losers but also churns marginal index entries.

**Proposals:**

1. Skip capitulation force when ticker ∈ `{SPY, QQQ, IWM}` and entry path is
   pullback/ATH (index churn path).
2. Require `pnlPct <= -0.5%` (not just `< 0`) before force exit.
3. Skip when `mfePct >= 0.5%` ever reached (trade had a chance to work).

**Est. impact:** +1–2 pp pnl if index entries are already blocked (P0); smaller
standalone.

---

### P4 — Earnings-cluster entry gate (Phase C T3)

**Why:** SWK −3.21% (`HARD_LOSS_CAP`, rank 100, pullback) and SGI −1.06% align
with Phase C's Jul 28–30 cluster pattern.

**Proposal (from `proposed_tuning.md` T3):** Block new entries on anchor day ±1
when ≥4-ticker earnings cluster, unless rank ≥ 97 and sector RS ≥ 0.

**Est. impact:** +3–4 pp on July; must replay Oct/Jan (cluster months) before merge.

---

### P5 — Exit path: do not disable MFE ratchet; revisit SL on index

**Observation:** Anchor used `mfe_proportional_trail` (6 exits). v2 shows
`sl_breached` (13) but net **+14.92%** on those — trailing SL is capturing
winners (IESC +6.4%, CDNS +7.4% via TP_FULL, GOOGL +2.73% via SL).

**Do not revert MFE ratchet** — 4 exits, +4.71%, working as backstop.

**Do tighten entry** on index rather than loosen exits — exit mix is a symptom.

---

## What NOT to do

| Proposal | Why skip for July |
|----------|-------------------|
| Blanket ATH demotion | Cuts +23% on non-index ATH winners |
| Raise SHORT min rank further | July slice is 100% LONG |
| Enable bleeder shield | OFF in anchor; adds complexity |
| Enable conviction fusion | OFF in anchor; hold per readiness doc |

---

## Validation protocol

1. Apply P0 config on preprod (`sync-model-config-to-preprod.mjs` after edits).
2. Re-run July slice: `phase-d-slice-2025-07-v3`.
3. Compare to v1 anchor AND v2 (regression budget: WR within 2 pp of best
   month, pnl within 10% per Phase C anti-overfit rules).
4. If P0 passes, add P1–P2 one at a time — never bundle without attribution.
5. Run `scripts/compare-block-chains.js` v2 vs v3 on index tickers to confirm
   block reasons return to `tt_pullback_not_deep_enough` / rank floor.

---

## Quick wins vs anchor profile

Target profile after P0 + selective P1:

| Metric | Target |
|--------|--------|
| Trades | 24–28 |
| WR | ≥ 65% (stretch: 70%+) |
| Sum pnl_pct | ≥ +28% |
| Index entries | 0–2 (probe only) |
| Big winners | ≥ 2 (keep CDNS + IESC-class ATH) |

This restores **anchor-like selectivity** while keeping the current single-name
ATH and pullback paths that actually worked in v2.
