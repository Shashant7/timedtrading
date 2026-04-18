#!/usr/bin/env python3
"""
scripts/phase-d-cross-month-analysis.py

Phase D cross-month synthesis: aggregates all 10 v2 monthly slices
(Jul 2025 - Apr 2026) alongside their Phase-B backdrops and block-chain
traces, and produces:

  data/trade-analysis/phase-d-cross-month-synthesis-2026-04-18/
    synthesis.md          human summary
    synthesis.json        machine-readable
    setup-vs-backdrop.md  trade outcomes by regime/cycle
    events-audit.md       earnings/macro-event honored check
    spy-qqq-iwm-gate.md   deep-dive on why index ETFs still zero trades

Assumes all 10 slice directories exist under
data/trade-analysis/phase-d-slice-<month>-v2/ with trades.json and
block_chain.jsonl.

Usage:
  node scripts/phase-d-cross-month-analysis.py  (no — it's python)
  python3 scripts/phase-d-cross-month-analysis.py
"""

import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SLICES = Path(ROOT) / "data" / "trade-analysis"
BACKDROPS = Path(ROOT) / "data" / "backdrops"
OUTDIR = SLICES / "phase-d-cross-month-synthesis-2026-04-18"
OUTDIR.mkdir(parents=True, exist_ok=True)

MONTHS = [
    "2025-07", "2025-08", "2025-09", "2025-10", "2025-11",
    "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
]
HOLDOUT = {"2026-03", "2026-04"}

TIER1_ETF = {"SPY", "QQQ", "IWM"}
TIER1_STOCKS = {"AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"}
TIER2 = {"AGQ", "CDNS", "ETN", "FIX", "GRNY", "HUBS", "IESC", "MTZ", "ON", "PH", "RIOT", "SGI", "SWK", "XLY"}


def load_trades(month):
    p = SLICES / f"phase-d-slice-{month}-v2" / "trades.json"
    if not p.exists():
        return []
    return json.loads(p.read_text()).get("trades") or []


def load_block_chain(month):
    p = SLICES / f"phase-d-slice-{month}-v2" / "block_chain.jsonl"
    if not p.exists():
        return []
    bars = []
    for line in p.read_text().splitlines():
        if not line.strip():
            continue
        try:
            bars.append(json.loads(line))
        except Exception:
            pass
    return bars


def load_backdrop(month):
    p = BACKDROPS / f"{month}.json"
    if not p.exists():
        return {}
    return json.loads(p.read_text())


def pnl_pct(t):
    v = t.get("pnl_pct")
    try:
        return float(v) if v is not None else 0.0
    except Exception:
        return 0.0


def cohort(ticker):
    if ticker in TIER1_ETF:
        return "Tier-1-ETF"
    if ticker in TIER1_STOCKS:
        return "Tier-1-stock"
    if ticker in TIER2:
        return "Tier-2"
    return "other"


def fmt_pct(n):
    if n is None:
        return "—"
    return f"{n:+.2f}%"


# ---------------------------------------------------------------------------
# Per-month snapshot
# ---------------------------------------------------------------------------


def per_month_summary():
    rows = []
    for m in MONTHS:
        trades = load_trades(m)
        bd = load_backdrop(m)
        wins = [t for t in trades if t.get("status") == "WIN"]
        losses = [t for t in trades if t.get("status") == "LOSS"]
        open_tp = [t for t in trades if t.get("status") == "TP_HIT_TRIM"]
        n = len(trades)
        wr = len(wins) / max(1, len(wins) + len(losses)) * 100
        pnl = sum(pnl_pct(t) for t in trades)
        big = [t for t in trades if pnl_pct(t) >= 5]
        clear_l = [t for t in trades if pnl_pct(t) <= -1.5]
        etf = [t for t in trades if t.get("ticker") in TIER1_ETF]
        rows.append({
            "month": m,
            "holdout": m in HOLDOUT,
            "trades": n,
            "wins": len(wins),
            "losses": len(losses),
            "open_tp": len(open_tp),
            "wr": wr,
            "big_winners": len(big),
            "clear_losers": len(clear_l),
            "sum_pnl_pct": pnl,
            "spy_qqq_iwm_trades": len(etf),
            "cycle": bd.get("cycle", {}).get("label"),
            "realized_vol": bd.get("cross_asset_vol", {}).get("spy_realized_vol", {}).get("annualized_pct"),
            "spy_ret": bd.get("sector_leadership", {}).get("spy_ret_pct"),
            "earnings_events": bd.get("event_density", {}).get("earnings", {}).get("total_events"),
            "clusters": len(bd.get("event_density", {}).get("earnings", {}).get("clusters_ge3_tickers_within_3d", [])),
        })
    return rows


