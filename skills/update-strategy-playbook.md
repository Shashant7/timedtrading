# Update Strategy Playbook (FSD publication → `worker/strategy-context.js`)

**WHEN to use:** A new editorial-inspiration publication has landed
(Fundstrat Direct Daily Technical Strategy, weekly recap, mid-year update,
2026 Year Ahead deck, or any equivalent research note) and we want its
rotation calls / sector reads / new risks reflected in the AI CIO, Daily
Brief, Right Rail strategy chip, and promotion-queue scoring.

**WHO this is for:** Any agent the operator hands a PDF to with "update
the playbook from this". Until the automated FSD-ingestion worker
ships ([tasks/2026-06-03-ai-cro-and-fsd-ingestion-plan.md](../tasks/2026-06-03-ai-cro-and-fsd-ingestion-plan.md)),
this is the manual flow.

**Prerequisites:**

- PDF file accessible in the repo (operator drops it under `docs/` or
  uploads via a branch push)
- `pypdf` installed (`pip3 install pypdf` if missing — already on the
  agent VM after PR #446)
- Wrangler authenticated (already configured on the agent VM)

---

## Sequence summary

1. Classify: **tactical overlay** vs **structural revision**
2. Extract text + summarize the actionable signals
3. Move + rename the PDF to `docs/reference-pdfs/`
4. Edit `worker/strategy-context.js` (the rules differ by classification)
5. Bump the vintage-history block in the header comment
6. Smoke-test `getStrategyBrief()` + per-ticker matching locally
7. Update `CONTEXT.md` "Active Strategy Playbook" section
8. Deploy worker to BOTH envs
9. Verify `/timed/strategy` reflects the new vintage

A complete worked example: PR #446 (vintage `2026-06-02`, Daily
Technical Strategy "Time to Favor Equal-Weighted SPX over Cap-Weighted").

**CRO re-ingest (listeners beyond the playbook file):** after a manual
structural bump, also re-ingest the source PDF so CRO/D1/KV listeners
stay aligned:

```bash
TIMED_API_KEY=... node scripts/cro-ingest-pdf-blob.js \
  --pdf docs/reference-pdfs/20260611-Sector-Allocation-June.pdf \
  --title "June 2026 Sector Allocation Update" \
  --extract --apply
```

Or re-fetch an existing FSD pub (now PDF-attachment aware):

```bash
curl -s -X POST "$BASE/timed/admin/cro/fsd/ingest" \
  -H "X-API-Key: $TIMED_API_KEY" -H "Content-Type: application/json" \
  -d '{"pub_id":"1535789","force":true}'
```

---

## 1. Classify the publication

| Publication type | Classification | What to bump |
|---|---|---|
| Daily Technical Strategy (Mark Newton-style daily note) | **tactical** | `STRATEGY_TACTICAL_VINTAGE`, `TACTICAL_SIGNALS[]`, refresh affected theme/sector playbook strings, append risks if needed |
| Weekly Strategy Roundup | **tactical** (usually) — multiple signal revisions in one note | same as daily — just more `TACTICAL_SIGNALS[]` entries |
| Year Ahead deck / Mid-Year refresh | **structural** | `STRATEGY_VINTAGE`, `STRATEGY_HEADLINE`, `STRATEGY_PHASE`, `SECTOR_TILTS{}`, `THEME_TILTS{}`, `SIZE_TILTS`, `CATALYST_WEIGHTS`, `ACTIVE_RISKS`, `EDUCATION_SNIPPETS` |
| Major thesis shift (e.g. "we are now BEAR for H2") | **structural** | bump both vintages; redo `STRATEGY_HEADLINE`, `STRATEGY_PHASE.scenario_weights`, sector stances |

**Rule of thumb:** if the publication argues sector/theme **stance**
changes (overweight → neutral, etc.), it's structural. If it argues
**timing** within an existing stance (TD setups, trendline breaks,
relative-strength inflections, "favor X over Y on any pullback"),
it's tactical.

---

## 2. Extract text + summarize the signals

