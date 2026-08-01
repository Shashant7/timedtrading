---
name: TT Cloud Pivot Thin Slice
overview: 'Intraday short-hold family for large moves in hours: 10m 5/12 curl + 34/50 bias + 1H MTF context. Paper Queued first. Exit = 10m close through 5/12 (anti-giveback). Named tt_cloud_pivot (not ripster_*).'
todos:
  - id: detect
    content: 'tt_cloud_pivot detector — open / 10am / midday curl windows on 10m c5_12 + 34/50 + 1H MTF.'
    status: completed
  - id: paper-queue
    content: 'Paper Queued 0.1×; confirm-stack wins ties; cloud pivot preferred over momentum_continuation.'
    status: completed
  - id: exit
    content: 'Family exit — 10m close under/over 5/12 trim/exit; 34/50 MTF dual loss = full exit.'
    status: completed
  - id: surface
    content: 'Today slices + ENTRY provenance slice_family=tt_cloud_pivot.'
    status: completed
  - id: attrib
    content: 'Family attribution + tests; widen on MFE keep for holds <1 session.'
    status: completed
isProject: true
---

# TT Cloud Pivot — Intraday Thin Slice

## Why

Weekly autopsy grades rare mega weeks. Ripster-style large moves often print in
**hours** on the **10m** chart via 5/12 curls against 34/50 bias and 1H MTF
magnets. Live `ENTRY_ENGINE=tt_core` does not admit that playbook; frozen
`ripster_core` already encodes the atoms. This slice promotes them as a named
TT family: **`tt_cloud_pivot`**.

## Family contract

| Input | Role |
|-------|------|
| 10m `c5_12` crossUp/crossDn or curl bounce | Trigger |
| 10m `c34_50` bias (soft for midday flip) | Bias / risk |
| 1H `c34_50` / MTF | Magnet / structure |
| Session window: open / 10am / midday | Timing |
| Paper Queued 0.1× | No capital-scale yet |
| Exit: 10m candle loses 5/12 | Anti-giveback |

## Explicitly not

- Renaming user-facing copy to "Ripster"
- Flipping full `ENTRY_ENGINE` to `ripster_core`
- Unlocking ATH Speculative capital matrix
- Overnight swing management on this family

## Done looks like

Today shows Cloud Pivot chips; scoring stamps `_sequence_queue_proposal.family=tt_cloud_pivot`;
open trades in the family exit on 5/12 loss before swing force-exits dominate;
attribution reports MFE keep for sub-session holds.
