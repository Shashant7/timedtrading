# Session Handoff — 2026-05-29

Long session. Captures everything shipped, current operational state, and the work waiting for the next session.

---

## 1. What shipped (in order)

Each item is a merged PR (or PR open + ready to merge if still in flight).

### Performance + reliability fixes

| PR | Title | Status |
| --- | --- | --- |
| #348 | Open positions dedup + theme chips + investor cron visibility | merged |
| #349 | ES-style prose for SPY/QQQ/IWM predictions | merged |
| #350 | Investor tab Lane Guidance card | merged |
| #351 | **Investor cron self-fetch fix** (CF blocks `.workers.dev` self-fetch) — unblocked 15-day-dead investor lane | merged |
| #352 | Heatmap visual lift + earnings row cleanup | merged |
| #357 | Open positions count reconcile across Today / Brief / Investor Kanban / Portfolio | merged |
| #360 | Investor tab loads on mobile + real ticker logos + EXT in rail header | merged |
| #361 | Rich Investor tab: stage reason, score breakdown, buy-zone signals, position, thesis | merged |
| #362 | Restore InvestorTabPanel definition in source (was only in dist) | merged |
| #363 | Unified Investor tab desktop+mobile + price-flicker fix outside RTH | merged |
| #364 | Bias chip flips fix + price lock outside RTH + catalyst banner on Investor | merged |
| #365 | Dual bias chip (Trader + Investor) on right rail header + Learn doc | merged |
| #366 | Brief range live-recompute when out-of-band + 365d fast-onboard backfill | merged |

### Discovery — opportunity surface expansion

| PR | Title | Status |
| --- | --- | --- |
| #353 | Promotion-queue unstick: lower threshold, material-thesis gate, status=any handling | merged |
| #354 | StockTwits social signal (Phase 1) + mcap-aware extreme-move deduction | merged |
| #355 | Reddit mention tracker (Apewisdom Phase 2) + Reddit subscore + early-spike capture | merged |
| #358 | Social Buzz panel in Catalysts tab (UI render for #354 + #355) | merged |
| #359 | Promotion approve actually adds to universe + clears blocklist + Investor tab on mobile | merged |

### Broker bridge (Option C from PR #340 research)

| PR | Title | Status |
| --- | --- | --- |
| #356 | Phase 1 sidecar bridge worker scaffold (Robinhood Agentic) | merged |
| #367 | IBKR adapter alongside Robinhood + full setup runbook + real RSA-SHA256 signing | open — last commit on `cursor/broker-bridge-ibkr-adapter-9f61` |

---

## 2. Architectural changes

### New subsystems

**Discovery stack** (`worker/discovery/`):
- `promotion-queue.js` — scores screener candidates across 7 components (sustain, quality, theme, news, insider, macro, peer, social), persists to D1 `discovery_promotion_queue`. `decideOnCandidate` now actually adds approved tickers to the universe + removes from blocklist + fires 365d backfill.
- `social-tracker.js` — StockTwits + Reddit/Apewisdom adapter. Schema: D1 `ticker_social` with per-source rows. Cron runs daily at 22 UTC.
- `news-tracker.js` — Finnhub headlines + sentiment scoring (existing)
- `insider-tracker.js` — Finnhub Form-4 insider transactions (existing)
- `coverage-gaps.js` — missed big-mover diagnostic (existing)

**Macro stack** (`worker/macro/`):
- `cross-asset-tracker.js` — country rotation, sector regime, cross-asset RS

