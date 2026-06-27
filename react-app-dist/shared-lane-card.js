// shared-lane-card.js — compact lane card layout (meta left, quote right, save bottom-right).
// Used by Active Trader lanes, Today Viewport, and Investor kanban for visual parity.
(function () {
  if (typeof window === "undefined") return;

  function boot() {
    const React = window.React;
    if (!React) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot, { once: true });
      } else {
        setTimeout(boot, 0);
      }
      return;
    }
    if (window.TTLaneCard) return;
    register(React);
  }

  function register(React) {
  const h = React.createElement;

  function compactBiasLabel(label) {
    const s = String(label || "");
    if (s === "Leaning bullish") return "Lean Bull";
    if (s === "Leaning bearish") return "Lean Bear";
    return s;
  }

  function extLineFromTicker(t) {
    try {
      const ext = window.TimedPriceUtils?.getExtChange?.(t);
      if (!ext) return null;
      return { ext, dir: ext.pct >= 0 ? "up" : "dn" };
    } catch (_) { return null; }
  }

  function logoRef(sym) {
    return (el) => {
      if (el && !el.dataset.dsInit && window.DS) {
        el.dataset.dsInit = "1";
        try { el.replaceWith(window.DS.tickerLogo(sym, { size: 22 })); } catch (_) {}
      }
    };
  }

  function quoteColumn({ price, dayPct, dayChg, dir, extLine }) {
    const d = dir || "flat";
    return h("div", { className: "tt-lane-card__quote" },
      h("div", { className: "tt-lane-card__price" },
        Number.isFinite(price) ? `$${price.toFixed(2)}` : "—",
      ),
      dayPct != null && h("div", {
        className: `tt-lane-card__change ds-tickercard__change--${d}`,
        title: Number.isFinite(dayChg) ? `${dayChg >= 0 ? "+" : ""}$${Math.abs(dayChg).toFixed(2)}` : undefined,
      },
        d === "up" ? "▲" : d === "dn" ? "▼" : "◆",
        `${dayPct >= 0 ? "+" : ""}${Number(dayPct).toFixed(2)}%`,
      ),
      extLine && h("div", {
        className: `tt-lane-card__ext ds-tickercard__change--${extLine.dir}`,
      },
        h("span", {
          className: "tt-lane-card__ext-tag",
        }, "EXT"),
        extLine.ext.price != null ? `$${extLine.ext.price.toFixed(2)} ` : "",
        `${extLine.ext.pct >= 0 ? "+" : ""}${extLine.ext.pct.toFixed(2)}%`,
      ),
    );
  }

  function saveButton({ sym, isSaved, onToggleSaved }) {
    if (!onToggleSaved) return null;
    return h("button", {
      onClick: (e) => { e.preventDefault(); e.stopPropagation(); onToggleSaved(sym); },
      className: "ds-chip ds-chip--sm tt-lane-card__save",
      style: {
        color: isSaved ? "var(--ds-accent)" : "var(--ds-text-muted)",
        background: isSaved ? "var(--ds-accent-dim)" : "transparent",
        borderColor: isSaved ? "var(--ds-accent)" : "var(--ds-stroke)",
      },
      title: isSaved ? "Saved — click to unsave" : "Save ticker",
      "aria-label": isSaved ? "Unsave ticker" : "Save ticker",
    }, isSaved ? "★" : "☆");
  }

  function create(p) {
    const sym = String(p.sym || "").toUpperCase();
    const chips = Array.isArray(p.chipRow) ? p.chipRow.filter(Boolean) : [];
    const metrics = Array.isArray(p.metrics) ? p.metrics.filter(Boolean) : [];
    const showFoot = metrics.length > 0 || !!p.onToggleSaved;

    return h("button", {
      onClick: p.button?.onClick,
      onKeyDown: p.button?.onKeyDown,
      className: `ds-tickercard tt-lane-card${p.button?.className ? ` ${p.button.className}` : ""}`,
      style: p.button?.style,
      title: p.button?.title,
    },
      h("div", { className: "tt-lane-card__main" },
        h("div", { className: "tt-lane-card__meta" },
          h("div", { className: "tt-lane-card__identity" },
            h("div", {
              className: "ds-tickercard__logo",
              ref: logoRef(sym),
              style: { width: 22, height: 22 },
            }, sym.slice(0, 2)),
            h("span", { className: "ds-tickercard__symbol", style: { fontSize: 13 } }, sym),
            p.isTTSel && h("span", {
              title: "TT Selected",
              className: "tt-lane-card__ttsel",
            }),
            p.identityExtra || null,
          ),
          chips.length > 0 && h("div", { className: "tt-lane-card__chips" }, ...chips),
        ),
        quoteColumn(p.quote || {}),
      ),
      p.midBody ? h("div", { className: "tt-lane-card__mid" }, p.midBody) : null,
      p.sparkSvg && h("div", {
        className: "ds-tickercard__spark",
        dangerouslySetInnerHTML: { __html: p.sparkSvg },
      }),
      showFoot && h("div", { className: "tt-lane-card__foot" },
        h("div", { className: "tt-lane-card__metrics" }, ...metrics),
        saveButton({ sym, isSaved: p.isSaved, onToggleSaved: p.onToggleSaved }),
      ),
    );
  }

  window.TTLaneCard = {
    create,
    compactBiasLabel,
    extLineFromTicker,
    logoRef,
    quoteColumn,
    saveButton,
  };
  }

  boot();
})();

// cache-bust:1782599674979:478461006
