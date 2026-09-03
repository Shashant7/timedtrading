/**
 * MTF EMA-cloud chips for ticker cards and Right Rail.
 * Uses Ripster-style clouds we compute on tf_tech:
 *   1H 34/50  (Ripster 1HR 50/34)
 *   D  20/21  (daily support — key for reclaim / support setups)
 *   D  50/55  (daily structure)
 * Direction = price vs cloud (above ↑ / below ↓ / in-cloud ·).
 */
(function () {
  if (typeof window === "undefined") return;

  let _data = null;

  const READS = [
    { id: "1h_34_50", label: "1H EMA", title: "1-hour 34/50 EMA cloud (Ripster) — ↑ above, ↓ below, · inside", tfKeys: ["1H", "60"], cloud: "c34_50" },
    { id: "d_20_21", label: "D 21 EMA", title: "Daily 20/21 EMA cloud — ↑ above, ↓ below, · inside", tfKeys: ["D"], cloud: "c20_21", fallbackCloud: "c34_50" },
    { id: "d_50_55", label: "D 55 EMA", title: "Daily 50/55 EMA cloud — ↑ above, ↓ below, · inside", tfKeys: ["D"], cloud: "c50_55", fallbackCloud: "c72_89" },
  ];

  function setData(map) {
    _data = map && typeof map === "object" ? map : null;
  }

  function resolveTicker(sym, explicit) {
    if (explicit && typeof explicit === "object") return explicit;
    const T = String(sym || "").toUpperCase();
    if (!T || !_data) return null;
    return _data[T] || _data[sym] || null;
  }

  function tfRipster(ticker, tfKeys) {
    const tech = ticker?.tf_tech;
    if (!tech || typeof tech !== "object") return null;
    for (const k of tfKeys) {
      const rt = tech[k]?.ripster;
      if (rt) return rt;
    }
    return null;
  }

  function resolveCloud(rt, spec) {
    if (!rt) return null;
    const primary = rt[spec.cloud];
    if (primary && typeof primary === "object") return primary;
    if (spec.fallbackCloud) {
      const fb = rt[spec.fallbackCloud];
      if (fb && typeof fb === "object") return fb;
    }
    return null;
  }

  function cloudDir(cloud) {
    if (!cloud || typeof cloud !== "object") return null;
    if (cloud.above === true) return "up";
    if (cloud.below === true) return "dn";
    if (cloud.inCloud === true) return "flat";
    if (cloud.bull === true) return "up";
    if (cloud.bear === true) return "dn";
    return null;
  }

  function arrowFor(dir) {
    if (dir === "up") return "\u2191";
    if (dir === "dn") return "\u2193";
    if (dir === "flat") return "\u00b7";
    return "";
  }

  function chipClass(dir) {
    if (dir === "up") return "ds-chip ds-chip--sm ds-chip--up tt-mtf-chip";
    if (dir === "dn") return "ds-chip ds-chip--sm ds-chip--dn tt-mtf-chip";
    return "ds-chip ds-chip--sm ds-chip--solid tt-mtf-chip";
  }

  function readsForTicker(ticker) {
    if (!ticker || typeof ticker !== "object") return [];
    const out = [];
    for (const spec of READS) {
      const rt = tfRipster(ticker, spec.tfKeys);
      const cloud = resolveCloud(rt, spec);
      const dir = cloudDir(cloud);
      if (!dir) continue;
      const dist = Number(cloud?.distToCloudPct);
      const distBit = Number.isFinite(dist) && dist > 0
        ? ` · ${dir === "up" ? "+" : dir === "dn" ? "\u2212" : ""}${(dist * 100).toFixed(2)}% from cloud`
        : "";
      out.push({
        id: spec.id,
        label: `${spec.label} ${arrowFor(dir)}`.trim(),
        dir,
        title: `${spec.title} — price ${dir === "up" ? "above" : dir === "dn" ? "below" : "inside"}${distBit}`,
      });
    }
    return out;
  }

  function stackRead(reads) {
    if (!reads.length) return null;
    let up = 0;
    let dn = 0;
    for (const r of reads) {
      if (r.dir === "up") up += 1;
      else if (r.dir === "dn") dn += 1;
    }
    if (up >= 2 && up > dn) {
      return {
        id: "mtf_stack",
        label: `MTF ${up}/${reads.length} ${arrowFor("up")}`,
        dir: "up",
        title: `${up} of ${reads.length} timeframe EMA clouds above price — stack leans long`,
      };
    }
    if (dn >= 2 && dn > up) {
      return {
        id: "mtf_stack",
        label: `MTF ${dn}/${reads.length} ${arrowFor("dn")}`,
        dir: "dn",
        title: `${dn} of ${reads.length} timeframe EMA clouds below price — stack leans short`,
      };
    }
    if (up === reads.length && up >= 2) {
      return {
        id: "mtf_stack",
        label: `MTF ${up}/${reads.length} ${arrowFor("up")}`,
        dir: "up",
        title: "All tracked EMA clouds are above price",
      };
    }
    if (dn === reads.length && dn >= 2) {
      return {
        id: "mtf_stack",
        label: `MTF ${dn}/${reads.length} ${arrowFor("dn")}`,
        dir: "dn",
        title: "All tracked EMA clouds are below price",
      };
    }
    return {
      id: "mtf_stack",
      label: `MTF mix ${arrowFor("flat")}`,
      dir: "flat",
      title: `Mixed stack — ${up} clouds above, ${dn} below (${reads.length} tracked)`,
    };
  }

  function getReads(sym, opts) {
    const ticker = resolveTicker(sym, opts?.ticker);
    return readsForTicker(ticker);
  }

  function buildChipElements(sym, h, opts) {
    if (!h) return [];
    const ticker = resolveTicker(sym, opts?.ticker);
    const reads = readsForTicker(ticker);
    if (!reads.length) return [];
    const max = Number(opts?.max) > 0 ? Number(opts.max) : 4;
    const includeStack = opts?.stack !== false;
    const items = includeStack ? reads.concat([stackRead(reads)].filter(Boolean)) : reads;
    return items.slice(0, max).map((r) =>
      h("span", {
        key: `mtf-${r.id}`,
        className: chipClass(r.dir),
        title: r.title,
        style: {
          fontFamily: "var(--tt-font-mono)",
          fontSize: 9,
          letterSpacing: "0.02em",
          fontWeight: 700,
        },
      }, r.label),
    );
  }

  window.TimedMtfChips = {
    setData,
    getReads,
    readsForTicker,
    buildChipElements,
    READS,
  };
})();

// cache-bust:1788471754027:378307341
