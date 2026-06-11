# Skills Library

A library of **reusable, copy-paste-ready playbooks** for the most common
operations a Timed Trading agent performs. Read the relevant skill BEFORE
inventing a new method — most "how do I do X?" questions already have an
answer here, and reinventing them is the #1 source of regressions.

## When to consult skills

| Situation | Skill |
|---|---|
| **"Is everything healthy?" / weekly system check / post-deploy verification** | [mc-holistic-smoke-test.md](mc-holistic-smoke-test.md) |
| Backfill missing daily / weekly / monthly candles for a ticker | [backfill-candles.md](backfill-candles.md) |
| One ticker's Investor or Trader score looks stale or wrong | [rescore-ticker.md](rescore-ticker.md) |
| You changed worker/ code and need it on production | [deploy.md](deploy.md) |
| You changed `shared-right-rail.js` or any React/JSX in `react-app/` | [cache-bust-rail.md](cache-bust-rail.md) |
| User reports "investor score is wrong vs Finnhub / consensus" | [sanity-check-investor.md](sanity-check-investor.md) |
| You need to read Mission Control's Status Grid | [mission-control-tour.md](mission-control-tour.md) |
| You see HTTP 401 / 403 / 404 / 503 from a worker route | [debug-http-codes.md](debug-http-codes.md) |
| You need to query D1 directly | [d1-debugging.md](d1-debugging.md) |
| You need to inspect a KV value | [kv-inspection.md](kv-inspection.md) |
| User reports Discord alert didn't fire | [discord-alerts.md](discord-alerts.md) |
| Bridge / IBKR / Robinhood automation work | [broker-bridge.md](broker-bridge.md) |
| New page failing to load OR blank-screen JSX bug | [frontend-build.md](frontend-build.md) |
| Touching paywall, auth-gate, Stripe webhook, or any Pro-gated UI | [user-state-matrix.md](user-state-matrix.md) |
| **Adding a worker route, self-fetch, WS consumer, or LLM-rendered HTML** | [security-auth-patterns.md](security-auth-patterns.md) |
| **Any UI styling work / porting a page to the Verda design system** | [verda-ui-migration.md](verda-ui-migration.md) |
| **Cron / deploy / "which worker runs X?" after the 2026-06 decomposition** | [worker-topology.md](worker-topology.md) |
| **Move Discovery / missed moves / "why didn't we catch X?" / gameplan** | [discovery-loop.md](discovery-loop.md) |
| **Adding scripts/styles to a page, slow loads, page-switch speed, caching** | [frontend-performance.md](frontend-performance.md) |
| Adding / flipping / debugging a CIO lifecycle hook (entry skip, trim, SL, defend) | [ai-cio-lifecycle.md](ai-cio-lifecycle.md) |
| Cron tombstones / missed trims / CIO shadow vs live mismatch | [scoring-cron-cio-recovery.md](scoring-cron-cio-recovery.md) |
| Stale scores / quarantined tickers / Data Age Contract (`_freshness`) | [freshness-doctrine.md](freshness-doctrine.md) |
| Add/grade a published signal (options plays, desk calls, investor actions) | [signal-outcome-ledger.md](signal-outcome-ledger.md) |
| Operator hands you a new Fundstrat Direct (or equivalent) publication and says "update the playbook" | [update-strategy-playbook.md](update-strategy-playbook.md) |

## When to ADD a new skill

If you find yourself doing something that:

1. Took more than ~3 tool calls to figure out the first time, AND
2. Another agent in the future is likely to need to do, AND
3. Is not already covered above

…then write a new skill **in the same session**. The cost of forgetting is
high; a 5-minute writeup saves the next agent an hour of rediscovery.

Skill files should:

- Be < 200 lines (keep it skimmable)
- Start with **WHEN to use** (1-2 sentences)
- List **prerequisites** (env vars, secrets, who needs to be admin)
- Give **copy-paste commands** with placeholders in `${UPPER_CASE}`
- End with **how to verify** the operation succeeded
- Link to source files in `worker/` or `react-app/` for deep context

## Relationship to other docs

- **[../CONTEXT.md](../CONTEXT.md)** — single onboarding entry; load this on every new session.
- **[../tasks/lessons.md](../tasks/lessons.md)** — long-form lessons + post-mortems. Read when a related skill links into it.
- **[../tasks/todo.md](../tasks/todo.md)** — live work plan. Update at the start of any non-trivial task.
- **[../AGENTS.md](../AGENTS.md)** — onboarding flow for a brand-new agent.

Skills are the **HOW**. Lessons are the **WHY**. Context is the **WHAT** you have to remember at all times.
