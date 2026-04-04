#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List


def load_rows(path: Path) -> List[Dict[str, Any]]:
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("trades", "rows", "results"):
            if isinstance(data.get(key), list):
                return data[key]
    return []


def parse_json(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        return json.loads(value)
    except Exception:
        return {}


def to_float(value: Any) -> float:
    try:
        return float(value)
    except Exception:
        return 0.0


def in_july_2025(entry_ts: Any) -> bool:
    try:
        ts = int(entry_ts)
    except Exception:
        return False
    start = int(dt.datetime(2025, 7, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)
    end = int(dt.datetime(2025, 8, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)
    return start <= ts < end


def summarize_bucket(rows: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    rows = list(rows)
    if not rows:
        return {}
    path_counts = Counter()
    exit_counts = Counter()
    profile_counts = Counter()
    rsi_div_counts = Counter()
    out = defaultdict(float)
    tf30_confirmed = 0
    tf30_opposed = 0
    late_phase = 0
    high_atr = 0
    pdz_adverse = 0
    for row in rows:
        snap = parse_json(row.get("signal_snapshot_json"))
        lineage = snap.get("lineage") or {}
        tf = snap.get("tf") or {}
        tf30 = tf.get("30m") or {}
        signals30 = tf30.get("signals") or {}
        saty_phase = (lineage.get("saty_phase") or {}).get("30") or {}
        atr_disp = lineage.get("atr_disp") or {}
        day_atr = atr_disp.get("day") or {}
        profile_counts[str(row.get("execution_profile_name") or "unknown")] += 1
        path_counts[str(row.get("entry_path") or "unknown")] += 1
        exit_counts[str(row.get("exit_reason") or "unknown")] += 1
        rsi_div = lineage.get("rsi_divergence") or {}
        if rsi_div:
            rsi_div_counts["present"] += 1
        else:
            rsi_div_counts["absent"] += 1
        if to_float(signals30.get("ema_cross")) > 0 and to_float(signals30.get("ema_structure")) > 0:
            tf30_confirmed += 1
        if to_float(signals30.get("supertrend")) < 0:
            tf30_opposed += 1
        if str(saty_phase.get("z") or "").upper() in {"HIGH", "EXTREME"}:
            late_phase += 1
        if to_float(day_atr.get("r")) >= 100:
            high_atr += 1
        pdz = lineage.get("pdz") or {}
        if pdz.get("D") in {"premium", "premium_approach"}:
            pdz_adverse += 1
        out["pnl"] += to_float(row.get("pnl"))
        out["pnl_pct"] += to_float(row.get("pnl_pct"))
        out["entry_quality_score"] += to_float(row.get("entry_quality_score"))
        out["rvol_best"] += to_float(row.get("rvol_best"))
    n = len(rows)
    return {
        "trade_count": n,
        "wins": sum(1 for row in rows if str(row.get("status")) == "WIN" or to_float(row.get("pnl")) > 0),
        "losses": sum(1 for row in rows if str(row.get("status")) == "LOSS" or to_float(row.get("pnl")) <= 0),
        "avg_pnl": round(out["pnl"] / n, 2),
        "avg_pnl_pct": round(out["pnl_pct"] / n, 3),
        "avg_entry_quality_score": round(out["entry_quality_score"] / n, 2),
        "avg_rvol_best": round(out["rvol_best"] / n, 2),
        "tf30_confirmed_rate": round(tf30_confirmed / n, 3),
        "tf30_opposed_rate": round(tf30_opposed / n, 3),
        "late_phase_rate": round(late_phase / n, 3),
        "high_atr_rate": round(high_atr / n, 3),
        "pdz_adverse_rate": round(pdz_adverse / n, 3),
        "entry_paths_top": path_counts.most_common(5),
        "exit_reasons_top": exit_counts.most_common(5),
        "profiles_top": profile_counts.most_common(5),
        "rsi_divergence_presence": dict(rsi_div_counts),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", action="append", required=True, help="trade-autopsy-trades.json path")
    parser.add_argument("--losers", default="FIX,CELH,RBLX")
    parser.add_argument("--winners", default="ETN,ULTA,CAT")
    parser.add_argument("--output", default="")
    args = parser.parse_args()

    loser_set = {t.strip().upper() for t in args.losers.split(",") if t.strip()}
    winner_set = {t.strip().upper() for t in args.winners.split(",") if t.strip()}
    collected: List[Dict[str, Any]] = []
    for item in args.artifact:
        p = Path(item)
        for row in load_rows(p):
            if not in_july_2025(row.get("entry_ts") or row.get("entryTs")):
                continue
            ticker = str(row.get("ticker") or "").upper()
            if ticker in loser_set or ticker in winner_set:
                row = dict(row)
                row["_artifact"] = p.parent.name
                collected.append(row)

    by_ticker = defaultdict(list)
    for row in collected:
        by_ticker[str(row.get("ticker")).upper()].append(row)

    ticker_reports = {
        ticker: summarize_bucket(rows)
        for ticker, rows in sorted(by_ticker.items())
    }
    loser_rows = [row for row in collected if str(row.get("ticker")).upper() in loser_set]
    winner_rows = [row for row in collected if str(row.get("ticker")).upper() in winner_set]
    report = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "artifacts": args.artifact,
        "losers": sorted(loser_set),
        "winners": sorted(winner_set),
        "loser_summary": summarize_bucket(loser_rows),
        "winner_summary": summarize_bucket(winner_rows),
        "by_ticker": ticker_reports,
    }
    out_path = Path(args.output) if args.output else Path(
        f"data/july-evidence-pack-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')}.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2))
    print(out_path)
    print(json.dumps({
        "loser_summary": report["loser_summary"],
        "winner_summary": report["winner_summary"],
    }, indent=2))


if __name__ == "__main__":
    main()
