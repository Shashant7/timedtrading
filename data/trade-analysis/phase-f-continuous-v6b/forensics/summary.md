# Phase-G Trade Forensics Summary

**Trades analyzed**: 213
**With forensic data**: 213

## Tag distribution

| Tag | Count | WR | Sum PnL | Avg PnL | Avg MFE | Avg MFE-exit gap |
|---|---:|---:|---:|---:|---:|---:|
| `leaky_winner` | 77 | 100.0% | +165.24% | +2.15% | +6.14% | +4.00% |
| `runner_give_back` | 75 | 100.0% | +207.70% | +2.77% | +7.16% | +4.39% |
| `clear_loser` | 48 | — | -139.45% | -2.91% | +0.72% | +3.63% |
| `chop_scratch` | 45 | 52.3% | +0.05% | +0.00% | +1.60% | +1.60% |
| `entry_extended_below_e48` | 41 | 56.8% | +9.40% | +0.23% | +4.60% | +4.37% |
| `stopped_out` | 40 | — | -109.52% | -2.74% | +0.79% | +3.53% |
| `never_worked` | 38 | — | -97.17% | -2.56% | +0.45% | +3.01% |
| `time_scaled_stop` | 26 | — | -53.39% | -2.05% | +0.71% | +2.77% |
| `big_winner` | 10 | 100.0% | +76.62% | +7.66% | +16.74% | +9.08% |
| `runner_drawdown_cap` | 7 | — | -5.18% | -0.74% | +1.07% | +1.81% |
| `dead_money_flat` | 5 | — | -5.30% | -1.06% | +0.51% | +1.57% |
| `clean_winner` | 5 | 100.0% | +1.93% | +0.39% | +0.46% | +0.07% |
| `entry_extended_above_e48` | 2 | — | -8.41% | -4.20% | +0.51% | +4.71% |
| `event_clipped` | 1 | — | -0.72% | -0.72% | +0.40% | +1.12% |

## Cohort × tag rollup

### Index_ETF

| Tag | Count | WR | Sum PnL | Avg PnL | Avg MFE | Avg MFE-exit gap |
|---|---:|---:|---:|---:|---:|---:|
| `chop_scratch` | 11 | 54.5% | +0.41% | +0.04% | +1.04% | +1.00% |
| `leaky_winner` | 8 | 100.0% | +11.44% | +1.43% | +3.94% | +2.52% |
| `runner_give_back` | 7 | 100.0% | +11.62% | +1.66% | +4.38% | +2.72% |
| `clear_loser` | 5 | — | -10.90% | -2.18% | +0.28% | +2.46% |
| `dead_money_flat` | 4 | — | -4.37% | -1.09% | +0.45% | +1.55% |
| `never_worked` | 4 | — | -9.19% | -2.30% | +0.26% | +2.55% |
| `stopped_out` | 4 | — | -9.19% | -2.30% | +0.26% | +2.55% |
| `time_scaled_stop` | 4 | — | -9.19% | -2.30% | +0.26% | +2.55% |
| `clean_winner` | 4 | 100.0% | +1.57% | +0.39% | +0.43% | +0.04% |

### MegaCap

| Tag | Count | WR | Sum PnL | Avg PnL | Avg MFE | Avg MFE-exit gap |
|---|---:|---:|---:|---:|---:|---:|
| `runner_give_back` | 30 | 100.0% | +78.23% | +2.61% | +6.65% | +4.05% |
| `leaky_winner` | 28 | 100.0% | +63.94% | +2.28% | +6.12% | +3.83% |
| `clear_loser` | 20 | — | -57.83% | -2.89% | +0.67% | +3.56% |
| `stopped_out` | 17 | — | -48.80% | -2.87% | +0.72% | +3.59% |
| `never_worked` | 16 | — | -41.48% | -2.59% | +0.37% | +2.96% |
| `chop_scratch` | 13 | 46.2% | +0.04% | +0.00% | +1.65% | +1.64% |
| `time_scaled_stop` | 12 | — | -27.96% | -2.33% | +0.70% | +3.03% |
| `entry_extended_below_e48` | 12 | 63.6% | +7.72% | +0.64% | +5.21% | +4.57% |
| `big_winner` | 3 | 100.0% | +16.49% | +5.50% | +12.73% | +7.24% |
| `runner_drawdown_cap` | 2 | — | -2.26% | -1.13% | +0.96% | +2.08% |
| `clean_winner` | 1 | 100.0% | +0.37% | +0.37% | +0.57% | +0.20% |

