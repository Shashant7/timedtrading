# Phase 2: News & Sentiment Integration Plan

## Overview
Phase 2 focuses on integrating external data sources to enhance trading signals with news sentiment, social media sentiment, and fundamental context. This will complement the technical analysis already in place.

## Goals
1. **News Integration**: Add financial news from NewsAPI to track market-moving events
2. **Sentiment Analysis**: Integrate Reddit API for retail sentiment tracking
3. **Optional**: Twitter/X API for broader social sentiment (requires API access)

---

## 1. NewsAPI Integration

### Purpose
Track financial news articles related to tracked tickers to identify:
- Earnings announcements
- Major corporate events
- Sector-wide news
- Market-moving headlines

### Implementation Steps

#### 1.1 API Setup
- **Service**: NewsAPI (https://newsapi.org/)
- **Free Tier**: 100 requests/day, 1,000 requests/month
- **Paid Tier**: Higher limits available
- **API Key**: Store as `NEWSAPI_KEY` in Cloudflare Worker secrets

#### 1.2 Data Collection
- **Endpoint**: `GET https://newsapi.org/v2/everything`
- **Parameters**:
  - `q`: Ticker symbol or company name
  - `language`: `en`
  - `sortBy`: `publishedAt` (most recent first)
  - `pageSize`: `10` (top 10 articles per ticker)
  - `from`: Last 24 hours (or configurable window)

#### 1.3 Storage Strategy
- **KV Key Pattern**: `timed:news:{ticker}:{timestamp}`
- **Data Structure**:
  ```json
  {
    "title": "Article title",
    "description": "Article description",
    "url": "https://...",
    "publishedAt": "2024-01-15T10:00:00Z",
    "source": "Bloomberg",
    "sentiment": "positive|negative|neutral" // Optional: add sentiment analysis
  }
  ```
- **TTL**: 7 days (news becomes stale quickly)

#### 1.4 Worker Integration
- **New Endpoint**: `GET /timed/news?ticker=XYZ&limit=10`
- **Scheduled Task**: Daily fetch for all tracked tickers (via Cloudflare Cron Triggers)
- **Rate Limiting**: Batch requests to stay within API limits

#### 1.5 Alert Integration
- Add news context to Discord alerts:
  - "Recent news: [Title] - [Source]"
  - Flag high-impact news (earnings, major events)

---

## 2. Reddit API Integration

### Purpose
Track retail sentiment from Reddit discussions:
- r/wallstreetbets activity
- r/stocks discussions
- r/investing insights
- Ticker-specific mentions and sentiment

### Implementation Steps

#### 2.1 API Setup
- **Service**: Reddit API (https://www.reddit.com/dev/api/)
- **Authentication**: OAuth2 (client credentials flow)
- **Rate Limits**: 60 requests/minute (free tier)
- **Credentials**: Store `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` in Worker secrets

#### 2.2 Data Collection
- **Endpoints**:
  - `GET /r/wallstreetbets/search.json?q={ticker}&sort=new`
  - `GET /r/stocks/search.json?q={ticker}&sort=new`
  - `GET /r/investing/search.json?q={ticker}&sort=new`
- **Metrics to Track**:
  - Post count (mentions per day)
  - Upvote ratio
  - Comment count
  - Sentiment score (positive/negative keywords)

#### 2.3 Storage Strategy
- **KV Key Pattern**: `timed:reddit:{ticker}:{date}` (daily aggregation)
- **Data Structure**:
  ```json
  {
    "date": "2024-01-15",
    "mentions": 42,
    "totalUpvotes": 1250,
    "avgUpvoteRatio": 0.85,
    "sentimentScore": 0.65, // -1 to +1 scale
    "topPosts": [
      {
        "title": "Post title",
        "url": "https://reddit.com/...",
        "upvotes": 500,
        "comments": 120
      }
    ]
  }
  ```
- **TTL**: 30 days (keep historical sentiment trends)

#### 2.4 Worker Integration
- **New Endpoint**: `GET /timed/sentiment/reddit?ticker=XYZ`
- **Scheduled Task**: Hourly fetch for tracked tickers (via Cron Triggers)
- **Rate Limiting**: Respect Reddit's 60 req/min limit

#### 2.5 Sentiment Scoring
- **Simple Keyword-Based Approach** (Phase 2.1):
  - Positive keywords: "bullish", "buy", "moon", "rocket", "gains"
  - Negative keywords: "bearish", "sell", "crash", "dump", "loss"
  - Score = (positive_count - negative_count) / total_mentions

- **Future Enhancement** (Phase 2.2):
  - Use OpenAI API for sentiment analysis
  - More nuanced sentiment detection

---

## 3. Twitter/X API Integration (Optional)

### Purpose
Track broader social sentiment and trending tickers on Twitter/X.

### Implementation Steps

#### 3.1 API Setup
- **Service**: Twitter API v2 (https://developer.twitter.com/)
- **Authentication**: OAuth 2.0 Bearer Token
- **Pricing**: Requires paid tier for production use
- **Credentials**: Store `TWITTER_BEARER_TOKEN` in Worker secrets

#### 3.2 Data Collection
- **Endpoint**: `GET /2/tweets/search/recent`
- **Query**: `{ticker} OR ${ticker} OR #{ticker}`
- **Metrics**:
  - Tweet volume
  - Engagement (likes, retweets)
  - Sentiment (via keyword analysis or AI)

#### 3.3 Storage Strategy
- **KV Key Pattern**: `timed:twitter:{ticker}:{hour}` (hourly aggregation)
- **Data Structure**:
  ```json
  {
    "hour": "2024-01-15T10:00:00Z",
    "tweetCount": 150,
    "totalLikes": 5000,
    "totalRetweets": 800,
    "sentimentScore": 0.45
  }
  ```

#### 3.4 Worker Integration
- **New Endpoint**: `GET /timed/sentiment/twitter?ticker=XYZ`
- **Scheduled Task**: Hourly fetch (if API access available)

---

## 4. Integration with Existing System

### 4.1 Enhanced Scoring
- **Current**: Technical score + Sector boost
- **Phase 2**: Technical score + Sector boost + **Sentiment boost**
  - Positive sentiment: +2 to +5 boost
  - Negative sentiment: -2 to -5 penalty
  - Neutral: No change

### 4.2 Alert Enhancements
- Add sentiment context to Discord alerts:
  ```
  🎯 CAT - Rank 85 | RR 2.5:1
  📰 Recent News: "Caterpillar Reports Strong Q4 Earnings"
  💬 Reddit Sentiment: Bullish (0.75 score, 42 mentions)
  ```

### 4.3 Dashboard Integration
- Add sentiment widgets to React dashboard:
  - News feed per ticker
  - Sentiment trend charts
  - Social media mention counts

---

## 5. Implementation Priority

### Phase 2.1 (MVP - 2-3 weeks)
1. ✅ **NewsAPI Integration**
   - Basic news fetching
   - Storage in KV
   - Display in alerts/API
   
2. ✅ **Reddit API Integration**
   - Basic mention tracking
   - Simple sentiment scoring
   - Storage in KV

### Phase 2.2 (Enhanced - 4-6 weeks)
3. **Advanced Sentiment Analysis**
   - OpenAI-based sentiment analysis
   - Multi-source sentiment aggregation
   - Sentiment trend analysis

4. **Twitter/X Integration** (if API access available)
   - Tweet volume tracking
   - Engagement metrics
   - Sentiment scoring

### Phase 2.3 (Optimization - 2-3 weeks)
5. **Performance Optimization**
   - Caching strategies
   - Batch processing
   - Rate limit optimization

6. **Dashboard UI**
   - News feed component
   - Sentiment charts
   - Social media widgets

---

## 6. API Endpoints (New)

### News Endpoints
- `GET /timed/news?ticker=XYZ&limit=10` - Get recent news for a ticker
- `GET /timed/news/all?limit=50` - Get recent news across all tickers

### Sentiment Endpoints
- `GET /timed/sentiment/reddit?ticker=XYZ` - Get Reddit sentiment
- `GET /timed/sentiment/twitter?ticker=XYZ` - Get Twitter sentiment (if available)
- `GET /timed/sentiment/combined?ticker=XYZ` - Get aggregated sentiment score

### Enhanced Endpoints
- `GET /timed/latest?ticker=XYZ&includeNews=true&includeSentiment=true` - Enhanced latest data

---

## 7. Configuration

### Environment Variables (Worker Secrets)
```bash
# NewsAPI
NEWSAPI_KEY=your_newsapi_key

# Reddit
REDDIT_CLIENT_ID=your_reddit_client_id
REDDIT_CLIENT_SECRET=your_reddit_client_secret

# Twitter (Optional)
TWITTER_BEARER_TOKEN=your_twitter_bearer_token

# OpenAI (for advanced sentiment)
OPENAI_API_KEY=your_openai_key  # Already exists
```

### Cron Triggers (wrangler.toml)
```toml
[[triggers.crons]]
cron = "0 */6 * * *"  # Every 6 hours - Fetch news
schedule = "news-fetch"

[[triggers.crons]]
cron = "0 * * * *"  # Every hour - Fetch Reddit sentiment
schedule = "reddit-sentiment"

[[triggers.crons]]
cron = "0 * * * *"  # Every hour - Fetch Twitter sentiment (if available)
schedule = "twitter-sentiment"
```

---

## 8. Cost Considerations

### NewsAPI
- **Free Tier**: 100 requests/day (sufficient for ~10 tickers)
- **Paid Tier**: $449/month for 250,000 requests/month (for full watchlist)

### Reddit API
- **Free**: No cost, but rate-limited (60 req/min)

### Twitter/X API
- **Basic**: $100/month (1,500 tweets/month)
- **Pro**: $5,000/month (higher limits)

### Recommendation
- **Start with**: NewsAPI free tier + Reddit API (free)
- **Scale up**: Add paid NewsAPI tier as watchlist grows
- **Twitter**: Add only if budget allows and value is proven

---

## 9. Testing Strategy

### Unit Tests
- Mock API responses
- Test sentiment scoring logic
- Test data storage/retrieval

### Integration Tests
- Test API endpoints with real data
- Verify rate limiting
- Test error handling

### Manual Testing
- Verify news appears in alerts
- Check sentiment scores are reasonable
- Monitor API usage/limits

---

## 10. Success Metrics

### Phase 2.1 Success Criteria
- ✅ News API integrated and fetching data
- ✅ Reddit sentiment tracking working
- ✅ Data stored in KV and accessible via API
- ✅ Sentiment data appears in Discord alerts

### Phase 2.2 Success Criteria
- ✅ Sentiment boost integrated into ranking
- ✅ Dashboard shows news/sentiment widgets
- ✅ Multi-source sentiment aggregation working

### Long-term Success
- Improved trade selection accuracy
- Better risk management (avoid negative sentiment setups)
- Enhanced user experience with richer context

---

## Next Steps

1. **Set up API accounts**:
   - Create NewsAPI account
   - Create Reddit API app
   - (Optional) Apply for Twitter API access

2. **Implement Phase 2.1**:
   - Start with NewsAPI integration
   - Add Reddit API integration
   - Test with a few tickers

3. **Iterate and improve**:
   - Gather feedback
   - Refine sentiment scoring
   - Add more data sources as needed
