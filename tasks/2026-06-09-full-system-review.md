# Timed Trading — Full System Review (2026-06-09)

Comprehensive assessment covering: vulnerabilities, uptime/reliability,
self-learning + AI officer utilization, optimization, strategy
enhancement, architecture bolstering, and product differentiators.
Produced from a full codebase audit (worker, worker-bridge, react-app,
scripts, skills, lessons history). Every finding cites files; critical
claims were verified directly against source.

---

## 0. Executive summary — root-cause diagnosis

The three stated pain points (uptime, self-learning reliability, AI
officer utilization) all trace to the **same three structural causes**:

1. **One 91,754-line worker doing everything per cron tick.**
   `worker/index.js` multiplexes 5 real Cloudflare cron slots into ~20
   virtual jobs. One CPU overrun, one missing secret, one virtual-cron
   gate typo kills *everything* in that tick. The CPU limit has already
   been raised to 300,000 ms (`worker/wrangler.toml` L168–179) — that's
   treating the symptom. The lessons file documents this class repeatedly
   (ghost cron P0.7.130, 15-day investor compute outage, calibration
   cron removed for CPU overruns).
2. **Silent-failure surfaces everywhere.** `ctx.waitUntil` jobs killed
   by the isolate with no tombstone; HTTP self-fetch crons that swallow
   401/503 as success; `try { D1 } catch { /* non-critical */ }` hiding
   schema mismatches; learning loops that no-op when their input is
   missing. The tombstone/sanity-sweep/COO self-heal layer is good but
   it only catches failures that *announce themselves*.
3. **Learning loops that don't close.** Almost every learning output
   exists, but several never feed back into live behavior: the CIO never
   sees its own accuracy in production (`cioDecisions: []` at
   `worker/index.js:89812`), ticker profiles require a manual script run,
   calibration recommendations sit in D1 unless COO tier-1 or an operator
   applies them, and toxic-ticker bans are recommendation-only.

The good news: the foundation is genuinely deep — tombstones, sanity
sweep, Loop 1/2/3, COO self-heal, provider fallback, replay-faithful
backtesting, an audited broker bridge, and a product surface that is
unusually complete. The work is **decomposition + closing loops +
locking the doors**, not rebuilding.

---

## 1. Vulnerabilities (security) — ranked

### CRITICAL

**V1. Calibration routes have NO auth — live model_config can be mutated
by anyone who reaches the worker.**
Verified directly: `POST /timed/calibration/upload-moves` (index.js
~70512), `POST /timed/calibration/run` (~70606), `POST
/timed/calibration/apply` (~73793), `POST /timed/calibration/rollback`
(~74106) — none call `requireKeyOrAdmin`/`requireKeyOr401`. `apply`
writes SL/TP tiers, rank thresholds, and other live trading parameters
into `model_config`. Any authenticated CF Access user (or anyone hitting
the workers.dev URL directly if Access doesn't front it) can change live
trading behavior. **Fix first, same day.** Also audit `GET
/timed/calibration/report` and `GET /timed/calibration/deep-audit`
(full closed-trade dumps).

**V2. CF Access JWT signature verification can silently degrade to
"trust the header".**
`worker/api.js:289-291` returns the decoded payload when JWKS keys are
unavailable ("skipping signature check"), and L317-318 trusts the edge
when cert-based verification isn't possible (Cloudflare often serves PEM
certs, not JWK n/e). Anyone who can reach the worker directly with a
forged `CF-Access-JWT-Assertion` header can impersonate `ADMIN_EMAIL`.
Fix: never return an unverified payload; convert PEM → CryptoKey
(WebCrypto `importKey("spki", ...)`) or use Access's `/certs` JWK set
properly; fail closed.

**V3. Proprietary data + licensed market data served unauthenticated.**
`GET /timed/all` (~46644), `/timed/prices` (~48730),
`/timed/investor/scores` (~80472), `/timed/latest`, `/timed/options/all`
require no auth — `window._ttIsAdmin`/`_ttIsPro` only hide the UI. This
is (a) the entire IP (scores, SL/TP, ranks) scrapeable at 20,000
req/hr/IP, and (b) a Twelve Data licensing violation at the API layer
(redistribution of live prices to unauthenticated callers). Fix:
server-side tier gating — strip price/score fields for non-Pro callers,
mirroring the pattern already used in `GET /timed/admin/fundamentals`.