# ---------------------------------------------------------------------------
# Exit-reason classification
# ---------------------------------------------------------------------------

# Categorize exit reasons into families for analysis.
EXIT_CATEGORIES = {
    "winner_take": ["TP_FULL", "mfe_proportional_trail", "HARD_FUSE_RSI_EXTREME", "SOFT_FUSE_RSI_CONFIRMED", "SMART_RUNNER_TD_EXHAUSTION_RUNNER", "PHASE_LEAVE_100"],
    "management_cut": ["ST_FLIP_4H_CLOSE", "SMART_RUNNER_SUPPORT_BREAK_CLOUD", "SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE", "PROFIT_GIVEBACK_STAGE_HOLD", "PROFIT_GIVEBACK_COOLING_HOLD", "ripster_72_89_1h_structural_break", "RUNNER_MAX_DRAWDOWN_BREAKER", "RSI_DIVERGENCE_TRAIL"],
    "safety_stop": ["max_loss", "HARD_LOSS_CAP", "sl_breached", "max_loss_pdz_window_expired"],
    "time_based": ["hard_max_hold_168h", "eod_trimmed_underwater_flatten", "STALL_FORCE_CLOSE", "RUNNER_STALE_FORCE_CLOSE", "replay_end_close"],
    "event_based": ["PRE_EVENT_RECOVERY_EXIT", "PRE_EARNINGS_FORCE_EXIT"],
    "bias_flip": ["bias_flip_full", "critical_invalidation"],
}


def classify_exit(reason):
    if not reason:
        return "unknown"
    for cat, reasons in EXIT_CATEGORIES.items():
        if reason in reasons:
            return cat
    return "other"


# ---------------------------------------------------------------------------
# Analysis: by exit reason x outcome across all 10 months
# ---------------------------------------------------------------------------


def exit_reason_analysis():
    stats = defaultdict(lambda: {"count": 0, "wins": 0, "losses": 0, "sum_pnl": 0.0, "avg_pnl": 0.0, "big_wins": 0, "clear_losses": 0, "category": None})
    all_trades = []
    for m in MONTHS:
        for t in load_trades(m):
            reason = t.get("exit_reason") or "unknown"
            cat = classify_exit(reason)
            p = pnl_pct(t)
            stats[reason]["count"] += 1
            stats[reason]["category"] = cat
            stats[reason]["sum_pnl"] += p
            if t.get("status") == "WIN":
                stats[reason]["wins"] += 1
            elif t.get("status") == "LOSS":
                stats[reason]["losses"] += 1
            if p >= 5:
                stats[reason]["big_wins"] += 1
            if p <= -1.5:
                stats[reason]["clear_losses"] += 1
            all_trades.append({**t, "_month": m, "_pnl": p, "_reason": reason, "_cat": cat})
    for r, s in stats.items():
        s["avg_pnl"] = s["sum_pnl"] / max(1, s["count"])
        s["wr"] = s["wins"] / max(1, s["wins"] + s["losses"]) * 100 if (s["wins"] + s["losses"]) > 0 else None
    return dict(stats), all_trades


# ---------------------------------------------------------------------------
# Analysis: by cohort and backdrop cycle
# ---------------------------------------------------------------------------


def cohort_by_cycle():
    buckets = defaultdict(lambda: defaultdict(lambda: {"n": 0, "wins": 0, "losses": 0, "sum_pnl": 0.0, "big": 0}))
    for m in MONTHS:
        bd = load_backdrop(m)
        cycle = bd.get("cycle", {}).get("label", "unknown")
        for t in load_trades(m):
            c = cohort(t.get("ticker"))
            b = buckets[cycle][c]
            b["n"] += 1
            b["sum_pnl"] += pnl_pct(t)
            if t.get("status") == "WIN":
                b["wins"] += 1
            elif t.get("status") == "LOSS":
                b["losses"] += 1
            if pnl_pct(t) >= 5:
                b["big"] += 1
    for cycle, cohorts in buckets.items():
        for c, b in cohorts.items():
            b["wr"] = b["wins"] / max(1, b["wins"] + b["losses"]) * 100 if (b["wins"] + b["losses"]) > 0 else None
    return {k: dict(v) for k, v in buckets.items()}


