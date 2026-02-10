# Pre-market lookback and last-period comparison

## The gap: 4pm → 9:30am

Replay (and live ingest) typically starts at **market open (9:30 AM ET)**. We miss:

- **Pre-market** state changes (e.g. 30m EMA crossover in pre-market, as on AAPL).
- **Overnight** move from previous close (4pm) to first 9:30am candle.

So the **first row at 9:30am** has no "previous" state to compare against, and we don't detect **justEnteredCorridor** or **enteredAligned** (pullback → momentum) if that transition happened between 4pm and 9:30am.

## Does comparison from last period help?

**Yes.** If we **seed** the replay with the **last known state before 9:30am** (e.g. last trail point before `tsStart`), then:

- The **first 9:30am row** has **prevData** = that last-period state (e.g. previous close or last pre-market candle).
- We can detect **justEnteredCorridor** (prev outside corridor, current in corridor).
- We can detect **enteredAligned** (prev state ≠ current state, current in momentum).

That bridges the gap without needing to ingest or store every pre-market candle.

## What we did: replay-ticker-d1

For **replay-ticker-d1** we now:

1. **Before** processing the day's rows (ts ≥ 9:30am), query D1 for the **last trail row** for that ticker **before tsStart**:  
   `SELECT ts, payload_json FROM timed_trail WHERE ticker = ? AND ts < ? ORDER BY ts DESC LIMIT 1`.
2. If found, parse the payload, compute **kanban_stage** and **move_status**, and set **stateMap[ticker]** = that payload.
3. The **first row** in the loop then has **existingState** = that "last period" state, so we compare 9:30am against it and can see state changes (e.g. PULLBACK → momentum).

**Query param:** `includePrevPeriod=1` (default) to enable; `includePrevPeriod=0` to disable.

**Response:** `prevPeriodSeeded: true` when we used a last-period state.

## Data source for "last period"

We use **timed_trail**: the last row with **ts < market open** for that day. That is usually:

- The **previous session’s last candle** (e.g. 4pm or last 1m/5m before 4pm) if we don’t have pre-market data, or
- The **last pre-market candle** if we do store pre-market in timed_trail.

So the comparison from last period **does** bridge the gap for the first 9:30am candle. To also capture **pre-market** state changes (e.g. 30m EMA cross in pre-market), you’d need pre-market data in **timed_trail** (e.g. TV alerts or a pre-market capture that writes to the same trail). Then the "last row before 9:30am" would be a pre-market candle and the first 9:30am row would compare against that.
