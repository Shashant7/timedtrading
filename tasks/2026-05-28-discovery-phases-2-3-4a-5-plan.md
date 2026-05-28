# Discovery Phases 2 / 3 / 4a / 5 + Promotion Queue — 2026-05-28

User: *"Let's do the Screener Queue and Promotion flow, with the flow accounting for easy to decide justification / thesis for why we should include it, not because it just ran a bunch, we don't want to get caught up in pump and dumps. Let's apply all the Phases 2, 3, 4, 4a, 5 and hold off on 4b (Options Flow) until later."*

Scope: Phase 3 (themes), Phase 4a (insider), Phase 5 (macro), Phase 2 (news+sentiment), plus the Promotion Queue with **explicit pump-and-dump defense**.

---

## Promotion Queue — design (the key piece)

### What the user explicitly does NOT want

> "we don't want to get caught up in pump and dumps"

Pump-and-dump signatures we must defend against:
1. **Single-day extreme moves with no fundamental catalyst** — penny stocks ramping 60%+ on social media buzz
2. **Volume-spike-without-price-sustainment** — late-day volume bomb that fades next session
3. **Coordinated screener appearance with thin liquidity** — sub-$1B market cap, < 500k avg volume
4. **Recent reverse splits / fresh IPOs** — common P&D vehicles
5. **Sustained appearance in `top_gainer` alone** without theme / news / institutional confirmation

### Thesis-quality scoring framework

A candidate gets a `total_score` 0-100 plus a `thesis_text` (1-2 sentence human-readable rationale) and a `red_flags` array. Components:

| Component | Weight | Definition |
|---|---|---|
| **SUSTAIN** (0-20) | 20% | Appeared in screener ≥ 3 scans across ≥ 3 distinct days in last 7d. Single-day spike = 0. |
| **QUALITY** (0-20) | 20% | Hard floor: market cap > $2B AND avg volume > 1M AND price > $5. Below floor → score 0, skipped entirely. Above → scaled by liquidity quartile. |
| **THEME_ACTIVE** (0-15) | 15% | Maps to a known theme (Phase 3 THEMES map) AND ≥ 30% of theme peers up >2% same day. NBIS+Aschenbrenner+AI infra = full 15. Lone runner = 0. |
| **NEWS_CATALYST** (0-15) | 15% | Phase 2 sentiment ≥ 0.7 bullish on a "catalyst" headline within 5 days. NBIS + Situational Awareness Fund disclosure = full 15. No news = 0. |
| **INSIDER_BUY** (0-10) | 10% | Phase 4a insider Form-4 BUY in last 14 days, $ value > $100k AND insider role in (CEO, CFO, Director, 10%-Owner). Insider SELL doesn't auto-penalize (often planned). |
| **MACRO_ALIGN** (0-10) | 10% | Phase 5 macro tilt favors this sector/region. AI infra in US-strong-on-energy-and-AI thesis = full 10. China ADR in China-underperforming = 0. |
| **PEER_VALIDATION** (0-10) | 10% | Existing in-universe peers (same THEME bucket) have a positive recent capture record on our system. New chip name validated by NVDA/AMD/AVGO winning here = full 10. |

**Pump-and-dump red-flag deductions** (each subtracts from total, can drive score negative → auto-reject):

