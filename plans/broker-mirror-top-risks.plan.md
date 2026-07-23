# Broker mirror top-risks hardening

Address the five risks from the E2E journey audit (feed → research → score → entry → manage → exit → bridge).

## Scope

1. **Trader TRIM → bridge** — `trimTradeToPct` calls `forwardOrderToBridge` with `side: "trim"`, qty = trim delta, stable `client_order_id`.
2. **Async mirror visibility** — wrap bridge forwards so rejects/`fetch_error`/skips land in `recordSilentFailure` (+ console); optional Discord only on hard rejects.
3. **Role-split / binding guards** — sanity-sweep checks: dual-exec flags, `BROKER_BRIDGE` binding present on engine/monolith when URL set.
4. **Entry vehicle skip clarity** — when entry skips equity mirror (`options`/`letf`/missing env), stamp silent-failure or ring skip with explicit reason (not silent no-op).
5. **Freshness vs hard exits** — `__candle_data_stale` must not block SL / feed hard-close / hard-loss paths; still defer soft trims/exits.

## Out of scope

- Enabling investor mirror by default
- Changing bridge preflight caps
- Making bridge await/block model ledger writes
