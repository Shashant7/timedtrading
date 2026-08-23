# Program timing (MFE / MAE by clock)

**WHEN to use:** Operator asks which session or hour a paper experiment
(Confirm-stack, Cloud Pivot, Continuation) or the core book should fire,
or "have we backtested family timing?"

## What this is

An **observational** scan of filled trades: slice by program, then by
ET session / hour / weekday / minutes-from-open. Crowns the bucket with
the highest `MFE − |MAE|` (and lowest MAE on ties).

This is **not** a flipped `ENTRY_ENGINE` historical replay. It cannot
answer "what if the fill was 30 minutes later." It answers "among fills
that already happened, which clock printed the cleanest excursion."

## Run

```bash
node scripts/program-timing-scan.mjs --wrangler-d1 production --remote --days 60 --min-n 3
node scripts/program-book-autopsy.mjs --wrangler-d1 production --remote
```

Writes `data/trust-spine/program-timing-*.md` + `.json` and
`data/trust-spine/program-book-autopsy-*.md` + `.json`.

Admin UI: Model Performance → Paper experiments → **Ideal clock** table.
API (same rows as family scoreboard): `GET /timed/admin/trust-spine/family-attribution?family=all&days=30` → `timing`.

## How to read

- `edge = avg MFE% − avg |MAE|%` — higher is cleaner
- `thin` = closed n below `--min-n` (default 3) — hint, not a gate
- Paper families are 0.1× — do not widen on a thin clock
- Core book is the contrast lane (everything that is not a named slice)
- **Full-book autopsy** answers pollution vs core degradation. A canonical
  `entry_path` stays **core** even with a paper-family stamp (coincident).
  Only a family path (`tt_cloud_pivot_long`, `confirm_stack_ema21_long`, …)
  without a canonical core `entry_path` is a standalone experiment.
  The 60-day timing scan does **not** apply that preference — do not treat
  its Confirm-stack / Cloud Pivot rows as a dedicated experiment P&L book.

## Source

- Pure aggregator: `worker/trust-spine/program-timing.js`
- CLI: `scripts/program-timing-scan.mjs` / `scripts/program-book-autopsy.mjs`
- Family scoreboard: `worker/trust-spine/family-attribution.js` (`family=all` attaches `timing`)
