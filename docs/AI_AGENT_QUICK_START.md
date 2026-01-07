# AI Agent Quick Start Guide

## Overview

This guide will help you set up the AI Trading Assistant feature. The AI agent can:
- Answer questions about tickers and setups
- Analyze market conditions
- Search external news and social media
- Provide real-time insights

## Current Status

✅ **Completed:**
- Architecture documentation
- Basic chat UI component (`react-app/src/components/ai-chat/ChatInterface.jsx`)
- Chat endpoint skeleton (`/timed/ai/chat` in worker)

⏳ **Next Steps:**
- Configure AI API (OpenAI or Anthropic)
- Integrate chat UI into main dashboard
- Add external data sources (news, social media)

## Step 1: Choose Your AI Provider

### Option A: OpenAI (Recommended for MVP)
- **Model**: GPT-3.5-turbo (fast, cheap) or GPT-4 (more capable)
- **Cost**: ~$0.0015-0.06 per 1K tokens
- **Setup**: Get API key from https://platform.openai.com/api-keys

### Option B: Anthropic Claude
- **Model**: Claude 3 Haiku (fast) or Claude 3 Sonnet (balanced)
- **Cost**: ~$0.008-0.024 per 1K tokens
- **Setup**: Get API key from https://console.anthropic.com/

## Step 2: Set Up API Key

### For Cloudflare Workers:

```bash
# Navigate to worker directory
cd worker

# Set OpenAI API key
wrangler secret put OPENAI_API_KEY
# Paste your API key when prompted

# Or for Anthropic
wrangler secret put ANTHROPIC_API_KEY
```

## Step 3: Integrate Chat UI

### Option A: Add to Main Dashboard

Edit `react-app/index-react.html`:

```javascript
// Add state for chat
const [chatOpen, setChatOpen] = useState(false);

// Add button to open chat (in header or sidebar)
<button onClick={() => setChatOpen(true)}>
  💬 AI Assistant
</button>

// Add ChatInterface component
{chatOpen && (
  <ChatInterface
    isOpen={chatOpen}
    onClose={() => setChatOpen(false)}
    tickerData={data}
    activityData={activityData}
  />
)}
```

### Option B: Floating Widget

Add a floating button that opens the chat in a modal or sidebar.

## Step 4: Enable AI Endpoint

Edit `worker/index.js` and uncomment the AI integration code in the `/timed/ai/chat` endpoint.

### Example with OpenAI:

```javascript
const openaiApiKey = env.OPENAI_API_KEY;
if (!openaiApiKey) {
  return sendJSON(
    { ok: false, error: "AI service not configured" },
    503,
    corsHeaders(env, req)
  );
}

// Fetch ticker data for context
const tickerData = body.tickerData || [];
const activityData = body.activityData || [];

// Build system prompt
const systemPrompt = `You are an expert trading analyst assistant for the Timed Trading platform.
You help users understand their trading setups, analyze market conditions, and provide actionable insights.

Available data:
- ${tickerData.length} tickers with real-time scores, ranks, RR, phase, and completion
- ${activityData.length} recent activity events

When answering:
1. Be concise but thorough
2. Reference specific data points when available
3. Provide actionable insights
4. Highlight risks when relevant
5. Use markdown for formatting`;

const response = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${openaiApiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-3.5-turbo",
    messages: [
      { role: "system", content: systemPrompt },
      ...(body.conversationHistory || []).slice(-10).map(msg => ({
        role: msg.role,
        content: msg.content
      })),
      { role: "user", content: body.message }
    ],
    temperature: 0.7,
    max_tokens: 500,
  }),
});

const aiData = await response.json();
const aiResponse = aiData.choices[0]?.message?.content || "Sorry, I couldn't process that.";
```

## Step 5: Add External Data Sources (Optional)

### NewsAPI Integration

1. Sign up at https://newsapi.org/ (free tier: 100 requests/day)
2. Get API key
3. Add to worker secrets: `wrangler secret put NEWSAPI_KEY`
4. Add news fetching function in worker

### Reddit Integration

Reddit API is free and doesn't require auth for public data:

```javascript
// Example: Search Reddit for ticker mentions
async function searchReddit(ticker) {
  const response = await fetch(
    `https://www.reddit.com/r/wallstreetbets/search.json?q=${ticker}&limit=5&sort=hot`
  );
  const data = await response.json();
  return data.data?.children || [];
}
```

## Step 6: Deploy

```bash
# Deploy worker
cd worker
wrangler deploy

# Deploy UI (if using Cloudflare Pages)
# Changes will auto-deploy if connected to GitHub
```

## Testing

1. Open the dashboard
2. Click "AI Assistant" button
3. Try queries like:
   - "What's the status of AAPL?"
   - "Show me all prime setups"
   - "What are the best setups right now?"

## Cost Monitoring

Monitor your AI API usage:
- OpenAI: https://platform.openai.com/usage
- Anthropic: https://console.anthropic.com/settings/usage

Set up usage alerts to avoid unexpected costs.

## Troubleshooting

### "AI service not configured"
- Make sure you've set the API key: `wrangler secret put OPENAI_API_KEY`
- Redeploy the worker after setting secrets

### Rate limiting errors
- Implement caching for common queries
- Add rate limiting on the chat endpoint
- Use cheaper models (GPT-3.5-turbo) for high volume

### Slow responses
- Reduce `max_tokens` in API call
- Use faster models (GPT-3.5-turbo vs GPT-4)
- Cache responses for similar queries

## Next Steps

1. ✅ Set up AI API key
2. ✅ Integrate chat UI
3. ✅ Test basic queries
4. ⏳ Add external news integration
5. ⏳ Add social media sentiment
6. ⏳ Implement real-time monitoring
7. ⏳ Add proactive alerts

## Support

For questions or issues:
- Check the architecture docs: `docs/AI_AGENT_ARCHITECTURE.md`
- Review implementation plan: `docs/AI_AGENT_IMPLEMENTATION_PLAN.md`
- Check worker logs: `wrangler tail`