**V4. `TIMED_API_KEY` accepted via `?key=` query param on destructive
routes.** `worker/api.js:126-142`; used on `/timed/purge`,
`/timed/admin/reset`, ML train, brief generation, and embedded into
cron self-fetch URLs (logged everywhere). One leaked log line = full
control. Fix: header-only (`Authorization: Bearer` / `X-API-Key`),
then rotate the key.

**V5. WebSocket price hub is unauthenticated.** `/timed/ws`
(index.js ~42255 → `worker/price-hub.js:59-71`) accepts any upgrade and
fans out live prices/scores. Same licensing + IP exposure as V3.

### HIGH

- **V6.** `requireKeyOrAdmin` silently drops the key requirement when
  `TIMED_API_KEY` is unset in an env (`api.js:611-616`) — combined with
  V2 this makes admin = forgeable JWT.
- **V7.** Pages `ADMIN_ONLY_PAGES` (`react-app/_worker.js:34-44`) is
  missing `calibration.html`, `simulation-dashboard.html`,
  `research-desk.html`, `investor-dashboard.html`; compiled JS assets
  aren't gated at all. `calibration.html` trusts localStorage for its
  admin check (L427-434) — spoofable, and pairs badly with V1.
- **V8.** Bridge HMAC split-brain: `worker/options-auto-mirror.js`
  (~385-410) signs with the wrong env var name, wrong header name, and
  hex-vs-base64 mismatch vs `worker-bridge/bridge-index.js:97-102`.
  Broken today (options auto-mirror can't authenticate) and evidence
  the secret contract isn't pinned down. Manifest guard fails OPEN on
  D1 read errors (`bridge-guards.js:190-196`) — acceptable in shadow,
  not once BYOB ships.
- **V9.** Ops/status endpoints public: stream status, ingest stats,
  `/timed/cors-debug`, `/timed/ws/stats`, `/timed/alert-debug`,
  `/timed/ledger/trades` (full trade history at 3000/hr).

### MEDIUM

- Rate limiter fails open on cache errors (`api.js:192-201`); fine for
  cheap GETs, wrong for LLM/D1-heavy endpoints.
- LLM HTML rendered via `dangerouslySetInnerHTML` without sanitization
  (`daily-brief.html:259-260`, `ChatInterface.jsx:100-105`,
  `simulation-dashboard.html`, `research-desk.html`). Prompt-injected
  content from FSD scrapes/news could become stored XSS for admins.
  Add DOMPurify.
- No-Origin requests get `Access-Control-Allow-Origin: *`
  (`api.js:72-76`).

### Done well — do not touch

Stripe webhook verification (HMAC + 5-min replay window), bridge token
encryption (AES-256-GCM with rotation), bridge preflight guards (kill
switch, caps, naked-short reject), `requireDestructiveConfirm` pattern,
parameterized D1 everywhere that matters, chart-svg escaping, CORS
origin allowlist + startup guard rejecting `CORS_ALLOW_ORIGIN=*`,
admin auto-demotion, 267 `requireKeyOrAdmin` call sites.

---

## 2. Uptime & reliability — why it keeps breaking

### Cron reality

| CF slot | What actually runs |
|---|---|
| `*/1` | price feed, Alpaca bars, backtest orchestrator, PriceStream keep-alive |
| `*/5` | **entire scoring + trade management + CIO + alerts pipeline** (~200 tickers), sanity sweep, options prewarm, bridge drain |
| `0 * * * *` | investor compute/rebalance, Loop 2 pulse, freshness monitor + heal, briefs, COO lanes |
| `30 * * * *` | no-op (calibration removed after CPU overruns) |
| `0 22 * * *` | discovery batch + COO daily + CRO/CTO full cycle |

### Ranked structural weaknesses

1. **Monolith + multiplexed crons = correlated failure domain**
   (CRITICAL). One bundle, one isolate, one CPU budget for everything.
   `requireRuntimeConfig()` failure aborts ALL crons silently
   (index.js:86098-86102). Virtual-cron gate typos have caused
   multi-week subsystem outages (investor hourly dead since April,
   fixed later; ghost half-hour cron doubling D1 reads).
2. **`*/5` scoring tick is a CPU/subrequest bomb** (CRITICAL).
   Per-ticker isolation exists (`Promise.allSettled`, 15-parallel) but
   the outer tick still dies wholesale on global limits — and when it
   dies, trims/SLs don't fire (the worst possible failure for a trading
   system; runbook exists at `skills/scoring-cron-cio-recovery.md`
   precisely because it has happened).
