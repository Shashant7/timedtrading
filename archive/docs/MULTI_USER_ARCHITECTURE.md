# Multi-User Architecture Proposal

## Overview

This document outlines the architecture for expanding Timed Trading to support multiple users with Google SSO authentication, user-specific groups, and watchlist management.

## Key Challenges

### 1. TradingView Watchlist API Limitation
**Problem**: TradingView does NOT provide a public REST API for programmatically adding/removing symbols from watchlists.

**Solutions**:
- **Option A (Recommended)**: Browser extension that users install to sync symbols
- **Option B**: Manual watchlist import via CSV/JSON export
- **Option C**: TradingView Webhooks (if available in future)
- **Option D**: Selenium/Puppeteer automation (not recommended, violates ToS)

### 2. Data Isolation
- User-specific groups vs. shared groups
- User-specific watchlists vs. shared watchlists
- User-specific alerts vs. shared alerts

## Proposed Architecture

### 1. Authentication Layer

#### Google SSO Integration
- Use **Cloudflare Access** (built-in) or **Auth0** / **Firebase Auth**
- Store user sessions in KV or D1 (Cloudflare SQL database)
- JWT tokens for API authentication

#### User Model
```javascript
{
  userId: "google_123456789",
  email: "user@example.com",
  name: "John Doe",
  createdAt: 1704067200000,
  subscription: "free" | "pro" | "enterprise",
  watchlistIds: ["watchlist_1", "watchlist_2"],
  groupIds: ["group_1", "group_2"]
}
```

### 2. Worker API Enhancements

#### New Endpoints

**User Management**:
- `POST /auth/login` - Google SSO callback
- `GET /auth/me` - Get current user
- `POST /auth/logout` - Logout

**Groups Management**:
- `GET /users/:userId/groups` - Get user's groups
- `POST /users/:userId/groups` - Create group
- `PUT /users/:userId/groups/:groupId` - Update group
- `DELETE /users/:userId/groups/:groupId` - Delete group
- `POST /users/:userId/groups/:groupId/symbols` - Add symbols to group
- `DELETE /users/:userId/groups/:groupId/symbols/:symbol` - Remove symbol

**Watchlists**:
- `GET /users/:userId/watchlists` - Get user's watchlists
- `POST /users/:userId/watchlists` - Create watchlist
- `GET /users/:userId/watchlists/:watchlistId/symbols` - Get symbols
- `POST /users/:userId/watchlists/:watchlistId/symbols` - Add symbols (returns CSV/JSON for import)
- `DELETE /users/:userId/watchlists/:watchlistId/symbols/:symbol` - Remove symbol

**Data Access**:
- `GET /users/:userId/tickers` - Get tickers for user's watchlists/groups
- `GET /users/:userId/tickers/:ticker` - Get specific ticker data
- `GET /users/:userId/top?bucket=long&n=10` - Get top tickers for user

### 3. Data Storage Structure

#### KV Namespace Structure
```
user:{userId}                    → User profile
user:{userId}:groups             → List of group IDs
user:{userId}:watchlists         → List of watchlist IDs
group:{groupId}                  → Group definition (name, symbols, userId)
watchlist:{watchlistId}          → Watchlist definition (name, symbols, userId)
timed:latest:{ticker}            → Latest ticker data (shared)
timed:trail:{ticker}             → Trail data (shared)
timed:tickers                    → All tracked tickers (shared)
```

