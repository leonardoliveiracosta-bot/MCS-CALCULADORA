(() => {
  'use strict';
  const MAX_FILES = 20;
  const MAX_ZIP = 100 * 1024 * 1024;
  const MAX_TEXT = 25 * 1024 * 1024;
  const MAX_ENTRIES = 10000;
  let config;
  let accessToken;
  let refreshTimer;
  let contacts = [];
  let chats = [];
  let journeys = [];
  let senderAliases = [];
  const $ = (id) => document.getElementById(id);
  const show = (id) => ['login-view', 'password-view', 'app-view'].forEach((view) => $(view).classList.toggle('hidden', view !== id));
  const error = (id, message) => { $(id).textContent = message || ''; };

  const request = async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}), ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}) }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = new Error(result.error || 'REQUEST_FAILED');
      failure.code = result.error;
      throw failure;
    }
    return result;
  };

  const sha256 = async (value) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
  };

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
      for (const entry of txt) {
        if (entry.encrypted || entry.uncompressedSize > MAX_TEXT) throw new Error('ZIP não atende aos limites de segurança.');
        result.push({ name: entry.filename, text: await entry.getData(new zip.TextWriter()) });
      }
      return result;
    } finally {
      await reader.close();
    }
  }

  function option(select, label, value) {
    select.add(new Option(label, value));
  }

  function updateImportChoices(parsed) {
    const contactSelect = $('import-contact');
    const chatSelect = $('import-chat');
    const journeySelect = $('import-journey');
    const chosenContact = contactSelect.value;
    const group = $('chat-type').value === 'group';
    chatSelect.replaceChildren(new Option('Novo chat', 'new'));
    chats.filter((chat) => chat.channel === 'WHATSAPP' && Boolean(chat.is_group) === group && (group || !chosenContact || chosenContact === 'new' || chat.contact_id === chosenContact)).forEach((chat) => option(chatSelect, `${chat.contact && chat.contact.display_name ? chat.contact.display_name : group ? 'Grupo existente' : 'Chat existente'} — ${chat.channel}`, chat.id));
    journeySelect.replaceChildren(new Option('Escolha', ''));
    option(journeySelect, 'Nova jornada', 'new');
    journeys.filter((journey) => chosenContact !== 'new' && journey.contact_id === chosenContact).forEach((journey) => {
      const refs = (journey.refs || []).map((item) => item.ref_code).join(', ');
      option(journeySelect, `${journey.vehicle_text || 'Busca sem veículo'}${refs ? ` — Ref ${refs}` : ''}`, journey.id);
    });
    $('contact-name-label').hidden = chosenContact !== 'new';
  }

  function reviewConversation(raw, filename, parsed) {
    return new Promise((resolve, reject) => {
      const card = $('import-review-card');
      const form = $('import-review-form');
      $('import-review-summary').textContent = `${filename}: ${parsed.senders.length} remetente(s), ${parsed.refs.length} Ref(s).`;
      $('date-order-label').classList.toggle('hidden', !parsed.requiresDateOrder);
      $('date-order').value = parsed.inferredDateOrder || '';
      $('chat-type').value = parsed.groupSignal ? 'group' : '';
      const sender = $('mcs-sender');
      sender.replaceChildren(new Option('Escolha', ''));
      parsed.senders.forEach((name) => option(sender, name, name));
      const contact = $('import-contact');
      contact.replaceChildren(new Option('Novo contato', 'new'));
      contacts.forEach((item) => option(contact, item.display_name || 'Sem nome', item.id));
      $('import-contact-name').value = '';
      $('ref-warning').classList.toggle('hidden', !parsed.refs.length);
      updateImportChoices(parsed);
      card.classList.remove('hidden');

      const toggle = () => {
        const group = $('chat-type').value === 'group';
        ['contact-label', 'contact-name-label', 'journey-label'].forEach((id) => { $(id).hidden = group || (id === 'contact-name-label' && $('import-contact').value !== 'new'); });
      };
      $('chat-type').onchange = () => { updateImportChoices(parsed); toggle(); };
      $('import-contact').onchange = () => { updateImportChoices(parsed); toggle(); };
      $('import-chat').onchange = () => {
        const selected = chats.find((chat) => chat.id === $('import-chat').value);
        if (selected && selected.contact_id) {
          $('import-contact').value = selected.contact_id;
          updateImportChoices(parsed);
          $('import-chat').value = selected.id;
        }
        const known = senderAliases.find((item) => item.chat_id === $('import-chat').value && item.direction === 'MCS');
        if (known && parsed.senders.includes(known.sender_text)) $('mcs-sender').value = known.sender_text;
      };
      toggle();
      form.onsubmit = (event) => {
        event.preventDefault();
        try {
          const isGroup = $('chat-type').value === 'group';
          const dateOrder = parsed.requiresDateOrder ? $('date-order').value : parsed.dateOrder || parsed.inferredDateOrder;
          if (!dateOrder) throw new Error('Escolha DD/MM ou MM/DD.');
          if (!$('chat-type').value) throw new Error('Confirme se é conversa individual ou grupo.');
          if (!$('mcs-sender').value) throw new Error('Confirme qual remetente é a MCS.');
          if (!isGroup && $('import-contact').value === 'new' && !MCSParser.clean($('import-contact-name').value)) throw new Error('Informe o nome do novo contato.');
          if (!isGroup && !$('import-journey').value) throw new Error('Escolha mesma busca ou nova jornada.');
          const finalParsed = MCSParser.parseWhatsApp(raw, filename, { dateOrder });
          if (!finalParsed.supported || finalParsed.requiresDateOrder) throw new Error('Não foi possível confirmar as datas.');
          const entries = MCSParser.assignDirections(finalParsed, $('mcs-sender').value);
          card.classList.add('hidden');
          resolve({
            parsed: finalParsed, entries, isGroup, mcsSender: $('mcs-sender').value,
            contactId: isGroup || $('import-contact').value === 'new' ? null : $('import-contact').value,
            newContactName: isGroup ? null : $('import-contact').value === 'new' ? MCSParser.clean($('import-contact-name').value) : null,
            chatId: $('import-chat').value === 'new' ? null : $('import-chat').value,
            journey: isGroup ? null : { mode: $('import-journey').value === 'new' ? 'new' : 'existing', journeyId: $('import-journey').value === 'new' ? null : $('import-journey').value }
          });
        } catch (failure) {
          $('import-status').textContent = failure.message;
        }
      };
      form.onreset = () => { card.classList.add('hidden'); reject(new Error('Importação cancelada.')); };
    });
  }

  async function submitConversation(raw, filename, sourceKind, sourceFilename, sourceSha) {
    const initial = MCSParser.parseWhatsApp(raw, filename, {});
    if (!initial.supported) {
      await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'review', sourceKind, sourceFilename, sourceSha256: sourceSha }) });
      $('import-status').textContent = `${sourceFilename}: formato não suportado — revisão, sem inserir mensagens.`;
      return { pending: true, inserted: 0 };
    }
    const choice = await reviewConversation(raw, filename, initial);
    const senderPayload = choice.parsed.senders.map((name) => ({ senderText: name, direction: MCSParser.normalizeSender(name) === MCSParser.normalizeSender(choice.mcsSender) ? 'MCS' : 'CUSTOMER' }));
    const start = await request('/api/panel/entry', {
      method: 'POST', body: JSON.stringify({
        action: 'start', sourceKind, sourceFilename, sourceSha256: sourceSha,
        chat: {
          channel: 'WHATSAPP', chatId: choice.chatId, isGroup: choice.isGroup,
          contactId: choice.contactId, newContactName: choice.newContactName,
          aliasText: choice.parsed.title, senderAliases: senderPayload
        }
      })
    });
    const messages = await Promise.all(choice.entries.map(async (entry) => ({
      chat_id: start.chatId, channel: 'WHATSAPP', direction: entry.direction,
      body_text: MCSParser.clean(entry.body), body_normalized: MCSParser.clean(entry.body),
      occurred_at_local: entry.date.local, timezone_assumed: 'America/New_York',
      occurred_at_utc: entry.date.utc, time_uncertain: entry.date.timeUncertain,
      original_datetime_text: entry.original, original_order: entry.originalOrder,
      source_kind: 'IMPORT', is_edit_marker: entry.edit, is_delete_marker: entry.deleted,
      signature_base: await sha256([start.chatId, entry.date.local, entry.direction, MCSParser.clean(entry.body)].join('\u001f'))
    })));
    const totals = messages.reduce((all, item) => { all[item.signature_base] = (all[item.signature_base] || 0) + 1; return all; }, {});
    messages.forEach((item) => { item.file_occurrence_total = totals[item.signature_base]; });
    let inserted = 0;
    let cursor = 0;
    let batch = 1;
    while (cursor < messages.length) {
      const chunk = [];
      while (cursor < messages.length && chunk.length < 500) {
        const candidate = chunk.concat(messages[cursor]);
        if (chunk.length && new Blob([JSON.stringify(candidate)]).size > 1024 * 1024) break;
        chunk.push(messages[cursor++]);
      }
      const result = await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'batch', importJobId: start.importJobId, batchNumber: batch++, messages: chunk }) });
      inserted += result.inserted;
    }
    const done = await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'finish', importJobId: start.importJobId, journey: choice.journey, refs: choice.parsed.refs }) });
    return { inserted, pending: done.pending };
  }

  async function importFiles(files) {
    if (!files.length || files.length > MAX_FILES) throw new Error('Selecione de 1 a 20 arquivos.');
    let inserted = 0;
    let pending = false;
    for (const file of files) {
      $('import-status').textContent = `Lendo ${file.name}…`;
      const sourceSha = await sha256(await file.arrayBuffer());
      const extracted = await extract(file);
      for (const item of extracted) {
        const result = await submitConversation(item.text, item.name, file.name.toLowerCase().endsWith('.zip') ? 'WHATSAPP_ZIP' : 'WHATSAPP_TXT', file.name, sourceSha);
        inserted += result.inserted;
        pending = pending || result.pending;
      }
    }
    $('import-status').textContent = `${inserted} mensagem(ns) nova(s). ${pending ? 'Há pendências em ENTRADA.' : 'Importação concluída; siga para HOJE.'}`;
    await loadQueue();
    if (!pending) switchPanel('today');
  }

  function switchPanel(view) {
    const entry = view === 'entry';
    $('entry-panel').classList.toggle('hidden', !entry);
    $('today-panel').classList.toggle('hidden', entry);
    $('page-title').textContent = entry ? 'ENTRADA' : 'HOJE';
    document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
    if (entry) loadQueue().catch(() => null);
  }

  function renderQueue(items, reviews) {
    const root = $('entry-queue');
    root.replaceChildren();
    if (!items.length && !reviews.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'Nenhuma conversa importada.';
      root.append(empty);
      return;
    }
    items.forEach((chat) => {
      const item = document.createElement('article');
      item.className = 'queue-item';
      const header = document.createElement('header');
      const title = document.createElement('strong');
      title.textContent = chat.contact && chat.contact.display_name ? chat.contact.display_name : chat.canonical_key;
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = chat.is_group ? 'revisão — grupo' : chat.resolution_status === 'RESOLVED' ? 'lida' : chat.resolution_status === 'UNIDENTIFIED' ? 'não identificada' : 'revisão';
      header.append(title, badge);
      const count = document.createElement('span');
      count.className = 'muted';
      count.textContent = `${chat.newMessageCount} mensagem(ns) nova(s) na última importação`;
      item.append(header, count);
      if (chat.hasTimeUncertain) {
        const uncertain = document.createElement('span');
        uncertain.className = 'badge';
        uncertain.textContent = 'hora incerta';
        item.append(uncertain);
      }
      if (chat.resolution_status !== 'RESOLVED') {
        const keep = document.createElement('button');
        keep.className = 'small';
        keep.type = 'button';
        keep.textContent = 'Manter em revisão';
        keep.addEventListener('click', async () => {
          await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'resolve', chatId: chat.id, resolution: 'review' }) });
          await loadQueue();
        });
        item.append(keep);
      }
      root.append(item);
    });
    reviews.forEach((review) => {
      const item = document.createElement('article');
      item.className = 'queue-item';
      const title = document.createElement('strong');
      title.textContent = review.source_filename || 'Arquivo sem nome';
      const note = document.createElement('span');
      note.className = 'badge';
      note.textContent = 'revisão — formato não suportado — manter em revisão';
      item.append(title, note);
      root.append(item);
    });
  }

  function refreshSmsJourneys() {
    const select = $('sms-journey');
    const contactId = $('sms-contact').value;
    select.replaceChildren(new Option('Nova jornada', 'new'));
    journeys.filter((journey) => contactId !== 'new' && journey.contact_id === contactId).forEach((journey) => option(select, journey.vehicle_text || 'Busca existente', journey.id));
  }

  async function loadQueue() {
    const data = await request('/api/panel/entry');
    contacts = data.contacts || [];
    chats = data.chats || [];
    journeys = data.journeys || [];
    senderAliases = data.senderAliases || [];
    const select = $('sms-contact');
    const old = select.value;
    select.replaceChildren(new Option('Novo contato', 'new'));
    contacts.forEach((contact) => option(select, contact.display_name || 'Sem nome', contact.id));
    if ([...select.options].some((entry) => entry.value === old)) select.value = old;
    refreshSmsJourneys();
    renderQueue(chats, data.reviews || []);
  }

  function smsDate(local) {
    const [date, time] = local.split('T');
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    return MCSParser.resolveNewYork({ year, month, day, hour, minute, second: 0 });
  }

  async function addSms(event) {
    event.preventDefault();
    const selected = $('sms-contact').value;
    const message = MCSParser.clean($('sms-text').value);
    const localInput = $('sms-date').value;
    const name = MCSParser.clean($('sms-new-name').value);
    if (!message || !localInput || (selected === 'new' && !name)) return;
    const contactId = selected === 'new' ? null : selected;
    const existingChat = chats.find((chat) => chat.channel === 'SMS' && chat.contact_id === contactId && !chat.is_group);
    const start = await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({
      action: 'start', sourceKind: 'SMS_PASTE', sourceFilename: 'SMS manual', sourceSha256: await sha256(message + localInput),
      chat: { channel: 'SMS', chatId: existingChat ? existingChat.id : null, isGroup: false, contactId, newContactName: selected === 'new' ? name : null, aliasText: 'SMS', senderAliases: [] }
    }) });
    const date = smsDate(localInput);
    const direction = $('sms-direction').value;
    const signature = await sha256([start.chatId, date.local, direction, message].join('\u001f'));
    const batch = await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'batch', importJobId: start.importJobId, batchNumber: 1, messages: [{
      chat_id: start.chatId, channel: 'SMS', direction, body_text: message, body_normalized: message,
      occurred_at_local: date.local, timezone_assumed: 'America/New_York', occurred_at_utc: date.utc,
      time_uncertain: date.timeUncertain, original_datetime_text: localInput, original_order: 1,
      source_kind: 'SMS_PASTE', is_edit_marker: false, is_delete_marker: false,
      signature_base: signature, file_occurrence_total: 1
    }] }) });
    const journeyValue = $('sms-journey').value;
    await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'finish', importJobId: start.importJobId, journey: { mode: journeyValue === 'new' ? 'new' : 'existing', journeyId: journeyValue === 'new' ? null : journeyValue }, refs: MCSParser.extractRefs([{ body: message }]) }) });
    $('sms-status').textContent = `${batch.inserted} SMS adicionado(s)${date.timeUncertain ? ' — hora incerta, revisão necessária' : ''}.`;
    $('sms-text').value = '';
    await loadQueue();
  }

  async function uploadAttachment() {
    const file = $('attachment-file').files[0];
    if (!file) return;
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const magicBase64 = btoa(String.fromCharCode(...head));
    try {
      const signed = await request('/api/panel/attachments', { method: 'POST', body: JSON.stringify({ action: 'sign', filename: file.name, mimeType: file.type, byteSize: file.size, magicBase64 }) });
      const path = signed.uploadUrl.startsWith('http') ? signed.uploadUrl : config.url + '/storage/v1' + signed.uploadUrl;
      const uploaded = await fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(signed.token), { method: 'PUT', headers: { 'content-type': file.type }, body: file });
      if (!uploaded.ok) throw new Error('UPLOAD_FAILED');
      await request('/api/panel/attachments', { method: 'POST', body: JSON.stringify({ action: 'finalize', attachmentId: signed.attachmentId, quarantinePath: signed.quarantinePath, filename: signed.filename, mimeType: file.type }) });
      $('attachment-status').textContent = 'Anexo verificado e armazenado de forma privada.';
      $('attachment-file').value = '';
    } catch (failure) {
      $('attachment-status').textContent = ['ATTACHMENT_REJECTED', 'ATTACHMENT_ID_INVALID', 'ATTACHMENT_PATH_INVALID'].includes(failure.code) ? 'Arquivo rejeitado por tipo, tamanho, caminho ou assinatura.' : 'Não foi possível enviar o anexo.';
    }
  }

  const clearSession = () => { sessionStorage.removeItem('mcs_panel_token'); accessToken = null; };
  const startSafeRefresh = () => {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => {
      try {
        await request('/api/panel/today');
        if (!$('entry-panel').classList.contains('hidden')) await loadQueue();
      } catch (_) { clearInterval(refreshTimer); }
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
    } catch (failure) {
      clearSession();
      show('login-view');
      if (failure.code === 'PANEL_ACCESS_DENIED') error('login-error', 'Esta conta não tem acesso ao painel.');
    }
  }
  async function signIn(event) {
    event.preventDefault();
    error('login-error');
    const response = await fetch(config.url + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: config.publishableKey, 'content-type': 'application/json' }, body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) return error('login-error', 'E-mail ou senha inválidos.');
    accessToken = data.access_token;
    sessionStorage.setItem('mcs_panel_token', accessToken);
    await routeSession();
  }
  async function changePassword(event) {
    event.preventDefault();
    error('password-error');
    const password = $('new-password').value;
    if (password !== $('confirm-password').value) return error('password-error', 'As senhas não coincidem.');
    try {
      await request('/api/panel/complete-password', { method: 'POST', body: JSON.stringify({ newPassword: password }) });
      await routeSession();
    } catch (failure) {
      error('password-error', failure.code === 'PASSWORD_REQUIREMENTS_NOT_MET' ? 'Use 12 caracteres, maiúscula, minúscula, número e símbolo.' : 'Não foi possível atualizar a senha.');
    }
  }
  async function boot() {
    try { config = await request('/api/panel/config'); } catch (_) { error('login-error', 'Painel indisponível no momento.'); return; }
    accessToken = sessionStorage.getItem('mcs_panel_token');
    $('login-form').addEventListener('submit', signIn);
    $('password-form').addEventListener('submit', changePassword);
    $('logout').addEventListener('click', () => { clearInterval(refreshTimer); clearSession(); show('login-view'); });
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => switchPanel(button.dataset.view)));
    $('whatsapp-files').addEventListener('change', (event) => importFiles([...event.target.files]).catch((failure) => { $('import-status').textContent = failure.message || 'Não foi possível importar o arquivo.'; }));
    const zone = $('drop-zone');
    ['dragenter', 'dragover'].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove('dragging'); }));
    zone.addEventListener('drop', (event) => importFiles([...event.dataTransfer.files]).catch((failure) => { $('import-status').textContent = failure.message || 'Não foi possível importar o arquivo.'; }));
    $('sms-form').addEventListener('submit', addSms);
    $('sms-contact').addEventListener('change', () => { $('sms-new-name-label').hidden = $('sms-contact').value !== 'new'; refreshSmsJourneys(); });
    $('attachment-upload').addEventListener('click', uploadAttachment);
    $('sms-date').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await routeSession();
  }
  boot();
})();
