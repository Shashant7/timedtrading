"""Decision-tree-style binary splits for each numeric / categorical signal.

For each feature, find the threshold that maximizes loser-shedding while
minimizing winner damage. Score = sum(loss_pnl_blocked) - sum(win_pnl_blocked).
"""
import json
from pathlib import Path
from collections import defaultdict

FEAT_FILE = Path("/workspace/tasks/phase-c/scripts/features.jsonl")


def load_rows():
    rows = []
    with FEAT_FILE.open() as f:
        for line in f:
            rows.append(json.loads(line))
    return rows


def closed_long(rows):
    return [r for r in rows if r.get("is_closed") and r.get("direction") == "LONG"]


def closed_short(rows):
    return [r for r in rows if r.get("is_closed") and r.get("direction") == "SHORT"]


def closed(rows):
    return [r for r in rows if r.get("is_closed")]


def evaluate_block(blocked):
    """blocked = list of trades that would have been blocked.
    Returns dict of metrics."""
    losers = [r for r in blocked if r["bucket"] == "LOSS"]
    winners = [r for r in blocked if r["bucket"] == "WIN"]
    loss_pnl = sum(r["pnl"] for r in losers)
    win_pnl = sum(r["pnl"] for r in winners)
    n = len(blocked)
    return {
        "blocked_n": n,
        "blocked_wins": len(winners),
        "blocked_losses": len(losers),
        "blocked_win_pnl": round(win_pnl, 2),
        "blocked_loss_pnl": round(loss_pnl, 2),
        "net_lift": round(-loss_pnl - win_pnl, 2),  # losers avoided minus winners forfeit
        "block_wr": round(len(winners) / max(n, 1) * 100, 1),
    }


def numeric_split(rows, field, candidate_thresholds=None, direction=None, op=">="):
    """For numeric field, try each threshold, return best by net_lift.
    op: '>=' or '<='. The signal triggers (block applies) when value op threshold.
    """
    pool = [r for r in rows if isinstance(r.get(field), (int, float)) and not isinstance(r.get(field), bool)]
    if direction:
        pool = [r for r in pool if r.get("direction") == direction]
    pool = [r for r in pool if r.get("is_closed")]
    if not pool:
        return None
    vals = sorted({r[field] for r in pool})
    if candidate_thresholds is None:
        # Use value points (skip dupes)
        candidate_thresholds = vals
    best = None
    for thr in candidate_thresholds:
        if op == ">=":
            blocked = [r for r in pool if r[field] >= thr]
        else:
            blocked = [r for r in pool if r[field] <= thr]
        m = evaluate_block(blocked)
        m["thr"] = thr
        if best is None or m["net_lift"] > best["net_lift"]:
            best = m
    return best


def categorical_split(rows, field, direction=None):
    pool = closed(rows)
    if direction:
        pool = [r for r in pool if r.get("direction") == direction]
    by_val = defaultdict(list)
    for r in pool:
        v = r.get(field)
        if isinstance(v, (list, dict)):
            v = json.dumps(v, sort_keys=True)
        by_val[v].append(r)
    results = []
    for val, group in by_val.items():
        m = evaluate_block(group)
        m["value"] = val
        m["total_pop"] = len(pool)
        results.append(m)
    results.sort(key=lambda x: -x["net_lift"])
    return results


def fmt(m):
    if not m:
        return "(no data)"
    return (
        f"thr={m.get('thr','-')} | val={m.get('value','-')} | "
        f"blocked_n={m['blocked_n']} ({m['blocked_wins']}W/{m['blocked_losses']}L, WR={m['block_wr']}%) | "
        f"loss_pnl_avoided=${-m['blocked_loss_pnl']:.0f} | win_pnl_forfeit=${-m['blocked_win_pnl']:.0f} | "
        f"NET_LIFT=${m['net_lift']:.0f}"
    )


