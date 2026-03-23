#!/usr/bin/env python3
"""
Compare full trade journey parity between a reference set and candidate trades.

Primary use: score candidate runs against the screenshot reference trades
from option-a-rank-overhaul (entry timing, hold duration, exit class, pnl quality).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_SCREENSHOT_TRADE_IDS = [
    "CDNS-1751376600000-00vnweq1y",
    "ORCL-1751377500000-4arrr4uxr",
    "CSX-1751377500000-0bkrj96aq",
    "ITT-1751379300000-x01hj8tuw",
    "KLAC-1751386500000-qindnxflj",
    "COST-1751463900000-4fp8oe86s",
    "AAPL-1751464800000-7nc9m5zsk",
    "ULTA-1751466600000-248i2hvzy",
    "HII-1751913900000-nvybkpi04",
    "WMT-1751906700000-74amv6wj1",
    "AWI-1751987700000-cfjz7tnax",
    "PWR-1752072300000-zydq25mni",
    "PLTR-1752499800000-zjo20p43p",
    "KO-1752504300000-w6mv3sfix",
    "KLAC-1752760800000-jtdxy5bx1",
    "HII-1752845400000-6r555jpyo",
    "AWI-1753450200000-3kxa19s7u",
    "PSTG-1753709400000-njguvgtdv",
]


def parse_ts(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        v = int(value)
        return v if v > 0 else None
    s = str(value).strip()
    if not s:
        return None
    if s.isdigit():
        v = int(s)
        return v if v > 0 else None
    try:
        return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def to_num(value: Any) -> float:
    try:
        return float(value)
    except Exception:
        return 0.0


def classify_exit_reason(reason: Any) -> str:
    s = str(reason or "").upper()
    if not s or s == "NONE":
        return "unknown"
    if "TP_FULL" in s:
        return "tp_full"
    if "FUSE" in s:
        return "fuse"
    if "MAX_LOSS" in s or "SL_BREACHED" in s or "TRIGGER_BREACHED" in s or "LARGE_ADVERSE_MOVE" in s:
        return "loss_protect"
    if "REGIME" in s or "EMA_REGIME_REVERSED" in s:
        return "regime_reversal"
    if "TRIM" in s:
        return "trim_related"
    if "UNKNOWN" in s:
        return "unknown"
    return "other"


@dataclass
class Trade:
    trade_id: str
    ticker: str
    direction: str
    entry_ts: int
    exit_ts: int
    hold_days: float
    pnl: float
    pnl_pct: float
    entry_path: str
    exit_reason: str
    exit_class: str
    raw: Dict[str, Any]


def load_trade_rows(path: Path) -> List[Dict[str, Any]]:
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for k in ("trades", "rows", "results"):
            if isinstance(data.get(k), list):
                return data[k]
    raise ValueError(f"Unsupported trade payload format: {path}")


def normalize_trade(row: Dict[str, Any]) -> Optional[Trade]:
    entry_ts = parse_ts(row.get("entry_ts") or row.get("entry_time") or row.get("opened_at") or row.get("openedAt"))
    exit_ts = parse_ts(row.get("exit_ts") or row.get("exit_time") or row.get("closed_at") or row.get("closedAt"))
    if not entry_ts or not exit_ts or exit_ts <= entry_ts:
        return None
    trade_id = str(row.get("trade_id") or row.get("id") or row.get("tradeId") or "").strip()
    ticker = str(row.get("ticker") or "").upper().strip()
    direction = str(row.get("direction") or row.get("side") or "").upper().strip()
    if not ticker or not direction:
        return None
    hold_days = (exit_ts - entry_ts) / 86400000.0
    pnl = to_num(row.get("pnl") or row.get("realized_pnl") or row.get("pnl_usd"))
    pnl_pct = to_num(row.get("pnl_pct") or row.get("pnlPercent"))
    entry_path = str(row.get("entry_path") or row.get("entryPath") or "")
    exit_reason = str(row.get("exit_reason") or row.get("exitReason") or "")
    return Trade(
        trade_id=trade_id,
        ticker=ticker,
        direction=direction,
        entry_ts=entry_ts,
        exit_ts=exit_ts,
        hold_days=hold_days,
        pnl=pnl,
        pnl_pct=pnl_pct,
        entry_path=entry_path,
        exit_reason=exit_reason,
        exit_class=classify_exit_reason(exit_reason),
        raw=row,
    )


def filter_trades(
    rows: List[Dict[str, Any]],
    run_id: Optional[str],
    trade_ids: Optional[List[str]],
) -> List[Trade]:
    wanted = {x.strip() for x in (trade_ids or []) if x.strip()}
    out: List[Trade] = []
    for row in rows:
        rid = str(row.get("run_id") or row.get("runId") or "")
        tid = str(row.get("trade_id") or row.get("id") or row.get("tradeId") or "")
        if run_id and rid != run_id:
            continue
        if wanted and tid not in wanted:
            continue
        t = normalize_trade(row)
        if t:
            out.append(t)
    out.sort(key=lambda x: x.entry_ts)
    return out


def score_pair(ref: Trade, cand: Trade, entry_tolerance_min: float, hold_tolerance_ratio: float) -> Dict[str, Any]:
    entry_delta_min = (cand.entry_ts - ref.entry_ts) / 60000.0
    hold_delta_days = cand.hold_days - ref.hold_days
    hold_allow_days = max(0.25, abs(ref.hold_days) * hold_tolerance_ratio)

    entry_score = max(0.0, 1.0 - (abs(entry_delta_min) / max(1.0, entry_tolerance_min)))
    hold_score = max(0.0, 1.0 - (abs(hold_delta_days) / hold_allow_days))
    exit_score = 1.0 if cand.exit_class == ref.exit_class else 0.0
    path_score = 1.0 if (cand.entry_path or "").lower() == (ref.entry_path or "").lower() else 0.0

    ref_sign = 1 if ref.pnl_pct > 0 else (-1 if ref.pnl_pct < 0 else 0)
    cand_sign = 1 if cand.pnl_pct > 0 else (-1 if cand.pnl_pct < 0 else 0)
    sign_match = 1.0 if ref_sign == cand_sign else 0.0
    mag_ratio = min(abs(cand.pnl_pct) / max(abs(ref.pnl_pct), 1e-6), 1.0) if sign_match else 0.0
    pnl_score = 0.6 * sign_match + 0.4 * mag_ratio

    total = (0.30 * entry_score) + (0.20 * hold_score) + (0.20 * exit_score) + (0.10 * path_score) + (0.20 * pnl_score)
    return {
        "entry_delta_min": round(entry_delta_min, 2),
        "hold_delta_days": round(hold_delta_days, 3),
        "entry_score": round(entry_score, 4),
        "hold_score": round(hold_score, 4),
        "exit_score": round(exit_score, 4),
        "path_score": round(path_score, 4),
        "pnl_score": round(pnl_score, 4),
        "journey_score": round(total, 4),
    }


def match_by_ticker_direction(ref_trades: List[Trade], cand_trades: List[Trade]) -> List[Tuple[Trade, Optional[Trade]]]:
    remaining = cand_trades[:]
    pairs: List[Tuple[Trade, Optional[Trade]]] = []
    for ref in ref_trades:
        candidates = [
            c for c in remaining
            if c.ticker == ref.ticker and c.direction == ref.direction
        ]
        if not candidates:
            pairs.append((ref, None))
            continue
        best = min(candidates, key=lambda c: abs(c.entry_ts - ref.entry_ts))
        remaining.remove(best)
        pairs.append((ref, best))
    return pairs


def main() -> None:
    p = argparse.ArgumentParser(description="Compare candidate trade journey parity vs reference set.")
    p.add_argument("--reference", required=True, help="Path to reference trades JSON (trade-autopsy-trades.json)")
    p.add_argument("--candidate", required=True, help="Path to candidate trades JSON")
    p.add_argument("--reference-run-id", default=None)
    p.add_argument("--candidate-run-id", default=None)
    p.add_argument("--reference-trade-ids", default=None, help="Comma-separated trade IDs; if omitted, default screenshot set is used")
    p.add_argument("--entry-tolerance-min", type=float, default=30.0)
    p.add_argument("--hold-tolerance-ratio", type=float, default=0.40)
    p.add_argument("--output", default=None, help="Write report JSON to this path")
    args = p.parse_args()

    reference_ids = (
        [x.strip() for x in args.reference_trade_ids.split(",") if x.strip()]
        if args.reference_trade_ids
        else DEFAULT_SCREENSHOT_TRADE_IDS
    )

    reference_rows = load_trade_rows(Path(args.reference))
    candidate_rows = load_trade_rows(Path(args.candidate))
    ref_trades = filter_trades(reference_rows, args.reference_run_id, reference_ids)
    cand_trades = filter_trades(candidate_rows, args.candidate_run_id, None)

    if not ref_trades:
        raise SystemExit("No reference trades after filtering.")
    if not cand_trades:
        raise SystemExit("No candidate trades after filtering.")

    pairs = match_by_ticker_direction(ref_trades, cand_trades)
    details: List[Dict[str, Any]] = []
    scored = 0
    score_sum = 0.0
    missing = 0

    for ref, cand in pairs:
        if cand is None:
            missing += 1
            details.append({
                "reference_trade_id": ref.trade_id,
                "ticker": ref.ticker,
                "direction": ref.direction,
                "matched": False,
                "reason": "no_candidate_trade_same_ticker_direction",
            })
            continue
        metric = score_pair(ref, cand, args.entry_tolerance_min, args.hold_tolerance_ratio)
        scored += 1
        score_sum += metric["journey_score"]
        details.append({
            "reference_trade_id": ref.trade_id,
            "candidate_trade_id": cand.trade_id,
            "ticker": ref.ticker,
            "direction": ref.direction,
            "matched": True,
            "reference": {
                "entry_ts": ref.entry_ts,
                "exit_ts": ref.exit_ts,
                "hold_days": round(ref.hold_days, 3),
                "entry_path": ref.entry_path,
                "exit_reason": ref.exit_reason,
                "exit_class": ref.exit_class,
                "pnl_pct": round(ref.pnl_pct, 4),
            },
            "candidate": {
                "entry_ts": cand.entry_ts,
                "exit_ts": cand.exit_ts,
                "hold_days": round(cand.hold_days, 3),
                "entry_path": cand.entry_path,
                "exit_reason": cand.exit_reason,
                "exit_class": cand.exit_class,
                "pnl_pct": round(cand.pnl_pct, 4),
            },
            "metric": metric,
        })

    overall = (score_sum / scored) if scored else 0.0
    report = {
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "reference_path": args.reference,
        "candidate_path": args.candidate,
        "reference_run_id": args.reference_run_id,
        "candidate_run_id": args.candidate_run_id,
        "reference_trade_count": len(ref_trades),
        "candidate_trade_count": len(cand_trades),
        "matched_count": scored,
        "missing_count": missing,
        "entry_tolerance_min": args.entry_tolerance_min,
        "hold_tolerance_ratio": args.hold_tolerance_ratio,
        "journey_score": round(overall, 4),
        "details": details,
    }

    if args.output:
        out = Path(args.output)
    else:
        out = Path("data") / f"journey-parity-report-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2))
    print(str(out))
    print(f"journey_score={report['journey_score']} matched={scored}/{len(ref_trades)} missing={missing}")


if __name__ == "__main__":
    main()
