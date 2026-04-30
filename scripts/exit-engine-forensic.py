#!/usr/bin/env python3
"""
Exit Engine Forensic Analysis (V15 P0.6 plan)

For each closed trade in a backtest run:
  1. Pull bar-level price+state series for ticker over trade window + 5 days post
  2. Find peak MFE bar (the "ideal exit")
  3. Identify state / kanban_stage transitions around peak
  4. Compute capture efficiency (actual_pnl / peak_mfe)
  5. Categorize the give-back pattern

Goal: surface the SIGNAL FINGERPRINT of peak MFE so we can build an
exit rule that fires there.

Usage:
  TIMED_API_KEY=... python3 scripts/exit-engine-forensic.py <run_id>
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta

API_BASE = "https://timed-trading-ingest.shashant.workers.dev"
API_KEY = os.environ.get("TIMED_API_KEY")
if not API_KEY:
    print("ERROR: TIMED_API_KEY not set", file=sys.stderr)
    sys.exit(1)

RUN_ID = sys.argv[1] if len(sys.argv) > 1 else "v15p05-fullrun-1777203131"


def http_get_json(path):
    url = f"{API_BASE}{path}"
    if "?" in url:
        url += f"&key={API_KEY}"
    else:
        url += f"?key={API_KEY}"
    req = urllib.request.Request(url, headers={"User-Agent": "timed-trading-forensic/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def fetch_trail(ticker, since_ms, until_ms):
    path = f"/timed/admin/trail-payload?ticker={ticker}&since={since_ms}&until={until_ms}&limit=1000"
    return http_get_json(path).get("rows") or []


# Optional: read trades from local saved snapshot to avoid Cloudflare bot detection
TRADES_LOCAL = os.environ.get("TRADES_LOCAL")


def fetch_trades(run_id):
    if TRADES_LOCAL and os.path.exists(TRADES_LOCAL):
        with open(TRADES_LOCAL) as f:
            return json.load(f).get("trades") or []
    path = f"/timed/admin/runs/trades?run_id={run_id}&limit=10000"
    return http_get_json(path).get("trades") or []


def fmt_ts(ts):
    return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def pnl_pct(t):
    return float(t.get("pnl_pct") or 0)


def analyze_trade(t, look_ahead_days=10):
    direction = (t.get("direction") or "").upper()
    entry_ts = t.get("entry_ts") or 0
    entry_price = float(t.get("entry_price") or 0)
    exit_ts = t.get("exit_ts") or 0
    exit_price = float(t.get("exit_price") or 0)
    pnl = pnl_pct(t)
    if not (entry_ts and entry_price and direction):
        return None

    # Look ahead 10 days OR until exit + 2 days, whichever is later
    until_ms = max(exit_ts + 2 * 86400_000, entry_ts + look_ahead_days * 86400_000)
    since_ms = entry_ts - 3600_000  # 1h before entry for context
    rows = fetch_trail(t["ticker"], since_ms, until_ms)
    if not rows:
        return None

    rows = sorted(rows, key=lambda r: r.get("ts", 0))

    # Walk forward from entry, track running MFE per bar
    is_long = direction == "LONG"
    peak_pnl_pct = 0.0
    peak_ts = entry_ts
    peak_price = entry_price
    bars_to_peak = 0
    bars_post_entry = 0

    # Also track post-peak: when did price first cross back to actual exit pnl,
    # and what was the structure at peak (stage, state)
    state_at_peak = None
    stage_at_peak = None
    # Slice rows to entry → exit + 2d
    after_entry = [r for r in rows if r.get("ts", 0) >= entry_ts]
    if not after_entry:
        return None

    for i, r in enumerate(after_entry):
        if r.get("ts", 0) > exit_ts + 86400_000 * 2:
            break
        bars_post_entry += 1
        px = float(r.get("price") or 0)
        if px <= 0:
            continue
        # Compute live pnl for our direction
        live_pnl = ((px - entry_price) / entry_price * 100.0) if is_long else ((entry_price - px) / entry_price * 100.0)
        if live_pnl > peak_pnl_pct:
            peak_pnl_pct = live_pnl
            peak_ts = r.get("ts", 0)
            peak_price = px
            bars_to_peak = i
            state_at_peak = r.get("state")
            stage_at_peak = r.get("kanban_stage")

    # Find what stage the trade was at when ACTUAL exit fired
    exit_stage = None
    exit_state = None
    for r in after_entry:
        if abs(r.get("ts", 0) - exit_ts) <= 1800_000:  # within 30min of exit
            exit_stage = r.get("kanban_stage")
            exit_state = r.get("state")
            break

    # Find bars from entry to peak (in trading bars / 30min intervals)
    bars_to_peak_min = bars_to_peak * 30  # approx
    capture_pct = (pnl / peak_pnl_pct * 100.0) if peak_pnl_pct > 0 else 0
    give_back_pct = peak_pnl_pct - pnl if peak_pnl_pct > pnl else 0

    # Look at the bar AT/JUST AFTER peak: did price reverse?
    # Did stage change? Find first bar after peak where stage != stage_at_peak
    post_peak_stage_change_ts = None
    post_peak_stage_change_to = None
    for r in after_entry:
        if r.get("ts", 0) <= peak_ts:
            continue
        s = r.get("kanban_stage")
        if s and s != stage_at_peak:
            post_peak_stage_change_ts = r.get("ts", 0)
            post_peak_stage_change_to = s
            break

    return {
        "ticker": t.get("ticker"),
        "direction": direction,
        "entry_ts": entry_ts,
        "exit_ts": exit_ts,
        "entry_price": entry_price,
        "exit_price": exit_price,
        "actual_pnl": pnl,
        "exit_reason": t.get("exit_reason"),
        "peak_pnl": round(peak_pnl_pct, 2),
        "peak_price": peak_price,
        "peak_ts": peak_ts,
        "bars_to_peak": bars_to_peak,
        "bars_to_peak_min": bars_to_peak_min,
        "state_at_peak": state_at_peak,
        "stage_at_peak": stage_at_peak,
        "exit_state": exit_state,
        "exit_stage": exit_stage,
        "capture_pct": round(capture_pct, 1),
        "give_back_pct": round(give_back_pct, 2),
        "post_peak_stage_change_to": post_peak_stage_change_to,
        "minutes_peak_to_exit": round((exit_ts - peak_ts) / 60000) if exit_ts and peak_ts else None,
        "status": t.get("status"),
    }


def main():
    print(f"=== Exit Engine Forensic — {RUN_ID} ===\n", flush=True)
    trades = fetch_trades(RUN_ID)
    closed = [t for t in trades if t.get("status") in ("WIN", "LOSS", "FLAT")]
    print(f"Total closed trades: {len(closed)}\n", flush=True)

    results = []
    for i, t in enumerate(closed):
        try:
            r = analyze_trade(t)
            if r:
                results.append(r)
            if (i + 1) % 10 == 0:
                print(f"  ... analyzed {i+1}/{len(closed)}", flush=True)
        except Exception as e:
            print(f"  ERR on {t.get('ticker')}: {e}", file=sys.stderr)
        time.sleep(0.05)

    print(f"\nAnalyzed {len(results)} trades\n", flush=True)

    # ─── 1. Capture efficiency overall ───
    print("=" * 90)
    print("1. OVERALL CAPTURE EFFICIENCY (actual_pnl as % of peak MFE)")
    print("=" * 90)
    wins = [r for r in results if r["status"] == "WIN" and r["peak_pnl"] > 0]
    losses = [r for r in results if r["status"] == "LOSS"]

    if wins:
        avg_capture = sum(r["capture_pct"] for r in wins) / len(wins)
        avg_giveback = sum(r["give_back_pct"] for r in wins) / len(wins)
        avg_peak = sum(r["peak_pnl"] for r in wins) / len(wins)
        avg_actual = sum(r["actual_pnl"] for r in wins) / len(wins)
        print(f"  WINS (n={len(wins)}):")
        print(f"    avg peak MFE:     +{avg_peak:.2f}%")
        print(f"    avg actual pnl:   +{avg_actual:.2f}%")
        print(f"    avg give-back:    +{avg_giveback:.2f}%  ← money left")
        print(f"    avg capture:      {avg_capture:.0f}% of peak")
        print()

    if losses:
        bad = [r for r in losses if r["peak_pnl"] >= 1.0]
        print(f"  LOSSES with peak MFE >= +1% (wins-turned-losses): {len(bad)} of {len(losses)}")
        for r in sorted(bad, key=lambda x: -x["peak_pnl"])[:8]:
            print(f"    {r['ticker']} {r['direction']} peak +{r['peak_pnl']:.2f}% → exit {r['actual_pnl']:+.2f}%  exit_reason={r['exit_reason']}")
        print()

    # ─── 2. Bars to peak — when does the move end? ───
    print("=" * 90)
    print("2. TIMING — when does peak MFE occur (bars from entry)?")
    print("=" * 90)
    if wins:
        bars_buckets = Counter()
        for r in wins:
            b = r["bars_to_peak"]
            if b <= 4:    bars_buckets["1-4 bars (1-2h)"] += 1
            elif b <= 12: bars_buckets["5-12 bars (3-6h)"] += 1
            elif b <= 24: bars_buckets["13-24 bars (1d)"] += 1
            elif b <= 48: bars_buckets["25-48 bars (2d)"] += 1
            else:         bars_buckets["49+ bars (3+d)"] += 1
        for label, count in bars_buckets.most_common():
            print(f"  {label}: {count}")
        print()

    # ─── 3. State / stage at peak ───
    print("=" * 90)
    print("3. STATE + STAGE AT PEAK — what does the system see?")
    print("=" * 90)
    if wins:
        state_at_peak = Counter(r["state_at_peak"] for r in wins if r["state_at_peak"])
        stage_at_peak = Counter(r["stage_at_peak"] for r in wins if r["stage_at_peak"])
        print(f"  State at peak (top 5):")
        for s, c in state_at_peak.most_common(5):
            print(f"    {s}: {c}")
        print(f"  Stage at peak (top 5):")
        for s, c in stage_at_peak.most_common(5):
            print(f"    {s}: {c}")
        print()

    # ─── 4. Post-peak stage change ───
    print("=" * 90)
    print("4. POST-PEAK STAGE TRANSITION (the ideal exit signal)")
    print("=" * 90)
    if wins:
        post_change = Counter(r["post_peak_stage_change_to"] for r in wins if r["post_peak_stage_change_to"])
        print(f"  Stage transitioned to immediately after peak:")
        for s, c in post_change.most_common(8):
            print(f"    → {s}: {c}")
        print()

    # ─── 5. Worst capture trades ───
    print("=" * 90)
    print("5. WORST CAPTURE — biggest peak MFE wasted")
    print("=" * 90)
    worst = sorted(results, key=lambda r: -r["give_back_pct"])[:15]
    print(f"  {'ticker':<6} {'dir':<5} {'entry':<16} {'peak':>6} {'actual':>7} {'cap%':>5} {'minP→Ex':>7} stage_at_peak    exit_reason")
    for r in worst:
        eet = fmt_ts(r["entry_ts"])
        print(f"  {r['ticker']:<6} {r['direction']:<5} {eet} {r['peak_pnl']:>+5.2f}% {r['actual_pnl']:>+6.2f}% {r['capture_pct']:>4.0f}% {r['minutes_peak_to_exit']:>6}m  {str(r['stage_at_peak'])[:15]:<16} {(r['exit_reason'] or '?')[:30]}")

    # ─── 6. Output structured JSON for further drill-down ───
    out_path = f"data/trade-analysis/exit-forensic-{RUN_ID}.json"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump({"run_id": RUN_ID, "results": results}, f, indent=2, default=str)
    print(f"\nFull results: {out_path}")


if __name__ == "__main__":
    main()
