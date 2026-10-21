const CACHE_NAME = 'hsk-vocab-cache-v213';
const ASSETS = [
  './',
  './index.html',
  './hsk_dictionary.js',
  './opencc_t2cn.js',
  './hanviet_dict.js',
  './pinyin_dict.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './loading.gif',
  './butterfly_loading.gif',
  './butterfly_loading.gif?v=177',
  './story_loading.gif',
  './story_loading.gif?v=149',
  './audio_playing.gif',
  './cat_listening.png',
  './speaker_flower.png',
  './reward_cheer.webp',
  './study_vocab.png',
  './study_reading.png',
  './fonts/HYZhengYuan-55W-2.otf'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch((err) => console.log('Cache addAll warning:', err));
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Hybrid strategy:
// - Skip cross-origin APIs (Supabase, OpenRouter, etc.) and Netlify functions
// - Cache-First (0ms) for heavy static assets (3.1MB font, 1.2MB dictionaries, GIFs/PNGs/WebPs)
// - Network-First for HTML, manifest, and sw.js so F5 always gets the latest version immediately
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const reqUrl = new URL(event.request.url);
  if (reqUrl.origin !== self.location.origin) return;
  if (reqUrl.pathname.includes('/.netlify/')) return;

  const isStaticAsset = /\.(otf|ttf|woff2?|png|gif|webp|jpe?g|svg)$/i.test(reqUrl.pathname)
    || /\/(hsk_dictionary|opencc_t2cn|hanviet_dict|pinyin_dict)\.js$/i.test(reqUrl.pathname);

  if (isStaticAsset) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) return cachedResponse;
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
