"""Flatten trades.json into a feature table for analysis."""
import json
import datetime as dt
from pathlib import Path

TRADES_FILE = Path("/workspace/data/trade-analysis/phase-c-stage1-jul2025-may2026/trades.json")
OUT_FILE = Path("/workspace/tasks/phase-c/scripts/features.jsonl")


def safe_get(d, *keys, default=None):
    cur = d
    for k in keys:
        if cur is None:
            return default
        if isinstance(cur, dict):
            cur = cur.get(k)
        else:
            return default
    return cur if cur is not None else default


def flatten_trade(t):
    r = {}
    for k in [
        "trade_id", "ticker", "direction", "status", "entry_ts", "entry_price",
        "exit_ts", "exit_price", "pnl", "pnl_pct", "notional", "shares", "rank", "rr",
        "setup_name", "setup_grade", "entry_path", "sector", "trim_ts", "trim_price",
        "trimmed_pct", "max_favorable_excursion", "max_adverse_excursion", "exit_reason",
        "risk_budget"
    ]:
        r[k] = t.get(k)

    # Derived: closed-trade flag
    r["is_closed"] = r["status"] in ("WIN", "LOSS", "TP_HIT_TRIM")
    # Treat TP_HIT_TRIM as a winner-bucket (still locked profit)
    r["bucket"] = (
        "WIN" if r["status"] in ("WIN", "TP_HIT_TRIM")
        else "LOSS" if r["status"] == "LOSS"
        else "OPEN"
    )

    if r["entry_ts"]:
        d = dt.datetime.fromtimestamp(r["entry_ts"]/1000.0, dt.timezone.utc)
        # NY = UTC-4 (Jul/Aug DST)
        nyd = d - dt.timedelta(hours=4)
        r["entry_hour_ny"] = nyd.hour
        r["entry_minute_ny"] = nyd.minute
        r["entry_dow"] = nyd.weekday()  # 0=Mon
        r["entry_date"] = nyd.strftime("%Y-%m-%d")
    if r["exit_ts"] and r["entry_ts"]:
        r["hold_h"] = (r["exit_ts"] - r["entry_ts"]) / 3_600_000.0

    # entry_signals_json
    es_raw = t.get("entry_signals_json")
    es = json.loads(es_raw) if isinstance(es_raw, str) else (es_raw or {})
    for k in [
        "has_adverse_rsi_div", "has_adverse_phase_div", "is_f4_severe",
        "adverse_phase_strongest_tf", "daily_td9_adverse", "daily_adverse_prep",
        "fourh_adverse_prep", "td9_bear_ltf_active", "pdz_d", "pdz_4h",
        "personality", "regime_class"
    ]:
        r["es_" + k] = es.get(k)
    r["loop_events"] = es.get("loop_events", [])

    # rank_trace setup_snapshot
    rt_raw = t.get("rank_trace_json")
    rt = json.loads(rt_raw) if isinstance(rt_raw, str) else (rt_raw or {})
    ss = (rt or {}).get("setup_snapshot") or {}

    r["focus_tier"] = (rt or {}).get("focus_tier")
    r["focus_conviction_score"] = (rt or {}).get("focus_conviction_score")
    r["finalScore"] = (rt or {}).get("finalScore")
    r["rawScore"] = (rt or {}).get("rawScore")

    for k in [
        "selected_path", "state", "htf_score", "ltf_score", "st_dir",
        "rsi", "rr", "bull_stack", "bear_stack", "above_e200",
        "pct_above_e21", "pct_above_e48", "e21_slope_5d",
        "rvol_best", "rvol_30m", "regime_class", "regime_combined",
        "ticker_personality", "execution_profile", "sector",
        "sector_alignment", "ath_breakout", "range_reversal", "gap_reversal",
        "n_test_support", "index_etf_swing", "upcoming_risk_event"
    ]:
        r["ss_" + k] = ss.get(k)

    # PDZ
    pdz = ss.get("pdz") or {}
    r["pdz_D"] = pdz.get("D")
    r["pdz_h4"] = pdz.get("h4")
    r["pdz_h1"] = pdz.get("h1")

    # VWAP per timeframe
    vwap = ss.get("vwap") or {}
    for tf in ["10", "30", "60", "240", "D", "W"]:
        v = vwap.get(tf) or {}
        r[f"vwap_{tf}_dist_pct"] = v.get("dist_pct")
        r[f"vwap_{tf}_above"] = v.get("above")
        r[f"vwap_{tf}_slope_5bar"] = v.get("slope_5bar")
        r[f"vwap_{tf}_touch_bars"] = v.get("touch_bars")

    # TD Sequential per timeframe
    td = ss.get("td_seq") or {}
    for tf in ["10", "30", "60", "240", "D", "W"]:
        s = td.get(tf) or {}
        r[f"td_{tf}_bull_prep"] = s.get("bull_prep")
        r[f"td_{tf}_bear_prep"] = s.get("bear_prep")
        r[f"td_{tf}_td9_bull"] = bool(s.get("td9_bull"))
        r[f"td_{tf}_td9_bear"] = bool(s.get("td9_bear"))
        r[f"td_{tf}_td13_bull"] = bool(s.get("td13_bull"))
        r[f"td_{tf}_td13_bear"] = bool(s.get("td13_bear"))

    # Divergence
    div = ss.get("divergence") or {}
    aphase = div.get("adverse_phase") or {}
    r["div_adverse_phase_count"] = aphase.get("count")
    a_strong = aphase.get("strongest") or {}
    r["div_adverse_phase_strongest_tf"] = a_strong.get("tf")
    r["div_adverse_phase_strongest_strength"] = a_strong.get("strength")
    r["div_adverse_phase_strongest_barsSince"] = a_strong.get("barsSince")
    r["div_adverse_phase_strongest_active"] = a_strong.get("active")
    arsi = div.get("adverse_rsi") or {}
    r["div_adverse_rsi_count"] = arsi.get("count") if isinstance(arsi, dict) else None
    a_rstrong = (arsi.get("strongest") if isinstance(arsi, dict) else None) or {}
    r["div_adverse_rsi_strongest_tf"] = a_rstrong.get("tf")
    r["div_adverse_rsi_strongest_strength"] = a_rstrong.get("strength")
    r["div_adverse_rsi_strongest_barsSince"] = a_rstrong.get("barsSince")
    r["div_bear_rsi"] = div.get("bear_rsi")
    r["div_bull_rsi"] = div.get("bull_rsi")

    # Market internals / cross asset
    mi = ss.get("market_internals") or {}
    r["mi_overall"] = mi.get("overall")
    r["mi_sector_rotation"] = mi.get("sector_rotation")
    r["mi_offense_avg_pct"] = mi.get("offense_avg_pct")
    r["mi_defense_avg_pct"] = mi.get("defense_avg_pct")
    r["mi_vix_state"] = mi.get("vix_state")
    r["mi_vix_price"] = mi.get("vix_price")

    ca = ss.get("cross_asset") or {}
    r["ca_btc_pct"] = ca.get("btc_pct")
    r["ca_dollar_pct"] = ca.get("dollar_pct")
    r["ca_oil_pct"] = ca.get("oil_pct")
    r["ca_gold_pct"] = ca.get("gold_pct")

    return r


def main():
    with TRADES_FILE.open() as f:
        data = json.load(f)
    trades = data["trades"]
    rows = [flatten_trade(t) for t in trades]
    with OUT_FILE.open("w") as f:
        for r in rows:
            f.write(json.dumps(r, default=str) + "\n")
    print(f"wrote {len(rows)} rows to {OUT_FILE}")


if __name__ == "__main__":
    main()
