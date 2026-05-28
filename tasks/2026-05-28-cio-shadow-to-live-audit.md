# AI CIO: Shadow → Live Audit & Go/No-Go (2026-05-28)

## TL;DR — Recommendation

**STAY IN SHADOW MODE** for now. We do not yet have enough post-fix data to validate go-live.

Concrete next steps:

1. Leave `ai_cio_shadow_mode = true` (no change).
2. New audit endpoint `GET /timed/admin/ai-cio/go-live-readiness` returns the current state vs gates.
3. Auto-flip-back safeguard: if at any point post-go-live we trip a pathology gate (>40% fallback rate, >5s avg latency, REJECT rate > 90%, or APPROVE rate < 5%), the system snaps back to shadow and pages the operator.

Earliest realistic go-live: **+10 trading days** assuming clean data + ≥50 entry-side decisions with outcomes attributed.

---

## What we know

### Config (live as of 2026-05-28 18:30 UTC)

| key | value | last updated |
| --- | --- | --- |
| `ai_cio_enabled` | true | 2026-05-07 |
| `ai_cio_shadow_mode` | true | 2026-05-12 |
| `ai_cio_entry_model` | gpt-5.4 | 2026-05-28 |
| `ai_cio_lifecycle_model` | gpt-5.4 | 2026-05-28 |
| `ai_cio_vision_model` | gpt-4o | 2026-05-28 |
| `ai_cio_reference_enabled` | true | 2026-05-28 |
| `ai_cio_replay_enabled` | false | 2026-04-16 |

### Decision history (latest 500 rows)

| date | type | count | shadow | model |
| --- | --- | --- | --- | --- |
| 2026-03-21 | REJECT | 155 | acted | gpt-4o-mini (old) |
| 2026-03-23 | REJECT | 78 + ADJUST: 2 + STALL_PROCEED: 1 | acted | gpt-4o-mini (old) |
| 2026-05-28 | TRIM_PROCEED | 217 | shadow | gpt-5.4 (new) |
| 2026-05-28 | TRIM_OVERRIDE | 45 | shadow | gpt-5.4 (new) |
| 2026-05-28 | ADJUST (entry) | 2 | shadow | gpt-5.4 (new) |

Total entry-side decisions ever: 237 (235 in March, 2 today).

### Critical gaps

1. **65-day silent gap (3/24 → 5/27).** D1 bind-parameter overflow caused `model_config` loads to fail silently, leaving `_deepAuditConfig` empty and CIO bypassed. Fixed in PR #332.

2. **Reasoning truncation.** Until today (5/28 17:00 UTC), `max_completion_tokens` was 500 (entry) / 400 (lifecycle), which cut model reasoning mid-sentence. Any decision before this fix was operating with insufficient reasoning budget. Fixed in PR #336.

3. **0% outcome attribution on REJECTs.** When CIO rejects an entry, no trade is taken, so no outcome to attribute. We cannot directly measure "was this a good rejection?" without a counterfactual.

4. **Acted-upon ADJUST track record (March only, old model):**
   - 364 decisions, 71 W / 64 L = **52.6% WR**
   - Avg P&L: **-0.36%**
   - Avg confidence: 0.70, edge: 0.76, latency: 3.8s

   Essentially breakeven. Not a compelling case for live mode UNLESS we believe gpt-5.4 + new prompts are meaningfully better.

5. **Zero post-fix outcomes.** All 145 post-fix decisions are shadow mode lifecycle (TRIM/EXIT) which by definition don't write outcomes.

---

## Go-Live Gates

CIO is ready to flip from shadow → live when **all** of the following are true:

### A. Sample-size gates (statistical confidence)

| gate | threshold | current | met? |
| --- | --- | --- | --- |
| Entry-side decisions in last 10 trading days | ≥ 50 | 2 | ❌ |
| Lifecycle decisions (TRIM/EXIT) in last 10 trading days | ≥ 100 | 264 | ✅ |
| Outcome-attributed entries | ≥ 30 | 0 | ❌ |

### B. Quality gates (does the model behave?)

