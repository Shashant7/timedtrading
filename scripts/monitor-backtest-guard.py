#!/usr/bin/env python3
import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import requests


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def to_float(v, default=0.0):
    try:
        return float(v)
    except Exception:
        return default


def detect_running_run(session, base_url, key):
    r = session.get(
        f"{base_url}/timed/admin/runs",
        params={"key": key, "limit": 20},
        timeout=30,
    )
    r.raise_for_status()
    runs = (r.json() or {}).get("runs", [])
    for run in runs:
        if str(run.get("status", "")).lower() == "running":
            return run
    return None


def fetch_run_trades(session, base_url, key, run_id):
    r = session.get(
        f"{base_url}/timed/admin/runs/trades",
        params={"key": key, "run_id": run_id},
        timeout=60,
    )
    if r.status_code == 404:
        # Legacy worker fallback: runs/trades route not available.
        # Use global D1 trades, which is safe when monitor is attached to a clean-slate run.
        r2 = session.get(
            f"{base_url}/timed/trades",
            params={"key": key, "source": "d1"},
            timeout=60,
        )
        r2.raise_for_status()
        trades = (r2.json() or {}).get("trades", [])
        filtered = [
            t for t in trades
            if str(t.get("run_id") or t.get("runId") or "") == str(run_id)
        ]
        return filtered if filtered else trades
    r.raise_for_status()
    return (r.json() or {}).get("trades", [])


def summarize(trades):
    closed = []
    openish = []
    for t in trades:
        st = str(t.get("status", "")).upper()
        if st in ("WIN", "LOSS", "FLAT"):
            closed.append(t)
        else:
            openish.append(t)

    wins = sum(1 for t in closed if str(t.get("status", "")).upper() == "WIN")
    losses = sum(1 for t in closed if str(t.get("status", "")).upper() == "LOSS")
    pnl = sum(to_float(t.get("pnl"), 0.0) for t in closed)
    gross_win = sum(max(0.0, to_float(t.get("pnl"), 0.0)) for t in closed)
    gross_loss = -sum(min(0.0, to_float(t.get("pnl"), 0.0)) for t in closed)
    pf = (gross_win / gross_loss) if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0)
    wr = (wins / (wins + losses)) if (wins + losses) > 0 else 0.0
    large_losses = sum(1 for t in closed if to_float(t.get("pnl_pct"), 0.0) <= -6.0)

    return {
        "total": len(trades),
        "closed": len(closed),
        "open": len(openish),
        "wins": wins,
        "losses": losses,
        "wr": wr,
        "pnl": pnl,
        "pf": pf,
        "large_losses": large_losses,
    }


def compute_journey_score(trades, args):
    if args.min_journey_score < 0 or not args.journey_reference:
        return None, None
    if len(trades) < max(4, args.min_closed_for_eval):
        return None, "insufficient_trades_for_journey_eval"

    comparator = Path(__file__).resolve().with_name("journey-parity-comparator.py")
    if not comparator.exists():
        return None, f"comparator_missing:{comparator}"

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as cand_f:
        json.dump({"trades": trades}, cand_f)
        cand_path = cand_f.name
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as out_f:
        report_path = out_f.name

    cmd = [
        sys.executable,
        str(comparator),
        "--reference",
        args.journey_reference,
        "--candidate",
        cand_path,
        "--entry-tolerance-min",
        str(args.journey_entry_tolerance_min),
        "--hold-tolerance-ratio",
        str(args.journey_hold_tolerance_ratio),
        "--output",
        report_path,
    ]
    if args.journey_reference_run_id:
        cmd += ["--reference-run-id", args.journey_reference_run_id]
    if args.journey_reference_trade_ids:
        cmd += ["--reference-trade-ids", args.journey_reference_trade_ids]
    if args.run_id:
        cmd += ["--candidate-run-id", args.run_id]

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=40)
        if proc.returncode != 0:
            msg = (proc.stderr or proc.stdout or "").strip().replace("\n", " ")
            return None, f"journey_comparator_error:{msg[:200]}"
        with open(report_path, "r", encoding="utf-8") as rf:
            report = json.load(rf)
        score = to_float(report.get("journey_score"), -1.0)
        if score < 0:
            return None, "journey_score_missing"
        return score, None
    except Exception as e:
        return None, f"journey_eval_exception:{e}"
    finally:
        for path in (cand_path, report_path):
            try:
                os.remove(path)
            except Exception:
                pass


def should_pause(stats, args):
    if stats["closed"] < args.min_closed_for_eval:
        return False, "insufficient_closed_trades"

    jscore = stats.get("journey_score")
    if args.min_journey_score >= 0 and jscore is not None and jscore < args.min_journey_score:
        return True, f"journey_score_below_threshold:{jscore:.3f}<{args.min_journey_score:.3f}"
    if stats["wr"] < args.min_wr:
        return True, f"win_rate_below_threshold:{stats['wr']:.2f}<{args.min_wr:.2f}"
    if stats["pf"] < args.min_pf:
        return True, f"profit_factor_below_threshold:{stats['pf']:.2f}<{args.min_pf:.2f}"
    if stats["large_losses"] > args.max_large_losses:
        return True, f"too_many_large_losses:{stats['large_losses']}>{args.max_large_losses}"
    if stats["pnl"] < args.min_pnl:
        return True, f"pnl_below_threshold:{stats['pnl']:.2f}<{args.min_pnl:.2f}"
    return False, "healthy"


