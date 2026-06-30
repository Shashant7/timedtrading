// Timed Trading — Service Worker (push notifications + offline app shell)
// Bump SHELL_VERSION when precache list or routing logic changes.

const SHELL_VERSION = "tt-shell-v2";
const SHELL_CACHE = `${SHELL_VERSION}-precache`;
const RUNTIME_CACHE = `${SHELL_VERSION}-runtime`;
const CDN_CACHE = `${SHELL_VERSION}-cdn`;

const PRECACHE_URLS = [
  "/today.html",
  "/active-trader.html",
  "/investor.html",
  "/portfolio.html",
  "/logo.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/site.webmanifest",
  "/tt-tokens.css",
  "/offline.html",
];

const CDN_HOSTS = new Set([
  "unpkg.com",
  "cdn.jsdelivr.net",
  "cdn.tailwindcss.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
]);

function isApiRequest(url) {
  const p = url.pathname || "";
  return p.startsWith("/timed/") || p.startsWith("/bridge/") || p.startsWith("/cdn-cgi/");
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    if (fallbackUrl) {
      const fb = await cache.match(fallbackUrl);
      if (fb) return fb;
    }
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return hit || network || fetch(request);
}

// ── Push notifications ────────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  let data = { title: "Timed Trading", body: "New notification" };
  try {
    if (event.data) data = event.data.json();
  } catch {
    if (event.data) data.body = event.data.text();
  }

  const options = {
    body: data.body || "",
    icon: "/apple-touch-icon.png",
    badge: "/logo.svg",
    tag: data.tag || `timed-${Date.now()}`,
    data: {
      url: data.link || data.url || "/today.html",
      type: data.type || "system",
    },
    actions: [
      { action: "open", title: "Open" },
      { action: "dismiss", title: "Dismiss" },
    ],
    vibrate: [100, 50, 100],
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(data.title || "Timed Trading", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;

  const targetUrl = event.notification.data?.url || "/today.html";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.navigate(targetUrl);
          return;
        }
      }
      return clients.openWindow(targetUrl);
    }),
  );
});

// ── Install / activate ────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      await Promise.allSettled(
        PRECACHE_URLS.map((url) => cache.add(new Request(url, { cache: "reload" }))),
      );
    }).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("tt-shell-") && !k.startsWith(SHELL_VERSION))
          .map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

// ── Fetch routing ─────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Live API — never cache in SW (tt-fetch-cache handles client-side TTL).
  if (isApiRequest(url)) return;

  // Cross-origin CDN assets — cache for offline revisits after first load.
  if (!isSameOrigin(url)) {
    if (CDN_HOSTS.has(url.hostname)) {
      event.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    }
    return;
  }

  // HTML navigations — network first, fall back to cached shell.
  if (request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(
      networkFirst(request, RUNTIME_CACHE, "/today.html").catch(async () => {
        const offline = await caches.match("/offline.html");
        if (offline) return offline;
        const today = await caches.match("/today.html");
        if (today) return today;
        return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
      }),
    );
    return;
  }

  // Versioned static assets (?v=) — stale-while-revalidate.
  if (url.searchParams.has("v") || url.pathname.startsWith("/vendor/")) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
    return;
  }

  // Other same-origin static — cache first after first fetch.
  event.respondWith(cacheFirst(request, RUNTIME_CACHE));
});

// cache-bust:1782821927039:285953455
