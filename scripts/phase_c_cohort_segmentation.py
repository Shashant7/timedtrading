#!/usr/bin/env python3
"""scripts/phase_c_cohort_segmentation.py

Phase 1a — Cohort segmentation across the full 237-ticker universe.

Reads the cached daily candles from data/phase-c-deep-dive/candles/<TICKER>__D.json
and computes Jul 1, 2025 -> May 8, 2026 performance metrics per ticker.
Buckets each ticker into one of six cohorts.

Outputs:
  data/phase-c-deep-dive/cohort-segmentation.json   (full per-ticker data)
  data/phase-c-deep-dive/cohort-segmentation.csv    (flat table)
  data/phase-c-deep-dive/cohort-summary.md          (markdown summary)

Cohort thresholds (final return July 1 -> May 8):
  MEGA_RUNNER       >= +75%
  STRONG_RUNNER     +30% .. +75%
  MODEST_WINNER     +10% .. +30%
  STAGNANT          -5%  .. +10%
  MILD_LOSER        -20% .. -5%
  CRASHER           <= -20%
"""
from __future__ import annotations

import json
import math
import os
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DD = ROOT / "data" / "phase-c-deep-dive"
CANDLES = DD / "candles"
UNIVERSE = json.loads((DD / "universe.json").read_text())

WINDOW_START_MS = int(datetime(2025, 7, 1, tzinfo=timezone.utc).timestamp() * 1000)
WINDOW_END_MS   = int(datetime(2026, 5, 9, tzinfo=timezone.utc).timestamp() * 1000)  # inclusive of May 8

COHORTS = [
    ("MEGA_RUNNER",   75.0,   math.inf),
    ("STRONG_RUNNER", 30.0,   75.0),
    ("MODEST_WINNER", 10.0,   30.0),
    ("STAGNANT",      -5.0,   10.0),
    ("MILD_LOSER",    -20.0,  -5.0),
    ("CRASHER",       -math.inf, -20.0),
]


def cohort_for(ret_pct: float) -> str:
    for name, lo, hi in COHORTS:
        if lo <= ret_pct < hi:
            return name
    return "CRASHER"


def load_candles(ticker: str) -> list[dict]:
    safe = ticker.replace("/", "_")
    fp = CANDLES / f"{safe}__D.json"
    if not fp.exists():
        return []
    try:
        data = json.loads(fp.read_text())
        return data.get("candles") or []
    except Exception:
        return []