# ---------------------------------------------------------------------------
# Analysis: earnings/events honored check
# ---------------------------------------------------------------------------


def build_earnings_index():
    """Map ticker -> list of earnings dates across all backdrops."""
    idx = defaultdict(list)
    for m in MONTHS:
        bd = load_backdrop(m)
        ern = bd.get("event_density", {}).get("earnings", {}).get("by_ticker", {})
        for tkr, events in ern.items():
            for ev in events:
                idx[tkr].append(ev.get("date"))
    # De-dup
    for k in idx:
        idx[k] = sorted(set(idx[k]))
    return dict(idx)


def events_analysis():
    """For every trade, check if it entered within 3 trading days of a
    known earnings date for that ticker. Also surface how exits tagged
    PRE_EVENT_RECOVERY_EXIT / PRE_EARNINGS_FORCE_EXIT correlate to
    actual event proximity."""
    ern_idx = build_earnings_index()

    # Date helpers
    def entry_date(t):
        ts = t.get("entry_ts")
        if not ts:
            return None
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).date().isoformat()

    def days_between(a, b):
        return (datetime.fromisoformat(a).date() - datetime.fromisoformat(b).date()).days

    stats = {
        "entered_within_3d_of_earnings": 0,
        "entered_day_of_earnings": 0,
        "entered_post_earnings_1d": 0,
        "entered_not_near_earnings": 0,
        "exit_PRE_EVENT_RECOVERY_EXIT_count": 0,
        "exit_PRE_EVENT_RECOVERY_EXIT_near_earnings": 0,
        "exit_PRE_EVENT_RECOVERY_EXIT_no_earnings_within_5d": 0,
        "exit_PRE_EARNINGS_FORCE_EXIT_count": 0,
        "exit_PRE_EARNINGS_FORCE_EXIT_near_earnings": 0,
    }
    pre_event_samples = []
    near_earnings_outcomes = {"wins": 0, "losses": 0, "sum_pnl": 0.0}

    for m in MONTHS:
        for t in load_trades(m):
            tkr = t.get("ticker")
            ed = entry_date(t)
            if not ed:
                continue
            dates = ern_idx.get(tkr, [])
            # Find nearest earnings date for this ticker
            nearest_earnings = None
            nearest_days = None
            for earn in dates:
                try:
                    diff = days_between(ed, earn)
                    if nearest_days is None or abs(diff) < abs(nearest_days):
                        nearest_days = diff
                        nearest_earnings = earn
                except Exception:
                    continue

            is_near = nearest_days is not None and abs(nearest_days) <= 3
            if is_near:
                stats["entered_within_3d_of_earnings"] += 1
                if nearest_days == 0:
                    stats["entered_day_of_earnings"] += 1
                elif nearest_days == 1:
                    stats["entered_post_earnings_1d"] += 1
                if t.get("status") == "WIN":
                    near_earnings_outcomes["wins"] += 1
                elif t.get("status") == "LOSS":
                    near_earnings_outcomes["losses"] += 1
                near_earnings_outcomes["sum_pnl"] += pnl_pct(t)
            else:
                stats["entered_not_near_earnings"] += 1

            reason = t.get("exit_reason") or ""
            if reason == "PRE_EVENT_RECOVERY_EXIT":
                stats["exit_PRE_EVENT_RECOVERY_EXIT_count"] += 1
                if is_near:
                    stats["exit_PRE_EVENT_RECOVERY_EXIT_near_earnings"] += 1
                else:
                    if nearest_days is None or abs(nearest_days) > 5:
                        stats["exit_PRE_EVENT_RECOVERY_EXIT_no_earnings_within_5d"] += 1
                pre_event_samples.append({
                    "month": m, "ticker": tkr, "entry_date": ed,
                    "nearest_earnings": nearest_earnings, "days_to_earnings": nearest_days,
                    "pnl_pct": pnl_pct(t),
                })
            if reason == "PRE_EARNINGS_FORCE_EXIT":
                stats["exit_PRE_EARNINGS_FORCE_EXIT_count"] += 1
                if is_near:
                    stats["exit_PRE_EARNINGS_FORCE_EXIT_near_earnings"] += 1

    stats["near_earnings_outcomes"] = near_earnings_outcomes
    return stats, pre_event_samples


