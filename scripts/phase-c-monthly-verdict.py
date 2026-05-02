#!/usr/bin/env python3
"""
Phase C — Monthly Verdict Generator
====================================
Standardized monthly trade-review report for Phase C walk-forward calibration.

Same format every month. Produces a Markdown verdict that you read alongside
the previous month's verdict to spot trajectory drift (toward July or away
from it).

USAGE
-----
    # Verdict from a backtest run:
    TIMED_API_KEY=... python3 scripts/phase-c-monthly-verdict.py \\
        --run-id <run_id> \\
        --month 2025-07

    # Verdict from a date window across the live trades table (no run id):
    TIMED_API_KEY=... python3 scripts/phase-c-monthly-verdict.py \\
        --month 2025-07 \\
        --source live

    # Verdict for the active promoted dataset:
    TIMED_API_KEY=... python3 scripts/phase-c-monthly-verdict.py \\
        --month 2025-07 \\
        --source promoted

Output:
    tasks/phase-c/monthly-verdicts/{month}-{run_id_or_source}.md

SECTIONS
--------
1. Headline numbers      — WR, R, max DD, Sharpe (vs July benchmark)
2. The proud trades      — top 5 by P&L%, with full attribute breakdown
3. The disappointed      — bottom 5, same breakdown
4. Profit giveback       — MFE >= 1% closed flat-or-worse (the "should've trimmed" list)
5. Re-entry chains       — tickers traded >= 3x; cumulative chain P&L
6. Setup performance     — WR x avg-R x volume per entry_path
7. Personality x setup   — heatmap of which combinations work
8. Loop firing log       — when did Loops 1/2/3 act (Phase C only — empty for pre-loop runs)
9. Calibration notes     — proposed flag deltas for the next month (manual section)

DESIGN
------
- Stable Markdown output so month-over-month diffs are meaningful
- Every number has a one-line plain-language interpretation
- Tables sorted deterministically so re-running produces identical bytes
- "Calibration notes" section is left empty for the human to fill in
"""
import argparse
import json
import os
import statistics
import sys
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

WORKER_BASE = os.environ.get(
    "TIMED_WORKER_BASE",
    "https://timed-trading-ingest.shashant.workers.dev",
)
UA = "Mozilla/5.0 (compatible; PhaseC-Verdict/1.0)"

# July 2025 benchmark (the "good page" we're calibrating toward).
# Numbers from the original July run as documented in tasks/lessons.md
# and the Phase A autopsy. If these need updating after Stage 0, they're
# all in one place here.
JULY_BENCHMARK = {
    "wr": 0.55,
    "avg_r": 1.6,
    "max_dd_pct": 3.0,
    "sharpe": 1.5,
}


def _api_key() -> str:
    key = os.environ.get("TIMED_API_KEY")
    if not key:
        sys.stderr.write(
            "ERROR: TIMED_API_KEY env var required.\n"
            "Set it before running: export TIMED_API_KEY=...\n"
        )
        sys.exit(2)
    return key


def fetch_trades_for_run(run_id: str) -> list[dict]:
    """All trades from a backtest_run_trades archive, full row."""
    qs = urllib.parse.urlencode({"run_id": run_id, "key": _api_key()})
    url = f"{WORKER_BASE}/timed/admin/backtests/run-trades?{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read().decode("utf-8")
    data = json.loads(body)
    if not data.get("ok"):
        raise RuntimeError(f"run-trades failed: {data.get('error')}")
    return data.get("trades") or []


def fetch_trades_promoted() -> list[dict]:
    """Trades from the active promoted dataset."""
    url = f"{WORKER_BASE}/timed/trades?source=promoted"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read().decode("utf-8")
    data = json.loads(body)
    if not data.get("ok"):
        raise RuntimeError(f"promoted trades failed: {data.get('error')}")
    return data.get("trades") or []


def fetch_trades_live() -> list[dict]:
    """Trades from the live D1 trades table (admin-gated)."""
    qs = urllib.parse.urlencode({"key": _api_key(), "source": "d1"})
    url = f"{WORKER_BASE}/timed/trades?{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read().decode("utf-8")
    data = json.loads(body)
    if not data.get("ok"):
        raise RuntimeError(f"live trades failed: {data.get('error')}")
    return data.get("trades") or []


