# Timed Trading — Canonical Marketing Plan

> **Single source of truth** for positioning, personas, channels, cadence, pricing, compliance, voice, and the agent that runs the daily content motion. Synthesizes the strategic memo from session 2026-05-13 with PR #133 Batch 0 (`tasks/marketing/`) and the **2026-05-30 founder narrative** ([`tasks/marketing/founder-story.md`](./tasks/marketing/founder-story.md)).
>
> **Phase:** *Trust before revenue.* Product and proof are ready; marketing earns belief before Charter urgency, Product Hunt, or X automation.

---

## 0. Highest-leverage immediate ship

The single highest-leverage thing to ship before any campaign starts:

**The public proof page** — `https://timed-trading.com/proof.html` *(shipped — see [`react-app/proof.html`](../react-app/proof.html))*

It does three jobs at once:
1. The link goes in every X post / Reddit comment / LinkedIn footer.
2. It's the trust artifact when a skeptic says "prove it".
3. It's the screenshot you embed in the Product Hunt launch.

Specs:
- Public, no auth, no admin gate.
- Pulls live from the worker direct URL (bypasses Cloudflare Access on the Pages domain).
- KPIs: account value, total P&L, realized P&L, closed trades, win rate, max drawdown.
- Equity curve (LightweightCharts area chart with $100K baseline).
- Top 5 wins AND top 5 losses for the last 30 days (no selection bias — losses always shown).
- Disclaimer footer + auto-refresh every 5 minutes.

Once the page is live, every other tactic in this plan runs against it.

### Founder narrative (voice)

The operator story—manual prep overload → bubble map → full lifecycle automation → flywheel (day trade / swing / invest)—lives in [`tasks/marketing/founder-story.md`](./tasks/marketing/founder-story.md). Use it for **founder X**, LinkedIn, YouTube hooks, and PH maker comments. It replaces generic “AI co-pilot” framing.

### Splash / pricing alignment (product marketing debt)

- Splash should lead with **exit discipline + proof**, not Charter scarcity ([`tasks/marketing/account-playbook-x.md`](./tasks/marketing/account-playbook-x.md)).
- **Stripe today:** ~$60/mo, **14-day trial** (splash and nurture copy must match).
- **Charter:** reframe as *founding member* (rate lock + direct line), not countdown FOMO.

---

## 1. Positioning

Get this single sentence right and the rest writes itself.

> **"Timed Trading is the system that tells you exactly when to enter, when to take profit, and when to get out — so your winners stop turning into losers."**

The wedge is **discipline as a service** — a model that doesn't blink, doesn't average down, doesn't rationalise. We do **not** sell "we make you money" (illegal to claim, plus instant-skeptic trigger).

### Audience variants

| Audience | Variant |
|---------|---------|
| RSU-rich, exit-poor (lead persona) | "You earned the equity. Now stop guessing when to sell. Timed Trading runs the model so you don't have to watch the screen." |
| Burned retail trader | "You're not a bad trader. You just don't have an exit rule. Timed Trading is the exit rule." |
| Quant-curious | "A real backtested system, ungated. Daily brief at 9 AM ET, alerts on every trim and exit, every position lifecycle logged." |

---

## 2. Personas — pick one to lead with

Lead with **A** for paid acquisition + **B** for organic Reddit/X. **C** is the long-tail referral target after the story exists.

### A. "RSU Riley" — *lead persona*

- **Demographics**: 32, Bay Area / Seattle, $400K-$1.5M unvested
- **Context**: 5-figure quarterly RSU drop. Wants to convert to cash without stepping on a 30% drawdown.
- **Where they hang out**: Hacker News, lurks r/financialindependence, follows tech-finance Twitter.
- **Pain**: misses tops because of work meetings; sells the bottom in a panic; chronic FOMO when the stock rips after they sold.
- **Hook**: *"Your comp plan picks the entry. Timed Trading picks the exit."*
- **Conversion path**: Daily Brief → Discord watchlist → paid signals.
- **Maps to product**: Active Trader (uses the swing-trader engine for the post-vest disposal decisions).

### B. "Burned Brian"

- **Demographics**: 38, day-trader-turned-swing, $40-150K account, lost 20%+ in 2024-25.
- **Where they hang out**: r/options, r/wallstreetbets, follows trader Twitter.
- **History**: Bought every Trade Ideas / Tradervue / Investors Underground product looking for the one.
- **Pain**: enters late, cuts winners early, holds losers, no system survives contact with his emotions.
- **Hook**: *"We're not selling you a course. We're selling you the alerts."*
- **Conversion path**: free tier with delayed signals → paid for live.
- **Maps to product**: Active Trader (the kanban + Discord alerts).

