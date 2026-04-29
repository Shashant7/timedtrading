#!/usr/bin/env python3
"""
Full Trade Autopsy — repeatable post-backtest analysis tool.

Pulls every trade from a run, classifies each across multiple dimensions,
and produces a comprehensive findings report identifying every area to fix.

Usage:
    TIMED_API_KEY=... python3 scripts/full-trade-autopsy.py <run_id>
    TIMED_API_KEY=... python3 scripts/full-trade-autopsy.py <run_id> --output-json
    TIMED_API_KEY=... python3 scripts/full-trade-autopsy.py <run_id> --top-n 25

Output:
    Human-readable text report on stdout (default)
    JSON dump of all findings if --output-json (to data/trade-analysis/<run_id>/autopsy.json)

Sections produced:
    1. RUN OVERVIEW — total trades, status mix, equity curve, drawdown
    2. SETUP FITNESS — per-entry-path performance + regime fit
    3. EXIT RULE PERFORMANCE — every exit reason with WR/PnL/giveback
    4. WINNER FORENSICS — top winners, MFE giveback analysis, "ones that got away"
    5. LOSER FORENSICS — top losers categorized: rapid stop-out, slow bleed, late exit
    6. REGIME ANALYSIS — performance by VIX state, sector rotation, market regime
    7. CROSS-ASSET CONTEXT — winner vs loser correlations to gold/dollar/oil/btc
    8. R:R ANALYSIS — distribution and outcome by R:R bucket
    9. MTF CONCORDANCE — per-TF stDir alignment vs trade outcomes
   10. EVENT PROXIMITY — entries near earnings/macro
   11. DATA INTEGRITY — orphans, exit_reason='unknown', dual-position bugs
   12. PRIORITIZED FIX LIST — ranked by recoverable PnL impact

This script is intended to be:
    - Run as part of every backtest's post-flight (cron-friendly)
    - Re-runnable for any run_id (live or historical)
    - Used during calibration to compare baseline vs candidate
"""
import argparse
import json
import os
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
UA = "Mozilla/5.0 (compatible; TimedTrading-Autopsy/1.0)"


# ─────────────────────────────────────────────────────────────────────────
# Data loading
# ─────────────────────────────────────────────────────────────────────────

def fetch_trades(api_key: str, run_id: str) -> list:
    url = f"{WORKER_BASE}/timed/admin/runs/trades?run_id={run_id}&limit=5000&key={api_key}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read())
    return data.get("trades") or []


def load_snapshot(t: dict) -> dict | None:
    rt = t.get("rank_trace_json")
    if not rt:
        return None
    try:
        parsed = json.loads(rt) if isinstance(rt, str) else rt
        return parsed.get("setup_snapshot") or {}
    except Exception:
        return None


def to_date(ts) -> str:
    if not ts:
        return "?"
    try:
        return datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return "?"


def to_dt(ts) -> str:
    if not ts:
        return "?"
    try:
        return datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return "?"


# ─────────────────────────────────────────────────────────────────────────
# Stats helpers
# ─────────────────────────────────────────────────────────────────────────

def compute_total_pnl(t: dict) -> float:
    """Compute total trade PnL including realized trim profit."""
    direction = (t.get("direction") or "LONG").upper()
    is_long = direction != "SHORT"
    entry = float(t.get("entry_price") or 0)
    if entry <= 0:
        return float(t.get("pnl_pct") or 0)
    trim_pct = float(t.get("trimmed_pct") or 0)
    trim_p = float(t.get("trim_price") or 0)
    runner_pnl = float(t.get("pnl_pct") or 0)

    if trim_pct > 0 and trim_p > 0:
        realized = ((trim_p - entry) / entry * 100) if is_long else ((entry - trim_p) / entry * 100)
        return realized * trim_pct + runner_pnl * (1 - trim_pct)
    return runner_pnl


def stats_for(trades: list) -> dict:
    """Compute WR/PnL/PF/avg-win/avg-loss for a trade list."""
    closed = [t for t in trades if t.get("status") in ("WIN", "LOSS")]
    if not closed:
        return {"n": 0, "wr": 0, "pnl": 0, "pf": 0, "avg_w": 0, "avg_l": 0, "n_total": len(trades)}
    wins = [t for t in closed if (t.get("pnl_pct") or 0) > 0]
    losses = [t for t in closed if (t.get("pnl_pct") or 0) <= 0]
    sw = sum(t.get("pnl_pct") or 0 for t in wins)
    sl = sum(t.get("pnl_pct") or 0 for t in losses)
    pf = sw / abs(sl) if sl else 999
    return {
        "n": len(closed),
        "n_total": len(trades),
        "wr": round(len(wins) / len(closed) * 100, 1),
        "pnl": round(sw + sl, 2),
        "pf": round(pf, 2),
        "avg_w": round(sw / len(wins), 2) if wins else 0,
        "avg_l": round(sl / len(losses), 2) if losses else 0,
        "best_w": round(max((t.get("pnl_pct") or 0) for t in wins), 2) if wins else 0,
        "worst_l": round(min((t.get("pnl_pct") or 0) for t in losses), 2) if losses else 0,
    }


