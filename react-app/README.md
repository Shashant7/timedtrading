# React Dashboard - Timed Trading

This is the new React-based dashboard for Timed Trading, featuring modern architecture, better performance, and enhanced UX.

## Quick Start

### Option 1: Standalone (No Build Required)

Simply open `index-react.html` in a browser. It uses React via CDN and works immediately.

### Option 2: Full Vite Setup (Recommended for Development)

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build
```

## Features

### ✅ Implemented
- React 18 with hooks
- Lightweight Recharts (replaces heavy Plotly)
- Real-time data fetching with auto-refresh
- Prime setup detection and highlighting
- Quick filter presets
- Responsive design
- Interactive bubble chart
- Ticker details panel
- Search functionality

### 🚧 Coming Soon
- Full filter panel (quadrants, RR, completion, etc.)
- Virtual scrolling for large lists
- Multiple view modes (table, cards, timeline)
- Quick actions (copy setup, set alerts)
- URL state sync (shareable links)
- WebSocket real-time updates
- Mobile optimizations

## Architecture

- **Components**: Modular, reusable React components
- **Hooks**: Custom hooks for data fetching, debouncing
- **Utils**: Pure functions for calculations and filtering
- **No Build**: Works standalone with CDN React

## Comparison with Original

| Feature | Original (index.html) | React (index-react.html) |
|---------|----------------------|--------------------------|
| Framework | Vanilla JS | React 18 |
| Charting | Plotly (~2MB) | Recharts (~50KB) |
| State Management | Manual | React hooks |
| Bundle Size | ~2MB | ~200KB |
| Maintainability | Monolithic | Component-based |
| Performance | Good | Better (optimized) |
| Mobile | Basic | Responsive |

## Next Steps

1. Add full filter panel
2. Implement virtual scrolling
3. Add quick actions
4. Set up Vite build system
5. Add TypeScript
6. Implement state management (Zustand)
7. Add React Query for better caching

