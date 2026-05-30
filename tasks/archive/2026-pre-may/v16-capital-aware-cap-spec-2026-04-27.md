# V16: Capital-Aware Position Cap (replaces count-based daily cap)

Created: 2026-04-27
Status: spec — implementation pending after V15 P0.7.6 completes
Priority: P1 (live system safety)

## Why we need this

The V15 P0.7.6 backtest removes the count-based daily entry cap (2/4/6 by
regime, then 4/8/12, then unlimited). The cap was correctly identified as
an artificial time-of-day filter that:

- Imposed scarcity on a system that already filters quality via multiple
  gates (focus_conviction, h3_consensus, sector concentration, etc.)
- Capped by COUNT not CAPITAL — wrong economic model.
- Created chronological bias: morning setups beat afternoon ones
  regardless of conviction (LITE Jul 14 15:30 missed in P0.7.5 because
  morning borderlines filled the count cap).
- Conflated different theses on different tickers (NVDA earnings catalyst
  vs META sector rotation — these don't compete for the same "slot").

Removing the cap is correct for the BACKTEST (where exposure has no
real cost). For the LIVE system though, capital is the real constraint,
and we need a new mechanism to enforce it.

## The capital model

Simulated paper account so users can follow along:

- **Account value (AV)**: starts at $X (e.g. $100,000), tracked via
  `account_ledger` and `portfolio_snapshots`.
- **Per-trade risk (R)**: 1-2% of AV (DA-keyed). Risk = `position_size ×
  abs(entry - stop) / entry`.
- **Allocated risk (AR)**: sum of R across all open positions.
- **Free risk capacity**: AV × max_account_risk - AR
  - `max_account_risk` defaults to 8% (i.e. up to 8% of account at risk
    simultaneously across all positions).

## The new cap rule

When evaluating a new entry:

1. Compute the candidate trade's risk: `R_candidate = entry_dollars × stop_pct`
2. Read current allocated risk: `AR_current = sum(R) for open positions`
3. If `AR_current + R_candidate > AV × max_account_risk`:
   - REJECT entry, reason `capital_cap_exceeded`
   - Log: `cap=X% allocated=Y% candidate_risk=Z% would_total=W%`
4. Otherwise: open as normal.

**Critically**: this is INDEPENDENT of trade count. 20 small-risk trades
totaling 5% of AV can all be open. 1 large-risk trade exceeding 8% gets
rejected.

## DA keys

```
deep_audit_capital_cap_enabled         = true
deep_audit_capital_cap_max_account_risk_pct = 8.0
deep_audit_capital_cap_per_trade_risk_pct   = 1.0  (default sizing)
deep_audit_capital_cap_emergency_floor_pct  = 1.0  (always allow if free risk >= 1%)
```

## Implementation plan

### Step 1: Already exists
- `account_ledger`, `portfolio_snapshots` tables already track AV.
- Per-trade entry calculates `entry_price × shares × stop_distance`
  implicitly through SL placement.

### Step 2: New helper in worker/index.js

```js
function getAllocatedRisk(env, replayCtx, isReplay, currentAV) {
  // Sum across open positions:
  //   R = entry_price × shares × abs(stop - entry)/entry
  // Returns dollar value.
  let allocated = 0;
  const positions = isReplay
    ? (replayCtx?.allTrades || []).filter(t => isOpenTradeStatus(t.status))
    : await db.prepare(`SELECT * FROM positions WHERE status='OPEN'`).all();
  for (const p of positions) {
    const px = Number(p.entry_price) || 0;
    const sl = Number(p.sl) || 0;
    const shares = Number(p.shares) || 0;
    if (px > 0 && sl > 0 && shares > 0) {
      allocated += px * shares * Math.abs(px - sl) / px;
    }
  }
  return allocated;
}
```

### Step 3: New gate in qualifiesForEnter (worker/index.js ~17680)

Insert AFTER existing gates but BEFORE entry execution:

```js
if (capitalCapEnabled && !isReplay) {
  const av = await getCurrentAccountValue(env);  // from portfolio_snapshots
  const ar = await getAllocatedRisk(env, ...);
  const candidateRisk = Number(tickerData.entry_dollars || ...) *
                        Math.abs(entryPrice - stopPrice) / entryPrice;
  const maxRisk = av * (maxAccountRiskPct / 100);
  
  if (ar + candidateRisk > maxRisk) {
    smartGateBlocked = true;
    smartGateReason = `capital_cap:allocated=${(ar/av*100).toFixed(1)}%/${maxAccountRiskPct}% candidate=${(candidateRisk/av*100).toFixed(1)}%`;
  }
}
```

### Step 4: Replay mode behavior

For backtests, the capital cap is OFF by default — the backtest is meant
to evaluate strategy ceiling, not capital efficiency. A separate
"realistic-capital" replay mode can be added later (DA-keyed) for users
who want to see what their actual paper account would have done.

### Step 5: UI exposure

Surface `available_risk_pct` on the dashboard so users see when they're
near the cap. Color the chip green / amber / red at 50% / 70% / 90%
allocated.

## Validation requirements

Before shipping (per tasks/v16-validation-methodology):

1. Re-run V15 P0.7.6 with `deep_audit_capital_cap_enabled=true` on the
   same Jul-Apr range.
2. Score the Would-Pass cohort vs Would-Block cohort.
3. Build the standard table:
   - Trades / WR / PnL / PF for both
   - List every Would-Block trade with PnL > +5% (these are real winners
     we'd skip — must validate the rejection was correct).
4. Ship only when Would-Block.PnL <= 0 AND Would-Pass.PnL >= 90% of
   uncapped baseline.

## Risks

- **Underestimating risk**: if stop_distance shrinks for high-conviction
  trades (tight stops on quality setups), allocated risk could
  under-count. Mitigation: use `risk = max(stop_distance, 0.5×ATR)` as
  the conservative estimate.
- **Account value lag**: portfolio_snapshots may be stale by 1-2
  minutes. Mitigation: read live KV-cached account value; refresh on
  every entry.
- **Realized losses don't immediately free capacity**: when a trade
  exits at a loss, the next entry's risk calculation should use the
  NEW (lower) AV. We already update `account_ledger` synchronously on
  exit, so this works naturally.

## Filed under

- This file: `tasks/v16-capital-aware-cap-spec-2026-04-27.md`
- Implementation: V16 P1
- Related: `tasks/v16-validation-methodology-2026-04-27.md`
