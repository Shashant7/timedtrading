# Live July 2026 → Trade Autopsy (grading feedback)

## Goal
Load **July 2026 live** short-term + long-term positions opened while the model
has been live into Trade Autopsy for individual grading / feedback.

## Design
1. `POST /timed/admin/trade-autopsy/archive-live-month` archives:
   - short-term: live `trades` (`run_id IS NULL`) opened in month
   - long-term: `investor_positions` with `first_entry_ts` in month
2. Includes OPEN rows (not only closed).
3. Autopsy GET includes OPEN for `live-*` / investor run_ids.

## Canonical July 2026 live books
- Short-term: `live-short-term-2026-07`
- Long-term: `live-long-term-2026-07`

```bash
curl -X POST "$API/timed/admin/trade-autopsy/archive-live-month" \
  -H "Authorization: Bearer $TIMED_API_KEY" \
  -d '{"month":"2026-07","mode":"both","include_open":true}'
```
