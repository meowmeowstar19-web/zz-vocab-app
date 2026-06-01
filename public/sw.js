// Service worker for PlushieWord PWA.
// - Satisfies Chrome's installability requirement (must have a fetch handler)
// - Caches static assets so the app loads instantly on repeat visits and works offline
// Bump CACHE_VERSION on every deploy that changes the SW or invalidates caches.
const CACHE_VERSION = 'v100';
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `runtime-${CACHE_VERSION}`;
// Bounded LRU cache for word-content images (local /images/ or R2 CDN). UI
// chrome (figma/install graphics) is NOT here — it lives in SHELL_CACHE so a
// heavy browsing session can't evict the app's own skeleton. See isShellAsset.
const IMAGE_CACHE = `images-${CACHE_VERSION}`;
const IMAGE_CACHE_LIMIT = 200;
// Unbounded cache for app-shell UI graphics (backgrounds, decorations, frames,
// login/settings art under /assets/figma/ and /assets/install/). This set is
// small and fixed (~38 files) and never grows with the word/audio library, so
// keeping all of it is cheap. Critically, it must NOT share the word-image LRU:
// a user who views >200 distinct words would otherwise evict the chrome and see
// a blank/broken shell offline. Suffixed with CACHE_VERSION so a deploy clears
// the old set; within a version nothing here is ever evicted.
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
// Bounded LRU cache for pronunciation audio (local /assets/audio/ or R2 CDN).
// The cap is how many clips a single device keeps cached at once — it has
// nothing to do with the total audio library (tens of thousands of files
// across many languages): users only ever replay a small handful, so 800
// (~8MB) holds plenty without ever needing to grow with the library.
const AUDIO_CACHE = `audio-${CACHE_VERSION}`;
const AUDIO_CACHE_LIMIT = 800;
// Permanent cache for the content-hashed entry bundle (/assets/index-*.js
// and index-*.css) — the only build output on the startup-critical path.
// Deliberately NOT suffixed with CACHE_VERSION: the filename hash already
// changes whenever the code changes, so these entries are immutable and must
// survive version bumps. Otherwise every deploy that bumps CACHE_VERSION (we
// bump on every asset refresh) evicts the ~1MB JS bundle and forces a full
// re-download on the next visit — the main cause of slow repeat loads.
// The ~1600 per-word lazy chunks are NOT included: they're loaded on demand,
// never block first paint, and stay on the existing versioned static path.
const BUILD_CACHE = 'build-assets';
// Each deploy produces 3 startup entries (index.js + vendor.js + index.css),
// so 9 keeps the current build plus the two previous ones — enough for an
// in-flight tab mid-deploy to still resolve its (now-previous) chunks.
const BUILD_CACHE_LIMIT = 9;
// R2 public bucket custom domain (Phase 5 sets VITE_CDN_BASE to this).
const CDN_HOST = 'cdn.plushieword.com';

// Pre-cache the bare minimum so the app shell opens offline.
const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE && k !== IMAGE_CACHE && k !== SHELL_CACHE && k !== AUDIO_CACHE && k !== BUILD_CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Skip the SW entirely for Supabase / API / analytics calls — those must hit the network.
function shouldBypass(url) {
  return (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('supabase.in') ||
    url.pathname.startsWith('/api/')
  );
}

// Pronunciation audio, local or R2 CDN. Path is identical in both cases
// (/assets/audio/<lang>/<key>.mp3), so the pathname test catches both. MUST be
// checked before isImageAsset: once audio is CDN-hosted its hostname is also
// CDN_HOST, and isImageAsset would otherwise swallow it into the image LRU.
function isAudioAsset(url) {
  return url.pathname.startsWith('/assets/audio/');
}

