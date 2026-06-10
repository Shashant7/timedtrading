# Vendored third-party libraries

Self-hosted copies of the runtime libraries previously loaded from
unpkg/jsdelivr. Same-origin serving removes 2 TLS handshakes from first
paint, lets the assets ride the immutable `?v=` cache (`_worker.js`),
and removes third-party outage risk.

`scripts/build-frontend.js` (`replaceCdnWithVendor`) rewrites the CDN
URLs in every page to these paths at build time — source HTML keeps the
CDN URLs so pages still work when opened straight from `react-app/`.

| File | Package | Version |
|---|---|---|
| `react.production.min.js` | react (UMD) | 18.3.1 |
| `react-dom.production.min.js` | react-dom (UMD) | 18.3.1 |
| `lightweight-charts.standalone.production.js` | lightweight-charts | 4.1.1 |
| `marked.min.js` | marked | 12.0.2 |
| `purify.min.js` | dompurify | 3.2.4 |
| `prop-types.min.js` | prop-types (UMD) | 15.8.1 |
| `htm.umd.js` | htm (UMD) | 3.1.1 |

To upgrade: download the new UMD/standalone build from unpkg, replace
the file, update this table, and update the version-matching regexes in
`CDN_VENDOR_MAP` (scripts/build-frontend.js) if the major version
changed.
