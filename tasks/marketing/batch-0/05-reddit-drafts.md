# Batch 0 / Deliverable 5 — 3 Reddit post drafts

> Reddit posture: **contribute first, mention product never until invited**. These three drafts assume the operator has already spent 1–2 weeks lurking and commenting in the target subreddit. Per the prompt, the OP carries the screenshot but **never** a sales link; if the subreddit allows it, the URL goes in the first comment.
>
> Operator action before posting: read each subreddit's current rules (Reddit's auto-mod removes anything that smells like promotion). If the rules forbid links in any form, drop the comment-link step and let people find the site via the screenshot's footer URL.
>
> Voice: "you / your" allowed (Reddit is off-site).
> Disclaimer: italicized one-liner above the call-to-action line.

---

## Draft 1 — `r/Daytrading`

**Title:** Spent 10 months building a multi-timeframe exit engine — here's the kanban that replaced my watchlist

**Body (≈ 220 words):**

I trade swings, not day trades, but most of you here will recognize the problem. Last year I was tracking 30+ tickers in a spreadsheet, missing trims because a meeting ran long, and holding losers because I had no rule that said "this one is broken, get out".

So I built a system that watches 240+ tickers across multiple timeframes and places each one in a single action lane:

- **Setup** → confluence is forming, not actionable yet
- **In Review** → confluence confirmed, sizing the entry
- **Hold** → in the trade, no action required
- **Defend** → trend is wobbling, stop is the next decision
- **Trim** → take partial, trail the runner
- **Exit** → out, log it, move on

One screen. Lane = decision.

The thing I underestimated was how much the **trim** matters. The entry is the easy half of a trade. The trim is where almost all of my P&L was leaking before I systematized it. Same score that finds the setup now fires the trim at TP1 and the exit when structure breaks.

10 months in, 593 closed trades, ledger is public — wins AND losses on the same page.

Happy to answer questions about the multi-timeframe scoring or how the trim rule decides 50% vs 75% vs runner.

*For informational and educational purposes only. Not investment advice. Past performance does not guarantee future results. All trading involves risk of loss.*

**First comment (if rules permit):**

For anyone who asked about the ledger — public proof page is at `timed-trading.com/proof.html`. Equity curve, top 5 wins, top 5 losses, max drawdown, Sharpe. No login. The screenshot in the OP is from the same dashboard.

**Suggested visual (OP image):**

Single screenshot of the Active Trader kanban — landscape format, all six lanes visible (Setup → In Review → Hold → Defend → Trim → Exit), each lane populated with 2–4 anonymized tickers. Lane colors per the brand: green / blue / green / red / amber / grey. Crop the top header to leave only the lane strip (no logged-in account chrome). Add a tiny footer with the disclaimer text and `timed-trading.com/proof.html` in mono. Image ratio 16:9.

**Disclaimer placement:** body (penultimate paragraph) + image footer.

**CTA URL:** `timed-trading.com/proof.html` (first comment only).

**Suggested post time:** **Tuesday 9:00 AM ET** (highest r/Daytrading dwell is pre-open on a market day).

**Persona target:** A / Burned Brian.

---

## Draft 2 — `r/investing`

**Title:** How I'm managing 25 single-name positions through this tape — the framework I wish I had in 2022

**Body (≈ 240 words):**

A note for anyone in the same boat: holding 20–30 single-name stocks accumulated over 4–5 years, no consistent rule for what to *add*, what to *trim*, what to *hold*.

I built a four-state framework that I run daily on every name in the portfolio:

1. **Buy Zone** — trend is intact, current price is in the model's accumulation band. Adds OK.
2. **Core Hold** — trend strong, position size appropriate, no action.
3. **Hold & Watch** — trend wobbling but still up. Don't add, don't trim, watch.
4. **Reduce** — trend itself is broken on the higher timeframe. Trim or exit.

The thing that changed everything is that this generates **one decision per name per day**. Not five charts, not eight indicators — a single state per name. If the state hasn't changed from yesterday, the decision is "do nothing". For 23 of my 25 names on any given day, that's the answer.

I don't think this replaces an index core. I run a 60/40 VTI/BND base layer and then run the 25-name single-stock sleeve through this framework on top.

The piece I'd push back on the "just buy VTI" reply: VTI doesn't help if the *single name concentration* is already there from RSUs, founder stock, or a 5-year-old conviction position. Those concentrations need an exit rule.

Not investment advice — just sharing the framework. Happy to dig into the state-transition rules if useful.

