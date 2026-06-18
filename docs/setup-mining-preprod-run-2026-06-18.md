# Setup Sequence Mining — Preprod Execution (2026-06-18)

**Command:**

```bash
TIMED_API_BASE=https://timed-trading-ingest-preprod.shashant.workers.dev \
  node scripts/mine-setup-sequences.mjs \
  --wrangler-d1 preprod \
  --tickers JCI,EXPE,DCI,KWEB,AXON,STRL \
  --limit 6 \
  --pre-entry-hours 72 \
  --out-dir data/setup-mining/preprod-july1
```

**Artifacts:** `data/setup-mining/preprod-july1/summary.{json,md}`

---

## Environment findings

| Check | Preprod | Production |
|---|---|---|
| `timed_trail.payload_json` rows | **0** | **0** (Phase-I purge) |
| `timed_trail` scalar rows (`flags_json`, price, state) | Yes (Jul 2025 – Jun 2026 for some tickers) | Yes (recent ~3-day retention) |
| Live closed trades (`--live`) | 0 | 0 |
| D1 closed trades (replay lane) | 56 (WIN/LOSS status) | 587 archived |

Mining cannot use full `payload_json` snapshots until ingest resumes writing them.
The execution used **`--wrangler-d1 preprod`** plus a new **`trail_scalars`**
snapshot builder (`flags_json` → PDZ/FVG fields).

---

## Results (6 tickers with Jul 1 2025 trail overlap)

| Metric | Value |
|---|---|
| Trades analyzed | 6 |
| Trades with pre-entry trail window | 5 |
| Trades with derived events (2 each) | 5 |
| Trades with active mean-reversion sequence | **0** |
| Baseline win rate | 33.3% (2W / 4L) |

### Why zero sequences

1. **Scalar trail is incomplete** — no TD sequential, phase, RSI, or EMA stacks in
   `flags_json`; only PDZ/FVG/squeeze/compression flags.
2. **Contiguous stage gate** — derived events are mostly static PDZ/FVG snapshots
   (no stage-1 exhaustion atoms), so the sequence detector never advances past
   stage 0.
3. **Zone mismatch** — Jul 1 sample tickers were in `premium_approach` while LONG
   mean-reversion location stage expects discount-family zones.

---

## Implications

- The mining **pipeline executes end-to-end** (trades → trail → events → join).
- **Reliability tables for stage 5–7 long sequences require `payload_json` backfill**
  or fresh scoring snapshots with full `tf_tech` / `td_sequential`.
- Until then, use `GET /timed/admin/setup-diagnostics` (after deploy) on tickers
  with `timed:latest` for point-in-time shadow sequence state.

---

## Next operator steps

1. Re-enable / backfill `timed_trail.payload_json` for a fixture ticker set.
2. Re-run mining on the same Jul 2025 preprod trades after backfill.
3. Compare stage ≥5 sequence win rate vs the 33% baseline on the Jul 1 cohort.
