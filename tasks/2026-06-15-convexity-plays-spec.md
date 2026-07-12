# Convexity Plays — Product Spec (2026-06-15)

Locked decisions from operator review. Replaces the retired **Day-Trade strip**
and **Options Plays of the Day** surfaces (no longer mounted on Today).

---

## Goal

Surface **lotto** and **moonshot** options plays where the model’s timing,
direction, and floor align — asymmetric payoff setups (3× lotto, 5–10× moonshot)
on names like AMD, AMAT, indices, etc.

Two UI surfaces, one server contract:

| Surface | Job |
|---|---|
| **Today → universe panel** | Scanner: one horizontal row of live convexity plays |
| **Right rail → Now (Snapshot)** | Ticker confirmation: compact panel only when *this* name aligns |

---

## Locked product decisions

| # | Decision |
|---|---|
| 1 | **One row** — single “Convexity Plays” strip in the universe panel (not separate Lotto / Moonshot rows) |
| 2 | **No suppressed list** — plays that fail gates **do not render**; no “suppressed” row, tooltip dump, or debug list in UI |
| 3 | **Lotto may fire on READY** — floor established, compression timing; motion not required yet |
| 4 | **Investor lane included** — convexity plays may surface on investor-mode tickers when fusion/timing align (LEAP stays on Options tab; lotto/moonshot are additive when trader-style timing fires on investor names) |
| 5 | **Pro gate** — same as Ready Setups (`window._ttIsPro`) |

Additional:

- **Indices included** in lotto lane (0DTE / 1DTE on SPY, QQQ, IWM, DIA when playbook + fusion align).
- **Retired surfaces** — do not remount `OptionsPlaysOfTheDay`, day-trade amber strip, or `day_trade_suppressed` UI. Backend may keep computing day-trade data for Options tab index panel until removed in a cleanup pass.

---

## Play taxonomy (engine)

| Class | DTE | Delta | Payoff | Activation bias |
|---|---|---|---|---|
| `lotto` | 0–3 (indices: 0/1 via `pickDayTradeExpiration`) | 0.10–0.20Δ OTM | Sized for 100% premium loss; 3×+ target | `READY` or early `RIDE` + compression/floor timing; direction locked |
| `moonshot` | 5–14 | 0.25–0.35Δ OTM | 5–10× target; more runway | `RIDE` + motion OR SMT-confirmed reversal path (existing `shouldActivateMoonshot`) |

Ranking within the single row: **moonshot before lotto** when both qualify; then confluence score; cap **10 cards** (mirror Ready Setups).

---

## Alignment contract (server)

`isConvexityPlayActionable(play, ctx, now) → boolean` — shared by list endpoint and per-ticker endpoint. **No `suppressed[]` in API response.**

Gates (all must pass):

1. **Profile** — `speculator` or `aggressive` (moonshot rule; lotto inherits same).
2. **Mode** — lotto: `READY` \| `RIDE` \| `DRIFT`; moonshot: `RIDE` \| `DRIFT` (+ SMT path per engine).
3. **Direction lock** — play direction = trader contract direction = timing lean (no LONG call on SHORT posture).
4. **Investor included** — do not filter out `contract.mode === "investor"`; investor-primed names in Ready Setups may show convexity when timing aligns.
5. **Floor (lotto)** — spot ≥ SL (long) or spot ≤ SL (short); compression `call_opportunity` / `put_opportunity` when mode is `READY`.
6. **Freshness** — `generated_at` within TTL: 5 min (0–1 DTE), 15 min (5–14 DTE).
7. **Strike drift** — reuse `validateDayTradeStrike` / ATR-aware cap for 0–1 DTE; 5% cap for 5–14 DTE swing moonshot.
8. **Expiration alive** — 0DTE invalid after RTH close / final-hour roll to 1DTE (existing `pickDayTradeExpiration` rules).
9. **Chain** — prefer live chain; BS estimate allowed but card shows `estimated` chip.

Failed gate → omit from response (no suppress reason exposed).

---

## API

### `GET /timed/options/convexity?limit=10`