**Broker bridge** (`worker-bridge/` — separate Cloudflare Worker, deployed at `https://tt-broker-bridge.shashant.workers.dev`):
- `bridge-index.js` — router with broker-agnostic dispatch
- `bridge-crypto.js` — AES-256-GCM token wrap, HMAC sign/verify, RSA imports
- `bridge-storage.js` — KV per-user state + D1 `bridge_audit` log
- `bridge-guards.js` — preflight caps (kill switch, $-per-order, daily count, SHORT rejection)
- `bridge-robinhood.js` — Robinhood Agentic MCP client (mock mode default)
- `bridge-ibkr.js` — Interactive Brokers Client Portal Web API adapter with full OAuth 1.0a (DH key exchange, LST cache, RSA-SHA256 + HMAC-SHA256 signing). PKCS#1/PKCS#8 PEM auto-detect.
- `bridge-auth.js` — OAuth flow scaffolding

### Cron architecture

Main worker (`worker/index.js`) has a chained discovery cron at 22 UTC daily:

```
1/5   Coverage gaps diagnostic
2/5   Macro cross-asset refresh
3/5   Insider transactions (Finnhub)
4/5   News + sentiment scoring (Finnhub)
4.5/5 Social — StockTwits        (PR #354)
4.6/5 Social — Reddit/Apewisdom  (PR #355)
5/5   Promotion queue rebuild
```

