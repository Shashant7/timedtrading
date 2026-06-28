# July 2025 Slice — v9 (rank_bypass=0)

| Field | Value |
|---|---|
| Run ID | `phase-d-slice-2025-07-v9` |
| Environment | `timed-trading-ingest-preprod` |
| Universe | 24 tickers (tier1 + tier2) |
| Config | high-rank member block only (`rank_bypass=0`); doctrine BULL defer; earnings-cluster gate; index 48h cooldown |
| Status | Finalized (07-01 → 07-30 replayed; **07-31 infra-failed** after 5×`503/1102`, positions closed at 07-31) |

## Result

| Run | Trades | WR | Sum P&L |
|---|---:|---:|---:|
| **Anchor** `phase-c-slice-2025-07-v1` | 25 | **76.0%** | **+26.05%** |
| v6 (best challenger) | 26 | 65.4% | +18.08% |
| **v9** | **43** | **41.9%** | **+12.41%** |

v9 closed **43 trades — 18W / 22L / 3 flat = 41.9% WR, +12.41%** (+$1,117 on the replay book).

## Verdict: v9 does NOT beat the anchor

It is the **worst** of the tuned challengers on win rate and the only one that
materially over-traded:

- **Over-trading.** 43 trades vs the anchor's 25 — `rank_bypass=0` (block only
  high-rank members, let everything else through) removed the selectivity that
  is the anchor's entire edge. More entries diluted quality.
- **WR collapse.** 41.9% vs anchor 76% / v6 65.4%. The extra ~17 trades v9 took
  beyond v6's count were net losers.
- **P&L.** +12.41% — below v6 (+18.08%) and well below the anchor (+26.05%).

### Worst / best names (v9)

- **Drag:** CDNS −$232 (4 trades), ON −$212, IWM −$164 (4), SGI −$145, AGQ −$107.
- **Edge:** IESC +$462, NVDA +$300, FIX +$284, MSFT +$278, ETN +$273.

The winners are the usual industrials/quality-tech names; the losers are the
marginal entries the looser gate admitted (CDNS re-entries, index churn on IWM).

## Takeaway

The anchor's advantage is **conviction/selectivity**, not breadth. Loosening the
rank gate (`rank_bypass=0`) to admit more candidates is the wrong direction — it
reverts the WR. The best path back toward the anchor is the **tighter v6 config**
(26 trades, 65.4% WR) plus the v6→anchor counterfactual already noted (block
TSLA/SWK, ~−7.2%), not a wider net.

**Recommendation:** stop the `rank_bypass` loosening lane; treat v6 as the
current challenger baseline and pursue selectivity (entry-quality / cluster
gating) rather than volume. v9 is archived as a negative result.

## Reproduce

```bash
PRE=https://timed-trading-ingest-preprod.shashant.workers.dev
curl -s "$PRE/timed/admin/runs/trades?run_id=phase-d-slice-2025-07-v9&limit=10000&key=$TIMED_API_KEY"
```
