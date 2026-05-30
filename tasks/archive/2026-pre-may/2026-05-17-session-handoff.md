# 2026-05-17 Session Handoff — UX Redesign, Login Fix, May Calibrations

**Purpose:** Single document a new agent can read to pick up everything that was
learned and changed in the May 14-17 work block. Cross-references the existing
canonical docs (`CONTEXT.md`, `tasks/lessons.md`) rather than duplicating
content already there.

---

## TL;DR — what to know before touching anything

1. **The UX has been split into dedicated journey pages.** `/index-react.html`
   is still the monolithic admin/legacy dashboard. The product entry point
   is now `/today.html`. The Active Trader / Investor / Portfolio / Insights
   / Learn pages each live at their own URL with their own React app, all
   pulling from shared modules.

2. **The login redirect is `/today.html`, not `/index-react.html`.** Three
   places enforce this: `react-app/_worker.js` (Pages Function), `react-app/
   index.html` (meta refresh), `react-app/auth-gate.js` (`handleLogin`).

3. **Cloudflare Access policies are page-allowlist regexes.** Every new HTML
   page added under `react-app/` MUST be added to either the User Pages or
   Admin Pages group in CF Access. The user-side `_worker.js` routing trusts
   the `CF_Authorization` cookie; CF Access actually issues that cookie based
   on whether the requested path matches its policy regex. Missing pages
   become "login loops" — the user lands on the SSO page, completes it, but
   the cookie never sets so they bounce right back. This is how `today.html`
   was unreachable until added to the regex.

4. **The model has been suppressing mega-cap entries for 60+ days.** The
   `megacap_tech` cohort overlay in `worker/pipeline/tt-core-entry.js` had a
   hard cap of 8% above the daily E48 — sensible for cyclicals, fatal for
   trending tech leaders. PR #194 raises it to 15% and expands the cohort
   list. See Section 4 below for the full diagnosis.

5. **The Right Rail requires `lightweight-charts` and `ticker-spider-chart.js`
   on the page.** Both are loaded on `index-react.html` natively but had to
   be explicitly added to every new journey page. See Section 2.

6. **`/timed/all` returns ticker data keyed by symbol, WITHOUT a `ticker`
   field inside the value object.** `Object.values(data).filter(t => t &&
   t.ticker)` silently drops every single scored entry. Always use
   `Object.entries(data).map(([k, v]) => ({ ticker: k, ...(v || {}) }))`.

---

## 1. The journey-page architecture

The product now has six dedicated pages, each a self-contained React app
that mounts inside the standard shell (top nav, mobile bottom nav, legal
footer, activity strip).

| Page | Path | Purpose |
|---|---|---|
| Today | `/today.html` | Daily Ingest — Market Pulse tiles, Daily Brief preview, Earnings, Bubble Map + Viewport (shared filters), FocusRail |
| Active Trader | `/active-trader.html` | Kanban lanes, narrative ATBrief, AccountStrip, lanes-only ATBubbleMap |
| Investor | `/investor.html` | Investor cards (via `InvestorPanel`), search + filter chips, AccountStrip, InvBubbleMap |
| Portfolio | `/portfolio.html` | Equity curves (both modes), TradesPerformance calendar, condensed Open-Positions tables (trader + investor side-by-side) |
| Insights | `/insights.html` | System Intelligence — CIOWatchlist, ModelStatus, UniverseChanges, EffectiveModelConfig, calibration apply flow |
| Learn | `/learn.html` | Step Zero educational walkthrough, CTAs to journey pages |
| Splash | `/splash.html` | Public landing, premium positioning ("founder's charter" pricing) |
| Index | `/index-react.html` | Legacy monolithic admin dashboard — still the source-of-truth reference for component logic |

**Critical:** the user's directive was **"port these components, do not
redesign them. We can add additional elements but not create two different
versions."** When adding behavior to a journey page, the rule is to lift
the existing code from `index-react.source.html` verbatim rather than
reimplement.

### Shared modules every journey page loads

```html
<!-- Each journey page MUST load these for the right rail to work -->
<script src="https://unpkg.com/lightweight-charts@4.1.1/dist/lightweight-charts.standalone.production.js"></script>
<script src="ticker-spider-chart.js?v=20260501a"></script>
<script src="shared-rail-helpers.js?v=..."></script>
<script src="shared-right-rail.compiled.js?v=..."></script>
<script src="shared-rail-bootstrap.js?v=..."></script>
<script src="tt-fetch-cache.js?v=..." defer></script>
<script src="tt-nav-extras.js?v=..." defer></script>
<script src="tt-activity-strip.js?v=..." defer></script>
<script src="tt-bottom-nav.js?v=..." defer></script>
```