# ── Filtering ───────────────────────────────────────────────────────────


def in_month(trade: dict, year: int, month: int) -> bool:
    """Returns True if trade's entry_ts is within the calendar month."""
    ts = trade.get("entry_ts") or trade.get("entryTs")
    if not ts:
        return False
    try:
        dt = datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc)
    except Exception:
        return False
    return dt.year == year and dt.month == month


def is_closed(trade: dict) -> bool:
    status = str(trade.get("status") or "").upper()
    return status in ("WIN", "LOSS", "FLAT")


# ── Trade attribute extraction (for the verdict tables) ────────────────


def attr_dict(trade: dict) -> dict:
    """
    Pulls the descriptive attributes that matter for forensic review.
    Reads from the flattened entry_signals_json + setup_snapshot in
    rank_trace_json that Stage 0 of round-3-46 wired in.
    """
    out = {
        "ticker": trade.get("ticker") or "?",
        "direction": str(trade.get("direction") or "?").upper(),
        "setup": trade.get("setup_name") or trade.get("entry_path") or "?",
        "grade": trade.get("setup_grade") or "?",
        "personality": "?",
        "regime": "?",
        "pdz_d": "?",
        "td9_bear_ltf_active": False,
        "rsi_div_adverse": False,
        "phase_div_adverse": False,
    }
    # entry_signals_json is the post-round-3 hot-path field
    es_raw = trade.get("entry_signals_json")
    if es_raw:
        try:
            es = json.loads(es_raw) if isinstance(es_raw, str) else es_raw
            if isinstance(es, dict):
                out["personality"] = es.get("personality") or out["personality"]
                out["regime"] = es.get("regime_class") or out["regime"]
                out["pdz_d"] = es.get("pdz_d") or out["pdz_d"]
                out["td9_bear_ltf_active"] = bool(es.get("td9_bear_ltf_active"))
                out["rsi_div_adverse"] = bool(es.get("has_adverse_rsi_div"))
                out["phase_div_adverse"] = bool(es.get("has_adverse_phase_div"))
        except Exception:
            pass
    # Fallback to rank_trace_json -> setup_snapshot
    if out["regime"] == "?" or out["personality"] == "?":
        rt_raw = trade.get("rank_trace_json")
        if rt_raw:
            try:
                rt = json.loads(rt_raw) if isinstance(rt_raw, str) else rt_raw
                snap = (rt or {}).get("setup_snapshot") or {}
                if out["regime"] == "?" and snap.get("regime_class"):
                    out["regime"] = snap["regime_class"]
                if out["personality"] == "?" and snap.get("ticker_personality"):
                    out["personality"] = snap["ticker_personality"]
                if out["pdz_d"] == "?":
                    pdz = snap.get("pdz") or {}
                    out["pdz_d"] = pdz.get("D") or out["pdz_d"]
            except Exception:
                pass
    out["sector"] = trade.get("sector") or "?"
    return out


def fmt_attr(a: dict) -> str:
    parts = [a["setup"], a["personality"], a["regime"], f"PDZ={a['pdz_d']}"]
    flags = []
    if a["td9_bear_ltf_active"]:
        flags.append("TD9B")
    if a["rsi_div_adverse"]:
        flags.append("RSIv-")
    if a["phase_div_adverse"]:
        flags.append("PHv-")
    if flags:
        parts.append("[" + "|".join(flags) + "]")
    return " · ".join(parts)


# ── Sections ────────────────────────────────────────────────────────────


