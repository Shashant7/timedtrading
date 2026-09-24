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

## Before blaming the entry, measure MFE

"We are a step behind and stop out even though we were right" is almost
always reported as an entry complaint and is usually an exit one. Separate
them with one number: the contract's **maximum favourable excursion after
the fill**. A late entry does not go green — MAE comes first and MFE stays
near zero. An entry that ran +60% before the desk let go was fine.

```bash
node scripts/replay-dt-profit-lock.mjs \
  --actions /tmp/dt-actions.json --marks /tmp/dt-marks.json
```

Feed it the `timed:opt-dt-actions` ring and an `option_marks` export
(`SELECT signal_id, ts, mid, bid, ask FROM option_marks WHERE signal_id
LIKE 'dt:%:<date>%'`). It splits every round into MFE/MAE, replays both
stop rules over the same path, and buckets first-of-day entries against
re-entries. `option_marks` is sampled — the script refuses to score a
round whose hold window holds only a few prints, and so should you.

On 2026-09-23/24 that gave: 7/14 fills reached their own 1R trim, and the
entries that did not were almost all re-entries (first position of the day
per underlying and side reached +50% in 5/5; re-entries in 2/9). Entry
timing was not the binding constraint — see `tasks/lessons.md`.

## Autopsy checklist

1. Pull the morning brief levels (`bull_trigger` / `bull_target` or bear)
   and the session OHLC — when did trigger and target tag?
2. Read `timed:opt-dt-actions` + book KV for the BUY timestamp and strike.
3. **Check MFE first** (above). If the contract went green by more than a
   few percent after the fill, stop looking at the entry and go read the
   exit ladder in `worker/option-day-trade-plan.js` `classifyPaperEvent`.
4. If BUY ≫ trigger time and spot was already past target: this is the
   old EMA-chase failure mode (fixed 2026-09-04). Confirm `entry_mode`
   would now be `trigger_pierce` at first pierce and WAIT after target.
5. Cash-open (09:30), open-print wait (09:30–09:45), lean, and chain are
   secondary — only blame them if the clock never saw ST-with or never
   received a gamePlan trigger.

## Exit ladder, since it is usually the answer

| Level | Armed by | Floor |
|---|---|---|
| Hard stop | always | `entry × 0.5` (`HARD_STOP_PCT`) |
| Profit lock | peak ≥ +10% / +$0.08 | `max(hard, min(entry, 0.6 × peak))` — ratchets, reported as `profit_lock_stop` |
| Breakeven | a 1R trim/protect (`profit_armed`) | `entry` — earned, reported as `breakeven_stop` |
| Runner trail | either arm | `0.6 × peak` (`TRAIL_GIVEBACK_PCT`) |

The profit lock and the breakeven are **not** the same level. Collapsing
them (both firing at `mid <= entry`) is what scratched half the book on
2026-09-23/24.

## Related

- Brief accuracy: `daily_briefs` scores + `/timed/admin/brief-accuracy`
- Paper books: `timed:opt-dt-book:<signal_id>`
- Mirror log: `timed:opt-dt-mirror-log` (short TTL)
