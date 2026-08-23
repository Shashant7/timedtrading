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
| `restricted` | Admission matrix only (wildcard ON). ATH, N-test, ATL, index swing. |
| `paused` | Hard reject at qualify. Range reversal long/short. |

Admission used to no-op when grade was empty (`missing_inputs_default_allow`).
`deep_audit_ja_grade_wildcard` now defaults **true** in
`worker/pipeline/tt-core-entry.js` so ATH / N-test / range rows actually
apply. Opt out with `false`.

Cloud Pivot exits do **not** manage a canonical core `entry_path` even
when a paper family stamp is coincident.

## Verify

```bash
npx vitest run worker/foundation/play-catalog.test.js worker/foundation/tt-cloud-pivot.test.js worker/pipeline/tt-core-entry.js worker/july-autopsy-gates.test.js
```

Re-read the book with one play key:

```bash
node scripts/program-book-autopsy.mjs --wrangler-d1 production --remote
```

Look at **By canonical play** — unstamped Gap Reversal Long and
`tt_gap_reversal_long` must be one row.