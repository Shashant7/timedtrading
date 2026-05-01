/**
 * Design System v2 — Shared Components
 *
 * Single-source primitives. Every surface in the app composes from these.
 * Spec: tasks/design-system-v2-spec-2026-05-01.md
 *
 * Usage (vanilla JS / pages):
 *   const card = window.DS.tickerCard({ symbol: 'AAPL', price: 195.42, ... });
 *   container.appendChild(card);
 *
 * Usage (React, via window.DS.react):
 *   window.DS.react.TickerCard({ symbol, price, ... })
 *
 * No external deps. CSS classes live in tt-tokens.css under the v2 utility
 * block.
 */

(function () {
  const W = typeof window !== 'undefined' ? window : globalThis;

  /* ─── Pure helpers ────────────────────────────────────────────────── */

  function fmtNum(v, decimals = 2) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }
  function fmtUsd(v, decimals = 2) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return '$' + fmtNum(Math.abs(n), decimals);
  }
  function fmtPct(v, decimals = 2) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const sign = n >= 0 ? '+' : '';
    return `${sign}${n.toFixed(decimals)}%`;
  }
  function dirClass(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) return 'flat';
    return n > 0 ? 'up' : 'dn';
  }

  /* ─── Sparkline SVG generator ─────────────────────────────────────── */

  function sparklineSvg(values, opts = {}) {
    const { width = 96, height = 24, direction = 'flat', strokeWidth = 1.5 } = opts;
    const arr = (values || []).filter(v => Number.isFinite(Number(v))).map(Number);
    if (arr.length < 2) {
      return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"></svg>`;
    }
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const range = max - min || 1;
    const dx = width / (arr.length - 1);
    const points = arr.map((v, i) => {
      const x = i * dx;
      const y = height - ((v - min) / range) * (height - strokeWidth) - strokeWidth / 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const path = `M${points.join(' L')}`;
    const fillPath = `${path} L${(arr.length - 1) * dx},${height} L0,${height} Z`;
    const fillVar = direction === 'up' ? 'var(--ds-spark-up-fill)'
                   : direction === 'dn' ? 'var(--ds-spark-dn-fill)'
                   : 'var(--ds-spark-flat-fill)';
    const strokeVar = direction === 'up' ? 'var(--ds-spark-up-stroke)'
                     : direction === 'dn' ? 'var(--ds-spark-dn-stroke)'
                     : 'var(--ds-spark-flat-stroke)';
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="display:block">
      <path d="${fillPath}" fill="${fillVar}" />
      <path d="${path}" fill="none" stroke="${strokeVar}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;
  }

  /* ─── Ticker logo (with monogram fallback) ────────────────────────── */

  function tickerLogoUrl(symbol) {
    // External logo provider via TwelveData. Falls back to monogram if image fails.
    // Pattern: https://eodhd.com/img/logos/US/{ticker}.png — public CDN
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return null;
    return `https://eodhd.com/img/logos/US/${sym}.png`;
  }
  function tickerMonogram(symbol) {
    return String(symbol || '').toUpperCase().slice(0, 2);
  }
  function tickerLogoColor(symbol) {
    // Deterministic warm-palette color from ticker hash
    const sym = String(symbol || '').toUpperCase();
    let hash = 0;
    for (let i = 0; i < sym.length; i++) hash = ((hash << 5) - hash) + sym.charCodeAt(i);
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 35%, 28%)`;
  }
  /* V2.1 round 4 (2026-05-01) — Some ETF logos (SPY, QQQ, IWM, USO, GLD,
     etc.) are delivered by eodhd as transparent PNGs whose foreground is
     dark — they vanish on the dark canvas. Wrap the img in a white plate
     so transparent logos show their detail. Logos that already ship with
     their own background (most equities) just look like a solid disc,
     which is fine. */
  function tickerLogo(symbol, opts = {}) {
    const { size = 24 } = opts;
    const url = tickerLogoUrl(symbol);
    const mono = tickerMonogram(symbol);
    const color = tickerLogoColor(symbol);
    const el = document.createElement('div');
    el.className = 'ds-tickercard__logo';
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.background = color;
    el.textContent = mono;
    if (url) {
      const img = new Image();
      img.src = url;
      img.alt = symbol;
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.borderRadius = '50%';
      img.style.objectFit = 'cover';
      img.onload = () => {
        el.textContent = '';
        // Light plate behind the img so transparent-PNG logos remain visible.
        el.style.background = '#ffffff';
        el.style.padding = '0';
        el.appendChild(img);
      };
      img.onerror = () => { /* keep monogram */ };
    }
    return el;
  }

  /* ─── DsTickerCard (vanilla DOM) ──────────────────────────────────── */

  function tickerCard(opts = {}) {
    const {
      symbol = '?',
      sub = '',                 // small text top-right (e.g. "VOLATILE_RUNNER")
      price = null,
      change = null,            // %
      changeDollar = null,
      sparkValues = null,
      density = 'default',      // 'compact' | 'default' | 'hero'
      onClick = null,
      direction = null,         // 'up' | 'dn' | 'flat' — auto-derived if null
    } = opts;
    const dir = direction || dirClass(change);
    const card = document.createElement(onClick ? 'button' : 'div');
    card.className = `ds-tickercard ${density === 'compact' ? 'ds-tickercard--compact' : density === 'hero' ? 'ds-tickercard--hero' : ''}`.trim();
    card.style.textAlign = 'left';
    if (onClick) { card.addEventListener('click', onClick); card.style.cursor = 'pointer'; }

    const head = document.createElement('div');
    head.className = 'ds-tickercard__head';
    head.appendChild(tickerLogo(symbol, { size: density === 'compact' ? 20 : density === 'hero' ? 32 : 24 }));
    const sym = document.createElement('span');
    sym.className = 'ds-tickercard__symbol';
    sym.textContent = String(symbol).toUpperCase();
    head.appendChild(sym);
    if (sub) {
      const subEl = document.createElement('span');
      subEl.className = 'ds-tickercard__sub';
      subEl.textContent = sub;
      head.appendChild(subEl);
    }
    card.appendChild(head);

    if (price != null) {
      const p = document.createElement('div');
      p.className = 'ds-tickercard__price';
      p.textContent = fmtUsd(price);
      card.appendChild(p);
    }
    if (change != null || changeDollar != null) {
      const ch = document.createElement('div');
      ch.className = `ds-tickercard__change ds-tickercard__change--${dir}`;
      const arrow = dir === 'up' ? '▲' : dir === 'dn' ? '▼' : '◆';
      const parts = [arrow];
      if (change != null) parts.push(fmtPct(change));
      if (changeDollar != null) parts.push(fmtUsd(changeDollar));
      ch.textContent = parts.join(' ');
      card.appendChild(ch);
    }
    if (sparkValues && sparkValues.length > 1) {
      const spark = document.createElement('div');
      spark.className = 'ds-tickercard__spark';
      spark.innerHTML = sparklineSvg(sparkValues, { width: 280, height: 50, direction: dir, strokeWidth: 1.5 });
      card.appendChild(spark);
    }
    return card;
  }

  /* ─── DsMetricTile (vanilla DOM) ──────────────────────────────────── */

  function metricTile(opts = {}) {
    const {
      label = '',
      value = '',
      delta = null,            // string like "+5.2%" or number
      deltaClass = 'accent',   // 'up' | 'dn' | 'accent'
      sparkValues = null,
      separator = false,
    } = opts;
    const el = document.createElement('div');
    el.className = `ds-metric ${separator ? 'ds-metric--separator' : ''}`.trim();
    if (label) {
      const l = document.createElement('div');
      l.className = 'ds-metric__label';
      l.textContent = label;
      el.appendChild(l);
    }
    const row = document.createElement('div');
    row.className = 'ds-metric__row';
    const v = document.createElement('div');
    v.className = 'ds-metric__value';
    v.textContent = String(value);
    row.appendChild(v);
    if (delta != null) {
      const d = document.createElement('div');
      d.className = `ds-metric__delta ds-metric__delta--${deltaClass}`;
      d.textContent = String(delta);
      row.appendChild(d);
    }
    el.appendChild(row);
    if (sparkValues && sparkValues.length > 1) {
      const spark = document.createElement('div');
      spark.className = 'ds-metric__spark';
      spark.innerHTML = sparklineSvg(sparkValues, { width: 80, height: 16, direction: 'flat', strokeWidth: 1 });
      el.appendChild(spark);
    }
    return el;
  }

  /* ─── DsChip (vanilla DOM) ────────────────────────────────────────── */

  function chip(opts = {}) {
    const {
      label = '',
      count = null,
      variant = '',         // '' | 'solid' | 'accent' | 'up' | 'dn'
      size = '',            // '' | 'sm' | 'lg'
      onClick = null,
      active = false,
      title = '',
    } = opts;
    const el = document.createElement(onClick ? 'button' : 'span');
    el.className = `ds-chip ${variant ? `ds-chip--${variant}` : ''} ${size ? `ds-chip--${size}` : ''} ${active ? 'ds-chip--accent' : ''}`.trim();
    if (title) el.title = title;
    if (onClick) el.addEventListener('click', onClick);
    el.appendChild(document.createTextNode(label));
    if (count != null) {
      const c = document.createElement('span');
      c.className = 'ds-chip__count';
      c.textContent = String(count);
      el.appendChild(c);
    }
    return el;
  }

  /* ─── DsRow (label-on-left, content-on-right) ─────────────────────── */

  function row(opts = {}) {
    const { label, sublabel, children } = opts;
    const r = document.createElement('div');
    r.className = 'ds-row';
    const l = document.createElement('div');
    l.className = 'ds-row__label';
    if (label) {
      const cap = document.createElement('div');
      cap.className = 'ds-caption';
      cap.textContent = label;
      l.appendChild(cap);
    }
    if (sublabel) {
      const s = document.createElement('div');
      s.style.fontSize = 'var(--ds-fs-caption)';
      s.style.color = 'var(--ds-text-faint)';
      s.style.marginTop = '2px';
      s.textContent = sublabel;
      l.appendChild(s);
    }
    r.appendChild(l);
    const c = document.createElement('div');
    c.className = 'ds-row__content';
    if (Array.isArray(children)) children.forEach(ch => ch && c.appendChild(ch));
    else if (children) c.appendChild(children);
    r.appendChild(c);
    return r;
  }

  /* ─── DsGlassPanel ───────────────────────────────────────────────── */

  function glassPanel(opts = {}) {
    const { title, action, children } = opts;
    const panel = document.createElement('div');
    panel.className = 'ds-glass';
    if (title || action) {
      const head = document.createElement('div');
      head.className = 'ds-glass__head';
      if (title) {
        const t = document.createElement('div');
        t.className = 'ds-glass__title';
        t.textContent = title;
        head.appendChild(t);
      }
      if (action) head.appendChild(action);
      panel.appendChild(head);
    }
    if (Array.isArray(children)) children.forEach(ch => ch && panel.appendChild(ch));
    else if (children) panel.appendChild(children);
    return panel;
  }

  /* ─── DsSpiderChart (SVG, single fill) ─────────────────────────────── */

  function spiderChart(opts = {}) {
    const {
      axes = [],          // [{ label, value, max }, ...] — typically 5 axes
      size = 240,
    } = opts;
    if (!axes.length) return document.createElement('div');
    const cx = size / 2;
    const cy = size / 2;
    const r = (size / 2) * 0.72;
    const n = axes.length;
    const TAU = Math.PI * 2;
    const offset = -Math.PI / 2;       // start at top
    const axisPoints = axes.map((_, i) => {
      const a = offset + (i / n) * TAU;
      return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, a };
    });
    const dataPoints = axes.map((ax, i) => {
      const v = Math.max(0, Math.min(1, (Number(ax.value) || 0) / (Number(ax.max) || 1)));
      const a = offset + (i / n) * TAU;
      return { x: cx + Math.cos(a) * r * v, y: cy + Math.sin(a) * r * v };
    });
    const outerPath = `M${axisPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L')} Z`;
    const dataPath = `M${dataPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L')} Z`;
    const labels = axes.map((ax, i) => {
      const p = axisPoints[i];
      const lx = cx + Math.cos(p.a) * (r + 18);
      const ly = cy + Math.sin(p.a) * (r + 18);
      const anchor = Math.cos(p.a) > 0.3 ? 'start' : Math.cos(p.a) < -0.3 ? 'end' : 'middle';
      return `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" font-family="var(--tt-font-ui)" font-size="10" font-weight="700" letter-spacing="0.16em" fill="var(--ds-text-muted)" style="text-transform:uppercase">${ax.label}</text>`;
    }).join('');
    const wrap = document.createElement('div');
    wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <path d="${outerPath}" fill="none" stroke="var(--ds-stroke-hi)" stroke-width="1" />
      <path d="${dataPath}" fill="rgba(167, 139, 250, 0.20)" stroke="rgba(167, 139, 250, 0.55)" stroke-width="1.5" />
      ${axisPoints.map(p => `<line x1="${cx}" y1="${cy}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="var(--ds-stroke-soft)" stroke-width="1" />`).join('')}
      ${labels}
    </svg>`;
    return wrap.firstChild;
  }

  /* ─── React wrappers (thin) ───────────────────────────────────────── */

  function makeReactWrappers(React) {
    if (!React) return {};
    const h = React.createElement;
    const factoryHooks = {};

    factoryHooks.TickerCard = (props) => {
      const ref = React.useRef(null);
      React.useEffect(() => {
        if (!ref.current) return;
        ref.current.innerHTML = '';
        ref.current.appendChild(tickerCard(props));
      }, [props.symbol, props.price, props.change, props.density]);
      return h('div', { ref });
    };
    factoryHooks.MetricTile = (props) => {
      const ref = React.useRef(null);
      React.useEffect(() => {
        if (!ref.current) return;
        ref.current.innerHTML = '';
        ref.current.appendChild(metricTile(props));
      }, [props.label, props.value, props.delta]);
      return h('div', { ref });
    };
    factoryHooks.SparklineSvg = (props) => {
      return h('div', {
        dangerouslySetInnerHTML: { __html: sparklineSvg(props.values, props) },
      });
    };
    factoryHooks.SpiderChart = (props) => {
      const ref = React.useRef(null);
      React.useEffect(() => {
        if (!ref.current) return;
        ref.current.innerHTML = '';
        ref.current.appendChild(spiderChart(props));
      }, [JSON.stringify(props.axes), props.size]);
      return h('div', { ref });
    };

    return factoryHooks;
  }

  /* ─── Public surface ──────────────────────────────────────────────── */

  W.DS = {
    // Helpers
    fmtNum, fmtUsd, fmtPct, dirClass,
    // SVG generators
    sparklineSvg,
    // Ticker logo helpers
    tickerLogo, tickerLogoUrl, tickerMonogram, tickerLogoColor,
    // Vanilla DOM factories
    tickerCard, metricTile, chip, row, glassPanel, spiderChart,
    // React wrappers (set lazily on first call)
    react: null,
    initReact(React) {
      if (!this.react) this.react = makeReactWrappers(React);
      return this.react;
    },
  };
})();
