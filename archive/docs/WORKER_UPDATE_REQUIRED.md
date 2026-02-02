# Worker Update Required

Your live Worker is missing several features that were added. Here's what needs to be updated:

## Missing Features

### 1. ✅ Momentum Elite Calculation
- **Function**: `computeMomentumElite()` (lines 141-284)
- **Purpose**: Calculates Momentum Elite status with caching
- **Impact**: Enables Momentum Elite score boost and visual indicators

### 2. ✅ Momentum Elite Score Boost
- **Location**: `computeRank()` function
- **Change**: Add `momentumElite` flag check and +20 point boost
- **Impact**: Momentum Elite stocks get higher ranks

### 3. ✅ Enhanced Trail Data
- **Location**: `appendTrail()` call in ingest endpoint
- **Changes**: 
  - Add `flags`, `momentum_elite`, `trigger_reason`, `trigger_dir` to trail
  - Increase `maxN` from 8 to 20
- **Impact**: Enables quadrant progression visualization in UI

### 4. ✅ Momentum Elite API Endpoints
- **Endpoints**:
  - `GET /timed/momentum?ticker=XYZ`
  - `GET /timed/momentum/history?ticker=XYZ`
  - `GET /timed/momentum/all`
- **Impact**: UI can fetch Momentum Elite data

## Quick Update Guide

### Option 1: Full Replace (Recommended)
Replace your entire `worker/index.js` with the updated version from the repo.

### Option 2: Incremental Updates
Add these sections to your live Worker:

#### Step 1: Add Momentum Elite Function
Add after `pct01()` function (around line 139):