### C. "Curious Casey"

- **Demographics**: 28-45, software engineer, mostly indexes, dabbles in stock-picking.
- **Where they hang out**: r/Bogleheads, r/investing, follows Galloway / Klement / Asness.
- **Pain**: knows index investing is "right" but can't help themselves with single names; wants a more sophisticated framework.
- **Hook**: *"Look at the actual model. Look at the actual trades. Then decide."*
- **Conversion path**: open backtest viewer → paid investor mode.
- **Maps to product**: Investor mode (Buy Zone / Core Hold / Hold & Watch / Reduce).

### Splash-page personas (kept for product copy consistency)

The splash page documents the product's two modes as:
- **Active Trader** = "swing traders who want structure" → covered by Burned Brian + RSU Riley's exit-decision use case.
- **Investor** = "long-term investors who want discipline without daily screen time" → covered by Curious Casey + RSU Riley's hold-the-rest use case.

When writing on-site copy, anchor to the splash personas. When writing for off-site channels, anchor to RSU Riley / Burned Brian / Curious Casey.

---

## 3. Launch sequence (trust phase — revised 2026-05-30)

**Gate before revenue pushes:** splash/proof aligned · 15+ manual founder posts · transactional email live · **5+ paying users** OR clear trial→paid metric.

| Weeks | Focus | Output |
|-------|-------|--------|
| **0 (now)** | Voice + proof | Founder weekend **week-ahead** + bubble map ([`tasks/marketing/weekend-kickoff-2026-05-30.md`](./tasks/marketing/weekend-kickoff-2026-05-30.md)). Product quote-tweets. No X cron. |
| **1–2** | Founder X + LinkedIn | 3–5 founder posts/week. 1 LinkedIn essay (RSU / “sold too early”). Reply in trader Twitter. Product: receipts + proof only. |
| **3–4** | Reddit warmup | Comments only in r/algotrading, r/swingtrading. **No product links.** Skip cold r/investing posts (Batch 0 drafts are optional, not week-1). |
| **5+** | Reddit launch post | “8 months live system” process post when karma ready. |
| **After 5–10 paid** | PH prep + launch | Avoid NFP/FOMC weeks. Hunter network 30+. |
| **After 2 weeks manual X** | Batch 0.5 automation | HITL Discord pipeline per [`tasks/marketing/marketing-automation-spec.md`](./tasks/marketing/marketing-automation-spec.md). |

*Original day-1–30 calendar is preserved in spirit; timing slips are acceptable—rushing PH before belief is not.*

---

## 4. Channel playbook

### X / Twitter — daily heartbeat (TWO accounts)

#### a) Product account — `@TimedTrading` (or current handle)

All signal, zero opinion. Run from the standing X queue (see §7).

| Time (ET) | Post |
|-----------|------|
| 9:00 AM | Morning brief thread — predictions for SPY/QQQ/IWM with day's gate levels. Screenshot. CTA: free Daily Brief signup. |
| Each entry / trim / exit | Auto-post: ticker, side, entry, current SL/TP, mini chart screenshot. |
| 4:30 PM | P&L of the day with the same Sharpe / WR badge regardless of result. **Show losses too.** |
| Friday | Weekly recap + equity curve. |

#### b) Founder account — personal handle

Opinion + behind-the-scenes. Run by the operator (Shashant) directly, not the agent. Full playbook: [`tasks/marketing/account-playbook-x.md`](./tasks/marketing/account-playbook-x.md).

- Origin / bubble map / “couldn’t keep up with my watchlist” ([`founder-story.md`](./tasks/marketing/founder-story.md)).
- Weekend **week-ahead prep** + bubble map screenshot (structure, not buy calls).
- Calibration and bug stories (stale price, rate limits). Vulnerability sells trust.
- Replies in trader-Twitter, citing `/proof.html` when asked.

**Cross-account:** Founder posts first; Product **quote-tweets** with data-only caption 4–24h later. Avoid duplicate same-hour posts.

#### Templates (steal these)

```
SPY morning brief 5/13 ET: opens near $739. Day Gate ±38.2% at $734.00 / $741.24. Above 741.24 → GG Open targets +50% $742.36 → +61.8% $743.48. Below 734 → invalidation. Live updates in Discord. timed-trading.com/proof.html
```

