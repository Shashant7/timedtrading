#!/usr/bin/env python3
"""
Build scenario execution policy from reference trades.

Scenario intent:
- pick best mix for ticker + setup + volatility + context
- output runtime policy artifact for worker:
  - engines (entry/management)
  - sl/tp multipliers
  - exit style bias (tp_full_bias vs smart_exit_bias)
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any, Dict, List, Tuple


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_json_maybe(s: str) -> Any:
    try:
        return json.loads(s)
    except Exception:
        return None


def run_sql(sql: str, db_name: str = "timed-trading-ledger") -> List[Dict[str, Any]]:
    raw = subprocess.check_output(
        [
            "npx",
            "wrangler",
            "d1",
            "execute",
            db_name,
            "--remote",
            "--command",
            sql,
        ],
        text=True,
    )
    parsed = parse_json_maybe(raw)
    if parsed is None:
        lb = raw.find("[")
        rb = raw.rfind("]")
        if lb >= 0 and rb > lb:
            parsed = parse_json_maybe(raw[lb:rb + 1])
    if not isinstance(parsed, list) or not parsed:
        return []
    first = parsed[0]
    if not isinstance(first, dict):
        return []
    rows = first.get("results")
    return rows if isinstance(rows, list) else []


def to_float(v: Any, default: float = 0.0) -> float:
    try:
        x = float(v)
        if math.isnan(x) or math.isinf(x):
            return default
        return x
    except Exception:
        return default


def normalize_engine(v: Any, fallback: str = "tt_core") -> str:
    s = str(v or "").strip().lower()
    return s if s in ("tt_core", "ripster_core", "legacy") else fallback


def infer_direction(path: str, fallback: str = "LONG") -> str:
    p = str(path or "").lower()
    if "short" in p:
        return "SHORT"
    if "long" in p:
        return "LONG"
    return fallback


def vix_bucket(vix: float) -> str:
    if vix <= 0:
        return "unknown"
    if vix < 14:
        return "calm"
    if vix < 19:
        return "normal"
    if vix < 26:
        return "elevated"
    return "stress"


def rvol_bucket(v: float) -> str:
    if v <= 0:
        return "unknown"
    if v < 0.9:
        return "low"
    if v < 1.2:
        return "normal"
    if v < 1.6:
        return "high"
    return "surge"


def normalize_regime(v: Any) -> str:
    s = str(v or "unknown").strip().upper()
    return s if s else "UNKNOWN"


def normalize_market_state(v: Any) -> str:
    s = str(v or "unknown").strip().lower()
    return s if s else "unknown"


def exit_style_from_trade(exit_reason: Any, trimmed_pct: Any) -> str:
    r = str(exit_reason or "").upper()
    t = to_float(trimmed_pct, 0.0)
    if "TP_FULL" in r or t >= 0.999:
        return "tp_full_bias"
    return "smart_exit_bias"


def apply_model_config(api_base: str, api_key: str, key: str, value: Dict[str, Any], description: str) -> None:
    payload = {"updates": [{"key": key, "value": value, "description": description}]}
    raw = subprocess.check_output(
        [
            "curl",
            "-sS",
            "-m",
            "90",
            "-X",
            "POST",
            f"{api_base}/timed/admin/model-config?key={api_key}",
            "-H",
            "Content-Type: application/json",
            "--data-raw",
            json.dumps(payload, separators=(",", ":"), ensure_ascii=True),
        ],
        text=True,
    )
    resp = parse_json_maybe(raw) or {}
    if not isinstance(resp, dict) or not resp.get("ok"):
        raise RuntimeError(f"Failed to apply model_config {key}: {resp}")


def aggregate_policy(rows: List[Dict[str, Any]], min_count: int) -> Dict[str, Any]:
    def summarize(group_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
        pairs = Counter((r["entry_engine"], r["management_engine"]) for r in group_rows)
        (entry_engine, management_engine), _ = pairs.most_common(1)[0]
        exits = Counter(r["exit_style"] for r in group_rows)
        sl_vals = [to_float(r.get("sl_mult"), 1.0) for r in group_rows if to_float(r.get("sl_mult"), 0) > 0]
        tp_vals = [to_float(r.get("tp_mult"), 1.0) for r in group_rows if to_float(r.get("tp_mult"), 0) > 0]
        wr = sum(1 for r in group_rows if str(r.get("status", "")).upper() == "WIN") / max(1, len(group_rows))
        return {
            "entry_engine": normalize_engine(entry_engine, "tt_core"),
            "management_engine": normalize_engine(management_engine, normalize_engine(entry_engine, "tt_core")),
            "exit_style": exits.most_common(1)[0][0] if exits else "smart_exit_bias",
            "sl_mult": round(max(0.7, min(2.5, median(sl_vals) if sl_vals else 1.0)), 4),
            "tp_mult": round(max(0.7, min(2.5, median(tp_vals) if tp_vals else 1.0)), 4),
            "win_rate": round(wr, 4),
            "sample_size": len(group_rows),
        }

    scenario_groups: Dict[Tuple[str, str, str, str, str, str, str], List[Dict[str, Any]]] = defaultdict(list)
    ticker_setup_groups: Dict[Tuple[str, str, str], List[Dict[str, Any]]] = defaultdict(list)
    context_groups: Dict[Tuple[str, str, str], List[Dict[str, Any]]] = defaultdict(list)

    for r in rows:
        scenario_groups[(
            r["ticker"],
            r["direction"],
            r["entry_path"],
            r["regime"],
            r["vix_bucket"],
            r["rvol_bucket"],
            r["market_state"],
        )].append(r)
        ticker_setup_groups[(r["ticker"], r["direction"], r["entry_path"])].append(r)
        context_groups[(r["direction"], r["regime"], r["vix_bucket"])].append(r)

    scenario_rules = []
    for k, g in scenario_groups.items():
        if len(g) < min_count:
            continue
        s = summarize(g)
        scenario_rules.append(
            {
                "when": {
                    "ticker": k[0], "direction": k[1], "entry_path": k[2],
                    "regime": k[3], "vix_bucket": k[4], "rvol_bucket": k[5], "market_state": k[6],
                },
                "recommend": s,
            }
        )

    ticker_setup_rules = []
    for k, g in ticker_setup_groups.items():
        if len(g) < max(2, min_count):
            continue
        s = summarize(g)
        ticker_setup_rules.append(
            {"when": {"ticker": k[0], "direction": k[1], "entry_path": k[2]}, "recommend": s}
        )

    context_defaults = []
    for k, g in context_groups.items():
        if len(g) < max(3, min_count + 1):
            continue
        s = summarize(g)
        context_defaults.append(
            {"when": {"direction": k[0], "regime": k[1], "vix_bucket": k[2]}, "recommend": s}
        )

    global_summary = summarize(rows) if rows else {
        "entry_engine": "tt_core",
        "management_engine": "tt_core",
        "exit_style": "smart_exit_bias",
        "sl_mult": 1.0,
        "tp_mult": 1.0,
        "win_rate": 0.0,
        "sample_size": 0,
    }

    return {
        "version": "scenario_execution_policy_v1",
        "generated_at_utc": now_iso(),
        "matching_priority": ["scenario_rules", "ticker_setup_rules", "context_defaults", "global_default"],
        "scenario_rules": sorted(scenario_rules, key=lambda x: x["recommend"]["sample_size"], reverse=True),
        "ticker_setup_rules": sorted(ticker_setup_rules, key=lambda x: x["recommend"]["sample_size"], reverse=True),
        "context_defaults": sorted(context_defaults, key=lambda x: x["recommend"]["sample_size"], reverse=True),
        "global_default": global_summary,
        "summary": {
            "input_rows": len(rows),
            "scenario_rules": len(scenario_rules),
            "ticker_setup_rules": len(ticker_setup_rules),
            "context_defaults": len(context_defaults),
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Build scenario policy from reference trades")
    ap.add_argument("--db-name", default="timed-trading-ledger")
    ap.add_argument("--reference-selection", default="data/reference-intel/reference-selection-v1.json")
    ap.add_argument("--reference-map", default="data/reference-intel/reference-execution-map-v1.json")
    ap.add_argument("--output", default="configs/scenario-execution-policy-v1.json")
    ap.add_argument("--min-count", type=int, default=2)
    ap.add_argument("--api-base", default="https://timed-trading-ingest.shashant.workers.dev")
    ap.add_argument("--api-key", default="AwesomeSauce")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    selection = json.loads(Path(args.reference_selection).read_text(encoding="utf-8"))
    refs = selection.get("references") or []
    ref_keys = {(str(r.get("run_id") or ""), str(r.get("trade_id") or "")) for r in refs}
    run_ids = sorted({rk[0] for rk in ref_keys if rk[0]})
    if not run_ids:
        raise RuntimeError("No reference run IDs found in selection")

    ref_map = json.loads(Path(args.reference_map).read_text(encoding="utf-8"))
    exact = ref_map.get("exact_reference_entries") or []
    engine_by_key = {
        (str(e.get("run_id") or ""), str(e.get("trade_id") or "")): (
            normalize_engine(e.get("entry_engine"), "tt_core"),
            normalize_engine(e.get("management_engine"), normalize_engine(e.get("entry_engine"), "tt_core")),
        )
        for e in exact
    }

    sql = f"""
    SELECT
      d.run_id, d.trade_id, d.ticker, d.entry_path, d.regime_combined, d.market_state, d.rvol_best, d.signal_snapshot_json,
      t.direction, t.exit_reason, t.trimmed_pct, t.pnl_pct, t.status
    FROM backtest_run_direction_accuracy d
    LEFT JOIN backtest_run_trades t ON t.run_id = d.run_id AND t.trade_id = d.trade_id
    WHERE d.run_id IS NOT NULL;
    """
    rows = run_sql(sql, db_name=args.db_name)
    if not rows:
        raise RuntimeError("No direction-accuracy rows returned for reference runs")

    policy_rows = []
    for r in rows:
        key = (str(r.get("run_id") or ""), str(r.get("trade_id") or ""))
        if key not in ref_keys:
            continue
        snap_raw = r.get("signal_snapshot_json")
        snap = parse_json_maybe(snap_raw) if isinstance(snap_raw, str) else (snap_raw if isinstance(snap_raw, dict) else {})
        lineage = (snap or {}).get("lineage") if isinstance((snap or {}).get("lineage"), dict) else {}

        ticker = str(r.get("ticker") or "").upper()
        if not ticker:
            continue
        entry_path = str(r.get("entry_path") or lineage.get("entry_path") or "unknown").strip().lower()
        direction = str(r.get("direction") or "").upper()
        if direction not in ("LONG", "SHORT"):
            direction = infer_direction(entry_path, "LONG")
        regime = normalize_regime(r.get("regime_combined") or lineage.get("regime_class"))
        market_state = normalize_market_state(r.get("market_state") or ((lineage.get("market_internals") or {}).get("overall")))
        vix = to_float(lineage.get("vix_at_entry"), 0.0)
        rv = to_float(r.get("rvol_best"), 0.0)
        if rv <= 0:
            rvol_obj = lineage.get("rvol") or {}
            rv = max(to_float(rvol_obj.get("30m"), 0.0), to_float(rvol_obj.get("1H"), 0.0), to_float(rvol_obj.get("D"), 0.0))
        tc = lineage.get("ticker_character") if isinstance(lineage.get("ticker_character"), dict) else {}
        sl_mult = to_float(tc.get("sl_mult"), 1.0)
        tp_mult = to_float(tc.get("tp_mult"), 1.0)
        entry_engine, management_engine = engine_by_key.get(key, ("tt_core", "tt_core"))
        policy_rows.append(
            {
                "run_id": key[0],
                "trade_id": key[1],
                "ticker": ticker,
                "direction": direction,
                "entry_path": entry_path or "unknown",
                "regime": regime,
                "market_state": market_state,
                "vix_bucket": vix_bucket(vix),
                "rvol_bucket": rvol_bucket(rv),
                "entry_engine": entry_engine,
                "management_engine": management_engine,
                "exit_style": exit_style_from_trade(r.get("exit_reason"), r.get("trimmed_pct")),
                "sl_mult": sl_mult if sl_mult > 0 else 1.0,
                "tp_mult": tp_mult if tp_mult > 0 else 1.0,
                "status": str(r.get("status") or "").upper(),
            }
        )

    if not policy_rows:
        raise RuntimeError("No matched reference rows to build policy")

    policy = aggregate_policy(policy_rows, min_count=args.min_count)
    policy["sources"] = {
        "reference_selection": args.reference_selection,
        "reference_map": args.reference_map,
        "matched_reference_rows": len(policy_rows),
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(policy, indent=2), encoding="utf-8")

    if args.apply:
        apply_model_config(
            api_base=args.api_base,
            api_key=args.api_key,
            key="scenario_execution_policy",
            value=policy,
            description="Scenario policy memory: context+volatility+setup execution bundle",
        )

    print(f"rows={len(policy_rows)}")
    print(f"scenario_rules={len(policy.get('scenario_rules') or [])}")
    print(f"ticker_setup_rules={len(policy.get('ticker_setup_rules') or [])}")
    print(f"context_defaults={len(policy.get('context_defaults') or [])}")
    print(f"output={out_path}")
    print(f"applied={'yes' if args.apply else 'no'}")


if __name__ == "__main__":
    main()