3. **HTTP self-fetch crons** (CRITICAL). Crons fetch their own routes
   (investor hourly, options prewarm, bridge drain). Caused the 15-day
   silent investor outage (CF 1042 loopback). Retries were added; the
   architecture remains wrong. Same class as the open CF-1042 bridge
   item in todo.md.
4. **Dual-env deploy drift** (CRITICAL). default + production must both
   be deployed and both hold secrets; preprod has no crons so cron
   changes can't be validated in isolation. The bridge worker has NO
   CI deploy at all.
5. **`ctx.waitUntil` without completion guarantees** (HIGH). Dozens of
   background jobs can be killed mid-flight with no tombstone — the
   lessons file says it plainly: "ctx.waitUntil background tasks
   silently die... no error, no done status" [2026-02-23].
6. **TwelveData: no 429/credit-budget backoff** (HIGH). Per-symbol
   TD→Alpaca fallback exists (`worker/data-provider.js`) but a TD-wide
   429 storm or credit exhaustion degrades everything with generic
   errors. No global daily credit budget guard.
7. **No tests in CI** (HIGH). ~15 vitest files exist; `.github/workflows/
   deploy-worker.yml` never runs them. `npm test` only gates local
   deploys.
8. **PriceStream DO eviction** (HIGH) — keep-alive exists but the
   REST fallback re-fetches ~200 tickers, burning subrequests exactly
   when the system is already degraded.

### What already exists (and is good)

Cron tombstones + Discord system lane (`alerts.js:245-303`), heartbeat
KV (`cron:last_5min_tick`), 14-check sanity sweep
(`worker/sanity-sweep.js`), Loop 2 breaker, COO self-heal, candle
freshness heal-before-page, provider fallback stats, bridge reconciler
heartbeat, MC status grid + smoke-test skill. The monitoring layer is
B+; the failure-domain architecture underneath it is D.

### Reliability roadmap (ordered)

**R1. Split the worker into failure domains.** Target topology:
- `tt-engine` — */5 scoring + trade management + CIO (the only thing
  that MUST be near-realtime)
- `tt-feed` — */1 price feed + PriceStream DO + freshness
- `tt-research` — daily/hourly CRO/CTO/COO/discovery/briefs/calibration
- `tt-api` — HTTP routes only (current index.js minus cron)
- `worker-bridge` — unchanged

Use Service Bindings between them (also resolves CF 1042 permanently).
Each gets its own CPU budget, tombstones, and deploy cadence. A
research-lane CPU blowup can no longer stop stop-losses from firing.
This is invasive but mechanical: the module boundaries already exist
(`worker/cro/`, `worker/coo/`, `worker/cio/`, `worker/pipeline/`,
`data-provider.js`); the work is extracting the `scheduled()` arms and
sharing libs via plain imports.

**R2. Kill HTTP self-fetch.** Replace every `fetch(WORKER_URL + ...)`
cron pattern with direct function calls (same isolate) or Service
Binding calls (cross-worker). Removes the entire "self-call swallowed
an auth error" failure class.

**R3. Queue-backed heavy jobs.** Discovery batch, regime bootstrap,
candle heal, COO daily → Cloudflare Queues with per-message retries +
dead-letter + explicit ack. Replaces unbounded `waitUntil` chains.
(Alternative if avoiding Queues: a D1 `job_queue` table drained by a
dedicated cron with lease + heartbeat columns — less infra, same
guarantee.)

**R4. CI gate.** Run vitest on every PR; deploy worker AND bridge in
the same workflow to BOTH envs; post-deploy smoke (`/timed/health` +
cron-status on both URLs); fail on tombstone count / scoring staleness.

