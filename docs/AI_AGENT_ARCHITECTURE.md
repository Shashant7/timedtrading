# AI Agent Architecture for Timed Trading Dashboard

## Overview
An AI-powered agent that monitors the trading dashboard, curates insights, and provides real-time analysis through natural language chat. The agent combines internal trading data with external financial news and social sentiment.

## Core Capabilities

### 1. Real-Time Monitoring
- **Bubble Chart Observer**: Tracks ticker movements, quadrant transitions, and score changes
- **Activity Feed Monitor**: Watches for new events (corridor entries, squeeze releases, momentum elite)
- **Alert System**: Identifies significant changes (new prime setups, rank shifts, RR improvements)

### 2. Data Sources

#### Internal Data (Existing)
- `/timed/all` - All ticker data with scores, ranks, RR, phase, completion
- `/timed/activity` - Recent activity events
- `/timed/latest?ticker=X` - Individual ticker data
- `/timed/tickers` - Full ticker index

#### External Data (To Integrate)
- **Financial News**: 
  - NewsAPI.org (free tier: 100 requests/day)
  - Alpha Vantage News & Sentiment API
  - Yahoo Finance RSS feeds
  - Financial Modeling Prep API
  
- **Social Media**:
  - Twitter/X API v2 (requires API key, paid tier for real-time)
  - Reddit API (PRAW - Python Reddit API Wrapper, or direct API)
  - StockTwits API (trading-focused social platform)

- **Market Data**:
  - Current prices, volume, market cap
  - Earnings calendar
  - Analyst ratings

### 3. AI Agent Components

#### A. Context Manager
- Maintains conversation history
- Tracks user preferences and watchlists
- Remembers previous queries and insights
- Manages session state

#### B. Data Retrieval Engine
- Queries internal endpoints for ticker data
- Fetches external news and social data
- Caches frequently accessed data
- Handles rate limiting and API quotas

#### C. Analysis Engine
- Synthesizes internal + external data
- Identifies patterns and correlations
- Generates insights and recommendations
- Provides risk assessments

#### D. Response Generator
- Natural language responses
- Contextual recommendations
- Actionable insights
- Visualizations and summaries

## Architecture Options

### Option 1: Cloudflare Worker + AI API (Recommended)
**Pros:**
- Serverless, scales automatically
- Low latency (edge computing)
- Cost-effective
- Already using Cloudflare Workers

**Cons:**
- Worker execution time limits (10s for free, 30s for paid)
- May need queue system for long-running tasks

**Implementation:**
```
User → React UI (Chat Interface)
  ↓
Cloudflare Worker (/timed/ai/chat)
  ↓
AI Service (OpenAI/Anthropic API)
  ↓
Data Aggregator (Internal + External APIs)
  ↓
Response → User
```

### Option 2: Separate Backend Service
**Pros:**
- No execution time limits
- Can run background jobs
- More control over caching and state

**Cons:**
- Additional infrastructure
- Higher costs
- More complex deployment

### Option 3: Hybrid Approach
- Cloudflare Worker for chat interface
- Separate service for data aggregation and monitoring
- Queue system for background tasks

## Implementation Phases

### Phase 1: Basic Chat Interface (Week 1)
- [ ] Add chat UI component to React dashboard
- [ ] Create `/timed/ai/chat` endpoint in Worker
- [ ] Integrate OpenAI/Anthropic API
- [ ] Basic context management
- [ ] Internal data lookup (ticker data, activity feed)

### Phase 2: External Data Integration (Week 2)
- [ ] Integrate NewsAPI for financial news
- [ ] Add Reddit API integration
- [ ] Twitter/X API integration (if available)
- [ ] Data caching layer
- [ ] Rate limiting and quota management

### Phase 3: Monitoring & Alerts (Week 3)
- [ ] Real-time monitoring of bubble chart changes
- [ ] Activity feed watcher
- [ ] Alert generation for significant events
- [ ] Proactive insights and notifications

