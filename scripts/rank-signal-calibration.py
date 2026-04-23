#!/usr/bin/env python3
"""
rank-signal-calibration.py

Empirically calibrate the computeRank formula by extracting each signal
from the v10b trade snapshots and measuring WR / PnL lift per signal.

Dataset: v10b's 101 closed trades, which carry full signal_snapshot_json
with all raw inputs that feed computeRank.

Method: for each signal S, compute
  - base_rate: overall WR and avg PnL% across all trades
  - signal_on_rate: WR and avg PnL% when S is "on" / above threshold
  - signal_off_rate: WR and avg PnL% when S is "off" / below
  - lift: signal_on - signal_off
  - lift_per_pct_pnl: difference in avg PnL%

Signals with no meaningful lift (|WR_lift| < 5%) should have their
current weight in computeRank REDUCED or REMOVED.

Signals with meaningful POSITIVE lift get increased weight proportional
to their predictive power.

Output: tasks/rank-calibration-findings-2026-04-22.md
"""

import json
import statistics
from collections import defaultdict
from pathlib import Path


SNAPSHOT_PATH = Path("data/trade-analysis/phase-h-v10b-1776787446/final-snapshot/trades-live-premortem.json")


def load_v10b_trades():
    """Load v10b closed trades with signal_snapshot + execution_profile extracted."""
    d = json.load(open(SNAPSHOT_PATH))
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
            "mfe_pct": float(t.get("max_favorable_excursion") or 0),
            "status": t.get("status"),
            "setup_name": t.get("setup_name"),
            "setup_grade": t.get("setup_grade"),
            "entry_quality_score": t.get("entry_quality_score"),
            "signal_snapshot": ss,
            "execution_profile": ep,
        })
    return enriched


def extract_signal(t, path):
    """Navigate nested dict by list-of-keys path, tolerant of missing keys."""
    ss = t.get("signal_snapshot") or {}
    ep = t.get("execution_profile") or {}
    for source_name, source in [("signal_snapshot", ss), ("execution_profile", ep)]:
        cursor = source
        ok = True
        for p in path:
            if isinstance(cursor, dict) and p in cursor:
                cursor = cursor[p]
            else:
                ok = False
                break
        if ok:
            return cursor
    return None


def stats_for_subset(trades):
    if not trades:
        return {"n": 0, "wr": None, "avg_pnl": None, "sum_pnl": None}
    wins = [t for t in trades if t["pnl_pct"] > 0]
    wr = len(wins) / len(trades) * 100
    avg = sum(t["pnl_pct"] for t in trades) / len(trades)
    ssum = sum(t["pnl_pct"] for t in trades)
    return {"n": len(trades), "wr": wr, "avg_pnl": avg, "sum_pnl": ssum}


def row(label, on, off, base):
    wr_lift = (on["wr"] or 0) - (base["wr"] or 0)
    pnl_lift = (on["avg_pnl"] or 0) - (base["avg_pnl"] or 0)
    on_wr = f"{on['wr']:.1f}%" if on["wr"] is not None else "—"
    on_pnl = f"{on['avg_pnl']:+.2f}%" if on["avg_pnl"] is not None else "—"
    off_wr = f"{off['wr']:.1f}%" if off["wr"] is not None else "—"
    off_pnl = f"{off['avg_pnl']:+.2f}%" if off["avg_pnl"] is not None else "—"
    wr_lift_s = f"{wr_lift:+5.1f}" if wr_lift is not None else "—"
    pnl_lift_s = f"{pnl_lift:+5.2f}" if pnl_lift is not None else "—"
    print(f"  {label:<40} n_on={on['n']:>3} WR={on_wr:<7} PnL={on_pnl:<8} | "
          f"n_off={off['n']:>3} WR={off_wr:<7} PnL={off_pnl:<8} | lift_WR={wr_lift_s} lift_PnL={pnl_lift_s}")