### Industrial

| Tag | Count | WR | Sum PnL | Avg PnL | Avg MFE | Avg MFE-exit gap |
|---|---:|---:|---:|---:|---:|---:|
| `leaky_winner` | 13 | 100.0% | +24.04% | +1.85% | +5.34% | +3.50% |
| `runner_give_back` | 12 | 100.0% | +23.67% | +1.97% | +5.60% | +3.63% |
| `entry_extended_below_e48` | 9 | 37.5% | -3.97% | -0.44% | +2.85% | +3.29% |
| `stopped_out` | 7 | — | -15.32% | -2.19% | +1.16% | +3.35% |
| `clear_loser` | 5 | — | -14.46% | -2.89% | +0.91% | +3.80% |
| `chop_scratch` | 5 | 40.0% | -0.35% | -0.07% | +1.63% | +1.70% |
| `time_scaled_stop` | 4 | — | -5.85% | -1.46% | +1.07% | +2.54% |
| `never_worked` | 3 | — | -7.65% | -2.55% | +0.41% | +2.96% |
| `runner_drawdown_cap` | 1 | — | -0.76% | -0.76% | +2.13% | +2.89% |
| `dead_money_flat` | 1 | — | -0.93% | -0.93% | +0.73% | +1.66% |

### Speculative

| Tag | Count | WR | Sum PnL | Avg PnL | Avg MFE | Avg MFE-exit gap |
|---|---:|---:|---:|---:|---:|---:|
| `leaky_winner` | 11 | 100.0% | +41.10% | +3.74% | +10.16% | +6.43% |
| `runner_give_back` | 9 | 100.0% | +48.07% | +5.34% | +13.31% | +7.98% |
| `clear_loser` | 8 | — | -26.71% | -3.34% | +0.91% | +4.24% |
| `entry_extended_below_e48` | 8 | 71.4% | +9.83% | +1.23% | +8.97% | +7.75% |
| `never_worked` | 6 | — | -14.65% | -2.44% | +0.65% | +3.09% |
| `stopped_out` | 6 | — | -19.24% | -3.21% | +0.84% | +4.05% |
| `big_winner` | 4 | 100.0% | +35.76% | +8.94% | +20.36% | +11.42% |
| `time_scaled_stop` | 3 | — | -6.52% | -2.17% | +0.47% | +2.64% |
| `chop_scratch` | 3 | 66.7% | -0.25% | -0.08% | +1.12% | +1.21% |
| `runner_drawdown_cap` | 2 | — | -1.15% | -0.58% | +0.80% | +1.39% |
| `event_clipped` | 1 | — | -0.72% | -0.72% | +0.40% | +1.12% |

### Semi

| Tag | Count | WR | Sum PnL | Avg PnL | Avg MFE | Avg MFE-exit gap |
|---|---:|---:|---:|---:|---:|---:|
| `leaky_winner` | 17 | 100.0% | +24.72% | +1.45% | +5.22% | +3.77% |
| `runner_give_back` | 17 | 100.0% | +46.11% | +2.71% | +7.03% | +4.32% |
| `chop_scratch` | 13 | 58.3% | +0.19% | +0.01% | +2.14% | +2.13% |
| `entry_extended_below_e48` | 12 | 54.5% | -4.18% | -0.35% | +2.38% | +2.73% |
| `clear_loser` | 8 | — | -22.58% | -2.82% | +0.99% | +3.81% |
| `never_worked` | 8 | — | -19.03% | -2.38% | +0.61% | +2.99% |
| `stopped_out` | 6 | — | -16.96% | -2.83% | +0.86% | +3.69% |
| `time_scaled_stop` | 3 | — | -3.87% | -1.29% | +1.11% | +2.41% |
| `big_winner` | 3 | 100.0% | +24.37% | +8.12% | +15.93% | +7.81% |
| `runner_drawdown_cap` | 2 | — | -1.01% | -0.50% | +0.93% | +1.43% |
| `entry_extended_above_e48` | 1 | — | -3.24% | -3.24% | +0.90% | +4.14% |

### Other

| Tag | Count | WR | Sum PnL | Avg PnL | Avg MFE | Avg MFE-exit gap |
|---|---:|---:|---:|---:|---:|---:|
| `clear_loser` | 2 | — | -6.96% | -3.48% | +0.08% | +3.56% |
| `never_worked` | 1 | — | -5.17% | -5.17% | +0.11% | +5.28% |
| `entry_extended_above_e48` | 1 | — | -5.17% | -5.17% | +0.11% | +5.28% |

