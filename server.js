// KILL SWITCH - elimina el Service Worker viejo y todo su caché
// El navegador detecta que este archivo cambió y lo instala automáticamente
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // 1. Borrar TODOS los caches
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
      // 2. Desregistrar este Service Worker
      await self.registration.unregister();
      // 3. Recargar todas las pestañas abiertas para traer la versión fresca
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(client => client.navigate(client.url));
    })()
  );
});
