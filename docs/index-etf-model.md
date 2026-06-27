# Index ETF Model (SPY / QQQ / IWM)

Indices are **not stocks**. SPY moves in slow, defined daily ranges; TSLA
does not. Each index ticker has its own profile.

## Design principle

| Stock model | Index model |
|-------------|---------------|
| ATH breakout, deep pullback ST flips | Slow range rotation inside D21/D48 band |
| rvol ≥ 1.0+, rank 95+ | SPY rvol ≥ 0.45, rank ≥ 88 |
| Wide MFE trail (multi-%) | Ride-runner at **0.6% MFE** for SPY |
| Stock SL ATR | **0.5% max stop** for SPY |

## Routing

SPY/QQQ/IWM enter **only** via `tt_index_etf_swing`. Stock paths
(`tt_pullback`, `tt_ath_breakout`, etc.) are blocked on index tickers.

## Per-ticker entry profiles (code defaults)

| Ticker | rvol min | rank min | pct_above_e48 band | e21 slope | ride MFE |
|--------|----------|----------|----------------------|-----------|----------|
| SPY | 0.45 | 88 | 0.4 – 2.8% | 0.12 – 1.0% | 0.6% |
| QQQ | 0.55 | 90 | 0.6 – 3.5% | 0.18 – 1.5% | 0.7% |
| IWM | 0.60 | 90 | 0.8 – 4.5% | 0.22 – 2.0% | 0.8% |

Allowed states: `HTF_BULL_LTF_PULLBACK` **and** `HTF_BULL_LTF_BULL` (slow
grind in calm uptrends — July SPY +2.34% monthly).

LTF: in-cloud holds OK for SPY/QQQ/IWM (no forced m30 reclaim).

## Management (`etf-profile.js`)

Per-index TP ladder and stop overrides merged into `getEtfProfile(ticker)`.

## Config overrides

Per-ticker DA keys: `deep_audit_index_model_spy_min_rank`, `_rvol_min`, etc.

Module: `worker/pipeline/index-etf-model.js`

## Singles regression guard

Setup demotion applies **index tickers only**
(`deep_audit_setup_demotion_index_only=true`). Singles keep support/range paths.
