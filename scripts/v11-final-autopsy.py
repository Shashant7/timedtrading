#!/usr/bin/env python3
"""
V11 Final Autopsy

Runs immediately after V11 completes. Produces a self-contained
report with:

  1. Aggregate performance         (WR / PF / PnL / trade count)
  2. Per-month breakdown           (monthly WR, PnL, trade count)
  3. Direction breakdown           (LONG vs SHORT)
  4. Setup / entry_path breakdown  (tt_pullback, tt_momentum, tt_index_etf_swing, ...)
  5. Exit-reason histogram         (what actually closed trades)
  6. Stale-OPEN analysis           (confirms V12 bug thesis)
  7. MFE coverage audit            (confirms V12 MFE-persist thesis)
  8. Big-loser list                (-3% and worse, drives V12 priority)
  9. Golden winners                (+5% and better, proves edge)
 10. V12 patch simulation          (what would V12's rules have done?)

Emits:
  data/trade-analysis/<RUN_ID>/v11-final-autopsy.md
  data/trade-analysis/<RUN_ID>/v11-final-autopsy.json   (machine-readable)

Usage:
  TIMED_API_KEY=... python3 scripts/v11-final-autopsy.py <RUN_ID>
"""
import json
import os
import statistics
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

API_BASE = os.environ.get("API_BASE", "https://timed-trading-ingest.shashant.workers.dev")
API_KEY = os.environ.get("TIMED_API_KEY")
if not API_KEY:
    print("TIMED_API_KEY env var required", file=sys.stderr)
    sys.exit(2)

if len(sys.argv) < 2:
    print(f"usage: {sys.argv[0]} <run_id>", file=sys.stderr)
    sys.exit(2)

RUN_ID = sys.argv[1]
OUT_DIR = os.path.join("data", "trade-analysis", RUN_ID)
os.makedirs(OUT_DIR, exist_ok=True)


