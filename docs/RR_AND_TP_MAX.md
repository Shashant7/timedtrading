# RR Calculation and TP Max

## Are we using TP Max for RR?

**Yes.** The worker uses **TP Max** for the RR (reward/risk) calculation in entry and replay.

### Where RR is computed

- **`computeRR(d)`** (worker) — used for `payload.rr` on ingest and replay:
  1. Uses **`d.tp_max_price`** if present (derived when we normalize payload).
  2. Else **`d.tp_target_price`**.
  3. Else **`d.tp`** (Pine’s first target, TP1).
  4. If **`d.tp_levels`** exists and is non-empty, **overwrites** with **max of `tp_levels`** (LONG) or **min** (SHORT) — i.e. **TP Max**.

So whenever the trail payload has `tp_levels` (as sent by TimedTrading_ScoreEngine_Enhanced.pine), RR is **gain/risk** where **gain** is the distance from entry to **TP Max**, not TP1.

- **`computeRRAtTrigger(d)`** — used for alert evaluation: same idea, uses **max of `tp_levels`** when present (TP Max for LONG).

### What Pine sends

- **`tp`** = first target (TP1), for backward compatibility.
- **`tp_levels`** = array of TP levels (with metadata when built). When present, the worker uses the **max** (LONG) or **min** (SHORT) of these prices as TP Max for RR.

---

## Why RR can still be low (e.g. 0.08, 0.22)

RR = **gain / risk**:

- **gain** = distance from entry (trigger_price) to **TP Max**.
- **risk** = distance from entry to **SL** (stop loss).

So RR is low when:

1. **Risk is large** — SL is far from entry. Even with TP Max, if the stop is very wide, RR drops (e.g. risk = $5, gain = $1 → RR = 0.2).
2. **TP Max is missing in the payload** — e.g. `tp_levels` empty or not stored in D1. Then we fall back to **`tp`** (TP1), so gain is smaller and RR is lower.
3. **TP Max is close to entry** — e.g. only one TP level near price; then gain is small and RR is low.

In the replay analysis (AMD, BE, etc.), the most likely cause is **(1)**: **wide stops** relative to the distance to TP Max. So we *are* using TP Max, but the **risk** (entry − SL) is large, so RR stays below the 1.2 minimum.

### What to check

- For a given bar, compare:
  - **Risk** = `|trigger_price − sl|`
  - **Gain** = `|tp_max − trigger_price|` (LONG)
- If risk is several times larger than gain, RR will be &lt; 1 even with TP Max.

### Optional improvements

1. **Store `tp_max_price` when writing to D1** — Derive TP Max from `tp_levels` (or payload) when inserting into `timed_trail` and add it to `payload_json` so replay always has an explicit TP Max and never silently falls back to TP1.
2. **Debug output** — In replay/debug, log which TP was used (tp_max vs fallback) and the raw **risk** and **gain** so you can see why RR is low.
