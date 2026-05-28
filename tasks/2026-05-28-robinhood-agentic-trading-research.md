# Robinhood Agentic Trading — Research + TT Integration Plan (2026-05-28)

## User question

> Can you review https://robinhood.com/us/en/agentic-trading/ and see if it
> is a good way for us to automate live trading using our system?
>
> I do think the key for us to go from "its cool" to "wow, it works" is if
> we allowed users to automate their trades against their broker using our
> TT System. I guess the first step is to vet it ourselves now that we are
> getting closer to seeing the engine work mostly and trade simulation
> getting better both reliability wise as performance wise.

## TL;DR — Recommendation

**Yes, it's a good fit — but not the cleanest path for TT today.** Robinhood
Agentic Trading is built around **AI agents holding the MCP session**, not
around server-side broker integrations. The fit becomes great once we accept
that TT's role is "produce trade decisions and publish them as signals" and
the user's AI (Claude / Codex / Cursor) is the executor.

Recommended shape: **Option C — Sidecar bridge**. Build a `tt-broker-bridge`
worker that (a) consumes TT's trade decisions via webhook and (b) proxies to
Robinhood's MCP using per-user OAuth tokens stored encrypted in CF KV. This
keeps the TT decision engine unchanged and makes future broker adapters
(Tastytrade, IBKR, Schwab) drop-in.

Phased rollout: paper-trade today (already live), single-operator end-to-end
test next (the user with a small funded Agentic account), Pro-tier feature
with hard caps in Phase 3.

---

## What Robinhood actually offers

### Surface

- **Single MCP URL:** `https://agent.robinhood.com/mcp/trading`
- **Auth:** OAuth flow per user, must do initial setup on desktop. Sessions cached after first auth.
- **Account model:** Customer creates a *separate* "Agentic Account" funded with whatever amount they want their agent to manage. Cleanly sandboxed from the user's main brokerage.
- **Kill switch:** Disconnect from Robinhood app at any time (one tap).
- **Notifications:** Push notification on every fill.

### Tools (10, as of launch)

| Tool | Purpose |
| --- | --- |
| `get_accounts` | List user's RH accounts |
| `get_portfolio` | Portfolio snapshot incl. cash, BP, value by asset class |
| `get_equity_positions` | Open positions with qty + cost basis |
| `get_equity_quotes` | Real-time quotes (≤20 symbols) |
| `get_equity_orders` | Order history + status |
| `get_equity_tradability` | Is the symbol tradable? Fractional ok? |
| `search` | Company name → ticker |
| `review_equity_order` | Dry-run simulate before placing (pre-trade warnings) |
| `place_equity_order` | Place |
| `cancel_equity_order` | Cancel an open order |

### What's NOT in the tool set

| Missing | Implication for TT |
| --- | --- |
| Options | TT doesn't trade options currently — no impact |
| Shorts | TT *does* take SHORT entries — **immediate blocker for SHORT mode** |
| Crypto | We score BTCUSD/ETHUSD but don't trade them — no impact |
| Stop-loss order types (explicit) | Unclear from docs whether `place_equity_order` supports `stop`/`stop_limit`. Need to test live. If not, TT would have to *manage SL itself* by polling positions and submitting market sells when stop is breached — fine, that's already our model. |
| Bracket / OCO orders | Not listed. TT already manages TP/SL state internally so this is OK. |
| GTC orders | Not listed. Day-only would be a problem for multi-day swings. **Must verify.** |
| Batch placement | Not listed. We'd serialize order calls. ~20 entries/day max for TT so not a real bottleneck. |
| Account-level circuit breakers | Built into RH UX (notifications, disconnect button) — no programmatic equivalent for TT to consume. |

### Constraints worth noting

- **Long equities only at launch.** Robinhood explicitly says "support for more assets soon". TT shorts cannot use Agentic accounts today.
- **Initial setup is desktop-only.** Operator must auth on desktop before the integration works for that user.
- **MCP design assumes an AI agent is the client.** Not a server-to-server REST API. We'd be presenting as an MCP client, which works but isn't the documented happy path.
- **Per-trade push notifications fire on every fill.** That's good UX for the operator but means our throughput is implicitly capped at what the user is willing to be paged about.

---

## Three integration shapes

### Option A — TT-as-MCP-client (worker calls Robinhood MCP directly)

```
TT scoring decides ENTRY → TT Worker → Robinhood MCP → fill → push to user's phone
```

**Pros:**
- Tightest loop, lowest latency, fully deterministic from TT's side
- No third-party agent in the path; decisions and executions are 1:1

**Cons:**
- Robinhood's MCP expects an AI agent client. We'd be presenting as one — possibly fine, possibly hits rate-limit / abuse heuristics
- Per-user OAuth flow lives on TT's worker — we own the token rotation, refresh, leak surface
- If RH changes the MCP shape, our trading stops until we update

**Verdict:** Possible but fragile. Robinhood will optimize their MCP for actual AI clients, not server adapters.

### Option B — Operator-as-bridge (user's AI agent reads TT, calls RH)

```
TT publishes signals via MCP → user's Claude/Codex/Cursor reads them →
   user's AI decides → user's AI calls Robinhood MCP → fill
```

**Pros:**
- Robinhood auth + agent UX is unchanged (the user uses Robinhood-blessed clients)
- Adds an explicit "human-AI-in-the-loop" — the user's AI can filter / second-guess / batch / scale TT's signals
- TT doesn't store any RH credentials — minimal regulatory surface

**Cons:**
- Decisions are no longer deterministic from TT — they're filtered through whatever the user's AI decides at runtime
- Latency depends on whether the user's AI is running during market hours
- We need to publish a TT MCP server (new product surface)

