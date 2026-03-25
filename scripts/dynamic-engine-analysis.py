#!/usr/bin/env python3
"""
Dynamic Engine Analysis — Phase 1c Deepened

Loads all trades from 3 local backtests, enriches each with sector + regime,
then analyzes per (engine x direction x sector x regime x entry_path x ticker)
to identify sweet spots, dead zones, franchise tickers, and blacklist tickers.

Outputs configs/dynamic-engine-rules-v2.json for runtime engine selection.
"""

import json
import os
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ── Load sector map ──────────────────────────────────────────────────────────
with open(ROOT / "configs" / "sector-map.json") as f:
    sector_data = json.load(f)
SECTOR_MAP = sector_data["SECTOR_MAP"]

# ── Load VIX daily candles from local DB ──────────────────────────────────────
DB_PATH = ROOT / "data" / "timed-local.db"
conn = sqlite3.connect(str(DB_PATH))
conn.row_factory = sqlite3.Row

vix_candles = conn.execute(
    "SELECT ts, c FROM ticker_candles WHERE ticker='VIX' AND tf='D' ORDER BY ts ASC"
).fetchall()
vix_by_date = {}
for row in vix_candles:
    ts_ms = row["ts"]
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    date_key = dt.strftime("%Y-%m-%d")
    vix_by_date[date_key] = float(row["c"])

spy_candles = conn.execute(
    "SELECT ts, c, o FROM ticker_candles WHERE ticker='SPY' AND tf='D' ORDER BY ts ASC"
).fetchall()
spy_by_date = {}
for row in spy_candles:
    ts_ms = row["ts"]
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    date_key = dt.strftime("%Y-%m-%d")
    spy_by_date[date_key] = {"close": float(row["c"]), "open": float(row["o"])}
conn.close()


def get_vix_for_date(entry_date: str) -> float | None:
    """Find VIX close for the given date or the most recent prior date."""
    if entry_date in vix_by_date:
        return vix_by_date[entry_date]
    dates = sorted(vix_by_date.keys())
    for d in reversed(dates):
        if d <= entry_date:
            return vix_by_date[d]
    return None


def classify_vix_regime(vix: float | None) -> str:
    if vix is None:
        return "unknown"
    if vix < 15:
        return "low_vol"
    if vix < 20:
        return "normal"
    if vix < 25:
        return "elevated"
    if vix < 30:
        return "high_vol"
    return "extreme"


def get_spy_trend(entry_date: str) -> str:
    """Determine SPY trend at entry date using 10-day rolling close."""
    dates = sorted(spy_by_date.keys())
    idx = None
    for i, d in enumerate(dates):
        if d <= entry_date:
            idx = i
    if idx is None or idx < 10:
        return "unknown"
    closes = [spy_by_date[dates[j]]["close"] for j in range(idx - 9, idx + 1)]
    sma10 = sum(closes) / len(closes)
    current = closes[-1]
    if current > sma10 * 1.005:
        return "uptrend"
    elif current < sma10 * 0.995:
        return "downtrend"
    return "sideways"


def classify_regime(entry_date: str) -> str:
    """Combine VIX level + SPY trend into a regime class."""
    vix = get_vix_for_date(entry_date)
    vix_regime = classify_vix_regime(vix)
    spy_trend = get_spy_trend(entry_date)
    if vix_regime in ("high_vol", "extreme"):
        return "crisis"
    if spy_trend == "uptrend" and vix_regime in ("low_vol", "normal"):
        return "bull_calm"
    if spy_trend == "uptrend":
        return "bull_elevated"
    if spy_trend == "downtrend" and vix_regime in ("low_vol", "normal"):
        return "bear_calm"
    if spy_trend == "downtrend":
        return "bear_elevated"
    if spy_trend == "sideways":
        return "choppy"
    return "unknown"


# ── Load trades from 3 backtests ──────────────────────────────────────────────
RUNS = [
    {
        "dir": "10m-ltf-validation--2026-03-20T0108",
        "engine": "ripster_core",
        "label": "A_ripster",
    },
    {
        "dir": "legacy-baseline--2026-03-20T0156",
        "engine": "legacy",
        "label": "B_legacy",
    },
    {
        "dir": "tt-core-context-v1--2026-03-20T0205",
        "engine": "tt_core",
        "label": "C_tt_core",
    },
]