```json
{
  "ok": true,
  "generated_at": 1718123456789,
  "plays": [
    {
      "ticker": "AMD",
      "play_class": "lotto",
      "direction": "LONG",
      "archetype": "lotto_call",
      "strike": 165,
      "expiration": { "iso": "2026-06-13", "dte": 1, "label": "Jun 13 (1DTE)" },
      "premium_mid": 1.85,
      "max_loss_usd": 185,
      "multi_bagger_targets": { "3x_underlying_at": 172.5 },
      "confluence_mode": "READY",
      "confluence_score": 58,
      "as_of_ms": 1718123456789,
      "chain_status": "live"
    }
  ]
}
```

- No `suppressed`, `day_trade_plays`, or parallel arrays.
- Pro-gated (401/403 for non-Pro).

### `GET /timed/options/ticker` (extend)

Add to existing response:

```json
{
  "convexity": {
    "actionable": true,
    "play_class": "moonshot",
    "primary": { /* compact play shape */ },
    "as_of_ms": 1718123456789
  }
}
```

When not actionable: `{ "actionable": false }` only — no reason string in API (keeps UI simple per decision #2).

---

## Today UI — universe panel

**Placement:** inside `tt-universe-panel`, after **Ready Setups**, before **Growth Ideas**.

```
READY SETUPS
────────────
CONVEXITY   ← new (sub: Lotto & moonshot ideas)
────────────
GROWTH IDEAS
────────────
TECHNICAL SETUPS
```

**Section copy:**

- Title: `CONVEXITY` — subheading `Lotto & moonshot ideas`, description in `tt-ready__sub`
- Sub: Short-dated OTM lotto & moonshot ideas when direction, floor, and timing align. Sized for asymmetric payoff — not share entries.

**Card fields:** ticker, play_class badge (LOTTO / MOONSHOT), strike + DTE, max loss, top multi-bagger target, confluence chip, as-of time.

**Empty state:** “No convexity plays aligned right now.” (empty strip, no filler)

**Click:** open rail → Now tab; scroll convexity panel into view.

**Pro locked:** same locked message pattern as Ready Setups.

---

## Right rail — Now (Snapshot) tab

**Panel title:** `Convexity Play`

**Render when:** `convexity.actionable === true` from `/timed/options/ticker` AND Snapshot trader verdict direction matches.

**Hide when:** stale TTL exceeded, direction mismatch, or gate fails — panel absent (not grayed).

**Contents (compact):**

- Play class + one-line thesis
- Strike, expiry, max loss, 2×/3× underlying targets
- Hard stop / floor line
- “Full ladder → Options tab” link

**Do not** show generic `long_call` here when moonshot/lotto inactive.

---

## Sizing

| Class | Sizing rule |
|---|---|
| Lotto | Fixed max-loss cap ($50 default; env `CONVEXITY_LOTTO_MAX_LOSS_USD`) |
| Moonshot | 40% of standard risk budget (existing `buildMoonshot`) |

Compliance line on every card: “Premium may go to zero.”

---

## Cleanup (separate PR)

- Remove dead `OptionsPlaysOfTheDay` component + CSS from `react-app/today.html`
- Stop mounting day-trade strip references in dist after frontend build
- Options tab index day-trade fetch in `shared-right-rail.js` — evaluate keep vs fold into convexity panel
- Optional: stop emitting `day_trade_suppressed` from `/timed/options/all` once no consumers remain

---

## Build order

1. `lotto_call` / `lotto_put` archetypes + `shouldActivateLotto()` in `worker/options-plays.js`
2. `isConvexityPlayActionable()` + `GET /timed/options/convexity`
3. Extend `/timed/options/ticker` with `convexity` block
4. `ConvexityPlaysStrip` in Today universe panel
5. Snapshot convexity panel in `shared-right-rail.js`
6. Ledger `play_class` on signal outcomes
7. Dead strip cleanup + `npm run build:frontend`

---

## Out of scope (v1)

- Discord/email alert channel for new convexity entries
- Auto-mirror enablement (stay OFF)
- Suppressed/debug admin endpoint
