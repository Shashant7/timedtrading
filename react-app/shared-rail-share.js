/* shared-rail-share.js — Right-rail share with screenshot + tab deep link */
(function () {
  if (typeof window === "undefined") return;

  const TAB_LABELS = {
    SNAPSHOT: "Snapshot",
    SETUP: "Setup",
    OPTIONS: "Options",
    INVESTOR: "Investor",
    TECHNICALS: "Technicals",
    FUNDAMENTALS: "Fundamentals",
    CATALYSTS: "Catalysts",
    HISTORY: "History",
    CHART: "Chart",
    ANALYSIS: "Snapshot",
  };

  function tabLabel(railTab) {
    const k = String(railTab || "SNAPSHOT").toUpperCase();
    return TAB_LABELS[k] || k.charAt(0) + k.slice(1).toLowerCase();
  }

  function shareBasePath() {
    const p = String(window.location.pathname || "");
    if (p.endsWith(".html")) return p;
    return "/today.html";
  }

  function buildShareUrl(ticker, railTab) {
    const sym = String(ticker || "").trim().toUpperCase();
    const u = new URL(shareBasePath(), window.location.origin);
    if (sym) u.searchParams.set("ticker", sym);
    const tab = String(railTab || "").trim().toUpperCase();
    if (tab) u.searchParams.set("railTab", tab);
    return u.toString();
  }

  function findRailRoot() {
    return document.querySelector("[data-tt-rail-root]")
      || document.querySelector(".tt-rail-shell")
      || document.querySelector(".tt-rail-mobile");
  }

  function toast(msg) {
    try {
      const t = document.createElement("div");
      t.textContent = msg;
      t.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--ds-bg-canvas,#0B1410);color:var(--ds-text-display,#fff);border:1px solid var(--ds-stroke,rgba(255,255,255,0.12));border-radius:8px;padding:8px 14px;font-size:12px;font-family:var(--tt-font-mono,monospace);z-index:99999;box-shadow:0 8px 32px rgba(0,0,0,0.5)";
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 1800);
    } catch (_) { /* noop */ }
  }

  let _html2canvasPromise = null;
  function loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (_html2canvasPromise) return _html2canvasPromise;
    _html2canvasPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
      s.async = true;
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => reject(new Error("html2canvas_load_failed"));
      document.head.appendChild(s);
    });
    return _html2canvasPromise;
  }

  async function captureRailScreenshot(root) {
    const html2canvas = await loadHtml2Canvas();
    const bg = getComputedStyle(root).backgroundColor;
    const canvas = await html2canvas(root, {
      backgroundColor: bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "#0B1410",
      scale: Math.min(2, window.devicePixelRatio || 1.5),
      useCORS: true,
      logging: false,
      scrollX: 0,
      scrollY: -window.scrollY,
      height: Math.min(root.scrollHeight, 2800),
      windowHeight: Math.min(root.scrollHeight, 2800),
    });
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png", 0.92));
  }

  async function shareRail(opts) {
    const sym = String(opts?.ticker || "").trim().toUpperCase();
    if (!sym) return { ok: false, reason: "no_ticker" };

    const railTab = String(opts?.railTab || opts?.tab || "SNAPSHOT").toUpperCase();
    const label = tabLabel(railTab);
    const url = buildShareUrl(sym, railTab);
    const title = `${sym} — ${label} — Timed Trading`;
    const text = `${sym} on Timed Trading (${label} tab)`;

    let blob = null;
    const root = findRailRoot();
    if (root) {
      try {
        blob = await captureRailScreenshot(root);
      } catch (e) {
        console.warn("[TimedRailShare] screenshot failed", e);
      }
    }

    try {
      if (blob && navigator.share) {
        const file = new File([blob], `${sym}-${railTab}.png`, { type: "image/png" });
        const withFiles = { title, text, url, files: [file] };
        if (!navigator.canShare || navigator.canShare(withFiles)) {
          await navigator.share(withFiles);
          return { ok: true, mode: "share-with-image" };
        }
      }
      if (navigator.share) {
        await navigator.share({ title, text, url });
        return { ok: true, mode: "share-link" };
      }
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, aborted: true };
    }

    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast(blob ? "Link copied" : "Link copied (screenshot not supported here)");
      return { ok: true, mode: "clipboard" };
    } catch (_) {
      toast("Could not share");
      return { ok: false, reason: "share_failed" };
    }
  }

  window.TimedRailShare = {
    shareRail,
    buildShareUrl,
    tabLabel,
    TAB_LABELS,
  };
})();