| Module | Role |
|---|---|
| `shared-rail-bootstrap.js` | Wires `TickerDetailRightRailFactory`. Exposes `window.TimedRightRail.Overlay`. Detects desktop "workspace mode" by `window.innerWidth`. Fetches `/timed/latest` to backfill heavy fields (e.g. `tf_tech`). |
| `shared-rail-helpers.js` | All helpers extracted from `index-react.source.html` the rail depends on: `getActionDescription`, `detectPatterns`, `computeHorizonBucket`, `getTickerSector`, `GROUPS`, `groupsForTicker`, `isTickerTTSelected`, etc. |
| `shared-right-rail.js` (+ compiled) | The right-rail component itself. Edit, then run `node scripts/compile-right-rail.js`. |
| `shared-bubble-chart.js` | Shared bubble-chart component used on Today + Active Trader + Investor. |
| `tt-bottom-nav.js` | Mobile bottom nav, auto-inserts on viewport <=767px. |
| `tt-nav-extras.js` | Top-nav badges (AT / Investor actionable counts), Admin dropdown, right-side widgets (Discord, Alerts, Avatar), journey-strip injection on admin pages. |
| `tt-activity-strip.js` | Sticky horizontal activity feed; polls `/timed/activity`. |
| `tt-fetch-cache.js` | sessionStorage-backed stale-while-revalidate. Use `window.TTFetchCache.get(url, opts)`. |

### Build & deploy

```bash
node scripts/build-frontend.js     # compiles JSX to JS, copies to react-app-dist/
# Pages auto-deploys on `git push main`
```

**Rule (already in `tasks/lessons.md`):** after any `react-app/` source change,
ALWAYS run `node scripts/build-frontend.js` and commit BOTH `react-app/` and
`react-app-dist/`. Cloudflare Pages serves from `react-app-dist/`.

---

## 2. Auth, routing, and the login loop

The auth chain has more moving parts than is obvious:

```
User hits /
  ↓
react-app/_worker.js (Pages Function)
  ├─ Has CF_Authorization cookie? → Response.redirect("/today.html", 302)
  └─ No cookie? → ASSETS.fetch("/splash.html")  (public)

User hits /today.html
  ↓
CF Access policy regex evaluates path
  ├─ Path matches User Pages regex? → checks cookie, issues if SSO valid
  └─ Path doesn't match? → 403 / login loop (the "you fixed it by adding
                            today.html to the User Pages group" case)

User hits /timed/* (API)
  ↓
react-app/_worker.js proxies to timed-trading-ingest.workers.dev
  ↓
Worker verifies CF_Authorization JWT (or API key)
```

### Files that touch auth

| File | Role |
|---|---|
| `react-app/_worker.js` | Pages Function. Root routing + API proxy. Updated to send authed users to `/today.html` (was `/index-react.html`). |
| `react-app/index.html` | Meta-refresh fallback. Now `url=/today.html`. |
| `react-app/auth-gate.js` | Client-side auth modal. `handleLogin()` is now **two-mode**: fresh logins skip the iframe and redirect directly; switch-account flow keeps the iframe-clear-then-redirect dance with a 1.5s safety timeout. |

### Common pitfalls

- **Adding a new HTML page** → must update the CF Access User Pages or Admin
  Pages regex. The agent CANNOT do this; the user must update it in the
  Cloudflare Dashboard. The standard regex shape is
  `(index-react|simulation-dashboard|daily-brief|alerts|investor-dashboard|today|active-trader|investor|portfolio|insights|learn)\.html`.
- **`API_BASE` must be empty string** (`API_BASE = ""`) on journey pages so
  fetches are same-origin proxied. Setting it to the workers.dev URL causes
  CF Access to require re-auth on every API call — the "kicked back to login
  repeatedly" bug.
- **Cookies on `CF_Authorization=`**: the Pages worker only checks for the
  cookie's *presence*, not its validity. CF Access enforces validity at the
  HTTP layer. So a stale/expired cookie can still satisfy the Pages worker's
  redirect logic but fail the SSO check on the API call.
- **Fresh login + iframe logout** — Safari/mobile would hang on the iframe
  load forever. The fix is the two-mode `handleLogin` in `auth-gate.js`:
  if no current session, skip the iframe entirely.

