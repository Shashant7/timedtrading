#!/usr/bin/env python3
"""
Translate journey blueprints into a versioned dynamic policy artifact.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    parser = argparse.ArgumentParser(description="Build dynamic policy artifact from blueprints")
    parser.add_argument("--blueprints", default="data/reference-intel/journey-blueprints-v1.json")
    parser.add_argument("--output", default="configs/dynamic-engine-rules-reference-v1.json")
    parser.add_argument("--min-count", type=int, default=3)
    parser.add_argument("--min-score", type=float, default=0.7)
    parser.add_argument("--max-rules", type=int, default=80)
    args = parser.parse_args()

    obj = json.loads(Path(args.blueprints).read_text(encoding="utf-8"))
    clusters = obj.get("clusters") or []
    rules: List[Dict[str, Any]] = []
    for c in clusters:
        count = int(c.get("count") or 0)
        score = float(c.get("avg_hybrid_score") or 0.0)
        if count < args.min_count or score < args.min_score:
            continue
        try:
            sector, direction, entry_path, exit_class, hold_bucket = str(c["cluster_key"]).split("|", 4)
        except Exception:
            continue
        rule = {
            "when": {
                "sector": sector,
                "direction": direction,
                "entry_path": entry_path,
                "hold_bucket": hold_bucket,
            },
            "recommend": {
                "policy_bias": "promote" if c.get("win_rate", 0) >= 0.55 else "cautious",
                "exit_class_preference": exit_class,
                "confidence": round(min(1.0, (score * 0.7) + (min(count, 12) / 12.0) * 0.3), 4),
                "expected_win_rate": c.get("win_rate"),
                "expected_pnl_pct": c.get("avg_pnl_pct"),
            },
            "evidence": {
                "cluster_count": count,
                "avg_hybrid_score": score,
                "top_tickers": c.get("top_tickers") or [],
            },
        }
        rules.append(rule)
        if len(rules) >= args.max_rules:
            break

    artifact = {
        "version": "reference_v1",
        "generated_at_utc": now_iso(),
        "source_blueprint_file": args.blueprints,
        "selection_thresholds": {
            "min_count": args.min_count,
            "min_score": args.min_score,
            "max_rules": args.max_rules,
        },
        "rules": rules,
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(artifact, indent=2), encoding="utf-8")
    print(f"rules={len(rules)}")
    print(f"output={out_path}")


if __name__ == "__main__":
    main()

