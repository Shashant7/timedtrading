// worker/foundation/parity.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION — parity harness core (Phase 0 of
//  tasks/2026-06-14-foundation-rebuild-plan.md).
//
//  Backtest ≠ live is the bug we are eliminating. The guarantee comes from one
//  execution core reading the SAME getSeries interface (live vs as-of), and is
//  PROVEN by this harness: take two score maps for the same as-of (one from the
//  live path, one from the replay path) and assert they are identical.
//
//  This module is the PURE diff core. The data plumbing (how you obtain the two
//  maps) is environment-specific and lives in scripts/parity-baseline.js. Keep
//  the math here so it is unit-tested and reused by the CI parity gate.
// ─────────────────────────────────────────────────────────────────────────────

/** Read a dot-path (e.g. "components.sector.pts") off an object. */
function getPath(obj, path) {
  return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function bothNumbers(a, b) {
  return typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b);
}

function valuesMatch(a, b, tol) {
  if (a == null && b == null) return true;
  if (bothNumbers(a, b)) return Math.abs(a - b) <= tol;
  return a === b;
}

/**
 * Compare two score maps for the same as-of.
 *
 * @param {Object<string,object>} live    { ticker: payload }
 * @param {Object<string,object>} replay  { ticker: payload }
 * @param {Object} [opts]
 * @param {string[]} [opts.fields=["status","value","tier"]]  dot-paths to compare
 * @param {number} [opts.tolerance=0]      numeric tolerance (0 = exact)
 * @returns {{
 *   identical:boolean,
 *   tickers_compared:number,
 *   divergent:Array<{ticker:string,field:string,live:*,replay:*,delta:number|null}>,
 *   only_in_live:string[],
 *   only_in_replay:string[],
 *   summary:object
 * }}
 */
export function computeParityReport(live, replay, opts = {}) {
  const fields = Array.isArray(opts.fields) && opts.fields.length ? opts.fields : ["status", "value", "tier"];
  const tol = Number(opts.tolerance) || 0;
  const liveMap = live || {};
  const repMap = replay || {};
  const liveKeys = Object.keys(liveMap);
  const repKeys = new Set(Object.keys(repMap));
  const liveSet = new Set(liveKeys);

  const both = liveKeys.filter((k) => repKeys.has(k));
  const only_in_live = liveKeys.filter((k) => !repKeys.has(k));
  const only_in_replay = [...repKeys].filter((k) => !liveSet.has(k));

  const divergent = [];
  for (const t of both) {
    for (const f of fields) {
      const a = getPath(liveMap[t], f);
      const b = getPath(repMap[t], f);
      if (!valuesMatch(a, b, tol)) {
        divergent.push({ ticker: t, field: f, live: a, replay: b, delta: bothNumbers(a, b) ? b - a : null });
      }
    }
  }

  const identical = divergent.length === 0 && only_in_live.length === 0 && only_in_replay.length === 0;
  return {
    identical,
    tickers_compared: both.length,
    divergent,
    only_in_live,
    only_in_replay,
    summary: {
      identical,
      divergence_count: divergent.length,
      divergent_tickers: [...new Set(divergent.map((d) => d.ticker))].length,
      only_in_live: only_in_live.length,
      only_in_replay: only_in_replay.length,
      fields,
      tolerance: tol,
    },
  };
}

/** One-line human summary for logs / runner output. */
export function summarizeParity(report) {
  const s = report?.summary || {};
  if (report?.identical) {
    return `PARITY OK — ${report.tickers_compared} tickers identical on [${(s.fields || []).join(", ")}]`;
  }
  return `PARITY DIVERGENCE — ${s.divergence_count} field diffs across ${s.divergent_tickers} tickers `
    + `(only_live=${s.only_in_live}, only_replay=${s.only_in_replay}); tickers_compared=${report?.tickers_compared}`;
}
