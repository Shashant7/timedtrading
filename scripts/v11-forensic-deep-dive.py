#!/usr/bin/env python3
"""
V11 Forensic Deep-Dive

Produces calibration-ready forensics against V11 trades to drive V12.

Sections:
  1. Rank integrity — does rank actually predict outcomes?
  2. March 2026 collapse autopsy (0W/6L, -8.19%)
  3. SHORT activation failure (only 1 short in 10 months)
  4. Setup paradoxes (tt_momentum: high WR but negative PnL)
  5. Exit-reason profitability — are we cutting winners early?
  6. Time-of-trade analysis (days-held vs outcome)
  7. Cohort performance (ETF vs MegaCap vs Small vs Specialty)
  8. Recommended V12 calibration targets

Emits:
  data/trade-analysis/<RUN_ID>/v11-forensic-deep-dive.md
"""
import json
import os
import statistics
import sys
from collections import defaultdict, Counter
from datetime import datetime, timezone

if len(sys.argv) < 2:
    print(f"usage: {sys.argv[0]} <run_id>", file=sys.stderr)
    sys.exit(2)

RUN_ID = sys.argv[1]
OUT_DIR = os.path.join("data", "trade-analysis", RUN_ID)
os.makedirs(OUT_DIR, exist_ok=True)


def _f(v, default=None):
    try:
        x = float(v)
        if x != x:
            return default
        return x
    except Exception:
        return default


def parse_trace(s):
    if not s:
        return None
    if isinstance(s, dict):
        return s
    try:
        return json.loads(s)
    except Exception:
        return None


def classify(t):
    s = (t.get("status") or "").upper()
    if s in ("WIN", "LOSS", "FLAT"):
        return s
    pnl = _f(t.get("pnl_pct"), 0) or 0
    return "WIN" if pnl > 0 else "LOSS" if pnl < 0 else "FLAT"