// Cache-first audio with a true LRU cap. Media playback (especially iOS Safari)
// is the hard part here:
// (1) RANGE REQUESTS BYPASS THE CACHE ENTIRELY. <audio> issues Range requests
//     (iOS opens with a tiny `bytes=0-1` probe) and REQUIRES a real 206 Partial
//     Content response. Two ways the Cache API breaks this: a stored full 200
//     served to a Range request, and — worse for CDN audio — a cross-origin
//     no-cors media fetch yields an *opaque* response (status 0) whose body is
//     just the probed bytes. Caching that opaque sliver and replaying it for
//     every later Range request feeds iOS a couple of bytes instead of a 206,
//     so all pronunciation goes silent after the first play. The CDN sends
//     `immutable` long-max-age headers, so the browser's own HTTP cache handles
//     replays — we lose nothing by streaming Range requests straight from net.
// (2) Only NON-range, same-origin full 200s are cached (never opaque 0). Hit →
//     re-put (move to MRU end); overflow → evict from front. Separate cache so
//     audio and image eviction don't fight over one LRU budget.
async function handleAudio(req) {
  if (req.headers.has('range')) return fetch(req);
  const cache = await caches.open(AUDIO_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    cache.put(req, cached.clone()).catch(() => {});
    return cached;
  }
  const res = await fetch(req);
  if (res.status === 200) {
    const copy = res.clone();
    cache.put(req, copy).then(async () => {
      const keys = await cache.keys();
      const excess = keys.length - AUDIO_CACHE_LIMIT;
      for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
    }).catch(() => {});
  }
  return res;
}

// App-shell UI graphics: backgrounds, decorations, frames, login/settings art
// under /assets/figma/ and /assets/install/ (local or R2 CDN — the pathname is
// identical in both cases). MUST be checked before isImageAsset: once CDN-
// hosted, these share CDN_HOST with word images, and isImageAsset matches on
// that host alone, which would wrongly funnel them into the bounded word-image
// LRU and let a long browsing session evict the app's own skeleton.
function isShellAsset(url) {
  return (
    url.pathname.startsWith('/assets/figma/') ||
    url.pathname.startsWith('/assets/install/')
  );
}

// Cache-first with NO eviction. The shell set is small and fixed, so once a
// client has fetched these (after one online load) the visual skeleton stays
// fully available offline regardless of how many words get browsed. On a hit we
// serve straight from cache (no re-put needed — there's no LRU ordering to
// maintain). Allows 200 and opaque (status 0) cross-origin CDN responses.
async function handleShell(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.status === 200 || res.status === 0) {
    cache.put(req, res.clone()).catch(() => {});
  }
  return res;
}

// Word-content image assets routed through the bounded LRU cache: R2 CDN host,
// plus the local mirror under /images/. Shell graphics (figma/install) are
// handled separately by handleShell and never reach here.
function isImageAsset(url) {
  return (
    url.hostname === CDN_HOST ||
    url.pathname.startsWith('/images/')
  );
}

// Cache-first with a true LRU cap. On a hit we re-put to move the entry to the
// most-recently-used end (Cache API keys() preserves insertion order, and put
// replaces by deleting the old entry first). On overflow we evict from the
// front (least-recently-used). Allows status 200 and opaque (status 0) CDN
// cross-origin responses.
async function handleImage(req) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    cache.put(req, cached.clone()).catch(() => {});
    return cached;
  }
  const res = await fetch(req);
  if (res.status === 200 || res.status === 0) {
    const copy = res.clone();
    cache.put(req, copy).then(async () => {
      const keys = await cache.keys();
      const excess = keys.length - IMAGE_CACHE_LIMIT;
      for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
    }).catch(() => {});
  }
  return res;
}

