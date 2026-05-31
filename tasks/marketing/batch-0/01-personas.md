# Batch 0 / Deliverable 1 — Personas (one page)

> **On-site copy** (timed-trading.com, splash, signup, dashboards) anchors to **Persona A — Structured Swing Trader** and **Persona B — Discipline-Seeking Investor** (the two modes the product ships).
>
> **Off-site copy** (X, Reddit, LinkedIn, Product Hunt, paid) anchors to the three sharper acquisition personas from the canonical plan: **RSU Riley**, **Burned Brian**, **Curious Casey**. They are not different people from A/B — they are tighter acquisition wedges of the same two buckets.
>
> Use this doc as a checklist: every asset states which persona it targets and which mode (Active Trader / Investor) it maps to.

---

## Persona A — "Structured Swing Trader" (on-site, product surface)

| Field | Detail |
|-------|--------|
| **Job titles** | Senior software engineer, eng manager, infra/platform PM, ops director, founder/operator at a 10-50 person SaaS, mid-career quant adjacent |
| **Age range** | 30 – 45 |
| **Account size** | $50K – $500K self-directed (separate from 401k / brokerage core) |
| **Household income** | $200K – $600K W-2 + equity |
| **Geo** | US tech metros (SF Bay, Seattle, Austin, NYC, Boston, Denver), remote-tech secondary metros |
| **Mode they buy** | **Active Trader** (Setup → In Review → Hold → Defend → Trim → Exit) |
| **Top 3 daily frustrations** | (1) Already tracks ~30 tickers in a manual spreadsheet/Notion and still can't tell whether today's setup is the same one that won last week. (2) Misses trims because a 1:1 ran long; the runner gives back the gain. (3) Holds a -3% trade because there's no rule that says "this one is broken, get out" — emotion fills the gap. |
| **Where they consume content** | X (trader Twitter, $TICKER lists, follow ~50 accounts), Discord (3-5 trade rooms), Hacker News on the weekend, r/Daytrading and r/swingtrading lurker, YouTube long-form for "process" content, Substack newsletters they don't always read |
| **The one objection they will raise** | *"How is this not just another signals service? I've been burned by every Discord that sells alerts."* |
| **The honest answer** | The signal is not the product. The lifecycle is. The same score that flagged the Setup also fires the Trim and the Exit, and every step is logged in the trade ledger — open at `/proof.html`. If the engine is wrong, the audit shows where. |
| **Win condition** | One dashboard that says "AGYS is in **Trim** — take 50% off at $X, SL trailed to $Y." No further reading required. |
| **Conversion path** | Daily Brief email → Discord watchlist → Active Trader paid ($29/mo) |

---

## Persona B — "Discipline-Seeking Investor" (on-site, product surface)

| Field | Detail |
|-------|--------|
| **Job titles** | Director / VP at a large corporate, lawyer / consultant / accountant partner-track, dual-income tech couple, mid-career physician, small-business owner past first liquidity event |
| **Age range** | 35 – 55 |
| **Account size** | $250K – $2M across taxable brokerage + Roth/Traditional IRAs + post-vest RSU concentration |
| **Household income** | $300K – $1.2M |
| **Geo** | National. Heavier on coasts and tier-1 metros, but LinkedIn shows strong tier-2 (Charlotte, Nashville, Minneapolis) skew |
| **Mode they buy** | **Investor** (Buy Zone → Core Hold → Hold & Watch → Reduce) |
| **Top 3 daily frustrations** | (1) Owns ~25 single-name stocks bought across 5 years and has no rule for *adding* vs *trimming* vs *holding* any of them — every decision is a fresh argument with the spouse. (2) Bought NVDA at $130, TQQQ at $90 because *"everyone said to"* — now sitting on outsized concentration and second-guesses every leg up. (3) Reads 4 newsletters and 2 RIA notes per week and they all disagree — needs a single tie-breaker that shows its work. |
| **Where they consume content** | LinkedIn (longform finance writers, RIAs, equity strategists), email newsletters (Stratechery-adjacent, market structure), r/investing and r/Bogleheads (mostly lurking), the Wall Street Journal app, a couple of trusted YouTube channels (no day-trading content) |
| **The one objection they will raise** | *"I'm not a trader. Why would a 'trading system' help me hold for years?"* |
| **The honest answer** | Investor mode is **not a trading system**. It is a Buy Zone / Core Hold / Hold & Watch / Reduce signal for each name in the portfolio, refreshed daily, with one decision required per name per day. The trade ledger shows the model has held some positions for months — and only flagged Reduce when the trend itself broke. |
| **Win condition** | A weekly portfolio review email that says "23 names in Core Hold, 1 in Hold & Watch, 1 in Reduce — review the Reduce flag inside." Then the decision takes 2 minutes, not 2 hours. |
| **Conversion path** | Daily Brief email → free Investor preview → Investor paid ($99/mo) |

