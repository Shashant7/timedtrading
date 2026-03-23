#!/usr/bin/env python3
"""
Compute simple drift metrics between two reference-selection snapshots.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Set


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_refs(path: str) -> List[Dict[str, Any]]:
    p = Path(path)
    if not p.exists():
        return []
    obj = json.loads(p.read_text(encoding="utf-8"))
    refs = obj.get("references")
    if not isinstance(refs, list):
        return []
    return [x for x in refs if isinstance(x, dict)]


def to_ids(rows: List[Dict[str, Any]]) -> Set[str]:
    out = set()
    for r in rows:
        run_id = str(r.get("run_id") or "")
        trade_id = str(r.get("trade_id") or "")
        if run_id and trade_id:
            out.add(f"{run_id}::{trade_id}")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute drift metrics between reference snapshots")
    parser.add_argument("--baseline", default="data/reference-intel/reference-selection-v1.json")
    parser.add_argument("--candidate", default="data/reference-intel/reference-selection-v1.json")
    parser.add_argument("--output", default="data/reference-intel/drift-monitor-v1.json")
    args = parser.parse_args()

    base = load_refs(args.baseline)
    cand = load_refs(args.candidate)
    base_ids = to_ids(base)
    cand_ids = to_ids(cand)
    overlap = len(base_ids & cand_ids)
    union = max(1, len(base_ids | cand_ids))
    jaccard = overlap / union

    base_sector = Counter(str(r.get("sector") or "unknown") for r in base)
    cand_sector = Counter(str(r.get("sector") or "unknown") for r in cand)
    sector_delta = {}
    for s in set(base_sector) | set(cand_sector):
        sector_delta[s] = int(cand_sector.get(s, 0) - base_sector.get(s, 0))

    report = {
        "generated_at_utc": now_iso(),
        "baseline_file": args.baseline,
        "candidate_file": args.candidate,
        "baseline_count": len(base),
        "candidate_count": len(cand),
        "trade_overlap_count": overlap,
        "trade_jaccard_similarity": round(jaccard, 4),
        "sector_delta_counts": sector_delta,
        "drift_alert": jaccard < 0.6,
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"jaccard={round(jaccard,4)}")
    print(f"drift_alert={report['drift_alert']}")
    print(f"output={out_path}")


if __name__ == "__main__":
    main()