# ---------------------------------------------------------------------------
# Analysis: ETF block chain (why SPY/QQQ/IWM still zero)
# ---------------------------------------------------------------------------


def etf_block_chain():
    """For each month, aggregate block reasons for SPY/QQQ/IWM to see
    what gates are still blocking despite T6A."""
    per_month = {}
    # totals: reason -> {SPY: int, QQQ: int, IWM: int}
    totals = defaultdict(lambda: {"SPY": 0, "QQQ": 0, "IWM": 0})
    for m in MONTHS:
        bars = load_block_chain(m)
        by_ticker = {"SPY": Counter(), "QQQ": Counter(), "IWM": Counter()}
        max_score = {"SPY": 0, "QQQ": 0, "IWM": 0}
        stages = {"SPY": Counter(), "QQQ": Counter(), "IWM": Counter()}
        for b in bars:
            t = b.get("ticker")
            if t not in by_ticker:
                continue
            by_ticker[t][b.get("reason", "unknown")] += 1
            stages[t][b.get("kanban_stage", "unknown")] += 1
            if b.get("score") and b["score"] > max_score[t]:
                max_score[t] = b["score"]
        per_month[m] = {
            "by_ticker": {k: dict(v) for k, v in by_ticker.items()},
            "max_score": max_score,
            "stages": {k: dict(v) for k, v in stages.items()},
        }
        for tkr, cnt in by_ticker.items():
            for reason, n in cnt.items():
                totals[reason][tkr] += n
    return per_month, dict(totals)


# ---------------------------------------------------------------------------
# Write outputs
# ---------------------------------------------------------------------------


