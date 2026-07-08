# Options Shadow Mode — calibration lane

## Goal

Shadow long call / long put plays on trader + investor entry signals. Labeled
**SHADOW** in Discord/email — not model equity guidance. Grade via Signal
Outcome Ledger (`desk: "shadow"`) before routing to IBKR bridge.

## Enable (tt-engine / main worker)

```toml
OPTIONS_SHADOW_MODE = "1"
OPTIONS_SHADOW_PROFILE = "aggressive"   # conservative | moderate | aggressive | speculator
OPTIONS_SHADOW_FETCH_CHAIN = "1"      # Alpaca chain when cache missing (default on)
OPTIONS_SHADOW_DELTA_FLEX = "0.10"    # reserved for chain leg matching
OPTIONS_ACCOUNT_VALUE = "100000"      # sizing (existing)
```

## Pricing sources (today)

| Source | Chains / quotes | Execution |
|--------|-----------------|-----------|
| **Alpaca** | Primary — `GET /v1beta1/options/snapshots/{sym}` (OPRA feed if paid) | Equity + options paper/live |
| **IBKR bridge** | Snapshot quotes via Client Portal (not wired for options chain yet) | Options LMT/MKT live |
| **Webull bridge** | Not implemented — equity only | Equity MARKET |
| **TwelveData** | Fallback, often 404 | N/A |

Shadow mode fetches Alpaca chain on entry when `OPTIONS_SHADOW_FETCH_CHAIN=1`.

## Limit orders

Wide bid/ask (spread ≥ 15% of mid): shadow embed suggests **bid + 25% of spread**
for debit buys — do not market. Tighter spreads: mid limit.

IBKR auto-mirror already uses LMT at premium mid (`playToIbkrOrder`).

## Phases

1. **Done (this PR)** — shadow embed + ledger + env gate
2. **Next** — enable options vehicles in MC; `maybeAutoMirror` with shadow grading
3. **Later** — Webull options adapter; IBKR chain quote endpoint; DTE flex on exp pick