def _ts_to_date(ts):
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(ts / 1000 if ts > 1e11 else ts, tz=timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return None


def _f(x, default=None):
    try:
        v = float(x)
        if v != v:  # NaN
            return default
        return v
    except Exception:
        return default


def fetch_trades(run_id):
    """Fetch all trades for the run (archived + live)."""
    qs = urllib.parse.urlencode({
        "runId": run_id,
        "archived": "1",
        "limit": 5000,
        "key": API_KEY,
    })
    url = f"{API_BASE}/timed/admin/trade-autopsy/trades?{qs}"
    req = urllib.request.Request(url, method="GET", headers={
        "User-Agent": "tt-autopsy/1.0",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
    trades = data.get("trades") or data.get("items") or []
    return trades


def classify_status(t):
    """Normalize status into { WIN, LOSS, FLAT, OPEN, TP_HIT_TRIM }."""
    s = (t.get("status") or "").upper()
    if s in ("WIN", "LOSS", "FLAT", "OPEN", "TP_HIT_TRIM"):
        return s
    if t.get("exit_ts") or t.get("exit_timestamp"):
        pnl = _f(t.get("pnl_pct"), 0) or 0
        return "WIN" if pnl > 0 else "LOSS" if pnl < 0 else "FLAT"
    return "OPEN"


def simulate_v12(trade, sim_now_ms):
    """
    Returns a dict describing whether each V12 rule would have fired on
    this trade at sim_now_ms. Purely informational — doesn't modify data.
    """
    entry_ts = trade.get("entry_ts") or trade.get("entry_timestamp")
    status = classify_status(trade)
    if status not in ("OPEN", "TP_HIT_TRIM"):
        return None
    if not entry_ts:
        return None
    entry_ms = entry_ts if entry_ts > 1e11 else entry_ts * 1000
    age_days = (sim_now_ms - entry_ms) / 86400000.0
    pnl_pct = _f(trade.get("pnl_pct"), 0) or 0
    mfe = _f(trade.get("max_favorable_excursion"))
    mfe_abs = abs(mfe) if mfe is not None else 0

    v12_stale_force_close = False
    if age_days >= 45:
        currently_breaking_out = (
            pnl_pct > 2.0
            or (pnl_pct > 0.5 and mfe_abs >= 3.0 and (mfe_abs - pnl_pct) < 0.5)
        )
        v12_stale_force_close = not currently_breaking_out

    v12_runner_time_cap = (status == "TP_HIT_TRIM" and age_days >= 30)

    return {
        "age_calendar_days": round(age_days, 1),
        "pnl_pct": round(pnl_pct, 2),
        "mfe_pct": mfe,
        "v12_stale_force_close_would_fire": v12_stale_force_close,
        "v12_runner_time_cap_would_fire": v12_runner_time_cap,
    }


def main():
    print(f"[autopsy] Fetching trades for {RUN_ID}...")
    trades = fetch_trades(RUN_ID)
    print(f"[autopsy] Got {len(trades)} trades")

    if not trades:
        print("No trades found — cannot produce autopsy.", file=sys.stderr)
        sys.exit(1)

    now_ms = datetime.now(timezone.utc).timestamp() * 1000

    # ── Bucket everything
    by_status = defaultdict(list)
    by_month = defaultdict(list)
    by_direction = defaultdict(list)
    by_setup = defaultdict(list)
    by_exit_reason = defaultdict(int)
    pnls = []

    for t in trades:
        s = classify_status(t)
        by_status[s].append(t)
        entry_ts = t.get("entry_ts") or t.get("entry_timestamp")
        if entry_ts:
            d = _ts_to_date(entry_ts)
            if d:
                by_month[d[:7]].append(t)
        direction = (t.get("direction") or "").upper() or "?"
        by_direction[direction].append(t)
        setup = t.get("setup_name") or t.get("entry_path") or "(none)"
        by_setup[setup].append(t)
        reason = t.get("exit_reason") or "(open)"
        by_exit_reason[reason] += 1
        pnl = _f(t.get("pnl_pct"))
        if pnl is not None:
            pnls.append(pnl)

    # ── 1. Aggregate
    n_closed = len(by_status["WIN"]) + len(by_status["LOSS"]) + len(by_status["FLAT"])
    n_win = len(by_status["WIN"])
    n_loss = len(by_status["LOSS"])
    win_pnls = [_f(t.get("pnl_pct"), 0) for t in by_status["WIN"]]
    loss_pnls = [_f(t.get("pnl_pct"), 0) for t in by_status["LOSS"]]
    total_pnl_pct = sum([_f(t.get("pnl_pct"), 0) or 0 for t in trades if classify_status(t) in ("WIN", "LOSS", "FLAT")])
    gross_win = sum([p for p in win_pnls if p])
    gross_loss = abs(sum([p for p in loss_pnls if p]))
    profit_factor = round(gross_win / gross_loss, 2) if gross_loss > 0 else None
    win_rate = round(100 * n_win / n_closed, 1) if n_closed else None
    avg_win = round(statistics.mean(win_pnls), 2) if win_pnls else None
    avg_loss = round(statistics.mean(loss_pnls), 2) if loss_pnls else None

    # ── 6. Stale OPEN analysis + V12 simulation
    stale_rows = []
    for t in by_status["OPEN"] + by_status["TP_HIT_TRIM"]:
        sim = simulate_v12(t, now_ms)
        if sim:
            stale_rows.append({
                "ticker": t.get("ticker"),
                "direction": (t.get("direction") or "").upper(),
                "entry_date": _ts_to_date(t.get("entry_ts") or t.get("entry_timestamp")),
                "setup": t.get("setup_name") or t.get("entry_path"),
                "status": classify_status(t),
                **sim,
            })
    stale_rows.sort(key=lambda r: r["age_calendar_days"], reverse=True)

    v12_stale_would_fire = sum(1 for r in stale_rows if r["v12_stale_force_close_would_fire"])
    v12_runner_would_fire = sum(1 for r in stale_rows if r["v12_runner_time_cap_would_fire"])

    # ── 7. MFE coverage
    mfe_coverage = {"WIN": {"has": 0, "no": 0}, "LOSS": {"has": 0, "no": 0},
                    "OPEN": {"has": 0, "no": 0}, "TP_HIT_TRIM": {"has": 0, "no": 0},
                    "FLAT": {"has": 0, "no": 0}}
    for t in trades:
        s = classify_status(t)
        if s not in mfe_coverage:
            continue
        v = t.get("max_favorable_excursion")
        if v is not None and v != "":
            mfe_coverage[s]["has"] += 1
        else:
            mfe_coverage[s]["no"] += 1

    # ── 8/9. Big losers + big winners
    big_losers = sorted([t for t in by_status["LOSS"] if (_f(t.get("pnl_pct")) or 0) <= -3.0],
                        key=lambda t: _f(t.get("pnl_pct")) or 0)[:15]
    big_winners = sorted([t for t in by_status["WIN"] if (_f(t.get("pnl_pct")) or 0) >= 5.0],
                         key=lambda t: _f(t.get("pnl_pct")) or 0, reverse=True)[:15]

    def trade_row(t):
        return {
            "ticker": t.get("ticker"),
            "direction": (t.get("direction") or "").upper(),
            "entry_date": _ts_to_date(t.get("entry_ts") or t.get("entry_timestamp")),
            "exit_date": _ts_to_date(t.get("exit_ts") or t.get("exit_timestamp")),
            "setup": t.get("setup_name") or t.get("entry_path"),
            "pnl_pct": round(_f(t.get("pnl_pct"), 0) or 0, 2),
            "mfe": _f(t.get("max_favorable_excursion")),
            "exit_reason": t.get("exit_reason"),
        }

    # ── Monthly breakdown
    month_summary = {}
    for m, bucket in sorted(by_month.items()):
        mw = [t for t in bucket if classify_status(t) == "WIN"]
        ml = [t for t in bucket if classify_status(t) == "LOSS"]
        mc = len(mw) + len(ml) + len([t for t in bucket if classify_status(t) == "FLAT"])
        mpnl = sum([_f(t.get("pnl_pct"), 0) or 0 for t in bucket if classify_status(t) in ("WIN", "LOSS", "FLAT")])
        month_summary[m] = {
            "trades_entered": len(bucket),
            "closed": mc,
            "wins": len(mw),
            "losses": len(ml),
            "win_rate": round(100 * len(mw) / mc, 1) if mc else None,
            "total_pnl_pct": round(mpnl, 2),
        }

    # ── Setup breakdown
    setup_summary = {}
    for s, bucket in sorted(by_setup.items(), key=lambda kv: len(kv[1]), reverse=True):
        sw = [t for t in bucket if classify_status(t) == "WIN"]
        sl = [t for t in bucket if classify_status(t) == "LOSS"]
        sc = len(sw) + len(sl) + len([t for t in bucket if classify_status(t) == "FLAT"])
        spnl = sum([_f(t.get("pnl_pct"), 0) or 0 for t in bucket if classify_status(t) in ("WIN", "LOSS", "FLAT")])
        setup_summary[s] = {
            "trades": len(bucket),
            "closed": sc,
            "wins": len(sw),
            "losses": len(sl),
            "win_rate": round(100 * len(sw) / sc, 1) if sc else None,
            "total_pnl_pct": round(spnl, 2),
            "avg_pnl_pct": round(spnl / sc, 2) if sc else None,
        }

    # ── Direction breakdown
    dir_summary = {}
    for d, bucket in by_direction.items():
        dw = [t for t in bucket if classify_status(t) == "WIN"]
        dl = [t for t in bucket if classify_status(t) == "LOSS"]
        dc = len(dw) + len(dl) + len([t for t in bucket if classify_status(t) == "FLAT"])
        dpnl = sum([_f(t.get("pnl_pct"), 0) or 0 for t in bucket if classify_status(t) in ("WIN", "LOSS", "FLAT")])
        dir_summary[d] = {
            "trades": len(bucket),
            "closed": dc,
            "wins": len(dw),
            "losses": len(dl),
            "win_rate": round(100 * len(dw) / dc, 1) if dc else None,
            "total_pnl_pct": round(dpnl, 2),
        }

    payload = {
        "run_id": RUN_ID,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "aggregate": {
            "total_trades": len(trades),
            "closed": n_closed,
            "wins": n_win,
            "losses": n_loss,
            "win_rate_pct": win_rate,
            "profit_factor": profit_factor,
            "total_pnl_pct": round(total_pnl_pct, 2),
            "avg_win_pct": avg_win,
            "avg_loss_pct": avg_loss,
            "open_positions": len(by_status["OPEN"]),
            "tp_hit_trim_runners": len(by_status["TP_HIT_TRIM"]),
        },
        "by_status": {k: len(v) for k, v in by_status.items()},
        "by_month": month_summary,
        "by_direction": dir_summary,
        "by_setup": setup_summary,
        "by_exit_reason": dict(by_exit_reason),
        "stale_open_rows": stale_rows,
        "mfe_coverage": mfe_coverage,
        "big_losers": [trade_row(t) for t in big_losers],
        "big_winners": [trade_row(t) for t in big_winners],
        "v12_simulation": {
            "stale_force_close_would_fire_count": v12_stale_would_fire,
            "runner_time_cap_would_fire_count": v12_runner_would_fire,
            "total_open_trades_audited": len(stale_rows),
        },
    }

    json_path = os.path.join(OUT_DIR, "v11-final-autopsy.json")
    with open(json_path, "w") as fp:
        json.dump(payload, fp, indent=2, default=str)
    print(f"[autopsy] Wrote {json_path}")

    # ── Markdown report
    md = []
    md.append(f"# V11 Final Autopsy — `{RUN_ID}`\n")
    md.append(f"Generated at {payload['generated_at']}.\n")

    md.append("## Headline\n")
    agg = payload["aggregate"]
    md.append(f"| Metric | Value |")
    md.append(f"|---|---:|")
    md.append(f"| Total trades | {agg['total_trades']} |")
    md.append(f"| Closed | {agg['closed']} |")
    md.append(f"| Win rate | {agg['win_rate_pct']}% |")
    md.append(f"| Profit factor | {agg['profit_factor']} |")
    md.append(f"| Total PnL % | {agg['total_pnl_pct']:+.2f}% |")
    md.append(f"| Avg win / loss | {agg['avg_win_pct']:+.2f}% / {agg['avg_loss_pct']:+.2f}% |")
    md.append(f"| Open positions | {agg['open_positions']} |")
    md.append(f"| TP_HIT_TRIM runners | {agg['tp_hit_trim_runners']} |")

    md.append("\n## By month\n")
    md.append("| Month | Entered | Closed | W | L | WR | Total PnL |")
    md.append("|---|---:|---:|---:|---:|---:|---:|")
    for m, s in payload["by_month"].items():
        md.append(f"| {m} | {s['trades_entered']} | {s['closed']} | {s['wins']} | {s['losses']} | {s['win_rate']}% | {s['total_pnl_pct']:+.2f}% |")

    md.append("\n## By direction\n")
    md.append("| Direction | Trades | Closed | W | L | WR | Total PnL |")
    md.append("|---|---:|---:|---:|---:|---:|---:|")
    for d, s in payload["by_direction"].items():
        md.append(f"| {d} | {s['trades']} | {s['closed']} | {s['wins']} | {s['losses']} | {s['win_rate']}% | {s['total_pnl_pct']:+.2f}% |")

    md.append("\n## By setup\n")
    md.append("| Setup | Trades | Closed | W | L | WR | Total PnL | Avg PnL |")
    md.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    for s_name, s in payload["by_setup"].items():
        md.append(f"| {s_name} | {s['trades']} | {s['closed']} | {s['wins']} | {s['losses']} | {s['win_rate']}% | {s['total_pnl_pct']:+.2f}% | {s['avg_pnl_pct']:+.2f}% |")

    md.append("\n## Stale OPEN / runner audit\n")
    if stale_rows:
        md.append("| Ticker | Dir | Entered | Status | Age | PnL | MFE | V12 stale? | V12 runner? |")
        md.append("|---|---|---|---|---:|---:|---:|---:|---:|")
        for r in stale_rows:
            mfe_str = f"{r['mfe_pct']:.2f}" if r.get("mfe_pct") is not None else "—"
            md.append(f"| {r['ticker']} | {r['direction']} | {r['entry_date']} | {r['status']} | {r['age_calendar_days']} | {r['pnl_pct']:+.2f}% | {mfe_str} | {'✓' if r['v12_stale_force_close_would_fire'] else '—'} | {'✓' if r['v12_runner_time_cap_would_fire'] else '—'} |")
        v12 = payload["v12_simulation"]
        md.append(f"\n**V12 simulation:** stale-force-close would fire on {v12['stale_force_close_would_fire_count']} / {v12['total_open_trades_audited']} positions; runner-time-cap on {v12['runner_time_cap_would_fire_count']}.")
    else:
        md.append("(no stale OPEN positions)")

    md.append("\n## MFE coverage audit\n")
    md.append("| Status | Has MFE | No MFE |")
    md.append("|---|---:|---:|")
    for s, c in mfe_coverage.items():
        md.append(f"| {s} | {c['has']} | {c['no']} |")

    md.append("\n## Big losers (≤ -3%)\n")
    if big_losers:
        md.append("| Ticker | Dir | In | Out | Setup | PnL | MFE | Exit |")
        md.append("|---|---|---|---|---|---:|---:|---|")
        for r in payload["big_losers"]:
            mfe_str = f"{r['mfe']:.2f}" if r.get("mfe") is not None else "—"
            md.append(f"| {r['ticker']} | {r['direction']} | {r['entry_date']} | {r['exit_date']} | {r['setup']} | {r['pnl_pct']:+.2f}% | {mfe_str} | {r['exit_reason']} |")
    else:
        md.append("(no trades worse than -3%)")

    md.append("\n## Golden winners (≥ +5%)\n")
    if big_winners:
        md.append("| Ticker | Dir | In | Out | Setup | PnL | MFE | Exit |")
        md.append("|---|---|---|---|---|---:|---:|---|")
        for r in payload["big_winners"]:
            mfe_str = f"{r['mfe']:.2f}" if r.get("mfe") is not None else "—"
            md.append(f"| {r['ticker']} | {r['direction']} | {r['entry_date']} | {r['exit_date']} | {r['setup']} | {r['pnl_pct']:+.2f}% | {mfe_str} | {r['exit_reason']} |")
    else:
        md.append("(no trades better than +5%)")

    md.append("\n## By exit reason\n")
    md.append("| Reason | Count |")
    md.append("|---|---:|")
    for reason, cnt in sorted(by_exit_reason.items(), key=lambda kv: kv[1], reverse=True):
        md.append(f"| {reason} | {cnt} |")

    md_path = os.path.join(OUT_DIR, "v11-final-autopsy.md")
    with open(md_path, "w") as fp:
        fp.write("\n".join(md) + "\n")
    print(f"[autopsy] Wrote {md_path}")

    # ── Console summary
    print()
    print(f"=== V11 headline ({RUN_ID}) ===")
    print(f"  Trades:    {agg['total_trades']} ({agg['closed']} closed, {agg['open_positions']} open, {agg['tp_hit_trim_runners']} TP_HIT_TRIM)")
    print(f"  Win rate:  {agg['win_rate_pct']}%")
    print(f"  PF:        {agg['profit_factor']}")
    print(f"  Total PnL: {agg['total_pnl_pct']:+.2f}%")
    print(f"  Avg W/L:   {agg['avg_win_pct']:+.2f}% / {agg['avg_loss_pct']:+.2f}%")
    print()
    print(f"=== V12 simulation ===")
    print(f"  Stale-force-close would fire on {payload['v12_simulation']['stale_force_close_would_fire_count']} / {payload['v12_simulation']['total_open_trades_audited']} open positions")
    print(f"  Runner-time-cap would fire on {payload['v12_simulation']['runner_time_cap_would_fire_count']} / {payload['v12_simulation']['total_open_trades_audited']} open positions")


if __name__ == "__main__":
    main()
