# V11 Exit-Policy Simulation

Run: `phase-i-v11-1776897135`

Generated: 2026-04-24T01:06:36.641392+00:00

Trades simulated: 177

Of those, 114 actually trimmed in V11 — the other 63 behave identically under single-exit / trim-variant.


## Aggregate comparison

| Policy | Total PnL % | Δ vs Quo | WR | Avg Win | Avg Loss | PF | Median |
|---|---:|---:|---:|---:|---:|---:|---:|
| **STATUS_QUO** | +62.53% | — | 52.0% | +1.85% | -1.33% | 1.58 | +0.12% |
| **SINGLE_EXIT** | +30.67% | -31.86% | 36.7% | +2.74% | -1.43% | 1.21 | -0.25% |
| **TRIM_25** | +58.31% | -4.22% | 46.9% | +2.20% | -1.38% | 1.47 | -0.04% |
| **TRIM_75** | +113.59% | +51.06% | 61.6% | +1.91% | -1.48% | 2.20 | +0.39% |
| **MFE_LOCK** | +297.31% | +234.78% | 70.6% | +2.38% | +0.00% | ∞ | +0.80% |
| **NO_RUNNER_CAP** | +340.71% | +278.18% | 89.8% | +2.14% | +0.00% | ∞ | +1.13% |

## Policy descriptions

- **STATUS_QUO** — V11 actual (trim-and-run baseline)
- **SINGLE_EXIT** — Never trim, ride to V11's final exit rule
- **TRIM_25** — Trim 25% at TP1, 75% runner to V11 exit
- **TRIM_75** — Trim 75% at TP1, 25% runner to V11 exit
- **MFE_LOCK** — Trim 50%, runner exits at MFE - 0.5%
- **NO_RUNNER_CAP** — Trim 50%, runner exits at MFE peak (upper bound)

## Top trades where TRIM_25 would have beat status quo

| Ticker | Entry | V11 Status Quo | Trim-25 | Δ | MFE |
|---|---|---:|---:|---:|---:|
| IAU | 01-08 | +2.89% | +6.65% | +3.76% | 6.65 |
| GLD | 01-08 | +2.90% | +6.64% | +3.74% | 6.64 |
| GOOGL | 09-02 | +8.43% | +11.32% | +2.89% | 11.32 |
| GOOGL | 01-05 | +4.67% | +6.85% | +2.18% | 5.09 |
| GOOGL | 07-17 | +2.55% | +4.45% | +1.89% | 5.03 |
| PWR | 09-25 | +7.84% | +9.67% | +1.82% | 12.21 |
| JCI | 07-16 | +3.30% | +4.74% | +1.44% | 4.97 |
| FN | 12-03 | +5.16% | +6.39% | +1.23% | 17.87 |
| LITE | 07-14 | +4.87% | +6.04% | +1.16% | 13.15 |
| NXT | 07-22 | +3.12% | +4.10% | +0.98% | 4.98 |

## Top trades where TRIM_75 would have beat status quo

| Ticker | Entry | V11 Status Quo | Trim-75 | Δ | MFE |
|---|---|---:|---:|---:|---:|
| IAU | 01-08 | +2.89% | +6.65% | +3.76% | 6.65 |
| GLD | 01-08 | +2.90% | +6.64% | +3.74% | 6.64 |
| GOOGL | 09-02 | +8.43% | +11.32% | +2.89% | 11.32 |
| B | 02-26 | -3.87% | -1.27% | +2.60% | 1.99 |
| PWR | 09-25 | +7.84% | +10.33% | +2.49% | 12.21 |
| GOOGL | 01-05 | +4.67% | +6.85% | +2.18% | 5.09 |
| GOOGL | 07-17 | +2.55% | +4.45% | +1.89% | 5.03 |
| EME | 09-10 | +2.11% | +3.95% | +1.85% | 5.28 |
| IBP | 10-21 | +3.41% | +5.11% | +1.70% | 6.82 |
| PWR | 01-28 | -1.96% | -0.47% | +1.49% | 0.73 |

## Specific audits (user-flagged)

### MSFT LONG — 2025-10-02 18:00

- Entry: $516.98 · Trim: $521.75 (50%) @ 2025-10-06 13:30 · Exit: $522.00 @ 2025-10-09 14:00
- MFE: 2.56% · MAE: -0.24%
- V11 realized PnL: +0.95% · exit reason: `atr_week_618_full_exit`
- Status-quo: +0.95%
- Single-exit: +0.97%
- Trim-25: +0.96%
- Trim-75: +0.93%
- MFE-lock: +1.49%
- No-runner-cap (upper bound): +1.74%

### TSLA LONG — 2025-12-11 18:30

- Entry: $447.02 · Trim: $472.29 (100%) @ 2025-12-16 14:30 · Exit: $472.29 @ 2025-12-16 14:30
- MFE: 7.21% · MAE: -0.40%
- V11 realized PnL: +6.26% · exit reason: `TP_FULL`
- Status-quo: +6.26%
- Single-exit: +5.65%
- Trim-25: +5.65%
- Trim-75: +5.65%
- MFE-lock: +6.18%
- No-runner-cap (upper bound): +6.43%

