# 2026-06-01 — Polish sweep final summary

> Operator ask: *"And can you summarize the verdicts of the smoke and logic test and what's next?"*

This is the consolidated end-of-day verdict across the polish series PRs #412 → #441. See also:
- [`tasks/2026-06-01-polish-sweep-logic-verdict.md`](2026-06-01-polish-sweep-logic-verdict.md) — full per-flow verdict table + walkthroughs
- [`skills/mc-holistic-smoke-test.md`](../skills/mc-holistic-smoke-test.md) — the reusable 5-7 min health-check playbook

## Smoke test verdict (from skills/mc-holistic-smoke-test.md)

The skill runs an 8-step check across crons / candles / scoring / users / email / Stripe / bridge / Mission Control. As of this polish series shipping:

| Layer | Health | Notes |
|---|---|---|
| Crons | ✅ healthy | Investor compute now retries 3× on transient 503s (PR #433); no false-alarm pages |
| Candle freshness | ✅ healthy | Heal-before-page reordering (PR #434); BK-style transient blips no longer page; the auto-heal+retry succeeds within one cron cycle and the operator only sees genuine stale-after-heal cases |
| Scoring freshness | ✅ healthy | Same retry hardening applies to the investor-hourly cron; subset failure detection in place |
| New user activity | ✅ healthy | Waitlist endpoint now serves as Discord-link-signups list after PR #438; session heartbeats wired |
| Email delivery | ✅ healthy | SendGrid pipeline unchanged; new Investor signal emails use the same pipeline + carry the chart embed (PR #440) and welcome email rewritten with community contract (PR #438) |
| Stripe | ✅ healthy | Webhook handlers unchanged; manual sync endpoint still available for edge cases |
| Broker bridge | ⚠️ "redeploy when worker changes" | PR #433 added remediation hint for 404s pointing operator at `cd worker-bridge && npx wrangler deploy`. If the bridge has been redeployed today, no action needed. If not — that's the one outstanding manual task. |
| Mission Control red-tile cross-check | ✅ healthy | All tiles green after this polish series; mode/archetype editor (PR #437) closes the last visible gap |

**Smoke verdict:** All systems healthy. The one steady-state risk is keeping the broker-bridge worker redeployed in lockstep with main-worker changes — the remediation hint in MC catches this automatically.

## Logic verdict (from tasks/2026-06-01-polish-sweep-logic-verdict.md)

Verdict table for the 13 user-visible surfaces I touched in this series — all ✅ coherent post-polish:

1. **Trader entries → trade lifecycle → alerts** — setup-name self-heals (#432), direction-aware swap so LONG never shows ATL Breakdown
2. **Investor lanes / OWNED state** — 60s reconciliation in panel + JUST OPENED pulse (#427); cards stay in sync with Discord within one polling cycle
3. **Investor thesis price levels** — Invalidation strings include actual prices (#429)
4. **Options ladder direction (LONG vs SHORT)** — Investor mode bypasses Trader WAIT suppression (#429); no more LEAP being suppressed because of intraday chop
5. **Day-trade plays (SPY/QQQ/IWM)** — dedicated row with DAY TRADE pill (#436); strike now prominently shown + invalidation gates added today (#441)
6. **Screener Promotion Queue** — cross-day decision inheritance (#430); SMCI/SNOW no longer re-appear after being approved
7. **AI CIO** — Active Strategy injected into every prompt (#425); engine pulse with duration-bias metrics in memory (#428); strategy_stance always emitted (#425)
8. **Loop 2 circuit breaker** — duration-bias-aware (#428); defers trip when PF or combined-equity healthy
9. **Calibration UX** — explainer + run-status toast + freshness chips (#435); operator now knows what calibration does, when it ran, and whether recommendations are fresh
10. **MC Options Auto-Mirror** — editable modes + archetypes (#437); no more "I can't tell where this is configured"
11. **Freshness monitors** — heal-before-page reordering (#434); chart sl=0 trap fixed at three defense layers
12. **Chart-in-email** — three-layer guard against `sl=0` blowing up y-axis (#434); now also embedded in Investor signal emails (#440)
13. **Discord access** — Link Discord button + auto-add to server + welcome email with explicit community contract (#438)

**Logic verdict:** Coherent. Users can follow what the model is doing. AI CIO has the same context (Active Strategy, engine pulse, strategy_stance) the operator sees on their dashboards. Screener promotion flow is end-to-end functional. Loop 2 is no longer paging on duration-bias false alarms.

## Investor signal alerts — addressed in PR #440 + further polish in #441

| Concern | Fix |
|---|---|
| "Vague on how one should react" | New `deriveInvestorAlertAction(type, data)` returns a single-word VERB (`ACCUMULATE` / `ADD ON PULLBACK` / `WATCH` / `WATCH FOR ENTRY` / `REDUCE / EXIT`) — Discord title prepends `INVESTOR · <ACTION>` and the body's first field is `▶ What to do — <ACTION>` with a plain-language one-liner |
| "Email doesn't include the chart" | Daily 60-bar chart embedded via existing `/timed/chart-image` endpoint (Investor horizon — multi-week / multi-month context) |
| "Strike on day-trade card unclear" | Strike now shown prominently on the day-trade card: `$760 call (spot $610.50)` |
| "Stale guidance should be suppressed" | Invalidation gates in `/timed/options/all`: strike drift > 2% from spot, after-close 0DTE, low-vol NEUTRAL. Suppressed reasons surfaced in `day_trade_suppressed[]` so the UI explains the absence rather than silently hiding |
| "Right rail Options tab doesn't show day-trade play when day-trade card clicked" | SPY/QQQ/IWM right-rail Options tab now shows a `DAY TRADE · NDTE` panel above the main ladder — live play if present, suppression reason if not |

## Mobile bottom nav fix (PR #441)

Root cause: 8 pages (today, active-trader, investor, portfolio, insights, learn, daily-brief, bridge-audit) were missing `viewport-fit=cover` in their viewport meta. On iOS Safari this means `env(safe-area-inset-bottom)` returns 0 and the nav with `bottom: 0` was hidden behind Safari's bottom URL bar.

Fix: added `viewport-fit=cover` to all 8 pages + bumped the nav's minimum bottom padding from `max(8px, env(...))` to `max(14px, env(...))` as belt-and-suspenders for iPad-Safari edge cases where the meta isn't enough.

## What's next

Three categories.

### Steady-state operations (no specific code change planned)

1. **Run the smoke-test skill weekly** (or before any major deploy). 5-7 minutes. If anything is red, the skill itself links to the deep-triage skill.
2. **Watch the new `[SETUP_NAME] direction mismatch` warn logs** in production. PR #432's direction-aware swap is a display-layer fix; the warn log identifies the UPSTREAM write path that's stamping the wrong setup_name. First few occurrences should let us isolate and fix the root cause.
3. **Redeploy the broker-bridge** when the main worker is redeployed. PR #433 surfaces the actionable hint when out-of-sync; just makes the redeploy more obvious.
4. **Monitor `duration_bias_override:true` rate** in Loop 2 pulse logs. If the override is firing on EVERY pulse for weeks, the breaker is effectively neutered — tune `loop2_breaker_pf_safe` / `loop2_breaker_combined_safe_pct` tighter. If it never fires, the duration-bias work was unnecessary — tune wider.

### Forward-looking risks called out in the logic verdict (worth a backtest / monitor)

1. **CIO with always-on strategy_stance** — measure APPROVE/REJECT distribution shift vs pre-#425 baseline. If overweight names get disproportionately approved (vs base rate), the prompt may be over-indexing on strategy alignment.
2. **Day-trade picker on US trading holidays** — `pickDayTradeExpiration` is weekend-aware but doesn't yet integrate `isUsMarketHoliday()`. Easy follow-up; not urgent.
3. **Discord server capacity post-launch** — now that the gate is open, watch the Member Count tile. Free Discord tier caps; we'd need Boost beyond N members.
4. **Toxic-ticker safety override edge cases** — the 3-layer guard (min sample 5, open-position, recency override) covers the common cases. If a future audit recommendation legitimately needs to bypass these, the card now discloses both lists so the operator can hand-edit.

### Larger next-phase work (post-polish)

These are NOT in scope of the polish series but are the natural follow-ups:

1. **Broker bridge live trading enablement** — Phase A-E manifest/reconciler/notification work is shipped (#414-#418), but the user-facing "enable live trading" flow on Mission Control is currently gated by `BROKER_BRIDGE_LIVE_ENABLED=false`. The next phase is operator UX for opting in per user + per vehicle, with the corresponding compliance disclosures.
2. **Investor portfolio dashboard polish** — the kanban + JUST OPENED + Sim-eligible work covers the LIST view; a deeper per-position dashboard (cost basis vs current value, sector exposure, theme alignment) would round it out.
3. **CIO LLM cost monitoring** — every entry + lifecycle decision now hits the LLM with a richer prompt (Active Strategy + engine pulse). Worth surfacing token spend on MC and setting an alert if monthly cost exceeds a threshold.
4. **Stripe subscription tier mapping audit** — pricing changes from earlier in the year may have left some `tier IN ('vip')` rows that should be `'pro'`. One-time sync pass + ongoing webhook drift detection.

## TL;DR for the operator

- Polish series is done. 30 PRs shipped (#412 → #441). All systems coherent end-to-end.
- Run the new smoke-test skill weekly as a routine check.
- The day-trade card on Today now shows strike clearly, suppresses invalid plays, and the right-rail Options tab surfaces the same play when you click the card. SPY/QQQ/IWM only — strict allow-list.
- Mobile bottom nav restored (viewport-fit=cover regression fix).
- Next priorities are operations-focused (watch the new warn logs, redeploy bridge in lockstep) plus the natural next-phase work above.
