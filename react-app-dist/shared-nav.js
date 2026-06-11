// shared-nav.js — D1 (2026-06-11): the ONE source of truth for the journey
// header. CONTEXT.md carried this as known debt: "Nav is currently duplicated
// per page... A future shared component (e.g. shared-nav.js mounting into
// #global-nav-root) would allow one place to edit; not yet implemented."
//
// Now implemented. Pages render `<div id="global-nav-root"></div>` where the
// copy-pasted `<nav class="topnav">` block used to live, and load this script
// (deferred by the build like every external script — it runs in document
// order BEFORE tt-nav-extras.js / tt-activity-strip.js, so their .nav-links
// hooks find the same markup they always did).
//
// Markup is byte-compatible with the previous static blocks:
//   - `.nav-link.active` marks the current page
//   - the Today link keeps its mint accent class ONLY on /today.html
//     (matching the prior per-page convention)
//   - FAQ + Learn keep their permanent accent classes
// Page-level `.topnav` CSS is untouched — this centralizes the MARKUP, so
// adding/removing/renaming a journey link is a one-file edit.
//
// No React, no fetch, no dependencies. Plain DOM injection.
(function () {
  "use strict";

  var BRAND_SVG =
    '<svg width="28" height="28" viewBox="0 0 48 48" fill="none"><defs><linearGradient id="ttng" x1="6" y1="42" x2="42" y2="6"><stop offset="0%" stop-color="#34d399"/><stop offset="100%" stop-color="#67e8f9"/></linearGradient></defs><rect width="48" height="48" rx="11" fill="#000"/><circle cx="24" cy="24" r="17" stroke="url(#ttng)" stroke-width="2.5" fill="none"/><line x1="19" y1="18.5" x2="16" y2="15.5" stroke="#636366" stroke-width="1.2" stroke-linecap="round"/><line x1="24" y1="24" x2="19" y2="18.5" stroke="#636366" stroke-width="3.5" stroke-linecap="round"/><line x1="29.5" y1="16.5" x2="32" y2="12.9" stroke="#30d158" stroke-width="1.2" stroke-linecap="round"/><line x1="24" y1="24" x2="29.5" y2="16.5" stroke="#30d158" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="24" r="3.2" fill="#30d158"/><circle cx="24" cy="24" r="1.3" fill="#000"/></svg>';

  var LINKS = [
    { href: "/today.html", label: "Today", accent: "today", accentOnSelfOnly: true },
    { href: "/active-trader.html", label: "Active Trader" },
    { href: "/investor.html", label: "Investor" },
    { href: "/portfolio.html", label: "Portfolio" },
    { href: "/insights.html", label: "Insights" },
    { href: "/faq.html", label: "FAQ", accent: "faq" },
    { href: "/learn.html", label: "Learn", accent: "learn" },
  ];

  function currentPath() {
    var p = String(window.location.pathname || "").toLowerCase();
    if (p === "/" || p === "") return "/today.html";
    return p;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function buildNavHtml() {
    var path = currentPath();
    var links = LINKS.map(function (l) {
      var isCurrent = path === l.href;
      var classes = ["nav-link"];
      if (l.accent && (!l.accentOnSelfOnly || isCurrent)) classes.push(l.accent);
      // The Today page's accent class IS its active treatment; everywhere
      // else the current page gets the standard .active.
      if (isCurrent && !(l.accent && l.accentOnSelfOnly)) classes.push("active");
      return (
        '<a href="' + l.href + '" class="' + classes.join(" ") + '">' +
        escapeHtml(l.label) + "</a>"
      );
    }).join("\n          ");

    return (
      '<nav class="topnav">\n' +
      '      <div class="nav-row">\n' +
      '        <a href="/today.html" class="nav-brand">\n' +
      "          " + BRAND_SVG + "\n" +
      "          Timed Trading\n" +
      "        </a>\n" +
      '        <div class="nav-links">\n' +
      "          " + links + "\n" +
      "        </div>\n" +
      "      </div>\n" +
      "    </nav>"
    );
  }

  function mount() {
    var root = document.getElementById("global-nav-root");
    if (!root) return;
    root.outerHTML = buildNavHtml();
  }

  // Deferred scripts run after parse, in document order — before
  // tt-nav-extras.js and before any DOMContentLoaded handlers.
  mount();
})();

// cache-bust:1781184675694:484797311