all_trades = []
for run in RUNS:
    trades_path = ROOT / "data" / "backtest-artifacts" / run["dir"] / "trades.json"
    with open(trades_path) as f:
        trades = json.load(f)
    for t in trades:
        entry_date = t.get("entry_date", "")
        ticker = t.get("ticker", "")
        sector = SECTOR_MAP.get(ticker, "Unknown")
        regime = classify_regime(entry_date)
        vix = get_vix_for_date(entry_date)

        all_trades.append({
            "engine": run["engine"],
            "label": run["label"],
            "ticker": ticker,
            "sector": sector,
            "direction": t.get("direction", "LONG"),
            "path": t.get("path", "unknown"),
            "entry_date": entry_date,
            "regime": regime,
            "vix": vix,
            "mfe_pct": float(t.get("mfe_pct", 0)),
            "mae_pct": float(t.get("mae_pct", 0)),
            "pnl": float(t.get("pnl", 0)),
            "pnl_pct": float(t.get("pnl_pct", 0)),
            "confidence": float(t.get("confidence", 0)),
            "hold_hours": float(t.get("hold_hours", 0)),
            "status": t.get("status", ""),
            "exit_reason": t.get("exit_reason", ""),
        })

print(f"[DATA] Loaded {len(all_trades)} trades across 3 engines")
for run in RUNS:
    count = sum(1 for t in all_trades if t["engine"] == run["engine"])
    wins = sum(1 for t in all_trades if t["engine"] == run["engine"] and t["status"] == "WIN")
    wr = wins / count * 100 if count > 0 else 0
    print(f"  {run['label']}: {count} trades, WR={wr:.1f}%")


# ── Analysis functions ────────────────────────────────────────────────────────
def analyze_group(trades: list[dict]) -> dict | None:
    if not trades:
        return None
    n = len(trades)
    wins = sum(1 for t in trades if t["status"] == "WIN")
    losses = sum(1 for t in trades if t["status"] == "LOSS")
    wr = wins / n * 100 if n > 0 else 0
    avg_mfe = sum(t["mfe_pct"] for t in trades) / n
    avg_mae = sum(abs(t["mae_pct"]) for t in trades) / n
    mfe_mae_ratio = avg_mfe / avg_mae if avg_mae > 0.01 else float("inf")
    avg_pnl = sum(t["pnl_pct"] for t in trades) / n
    avg_hold = sum(t["hold_hours"] for t in trades) / n
    total_pnl = sum(t["pnl"] for t in trades)

    return {
        "count": n,
        "wins": wins,
        "losses": losses,
        "wr": round(wr, 1),
        "avg_mfe": round(avg_mfe, 2),
        "avg_mae": round(avg_mae, 2),
        "mfe_mae_ratio": round(mfe_mae_ratio, 2),
        "avg_pnl_pct": round(avg_pnl, 2),
        "avg_hold_hours": round(avg_hold, 1),
        "total_pnl": round(total_pnl, 2),
    }


# ── Grouping analysis ────────────────────────────────────────────────────────
def group_trades(trades, *keys):
    """Group trades by multiple keys, return dict of key_tuple -> [trades]."""
    groups = defaultdict(list)
    for t in trades:
        key = tuple(t[k] for k in keys)
        groups[key].append(t)
    return groups


# 1. Engine x Direction x Regime
print("\n" + "=" * 80)
print("ENGINE x DIRECTION x REGIME ANALYSIS")
print("=" * 80)

sweet_spots = []
dead_zones = []
MIN_COUNT = 5

groups = group_trades(all_trades, "engine", "direction", "regime")
for key, trades in sorted(groups.items(), key=lambda x: -len(x[1])):
    stats = analyze_group(trades)
    if not stats or stats["count"] < MIN_COUNT:
        continue
    engine, direction, regime = key
    label = f"{engine} | {direction} | {regime}"
    is_sweet = stats["wr"] >= 45 and stats["mfe_mae_ratio"] >= 2.0
    is_dead = stats["wr"] < 35 or stats["mfe_mae_ratio"] < 1.0
    marker = " ★ SWEET" if is_sweet else " ✗ DEAD" if is_dead else ""
    print(f"  {label:50s} n={stats['count']:4d} WR={stats['wr']:5.1f}% "
          f"MFE={stats['avg_mfe']:5.2f} MAE={stats['avg_mae']:5.2f} "
          f"ratio={stats['mfe_mae_ratio']:5.2f} PnL={stats['avg_pnl_pct']:+6.2f}%{marker}")
    record = {"engine": engine, "direction": direction, "regime": regime, **stats}
    if is_sweet:
        sweet_spots.append(record)
    if is_dead:
        dead_zones.append(record)

# 2. Engine x Direction x Sector
print("\n" + "=" * 80)
print("ENGINE x DIRECTION x SECTOR ANALYSIS (top combos)")
print("=" * 80)

