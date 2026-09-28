'use strict';

function panelUrl(payload) {
  return payload && payload.journeyId
    ? '/painel#ficha/' + encodeURIComponent(payload.journeyId)
    : '/painel';
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch (_) { payload = {}; }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = windows.find((client) => client.visibilityState === 'visible' && new URL(client.url).pathname.startsWith('/painel'));
    if (visible) {
      visible.postMessage({ type: 'MCS_PUSH_RECEIVED', messageId: payload.messageId || null });
      return;
    }
    await self.registration.showNotification(payload.title || 'Nova mensagem de cliente', {
      body: payload.body || 'Nova mensagem de cliente.',
      tag: payload.messageId ? 'mcs-message-' + payload.messageId : 'mcs-test',
      renotify: true,
      data: { url: panelUrl(payload), messageId: payload.messageId || null }
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = event.notification.data && event.notification.data.url || '/painel';
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const panel = windows.find((client) => new URL(client.url).pathname.startsWith('/painel'));
    if (panel) {
      if ('navigate' in panel) await panel.navigate(target);
      return panel.focus();
    }
    return self.clients.openWindow(target);
  })());
});
