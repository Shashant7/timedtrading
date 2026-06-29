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
        max-width: 1600px; margin: 0 auto; padding: 11px 24px;
        display: flex; align-items: center; gap: 12px;
      }
      @media (max-width: 720px) {
        /* 2026-05-31 — Mobile keeps sticky positioning (was fixed),
           but inside the .tt-sticky-top wrapper the !important rules
           above force position:static so the strip flows under the
           nav within the sticky container. */
        .tt-activity-strip { position: sticky; top: var(--tt-nav-h, 52px); left: 0; right: 0; }
        .tt-activity-strip__inner { padding: 10px 12px; gap: 8px; }
      }
      .tt-activity-strip__label {
        font-size: 11px; font-weight: 700; letter-spacing: 0.10em;
        color: var(--tt-text-dim, #6E867D); text-transform: uppercase; flex-shrink: 0;
      }
      .tt-activity-strip__hint { font-size: 10.5px; color: var(--tt-text-faint); display: none; flex-shrink: 0; }
      @media (min-width: 900px) { .tt-activity-strip__hint { display: block; } }
      .tt-activity-strip__scroll { flex: 1; overflow-x: auto; scrollbar-width: none; }
      .tt-activity-strip__scroll::-webkit-scrollbar { display: none; }
      .tt-activity-strip__row { display: inline-flex; gap: 10px; align-items: center; }
      .tt-activity-pill {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 12px; border-radius: 9px; font-size: 12.5px;
        font-family: var(--tt-font-mono, ui-monospace, monospace);
        background: var(--tt-bg-elev, rgba(255,255,255,0.04));
        border: 1px solid var(--tt-border, rgba(255,255,255,0.06));
        color: var(--tt-text-muted, #8AA39A); white-space: nowrap; cursor: pointer;
        max-width: min(560px, 96vw); text-align: left; flex-shrink: 0;
      }
      .tt-activity-pill:hover { border-color: var(--tt-border-hi, rgba(255,255,255,0.12)); }
      /* Brand logo to the left of the ticker — monogram fallback until the
         real logo async-loads (mirrors ds-components tickerLogo). */
      .tt-activity-pill .ev-logo {
        width: 18px; height: 18px; flex-shrink: 0;
        display: inline-flex; align-items: center; justify-content: center;
        border-radius: 50%; overflow: hidden;
        font-size: 8px; font-weight: 700; letter-spacing: 0.02em;
        color: #fff; line-height: 1;
      }
      .tt-activity-pill .ev-logo img {
        width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block;
      }
      .tt-activity-pill .ev-scope {
        font-size: 9px; font-weight: 800; letter-spacing: 0.06em;
        text-transform: uppercase; padding: 1px 4px; border-radius: 4px;
        border: 1px solid transparent; line-height: 1.3;
      }
      .tt-activity-pill .ev-scope--trader {
        color: #67e8f9; background: rgba(103,232,249,0.10); border-color: rgba(103,232,249,0.28);
      }
      .tt-activity-pill .ev-scope--investor {
        color: #c4b5fd; background: rgba(167,139,250,0.12); border-color: rgba(167,139,250,0.30);
      }
      .tt-activity-pill .ev-type { font-weight: 700; font-size: 11px; text-transform: uppercase; }
      .tt-activity-pill .ev-sym { font-weight: 700; font-size: 12.5px; color: var(--tt-text, #E8F2EC); }
      .tt-activity-pill .ev-dir { font-size: 10px; font-weight: 600; }
      .tt-activity-pill .ev-dir--long { color: var(--tt-up-soft, #34d399); }
      .tt-activity-pill .ev-dir--short { color: var(--tt-dn-soft, #fb7185); }
      .tt-activity-pill .ev-detail { font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
      .tt-activity-pill .ev-pnl { font-size: 11px; font-weight: 600; }
      .tt-activity-pill .ev-pnl--up { color: var(--tt-up-soft, #34d399); }
      .tt-activity-pill .ev-pnl--dn { color: var(--tt-dn-soft, #fb7185); }
      .tt-activity-pill .ev-time { font-size: 10px; opacity: 0.65; }
      .tt-activity-pill.ev-entry .ev-type { color: var(--tt-up-soft, #34d399); }
      .tt-activity-pill.ev-trim .ev-type { color: #fbbf24; }
      .tt-activity-pill.ev-exit .ev-type { color: var(--tt-dn-soft, #fb7185); }
      .tt-activity-pill.ev-watching {
        background: transparent;
        border-style: dashed;
        opacity: 0.82;
      }
      .tt-activity-pill.ev-doing,
      .tt-activity-pill.ev-recommended {
        background: rgba(251,146,60,0.10);
        border-color: rgba(251,146,60,0.35);
      }
      .tt-activity-strip__filters {
        display: inline-flex; gap: 4px; flex-shrink: 0;
      }
      .tt-activity-strip__filter {
        font-size: 9px; font-weight: 700; letter-spacing: 0.06em;
        text-transform: uppercase; padding: 3px 7px; border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.08); background: transparent;
        color: var(--tt-text-dim); cursor: pointer;
      }
      .tt-activity-strip__filter.is-active {
        color: var(--tt-text, #E8F2EC);
        border-color: rgba(255,255,255,0.16);
        background: rgba(255,255,255,0.06);
      }
      .tt-activity-pill[data-scope="investor"] {
        border-color: rgba(167,139,250,0.28);
        background: rgba(167,139,250,0.06);
      }
      .tt-activity-pill[data-scope="trader"] {
        border-color: rgba(103,232,249,0.22);
        background: rgba(103,232,249,0.04);
      }
      .tt-activity-strip__empty { font-size: 12.5px; color: var(--tt-text-faint); font-style: italic; }
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

  // Strip display: mode + enter/exit/trim only (ADD/BOUGHT/WATCH/QUEUE → enter).
  function normalizeDisplayAction(meta) {
    const label = String(meta?.label || "").toUpperCase();
    const evType = String(meta?.evType || "").toUpperCase();
    if (label === "TRIM" || evType === "TRIM" || label === "REDUCE" || evType.indexOf("TRIM") >= 0) return "TRIM";
    if (label === "EXIT" || evType === "EXIT" || /EXIT|SL_HIT|TP_HIT_EXIT/.test(evType)) return "EXIT";
    return "ENTER";
  }

  function scopeDisplayLabel(scope) {
    return scope === "investor" ? "Inv" : "Trader";
  }

  // Brand logo (monogram fallback → async real logo swap). Mirrors the
  // ds-components / today.html TickerLogo so the strip matches cards.
  function buildTickerLogo(sym) {
    const SYM = String(sym || "").toUpperCase();
    const el = document.createElement("span");
    el.className = "ev-logo";
    if (!SYM) return el;
    const mono = SYM.slice(0, 2);
    el.textContent = mono;
    let hash = 0;
    for (let i = 0; i < SYM.length; i++) hash = ((hash << 5) - hash) + SYM.charCodeAt(i);
    el.style.background = `hsl(${Math.abs(hash) % 360}, 35%, 28%)`;
    const url = (window.DS && typeof window.DS.tickerLogoUrl === "function")
      ? window.DS.tickerLogoUrl(SYM)
      : `${API_BASE}/timed/logo/${encodeURIComponent(SYM)}.png`;
    if (url) {
      const img = new Image();
      img.src = url;
      img.alt = SYM;
      img.onload = () => {
        // White plate so transparent-PNG ETF logos stay visible on dark.
        while (el.firstChild) el.removeChild(el.firstChild);
        el.style.background = "#ffffff";
        el.style.color = "transparent";
        el.appendChild(img);
      };
      img.onerror = () => { /* keep monogram + colored background */ };
    }
    return el;
  }

  // Client-side dedupe guard (belt-and-braces on top of the server's
  // buildMergedActivityFeed dedupe). The same investor action can surface via
  // both a D1 lot row and a KV signal append; collapse them by ticker + coarse
  // action class + 10-min bucket so the strip never shows duplicate
  // RIOT/CRDO exits even if a stale cache slips through.
  function actionClass(ev) {
    const a = String(ev?.action || ev?.investor_alert_type || ev?.type || ev?.event || "").toUpperCase();
    if (/SELL|TRIM|REDUCE|CLOSE|EXIT/.test(a)) return "sell";
    if (/BUY|ADD|ACCUMULAT|QUEUE|OPEN|ENTRY|ENTER/.test(a)) return "buy";
    return "other";
  }
  function dedupeKeys(ev) {
    const keys = [];
    if (ev?.lot_id) keys.push(`lot:${ev.lot_id}`);
    const sym = String(ev?.ticker || ev?.symbol || "").toUpperCase();
    const tsN = Number(ev?.ts ?? ev?.timestamp ?? 0);
    const tsMs = tsN > 1e12 ? tsN : tsN * 1000;
    if (sym) keys.push(`${scopeOf(ev, String(ev?.type || "").toUpperCase())}:${sym}:${actionClass(ev)}:${Math.floor(tsMs / 600000)}`);
    return keys;
  }
  function dedupeEvents(list) {
    const seen = new Set();
    const out = [];
    for (const ev of (Array.isArray(list) ? list : [])) {
      const keys = dedupeKeys(ev);
      if (keys.length && keys.some((k) => seen.has(k))) continue;
      for (const k of keys) seen.add(k);
      out.push(ev);
    }
    return out;
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

  // 2026-06-22 — scope tag so a reader can instantly tell whether a feed
  // entry is an Active Trader signal or an Investor signal (operator
  // request). Investor events carry type INVESTOR_SIGNAL or an
  // investor_alert_type / mode marker; everything else is trader-lane.
  function scopeOf(ev, t) {
    const mode = String(ev?.mode || "").toLowerCase();
    if (mode === "investor") return "investor";
    if (mode === "trader") return "trader";
    if (t === "INVESTOR_SIGNAL" || ev?.investor_alert_type) return "investor";
    const desk = String(ev?.desk || "").toLowerCase();
    if (desk === "investor") return "investor";
    return "trader";
  }

  function classifyInvestorExecution(ev) {
    const invT = String(ev?.investor_alert_type || "").toLowerCase();
    if (invT === "position_add") {
      return { cls: "ev-entry ev-doing", label: "ADD", evType: "ADD", scope: "investor", mode: "doing", execState: "done" };
    }
    if (invT === "position_trim") {
      return { cls: "ev-trim ev-doing", label: "TRIM", evType: "TRIM", scope: "investor", mode: "doing", execState: "done" };
    }
    if (invT === "position_close") {
      return { cls: "ev-exit ev-doing", label: "EXIT", evType: "EXIT", scope: "investor", mode: "doing", execState: "done" };
    }
    // Belt-and-braces: D1 lots always set action verb — parse when alert_type
    // is missing but mode/engine marks this as an executed investor lot.
    const modeRaw = String(ev?.mode || ev?.alert_class || ev?.engine || "").toLowerCase();
    const isInvLane = modeRaw === "investor" || modeRaw === "doing" || !!ev?.lot_id || ev?.source === "d1_lots";
    if (!isInvLane) return null;
    const act = String(ev?.action || "").toUpperCase();
    if (act.includes("EXIT")) {
      return { cls: "ev-exit ev-doing", label: "EXIT", evType: "EXIT", scope: "investor", mode: "doing", execState: "done" };
    }
    if (act.includes("TRIM")) {
      return { cls: "ev-trim ev-doing", label: "TRIM", evType: "TRIM", scope: "investor", mode: "doing", execState: "done" };
    }
    if (act.includes("ADD") && (Number(ev?.shares) > 0 || Number(ev?.qty) > 0)) {
      return { cls: "ev-entry ev-doing", label: "ADD", evType: "ADD", scope: "investor", mode: "doing", execState: "done" };
    }
    return null;
  }

  function resolveEvType(ev, c) {
    if (c && c.evType) return c.evType;
    const SG = window.TimedSignalGrammar;
    if (SG && typeof SG.investorEvType === "function") {
      const inv = SG.investorEvType(ev);
      if (inv) return inv;
    }
    const invT = String(ev?.investor_alert_type || "").toLowerCase();
    if (invT === "position_add") return "ADD";
    if (invT === "position_trim") return "TRIM";
    if (invT === "position_close") return "EXIT";
    return String(ev?.type || ev?.event || "").toUpperCase() || "EVENT";
  }

  function classifyEvent(ev) {
    const invExec = classifyInvestorExecution(ev);
    if (invExec) return invExec;
    const SG = window.TimedSignalGrammar;
    if (SG && typeof SG.classifyActivityEvent === "function") {
      const c = SG.classifyActivityEvent(ev);
      const evType = resolveEvType(ev, c);
      const invOverride = classifyInvestorExecution(ev);
      if (invOverride) return invOverride;
      const rawType = String(ev?.type || ev?.event || "").toUpperCase();
      const execFromEv = String(ev?.exec_state || ev?.execState || "").toLowerCase();
      const isExitRecommended = c.execState === "recommended"
        || execFromEv === "recommended"
        || rawType === "TRADE_EXIT_SIGNAL";
      const label = (c.label && c.label !== "UPDATE" && c.label !== "WATCH")
        ? c.label
        : (evType === "ADD" || evType === "TRIM" || evType === "EXIT" ? evType : (c.label || evType || "UPDATE"));
      return {
        cls: c.cls || (isExitRecommended ? "ev-exit ev-recommended ev-doing" : ""),
        label,
        evType,
        scope: c.scope || scopeOf(ev, String(ev?.type || "").toUpperCase()),
        mode: (c.mode === "doing" || evType === "ADD" || evType === "TRIM" || evType === "EXIT") ? "doing" : (c.mode || "doing"),
        execState: isExitRecommended
          ? "recommended"
          : ((c.execState === "done" || evType === "ADD" || evType === "TRIM" || evType === "EXIT") ? "done" : (c.execState || "done")),
      };
    }
    const t = String(ev?.type || ev?.event || "").toUpperCase();
    const scope = scopeOf(ev, t);
    if (t === "TRADE_ENTRY") return { cls: "ev-entry ev-doing", label: "ENTER", evType: "ENTRY", scope, mode: "doing", execState: "done" };
    if (t === "TRADE_EXIT_SIGNAL") return { cls: "ev-exit ev-recommended ev-doing", label: "EXIT", evType: "EXIT", scope, mode: "doing", execState: "recommended" };
    if (t === "TRADE_EXIT") return { cls: "ev-exit ev-doing", label: "EXIT", evType: "EXIT", scope, mode: "doing", execState: "done" };
    if (t === "TRADE_TRIM") return { cls: "ev-trim ev-doing", label: "TRIM", evType: "TRIM", scope, mode: "doing", execState: "done" };
    if (t === "INVESTOR_SIGNAL") {
      const invT = String(ev?.investor_alert_type || "").toLowerCase();
      if (invT === "position_close") {
        return { cls: "ev-exit ev-doing", label: "EXIT", evType: "EXIT", scope: "investor", mode: "doing", execState: "done" };
      }
      if (invT === "position_trim") {
        return { cls: "ev-trim ev-doing", label: "TRIM", evType: "TRIM", scope: "investor", mode: "doing", execState: "done" };
      }
      if (invT === "position_add") {
        return { cls: "ev-entry ev-doing", label: "ADD", evType: "ADD", scope: "investor", mode: "doing", execState: "done" };
      }
      const verb = String(ev?.action || "INVESTOR").toUpperCase().replace(/^MODEL\s*·\s*/, "");
      return { cls: "ev-entry", label: verb || "INVESTOR", evType: "INVESTOR_SIGNAL", scope: "investor", mode: "watching", execState: "watching" };
    }
    // D5 (2026-06-11) — resolution-time grading events belong on /alerts.html only.
    if (t === "ENTRY" || t === "ENTER") return { cls: "ev-entry", label: "ENTER", evType: "ENTRY", scope };
    if (t === "ADD" || t === "ADD_ENTRY") return { cls: "ev-entry", label: "ADD", evType: "ADD_ENTRY", scope };
    if (t === "TRIM" || t === "TP_HIT_TRIM") return { cls: "ev-trim", label: "TRIM", evType: "TRIM", scope };
    if (t === "EXIT" || t === "TP_HIT_EXIT" || t === "SL_HIT") return { cls: "ev-exit", label: "EXIT", evType: "EXIT", scope };
    return { cls: "", label: t || "EVENT", evType: t, scope };
  }

  function buildPillDetail(ev, meta) {
    const price = Number(ev?.price);
    const qty = Number(ev?.qty);
    const shares = Number(ev?.shares);
    const parts = [];
    const t = meta.evType;
    const shareN = Number.isFinite(shares) && shares > 0 ? shares : qty;
    if (t === "ENTRY" || t === "ADD_ENTRY" || t === "ADD" || t === "INVESTOR_SIGNAL") {
      if (Number.isFinite(price) && price > 0) {
        parts.push(shareN > 0 ? `${shareN % 1 === 0 ? shareN : shareN.toFixed(1)} sh @ ${fmtUsd(price)}` : `@ ${fmtUsd(price)}`);
      } else if (shareN > 0) {
        parts.push(`${shareN % 1 === 0 ? shareN : shareN.toFixed(1)} sh`);
      }
      const reason = shortReason(ev?.reason || ev?.action);
      if (reason) parts.push(reason);
      if (ev?.setup_grade) parts.push(String(ev.setup_grade));
      return parts.join(" · ");
    }
    if (t === "EXIT" || t === "TRIM") {
      if (shareN > 0) parts.push(`${shareN % 1 === 0 ? shareN : shareN.toFixed(1)} sh`);
      if (Number.isFinite(price) && price > 0) parts.push(`@ ${fmtUsd(price)}`);
      const remain = Number(ev?.remaining ?? ev?.remaining_shares ?? ev?.total_shares);
      if (Number.isFinite(remain) && remain >= 0 && t === "TRIM") parts.push(`${remain % 1 === 0 ? remain : remain.toFixed(1)} sh left`);
      const reason = shortReason(ev?.reason || ev?.action);
      if (reason) parts.push(reason);
      return parts.join(" · ");
    }
    if (Number.isFinite(price) && price > 0) parts.push(`@ ${fmtUsd(price)}`);
    if (ev?.setup_grade && (t === "ENTRY" || t === "ADD_ENTRY")) parts.push(String(ev.setup_grade));
    const reason = shortReason(ev?.reason);
    if (reason) parts.push(reason);
    return parts.join(" · ");
  }

  function isActionableActivityEvent(ev) {
    const SG = window.TimedSignalGrammar;
    const meta = classifyEvent(ev);
    if (SG && typeof SG.isActionableFeedEvent === "function") {
      return SG.isActionableFeedEvent(ev, meta);
    }
    const sym = String(ev?.ticker || ev?.symbol || "").toUpperCase();
    if (!sym || sym === "UNDEFINED" || sym === "NULL") return false;
    const t = String(ev?.type || ev?.event || "").toUpperCase();
    if (t === "SIGNAL_GRADED") return false;
    if (t === "TRADE_EXIT_SIGNAL") return true;
    const traderTypes = new Set([
      "ENTRY", "ENTER", "ADD", "ADD_ENTRY", "TRIM", "TP_HIT_TRIM",
      "EXIT", "TP_HIT_EXIT", "SL_HIT",
      "TRADE_ENTRY", "TRADE_TRIM", "TRADE_EXIT",
    ]);
    if (traderTypes.has(t)) return true;
    const invT = String(ev?.investor_alert_type || "").toLowerCase();
    if (invT === "position_open" || invT === "position_add" || invT === "position_trim" || invT === "position_close") return true;
    if (t === "INVESTOR_SIGNAL") {
      const act = String(ev?.action || "").toUpperCase();
      if (act.includes("ON RADAR") || act.includes("WATCH") || act.includes("INFO")) return false;
      if (act.includes("QUEUE") || act.includes("ACCUMULATE") || act.includes("BOUGHT")
          || act.includes("REDUCE") || act.includes("REVIEW")) return true;
      return meta.mode === "doing" && meta.label !== "WATCH";
    }
    return false;
  }

  function openActivityEvent(ev, sym, meta) {
    const ticker = String(sym || "").toUpperCase();
    if (!ticker) return;
    const tradeId = ev?.trade_id || ev?.tradeId || null;
    const payload = {
      ticker,
      tradeId,
      evType: meta.evType,
      scope: meta.scope,
      activityEvent: ev,
      source: "activity-strip",
    };
    if (typeof window.ttOpenActivityInRail === "function") {
      window.ttOpenActivityInRail(payload);
      return;
    }
    const initialRailTab = typeof window.ttResolveActivityRailTab === "function"
      ? window.ttResolveActivityRailTab(ev, { scope: meta.scope, evType: meta.evType })
      : "HISTORY";
    if (typeof window.ttOpenTickerInRail === "function") {
      window.ttOpenTickerInRail({ ...payload, initialRailTab });
    } else {
      window.dispatchEvent(new CustomEvent("tt-open-ticker", {
        detail: { ...payload, initialRailTab, openAutopsy: initialRailTab === "HISTORY" },
        bubbles: true,
      }));
    }
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
    const arr = (Array.isArray(events) ? events : [])
      .filter(isActionableActivityEvent)
      .slice();
    arr.sort((a, b) => {
      const norm = (x) => { const n = Number(x?.ts ?? x?.timestamp ?? 0); return n > 1e12 ? n : n * 1000; };
      return norm(b) - norm(a);
    });
    // Collapse cross-channel duplicates (D1 lot + KV signal append) — sorted
    // newest-first so the freshest copy of an action wins.
    const visible = dedupeEvents(arr).slice(0, 20);

    if (!host._row) {
      const inner = document.createElement("div");
      inner.className = "tt-activity-strip__inner";
      const label = document.createElement("span");
      label.className = "tt-activity-strip__label";
      label.textContent = "Recent activity";
      const hint = document.createElement("span");
      hint.className = "tt-activity-strip__hint";
      hint.textContent = "Mode · action · ticker · bias · size @ price · when · why";
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
      empty.textContent = "No recent model actions.";
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
      pill.className = `tt-activity-pill ${meta.cls}${meta.mode === "watching" ? " ev-watching" : " ev-doing"}`;
      pill.dataset.scope = meta.scope === "investor" ? "investor" : "trader";
      const actionLabel = normalizeDisplayAction(meta);
      const scopeLabel = scopeDisplayLabel(meta.scope);
      pill.title = [scopeLabel, actionLabel, sym, dir, detail, fmtClock(ts)].filter(Boolean).join(" · ");

      const scopeEl = document.createElement("span");
      scopeEl.className = `ev-scope ev-scope--${meta.scope === "investor" ? "investor" : "trader"}`;
      scopeEl.textContent = scopeLabel;
      pill.appendChild(scopeEl);

      const typeEl = document.createElement("span");
      typeEl.className = "ev-type";
      typeEl.textContent = actionLabel;
      pill.appendChild(typeEl);
      if (sym) {
        pill.appendChild(buildTickerLogo(sym));
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
    const endpoint = "/timed/activity";
    const fetchLimit = 50;
    try {
      const r = await fetch(`${API_BASE}${endpoint}?limit=${fetchLimit}&_t=${Date.now()}`, { cache: "no-store", credentials: "include" });
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
    // Re-render once signal grammar loads (auth-gate injects it async).
    let _grammarPoll = 0;
    const grammarPoll = setInterval(() => {
      if (window.TimedSignalGrammar && host) {
        clearInterval(grammarPoll);
        refresh(host);
      }
      if (++_grammarPoll > 60) clearInterval(grammarPoll);
    }, 100);
    setInterval(() => { if (document.visibilityState !== "hidden") refresh(host); }, 60000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(host); });
    return host;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();

// cache-bust:1782734360422:721097512