def main():
    rows = load_rows()
    long_rows = closed_long(rows)
    short_rows = closed_short(rows)

    # Top-line summary
    all_closed = closed(rows)
    losers = [r for r in all_closed if r["bucket"] == "LOSS"]
    winners = [r for r in all_closed if r["bucket"] == "WIN"]
    print(f"Closed: {len(all_closed)} (W={len(winners)}, L={len(losers)})")
    print(f"Total winner $: {sum(r['pnl'] for r in winners):.0f}")
    print(f"Total loser $: {sum(r['pnl'] for r in losers):.0f}")
    print(f"Net $: {sum(r['pnl'] for r in all_closed):.0f}")
    print(f"Long count: {len(long_rows)}, Short count: {len(short_rows)}")
    print()

    # Numeric features (LONG-side primarily, since 167/175 are LONG)
    print("=" * 80)
    print("NUMERIC SPLITS — LONG-side only (167 LONG vs 8 SHORT)")
    print("=" * 80)

    numeric_fields = [
        # VWAP distance
        ("vwap_240_dist_pct", ">="),
        ("vwap_D_dist_pct", ">="),
        ("vwap_W_dist_pct", ">="),
        ("vwap_60_dist_pct", ">="),
        ("vwap_30_dist_pct", ">="),
        ("vwap_240_slope_5bar", "<="),
        ("vwap_D_slope_5bar", "<="),
        # TD seq adverse
        ("td_240_bear_prep", ">="),
        ("td_D_bear_prep", ">="),
        ("td_60_bear_prep", ">="),
        ("td_30_bear_prep", ">="),
        ("td_W_bear_prep", ">="),
        # Divergence
        ("div_adverse_phase_count", ">="),
        ("div_adverse_phase_strongest_strength", ">="),
        ("div_adverse_phase_strongest_barsSince", "<="),
        ("div_adverse_rsi_count", ">="),
        ("div_adverse_rsi_strongest_strength", ">="),
        # RSI / extension
        ("ss_rsi", ">="),
        ("ss_pct_above_e21", ">="),
        ("ss_pct_above_e48", ">="),
        ("ss_e21_slope_5d", "<="),
        # Stack scores
        ("ss_bull_stack", "<="),
        ("ss_bear_stack", ">="),
        ("ss_htf_score", "<="),
        ("ss_ltf_score", "<="),
        ("ss_rvol_30m", "<="),
        ("ss_rvol_best", "<="),
        # rank, rr
        ("rank", ">="),
        ("rr", "<="),
        ("focus_conviction_score", "<="),
        ("finalScore", "<="),
        ("rawScore", "<="),
        # Cross-asset
        ("ca_btc_pct", "<="),
        # Market internals
        ("mi_offense_avg_pct", "<="),
    ]

    for field, op in numeric_fields:
        m = numeric_split(rows, field, direction="LONG", op=op)
        if m and m["net_lift"] > 0:
            print(f"  [LONG] {field} {op} {m['thr']}: {fmt(m)}")

    print()
    print("=" * 80)
    print("CATEGORICAL SPLITS — LONG-side")
    print("=" * 80)

    cat_fields = [
        "es_pdz_d", "es_pdz_4h", "pdz_D", "pdz_h4", "pdz_h1",
        "es_personality", "es_regime_class", "ss_regime_combined",
        "ss_execution_profile", "ss_selected_path", "setup_name",
        "ss_st_dir", "ss_above_e200",
        "es_has_adverse_rsi_div", "es_has_adverse_phase_div",
        "es_is_f4_severe", "es_daily_td9_adverse",
        "es_daily_adverse_prep", "es_fourh_adverse_prep",
        "es_td9_bear_ltf_active",
        "div_adverse_phase_strongest_tf",
        "div_adverse_rsi_strongest_tf",
        "mi_overall", "mi_sector_rotation", "mi_vix_state",
        "ss_sector_alignment", "sector",
        "entry_hour_ny", "entry_dow",
    ]

    for field in cat_fields:
        results = categorical_split(rows, field, direction="LONG")
        # Print only buckets where blocking would help (net_lift > 0)
        helpful = [r for r in results if r["net_lift"] > 50 and r["blocked_n"] >= 3]
        if helpful:
            print(f"\n  [LONG] {field}:")
            for r in helpful:
                print(f"    {fmt(r)}")


if __name__ == "__main__":
    main()