def section_headline(trades: list[dict]) -> list[str]:
    closed = [t for t in trades if is_closed(t)]
    if not closed:
        return ["**No closed trades in this month.**", ""]
    wins = [t for t in closed if str(t.get("status")).upper() == "WIN"]
    losses = [t for t in closed if str(t.get("status")).upper() == "LOSS"]
    flat = [t for t in closed if str(t.get("status")).upper() == "FLAT"]
    wr = len(wins) / len(closed) if closed else 0
    pnls = [float(t.get("pnl_pct") or t.get("pnlPct") or 0) for t in closed]
    avg_w = statistics.mean([p for p in pnls if p > 0]) if any(p > 0 for p in pnls) else 0
    avg_l = statistics.mean([abs(p) for p in pnls if p < 0]) if any(p < 0 for p in pnls) else 0
    avg_r = (avg_w / avg_l) if avg_l > 0 else 0
    cum_pct = sum(pnls)
    # Approximate max DD on cumulative %
    cum = 0.0
    peak = 0.0
    max_dd = 0.0
    for p in pnls:
        cum += p
        peak = max(peak, cum)
        max_dd = max(max_dd, peak - cum)
    sharpe = (statistics.mean(pnls) / statistics.pstdev(pnls)) * (252**0.5) if len(pnls) >= 2 and statistics.pstdev(pnls) > 0 else 0

    def stamp(value: float, target: float, *, higher_is_better: bool = True) -> str:
        ok = (value >= target) if higher_is_better else (value <= target)
        return "PASS" if ok else "MISS"

    lines = [
        "## 1 · Headline",
        "",
        f"- **{len(closed)} closed trades.** {len(wins)}W / {len(losses)}L / {len(flat)} flat.",
        f"- **Win rate: {wr*100:.1f}%.** Target {JULY_BENCHMARK['wr']*100:.0f}% — {stamp(wr, JULY_BENCHMARK['wr'])}.",
        f"- **Avg winner / Avg loser: {avg_r:.2f}x** ({avg_w:.2f}% / {avg_l:.2f}%). Target {JULY_BENCHMARK['avg_r']:.2f}x — {stamp(avg_r, JULY_BENCHMARK['avg_r'])}.",
        f"- **Max drawdown (cum %): {max_dd:.2f}%.** Target ≤ {JULY_BENCHMARK['max_dd_pct']:.1f}% — {stamp(max_dd, JULY_BENCHMARK['max_dd_pct'], higher_is_better=False)}.",
        f"- **Sharpe (annualized, daily-pct proxy): {sharpe:.2f}.** Target {JULY_BENCHMARK['sharpe']:.2f} — {stamp(sharpe, JULY_BENCHMARK['sharpe'])}.",
        f"- **Cumulative P&L (sum of pct): {cum_pct:+.2f}%.**",
        "",
    ]
    return lines


def _trade_one_liner(t: dict) -> str:
    a = attr_dict(t)
    pnl = float(t.get("pnl_pct") or t.get("pnlPct") or 0)
    mfe = float(t.get("mfe_pct") or 0)
    mae = float(t.get("mae_pct") or 0)
    exit_reason = t.get("exit_reason") or t.get("exitReason") or "?"
    sym = a["ticker"].ljust(6)
    dir_ = a["direction"][:1]
    return (
        f"- **{sym}** {dir_} | {pnl:+6.2f}% | MFE {mfe:+5.2f}% / MAE {mae:+5.2f}% | "
        f"exit: `{exit_reason}` | {fmt_attr(a)}"
    )


def section_proud(trades: list[dict], n: int = 5) -> list[str]:
    closed = [t for t in trades if is_closed(t)]
    closed.sort(key=lambda t: float(t.get("pnl_pct") or 0), reverse=True)
    top = closed[:n]
    lines = [
        "## 2 · The Proud (top winners)",
        "",
        "What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month",
        "has fewer trades that look like this, the engine has drifted.",
        "",
    ]
    if not top:
        lines.append("_No winners this month._")
    else:
        for t in top:
            lines.append(_trade_one_liner(t))
    lines.append("")
    return lines


def section_disappointed(trades: list[dict], n: int = 5) -> list[str]:
    closed = [t for t in trades if is_closed(t)]
    closed.sort(key=lambda t: float(t.get("pnl_pct") or 0))
    bot = closed[:n]
    lines = [
        "## 3 · The Disappointed (worst losers)",
        "",
        "Each one of these is a calibration question: was the entry the issue, the management, or the regime?",
        "If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next",
        "calibration should raise the bar for that combo.",
        "",
    ]
    if not bot:
        lines.append("_No losers this month._")
    else:
        for t in bot:
            lines.append(_trade_one_liner(t))
    lines.append("")
    return lines