Hourly investor cron now uses `WORKER_URL=https://timed-trading.com` (PR #351) to bypass CF's self-fetch block on `.workers.dev`.

### UI architecture

**Right Rail (`react-app/shared-right-rail.js`)**:
- Module-scoped `InvestorTabPanel` component, called from BOTH desktop pro-tabs branch and mobile baseTabs render. Fetches `/timed/investor/ticker` and renders 7 sections (Lane Guidance · Why classification · Score Breakdown · Buy Zone Signals · Position · RS/Sector · Thesis+Invalidation).
- Dual bias chip on header: `TRADER · LONG/SHORT` + `INVESTOR · ACCUMULATE/CORE HOLD/WATCH/REDUCE/AVOID/...`. PR #365.
- EXT chip + RTH-locked price outside market hours (PR #363/364)
- Catalyst banner on Investor tab when |daily_pct| or |ah_pct| ≥ 10% (PR #364)

**Today page (`react-app/today.html`)**:
- Live trader-open count published to `window.__liveTraderOpenCount` so brief preview re-renders (PR #357)
- Brief index cards: live-recomputed range when current price is outside morning band (PR #366)
- Real ticker logos (replaces DS.tickerLogo race condition — PR #360)
- Open Positions strip dedup from `/timed/investor/positions` not `/ledger/trades` (PR #357)

**Today page Brief Preview**:
- ES-style narrative prose for SPY/QQQ/IWM (PR #349)
- BULL ACTIVE / WATCHING TRIGGERS chips computed against live price
- "Above early range — bull trigger armed" / "TARGET HIT" banners (PR #366)

---

## 3. Operational state right now

### Live + deployed
- Main worker: latest version on `timed-trading-ingest.shashant.workers.dev`
- Pages: latest from main on `timed-trading.com`
- Broker bridge: live on `tt-broker-bridge.shashant.workers.dev`, **MOCK MODE OFF** (live IBKR calls)
- All cron jobs running

### Investor lane fully unblocked (after PR #351)
- TWLO opened automatically tonight via investor auto-rebalance
- 3 positions trimmed
- Cron computing every hour

### Discovery queue alive
- 8 promoted tickers backfilled with 365 D + 730 W candles each: ALAB, ESTC, LUNR, NET, SMCI, SNOW, TEAM, WULF
- All scoring; investor stage = `research_avoid` for now (correct — thin trend history relative to long-established universe; will upgrade as data accumulates)
- StockTwits + Reddit data flowing daily

### Broker bridge — IBKR setup state

**Setup complete:**
- `BRIDGE_KV` namespace created (id `951f03a0c0464ecfa0d8dad25ebb3361`)
- Bridge secrets set: `BRIDGE_ENCRYPTION_KEY`, `BRIDGE_INTERNAL_HMAC_KEY`, `BRIDGE_OPERATOR_KEY`
- IBKR secrets set: `IBKR_ACCOUNT_ID`, `IBKR_CONSUMER_KEY`, `IBKR_ACCESS_TOKEN`, `IBKR_ACCESS_TOKEN_SECRET`, `IBKR_DH_PRIME`, `IBKR_PRIVATE_SIGNATURE_KEY`, `IBKR_PRIVATE_ENCRYPTION_KEY` (operator rotated all 7 placeholders to real values via CF Dashboard)
- Operator user record created with `broker: "ibkr"`
- Mock mode flipped to `false` in `wrangler.toml`
- Code: PKCS#1 PEM parser, prepend RSA-decrypt, DH key exchange, RSA-SHA256 signing for LST, HMAC-SHA256 for ongoing requests — all working

**Currently waiting on:**
- IBKR-side OAuth activation. Last test (~9:50 PM UTC):
  ```
  HTTP 401 {"error":"id: 95675, error: invalid consumer"}
  ```
  This is IBKR's "consumer key not yet propagated to auth servers" code. IBKR docs say up to 24 hours. User toggled Enable OAuth Access ~3 hours before that test.

**Retest command** (operator key = `RR1TRs8oYAbrDN3WCxOcBUz9j3IDaW8p`):
```bash
curl -sX POST "https://tt-broker-bridge.shashant.workers.dev/bridge/test/rh-call" \
  -H "Authorization: Bearer RR1TRs8oYAbrDN3WCxOcBUz9j3IDaW8p" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"operator","tool":"_lst_debug"}'
```

When `lst_exchange_ok` flips to `true` (i.e. IBKR finishes activation), the next call to `tool: get_portfolio` will return your real account summary.

---

## 4. Open backlog — for the fresh sessions

The user explicitly QA'd tonight and surfaced these. Each is independent and can be tackled separately.

### AREA A — Daily Brief restructure

**Goal:** Restructure both Evening Brief and Morning Brief for retail readability + add inline charts + send Intraday Pulse to Discord with a TLDR summary.

#### Evening Brief — desired order

1. **Session Recap & Context** — explain cross-asset relationships in retail-friendly language. Don't say "XLK relationship with crude and gold" — say what that means and why it matters.
2. **Sector Themes** — spell out sector names; don't use 3-letter codes without context.
3. **ES Prediction Scorecard** — extend to include SPY, QQQ, IWM scorecards too.
4. **Combined Key Levels + Structural Update** — chart per index, with annotation of the structure being referenced, commentary side-by-side with the chart.
5. **Looking Ahead**
6. **Risk Factors**
7. **Active Trader Report**
8. **Investor Portfolio**

#### Morning Brief — same treatment + earnings/macro

1. **Market Context** — easier-reading for non-savvy users
2. **Sector Themes** — spell out names
3. **Earnings Watch** + macro news
4. **ES Prediction Scorecard** — include SPY, QQQ, IWM
5. **Combined Key Levels + Game Plan + Structure + Scenario** — easier to read; ideally with chart alongside or reusing top-of-brief chart
6. **Risk Factors**
7. **Active Trader Report**
8. **Investor Portfolio**

#### Intraday Pulse

- **Send to Discord** in addition to the current site location
- Open with a clear **TLDR summary line** at the top so users scanning quickly can absorb the lean

#### Code locations
- `worker/daily-brief.js` — content generation (LLM prompt + section assembly)
- `react-app/daily-brief.html` — render
- Charts: `worker/index.js` has chart-image endpoint (use TradingView snapshot helpers already in place for autopsy)

---

### AREA B — Issues / enhancements (9 items)

**1. Verify UPTICKS group changes** — operator added MAR, GS, APLD; removed AXP, QXO. Confirm via D1/KV.

**2. Hydrate missing Name/Sector/Industry/MCap on Tickers page** — many tickers blank. Fetch from TwelveData / Alpaca / Finnhub once and persist. MCap can refresh periodically; the others are static.

**3. Admin pages still show stacked navigation** — old nav appears below the new nav on admin pages despite the PR #335/#345 fixes. Need final cleanup pass.

**4. Insights page accuracy issues:**
- Shows 2 live positions; should match the 9 trader + 9 investor (actual)
- "Best" highlights TLN at 1.92% but MU/SNDK are bigger movers
- No Investor-mode actions mentioned
- TT Universe Changes section misses Upticks additions/removals — those should appear here too
- Stop using "Upticks" as a separate label — umbrella under "TT Selected"
- Additions/removals capped at 8 — show full list

**5. Today page layout** — space below the Today Brief panel and to the left of the Predictions panel is under-utilized. See screenshot.

**6. Rename "Setup" tab to "Trader"** on the Right Rail.

**7. Trade Ledger (right rail History tab) showing wrong values for Investor trades** — showing 0 P&L or entry/closed confusion. Should be lot-specific. See screenshots in chat — TSLA INV SELL on Oct 10 shows +21.96% but the receipt shows 14.75 shares HELD AFTER and 0 realized.

**8. Trader tab (renamed from Setup) — surface "Current Open Position" at the top** when a position is open, mirroring how the Investor tab handles open Investor-mode positions.

**9. Today → Read Full Brief crash** — daily-brief page initially crashes (React error #310 + "Cannot read properties of useMemo" → `Object is disposed` from lightweight-charts), then renders on refresh. Console errors point to `IntradayFlash` in `daily-brief.compiled.js`. Likely a chart-disposal race.

---

## 5. Pinned conventions for the next session

- **Branch naming**: `cursor/<descriptive-name>-9f61` (lowercase, kebab-case)
- **Commit format**: `<type>(<scope>): <subject>` then a blank line then body
- **PR base branch**: `main`
- **Dist files**: always rebuild via `npm run build:frontend` before commit
- **Worker deploy**: `cd worker && npx wrangler deploy --env=''` (production env doesn't have cron triggers)
- **Bridge worker deploy**: `cd worker-bridge && npx wrangler deploy --env=''`
- **D1 schema migrations**: `worker/d1-schema.sql` (already applied to remote)
- **D1 direct queries**: `npx wrangler d1 execute timed-trading-ledger --remote --command '...'`
- **Discord lanes**: `notifyDiscord(env, embed, "trade")` for trade alerts, `notifyDiscord(env, embed, "system")` for ops
- **Always test live worker calls before claiming "shipped"**

---

## 6. Quick-reference: key files

| Purpose | Path |
| --- | --- |
| Daily Brief generator | `worker/daily-brief.js` |
| Right rail | `react-app/shared-right-rail.js` |
| Today page | `react-app/today.html` |
| Investor page | `react-app/investor.html` |
| Tickers admin page | `react-app/ticker-management.html` |
| Insights page | `react-app/insights.html` |
| Promotion queue UI | `react-app/screener.html` |
| Mission Control admin | `react-app/mission-control.html` |
| Daily brief render | `react-app/daily-brief.html` |
| Broker bridge worker | `worker-bridge/` |
| Bridge plan + runbook | `tasks/2026-05-29-broker-bridge-phase1-plan.md` |
| Robinhood Agentic research | `tasks/2026-05-28-robinhood-agentic-trading-research.md` |
| AI CIO Shadow→Live audit | `tasks/2026-05-28-cio-shadow-to-live-audit.md` |
| Today page redesign plan | `tasks/2026-05-28-today-page-redesign.md` |
| DMARC runbook | `tasks/2026-05-28-dmarc-runbook.md` |

---

## 7. What to NOT touch in next session unless explicitly asked

- AI CIO shadow→live transition (in flight — needs more data per the audit doc)
- Broker bridge LST exchange code (working — just waiting on IBKR's 24h activation)
- Discord routing (settled in PR #336)
- Email parity (settled in PR #336)
- DMARC ramp (separate runbook, on the operator)
- The fast-onboard backfill defaults (365 D + 730 W — appears correct)
