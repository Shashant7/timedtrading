// ═══════════════════════════════════════════════════════════════════════
// Timed Trading — Service Worker for Push Notifications
// ═══════════════════════════════════════════════════════════════════════

// Cache name for offline support (optional, progressive)
const CACHE_NAME = "timed-trading-v1";

// Listen for push events
self.addEventListener("push", (event) => {
  let data = { title: "Timed Trading", body: "New notification" };
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch {
    if (event.data) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body || "",
    icon: "/logo.png",
    badge: "/logo.png",
    tag: data.tag || `timed-${Date.now()}`,
    data: {
      url: data.link || data.url || "/index-react.html",
      type: data.type || "system",
    },
    actions: [
      { action: "open", title: "Open" },
      { action: "dismiss", title: "Dismiss" },
    ],
    // Vibrate pattern for mobile
    vibrate: [100, 50, 100],
    // Renotify if same tag
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(data.title || "Timed Trading", options));
});

// Handle notification click
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  const targetUrl = event.notification.data?.url || "/index-react.html";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // If a window is already open, focus it and navigate
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.navigate(targetUrl);
          return;
        }
      }
      // Otherwise open a new window
      return clients.openWindow(targetUrl);
    }),
  );
});

// Install event
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

// Activate event
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
