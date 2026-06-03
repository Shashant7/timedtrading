# AI CRO + Automated FSD Ingestion — Design & Phased Plan

**Filed:** 2026-06-03 (by request after PR #446 landed the manual
playbook-update flow as a vintage bump)

**Owner:** Operator (Shashant) + whichever agent picks up the next
phase

**Companion skill:** [skills/update-strategy-playbook.md](../skills/update-strategy-playbook.md)
— the manual flow this plan eventually automates.

## TL;DR

Build a **third executive agent — AI CRO (Chief Research Officer)** —
that sits alongside AI CIO + AI COO. The CRO's job is **research +
context**, not trade approval. It runs on its own cron, synthesizes
five inputs into a single daily research note, and publishes that
note into the same memory cache the CIO + COO already read from
plus a new operator-facing surface.

The five inputs:

1. **FSD intel** (primary editorial inspiration) — automated daily
   scrape of new Fundstrat Direct publications, LLM-extracted into
   the same `TACTICAL_SIGNALS[]` shape `worker/strategy-context.js`
   already consumes.
2. **Cross-asset macro** (`worker/macro/cross-asset-tracker.js`) —
   USD / Gold / Oil / NatGas / Rates / Credit drift; existing module.
3. **Sector + theme rotation** — pairwise relative-strength
   computation (RSP/SPY, IGV/SMH, XLI/SPY, XLE/XLY, semis breadth,
   materials breadth, etc.). New compute.
4. **Correlation cluster moves** — "are all semis moving together?",
   "are materials all bid?", "are Mag-7 still correlated or
   decoupling?". New compute on top of existing `timed_trail`.
5. **Discovery + social + screener pulse** — the "what is the rest
   of the system seeing that the playbook doesn't yet?" view, built
   on `worker/discovery/{news,insider,social,move-discovery}.js` +
   the existing screener.

CRO output:

- Written to KV `timed:cro:daily-note:{YYYY-MM-DD}` and `timed:cro:latest`
- Read by `buildCIOMemory()` as **Layer 15c** (research note for the
  CIO)
- Read by `buildCOOPlan()` as one of the strategic context inputs
- Exposed at `GET /timed/cro/latest` + a CRO tab on `/insights.html`
- Daily Brief opens with a CRO summary alongside the existing
  `getStrategyBrief()`

Build is **phased** — each phase ships value standalone, so we don't
have to commit to the full architecture up front.

---

## Why a "CRO" and not "extend CIO/COO"

| Role | Decision horizon | Owns | Sees |
|---|---|---|---|
| **CIO** | per-trade (entries, trims, exits) | trade-level memory, regime, exit doctrine | structural playbook + per-ticker history |
| **COO** | system-wide (gates, throttles, breakers) | model_config / gates, auto-apply tier-1 changes | runtime health + recent performance |
| **CRO** *(new)* | per-day (what is the world telling us today) | research note → editorial context | upstream publications + cross-asset + rotation + correlation + discovery |

The CIO and COO already have full prompts; bolting "scrape FSD + run
correlation cluster + summarize sector rotation" onto either of them
adds latency, blows the prompt budget, and conflates research with
decision. CRO is the natural seam — same separation of concerns as
buyside firms, where the research desk briefs PMs but doesn't trade.

Critically, the CRO does NOT override the engine. The engine still
trades the bubble map / setups / backtest-proven configs. The CRO
informs the **explanation, sizing bias, and timing weight** that the
CIO + COO apply on top — same role `worker/strategy-context.js`
plays today, just with daily fresh inputs and a richer compute
substrate.

---

## What we already have (don't re-build)

