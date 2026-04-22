#!/usr/bin/env python3
"""
validate-rank-v2.py

Simulate the computeRankV2 formula against v10b's 101 closed trades using
their signal_snapshot_json at entry time. Compare rank-v2 to actual outcomes.

Success criteria: Pearson(rank_v2, pnl_pct) > +0.25 (vs current ~0).
"""

import json
import statistics
from pathlib import Path

SNAPSHOT = Path("data/trade-analysis/phase-h-v10b-1776787446/final-snapshot/trades-live-premortem.json")


def compute_rank_v2(t):
    """Mirror worker/index.js::computeRankV2 in Python."""
    ss = t.get("signal_snapshot") or {}
    ep = t.get("execution_profile") or {}
    side = t.get("direction", "LONG")
    sign = 1 if side == "LONG" else -1

    score = 50
    parts = []

    # setup_grade
    grade = str(t.get("setup_grade") or "").lower()
    if grade == "confirmed":
        score += 10
        parts.append(("grade_confirmed", +10))
    elif grade == "prime":
        score += 2
        parts.append(("grade_prime", +2))

    # RSI divergence
    rsi_div = ss.get("rsi_divergence") or {}
    bull_active = False
    bear_active = False
    for tf, v in rsi_div.items() if isinstance(rsi_div, dict) else []:
        if isinstance(v, dict):
            bull = v.get("bull") or {}
            bear = v.get("bear") or {}
            if isinstance(bull, dict) and bull.get("active"):
                bull_active = True
            if isinstance(bear, dict) and bear.get("active"):
                bear_active = True
    if side == "LONG" and bull_active:
        score += 8
        parts.append(("rsi_bull_div", +8))
    elif side == "SHORT" and bear_active:
        score += 5
        parts.append(("rsi_bear_div", +5))

    # regime_class
    regime_class = str(
        ep.get("regime_class")
        or ss.get("lineage", {}).get("regime_class", "")
        or ""
    ).upper()
    if regime_class == "TRENDING":
        score += 6
        parts.append(("trending_regime", +6))
    elif regime_class == "TRANSITIONAL":
        score -= 10
        parts.append(("transitional_regime", -10))

    # Supertrend 30m
    st30 = None
    st = ss.get("supertrend") or {}
    if isinstance(st, dict):
        tf30 = st.get("30") or st.get("30m")
        if isinstance(tf30, dict):
            st30 = tf30.get("d")
    if st30 is not None:
        if (side == "LONG" and st30 > 0) or (side == "SHORT" and st30 < 0):
            score += 4
            parts.append(("st30_aligned", +4))

    # RR — need from trade. V10b trades don't store rr directly in flat fields.
    # Approximate from lifecycle_risk_amount and notional, or skip.
    rr = None
    # Try deriving from risk_budget path
    rb = t.get("risk_budget")
    # RR not in flat fields for v10b. Skip this term but note it.
    # Score contribution from RR is 0 in this simulation.

    # ATR displacement
    atr = ss.get("atr_disp") or {}
    atr_day = atr.get("day") or {}
    atr_week = atr.get("week") or {}
    if atr_week.get("ge") is True:
        atr_d = atr_week.get("d") or 0
        if atr_d * sign >= 0.3:
            score -= 20
            parts.append(("atr_week_extended", -20))
    elif atr_day.get("ge") is True:
        atr_d = atr_day.get("d") or 0
        if atr_d * sign >= 0.3:
            score -= 10
            parts.append(("atr_day_extended", -10))

    # Phase over-extension
    saty = ss.get("saty_phase") or {}
    phase_1h = None
    phase_d = None
    if isinstance(saty.get("1H"), dict):
        phase_1h = saty["1H"].get("v")
    if isinstance(saty.get("D"), dict):
        phase_d = saty["D"].get("v")
    if phase_1h is not None and phase_1h > 70:
        score -= 8
        parts.append(("phase_1H_high", -8))
    if phase_d is not None and phase_d > 70:
        score -= 8
        parts.append(("phase_D_high", -8))

    # Phase zone HIGH
    phase_1h_z = str(saty.get("1H", {}).get("z", "") if isinstance(saty.get("1H"), dict) else "").upper()
    if phase_1h_z == "HIGH":
        score -= 6
        parts.append(("phase_1H_zone_HIGH", -6))

    # LTF over-alignment
    tf_30m = (ss.get("tf") or {}).get("30m") or {}
    tf30_bias = tf_30m.get("bias") if isinstance(tf_30m, dict) else None
    if tf30_bias is not None:
        if tf30_bias * sign > 0.5:
            score -= 4
            parts.append(("ltf_overaligned", -4))

    # Note: SHORT-vs-SPY penalty cannot be computed from trade snapshot alone
    # (we don't have SPY's state at that moment). Skip.

    score = max(0, min(100, score))
    return int(round(score)), parts


