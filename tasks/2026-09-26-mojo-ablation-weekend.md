# Mojo weekend — ablation + preprod parity (2026-09-26)

Goal: prove what the model actually needs — raw technicals vs list/research
influence vs universe noise — with preprod replay that matches live gates.

Operator thesis: FSD / TT_SELECTED / Upticks oversize conviction; ~300 tickers
drown valid setups; need confidence before more users.

---

## 0. Parity gate (do this first — blocked without it)

Live vs preprod `model_config` (sampled 2026-09-26): **preprod was missing
`deep_audit_focus_tier_enabled` and tier floors** that live has ON. Replay
defaults those to OFF → different admit path than live.

```bash
# 1) Deploy this branch to preprod
npm run deploy:preprod   # or wrangler deploy --env=preprod

# 2) Sync live config → preprod (skip side-effect keys)
TIMED_API_KEY=$TIMED_TRADING_API_KEY \
  node scripts/sync-model-config-to-preprod.mjs

# 3) Confirm focus tier + new ablation keys exist on preprod
curl -s -H "X-API-Key: $TIMED_TRADING_API_KEY" \
  "$PRE/timed/admin/model-config?prefix=deep_audit_focus" | jq '.items[].key'

# Expect: focus_tier_enabled=true, floors 110/80/75, min_conviction=70,
# and deep_audit_focus_bonus_* keys present (set per arm below).

# 4) Clear replay lock
curl -s -X DELETE -H "X-API-Key: $TIMED_TRADING_API_KEY" \
  "$PRE/timed/admin/replay-lock"
```

Known irreducible gaps (document in every arm report, do not pretend zero):

| Gap | Effect |
|---|---|
| Bar-close SL vs live */5 ticks | Wick rules look like no-ops |
| Instant paper fill | No broker rejects / sizing |
| Wall-clock news / Upticks KV | Look-ahead if forced ON in historical months |
| Cadence 30m default vs live 5m | Density; run 5m only on ≤10 tickers |

---

## 1. Ablation knobs (shipped this branch)

In `worker/focus-tier.js` → `resolveFocusBonusPolicy`:

| Key | Default live | Default replay |
|---|---|---|
| `deep_audit_focus_bonus_tt_selected` | true (+15) | true |
| `deep_audit_focus_bonus_upticks` | true (+10) | **false** |
| `deep_audit_focus_bonus_granny` | true (+10) | **false** |
| `deep_audit_focus_bonus_context` | true (±18) | true |
| `deep_audit_focus_bonus_recent_winner` | true (+5) | true |

Theme / FSD rank tilt (separate): `cro_theme_rank_boost_enabled` (already exists).

Flip per arm with SQL on preprod `model_config` — never `config_override` in body.
Keys are on `REPLAY_DA_KEYS`.

---

## 2. Arm matrix (equal scope)

**Window:** 2026-07-01 → 2026-07-31 (then Aug if July is decisive).  
**Cadence:** 30m, `ticker-batch` ≥ ticker count.  
**Cash:** $100k paper. Judge **realized $** only; split `replay_end_close`.

### Universe sets (reuse across arms)

| Set | Tickers | Why |
|---|---|---|
| `U24` | 24 liquid names from recent ST actives + indices | Capacity-safe baseline |
| `U_TT` | `TT_SELECTED_DEFAULT` only (~curated) | List-universe hypothesis |
| `U_RAND24` | 24 random from full SECTOR_MAP (fixed seed) | Noise control |
| `U48` | U24 ∪ 24 more high-liquidity | Density stress (may need 10m→batch cut) |

Pin the exact ticker CSV in each run's label; do not change mid-weekend.

### Influence arms (all on `U24` first)