| Capability | Module | Notes |
|---|---|---|
| Structural playbook (sector / theme / SMID / risks / education) | `worker/strategy-context.js` | The CRO writes tactical updates here via the same skill-driven flow |
| Cross-asset macro snapshot | `worker/macro/cross-asset-tracker.js` (`runMacroSnapshot`, `loadMacroSnapshot`) | Already cached in KV; CRO just reads it |
| Theme activity (per theme: peer movers, net move %) | `worker/sector-mapping.js` (`computeThemeActivity`) | Existing, called per-ticker; CRO calls per-theme universe-wide |
| Per-ticker themes lookup | `worker/sector-mapping.js` (`getThemesForTicker`) | Existing |
| News + sentiment | `worker/discovery/news-tracker.js` (`loadRecentNewsSummary`) | Existing per-ticker; aggregated cross-universe scoring needs new compute |
| Insider activity | `worker/discovery/insider-tracker.js` (`loadRecentInsiderSummary`) | Existing |
| Social sentiment | `worker/discovery/social-tracker.js` (`loadSocialSummary`, `loadSocialSummariesBatch`) | Existing |
| Move discovery (gap-up surprise list) | `worker/discovery/move-discovery.js` (`runMoveDiscovery`) | Existing |
| Promotion queue (composite candidate score) | `worker/discovery/promotion-queue.js` (`rebuildPromotionQueue`) | Existing |
| Markov + HMM regime forecasts | `worker/lib/regime-{markov,hmm,markov-compute,hmm-compute,markov-policy}.js` | Existing; surfaces via CIO Layer 8 |
| Reference-intel artifacts | `data/reference-intel/`, `scripts/reference-*.py` | Existing offline pipeline; CRO can later consume the `cio-memory-features-v1.json` payload too |
| KV cache pattern | `KV.get/put` with `expirationTtl` | Existing across codebase |
| CIO memory builder | `worker/cio/cio-memory.js` | Already has 16 layers; CRO output drops in as a new layer |

The CRO is mostly **glue + LLM** on top of existing primitives. The
genuinely new compute is sector-rotation pairwise RS + correlation
clusters + the FSD scrape/parse path.

---

## Phase plan

Each phase ships in its own PR. Operator can pause / re-prioritize
between phases. Order is chosen so every phase produces standalone
value, not just plumbing.

### Phase 0 — Credentials hygiene (DONE)

- `FSD_USERNAME` + `FSD_PASSWORD` added as Cloudflare Worker secrets
  to both default + production envs.
- **Action item still on the operator:** the password value was
  visible in plaintext in the chat that requested this plan. Rotate
  the FSD password and re-run `wrangler secret put FSD_PASSWORD`
  for both envs. Until then, treat the in-use value as
  known-compromised.

### Phase 1 — Skill for manual PDF flow (DONE in this PR)

- [skills/update-strategy-playbook.md](../skills/update-strategy-playbook.md)
  codifies the workflow PR #446 invented. Any agent the operator
  hands a PDF to can now run the flow end-to-end without
  re-discovering it. This is the fallback path forever — even after
  automation lands, sometimes the operator just wants to feed in a
  one-off publication.

### Phase 2 — FSD authenticated fetch + raw archive

**Goal:** be able to pull a list of new publications and download
their PDFs without operator intervention.

**Risk:** Fundstrat Direct ToS. Their PDFs disclaim "research cannot
be shared or redistributed". A single subscriber using their own
credentials to automate their own personal workflow is the operator's
call to make; we don't redistribute the PDFs outside the operator's
own infrastructure. Archive PDFs in R2 with `private` ACL — never
served publicly, never embedded in user-facing UI.

**Components:**

- New module: `worker/cro/fsd-client.js`
  - `loginFSD(env)` — POST to FSD login form using `env.FSD_USERNAME`
    + `env.FSD_PASSWORD`; capture the session cookie. Cache the
    cookie in KV for the duration FSD honors it (probably 24h);
    re-login on 401.
  - `listFSDPublications(env, {since})` — fetch the publications
    index, return `[{id, title, published_at, url}]`.
  - `fetchFSDPublicationPDF(env, pubId)` — GET the PDF, return
    `ArrayBuffer`.
- New R2 binding `FSD_ARCHIVE` (private) — store each PDF under
  `fsd/<published_at_iso_date>-<pubId>.pdf`. Operator can still
  inspect via `wrangler r2 object get`. The repo's `docs/reference-pdfs/`
  stays the operator-curated subset for inspirations we want
  long-term reference for.
- New D1 table `fsd_publications` (id, title, published_at,
  source_url, r2_key, fetched_at, fetch_error). Source of truth for
  "have we already ingested this?".
- New cron: `0 13 * * 1-5` (one tick after the morning FSD publish
  window) — calls `runFSDIngestion(env)` which lists + diff-fetches.

**Exit criteria:**

- Operator can hit `GET /timed/admin/cro/fsd/recent` and see the
  last N publications with title + published_at + r2_key.
- Discord alert fires on any consecutive `fetch_error >= 2` for a
  given pub.
- Login flow exits cleanly with a structured `{error_kind}` payload
  on FSD ToS pages, password change, MFA prompt, etc. — never silently
  scrapes the wrong page.

**Non-goals in this phase:** no parsing, no playbook update, no UI.
Just clean fetch + archive.

### Phase 3 — LLM extraction → proposed playbook diff

**Goal:** convert a raw PDF into a structured proposal the operator
can approve in one click.

**Components:**

