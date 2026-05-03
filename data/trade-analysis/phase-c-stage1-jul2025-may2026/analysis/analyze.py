#!/usr/bin/env python3
"""
Deep analysis of Phase-C Jul-Aug 2025 backtest trades.
Sections A-G. Run with no arguments. Outputs to stdout.
"""
import json
import datetime as dt
from collections import Counter, defaultdict
from statistics import mean, median

PATH = "data/trade-analysis/phase-c-stage1-jul2025-may2026/analysis/trades-fresh.json"

def load():
    raw = json.load(open(PATH))
    trades = raw["trades"]
    for t in trades:
        try:
            t["_es"] = json.loads(t["entry_signals_json"]) if t.get("entry_signals_json") else {}
        except Exception:
            t["_es"] = {}
        try:
            t["_rk"] = json.loads(t["rank_trace_json"]) if t.get("rank_trace_json") else {}
        except Exception:
            t["_rk"] = {}
        t["_snap"] = (t["_rk"] or {}).get("setup_snapshot") or {}
    return trades

def closed_only(trades):
    return [t for t in trades if t.get("status") in ("WIN","LOSS","FLAT")]

def fmt_dt(ms):
    return dt.datetime.utcfromtimestamp(ms/1000).strftime('%Y-%m-%d %H:%M')

def hr(title):
    print()
    print("="*80)
    print(title)
    print("="*80)

