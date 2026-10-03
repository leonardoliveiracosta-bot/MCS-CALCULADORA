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
    // "Enviar para meu celular": the notification always shows; tapping it opens the WhatsApp conversation with the text.
    if (payload.kind === 'WA_HANDOFF' && /^https:\/\/wa\.me\//.test(String(payload.url || ''))) {
      await self.registration.showNotification(payload.title || 'Enviar no WhatsApp', { body: payload.body || '', tag: 'mcs-wa-handoff', renotify: true, data: { url: payload.url, external: true } });
      return;
    }
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
    if (event.notification.data && event.notification.data.external) return self.clients.openWindow(target);
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const panel = windows.find((client) => new URL(client.url).pathname.startsWith('/painel'));
    if (panel) {
      if ('navigate' in panel) await panel.navigate(target);
      return panel.focus();
    }
    return self.clients.openWindow(target);
  })());
});