**R5. Watchdog inversion.** Today monitoring mostly lives INSIDE the
thing being monitored. Add one tiny external check — a separate
5-line Worker on its own schedule (or even a GitHub Actions cron /
UptimeRobot) that hits `/timed/health`, checks `cron:last_5min_tick`
age, and pages. When the main worker is fully wedged, today nothing
pages until the operator opens Mission Control.

**R6. Unified health contract.** Extend `/timed/health` to expose what
the smoke-test skill already documents (per-op lastRun, failures24h,
tick age, bridge heartbeat, TD credit/fallback stats) so MC, the
external watchdog, and CI all read one endpoint.

---

## 3. Self-learning + AI officers (CIO / CRO / CTO / COO)

### What exists (more than expected)

CRO and CTO are real, not aspirational:
- **CIO** (`worker/cio/`) — LLM entry + lifecycle reviewer, 15+ memory
  layers, decision persistence, monthly $ cap, shadow/live flags.
- **CRO** (`worker/cro/`) — daily 22:00 UTC LLM research synthesis
  (FSD + macro + rotation + discovery) + hourly intraday FSD lane;
  feeds CIO memory L15c and Research Desk.
- **CTO** (`worker/cto/cto-service.js`) — deterministic probabilistic
  price levels (Fib/ATR/pivots/Markov + empirical hit rates); daily
  only; feeds CIO L15d.
- **COO** (`worker/coo/`) — ops orchestrator: calibration run→apply
  (tier-1 auto), self-heal, discovery, screener promote.

### Why they feel unreliable / under-utilized — concrete defects

1. **The CIO never sees its own track record in production.**
   `env._cioMemoryCache = { ..., cioDecisions: [] }` at
   `worker/index.js:89812` — Layer 5 (self-accuracy) is only populated
   in replay. The prompt documents a layer that is empty live.
2. **`entry_skip_review` (the Loop-2 override — the highest-stakes CIO
   call) runs with `memory: {}`** (`worker/index.js:17403-17410`).
3. **Lifecycle decisions use synthetic trade IDs** (`${sym}-${now}-
   stall-hold`) so outcome backfill misses them; accuracy stats are
   structurally incomplete; backfill endpoint is manual.
4. **CIO authority is static.** Shadow mode + go-live gates are
   operator checkboxes (`ai_cio_d_manual_review_done`,
   index.js:57074+). Accuracy never adjusts authority in either
   direction.
5. **CTO is stale intraday** — computed only in the daily CRO full
   cycle, with 1h KV TTL; the hourly CRO lane deliberately skips it
   for CPU (index.js:87812-87814 — a direct casualty of the monolith).
6. **CRO is context-only.** Its verdicts inform prompts but never gate
   or size anything; FSD tactical auto-apply defaults ON without
   operator review when confidence gates pass (`cro-apply.js:183-196`)
   — the one place it DOES act is the one place it acts unsupervised.
7. **Ticker learning is half-manual.** `build-ticker-learning.js` /
   `build-ticker-profiles.js` are operator rituals;
   `d1UpdateLearningOnClose` no-ops for any ticker without an existing
   `learning_json` (index.js:34161). New universe additions never get
   profiled unless someone remembers.
8. **Calibration is apply-gated.** Recommendations accumulate in D1;
   only COO tier-1 auto-applies; tier-2 (bans, setup disables) waits
   for a human indefinitely. Toxic-ticker bans are recommendation-only.

### The closed-loop blueprint (highest-leverage fixes, ordered)

**L1. Fix CIO memory integrity (small, do immediately):**
load last-N `ai_cio_decisions` per ticker/type into the scoring
preload (fix line 89812); call `ensureCioMemoryCache` before
`entry_skip_review`; stamp real `trade_id` + `decision_type` on all
lifecycle rows; make outcome backfill a nightly cron not a manual POST.

