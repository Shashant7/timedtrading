/* tt-fetch-cache.js
 *
 * SessionStorage-backed fetch cache. Pages load instantly from the
 * cache on the next visit, then revalidate in the background so the
 * UI stays fresh.
 *
 * Usage:
 *   const data = await window.TTFetchCache.get("/timed/all", {
 *     ttlMs: 60 * 1000,      // freshness budget
 *     maxAgeMs: 5 * 60 * 1000, // hard expiry — never serve older
 *     fetchOpts: { credentials: "include", cache: "no-store" },
 *   });
 *
 * Pattern (stale-while-revalidate):
 *   1. Resolve immediately with cached body if it's within ttlMs.
 *   2. Always trigger a background fetch to refresh the cache.
 *   3. Subscribe via .subscribe(url, onUpdate) to react to background
 *      revalidations and re-render with the fresh body.
 *
 * Why sessionStorage (not localStorage):
 *  - Per-tab scope keeps stale data from polluting a fresh login.
 *  - 5MB budget is plenty for snapshot + brief + investor scores.
 */
(function () {
  if (typeof window === "undefined") return;

  const STORAGE_PREFIX = "ttfc:v1:";
  const listeners = new Map(); // url -> Set<(body)=>void>

  function storageKey(url) {
    return STORAGE_PREFIX + url;
  }

  function readEntry(url) {
    try {
      const raw = sessionStorage.getItem(storageKey(url));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return parsed; // { body, ts, status }
    } catch (_) { return null; }
  }

  function writeEntry(url, body, status) {
    try {
      const entry = { body, ts: Date.now(), status: status ?? 200 };
      sessionStorage.setItem(storageKey(url), JSON.stringify(entry));
      return entry;
    } catch (_) {
      // Quota exceeded — purge oldest TT cache keys + retry once.
      try {
        const keys = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k);
        }
        keys.sort();
        for (let i = 0; i < Math.min(5, keys.length); i++) sessionStorage.removeItem(keys[i]);
        const entry = { body, ts: Date.now(), status: status ?? 200 };
        sessionStorage.setItem(storageKey(url), JSON.stringify(entry));
        return entry;
      } catch (_e) {
        return null;
      }
    }
  }

  function notify(url, body) {
    const set = listeners.get(url);
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try { fn(body); } catch (_) {}
    }
  }

  async function backgroundRefresh(url, fetchOpts) {
    try {
      const r = await fetch(url, fetchOpts);
      if (!r.ok) return;
      const body = await r.json();
      writeEntry(url, body, r.status);
      notify(url, body);
    } catch (_) {/* silent — keep stale entry */}
  }

  async function get(url, opts) {
    const ttlMs = Number(opts?.ttlMs ?? 60 * 1000);
    const maxAgeMs = Number(opts?.maxAgeMs ?? 30 * 60 * 1000);
    const fetchOpts = opts?.fetchOpts || { credentials: "include" };

    const entry = readEntry(url);
    const age = entry ? Date.now() - entry.ts : Infinity;
    const isFresh = entry && age < ttlMs;
    const isStaleButUsable = entry && age < maxAgeMs;

    // Fresh — return immediately and DON'T re-fetch unless caller
    // explicitly opts in via revalidateAlways.
    if (isFresh && !opts?.revalidateAlways) {
      return entry.body;
    }

    // Stale-but-usable — return immediately, kick off background refresh.
    if (isStaleButUsable) {
      backgroundRefresh(url, fetchOpts);
      return entry.body;
    }

    // No usable entry — fetch synchronously.
    try {
      const r = await fetch(url, fetchOpts);
      if (!r.ok) return null;
      const body = await r.json();
      writeEntry(url, body, r.status);
      return body;
    } catch (_) {
      return null;
    }
  }

  function subscribe(url, onUpdate) {
    let set = listeners.get(url);
    if (!set) {
      set = new Set();
      listeners.set(url, set);
    }
    set.add(onUpdate);
    return () => set.delete(onUpdate);
  }

  function peek(url) {
    const entry = readEntry(url);
    return entry ? entry.body : null;
  }

  function invalidate(url) {
    try { sessionStorage.removeItem(storageKey(url)); } catch (_) {}
  }

  function clear() {
    try {
      const keys = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k);
      }
      for (const k of keys) sessionStorage.removeItem(k);
    } catch (_) {}
  }

  window.TTFetchCache = { get, peek, subscribe, invalidate, clear };
})();

// cache-bust:1780023375299:134456009