def main():
    trades = load_v10b_trades()
    print(f"Loaded {len(trades)} closed v10b trades with snapshots\n")

    base = stats_for_subset(trades)
    print(f"BASE RATES: n={base['n']} WR={base['wr']:.1f}% avg_PnL={base['avg_pnl']:+.2f}%\n")
    print(f"{'SIGNAL':<40} {'ON':<32} {'OFF':<32} {'LIFT'}")
    print(f"{'-' * 40} {'-' * 32} {'-' * 32} {'-' * 20}")

    # ─────────────────────────────────────────────
    # GROUP 1: State-based (current weight: +4 to +12)
    # ─────────────────────────────────────────────
    print("\n[GROUP 1] State — current weights: aligned_state=+12, setup_state=+4")
    state_field_paths = [
        ["lineage", "state"],  # most reliable in signal_snapshot
    ]
    for t in trades:
        for p in state_field_paths:
            s = extract_signal(t, p)
            if s:
                t["__state"] = str(s)
                break
        else:
            t["__state"] = ""

    aligned = [t for t in trades if t["__state"] in ("HTF_BULL_LTF_BULL", "HTF_BEAR_LTF_BEAR")]
    setup = [t for t in trades if "PULLBACK" in t["__state"]]
    other = [t for t in trades if t["__state"] not in ("HTF_BULL_LTF_BULL", "HTF_BEAR_LTF_BEAR") and "PULLBACK" not in t["__state"]]

    row("aligned_state (HTF_X_LTF_X matching)", stats_for_subset(aligned),
        stats_for_subset([t for t in trades if t not in aligned]), base)
    row("setup_state (HTF_X_LTF_PULLBACK)", stats_for_subset(setup),
        stats_for_subset([t for t in trades if t not in setup]), base)
    row("neither", stats_for_subset(other),
        stats_for_subset([t for t in trades if t not in other]), base)

    # ─────────────────────────────────────────────
    # GROUP 2: HTF / LTF scores (current: up to +10 each)
    # ─────────────────────────────────────────────
    print("\n[GROUP 2] HTF / LTF bias scores")
    for t in trades:
        # HTF score from signal_snapshot.tf.D.bias (or 4H)
        tf = extract_signal(t, ["tf"]) or {}
        t["__htf_bias"] = tf.get("D", {}).get("bias") if isinstance(tf, dict) else None
        t["__ltf_bias"] = tf.get("30m", {}).get("bias") if isinstance(tf, dict) else None
        t["__4h_bias"] = tf.get("4H", {}).get("bias") if isinstance(tf, dict) else None

    # HTF strong alignment with trade direction
    htf_aligned = []
    for t in trades:
        htf = t["__htf_bias"]
        if htf is None: continue
        sign = 1 if t["direction"] == "LONG" else -1
        if htf * sign >= 0.5:
            htf_aligned.append(t)
    row("HTF_D bias aligned with direction (|bias|>=0.5)", stats_for_subset(htf_aligned),
        stats_for_subset([t for t in trades if t not in htf_aligned]), base)

    ltf_aligned = []
    for t in trades:
        ltf = t["__ltf_bias"]
        if ltf is None: continue
        sign = 1 if t["direction"] == "LONG" else -1
        if ltf * sign >= 0.3:
            ltf_aligned.append(t)
    row("LTF_30m bias aligned with direction", stats_for_subset(ltf_aligned),
        stats_for_subset([t for t in trades if t not in ltf_aligned]), base)

    h4_aligned = []
    for t in trades:
        h4 = t["__4h_bias"]
        if h4 is None: continue
        sign = 1 if t["direction"] == "LONG" else -1
        if h4 * sign >= 0.5:
            h4_aligned.append(t)
    row("4H bias aligned with direction", stats_for_subset(h4_aligned),
        stats_for_subset([t for t in trades if t not in h4_aligned]), base)

    # All three TFs aligned
    all_aligned = [t for t in trades
                   if t in htf_aligned and t in ltf_aligned and t in h4_aligned]
    row("ALL 3 TFs (D+4H+30m) aligned", stats_for_subset(all_aligned),
        stats_for_subset([t for t in trades if t not in all_aligned]), base)

    # ─────────────────────────────────────────────
    # GROUP 3: Volume (rvol)
    # ─────────────────────────────────────────────
    print("\n[GROUP 3] RVol at entry (not currently in rank, but H.3 consensus gate uses)")
    for t in trades:
        rvol = extract_signal(t, ["rvol"]) or {}
        t["__rvol_30"] = rvol.get("30m") if isinstance(rvol, dict) else None
        t["__rvol_1h"] = rvol.get("1H") if isinstance(rvol, dict) else None

    rvol_high = [t for t in trades if (t["__rvol_30"] or 0) >= 2.0]
    rvol_mid = [t for t in trades if 1.2 <= (t["__rvol_30"] or 0) < 2.0]
    rvol_low = [t for t in trades if (t["__rvol_30"] or 0) < 1.2 and t["__rvol_30"] is not None]
    row("rvol_30m >= 2.0x", stats_for_subset(rvol_high),
        stats_for_subset([t for t in trades if t not in rvol_high]), base)
    row("rvol_30m 1.2-2.0x", stats_for_subset(rvol_mid),
        stats_for_subset([t for t in trades if t not in rvol_mid]), base)
    row("rvol_30m < 1.2x", stats_for_subset(rvol_low),
        stats_for_subset([t for t in trades if t not in rvol_low]), base)

    # ─────────────────────────────────────────────
    # GROUP 4: Supertrend direction (per TF)
    # ─────────────────────────────────────────────
    print("\n[GROUP 4] Supertrend direction (not directly weighted but affects state)")
    for t in trades:
        st = extract_signal(t, ["supertrend"]) or {}
        for tf in ["30", "1H", "4H", "D"]:
            if isinstance(st.get(tf), dict):
                t[f"__st_{tf}"] = st[tf].get("d")
            else:
                t[f"__st_{tf}"] = None

    for tf in ["30", "1H", "4H", "D"]:
        aligned = [t for t in trades
                   if t.get(f"__st_{tf}") is not None
                   and ((t["direction"] == "LONG" and t[f"__st_{tf}"] > 0) or
                        (t["direction"] == "SHORT" and t[f"__st_{tf}"] < 0))]
        row(f"supertrend_{tf} aligned", stats_for_subset(aligned),
            stats_for_subset([t for t in trades if t not in aligned]), base)

    # All 4 supertrend aligned
    all_st = [t for t in trades
              if all(
                  (t.get(f"__st_{tf}") is not None and
                   ((t["direction"] == "LONG" and t[f"__st_{tf}"] > 0) or
                    (t["direction"] == "SHORT" and t[f"__st_{tf}"] < 0)))
                  for tf in ["30", "1H", "4H", "D"])]
    row("ALL supertrends aligned", stats_for_subset(all_st),
        stats_for_subset([t for t in trades if t not in all_st]), base)

    # ─────────────────────────────────────────────
    # GROUP 5: Ripster cloud (EMA clouds)
    # ─────────────────────────────────────────────
    print("\n[GROUP 5] Ripster clouds (indirect via state classification)")
    for t in trades:
        rc = extract_signal(t, ["ripster_clouds"]) or {}
        for tf in ["D", "4H", "1H"]:
            c = rc.get(tf, {}) if isinstance(rc, dict) else {}
            t[f"__cloud_{tf}_bull"] = c.get("c34_50", {}).get("b") if isinstance(c.get("c34_50"), dict) else None

    for tf in ["D", "4H", "1H"]:
        aligned = [t for t in trades
                   if t.get(f"__cloud_{tf}_bull") is not None
                   and ((t["direction"] == "LONG" and t[f"__cloud_{tf}_bull"] == 1) or
                        (t["direction"] == "SHORT" and t[f"__cloud_{tf}_bull"] == 0))]
        row(f"ripster_cloud_34_50 {tf} aligned", stats_for_subset(aligned),
            stats_for_subset([t for t in trades if t not in aligned]), base)

    # ─────────────────────────────────────────────
    # GROUP 6: Saty phase zones
    # ─────────────────────────────────────────────
    print("\n[GROUP 6] Saty Phase")
    for t in trades:
        phase = extract_signal(t, ["saty_phase"]) or {}
        for tf in ["30", "1H", "4H", "D", "W"]:
            if isinstance(phase.get(tf), dict):
                t[f"__phase_{tf}_v"] = phase[tf].get("v")
                t[f"__phase_{tf}_z"] = phase[tf].get("z")
            else:
                t[f"__phase_{tf}_v"] = None
                t[f"__phase_{tf}_z"] = None

    # Phase_30m LOW
    for tf in ["30", "1H", "D"]:
        low_z = [t for t in trades if t.get(f"__phase_{tf}_z") == "LOW"]
        high_z = [t for t in trades if t.get(f"__phase_{tf}_z") == "HIGH"]
        row(f"phase_{tf}_zone LOW", stats_for_subset(low_z),
            stats_for_subset([t for t in trades if t not in low_z]), base)
        if high_z:
            row(f"phase_{tf}_zone HIGH", stats_for_subset(high_z),
                stats_for_subset([t for t in trades if t not in high_z]), base)

    # Phase below 30% (early move, not over-extended)
    for tf in ["30", "1H", "D"]:
        early = [t for t in trades if (t.get(f"__phase_{tf}_v") or 100) < 30]
        late = [t for t in trades if (t.get(f"__phase_{tf}_v") or 0) > 70]
        row(f"phase_{tf}_v < 30 (early)", stats_for_subset(early),
            stats_for_subset([t for t in trades if t not in early]), base)
        row(f"phase_{tf}_v > 70 (over-extended)", stats_for_subset(late),
            stats_for_subset([t for t in trades if t not in late]), base)

    # ─────────────────────────────────────────────
    # GROUP 7: RSI + Divergence
    # ─────────────────────────────────────────────
    print("\n[GROUP 7] RSI & divergence")
    for t in trades:
        rsi_div = extract_signal(t, ["rsi_divergence"]) or {}
        # Any active bullish/bearish divergence
        has_bull_div = False
        has_bear_div = False
        for tf, v in (rsi_div.items() if isinstance(rsi_div, dict) else []):
            if isinstance(v, dict):
                bull = v.get("bull") or {}
                bear = v.get("bear") or {}
                if isinstance(bull, dict) and bull.get("active"):
                    has_bull_div = True
                if isinstance(bear, dict) and bear.get("active"):
                    has_bear_div = True
        t["__has_bull_div"] = has_bull_div
        t["__has_bear_div"] = has_bear_div

    bull_div = [t for t in trades if t["__has_bull_div"]]
    bear_div = [t for t in trades if t["__has_bear_div"]]
    row("RSI bull divergence present", stats_for_subset(bull_div),
        stats_for_subset([t for t in trades if t not in bull_div]), base)
    row("RSI bear divergence present", stats_for_subset(bear_div),
        stats_for_subset([t for t in trades if t not in bear_div]), base)

    # Phase divergence
    for t in trades:
        pd = extract_signal(t, ["phase_divergence"]) or {}
        has_pd_bull = False
        has_pd_bear = False
        for tf, v in (pd.items() if isinstance(pd, dict) else []):
            if isinstance(v, dict):
                bull = v.get("bull") or {}
                bear = v.get("bear") or {}
                if isinstance(bull, dict) and bull.get("active"):
                    has_pd_bull = True
                if isinstance(bear, dict) and bear.get("active"):
                    has_pd_bear = True
        t["__has_pd_bull"] = has_pd_bull
        t["__has_pd_bear"] = has_pd_bear

    pd_bull = [t for t in trades if t["__has_pd_bull"]]
    pd_bear = [t for t in trades if t["__has_pd_bear"]]
    row("Phase bull divergence present", stats_for_subset(pd_bull),
        stats_for_subset([t for t in trades if t not in pd_bull]), base)
    row("Phase bear divergence present", stats_for_subset(pd_bear),
        stats_for_subset([t for t in trades if t not in pd_bear]), base)

    # ─────────────────────────────────────────────
    # GROUP 8: ATR displacement
    # ─────────────────────────────────────────────
    print("\n[GROUP 8] ATR displacement")
    for t in trades:
        atr = extract_signal(t, ["atr_disp"]) or {}
        for window in ["day", "week", "month"]:
            if isinstance(atr.get(window), dict):
                t[f"__atr_{window}_d"] = atr[window].get("d")
                t[f"__atr_{window}_ge"] = atr[window].get("ge")
                t[f"__atr_{window}_gc"] = atr[window].get("gc")
            else:
                t[f"__atr_{window}_d"] = None

    # Golden Gate expanded (ge=true)
    for window in ["day", "week"]:
        ge_on = [t for t in trades if t.get(f"__atr_{window}_ge")]
        row(f"ATR_{window} Golden Gate expanded", stats_for_subset(ge_on),
            stats_for_subset([t for t in trades if t not in ge_on]), base)

    # ATR displacement aligned with direction (|d| > 0.5)
    for window in ["day", "week"]:
        aligned = []
        for t in trades:
            d_v = t.get(f"__atr_{window}_d")
            if d_v is None: continue
            sign = 1 if t["direction"] == "LONG" else -1
            if d_v * sign >= 0.3:
                aligned.append(t)
        row(f"ATR_{window} displacement aligned", stats_for_subset(aligned),
            stats_for_subset([t for t in trades if t not in aligned]), base)

    # ─────────────────────────────────────────────
    # GROUP 9: Execution Profile
    # ─────────────────────────────────────────────
    print("\n[GROUP 9] Execution profile & regime")
    for t in trades:
        ep_active = extract_signal(t, ["execution_profile", "active_profile"]) or ""
        t["__ep_active"] = str(ep_active).lower()
        regime_class = extract_signal(t, ["lineage", "regime_class"]) or ""
        t["__regime_class"] = str(regime_class).upper()
        backdrop = extract_signal(t, ["regime_vocabulary", "market_backdrop_class"]) or ""
        t["__backdrop"] = str(backdrop).upper()

    for ep_name in set(t["__ep_active"] for t in trades):
        if not ep_name: continue
        sub = [t for t in trades if t["__ep_active"] == ep_name]
        if len(sub) < 3: continue
        row(f"execution_profile={ep_name}", stats_for_subset(sub),
            stats_for_subset([t for t in trades if t not in sub]), base)

    for regime in set(t["__regime_class"] for t in trades):
        if not regime: continue
        sub = [t for t in trades if t["__regime_class"] == regime]
        if len(sub) < 3: continue
        row(f"regime_class={regime}", stats_for_subset(sub),
            stats_for_subset([t for t in trades if t not in sub]), base)

    # ─────────────────────────────────────────────
    # GROUP 10: Setup grade
    # ─────────────────────────────────────────────
    print("\n[GROUP 10] Setup grade (currently set by entry logic; not in computeRank but interesting)")
    for grade in set(t.get("setup_grade") for t in trades):
        if not grade: continue
        sub = [t for t in trades if t.get("setup_grade") == grade]
        if len(sub) < 3: continue
        row(f"setup_grade={grade}", stats_for_subset(sub),
            stats_for_subset([t for t in trades if t not in sub]), base)

    # ─────────────────────────────────────────────
    # GROUP 11: Direction
    # ─────────────────────────────────────────────
    print("\n[GROUP 11] Direction")
    longs = [t for t in trades if t["direction"] == "LONG"]
    shorts = [t for t in trades if t["direction"] == "SHORT"]
    row("LONG", stats_for_subset(longs), stats_for_subset(shorts), base)
    row("SHORT", stats_for_subset(shorts), stats_for_subset(longs), base)


if __name__ == "__main__":
    main()
