/* tt-topnav-scaffold.js
 *
 * Injects the canonical journey topnav (Today / Active Trader / Investor /
 * Portfolio / Insights / FAQ / Learn) on admin pages that previously
 * rendered a legacy React nav (Analysis / Trades / System Intelligence).
 *
 * tt-nav-extras.js then adds badges, Admin dropdown, Discord, alerts bell,
 * and avatar into nav.topnav .nav-row.
 *
 * Load synchronously at the top of <body>, before #root.
 */
(function () {
  if (typeof document === "undefined") return;
  if (document.querySelector("nav.topnav")) return;

  if (!document.getElementById("tt-topnav-scaffold-styles")) {
    const style = document.createElement("style");
    style.id = "tt-topnav-scaffold-styles";
    style.textContent = `
      nav.topnav {
        position: sticky; top: 0; z-index: 50;
        background: rgba(10,12,16,0.85);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .nav-row {
        max-width: 1600px; margin: 0 auto;
        padding: 12px 24px;
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
      }
      .nav-brand {
        display: inline-flex; align-items: center; gap: 10px;
        text-decoration: none; color: #e5e7eb; font-weight: 700;
      }
      .nav-links { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .nav-link {
        font-size: 12.5px; color: #94a3b8; text-decoration: none;
        padding: 6px 11px; border-radius: 7px; font-weight: 500;
        transition: all 0.15s;
      }
      .nav-link:hover { background: rgba(255,255,255,0.04); color: #f1f5f9; }
      .nav-link.active { color: #e5e7eb; background: rgba(255,255,255,0.04); }
      .nav-link.learn { color: #34d399; }
      .nav-link.learn:hover { background: rgba(34,197,94,0.10); }
      .nav-link.faq { color: #22d3ee; }
      .nav-link.faq:hover { background: rgba(34,211,238,0.08); }
    `;
    document.head.appendChild(style);
  }

  const logo = '<svg width="28" height="28" viewBox="0 0 48 48" fill="none"><defs><linearGradient id="ttng" x1="6" y1="42" x2="42" y2="6"><stop offset="0%" stop-color="#34d399"/><stop offset="100%" stop-color="#67e8f9"/></linearGradient></defs><rect width="48" height="48" rx="11" fill="#000"/><circle cx="24" cy="24" r="17" stroke="url(#ttng)" stroke-width="2.5" fill="none"/><line x1="19" y1="18.5" x2="16" y2="15.5" stroke="#636366" stroke-width="1.2" stroke-linecap="round"/><line x1="24" y1="24" x2="19" y2="18.5" stroke="#636366" stroke-width="3.5" stroke-linecap="round"/><line x1="29.5" y1="16.5" x2="32" y2="12.9" stroke="#30d158" stroke-width="1.2" stroke-linecap="round"/><line x1="24" y1="24" x2="29.5" y2="16.5" stroke="#30d158" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="24" r="3.2" fill="#30d158"/><circle cx="24" cy="24" r="1.3" fill="#000"/></svg>';

  const nav = document.createElement("nav");
  nav.className = "topnav";
  nav.innerHTML =
    '<div class="nav-row">'
    + '<a href="/today.html" class="nav-brand">' + logo + 'Timed Trading</a>'
    + '<div class="nav-links">'
    + '<a href="/today.html" class="nav-link">Today</a>'
    + '<a href="/active-trader.html" class="nav-link">Active Trader</a>'
    + '<a href="/investor.html" class="nav-link">Investor</a>'
    + '<a href="/portfolio.html" class="nav-link">Portfolio</a>'
    + '<a href="/insights.html" class="nav-link">Insights</a>'
    + '<a href="/faq.html" class="nav-link faq">FAQ</a>'
    + '<a href="/learn.html" class="nav-link learn">Learn</a>'
    + '</div>'
    + '</div>';

  const strip = document.createElement("div");
  strip.setAttribute("data-tt-activity-strip", "");

  const root = document.getElementById("root");
  if (root && root.parentNode) {
    root.parentNode.insertBefore(strip, root);
    root.parentNode.insertBefore(nav, strip);
  } else {
    document.body.prepend(strip);
    document.body.prepend(nav);
  }
})();

// cache-bust:1782792637332:733221451
