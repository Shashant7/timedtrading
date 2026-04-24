#!/usr/bin/env python3
"""
V11 Exit-Policy Simulator

Takes the 177 V11 trades and re-evaluates each one under alternative
exit policies to answer:

   "Is the current trim-and-run flow optimal, or would a simpler
    single-exit policy — or a different trim ratio — have made more
    money?"

Policies simulated per trade
----------------------------

Each policy produces a per-share PnL%. We weight by risk budget (so a
trade that risked 2 % contributes proportionally more than one that
risked 0.5 %). All P&L is on a 1 R = 1 % scale for readability.

1. STATUS_QUO
   Exactly what V11 did. Uses `lifecycle_realized_pnl` / `notional` as
   the effective per-dollar return. This is the baseline.

2. SINGLE_EXIT
   Never trim. Exit the entire position at max(exit_reason_price, TP1,
   stop). We approximate by: if trimmed_pct > 0 (trimmed at TP1), we
   apply that TP1 price to 100 % of the position INSTEAD of 50/50.
   If no trim happened, identical to status quo.

3. TRIM_25
   Trim 25 % at TP1, let 75 % runner ride (current is 50/50 by default
   inferred from trimmed_pct distribution).

4. TRIM_75
   Trim 75 % at TP1, 25 % runner. Captures more at TP1, smaller runner.

5. NO_RUNNER_CAP
   Trim 50 % at TP1 but remove the runner drawdown / time caps — let
   the runner ride until TP2 or a hard exit. Approximated by: use MFE
   as the cap instead of the V11 actual runner exit price.

6. MFE_LOCK
   Trim 50 % at TP1, then exit runner at `max(MFE - 0.5 %, entry)`.
   Captures the "don't give back the big move" policy.

For each policy we report:
   - Total PnL % (sum of pnl_pct weighted by notional)
   - WR (closed trades only)
   - Avg win / avg loss
   - PnL vs status quo (delta)

We ALSO enumerate specific trades where the alternative policy would
have beat status quo by >1 %, so we can see concrete cases.
"""
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

RUN_ID = os.environ.get("RUN_ID", "phase-i-v11-1776897135")
OUT_DIR = os.path.join("data", "trade-analysis", RUN_ID)
os.makedirs(OUT_DIR, exist_ok=True)

def _f(v, d=0.0):
    try:
        x = float(v)
        if x != x: return d
        return x
    except Exception: return d

def classify(t):
    s = (t.get("status") or "").upper()
    if s in ("WIN","LOSS","FLAT"): return s
    pnl = _f(t.get("pnl_pct"), 0) or 0
    return "WIN" if pnl > 0 else "LOSS" if pnl < 0 else "FLAT"