# ─────────────────────────────────────────────────────────────────────────
# Section builders
# ─────────────────────────────────────────────────────────────────────────

def section_overview(trades: list) -> dict:
    status = Counter(t.get("status") or "?" for t in trades)
    closed = [t for t in trades if t.get("status") in ("WIN", "LOSS")]
    s = stats_for(trades)

    # Equity curve at $100k notional
    acct = 100_000.0
    peak = 100_000.0
    trough = 100_000.0
    max_dd_pct = 0
    weekly = defaultdict(lambda: {"pnl": 0, "n": 0})
    sorted_closed = sorted(
        [t for t in closed if t.get("exit_ts") or t.get("trim_ts")],
        key=lambda t: t.get("exit_ts") or t.get("trim_ts"),
    )
    for t in sorted_closed:
        ts = t.get("exit_ts") or t.get("trim_ts")
        d = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isocalendar()
        wk = f"{d.year}-W{d.week:02d}"
        pnl_dol = float(t.get("pnl") or 0)
        weekly[wk]["pnl"] += pnl_dol
        weekly[wk]["n"] += 1
        acct += pnl_dol
        if acct > peak:
            peak = acct
        else:
            dd = (acct - peak) / peak * 100
            if dd < max_dd_pct:
                max_dd_pct = dd
                trough = acct

    return {
        "total_trades": len(trades),
        "status_mix": dict(status),
        "stats": s,
        "weekly": [{"week": k, **v} for k, v in sorted(weekly.items())],
        "equity_start": 100_000,
        "equity_end": round(acct, 2),
        "equity_peak": round(peak, 2),
        "equity_trough_after_peak": round(trough, 2),
        "max_drawdown_pct": round(max_dd_pct, 2),
        "account_return_pct": round((acct - 100_000) / 100_000 * 100, 2),
    }


def section_setup_fitness(trades: list) -> list:
    by_path = defaultdict(list)
    for t in trades:
        by_path[t.get("entry_path") or "?"].append(t)

    rows = []
    for path, ts in by_path.items():
        s = stats_for(ts)
        if not s["n"]:
            continue
        avg_mfe = sum(float(t.get("max_favorable_excursion") or 0) for t in ts) / len(ts)
        # Regime mix
        regimes = Counter()
        bull_stacks = 0
        for t in ts:
            snap = load_snapshot(t) or {}
            r = snap.get("regime_class") or "?"
            regimes[r] += 1
            if snap.get("bull_stack"):
                bull_stacks += 1
        rows.append({
            "path": path,
            **s,
            "avg_mfe": round(avg_mfe, 2),
            "bull_stack_pct": round(bull_stacks / len(ts) * 100, 0) if ts else 0,
            "regime_mix": dict(regimes.most_common(3)),
        })
    rows.sort(key=lambda r: -r["pnl"])
    return rows


def section_exit_rule_performance(trades: list) -> list:
    by_reason = defaultdict(list)
    for t in trades:
        if t.get("status") not in ("WIN", "LOSS"):
            continue
        by_reason[t.get("exit_reason") or "?"].append(t)

    rows = []
    for r, ts in by_reason.items():
        s = stats_for(ts)
        # Avg MFE giveback
        gb_total = 0
        gb_count = 0
        for t in ts:
            mfe = float(t.get("max_favorable_excursion") or 0)
            pnl = float(t.get("pnl_pct") or 0)
            if mfe > 0:
                gb_total += mfe - pnl
                gb_count += 1
        rows.append({
            "exit_reason": r,
            **s,
            "avg_giveback": round(gb_total / gb_count, 2) if gb_count else 0,
        })
    rows.sort(key=lambda r: -r["n"])
    return rows


def section_winner_forensics(trades: list, top_n: int = 25) -> dict:
    wins = [t for t in trades if t.get("status") == "WIN"]
    wins_sorted = sorted(wins, key=lambda t: -(t.get("pnl_pct") or 0))

    # Top winners
    top_winners = []
    for t in wins_sorted[:top_n]:
        top_winners.append({
            "ticker": t.get("ticker"),
            "entry_path": t.get("entry_path"),
            "entry_date": to_date(t.get("entry_ts")),
            "exit_date": to_date(t.get("exit_ts")),
            "pnl_pct": round(t.get("pnl_pct") or 0, 2),
            "mfe": round(float(t.get("max_favorable_excursion") or 0), 2),
            "exit_reason": t.get("exit_reason"),
        })

    # MFE giveback analysis
    giveback_trades = []
    for t in wins:
        mfe = float(t.get("max_favorable_excursion") or 0)
        pnl = float(t.get("pnl_pct") or 0)
        if mfe > 5.0 and (mfe - pnl) > 5.0:
            giveback_trades.append({
                "ticker": t.get("ticker"),
                "entry_path": t.get("entry_path"),
                "entry_date": to_date(t.get("entry_ts")),
                "exit_date": to_date(t.get("exit_ts")),
                "mfe": round(mfe, 2),
                "kept": round(pnl, 2),
                "giveback_pp": round(mfe - pnl, 2),
                "exit_reason": t.get("exit_reason"),
            })
    giveback_trades.sort(key=lambda x: -x["giveback_pp"])

    return {
        "top_winners": top_winners,
        "ones_that_got_away": giveback_trades[:top_n],
        "total_potential_pnl_left_on_table": round(
            sum(g["giveback_pp"] for g in giveback_trades), 2
        ),
    }


