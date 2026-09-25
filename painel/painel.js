(() => {
  'use strict';
  const MAX_FILES = 20;
  const MAX_ZIP = 100 * 1024 * 1024;
  const MAX_TEXT = 25 * 1024 * 1024;
  const MAX_ENTRIES = 10000;
  let config;
  let accessToken;
  let refreshToken;
  let accessExpiresAt = 0;
  let persistentSession = false;
  let refreshTimer;
  let contacts = [];
  let chats = [];
  let journeys = [];
  let senderAliases = [];
  let chatAliases = [];
  let todayItems = [];
  let recordItems = [];
  let currentView = 'today';
  let orderFilter = 'Todos';
  let orderPeriod = '30';
  let orderOffset = 0;
  let orderItems = [];
  let orderLinkTargets = [];
  let manheimJourneys = [];
  let manheimMatches = [];
  let reportView = 'today';
  let viewRequestVersion = 0;
  const $ = (id) => document.getElementById(id);
  const show = (id) => ['login-view', 'password-view', 'app-view'].forEach((view) => $(view).classList.toggle('hidden', view !== id));
  const error = (id, message) => { $(id).textContent = message || ''; };
  const importFailureMessage = (failure) => {
    const messages = {
      IMPORT_START_FAILED: 'não foi possível criar a conversa no banco',
      IMPORT_BATCH_FAILED: 'não foi possível gravar as mensagens no banco',
      IMPORT_FINISH_FAILED: 'as mensagens foram recebidas, mas a jornada não pôde ser concluída',
      CONTACT_NOT_FOUND: 'o contato escolhido não existe mais',
      CHAT_NOT_FOUND: 'o chat escolhido não existe mais',
      JOURNEY_CHOICE_REQUIRED: 'escolha a busca antes de confirmar',
      PANEL_ACCESS_DENIED: 'esta conta não tem acesso ao painel',
      AUTHENTICATION_REQUIRED: 'a sessão expirou; entre novamente'
    };
    const detail = messages[failure && failure.code] || 'não foi possível concluir a gravação';
    return `Falha na importação: ${detail}. Nenhum sucesso foi confirmado.`;
  };
  const showImportFailure = (failure) => {
    const status = $('import-status');
    status.classList.add('error');
    status.textContent = importFailureMessage(failure);
  };
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const formatDate = (value) => value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
  const formatMoney = (cents) => Number(cents) ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(Number(cents) / 100) : '—';
  const localInput = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const normalize = (value) => MCSParser.normalizeSender(value);
  const inferredContactName = (title) => MCSParser.clean(String(title || '').replace(/^WhatsApp Chat with\s+/i, '').replace(/^Conversa do WhatsApp com\s+/i, '')).slice(0, 160) || 'Contato sem nome';
  const setCount = (view, value) => document.querySelectorAll(`[data-count="${view}"]`).forEach((node) => { node.textContent = String(value || 0); });

  const request = async (path, options = {}) => {
    const retryAuth = options.retryAuth !== false;
    const fetchOptions = { ...options };
    delete fetchOptions.retryAuth;
    const response = await fetch(path, {
      ...fetchOptions,
      headers: { 'content-type': 'application/json', ...(fetchOptions.headers || {}), ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}) }
    });
    if (response.status === 401 && retryAuth && refreshToken && await refreshAccessToken()) {
      return request(path, { ...fetchOptions, retryAuth: false });
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/panel/config') {
        clearInterval(refreshTimer);
        clearSession();
        show('login-view');
        error('login-error', 'Sua sessão expirou. Entre novamente para continuar.');
      }
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
      const refs = [journey.reference_code, ...(journey.refs || []).map((item) => item.ref_code)].filter(Boolean).join(', ');
      option(journeySelect, `${journey.vehicle_text || 'Busca sem veículo'}${refs ? ` — Ref ${refs}` : ''}`, journey.id);
    });
    journeySelect.value = 'new';
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
      $('import-contact-name').value = inferredContactName(parsed.title);
      $('ref-warning').classList.toggle('hidden', !parsed.refs.length);
      updateImportChoices(parsed);
      $('import-contact').value = 'new';
      $('import-journey').value = 'new';
      ['contact-label', 'contact-name-label', 'chat-label', 'journey-label', 'ref-warning'].forEach((id) => $(id).classList.add('hidden'));
      card.classList.remove('hidden');
      $('import-status').classList.remove('error');
      $('import-status').textContent = `${filename}: arquivo lido. Confirme os dados abaixo para gravar a conversa.`;
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });

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
          $('import-status').classList.remove('error');
          $('import-status').textContent = 'Gravando conversa e mensagens…';
          card.classList.add('hidden');
          resolve({
            parsed: finalParsed, entries, isGroup, mcsSender: $('mcs-sender').value,
            contactId: isGroup || $('import-contact').value === 'new' ? null : $('import-contact').value,
            newContactName: isGroup ? null : $('import-contact').value === 'new' ? MCSParser.clean($('import-contact-name').value) : null,
            chatId: $('import-chat').value === 'new' ? null : $('import-chat').value,
            journey: isGroup ? null : { mode: $('import-journey').value === 'new' ? 'new' : 'existing', journeyId: $('import-journey').value === 'new' ? null : $('import-journey').value }
          });
        } catch (failure) {
          $('import-status').classList.add('error');
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
    const automatic = MCSParser.automaticImportMatch(initial, chatAliases, chats, senderAliases);
    const knownChat = automatic && automatic.chat;
    const knownMcs = automatic && { sender_text: automatic.mcsSender };
    let choice;
    if (knownChat && knownMcs && !initial.requiresDateOrder) {
      const parsed = MCSParser.parseWhatsApp(raw, filename, { dateOrder: initial.dateOrder });
      const ownJourneys = journeys.filter((item) => item.contact_id === knownChat.contact_id);
      const byRef = ownJourneys.filter((item) => initial.refs.some((ref) => ref === item.reference_code || (item.refs || []).some((stored) => stored.ref_code === ref)));
      const target = byRef.length === 1 ? byRef[0] : ownJourneys.length === 1 ? ownJourneys[0] : null;
      choice = {
        parsed, entries: MCSParser.assignDirections(parsed, knownMcs.sender_text), isGroup: false,
        mcsSender: knownMcs.sender_text, contactId: knownChat.contact_id, newContactName: null,
        chatId: knownChat.id, journey: target ? { mode: 'existing', journeyId: target.id } : { mode: 'new', journeyId: null }
      };
      $('import-status').textContent = `${sourceFilename}: conversa reconhecida; gravando…`;
    } else {
      choice = await reviewConversation(raw, filename, initial);
    }
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
    return { inserted, pending: done.pending, journeyId: done.journeyId || null };
  }

  async function importFiles(files) {
    if (!files.length || files.length > MAX_FILES) throw new Error('Selecione de 1 a 20 arquivos.');
    await loadQueue(false);
    let inserted = 0;
    let pending = false;
    let lastJourneyId = null;
    for (const file of files) {
      $('import-status').classList.remove('error');
      $('import-status').textContent = `Lendo ${file.name}…`;
      const sourceSha = await sha256(await file.arrayBuffer());
      const extracted = await extract(file);
      for (const item of extracted) {
        const result = await submitConversation(item.text, item.name, file.name.toLowerCase().endsWith('.zip') ? 'WHATSAPP_ZIP' : 'WHATSAPP_TXT', file.name, sourceSha);
        inserted += result.inserted;
        pending = pending || result.pending;
        lastJourneyId = result.journeyId || lastJourneyId;
      }
    }
    $('import-status').classList.remove('error');
    $('import-status').textContent = `${inserted} mensagem(ns) nova(s). ${pending ? 'Há uma dúvida real para revisar.' : 'Importação concluída.'}`;
    await loadQueue();
    if (!pending && lastJourneyId) { await switchPanel('records'); await openRecord(lastJourneyId); }
  }

  function clearRecordDetail(message = 'Escolha uma ficha.') {
    const root = $('record-detail');
    if (root) root.replaceChildren(element('p', 'muted', message));
  }

  function renderLoading(view) {
    const roots = { today: 'today-list', entry: 'entry-queue', orders: 'orders-list', qualification: 'qualification-list', manheim: 'manheim-results', records: 'records-list' };
    if (roots[view] && $(roots[view])) empty($(roots[view]), 'Carregando…');
    if (view === 'orders') $('orders-more').classList.add('hidden');
  }

  async function switchPanel(view) {
    if (!['today', 'entry', 'orders', 'qualification', 'manheim', 'records'].includes(view)) return;
    currentView = view;
    const requestVersion = ++viewRequestVersion;
    clearRecordDetail();
    const labels = { today: 'HOJE', entry: 'ENTRADA', orders: 'PEDIDOS', qualification: 'QUALIFICAÇÃO', manheim: 'MANHEIM', records: 'FICHAS' };
    Object.keys(labels).forEach((name) => $(name + '-panel').classList.toggle('hidden', name !== view));
    $('page-title').textContent = labels[view];
    document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
    renderLoading(view);
    try { await loadCurrent(view, requestVersion); } catch (_) {
      if (currentView === view && viewRequestVersion === requestVersion) renderFailure(view);
    }
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

  async function loadQueue(render = true) {
    const data = await request('/api/panel/entry');
    contacts = data.contacts || [];
    chats = data.chats || [];
    journeys = data.journeys || [];
    senderAliases = data.senderAliases || [];
    chatAliases = data.chatAliases || [];
    const select = $('sms-contact');
    const old = select.value;
    select.replaceChildren(new Option('Novo contato', 'new'));
    contacts.forEach((contact) => option(select, contact.display_name || 'Sem nome', contact.id));
    if ([...select.options].some((entry) => entry.value === old)) select.value = old;
    refreshSmsJourneys();
    setCount('entry', chats.filter((chat) => chat.resolution_status !== 'RESOLVED' || chat.hasTimeUncertain).length + (data.reviews || []).length);
    if (render) renderQueue(chats, data.reviews || []);
    return data;
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
      const uploadUrl = new URL(path);
      uploadUrl.searchParams.set('token', signed.token);
      const uploadBody = new FormData();
      uploadBody.append('cacheControl', '3600');
      uploadBody.append('', file);
      const uploaded = await fetch(uploadUrl.toString(), { method: 'PUT', headers: { 'x-upsert': 'false' }, body: uploadBody });
      if (!uploaded.ok) throw new Error('UPLOAD_FAILED');
      await request('/api/panel/attachments', { method: 'POST', body: JSON.stringify({ action: 'finalize', attachmentId: signed.attachmentId, quarantinePath: signed.quarantinePath, filename: signed.filename, mimeType: file.type }) });
      $('attachment-status').textContent = 'Anexo verificado e armazenado de forma privada.';
      $('attachment-file').value = '';
    } catch (failure) {
      $('attachment-status').textContent = ['ATTACHMENT_REJECTED', 'ATTACHMENT_ID_INVALID', 'ATTACHMENT_PATH_INVALID'].includes(failure.code) ? 'Arquivo rejeitado por tipo, tamanho, caminho ou assinatura.' : 'Não foi possível enviar o anexo.';
    }
  }

  function updateMeta(meta) {
    if (!meta) return;
    $('data-updated').textContent = formatDate(meta.dataUpdatedAt);
    $('last-whatsapp-import').textContent = meta.lastWhatsAppImportAt ? formatDate(meta.lastWhatsAppImportAt) : 'nenhuma';
  }

  function empty(root, message) {
    root.replaceChildren(element('p', 'empty-state', message));
  }

  function makeBadge(text, tone) {
    return element('span', 'badge' + (tone ? ' ' + tone : ''), text);
  }

  function waitLabel(milliseconds) {
    const hours = Math.max(0, Math.floor(Number(milliseconds || 0) / 3600000));
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  function sourceLabel(source) {
    return ({ CALCULATOR: 'Calculadora', WHATSAPP_DIRECT: 'WhatsApp', SMS_DIRECT: 'SMS', MANUAL: 'Manual' })[source] || source || 'Origem não informada';
  }

  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
  }

  function identityHeader(item, options = {}) {
    const name = item.name || item.contact && item.contact.display_name || item.contactName || 'Sem nome';
    const ref = item.referenceCode || item.reference_code || item.ref || null;
    const phone = item.phoneLast4 || String((item.phones || []).find((entry) => entry.is_current !== false)?.phone_e164 || (item.phones || [])[0]?.phone_raw || '').replace(/\D/g, '').slice(-4);
    const wrap = element('div', 'identity');
    wrap.append(element('span', 'avatar', initials(name)));
    const text = element('div');
    text.append(element('strong', '', `${name}${ref ? ` · Ref ${ref}` : ''}`));
    const details = [item.vehicleText || item.vehicle_text || 'Veículo não informado', phone ? `•••• ${phone}` : null, sourceLabel(item.source)].filter(Boolean).join(' · ');
    text.append(element('span', 'muted one-line', details));
    if (options.preview) text.append(element('span', 'one-line message-preview', options.preview));
    wrap.append(text);
    return wrap;
  }

  function makeCardClickable(card, action) {
    card.tabIndex = 0;
    card.classList.add('clickable-card');
    card.addEventListener('click', (event) => {
      if (event.target.closest('button,input,select,textarea,a,details,summary')) return;
      action();
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === card) action();
    });
  }

  function journeySwitch(item, reload) {
    const enabled = typeof item.enabled === 'boolean' ? item.enabled : item.status !== 'ENCERRADO';
    const wrap = element('div', 'journey-switch');
    const canReactivate = enabled || item.toggleManaged !== false;
    const toggle = element('button', enabled ? 'switch-on small' : 'switch-off small', enabled ? 'Ligado' : canReactivate ? 'Desligado — religar' : 'Desligado');
    toggle.type = 'button';
    toggle.disabled = !canReactivate;
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(enabled));
    toggle.addEventListener('click', async () => {
      await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'toggle_journey', journeyId: item.id, enabled: !enabled, reason: null }) });
      await reload();
    });
    wrap.append(toggle);
    if (enabled) {
      const reasons = element('details', 'switch-reasons');
      reasons.append(element('summary', '', 'Desligar com motivo'));
      const choices = element('div', 'inline-actions');
      [['MCS_PURCHASE', 'Comprou com a MCS'], ['OTHER_PURCHASE', 'Comprou em outro lugar'], ['GAVE_UP', 'Desistiu'], ['NO_RESPONSE', 'Sem resposta']].forEach(([reason, label]) => {
        const button = element('button', 'quiet small', label);
        button.type = 'button';
        button.addEventListener('click', async () => {
          await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'toggle_journey', journeyId: item.id, enabled: false, reason }) });
          await reload();
        });
        choices.append(button);
      });
      reasons.append(choices);
      wrap.append(reasons);
    } else if (item.offReason) {
      const labels = { MCS_PURCHASE: 'Comprou com a MCS', OTHER_PURCHASE: 'Comprou em outro lugar', GAVE_UP: 'Desistiu', NO_RESPONSE: 'Sem resposta' };
      wrap.append(makeBadge(labels[item.offReason] || item.offReason));
    }
    return wrap;
  }

  function renderFailure(view) {
    const roots = { today: 'today-list', entry: 'entry-queue', orders: 'orders-list', qualification: 'qualification-list', manheim: 'manheim-results', records: 'records-list' };
    if (roots[view] && $(roots[view])) empty($(roots[view]), 'Não foi possível carregar esta aba.');
  }

  async function loadCurrent(view = currentView, requestVersion = viewRequestVersion) {
    const current = () => currentView === view && viewRequestVersion === requestVersion;
    if (view === 'entry') {
      const data = await loadQueue(false);
      if (!current()) return;
      return renderQueue(data.chats || [], data.reviews || []);
    }
    if (view === 'today') {
      const data = await request('/api/panel/today');
      if (!current()) return;
      updateMeta(data.meta);
      return renderToday(data.items || []);
    }
    if (view === 'orders') {
      return loadOrders(false, view, requestVersion);
    }
    if (view === 'qualification') {
      const data = await request('/api/panel/qualification');
      if (!current()) return;
      updateMeta(data.meta);
      return renderQualification(data.items || []);
    }
    if (view === 'manheim') {
      const data = await request('/api/panel/records?view=manheim');
      if (!current()) return;
      updateMeta(data.meta);
      return renderManheim(data);
    }
    if (view === 'records') {
      const data = await request('/api/panel/records');
      if (!current()) return;
      updateMeta(data.meta);
      return renderRecords(data.items || []);
    }
  }

  async function refreshCounters() {
    const [entry, orders, qualification, manheim, records] = await Promise.all([
      request('/api/panel/entry'),
      request('/api/panel/orders?filter=Todos&period=30&limit=1&offset=0'),
      request('/api/panel/qualification'),
      request('/api/panel/records?view=manheim'),
      request('/api/panel/records')
    ]);
    setCount('entry', (entry.chats || []).filter((chat) => chat.resolution_status !== 'RESOLVED' || chat.hasTimeUncertain).length + (entry.reviews || []).length);
    setCount('orders', orders.page && orders.page.total || 0);
    setCount('qualification', (qualification.items || []).length);
    setCount('manheim', manheim.upload && manheim.upload.lead_count || 0);
    setCount('records', (records.items || []).length);
  }

  async function loadOrders(append, view = currentView, requestVersion = viewRequestVersion) {
    if (!append) {
      orderOffset = 0;
      orderItems = [];
    }
    const params = new URLSearchParams({ filter: orderFilter, period: orderPeriod, limit: '30', offset: String(orderOffset) });
    const data = await request('/api/panel/orders?' + params.toString());
    if (currentView !== view || viewRequestVersion !== requestVersion) return;
    updateMeta(data.meta);
    orderItems = append ? orderItems.concat(data.items || []) : (data.items || []);
    orderLinkTargets = data.linkTargets || orderLinkTargets;
    orderOffset = orderItems.length;
    renderOrders(orderItems, orderLinkTargets, data.page || {});
  }

  async function postAction(payload) {
    const result = await request('/api/panel/actions', { method: 'POST', body: JSON.stringify(payload) });
    await loadCurrent();
    return result;
  }

  function renderToday(items) {
    const root = $('today-list');
    root.replaceChildren();
    todayItems = items.slice();
    setCount('today', items.length);
    if (!items.length) return empty(root, 'Nenhuma pendência agora.');
    const mode = $('today-sort') ? $('today-sort').value : 'priority';
    const sorted = items.slice().sort((a, b) => mode === 'recent' ? a.waitMs - b.waitMs : mode === 'oldest' ? b.waitMs - a.waitMs : 0);
    sorted.forEach((item) => {
      const card = element('article', 'item-card');
      const head = element('div', 'item-head');
      const title = element('div');
      title.append(identityHeader(item, { preview: item.reasons.find((reason) => reason.preview)?.preview || '' }));
      const priority = element('div', 'badges');
      if (item.kind === 'CALCULATOR_ORDER') priority.append(makeBadge(waitLabel(item.waitMs), item.waitColor));
      priority.append(makeBadge(item.checklistLabel, 'blue'));
      if (item.budgetCents) priority.append(makeBadge(formatMoney(item.budgetCents), 'blue'));
      head.append(title, priority);
      const reasons = element('div', 'badges');
      item.reasons.forEach((reason) => reasons.append(makeBadge(reason.label, reason.urgency || (reason.label.includes('VENCID') ? 'red' : ''))));
      card.append(head, reasons);
      const actions = element('div', 'inline-actions');
      const open = element('button', 'quiet small', 'Abrir ficha');
      open.type = 'button';
      if (item.kind === 'CALCULATOR_ORDER') {
        open.textContent = 'Abrir pedido';
        open.addEventListener('click', () => switchPanel('orders'));
        actions.append(open);
        card.append(actions);
        makeCardClickable(card, () => switchPanel('orders'));
        root.append(card);
        return;
      }
      open.addEventListener('click', async () => { await switchPanel('records'); await openRecord(item.id); });
      makeCardClickable(card, async () => { await switchPanel('records'); await openRecord(item.id); });
      const defer = element('button', 'small', 'Adiar');
      defer.type = 'button';
      const dismiss = element('button', 'quiet small', 'Dispensar');
      dismiss.type = 'button';
      const form = element('div', 'inline-form hidden');
      const dateLabel = element('label', '', 'Até');
      const date = element('input');
      date.type = 'datetime-local';
      date.value = localInput(new Date(Date.now() + 24 * 3600000));
      dateLabel.append(date);
      const reasonLabel = element('label', '', 'Motivo');
      const reason = element('input');
      reason.maxLength = 500;
      reasonLabel.append(reason);
      const save = element('button', 'small', 'Salvar adiamento');
      save.type = 'button';
      save.addEventListener('click', async () => {
        await postAction({ action: 'suppress', journeyId: item.id, kind: item.reasons[0].kind, suppressionAction: 'DEFER', untilAt: new Date(date.value).toISOString(), reason: reason.value });
      });
      form.append(dateLabel, reasonLabel, save);
      defer.addEventListener('click', () => form.classList.toggle('hidden'));
      dismiss.addEventListener('click', () => postAction({ action: 'suppress', journeyId: item.id, kind: item.reasons[0].kind, suppressionAction: 'DISMISS' }));
      actions.append(open, defer, dismiss, journeySwitch(item, () => loadCurrent()));
      card.append(actions, form);
      root.append(card);
    });
  }

  function renderOrders(items, linkTargets, page) {
    const root = $('orders-list');
    root.replaceChildren();
    $('orders-more').classList.toggle('hidden', !page.hasMore);
    setCount('orders', page.total || items.length);
    if (!items.length) return empty(root, 'Nenhum pedido neste filtro e período.');
    items.forEach((item) => {
      const card = element('article', 'item-card');
      card.dataset.orderKey = item.key;
      const head = element('div', 'item-head');
      const title = element('div');
      const heading = item.contactName || (item.ref || item.referenceCode ? `Ref ${item.ref || item.referenceCode}` : 'Pedido direto');
      title.append(element('h3', '', heading), element('p', 'muted', item.vehicleText || 'Veículo não informado'));
      const badges = element('div', 'badges');
      const modeLabel = item.logicalMode === 'CARRO' ? 'POR CARRO IDEAL' : item.logicalMode === 'VALOR' ? 'POR ORÇAMENTO' : 'MODO NÃO INFORMADO';
      const statusTone = item.status === 'SEM RESPOSTA' ? 'yellow' : item.status === 'EM REVISÃO' ? 'red' : 'green';
      badges.append(makeBadge(item.sourceLabel), makeBadge(modeLabel), makeBadge(item.status, statusTone));
      head.append(title, badges);
      const details = element('dl', 'definition-grid order-details');
      definition(details, 'Ref', item.ref || item.referenceCode || null);
      definition(details, 'Orçamento', item.budgetCents ? formatMoney(item.budgetCents) : 'Não informado');
      definition(details, 'Pagamento', item.paymentText || 'Não informado');
      definition(details, 'Estado', item.state || 'Não informado');
      definition(details, 'ZIP', item.zip || 'Não informado');
      definition(details, 'Anos', item.yearsText || 'Não informado');
      definition(details, 'Milhas', item.mileageText || 'Não informado');
      definition(details, 'Prazo', item.deadlineText || 'Não informado');
      definition(details, 'Contato escolhido', item.contactChannel || 'Não informado');
      definition(details, 'Data', item.occurredAt ? formatDate(item.occurredAt) : 'Não informada');
      card.append(head, details);
      if (item.kind === 'CALCULATOR' && !item.link) {
        const form = element('div', 'inline-form');
        const label = element('label', '', 'Ligar a um lead');
        const select = element('select');
        select.append(new Option('Escolha uma jornada', ''));
        linkTargets.forEach((target) => select.append(new Option(target.label, `${target.journeyId}|${target.contactId}`)));
        label.append(select);
        const button = element('button', 'small', 'Ligar a um lead');
        button.type = 'button';
        button.disabled = !linkTargets.length;
        button.addEventListener('click', async () => {
          if (!select.value) return;
          const [journeyId, contactId] = select.value.split('|');
          await postAction({ action: 'link_request', journeyId, contactId, calcSid: item.sid, calcRef: item.ref, logicalMode: item.logicalMode });
        });
        form.append(label, button);
        card.append(form);
      }
      const linkedJourneyId = item.journeyId || item.link && item.link.journeyId;
      if (linkedJourneyId) makeCardClickable(card, async () => { await switchPanel('records'); await openRecord(linkedJourneyId); });
      root.append(card);
    });
  }

  function renderQualification(items) {
    const root = $('qualification-list');
    root.replaceChildren();
    setCount('qualification', items.length);
    if (!items.length) return empty(root, 'Nenhuma jornada para qualificar.');
    items.forEach((item) => {
      const card = element('article', 'item-card');
      const head = element('div', 'item-head');
      const title = element('div');
      title.append(identityHeader(item, { preview: item.latestMessage && item.latestMessage.body_text || '' }));
      const badges = element('div', 'badges');
      badges.append(makeBadge(item.checklistSummary.label, item.checklistSummary.completed === 6 ? 'green' : 'blue'), makeBadge(item.stage), makeBadge(item.enabled === false ? 'DESLIGADO' : item.status));
      if (item.shortDeadline) badges.append(makeBadge('prazo curto', 'yellow'));
      head.append(title, badges);
      card.append(head);
      item.checklist.forEach((point) => {
        const block = element('div', 'check-point' + (point.status === 'COMPLETE' ? ' complete' : ''));
        block.append(element('strong', '', `${point.point_number}. ${point.point_label}`), makeBadge(point.status === 'COMPLETE' ? 'com evidência' : point.status.toLowerCase(), point.status === 'COMPLETE' ? 'green' : ''));
        point.evidence.forEach((evidence) => block.append(element('p', 'evidence', evidence.excerpt_text)));
        card.append(block);
      });
      const open = element('button', 'quiet small', 'Abrir ficha e conversa');
      open.type = 'button';
      open.addEventListener('click', async () => { await switchPanel('records'); await openRecord(item.id); });
      makeCardClickable(card, async () => { await switchPanel('records'); await openRecord(item.id); });
      card.append(open, journeySwitch(item, () => loadCurrent()));
      root.append(card);
    });
  }

  function wishlistSummary(wish, budgetCents) {
    const years = wish && wish.yearMin && wish.yearMax ? `${wish.yearMin}–${wish.yearMax}` : wish && (wish.yearMin || wish.yearMax) || 'qualquer ano';
    const miles = wish && wish.maxMiles ? `até ${Number(wish.maxMiles).toLocaleString('pt-BR')} milhas` : 'sem limite de milhas';
    return `${wish && wish.make || 'Marca não informada'} ${wish && wish.model || 'modelo não informado'} · ${years} · ${miles}${budgetCents ? ` · teto ${formatMoney(budgetCents)}` : ''}`;
  }

  function downloadShortlist(matches, referenceCode) {
    if (!matches.length) return;
    const headers = [];
    matches.forEach((match) => (match.vehicle_json.headers || []).forEach((header) => { if (!headers.includes(header)) headers.push(header); }));
    const csv = MCSManheim.toCsv(headers, matches.map((match) => match.vehicle_json.raw));
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `shortlist-${referenceCode || 'lead'}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderManheimGroup(root, journey, matches, reactivation) {
    const card = element('article', 'item-card manheim-lead');
    const head = element('div', 'item-head');
    head.append(identityHeader(journey), makeBadge(`${matches.filter((match) => match.match_kind === 'BATE').length} BATE · ${matches.filter((match) => match.match_kind === 'QUASE').length} QUASE`, matches.some((match) => match.match_kind === 'BATE') ? 'green' : 'yellow'));
    card.append(head, element('p', 'muted', wishlistSummary(journey.wishlist, journey.budget_cents)));
    if (reactivation) {
      const reactivateButton = element('button', 'small', journey.status === 'PARADO' ? 'Retomar busca' : 'Religar busca');
      reactivateButton.type = 'button';
      reactivateButton.addEventListener('click', async () => {
        const payload = journey.status === 'PARADO'
          ? { action: 'set_funnel', journeyId: journey.id, value: 'EM_BUSCA' }
          : { action: 'toggle_journey', journeyId: journey.id, enabled: true, reason: null };
        await request('/api/panel/actions', { method: 'POST', body: JSON.stringify(payload) });
        await loadCurrent();
      });
      card.append(makeBadge(journey.status === 'PARADO' ? 'Parado — reativar' : 'Desligado — reativar', 'yellow'), reactivateButton);
    }
    const table = element('div', 'manheim-table');
    matches.forEach((match) => {
      const parsed = match.vehicle_json.parsed || {};
      const row = element('div', 'manheim-row');
      const select = element('input'); select.type = 'checkbox'; select.className = 'manheim-select'; select.dataset.matchId = match.id;
      const vehicle = element('div');
      vehicle.append(element('strong', '', [parsed.year, parsed.make, parsed.model, parsed.trim].filter(Boolean).join(' ')), element('span', 'muted', `${Number(parsed.miles || 0).toLocaleString('pt-BR')} milhas${parsed.location ? ` · ${parsed.location}` : ''}${parsed.saleDate ? ` · ${parsed.saleDate}` : ''}`));
      const badges = element('div', 'badges');
      badges.append(makeBadge(match.match_kind, match.match_kind === 'BATE' ? 'green' : 'yellow'));
      if (match.match_reason) badges.append(makeBadge(match.match_reason));
      if (match.mmr_status) badges.append(makeBadge(match.mmr_status, match.mmr_status.includes('acima') ? 'yellow' : 'blue'));
      const presented = element('button', 'quiet small', match.presented_unit_id ? 'Apresentado' : journey.enabled === false ? 'Religue antes de apresentar' : 'Apresentei ao cliente');
      presented.type = 'button'; presented.disabled = Boolean(match.presented_unit_id) || journey.enabled === false;
      presented.addEventListener('click', async () => {
        await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'unit', journeyId: journey.id, manheimMatchId: match.id, status: 'PRESENTED' }) });
        await loadCurrent();
      });
      row.append(select, vehicle, badges, presented);
      table.append(row);
    });
    card.append(table);
    const exportButton = element('button', 'quiet small', 'Exportar para shortlist');
    exportButton.type = 'button';
    exportButton.addEventListener('click', () => {
      const selected = [...card.querySelectorAll('.manheim-select:checked')].map((checkbox) => matches.find((match) => match.id === checkbox.dataset.matchId)).filter(Boolean);
      downloadShortlist(selected, journey.reference_code);
    });
    card.append(exportButton);
    root.append(card);
  }

  function renderManheim(data) {
    manheimJourneys = data.items || [];
    manheimMatches = data.matches || [];
    setCount('manheim', data.upload && data.upload.lead_count || 0);
    $('manheim-summary').textContent = data.upload ? `${data.upload.vehicle_count} carro(s) analisado(s) · ${data.upload.matched_vehicle_count} combinação(ões) · ${data.upload.lead_count} lead(s) · ${formatDate(data.upload.uploaded_at)}` : 'Nenhuma exportação processada.';
    const root = $('manheim-results');
    root.replaceChildren();
    if (!manheimMatches.length) return empty(root, 'Nenhum carro compatível no último upload.');
    const byJourney = new Map(manheimJourneys.map((journey) => [journey.id, journey]));
    const grouped = new Map();
    manheimMatches.forEach((match) => {
      if (!grouped.has(match.journey_id)) grouped.set(match.journey_id, []);
      grouped.get(match.journey_id).push(match);
    });
    const standard = element('section', 'stack');
    standard.append(element('h3', '', 'Compatíveis'));
    const reactivate = element('section', 'stack');
    reactivate.append(element('h3', '', 'Reativar'));
    let standardCount = 0;
    let reactivateCount = 0;
    grouped.forEach((matches, journeyId) => {
      const journey = byJourney.get(journeyId);
      if (!journey) return;
      const isReactivation = journey.reactivationEligible || journey.status === 'PARADO';
      if (isReactivation) { renderManheimGroup(reactivate, journey, matches.filter((match) => match.match_kind === 'BATE'), true); reactivateCount += 1; }
      else { renderManheimGroup(standard, journey, matches, false); standardCount += 1; }
    });
    if (standardCount) root.append(standard);
    if (reactivateCount) root.append(reactivate);
  }

  async function importManheim(files) {
    const selected = files.filter((file) => /\.csv$/i.test(file.name));
    if (!selected.length || selected.length !== files.length || selected.length > MAX_FILES) throw new Error('MANHEIM_FILES_INVALID');
    if (!window.MCSManheim) throw new Error('MANHEIM_READER_UNAVAILABLE');
    $('manheim-status').classList.remove('error');
    $('manheim-status').textContent = 'Lendo e comparando no navegador…';
    if (!manheimJourneys.length) {
      const data = await request('/api/panel/records?view=manheim');
      manheimJourneys = data.items || [];
    }
    const vehicles = [];
    const headerGroups = [];
    const mappings = [];
    for (const file of selected) {
      if (file.size > MAX_TEXT) throw new Error('MANHEIM_FILE_TOO_LARGE');
      const parsed = MCSManheim.parseCsv(await file.text());
      const mapping = MCSManheim.mapHeaders(parsed.headers);
      if (mapping.missing.length) {
        $('manheim-status').classList.add('error');
        $('manheim-status').textContent = `CSV incompleto: faltam ${mapping.missing.join(', ')}.`;
        return;
      }
      headerGroups.push(parsed.headers);
      mappings.push(mapping.fields);
      vehicles.push(...MCSManheim.normalizeRows(parsed, mapping));
    }
    const matches = [];
    for (const journey of manheimJourneys) {
      const enabled = journey.enabled !== false;
      const reactivation = journey.reactivationEligible || journey.status === 'PARADO';
      if (!enabled && !reactivation) continue;
      for (const vehicle of vehicles) {
        const result = MCSManheim.matchVehicle(vehicle, journey.wishlist, journey.budget_cents);
        if (!result || (reactivation && result.kind !== 'BATE')) continue;
        matches.push({
          journeyId: journey.id, kind: result.kind, reason: result.reason, mmrStatus: result.mmrStatus,
          fingerprint: MCSManheim.fingerprint(vehicle),
          vehicle: { headers: vehicle.headers, raw: vehicle.raw, parsed: { year: vehicle.year, make: vehicle.make, model: vehicle.model, trim: vehicle.trim, miles: vehicle.miles, location: vehicle.location, saleDate: vehicle.saleDate, mmrCents: vehicle.mmrCents } }
        });
      }
    }
    if (matches.length > 2000) throw new Error('MANHEIM_MATCH_LIMIT');
    const result = await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'manheim_upload', sourceFileCount: selected.length, vehicleCount: vehicles.length, headers: headerGroups, headerMap: { files: mappings }, matches }) });
    $('manheim-status').textContent = `${result.matchedVehicleCount} combinação(ões) compatível(is) em ${result.leadCount} lead(s).`;
    await loadCurrent();
    await refreshCounters();
  }

  function renderRecords(items) {
    const root = $('records-list');
    root.replaceChildren();
    recordItems = items.slice();
    setCount('records', items.length);
    if (!items.length) {
      clearRecordDetail('Nenhuma ficha selecionada.');
      return empty(root, 'Nenhuma ficha criada.');
    }
    const mode = $('records-sort') ? $('records-sort').value : 'recent';
    const sorted = items.slice().sort((a, b) => mode === 'oldest' ? Date.parse(a.updated_at) - Date.parse(b.updated_at) : mode === 'name' ? String(a.contact && a.contact.display_name || '').localeCompare(String(b.contact && b.contact.display_name || ''), 'pt-BR') : mode === 'ref' ? String(a.reference_code || '').localeCompare(String(b.reference_code || '')) : Date.parse(b.updated_at) - Date.parse(a.updated_at));
    sorted.forEach((item) => {
      const card = element('article', 'search-hit record-list-card');
      const text = identityHeader(item, { preview: item.latestMessage && item.latestMessage.body_text || '' });
      const controls = element('div', 'record-card-controls');
      controls.append(makeBadge(`${item.stage} · ${item.enabled === false ? 'DESLIGADO' : item.status}`));
      const open = element('button', 'quiet small', 'Abrir ficha');
      open.type = 'button';
      open.addEventListener('click', () => openRecord(item.id));
      controls.append(open, journeySwitch(item, () => loadCurrent()));
      card.append(text, controls);
      makeCardClickable(card, () => openRecord(item.id));
      root.append(card);
    });
  }

  function definition(list, term, value) {
    const wrapper = element('div');
    wrapper.append(element('dt', '', term), element('dd', '', value === null || value === undefined || value === '' ? '—' : value));
    list.append(wrapper);
  }

  function actionMessage(message, journeyId, reload) {
    const root = element('details', 'message-menu');
    const summary = element('summary', '', '⋯');
    summary.setAttribute('aria-label', 'Ações desta mensagem');
    root.append(summary);
    const menu = element('div', 'message-menu-panel');
    if (message.direction === 'CUSTOMER') {
      const wishlistForm = element('div', 'wishlist-menu');
      const make = element('input'); make.placeholder = 'Marca'; make.maxLength = 80;
      const model = element('input'); model.placeholder = 'Modelo'; model.maxLength = 120;
      const yearMin = element('input'); yearMin.type = 'number'; yearMin.placeholder = 'Ano de'; yearMin.min = '1900'; yearMin.max = String(new Date().getFullYear() + 2);
      const yearMax = element('input'); yearMax.type = 'number'; yearMax.placeholder = 'Ano até'; yearMax.min = '1900'; yearMax.max = String(new Date().getFullYear() + 2);
      const maxMiles = element('input'); maxMiles.type = 'number'; maxMiles.placeholder = 'Milhas até'; maxMiles.min = '0'; maxMiles.max = '2000000';
      const wishlistButton = element('button', 'quiet small', 'Carro ou faixa');
      wishlistButton.type = 'button';
      wishlistButton.addEventListener('click', async () => {
        await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({
          action: 'mark_message', journeyId, messageId: message.id, kind: 'VEHICLE',
          wishlist: { make: make.value, model: model.value, yearMin: yearMin.value || null, yearMax: yearMax.value || null, maxMiles: maxMiles.value || null }
        }) });
        await reload();
      });
      wishlistForm.append(wishlistButton, make, model, yearMin, yearMax, maxMiles);
      menu.append(wishlistForm);
      const choices = [
        ['BUDGET', 'Teto', true], ['PAYMENT', 'Pagamento', true],
        ['DEADLINE', 'Prazo', true], ['OUTSIDE_FLORIDA', 'Aceita fora da Flórida', false],
        ['NO_TEST_DRIVE', 'Entendeu sem test drive/devolução', false]
      ];
      choices.forEach(([kind, label, needsValue]) => {
        const row = element('div', 'menu-action');
        const value = element('input');
        value.maxLength = 500;
        value.value = needsValue ? String(message.body_text || '').slice(0, 500) : '';
        value.classList.toggle('hidden', !needsValue);
        const button = element('button', 'quiet small', label);
        button.type = 'button';
        button.addEventListener('click', async () => {
          await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'mark_message', journeyId, messageId: message.id, kind, value: needsValue ? value.value : null }) });
          await reload();
        });
        row.append(button, value);
        menu.append(row);
      });
      const okButton = element('button', 'small', 'Cliente deu OK');
      okButton.type = 'button';
      okButton.addEventListener('click', async () => { await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'client_ok', journeyId, messageId: message.id }) }); await reload(); });
      menu.append(okButton);
    }
    if (message.direction === 'MCS') {
      const promiseForm = element('div', 'menu-action');
      const dueLabel = element('label', '', 'Prazo da promessa');
      const due = element('input');
      due.type = 'datetime-local';
      due.value = localInput(new Date(Date.now() + 24 * 3600000));
      dueLabel.append(due);
      const dueTextLabel = element('label', '', 'Prazo em texto');
      const dueText = element('input');
      dueText.maxLength = 200;
      dueText.placeholder = 'Ex.: amanhã às 15h';
      dueTextLabel.append(dueText);
      const promiseButton = element('button', 'small', 'Marcar como promessa');
      promiseButton.type = 'button';
      promiseButton.addEventListener('click', async () => {
        await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'promise', journeyId, messageId: message.id, dueAt: new Date(due.value).toISOString(), dueText: dueText.value }) });
        await reload();
      });
      promiseForm.append(dueLabel, dueTextLabel, promiseButton);
      menu.append(promiseForm);
    }
    root.append(menu);
    return root;
  }

  async function openRecord(id) {
    const data = await request('/api/panel/records?id=' + encodeURIComponent(id));
    if (currentView !== 'records') return;
    updateMeta(data.meta);
    const item = data.item;
    const root = $('record-detail');
    root.replaceChildren();
    const reload = () => openRecord(id);
    const split = element('div', 'record-split');
    const left = element('div', 'record-data-column');
    const right = element('div', 'record-conversation-column');
    split.append(left, right);
    root.append(split);

    const dataBlock = element('section', 'record-block');
    dataBlock.append(element('h2', '', item.contact && item.contact.display_name || 'Contato sem nome'));
    const statusBadges = element('div', 'badges');
    statusBadges.append(makeBadge(item.stage), makeBadge(item.enabled ? 'LIGADO' : 'DESLIGADO', item.enabled ? 'green' : 'red'), makeBadge(item.checklistSummary.label, item.checklistSummary.completed === 6 ? 'green' : 'blue'));
    if (item.shortDeadline) statusBadges.append(makeBadge('prazo curto', 'yellow'));
    dataBlock.append(statusBadges);
    const definitions = element('dl', 'definition-grid');
    definition(definitions, 'Telefones', item.phones.map((phone) => phone.phone_e164 || phone.phone_raw).join(', '));
    definition(definitions, 'Ref', item.reference_code);
    definition(definitions, 'Refs da calculadora/conversa', item.refs.map((ref) => ref.ref_code).join(', '));
    definition(definitions, 'Origem', item.source);
    definition(definitions, 'Pagamento', item.payment_text);
    definition(definitions, 'Prazo', item.customer_deadline_text || formatDate(item.customer_deadline_at));
    dataBlock.append(definitions);
    const wishlist = element('section', 'wishlist-block');
    wishlist.append(element('h3', '', 'Lista de desejo'));
    const wishDefinitions = element('dl', 'definition-grid');
    definition(wishDefinitions, 'Marca', item.wishlist && item.wishlist.make);
    definition(wishDefinitions, 'Modelo', item.wishlist && item.wishlist.model);
    definition(wishDefinitions, 'Ano de', item.wishlist && item.wishlist.yearMin);
    definition(wishDefinitions, 'Ano até', item.wishlist && item.wishlist.yearMax);
    definition(wishDefinitions, 'Milhas até', item.wishlist && item.wishlist.maxMiles ? Number(item.wishlist.maxMiles).toLocaleString('pt-BR') : null);
    definition(wishDefinitions, 'Teto', formatMoney(item.budget_cents));
    wishlist.append(wishDefinitions);
    dataBlock.append(wishlist, journeySwitch(item, reload));
    if (item.manheimMatchCount) {
      const matchNotice = element('button', 'manheim-notice', `${item.manheimMatchCount} carro(s) do export mais recente batem · abrir Manheim`);
      matchNotice.type = 'button';
      matchNotice.addEventListener('click', () => switchPanel('manheim'));
      dataBlock.append(matchNotice);
    }

    const noteForm = element('div', 'inline-form note-form');
    const noteLabel = element('label', '', 'Nota');
    const note = element('textarea');
    note.maxLength = 4000;
    note.value = item.contact && item.contact.notes || '';
    noteLabel.append(note);
    const saveNote = element('button', 'quiet small', 'Salvar nota');
    saveNote.type = 'button';
    saveNote.addEventListener('click', async () => { await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'update_note', journeyId: id, note: note.value }) }); await reload(); });
    noteForm.append(noteLabel, saveNote);
    dataBlock.append(noteForm);

    if (item.enabled && !item.stage_frozen) {
      const operations = element('div', 'inline-actions');
      ['CALL_ANSWERED', 'CALL_ATTEMPT', 'IN_PERSON'].forEach((type) => {
        const labels = { CALL_ANSWERED: 'Ligação atendida', CALL_ATTEMPT: 'Tentativa sem resposta', IN_PERSON: 'Conversa presencial' };
        const button = element('button', 'quiet small', labels[type]);
        button.type = 'button';
        button.addEventListener('click', async () => { await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'interaction', journeyId: id, interactionType: type }) }); await reload(); });
        operations.append(button);
      });
      dataBlock.append(operations);

      const statusForm = element('div', 'inline-form');
      const statusLabel = element('label', '', 'Etapa operacional');
      const statusSelect = element('select');
      [['NOVO', 'Novo'], ['RESPONDIDO', 'Respondido'], ['EM_BUSCA', 'Em busca'], ['DECIDINDO', 'Decidindo'], ['QUALIFICADO', 'Qualificado'], ['AGUARDANDO_CLIENTE', 'Aguardando cliente'], ['PARADO', 'Parado']].forEach(([value, label]) => statusSelect.append(new Option(label, value)));
      statusSelect.value = ['AGUARDANDO_CLIENTE', 'PARADO'].includes(item.status) ? item.status : item.stage;
      statusLabel.append(statusSelect);
      const statusButton = element('button', 'small', 'Atualizar etapa');
      statusButton.type = 'button';
      statusButton.addEventListener('click', async () => { await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'set_funnel', journeyId: id, value: statusSelect.value }) }); await reload(); });
      statusForm.append(statusLabel, statusButton);
      dataBlock.append(statusForm);
    }

    if (item.divergences.length) {
      dataBlock.append(element('h3', '', 'Pendências e divergências'));
      item.divergences.forEach((divergence) => {
        const row = element('div', 'check-point');
        row.append(element('strong', '', `${divergence.field} — ${divergence.status}`));
        if (divergence.status === 'OPEN') {
          const choices = item.declarations.filter((declaration) => declaration.field === divergence.field && [divergence.left_declaration_id, divergence.right_declaration_id].includes(declaration.id));
          const select = element('select');
          choices.forEach((choice) => select.append(new Option(`${choice.source}: ${choice.value_text}`, choice.id)));
          const button = element('button', 'small', 'Usar como operacional');
          button.type = 'button';
          button.addEventListener('click', async () => { await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'resolve_divergence', journeyId: id, divergenceId: divergence.id, declarationId: select.value }) }); await reload(); });
          row.append(select, button);
        }
        dataBlock.append(row);
      });
    }
    left.append(dataBlock);

    const checklistBlock = element('section', 'record-block');
    checklistBlock.append(element('h3', '', `Checklist — ${item.checklistSummary.label}`));
    item.checklist.forEach((point) => {
      const row = element('div', 'check-point' + (point.status === 'COMPLETE' ? ' complete' : ''));
      row.append(element('strong', '', `${point.point_number}. ${point.point_label}`), makeBadge(point.status));
      point.evidence.forEach((evidence) => row.append(element('p', 'evidence', evidence.excerpt_text)));
      checklistBlock.append(row);
    });
    left.append(checklistBlock);

    const returnBlock = element('section', 'record-block');
    returnBlock.append(element('h3', '', 'Retornos'));
    const openReturns = item.returns.filter((entry) => entry.status === 'OPEN');
    if (!openReturns.length) returnBlock.append(element('p', 'muted', 'Nenhum retorno aberto.'));
    openReturns.forEach((entry) => {
      const row = element('div', 'check-point');
      row.append(element('p', 'message-body', entry.text), element('p', 'muted', `${entry.origin} · ${formatDate(entry.dueAt)}`));
      const complete = element('button', 'small', 'Concluir');
      complete.type = 'button';
      complete.addEventListener('click', async () => { await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'return_update', journeyId: id, returnKind: entry.kind, returnId: entry.kind === 'PROMISE' ? entry.id : null, operation: 'COMPLETE' }) }); await reload(); });
      const remove = element('button', 'quiet small', 'Remover');
      remove.type = 'button';
      remove.addEventListener('click', async () => { await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'return_update', journeyId: id, returnKind: entry.kind, returnId: entry.kind === 'PROMISE' ? entry.id : null, operation: 'REMOVE' }) }); await reload(); });
      row.append(complete, remove);
      returnBlock.append(row);
    });
    if (item.enabled && !item.next_action_at) {
      const nextForm = element('div', 'inline-form');
      const nextTextLabel = element('label', '', 'Retorno manual');
      const nextText = element('input'); nextText.maxLength = 500; nextTextLabel.append(nextText);
      const nextDateLabel = element('label', '', 'Data');
      const nextDate = element('input'); nextDate.type = 'datetime-local'; nextDate.value = localInput(new Date(Date.now() + 24 * 3600000)); nextDateLabel.append(nextDate);
      const nextButton = element('button', 'small', 'Adicionar retorno');
      nextButton.type = 'button';
      nextButton.addEventListener('click', async () => { await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'next_action', operation: 'CREATE', journeyId: id, text: nextText.value, at: new Date(nextDate.value).toISOString() }) }); await reload(); });
      nextForm.append(nextTextLabel, nextDateLabel, nextButton);
      returnBlock.append(nextForm);
    }
    left.append(returnBlock);

    const unitsBlock = element('section', 'record-block');
    unitsBlock.append(element('h3', '', 'Unidades apresentadas'));
    if (!item.units.length) unitsBlock.append(element('p', 'muted', 'Nenhuma unidade apresentada.'));
    item.units.forEach((unit) => {
      const row = element('div', 'check-point');
      row.append(element('strong', '', unit.vehicle_text), element('p', 'muted', formatDate(unit.presented_at)), makeBadge(unit.status));
      if (item.enabled && !item.stage_frozen) {
        const form = element('div', 'inline-form');
        const select = element('select');
        ['PRESENTED', 'UNDER_REVIEW', 'ACCEPTED', 'DECLINED', 'WITHDRAWN'].forEach((status) => select.append(new Option(status, status)));
        select.value = unit.status;
        const decline = element('input');
        decline.placeholder = 'Motivo de recusa';
        decline.maxLength = 500;
        decline.value = unit.decline_reason || '';
        const save = element('button', 'small', 'Atualizar unidade');
        save.type = 'button';
        save.addEventListener('click', async () => { await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'unit', journeyId: id, unitId: unit.id, status: select.value, declineReason: decline.value }) }); await reload(); });
        const responded = element('button', 'quiet small', 'Registrar resposta do cliente');
        responded.type = 'button';
        responded.addEventListener('click', async () => { await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'unit', journeyId: id, unitId: unit.id, status: select.value, declineReason: decline.value, customerResponded: true }) }); await reload(); });
        form.append(select, decline, save, responded);
        row.append(form);
      }
      unitsBlock.append(row);
    });
    if (item.enabled && !item.stage_frozen) {
      const addForm = element('div', 'inline-form');
      const vehicle = element('input');
      vehicle.placeholder = 'Veículo da unidade';
      vehicle.maxLength = 500;
      const status = element('select');
      status.append(new Option('Apresentada', 'PRESENTED'), new Option('Em análise', 'UNDER_REVIEW'));
      const add = element('button', 'small', 'Adicionar unidade');
      add.type = 'button';
      add.addEventListener('click', async () => { await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'unit', journeyId: id, vehicleText: vehicle.value, status: status.value }) }); await reload(); });
      addForm.append(vehicle, status, add);
      unitsBlock.append(addForm);
    }
    left.append(unitsBlock);

    const conversationBlock = element('section', 'record-block');
    conversationBlock.append(element('h3', '', 'CONVERSA'));
    const conversationControls = element('div', 'conversation-controls');
    const sortLabel = element('label', '', 'Ordenar');
    const sort = element('select');
    sort.append(new Option('Mais antigas primeiro', 'oldest'), new Option('Mais recentes primeiro', 'recent'));
    sort.value = localStorage.getItem('mcs_conversation_sort') || 'oldest';
    sortLabel.append(sort);
    const filterLabel = element('label', '', 'Mostrar');
    const filter = element('select');
    filter.append(new Option('Tudo', 'all'), new Option('Cliente', 'CUSTOMER'), new Option('MCS', 'MCS'));
    filterLabel.append(filter);
    conversationControls.append(sortLabel, filterLabel);
    conversationBlock.append(conversationControls);
    const timeline = element('div', 'conversation-timeline');
    const renderConversation = () => {
      timeline.replaceChildren();
      const entries = (item.timeline || item.conversation.map((message) => ({ ...message, timelineType: 'message', occurredAt: message.occurred_at_utc || message.occurred_at_local || message.created_at })))
        .filter((entry) => entry.timelineType !== 'message' ? filter.value === 'all' : filter.value === 'all' || entry.direction === filter.value)
        .slice()
        .sort((left, right) => {
          const delta = (Date.parse(left.occurredAt) || 0) - (Date.parse(right.occurredAt) || 0);
          return delta || (Number(left.original_order) || 0) - (Number(right.original_order) || 0) || String(left.id).localeCompare(String(right.id));
        });
      if (sort.value === 'recent') entries.reverse();
      entries.forEach((message) => {
        if (message.timelineType !== 'message') {
          const typeLabel = message.timelineType === 'interaction' ? 'Interação' : 'Sistema';
          timeline.append(element('p', `timeline-event timeline-${message.timelineType}`, `${formatDate(message.occurredAt)} · ${typeLabel} · ${message.label}`));
          return;
        }
        const row = element('article', 'message ' + message.direction.toLowerCase());
        const meta = `${message.channel} · ${message.direction === 'CUSTOMER' ? 'Cliente' : message.direction === 'MCS' ? 'MCS' : 'Sistema'} · ${formatDate(message.occurred_at_utc || message.occurred_at_local || message.created_at)}${message.time_uncertain ? ' · hora incerta' : ''}`;
        row.append(element('span', 'message-meta', meta), element('p', 'message-body', message.body_text));
        if (item.enabled && !item.stage_frozen && message.direction !== 'SYSTEM') row.append(actionMessage(message, id, reload));
        timeline.append(row);
      });
      if (!timeline.childNodes.length) timeline.append(element('p', 'muted', 'Nenhuma mensagem neste filtro.'));
    };
    sort.addEventListener('change', () => { localStorage.setItem('mcs_conversation_sort', sort.value); renderConversation(); });
    filter.addEventListener('change', renderConversation);
    conversationBlock.append(timeline);
    renderConversation();
    right.append(conversationBlock);
  }

  async function globalSearch(event) {
    event.preventDefault();
    const q = $('global-search-input').value.trim();
    if (!q) return;
    const result = await request('/api/panel/search?q=' + encodeURIComponent(q));
    const root = $('search-results');
    root.replaceChildren(element('h2', '', 'Resultados da busca'));
    if (!result.items.length) root.append(element('p', 'muted', 'Nenhum resultado.'));
    result.items.forEach((item) => {
      const button = element('button', 'search-hit');
      button.type = 'button';
      button.append(element('span', '', `${item.name}${item.vehicleText ? ` — ${item.vehicleText}` : ''}`), makeBadge(item.matchedBy));
      button.addEventListener('click', async () => {
        root.classList.add('hidden');
        if (item.kind === 'ORDER') {
          orderFilter = 'Todos';
          orderPeriod = 'all';
          document.querySelectorAll('[data-order-filter]').forEach((entry) => entry.classList.toggle('active', entry.dataset.orderFilter === orderFilter));
          document.querySelectorAll('[data-order-period]').forEach((entry) => entry.classList.toggle('active', entry.dataset.orderPeriod === orderPeriod));
          await switchPanel('orders');
          return;
        }
        if (item.journeyId) { await switchPanel('records'); await openRecord(item.journeyId); }
      });
      root.append(button);
    });
    root.classList.remove('hidden');
  }

  function openReport(view) {
    reportView = view;
    $('report-text').value = '';
    $('report-status').textContent = '';
    $('report-dialog').showModal();
  }

  async function generateReport() {
    const period = $('report-period').value;
    const params = new URLSearchParams({ period, view: reportView });
    if (period === 'custom') {
      params.set('from', $('report-from').value);
      params.set('to', $('report-to').value);
    }
    try {
      const report = await request('/api/panel/report?' + params.toString());
      $('report-text').value = report.text;
      $('report-status').textContent = `Simulações: ${report.summary.simulations} · Leads: ${report.summary.leads} · Qualificados: ${report.summary.qualified} · Desligados: ${report.summary.closed}`;
    } catch (_) {
      $('report-status').textContent = 'Não foi possível gerar o relatório para esse período.';
    }
  }

  async function copyReport() {
    if (!$('report-text').value) return;
    await navigator.clipboard.writeText($('report-text').value);
    $('report-status').textContent = 'Texto copiado.';
  }

  const SESSION_KEY = 'mcs_panel_session';
  const storeSession = () => {
    const storage = persistentSession ? localStorage : sessionStorage;
    const otherStorage = persistentSession ? sessionStorage : localStorage;
    otherStorage.removeItem(SESSION_KEY);
    storage.setItem(SESSION_KEY, JSON.stringify({ accessToken, refreshToken, accessExpiresAt }));
  };
  const acceptAuthSession = (data, remember = persistentSession) => {
    accessToken = data.access_token;
    refreshToken = data.refresh_token || refreshToken;
    accessExpiresAt = Date.now() + Math.max(0, Number(data.expires_in || 3600) - 60) * 1000;
    persistentSession = remember;
    storeSession();
  };
  const clearSession = () => {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
    accessToken = null;
    refreshToken = null;
    accessExpiresAt = 0;
    persistentSession = false;
  };
  async function refreshAccessToken() {
    if (!refreshToken || !config) return false;
    const response = await fetch(config.url + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: config.publishableKey, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      clearSession();
      return false;
    }
    acceptAuthSession(data);
    return true;
  }
  async function restoreSession() {
    let raw = localStorage.getItem(SESSION_KEY);
    persistentSession = Boolean(raw);
    if (!raw) raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    try {
      const stored = JSON.parse(raw);
      accessToken = stored.accessToken || null;
      refreshToken = stored.refreshToken || null;
      accessExpiresAt = Number(stored.accessExpiresAt || 0);
      if (!accessToken || accessExpiresAt <= Date.now()) await refreshAccessToken();
    } catch (_) {
      clearSession();
    }
  }
  const startSafeRefresh = () => {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => {
      try {
        await loadCurrent();
      } catch (_) { clearInterval(refreshTimer); }
    }, 120000);
  };
  async function routeSession() {
    if (!accessToken) return show('login-view');
    try {
      const session = await request('/api/panel/session');
      if (session.mustChangePassword) return show('password-view');
      show('app-view');
      await switchPanel('today');
      await refreshCounters();
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
    acceptAuthSession(data, $('remember-login').checked);
    $('password').value = '';
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
    await restoreSession();
    $('login-form').addEventListener('submit', signIn);
    $('password-form').addEventListener('submit', changePassword);
    $('logout').addEventListener('click', () => { clearInterval(refreshTimer); clearSession(); show('login-view'); });
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => switchPanel(button.dataset.view)));
    document.querySelectorAll('[data-order-filter]').forEach((button) => button.addEventListener('click', async () => {
      orderFilter = button.dataset.orderFilter;
      document.querySelectorAll('[data-order-filter]').forEach((item) => item.classList.toggle('active', item === button));
      if (currentView === 'orders') await loadCurrent();
    }));
    document.querySelectorAll('[data-order-period]').forEach((button) => button.addEventListener('click', async () => {
      orderPeriod = button.dataset.orderPeriod;
      document.querySelectorAll('[data-order-period]').forEach((item) => item.classList.toggle('active', item === button));
      if (currentView === 'orders') await loadCurrent();
    }));
    $('orders-more').addEventListener('click', () => loadOrders(true).catch(() => { $('orders-more').textContent = 'Não foi possível carregar'; }));
    $('today-sort').addEventListener('change', () => renderToday(todayItems));
    $('records-sort').addEventListener('change', () => renderRecords(recordItems));
    document.querySelectorAll('[data-report]').forEach((button) => button.addEventListener('click', () => openReport(button.dataset.report)));
    $('global-search').addEventListener('submit', (event) => globalSearch(event).catch(() => { $('search-results').replaceChildren(element('p', 'muted', 'Não foi possível buscar.')); $('search-results').classList.remove('hidden'); }));
    $('report-period').addEventListener('change', () => $('report-custom').classList.toggle('hidden', $('report-period').value !== 'custom'));
    $('report-generate').addEventListener('click', generateReport);
    $('report-copy').addEventListener('click', () => copyReport().catch(() => { $('report-status').textContent = 'Não foi possível copiar.'; }));
    $('whatsapp-files').addEventListener('change', (event) => importFiles([...event.target.files]).catch(showImportFailure));
    const zone = $('drop-zone');
    ['dragenter', 'dragover'].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove('dragging'); }));
    zone.addEventListener('drop', (event) => importFiles([...event.dataTransfer.files]).catch(showImportFailure));
    $('manheim-files').addEventListener('change', (event) => importManheim([...event.target.files]).catch(() => { $('manheim-status').classList.add('error'); $('manheim-status').textContent = 'Não foi possível ler ou comparar este CSV.'; }));
    const manheimZone = $('manheim-drop-zone');
    ['dragenter', 'dragover'].forEach((name) => manheimZone.addEventListener(name, (event) => { event.preventDefault(); manheimZone.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach((name) => manheimZone.addEventListener(name, (event) => { event.preventDefault(); manheimZone.classList.remove('dragging'); }));
    manheimZone.addEventListener('drop', (event) => importManheim([...event.dataTransfer.files]).catch(() => { $('manheim-status').classList.add('error'); $('manheim-status').textContent = 'Não foi possível ler ou comparar este CSV.'; }));
    $('sms-form').addEventListener('submit', addSms);
    $('sms-contact').addEventListener('change', () => { $('sms-new-name-label').hidden = $('sms-contact').value !== 'new'; refreshSmsJourneys(); });
    $('attachment-upload').addEventListener('click', uploadAttachment);
    $('sms-date').value = localInput();
    await routeSession();
  }
  boot();
})();
