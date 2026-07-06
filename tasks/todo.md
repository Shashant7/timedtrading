# Current Tasks

> **Workflow:** Plan first → commit before testing → push every iteration →
> open/update the PR → update lessons after any user correction.
> See [AGENTS.md](../AGENTS.md) for the full onboarding.
>
> **Skills first:** Before inventing a new method, check [`../skills/`](../skills/).
> If you do something new that's reusable, write a skill before exiting.

---

## Completed programs (do not reopen)

- **Jul→Apr recovery (2025-07 → 2026-04)** — Backtest validation and
  promotion to live are **done**. Historical plans live in
  [`archive/2026-pre-may/`](archive/2026-pre-may/README.md). Only start a
  new replay lane if you intentionally define a fresh contract in this file.

---

## Open work — Mission Control + Today + UX polish

### Active

- [ ] **Bugbot fixes (#997/#998/#1001) — PR #1002 (ready for review; Bugbot pending).**
      Fixes: ReadySetupsBoard `embedded` prop, VerdictGuideBlock key levels,
      exited names in BUY ZONE strip, TimedRailHelpers investor helper wiring.
      **Process:** always wait for Bugbot + human review before merging PRs.

- [x] **NVDA feed SL hard-close (2026-07-02).** */1 price-feed now triggers
      immediate `processTradeSimulation` hard close on confirmed SL breach
      (worst-case price via `feed-sl-close.js`). TRADE UPDATE + OOH reconcile
      pass `openTrade` into `hydrateTickerDataForTradeMgmt`. Admin:
      `GET /timed/admin/feed-sl-triggers`. tt-feed relays via
      `POST /timed/internal/feed-sl-close`.

- [x] **Breaker phantom pollution fix (2026-07-01).** Loop 2 + portfolio-risk
      exclude fast hard-exit round-trips and impossible `sl_breached` rows;
      live queries scoped to `run_id IS NULL`; regime-shock suppressed when
      book is flat; admin `POST /timed/admin/portfolio-risk/reset-samples`;
      Loop 2 pause auto-clears on healthy pulse.

- [x] **Investor alert templates + candle freshness (2026-07-02).** EXIT vs
      TRIM digest fix, templated Discord/email (shares, levels, CIO, 1H chart),
      sanity sweep candle streak gate.

- [ ] **Setup sequence shadow awakening (2026-06-21).** Tier A+B replay
      complete (211 moves, 96% sequence yield). Verdict:
      `docs/setup-mining-tier-ab-verdict-2026-06-21.md`. Shipped:
      alignment section in aggregate report, `SETUP_SHADOW_STAMP` on scoring
      payload (`setup_sequences` + `setup_shadow_posture`), right-rail inline
      shadow read. L2 live gate pending trail pair depth on prod fixtures.
      **No `SEQUENCE_ENTRY_GATE` until forward shadow validates aligned capture.**

- [x] **Gate simulation + TD9 parity (2026-06-22, PR #775).** TD9 daily
      transition fix (0%→12% backtest coverage). Expanded gate sim +
      timing pass + SETUP_GATE_SHADOW on preprod/tt-engine.
      `docs/setup-mining-gate-timing-shadow-2026-06-22.md`. **Next:**
      deploy tt-engine with SETUP_GATE_SHADOW; forward shadow validation.

- [x] **D1 billing 80M threshold (2026-06-22).** Investigated + documented.
      No fix — Jun 18 mining burst + normal RTH; ENGINE_EXTERNAL cutover OK.
      `docs/d1-billing-investigation-2026-06-22.md`. Re-assess next month.

- [x] **Setup-mining Tier A sequence yield (2026-06-20).** Root cause: preprod
      `timed_trail` rows had `flags_json` only (0/3318 `payload_json` for KLAC).
      Fix: auto-write `sequence_trail` snapshots when `SETUP_TRAIL_SNAPSHOT=1`
      (preprod wrangler var), richer `snapshotFromTrailScalars`, `--force-replay`
      + payload warnings in replay script. Deploy preprod; KLAC smoke: 4→51 events,
      sequence detected with 1 day of payload backfill. Full Tier A re-run needs
      `--force-replay` on `replay-move-windows.mjs`.

- [x] **Investor compliance + model voice (2026-06-15, PR #733).** Model-voice
      copy; structural reduce bypass; sticky invalidation. Merged + deployed.

- [x] **Investor schedule + candle heal (2026-06-15, PR #735).** Primary
      rebalance 10:30 AM ET; score 4 AM–8 PM ET hourly; RTH portfolio actions
      every hour. Merged + deployed.

- [x] **Investor invalidation → auto-rebalance exit (2026-06-15, PR #729).**
      primary invalidation price breach into live auto-rebalance (full exit,
      no CIO gate). Sticky invalidation for owned positions so floors don't
      ratchet down on a drop. Branch: `cursor/investor-invalidation-exit-df0c`.
      Merged PR #729.

- [x] **Active Trader alert parity (2026-06-15).** Entry: await
      d1InsertNotification + dispatchTradeAlertEmails; rich notification
      body; full Discord parity in email (signal quality, why entered,
      scale hint, vehicle pick). Exit signal suppressed when flat-price /
      shield / min-age / Trend-Hold block close. Branch:
      `cursor/active-trader-alerts-df0c`.

- [x] **CTO universe + tiered refresh (2026-06-11).** Drop screener
      candidates from CTO focus; use scored universe (`SECTOR_MAP` +
      user-added). Hourly intraday CRO refreshes indices + open positions
      (1h cache, 45s cap); daily full CRO pass refreshes remainder (24h
      cache, 4m cap). Rollup merge preserves cached rows; D1 audit only on
      fresh compute. Branch: `cursor/cto-universe-refresh-7b37`.

- [x] **Performance tuning + journey-page design unification + docs
      (2026-06-10, PR pending).** Frontend perf pass (defer-everything,
      vendored CDN libs, immutable `?v=` caching via `_worker.js`,
      single font @import, speculation-rules prerender, CSS stamping in
      build); Active Trader + Investor restyled to Today's Verda
      language (shared `.tt-disclose`/`.tt-status` in tt-tokens.css,
      full `:root` repoints, guides collapsed by default); docs
      refreshed for new agents (CONTEXT stack/topology + perf doctrine,
      DESIGN canonical patterns, AGENTS repo map, new skills:
      `worker-topology.md`, `frontend-performance.md`). Plan:
      `tasks/2026-06-10-perf-design-docs-plan.md`.
- [x] **Accumulate lane clarity — execution-ready only (PR pending).**
      LITE/ASTS showed in ACCUMULATE (BUY NOW) but detail panel said
      WATCH. Fix: kanban demotes monitor/stale accumulate rows to On
      Radar / Hold & Watch; scores GET revalidates accumulate/reduce
      rows at read time; hide "monitoring for trigger" on act_now/ready.
- [x] **Timing plumbing — extension dump orchestration (PR #509).**
      Unified TD9/phase/RSI/Markov/VIX/FSD into `timing-signals.js`;
      fixed broken `detectExhaustionWarnings` per_tf path; L6 DeMark bear
      fix; confluence FADE SHORT overlay; index put gate; kanban trim;
      Discord INDEX EXTENSION WATCH; proactive alerts; Trader tab Timing
      panel; worker deployed default + production.
- [x] **DIA day-trade archival — canonical scenario + grading (PR pending).**
      DIA morning triggers were NULL on 2026-06-05 because archival read
      `diaTechnical` (D-candles only) instead of `buildTickerScenario`.
      Patched: `diaScenario` in gather, DIA in infographic.indices, D1
      insert prefers scenario game plan; right-rail day-trade panel includes DIA.
- [x] **Discord: link-flow button + welcome email rules (PR #438).**
- [x] **Holistic MC smoke-test skill + polish-sweep logic verdict (PR #439).**
- [x] **Investor alerts: explicit ACTION verb + chart in email (PR #440).**
- [x] **MC: editable modes + archetypes for options auto-mirror (PR #437).**
- [x] **Mobile nav + day-trade card clarity + right-rail integration (PR #441).**
- [x] **Setup-name upstream stamp fix + CIO lifecycle coverage thoughts
      (PR pending).** Operator: "I also noticed there was a setup name
      stamp issue upstream mentioned" + "My lean on AI CIO is to have
      it on for all trade lifecycle decisions, thoughts?". (a) Upstream
      stamp fix: `worker/index.js` `d1UpsertTrade` had a DUPLICATE of
      the old `formatSetupName` regex fallback that never got the
      PR #432 fix — `tt_atl_breakdown` landed in D1 as `"TT Tt Atl
      Breakdown"`. Replaced with direct `formatSetupName()` call (single
      source of truth) + new `_trimSetupNameForDir()` inline helper that
      applies the SETUP_DIRECTION_PAIRS swap at WRITE time. Logs every
      swap with trade_id + ticker + entry_path so we can identify the
      upstream caller. 5/5 smoke-test scenarios pass. (b) CIO coverage
      doc at `tasks/2026-06-01-ai-cio-lifecycle-coverage-thoughts.md`:
      recommends phased rollout (Phase 1 = Investor auto-rebalance trim
      next session; Phases 2-5 sequential) with three guardrails
      (latency cap, monthly $ cap, differential override logging).
- [x] **Day-trade options plays + Options-tab loading overlay (PR #436).**
- [x] **Calibration UX polish (PR #435).** Three additions to System
      Intelligence → Analysis tab: (a) Calibration explainer card at
      the top — plain-language "what calibration does, where it shows
      up, how to use this page" with a right-aligned freshness chip
      (FRESH <6h / OK <24h / STALE >24h based on time since last Run
      Analysis). (b) Run-status toast after Run Analysis completes —
      "✓ Analysis complete — N recs from M trades (Xs)" success or
      "✗ Analysis failed: <error> (Xs)" — auto-dismisses 6s.
      (c) Freshness chip on the Deep Audit header with the same
      colour ladder + tooltip explaining the STALE case. Operator no
      longer guesses whether Run Analysis did anything or whether
      recommendations are current.
- [x] **Setup-name display: tt_* keys mapped + direction-aware swap
      (PR #432).** Discord DIA exit embed showed "Setup: Atl Breakdown"
      for a LONG. Two bugs: (a) SETUP_NAME_MAP missed `tt_*` paths, so
      `formatSetupName` fell through to a regex that produced
      "TT Tt Ath Breakout" (phantom "Tt" word from `tt_` getting
      title-cased) — now every `tt_*` entry path is mapped explicitly
      and the fallback regex strips a leading `tt_` first; (b) some
      upstream write path stamps a stale/mis-derived setup_name —
      added a direction-aware swap in `prettySetupName(name, direction)`
      that converts a stored LONG/SHORT-mismatched setup to the
      direction-correct paired name at render time. Logs warn so we
      can trace the upstream stamp bug. Trim + exit embed call sites
      pass direction. 9/9 smoke test scenarios pass.
- [x] **Freshness monitor heals before paging + chart SVG sl=0 trap
      (PR pending).** Two polish-phase bugs in one PR. (1) `candle_
      freshness_60` paged for BK at 71.5h stale even though the auto-
      heal was about to clear it. Reordered to detect → heal → re-check
      → page only if still stale; page text now distinguishes "real
      data problem (auto-heal attempted, still stale)" from the
      transient case. (2) DIA exit email rendered an empty chart
      because `sl=0` got coerced to a real annotation
      (`Number.isFinite(Number(null))` is `true`), expanding the
      y-axis from $0 to $539 and squeezing the actual price action
      ($509-$511) into a tiny squiggle at the top. Three defenses:
      email.js skips sl/tp on EXITs entirely; URL-encode requires
      `>0`; chart-svg.js helper requires `Number.isFinite(v) && v > 0`
      AND filters annotations >30% off the price midpoint.
- [x] **Reliability sweep: investor compute retry + manifest stale-bridge
      hint + toxic-ticker safety (PR #433).** Three independent
      polish-phase fixes in one PR. (1) Investor cron now retries
      `/timed/investor/compute` 3× with 0/8/30s backoff on 5xx/408/429
      before tombstoning — single transient 503s no longer page.
      (2) MC manifest 404 surfaces actionable remediation hint
      ("redeploy worker-bridge" for 404, "key mismatch" for 401)
      instead of just raw upstream error. (3) Auto-ban toxic tickers
      now has three safety layers: min sample 3→5, open-position
      protection (any ticker with an OPEN trade is excluded — covers
      the TSM/AMZN case), recency recovery (last-10 trades SQN >= 0
      overrides historical SQN). Card discloses both banned and
      protected tickers with per-ticker context; if all candidates
      protected, the `config` payload is omitted so Apply doesn't
      clear an existing blacklist.
- [x] **ETF stagnant-exit HTF gate (DIA 2026-06-01 audit, PR pending).**
      Operator flagged a DIA LONG cut at +0.28% via `etf stagnant exit`
      while the live MTF chart showed bullish Monthly + Weekly + Daily
      and a clear 30m coil-before-break — DIA rallied minutes after the
      cut and is currently at $511.21 (vs. our $510.67 fill). The
      `etf_fast_cut_zero_mfe` branch fired correctly per its own logic
      (4h elapsed + MFE<0.05%) but didn't know the trade was sitting in
      a constructive HTF coil. Fix: optional `htfContext` parameter to
      `checkEtfStagnantExit()` defers the cut when LONG + monthly
      bullish + above D-EMA200 + LTF squeeze (mirror for SHORT). Other
      branches (dead-money, pnl-negative fast-cut) unchanged so genuine
      slow+losing trades still get cut. Smoke-tested 8 scenarios; only
      the exact "HTF-aligned coil" pattern defers. Full investigation
      writeup in `tasks/2026-06-01-dia-stagnant-exit-investigation.md`.
- [x] **Screener Promotion Queue: per-ticker decision inheritance +
      Discovery Thesis in Snapshot right rail (PR pending).** Operator
      flagged: (1) "SMCI, SNOW showed up again, I thought we already
      added those" and (2) "the justification text is money, can we
      incorporate that into Snapshot Right Rail?". Two fixes: (a)
      `worker/discovery/promotion-queue.js` `rebuildPromotionQueue` now
      looks up the most recent decision for each ticker across ALL
      candidate_ids before creating today's row — `approved`/`declined`
      decisions inherit forward so a previously-decided ticker stays
      decided. Smoke-tested prior-approved/declined/new-ticker paths.
      `IN UNIVERSE` badge added to `react-app/screener.html` cards for
      visual confirmation. (b) New `loadThesisForTicker()` helper +
      `GET /timed/screener/thesis?ticker=SYM` endpoint (CF Access, 5-min
      KV cache). New Discovery Thesis Panel in
      `react-app/shared-right-rail.js` Snapshot tab — sits between
      Today and Regime Forecast, shows status chip + score in header,
      thesis paragraph in body, red flags as inline chips. Silently
      absent for tickers without a promotion-queue record (legacy
      universe names — don't fabricate).
- [x] **Investor card: Invalidation prices + LEAP (not Straddle) for
      Investor mode (PR pending).** Operator on CRS Investor card asked
      (1) "add price reference for Monthly ST and Weekly EMA(200) in
      the Invalidation thesis" and (2) "the Options Play is a Long
      Straddle — if we are accumulating LONG, why a direction-neutral
      play?". Two fixes: (a) `worker/indicators.js` exposes new
      `weekly_bundle` (mirror of `monthly_bundle`) with `supertrend_line`
      + `ema200`; `worker/investor.js` `generateThesis` appends actual
      price (`$XXX.XX`) to ST/EMA invalidation strings and ordinal
      `(currently NNrd)` to RS-rank strings — converts
      `"Price closes below Weekly EMA(200)"` → `"Price closes below
      Weekly EMA(200) ($435.20)"`. (b) `worker/options-plays.js`
      `buildOptionsLadder` was treating the trader-side
      `confluence.mode==="WAIT"` (a short-horizon "no 1-5d direction"
      verdict) as authority to strip all directional plays — so the
      Investor LEAP was being suppressed and only the direction-neutral
      Long Straddle survived for CRS. Now `suppressDirectional` is
      gated on `!isInvestorMode`; Long Straddle is excluded entirely
      from Investor mode regardless of vol/verdict (Investor thesis is
      directional by definition). Trader mode keeps the existing
      behavior (straddle still surfaces at high vol or on WAIT verdict).
      Smoke-tested 5 scenarios across trader/investor × WAIT/RIDE/high-vol;
      CRS Investor + WAIT now yields LEAP as primary (was straddle).
- [x] **Loop 2 breaker: duration-bias-aware (PR pending).** Operator paged
      twice for `wr_20` (Last 10 WR 20%, today -1.15%) while the open
      book was up — classic survivorship bias. `loop2ComputePulse` now
      also returns `profit_factor` + `expectancy_pct`; new
      `loop2ComputeOpenBookMetrics` computes open MTM and today-delta;
      `loop2EvaluatePulse` defers any trip when EITHER PF ≥ 1.3 OR
      combined-today (realized + open delta) ≥ -0.5% (both knobs in
      `model_config`). Discord alert now shows the combined view next
      to the closed-only headline so operators see whether the trip is
      a real regime breakdown or a closed-WR headline. Tunable: PR adds
      `loop2_breaker_pf_safe` + `loop2_breaker_combined_safe_pct`.
      CIO memory gains Layer 16 `engine_pulse` (same metrics + a
      `bias_note: "closed_wr is duration-biased downward; profit_factor
      + combined_today are the unbiased view"`). CIO system prompt
      gains a DURATION-BIAS WARNING section telling the LLM to weight
      PF + combined over WR and forbids citing WR alone in reasoning.
      Backward compat: pulses without the new fields fall back to
      closed-only legacy behavior. Smoke-tested 4 scenarios (duration-
      bias case, real breakdown, no open-book data, low-PF + bad
      open-book) — all behave correctly.
- [x] **Investor cards out of sync with Discord entries (PR pending).**
      Operator screenshotted 6 fresh Discord entries (CRS, IESC, FSLR,
      WTS, ASTS, TSM LONG) at 11 AM and the matching kanban tiles
      showing NO OWNED chip. Three independent bugs collapsed into one
      complaint: (1) `InvestorPanel.fetchData` polled
      `/timed/investor/scores` alone every 60 s, wiping the
      position-reconciliation `investor.html` did at first paint —
      moved the merge of `/timed/investor/positions` INTO the panel's
      polling loop so refresh now stays in sync with newly-opened
      positions. (2) `worker/investor.js:700` classifies unowned
      tickers with moderate scores as `stage:"watch"` and the lane
      renders with action chip "HOLDING" — added panel-side demote:
      `watch`/`core_hold` + !owned → `research_on_watch`,
      `reduce` + !owned → `research_low`. (3) Lane gutter showed
      total-items, not owned-count — HOLDING lanes now compute owned
      separately and render "owned/total" when mixed. (4) Added a
      green pulsing "JUST OPENED" chip for positions whose
      `first_entry_ts` is within the last 30 min, directly anchoring
      Discord entry alerts to kanban tiles. `tt-tokens.css` gains a
      generic `tt-pulse` keyframe (respected by
      `prefers-reduced-motion`).
- [x] **Open-position freshness alert noise — streak gate + 20min
      5m RTH threshold (PR #426).** Operator paged for
      `5=16.2min` on DIA/GS/AA — a 5-15 min shared-feed blip that
      self-heals on the next cron tick. Three fixes in
      `worker/index.js`: (1) bumped `OPEN_POS_STALE_5M_RTH_MS` from
      15 → 20 min (absorbs one missed bar; 3+ missed still trips).
      (2) Added streak gate — KV key
      `timed:freshness:open_pos_streak:<sig>` (30 min TTL) requires
      ≥ 2 consecutive sweeps with the SAME `(tickers × reasons)`
      signature before paging. (3) Rewrote reason format from
      `5=16.2min` → `5m: 16min stale (>20min)` and embed description
      now explicitly states "pause auto-clears on next successful
      sweep, so no action is required unless alert recurs in 24h."
- [x] **Chart image in entry/trim/exit emails (PR #424).** New SVG chart
      renderer (`worker/chart-svg.js`) + public `GET /timed/chart-image
      ?ticker=&tf=60&bars=48&entry=X&sl=Y&tp=Z` endpoint pulls candles
      from `ticker_candles` D1 and renders an inline SVG (~3-4KB) with
      entry/SL/TP annotation lines, last 48 1H bars by default. Email
      body now embeds the chart as `<img src="https://timed-trading.com
      /timed/chart-image?...">` right under the headline — Gmail / Apple
      Mail / Outlook proxies fetch it inline. Cached 5 min CF-side so
      heavy email blasts don't pound D1. Empty-state SVG when candles
      are missing so the `<img>` never breaks.
- [x] **AI CIO ↔ Active Strategy wiring + freshness Monday-morning
      false-positive fix (PR #425).** Audit found CIO only saw per-ticker
      `strategy_stance` when a ticker actively matched a theme — and
      even then, the system prompt had no guidance on how to use it.
      The full editorial brief was Daily-Brief-only. Three fixes:
      (1) `getStrategyBrief()` injected at the top of every CIO entry
      + lifecycle prompt — same brief Daily Brief uses, so the two
      surfaces stay in lockstep. (2) `strategy_stance` is now ALWAYS
      added to memory (even for neutral stance / no theme match) so
      ~60% of the universe stops getting silently omitted from
      playbook context. New `on_thesis` boolean for fast LLM branching.
      (3) New ACTIVE STRATEGY PLAYBOOK + STRATEGY STANCE sections in
      the CIO system prompt explaining how to use overweight/under-
      weight + tier-1 themes + active risks as soft priors. Evaluation
      order elevates these above MACRO TILT and PDZ. Also: freshness
      monitor's 60m staleness threshold is now weekend-aware (72h on
      Monday 9 AM check; 24h Tue-Fri) — previously fired
      "candle_freshness_60: BRK-B 65.5h" every Monday because the
      first Monday bar hadn't completed yet.
- [x] **Universe + cohort fix — NBIS sector mismatch, ARM/MRVL/SMCI
      promoted to megacap_tech cohort (PR #423).** NBIS was tagged
      Health Care in `worker/index.js` SECTOR_MAP (sector-mapping.js
      correctly has it as Information Technology) — fixed, should
      immediately raise NBIS investor score and surface it in AI-infra
      theme runs. ARM, MRVL, SMCI added to default megacap_tech cohort
      in `worker/pipeline/tt-core-entry.js` so the slope/RSI/extension
      caps match AI-infra primary-trend behavior (was falling into the
      cyclical "other" bucket with too-tight caps). All still
      operator-tunable via `deep_audit_cohort_megacap_tickers`
      model_config key without a redeploy.
- [x] **Investor Sim-eligible filter — backfill + chip counts + tickerData
      passthrough (PR #422).** Three fixes for the operator report that
      clicking "Sim-eligible" emptied the lane while the dashboard
      still showed 90 in Accumulate.
      (1) `/timed/investor/scores` now backfills `simEligible` +
      `_stDirD/W/M` on the read path when the underlying KV scoring
      blob predates the field (returns `simEligible: null` to mark
      "unknown — data not yet populated").
      (2) Panel filter now treats `simEligible === null` as **unknown**
      (keeps visible) instead of hard-exclude, so the lane doesn't
      silently empty when the cron hasn't repopulated.
      (3) Chip label shows `Sim-eligible (N+M?)` where N = strictly
      eligible, M = unknown — so the operator always sees a number that
      matches the lane.
      (4) `investor.html` now passes `data` (from `/timed/all`) as
      `tickerData` to InvestorPanel so the fallback recompute has
      structural fields (tf_tech.D.stDir, monthly_bundle.supertrend_dir).
- [x] **MC: Run Calibration button + stale-message cleanup (PR #422).**
      The Last Calibration KPI in Mission Control now has a "Run ⚙"
      button that opens `/calibration.html?auto=run` in a new tab.
      `/timed/calibration/status` no longer claims "Waiting for next
      half-hour cron" (the cron-based pipeline was removed in April);
      now points operator at `POST /timed/calibration/run` and
      `scripts/calibrate.js`. wrangler.toml comment updated to note
      the half-hour slot is reserved/no-op.
- [x] **Investor Accumulate lane polish — tighter default + Sim-eligible
      filter.** Bumped `accumulate_strong_score_min` default 65 → 70 in
      `worker/investor.js` (the in-zone path stays permissive). Added a
      "Sim-eligible" filter chip to the Investor lane + bubble map that
      narrows Actionable to the cohort the simulator would actually buy
      (Monthly ST bullish + ≥2/3 of D/W/M ST bullish — matches
      `worker/index.js:36692-36698` exactly). Scoring cron pre-computes
      `simEligible` + `_stDirD/W/M` on each `/timed/investor/scores`
      row so the filter is a single boolean read on the client. Operator
      override (`deep_audit_investor_accumulate_strong_score_min`)
      unchanged; can flip back to 60-65 for wider Forensic-style cohort.
- [x] **Discord DM as a bonus user notification channel.**
      New `discordDmUser(env, discordUserId, payload)` helper in
      `worker/alerts.js` — two-step bot API flow (open DM channel →
      post message). Wired into the bridge-notify drain handler:
      when `BROKER_NOTIFY_DM_USER=true` and the user has linked
      Discord (`users.discord_id` from existing OAuth), the drain
      ALSO DMs them with the same compact embed alongside the email.
      Lookup is bounded (one D1 SELECT per unique email, cached in
      the drain handler). Failures (DMs disabled, no link, bot
      issues) never block the email send. Default OFF — operator
      opts in once they've verified DMs land. The drain response
      reports `dm_enabled`, `dm_sent`, `dm_skipped_no_link`,
      `dm_failed` so MC can surface DM health alongside email
      counts. Replaces / supplements the per-environment
      `BROKER_OPERATOR_DISCORD_WEBHOOK_URL` (operator can keep
      using that AS WELL for cross-team visibility, but it's no
      longer the only escalation path).
- [x] **Trade-aware mirror sync Phase E — drift notifications + MC
      Mirror Sync panel + Daily Owner Email cron.**
      New `worker-bridge/bridge-notifications.js`:
      `shouldDispatchDriftNotification()` (severity-tier dedup with
      escalation escape hatch), `buildDriftEmailContent()` /
      `postOperatorDiscord()` / `emitDriftNotification()` (queue +
      stamp manifest), `buildDailyOwnerDigest()` /
      `renderDailyOwnerDigestEmail()`, `drainNotifyQueue()`.
      Reconciler now calls `emitDriftNotification()` on warn/critical
      drift; bridge enqueues to `BRIDGE_KV` `bridge:notify:queue:*`,
      main worker `*/5` cron drains via
      `POST /timed/admin/broker-bridge/notify/drain { send: true }`
      and forwards through `sendEmail()`. New bridge cron
      `30 21 * * *` (21:30 UTC = 4:30pm ET) builds daily digests.
      New operator endpoints: `POST /bridge/manifest/action` with
      actions `suppress|unsuppress|mark_manual|mark_closed|
      force_resync_from_broker`; `POST /bridge/notify/drain`;
      `POST /bridge/notify/daily-digest`. Matching proxy routes
      on the main worker. MC manifest table extended with per-row
      action buttons (↻ resync, ⛔ Suppress / ✓ Unsuppress, ✕
      Mark Closed, ⊘ Mark Manual) + "📧 Preview daily digest"
      button in the section header. All operator actions include
      consequence text in their confirm dialogs.
- [x] **Trade-aware mirror sync Phase D — options + LEAPs + Investor + OCO.**
      Options leg-aware reconcile via `classifyOptionsDrift()`:
      canonical contract key `TICKER:YYYY-MM-DD:STRIKE.SS:[CP]`,
      per-leg expected vs broker comparison, spread leg-gap escalates
      severity to `critical`. New cadence routing: Trader equity 5min /
      Investor equity 60min / Trader & Investor options 60min / LEAPs
      daily — eligibility checked per-row via `_cadenceEligible()` so
      the 5-min cron throttles itself appropriately. LEAPs within T-30
      and other options within T-1 day get an "approaching expiration"
      note appended (Phase E will route to user notifications + emit
      auto-close once enabled). DCA tranche aggregation via
      `aggregateDcaTranches()` surfaces `N/M filled, K pending` in
      `sync_note`. New `worker-bridge/bridge-oco.js` exports
      `orchestrateOcoForReducer()` returning a structured cancel +
      replace plan for SL/TP orders; bridge audits the plan when
      `BROKER_OCO_ENABLED=true` (default off — actual cancel/place
      dispatch lands in Phase E).
- [x] **Trade-aware mirror sync Phase C — reconciler cron.**
      New `worker-bridge/bridge-reconciler.js` with
      `reconcileUser(env, user, adapter, opts)` + top-level
      `reconcileAllUsers(env, userListFn, adapterForUser, opts)`.
      `scheduled()` cron handler in bridge worker fires every 5 min
      (configurable via wrangler.toml triggers.crons), gates on NY
      regular-hours unless `BROKER_RECONCILE_24_7=true`. Compares
      `manifest.broker_remaining_qty` (fallback `model_intended_qty`)
      vs broker `getEquityPositions[ticker]` per §5.1 cadence and
      §6 mismatch taxonomy. Drift classifications: in_sync /
      partial_fill / broker_orphan (model CLOSED + broker holds) /
      mothership_orphan (model OPEN + broker = 0) / reconcile_error.
      Auto-suppress after 3+ chronic drift cycles with explicit
      `auto_suppressed_after_N_drifts:<state>` reason. Operator
      on-demand: `POST /bridge/reconcile` (single user or all) +
      `POST /timed/admin/broker-bridge/reconcile` proxy. MC "Force
      reconcile" button below the manifest table. `BROKER_RECONCILE_
      DRY_RUN` env supports observe-only mode for the first week.
- [x] **Trade-aware mirror sync Phase B — manifest-aware reducer.**
      `preflightOrder` now reads the `mirror_trade_manifest` BEFORE
      the portfolio check on every TRIM/EXIT. Decision matrix per
      §4.1: PROCEED when sync_state ∈ {in_sync, partial_fill,
      broker_orphan, untracked (close only)}; REJECT with explicit
      `no_manifest_for_trade` / `mirror_suppressed:<reason>` /
      `reducer_blocked_by_sync_state:<state>` /
      `reducer_missing_trade_id_for_manifest_lookup`. Partial-fill
      scaling supported via `BROKER_PARTIAL_FILL_MODE=scale`.
      `markManifestModelClosed()` wired on successful EXIT.
      Gated by `BROKER_MANIFEST_ENFORCE` env (on / log / off);
      starts in `log` mode in prod for a week of shadow-mode
      observation, then flips to `on`. Fail-OPEN on D1 read error
      so a degraded manifest doesn't lock the operator out
      (portfolio guard + reconciler are last-line defense).
- [x] **Trade-aware mirror sync Phase A — manifest writer.**
      New `worker-bridge/bridge-manifest.js` with `mirror_trade_manifest`
      D1 table (matches §3.1 schema exactly), `writeEntryManifest()`
      writer (called on every successful place after preflight),
      `writeRejectedEntry()` (called when preflight rejects an entry so
      Phase B can return `mirror_suppressed` on follow-on TRIM/EXIT),
      `recentManifestRows()` + `readManifestRow()` for inspector use.
      `ensureMirrorManifestSchema()` runs via `ensureBridgeSchema()` —
      idempotent + in-process cached. New `GET /bridge/manifest` +
      `GET /timed/admin/broker-bridge/manifest` operator-only endpoints.
      Mission Control renders a per-sync_state count strip + 50-row
      scrolling table with ⛔ icons on suppressed rows. Writer is
      best-effort — a manifest write failure does NOT undo a placed
      order; the reconciler (Phase C) reconstructs from the broker side.
- [x] **Options engine emits LEAPs for long-direction tickers (Investor
      primary, Trader alternative).** New `leap_call` archetype +
      `pickLeapExpiration()` (~540 DTE, snapped to 3rd Friday, floored at
      365 DTE for true LEAP status) + `buildLeapCall()` baked with the full
      stock-replacement framework (deep-ITM 0.80Δ default, PMCC follow-on
      suggestion, T-180 day roll discipline, IV-aware entry caveat,
      capital-efficiency floor warning, LEAP-aware liquidity tolerance).
      `buildOptionsLadder()` always inserts a LEAP into the long-side
      ladder for any long-direction ticker — `_investor_boost` pins it
      primary only on Investor stage; Trader stage keeps Long Call as
      primary with LEAP as an alternative below.
- [x] **Right-rail Options tab: Horizon toggle (Trader / Investor LEAP).**
      `/timed/options/ticker?mode=investor` forces `stage='investor'` +
      `direction='LONG'` so the engine pins the LEAP as primary. The
      in-panel toggle auto-detects from the host URL on mount
      (investor.html → investor) and is operator-overridable. LEAP
      metadata (roll target, PMCC suggestion, capital efficiency, IV
      assessment) renders through the existing primary-play card + notes
      bullet list — no further UI work was needed beyond the toggle.
- [x] **Trader + Investor entry alerts include the recommended options play.**
      New shared formatters `compactOptionsPlay()`, `optionsPlayDiscordField()`
      (Discord 1024-char-safe), and `optionsPlayEmailHtml()` in
      `worker/options-plays.js`. Trader entry path (kanban + trade-sim) and
      Investor entry path each call `buildEntryOptionsPlay()` which routes
      through the right mode → ladder primary, then attaches a single Discord
      field and an `options_play` payload to `sendTradeAlertEmail()`. Email
      renders a new "Options Play" section between Setup and Signals. Sample
      fixtures (`/timed/admin/send-sample-emails`) now include `trade_entry`
      (Trader long-call) and `investor_entry_leap` (Investor LEAP).
- [ ] **Investigate CF error 1042 on broker-bridge subrequests.** Worker-to-worker
      HTTPS fetch to `tt-broker-bridge.shashant.workers.dev` returns
      404 + `error code: 1042` (Cloudflare loopback rejection). Migrate
      to **Service Bindings** in `worker/wrangler.toml` per
      [skills/broker-bridge.md](../skills/broker-bridge.md) → "Cloudflare
      error 1042". Symptom: Mission Control bridge tile shows
      `bridge_responded_404` even though the bridge worker is up.
- [x] **FAQ ↔ Learn content alignment.** Rewrote `/faq.html` end-to-end
      so its 24 Q&A pairs align with `/learn.html` and the current
      product. New sections: Getting Started · Active Strategy &
      Universe · Daily Brief, AI CIO & Two Modes · Options & LEAPs ·
      Performance & Proof · Pricing & Subscription · Alerts, Community
      & Technical. Fixed: nav Sign-In → `/today.html` (was
      `/index-react.html`), Founding-member pricing terminology
      (was "Charter"), accurate Active Trader lanes (Watch → Setup →
      Enter → Hold → Defend → Trim → Exit) + Investor 4-action /
      3-research lane split, performance defers to live `/proof.html`
      instead of static backtest numbers, new questions for AI CIO,
      Active Strategy ON/OFF-THESIS, Options + LEAPs, entry-alert
      options play, sign-out-after-admin-removal flow, data sources
      (Twelve Data + Alpaca).

### Watch

- [ ] **Mission Control AI CIO Decision Review** — inline feedback now in place
      (PR after 2026-05-30). Confirm with operator that buttons feel responsive.
- [ ] **Broker bridge console noise** — `/status` + `/audit` now return 200
      with structured `error_kind` (same PR). Confirm DevTools is clean.

### Planned

- [ ] **Trade-Aware Mirror Sync (v2 design).** Manifest table +
      reconciler keeping mothership (model trade state) in lockstep
      with each spawn (user broker account). Drift detection +
      user notification + per-trade kill switch + per-vehicle
      toggles + daily owner email + user-modification handling.
      Plan: [2026-06-01-trade-aware-mirror-sync-design.md](2026-06-01-trade-aware-mirror-sync-design.md)
      (v2). **Scope:** Trader + Investor × Shares + Options
      (incl. LEAPs as 2nd-most-popular vehicle), 6 simulation
      actions mapped per cell, every action mapped to explicit
      IBKR Client Portal API calls including OCO order lifecycle
      (cancel-before-trim, modify-SL, TP/SL fill detection). **No
      naked shorts** — equity SHORT, options selling-to-open,
      cash-secured puts, covered calls all deferred to a separate
      risk-reviewed workstream. **Per-vehicle toggles**: equity_long
      defaults ON; every option archetype (long_call, long_put,
      vertical_spread, leaps, straddle, moonshot) defaults OFF.
      **Daily owner email**: per-broker-account digest (trades,
      positions, day P&L, tomorrow's outlook). **User-mod handling**:
      revert SL/TP changes by default, accept user-initiated closes.
      **Prerequisite for BYOB** — must ship before third-party
      users connect their own broker. 7 phases (A→G), ~18 days
      total before BYOB launch; Phase G polish post-launch.

- [ ] **BYOB — Bring Your Own Broker.** Multi-user broker connect flow
      (Robinhood + IBKR per-user). Plan:
      [2026-06-01-byob-broker-connect-plan.md](2026-06-01-byob-broker-connect-plan.md).
      Bridge architecture is already multi-user-ready (per-user storage,
      OAuth, encrypted tokens, risk caps, audit log all live). What's
      missing: user-facing Connect-Broker UI, Robinhood OAuth wiring,
      IBKR per-user wizard, compliance + risk controls. **Depends on
      Trade-Aware Mirror Sync (above)** — letting third-party users
      connect their own broker requires lock-tight trade-level
      isolation. 4-phase rollout estimated 4-6 weeks of focused work
      + parallel legal review.

---

## Strategic plans (one-shot, recently shipped)

| Plan | Status |
|---|---|
| [2026-05-30-ibkr-auto-execution-plan.md](2026-05-30-ibkr-auto-execution-plan.md) | Shipped (IBKR live; auto-mirror policy + audit live) |
| [2026-05-29-broker-bridge-phase1-plan.md](2026-05-29-broker-bridge-phase1-plan.md) | Phase 1 shipped |
| [2026-05-29-session-handoff.md](2026-05-29-session-handoff.md) | Historical reference |
| [2026-05-28-today-page-redesign.md](2026-05-28-today-page-redesign.md) | Shipped + refined through 2026-05-30 |
| [2026-05-28-cio-signal-enrichment-plan.md](2026-05-28-cio-signal-enrichment-plan.md) | Shipped |
| [2026-05-28-opportunity-surface-plan.md](2026-05-28-opportunity-surface-plan.md) | Shipped |
| [2026-05-28-right-rail-catalysts-tab-plan.md](2026-05-28-right-rail-catalysts-tab-plan.md) | Shipped |
| [2026-05-28-discovery-phases-2-3-4a-5-plan.md](2026-05-28-discovery-phases-2-3-4a-5-plan.md) | Shipped |
| [2026-05-28-cio-shadow-to-live-audit.md](2026-05-28-cio-shadow-to-live-audit.md) | Shipped (live + replay separation in `ai_cio_decisions`) |
| [2026-05-28-admin-nav-cleanup-plan.md](2026-05-28-admin-nav-cleanup-plan.md) | Shipped |
| [2026-05-28-dmarc-runbook.md](2026-05-28-dmarc-runbook.md) | Operational runbook (keep) |
| [2026-05-28-dell-stale-and-earnings-radar-miss.md](2026-05-28-dell-stale-and-earnings-radar-miss.md) | Fixed + lesson logged |
| [2026-05-28-robinhood-agentic-trading-research.md](2026-05-28-robinhood-agentic-trading-research.md) | Research; feeds bridge-phase2 |
| [2026-05-27-cio-candles-shortrank-plan.md](2026-05-27-cio-candles-shortrank-plan.md) | Shipped |
| [2026-05-27-three-week-live-review.md](2026-05-27-three-week-live-review.md) | Historical reference |

---

## Backlog (pull from here when current work clears)

### Operability

- [ ] Migrate main → bridge fetch to Service Bindings (resolves CF 1042 above).
- [ ] Add a "worst stale ticker" alert that wakes someone if it exceeds 24h
      (currently only surfaced in Mission Control on visit).

### Strategy

- [ ] Multi-leg combo orders end-to-end in IBKR live (currently single-leg
      autopilot; combos defined in `worker/options-plays.js` but not
      auto-mirrored yet).
- [ ] Robinhood Agentic execution as bridge target #2 (research in
      `2026-05-28-robinhood-agentic-trading-research.md`).

### UX

- [ ] Investor email digest cadence — current is per-zone-enter; consider
      morning summary roll-up.
- [ ] Replace the alert() prompts that remain in `mission-control.html`
      (auto-flipped-gate banner) with the same inline-toast pattern used
      for review feedback.

---

## How to add a new task here

1. Use the **outermost section** (Open work / Strategic plans / Backlog).
2. Active items go under "Active" with a `[ ]` checkbox.
3. Shipped one-shots get moved into the "Strategic plans" table with a
   status, not deleted (they remain useful reference).
4. When a task ships AND is fully validated by the user, mark it `[x]`
   then move to the Strategic-plans table on the next session sweep.