---

## 3. The Worker engine — where the levers live

Five files contain ~95% of the calibration/control surface. Memorize their
roles:

| File | What's in it |
|---|---|
| `worker/pipeline/gates.js` | **Universal gates** — RVOL dead zone, SHORT min rank, ticker blacklist (Gate 3 = `deep_audit_ticker_blacklist`, Gate 4 = hardcoded May calibration blocklist for NFLX/APD). Every engine consults this first. |
| `worker/pipeline/tt-core-entry.js` | **TT-core entry pipeline** — the long body of code that decides whether a ticker qualifies for entry. Contains the regime gates, cohort overlays (index_etf / megacap_tech / industrial / speculative / sector_etf), trigger detection, and rank floor logic. |
| `worker/phase-c-setup-admission.js` | **Admission matrix** — keyed `setup:DIRECTION:Grade`, decides whether a setup is allowed in a given regime, with optional `min_rr` / `min_conviction` floors. |
| `worker/phase-c-exit-doctrine.js` | **Exit doctrine** — per-setup parameters for `ride_runner` / `tighten` / `force_exit`. Force-exit triggers: regime flip + age + pnl, fresh-failure (low MFE + losing + minimum age), regime-decay. Trend-Hold and ETF-Ride-Runner bypass everything. |
| `worker/index.js` | **The main worker** — all routes, cron handlers, trade lifecycle. The Hard Loss Cap (`_hlcCapDollar` / `_hlcCapPct` / `_hlcMinHoldMs`) lives around line 18896. |

### Configuration model

All tunables flow through one of:

1. **`model_config` D1 table** — long-lived config. Keys prefixed `deep_audit_*`.
   Read via `daCfg.deep_audit_<key>`. The default in code (`?? <default>`) is
   what fires if the key isn't set.
2. **`backtest_run_config` D1 table** — per-run snapshot for replays.
3. **KV** — fast-changing state (`phase-c:exit-doctrine`, `timed:prices`,
   `timed:tickers`, snapshot caches).

Read the current model_config:
```bash
# Admin-gated — must have CF_Authorization cookie
curl -s 'https://<host>/timed/admin/model-config'
```

Apply via calibration:
```
POST /timed/calibration/apply
# Body: { report_id, recommendations: [...] }
# Validates each recommendation against clampVal() ranges, writes
# to model_config, returns the list of keys applied.
```

`/timed/calibration/run` produces `diagnostic_only=true` reports by default.
The Apply flow now transparently re-runs as a promotion-candidate
(`analysis_only: false`) before writing. See PR #2f79380.

### Setup keys (memorize these)

```
LONG side:
  tt_gap_reversal_long      <- workhorse, PF 2.98 all-time, n=338
  tt_pullback               <- marginal, Exp -0.10
  tt_ath_breakout           <- bleeding, Exp -0.14, demoted in PR #194
  tt_range_reversal_long    <- decent, PF 2.26
  tt_n_test_support         <- marginal
  tt_momentum               <- small sample

SHORT side:
  tt_gap_reversal_short     <- highest PF (8.86), bear-regime only
  tt_atl_breakdown          <- small sample
  tt_n_test_resistance      <- leak (PF 0.48)
  tt_range_reversal_short   <- small sample
```

Grades: `Prime`, `Confirmed`, `Speculative` (Speculative is the lowest tier,
generally blocked).

Regimes: `STRONG_BULL`, `EARLY_BULL`, `LATE_BULL`, `COUNTER_TREND_BULL`,
`NEUTRAL`, `EARLY_BEAR`, `LATE_BEAR`, `STRONG_BEAR`, `COUNTER_TREND_BEAR`.

---

## 4. The mega-cap suppression — the biggest finding of this session

**Symptom:** the user noticed NVDA / TSLA / NBIS / MSFT were not getting
traded despite obvious moves. Investigation showed **zero trades on NVDA,
TSLA, MSFT, NBIS, GOOGL, META, AAPL, AMD, AVGO, PLTR, CRWD in 60 days.**

**Diagnostic recipe (use this for any "missing trades" question):**

