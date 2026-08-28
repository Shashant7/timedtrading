# Core play catalog

**WHEN to use:** Operator asks why two setup names are "different
implementations", wants bleeders gated, or needs the one list of core
plays (not a long similar-looking menu).

## The rule

One play = one id + one label.

`Gap Reversal Long` (historical `setup_name`, no `entry_path`) and
`tt_gap_reversal_long` (stamped from May 2026) are the **same** play.
Do not pause the workhorse because a path-only slice of 20 recent fills
lost money.

Source: `worker/foundation/play-catalog.js` (`resolvePlay`,
`canonicalPlayId`, `isPlayPaused`).

## Status

| Status | Meaning |
|---|---|
| `live` | Take when the detector + admission fire. Workhorse: gap reversal. |
| `restricted` | Admission matrix only (wildcard ON). ATH, N-test, ATL, index swing, Cloud Pivot. |
| `paused` | Hard reject at qualify. Range reversal long/short. |

Admission used to no-op when grade was empty (`missing_inputs_default_allow`).
`deep_audit_ja_grade_wildcard` now defaults **true** in
`worker/pipeline/tt-core-entry.js` so ATH / N-test / range / index-swing
rows actually apply. Opt out with `false`. Restricted plays fail closed
when the flag is on and no exact/`*` row matches. ATH `*` also requires
`conviction>=4` (same as Prime). `min_rr` / `min_conviction` fail closed
when the value is missing.

**Cloud Pivot is a catalog play** (`tt_cloud_pivot`, restricted,
role `calibration`). Loop 1 and Trade Review must see that id. The
weekly governor must **not** auto-pause it — first print was 2026-08-24
at paper size. Visible ≠ auto-demote.

Paper families (Confirm-stack / Cloud Pivot / Continuation) still open a
**0.1×** sibling ticket when FIRE + proposal are live and no core path is
in the enter lane (`resolvePaperFamilyStandaloneEntry`). Those path ids
look like `tt_cloud_pivot_long` and do **not** resolve to the catalog
play (the `_long` suffix is the carve-out). Do not apply 0.1× size to
`tt_gap_reversal_*` / `tt_n_test_*` / ATH / core `tt_cloud_pivot`.
Family exits (`evaluateTtCloudPivotExit`) must read that paper path from
the trade, not `tickerData.setup_name`.

## Verify

```bash
npx vitest run worker/foundation/play-catalog.test.js worker/foundation/tt-cloud-pivot.test.js worker/july-autopsy-gates.test.js worker/phase-c-setup-admission.test.js tests/email-setup-name.test.js
```

Re-read the book with one play key:

```bash
node scripts/program-book-autopsy.mjs --wrangler-d1 production --remote
```

Look at **By canonical play** — unstamped Gap Reversal Long and
`tt_gap_reversal_long` must be one row.