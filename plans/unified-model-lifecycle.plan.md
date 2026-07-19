---
name: Unified Model Lifecycle
overview: 'Collapse Active Trader vs Investor mode theater into one model lifecycle. The user experience is trust-the-process: Watching → Queued → Bought → Held → Trimming → Exited. Every position has a WHY (entry thesis), INTENT (what the model will do), and LEVELS (the trade plan). Horizon (swing vs long-haul) is metadata on the trade — not a separate product.'
todos:
  - id: lifecycle-contract
    content: 'Canonical lifecycle states + resolver that maps trader kanban_stage and investor stage/actionTier into one enum; stamp on timed:latest + investor scores.'
    status: completed
  - id: play-vehicles
    content: 'Model play vehicles shares|letf|options — pick at entry, persist lineage, dogfood scorecard W/L/pct, surface on lifecycle + alerts.'
    status: completed
  - id: trade-intent-levels
    content: 'Every ENTRY stamps why_entered + intent + levels (entry/sl/tp/invalidation) so UI shows the plan, not playbook options.'
    status: pending
  - id: unified-board-ui
    content: 'One board (or Today-first surface) keyed by lifecycle state; retire dual AT/Investor kanban as primary UX; horizon as a chip, not a page.'
    status: pending
  - id: event-feed
    content: 'Primary feed = what the model did/is doing (bought/trimmed/exited) with WHY; secondary = research/context. Notifications follow the same taxonomy.'
    status: pending
  - id: broker-execution
    content: 'Broker bridge executes against lifecycle events + account preferences; mode is not a routing fork for fills. Eventually fill the chosen play vehicle, not shares-only.'
    status: pending
isProject: true
---

# Unified Model Lifecycle — Trust the Process

## The reframe

Active Trader and Investor are **not different products**. They are the same machine doing the same actions — buy, trim, sell — with different **horizons and thesis labels**.

If the nirvana state is a broker-connected model that executes against the account and preferences, then the UI job is not "pick a mode and research plays." It is:

> **Is the model doing something with this ticker, and WHY — or is it not, and WHY.**

Let it cook. Trust the process.

## Canonical lifecycle (one mode)

| State | Meaning | User sees |
|-------|---------|-----------|
| **Watching** | Model is aware; no order intent yet | Thesis forming / levels watched |
| **Queued** | Model intends to buy; waiting for session/gate/rebalance | Next action: buy when conditions clear |
| **Bought** | Entry just filled (or model book entry) | WHY entered + levels plan |
| **Held** | Position open; thesis intact | Hold plan; what would change the mind |
| **Trimming** | Partial reduce in progress / recommended | Trim % + remaining thesis |
| **Exited** | Flat; thesis closed | Outcome + lesson |

Horizon (`swing` | `long_haul` | `day`) and book (`model_trader` | `model_investor` | `live_broker`) are **labels on the position**, not separate apps.

## What every signal/trade must carry

1. **Lifecycle state** — one of the six above  
2. **WHY entered** (or why watching / why not) — one human sentence + provenance id  
3. **Intent** — hold-to-target / accumulate-on-dips / trim-into-strength / exit-on-break  
4. **Levels** — entry, invalidation/SL, targets, next decision price  
5. **Business character** — steady value vs growth compounder (changes how levels are read)  
6. **Confidence / conviction** — calibrated when validated; never the headline alone  
7. **Play vehicle** — Shares / Leveraged ETF / Options — the model's chosen expression of the move  

The UI leads with **event + plan + play**, not "here are six ways to play this ticker."

## Ways to play (first-class preference)

The model may shoot **any of the three** vehicles on each signal:

| Play | Meaning | Scorecard key |
|------|---------|---------------|
| **Shares** | Linear underlying | `play_vehicle=shares` |
| **Leveraged ETF** | Mapped LETF (e.g. QQQ→TQQQ) | `play_vehicle=letf` |
| **Options** | Calls/puts/spreads/LEAP/moonshot | `play_vehicle=options` |

- Pref default: all three allowed (`allowed_vehicles`). BYOB later narrows the menu; it does not invent a fourth product.
- At ENTRY the engine records `source=model_play` in `signal_outcomes` plus lineage `model_play` / `vehicle_menu`.
- **Sim fill (2026-07-19):** live book executes the pick via `worker/model-play-sim.js` (`deep_audit_model_play_sim_enabled`, default on). Options = long-debit paper (BS mark); LETF = mapped ticker quote; shares unchanged. Replay stays shares-only. Broker bridge still separate.
- Endpoints: `GET /timed/admin/play-performance` and `GET /timed/play-performance` — W/L, win rate, avg/sum pct by play.

## What we stop doing

- Dual primary kanban (AT vs Investor) as the product identity  
- Teaching users two vocabularies for the same action (enter vs accumulate, trim vs reduce)  
- Fronting research/playbook density over "what is the model doing now"  
- Treating frequency of alerts as a mode difference — taxonomy is one; preferences filter delivery  

## What we keep (as metadata)

- Horizon honesty: a day lean is not a core hold; a LEAP thesis is not a 2-day trim  
- Separate model books in the ledger for attribution (until live broker is the book)  
- Different *entry path* logic under the hood — as long as the **surface contract** is one lifecycle  

## Implementation sequence

1. **Contract** (`worker/model-lifecycle.js`) — resolve unified state from existing fields; no UI rewrite yet.  
2. **Stamp** — attach `model_lifecycle` on scored payloads + investor scores + decision_records.  
3. **Today / Right Rail** — "Model status" block: state + why + levels.  
4. **One board** — migrate AT + Investor boards to lifecycle columns.  
5. **Notifications** — one taxonomy (`MODEL · QUEUED|BOUGHT|HELD|TRIMMING|EXITED`).  
6. **Broker** — execute lifecycle transitions; preferences control size/frequency, not mode forks.  

## Relationship to Trust Spine / business character

- Trust Spine = license to automate (provenance, autonomy, calibration).  
- Business character = fundamentals that change what technicals mean.  
- **This plan = the product surface those systems feed.** Without it, more edge research still looks like mode confusion.

## Done looks like

A user opens the app and within one glance knows: which tickers the model is watching, which are queued, what is held with what plan, what is trimming, what just exited — and can drill into a single WHY + levels card. They do not need to choose "am I an Active Trader or an Investor today?"
