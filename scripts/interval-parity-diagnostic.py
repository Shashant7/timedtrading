#!/usr/bin/env python3
"""
Focused interval-by-interval parity probe using /timed/admin/interval-replay.

Goal:
- For each ticker, find earliest interval where either:
  1) trade gets created, or
  2) entry is blocked and a dominant block reason appears.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from typing import Any, Dict, List

import requests


DEFAULT_BASE_URL = "https://timed-trading-ingest.shashant.workers.dev"
DEFAULT_TICKERS = ["CDNS", "ORCL", "CSX", "ITT"]


def interval_ts(date_str: str, interval_idx: int, interval_minutes: int) -> int:
    # 9:30 ET is 13:30 UTC in July (DST). This diagnostic date is Jul 1, 2025.
    # Using UTC anchor here is sufficient for reporting; worker does authoritative interval math.
    base = dt.datetime.fromisoformat(f"{date_str}T13:30:00+00:00")
    return int((base + dt.timedelta(minutes=interval_idx * interval_minutes)).timestamp() * 1000)


def iso_utc(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).isoformat()


def call_json(session: requests.Session, method: str, url: str, **kwargs) -> Dict[str, Any]:
    r = session.request(method, url, timeout=120, **kwargs)
    r.raise_for_status()
    return r.json()


def main() -> None:
    p = argparse.ArgumentParser(description="Interval replay parity diagnostics for target tickers.")
    p.add_argument("--key", required=True)
    p.add_argument("--date", default="2025-07-01")
    p.add_argument("--tickers", default=",".join(DEFAULT_TICKERS))
    p.add_argument("--base-url", default=DEFAULT_BASE_URL)
    p.add_argument("--interval-minutes", type=int, default=5)
    p.add_argument("--max-intervals", type=int, default=79)
    p.add_argument("--engine", default="legacy")
    p.add_argument("--output", default=None)
    args = p.parse_args()

    tickers = [x.strip().upper() for x in args.tickers.split(",") if x.strip()]
    s = requests.Session()

    report: Dict[str, Any] = {
        "date": args.date,
        "tickers": tickers,
        "engine": args.engine,
        "interval_minutes": args.interval_minutes,
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "results": [],
    }

    for ticker in tickers:
        # isolate each ticker probe
        try:
            s.delete(f"{args.base_url}/timed/admin/replay-lock", params={"key": args.key}, timeout=30)
        except Exception:
            pass
        call_json(
            s,
            "POST",
            f"{args.base_url}/timed/admin/reset",
            params={"key": args.key, "resetLedger": "1"},
        )

        ticker_result: Dict[str, Any] = {
            "ticker": ticker,
            "first_signal_interval": None,
            "first_signal_time_utc": None,
            "signal_type": None,
            "top_reason": None,
            "top_reason_count": 0,
            "stage_counts": None,
            "trades_created_in_interval": 0,
            "scored_in_interval": 0,
            "interval_checks": [],
        }

        for i in range(args.max_intervals):
            payload = call_json(
                s,
                "POST",
                f"{args.base_url}/timed/admin/interval-replay",
                params={
                    "key": args.key,
                    "date": args.date,
                    "interval": str(i),
                    "intervalMinutes": str(args.interval_minutes),
                    "cleanSlate": "1" if i == 0 else "0",
                    "traderOnly": "1",
                    "tickers": ticker,
                    "ENTRY_ENGINE": args.engine,
                    "MANAGEMENT_ENGINE": args.engine,
                },
            )
            block_reasons = payload.get("blockReasons") or {}
            stage_counts = payload.get("stageCounts") or {}
            process_debug = payload.get("processDebug") or []
            blocked_entry_gates = payload.get("blockedEntryGates") or {}
            trades_created = int(payload.get("tradesCreated") or 0)
            scored = int(payload.get("scored") or 0)

            top_reason = None
            top_reason_count = 0
            if block_reasons:
                top_reason, top_reason_count = sorted(
                    block_reasons.items(), key=lambda kv: kv[1], reverse=True
                )[0]

            ticker_result["interval_checks"].append(
                {
                    "interval": i,
                    "time_utc": iso_utc(interval_ts(args.date, i, args.interval_minutes)),
                    "scored": scored,
                    "tradesCreated": trades_created,
                    "topBlockReason": top_reason,
                    "topBlockReasonCount": top_reason_count,
                    "stageCounts": stage_counts,
                    "blockedEntryGates": blocked_entry_gates,
                    "processDebug": process_debug[:12],
                }
            )

            if trades_created > 0:
                ticker_result["first_signal_interval"] = i
                ticker_result["first_signal_time_utc"] = iso_utc(interval_ts(args.date, i, args.interval_minutes))
                ticker_result["signal_type"] = "trade_created"
                ticker_result["top_reason"] = None
                ticker_result["top_reason_count"] = 0
                ticker_result["stage_counts"] = stage_counts
                ticker_result["trades_created_in_interval"] = trades_created
                ticker_result["scored_in_interval"] = scored
                break

            if top_reason:
                ticker_result["first_signal_interval"] = i
                ticker_result["first_signal_time_utc"] = iso_utc(interval_ts(args.date, i, args.interval_minutes))
                ticker_result["signal_type"] = "blocked"
                ticker_result["top_reason"] = top_reason
                ticker_result["top_reason_count"] = top_reason_count
                ticker_result["stage_counts"] = stage_counts
                ticker_result["trades_created_in_interval"] = trades_created
                ticker_result["scored_in_interval"] = scored
                break

            if blocked_entry_gates:
                gate_name, gate_count = sorted(blocked_entry_gates.items(), key=lambda kv: kv[1], reverse=True)[0]
                ticker_result["first_signal_interval"] = i
                ticker_result["first_signal_time_utc"] = iso_utc(interval_ts(args.date, i, args.interval_minutes))
                ticker_result["signal_type"] = "blocked_runtime_gate"
                ticker_result["top_reason"] = gate_name
                ticker_result["top_reason_count"] = int(gate_count or 0)
                ticker_result["stage_counts"] = stage_counts
                ticker_result["trades_created_in_interval"] = trades_created
                ticker_result["scored_in_interval"] = scored
                break

        report["results"].append(ticker_result)

    out_path = (
        Path(args.output)
        if args.output
        else Path(
            f"data/interval-parity-diagnostic-{args.date}-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')}.json"
        )
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2))
    print(str(out_path))


if __name__ == "__main__":
    main()
