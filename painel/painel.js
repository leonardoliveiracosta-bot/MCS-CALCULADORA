(() => {
  'use strict';
  let config;
  let accessToken;
  let refreshTimer;
  const $ = (id) => document.getElementById(id);
  const show = (id) => ['login-view', 'password-view', 'app-view'].forEach((view) => $(view).classList.toggle('hidden', view !== id));
  const error = (id, message) => { $(id).textContent = message || ''; };
  const request = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { ...(options.headers || {}), ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const err = new Error(body.error || 'REQUEST_FAILED'); err.code = body.error; throw err; }
    return body;
  };
  const clearSession = () => { sessionStorage.removeItem('mcs_panel_token'); accessToken = null; };
  const startSafeRefresh = () => {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => {
      try { await request('/api/panel/today'); } catch (_) { clearInterval(refreshTimer); }
    }, 120000);
  };
  async function routeSession() {
    if (!accessToken) return show('login-view');
    try {
      const session = await request('/api/panel/session');
      if (session.mustChangePassword) return show('password-view');
      show('app-view');
      await request('/api/panel/today');
      startSafeRefresh();
    } catch (err) {
      clearSession(); show('login-view');
      if (err.code === 'PANEL_ACCESS_DENIED') error('login-error', 'Esta conta não tem acesso ao painel.');
    }
  }
  async function signIn(event) {
    event.preventDefault(); error('login-error');
    const response = await fetch(config.url + '/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { apikey: config.publishableKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) return error('login-error', 'E-mail ou senha inválidos.');
    accessToken = data.access_token; sessionStorage.setItem('mcs_panel_token', accessToken);
    await routeSession();
  }
  async function changePassword(event) {
    event.preventDefault(); error('password-error');
    const password = $('new-password').value;
    if (password !== $('confirm-password').value) return error('password-error', 'As senhas não coincidem.');
    const response = await fetch(config.url + '/auth/v1/user', {
      method: 'PUT', headers: { apikey: config.publishableKey, authorization: 'Bearer ' + accessToken, 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!response.ok) return error('password-error', 'Não foi possível atualizar a senha.');
    try { await request('/api/panel/complete-password', { method: 'POST' }); await routeSession(); }
    catch (_) { error('password-error', 'A senha foi alterada, mas a liberação do painel falhou. Entre novamente.'); clearSession(); }
  }
  async function boot() {
    try { config = await request('/api/panel/config'); }
    catch (_) { error('login-error', 'Painel indisponível no momento.'); return; }
    accessToken = sessionStorage.getItem('mcs_panel_token');
    $('login-form').addEventListener('submit', signIn); $('password-form').addEventListener('submit', changePassword);
    $('logout').addEventListener('click', () => { clearInterval(refreshTimer); clearSession(); show('login-view'); });
    await routeSession();
  }
  boot();
})();
