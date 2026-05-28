# Opportunity Surface Expansion — Plan (2026-05-28)

> User question: "We are light on finding tickers that are not in our universe but are great trades, or tickers in our universe getting lost in our setup detection. Five areas: (1) screeners, (2) news/social/sentiment, (3) research/correlation, (4) options flow + institutional, (5) cycles/rotations/macro."

This document maps each area to **what we already have**, **what's missing**, and **what it would cost to close the gap**. After the audit, the recommended phasing is concrete.

---

## Audit — what already exists

### Discovery infrastructure (substantial — just not closing the loop)

| Asset | Path | Current state |
|---|---|---|
| **TradingView screener cron** | `scripts/discover-tickers.py` + `.github/workflows/screener-daily.yml` | **LIVE** — runs at 22:30 UTC Mon-Fri, scans momentum + top-movers + weekly. POSTs to `/timed/screener/candidates`. **579 candidates in KV right now** from tonight's run. |
| **Screener candidates API** | `/timed/screener/candidates` (GET/POST) | **LIVE** — 7-day rolling KV cache, deduped by ticker. |
| **Move discovery (in-universe)** | `scripts/discover-moves.js` → `/timed/move-discovery` | **EXISTS** — scans entire universe for ATR-relative breakouts, cross-references with trades for capture rate. Currently *manually* triggered (`USE_D1=1 node scripts/discover-moves.js --upload`). |
| **Missed-move diagnostic** | `scripts/diagnose-missed-moves.js` | **EXISTS** — for each missed move, traces what the scoring engine showed during the period. Manual. |
| **Big-movers historical pattern analysis** | `scripts/analyze-big-movers.js` + `data/HISTORICAL_MOVERS_*.json` | **EXISTS** — used during model tuning, not a live signal feed. |
| **Reference-intel refresh cron** | `scripts/reference-intel-refresh.py` + GH Action | **LIVE** — twice-daily. Feeds CIO reference priors. |
| **Discovery review page** | `react-app-dist/move-discovery.html` | **EXISTS** — currently shows static report from KV. |
| **Admin: add ticker to universe** | `POST /timed/admin/universe` (PR #273) | **LIVE** — KV-backed overlay. |

### News / sentiment — minimal

| Asset | Path | Current state |
|---|---|---|
| **Finnhub general news** | `worker/daily-brief.js` | **LIVE** — pulled once-daily, fed into Daily Brief prose only. **Never used per-ticker, never fed to CIO.** |
| **Finnhub earnings + economic calendar** | `worker/daily-brief.js` | **LIVE** — feeds `market_events` D1 table → CIO memory L7 (event-driven context). |
| Per-ticker news | nothing | **MISSING** — Finnhub has `/company-news?symbol=…` but we don't call it. |
| Social (Reddit / X / StockTwits) | nothing | **MISSING** — no infrastructure. |
| Sentiment scoring | nothing | **MISSING** — no per-ticker bull/bear sentiment over windows. |

### Research / correlation themes — minimal

| Asset | Path | Current state |
|---|---|---|
| **Sector mapping** | `worker/sector-mapping.js` + KV overlay | **LIVE** — 245 tickers mapped to sectors. Used for concentration caps. |
| **TICKER_PROXY_MAP** | `worker/sector-mapping.js` | **LIVE** — small set of peer groups (NVDA→AMD/SOXL, etc.) used for earnings-proxy in CIO memory L7. |
| **Cohort overlays** | `worker/pipeline/tt-core-entry.js` | **LIVE** — index_etf, megacap_tech, industrial, speculative, sector_etf — used for entry gates, NOT for opportunity discovery. |
| Theme cluster (AI demand → chips → memory → energy → cooling → datacenter REITs) | nothing | **MISSING** — no explicit theme map nor "peer moved big today" signal. |
| Cross-asset correlation (BTC/ETH leading equities) | `worker/cio/cio-memory.js` L6 | **LIVE for CIO entry** — BTC/ETH 2-4wk trends already feed CIO. |

### Options flow / institutional — nothing

| Asset | Current state |
|---|---|
| Options flow (volume spikes, unusual activity) | **MISSING** — would need Polygon Options, Unusual Whales, or Tradier paid feed |
| Institutional ownership / 13F | **MISSING** — SEC EDGAR is free but quarterly + 45-day lag; commercial real-time = $$$ |
| Dark-pool prints | **MISSING** — vendor-specific paid |
| Insider trades (Form 4) | **MISSING** — Finnhub has `/stock/insider-transactions` (existing API key works) |
| Short-interest changes | **MISSING** — Finnhub has `/stock/insider-sentiment` and short-interest endpoints (existing API key) |

### Cycles / rotations / macro — partial

| Asset | Current state |
|---|---|
| **HMM latent regime** | **LIVE** (BULL_TREND / CHOP / BEAR_TREND on universe). Already in CIO. |
| **Markov regime forecast** | **LIVE** (per-ticker + universe 4-state + 12-state). Already in CIO. |
| **VIX state** | **LIVE** (`market_internals` + `daily_market_snapshots`). Already in CIO L6. |
| **Sector rotation** | **LIVE** (`daily_market_snapshots.sector_rotation`) — coarse. Already in CIO L6 + L8b. |
| Cross-country / cross-asset macro tilts (S Korea EWY outperforming, China FXI underperforming, oil/energy regime) | **PARTIAL** — `daily_market_snapshots` has oil/SPY but no country-ETF performance tracking. |
| Cycle indicators (4-yr cycle, election cycle, presidential year, seasonality) | **MISSING** |
| Bond/yield curve regime | **MISSING** — Finnhub has yield data; not pulled |

---

## What's actually wrong today

**TL;DR:** We have a daily firehose of 100-500 fresh discovery candidates landing in KV every night. Nothing consumes them. The model trades only what's already in `SECTOR_MAP` (~245 tickers + ~14 user-added), so 90%+ of the universe of valid daily setups is invisible to the engine.

Concretely, the failure modes the user described map to:

1. **"Great tickers not in our universe"** → discovery cron is finding them (`/timed/screener/candidates` has 579 from tonight). No auto-promotion. No surfacing in CIO. No "should I add this?" admin review.
2. **"Tickers in our universe getting lost"** → no live coverage-gap diagnostic. The `diagnose-missed-moves.js` script exists but is manually run, not scheduled, not surfaced.
3. **"NBIS / Aschenbrenner / catalyst-driven runs"** → no per-ticker news ingest, no sentiment scoring, no "catalyst tag" anywhere in the engine.
4. **"Secondary/tertiary effects (AI demand chain)"** → no theme cluster map beyond the tiny TICKER_PROXY_MAP, no "peer moved big → flag the cluster" propagation.
5. **"Options flow + institutional"** → none. Greenfield.
6. **"Country rotations + macro tilts"** → coarse — we have HMM/Markov/VIX/sector_rotation but no cross-country / cross-asset detail.

---

## Phased plan

### Phase 1 — Close the existing loop *(ship now, no external data needed)*

**Cost: $0. Effort: small. Value: immediate. Uses what we already pay for.**

1. **`/timed/admin/discovery/coverage-gaps` endpoint + daily cron**
   - Scans every in-universe ticker for ≥ 3× ATR daily moves in the last N sessions
   - For each missed move, classifies why no trade fired:
     - `not_scored` — no scoring ran (cron miss or stale candles)
     - `gate_blocked` — admission_cohort_log shows a specific gate
     - `low_rank` — score was computed but rank < gate
     - `cohort_fail` — cohort floors blocked it
     - `setup_not_detected` — engine saw no qualifying setup
     - `entry_path_blocked` — entry path filter killed it (Speculative grade in chop, etc.)
   - Surfaces in System Intelligence: "Universe coverage gaps — past N days"
   - Operator-actionable: "this ticker missed 5 of last 10 moves, all classified `setup_not_detected` — investigate entry criteria"

2. **CIO memory L9 — theme rotation / discovery signal**
   - When CIO evaluates a ticker entry, surface in memory:
     - "Same sector had X big movers today: TSM (+5.2%), AMD (+3.8%)" — theme is active
     - "This ticker appeared in screener top_gainers for 3 of last 5 scans" — sustained momentum
     - "Universe-coverage gap classification for this ticker over last 30d: 5/12 valid moves missed, dominant reason: cohort_fail" — known weak detection
   - Cost: ~50 extra tokens per CIO call, negligible

3. **Discovery promotion queue**
   - Daily cron filters `timed:screener:candidates` for quality:
     - Appeared in ≥ 2 scans over last 5 days
     - Volume > 1M, market cap > $1B
     - Has SECTOR_MAP entry OR sector inferable from screener payload
     - Not on blacklist
   - Top N candidates written to `discovery_promotion_queue` D1 table
   - Admin endpoint `/timed/admin/discovery/promotion-queue` for review
   - "Approve" action calls existing `POST /timed/admin/universe/add`

4. **Schedule existing scripts**
   - `discover-moves.js` (currently manual) → GitHub Action runs nightly at 23:30 UTC
   - `diagnose-missed-moves.js` → runs after `discover-moves.js`, posts the diagnostic

### Phase 2 — News + per-ticker sentiment *(small approval needed: API call volume on existing Finnhub key)*

**Cost: $0 on existing Finnhub plan if call volume stays under quota.**

1. **Per-ticker news ingest** — Finnhub `/company-news?symbol={SYM}&from=YYYY-MM-DD&to=YYYY-MM-DD`. Pull last 24h for the 30-40 highest-rank in-review tickers + open positions, twice daily (pre-market + lunch).
2. **D1 table `ticker_news`** — ticker, date, headline, source, url, summary
3. **Sentiment score via gpt-4o-mini** — batch 20 headlines per call, score each `bullish` / `bearish` / `neutral` + `catalyst_strength` 0-10. Cost ~$0.10/day.
4. **CIO memory L10 — recent news + sentiment**
5. **Discovery enrichment** — high-sentiment news on a candidate ticker flags it as priority promotion.

### Phase 3 — Theme cluster + research correlation *(no external data — pure engineering)*

**Cost: $0. Effort: medium. Value: directly answers user's "AI demand → chips/memory/energy" example.**

1. **Theme map** — explicit `THEMES` object in `worker/sector-mapping.js`:
   ```
   ai_infra: { primary: NVDA, AMD, AVGO, MRVL; memory: MU, WDC, STX, SNDK;
               energy: NEE, VST, CEG, PWR, TLN; cooling: VRT, MOD;
               datacenter: DLR, EQIX; networking: ANET, CIEN;
               semicap: AMAT, LRCX, KLAC, ASML }
   space_tech: { primary: RKLB, ASTS, IRDM; defense: LMT, RTX, NOC, GD }
   weight_loss: { primary: LLY, NVO; biotech: VKTX, ALT }
   data_infra: { primary: SNOW, DDOG, PLTR; security: CRWD, ZS, PANW }
   crypto: { primary: COIN, RIOT, MSTR, HIMS; etf: IBIT, BITO }
   ```
2. **"Theme is active" signal** — when ≥ 30% of a theme's tickers move > 2% same day, the theme is "active"
3. **CIO memory L11 — theme alignment** — when CIO evaluates a ticker, surface "this ticker is in `ai_infra.memory` cluster; cluster is ACTIVE today (4/4 names up >2%, MU +4.5% on Aschenbrenner-tied flows)"
4. **Discovery boost** — when a theme is active, screener candidates tagged with that theme get promoted faster

### Phase 4 — Options flow + institutional *(significant approval — paid feeds)*

**Cost: $150-$500/month depending on vendor. Effort: medium. Value: high — predictive on big moves.**

| Source | What it gives us | Cost | Recommendation |
|---|---|---|---|
| **Polygon Options** | Volume, open interest, IV, unusual activity | ~$200/mo | Best price for raw data; we'd write our own unusual-activity detector |
| **Unusual Whales** | Pre-filtered unusual options, dark pool, social, gamma | $50-$100/mo | Cheapest, highest-signal product. Recommend this for first toe in the water |
| **Tradier sandbox** | Options chains free if you have a brokerage account | $0 | Limited to chains, no flow |
| **SEC EDGAR (13F + Form 4)** | Quarterly institutional positions + insider trades (real-time) | $0 | Slow but free; Form 4 is real-time and high-signal (insider buys at NBIS-scale = big leading indicator) |
| **Finnhub insider transactions** | Already have the API key | $0 | Untapped — quick win |

**Recommendation for Phase 4 start:** Wire Finnhub insider transactions (free, existing key) + Unusual Whales API (~$80/mo if we go SaaS) as Phase 4a. Defer Polygon Options to Phase 4b based on Phase 4a evidence.

### Phase 5 — Cross-country / cross-asset macro *(no external data — uses existing TwelveData feed)*

**Cost: $0. Effort: medium-small. Value: medium.**

1. **Cross-country ETF tracking** — add EWY, EWG, EWJ, FXI, INDA, EWZ, MCHI, KWEB to a separate "macro_etf" universe. Pull daily candles. Compute rolling 20-day / 60-day relative strength.
2. **Cross-asset tracking** — DXY, GLD, SLV, USO, BNO, UNG, TLT, IEF, HYG, LQD, FXE, FXY. Daily. Same RS framework.
3. **`daily_market_snapshots` extension** — add `country_rotation` (top 3 + bottom 3 outperformers), `cross_asset_regime` (dollar trend, gold trend, oil trend, rates trend).
4. **CIO memory L12 — macro tilt** — surface to CIO: "USD strong (DXY +2.4% this month), gold weak (-1.8%), South Korea outperforming (EWY +3.1% vs SPY flat), Chinese ADRs underperforming". Lets CIO factor your thesis directly.
5. **Theme correlation** — chip cycle vs DRAM cycle vs RAM pricing (use existing fundamentals if available)

---

## Recommended execution order

| Phase | Effort | External cost | Approval needed | Recommendation |
|---|---|---|---|---|
| **1: Close loop** | small | $0 | none | **Ship now** |
| **2: News + sentiment** | small-medium | $0 (existing Finnhub) + $3-5/mo OpenAI | none | Ship after Phase 1 lands |
| **3: Theme cluster** | medium | $0 | none | Ship in parallel with Phase 2 |
| **4a: Insider + free institutional** | medium | $0 | none | Ship after Phase 2-3 |
| **4b: Options flow (paid)** | medium-large | $50-$200/mo | **explicit user $$ approval** | Decide based on Phase 4a evidence |
| **5: Cross-country macro** | medium-small | $0 | none | After Phase 1-3 prove value |

---

## What I'm shipping tonight (Phase 1 — partial)

Given how much already landed today, I'm shipping the **two highest-leverage Phase 1 pieces**:

1. **Coverage-gap diagnostic endpoint + cron** — directly answers "tickers in our universe getting lost in our setup detection." Surfaces missed moves with classified reasons (cohort_fail / setup_not_detected / etc.) so we can fix the engine, not just the data.
2. **CIO memory L9 — discovery context + sector-peer movers + coverage-gap history** — gives CIO awareness of the broader rotation when evaluating any single trade, and surfaces known-weak detection cases so it can ADJUST confidence.

These two pieces alone close the most actionable loop with zero external data dependencies. Phases 2-5 will be follow-up PRs with explicit scope/cost in each.