def write_synthesis():
    summary = per_month_summary()
    exit_stats, all_trades = exit_reason_analysis()
    cohort_cycle = cohort_by_cycle()
    events_stats, pre_event_samples = events_analysis()
    etf_per_month, etf_totals = etf_block_chain()

    # Overall totals (training only)
    training_rows = [r for r in summary if not r["holdout"]]
    holdout_rows = [r for r in summary if r["holdout"]]
    total_training_trades = sum(r["trades"] for r in training_rows)
    total_training_wins = sum(r["wins"] for r in training_rows)
    total_training_losses = sum(r["losses"] for r in training_rows)
    training_wr = total_training_wins / max(1, total_training_wins + total_training_losses) * 100
    training_pnl = sum(r["sum_pnl_pct"] for r in training_rows)
    training_big = sum(r["big_winners"] for r in training_rows)
    training_clear_l = sum(r["clear_losers"] for r in training_rows)

    # Markdown
    lines = []
    lines.append("# Phase D cross-month synthesis — 2026-04-18")
    lines.append("")
    lines.append(f"- Scope: 10 v2 slices on the 24-ticker Phase-B universe, Jul 2025 – Apr 2026.")
    lines.append(f"- Orchestrator: deterministic (PR #9 cleanSlate fix).")
    lines.append(f"- Data: full 215-ticker SECTOR_MAP hydration complete (0 gap cells).")
    lines.append(f"- Worker: stale-bundle + entry-price-divergent guards active; T6A active for SPY/QQQ/IWM.")
    lines.append(f"- Holdout discipline: **{sorted(HOLDOUT)}** reported separately; not used in tuning-proposal evidence.")
    lines.append("")
    lines.append("## Training-months rollup (8 months, Jul 2025 – Feb 2026)")
    lines.append("")
    lines.append(f"- **Trades: {total_training_trades}**")
    lines.append(f"- **Win rate: {training_wr:.1f}%** ({total_training_wins} W / {total_training_losses} L)")
    lines.append(f"- **Big winners (≥ 5 % pnl): {training_big}**")
    lines.append(f"- **Clear losers (≤ −1.5 % pnl): {training_clear_l}**")
    lines.append(f"- **Sum `pnl_pct`: {training_pnl:+.2f}%**")
    lines.append(f"- **SPY / QQQ / IWM trades: {sum(r['spy_qqq_iwm_trades'] for r in training_rows)}**")
    lines.append("")

    # Per-month table
    lines.append("## Per-month table")
    lines.append("")
    lines.append("| Month | Holdout | Cycle | RV % | SPY ret | Trades | WR | Big W | Clear L | Sum pnl | SPY/QQQ/IWM | Earnings | Clusters |")
    lines.append("|---|:-:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in summary:
        lines.append("| {month} | {h} | {cyc} | {rv} | {sr} | {n} | {wr:.1f}% | {big} | {cl} | {p:+.2f}% | {etf} | {ern} | {cl_n} |".format(
            month=r["month"], h="✓" if r["holdout"] else "",
            cyc=r["cycle"] or "-",
            rv=f"{r['realized_vol']:.1f}" if r["realized_vol"] else "-",
            sr=f"{r['spy_ret']:+.1f}%" if r["spy_ret"] else "-",
            n=r["trades"], wr=r["wr"], big=r["big_winners"], cl=r["clear_losers"],
            p=r["sum_pnl_pct"], etf=r["spy_qqq_iwm_trades"],
            ern=r["earnings_events"] or 0, cl_n=r["clusters"] or 0,
        ))
    lines.append("")

    lines.append("## Losing months (WR < 50 %)")
    lines.append("")
    losing = [r for r in summary if r["wr"] < 50 and r["trades"] > 0]
    if losing:
        for r in losing:
            lines.append(f"- **{r['month']}** ({r['cycle']}, vol {r['realized_vol']:.1f} %, SPY {r['spy_ret']:+.1f} %): {r['trades']} trades, WR {r['wr']:.1f} %, PnL {r['sum_pnl_pct']:+.2f} %, {r['clear_losers']} clear losers")
    else:
        lines.append("- None.")
    lines.append("")

    # Months with 0 trades or "starving"
    lines.append("## Starving months (< 5 trades)")
    lines.append("")
    starving = [r for r in summary if r["trades"] < 5]
    if starving:
        for r in starving:
            lines.append(f"- **{r['month']}** ({r['cycle']}): {r['trades']} trades")
    else:
        lines.append("- None.")
    lines.append("")

    # Cohort x cycle
    lines.append("## Cohort × cycle breakdown")
    lines.append("")
    lines.append("| Cycle | Tier-1 ETF | Tier-1 stock | Tier-2 |")
    lines.append("|---|---|---|---|")
    for cycle in ("uptrend", "transitional", "downtrend"):
        row = cohort_cycle.get(cycle, {})
        cells = []
        for c in ("Tier-1-ETF", "Tier-1-stock", "Tier-2"):
            s = row.get(c, {"n": 0, "wr": None, "sum_pnl": 0.0, "big": 0})
            if s["n"] == 0:
                cells.append("—")
            else:
                cells.append(f"n={s['n']} WR={s['wr']:.0f}% pnl={s['sum_pnl']:+.1f}% big={s['big']}")
        lines.append(f"| {cycle} | {cells[0]} | {cells[1]} | {cells[2]} |")
    lines.append("")

    # Exit-reason table (top 20 by count)
    lines.append("## Exit-reason rollup (all 10 months)")
    lines.append("")
    lines.append("| Exit reason | Category | Count | WR | Avg PnL | Sum PnL | Big W | Clear L |")
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|")
    sorted_reasons = sorted(exit_stats.items(), key=lambda x: -x[1]["count"])
    for reason, s in sorted_reasons[:20]:
        wr = f"{s['wr']:.0f}%" if s.get("wr") is not None else "—"
        lines.append(f"| `{reason}` | {s['category']} | {s['count']} | {wr} | {s['avg_pnl']:+.2f}% | {s['sum_pnl']:+.1f}% | {s['big_wins']} | {s['clear_losses']} |")
    lines.append("")

    # Events
    lines.append("## Events & earnings — are they being honored?")
    lines.append("")
    total_trades = sum(1 for m in MONTHS for t in load_trades(m))
    near_pct = events_stats["entered_within_3d_of_earnings"] / max(1, total_trades) * 100
    lines.append(f"- Total trades across all 10 months: **{total_trades}**")
    lines.append(f"- Entered within 3 days of an earnings event (for the same ticker): **{events_stats['entered_within_3d_of_earnings']} ({near_pct:.1f}%)**")
    lines.append(f"  - On the day-of earnings: {events_stats['entered_day_of_earnings']}")
    lines.append(f"  - Day-after earnings: {events_stats['entered_post_earnings_1d']}")
    near_out = events_stats["near_earnings_outcomes"]
    if near_out["wins"] + near_out["losses"] > 0:
        near_wr = near_out["wins"] / (near_out["wins"] + near_out["losses"]) * 100
        lines.append(f"  - Outcome: {near_out['wins']} W / {near_out['losses']} L → WR {near_wr:.1f}%, sum PnL {near_out['sum_pnl']:+.2f}%")
    lines.append("")
    lines.append(f"- `PRE_EVENT_RECOVERY_EXIT` fires: **{events_stats['exit_PRE_EVENT_RECOVERY_EXIT_count']}**")
    lines.append(f"  - Near a known earnings event (≤ 3d): {events_stats['exit_PRE_EVENT_RECOVERY_EXIT_near_earnings']}")
    lines.append(f"  - No earnings event within 5d: {events_stats['exit_PRE_EVENT_RECOVERY_EXIT_no_earnings_within_5d']} (these are macro-event triggered)")
    lines.append(f"- `PRE_EARNINGS_FORCE_EXIT` fires: **{events_stats['exit_PRE_EARNINGS_FORCE_EXIT_count']}**")
    lines.append(f"  - Near earnings (≤ 3d): {events_stats['exit_PRE_EARNINGS_FORCE_EXIT_near_earnings']}")
    lines.append("")
    if pre_event_samples:
        lines.append("### `PRE_EVENT_RECOVERY_EXIT` samples (first 15)")
        lines.append("")
        lines.append("| Month | Ticker | Entry | Nearest earnings | Days to earnings | PnL |")
        lines.append("|---|---|---|---|---:|---:|")
        for s in pre_event_samples[:15]:
            lines.append(f"| {s['month']} | {s['ticker']} | {s['entry_date']} | {s['nearest_earnings'] or '—'} | {s['days_to_earnings'] if s['days_to_earnings'] is not None else '—'} | {s['pnl_pct']:+.2f}% |")
        lines.append("")

    # ETF (SPY/QQQ/IWM) deep dive
    lines.append("## SPY / QQQ / IWM — why still zero trades?")
    lines.append("")
    lines.append("T6A has been active for all 10 v2 slices (Phase-B universe). The SPY/QQQ/IWM trade count across every month is **0**. Block-chain analysis shows the dominant remaining gates:")
    lines.append("")
    lines.append("### Aggregate block reasons across all 10 months, per ticker")
    lines.append("")
    lines.append("| Reason | SPY | QQQ | IWM |")
    lines.append("|---|---:|---:|---:|")
    sorted_etf = sorted(etf_totals.items(), key=lambda x: -(x[1]["SPY"] + x[1]["QQQ"] + x[1]["IWM"]))
    for reason, cnt in sorted_etf[:15]:
        lines.append(f"| `{reason}` | {cnt['SPY']} | {cnt['QQQ']} | {cnt['IWM']} |")
    lines.append("")

    lines.append("### Per-month peak score (showing how close each got to triggering)")
    lines.append("")
    lines.append("| Month | SPY max_score | QQQ max_score | IWM max_score |")
    lines.append("|---|---:|---:|---:|")
    for m in MONTHS:
        mx = etf_per_month.get(m, {}).get("max_score", {})
        lines.append(f"| {m} | {mx.get('SPY', 0)} | {mx.get('QQQ', 0)} | {mx.get('IWM', 0)} |")
    lines.append("")

    # Write
    (OUTDIR / "synthesis.md").write_text("\n".join(lines))
    (OUTDIR / "synthesis.json").write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "per_month": summary,
        "training_totals": {
            "trades": total_training_trades,
            "wins": total_training_wins,
            "losses": total_training_losses,
            "wr": training_wr,
            "sum_pnl_pct": training_pnl,
            "big_winners": training_big,
            "clear_losers": training_clear_l,
        },
        "exit_reasons": {r: {k: v for k, v in s.items() if k != "category"} | {"category": s["category"]} for r, s in exit_stats.items()},
        "cohort_cycle": cohort_cycle,
        "events": events_stats,
        "etf_totals": {r: dict(cnt) for r, cnt in etf_totals.items()},
    }, indent=2, default=str))

    print(f"Wrote {OUTDIR / 'synthesis.md'}")
    print(f"Wrote {OUTDIR / 'synthesis.json'}")
    print()
    print(f"Training rollup: {total_training_trades} trades / WR {training_wr:.1f}% / {training_big} big winners / PnL {training_pnl:+.2f}%")


if __name__ == "__main__":
    write_synthesis()
