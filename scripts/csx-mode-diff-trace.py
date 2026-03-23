#!/usr/bin/env python3
"""
Focused CSX mode-diff trace:
- interval-replay (single interval calls)
- candle-replay (single day call with timeline debug)

Outputs an artifact with per-interval trade mutation evidence and first divergence.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import time
import urllib.parse
from datetime import datetime, timedelta, timezone


API_BASE = os.environ.get("TT_API_BASE", "https://timed-trading-ingest.shashant.workers.dev")
API_KEY = os.environ.get("TT_API_KEY", "AwesomeSauce")


def post(path: str, params: dict, timeout: int = 120) -> dict:
    qp = urllib.parse.urlencode(params)
    url = f"{API_BASE}{path}?{qp}"
    out = subprocess.check_output(
        ["curl", "-sS", "-m", str(timeout), "-X", "POST", url],
        text=True,
    )
    data = out
    try:
        return json.loads(data)
    except Exception:
        return {"ok": False, "error": "non_json_response", "raw": data[:400]}


def get(path: str, params: dict, timeout: int = 60) -> dict:
    qp = urllib.parse.urlencode(params)
    url = f"{API_BASE}{path}?{qp}"
    out = subprocess.check_output(
        ["curl", "-sS", "-m", str(timeout), url],
        text=True,
    )
    data = out
    try:
        return json.loads(data)
    except Exception:
        return {"ok": False, "error": "non_json_response", "raw": data[:400]}


def reset_state() -> dict:
    return post("/timed/admin/reset", {"resetLedger": 1, "key": API_KEY}, timeout=180)


def fetch_trade_state(ticker: str) -> dict:
    trades_resp = get("/timed/trades", {"source": "kv", "key": API_KEY}, timeout=60)
    trades = trades_resp.get("trades") if isinstance(trades_resp, dict) else []
    if not isinstance(trades, list):
        trades = []
    ticker_u = ticker.upper()
    filt = [t for t in trades if str(t.get("ticker", "")).upper() == ticker_u]
    open_rows = [
        t
        for t in filt
        if str(t.get("status", "")).upper() in ("OPEN", "TP_HIT_TRIM")
    ]
    latest = sorted(
        filt,
        key=lambda t: float(t.get("entry_ts") or t.get("created_at") or 0),
        reverse=True,
    )[:3]
    return {
        "totalTrades": len(filt),
        "openTrades": len(open_rows),
        "latestTrades": [
            {
                "status": t.get("status"),
                "entry_ts": t.get("entry_ts") or t.get("created_at"),
                "exit_ts": t.get("exit_ts"),
                "exit_reason": t.get("exitReason") or t.get("exit_reason"),
                "trimmed_pct": t.get("trimmedPct", t.get("trimmed_pct")),
            }
            for t in latest
        ],
    }


def iter_days(start_date: str, end_date: str):
    d = datetime.strptime(start_date, "%Y-%m-%d").date()
    e = datetime.strptime(end_date, "%Y-%m-%d").date()
    while d <= e:
        if d.weekday() < 5:
            yield d.strftime("%Y-%m-%d")
        d = d + timedelta(days=1)


def run_interval_mode(start_date: str, end_date: str, ticker: str, interval_minutes: int, overrides: dict) -> list[dict]:
    total_intervals = int(math.floor(390 / interval_minutes) + 1)
    out = []
    is_first = True
    for date_str in iter_days(start_date, end_date):
        for idx in range(total_intervals):
            params = {
                "date": date_str,
                "interval": idx,
                "intervalMinutes": interval_minutes,
                "tickers": ticker,
                "key": API_KEY,
            }
            if is_first:
                params["cleanSlate"] = 1
                is_first = False
            if idx == total_intervals - 1:
                params["endOfDay"] = 1
                params["traderOnly"] = 1
            for k, v in overrides.items():
                params[k] = v
            resp = post("/timed/admin/interval-replay", params, timeout=120)
            state = None
            if int(resp.get("tradesCreated") or 0) > 0 or idx % 20 == 0:
                state = fetch_trade_state(ticker)
            out.append(
                {
                    "date": date_str,
                    "interval": idx,
                    "intervalTs": resp.get("intervalTs"),
                    "scored": resp.get("scored"),
                    "tradesCreated": resp.get("tradesCreated"),
                    "totalTradesResponse": resp.get("totalTrades"),
                    "stageCounts": resp.get("stageCounts") or {},
                    "blockReasons": resp.get("blockReasons") or {},
                    "blockedEntryGates": resp.get("blockedEntryGates") or {},
                    "processDebug": resp.get("processDebug") or [],
                    "totalTrades": state["totalTrades"] if state else None,
                    "openTrades": state["openTrades"] if state else None,
                    "latestTrades": state["latestTrades"] if state else [],
                }
            )
    return out


def run_candle_mode(start_date: str, end_date: str, ticker: str, interval_minutes: int, overrides: dict) -> dict:
    merged_timeline = []
    summaries = []
    is_first = True
    for date_str in iter_days(start_date, end_date):
        params = {
            "date": date_str,
            "fullDay": 1,
            "tickerBatch": 1,
            "tickers": ticker,
            "debugTimeline": 1,
            "traderOnly": 1,
            "intervalMinutes": interval_minutes,
            "key": API_KEY,
        }
        if is_first:
            params["cleanSlate"] = 1
            is_first = False
        for k, v in overrides.items():
            params[k] = v
        resp = post("/timed/admin/candle-replay", params, timeout=240)
        tl = resp.get("timeline") or []
        for row in tl:
            row["date"] = date_str
            merged_timeline.append(row)
        summaries.append(
            {
                "date": date_str,
                "scored": resp.get("scored"),
                "tradesCreated": resp.get("tradesCreated"),
                "totalTrades": resp.get("totalTrades"),
                "errorsCount": resp.get("errorsCount"),
            }
        )
    return {"timeline": merged_timeline, "summaries": summaries}


def build_diff(interval_rows: list[dict], candle_timeline: list[dict]) -> dict:
    diffs = []
    n = min(len(interval_rows), len(candle_timeline))
    for i in range(n):
        iv = interval_rows[i]
        cd = candle_timeline[i]
        mismatch = {}
        iv_total = iv.get("totalTradesResponse")
        if iv_total is None:
            iv_total = iv.get("totalTrades")
        if int(iv_total or 0) != int(cd.get("totalTrades", 0) or 0):
            mismatch["totalTrades"] = {"interval": iv_total, "candle": cd.get("totalTrades")}
        if int(iv.get("tradesCreated", 0) or 0) != int(cd.get("tradesCreated", 0) or 0):
            mismatch["tradesCreated"] = {"interval": iv.get("tradesCreated"), "candle": cd.get("tradesCreated")}
        if mismatch:
            diffs.append({"interval": i, "intervalTs": cd.get("intervalTs"), "mismatch": mismatch, "interval_latest": iv.get("latestTrades"), "candle_latest": cd.get("latestTrades")})
    return {
        "diffCount": len(diffs),
        "firstDivergence": diffs[0] if diffs else None,
        "sampleDiffs": diffs[:15],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Focused CSX candle-vs-interval trace")
    ap.add_argument("--date", default="2025-07-01")
    ap.add_argument("--end-date", default="")
    ap.add_argument("--ticker", default="CSX")
    ap.add_argument("--interval-minutes", type=int, default=5)
    ap.add_argument("--output", default="")
    ap.add_argument("--leading-ltf", default="10")
    ap.add_argument("--entry-engine", default="")
    ap.add_argument("--management-engine", default="")
    args = ap.parse_args()

    overrides = {"LEADING_LTF": args.leading_ltf}
    if args.entry_engine:
        overrides["ENTRY_ENGINE"] = args.entry_engine
    if args.management_engine:
        overrides["MANAGEMENT_ENGINE"] = args.management_engine

    end_date = args.end_date or args.date

    print("Resetting before interval mode...")
    reset_state()
    interval_rows = run_interval_mode(args.date, end_date, args.ticker, args.interval_minutes, overrides)

    print("Resetting before candle mode...")
    reset_state()
    candle_resp = run_candle_mode(args.date, end_date, args.ticker, args.interval_minutes, overrides)
    candle_timeline = candle_resp.get("timeline") or []

    diff = build_diff(interval_rows, candle_timeline)

    artifact = {
        "ok": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "start_date": args.date,
        "end_date": end_date,
        "ticker": args.ticker.upper(),
        "interval_minutes": args.interval_minutes,
        "overrides": overrides,
        "interval_mode": interval_rows,
        "candle_mode": {
            "summaries": candle_resp.get("summaries") or [],
            "timeline": candle_timeline,
        },
        "diff": diff,
    }

    out_path = args.output
    if not out_path:
        ts = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        out_path = f"data/backtest-artifacts/csx-mode-diff-trace-{ts}.json"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(artifact, f, indent=2)

    print(f"artifact={out_path}")
    print(f"diffCount={diff['diffCount']}")
    if diff["firstDivergence"]:
        d = diff["firstDivergence"]
        print(f"firstDivergence interval={d['interval']} mismatch={json.dumps(d['mismatch'])}")
    else:
        print("firstDivergence=none")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