def section_profit_giveback(trades: list[dict]) -> list[str]:
    closed = [t for t in trades if is_closed(t)]
    leak = []
    for t in closed:
        mfe = float(t.get("mfe_pct") or 0)
        pnl = float(t.get("pnl_pct") or 0)
        if mfe >= 1.0 and pnl <= 0.0:
            leak.append(t)
    leak.sort(key=lambda t: float(t.get("mfe_pct") or 0), reverse=True)
    lines = [
        "## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)",
        "",
        f"**{len(leak)} trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.",
        "If this list is long, the calibration question is: should peak-lock fire earlier?",
        "",
    ]
    if not leak:
        lines.append("_None._ Engine is locking gains well this month.")
    else:
        for t in leak[:10]:
            mfe = float(t.get("mfe_pct") or 0)
            pnl = float(t.get("pnl_pct") or 0)
            lost = mfe - pnl
            a = attr_dict(t)
            lines.append(
                f"- **{a['ticker']}** {a['direction'][:1]} | gave back **{lost:.2f}%** "
                f"(MFE +{mfe:.2f}% → {pnl:+.2f}%) | {fmt_attr(a)}"
            )
    lines.append("")
    return lines


def section_re_entry_chains(trades: list[dict]) -> list[str]:
    by_ticker: dict[str, list[dict]] = defaultdict(list)
    for t in trades:
        by_ticker[t.get("ticker") or "?"].append(t)
    chains = [(sym, ts) for sym, ts in by_ticker.items() if len(ts) >= 3]
    chains.sort(key=lambda kv: -len(kv[1]))
    lines = [
        "## 5 · Re-entry chains (tickers traded ≥ 3x)",
        "",
        "Negative chains are the engine repeatedly being wrong about the same name.",
        "If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.",
        "",
    ]
    if not chains:
        lines.append("_No chains of 3+ trades on a single ticker this month._")
    else:
        for sym, ts in chains[:10]:
            net = sum(float(t.get("pnl_pct") or 0) for t in ts if is_closed(t))
            wins = sum(1 for t in ts if str(t.get("status")).upper() == "WIN")
            losses = sum(1 for t in ts if str(t.get("status")).upper() == "LOSS")
            tag = "🟢" if net > 0 else "🔴"
            lines.append(f"- **{sym}** — {len(ts)} trades, {wins}W/{losses}L, **net {net:+.2f}%** {tag}")
    lines.append("")
    return lines


def section_setup_grid(trades: list[dict]) -> list[str]:
    by_setup: dict[str, list[float]] = defaultdict(list)
    for t in trades:
        if not is_closed(t):
            continue
        setup = t.get("setup_name") or t.get("entry_path") or "?"
        by_setup[setup].append(float(t.get("pnl_pct") or 0))
    rows = []
    for setup, pnls in by_setup.items():
        wins = sum(1 for p in pnls if p > 0)
        wr = wins / len(pnls) if pnls else 0
        avg_r = statistics.mean(pnls) if pnls else 0
        rows.append((setup, len(pnls), wr, avg_r, sum(pnls)))
    rows.sort(key=lambda r: -r[4])  # by net pnl
    lines = [
        "## 6 · Setup performance",
        "",
        "Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.",
        "",
        "| Setup | N | WR | Avg | Net |",
        "|---|---:|---:|---:|---:|",
    ]
    if not rows:
        lines.append("| _no data_ | — | — | — | — |")
    else:
        for setup, n, wr, avg_r, net in rows[:15]:
            lines.append(f"| `{setup}` | {n} | {wr*100:.0f}% | {avg_r:+.2f}% | {net:+.2f}% |")
    lines.append("")
    return lines


def section_personality_x_setup(trades: list[dict]) -> list[str]:
    by_combo: dict[tuple[str, str], list[float]] = defaultdict(list)
    for t in trades:
        if not is_closed(t):
            continue
        a = attr_dict(t)
        by_combo[(a["personality"], a["setup"])].append(float(t.get("pnl_pct") or 0))
    rows = []
    for (pers, setup), pnls in by_combo.items():
        if len(pnls) < 2:
            continue  # ignore singletons — too noisy
        wins = sum(1 for p in pnls if p > 0)
        wr = wins / len(pnls)
        net = sum(pnls)
        rows.append((pers, setup, len(pnls), wr, net))
    rows.sort(key=lambda r: r[3])  # WR ascending — worst first
    lines = [
        "## 7 · Personality × Setup (combos with 2+ trades)",
        "",
        "Worst-WR combos at top — these are the immediate Loop 1 candidates.",
        "",
        "| Personality | Setup | N | WR | Net |",
        "|---|---|---:|---:|---:|",
    ]
    if not rows:
        lines.append("| _insufficient data_ | — | — | — | — |")
    else:
        for pers, setup, n, wr, net in rows[:15]:
            lines.append(f"| {pers} | `{setup}` | {n} | {wr*100:.0f}% | {net:+.2f}% |")
    lines.append("")
    return lines