```bash
# 1. Verify the names are in the universe
curl -s 'https://timed-trading-ingest.shashant.workers.dev/timed/tickers' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); \
    print('size:', len(d.get('tickers',[]))); \
    print('NVDA in:', 'NVDA' in d.get('tickers',[]))"

# 2. Check the scored snapshot for rank + stage
curl -s 'https://...workers.dev/timed/all' > /tmp/all.json
python3 -c "
import json; d=json.load(open('/tmp/all.json')).get('data', {})
for s in ['NVDA','TSLA','MSFT','NBIS']:
    t = d.get(s, {}); print(s, 'rank=', t.get('rank'), 'stage=', t.get('kanban_stage'))
"

# 3. If all are stuck in 'watch' or 'setup' with reasonable rank, the
#    leak is at the entry-qualification layer. Search the worker logs
#    for the ticker symbol and 'phase_i_' / 'tt_cohort_' / 'h3_' /
#    'doa_' prefixed reason codes.
```

**Root cause:** the `megacap_tech` cohort overlay in `tt-core-entry.js`
(line ~1996) had:
- `extensionMaxOverride = 8.0` → rejected any LONG entry where the price
  was running >8% above the daily E48.
- A cohort list of just `AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA` — newer
  primary tech (AVGO, AMD, PLTR, NBIS, CRWD, ORCL, MU, ASML) fell into
  the default "other" cohort with even tighter cyclical-tuned caps.