```bash
PDF="docs/<filename>.pdf"
python3 << EOF > /tmp/pub_text.txt
from pypdf import PdfReader
r = PdfReader("${PDF}")
for i, p in enumerate(r.pages):
    print(f"\n===== PAGE {i+1} =====")
    print(p.extract_text())
EOF
head -c 8000 /tmp/pub_text.txt
```

Read the extracted text. Write a short summary of each actionable
signal in this exact shape (one row per signal):

```
signal_name | pair | direction | horizon | evidence (1 line) | playbook action (1-3 sentences) | affected tier-1 themes | affected overweight sectors
```

Example from PR #446:

```
rsp_spy_breadth_breakout | RSP/SPY | favor_equal_weight_over_cap_weight | intermediate | Daily RSP/SPY ratio broke its short-term multi-month downtrend, turning up from multi-month lows | Lean toward equal-weight + lagging non-Tech groups (Industrials, Healthcare, Financials, Consumer Discretionary) | banks_money_center, banks_regional, oil_gas, metals_miners | Industrials, Financials, Consumer Discretionary
```

This is the JSON-ready shape that goes straight into `TACTICAL_SIGNALS[]`.

---

## 3. Move + rename the PDF

```bash
cd /workspace
git mv "${PDF}" "docs/reference-pdfs/YYYYMMDD-<Short-Descriptive-Slug>.pdf"
# Naming convention matches existing inventory:
#   20260423-Market-UpdatevFSD-1.pdf
#   20260529-STRATEGYMarketingDeckvFSD.pdf
#   20260602-Daily-Technical-Strategy-Equal-Weight-Rotation.pdf
ls docs/reference-pdfs/
```

Commit this rename as its own commit — separates the "I received the
source material" change from the "I encoded its conclusions" change.

---

## 4. Edit `worker/strategy-context.js`

> **CRITICAL: the file is ~700 lines but `StrReplace` has a known
> partial-failure mode on this file** (silent success returns but no
> change applied — see CONTEXT.md "Editing tactic"). Use Python `replace`
> with an `occurrences == 1` guard for every edit. The exact pattern
> used in PR #446 is reproduced below.

### 4a. Bump the vintage(s)

For a **tactical** update:

```js
export const STRATEGY_TACTICAL_VINTAGE = "YYYY-MM-DD";
export const STRATEGY_TACTICAL_SOURCE  = "<Daily Technical Strategy · M/D/YYYY>";
export const STRATEGY_TACTICAL_TITLE   = "<1-line headline of today's rotation call>";
```

For a **structural** update also bump `STRATEGY_VINTAGE` and update
`STRATEGY_HEADLINE` + `STRATEGY_PHASE` to match the new deck.

### 4b. Replace (or extend) `TACTICAL_SIGNALS[]`

For a tactical publication, **replace the whole array** — yesterday's
signals shouldn't ghost-haunt the LLM after today's note supersedes them.
If today's publication only refreshes some signals and leaves others
standing, copy the still-relevant ones from the previous version with
their original wording.

Each entry MUST carry: `signal`, `pair`, `direction`, `horizon`,
`evidence`, `playbook_action`, `affected_tier1_themes`,
`affected_sectors_overweight`. The CIO Layer 15b matcher joins on the
latter two fields — getting them wrong silently drops the signal from
per-ticker memory.

Also bump `STRATEGY_PHASE.tactical_overlay` to a 1-sentence headline.

### 4c. Refresh affected theme & sector playbook strings inline

For every theme or sector mentioned in the new publication, append a
parenthetical `(tactical M/D: <one-liner>)` to the existing `playbook`
string in `THEME_TILTS` / `rationale_long` in `SECTOR_TILTS`. Reason:
some CIO memory consumers only read Layer 15 (`strategy_stance`) and
never see Layer 15b — keeping the inline note guarantees the timing
context lands even on the cheaper code path.

Don't change `stance` or `multiplier` for a tactical-only publication.
If you find yourself wanting to, it's structural; re-classify and stop.