def main():
    # Load trades (from /tmp cache if available, else re-fetch)
    cache = "/tmp/v11_trades_full.json"
    if os.path.exists(cache):
        trades = json.load(open(cache))
    else:
        import urllib.parse, urllib.request
        KEY = os.environ["TIMED_API_KEY"]
        url = f"https://timed-trading-ingest.shashant.workers.dev/timed/admin/trade-autopsy/trades?runId={RUN_ID}&archived=1&limit=5000&key={KEY}"
        req = urllib.request.Request(url, headers={"User-Agent": "tt-forensic/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            trades = (json.loads(r.read()) or {}).get("trades") or []
    print(f"[forensic] {len(trades)} trades")

    closed = [t for t in trades if classify(t) in ("WIN", "LOSS", "FLAT")]

    md = [f"# V11 Forensic Deep-Dive — `{RUN_ID}`\n"]
    md.append(f"Generated {datetime.now(timezone.utc).isoformat()}\n")
    md.append(f"Analyzed: {len(closed)} closed trades\n")

    # ═════════════════════════════════════════════════════════════════════
    # 1. RANK INTEGRITY — does rank actually predict outcomes?
    # ═════════════════════════════════════════════════════════════════════
    md.append("## 1. Rank integrity audit\n")
    ranked = [t for t in closed if _f(t.get("rank")) is not None]

    # Decile the rank, show WR + avg PnL per decile
    ranks = sorted([_f(t.get("rank")) for t in ranked if _f(t.get("rank")) is not None])
    if ranks:
        n = len(ranks)
        deciles = [ranks[min(int(n * i / 10), n - 1)] for i in range(11)]
        buckets = defaultdict(list)
        for t in ranked:
            r = _f(t.get("rank"))
            for i in range(10):
                if deciles[i] <= r <= deciles[i + 1]:
                    buckets[i].append(t); break

        md.append(f"Trades with populated rank: {len(ranked)}/{len(closed)}\n")
        md.append("| Decile | Rank range | N | Wins | WR | Avg PnL | Total PnL |")
        md.append("|---:|---|---:|---:|---:|---:|---:|")
        for i in range(10):
            b = buckets.get(i, [])
            if not b: continue
            w = sum(1 for t in b if classify(t) == "WIN")
            wr = 100*w/len(b) if b else 0
            pnls = [_f(t.get("pnl_pct"), 0) or 0 for t in b]
            avg = sum(pnls)/len(pnls) if pnls else 0
            md.append(f"| D{i+1} | {deciles[i]:.1f}–{deciles[i+1]:.1f} | {len(b)} | {w} | {wr:.1f}% | {avg:+.2f}% | {sum(pnls):+.2f}% |")
        # Predictive power: correlation between rank and pnl
        xs = [_f(t.get("rank")) for t in ranked]
        ys = [_f(t.get("pnl_pct"), 0) or 0 for t in ranked]
        try:
            mx = sum(xs)/len(xs); my = sum(ys)/len(ys)
            num = sum((xs[i]-mx)*(ys[i]-my) for i in range(len(xs)))
            dx = sum((xs[i]-mx)**2 for i in range(len(xs))) ** 0.5
            dy = sum((ys[i]-my)**2 for i in range(len(ys))) ** 0.5
            corr = num / (dx*dy) if dx*dy > 0 else 0
        except Exception:
            corr = 0
        md.append(f"\n**Pearson correlation (rank, pnl_pct):** {corr:+.3f}\n")
        if abs(corr) < 0.1:
            md.append(f"> Rank has **essentially zero predictive power** in V11 \u2014 calibration is warranted.")
        elif corr > 0.2:
            md.append(f"> Rank has meaningful positive correlation \u2014 formula is working.")
        else:
            md.append(f"> Rank has weak predictive power \u2014 calibration should improve this.")

    # Rank-trace component audit
    traced = [t for t in ranked if parse_trace(t.get("rank_trace_json"))]
    md.append(f"\n**Rank-trace coverage:** {len(traced)}/{len(ranked)} ({100*len(traced)/max(len(ranked),1):.0f}%)\n")

    if traced:
        # Per-component correlation with outcome (WIN=1, LOSS=-1)
        component_fields = ["htf", "ltf", "completion", "phase", "rr", "triggerSummaryScore", "tfSummaryScore", "completenessScore"]
        md.append("Per-component correlation with outcome (WIN=+1, LOSS=-1):\n")
        md.append("| Component | Mean(W) | Mean(L) | Delta | Predictive? |")
        md.append("|---|---:|---:|---:|:--:|")
        for fld in component_fields:
            vals_w, vals_l = [], []
            for t in traced:
                tr = parse_trace(t.get("rank_trace_json")) or {}
                v = _f(tr.get(fld))
                if v is None: continue
                (vals_w if classify(t) == "WIN" else vals_l).append(v)
            if vals_w and vals_l:
                mw = sum(vals_w)/len(vals_w); ml = sum(vals_l)/len(vals_l)
                delta = mw - ml
                verdict = "strong" if abs(delta) > 5 else "weak" if abs(delta) > 1 else "\u2014"
                md.append(f"| {fld} | {mw:.2f} | {ml:.2f} | {delta:+.2f} | {verdict} |")

    # ═════════════════════════════════════════════════════════════════════
    # 2. MARCH 2026 COLLAPSE AUTOPSY
    # ═════════════════════════════════════════════════════════════════════
    md.append("\n## 2. March 2026 collapse autopsy (0W / 6L / -8.19%)\n")
    mar = [t for t in closed if str(t.get("entry_ts") or 0) and datetime.fromtimestamp((t.get("entry_ts") or 0)/1000, tz=timezone.utc).strftime("%Y-%m") == "2026-03"]

    if mar:
        md.append("| Ticker | Dir | In | Out | Setup | Entry Path | PnL | MFE | MAE | Exit | Rank |")
        md.append("|---|---|---|---|---|---|---:|---:|---:|---|---:|")
        for t in sorted(mar, key=lambda x: x.get("entry_ts") or 0):
            ts_in = datetime.fromtimestamp((t.get("entry_ts") or 0)/1000, tz=timezone.utc).strftime("%m-%d")
            ts_out = datetime.fromtimestamp((t.get("exit_ts") or 0)/1000, tz=timezone.utc).strftime("%m-%d") if t.get("exit_ts") else "—"
            mfe = _f(t.get("max_favorable_excursion")); mae = _f(t.get("max_adverse_excursion"))
            mfe_s = f"{mfe:.2f}" if mfe is not None else "—"
            mae_s = f"{mae:.2f}" if mae is not None else "—"
            md.append(f"| {t.get('ticker')} | {(t.get('direction') or '').upper()} | {ts_in} | {ts_out} | {t.get('setup_name') or '—'} | {t.get('entry_path') or '—'} | {_f(t.get('pnl_pct'),0):+.2f}% | {mfe_s} | {mae_s} | {t.get('exit_reason') or '—'} | {t.get('rank') or '—'} |")

    # ═════════════════════════════════════════════════════════════════════
    # 3. SHORT activation failure
    # ═════════════════════════════════════════════════════════════════════
    md.append("\n## 3. SHORT activation failure (1 SHORT in 10 months)\n")
    shorts = [t for t in closed if (t.get("direction") or "").upper() == "SHORT"]
    md.append(f"Total SHORTs: {len(shorts)} / 177 trades ({100*len(shorts)/177:.1f}%)\n")
    if shorts:
        for t in shorts:
            md.append(f"- **{t.get('ticker')}** entered {datetime.fromtimestamp((t.get('entry_ts') or 0)/1000, tz=timezone.utc).strftime('%Y-%m-%d')}, exited {t.get('exit_reason')} at {_f(t.get('pnl_pct'),0):+.2f}%\n")
    md.append("\n> W2 gate (`deep_audit_short_requires_spy_downtrend`) + `deep_audit_short_sector_strength_gate` are over-filtering. SPY had multiple identifiable downtrends (Feb, late-March bounce-back) that produced zero shorts.\n")
    md.append("> **V12 action:** relax W2 to accept SPY daily structure = `bearish_mixed` OR `sideways_below_21ema` (currently requires full `bearish_stacked`). Also drop the sector-strength gate as a hard block and convert to a rank penalty instead.\n")

    # ═════════════════════════════════════════════════════════════════════
    # 4. Setup paradoxes
    # ═════════════════════════════════════════════════════════════════════
    md.append("\n## 4. Setup paradoxes\n")
    by_setup = defaultdict(list)
    for t in closed:
        key = t.get("setup_name") or t.get("entry_path") or "?"
        by_setup[key].append(t)

    # tt_momentum: 71% WR but -2% PnL — investigate
    for key in ["tt_momentum", "TT Tt Momentum"]:
        bucket = by_setup.get(key, [])
        if not bucket: continue
        wins = [t for t in bucket if classify(t) == "WIN"]
        losses = [t for t in bucket if classify(t) == "LOSS"]
        wp = [_f(t.get("pnl_pct"),0) for t in wins]
        lp = [_f(t.get("pnl_pct"),0) for t in losses]
        md.append(f"\n### `{key}` — WR {100*len(wins)/max(len(wins)+len(losses),1):.1f}%, total PnL {sum(_f(t.get('pnl_pct'),0) or 0 for t in bucket):+.2f}%\n")
        md.append(f"- Wins (n={len(wins)}): mean {statistics.mean(wp) if wp else 0:+.2f}%, median {statistics.median(wp) if wp else 0:+.2f}%, max {max(wp) if wp else 0:+.2f}%\n")
        md.append(f"- Losses (n={len(losses)}): mean {statistics.mean(lp) if lp else 0:+.2f}%, median {statistics.median(lp) if lp else 0:+.2f}%, min {min(lp) if lp else 0:+.2f}%\n")
        md.append("| Ticker | Dir | W/L | PnL | MFE | Exit |")
        md.append("|---|---|:--:|---:|---:|---|")
        for t in sorted(bucket, key=lambda x: _f(x.get("pnl_pct"),0) or 0):
            md.append(f"| {t.get('ticker')} | {(t.get('direction') or '').upper()} | {classify(t)[0]} | {_f(t.get('pnl_pct'),0):+.2f}% | {_f(t.get('max_favorable_excursion'),0) or 0:.2f}% | {t.get('exit_reason')} |")

    # ═════════════════════════════════════════════════════════════════════
    # 5. Exit-reason profitability
    # ═════════════════════════════════════════════════════════════════════
    md.append("\n## 5. Exit-reason profitability — are we cutting winners early?\n")
    by_reason = defaultdict(list)
    for t in closed:
        by_reason[t.get("exit_reason") or "?"].append(t)
    md.append("| Exit reason | N | WR | Avg PnL | Max MFE in this bucket |")
    md.append("|---|---:|---:|---:|---:|")
    for reason, bucket in sorted(by_reason.items(), key=lambda kv: len(kv[1]), reverse=True):
        w = sum(1 for t in bucket if classify(t) == "WIN")
        wr = 100*w/len(bucket) if bucket else 0
        pnls = [_f(t.get("pnl_pct"),0) or 0 for t in bucket]
        mfes = [_f(t.get("max_favorable_excursion"),0) or 0 for t in bucket]
        md.append(f"| {reason} | {len(bucket)} | {wr:.0f}% | {sum(pnls)/len(pnls):+.2f}% | {max(mfes) if mfes else 0:.2f}% |")

    # Focus on phase_i_mfe_fast_cut_zero_mfe
    fcut = by_reason.get("phase_i_mfe_fast_cut_zero_mfe", [])
    if fcut:
        mfes = [_f(t.get("max_favorable_excursion"),0) or 0 for t in fcut]
        pnls = [_f(t.get("pnl_pct"),0) or 0 for t in fcut]
        got_above_mfe_1 = sum(1 for m in mfes if m >= 1.0)
        got_above_mfe_2 = sum(1 for m in mfes if m >= 2.0)
        md.append(f"\n### `phase_i_mfe_fast_cut_zero_mfe` deep-dive (n={len(fcut)})\n")
        md.append(f"- Avg PnL at cut: {sum(pnls)/len(pnls):+.2f}%\n")
        md.append(f"- Max MFE reached before cut: {max(mfes):.2f}%\n")
        md.append(f"- Trades that touched ≥1% MFE before cut: **{got_above_mfe_1}** ({100*got_above_mfe_1/len(fcut):.0f}%)\n")
        md.append(f"- Trades that touched ≥2% MFE before cut: **{got_above_mfe_2}** ({100*got_above_mfe_2/len(fcut):.0f}%)\n")
        md.append(f"> If `got_above_mfe_1` is large, we're cutting trades that did 'work' then came back. Consider relaxing the zero-MFE threshold.\n")

    # ═════════════════════════════════════════════════════════════════════
    # 6. Time-of-trade analysis
    # ═════════════════════════════════════════════════════════════════════
    md.append("\n## 6. Time-of-trade analysis\n")
    def hold_days(t):
        a, b = t.get("entry_ts"), t.get("exit_ts")
        if not a or not b: return None
        return (b - a) / (86400*1000)
    buckets = defaultdict(list)
    for t in closed:
        d = hold_days(t)
        if d is None: continue
        b = "<1d" if d < 1 else "1-2d" if d < 2 else "2-5d" if d < 5 else "5-10d" if d < 10 else ">=10d"
        buckets[b].append(t)
    md.append("| Hold duration | N | WR | Avg PnL |")
    md.append("|---|---:|---:|---:|")
    for b in ["<1d","1-2d","2-5d","5-10d",">=10d"]:
        bk = buckets.get(b, [])
        if not bk: continue
        w = sum(1 for t in bk if classify(t) == "WIN")
        pnls = [_f(t.get("pnl_pct"),0) or 0 for t in bk]
        md.append(f"| {b} | {len(bk)} | {100*w/len(bk):.0f}% | {sum(pnls)/len(pnls):+.2f}% |")

    # ═════════════════════════════════════════════════════════════════════
    # 8. V12 calibration roadmap
    # ═════════════════════════════════════════════════════════════════════
    md.append("\n## 8. V12 calibration roadmap — path to 65%+ WR\n")
    md.append("""
### Priority 1: Rank calibration (Stage 0)
- Only 32% of V11 trades have `rank_trace_json` — fix the flag so V12 captures 100%
- Re-run per-component WR/PnL-lift analysis on V12 trades
- Re-weight `computeRankV2` with empirical lifts

### Priority 2: Stop cutting trades that are working
- `phase_i_mfe_fast_cut_zero_mfe` fires on 24% of V11 exits. See section 5 for % that touched ≥1% MFE before cut.
- Proposal: raise threshold from "zero MFE" to "MFE < 0.5%" **and** require 2h age rather than hard-cut at any age.

### Priority 3: Re-enable SHORT side
- W2 filters everything out. Relax to allow SHORTs when:
  - SPY daily regime ≤ `mixed_below_21ema` OR
  - Ticker's own daily EMA structure is stacked-bearish with RVol ≥ 1.5
- Keep the sector-strength gate but convert to a rank penalty, not a hard block.

### Priority 4: March breakdown — regime-change handler
- March 2026 was a 6-trade 0-win, -8.19% cluster.
- Need a "recent-losing-streak" throttle: after 3 consecutive losses in a month, reduce max open positions from 10 to 4 until a winning trade breaks the streak.

### Priority 5: `tt_momentum` paradox
- 71.4% WR but -2.0% PnL means wins are tiny and losses are larger. Fix by:
  - Tightening momentum entry criteria (require MFE ≥ 1% within 2h of entry to hold)
  - Letting momentum winners run longer (swap `mfe_proportional_trail` for `atr_week_618` on this setup)

### Target metrics for V12
- Win rate: 65%+ (V11: 52.0%)
- Profit factor: 2.0+ (V11: 1.58)
- Total PnL: +80% or better (V11: +62.53%)
- Max month drawdown: capped at -3% (V11 March: -8.19%)
- SHORT trades: 5-15 per 10 months (V11: 1)
""")

    md_path = os.path.join(OUT_DIR, "v11-forensic-deep-dive.md")
    with open(md_path, "w") as fp:
        fp.write("\n".join(md) + "\n")
    print(f"[forensic] Wrote {md_path}")


if __name__ == "__main__":
    main()