def section_loser_forensics(trades: list, top_n: int = 25) -> dict:
    losses = [t for t in trades if t.get("status") == "LOSS"]
    losses_sorted = sorted(losses, key=lambda t: t.get("pnl_pct") or 0)

    top_losers = []
    for t in losses_sorted[:top_n]:
        mfe = float(t.get("max_favorable_excursion") or 0)
        top_losers.append({
            "ticker": t.get("ticker"),
            "entry_path": t.get("entry_path"),
            "entry_date": to_date(t.get("entry_ts")),
            "exit_date": to_date(t.get("exit_ts")),
            "pnl_pct": round(t.get("pnl_pct") or 0, 2),
            "mfe": round(mfe, 2),
            "exit_reason": t.get("exit_reason"),
            "had_profit_window": mfe >= 1.0,  # was profitable at some point
        })

    # Categorize losers
    rapid_stops = [t for t in losses if (t.get("max_favorable_excursion") or 0) < 0.5]
    slow_bleeds = [t for t in losses if 0.5 <= (t.get("max_favorable_excursion") or 0) < 3.0]
    late_exits = [t for t in losses if (t.get("max_favorable_excursion") or 0) >= 3.0]

    return {
        "top_losers": top_losers,
        "categories": {
            "rapid_stop_outs_mfe_under_05pct": {
                "n": len(rapid_stops),
                "total_pnl": round(sum(t.get("pnl_pct") or 0 for t in rapid_stops), 2),
                "comment": "Entries that never went green — entry quality issue",
            },
            "slow_bleeds_mfe_05_to_3pct": {
                "n": len(slow_bleeds),
                "total_pnl": round(sum(t.get("pnl_pct") or 0 for t in slow_bleeds), 2),
                "comment": "Got small green then faded — exit timing or trail too tight",
            },
            "late_exits_mfe_over_3pct": {
                "n": len(late_exits),
                "total_pnl": round(sum(t.get("pnl_pct") or 0 for t in late_exits), 2),
                "comment": "Had real edge but gave it all back — winner-protect needed",
            },
        },
    }


def section_regime_analysis(trades: list) -> dict:
    """Performance by regime + VIX state + sector rotation.

    VIX state and sector rotation prefer joined trade.context (100%
    coverage from autopsy-join-context.py) over setup_snapshot.
    """
    closed = [t for t in trades if t.get("status") in ("WIN", "LOSS")]
    by_regime = defaultdict(list)
    by_vix = defaultdict(list)
    by_rot = defaultdict(list)
    by_state = defaultdict(list)

    for t in closed:
        snap = load_snapshot(t) or {}
        r = snap.get("regime_class") or "?"
        by_regime[r].append(t)
        st = snap.get("state") or "?"
        by_state[st].append(t)

        # VIX state: prefer joined context, fall back to snapshot
        ctx = t.get("context") or {}
        vix = ctx.get("vix_state")
        if vix is None:
            mi = snap.get("market_internals") or {}
            vix = mi.get("vix_state")
        # When using VIXY proxy, derive bucket from pct_change instead
        if vix is None and ctx.get("vix_proxy_source") == "VIXY":
            pct = ctx.get("vix_pct_change")
            if pct is not None:
                if pct < -3: vix = "vol_drop"
                elif pct < 1: vix = "vol_calm"
                elif pct < 3: vix = "vol_up"
                else: vix = "vol_spike"
        vix = vix or "?"
        by_vix[vix].append(t)

        # Sector rotation: prefer joined
        ca_ctx = ctx.get("cross_asset") or {}
        rot = ca_ctx.get("sector_rotation")
        if rot is None or rot == "unknown":
            mi = snap.get("market_internals") or {}
            rot = mi.get("sector_rotation")
        rot = rot or "?"
        by_rot[rot].append(t)

    return {
        "by_regime_class": {r: stats_for(ts) for r, ts in by_regime.items()},
        "by_state": {st: stats_for(ts) for st, ts in by_state.items()},
        "by_vix_state": {v: stats_for(ts) for v, ts in by_vix.items()},
        "by_sector_rotation": {r: stats_for(ts) for r, ts in by_rot.items()},
    }


