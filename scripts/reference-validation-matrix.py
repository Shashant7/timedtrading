#!/usr/bin/env python3
"""
Run a compact control-vs-candidate validation matrix for reference-policy/CIO rollout.

Outputs:
- data/reference-intel/validation-matrix-v1.json
- data/reference-intel/validation-go-no-go-v1.json
- data/reference-intel/cio-validation-v1.json
- data/reference-intel/iteration-notes-v1.md
"""

from __future__ import annotations

import argparse
import json
import subprocess
import urllib.parse
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List


API_BASE = "https://timed-trading-ingest.shashant.workers.dev"
API_KEY = "AwesomeSauce"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def post(path: str, params: Dict[str, Any], timeout: int = 240) -> Dict[str, Any]:
    qp = urllib.parse.urlencode(params)
    url = f"{API_BASE}{path}?{qp}"
    raw = subprocess.check_output(
        ["curl", "-sS", "-m", str(timeout), "-X", "POST", url],
        text=True,
    )
    try:
        return json.loads(raw)
    except Exception:
        return {"ok": False, "error": "non_json_response", "raw": raw[:400]}


def get(path: str, params: Dict[str, Any], timeout: int = 90) -> Dict[str, Any]:
    qp = urllib.parse.urlencode(params)
    url = f"{API_BASE}{path}?{qp}"
    raw = subprocess.check_output(
        ["curl", "-sS", "-m", str(timeout), url],
        text=True,
    )
    try:
        return json.loads(raw)
    except Exception:
        return {"ok": False, "error": "non_json_response", "raw": raw[:400]}


def iter_days(start: str, end: str) -> Iterable[str]:
    d = datetime.strptime(start, "%Y-%m-%d").date()
    e = datetime.strptime(end, "%Y-%m-%d").date()
    while d <= e:
        if d.weekday() < 5:
            yield d.strftime("%Y-%m-%d")
        d = d + timedelta(days=1)


def set_model_config_bool(key: str, value: bool) -> None:
    payload = {
        "updates": [
            {
                "key": key,
                "value": str(value).lower(),
                "description": f"Matrix toggle {key}",
            }
        ]
    }
    raw = subprocess.check_output(
        [
            "curl",
            "-sS",
            "-m",
            "90",
            "-X",
            "POST",
            f"{API_BASE}/timed/admin/model-config?{urllib.parse.urlencode({'key': API_KEY})}",
            "-H",
            "Content-Type: application/json",
            "--data-raw",
            json.dumps(payload, separators=(",", ":")),
        ],
        text=True,
    )
    try:
        resp = json.loads(raw)
    except Exception:
        raise RuntimeError("model-config update returned non-json response")
    if not bool(resp.get("ok")):
        raise RuntimeError(f"model-config update failed for {key}: {resp.get('error')}")


def classify_exit(reason: Any) -> str:
    s = str(reason or "").upper()
    if "TP_FULL" in s:
        return "tp_full"
    if "FUSE" in s:
        return "fuse"
    if any(x in s for x in ("MAX_LOSS", "SL_BREACHED", "TRIGGER_BREACHED", "LARGE_ADVERSE_MOVE")):
        return "loss_protect"
    if "REGIME" in s:
        return "regime_reversal"
    if "TRIM" in s:
        return "trim_related"
    if not s:
        return "unknown"
    return "other"


def trade_fingerprint(trades: List[Dict[str, Any]], tickers: List[str]) -> List[str]:
    """Stable identity of the trade set a leg observed. Two legs that ran
    against a properly reset ledger must not share fingerprints — identical
    sets mean the reset failed and both legs read the same leftover rows."""
    tset = {t.upper() for t in tickers}
    out = []
    for t in trades:
        if str(t.get("ticker", "")).upper() not in tset:
            continue
        tid = str(t.get("trade_id") or t.get("tradeId") or "").strip()
        if tid:
            out.append(tid)
        else:
            out.append(
                f"{str(t.get('ticker', '')).upper()}|{t.get('entry_ts') or t.get('entryTs')}|{t.get('pnl')}"
            )
    return sorted(out)


