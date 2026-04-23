#!/usr/bin/env bash
# V12 Killer Strategy — activation script.
#
# Writes all V12 DA keys to model_config. Run after worker deploy.
# See tasks/v12-killer-strategy-2026-04-23.md for the playbook.
#
# Usage:
#   TIMED_API_KEY=... bash scripts/v12-activate-killer-strategy.sh
#
# Activates:
#   - P1: fast-cut relaxation (age>=2h, MAE>=0.5%)
#   - P2: full rank_trace coverage
#   - P3: let-winners-run guard (MFE>=3% near-peak)
#   - P4: SHORT gate relaxation (bearish_mixed floor + ticker-daily-bear)
#   - P5: tt_momentum retune (wider TPs, tighter entries)
#   - P6: ETF Precision Gate (SPY/QQQ/IWM/DIA 10-filter mandatory)
#   - Stale-OPEN polarity fix + runner time cap

set -euo pipefail
API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY:?TIMED_API_KEY required}"

read -r -d '' PAYLOAD <<'JSON' || true
{
  "updates": [
    { "key": "deep_audit_mfe_fast_cut_min_age_hours", "value": "2" },
    { "key": "deep_audit_mfe_fast_cut_max_mae_pct", "value": "0.5" },
    { "key": "deep_audit_mfe_fast_cut_honor_retrigger", "value": "true" },

    { "key": "deep_audit_rank_trace_force_enabled", "value": "true" },
    { "key": "deep_audit_rank_trace_on_entry_always", "value": "true" },

    { "key": "deep_audit_winner_protect_enabled", "value": "true" },
    { "key": "deep_audit_winner_protect_min_mfe_pct", "value": "3.0" },
    { "key": "deep_audit_winner_protect_near_mfe_gap_pct", "value": "0.5" },

    { "key": "deep_audit_short_spy_regime_floor", "value": "bearish_mixed" },
    { "key": "deep_audit_short_requires_ticker_bearish_daily", "value": "true" },
    { "key": "deep_audit_short_sector_strength_gate", "value": "false" },

    { "key": "deep_audit_tt_momentum_tp1_pct", "value": "2.0" },
    { "key": "deep_audit_tt_momentum_tp2_pct", "value": "4.0" },
    { "key": "deep_audit_tt_momentum_min_rvol", "value": "2.0" },
    { "key": "deep_audit_tt_momentum_bar_position_min", "value": "0.60" },

    { "key": "deep_audit_etf_precision_gate_enabled", "value": "true" },
    { "key": "deep_audit_etf_precision_tickers", "value": "SPY,QQQ,IWM,DIA" },
    { "key": "deep_audit_etf_precision_min_rank", "value": "90" },
    { "key": "deep_audit_etf_precision_daily_ema_pullback_pct", "value": "1.5" },
    { "key": "deep_audit_etf_precision_daily_rsi_min", "value": "40" },
    { "key": "deep_audit_etf_precision_daily_rsi_max", "value": "65" },
    { "key": "deep_audit_etf_precision_vix_max", "value": "25" },
    { "key": "deep_audit_etf_precision_breadth_min", "value": "50" },
    { "key": "deep_audit_etf_precision_macro_event_hours", "value": "48" },
    { "key": "deep_audit_etf_precision_stop_atr_mult", "value": "1.5" },
    { "key": "deep_audit_etf_precision_min_hold_hours", "value": "24" },
    { "key": "deep_audit_etf_precision_max_hold_days", "value": "14" },

    { "key": "deep_audit_stale_position_force_close_days", "value": "45" },
    { "key": "deep_audit_stale_pnl_breakout_pct", "value": "2.0" },
    { "key": "deep_audit_stale_near_mfe_gap_pct", "value": "0.5" },
    { "key": "deep_audit_trim_runner_time_cap_days", "value": "30" },
    { "key": "deep_audit_mfe_persist_on_open", "value": "true" }
  ]
}
JSON

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] V12 killer strategy ON (31 DA keys)"
curl -sS -m 30 -X POST "$API_BASE/timed/admin/model-config?key=$API_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD" | python3 -m json.tool