*For informational and educational purposes only. Not investment advice. Past performance does not guarantee future results. All trading involves risk of loss.*

**First comment (if asked):**

For the folks who asked — the model + ledger live at `timed-trading.com`. The proof page (`/proof.html`) is the relevant one for "show me the receipts" — it lists wins and losses on the same screen for the last 30 days.

**Suggested visual (OP image):**

Investor board screenshot, portrait or square format. Show 6–8 cards across the four lanes (Buy Zone, Core Hold, Hold & Watch, Reduce). Anonymize 1–2 tickers if any are sensitive but keep the lane structure honest. Bottom footer: disclaimer + `timed-trading.com`.

**Disclaimer placement:** body (penultimate paragraph) + image footer.

**CTA URL:** `timed-trading.com` (in first comment only, only if rules permit).

**Suggested post time:** **Sunday 8:00 PM ET** (highest r/investing dwell — Sunday-night portfolio-review mood).

**Persona target:** B / Curious Casey / RSU Riley.

**Auto-mod note:** r/investing's auto-mod will yank anything that looks like a service promotion. The OP carries zero product mention; if the post survives 12 hours and the discussion is real, drop the link in a top-level comment, not the OP. If a mod removes the link, don't repost.

---

## Draft 3 — `r/swingtrading`

**Title:** My systematic trim rule — the thing that finally stopped me from giving back winners

**Body (≈ 230 words):**

Every losing swing year I've had came from the same mistake: a winner hit a logical TP, I didn't trim, the trade gave it all back, I got mad, sized up the next one, blew up the account.

This year I codified the trim rule. Sharing it because the rule is more useful than any specific signal.

**The rule:**

1. Every trade gets a TP1 / TP2 / TP3 ladder at entry. TP1 = 1R. TP2 = 2R. TP3 = the Saty ATR or Golden Gate weekly target, whichever is closer.
2. **TP1 fires → trim 50%, SL trails to entry.** The remaining size now has zero dollar downside — the stop is at breakeven on whatever's left.
3. **TP2 fires → trim another 30%.** 20% is the runner.
4. **TP3 fires → take it. No runner past TP3.** The math says holding past TP3 reduces expectancy.
5. If the **next-higher timeframe phase flips against the trade** before TP1, the rule overrides everything: trim 100%, exit. No "give it room".

I run this through an engine now because I cannot be trusted to apply it consistently. The engine flagged `Trim` on AGYS at TP3 last week — I would've held it. It also flagged `Defend → Exit` on INFL for -1.31% the same week — I would've held that too, and watched it go to -5%.

The systematic part isn't optional. Discretion is what burns the rule.

Screenshot is the current Trim lane on the dashboard.

*For informational and educational purposes only. Not investment advice. Past performance does not guarantee future results. All trading involves risk of loss.*

**First comment (if asked):**

Engine + ledger at `timed-trading.com/proof.html` — public, no login. Top 5 wins and top 5 losses for last 30 days are on the same screen, on purpose.

**Suggested visual (OP image):**

Crop of the Active Trader kanban focused on the **Trim** lane, showing 2–3 cards each with TP1/TP2/TP3 fills labeled and the SL trail line annotated. Or, alternatively, a single annotated trade-autopsy modal showing the full TP ladder for one trade (e.g. AGYS) with the entries marked.

**Disclaimer placement:** body (penultimate paragraph) + image footer.

**CTA URL:** `timed-trading.com/proof.html` (first comment only).

**Suggested post time:** **Saturday 10:00 AM ET** (r/swingtrading's Saturday "show your trade" window).

**Persona target:** A / Burned Brian.

---

## Operator handoff notes

- All three drafts assume **karma + comment history exists** in the target subreddit. If the operator has < 100 karma in any of these subs, **don't post yet** — comment substantively for 2 weeks first. Per canonical plan §4 ("Reddit — long-form, technical, no spam").
- The `r/algotrading` long-form post (the *"8 months of running a live system"* post from canonical plan §4) is **not in this batch** — it's the Week-3 launch post in the 30-day sequence and gets its own writeup once the operator approves the architecture-detail level.
- Do **not** post the three drafts in the same week. Stagger by ≥ 5 days so they don't appear as a coordinated push (Reddit's spam filter compares user posting patterns across subs).
- If any subreddit removes the post, **don't argue with the mods** in modmail and don't repost. Treat the removal as data and re-tune.

---

*Source of truth: [`tasks/marketing-canonical-plan.md`](../../marketing-canonical-plan.md) §4 ("Reddit — long-form, technical, no spam") + §6 (voice) + §8 (compliance).*
