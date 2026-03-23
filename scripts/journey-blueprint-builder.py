#!/usr/bin/env python3
"""
Build journey blueprints from selected reference trades.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any, Dict, List


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_selection(path: Path) -> List[Dict[str, Any]]:
    obj = json.loads(path.read_text(encoding="utf-8"))
    refs = obj.get("references")
    if not isinstance(refs, list):
        return []
    return [x for x in refs if isinstance(x, dict)]


def hold_bucket(days: Any) -> str:
    if not isinstance(days, (int, float)):
        return "unknown"
    d = float(days)
    if d < 0.2:
        return "intraday"
    if d < 1.5:
        return "swing_short"
    if d < 5.0:
        return "swing_medium"
    return "swing_long"


def avg(values: List[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def main() -> None:
    parser = argparse.ArgumentParser(description="Build journey blueprint clusters")
    parser.add_argument("--selection", default="data/reference-intel/reference-selection-v1.json")
    parser.add_argument("--output", default="data/reference-intel/journey-blueprints-v1.json")
    args = parser.parse_args()

    refs = load_selection(Path(args.selection))
    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in refs:
        key = "|".join([
            str(r.get("sector") or "unknown"),
            str(r.get("direction") or "UNK"),
            str(r.get("entry_path") or "unknown"),
            str(r.get("exit_class") or "unknown"),
            hold_bucket(r.get("hold_days")),
        ])
        groups[key].append(r)

    clusters = []
    for key, items in groups.items():
        pnl_values = [float(x["pnl_pct"]) for x in items if isinstance(x.get("pnl_pct"), (int, float))]
        score_values = [float(x["hybrid_score"]) for x in items if isinstance(x.get("hybrid_score"), (int, float))]
        win_count = sum(1 for x in items if str(x.get("status") or "").upper() == "WIN")
        clusters.append({
            "cluster_key": key,
            "count": len(items),
            "win_rate": round(win_count / max(1, len(items)), 4),
            "avg_pnl_pct": round(avg(pnl_values), 4),
            "median_pnl_pct": round(median(pnl_values), 4) if pnl_values else None,
            "avg_hybrid_score": round(avg(score_values), 4),
            "top_tickers": sorted(
                list({str(x.get("ticker") or "UNK") for x in items})
            )[:10],
        })
    clusters.sort(key=lambda x: (x["avg_hybrid_score"], x["count"]), reverse=True)

    out = {
        "generated_at_utc": now_iso(),
        "reference_count": len(refs),
        "cluster_count": len(clusters),
        "clusters": clusters,
    }
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"reference_count={len(refs)}")
    print(f"cluster_count={len(clusters)}")
    print(f"output={out_path}")


if __name__ == "__main__":
    main()

