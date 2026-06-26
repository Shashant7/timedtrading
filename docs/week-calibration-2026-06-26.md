# Week Calibration — 2026-06-20 → 2026-06-26

Live trader activity pulled from production D1 (`timed-trading-ledger`) on
2026-06-26. Re-run anytime:

```bash
node scripts/analyze-week-activity.mjs --days 7
```

---

## Executive summary

| Metric | Value |
|---|---|
| Realized P&L (exits in window) | **+$131.78** |
| Closed trades | 5 |
| New entries (opened in window) | 6 |
| Still open (from this week) | 3 underwater + legacy winners |
| `decision_records` captured | 4 rows (shipped mid-week, today only) |
| Net exit mix | 1 big winner (MU), 4 SL stops |

The week was **net positive on realized exits** because MU (+$459, +10.7%)
dominated four smaller stop-outs (-$327 combined). Open book carry is
underwater on NVDA (-4.1%), NEU (-1.6%), and GEV (-1.3%).

---

## Today (2026-06-26) — what was recorded

### Trades

| Time (UTC) | Ticker | Event | Path | P&L | Notes |
|---|---|---|---|---|---|
| 13:30 | IWM | ENTRY → EXIT (3 min) | `tt_ath_breakout` | -$41 (-0.91%) | SL honored quickly |
| 13:33 | NEU | ENTRY (open) | `tt_range_reversal_long` | -$102 (-1.65%) | Tier-A conviction stamped |
| 14:43 | GEV | ENTRY (open) | `tt_n_test_support` | -$119 (-1.34%) | Tier-A conviction stamped |
| 05:55 | GRNJ | EXIT | `tt_pullback` | -$192 (-4.74%) | Overnight SL (pre-RTH) |

### Decision provenance (`decision_records`)

All four rows landed today after PR #851 deployed:

| Ticker | Event | `config_hash` | `engine_git_sha` | `conviction_tier` |
|---|---|---|---|---|
| IWM | ENTRY | `7ac61ee3` | `6f4b879f` | A |
| NEU | ENTRY | `7ac61ee3` | `6f4b879f` | A |
| IWM | EXIT | `7ac61ee3` | `6f4b879f` | — |
| GEV | ENTRY | `5fcefa92` ⚠ | `6f4b879f` | A |

**Bug found:** GEV used the lazy-loader subset hash (`5fcefa92`, ~51 keys)
while cron-path rows used the full REPLAY_DA_KEYS hash (`7ac61ee3`, 443 keys).
Same live config, different fingerprint — breaks apples-to-apples Reflect.
**Fix:** PR unifies both paths via `loadDeepAuditConfigFromDb()`.

Inputs JSON on each row captures price, shares, reason, and note — enough to
reconstruct the ledger event. No DEFEND/TRIM rows yet this session.

---

## Full week activity

### Daily flow

| Day | Entries | Exits | Day realized |
|---|---|---|---|
| Mon 06-22 | 3 (PWR, QQQ, NVDA) | 1 (QQQ SL) | -$57 |
| Tue 06-23 | — | 2 (PWR SL, MU win) | +$421 |
| Thu 06-26 | 3 (IWM, NEU, GEV) | 2 (GRNJ SL, IWM SL) | -$233 |

### All exits (7-day window)

| Exit | Ticker | Path | Reason | P&L |
|---|---|---|---|---|
| Mon | QQQ | support bounce | `sl_breached` | -$57 |
| Tue | PWR | pullback | `sl_breached` | -$37 |
| Tue | MU | gap reversal | `PHASE_LEAVE_100` | **+$459** |
| Thu | GRNJ | pullback | `sl_breached` | -$192 |
| Thu | IWM | ATH breakout | `sl_breached` | -$41 |

### Exit reason ledger

| Reason | Count | Total P&L |
|---|---|---|
| `sl_breached` | 4 | -$327 |
| `PHASE_LEAVE_100` | 1 | +$875 (trades table; event +$459) |

SL discipline is working on **new** stops (IWM 3-min exit). MU shows the
management stack can capture trend continuation when structure holds.

### Entry path scorecard (opened this week)

| Path | Opened | Closed | Closed P&L | Assessment |
|---|---|---|---|---|
| `tt_range_reversal_long` | 2 | 0 | — | Both underwater (NVDA, NEU) |
| `tt_n_test_support` | 2 | 1 | -$57 | Mixed; GEV still open |
| `tt_pullback` | 1 | 1 | -$37 | Stop honored |
| `tt_ath_breakout` | 1 | 1 | -$41 | Fast false breakout |