def evaluate_go_no_go(
    control: Dict[str, Any],
    candidate: Dict[str, Any],
    delta: Dict[str, Any],
    cio_snapshot: Dict[str, Any],
    min_closed_trades: int = 5,
) -> Dict[str, Any]:
    """Pure gate evaluation (F24 fix, plans/current-ledger-audit-pnl-improvement-2026-09-04.md).

    A PASS is INVALID — regardless of the delta gates — when:
      • either leg's ledger reset failed (reset_ok false),
      • both legs observed the identical trade set (reset did not isolate them),
      • the candidate leg produced fewer closed trades than the evidence floor,
      • the CIO eval snapshot has zero decision rows (nothing was actually
        evaluated by the system under test).
    """
    csum = control.get("summary") or {}
    nsum = candidate.get("summary") or {}
    invalid_reasons: List[str] = []

    if not bool(control.get("reset_ok")):
        invalid_reasons.append("control_reset_failed")
    if not bool(candidate.get("reset_ok")):
        invalid_reasons.append("candidate_reset_failed")

    cfp = control.get("trade_fingerprint") or []
    nfp = candidate.get("trade_fingerprint") or []
    if cfp and nfp and cfp == nfp:
        invalid_reasons.append("legs_observed_identical_trade_set")

    closed = int(nsum.get("trade_count_closed") or 0)
    if closed < int(min_closed_trades):
        invalid_reasons.append(
            f"candidate_closed_trades_{closed}_below_min_{int(min_closed_trades)}"
        )

    decision_rows = int((cio_snapshot or {}).get("decision_rows") or 0)
    if decision_rows < 1:
        invalid_reasons.append("cio_eval_zero_decision_rows")

    gates = [
        {
            "gate": "candidate_min_closed_trades",
            "value": closed,
            "threshold": int(min_closed_trades),
            "operator": ">=",
            "pass": closed >= int(min_closed_trades),
        },
        {
            "gate": "candidate_pnl_not_materially_worse",
            "value": float(delta.get("realized_pnl_delta") or 0.0),
            "threshold": -200.0,
            "operator": ">=",
            "pass": float(delta.get("realized_pnl_delta") or 0.0) >= -200.0,
        },
        {
            "gate": "candidate_win_rate_not_materially_worse",
            "value": float(delta.get("win_rate_delta") or 0.0),
            "threshold": -0.25,
            "operator": ">=",
            "pass": float(delta.get("win_rate_delta") or 0.0) >= -0.25,
        },
    ]
    gates_pass = all(g["pass"] for g in gates)
    verdict = "INVALID" if invalid_reasons else ("PASS" if gates_pass else "FAIL")
    return {
        "generated_at_utc": now_iso(),
        "verdict": verdict,
        # overall_pass stays the machine gate older tooling reads; an INVALID
        # run must never read as pass even when the delta gates are green.
        "overall_pass": verdict == "PASS",
        "invalid_reasons": invalid_reasons,
        "gates": gates,
        "delta": delta,
        "evidence": {
            "candidate_closed_trades": closed,
            "min_closed_trades": int(min_closed_trades),
            "cio_decision_rows": decision_rows,
            "control_reset_ok": bool(control.get("reset_ok")),
            "candidate_reset_ok": bool(candidate.get("reset_ok")),
            "fingerprints_identical": bool(cfp and nfp and cfp == nfp),
        },
    }


def summarize_trades(trades: List[Dict[str, Any]], tickers: List[str]) -> Dict[str, Any]:
    tset = {t.upper() for t in tickers}
    rows = [t for t in trades if str(t.get("ticker", "")).upper() in tset]
    closed = [t for t in rows if str(t.get("status", "")).upper() in ("WIN", "LOSS", "FLAT")]
    open_rows = [t for t in rows if str(t.get("status", "")).upper() in ("OPEN", "TP_HIT_TRIM")]
    wins = sum(1 for t in closed if str(t.get("status", "")).upper() == "WIN")
    pnl = 0.0
    for t in closed:
        try:
            pnl += float(t.get("pnl") or 0.0)
        except Exception:
            pass
    exits = Counter(classify_exit(t.get("exitReason") or t.get("exit_reason")) for t in closed)
    by_ticker = Counter(str(t.get("ticker", "")).upper() for t in rows)
    return {
        "trade_count_total": len(rows),
        "trade_count_closed": len(closed),
        "trade_count_open": len(open_rows),
        "wins": wins,
        "losses": sum(1 for t in closed if str(t.get("status", "")).upper() == "LOSS"),
        "flats": sum(1 for t in closed if str(t.get("status", "")).upper() == "FLAT"),
        "win_rate_closed": round((wins / len(closed)), 4) if closed else 0.0,
        "realized_pnl": round(pnl, 4),
        "exit_class_counts": dict(exits),
        "ticker_counts": dict(by_ticker),
    }