def main():
    trades = load()
    closed = closed_only(trades)

    hr("Overall stats")
    by_month = defaultdict(lambda: {"closed":0, "win":0, "loss":0, "pnl":0.0})
    for t in closed:
        ym = dt.datetime.utcfromtimestamp(t["entry_ts"]/1000).strftime("%Y-%m")
        b = by_month[ym]
        b["closed"] += 1
        if t["status"] == "WIN": b["win"] += 1
        elif t["status"] == "LOSS": b["loss"] += 1
        b["pnl"] += float(t.get("pnl") or 0)
    for k in sorted(by_month):
        b = by_month[k]
        wr = b["win"]/b["closed"]*100 if b["closed"] else 0
        print(f"  {k}: closed={b['closed']:3d}  W={b['win']:3d}  L={b['loss']:3d}  WR={wr:5.1f}%  Net=${b['pnl']:+,.0f}")

    # =================================================================
    # SECTION A — Big-winner extension
    # =================================================================
    hr("A. Big-winner extension — Top 10 by MFE")

    mfe_top = sorted(closed, key=lambda t: float(t.get("max_favorable_excursion") or 0), reverse=True)[:15]
    print(f"{'rank':>4} {'ticker':<6} {'side':<5} {'setup':<22} {'pers':<16} {'regime':<14} {'MFE%':>6} {'pnl%':>6} {'cap%':>5} {'exit_reason':<35}")
    for i, t in enumerate(mfe_top, 1):
        mfe = float(t.get("max_favorable_excursion") or 0)
        pnl = float(t.get("pnl_pct") or 0)
        cap = (pnl/mfe*100) if mfe > 0 else 0
        snap = t["_snap"]
        es = t["_es"]
        print(f"{i:>4} {t['ticker']:<6} {t['direction'][:5]:<5} {(t.get('entry_path') or '')[:22]:<22} "
              f"{(snap.get('ticker_personality') or es.get('personality') or '')[:16]:<16} "
              f"{(snap.get('regime_class') or es.get('regime_class') or '')[:14]:<14} "
              f"{mfe:>6.2f} {pnl:>6.2f} {cap:>4.0f}% "
              f"{(t.get('exit_reason') or '')[:35]:<35}")

    # MFE >= 5% trades exit-reason breakdown + capture %
    print()
    print("--- Trades with MFE >= 5%: exit-reason breakdown + giveback ---")
    big = [t for t in closed if float(t.get("max_favorable_excursion") or 0) >= 5.0]
    print(f"Total trades MFE>=5%: {len(big)}")
    by_reason = defaultdict(list)
    for t in big:
        by_reason[t.get("exit_reason") or "NULL"].append(t)
    print(f"{'exit_reason':<38} {'n':>4} {'avg_MFE':>8} {'avg_pnl':>8} {'avg_cap%':>9} {'avg_giveback%':>14}")
    for r, lst in sorted(by_reason.items(), key=lambda kv: -len(kv[1])):
        avg_mfe = mean(float(t.get("max_favorable_excursion") or 0) for t in lst)
        avg_pnl = mean(float(t.get("pnl_pct") or 0) for t in lst)
        avg_cap = mean(((float(t.get("pnl_pct") or 0))/(float(t.get("max_favorable_excursion") or 1)))*100 for t in lst)
        avg_gb = 100 - avg_cap
        print(f"{r:<38} {len(lst):>4} {avg_mfe:>8.2f} {avg_pnl:>8.2f} {avg_cap:>8.0f}% {avg_gb:>13.0f}%")

    # Specific exit reasons of interest
    print()
    print("--- Watch-list exit reasons on MFE>=5% trades ---")
    watch = ["mfe_decay_structural_flatten","peak_lock_ema12_deep_break","PROFIT_GIVEBACK_STAGE_HOLD",
             "atr_week_618_full_exit","ST_FLIP_4H_CLOSE","sl_breached","TP_FULL","SMART_RUNNER_SUPPORT_BREAK_CLOUD",
             "max_loss_time_scaled","HARD_FUSE_RSI_EXTREME","SOFT_FUSE_RSI_CONFIRMED","atr_day_adverse_382_cut"]
    for r in watch:
        lst = by_reason.get(r) or []
        if not lst: continue
        avg_mfe = mean(float(t.get("max_favorable_excursion") or 0) for t in lst)
        avg_pnl = mean(float(t.get("pnl_pct") or 0) for t in lst)
        avg_cap = mean(((float(t.get("pnl_pct") or 0))/(float(t.get("max_favorable_excursion") or 1)))*100 for t in lst)
        print(f"  {r:<38} n={len(lst):2d}  avg_MFE={avg_mfe:5.2f}%  avg_pnl={avg_pnl:5.2f}%  avg_cap={avg_cap:4.0f}%  giveback={100-avg_cap:4.0f}%")

    # Cross-ref entry_path × personality on MFE>=5% trades
    print()
    print("--- entry_path × personality combos, MFE>=5% trades only ---")
    combo_stats = defaultdict(lambda: {"n":0, "mfe_sum":0, "pnl_sum":0, "exit_reasons":Counter()})
    for t in big:
        snap = t["_snap"]
        es = t["_es"]
        ep = t.get("entry_path") or ""
        per = snap.get("ticker_personality") or es.get("personality") or ""
        key = f"{ep:<22} × {per}"
        c = combo_stats[key]
        c["n"] += 1
        c["mfe_sum"] += float(t.get("max_favorable_excursion") or 0)
        c["pnl_sum"] += float(t.get("pnl_pct") or 0)
        c["exit_reasons"][t.get("exit_reason") or "NULL"] += 1
    for k, c in sorted(combo_stats.items(), key=lambda kv: -kv[1]["n"]):
        if c["n"] < 2: continue
        avg_cap = (c["pnl_sum"]/c["mfe_sum"])*100 if c["mfe_sum"]>0 else 0
        top_exits = ", ".join(f"{r}({n})" for r,n in c["exit_reasons"].most_common(3))
        print(f"  {k}  n={c['n']:2d}  avg_cap={avg_cap:4.0f}%  top_exits={top_exits}")

    # Trades that gave back >40% of MFE
    print()
    print("--- Trades with >40% MFE giveback (MFE>=3%) ---")
    gb_list = []
    for t in closed:
        mfe = float(t.get("max_favorable_excursion") or 0)
        if mfe < 3.0: continue
        pnl = float(t.get("pnl_pct") or 0)
        cap = pnl/mfe*100 if mfe > 0 else 0
        gb = 100 - cap
        if gb >= 40 and pnl > 0:  # only winners that gave back
            gb_list.append((gb, t))
    gb_list.sort(reverse=True)
    print(f"Total winners giving back >=40% of MFE: {len(gb_list)}")
    print(f"{'gb%':>6} {'ticker':<6} {'MFE%':>6} {'pnl%':>6} {'setup':<22} {'pers':<16} {'exit_reason':<35}")
    for gb, t in gb_list[:20]:
        snap = t["_snap"]
        print(f"{gb:>5.0f}% {t['ticker']:<6} {float(t.get('max_favorable_excursion') or 0):>6.2f} {float(t.get('pnl_pct') or 0):>6.2f} "
              f"{(t.get('entry_path') or '')[:22]:<22} {(snap.get('ticker_personality') or '')[:16]:<16} "
              f"{(t.get('exit_reason') or '')[:35]:<35}")

    # =================================================================
    # SECTION B — Loser deepening (worst 10 by $)
    # =================================================================
    hr("B. Loser deepening — Worst 10 by $ loss")
    losers = sorted(closed, key=lambda t: float(t.get("pnl") or 0))[:15]
    print(f"{'rank':>4} {'ticker':<6} {'side':<5} {'setup':<22} {'pers':<16} {'regime':<14} {'pnl$':>10} {'pnl%':>7} {'MFE%':>6} {'flags':<60}")
    for i, t in enumerate(losers, 1):
        es = t["_es"]
        snap = t["_snap"]
        flags = []
        if es.get("has_adverse_phase_div"): flags.append("APdiv")
        if es.get("has_adverse_rsi_div"): flags.append("ARdiv")
        if es.get("td9_bear_ltf_active"): flags.append("td9bearLTF")
        if es.get("daily_td9_adverse"): flags.append("dTD9")
        if es.get("daily_adverse_prep"): flags.append(f"dAP{es.get('daily_adverse_prep')}")
        if es.get("fourh_adverse_prep"): flags.append(f"4hAP{es.get('fourh_adverse_prep')}")
        if es.get("is_f4_severe"): flags.append("F4sev")
        pdz_d = es.get("pdz_d") or ""
        if "premium" in pdz_d.lower(): flags.append(f"pdz_d:{pdz_d}")
        if "discount" in pdz_d.lower(): flags.append(f"pdz_d:{pdz_d}")
        flag_str = ",".join(flags) if flags else "(clean)"
        print(f"{i:>4} {t['ticker']:<6} {t['direction'][:5]:<5} {(t.get('entry_path') or '')[:22]:<22} "
              f"{(snap.get('ticker_personality') or es.get('personality') or '')[:16]:<16} "
              f"{(snap.get('regime_class') or es.get('regime_class') or '')[:14]:<14} "
              f"{float(t.get('pnl') or 0):>10.2f} {float(t.get('pnl_pct') or 0):>7.2f} "
              f"{float(t.get('max_favorable_excursion') or 0):>6.2f} "
              f"{flag_str[:60]:<60}")

    # Single-flag veto candidate analysis
    print()
    print("--- Single-flag entry-veto candidates (flag+side+setup → WR/loss-counts) ---")
    flagsets = {
        "has_adverse_phase_div": lambda es: es.get("has_adverse_phase_div") is True,
        "has_adverse_rsi_div": lambda es: es.get("has_adverse_rsi_div") is True,
        "td9_bear_ltf_active": lambda es: es.get("td9_bear_ltf_active") is True,
        "daily_td9_adverse": lambda es: es.get("daily_td9_adverse") is True,
        "daily_adverse_prep>=8": lambda es: (es.get("daily_adverse_prep") or 0) >= 8,
        "fourh_adverse_prep>=8": lambda es: (es.get("fourh_adverse_prep") or 0) >= 8,
        "is_f4_severe": lambda es: es.get("is_f4_severe") is True,
    }
    print(f"{'flag':<30} {'side':<5} {'n':>4} {'W':>3} {'L':>3} {'WR%':>5} {'pnl_sum$':>11} {'avg_pnl_pct':>11}")
    for flag_name, predicate in flagsets.items():
        for side in ["LONG","SHORT","ALL"]:
            lst = [t for t in closed if predicate(t["_es"]) and (side == "ALL" or t["direction"] == side)]
            if not lst: continue
            w = sum(1 for t in lst if t["status"] == "WIN")
            l = sum(1 for t in lst if t["status"] == "LOSS")
            wr = w/(w+l)*100 if (w+l)>0 else 0
            pnl_sum = sum(float(t.get("pnl") or 0) for t in lst)
            apct = mean(float(t.get("pnl_pct") or 0) for t in lst)
            if len(lst) >= 4:
                print(f"{flag_name:<30} {side:<5} {len(lst):>4} {w:>3} {l:>3} {wr:>4.0f}% {pnl_sum:>11.2f} {apct:>10.2f}%")

    # Combined two-flag vetoes
    print()
    print("--- Two-flag combinations (intersection) for entry veto ---")
    combos = [
        ("APdiv & 4hAP>=5", lambda es: es.get("has_adverse_phase_div") and (es.get("fourh_adverse_prep") or 0) >= 5),
        ("APdiv & dailyAP>=5", lambda es: es.get("has_adverse_phase_div") and (es.get("daily_adverse_prep") or 0) >= 5),
        ("APdiv & td9_bear_ltf", lambda es: es.get("has_adverse_phase_div") and es.get("td9_bear_ltf_active")),
        ("F4sev & APdiv", lambda es: es.get("is_f4_severe") and es.get("has_adverse_phase_div")),
        ("F4sev (alone)", lambda es: es.get("is_f4_severe")),
        ("dailyAP>=10 & 4hAP>=5", lambda es: (es.get("daily_adverse_prep") or 0) >= 10 and (es.get("fourh_adverse_prep") or 0) >= 5),
    ]
    for name, predicate in combos:
        for side in ["LONG","SHORT","ALL"]:
            lst = [t for t in closed if predicate(t["_es"]) and (side == "ALL" or t["direction"] == side)]
            if not lst: continue
            w = sum(1 for t in lst if t["status"] == "WIN")
            l = sum(1 for t in lst if t["status"] == "LOSS")
            wr = w/(w+l)*100 if (w+l)>0 else 0
            pnl_sum = sum(float(t.get("pnl") or 0) for t in lst)
            apct = mean(float(t.get("pnl_pct") or 0) for t in lst)
            if len(lst) >= 3:
                print(f"  {name:<30} {side:<5} n={len(lst):>3}  W={w:2d} L={l:2d} WR={wr:4.0f}%  net=${pnl_sum:+8.2f}  avg_pnl%={apct:+5.2f}%")

    # Regime breakdown of losers
    print()
    print("--- Regime-class of all closed trades ---")
    regimes = defaultdict(lambda: [0,0,0,0.0])  # closed,win,loss,pnl
    for t in closed:
        rc = t["_snap"].get("regime_class") or t["_es"].get("regime_class") or "UNK"
        b = regimes[rc]
        b[0]+=1
        if t["status"]=="WIN": b[1]+=1
        elif t["status"]=="LOSS": b[2]+=1
        b[3]+=float(t.get("pnl") or 0)
    print(f"{'regime':<20} {'n':>4} {'W':>3} {'L':>3} {'WR%':>5} {'pnl$':>11}")
    for r,(n,w,l,p) in sorted(regimes.items(), key=lambda kv:-kv[1][0]):
        wr = w/(w+l)*100 if (w+l)>0 else 0
        print(f"{r:<20} {n:>4} {w:>3} {l:>3} {wr:>4.0f}% {p:>11.2f}")

    # =================================================================
    # SECTION C — Loop 1 effectiveness
    # =================================================================
    hr("C. Loop 1 effectiveness — combo scorecard")

    combos_l1 = defaultdict(lambda: {"n":0, "w":0, "l":0, "pnl":0.0, "trades":[]})
    for t in closed:
        snap = t["_snap"]
        es = t["_es"]
        setup = (t.get("entry_path") or "").lower()
        regime = (snap.get("regime_class") or es.get("regime_class") or "unknown").lower()
        per = (snap.get("ticker_personality") or es.get("personality") or "unknown").lower()
        side = "L" if t["direction"]=="LONG" else "S"
        key = f"{setup}:{regime}:{per}:{side}"
        c = combos_l1[key]
        c["n"]+=1
        if t["status"]=="WIN": c["w"]+=1
        elif t["status"]=="LOSS": c["l"]+=1
        c["pnl"]+=float(t.get("pnl") or 0)
        c["trades"].append(t)

    print(f"All combos with n>=3 trades, sorted by WR ascending (worst first):")
    print(f"{'combo':<70} {'n':>3} {'W':>3} {'L':>3} {'WR%':>5} {'pnl$':>11}")
    rows = []
    for k,c in combos_l1.items():
        if c["n"] < 3: continue
        wr = c["w"]/(c["w"]+c["l"])*100 if (c["w"]+c["l"])>0 else 0
        rows.append((wr, k, c))
    rows.sort()
    for wr, k, c in rows[:30]:
        print(f"{k:<70} {c['n']:>3} {c['w']:>3} {c['l']:>3} {wr:>4.0f}% {c['pnl']:>+11.2f}")

    print()
    print(f"Combos with n=2 (under min_samples=3) but BOTH losses:")
    for k,c in combos_l1.items():
        if c["n"] >= 3: continue
        if c["l"] == c["n"] and c["n"] >= 2:
            print(f"  {k:<70} n={c['n']} pnl=${c['pnl']:.2f}")

    # =================================================================
    # SECTION D — Loop 2 effectiveness
    # =================================================================
    hr("D. Loop 2 effectiveness — circuit breaker")
    # Re-scan loop_events and identify days the breaker tripped
    loop2_events = []
    for t in closed:
        for ev in (t["_es"].get("loop_events") or []):
            if ev.get("loop") == 2:
                loop2_events.append((t, ev))
    print(f"Total loop-2 events captured in entry_signals: {len(loop2_events)}")
    counter = Counter(ev.get("reason") for _,ev in loop2_events)
    print(f"Reasons: {dict(counter)}")

    # daily PnL as of the simulated day:
    by_day = defaultdict(list)
    for t in closed:
        ymd = dt.datetime.utcfromtimestamp(t["entry_ts"]/1000).strftime("%Y-%m-%d")
        by_day[ymd].append(t)
    losing_days = []
    for d, lst in sorted(by_day.items()):
        pnl = sum(float(t.get("pnl") or 0) for t in lst)
        wr = sum(1 for t in lst if t["status"]=="WIN")/len(lst)*100 if lst else 0
        if pnl < -1500 or wr < 30 and len(lst)>=3:
            losing_days.append((d, len(lst), wr, pnl))
    print(f"\nLosing days (pnl<-$1500 or WR<30% with n>=3):")
    for d,n,wr,pnl in losing_days:
        print(f"  {d}  n={n:2d} WR={wr:4.0f}% pnl=${pnl:+8.2f}")

    # =================================================================
    # SECTION E — PDZ usage
    # =================================================================
    hr("E. PDZ usage — long entries by daily PDZ")
    pdz_buckets = defaultdict(lambda: [0,0,0,0.0])
    for t in closed:
        side = t["direction"]
        pdz = (t["_es"].get("pdz_d") or t["_snap"].get("pdz",{}).get("D") or "null")
        bucket_key = f"{side}:{pdz}"
        b = pdz_buckets[bucket_key]
        b[0]+=1
        if t["status"]=="WIN": b[1]+=1
        elif t["status"]=="LOSS": b[2]+=1
        b[3]+=float(t.get("pnl") or 0)
    print(f"{'side:pdz_d':<35} {'n':>4} {'W':>3} {'L':>3} {'WR%':>5} {'pnl$':>11}")
    for k,(n,w,l,p) in sorted(pdz_buckets.items(), key=lambda kv:-kv[1][0]):
        if n < 2: continue
        wr = w/(w+l)*100 if (w+l)>0 else 0
        print(f"{k:<35} {n:>4} {w:>3} {l:>3} {wr:>4.0f}% {p:>11.2f}")

    # PDZ × side cross-tab using 4h PDZ
    print()
    print("--- pdz_4h x side ---")
    pdz4_buckets = defaultdict(lambda: [0,0,0,0.0])
    for t in closed:
        side = t["direction"]
        pdz = (t["_es"].get("pdz_4h") or t["_snap"].get("pdz",{}).get("h4") or "null")
        b = pdz4_buckets[f"{side}:{pdz}"]
        b[0]+=1
        if t["status"]=="WIN": b[1]+=1
        elif t["status"]=="LOSS": b[2]+=1
        b[3]+=float(t.get("pnl") or 0)
    print(f"{'side:pdz_4h':<35} {'n':>4} {'W':>3} {'L':>3} {'WR%':>5} {'pnl$':>11}")
    for k,(n,w,l,p) in sorted(pdz4_buckets.items(), key=lambda kv:-kv[1][0]):
        if n < 2: continue
        wr = w/(w+l)*100 if (w+l)>0 else 0
        print(f"{k:<35} {n:>4} {w:>3} {l:>3} {wr:>4.0f}% {p:>11.2f}")

    # =================================================================
    # SECTION F — VWAP behavior
    # =================================================================
    hr("F. VWAP behavior — distance buckets")
    # daily VWAP
    def get_vwap(t, tf="D", field="dist_pct"):
        snap = t.get("_snap") or {}
        v = (snap.get("vwap") or {}).get(tf) or {}
        return v.get(field)

    print(f"--- vwap.D.dist_pct buckets (LONG only) ---")
    buckets = [(-100,-10), (-10,-5), (-5,-2), (-2,0), (0,2), (2,5), (5,10), (10,30), (30,100)]
    for lo,hi in buckets:
        lst = [t for t in closed if t["direction"]=="LONG" and (get_vwap(t,"D") is not None) and lo <= get_vwap(t,"D") < hi]
        if not lst: continue
        w = sum(1 for t in lst if t["status"]=="WIN")
        l = sum(1 for t in lst if t["status"]=="LOSS")
        wr = w/(w+l)*100 if (w+l)>0 else 0
        pnl = sum(float(t.get("pnl") or 0) for t in lst)
        avgpnl = mean(float(t.get("pnl_pct") or 0) for t in lst)
        print(f"  [{lo:+4d},{hi:+4d})%  n={len(lst):3d} W={w:2d} L={l:2d} WR={wr:4.0f}%  net=${pnl:+9.2f}  avg_pnl%={avgpnl:+5.2f}%")

    print(f"--- vwap.D.dist_pct buckets (SHORT only) ---")
    for lo,hi in buckets:
        lst = [t for t in closed if t["direction"]=="SHORT" and (get_vwap(t,"D") is not None) and lo <= get_vwap(t,"D") < hi]
        if not lst: continue
        w = sum(1 for t in lst if t["status"]=="WIN")
        l = sum(1 for t in lst if t["status"]=="LOSS")
        wr = w/(w+l)*100 if (w+l)>0 else 0
        pnl = sum(float(t.get("pnl") or 0) for t in lst)
        avgpnl = mean(float(t.get("pnl_pct") or 0) for t in lst)
        print(f"  [{lo:+4d},{hi:+4d})%  n={len(lst):3d} W={w:2d} L={l:2d} WR={wr:4.0f}%  net=${pnl:+9.2f}  avg_pnl%={avgpnl:+5.2f}%")

    print(f"\n--- vwap.W.dist_pct buckets (LONG only) ---")
    for lo,hi in [(-100,-10), (-10,-5), (-5,0), (0,5), (5,10), (10,30), (30,100)]:
        lst = [t for t in closed if t["direction"]=="LONG" and (get_vwap(t,"W") is not None) and lo <= get_vwap(t,"W") < hi]
        if not lst: continue
        w = sum(1 for t in lst if t["status"]=="WIN")
        l = sum(1 for t in lst if t["status"]=="LOSS")
        wr = w/(w+l)*100 if (w+l)>0 else 0
        pnl = sum(float(t.get("pnl") or 0) for t in lst)
        print(f"  [{lo:+4d},{hi:+4d})%  n={len(lst):3d} W={w:2d} L={l:2d} WR={wr:4.0f}%  net=${pnl:+9.2f}")

    print(f"\n--- vwap.D.slope_5bar buckets (LONG only) ---")
    for lo,hi in [(-10,-0.1), (-0.1,0), (0,0.05), (0.05,0.1), (0.1,0.2), (0.2,0.5), (0.5,5)]:
        lst = [t for t in closed if t["direction"]=="LONG" and (get_vwap(t,"D","slope_5bar") is not None) and lo <= get_vwap(t,"D","slope_5bar") < hi]
        if not lst: continue
        w = sum(1 for t in lst if t["status"]=="WIN")
        l = sum(1 for t in lst if t["status"]=="LOSS")
        wr = w/(w+l)*100 if (w+l)>0 else 0
        pnl = sum(float(t.get("pnl") or 0) for t in lst)
        print(f"  slope [{lo:+5.2f},{hi:+5.2f})  n={len(lst):3d} W={w:2d} L={l:2d} WR={wr:4.0f}%  net=${pnl:+9.2f}")

    # =================================================================
    # SECTION G — Time of day / day of week
    # =================================================================
    hr("G. Time-of-day / Day-of-week (NY tz approx via UTC-4 = EDT)")
    # Use UTC-4 (EDT) for July/August
    def ny_hour_dow(t):
        d = dt.datetime.utcfromtimestamp(t["entry_ts"]/1000) - dt.timedelta(hours=4)
        return d.hour, d.strftime("%A"), d.weekday()

    by_hour = defaultdict(lambda: [0,0,0,0.0])
    by_dow = defaultdict(lambda: [0,0,0,0.0])
    for t in closed:
        h, dow, _ = ny_hour_dow(t)
        b = by_hour[h]
        b[0]+=1
        if t["status"]=="WIN": b[1]+=1
        elif t["status"]=="LOSS": b[2]+=1
        b[3]+=float(t.get("pnl") or 0)
        b2 = by_dow[dow]
        b2[0]+=1
        if t["status"]=="WIN": b2[1]+=1
        elif t["status"]=="LOSS": b2[2]+=1
        b2[3]+=float(t.get("pnl") or 0)

    print(f"--- Hour-of-day (NY) ---")
    for h in sorted(by_hour):
        n,w,l,p = by_hour[h]
        wr = w/(w+l)*100 if (w+l)>0 else 0
        print(f"  hour {h:02d}: n={n:3d} W={w:2d} L={l:2d} WR={wr:4.0f}% net=${p:+9.2f}")

    print(f"\n--- Day-of-week ---")
    order = ["Monday","Tuesday","Wednesday","Thursday","Friday"]
    for d in order:
        if d in by_dow:
            n,w,l,p = by_dow[d]
            wr = w/(w+l)*100 if (w+l)>0 else 0
            print(f"  {d:<10} n={n:3d} W={w:2d} L={l:2d} WR={wr:4.0f}% net=${p:+9.2f}")

    # Summary: Aug-only WR
    hr("Aug 2025 standalone — what changed vs July?")
    july = [t for t in closed if dt.datetime.utcfromtimestamp(t["entry_ts"]/1000).month == 7]
    aug = [t for t in closed if dt.datetime.utcfromtimestamp(t["entry_ts"]/1000).month == 8]
    for label, lst in [("July", july), ("August", aug)]:
        print(f"\n--- {label} (n={len(lst)}) ---")
        ER = Counter(t.get("exit_reason") or "NULL" for t in lst)
        for r,c in ER.most_common(15):
            sub = [t for t in lst if (t.get("exit_reason") or "NULL")==r]
            w = sum(1 for t in sub if t["status"]=="WIN")
            l = sum(1 for t in sub if t["status"]=="LOSS")
            pnl = sum(float(t.get("pnl") or 0) for t in sub)
            print(f"  {r:<38} n={c:2d}  W={w:2d} L={l:2d}  net=${pnl:+9.2f}")

if __name__ == "__main__":
    main()
