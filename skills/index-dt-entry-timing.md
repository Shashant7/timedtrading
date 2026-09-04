# Index day-trade entry timing

**WHEN to use:** Paper/live index options (SPY/QQQ/IWM/DIA) BUY fired hours
after the Daily Brief trigger tagged, or the 1-min lane never armed on a
trending day that the brief graded as a full hit.

**Module:** `worker/option-execution-clock.js` → `buildExecutionClock`
(driven once a minute by the options day-trade section in `worker/index.js`).

## Decision order that matters

1. Cash open / sell window / invalidation / force-liq / session flatten
2. Dead-premium path (already bled from peak)
3. **Anti-chase:** lean target already tagged → WAIT (no new ticket)
4. Premium-rich / R:R / late-entry (after 15:30) gates
5. **Trigger-pierce BUY:** SuperTrend with lean, game-plan trigger pierced,
   progress to target still fresh (`0 ≤ progress < 0.55`), after 09:45,
   premium not rich
6. EMA-pullback / premium-trough / premium-cheap BUY (also blocked once
   target is tagged)
7. SuperTrend against / open print / extended → WAIT

## Autopsy checklist

1. Pull the morning brief levels (`bull_trigger` / `bull_target` or bear)
   and the session OHLC — when did trigger and target tag?
2. Read `timed:opt-dt-actions` + book KV for the BUY timestamp and strike.
3. If BUY ≫ trigger time and spot was already past target: this is the
   old EMA-chase failure mode (fixed 2026-09-04). Confirm `entry_mode`
   would now be `trigger_pierce` at first pierce and WAIT after target.
4. Cash-open (09:30), open-print wait (09:30–09:45), lean, and chain are
   secondary — only blame them if the clock never saw ST-with or never
   received a gamePlan trigger.

## Related

- Brief accuracy: `daily_briefs` scores + `/timed/admin/brief-accuracy`
- Paper books: `timed:opt-dt-book:<signal_id>`
- Mirror log: `timed:opt-dt-mirror-log` (short TTL)
