/* tt-activity-strip.js — recent ENTRY/TRIM/EXIT with traceability to History tab */
(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const API_BASE = window.TT_API_BASE || "";

  function ensureStyles() {
    if (document.getElementById("tt-activity-strip-styles")) return;
    const el = document.createElement("style");
    el.id = "tt-activity-strip-styles";
    el.textContent = `
      .tt-activity-strip {
        position: sticky; top: 56px; z-index: 40;
        background: rgba(10,12,16,0.85);
        backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
        border-bottom: 1px solid var(--tt-border, rgba(255,255,255,0.06));
        transform: translate3d(0,0,0); will-change: transform;
      }
      .tt-activity-strip__inner {
        max-width: 1600px; margin: 0 auto; padding: 8px 24px;
        display: flex; align-items: center; gap: 12px;
      }
      @media (max-width: 720px) {
        .tt-activity-strip { position: fixed; top: var(--tt-nav-h, 52px); left: 0; right: 0; }
        .tt-activity-strip__inner { padding: 8px 12px; gap: 8px; }
      }
      .tt-activity-strip__label {
        font-size: 10.5px; font-weight: 700; letter-spacing: 0.10em;
        color: var(--tt-text-dim, #6b7280); text-transform: uppercase; flex-shrink: 0;
      }
      .tt-activity-strip__hint { font-size: 10px; color: var(--tt-text-faint); display: none; flex-shrink: 0; }
      @media (min-width: 900px) { .tt-activity-strip__hint { display: block; } }
      .tt-activity-strip__scroll { flex: 1; overflow-x: auto; scrollbar-width: none; }
      .tt-activity-strip__scroll::-webkit-scrollbar { display: none; }
      .tt-activity-strip__row { display: inline-flex; gap: 10px; align-items: center; }
      .tt-activity-pill {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 4px 10px; border-radius: 8px; font-size: 11px;
        font-family: var(--tt-font-mono, ui-monospace, monospace);
        background: var(--tt-bg-elev, rgba(255,255,255,0.04));
        border: 1px solid var(--tt-border, rgba(255,255,255,0.06));
        color: var(--tt-text-muted, #9ca3af); white-space: nowrap; cursor: pointer;
        max-width: min(420px, 92vw); text-align: left;
      }
      .tt-activity-pill:hover { border-color: var(--tt-border-hi, rgba(255,255,255,0.12)); }
      .tt-activity-pill .ev-type { font-weight: 700; font-size: 10px; text-transform: uppercase; }
      .tt-activity-pill .ev-sym { font-weight: 700; color: var(--tt-text, #e5e7eb); }
      .tt-activity-pill .ev-dir { font-size: 9px; font-weight: 600; }
      .tt-activity-pill .ev-dir--long { color: var(--tt-up-soft, #34d399); }
      .tt-activity-pill .ev-dir--short { color: var(--tt-dn-soft, #fb7185); }
      .tt-activity-pill .ev-detail { font-size: 10px; overflow: hidden; text-overflow: ellipsis; }
      .tt-activity-pill .ev-pnl { font-size: 10px; font-weight: 600; }
      .tt-activity-pill .ev-pnl--up { color: var(--tt-up-soft, #34d399); }
      .tt-activity-pill .ev-pnl--dn { color: var(--tt-dn-soft, #fb7185); }
      .tt-activity-pill .ev-time { font-size: 9px; opacity: 0.65; }
      .tt-activity-pill.ev-entry .ev-type { color: var(--tt-up-soft, #34d399); }
      .tt-activity-pill.ev-trim .ev-type { color: #fbbf24; }
      .tt-activity-pill.ev-exit .ev-type { color: var(--tt-dn-soft, #fb7185); }
      .tt-activity-strip__empty { font-size: 11.5px; color: var(--tt-text-faint); font-style: italic; }
    `;
    document.head.appendChild(el);
  }

  function fmtAgo(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    const ms = n < 1e12 ? n * 1000 : n;
    const m = Math.floor((Date.now() - ms) / 60000);
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    const hr = Math.floor(m / 60);
    return hr < 24 ? `${hr}h` : `${Math.floor(hr / 24)}d`;
  }

  function fmtClock(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    const ms = n < 1e12 ? n * 1000 : n;
    try {
      return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (_) { return ""; }
  }

  function fmtUsd(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return "";
    return v >= 1000 ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : `$${v.toFixed(2)}`;
  }

  function fmtPct(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "";
    return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  }

  function shortReason(reason) {
    const s = String(reason || "").trim().replace(/_/g, " ");
    return s.length > 36 ? s.slice(0, 34) + "…" : s;
  }

  function classifyEvent(ev) {
    const t = String(ev?.type || ev?.event || "").toUpperCase();
    if (t === "TRADE_ENTRY") return { cls: "ev-entry", label: "ENTER", evType: "ENTRY" };
    if (t === "TRADE_EXIT") return { cls: "ev-exit", label: "EXIT", evType: "EXIT" };
    if (t === "TRADE_TRIM") return { cls: "ev-trim", label: "TRIM", evType: "TRIM" };
    if (t === "ENTRY" || t === "ENTER") return { cls: "ev-entry", label: "ENTER", evType: "ENTRY" };
    if (t === "ADD" || t === "ADD_ENTRY") return { cls: "ev-entry", label: "ADD", evType: "ADD_ENTRY" };
    if (t === "TRIM" || t === "TP_HIT_TRIM") return { cls: "ev-trim", label: "TRIM", evType: "TRIM" };
    if (t === "EXIT" || t === "TP_HIT_EXIT" || t === "SL_HIT") return { cls: "ev-exit", label: "EXIT", evType: "EXIT" };
    return { cls: "", label: t || "EVENT", evType: t };
  }

  function buildPillDetail(ev, meta) {
    const price = Number(ev?.price);
    const qty = Number(ev?.qty);
    const parts = [];
    const t = meta.evType;
    if (Number.isFinite(price) && price > 0) {
      if (t === "ENTRY" || t === "ADD_ENTRY") {
        parts.push(qty > 0 ? `${qty % 1 === 0 ? qty : qty.toFixed(1)} sh @ ${fmtUsd(price)}` : `@ ${fmtUsd(price)}`);
      } else {
        parts.push(`@ ${fmtUsd(price)}`);
      }
    }
    if (ev?.setup_grade && (t === "ENTRY" || t === "ADD_ENTRY")) parts.push(String(ev.setup_grade));
    const reason = shortReason(ev?.reason);
    if (reason && (t === "EXIT" || t === "TRIM")) parts.push(reason);
    return parts.join(" · ");
  }

  function isJourneyRailPage() {
    try {
      const p = String(window.location.pathname || "").toLowerCase();
      return p.includes("active-trader") || p.includes("today") || p.includes("investor") || p.includes("portfolio");
    } catch (_) { return false; }
  }

  function openActivityEvent(ev, sym, meta) {
    const ticker = String(sym || "").toUpperCase();
    if (!ticker) return;
    const tradeId = ev?.trade_id || ev?.tradeId || null;
    const evType = meta.evType || "";
    const openAutopsy = evType === "EXIT" || evType === "TRIM";

    try {
      if (typeof window.ttGlobalSearchMarkHandled === "function") window.ttGlobalSearchMarkHandled(ticker);
      else window._ttGlobalSearchLastHandled = ticker;
    } catch (_) {}

    if (typeof window.ttOpenTickerInRail === "function") {
      window.ttOpenTickerInRail({ ticker, initialRailTab: "HISTORY", tradeId, evType, openAutopsy, activityEvent: ev, source: "activity-strip" });
    } else {
      window.dispatchEvent(new CustomEvent("tt-open-ticker", {
        detail: { ticker, initialRailTab: "HISTORY", tradeId, openAutopsy, activityEvent: ev, source: "activity-strip" },
        bubbles: true,
      }));
    }

    setTimeout(() => {
      if (window._ttGlobalSearchLastHandled === ticker) return;
      if (isJourneyRailPage()) return;
      const q = new URLSearchParams({ ticker, railTab: "HISTORY" });
      if (tradeId) q.set("trade_id", tradeId);
      if (openAutopsy) q.set("autopsy", "1");
      if (evType) q.set("ev", evType);
      window.location.href = `/active-trader.html?${q.toString()}`;
    }, 400);
  }

  function ensureMobileSpacer(host) {
    const apply = () => {
      try {
        const isMobile = window.matchMedia?.("(max-width: 720px)")?.matches;
        const navH = document.querySelector("nav.topnav")?.getBoundingClientRect().height || 52;
        document.documentElement.style.setProperty("--tt-nav-h", `${Math.round(navH)}px`);
        if (!isMobile) {
          if (document.body?.dataset.ttStripSpacer) {
            document.body.style.paddingTop = "";
            delete document.body.dataset.ttStripSpacer;
          }
          return;
        }
        const total = Math.round(navH) + (Math.round(host.getBoundingClientRect().height) || 44);
        if (document.body) {
          document.body.style.paddingTop = `${total}px`;
          document.body.dataset.ttStripSpacer = String(total);
        }
      } catch (_) {}
    };
    apply();
    try {
      const ro = new ResizeObserver(apply);
      ro.observe(host);
      const nav = document.querySelector("nav.topnav");
      if (nav) ro.observe(nav);
    } catch (_) {}
    window.addEventListener("resize", apply, { passive: true });
  }

  function render(host, events) {
    const arr = (Array.isArray(events) ? events : []).slice();
    arr.sort((a, b) => {
      const norm = (x) => { const n = Number(x?.ts ?? x?.timestamp ?? 0); return n > 1e12 ? n : n * 1000; };
      return norm(b) - norm(a);
    });
    const visible = arr.slice(0, 20);

    if (!host._row) {
      const inner = document.createElement("div");
      inner.className = "tt-activity-strip__inner";
      const label = document.createElement("span");
      label.className = "tt-activity-strip__label";
      label.textContent = "Recent activity";
      const hint = document.createElement("span");
      hint.className = "tt-activity-strip__hint";
      hint.textContent = "Click → History";
      const scroll = document.createElement("div");
      scroll.className = "tt-activity-strip__scroll";
      const row = document.createElement("div");
      row.className = "tt-activity-strip__row";
      scroll.appendChild(row);
      inner.append(label, hint, scroll);
      host.appendChild(inner);
      host._row = row;
    }

    const row = host._row;
    row.innerHTML = "";
    if (!visible.length) {
      const empty = document.createElement("span");
      empty.className = "tt-activity-strip__empty";
      empty.textContent = "No recent system events.";
      row.appendChild(empty);
      return;
    }

    for (const ev of visible) {
      const meta = classifyEvent(ev);
      const sym = String(ev?.ticker || ev?.symbol || "").toUpperCase();
      const ts = ev?.ts ?? ev?.timestamp ?? 0;
      const dir = String(ev?.direction || "").toUpperCase();
      const detail = buildPillDetail(ev, meta);
      const pnlPct = Number(ev?.pnl_pct ?? ev?.pnlPct);
      const showPnl = (meta.evType === "EXIT" || meta.evType === "TRIM") && Number.isFinite(pnlPct);

      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = `tt-activity-pill ${meta.cls}`;
      pill.title = [meta.label, sym, dir, detail, fmtClock(ts)].filter(Boolean).join(" · ");

      const typeEl = document.createElement("span");
      typeEl.className = "ev-type";
      typeEl.textContent = meta.label;
      pill.appendChild(typeEl);
      if (sym) {
        const symEl = document.createElement("span");
        symEl.className = "ev-sym";
        symEl.textContent = sym;
        pill.appendChild(symEl);
      }
      if (dir === "LONG" || dir === "SHORT") {
        const dirEl = document.createElement("span");
        dirEl.className = `ev-dir ev-dir--${dir.toLowerCase()}`;
        dirEl.textContent = dir;
        pill.appendChild(dirEl);
      }
      if (detail) {
        const det = document.createElement("span");
        det.className = "ev-detail";
        det.textContent = detail;
        pill.appendChild(det);
      }
      if (showPnl) {
        const pnlEl = document.createElement("span");
        pnlEl.className = `ev-pnl ${pnlPct >= 0 ? "ev-pnl--up" : "ev-pnl--dn"}`;
        pnlEl.textContent = fmtPct(pnlPct);
        pill.appendChild(pnlEl);
      }
      const timeEl = document.createElement("span");
      timeEl.className = "ev-time";
      timeEl.textContent = fmtAgo(ts);
      pill.appendChild(timeEl);

      pill.addEventListener("click", (e) => { e.preventDefault(); openActivityEvent(ev, sym, meta); });
      row.appendChild(pill);
    }
  }

  let _events = [];
  function isAdmin() {
    return window._ttIsAdmin === true || document.body?.dataset?.isAdmin === "true";
  }

  async function refresh(host) {
    const adminEndpoint = "/timed/admin/activity-feed";
    const publicEndpoint = "/timed/activity";
    let endpoint = isAdmin() ? adminEndpoint : publicEndpoint;
    try {
      let r = await fetch(`${API_BASE}${endpoint}?limit=20&_t=${Date.now()}`, { cache: "no-store", credentials: "include" });
      if (isAdmin() && (r.status === 401 || r.status === 403)) {
        endpoint = publicEndpoint;
        r = await fetch(`${API_BASE}${endpoint}?limit=20&_t=${Date.now()}`, { cache: "no-store", credentials: "include" });
      }
      if (r.ok) {
        const j = await r.json();
        if (j?.ok && Array.isArray(j.events)) _events = j.events;
      }
    } catch (_) {}
    render(host, _events);
  }

  function mount() {
    ensureStyles();
    let host = document.querySelector("[data-tt-activity-strip]");
    if (!host) {
      const nav = document.querySelector("nav.topnav");
      if (!nav) return null;
      host = document.createElement("div");
      host.className = "tt-activity-strip";
      host.setAttribute("data-tt-activity-strip", "auto");
      nav.insertAdjacentElement("afterend", host);
    } else {
      host.classList.add("tt-activity-strip");
    }
    ensureMobileSpacer(host);
    refresh(host);
    window.addEventListener("tt-auth-bootstrap-updated", () => refresh(host));
    setInterval(() => { if (document.visibilityState !== "hidden") refresh(host); }, 60000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(host); });
    return host;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();

// cache-bust:1780011761292:492001491
