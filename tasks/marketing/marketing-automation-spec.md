# Marketing Automation Spec (Batch 0.5)

> **Status:** spec only. Marketing-agent-owned. Implementation is operator-owned or an engineering-agent task (worker code is out of scope for the Marketing Agent).
>
> **Goal:** drive on-brand X content from live engine events with one-tap HITL approval on mobile, while guaranteeing the lifecycle commitment ("if we posted the entry, we will post the exit") through automated pairing.
>
> **Source of truth this builds on:** [`marketing-canonical-plan.md`](./marketing-canonical-plan.md) §7 ("The standing X agent"), [`batch-0/02-brand-voice-guide.md`](./batch-0/02-brand-voice-guide.md), [`x-queue-2026-05.md`](./x-queue-2026-05.md).

---

## 0. Operating principle

Automation handles **drafting** and **lifecycle bookkeeping**. HITL only happens at **one place — the publish button**. The operator's friction must collapse to: a Discord notification on the phone, ≈ 2 seconds to read, one tap. No copy writing on the operator's side, ever.

The brand promise is **continuity**: a publicly opened position will always be publicly closed. The system enforces this on rails so the operator's unavailability never breaks the contract.

---

## 1. Architecture

Three components. The first is new. The second already exists. The third is the cron runner specced in [`x-queue-2026-05.md`](./x-queue-2026-05.md).

```
ENGINE (read-only source)                                            
  │                                                                  
  │ events: ENTRY · TRIM · EXIT · SL_HIT · LANE_CHANGE · REJECT      
  │         · DAILY_BRIEF_PUBLISHED · WEEKLY_WRAP                    
  ▼                                                                  
┌──────────────────────────────────────────────────────────┐        
│ marketing-worker  (NEW · ~300-500 LoC Cloudflare Worker) │        
│                                                          │        
│  1. classify event → template id                         │        
│  2. fill template tokens from event payload              │        
│  3. fetch / generate visual asset                        │        
│  4. POST approval card to operator Discord channel       │        
│  5. listen for Discord interaction webhook               │        
│  6. on approve → write to x-queue.md (git commit) OR     │        
│     direct insert into a KV-backed queue                 │        
│  7. record trade_id ↔ post_id pairing in KV              │        
│  8. on engine exit event for paired trade_id, auto-draft │        
│     exit post with 30-min skip-window default-ship       │        
└──────────────────────┬──────────────────────────────────┘        
                       │                                            
                       ▼                                            
                 OPERATOR DISCORD                                   
                 (interactions API · approval card · phone)         
                       │                                            
                       ▼                                            
                ┌──────────────────────┐                            
                │ x-queue runner       │                            
                │ (cron · dumb)        │                            
                └──────────┬───────────┘                            
                           │                                        
                           ▼                                        
                       X API · post                                 
```

The marketing-worker subscribes to engine events but **cannot modify engine state**. This isolation is the safety property — worst case, wrong copy on social, fully recoverable.

---

## 2. The lifecycle-pairing trust contract

This is the bit that lets the operator step away without breaking the brand.

### Pairing rule

1. **Entry post is HITL-gated.** Operator must tap ✅ for the post to ship.
2. **Approving an entry post creates a `pending-exit` record** in KV, keyed by `trade_id`, with TTL = 90 days.
3. **When the engine fires `TRIM`, `EXIT`, or `SL_HIT` for that `trade_id`**, marketing-worker auto-drafts the matching exit/trim post and sends it to Discord — but with **inverted defaults**:
   - **30-minute skip-window.** If the operator doesn't tap 🚫 Skip within 30 min, the post auto-ships.
   - The buttons exposed are 🚫 Skip and 📝 Edit. The implicit Approve is "do nothing".
4. **If an entry never gets approved**, no pairing record is created, and downstream events silently no-op. Nothing leaks.
5. **Multi-event trades** (e.g. TP1 trim → TP2 trim → TP3 exit) produce **multiple paired posts**, each its own skip-window. The KV pairing tracks an array of `child_events`.

### What happens when the operator goes dark

