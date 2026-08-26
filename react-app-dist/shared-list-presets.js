/**
 * Ripster-style list presets + upticks sync for ticker cards and Right Rail.
 * Loads GET /timed/list-presets (presets + KV upticks).
 */
(function () {
  if (typeof window === "undefined") return;

  const API_PATH = "/timed/list-presets";
  let _loaded = false;
  let _loading = null;
  const _presetMap = {};
  const _upticks = new Set();

  function norm(sym) {
    let v = String(sym || "").trim().toUpperCase();
    if (v === "BRK.B") v = "BRK-B";
    return v;
  }

  function ingest(data) {
    if (!data || !data.ok) return;
    for (const p of (data.presets || [])) {
      const id = String(p.id || "").trim();
      if (!id) continue;
      _presetMap[id] = {
        id,
        label: String(p.label || id),
        tickers: new Set((p.tickers || []).map(norm).filter(Boolean)),
      };
    }
    _upticks.clear();
    for (const t of (data.upticks || [])) {
      const s = norm(t);
      if (s) _upticks.add(s);
    }
    _loaded = true;
  }

  async function load(apiBase) {
    if (_loaded) return;
    if (_loading) return _loading;
    const base = String(apiBase || "").replace(/\/$/, "");
    const url = base ? `${base}${API_PATH}` : API_PATH;
    _loading = fetch(url, { credentials: "include", cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { ingest(j); })
      .catch(() => { _loaded = true; })
      .finally(() => { _loading = null; });
    return _loading;
  }

  function getUpticksSet() {
    return new Set(_upticks);
  }

  function applyUpticksToGroups(groups) {
    if (!groups || !_upticks.size) return;
    groups.UPTICKS = new Set(_upticks);
  }

  function getPresetsForTicker(sym) {
    const T = norm(sym);
    if (!T) return [];
    const out = [];
    for (const p of Object.values(_presetMap)) {
      if (p.tickers.has(T)) out.push({ id: p.id, label: p.label });
    }
    return out;
  }

  function isInPreset(sym, presetId) {
    const p = _presetMap[String(presetId || "")];
    return p ? p.tickers.has(norm(sym)) : false;
  }

  function buildChipElements(sym, h, opts) {
    if (!h) return [];
    const max = Number(opts?.max) > 0 ? Number(opts.max) : 4;
    const presets = getPresetsForTicker(sym).slice(0, max);
    return presets.map((p) =>
      h("span", {
        key: `list-${p.id}`,
        className: "ds-chip ds-chip--sm tt-list-preset-chip",
        title: `Tracked list: ${p.label}`,
        style: {
          fontFamily: "var(--tt-font-mono)",
          fontSize: 9,
          letterSpacing: "0.03em",
          background: "rgba(103, 232, 249, 0.08)",
          borderColor: "rgba(103, 232, 249, 0.28)",
          color: "#67e8f9",
        },
      }, p.label),
    );
  }

  window.TimedListPresets = {
    load,
    ingest,
    getUpticksSet,
    applyUpticksToGroups,
    getPresetsForTicker,
    isInPreset,
    buildChipElements,
    norm,
  };

  load();
})();

// cache-bust:1787746033470:59714626
