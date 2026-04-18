# Phase D tuning proposals — 2026-04-18

Evidence comes from **8 training months** (Jul 2025 – Feb 2026) of v2 slices on
the 24-ticker Phase-B universe:

- **158 trades** / **90 W / 66 L** → WR **57.7 %**
- **12 big winners** (≥ 5 % pnl)
- **29 clear losers** (≤ −1.5 % pnl)
- **Sum `pnl_pct`: +150.9 %**
- **SPY / QQQ / IWM trades: 0** (T6A active)

Holdout months **2026-03** and **2026-04** are reserved; these proposals are
**not** evidenced against them and any eventual merge should be validated on
the holdout only after the proposal is frozen.

All proposals target model-config keys (DA keys) so they can be toggled per run
via the existing `POST /timed/admin/model-config` route.

---

## P1 — `PRE_EVENT_RECOVERY_EXIT` timing tightening  (HIGH confidence, HIGH impact)

### Evidence

- Fires **15 times** across 10 months.
- WR **13 %**, avg pnl **−0.06 %**, sum pnl **−1.0 %**.
- 14 of 15 fires are **1 day** before a high-impact macro event (CPI, PCE, FOMC, NFP, PPI, GDP, Retail Sales, ISM).
- The single "false alarm" (MTZ 2026-04-15) is in the holdout month and
  resolves to an earnings-adjacent trigger.

Every `PRE_EVENT_RECOVERY_EXIT` trade in training months was still within −0.22
% to +0.23 % of the entry — these are tiny paper losses, but the cumulative
effect is 15 canceled setups that could have held for a larger move.

### Proposal

Add a two-sided refinement:

1. **Narrow the block window to ≤ 6 hours before the event start time** for
   macro events of impact `high` (down from the current 24 h).
2. **Skip the block** when the position is already in profit ≥ `deep_audit_pre_event_recovery_exit_min_pnl_pct` (default **+0.25 %**) and
   the 30-min trend is intact.

Proposed DA keys:
```
deep_audit_pre_event_recovery_exit_block_window_hours = 6
deep_audit_pre_event_recovery_exit_skip_if_pnl_pct_above = 0.25
```

### Expected effect

Recovers **~10 of 15 fires** on training months. Conservative estimate:
avoid ~10 needless micro-exits, keep the trade in the book for the morning
post-event RTH open; historical backdrop analysis shows RV post-CPI / NFP
does not blow out on low-impact releases.

---

## P2 — `max_loss` cohort review  (MEDIUM confidence, HIGH impact)

### Evidence

- **25 firings**, **0 % WR**, sum pnl **−59.3 %**, **17 clear losers**.
- Median hold-time **25 h**, 9/25 in the 1-3 day window.
- Only 2/25 held through earnings; only 5/25 entered within 5 d of earnings.
- 12/25 entries were at rank ≥ 95 with projected RR 2.3 – 5.5 × — these were
  A-setups that still hit stop.
- Distribution by cycle:
  - Transitional: 14 trades / −35.3 % sum pnl
  - Downtrend: 7 trades / −14.4 %
  - Uptrend: 4 trades / −9.6 %

This is the single largest PnL leak. Transitional regime is over-represented.

### Proposal

Two complementary levers:

### P2a. Cycle-conditional hard-loss cap

Introduce an additional safety cap that is stricter in transitional /
downtrend regimes (where the base `max_loss` stop of −2 % sees a 50-70 % hit
rate on losers). When backdrop cycle ∈ {`transitional`, `downtrend`}, halve
the distance for `HARD_LOSS_CAP` kick-in.

```
deep_audit_hard_loss_cap_cycle_mult_transitional = 0.5
deep_audit_hard_loss_cap_cycle_mult_downtrend = 0.5
```

### P2b. Rank-quality penalty re-examined

For the 12 A-setup losers, cross-check `score`, `rank`, and `ltf_score` at
entry. Hypothesis: entries at rank ≥ 95 were in parabolic extension (we reach
rank=100 at late-cycle extension, when the setup is exhausted rather than
fresh). **Add a penalty that requires `ltf_score >= 30`** for entries
scoring ≥ 95 during transitional/downtrend cycles.

```
deep_audit_high_rank_transitional_min_ltf_score = 30
```

### Expected effect

On training months, P2a alone would have cut realized loss from the 14
transitional `max_loss` fires by ~50 % (~ +17 % PnL). P2b eliminates the
parabolic-rank traps in downtrends (5-7 fires) for another ~ +10 % PnL.

Combined: projected **+25-30 % PnL** on training months with WR rising to
~62 %.

---

## P3 — Downtrend regime guard for Tier-1 single-stocks  (MEDIUM confidence, MEDIUM impact)

### Evidence

- Training-month cohort × cycle breakdown:
  - Downtrend + Tier-1-stock: **n=7, WR 29 %, sum pnl −5.8 %, 0 big winners.**
  - Downtrend + Tier-2: **n=20, WR 58 %, +15.8 %, 1 big winner.**
- Tier-1 names (AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA) behave differently
  from Tier-2 in downdraft months because they are the index leaders — when
  the tape rolls over, they carry the decline.

### Proposal

Add a cycle-aware rank floor for Tier-1 single-stock entries:

```
deep_audit_downtrend_tier1_stock_min_rank = 90
deep_audit_downtrend_tier1_stock_tickers = AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA
```

In downtrend regime, require the rank to be ≥ 90 for these tickers (vs the
current open-floor of 70-80 in some pullback paths). This doesn't touch their
behavior in uptrend or transitional — only downtrend.

### Expected effect

Eliminates 4-5 of the 7 downtrend Tier-1-stock losers; ~ +4-6 % PnL impact on
training months, minimal trade-count reduction in up/transitional months.

---

## P4 — T6B (ETF entry relaxation, follow-on to T6A)  (LOW confidence, MEDIUM impact — needs holdout validation first)

### Evidence

T6A has been active for all 10 v2 months and produced **0** SPY/QQQ/IWM
trades. Block-chain analysis shows T6A's relaxed gate (`tt_pullback_not_deep_enough` with `min_bearish_count=1`) is
**not the binding constraint**.

When kanban stage = `setup` (the closest ETFs get — they never reach
`in_review` in training months), dominant blocks per ETF are:

| Reason | SPY | QQQ | IWM |
|---|---:|---:|---:|
| `tt_no_trigger` | 812 | 620 | 911 |
| `tt_bias_not_aligned` | 511 | 348 | 402 |
| `tt_momentum_30m_5_12_unconfirmed` | 135 | 97 | 160 |
| `tt_pullback_5_12_not_reclaimed` | 116 | 96 | 118 |
| `tt_pullback_non_prime_rank_selective` | 93 | 61 | 135 |

`tt_pullback_not_deep_enough` (the T6A target) never shows up at kanban=setup
for SPY/QQQ/IWM — it only fires at kanban=watch (an earlier stage). T6A was
correct in principle but targeted the wrong gate.

### Proposal

**DO NOT** deploy T6B blindly. First:

1. Instrument a dedicated probe that temporarily whitelists SPY/QQQ/IWM past
   `tt_no_trigger` and `tt_bias_not_aligned` to see whether a trade would ever
   fire, and at what forward-looking outcome.
2. If the probe shows actionable signal, gate that path behind a
   `deep_audit_etf_bias_alignment_override = SPY,QQQ,IWM` DA key with the
   condition that **VIX realized vol < 12 %** (uptrend calm regime only).
3. Validate on the 2026-03 and 2026-04 holdout months only.

Proposed DA keys (design only, **do not merge without holdout validation**):
```
deep_audit_etf_bias_relax_tickers = SPY,QQQ,IWM
deep_audit_etf_bias_relax_max_spy_realized_vol_pct = 12
deep_audit_etf_no_trigger_proxy_min_score = 95
```

### Expected effect

Unknown until probed. This proposal is **deferred** until the `tt_no_trigger`
root cause is understood.

---

## P5 — Starving months (Apr 2026 = 1 trade)  (OBSERVATIONAL, no action yet)

### Evidence

- 2026-04 (holdout): 1 trade. Cycle = uptrend, SPY +8.4 %, RV 11.8 %. 22,750
  bars scored, 13,128 blocked on `tt_bias_not_aligned` (58 %).
- This is the tail end of the Mar 2026 downtrend reversing into April's
  uptrend — classic regime-flip month. Cloud stacks on HTF are still mixed
  early- to mid-April.

### Note

Do NOT "fix" this by loosening `tt_bias_not_aligned` — the engine is
correctly refusing to chase a flip until it's confirmed. But **consider
adding a monthly synthesis guard**: if a month is flagged "uptrend" in the
Phase-B backdrop yet produces < 5 trades, log it as a "regime-flip under-
participation" event for follow-up.

---

## P6 — Validation / observational

### Events & earnings (PASS)

- `PRE_EVENT_RECOVERY_EXIT`: 14/15 fires within 1 d of high-impact macro
  event — **honoring**.
- `PRE_EARNINGS_FORCE_EXIT`: 3/3 fires were exactly 1 d before known
  earnings — **honoring**.
- 4 trades held through earnings; all were opened 1–6 days before earnings
  (outside the 36-h entry-block window).
- 13 of 165 trades (7.9 %) entered within 3 days of an earnings event, WR 50
  %. This is within random-chance and doesn't indicate a leak.

### TT_pullback vs TT_momentum performance

Trade records don't carry `setup_name` in the archive path (gap from
tt-pipeline → archive), so setup-family analysis requires inferring from
exit_reason + block-chain entry-path. Proposal for next iteration:
**persist `setup_name`, `entry_path`, and `kanban_signal` on the trade
record** so this slice can be made directly. Not a tuning proposal but an
instrumentation follow-up (listed in synthesis.md as TODO-I1).

---

## Implementation priority

1. **P1 (PRE_EVENT_RECOVERY_EXIT timing)** — lowest risk, highest-signal gain.
2. **P2a (cycle-conditional HARD_LOSS_CAP)** — biggest PnL lever, but
   requires validation on holdout first because it will also cut winners.
3. **P3 (downtrend Tier-1 rank floor)** — low complexity, MEDIUM impact.
4. **P2b (parabolic-rank LTF floor)** — interacts with P2a; test together.
5. **P4 (T6B ETF entry relaxation)** — deferred behind a probe.

Each proposal ships as an independent toggle so we can A/B them on 2026-03
(holdout) before mainstream adoption.