- New module: `worker/cro/fsd-extractor.js`
  - `extractPublicationToProposal(env, pdfBuffer, currentPlaybook)` —
    runs the PDF through `pypdf` (or Cloudflare Workers AI's PDF
    extractor if simpler), then through `gpt-4o-mini` (or current
    cheapest with JSON mode) with a strict schema prompt:
    ```
    Return JSON {
      classification: "tactical" | "structural",
      tactical_signals_add: [<TACTICAL_SIGNALS schema rows>],
      theme_playbook_updates: [{theme, tactical_note}],
      sector_playbook_updates: [{sector, tactical_note}],
      active_risks_add: [<ACTIVE_RISKS rows>],
      education_snippets_add: [<EDUCATION_SNIPPETS rows>],
      vintage_history_entry: <prose>,
      one_line_phase_tactical_overlay: <string>,
      // For STRUCTURAL only:
      sector_stance_changes: [...],
      theme_stance_changes: [...],
      strategy_headline_revision: <string|null>,
      strategy_phase_revision: {...} | null,
    }
    ```
  - The prompt grounds the extractor in `getStrategyDigest()` so the
    LLM uses our exact taxonomy (theme keys, sector names, signal
    shape) instead of inventing fresh ones.
- New D1 table `playbook_proposals` (publication_id, proposal_json,
  status enum {pending, approved, rejected, applied}, created_at,
  decided_at, decided_by).
- New endpoints:
  - `POST /timed/admin/cro/proposal/generate` — extract from a given
    publication.
  - `GET /timed/admin/cro/proposal/pending` — list awaiting approval.
  - `POST /timed/admin/cro/proposal/approve` — applies the diff
    (Phase 4).
  - `POST /timed/admin/cro/proposal/reject` — marks rejected with a
    note.

**Exit criteria:**

- Operator can run `POST .../proposal/generate?publication_id=<id>`
  and read back a structured JSON proposal in <30s.
- Re-running on the 6/2 PDF reproduces approximately the same
  `TACTICAL_SIGNALS[]` PR #446 hand-crafted. Establish this as a
  fixture-based regression test in `worker/cro/fsd-extractor.test.js`.

### Phase 4 — Auto-apply (operator-gated) → playbook PR

**Goal:** approve in one click; the system creates a PR with the
diff and deploys when merged.

Two flavors of "apply":

- **In-worker apply** (fast path) — for tactical-only proposals: a
  separate KV-backed override `cro:tactical_overrides` that the
  `getTacticalSignals()` helper merges on top of the source code's
  `TACTICAL_SIGNALS[]`. No deploy needed. Reverting = `KV.delete`.
- **Source-of-truth apply** (canonical) — for any proposal flagged
  `structural`, or for tactical updates the operator wants
  permanently encoded: a GitHub PR opened automatically against
  `main` with the diff to `worker/strategy-context.js`, the PDF
  renamed into `docs/reference-pdfs/`, and the vintage-history
  comment block updated. Operator reviews, merges; Cloudflare Pages
  + a CI job redeploy the worker.

Gate `auto_apply_tactical_kv_override` defaults to **off**. Until the
operator turns it on, every approval still routes through the PR path
so a human sees the diff.

### Phase 5 — Sector rotation + correlation cluster compute

**Goal:** compute what FSD computes (RSP/SPY trend break, theme
correlation, "are all semis bid?") locally, so the CRO can corroborate
or contradict the FSD read with the operator's own universe.

**Components:**

- New module: `worker/cro/rotation-engine.js`
  - `computePairwiseRS(env)` — for a configured list of pairs
    (RSP/SPY, IGV/SMH, XLI/SPY, XLE/XLY, XLF/SPY, MAGS/SPY,
    QQQ/IWM, country-rotation pairs), compute the daily ratio series
    over a rolling 250d window, fit a trendline + RSI + 20d ROC.
    Emit `{pair, ratio_now, ratio_20d_ago, trend_state ∈
    {breaking_up, breaking_down, stable_up, stable_down, choppy},
    td_setup_state}`.
  - `computeThemeBreadth(env)` — for each theme in `THEMES`,
    compute % of constituents up >1% today, >5% W/W, >10% M/M.
    Flag "all bid" themes (>70% constituents up >1% today) and
    "all offered" themes (mirror image).
  - `computeCorrelationClusters(env, {window: 20})` — pairwise
    20d-rolling correlation across the universe; cluster tickers
    that move ≥0.7 correlated. Surface clusters that recently
    formed (correlation rising) or recently broke (correlation
    falling). This is the "are MAG7 still correlated or decoupling?"
    read.