| Operator state | New ENTRY events | Open `pending-exit` records |
|----------------|------------------|----------------------------|
| Online, < 24h since last interaction | HITL approval card fires normally | Auto-draft fires, 30-min skip window |
| Offline 24–72h | HITL card still fires but is auto-skipped if no response in 4h | Auto-draft fires; skip-window unchanged (30 min) |
| Offline > 72h | New entry post drafting **paused** | **Continues shipping** all open exit pairs |

The third row is the brand promise: a publicly opened position always gets a publicly closed post, regardless of operator availability. The system stops opening *new* publicly tracked trades once the operator is unreachable, but it always closes the ones it opened.

### Failure modes the contract handles

- **Operator approved an entry, then the trade closes overnight before they're online**: exit post auto-ships at next ET window (no overnight Skip-window — operator can't see it anyway).
- **Operator approved entry, trade is still open after 90 days**: KV record expires. Mark post lineage "abandoned-old" — do not auto-post a stale exit. Manual catch-up only.
- **Engine fires duplicate exit events**: idempotency on `trade_id + event_seq`. Second event is silently dropped.

---

## 3. The HITL approval card (Discord)

### Channel setup

- New private Discord channel: `#tt-marketing-approvals` (operator + bot only).
- Existing engine notification webhook continues to write to `#trade-log` unchanged. The marketing approval card is a separate stream.

### Card layout (Discord embed + interactive components)

```
┌──────────────────────────────────────────────────────────┐
│ 🟢 ENTRY · TSLA LONG · $440.99                            │
│ Setup: Gap Reversal Long (Prime, 100/100, conv 91/B)      │
│ AI CIO: ADJUST (83% conf, edge 76%) — macro CHOP, sized   │
│ down. Bull setup + caution, same alert.                   │
│                                                           │
│ ┌─ Drafted X post (340 chars) ───────────────────────┐    │
│ │ Model fired Long on TSLA at $440.99 a few minutes  │    │
│ │ ago. Setup: Gap Reversal Long (Prime grade, signal │    │
│ │ strength 100/100, conviction 91/B).                │    │
│ │ SL $436.40 · TP1 $463.55 · runner to $499.22.      │    │
│ │ R:R 3.5 to TP1.                                    │    │
│ │ … (full body) …                                    │    │
│ │ For informational and educational purposes only.   │    │
│ │ Past performance does not guarantee future results.│    │
│ │ Not investment advice.                             │    │
│ └────────────────────────────────────────────────────┘    │
│                                                           │
│ Visual:    live-trade-2026-05-28-tsla.png ✓ (generated)   │
│ Disclaimer: in body + image footer ✓                      │
│ Ship time:  now · 1:30 PM ET · 4:30 PM ET                 │
│ Paired-exit: ✓ will auto-draft when TP1/TP2/TP3/SL fires  │
│                                                           │
│ Drafted by marketing-worker at 12:38 ET                   │
└──────────────────────────────────────────────────────────┘

[ ✅ Ship now ]  [ ⏰ Queue next slot ]  [ 🚫 Skip ]
[ 📝 Edit copy ]  [ 👁 Full draft ]
```

### Button semantics

| Button | Action |
|--------|--------|
| ✅ Ship now | Insert at front of x-queue with `scheduled_for_et = now`. Mark card "shipped at HH:MM by @operator". |
| ⏰ Queue next slot | Insert at next available cadence slot per posting calendar. Mark card "queued for HH:MM". |
| 🚫 Skip | Drop the post. **For ENTRY posts**: also drop the pairing record (no future exit post will fire). **For TRIM/EXIT posts**: drop just this one — the trade is still publicly open, marketing-worker logs a "skipped-exit" warning for operator visibility. |
| 📝 Edit copy | Open Discord modal with the copy in a textarea. Save → re-render card with new copy and same buttons. |
| 👁 Full draft | Ephemeral message: full body + alt-text + visual preview + disclaimer + lifecycle commitments. No action. |

### Mobile ergonomics

Total operator decision time per card: ≈ 2 sec read + 1 tap. Discord renders embeds and interaction buttons well on iOS/Android. No second app, no second login, no second push channel.

