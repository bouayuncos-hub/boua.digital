/* =====================================================================
   Bouadigital — Service worker
   - Pages : réseau d'abord, copie en cache si pas de réseau (l'app s'ouvre hors ligne)
   - Bibliothèques (Tailwind, Firebase, polices, QR) : cache, mise à jour en arrière-plan
   - Jamais en cache : Firestore, Auth, Storage, Stripe, /api (données toujours à jour)
   À chaque nouvelle version du site : augmenter VERSION.
   ===================================================================== */
const VERSION = "bd-2026-10-19-1";
const PAGES = `pages-${VERSION}`;
const LIBS = `libs-${VERSION}`;

const PRECACHE = [
  "/", "/app", "/client", "/kit-digital",
  "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon.svg"
];
const LIB_HOSTS = ["cdn.tailwindcss.com", "fonts.googleapis.com", "fonts.gstatic.com", "www.gstatic.com", "cdnjs.cloudflare.com"];
const NEVER = ["firestore.googleapis.com", "identitytoolkit.googleapis.com", "securetoken.googleapis.com",
  "firebasestorage.googleapis.com", "firebaseinstallations.googleapis.com", "cloudfunctions.net", "stripe.com", "wa.me"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(PAGES).then(c => Promise.all(PRECACHE.map(u => c.add(u).catch(() => {}))))
  );
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.endsWith(VERSION)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// La page demande d'activer tout de suite la nouvelle version
self.addEventListener("message", event => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (NEVER.some(h => url.hostname.endsWith(h))) return;
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return;

  // Pages HTML : réseau d'abord
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && !res.redirected) {
          const c = await caches.open(PAGES);
          c.put(cleanKey(url), res.clone());
        }
        return res;
      } catch (e) {
        const c = await caches.open(PAGES);
        return (await c.match(cleanKey(url))) || (await c.match("/app")) || (await c.match("/")) ||
          new Response("<h1>Hors ligne</h1><p>Reconnectez-vous pour charger cette page.</p>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    })());
    return;
  }

  // Bibliothèques externes : cache puis mise à jour en arrière-plan
  if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, LIBS));
    return;
  }

  // Fichiers du site (icônes, manifest…) : cache puis mise à jour
  if (url.origin === location.origin) {
    event.respondWith(staleWhileRevalidate(req, PAGES));
  }
});

function cleanKey(url) {
  // /app?tab=documents et /app partagent la même page en cache
  let p = url.pathname.replace(/\.html$/, "");
  if (p === "/index") p = "/";
  return p;
}

async function staleWhileRevalidate(req, cacheName) {
  const c = await caches.open(cacheName);
  const cached = await c.match(req);
  const network = fetch(req).then(res => {
    if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || network;
}
