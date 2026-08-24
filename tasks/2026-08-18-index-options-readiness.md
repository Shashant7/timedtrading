# Index options readiness — SPY / QQQ / IWM (2026-08-18)

Operator ask (this session): "How close are we to executing options
trades at a high success rate?" Specifically SPY / QQQ / IWM day
trades and multi-day, feeding off the Daily Brief + scoring updates.

The SPY 772P (1 DTE) the operator saw yesterday is the reference
case. It was directionally right and the strike snapped to the day's
bear target. Operator flagged two things the play didn't do:

1. An ITM alternative (say 777P / 775P) to soften theta / gamma risk.
2. A slightly longer DTE (3 days out) for the same directional read.

Both are real gaps. This doc scopes what already works, what does
not, and what to ship to move from "sometimes right" to a scorecard
we can trust.

---

## 1. What already exists (verified against code + prod)

### Data plane
- **Real options chain**: `worker/alpaca-options.js` — Alpaca OPRA
  snapshots (bid / ask / IV / Greeks, per-strike, filterable by
  expiration). Auth works on the same key as equity execution.
- **Chain resolver + cache**: `resolveAndFetchOptionsChain` in
  `worker/options-plays.js` — chain-first pricing when available,
  BS + ATR-IV estimator as fallback.

### Play compilation (SPY / QQQ / IWM specific)
- **Day-trade builder**: `buildDayTradePlay(ctx)` in
  `worker/options-plays.js` — SPY / QQQ / IWM / DIA allow-list. Picks
  ATM strike (speculator gets slight OTM, ~0.5%). 0 DTE before 3 PM
  ET, 1 DTE after; conservative / moderate default to 1 DTE. Snaps
  to the real $1 grid for indices (fixes the DIA $510 / $502.92
  incident). Emits `day_trade_call`, `day_trade_put`, or
  `day_trade_straddle` (WAIT-day + speculator + high vol).
- **Day-lean**: `computeDayLean` in `worker/day-trade-game-plan.js`
  — LONG / SHORT / NEUTRAL with a signed score. Drives play flavor
  when conviction is medium/high (`_flavorSource: "day_lean"`);
  otherwise the play falls back to the multi-day confluence gate.
- **Index-only entry model**: `worker/pipeline/index-etf-model.js`
  — SPY / QQQ / IWM slow / moderate / wide range profiles; BLOCKS
  stock triggers (ATH breakout, tt_pullback, tt_mean_revert) on the
  indexes. Prevents the model from ever taking SPY as a support
  bounce single stock.

### Surfaces already wired
- **Right Rail Options tab** (`OptionsTabPanel` in
  `react-app/shared-right-rail.js`) → `/timed/options/ticker`.
- **Today page**: `DayTradePredictions` component +
  `/timed/day-trade-predictions` (per-index bull/bear/lean/grade)
  and `/timed/options/all` (top day-trade plays universe-wide).
- **Shadow mode**: `worker/options-shadow.js` — attached to every
  live entry, three tiers (Model default / Looser / Loosest valid),
  Discord + email embed, logged to `signal_outcomes` with
  `desk="shadow"`.
- **Signal Outcome Ledger**: `worker/signal-outcomes.js` — nightly
  resolver grades every published call **against the underlying**
  (target vs stop before expiry), records grade + outcome_pct.

### Auto-mirror (off by default)
- `worker/options-auto-mirror.js` — Phase 3 pipeline exists.
  Operator-only, per-vehicle daily cap, per-order max USD, IBKR
  route via `BROKER_BRIDGE`. `long_call` / `long_put` default OFF.
  Alpaca paper supports options; Webull options-buy is stubbed only.

### Live snapshot (18 Aug 02:30 UTC)
```
/timed/options/all → 3 day-trade plays live
  SPY  day_trade_put   strike 769 (spot 772.67) 1DTE $1.54  day_lean SHORT medium  conf WAIT (24)
  QQQ  day_trade_call  strike 733 (spot 729.48) 1DTE $1.51  day_lean NEUTRAL low   conf DRIFT (28)
  DIA  day_trade_put   strike 531 (spot 533.86) 1DTE $0.97  day_lean SHORT medium  conf WAIT (35)
  IWM  suppressed — day_lean NEUTRAL low, WAIT
```
This is the same class of play the operator saw. Direction is
already being derived, strike is being snapped, premium is being
estimated. The mechanism works.

