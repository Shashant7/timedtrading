#!/usr/bin/env python3
"""
Engine Selection Rules Generator.
Analyzes cross-engine MFE by direction, month, sector, and signal patterns
to build a dynamic engine selection rules config.
"""

import json, os, sys, subprocess
from collections import defaultdict

ARTIFACTS = os.path.join(os.path.dirname(__file__), "..", "data", "backtest-artifacts")

RUNS = {
    "ripster_core": "10m-ltf-validation--2026-03-20T0108",
    "legacy":       "legacy-baseline--2026-03-20T0156",
    "tt_core":      "tt-core-context-v1--2026-03-20T0205",
}

# Load SECTOR_MAP via Node.js
def load_sector_map():
    result = subprocess.run(
        ["node", "-e",
         "import { SECTOR_MAP } from './worker/sector-mapping.js'; "
         "console.log(JSON.stringify(SECTOR_MAP));"],
        capture_output=True, text=True,
        cwd=os.path.join(os.path.dirname(__file__), "..")
    )
    return json.loads(result.stdout.strip())

SECTOR_MAP = load_sector_map()

def load_trades(run_dir):
    with open(os.path.join(ARTIFACTS, run_dir, "trades.json")) as f:
        return json.load(f)

def load_autopsy(run_dir):
    path = os.path.join(ARTIFACTS, run_dir, "trade-autopsy-signals.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return []

def pct(n, d):
    return round(n / d * 100, 1) if d else 0

def avg(vals):
    return round(sum(vals) / len(vals), 2) if vals else 0

def wr(trades):
    w = sum(1 for t in trades if t["status"] == "WIN")
    l = sum(1 for t in trades if t["status"] == "LOSS")
    return pct(w, w + l) if (w + l) > 0 else 0

def analyze_dimension(all_engine_trades, dimension_fn, dim_name):
    """Analyze which engine wins per dimension value."""
    results = {}
    all_keys = set()
    for engine, trades in all_engine_trades.items():
        for t in trades:
            k = dimension_fn(t)
            if k: all_keys.add(k)

    for key in sorted(all_keys):
        row = {}
        for engine, trades in all_engine_trades.items():
            subset = [t for t in trades if dimension_fn(t) == key]
            if not subset:
                row[engine] = {"trades": 0, "wr": 0, "avg_mfe": 0, "pnl": 0}
                continue
            row[engine] = {
                "trades": len(subset),
                "wr": wr(subset),
                "avg_mfe": avg([t["mfe_pct"] for t in subset]),
                "pnl": round(sum(t["pnl"] for t in subset)),
                "gave_back": sum(1 for t in subset if t["mfe_pct"] >= 2 and t["status"] == "LOSS"),
            }
        # Determine best engine for this dimension (by WR, min 10 trades)
        candidates = {e: d for e, d in row.items() if d["trades"] >= 10}
        if candidates:
            best = max(candidates, key=lambda e: candidates[e]["wr"])
        else:
            candidates = {e: d for e, d in row.items() if d["trades"] >= 3}
            best = max(candidates, key=lambda e: candidates[e]["wr"]) if candidates else None
        results[key] = {"by_engine": row, "best": best, "best_wr": row[best]["wr"] if best else 0}

    return results

def derive_regime_from_month(month):
    """Approximate market regime from month. (From backtest data patterns.)"""
    regime_map = {
        "2025-07": "TRENDING_BULL",
        "2025-08": "VOLATILE_MIXED",
        "2025-09": "TRENDING_BULL",
        "2025-10": "CHOPPY_MIXED",
        "2025-11": "CHOPPY_BEAR",
        "2025-12": "RANGE_BOUND",
        "2026-01": "VOLATILE_BULL",
        "2026-02": "VOLATILE_MIXED",
    }
    return regime_map.get(month, "UNKNOWN")


def main():
    print("=" * 80)
    print("  ENGINE SELECTION RULES ANALYSIS")
    print("=" * 80)

    # Load all trades (excluding March force-close artifacts)
    all_trades = {}
    for engine, run_dir in RUNS.items():
        trades = load_trades(run_dir)
        all_trades[engine] = [t for t in trades if t["entry_date"] < "2026-03"]
        print(f"  {engine}: {len(all_trades[engine])} trades (excl March)")

    # ── BY DIRECTION ──
    print("\n━" * 80)
    print("  BY DIRECTION")
    print("━" * 80)
    dir_results = analyze_dimension(all_trades, lambda t: t["direction"], "Direction")
    for key, data in dir_results.items():
        print(f"\n  {key}: → Best = {data['best']} ({data['best_wr']}% WR)")
        for eng, d in data["by_engine"].items():
            print(f"    {eng:>15}: {d['trades']:>4} trades, {d['wr']:>5}% WR, ${d['pnl']:>8}, MFE={d['avg_mfe']:.1f}%, GB={d.get('gave_back', 0)}")

    # ── BY MONTH (regime proxy) ──
    print("\n━" * 80)
    print("  BY MONTH / REGIME")
    print("━" * 80)
    month_results = analyze_dimension(all_trades, lambda t: t["entry_date"][:7], "Month")
    for month, data in month_results.items():
        regime = derive_regime_from_month(month)
        print(f"\n  {month} ({regime}): → Best = {data['best']} ({data['best_wr']}% WR)")
        for eng, d in data["by_engine"].items():
            print(f"    {eng:>15}: {d['trades']:>4} trades, {d['wr']:>5}% WR, ${d['pnl']:>8}, MFE={d['avg_mfe']:.1f}%")

    # ── BY SECTOR ──
    print("\n━" * 80)
    print("  BY SECTOR")
    print("━" * 80)
    sector_fn = lambda t: SECTOR_MAP.get(t["ticker"], "Unknown")
    sector_results = analyze_dimension(all_trades, sector_fn, "Sector")
    for sector, data in sorted(sector_results.items(), key=lambda x: -x[1]["best_wr"]):
        if data["best"]:
            print(f"\n  {sector}: → Best = {data['best']} ({data['best_wr']}% WR)")
            for eng, d in data["by_engine"].items():
                if d["trades"] > 0:
                    print(f"    {eng:>15}: {d['trades']:>4} trades, {d['wr']:>5}% WR, ${d['pnl']:>8}")

    # ── BY DIRECTION + MONTH ──
    print("\n━" * 80)
    print("  BY DIRECTION + MONTH")
    print("━" * 80)
    dim_fn = lambda t: f"{t['direction']}-{t['entry_date'][:7]}"
    combo_results = analyze_dimension(all_trades, dim_fn, "Dir+Month")
    for key, data in sorted(combo_results.items()):
        if data["best"]:
            best_d = data["by_engine"][data["best"]]
            if best_d["trades"] >= 5:
                print(f"  {key:<18} → {data['best']:>15} ({data['best_wr']:>5}% WR, {best_d['trades']:>3} trades)")

    # ── BUILD DYNAMIC ENGINE RULES ──
    print("\n" + "=" * 80)
    print("  DYNAMIC ENGINE SELECTION RULES")
    print("=" * 80)

    rules = {
        "_description": "Dynamic engine selection rules derived from 3-way backtest Jul-Feb 2026",
        "_generated_from": list(RUNS.values()),
        "default_engine": "ripster_core",
        "rules": []
    }

    # Rule 1: Direction-based
    for direction, data in dir_results.items():
        if data["best"] and data["best"] != rules["default_engine"]:
            rules["rules"].append({
                "condition": {"direction": direction},
                "engine": data["best"],
                "wr": data["best_wr"],
                "note": f"{direction} performs best with {data['best']}"
            })

    # Rule 2: Month/Regime-based overrides
    for month, data in month_results.items():
        if not data["best"]: continue
        regime = derive_regime_from_month(month)
        best = data["best"]
        best_d = data["by_engine"][best]
        if best_d["trades"] >= 15 and best != rules["default_engine"]:
            rules["rules"].append({
                "condition": {"regime": regime, "month_example": month},
                "engine": best,
                "wr": data["best_wr"],
                "note": f"{regime} regime: {best} had {data['best_wr']}% WR ({best_d['trades']} trades)"
            })

    # Rule 3: Sector-specific overrides with high confidence
    for sector, data in sector_results.items():
        if not data["best"]: continue
        best = data["best"]
        best_d = data["by_engine"][best]
        if best_d["trades"] >= 15 and best_d["wr"] >= 45 and best != rules["default_engine"]:
            rules["rules"].append({
                "condition": {"sector": sector},
                "engine": best,
                "wr": data["best_wr"],
                "note": f"{sector}: {best} had {data['best_wr']}% WR ({best_d['trades']} trades)"
            })

    # Rule 4: SHORT direction always gets stricter gating
    rules["rules"].append({
        "condition": {"direction": "SHORT"},
        "config_overrides": {
            "deep_audit_danger_max_signals": 2,
            "tt_spy_directional_gate": "true",
            "doa_gate_enabled": "true",
        },
        "note": "SHORTs need stricter gating across all engines (28-35% WR)"
    })

    # Rule 5: 12-24h hold DOA tightening
    rules["exit_overrides"] = {
        "deep_audit_stall_max_hours": 12,
        "deep_audit_mfe_safety_trim_pct": 2.0,
        "deep_audit_max_runner_drawdown_pct": 2.5,
        "note": "12-24h holds at 10-18% WR across all engines → tighten DOA to 12h"
    }

    # Print summary
    for r in rules["rules"]:
        eng = r.get("engine", "config_only")
        cond = r.get("condition", {})
        note = r.get("note", "")
        print(f"  IF {cond} → {eng}: {note}")

    if rules.get("exit_overrides"):
        print(f"  EXIT: {rules['exit_overrides']['note']}")

    # Save
    output_path = os.path.join(os.path.dirname(__file__), "..", "configs", "dynamic-engine-rules.json")
    with open(output_path, "w") as f:
        json.dump(rules, f, indent=2)
    print(f"\n  Saved: {output_path}")

    # ── SIGNAL-AT-PEAK DISTRIBUTION ANALYSIS ──
    print("\n" + "=" * 80)
    print("  SIGNAL-AT-PEAK DISTRIBUTION (for exit threshold tuning)")
    print("=" * 80)

    for engine, run_dir in RUNS.items():
        autopsy = load_autopsy(run_dir)
        if not autopsy: continue
        valid = [a for a in autopsy if a.get("signals_at_peak") and not a.get("error")]
        if not valid: continue

        print(f"\n  {engine} ({len(valid)} trades with signals):")

        # RSI at peak distribution
        rsi_1h_vals = [a["signals_at_peak"]["rsi_1H"] for a in valid if a["signals_at_peak"].get("rsi_1H") is not None]
        if rsi_1h_vals:
            longs_rsi = [a["signals_at_peak"]["rsi_1H"] for a in valid
                         if a["direction"] == "LONG" and a["signals_at_peak"].get("rsi_1H") is not None]
            shorts_rsi = [a["signals_at_peak"]["rsi_1H"] for a in valid
                          if a["direction"] == "SHORT" and a["signals_at_peak"].get("rsi_1H") is not None]
            if longs_rsi:
                print(f"    RSI 1H at peak (LONG): avg={avg(longs_rsi)}, p75={sorted(longs_rsi)[int(len(longs_rsi)*0.75)]}, p90={sorted(longs_rsi)[int(len(longs_rsi)*0.9)]}")
            if shorts_rsi:
                print(f"    RSI 1H at peak (SHORT): avg={avg(shorts_rsi)}, p25={sorted(shorts_rsi)[int(len(shorts_rsi)*0.25)]}, p10={sorted(shorts_rsi)[int(len(shorts_rsi)*0.1)]}")

        # Phase at peak
        phase_vals = [a["signals_at_peak"]["phase_osc_1H"] for a in valid if a["signals_at_peak"].get("phase_osc_1H") is not None]
        if phase_vals:
            long_phase = [a["signals_at_peak"]["phase_osc_1H"] for a in valid
                          if a["direction"] == "LONG" and a["signals_at_peak"].get("phase_osc_1H") is not None]
            if long_phase:
                print(f"    Phase Osc 1H at peak (LONG): avg={avg(long_phase)}, p75={sorted(long_phase)[int(len(long_phase)*0.75)]}, p90={sorted(long_phase)[int(len(long_phase)*0.9)]}")

        # Hours to peak
        peak_hours = [a["hours_to_peak"] for a in valid if a.get("hours_to_peak")]
        if peak_hours:
            s = sorted(peak_hours)
            print(f"    Hours to peak: avg={avg(peak_hours)}, p25={s[int(len(s)*0.25)]}, p50={s[int(len(s)*0.5)]}, p75={s[int(len(s)*0.75)]}")

        # Gave-back trades: what signals were present?
        gb = [a for a in valid if a["status"] == "LOSS" and a["mfe_pct"] >= 2]
        if gb:
            print(f"    Gave-back ({len(gb)} trades):")
            gb_rsi = [a["signals_at_peak"]["rsi_1H"] for a in gb if a["signals_at_peak"].get("rsi_1H") is not None]
            if gb_rsi:
                print(f"      RSI 1H at peak: avg={avg(gb_rsi)}")
            gb_phase = [a["signals_at_peak"]["phase_osc_1H"] for a in gb if a["signals_at_peak"].get("phase_osc_1H") is not None]
            if gb_phase:
                print(f"      Phase Osc 1H at peak: avg={avg(gb_phase)}")
            gb_mfe = [a["mfe_pct"] for a in gb]
            print(f"      Avg MFE: {avg(gb_mfe)}%, Avg hours to peak: {avg([a['hours_to_peak'] for a in gb if a.get('hours_to_peak')])}h")


if __name__ == "__main__":
    main()
