#!/usr/bin/env python3
"""
Evaluate scenario policy coverage/hit-rate against reference trades.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
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
        ["npx", "wrangler", "d1", "execute", db_name, "--remote", "--command", sql],
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
    return str(v or "UNKNOWN").strip().upper() or "UNKNOWN"


def normalize_market_state(v: Any) -> str:
    return str(v or "unknown").strip().lower() or "unknown"


def eq(a: Any, b: Any) -> bool:
    return str(a or "").lower() == str(b or "").lower()


def match_policy(ctx: Dict[str, Any], policy: Dict[str, Any]) -> str:
    for r in policy.get("scenario_rules") or []:
        w = r.get("when") or {}
        if (
            eq(w.get("ticker"), ctx["ticker"])
            and eq(w.get("direction"), ctx["direction"])
            and eq(w.get("entry_path"), ctx["entry_path"])
            and eq(w.get("regime"), ctx["regime"])
            and eq(w.get("vix_bucket"), ctx["vix_bucket"])
            and eq(w.get("rvol_bucket"), ctx["rvol_bucket"])
            and eq(w.get("market_state"), ctx["market_state"])
        ):
            return "scenario_rules"
    for r in policy.get("ticker_setup_rules") or []:
        w = r.get("when") or {}
        if eq(w.get("ticker"), ctx["ticker"]) and eq(w.get("direction"), ctx["direction"]) and eq(w.get("entry_path"), ctx["entry_path"]):
            return "ticker_setup_rules"
    for r in policy.get("context_defaults") or []:
        w = r.get("when") or {}
        if eq(w.get("direction"), ctx["direction"]) and eq(w.get("regime"), ctx["regime"]) and eq(w.get("vix_bucket"), ctx["vix_bucket"]):
            return "context_defaults"
    if policy.get("global_default"):
        return "global_default"
    return "none"


def main() -> None:
    ap = argparse.ArgumentParser(description="Scenario policy hit-rate report")
    ap.add_argument("--db-name", default="timed-trading-ledger")
    ap.add_argument("--reference-selection", default="data/reference-intel/reference-selection-v2.json")
    ap.add_argument("--policy", default="configs/scenario-execution-policy-v2.json")
    ap.add_argument("--output", default="data/reference-intel/scenario-policy-hitrate-v2.json")
    args = ap.parse_args()

    refs = json.loads(Path(args.reference_selection).read_text(encoding="utf-8")).get("references") or []
    ref_keys = {(str(r.get("run_id") or ""), str(r.get("trade_id") or "")) for r in refs}
    if not ref_keys:
        raise RuntimeError("No reference trades found")
    policy = json.loads(Path(args.policy).read_text(encoding="utf-8"))

    sql = """
    SELECT
      d.run_id, d.trade_id, d.ticker, d.entry_path, d.regime_combined, d.market_state, d.rvol_best, d.signal_snapshot_json,
      t.direction, t.status
    FROM backtest_run_direction_accuracy d
    LEFT JOIN backtest_run_trades t ON t.run_id = d.run_id AND t.trade_id = d.trade_id
    WHERE d.run_id IS NOT NULL;
    """
    rows = run_sql(sql, db_name=args.db_name)
    eval_rows = []
    universe_rows = []
    for r in rows:
        key = (str(r.get("run_id") or ""), str(r.get("trade_id") or ""))
        snap = parse_json_maybe(r.get("signal_snapshot_json") or "") or {}
        lineage = snap.get("lineage") if isinstance(snap.get("lineage"), dict) else {}
        direction = str(r.get("direction") or "").upper()
        entry_path = str(r.get("entry_path") or lineage.get("entry_path") or "unknown").lower()
        if direction not in ("LONG", "SHORT"):
            direction = infer_direction(entry_path, "LONG")
        rv = to_float(r.get("rvol_best"), 0.0)
        if rv <= 0:
            rv_obj = lineage.get("rvol") if isinstance(lineage.get("rvol"), dict) else {}
            rv = max(to_float(rv_obj.get("30m"), 0.0), to_float(rv_obj.get("1H"), 0.0), to_float(rv_obj.get("D"), 0.0))
        ctx = {
            "ticker": str(r.get("ticker") or "").upper(),
            "direction": direction,
            "entry_path": entry_path,
            "regime": normalize_regime(r.get("regime_combined") or lineage.get("regime_class")),
            "vix_bucket": vix_bucket(to_float(lineage.get("vix_at_entry"), 0.0)),
            "rvol_bucket": rvol_bucket(rv),
            "market_state": normalize_market_state(r.get("market_state") or (lineage.get("market_internals") or {}).get("overall")),
        }
        tier = match_policy(ctx, policy)
        row_obj = {"ctx": ctx, "tier": tier, "status": str(r.get("status") or "").upper(), "key": key}
        universe_rows.append(row_obj)
        if key in ref_keys:
            eval_rows.append(row_obj)

    total = len(eval_rows)
    tier_counts = Counter(r["tier"] for r in eval_rows)
    by_ticker = defaultdict(Counter)
    for r in eval_rows:
        by_ticker[r["ctx"]["ticker"]][r["tier"]] += 1
    weak_tickers = []
    for t, c in by_ticker.items():
        n = sum(c.values())
        non_specific = c.get("global_default", 0) + c.get("none", 0)
        if n >= 2 and (non_specific / n) >= 0.7:
            weak_tickers.append({"ticker": t, "rows": n, "global_or_none_ratio": round(non_specific / n, 4), "counts": dict(c)})
    weak_tickers.sort(key=lambda x: (-x["global_or_none_ratio"], -x["rows"], x["ticker"]))

    # Universe generalization (all DA rows, including non-reference)
    universe_total = len(universe_rows)
    universe_tier_counts = Counter(r["tier"] for r in universe_rows)
    by_ticker_u = defaultdict(Counter)
    for r in universe_rows:
        by_ticker_u[r["ctx"]["ticker"]][r["tier"]] += 1
    weak_tickers_u = []
    for t, c in by_ticker_u.items():
        n = sum(c.values())
        non_specific = c.get("global_default", 0) + c.get("none", 0)
        if n >= 5 and (non_specific / n) >= 0.5:
            weak_tickers_u.append({"ticker": t, "rows": n, "global_or_none_ratio": round(non_specific / n, 4), "counts": dict(c)})
    weak_tickers_u.sort(key=lambda x: (-x["global_or_none_ratio"], -x["rows"], x["ticker"]))

    out = {
        "generated_at_utc": now_iso(),
        "reference_fit": {
            "reference_rows_evaluated": total,
            "tier_counts": dict(tier_counts),
            "tier_ratios": {k: round(v / max(1, total), 4) for k, v in tier_counts.items()},
            "weak_tickers": weak_tickers[:40],
        },
        "universe_generalization": {
            "rows_evaluated": universe_total,
            "tier_counts": dict(universe_tier_counts),
            "tier_ratios": {k: round(v / max(1, universe_total), 4) for k, v in universe_tier_counts.items()},
            "weak_tickers": weak_tickers_u[:60],
        },
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"reference_evaluated={total}")
    print(f"reference_tier_counts={dict(tier_counts)}")
    print(f"reference_weak_tickers={len(weak_tickers)}")
    print(f"universe_evaluated={universe_total}")
    print(f"universe_tier_counts={dict(universe_tier_counts)}")
    print(f"universe_weak_tickers={len(weak_tickers_u)}")
    print(f"output={out_path}")


if __name__ == "__main__":
    main()
