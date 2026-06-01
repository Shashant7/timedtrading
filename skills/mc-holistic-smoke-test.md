# Holistic Mission Control Smoke Test

**WHEN to use:** Periodic system health pass. Run before major changes, after deployments, weekly as a routine check, or whenever the operator asks "is everything healthy?". This skill is the single source of truth for the full-system signal-vs-noise check across crons, candle integrity, scoring integrity, user activity, email delivery, and Stripe.

**WHO this is for:** Operator or any agent triaging "is anything broken?" without specific symptoms. For a known-symptom triage, jump straight to the relevant skill ([broker-bridge.md](broker-bridge.md), [d1-debugging.md](d1-debugging.md), [backfill-candles.md](backfill-candles.md), etc.).

**Sequence summary:**
1. Crons firing on schedule
2. Candle freshness (active universe)
3. Scoring freshness + completeness
4. New user activity (signups + sessions)
5. Email delivery health (SendGrid + DMARC)
6. Stripe health (subscriptions + recent webhooks)
7. Broker bridge connectivity
8. Cross-check: anything in Mission Control showing a red KPI not already covered above

Each step takes 30-60 seconds. Total: ~5-7 minutes.

---

## 1. Crons firing on schedule

**Endpoint:** `GET /timed/health`

**Look at:**
- `lastCronRun` per cron name — should all be within their expected interval
- `cronFailuresLast24h` — should be ≤ 1 for each cron (transient retries OK; persistent failures = real)
- The "Scheduled Crons" section of Mission Control shows the same info visually

**Healthy:**
- `*/5 * * * *` (scoring) — last run < 6 min ago
- `0 14-21 * * 1-5` (investor hourly) — last run within the current trading hour (or last weekday end if weekend)
- `0 21 * * 1-5` (evening brief), `0 11 * * 1-5` (morning brief) — within last 24h on weekdays
- `*/5 * * * *` (broker reconciler, gated by RTH) — same as scoring during RTH

**Unhealthy patterns:**
- Single cron `cronFailuresLast24h >= 2` and `lastCronRun` is stale → check Discord for the corresponding `Cron Failure:` alert; the alert body has the remediation
- Many crons stale at once → worker deploy may have failed; check `wrangler deployments list` for the latest active deployment

**Cron failure tombstones** are written to `timed:cron:failure:<op>` in KV. The Mission Control "Cron Health" tile + `/timed/health` both read these. After fixing, clear via `wrangler kv:key delete timed:cron:failure:<op>`.

---

## 2. Candle freshness (active universe)

**Endpoint:** `GET /timed/admin/freshness-summary` (or inspect Mission Control "Worst Stale Ticker" tile)

**Look at:**
- Worst 60m candle age (in hours) — should be < 24h on weekdays, < 72h Monday morning (the weekend-aware threshold catches the Friday-close → Monday-9-AM gap)
- Worst D candle age (in days) — should be < 5d
- Number of stale tickers — should be 0 in steady state

**Healthy:**
- Worst 60m < 4h during RTH, < 24h overnight, < 72h Mon-9am
- No `candle_freshness_60` or `candle_freshness_d` cron failure tombstones