---

## 4. Event → template mapping

Engine event types and their corresponding marketing templates.

| Engine event | Template id | Default behavior | Notes |
|--------------|------------|------------------|-------|
| `TRADE_ENTRY` (new position opened) | `entry` | HITL-gated, no default ship | Most common card. |
| `TRADE_TRIM` (TP1/TP2/TP3 partial fill) | `trim` | Auto-ship after 30-min skip window, **only if** paired entry was approved | "Engine fired Trim on X at +Y%." |
| `TRADE_EXIT_WIN` (full close, P&L > 0) | `exit-win` | Auto-ship after 30-min skip window, **only if** paired entry was approved | "Engine closed X at +Y% — runner played out." |
| `TRADE_EXIT_LOSS` (full close, P&L ≤ 0) | `exit-loss` | Auto-ship after 30-min skip window, **only if** paired entry was approved | **The trust post.** Always shipped if entry was public. |
| `LANE_CHANGE_DEFEND` (Hold → Defend) | `defend` | HITL-gated, no default ship | Optional — operator decides whether to surface mid-trade tension. |
| `LANE_CHANGE_INVESTOR` (Investor mode lane transition) | `investor-lane` | HITL-gated, no default ship | For Buy Zone → Hold & Watch → Reduce moves on watched names. |
| `TRADE_REJECTED` (entry filtered out) | `no-trade` | HITL-gated, no default ship | Used selectively for high-name rejections (NVDA, TSLA, AAPL). |
| `DAILY_BRIEF_PUBLISHED` (9 AM ET) | `daily-brief-headline` | **Auto-ship, no HITL** | Levels-only mirror, no subjective interpretation. |
| `WEEKLY_WRAP` (Fri 4 PM ET) | `weekly-wrap` | HITL-gated, default ship in 60 min | One subjective sentence; operator usually approves. |

---

## 5. Content templates

Every template returns a final string ≤ 4,000 chars (X premium tier) with an optional shorter `compact` variant ≤ 270 chars (free tier).

Token syntax: `{{token_name}}`. Missing required tokens cause the marketing-worker to abort the post and alert the operator (do not ship a partial draft).

### 5.1 `entry` template

```
Model fired {{direction}} on {{ticker}} at ${{entry_price}}.
Setup: {{setup_name}} ({{grade}}, signal {{signal_strength}}/100, conviction {{conviction_score}}/{{conviction_letter}}).

SL ${{stop_loss}} · TP1 ${{tp1_price}}{{#if tp3_price}} · runner to ${{tp3_price}}{{/if}}. R:R {{risk_reward}} to TP1.

{{#if ai_cio_decision != "PROCEED"}}AI CIO flagged {{ai_cio_decision}} ({{ai_cio_confidence}}% conf) — {{ai_cio_one_line}}. {{/if}}Lane: In Review → Hold.

Next post: lane change at TP1 or SL.

Live ledger: timed-trading.com/proof.html

For informational and educational purposes only. Past performance does not guarantee future results. Not investment advice.
```