| gate | threshold | current | met? |
| --- | --- | --- | --- |
| Fallback rate (APPROVE-by-default due to API error) | < 5% | 0% | ✅ |
| Avg entry latency | < 6s | 3.2s (4 samples) | ✅ |
| Avg lifecycle latency | < 8s | 5.1s | ✅ |
| Reasoning truncation (ends with no period) | < 5% | TBD | 🟡 |
| REJECT rate on entries | 30-80% (not all-or-nothing) | 98% historical | ⚠️ |
| APPROVE rate on entries | > 5% | 1.7% historical | ⚠️ |

### C. Edge gates (does the model improve outcomes?)

| gate | threshold | current | met? |
| --- | --- | --- | --- |
| ADJUST decisions avg pnl vs no-CIO baseline | > +0.30% better | -0.36% (old model) | ❌ |
| REJECT counterfactual win rate (what would have happened) | < 45% (good rejections) | TBD (need backfill) | 🟡 |
| Disagreement-with-engine rate | 5-30% (provides signal but not pure noise) | TBD | 🟡 |

The bolded **⚠️ on REJECT rate** is the biggest concern: historically CIO rejected 98% of entries (5,188 of 5,425). That's de facto "stop trading" — basically a kill switch dressed up as a CIO. Either the system needs to entry-side score better trades to CIO, or CIO's bar for APPROVE needs to come down.

### D. Operator gates (human checks)

| gate | required | current | met? |
| --- | --- | --- | --- |
| Manual review of last 20 entry decisions (reasoning quality) | yes | not done | ❌ |
| Lifecycle-only live (TRIM/EXIT) tested first | yes | not done | ❌ |
| Auto-snapback to shadow on pathology detection | implemented | TBD | ❌ |

---

## Recommended Path

Order of operations to get to safe go-live:

### Phase 1 — Now (this PR)

1. **Build `GET /timed/admin/ai-cio/go-live-readiness`** that returns the gate table above with current values. Operator can poll any time to see status.
2. **Add backfill for outcome attribution.** Today only the entry-side ADJUST/APPROVE decisions have `trade_outcome` filled; lifecycle decisions never get attributed. Fix by joining `ai_cio_decisions` on `trades.trade_id` when status flips to WIN/LOSS/FLAT.
3. **Reduce REJECT bias in the prompt.** Update `AI_CIO_SYSTEM_PROMPT` to default-APPROVE on prime setups unless explicit risk flags are present. The current "evaluation order" puts CHART first but the REJECT examples bias the model toward refusing. Goal: bring entry REJECT rate from 98% → 50-70%.

### Phase 2 — +5 trading days

4. **Enable LIFECYCLE-ONLY live mode** (new config `ai_cio_lifecycle_enforce = true`, keep `ai_cio_shadow_mode = true` for entries). Lifecycle decisions are lower risk (you already have the position; CIO is just deciding when to trim/exit).
5. **Watch shadow entry-side accumulate.** Need ≥ 50 entry decisions before any consideration of entry-side live mode.

### Phase 3 — +10 trading days from now

6. **Re-evaluate gates.** If A + B + C + D all green, flip `ai_cio_shadow_mode = false`.
7. **First 48h on live: half-size override.** New config `ai_cio_first_48h_size_mult = 0.5` so even if CIO mis-fires, account impact is bounded.

### Phase 4 — first month live

8. **Auto-snapback** triggers if any pathology gate goes red. Operator must explicitly re-flip after investigation.
9. **Weekly accuracy report** auto-emailed to operator (uses new audit endpoint).
10. **A/B mode** (optional): half of trades get CIO enforcement, half don't, compare PnL distributions monthly.

---

## What changes in this PR

- New endpoint `GET /timed/admin/ai-cio/go-live-readiness` (public-admin behind API key) returning the gate table + boolean `ready_for_live`.
- New endpoint `POST /timed/admin/ai-cio/backfill-outcomes` (admin-only) that joins `ai_cio_decisions` with `trades` on `trade_id` and fills `trade_outcome` + `trade_pnl_pct` where missing.
- Documentation: this file.
- **No config flip.** Shadow mode stays on.

## What does NOT change

- `ai_cio_shadow_mode = true` (unchanged)
- `ai_cio_enabled = true` (unchanged)
- All models (entry/lifecycle/vision) unchanged
- All prompts unchanged

Prompt rebalancing (Phase 1 step 3 above) is intentionally deferred to a separate PR so this one stays scoped to "what's the readiness picture" + tooling, not "let's also redesign the prompts".
