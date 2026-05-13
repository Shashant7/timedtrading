# Batch 0 / Deliverable 6 — Long-form YouTube script

> **Working title:** *"I let an AI manage 600 trades over 10 months — here's what happened."*
> **Target runtime:** 8–10 minutes (~1,400–1,700 spoken words).
> **Format:** founder-on-camera intro (0:00–0:30), then full-screen dashboard with founder voiceover (0:30–8:00), founder-on-camera close (8:00–end).
> **Voice:** founder, off-site, "you / your" allowed in narration. When the script quotes engine output, switch to *"the engine"* / *"the model"*.
> **Numbers in `{{brackets}}`** = operator confirms from live data before recording. Numbers without brackets are pulled from the screenshots provided 2026-05-13.

---

## Cold-open hook (0:00 – 0:20)

> [On-camera, plain dark backdrop, founder mid-shot. Active Trader dashboard visible as a faint window on the right side of the frame.]
>
> Ten months ago, I started running my swing trades through an engine I'd built. No discretion, no overrides — if the model said exit, I exited.
>
> 593 trades later, the account went from $100K to about $140K. **+40%, before fees.** Some of those trades hit +18% in a week. Some of them hit my stop and lost money. All of them are public on a page anyone can read.
>
> This video is what worked, what didn't, and what I'd tell anyone thinking about delegating their exit rule to a piece of software. None of this is investment advice.

*[Lower-third overlay 0:08–0:18: "10 months · 593 closed trades · ~$100K → ~$140K · Not investment advice · Past performance ≠ future results"]*

---

## Beat 1 — What the engine actually is (0:20 – 1:30)

> [B-roll: full-screen Active Trader kanban scroll, slow pan left-to-right across the six lanes. Then Investor board scroll across the four lanes.]
>
> Two modes, same engine. The first is Active Trader — swing trading. It takes 240+ tickers and places each one in a single lane: Setup, In Review, Hold, Defend, Trim, Exit. The lane *is* the decision. If a stock is in Trim, the next action is partial profit. If it's in Defend, the next action is the stop. I never have to read 10 indicators.
>
> The second mode is Investor — long-term. Same engine, different lanes: Buy Zone, Core Hold, Hold & Watch, Reduce. One decision per name per day.
>
> The score behind both modes is multi-timeframe — daily, 4-hour, 1-hour, 30-min, all stacked into one number. That same score finds the trade, manages the trim, and fires the exit. The integration is the whole product. Most signal services stop at the entry. The trim and the exit are where 70% of P&L lives, and that's where almost every discretionary system bleeds.

---

## Beat 2 — Live walkthrough (1:30 – 3:30)

> [Full-screen screen capture: open `timed-trading.com/proof.html`. Scroll slowly from the equity curve to the Top 5 wins to the Top 5 losses. Voiceover keeps pace.]
>
> This is the public proof page. No login. Live numbers, refreshed every 5 minutes.
>
> Equity curve from July 2025 through today — $100K start, around $140K now. **Plus 40%**, before fees and slippage. The bumpy bits are real — there's a drawdown in early {{month}} and another in {{month}}. The max drawdown the page logs is about {{max_dd}}%.
>
> Top 5 wins, top 5 losses — same page, same window. I'll come back to why that's deliberate.
>
> [Switch to the Trades page screen capture. Scroll through recent closed trades.]
>
> Every trade has a lane history. AGYS entered Setup on {{date}}, moved to Hold on {{date}}, the engine fired Trim at TP1 for +1.83%, the runner trailed, TP3 fired at +18% on {{date}}. The whole lifecycle is in the ledger.
>
> [Switch to the Daily Brief.]
>
> The Daily Brief is what arrives at 9 AM ET every market day. Bull Plan, Bear Plan, ATR levels, sector context. Two prices per index. That's the whole skim. The free tier of the product is just this email — no upgrade required.

---

## Beat 3 — Three best trades, with the why (3:30 – 5:00)

