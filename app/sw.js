// Cachea la app para que abra sin conexión; los precios siempre van a la red.
const CACHE = 'comparador-v12';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'airports.js', 'config.js', 'manifest.webmanifest', 'icons/icon.svg'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS))));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
));
self.addEventListener('fetch', (e) => {
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
