// Service worker — cache l'app shell pour l'usage terrain hors-ligne.
// Les tuiles OSM restent réseau (trop volumineuses à pré-cacher).
const CACHE = 'clean-them-all-v12'; // à incrémenter à chaque déploiement pour invalider le cache
const ASSETS = [
  './',
  './index.html',
  './debug.html',
  './style.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './config.js',
  './js/app.js',
  './js/db.js',
  './js/ball.js',
  './js/charts.js',
  './js/community.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/supabase/supabase.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // tuiles OSM etc. → réseau direct
  e.respondWith(
    caches.match(e.request).then(cached => cached ?? fetch(e.request)),
  );
});
