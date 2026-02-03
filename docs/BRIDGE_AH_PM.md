# Bridging the Gap During After-Hours (AH) and Pre-Market (PM)

## The gaps

| Window | Issue |
|--------|--------|
| **4pm → 9:30am** | No bars in trail during AH/PM for equities, so "last period" seed is usually **previous RTH close (4pm)**. We already use that in replay (see [PRE_MARKET_LOOKBACK.md](PRE_MARKET_LOOKBACK.md)). |
| **PM (4am–9am ET)** | TradingView **watchlist** equity alerts often **do not fire** during extended hours (platform limit). So we rarely get PM bars into `timed_trail`. |
| **AH (4pm–8pm ET)** | Same TV limit: after 4pm we often get no more bars until next RTH. |

So we **do** bridge 4pm→9:30am by seeding with the last known state before 9:30am (that last state is typically the 4pm close). What we **don’t** have is continuity *within* PM or AH (e.g. “squeeze released at 8am”) unless we get data from somewhere.

---

## Options to better bridge AH/PM

### 1. **Get PM/AH data from TradingView (equities)**

- Use **individual chart alerts** (not watchlist) for key tickers, with:
  - Chart: **Extended Hours** enabled (Settings → Symbol).
  - Script: **Bypass Session Check** = true.
- Alerts may then fire on PM/AH bars and send payloads to ingest → `timed_trail`.  
- Replay “last period” seed becomes the **last PM bar** before 9:30am instead of only the previous 4pm close.  
- **Cost**: More alert setup per symbol; TV may still restrict some equity alerts in extended hours.

### 2. **Explicit end-of-RTH snapshot (4pm baseline)**

- At **4:01pm ET** (or end of RTH), run a job that:
  - Reads current KV state (or last trail row per ticker for that day),
  - Writes an **EOD snapshot** per ticker (e.g. `timed_eod_snapshot` in D1, or a dedicated KV key like `timed:eod:{ticker}:{date}`).
- Replay (and live open) then **seed from EOD** when “last row before 9:30am” is requested:  
  - Prefer `timed_eod_snapshot` for `date - 1` if present, else fall back to last `timed_trail` row before 9:30am.  
- Gives a **clean 4pm baseline** instead of “last bar we happened to store.”

### 3. **Lightweight AH/PM heartbeat**

- A **scheduled** run (e.g. 8pm ET, 8am ET) that:
  - For each watchlist ticker, calls ingest with a **minimal payload** (e.g. price + last known state from KV or from a previous trail row),
  - So ingest writes one **trail row per ticker** during AH and one during PM.  
- Then “last period before 9:30am” can be the **8am heartbeat** (or last PM bar) instead of only the previous day’s 4pm.  
- Requires a small **heartbeat payload** format and ingest path that accept “synthetic” bars (e.g. from a cron, not from TV).

### 4. **Tag RTH vs EXT in trail**

- When writing to `timed_trail`, add a **session** field: `RTH` vs `EXT` (or `session_type`), e.g. from TV’s session or from server time.  
- When querying “last period before 9:30am”, **prefer** the last row with `session = RTH` (i.e. last true 4pm close) so we never seed from a partial AH bar unless intended.  
- Improves quality of the existing “last row before 9:30am” seed; doesn’t add new PM/AH bars by itself.

### 5. **Futures / 24h symbols**

- For symbols that trade 24/5 or 24/7 (e.g. ES, NQ, crypto), TV alerts fire in AH/PM and we already get a continuous trail.  
- For equities, using an index future (e.g. ES) as a regime filter is a way to use 24h data without changing equity alert behavior.

---

## Recommended order

1. **Short term**: Rely on **prev-period seed** (already in place) so 9:30am always compares to last known state (usually 4pm). Optional: **Tag RTH/EXT** (option 4) so that “last period” is explicitly last RTH when available.  
2. **If you want PM/AH bars for equities**: Add **individual chart alerts + Extended Hours + Bypass Session Check** (option 1) for a small set of symbols and confirm TV fires; then replay will automatically use last PM bar as seed when present.  
3. **If you want a reliable 4pm baseline**: Add **EOD snapshot** (option 2) and use it as the preferred seed for “previous period” in replay and, if desired, for open logic.  
4. **If you want continuity without TV in AH/PM**: Add **AH/PM heartbeat** (option 3) so you have at least one trail point per ticker in AH and PM.

---

## Summary

- **Current**: We already bridge 4pm→9:30am by seeding replay with the last trail row before 9:30am (usually 4pm).  
- **Better bridge**: Get PM/AH data into the trail (TV individual alerts + extended hours, or EOD snapshot, or AH/PM heartbeat), and/or tag RTH vs EXT so the “last period” we use is the true previous close when that matters.

---

## Implemented: First-bar-of-day lane bridge (Option 3 style)

**Problem:** Tickers in Watch at EOD can move into ENTER NOW overnight/PM; by first ingest (9:31am ET) they are already in HOLD or TRIM. Lane transition rules required "pass through ENTER_NOW first" (cycle + trigger), so we forced them to Watch or ENTER_NOW and missed the actual move.

**Solution:** When the **previous state** is from **before today's market open** and the **current bar** is **at or after 9:30am** (first bar of day after the gap), and `classifyKanbanStage` says **hold / just_entered / trim / exit**, we **accept** that stage instead of forcing Watch or ENTER_NOW. We set the cycle from this bar (kanban_cycle_enter_now_ts, trigger_ts, side) and entry_price/entry_ts from payload so subsequent bars have a valid cycle.

**Where applied:**
- **Replay-ticker-d1**: `isFirstBarOfDayAfterGap(existingTs, rowTs, tsStart)` — if true and mgmt, keep finalStage = stage and backfill cycle.
- **Live ingest** (main + capture-promote): same check with `existing?.ts`, `payload?.ts`, today's market open. Flag `payload.flags.first_bar_of_day_bridge = true` when used.

**Result:** First 9:31am (or first bar after open) that shows hold/trim is placed in HOLD/TRIM instead of forced to Watch or ENTER_NOW; fewer missed trades and less chasing lower-probability pullbacks.
