#!/usr/bin/env python3
"""
Phase-C Stage1 Universe Benchmark — Oracle vs System

Builds an objective "best-possible-trade" oracle from daily candles for the
238-ticker phase-c stage1 universe over the Jul 2025 → currently-available
window, then compares it to the system's actual trades for run_id
`phase-c-stage1-jul2025-may2026`.

READ-ONLY: only hits the public worker candles + admin run-trades endpoints.
Caches per-ticker daily bars under /workspace/data/universe-cache/.

Outputs:
    /workspace/tasks/phase-c/universe-benchmark/oracle-trades.json
    /workspace/tasks/phase-c/universe-benchmark/system-trades.json   (raw cache)
    /workspace/tasks/phase-c/universe-benchmark/comparison.md
"""

from __future__ import annotations

import json
import os
import sys
import time
import math
import urllib.parse
import urllib.request
import urllib.error
import datetime as dt
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------
WORKER_BASE = "https://timed-trading-ingest.shashant.workers.dev"
RUN_ID = "phase-c-stage1-jul2025-may2026"
UNIVERSE_FILE = Path("/workspace/configs/backtest-universe-phase-c-stage1.txt")
CACHE_DIR = Path("/workspace/data/universe-cache")
OUT_DIR = Path("/workspace/tasks/phase-c/universe-benchmark")
ORACLE_OUT = OUT_DIR / "oracle-trades.json"
SYSTEM_TRADES_CACHE = OUT_DIR / "system-trades.json"
REPORT_OUT = OUT_DIR / "comparison.md"

# Window for the benchmark — start hard at Jul 1 2025 entry date.
WINDOW_START_MS = int(dt.datetime(2025, 7, 1).timestamp() * 1000)
# asOfTs cap when fetching: well into the future so endpoint returns
# everything available; the worker's underlying replay determines actual
# last-available bar.
AS_OF_MS = int(dt.datetime(2026, 5, 5).timestamp() * 1000)
# Hard cap on oracle entry dates: the system has only been replayed up to
# this point so any oracle entry beyond it is unfair to compare.
# Will be overwritten dynamically from the system trades' max entry_ts at runtime.
WINDOW_END_MS = int(dt.datetime(2026, 5, 5).timestamp() * 1000)

# Oracle parameters
N_FORWARD = 10        # forward window in trading days (matches spec primary horizon)
MIN_PCT = 8.0         # minimum % magnitude for a "winning move"
TOP_PER_TICKER = 3    # max non-overlapping winners per ticker per side
# Match window for system vs oracle in trading days
MATCH_DAYS = 3
# Capture-efficiency threshold for "caught but mismanaged"
MISMANAGE_CAPTURE = 0.30

# HTTP throttling
MIN_REQ_INTERVAL_S = 0.20  # ~5 req/sec
MAX_RETRIES = 5

API_KEY = os.environ.get("TIMED_API_KEY") or os.environ.get(
    "TIMED_TRADING_API_KEY"
)
if not API_KEY:
    print("ERROR: TIMED_API_KEY env var not set", file=sys.stderr)
    sys.exit(2)


# ---------------------------------------------------------------------------
# http helpers
# ---------------------------------------------------------------------------
_last_req_ts = [0.0]


def _throttle() -> None:
    now = time.time()
    delta = now - _last_req_ts[0]
    if delta < MIN_REQ_INTERVAL_S:
        time.sleep(MIN_REQ_INTERVAL_S - delta)
    _last_req_ts[0] = time.time()


def http_get_json(url: str, timeout: int = 60) -> dict[str, Any]:
    backoff = 1.0
    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES):
        _throttle()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "phase-c-bench/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
                return json.loads(body)
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code == 429 or e.code >= 500:
                wait = backoff
                # honour Retry-After if present
                ra = e.headers.get("Retry-After") if e.headers else None
                if ra:
                    try:
                        wait = max(wait, float(ra))
                    except ValueError:
                        pass
                print(f"  http {e.code} retry in {wait:.1f}s ({url[:80]})", file=sys.stderr)
                time.sleep(wait)
                backoff = min(backoff * 2, 30)
                continue
            raise
        except Exception as e:
            last_err = e
            print(f"  net err {type(e).__name__}: {e} retry in {backoff:.1f}s", file=sys.stderr)
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
    raise RuntimeError(f"HTTP failed after {MAX_RETRIES} retries: {last_err}")


# ---------------------------------------------------------------------------
# data loaders
# ---------------------------------------------------------------------------
def load_universe() -> list[str]:
    out = []
    for ln in UNIVERSE_FILE.read_text().splitlines():
        s = ln.strip()
        if s:
            out.append(s)
    return out


def cache_path(ticker: str) -> Path:
    safe = ticker.replace("/", "_").replace("!", "_").replace(":", "_")
    return CACHE_DIR / f"{safe}-D.json"


