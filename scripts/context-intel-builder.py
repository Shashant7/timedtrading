#!/usr/bin/env python3
"""
Build context-intel snapshot v1 from canonical trades and ticker profiles.

This v1 is artifact-first:
- ticker profile block is populated from latest local ticker profile snapshot
- SPY/QQQ hyper-state is derived from same-day SPY/QQQ trade outcomes when available
- daily brief block remains null unless an external snapshot source is provided
"""

from __future__ import annotations

import argparse
import json
import subprocess
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    rows.append(obj)
            except Exception:
                continue
    return rows


def date_key(entry_ts: Any) -> Optional[str]:
    if not isinstance(entry_ts, int) or entry_ts <= 0:
        return None
    return datetime.fromtimestamp(entry_ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def find_latest_profile(path_glob: str) -> Optional[Path]:
    paths = list(Path(".").glob(path_glob))
    if not paths:
        return None
    paths.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return paths[0]


def derive_hyper_state(spyqqq_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    pnl_values = [float(r["pnl_pct"]) for r in spyqqq_rows if isinstance(r.get("pnl_pct"), (int, float))]
    if not pnl_values:
        return {
            "trend_state": "unknown",
            "volatility_state": "unknown",
            "opening_tone": "unknown",
            "persistence_state": "unknown",
            "sample_size": len(spyqqq_rows),
        }
    avg = sum(pnl_values) / len(pnl_values)
    std_proxy = (max(pnl_values) - min(pnl_values)) if len(pnl_values) > 1 else 0.0
    trend_state = "bullish_bias" if avg > 0.4 else ("bearish_bias" if avg < -0.4 else "mixed")
    volatility_state = "high" if std_proxy > 6 else ("medium" if std_proxy > 3 else "low")
    opening_tone = "risk_on" if avg > 0 else ("risk_off" if avg < 0 else "neutral")
    persistence_state = "trend_follow" if abs(avg) > 1.0 else "mean_revert_or_chop"
    return {
        "trend_state": trend_state,
        "volatility_state": volatility_state,
        "opening_tone": opening_tone,
        "persistence_state": persistence_state,
        "sample_size": len(pnl_values),
        "avg_pnl_pct": round(avg, 4),
        "range_pnl_pct": round(std_proxy, 4),
    }


def d1_query(sql: str) -> List[Dict[str, Any]]:
    try:
        raw = subprocess.check_output(
            [
                "npx",
                "wrangler",
                "d1",
                "execute",
                "timed-trading-ledger",
                "--remote",
                "--command",
                sql,
                "--json",
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        payload = json.loads(raw)
        if isinstance(payload, list) and payload:
            res = payload[0].get("results")
            if isinstance(res, list):
                return [x for x in res if isinstance(x, dict)]
    except Exception:
        return []
    return []


def parse_wrangler_json_results(path: Path) -> List[Dict[str, Any]]:
    payload = load_json(path)
    if isinstance(payload, list) and payload:
        first = payload[0]
        if isinstance(first, dict) and isinstance(first.get("results"), list):
            return [x for x in first["results"] if isinstance(x, dict)]
    return []


def main() -> None:
    parser = argparse.ArgumentParser(description="Build context-intel snapshot v1")
    parser.add_argument("--canonical", default="data/reference-intel/trade-intel-canonical-v1.jsonl")
    parser.add_argument("--profile-glob", default="data/ticker-profiles-*.json")
    parser.add_argument("--output", default="data/reference-intel/context-intel-snapshot-v1.json")
    parser.add_argument("--quality-output", default="data/reference-intel/context-intel-quality-v1.json")
    parser.add_argument("--use-d1-runtime", action="store_true")
    parser.add_argument("--runtime-snapshots-json", default="")
    parser.add_argument("--runtime-events-json", default="")
    args = parser.parse_args()

    canonical_rows = load_jsonl(Path(args.canonical))
    latest_profile_path = find_latest_profile(args.profile_glob)
    profile_payload = load_json(latest_profile_path) if latest_profile_path else None
    profile_map = {}
    if isinstance(profile_payload, dict) and isinstance(profile_payload.get("profiles"), dict):
        profile_map = profile_payload["profiles"]

    rows_by_date: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in canonical_rows:
        d = date_key(row.get("entry_ts"))
        if d:
            rows_by_date[d].append(row)

    sorted_dates = sorted(rows_by_date.keys())
    d1_snapshots_by_date: Dict[str, Dict[str, Any]] = {}
    d1_events_by_date: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    if args.use_d1_runtime and sorted_dates:
        min_date = sorted_dates[0]
        max_date = sorted_dates[-1]
        snap_rows: List[Dict[str, Any]] = []
        event_rows: List[Dict[str, Any]] = []
        if args.runtime_snapshots_json:
            snap_rows = parse_wrangler_json_results(Path(args.runtime_snapshots_json))
        if args.runtime_events_json:
            event_rows = parse_wrangler_json_results(Path(args.runtime_events_json))
        if not snap_rows:
            snap_rows = d1_query(
                f"SELECT date, vix_close, vix_state, spy_pct, qqq_pct, iwm_pct, offense_avg_pct, defense_avg_pct, sector_rotation, regime_overall, regime_score, btc_pct, eth_pct FROM daily_market_snapshots WHERE date >= '{min_date}' AND date <= '{max_date}' ORDER BY date ASC"
            )
        for r in snap_rows:
            d = str(r.get("date") or "")
            if d:
                d1_snapshots_by_date[d] = r
        if not event_rows:
            event_rows = d1_query(
                f"SELECT date, event_type, event_name, impact, surprise_pct, spy_reaction_pct, sector_reaction_pct FROM market_events WHERE date >= '{min_date}' AND date <= '{max_date}' ORDER BY date ASC"
            )
        for r in event_rows:
            d = str(r.get("date") or "")
            if d:
                d1_events_by_date[d].append(r)

    spyqqq_by_date: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for d, rows in rows_by_date.items():
        for r in rows:
            if str(r.get("ticker") or "").upper() in ("SPY", "QQQ"):
                spyqqq_by_date[d].append(r)

    context_rows: List[Dict[str, Any]] = []
    quality_counter = Counter()
    for row in canonical_rows:
        ticker = str(row.get("ticker") or "").upper()
        d = date_key(row.get("entry_ts"))
        if not ticker or not d:
            continue
        p = profile_map.get(ticker) if isinstance(profile_map, dict) else None
        profile_present = isinstance(p, dict)
        snap = d1_snapshots_by_date.get(d)
        if snap:
            spy_pct = float(snap.get("spy_pct") or 0)
            qqq_pct = float(snap.get("qqq_pct") or 0)
            combined = (spy_pct + qqq_pct) / 2.0
            hyper = {
                "trend_state": "bullish_bias" if combined > 0.3 else ("bearish_bias" if combined < -0.3 else "mixed"),
                "volatility_state": str(snap.get("vix_state") or "unknown"),
                "opening_tone": "risk_on" if combined > 0 else ("risk_off" if combined < 0 else "neutral"),
                "persistence_state": "trend_follow" if abs(combined) > 0.8 else "mean_revert_or_chop",
                "sample_size": 1,
                "spy_pct": spy_pct,
                "qqq_pct": qqq_pct,
                "regime_overall": snap.get("regime_overall"),
                "regime_score": snap.get("regime_score"),
            }
        else:
            hyper = derive_hyper_state(spyqqq_by_date.get(d, []))
        hyper_present = (snap is not None) or (hyper.get("sample_size", 0) > 0)
        daily_brief = None
        if snap:
            events = d1_events_by_date.get(d, [])
            high_impact = sum(1 for e in events if str(e.get("impact") or "").lower() == "high")
            daily_brief = {
                "date": d,
                "regime_overall": snap.get("regime_overall"),
                "regime_score": snap.get("regime_score"),
                "vix_close": snap.get("vix_close"),
                "vix_state": snap.get("vix_state"),
                "sector_rotation": snap.get("sector_rotation"),
                "offense_avg_pct": snap.get("offense_avg_pct"),
                "defense_avg_pct": snap.get("defense_avg_pct"),
                "spy_pct": snap.get("spy_pct"),
                "qqq_pct": snap.get("qqq_pct"),
                "iwm_pct": snap.get("iwm_pct"),
                "btc_pct": snap.get("btc_pct"),
                "eth_pct": snap.get("eth_pct"),
                "event_count": len(events),
                "high_impact_event_count": high_impact,
            }
        daily_brief_present = daily_brief is not None
        profile_block = {
            "personality": p.get("personality") if profile_present else None,
            "avg_volatility_pct": p.get("avg_volatility_pct") if profile_present else None,
            "long_avg_duration": (p.get("long_profile") or {}).get("avg_duration") if profile_present else None,
            "short_avg_duration": (p.get("short_profile") or {}).get("avg_duration") if profile_present else None,
            "trail_style": (p.get("entry_params") or {}).get("trail_style") if profile_present else None,
        }
        context = {
            "date": d,
            "ticker": ticker,
            "run_id": row.get("run_id"),
            "context_complete": profile_present and hyper_present and daily_brief_present,
            "profile_present": profile_present,
            "daily_brief_present": daily_brief_present,
            "hyper_state_present": hyper_present,
            "ticker_profile": profile_block,
            "daily_brief": daily_brief,
            "spy_qqq_hyper_state": hyper if hyper_present else None,
            "source_timestamps": {
                "canonical_generated_from": args.canonical,
                "ticker_profile_source": str(latest_profile_path) if latest_profile_path else None,
                "runtime_source": "d1:daily_market_snapshots,market_events" if args.use_d1_runtime else None,
            },
        }
        quality_counter["rows"] += 1
        if profile_present:
            quality_counter["profile_present"] += 1
        if daily_brief_present:
            quality_counter["daily_brief_present"] += 1
        if hyper_present:
            quality_counter["hyper_state_present"] += 1
        context_rows.append(context)

    snapshot = {
        "generated_at_utc": now_iso(),
        "source": "runtime-augmented-v1" if args.use_d1_runtime else "artifact-first-v1",
        "latest_profile_source": str(latest_profile_path) if latest_profile_path else None,
        "row_count": len(context_rows),
        "rows": context_rows,
    }

    q_total = max(1, quality_counter["rows"])
    quality = {
        "generated_at_utc": now_iso(),
        "row_count": quality_counter["rows"],
        "profile_present_count": quality_counter["profile_present"],
        "daily_brief_present_count": quality_counter["daily_brief_present"],
        "hyper_state_present_count": quality_counter["hyper_state_present"],
        "profile_present_rate": round(quality_counter["profile_present"] / q_total, 4),
        "daily_brief_present_rate": round(quality_counter["daily_brief_present"] / q_total, 4),
        "hyper_state_present_rate": round(quality_counter["hyper_state_present"] / q_total, 4),
        "known_gap": None if quality_counter["daily_brief_present"] == quality_counter["rows"] else "daily_brief source integration is pending in this snapshot",
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
    Path(args.quality_output).write_text(json.dumps(quality, indent=2), encoding="utf-8")

    print(f"row_count={len(context_rows)}")
    print(f"profile_source={latest_profile_path}")
    print(f"use_d1_runtime={args.use_d1_runtime}")
    print(f"output={out_path}")
    print(f"quality={args.quality_output}")


if __name__ == "__main__":
    main()