// The content-hashed startup bundle emitted by Vite: the entry
// /assets/index-<hash>.{js,css} plus the /assets/vendor-<hash>.js chunk
// (third-party libs split out via build.rollupOptions in vite.config.js).
// Both are on the first-paint critical path and must survive CACHE_VERSION
// bumps. Per-word lazy chunks (<word>-<hash>.js) are intentionally excluded —
// they don't gate first paint.
function isBuildAsset(url) {
  if (url.origin !== self.location.origin) return false;
  const isStartupChunk = url.pathname.startsWith('/assets/index-')
    || url.pathname.startsWith('/assets/vendor-');
  if (!isStartupChunk) return false;
  return url.pathname.endsWith('.js') || url.pathname.endsWith('.css');
}

// Cache-first into the permanent BUILD_CACHE with a bounded LRU. Hashed
// filenames are immutable, so a hit is always safe to serve without
// revalidation. On a hit we re-put to mark the entry most-recently-used;
// stale bundles from old deploys drift to the front and get evicted once we
// exceed BUILD_CACHE_LIMIT.
async function handleBuildAsset(req) {
  const cache = await caches.open(BUILD_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    cache.put(req, cached.clone()).catch(() => {});
    return cached;
  }
  const res = await fetch(req);
  if (res.status === 200) {
    const copy = res.clone();
    cache.put(req, copy).then(async () => {
      const keys = await cache.keys();
      const excess = keys.length - BUILD_CACHE_LIMIT;
      for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
    }).catch(() => {});
  }
  return res;
}

// Cacheable static asset paths (large, rarely changing).
function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/images/') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.jpeg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.webp') ||
    url.pathname.endsWith('.woff') ||
    url.pathname.endsWith('.woff2')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (shouldBypass(url)) return;

  // HTML / app shell → stale-while-revalidate. Serve the cached shell
  // instantly (first paint no longer waits on a network round-trip to the
  // origin every load), then refresh the cache in the background so the next
  // load picks up a new deploy. The one-reload propagation lag is acceptable;
  // the stale shell references a hashed bundle that this client already has in
  // the permanent BUILD_CACHE (it was stored on the same prior visit), so
  // there's no stale-HTML-vs-missing-bundle mismatch. Falls back to the
  // precached '/' when both cache and network miss (offline first visit).
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => cached || caches.match('/'));
      if (cached) {
        event.waitUntil(networkFetch.catch(() => {}));
        return cached;
      }
      return networkFetch;
    })());
    return;
  }

  // Entry bundle (index-*.js / .css) → permanent cache, cache-first, survives
  // CACHE_VERSION bumps so the ~1MB bundle isn't re-downloaded every deploy.
  if (isBuildAsset(url)) {
    event.respondWith(handleBuildAsset(req));
    return;
  }

  // Audio (local or R2 CDN) → dedicated bounded LRU, cache-first, 206-safe.
  // MUST precede the image branch: CDN-hosted audio shares CDN_HOST with
  // images, and isImageAsset matches on that host alone.
  if (isAudioAsset(url)) {
    event.respondWith(handleAudio(req));
    return;
  }

  // App-shell UI graphics (figma/install) → unbounded cache, cache-first.
  // MUST precede the image branch: CDN-hosted shell assets share CDN_HOST with
  // word images, and isImageAsset matches on that host alone.
  if (isShellAsset(url)) {
    event.respondWith(handleShell(req));
    return;
  }

  // Word-content images (local or R2 CDN) → bounded LRU cache, cache-first.
  if (isImageAsset(url)) {
    event.respondWith(handleImage(req));
    return;
  }

  // Static assets → cache-first.
  if (isStaticAsset(url) || url.origin === 'https://fonts.gstatic.com' || url.origin === 'https://fonts.googleapis.com') {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          // status===200 only — 206 (Partial Content) from Range requests
          // can't be cached via Cache API ("Partial response is unsupported"),
          // which the browser fires for <audio> seeking. res.ok includes
          // 206, so we narrow explicitly. .catch() swallows any other
          // put-failures so the network response still resolves to the page.
          if (res.status === 200) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        });
      })
    );
    return;
  }

  // Everything else (built JS/CSS chunks etc.) → stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req).then((res) => {
        if (res.status === 200) {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
