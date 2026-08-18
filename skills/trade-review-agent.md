# Trade Review Agent

Independent grading of each **closed trade** as one story (entry + any
trims + exit), with an operator approve / modify / reject loop that feeds
the learning bus, the executive desks, and GitHub.

The original per-leg queue (~76 cards on a busy day) was not a sustainable
operator loop. Default is now `trade_review_closed_only=true`: ENTRY/TRIM
are not queued; the EXIT event writes one `{trade_id}::TRADE::0` row.

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
| `trade_review_closed_only` | `true` | one TRADE review after close (skip per-leg ENTRY/TRIM) |
| `trade_review_github_enabled` | `false` | allow filing one-pagers as issues |

```bash
curl -sX POST "$WORKER_URL/timed/admin/model-config?key=$TIMED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"updates":[{"key":"trade_review_enabled","value":"true"}]}'
```

Every one of these keys must also appear in `REPLAY_DA_KEYS`
(`worker/replay-runtime-setup.js`). That allowlist is what the live
scoring cron loads into `env._deepAuditConfig`; a key missing from it is
invisible to the engine no matter what `model_config` says. Admin HTTP
requests and the 22:00 cron do not load that config at all, which is why
every reviewer entry point calls `loadTradeReviewConfig(env)` first.

Enqueueing is a single D1 insert on the ledger path — **no LLM runs
during a trade**. Reviews happen on the nightly drain or on demand.
Open positions are left alone; the UI says the review waits until flat.

**Operator-validated class (2026-08-17):** USO trimmed and exited early
while the dominant move was still running is **LEFT_MONEY / valid**. A
max-loss or cloud-pivot with MFE near zero and leftover under ~1% is
**not** premature (XYZ 17 Aug was rejected on that basis).

**Live as of 2026-08-17:** `trade_review_enabled`, `trade_review_auto_run`
and `trade_review_github_enabled` are `true` in production with
`trade_review_batch=12`. Backfilled 64 legs across the last 21 days of
live trades; all 64 graded.

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

Dispatch uses the **v1 Cloud Agents API** with Cursor Router **Auto**
(`model.id = auto-smart`, `optimize_for = balanced`) and
`autoCreatePR: true`. Override with Worker secrets/vars:

| Var | Effect |
|---|---|
| `CURSOR_AGENT_OPTIMIZE_FOR` | `cost` / `balanced` (default) / `intelligence` |
| `CURSOR_AGENT_MODEL` | Pin an explicit model id; skips Router Auto |

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
- **The model swaps `grade` and `verdict`.** In the first production drain,
  17 of 25 reviews came back with a verdict code sitting in `grade` and a
  sentence in `verdict`, so both fields normalised to null. The prompt now
  spells out that grade is a letter and verdict is a code, and
  `normalizeReviewPayload` salvages a verdict found in the grade field and
  folds `B+`/`C-` down to `B`/`C`. When either field still ends up null the
  raw values are kept in `analysis._raw` — check there first.
- **A review row with `status='reviewed'` is not proof it worked.** Grade
  and verdict can both be null on a "successful" review. After any prompt
  or model change, re-drain and count nulls:
  `SELECT COUNT(*) FROM trade_reviews WHERE status='reviewed' AND (grade IS NULL OR verdict IS NULL)`.
  Reset those rows to `pending` and drain again.

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
