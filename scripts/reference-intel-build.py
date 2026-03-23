#!/usr/bin/env python3
"""
Build canonical full-history trade intelligence dataset from backtest artifacts.

Outputs:
- data/reference-intel/trade-intel-canonical-v1.jsonl
- data/reference-intel/trade-intel-canonical-v1-summary.json
- data/reference-intel/lineage-quality-audit-v1.json
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


FORCED_CLOSE_PATTERNS = (
    "REPLAY_END_CLOSE",
    "TIME_EXIT_LOSER_TRANSITIONAL",
    "UNKNOWN",
)


@dataclass
class TradePick:
    row: Dict[str, Any]
    score: int


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def as_list_payload(payload: Any) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        for key in ("trades", "rows", "results", "summaries"):
            value = payload.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]
    return []


def pick(*values: Any) -> Any:
    for value in values:
        if value is None:
            continue
        if isinstance(value, str) and value.strip() == "":
            continue
        return value
    return None


def to_number(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except Exception:
        return None


def to_int(value: Any) -> Optional[int]:
    n = to_number(value)
    if n is None:
        return None
    try:
        return int(n)
    except Exception:
        return None


def parse_json_maybe(raw: Any) -> Optional[Any]:
    if raw is None:
        return None
    if isinstance(raw, (dict, list)):
        return raw
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return None
        try:
            return json.loads(s)
        except Exception:
            return None
    return None


def parse_signal_snapshot(raw: Any) -> Tuple[Optional[float], int]:
    obj = parse_json_maybe(raw)
    if not isinstance(obj, dict):
        return None, 0
    avg_bias = to_number(obj.get("avg_bias"))
    tf = obj.get("tf")
    tf_count = len(tf) if isinstance(tf, dict) else 0
    return avg_bias, tf_count


def parse_tf_stack_count(raw: Any) -> int:
    obj = parse_json_maybe(raw)
    if isinstance(obj, list):
        return len(obj)
    return 0


def classify_exit_reason(reason: Any) -> str:
    s = str(reason or "").upper().strip()
    if not s:
        return "unknown"
    if "TP_FULL" in s:
        return "tp_full"
    if "FUSE" in s:
        return "fuse"
    if any(x in s for x in ("MAX_LOSS", "SL_BREACHED", "TRIGGER_BREACHED", "LARGE_ADVERSE_MOVE")):
        return "loss_protect"
    if any(x in s for x in ("REGIME", "EMA_REGIME")):
        return "regime_reversal"
    if "TRIM" in s:
        return "trim_related"
    return "other"


def is_forced_close(reason: Any) -> bool:
    s = str(reason or "").upper().strip()
    if not s:
        return True
    return any(p in s for p in FORCED_CLOSE_PATTERNS)


def hold_days(entry_ts: Optional[int], exit_ts: Optional[int]) -> Optional[float]:
    if not entry_ts or not exit_ts or exit_ts <= entry_ts:
        return None
    return round((exit_ts - entry_ts) / 86400000.0, 4)


def normalize_status(status: Any) -> str:
    return str(status or "").upper().strip()


def rank_trade_row_for_merge(row: Dict[str, Any]) -> int:
    status = normalize_status(row.get("status"))
    closed_bonus = 2 if status not in ("", "OPEN", "TP_HIT_TRIM") else 0
    has_exit = 1 if to_int(row.get("exit_ts")) else 0
    return closed_bonus + has_exit


def build_trade_map(rows: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    picks: Dict[str, TradePick] = {}
    for row in rows:
        trade_id = str(pick(row.get("trade_id"), row.get("id"), row.get("tradeId")) or "").strip()
        if not trade_id:
            continue
        score = rank_trade_row_for_merge(row)
        existing = picks.get(trade_id)
        if existing is None or score > existing.score:
            picks[trade_id] = TradePick(row=row, score=score)
    return {k: v.row for k, v in picks.items()}


def load_sector_map(path: Path) -> Dict[str, str]:
    data = load_json(path)
    if not isinstance(data, dict):
        return {}
    if isinstance(data.get("SECTOR_MAP"), dict):
        data = data["SECTOR_MAP"]
    out: Dict[str, str] = {}
    for k, v in data.items():
        sym = str(k).upper().strip()
        if not sym:
            continue
        out[sym] = str(v)
    return out


def canonical_row(
    run_dir: Path,
    manifest: Dict[str, Any],
    base: Dict[str, Any],
    aut: Optional[Dict[str, Any]],
    sector_map: Dict[str, str],
) -> Dict[str, Any]:
    trade_id = str(pick((aut or {}).get("trade_id"), base.get("trade_id"), base.get("id"), base.get("tradeId")) or "")
    run_id = str(pick((aut or {}).get("run_id"), base.get("run_id"), base.get("runId")) or "")
    ticker = str(pick((aut or {}).get("ticker"), base.get("ticker")) or "").upper()
    direction = str(pick((aut or {}).get("direction"), base.get("direction"), base.get("side")) or "").upper()
    status = str(pick((aut or {}).get("status"), base.get("status")) or "").upper()
    entry_ts = to_int(pick((aut or {}).get("entry_ts"), base.get("entry_ts"), base.get("entryTime")))
    exit_ts = to_int(pick((aut or {}).get("exit_ts"), base.get("exit_ts")))
    pnl = to_number(pick((aut or {}).get("pnl"), base.get("pnl")))
    pnl_pct = to_number(pick((aut or {}).get("pnl_pct"), (aut or {}).get("pnlPct"), base.get("pnl_pct"), base.get("pnlPct")))
    entry_path = str(pick((aut or {}).get("entry_path"), base.get("entry_path"), base.get("entryPath")) or "")
    exit_reason = str(pick((aut or {}).get("exit_reason"), (aut or {}).get("exitReason"), base.get("exit_reason"), base.get("exitReason")) or "")
    signal_snapshot_raw = pick((aut or {}).get("signal_snapshot_json"), base.get("signal_snapshot_json"))
    tf_stack_raw = pick((aut or {}).get("tf_stack_json"), base.get("tf_stack_json"))
    avg_bias, snapshot_tf_count = parse_signal_snapshot(signal_snapshot_raw)
    tf_stack_count = parse_tf_stack_count(tf_stack_raw)
    mfe = to_number(pick((aut or {}).get("max_favorable_excursion"), base.get("max_favorable_excursion"), base.get("mfe_pct")))
    mae = to_number(pick((aut or {}).get("max_adverse_excursion"), base.get("max_adverse_excursion"), base.get("mae_pct")))

    has_entry_path = bool(entry_path)
    has_signal_snapshot = signal_snapshot_raw is not None and str(signal_snapshot_raw).strip() != ""
    has_tf_stack = tf_stack_raw is not None and str(tf_stack_raw).strip() != ""
    has_mfe_mae = mfe is not None or mae is not None
    has_exit_reason = bool(exit_reason)

    row = {
        "run_id": run_id,
        "run_label": run_dir.name,
        "run_start_date": manifest.get("start_date"),
        "run_end_date": manifest.get("end_date"),
        "trade_id": trade_id,
        "ticker": ticker,
        "direction": direction,
        "sector": sector_map.get(ticker),
        "entry_ts": entry_ts,
        "exit_ts": exit_ts,
        "status": status,
        "entry_path": entry_path or None,
        "exit_reason": exit_reason or None,
        "exit_class": classify_exit_reason(exit_reason),
        "is_forced_close": is_forced_close(exit_reason),
        "is_closed": status not in ("OPEN", "TP_HIT_TRIM", ""),
        "hold_days": hold_days(entry_ts, exit_ts),
        "pnl": pnl,
        "pnl_pct": pnl_pct,
        "signal_snapshot_json": signal_snapshot_raw,
        "tf_stack_json": tf_stack_raw,
        "snapshot_avg_bias": avg_bias,
        "snapshot_tf_count": snapshot_tf_count,
        "tf_stack_count": tf_stack_count,
        "consensus_direction": pick((aut or {}).get("consensus_direction"), base.get("consensus_direction")),
        "max_favorable_excursion": mfe,
        "max_adverse_excursion": mae,
        "annotation_classification": (aut or {}).get("annotation_classification"),
        "annotation_entry_grade": (aut or {}).get("annotation_entry_grade"),
        "annotation_trade_management": (aut or {}).get("annotation_trade_management"),
        "lineage_quality_flags": {
            "has_entry_path": has_entry_path,
            "has_signal_snapshot": has_signal_snapshot,
            "has_tf_stack": has_tf_stack,
            "has_mfe_mae": has_mfe_mae,
            "has_exit_reason": has_exit_reason,
        },
        "source_file": "trade-autopsy-trades.json" if aut is not None else "trades.json",
        "artifact_dir": str(run_dir),
    }
    return row


def build_summary(rows: List[Dict[str, Any]], runs_scanned: int, runs_with_data: int) -> Dict[str, Any]:
    status_counts = Counter(str(r.get("status") or "") for r in rows)
    exit_class_counts = Counter(str(r.get("exit_class") or "unknown") for r in rows)
    ticker_counts = Counter(str(r.get("ticker") or "") for r in rows)
    sector_counts = Counter(str(r.get("sector") or "unknown") for r in rows)
    run_counts = Counter(str(r.get("run_label") or "") for r in rows)
    total = len(rows) or 1
    missing = defaultdict(int)
    for r in rows:
        flags = r.get("lineage_quality_flags") or {}
        for k in ("has_entry_path", "has_signal_snapshot", "has_tf_stack", "has_mfe_mae", "has_exit_reason"):
            if not bool(flags.get(k)):
                missing[k] += 1
    missing_rates = {k: round(v / total, 4) for k, v in missing.items()}
    return {
        "generated_at_utc": now_iso(),
        "runs_scanned": runs_scanned,
        "runs_with_data": runs_with_data,
        "row_count": len(rows),
        "unique_tickers": len(ticker_counts),
        "status_counts": dict(status_counts),
        "exit_class_counts": dict(exit_class_counts),
        "top_tickers": ticker_counts.most_common(25),
        "top_sectors": sector_counts.most_common(25),
        "top_runs": run_counts.most_common(50),
        "lineage_missing_rates": missing_rates,
    }


def build_lineage_quality_audit(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_run: Dict[str, Counter] = defaultdict(Counter)
    for r in rows:
        run = str(r.get("run_label") or "")
        by_run[run]["rows"] += 1
        flags = r.get("lineage_quality_flags") or {}
        for k in ("has_entry_path", "has_signal_snapshot", "has_tf_stack", "has_mfe_mae", "has_exit_reason"):
            if not bool(flags.get(k)):
                by_run[run][f"missing_{k}"] += 1
    run_quality = []
    for run, c in by_run.items():
        n = max(1, int(c["rows"]))
        run_quality.append({
            "run_label": run,
            "rows": int(c["rows"]),
            "missing_has_entry_path": int(c["missing_has_entry_path"]),
            "missing_has_signal_snapshot": int(c["missing_has_signal_snapshot"]),
            "missing_has_tf_stack": int(c["missing_has_tf_stack"]),
            "missing_has_mfe_mae": int(c["missing_has_mfe_mae"]),
            "missing_has_exit_reason": int(c["missing_has_exit_reason"]),
            "missing_rate_has_entry_path": round(c["missing_has_entry_path"] / n, 4),
            "missing_rate_has_signal_snapshot": round(c["missing_has_signal_snapshot"] / n, 4),
            "missing_rate_has_tf_stack": round(c["missing_has_tf_stack"] / n, 4),
            "missing_rate_has_mfe_mae": round(c["missing_has_mfe_mae"] / n, 4),
            "missing_rate_has_exit_reason": round(c["missing_has_exit_reason"] / n, 4),
        })
    run_quality.sort(key=lambda x: (x["missing_rate_has_entry_path"], x["missing_rate_has_signal_snapshot"], x["rows"]), reverse=True)
    return {
        "generated_at_utc": now_iso(),
        "row_count": len(rows),
        "runs": run_quality,
    }


def iter_artifact_runs(artifacts_dir: Path) -> Iterable[Path]:
    for p in sorted(artifacts_dir.iterdir()):
        if p.is_dir():
            yield p


def main() -> None:
    parser = argparse.ArgumentParser(description="Build canonical reference-intel dataset from artifacts")
    parser.add_argument("--artifacts-dir", default="data/backtest-artifacts")
    parser.add_argument("--output-dir", default="data/reference-intel")
    parser.add_argument("--sector-map", default="configs/sector-map.json")
    args = parser.parse_args()

    artifacts_dir = Path(args.artifacts_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    sector_map = load_sector_map(Path(args.sector_map))

    rows: List[Dict[str, Any]] = []
    runs_scanned = 0
    runs_with_data = 0

    for run_dir in iter_artifact_runs(artifacts_dir):
        runs_scanned += 1
        manifest = load_json(run_dir / "manifest.json")
        if not isinstance(manifest, dict):
            manifest = {}
        autopsy_rows = as_list_payload(load_json(run_dir / "trade-autopsy-trades.json"))
        trade_rows = as_list_payload(load_json(run_dir / "trades.json"))
        if not autopsy_rows and not trade_rows:
            continue
        runs_with_data += 1
        trade_map = build_trade_map(trade_rows)
        seen: set[str] = set()

        for aut in autopsy_rows:
            tid = str(pick(aut.get("trade_id"), aut.get("id"), aut.get("tradeId")) or "").strip()
            if not tid:
                continue
            seen.add(tid)
            base = trade_map.get(tid, {})
            rows.append(canonical_row(run_dir, manifest, base, aut, sector_map))

        for tid, base in trade_map.items():
            if tid in seen:
                continue
            rows.append(canonical_row(run_dir, manifest, base, None, sector_map))

    canonical_path = output_dir / "trade-intel-canonical-v1.jsonl"
    summary_path = output_dir / "trade-intel-canonical-v1-summary.json"
    quality_path = output_dir / "lineage-quality-audit-v1.json"

    with canonical_path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")

    summary = build_summary(rows, runs_scanned, runs_with_data)
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    quality = build_lineage_quality_audit(rows)
    quality_path.write_text(json.dumps(quality, indent=2), encoding="utf-8")

    print(f"rows={len(rows)}")
    print(f"runs_scanned={runs_scanned}")
    print(f"runs_with_data={runs_with_data}")
    print(f"canonical={canonical_path}")
    print(f"summary={summary_path}")
    print(f"quality={quality_path}")


if __name__ == "__main__":
    main()

