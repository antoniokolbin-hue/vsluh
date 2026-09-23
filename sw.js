// Вслух — офлайн-режим. Оболочка приложения кэшируется при установке,
// голоса и движки кэширует сам воркер озвучки (vsluh-assets-v1).
const SHELL = 'vsluh-shell-v2';
const FILES = [
  './', 'index.html', 'app.js', 'tts-worker.js', 'manifest.webmanifest',
  'ort.wasm.bundle.min.mjs', 'ort-wasm-simd-threaded.mjs', 'piper_phonemize.mjs',
  'literata-cyrillic-wght-normal.woff2', 'literata-cyrillic-wght-italic.woff2',
  'literata-latin-wght-normal.woff2', 'literata-latin-wght-italic.woff2',
  'icon-180.png', 'icon-192.png', 'icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('vsluh-shell-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    // сначала сеть (свежая версия), при офлайне — кэш
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(req.mode === 'navigate' ? req.url : req, { signal: ctl.signal, cache: 'no-cache' });
      clearTimeout(t);
      if (r.ok) { const c = await caches.open(SHELL); c.put(req, r.clone()).catch(() => {}); }
      return r;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await caches.match('index.html') : null);
      return hit || Response.error();
    }
  })());
});
