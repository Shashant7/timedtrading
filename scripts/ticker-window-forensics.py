#!/usr/bin/env python3
"""
Ticker + date-window forensics.

For each reference trade, find all overlapping trades for the same ticker across
artifact runs and summarize what repeated, what diverged, and which paths/exits dominated.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional


def load_rows(path: Path) -> List[Dict[str, Any]]:
    try:
        data = json.loads(path.read_text())
    except Exception:
        return []
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("trades", "rows", "results"):
            if isinstance(data.get(key), list):
                return data[key]
    return []


def parse_ts(value: Any) -> Optional[int]:
    try:
        iv = int(value)
        return iv if iv > 0 else None
    except Exception:
        return None


def to_float(value: Any) -> float:
    try:
        return float(value)
    except Exception:
        return 0.0


def normalize_trade(row: Dict[str, Any], source: str) -> Optional[Dict[str, Any]]:
    entry_ts = parse_ts(row.get("entry_ts") or row.get("entryTs"))
    exit_ts = parse_ts(row.get("exit_ts") or row.get("exitTs"))
    if not entry_ts or not exit_ts or exit_ts <= entry_ts:
        return None
    ticker = str(row.get("ticker") or "").upper().strip()
    if not ticker:
        return None
    return {
        "ticker": ticker,
        "entry_ts": entry_ts,
        "exit_ts": exit_ts,
        "pnl": to_float(row.get("pnl")),
        "pnl_pct": to_float(row.get("pnl_pct")),
        "entry_path": str(row.get("entry_path") or ""),
        "exit_reason": str(row.get("exit_reason") or ""),
        "run_id": str(row.get("run_id") or row.get("runId") or ""),
        "trade_id": str(row.get("trade_id") or row.get("id") or row.get("tradeId") or ""),
        "source": source,
        "direction": str(row.get("direction") or row.get("side") or "").upper(),
    }


def et_str(ms: int) -> str:
    et = dt.timezone(dt.timedelta(hours=-4))
    d = dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).astimezone(et)
    return d.strftime("%Y-%m-%d %I:%M %p")


def main() -> None:
    p = argparse.ArgumentParser(description="Ticker + date-window cross-run forensics")
    p.add_argument("--artifacts-dir", default="data/backtest-artifacts")
    p.add_argument("--reference", required=True, help="Reference trade-autopsy-trades.json")
    p.add_argument("--tickers", default="", help="Optional comma-separated ticker filter")
    p.add_argument("--require-positive-reference", action="store_true", default=True)
    p.add_argument("--nearest-limit", type=int, default=5)
    p.add_argument("--output", default="")
    args = p.parse_args()

    tickers_filter = {
        t.strip().upper()
        for t in args.tickers.split(",")
        if t.strip()
    }

    ref_rows = load_rows(Path(args.reference))
    ref_trades: Dict[str, Dict[str, Any]] = {}
    for row in ref_rows:
        tr = normalize_trade(row, "reference")
        if not tr:
            continue
        if tickers_filter and tr["ticker"] not in tickers_filter:
            continue
        if args.require_positive_reference and tr["pnl"] <= 0:
            continue
        prev = ref_trades.get(tr["ticker"])
        if not prev or tr["pnl"] > prev["pnl"]:
            ref_trades[tr["ticker"]] = tr

    all_trades: List[Dict[str, Any]] = []
    pattern = str(Path(args.artifacts_dir) / "**" / "trade-autopsy-trades.json")
    for file in glob.glob(pattern, recursive=True):
        source = Path(file).parent.name
        for row in load_rows(Path(file)):
            tr = normalize_trade(row, source)
            if tr and tr["ticker"] in ref_trades:
                all_trades.append(tr)

    report: List[Dict[str, Any]] = []
    for ticker, ref in sorted(ref_trades.items()):
        start_ts, end_ts = ref["entry_ts"], ref["exit_ts"]
        overlaps: List[Dict[str, Any]] = []
        for tr in all_trades:
            if tr["ticker"] != ticker:
                continue
            if tr["entry_ts"] <= end_ts and tr["exit_ts"] >= start_ts:
                overlaps.append(tr)

        seen = set()
        uniq = []
        for tr in overlaps:
            key = (tr["source"], tr["trade_id"])
            if key in seen:
                continue
            seen.add(key)
            uniq.append(tr)
        overlaps = uniq

        wins = [t for t in overlaps if t["pnl"] > 0]
        losses = [t for t in overlaps if t["pnl"] <= 0]
        by_path = Counter((t["entry_path"] or "unknown") for t in overlaps)
        by_exit = Counter((t["exit_reason"] or "unknown") for t in overlaps)

        alternates = [t for t in overlaps if t["trade_id"] != ref["trade_id"]]
        alternates.sort(key=lambda t: abs(t["entry_ts"] - ref["entry_ts"]))

        report.append(
            {
                "ticker": ticker,
                "reference_trade": {
                    "trade_id": ref["trade_id"],
                    "entry_et": et_str(ref["entry_ts"]),
                    "exit_et": et_str(ref["exit_ts"]),
                    "pnl": round(ref["pnl"], 2),
                    "pnl_pct": round(ref["pnl_pct"], 3),
                    "entry_path": ref["entry_path"],
                    "exit_reason": ref["exit_reason"],
                    "direction": ref["direction"],
                },
                "overlap_window_stats": {
                    "total_trades": len(overlaps),
                    "wins": len(wins),
                    "losses": len(losses),
                    "win_rate": round((len(wins) / len(overlaps)) * 100, 1) if overlaps else 0.0,
                    "avg_pnl": round(sum(t["pnl"] for t in overlaps) / len(overlaps), 2) if overlaps else 0.0,
                    "entry_paths_top": by_path.most_common(5),
                    "exit_reasons_top": by_exit.most_common(5),
                    "sources_count": len({t["source"] for t in overlaps}),
                },
                "nearest_alternates": [
                    {
                        "source": t["source"],
                        "run_id": t["run_id"],
                        "trade_id": t["trade_id"],
                        "entry_et": et_str(t["entry_ts"]),
                        "exit_et": et_str(t["exit_ts"]),
                        "entry_path": t["entry_path"],
                        "exit_reason": t["exit_reason"],
                        "pnl": round(t["pnl"], 2),
                        "pnl_pct": round(t["pnl_pct"], 3),
                    }
                    for t in alternates[: max(1, args.nearest_limit)]
                ],
            }
        )

    out_path = Path(args.output) if args.output else Path(
        f"data/ticker-window-forensics-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')}.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(
            {
                "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
                "reference": args.reference,
                "tickers": sorted(ref_trades.keys()),
                "report": report,
            },
            indent=2,
        )
    )
    print(str(out_path))
    for row in report:
        s = row["overlap_window_stats"]
        top_path = s["entry_paths_top"][0][0] if s["entry_paths_top"] else "n/a"
        print(
            f"{row['ticker']}: trades={s['total_trades']} wr={s['win_rate']}% "
            f"avg_pnl={s['avg_pnl']} top_path={top_path}"
        )


if __name__ == "__main__":
    main()