**Tokens required:** `direction`, `ticker`, `entry_price`, `setup_name`, `grade`, `signal_strength`, `conviction_score`, `conviction_letter`, `stop_loss`, `tp1_price`, `risk_reward`.
**Tokens optional:** `tp3_price`, `ai_cio_decision`, `ai_cio_confidence`, `ai_cio_one_line`.
**Tokens NEVER posted** (per voice guide — operator's account math is not public): `qty`, `value`, `notional`, `pct_of_acct`, `scale_per_1k`, `risk_pct`.

### 5.2 `trim` template

```
Engine fired Trim on {{ticker}} at TP{{tp_level}} (+{{realized_pct}}%). Trim {{trim_pct}}%, runner held, SL trailed to {{new_sl_price}}.

We don't post "we made money on {{ticker}}" — we post "Trim {{trim_pct}}%". The next bar might wipe the runner. The trim is the only locked-in part of the trade.

Live ledger: timed-trading.com/proof.html

Past performance does not guarantee future results. Not investment advice.
```

**Tokens required:** `ticker`, `tp_level`, `realized_pct`, `trim_pct`, `new_sl_price`.

### 5.3 `exit-win` template

```
Engine closed {{ticker}} {{direction}} at ${{exit_price}} (+{{realized_pct}}% from entry at ${{entry_price}}).

Full lane history: {{lane_history}}. Held for {{hold_duration}}.

The trim ladder did the work — TP1 at +{{tp1_realized_pct}}%, TP3 runner at +{{tp3_realized_pct}}%. Logged in the ledger.

timed-trading.com/proof.html

Past performance does not guarantee future results. Not investment advice.
```

**Tokens required:** `ticker`, `direction`, `exit_price`, `realized_pct`, `entry_price`, `lane_history`, `hold_duration`.
**Tokens optional:** `tp1_realized_pct`, `tp3_realized_pct`.

### 5.4 `exit-loss` template — *the trust post*

```
Engine closed {{ticker}} {{direction}} at ${{exit_price}} ({{realized_pct}}% from entry at ${{entry_price}}).

{{loss_reason}} — model fired Defend → Exit. SL took us out.

Posting the loss on purpose. The proof page lists top 5 losses every month next to top 5 wins, on the same screen. If a system can't survive showing its losses it shouldn't be sold.

timed-trading.com/proof.html

Past performance does not guarantee future results. Not investment advice.
```

**Tokens required:** `ticker`, `direction`, `exit_price`, `realized_pct`, `entry_price`, `loss_reason`.

**Default behavior is special**: even if the operator does not respond at all (offline > 72h), this post still ships. This is the only template that **cannot be skipped to zero** — the strongest version of the operator's "once we start we must continue" rule. The only way to suppress an `exit-loss` post is for the corresponding `entry` post to have never been approved in the first place.

### 5.5 `defend` template (optional, HITL)

```
{{ticker}} moved from Hold to Defend today. {{defend_reason_one_line}}.

Not closing yet — the lane says "next decision is the stop", not "exit now". Trade is at {{current_pct}}% from entry. Stop sits at ${{stop_loss}}.

If structure recovers, lane goes back to Hold. If not, the next post is the close.

timed-trading.com/proof.html

Not investment advice.
```

### 5.6 `investor-lane` template (HITL, Persona B)

```
{{ticker}} moved from {{from_lane}} to {{to_lane}} in Investor mode today. Position {{position_pct}}% since the Buy Zone entry. {{lane_change_one_line}}.

Investor mode is one decision per name per day. Today's decision on {{ticker}}: {{decision_one_line}}.

timed-trading.com

Past performance does not guarantee future results. Not investment advice.
```

### 5.7 `no-trade` template (HITL, selective)

```
Model rejected a {{ticker}} {{direction}} entry premarket — {{rejection_reason_one_line}}. No trade.

The trade that didn't happen is also a decision. Logged in the same ledger as the wins and losses, with the reason the engine said no.

timed-trading.com/proof.html

Not investment advice.
```

### 5.8 `daily-brief-headline` template — *fully unattended*

```
{{date_short}} morning brief: SPY opens near ${{spy_open}}. Day Gate {{spy_lower}} / {{spy_upper}}. Above {{spy_upper}} → Golden Gate Open targets {{spy_gg1}} → {{spy_gg2}}. Below {{spy_lower}} → invalidation.

Full brief: timed-trading.com/daily-brief

Not investment advice.
```

This is the **only** template that auto-ships without any approval step. It contains no subjective interpretation — only the levels the engine published. The marketing-worker pulls the data from the same source as the public `/daily-brief` page (see §8).

Posted at 9:05 AM ET, weekdays only, after market-holiday check.

### 5.9 `weekly-wrap` template (HITL, default ship in 60 min)

```
{{week_label}} weekly wrap:
• {{trade_count}} trades closed.
• {{wins}} wins / {{losses}} losses.
• Win rate {{wr}}%. Avg R:R {{rr}}.
{{#if best_trade}}• Best: {{best_trade_ticker}} at +{{best_trade_pct}}%.{{/if}}
{{#if worst_trade}}• Worst: {{worst_trade_ticker}} at {{worst_trade_pct}}%.{{/if}}

Equity curve + full ledger: timed-trading.com/proof.html

For informational and educational purposes only. Past performance does not guarantee future results. Not investment advice.
```

Fired Friday at 4:15 PM ET. Operator gets 60 min to override; otherwise ships at 5:15 PM ET.

---

## 6. Default behaviors & timings

| Event | Default ship behavior | Skip-window | Max latency from event |
|-------|----------------------|-------------|----------------------|
| `TRADE_ENTRY` | Wait for ✅ | — | 60 min stale-out (after that, drop card silently) |
| `TRADE_TRIM` | Auto-ship | 30 min | 90 min from event |
| `TRADE_EXIT_WIN` | Auto-ship | 30 min | 90 min |
| `TRADE_EXIT_LOSS` | Auto-ship, cannot be reduced to zero if entry was public | 30 min (can edit, can't fully skip) | 90 min |
| `LANE_CHANGE_DEFEND` | Wait for ✅ | — | 4 hours stale-out |
| `INVESTOR_LANE_CHANGE` | Wait for ✅ | — | 24 hours stale-out |
| `TRADE_REJECTED` | Wait for ✅ | — | 4 hours stale-out |
| `DAILY_BRIEF_PUBLISHED` | Auto-ship | — | 15 min |
| `WEEKLY_WRAP` | Auto-ship | 60 min | 90 min |

**Rate limits enforced by marketing-worker:**
- Maximum **3 X posts per ET day** total across the entire pipeline (matches the canonical plan §4 cadence).
- Maximum **1 entry post per ticker per 7 days** (no "we entered TSLA again" two days later — looks spammy).
- Maximum **5 approval cards in Discord per ET day** (everything beyond that is silently coalesced — only the highest-conviction entries reach the operator).

---

## 7. Hard never-auto-posts

The marketing-worker **must reject** any draft that hits any of these and alert the operator:

- The phrase set: `guaranteed`, `risk-free`, `can't lose`, `easy money`, `to the moon`, `wagmi`, `diamond hands`, `tendies`, `paper hands`, `you'll make`, `our users made`, `turn $`, `beat the market`. *(Pre-publish lint against the voice-guide banned-phrase list.)*
- Any token containing the operator's account math (`qty`, `value`, `notional`, `pct_of_acct`, `realized_dollar`, `realized_usd`). These fields are *available* in the event payload but are **stripped at the template-fill step** — they never reach the draft.
- Any unfilled `{{token}}` in the rendered body. The runner already enforces this; the marketing-worker enforces it pre-Discord too.
- Any post about a paid-tier-only insight (full AI CIO output, lane analytics, intraday flash log). Marketing posts surface the *fact* of a lane change, never the proprietary analytics behind it.
- Any post identifying an individual user without a `consent_token` lookup returning `true` in KV.

A failed lint **does not** silently drop the event — it pings the operator with "draft blocked by lint, here's why" so the operator knows the engine fired but nothing was posted.

---

## 8. Public Daily Brief surface

A separate but adjacent piece of marketing infrastructure. **Not part of the marketing-worker — this is a frontend change** that the operator owns (or assigns to an engineering agent). The Marketing Agent's role is the spec.

### Surface design

One URL, two experiences:

- **`/daily-brief`** (public, no auth) renders the **marketing-safe view**:
  - Today's date + "Morning Brief" / "Evening Recap" header
  - SPY · QQQ · IWM cards with: current price, Bull Plan, Bear Plan, ATR levels
  - Today's earnings tape (ticker list only — no internal scoring)
  - Macro strip (VIX, crude, 10y, DXY)
  - Yesterday's Daily Brief link in a small "Archive" footer
  - **Hero CTA at the top**: email opt-in — *"Get this in your inbox at 9 AM ET, free."*
  - Disclaimer footer (sticky)
- **Authenticated visitors** unlock additional sections inline on the same URL:
  - Open positions list (with lane badges)
  - AI CIO commentary
  - Intraday flash log
  - Lane analysis (Setup pipeline / Defend candidates)

The public view is fully indexable by search engines. It is the brand's primary content surface.

### What's deliberately hidden

To preserve the paid tier's value:
- No individual ticker scoring or grade outside SPY/QQQ/IWM.
- No "today's setups" list (that's the paid pipeline).
- No Buy Zone / Reduce signals for any name beyond the indices.
- No realized P&L numbers other than what's already on `/proof.html`.

### Mirroring to X

When `DAILY_BRIEF_PUBLISHED` fires (every 9 AM ET on a market day), marketing-worker auto-posts the levels-only X version (`daily-brief-headline` template, §5.8) **with no HITL**. This is the single template that ships on rails because the post contains zero subjective interpretation.

### Caching and feed availability

- Page is server-rendered + edge-cached for 60 sec.
- An RSS feed at `/daily-brief.rss` carries the same marketing-safe content for low-effort syndication.
- An OG image is auto-generated server-side per brief (so X / LinkedIn / iMessage previews look like a brief, not a default favicon).

### Email-list integration

Email opt-in form on `/daily-brief` writes to the existing Daily Brief mailing list. The Day-0..20 nurture sequence (Batch 0 deliverable 3) auto-fires from the same signup. No new ESP wiring required.

---

## 9. MVP build order

Phase build, lowest-risk slice first. Each phase ships independently.

### Phase 1 — Discord HITL + entry-only (≈ 2-3 days of engineering)

- Marketing-worker subscribes to `TRADE_ENTRY` only.
- Renders `entry` template, posts approval card to `#tt-marketing-approvals`.
- Discord interactions API wired: ✅ / ⏰ / 🚫 / 📝 buttons functional.
- On approve, marketing-worker writes to `x-queue-2026-MM.md` (via a git commit from the worker, OR a KV store the x-queue runner reads — operator picks).
- **Lifecycle pairing NOT yet implemented.** Approved entries do not yet create pending-exit records.
- **Outcome of Phase 1**: operator can ship a live-trade entry post in under 60 sec from a phone tap, fully on-brand.

### Phase 2 — Pairing + auto-exit (≈ 2-3 days)

- KV-backed pairing store, keyed by `trade_id`.
- Subscribe to `TRADE_TRIM`, `TRADE_EXIT_WIN`, `TRADE_EXIT_LOSS`.
- Implement the 30-min skip-window auto-ship default for paired exits.
- Special-case the `exit-loss` template's no-zero-skip rule.
- **Outcome of Phase 2**: the brand's continuity promise is enforced on rails. The operator can step away mid-trade without breaking it.

### Phase 3 — Public Daily Brief surface (≈ 3-5 days, frontend work)

- Fork the existing admin-gated `/daily-brief` into the public/paid dual view per §8.
- Add email opt-in widget + tie to the Daily Brief mailing list.
- Add `/daily-brief.rss` and OG-image generation.
- Implement the unattended `DAILY_BRIEF_PUBLISHED` → X mirror.
- **Outcome of Phase 3**: a public follow-engine exists. People have a daily reason to follow / subscribe. Free-tier funnel is wired end-to-end.

### Phase 4 — Lane changes & weekly wrap (≈ 2 days)

- Add `LANE_CHANGE_DEFEND`, `INVESTOR_LANE_CHANGE`, `TRADE_REJECTED`, `WEEKLY_WRAP`.
- All HITL except `WEEKLY_WRAP` which uses the 60-min default-ship pattern.
- **Outcome of Phase 4**: the marketing-worker covers the full event catalog. Operator is mostly a tap-only consumer of the pipeline.

### Phase 5 — Cross-channel fan-out (optional, later)

- LinkedIn auto-cross-post for `WEEKLY_WRAP` and the long-form weekly thread.
- Telegram / Bluesky / Threads as secondary fan-out (read same x-queue, post via their APIs).
- This phase only after the operator wants more channels.

---

## 10. Prerequisites the operator must complete

Before Phase 1 can ship:

- [ ] Create a Discord application at `https://discord.com/developers/applications` — bot user, get bot token.
- [ ] Add the bot to the operator's Discord server with `Send Messages`, `Embed Links`, `Use Application Commands` permissions.
- [ ] Create the `#tt-marketing-approvals` private channel; allow only the operator + bot.
- [ ] Register an X (Twitter) developer app — note: write access to a posting account requires the paid X API tier. Cost = $100/mo basic, $5000/mo pro. Basic tier is sufficient for ≤ 1500 posts/month.
- [ ] Decide queue storage: (a) marketing-worker writes back to the repo's `x-queue-YYYY-MM.md` via a GitHub App + push, OR (b) KV-backed queue that the runner reads. Recommend **(b) KV-backed** for Phase 1 simplicity; the markdown file becomes a snapshot/audit log generated nightly.
- [ ] Acknowledge X API content compliance: nothing in this pipeline triggers X's policy rules (no automated DM, no spam, no platform manipulation). Posts are clearly human-approved on the entry side and templated on the exit side. Document this once for X compliance review.

Marketing Agent's contribution beyond Batch 0:
- This spec doc (committed).
- The content templates (in §5, ready to lift).
- A KV schema sketch (see §11 open question).

---

## 11. Open questions for the operator

These need a decision before Phase 1 codegen. None blocks the spec.

1. **Single Discord channel for approvals vs. mode-split?** Recommend single `#tt-marketing-approvals` for everything; reconsider if approval cards exceed 10/day.
2. **Queue storage — markdown file commits vs. KV-backed?** Recommend KV for the worker's storage; nightly dump to `x-queue-YYYY-MM.md` for human auditability + git history.
3. **Skip-window grace for `exit-loss`?** Spec currently says 30 min and cannot reduce to zero. Operator may want longer (e.g. 4 hours) to allow rewording the loss-reason line. Recommend 30 min stays.
4. **Public Daily Brief — strip versus separate URL?** Spec says one URL, two experiences. Alternative is `/brief-public` vs `/brief` for paid. Recommend the inline-unlock model — simpler to maintain.
5. **Visual generation — operator pre-loads images vs. server-side composite?** Templated visuals can be auto-generated server-side (Cloudflare Image Resizing + an SVG template). Alternative is operator pre-uploads a stock visual per template. Recommend auto-generated for entry/trim/exit cards, pre-uploaded for philosophy/social-proof.
6. **Approval card aging — what happens to a card the operator never tapped?** Spec says drop silently after stale-out (60 min for entry, 4h for lane changes, 24h for investor moves). Operator may want a "missed entries" digest at end of day instead. Recommend silent drop + KV log.

---

## 12. Out of scope

- **Engine modifications.** This pipeline subscribes to existing engine events. It never writes to engine state.
- **Paid ad copy automation.** Operator owns ad spend decisions per canonical plan §7.
- **Cold lead outreach.** Operator-owned.
- **Automated DM / one-to-one outreach on any platform.** Will not be built. Each platform's policy plus securities-advice risk make this strictly off the table.
- **Auto-replies to comments / mentions on X.** Reply quality is too brand-sensitive to automate. Replies remain operator-driven from the founder account.
- **Backfilling historical trades into the social feed.** First Phase 1 ship is forward-only from go-live.

---

## 13. Sanity checks before go-live

A one-page operator checklist for the first 7 days post-launch:

- [ ] First approval card lands in `#tt-marketing-approvals` within 90 sec of an engine event. (Latency budget.)
- [ ] First X post ships within 5 min of operator tap. (End-to-end budget.)
- [ ] First paired exit post auto-ships with the right ticker / direction / realized %. (Pairing correctness.)
- [ ] First post containing a banned phrase is **rejected** by the lint, with an operator alert. (Compliance gate works.)
- [ ] First X post during a market holiday is correctly suppressed. (Calendar awareness.)
- [ ] First operator-skip on an `exit-win` post does NOT prevent the matching trust audit log from being written. (Audit trail intact.)

If any of these fail in week 1, pause Phase 2 ship and patch Phase 1 first.

---

*Spec authored by the Marketing Agent. Implementation is operator-owned or engineering-agent-owned. Marketing Agent maintains the templates (§5) and updates this spec when the brand voice rules or event types change.*