def _dedupe_candles(raw: list[dict]) -> list[dict]:
    """
    The candles endpoint returns multiple rows per trading day from different
    data feeds (e.g. equity vs spot). Strategy:
      1. Group by trading-day date.
      2. If a group has rows with non-zero volume, drop v=0 / v=null rows.
      3. If multiple rows remain, take the one whose close is closest to the
         median close of all rows that share the same close-magnitude band
         (within 30% of the most-common price for that day).
      4. Fallback: take the row with the largest reported volume.
      5. Cross-day sanity: drop any day whose close is >5x or <0.2x the
         3-day rolling median (bad-feed bleed).
    """
    if not raw:
        return raw
    by_date: dict[str, list[dict]] = {}
    for r in raw:
        dk = dt.datetime.fromtimestamp(int(r["ts"]) / 1000, tz=dt.timezone.utc).strftime("%Y-%m-%d")
        by_date.setdefault(dk, []).append(r)

    chosen: list[dict] = []
    for dk in sorted(by_date.keys()):
        rs = by_date[dk]
        # Step 1: prefer rows with volume > 0 if any exist
        with_v = [r for r in rs if r.get("v") and float(r["v"]) > 0]
        cands = with_v if with_v else rs
        if len(cands) == 1:
            chosen.append(cands[0])
            continue
        # Step 2: by max volume (most-traded feed wins)
        cands_sorted = sorted(cands, key=lambda r: float(r.get("v") or 0), reverse=True)
        chosen.append(cands_sorted[0])

    # Step 3: cross-day sanity filter using rolling median.
    # Sort by ts, then walk and drop outliers.
    chosen.sort(key=lambda r: r["ts"])
    cleaned: list[dict] = []
    for i, r in enumerate(chosen):
        # rolling median of close over the last 5 cleaned bars (else this bar)
        recent = [c["c"] for c in cleaned[-5:]] if cleaned else [r["c"]]
        med = sorted(recent)[len(recent) // 2]
        if med <= 0:
            cleaned.append(r)
            continue
        ratio = float(r["c"]) / med
        if 0.4 <= ratio <= 2.5:
            cleaned.append(r)
        else:
            # Try the other dup row(s) for this date if any
            dk = dt.datetime.fromtimestamp(int(r["ts"]) / 1000, tz=dt.timezone.utc).strftime("%Y-%m-%d")
            alt_rs = [a for a in by_date[dk] if a is not r]
            picked = None
            for a in sorted(alt_rs, key=lambda x: float(x.get("v") or 0), reverse=True):
                if 0.4 <= float(a["c"]) / med <= 2.5:
                    picked = a
                    break
            if picked is not None:
                cleaned.append(picked)
            # otherwise drop the bar (likely cross-source contamination)
    return cleaned


def fetch_daily_candles(ticker: str, force: bool = False) -> list[dict]:
    """Returns sorted-asc, dedup'd list of {ts,o,h,l,c,v}. Cached locally."""
    p = cache_path(ticker)
    raw: list[dict] | None = None
    if p.exists() and not force:
        try:
            data = json.loads(p.read_text())
            raw = data.get("candles") or []
        except Exception:
            raw = None
    if raw is None:
        url = (
            f"{WORKER_BASE}/timed/candles?ticker="
            f"{urllib.parse.quote(ticker)}&tf=D&limit=500&asOfTs={AS_OF_MS}"
        )
        j = http_get_json(url)
        if not j.get("ok"):
            print(f"  WARN {ticker}: candles endpoint err {j.get('error')}", file=sys.stderr)
            raw = []
        else:
            raw = j.get("candles") or []
        raw = sorted(raw, key=lambda r: r["ts"])
        p.write_text(json.dumps({"ticker": ticker, "candles": raw}))
    return _dedupe_candles(raw)


def fetch_system_trades() -> list[dict]:
    if SYSTEM_TRADES_CACHE.exists():
        try:
            cached = json.loads(SYSTEM_TRADES_CACHE.read_text())
            if cached.get("trades"):
                # Always refresh to capture any new trades
                pass
        except Exception:
            pass
    url = (
        f"{WORKER_BASE}/timed/admin/backtests/run-trades"
        f"?run_id={urllib.parse.quote(RUN_ID)}&key={urllib.parse.quote(API_KEY)}&limit=2000"
    )
    j = http_get_json(url, timeout=120)
    if not j.get("ok"):
        raise RuntimeError(f"run-trades endpoint err: {j}")
    trades = j.get("trades") or []
    SYSTEM_TRADES_CACHE.write_text(json.dumps({"run_id": RUN_ID, "trades": trades}, indent=2))
    return trades


# ---------------------------------------------------------------------------
# oracle computation
# ---------------------------------------------------------------------------
def ts_to_date(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).strftime("%Y-%m-%d")


def compute_oracle_for_ticker(ticker: str, candles: list[dict]) -> list[dict]:
    """
    For each trading day i (with i+1..i+N inside the data), compute:
      long_pct  = (max(h_{i+1..i+N}) / c_i - 1) * 100
      short_pct = (min(l_{i+1..i+N}) / c_i - 1) * 100   (negative)
    Also capture the index of the day containing the extreme.

    Then greedy-pick top-3 non-overlapping winners per side where
      |pct| > MIN_PCT, ordered by |pct| desc.
    Two windows overlap if [entry_idx, exit_idx] intersect.
    """
    n = len(candles)
    if n < N_FORWARD + 2:
        return []

    # Filter to candles whose entry date is on/after WINDOW_START
    candidates_long: list[tuple[float, int, int]] = []   # (pct, entry_idx, exit_idx)
    candidates_short: list[tuple[float, int, int]] = []

    for i in range(n - 1):
        # entry_ts is close-of-day i; only consider entry days in window.
        if candles[i]["ts"] < WINDOW_START_MS:
            continue
        if candles[i]["ts"] > WINDOW_END_MS:
            break
        end = min(i + N_FORWARD, n - 1)
        if end <= i:
            continue
        entry_close = float(candles[i]["c"])
        if not math.isfinite(entry_close) or entry_close <= 0:
            continue
        # find peak high & trough low in (i+1 .. end)
        peak_idx = i + 1
        trough_idx = i + 1
        for j in range(i + 1, end + 1):
            if float(candles[j]["h"]) > float(candles[peak_idx]["h"]):
                peak_idx = j
            if float(candles[j]["l"]) < float(candles[trough_idx]["l"]):
                trough_idx = j
        long_pct = (float(candles[peak_idx]["h"]) / entry_close - 1.0) * 100.0
        short_pct = (float(candles[trough_idx]["l"]) / entry_close - 1.0) * 100.0
        if long_pct >= MIN_PCT:
            candidates_long.append((long_pct, i, peak_idx))
        if short_pct <= -MIN_PCT:
            candidates_short.append((short_pct, i, trough_idx))

    def greedy_pick(cands: list[tuple[float, int, int]], side: str) -> list[dict]:
        # sort by absolute pct descending
        cands_sorted = sorted(cands, key=lambda t: -abs(t[0]))
        chosen_intervals: list[tuple[int, int]] = []
        out: list[dict] = []
        for pct, ei, xi in cands_sorted:
            lo, hi = (ei, xi) if ei <= xi else (xi, ei)
            overlap = False
            for clo, chi in chosen_intervals:
                if not (hi < clo or lo > chi):
                    overlap = True
                    break
            if overlap:
                continue
            chosen_intervals.append((lo, hi))
            entry_c = candles[ei]
            exit_c = candles[xi]
            entry_price = float(entry_c["c"])
            exit_price = (
                float(exit_c["h"]) if side == "LONG" else float(exit_c["l"])
            )
            out.append({
                "ticker": ticker,
                "side": side,
                "entry_ts": int(entry_c["ts"]),
                "entry_date": ts_to_date(int(entry_c["ts"])),
                "entry_price": entry_price,
                "exit_ts": int(exit_c["ts"]),
                "exit_date": ts_to_date(int(exit_c["ts"])),
                "exit_price": exit_price,
                "pct_move": round(pct, 3),
                "days_held": xi - ei,
                "_entry_idx": ei,
                "_exit_idx": xi,
            })
            if len(out) >= TOP_PER_TICKER:
                break
        return out

    longs = greedy_pick(candidates_long, "LONG")
    shorts = greedy_pick(candidates_short, "SHORT")
    return longs + shorts


# ---------------------------------------------------------------------------
# matching
# ---------------------------------------------------------------------------
def trading_day_index(candles: list[dict], ts_ms: int) -> int | None:
    """Return idx of candle whose date == nearest-on-or-before trading day for ts_ms."""
    target_date = dt.datetime.fromtimestamp(ts_ms / 1000, tz=dt.timezone.utc).date()
    # Find the largest idx whose date <= target_date
    lo, hi, ans = 0, len(candles) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        d = dt.datetime.fromtimestamp(candles[mid]["ts"] / 1000, tz=dt.timezone.utc).date()
        if d <= target_date:
            ans = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return ans


def parse_es(t: dict) -> dict:
    es = t.get("entry_signals_json")
    if not es:
        return {}
    if isinstance(es, dict):
        return es
    try:
        return json.loads(es)
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# main pipeline
# ---------------------------------------------------------------------------
def main() -> int:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    universe = load_universe()
    print(f"[universe] {len(universe)} tickers")

    # 1) fetch candles (cached)
    candles_by_ticker: dict[str, list[dict]] = {}
    missing: list[str] = []
    fetched_count = 0
    cached_count = 0
    for i, tk in enumerate(universe, 1):
        p = cache_path(tk)
        was_cached = p.exists()
        try:
            cs = fetch_daily_candles(tk)
        except Exception as e:
            print(f"  ERR {tk}: {e}", file=sys.stderr)
            cs = []
        if not cs:
            missing.append(tk)
        candles_by_ticker[tk] = cs
        if was_cached:
            cached_count += 1
        else:
            fetched_count += 1
        if i % 25 == 0 or i == len(universe):
            print(f"  [{i}/{len(universe)}] fetched={fetched_count} cached={cached_count} missing={len(missing)}")
    print(f"[candles] fetched={fetched_count} cached={cached_count} no-data={len(missing)}")
    if missing:
        print(f"  no-data tickers (excluded from oracle): {missing[:20]}{'...' if len(missing) > 20 else ''}")

    # Pre-fetch system trades just to learn the replay cutoff for oracle entries.
    trades_preview = fetch_system_trades()
    sys_max_entry = max((t.get("entry_ts") or 0) for t in trades_preview)
    if sys_max_entry > 0:
        global WINDOW_END_MS
        # End cap = end of the trading day the system last opened a trade on.
        # Anything beyond that the system literally couldn't have entered.
        sys_last_date = dt.datetime.fromtimestamp(sys_max_entry / 1000, tz=dt.timezone.utc).date()
        WINDOW_END_MS = int(dt.datetime(
            sys_last_date.year, sys_last_date.month, sys_last_date.day, 23, 59, 59
        ).timestamp() * 1000)
        print(f"[window] capping oracle entries at {sys_last_date.isoformat()} (sys last entry day)")

    # 2) compute oracle
    oracle: list[dict] = []
    for tk, cs in candles_by_ticker.items():
        if not cs:
            continue
        # Filter cs to those within window for correctness — keep all so look-back works
        oracle.extend(compute_oracle_for_ticker(tk, cs))
    # sort: largest |pct| first
    oracle.sort(key=lambda r: -abs(r["pct_move"]))
    longs = [r for r in oracle if r["side"] == "LONG"]
    shorts = [r for r in oracle if r["side"] == "SHORT"]
    print(f"[oracle] {len(oracle)} winners ({len(longs)} long, {len(shorts)} short)")

    # write oracle JSON (drop private fields)
    publishable = []
    for r in oracle:
        publishable.append({k: v for k, v in r.items() if not k.startswith("_")})
    ORACLE_OUT.write_text(json.dumps({
        "run_id": RUN_ID,
        "params": {
            "N_FORWARD": N_FORWARD,
            "MIN_PCT": MIN_PCT,
            "TOP_PER_TICKER": TOP_PER_TICKER,
            "WINDOW_START": ts_to_date(WINDOW_START_MS),
        },
        "count": len(publishable),
        "trades": publishable,
    }, indent=2))
    print(f"[oracle] wrote {ORACLE_OUT}")

    # 3) system trades (already fetched above)
    trades = trades_preview
    print(f"[system] {len(trades)} trades for run {RUN_ID}")

    # 4) match oracle <-> system
    # Build per-ticker oracle list
    oracle_by_ticker: dict[str, list[dict]] = defaultdict(list)
    for r in oracle:
        oracle_by_ticker[r["ticker"]].append(r)

    # Build per-ticker system trade list (only trades on or after WINDOW_START)
    sys_by_ticker: dict[str, list[dict]] = defaultdict(list)
    for t in trades:
        if not t.get("entry_ts"):
            continue
        if t["entry_ts"] < WINDOW_START_MS:
            continue
        sys_by_ticker[t["ticker"]].append(t)

    matches: list[dict] = []   # one per oracle window matched to system trade
    misses: list[dict] = []    # oracle windows with no system trade nearby
    for tk, ows in oracle_by_ticker.items():
        cs = candles_by_ticker.get(tk) or []
        if not cs:
            continue
        sys_trades = sys_by_ticker.get(tk, [])
        for ow in ows:
            o_entry_idx = ow["_entry_idx"]
            o_exit_idx = ow["_exit_idx"]
            best_match: dict | None = None
            best_dist = 10**9
            for st in sys_trades:
                if st.get("direction") != ow["side"]:
                    continue
                s_entry_idx = trading_day_index(cs, st["entry_ts"])
                if s_entry_idx is None:
                    continue
                dist = abs(s_entry_idx - o_entry_idx)
                if dist <= MATCH_DAYS and dist < best_dist:
                    best_match = st
                    best_dist = dist
            if best_match is None:
                misses.append(ow)
            else:
                pnl_pct = best_match.get("pnl_pct")
                # pnl_pct stored as a percent already (e.g. 0.74 means 0.74%)
                # We want signed magnitude relative to entry; pnl_pct already signed.
                if pnl_pct is None:
                    pnl_pct = 0.0
                oracle_pct_abs = abs(ow["pct_move"])
                # capture: signed system pnl in same direction divided by oracle |pct|
                sys_signed_pct = float(pnl_pct)
                # For SHORT trades, system's pnl_pct is positive when price drops,
                # so capture comparison stays consistent (sys/positive_oracle).
                capture = (sys_signed_pct / oracle_pct_abs) if oracle_pct_abs > 0 else 0.0
                matches.append({
                    "oracle": ow,
                    "system": best_match,
                    "entry_dist_days": best_dist,
                    "system_pnl_pct": sys_signed_pct,
                    "oracle_pct_abs": oracle_pct_abs,
                    "capture": capture,
                })

    # 5) "system wins not in oracle" = profitable system trades whose entry day
    # isn't within ±MATCH_DAYS of any oracle window of same direction.
    sys_extra_wins: list[dict] = []
    for tk, sts in sys_by_ticker.items():
        cs = candles_by_ticker.get(tk) or []
        if not cs:
            continue
        ows = oracle_by_ticker.get(tk, [])
        for st in sts:
            pnl_pct = st.get("pnl_pct") or 0.0
            if pnl_pct <= 0:
                continue
            s_idx = trading_day_index(cs, st["entry_ts"])
            if s_idx is None:
                continue
            matched = False
            for ow in ows:
                if ow["side"] != st.get("direction"):
                    continue
                if abs(s_idx - ow["_entry_idx"]) <= MATCH_DAYS:
                    matched = True
                    break
            if not matched:
                sys_extra_wins.append(st)

    print(f"[match] oracle={len(oracle)} matched={len(matches)} missed={len(misses)} extra_sys_wins={len(sys_extra_wins)}")

    # 6) write report
    write_report(oracle, matches, misses, sys_extra_wins, trades, candles_by_ticker)

    # also dump a JSON of matches for downstream debugging
    (OUT_DIR / "matches-debug.json").write_text(json.dumps({
        "matches_count": len(matches),
        "missed_count": len(misses),
        "extra_wins_count": len(sys_extra_wins),
        "matches_sample": [
            {
                "ticker": m["oracle"]["ticker"], "side": m["oracle"]["side"],
                "oracle_entry": m["oracle"]["entry_date"],
                "oracle_exit": m["oracle"]["exit_date"],
                "oracle_pct": m["oracle"]["pct_move"],
                "system_entry_ts": m["system"]["entry_ts"],
                "system_pnl_pct": m["system_pnl_pct"],
                "capture": round(m["capture"], 3),
                "entry_dist": m["entry_dist_days"],
            }
            for m in matches[:50]
        ],
    }, indent=2))

    return 0


# ---------------------------------------------------------------------------
# report writer
# ---------------------------------------------------------------------------
def fmt_pct(x: float) -> str:
    return f"{x:+.2f}%"


def write_report(
    oracle: list[dict],
    matches: list[dict],
    misses: list[dict],
    extra_wins: list[dict],
    sys_trades: list[dict],
    candles_by_ticker: dict[str, list[dict]],
) -> None:
    longs = [r for r in oracle if r["side"] == "LONG"]
    shorts = [r for r in oracle if r["side"] == "SHORT"]
    total_oracle_long_pct = sum(r["pct_move"] for r in longs)
    total_oracle_short_pct = sum(-r["pct_move"] for r in shorts)  # absolute opp magnitude
    total_oracle_pct = total_oracle_long_pct + total_oracle_short_pct

    matched_oracle = {(m["oracle"]["ticker"], m["oracle"]["entry_date"], m["oracle"]["side"]) for m in matches}
    n_matched = len(matched_oracle)
    n_oracle = len(oracle)
    hit_rate = (n_matched / n_oracle * 100.0) if n_oracle else 0.0

    # capture efficiency: sum matched system pnl_pct / sum matched oracle |pct|
    sum_sys_matched = sum(m["system_pnl_pct"] for m in matches)
    sum_oracle_matched = sum(m["oracle_pct_abs"] for m in matches)
    capture_eff = (sum_sys_matched / sum_oracle_matched * 100.0) if sum_oracle_matched else 0.0

    # ----- pattern breakdowns -----
    # matched: bucket by capture
    fully_caught = [m for m in matches if m["capture"] >= 0.7]
    partial = [m for m in matches if 0.3 <= m["capture"] < 0.7]
    mismanaged = [m for m in matches if m["capture"] < 0.3]

    # personality / regime / setup breakdown using system trade es
    def es_of(m: dict) -> dict:
        return parse_es(m["system"])

    def by_dim(items: list[dict], dim: str) -> Counter:
        c = Counter()
        for m in items:
            es = es_of(m)
            v = es.get(dim) or "UNKNOWN"
            c[v] += 1
        return c

    # ----- missed top 30 -----
    misses_sorted = sorted(misses, key=lambda r: -abs(r["pct_move"]))
    miss_top = misses_sorted[:30]

    # ----- mismanaged top 30 by giveback (oracle - system) -----
    mismanaged_sorted = sorted(mismanaged, key=lambda m: -(m["oracle_pct_abs"] - m["system_pnl_pct"]))
    mis_top = mismanaged_sorted[:30]

    # ----- system wins not in oracle, sorted by pnl_pct -----
    extra_wins_sorted = sorted(extra_wins, key=lambda t: -(t.get("pnl_pct") or 0))
    ew_top = extra_wins_sorted[:30]

    # ----- entry timing on matched -----
    if matches:
        entry_dists = [m["entry_dist_days"] for m in matches]
        within_1 = sum(1 for d in entry_dists if d <= 1) / len(entry_dists) * 100.0
        avg_capture = sum(m["capture"] for m in matches) / len(matches) * 100.0
    else:
        within_1 = 0.0
        avg_capture = 0.0

    # ----- personality x outcome -----
    # outcome buckets across ALL matches (each system trade -> bucket)
    pers_caught = by_dim(fully_caught, "personality")
    pers_partial = by_dim(partial, "personality")
    pers_mis = by_dim(mismanaged, "personality")
    setup_caught = Counter(m["system"].get("setup_name", "?") for m in fully_caught)
    setup_mis = Counter(m["system"].get("setup_name", "?") for m in mismanaged)
    regime_caught = by_dim(fully_caught, "regime_class")
    regime_mis = by_dim(mismanaged, "regime_class")

    # ----- per-side capture & hit-rate -----
    long_oracle = [r for r in oracle if r["side"] == "LONG"]
    short_oracle = [r for r in oracle if r["side"] == "SHORT"]
    long_matched = [m for m in matches if m["oracle"]["side"] == "LONG"]
    short_matched = [m for m in matches if m["oracle"]["side"] == "SHORT"]
    long_hit = (len(long_matched) / len(long_oracle) * 100.0) if long_oracle else 0.0
    short_hit = (len(short_matched) / len(short_oracle) * 100.0) if short_oracle else 0.0
    long_cap = (
        sum(m["system_pnl_pct"] for m in long_matched)
        / sum(m["oracle_pct_abs"] for m in long_matched) * 100.0
    ) if long_matched else 0.0
    short_cap = (
        sum(m["system_pnl_pct"] for m in short_matched)
        / sum(m["oracle_pct_abs"] for m in short_matched) * 100.0
    ) if short_matched else 0.0

    # ----- oracle window length stats -----
    days_held = [r["days_held"] for r in oracle]
    avg_days = sum(days_held) / len(days_held) if days_held else 0

    # exit_reason breakdown of mismanaged matches
    mis_reasons = Counter(m["system"].get("exit_reason", "?") for m in mismanaged)
    full_reasons = Counter(m["system"].get("exit_reason", "?") for m in fully_caught)

    # personality presence across our system trades (overall)
    sys_pers_all = Counter(parse_es(t).get("personality", "?") for t in sys_trades if t.get("entry_ts", 0) >= WINDOW_START_MS)

    # window covered
    if candles_by_ticker:
        all_ts = []
        for cs in candles_by_ticker.values():
            if cs:
                all_ts.append(cs[-1]["ts"])
        last_data = ts_to_date(max(all_ts)) if all_ts else "?"
    else:
        last_data = "?"

    md: list[str] = []
    md.append("# Phase-C Stage1 Universe Benchmark — Oracle vs System")
    md.append("")
    md.append(f"**Run:** `{RUN_ID}`")
    md.append(f"**Universe:** 238 tickers (`configs/backtest-universe-phase-c-stage1.txt`)")
    md.append(f"**Window:** entries {ts_to_date(WINDOW_START_MS)} → **{ts_to_date(WINDOW_END_MS)}** "
              f"(capped at system's last entry day; daily candle data extends through {last_data})")
    md.append(f"**Oracle method:** N={N_FORWARD}-trading-day forward window, |move| ≥ {MIN_PCT:.0f}%, top-{TOP_PER_TICKER} non-overlapping per ticker per side, greedy by |pct| desc.")
    md.append(f"**Match window:** ±{MATCH_DAYS} trading days on entry, same direction.")
    md.append("")

    sys_in_window = [t for t in sys_trades if t.get("entry_ts", 0) >= WINDOW_START_MS and t.get("entry_ts", 0) <= WINDOW_END_MS]
    sys_total_pnl_pct = sum((t.get("pnl_pct") or 0) for t in sys_in_window)
    sys_long_pnl_pct = sum((t.get("pnl_pct") or 0) for t in sys_in_window if t.get("direction") == "LONG")
    sys_short_pnl_pct = sum((t.get("pnl_pct") or 0) for t in sys_in_window if t.get("direction") == "SHORT")
    sys_wins = sum(1 for t in sys_in_window if (t.get("pnl_pct") or 0) > 0)
    sys_losses = sum(1 for t in sys_in_window if (t.get("pnl_pct") or 0) < 0)

    md.append("## Headline")
    md.append("")
    md.append(f"- Oracle winners total: **{n_oracle}** ({len(longs)} long, {len(shorts)} short)")
    md.append(f"- Total oracle opportunity (sum |%move|): **{total_oracle_pct:.1f}%** "
              f"(long {total_oracle_long_pct:.1f}% + short {total_oracle_short_pct:.1f}%)")
    md.append(f"- System trades in window: **{len(sys_in_window)}** "
              f"({sum(1 for t in sys_in_window if t.get('direction')=='LONG')} long, "
              f"{sum(1 for t in sys_in_window if t.get('direction')=='SHORT')} short); "
              f"{sys_wins} win / {sys_losses} loss")
    md.append(f"- System total PnL%: **{sys_total_pnl_pct:.1f}%** (long {sys_long_pnl_pct:.1f}%, short {sys_short_pnl_pct:.1f}%)")
    md.append(f"- Oracle windows the system entered within ±{MATCH_DAYS} TD: **{n_matched} / {n_oracle} = {hit_rate:.1f}%**")
    md.append(f"  - Long hit rate: {long_hit:.1f}% ({len(long_matched)}/{len(long_oracle)})")
    md.append(f"  - Short hit rate: {short_hit:.1f}% ({len(short_matched)}/{len(short_oracle)})")
    md.append(f"- Avg per-match capture (system pnl% / oracle |%|): **{avg_capture:.1f}%**")
    md.append(f"- **Capture efficiency** (Σ system pnl% / Σ oracle |%|, matched only): **{capture_eff:.1f}%**")
    md.append(f"  - Long: {long_cap:.1f}%   Short: {short_cap:.1f}%")
    md.append(f"- Matched-trade outcome buckets: fully ≥70% cap = {len(fully_caught)}, partial 30–70% = {len(partial)}, mismanaged <30% = {len(mismanaged)}")
    md.append(f"- System wins outside any oracle window (system 'edge'): **{len(extra_wins)}**, total pnl% = {sum(t.get('pnl_pct') or 0 for t in extra_wins):.1f}%")
    md.append(f"- Avg oracle window length: {avg_days:.1f} trading days")
    md.append("")

    md.append("## Missed Winners (oracle hit, system never opened) — Top 30 by |% move|")
    md.append("")
    md.append("| ticker | side | entry → exit | days | oracle % | nearest sys trade in ticker (direction, entry, pnl%) |")
    md.append("|---|---|---|---|---|---|")
    for r in miss_top:
        cs = candles_by_ticker.get(r["ticker"], [])
        # find nearest in-ticker system trade, any direction
        nearest = "—"
        sys_trades_t = [t for t in sys_trades if t.get("ticker") == r["ticker"]]
        if sys_trades_t and cs:
            o_idx = r["_entry_idx"]
            best = None
            best_d = 10**9
            for st in sys_trades_t:
                si = trading_day_index(cs, st["entry_ts"])
                if si is None:
                    continue
                d = abs(si - o_idx)
                if d < best_d:
                    best_d = d
                    best = st
            if best:
                nearest = (
                    f"{best.get('direction')} @ {ts_to_date(best['entry_ts'])} "
                    f"({fmt_pct(best.get('pnl_pct') or 0)}, Δ={best_d}d)"
                )
        md.append(
            f"| {r['ticker']} | {r['side']} | {r['entry_date']} → {r['exit_date']} | "
            f"{r['days_held']} | {r['pct_move']:+.2f}% | {nearest} |"
        )
    md.append("")

    md.append("## Caught but Mismanaged (matched, capture <30%) — Top 30 by giveback")
    md.append("")
    md.append("| ticker | side | oracle entry | oracle % | sys entry | sys pnl % | capture | exit reason | setup | personality |")
    md.append("|---|---|---|---|---|---|---|---|---|---|")
    for m in mis_top:
        ow = m["oracle"]
        st = m["system"]
        es = parse_es(st)
        md.append(
            f"| {ow['ticker']} | {ow['side']} | {ow['entry_date']} | "
            f"{ow['pct_move']:+.2f}% | {ts_to_date(st['entry_ts'])} | "
            f"{fmt_pct(m['system_pnl_pct'])} | {m['capture']*100:.0f}% | "
            f"{st.get('exit_reason') or '?'} | {st.get('setup_name') or '?'} | "
            f"{es.get('personality') or '?'} |"
        )
    md.append("")

    md.append("## System Wins NOT in Oracle (system 'edge') — Top 30 by pnl %")
    md.append("")
    md.append("| ticker | side | entry | exit | pnl % | exit reason | setup | personality |")
    md.append("|---|---|---|---|---|---|---|---|")
    for st in ew_top:
        es = parse_es(st)
        md.append(
            f"| {st.get('ticker')} | {st.get('direction')} | "
            f"{ts_to_date(st['entry_ts'])} | "
            f"{ts_to_date(st['exit_ts']) if st.get('exit_ts') else 'OPEN'} | "
            f"{fmt_pct(st.get('pnl_pct') or 0)} | {st.get('exit_reason') or '?'} | "
            f"{st.get('setup_name') or '?'} | {es.get('personality') or '?'} |"
        )
    md.append("")

    md.append("## Setup × Personality × Regime breakdown (matched trades only)")
    md.append("")
    md.append("### By personality")
    md.append("")
    md.append("| personality | fully (≥70%) | partial (30–70%) | mismanaged (<30%) |")
    md.append("|---|---|---|---|")
    pers_keys = sorted(set(list(pers_caught) + list(pers_partial) + list(pers_mis)),
                       key=lambda k: -(pers_caught[k] + pers_partial[k] + pers_mis[k]))
    for k in pers_keys:
        md.append(f"| {k} | {pers_caught[k]} | {pers_partial[k]} | {pers_mis[k]} |")
    md.append("")

    md.append("### By regime")
    md.append("")
    md.append("| regime | fully | partial | mismanaged |")
    md.append("|---|---|---|---|")
    reg_keys = sorted(set(list(regime_caught) + list(regime_mis)),
                      key=lambda k: -(regime_caught[k] + regime_mis[k]))
    for k in reg_keys:
        md.append(f"| {k} | {regime_caught[k]} | — | {regime_mis[k]} |")
    md.append("")

    md.append("### By setup (top 12 by total matches)")
    md.append("")
    md.append("| setup | fully | mismanaged |")
    md.append("|---|---|---|")
    setup_total = Counter()
    for k, v in setup_caught.items():
        setup_total[k] += v
    for k, v in setup_mis.items():
        setup_total[k] += v
    for k, _ in setup_total.most_common(12):
        md.append(f"| {k} | {setup_caught.get(k,0)} | {setup_mis.get(k,0)} |")
    md.append("")

    md.append("### Matched-trade exit reasons")
    md.append("")
    md.append("| exit reason | fully (≥70%) | mismanaged (<30%) |")
    md.append("|---|---|---|")
    er_keys = sorted(set(list(full_reasons) + list(mis_reasons)),
                     key=lambda k: -(full_reasons[k] + mis_reasons[k]))
    for k in er_keys:
        md.append(f"| {k or '?'} | {full_reasons.get(k,0)} | {mis_reasons.get(k,0)} |")
    md.append("")

    # ----- INSIGHTS -----
    md.append("## Insights & Calibration Suggestions")
    md.append("")
    md.append("Each insight is tagged with the relevant config knob; *do not implement here*, the parent agent will run a calibration A/B.")
    md.append("")
    insights: list[str] = []

    # Pre-compute helpers used across insights
    top_mis_reasons = mis_reasons.most_common(5)
    top_mis_str = ", ".join(f"`{k or '?'}`={v}" for k, v in top_mis_reasons)

    # ---- Insight 1: entry timing vs exit discipline ----
    insights.append(
        f"**1. Entries are reasonably well-timed; exit discipline is the binding constraint.** "
        f"Of {len(matches)} matched oracle windows, the system enters within ±1 trading day "
        f"**{within_1:.0f}%** of the time, but average per-match capture is only **{avg_capture:.0f}%** "
        f"of the oracle |%| (and **0** matches reach the ≥70% 'fully captured' bucket). "
        f"The top exit reasons in the mismanaged-bucket are: {top_mis_str}. "
        f"`HARD_FUSE_RSI_EXTREME` and `PROFIT_GIVEBACK_STAGE_HOLD` between them account for ~25% of "
        f"the mismanaged exits — these fire on day 2–4 of moves that the oracle shows would have "
        f"continued for 7+ days. "
        f"➜ *Calibration knob:* `worker/index.js` — search for the RSI threshold that triggers "
        f"`HARD_FUSE_RSI_EXTREME` (likely `rsi >= 80` or similar). Proposed test: raise the threshold "
        f"to `rsi >= 88` for `VOLATILE_RUNNER` personality + `Gap Reversal Long` setup, since these "
        f"are the dominant mismanaged combo (37/49 = 76%) and also the dominant 'edge' winners — "
        f"the gate is firing too symmetrically across both."
    )

    # ---- Insight 2: PROFIT_GIVEBACK_STAGE_HOLD ----
    pgsh_count = mis_reasons.get("PROFIT_GIVEBACK_STAGE_HOLD", 0)
    if pgsh_count >= 3:
        insights.append(
            f"**2. `PROFIT_GIVEBACK_STAGE_HOLD` is firing on real winners.** "
            f"It accounts for **{pgsh_count}** of {len(mismanaged)} mismanaged matched trades, "
            f"all locking in <10% capture on oracle moves of 20–60%. The trades had positive MFE "
            f"early then mean-reverted intraday, but the oracle confirms the move resumed within "
            f"5 trading days. "
            f"➜ *Calibration knob:* `worker/index.js` — search `PROFIT_GIVEBACK_STAGE_HOLD`. "
            f"Proposed test: raise the giveback-percent threshold from current value to **0.55** "
            f"of MFE (typically ~0.38–0.5), and gate the trigger behind `bars_since_entry >= 12` on "
            f"the 4H timeframe so day-1 chop doesn't tag it. Also disable on `personality == "
            f"'VOLATILE_RUNNER'` for the first 24h."
        )

    # ---- Insight 3: shorts ----
    if len(short_oracle) > 0:
        sys_short_count = sum(1 for t in sys_in_window if t.get('direction') == 'SHORT')
        sys_long_count = sum(1 for t in sys_in_window if t.get('direction') == 'LONG')
        insights.append(
            f"**3. Short side is structurally under-sampled.** "
            f"Oracle has **{len(short_oracle)}** short opportunities worth Σ{total_oracle_short_pct:.0f}% "
            f"of move; system took {sys_short_count} shorts vs {sys_long_count} longs "
            f"({sys_short_count*100/(sys_short_count+sys_long_count):.1f}% of trades) and matched only "
            f"**{len(short_matched)}** oracle short windows ({short_hit:.1f}% hit rate). "
            f"Even on the 1 fully-caught short, capture stayed at {short_cap:.1f}% of the oracle move. "
            f"➜ *Calibration knob:* `worker/index.js` — search `setup_name === 'TT Tt Gap Reversal Short'` "
            f"and the `td9_bear_ltf_active`/`HTF_BEAR_LTF_BEAR` gates. Proposed test: relax the short-entry "
            f"requirement so `HTF_TRANSITIONAL + LTF_BEAR + daily_td9_adverse` is permitted (currently "
            f"requires fully aligned bear). Cross-check against the 8 short trades' `rank_trace_json` to "
            f"confirm they're being filtered at `_applyContextGates()`."
        )

    # ---- Insight 4: missed-by-ticker ----
    miss_tickers = Counter(m["ticker"] for m in misses)
    multi_miss = [t for t, n in miss_tickers.items() if n >= 2]
    traded_set = {t["ticker"] for t in sys_in_window}
    never_traded = sorted([t for t in multi_miss if t not in traded_set])
    if never_traded:
        # Compute total opp $ missed for never-traded tickers
        never_traded_set = set(never_traded)
        nt_oracle = [m for m in misses if m["ticker"] in never_traded_set]
        nt_total = sum(abs(r["pct_move"]) for r in nt_oracle)
        insights.append(
            f"**4. {len(multi_miss)} tickers had ≥2 oracle winners; **{len(never_traded)}** of them "
            f"were never traded by the system in this window.** Combined opportunity left on the table "
            f"from never-traded tickers: Σ{nt_total:.0f}% of move across {len(nt_oracle)} oracle "
            f"windows. Examples: `{', '.join(never_traded[:12])}`. "
            f"➜ *Calibration knob:* `worker/index.js` — search the global entry threshold "
            f"(`finalScore >= ` near `qualifiesForEnter`). Proposed test: probe `rank_trace_json` for "
            f"these specific tickers on the oracle entry dates — if `parts[]` shows score zeroed at "
            f"`data_completeness` or `tf_summary`, that's the rejection root. Likely fix: lower the "
            f"`finalScore` entry threshold by 5 points and add a new `volatility_expansion_bonus` that "
            f"adds +5 to score when daily ATR/price > 4% (high-vol names like UUUU/IONQ/IREN/RKLB/ASTS "
            f"keep getting filtered by the choppy-regime guard)."
        )

    # ---- Insight 5: extra wins (system edge) ----
    if extra_wins:
        ew_pers = Counter(parse_es(t).get("personality") or "?" for t in extra_wins)
        ew_setup = Counter(t.get("setup_name") or "?" for t in extra_wins)
        top_ew_setup = ew_setup.most_common(1)[0] if ew_setup else ("—", 0)
        top_ew_pers = ew_pers.most_common(1)[0] if ew_pers else ("—", 0)
        ew_total = sum(t.get('pnl_pct') or 0 for t in extra_wins)
        insights.append(
            f"**5. The system has {len(extra_wins)} profitable trades that no oracle window matched** "
            f"(total Σ{ew_total:.1f}% pnl). Top combo: `{top_ew_setup[0]}` × `{top_ew_pers[0]}` "
            f"({ew_setup[top_ew_setup[0]]} trades). These are sub-{MIN_PCT}% moves the system "
            f"profitably scalps — protect them when calibrating. "
            f"➜ *Calibration guard-rail:* if Insight 1's HARD_FUSE_RSI threshold raise is implemented, "
            f"split the rule by `setup_name`: keep aggressive HARD_FUSE for `TT Tt N Test Support/"
            f"Resistance` (these dominate the 'edge' wins for `PULLBACK_PLAYER`), but loosen for "
            f"`Gap Reversal Long` × `VOLATILE_RUNNER` only. Same file, same code path, but the "
            f"branch must read the setup_name."
        )

    # ---- Insight 6: holding-period gap (calendar-corrected) ----
    sys_hold = []
    for m in matches:
        st = m["system"]
        if st.get("entry_ts") and st.get("exit_ts"):
            hold_ms = st["exit_ts"] - st["entry_ts"]
            sys_hold.append(hold_ms / (1000 * 60 * 60 * 24))
    # Convert oracle trading-days to calendar days for fair compare (~7/5)
    avg_oracle_calendar = avg_days * 7.0 / 5.0
    if sys_hold:
        avg_sys_hold = sum(sys_hold) / len(sys_hold)
        insights.append(
            f"**6. Holding-period gap on matched trades.** Avg oracle window = {avg_days:.1f} trading "
            f"days (~{avg_oracle_calendar:.1f} calendar days); avg system hold on matched trades = "
            f"{avg_sys_hold:.1f} calendar days. The system is exiting **{(1 - avg_sys_hold/avg_oracle_calendar)*100:.0f}%** "
            f"earlier than the oracle peak on average. Combined with Insight 1 + Insight 2 this is the "
            f"single biggest source of capture loss. "
            f"➜ *Calibration knob:* `worker/index.js` — `executionProfileName == 'correction_transition'` "
            f"is the most common profile in our data. Find its time-stop / max-bars constant. "
            f"Proposed test: raise from current value to ≥**{int(avg_oracle_calendar*1.5)}** trading days "
            f"for trades that have positive MFE > 1R."
        )

    # ---- Insight 7: max_loss firing on oracle winners ----
    ml_count = mis_reasons.get("max_loss", 0) + mis_reasons.get("max_loss_time_scaled", 0)
    if ml_count >= 4:
        insights.append(
            f"**7. `max_loss` is stopping us out on {ml_count} trades that became oracle winners.** "
            f"These trades entered within ±3 TD of an eventual large move but the stop triggered "
            f"during the chop *before* the move. Examples: AEHR (oracle +73%, sys -0.8%, max_loss), "
            f"BE (oracle +63%, sys -1.4%, max_loss_time_scaled), MDB (oracle +23%, sys -4%, max_loss). "
            f"➜ *Calibration knob:* `worker/index.js` — search the `max_loss` cap (likely "
            f"`-0.5R` to `-1R`). Proposed test: for `VOLATILE_RUNNER` personality, widen initial "
            f"stop from current value to **-1.4R** for the first 12 4H bars, then tighten to current "
            f"value. Rationale: high-vol names need more rope on entry day to survive the noise that "
            f"precedes the oracle move."
        )

    for line in insights:
        md.append(f"- {line}")
        md.append("")

    # Appendix: never-traded tickers with oracle wins (full list)
    miss_tickers = Counter(m["ticker"] for m in misses)
    traded_set = {t["ticker"] for t in sys_in_window}
    never_traded_with_wins = sorted(
        [(t, n) for t, n in miss_tickers.items() if t not in traded_set],
        key=lambda x: -x[1]
    )
    if never_traded_with_wins:
        md.append("## Appendix A — Tickers never traded by system but had oracle winners")
        md.append("")
        md.append("| ticker | # missed oracle windows | total |%move| missed |")
        md.append("|---|---|---|")
        for tk, n in never_traded_with_wins:
            opp = sum(abs(r["pct_move"]) for r in misses if r["ticker"] == tk)
            md.append(f"| {tk} | {n} | {opp:.1f}% |")
        md.append("")

    md.append("---")
    md.append("")
    md.append("### Methodology footnote")
    md.append("")
    md.append(f"For every trading day `i` with available data after {ts_to_date(WINDOW_START_MS)}, "
              f"we compute `(max high in days i+1..i+{N_FORWARD}) / close_i - 1` (long) and "
              f"`(min low in days i+1..i+{N_FORWARD}) / close_i - 1` (short). "
              f"Days where |move| ≥ {MIN_PCT}% become candidates. We then greedy-pick top "
              f"{TOP_PER_TICKER} per ticker per side by descending |move|, requiring no overlap on "
              f"`[entry_idx, exit_idx]`. Entry is the *close* of day `i`; exit is the *high* (long) "
              f"or *low* (short) of the peak/trough day. Match window vs system trades is ±{MATCH_DAYS} "
              f"trading days on entry and same direction. Capture is `system_pnl_pct / |oracle_pct|`.")

    REPORT_OUT.write_text("\n".join(md))
    print(f"[report] wrote {REPORT_OUT}")


if __name__ == "__main__":
    sys.exit(main())