```
We just took TP1 on NFLX at +1.83%. Trim 60%, runner held. SL trailed to entry. Why we don't say "we made money on NFLX" and instead say "TP1 trim 60%" — because the next bar might wipe the runner. Discipline, not bragging.
```

```
Our system fired 47 trades in April. 28 wins, 19 losses. Win rate 60%. R:R 1.4. Sharpe 1.6. Equity curve attached. Data shouldn't need a sales pitch. timed-trading.com/proof.html
```

The 3rd one is the killer. Repeat monthly with fresh numbers.

### Reddit — long-form, technical, no spam

Reddit is suspicious of everything. **Contribute first, mention product never until invited.**

| Order | Action |
|-------|--------|
| Week 1-2 | Comment on existing threads in r/algotrading, r/options, r/Daytrading, r/StockMarket with substantive technical answers. Build karma. **Do not link product.** |
| Week 3 | Process post in r/algotrading: *"How we built a multi-timeframe entry/exit engine — and the 4 things the backtest got wrong."* Show the actual evolution. Mention product only in the "what I work on" footer. |
| Week 4 | Show-and-tell in r/algotrading (Saturday "Show your project" thread or top-level if rules allow). Now the product can be center stage. |

**Cold-post draft for r/algotrading** (week 3):

> **Title**: "8 months of running a live multi-timeframe trading system — Sharpe 1.6, here's the architecture and the bugs that bit us"
>
> **Body** (open with the equity curve from `/proof.html`):
> - **Architecture**: Cloudflare Workers, D1, Durable Objects, TwelveData feed, Saty ATR levels for daily + weekly gates.
> - **The model**: per-ticker personality classification, AI CIO shadow mode, three-tier risk.
> - **The bugs**: stale prices clobbering live data; SL fires on stale ticks; rate-limit floods from object-as-string params.
> - **What works**: discipline at the exit.
> - **What doesn't (yet)**: low-volume tickers, news shocks.
> - End: "Live at timed-trading.com/proof.html if you want to follow along."

**Subreddits to NOT post in cold**: r/wallstreetbets (will roast and downvote), r/investing (allergic to anything that smells like a service), r/CryptoCurrency (off-thesis).

### Product Hunt — one-shot, prep heavy

PH launches are won the night before. Don't half-launch.

**Prep checklist:**
- 30+ "hunter network" people lined up to comment on launch day.
- **Tagline** (10 words max): *"The trading system that tells you when to exit."*
- **Hero gif/video** (30 sec): screen-record of the dashboard during a real trade — entry alert, trim, exit. No narration. Captioned.
- **5-image gallery**: brief, dashboard, alert, equity curve, trade autopsy modal.
- **First comment from the maker** (2 paragraphs): why you built it (RSU vesting, sold too early, watched it rip).
- **Free tier** ready to go (no sign-up wall on day 1, just email opt-in for the daily brief).

**Best launch day**: Tuesday or Wednesday. Avoid Mondays. Avoid major market events (FOMC, NFP).

**Realistic outcome**: top 5 of the day → 2-4K unique visitors → 200-500 email signups → 20-50 paid conversions (if pricing is right).

### LinkedIn — RSU Riley lives here

Underused for finance products. Post 1× per week:

- *"Why I sold my RSUs at the bottom — and the system I built so I never do it again."* (founder story, ~800 words)
- *"What 'timing the market' actually means when you're an employee with a 4-year vesting cliff."*
- *"RSU concentration risk is the silent killer of tech wealth. Here's the rule we follow."*

LinkedIn comments are a goldmine for B2B-adjacent acquisition. Respond to every one within 24h.

### Discord — your moat

You already have this. Make it the proof point.

- Pin a "How to read the alerts" doc.
- Add `#trade-log` (append-only, every entry / trim / exit).
- Add `#daily-brief` that auto-posts at 9 AM.
- New visitors should see 7 days of receipts in 30 seconds.

### Email

- **2/week** to free list, **1/month** to paid.
- Daily Brief preview, "what the engine did this week", education pieces.
- Day-0/2/5/10/20 nurture sequence on signup (each <200 words, single CTA, mandatory disclaimer).

### YouTube

- **1/week** long-form (5-10 min): "Engine pick of the week".
- **2/week** Shorts (<60 sec): pre-market Daily Brief read-aloud format.

---

## 5. Pricing (aligned to product — 2026-05-30)

| Tier | Price | What you get |
|------|-------|--------------|
| **Trial** | $0 for **14 days** | Full product trial (Stripe); align splash/footer copy. |
| **Pro (Charter / standard)** | **$60/mo** | Active Trader + Investor modes, live signals, dashboard, trade autopsy, Discord. Charter = founding-member rate lock + direct line—not fake scarcity. |
| **Free email (future)** | $0 | Daily Brief opt-in without full dashboard—spec’d in automation doc; not required for trust phase. |

