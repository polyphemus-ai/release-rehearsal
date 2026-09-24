// Service worker: shows polyphemus notifications and opens the right session when you tap one.

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'polyphemus', body: '', url: '/', tag: 'polyphemus' };
  event.waitUntil(
    (async () => {
      // Nothing is news if you're looking at polyphemus right now: the open app says it itself, so the
      // window is told instead of the operating system. A window that's visible but not focused (behind
      // another app, another screen) still gets a notification.
      const windows = await self.clients.matchAll({ type: 'window' });
      const here = windows.find((client) => client.visibilityState === 'visible' && client.focused);
      if (here) {
        here.postMessage({ type: 'polyphemus-push', ...data });
        return;
      }
      await self.registration.showNotification(data.title, {
        body: data.body,
        tag: data.tag,
        renotify: true,
        // PNG: Android can't show SVG here, and falls back to a generic icon.
        icon: '/icon-192.png',
        badge: '/badge.png',
        data: { url: data.url },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) {
          await client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
