/* tt-activity-strip.js
 *
 * Slim horizontal "recent system activity" strip — shown at the top
 * of /today, /active-trader, /investor (under the nav). Mirrors the
 * V15 ActivityFeedDrawer from /index-react.html but in a single
 * horizontal row that doesn't compete with the kanban / bubble map
 * for vertical space.
 *
 * Data: GET /timed/activity?limit=10 (the public endpoint — admin
 * activity feed has more events but is gated behind a key, so we use
 * the public feed which surfaces ENTER / TRIM / EXIT / FLIP events).
 *
 * Vanilla DOM patching — auto-mounts into [data-tt-activity-strip] if
 * the host page declares one, otherwise injects itself directly after
 * the topnav. Polls every 60s. Hides gracefully when there are no
 * events.
 */
(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const API_BASE = window.TT_API_BASE || "";

  // ── Styles (idempotent) ────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById("tt-activity-strip-styles")) return;
    const el = document.createElement("style");
    el.id = "tt-activity-strip-styles";
    el.textContent = `
      .tt-activity-strip {
        position: sticky;
        top: 56px; /* below the nav, which is sticky at top */
        z-index: 40;
        background: rgba(10,12,16,0.85);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        border-bottom: 1px solid var(--tt-border, rgba(255,255,255,0.06));
      }
      .tt-activity-strip__inner {
        max-width: 1600px;
        margin: 0 auto;
        padding: 8px 24px;
        display: flex;
        align-items: center;
        gap: 12px;
      }
      @media (max-width: 720px) {
        .tt-activity-strip__inner { padding: 8px 12px; gap: 8px; }
      }
      .tt-activity-strip__label {
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.10em;
        color: var(--tt-text-dim, #6b7280);
        text-transform: uppercase;
        flex-shrink: 0;
        font-family: var(--tt-font, 'Inter', sans-serif);
      }
      .tt-activity-strip__scroll {
        flex: 1 1 auto;
        overflow-x: auto;
        scrollbar-width: none;
        -ms-overflow-style: none;
      }
      .tt-activity-strip__scroll::-webkit-scrollbar { display: none; }
      .tt-activity-strip__row {
        display: inline-flex;
        gap: 14px;
        align-items: center;
        padding-right: 6px;
      }
      .tt-activity-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 9px;
        border-radius: 999px;
        font-size: 11.5px;
        font-family: var(--tt-font-mono, ui-monospace, monospace);
        background: var(--tt-bg-elev, rgba(255,255,255,0.04));
        border: 1px solid var(--tt-border, rgba(255,255,255,0.06));
        color: var(--tt-text-muted, #9ca3af);
        white-space: nowrap;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease;
      }
      .tt-activity-pill:hover {
        background: var(--tt-bg-surface, rgba(255,255,255,0.025));
        border-color: var(--tt-border-hi, rgba(255,255,255,0.12));
      }
      .tt-activity-pill .ev-type {
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        font-size: 10.5px;
      }
      .tt-activity-pill .ev-sym {
        font-weight: 700;
        color: var(--tt-text, #e5e7eb);
      }
      .tt-activity-pill .ev-time {
        font-size: 10px;
        opacity: 0.7;
      }
      .tt-activity-pill.ev-entry  .ev-type { color: var(--tt-up-soft, #34d399); }
      .tt-activity-pill.ev-add    .ev-type { color: var(--tt-up-soft, #34d399); }
      .tt-activity-pill.ev-trim   .ev-type { color: #fbbf24; }
      .tt-activity-pill.ev-exit   .ev-type { color: var(--tt-dn-soft, #fb7185); }
      .tt-activity-pill.ev-flip   .ev-type { color: var(--tt-cyan, #22d3ee); }
      .tt-activity-pill.ev-stage  .ev-type { color: var(--tt-accent, #f5c25c); }
      .tt-activity-strip__empty {
        font-size: 11.5px;
        color: var(--tt-text-faint, #4b5563);
        font-style: italic;
      }
    `;
    document.head.appendChild(el);
  }

  // ── Helpers ────────────────────────────────────────────────────
  function fmtAgo(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    const ms = ts < 1e12 ? n * 1000 : n;
    const diff = Date.now() - ms;
    const m = Math.floor(diff / 60000);
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    const hr = Math.floor(m / 60);
    if (hr < 24) return `${hr}h`;
    const d = Math.floor(hr / 24);
    return `${d}d`;
  }

  function classifyEvent(ev) {
    const t = String(ev?.type || ev?.event || ev?.kind || "").toUpperCase();
    // Bug 1 (2026-05-19) — admin activity-feed emits TRADE_ENTRY /
    // TRADE_EXIT / TRADE_TRIM / SQUEEZE_RELEASE event types; the strip
    // previously only recognized ENTRY / EXIT / TRIM / FLIP. Without
    // these mappings, real trade events render as the bare event name
    // and look like noise. Map them onto the existing pill classes.
    if (t === "TRADE_ENTRY")    return { cls: "ev-entry", label: "ENTER" };
    if (t === "TRADE_EXIT")     return { cls: "ev-exit",  label: "EXIT"  };
    if (t === "TRADE_TRIM")     return { cls: "ev-trim",  label: "TRIM"  };
    if (t === "SQUEEZE_RELEASE")return { cls: "ev-flip",  label: "SQ RLS" };
    if (t === "ENTRY" || t === "ENTER")     return { cls: "ev-entry", label: "ENTER" };
    if (t === "ADD" || t === "ADD_ENTRY")   return { cls: "ev-add",   label: "ADD" };
    if (t === "TRIM" || t === "TP_HIT_TRIM") return { cls: "ev-trim", label: "TRIM" };
    if (t === "EXIT" || t === "TP_HIT_EXIT" || t === "SL_HIT") return { cls: "ev-exit", label: "EXIT" };
    if (t === "FLIP" || t === "FLIP_LONG" || t === "FLIP_SHORT") return { cls: "ev-flip", label: "FLIP" };
    if (t === "STAGE_CHANGE" || t === "STAGE_TRANSITION") return { cls: "ev-stage", label: "STAGE" };
    return { cls: "", label: t || "EVENT" };
  }

  // ── Render ─────────────────────────────────────────────────────
  function render(host, events) {
    const visible = (Array.isArray(events) ? events : []).slice(0, 20);

    if (!host._inner) {
      const inner = document.createElement("div");
      inner.className = "tt-activity-strip__inner";

      const label = document.createElement("span");
      label.className = "tt-activity-strip__label";
      label.textContent = "Recent activity";
      inner.appendChild(label);

      const scroll = document.createElement("div");
      scroll.className = "tt-activity-strip__scroll";
      const row = document.createElement("div");
      row.className = "tt-activity-strip__row";
      scroll.appendChild(row);
      inner.appendChild(scroll);

      host.appendChild(inner);
      host._inner = inner;
      host._row = row;
    }

    const row = host._row;
    row.innerHTML = "";

    if (visible.length === 0) {
      const empty = document.createElement("span");
      empty.className = "tt-activity-strip__empty";
      empty.textContent = "No recent system events.";
      row.appendChild(empty);
      // Keep host visible (~32px) so the layout stays stable.
      host.style.display = "";
      return;
    }

    for (const ev of visible) {
      const meta = classifyEvent(ev);
      const sym = String(ev?.ticker || ev?.symbol || "").toUpperCase();
      const ts = ev?.ts ?? ev?.timestamp ?? ev?.created_at ?? ev?.event_ts ?? 0;
      const pill = document.createElement("a");
      pill.className = `tt-activity-pill ${meta.cls}`;
      pill.href = sym ? `/active-trader.html?ticker=${encodeURIComponent(sym)}` : "#";
      pill.innerHTML =
        `<span class="ev-type">${meta.label}</span>` +
        (sym ? `<span class="ev-sym">${sym}</span>` : "") +
        (fmtAgo(ts) ? `<span class="ev-time">${fmtAgo(ts)}</span>` : "");
      row.appendChild(pill);
    }
    host.style.display = "";
  }

  // ── Fetch ──────────────────────────────────────────────────────
  let _events = [];
  function isAdmin() {
    return window._ttIsAdmin === true || document.body?.dataset?.isAdmin === "true";
  }

  async function refresh(host) {
    try {
      // Bug 1 (2026-05-19) — admin users get the D1-backed
      // /timed/admin/activity-feed (real ENTRY/TRIM/EXIT/FLIP from
      // execution_actions). Non-admins keep the public KV-backed
      // /timed/activity feed (sparse — only public-safe signals).
      // Auth is per-request via session cookie (credentials: include);
      // admin endpoint returns 401 cleanly if the user isn't admin.
      const endpoint = isAdmin() ? "/timed/admin/activity-feed" : "/timed/activity";
      const r = await fetch(`${API_BASE}${endpoint}?limit=20&_t=${Date.now()}`, {
        cache: "no-store",
        credentials: "include",
      });
      if (!r.ok) { render(host, _events); return; }
      const j = await r.json();
      if (j?.ok && Array.isArray(j.events)) {
        _events = j.events;
      }
      render(host, _events);
    } catch (_) {
      render(host, _events);
    }
  }

  // ── Mount ──────────────────────────────────────────────────────
  //
  // Bug 2026-05-20 (user report): the strip worked on /today but not on
  // /active-trader and /investor despite identical script/HTML structure.
  // Root cause: auto-mount via document.querySelector("nav.topnav") +
  // insertAdjacentElement was racy and broke depending on page context
  // (some pages may have React content that interferes, defer-script
  // ordering, etc.). Fix:
  //   1. Each page now ships an explicit `<div data-tt-activity-strip>`
  //      container in the static HTML right after </nav>, eliminating
  //      the nav-query dependency.
  //   2. MutationObserver below re-mounts if the host is ever removed
  //      from the DOM (defense against React reconciliation or other
  //      scripts touching siblings of #root).
  //   3. [ACTIVITY-STRIP] log line on mount so devs can immediately
  //      verify the strip booted via the browser console.
  function mount() {
    ensureStyles();
    let host = document.querySelector("[data-tt-activity-strip]");
    if (!host) {
      // Legacy fallback: auto-mount under the top nav for pages that
      // haven't been updated with the explicit container yet.
      const nav = document.querySelector("nav.topnav");
      if (!nav) {
        console.warn("[ACTIVITY-STRIP] mount aborted — no explicit container and no nav.topnav found");
        return null;
      }
      host = document.createElement("div");
      host.className = "tt-activity-strip";
      host.setAttribute("data-tt-activity-strip", "auto");
      nav.insertAdjacentElement("afterend", host);
      console.log("[ACTIVITY-STRIP] mounted via fallback auto-insert under nav.topnav");
    } else {
      host.classList.add("tt-activity-strip");
      console.log("[ACTIVITY-STRIP] mounted into explicit [data-tt-activity-strip] container");
    }
    refresh(host);
    setInterval(() => {
      if (document.visibilityState === "hidden") return;
      refresh(host);
    }, 60 * 1000);

    // Defense: if the host node is ever removed from the DOM (e.g. by
    // a React re-render that clobbered surrounding nodes, or another
    // script doing innerHTML reset), re-mount silently.
    try {
      const obs = new MutationObserver(() => {
        if (!document.contains(host)) {
          console.warn("[ACTIVITY-STRIP] host removed from DOM — re-mounting");
          // Reset closure-cached children so render() rebuilds.
          host._inner = null;
          host._row = null;
          mount();
          obs.disconnect();
        }
      });
      obs.observe(document.body, { childList: true, subtree: false });
    } catch (_) { /* observer is best-effort */ }
    return host;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
