'use strict';

(() => {
  const SESSION_KEY = 'mcs_panel_session';
  const CURSOR_KEY = 'mcs_panel_notification_cursor';
  const PUSH_IDS_KEY = 'mcs_panel_push_message_ids';
  const POLL_MS = 20 * 1000;
  let pollTimer = null;
  let cursor = null;

  const byId = (id) => document.getElementById(id);
  const status = (text) => { const node = byId('notification-status'); if (node) node.textContent = text || ''; };
  const toggle = () => byId('notification-toggle');
  const testButton = () => byId('notification-test');

  function accessToken() {
    for (const storage of [localStorage, sessionStorage]) {
      try {
        const value = JSON.parse(storage.getItem(SESSION_KEY) || 'null');
        if (value && value.accessToken) return value.accessToken;
      } catch (_) { /* Ignore malformed local state. */ }
    }
    return null;
  }

  function pushIds() {
    try { return new Set(JSON.parse(sessionStorage.getItem(PUSH_IDS_KEY) || '[]')); } catch (_) { return new Set(); }
  }

  function rememberPush(messageId) {
    if (!messageId) return;
    const ids = [...pushIds(), messageId].slice(-200);
    sessionStorage.setItem(PUSH_IDS_KEY, JSON.stringify([...new Set(ids)]));
  }

  async function api(path, options = {}) {
    const token = accessToken();
    if (!token) throw new Error('AUTHENTICATION_REQUIRED');
    const response = await fetch(path, {
      ...options,
      headers: { authorization: 'Bearer ' + token, ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'REQUEST_FAILED');
    return { data, status: response.status };
  }

  function urlBase64ToUint8Array(value) {
    const padded = value + '='.repeat((4 - value.length % 4) % 4);
    const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  }

  function foreground() {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  function buttonState() {
    const available = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (toggle()) toggle().disabled = !available || Notification.permission === 'denied';
    if (testButton()) testButton().disabled = !available || !accessToken();
    if (!available) status('Este navegador não oferece avisos.');
    else if (Notification.permission === 'denied') status('Os avisos estão bloqueados neste dispositivo.');
  }

  async function registerWorker() {
    if (!('serviceWorker' in navigator)) throw new Error('PUSH_UNSUPPORTED');
    return navigator.serviceWorker.register('/painel/sw.js', { scope: '/painel/' });
  }

  async function subscribe() {
    try {
      if (!('Notification' in window) || !('PushManager' in window)) throw new Error('PUSH_UNSUPPORTED');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('PUSH_PERMISSION_DENIED');
      const registration = await registerWorker();
      const config = await api('/api/panel/push-config');
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.data.publicKey)
      });
      await api('/api/panel/push-subscriptions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription.toJSON())
      });
      status('Avisos ativados neste dispositivo.');
    } catch (error) {
      const messages = {
        PUSH_UNSUPPORTED: 'Este dispositivo não oferece avisos.',
        PUSH_PERMISSION_DENIED: 'A permissão de avisos não foi concedida.',
        PUSH_NOT_CONFIGURED: 'Os avisos ainda não estão configurados no servidor.'
      };
      status(messages[error.message] || 'Não foi possível ativar os avisos.');
    } finally { buttonState(); }
  }

  async function sendTest() {
    try {
      const result = await api('/api/panel/push-test', { method: 'POST' });
      status('Aviso de teste enviado (' + result.data.accepted + ').');
    } catch (error) {
      status(error.message === 'PUSH_TEST_NOT_DELIVERED' ? 'Ative os avisos neste dispositivo antes do teste.' : 'Não foi possível enviar o teste.');
    }
  }

  async function poll() {
    if (!foreground() || !accessToken()) return;
    if (!cursor) {
      cursor = sessionStorage.getItem(CURSOR_KEY) || new Date().toISOString();
      sessionStorage.setItem(CURSOR_KEY, cursor);
      return;
    }
    try {
      const result = await api('/api/panel/notifications?after=' + encodeURIComponent(cursor));
      const received = pushIds();
      for (const message of result.data.items || []) if (!received.has(message.id)) status('Nova mensagem de cliente no painel.');
      if (result.data.cursor) {
        cursor = result.data.cursor;
        sessionStorage.setItem(CURSOR_KEY, cursor);
      }
    } catch (_) { /* Polling is optional and never changes the app state. */ }
  }

  function schedulePolling() {
    clearInterval(pollTimer);
    pollTimer = null;
    if (!foreground()) return;
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }

  document.addEventListener('DOMContentLoaded', () => {
    buttonState();
    toggle() && toggle().addEventListener('click', subscribe);
    testButton() && testButton().addEventListener('click', sendTest);
    navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type === 'MCS_PUSH_RECEIVED') {
        rememberPush(data.messageId);
        status('Nova mensagem de cliente no painel.');
      }
    });
    document.addEventListener('visibilitychange', schedulePolling);
    window.addEventListener('focus', schedulePolling);
    window.addEventListener('blur', schedulePolling);
    schedulePolling();
  });
})();
