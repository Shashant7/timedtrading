# Journey UX + Sequence Shadow Handoff — 2026-06-23

Agent handoff for recent merges (Jun 21–23). Read this before touching
right rail, Active Trader kanban, or Investor bubble map.

---

## Right rail IA (PR #824: `cursor/rail-sequence-options-ux-0b66` — rebased on main after #823)

### Top-level tabs (5 groups)

| Pill | Internal `railTab` | Notes |
|------|-------------------|-------|
| Now | `SNAPSHOT` | Verdict-first snapshot |
| Trade | `SETUP` | Setup-only — **no Options sub-tab** |
| Options | `OPTIONS` | Promoted to own primary pill (was Trade sub-tab) |
| Invest | `INVESTOR` | Lane guidance |
| Context | `TECHNICALS` / `FUNDAMENTALS` / `CATALYSTS` / `HISTORY` | Sub-pills unchanged |

Deep links `?railTab=OPTIONS` still work. `RAIL_TAB_GROUP_OF` maps
`OPTIONS → "OPTIONS"` (not `"TRADE"`).

### Trade tab panel order (top → bottom)

1. Entry Decision (open position + model conflict hero)
2. Timing — Extension / Compression watch
3. Setup name / grade (when present)
4. Trade Plan / Model Plan / Position Plan
5. Reference Levels
6. Profile
7. Sector & Market
8. **Sequence (shadow)** — **last**; admin-gated (`window._ttIsAdmin`)

### Sequence panel dedupe (Trade tab)

On **Trade / Setup** the panel uses `compact` mode:

- Header: SHADOW badge only (posture / S-stage / archetype moved into primary card)
- No intro paragraph (Snapshot tab keeps full copy)
- VIX / Index / snap count / Confirm gates → collapsible **Context & diagnostics**
- Stage journey: dot bar + one-line "Next:" — checklist of completed stages hidden
- `seq.posture` and path forecast hidden (duplicate Entry Decision / header tags)

Snapshot tab still renders `{renderSequenceShadowPanel()}` with full detail.

**Files:** `react-app/shared-right-rail.js` → `npm run build:frontend`.

---

## Active Trader kanban (PRs #819–#820)

### Four DOING lanes (Exiting removed)

| Lane | Rule |
|------|------|
| Holding | Open runner, not defending, not trimmed today |
| Defending | Engine `exit` / `exiting` stage on open runners |
| Trimming | `trimmed_pct > 0` **and** `trim_ts` within local calendar day |
| Closed | Exited today |

`tradeTrimmedToday()` in `react-app/active-trader.html` — GS/SNDK bug was
runners with historical trim landing in Trimming without a trim **today**.

### Language

- Use "Holding / Defending / Trimming / Closed" — not "Exiting"
- Narratives on defend/trim cards are intentional (operator OK)

---

## Investor UX (PRs #821–#823)

### Kanban band order

**DOING above WATCHING** in `react-app/investor-panel.js`. If UI looks
stale after merge, run full `npm run build:frontend` — partial compiles
leave old `?v=` on `investor-panel.js` (immutable cache).

### Bubble map lane filters

Chips: On Radar, Queued, Hold & Watch, Core Hold, Open Positions,
TT Selected, Reducing. `InvBubbleMap` + `passesInvestorBubbleMapFilter()`.

---

## System health check — 2026-06-23 ~23:52 UTC

Source: `GET https://timed-trading-ingest.shashant.workers.dev/timed/health`

| Signal | Status | Detail |
|--------|--------|--------|
| Worker | OK | `ok: true` |
| Scoring | OK | Last run ~4.7 min ago; 244 core + 15 user-added |
| Price feed | OK | `pricesAgeSec: 28`, `staleSymbolCount: 0` |
| Candle SLO | OK | 292/292 fresh on intraday TFs; `slo_ok: true` |
| Monthly candles | Expected | Worst `M` age ~33k min (GEV) — monthly bar, not RTH |
| Cron | Minor | 1 failure tracked: `intraday_flash` |
| Session | After hours | `nyRthOpen: false`, ET 2026-06-23 |
| Engine split | OK | `engineExternal: true`, role `monolith` |

`/timed/all` timed out from cloud agent (15s) — use health + single-ticker
routes for smoke; full assembly is heavy.

---

## Sequence pattern → live flip readiness

**Current state: shadow only.** Do not set `SEQUENCE_ENTRY_GATE=1` until
forward shadow validates aligned capture (`tasks/todo.md`).

### What is collecting

| Layer | Flag / route | Purpose |
|-------|--------------|---------|
| Trail snapshots | `SETUP_TRAIL_SNAPSHOT=1` (preprod / tt-engine) | `timed_trail.payload_json` pairs for event re-derive |
| Setup events | `SETUP_EVENTS_WRITE` | D1 `setup_events` rows |
| Scoring stamp | `SETUP_SHADOW_STAMP` | `setup_sequences` + `setup_shadow_posture` on KV payload |
| Gate shadow | `SETUP_GATE_SHADOW=1` (preprod + tt-engine) | `stack_full_confirm`, `gate_runway_full` in diagnostics |
| Admin UI | `GET /timed/admin/setup-diagnostics` | Right-rail Sequence panel |
| Parity gate | `/timed/admin/setup-parity-gate` | Live events vs re-derived from trail pairs |

### Tier A+B replay verdict (2026-06-21)

- 211 moves, 96% sequence yield, 65% alignment on missed moves
- Dominant archetype: `td_phase_mean_reversion_long` @ forming (S1–4)
- **Blocker for live:** only 16% of live captures had sequence at entry;
  need prod fixture **trail pair depth** + forward shadow pass
- Docs: `docs/setup-mining-tier-ab-verdict-2026-06-21.md`,
  `docs/setup-mining-gate-timing-shadow-2026-06-22.md`

### Gaps before flipping live

1. `SETUP_TRAIL_SNAPSHOT=1` on production tt-engine (verify wrangler vars)
2. Two consecutive */5 trail rows per Tier-A fixture ticker for parity gate
3. Forward shadow: Confirm/Runway gates firing on aligned fixtures
4. Operator sign-off on 65% alignment vs false-positive cost on MR-long @ S1–4

---

## Build / deploy reminders

- Always **`npm run build:frontend`** after `shared-right-rail.js` or
  shared JS changes — never partial compile + commit
- CI `check-dist` fails if source/dist drift
- Pages serves `react-app-dist/` — push to `main` for UI deploy

---

## Related PRs (merged unless noted)

| PR | Topic |
|----|-------|
| #819–#820 | AT kanban 4 lanes + trim-today semantics |
| #821–#822 | Investor DOING-first + cache bust |
| #823 | Investor bubble map filters |
| pending | Right rail: Sequence last, Options tab, dedupe |
