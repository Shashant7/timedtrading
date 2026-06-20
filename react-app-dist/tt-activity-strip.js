/* tt-activity-strip.js — recent ENTRY/TRIM/EXIT with traceability to History tab */
(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const API_BASE = window.TT_API_BASE || "";

  function ensureStyles() {
    if (document.getElementById("tt-activity-strip-styles")) return;
    const el = document.createElement("style");
    el.id = "tt-activity-strip-styles";
    el.textContent = `
      /* 2026-05-31 — Sticky header wrapper. The nav and the activity
         strip are moved into this container at runtime so they stick
         together as a single unit. Before, the nav was \`position:
         sticky; top: 0\` and the strip was \`position: fixed; top:
         52px\` on mobile — iOS Safari momentarily de-sticks
         position:sticky elements during the address-bar collapse,
         which made the fixed-position strip momentarily appear ABOVE
         the unstuck nav. One sticky container = both pin together,
         always in DOM order. */
      .tt-sticky-top {
        position: sticky;
        top: 0;
        z-index: 60;
        background: rgba(11,20,16,0.85);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        transform: translate3d(0, 0, 0);
        -webkit-transform: translate3d(0, 0, 0);
        will-change: transform;
      }
      .tt-sticky-top > nav.topnav {
        position: static !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        background: transparent !important;
        z-index: auto !important;
      }
      .tt-sticky-top > [data-tt-activity-strip],
      .tt-sticky-top > .tt-activity-strip {
        position: static !important;
        top: auto !important;
        left: auto !important;
        right: auto !important;
        z-index: auto !important;
      }

      .tt-activity-strip {
        position: sticky; top: 56px; z-index: 40;
        background: rgba(11,20,16,0.85);
        backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
        border-bottom: 1px solid var(--tt-border, rgba(255,255,255,0.06));
        transform: translate3d(0,0,0); will-change: transform;
      }
      .tt-activity-strip__inner {
        max-width: 1600px; margin: 0 auto; padding: 8px 24px;
        display: flex; align-items: center; gap: 12px;
      }
      @media (max-width: 720px) {
        /* 2026-05-31 — Mobile keeps sticky positioning (was fixed),
           but inside the .tt-sticky-top wrapper the !important rules
           above force position:static so the strip flows under the
           nav within the sticky container. */
        .tt-activity-strip { position: sticky; top: var(--tt-nav-h, 52px); left: 0; right: 0; }
        .tt-activity-strip__inner { padding: 8px 12px; gap: 8px; }
      }
      .tt-activity-strip__label {
        font-size: 10.5px; font-weight: 700; letter-spacing: 0.10em;
        color: var(--tt-text-dim, #6E867D); text-transform: uppercase; flex-shrink: 0;
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
        color: var(--tt-text-muted, #8AA39A); white-space: nowrap; cursor: pointer;
        max-width: min(420px, 92vw); text-align: left;
      }
      .tt-activity-pill:hover { border-color: var(--tt-border-hi, rgba(255,255,255,0.12)); }
      .tt-activity-pill .ev-type { font-weight: 700; font-size: 10px; text-transform: uppercase; }
      .tt-activity-pill .ev-sym { font-weight: 700; color: var(--tt-text, #E8F2EC); }
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

  // Display-layer only — raw execution_actions.reason values stay unchanged
  // in D1. Mirrors worker/email.js + Discord trimReasonMap so the strip
  // never leaks indicator-author jargon ("ripster 5 12 lost confirmed").
  const ACTIVITY_REASON_MAP = {
    ripster_5_12_lost_confirmed: "5/12 cloud cross confirmed — momentum flipped",
    ripster_5_12_lost: "5/12 cloud lost — momentum flipping",
    ripster_5_12_defend_trim: "5/12 cloud lost — defensive trim",
    ripster_5_12_pending: "5/12 cloud cross forming",
    ripster_34_50_trim_then_hold: "34/50 cloud trim — runner held",
    ripster_34_50_defer_to_72_89: "34/50 lost — deferring to 72/89",
    ripster_72_89_1h_trim: "72/89 structural trim",
    ripster_72_89_1h_structural_break: "72/89 structural break",
    ripster_30m_9ema_trail_trim: "30m 9-EMA trail trim",
    ripster_30m_9ema_trail_exit: "30m 9-EMA trail exit",
    ripster_pdz_mfe_trim: "PDZ MFE trim",
    atr_tp_ladder_tier1_fib0_382: "ATR ladder tier 1 trim",
    atr_tp_ladder_tier2_fib0_618: "ATR ladder tier 2 trim",
    atr_tp_ladder_tier3_fib1: "ATR ladder tier 3 trim",
    atr_tp_ladder_tier4_fib1_236: "ATR ladder tier 4 trim",
    atr_tp_ladder_runner_full: "ATR runner cap exit",
    PRE_CPI_RISK_REDUCTION: "Pre-CPI risk reduction",
    PRE_PPI_RISK_REDUCTION: "Pre-PPI risk reduction",
    PRE_FOMC_RISK_REDUCTION: "Pre-FOMC risk reduction",
    PRE_PCE_RISK_REDUCTION: "Pre-PCE risk reduction",
    PRE_NFP_RISK_REDUCTION: "Pre-NFP risk reduction",
    PRE_EARNINGS_RISK_REDUCTION: "Pre-earnings risk reduction",
    MFE_SAFETY_TRIM: "Profit lock trim",
    PHASE_LEAVE_100: "Momentum fade trim",
    RUNNER_PEAK_TRAIL: "Peak trail trim",
    PROFIT_PROTECT_TRIM: "Profit protect trim",
    SOFT_FUSE_TRIM: "Momentum weaken trim",
    SOFT_FUSE_CLOUD_TRIM: "Cloud-hold partial trim",
    sl_breached: "Stop loss hit",
    TP_FULL: "All targets hit",
    RUNNER_MAX_DRAWDOWN_BREAKER: "Pullback from peak exit",
    HARD_LOSS_CAP: "Hard loss cap exit",
    STALL_FORCE_CLOSE: "Stalled — capital freed",
  };

  function shortReason(reason) {
    const raw = String(reason || "").trim();
    if (!raw) return "";
    if (ACTIVITY_REASON_MAP[raw]) {
      const label = ACTIVITY_REASON_MAP[raw];
      return label.length > 40 ? label.slice(0, 38) + "…" : label;
    }
    const scrubbed = raw
      .replace(/^TT\s+/i, "")
      .replace(/^Tt[\s_]/i, "")
      .replace(/^tt_/i, "")
      .replace(/ripster[_\s-]*/gi, "")
      .replace(/saty[_\s-]*/gi, "")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const titled = scrubbed.replace(/\b\w/g, (c) => c.toUpperCase());
    return titled.length > 40 ? titled.slice(0, 38) + "…" : titled;
  }

  function classifyEvent(ev) {
    const t = String(ev?.type || ev?.event || "").toUpperCase();
    if (t === "TRADE_ENTRY") return { cls: "ev-entry", label: "ENTER", evType: "ENTRY" };
    if (t === "TRADE_EXIT" || t === "TRADE_EXIT_SIGNAL") return { cls: "ev-exit", label: "EXIT", evType: "EXIT" };
    if (t === "TRADE_TRIM") return { cls: "ev-trim", label: "TRIM", evType: "TRIM" };
    if (t === "INVESTOR_SIGNAL") return { cls: "ev-entry", label: String(ev?.action || "INVESTOR").toUpperCase(), evType: "INVESTOR_SIGNAL" };
    // D5 (2026-06-11) — resolution-time grading events from the Signal
    // Outcome Ledger: every published call shows its grade on the strip
    // the night it resolves. Wins read green, losses red, flats neutral.
    if (t === "SIGNAL_GRADED") {
      const oc = String(ev?.outcome || "").toLowerCase();
      return {
        cls: oc === "win" ? "ev-entry" : oc === "loss" ? "ev-exit" : "ev-trim",
        label: `GRADED ${String(ev?.grade || "").toUpperCase()}`.trim(),
        evType: "SIGNAL_GRADED",
      };
    }
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
    if (t === "SIGNAL_GRADED") {
      const pct = Number(ev?.outcome_pct);
      if (Number.isFinite(pct)) parts.push(`${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`);
      if (ev?.source) parts.push(String(ev.source).replace(/_/g, " "));
    }
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

  // 2026-05-31 — Tracks the live nav height as a CSS variable so the
  // desktop activity strip's `top: 56px` rule can scale to the real
  // nav height (previously hard-coded). The body padding-top hack
  // that used to live here is no longer needed: the .tt-sticky-top
  // wrapper keeps both elements in document flow, so content
  // naturally starts BELOW the sticky header without a synthetic
  // padding-top spacer (which used to fight with iOS Safari's
  // address bar collapse). Cleanup the old spacer if a previous
  // page load left it on body.
  function ensureMobileSpacer(host) {
    const apply = () => {
      try {
        const navH = document.querySelector("nav.topnav")?.getBoundingClientRect().height || 52;
        document.documentElement.style.setProperty("--tt-nav-h", `${Math.round(navH)}px`);
        if (document.body?.dataset.ttStripSpacer) {
          document.body.style.paddingTop = "";
          delete document.body.dataset.ttStripSpacer;
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
  // 2026-05-31 — Activity strip is a Pro-tier feature. Free / not-yet-
  // trialing visitors should not be able to follow the live trade feed
  // without paying (the strip lets you see every ENTRY / TRIM / EXIT
  // the model takes in real time — that's the core value). We gate
  // hide-if-not-Pro server-side too via the endpoint auth, but the UI
  // gate also (a) avoids the fetch entirely (less noise + faster page),
  // and (b) collapses the DOM so there is no empty strip placeholder.
  function isProOrAdmin() {
    if (isAdmin()) return true;
    if (window._ttIsPro === true) return true;
    if (document.body?.dataset?.isPro === "true") return true;
    return false;
  }
  function isAuthenticated() {
    if (document.body?.dataset?.isAuthenticated === "true") return true;
    try {
      const session = window.TimedAuthHelpers?.getStoredSession?.();
      return !!session;
    } catch (_) {
      return false;
    }
  }

  function setHostVisible(host, visible) {
    if (!host) return;
    host.style.display = visible ? "" : "none";
    host.setAttribute("data-tt-activity-strip-gated", visible ? "0" : "1");
  }

  async function refresh(host) {
    if (!isAuthenticated() || !isProOrAdmin()) {
      // Logged-out or free user — hide and bail. Re-evaluated on
      // tt-auth-bootstrap-updated when auth-gate clears dataset flags.
      _events = [];
      setHostVisible(host, false);
      return;
    }
    setHostVisible(host, true);
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

  // 2026-05-31 — Wrap <nav.topnav> + <[data-tt-activity-strip]> in a
  // single .tt-sticky-top container so they pin together as one unit
  // (see CSS comment above). Idempotent: re-running this function is
  // a no-op once the wrapper exists.
  function ensureStickyWrapper(host) {
    try {
      const nav = document.querySelector("nav.topnav");
      if (!nav) return;
      // Already wrapped? Done.
      if (nav.parentElement && nav.parentElement.classList.contains("tt-sticky-top")) return;
      const wrapper = document.createElement("div");
      wrapper.className = "tt-sticky-top";
      // Insert wrapper where nav currently lives, then move nav + host into it.
      nav.parentNode.insertBefore(wrapper, nav);
      wrapper.appendChild(nav);
      if (host && host !== wrapper) wrapper.appendChild(host);
    } catch (_) { /* defensive: never break the page over a UI nicety */ }
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
    // Wrap nav + strip in the sticky container so they pin as one.
    ensureStickyWrapper(host);
    // Default to hidden until auth-bootstrap fires; prevents a brief
    // flash of the strip on cold page load before auth-gate resolves.
    setHostVisible(host, false);
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

// cache-bust:1781968603785:28660007
