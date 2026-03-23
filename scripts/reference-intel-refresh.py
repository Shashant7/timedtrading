#!/usr/bin/env python3
"""
Phase 10 automation entrypoint:
- refresh reference-intel artifacts
- run drift monitors (reference + CIO)
- run validation checks/matrix
- emit revalidation trigger artifact when needed
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def run(cmd: List[str], required: bool = True) -> bool:
    try:
        subprocess.check_call(cmd)
        return True
    except Exception:
        if required:
            raise
        return False


def load_json(path: str) -> Dict[str, Any]:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        obj = json.loads(p.read_text(encoding="utf-8"))
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def write_json(path: str, obj: Dict[str, Any]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, indent=2), encoding="utf-8")


def export_runtime_sources() -> bool:
    out_snap = "data/reference-intel/runtime-daily-market-snapshots-v1.json"
    out_events = "data/reference-intel/runtime-market-events-v1.json"
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
                "SELECT date, vix_close, vix_state, spy_pct, qqq_pct, iwm_pct, offense_avg_pct, defense_avg_pct, sector_rotation, regime_overall, regime_score, btc_pct, eth_pct FROM daily_market_snapshots ORDER BY date ASC",
                "--json",
            ],
            text=True,
        )
        Path(out_snap).write_text(raw, encoding="utf-8")
        raw2 = subprocess.check_output(
            [
                "npx",
                "wrangler",
                "d1",
                "execute",
                "timed-trading-ledger",
                "--remote",
                "--command",
                "SELECT date, event_type, event_name, impact, surprise_pct, spy_reaction_pct, sector_reaction_pct FROM market_events ORDER BY date ASC",
                "--json",
            ],
            text=True,
        )
        Path(out_events).write_text(raw2, encoding="utf-8")
        return True
    except Exception:
        return False


def has_runtime_sources() -> bool:
    return (
        Path("data/reference-intel/runtime-daily-market-snapshots-v1.json").exists()
        and Path("data/reference-intel/runtime-market-events-v1.json").exists()
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="Reference-intel refresh and drift automation")
    ap.add_argument("--run-matrix", action="store_true")
    ap.add_argument("--matrix-start", default="2025-07-31")
    ap.add_argument("--matrix-end", default="2025-08-01")
    ap.add_argument("--matrix-tickers", default="CSX,CDNS,ORCL,ITT")
    ap.add_argument("--output-trigger", default="data/reference-intel/revalidation-trigger-v1.json")
    args = ap.parse_args()

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    history_dir = Path("data/reference-intel/history")
    history_dir.mkdir(parents=True, exist_ok=True)
    current_sel = Path("data/reference-intel/reference-selection-v1.json")
    baseline_sel = current_sel
    if current_sel.exists():
        archived = history_dir / f"reference-selection-{ts}.json"
        shutil.copy2(current_sel, archived)
        baseline_sel = archived

    run(["python3", "scripts/reference-intel-build.py"])
    run(["python3", "scripts/reference-trade-selector.py"])
    run(["python3", "scripts/reference-coverage-report.py"])

    runtime_source_mode = "fresh_export" if export_runtime_sources() else ("cached_files" if has_runtime_sources() else "none")

    if has_runtime_sources():
        run(
            [
                "python3",
                "scripts/context-intel-builder.py",
                "--use-d1-runtime",
                "--runtime-snapshots-json",
                "data/reference-intel/runtime-daily-market-snapshots-v1.json",
                "--runtime-events-json",
                "data/reference-intel/runtime-market-events-v1.json",
            ]
        )
    else:
        run(["python3", "scripts/context-intel-builder.py"])
    run(["python3", "scripts/journey-blueprint-builder.py"])
    run(["python3", "scripts/policy-artifact-builder.py"])
    # In scheduled automation contexts, D1 CLI auth may be unavailable.
    # Build feature priors from local reference artifacts and use separate CIO drift script.
    run(["python3", "scripts/reference-cio-feature-pack.py", "--skip-d1"])
    run(["python3", "scripts/reference-validation-gates.py"])
    run(
        [
            "python3",
            "scripts/reference-drift-monitor.py",
            "--baseline",
            str(baseline_sel),
            "--candidate",
            "data/reference-intel/reference-selection-v1.json",
            "--output",
            "data/reference-intel/drift-monitor-v1.json",
        ]
    )
    cio_drift_ok = run(["python3", "scripts/cio-drift-monitor.py"], required=False)

    if args.run_matrix:
        matrix_ok = run(
            [
                "python3",
                "scripts/reference-validation-matrix.py",
                "--start-date",
                args.matrix_start,
                "--end-date",
                args.matrix_end,
                "--tickers",
                args.matrix_tickers,
            ],
            required=False,
        )
    else:
        matrix_ok = True

    drift = load_json("data/reference-intel/drift-monitor-v1.json")
    cio_drift = load_json("data/reference-intel/cio-drift-monitor-v1.json")
    gates = load_json("data/reference-intel/validation-gates-v1.json")
    matrix_go = load_json("data/reference-intel/validation-go-no-go-v1.json")

    should_revalidate = bool(drift.get("drift_alert")) or bool((cio_drift.get("alerts") or {}).get("drift_alert"))
    should_block = not bool(gates.get("overall_pass", False)) or not bool(matrix_go.get("overall_pass", False))
    trigger = {
        "generated_at_utc": now_iso(),
        "refresh_cycle_ts": ts,
        "runtime_source_mode": runtime_source_mode,
        "baseline_selection_file": str(baseline_sel),
        "candidate_selection_file": "data/reference-intel/reference-selection-v1.json",
        "alerts": {
            "reference_drift_alert": bool(drift.get("drift_alert")),
            "cio_drift_alert": bool((cio_drift.get("alerts") or {}).get("drift_alert")),
            "validation_gates_pass": bool(gates.get("overall_pass", False)),
            "matrix_go_no_go_pass": bool(matrix_go.get("overall_pass", False)) if matrix_ok else False,
            "cio_drift_monitor_ok": bool(cio_drift_ok),
            "matrix_run_ok": bool(matrix_ok),
        },
        "actions": {
            "should_revalidate": should_revalidate,
            "should_block_promotion": should_block or should_revalidate,
            "next_step": "run_validation_matrix" if should_revalidate else ("hold_promotion_fix_gates" if should_block else "eligible_for_promotion_review"),
        },
    }
    write_json(args.output_trigger, trigger)

    print(f"refresh_cycle_ts={ts}")
    print(f"trigger={args.output_trigger}")
    print(f"should_revalidate={trigger['actions']['should_revalidate']}")
    print(f"should_block_promotion={trigger['actions']['should_block_promotion']}")


if __name__ == "__main__":
    main()