---

## 2. Where the gap is (why "sometimes right" is not "high success rate")

### Gap A — we grade against the underlying, not the contract
Every published day-trade play is scored by whether the underlying
hit the target before the stop. That answers "was the DIRECTION
right?" It does NOT answer "did the CONTRACT pay?" The 772P at
$1.54 has three separate outcomes we currently conflate:

- Direction hit → 771.07 tag, 772P closed +47%. GOOD.
- Direction hit late → 772.30, theta killed it before the touch. BAD.
- Direction missed → 774, 772P closed −80%. BAD.

Without an option-mark record we cannot tell C from B or B from A on
paper. The scorecard has been running on shares logic since May.
Consequence: we cannot tune strike selection, DTE choice, or exit
timing against a real edge signal.

### Gap B — no strike / DTE ladder
`buildDayTradePlay` picks ONE strike (ATM or ±0.5%) and ONE DTE
(0/1). That is the operator's SPY 772P complaint distilled: the
system offers no ITM safety tier and no 3-DTE breathing tier. Both
are trivial extensions of the existing code — the ladder builder
already ranks strikes by delta profile, just not for the day-trade
class.

### Gap C — no trim/exit doctrine on the options card
The play prints `notes` telling the trader to "manage actively",
"exit if not working by lunch on 0DTE." Those are copy, not rules.
There is no `_option_management` object saying "bank half at +40%,
hard stop at −50%, time stop 12:00 ET." Trade Review sees closed
share trades (that PR just landed); it has never seen an options
position.

### Gap D — day_lean vs confluence conflict
Today's SPY: confluence WAIT (24/100) LONG-tilted, day_lean SHORT
medium → play is a put. That is intentional (`_flavorSource:
"day_lean"`), but it is untested. We do not know the historical win
rate of `WAIT / day_lean medium` on SPY vs QQQ vs IWM. Might be
70%, might be 40%. Feels like the SPY 772P was a hit; N=1.

### Gap E — sizing + auto-mirror
- One contract minimum, scaled via a Mission Control cap. Fine for
  paper, not for compounding.
- Auto-mirror is off by default for options. Even when the play
  reads right, no capital moves.
- Broker coverage: Alpaca paper options are live; IBKR live is
  wired; Webull options-buy is a stub. Multi-broker parity is not
  there.

### Gap F — no options replay / backtest
Replay is shares-only. `worker/model-play-sim.js` marks the option
paper fill at BS+ATR at entry but does not track theta path. The
whole 6-month autopsy that produced ST + LT tuning has zero options
outcome data. We are tuning in the dark.

---

## 3. What would a "high success rate" system look like

Working definition, operator-owned: on SPY / QQQ / IWM day-trade
plays with **medium+** conviction, contract P/L is positive on ≥60%
of instances, median max-gain / max-drawdown ≥ 1.5, and the
system's exit doctrine captures ≥50% of the max-gain.

That is the same "capture, don't be right" doctrine PR #1272 wrote
for equity trades (LEFT_MONEY / CORRECT_LOSS). Options need the
same. Six stages to get there. Each ships behind a flag; nothing
routes to the bridge until the scorecard proves edge on paper.

### Stage 1 — instrumentation (measure before we tune)

- **`option_marks` D1 table**. For every published day-trade play
  (`day_trade_call/put/straddle`) and shadow play (three tiers),
  snapshot the live contract every ~5 min while the play is "open"
  (published_at → expiry or close). Fields: `signal_id`,
  `option_symbol` (OCC), `ts`, `bid`, `ask`, `mid`, `iv`, `delta`,
  `underlying`, `spot_source`.
- **Options-side resolver**: extend nightly `signal_outcomes`
  resolver to compute `option_max_gain_pct`, `option_max_drawdown_pct`,
  `option_close_pct`, `theta_realized_pct` off the marks.
- **Backfill 30 days**: Alpaca options bars
  (`/v1beta1/options/bars`) reconstruct the marks for already-
  published plays (three tiers × ~4 indices × ~22 sessions).
