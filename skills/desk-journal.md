# Desk Journal

**WHEN to use:** Operator wants a TradeZella-style after-close review of a
**broker sleeve** (Webull Individual Margin, imported CSV, …) — pick an
account, see metrics, expand a trip, write a note. Do **not** extend
`/trade-review.html` for this; that page grades **model** engine trades.

## Surface

- Page: `/desk-journal.html` (admin-only; also in the Admin nav)
- Worker: `worker/desk-journal.js`
- Routes (all `requireKeyOrAdmin`):
  - `GET /timed/admin/desk-journal/accounts`
  - `GET /timed/admin/desk-journal/trips?account_id=&from=&to=&unjournaled=&side=`
  - `GET /timed/admin/desk-journal/trip?trip_id=`
  - `POST /timed/admin/desk-journal/sync` `{ user_id, from, to }`
  - `POST /timed/admin/desk-journal/import` `{ account_id, csv }`
  - `POST /timed/admin/desk-journal/journal` `{ trip_id, journal_text, journal_grade, journal_tags }`

## Daily routine

1. Open Desk Journal after 16:00 ET (defaults to the last completed session).
2. Pick the sleeve (Individual Margin is preferred when the label matches).
3. **Sync Webull** for that window (newest **100** fills only).
4. For history beyond 100 rows, **Import CSV** from Webull → Account → Orders.
5. Leave **Unjournaled** on. Expand each trip, read the chart + fills, write
   the note, tap a grade (Repeat / A–F / Avoid), Save.

## Constraints that have already bitten

- Webull `page_size` max is 100, newest first. `start_date === end_date` is
  rejected — the worker widens same-day windows by one calendar day.
- `last_create_time` does **not** page some accounts. CSV is the backfill.
- Alpaca option bars: `GET /v1beta1/options/bars?symbols=SPY260903C00766000`.
  The `/bars/$occ` path 404s — do not reuse `fetchOptionBars()` as-is.
- Journal columns are copied onto rebuilt trips by `trip_id` or
  `account|symbol|entry_ts|qty`. Re-importing the same CSV does not wipe notes.
- Admin gate: `react-app/_worker.js` `ADMIN_ONLY_PAGES` + `JOURNEY_PATHS`
  (`/desk-journal`) so extras does not inject a second nav row.

## Verify

```bash
npx vitest run worker/desk-journal.test.js
# After deploy, as admin:
# /desk-journal.html → pick sleeve → Sync or Import → expand a trip → Save
```
