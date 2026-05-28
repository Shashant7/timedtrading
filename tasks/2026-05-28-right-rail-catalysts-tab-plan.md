# Right Rail — Catalysts tab + mobile tab IA — 2026-05-28

User: *"Surface theme, news, insider for ticker detail in the right rail. Clean info architecture. Mobile tabs don't fit horizontally and require scroll."*

Confirmed via screenshot: the v2 workspace tab strip (Snapshot/Chart/Setup/Technicals/Fundamentals/History) overflows horizontally on mobile, clipping "Snapshot" to "...not".

## Information Architecture decision

**Add ONE new tab: "Catalysts"** that consolidates News + Insider + Themes + Macro + Coverage-Gap History into a single well-organized panel. Why one tab and not four:

- **Cognitive load**: 7 tabs is already at the upper bound of recognition memory; 10+ tabs becomes a menu the user has to *scan* rather than recognize. Goes against the user's "keen IA approach for clean path."
- **Co-location of fundamentally-related signals**: news, insider, theme, macro all answer the same question — *"what's the bigger story behind this ticker right now?"* They belong in one place where the user can scan them together and form a thesis.
- **Mobile constraint**: 4 separate tabs make the horizontal overflow worse, not better.

### Catalysts panel section order (most actionable first)

1. **🔥 News Catalysts** — top headline with strength, sentiment chips, latest 3 headlines
2. **💼 Insider Activity** — net $ buys/sells, high-signal count, top 3 transactions
3. **🎭 Theme Rotation** — themes ticker belongs to + ACTIVE state + peer movers today
4. **🌐 Macro Context** — cross-asset regime narrative, country rotation if relevant
5. **📊 Detection History** — system's capture rate for this ticker, dominant miss reason

Each card has explicit data-source attribution in footer for transparency + compliance.

### Mobile tab layout fix

V2 workspace tabs currently use `overflow-x: auto` which:
- Clips text on the leftmost tab when the active tab is mid-list
- Hides the existence of off-screen tabs (only the right-edge tab shows partial fade)
- Forces horizontal swipe gesture, fighting natural vertical-only scroll on a ticker page

**Fix:** switch from `overflow-x: auto` to `flex-wrap` so 7 tabs wrap into 2 rows on screens narrower than ~640px. Single row on tablet/desktop where space is abundant. Tab pill padding stays the same so the affordance is identical; only the wrap behavior changes.

Equally important: the outer-modal tabs at lines 7069-7101 (`Analysis | Investor | Technicals | Model | Journey | Trades(N)`) also overflow on narrow screens — apply the same fix.

## Data flow

Lazy-fetch on Catalysts tab open, mirror `FUNDAMENTALS` pattern (line 2861):
- 5-minute in-page cache keyed by ticker
- Single bundled request to `/timed/discovery/ticker-catalysts?ticker=SYM` (NEW: combined endpoint that returns news + insider + theme + macro + coverage in one round-trip)
- Worker side: server-side compose of the 4 underlying sources to avoid the rail making 4 separate fetches

OR, simpler: 4 separate fetches in parallel. Cost is ~5 KB total per ticker. Per-ticker, called only on tab open.

Going with **bundled endpoint approach** because:
- Atomic snapshot (all 4 sources from same instant)
- Single auth handshake
- Worker can pre-cache aggressively (KV TTL 15min per ticker)
- Simpler client code

New endpoint:

```
GET /timed/discovery/ticker-catalysts?ticker=SYM
  → { ok, ticker, fetched_at, news, insider, themes, macro, coverage }
```

This is a non-admin route (`requireKeyOrPro` style) so authenticated users can hit it, not just admin.

## What I'm NOT changing

- Existing tabs stay in current order
- Existing Pro-gated tabs stay Pro-gated
- The bigger consolidation question (Analysis vs Investor mode) is deferred — it's a much larger UX rework
- Workspace mode vs modal mode rendering — already correct, just gets the new tab added

## Rollback

- Catalysts tab can be removed by deleting the new tab entry + body block + lazy-fetch effect
- Mobile flex-wrap fix can be reverted to overflow-x-auto independently
- New endpoint is additive — no breaking changes