### 4d. Append (don't replace) `ACTIVE_RISKS`

New risks the publication flags (e.g. "MAG7 trendline break", "breadth
divergence", "crypto-equity decoupling") get appended at the end of
the array with `severity: "low"`, `"medium"`, or `"high"`. Use
`"medium"` by default; reserve `"high"` for risks the publication
itself calls out as immediately actionable (e.g. "active black swan").

### 4e. Append (don't replace) `EDUCATION_SNIPPETS`

If the publication uses jargon a non-Saty/non-DeMark user wouldn't
recognize, add a snippet. PR #446 added: *Equal-weight vs cap-weight
(RSP/SPY)*, *TD Buy Setup / TD Sell Setup (DeMark)*, *Magnificent Seven
(MAGS / MAG7)*, *Broadening rotation*.

### 4f. `getStrategyBrief()` — usually no edit needed

The brief renders `TACTICAL_SIGNALS` automatically via `.map(...)`.
Only edit if you added a new top-level field that should appear in the
brief header (rare).

### 4g. The Python-edit safety pattern

```python
python3 << 'PYEOF'
path = '/workspace/worker/strategy-context.js'
with open(path) as f: src = f.read()
edits = [
  ("vintage_bump", '<EXACT 3-5 lines around the old value>', '<the new 3-5 lines>'),
  ("tactical_signals_array", '<exact old TACTICAL_SIGNALS = [...]>', '<new array>'),
  # ...
]
fail = []
for name, o, n in edits:
    c = src.count(o)
    if c == 1:
        src = src.replace(o, n); print('OK', name)
    else:
        fail.append((name, c)); print('FAIL', name, 'occurrences=', c)
if fail: raise SystemExit(f'aborted: {fail}')
with open(path, 'w') as f: f.write(src)
PYEOF
```

---

## 5. Bump the vintage-history block in the header comment

The comment block near the top of `worker/strategy-context.js` is the
canonical changelog. Add a new entry at the TOP of the `Vintage history`
section (most-recent-first):

```
//   YYYY-MM-DD (current)
//     <Publication title>. <1–4 line summary of what changed and why.>
```

Move the previous "(current)" entry's annotation off `(current)`. This
takes 10 seconds and is the only reason a future agent can answer
"what was in the 2026-06-02 vintage?" without grepping git log.

---

## 6. Smoke-test locally before deploying

```bash
cd /workspace && node --check worker/strategy-context.js && node --check worker/cio/cio-memory.js && echo SYNTAX_OK

# Render the brief that goes into CIO + Daily Brief prompts.
node --input-type=module -e "
import('./worker/strategy-context.js').then(m => {
  console.log('vintage:', m.STRATEGY_VINTAGE);
  console.log('tactical vintage:', m.STRATEGY_TACTICAL_VINTAGE);
  console.log('---');
  console.log(m.getStrategyBrief());
}).catch(e => { console.error(e); process.exit(1); });
" | head -50
```

Check:

- Vintages reflect the new values
- Headline + sector/theme strings include the new (tactical M/D) notes
- The `TACTICAL SIGNALS` section appears in the brief and lists every
  signal you just encoded
- `ACTIVE RISKS` includes any newly appended risks

Then verify per-ticker matching (Layer 15b) against representative
tickers from each affected theme:

```bash
node --input-type=module -e "
import('./worker/strategy-context.js').then(m => {
  const cases = [
    ['NVDA', 'Information Technology', ['ai_infra_compute', 'ai_infra_semicap']],
    ['XLI',  'Industrials',            ['ai_infra_energy']],
    ['IBIT', 'Financials',             ['crypto_etf']],
    ['JPM',  'Financials',             ['banks_money_center']],
  ];
  for (const [sym, sector, themes] of cases) {
    const strat = m.getStrategyForTicker(sym, { sector }, () => themes);
    const tact  = m.getTacticalSignals();
    const tickerThemes = strat.themes_matched.map(x => x.theme);
    const matches = tact.signals
      .filter(s => (s.affected_tier1_themes||[]).some(t => tickerThemes.includes(t))
                || (s.affected_sectors_overweight||[]).includes(sector))
      .map(s => s.signal);
    console.log(sym, '[' + sector + ']', '->', matches.join(', ') || '(no matches)');
  }
});
" 2>&1 | grep -v 'MODULE_TYPELESS\|Reparsing\|To eliminate\|trace-warnings'
```

Each ticker that *should* get the new signal must show it. If a signal
is missing on a ticker you expected, check the `affected_tier1_themes`
+ `affected_sectors_overweight` keys for typos.

---

## 7. Update CONTEXT.md "Active Strategy Playbook" section

Replace the "Current tactical overlay (...)" paragraph at the bottom of
that section with a 2–4 line summary of the new tactical reads. Don't
edit other sections of CONTEXT.md in the same PR — that file is
notoriously merge-conflict-prone (see workspace rules).

---

## 8. Deploy worker to BOTH envs

```bash
cd /workspace && node scripts/embed-dashboard.js 2>&1 | tail -1
cd /workspace/worker && ../node_modules/.bin/wrangler deploy --env="" 2>&1 | tail -5
cd /workspace/worker && ../node_modules/.bin/wrangler deploy --env production 2>&1 | tail -5
```

---

## 9. Verify live `/timed/strategy`

```bash
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/strategy" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('vintage:', d.get('vintage'))
print('tactical.vintage:', d.get('tactical', {}).get('vintage'))
print('tactical.title:', d.get('tactical', {}).get('title'))
for s in d.get('tactical', {}).get('signals', []):
    print(' -', s['signal'], '->', s['direction'])
"
```

`vintage` and `tactical.vintage` must match what you bumped. Every
signal you added must appear in the listing.

---

## Common pitfalls

- **StrReplace partial-fail on this file.** Use the Python `replace`
  pattern from §4g; trust nothing the tool prints. After any edit,
  `grep -n STRATEGY_VINTAGE /workspace/worker/strategy-context.js` to
  visually confirm the new value is the only occurrence.
- **Forgetting to bump the header vintage-history comment.** The code
  works fine without it, but future agents lose the changelog.
- **Bumping `STRATEGY_VINTAGE` for a tactical-only publication.** The
  two vintages are intentionally decoupled — touching the structural
  one signals to all downstream consumers (including
  reference-intel drift monitors) that the Year-Ahead deck has been
  revised. Don't lie to them. Tactical-only = bump only
  `STRATEGY_TACTICAL_VINTAGE`.
- **Skipping the per-ticker Layer 15b smoke test.** A typo in
  `affected_tier1_themes` silently drops the signal from the CIO's
  per-ticker memory. The downstream symptom is "the CIO ignored the
  new playbook for NVDA all week" — find it before it costs trades.
- **Deploying to only the default env.** Production has a separate
  worker binding. Both deploys must succeed.
- **Skipping `node scripts/embed-dashboard.js` before the deploy.**
  Wrangler will fail with `Could not resolve "./dashboard-html.js"`.

---

## Source map

- `worker/strategy-context.js` — playbook source of truth
- `worker/cio/cio-memory.js` — Layer 15 `strategy_stance` + Layer 15b
  `tactical_signals`
- `worker/cio/cio-prompts.js` — opens with `getStrategyBrief()`
- `worker/daily-brief.js` — morning + evening prompts open with
  `getStrategyBrief()`
- `worker/discovery/promotion-queue.js` — boosts tier-1 theme candidates
- `worker/index.js` — `/timed/strategy` endpoint returns
  `getStrategyDigest()`
- `docs/reference-pdfs/` — source-material inventory
- [tasks/2026-06-03-ai-cro-and-fsd-ingestion-plan.md](../tasks/2026-06-03-ai-cro-and-fsd-ingestion-plan.md)
  — the design for automating steps 1–4 so this skill can shrink to
  "operator approves the proposed diff"

## Related lessons

- PR #446 — first execution of this skill end-to-end; reference for
  the exact diff shape and the per-ticker matching outputs