- **Scorecard endpoint**: `GET /timed/admin/options-scorecard?
  days=30&ticker=SPY,QQQ,IWM` — direction hit rate, median gain /
  drawdown, win rate at 25/50/100% take-profit rules, all sliced by
  `day_lean_conviction` and `confluence_mode`.

Deliverables land dark; no user-visible change. Purpose is to know
what we already have before adding.

### Stage 2 — strike + DTE ladder (address operator's ITM / 3-DTE ask)

Day-trade builder returns three variants, not one:

- **Gamma tier** — current behavior (ATM or ~0.5% OTM, 0 / 1 DTE).
  Highest gamma, worst theta.
- **Safety tier** — ~1% ITM (delta ~0.55–0.65), 1–2 DTE. Theta
  cushion; still directional. This is the SPY 777P alternative the
  operator asked for.
- **Breathing tier** — ATM, 3–5 DTE. A right direction that takes
  a day to develop still pays.

Right Rail Options tab shows all three; the scorecard grades them
separately per index so we know which tier wins for SPY vs QQQ vs
IWM. Speculator picks Gamma by default, Aggressive picks Safety,
Moderate picks Breathing. Operator can override per-play.

### Stage 3 — directional gate honesty

- Backtest the day_lean → contract win rate on the scorecard. If
  `medium` is 45% and `high` is 62%, drop `medium` from
  `_flavorSource: "day_lean"` when confluence is WAIT with an
  opposing side. Keep `medium` when confluence agrees.
- Add a **confluence-veto** rule: WAIT confluence with the
  confluence side opposing day_lean → auto-downgrade the play a
  tier (Gamma → Safety, Safety → Breathing). Never invert; just
  give the trade more room.
- Publish the "which conditions worked" table in the Daily Brief so
  the operator sees the edge before the day starts.

### Stage 4 — trim / exit doctrine on the options card

Each play carries a machine-readable `option_management` block:

```json
{
  "take_profit_1": { "pct": 40, "size": 0.5 },
  "take_profit_2": { "pct": 100, "size": 0.5 },
  "hard_stop_pct": -50,
  "time_stop_et": "12:00",
  "invalidation": {
    "underlying_below": 764.77,
    "underlying_above": 779.53
  }
}
```

Right Rail + Discord render as three checkboxes ("+40% → half",
"+100% → close", "underlying 764.77 → hard stop"). Trade Review
grades the closed contract through the same TRADE card the equity
lane uses — same LEFT_MONEY / CORRECT_LOSS verdict semantics.

### Stage 5 — paper auto-mirror on the three indices

- Turn `long_call` / `long_put` `enabled: true` **only for
  SPY / QQQ / IWM** at `max_loss_per_order_usd: 100`,
  `daily_cap: 2`. Alpaca paper only. Kill switch stays hot.
- Requires Stage 4 (or the mirrored order has no exit rule).
- Requires Stage 1's scorecard to show ≥60% contract-win rate on
  the graded tier before it comes off paper.

### Stage 5b — lifecycle mirror (trim / exit / stop closes)

Shipped on `maybeAutoMirrorIndexDayTradeEvent`:

- **BUY** — limit entry at `display_buy_ceil` (live mid capped); records
  `timed:opt-dt-mirror:{signal_id}` when the bridge accepts the order.
- **TRIM** — SELL `trim_sell_qty` contracts at live premium (≥2-lot books).
- **EXIT / STOP** — SELL remaining contracts (`contracts_remaining` after
  trim, or full size on single-lot).
- **PROTECT** — paper-only (breakeven + trail armed); no broker order.
- Closes only fire when a mirrored **entry** exists for that signal id
  (dedup: one trim + one exit per signal).
- Still **not** native bracket orders — each event is a separate signed
  LMT sell via `POST /bridge/options/order`. Bridge reducer guards
  enforce held qty.

Enable: `options_auto_mirror_indices` + auto-mirror master + vehicle toggles.

### Stage 6 — multi-day (2–5 session) SPY / QQQ / IWM plays

- New builder `buildIndexSwingPlay`: 5–14 DTE ATM or ~2% OTM, sized
  by `stop_max_pct` from the index profile.
- Fires only when the index-etf-model qualifies the entry (already
  gated). No stock-path leakage.
