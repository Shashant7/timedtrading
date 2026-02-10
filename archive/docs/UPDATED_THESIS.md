# Updated Thesis (from Best Setups Analysis)

Generated: 2026-01-23  
Source report: `docs/BEST_SETUPS_ANALYSIS.md` (window: last 14 days; horizons: 4h, 1d)

## What “worked” in the data

The analysis scores “winner” outcomes (target% reached before stop%) after specific **event moments** and **snapshot states**.

Across both 4h and 1d horizons, the highest-signal patterns were:

### 1) Squeeze cycle → momentum continuation

- **Pattern: squeeze release → momentum (≤6h)** showed consistent lift.
- Strongest combo variant:
  - **Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h)**  
    (higher win rate than baseline with meaningful sample size)

**Interpretation**: We want “pressure → release → follow-through” *with HTF acceleration*, not just any squeeze.

### 2) Prime-like “quality snapshots” (selective, high lift)

The **Prime-like (snapshot)** cohort had higher win rate than baseline (small coverage but good lift).

**Interpretation**: Rank + early completion/phase + corridor + alignment/confirmation remains a strong “quality gate”.

### 3) HTF improvement matters (trend-strength confirmation)

**HTF improving** (4h / 1d) shows up repeatedly in the best combos.

**Interpretation**: The best entries happen when the higher timeframe is still *getting stronger*, not rolling over.

## Updated Thesis (what we should trade + how)

### Core Thesis (base filter)

Trade only “quality setups” that meet a tight baseline, then add catalysts:

- **Rank**: ≥ **74** (quality threshold)
- **RR**: ≥ **1.5**
- **Completion**: ≤ **0.60**
- **Phase**: ≤ **0.60**
- **Context**: prefer **in corridor** and recent corridor entry (timing), then “specials” for conviction

This is now reflected in the dashboard’s **Thesis** preset (`THESIS_PRESET.minRank = 74`).

### Catalyst layer (what upgrades a setup into a “Best Setup”)

Prioritize candidates with one (or more) of:

- **⚡ Squeeze Release** (especially when it transitions into momentum within hours)
- **🧨 In Squeeze** *building* (if close to corridor and HTF is improving)
- **🏆 Winner Signature** (early-run shortlist accelerator)
- **🚀 Momentum Elite** (fundamental strength overlay; still require clean technical context)

### Timing rule (to reduce chop / low-quality alerts)

When possible, bias toward:

- **Squeeze release within the last ~6 hours**, and/or
- **HTF improving over the last 4h/1d**, and/or
- **Corridor entry within the last ~60 minutes**

## Next upgrades (to fully operationalize this thesis)

Some of the highest-signal features (HTF deltas, “recent corridor entry”) aren’t first-class UI filters yet.
If you want, I can add them as toggles so “Thesis” can optionally enforce:

- `HTF improving (4h / 1d)`  
- `Recent corridor entry (≤60m)`  
- `Squeeze release → momentum (≤6h)` (sequence)