def run_leg(
    name: str,
    start_date: str,
    end_date: str,
    tickers: List[str],
    interval_minutes: int,
    env_overrides: Dict[str, Any],
) -> Dict[str, Any]:
    reset = post("/timed/admin/reset", {"resetLedger": 1, "key": API_KEY}, timeout=180)
    day_summaries = []
    clean_slate = True
    for d in iter_days(start_date, end_date):
        resp = post(
            "/timed/admin/candle-replay",
            {
                "date": d,
                "fullDay": 1,
                "tickers": ",".join(tickers),
                "tickerBatch": len(tickers),
                "intervalMinutes": interval_minutes,
                "traderOnly": 1,
                "cleanSlate": 1 if clean_slate else 0,
                "key": API_KEY,
                **env_overrides,
            },
            timeout=300,
        )
        clean_slate = False
        day_summaries.append(
            {
                "date": d,
                "scored": resp.get("scored"),
                "tradesCreated": resp.get("tradesCreated"),
                "totalTrades": resp.get("totalTrades"),
                "errorsCount": resp.get("errorsCount"),
            }
        )
    tr = get("/timed/trades", {"source": "d1", "key": API_KEY}, timeout=120)
    trade_rows = tr.get("trades") if isinstance(tr, dict) else []
    if not isinstance(trade_rows, list):
        tr = get("/timed/trades", {"source": "kv", "key": API_KEY}, timeout=120)
        trade_rows = tr.get("trades") if isinstance(tr, dict) else []
    if not isinstance(trade_rows, list):
        trade_rows = []
    return {
        "name": name,
        "reset_ok": bool(reset.get("ok", False)),
        "days": day_summaries,
        "summary": summarize_trades(trade_rows, tickers),
        "trade_fingerprint": trade_fingerprint(trade_rows, tickers),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Run compact validation matrix for reference CIO rollout")
    ap.add_argument("--start-date", default="2025-07-31")
    ap.add_argument("--end-date", default="2025-08-01")
    ap.add_argument("--tickers", default="CSX,CDNS,ORCL,ITT")
    ap.add_argument("--interval-minutes", type=int, default=5)
    ap.add_argument("--matrix-output", default="data/reference-intel/validation-matrix-v1.json")
    ap.add_argument("--go-no-go-output", default="data/reference-intel/validation-go-no-go-v1.json")
    ap.add_argument("--cio-output", default="data/reference-intel/cio-validation-v1.json")
    ap.add_argument("--notes-output", default="data/reference-intel/iteration-notes-v1.md")
    ap.add_argument("--min-closed-trades", type=int, default=5,
                    help="Evidence floor: candidate leg must close at least this many trades")
    ap.add_argument("--reevaluate", action="store_true",
                    help="Skip the replay; re-run the go/no-go gates against the existing matrix + CIO artifacts")
    args = ap.parse_args()

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]

    if args.reevaluate:
        matrix = json.loads(Path(args.matrix_output).read_text(encoding="utf-8"))
        legs = matrix.get("legs") or []
        control = next((l for l in legs if "control" in str(l.get("name", ""))), legs[0] if legs else {})
        candidate = next((l for l in legs if "candidate" in str(l.get("name", ""))), legs[-1] if legs else {})
        delta = matrix.get("delta") or {}
        cio_existing = {}
        cio_path = Path(args.cio_output)
        if cio_path.exists():
            try:
                cio_existing = (json.loads(cio_path.read_text(encoding="utf-8")) or {}).get(
                    "global_cio_eval_snapshot"
                ) or {}
            except Exception:
                cio_existing = {}
        go_no_go = evaluate_go_no_go(control, candidate, delta, cio_existing, args.min_closed_trades)
        Path(args.go_no_go_output).write_text(json.dumps(go_no_go, indent=2), encoding="utf-8")
        print(f"go_no_go={args.go_no_go_output}")
        print(f"verdict={go_no_go['verdict']}")
        if go_no_go["invalid_reasons"]:
            print("invalid_reasons=" + ",".join(go_no_go["invalid_reasons"]))
        return
    env_overrides = {
        "ENTRY_ENGINE": "legacy",
        "MANAGEMENT_ENGINE": "legacy",
        "LEADING_LTF": "10",
        "deep_audit_confirmed_min_rank": 0,
    }

    # Control leg: reference priors disabled.
    set_model_config_bool("ai_cio_reference_enabled", False)
    control = run_leg(
        "control_ref_priors_off",
        args.start_date,
        args.end_date,
        tickers,
        args.interval_minutes,
        env_overrides,
    )

    # Candidate leg: reference priors enabled.
    set_model_config_bool("ai_cio_reference_enabled", True)
    candidate = run_leg(
        "candidate_ref_priors_on",
        args.start_date,
        args.end_date,
        tickers,
        args.interval_minutes,
        env_overrides,
    )

    csum = control["summary"]
    nsum = candidate["summary"]
    delta = {
        "closed_trade_delta": int(nsum["trade_count_closed"]) - int(csum["trade_count_closed"]),
        "win_rate_delta": round(float(nsum["win_rate_closed"]) - float(csum["win_rate_closed"]), 4),
        "realized_pnl_delta": round(float(nsum["realized_pnl"]) - float(csum["realized_pnl"]), 4),
    }

    matrix = {
        "generated_at_utc": now_iso(),
        "window": {"start_date": args.start_date, "end_date": args.end_date, "tickers": tickers, "interval_minutes": args.interval_minutes},
        "legs": [control, candidate],
        "delta": delta,
    }
    Path(args.matrix_output).write_text(json.dumps(matrix, indent=2), encoding="utf-8")

    # CIO eval snapshot is loaded BEFORE gating — zero decision rows must
    # invalidate the run, not decorate the artifact after a green verdict.
    existing = {}
    p = Path("data/reference-intel/cio-eval-loop-v1.json")
    if p.exists():
        try:
            existing = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            existing = {}

    go_no_go = evaluate_go_no_go(control, candidate, delta, existing, args.min_closed_trades)
    Path(args.go_no_go_output).write_text(json.dumps(go_no_go, indent=2), encoding="utf-8")

    cio_val = {
        "generated_at_utc": now_iso(),
        "window": {"start_date": args.start_date, "end_date": args.end_date, "tickers": tickers},
        "matrix_delta": delta,
        "global_cio_eval_snapshot": existing,
    }
    Path(args.cio_output).write_text(json.dumps(cio_val, indent=2), encoding="utf-8")

    notes = f"""# Iteration Notes v1

Generated: {now_iso()}

## Window
- Dates: {args.start_date} → {args.end_date}
- Tickers: {", ".join(tickers)}
- Interval: {args.interval_minutes}m

## Legs
- control: `ai_cio_reference_enabled=false`
- candidate: `ai_cio_reference_enabled=true`

## Delta
- closed_trade_delta: {delta['closed_trade_delta']}
- win_rate_delta: {delta['win_rate_delta']}
- realized_pnl_delta: {delta['realized_pnl_delta']}

## Outcome
- go_no_go: {go_no_go['verdict']}
- invalid_reasons: {", ".join(go_no_go['invalid_reasons']) or "none"}
"""
    Path(args.notes_output).write_text(notes, encoding="utf-8")

    print(f"matrix={args.matrix_output}")
    print(f"go_no_go={args.go_no_go_output}")
    print(f"cio={args.cio_output}")
    print(f"notes={args.notes_output}")
    print(f"verdict={go_no_go['verdict']}")
    if go_no_go["invalid_reasons"]:
        print("invalid_reasons=" + ",".join(go_no_go["invalid_reasons"]))


if __name__ == "__main__":
    main()

