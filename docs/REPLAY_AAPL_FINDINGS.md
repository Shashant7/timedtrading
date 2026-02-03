# Replay AAPL: Are We Getting Trades and Why?

## Run: DATE=2026-02-02, TICKER=AAPL, DEBUG=1

### Are we getting trades?

**Yes.** In the full run we got **2 trades** for AAPL:
- **Bucket 1:** +1 trade (purged 1 from clean slate, then created 1).
- **Bucket 26:** +1 trade.

So:
- AAPL rows are now being processed (pagination fix is working).
- Two moments in the day met all entry gates (rank, RR, completion, phase, regime, etc.) and trades were opened.

### Why don’t we get more trades?

Debug showed **enter_now** moments that did **not** create a trade because **shouldTrigger** was false. Example blockers:

| Blocker | Value | Threshold |
|--------|--------|-----------|
| `rank_below_min(50<70)` | rank 50 | min 70 (non–momentum-elite) |
| `rr_below_min(0.05<1.2)` | RR 0.05 | min 1.2 |
| (implied) completion | comp 0.96 | max 0.5–0.6 |

So that candle was correctly **blocked**: low rank, very low RR, and move almost finished (96% completion). Other enter_now moments may be blocked by:
- **rank** &lt; 70 (or &lt; 60 if momentum_elite)
- **rr** &lt; 1.2
- **completion** &gt; 0.5–0.6
- **phase** &gt; 0.65
- **htf_regime_gate** / **ichimoku_regime_gate** / **late_cycle**

### Summary

- **Trades:** We are getting trades when the payload passes all gates (e.g. bucket 1).
- **Why not more:** Many enter_now candles fail rank, RR, or completion; that’s by design to avoid late or low-quality entries.

### 429 Too Many Requests

Replay hits Cloudflare KV write rate limits (each bucket does multiple KV PUTs: `timed:latest:AAPL`, `timed:trades:all`). At **DELAY_MS=1000** we still hit 429 around bucket 56. Options:
- Use **DELAY_MS=1500** or **2000** to finish the full day.
- Or run in two passes (e.g. first half of buckets, then second half after a pause).
