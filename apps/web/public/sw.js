// Conclave service worker: shows web pushes (NOTE-003) and opens the inbox when one is clicked.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Conclave", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Conclave";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || undefined,
      data: { url: data.url || "/inbox" },
      // Safety checks stay on screen until someone acts on them.
      requireInteraction: !!data.urgent,
      icon: "/favicon.svg",
      badge: "/favicon.svg",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/inbox", self.location.origin);
  // Only ever open pages of this app.
  const url = target.origin === self.location.origin ? target.href : new URL("/inbox", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
