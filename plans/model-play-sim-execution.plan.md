---
name: Model Play Sim Execution
overview: 'When the model picks Shares / LETF / Options, the simulation book fills that vehicle — not always shares with counterfactual grading. Dogfood PnL matches the chosen play.'
todos:
  - id: options-paper-fill
    content: 'Long-premium options paper fill (debit calls/puts/LEAPs) sized to risk budget; BS mark-to-market; underlying SL/TP exit triggers.'
    status: completed
  - id: letf-paper-fill
    content: 'LETF fill as stock-like position in mapped ticker when live price available.'
    status: completed
  - id: wire-entry-mtm
    content: 'Wire fill after vehicle menu; executed_vehicle on model_play signal; computeTradePnlComponents marks options honestly.'
    status: completed
  - id: flag-tests
    content: 'Config flag + unit tests; update play-the-move doctrine + lifecycle plan.'
    status: completed
isProject: true
---

# Model Play Sim Execution

## Why

Selecting Shares / LETF / Options without simulating the pick means dogfood still tracks the shares book. Eat our own cooking: **fill what the model chose**.

## Scope (MVP)

| Vehicle | Sim fill |
|---------|----------|
| **Shares** | Unchanged (baseline) |
| **Options** | Long **debit** single-leg only (long_call / long_put / leap_* / moonshot debit). Size contracts from risk budget ÷ max loss. Cash debits premium×100×contracts. MTM via Black-Scholes on underlying + DTE. Exit when **underlying** hits SL/TP (or expiry). |
| **LETF** | Stock-like fill of mapped LETF ticker when `timed:prices` has a quote; else fall back to shares. |

Out of scope for MVP: credit spreads, covered calls, naked shorts, real option chain marks store, broker bridge fills.

## Config

`deep_audit_model_play_sim_enabled` — default **false** until D1 hydrates `options_paper` / `letf_paper` and close/trim cash is vehicle-aware. Code path is wired; flip on only after persistence. Replay stays shares-only unless `deep_audit_model_play_sim_replay=true`.

## Honesty

- Options PnL is **modeled premium**, not a live OPRA mark (until chain marks are persisted).
- Label marks `mark_source: "bs_atr_proxy"` so UI/scorecard never claim exchange fills.
- `signal_outcomes` `executed_vehicle` matches the fill.