def load_v10b():
    d = json.load(open(SNAPSHOT))
    trades = [t for t in d["trades"] if t.get("run_id") == "phase-h-v10b-1776787446"]
    closed = [t for t in trades if t.get("exit_ts")]
    enriched = []
    for t in closed:
        ss_raw = t.get("signal_snapshot_json")
        ep_raw = t.get("execution_profile_json")
        try:
            ss = json.loads(ss_raw) if isinstance(ss_raw, str) else (ss_raw or {})
        except Exception:
            ss = {}
        try:
            ep = json.loads(ep_raw) if isinstance(ep_raw, str) else (ep_raw or {})
        except Exception:
            ep = {}
        enriched.append({
            "ticker": t.get("ticker"),
            "direction": t.get("direction"),
            "pnl_pct": float(t.get("pnl_pct") or 0),
            "setup_grade": t.get("setup_grade"),
            "signal_snapshot": ss,
            "execution_profile": ep,
            "entry_quality_score": t.get("entry_quality_score"),
        })
    return enriched


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return 0
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    den = (sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys)) ** 0.5
    return num / den if den else 0


def main():
    trades = load_v10b()
    print(f"Loaded {len(trades)} closed v10b trades\n")

    ranks_v2 = []
    pnls = []
    for t in trades:
        rank_v2, parts = compute_rank_v2(t)
        t["__rank_v2"] = rank_v2
        t["__rank_v2_parts"] = parts
        ranks_v2.append(rank_v2)
        pnls.append(t["pnl_pct"])

    corr = pearson(ranks_v2, pnls)
    print(f"=== RANK-V2 CORRELATION WITH OUTCOMES ===")
    print(f"  Pearson(rank_v2, pnl_pct) = {corr:+.3f}")
    print(f"  Pearson(old_rank == entry_quality_score, pnl_pct) = ", end="")
    old_ranks = [t.get("entry_quality_score") or 0 for t in trades]
    print(f"{pearson(old_ranks, pnls):+.3f}")

    # Distribution
    print(f"\n=== RANK-V2 DISTRIBUTION ===")
    bins = [(90, 100), (80, 89), (70, 79), (60, 69), (50, 59), (0, 49)]
    print(f"{'Range':<10} {'N':>4} {'WR%':>6} {'Avg%':>7} {'Sum%':>9}")
    for lo, hi in bins:
        sub = [t for t in trades if lo <= t["__rank_v2"] <= hi]
        if not sub:
            continue
        wins = [t for t in sub if t["pnl_pct"] > 0]
        wr = len(wins) / len(sub) * 100
        avg = sum(t["pnl_pct"] for t in sub) / len(sub)
        sum_pnl = sum(t["pnl_pct"] for t in sub)
        print(f"  {lo}-{hi:<5} {len(sub):>4} {wr:>5.1f}% {avg:>+6.2f}% {sum_pnl:>+8.2f}%")

    # Top-20 ranked trades outcome
    print(f"\n=== TOP 20 BY RANK-V2 ===")
    top20 = sorted(trades, key=lambda x: -x["__rank_v2"])[:20]
    wins20 = [t for t in top20 if t["pnl_pct"] > 0]
    print(f"  WR: {len(wins20)/20*100:.1f}%, SumPnL: {sum(t['pnl_pct'] for t in top20):+.2f}%")
    for t in top20:
        print(f"  rank_v2={t['__rank_v2']:>3} {t['ticker']:<6} {t['direction']:<6} pnl={t['pnl_pct']:>+6.2f}% grade={t['setup_grade']}")

    # Bottom 20
    print(f"\n=== BOTTOM 20 BY RANK-V2 ===")
    bot20 = sorted(trades, key=lambda x: x["__rank_v2"])[:20]
    wins_b = [t for t in bot20 if t["pnl_pct"] > 0]
    print(f"  WR: {len(wins_b)/20*100:.1f}%, SumPnL: {sum(t['pnl_pct'] for t in bot20):+.2f}%")
    for t in bot20:
        print(f"  rank_v2={t['__rank_v2']:>3} {t['ticker']:<6} {t['direction']:<6} pnl={t['pnl_pct']:>+6.2f}%")

    # Filter impact simulation: what if rank_v2 floor=60 (drop bottom tier)?
    print(f"\n=== FILTER IMPACT SIMULATION ===")
    for floor in [50, 55, 60, 65, 70, 75]:
        kept = [t for t in trades if t["__rank_v2"] >= floor]
        dropped = [t for t in trades if t["__rank_v2"] < floor]
        if not kept:
            continue
        kw = len([t for t in kept if t["pnl_pct"] > 0])
        dw = len([t for t in dropped if t["pnl_pct"] > 0])
        ksum = sum(t["pnl_pct"] for t in kept)
        dsum = sum(t["pnl_pct"] for t in dropped)
        print(f"  floor={floor}: kept={len(kept)} (WR={kw/len(kept)*100:.1f}%, sum={ksum:+.2f}%) | dropped={len(dropped)} (sum={dsum:+.2f}%)")


if __name__ == "__main__":
    main()
