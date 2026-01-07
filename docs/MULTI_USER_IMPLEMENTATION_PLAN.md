# Multi-User Implementation Plan

## Quick Answer: TradingView Watchlist API

**No, TradingView does NOT provide a public REST API for programmatically managing watchlists.**

However, we can work around this with:
1. **Browser Extension** (best UX) - Syncs symbols between our system and TradingView
2. **CSV/JSON Export** (simplest) - Users manually import watchlists into TradingView
3. **TradingView Watchlist Importer Extension** - Users can use existing extensions with our exported data

## Recommended Approach: Hybrid Solution

### Phase 1: Manual Import (Week 1-2)
- Users create watchlists in our UI
- Export CSV/JSON format
- Users manually import into TradingView
- **Pros**: Fast to implement, no browser extension needed
- **Cons**: Not automated, requires manual step

### Phase 2: Browser Extension (Week 3-4)
- Chrome extension that syncs watchlists
- Uses TradingView's internal APIs or UI automation
- **Pros**: Seamless UX, automated sync
- **Cons**: Requires extension installation, more complex

## Implementation Steps

### Step 1: Add Google SSO Authentication

#### Option A: Cloudflare Access (Easiest)
```bash
# Install Cloudflare Access
# Configure in Cloudflare Dashboard
# Add Google as identity provider
```

#### Option B: Firebase Auth (Recommended for flexibility)
```javascript
// In worker/index.js
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// Verify JWT token from Firebase
async function verifyToken(token) {
  const auth = getAuth();
  return await auth.verifyIdToken(token);
}
```

### Step 2: User Data Model

Add to `worker/index.js`:
```javascript
// User storage in KV
async function getUser(KV, userId) {
  return await kvGetJSON(KV, `user:${userId}`);
}

async function saveUser(KV, userId, userData) {
  await kvPutJSON(KV, `user:${userId}`, userData);
}

// Groups storage
async function getUserGroups(KV, userId) {
  const groups = await kvGetJSON(KV, `user:${userId}:groups`) || [];
  return groups;
}

async function saveGroup(KV, userId, groupId, groupData) {
  await kvPutJSON(KV, `group:${groupId}`, {
    ...groupData,
    userId,
    createdAt: Date.now()
  });
  // Update user's group list
  const groups = await getUserGroups(KV, userId);
  if (!groups.includes(groupId)) {
    groups.push(groupId);
    await kvPutJSON(KV, `user:${userId}:groups`, groups);
  }
}
```

### Step 3: Protected API Routes

```javascript
// Middleware to verify user authentication
async function requireAuth(req, env) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, error: 'unauthorized', user: null };
  }
  
  const token = authHeader.substring(7);
  try {
    const user = await verifyToken(token); // Firebase or Cloudflare Access
    return { ok: true, user };
  } catch (e) {
    return { ok: false, error: 'invalid_token', user: null };
  }
}

// Example protected route
if (url.pathname === "/users/me/groups" && req.method === "GET") {
  const auth = await requireAuth(req, env);
  if (!auth.ok) {
    return sendJSON({ ok: false, error: auth.error }, 401, corsHeaders(env));
  }
  
  const groups = await getUserGroups(KV, auth.user.uid);
  return sendJSON({ ok: true, groups }, 200, corsHeaders(env));
}
```

### Step 4: Watchlist Export Endpoint

```javascript
// GET /users/me/watchlists/:watchlistId/export?format=csv|json
if (url.pathname.startsWith("/users/me/watchlists/") && url.pathname.endsWith("/export")) {
  const auth = await requireAuth(req, env);
  if (!auth.ok) {
    return sendJSON({ ok: false, error: auth.error }, 401, corsHeaders(env));
  }
  
  const watchlistId = url.pathname.split("/")[3];
  const watchlist = await kvGetJSON(KV, `watchlist:${watchlistId}`);
  
  if (!watchlist || watchlist.userId !== auth.user.uid) {
    return sendJSON({ ok: false, error: "not_found" }, 404, corsHeaders(env));
  }
  
  const format = url.searchParams.get("format") || "csv";
  const symbols = watchlist.symbols || [];
  
  if (format === "csv") {
    const csv = "Symbol,Name\n" + symbols.map(s => `${s},${s}`).join("\n");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="watchlist_${watchlistId}.csv"`
      }
    });
  } else {
    return sendJSON({
      watchlist: watchlist.name,
      symbols: symbols
    }, 200, corsHeaders(env));
  }
}
```

### Step 5: UI Authentication Flow

Add to `react-app/index-react.html`:
```javascript
// Firebase Auth setup
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  projectId: "YOUR_PROJECT_ID"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth();
const provider = new GoogleAuthProvider();

