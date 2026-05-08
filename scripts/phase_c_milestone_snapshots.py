#!/usr/bin/env python3
"""scripts/phase_c_milestone_snapshots.py

Phase 1b — For each ticker in the cohort segmentation, computes signal
snapshots at meaningful price milestones during the Jul 2025 -> May 2026
window:

  * window_start  — first close on/after 2025-07-01
  * pct5/15/30/50 — first close that crossed +5/+15/+30/+50% above start
  * peak          — high-water close
  * window_end    — last close on/before 2026-05-08

For each milestone we compute:
  * D / W / M technical snapshot via phase_c_indicators.snapshot_at
    (EMA9/21/50/200 stack, RSI14, ATR%, SuperTrend(10,3) dir, TD setup count)
  * Sector and ticker-cohort context
  * (When traded) the trade(s) we were in at that timestamp + entry_signals

Outputs:
  data/phase-c-deep-dive/milestones/<TICKER>.json
  data/phase-c-deep-dive/milestones-summary.json
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import phase_c_indicators as ind  # noqa: E402

DD = ROOT / "data" / "phase-c-deep-dive"
CANDLES = DD / "candles"
MILESTONES_DIR = DD / "milestones"
MILESTONES_DIR.mkdir(parents=True, exist_ok=True)

WINDOW_START_MS = int(datetime(2025, 7, 1, tzinfo=timezone.utc).timestamp() * 1000)
WINDOW_END_MS   = int(datetime(2026, 5, 9, tzinfo=timezone.utc).timestamp() * 1000)

cohort_data = json.loads((DD / "cohort-segmentation.json").read_text())
universe    = json.loads((DD / "universe.json").read_text())
ticker_to_sector = universe["ticker_to_sector"]


def load_candles(ticker, tf):
    safe = ticker.replace("/", "_")
    fp = CANDLES / f"{safe}__{tf}.json"
    if not fp.exists():
        return []
    try:
        data = json.loads(fp.read_text())
        cs = data.get("candles") or []
        cs.sort(key=lambda x: int(x.get("ts", 0)))
        # de-dup any identical ts (some API responses include dupes)
        seen = set()
        out = []
        for c in cs:
            t = int(c.get("ts", 0))
            if t in seen:
                continue
            seen.add(t)
            out.append(c)
        return out
    except Exception:
        return []


def sanitize_outliers(candles):
    """Drop candles where high/low/close diverge >5x from the median of the
    surrounding 9 candles. Catches bad-feed spikes (e.g. GOLD 2026-01-28)."""
    if not candles:
        return candles
    out = []
    for i, c in enumerate(candles):
        lo = max(0, i - 4)
        hi = min(len(candles), i + 5)
        peers = candles[lo:hi]
        if len(peers) < 5:
            out.append(c)
            continue
        med_close = sorted(p.get("c", 0) for p in peers)[len(peers) // 2]
        ch = float(c.get("c") or 0)
        ph = float(c.get("h") or 0)
        if med_close > 0 and (ch > med_close * 5 or ph > med_close * 5 or (ch > 0 and ch < med_close / 5)):
            continue
        out.append(c)
    return out


def fmt_date(ts):
    return datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc).strftime("%Y-%m-%d") if ts else None


def day_milestone_indices(d_candles, start_idx, end_idx):
    """Return milestone (label, index) pairs sliced from the daily candles
    inside [start_idx, end_idx]."""
    if start_idx < 0 or end_idx < 0 or end_idx <= start_idx:
        return []
    start_p = float(d_candles[start_idx].get("c") or 0)
    if start_p <= 0:
        return []
    milestones = []
    pcts = [5, 15, 30, 50]
    pct_hit_idx = {p: None for p in pcts}
    peak_h = start_p
    peak_idx = start_idx
    for i in range(start_idx, end_idx + 1):
        c = float(d_candles[i].get("c") or 0)
        h = float(d_candles[i].get("h") or 0)
        if c <= 0:
            continue
        ret = (c / start_p - 1.0) * 100.0
        for p in pcts:
            if pct_hit_idx[p] is None and ret >= p:
                pct_hit_idx[p] = i
        if h > peak_h:
            peak_h = h
            peak_idx = i
    milestones.append(("window_start", start_idx))
    for p in pcts:
        if pct_hit_idx[p] is not None:
            milestones.append((f"pct_{p}", pct_hit_idx[p]))
    if peak_idx != start_idx:
        milestones.append(("peak", peak_idx))
    if end_idx != start_idx and end_idx != peak_idx:
        milestones.append(("window_end", end_idx))
    return milestones


def snapshot_for_ticker(ticker, sector, cohort_row):
    d_raw = sanitize_outliers(load_candles(ticker, "D"))
    w_raw = sanitize_outliers(load_candles(ticker, "W"))
    m_raw = sanitize_outliers(load_candles(ticker, "M"))
    if not d_raw:
        return None
    d_start_idx = ind.find_index_at_or_after(d_raw, WINDOW_START_MS)
    d_end_idx   = ind.find_index_at_or_before(d_raw, WINDOW_END_MS)
    if d_start_idx < 0 or d_end_idx < d_start_idx:
        return None
    milestones = day_milestone_indices(d_raw, d_start_idx, d_end_idx)
    snaps = []
    for label, idx in milestones:
        ts = int(d_raw[idx].get("ts", 0))
        d_snap = ind.snapshot_at(d_raw, idx, prefix="D_")
        w_idx = ind.find_index_at_or_before(w_raw, ts)
        m_idx = ind.find_index_at_or_before(m_raw, ts)
        w_snap = ind.snapshot_at(w_raw, w_idx, prefix="W_") if w_idx >= 0 else {}
        m_snap = ind.snapshot_at(m_raw, m_idx, prefix="M_") if m_idx >= 0 else {}
        c = d_raw[idx]
        snap = {
            "label": label,
            "date": fmt_date(ts),
            "ts": ts,
            "open":  float(c.get("o") or 0),
            "high":  float(c.get("h") or 0),
            "low":   float(c.get("l") or 0),
            "close": float(c.get("c") or 0),
            **d_snap,
            **w_snap,
            **m_snap,
        }
        snap["return_from_start_pct"] = round((snap["close"] / float(d_raw[d_start_idx].get("c") or 1) - 1.0) * 100.0, 2)
        snaps.append(snap)
    return {
        "ticker": ticker,
        "sector": sector,
        "cohort": cohort_row.get("cohort"),
        "return_pct": cohort_row.get("return_pct"),
        "peak_return_pct": cohort_row.get("peak_return_pct"),
        "drawdown_from_peak_pct": cohort_row.get("drawdown_from_peak_pct"),
        "milestones": snaps,
    }


def main():
    # Flatten cohort rows
    rows = []
    for cohort, items in cohort_data["cohorts"].items():
        for r in items:
            rows.append(r)
    n_done = 0
    n_skipped = 0
    summaries = []
    for r in rows:
        ticker = r["ticker"]
        sector = r["sector"]
        out = snapshot_for_ticker(ticker, sector, r)
        if not out:
            n_skipped += 1
            continue
        fp = MILESTONES_DIR / f"{ticker.replace('/', '_')}.json"
        fp.write_text(json.dumps(out, indent=2))
        summaries.append({
            "ticker": ticker,
            "sector": sector,
            "cohort": r["cohort"],
            "return_pct": r.get("return_pct"),
            "milestone_count": len(out["milestones"]),
        })
        n_done += 1
    summary = {
        "generated_at": int(datetime.now(timezone.utc).timestamp() * 1000),
        "total": len(rows),
        "snapshots": n_done,
        "skipped": n_skipped,
        "by_ticker": sorted(summaries, key=lambda x: x["ticker"]),
    }
    (DD / "milestones-summary.json").write_text(json.dumps(summary, indent=2))
    print(f"[milestones] {n_done} snapshots, {n_skipped} skipped")


if __name__ == "__main__":
    main()
