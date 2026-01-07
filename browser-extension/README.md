# Timed Trading Browser Extension

Browser extension to sync watchlists between Timed Trading and TradingView.

## Status

🚧 **In Development** - This is a placeholder for Phase 2 implementation.

## Planned Features

1. **Watchlist Sync**
   - Sync watchlists from Timed Trading to TradingView
   - Add/remove symbols via extension UI
   - Real-time updates

2. **Authentication**
   - Google SSO integration
   - Secure token storage

3. **TradingView Integration**
   - Detect TradingView watchlist page
   - Add symbols programmatically (if possible)
   - Export symbols from TradingView

## Installation

1. Clone this repository
2. Open Chrome/Edge → Extensions → Developer mode
3. Click "Load unpacked"
4. Select the `browser-extension` folder

## Development

```bash
cd browser-extension
# Edit files
# Reload extension in Chrome
```

## Architecture

- **manifest.json**: Extension configuration
- **background.js**: Service worker for API calls
- **popup.html/js**: Extension popup UI
- **content.js**: TradingView page interaction
- **options.html**: Extension settings

## TradingView API Limitations

TradingView does not provide a public API for watchlist management. This extension will:

1. **Option A**: Use TradingView's internal APIs (if accessible)
2. **Option B**: UI automation to add symbols
3. **Option C**: Export CSV/JSON for manual import

## Future Enhancements

- Bidirectional sync (TradingView → Timed Trading)
- Multiple watchlist support
- Auto-sync on symbol changes
- Conflict resolution

