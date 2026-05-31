# Batch 0 / Deliverable 3 — 5-email nurture sequence

> **Audience**: free signups (Daily Brief email list) who have NOT upgraded.
> **Cadence**: Day 0, Day 2, Day 5, Day 10, Day 20.
> **Length cap**: < 200 words per email (counted excluding disclaimer + footer).
> **CTA rule**: exactly one button per email. One URL.
> **Disclaimer**: footer, every email.
> **Voice rule**: "you / your" is allowed in body copy. The instant copy quotes engine output, switch to *"the system"* / *"the model"*.
> **From**: `Shashant @ Timed Trading <shashant@timed-trading.com>` (operator confirms exact send address).
> **Send time**: 9:15 AM ET (15 min after the morning Daily Brief drops, so the new signup has the brief in inbox first).

Replace bracketed `{{merge_field}}` tokens with your ESP's tokens. The standard disclaimer block below is `{{disclaimer}}` and is reproduced verbatim once at the bottom of this file.

---

## Email 1 — Day 0 — *Welcome + what arrives in your inbox tomorrow*

**Subject:** Welcome — your first Daily Brief lands at 9 AM ET tomorrow
**Preview:** Plus: a 60-second tour of what to actually read in it.

Hi {{first_name|"there"}} —

Thanks for joining. One email at 9 AM ET, every market day. That's the deal.

Here's what shows up tomorrow morning:

- A **Bull Plan** and **Bear Plan** for SPY, QQQ, and IWM — exact levels, no narrative fluff.
- **ATR levels** for each, so the stop and the take-profit are obvious before the open.
- A **macro context** block (rates, dollar, oil, crypto) so the brief reads in 90 seconds.
- The engine's open positions and what lane they're in (Setup / In Review / Hold / Defend / Trim / Exit).

Want to see one before tomorrow? Yesterday's brief is public.

