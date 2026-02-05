# Kanban System & Trade Execution

Quick reference for the dual-mode Kanban system, 3-tier TP logic, and exit/trim rules.

---

## Terminology

- **Score** (0-100): Composite quality from `computeRank()`. Higher = better setup. Stored as `rank` in DB; exposed as `score` in API.
- **Position** (1-based): Ordinal after sorting by score. 1 = best in watchlist.
- **D1 positions**: Source of truth for open positions (stop_loss, take_profit, entry_price).

---

## Dual-Mode Kanban System

The Kanban system operates in two modes based on whether a position is open:

```
DISCOVERY MODE (no position)          MANAGEMENT MODE (position open)
┌─────────┐                           ┌─────────┐
│  WATCH  │ ─► Monitoring setup       │  ACTIVE │ ─► Position healthy
└────┬────┘                           └────┬────┘
     │                                     │
     ▼                                     ▼
┌─────────┐                           ┌─────────┐
│  SETUP  │ ─► Pullback forming       │  TRIM   │ ─► Take partial profit
└────┬────┘                           └────┬────┘
     │                                     │
     ▼                                     ▼
┌─────────┐                           ┌─────────┐
│  ENTER  │ ─► Ready to buy           │  EXIT   │ ─► Close position
└─────────┘                           └─────────┘
```

### DISCOVERY Mode (No Open Position)

| Stage | Meaning | Trigger |
|-------|---------|---------|
| **WATCH** | Monitoring ticker | In watchlist, not yet actionable |
| **SETUP** | Pullback forming | PULLBACK state, in corridor, waiting for momentum |
| **ENTER** | Ready to buy | Momentum confirmed, entry gates passed |

### MANAGEMENT Mode (Position Open)

| Stage | Meaning | Trigger |
|-------|---------|---------|
| **ACTIVE** | Position healthy | Holding, no trim/exit signals |
| **TRIM** | Take partial profit | Completion >= 60%, or P&L >= +5% |
| **EXIT** | Close position | SL breach, P&L <= -8%, or critical signal |

---

## 3-Tier Take Profit System

Positions use a 3-tier TP system that automatically trims and adjusts the trailing SL:

| Tier | ATR Multiplier | Trim % | Cumulative | SL Adjustment |
|------|---------------|--------|------------|---------------|
| **TRIM** | 0.5x - 1.0x | 60% | 60% | SL moves to breakeven (entry) |
| **EXIT** | 1.0x - 1.618x | 20% | 80% | SL moves to TRIM TP price |
| **RUNNER** | 1.618x - 3.0x | 20% | 100% | Trade closed (TP_FULL) |

### Example Flow

```
Entry at $100, SL at $95, TRIM TP at $105, EXIT TP at $108, RUNNER TP at $115

1. Price hits $105 → Trim 60%, SL moves to $100 (breakeven)
2. Price hits $108 → Trim 20% more (80% total), SL moves to $105
3. Price hits $115 → Close final 20%, trade complete (TP_FULL, WIN)
```

### Key Protection

As each TP tier is hit, the SL tightens to lock in profits. Even if RUNNER isn't hit, gains from trimmed portions are secured.

---

## Exit Triggers

| Trigger | Condition | Action |
|---------|-----------|--------|
| **SL Breach** | Price <= SL (long) or >= SL (short) | EXIT, status = LOSS |
| **P&L -8%** | Open P&L <= -8% | EXIT, status = LOSS |
| **TP_FULL** | All 3 TP tiers hit | EXIT, status = WIN |
| **Critical Signal** | `computeMoveStatus` returns CRITICAL | EXIT |
| **Left Corridor** | Price exits entry corridor | EXIT |

---

## Trim Triggers

| Trigger | Condition | Action |
|---------|-----------|--------|
| **Completion >= 60%** | Move is 60%+ complete | TRIM stage |
| **P&L +5%** | Open P&L >= +5% | TRIM stage |
| **Phase 65% + WARNING** | High phase with warning severity | TRIM stage |
| **Adverse Move Warning** | >= 5% adverse move | TRIM stage |

---

## Entry Gates (ENTER Stage)

To reach ENTER stage, a ticker must pass these gates:

| Gate | Default | Momentum Elite |
|------|---------|----------------|
| **Score** | >= 70 | >= 60 |
| **RR** | >= 1.2 | >= 1.0 |
| **Completion** | <= 50% | <= 60% |
| **Phase** | <= 65% | <= 70% |
| **In Corridor** | Required | Required |

### Enter Paths (score + signal required)

1. **Top Tier + Corridor**: (score >= 75 OR position <= 20) AND in_corridor
2. **Thesis / Momentum Elite**: (thesis_match OR momentum_elite) AND score >= 60
3. **Strong HTF/LTF**: htfAbs >= 40 AND ltfAbs >= 20 AND score >= 70
4. **Corridor + Squeeze**: in_corridor AND sq30_release AND score >= 70
5. **1H 13/48 EMA Cross**: in_corridor AND ema_cross_1h_13_48 AND score >= 68

---

## Position Limits

| Limit | Value | Purpose |
|-------|-------|---------|
| **MAX_OPEN_POSITIONS** | 15 | Capital allocation |
| **MAX_DAILY_ENTRIES** | 8 | Prevent overtrading |

---

## D1 Position Fields

The `positions` table stores:

| Field | Purpose |
|-------|---------|
| `stop_loss` | Current trailing SL (updated as TP tiers hit) |
| `take_profit` | Initial TP target |
| `entry_price` | Position entry price |
| `total_qty` | Current quantity (decreases on trims) |
| `status` | OPEN or CLOSED |

---

## Discord Alerts

Alerts fire on stage transitions:

| Stage | Alert Type | When |
|-------|------------|------|
| **ENTER** | KANBAN_ENTER | Ticker meets entry gates |
| **ACTIVE** | KANBAN_HOLD | Position opened, healthy |
| **TRIM** | KANBAN_TRIM | Trim trigger hit |
| **EXIT** | KANBAN_EXIT | Exit trigger hit |

- **Deduplication**: One alert per ticker per stage per 15-minute bucket
- **Lifecycle gate**: ACTIVE/TRIM/EXIT require prior ENTER in same cycle

---

## Quick Reference

```
Position open?
├── NO (DISCOVERY)
│   └── WATCH → SETUP → ENTER
│
└── YES (MANAGEMENT)
    ├── Check SL breach → EXIT
    ├── Check P&L <= -8% → EXIT
    ├── Check P&L >= +5% → TRIM
    ├── Check completion >= 60% → TRIM
    └── Otherwise → ACTIVE
```

---

## Admin Commands

### Replay Day
```bash
DATE=2026-02-02 CLEAN_SLATE=1 TIMED_API_KEY=x node scripts/replay-day.js
```

### Reset + Replay from Start
```bash
FROM=2026-02-02 TIMED_API_KEY=x node scripts/reset-and-replay-from-start.js
```

### Reset Only (No Replay)
```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/reset?key=KEY&resetLedger=1"
```
