#!/usr/bin/env python3
"""
Build cross-run execution coverage and runtime reference execution map.

Outputs:
- data/reference-intel/reference-execution-coverage-v1.json
- data/reference-intel/reference-execution-map-v1.json

Optional:
- Apply map to model_config.reference_execution_map via admin API.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import urllib.parse
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any, Dict, List, Optional, Tuple


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_json_maybe(s: str) -> Any:
    try:
        return json.loads(s)
    except Exception:
        return None


def fetch_json(url: str, timeout: int = 120) -> Dict[str, Any]:
    raw = subprocess.check_output(
        ["curl", "-sS", "-m", str(timeout), url],
        text=True,
    )
    obj = parse_json_maybe(raw)
    return obj if isinstance(obj, dict) else {}


def run_sql(sql: str, db_name: str = "timed-trading-ledger") -> List[Dict[str, Any]]:
    raw = subprocess.check_output(
        [
            "npx",
            "wrangler",
            "d1",
            "execute",
            db_name,
            "--remote",
            "--command",
            sql,
        ],
        text=True,
    )
    parsed = parse_json_maybe(raw)
    if not isinstance(parsed, list) or not parsed:
        return []
    first = parsed[0]
    if not isinstance(first, dict):
        return []
    rows = first.get("results")
    return rows if isinstance(rows, list) else []


def collect_rows_from_api(api_base: str, api_key: str, run_limit: int = 200) -> List[Dict[str, Any]]:
    runs_url = f"{api_base}/timed/admin/runs?{urllib.parse.urlencode({'include_archived': 1, 'limit': run_limit, 'key': api_key})}"
    runs_obj = fetch_json(runs_url, timeout=120)
    runs = runs_obj.get("runs") or runs_obj.get("summaries") or []
    if not isinstance(runs, list) or not runs:
        return []

    all_trade_rows: List[Dict[str, Any]] = []
    for run in runs:
        run_id = str(run.get("run_id") or "")
        if not run_id:
            continue
        cfg_url = f"{api_base}/timed/admin/runs/config?{urllib.parse.urlencode({'run_id': run_id, 'key': api_key})}"
        cfg_obj = fetch_json(cfg_url, timeout=90)
        cfg = cfg_obj.get("config") if isinstance(cfg_obj.get("config"), dict) else {}
        entry_engine = normalize_engine(cfg.get("ENTRY_ENGINE"), "tt_core")
        management_engine = normalize_engine(cfg.get("MANAGEMENT_ENGINE"), entry_engine)
        leading_ltf = str(cfg.get("LEADING_LTF") or "10")
        rank_gate_mode = str(cfg.get("rank_gate_mode") or "relative")

        tr_url = f"{api_base}/timed/admin/runs/trades?{urllib.parse.urlencode({'run_id': run_id, 'limit': 10000, 'key': api_key})}"
        tr_obj = fetch_json(tr_url, timeout=180)
        trades = tr_obj.get("trades") or []
        if not isinstance(trades, list) or not trades:
            continue
        for t in trades:
            entry_ts = to_int(t.get("entry_ts"), 0)
            if entry_ts <= 0:
                continue
            all_trade_rows.append(
                {
                    "run_id": run_id,
                    "label": run.get("label"),
                    "start_date": run.get("start_date"),
                    "end_date": run.get("end_date"),
                    "trade_id": t.get("trade_id") or t.get("id"),
                    "ticker": str(t.get("ticker") or "").upper(),
                    "direction": str(t.get("direction") or "").upper(),
                    "entry_ts": entry_ts,
                    "status": t.get("status"),
                    "pnl_pct": to_float(t.get("pnl_pct"), 0.0),
                    "entry_engine": entry_engine,
                    "management_engine": management_engine,
                    "leading_ltf": leading_ltf,
                    "rank_gate_mode": rank_gate_mode,
                }
            )

    if not all_trade_rows:
        return []

    grouped: Dict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
    for r in all_trade_rows:
        grouped[(str(r.get("run_id")), str(r.get("ticker")))].append(r)

    enriched = []
    for r in all_trade_rows:
        grp = grouped[(str(r.get("run_id")), str(r.get("ticker")))]
        first_ts = min(to_int(x.get("entry_ts"), 0) for x in grp)
        last_ts = max(to_int(x.get("entry_ts"), 0) for x in grp)
        trade_count = len(grp)
        wins = sum(1 for x in grp if str(x.get("status") or "").upper() == "WIN")
        losses = sum(1 for x in grp if str(x.get("status") or "").upper() == "LOSS")
        avg_pnl_pct = sum(to_float(x.get("pnl_pct"), 0.0) for x in grp) / max(1, trade_count)
        row = dict(r)
        row["first_entry_ts"] = first_ts
        row["last_entry_ts"] = last_ts
        row["trade_count"] = trade_count
        row["wins"] = wins
        row["losses"] = losses
        row["avg_pnl_pct"] = avg_pnl_pct
        enriched.append(row)
    return enriched


def to_int(v: Any, default: int = 0) -> int:
    try:
        if v is None:
            return default
        return int(float(v))
    except Exception:
        return default


def to_float(v: Any, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        x = float(v)
        if math.isnan(x) or math.isinf(x):
            return default
        return x
    except Exception:
        return default


def normalize_engine(v: Any, fallback: str = "tt_core") -> str:
    s = str(v or "").strip().lower()
    if s in ("legacy", "tt_core", "ripster_core"):
        return s
    return fallback


def parse_obj_maybe(v: Any) -> Optional[Any]:
    if isinstance(v, (dict, list)):
        return v
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            return json.loads(s)
        except Exception:
            return None
    return None


def _lower_or_none(v: Any) -> Optional[str]:
    s = str(v or "").strip()
    return s.lower() if s else None


def extract_lineage(ref_row: Dict[str, Any]) -> Dict[str, Any]:
    snap = parse_obj_maybe(ref_row.get("signal_snapshot_json"))
    if not isinstance(snap, dict):
        return {}
    lin = snap.get("lineage")
    return lin if isinstance(lin, dict) else {}


def extract_tf_bias(ref_row: Dict[str, Any]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    tf_stack = parse_obj_maybe(ref_row.get("tf_stack_json"))
    if not isinstance(tf_stack, list):
        return out
    for item in tf_stack:
        if not isinstance(item, dict):
            continue
        tf = str(item.get("tf") or "").strip()
        bias = str(item.get("bias") or "").strip().lower()
        if not tf or not bias:
            continue
        out[tf] = bias
    return out


def build_criteria_fingerprint(ref_row: Dict[str, Any]) -> Dict[str, Any]:
    lineage = extract_lineage(ref_row)
    fp: Dict[str, Any] = {
        "version": "criteria_fingerprint_v1",
        "entry_path": _lower_or_none(ref_row.get("entry_path") or lineage.get("entry_path")),
        "direction_source": _lower_or_none(lineage.get("direction_source")),
        "state": _lower_or_none(lineage.get("state")),
        "regime_class": _lower_or_none(lineage.get("regime_class")),
        "consensus_direction": _lower_or_none(ref_row.get("consensus_direction")),
        "engine_source": _lower_or_none(lineage.get("engine_source")),
        "scenario_policy_source": _lower_or_none(lineage.get("scenario_policy_source")),
        "tf_bias": extract_tf_bias(ref_row),
    }
    # Drop empty keys to keep map compact.
    clean: Dict[str, Any] = {}
    for k, v in fp.items():
        if v is None:
            continue
        if isinstance(v, dict) and not v:
            continue
        clean[k] = v
    return clean


def quarter_bucket(ts_ms: int) -> str:
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    q = ((dt.month - 1) // 3) + 1
    return f"{dt.year}-Q{q}"


def mode_pair(pairs: List[Tuple[str, str]]) -> Tuple[str, str]:
    if not pairs:
        return ("tt_core", "tt_core")
    c = Counter(pairs)
    return c.most_common(1)[0][0]


@dataclass
class RefEntry:
    ticker: str
    direction: str
    entry_ts: int
    trade_id: str
    run_id: str
    entry_engine: str
    management_engine: str
    score: float
    entry_path_expected: Optional[str]
    engine_source_expected: Optional[str]
    scenario_policy_source_expected: Optional[str]
    criteria_fingerprint: Dict[str, Any]


def build_coverage(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_ticker: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_ticker[str(r.get("ticker") or "").upper()].append(r)

    ticker_summary = {}
    for ticker, trows in by_ticker.items():
        first_ts = min(to_int(r.get("first_entry_ts"), 0) for r in trows if to_int(r.get("first_entry_ts"), 0) > 0)
        last_ts = max(to_int(r.get("last_entry_ts"), 0) for r in trows)
        total_trades = sum(to_int(r.get("trade_count"), 0) for r in trows)
        total_wins = sum(to_int(r.get("wins"), 0) for r in trows)
        combos = Counter(
            (
                normalize_engine(r.get("entry_engine"), "tt_core"),
                normalize_engine(r.get("management_engine"), normalize_engine(r.get("entry_engine"), "tt_core")),
            )
            for r in trows
        )
        ticker_summary[ticker] = {
            "ticker": ticker,
            "first_entry_ts": first_ts,
            "last_entry_ts": last_ts,
            "run_count": len(trows),
            "trade_count": total_trades,
            "win_rate": round((total_wins / total_trades), 4) if total_trades > 0 else 0.0,
            "top_engine_combo": {
                "entry_engine": combos.most_common(1)[0][0][0] if combos else "tt_core",
                "management_engine": combos.most_common(1)[0][0][1] if combos else "tt_core",
                "count": combos.most_common(1)[0][1] if combos else 0,
            },
            "ranges": [
                {
                    "run_id": r.get("run_id"),
                    "label": r.get("label"),
                    "start_date": r.get("start_date"),
                    "end_date": r.get("end_date"),
                    "first_entry_ts": to_int(r.get("first_entry_ts"), 0),
                    "last_entry_ts": to_int(r.get("last_entry_ts"), 0),
                    "trade_count": to_int(r.get("trade_count"), 0),
                    "wins": to_int(r.get("wins"), 0),
                    "losses": to_int(r.get("losses"), 0),
                    "avg_pnl_pct": round(to_float(r.get("avg_pnl_pct"), 0.0), 4),
                    "entry_engine": normalize_engine(r.get("entry_engine"), "tt_core"),
                    "management_engine": normalize_engine(r.get("management_engine"), normalize_engine(r.get("entry_engine"), "tt_core")),
                    "leading_ltf": str(r.get("leading_ltf") or "10"),
                    "rank_gate_mode": str(r.get("rank_gate_mode") or "relative"),
                }
                for r in sorted(trows, key=lambda x: to_int(x.get("first_entry_ts"), 0))
            ],
        }

    return {
        "generated_at_utc": now_iso(),
        "ticker_count": len(ticker_summary),
        "rows": len(rows),
        "tickers": ticker_summary,
    }


def build_reference_map(reference_path: Path, trade_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    ref_obj = json.loads(reference_path.read_text(encoding="utf-8"))
    refs = ref_obj.get("references") or []

    trade_lookup: Dict[Tuple[str, str], Dict[str, Any]] = {}
    run_engine_lookup: Dict[str, Tuple[str, str]] = {}
    for r in trade_rows:
        run_id = str(r.get("run_id") or "")
        trade_id = str(r.get("trade_id") or "")
        if run_id and trade_id:
            trade_lookup[(run_id, trade_id)] = r
        if run_id and run_id not in run_engine_lookup:
            run_engine_lookup[run_id] = (
                normalize_engine(r.get("entry_engine"), "tt_core"),
                normalize_engine(r.get("management_engine"), normalize_engine(r.get("entry_engine"), "tt_core")),
            )

    exact: List[RefEntry] = []
    seen_exact = set()
    for row in refs:
        run_id = str(row.get("run_id") or "")
        trade_id = str(row.get("trade_id") or "")
        ticker = str(row.get("ticker") or "").upper()
        if not run_id or not trade_id or not ticker:
            continue
        entry_ts = to_int(row.get("entry_ts"), 0)
        direction = str(row.get("direction") or "").upper()
        score = to_float(row.get("hybrid_score"), 0.0)
        matched = trade_lookup.get((run_id, trade_id))
        if matched:
            if not entry_ts:
                entry_ts = to_int(matched.get("entry_ts"), 0)
            if not direction:
                direction = str(matched.get("direction") or "").upper()
            ee = normalize_engine(matched.get("entry_engine"), "tt_core")
            me = normalize_engine(matched.get("management_engine"), ee)
        else:
            ee, me = run_engine_lookup.get(run_id, ("tt_core", "tt_core"))
        lineage = extract_lineage(row)
        entry_path_expected = _lower_or_none(row.get("entry_path") or lineage.get("entry_path"))
        engine_source_expected = _lower_or_none(lineage.get("engine_source"))
        scenario_policy_source_expected = _lower_or_none(lineage.get("scenario_policy_source"))
        criteria_fingerprint = build_criteria_fingerprint(row)
        if not entry_ts:
            continue
        if direction not in ("LONG", "SHORT"):
            direction = "LONG"
        dedupe_key = (ticker, direction, entry_ts, trade_id, run_id)
        if dedupe_key in seen_exact:
            continue
        seen_exact.add(dedupe_key)
        exact.append(
            RefEntry(
                ticker=ticker,
                direction=direction,
                entry_ts=entry_ts,
                trade_id=trade_id,
                run_id=run_id,
                entry_engine=ee,
                management_engine=me,
                score=score,
                entry_path_expected=entry_path_expected,
                engine_source_expected=engine_source_expected,
                scenario_policy_source_expected=scenario_policy_source_expected,
                criteria_fingerprint=criteria_fingerprint,
            )
        )

    exact.sort(key=lambda x: (x.ticker, x.entry_ts))

    # Build ticker-date windows by clustering reference entries for same ticker+direction
    windows = []
    grouped: Dict[Tuple[str, str], List[RefEntry]] = defaultdict(list)
    for e in exact:
        grouped[(e.ticker, e.direction)].append(e)
    max_gap_ms = 35 * 24 * 60 * 60 * 1000
    for (ticker, direction), items in grouped.items():
        items.sort(key=lambda x: x.entry_ts)
        cluster: List[RefEntry] = []
        for e in items:
            if not cluster:
                cluster = [e]
                continue
            if e.entry_ts - cluster[-1].entry_ts <= max_gap_ms:
                cluster.append(e)
            else:
                pair = mode_pair([(c.entry_engine, c.management_engine) for c in cluster])
                entry_path_ctr = Counter(c.entry_path_expected for c in cluster if c.entry_path_expected)
                engine_source_ctr = Counter(c.engine_source_expected for c in cluster if c.engine_source_expected)
                scenario_source_ctr = Counter(c.scenario_policy_source_expected for c in cluster if c.scenario_policy_source_expected)
                fp_ctr = Counter(
                    json.dumps(c.criteria_fingerprint, sort_keys=True, separators=(",", ":"))
                    for c in cluster
                    if isinstance(c.criteria_fingerprint, dict) and c.criteria_fingerprint
                )
                top_fp = parse_obj_maybe(fp_ctr.most_common(1)[0][0]) if fp_ctr else {}
                windows.append(
                    {
                        "ticker": ticker,
                        "direction": direction,
                        "start_ts": cluster[0].entry_ts - (2 * 24 * 60 * 60 * 1000),
                        "end_ts": cluster[-1].entry_ts + (2 * 24 * 60 * 60 * 1000),
                        "entry_engine": pair[0],
                        "management_engine": pair[1],
                        "entry_path_expected": entry_path_ctr.most_common(1)[0][0] if entry_path_ctr else None,
                        "engine_source_expected": engine_source_ctr.most_common(1)[0][0] if engine_source_ctr else None,
                        "scenario_policy_source_expected": scenario_source_ctr.most_common(1)[0][0] if scenario_source_ctr else None,
                        "criteria_fingerprint": top_fp if isinstance(top_fp, dict) else {},
                        "sample_size": len(cluster),
                        "median_score": round(median([c.score for c in cluster]), 4) if cluster else 0.0,
                    }
                )
                cluster = [e]
        if cluster:
            pair = mode_pair([(c.entry_engine, c.management_engine) for c in cluster])
            entry_path_ctr = Counter(c.entry_path_expected for c in cluster if c.entry_path_expected)
            engine_source_ctr = Counter(c.engine_source_expected for c in cluster if c.engine_source_expected)
            scenario_source_ctr = Counter(c.scenario_policy_source_expected for c in cluster if c.scenario_policy_source_expected)
            fp_ctr = Counter(
                json.dumps(c.criteria_fingerprint, sort_keys=True, separators=(",", ":"))
                for c in cluster
                if isinstance(c.criteria_fingerprint, dict) and c.criteria_fingerprint
            )
            top_fp = parse_obj_maybe(fp_ctr.most_common(1)[0][0]) if fp_ctr else {}
            windows.append(
                {
                    "ticker": ticker,
                    "direction": direction,
                    "start_ts": cluster[0].entry_ts - (2 * 24 * 60 * 60 * 1000),
                    "end_ts": cluster[-1].entry_ts + (2 * 24 * 60 * 60 * 1000),
                    "entry_engine": pair[0],
                    "management_engine": pair[1],
                    "entry_path_expected": entry_path_ctr.most_common(1)[0][0] if entry_path_ctr else None,
                    "engine_source_expected": engine_source_ctr.most_common(1)[0][0] if engine_source_ctr else None,
                    "scenario_policy_source_expected": scenario_source_ctr.most_common(1)[0][0] if scenario_source_ctr else None,
                    "criteria_fingerprint": top_fp if isinstance(top_fp, dict) else {},
                    "sample_size": len(cluster),
                    "median_score": round(median([c.score for c in cluster]), 4) if cluster else 0.0,
                }
            )

    # Date-bucket fallback defaults from all trade rows (quarterly)
    bucket_stats: Dict[str, Counter] = defaultdict(Counter)
    bucket_range: Dict[str, Tuple[int, int]] = {}
    for r in trade_rows:
        first_ts = to_int(r.get("first_entry_ts"), 0)
        last_ts = to_int(r.get("last_entry_ts"), 0)
        if first_ts <= 0 or last_ts <= 0:
            continue
        b = quarter_bucket(first_ts)
        pair = (
            normalize_engine(r.get("entry_engine"), "tt_core"),
            normalize_engine(r.get("management_engine"), normalize_engine(r.get("entry_engine"), "tt_core")),
        )
        bucket_stats[b][pair] += to_int(r.get("trade_count"), 0)
        lo, hi = bucket_range.get(b, (first_ts, last_ts))
        bucket_range[b] = (min(lo, first_ts), max(hi, last_ts))

    date_defaults = []
    for b in sorted(bucket_stats.keys()):
        pair, ct = bucket_stats[b].most_common(1)[0]
        start_ts, end_ts = bucket_range[b]
        date_defaults.append(
            {
                "bucket": b,
                "start_ts": start_ts,
                "end_ts": end_ts,
                "entry_engine": pair[0],
                "management_engine": pair[1],
                "sample_size": int(ct),
            }
        )

    return {
        "version": "reference_execution_map_v2_semantic_tolerance",
        "generated_at_utc": now_iso(),
        "source_reference_file": str(reference_path),
        "semantic_tolerance_profile": {
            "version": "semantic_tolerance_v1",
            "execute": {
                "enabled": True,
                "compare_paths": [
                    "entry_path",
                    "direction_source",
                    "state",
                    "regime_class",
                    "consensus_direction",
                    "engine_source",
                    "scenario_policy_source",
                    "tf_bias.10m",
                    "tf_bias.15m",
                    "tf_bias.30m",
                    "tf_bias.1H",
                    "tf_bias.4H",
                    "tf_bias.D",
                ],
                "required_paths": ["entry_path", "state", "regime_class"],
                "strict_missing": False,
                "ignore_unknown_expected": True,
                "max_mismatches": 1,
            },
            "drift": {
                "enabled": True,
                "compare_paths": [
                    "entry_path",
                    "direction_source",
                    "state",
                    "regime_class",
                    "consensus_direction",
                    "engine_source",
                    "scenario_policy_source",
                    "tf_bias.10m",
                    "tf_bias.15m",
                    "tf_bias.30m",
                    "tf_bias.1H",
                    "tf_bias.4H",
                    "tf_bias.D",
                ],
                "required_paths": ["entry_path", "state", "regime_class"],
                "strict_missing": True,
                "ignore_unknown_expected": True,
                "max_mismatches": 0,
            },
        },
        "exact_reference_entries": [
            {
                "ticker": e.ticker,
                "direction": e.direction,
                "entry_ts": e.entry_ts,
                "trade_id": e.trade_id,
                "run_id": e.run_id,
                "entry_engine": e.entry_engine,
                "management_engine": e.management_engine,
                "entry_path_expected": e.entry_path_expected,
                "engine_source_expected": e.engine_source_expected,
                "scenario_policy_source_expected": e.scenario_policy_source_expected,
                "criteria_fingerprint": e.criteria_fingerprint if isinstance(e.criteria_fingerprint, dict) else {},
                "score": round(e.score, 4),
                "tolerance_minutes": 20,
            }
            for e in exact
        ],
        "ticker_date_windows": windows,
        "date_bucket_defaults": date_defaults,
        "default_entry_engine": "tt_core",
        "default_management_engine": "tt_core",
    }


def apply_model_config(api_base: str, api_key: str, key: str, value: Dict[str, Any], description: str) -> None:
    payload = {"updates": [{"key": key, "value": value, "description": description}]}
    raw = subprocess.check_output(
        [
            "curl",
            "-sS",
            "-m",
            "90",
            "-X",
            "POST",
            f"{api_base}/timed/admin/model-config?key={api_key}",
            "-H",
            "Content-Type: application/json",
            "--data-raw",
            json.dumps(payload, separators=(",", ":"), ensure_ascii=True),
        ],
        text=True,
    )
    resp = parse_json_maybe(raw) or {}
    if not isinstance(resp, dict) or not resp.get("ok"):
        raise RuntimeError(f"Failed to apply model_config {key}: {resp}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build runtime reference execution map + coverage artifact")
    ap.add_argument("--db-name", default="timed-trading-ledger")
    ap.add_argument("--reference-selection", default="data/reference-intel/reference-selection-v1.json")
    ap.add_argument("--coverage-output", default="data/reference-intel/reference-execution-coverage-v1.json")
    ap.add_argument("--map-output", default="data/reference-intel/reference-execution-map-v1.json")
    ap.add_argument("--api-base", default="https://timed-trading-ingest.shashant.workers.dev")
    ap.add_argument("--api-key", default="AwesomeSauce")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    sql = """
    SELECT
      t.run_id,
      r.label,
      r.start_date,
      r.end_date,
      t.trade_id,
      t.ticker,
      t.direction,
      t.entry_ts,
      t.status,
      t.pnl_pct,
      agg.first_entry_ts,
      agg.last_entry_ts,
      agg.trade_count,
      agg.wins,
      agg.losses,
      agg.avg_pnl_pct,
      MAX(CASE WHEN c.config_key='ENTRY_ENGINE' THEN c.config_value END) AS entry_engine,
      MAX(CASE WHEN c.config_key='MANAGEMENT_ENGINE' THEN c.config_value END) AS management_engine,
      MAX(CASE WHEN c.config_key='LEADING_LTF' THEN c.config_value END) AS leading_ltf,
      MAX(CASE WHEN c.config_key='rank_gate_mode' THEN c.config_value END) AS rank_gate_mode
    FROM backtest_run_trades t
    LEFT JOIN backtest_runs r ON r.run_id = t.run_id
    LEFT JOIN backtest_run_config c
      ON c.run_id = t.run_id
     AND c.config_key IN ('ENTRY_ENGINE','MANAGEMENT_ENGINE','LEADING_LTF','rank_gate_mode')
    LEFT JOIN (
      SELECT
        run_id,
        ticker,
        MIN(entry_ts) AS first_entry_ts,
        MAX(entry_ts) AS last_entry_ts,
        COUNT(*) AS trade_count,
        SUM(CASE WHEN UPPER(status)='WIN' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN UPPER(status)='LOSS' THEN 1 ELSE 0 END) AS losses,
        AVG(COALESCE(pnl_pct, 0)) AS avg_pnl_pct
      FROM backtest_run_trades
      WHERE entry_ts IS NOT NULL
      GROUP BY run_id, ticker
    ) agg ON agg.run_id = t.run_id AND agg.ticker = t.ticker
    WHERE t.entry_ts IS NOT NULL
    GROUP BY
      t.run_id, r.label, r.start_date, r.end_date,
      t.trade_id, t.ticker, t.direction, t.entry_ts, t.status, t.pnl_pct,
      agg.first_entry_ts, agg.last_entry_ts, agg.trade_count, agg.wins, agg.losses, agg.avg_pnl_pct
    ORDER BY t.entry_ts;
    """
    rows = run_sql(sql, db_name=args.db_name)
    if not rows:
        rows = collect_rows_from_api(args.api_base, args.api_key, run_limit=200)
    if not rows:
        raise RuntimeError("No backtest_run_trades rows found; cannot build coverage/map")

    # coverage works off run+ticker aggregates (dedupe per run_id+ticker)
    dedup = {}
    for r in rows:
      k = (str(r.get("run_id") or ""), str(r.get("ticker") or ""))
      if k not in dedup:
          dedup[k] = r
    coverage = build_coverage(list(dedup.values()))
    map_obj = build_reference_map(Path(args.reference_selection), rows)

    cov_out = Path(args.coverage_output)
    cov_out.parent.mkdir(parents=True, exist_ok=True)
    cov_out.write_text(json.dumps(coverage, indent=2), encoding="utf-8")

    map_out = Path(args.map_output)
    map_out.parent.mkdir(parents=True, exist_ok=True)
    map_out.write_text(json.dumps(map_obj, indent=2), encoding="utf-8")

    if args.apply:
        apply_model_config(
            api_base=args.api_base,
            api_key=args.api_key,
            key="reference_execution_map",
            value=map_obj,
            description="Ticker/date reference execution map (entry + management engine)",
        )

    print(f"coverage_rows={coverage.get('rows')}")
    print(f"coverage_tickers={coverage.get('ticker_count')}")
    print(f"exact_reference_entries={len(map_obj.get('exact_reference_entries') or [])}")
    print(f"ticker_date_windows={len(map_obj.get('ticker_date_windows') or [])}")
    print(f"date_bucket_defaults={len(map_obj.get('date_bucket_defaults') or [])}")
    print(f"coverage_output={cov_out}")
    print(f"map_output={map_out}")
    print(f"applied={'yes' if args.apply else 'no'}")


if __name__ == "__main__":
    main()