- Same option_marks / scorecard / trim doctrine as Stage 1–4.

### Stage 7 — surface the edge in the Daily Brief

- Header row per index: last-30d record, best window, current
  day-lean, edge-verdict.
- Daily brief prompt ingests the scorecard rollup so the AI
  narrative can lead with "SPY day-trade record: 18-12 (60%) on
  medium+ conviction, best window 9:45–11 ET."
- Right Rail Options tab shows the tier chosen + rationale +
  historic win rate — the whole card tells the operator not just
  "buy this" but "here is why, and here is how often it worked."

---

## 3.5. Shipping order — one PR, all seven stages, staged activation

Operator direction (this session): build all seven stages in one drop
so the plumbing is in place. Tune with real data, then flip flags
one at a time.

Rules for the single-PR drop:

- Every stage lands **default off**. No behaviour changes on merge.
- Stages have flags in `model_config` (and `REPLAY_DA_KEYS`).
- Tests per stage — each stage must pass its own unit tests before
  the next commit is added to the branch.
- One logical commit per stage. Reviewers (and rollback) can pick
  individual stages out cleanly.

### Activation ladder (post-merge)

The flag flips are ordered so measurement always lands before any
capital-facing change.

| Order | Flag | Effect |
|---|---|---|
| 1 | `options_marks_enabled=true` | Stage 1 snapshot cron + resolver start writing. No user surface yet. |
| 2 | `options_backfill_run=1` (one-shot) | Stage 1 30-day Alpaca backfill; reads-only. |
| 3 | `options_scorecard_enabled=true` | Admin scorecard endpoint returns real numbers. |
| 4 | `options_ladder_tiers=true` | Stage 2 three-tier day-trade cards published on Right Rail + /timed/options/all. |
| 5 | `options_gate_honesty=true` | Stage 3 confluence-veto tier-downgrade. |
| 6 | `options_management_card=true` | Stage 4 exit doctrine block rendered + Trade Review consumes closed contracts. |
| 7 | `options_brief_surface=true` | Stage 7 daily brief + Right Rail historic win rate. |
| 8 | `options_auto_mirror_indices=true` | Stage 5 paper auto-mirror SPY/QQQ/IWM `long_call/long_put`. Only after the scorecard shows ≥60% contract-win rate. |
| 9 | `options_index_swing_enabled=true` | Stage 6 multi-day builder. |

Nothing here auto-flips. Every step is an explicit operator write to
`model_config`. Stage 5 stays paper (Alpaca) even when enabled;
IBKR live flip is a separate write on the bridge side.

---

## 4. Honest readiness answer

Today:

- **Direction / strike / DTE**: OK for SPY / QQQ / IWM 0/1 DTE
  ATM plays. Live SPY 772P instance was a hit; N=1.
- **Contract win rate**: unknown. We grade against the underlying.
- **Strike alternatives**: none — no ITM tier, no 3 DTE tier.
- **Exit doctrine**: prose only.
- **Sizing / execution**: 1 contract paper; auto-mirror OFF.
- **Feedback loop**: closed-loop only on shares. Trade Review has
  never seen an option position.

Distance to "high success rate" is a measurement problem first
(Stage 1), then a strike-menu problem (Stage 2), then an exit
problem (Stage 4). Stages 3, 5, 6, 7 are tuning + surface once the
measurement exists.

The cheapest first ship is **Stage 1 + Stage 2** together:
option_marks ledger with 30-day backfill, and the three-tier
ladder in the day-trade builder. That unlocks the scorecard AND
gives the operator the ITM / 3-DTE tiers to trade against while we
watch the data come in.

No new UI required beyond the extra tier cards on the Right Rail
Options tab and an admin scorecard route. No auto-mirror flip
until the scorecard shows edge. No broker changes until Stage 5.

---

## 5. Non-goals

- No new option archetypes beyond the three tiers. Iron condors,
  strangles, and calendars are already in the ladder but they are
  not what SPY / QQQ / IWM day-trading needs to close the current
  gap.
- No LLM decision path. Direction stays deterministic (day_lean +
  confluence). LLM only summarizes.
- No Webull options adapter. IBKR + Alpaca is enough to prove the
  edge; adding Webull-options before we know the win rate is
  premature.
