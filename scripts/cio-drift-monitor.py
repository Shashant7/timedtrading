#!/usr/bin/env python3
"""
Compute CIO decision-quality drift between recent and prior windows.

Output:
- data/reference-intel/cio-drift-monitor-v1.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

API_BASE = "https://timed-trading-ingest.shashant.workers.dev"
API_KEY = "AwesomeSauce"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def as_float(v: Any) -> float | None:
    try:
        if v is None:
            return None
        return float(v)
    except Exception:
        return None


def d1_query(sql: str) -> List[Dict[str, Any]]:
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
                sql,
                "--json",
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        payload = json.loads(raw)
        if isinstance(payload, list) and payload:
            res = payload[0].get("results")
            if isinstance(res, list):
                return [x for x in res if isinstance(x, dict)]
    except Exception:
        return []
    return []


def api_decisions(limit: int) -> List[Dict[str, Any]]:
    try:
        params = urllib.parse.urlencode({"limit": max(1, min(500, limit)), "key": API_KEY})
        url = f"{API_BASE}/timed/admin/ai-cio/decisions?{params}"
        raw = subprocess.check_output(["curl", "-sS", "-m", "90", url], text=True)
        payload = json.loads(raw)
        rows = payload.get("decisions") if isinstance(payload, dict) else None
        if isinstance(rows, list):
            return [x for x in rows if isinstance(x, dict)]
    except Exception:
        return []
    return []


def summarize(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    outcomes = [r for r in rows if str(r.get("trade_outcome") or "").upper() in ("WIN", "LOSS", "FLAT")]
    aa = [r for r in outcomes if str(r.get("decision") or "").upper() in ("APPROVE", "ADJUST")]
    rj = [r for r in outcomes if str(r.get("decision") or "").upper() == "REJECT"]

    def wr(xs: List[Dict[str, Any]]) -> float:
        if not xs:
            return 0.0
        wins = sum(1 for x in xs if str(x.get("trade_outcome") or "").upper() == "WIN")
        return wins / len(xs)

    confs = [as_float(r.get("confidence")) for r in outcomes]
    confs = [c for c in confs if c is not None]
    edge = [as_float(r.get("edge_score")) for r in outcomes]
    edge = [e for e in edge if e is not None]
    return {
        "decision_rows": len(rows),
        "rows_with_outcome": len(outcomes),
        "approve_adjust_rows": len(aa),
        "reject_rows": len(rj),
        "approve_adjust_win_rate": round(wr(aa), 4),
        "reject_counterfactual_win_rate": round(wr(rj), 4),
        "avg_confidence": round(sum(confs) / len(confs), 4) if confs else 0.0,
        "avg_edge_score": round(sum(edge) / len(edge), 4) if edge else 0.0,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="CIO drift monitor")
    ap.add_argument("--recent-size", type=int, default=400)
    ap.add_argument("--prior-size", type=int, default=400)
    ap.add_argument("--output", default="data/reference-intel/cio-drift-monitor-v1.json")
    ap.add_argument("--wr-drop-threshold", type=float, default=0.08)
    args = ap.parse_args()

    total = max(1, args.recent_size + args.prior_size)
    rows = d1_query(
        f"SELECT decision, confidence, edge_score, trade_outcome, trade_pnl_pct, created_at "
        f"FROM ai_cio_decisions ORDER BY created_at DESC LIMIT {total}"
    )
    source = "d1"
    if not rows:
        rows = api_decisions(total)
        source = "api" if rows else "none"
    recent = rows[: args.recent_size]
    prior = rows[args.recent_size : args.recent_size + args.prior_size]

    recent_s = summarize(recent)
    prior_s = summarize(prior)

    wr_drop = prior_s["approve_adjust_win_rate"] - recent_s["approve_adjust_win_rate"]
    reject_inversion = recent_s["reject_counterfactual_win_rate"] > recent_s["approve_adjust_win_rate"]
    drift_alert = (wr_drop > args.wr_drop_threshold) or reject_inversion

    out = {
        "generated_at_utc": now_iso(),
        "source": source,
        "window_sizes": {"recent": args.recent_size, "prior": args.prior_size},
        "recent": recent_s,
        "prior": prior_s,
        "delta": {
            "approve_adjust_win_rate": round(recent_s["approve_adjust_win_rate"] - prior_s["approve_adjust_win_rate"], 4),
            "reject_counterfactual_win_rate": round(recent_s["reject_counterfactual_win_rate"] - prior_s["reject_counterfactual_win_rate"], 4),
            "avg_confidence": round(recent_s["avg_confidence"] - prior_s["avg_confidence"], 4),
            "avg_edge_score": round(recent_s["avg_edge_score"] - prior_s["avg_edge_score"], 4),
        },
        "alerts": {
            "wr_drop_exceeds_threshold": wr_drop > args.wr_drop_threshold,
            "reject_inversion": reject_inversion,
            "drift_alert": drift_alert,
        },
        "thresholds": {"wr_drop_threshold": args.wr_drop_threshold},
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")

    print(f"recent_rows={recent_s['decision_rows']}")
    print(f"prior_rows={prior_s['decision_rows']}")
    print(f"drift_alert={drift_alert}")
    print(f"output={out_path}")


if __name__ == "__main__":
    main()

