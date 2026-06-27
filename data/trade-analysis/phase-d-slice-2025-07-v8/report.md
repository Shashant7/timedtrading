# Phase D slice — 2025-07 (run_id `phase-d-slice-2025-07-v8`)

> Cluster windows wired to `result._env` — gate **fires** (1294 block-chain hits) but
> `rank_bypass=93` standard cluster block is too aggressive (911 blocks).

| Metric | v8 | **v6** | anchor |
|---|---|---|---|
| Trades | 55 | 26 | 25 |
| WR | 47.3% | **65.4%** | 76.0% |
| Sum pnl | +10.76% | **+18.08%** | +26.05% |
| TSLA/SWK | **blocked** | entered | none |

**Best run so far: v6.** Next config tweak: disable standard cluster block
(`rank_bypass=0`) and keep high-rank member block only.
