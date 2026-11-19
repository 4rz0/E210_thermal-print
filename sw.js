// Offline cache: network first, cache as fallback, so updates show up immediately.
const C = "e210-v2";
const FILES = ["./", "index.html", "style.css", "app.js", "printer.js", "manifest.webmanifest", "icon.svg",
  "icon-192.png", "icon-512.png", "vendor/qrcode.js", "vendor/JsBarcode.all.min.js"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(C).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(C).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