**Pricing experiments (operator decision, not urgent):**
- **$60** is the live price and defensible vs manual Discord/Substack services ($60 can read *cheap* if proof is strong).
- **$29** may widen retail funnel—only test after trust metrics (proof visits, trial starts, retention), not to chase day-30 revenue.
- **Annual** ($500–600/yr) can come after 20+ retained subs.

Batch 0 persona doc mentioned $29/$99 tiers—**deprecated**; use this section for all new copy.

---

## 6. Voice & tone

- **Confident, not promotional.** The product earns belief through audited numbers, not adjectives.
- **Always pair claims with evidence** (a screenshot, a trade ID, a Daily Brief link). Never make a claim that can't be linked to a live URL.
- **Use the engine's vocabulary as brand language**: "Setup" / "In Review" / "Hold" / "Defend" / "Trim" / "Exit" for Active Trader; "Buy Zone" / "Core Hold" / "Hold & Watch" / "Reduce" for Investor. **Don't invent synonyms.**
- **No trader-bro slang**: no "wagmi", no "diamond hands", no "to the moon". The brand is engineering-grade discipline.
- **Punctuation**: em-dashes encouraged. No hashtag soup. One or two per X post max (`#swingtrading`, `#stocks`). **NEVER `#investingtips`.**

### Banned phrases

`guaranteed` · `risk-free` · `can't lose` · `easy money` · `to the moon` · `wagmi` · `diamond hands` · `you'll make X%` · `our users made $Y`

### Required phrases (on any asset showing performance)

`For informational and educational purposes only. Not investment advice. Past performance does not guarantee future results. All trading involves risk of loss.`

---

## 7. The standing X agent

The product account posts 2-3×/day. That's the operator-as-bottleneck killer. Set up a standing agent.

**Architecture:**

1. **Marketing agent** writes a 30-day rolling X queue, refreshed weekly. Stored in `tasks/marketing/x-queue-2026-MM.md` as a numbered list with: `[post id, intended post time ET, copy, visual brief, disclaimer flag]`.

2. **Dumb cron runner** (operator builds once — Cloudflare Worker cron + the X API) pulls the next item every 4 hours during ET market hours and posts. The runner is dumb — it just sends what the agent wrote.

3. **The agent watches** prior week's X analytics and rewrites the next week's batch with better hooks based on what got engagement. **The runner never changes copy. Always human-author the queue.**

### Recommended models

| Use case | Model | Why |
|----------|-------|-----|
| Initial launch sprint (positioning, persona refinement, anchor email sequence, Batch 0 X posts) | **Claude Opus 4.7** | Best at strategic narrative + persona empathy + long-form structure. |
| Weekly content batches (X posts, Reddit threads, follow-up emails) | **Claude Sonnet 4.7** | Faster + cheaper, holds the voice once Opus has set the tone. |
| Standing X queue agent | **Sonnet 4.7** with the voice guide as in-context examples | Daily reliability > virtuosity. |
| Image / asset generation | **Imagen 4 Ultra** or **Nano Banana Pro** for hero visuals; DALL-E 3 for quick variants | Pick one and stay consistent. |

For Batch 0, start with **Opus 4.7**. After the kickoff produces persona docs + 5-email sequence + 20 anchor X posts, downshift to Sonnet for the weekly grind.

### Batch 0 deliverables (the agent's first invocation)

