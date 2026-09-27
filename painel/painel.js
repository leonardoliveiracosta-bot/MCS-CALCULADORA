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
  let pendingSituation = 'all';
  let pendingContinueTimer = null;
  let currentView = 'today';
  let orderFilter = 'Todos';
  let orderPeriod = '30';
  let orderOffset = 0;
  let orderItems = [];
  let orderLinkTargets = [];
  let manheimJourneys = [];
  let manheimOrders = [];
  let manheimMatches = [];
  let savedSearchesData = null;
  let reportView = 'today';
  let viewRequestVersion = 0;
  let detailRequestVersion = 0;
  let detailOrigin = null;
  let currentDetail = null;
  let orderHasMore = false;
  let undoTimer = null;
  let autoPrintContext = null;
  let historyImportFile = null;
  const $ = (id) => document.getElementById(id);
  const productionHost = location.hostname === 'www.mycarscout.net';
  const environmentBadge = $('environment-badge');
  if (environmentBadge) { environmentBadge.textContent = productionHost ? 'PRODUÃ‡ÃƒO' : 'PREVIEW â€” NÃƒO USE PARA TRABALHAR'; environmentBadge.classList.toggle('production', productionHost); }
  const show = (id) => ['login-view', 'password-view', 'app-view'].forEach((view) => $(view).classList.toggle('hidden', view !== id));
  const error = (id, message) => { $(id).textContent = message || ''; };
  const importFailureMessage = (failure) => {
    const messages = {
      IMPORT_START_FAILED: 'nÃ£o foi possÃ­vel criar a conversa no banco',
      IMPORT_BATCH_FAILED: 'nÃ£o foi possÃ­vel gravar as mensagens no banco',
      IMPORT_FINISH_FAILED: 'as mensagens foram recebidas, mas a jornada nÃ£o pÃ´de ser concluÃ­da',
      CONTACT_NOT_FOUND: 'o contato escolhido nÃ£o existe mais',
      CHAT_NOT_FOUND: 'o chat escolhido nÃ£o existe mais',
      JOURNEY_CHOICE_REQUIRED: 'escolha a busca antes de confirmar',
      PANEL_ACCESS_DENIED: 'esta conta nÃ£o tem acesso ao painel',
      AUTHENTICATION_REQUIRED: 'a sessÃ£o expirou; entre novamente'
    };
    const detail = messages[failure && failure.code] || 'nÃ£o foi possÃ­vel concluir a gravaÃ§Ã£o';
    return `Falha na importaÃ§Ã£o: ${detail}. Nenhum sucesso foi confirmado.`;
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
  const formatDate = (value) => value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'â€”';
  const formatMoney = (cents) => Number(cents) ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(Number(cents) / 100) : 'â€”';
  const localInput = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const zonedInput = (date, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timeZone||'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map((part)=>[part.type,part.value]));
  const localInputForZone = (date, timeZone) => { const parts=zonedInput(date,timeZone); return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`; };
  const normalize = (value) => MCSParser.normalizeSender(value);
  const inferredContactName = (title) => MCSParser.clean(String(title || '').replace(/^WhatsApp Chat with\s+/i, '').replace(/^Conversa do WhatsApp com\s+/i, '')).slice(0, 160) || 'Contato sem nome';
  const setCount = (view, value) => document.querySelectorAll(`[data-count="${view}"]`).forEach((node) => { node.textContent = String(value || 0); });

  const PAYMENT_LABELS = Object.freeze({ cash: 'Ã€ vista', fin: 'Financiado', financing: 'Financiado' });
  const DEADLINE_LABELS = Object.freeze({ none: 'Sem prazo', now: 'Agora', '30d': '30 dias', '3m': '3 meses', '6m': '6 meses', '12m': '12 meses' });
  const SOURCE_LABELS = Object.freeze({ CALCULATOR: 'Calculadora', WHATSAPP_DIRECT: 'WhatsApp direto', SMS_DIRECT: 'SMS direto', MANUAL: 'Manual' });
  const displayPayment = (value) => PAYMENT_LABELS[String(value || '').toLowerCase()] || value || 'NÃ£o informado';
  const displayDeadline = (value) => DEADLINE_LABELS[String(value || '').toLowerCase()] || value || 'Sem prazo';
  const displayModel = (value) => String(value || '').replace(/\bnot sure\b/gi, '').replace(/\bother model\b/gi, 'Outro modelo').replace(/\s{2,}/g, ' ').trim();
  const checklistStatusLabel = (status) => status === 'COMPLETE' ? 'OK' : status === 'OPEN' ? 'Pendente' : status === 'NOT_APPLICABLE' ? 'NÃ£o se aplica' : status || '';
  const orderIcon = (item) => item.logicalMode === 'VALOR' || (item.logicalModes || []).every((mode) => mode === 'VALOR') ? 'ğŸ’°' : 'ğŸš—';


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
        error('login-error', 'Sua sessÃ£o expirou. Entre novamente para continuar.');
      }
      const failure = new Error(result.error || 'REQUEST_FAILED');
      failure.code = result.error;
      failure.requestId = result.requestId || null;
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
    if (!window.zip) throw new Error('Leitor ZIP indisponÃ­vel.');
    const reader = new zip.ZipReader(new zip.BlobReader(file));
    try {
      const entries = await reader.getEntries();
      if (entries.length > MAX_ENTRIES) throw new Error('ZIP com entradas demais.');
      const txt = entries.filter((entry) => !entry.directory && /\.txt$/i.test(entry.filename));
      if (!txt.length) throw new Error('ZIP sem TXT de conversa.');
      const result = [];
      for (const entry of txt) {
        if (entry.encrypted || entry.uncompressedSize > MAX_TEXT) throw new Error('ZIP nÃ£o atende aos limites de seguranÃ§a.');
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
    chats.filter((chat) => chat.channel === 'WHATSAPP' && Boolean(chat.is_group) === group && (group || !chosenContact || chosenContact === 'new' || chat.contact_id === chosenContact)).forEach((chat) => option(chatSelect, `${chat.contact && chat.contact.display_name ? chat.contact.display_name : group ? 'Grupo existente' : 'Chat existente'} â€” ${chat.channel}`, chat.id));
    journeySelect.replaceChildren(new Option('Escolha', ''));
    option(journeySelect, 'Nova jornada', 'new');
    journeys.filter((journey) => chosenContact !== 'new' && journey.contact_id === chosenContact).forEach((journey) => {
      const refs = [journey.reference_code, ...(journey.refs || []).map((item) => item.ref_code)].filter(Boolean).join(', ');
      option(journeySelect, `${journey.vehicle_text || 'Busca sem veÃ­culo'}${refs ? ` â€” Ref ${refs}` : ''}`, journey.id);
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
      const inferredName = inferredContactName(parsed.title);
      const suggestedMcs = parsed.senders.filter((name) => !MCSParser.senderLooksLikeContact(name, inferredName));
      const senderLabel = sender.closest('label');
      sender.dataset.confirmed = suggestedMcs.length === 1 ? 'false' : 'true';
      sender.addEventListener('change', () => { sender.dataset.confirmed = 'true'; });
      if (senderLabel) {
        const labelText = senderLabel.firstChild;
        if (labelText && labelText.nodeType === Node.TEXT_NODE) labelText.textContent = 'VocÃª Ã©: ';
        if (suggestedMcs.length === 1) {
          sender.value = suggestedMcs[0];
          const example = MCSParser.senderExample(parsed, suggestedMcs[0]);
          const confirm = element('button', 'quiet small', `Confirmar: vocÃª Ã© ${suggestedMcs[0]}`);
          confirm.type = 'button';
          confirm.addEventListener('click', () => {
            sender.value = suggestedMcs[0];
            sender.dataset.confirmed = 'true';
            confirm.textContent = 'Confirmado';
            confirm.disabled = true;
          });
          senderLabel.append(confirm);
          if (example) senderLabel.append(element('span', 'muted sender-example', `Exemplo: â€œ${example}â€`));
        }
      }
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
          if (!$('chat-type').value) throw new Error('Confirme se Ã© conversa individual ou grupo.');
          if (!$('mcs-sender').value) throw new Error('Confirme qual remetente Ã© a MCS.');
          if ($('mcs-sender').dataset.confirmed === 'false') throw new Error('Confirme com um clique quem Ã© vocÃª nesta conversa.');
          const contactName = $('import-contact').value === 'new'
            ? MCSParser.clean($('import-contact-name').value)
            : ((contacts.find((item) => item.id === $('import-contact').value) || {}).display_name || inferredContactName(parsed.title));
          if (!isGroup && MCSParser.senderLooksLikeContact($('mcs-sender').value, contactName || inferredContactName(parsed.title))) {
            throw new Error('O remetente da MCS nÃ£o pode ser o mesmo nome do contato. Revise quem Ã© vocÃª.');
          }
          if (!isGroup && $('import-contact').value === 'new' && !MCSParser.clean($('import-contact-name').value)) throw new Error('Informe o nome do novo contato.');
          if (!isGroup && !$('import-journey').value) throw new Error('Escolha mesma busca ou nova jornada.');
          const finalParsed = MCSParser.parseWhatsApp(raw, filename, { dateOrder });
          if (!finalParsed.supported || finalParsed.requiresDateOrder) throw new Error('NÃ£o foi possÃ­vel confirmar as datas.');
          const entries = MCSParser.assignDirections(finalParsed, $('mcs-sender').value);
          $('import-status').classList.remove('error');
          $('import-status').textContent = 'Gravando conversa e mensagensâ€¦';
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
      form.onreset = () => { card.classList.add('hidden'); reject(new Error('ImportaÃ§Ã£o cancelada.')); };
    });
  }

  async function submitConversation(raw, filename, sourceKind, sourceFilename, sourceSha) {
    const initial = MCSParser.parseWhatsApp(raw, filename, {});
    if (!initial.supported) {
      await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'review', sourceKind, sourceFilename, sourceSha256: sourceSha }) });
      $('import-status').textContent = `${sourceFilename}: formato nÃ£o suportado â€” revisÃ£o, sem inserir mensagens.`;
      return { pending: true, inserted: 0 };
    }
    const inferredName = inferredContactName(initial.title || filename);
    const automatic = MCSParser.automaticImportMatch(initial, chatAliases, chats, senderAliases, inferredName);
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
      $('import-status').textContent = `${sourceFilename}: conversa reconhecida; gravandoâ€¦`;
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
      $('import-status').textContent = `Lendo ${file.name}â€¦`;
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
    $('import-status').textContent = `${inserted} mensagem(ns) nova(s). ${pending ? 'HÃ¡ uma dÃºvida real para revisar.' : 'ImportaÃ§Ã£o concluÃ­da.'}`;
    await loadQueue();
    if (!pending && lastJourneyId) { await switchPanel('records'); await openRecord(lastJourneyId); }
  }

  function clearRecordDetail(message = 'Escolha uma ficha.') {
    const root = $('record-detail');
    if (root) root.replaceChildren(element('p', 'muted', message));
  }

  function renderLoading(view) {
    const roots = { today: 'today-list', entry: 'entry-queue', pending: 'pending-list', orders: 'orders-list', qualification: 'qualification-list', searches: 'searches-list', manheim: 'manheim-results', records: 'records-list' };
    if (roots[view] && $(roots[view])) empty($(roots[view]), 'Carregandoâ€¦');
    if (view === 'orders') $('orders-more').classList.add('hidden');
  }

  async function switchPanel(view) {
    if (!['today', 'entry', 'pending', 'orders', 'qualification', 'searches', 'manheim', 'records'].includes(view)) return;
    if (view !== 'pending') clearTimeout(pendingContinueTimer);
    currentView = view;
    const requestVersion = ++viewRequestVersion;
    clearRecordDetail();
    const labels = { today: 'HOJE', entry: 'ENTRADA', pending: 'PENDÃŠNCIAS', orders: 'PEDIDOS', qualification: 'QUALIFICAÃ‡ÃƒO', searches: 'BUSCAS', manheim: 'MANHEIM', records: 'FICHAS' };
    currentDetail = null;
    if ($('detail-panel')) $('detail-panel').classList.add('hidden');
    Object.keys(labels).forEach((name) => $(name + '-panel').classList.toggle('hidden', name !== view));
    $('page-title').textContent = labels[view];
    document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
    renderLoading(view);
    try { await loadCurrent(view, requestVersion); } catch (_) {
      if (currentView === view && viewRequestVersion === requestVersion) renderFailure(view);
    }
  }

  function renderQueue(items, reviews) {
    items=clientSort(items,$('entry-sort')?.value||'recent');
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
      badge.textContent = chat.is_group ? 'revisÃ£o â€” grupo' : chat.resolution_status === 'RESOLVED' ? 'lida' : chat.resolution_status === 'UNIDENTIFIED' ? 'nÃ£o identificada' : 'revisÃ£o';
      header.append(title, badge);
      const count = document.createElement('span');
      count.className = 'muted';
      count.textContent = `${chat.newMessageCount} mensagem(ns) nova(s) na Ãºltima importaÃ§Ã£o`;
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
        keep.textContent = 'Manter em revisÃ£o';
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
      note.textContent = 'revisÃ£o â€” formato nÃ£o suportado â€” manter em revisÃ£o';
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

  async function loadWhatsApp() {
    const data = await request('/api/panel/whatsapp');
    const ago = (stamp) => {
      if (!stamp) return 'nenhuma ainda';
      const hours = Math.max(0, (Date.now() - Date.parse(stamp)) / 3600000);
      return hours < 1 ? `${Math.max(1, Math.floor(hours * 60))} min` : hours < 48 ? `${Math.floor(hours)} h` : `${Math.floor(hours / 24)} dias`;
    };
    $('whatsapp-signal').textContent = data.lastEventAt && Date.now() - Date.parse(data.lastEventAt) < 24 * 3600000
      ? 'Recebendo Â· Ãºltimo sinal hÃ¡ ' + ago(data.lastEventAt) : 'Sem sinal' + (data.lastEventAt ? ' hÃ¡ ' + ago(data.lastEventAt) : ' ainda');
    $('whatsapp-received').textContent = 'Ãšltima mensagem recebida hÃ¡ ' + ago(data.lastInboundAt);
    $('whatsapp-echo').textContent = 'Ãšltima mensagem enviada por vocÃª recebida hÃ¡ ' + ago(data.lastEchoAt);
    const errors = $('whatsapp-errors'); errors.replaceChildren();
    (data.errors || []).forEach((event) => {
      const row = element('div', 'queue-item');
      row.append(element('span', '', `Evento ${event.event_type} Â· ${event.status === 'ERROR' ? 'erro' : 'pendente'} Â· ${ago(event.received_at)}`));
      const retry = element('button', 'small', 'Reprocessar'); retry.type = 'button';
      retry.addEventListener('click', async () => { retry.disabled = true; try {
        await request('/api/panel/whatsapp', { method: 'POST', body: JSON.stringify({ action: 'reprocess', id: event.id }) });
        await loadWhatsApp();
      } catch (_) { retry.disabled = false; row.append(element('span', 'status error', 'NÃ£o foi possÃ­vel reprocessar.')); } });
      row.append(retry); errors.append(row);
    });
    (data.ignored||[]).forEach((event)=>errors.append(element('div','queue-item',`ignorado: ${String(event.error_code||event.event_type||'campo desconhecido').replace(/^IGNORED:/,'')}`)));
    const itemErrorLabel=(code)=>({HISTORY_DECLINED:'HistÃ³rico nÃ£o compartilhado pelo WhatsApp',PHONE_INVALID:'Telefone invÃ¡lido',PHONE_AMBIGUOUS:'Telefone ligado a mais de um contato',MESSAGE_CONTENT_INVALID:'Mensagem invÃ¡lida',ITEM_PROCESSING_FAILED:'Falha ao gravar a mensagem',PROCESSING_INTERRUPTED:'Processamento interrompido'})[code]||'Falha ao processar este item';
    (data.itemErrors||[]).forEach((event)=>{const row=element('div','queue-item');row.append(element('span','',`Item ${event.item_index+1}: ${itemErrorLabel(event.error_code)}`));const declined=event.error_code==='HISTORY_DECLINED';const retry=element('button','small',declined?'Dispensar':'Tentar de novo');retry.type='button';retry.disabled=event.status==='PROCESSING';retry.addEventListener('click',async()=>{retry.disabled=true;try{await request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:declined?'dismiss_item':'reprocess_item',id:event.id})});await loadWhatsApp();await loadQueue();}catch(error){retry.disabled=false;row.append(element('span','status error',error.message==='ITEM_ALREADY_PROCESSING'?'Este item jÃ¡ estÃ¡ sendo processado.':declined?'NÃ£o foi possÃ­vel dispensar este item.':'NÃ£o foi possÃ­vel processar este item.'));}});row.append(retry);errors.append(row);});
    const suggestions = $('whatsapp-suggestions'); suggestions.replaceChildren();
    (data.suggestions || []).forEach((item) => {
      const row = element('div', 'queue-item');
      row.append(element('strong', '', item.target_ref?`Esta conversa do WhatsApp (${item.phone_e164}) parece ser Ref ${item.target_ref}`:`Esta conversa do WhatsApp (${item.phone_e164}) parece ser a ficha ${item.targetName || 'sem nome'} â€” ${item.sourceName || 'novo contato'}`));
      if(item.motives)row.append(element('span','muted',`Motivos: ${item.motives}`));
      for (const [label, link] of [['Ligar', true], ['NÃ£o Ã©', false]]) {
        const action = element('button', link ? 'small' : 'quiet small', label); action.type = 'button';
        action.addEventListener('click', async () => { action.disabled = true; try {
          await request('/api/panel/whatsapp', { method: 'POST', body: JSON.stringify({ action: 'suggestion', id: item.id, link }) });
          await loadWhatsApp(); await loadQueue();
        } catch (_) { action.disabled = false; row.append(element('span', 'status error', 'NÃ£o foi possÃ­vel registrar a escolha.')); } });
        row.append(action);
      }
      const notLead=element('button','quiet small',item.sourceIsLead===false?'Restaurar lead':'NÃ£o Ã© lead');notLead.type='button';notLead.addEventListener('click',async()=>{notLead.disabled=true;try{await request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:'contact_lead',contactId:item.source_contact_id,isLead:item.sourceIsLead===false})});await loadWhatsApp();await loadQueue();}catch(_){notLead.disabled=false;row.append(element('span','status error','NÃ£o foi possÃ­vel atualizar este contato.'));}});row.append(notLead);
      suggestions.append(row);
    });
    (data.phoneReviews||[]).forEach((item)=>{const row=element('div','queue-item');row.append(element('strong','',`O telefone ${item.phone_e164} estÃ¡ em mais de um contato. Escolha o correto:`));(item.candidates||[]).forEach((candidate)=>{const group=element('span','inline-actions');const choose=element('button','small',candidate.name);choose.type='button';choose.addEventListener('click',async()=>{choose.disabled=true;try{await request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:'phone_review',id:item.id,contactId:candidate.id})});await loadWhatsApp();await loadQueue();}catch(_){choose.disabled=false;row.append(element('span','status error','NÃ£o foi possÃ­vel ligar a mensagem.'));}});const lead=element('button','quiet small',candidate.isLead===false?'Restaurar':'NÃ£o Ã© lead');lead.type='button';lead.addEventListener('click',async()=>{lead.disabled=true;try{await request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:'contact_lead',contactId:candidate.id,isLead:candidate.isLead===false})});await loadWhatsApp();await loadQueue();}catch(_){lead.disabled=false;}});group.append(choose,lead);row.append(group);});suggestions.append(row);});
  }

  const historyPhone = '13055400742';
  function validHistoryObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !['history', 'smb_app_state_sync'].includes(value.event) || !String(value.id || '').trim() || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) return false;
    if (value.event === 'history' && !Array.isArray(value.data.history)) return false;
    if (Object.prototype.hasOwnProperty.call(value.data, 'metadata') && String(value.data.metadata?.display_phone_number || '').replace(/\D/g, '') !== historyPhone) return false;
    return true;
  }
  function historyOrder(value) {
    const ranks = (value.data?.history || []).map((chunk) => [Number(chunk?.metadata?.phase), Number(chunk?.metadata?.chunk_order)]).filter(([phase, order]) => Number.isFinite(phase) || Number.isFinite(order));
    return ranks.sort((left, right) => (left[0] - right[0]) || (left[1] - right[1]))[0] || [Infinity, Infinity];
  }
  const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  async function import360History() {
    const status = $('history-import-status'), errors = $('history-import-errors'), sendButton = $('history-import-send');
    if (!historyImportFile) return;
    let entries;
    try { entries = JSON.parse(await historyImportFile.text()); } catch (_) { throw new Error('HISTORY_FILE_INVALID'); }
    if (!Array.isArray(entries) || !entries.length || !entries.every(validHistoryObject)) throw new Error('HISTORY_FILE_INVALID');
    const states = entries.filter((entry) => entry.event === 'smb_app_state_sync');
    const histories = entries.filter((entry) => entry.event === 'history').sort((left, right) => historyOrder(left)[0] - historyOrder(right)[0] || historyOrder(left)[1] - historyOrder(right)[1]);
    const ordered = states.concat(histories), totals = { conversations: 0, imported: 0, alreadyExists: 0, errors: 0 };
    errors.replaceChildren(); sendButton.disabled = true;
    for (let offset = 0; offset < ordered.length; offset += 10) {
      let batch = ordered.slice(offset, offset + 10), attempts = 0;
      while (batch.length) {
        status.textContent = `Importando ${Math.min(offset + (ordered.slice(offset, offset + 10).length - batch.length), ordered.length)} de ${ordered.length}â€¦`;
        const result = await request('/api/panel/history-import', { method: 'POST', body: JSON.stringify({ items: batch }) });
        totals.conversations += Number(result.conversations || 0); totals.imported += Number(result.imported || 0); totals.alreadyExists += Number(result.alreadyExists || 0); totals.errors += Number(result.errors || 0);
        if (result.more) { batch = batch.slice(Math.max(1, Number(result.nextIndex || 1))); continue; }
        if (result.inProgress && attempts++ < 8) { await pause(1000); continue; }
        if (result.inProgress) totals.errors += batch.length;
        break;
      }
      status.textContent = `Importando ${Math.min(offset + 10, ordered.length)} de ${ordered.length}â€¦`;
    }
    const summary = `Importado: ${totals.conversations} conversas, ${totals.imported} mensagens novas, ${totals.alreadyExists} jÃ¡ existiam, ${totals.errors} com erro`;
    status.textContent = summary;
    if (totals.errors) { const viewErrors = element('button', 'quiet small', 'ver erros'); viewErrors.type = 'button'; viewErrors.addEventListener('click', () => loadWhatsApp().catch(() => {})); errors.append(viewErrors); }
    historyImportFile = null; $('history-import-file').value = ''; sendButton.disabled = true;
    await Promise.all([loadWhatsApp(), loadQueue(false)]);
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
    const phone = MCSParser.clean($('sms-new-phone').value);
    if (!message || !localInput || (selected === 'new' && (!name||!phone))) {$('sms-status').textContent='Informe nome e telefone para o novo contato.';return;}
    const contactId = selected === 'new' ? null : selected;
    const existingChat = chats.find((chat) => chat.channel === 'SMS' && chat.contact_id === contactId && !chat.is_group);
    const start = await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({
      action: 'start', sourceKind: 'SMS_PASTE', sourceFilename: 'SMS manual', sourceSha256: await sha256(message + localInput),
      chat: { channel: 'SMS', chatId: existingChat ? existingChat.id : null, isGroup: false, contactId, newContactName: selected === 'new' ? name : null, phone:selected==='new'?phone:null, aliasText: 'SMS', senderAliases: [] }
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
    $('sms-status').textContent = `${batch.inserted} SMS adicionado(s)${date.timeUncertain ? ' â€” hora incerta, revisÃ£o necessÃ¡ria' : ''}.`;
    $('sms-text').value = '';
    await loadQueue();
  }

  function clearAutoPrint(){const input=$('auto-print-file');input.value='';autoPrintContext=null;$('auto-print-file-info').replaceChildren();$('auto-print-file-info').classList.add('hidden');$('auto-print-remove').classList.add('hidden');$('auto-print-send').disabled=true;$('auto-print-result').classList.add('hidden');}
  function showAutoPrintChoice(files){const info=$('auto-print-file-info');info.replaceChildren();[...files].forEach((file)=>info.append(element('span','',file.name),element('small','muted',`${(file.size/1024/1024).toFixed(1)} MB`)));info.classList.remove('hidden');$('auto-print-remove').classList.remove('hidden');$('auto-print-send').disabled=!files.length;}
  function autoPrintResult(filename,text,saved){const root=$('auto-print-result');root.classList.remove('hidden');const row=element('section',saved?'':'error');row.append(element('strong',saved?'':'warning',`${filename||'Print'} â€” ${text}`));root.append(row);return row;}
  async function saveAutoPrint(read,context,filename=read.original_filename){const values=read.extracted_json||{};const saved=await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'confirm',auto:true,readId:read.id,sourceJourneyId:context?.journeyId||null,phone:values.phone||'',name:values.name||'',ref:values.ref||'',message:values.message||'',translation:values.translation||''})});const name=saved.name||saved.phone||(saved.ref?`Pedido ${saved.ref}`:'lead novo');const root=autoPrintResult(filename,saved.duplicate?`Este print jÃ¡ foi guardado no lead de ${name} Â· Ref ${saved.ref||values.ref||'â€”'}`:`âœ“ ${saved.photoOnly?'Foto guardada':'Guardado'} no lead de ${name} Â· Ref ${saved.ref||values.ref||'â€”'}`,true);const actions=element('div','inline-actions');const open=element('button','small','Abrir lead');open.type='button';open.addEventListener('click',()=>openDetail('ficha',saved.journeyId));actions.append(open);if(!saved.duplicate){const undo=element('button','quiet small','Desfazer');undo.type='button';undo.addEventListener('click',async()=>{await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'undo',readId:read.id})});root.replaceChildren(element('strong','', `${filename||'Print'} â€” Desfeito. O arquivo permanece guardado.`));});actions.append(undo);}root.append(actions);await refreshCounters();return saved;}
  async function handleAutoPrintRead(result,context,filename){if(result.manual){const root=autoPrintResult(filename||result.read?.original_filename,'NÃ£o consegui ler agora â€” ',false);const retry=element('button','quiet small','Tentar de novo');retry.type='button';retry.addEventListener('click',async()=>{retry.disabled=true;try{await handleAutoPrintRead(await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'retry',readId:result.read.id})}),context,filename);}catch(_){retry.disabled=false;}});root.append(retry);return false;}return saveAutoPrint(result.read,context,filename);}
  async function uploadAutoPrint(file,context={}){const head=new Uint8Array(await file.slice(0,64).arrayBuffer());const signed=await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'sign',filename:file.name,mimeType:file.type,byteSize:file.size,magicBase64:btoa(String.fromCharCode(...head)),journeyId:context.journeyId||null,contactId:context.contactId||null})});const uploadUrl=new URL(signed.uploadUrl);uploadUrl.searchParams.set('token',signed.token);const uploaded=await fetch(uploadUrl.toString(),{method:'PUT',headers:{'content-type':file.type,'x-upsert':'false'},body:file});if(!uploaded.ok)throw Error('UPLOAD_FAILED');return handleAutoPrintRead(await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'read',readId:signed.readId})}),context,file.name);}
  async function sendAutoPrint(){const files=[...$('auto-print-file').files];if(!files.length)return;const status=$('auto-print-status'),result=$('auto-print-result');let failures=0;status.classList.remove('error');result.replaceChildren();result.classList.remove('hidden');$('auto-print-send').disabled=true;for(let index=0;index<files.length;index++){const file=files[index];status.textContent=`${index+1} de ${files.length}â€¦`;try{if(await uploadAutoPrint(file,autoPrintContext||{})===false)failures++;}catch(error){failures++;autoPrintResult(file.name,error.code==='SMS_PRINT_INVALID_IMAGE'?'Use uma imagem vÃ¡lida, atÃ© 10 MB.':'NÃ£o consegui enviar agora. O arquivo nÃ£o foi apagado.',false);}}$('auto-print-file').value='';$('auto-print-file-info').replaceChildren();$('auto-print-file-info').classList.add('hidden');$('auto-print-remove').classList.add('hidden');$('auto-print-send').disabled=true;autoPrintContext=null;status.textContent=`${files.length} de ${files.length} prontos${failures?` Â· ${failures} com erro`:''}`;}

  function updateMeta(meta) {
    if (!meta) return;
    $('data-updated').textContent = formatDate(meta.dataUpdatedAt);
    $('last-whatsapp-import').textContent = meta.lastWhatsAppImportAt ? formatDate(meta.lastWhatsAppImportAt) : 'nenhuma';
  }

  function pendingQuery() {
    const params=new URLSearchParams({situation:pendingSituation,sort:$('pending-sort').value,withRef:String($('pending-with-ref').checked)});
    return '/api/panel/pendencias?'+params.toString();
  }
  function pendingAgo(value) {
    const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(value||0))/60000));
    return minutes<60?`${Math.max(1,minutes)} min`:minutes<1440?`${Math.floor(minutes/60)} h`:`${Math.floor(minutes/1440)} dias`;
  }
  function pendingSituationLabel(value) {
    return {NO_RESPONSE:'ğŸ”´ Sem resposta',MCS_PENDING:'ğŸŸ  Parada com vocÃª',CUSTOMER_PENDING:'ğŸŸ¡ Parada com o cliente',IN_PROGRESS:'ğŸŸ¢ Em andamento',CLOSED:'âšª ConcluÃ­da / sem interesse'}[value]||'SituaÃ§Ã£o pendente';
  }
  function pendingTone(value) { return {NO_RESPONSE:'red',MCS_PENDING:'yellow',CUSTOMER_PENDING:'yellow',IN_PROGRESS:'green',CLOSED:''}[value]||''; }
  function pendingHeatLabel(value) { return {HOT:'ğŸ”¥ Quente',WARM:'ğŸŒ¤ Morno',COLD:'â„ï¸ Frio'}[value]||'â„ï¸ Frio'; }
  function renderPendingGeneral(data) {
    const root=$('pending-general-card'),run=data.run||{},active=run.status==='ACTIVE',paused=run.status==='PAUSED',limited=run.status==='LIMIT';
    root.replaceChildren();
    root.append(element('h2','', 'Leitura geral de todas as conversas'));
    if(!data.historyReady) {
      root.append(element('p','muted',`Aguardando o histÃ³rico terminar de chegar (Ãºltima parte hÃ¡ ${pendingAgo(data.lastHistoryAt)}).`));
      const button=element('button','quiet small','Fazer leitura geral');button.type='button';button.disabled=true;root.append(button);return;
    }
    const total=Number(run.total_conversations||0),completed=Number(run.completed_conversations||0),spent=Number(run.spent_usd||0),budget=Number(run.budget_usd||20);
    if(run.status==='IDLE'||!run.status){
      root.append(element('p','muted','LÃª todas as conversas, das mais recentes Ã s mais antigas, inclusive conversas longas em partes.'));
      const start=element('button','small','Fazer leitura geral');start.type='button';start.addEventListener('click',async()=>{start.disabled=true;try{await request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'start_general'})});await continuePendingGeneral();}catch(error){start.disabled=false;root.append(element('p','error',error.code==='HISTORY_STILL_ARRIVING'?'Aguardando o histÃ³rico terminar de chegar.':'IA indisponÃ­vel'));}});root.append(start);return;
    }
    const status=limited?'limite atingido':paused?'pausada':run.status==='COMPLETED'?'concluÃ­da':'em andamento';
    root.append(element('p','',`Leitura geral ${status}`));
    if (paused && run.last_error) root.append(element('p','error',run.last_error==='IA_UNAVAILABLE'?'IA indisponÃ­vel. O painel continua disponÃ­vel para uso manual.':'A leitura foi pausada; tente continuar novamente.'));
    const bar=element('div','pending-bar'),fill=element('i');fill.style.width=`${total?Math.min(100,completed/total*100):100}%`;bar.append(fill);root.append(bar);
    root.append(element('p','muted',`${completed} de ${total} conversas lidas Â· gasto US$ ${spent.toFixed(2)} de US$ ${budget.toFixed(2)} Â· conversas longas sÃ£o lidas em partes, atÃ© o fim`));
    const actions=element('div','inline-actions');
    if(active){const pause=element('button','quiet small','Pausar');pause.type='button';pause.addEventListener('click',async()=>{pause.disabled=true;await request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'pause_general'})});await loadPending();});actions.append(pause);}
    if(paused){const resume=element('button','small','Continuar');resume.type='button';resume.addEventListener('click',async()=>{resume.disabled=true;await request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'resume_general'})});await continuePendingGeneral();});actions.append(resume);}
    if(limited){
      root.append(element('p','warning',`${completed} de ${total} lidas â€” faltam ${Math.max(0,total-completed)}.`));
      const more=element('button','small','Liberar mais US$ 10');more.type='button';
      more.addEventListener('click',()=>{
        more.disabled=true;
        const question=element('span','muted','Liberar mais US$ 10 para concluir a leitura geral?');
        const cancel=element('button','quiet small','Cancelar');cancel.type='button';
        const approve=element('button','small','Confirmar liberaÃ§Ã£o');approve.type='button';
        const confirmation=element('div','inline-actions');confirmation.append(question,cancel,approve);
        cancel.addEventListener('click',()=>{confirmation.remove();more.disabled=false;});
        approve.addEventListener('click',async()=>{approve.disabled=true;cancel.disabled=true;try{await request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'increase_budget',confirm:true})});confirmation.remove();await continuePendingGeneral();}catch(_){approve.disabled=false;cancel.disabled=false;}});
        root.append(confirmation);
      });actions.append(more);
    }
    root.append(actions);
  }
  function renderPending(data) {
    clearTimeout(pendingContinueTimer);renderPendingGeneral(data);setCount('pending',Object.values(data.counts||{}).reduce((total,value)=>total+Number(value||0),0));
    const stats=$('pending-stats');stats.replaceChildren();[['NO_RESPONSE','ğŸ”´ Sem resposta'],['MCS_PENDING','ğŸŸ  Parada com vocÃª'],['CUSTOMER_PENDING','ğŸŸ¡ Parada com o cliente'],['IN_PROGRESS','ğŸŸ¢ Em andamento'],['CLOSED','âšª ConcluÃ­da / sem interesse']].forEach(([key,label])=>{const stat=element('div','pending-stat');stat.append(element('strong','',String(data.counts?.[key]||0)),element('span','muted',label));stats.append(stat);});
    const root=$('pending-list');root.replaceChildren();if(!(data.items||[]).length)empty(root,'Nenhuma conversa neste filtro.');
    (data.items||[]).forEach((item)=>{
      const card=element('article','item-card pending-card'),head=element('div','item-head'),identity=element('div','identity'),text=element('div'),phoneItem={phones:item.phone?[{phone_e164:item.phone,is_primary:true}]:[],ref:item.ref};text.append(element('strong','identity-name',item.name||`Pedido ${item.ref||'â€”'}`),phoneNode(phoneItem),element('span','muted one-line',`Ref ${item.ref||'â€”'} Â· ${item.vehicleText||'VeÃ­culo nÃ£o informado'}`));const direct=directLeadBadge(item);if(direct)text.append(direct);identity.append(element('span','avatar',initials(item.name)),text);head.append(identity);const badges=element('div','badges');badges.append(makeBadge(`${pendingSituationLabel(item.situation)} Â· ${item.daysStalled} dias`,pendingTone(item.situation)),makeBadge(pendingHeatLabel(item.heat),item.heat==='HOT'?'red':item.heat==='WARM'?'yellow':''));if(item.searchStageLabel)badges.append(makeBadge(item.searchStageLabel,item.searchStage==='SENT'?'green':item.searchStage==='SAVED'?'blue':'yellow'));head.append(badges);card.append(head);const contact=contactMeta(item);if(contact)card.append(contact);
      const prefix=item.latestDirection==='MCS'?'VocÃª: ':'';card.append(element('p','message-preview',prefix+item.latestMessage));if(item.translation)card.append(element('p','muted','TraduÃ§Ã£o: â€œ'+item.translation+'â€'));if(item.summary||item.nextStep){const ai=element('div','pending-ai');ai.append(element('strong','', 'IA: '),document.createTextNode(item.summary||'Sem resumo ainda'));if(item.nextStep)ai.append(element('strong','', ' PrÃ³ximo passo: '),document.createTextNode(item.nextStep));card.append(ai);}
      const actions=element('div','inline-actions');const open=element('button','small','Abrir lead/conversa');open.type='button';open.addEventListener('click',()=>openDetail('ficha',item.journeyId));const copy=element('button','quiet small','Copiar nÃºmero');copy.type='button';copy.disabled=!item.phone;copy.addEventListener('click',async()=>{copy.disabled=true;try{await navigator.clipboard.writeText(item.phone);}catch(_){copy.disabled=false;}});const resolved=element('button','quiet small','JÃ¡ resolvi');resolved.type='button';resolved.addEventListener('click',async()=>{resolved.disabled=true;try{await request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'resolve',journeyId:item.journeyId,chatId:item.chatId})});await loadPending();}catch(_){resolved.disabled=false;}});const lead=element('button','quiet small',item.isLead?'NÃ£o Ã© lead':'Restaurar lead');lead.type='button';lead.addEventListener('click',async()=>{lead.disabled=true;try{await request('/api/panel/lead?id='+encodeURIComponent(item.journeyId),{method:'POST',body:JSON.stringify({action:'contact_lead',journeyId:item.journeyId,isLead:!item.isLead})});await loadPending();}catch(_){lead.disabled=false;}});actions.append(open,copy,resolved,lead);card.append(actions);makeCardClickable(card,()=>openDetail('ficha',item.journeyId));root.append(card);
    });
    if(currentView==='pending'&&data.run?.status==='ACTIVE')pendingContinueTimer=setTimeout(()=>continuePendingGeneral().catch(()=>{}),500);
  }
  async function loadPending() { const data=await request(pendingQuery());renderPending(data);return data; }
  async function continuePendingGeneral() { if(currentView!=='pending')return;await request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'continue_general'})});return loadPending(); }
  async function downloadPendingCsv() {
    const response=await fetch(pendingQuery()+'&download=csv',{headers:accessToken?{Authorization:'Bearer '+accessToken}:{}});if(!response.ok)throw Error('DOWNLOAD_FAILED');const blob=await response.blob(),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='pendencias-mcs.csv';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
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
    return SOURCE_LABELS[source] || (source && !/^not sure$/i.test(String(source)) ? source : null);
  }

  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
  }
  function primaryPhone(item){return (item.phones||[]).find((entry)=>entry.is_primary)||(item.phones||[]).find((entry)=>entry.is_current!==false)||(item.phones||[])[0]||null;}
  function phoneDisplay(value){const raw=String(value||'');const digits=raw.replace(/\D/g,'');return digits.length===11&&digits[0]==='1'?`(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`:raw||'falta o nÃºmero';}
  function referencePhone(item){const ref=item.referenceCode||item.reference_code||item.ref||'â€”';const phone=primaryPhone(item);return `Ref ${ref} Â· ğŸ“ ${phone?phoneDisplay(phone.phone_e164||phone.phone_raw):'falta o nÃºmero'}`;}
  function phoneNode(item){const phone=primaryPhone(item);if(!phone)return element('span','identity-ref-phone phone-missing','ğŸ“ falta o nÃºmero');const raw=phone.phone_e164||phone.phone_raw;const link=element('a','identity-ref-phone phone-link','ğŸ“ '+phoneDisplay(raw));link.href='tel:'+String(raw).replace(/[^+\d]/g,'');link.addEventListener('click',(event)=>event.stopPropagation());return link;}
  function contactChannelLabel(channel){return {WHATSAPP:'ğŸ’¬ WhatsApp',WHATSAPP_HISTORY:'ğŸ’¬ WhatsApp Â· histÃ³rico',WHATSAPP_CLICK:'ğŸ’¬ Clicou em WhatsApp',SMS_CLICK:'âœ‰ï¸ Clicou em mensagem de texto',CONTACT_CLICK_UNKNOWN:'ğŸ’¬ Clicou para falar (canal nÃ£o registrado)',IMPORTED:'ğŸ“ Conversa importada/colada'}[channel]||'';}
  function floridaArrival(value){if(!value)return '';const date=new Date(value),now=new Date();const fmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',hour12:true});const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(date);const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(now);const yesterday=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(Date.now()-86400000));const prefix=day===today?'hoje':day===yesterday?'ontem':new Intl.DateTimeFormat('pt-BR',{timeZone:'America/New_York',day:'2-digit',month:'2-digit'}).format(date);return `chegou ${prefix} ${fmt.format(date)} (FlÃ³rida)`;}
  function heatBadge(item){const labels={HOT:'ğŸ”¥ Quente',WARM:'ğŸŒ¤ Morno',COLD:'â„ï¸ Frio'},tone={HOT:'red',WARM:'yellow',COLD:'blue'};const heat=String(item.heat||'').toUpperCase();return heat?makeBadge(labels[heat]||labels.COLD,tone[heat]||'blue'):null;}
  function contactMeta(item){const wrap=element('div','badges contact-meta');const channel=contactChannelLabel(item.contactChannel),arrival=floridaArrival(item.contactAt||item.lastCustomerAt);if(channel)wrap.append(makeBadge(channel,['WHATSAPP','WHATSAPP_HISTORY','WHATSAPP_CLICK'].includes(item.contactChannel)?'green':item.contactChannel==='SMS_CLICK'?'yellow':'blue'));if(arrival)wrap.append(makeBadge(arrival));const heat=heatBadge(item);if(heat){const details=element('details','temperature-details'),summary=element('summary','');summary.append(heat);details.append(summary,element('p','temperature-explanation',item.heatSource==='AI'?`Temperatura da IA: ${item.aiSummary||'Sem resumo.'}${item.aiNextStep?' PrÃ³ximo passo: '+item.aiNextStep:''}`:'Temperatura calculada: telefone, checklist, prazo, orÃ§amento x Manheim, conversa recente e horÃ¡rio.'));wrap.append(details);}return wrap.childNodes.length?wrap:null;}
  function directLeadLabel(item){return item?.directLeadSource==='WHATSAPP_DIRECT'?'ğŸ“± veio direto pelo WhatsApp (sem calculadora)':item?.directLeadSource==='SMS_DIRECT'?'âœ‰ï¸ veio direto por SMS (sem calculadora)':'';}
  function directLeadBadge(item){const label=directLeadLabel(item);return label?makeBadge(label,'blue'):null;}
  function clientSort(items,mode){const missing=(v)=>v===null||v===undefined||v==='';const value=(x)=>Number(x.confirmed_total_ceiling_cents||x.budgetCents||x.budget_cents)||null;const stamp=(x)=>Date.parse(x.last_seen_at||x.updated_at||x.occurredAt||x.created_at||0)||0;const field=(x,kind)=>kind==='location'?(x.state||x.estado||x.contact?.location_text):kind==='vehicle'?(x.make||x.vehicleText||x.vehicle_text):value(x);return items.slice().sort((a,b)=>{if(mode==='recent'||mode==='oldest')return(stamp(b)-stamp(a))*(mode==='recent'?1:-1);const av=field(a,mode),bv=field(b,mode);if(missing(av))return missing(bv)?0:1;if(missing(bv))return -1;if(mode==='value_desc'||mode==='value_asc')return(av-bv)*(mode==='value_desc'?-1:1);return String(av).localeCompare(String(bv),'pt-BR');});}

  function identityHeader(item, options = {}) {
    const ref = item.referenceCode || item.reference_code || item.ref || null;
    const name = item.name || item.contact && item.contact.display_name || item.contactName || (ref ? `Pedido ${ref}` : 'Pedido');
    const wrap = element('div', 'identity');
    wrap.append(element('span', 'avatar', initials(name)));
    const text = element('div');
    text.append(element('strong', 'identity-name', name), phoneNode(item));
    const details = [`Ref ${ref||'â€”'}`, item.vehicleText || item.vehicle_text || 'VeÃ­culo nÃ£o informado', item.budgetCents||item.budget_cents ? formatMoney(item.budgetCents||item.budget_cents) : null].filter(Boolean).join(' Â· ');
    text.append(element('span', 'muted one-line', details));
    const direct=directLeadBadge(item);if(direct)text.append(direct);
    const contact=contactMeta(item);if(contact)text.append(contact);
    if (options.preview) text.append(element('span', 'one-line message-preview', options.preview));
    wrap.append(text);
    return wrap;
  }

  function smsPrintMissing(item) {
    if(item.contactChannel!=='SMS_CLICK'||item.smsPrintConfirmed)return null;
    const block=element('section','sms-print-missing'); block.append(element('strong','', 'Falta o print do SMS'),element('p','', 'Tire um print da mensagem no seu celular, com o nÃºmero e a Ref, e anexe aqui.'));
    const attach=element('label','small','ğŸ“· Anexar print do SMS'),input=element('input');input.type='file';input.accept='image/*';input.multiple=true;input.hidden=true;attach.append(input);const absent=element('button','quiet small','NÃ£o chegou SMS'); absent.type='button';
    input.addEventListener('change',async()=>{const files=[...input.files];if(!files.length)return;const context={journeyId:item.journeyId||item.id||null,contactId:item.contact_id||item.contact?.id||null};attach.classList.add('disabled');for(const file of files){try{await uploadAutoPrint(file,context);}catch(_){block.append(element('p','status error','NÃ£o consegui ler agora â€” tente mais tarde.'));}}attach.classList.remove('disabled');input.value='';});
    absent.addEventListener('click',()=>setDisposition({...item,kind:item.kind||'JOURNEY',id:item.id||item.journeyId},'DISCARDED'));
    const actions=element('div','inline-actions'); actions.append(attach,absent); block.append(actions);
    return block;
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
    const toggle = element('button', enabled ? 'switch-on small' : 'switch-off small', enabled ? 'Ligado' : canReactivate ? 'Desligado â€” religar' : 'Desligado');
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
      reasons-yç~­¢G§²ÚîÆ­yÖæ÷&ÖÆ—¦VCÔÔ54Öæ†V–Òææ÷&ÖÆ—¦U&÷w2‡'6VBÂÖ–ær“·'6VD6÷VçG2çW6‚‡¶–væ÷&VC§'6VBç&÷w2æÆVæwF‚Öæ÷&ÖÆ—¦VBæÆVæwF‡Ò“·fV†–6ÆW2çW6‚‚ââææ÷&ÖÆ—¦VB“°¢Ğ¢6öç7B–væ÷&VE&÷w2Ò†VFW$w&÷W2ç&VGV6R‚‡7VÒÅòÆ–æFW‚“Óç7VÒ²‡'6VD6÷VçG5¶–æFW…Óòæ–væ÷&VGÇÃ’Ã“°¢6öç7BÖF6†W2ÒµÓ°¢f÷"†6öç7B¦÷W&æW’öbÖæ†V–Ô¦÷W&æW—2’°¢6öç7BVæ&ÆVBÒ¦÷W&æW’æVæ&ÆVBÓÒfÇ6S°¢6öç7B&V7F—fF–öâÒ¦÷W&æW’ç&V7F—fF–öäVÆ–v–&ÆRÇÂ¦÷W&æW’ç7FGW2ÓÓÒu$Dòs°¢–b‚Væ&ÆVBbb&V7F—fF–öâ’6öçF–çVS°¢f÷"†6öç7BfV†–6ÆRöbfV†–6ÆW2’°¢6öç7B&W7VÇBÒÔ54Öæ†V–ÒæÖF6…fV†–6ÆR‡fV†–6ÆRÂ¦÷W&æW’çv—6†Æ—7G2ÇÂ¦÷W&æW’çv—6†Æ—7BÂ¦÷W&æW’æ'VFvWEö6VçG2“°¢–b‚&W7VÇBÇÂ‡&V7F—fF–öâbb&W7VÇBæ¶–æBÓÒt$DRr’’6öçF–çVS°¢ÖF6†W2çW6‚‡°¢¦÷W&æW”–C¢¦÷W&æW’æ–BÂ¶–æC¢&W7VÇBæ¶–æBÂ&V6öã¢&W7VÇBç&V6öâÂÖ×%7FGW3¢&W7VÇBæÖ×%7FGW2À¢f–ævW'&–çC¢Ô54Öæ†V–Òæf–ævW'&–çB‡fV†–6ÆR’À¢fV†–6ÆS¢²†VFW'3¢fV†–6ÆRæ†VFW'2Â&s¢fV†–6ÆRç&rÂ'6VC¢°¢f–ã¢fV†–6ÆRçf–âÂ–V#¢fV†–6ÆRç–V"ÂÖ¶S¢fV†–6ÆRæÖ¶RÂÖ¶T–æfW'&VC¢fV†–6ÆRæÖ¶T–æfW'&VBÂÖ¶Tæ÷F–6S¢fV†–6ÆRæÖ¶Tæ÷F–6RÀ¢ÖöFVÃ¢fV†–6ÆRæÖöFVÂÂG&–Ó¢fV†–6ÆRçG&–ÒÂÖ–ÆW3¢fV†–6ÆRæÖ–ÆW2ÂÆö6F–öã¢fV†–6ÆRæÆö6F–öâÂÆö6F–öäF—7Æ“¢fV†–6ÆRæÆö6F–öäF—7Æ’À¢6ÆTFFS¢fV†–6ÆRç6ÆTFFRÂÖ×$6VçG3¢fV†–6ÆRæÖ×$6VçG2ÂW‡FW&–÷$6öÆ÷#¢fV†–6ÆRæW‡FW&–÷$6öÆ÷"Â–çFW&–÷$6öÆ÷#¢fV†–6ÆRæ–çFW&–÷$6öÆ÷"À¢'W”æ÷u&–6S¢fV†–6ÆRæ'W”æ÷u&–6RÂ6öæF—F–öäw&FS¢fV†–6ÆRæ6öæF—F–öäw&FP¢ÒĞ¢Ò“°¢Ğ¢Ğ¢f÷"†6öç7B÷&FW"öbÖæ†V–Ô÷&FW'2æf–ÇFW"‚†—FVÒ’Óâ—FVÒæF—7÷6—F–öâÓÒtD•44$DTBr’’°¢f÷"†6öç7BfV†–6ÆRöbfV†–6ÆW2’°¢6öç7B&W7VÇBÒÔ54Öæ†V–ÒæÖF6„÷&FW"‡fV†–6ÆRÂ÷&FW"“°¢–b‚&W7VÇB’6öçF–çVS°¢ÖF6†W2çW6‚‡°¢F&vWEG—S¢tõ$DU"rÂ6Æ5&Vc¢÷&FW"ç&VbÂ¶–æC¢&W7VÇBæ¶–æBÂ&V6öã¢&W7VÇBç&V6öâÂÖ×%7FGW3¢&W7VÇBæÖ×%7FGW2À¢f–ævW'&–çC¢Ô54Öæ†V–Òæf–ævW'&–çB‡fV†–6ÆR’À¢fV†–6ÆS¢²†VFW'3¢fV†–6ÆRæ†VFW'2Â&s¢fV†–6ÆRç&rÂ'6VC¢°¢f–ã¢fV†–6ÆRçf–âÂ–V#¢fV†–6ÆRç–V"ÂÖ¶S¢fV†–6ÆRæÖ¶RÂÖ¶T–æfW'&VC¢fV†–6ÆRæÖ¶T–æfW'&VBÂÖ¶Tæ÷F–6S¢fV†–6ÆRæÖ¶Tæ÷F–6RÀ¢ÖöFVÃ¢fV†–6ÆRæÖöFVÂÂG&–Ó¢fV†–6ÆRçG&–ÒÂÖ–ÆW3¢fV†–6ÆRæÖ–ÆW2ÂÆö6F–öã¢fV†–6ÆRæÆö6F–öâÂÆö6F–öäF—7Æ“¢fV†–6ÆRæÆö6F–öäF—7Æ’À¢6ÆTFFS¢fV†–6ÆRç6ÆTFFRÂÖ×$6VçG3¢fV†–6ÆRæÖ×$6VçG2ÂW‡FW&–÷$6öÆ÷#¢fV†–6ÆRæW‡FW&–÷$6öÆ÷"Â–çFW&–÷$6öÆ÷#¢fV†–6ÆRæ–çFW&–÷$6öÆ÷"À¢'W”æ÷u&–6S¢fV†–6ÆRæ'W”æ÷u&–6RÂ6öæF—F–öäw&FS¢fV†–6ÆRæ6öæF—F–öäw&FP¢ÒĞ¢Ò“°¢Ğ¢Ğ¢–b†ÖF6†W2æÆVæwF‚â#’F‡&÷ræWrW'&÷"‚tÔä„T”ÕôÔD4…ôÄ”Ô•Br“°¢6öç7B&W7VÇBÒv—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢vÖæ†V–Õ÷WÆöBrÂ6÷W&6Tf–ÆT6÷VçC¢6VÆV7FVBæÆVæwF‚ÂfV†–6ÆT6÷VçC¢fV†–6ÆW2æÆVæwF‚Â†VFW'3¢†VFW$w&÷W2Â†VFW$Ö¢²f–ÆW3¢Ö–æw2ÒÂÖF6†W2Ò’Ò“°¢–b‡&W7VÇBçWÆöD–B’°¢6öç7B6VVâÒæWr6WB‚“°¢6öç7B&6†—fRÒfV†–6ÆW2æf–ÇFW"‚‡fV†–6ÆR’Óâ²6öç7B–BÒÔ54Öæ†V–Òæf–ævW'&–çB‡fV†–6ÆR“²–b‡6VVâæ†2†–B’’&WGW&âfÇ6S²6VVâæFB†–B“²&WGW&âG'VS²Ò“°¢ÆWB&6†—fVCÓÂ–væ÷&VCÖ–væ÷&VE&÷w3°¢f÷"†ÆWB–æFW‚Ò²–æFW‚Â&6†—fRæÆVæwFƒ²–æFW‚³Ò’°¢6öç7B6fVCÖv—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢vÖæ†V–Õö&6†—fRrÂWÆöD–C¢&W7VÇBçWÆöD–BÀ¢fV†–6ÆW3¢&6†—fRç6Æ–6R†–æFW‚Â–æFW‚²’æÖ‚‡fV†–6ÆR’Óâ‡²f–ævW'&–çC¢Ô54Öæ†V–Òæf–ævW'&–çB‡fV†–6ÆR’ÂfV†–6ÆS¢°¢f–ã¢fV†–6ÆRçf–âÂ–V#¢fV†–6ÆRç–V"ÂÖ¶S¢fV†–6ÆRæÖ¶RÂÖöFVÃ¢fV†–6ÆRæÖöFVÂÂG&–Ó¢fV†–6ÆRçG&–ÒÀ¢Ö–ÆW3¢fV†–6ÆRæÖ–ÆW2ÂÆö6F–öã¢fV†–6ÆRæÆö6F–öâÂÆö6F–öäF—7Æ“¢fV†–6ÆRæÆö6F–öäF—7Æ’À¢6ÆTFFS¢fV†–6ÆRç6ÆTFFRÂÖ×$6VçG3¢fV†–6ÆRæÖ×$6VçG0¢ÒÒ’’Ò’Ò“°¢&6†—fVB³×6fVBæ&6†—fVGÇÃ¶–væ÷&VB³×6fVBæ–væ÷&VGÇÃ°¢Ğ¢B‚vÖæ†V–Ò×7FGW2r’çFW‡D6öçFVçBÒG¶&6†—fVGÒ6'&÷2'V—fF÷2ÂG¶–væ÷&VGÒ–væ÷&F÷6°¢Ğ¢v—BÆöD7W'&VçB‚“°¢v—B&Vg&W6„6÷VçFW'2‚“°¢Ğ ¢gVæ7F–öâ6†÷tÖæ†V–Ôf–ÇW&R†f–ÇW&R’°¢6öç7BÖW76vW2Ò°¢Ôä„T”Õôd”ÄUõDôõôÄ$tS¢tò55bW†6VFRòÆ–Ö—FRW&Ö—F–FòârÀ¢Ôä„T”Õôd”ÄUõ$TEôd”ÄTC¢tòæfVvF÷"ì:6ò6öç6VwV—RÆW"ò55b6VÆV6–öæFòâ6VÆV6–öæRò'V—fòæ÷fÖVçFRârÀ¢Ôä„T”ÕôÔD4…ôÄ”Ô•C¢tò55bvW&÷R6öÖ&–æ:|;VW2FVÖ—3²&VGW¦ò'V—fòârÀ¢Ôä„T”ÕõUÄôEô”ådÄ”C¢tò&W7VÖòFò55bì:6ò76÷RæfÆ–F:|:6òârÀ¢Ôä„T”ÕôÔD4…ô”ådÄ”C¢uVÖÆ–æ†6ö×L:×fVÂì:6ò76÷RæfÆ–F:|:6òârÀ¢Ôä„T”Õô¤õU$äU•ôD•4$ÄTC¢uVÖ'W66ì:6òW7L:F—7öì:×fVÂ&6ö×&:|:6òârÀ¢”ÄôEõDôõôÄ$tS¢tò&W7VÇFFò6ö×L:×fVÂW†6VFRòÆ–Ö—FRFRVçf–òârÀ¢äTÅô5D”ôåôd”ÄTC¢t6ö×&:|:6òfö’Æ–FÂÖ2ì:6ò;FFR6W"w&fFâFVçFRæ÷fÖVçFRâp¢Ó°¢6öç7BÖöGVÆTÖ—76–ærÒf–ÇW&Rbbf–ÇW&RæÖW76vRÓÓÒtÔ54Öæ†V–Ò—2æ÷BFVf–æVBs°¢B‚vÖæ†V–Ò×7FGW2r’æ6Æ74Æ—7BæFB‚vW'&÷"r“°¢B‚vÖæ†V–Ò×7FGW2r’çFW‡D6öçFVçBÒÖöGVÆTÖ—76–æròtòÆV—F÷"FR55bì:6ò6'&Vv÷RâGVÆ—¦R:v–æRFVçFRæ÷fÖVçFRâr¢ÖW76vW5¶f–ÇW&Rbbf–ÇW&Ræ6öFUÒÇÂtì:6òfö’÷7<:×fVÂÆW"÷R6ö×&"W7FR55bâs°¢Ğ ¢gVæ7F–öâ&VæFW%&V6÷&G2†—FV×2’°¢6öç7B&ö÷BÒB‚w&V6÷&G2ÖÆ—7Br“°¢&ö÷Bç&WÆ6T6†–ÆG&Vâ‚“°¢&V6÷&D—FV×2Ò—FV×2ç6Æ–6R‚“°¢6WD6÷VçB‚w&V6÷&G2rÂ—FV×2æÆVæwF‚“°¢–b‚—FV×2æÆVæwF‚’°¢6ÆV%&V6÷&DFWF–Â‚tæVæ‡VÖf–6†6VÆV6–öæFâr“°¢&WGW&âV×G’‡&ö÷BÂtæVæ‡VÖf–6†7&–Fâr“°¢Ğ¢6öç7B6÷'FVBÒ—FV×2ç6Æ–6R‚“°¢6÷'FVBæf÷$V6‚‚†—FVÒ’Óâ°¢6öç7B6&BÒVÆVÖVçB‚v'F–6ÆRrÂw6V&6‚Ö†—B&V6÷&BÖÆ—7BÖ6&Br“°¢6öç7BFW‡BÒ–FVçF—G”†VFW"†—FVÒÂ²&Wf–Ws¢—FVÒæÆFW7DÖW76vRbb—FVÒæÆFW7DÖW76vRæ&öG•÷FW‡BÇÂrrÒ“°¢6öç7B6öçG&öÇ2ÒVÆVÖVçB‚vF—brÂw&V6÷&BÖ6&BÖ6öçG&öÇ2r“°¢6öç7B&V6÷&E7FGW2Ò—FVÒæVæ&ÆVBÓÓÒfÇ6RòtDU4Ä”tDòr¢—FVÒç7FGW3°¢6öçG&öÇ2æVæB†Ö¶T&FvR†—FVÒç7FvRÂ—FVÒç7FvRÓÓÒu$U5ôäD”Dòròv&ÇVRr¢rr’ÂÖ¶T&FvR‡&V6÷&E7FGW2Â&V6÷&E7FGW2ÓÓÒtD•dòròvw&VVâr¢&V6÷&E7FGW2ÓÓÒu$U5ôäD”Dòròv&ÇVRr¢rr’“°¢–b†—FVÒç6V&6…7FvTÆ&VÂ–6öçG&öÇ2æVæB†Ö¶T&FvR†—FVÒç6V&6…7FvTÆ&VÂÆ—FVÒç6V&6…7FvSÓÓÒu4TåBsòvw&VVâs¦—FVÒç6V&6…7FvSÓÓÒu4dTBsòv&ÇVRs¢w–VÆÆ÷rr’“°¢6öç7B†VCÖ†VD&FvR†—FVÒ“¶–b††VB–6öçG&öÇ2æVæB††VB“°¢–b†—FVÒçVæF–æt”6÷VçB–6öçG&öÇ2æVæB†Ö¶T&FvR†	ù9ÒG¶—FVÒçVæF–æt”6÷VçGÒ—FVç2&6öæf—&Ö&Âw–VÆÆ÷rr’“°¢–b†—FVÒæ”Æ–æµ7VvvW7FVB–6öçG&öÇ2æVæB†Ö¶T&FvR‚	ùIrÆ–v:|:6ò7VvW&–FrÂw–VÆÆ÷rr’“°¢6öç7B÷VâÒVÆVÖVçB‚v'WGFöârÂwV–WB6ÖÆÂrÂt'&—"f–6†r“°¢÷VâçG—RÒv'WGFöâs°¢÷VâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ÷VäFWF–Â‚vf–6†rÂ—FVÒæ–B’“°¢6öçG&öÇ2æVæB†÷VâÂ¦÷W&æW•7v—F6‚†—FVÒÂ‚’ÓâÆöD7W'&VçB‚’’“°¢6&BæVæB‡FW‡BÂ6öçG&öÇ2“°¢Ö¶T6&D6Æ–6¶&ÆR†6&BÂ‚’Óâ÷VäFWF–Â‚vf–6†rÂ—FVÒæ–B’“°¢&ö÷BæVæB†6&B“°¢Ò“°¢Ğ ¢gVæ7F–öâFVf–æ—F–öâ†Æ—7BÂFW&ÒÂfÇVR’°¢6öç7Bw&W"ÒVÆVÖVçB‚vF—br“°¢w&W"æVæB†VÆVÖVçB‚vGBrÂrrÂFW&Ò’ÂVÆVÖVçB‚vFBrÂrrÂfÇVRÓÓÒçVÆÂÇÂfÇVRÓÓÒVæFVf–æVBÇÂfÇVRÓÓÒrrò~(	Br¢fÇVR’“°¢Æ—7BæVæB‡w&W"“°¢Ğ ¢gVæ7F–öâ7F–öäÖW76vR†ÖW76vRÂ¦÷W&æW”–BÂ&VÆöBÂ&VbÂ7W7FöÖW%F–ÖW¦öæR’°¢6öç7B&ö÷BÒVÆVÖVçB‚vFWF–Ç2rÂvÖW76vRÖÖVçRr“°¢6öç7B7VÖÖ'’ÒVÆVÖVçB‚w7VÖÖ'’rÂrrÂ~(ºòr“°¢7VÖÖ'’ç6WDGG&–'WFR‚v&–ÖÆ&VÂrÂt:|;VW2FW7FÖVç6vVÒr“°¢&ö÷BæVæB‡7VÖÖ'’“°¢6öç7BÖVçRÒVÆVÖVçB‚vF—brÂvÖW76vRÖÖVçR×æVÂr“°¢–b†ÖW76vRæF—&V7F–öâÓÓÒt5U5DôÔU"r’°¢6öç7Bv—6†Æ—7Df÷&ÒÒVÆVÖVçB‚vF—brÂwv—6†Æ—7BÖÖVçRr“°¢6öç7Bv—6†Æ—7E&÷w2ÒµÓ°¢6öç7BFEv—6†Æ—7E&÷rÒ‚’Óâ°¢–b‡v—6†Æ—7E&÷w2æÆVæwF‚ãÒR’&WGW&ã°¢6öç7B&÷rÒVÆVÖVçB‚vF—brÂwv—6†Æ—7B×&÷rr“°¢6öç7BÖ¶RÒVÆVÖVçB‚v–çWBr“²Ö¶RçÆ6V†öÆFW"ÒtÖ&6s²Ö¶RæÖ„ÆVæwF‚Òƒ°¢6öç7BÖöFVÂÒVÆVÖVçB‚v–çWBr“²ÖöFVÂçÆ6V†öÆFW"ÒtÖöFVÆòs²ÖöFVÂæÖ„ÆVæwF‚Ò#°¢6öç7B–V$Ö–âÒVÆVÖVçB‚v–çWBr“²–V$Ö–âçG—RÒvçVÖ&W"s²–V$Ö–âçÆ6V†öÆFW"ÒtæòFRs²–V$Ö–âæÖ–âÒs“s²–V$Ö–âæÖ‚Ò7G&–ær†æWrFFR‚’ævWDgVÆÅ–V"‚’²"“°¢6öç7B–V$Ö‚ÒVÆVÖVçB‚v–çWBr“²–V$Ö‚çG—RÒvçVÖ&W"s²–V$Ö‚çÆ6V†öÆFW"ÒtæòL:’s²–V$Ö‚æÖ–âÒs“s²–V$Ö‚æÖ‚Ò7G&–ær†æWrFFR‚’ævWDgVÆÅ–V"‚’²"“°¢6öç7BÖ„Ö–ÆW2ÒVÆVÖVçB‚v–çWBr“²Ö„Ö–ÆW2çG—RÒvçVÖ&W"s²Ö„Ö–ÆW2çÆ6V†öÆFW"ÒtÖ–Æ†2L:’s²Ö„Ö–ÆW2æÖ–âÒss²Ö„Ö–ÆW2æÖ‚Òs#s°¢&÷ræVæB†Ö¶RÂÖöFVÂÂ–V$Ö–âÂ–V$Ö‚ÂÖ„Ö–ÆW2“°¢v—6†Æ—7E&÷w2çW6‚‡²Ö¶RÂÖöFVÂÂ–V$Ö–âÂ–V$Ö‚ÂÖ„Ö–ÆW2Ò“°¢v—6†Æ—7Df÷&ÒæVæB‡&÷r“°¢Ó°¢FEv—6†Æ—7E&÷r‚“°¢6öç7BFEfV†–6ÆRÒVÆVÖVçB‚v'WGFöârÂwV–WB6ÖÆÂrÂr²÷WG&ò6'&òr“°¢FEfV†–6ÆRçG—RÒv'WGFöâs°¢FEfV†–6ÆRæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂFEv—6†Æ—7E&÷r“°¢6öç7Bv—6†Æ—7D'WGFöâÒVÆVÖVçB‚v'WGFöârÂwV–WB6ÖÆÂrÂt6'&ò÷Rf—†r“°¢v—6†Æ—7D'WGFöâçG—RÒv'WGFöâs°¢v—6†Æ—7D'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ°¢6öç7Bv—6†Æ—7G2Òv—6†Æ—7E&÷w2æf–ÇFW"‚‡&÷r’Óâ&÷ræÖöFVÂçfÇVRçG&–Ò‚’’æÖ‚‡&÷r’Óâ‡°¢Ö¶S¢&÷ræÖ¶RçfÇVRÂÖöFVÃ¢&÷ræÖöFVÂçfÇVRÂ–V$Ö–ã¢&÷rç–V$Ö–âçfÇVRÇÂçVÆÂÀ¢–V$Öƒ¢&÷rç–V$Ö‚çfÇVRÇÂçVÆÂÂÖ„Ö–ÆW3¢&÷ræÖ„Ö–ÆW2çfÇVRÇÂçVÆÀ¢Ò’“°¢v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡°¢7F–öã¢vÖ&µöÖW76vRrÂ¦÷W&æW”–BÂ&VbÂÖW76vT–C¢ÖW76vRæ–BÂ¶–æC¢udT„”4ÄRrÀ¢v—6†Æ—7G0¢Ò’Ò“°¢v—B&VÆöB‚“°¢Ò“°¢v—6†Æ—7Df÷&Òç&WVæB‡v—6†Æ—7D'WGFöâÂFEfV†–6ÆR“°¢ÖVçRæVæB‡v—6†Æ—7Df÷&Ò“°¢6öç7B6†ö–6W2Ò°¢²t%TDtUBrÂuFWFòrÂG'VUÒÂ²u”ÔTåBrÂuvÖVçFòrÂG'VUÒÀ¢²tDTDÄ”äRrÂu&¦òrÂG'VUÒÂ²tõUE4”DUôdÄõ$”DrÂt6V—Ff÷&FfÌ;7&–FrÂfÇ6UÒÀ¢²täõõDU5EôE$•dRrÂtVçFVæFWR6VÒFW7BG&—fRöFWföÇ\:|:6òrÂfÇ6UĞ¢Ó°¢6†ö–6W2æf÷$V6‚‚…¶¶–æBÂÆ&VÂÂæVVG5fÇVUÒ’Óâ°¢6öç7B&÷rÒVÆVÖVçB‚vF—brÂvÖVçRÖ7F–öâr“°¢6öç7BfÇVRÒVÆVÖVçB‚v–çWBr“°¢fÇVRæÖ„ÆVæwF‚ÒS°¢fÇVRçfÇVRÒæVVG5fÇVRò7G&–ær†ÖW76vRæ&öG•÷FW‡BÇÂrr’ç6Æ–6RƒÂS’¢rs°¢fÇVRæ6Æ74Æ—7BçFövvÆR‚v†–FFVârÂæVVG5fÇVR“°¢6öç7B'WGFöâÒVÆVÖVçB‚v'WGFöârÂwV–WB6ÖÆÂrÂÆ&VÂ“°¢'WGFöâçG—RÒv'WGFöâs°¢'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ°¢v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢vÖ&µöÖW76vRrÂ¦÷W&æW”–BÂ&VbÂÖW76vT–C¢ÖW76vRæ–BÂ¶–æBÂfÇVS¢æVVG5fÇVRòfÇVRçfÇVR¢çVÆÂÒ’Ò“°¢v—B&VÆöB‚“°¢Ò“°¢&÷ræVæB†'WGFöâÂfÇVR“°¢ÖVçRæVæB‡&÷r“°¢Ò“°¢6öç7Bö´'WGFöâÒVÆVÖVçB‚v'WGFöârÂw6ÖÆÂrÂt6Æ–VçFRFWRô²r“°¢ö´'WGFöâçG—RÒv'WGFöâs°¢ö´'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢v6Æ–VçEöö²rÂ¦÷W&æW”–BÂ&VbÂÖW76vT–C¢ÖW76vRæ–BÒ’Ò“²v—B&VÆöB‚“²Ò“°¢ÖVçRæVæB†ö´'WGFöâ“°¢Ğ¢–b†ÖW76vRæF—&V7F–öâÓÓÒtÔ52r’°¢6öç7B&öÖ—6Tf÷&ÒÒVÆVÖVçB‚vF—brÂvÖVçRÖ7F–öâr“°¢6öç7BGVTÆ&VÂÒVÆVÖVçB‚vÆ&VÂrÂrrÂu&¦òF&öÖW76r“°¢6öç7BGVRÒVÆVÖVçB‚v–çWBr“°¢GVRçG—RÒvFFWF–ÖRÖÆö6Âs°¢GVRçfÇVRÒÆö6Ä–çWDf÷%¦öæR†æWrFFR„FFRææ÷r‚’²#B¢3c’Æ7W7FöÖW%F–ÖW¦öæR“°¢GVTÆ&VÂæVæB†GVR“°¢GVTÆ&VÂæVæB†VÆVÖVçB‚w6ÖÆÂrÂv×WFVBrÂv†÷,:&–òFò6Æ–VçFRr’“°¢6öç7BGVUFW‡DÆ&VÂÒVÆVÖVçB‚vÆ&VÂrÂrrÂu&¦òVÒFW‡Fòr“°¢6öç7BGVUFW‡BÒVÆVÖVçB‚v–çWBr“°¢GVUFW‡BæÖ„ÆVæwF‚Ò#°¢GVUFW‡BçÆ6V†öÆFW"ÒtW‚ã¢ÖæŒ:2:2V‚s°¢GVUFW‡DÆ&VÂæVæB†GVUFW‡B“°¢6öç7B&öÖ—6T'WGFöâÒVÆVÖVçB‚v'WGFöârÂw6ÖÆÂrÂtÖ&6"6öÖò&öÖW76r“°¢&öÖ—6T'WGFöâçG—RÒv'WGFöâs°¢&öÖ—6T'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ°¢&öÖ—6T'WGFöâæF—6&ÆVC×G'VS°¢G'’²v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢w&öÖ—6RrÂ¦÷W&æW”–BÂ&VbÂÖW76vT–C¢ÖW76vRæ–BÂGVTÆö6Ã¢GVRçfÇVRÂGVUFW‡C¢GVUFW‡BçfÇVRÒ’Ò“²v—B&VÆöB‚“²Ğ¢f–æÆÇ’²&öÖ—6T'WGFöâæF—6&ÆVCÖfÇ6S²Ğ¢Ò“°¢&öÖ—6Tf÷&ÒæVæB†GVTÆ&VÂÂGVUFW‡DÆ&VÂÂ&öÖ—6T'WGFöâ“°¢ÖVçRæVæB‡&öÖ—6Tf÷&Ò“°¢Ğ¢&ö÷BæVæB†ÖVçR“°¢&WGW&â&ö÷C°¢Ğ ¢7–æ2gVæ7F–öâ÷Vå&V6÷&B†–BÂ÷F–öç2Ò·Ò’°¢6öç7BFFÒv—B&WVW7B‚rö’÷æVÂ÷&V6÷&G3ö–CÒr²Væ6öFUU$”6ö×öæVçB†–B’“°¢WFFTÖWF†FFæÖWF“°¢6öç7B—FVÒÒFFæ—FVÓ°¢6öç7B&ö÷BÒB‚w&V6÷&BÖFWF–Âr“°¢&ö÷Bç&WÆ6T6†–ÆG&Vâ‚“°¢–b†÷F–öç2ç&WVæB’&ö÷BæVæB†÷F–öç2ç&WVæB“°¢6öç7B&VÆöBÒ‚’Óâ÷Vå&V6÷&B†–BÂ÷F–öç2“°¢6öç7B7Æ—BÒVÆVÖVçB‚vF—brÂw&V6÷&B×7Æ—Br“°¢6öç7BÆVgBÒVÆVÖVçB‚vF—brÂw&V6÷&BÖFFÖ6öÇVÖâr“°¢6öç7B&–v‡BÒVÆVÖVçB‚vF—brÂw&V6÷&BÖ6öçfW'6F–öâÖ6öÇVÖâr“°¢7Æ—BæVæB†ÆVgBÂ&–v‡B“°¢&ö÷BæVæB‡7Æ—B“° ¢6öç7BFF&Æö6²ÒVÆVÖVçB‚w6V7F–öârÂw&V6÷&BÖ&Æö6²r“°¢FF&Æö6²æVæB†VÆVÖVçB‚vƒ"rÂrrÂ—FVÒæ6öçF7Bbb—FVÒæ6öçF7BæF—7Æ•öæÖRÇÂt6öçFFò6VÒæöÖRr’“°¢6öç7B7FGW4&FvW2ÒVÆVÖVçB‚vF—brÂv&FvW2r“°¢7FGW4&FvW2æVæB†Ö¶T&FvR†—FVÒç7FvRÂ—FVÒç7FvRÓÓÒu$U5ôäD”Dòròv&ÇVRr¢rr’ÂÖ¶T&FvR†—FVÒæVæ&ÆVBòtÄ”tDòr¢tDU4Ä”tDòrÂ—FVÒæVæ&ÆVBòvw&VVâr¢rr’ÂÖ¶T&FvR†—FVÒæ6†V6¶Æ—7E7VÖÖ'’æÆ&VÂÂ—FVÒæ6†V6¶Æ—7E7VÖÖ'’æ6ö×ÆWFVBÓÓÒbòvw&VVâr¢v&ÇVRr’“°¢–b†—FVÒç6†÷'DFVFÆ–æR’7FGW4&FvW2æVæB†Ö¶T&FvR‚w&¦ò7W'FòrÂw–VÆÆ÷rr’“°¢FF&Æö6²æVæB‡7FGW4&FvW2“°¢6öç7BFVf–æ—F–öç2ÒVÆVÖVçB‚vFÂrÂvFVf–æ—F–öâÖw&–Br“°¢FVf–æ—F–öâ†FVf–æ—F–öç2ÂuFVÆVföæW2rÂ—FVÒç†öæW2æÖ‚‡†öæR’Óâ†öæRç†öæUöScBÇÂ†öæRç†öæU÷&r’æ¦ö–â‚rÂr’“°¢FVf–æ—F–öâ†FVf–æ—F–öç2Âu&VbrÂ—FVÒç&VfW&Væ6Uö6öFR“°¢FVf–æ—F–öâ†FVf–æ—F–öç2Âu&Vg2F6Æ7VÆF÷&ö6öçfW'6rÂ—FVÒç&Vg2æÖ‚‡&Vb’Óâ&Vbç&Veö6öFR’æ¦ö–â‚rÂr’“°¢6öç7B÷&–v–âÒ6÷W&6TÆ&VÂ†—FVÒç6÷W&6R“°¢–b†÷&–v–â’FVf–æ—F–öâ†FVf–æ—F–öç2Ât÷&–vVÒrÂ÷&–v–â“°¢FVf–æ—F–öâ†FVf–æ—F–öç2ÂuvÖVçFòrÂF—7Æ•–ÖVçB†—FVÒç–ÖVçE÷FW‡B’“°¢FVf–æ—F–öâ†FVf–æ—F–öç2Âu&¦òrÂF—7Æ”FVFÆ–æR†—FVÒæ7W7FöÖW%öFVFÆ–æU÷FW‡B’ÇÂf÷&ÖDFFR†—FVÒæ7W7FöÖW%öFVFÆ–æUöB’“°¢FF&Æö6²æVæB†FVf–æ—F–öç2“°¢6öç7B6×4Ö—76–æs×6×5&–çDÖ—76–ær‡²ââæ—FVÒÂ–C¦—FVÒæ–BÂ¦÷W&æW”–C¦—FVÒæ–BÂ6öçF7D6†ææVÃ¦—FVÒæ6öçF7D6†ææVÂÇÂ—FVÒæ6öçF7Eö6†ææVÂÂ&Vc¦—FVÒç&VfW&Væ6Uö6öFRÂ6öçF7Eö–C¦—FVÒæ6öçF7Eö–BÒ“²–b‡6×4Ö—76–ær–FF&Æö6²æVæB‡6×4Ö—76–ær“°¢6öç7Bv—6†Æ—7BÒVÆVÖVçB‚w6V7F–öârÂwv—6†Æ—7BÖ&Æö6²r“°¢v—6†Æ—7BæVæB†VÆVÖVçB‚vƒ2rÂrrÂtÆ—7FFRFW6V¦òr’“°¢6öç7Bv—6†W2Ò—FVÒçv—6†Æ—7G2bb—FVÒçv—6†Æ—7G2æÆVæwF‚ò—FVÒçv—6†Æ—7G2¢¶—FVÒçv—6†Æ—7BÇÂ·ÕÓ°¢v—6†W2æf÷$V6‚‚‡v—6‚Â–æFW‚’Óâ°¢6öç7Bv—6„FVf–æ—F–öç2ÒVÆVÖVçB‚vFÂrÂvFVf–æ—F–öâÖw&–Br“°¢6öç7Bv—6„ÖöFVÂÒF—7Æ”ÖöFVÂ‡v—6‚æÖöFVÂ“°¢FVf–æ—F–öâ‡v—6„FVf–æ—F–öç2Â6'&òG¶–æFW‚²ÖÂv—6„ÖöFVÂò…7G&–ær‡v—6„ÖöFVÂ’çFôÆ÷vW$66R‚’ç7F'G5v—F‚…7G&–ær‡v—6‚æÖ¶RÇÂrr’çFôÆ÷vW$66R‚’²rr’òv—6„ÖöFVÂ¢·v—6‚æÖ¶RÂv—6„ÖöFVÅÒæf–ÇFW"„&ööÆVâ’æ¦ö–â‚rr’’¢çVÆÂ“°¢FVf–æ—F–öâ‡v—6„FVf–æ—F–öç2ÂtæòFRrÂv—6‚ç–V$Ö–â“°¢FVf–æ—F–öâ‡v—6„FVf–æ—F–öç2ÂtæòL:’rÂv—6‚ç–V$Ö‚“°¢FVf–æ—F–öâ‡v—6„FVf–æ—F–öç2ÂtÖ–Æ†2L:’rÂv—6‚æÖ„Ö–ÆW2òçVÖ&W"‡v—6‚æÖ„Ö–ÆW2’çFôÆö6ÆU7G&–ær‚wBÔ%"r’¢çVÆÂ“°¢v—6†Æ—7BæVæB‡v—6„FVf–æ—F–öç2“°¢Ò“°¢6öç7B'VFvWDFVf–æ—F–öâÒVÆVÖVçB‚vFÂrÂvFVf–æ—F–öâÖw&–Br“°¢FVf–æ—F–öâ†'VFvWDFVf–æ—F–öâÂuFWFò;¦æ–6òrÂf÷&ÖDÖöæW’†—FVÒæ'VFvWEö6VçG2’“°¢v—6†Æ—7BæVæB†'VFvWDFVf–æ—F–öâ“°¢FF&Æö6²æVæB‡v—6†Æ—7BÂ¦÷W&æW•7v—F6‚†—FVÒÂ&VÆöB’“°¢–b‚÷F–öç2ç&WVæB’FF&Æö6²æVæB†F—7÷6—F–öä6öçG&öÇ2‡²¶–æC¢t¤õU$äU’rÂ–C¢—FVÒæ–BÂ¦÷W&æW”–C¢—FVÒæ–BÒ’“°¢–b‚÷F–öç2ç&WVæBbb—FVÒæ6Æ7VÆF÷%&WVW7G2bb—FVÒæ6Æ7VÆF÷%&WVW7G2æÆVæwF‚’°¢—FVÒæ6Æ7VÆF÷%&WVW7G2æf÷$V6‚‚‡&WVW7D—FVÒ’ÓâFF&Æö6²æVæB‡6–×VÆF–öä&Æö6²‡&WVW7D—FVÒ’’“°¢Ğ¢–b†—FVÒæÖæ†V–ÔÖF6„6÷VçB’°¢6öç7BÖF6„æ÷F–6RÒVÆVÖVçB‚v'WGFöârÂvÖæ†V–ÒÖæ÷F–6RrÂG¶—FVÒæÖæ†V–ÔÖF6„6÷VçGÒ6'&ò‡2’FòW‡÷'BÖ—2&V6VçFR&FVÒ+r'&—"Öæ†V–Ö“°¢ÖF6„æ÷F–6RçG—RÒv'WGFöâs°¢ÖF6„æ÷F–6RæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ7v—F6…æVÂ‚vÖæ†V–Òr’“°¢FF&Æö6²æVæB†ÖF6„æ÷F–6R“°¢Ğ ¢6öç7Bæ÷FTf÷&ÒÒVÆVÖVçB‚vF—brÂv–æÆ–æRÖf÷&Òæ÷FRÖf÷&Òr“°¢6öç7Bæ÷FTÆ&VÂÒVÆVÖVçB‚vÆ&VÂrÂrrÂtæ÷Fr“°¢6öç7Bæ÷FRÒVÆVÖVçB‚wFW‡F&Vr“°¢æ÷FRæÖ„ÆVæwF‚ÒC°¢æ÷FRçfÇVRÒ—FVÒæ6öçF7Bbb—FVÒæ6öçF7Bææ÷FW2ÇÂrs°¢æ÷FTÆ&VÂæVæB†æ÷FR“°¢6öç7B6fTæ÷FRÒVÆVÖVçB‚v'WGFöârÂwV–WB6ÖÆÂrÂu6Çf"æ÷Fr“°¢6fTæ÷FRçG—RÒv'WGFöâs°¢6fTæ÷FRæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢wWFFUöæ÷FRrÂ¦÷W&æW”–C¢–BÂæ÷FS¢æ÷FRçfÇVRÒ’Ò“²v—B&VÆöB‚“²Ò“°¢æ÷FTf÷&ÒæVæB†æ÷FTÆ&VÂÂ6fTæ÷FR“°¢FF&Æö6²æVæB†æ÷FTf÷&Ò“° ¢–b†—FVÒæVæ&ÆVBbb—FVÒç7FvUög&÷¦Vâ’°¢6öç7B÷W&F–öç2ÒVÆVÖVçB‚vF—brÂv–æÆ–æRÖ7F–öç2r“°¢²t4ÄÅôå5tU$TBrÂt4ÄÅôEDTÕBrÂt”åõU%4ôâuÒæf÷$V6‚‚‡G—R’Óâ°¢6öç7BÆ&VÇ2Ò²4ÄÅôå5tU$TC¢tÆ–v:|:6òFVæF–FrÂ4ÄÅôEDTÕC¢uFVçFF—f6VÒ&W7÷7FrÂ”åõU%4ôã¢t6öçfW'6&W6Væ6–ÂrÓ°¢6öç7B'WGFöâÒVÆVÖVçB‚v'WGFöârÂwV–WB6ÖÆÂrÂÆ&VÇ5·G—UÒ“°¢'WGFöâçG—RÒv'WGFöâs°¢'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢v–çFW&7F–öârÂ¦÷W&æW”–C¢–BÂ–çFW&7F–öåG—S¢G—RÒ’Ò“²v—B&VÆöB‚“²Ò“°¢÷W&F–öç2æVæB†'WGFöâ“°¢Ò“°¢FF&Æö6²æVæB†÷W&F–öç2“° ¢6öç7B7FGW4f÷&ÒÒVÆVÖVçB‚vF—brÂv–æÆ–æRÖf÷&Òr“°¢6öç7B7FGW4Æ&VÂÒVÆVÖVçB‚vÆ&VÂrÂrrÂtWF÷W&6–öæÂr“°¢6öç7B7FGW56VÆV7BÒVÆVÖVçB‚w6VÆV7Br“°¢µ²täõdòrÂtæ÷fòuÒÂ²u$U5ôäD”DòrÂu&W7öæF–FòuÒÂ²tTÕô%U44rÂtVÒ'W66uÒÂ²tDT4”D”äDòrÂtFV6–F–æFòuÒÂ²uTÄ”d”4DòrÂuVÆ–f–6FòuÒÂ²tuT$DäDõô4Ä”TåDRrÂtwV&FæFò6Æ–VçFRuÒÂ²u$DòrÂu&FòuÕÒæf÷$V6‚‚…·fÇVRÂÆ&VÅÒ’Óâ7FGW56VÆV7BæVæB†æWr÷F–öâ†Æ&VÂÂfÇVR’’“°¢7FGW56VÆV7BçfÇVRÒ²tuT$DäDõô4Ä”TåDRrÂu$DòuÒæ–æ6ÇVFW2†—FVÒç7FGW2’ò—FVÒç7FGW2¢—FVÒç7FvS°¢7FGW4Æ&VÂæVæB‡7FGW56VÆV7B“°¢6öç7B7FGW4'WGFöâÒVÆVÖVçB‚v'WGFöârÂw6ÖÆÂrÂtGVÆ—¦"WFr“°¢7FGW4'WGFöâçG—RÒv'WGFöâs°¢7FGW4'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢w6WEögVææVÂrÂ¦÷W&æW”–C¢–BÂfÇVS¢7FGW56VÆV7BçfÇVRÒ’Ò“²v—B&VÆöB‚“²Ò“°¢7FGW4f÷&ÒæVæB‡7FGW4Æ&VÂÂ7FGW4'WGFöâ“°¢FF&Æö6²æVæB‡7FGW4f÷&Ò“°¢Ğ ¢–b†—FVÒæF—fW&vVæ6W2æÆVæwF‚’°¢FF&Æö6²æVæB†VÆVÖVçB‚vƒ2rÂrrÂuVæL:¦æ6–2RF—fW&|:¦æ6–2r’“°¢—FVÒæF—fW&vVæ6W2æf÷$V6‚‚†F—fW&vVæ6R’Óâ°¢6öç7B&÷rÒVÆVÖVçB‚vF—brÂv6†V6²×ö–çBr“°¢&÷ræVæB†VÆVÖVçB‚w7G&öærrÂrrÂG¶F—fW&vVæ6Ræf–VÆGÒ(	BG¶F—fW&vVæ6Rç7FGW7Ö’“°¢–b†F—fW&vVæ6Rç7FGW2ÓÓÒtõTâr’°¢6öç7B6†ö–6W2Ò—FVÒæFV6Æ&F–öç2æf–ÇFW"‚†FV6Æ&F–öâ’ÓâFV6Æ&F–öâæf–VÆBÓÓÒF—fW&vVæ6Ræf–VÆBbb¶F—fW&vVæ6RæÆVgEöFV6Æ&F–öåö–BÂF—fW&vVæ6Rç&–v‡EöFV6Æ&F–öåö–EÒæ–æ6ÇVFW2†FV6Æ&F–öâæ–B’“°¢6öç7B6VÆV7BÒVÆVÖVçB‚w6VÆV7Br“°¢6†ö–6W2æf÷$V6‚‚†6†ö–6R’Óâ6VÆV7BæVæB†æWr÷F–öâ†G¶6†ö–6Rç6÷W&6WÓ¢G¶6†ö–6RçfÇVU÷FW‡GÖÂ6†ö–6Ræ–B’’“°¢6öç7B'WGFöâÒVÆVÖVçB‚v'WGFöârÂw6ÖÆÂrÂuW6"6öÖò÷W&6–öæÂr“°¢'WGFöâçG—RÒv'WGFöâs°¢'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢w&W6öÇfUöF—fW&vVæ6RrÂ¦÷W&æW”–C¢–BÂF—fW&vVæ6T–C¢F—fW&vVæ6Ræ–BÂFV6Æ&F–öä–C¢6VÆV7BçfÇVRÒ’Ò“²v—B&VÆöB‚“²Ò“°¢&÷ræVæB‡6VÆV7BÂ'WGFöâ“°¢Ğ¢FF&Æö6²æVæB‡&÷r“°¢Ò“°¢Ğ¢ÆVgBæVæB†FF&Æö6²“° ¢6öç7B6†V6¶Æ—7D&Æö6²ÒVÆVÖVçB‚w6V7F–öârÂw&V6÷&BÖ&Æö6²r“°¢6†V6¶Æ—7D&Æö6²æVæB†VÆVÖVçB‚vƒ2rÂrrÂ6†V6¶Æ—7B(	BG¶—FVÒæ6†V6¶Æ—7E7VÖÖ'’æÆ&VÇÖ’“°¢—FVÒæ6†V6¶Æ—7Bæf÷$V6‚‚‡ö–çB’Óâ°¢6öç7B&÷rÒVÆVÖVçB‚vF—brÂv6†V6²×ö–çBr²‡ö–çBç7FGW2ÓÓÒt4ôÕÄUDRròr6ö×ÆWFRr¢rr’“°¢&÷ræVæB†VÆVÖVçB‚w7G&öærrÂrrÂG·ö–çBçö–çEöçVÖ&W'ÒâG·ö–çBçö–çEöÆ&VÇÖ’ÂÖ¶T&FvR†6†V6¶Æ—7E7FGW4Æ&VÂ‡ö–çBç7FGW2’Âö–çBç7FGW2ÓÓÒt4ôÕÄUDRròvw&VVâr¢rr’“°¢ö–çBæWf–FVæ6Ræf÷$V6‚‚†Wf–FVæ6R’Óâ&÷ræVæB†VÆVÖVçB‚wrÂvWf–FVæ6RrÂWf–FVæ6RæW†6W'E÷FW‡B’’“°¢6†V6¶Æ—7D&Æö6²æVæB‡&÷r“°¢Ò“°¢ÆVgBæVæB†6†V6¶Æ—7D&Æö6²“° ¢6öç7B&WGW&ä&Æö6²ÒVÆVÖVçB‚w6V7F–öârÂw&V6÷&BÖ&Æö6²r“°¢&WGW&ä&Æö6²æVæB†VÆVÖVçB‚vƒ2rÂrrÂu&WF÷&æ÷2r’“°¢6öç7B÷Vå&WGW&ç2Ò—FVÒç&WGW&ç2æf–ÇFW"‚†VçG'’’ÓâVçG'’ç7FGW2ÓÓÒtõTâr“°¢–b‚÷Vå&WGW&ç2æÆVæwF‚’&WGW&ä&Æö6²æVæB†VÆVÖVçB‚wrÂv×WFVBrÂtæVæ‡VÒ&WF÷&æò&W'Fòâr’“°¢÷Vå&WGW&ç2æf÷$V6‚‚†VçG'’’Óâ°¢6öç7B&÷rÒVÆVÖVçB‚vF—brÂv6†V6²×ö–çBr“°¢&÷ræVæB†VÆVÖVçB‚wrÂvÖW76vRÖ&öG’rÂVçG'’çFW‡B’ÂVÆVÖVçB‚wrÂv×WFVBrÂG¶VçG'’æ÷&–v–çÒ+rG¶f÷&ÖDFFR†VçG'’æGVTB—Ö’“°¢6öç7B6ö×ÆWFRÒVÆVÖVçB‚v'WGFöârÂw6ÖÆÂrÂt6öæ6ÇV—"r“°¢6ö×ÆWFRçG—RÒv'WGFöâs°¢6ö×ÆWFRæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢w&WGW&å÷WFFRrÂ¦÷W&æW”–C¢–BÂ&WGW&ä¶–æC¢VçG'’æ¶–æBÂ&WGW&ä–C¢VçG'’æ¶–æBÓÓÒu$ôÔ•4RròVçG'’æ–B¢çVÆÂÂ÷W&F–öã¢t4ôÕÄUDRrÒ’Ò“²v—B&VÆöB‚“²Ò“°¢6öç7B&VÖ÷fRÒVÆVÖVçB‚v'WGFöârÂwV–WB6ÖÆÂrÂu&VÖ÷fW"r“°¢&VÖ÷fRçG—RÒv'WGFöâs°¢&VÖ÷fRæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢w&WGW&å÷WFFRrÂ¦÷W&æW”–C¢–BÂ&WGW&ä¶–æC¢VçG'’æ¶–æBÂ&WGW&ä–C¢VçG'’æ¶–æBÓÓÒu$ôÔ•4RròVçG'’æ–B¢çVÆÂÂ÷W&F–öã¢u$TÔõdRrÒ’Ò“²v—B&VÆöB‚“²Ò“°¢&÷ræVæB†6ö×ÆWFRÂ&VÖ÷fR“°¢&WGW&ä&Æö6²æVæB‡&÷r“°¢Ò“°¢–b†—FVÒæVæ&ÆVBbb—FVÒææW‡Eö7F–öåöB’°¢6öç7BæW‡Df÷&ÒÒVÆVÖVçB‚vF—brÂv–æÆ–æRÖf÷&Òr“°¢6öç7BæW‡EFW‡DÆ&VÂÒVÆVÖVçB‚vÆ&VÂrÂrrÂu&WF÷&æòÖçVÂr“°¢6öç7BæW‡EFW‡BÒVÆVÖVçB‚v–çWBr“²æW‡EFW‡BæÖ„ÆVæwF‚ÒS²æW‡EFW‡DÆ&VÂæVæB†æW‡EFW‡B“°¢6öç7BæW‡DFFTÆ&VÂÒVÆVÖVçB‚vÆ&VÂrÂrrÂtFFr“°¢6öç7BæW‡DFFRÒVÆVÖVçB‚v–çWBr“²æW‡DFFRçG—RÒvFFWF–ÖRÖÆö6Âs²æW‡DFFRçfÇVRÒÆö6Ä–çWB†æWrFFR„FFRææ÷r‚’²#B¢3c’“²æW‡DFFTÆ&VÂæVæB†æW‡DFFR“°¢6öç7BæW‡D'WGFöâÒVÆVÖVçB‚v'WGFöârÂw6ÖÆÂrÂtF–6–öæ"&WF÷&æòr“°¢æW‡D'WGFöâçG—RÒv'WGFöâs°¢æW‡D'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢væW‡Eö7F–öârÂ÷W&F–öã¢t5$TDRrÂ¦÷W&æW”–C¢–BÂFW‡C¢æW‡EFW‡BçfÇVRÂC¢æWrFFR†æW‡DFFRçfÇVR’çFô•4õ7G&–ær‚’Ò’Ò“²v—B&VÆöB‚“²Ò“°¢æW‡Df÷&ÒæVæB†æW‡EFW‡DÆ&VÂÂæW‡DFFTÆ&VÂÂæW‡D'WGFöâ“°¢&WGW&ä&Æö6²æVæB†æW‡Df÷&Ò“°¢Ğ¢ÆVgBæVæB‡&WGW&ä&Æö6²“° ¢6öç7BVæ—G4&Æö6²ÒVÆVÖVçB‚w6V7F–öârÂw&V6÷&BÖ&Æö6²r“°¢Væ—G4&Æö6²æVæB†VÆVÖVçB‚vƒ2rÂrrÂuVæ–FFW2&W6VçFF2r’“°¢–b‚—FVÒçVæ—G2æÆVæwF‚’Væ—G4&Æö6²æVæB†VÆVÖVçB‚wrÂv×WFVBrÂtæVæ‡VÖVæ–FFR&W6VçFFâr’“°¢—FVÒçVæ—G2æf÷$V6‚‚‡Væ—B’Óâ°¢6öç7B&÷rÒVÆVÖVçB‚vF—brÂv6†V6²×ö–çBr“°¢&÷ræVæB†VÆVÖVçB‚w7G&öærrÂrrÂVæ—BçfV†–6ÆU÷FW‡B’ÂVÆVÖVçB‚wrÂv×WFVBrÂf÷&ÖDFFR‡Væ—Bç&W6VçFVEöB’’ÂÖ¶T&FvR‡Væ—Bç7FGW2’“°¢–b†—FVÒæVæ&ÆVBbb—FVÒç7FvUög&÷¦Vâ’°¢6öç7Bf÷&ÒÒVÆVÖVçB‚vF—brÂv–æÆ–æRÖf÷&Òr“°¢6öç7B6VÆV7BÒVÆVÖVçB‚w6VÆV7Br“°¢²u$U4TåDTBrÂuTäDU%õ$Ud”UrrÂt44UDTBrÂtDT4Ä”äTBrÂut•D„E$tâuÒæf÷$V6‚‚‡7FGW2’Óâ6VÆV7BæVæB†æWr÷F–öâ‡7FGW2Â7FGW2’’“°¢6VÆV7BçfÇVRÒVæ—Bç7FGW3°¢6öç7BFV6Æ–æRÒVÆVÖVçB‚v–çWBr“°¢FV6Æ–æRçÆ6V†öÆFW"ÒtÖ÷F—fòFR&V7W6s°¢FV6Æ–æRæÖ„ÆVæwF‚ÒS°¢FV6Æ–æRçfÇVRÒVæ—BæFV6Æ–æU÷&V6öâÇÂrs°¢6öç7B6fRÒVÆVÖVçB‚v'WGFöârÂw6ÖÆÂrÂtGVÆ—¦"Væ–FFRr“°¢6fRçG—RÒv'WGFöâs°¢6fRæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢wVæ—BrÂ¦÷W&æW”–C¢–BÂVæ—D–C¢Væ—Bæ–BÂ7FGW3¢6VÆV7BçfÇVRÂFV6Æ–æU&V6öã¢FV6Æ–æRçfÇVRÒ’Ò“²v—B&VÆöB‚“²Ò“°¢6öç7B&W7öæFVBÒVÆVÖVçB‚v'WGFöârÂwV–WB6ÖÆÂrÂu&Vv—7G&"&W7÷7FFò6Æ–VçFRr“°¢&W7öæFVBçG—RÒv'WGFöâs°¢&W7öæFVBæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢wVæ—BrÂ¦÷W&æW”–C¢–BÂVæ—D–C¢Væ—Bæ–BÂ7FGW3¢6VÆV7BçfÇVRÂFV6Æ–æU&V6öã¢FV6Æ–æRçfÇVRÂ7W7FöÖW%&W7öæFVC¢G'VRÒ’Ò“²v—B&VÆöB‚“²Ò“°¢f÷&ÒæVæB‡6VÆV7BÂFV6Æ–æRÂ6fRÂ&W7öæFVB“°¢&÷ræVæB†f÷&Ò“°¢Ğ¢Væ—G4&Æö6²æVæB‡&÷r“°¢Ò“°¢–b†—FVÒæVæ&ÆVBbb—FVÒç7FvUög&÷¦Vâ’°¢6öç7BFDf÷&ÒÒVÆVÖVçB‚vF—brÂv–æÆ–æRÖf÷&Òr“°¢6öç7BfV†–6ÆRÒVÆVÖVçB‚v–çWBr“°¢fV†–6ÆRçÆ6V†öÆFW"Òuf\:Ö7VÆòFVæ–FFRs°¢fV†–6ÆRæÖ„ÆVæwF‚ÒS°¢6öç7B7FGW2ÒVÆVÖVçB‚w6VÆV7Br“°¢7FGW2æVæB†æWr÷F–öâ‚t&W6VçFFrÂu$U4TåDTBr’ÂæWr÷F–öâ‚tVÒì:Æ—6RrÂuTäDU%õ$Ud”Urr’“°¢6öç7BFBÒVÆVÖVçB‚v'WGFöârÂw6ÖÆÂrÂtF–6–öæ"Væ–FFRr“°¢FBçG—RÒv'WGFöâs°¢FBæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢wVæ—BrÂ¦÷W&æW”–C¢–BÂfV†–6ÆUFW‡C¢fV†–6ÆRçfÇVRÂ7FGW3¢7FGW2çfÇVRÒ’Ò“²v—B&VÆöB‚“²Ò“°¢FDf÷&ÒæVæB‡fV†–6ÆRÂ7FGW2ÂFB“°¢Væ—G4&Æö6²æVæB†FDf÷&Ò“°¢Ğ¢ÆVgBæVæB‡Væ—G4&Æö6²“° ¢6öç7B6öçfW'6F–öä&Æö6²ÒVÆVÖVçB‚w6V7F–öârÂw&V6÷&BÖ&Æö6²r“°¢6öçfW'6F–öä&Æö6²æVæB†VÆVÖVçB‚vƒ2rÂrrÂt4ôådU%4r’“°¢6öç7B6öçfW'6F–öä6†D–G2Ò²ââææWr6WB‚†—FVÒæ6öçfW'6F–öâÇÂµÒ’æÖ‚†ÖW76vR’ÓâÖW76vRæ6†Eö–B’æf–ÇFW"„&ööÆVâ’•Ó°¢–b†6öçfW'6F–öä6†D–G2æÆVæwF‚’°¢6öç7B6VæFW%FööÇ2ÒVÆVÖVçB‚vF—brÂv–æÆ–æRÖ7F–öç2r“°¢6öçfW'6F–öä6†D–G2æf÷$V6‚‚†6†D–B’Óâ°¢6öç7B–çfW'BÒVÆVÖVçB‚v'WGFöârÂwV–WB6ÖÆÂrÂ6öçfW'6F–öä6†D–G2æÆVæwF‚ÓÓÒòt–çfW'FW"&VÖWFVçFW2FW7F6öçfW'6r¢t–çfW'FW"&VÖWFVçFW2FW7FR6†Br“°¢–çfW'BçG—RÒv'WGFöâs°¢–çfW'BæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ°¢–b†–çfW'BæFF6WBæ6öæf—&ÖVBÓÒwG'VRr’²–çfW'BæFF6WBæ6öæf—&ÖVCÒwG'VRs²–çfW'BçFW‡D6öçFVçCÒt6öæf—&Ö"–çfW'<:6òs²&WGW&ã²Ğ¢–çfW'BæF—6&ÆVC×G'VS°¢G'’²v—B&WVW7B‚rö’÷æVÂö7F–öç2rÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²7F–öã¢v–çfW'E÷6VæFW'2rÂ¦÷W&æW”–C¢–BÂ6†D–BÒ’Ò“²v—B&VÆöB‚“²Ğ¢f–æÆÇ’²–çfW'BæF—6&ÆVCÖfÇ6S²Ğ¢Ò“°¢6VæFW%FööÇ2æVæB†–çfW'B“°¢Ò“°¢6öçfW'6F–öä&Æö6²æVæB‡6VæFW%FööÇ2“°¢Ğ¢6öç7B6öçfW'6F–öä6öçG&öÇ2ÒVÆVÖVçB‚vF—brÂv6öçfW'6F–öâÖ6öçG&öÇ2r“°¢6öç7B6÷'DÆ&VÂÒVÆVÖVçB‚vÆ&VÂrÂrrÂt÷&FVæ"r“°¢6öç7B6÷'BÒVÆVÖVçB‚w6VÆV7Br“°¢6÷'BæVæB†æWr÷F–öâ‚tÖ—2çF–v2&–ÖV—&òrÂvöÆFW7Br’ÂæWr÷F–öâ‚tÖ—2&V6VçFW2&–ÖV—&òrÂw&V6VçBr’“°¢6÷'BçfÇVRÒÆö6Å7F÷&vRævWD—FVÒ‚vÖ75ö6öçfW'6F–öå÷6÷'Br’ÇÂvöÆFW7Bs°¢6÷'DÆ&VÂæVæB‡6÷'B“°¢6öç7Bf–ÇFW$Æ&VÂÒVÆVÖVçB‚vÆ&VÂrÂrrÂtÖ÷7G&"r“°¢6öç7Bf–ÇFW"ÒVÆVÖVçB‚w6VÆV7Br“°¢f–ÇFW"æVæB†æWr÷F–öâ‚uGVFòrÂvÆÂr’ÂæWr÷F–öâ‚t6Æ–VçFRrÂt5U5DôÔU"r’ÂæWr÷F–öâ‚tÔ52rÂtÔ52r’“°¢f–ÇFW$Æ&VÂæVæB†f–ÇFW"“°¢6öçfW'6F–öä6öçG&öÇ2æVæB‡6÷'DÆ&VÂÂf–ÇFW$Æ&VÂ“°¢6öçfW'6F–öä&Æö6²æVæB†6öçfW'6F–öä6öçG&öÇ2“°¢6öç7BF–ÖVÆ–æRÒVÆVÖVçB‚vF—brÂv6öçfW'6F–öâ×F–ÖVÆ–æRr“°¢6öç7B&VæFW$6öçfW'6F–öâÒ‚’Óâ°¢F–ÖVÆ–æRç&WÆ6T6†–ÆG&Vâ‚“°¢6öç7BVçG&–W2Ò†—FVÒçF–ÖVÆ–æRÇÂ—FVÒæ6öçfW'6F–öâæÖ‚†ÖW76vR’Óâ‡²ââæÖW76vRÂF–ÖVÆ–æUG—S¢vÖW76vRrÂö67W'&VDC¢ÖW76vRæö67W'&VEöE÷WF2ÇÂÖW76vRæö67W'&VEöEöÆö6ÂÇÂÖW76vRæ7&VFVEöBÒ’’¢æf–ÇFW"‚†VçG'’’ÓâVçG'’çF–ÖVÆ–æUG—RÓÒvÖW76vRròf–ÇFW"çfÇVRÓÓÒvÆÂr¢f–ÇFW"çfÇVRÓÓÒvÆÂrÇÂVçG'’æF—&V7F–öâÓÓÒf–ÇFW"çfÇVR¢ç6Æ–6R‚¢ç6÷'B‚†ÆVgBÂ&–v‡B’Óâ°¢6öç7BFVÇFÒ„FFRç'6R†ÆVgBæö67W'&VDB’ÇÂ’Ò„FFRç'6R‡&–v‡Bæö67W'&VDB’ÇÂ“°¢&WGW&âFVÇFÇÂ„çVÖ&W"†ÆVgBæ÷&–v–æÅö÷&FW"’ÇÂ’Ò„çVÖ&W"‡&–v‡Bæ÷&–v–æÅö÷&FW"’ÇÂ’ÇÂ7G&–ær†ÆVgBæ–B’æÆö6ÆT6ö×&R…7G&–ær‡&–v‡Bæ–B’“°¢Ò“°¢–b‡6÷'BçfÇVRÓÓÒw&V6VçBr’VçG&–W2ç&WfW'6R‚“°¢VçG&–W2æf÷$V6‚‚†ÖW76vR’Óâ°¢–b†ÖW76vRçF–ÖVÆ–æUG—RÓÒvÖW76vRr’°¢6öç7BG—TÆ&VÂÒÖW76vRçF–ÖVÆ–æUG—RÓÓÒv–çFW&7F–öâròt–çFW&:|:6òr¢u6—7FVÖs°¢F–ÖVÆ–æRæVæB†VÆVÖVçB‚wrÂF–ÖVÆ–æRÖWfVçBF–ÖVÆ–æRÒG¶ÖW76vRçF–ÖVÆ–æUG—WÖÂG¶f÷&ÖDFFR†ÖW76vRæö67W'&VDB—Ò+rG·G—TÆ&VÇÒ+rG¶ÖW76vRæÆ&VÇÖ’“°¢&WGW&ã°¢Ğ¢6öç7B&÷rÒVÆVÖVçB‚v'F–6ÆRrÂvÖW76vRr²ÖW76vRæF—&V7F–öâçFôÆ÷vW$66R‚’“°¢6öç7BÖWFÒG¶ÖW76vRæ6†ææVÇÒ+rG¶ÖW76vRæF—&V7F–öâÓÓÒt5U5DôÔU"ròt6Æ–VçFRr¢ÖW76vRæF—&V7F–öâÓÓÒtÔ52ròtÔ52r¢u6—7FVÖwÒ+rG¶f÷&ÖDFFR†ÖW76vRæö67W'&VEöE÷WF2ÇÂÖW76vRæö67W'&VEöEöÆö6ÂÇÂÖW76vRæ7&VFVEöB—ÒG¶ÖW76vRçF–ÖU÷Væ6W'F–âòr+r†÷&–æ6W'Fr¢rwÖ°¢&÷ræVæB†VÆVÖVçB‚w7ârÂvÖW76vRÖÖWFrÂÖWF’ÂVÆVÖVçB‚wrÂvÖW76vRÖ&öG’rÂÖW76vRæ&öG•÷FW‡B’“°¢–b†—FVÒæVæ&ÆVBbb—FVÒç7FvUög&÷¦VâbbÖW76vRæF—&V7F–öâÓÒu5•5DTÒr’&÷ræVæB†7F–öäÖW76vR†ÖW76vRÂ–BÂ&VÆöB’“°¢F–ÖVÆ–æRæVæB‡&÷r“°¢Ò“°¢–b‚F–ÖVÆ–æRæ6†–ÆDæöFW2æÆVæwF‚’F–ÖVÆ–æRæVæB†VÆVÖVçB‚wrÂv×WFVBrÂtæVæ‡VÖÖVç6vVÒæW7FRf–ÇG&òâr’“°¢Ó°¢6÷'BæFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ²Æö6Å7F÷&vRç6WD—FVÒ‚vÖ75ö6öçfW'6F–öå÷6÷'BrÂ6÷'BçfÇVR“²&VæFW$6öçfW'6F–öâ‚“²Ò“°¢f–ÇFW"æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ&VæFW$6öçfW'6F–öâ“°¢6öçfW'6F–öä&Æö6²æVæB‡F–ÖVÆ–æR“°¢&VæFW$6öçfW'6F–öâ‚“°¢&–v‡BæVæB†6öçfW'6F–öä&Æö6²“°¢Ğ ¢7–æ2gVæ7F–öâvÆö&Å6V&6‚†WfVçB’°¢WfVçBç&WfVçDFVfVÇB‚“°¢6öç7BÒB‚vvÆö&Â×6V&6‚Ö–çWBr’çfÇVRçG&–Ò‚“°¢–b‚’&WGW&ã°¢6öç7B6V&6…6÷'CÖÆö6Å7F÷&vRævWD—FVÒ‚vÖ75÷6÷'E÷6V&6‚r—ÇÂw&V6VçBs°¢6öç7B&W7VÇBÒv—B&WVW7B‚rö’÷æVÂ÷6V&6ƒ÷Òr²Væ6öFUU$”6ö×öæVçB‡’²rg6÷'CÒr¶Væ6öFUU$”6ö×öæVçB‡6V&6…6÷'B’“°¢6öç7B&ö÷BÒB‚w6V&6‚×&W7VÇG2r“°¢&ö÷Bç&WÆ6T6†–ÆG&Vâ†VÆVÖVçB‚vƒ"rÂrrÂu&W7VÇFF÷2F'W66r’“°¢6öç7B6÷'DÆ&VÃÖVÆVÖVçB‚vÆ&VÂrÂrrÂt÷&FVæ"r“¶6öç7B6÷'E6VÆV7CÖVÆVÖVçB‚w6VÆV7Br“µµ²w&V6VçBrÂtÖ—2&V6VçFW2uÒÅ²vöÆFW7BrÂtÖ—2çF–v2uÒÅ²wfÇVUöFW62rÂtÖ–÷"fÆ÷"uÒÅ²wfÇVUö62rÂtÖVæ÷"fÆ÷"uÒÅ²vÆö6F–öârÂtÆö6Æ—¦:|:6òuÒÅ²wfV†–6ÆRrÂtÖ&6Fò6'&òuÕÒæf÷$V6‚‚…·bÆÅÒ“Óç6÷'E6VÆV7BæVæB†æWr÷F–öâ†ÂÇb’’“·6÷'E6VÆV7BçfÇVS×6V&6…6÷'C·6÷'E6VÆV7BæFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚“Óç¶Æö6Å7F÷&vRç6WD—FVÒ‚vÖ75÷6÷'E÷6V&6‚rÇ6÷'E6VÆV7BçfÇVR“¶vÆö&Å6V&6‚†æWrWfVçB‚w7V&Ö—Br’“·Ò“·6÷'DÆ&VÂæVæB‡6÷'E6VÆV7B“·&ö÷BæVæB‡6÷'DÆ&VÂ“°¢–b‚&W7VÇBæ—FV×2æÆVæwF‚’&ö÷BæVæB†VÆVÖVçB‚wrÂv×WFVBrÂtæVæ‡VÒ&W7VÇFFòâr’“°¢&W7VÇBæ—FV×2æf÷$V6‚‚†—FVÒ’Óâ°¢6öç7B'WGFöâÒVÆVÖVçB‚v'WGFöârÂw6V&6‚Ö†—Br“°¢'WGFöâçG—RÒv'WGFöâs°¢6öç7BÆ&VÂÒ—FVÒæ¶–æBÓÓÒtõ$DU"p¢òG·&VfW&Væ6U†öæR†—FVÒ—ÒG¶—FVÒç6–×VÆF–öä6÷VçBâò+rG¶—FVÒç6–×VÆF–öä6÷VçGÒ6–×VÆ:|;VW6¢rwÒG¶—FVÒçfV†–6ÆUFW‡Bò(	BG¶F—7Æ”ÖöFVÂ†—FVÒçfV†–6ÆUFW‡B—Ö¢rwÖ ¢¢G¶—FVÒææÖWÒ+rG·&VfW&Væ6U†öæR†—FVÒ—ÒG¶—FVÒçfV†–6ÆUFW‡Bò(	BG¶F—7Æ”ÖöFVÂ†—FVÒçfV†–6ÆUFW‡B—Ö¢rwÖ°¢'WGFöâæVæB†VÆVÖVçB‚w7ârÂrrÂÆ&VÂ’ÂÖ¶T&FvR†—FVÒæÖF6†VD'’’“¶6öç7BF—&V7CÖF—&V7DÆVD&FvR†—FVÒ“¶–b†F—&V7B–'WGFöâæVæB†F—&V7B“¶–b†—FVÒç6V&6…7FvTÆ&VÂ–'WGFöâæVæB†Ö¶T&FvR†—FVÒç6V&6…7FvTÆ&VÂÆ—FVÒç6V&6…7FvSÓÓÒu4TåBsòvw&VVâs¦—FVÒç6V&6…7FvSÓÓÒu4dTBsòv&ÇVRs¢w–VÆÆ÷rr’“°¢'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ°¢6öç7B÷&–v–ãÖ6GW&T÷&–v–â‚“°¢&ö÷Bæ6Æ74Æ—7BæFB‚v†–FFVâr“°¢–b†—FVÒæ¶–æBÓÓÒtõ$DU"r’&WGW&â÷VäFWF–Â‚v÷&FW"rÂ—FVÒç&VbÇ¶÷&–v–çÒ“°¢–b†—FVÒæ¦÷W&æW”–B’&WGW&â÷VäFWF–Â‚vf–6†rÂ—FVÒæ¦÷W&æW”–BÇ¶÷&–v–çÒ“°¢Ò“°¢&ö÷BæVæB†'WGFöâ“°¢Ò“°¢&ö÷Bæ6Æ74Æ—7Bç&VÖ÷fR‚v†–FFVâr“°¢Ğ ¢gVæ7F–öâ÷Vå&W÷'B‡f–Wr’°¢&W÷'Ef–WrÒf–Ws°¢B‚w&W÷'B×FW‡Br’çfÇVRÒrs°¢B‚w&W÷'B×7FGW2r’çFW‡D6öçFVçBÒrs°¢B‚w&W÷'BÖF–Æörr’ç6†÷tÖöFÂ‚“°¢Ğ ¢7–æ2gVæ7F–öâvVæW&FU&W÷'B‚’°¢6öç7BW&–öBÒB‚w&W÷'B×W&–öBr’çfÇVS°¢6öç7B&×2ÒæWrU$Å6V&6…&×2‡²W&–öBÂf–Ws¢&W÷'Ef–WrÒ“°¢–b‡W&–öBÓÓÒv7W7FöÒr’°¢&×2ç6WB‚vg&öÒrÂB‚w&W÷'BÖg&öÒr’çfÇVR“°¢&×2ç6WB‚wFòrÂB‚w&W÷'B×Fòr’çfÇVR“°¢Ğ¢G'’°¢6öç7B&W÷'BÒv—B&WVW7B‚rö’÷æVÂ÷&W÷'Còr²&×2çFõ7G&–ær‚’“°¢B‚w&W÷'B×FW‡Br’çfÇVRÒ&W÷'BçFW‡C°¢B‚w&W÷'B×7FGW2r’çFW‡D6öçFVçBÒu&VÆL;7&–òvW&Fòâs°¢Ò6F6‚…ò’°¢B‚w&W÷'B×7FGW2r’çFW‡D6öçFVçBÒtì:6òfö’÷7<:×fVÂvW&"ò&VÆL;7&–ò&W76RW,:ÖöFòâs°¢Ğ¢Ğ ¢7–æ2gVæ7F–öâ6÷•&W÷'B‚’°¢–b‚B‚w&W÷'B×FW‡Br’çfÇVR’&WGW&ã°¢v—Bæf–vF÷"æ6Æ—&ö&Bçw&—FUFW‡B‚B‚w&W÷'B×FW‡Br’çfÇVR“°¢B‚w&W÷'B×7FGW2r’çFW‡D6öçFVçBÒuFW‡Fò6÷–Fòâs°¢Ğ ¢6öç7B4U54”ôåô´U’ÒvÖ75÷æVÅ÷6W76–öâs°¢6öç7B7F÷&U6W76–öâÒ‚’Óâ°¢6öç7B7F÷&vRÒW'6—7FVçE6W76–öâòÆö6Å7F÷&vR¢6W76–öå7F÷&vS°¢6öç7B÷F†W%7F÷&vRÒW'6—7FVçE6W76–öâò6W76–öå7F÷&vR¢Æö6Å7F÷&vS°¢÷F†W%7F÷&vRç&VÖ÷fT—FVÒ…4U54”ôåô´U’“°¢7F÷&vRç6WD—FVÒ…4U54”ôåô´U’Â¥4ôâç7G&–æv–g’‡²66W75Fö¶VâÂ&Vg&W6…Fö¶VâÂ66W74W‡—&W4BÒ’“°¢Ó°¢6öç7B66WDWF…6W76–öâÒ†FFÂ&VÖVÖ&W"ÒW'6—7FVçE6W76–öâ’Óâ°¢66W75Fö¶VâÒFFæ66W75÷Fö¶Vã°¢&Vg&W6…Fö¶VâÒFFç&Vg&W6…÷Fö¶VâÇÂ&Vg&W6…Fö¶Vã°¢66W74W‡—&W4BÒFFRææ÷r‚’²ÖF‚æÖ‚ƒÂçVÖ&W"†FFæW‡—&W5ö–âÇÂ3c’Òc’¢°¢W'6—7FVçE6W76–öâÒ&VÖVÖ&W#°¢7F÷&U6W76–öâ‚“°¢Ó°¢6öç7B6ÆV%6W76–öâÒ‚’Óâ°¢6W76–öå7F÷&vRç&VÖ÷fT—FVÒ…4U54”ôåô´U’“°¢Æö6Å7F÷&vRç&VÖ÷fT—FVÒ…4U54”ôåô´U’“°¢66W75Fö¶VâÒçVÆÃ°¢&Vg&W6…Fö¶VâÒçVÆÃ°¢66W74W‡—&W4BÒ°¢W'6—7FVçE6W76–öâÒfÇ6S°¢Ó°¢7–æ2gVæ7F–öâ&Vg&W6„66W75Fö¶Vâ‚’°¢–b‚&Vg&W6…Fö¶VâÇÂ6öæf–r’&WGW&âfÇ6S°¢6öç7B&W7öç6RÒv—BfWF6‚†6öæf–rçW&Â²röWF‚÷c÷Fö¶Vãöw&çE÷G—S×&Vg&W6…÷Fö¶VârÂ°¢ÖWF†öC¢uõ5BrÀ¢†VFW'3¢²–¶W“¢6öæf–rçV&Æ—6†&ÆT¶W’Âv6öçFVçB×G—Rs¢vÆ–6F–öâö§6öârÒÀ¢&öG“¢¥4ôâç7G&–æv–g’‡²&Vg&W6…÷Fö¶Vã¢&Vg&W6…Fö¶VâÒ¢Ò“°¢6öç7BFFÒv—B&W7öç6Ræ§6öâ‚’æ6F6‚‚‚’Óâ‡·Ò’“°¢–b‚&W7öç6Ræö²ÇÂFFæ66W75÷Fö¶Vâ’°¢6ÆV%6W76–öâ‚“°¢&WGW&âfÇ6S°¢Ğ¢66WDWF…6W76–öâ†FF“°¢&WGW&âG'VS°¢Ğ¢7–æ2gVæ7F–öâ&W7F÷&U6W76–öâ‚’°¢ÆWB&rÒÆö6Å7F÷&vRævWD—FVÒ…4U54”ôåô´U’“°¢W'6—7FVçE6W76–öâÒ&ööÆVâ‡&r“°¢–b‚&r’&rÒ6W76–öå7F÷&vRævWD—FVÒ…4U54”ôåô´U’“°¢–b‚&r’&WGW&ã°¢G'’°¢6öç7B7F÷&VBÒ¥4ôâç'6R‡&r“°¢66W75Fö¶VâÒ7F÷&VBæ66W75Fö¶VâÇÂçVÆÃ°¢&Vg&W6…Fö¶VâÒ7F÷&VBç&Vg&W6…Fö¶VâÇÂçVÆÃ°¢66W74W‡—&W4BÒçVÖ&W"‡7F÷&VBæ66W74W‡—&W4BÇÂ“°¢–b‚66W75Fö¶VâÇÂ66W74W‡—&W4BÃÒFFRææ÷r‚’’v—B&Vg&W6„66W75Fö¶Vâ‚“°¢Ò6F6‚…ò’°¢6ÆV%6W76–öâ‚“°¢Ğ¢Ğ¢6öç7B7F'E6fU&Vg&W6‚Ò‚’Óâ°¢6ÆV$–çFW'fÂ‡&Vg&W6…F–ÖW"“°¢&Vg&W6…F–ÖW"Ò6WD–çFW'fÂ†7–æ2‚’Óâ°¢G'’°¢v—BÆöD7W'&VçB‚“°¢v—BÆöD6GW&Uv&æ–ær‚“°¢Ò6F6‚…ò’²6ÆV$–çFW'fÂ‡&Vg&W6…F–ÖW"“²Ğ¢ÒÂ#“°¢Ó°¢7–æ2gVæ7F–öâ&÷WFTg&öÔ†6‚‡W6‚ÒfÇ6R’°¢6öç7B†6‚Ò7G&–ær†Æö6F–öâæ†6‚ÇÂrr“°¢6öç7B÷&FW"Ò†6‚æÖF6‚‚õâ7VF–FõÂò…´Ô„¢ÔåÕ£"Ó•×³WÒ’Bö’“°¢–b†÷&FW"’°¢6öç7B&VbÒFV6öFUU$”6ö×öæVçB†÷&FW%³Ò’çFõWW$66R‚“°¢v—B÷VäFWF–Â‚v÷&FW"rÂ&VbÂ²W6‚Â÷&–v–ã¢†—7F÷'’ç7FFRbb†—7F÷'’ç7FFRæ÷&–v–âÇÂFWF–Ä÷&–v–âÇÂ6GW&T÷&–v–â‚’Ò“°¢&WGW&âG'VS°¢Ğ¢6öç7B&V6÷&BÒ†6‚æÖF6‚‚õâ6f–6†Âò…³Ó–ÖbÕ×³3gÒ’Bö’“°¢–b‡&V6÷&B’°¢v—B÷VäFWF–Â‚vf–6†rÂFV6öFUU$”6ö×öæVçB‡&V6÷&E³Ò’Â²W6‚Â÷&–v–ã¢†—7F÷'’ç7FFRbb†—7F÷'’ç7FFRæ÷&–v–âÇÂFWF–Ä÷&–v–âÇÂ6GW&T÷&–v–â‚’Ò“°¢&WGW&âG'VS°¢Ğ¢&WGW&âfÇ6S°¢Ğ ¢7–æ2gVæ7F–öâ†æFÆU÷7FFR†WfVçB’°¢FWF–Å&WVW7EfW'6–öâ²³°¢–b‚66W75Fö¶Vâ’&WGW&ã°¢6öç7B7FFRÒWfVçBç7FFRÇÂ·Ó°¢–b‡7FFRæFWF–Âbb7FFRæ¶–æBbb7FFRæ¶W’’°¢v—B÷VäFWF–Â‡7FFRæ¶–æBÂ7FFRæ¶W’Â²W6ƒ¢fÇ6RÂ÷&–v–ã¢7FFRæ÷&–v–âÇÂFWF–Ä÷&–v–âÒ“°¢&WGW&ã°¢Ğ¢–b†v—B&÷WFTg&öÔ†6‚†fÇ6R’’&WGW&ã°¢v—B&W7F÷&T÷&–v–â‡7FFRçæVÄ÷&–v–âÇÂFWF–Ä÷&–v–âÇÂ²f–Ws¢7W'&VçEf–WrÇÂwFöF’rÂ67&öÆÅ“¢Ò“°¢Ğ ¢7–æ2gVæ7F–öâ&÷WFU6W76–öâ‚’°¢–b‚66W75Fö¶Vâ’&WGW&â6†÷r‚vÆöv–â×f–Wrr“°¢G'’°¢6öç7B6W76–öâÒv—B&WVW7B‚rö’÷æVÂ÷6W76–öâr“°¢–b‡6W76–öâæ×W7D6†ævU77v÷&B’&WGW&â6†÷r‚w77v÷&B×f–Wrr“°¢6†÷r‚v×f–Wrr“°¢v—B7v—F6…æVÂ‚wFöF’r“°¢–b‚†—7F÷'’ç7FFR’†—7F÷'’ç&WÆ6U7FFR‡²æVÄ÷&–v–ã¢6GW&T÷&–v–â‚’ÒÂrrÂÆö6F–öâçF†æÖR²Æö6F–öâç6V&6‚²†Æö6F–öâæ†6‚ÇÂrr’“°¢v—B&÷WFTg&öÔ†6‚†fÇ6R“°¢v—B&Vg&W6„6÷VçFW'2‚“°¢v—BÆöDWFöÖF–4ÖW76vW2‚“°¢7F'E6fU&Vg&W6‚‚“°¢Ò6F6‚†f–ÇW&R’°¢6ÆV%6W76–öâ‚“°¢6†÷r‚vÆöv–â×f–Wrr“°¢–b†f–ÇW&Ræ6öFRÓÓÒuäTÅô44U55ôDTä”TBr’W'&÷"‚vÆöv–âÖW'&÷"rÂtW7F6öçFì:6òFVÒ6W76òò–æVÂâr“°¢Ğ¢Ğ¢7–æ2gVæ7F–öâÆöDWFöÖF–4ÖW76vW2‚—°¢6öç7BÆ—7CÒB‚vWFöÖF–2ÖÖW76vRÖÆ—7Br“¶–b‚Æ—7B—&WGW&ã°¢G'—¶6öç7BFFÖv—B&WVW7B‚rö’÷æVÂöWFöÖF–2ÖÖW76vW2r“¶Æ—7Bç&WÆ6T6†–ÆG&Vâ‚“²†FFæ—FV×7ÇÅµÒ’æf÷$V6‚‚†—FVÒ“Óç¶6öç7B&÷sÖVÆVÖVçB‚vF—brÂwVWVRÖ—FVÒr“·&÷ræVæB†VÆVÖVçB‚w7ârÂrrÆ—FVÒæ&öG•öæ÷&ÖÆ—¦VB’“¶6öç7B&VÖ÷fSÖVÆVÖVçB‚v'WGFöârÂwV–WB6ÖÆÂrÂu&VÖ÷fW"r“·&VÖ÷fRçG—SÒv'WGFöâs·&VÖ÷fRæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÆ7–æ2‚“Óç·&VÖ÷fRæF—6&ÆVC×G'VS¶v—B&WVW7B‚rö’÷æVÂöWFöÖF–2ÖÖW76vW2rÇ¶ÖWF†öC¢uõ5BrÆ&öG“¤¥4ôâç7G&–æv–g’‡¶7F–öã¢vFVÆWFRrÆ–C¦—FVÒæ–GÒ—Ò“¶v—BÆöDWFöÖF–4ÖW76vW2‚“·Ò“·&÷ræVæB‡&VÖ÷fR“¶Æ—7BæVæB‡&÷r“·Ò“·Ö6F6‚…ò—¶Æ—7BçFW‡D6öçFVçCÒtì:6òfö’÷7<:×fVÂ6'&Vv"ÖVç6vVç2WFöÜ:F–62âs·Ğ¢Ğ¢B‚vWFöÖF–2ÖÖW76vR×6fRr“òæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÆ7–æ2‚“Óç¶6öç7B–çWCÒB‚vWFöÖF–2ÖÖW76vR×FW‡Br’Ç6fSÒB‚vWFöÖF–2ÖÖW76vR×6fRr“¶–b‚–çWBçfÇVRçG&–Ò‚’—&WGW&ã·6fRæF—6&ÆVC×G'VS·G'—¶v—B&WVW7B‚rö’÷æVÂöWFöÖF–2ÖÖW76vW2rÇ¶ÖWF†öC¢uõ5BrÆ&öG“¤¥4ôâç7G&–æv–g’‡¶7F–öã¢w6fRrÇFW‡C¦–çWBçfÇVWÒ—Ò“¶–çWBçfÇVSÒrs¶v—BÆöDWFöÖF–4ÖW76vW2‚“·Öf–æÆÇ—·6fRæF—6&ÆVCÖfÇ6S·×Ò“°¢7–æ2gVæ7F–öâ6–vä–â†WfVçB’°¢WfVçBç&WfVçDFVfVÇB‚“°¢W'&÷"‚vÆöv–âÖW'&÷"r“°¢6öç7B&W7öç6RÒv—BfWF6‚†6öæf–rçW&Â²röWF‚÷c÷Fö¶Vãöw&çE÷G—S×77v÷&BrÂ²ÖWF†öC¢uõ5BrÂ†VFW'3¢²–¶W“¢6öæf–rçV&Æ—6†&ÆT¶W’Âv6öçFVçB×G—Rs¢vÆ–6F–öâö§6öârÒÂ&öG“¢¥4ôâç7G&–æv–g’‡²VÖ–Ã¢B‚vVÖ–Âr’çfÇVRçG&–Ò‚’Â77v÷&C¢B‚w77v÷&Br’çfÇVRÒ’Ò“°¢6öç7BFFÒv—B&W7öç6Ræ§6öâ‚’æ6F6‚‚‚’Óâ‡·Ò’“°¢–b‚&W7öç6Ræö²ÇÂFFæ66W75÷Fö¶Vâ’&WGW&âW'&÷"‚vÆöv–âÖW'&÷"rÂtRÖÖ–Â÷R6Væ†–çl:Æ–F÷2âr“°¢66WDWF…6W76–öâ†FFÂB‚w&VÖVÖ&W"ÖÆöv–âr’æ6†V6¶VB“°¢B‚w77v÷&Br’çfÇVRÒrs°¢v—B&÷WFU6W76–öâ‚“°¢Ğ¢7–æ2gVæ7F–öâ6†ævU77v÷&B†WfVçB’°¢WfVçBç&WfVçDFVfVÇB‚“°¢W'&÷"‚w77v÷&BÖW'&÷"r“°¢6öç7B77v÷&BÒB‚væWr×77v÷&Br’çfÇVS°¢–b‡77v÷&BÓÒB‚v6öæf—&Ò×77v÷&Br’çfÇVR’&WGW&âW'&÷"‚w77v÷&BÖW'&÷"rÂt26Væ†2ì:6ò6ö–æ6–FVÒâr“°¢G'’°¢v—B&WVW7B‚rö’÷æVÂö6ö×ÆWFR×77v÷&BrÂ²ÖWF†öC¢uõ5BrÂ&öG“¢¥4ôâç7G&–æv–g’‡²æWu77v÷&C¢77v÷&BÒ’Ò“°¢v—B&÷WFU6W76–öâ‚“°¢Ò6F6‚†f–ÇW&R’°¢W'&÷"‚w77v÷&BÖW'&÷"rÂf–ÇW&Ræ6öFRÓÓÒu55tõ$Eõ$UT•$TÔTåE5ôäõEôÔUBròuW6R"6&7FW&W2ÂÖœ;§67VÆÂÖ–ì;§67VÆÂì;¦ÖW&òR<:ÖÖ&öÆòâr¢tì:6òfö’÷7<:×fVÂGVÆ—¦"6Væ†âr“°¢Ğ¢Ğ¢7–æ2gVæ7F–öâ&ö÷B‚’°¢G'’²6öæf–rÒv—B&WVW7B‚rö’÷æVÂö6öæf–rr“²Ò6F6‚…ò’²W'&÷"‚vÆöv–âÖW'&÷"rÂu–æVÂ–æF—7öì:×fVÂæòÖöÖVçFòâr“²&WGW&ã²Ğ¢v—B&W7F÷&U6W76–öâ‚“°¢B‚vÆöv–âÖf÷&Òr’æFDWfVçDÆ—7FVæW"‚w7V&Ö—BrÂ6–vä–â“°¢B‚w77v÷&BÖf÷&Òr’æFDWfVçDÆ—7FVæW"‚w7V&Ö—BrÂ6†ævU77v÷&B“°¢B‚vÆöv÷WBr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ²6ÆV$–çFW'fÂ‡&Vg&W6…F–ÖW"“²6ÆV%6W76–öâ‚“²6†÷r‚vÆöv–â×f–Wrr“²Ò“°¢Fö7VÖVçBçVW'•6VÆV7F÷$ÆÂ‚u¶FF×f–WuÒr’æf÷$V6‚‚†'WGFöâ’Óâ'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ°¢†—7F÷'’ç&WÆ6U7FFR‡²æVÄ÷&–v–ã¢²f–Ws¢'WGFöâæFF6WBçf–WrÂ67&öÆÅ“¢Â÷&FW$f–ÇFW"Â÷&FW%W&–öBÂ÷&FW$ÆöFVC¢÷&FW$—FV×2æÆVæwF‚ÒÒÂrrÂÆö6F–öâçF†æÖR²Æö6F–öâç6V&6‚“°¢v—B7v—F6…æVÂ†'WGFöâæFF6WBçf–Wr“°¢Ò’“°¢B‚vFWF–ÂÖ&6²r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ°¢FWF–Å&WVW7EfW'6–öâ²³°¢–b††—7F÷'’ç7FFRbb†—7F÷'’ç7FFRæFWF–Â’†—7F÷'’æ&6²‚“°¢VÇ6R°¢†—7F÷'’ç&WÆ6U7FFR‡²æVÄ÷&–v–ã¢FWF–Ä÷&–v–âÇÂ²f–Ws¢wFöF’rÂ67&öÆÅ“¢ÒÒÂrrÂÆö6F–öâçF†æÖR²Æö6F–öâç6V&6‚“°¢&W7F÷&T÷&–v–â‚’æ6F6‚‚‚’Óâ·Ò“°¢Ğ¢Ò“°¢v–æF÷ræFDWfVçDÆ—7FVæW"‚w÷7FFRrÂ†WfVçB’Óâ²†æFÆU÷7FFR†WfVçB’æ6F6‚‚‚’Óâ·Ò“²Ò“°¢Fö7VÖVçBçVW'•6VÆV7F÷$ÆÂ‚u¶FFÖ÷&FW"Öf–ÇFW%Òr’æf÷$V6‚‚†'WGFöâ’Óâ'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ°¢÷&FW$f–ÇFW"Ò'WGFöâæFF6WBæ÷&FW$f–ÇFW#°¢–b†÷&FW$f–ÇFW"ÓÓÒuVæFVçFW2r’÷&FW%W&–öBÒvÆÂs°¢Fö7VÖVçBçVW'•6VÆV7F÷$ÆÂ‚u¶FFÖ÷&FW"Öf–ÇFW%Òr’æf÷$V6‚‚†—FVÒ’Óâ—FVÒæ6Æ74Æ—7BçFövvÆR‚v7F—fRrÂ—FVÒÓÓÒ'WGFöâ’“°¢7–æ4÷&FW$6öçG&öÇ2‚“°¢–b†7W'&VçEf–WrÓÓÒv÷&FW'2r’v—BÆöD7W'&VçB‚“°¢Ò’“°¢Fö7VÖVçBçVW'•6VÆV7F÷$ÆÂ‚u¶FFÖ÷&FW"×W&–öEÒr’æf÷$V6‚‚†'WGFöâ’Óâ'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ°¢÷&FW%W&–öBÒ'WGFöâæFF6WBæ÷&FW%W&–öC°¢Fö7VÖVçBçVW'•6VÆV7F÷$ÆÂ‚u¶FFÖ÷&FW"×W&–öEÒr’æf÷$V6‚‚†—FVÒ’Óâ—FVÒæ6Æ74Æ—7BçFövvÆR‚v7F—fRrÂ—FVÒÓÓÒ'WGFöâ’“°¢–b†7W'&VçEf–WrÓÓÒv÷&FW'2r’v—BÆöD7W'&VçB‚“°¢Ò’“°¢B‚v÷&FW'2ÖÖ÷&Rr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’ÓâÆöD÷&FW'2‡G'VR’æ6F6‚‚‚’Óâ²B‚v÷&FW'2ÖÖ÷&Rr’çFW‡D6öçFVçBÒtì:6òfö’÷7<:×fVÂ6'&Vv"s²Ò’“°¢²wFöF’rÂvVçG'’rÂwVæF–ærrÂv÷&FW'2rÂwVÆ–f–6F–öârÂw6V&6†W2rÂvÖæ†V–ÒrÂw&V6÷&G2uÒæf÷$V6‚‚†æÖR“Óç¶6öç7B6VÆV7CÒB†æÖR²r×6÷'Br“¶–b‚6VÆV7B—&WGW&ã¶6öç7B6fVCÖÆö6Å7F÷&vRævWD—FVÒ‚vÖ75÷6÷'Eòr¶æÖR“¶–b‡6fVBbe²ââç6VÆV7Bæ÷F–öç5Òç6öÖR‚†÷F–öâ“Óæ÷F–öâçfÇVSÓÓ×6fVB’—6VÆV7BçfÇVS×6fVC·6VÆV7BæFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚“Óç¶Æö6Å7F÷&vRç6WD—FVÒ‚vÖ75÷6÷'Eòr¶æÖRÇ6VÆV7BçfÇVR“¶–b†7W'&VçEf–WrÓÖæÖR—&WGW&ã¶–b†æÖSÓÓÒvÖæ†V–Òr—·&VæFW%6fVE6V&6†W2‚’æ6F6‚‚‚“Óç·Ò“·&WGW&ã·ÖÆöD7W'&VçB‚’æ6F6‚‚‚“Óç·Ò“·Ò“·Ò“°¢Fö7VÖVçBçVW'•6VÆV7F÷$ÆÂ‚u¶FF×VæF–ær×6—GVF–öåÒr’æf÷$V6‚‚†'WGFöâ“Óæ'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÆ7–æ2‚“Óç·VæF–æu6—GVF–öãÖ'WGFöâæFF6WBçVæF–æu6—GVF–öã¶Fö7VÖVçBçVW'•6VÆV7F÷$ÆÂ‚u¶FF×VæF–ær×6—GVF–öåÒr’æf÷$V6‚‚†—FVÒ“Óæ—FVÒæ6Æ74Æ—7BçFövvÆR‚v7F—fRrÆ—FVÓÓÓÖ'WGFöâ’“¶–b†7W'&VçEf–WsÓÓÒwVæF–ærr–v—BÆöEVæF–ær‚“·Ò’“°¢B‚wVæF–ær×v—F‚×&Vbr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚“Óç¶–b†7W'&VçEf–WsÓÓÒwVæF–ærr–ÆöEVæF–ær‚’æ6F6‚‚‚“Óç·Ò“·Ò“°¢B‚wVæF–ærÖF÷væÆöBr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÆ7–æ2‚“Óç¶6öç7B'WGFöãÒB‚wVæF–ærÖF÷væÆöBr“¶'WGFöâæF—6&ÆVC×G'VS·G'—¶v—BF÷væÆöEVæF–æt77b‚“·Ö6F6‚…ò—¶'WGFöâægFW"†VÆVÖVçB‚w7ârÂvW'&÷"rÂtì:6òfö’÷7<:×fVÂ&—†"Ææ–Æ†âr’“·Öf–æÆÇ—¶'WGFöâæF—6&ÆVCÖfÇ6S·×Ò“°¢Fö7VÖVçBçVW'•6VÆV7F÷$ÆÂ‚u¶FF×&W÷'EÒr’æf÷$V6‚‚†'WGFöâ’Óâ'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ÷Vå&W÷'B†'WGFöâæFF6WBç&W÷'B’’“°¢B‚vvÆö&Â×6V&6‚r’æFDWfVçDÆ—7FVæW"‚w7V&Ö—BrÂ†WfVçB’ÓâvÆö&Å6V&6‚†WfVçB’æ6F6‚‚‚’Óâ²B‚w6V&6‚×&W7VÇG2r’ç&WÆ6T6†–ÆG&Vâ†VÆVÖVçB‚wrÂv×WFVBrÂtì:6òfö’÷7<:×fVÂ'W66"âr’“²B‚w6V&6‚×&W7VÇG2r’æ6Æ74Æ—7Bç&VÖ÷fR‚v†–FFVâr“²Ò’“°¢B‚w&W÷'B×W&–öBr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’ÓâB‚w&W÷'BÖ7W7FöÒr’æ6Æ74Æ—7BçFövvÆR‚v†–FFVârÂB‚w&W÷'B×W&–öBr’çfÇVRÓÒv7W7FöÒr’“°¢B‚w&W÷'BÖvVæW&FRr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂvVæW&FU&W÷'B“°¢B‚w&W÷'BÖ6÷’r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ6÷•&W÷'B‚’æ6F6‚‚‚’Óâ²B‚w&W÷'B×7FGW2r’çFW‡D6öçFVçBÒtì:6òfö’÷7<:×fVÂ6÷–"âs²Ò’“°¢B‚wv†G6Öf–ÆW2r’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ†WfVçB’Óâ–×÷'Df–ÆW2…²ââæWfVçBçF&vWBæf–ÆW5Ò’æ6F6‚‡6†÷t–×÷'Df–ÇW&R’“°¢B‚v†—7F÷'’Ö–×÷'BÖf–ÆRr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ†WfVçB’Óâ°¢†—7F÷'”–×÷'Df–ÆRÒWfVçBçF&vWBæf–ÆW3òå³ÒÇÂçVÆÃ°¢B‚v†—7F÷'’Ö–×÷'B×6VæBr’æF—6&ÆVBÒ†—7F÷'”–×÷'Df–ÆS°¢B‚v†—7F÷'’Ö–×÷'B×7FGW2r’çFW‡D6öçFVçBÒ†—7F÷'”–×÷'Df–ÆRòG¶†—7F÷'”–×÷'Df–ÆRææÖWÒ&öçFò&–×÷'F"æ¢rs°¢Ò“°¢B‚v†—7F÷'’Ö–×÷'B×6VæBr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ–×÷'C3c†—7F÷'’‚’æ6F6‚‚†f–ÇW&R’Óâ°¢B‚v†—7F÷'’Ö–×÷'B×7FGW2r’çFW‡D6öçFVçBÒf–ÇW&Sòæ6öFRÓÓÒt„•5Dõ%•ô”Õõ%Eô”ådÄ”BrÇÂf–ÇW&SòæÖW76vRÓÓÒt„•5Dõ%•ôd”ÄUô”ådÄ”BròtW7FRì:6ò:’ò'V—fòFò†—7L;7&–6òFò3cF–Æör&òì;¦ÖW&ò6öæf–wW&Fòâr¢tì:6òfö’÷7<:×fVÂ–×÷'F"v÷&âfö<:¢öFRFVçF"FRæ÷fò6VÒGWÆ–6"âs°¢B‚v†—7F÷'’Ö–×÷'B×6VæBr’æF—6&ÆVBÒ†—7F÷'”–×÷'Df–ÆS°¢Ò’“°¢6öç7B¦öæRÒB‚vG&÷×¦öæRr“°¢²vG&vVçFW"rÂvG&v÷fW"uÒæf÷$V6‚‚†æÖR’Óâ¦öæRæFDWfVçDÆ—7FVæW"†æÖRÂ†WfVçB’Óâ²WfVçBç&WfVçDFVfVÇB‚“²¦öæRæ6Æ74Æ—7BæFB‚vG&vv–ærr“²Ò’“°¢²vG&vÆVfRrÂvG&÷uÒæf÷$V6‚‚†æÖR’Óâ¦öæRæFDWfVçDÆ—7FVæW"†æÖRÂ†WfVçB’Óâ²WfVçBç&WfVçDFVfVÇB‚“²¦öæRæ6Æ74Æ—7Bç&VÖ÷fR‚vG&vv–ærr“²Ò’“°¢¦öæRæFDWfVçDÆ—7FVæW"‚vG&÷rÂ†WfVçB’Óâ–×÷'Df–ÆW2…²ââæWfVçBæFFG&ç6fW"æf–ÆW5Ò’æ6F6‚‡6†÷t–×÷'Df–ÇW&R’“°¢B‚vÖæ†V–ÒÖf–ÆW2r’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ†WfVçB’Óâ–×÷'DÖæ†V–Ò…²ââæWfVçBçF&vWBæf–ÆW5Ò’æ6F6‚‡6†÷tÖæ†V–Ôf–ÇW&R’“°¢6öç7BÖæ†V–Õ¦öæRÒB‚vÖæ†V–ÒÖG&÷×¦öæRr“°¢²vG&vVçFW"rÂvG&v÷fW"uÒæf÷$V6‚‚†æÖR’ÓâÖæ†V–Õ¦öæRæFDWfVçDÆ—7FVæW"†æÖRÂ†WfVçB’Óâ²WfVçBç&WfVçDFVfVÇB‚“²Öæ†V–Õ¦öæRæ6Æ74Æ—7BæFB‚vG&vv–ærr“²Ò’“°¢²vG&vÆVfRrÂvG&÷uÒæf÷$V6‚‚†æÖR’ÓâÖæ†V–Õ¦öæRæFDWfVçDÆ—7FVæW"†æÖRÂ†WfVçB’Óâ²WfVçBç&WfVçDFVfVÇB‚“²Öæ†V–Õ¦öæRæ6Æ74Æ—7Bç&VÖ÷fR‚vG&vv–ærr“²Ò’“°¢Öæ†V–Õ¦öæRæFDWfVçDÆ—7FVæW"‚vG&÷rÂ†WfVçB’Óâ–×÷'DÖæ†V–Ò…²ââæWfVçBæFFG&ç6fW"æf–ÆW5Ò’æ6F6‚‡6†÷tÖæ†V–Ôf–ÇW&R’“°¢B‚w6×2Öf÷&Òr’æFDWfVçDÆ—7FVæW"‚w7V&Ö—BrÂFE6×2“°¢B‚w6×2Ö6öçF7Br’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ²6öç7Bg&W6ƒÒB‚w6×2Ö6öçF7Br’çfÇVSÓÓÒvæWrs²B‚w6×2ÖæWrÖæÖRÖÆ&VÂr’æ†–FFVãÒg&W6ƒ²B‚w6×2ÖæWr×†öæRÖÆ&VÂr’æ†–FFVãÒg&W6ƒ·&Vg&W6…6×4¦÷W&æW—2‚“²Ò“°¢B‚vWFò×&–çBÖf–ÆRr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚“Óç¶6öç7Bf–ÆW3ÒB‚vWFò×&–çBÖf–ÆRr’æf–ÆW3¶–b†f–ÆW2æÆVæwF‚—6†÷tWFõ&–çD6†ö–6R†f–ÆW2“·Ò“°¢B‚vWFò×&–çB×&VÖ÷fRr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÆ6ÆV$WFõ&–çB“°¢B‚vWFò×&–çB×6VæBr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚“Óç6VæDWFõ&–çB‚’æ6F6‚‚‚“Óç·Ò’“°¢B‚w6×2ÖFFRr’çfÇVRÒÆö6Ä–çWB‚“°¢v—B&÷WFU6W76–öâ‚“°¢Ğ¢&ö÷B‚“°§Ò’‚“° 