---

## Open book (all live positions)

| Ticker | Entry | Path | Mark P&L | MAE | Flag |
|---|---|---|---|---|---|
| SNDK | May 6 | legacy | +35.2% | 0% | Trend hold winner |
| GS | May 27 | pullback | +2.6% | 0% | Healthy |
| NVDA | Jun 22 | range reversal | **-4.1%** | -4.1% | **Past published SL — no exit recorded** |
| NEU | Jun 26 | range reversal | -1.6% | -2.0% | Watch |
| GEV | Jun 26 | support bounce | -1.3% | -2.3% | Watch |

NVDA is the trust-spine issue: MAE equals mark loss (~-4.1%), adverse phase
divergence at entry (`has_adverse_phase_div: true`, 15m), personality
`VOLATILE_RUNNER`. No `decision_records` row exists (predates provenance ship).
This remains the highest-priority enforcement gap.

---

## Calibration recommendations

Prioritized for the self-calibrating loop. None flip conviction/bleeder flags
until forward `decision_records` validation clears (see
`docs/self-calibrating-loop.md`).

### Applied 2026-06-26 (PR pending deploy)

| Rec | Status | Implementation |
|---|---|---|
| P0 config_hash unification | **Live** (PR #856 merged) | `loadDeepAuditConfigFromDb()` |
| P0 NVDA SL enforcement | **Live** (PR #855 merged) | `sl-hard-exit.js` stale-price + PnL-implied marks |
| P1 range-reversal adverse phase gate | **Code + config** | `calibration-guards.js` + `deep_audit_range_reversal_block_adverse_phase=true` |
| P1 ATH false-break confirm | **Code + config** | min 5 min + 3 confirm cycles before ATH entry |
| P1 repeat churn (CRDO/MOD/GRNJ) | **Code + config** | Wired dormant `repeat_churn_guard`; include list + global 2× same-day SL |
| P3 pullback low-liquidity cap | **Code + config** | Caps `tt_pullback` notional on avg vol < 500k |
| P2 forward validation | **Operational** | `decision_records` accrual + weekly scorecard script |
| P3 full autopsy | **On demand** | `USE_D1=1 node scripts/calibrate.js --since 2026-06-20` |

Re-apply config: `node scripts/apply-week-calibration-config.mjs`

### P0 — Trust spine (act now)

1. **Deploy config_hash unification** — every new `decision_record` must carry
   `7ac61ee3` (or whatever the epoch hash is) regardless of entry path.
2. **NVDA SL enforcement** — confirm `sl-hard-exit` path fires when mark ≤
   published SL; add DEFEND/EXIT `decision_record` when remediated so the
   why-trail is complete.

### P1 — Entry quality (propose via `learning_proposals`, evidence-backed)

3. **`tt_range_reversal_long` gate review** — 2/2 new entries underwater;
   NVDA had adverse 15m phase div at entry. Consider requiring daily structure
   hold or blocking when `has_adverse_phase_div` on entry TF.
4. **`tt_ath_breakout` false-break filter** — IWM stopped in 3 minutes; require
   higher RVOL or 5m hold-above-break before ENTER_NOW promotion.

### P2 — Reflect accumulation (this week forward)

5. **Let `decision_records` accrue** — after hash fix deploy, expect every
   ENTRY/EXIT/TRIM/DEFEND to stamp `config_hash`, `engine_git_sha`,
   `conviction_tier`, and inputs JSON. Re-run forward validation at ~50 rows.
6. **Weekly scorecard cadence** — `node scripts/analyze-week-activity.mjs`
   every Friday; join exits to `config_hash` epoch once multiple epochs exist.

### P3 — Deeper calibration (next pass)

7. **Run full autopsy pipeline** when ready:
   `USE_D1=1 node scripts/calibrate.js --since 2026-06-20`
8. **Pullback path sizing** — GRNJ -4.7% is outsized vs other SLs (~-0.6 to
   -1.0%); review position sizing on low-liquidity names.

---

## What good looks like next week

- Every trade event has a matching `decision_records` row with a **single**
  `config_hash` per config epoch.
- NVDA either exits at SL with an attributable EXIT record, or SL is explicitly
  adjusted with a DEFEND/SL_TIGHTEN record explaining why.
- Forward validation script can group outcomes by `config_hash` without the
  lazy-loader confound.
