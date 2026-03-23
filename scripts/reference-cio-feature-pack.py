#!/usr/bin/env python3
"""
Build CIO reference memory features and an outcome-calibration eval loop artifact.

Primary outputs:
- data/reference-intel/cio-memory-features-v1.json
- data/reference-intel/cio-eval-loop-v1.json
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def as_float(v: Any) -> float | None:
    try:
        if v is None:
            return None
        return float(v)
    except Exception:
        return None


def load_json(path: str) -> Dict[str, Any]:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        obj = json.loads(p.read_text(encoding="utf-8"))
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def safe_rate(num: float, den: float) -> float:
    if den <= 0:
        return 0.0
    return num / den


def aggregate_bucket(rows: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    rows = list(rows)
    n = len(rows)
    if n == 0:
        return {
            "sample_size": 0,
            "win_rate": 0.0,
            "avg_pnl_pct": 0.0,
            "median_hybrid_score": 0.0,
            "preferred_exit_classes": [],
            "lineage_quality_rate": 0.0,
            "confidence_prior": 0.0,
        }
    wins = sum(1 for r in rows if str(r.get("status") or "").upper() == "WIN")
    pnl = [as_float(r.get("pnl_pct")) for r in rows]
    pnl_vals = [x for x in pnl if x is not None]
    h_scores = [as_float(r.get("hybrid_score")) for r in rows]
    hs = sorted([x for x in h_scores if x is not None])
    median_h = hs[len(hs) // 2] if hs else 0.0
    exits = Counter(str(r.get("exit_class") or "unknown") for r in rows)
    lineage_flags = []
    for r in rows:
        f = r.get("lineage_quality_flags") or {}
        checks = [
            bool(f.get("has_entry_path")),
            bool(f.get("has_signal_snapshot")),
            bool(f.get("has_tf_stack")),
            bool(f.get("has_exit_reason")),
        ]
        lineage_flags.append(sum(1 for c in checks if c) / len(checks))
    lineage_rate = sum(lineage_flags) / len(lineage_flags) if lineage_flags else 0.0
    wr = safe_rate(wins, n)
    avg_pnl = (sum(pnl_vals) / len(pnl_vals)) if pnl_vals else 0.0
    # Confidence prior shrinks toward neutral with sample size.
    sample_weight = clamp(n / 10.0)
    performance_component = clamp((wr * 0.7) + (clamp((avg_pnl + 5.0) / 15.0) * 0.3))
    confidence_prior = clamp((performance_component * sample_weight) + (0.5 * (1 - sample_weight)))
    return {
        "sample_size": n,
        "win_rate": round(wr, 4),
        "avg_pnl_pct": round(avg_pnl, 4),
        "median_hybrid_score": round(float(median_h or 0.0), 4),
        "preferred_exit_classes": [k for k, _ in exits.most_common(3)],
        "lineage_quality_rate": round(lineage_rate, 4),
        "confidence_prior": round(confidence_prior, 4),
    }


def build_feature_pack(reference_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_ticker: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    by_ticker_dir: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    by_path_dir: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    by_sector_dir: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

    for r in reference_rows:
        ticker = str(r.get("ticker") or "UNK").upper()
        direction = str(r.get("direction") or "UNK").upper()
        entry_path = str(r.get("entry_path") or "unknown")
        sector = str(r.get("sector") or "unknown")
        by_ticker[ticker].append(r)
        by_ticker_dir[f"{ticker}|{direction}"].append(r)
        by_path_dir[f"{entry_path}|{direction}"].append(r)
        by_sector_dir[f"{sector}|{direction}"].append(r)

    features = {
        "generated_at_utc": now_iso(),
        "source": "data/reference-intel/reference-selection-v1.json",
        "row_count": len(reference_rows),
        "priors": {
            "ticker": {k: aggregate_bucket(v) for k, v in sorted(by_ticker.items())},
            "ticker_direction": {k: aggregate_bucket(v) for k, v in sorted(by_ticker_dir.items())},
            "entry_path_direction": {k: aggregate_bucket(v) for k, v in sorted(by_path_dir.items())},
            "sector_direction": {k: aggregate_bucket(v) for k, v in sorted(by_sector_dir.items())},
        },
    }
    return features


def d1_query(sql: str) -> List[Dict[str, Any]]:
    try:
        raw = subprocess.check_output(
            [
                "npx",
                "wrangler",
                "d1",
                "execute",
                "timed-trading-ledger",
                "--remote",
                "--command",
                sql,
                "--json",
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        payload = json.loads(raw)
        if isinstance(payload, list) and payload:
            results = payload[0].get("results")
            if isinstance(results, list):
                return [x for x in results if isinstance(x, dict)]
    except Exception:
        return []
    return []


def build_eval_loop(decisions: List[Dict[str, Any]]) -> Dict[str, Any]:
    total = len(decisions)
    approved = [d for d in decisions if str(d.get("decision") or "").upper() in ("APPROVE", "ADJUST")]
    rejected = [d for d in decisions if str(d.get("decision") or "").upper() == "REJECT"]
    with_outcome = [d for d in decisions if str(d.get("trade_outcome") or "").upper() in ("WIN", "LOSS", "FLAT")]
    approved_outcome = [d for d in approved if d in with_outcome]
    rejected_outcome = [d for d in rejected if d in with_outcome]

    def win_rate(rows: List[Dict[str, Any]]) -> float:
        wins = sum(1 for d in rows if str(d.get("trade_outcome") or "").upper() == "WIN")
        return round(safe_rate(wins, len(rows)), 4)

    # Simple confidence calibration buckets.
    buckets: Dict[str, Dict[str, float]] = {}
    for lo, hi in [(0.0, 0.25), (0.25, 0.5), (0.5, 0.75), (0.75, 1.01)]:
        b_rows = []
        for d in with_outcome:
            c = as_float(d.get("confidence"))
            if c is None:
                continue
            if c >= lo and c < hi:
                b_rows.append(d)
        key = f"{lo:.2f}-{min(hi,1.0):.2f}"
        buckets[key] = {
            "sample_size": len(b_rows),
            "win_rate": win_rate(b_rows),
            "avg_confidence": round(sum((as_float(r.get("confidence")) or 0.0) for r in b_rows) / len(b_rows), 4) if b_rows else 0.0,
        }

    return {
        "generated_at_utc": now_iso(),
        "decision_rows": total,
        "rows_with_outcome": len(with_outcome),
        "approve_adjust_rows": len(approved),
        "reject_rows": len(rejected),
        "approve_adjust_win_rate": win_rate(approved_outcome),
        "reject_counterfactual_win_rate": win_rate(rejected_outcome),
        "calibration_buckets": buckets,
        "notes": [
            "Reject counterfactual win-rate should trend below approve/adjust win-rate.",
            "Confidence buckets should be monotonic over time as calibration improves.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build CIO memory feature pack and eval loop artifact")
    parser.add_argument("--reference-selection", default="data/reference-intel/reference-selection-v1.json")
    parser.add_argument("--features-output", default="data/reference-intel/cio-memory-features-v1.json")
    parser.add_argument("--eval-output", default="data/reference-intel/cio-eval-loop-v1.json")
    parser.add_argument("--decisions-json", default="")
    parser.add_argument("--skip-d1", action="store_true")
    args = parser.parse_args()

    selection = load_json(args.reference_selection)
    refs = selection.get("references")
    reference_rows = [x for x in refs if isinstance(x, dict)] if isinstance(refs, list) else []
    features = build_feature_pack(reference_rows)

    features_path = Path(args.features_output)
    features_path.parent.mkdir(parents=True, exist_ok=True)
    features_path.write_text(json.dumps(features, indent=2), encoding="utf-8")

    decisions: List[Dict[str, Any]] = []
    if args.decisions_json:
        obj = load_json(args.decisions_json)
        raw = obj.get("results") if isinstance(obj, dict) else None
        if isinstance(raw, list):
            decisions = [x for x in raw if isinstance(x, dict)]
    if not decisions and not args.skip_d1:
        decisions = d1_query(
            "SELECT ticker, direction, decision, confidence, edge_score, trade_outcome, trade_pnl_pct, created_at FROM ai_cio_decisions ORDER BY created_at DESC LIMIT 5000"
        )

    eval_loop = build_eval_loop(decisions)
    eval_path = Path(args.eval_output)
    eval_path.parent.mkdir(parents=True, exist_ok=True)
    eval_path.write_text(json.dumps(eval_loop, indent=2), encoding="utf-8")

    print(f"reference_rows={len(reference_rows)}")
    print(f"feature_ticker_keys={len(features['priors']['ticker'])}")
    print(f"decision_rows={len(decisions)}")
    print(f"features_output={features_path}")
    print(f"eval_output={eval_path}")


if __name__ == "__main__":
    main()

