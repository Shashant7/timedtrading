#!/usr/bin/env python3
"""
Run a focused parity diagnostic for known target tickers/date.

This uses existing worker admin endpoints:
  - GET  /timed/admin/replay-data-stats
  - POST /timed/admin/replay-ticker-d1?debug=1

It compares expected artifact entries vs replay diagnostics and writes a JSON report.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests


DEFAULT_BASE_URL = "https://timed-trading-ingest.shashant.workers.dev"
DEFAULT_EXPECTED_ARTIFACT = (
    "data/backtest-artifacts/option-a-rank-overhaul--20260309-202532/trade-autopsy-trades.json"
)
DEFAULT_TICKERS = ["CDNS", "ORCL", "CSX", "ITT"]


def ts_to_iso(ts_ms: Optional[int]) -> Optional[str]:
    if not ts_ms:
        return None
    return dt.datetime.fromtimestamp(ts_ms / 1000, tz=dt.timezone.utc).isoformat()


def load_expected_entries(artifact_path: Path, date_str: str, tickers: List[str]) -> List[Dict[str, Any]]:
    payload = json.loads(artifact_path.read_text())
    rows = payload.get("trades") or []
    tick_set = {t.upper() for t in tickers}
    start = int(dt.datetime.fromisoformat(date_str).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
    end = start + (24 * 60 * 60 * 1000) - 1
    out: List[Dict[str, Any]] = []
    for t in rows:
        sym = str(t.get("ticker") or "").upper()
        ts = int(t.get("entry_ts") or 0)
        if sym not in tick_set or ts < start or ts > end:
            continue
        signal = {}
        try:
            signal = json.loads(t.get("signal_snapshot_json") or "{}")
        except Exception:
            signal = {}
        tf = signal.get("tf") or {}
        out.append(
            {
                "ticker": sym,
                "entry_ts": ts,
                "entry_iso_utc": ts_to_iso(ts),
                "entry_path": t.get("entry_path"),
                "direction": t.get("direction"),
                "avg_bias": signal.get("avg_bias"),
                "bias_10m": (tf.get("10m") or {}).get("bias"),
                "bias_30m": (tf.get("30m") or {}).get("bias"),
                "bias_1H": (tf.get("1H") or {}).get("bias"),
                "bias_4H": (tf.get("4H") or {}).get("bias"),
                "bias_D": (tf.get("D") or {}).get("bias"),
            }
        )
    out.sort(key=lambda x: x["entry_ts"])
    return out


def call_json(session: requests.Session, method: str, url: str, **kwargs) -> Dict[str, Any]:
    r = session.request(method, url, timeout=120, **kwargs)
    r.raise_for_status()
    return r.json()


def summarize_analysis_rows(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    final_stages = Counter(str(r.get("finalStage") or "") for r in rows)
    forced_reasons = Counter(str(r.get("forcedReason") or "") for r in rows if r.get("forcedReason"))
    blockers = Counter()
    for r in rows:
        b = r.get("blockers")
        if isinstance(b, list):
            blockers.update(str(x) for x in b if x)

    first_in_review = next((r for r in rows if str(r.get("finalStage")) in {"in_review", "enter", "enter_now"}), None)
    first_enter_now = next((r for r in rows if str(r.get("finalStage")) == "enter_now"), None)
    return {
        "final_stage_counts": dict(final_stages),
        "forced_reason_counts": dict(forced_reasons),
        "top_blockers": blockers.most_common(12),
        "first_in_review_row": first_in_review,
        "first_enter_now_row": first_enter_now,
    }


def filter_trades_for_day(trades: List[Dict[str, Any]], date_str: str, ticker: str) -> List[Dict[str, Any]]:
    start = int(dt.datetime.fromisoformat(date_str).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
    end = start + (24 * 60 * 60 * 1000) - 1
    sym = ticker.upper()
    out = []
    for t in trades:
        ts = int(t.get("entry_ts") or 0)
        if str(t.get("ticker") or "").upper() == sym and start <= ts <= end:
            out.append(
                {
                    "ticker": sym,
                    "entry_ts": ts,
                    "entry_iso_utc": ts_to_iso(ts),
                    "direction": t.get("direction"),
                    "status": t.get("status"),
                    "entry_path": t.get("entry_path"),
                    "exit_reason": t.get("exit_reason") or t.get("exitReason"),
                    "rank": t.get("rank"),
                }
            )
    out.sort(key=lambda x: x["entry_ts"])
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Parity diagnostic for artifact-vs-replay entry behavior.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--key", required=True)
    parser.add_argument("--date", default="2025-07-01")
    parser.add_argument("--tickers", default=",".join(DEFAULT_TICKERS))
    parser.add_argument("--expected-artifact", default=DEFAULT_EXPECTED_ARTIFACT)
    parser.add_argument("--limit", type=int, default=1000, help="Max timed_trail rows per ticker replay.")
    parser.add_argument(
        "--output",
        default=None,
        help="Output JSON path. Default: data/parity-diagnostic-<date>-<utcstamp>.json",
    )
    args = parser.parse_args()

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    artifact_path = Path(args.expected_artifact)
    expected = load_expected_entries(artifact_path, args.date, tickers)
    expected_by_ticker: Dict[str, List[Dict[str, Any]]] = {}
    for e in expected:
        expected_by_ticker.setdefault(e["ticker"], []).append(e)

    report: Dict[str, Any] = {
        "date": args.date,
        "base_url": args.base_url,
        "tickers": tickers,
        "expected_artifact": str(artifact_path),
        "expected_entries": expected,
        "diagnostics": [],
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
    }

    s = requests.Session()
    # Keep state deterministic for this diagnostic loop.
    try:
        s.delete(f"{args.base_url}/timed/admin/replay-lock", params={"key": args.key}, timeout=60)
    except Exception:
        pass
    call_json(
        s,
        "POST",
        f"{args.base_url}/timed/admin/reset",
        params={"key": args.key, "resetLedger": "1"},
    )

    for i, ticker in enumerate(tickers):
        stats = call_json(
            s,
            "GET",
            f"{args.base_url}/timed/admin/replay-data-stats",
            params={"key": args.key, "date": args.date, "ticker": ticker},
        )
        replay = call_json(
            s,
            "POST",
            f"{args.base_url}/timed/admin/replay-ticker-d1",
            params={
                "key": args.key,
                "ticker": ticker,
                "date": args.date,
                "cleanSlate": "1" if i == 0 else "0",
                "debug": "1",
                "limit": str(args.limit),
            },
        )
        analysis_rows = ((replay.get("analysis") or {}).get("rows")) or []
        analysis_summary = summarize_analysis_rows(analysis_rows)
        trades_payload = call_json(
            s,
            "GET",
            f"{args.base_url}/timed/trades",
            params={"key": args.key, "source": "d1"},
        )
        actual_entries = filter_trades_for_day(trades_payload.get("trades") or [], args.date, ticker)
        report["diagnostics"].append(
            {
                "ticker": ticker,
                "expected_entries": expected_by_ticker.get(ticker, []),
                "replay_data_stats": stats,
                "replay_summary": {
                    "rowsProcessed": replay.get("rowsProcessed"),
                    "tradesCreated": replay.get("tradesCreated"),
                    "laneCounts": replay.get("laneCounts"),
                    "prevPeriodSeeded": replay.get("prevPeriodSeeded"),
                },
                "analysis_summary": analysis_summary,
                "actual_entries_after_replay": actual_entries,
            }
        )

    output = Path(args.output) if args.output else Path(
        f"data/parity-diagnostic-{args.date}-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')}.json"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2))
    print(str(output))


if __name__ == "__main__":
    main()
