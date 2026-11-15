import { immutable, assets, prerendered } from '$app/manifest';
import { version } from '$app/env';
import { self as worker } from '$app/service-worker';
const cacheName = `puffin-${version}`;
const paths = [...immutable, ...assets, ...prerendered].map(
  (entry) =>
    new URL(entry.path || './', new URL('./', worker.location.href)).href
);
worker.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(paths)));
});
worker.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('puffin-') && key !== cacheName)
            .map((key) => caches.delete(key))
        )
      )
  );
});
worker.addEventListener('fetch', (event) => {
  if (
    event.request.method !== 'GET' ||
    new URL(event.request.url).origin !== worker.location.origin
  )
    return;
  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      try {
        return await fetch(event.request);
      } catch (error) {
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        throw error;
      }
    })()
  );
});