#### D1 Database (Alternative/Additional)
For better querying and relationships:
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  created_at INTEGER,
  subscription TEXT
);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT,
  symbols TEXT, -- JSON array
  created_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE watchlists (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT,
  symbols TEXT, -- JSON array
  created_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 4. Watchlist Management Workaround

#### Browser Extension Approach (Recommended)

**Extension Features**:
1. User authenticates with Google SSO
2. Extension syncs with Worker API to get user's watchlists
3. Extension provides UI to:
   - View watchlists
   - Add/remove symbols
   - Sync to TradingView (via TradingView's UI automation)
4. Extension can also export CSV/JSON for manual import

**Implementation**:
- Chrome Extension using Manifest V3
- Uses TradingView's internal APIs (if accessible) or UI automation
- Stores auth token securely
- Syncs changes back to Worker

#### CSV/JSON Export Approach

**Workflow**:
1. User creates watchlist in UI
2. User adds symbols via UI
3. User clicks "Export for TradingView"
4. System generates CSV/JSON file
5. User manually imports into TradingView

**CSV Format**:
```csv
Symbol,Name
AAPL,Apple Inc.
TSLA,Tesla Inc.
```

**JSON Format** (for TradingView Watchlist Importer extension):
```json
{
  "watchlist": "My Watchlist",
  "symbols": ["AAPL", "TSLA", "MSFT"]
}
```

### 5. UI Enhancements

#### Authentication Flow
1. Landing page with "Sign in with Google"
2. Redirect to Google OAuth
3. Callback to Worker
4. Store session token
5. Redirect to dashboard

#### User Dashboard
- **My Watchlists**: Manage watchlists
- **My Groups**: Manage groups
- **My Tickers**: View tickers from user's watchlists/groups
- **Settings**: Profile, subscription, API keys

#### Group Management UI
- Create/edit/delete groups
- Add/remove symbols
- Share groups (optional, future feature)

#### Watchlist Management UI
- Create/edit/delete watchlists
- Add/remove symbols
- Export for TradingView (CSV/JSON)
- Browser extension sync status

### 6. TradingView Integration

#### Alert Configuration
- Each user can configure their own TradingView alerts
- Alert webhook includes `userId` parameter
- Worker routes alerts to user's data

#### Alternative: Shared Alerts with User Filtering
- Single TradingView watchlist with all symbols
- Worker filters data based on user's watchlists/groups
- More efficient but less flexible

### 7. Implementation Phases

#### Phase 1: Authentication & Basic User Management
- [ ] Google SSO integration
- [ ] User profile storage
- [ ] Session management
- [ ] Protected API routes

#### Phase 2: Groups Management
- [ ] Groups CRUD API
- [ ] Groups UI
- [ ] Symbol management in groups

#### Phase 3: Watchlists Management
- [ ] Watchlists CRUD API
- [ ] Watchlists UI
- [ ] CSV/JSON export
- [ ] Browser extension (MVP)

#### Phase 4: Data Isolation
- [ ] User-specific data filtering
- [ ] User-specific top lists
- [ ] User-specific alerts

#### Phase 5: Browser Extension (Full)
- [ ] TradingView sync
- [ ] Real-time updates
- [ ] Bidirectional sync

## Technical Stack

### Authentication
- **Option 1**: Cloudflare Access (easiest, built-in)
- **Option 2**: Auth0 (more features, external)
- **Option 3**: Firebase Auth (Google-native, easy integration)

### Database
- **KV**: User profiles, groups, watchlists (simple key-value)
- **D1**: If we need complex queries (optional)
- **R2**: For file storage (CSV/JSON exports)

### Browser Extension
- **Manifest V3** (Chrome/Edge)
- **WebExtensions API** (Firefox)
- **React** or **Vanilla JS**

## Security Considerations

1. **API Authentication**: JWT tokens with expiration
2. **Data Isolation**: Ensure users can only access their own data
3. **Rate Limiting**: Per-user rate limits
4. **Input Validation**: Sanitize all user inputs
5. **CORS**: Restrict to authorized origins
6. **Secrets Management**: Use Cloudflare Secrets

## Cost Considerations

### Cloudflare
- **Workers**: $5/month for 10M requests (free tier: 100K/day)
- **KV**: $0.50 per million reads, $5 per million writes
- **D1**: $0.001 per million rows read (free tier: 5M rows/month)
- **Access**: Free for up to 50 users, then $3/user/month

### Third-Party
- **Auth0**: Free for up to 7,000 MAU
- **Firebase Auth**: Free tier available

## Next Steps

1. **Decide on authentication provider** (Cloudflare Access recommended)
2. **Design user data model** (KV vs D1)
3. **Implement Phase 1** (authentication)
4. **Build groups management** (Phase 2)
5. **Create watchlist export** (Phase 3)
6. **Develop browser extension** (Phase 4)

## Questions to Answer

1. **Shared vs. Private Groups**: Should groups be shareable between users?
2. **Subscription Tiers**: What features should be free vs. paid?
3. **Watchlist Limits**: How many watchlists/groups per user?
4. **Symbol Limits**: How many symbols per watchlist/group?
5. **Data Retention**: How long to keep user data after inactivity?

