// shared-lane-card.js — compact lane card layout (meta left, quote right, rank/score + save bottom bar).
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

  function traderRankScore(t) {
    const TT = window.TimedBubbleChart || {};
    const score = (() => {
      try {
        const dyn = TT.rankScoreForTicker ? Number(TT.rankScoreForTicker(t)) : NaN;
        if (Number.isFinite(dyn) && dyn !== 0) return Math.round(dyn);
      } catch (_) {}
      const fallback = Number(t?.score ?? t?.rank);
      return Number.isFinite(fallback) && fallback !== 0 ? Math.round(fallback) : null;
    })();
    const rank = Number(t?.rank_position ?? t?.rp) || null;
    return { rank, score };
  }

  function sparkClosesFromEntry(entry) {
    if (Array.isArray(entry)) return entry;
    if (entry && Array.isArray(entry.closes)) return entry.closes;
    return null;
  }

  function sparkSvgFromCache(sym, price, dir, sparkCache, ensureSpark) {
    const upper = String(sym || "").toUpperCase();
    if (typeof ensureSpark === "function") ensureSpark(upper);
    const entry = sparkCache && sparkCache[upper];
    const closes = sparkClosesFromEntry(entry);
    const points = (closes && closes.length >= 2) ? closes : [price || 0, price || 0];
    if (window.DS && Number.isFinite(price) && price > 0) {
      return window.DS.sparklineSvg(points, {
        width: 280,
        height: 44,
        direction: dir || "flat",
        strokeWidth: 1.4,
      });
    }
    return "";
  }

  function fmtZonePx(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return `$${v.toFixed(v >= 100 ? 0 : 2)}`;
  }

  /** INV / PB / TGT plan bar — Active Trader position-track styling with zone shading. */
  function zoneBarTrack(zm, opts) {
    opts = opts || {};
    if (!zm || typeof zm.pct !== "function") return null;
    const compact = !!opts.compact;
    const pbLo = zm.pb ? zm.pb[0] : zm.pbLo;
    const pbHi = zm.pb ? zm.pb[1] : zm.pbHi;
    const pbLoPct = zm.pct(pbLo);
    const pbHiPct = zm.pct(pbHi);
    const pricePct = zm.pct(zm.price);
    const invPct = zm.pct(zm.inv);
    const tgtPct = zm.pct(zm.tgt);
    const pbMid = (Number(pbLo) + Number(pbHi)) / 2;
    const pbMidPct = zm.pct(pbMid);
    const laneLabel = zm.lane === "investor" ? "INVESTOR" : zm.lane === "trader" ? "TRADER" : null;

    const ticks = [
      { pct: invPct, label: "INV", color: "var(--ds-dn)", px: zm.inv },
      { pct: pbMidPct, label: "PB", color: "var(--ds-up)", px: pbMid },
      { pct: tgtPct, label: "TGT", color: "var(--ds-accent)", px: zm.tgt },
    ].sort((a, b) => a.pct - b.pct);

    const fillStart = Math.min(pbMidPct, pricePct);
    const fillW = Math.abs(pricePct - pbMidPct);
    const fillBg = pricePct >= pbLoPct && pricePct <= pbHiPct
      ? "var(--ds-up-bg)"
      : pricePct > pbHiPct
        ? "rgba(245,194,92,0.14)"
        : "var(--ds-dn-bg)";

    return h("div", { className: "tt-zone-plan" + (compact ? " tt-zone-plan--compact" : "") },
      !compact && laneLabel && h("div", { className: "tt-zone-bar__lane-row" },
        h("span", {
          className: "tt-zone-bar__lane tt-zone-bar__lane--" + (zm.lane === "investor" ? "investor" : "trader"),
        }, laneLabel),
        h("span", null, opts.planLabel || (zm.lane === "investor" ? "Buy zone plan" : "Trader plan")),
      ),
      h("div", { className: "tt-lane-card__position tt-zone-plan__bar" },
        h("div", { className: "tt-lane-card__pos-track" },
          h("div", {
            className: "tt-zone-plan__shade tt-zone-plan__shade--inv",
            style: { left: "0%", width: `${pbLoPct}%` },
          }),
          h("div", {
            className: "tt-zone-plan__shade tt-zone-plan__shade--pb",
            style: { left: `${pbLoPct}%`, width: `${Math.max(0, pbHiPct - pbLoPct)}%` },
          }),
          h("div", {
            className: "tt-zone-plan__shade tt-zone-plan__shade--tgt",
            style: { left: `${pbHiPct}%`, width: `${Math.max(0, 100 - pbHiPct)}%` },
          }),
          fillW > 0.4 && h("div", {
            className: "tt-zone-plan__fill",
            style: {
              left: `${fillStart}%`,
              width: `${fillW}%`,
              background: fillBg,
            },
          }),
          ...ticks.map((tick, i) => h("div", {
            key: "tick-" + i,
            className: "tt-zone-plan__tick",
            style: { left: `${tick.pct}%` },
            title: `${tick.label}: ${fmtZonePx(tick.px)}`,
          },
            h("div", { className: "tt-zone-plan__tick-line", style: { background: tick.color } }),
          )),
          h("div", {
            className: "tt-zone-plan__dot",
            style: { left: `${pricePct}%` },
            title: `Live ${fmtZonePx(zm.price)}`,
          }),
        ),
        h("div", { className: "tt-lane-card__pos-labels" },
          ...ticks.map((tick, i) => h("span", {
            key: "lbl-" + i,
            className: "tt-zone-plan__tick-label",
            style: { left: `${tick.pct}%`, color: tick.color },
            title: `${tick.label}: ${fmtZonePx(tick.px)}`,
          }, tick.label)),
        ),
      ),
    );
  }

  /** Price levels row — sits below the lane card in the strip stack. */
  function zoneBarMeta(zm, opts) {
    opts = opts || {};
    if (!zm) return null;
    const pbLo = zm.pb ? zm.pb[0] : zm.pbLo;
    const pbHi = zm.pb ? zm.pb[1] : zm.pbHi;
    const fmtProb = (p) => (Number.isFinite(Number(p)) ? `${Math.round(Number(p) * 100)}%` : null);
    const invProb = fmtProb(zm.invProb);
    const tgtProb = fmtProb(zm.tgtProb);
    const laneTag = opts.laneTag && zm.lane
      ? h("span", {
          className: "tt-zone-bar__lane tt-zone-bar__lane--" + (zm.lane === "investor" ? "investor" : "trader"),
        }, zm.lane === "investor" ? "INV" : "AT")
      : null;
    return h("div", { className: "tt-zone-bar__meta" + (laneTag ? " tt-zone-bar__meta--tagged" : "") },
      laneTag,
      h("span", null, `Inv ${fmtZonePx(zm.inv)}`, invProb && h("span", { className: "tt-zone-bar__prob" }, ` · ${invProb} hit`)),
      h("span", null, `PB ${fmtZonePx(pbLo)}\u2013${fmtZonePx(pbHi)}`),
      h("span", null, `Tgt ${fmtZonePx(zm.tgt)}`, tgtProb && h("span", { className: "tt-zone-bar__prob" }, ` · ${tgtProb} reach`)),
      opts.extraMeta || null,
    );
  }

  function rankScoreMetricChips(opts) {
    const {
      rank,
      score,
      scoreUpAt = 100,
      scoreAccentAt = 75,
      rankTitle,
      scoreTitle,
    } = opts || {};
    const chips = [];
    if (rank != null) {
      chips.push(h("span", {
        className: `ds-chip ds-chip--sm ${rank <= 10 ? "ds-chip--up" : rank <= 30 ? "ds-chip--accent" : ""}`,
        style: { fontFamily: "var(--tt-font-mono)" },
        title: rankTitle || `Rank position: ${rank} of all eligible tickers (1 = best).`,
      }, `R${rank}`));
    }
    if (score != null) {
      chips.push(h("span", {
        className: `ds-chip ds-chip--sm ${score >= scoreUpAt ? "ds-chip--up" : score >= scoreAccentAt ? "ds-chip--accent" : ""}`,
        style: { fontFamily: "var(--tt-font-mono)" },
        title: scoreTitle || `Score: ${Math.round(score)} (composite alignment, higher = better).`,
      }, `S${Math.round(score)}`));
    }
    return chips;
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
    const hasMid = !!p.midBody;
    const extraClass = p.button?.className ? ` ${p.button.className}` : "";

    return h("button", {
      onClick: p.button?.onClick,
      onKeyDown: p.button?.onKeyDown,
      className: `ds-tickercard tt-lane-card${hasMid ? " tt-lane-card--active" : ""}${extraClass}`,
      style: p.button?.style,
      title: p.button?.title,
    },
      p.sparkSvg && h("div", {
        className: "ds-tickercard__spark",
        dangerouslySetInnerHTML: { __html: p.sparkSvg },
      }),
      h("div", { className: "tt-lane-card__main" },
        p.topBanner && h("div", { className: "tt-lane-card__top-banner" }, p.topBanner),
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
          h("div", { className: "tt-lane-card__chips" }, ...(chips.length ? chips : [])),
        ),
        quoteColumn(p.quote || {}),
      ),
      hasMid && h("div", { className: "tt-lane-card__mid" }, p.midBody),
      h("div", { className: "tt-lane-card__bar" },
        metrics.length > 0 && h("div", { className: "tt-lane-card__metrics" }, ...metrics),
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
    traderRankScore,
    rankScoreMetricChips,
    sparkSvgFromCache,
    zoneBarTrack,
    zoneBarMeta,
  };
  }

  boot();
})();

// cache-bust:1783488750566:536963406