### Phase 4: Advanced Features (Week 4+)
- [ ] Pattern recognition across multiple tickers
- [ ] Correlation analysis
- [ ] Sentiment analysis from social media
- [ ] Personalized recommendations
- [ ] Historical analysis and backtesting insights

## Technical Stack

### Frontend
- React chat component (existing React app)
- WebSocket or Server-Sent Events for real-time updates
- Markdown rendering for AI responses

### Backend
- Cloudflare Workers (existing)
- AI API: OpenAI GPT-4 or Anthropic Claude
- Vector database (optional): For semantic search of historical data
- Cache: Cloudflare KV or Workers Cache API

### External APIs
- NewsAPI.org (free tier available)
- Reddit API (free, no auth needed for public data)
- Twitter/X API (requires API key)
- Alpha Vantage (free tier: 5 calls/min, 500/day)

## Example User Interactions

### Query Types

1. **Data Lookup**
   - "What's the current status of AAPL?"
   - "Show me all prime setups"
   - "What happened with GOOGL in the last hour?"

2. **Analysis**
   - "Why did NVDA's rank drop?"
   - "What's driving the momentum in tech stocks?"
   - "Compare AAPL and GOOGL setups"

3. **External Context**
   - "What's the news on TSLA?"
   - "What are people saying about NVDA on Reddit?"
   - "Any recent analyst upgrades for tech stocks?"

4. **Recommendations**
   - "What are the best setups right now?"
   - "Should I enter this position?"
   - "What's the risk on this trade?"

5. **Monitoring**
   - "Alert me when any ticker enters Q2"
   - "Watch for squeeze releases in tech sector"
   - "Notify me of new momentum elite stocks"

## Security & Privacy

- API keys stored in Cloudflare Workers secrets
- Rate limiting on chat endpoint
- User session management
- Data privacy compliance (GDPR, etc.)
- No storage of sensitive trading data

## Cost Considerations

### AI API Costs
- OpenAI GPT-4: ~$0.03-0.06 per 1K tokens
- Anthropic Claude: ~$0.008-0.024 per 1K tokens
- Estimated: $10-50/month for moderate usage

### External API Costs
- NewsAPI: Free tier (100 req/day) or $449/month (unlimited)
- Reddit: Free (public API)
- Twitter/X: Free tier limited, $100/month for basic
- Alpha Vantage: Free tier (500 req/day)

### Infrastructure
- Cloudflare Workers: Free tier (100K requests/day)
- KV Storage: Free tier (100K reads/day)

## Next Steps

1. **Start with Phase 1**: Basic chat interface with internal data lookup
2. **Choose AI Provider**: OpenAI vs Anthropic (cost vs capability)
3. **Design Chat UI**: Where to place it in dashboard
4. **Create MVP**: Get basic query/response working
5. **Iterate**: Add external data sources one by one

## Example Implementation Structure

```
worker/
  index.js (existing)
  ai/
    chat.js (new - chat endpoint)
    context.js (new - context management)
    data-fetcher.js (new - data aggregation)
    prompts.js (new - AI prompt templates)

react-app/
  src/
    components/
      ai-chat/ (new)
        ChatInterface.jsx
        MessageList.jsx
        InputBox.jsx
        AgentAvatar.jsx
```

## Questions to Consider

1. **Where should the chat interface live?**
   - Sidebar panel?
   - Floating widget?
   - Dedicated tab/page?

2. **Real-time updates?**
   - WebSocket connection?
   - Polling?
   - Server-Sent Events?

3. **AI Model Choice?**
   - GPT-4 (more capable, more expensive)
   - GPT-3.5-turbo (faster, cheaper)
   - Claude (good balance)

4. **Caching Strategy?**
   - Cache external API responses?
   - Cache AI responses for similar queries?
   - How long to cache?

5. **User Authentication?**
   - Per-user context?
   - Shared context?
   - Personalized insights?