def section_cross_asset(trades: list) -> dict:
    """Winner vs loser averages on cross-asset fields.

    Prefers trade.context.cross_asset (joined post-flight from D1 +
    backfill — 100% coverage). Falls back to setup_snapshot.cross_asset
    if context not joined.
    """
    closed = [t for t in trades if t.get("status") in ("WIN", "LOSS")]

    fields = ("gold_pct", "silver_pct", "oil_pct", "dollar_pct", "energy_pct", "btc_pct")
    out = {}
    for field in fields:
        wins = []
        losses = []
        for t in closed:
            # Prefer joined context, fall back to snapshot
            ctx_ca = (t.get("context") or {}).get("cross_asset") or {}
            snap = load_snapshot(t) or {}
            snap_ca = snap.get("cross_asset") or {}
            v = ctx_ca.get(field)
            if v is None:
                v = snap_ca.get(field)
            if v is None:
                continue
            if (t.get("pnl_pct") or 0) > 0:
                wins.append(v)
            else:
                losses.append(v)
        out[field] = {
            "wins_avg": round(sum(wins) / len(wins), 3) if wins else None,
            "losses_avg": round(sum(losses) / len(losses), 3) if losses else None,
            "n_wins": len(wins),
            "n_losses": len(losses),
        }
    return out


def section_rr_analysis(trades: list) -> list:
    """R:R bucketing."""
    buckets = defaultdict(list)
    for t in trades:
        snap = load_snapshot(t) or {}
        rr = snap.get("rr") or t.get("rr")
        if rr is None:
            bucket = "unknown"
        elif rr < 1.5:
            bucket = "<1.5"
        elif rr < 2.0:
            bucket = "1.5-2.0"
        elif rr < 3.0:
            bucket = "2.0-3.0"
        elif rr < 5.0:
            bucket = "3.0-5.0"
        else:
            bucket = ">=5.0"
        buckets[bucket].append(t)

    order = ["<1.5", "1.5-2.0", "2.0-3.0", "3.0-5.0", ">=5.0", "unknown"]
    rows = []
    for b in order:
        if b not in buckets:
            continue
        s = stats_for(buckets[b])
        if s["n"]:
            rows.append({"bucket": b, **s})
    return rows


def section_mtf_concordance(trades: list) -> list:
    """Per-trade MTF stDir alignment with trade direction."""
    buckets = defaultdict(list)
    for t in trades:
        snap = load_snapshot(t) or {}
        sd = snap.get("st_dir") or {}
        direction = (t.get("direction") or "LONG").upper()
        wanted = 1 if direction != "SHORT" else -1
        sigs = [sd.get(k) for k in ("m30", "h1", "h4", "D")]
        sigs = [s for s in sigs if s is not None]
        if not sigs:
            buckets["unknown"].append(t)
            continue
        aligned = sum(1 for s in sigs if s == wanted)
        ratio = aligned / len(sigs)
        if ratio == 1.0:
            buckets["all_aligned"].append(t)
        elif ratio >= 0.75:
            buckets["mostly_aligned"].append(t)
        elif ratio >= 0.5:
            buckets["half_aligned"].append(t)
        else:
            buckets["misaligned"].append(t)

    order = ["all_aligned", "mostly_aligned", "half_aligned", "misaligned", "unknown"]
    rows = []
    for b in order:
        if b not in buckets:
            continue
        s = stats_for(buckets[b])
        if s["n"]:
            rows.append({"bucket": b, **s})
    return rows


def section_event_proximity(trades: list) -> list:
    """Performance by upcoming event proximity at entry."""
    buckets = defaultdict(list)
    for t in trades:
        snap = load_snapshot(t) or {}
        ev = snap.get("upcoming_risk_event")
        if not ev:
            buckets["no_event"].append(t)
            continue
        h = ev.get("hours_to_event")
        etype = ev.get("event_type", "?")
        if h is None:
            bucket = f"{etype}_unknown_h"
        elif h < 24:
            bucket = f"{etype}_<24h"
        elif h < 72:
            bucket = f"{etype}_24-72h"
        elif h < 168:
            bucket = f"{etype}_3-7d"
        else:
            bucket = f"{etype}_>7d"
        buckets[bucket].append(t)

    rows = []
    for b, ts in buckets.items():
        s = stats_for(ts)
        if s["n"]:
            rows.append({"bucket": b, **s})
    rows.sort(key=lambda r: -r["pnl"])
    return rows