**Fix (PR #194):**
- Extension cap 8.0 → **15.0**
- Cohort list expanded to include `GOOG,AVGO,AMD,PLTR,NBIS,CRWD,ORCL,MU,ASML`

**Lesson (write to lessons.md):** cohort overlays are silently destructive
in trending tape. Every cohort cap should be reviewed quarterly against the
empirical distribution of `pct_above_e48` for the cohort's actual members.
A cap of 8% rejects ~70-80% of trending mega-cap entries in a bull market.

---

## 5. The May 2026 calibration block (PR #194) in detail

### What landed (full diffstat in `tasks/may-2026-performance-analysis.md`)

```
worker/pipeline/tt-core-entry.js    +20 -3   (megacap unlock — P0+)
worker/pipeline/gates.js            +18 -0   (NFLX/APD blocklist — P0)
worker/phase-c-setup-admission.js   +9 -1    (ATH demotion — P0)
worker/phase-c-exit-doctrine.js     +29 -8   (doctrine softening — P1)
worker/index.js                     +14 -3   (HLC tightening — P1)
tasks/may-2026-performance-analysis.md  +98 -0
```

### Why we did NOT touch SHORT setups

The 30-day zero-shorts finding is **not a bug**. `tt_gap_reversal_short:
SHORT:Prime` is gated to `allow_only_in: ["LATE_BEAR", "STRONG_BEAR",
"EARLY_BEAR", "COUNTER_TREND_BULL"]`. May was a broad-bull tape so the
gate correctly suppressed shorts. The setup's PF 8.86 statistic is the
result of only firing in friendly regimes — opening it up in bull tape
would destroy that statistic. **Trust the gate; validate on the next bear
regime.** If the user re-raises this, point them at the cohort_stats in
the admission matrix.

### Expected impact

Net target on the 90-day window: flip from net-flat to **+$2K–$4K/month**.
Verify at June month-close.

The smoke test (first observable sign the calibration is working): **mega-cap
entries appearing in `/timed/trades` within the first session after deploy**.

---

## 6. Performance analysis recipe

This is the script flow used to produce the May analysis. Re-runnable any
time:

```bash
# 1. Pull trades
curl -s 'https://timed-trading-ingest.shashant.workers.dev/timed/ledger/trades?limit=1000' \
  -o /tmp/trades.json

# 2. Run the analysis
python3 tasks/scripts/may-2026-perf.py
```

The script computes:
- Headline (n, WR%, P&L, PF, expectancy) by window (7d, current month, prior
  months, 30d, 90d, all-time)
- LONG vs SHORT balance per window
- Setup performance over 90 days (n ≥ 5)
- Exit-reason performance (n ≥ 3) — this is where leaks surface
- Toxic tickers (cumR < -2.0 with n ≥ 2)
- Consistent winners (n ≥ 3, WR ≥ 60%, P&L > 0)

**Important:** the `setup_name` field arrives as `TT Tt <name>` (the canonical
internal prefix). Use the `pretty_setup` helper to strip the prefix before
displaying. The Insights page already does this in production via
`prettySetupName()` in `react-app/insights.html`.

**Note:** the diagnostic calibration report at `/timed/calibration/report` is
authoritative for `entry_paths` (per-setup all-time stats), `vix_buckets` (currently
empty — known calibration-pipeline gap), `regime_filters` (currently shows
only "unknown" — same gap), `position_sizing` (Kelly vs current), and
`rank_optimization` (`best_cutoff` confirms the production gate).

---

## 7. Critical reference data

### Calibration baseline (all-time, 598 closed trades)

- Win Rate: 51.7%
- Profit Factor: 2.00
- Net P&L: +$39,155
- Expectancy: +$65/trade

### May 2026 (14 closed trades through May 17)

- Win Rate: 21.4% (**-30pp vs baseline**)
- Profit Factor: 0.06
- Net P&L: -$1,069
- Three painful months in 90-day window: March -$3,005, April +$3,259, May -$1,069

### Setup edge (all-time, from calibration report)

| Setup | n | WR% | PF | Exp | Status |
|---|---|---|---|---|---|
| `tt_gap_reversal_long` | 338 | 59.2 | **2.98** | +1.21 | workhorse |
| `tt_gap_reversal_short` | 11 | 63.6 | **8.86** | +1.83 | highest PF, bear-only |
| `tt_range_reversal_long` | 20 | 55.0 | 2.26 | +0.61 | solid |
| `tt_n_test_support` | 61 | 36.1 | 1.20 | +0.13 | marginal |
| `tt_pullback` | 59 | 47.5 | 0.86 | -0.10 | slight leak |
| `tt_ath_breakout` | 68 | 41.2 | 0.76 | -0.14 | **bleeding** (PR #194 demoted) |
| `tt_n_test_resistance` | 13 | 38.5 | 0.48 | -0.28 | leak |

### Toxic ticker pattern (last 30 days)

Defined as: `cumR < -2.5% across n ≥ 2 trades`. NFLX (4 trades, -$296) and
APD (2 trades, -$252) were the May 2026 entries to this list (blocklisted
in PR #194).

Older blocklist (from cross-run analysis): AMZN, META, RKLB, RDDT — see
`CONTEXT.md > Cross-Run Analysis`.

---

## 8. Open questions / known gaps for the next agent

1. **Calibration pipeline VIX/regime enrichment is broken.** The diagnostic
   report has empty `vix_buckets` (all `n=None`) and only `unknown` in
   `regime_filters`. The trade context carries this data but the aggregator
   isn't picking it up. Until fixed, the system cannot produce
   regime-conditional recommendations like "block ATH breakouts when VIX > 22"
   — that would otherwise be the next obvious tightening.

2. **Friday entries went 0-for-4 in May.** Sample too small to act on; flag
   for next monthly review. If WR stays <20% with n ≥ 10, add a Friday-PM
   entry block.

3. **`/timed/all` payload is 17MB** for 242 tickers — slow to load. The
   `tt-fetch-cache.js` module mitigates this with sessionStorage caching but
   the underlying payload could be split into a slim "scoring snapshot" and
   a heavy "details on demand" endpoint pair.

4. **D1 payload truncation is still a risk for new heavy fields.** PR #184
   raised `D1_MAX` to 200KB with a 3-tier cascade, but any new heavy field
   added to ticker scoring (e.g. a new technical indicator object) should
   verify it lands in `D1_MINIMAL_KEYS` if the UI depends on it.

5. **The "deep audit" key namespace is sprawling.** ~50+ `deep_audit_*` keys
   in `worker/replay-runtime-setup.js`. Worth a once-over to consolidate the
   ones that overlap or are obsolete.

---

## 9. Cross-references

- **Full canonical context:** `CONTEXT.md` (top-level)
- **Lessons archive:** `tasks/lessons.md` (180+ items, dated session blocks)
- **May 2026 performance writeup:** `tasks/may-2026-performance-analysis.md`
- **Re-runnable analysis script:** `tasks/scripts/may-2026-perf.py`
- **UX-redesign component porting reference:** `react-app/index-react.source.html`
- **Design tokens:** `react-app/tt-tokens.css` (mirrored in `DESIGN.md`)
- **Calibration apply flow (server):** `worker/index.js` around line 62525
- **Calibration apply flow (UI):** `react-app/insights.html` `handleApply`
- **PR series (this session):**
  - #189 polish pass 6 (mobile journey-strip + footer)
  - #190 polish pass 7 (account-strip)
  - #191 polish pass 8 (footer inline + login redirect attempt 1)
  - #192 login redirect fix (`_worker.js` + `auth-gate.js` two-mode)
  - #193 May performance analysis (this session's data writeup)
  - #194 May calibrations (mega-cap unlock + P0/P1 fixes)