## ATR Level reach by cohort × horizon

How far along the Fib-ATR ladder each cohort's trades actually reach at their favorable peak.

### Semi

| Horizon | Max ratio | Count |
|---|---:|---:|
| day | 0.236 | 5 |
| day | 0.382 | 4 |
| day | 0.5 | 2 |
| day | 0.618 | 7 |
| day | 0.786 | 3 |
| day | 1 | 3 |
| day | 1.236 | 1 |
| day | 2 | 1 |
| day | 3 | 1 |
| week | 0.236 | 6 |
| week | 0.382 | 2 |
| week | 0.5 | 2 |
| week | 0.618 | 2 |
| week | 0.786 | 3 |
| week | 1.236 | 1 |
| month | 0.236 | 4 |
| month | 0.382 | 1 |
| month | 0.5 | 2 |
| month | 0.786 | 1 |
| quarter | 0.236 | 3 |
| quarter | 0.382 | 1 |

### MegaCap

| Horizon | Max ratio | Count |
|---|---:|---:|
| day | 0.236 | 6 |
| day | 0.382 | 7 |
| day | 0.5 | 5 |
| day | 0.618 | 5 |
| day | 0.786 | 8 |
| day | 1 | 7 |
| day | 1.236 | 4 |
| day | 1.618 | 4 |
| day | 2 | 1 |
| day | 2.618 | 5 |
| day | 3 | 3 |
| week | 0.236 | 16 |
| week | 0.382 | 8 |
| week | 0.5 | 8 |
| week | 0.618 | 5 |
| week | 0.786 | 6 |
| week | 1 | 1 |
| week | 1.236 | 1 |
| week | 1.618 | 1 |
| month | 0.236 | 7 |
| month | 0.382 | 1 |
| month | 0.5 | 1 |
| month | 0.618 | 3 |
| quarter | 0.236 | 3 |
| quarter | 0.382 | 1 |
| quarter | 0.5 | 1 |
| longterm | 0.236 | 1 |

### Index_ETF

| Horizon | Max ratio | Count |
|---|---:|---:|
| day | 0.236 | 1 |
| day | 0.382 | 5 |
| day | 0.5 | 2 |
| day | 0.618 | 3 |
| day | 0.786 | 3 |
| day | 1.236 | 4 |
| day | 1.618 | 4 |
| day | 2 | 3 |
| day | 2.618 | 1 |
| day | 3 | 2 |
| week | 0.236 | 11 |
| week | 0.382 | 5 |
| week | 0.5 | 4 |
| week | 0.618 | 3 |
| week | 0.786 | 3 |
| week | 1 | 2 |
| month | 0.236 | 7 |
| month | 0.382 | 2 |
| month | 0.618 | 2 |
| quarter | 0.236 | 5 |

### Speculative

| Horizon | Max ratio | Count |
|---|---:|---:|
| day | 0.236 | 2 |
| day | 0.5 | 3 |
| day | 0.618 | 4 |
| day | 1 | 2 |
| day | 1.236 | 2 |
| day | 1.618 | 2 |
| day | 2 | 2 |
| day | 2.618 | 1 |
| day | 3 | 2 |
| week | 0.236 | 6 |
| week | 0.382 | 1 |
| week | 0.5 | 4 |
| week | 0.618 | 1 |
| week | 0.786 | 3 |
| week | 1 | 2 |
| week | 1.236 | 1 |
| month | 0.236 | 2 |
| month | 0.382 | 4 |
| month | 0.618 | 1 |
| month | 0.786 | 1 |
| quarter | 0.236 | 5 |

### Industrial

| Horizon | Max ratio | Count |
|---|---:|---:|
| day | 0.236 | 3 |
| day | 0.382 | 2 |
| day | 0.618 | 4 |
| day | 1 | 2 |
| day | 1.236 | 4 |
| day | 1.618 | 1 |
| day | 2 | 3 |
| week | 0.236 | 3 |
| week | 0.382 | 1 |
| week | 0.5 | 3 |
| week | 0.618 | 2 |
| week | 0.786 | 1 |
| week | 1 | 2 |
| month | 0.236 | 1 |
| month | 0.382 | 1 |
| month | 0.618 | 1 |
| quarter | 0.236 | 2 |

### Other

| Horizon | Max ratio | Count |
|---|---:|---:|
| day | 0.618 | 1 |
| day | 0.786 | 1 |
| week | 0.382 | 2 |
| week | 0.786 | 1 |
| quarter | 0.236 | 1 |