**L2. Accuracy-scaled authority.** One nightly job computes rolling
CIO precision per decision-type (approve-WR vs reject-counterfactual,
trim-saved-PnL, etc.) and writes a bounded `cio_authority` block to
model_config: e.g. REJECT enforcement only while rolling reject-
precision ≥ X over N decisions; auto-revert to shadow on degradation;
Discord note on every authority change. This converts the manual
go-live checkboxes into a governed feedback loop — the single biggest
step toward "self-learning you can trust."

**L3. Officer cadence + SLA.**
- CTO: refresh for the open book + top candidates hourly (cheap — it's
  deterministic math; the blocker is the shared CPU budget, which R1
  removes).
- CRO: morning pre-RTH synthesis (not just 22:00 UTC) so the day's
  stance exists before the first entry; freshness stamped into
  `/timed/health`; sanity-sweep check on CRO/CTO age.
- Every officer output carries `computed_at` and consumers (CIO
  prompts, UI) display/discount stale inputs.

**L4. One promotion pipeline for ALL learning.** Today calibration,
ticker bans, path-disable, Loop-1 scorecards, FSD tactical overrides,
and profile nudges each have bespoke apply paths with different safety
levels. Unify on the pattern that already exists for calibration
(propose → bounded blend → apply → measure → rollback):
`learning_proposals` table where every loop writes
`{source, key, current, proposed, evidence, tier}`; COO applies tier-1
nightly with bounds; tier-2 auto-applies only with HIGH confidence +
no-open-winner guard + Discord notice + 7-day auto-rollback if the
measured delta is negative. This is the "automation bus" that makes
the system genuinely self-improving instead of self-recommending.

**L5. Automate profile builds.** Move `build-ticker-profiles.js` logic
into the research worker (incremental: only tickers with new closed
trades or new universe additions) so `d1UpdateLearningOnClose` always
has a substrate. New promotion-queue approvals trigger profile build
automatically.

**L6. LLM-output hygiene.** All officer JSON already falls back safely
(APPROVE/PROCEED) — good. Add: one global OpenAI budget across
CIO+CRO+brief (today only the CIO lifecycle lane has a cap), and log a
tombstone when fallback-rate per lane exceeds a threshold (a quiet
OpenAI outage currently looks identical to "CIO approves everything").

---

## 4. Optimization opportunities (cost + performance)

1. **D1 read pressure in the */5 tick** — the largest cost and the
   CPU driver. The scoring tick re-reads candles/config per ticker per
   tick. Options: per-tick memoized config snapshot (partially done via
   `_deepAuditConfig`, but lazy-load is path-dependent —
   index.js:16903-16949), move candle reads to bulk `db.batch()` keyed
   by changed-tickers-only (the price feed already knows which tickers
   moved), and skip full rescoring for tickers with no new bar.
2. **KV write fan-out** — 200+ `kvPutJSON` per tick brushes the
   1 write/sec/key limit; batching exists (`mergeFreshnessIntoLatest`,
   50-chunks). Consider one `timed:all` blob write + per-ticker writes
   only for tickers whose payload hash changed.
3. **TwelveData credit budget** — add a daily credit counter in KV with
   a soft ceiling that flips the feed to Alpaca-primary for the rest of
   the day instead of failing ad hoc.
4. **`/timed/all` payload** — full-universe snapshot on every page
   poll; add ETag/If-None-Match (most polls return unchanged data) and
   a field-mask param so the bubble map doesn't pull SL/TP internals.
5. **Frontend Babel-standalone** — every journey page JSX-compiles in
   the browser (1–3 s cold load; the blank-page lesson exists because
   of it). A build-step precompile (the right-rail already does this
   via `compile-right-rail.js`) across all pages removes a whole class
   of UX + reliability issues.
6. **LLM cost** — CRO daily + briefs run on gpt-4o-mini with 60 s wall
   timeouts; fine. The win is consolidating budget + fallback-rate
   observability (see L6), not model changes.

---

## 5. Strategy enhancement

The engine is institutionally deep (10+ gate layers, data-derived
admission matrix, Phase C loops, replay-faithful backtests). The gaps
are at the PORTFOLIO level and in unwired signal assets:

1. **Capital-aware book risk** (sketched in index.js, unimplemented):
   replace position-count caps (35/50) with Σ(open risk) and
   Σ(notional) vs account equity; reject entries past 80% of risk
   budget. Count-based caps allow 35 highly-correlated full-size longs.