def section_data_integrity(trades: list) -> dict:
    """Find data anomalies."""
    # exit_reason="unknown" with status WIN/LOSS
    unknown_finalized = [
        t for t in trades
        if t.get("exit_reason") == "unknown"
        and t.get("status") in ("WIN", "LOSS")
    ]
    # Trades closed at wall-clock time today (force-closed by replay-end-close or live cron)
    today_ts = datetime.now(tz=timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000
    closed_today = [
        t for t in trades
        if t.get("exit_ts") and t["exit_ts"] >= today_ts
        and t.get("status") in ("WIN", "LOSS")
    ]
    # Same-ticker dual OPEN positions
    open_per_ticker = Counter(
        t["ticker"] for t in trades
        if t.get("status") in ("OPEN", "TP_HIT_TRIM")
    )
    duplicates = {k: v for k, v in open_per_ticker.items() if v > 1}
    # Long-held closed (>= 60 days)
    long_held = [
        t for t in trades
        if t.get("entry_ts") and t.get("exit_ts")
        and (t["exit_ts"] - t["entry_ts"]) > 60 * 86400 * 1000
        and t.get("status") in ("WIN", "LOSS")
    ]

    return {
        "exit_reason_unknown_finalized": [
            {
                "ticker": t.get("ticker"),
                "trade_id": t.get("trade_id"),
                "status": t.get("status"),
                "entry_date": to_date(t.get("entry_ts")),
                "exit_date_wallclock": to_dt(t.get("exit_ts")),
                "pnl_pct": t.get("pnl_pct"),
            }
            for t in unknown_finalized
        ],
        "closed_today_walllclock": len(closed_today),
        "duplicate_open_per_ticker": duplicates,
        "long_held_over_60d": [
            {
                "ticker": t.get("ticker"),
                "days_held": round((t["exit_ts"] - t["entry_ts"]) / 86400 / 1000, 1),
                "exit_reason": t.get("exit_reason"),
                "pnl_pct": t.get("pnl_pct"),
            }
            for t in long_held
        ],
    }


def section_priority_fixes(
    setup_fitness: list,
    exit_rules: list,
    winner_forensics: dict,
    loser_forensics: dict,
) -> list:
    """Rank-order broken areas by recoverable PnL impact."""
    fixes = []

    # 1. Net-negative entry paths
    for s in setup_fitness:
        if s["pnl"] < 0 and s["n"] >= 5:
            fixes.append({
                "priority": "HIGH" if abs(s["pnl"]) > 5 else "MEDIUM",
                "category": "ENTRY_FILTER",
                "target": s["path"],
                "impact_pnl_pct": s["pnl"],
                "n_trades_affected": s["n"],
                "wr": s["wr"],
                "recommendation": (
                    f"Path {s['path']} is net negative ({s['pnl']:+.2f}% over {s['n']} trades, "
                    f"WR {s['wr']:.0f}%). Tighten significance filter, require regime alignment, "
                    f"or temporarily disable until refined."
                ),
            })

    # 2. Bad exit rules with significant PnL impact
    for r in exit_rules:
        if r["pnl"] < -3 and r["n"] >= 5:
            fixes.append({
                "priority": "HIGH" if abs(r["pnl"]) > 5 else "MEDIUM",
                "category": "EXIT_RULE",
                "target": r["exit_reason"],
                "impact_pnl_pct": r["pnl"],
                "n_trades_affected": r["n"],
                "wr": r["wr"],
                "avg_giveback": r["avg_giveback"],
                "recommendation": (
                    f"Exit rule '{r['exit_reason']}' fired {r['n']}× with WR {r['wr']:.0f}% "
                    f"and net {r['pnl']:+.2f}% PnL (avg giveback {r['avg_giveback']:.1f}%). "
                    f"Consider deferring on daily-cloud-hold, requiring confirmation, or tightening."
                ),
            })

    # 3. Winner protection — recoverable PnL from MFE giveback
    if winner_forensics.get("ones_that_got_away"):
        gb_total = winner_forensics.get("total_potential_pnl_left_on_table", 0)
        if gb_total > 30:
            fixes.append({
                "priority": "HIGH",
                "category": "WINNER_PROTECT",
                "target": "MFE giveback >5pp on winners",
                "impact_pnl_pct": round(gb_total * 0.5, 2),  # assume can recover ~50%
                "n_trades_affected": len(winner_forensics["ones_that_got_away"]),
                "recommendation": (
                    f"Top winners gave back {gb_total:.1f}pp combined from MFE peaks. "
                    f"Add a winner-protect anchor: when MFE >= 15%, lock SL at "
                    f"entry + 0.6 × MFE to capture more of the runner."
                ),
            })

    # 4. Late exits (losers with high MFE)
    late = loser_forensics["categories"]["late_exits_mfe_over_3pct"]
    if late["n"] >= 5:
        fixes.append({
            "priority": "HIGH" if abs(late["total_pnl"]) > 10 else "MEDIUM",
            "category": "LATE_EXITS",
            "target": "Losses with MFE >= 3% (real edge given back to negative)",
            "impact_pnl_pct": late["total_pnl"],
            "n_trades_affected": late["n"],
            "recommendation": (
                f"{late['n']} losers had MFE >= 3% then went negative. These are "
                f"breakeven-stop candidates: when MFE peaks > 3% then retraces 80%, "
                f"exit at breakeven instead of letting it go red."
            ),
        })

    # 5. Rapid stop-outs (entries that never went green)
    rapid = loser_forensics["categories"]["rapid_stop_outs_mfe_under_05pct"]
    if rapid["n"] >= 10:
        fixes.append({
            "priority": "HIGH" if abs(rapid["total_pnl"]) > 15 else "MEDIUM",
            "category": "ENTRY_QUALITY",
            "target": "Rapid stop-outs (MFE < 0.5%)",
            "impact_pnl_pct": rapid["total_pnl"],
            "n_trades_affected": rapid["n"],
            "recommendation": (
                f"{rapid['n']} entries never went above +0.5% — these are entry-quality "
                f"failures. Audit which entry paths/regimes/RVol levels these came from "
                f"and tighten the conviction floor or require more confirmation."
            ),
        })

    fixes.sort(key=lambda f: -abs(f.get("impact_pnl_pct", 0)))
    return fixes


# ─────────────────────────────────────────────────────────────────────────
# Render
# ─────────────────────────────────────────────────────────────────────────

def render_text(report: dict) -> str:
    out = []
    sec = lambda title: out.append(f"\n{'=' * 75}\n{title}\n{'=' * 75}")

    sec(f"FULL TRADE AUTOPSY: {report['run_id']}")
    out.append(f"Generated: {report['generated_at']}")

    # 1. Overview
    sec("1. RUN OVERVIEW")
    o = report["overview"]
    out.append(f"Total trades: {o['total_trades']}")
    out.append(f"Status mix:   {o['status_mix']}")
    s = o["stats"]
    out.append(f"Closed: {s['n']}  WR: {s['wr']:.1f}%  PnL: {s['pnl']:+.2f}%  PF: {s['pf']}")
    out.append(f"Avg WIN: {s['avg_w']:+.2f}%  Avg LOSS: {s['avg_l']:+.2f}%")
    out.append(f"Best WIN: +{s['best_w']:.2f}%  Worst LOSS: {s['worst_l']:.2f}%")
    out.append(f"Account: ${o['equity_start']:,.0f} -> ${o['equity_end']:,.0f} "
               f"({o['account_return_pct']:+.2f}%) | Peak ${o['equity_peak']:,.0f} | "
               f"Max DD {o['max_drawdown_pct']:.2f}%")

    out.append("\nWeekly equity progression:")
    out.append(f"{'Week':<10} {'N':>4} {'PnL$':>10} {'Cum%':>9}")
    cum = 0
    for w in o["weekly"]:
        cum += w["pnl"]
        out.append(f"{w['week']:<10} {w['n']:>4} ${w['pnl']:>+9,.0f} "
                   f"{cum/o['equity_start']*100:>+7.2f}%")

    # 2. Setup fitness
    sec("2. SETUP FITNESS — per-entry-path")
    out.append(f"{'Path':<28} {'N':>4} {'WR%':>5} {'PnL%':>8} {'PF':>5} {'AvgMFE%':>8} {'Bull%':>6}")
    out.append("-" * 75)
    for r in report["setup_fitness"]:
        out.append(
            f"{r['path'][:27]:<28} {r['n']:>4} {r['wr']:>4.0f} {r['pnl']:>+8.2f} "
            f"{r['pf']:>5.1f} {r['avg_mfe']:>+7.1f} {r['bull_stack_pct']:>5.0f}%"
        )

    # 3. Exit rules
    sec("3. EXIT RULE PERFORMANCE")
    out.append(f"{'Exit Reason':<38} {'N':>4} {'WR%':>5} {'PnL%':>8} {'AvgGB':>7}")
    out.append("-" * 70)
    for r in report["exit_rule_performance"]:
        if r["n"] < 3:
            continue
        out.append(
            f"{r['exit_reason'][:37]:<38} {r['n']:>4} {r['wr']:>4.0f} "
            f"{r['pnl']:>+8.2f} {r['avg_giveback']:>+6.2f}"
        )

    # 4. Winners
    sec("4. WINNER FORENSICS — top winners + ones that got away")
    out.append("\nTop 10 winners:")
    out.append(f"{'Ticker':<7} {'Setup':<26} {'Entry':<11} {'Exit':<11} "
               f"{'PnL%':>7} {'MFE%':>6} {'Reason'}")
    for w in report["winner_forensics"]["top_winners"][:10]:
        out.append(
            f"{w['ticker']:<7} {(w['entry_path'] or '?')[:25]:<26} "
            f"{w['entry_date']:<11} {w['exit_date']:<11} "
            f"{w['pnl_pct']:>+6.2f}% {w['mfe']:>5.1f}% {w['exit_reason'] or '?'}"
        )

    out.append(f"\nTop 12 'ones that got away' (MFE >5pp giveback):")
    out.append(f"{'Ticker':<7} {'Setup':<26} {'Dates':<23} "
               f"{'MFE%':>6} {'Kept%':>7} {'Gave back':>10}")
    for g in report["winner_forensics"]["ones_that_got_away"][:12]:
        dates = f"{g['entry_date']}->{g['exit_date']}"
        out.append(
            f"{g['ticker']:<7} {(g['entry_path'] or '?')[:25]:<26} {dates[:22]:<23} "
            f"{g['mfe']:>5.1f}% {g['kept']:>+6.2f}% {g['giveback_pp']:>9.2f}pp"
        )
    out.append(
        f"\nTotal PnL left on the table from giveback: "
        f"{report['winner_forensics']['total_potential_pnl_left_on_table']:+.2f} pp"
    )

    # 5. Losers
    sec("5. LOSER FORENSICS")
    out.append("\nLoser categories:")
    for cat, d in report["loser_forensics"]["categories"].items():
        out.append(f"  {cat:<48} N={d['n']:>3}  PnL={d['total_pnl']:>+7.2f}%  ({d['comment']})")

    out.append(f"\nTop 10 losers:")
    out.append(f"{'Ticker':<7} {'Setup':<26} {'Dates':<23} "
               f"{'PnL%':>7} {'MFE%':>6} {'Reason'}")
    for l in report["loser_forensics"]["top_losers"][:10]:
        dates = f"{l['entry_date']}->{l['exit_date']}"
        out.append(
            f"{l['ticker']:<7} {(l['entry_path'] or '?')[:25]:<26} {dates[:22]:<23} "
            f"{l['pnl_pct']:>+6.2f}% {l['mfe']:>5.1f}% {l['exit_reason'] or '?'}"
        )

    # 6. Regime
    sec("6. REGIME ANALYSIS")
    for label, group in [
        ("By regime_class:", report["regime_analysis"]["by_regime_class"]),
        ("By state:", report["regime_analysis"]["by_state"]),
        ("By VIX state:", report["regime_analysis"]["by_vix_state"]),
        ("By sector rotation:", report["regime_analysis"]["by_sector_rotation"]),
    ]:
        out.append(f"\n{label}")
        out.append(f"{'Bucket':<24} {'N':>4} {'WR%':>5} {'PnL%':>8} {'PF':>5}")
        for k, s in group.items():
            if not s["n"]:
                continue
            out.append(f"{str(k)[:23]:<24} {s['n']:>4} {s['wr']:>4.0f} "
                       f"{s['pnl']:>+8.2f} {s['pf']:>5.1f}")

    # 7. Cross-asset
    sec("7. CROSS-ASSET BACKDROP — winner vs loser averages")
    out.append(f"{'Asset':<14} {'Wins avg':>10} {'Losses avg':>12} {'Spread':>9}")
    for asset, d in report["cross_asset"].items():
        if d["wins_avg"] is None or d["losses_avg"] is None:
            continue
        spread = d["wins_avg"] - d["losses_avg"]
        out.append(
            f"{asset:<14} {d['wins_avg']:>+9.2f}% {d['losses_avg']:>+11.2f}% "
            f"{spread:>+8.2f}pp"
        )

    # 8. R:R
    sec("8. R:R DISTRIBUTION")
    out.append(f"{'R:R bucket':<14} {'N':>4} {'WR%':>5} {'PnL%':>8} {'PF':>5}")
    for r in report["rr_analysis"]:
        out.append(f"{r['bucket']:<14} {r['n']:>4} {r['wr']:>4.0f} "
                   f"{r['pnl']:>+8.2f} {r['pf']:>5.1f}")

    # 9. MTF
    sec("9. MTF CONCORDANCE")
    out.append(f"{'Bucket':<20} {'N':>4} {'WR%':>5} {'PnL%':>8} {'PF':>5}")
    for r in report["mtf_concordance"]:
        out.append(f"{r['bucket']:<20} {r['n']:>4} {r['wr']:>4.0f} "
                   f"{r['pnl']:>+8.2f} {r['pf']:>5.1f}")

    # 10. Event proximity
    sec("10. EVENT PROXIMITY")
    out.append(f"{'Bucket':<25} {'N':>4} {'WR%':>5} {'PnL%':>8} {'PF':>5}")
    for r in report["event_proximity"]:
        out.append(f"{r['bucket']:<25} {r['n']:>4} {r['wr']:>4.0f} "
                   f"{r['pnl']:>+8.2f} {r['pf']:>5.1f}")

    # 11. Data integrity
    sec("11. DATA INTEGRITY ANOMALIES")
    di = report["data_integrity"]
    out.append(f"Trades with exit_reason='unknown' AND status WIN/LOSS: "
               f"{len(di['exit_reason_unknown_finalized'])}")
    for t in di["exit_reason_unknown_finalized"][:10]:
        out.append(f"  {t['ticker']:<7} {t['status']:<5} entry={t['entry_date']} "
                   f"exit_wallclock={t['exit_date_wallclock']} pnl={t['pnl_pct']}")
    out.append(f"\nTrades with duplicate-OPEN per ticker: {di['duplicate_open_per_ticker']}")
    out.append(f"Trades closed today (wall-clock): {di['closed_today_walllclock']}")
    out.append(f"Trades held >60 days: {len(di['long_held_over_60d'])}")
    for t in di["long_held_over_60d"][:5]:
        out.append(f"  {t['ticker']:<7} held={t['days_held']}d "
                   f"reason={t['exit_reason']} pnl={t['pnl_pct']}")

    # 12. Priority fix list
    sec("12. PRIORITIZED FIX LIST")
    out.append(f"{'Pri':<7} {'Category':<18} {'Target':<35} {'PnL impact':>11} {'Trades':>7}")
    out.append("-" * 85)
    for f in report["priority_fixes"]:
        out.append(
            f"{f['priority']:<7} {f['category']:<18} {f['target'][:34]:<35} "
            f"{f['impact_pnl_pct']:>+10.2f}% {f.get('n_trades_affected', 0):>7}"
        )
    out.append("\nDETAILED RECOMMENDATIONS:")
    for i, f in enumerate(report["priority_fixes"], 1):
        out.append(f"\n  {i}. [{f['priority']}] {f['category']}: {f['target']}")
        out.append(f"     Impact: {f['impact_pnl_pct']:+.2f}% PnL across {f.get('n_trades_affected', 0)} trades")
        out.append(f"     {f['recommendation']}")

    return "\n".join(out)


# ─────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Full Trade Autopsy")
    ap.add_argument("run_id", help="Run identifier")
    ap.add_argument("--output-json", action="store_true", help="Also write JSON")
    ap.add_argument("--top-n", type=int, default=25, help="Top-N for winner/loser sections")
    ap.add_argument("--out-dir", default="/workspace/data/trade-analysis",
                    help="Output directory for artifacts")
    ap.add_argument("--trades-file",
                    help="Path to enriched trades JSON (output of "
                         "autopsy-join-context.py). If omitted, fetches from "
                         "API and uses raw trades (no joined cross-asset).")
    args = ap.parse_args()

    api_key = os.environ.get("TIMED_API_KEY")

    # Prefer enriched trades file; fall back to API fetch
    enriched_path = args.trades_file or f"{args.out_dir}/{args.run_id}/trades-enriched.json"
    if Path(enriched_path).exists():
        print(f"Loading enriched trades from {enriched_path} ...", file=sys.stderr)
        with open(enriched_path) as f:
            data = json.load(f)
        trades = data.get("trades") or []
        print(f"  {len(trades)} trades (with joined context)", file=sys.stderr)
    else:
        if not api_key:
            print("TIMED_API_KEY not set and no enriched file provided", file=sys.stderr)
            sys.exit(1)
        print(f"Fetching trades for {args.run_id} from API (no joined context)...",
              file=sys.stderr)
        trades = fetch_trades(api_key, args.run_id)
        print(f"  {len(trades)} trades", file=sys.stderr)

    overview = section_overview(trades)
    setup_fitness = section_setup_fitness(trades)
    exit_rule_performance = section_exit_rule_performance(trades)
    winner_forensics = section_winner_forensics(trades, top_n=args.top_n)
    loser_forensics = section_loser_forensics(trades, top_n=args.top_n)
    regime_analysis = section_regime_analysis(trades)
    cross_asset = section_cross_asset(trades)
    rr_analysis = section_rr_analysis(trades)
    mtf_concordance = section_mtf_concordance(trades)
    event_proximity = section_event_proximity(trades)
    data_integrity = section_data_integrity(trades)
    priority_fixes = section_priority_fixes(
        setup_fitness, exit_rule_performance, winner_forensics, loser_forensics
    )

    report = {
        "run_id": args.run_id,
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "total_trades": len(trades),
        "overview": overview,
        "setup_fitness": setup_fitness,
        "exit_rule_performance": exit_rule_performance,
        "winner_forensics": winner_forensics,
        "loser_forensics": loser_forensics,
        "regime_analysis": regime_analysis,
        "cross_asset": cross_asset,
        "rr_analysis": rr_analysis,
        "mtf_concordance": mtf_concordance,
        "event_proximity": event_proximity,
        "data_integrity": data_integrity,
        "priority_fixes": priority_fixes,
    }

    print(render_text(report))

    if args.output_json:
        out_dir = Path(args.out_dir) / args.run_id
        out_dir.mkdir(parents=True, exist_ok=True)
        json_path = out_dir / "autopsy.json"
        with open(json_path, "w") as f:
            json.dump(report, f, indent=2)
        print(f"\nJSON saved: {json_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
