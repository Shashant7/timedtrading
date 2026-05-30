# Discord Alerts

**WHEN to use:** A user reports "I didn't get the alert" (entry, exit,
investor, daily brief), or you've added a new alert path and want to
verify it fires.

**Prerequisites:**
- `DISCORD_BOT_TOKEN` secret set
- `DISCORD_GUILD_ID` configured
- Test user has joined the guild and been assigned the gated role

---

## Alert types

| Source | Function | Channel |
|---|---|---|
| Entry (new trade opened) | `discordSendTradeOpenEmbed` | `#trades` |
| Exit (trade closed) | `discordSendTradeCloseEmbed` | `#trades` |
| Investor (zone enter / exit) | `discordSendInvestorAlertEmbed` | `#investor` |
| Daily Brief (morning + evening) | `discordPostDailyBrief` | `#daily-brief` |
| AI CIO reject | `discordSendCioRejectEmbed` | `#cio-decisions` |
| Mission Control critical | `discordSendMissionControlAlert` | `#operations` |

All implemented in `worker/discord.js` / `worker/alerts.js`.

---

## Fire a test alert manually

### Test entry embed for a synthetic ticker

```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/discord/test" \
  -H "Content-Type: application/json" \
  -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  -d '{"kind":"entry","ticker":"TEST","direction":"LONG","entry_price":100,"sl":98,"tp":105}'
```

### Test daily brief preview

```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/daily-brief/preview" \
  -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  -d '{"session":"morning","post_to_discord":false}' | python3 -m json.tool | head -30
```

`post_to_discord:false` runs the full LLM generation but doesn't actually
post — useful for verifying prompt + content. Set to true to send.

### Test investor alert

```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/discord/investor-test" \
  -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  -d '{"ticker":"AMZN","zone":"accumulate","zone_type":"true_accumulation"}'
```

---

## "Bot doesn't send to user" troubleshooting

If a user reports they didn't get a DM or weren't tagged in a channel:

1. **Check role assignment** — the bot only @-mentions users with the
   gated role.
   ```bash
   curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/discord/fix-role" \
     -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
     -d '{"discord_id":"USER_DISCORD_ID"}'
   ```

2. **Check bot role hierarchy** — the bot role MUST be ABOVE the role it's
   trying to assign in the Discord guild settings. If not, `PUT /roles`
   returns 403 and the user gets the welcome email but never the role.

3. **Check user email preferences** — `email_preferences` D1 table.
   Investor alerts have their own preference toggle (PR #382). Some
   users opt out of Discord-only too.

---

## "Embed is malformed / shows blank fields"

Discord embeds have strict limits:

- Total payload < 6000 chars
- Each `field.value` < 1024 chars
- Footer < 2048 chars
- Title < 256 chars

If a generated embed busts a limit, Discord returns 400 silently (we
log to console.warn but don't surface to the user). Check the worker
tail logs:

```bash
cd /workspace/worker
../node_modules/.bin/wrangler tail --env production --format=pretty
```

…then trigger the alert again from another terminal.

---

## "Daily brief never posted"

Likely causes (in order of frequency):

1. **`OPENAI_API_KEY` secret missing** — daily brief LLM call fails silently.
2. **`max_completion_tokens` not set** — GPT-5.4 requires it (NOT
   `max_tokens`). The code already handles this; if you've recently
   changed `worker/daily-brief.js` make sure you preserved the flag.
3. **Cron didn't fire** — check `/timed/health → minutesSinceScoring`
   (proxy for cron health overall).

## Source

- `worker/discord.js` — bot client + embed senders
- `worker/alerts.js` — embed BUILDERS (entry/exit/investor/cio)
- `worker/daily-brief.js` — morning + evening brief generation
- `worker/email.js` — email side of dual-channel notifications
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → "Discord" entries