2. **Returns-based correlation guard:** rolling 20-day pairwise
   correlation; block/downsize entries whose avg correlation to the
   open book exceeds ~0.7. The current sector-count proxy missed the
   October cluster-loss month.
3. **Equity-curve circuit breaker:** Loop 2 is trade-outcome based
   (last-10 WR) — add a drawdown breaker on the model book's equity
   curve (e.g. -X% from 20-day high → halve all new sizing) which
   catches slow bleeds Loop 2's WR window misses, and is immune to the
   duration bias that already required a Loop-2 patch.
4. **Regime-shock de-risk:** on VIX spike + breadth collapse,
   auto-trim the weakest quartile of the open book. Today nothing
   coordinates exits portfolio-wide; every position defends itself.
5. **Wire `scoreRootConfluence` into entries.** The 8-layer confluence
   + SuperTrend ignition is currently display/options-facing only.
   Use RIDE/READY as a rank boost (or Prime-grade gate) and FADE as an
   automatic size haircut — backtest first via the existing replay
   lane.
6. **Markov sizing default-on** after a walk-forward validation pass
   (`gates.markov_position_sizing_enabled` is built and opt-in).
7. **Hedging channel:** infra exists (Tradovate module, futures-proxy
   registry, options engine). A small systematic hedge — index puts or
   /ES short when Loop 2 trips or regime flips to BEAR — converts the
   breaker from "stop trading" to "keep trading, hedged," which also
   fixes the "system feels down for days" complaint about Loop 2.
8. **Automated out-of-sample discipline:** promotion of any config/
   matrix requires passing a held-out window (e.g. train Jul–Mar,
   validate Apr; OOS PF ≥ 1.0) — currently process-based via monthly
   verdicts, not enforced in code. Add bootstrap confidence intervals
   to run metrics so promotion decisions stop riding on point
   estimates from 20-trade samples.
9. **Short book in bear regimes** — engine supports it; gap-reversal
   SHORT has PF 8.86 in its design regime; mirror defers shorts. Keep
   the model book learning shorts even while mirroring stays long-only.

---

## 6. Architecture bolstering (target state)

```
                    ┌─────────────┐
   TwelveData ──────│  tt-feed     │── KV timed:prices / timed:all
   Alpaca ──────────│  (*/1)       │── PriceStream DO + freshness
                    └──────┬──────┘
                           │ Service Binding
                    ┌──────▼──────┐        ┌──────────────┐
   OpenAI ──────────│  tt-engine   │───SB──▶│ worker-bridge │── IBKR/RH
                    │  (*/5)       │        │  (*/5 RTH)    │
                    │ scoring+CIO  │        └──────────────┘
                    └──────┬──────┘
                           │ Queues / job table
                    ┌──────▼──────┐
   FSD/news ────────│ tt-research  │── CRO/CTO/COO/calibration/briefs
                    │ (hourly/daily│── learning_proposals → apply bus
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
   Pages/users ─────│   tt-api     │── HTTP only; auth hardened
                    └─────────────┘
   external watchdog ── /timed/health (all workers) ── pages operator
```

Principles:
- **Failure domains follow money-criticality.** Stop-losses (tt-engine)
  must never share a CPU budget with research synthesis.
- **Service Bindings everywhere two workers talk** (kills CF 1042 and
  the self-fetch class).
- **Every background job is either awaited, queued with retries, or
  tombstoned** — no bare `waitUntil` for anything that matters.
- **One health contract; one external watchdog** that doesn't live
  inside the patient.
- **CI runs tests + deploys all workers to both envs atomically.**