- Cache the full rotation+breadth+cluster snapshot in KV
  `timed:cro:rotation-snapshot` (TTL 30 min, refreshed every cron tick
  via a 5-min cron).

**Exit criteria:**

- Operator can hit `GET /timed/cro/rotation` and see today's
  `RSP/SPY: breaking_up, slope_30d: +0.04, td_setup: countdown_7_of_13`
  — directly comparable to what Mark Newton publishes.
- `correlation_clusters.formed_today` ≥ 1 on most market days for the
  liquid universe — establish that the compute actually fires.

### Phase 6 — CRO worker module + daily research note

**Goal:** synthesize Phases 2–5 + the existing discovery / social /
news inputs into a single daily research note, structured for
machine and human consumption.

**Components:**

- New module: `worker/cro/cro-service.js`
  - `runCRODaily(env, {asOfDate})` — sequence:
    1. Load latest FSD intel (Phase 3 extractions for any publications
       since last run).
    2. Load `loadMacroSnapshot()` (existing).
    3. Load rotation snapshot from Phase 5.
    4. Load `loadRecentNewsSummary` for the top-N universe and
       summarize aggregate sentiment + top cross-ticker catalysts.
    5. Load aggregate social + insider top-N from existing trackers.
    6. Load `runMoveDiscovery` output + promotion-queue top 20.
    7. Build a single LLM prompt:
       ```
       Synthesize today's research note. Sections:
       A. What FSD is saying (raw extract)
       B. What the tape is corroborating / contradicting (rotation
          snapshot + breadth + correlation clusters)
       C. Early indicators (cross-asset vol, sector rotation
          inflections, theme correlation births/deaths)
       D. Where the discovery + social + screener layer is pointing
          (tickers in motion the playbook doesn't yet cover)
       E. CRO verdict — a short paragraph the CIO + COO can lean on.
       Constraint: do NOT propose stance changes; that's the
       Playbook PR flow. Surface OBSERVATIONS and IMPLICATIONS only.
       ```
    8. Persist to KV `timed:cro:daily-note:{YYYY-MM-DD}` +
       `timed:cro:latest`. Also archive to D1 `cro_daily_notes`
       (with the full prompt + completion for replay / audit).
- New cron: `0 12 * * 1-5` (after FSD ingestion at 13:00 UTC and
  before the morning brief at 13:00 UTC ET... pick a window the
  operator wants; 11:30 ET / 15:30 UTC is a reasonable default so the
  9 AM ET morning brief picks it up).

**Exit criteria:**

- `GET /timed/cro/latest` returns yesterday's (or today's if past
  cron) note as JSON + Markdown.
- `runCRODaily` produces ≤ ~3 KB of text — small enough to ship in
  the CIO + Daily Brief prompts without blowing the budget.

### Phase 7 — Wire CRO into CIO + COO + Daily Brief

**Goal:** the existing decision-makers actually consume the CRO note.

**Components:**

- `worker/cio/cio-memory.js`:
  - Add **Layer 15c** `cro_research_note` (after Layer 15b
    `tactical_signals`). Pulls from `timed:cro:latest`, attaches the
    `verdict` paragraph + the top 3 observations as a short JSON
    block to the per-ticker memory.
- `worker/cio/cio-prompts.js`:
  - System prompt evaluation order updated: add CRO between
    `**PLAYBOOK + STRATEGY STANCE**` and `MACRO TILT`.
- `worker/coo/coo-orchestrator.js`:
  - On each gate-tier evaluation, load the CRO verdict and surface it
    in the proposed-change rationale.
- `worker/daily-brief.js`:
  - `getStrategyBrief()` already opens both prompts; add a small
    `getCROBriefAddendum()` (new export) that injects 3–6 lines of
    "CRO today" right after the strategy block. Both morning + evening
    pick it up.

**Non-goals:** the CRO doesn't decide trades; CIO still approves /
rejects, COO still tunes gates. The CRO is an input, not an authority.

### Phase 8 — UI surface

**Goal:** operator + Pro user can read today's CRO note in plain
language.

**Components:**

- `/timed/cro/latest` endpoint (public-ish, behind `requireUser`).
- New tab on `insights.html`: "Research Desk" — renders the CRO note
  in Markdown with the source-attribution chips (FSD, our rotation
  engine, our discovery layer). Admin sees the underlying JSON for
  debugging.
- Right Rail "Active Strategy" chip gets a small "Today's CRO note"
  link that opens the same panel.

### Phase 9 — Backtest + replay parity

**Goal:** when we replay an old trade, the CIO sees the CRO note that
was live on that date — not today's note (which is information leakage
from the future).