def analyze_ticker(ticker: str, sector: str) -> dict | None:
    candles = load_candles(ticker)
    if not candles:
        return {"ticker": ticker, "sector": sector, "ok": False, "error": "no_candles"}
    in_window = [c for c in candles if WINDOW_START_MS <= int(c.get("ts", 0)) <= WINDOW_END_MS]
    if len(in_window) < 5:
        return {"ticker": ticker, "sector": sector, "ok": False, "error": "insufficient_window_data",
                "candles_total": len(candles), "candles_window": len(in_window)}
    in_window.sort(key=lambda x: int(x["ts"]))
    start_c = in_window[0]
    end_c   = in_window[-1]
    start_p = float(start_c.get("c") or 0)
    end_p   = float(end_c.get("c") or 0)
    if start_p <= 0 or end_p <= 0:
        return {"ticker": ticker, "sector": sector, "ok": False, "error": "bad_prices"}
    ret_pct = (end_p / start_p - 1.0) * 100.0

    closes = [float(c.get("c") or 0) for c in in_window]
    highs  = [float(c.get("h") or 0) for c in in_window]
    lows   = [float(c.get("l") or 0) for c in in_window]
    vols   = [float(c.get("v") or 0) for c in in_window]

    peak_idx = max(range(len(highs)), key=lambda i: highs[i])
    peak_price = highs[peak_idx]
    peak_ts    = int(in_window[peak_idx]["ts"])
    peak_ret_from_start_pct = (peak_price / start_p - 1.0) * 100.0
    drawdown_from_peak_pct = (end_p / peak_price - 1.0) * 100.0 if peak_price > 0 else 0.0

    trough_idx = min(range(len(lows)), key=lambda i: lows[i])
    trough_price = lows[trough_idx]
    trough_ts    = int(in_window[trough_idx]["ts"])

    # daily returns -> volatility (annualized) and max drawdown
    rets = []
    prev = closes[0]
    for c in closes[1:]:
        if prev > 0:
            rets.append((c / prev) - 1.0)
        prev = c
    if rets:
        daily_vol = statistics.pstdev(rets)
        ann_vol_pct = daily_vol * math.sqrt(252) * 100.0
    else:
        ann_vol_pct = 0.0

    # max DD via rolling peak
    running_peak = closes[0]
    max_dd = 0.0
    for c in closes:
        if c > running_peak:
            running_peak = c
        dd = (c / running_peak - 1.0) * 100.0
        if dd < max_dd:
            max_dd = dd

    # accumulation behaviour: time-above-50%-of-peak-run measure
    # (a runner that quickly broke and rode high vs. one that round-tripped)
    days_in_top_quartile = 0
    threshold = start_p + (peak_price - start_p) * 0.75
    for c in closes:
        if c >= threshold:
            days_in_top_quartile += 1

    # rolling 20-day high streak — proxy for sustained trend
    ath_days = 0
    cur_max = 0
    for c in closes:
        if c > cur_max:
            cur_max = c
            ath_days += 1

    avg_dollar_vol = sum((c.get("c", 0) * c.get("v", 0)) for c in in_window) / max(1, len(in_window))

    cohort = cohort_for(ret_pct)
    return {
        "ticker": ticker,
        "sector": sector,
        "ok": True,
        "cohort": cohort,
        "candles_window": len(in_window),
        "start_date": datetime.fromtimestamp(int(start_c["ts"]) / 1000, tz=timezone.utc).strftime("%Y-%m-%d"),
        "end_date":   datetime.fromtimestamp(int(end_c["ts"])   / 1000, tz=timezone.utc).strftime("%Y-%m-%d"),
        "start_price": round(start_p, 4),
        "end_price":   round(end_p, 4),
        "return_pct":  round(ret_pct, 2),
        "peak_price":  round(peak_price, 4),
        "peak_date":   datetime.fromtimestamp(peak_ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d"),
        "peak_return_pct": round(peak_ret_from_start_pct, 2),
        "drawdown_from_peak_pct": round(drawdown_from_peak_pct, 2),
        "trough_price": round(trough_price, 4),
        "trough_date":  datetime.fromtimestamp(trough_ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d"),
        "ann_vol_pct": round(ann_vol_pct, 2),
        "max_dd_pct":  round(max_dd, 2),
        "ath_days":    ath_days,
        "days_in_top_quartile_of_run": days_in_top_quartile,
        "avg_dollar_vol_m": round(avg_dollar_vol / 1_000_000, 2),
    }


def main():
    ticker_to_sector = UNIVERSE["ticker_to_sector"]
    rows = []
    skipped = []
    for ticker in UNIVERSE["tickers"]:
        sector = ticker_to_sector[ticker]
        out = analyze_ticker(ticker, sector)
        if not out:
            continue
        if out.get("ok"):
            rows.append(out)
        else:
            skipped.append(out)

    rows.sort(key=lambda r: r["return_pct"], reverse=True)

    by_cohort: dict[str, list[dict]] = {c[0]: [] for c in COHORTS}
    for r in rows:
        by_cohort[r["cohort"]].append(r)

    summary = {
        "generated_at": int(datetime.now(timezone.utc).timestamp() * 1000),
        "window_start": "2025-07-01",
        "window_end": "2026-05-08",
        "universe_size": len(UNIVERSE["tickers"]),
        "analysed": len(rows),
        "skipped": len(skipped),
        "cohort_thresholds": [{"name": n, "lo_pct": (None if math.isinf(lo) else lo),
                                "hi_pct": (None if math.isinf(hi) else hi)} for n, lo, hi in COHORTS],
        "cohort_counts": {k: len(v) for k, v in by_cohort.items()},
        "cohorts": by_cohort,
        "skipped_tickers": skipped,
    }

    out_json = DD / "cohort-segmentation.json"
    out_json.write_text(json.dumps(summary, indent=2))

    # CSV
    out_csv = DD / "cohort-segmentation.csv"
    cols = ["ticker", "sector", "cohort", "return_pct", "peak_return_pct", "drawdown_from_peak_pct",
            "max_dd_pct", "ann_vol_pct", "ath_days", "days_in_top_quartile_of_run",
            "start_price", "peak_price", "end_price", "peak_date", "avg_dollar_vol_m", "candles_window"]
    with out_csv.open("w") as f:
        f.write(",".join(cols) + "\n")
        for r in rows:
            f.write(",".join(str(r.get(c, "")) for c in cols) + "\n")

    # Markdown summary
    md_lines = []
    md_lines.append(f"# Phase C Cohort Segmentation — {summary['window_start']} → {summary['window_end']}")
    md_lines.append("")
    md_lines.append(f"Universe: {summary['universe_size']} tickers · analysed: {summary['analysed']} · skipped: {summary['skipped']}")
    md_lines.append("")
    md_lines.append("## Cohort counts")
    md_lines.append("")
    md_lines.append("| Cohort | Range | n | Median return % | Median peak return % | Median DD from peak % |")
    md_lines.append("|---|---|---:|---:|---:|---:|")
    for name, lo, hi in COHORTS:
        rng = f"{'-∞' if math.isinf(lo) else f'{lo:+.0f}%'} → {'+∞' if math.isinf(hi) else f'{hi:+.0f}%'}"
        items = by_cohort[name]
        if items:
            med_ret = statistics.median(r["return_pct"] for r in items)
            med_peak = statistics.median(r["peak_return_pct"] for r in items)
            med_dd = statistics.median(r["drawdown_from_peak_pct"] for r in items)
            md_lines.append(f"| **{name}** | {rng} | {len(items)} | {med_ret:+.1f}% | {med_peak:+.1f}% | {med_dd:+.1f}% |")
        else:
            md_lines.append(f"| **{name}** | {rng} | 0 | — | — | — |")
    md_lines.append("")

    for name, _, _ in COHORTS:
        items = by_cohort[name]
        md_lines.append(f"## {name} — n={len(items)}")
        md_lines.append("")
        md_lines.append("| Ticker | Sector | Return % | Peak return % | DD from peak % | Max DD % | Vol % | ATH days | Days top-25% of run | Peak date |")
        md_lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---|")
        for r in items[:60]:
            md_lines.append(
                f"| {r['ticker']} | {r['sector']} | {r['return_pct']:+.1f}% | {r['peak_return_pct']:+.1f}% | "
                f"{r['drawdown_from_peak_pct']:+.1f}% | {r['max_dd_pct']:+.1f}% | {r['ann_vol_pct']:.0f}% | "
                f"{r['ath_days']} | {r['days_in_top_quartile_of_run']} | {r['peak_date']} |"
            )
        if len(items) > 60:
            md_lines.append(f"| … | … | … | … | … | … | … | … | … | _{len(items)-60} more rows in JSON_ |")
        md_lines.append("")

    if skipped:
        md_lines.append("## Skipped tickers (insufficient data)")
        md_lines.append("")
        for s in skipped:
            md_lines.append(f"- {s['ticker']} ({s.get('sector','')}) — {s.get('error','?')}")
        md_lines.append("")

    out_md = DD / "cohort-summary.md"
    out_md.write_text("\n".join(md_lines))

    print(f"[cohort] wrote {out_json}")
    print(f"[cohort] wrote {out_csv}")
    print(f"[cohort] wrote {out_md}")
    print(f"[cohort] cohorts: {summary['cohort_counts']}")


if __name__ == "__main__":
    main()
