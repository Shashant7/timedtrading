# UI Refresh — Today 3-tier + Rail 4-group + Chart bounty (2026-06-10)

Operator feedback on the redesign plan (Today → 3-tier morning read; rail
9 tabs → 4 groups; Verda restyle):

> I don't want to lose the bubble map and some of the informative
> sections: macro events, earnings and movers. We don't need squeeze nor
> RR. The market pulse should also be retained. Regarding the Right
> Rail, options and fundamentals should be retained. The chart also is
> necessary to provide context. (Bug bounty: the chart flickers and can
> be smoother and more informative with clear levels and autoscaling and
> annotations)

## Decisions (locked by the feedback)

### Today page (`react-app/today.html`)

New order — 3-tier morning read first, retained sections after,
everything else progressive disclosure:

1. **Tier 1** — StatusHeader + new regime one-liner (session pill ·
   daily regime · HMM latent · breadth · SPY/VIX chips). Replaces the
   QuickGlance card (its regime/HMM/top-mover tiles fold into this
   line; top mover already lives in the Movers strip).
2. **Tier 2** — Daily Brief hero (BriefPreview | Research Desk).
3. **Tier 3** — Open Positions strip.
4. **Market Pulse** tiles (RETAINED, full row).
5. **Cross-asset + sectors** strip (`MacroStrip`, brief-gated).
6. **Macro events** strip (RETAINED).
7. **Earnings** strip (RETAINED).
8. **Entry Zone** strip (kept — actionable; not flagged for removal).
   HIGH R:R and SQUEEZE strips REMOVED per feedback.
9. **Top Movers** RTH/EXT strips (RETAINED).
10. *Disclosure (collapsed, localStorage-persisted):* Day-Trade Game
    Plan, Options Plays of the Day.
11. **Analysis zone** — filter chips + **Bubble Map + Viewport split**
    (RETAINED as the centerpiece).
12. *Disclosure (collapsed):* Universe Heat Map (redundant w/ bubble map).
13. End CTA.

Removals: `high_rr_early` + `squeeze` filter chips, RR/SQ chips on
viewport cards, dead components (`IndexPredictionsStrip`,
`BriefIndexCard`, `BriefIndexRowCompact`, grid-mode FocusRail render).

Verda restyle (per `skills/verda-ui-migration.md`): Verda tokens enter
through a marked VERDA section in `tt-tokens.css` (`--vf-*` custom
properties only — no second stylesheet). today.html migrates by
re-pointing its page-local `--tt-*`/`--ds-*` token values at the Verda
palette (Ink/Bark/Moss/Cream/Sage, mint accent) + Manrope display
headings. Data semantics keep `--tt-up/--tt-dn` greens/reds and mono
numerals (mint is the CTA accent, never "price up"). No `vf-*`
component classes are mixed into the page — the page keeps its local
classes, retoken'd. Shared rail inherits the page-level `--ds-*`
overrides automatically; rail component classes migrate LAST per the
skill.

### Right rail (`react-app/shared-right-rail.js`)

9 tabs → **4 groups** with sub-tabs. Internal `railTab` keys are
UNCHANGED so every data gate, deep link (`?railTab=OPTIONS`) and
`initialRailTab` keeps working:

| Group | Sub-tabs (railTab keys) |
|---|---|
| **Now** | SNAPSHOT |
| **Trade** | SETUP, OPTIONS (RETAINED) |
| **Invest** | INVESTOR |
| **Context** | TECHNICALS, FUNDAMENTALS (RETAINED), CATALYSTS, HISTORY |

- Mobile keeps the CHART tab as a 5th pill (workspace mode hides it —
  the persistent left-pane chart is the desktop chart, RETAINED).
- Snapshot becomes **verdict-first**: hero Trader Model verdict renders
  before the portfolio cards.
- Group pill remembers the last sub-tab visited per group.

### Chart bounty (flicker + informativeness)

1. **No double-mount**: left-pane chart block skips rendering while the
   mobile CHART tab is active (was two live LWChart instances).
2. **Last-bar fast path**: when only the forming bar changed,
   `series.update(bar)` instead of full `setData()` (the per-tick
   full-redraw was the main remaining flicker during RTH).
3. **Persistent overlay series**: EMA/ST series are created once and
   `setData`'d on refresh; removed only when toggled off (was full
   remove/re-add per update).
4. **Marker signature guard** — `setMarkers` only when content changes.
5. **Price-line diffing**: PRICE-LINES effect now diffs by key
   (price|title|color|style) and only removes/adds the delta (tab
   switches no longer flash all lines).
6. **Clear levels by default**: canonical S/R levels (ticker-scenario)
   default ON, deduped against SL/TP/Entry lines (±0.15%), capped at 3
   support + 3 resistance; "Lvls" toggle chip in the chart header.
7. **Autoscale affordance**: "Fit" chip re-enables autoScale +
   fitContent after manual zoom/pan (double-click on axis still works).

## Out of scope (this PR)

- Verda migration of other journey pages (page-by-page per skill).
- Rail component-class restyle (shared components migrate LAST).
- Worker decomposition (separate PR — tt-feed extraction per
  `tasks/2026-06-09-full-system-review.md` §R1/P2).