**Verdict:** Clean separation, lowest TT-side risk, but slowest to execute and depends on user-side AI being live.

### Option C — Sidecar bridge worker (RECOMMENDED)

```
TT scoring engine (existing worker)  ──webhook──►  TT-Broker-Bridge worker
                                                    │
                                                    │  (per-user OAuth tokens
                                                    │   stored encrypted in KV)
                                                    │
                                                    ▼
                                                Robinhood MCP (per user)
                                                    │
                                                    ▼
                                                Fill → push to user
```

**Pros:**
- TT decision engine is unchanged — keeps the current shape (worker + D1 + KV)
- Execution adapter is a thin, swappable layer. Adding Tastytrade later? Build `tt-tastytrade-bridge`. Schwab? Same pattern.
- Per-user OAuth tokens live in the bridge, not the main worker. Smaller secret blast radius.
- Bridge can implement TT-specific safety logic (max daily orders, max position size, kill-switch override) that's broker-agnostic.
- TT keeps the deterministic decision loop.

**Cons:**
- Two workers to deploy + monitor instead of one
- Bridge holds RH credentials → we own the security surface (mitigated by single-purpose worker + Cloudflare's secrets store + encrypted KV)
- Robinhood MCP is still the underlying contract, so if they change it, bridge breaks

**Verdict:** Best of both worlds. TT-side stays clean; broker contracts isolated; future-proof.

---

## Recommended phased rollout

### Phase 0 — Today (paper mode, already live)

- TT decisions populate `positions` + `trades` D1 tables — simulated execution
- All existing functionality untouched

**No change.**

### Phase 1 — Sidecar bridge MVP, operator-only

Goal: prove end-to-end mechanically works on a single funded Agentic account.

1. Build `tt-broker-bridge` worker:
   - Endpoints: `POST /bridge/order` (TT main worker calls this when ENTRY/TRIM/EXIT fires), `GET /bridge/health`, `POST /bridge/oauth/complete`
   - Per-user OAuth: user clicks "Connect Robinhood" → bridge orchestrates RH OAuth → tokens encrypted (AES-256-GCM via WebCrypto) and stored in KV keyed by user email
   - Translates TT order into RH `review_equity_order` → `place_equity_order` calls
2. Wire TT main worker: when `processTradeSimulation` decides ENTRY/TRIM/EXIT and `user.broker_integration === "robinhood"`, additionally call `fetch(BRIDGE_URL + "/bridge/order", ...)` with the order details
3. **Operator-only flag** `broker_integration_enabled = false` by default. Operator (the user) flips it for their own account first
4. **Hard caps** baked in: max $5k per order, max 3 orders/day per user, total agentic account budget cap (read from RH `get_portfolio`)
5. **Mandatory dry-run first**: every order goes through `review_equity_order` before `place_equity_order` — if RH flags it, bridge logs and refuses

Duration: 1-2 weeks engineering, 1 week operator-only testing.

### Phase 2 — Pro-tier preview (5-10 customers)

- Pro users opt-in via a setting toggle
- Per-user RH Agentic account is required (RH enforces this)
- Hard caps + kill-switch on TT side (operator can pause all live trading by flipping a global flag)
- LONG-only (RH constraint)
- TT marks the position with `broker = "robinhood"` and shows live RH order IDs in the UI
- Weekly review meeting to surface issues

### Phase 3 — General availability

- All Pro users can opt in
- Marketing message: "TT decides, your broker executes — connected via Robinhood Agentic"
- Add Tastytrade adapter for users who want options + shorts (different MCP, same bridge pattern)
- Add Schwab adapter when their API stabilizes

---

## Open questions before Phase 1

1. **GTC support.** Does `place_equity_order` accept `time_in_force=gtc`? If day-only, TT can't trust a stop-loss order to persist overnight — would need to re-submit at every open.
2. **Stop-loss order types.** Does the tool accept `order_type=stop` or `stop_limit`? If only `market`/`limit`, TT manages SL itself by monitoring positions and firing market sells.
3. **Rate limits.** Documented limit? In practice — TT's max throughput is ~10 entries/hour, well below anything reasonable, but worth confirming.
4. **Fractional support.** Documented yes for some symbols (`get_equity_tradability`). TT already computes fractional shares in `processTradeSimulation` — good fit.
5. **Settlement / cash mode.** Agentic accounts may default to settled cash (T+1) vs. margin. TT's current sizing assumes immediate buying power.
6. **Disconnect-fired-during-position-open.** If the operator disconnects RH mid-trade, what happens to open positions? Stay open or auto-flat? Need to test.
7. **OAuth refresh cadence.** Token TTL, refresh flow, and what happens if refresh fails during market hours.

These get answered during the Phase 1 operator-test with the user's small funded account.

---

## What this PR ships

Just this research doc. No code. Phase 1 (the sidecar bridge worker) is a
separate planning + scoping exercise based on this recommendation. The user
asked us to vet the platform — vetted, recommend Option C with Phase 1
operator-only test as the immediate next step.

## What the user can do today

1. **Read this doc.** Confirm Option C is the right shape (vs A or B).
2. **Fund a small Robinhood Agentic account** (e.g. $500-$1000) on the user's own RH login. Connect it to Claude Desktop or Codex CLI via Robinhood's MCP setup so the user has hands-on familiarity with the agent UX.
3. **Manually test a few trades** through Claude → RH MCP to surface any of the open questions above.
4. **Approve Phase 1** if Option C still looks right post-hands-on.

Then we scope and build `tt-broker-bridge`.
