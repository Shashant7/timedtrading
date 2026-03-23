#!/usr/bin/env python3
"""
Select hybrid-ranked reference trades from canonical reference-intel dataset.

Inputs:
- data/reference-intel/trade-intel-canonical-v1.jsonl

Outputs:
- data/reference-intel/reference-selection-v1.json
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def load_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    rows.append(obj)
            except Exception:
                continue
    return rows


def score_outcome(row: Dict[str, Any]) -> float:
    status = str(row.get("status") or "").upper()
    pnl_pct = row.get("pnl_pct")
    forced = bool(row.get("is_forced_close"))
    base = 0.35
    if status == "WIN":
        base = 0.95
    elif status == "FLAT":
        base = 0.55
    elif status == "LOSS":
        base = 0.2
    elif status in ("OPEN", "TP_HIT_TRIM"):
        base = 0.3
    if isinstance(pnl_pct, (int, float)):
        base = 0.5 * base + 0.5 * clamp((float(pnl_pct) + 10.0) / 25.0)
    if forced:
        base -= 0.2
    return clamp(base)


def score_journey(row: Dict[str, Any]) -> float:
    hold = row.get("hold_days")
    mfe = row.get("max_favorable_excursion")
    mae = row.get("max_adverse_excursion")
    hold_score = 0.4
    if isinstance(hold, (int, float)):
        h = float(hold)
        if h < 0.05:
            hold_score = 0.2
        elif h <= 0.4:
            hold_score = 0.65
        elif h <= 3.0:
            hold_score = 0.9
        elif h <= 8.0:
            hold_score = 0.75
        else:
            hold_score = 0.5
    mae_mfe_score = 0.45
    if isinstance(mfe, (int, float)) and isinstance(mae, (int, float)):
        f = max(0.0, float(mfe))
        a = abs(float(mae))
        rr = f / max(a, 0.25)
        mae_mfe_score = clamp(rr / 3.0)
    return clamp(0.6 * hold_score + 0.4 * mae_mfe_score)


def score_lineage(row: Dict[str, Any]) -> float:
    flags = row.get("lineage_quality_flags") or {}
    checks = [
        bool(flags.get("has_entry_path")),
        bool(flags.get("has_signal_snapshot")),
        bool(flags.get("has_tf_stack")),
        bool(flags.get("has_mfe_mae")),
        bool(flags.get("has_exit_reason")),
    ]
    return sum(1.0 for c in checks if c) / len(checks)


def score_annotation(row: Dict[str, Any]) -> float:
    c = str(row.get("annotation_classification") or "").lower()
    if not c:
        return 0.45
    if "good" in c or "valid win" in c:
        return 0.95
    if "held too long" in c:
        return 0.35
    if "bad" in c:
        return 0.15
    return 0.55


def hybrid_score(row: Dict[str, Any]) -> Dict[str, float]:
    outcome = score_outcome(row)
    journey = score_journey(row)
    lineage = score_lineage(row)
    annotation = score_annotation(row)
    score = (
        0.35 * outcome
        + 0.30 * journey
        + 0.20 * lineage
        + 0.15 * annotation
    )
    if bool(row.get("is_forced_close")):
        score -= 0.1
    return {
        "hybrid_score": round(clamp(score), 6),
        "outcome_quality": round(outcome, 6),
        "journey_quality": round(journey, 6),
        "lineage_quality": round(lineage, 6),
        "annotation_confidence": round(annotation, 6),
    }


@dataclass
class Caps:
    max_per_ticker: int
    max_per_sector: int
    top_n: int


def select_diverse(rows: List[Dict[str, Any]], caps: Caps) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    by_ticker = Counter()
    by_sector = Counter()
    by_direction_month = Counter()
    for r in rows:
        ticker = str(r.get("ticker") or "UNK")
        sector = str(r.get("sector") or "unknown")
        direction = str(r.get("direction") or "UNK")
        entry_ts = r.get("entry_ts")
        month = "unknown"
        if isinstance(entry_ts, int) and entry_ts > 0:
            month = datetime.fromtimestamp(entry_ts / 1000, tz=timezone.utc).strftime("%Y-%m")
        dm = f"{direction}:{month}"
        if by_ticker[ticker] >= caps.max_per_ticker:
            continue
        if by_sector[sector] >= caps.max_per_sector:
            continue
        if by_direction_month[dm] >= 30:
            continue
        out.append(r)
        by_ticker[ticker] += 1
        by_sector[sector] += 1
        by_direction_month[dm] += 1
        if len(out) >= caps.top_n:
            break
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Build hybrid-ranked reference trade selection")
    parser.add_argument("--input", default="data/reference-intel/trade-intel-canonical-v1.jsonl")
    parser.add_argument("--output", default="data/reference-intel/reference-selection-v1.json")
    parser.add_argument("--top-n", type=int, default=250)
    parser.add_argument("--max-per-ticker", type=int, default=4)
    parser.add_argument("--max-per-sector", type=int, default=55)
    args = parser.parse_args()

    rows = load_jsonl(Path(args.input))
    scored: List[Dict[str, Any]] = []
    for row in rows:
        status = str(row.get("status") or "").upper()
        if status in ("OPEN", "", "ARCHIVED"):
            continue
        metrics = hybrid_score(row)
        record = dict(row)
        record.update(metrics)
        scored.append(record)

    scored.sort(key=lambda x: x.get("hybrid_score", 0), reverse=True)
    selected = select_diverse(
        scored,
        Caps(
            max_per_ticker=max(1, args.max_per_ticker),
            max_per_sector=max(1, args.max_per_sector),
            top_n=max(1, args.top_n),
        ),
    )

    out = {
        "generated_at_utc": now_iso(),
        "input_rows": len(rows),
        "scored_rows": len(scored),
        "selected_rows": len(selected),
        "score_weights": {
            "outcome_quality": 0.35,
            "journey_quality": 0.30,
            "lineage_quality": 0.20,
            "annotation_confidence": 0.15,
        },
        "caps": {
            "max_per_ticker": args.max_per_ticker,
            "max_per_sector": args.max_per_sector,
            "top_n": args.top_n,
        },
        "sector_mix": dict(Counter(str(r.get("sector") or "unknown") for r in selected)),
        "top_ticker_mix": Counter(str(r.get("ticker") or "UNK") for r in selected).most_common(25),
        "references": selected,
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"selected_rows={len(selected)}")
    print(f"output={out_path}")


if __name__ == "__main__":
    main()