// Sign in function
async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, provider);
    const token = await result.user.getIdToken();
    localStorage.setItem('authToken', token);
    return token;
  } catch (error) {
    console.error('Sign in error:', error);
  }
}

// Use token in API calls
async function fetchUserData() {
  const token = localStorage.getItem('authToken');
  const response = await fetch(`${API_BASE}/users/me/groups`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  return await response.json();
}
```

## Browser Extension (Phase 2)

### Extension Structure
```
browser-extension/
├── manifest.json
├── background.js
├── popup.html
├── popup.js
├── content.js
└── options.html
```

### manifest.json
```json
{
  "manifest_version": 3,
  "name": "Timed Trading Watchlist Sync",
  "version": "1.0.0",
  "permissions": [
    "storage",
    "activeTab",
    "identity"
  ],
  "host_permissions": [
    "https://www.tradingview.com/*",
    "https://YOUR_WORKER_URL/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html"
  },
  "content_scripts": [{
    "matches": ["https://www.tradingview.com/*"],
    "js": ["content.js"]
  }]
}
```

### Extension Features
1. **Sync watchlists from Worker to TradingView**
2. **Add/remove symbols via extension UI**
3. **Bidirectional sync** (changes in TradingView → Worker)
4. **Auto-sync on login**

## Migration Strategy

### For Existing Users
1. Create a "default" user account
2. Migrate existing groups to default user
3. Allow users to claim/transfer data to their account

### Data Migration
```javascript
// One-time migration script
async function migrateToMultiUser(KV) {
  // Get all existing groups
  const existingGroups = GROUPS; // From current code
  
  // Create default user
  const defaultUserId = "default_user";
  await saveUser(KV, defaultUserId, {
    email: "default@timedtrading.com",
    name: "Default User",
    createdAt: Date.now()
  });
  
  // Migrate groups
  for (const [groupName, symbols] of Object.entries(existingGroups)) {
    const groupId = `group_${groupName.toLowerCase()}`;
    await saveGroup(KV, defaultUserId, groupId, {
      name: groupName,
      symbols: Array.from(symbols)
    });
  }
}
```

## Testing Checklist

- [ ] Google SSO login works
- [ ] User can create groups
- [ ] User can add/remove symbols from groups
- [ ] User can create watchlists
- [ ] CSV export works
- [ ] JSON export works
- [ ] User can import CSV into TradingView
- [ ] Data is isolated per user
- [ ] API authentication works
- [ ] Session expiration works

## Deployment Order

1. **Deploy Worker updates** (add auth, user endpoints)
2. **Deploy UI updates** (add login, user management)
3. **Test authentication flow**
4. **Deploy browser extension** (optional, Phase 2)
5. **Migrate existing data** (if needed)

## Cost Estimate

### Cloudflare (per month)
- Workers: $5 (10M requests)
- KV: ~$1-2 (user data storage)
- Access: Free (up to 50 users)

### Firebase (per month)
- Auth: Free (up to 50K MAU)
- Hosting: Free tier available

**Total**: ~$6-7/month for small scale (< 50 users)

## Next Steps

1. **Choose authentication provider** (Firebase Auth recommended)
2. **Implement Step 1-3** (auth + user model + protected routes)
3. **Implement Step 4** (watchlist export)
4. **Update UI** (Step 5)
5. **Test end-to-end**
6. **Deploy browser extension** (Phase 2)