1. **One-page persona refinement** for RSU Riley + Burned Brian + Curious Casey (specific job titles, 3 daily frustrations each, where they consume content, the one objection they'll raise).
2. **Brand voice guide** (one page): tone, banned phrases, must-use phrases, two example tweets ("good" vs "bad").
3. **5-email nurture sequence** (Day 0, 2, 5, 10, 20) for free signups who haven't upgraded. <200 words each, single CTA, disclaimer.
4. **20 X posts**: 5 live-trade + 5 Daily Brief preview + 5 engine philosophy + 5 social proof.
5. **3 Reddit drafts** (one per subreddit: r/algotrading process post, r/investing macro framing, r/swingtrading systematic-trim demo).
6. **1 long-form YouTube script** (8-10 min): *"I let an AI manage 600 trades over 10 months — here's what happened."* Hook → engine overview → live walkthrough → 3 best trades → 3 worst trades → what the engine learned → CTA.
7. **3 YouTube Shorts scripts** (<60 sec): morning Daily Brief read-aloud format.

After Batch 0 is approved, switch to weekly cadence:
- Each Monday, operator provides screenshots + week's PnL + 1-2 "moments" (e.g. *"AGYS hit TP3 for +18%"*, *"model rejected an NVDA entry that would have lost -2.4%"*).
- Agent delivers: 15 X posts, 1 Reddit thread, 1 long YouTube + 2 Shorts, 1 nurture email.

### What the operator (Shashant) is on the hook for

- **Each weekly batch**: provide screenshots (Active Trader board, Investor board, Daily Brief), the week's realized PnL, optional 1-2 moments.
- **Operator does NOT** provide cold leads, ad budgets, or paid spend decisions. That stays operator-owned.

### Hard "do not"s

- Do not promise specific returns.
- Do not impersonate other trading platforms or compare directly by name. Comparisons are feature-based, e.g. *"most scoring tools stop at the entry — Timed Trading also manages the trim and exit"*.
- Do not target retirees, students, or anyone who can't afford to lose principal — even implicitly (so no *"turn $5K into $50K"* framing).
- Do not include screenshots of any other broker's UI.
- Do not name individual users without written consent.

---

## 8. Compliance — three lines of defense

1. **Never claim returns.** Use "win rate", "system performance", "backtest Sharpe". All copy needs the disclaimer footer. Every shared screenshot and tweet thread quotes it once.
2. **No personalized recommendations.** Generic signals to a public list = newsletter (relatively safe). DMing "you should buy NFLX" = registered investment advisor territory (avoid).
3. **Show the full picture when citing a trade.** If you ever say "the model called NFLX" → always include: prediction date/time + entry/exit price + outcome + bigger losers from the same week. Selection bias is the #1 way finance influencers get into trouble. The `/proof.html` page does this for you automatically — lean on it.

**Threshold for legal escalation**: if revenue approaches $50K/yr from US users, talk to a securities lawyer (~$2-5K for a clear-cut newsletter exemption opinion). Cheap insurance.

**Product-surface-only constraint**: never use "you / your" in product UI copy. Use "the system", "the model", "the portfolio", "this stock". (For ad copy and cold emails "you" is fine — only the product surfaces use the third-person convention.)

---

## 9. Metrics — track these, ignore the rest

| Metric | Target by day 30 | Why |
|--------|------------------|-----|
| Daily Brief email subs | 1,000 | Top of funnel |
| Discord active members (7-day) | 200 | Mid-funnel engagement |
| Trial → paid conversion | 8% (track, don’t optimize prematurely) | Pricing/value proof |
| 30-day paid retention | 80% | Product-fit signal |
| `proof.html` unique visitors / week | 200+ | Trust funnel |
| Organic X follows / week | 50+ (quality followers) | Brand momentum |
| **Unprompted referrals** | **≥1 per week** | **Compounds when product fits** |

If happy users aren't telling friends, fix positioning and onboarding—not price cuts or PH timing.

Add a small KPI tile to `system-intelligence.html` (operator-only) tracking these. The agent's output (top 3 X posts by engagement each week) feeds back into the next batch.

---

## 10. Operator setup checklist

When invoking the marketing agent for the first time:

- [ ] Open a fresh agent thread (NOT a continuation of any engineering work).
- [ ] Pick **Claude Opus 4.7** for Batch 0; switch to Sonnet 4.7 for the weekly cadence.
- [ ] Paste the agent prompt block from [`marketing-agent-prompt.md`](./marketing-agent-prompt.md) (the annex) as the first message.
- [ ] Reference *this* canonical plan from the agent prompt: *"Source of truth for personas, voice, channels, and constraints is `tasks/marketing-canonical-plan.md`. Read it first."*
- [ ] Attach reference assets in the same message:
  - One current screenshot of the Active Trader kanban
  - One current screenshot of the Investor board
  - The latest Daily Brief PDF or screenshot
  - The latest realized PnL number (or just point at `/proof.html`)
- [ ] Wait for Batch 0, review, mark up edits inline, send back for revisions. Plan ~60-90 min of operator review for Batch 0.
- [ ] Set up the X queue infrastructure (separate task — small Cloudflare Worker cron that reads `tasks/marketing/x-queue-YYYY-MM.md` and posts via X API). The agent writes the queue; the operator builds the runner once.

---

## Annex

- [`marketing-agent-prompt.md`](./marketing-agent-prompt.md) — copy-paste-ready agent prompt block, model rationale, voice guide details, X queue architecture. Reads this canonical plan as authoritative.