sector_sweet = []
sector_dead = []
groups = group_trades(all_trades, "engine", "direction", "sector")
for key, trades in sorted(groups.items(), key=lambda x: -len(x[1])):
    stats = analyze_group(trades)
    if not stats or stats["count"] < MIN_COUNT:
        continue
    engine, direction, sector = key
    label = f"{engine} | {direction} | {sector}"
    is_sweet = stats["wr"] >= 45 and stats["mfe_mae_ratio"] >= 2.0
    is_dead = stats["wr"] < 35 or stats["mfe_mae_ratio"] < 1.0
    marker = " ★ SWEET" if is_sweet else " ✗ DEAD" if is_dead else ""
    print(f"  {label:60s} n={stats['count']:4d} WR={stats['wr']:5.1f}% "
          f"ratio={stats['mfe_mae_ratio']:5.2f} PnL={stats['avg_pnl_pct']:+6.2f}%{marker}")
    record = {"engine": engine, "direction": direction, "sector": sector, **stats}
    if is_sweet:
        sector_sweet.append(record)
    if is_dead:
        sector_dead.append(record)

# 3. Franchise tickers (consistently high MFE across engines/regimes)
print("\n" + "=" * 80)
print("FRANCHISE TICKERS (high MFE, WR>=45% across engines)")
print("=" * 80)

ticker_stats = defaultdict(list)
for t in all_trades:
    ticker_stats[t["ticker"]].append(t)

franchise_tickers = []
blacklist_tickers = []
for ticker, trades in sorted(ticker_stats.items()):
    stats = analyze_group(trades)
    if not stats or stats["count"] < 5:
        continue
    engines_seen = set(t["engine"] for t in trades)
    is_franchise = stats["wr"] >= 45 and stats["avg_mfe"] >= 2.0 and len(engines_seen) >= 2
    # Keep the runtime deny-list very small. It should only contain names with
    # enough sample size plus consistently poor follow-through / expectancy, not
    # every merely "subpar" ticker from a coarse 3-run comparison.
    is_blacklist = (
        stats["count"] >= 10 and
        stats["avg_mfe"] < 0.75 and
        (stats["wr"] < 20 or stats["avg_pnl_pct"] < -0.25)
    )
    marker = " ★ FRANCHISE" if is_franchise else " ✗ BLACKLIST" if is_blacklist else ""
    if is_franchise or is_blacklist or stats["count"] >= 10:
        sector = SECTOR_MAP.get(ticker, "Unknown")
        print(f"  {ticker:8s} ({sector:25s}) n={stats['count']:4d} WR={stats['wr']:5.1f}% "
              f"MFE={stats['avg_mfe']:5.2f} MAE={stats['avg_mae']:5.2f} "
              f"ratio={stats['mfe_mae_ratio']:5.2f}{marker}")
    if is_franchise:
        franchise_tickers.append(ticker)
    if is_blacklist:
        blacklist_tickers.append(ticker)

# 4. Best engine per regime+direction+sector
print("\n" + "=" * 80)
print("BEST ENGINE PER (REGIME x DIRECTION x SECTOR)")
print("=" * 80)

best_engine_rules = []
combos = group_trades(all_trades, "regime", "direction", "sector")
for (regime, direction, sector), trades in sorted(combos.items()):
    if len(trades) < 5:
        continue
    engine_perf = {}
    for engine in ["ripster_core", "legacy", "tt_core"]:
        engine_trades = [t for t in trades if t["engine"] == engine]
        if len(engine_trades) >= 3:
            engine_perf[engine] = analyze_group(engine_trades)

    if not engine_perf:
        continue

    # Score: combine WR, MFE/MAE ratio, and avg PnL
    def score_engine(stats):
        return (stats["wr"] / 100) * 0.4 + min(stats["mfe_mae_ratio"] / 5, 1.0) * 0.3 + \
               max(min(stats["avg_pnl_pct"] / 5, 1.0), -1.0) * 0.3

    best = max(engine_perf.items(), key=lambda x: score_engine(x[1]))
    best_engine, best_stats = best
    score = score_engine(best_stats)
    print(f"  {regime:15s} {direction:6s} {sector:25s} → {best_engine:15s} "
          f"(n={best_stats['count']}, WR={best_stats['wr']:.1f}%, "
          f"ratio={best_stats['mfe_mae_ratio']:.2f}, score={score:.3f})")
    best_engine_rules.append({
        "regime": regime,
        "direction": direction,
        "sector": sector,
        "engine": best_engine,
        "score": round(score, 3),
        **best_stats,
    })

# 5. Entry path analysis across engines
print("\n" + "=" * 80)
print("ENTRY PATH PERFORMANCE (across all engines)")
print("=" * 80)

