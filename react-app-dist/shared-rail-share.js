/* shared-rail-share.js — Right-rail share with branded screenshot + tab deep link */
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

  /** Shared links always land on Today so recipients sign in and open the rail. */
  function buildShareUrl(ticker, railTab) {
    const sym = String(ticker || "").trim().toUpperCase();
    const u = new URL("/today.html", window.location.origin);
    if (sym) u.searchParams.set("ticker", sym);
    const tab = String(railTab || "").trim().toUpperCase();
    if (tab) u.searchParams.set("railTab", tab);
    return u.toString();
  }

  function buildShareText(sym, label, url) {
    return [
      `${sym} · ${label} tab on Timed Trading`,
      "",
      "Open the link to sign in and view the full setup:",
      url,
    ].join("\n");
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

  let _logoPromise = null;
  function loadLogoImage() {
    if (_logoPromise) return _logoPromise;
    _logoPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("logo_load_failed"));
      img.src = "/apple-touch-icon.png";
    });
    return _logoPromise;
  }

  function blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("screenshot_decode_failed"));
      };
      img.src = url;
    });
  }

  /**
   * Wrap the rail screenshot in a branded share card: logo header, tab
   * context line, screenshot body, footer watermark + link hint.
   */
  async function composeShareCard(screenshotBlob, { sym, label, url }) {
    const [shot, logo] = await Promise.all([
      blobToImage(screenshotBlob),
      loadLogoImage().catch(() => null),
    ]);

    const maxW = 720;
    const scale = shot.width > maxW ? maxW / shot.width : 1;
    const shotW = Math.round(shot.width * scale);
    const shotH = Math.round(shot.height * scale);

    const pad = 14;
    const headerH = 56;
    const footerH = 44;
    const w = shotW + pad * 2;
    const h = headerH + shotH + footerH + pad;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return screenshotBlob;

    ctx.fillStyle = "#0B1410";
    ctx.fillRect(0, 0, w, h);

    // Header band
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fillRect(0, 0, w, headerH);
    ctx.strokeStyle = "rgba(56,242,161,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, headerH - 0.5);
    ctx.lineTo(w, headerH - 0.5);
    ctx.stroke();

    const logoSize = 32;
    if (logo) {
      ctx.drawImage(logo, pad, (headerH - logoSize) / 2, logoSize, logoSize);
    }

    ctx.fillStyle = "#F0FDF4";
    ctx.font = "600 15px Inter, system-ui, sans-serif";
    ctx.fillText("Timed Trading", pad + logoSize + 10, 22);

    ctx.fillStyle = "#38F2A1";
    ctx.font = "600 12px JetBrains Mono, ui-monospace, monospace";
    ctx.fillText(`${sym} · ${label} tab`, pad + logoSize + 10, 40);

    // Screenshot with subtle inset border
    ctx.drawImage(shot, pad, headerH, shotW, shotH);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.strokeRect(pad + 0.5, headerH + 0.5, shotW - 1, shotH - 1);

    // Footer watermark
    const footY = headerH + shotH;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, footY, w, footerH + pad);
    ctx.fillStyle = "#38F2A1";
    ctx.font = "600 11px Inter, system-ui, sans-serif";
    ctx.fillText("Open link for full view · Sign in required", pad, footY + 18);

    ctx.fillStyle = "#6E867D";
    ctx.font = "500 10px JetBrains Mono, ui-monospace, monospace";
    const shortUrl = String(url || "").replace(/^https?:\/\//, "");
    if (shortUrl) {
      const clip = shortUrl.length > 48 ? `${shortUrl.slice(0, 45)}…` : shortUrl;
      ctx.fillText(clip, pad, footY + 32);
    }

    if (logo) {
      ctx.globalAlpha = 0.45;
      ctx.drawImage(logo, w - pad - 20, footY + 10, 20, 20);
      ctx.globalAlpha = 1;
    }

    return new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b || screenshotBlob), "image/png", 0.92);
    });
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
    const text = buildShareText(sym, label, url);

    let blob = null;
    const root = findRailRoot();
    if (root) {
      try {
        const raw = await captureRailScreenshot(root);
        if (raw) {
          blob = await composeShareCard(raw, { sym, label, url });
        }
      } catch (e) {
        console.warn("[TimedRailShare] screenshot failed", e);
      }
    }

    try {
      if (blob && navigator.share) {
        const file = new File([blob], `${sym}-${railTab}-timed-trading.png`, { type: "image/png" });
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
      await navigator.clipboard.writeText(text);
      toast("Link copied — open to sign in and view full setup");
      return { ok: true, mode: "clipboard" };
    } catch (_) {
      toast("Could not share");
      return { ok: false, reason: "share_failed" };
    }
  }

  window.TimedRailShare = {
    shareRail,
    buildShareUrl,
    buildShareText,
    tabLabel,
    TAB_LABELS,
    composeShareCard,
  };
})();

// cache-bust:1782686018458:97707811