**[Read yesterday's Daily Brief →](https://timed-trading.com/daily-brief)**

If anything looks unclear, hit reply. I read every one.

— Shashant
*Founder, Timed Trading*

---
*{{disclaimer}}*

---

## Email 2 — Day 2 — *How to read the brief (the 90-second version)*

**Subject:** How to read the Daily Brief in 90 seconds
**Preview:** Three numbers per index. That's the whole skim.

Most market emails fail because they bury the levels under a 400-word "narrative". This one inverts it.

**The 90-second read:**

1. **Top of brief — SPY price + "Bull Plan" / "Bear Plan" rows.** Two prices each. Those four numbers define the trading day's range.
2. **Sector heatmap.** XLE up, XLK flat, XLF down — confirms or fades the index call.
3. **Open trades panel.** Which lane is each name in? `Hold` means do nothing. `Trim` means the next decision is partial profit. `Defend` means the next decision is the stop.

Everything else is context, not action.

Tomorrow's brief drops at 9 AM ET. After two or three reads, the skim takes under a minute.

**[See today's brief →](https://timed-trading.com/daily-brief)**

— Shashant

---
*{{disclaimer}}*

---

## Email 3 — Day 5 — *The proof page (we show the losers too)*

**Subject:** The losses are on the same page as the wins
**Preview:** It's a deliberate design choice.

Most trading newsletters publish their best week and never the worst.

We publish both. The proof page lists the **top 5 wins AND top 5 losses for the last 30 days**, live, no hand-picking. Sharpe, max drawdown, average R:R, setup diversity — all on one screen.

It's public. No login.

**[Open the proof page →](https://timed-trading.com/proof.html)**

The reason it's public is simple: if a system can't survive showing its losses, it shouldn't be sold. Showing the full ledger is how the brand earns trust faster than a sales page can.

Skim it. Bookmark it. Watch it for a few weeks. The numbers are live — they refresh every 5 minutes.

— Shashant

---
*{{disclaimer}}*

---

## Email 4 — Day 10 — *Why the same score handles entry, trim, and exit*

**Subject:** Most signal services stop at the entry
**Preview:** That's the half of the trade that doesn't matter.

A blunt observation: the entry is the easy half of a trade.

Anyone with a chart can find a setup. Almost nobody has a rule for **when to take partial profit** and **when the trade is broken**. That's where 70% of P&L lives, and that's where most discretionary traders bleed.

Timed Trading runs the same multi-timeframe score from setup to exit:

- The score finds the trade (lane: **Setup**).
- The score confirms entry (lane: **In Review → Hold**).
- The score fires the trim at TP1 / TP2 (lane: **Trim**).
- The score fires the stop when the structure breaks (lane: **Defend → Exit**).

Every step is logged. The ledger replays every decision the engine made.

**[See the engine in action →](https://timed-trading.com/proof.html)**

The free Daily Brief shows the bull / bear levels. The paid tier shows the lane transitions in real time.

— Shashant

---
*{{disclaimer}}*

---

## Email 5 — Day 20 — *Two ways to upgrade — or stay on the free brief*

**Subject:** Two ways to upgrade — or stay where you are
**Preview:** No pressure. Just the difference.

You've been getting the Daily Brief for three weeks. Here are the two upgrade paths, side by side, with what each is *actually for*.

**Active Trader — $29/mo** *(or $290/yr — two months free)*
The swing-trading mode. Live Discord alerts on every lane change (Setup → Trim → Exit). Full dashboard with the Active Trader kanban. Best fit: anyone running their own 10-30 ticker watchlist and tired of guessing the exit.

**Investor — $99/mo**
The long-term mode. Buy Zone / Core Hold / Hold & Watch / Reduce signal for every name in the portfolio, refreshed daily. Weekly portfolio review email. Best fit: a 20-50 name single-stock portfolio that needs *one decision per name per day* — not a tape to babysit.

Both share the same engine. Both are cancel-anytime.

**[Compare plans →](https://timed-trading.com/pricing)**

If neither fits, the free Daily Brief stays free. Nothing changes. Reply if anything's unclear.

— Shashant

---
*{{disclaimer}}*

---

## Standard disclaimer block (paste under every email)

> *For informational and educational purposes only. Not investment advice. Past performance does not guarantee future results. All trading involves risk of loss. You can unsubscribe at any time.*

---

## Per-email asset specs (for the design tool / ESP)

| Email | Visual brief | Hero image alt-text |
|-------|--------------|---------------------|
| Day 0 | Screenshot of the Daily Brief header strip (date + SPY/QQQ/IWM Bull/Bear blocks). Dark navy `#0E1623` background, amber `#F5C25C` accent on the SPY price. Mono font for numbers. | "Timed Trading Daily Brief header showing SPY, QQQ, IWM Bull and Bear plans for the current session." |
| Day 1 (Day 2 send) | Annotated screenshot: same Daily Brief, with arrows labeled (1) Bull/Bear, (2) Sector strip, (3) Open trades. | "Annotated Daily Brief explaining the three sections to read first." |
| Day 5 | Screenshot of `/proof.html` showing the equity curve + Top 5 wins + Top 5 losses tables side-by-side. | "Public proof page showing equity curve, top 5 wins, and top 5 losses for the last 30 days." |
| Day 10 | Composite: kanban lane crops (Setup → Trim → Exit) stitched horizontally with arrows. | "Active Trader kanban lanes from Setup to Exit, showing how one trade moves left to right over time." |
| Day 20 | Side-by-side pricing card: Active Trader $29 vs Investor $99, with the matching dashboard screenshot under each. | "Pricing comparison: Active Trader $29/mo with kanban screenshot, Investor $99/mo with Buy Zone screenshot." |

All images: maintain the dark navy + amber palette. Mono font for all numbers. The disclaimer footer must remain visible if a dashboard screenshot is used.

---

## Send-time confirmation matrix (for the ESP)

| Day offset | ET send time | Why |
|-----------|--------------|-----|
| 0 | 9:15 AM | 15 min after the Daily Brief, so the brief is on top of the inbox. |
| 2 | 7:30 AM | Pre-market read, sets up the day. |
| 5 | 10:30 AM | After the open volatility — reader is curious, not stressed. |
| 10 | 8:00 AM ET Sat | Weekend skim time. Proof page resonates on a Saturday. |
| 20 | 9:00 AM ET Tue | Highest open-rate weekday. CTA day. |

---

*Source of truth: [`tasks/marketing-canonical-plan.md`](../../marketing-canonical-plan.md) §4 ("Email") + §6 (voice) + §8 (compliance).*
