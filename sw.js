// Offline shell: app files are cached so it opens without a connection. Network first, so updates arrive at once.
const CACHE = 'french-v1';
const FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
  'vendor/preact-htm.js', 'js/app.js', 'js/ui.js', 'js/store.js', 'js/util.js', 'js/grammar-data.js', 'js/gemini.js',
  'js/audio.js', 'js/sync.js', 'js/drills.js', 'js/practice.js', 'js/drillsview.js', 'js/reading.js', 'js/convo.js',
  'js/screens.js', 'fonts/Poppins-Regular.ttf', 'fonts/Poppins-SemiBold.ttf', 'fonts/Poppins-Bold.ttf',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
