#!/usr/bin/env python3
"""
Generate scenario coverage map and gap report for reference intelligence.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_jsonl(path: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    out.append(obj)
            except Exception:
                continue
    return out


def load_selection(path: Path) -> List[Dict[str, Any]]:
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    refs = obj.get("references")
    if isinstance(refs, list):
        return [x for x in refs if isinstance(x, dict)]
    return []


def month_bucket(entry_ts: Any) -> str:
    if isinstance(entry_ts, int) and entry_ts > 0:
        return datetime.fromtimestamp(entry_ts / 1000, tz=timezone.utc).strftime("%Y-%m")
    return "unknown"


def compute_sparse_bins(counter: Counter, min_count: int) -> List[Dict[str, Any]]:
    sparse = []
    for k, v in counter.items():
        if v < min_count:
            sparse.append({"bucket": k, "count": int(v)})
    sparse.sort(key=lambda x: x["count"])
    return sparse


def top(counter: Counter, n: int = 30) -> List[List[Any]]:
    return [[k, int(v)] for k, v in counter.most_common(n)]


def main() -> None:
    parser = argparse.ArgumentParser(description="Build coverage/gap report for reference-intel")
    parser.add_argument("--canonical", default="data/reference-intel/trade-intel-canonical-v1.jsonl")
    parser.add_argument("--selection", default="data/reference-intel/reference-selection-v1.json")
    parser.add_argument("--output", default="data/reference-intel/coverage-gap-report-v1.json")
    parser.add_argument("--min-bin", type=int, default=6)
    args = parser.parse_args()

    rows = load_jsonl(Path(args.canonical))
    refs = load_selection(Path(args.selection))
    closed = [r for r in rows if str(r.get("status") or "").upper() not in ("OPEN", "", "ARCHIVED")]

    c_sector = Counter(str(r.get("sector") or "unknown") for r in closed)
    c_ticker = Counter(str(r.get("ticker") or "UNK") for r in closed)
    c_direction = Counter(str(r.get("direction") or "UNK") for r in closed)
    c_month = Counter(month_bucket(r.get("entry_ts")) for r in closed)
    c_exit_class = Counter(str(r.get("exit_class") or "unknown") for r in closed)
    c_entry_path = Counter(str(r.get("entry_path") or "unknown") for r in closed)

    joint_sector_direction = Counter(
        f"{str(r.get('sector') or 'unknown')}|{str(r.get('direction') or 'UNK')}" for r in closed
    )
    joint_month_direction = Counter(
        f"{month_bucket(r.get('entry_ts'))}|{str(r.get('direction') or 'UNK')}" for r in closed
    )

    r_sector = Counter(str(r.get("sector") or "unknown") for r in refs)
    r_direction = Counter(str(r.get("direction") or "UNK") for r in refs)
    r_month = Counter(month_bucket(r.get("entry_ts")) for r in refs)

    sector_coverage_ratio = {}
    for sector, total in c_sector.items():
        if total <= 0:
            continue
        sector_coverage_ratio[sector] = round(r_sector.get(sector, 0) / total, 4)

    report = {
        "generated_at_utc": now_iso(),
        "canonical_closed_rows": len(closed),
        "reference_rows": len(refs),
        "coverage_map": {
            "canonical": {
                "sector": dict(c_sector),
                "direction": dict(c_direction),
                "month": dict(c_month),
                "exit_class": dict(c_exit_class),
                "entry_path": dict(c_entry_path),
            },
            "reference": {
                "sector": dict(r_sector),
                "direction": dict(r_direction),
                "month": dict(r_month),
            },
            "reference_to_canonical_sector_ratio": sector_coverage_ratio,
        },
        "top_views": {
            "top_tickers_canonical": top(c_ticker, 40),
            "top_entry_path_canonical": top(c_entry_path, 25),
            "top_sector_direction_canonical": top(joint_sector_direction, 30),
            "top_month_direction_canonical": top(joint_month_direction, 30),
        },
        "gaps": {
            "sparse_sector_direction_bins": compute_sparse_bins(joint_sector_direction, args.min_bin),
            "sparse_month_direction_bins": compute_sparse_bins(joint_month_direction, args.min_bin),
            "low_representation_exit_classes": compute_sparse_bins(c_exit_class, args.min_bin),
            "low_representation_entry_paths": compute_sparse_bins(c_entry_path, args.min_bin),
        },
        "notes": [
            "Use sparse bins to define next replay matrix slices.",
            "Combine with context-intel states before policy promotion.",
        ],
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"canonical_closed_rows={len(closed)}")
    print(f"reference_rows={len(refs)}")
    print(f"output={out_path}")


if __name__ == "__main__":
    main()