> [B-roll: zoomed crops of the three trade autopsy modals. Each one stays on screen for ~25 seconds.]
>
> Three of the better trades. Showing the *why*, not the size.
>
> **One — AGYS.** Setup fired on the daily phase BULL with LTF confluence. Entry around {{entry}}. TP1 trimmed 50%, SL trailed to entry. TP3 closed the runner at +18%. The reason this worked: the multi-timeframe score held confluence the entire 9-bar move. The engine didn't try to call a top — it let the trim ladder do the work.
>
> **Two — FIX in Investor mode.** Buy Zone entry around {{entry}}. Currently sitting at +42% over a multi-month hold. **No trims yet** — Investor mode doesn't trim until the trend breaks on the higher timeframe. This is the kind of trade where discipline is "do nothing for three months". Hard to do without a rule.
>
> **Three — a setup the engine *didn't* take.** NVDA pre-market: phase BULL, but LTF lost confluence the night before — daily ATR exhaustion + 30-min flagged-bear. The engine logged "no entry" with timestamp + reason. The same week NVDA had a {{nvda_drop}}% intraday flush. The trades that didn't happen are part of the ledger too, with the reason written down.

---

## Beat 4 — Three worst trades, with the why (5:00 – 6:30)

> [B-roll: zoomed crops of three losing trades. Same modal format. Don't sugarcoat — the goal is to land trust.]
>
> Three of the worst, in the same window. This is the part most YouTube trading videos skip.
>
> **One — INFL.** Long entry, daily phase BULL, but the trade never developed. Engine fired Defend → Exit at −1.31%. In hindsight the entry was on a frothy momentum bar without backing volume. The model has since been re-weighted to penalize that exact signature. The loss is real and the loss is in the ledger.
>
> **Two — a fast-trim bug.** In April we had a stretch where the trim rule was firing one bar too early on low-volume names. The fix is documented on a separate page if you care about the engineering, but the trades during that window all show under-realized R:R. They're still in the ledger.
>
> **Three — a news-shock loss.** Pre-earnings rule says trim into the event. This trade trimmed into the event and the remaining runner gapped down on guidance. The trim limited the damage but it didn't eliminate it. The engine isn't a hedge against news shocks. It's a discipline layer on the parts of the trade that *can* be systematized.
>
> Losses aren't an embarrassment — they're the receipt for the wins. A system that won't show its losses is a sales pitch, not a system.

---

## Beat 5 — What the engine learned (6:30 – 7:30)

> [Footage: founder back on camera, leaning into the lens. Then cut to the model dashboard / lane history.]
>
> Three things the engine learned in 10 months.
>
> **One — exit weight matters more than entry weight.** When I started, the score was 70% entry signal, 30% management. Now it's closer to 40 / 60. Most of the gain came from making the trim and the stop smarter, not finding more entries.
>
> **Two — the daily phase is the regime gate.** When daily phase is BULL the engine takes long setups freely. When it's BEAR, longs are filtered hard. We've been in BULL for most of the live window. The honest answer to "what happens in a regime shift" is: there's not 10 months of live BEAR data yet. The backtest covers it. The live ledger will, soon enough.
>
> **Three — fewer trades, higher conviction.** I started 2025 chasing 80 setups a week. The engine now takes about {{trades_per_week}} a week. Win rate went up, average R:R went up, and screen time went down. That's the engineering trade-off: more filtering, less FOMO.

---

## Beat 6 — Honest limits (7:30 – 8:00)

> [Founder on camera, conversational.]
>
> What this is *not* good at, on purpose. It doesn't trade options. It doesn't trade crypto. It doesn't do 0DTE or earnings lottery tickets. It doesn't replace an index core. And it doesn't tell you what to buy in your retirement account — Investor mode is for the single-name concentration on top of an index base, not the base itself.
>
> If you want a system that's loud and tries to do everything, this isn't it. If you want a system that's narrow and tells you when the trade you're already in is broken, this is exactly it.

---

## CTA close (8:00 – 8:30)

> [Founder on camera. Behind: faint Active Trader dashboard.]
>
> Everything in this video is at `timed-trading.com`. The free Daily Brief lives at `/daily-brief`. The public proof page — equity curve, wins, losses, max drawdown, Sharpe — is at `/proof.html`. No login on either.
>
> If a system can't survive showing its losses, it shouldn't be sold. Mine survives. Watch it for a few weeks before you decide anything. And if it convinces you, the paid tier is $29 a month for Active Trader, $99 for Investor.
>
> One ask before you go: comment with the trade you most recently held too long — the one that gave it all back. I read every one, and the next video will pull from those.
>
> *Not investment advice. For informational and educational purposes only. Past performance does not guarantee future results. All trading involves risk of loss.*

*[End card 8:25–8:35: `timed-trading.com/proof.html` + `Daily Brief — free at 9 AM ET` + disclaimer in small type.]*

---

## B-roll suggestions per minute

| Minute | Footage |
|--------|---------|
| 0:00 – 0:30 | Founder on camera, dashboard in soft-focus window behind. |
| 0:30 – 1:30 | Kanban scroll Active Trader → Investor board scroll. Light, slow camera moves. |
| 1:30 – 3:30 | Screen capture: `/proof.html` equity curve → Top 5 wins → Top 5 losses → Trades page lane history → Daily Brief. |
| 3:30 – 5:00 | Three trade autopsy modals fullscreen, ~25 sec each, with kinetic-type labels for ticker + outcome. |
| 5:00 – 6:30 | Three losing trade autopsies, same template. Use red accents per the brand. |
| 6:30 – 7:30 | Cut between founder on camera and dashboard lane-history visualizations. |
| 7:30 – 8:00 | Founder on camera, single take, no cuts. Conversational. |
| 8:00 – 8:30 | Founder on camera, end card overlays the last 5 seconds. |

---

## Thumbnail concept

**Image:** Founder face left-half of frame, looking slightly off-camera. Right-half: zoomed crop of the equity curve from `/proof.html` showing the $100K → $140K rise.

**Text overlay:** Three lines, mono font, top-right corner:

- Line 1 — `593 TRADES` (small caps, amber `#F5C25C`)
- Line 2 — `10 MONTHS` (small caps, amber `#F5C25C`)
- Line 3 — `+40%*` (large, white)

**Footer overlay (small):** `*Before fees. Past performance ≠ future results. Not advice.`

**Background:** Dark navy `#0E1623`. Light vignette around the founder face.

**Avoid:** rocket emojis, "shocking", "you won't believe", red-arrow-and-circle YouTube tropes. The thumbnail's job is to look like an engineering postmortem, not a hype clip — that's the brand wedge.

---

## Description (paste into YouTube description box)

> *For informational and educational purposes only. Not investment advice. Past performance does not guarantee future results. All trading involves risk of loss.*
>
> I built a multi-timeframe scoring engine that places every U.S. equity in one of six action lanes (Setup → Exit) for swing trading, and four lanes (Buy Zone → Reduce) for long-term holds. Then I let it manage my account for 10 months. 593 closed trades later, this video walks through what worked, what didn't, what I'd do differently, and where the system stops being useful.
>
> Live proof page (equity curve, top 5 wins, top 5 losses, last 30 days): https://timed-trading.com/proof.html
> Free Daily Brief: https://timed-trading.com/daily-brief
>
> Chapters:
> 0:00 — Hook
> 0:20 — What the engine is
> 1:30 — Live walkthrough
> 3:30 — Three best trades
> 5:00 — Three worst trades
> 6:30 — What the engine learned
> 7:30 — Where it stops being useful
> 8:00 — CTA
>
> Built on Cloudflare Workers, D1, Durable Objects. Price feed via TwelveData. ATR levels via Saty Multi-Day.
>
> Not investment advice. Educational only.

---

## Pinned comment

> The losses are on the same page as the wins on purpose — `timed-trading.com/proof.html`. If anything's unclear about a specific lane, reply here and I'll answer. Not investment advice; past performance doesn't guarantee future results.

---

*Source of truth: [`tasks/marketing-canonical-plan.md`](../../marketing-canonical-plan.md) §4 ("YouTube") + §6 (voice) + §8 (compliance).*