Migration is mechanical, not risky, if done in this order:
(1) extract tt-feed (lowest risk, clearest boundary), (2) extract
tt-research (everything daily/hourly that isn't trade-path),
(3) tt-engine last (highest care; the pipeline modules in
`worker/pipeline/` are already cleanly importable), with `tt-api`
being whatever remains of index.js. Each step is a separate PR with
the smoke-test skill as the gate.

---

## 7. Product differentiators

### Already differentiated (lean into these)

1. **Full-lifecycle management with a public ledger** — alert services
   sell entries; Timed Trading manages entry→trim→exit with proof.html
   showing losses. Rare and credible.
2. **AI officer suite with an audit trail** — CIO verdicts persisted,
   reviewable, and (soon) accuracy-governed. No retail competitor has
   a structured, auditable AI veto on every trade.
3. **Options translation layer** — every thesis becomes a defined-risk
   structure (ladders, LEAPs, PMCC guidance) automatically.
4. **Trade autopsy + self-learning** — per-trade forensic replay
   feeding profiles and calibration. This is the moat once the loops
   close (Section 3); "the system that shows its homework and gets
   measurably better every month" is the marketing claim competitors
   can't copy quickly.
5. **BYOB broker mirroring** — designed, bridge multi-user-ready;
   shipping this to Pro users is the single largest commercial
   differentiator on the roadmap. Mirror-sync manifest/reconciler
   discipline is ahead of copy-trade products.

### Gaps to differentiation

- **Reliability IS the product.** For an automation product, uptime
  is the differentiator; Sections 2–3 are therefore product work, not
  infra work. A public status page (fed by the unified health
  endpoint) would turn the current weakness into a trust signal.
- **"Officer desk" as UX**: CIO/CRO/CTO/COO exist but are scattered
  across Research Desk / MC / right rail. A single "what the desk
  thinks right now" surface (stances, freshness, recent decisions +
  outcomes) makes the AI staff tangible to subscribers — directly
  answers the "utilization" complaint.
- **Per-user guidance, not broadcast**: alerts are broadcast; the
  ever-changing-market "guide the user" goal wants per-user filters
  (setup tier, conviction floor, vehicle) and a daily "what this
  means for the account" digest — most of which exists in the mirror
  daily-digest design already.
- **Pricing surface**: single $60/mo tier; no annual/founding tier
  (FAQ mentions founding-member language but no Stripe price exists).
  Cheap win.
- **Walk-forward methodology page**: publishing the OOS discipline
  (Section 5.8) converts backtest skepticism into trust.

---

## 8. Prioritized program (technical sequencing, no calendar estimates)

**P0 — same-session security (small diffs, huge risk reduction)**
1. Auth-guard all `/timed/calibration/*` routes (V1).
2. Fail-closed JWT verification (V2).
3. Header-only API key + rotate (V4).
4. Server-side tier gating on `/timed/all`, `/timed/prices`,
   `/timed/investor/scores`, `/timed/latest`, `/timed/ws` (V3, V5).
5. Complete `ADMIN_ONLY_PAGES`; fix bridge HMAC contract (V7, V8).

**P1 — stop the silent failures**
6. External watchdog + unified `/timed/health` (R5, R6).
7. CI: tests + dual-env + bridge deploy + post-deploy smoke (R4).
8. Replace self-fetch crons with direct calls / Service Bindings (R2).
9. CIO memory integrity fixes — L1 (preload decisions, real trade IDs,
   nightly backfill, entry_skip memory).

**P2 — decompose the monolith**
10. Extract tt-feed → tt-research → tt-engine (R1), queue-backed heavy
    jobs (R3). After this, CTO hourly refresh and morning CRO become
    trivial (L3).

**P3 — close the learning loops**
11. learning_proposals apply bus + tier-2 guarded auto-apply (L4).
12. Accuracy-scaled CIO authority (L2).
13. Automated profile builds (L5); global LLM budget + fallback-rate
    tombstones (L6).

**P4 — strategy + product**
14. Capital-aware book risk + correlation guard + equity-curve breaker
    (S1–S3), confluence wiring behind a replay-validated gate (S5).
15. Officer-desk UX surface; public status page; founding/annual
    pricing; BYOB Phase 1 per existing plan.

Each numbered item is a separately shippable PR (or short PR series)
with the existing smoke-test skill as the verification gate.

---

## Appendix — audit method

Four parallel deep-exploration passes (reliability/cron, AI+learning,
security, strategy+product) over worker/, worker-bridge/, react-app/,
scripts/, skills/, tasks/lessons.md. Critical security findings (V1,
V2) verified line-by-line against source before inclusion. File/line
references are as of main @ 2026-06-09.