def section_loop_log(trades: list[dict]) -> list[str]:
    """
    Loop firing log. Will be empty for pre-Phase-C runs (the loops emit a
    'phase_c_loop_event' record into entry_signals.loop_events when active).
    """
    events = []
    for t in trades:
        es_raw = t.get("entry_signals_json")
        if not es_raw:
            continue
        try:
            es = json.loads(es_raw) if isinstance(es_raw, str) else es_raw
            for ev in (es or {}).get("loop_events") or []:
                events.append({"trade": t.get("ticker"), **ev})
        except Exception:
            continue
    lines = [
        "## 8 · Loop firing log",
        "",
        "Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.",
        "",
    ]
    if not events:
        lines.append("_No loop events recorded this month (loops not yet active or didn't fire)._")
    else:
        loop_counts = Counter((e.get("loop"), e.get("action")) for e in events)
        for (loop, action), cnt in loop_counts.most_common():
            lines.append(f"- **Loop {loop}** — `{action}`: {cnt} times")
    lines.append("")
    return lines


def section_calibration_notes(month_label: str) -> list[str]:
    return [
        "## 9 · Calibration notes (fill in by hand after reviewing above)",
        "",
        "_Proposed flag deltas for the next month, with one-line justification each._",
        "",
        "- [ ] (no change) — engine looks calibrated for this regime",
        "- [ ] _Or list specific flag deltas. e.g.:_",
        "      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.",
        "",
        "After deciding, edit `scripts/v15-activate.sh`, commit with message",
        f"`phase-c: {month_label} calibration` and resume the next month.",
        "",
    ]


# ── Main ────────────────────────────────────────────────────────────────


def parse_month(s: str) -> tuple[int, int]:
    """Accepts 'YYYY-MM'."""
    try:
        y, m = s.split("-")
        return int(y), int(m)
    except Exception:
        sys.stderr.write(f"ERROR: --month must be YYYY-MM, got {s!r}\n")
        sys.exit(2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", required=True, help="YYYY-MM")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--run-id", help="Backtest run id (queries backtest_run_trades)")
    src.add_argument("--source", choices=("live", "promoted"), help="Pull from live trades or active promoted dataset")
    ap.add_argument("--output-dir", default="tasks/phase-c/monthly-verdicts")
    args = ap.parse_args()

    year, month = parse_month(args.month)

    if args.run_id:
        trades = fetch_trades_for_run(args.run_id)
        source_label = args.run_id
    elif args.source == "promoted":
        trades = fetch_trades_promoted()
        source_label = "promoted"
    else:
        trades = fetch_trades_live()
        source_label = "live"

    in_window = [t for t in trades if in_month(t, year, month)]

    out: list[str] = []
    out.append(f"# Phase C — Monthly Verdict · {args.month}")
    out.append("")
    out.append(f"_Source: `{source_label}` · Trades in window: **{len(in_window)}** · Generated {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}_")
    out.append("")
    out.append("> Read this alongside the previous month's verdict. The point is **trajectory** —")
    out.append("> are we drifting toward July or away from it?")
    out.append("")
    out += section_headline(in_window)
    out += section_proud(in_window)
    out += section_disappointed(in_window)
    out += section_profit_giveback(in_window)
    out += section_re_entry_chains(in_window)
    out += section_setup_grid(in_window)
    out += section_personality_x_setup(in_window)
    out += section_loop_log(in_window)
    out += section_calibration_notes(args.month)

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    safe_source = source_label.replace("/", "_")
    out_path = out_dir / f"{args.month}-{safe_source}.md"
    out_path.write_text("\n".join(out))
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