| Red flag | Deduction | Detection |
|---|---|---|
| `extreme_single_day_move` | -30 | One-day move > 30% AND it's only appeared in 1 scan (not sustained) |
| `low_liquidity` | -20 | avg_volume < 500k OR market_cap < $1B |
| `sub_$5_price` | -15 | price < $5 |
| `recent_ipo_or_split` | -10 | (deferred to Phase 4a: insider/SEC data we don't have yet — placeholder rule based on age in our candle history) |
| `no_news_no_theme_no_insider` | -25 | None of SUSTAIN, NEWS_CATALYST, INSIDER_BUY, THEME_ACTIVE non-zero. Pure technical pump suspicion. |
| `volume_spike_no_price_sustain` | -15 | Volume > 5× 30-day avg on the spike day, but next-day close fell > 5% from spike close |

### Auto-decision thresholds

```
total_score >= 60 AND no critical red flags → status="ready_to_add"        (auto-add to user_tickers)
total_score >= 40 AND no critical red flags → status="needs_review"        (admin must approve)
total_score <  40 OR critical red flags     → status="rejected"            (logged but not surfaced)
```

Critical red flags: `low_liquidity`, `sub_$5_price`, `no_news_no_theme_no_insider`.

### Thesis text generation

Each queue row stores a human-readable thesis built deterministically from components — for the operator review UI:

> *"**NBIS** — AI infra hyperscaler (theme: ai_infra). Appeared in screener top_gainer 4× in last 5 days (+18.3% on 5/27). Catalyst: Aschenbrenner Situational Awareness Fund disclosure (news sentiment 0.85). Insider activity: 2 director buys totaling $1.2M last week. Theme ai_infra is ACTIVE (5/8 peers up >2% today). Macro: US AI infra favored in current regime. Score: 84/100. Recommendation: READY_TO_ADD."*

> *"**WULF** — Crypto miner. Appeared in screener top_gainer 1× (+47% on 5/26). NO news, NO insider, NO theme peer validation. Red flags: extreme_single_day_move, low_liquidity (avg vol 380k), no_news_no_theme_no_insider. Score: -55/100. Recommendation: REJECTED (pump-and-dump suspect)."*

### Tables

```sql
CREATE TABLE discovery_promotion_queue (
  candidate_id      TEXT PRIMARY KEY,        -- ticker:YYYY-MM-DD
  ticker            TEXT NOT NULL,
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  appearances_7d    INTEGER NOT NULL,
  total_score       INTEGER NOT NULL,
  status            TEXT NOT NULL,           -- 'ready_to_add' | 'needs_review' | 'rejected' | 'approved' | 'declined'
  thesis_text       TEXT,
  red_flags_json    TEXT,
  components_json   TEXT,                    -- per-component breakdown for transparency
  signals_json      TEXT,                    -- raw screener + news + insider snapshot
  decided_by        TEXT,                    -- operator email / 'auto' for ready_to_add
  decided_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
```

### Admin endpoints

```
GET  /timed/admin/discovery/promotion-queue?status=needs_review&limit=50
POST /timed/admin/discovery/promotion-queue/decide  body: { candidate_id, decision: "approve"|"decline", note? }
POST /timed/admin/discovery/promotion-queue/rebuild — daily cron's manual trigger
```

`approve` → calls existing `POST /timed/admin/universe/add` to add the ticker. `decline` just logs.

---

## Phase 3 — THEMES map + peer-mover propagation

`worker/sector-mapping.js` adds:

```js
export const THEMES = {
  ai_infra_compute:  ["NVDA","AMD","AVGO","MRVL","ANET","CIEN","ARM","SMCI","NBIS"],
  ai_infra_memory:   ["MU","WDC","STX","SNDK","HIMX"],
  ai_infra_energy:   ["NEE","VST","CEG","PWR","TLN","NXT","AES","BE"],
  ai_infra_cooling:  ["VRT","MOD","JCI","DOV"],
  ai_infra_dc_reit:  ["DLR","EQIX","IRM","COR"],
  ai_infra_semicap:  ["AMAT","LRCX","KLAC","ASML","ENTG"],
  ai_software:       ["PLTR","SNOW","DDOG","CRWD","ZS","PANW","NOW","NET","S","CFLT"],
  space_tech:        ["RKLB","ASTS","IRDM","SPCE"],
  weight_loss:       ["LLY","NVO","VKTX","ALT"],
  crypto:            ["COIN","RIOT","MARA","MSTR","HOOD","CIFR","WULF","IREN","HUT","BTBT"],
  crypto_etf:        ["IBIT","BITO","ETHE","BTCO","FBTC"],
  fintech:           ["SOFI","UPST","NU","AFRM","HOOD","PYPL","SQ"],
  defense:           ["LMT","RTX","NOC","GD","HII","LDOS"],
  uranium_nuclear:   ["UEC","DNN","CCJ","NXE","UUUU","SMR","BWXT","LEU"],
  ev_battery:        ["TSLA","RIVN","LCID","CHPT","ALB","LITE"],
  obesity_adjacent:  ["LLY","NVO","ABBV","AMGN","PFE"],
  cybersecurity:     ["CRWD","ZS","PANW","NET","S","FTNT","OKTA","CYBR"],
  oil_gas:           ["XOM","CVX","COP","EOG","DVN","SLB","HAL","OXY","PSX"],
  banks_money_center:["JPM","BAC","WFC","C","GS","MS"],
};

export function getThemesForTicker(sym) { ... }
export function isThemeActive(themeName, livePriceMap) { ... }
export function activeThemesNow(livePriceMap) { ... }
```

CIO memory L11 reads the live `timed:prices` KV map, calls `activeThemesNow()`, and surfaces:
- Themes that contain the current ticker
- For each, "X / N peers up > 2% today, top movers: …"

---

## Phase 4a — Insider transactions

New cron pulls Finnhub `/stock/insider-transactions?symbol={SYM}` for:
- Every open position (always)
- Every in-review ticker that appears in screener candidates (daily)
- Top 30 universe tickers by recent volume (weekly to keep API calls bounded)

D1 table `insider_transactions`:
```sql
CREATE TABLE insider_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  insider_name TEXT,
  insider_title TEXT,         -- CEO, CFO, Director, 10% Owner, etc.
  transaction_date TEXT,      -- YYYY-MM-DD
  transaction_code TEXT,      -- P (purchase), S (sale), A (award), etc.
  shares INTEGER,
  price REAL,
  total_value REAL,
  filing_url TEXT,
  fetched_at INTEGER,
  UNIQUE(ticker, insider_name, transaction_date, transaction_code, shares)
);
```

CIO memory L12 surfaces:
- `recent_buys`: count + total $ value + named insiders in last 14d, with role weight
- `recent_sells`: count + total $ value (informational — doesn't auto-penalize)

---

## Phase 5 — Cross-country + cross-asset macro

Add to a separate "macro_universe" set:
```
Country ETFs:  EWY (Korea), EWG (Germany), EWJ (Japan), FXI / MCHI / KWEB (China),
               INDA (India), EWZ (Brazil), EWA (Australia), EWC (Canada),
               EWU (UK), EWW (Mexico), EZA (S Africa)
Cross-asset:   DXY (dollar), GLD (gold), SLV (silver), USO (WTI), BNO (Brent),
               UNG (nat gas), TLT/IEF (rates), HYG/LQD (credit), FXE (euro), FXY (yen)
```

These piggyback on existing TwelveData candle ingest (already in pipeline for any ticker in `SECTOR_MAP`).

New module `worker/macro/cross-asset-tracker.js`:
- Compute 20-day and 60-day relative strength vs SPY for each macro_universe ticker
- Classify regime per asset: `outperforming` / `inline` / `underperforming`
- Daily cron writes `timed:macro:cross-asset-summary` KV blob

CIO memory L13 surfaces:
- `country_rotation`: top 3 + bottom 3 country ETFs (20-day RS)
- `cross_asset_regime`: dollar_trend / gold_trend / oil_trend / rates_trend / credit_spread_trend

User's thesis ("US > Korea > … > China importing energy underperforming") becomes a directly-queryable signal CIO can weight when evaluating any LONG/SHORT entry.

---

## Phase 2 — Per-ticker news + sentiment

New cron pulls Finnhub `/company-news?symbol={SYM}&from=&to=` for:
- Every open position (every hour during market hours)
- Top 30 in-review tickers (every */5 during RTH)
- Top 50 universe tickers by rank (twice daily off-hours)

D1 table `ticker_news`:
```sql
CREATE TABLE ticker_news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  headline TEXT NOT NULL,
  source TEXT,
  url TEXT,
  summary TEXT,
  datetime_utc TEXT,          -- ISO
  sentiment TEXT,             -- 'bullish' | 'bearish' | 'neutral'
  catalyst_strength INTEGER,  -- 0-10
  scored_at INTEGER,
  UNIQUE(ticker, url)
);
```

Sentiment scoring via gpt-4o-mini, batched 20 headlines per call, JSON output:
```json
{
  "scores": [
    { "url_hash": "...", "sentiment": "bullish", "catalyst_strength": 9,
      "summary": "Major institutional fund disclosed position", "is_catalyst": true },
    ...
  ]
}
```

Cost: ~250 tickers × 5 headlines/day × $0.15/1M tokens = ~$0.10/day. Negligible.

CIO memory L14 surfaces top headlines + sentiment + catalyst flag.

---

## Phase ordering for build

1. **Phase 3 (THEMES)** — foundational, used by Phase 5 + Queue
2. **Phase 4a (insider)** — D1 + cron + CIO L12
3. **Phase 5 (macro)** — cron + KV + CIO L13
4. **Phase 2 (news + sentiment)** — D1 + cron + sentiment scoring + CIO L14
5. **Promotion Queue** — consumer of all 4 above + screener candidates → thesis-quality scoring → admin endpoints + daily cron
6. CIO prompt updates teaching it about all new memory layers + pump-defense bias
7. Deploy + smoke + new PR

---

## What's intentionally deferred

- **Phase 4b (Options Flow)** — needs paid feed approval ($50-200/mo). User explicitly said hold.
- **UI for promotion queue review** — the admin endpoints land in this PR; the System Intelligence UI tab is a separate small PR (a non-engineering follow-up).
- **News-source quality weighting** — first cut treats all Finnhub sources equally. Future: weight Bloomberg/Reuters higher than seekingalpha/zerohedge.
- **Multi-source news cross-validation** — first cut is Finnhub only. Future: cross-ref with NewsAPI / Polygon news.

---

## Rollback

Each phase ships as a self-contained module:
- `worker/sector-mapping.js` THEMES export — additive, no breaking change
- `worker/discovery/insider-tracker.js` — new file
- `worker/macro/cross-asset-tracker.js` — new file
- `worker/discovery/news-tracker.js` — new file
- `worker/discovery/promotion-queue.js` — new file

Disable individually via model_config flags:
- `gates.discovery_phase3_themes_in_cio` (default true)
- `gates.discovery_phase4a_insider_enabled` (default true)
- `gates.discovery_phase5_macro_enabled` (default true)
- `gates.discovery_phase2_news_enabled` (default true)
- `gates.discovery_promotion_queue_auto_add` (default false — operator-approve only until trust earned)
