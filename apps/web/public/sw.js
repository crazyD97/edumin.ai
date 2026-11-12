/*
 * Edumin service worker.
 * - App shell works offline (navigations fall back to the cached index.html).
 * - Built assets are cached on first use.
 * - GET API responses are cached so recently viewed pages (dashboard,
 *   attendance, homework, fees) still open without a connection.
 * - Shows push notifications and opens the right page when tapped.
 */
const SHELL = 'edumin-shell-v1';
const ASSETS = 'edumin-assets-v1';
const API = 'edumin-api-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/favicon.svg', '/icons/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, ASSETS, API].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Never cache auth, files (may be large/private), webhooks or non-GET calls.
const cacheableApi = (url) => url.pathname.startsWith('/api/') && !/^\/api\/(auth|files|webhooks|public\/messages|push)/.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(ASSETS).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
    return;
  }

  if (cacheableApi(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(API).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || new Response(JSON.stringify({ success: false, error: { code: 'OFFLINE', message: "You're offline. Showing nothing new until you reconnect." } }), { status: 503, headers: { 'Content-Type': 'application/json' } }))),
    );
  }
});

// The app tells us when a user signs out so their cached data is wiped.
self.addEventListener('message', (event) => {
  if (event.data === 'clear-user-cache') event.waitUntil(caches.delete(API));
});

self.addEventListener('push', (event) => {
  let data = { title: 'School update', body: '', link: '/' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* plain text push */
  }
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { link: data.link } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.navigate(link);
          return w.focus();
        }
      }
      return self.clients.openWindow(link);
    }),
  );
});