def finalize_failed(session, base_url, key, run_id, note):
    r = session.post(
        f"{base_url}/timed/admin/runs/finalize",
        params={"key": key},
        json={"run_id": run_id, "status": "failed", "status_note": note[:240]},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def release_lock(session, base_url, key):
    r = session.delete(
        f"{base_url}/timed/admin/replay-lock",
        params={"key": key},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def kill_pid(pid):
    if not pid:
        return
    try:
        os.kill(pid, signal.SIGTERM)
        time.sleep(1.0)
    except ProcessLookupError:
        return
    except Exception:
        pass
    try:
        os.kill(pid, signal.SIGKILL)
    except Exception:
        pass


def main():
    p = argparse.ArgumentParser(description="Backtest mission-control guard monitor")
    p.add_argument("--base-url", default="https://timed-trading-ingest.shashant.workers.dev")
    p.add_argument("--key", default=os.environ.get("TT_API_KEY", ""))
    p.add_argument("--run-id", default="")
    p.add_argument("--poll-seconds", type=int, default=60)
    p.add_argument("--process-pid", type=int, default=0, help="Optional local backtest process PID to stop on guard breach")
    p.add_argument("--max-polls", type=int, default=0, help="0 means infinite")
    p.add_argument("--min-closed-for-eval", type=int, default=8)
    p.add_argument("--min-wr", type=float, default=0.45)
    p.add_argument("--min-pf", type=float, default=1.0)
    p.add_argument("--max-large-losses", type=int, default=2)
    p.add_argument("--min-pnl", type=float, default=-1500.0)
    p.add_argument("--breach-confirmations", type=int, default=2)
    p.add_argument("--min-journey-score", type=float, default=-1.0, help="Enable journey parity guard when >= 0")
    p.add_argument("--journey-reference", default="", help="Reference trade JSON path for journey comparator")
    p.add_argument("--journey-reference-run-id", default="", help="Optional run_id filter for reference trades")
    p.add_argument("--journey-reference-trade-ids", default="", help="Optional comma-separated reference trade IDs")
    p.add_argument("--journey-entry-tolerance-min", type=float, default=30.0)
    p.add_argument("--journey-hold-tolerance-ratio", type=float, default=0.40)
    args = p.parse_args()

    if not args.key:
        print("ERROR: missing API key; set --key or TT_API_KEY", file=sys.stderr)
        sys.exit(2)

    s = requests.Session()
    run_id = args.run_id
    if not run_id:
        run = detect_running_run(s, args.base_url, args.key)
        if not run:
            print(f"[{now_iso()}] No running run found.")
            sys.exit(1)
        run_id = run.get("run_id")

    print(f"[{now_iso()}] Monitoring run: {run_id}")
    bad_streak = 0
    polls = 0

    while True:
        polls += 1
        trades = fetch_run_trades(s, args.base_url, args.key, run_id)
        st = summarize(trades)
        journey_score, journey_note = compute_journey_score(trades, args)
        if journey_score is not None:
            st["journey_score"] = journey_score
        stop, reason = should_pause(st, args)
        journey_text = (
            f" journey={journey_score:.3f}"
            if journey_score is not None
            else (f" journey=n/a({journey_note})" if args.min_journey_score >= 0 else "")
        )
        print(
            f"[{now_iso()}] poll={polls} total={st['total']} closed={st['closed']} "
            f"wr={st['wr']*100:.1f}% pf={st['pf']:.2f} pnl={st['pnl']:.2f} "
            f"large_losses={st['large_losses']}{journey_text} decision={'PAUSE' if stop else 'OK'} reason={reason}"
        )

        if stop:
            bad_streak += 1
        else:
            bad_streak = 0

        if bad_streak >= args.breach_confirmations:
            note = f"auto-paused by monitor: {reason}; closed={st['closed']} wr={st['wr']*100:.1f}% pf={st['pf']:.2f} pnl={st['pnl']:.2f}"
            print(f"[{now_iso()}] Triggering pause: {note}")
            try:
                finalize_failed(s, args.base_url, args.key, run_id, note)
            except Exception as e:
                print(f"[{now_iso()}] finalize error: {e}")
            try:
                release_lock(s, args.base_url, args.key)
            except Exception as e:
                print(f"[{now_iso()}] unlock error: {e}")
            kill_pid(args.process_pid)
            print(f"[{now_iso()}] Monitor exited after pause.")
            return

        if args.max_polls > 0 and polls >= args.max_polls:
            print(f"[{now_iso()}] Reached max polls ({args.max_polls}). Exiting.")
            return

        time.sleep(max(5, args.poll_seconds))


if __name__ == "__main__":
    main()
