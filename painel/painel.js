(() => {
  'use strict';
  const MAX_FILES = 20, MAX_ZIP = 100 * 1024 * 1024, MAX_TEXT = 25 * 1024 * 1024, MAX_ENTRIES = 10000;
  let config, accessToken, refreshTimer, contacts = [];
  const $ = (id) => document.getElementById(id);
  const show = (id) => ['login-view', 'password-view', 'app-view'].forEach((view) => $(view).classList.toggle('hidden', view !== id));
  const error = (id, message) => { $(id).textContent = message || ''; };
  const request = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}), ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const err = new Error(body.error || 'REQUEST_FAILED'); err.code = body.error; throw err; }
    return body;
  };
  const clean = (value) => String(value || '').normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '').trim();
  const sha256 = async (value) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
  };
  function nyUtc(p) {
    const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second || 0);
    const out = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess)).reduce((o, part) => (o[part.type] = part.value, o), {});
    const localAsUtc = Date.UTC(+out.year, +out.month - 1, +out.day, +out.hour, +out.minute, +out.second);
    return new Date(guess - (localAsUtc - guess)).toISOString();
  }
  function parseDate(match) {
    let [month, day, year, hour, minute, second, ampm] = match.slice(1, 8);
    let h = +hour; if (ampm) { if (/p/i.test(ampm) && h < 12) h += 12; if (/a/i.test(ampm) && h === 12) h = 0; }
    const y = +year < 100 ? 2000 + +year : +year;
    if (+month > 12 || +day > 31 || h > 23 || +minute > 59) return null;
    const p = { year: y, month: +month, day: +day, hour: h, minute: +minute, second: +(second || 0) };
    return { local: `${y}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`, utc: nyUtc(p) };
  }
  function parseWhatsApp(raw, filename, mcsName) {
    const iphone = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\]\s([^:]+):\s?(.*)$/;
    const android = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\s+-\s+([^:]+):\s?(.*)$/;
    const items = []; let current, recognized = 0;
    raw.replace(/\r\n?/g, '\n').split('\n').forEach((line) => {
      const match = line.match(iphone) || line.match(android); const date = match && parseDate(match);
      if (date) { current = { date, sender: clean(match[8]), body: match[9] || '', original: line }; items.push(current); recognized++; }
      else if (current) current.body += '\n' + line;
    });
    if (!recognized) return { supported: false, reason: 'formato não suportado' };
    const messages = items.filter((item) => !/mensagens e ligações são protegidas|messages and calls are end-to-end encrypted|mudou o assunto|created group|added .* to the group|entrou usando/i.test(clean(item.body)));
    if (!messages.length) return { supported: false, reason: 'formato não suportado' };
    const speakers = new Set(messages.map((item) => item.sender.toLocaleLowerCase('pt-BR')));
    return { supported: true, channel: 'WHATSAPP', canonicalKey: clean(filename.replace(/\.txt$/i, '')) || 'WhatsApp', isGroup: speakers.size > 2, entries: messages.map((item, index) => ({ ...item, direction: item.sender.toLocaleLowerCase('pt-BR') === clean(mcsName).toLocaleLowerCase('pt-BR') ? 'MCS' : 'CUSTOMER', originalOrder: index + 1, edit: /mensagem editada|edited/i.test(item.body), deleted: /mensagem apagada|message deleted/i.test(item.body) })) };
  }
  async function extract(file) {
    if (file.size > (file.name.toLowerCase().endsWith('.zip') ? MAX_ZIP : MAX_TEXT)) throw new Error('Arquivo excede o limite permitido.');
    if (!file.name.toLowerCase().endsWith('.zip')) return [{ name: file.name, text: await file.text() }];
    if (!window.zip) throw new Error('Leitor ZIP indisponível.');
    const reader = new zip.ZipReader(new zip.BlobReader(file));
    try {
      const entries = await reader.getEntries();
      if (entries.length > MAX_ENTRIES) throw new Error('ZIP com entradas demais.');
      const txt = entries.filter((entry) => !entry.directory && /\.txt$/i.test(entry.filename));
      if (!txt.length) throw new Error('ZIP sem TXT de conversa.');
      const result = [];
      for (const entry of txt) { if (entry.encrypted || entry.uncompressedSize > MAX_TEXT) throw new Error('ZIP não atende aos limites de segurança.'); result.push({ name: entry.filename, text: await entry.getData(new zip.TextWriter()) }); }
      return result;
    } finally { await reader.close(); }
  }
  async function sendConversation(parsed, sourceKind, sourceFilename, sourceSha, contact) {
    if (!parsed.supported) { await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'review', sourceKind, sourceFilename, sourceSha256: sourceSha }) }); $('import-status').textContent = `${sourceFilename}: formato não suportado — revisão, sem inserir mensagens.`; return { pending: true, inserted: 0 }; }
    const start = await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'start', sourceKind, sourceFilename, sourceSha256: sourceSha, chat: { channel: parsed.channel, canonicalKey: parsed.canonicalKey, isGroup: parsed.isGroup, contactId: contact && contact.id, newContactName: contact && contact.name } }) });
    const messages = await Promise.all(parsed.entries.map(async (entry) => ({
      chat_id: start.chatId, channel: parsed.channel, direction: entry.direction, body_text: clean(entry.body), body_normalized: clean(entry.body), occurred_at_local: entry.date.local, timezone_assumed: 'America/New_York', occurred_at_utc: entry.date.utc, time_uncertain: false, original_datetime_text: entry.original, original_order: entry.originalOrder, source_kind: 'IMPORT', is_edit_marker: entry.edit, is_delete_marker: entry.deleted,
      signature_base: await sha256([start.chatId, entry.date.local, entry.direction, clean(entry.body)].join('\u001f'))
    })));
    const total = messages.reduce((all, item) => (all[item.signature_base] = (all[item.signature_base] || 0) + 1, all), {}); messages.forEach((item) => { item.file_occurrence_total = total[item.signature_base]; });
    let inserted = 0, cursor = 0, batch = 1;
    while (cursor < messages.length) { const chunk = []; while (cursor < messages.length && chunk.length < 500) { const candidate = chunk.concat(messages[cursor]); if (chunk.length && new Blob([JSON.stringify(candidate)]).size > 1024 * 1024) break; chunk.push(messages[cursor++]); } const result = await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'batch', importJobId: start.importJobId, batchNumber: batch++, messages: chunk }) }); inserted += result.inserted; }
    const done = await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'finish', importJobId: start.importJobId }) });
    return { inserted, pending: done.pending };
  }
  async function importFiles(files) {
    if (!files.length || files.length > MAX_FILES) throw new Error('Selecione de 1 a 20 arquivos.'); let inserted = 0, pending = false;
    for (const file of files) { $('import-status').textContent = `Lendo ${file.name}…`; const sourceSha = await sha256(await file.arrayBuffer()); for (const item of await extract(file)) { const result = await sendConversation(parseWhatsApp(item.text, file.name, $('mcs-name').value), file.name.toLowerCase().endsWith('.zip') ? 'WHATSAPP_ZIP' : 'WHATSAPP_TXT', file.name, sourceSha); inserted += result.inserted; pending = pending || result.pending; } }
    $('import-status').textContent = `${inserted} mensagem(ns) nova(s). ${pending ? 'Há pendências em ENTRADA.' : 'Importação concluída; siga para HOJE.'}`; await loadQueue(); if (!pending) switchPanel('today');
  }
  function switchPanel(view) { const entry = view === 'entry'; $('entry-panel').classList.toggle('hidden', !entry); $('today-panel').classList.toggle('hidden', entry); $('page-title').textContent = entry ? 'ENTRADA' : 'HOJE'; document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view)); if (entry) loadQueue().catch(() => null); }
  function renderQueue(chats, reviews) {
    const root = $('entry-queue'); root.replaceChildren(); if (!chats.length && !reviews.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Nenhuma conversa pendente.'; root.append(p); return; }
    chats.forEach((chat) => { const item = document.createElement('article'); item.className = 'queue-item'; const header = document.createElement('header'); const title = document.createElement('strong'); title.textContent = chat.canonical_key; const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = chat.is_group ? 'revisão — grupo' : chat.resolution_status === 'UNIDENTIFIED' ? 'não identificada' : 'revisão'; header.append(title, badge); const count = document.createElement('span'); count.className = 'muted'; count.textContent = `${chat.newMessageCount} mensagem(ns) importada(s)`; const actions = document.createElement('div'); actions.className = 'queue-actions'; const select = document.createElement('select'); select.add(new Option('De quem é?', '')); select.add(new Option('Novo contato', 'new')); select.add(new Option('Descartar / manter em revisão', 'discard')); contacts.forEach((contact) => select.add(new Option(contact.display_name || 'Sem nome', contact.id))); const name = document.createElement('input'); name.placeholder = 'Nome do novo contato'; name.hidden = true; select.addEventListener('change', () => { name.hidden = select.value !== 'new'; }); const button = document.createElement('button'); button.className = 'small'; button.type = 'button'; button.textContent = 'Confirmar'; button.addEventListener('click', async () => { if (!select.value) return; try { await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'resolve', chatId: chat.id, resolution: select.value === 'new' ? 'new' : select.value === 'discard' ? 'discard' : 'existing', contactId: select.value, displayName: name.value, aliasText: chat.canonical_key }) }); await loadQueue(); } catch (_) { $('import-status').textContent = 'Não foi possível concluir a revisão.'; } }); actions.append(select, name, button); item.append(header, count, actions); root.append(item); });
  }
  async function loadQueue() { const data = await request('/api/panel/entry'); contacts = data.contacts || []; const select = $('sms-contact'); const old = select.value; select.replaceChildren(new Option('Novo contato', 'new')); contacts.forEach((contact) => select.add(new Option(contact.display_name || 'Sem nome', contact.id))); if ([...select.options].some((option) => option.value === old)) select.value = old; renderQueue(data.chats || [], data.reviews || []); (data.reviews || []).forEach((review) => { const item = document.createElement('article'); item.className = 'queue-item'; const title = document.createElement('strong'); title.textContent = review.source_filename || 'Arquivo sem nome'; const note = document.createElement('span'); note.className = 'badge'; note.textContent = 'revisão — formato não suportado'; item.append(title, note); $('entry-queue').append(item); }); }
  async function addSms(event) {
    event.preventDefault(); const selected = $('sms-contact').value, message = clean($('sms-text').value), local = $('sms-date').value; if (!message || !local) return; const name = clean($('sms-new-name').value); if (selected === 'new' && !name) { $('sms-status').textContent = 'Informe o nome do novo contato.'; return; }
    const p = { year: +local.slice(0,4), month: +local.slice(5,7), day: +local.slice(8,10), hour: +local.slice(11,13), minute: +local.slice(14,16), second: 0 };
    const parsed = { supported: true, channel: 'SMS', canonicalKey: selected === 'new' ? 'sms:' + name : 'sms:' + selected, isGroup: false, entries: [{ date: { local: local + ':00', utc: nyUtc(p) }, direction: $('sms-direction').value, body: message, original: local, originalOrder: 1, edit: false, deleted: false }] };
    try { const result = await sendConversation(parsed, 'SMS_PASTE', 'SMS manual', await sha256(message + local), selected === 'new' ? { name } : { id: selected }); $('sms-status').textContent = `${result.inserted} SMS adicionado(s).`; $('sms-text').value = ''; await loadQueue(); } catch (_) { $('sms-status').textContent = 'Não foi possível adicionar o SMS.'; }
  }
  async function uploadAttachment() {
    const file = $('attachment-file').files[0]; if (!file) return;
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const magicBase64 = btoa(String.fromCharCode(...head));
    try {
      const signed = await request('/api/panel/attachments', { method: 'POST', body: JSON.stringify({ action: 'sign', filename: file.name, mimeType: file.type, byteSize: file.size, magicBase64 }) });
      const path = signed.uploadUrl.startsWith('http') ? signed.uploadUrl : config.url + '/storage/v1' + signed.uploadUrl;
      const uploaded = await fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(signed.token), { method: 'PUT', headers: { 'content-type': file.type }, body: file });
      if (!uploaded.ok) throw new Error('UPLOAD_FAILED');
      await request('/api/panel/attachments', { method: 'POST', body: JSON.stringify({ action: 'finalize', attachmentId: signed.attachmentId, quarantinePath: signed.quarantinePath, filename: signed.filename, mimeType: file.type }) });
      $('attachment-status').textContent = 'Anexo verificado e armazenado de forma privada.'; $('attachment-file').value = '';
    } catch (err) { $('attachment-status').textContent = err.code === 'ATTACHMENT_REJECTED' ? 'Arquivo rejeitado por tipo, tamanho ou assinatura.' : 'Não foi possível enviar o anexo.'; }
  }
  const clearSession = () => { sessionStorage.removeItem('mcs_panel_token'); accessToken = null; };
  const startSafeRefresh = () => { clearInterval(refreshTimer); refreshTimer = setInterval(async () => { try { await request('/api/panel/today'); if (!$('entry-panel').classList.contains('hidden')) await loadQueue(); } catch (_) { clearInterval(refreshTimer); } }, 120000); };
  async function routeSession() { if (!accessToken) return show('login-view'); try { const session = await request('/api/panel/session'); if (session.mustChangePassword) return show('password-view'); show('app-view'); await request('/api/panel/today'); startSafeRefresh(); } catch (err) { clearSession(); show('login-view'); if (err.code === 'PANEL_ACCESS_DENIED') error('login-error', 'Esta conta não tem acesso ao painel.'); } }
  async function signIn(event) { event.preventDefault(); error('login-error'); const response = await fetch(config.url + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: config.publishableKey, 'content-type': 'application/json' }, body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }) }); const data = await response.json().catch(() => ({})); if (!response.ok || !data.access_token) return error('login-error', 'E-mail ou senha inválidos.'); accessToken = data.access_token; sessionStorage.setItem('mcs_panel_token', accessToken); await routeSession(); }
  async function changePassword(event) { event.preventDefault(); error('password-error'); const password = $('new-password').value; if (password !== $('confirm-password').value) return error('password-error', 'As senhas não coincidem.'); const response = await fetch(config.url + '/auth/v1/user', { method: 'PUT', headers: { apikey: config.publishableKey, authorization: 'Bearer ' + accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ password }) }); if (!response.ok) return error('password-error', 'Não foi possível atualizar a senha.'); try { await request('/api/panel/complete-password', { method: 'POST' }); await routeSession(); } catch (_) { error('password-error', 'A senha foi alterada, mas a liberação do painel falhou. Entre novamente.'); clearSession(); } }
  async function boot() { try { config = await request('/api/panel/config'); } catch (_) { error('login-error', 'Painel indisponível no momento.'); return; } accessToken = sessionStorage.getItem('mcs_panel_token'); $('login-form').addEventListener('submit', signIn); $('password-form').addEventListener('submit', changePassword); $('logout').addEventListener('click', () => { clearInterval(refreshTimer); clearSession(); show('login-view'); }); document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => switchPanel(button.dataset.view))); $('whatsapp-files').addEventListener('change', (event) => importFiles([...event.target.files]).catch((err) => { $('import-status').textContent = err.message || 'Não foi possível importar o arquivo.'; })); const zone = $('drop-zone'); ['dragenter','dragover'].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add('dragging'); })); ['dragleave','drop'].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove('dragging'); })); zone.addEventListener('drop', (event) => importFiles([...event.dataTransfer.files]).catch((err) => { $('import-status').textContent = err.message || 'Não foi possível importar o arquivo.'; })); $('sms-form').addEventListener('submit', addSms); $('sms-contact').addEventListener('change', () => { $('sms-new-name-label').hidden = $('sms-contact').value !== 'new'; }); $('attachment-upload').addEventListener('click', uploadAttachment); $('sms-date').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16); await routeSession(); }
  boot();
})();