---

## Off-site acquisition personas (from canonical plan)

These are tighter wedges of A and B for ad copy, X, Reddit, and LinkedIn. **Off-site copy is allowed to use "you / your".** Switch to third-person on landing.

### RSU Riley — *lead acquisition persona*

- Maps to: **Active Trader** (for post-vest disposal swings) **+ Investor** (for the rest).
- 32, Bay Area / Seattle / NYC. $400K – $1.5M unvested. 5-figure RSU drop every quarter.
- Pain: missed last cycle's top because a work meeting ran long; sold the bottom in March on panic; chronic FOMO when the stock rips after they exited.
- Hook: *"Your comp plan picks the entry. Timed Trading picks the exit."*
- Will raise: *"I don't want to babysit a screen all day — I have a real job."* Answer: Daily Brief = one email at 9 AM ET. Investor mode = one decision per name per day.
- Where: LinkedIn (long-form RSU concentration posts), X (founder account replies in tech-finance threads), Hacker News "Ask HN: how do you de-risk your RSUs?" comments.

### Burned Brian — *the volume persona*

- Maps to: **Active Trader**.
- 38, day-trader-turned-swing, $40K – $150K account, lost 20%+ in 2024-25, bought 3 courses already.
- Pain: enters late, cuts winners early, holds losers, no system survives contact with emotions.
- Hook: *"We're not selling you a course. We're selling you the exit rule."*
- Will raise: *"What's your edge — there are 100 signal services already."* Answer: most stop at the entry. Timed Trading manages the trim and the exit, and the ledger is public at `/proof.html` — including losses.
- Where: r/options, r/Daytrading, r/wallstreetbets (read-only — never post product there), trader Twitter replies, YouTube comments under trading-system creators.

### Curious Casey — *the long-tail referral*

- Maps to: **Investor**.
- 28-45 software engineer, mostly indexes, occasionally picks a single name and feels uneasy about it.
- Pain: knows indexing is "right" but can't stop themselves on the one stock; wants a more sophisticated framework than "buy and hold forever".
- Hook: *"Look at the model. Look at the trades. Then decide."*
- Will raise: *"Why not just buy VTI?"* Answer: this isn't about replacing the index core. It's about ranking and managing the 5-10 single names already in the account.
- Where: r/investing (rarely posts, watches comments), r/Bogleheads, LinkedIn long-form, podcasts (Patrick O'Shaughnessy / Asness adjacent).

---

## Persona → channel → asset map (quick reference)

| Asset | Primary persona | Mode | Channel |
|-------|----------------|------|---------|
| Daily Brief email | A + B | Both | Email |
| `/proof.html` link drop | All | Both | X, Reddit, LinkedIn |
| Live trade callout | A / Burned Brian | Active Trader | X |
| "How I size RSU disposal swings" | RSU Riley | Active Trader | LinkedIn, X long-form |
| "How I manage 25 names without watching the tape" | B / Curious Casey | Investor | LinkedIn, r/investing |
| 8-min YouTube ("600 trades over 10 months") | A + RSU Riley + Curious Casey | Both | YouTube |
| Pre-market Shorts | A / Burned Brian | Active Trader | YouTube Shorts |
| r/algotrading process post | A / Burned Brian | Active Trader | Reddit |

---

## Adjacent personas to ignore until A + B are saturated

Per the operator prompt, these are queued but **not in scope for Batch 0**:

- **Reformed YOLO trader** — burned by 0DTE, looking for structure. (Will overlap with Burned Brian until then.)
- **RIA / advisor** — wants a research tool. **Compliance edge**: never position as a tool to give clients trade signals. Off-scope until a separate compliance review.
- **Crypto-curious equity trader** — wants the same automation rigor for equities. Off-scope; reconsider after the equities story has a 6-month proof window.

---

*Source of truth: [`tasks/marketing-canonical-plan.md`](../../marketing-canonical-plan.md) §2. This doc refines the seeds, it does not replace them.*
