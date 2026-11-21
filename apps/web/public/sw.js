// Service worker di Yrols: serve solo a ricevere le notifiche push e ad aprire l'app al tocco.
// Non salva pagine in cache: l'app resta sempre quella pubblicata.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  const scope = self.registration.scope;
  e.waitUntil(self.registration.showNotification(d.title || "Yrols", {
    body: d.body || "",
    icon: scope + "icons/icon-192.png",
    tag: d.tag || "yrols",
    renotify: true,
    data: { url: (d.url || "/").replace(/^\/+/, "") },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) {
      await win.focus();
      if ("navigate" in win) await win.navigate(url).catch(() => {});
      return;
    }
    await self.clients.openWindow(url);
  })());
});
