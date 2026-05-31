# Batch 0 / Deliverable 2 — Brand voice guide (one page)

> One page. If a piece of copy fails any of these checks, rewrite before publishing.

---

## North-star sentence

> **"Timed Trading is the system that tells you exactly when to enter, when to take profit, and when to get out — so your winners stop turning into losers."**

Every asset should be one degree of separation from that sentence. The wedge is **discipline as a service**, not "we make you money".

---

## Tone

- **Engineering-grade discipline.** The voice of a senior infra engineer who happens to trade — not a hype trader who built a tool.
- **Confident, never promotional.** Numbers carry the claim. Adjectives do not.
- **Receipts over assertions.** Every claim links to a live URL — `/proof.html`, a Daily Brief, a screenshot.
- **Comfortable showing losses.** Showing the losers is the marketing. The proof page lists top 5 wins *and* top 5 losses for the last 30 days for exactly this reason.
- **Em-dashes welcome.** Hashtag soup is not. Max two hashtags per X post.

---

## Mode-aware copy rule (NON-NEGOTIABLE)

| Surface | "you / your" allowed? | Voice |
|---------|----------------------|-------|
| **Product UI** (dashboard cards, modals, settings, in-app emails post-signup) | **No.** | Use *"the system"*, *"the model"*, *"the portfolio"*, *"this stock"*. |
| **On-site marketing copy** (landing page, /proof.html, /pricing, splash, blog) | **No.** | Same as product UI. The reader is observing a system, not being addressed. |
| **Cold acquisition copy** (X posts, Reddit, LinkedIn, ads, cold emails, YouTube hooks) | **Yes.** | First / second person fine. Conversational. |
| **Nurture emails** (Day 0/2/5/10/20 after signup) | **Yes** in the body. | Switch to third-person whenever quoting the product / engine output. |
| **Disclaimers** | N/A | Verbatim required string — see below. |

The shorthand: **the moment the copy describes what the engine did, the engine is the grammatical subject.** Not "you made +3% on NFLX". Either "the engine fired Trim on NFLX at +3%" (product surface) or "we trimmed NFLX at +3%" (founder voice, off-site).

---

## Must-use vocabulary (the brand is the engine's words)

Never invent synonyms. These are the brand.

**Active Trader lanes** (left → right in the kanban):

- `Setup` · `In Review` · `Hold` · `Defend` · `Trim` · `Exit`

**Investor lanes:**

- `Buy Zone` · `Core Hold` · `Hold & Watch` · `Reduce`

**Decision artifacts** (capitalize when used as engine output):

- `Daily Brief` · `Trade Ledger` · `Buy Zone` · `Bull Plan` · `Bear Plan` · `Golden Gate` · `Day Gate` · `ATR Level` · `TP1 / TP2 / TP3` · `SL` (stop loss) · `Trim` · `Runner`

**Time windows** (use these exactly):

- *"the live window"* = Jul 2025 → today
- *"the backtest window"* = whatever range the screenshot/page shows; never elide it
- *"before fees and slippage"* — always state it when citing $ or %

---

## Banned phrases (will get the brand pulled into a thread we don't want)

- `guaranteed`, `risk-free`, `can't lose`, `easy money`, `passive income from trading`
- `to the moon`, `wagmi`, `diamond hands`, `paper hands`, `tendies`, `apes`
- `you'll make X%`, `our users made $Y`, `turn $5K into $50K`
- `beat the market` *(too close to a registered-advice claim)*
- `signal service`, `trading alerts you can copy` *(invites the "you copy, you sue" objection)*
- `secret`, `nobody is talking about`, `the one trade that…` *(spammy newsletter cadence)*
- `#investingtips`, `#getrichquick`, `#daytradergang`
- Any direct competitor brand name in a comparison. Comparisons are feature-based.

---

## Required disclaimer (copy verbatim onto anything that shows live or backtest numbers)

> **For informational and educational purposes only. Not investment advice. Past performance does not guarantee future results. All trading involves risk of loss.**

Placement rules:

| Asset type | Where the disclaimer goes |
|------------|---------------------------|
| X post (single) | Last line, or in alt-text of the image if char count is tight, or in the first reply if a thread. |
| X thread | Final tweet of the thread, in the body. Not just in alt-text. |
| Email | Footer block under the CTA, smaller font. |
| Reddit post | One blank line above the call-to-action, italicized. |
| LinkedIn post | Last paragraph, separated by `—`. |
| YouTube long-form | (1) On-screen card 0:00 – 0:08, (2) full text in pinned comment, (3) in description first line. |
| YouTube Shorts | On-screen text last 3 seconds + description first line. |
| Landing pages | Sticky footer, always visible. |

---

## Claim-evidence pairing rule

Every numeric claim is followed by **(a) the window, (b) a "before fees" qualifier when relevant, (c) a link to the live source**.

- ✅ *"+40% Jul 2025 → today, before fees, live ledger at timed-trading.com/proof.html. Not investment advice."*
- ❌ *"We're up 40%."*

If a single tweet can't fit (a) + (b) + (c), put the disclaimer block in alt-text on the image and shorten — never drop the window.

---

## Example tweets (good vs bad)

### Good ✅

> SPY morning brief 5/13 ET: opens near $739. Day Gate ±38.2% at $734.00 / $741.24. Above 741.24 → Golden Gate Open targets +50% $742.36 → +61.8% $743.48. Below 734 → invalidation. Live brief at timed-trading.com.
>
> *For informational and educational purposes only. Not investment advice.*

**Why it works:** specific levels, the engine's vocabulary (`Day Gate`, `Golden Gate`), no claim about outcome, the disclaimer is in the post.

### Good ✅

> The engine fired Trim on NFLX at TP1 (+1.83%). Trim 60%, runner held, SL trailed to entry. Why we don't post "we made money on NFLX" and instead post "Trim 60%" — the next bar might wipe the runner. Discipline, not bragging.
>
> Live ledger: timed-trading.com/proof.html
>
> *For informational and educational purposes only. Not investment advice. Past performance does not guarantee future results.*

**Why it works:** uses lane vocabulary (`Trim`, `runner`, `SL`), shows the *mechanism* not the outcome, links to ledger so the claim is verifiable.

### Bad ❌

> We just CRUSHED IT on NFLX 🚀🚀 +1.83% in 90 minutes. Imagine if you had 10K on this trade. This is what AI-powered trading looks like. DM for access. #tendies #wagmi

**Why it fails:** hype emojis, "what if you had X" is a returns promise by implication, "DM for access" reads like a scam, "AI-powered" is filler, `#wagmi` is banned, no window, no disclaimer, no link.

### Bad ❌

> Our system never loses 🔒 Backtested to 99.7% accuracy. Stop guessing and let the algorithm do the work. Risk-free 7-day trial.

**Why it fails:** "never loses" + "99.7%" + "risk-free" = three banned framings in one post, no window, no link, no disclaimer. This is the post that gets the account suspended.

---

## Visual identity (per canonical plan)

- **Primary surface**: dark navy `#0E1623` background.
- **Accent**: amber `#F5C25C` for the brand mark and CTAs.
- **Lane colors** (use the engine's): Setup/Bull = green, Defend/Bear = red, Trim/Hold & Watch = amber, In Review / Buy Zone = blue.
- **Numbers**: use a monospaced face (the dashboards already use one). Numbers in marketing copy should never be in a proportional font.
- **Screenshots**: always pulled from the actual product (no mockups). When cropping, keep the disclaimer footer visible.
- **Logos / wordmark**: always paired with the URL `timed-trading.com` underneath in small caps.

---

## One-line checklist before publishing

- [ ] Persona named (A, B, RSU Riley, Burned Brian, or Curious Casey).
- [ ] Mode named (Active Trader / Investor / both).
- [ ] No banned phrase.
- [ ] If numeric: window + "before fees" + link + disclaimer.
- [ ] If product UI / on-site: no "you / your".
- [ ] One CTA, one URL. Not two.
- [ ] Less than 2 hashtags. Zero `#investingtips`.

*Source of truth: [`tasks/marketing-canonical-plan.md`](../../marketing-canonical-plan.md) §6 + §8.*
