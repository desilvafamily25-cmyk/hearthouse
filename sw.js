// HeartHouse Service Worker
// Enables offline functionality and caching with safe update behavior

// ======= VERSION (bump to force updates) =======
const SW_VERSION = 'v2';

// Separate names so old caches get cleaned up
const PRECACHE = `hearthouse-precache-${SW_VERSION}`;
const RUNTIME  = `hearthouse-runtime-${SW_VERSION}`;

// Assets to cache on install (app shell)
const PRECACHE_URLS = [
  '/',                // app shell
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
  // Note: we avoid precaching external CDNs to reduce staleness.
];

// ----- INSTALL -----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PRECACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch(err => console.log('[SW] precache failed:', err))
  );
});

// ----- ACTIVATE -----
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Clean up any old caches
    const keep = new Set([PRECACHE, RUNTIME]);
    const names = await caches.keys();
    await Promise.all(names.map(n => !keep.has(n) && caches.delete(n)));

    // Enable navigation preload if available (faster first paint)
    if ('navigationPreload' in self.registration) {
      await self.registration.navigationPreload.enable();
    }

    await self.clients.claim();
  })());
});

// Utility to get cached index.html regardless of query strings
async function cachedAppShell() {
  // Try match ignoring query params
  const cache = await caches.open(PRECACHE);
  const match = await cache.match('/index.html', { ignoreSearch: true });
  if (match) return match;

  // Fallback to root if needed
  return cache.match('/', { ignoreSearch: true });
}

// ----- FETCH -----
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1) Always bypass SW for cross-origin (except you can add allowlists if needed)
  if (url.origin !== self.location.origin) {
    return; // let the browser handle it
  }

  // 2) Never cache Supabase API/auth; always go to network
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(JSON.stringify({
          error: 'Offline - changes will sync when connection is restored'
        }), { headers: { 'Content-Type': 'application/json' }});
      })
    );
    return;
  }

  // 3) Navigations (address bar, PWA launches) -> network-first, fallback to cached app shell
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        // If navigation preload is enabled, use it
        const preload = await event.preloadResponse;
        if (preload) return preload;

        // Network first to pick up new deploys
        const fresh = await fetch(request, { cache: 'no-store' });
        return fresh;
      } catch {
        // Offline: serve cached shell
        const shell = await cachedAppShell();
        return shell || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // 4) Same-origin GET assets -> stale-while-revalidate
  if (request.method === 'GET') {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(request);
      const networkPromise = fetch(request).then((response) => {
        // Only cache OK responses
        if (response && response.status === 200 && response.type === 'basic') {
          cache.put(request, response.clone());
        }
        return response;
      }).catch(() => undefined);

      // Return cached immediately, update in background; or await network if no cache
      return cached || networkPromise || (await cachedAppShell()) || new Response('Offline', { status: 503 });
    })());
    return;
  }

  // 5) Everything else — default
  // (POST/PUT/PATCH/DELETE will fall through to network)
});
