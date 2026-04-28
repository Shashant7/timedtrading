#!/usr/bin/env python3
"""
PFVG Detector — finds the First Presented Fair Value Gap from 1-min bars.

Reads pfvg-bars-*.json (output of pfvg-fetcher.py) and writes
pfvg-levels-*.json with one detected PFVG per (ticker, date) when one
exists.

Algorithm (matches v16-pfvg-experiment-spec):
  1. Window: bars between 9:30 and 10:00 ET (provided by fetcher).
  2. For each i in [2..N-1], check 3-bar FVG between bars i-2, i-1, i.
  3. Significance: gap_size >= 0.30 * ATR(14) on the 1-min window OR
     middle bar range >= 1.5x average of prior 6 bars OR
     middle bar broke prior 30-bar high (bull) / low (bear).
  4. Selection: FIRST_VALID — keep the first FVG that passes filter.

Usage:
  python3 scripts/pfvg-detector.py \\
      --input data/pfvg/pfvg-bars-2025-jul-oct.json \\
      --output data/pfvg/pfvg-levels-2025-jul-oct.json
"""
import argparse
import json
import statistics
import sys
from collections import defaultdict


def true_range(prev_close: float, h: float, l: float) -> float:
    return max(h - l, abs(h - prev_close), abs(l - prev_close))


def compute_atr(bars: list, period: int = 14) -> float:
    if len(bars) < 2:
        return 0.0
    trs = []
    for i in range(1, len(bars)):
        trs.append(true_range(bars[i - 1]["c"], bars[i]["h"], bars[i]["l"]))
    if not trs:
        return 0.0
    if len(trs) >= period:
        return sum(trs[-period:]) / period
    return sum(trs) / len(trs)


def detect_pfvg(bars: list) -> dict | None:
    """Return PFVG record or None if no significant FVG found in this window.

    bars: list of {t,o,h,l,c,v} sorted ascending by ts. All inside 9:30-10:00.
    """
    if len(bars) < 3:
        return None
    atr = compute_atr(bars, period=min(14, len(bars) - 1))
    if atr <= 0:
        return None

    avg_range_recent = []
    for i in range(2, len(bars)):
        c1, c2, c3 = bars[i - 2], bars[i - 1], bars[i]
        # bar c2 is the middle bar; bar c3 is the displacement bar
        # Bullish FVG: gap between c1.h and c3.l
        bull_gap = c3["l"] - c1["h"]
        bear_gap = c1["l"] - c3["h"]

        # Average range of prior 6 bars (or whatever is available)
        prior = bars[max(0, i - 6) : i]
        if prior:
            avg_range = sum(b["h"] - b["l"] for b in prior) / len(prior)
        else:
            avg_range = 0.0

        # Structure break check: prior 30 bars (everything before middle)
        prior_struct = bars[: i - 1]  # exclude c2/c3
        prior_high = max((b["h"] for b in prior_struct), default=0.0)
        prior_low = min((b["l"] for b in prior_struct), default=float("inf"))

        for direction, gap, top, bottom in (
            ("bull", bull_gap, c3["l"], c1["h"]),
            ("bear", bear_gap, c1["l"], c3["h"]),
        ):
            if gap <= 0:
                continue
            displacement_atr = gap / atr if atr > 0 else 0.0
            mid_range = c2["h"] - c2["l"]
            range_expansion = mid_range / avg_range if avg_range > 0 else 0.0
            if direction == "bull":
                struct_break = c2["h"] > prior_high if prior_struct else False
            else:
                struct_break = c2["l"] < prior_low if prior_struct else False

            sig_disp = displacement_atr >= 0.30
            sig_range = range_expansion >= 1.5
            sig_struct = bool(struct_break)
            if not (sig_disp or sig_range or sig_struct):
                continue

            strength_score = round(
                min(1.0, (
                    min(displacement_atr / 1.0, 1.0) * 0.5
                    + min(range_expansion / 3.0, 1.0) * 0.3
                    + (0.2 if struct_break else 0.0)
                )),
                3,
            )
            return {
                "direction": direction,
                "top": round(top, 6),
                "bottom": round(bottom, 6),
                "midpoint": round((top + bottom) / 2.0, 6),
                "size": round(gap, 6),
                "detection_ts": c3["t"],
                "formation_indices": [i - 2, i - 1, i],
                "atr_window": round(atr, 6),
                "significance": {
                    "displacement_atr": round(displacement_atr, 3),
                    "range_expansion": round(range_expansion, 3),
                    "structure_break": sig_struct,
                },
                "strength_score": strength_score,
            }
    return None


def main():
    ap = argparse.ArgumentParser(description="PFVG detector")
    ap.add_argument("--input", required=True, help="pfvg-bars JSON")
    ap.add_argument("--output", required=True, help="pfvg-levels JSON")
    args = ap.parse_args()

    with open(args.input) as f:
        bars_db = json.load(f)

    levels = {}
    by_ticker = defaultdict(list)
    by_date = defaultdict(list)

    detected = 0
    no_pfvg = 0
    skipped_no_bars = 0

    for key, bars in bars_db.items():
        if not bars:
            skipped_no_bars += 1
            continue
        # Sort by datetime
        bars = sorted(bars, key=lambda b: b.get("t") or "")
        ticker, date = key.split("|", 1)
        pfvg = detect_pfvg(bars)
        if not pfvg:
            no_pfvg += 1
            continue
        rec = {
            "ticker": ticker,
            "date": date,
            "session_id": f"{ticker}_{date}",
            **pfvg,
        }
        levels[key] = rec
        by_ticker[ticker].append(date)
        by_date[date].append(ticker)
        detected += 1

    print(f"=== PFVG detector ===")
    print(f"Ticker-days input: {len(bars_db)}")
    print(f"  detected:        {detected}")
    print(f"  no_pfvg:         {no_pfvg}")
    print(f"  skipped_no_bars: {skipped_no_bars}")
    print(f"\nDetection rate: {detected / max(1, detected + no_pfvg) * 100:.1f}%")
    print(f"Tickers with at least one PFVG: {len(by_ticker)}")

    # Direction distribution
    bull = sum(1 for r in levels.values() if r["direction"] == "bull")
    bear = sum(1 for r in levels.values() if r["direction"] == "bear")
    print(f"Direction: bull={bull} bear={bear}")

    if levels:
        avg_strength = statistics.mean(r["strength_score"] for r in levels.values())
        avg_disp_atr = statistics.mean(
            r["significance"]["displacement_atr"] for r in levels.values()
        )
        print(f"Avg strength score: {avg_strength:.3f}")
        print(f"Avg displacement (ATR): {avg_disp_atr:.3f}")

    with open(args.output, "w") as f:
        json.dump(levels, f, indent=2)
    print(f"\nWritten: {args.output}")


if __name__ == "__main__":
    main()