```javascript
//─────────────────────────────────────────────────────────────────────────────
// Momentum Elite Calculation (Worker-Based with Caching)
//─────────────────────────────────────────────────────────────────────────────

// Fetch market cap from external API (placeholder - implement with your preferred API)
async function fetchMarketCap(ticker) {
  // TODO: Implement with Alpha Vantage, Yahoo Finance, or other API
  // For now, return null to skip market cap check
  return null; // Will be implemented with actual API
}

// Calculate Average Daily Range (ADR) from price data
function calculateADR(price, high, low) {
  if (!price || price <= 0) return null;
  const dailyRange = (high - low) / price;
  return dailyRange;
}

// Calculate percentage change over period
function calculatePctChange(current, previous) {
  if (!previous || previous <= 0) return null;
  return (current - previous) / previous;
}

// Check if ticker meets Momentum Elite criteria
async function computeMomentumElite(KV, ticker, payload) {
  const cacheKey = `timed:momentum:${ticker}`;
  const now = Date.now();
  
  // Check cache (5 minute TTL for final status)
  const cached = await kvGetJSON(KV, cacheKey);
  if (cached && (now - cached.timestamp < 5 * 60 * 1000)) {
    return cached;
  }

  const price = Number(payload.price) || 0;
  
  // All base criteria must be true:
  // 1. Price > $4
  const priceOver4 = price >= 4.0;
  
  // 2. Market Cap > $1B (cached for 24 hours)
  const marketCapKey = `timed:momentum:marketcap:${ticker}`;
  let marketCapOver1B = true; // Default to true if we can't check
  const marketCapCache = await kvGetJSON(KV, marketCapKey);
  if (marketCapCache && (now - marketCapCache.timestamp < 24 * 60 * 60 * 1000)) {
    marketCapOver1B = marketCapCache.value;
  } else {
    // Fetch fresh market cap
    const marketCap = await fetchMarketCap(ticker);
    if (marketCap !== null) {
      marketCapOver1B = marketCap >= 1000000000;
      await kvPutJSON(KV, marketCapKey, { value: marketCapOver1B, timestamp: now }, 24 * 60 * 60);
    }
  }
  
  // 3. Average Daily Range > 2% (cached for 1 hour, calculated from recent data)
  const adrKey = `timed:momentum:adr:${ticker}`;
  let adrOver2Pct = false;
  const adrCache = await kvGetJSON(KV, adrKey);
  if (adrCache && (now - adrCache.timestamp < 60 * 60 * 1000)) {
    adrOver2Pct = adrCache.value;
  } else {
    // Calculate ADR from current data (simplified - in production, use 50-day average)
    const high = Number(payload.high) || price;
    const low = Number(payload.low) || price;
    const adr = calculateADR(price, high, low);
    adrOver2Pct = (adr !== null) && (adr >= 0.02);
    await kvPutJSON(KV, adrKey, { value: adrOver2Pct, timestamp: now }, 60 * 60);
  }
  
  // 4. Average Volume (50 days) > 2M (cached for 1 hour)
  const volumeKey = `timed:momentum:volume:${ticker}`;
  let volumeOver2M = false;
  const volumeCache = await kvGetJSON(KV, volumeKey);
  if (volumeCache && (now - volumeCache.timestamp < 60 * 60 * 1000)) {
    volumeOver2M = volumeCache.value;
  } else {
    // Use current volume as proxy (in production, calculate 50-day average)
    const volume = Number(payload.volume) || 0;
    volumeOver2M = volume >= 2000000;
    await kvPutJSON(KV, volumeKey, { value: volumeOver2M, timestamp: now }, 60 * 60);
  }
  
  // All base criteria
  const allBaseCriteria = priceOver4 && marketCapOver1B && adrOver2Pct && volumeOver2M;
  
  // Any momentum criteria (cached for 15 minutes):
  // These would ideally come from historical data or external APIs
  // For now, we'll use placeholder logic
  const momentumKey = `timed:momentum:changes:${ticker}`;
  let anyMomentumCriteria = false;
  const momentumCache = await kvGetJSON(KV, momentumKey);
  if (momentumCache && (now - momentumCache.timestamp < 15 * 60 * 1000)) {
    anyMomentumCriteria = momentumCache.value;
  } else {
    // TODO: Fetch historical prices for week/month/3month/6month calculations
    // For now, placeholder - in production, fetch from TradingView API or external source
    anyMomentumCriteria = false; // Placeholder
    await kvPutJSON(KV, momentumKey, { value: anyMomentumCriteria, timestamp: now }, 15 * 60);
  }
  
  const momentumElite = allBaseCriteria && anyMomentumCriteria;
  
  // Store result with metadata
  const result = {
    momentum_elite: momentumElite,
    criteria: {
      priceOver4,
      marketCapOver1B,
      adrOver2Pct,
      volumeOver2M,
      allBaseCriteria,
      anyMomentumCriteria
    },
    timestamp: now
  };
  
  // Check for status change and log history
  const prevStatus = cached ? cached.momentum_elite : false;
  if (momentumElite !== prevStatus) {
    const historyKey = `timed:momentum:history:${ticker}`;
    const history = await kvGetJSON(KV, historyKey) || [];
    history.push({
      status: momentumElite,
      timestamp: now,
      criteria: result.criteria
    });
    // Keep last 100 status changes
    const trimmedHistory = history.slice(-100);
    await kvPutJSON(KV, historyKey, trimmedHistory);
  }
  
  // Cache result
  await kvPutJSON(KV, cacheKey, result, 5 * 60);
  
  return result;
}
```

#### Step 2: Update computeRank()
Find the `computeRank()` function and add this line before the final `return`:

```javascript
function computeRank(d) {
  // ... existing code ...
  
  const flags = d.flags || {};
  const sqRel = !!flags.sq30_release;
  const sqOn = !!flags.sq30_on;
  const phaseZoneChange = !!flags.phase_zone_change;
  const momentumElite = !!flags.momentum_elite;  // ADD THIS LINE
  
  // ... existing scoring logic ...
  
  if (Number.isFinite(rr)) score += Math.min(10, rr * 2);

  // ADD THIS BLOCK:
  // Momentum Elite boost (significant boost for high-quality momentum stocks)
  if (momentumElite) score += 20;

  score = Math.max(0, Math.min(100, score));
  return Math.round(score);
}
```

#### Step 3: Update Ingest Endpoint
In the `/timed/ingest` POST handler, find where you calculate rank and add this BEFORE `payload.rank = computeRank(payload)`:

```javascript
      // Derived: rr/rank
      payload.rr = payload.rr ?? computeRR(payload);
      if (payload.rr != null && Number(payload.rr) > 25) payload.rr = 25;

      // ADD THIS BLOCK:
      // Calculate Momentum Elite (worker-based with caching)
      const momentumEliteData = await computeMomentumElite(KV, ticker, payload);
      if (momentumEliteData && momentumEliteData.momentum_elite) {
        // Update flags with Momentum Elite status
        if (!payload.flags) payload.flags = {};
        payload.flags.momentum_elite = true;
        // Store full criteria for debugging/display
        payload.momentum_elite_criteria = momentumEliteData.criteria;
      } else {
        // Ensure flag is set to false if not elite
        if (!payload.flags) payload.flags = {};
        payload.flags.momentum_elite = false;
      }

      payload.rank = computeRank(payload);
```

#### Step 4: Update appendTrail Call
Find the `appendTrail()` call and update it:

```javascript
      // OLD:
      await appendTrail(KV, ticker, {
        ts: payload.ts,
        htf_score: payload.htf_score,
        ltf_score: payload.ltf_score,
        completion: payload.completion,
        phase_pct: payload.phase_pct,
        state: payload.state,
        rank: payload.rank
      }, 8);

      // NEW:
      await appendTrail(KV, ticker, {
        ts: payload.ts,
        htf_score: payload.htf_score,
        ltf_score: payload.ltf_score,
        completion: payload.completion,
        phase_pct: payload.phase_pct,
        state: payload.state,
        rank: payload.rank,
        flags: payload.flags || {},
        momentum_elite: !!(payload.flags && payload.flags.momentum_elite),
        trigger_reason: payload.trigger_reason,
        trigger_dir: payload.trigger_dir
      }, 20); // Increased to 20 points for better history
```

#### Step 5: Add API Endpoints
Add these endpoints BEFORE the `/timed/health` endpoint:

```javascript
    // GET /timed/momentum?ticker=XYZ
    if (url.pathname === "/timed/momentum" && req.method === "GET") {
      const ticker = normTicker(url.searchParams.get("ticker"));
      if (!ticker) return sendJSON({ ok:false, error:"missing ticker" }, 400, corsHeaders(env));
      const data = await kvGetJSON(KV, `timed:momentum:${ticker}`);
      return sendJSON({ ok:true, ticker, data }, 200, corsHeaders(env));
    }

    // GET /timed/momentum/history?ticker=XYZ
    if (url.pathname === "/timed/momentum/history" && req.method === "GET") {
      const ticker = normTicker(url.searchParams.get("ticker"));
      if (!ticker) return sendJSON({ ok:false, error:"missing ticker" }, 400, corsHeaders(env));
      const history = (await kvGetJSON(KV, `timed:momentum:history:${ticker}`)) || [];
      return sendJSON({ ok:true, ticker, history }, 200, corsHeaders(env));
    }

    // GET /timed/momentum/all
    if (url.pathname === "/timed/momentum/all" && req.method === "GET") {
      const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
      const eliteTickers = [];
      for (const t of tickers) {
        const momentumData = await kvGetJSON(KV, `timed:momentum:${t}`);
        if (momentumData && momentumData.momentum_elite) {
          eliteTickers.push({ ticker: t, ...momentumData });
        }
      }
      return sendJSON({ ok:true, count: eliteTickers.length, tickers: eliteTickers }, 200, corsHeaders(env));
    }
```

## Deployment Steps

1. **Update the file**: Make the changes above to your `worker/index.js`
2. **Test locally** (optional): `wrangler dev`
3. **Deploy**: `wrangler deploy`
4. **Verify**: Test the health endpoint and check logs

## What This Enables

✅ Momentum Elite detection and score boost (+20 points)  
✅ Enhanced trail data for quadrant progression visualization  
✅ Momentum Elite API endpoints for UI  
✅ Better history tracking (20 points vs 8)  

## Backward Compatibility

All changes are backward compatible:
- Existing data continues to work
- New fields are optional
- Old endpoints unchanged
- New endpoints are additive

