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
        /* iOS Safari has a known position:sticky bug during momentum scroll
           where the element briefly unsticks and floats — same pattern we
           fixed on the bottom nav. Forcing a GPU compositing layer pins
           the strip to its own layer and prevents the miscalculation. */
        transform: translate3d(0, 0, 0);
        -webkit-transform: translate3d(0, 0, 0);
        will-change: transform;
        -webkit-backface-visibility: hidden;
        backface-visibility: hidden;
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
        /* On phones the in-flow sticky was visibly drifting on iOS Safari
           even with the GPU layer fix above — the strip is the FIRST
           positioned descendant of <body>, so we can promote it to
           position:fixed cleanly. Pin it directly below the nav. The
           accompanying body padding-top (injected on mount, see
           ensureMobileSpacer below) keeps content from sliding under it.
           The desktop sticky path is unchanged. */
        .tt-activity-strip {
          position: fixed;
          top: var(--tt-nav-h, 52px);
          left: 0;
          right: 0;
        }
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

  // ── Mobile spacer + nav-offset measurement ─────────────────────
  // On phones the strip is position:fixed (CSS above), so it no longer
  // takes up flow space and content would slide under it. Inject a
  // body padding-top equal to the strip's measured height and set a
  // CSS custom property --tt-nav-h to the live nav height so the strip
  // sits exactly under the top nav even if it ever changes (e.g. badge
  // wraps to a second line). Recomputed on resize.
  function ensureMobileSpacer(host) {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const apply = () => {
      try {
        const isMobile = window.matchMedia && window.matchMedia("(max-width: 720px)").matches;
        const nav = document.querySelector("nav.topnav");
        const navH = nav ? Math.round(nav.getBoundingClientRect().height) : 52;
        document.documentElement.style.setProperty("--tt-nav-h", `${navH}px`);
        if (!isMobile) {
          // Restore desktop sticky — drop the spacer if it was set.
          if (document.body && document.body.dataset.ttStripSpacer) {
            document.body.style.paddingTop = "";
            delete document.body.dataset.ttStripSpacer;
          }
          return;
        }
        // Measure the strip's rendered height and pad the body so the
        // top of the first content card sits right below it.
        const stripH = Math.round(host.getBoundingClientRect().height) || 44;
        const total = navH + stripH;
        if (document.body) {
          document.body.style.paddingTop = `${total}px`;
          document.body.dataset.ttStripSpacer = String(total);
        }
      } catch (_) { /* best-effort */ }
    };
    apply();
    // Re-measure when the strip's content changes height (e.g. an empty
    // strip vs a populated one), on window resize, and on viewport
    // changes (iOS Safari URL-bar collapse).
    try {
      const ro = new ResizeObserver(() => apply());
      ro.observe(host);
      const nav = document.querySelector("nav.topnav");
      if (nav) ro.observe(nav);
    } catch (_) {}
    window.addEventListener("resize", apply, { passive: true });
    window.addEventListener("orientationchange", apply, { passive: true });
  }

  // ── Render ─────────────────────────────────────────────────────
  function render(host, events) {
    // 2026-05-21 — defensive sort, newest first.
    // The admin /timed/admin/activity-feed endpoint already returns
    // ts DESC, but the public /timed/activity endpoint and any future
    // merge step can disagree. Guarantee newest-first ordering here
    // so the chip on the left is always the most recent event and
    // the user can horizontally scroll right for older activity.
    const arr = (Array.isArray(events) ? events : []).slice();
    arr.sort((a, b) => {
      const tA = Number(a?.ts ?? a?.timestamp ?? a?.created_at ?? a?.event_ts ?? 0);
      const tB = Number(b?.ts ?? b?.timestamp ?? b?.created_at ?? b?.event_ts ?? 0);
      // ms vs seconds — normalize before comparing so a mixed batch is
      // still ordered correctly (admin = ms, public = seconds).
      const normA = tA > 1e12 ? tA : tA * 1000;
      const normB = tB > 1e12 ? tB : tB * 1000;
      return normB - normA;
    });
    const visible = arr.slice(0, 20);

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
    // Admin gets the D1-backed admin feed (real ENTRY/TRIM/EXIT from
    // execution_actions). Non-admin gets the public KV-backed feed
    // (sparse, often empty). Auth flows via session cookie.
    //
    // Fallback: if admin endpoint returns 401 (no session yet, e.g. on
    // first paint before auth-gate has populated _ttIsAdmin), retry
    // against the public endpoint so the strip still shows SOMETHING
    // instead of staying empty until the next 60s tick.
    const adminEndpoint = "/timed/admin/activity-feed";
    const publicEndpoint = "/timed/activity";
    const wantAdmin = isAdmin();
    let endpoint = wantAdmin ? adminEndpoint : publicEndpoint;
    let r;
    try {
      r = await fetch(`${API_BASE}${endpoint}?limit=20&_t=${Date.now()}`, {
        cache: "no-store",
        credentials: "include",
      });
      // If admin fetch fails with 401/403 (no session yet), fall back
      // to public endpoint on the same tick.
      if (wantAdmin && (r.status === 401 || r.status === 403)) {
        console.warn(`[ACTIVITY-STRIP] admin feed returned ${r.status}, falling back to public`);
        endpoint = publicEndpoint;
        r = await fetch(`${API_BASE}${endpoint}?limit=20&_t=${Date.now()}`, {
          cache: "no-store",
          credentials: "include",
        });
      }
    } catch (e) {
      console.warn(`[ACTIVITY-STRIP] fetch ${endpoint} threw:`, e);
      render(host, _events);
      return;
    }
    if (!r || !r.ok) {
      console.warn(`[ACTIVITY-STRIP] fetch ${endpoint} returned status=${r?.status || "?"}`);
      render(host, _events);
      return;
    }
    let j;
    try {
      j = await r.json();
    } catch (e) {
      console.warn(`[ACTIVITY-STRIP] fetch ${endpoint} JSON parse failed:`, e);
      render(host, _events);
      return;
    }
    if (j?.ok && Array.isArray(j.events)) {
      _events = j.events;
      // First-load visibility: log the count so we can verify in
      // DevTools that data flowed without needing to inspect DOM.
      console.log(`[ACTIVITY-STRIP] ${endpoint} → ${_events.length} events`);
    } else {
      console.warn(`[ACTIVITY-STRIP] fetch ${endpoint} returned bad shape:`, j);
    }
    render(host, _events);
  }

  // ── Mount ──────────────────────────────────────────────────────
  //
  // The strip script is loaded with `defer` on /today, /active-trader,
  // /investor. Each page ships an explicit `<div data-tt-activity-strip>`
  // container in the static HTML right after </nav> — that's the mount
  // target. Legacy fallback (insertAdjacentElement under nav.topnav) is
  // kept for any page that hasn't been updated yet.
  //
  // Auth timing note: on first refresh, `auth-gate.js` may not have
  // populated `window._ttIsAdmin` yet (network round-trip to /timed/me).
  // refresh() handles this gracefully — if the admin endpoint 401s,
  // it falls back to the public endpoint on the same tick. The 60s
  // setInterval below will pick up admin events as soon as auth lands.
  function mount() {
    ensureStyles();
    let host = document.querySelector("[data-tt-activity-strip]");
    if (!host) {
      const nav = document.querySelector("nav.topnav");
      if (!nav) {
        console.warn("[ACTIVITY-STRIP] mount aborted — no [data-tt-activity-strip] container and no nav.topnav");
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
    // Mobile: make the strip position:fixed under the nav (see CSS) and
    // pad the body so the first content card sits below it. Desktop: no-op.
    ensureMobileSpacer(host);
    refresh(host);

    // Bug 2026-05-20 (PR after #238): on initial page load the first
    // refresh fires at defer-script time — BEFORE auth-gate's
    // /timed/me fetch resolves and populates window._ttIsAdmin. So the
    // first refresh hits the public /timed/activity endpoint (which is
    // usually empty) and renders the empty state. The user then has to
    // wait 60s for the next setInterval tick to hit the admin endpoint.
    //
    // auth-gate.js dispatches `tt-auth-bootstrap-updated` AFTER setting
    // body.dataset.isAdmin + window._ttIsAdmin. Listen for that event
    // and re-fetch immediately. Subsequent setInterval ticks pick up
    // the admin endpoint on their own.
    try {
      const _onAuthBootstrap = (ev) => {
        const justWentAdmin = !!ev?.detail?.isAdmin;
        console.log(`[ACTIVITY-STRIP] auth bootstrap event received (isAdmin=${justWentAdmin}) — refetching`);
        refresh(host);
      };
      window.addEventListener("tt-auth-bootstrap-updated", _onAuthBootstrap);
    } catch (_) { /* event wiring is best-effort */ }

    setInterval(() => {
      if (document.visibilityState === "hidden") return;
      refresh(host);
    }, 60 * 1000);

    // Also re-fetch when the page becomes visible after being hidden
    // (e.g. tab-switching). The strip should reflect what happened
    // while the user was away.
    try {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          refresh(host);
        }
      });
    } catch (_) { /* visibilitychange is best-effort */ }
    return host;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
