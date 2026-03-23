#!/usr/bin/env python3
"""
Evaluate go/no-go readiness gates from reference-intel artifacts.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: str) -> Dict[str, Any]:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        obj = json.loads(p.read_text(encoding="utf-8"))
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def gate(name: str, value: float, threshold: float, op: str = ">=") -> Dict[str, Any]:
    if op == ">=":
        passed = value >= threshold
    else:
        passed = value <= threshold
    return {
        "gate": name,
        "value": value,
        "threshold": threshold,
        "operator": op,
        "pass": passed,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate reference-intel go/no-go gates")
    parser.add_argument("--summary", default="data/reference-intel/trade-intel-canonical-v1-summary.json")
    parser.add_argument("--selection", default="data/reference-intel/reference-selection-v1.json")
    parser.add_argument("--coverage", default="data/reference-intel/coverage-gap-report-v1.json")
    parser.add_argument("--context-quality", default="data/reference-intel/context-intel-quality-v1.json")
    parser.add_argument("--policy", default="configs/dynamic-engine-rules-reference-v1.json")
    parser.add_argument("--output", default="data/reference-intel/validation-gates-v1.json")
    args = parser.parse_args()

    summary = load_json(args.summary)
    selection = load_json(args.selection)
    coverage = load_json(args.coverage)
    context_quality = load_json(args.context_quality)
    policy = load_json(args.policy)

    missing_rates = summary.get("lineage_missing_rates") or {}
    sector_map = (((coverage.get("coverage_map") or {}).get("canonical") or {}).get("sector") or {})
    sector_count = len([k for k, v in sector_map.items() if k and k != "unknown" and int(v) > 0])
    refs_count = int(selection.get("selected_rows") or 0)
    policy_rules = len(policy.get("rules") or [])

    gates = [
        gate("lineage_missing_entry_path_max", float(missing_rates.get("has_entry_path") or 1.0), 0.50, "<="),
        gate("lineage_missing_signal_snapshot_max", float(missing_rates.get("has_signal_snapshot") or 1.0), 0.50, "<="),
        gate("reference_count_min", float(refs_count), 200.0, ">="),
        gate("canonical_sector_coverage_min", float(sector_count), 8.0, ">="),
        gate("context_profile_present_rate_min", float(context_quality.get("profile_present_rate") or 0.0), 0.95, ">="),
        gate("context_daily_brief_present_rate_min", float(context_quality.get("daily_brief_present_rate") or 0.0), 0.95, ">="),
        gate("context_hyper_state_present_rate_min", float(context_quality.get("hyper_state_present_rate") or 0.0), 0.95, ">="),
        gate("policy_rule_count_min", float(policy_rules), 20.0, ">="),
    ]
    pass_count = sum(1 for g in gates if g["pass"])
    result = {
        "generated_at_utc": now_iso(),
        "gates_total": len(gates),
        "gates_passed": pass_count,
        "overall_pass": pass_count == len(gates),
        "gates": gates,
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"gates_passed={pass_count}/{len(gates)}")
    print(f"overall_pass={result['overall_pass']}")
    print(f"output={out_path}")


if __name__ == "__main__":
    main()

