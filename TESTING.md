# Testing Guide - Timed Trading Dashboards

## Quick Start (No Setup Required)

### Option 1: Version Selector (Recommended)
1. Open `index-selector.html` in your browser
2. Click on either "Classic Version" or "React Dashboard"
3. Both versions will work immediately

### Option 2: Direct Access
- **Original**: Open `index.html` directly
- **React**: Open `react-app/index-react.html` directly

## Testing the React Dashboard

### Standalone Version (Current)
The React dashboard works immediately without any build step:

1. **Open the file**:
   ```bash
   # From project root
   open react-app/index-react.html
   ```
   
   Or navigate to: `file:///Users/shashant/timedtrading/react-app/index-react.html`

2. **What to test**:
   - ✅ Data loads from API
   - ✅ Chart renders with bubbles
   - ✅ Search functionality
   - ✅ Quick filter buttons
   - ✅ Click bubbles to see details
   - ✅ Click list items to select
   - ✅ Prime setups show ⭐ indicator
   - ✅ Auto-refresh every 30 seconds

### Full Vite Setup (Optional - For Development)

If you want to use the full development environment:

1. **Check if Node.js is installed**:
   ```bash
   node --version
   npm --version
   ```

2. **If Node.js is not installed**, install it:
   - Visit: https://nodejs.org/
   - Download and install LTS version
   - Restart terminal

3. **Install dependencies**:
   ```bash
   cd react-app
   npm install
   ```

4. **Start dev server**:
   ```bash
   npm run dev
   ```
   
   This will:
   - Start a local server (usually http://localhost:3000)
   - Open browser automatically
   - Enable hot reload (changes update instantly)

5. **Build for production**:
   ```bash
   npm run build
   ```
   
   Output will be in `react-app/dist/`

## Testing Checklist

### React Dashboard Features

- [ ] **Data Loading**
  - [ ] Shows loading spinner on initial load
  - [ ] Data appears after fetch completes
  - [ ] Error handling works (try with network off)

- [ ] **Chart Interaction**
  - [ ] Bubbles render correctly
  - [ ] Hover shows tooltip
  - [ ] Click bubble selects ticker
  - [ ] Prime setups show ⭐ emoji
  - [ ] Bubble colors reflect phase
  - [ ] Bubble sizes reflect completion

- [ ] **Filters**
  - [ ] Search filters tickers in real-time
  - [ ] "Prime Only" button filters correctly
  - [ ] "In Corridor" button works
  - [ ] "Squeeze Release" button works

- [ ] **List View**
  - [ ] Top setups sorted by rank
  - [ ] Click item selects ticker
  - [ ] Prime items have green border/glow
  - [ ] Badges show Rank and RR

- [ ] **Details Panel**
  - [ ] Shows when ticker selected
  - [ ] Displays all key metrics
  - [ ] Prime setup banner appears
  - [ ] TradingView link works
  - [ ] Close button works

- [ ] **Auto-refresh**
  - [ ] Updates every 30 seconds
  - [ ] Shows last update time
  - [ ] Manual refresh button works

- [ ] **Responsive Design**
  - [ ] Works on desktop
  - [ ] Works on tablet (resize browser)
  - [ ] Works on mobile (resize browser)

## Common Issues & Solutions

### Issue: Chart doesn't render
**Solution**: Check browser console for errors. Make sure:
- Recharts CDN loaded correctly
- React/ReactDOM loaded correctly
- No CORS errors from API

### Issue: Data not loading
**Solution**: 
- Check network tab in browser DevTools
- Verify API endpoint is accessible
- Check for CORS errors

### Issue: Bubbles not clickable
**Solution**: 
- Check if Recharts Scatter component is working
- Verify event handlers are attached
- Check browser console for errors

### Issue: Filters not working
**Solution**:
- Check `applyFilters` function logic
- Verify filter state updates correctly
- Check console for errors

## Browser Compatibility

Tested and works on:
- ✅ Chrome/Edge (latest)
- ✅ Firefox (latest)
- ✅ Safari (latest)

## Performance Testing

1. **Open DevTools** (F12)
2. **Network Tab**: Check load times
3. **Performance Tab**: Record interaction
4. **Console**: Check for errors/warnings

Expected performance:
- Initial load: < 2s
- Filter changes: < 100ms
- Chart updates: < 200ms

## Comparing Both Versions

### Side-by-Side Testing
1. Open `index-selector.html`
2. Open both versions in separate tabs
3. Compare:
   - Load times
   - Responsiveness
   - Visual appearance
   - Feature completeness

### Feature Comparison
- **Original**: Full feature set, mature, stable
- **React**: Modern architecture, faster, lighter, easier to extend

## Next Steps After Testing

1. **Report Issues**: Note any bugs or missing features
2. **Request Features**: Suggest improvements
3. **Choose Version**: Decide which to use as primary
4. **Enhance**: Add more features to React version