**Unhealthy patterns:**
- Single ticker persistently stale (e.g. BK D-feed) → likely M&A / corporate action; verify on a public quote, then either add to `FRESHNESS_EXCLUDE` in `worker/index.js` or backfill via [backfill-candles.md](backfill-candles.md)
- Many tickers stale at once → vendor outage; the auto-heal sweep should clear within 1-2 cron ticks (PR #434 reordered the monitor to heal BEFORE paging; a single transient gap should no longer alert)
- Daily candle stale > 5d → check TwelveData REST directly: `POST /timed/admin/td-backfill?ticker=<sym>&tf=D&days=10`

---

## 3. Scoring freshness + completeness

**Endpoint:** `GET /timed/health` → `minutesSinceScoring` + `timed:investor:computed-at` (KV)

**Look at:**
- Scoring cron last run < 10 min during RTH
- `timed:investor:computed-at` < 90 min during RTH (hourly cadence)
- `/timed/health` → `scoredTickerCount` ≈ universe size (200-250 tickers; large drop = subset failure)

**Healthy:**
- `minutesSinceScoring` < 10
- `scoredTickerCount` within 5% of expected
- Investor scores computed within the last hour during RTH (PR #433 added retry — single transient 503s no longer break the cron)

**Unhealthy patterns:**
- `scoredTickerCount` drops 20%+ → check for a recent universe change or a worker-CPU breach (subrequest cap hit mid-pass)
- `investor:computed-at` stale 2h+ during RTH → cron tombstone should be present; check Discord for the `investor_hourly_compute` alert
- Investor scoring works but Trader scoring is stale → `/timed/all` cron is the one stalled; different cause from the investor path

---

## 4. New user activity (signups + sessions)

**Endpoints:**
- `GET /timed/admin/waitlist?limit=50` → recent waitlist signups (now Discord-link signups after PR #438)
- `GET /timed/admin/sessions?range=24h` → session heartbeats per user

**Look at:**
- Daily signups in line with the last 7-day baseline (no sudden 90% drop)
- Active session count > 0 (members are using the platform)
- New CF Access users in `users` table matched against waitlist (i.e. emails on the waitlist are converting to actual sign-ins)

**Healthy:**
- 7-day rolling signup average within ±50% of the trailing 30-day average
- Median session heartbeat per active user ≥ 5/day during RTH

**Unhealthy patterns:**
- Sudden signup drop with no other system change → the landing page may be broken; load `https://timed-trading.com/splash.html` in an incognito tab and verify
- Active sessions > 0 but 0 cron-fired Discord alerts → check Discord webhook (the **Email & Discord Health** section of Mission Control flags webhook delivery counts)

---

## 5. Email delivery health (SendGrid + DMARC)

**Endpoints:**
- `GET /timed/admin/email-health` → daily send count, bounces, complaints, DMARC alignment
- SendGrid Activity Feed (login to SendGrid dashboard for the latest 1000 events)

**Look at:**
- Daily volume in line with expected (entry / trim / exit alerts + 2 briefs per active subscriber per weekday)
- Bounce rate < 1% (SendGrid alerts if higher)
- Complaint rate < 0.1%
- DMARC aligned for the `from` domain (no recent failures in Postmaster Tools)

**Healthy:**
- Daily volume tracks open-position count × event frequency
- Bounces/complaints stay near zero
- DMARC report clean

**Unhealthy patterns:**
- Volume drops to 0 → check `SENDGRID_API_KEY` secret rotation; `wrangler secret list` to verify presence
- Volume spikes 5x normal → check for a runaway alert loop (e.g. a trade getting flagged for entry every cron tick); audit `bridge_audit` for repeated identical entries on the same trade_id
- Bounce rate > 2% → list hygiene issue; pull bounced emails from SendGrid and mark `users.email_status = 'bounced'` to stop sending

---

## 6. Stripe health (subscriptions + recent webhooks)

**Endpoints:**
- `GET /timed/admin/stripe-health` → active subscriptions, MRR, recent webhook events
- Stripe dashboard webhook log (https://dashboard.stripe.com/webhooks)

**Look at:**
- Active subscriptions count matches expected (no silent churn)
- Recent webhook events (`customer.subscription.created`, `invoice.payment_succeeded`, `invoice.payment_failed`) processed within the last hour for active customers
- No webhook failures (Stripe will alert if endpoint returns non-2xx)

**Healthy:**
- Webhook success rate 100% over last 24h
- New paid signups match Stripe Atlas activity (within a few minutes)
- No `users.subscription_status = 'unknown'` rows (every paid user should resolve to `active`/`trialing`/`past_due`/`cancelled`)

**Unhealthy patterns:**
- Webhook returning non-2xx → check Stripe dashboard for the body; usually a worker error in the `/timed/stripe/webhook` handler (D1 timeout, bad payload schema, etc.)
- `subscription_status` stuck in `unknown` for a paid user → manual sync via `POST /timed/admin/stripe-sync-user?email=X` (forces re-read from Stripe and updates the local row)
- Payment failed for a customer with `email_status = bounced` → the dunning emails won't reach them; reach out via Discord DM if linked

---

## 7. Broker bridge connectivity

**Endpoint:** `GET /timed/admin/broker-bridge/status`

**Look at:**
- `live` (mock_mode=false) or `mock` (mock_mode=true) — should match expected env
- Per-user `status: "connected"` and `enabled: true/false` per intent
- `last_pulse_ms` per connected user — should be < 5min during RTH (Phase C reconciler)
- Any "Phase C — Reconciler Paused" notifications in Discord (would have already alerted)

**Healthy:**
- Bridge service responds (no 5xx)
- All expected users `connected`
- Reconciler last pulse within last 5-10 min during RTH

**Unhealthy patterns:**
- 404 on `/bridge/manifest` etc. → deployed bridge version is older than current source; redeploy via `cd worker-bridge && npx wrangler deploy` (PR #433 surfaces this hint in MC inline now)
- User stuck `disconnected` → bridge tried to fetch IBKR positions and failed > N times; check the per-user remediation note in MC and either re-link IBKR or clear the monitor

---

## 8. Mission Control red-tile cross-check

Load `https://timed-trading.com/mission-control.html` and scan the 10-tile Status Grid:

| Tile | Red means |
|---|---|
| Data Capture | Cron stalled; covered in step 1 above |
| Scoring | Scoring cron stalled; step 3 |
| Worst Stale Ticker | Candle freshness; step 2 |
| AI CIO | `ai_cio_enabled=false` OR 0 decisions today |
| Realized P&L 7d | Informational only; not "broken" |
| Unrealized P&L | If $0 with open trades → `timed:prices` KV bug |
| Open Positions | If huge (>50) check trade lifecycle for stuck rows |
| Weekly Retro | Retro cron stalled OR not yet generated this week |
| Broker Bridge | Step 7 |
| Trades Last 24h | If 0 across multiple days → engine paused; check Loop 2 + scoring |

**If everything above is green:** the system is healthy. Note the run in `tasks/lessons.md` if you want to baseline the steady-state metrics.

**If anything is red:** triage in the order of the steps above. Each step links to the specific skill / endpoint for the next layer of detail.

---

## What to ADD to MC if it isn't already there

If during this sweep you encounter a health signal that requires hitting a non-MC endpoint, **the surface needs to be added to MC**. Examples to watch for:
- Cron failure types not yet on the Status Grid
- Stripe webhook failure rate (currently behind `/timed/admin/stripe-health` only)
- Per-user broker bridge `last_pulse_ms` lag (currently in the bridge sub-card but not on the grid)
- Email bounce rate (currently SendGrid-only)

File any gaps in `tasks/todo.md` under "Mission Control gaps surfaced by holistic smoke test [date]" so the next pass picks them up.

---

## Source

- `worker/index.js` → `/timed/health`, `/timed/admin/freshness-summary`, `/timed/admin/email-health`, `/timed/admin/stripe-health`
- `react-app/mission-control.html` → all React components
- Companion skills: [mission-control-tour.md](mission-control-tour.md), [broker-bridge.md](broker-bridge.md), [backfill-candles.md](backfill-candles.md), [d1-debugging.md](d1-debugging.md), [discord-alerts.md](discord-alerts.md)
- Recent reliability lessons in `tasks/lessons.md`: BK freshness heal-before-page, investor compute retry, manifest stale-bridge hint, toxic-ticker safety
