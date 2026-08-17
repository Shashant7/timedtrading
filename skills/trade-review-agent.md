# Trade Review Agent

Independent per-leg grading of every ENTRY / TRIM / EXIT the model
executes, with an operator approve / modify / reject loop that feeds the
learning bus, the executive desks, and GitHub.

Admin page: **`/trade-review.html`** (admin-gated).
Design + rationale: [tasks/2026-08-17-trade-review-agent.md](../tasks/2026-08-17-trade-review-agent.md).

---

## The one thing to understand

The reviewer is **not** part of the engine and does not trust it. The
engine's own record — setup name, grade, gate trace, the AI CIO's
pre-trade approval — is passed to the model under `engine_claim` and
labelled as *the assertion being graded*. The tape facts are computed
separately in `worker/review/trade-review-capture.js` and passed as
ground truth.

This matters because the AI CIO already approves entries. An agent
grading its own prior approvals is not an independent review, so the
reviewer is a different agent, with a different prompt, and no authority
over execution.

---

## Turning it on

All flags live in `model_config` (D1 `timed-trading-ledger`).

| Key | Default | Effect |
|---|---|---|
| `trade_review_enabled` | `false` | queue a review row per executed leg |
| `trade_review_auto_run` | `false` | nightly cron drains the queue |
| `trade_review_model` | `gpt-4o-mini` | reviewer model |
| `trade_review_batch` | `6` | max legs reviewed per cron tick |
| `trade_review_lookahead_days` | `10` | big-move overlay window past the exit |
| `trade_review_github_enabled` | `false` | allow filing one-pagers as issues |

```bash
cd worker && ../node_modules/.bin/wrangler d1 execute timed-trading-ledger --remote \
  --command "INSERT INTO model_config (config_key, config_value, updated_at)
             VALUES ('trade_review_enabled','true',strftime('%s','now')*1000)
             ON CONFLICT(config_key) DO UPDATE SET config_value='true'"
```

Enqueueing is a single D1 insert on the ledger path — **no LLM runs
during a trade**. Reviews happen on the nightly drain or on demand.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/timed/admin/trade-review/trades` | trades with legs + grades (`?status=`, `?ticker=`, `?days=`) |
| GET | `/timed/admin/trade-review/detail?review_id=` | full analysis, capture, context, proposals |
| POST | `/timed/admin/trade-review/enqueue` | backfill: `{trade_id}` or `{days, limit}` |
| POST | `/timed/admin/trade-review/run` | `{review_id}`, `{review_id, dry_run:true}`, or `{drain:true, limit}` |
| POST | `/timed/admin/trade-review/decide` | `{review_id, decision, note, patch}` |
| GET | `/timed/admin/trade-review/proposals` | one-pagers |
| POST | `/timed/admin/trade-review/proposal/file` | `{proposal_id, agent_ready, dispatch}` |
| GET | `/timed/admin/exec-memos?audience=cio` | the desk feed |

### Audit a prompt without spending a call

```bash
curl -s -X POST "$API/timed/admin/trade-review/run" -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"review_id":"XLI-1785765000000::EXIT::0","dry_run":true}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['user_prompt'])"
```

Use this first whenever a review reads wrong. Nine times out of ten the
model is fine and the *context* is wrong.

---

## What the operator's decision actually does

| Decision | Effect |
|---|---|
| **Approve** | applies the agent's analysis as-is |
| **Modify** | operator's edits replace the agent's, revalidated through the same normalizer, then applied |
| **Reject** | records the disagreement, routes nothing |

Applying routes three ways:

1. **Config findings** → `submitProposal()` on the `learning_proposals`
   bus, **always tier2**. A single-trade review can never auto-mutate the
   live model, however confident it is.
2. **Engine findings** → a `trade_review_proposals` row: a one-page
   requirement with the evidence table, acceptance criteria (flag-gated,
   unit-tested, replay-validated) and a scope note.
3. **Always** → an `exec_memos` row + KV ring `timed:exec:memos`, read by
   the CIO (memory layer, weighted above external research because it
   grades the CIO's own approvals) and the CRO (synthesis source cited as
   `trade_review`).

Rejections are kept deliberately: a reviewer that is frequently overruled
is itself a calibration signal.

---

## Filing engine work to GitHub

`File as agent-ready` creates the issue with the `trade-review` and
`agent-ready` labels. The **label is the contract** — that is what marks
work as ready for a coding agent to pick up.

If `CURSOR_API_KEY` is set on the worker, filing also dispatches a
background agent against the one-pager. Without the key the issue is
still filed and labelled; only the automatic hand-off is skipped.

Requires `GITHUB_TOKEN` (with `issues:write`) + `GITHUB_REPO`, already
configured for the screener workflow dispatch.

---

## Traps

- **`Number(null) === 0`.** The capture math rejects null/empty before
  coercing; a missing exit price must not become a $0 fill. Any new
  numeric helper here needs the same guard.
- **Shorts are not negative longs.** A fall from 106 to 90 is a 15.1%
  gain on the 106 basis, not 17.8% on the 90 basis. All percentages go
  through `favPct(reference, price, isLong)`.
- **`positions` is keyed by ticker, not trade_id.** A closed trade whose
  ticker was later re-entered will match the *new* position's stop. Levels
  must pass `levelsAreCoherent()` (stop below entry for a long, target
  above) and the positions fallback only applies while the trade is open.
  Unattributable levels are reported as "NOT RECOVERABLE" — never guessed.
- **Thin tape.** Preprod candle coverage often stops mid-trade. The prompt
  states bar coverage and steers to `INSUFFICIENT_DATA` below 3 bars;
  don't read a confident grade off a two-bar sample.
- **Synthesized legs.** Trades without a `trade_events` receipt have their
  legs reconstructed from summary columns. The prompt says so; timestamps
  are approximate.
- **The dominant move may start after the exit.** "Captured 49% of the
  move" reads very differently when the move began once we were flat. The
  prompt distinguishes the two cases explicitly.

---

## Files

| Path | Role |
|---|---|
| `worker/review/trade-review-schema.js` | D1 tables |
| `worker/review/trade-review-legs.js` | leg extraction (events → summary fallback) |
| `worker/review/trade-review-capture.js` | deterministic forensics (pure) |
| `worker/review/trade-review-context.js` | D1 assembly + level attribution |
| `worker/review/trade-review-prompts.js` | system prompt + tape brief |
| `worker/review/trade-review-agent.js` | enqueue / run / drain / validate |
| `worker/review/trade-review-apply.js` | proposals, memos, one-pagers |
| `worker/review/trade-review-github.js` | issue filing + agent dispatch |
| `react-app/trade-review.html` | admin page |
