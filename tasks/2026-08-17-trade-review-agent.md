# Trade Review Agent

Operator brief (2026-08-17): an independent body that reviews every trade
action — Entry, Trim, Exit — grades it, analyses the price action, and
feeds validated findings back into the model.

## Contract

1. **Per-leg, evolving.** Every leg the model executes (ENTRY, each TRIM,
   EXIT) gets its own review row. Reviews accrete as the trade evolves;
   the entry review can be re-run later once the move has played out.
2. **Independent.** The reviewer does NOT see the engine's own
   justification as ground truth. It gets the tape, the levels, the
   deterministic capture math, and the engine's claim — and grades the
   claim.
3. **Entry reviews** answer: is the trade valid, is the stop valid, is
   the target valid, what is the probability of success, and what are
   the specific ways this fails.
4. **Trim/Exit reviews** answer: good exit or should it have been held;
   how did realised P&L compare to MFE/MAE; and — overlaid on the larger
   move — how much of the move did the trade actually capture.
5. **Operator in the loop.** Every review can be Approved, Modified
   (operator edits the analysis) or Rejected, with free-text commentary.
6. **Approve/Modify applies the finding**: config nudges go to the
   `learning_proposals` bus; the lesson goes to the executive desks
   (CIO / CRO / COO) as a memo; engine/code work becomes a one-page
   GitHub proposal that a coding agent can pick up when marked
   agent-ready.

## Why a separate agent (not an extension of Trade Autopsy)

Trade Autopsy is trade-level, human-graded, and retrospective (monthly
books). The reviewer is leg-level, machine-graded, and continuous. They
share the trade substrate but not the workflow: the autopsy is where the
operator forms opinions; the review desk is where an independent agent
forms them first and the operator adjudicates.

Also, critically, the AI CIO is a *pre-trade* gate — it approves entries.
An agent grading its own prior approvals is not independent. The reviewer
is deliberately a different agent with a different prompt, no authority
over execution, and read-only access to what the CIO decided.

## Data model

### `trade_reviews` — one row per leg per trade

| Column | Notes |
|---|---|
| `review_id` | `{trade_id}::{leg_kind}::{leg_seq}` |
| `trade_id`, `ticker`, `direction` | |
| `leg_kind` | ENTRY / TRIM / EXIT |
| `leg_seq` | 0 for entry/exit, 1..n for trims |
| `leg_event_id`, `leg_ts`, `leg_price`, `leg_qty_pct` | from `trade_events`, synthesized from `trades` when absent |
| `status` | pending / reviewed / error / approved / modified / rejected |
| `grade` | A+ … F |
| `verdict` | machine enum per leg kind |
| `success_prob` | entry legs only (0–1) |
| `capture_json` | deterministic math (MFE/MAE, capture ratio, big move overlay) |
| `context_json` | facts handed to the model (audit) |
| `analysis_json` | full model output |
| `model`, `latency_ms`, `error`, `prompt_version` | |
| `operator_note`, `decided_by`, `decided_at`, `operator_patch_json` | |
| `applied_json` | what the apply step actually did |
| `created_at`, `updated_at` | |

### `trade_review_proposals` — engine/code one-pagers

`proposal_id`, `review_id`, `trade_id`, `title`, `body_md`, `kind`,
`status` (draft / agent_ready / filed / error), `github_issue_number`,
`github_url`, `agent_dispatched_at`, `created_at`, `updated_at`.

### `exec_memos` — the desk feed

`memo_id`, `source`, `audience` (csv of cio/cro/coo), `ticker`,
`headline`, `body_md`, `evidence_json`, `weight`, `status`,
`created_at`, `expires_at`. Mirrored into KV `timed:exec:memos` (ring)
so the CIO memory loader picks it up without an extra D1 read on the hot
path.

## Flow

```
trade event written (ENTRY/TRIM/EXIT)
  └─ enqueueTradeReview()  → trade_reviews row, status=pending  (cheap, no LLM)
       └─ cron drain / "Review now"  → buildLegContext() + capture math
             └─ LLM (JSON mode)  → status=reviewed, grade, analysis
                   └─ operator: approve | modify | reject
                         ├─ submitProposal() → learning_proposals (config)
                         ├─ exec memo        → CIO / CRO / COO
                         └─ one-pager        → trade_review_proposals
                                                  └─ agent-ready → GitHub issue
```

## Deterministic capture math (not LLM)

Computed in `worker/review/trade-review-capture.js` from candles so the
model is grading facts, not inventing them:

- `mfe_pct` / `mae_pct` from entry (recomputed from the tape, cross-checked
  against stored `max_favorable_excursion` / `max_adverse_excursion`)
- `realized_pct`, `capture_ratio` = realized ÷ MFE
- **Big-move overlay**: the dominant favourable swing in a window that
  extends past the exit (default 10 trading days), so "exited at 81, ran
  to 100" is a number, not a vibe
- `post_exit_pct` — what the tape did after the exit
- `heat_before_payoff` — MAE experienced before MFE was reached
- for entries: `sl_distance_pct`, `tp_distance_pct`, `rr`,
  `entry_in_bar_range` (did we buy the high of the bar)

## Flags

| Key | Default | Meaning |
|---|---|---|
| `trade_review_enabled` | `false` | master switch (enqueue + drain) |
| `trade_review_auto_run` | `false` | cron drains the pending queue |
| `trade_review_model` | `gpt-4o-mini` | reviewer model |
| `trade_review_batch` | `6` | max legs reviewed per cron tick |
| `trade_review_lookahead_days` | `10` | big-move overlay window |
| `trade_review_github_enabled` | `false` | allow filing one-pagers |

## Status

- [x] Schema + capture math + agent + endpoints + apply pipeline
- [x] Admin page `/trade-review.html`
- [x] GitHub one-pager filing (+ agent-ready dispatch when `CURSOR_API_KEY` set)
- [ ] Operator to enable `trade_review_enabled` after reviewing a dry run