| Arm | Config delta | Question |
|---|---|---|
| `A0-tech` | all `focus_bonus_*=false`, `cro_theme_rank_boost_enabled=false` | Pure technical conviction |
| `A1-tt` | A0 + `tt_selected=true` only | Does curation list earn its +15? |
| `A2-lists` | A1 + upticks+granny=true (accept KV look-ahead) | Live list stack |
| `A3-theme` | A1 + theme tilt ON | FSD theme rank nudge |
| `A4-full` | live-like: all bonuses ON + theme ON | Closest to production |

### Universe arms (config = `A0-tech` or winner of influence)

| Arm | Universe | Question |
|---|---|---|
| `B0-u24` | U24 | Control |
| `B1-utt` | U_TT | Curated-only book |
| `B2-rand` | U_RAND24 | Same size, uncurated |
| `B3-u48` | U48 | Does doubling drown quality? |

---

## 3. How to run one arm

```bash
export API_BASE=https://timed-trading-ingest-preprod.shashant.workers.dev
export TIMED_API_KEY=$TIMED_TRADING_API_KEY

# Example: A0-tech
# UPDATE model_config SET config_value='false' WHERE config_key LIKE 'deep_audit_focus_bonus_%';
# UPDATE model_config SET config_value='false' WHERE config_key='cro_theme_rank_boost_enabled';
# (use admin API POST if easier)

TIMED_API_KEY=$TIMED_TRADING_API_KEY scripts/monthly-slice.sh \
  --month=2026-07 \
  --run-id=mojo-a0-tech-u24-jul26 \
  --label=mojo-a0-tech-u24 \
  --tickers="$U24_CSV" \
  --ticker-batch=24 \
  --interval-minutes=30 \
  --api-base=$API_BASE
```

Read:

```sql
SELECT run_id,
       COUNT(*) trades,
       ROUND(SUM(CASE WHEN exit_reason='replay_end_close' THEN 0 ELSE pnl END),0) realized_usd,
       ROUND(SUM(CASE WHEN exit_reason='replay_end_close' THEN pnl ELSE 0 END),0) open_mark_usd
  FROM backtest_run_trades
 WHERE run_id LIKE 'mojo-%'
 GROUP BY run_id;
```

Also diff trade sets arm-vs-arm (path-dependence cascade) per `skills/backtest-replay.md` §5.

---

## 4. Success criteria (promotion bar)

1. **Parity:** preprod focus-tier keys match live; ablation keys load (log / entry stamp `bonus_policy`).
2. **Influence:** if `A0-tech` realized ≥ `A4-full` (or A4 only wins via list-padded weak HTF entries), lists are oversized — cut live bonuses or require technical floor before list points count.
3. **Universe:** if `B2-rand` ≈ `B0-u24` and `B1-utt` wins, curation is the edge and 300-name scan is noise. If `B3-u48` collapses vs B0, density/caps are the bug.
4. **No ship** of list cuts or universe shrink without equal-scope Jul+Aug and trade-set diffs.

---

## 5. Live evidence already pointing at oversized lists

`GET /timed/admin/entry-explain?ticker=GEV` (2026-09-26): rank **45**,
`HTF_BEAR_LTF_PULLBACK`, conviction **83** with +35 from TT+Upticks+Granny.
Floor 70 — lists alone can clear the gate.

---

## 6. Out of scope this weekend (park)

- TD 1+volume → ride to 9 (new entry path; design after A0 baseline)
- GEV force-close / stale TP_HIT_TRIM repair (ops, not ablation)
- Broker fill fidelity
- Investor FSD floor A/B (separate lane)

---

## 7. Checklist

- [ ] Deploy branch to preprod
- [ ] Sync model_config live → preprod; verify focus_tier_enabled
- [ ] Backfill candles for U24/U48/U_TT/U_RAND for Jul (+ warm-up)
- [ ] Run A0 → A4 on U24
- [ ] Pick influence winner; run B0–B3
- [ ] Write realized-$ table + trade-set diffs into this file
- [ ] Recommend live knob changes (or "lists stay, technical floor hardens")