path_groups = group_trades(all_trades, "path")
path_rankings = []
for key, trades in sorted(path_groups.items(), key=lambda x: -len(x[1])):
    stats = analyze_group(trades)
    if not stats or stats["count"] < 5:
        continue
    path_name = key[0] if isinstance(key, tuple) else key
    marker = " ★" if stats["wr"] >= 45 and stats["mfe_mae_ratio"] >= 2.0 else ""
    print(f"  {path_name:40s} n={stats['count']:4d} WR={stats['wr']:5.1f}% "
          f"MFE={stats['avg_mfe']:5.2f} MAE={stats['avg_mae']:5.2f} "
          f"ratio={stats['mfe_mae_ratio']:5.2f} PnL={stats['avg_pnl_pct']:+6.2f}%{marker}")
    path_rankings.append({"path": path_name, **stats})


# ── Build dynamic-engine-rules-v2.json ────────────────────────────────────────
print("\n" + "=" * 80)
print("GENERATING configs/dynamic-engine-rules-v2.json")
print("=" * 80)

rules_v2 = {
    "_meta": {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_trades_analyzed": len(all_trades),
        "engines": ["ripster_core", "legacy", "tt_core"],
        "backtests": [r["dir"] for r in RUNS],
    },
    "default_engine": "ripster_core",
    "regime_direction_sector_rules": [],
    "franchise_tickers": franchise_tickers,
    "blacklist_tickers": blacklist_tickers,
    "sweet_spots": [],
    "dead_zones": [],
    "path_rankings": sorted(path_rankings, key=lambda x: -x.get("mfe_mae_ratio", 0)),
}

# Build regime+direction+sector rules (only include combos with score > 0.3)
for rule in sorted(best_engine_rules, key=lambda x: -x["score"]):
    if rule["score"] < 0.3:
        continue
    rules_v2["regime_direction_sector_rules"].append({
        "regime": rule["regime"],
        "direction": rule["direction"],
        "sector": rule["sector"],
        "engine": rule["engine"],
        "score": rule["score"],
        "sample_size": rule["count"],
        "wr": rule["wr"],
        "mfe_mae_ratio": rule["mfe_mae_ratio"],
    })

# Add sweet spots with their config overrides
for spot in sweet_spots:
    rules_v2["sweet_spots"].append({
        "engine": spot["engine"],
        "direction": spot["direction"],
        "regime": spot["regime"],
        "wr": spot["wr"],
        "mfe_mae_ratio": spot["mfe_mae_ratio"],
        "sample_size": spot["count"],
        "config_overrides": {},
    })

# Add dead zones (should be avoided or use different engine)
for dz in dead_zones:
    rules_v2["dead_zones"].append({
        "engine": dz["engine"],
        "direction": dz["direction"],
        "regime": dz["regime"],
        "wr": dz["wr"],
        "mfe_mae_ratio": dz["mfe_mae_ratio"],
        "sample_size": dz["count"],
    })

out_path = ROOT / "configs" / "dynamic-engine-rules-v2.json"
with open(out_path, "w") as f:
    json.dump(rules_v2, f, indent=2)

print(f"\nWritten to {out_path}")
print(f"  {len(rules_v2['regime_direction_sector_rules'])} engine selection rules")
print(f"  {len(rules_v2['sweet_spots'])} sweet spots")
print(f"  {len(rules_v2['dead_zones'])} dead zones")
print(f"  {len(rules_v2['franchise_tickers'])} franchise tickers")
print(f"  {len(rules_v2['blacklist_tickers'])} blacklist tickers")
print(f"  {len(rules_v2['path_rankings'])} entry path rankings")

# Summary stats
print("\n" + "=" * 80)
print("SUMMARY")
print("=" * 80)

regime_counts = defaultdict(int)
for t in all_trades:
    regime_counts[t["regime"]] += 1
print("\nRegime distribution:")
for regime, count in sorted(regime_counts.items(), key=lambda x: -x[1]):
    pct = count / len(all_trades) * 100
    print(f"  {regime:20s}: {count:4d} ({pct:5.1f}%)")

direction_counts = defaultdict(int)
for t in all_trades:
    direction_counts[t["direction"]] += 1
print("\nDirection distribution:")
for direction, count in sorted(direction_counts.items(), key=lambda x: -x[1]):
    pct = count / len(all_trades) * 100
    print(f"  {direction:10s}: {count:4d} ({pct:5.1f}%)")

print(f"\nBest overall engine by composite score:")
for engine in ["ripster_core", "legacy", "tt_core"]:
    etrades = [t for t in all_trades if t["engine"] == engine]
    stats = analyze_group(etrades)
    if stats:
        print(f"  {engine:15s}: n={stats['count']:4d} WR={stats['wr']:5.1f}% "
              f"MFE/MAE={stats['mfe_mae_ratio']:5.2f} avg_PnL={stats['avg_pnl_pct']:+6.2f}%")