**Components:**

- `cro_daily_notes` D1 table is already the daily archive; replay
  loads `WHERE as_of_date = ?` from this table the same way the VIX
  daily candle loader does today (CONTEXT.md "Trades" section).
- `replay-ticker-d1` and the calibration replay pipeline both grow a
  `cro_note_at_entry` lineage field so post-trade autopsy can
  attribute "we trimmed early because the CRO note flagged
  cross-asset decoupling that morning".

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| FSD changes their login flow / site structure | `loginFSD` returns structured `{error_kind: 'login_form_changed' \| 'mfa_prompted' \| ...}`; cron failure tombstones surface fast via Discord; fall back to operator manually feeding the PDF via the Phase-1 skill. |
| FSD ToS / redistribution | Archive in private R2 only. Never serve PDFs to users. CRO note paraphrases / cites — does not reproduce material chunks. Operator owns the subscription so single-user automation is in-scope. |
| LLM hallucination in proposal extraction | Fixture-based regression test against PR #446's encoded signals. Schema-enforced JSON mode. Operator-in-the-loop approval flow before any change reaches `worker/strategy-context.js`. |
| Correlation/rotation compute cost | These compute on the existing `timed_trail` 5m aggregation; same data the Markov pipeline already reads. Bounded by universe size (~200 tickers) — well within CPU budget even at 5-min cron. |
| Prompt-budget bloat from a fourth context block | CRO note caps at ~3 KB. CIO + Daily Brief prompts today are ~6 KB combined — adding 3 KB takes us to ~9 KB, still well within `gpt-4o`'s 128k. Worst-case fallback: include CRO note only for entries that are NOT on-thesis (where the extra context has the highest marginal value). |
| Stance change embedded in a CRO note bypassing the playbook PR flow | Explicit prompt constraint: CRO does not propose stance changes. Any structural revision MUST go through the Phase-4 proposal flow (`/timed/admin/cro/proposal/...`). |
| Replay information leakage (CRO note from after trade date used at entry time) | Phase 9 builds the date-scoped archive + read path before CRO is wired into replay scoring. |

---

## Out of scope (explicitly)

- **Auto-trading on CRO output.** The CRO informs; the engine trades.
  CIO + COO are still the only voices that touch the trade loop.
- **Multi-publication-source aggregation.** This plan starts with FSD
  only. Adding more sources (Tom Lee's other channels, Zerohedge,
  Bloomberg headlines, etc.) is a separable PR and probably wants a
  source-quality weighting design first.
- **Real-time CRO updates.** Daily cadence matches the FSD publish
  cadence + the morning/evening brief cadence. Intraday CRO notes
  would require source signals that intraday-update at the same
  cadence; we don't have those today.

---

## Acceptance checklist (when the full plan is built)

- [ ] Operator can drop a new FSD publication URL and the worker
      ingests, extracts, and proposes a playbook diff in <2 minutes.
- [ ] Approving the proposal opens a PR that, once merged, redeploys
      the worker with the new vintage.
- [ ] `GET /timed/cro/latest` returns a daily research note covering
      the five inputs.
- [ ] CIO prompt includes the CRO verdict at Layer 15c.
- [ ] COO orchestrator surfaces the CRO verdict in its proposed-change
      rationale.
- [ ] Morning + evening Daily Briefs open with strategy block followed
      by a CRO addendum.
- [ ] Replay loads the historical CRO note for the trade date instead
      of today's; backtests are leakage-free.
- [ ] Operator can read the CRO note from the Insights "Research
      Desk" tab in plain English.
- [ ] `tasks/lessons.md` carries a postmortem of the first month of
      CRO drift vs. FSD ground truth.

---

## Open questions

1. **Cadence of FSD scrape** — 1×/day is the obvious default. Should
   it also fire intraday when FSD publishes a "Market Update"
   off-schedule? (Probably yes; ToS aside, the operator pays for
   the subscription.)
2. **R2 retention** — keep PDFs indefinitely (~10 MB/yr at current
   cadence — negligible) or roll-up after 1 year? Default: keep
   indefinitely; cheap insurance for backtest replay parity.
3. **Should the CRO have its own LLM model selection** (e.g. a
   reasoning-tuned model for the synthesis step) vs. reusing the
   same `gpt-4o-mini` the CIO uses? Performance question for
   Phase 6; not blocking earlier phases.
4. **Operator-approval channel** — Discord button via interaction
   webhook, or a row in Mission Control with "Approve / Reject"
   buttons? Both work. Default: Mission Control row, since the
   operator already lives there.
