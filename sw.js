/* Service Worker: アプリ本体は事前キャッシュ、問題画像は「見たら保存」+ TOP 画面からの一括保存 */
const SHELL = 'sc-shell-v10';
const DATA = 'sc-data-v1';       // app.js の DATA_CACHE と同じ名前
const SHELL_FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'data/exams.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('sc-shell-') && k !== SHELL) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 問題・解答例のページ画像: キャッシュ優先。取得できたら保存しておく
  if (/\/data\/[^/]+\/[^/]+\.png$/.test(url.pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(DATA);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req.url, res.clone());
      return res;
    })());
    return;
  }

  // アプリ本体と exams.json: キャッシュを即返しつつ裏で更新 (次回起動時に反映)
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const key = req.mode === 'navigate' ? './' : req;
    const hit = await cache.match(key, { ignoreSearch: true });
    const net = fetch(req).then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || new Response('offline', { status: 503 });
  })());
});
