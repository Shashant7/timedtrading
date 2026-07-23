# Dual horizon cards + Short/Long Term terminology

## Product
- When Short Term and Long Term both have a live signal on the same ticker,
  show **two cards** (Model board + Today Viewport). Open Positions already
  dual-books.
- Broker mirror supports both via separate `trade_id` + `mode` + `horizon`.
- User-facing surfaces use Short Term / Long Term (internal keys unchanged).

## Done
- `modelLanes` dual emit; ATCard / ViewportCard horizon chips + keys
- Investor bridge: stable `tt-lt-*` client_order_id + `horizon: long_term`
- Discord / email / notif / Brief / Portfolio / activity strip / lane bar labels
- Helpers: `worker/horizon-labels.js`, `react-app/shared-horizon-labels.js`
