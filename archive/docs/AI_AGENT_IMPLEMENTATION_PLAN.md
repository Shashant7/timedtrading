# AI Agent Implementation Plan

## Quick Start: MVP (Minimum Viable Product)

### Phase 1: Basic Chat Interface (1-2 days)

**Goal**: Get a working chat interface that can answer questions about internal data.

#### Step 1: Create Chat UI Component
- [ ] Create `react-app/src/components/ai-chat/ChatInterface.jsx`
- [ ] Add chat panel to main dashboard (collapsible sidebar or floating widget)
- [ ] Basic message list and input box
- [ ] Loading states and error handling

#### Step 2: Create AI Chat Endpoint
- [ ] Add `/timed/ai/chat` endpoint to `worker/index.js`
- [ ] Integrate OpenAI API (or Anthropic Claude)
- [ ] Basic prompt engineering for trading context
- [ ] Context management (conversation history)

#### Step 3: Internal Data Integration
- [ ] Create data fetcher that queries `/timed/all`, `/timed/activity`, etc.
- [ ] Format data for AI consumption
- [ ] Add to AI context/prompts

### Phase 2: External Data (3-5 days)

#### Step 4: News Integration
- [ ] Integrate NewsAPI.org (free tier)
- [ ] Search news by ticker symbol
- [ ] Cache news results (1 hour TTL)

#### Step 5: Social Media Integration
- [ ] Reddit API integration (r/wallstreetbets, r/stocks, r/investing)
- [ ] Search Reddit posts by ticker
- [ ] Extract sentiment (basic keyword analysis or AI sentiment)

#### Step 6: Twitter/X Integration (Optional)
- [ ] Twitter API v2 setup
- [ ] Search tweets by ticker
- [ ] Rate limiting and quota management

### Phase 3: Monitoring & Proactive Insights (1 week)

#### Step 7: Real-time Monitoring
- [ ] WebSocket or Server-Sent Events for real-time updates
- [ ] Monitor bubble chart changes
- [ ] Track activity feed events

#### Step 8: Alert System
- [ ] Proactive notifications for significant events
- [ ] "New prime setup detected" alerts
- [ ] "Ticker entered corridor" alerts

## Recommended Tech Stack

### AI Provider
**Option A: OpenAI GPT-4**
- Pros: Most capable, best for complex analysis
- Cons: More expensive (~$0.03-0.06 per 1K tokens)
- Best for: Deep analysis, complex queries

**Option B: Anthropic Claude**
- Pros: Good balance, cheaper (~$0.008-0.024 per 1K tokens)
- Cons: Slightly less capable than GPT-4
- Best for: General use, cost-conscious

**Option C: OpenAI GPT-3.5-turbo**
- Pros: Fast, cheap (~$0.0015 per 1K tokens)
- Cons: Less capable for complex reasoning
- Best for: Simple queries, high volume

**Recommendation**: Start with GPT-3.5-turbo for MVP, upgrade to GPT-4 or Claude if needed.

### External APIs

1. **NewsAPI.org** (Free tier: 100 requests/day)
   - Easy integration
   - Good coverage
   - Upgrade to paid for more requests

2. **Reddit API** (Free, no auth needed)
   - Public API access
   - Good for sentiment
   - Rate limits: 60 requests/min

3. **Twitter/X API** (Optional)
   - Requires API key
   - Free tier: 1,500 tweets/month
   - Paid: $100/month for basic

4. **Alpha Vantage** (Free tier: 500 requests/day)
   - Market data, news, sentiment
   - Good for additional context

## Cost Estimates

### Monthly Costs (Moderate Usage)
- AI API (GPT-3.5-turbo): ~$5-15/month
- AI API (GPT-4): ~$20-50/month
- NewsAPI: Free (or $449/month for unlimited)
- Reddit: Free
- Twitter: Free tier or $100/month
- Cloudflare Workers: Free tier (100K requests/day)
- **Total: $5-50/month** (depending on AI model and Twitter)

## Implementation Priority

1. **Week 1**: Basic chat interface + internal data lookup
2. **Week 2**: External news integration
3. **Week 3**: Social media integration (Reddit)
4. **Week 4**: Real-time monitoring and alerts

## Example Prompts for AI

### System Prompt Template
```
You are an expert trading analyst assistant for the Timed Trading platform. 
You help users understand their trading setups, analyze market conditions, 
and provide actionable insights.

You have access to:
- Real-time ticker data (scores, ranks, RR, phase, completion)
- Activity feed (recent events)
- External news and social sentiment

When answering questions:
1. Be concise but thorough
2. Reference specific data points
3. Provide actionable insights
4. Highlight risks when relevant
5. Use markdown for formatting
```

### User Query Examples
- "What's the status of AAPL?"
- "Show me all prime setups"
- "Why did NVDA's rank drop?"
- "What's the news on TSLA?"
- "What are people saying about GOOGL on Reddit?"
- "What are the best setups right now?"

## Next Steps

1. **Decide on AI Provider**: OpenAI vs Anthropic
2. **Choose Chat UI Location**: Sidebar, floating widget, or dedicated tab
3. **Set up API Keys**: Store in Cloudflare Workers secrets
4. **Start with MVP**: Basic chat + internal data
5. **Iterate**: Add external data sources one by one