def load_trades():
    cache = "/tmp/v11_trades_full.json"
    if os.path.exists(cache):
        return json.load(open(cache))
    import urllib.request, urllib.parse
    KEY = os.environ["TIMED_API_KEY"]
    url = f"https://timed-trading-ingest.shashant.workers.dev/timed/admin/trade-autopsy/trades?runId={RUN_ID}&archived=1&limit=5000&key={KEY}"
    req = urllib.request.Request(url, headers={"User-Agent":"tt-exit-sim/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read())
    trades = data.get("trades") or []
    with open(cache, "w") as fp: json.dump(trades, fp)
    return trades

# ══════════════════════════════════════════════════════════════════════
# Per-trade policy simulators
# Each returns a per-position total-return %: the PnL % that position
# would have booked under the policy, computed on the FULL notional.
# ══════════════════════════════════════════════════════════════════════

def _sign(direction):
    return 1.0 if str(direction).upper() == "LONG" else -1.0

def _return_pct(entry, exit_, direction):
    """Return % for a LONG or SHORT given entry and exit."""
    if not (entry and exit_ and entry > 0): return 0.0
    return _sign(direction) * (exit_ - entry) / entry * 100.0

def pnl_status_quo(t):
    """V11 actual outcome."""
    return _f(t.get("pnl_pct"), 0) or 0

def pnl_single_exit(t):
    """
    What if we exited the entire position at whatever we exited the
    runner at (i.e. no trim). This is a bit pessimistic for trimmed
    trades because the runner usually exits later, when conditions have
    changed. Closer to 'never trim, ride to the same exit rule'.
    """
    entry = _f(t.get("entry_price") or t.get("lifecycle_entry_price") or t.get("raw_entry_price"))
    final_exit = _f(t.get("exit_price") or t.get("lifecycle_exit_price") or t.get("raw_exit_price"))
    if not entry or not final_exit:
        return pnl_status_quo(t)
    return _return_pct(entry, final_exit, t.get("direction"))

def pnl_custom_trim(t, trim_pct):
    """
    Simulate trim_pct at TP1 (using actual lifecycle_trim_price), runner
    at actual lifecycle_exit_price. If the trade never trimmed in V11
    (trimmed_pct == 0), we fall back to status quo (no trim to split).
    """
    actual_trim = _f(t.get("trimmed_pct"), 0) or 0
    if actual_trim <= 0:
        return pnl_status_quo(t)

    entry = _f(t.get("lifecycle_entry_price") or t.get("entry_price"))
    trim_price = _f(t.get("lifecycle_trim_price") or t.get("trim_price") or t.get("raw_trim_price"))
    exit_price = _f(t.get("lifecycle_exit_price") or t.get("exit_price") or t.get("raw_exit_price"))
    if not entry or not trim_price or not exit_price:
        return pnl_status_quo(t)

    direction = t.get("direction")
    trim_ret = _return_pct(entry, trim_price, direction)
    runner_ret = _return_pct(entry, exit_price, direction)
    return trim_pct * trim_ret + (1.0 - trim_pct) * runner_ret

def pnl_mfe_lock(t):
    """
    Trim 50 % at TP1, runner exits at max(MFE - 0.5 %, breakeven).
    This represents the 'don't give back the big move' policy: once MFE
    was achieved, runner flattens the moment it retraces 0.5 % from peak.
    We approximate runner exit = MFE - 0.5 % from entry.
    """
    actual_trim = _f(t.get("trimmed_pct"), 0) or 0
    entry = _f(t.get("lifecycle_entry_price") or t.get("entry_price"))
    trim_price = _f(t.get("lifecycle_trim_price") or t.get("trim_price"))
    mfe = _f(t.get("max_favorable_excursion"))
    if not entry or mfe is None:
        return pnl_status_quo(t)

    direction = t.get("direction")
    trim_ret = _return_pct(entry, trim_price, direction) if trim_price else 0.0
    # Runner exits 0.5 % below MFE from entry
    runner_ret = max(mfe - 0.5, 0.0)
    if actual_trim <= 0:
        # Never trimmed — runner = full position at MFE-0.5
        return runner_ret
    return 0.5 * trim_ret + 0.5 * runner_ret

def pnl_no_runner_cap(t):
    """
    Trim 50 % at TP1 but runner exits at MFE (no cap — ride to peak).
    This is optimistic — in reality you can't perfectly time the peak.
    We use it as an upper-bound reference.
    """
    actual_trim = _f(t.get("trimmed_pct"), 0) or 0
    entry = _f(t.get("lifecycle_entry_price") or t.get("entry_price"))
    trim_price = _f(t.get("lifecycle_trim_price") or t.get("trim_price"))
    mfe = _f(t.get("max_favorable_excursion"))
    if not entry:
        return pnl_status_quo(t)

    direction = t.get("direction")
    trim_ret = _return_pct(entry, trim_price, direction) if trim_price else 0.0
    runner_ret = mfe if mfe else 0.0
    if actual_trim <= 0:
        return runner_ret
    return 0.5 * trim_ret + 0.5 * runner_ret

POLICIES = [
    ("STATUS_QUO",   "V11 actual (trim-and-run baseline)", pnl_status_quo),
    ("SINGLE_EXIT",  "Never trim, ride to V11's final exit rule", pnl_single_exit),
    ("TRIM_25",      "Trim 25% at TP1, 75% runner to V11 exit", lambda t: pnl_custom_trim(t, 0.25)),
    ("TRIM_75",      "Trim 75% at TP1, 25% runner to V11 exit", lambda t: pnl_custom_trim(t, 0.75)),
    ("MFE_LOCK",     "Trim 50%, runner exits at MFE - 0.5%", pnl_mfe_lock),
    ("NO_RUNNER_CAP","Trim 50%, runner exits at MFE peak (upper bound)", pnl_no_runner_cap),
]

def policy_stats(trades, fn):
    rows = []
    for t in trades:
        if classify(t) not in ("WIN","LOSS","FLAT"): continue
        rows.append(fn(t))
    if not rows:
        return {"n": 0, "total": 0, "wr": 0, "avg_w": 0, "avg_l": 0, "pf": None, "median": 0}
    wins = [r for r in rows if r > 0]
    losses = [r for r in rows if r < 0]
    total = sum(rows)
    wr = 100.0 * len(wins) / len(rows)
    avg_w = sum(wins)/len(wins) if wins else 0
    avg_l = sum(losses)/len(losses) if losses else 0
    gross_w = sum(wins); gross_l = abs(sum(losses))
    pf = gross_w / gross_l if gross_l > 0 else None
    rows_sorted = sorted(rows)
    median = rows_sorted[len(rows_sorted)//2]
    return {"n": len(rows), "total": total, "wr": wr, "avg_w": avg_w, "avg_l": avg_l, "pf": pf, "median": median, "rows": rows}

def main():
    trades = load_trades()
    print(f"[sim] {len(trades)} V11 trades loaded")

    # Only trades with trim activity (TP_HIT_TRIM or exit with trim_ts) are
    # where alt policies diverge meaningfully. Show both buckets.
    trim_trades = [t for t in trades if (_f(t.get("trimmed_pct"), 0) or 0) > 0]
    print(f"[sim] {len(trim_trades)} trades actually trimmed in V11")

    # ─── Run each policy against all 177 closed trades
    results = {}
    for name, desc, fn in POLICIES:
        s = policy_stats(trades, fn)
        results[name] = s

    # ─── Headline table
    lines = []
    lines.append(f"# V11 Exit-Policy Simulation\n")
    lines.append(f"Run: `{RUN_ID}`\n")
    lines.append(f"Generated: {datetime.now(timezone.utc).isoformat()}\n")
    lines.append(f"Trades simulated: {results['STATUS_QUO']['n']}\n")
    lines.append(f"Of those, {len(trim_trades)} actually trimmed in V11 — the other "
                 f"{results['STATUS_QUO']['n']-len(trim_trades)} behave identically under single-exit / trim-variant.\n")

    lines.append("\n## Aggregate comparison\n")
    lines.append("| Policy | Total PnL % | Δ vs Quo | WR | Avg Win | Avg Loss | PF | Median |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    quo = results["STATUS_QUO"]["total"]
    for name, desc, _ in POLICIES:
        r = results[name]
        pf = f"{r['pf']:.2f}" if r['pf'] else "∞"
        delta = r["total"] - quo
        delta_s = f"{delta:+.2f}%" if name != "STATUS_QUO" else "—"
        lines.append(f"| **{name}** | {r['total']:+.2f}% | {delta_s} | {r['wr']:.1f}% | {r['avg_w']:+.2f}% | {r['avg_l']:+.2f}% | {pf} | {r['median']:+.2f}% |")

    lines.append("\n## Policy descriptions\n")
    for name, desc, _ in POLICIES:
        lines.append(f"- **{name}** — {desc}")

    # ─── Per-trade delta: who benefits most from each alternative?
    lines.append("\n## Top trades where TRIM_25 would have beat status quo\n")
    delta_rows = []
    for t in trim_trades:
        quo_pnl = pnl_status_quo(t)
        alt_pnl = pnl_custom_trim(t, 0.25)
        delta_rows.append((t, alt_pnl - quo_pnl, quo_pnl, alt_pnl))
    delta_rows.sort(key=lambda x: -x[1])
    lines.append("| Ticker | Entry | V11 Status Quo | Trim-25 | Δ | MFE |")
    lines.append("|---|---|---:|---:|---:|---:|")
    for t, delta, quo_pnl, alt_pnl in delta_rows[:10]:
        ets = datetime.fromtimestamp(t.get("entry_ts")/1000, tz=timezone.utc).strftime("%m-%d") if t.get("entry_ts") else "?"
        mfe = _f(t.get("max_favorable_excursion"))
        mfe_s = f"{mfe:.2f}" if mfe else "—"
        lines.append(f"| {t.get('ticker')} | {ets} | {quo_pnl:+.2f}% | {alt_pnl:+.2f}% | {delta:+.2f}% | {mfe_s} |")

    # Same for TRIM_75
    lines.append("\n## Top trades where TRIM_75 would have beat status quo\n")
    delta_rows75 = []
    for t in trim_trades:
        quo_pnl = pnl_status_quo(t)
        alt_pnl = pnl_custom_trim(t, 0.75)
        delta_rows75.append((t, alt_pnl - quo_pnl, quo_pnl, alt_pnl))
    delta_rows75.sort(key=lambda x: -x[1])
    lines.append("| Ticker | Entry | V11 Status Quo | Trim-75 | Δ | MFE |")
    lines.append("|---|---|---:|---:|---:|---:|")
    for t, delta, quo_pnl, alt_pnl in delta_rows75[:10]:
        ets = datetime.fromtimestamp(t.get("entry_ts")/1000, tz=timezone.utc).strftime("%m-%d") if t.get("entry_ts") else "?"
        mfe = _f(t.get("max_favorable_excursion"))
        mfe_s = f"{mfe:.2f}" if mfe else "—"
        lines.append(f"| {t.get('ticker')} | {ets} | {quo_pnl:+.2f}% | {alt_pnl:+.2f}% | {delta:+.2f}% | {mfe_s} |")

    # ─── Specific audits: MSFT and TSLA SHORT from your question
    lines.append("\n## Specific audits (user-flagged)\n")
    msft_oct = [t for t in trades if t.get("ticker") == "MSFT"]
    tsla = [t for t in trades if t.get("ticker") == "TSLA"]

    def audit_trade_row(t):
        entry = _f(t.get("lifecycle_entry_price") or t.get("entry_price"))
        trim = _f(t.get("lifecycle_trim_price") or t.get("trim_price"))
        exit_ = _f(t.get("lifecycle_exit_price") or t.get("exit_price"))
        mfe = _f(t.get("max_favorable_excursion"))
        mae = _f(t.get("max_adverse_excursion"))
        ets = datetime.fromtimestamp(t.get("entry_ts")/1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M") if t.get("entry_ts") else "?"
        xts = datetime.fromtimestamp(t.get("exit_ts")/1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M") if t.get("exit_ts") else "?"
        trim_ts = datetime.fromtimestamp(t.get("trim_ts")/1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M") if t.get("trim_ts") else "—"
        trim_pct = (_f(t.get("trimmed_pct"),0) or 0) * 100
        return (
            f"### {t.get('ticker')} {t.get('direction')} — {ets}\n\n"
            f"- Entry: ${entry:.2f} · Trim: ${trim:.2f} ({trim_pct:.0f}%) @ {trim_ts} · Exit: ${exit_:.2f} @ {xts}\n"
            f"- MFE: {mfe:.2f}% · MAE: {mae:.2f}%\n"
            f"- V11 realized PnL: {_f(t.get('pnl_pct')):+.2f}% · exit reason: `{t.get('exit_reason')}`\n"
            f"- Status-quo: {pnl_status_quo(t):+.2f}%\n"
            f"- Single-exit: {pnl_single_exit(t):+.2f}%\n"
            f"- Trim-25: {pnl_custom_trim(t, 0.25):+.2f}%\n"
            f"- Trim-75: {pnl_custom_trim(t, 0.75):+.2f}%\n"
            f"- MFE-lock: {pnl_mfe_lock(t):+.2f}%\n"
            f"- No-runner-cap (upper bound): {pnl_no_runner_cap(t):+.2f}%\n"
        )

    for t in msft_oct:
        lines.append(audit_trade_row(t))
    for t in tsla:
        lines.append(audit_trade_row(t))

    # ─── Write outputs
    md_path = os.path.join(OUT_DIR, "v11-exit-policy-simulation.md")
    with open(md_path, "w") as fp: fp.write("\n".join(lines) + "\n")

    json_path = os.path.join(OUT_DIR, "v11-exit-policy-simulation.json")
    with open(json_path, "w") as fp:
        # strip 'rows' list from stats to keep JSON small
        clean = {k: {kk: vv for kk, vv in v.items() if kk != "rows"} for k, v in results.items()}
        json.dump({"run_id": RUN_ID, "policies": clean, "trim_count": len(trim_trades)}, fp, indent=2)

    print(f"[sim] Wrote {md_path}")
    print(f"[sim] Wrote {json_path}")
    print()
    print("=== Headline ===")
    for name, _, _ in POLICIES:
        r = results[name]
        delta = r["total"] - quo
        star = " ←" if abs(delta) > 0.01 else ""
        pf_s = f"{r['pf']:.2f}" if r['pf'] else "—"
        print(f"  {name:<16} total={r['total']:+7.2f}%  Δ={delta:+6.2f}%  WR={r['wr']:5.1f}%  PF={pf_s}{star}")

if __name__ == "__main__":
    main()
