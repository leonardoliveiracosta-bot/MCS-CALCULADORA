(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const formatDate = (value) => value ? new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short'
  }).format(new Date(value)) : '—';

  let generatedId = null;

  function accessToken() {
    for (const storage of [localStorage, sessionStorage]) {
      try {
        const saved = JSON.parse(storage.getItem('mcs_panel_session') || 'null');
        if (saved?.accessToken) return saved.accessToken;
      } catch (_) {}
    }
    return null;
  }

  async function request(options = {}) {
    const token = accessToken();
    if (!token) throw new Error('AUTHENTICATION_REQUIRED');
    const response = await fetch('/api/panel/sms-device-tokens', {
      ...options,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(options.body ? { 'content-type': 'application/json' } : {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'SMS_DEVICE_TOKENS_FAILED');
    return data;
  }

  function hideCode() {
    generatedId = null;
    $('sms-device-code').textContent = '';
    $('sms-device-once').classList.add('hidden');
  }

  function showCode(code, id) {
    generatedId = id;
    $('sms-device-code').textContent = code;
    $('sms-device-once').classList.remove('hidden');
  }

  async function load() {
    const list = $('sms-device-list');
    if (!list) return;
    try {
      const data = await request();
      list.replaceChildren();
      if (!(data.items || []).length) {
        list.append(element('p', 'muted', 'Nenhum iPhone conectado'));
        return;
      }
      for (const item of data.items || []) {
        const row = element('div', 'queue-item sms-device-row');
        const detail = element('span');
        detail.append(
          element('strong', '', item.deviceName || 'iPhone'),
          element('small', 'muted', `${formatDate(item.createdAt)} · ${item.status === 'ACTIVE' ? 'Ativo' : 'Revogado'}`),
          element('span', 'badge ' + (item.status === 'ACTIVE' ? 'green' : ''), item.status === 'ACTIVE' ? 'Ativo' : 'Revogado')
        );
        row.append(detail);
        if (item.status === 'ACTIVE') {
          const revoke = element('button', 'quiet small', 'Revogar');
          revoke.type = 'button';
          revoke.addEventListener('click', async () => {
            revoke.disabled = true;
            try {
              await request({ method: 'POST', body: JSON.stringify({ action: 'revoke', id: item.id }) });
              if (generatedId === item.id) hideCode();
              $('sms-device-status').textContent = 'Código revogado';
              await load();
            } catch (_) {
              revoke.disabled = false;
              $('sms-device-status').textContent = 'Não consegui revogar · tente de novo';
            }
          });
          row.append(revoke);
        }
        list.append(row);
      }
    } catch (_) {
      list.textContent = 'Não foi possível carregar os iPhones conectados';
    }
  }

  async function copyCode() {
    const code = $('sms-device-code').textContent;
    const status = $('sms-device-status');
    if (!code) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
      else {
        const field = document.createElement('textarea');
        field.value = code;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.append(field);
        try {
          field.select();
          if (!document.execCommand('copy')) throw new Error('COPY_FAILED');
        } finally {
          field.remove();
        }
      }
      status.textContent = 'Código copiado';
    } catch (_) {
      status.textContent = 'Não consegui copiar · toque e segure o código para copiar';
    }
  }

  const generate = $('sms-device-generate');
  if (generate) generate.addEventListener('click', async () => {
    const status = $('sms-device-status');
    generate.disabled = true;
    status.textContent = 'Gerando código…';
    hideCode();
    try {
      const data = await request({ method: 'POST', body: JSON.stringify({ action: 'generate', deviceName: 'iPhone' }) });
      showCode(data.code, data.item.id);
      status.textContent = 'Código gerado · o anterior foi revogado';
      await load();
    } catch (_) {
      status.textContent = 'Não consegui gerar o código · tente de novo';
    } finally {
      generate.disabled = false;
    }
  });

  $('sms-device-copy')?.addEventListener('click', copyCode);
  document.querySelector('[data-view="settings"]')?.addEventListener('click', () => load());
})();
