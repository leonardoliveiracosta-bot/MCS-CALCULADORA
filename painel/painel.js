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
  let clientsData = { items: [], pending: { items: [], counts: {} } };
  let todayRefFilter = localStorage.getItem('mcs_today_ref_filter') || 'all';
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
  const undoTimers = new Map();
  let autoPrintContext = null;
  let historyImportFile = null;
  const $ = (id) => document.getElementById(id);
  const productionHost = location.hostname === 'www.mycarscout.net';
  const environmentBadge = $('environment-badge');
  if (environmentBadge) { environmentBadge.textContent = productionHost ? 'PRODUÇÃO' : 'PREVIEW — NÃO USE PARA TRABALHAR'; environmentBadge.classList.toggle('production', productionHost); }
  const show = (id) => { document.body.classList.toggle('login-screen', id === 'login-view'); ['login-view', 'password-view', 'app-view'].forEach((view) => $(view).classList.toggle('hidden', view !== id)); };
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
  const updateFloridaClock = () => {
    const clock = $('today-florida-time');
    if (!clock) return;
    const now = new Date();
    const date = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/New_York', weekday: 'long', day: 'numeric', month: 'long'
    }).format(now);
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true
    }).format(now);
    clock.textContent = `${date} · ${time} (Flórida)`;
  };
  updateFloridaClock();
  setInterval(updateFloridaClock, 60000);
  const localInput = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const zonedInput = (date, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timeZone||'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map((part)=>[part.type,part.value]));
  const localInputForZone = (date, timeZone) => { const parts=zonedInput(date,timeZone); return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`; };
  const normalize = (value) => MCSParser.normalizeSender(value);
  const inferredContactName = (title) => MCSParser.clean(String(title || '').replace(/^WhatsApp Chat with\s+/i, '').replace(/^Conversa do WhatsApp com\s+/i, '')).slice(0, 160) || 'Contato sem nome';
  const setCount = (view, value) => document.querySelectorAll(`[data-count="${view}"]`).forEach((node) => {
    const count = Number(value) || 0;
    node.textContent = String(count);
    node.classList.toggle('count-positive', count > 0);
  });

  const PAYMENT_LABELS = Object.freeze({ cash: 'À vista', fin: 'Financiado', financing: 'Financiado' });
  const DEADLINE_LABELS = Object.freeze({ none: 'Sem prazo', now: 'Agora', '30d': '30 dias', '3m': '3 meses', '6m': '6 meses', '12m': '12 meses' });
  const SOURCE_LABELS = Object.freeze({ CALCULATOR: 'Calculadora', WHATSAPP_DIRECT: 'WhatsApp direto', SMS_DIRECT: 'SMS direto', MANUAL: 'Manual' });
  const displayPayment = (value) => PAYMENT_LABELS[String(value || '').toLowerCase()] || value || 'Não informado';
  const displayDeadline = (value) => DEADLINE_LABELS[String(value || '').toLowerCase()] || value || 'Sem prazo';
  const displayModel = (value) => String(value || '').replace(/\bnot sure\b/gi, '').replace(/\bother model\b/gi, 'Outro modelo').replace(/\s{2,}/g, ' ').trim();
  const checklistStatusLabel = (status) => status === 'COMPLETE' ? 'OK' : status === 'OPEN' ? 'Pendente' : status === 'NOT_APPLICABLE' ? 'Não se aplica' : status || '';
  const orderIcon = (item) => item.logicalMode === 'VALOR' || (item.logicalModes || []).every((mode) => mode === 'VALOR') ? '💰' : '🚗';


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
      const inferredName = inferredContactName(parsed.title);
      const suggestedMcs = parsed.senders.filter((name) => !MCSParser.senderLooksLikeContact(name, inferredName));
      const senderLabel = sender.closest('label');
      sender.dataset.confirmed = suggestedMcs.length === 1 ? 'false' : 'true';
      sender.addEventListener('change', () => { sender.dataset.confirmed = 'true'; });
      if (senderLabel) {
        const labelText = senderLabel.firstChild;
        if (labelText && labelText.nodeType === Node.TEXT_NODE) labelText.textContent = 'Você é: ';
        if (suggestedMcs.length === 1) {
          sender.value = suggestedMcs[0];
          const example = MCSParser.senderExample(parsed, suggestedMcs[0]);
          const confirm = element('button', 'quiet small', `Confirmar: você é ${suggestedMcs[0]}`);
          confirm.type = 'button';
          confirm.addEventListener('click', () => {
            sender.value = suggestedMcs[0];
            sender.dataset.confirmed = 'true';
            confirm.textContent = 'Confirmado';
            confirm.disabled = true;
          });
          senderLabel.append(confirm);
          if (example) senderLabel.append(element('span', 'muted sender-example', `Exemplo: “${example}”`));
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
          if (!$('chat-type').value) throw new Error('Confirme se é conversa individual ou grupo.');
          if (!$('mcs-sender').value) throw new Error('Confirme qual remetente é a MCS.');
          if ($('mcs-sender').dataset.confirmed === 'false') throw new Error('Confirme com um clique quem é você nesta conversa.');
          const contactName = $('import-contact').value === 'new'
            ? MCSParser.clean($('import-contact-name').value)
            : ((contacts.find((item) => item.id === $('import-contact').value) || {}).display_name || inferredContactName(parsed.title));
          if (!isGroup && MCSParser.senderLooksLikeContact($('mcs-sender').value, contactName || inferredContactName(parsed.title))) {
            throw new Error('O remetente da MCS não pode ser o mesmo nome do contato. Revise quem é você.');
          }
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
    if (!pending && lastJourneyId) await openDetail('ficha',lastJourneyId);
  }

  function clearRecordDetail(message = 'Escolha uma ficha.') {
    const root = $('record-detail');
    if (root) root.replaceChildren(element('p', 'muted', message));
  }

  function renderLoading(view) {
    const roots = { today: 'today-list', entry: 'entry-queue', clients: 'clients-list', pending: 'pending-list', orders: 'orders-list', qualification: 'qualification-list', searches: 'searches-list', manheim: 'manheim-results', records: 'records-list' };
    if (roots[view] && $(roots[view])) empty($(roots[view]), 'Carregando…');
    if (view === 'orders') $('orders-more').classList.add('hidden');
  }

  async function switchPanel(view) {
    if (!['today', 'entry', 'clients', 'orders', 'searches'].includes(view)) return;
    if (view !== 'pending') clearTimeout(pendingContinueTimer);
    currentView = view;
    const requestVersion = ++viewRequestVersion;
    clearRecordDetail();
    const labels = { today: 'HOJE', entry: 'ENTRADA', clients: 'CLIENTES', orders: 'PEDIDOS', searches: 'BUSCAS' };
    currentDetail = null;
    if ($('detail-panel')) $('detail-panel').classList.add('hidden');
    ['today','entry','clients','orders','searches','pending','qualification','manheim','records'].forEach((name) => $(name + '-panel')?.classList.toggle('hidden', name !== view));
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
    const reviewControls=(item,target,kind)=>{
      const controls=element('div','entry-review-actions');
      const select=element('select','');
      select.setAttribute('aria-label','Lead para ligar');
      select.append(new Option('Escolha um lead', ''));
      journeys.forEach((journey)=>select.append(new Option(`${journey.contact?.display_name||journey.vehicle_text||'Lead'}${journey.reference_code?` · ${journey.reference_code}`:''}`,journey.id)));
      const run=(button,action,successText)=>MCSAction.bind(button,()=>({
        scope:item,successScope:document.body,feedbackKey:`entry:${kind}:${target.id}`,
        optimistic:()=>{item.classList.add('action-optimistic-hidden');const before=countValue('entry');setCount('entry',Math.max(0,before-1));return before;},
        commit:()=>request('/api/panel/entry',{method:'POST',body:JSON.stringify({action,kind,id:target.id,journeyId:select.value||null})}),
        rollback:(before)=>{item.classList.remove('action-optimistic-hidden');setCount('entry',before);},
        successText,
        undo:{commit:(result)=>request('/api/panel/entry',{method:'POST',body:JSON.stringify({action:'review_undo',undo:result.undo})}),successText:'A conversa voltou para revisão.',refresh:()=>loadQueue()},
        refresh:()=>loadQueue(false),errorText:'Não consegui salvar — tente de novo'
      }));
      const link=element('button','small','Ligar a um lead');link.type='button';
      MCSAction.bind(link,()=>{
        if(!select.value)return{scope:item,commit:()=>Promise.reject(new Error('JOURNEY_REQUIRED')),errorText:'Escolha um lead antes de ligar.'};
        return{scope:item,successScope:document.body,feedbackKey:`entry:${kind}:${target.id}`,optimistic:()=>{item.classList.add('action-optimistic-hidden');const before=countValue('entry');setCount('entry',Math.max(0,before-1));return before;},commit:()=>request('/api/panel/entry',{method:'POST',body:JSON.stringify({action:'review_link',kind,id:target.id,journeyId:select.value})}),rollback:(before)=>{item.classList.remove('action-optimistic-hidden');setCount('entry',before);},successText:'Conversa ligada ao lead.',undo:{commit:(result)=>request('/api/panel/entry',{method:'POST',body:JSON.stringify({action:'review_undo',undo:result.undo})}),successText:'A conversa voltou para revisão.',refresh:()=>loadQueue()},refresh:()=>loadQueue(false),errorText:'Não consegui salvar — tente de novo'};
      });
      const create=element('button','quiet small','Criar lead novo');create.type='button';run(create,'review_create','Lead criado e conversa ligada.');
      const dismiss=element('button','quiet small','Dispensar (não é cliente)');dismiss.type='button';run(dismiss,'review_dismiss','Conversa dispensada.');
      controls.append(select,link,create,dismiss);
      return controls;
    };
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
        MCSAction.bind(keep,()=>({scope:item,optimistic:()=>{const before=badge.textContent;badge.textContent='revisão';return before;},commit:()=>request('/api/panel/entry',{method:'POST',body:JSON.stringify({action:'resolve',chatId:chat.id,resolution:'review'})}),rollback:(before)=>{badge.textContent=before;},refresh:()=>loadQueue(),errorText:'Não consegui salvar — tente de novo'}));
        item.append(keep);
      }
      if(chat.resolution_status!=='RESOLVED'||chat.hasTimeUncertain)item.append(reviewControls(item,chat,'chat'));
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
      item.append(title, note,reviewControls(item,review,'review'));
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
      ? 'Recebendo · último sinal há ' + ago(data.lastEventAt) : 'Sem sinal' + (data.lastEventAt ? ' há ' + ago(data.lastEventAt) : ' ainda');
    $('whatsapp-received').textContent = 'Última mensagem recebida há ' + ago(data.lastInboundAt);
    $('whatsapp-echo').textContent = 'Última mensagem enviada por você recebida há ' + ago(data.lastEchoAt);
    const errors = $('whatsapp-errors'); errors.replaceChildren();
    (data.errors || []).forEach((event) => {
      const row = element('div', 'queue-item');
      row.append(element('span', '', `Evento ${event.event_type} · ${event.status === 'ERROR' ? 'erro' : 'pendente'} · ${ago(event.received_at)}`));
      const retry = element('button', 'small', 'Reprocessar'); retry.type = 'button';
      MCSAction.bind(retry,()=>({scope:row,optimistic:()=>{retry.textContent='Reprocessando…';},commit:()=>request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:'reprocess',id:event.id})}),rollback:()=>{retry.textContent='Reprocessar';},refresh:()=>loadWhatsApp(),errorText:'Não consegui salvar — tente de novo'}));
      row.append(retry); errors.append(row);
    });
    (data.ignored||[]).forEach((event)=>errors.append(element('div','queue-item',`ignorado: ${String(event.error_code||event.event_type||'campo desconhecido').replace(/^IGNORED:/,'')}`)));
    const itemErrorLabel=(code)=>({HISTORY_DECLINED:'Histórico não compartilhado pelo WhatsApp',PHONE_INVALID:'Telefone inválido',PHONE_AMBIGUOUS:'Telefone ligado a mais de um contato',MESSAGE_CONTENT_INVALID:'Mensagem inválida',ITEM_PROCESSING_FAILED:'Falha ao gravar a mensagem',PROCESSING_INTERRUPTED:'Processamento interrompido'})[code]||'Falha ao processar este item';
    (data.itemErrors||[]).forEach((event)=>{const row=element('div','queue-item');row.append(element('span','',`Item ${event.item_index+1}: ${itemErrorLabel(event.error_code)}`));const declined=event.error_code==='HISTORY_DECLINED';const retry=element('button','small',declined?'Dispensar':'Tentar de novo');retry.type='button';retry.disabled=event.status==='PROCESSING';MCSAction.bind(retry,()=>({scope:row,optimistic:()=>{retry.textContent=declined?'Dispensando…':'Processando…';},commit:()=>request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:declined?'dismiss_item':'reprocess_item',id:event.id})}),rollback:()=>{retry.textContent=declined?'Dispensar':'Tentar de novo';},refresh:()=>Promise.all([loadWhatsApp(),loadQueue()]),errorText:'Não consegui salvar — tente de novo'}));row.append(retry);errors.append(row);});
    const suggestions = $('whatsapp-suggestions'); suggestions.replaceChildren();
    (data.suggestions || []).forEach((item) => {
      const row = element('div', 'queue-item');
      row.append(element('strong', '', item.target_ref?`Esta conversa do WhatsApp (${item.phone_e164}) parece ser Ref ${item.target_ref}`:`Esta conversa do WhatsApp (${item.phone_e164}) parece ser a ficha ${item.targetName || 'sem nome'} — ${item.sourceName || 'novo contato'}`));
      if(item.motives)row.append(element('span','muted',`Motivos: ${item.motives}`));
      for (const [label, link] of [['Ligar', true], ['Não é', false]]) {
        const action = element('button', link ? 'small' : 'quiet small', label); action.type = 'button';
        MCSAction.bind(action,()=>({scope:row,optimistic:()=>{row.classList.add('action-optimistic-hidden');},commit:()=>request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:'suggestion',id:item.id,link})}),rollback:()=>{row.classList.remove('action-optimistic-hidden');},refresh:()=>Promise.all([loadWhatsApp(),loadQueue()]),errorText:'Não consegui salvar — tente de novo'}));
        row.append(action);
      }
      const notLead=element('button','quiet small',item.sourceIsLead===false?'Restaurar lead':'Não é lead');notLead.type='button';MCSAction.bind(notLead,()=>{const before=item.sourceIsLead!==false;return{scope:row,optimistic:()=>{item.sourceIsLead=!before;notLead.textContent=item.sourceIsLead?'Não é lead':'Restaurar lead';return before;},commit:()=>request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:'contact_lead',contactId:item.source_contact_id,isLead:!before})}),rollback:(value)=>{item.sourceIsLead=value;notLead.textContent=value?'Não é lead':'Restaurar lead';},refresh:()=>Promise.all([loadWhatsApp(),loadQueue()]),errorText:'Não consegui salvar — tente de novo'};});row.append(notLead);
      suggestions.append(row);
    });
    (data.phoneReviews||[]).forEach((item)=>{const row=element('div','queue-item');row.append(element('strong','',`O telefone ${item.phone_e164} está em mais de um contato. Escolha o correto:`));(item.candidates||[]).forEach((candidate)=>{const group=element('span','inline-actions');const choose=element('button','small',candidate.name);choose.type='button';MCSAction.bind(choose,()=>({scope:row,optimistic:()=>{row.classList.add('action-optimistic-hidden');},commit:()=>request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:'phone_review',id:item.id,contactId:candidate.id})}),rollback:()=>{row.classList.remove('action-optimistic-hidden');},refresh:()=>Promise.all([loadWhatsApp(),loadQueue()]),errorText:'Não consegui salvar — tente de novo'}));const lead=element('button','quiet small',candidate.isLead===false?'Restaurar':'Não é lead');lead.type='button';MCSAction.bind(lead,()=>{const before=candidate.isLead!==false;return{scope:row,optimistic:()=>{candidate.isLead=!before;lead.textContent=candidate.isLead?'Não é lead':'Restaurar';return before;},commit:()=>request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:'contact_lead',contactId:candidate.id,isLead:!before})}),rollback:(value)=>{candidate.isLead=value;lead.textContent=value?'Não é lead':'Restaurar';},refresh:()=>Promise.all([loadWhatsApp(),loadQueue()]),errorText:'Não consegui salvar — tente de novo'};});group.append(choose,lead);row.append(group);});suggestions.append(row);});
    $('entry-needs-empty').classList.toggle('hidden', Boolean(errors.childElementCount || suggestions.childElementCount));
  }

  const historyPhone = '13055400742';
  function validHistoryObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !['history', 'smb_app_state_sync'].includes(value.event) || !String(value.id || '').trim() || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) return false;
    if (value.event === 'history' && ![value.data.history, value.data.messages, value.data.message_echoes].some(Array.isArray)) return false;
    if (Object.prototype.hasOwnProperty.call(value.data, 'metadata') && String(value.data.metadata?.display_phone_number || '').replace(/\D/g, '') !== historyPhone) return false;
    return true;
  }
  function historyOrder(value) {
    const ranks = (value.data?.history || []).map((chunk) => [Number(chunk?.metadata?.phase), Number(chunk?.metadata?.chunk_order)]).filter(([phase, order]) => Number.isFinite(phase) || Number.isFinite(order));
    return ranks.sort((left, right) => (left[0] - right[0]) || (left[1] - right[1]))[0] || [Infinity, Infinity];
  }
  function mediaHistoryOrder(value) {
    return Math.min(...[...(value.data?.messages || []), ...(value.data?.message_echoes || [])].map((message) => Number(message?.timestamp)).filter(Number.isFinite), Infinity);
  }
  function historyPartNumber(value) {
    const match = String(value?.id || '').match(/#p(\d+)$/);
    return match ? Number(match[1]) : 0;
  }
  function historyParts(value) {
    if (value?.event !== 'history' || !Array.isArray(value.data?.history)) return [value];
    const totalMessages = value.data.history.reduce((total, chunk) => total + (Array.isArray(chunk?.threads) ? chunk.threads : []).reduce((count, thread) => count + (Array.isArray(thread?.messages) ? thread.messages.length : 0), 0), 0);
    if (!totalMessages) return [value];
    const parts = [];
    for (const chunk of value.data.history) {
      let threads = [], messageCount = 0;
      const flush = () => {
        if (!threads.length) return;
        parts.push({ id: `${value.id}#p${parts.length + 1}`, event: 'history', data: { id: value.data.id, messaging_product: value.data.messaging_product, metadata: value.data.metadata, history: [{ metadata: chunk?.metadata, threads }] } });
        threads = []; messageCount = 0;
      };
      for (const thread of Array.isArray(chunk?.threads) ? chunk.threads : []) {
        const messages = Array.isArray(thread?.messages) ? thread.messages : [];
        for (let index = 0; index < messages.length;) {
          if (messageCount === 100) flush();
          const take = Math.min(100 - messageCount, messages.length - index);
          threads.push({ ...thread, messages: messages.slice(index, index + take) });
          messageCount += take; index += take;
          if (messageCount === 100) flush();
        }
      }
      flush();
    }
    return parts.length ? parts : [value];
  }
  function historyBatches(ordered) {
    const batches = [], encoder = new TextEncoder();
    let batch = [], bytes = 0;
    for (const item of ordered) {
      const itemBytes = encoder.encode(JSON.stringify(item)).length;
      if (batch.length && (batch.length === 10 || bytes + itemBytes > 500000)) { batches.push(batch); batch = []; bytes = 0; }
      batch.push(item); bytes += itemBytes;
    }
    if (batch.length) batches.push(batch);
    return batches;
  }
  const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  async function requestHistoryBatch(batch, requester, wait) {
    let failure;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await requester('/api/panel/history-import', { method: 'POST', body: JSON.stringify({ items: batch }) }); }
      catch (error) {
        failure = error;
        const retryable = !error?.code || error.code === 'HISTORY_IMPORT_FAILED' || error.message === 'REQUEST_FAILED';
        if (!retryable || attempt === 3) throw error;
        await wait(2000);
      }
    }
    throw failure;
  }
  async function import360History() {
    const status = $('history-import-status'), errors = $('history-import-errors'), sendButton = $('history-import-send');
    if (!historyImportFile) return;
    let entries;
    try { entries = JSON.parse(await historyImportFile.text()); } catch (_) { throw new Error('HISTORY_FILE_INVALID'); }
    if (!Array.isArray(entries) || !entries.length || !entries.every(validHistoryObject)) throw new Error('HISTORY_FILE_INVALID');
    const states = entries.filter((entry) => entry.event === 'smb_app_state_sync');
    const histories = entries.filter((entry) => entry.event === 'history' && Array.isArray(entry.data.history)).flatMap(historyParts).sort((left, right) => historyOrder(left)[0] - historyOrder(right)[0] || historyOrder(left)[1] - historyOrder(right)[1] || historyPartNumber(left) - historyPartNumber(right));
    const mediaHistories = entries.filter((entry) => entry.event === 'history' && !Array.isArray(entry.data.history)).sort((left, right) => mediaHistoryOrder(left) - mediaHistoryOrder(right));
    const ordered = states.concat(histories, mediaHistories), totals = { conversations: 0, imported: 0, alreadyExists: 0, errors: 0 };
    errors.replaceChildren(); sendButton.disabled = true;
    let completed = 0;
    for (const originalBatch of historyBatches(ordered)) {
      let batch = originalBatch, attempts = 0;
      while (batch.length) {
        status.textContent = `Importando ${Math.min(completed, ordered.length)} de ${ordered.length}…`;
        const result = await requestHistoryBatch(batch, request, pause);
        totals.conversations += Number(result.conversations || 0); totals.imported += Number(result.imported || 0); totals.alreadyExists += Number(result.alreadyExists || 0); totals.errors += Number(result.errors || 0);
        if (result.more) { const processed = Math.max(1, Number(result.nextIndex || 1)); completed += Math.min(processed, batch.length); batch = batch.slice(processed); continue; }
        if (result.inProgress && attempts++ < 8) { await pause(1000); continue; }
        if (result.inProgress) totals.errors += batch.length;
        completed += batch.length;
        break;
      }
      status.textContent = `Importando ${Math.min(completed, ordered.length)} de ${ordered.length}…`;
    }
    const summary = `Importado: ${totals.conversations} conversas, ${totals.imported} mensagens novas, ${totals.alreadyExists} já existiam, ${totals.errors} com erro`;
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

  function addSms(event) {
    event.preventDefault();
    const selected = $('sms-contact').value;
    const message = MCSParser.clean($('sms-text').value);
    const localInput = $('sms-date').value;
    const name = MCSParser.clean($('sms-new-name').value);
    const phone = MCSParser.clean($('sms-new-phone').value);
    if (!message || !localInput || (selected === 'new' && (!name||!phone))) {$('sms-status').textContent='Informe nome e telefone para o novo contato.';return;}
    const submit=event.submitter||$('sms-form').querySelector('button[type="submit"]');
    MCSAction.run({button:submit,scope:$('sms-form'),optimistic:()=>{$('sms-status').classList.remove('error');$('sms-status').textContent='Salvando…';},commit:async()=>{
      const contactId = selected === 'new' ? null : selected;
      const existingChat = chats.find((chat) => chat.channel === 'SMS' && chat.contact_id === contactId && !chat.is_group);
      const start = await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({
        action: 'start', sourceKind: 'SMS_PASTE', sourceFilename: 'SMS manual', sourceSha256: await sha256(message + localInput),
        chat: { channel: 'SMS', chatId: existingChat ? existingChat.id : null, isGroup: false, contactId, newContactName: selected === 'new' ? name : null, phone:selected==='new'?phone:null, aliasText: 'SMS', senderAliases: [] }
      }) });
      const date = smsDate(localInput),direction = $('sms-direction').value;
      const signature = await sha256([start.chatId, date.local, direction, message].join('\u001f'));
      const batch = await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'batch', importJobId: start.importJobId, batchNumber: 1, messages: [{
        chat_id: start.chatId, channel: 'SMS', direction, body_text: message, body_normalized: message,
        occurred_at_local: date.local, timezone_assumed: 'America/New_York', occurred_at_utc: date.utc,
        time_uncertain: date.timeUncertain, original_datetime_text: localInput, original_order: 1,
        source_kind: 'SMS_PASTE', is_edit_marker: false, is_delete_marker: false, signature_base: signature, file_occurrence_total: 1
      }] }) });
      const journeyValue = $('sms-journey').value;
      await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'finish', importJobId: start.importJobId, journey: { mode: journeyValue === 'new' ? 'new' : 'existing', journeyId: journeyValue === 'new' ? null : journeyValue }, refs: MCSParser.extractRefs([{ body: message }]) }) });
      return{batch,date};
    },onSuccess:({batch,date})=>{$('sms-status').textContent=`${batch.inserted} SMS adicionado(s)${date.timeUncertain?' — hora incerta, revisão necessária':''}.`;$('sms-text').value='';},refresh:()=>loadQueue(),onError:()=>{$('sms-status').classList.add('error');},errorText:'Não consegui salvar — tente de novo'});
  }

  function clearAutoPrint(){const input=$('auto-print-file');input.value='';autoPrintContext=null;$('auto-print-file-info').replaceChildren();$('auto-print-file-info').classList.add('hidden');$('auto-print-remove').classList.add('hidden');$('auto-print-send').disabled=true;$('auto-print-result').classList.add('hidden');}
  function showAutoPrintChoice(files){const info=$('auto-print-file-info');info.replaceChildren();[...files].forEach((file)=>info.append(element('span','',file.name),element('small','muted',`${(file.size/1024/1024).toFixed(1)} MB`)));info.classList.remove('hidden');$('auto-print-remove').classList.remove('hidden');$('auto-print-send').disabled=!files.length;}
  function autoPrintResult(filename,text,saved){const resultRoot=arguments[3],root=resultRoot||$('auto-print-result');root.classList.remove('hidden');const row=element('section',saved?'':'error');row.append(element('strong',saved?'':'warning',`${filename||'Print'} — ${text}`));root.append(row);return row;}
  async function saveAutoPrint(read,context,filename=read.original_filename,resultRoot){const values=read.extracted_json||{},hint=values.ref||context?.ref||'';const saved=await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'confirm',auto:true,readId:read.id,sourceJourneyId:context?.journeyId||null,phone:values.phone||'',name:values.name||'',ref:hint,message:values.message||'',translation:values.translation||''})});const name=saved.name||saved.phone||(saved.ref?`Pedido ${saved.ref}`:'lead novo');const root=autoPrintResult(filename,saved.duplicate?`Este print já foi guardado no lead de ${name} · Ref ${saved.ref||hint||'—'}`:`✓ ${saved.photoOnly?'Foto guardada':'Guardado'} no lead de ${name} · Ref ${saved.ref||hint||'—'}`,true,resultRoot);const actions=element('div','inline-actions');const open=element('button','small','Abrir lead');open.type='button';open.addEventListener('click',()=>openDetail('ficha',saved.journeyId));actions.append(open);if(!saved.duplicate){const undo=element('button','quiet small','Desfazer');undo.type='button';MCSAction.bind(undo,()=>({scope:root,commit:()=>request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'undo',readId:read.id})}),successText:`${filename||'Print'} — Desfeito. O arquivo permanece guardado.`,errorText:'Não consegui desfazer — tente de novo',onSuccess:()=>root.querySelector('strong')?.remove()}));actions.append(undo);}root.append(actions);await refreshCounters();return saved;}
  async function handleAutoPrintRead(result,context,filename,resultRoot){if(result.manual){const root=autoPrintResult(filename||result.read?.original_filename,'Não consegui ler agora — tente mais tarde ou use outra imagem.',false,resultRoot);const retry=element('button','quiet small','Tentar de novo');retry.type='button';MCSAction.bind(retry,()=>({scope:root,commit:()=>request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'retry',readId:result.read.id})}),onSuccess:(next)=>handleAutoPrintRead(next,context,filename,resultRoot),errorText:'Não consegui ler agora — tente de novo'}));root.append(retry);return false;}return saveAutoPrint(result.read,context,filename,resultRoot);}
  async function uploadAutoPrint(file,context={},resultRoot){const head=new Uint8Array(await file.slice(0,64).arrayBuffer());const signed=await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'sign',filename:file.name,mimeType:file.type,byteSize:file.size,magicBase64:btoa(String.fromCharCode(...head)),journeyId:context.journeyId||null,contactId:context.contactId||null})});const uploadUrl=new URL(signed.uploadUrl);uploadUrl.searchParams.set('token',signed.token);const uploaded=await fetch(uploadUrl.toString(),{method:'PUT',headers:{'content-type':file.type,'x-upsert':'false'},body:file});if(!uploaded.ok)throw Error('UPLOAD_FAILED');return handleAutoPrintRead(await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'read',readId:signed.readId})}),context,file.name,resultRoot);}
  async function sendAutoPrint(){const files=[...$('auto-print-file').files];if(!files.length)return;const status=$('auto-print-status'),result=$('auto-print-result');let failures=0;status.classList.remove('error');result.replaceChildren();result.classList.remove('hidden');$('auto-print-send').disabled=true;for(let index=0;index<files.length;index++){const file=files[index];status.textContent=`${index+1} de ${files.length}…`;try{if(await uploadAutoPrint(file,autoPrintContext||{})===false)failures++;}catch(error){failures++;autoPrintResult(file.name,error.code==='SMS_PRINT_INVALID_IMAGE'?'Use uma imagem válida, até 10 MB.':'Não consegui enviar agora. O arquivo não foi apagado.',false);}}$('auto-print-file').value='';$('auto-print-file-info').replaceChildren();$('auto-print-file-info').classList.add('hidden');$('auto-print-remove').classList.add('hidden');$('auto-print-send').disabled=true;autoPrintContext=null;status.textContent=`${files.length} de ${files.length} prontos${failures?` · ${failures} com erro`:''}`;}

  function updateMeta(meta) {
    if (!meta) return;
    $('data-updated').textContent = formatDate(meta.dataUpdatedAt);
    const whatsappAt=meta.lastWhatsAppMessageAt||meta.lastWhatsAppImportAt;
    $('last-whatsapp-import').textContent = whatsappAt ? formatDate(whatsappAt) : 'nenhuma';
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
    return {NO_RESPONSE:'🔴 Sem resposta',MCS_PENDING:'🟠 Parada com você',CUSTOMER_PENDING:'🟡 Parada com o cliente',IN_PROGRESS:'🟢 Em andamento',CLOSED:'⚪ Concluída / sem interesse'}[value]||'Situação pendente';
  }
  function pendingTone(value) { return {NO_RESPONSE:'red',MCS_PENDING:'yellow',CUSTOMER_PENDING:'yellow',IN_PROGRESS:'green',CLOSED:''}[value]||''; }
  function pendingHeatLabel(value) { return {HOT:'🔥 Quente',WARM:'🌤 Morno',COLD:'❄️ Frio'}[value]||'❄️ Frio'; }
  function renderPendingGeneral(data, rootId='pending-general-card') {
    const root=$(rootId),run=data.run||{},active=run.status==='ACTIVE',paused=run.status==='PAUSED',limited=run.status==='LIMIT';
    root.replaceChildren();
    root.append(element('h2','', 'Leitura geral de todas as conversas'));
    if(!data.historyReady) {
      root.append(element('p','muted',`Aguardando o histórico terminar de chegar (última parte há ${pendingAgo(data.lastHistoryAt)}).`));
      const button=element('button','quiet small','Fazer leitura geral');button.type='button';button.disabled=true;root.append(button);return;
    }
    const total=Number(run.total_conversations||0),completed=Number(run.completed_conversations||0),spent=Number(run.spent_usd||0),budget=Number(run.budget_usd||20);
    if(run.status==='IDLE'||!run.status){
      root.append(element('p','muted','Lê todas as conversas, das mais recentes às mais antigas, inclusive conversas longas em partes.'));
      const start=element('button','small','Fazer leitura geral');start.type='button';MCSAction.bind(start,()=>({scope:root,commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'start_general'})}),onSuccess:()=>continuePendingGeneral(),errorText:'IA indisponível — tente de novo'}));root.append(start);return;
    }
    const status=limited?'limite atingido':paused?'pausada':run.status==='COMPLETED'?'concluída':'em andamento';
    root.append(element('p','',`Leitura geral ${status}`));
    if (paused && run.last_error) root.append(element('p','error',run.last_error==='IA_UNAVAILABLE'?'IA indisponível. O painel continua disponível para uso manual.':'A leitura foi pausada; tente continuar novamente.'));
    const bar=element('div','pending-bar'),fill=element('i');fill.style.width=`${total?Math.min(100,completed/total*100):100}%`;bar.append(fill);root.append(bar);
    root.append(element('p','muted',`${completed} de ${total} conversas lidas · gasto US$ ${spent.toFixed(2)} de US$ ${budget.toFixed(2)} · conversas longas são lidas em partes, até o fim`));
    const actions=element('div','inline-actions');
    if(active){const pause=element('button','quiet small','Pausar');pause.type='button';MCSAction.bind(pause,()=>({scope:root,optimistic:()=>{pause.textContent='Pausando…';},commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'pause_general'})}),rollback:()=>{pause.textContent='Pausar';},onSuccess:()=>currentView==='clients'?loadClients():loadPending(),errorText:'Não consegui salvar — tente de novo'}));actions.append(pause);}
    if(paused){const resume=element('button','small','Continuar');resume.type='button';MCSAction.bind(resume,()=>({scope:root,optimistic:()=>{resume.textContent='Continuando…';},commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'resume_general'})}),rollback:()=>{resume.textContent='Continuar';},onSuccess:()=>continuePendingGeneral(),errorText:'Não consegui salvar — tente de novo'}));actions.append(resume);}
    if(limited){
      root.append(element('p','warning',`${completed} de ${total} lidas — faltam ${Math.max(0,total-completed)}.`));
      const more=element('button','small','Liberar mais US$ 10');more.type='button';
      more.addEventListener('click',()=>{
        more.disabled=true;
        const question=element('span','muted','Liberar mais US$ 10 para concluir a leitura geral?');
        const cancel=element('button','quiet small','Cancelar');cancel.type='button';
        const approve=element('button','small','Confirmar liberação');approve.type='button';
        const confirmation=element('div','inline-actions');confirmation.append(question,cancel,approve);
        cancel.addEventListener('click',()=>{confirmation.remove();more.disabled=false;});
        MCSAction.bind(approve,()=>({scope:confirmation,optimistic:()=>{cancel.disabled=true;},commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'increase_budget',confirm:true})}),rollback:()=>{cancel.disabled=false;},onSuccess:()=>{confirmation.remove();continuePendingGeneral();},errorText:'Não consegui salvar — tente de novo'}));
        root.append(confirmation);
      });actions.append(more);
    }
    root.append(actions);
  }
  function renderPending(data) {
    clearTimeout(pendingContinueTimer);renderPendingGeneral(data);setCount('pending',Object.values(data.counts||{}).reduce((total,value)=>total+Number(value||0),0));
    const stats=$('pending-stats');stats.replaceChildren();[['NO_RESPONSE','🔴 Sem resposta'],['MCS_PENDING','🟠 Parada com você'],['CUSTOMER_PENDING','🟡 Parada com o cliente'],['IN_PROGRESS','🟢 Em andamento'],['CLOSED','⚪ Concluída / sem interesse']].forEach(([key,label])=>{const stat=element('div','pending-stat');stat.append(element('strong','',String(data.counts?.[key]||0)),element('span','muted',label));stats.append(stat);});
    const root=$('pending-list');root.replaceChildren();if(!(data.items||[]).length)empty(root,'Nenhuma conversa neste filtro.');
    (data.items||[]).forEach((item)=>{
      const card=element('article','item-card pending-card'),head=element('div','item-head'),identity=element('div','identity'),text=element('div'),phoneItem={phones:item.phone?[{phone_e164:item.phone,is_primary:true}]:[],ref:item.ref};text.append(element('strong','identity-name',item.name||`Pedido ${item.ref||'—'}`),phoneNode(phoneItem),element('span','muted one-line',`Ref ${item.ref||'—'} · ${item.vehicleText||'Veículo não informado'}`));const direct=directLeadBadge(item);if(direct)text.append(direct);identity.append(element('span','avatar',initials(item.name)),text);head.append(identity);const badges=element('div','badges');badges.append(makeBadge(`${pendingSituationLabel(item.situation)} · ${item.daysStalled} dias`,pendingTone(item.situation)),makeBadge(pendingHeatLabel(item.heat),item.heat==='HOT'?'red':item.heat==='WARM'?'yellow':''));if(item.searchStageLabel)badges.append(makeBadge(item.searchStageLabel,item.searchStage==='SENT'?'green':item.searchStage==='SAVED'?'blue':'yellow'));head.append(badges);card.append(head);const contact=contactMeta(item);if(contact)card.append(contact);
      const prefix=item.latestDirection==='MCS'?'Você: ':'';card.append(element('p','message-preview',prefix+item.latestMessage));if(item.translation)card.append(element('p','muted','Tradução: “'+item.translation+'”'));if(item.summary||item.nextStep){const ai=element('div','pending-ai');ai.append(element('strong','', 'IA: '),document.createTextNode(item.summary||'Sem resumo ainda'));if(item.nextStep)ai.append(element('strong','', ' Próximo passo: '),document.createTextNode(item.nextStep));card.append(ai);}
      const actions=element('div','inline-actions');const open=element('button','small','Abrir lead/conversa');open.type='button';open.addEventListener('click',()=>openDetail('ficha',item.journeyId));const copy=element('button','quiet small','Copiar número');copy.type='button';copy.disabled=!item.phone;MCSAction.bind(copy,()=>({scope:card,commit:()=>navigator.clipboard.writeText(item.phone),successText:'Copiado',errorText:'Não consegui copiar — tente de novo'}));const resolved=element('button','quiet small','Já resolvi');resolved.type='button';MCSAction.bind(resolved,()=>({scope:card,successScope:document.body,feedbackKey:`pending:${item.journeyId}:${item.chatId}`,optimistic:()=>{card.classList.add('action-optimistic-hidden');const count=countValue('pending');setCount('pending',Math.max(0,count-1));return count;},commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'resolve',journeyId:item.journeyId,chatId:item.chatId})}),rollback:(count)=>{card.classList.remove('action-optimistic-hidden');setCount('pending',count);},successText:'Marcado como resolvido.',undo:{commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'unresolve',journeyId:item.journeyId,chatId:item.chatId})}),successText:'Voltou para pendente.',refresh:()=>loadPending()},errorText:'Não consegui salvar — tente de novo'}));const lead=element('button','quiet small',item.isLead?'Não é lead':'Restaurar lead');lead.type='button';MCSAction.bind(lead,()=>{const before=item.isLead;return{scope:card,optimistic:()=>{item.isLead=!before;lead.textContent=item.isLead?'Não é lead':'Restaurar lead';return before;},commit:()=>request('/api/panel/lead?id='+encodeURIComponent(item.journeyId),{method:'POST',body:JSON.stringify({action:'contact_lead',journeyId:item.journeyId,isLead:!before})}),rollback:(value)=>{item.isLead=value;lead.textContent=value?'Não é lead':'Restaurar lead';},refresh:()=>loadPending(),errorText:'Não consegui salvar — tente de novo'};});actions.append(open,copy,resolved,lead);card.append(actions);makeCardClickable(card,()=>openDetail('ficha',item.journeyId));root.append(card);
    });
    if(['pending','clients'].includes(currentView)&&data.run?.status==='ACTIVE')pendingContinueTimer=setTimeout(()=>continuePendingGeneral().catch(()=>{}),500);
  }
  async function loadPending() { const data=await request(pendingQuery());renderPending(data);return data; }
  async function continuePendingGeneral() { if(!['pending','clients'].includes(currentView))return;await request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'continue_general'})});return currentView==='clients'?loadClients():loadPending(); }
  async function downloadPendingCsv() {
    const response=await fetch(pendingQuery()+'&download=csv',{headers:accessToken?{Authorization:'Bearer '+accessToken}:{}});if(!response.ok)throw Error('DOWNLOAD_FAILED');const blob=await response.blob(),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='pendencias-mcs.csv';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  function hasRef(item){return Boolean(item?.ref||item?.referenceCode||item?.reference_code||(item?.refs||[]).some((entry)=>entry?.ref_code||entry));}
  function checklistCompleted(item){return Number(item?.checklistSummary?.completed||item?.completedChecklist||0);}
  function waitClockNode(item){
    const latest=item?.latestMessage;
    if(!latest||latest.is_automatic||latest.direction!=='CUSTOMER')return null;
    const stamp=Date.parse(latest.occurred_at_utc||latest.occurred_at_local||latest.created_at||item.latestAt||0);if(!stamp)return null;
    const elapsed=Math.max(0,Date.now()-stamp),tone=elapsed>14400000?'wait-red':elapsed>3600000?'wait-orange':'wait-gray';
    return element('p',`wait-clock ${tone}`,`esperando há ${pendingAgo(new Date(stamp).toISOString())}`);
  }
  function readReceiptNode(item){
    const latest=item?.latestMcsMessage||null,readAt=latest?.whatsapp_read_at||item?.lastMcsReadAt;if(!readAt)return null;
    const wrap=element('div','message-receipt');wrap.append(element('span','muted',`✓✓ leu às ${new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',hour12:true}).format(new Date(readAt))}`));
    const customerAt=Date.parse(item?.lastCustomerAt||0)||0,mcsAt=Date.parse(latest?.occurred_at_utc||latest?.created_at||item?.lastMcsAt||0)||0;
    if(Date.now()-Date.parse(readAt)>7200000&&customerAt<=mcsAt)wrap.append(makeBadge('leu e não respondeu','red'));
    return wrap;
  }
  function nextQuickDate(kind){const date=new Date();date.setHours(17,0,0,0);if(kind==='tomorrow')date.setDate(date.getDate()+1);if(kind==='friday'){const add=(5-date.getDay()+7)%7||7;date.setDate(date.getDate()+add);}return date;}
  function nextActionNode(item,reload){
    if(item.enabled===false||item.status==='ENCERRADO')return null;
    const journeyId=item.journeyId||item.id;if(!journeyId)return null;
    const block=element('section','next-action'+(item.next_action_at&&Date.parse(item.next_action_at)<Date.now()?' overdue':''));
    block.append(element('strong','',`Próximo passo: ${item.next_action_text||'não definido'}${item.next_action_at?' · '+formatDate(item.next_action_at):''}`));
    const define=element('button','quiet small','Definir');define.type='button';block.append(define);
    define.addEventListener('click',(event)=>{event.preventDefault();event.stopPropagation();if(block.querySelector('.next-action-editor'))return;
      const editor=element('div','next-action-editor'),text=element('input');text.type='text';text.maxLength=500;text.placeholder='Texto curto';text.value=item.next_action_text||'';
      const quick=element('select');[['today','Hoje'],['tomorrow','Amanhã'],['friday','Sexta'],['custom','Data']].forEach(([value,label])=>quick.append(new Option(label,value)));
      const date=element('input');date.type='datetime-local';date.value=localInput(nextQuickDate('today'));date.classList.add('hidden');quick.addEventListener('change',()=>{date.classList.toggle('hidden',quick.value!=='custom');if(quick.value!=='custom')date.value=localInput(nextQuickDate(quick.value));});
      const save=element('button','small','Salvar');save.type='button';MCSAction.bind(save,()=>({scope:block,optimistic:()=>{save.textContent='Salvando…';},commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'next_action',operation:'CREATE',journeyId,text:text.value,at:new Date(date.value).toISOString()})}),rollback:()=>{save.textContent='Salvar';},refresh:reload,errorText:'Não consegui salvar — tente de novo'}));
      editor.append(text,quick,date,save);block.append(editor);
    });
    return block;
  }
  function copyPhoneButton(item,card){const phone=primaryPhone(item)?.phone_e164||primaryPhone(item)?.phone_raw||item.phone;if(!phone)return null;const copy=element('button','quiet small','Copiar número');copy.type='button';MCSAction.bind(copy,()=>({scope:card,commit:()=>navigator.clipboard.writeText(phone),successText:'Copiado',errorText:'Não consegui copiar — tente de novo'}));return copy;}

  function renderClients(data){
    clientsData=data;const pendingByJourney=new Map((data.pending.items||[]).map((item)=>[item.journeyId,item]));
    let items=(data.items||[]).map((item)=>({...item,...(pendingByJourney.get(item.id)||{}),id:item.id,journeyId:item.id,latestMessage:item.latestMessage||null}));
    const situation=$('clients-situation').value,checklist=$('clients-checklist').value,ref=$('clients-ref').value,heat=$('clients-heat').value;
    items=items.filter((item)=>(situation==='all'||item.situation===situation)&&(checklist==='all'||(checklist==='complete'?checklistCompleted(item)===6:checklistCompleted(item)<6))&&(ref==='all'||(ref==='with'?hasRef(item):!hasRef(item)))&&(heat==='all'||String(item.heat||'').toUpperCase()===heat));
    items=clientSort(items,$('clients-sort').value);if($('clients-sort').value==='hot')items.sort((a,b)=>({HOT:0,WARM:1,COLD:2}[a.heat]??3)-({HOT:0,WARM:1,COLD:2}[b.heat]??3));
    renderPendingGeneral(data.pending,'clients-general-card');const stats=$('clients-stats');stats.replaceChildren();[['NO_RESPONSE','Sem resposta'],['MCS_PENDING','Parado com você'],['CUSTOMER_PENDING','Parado com o cliente'],['IN_PROGRESS','Em andamento'],['CLOSED','Concluída']].forEach(([key,label])=>{const stat=element('div','pending-stat');stat.append(element('strong','',String(data.pending.counts?.[key]||0)),element('span','muted',label));stats.append(stat);});
    const root=$('clients-list');root.replaceChildren();setCount('clients',(data.items||[]).length);if(!items.length)return empty(root,'Nenhum cliente neste filtro.');
    items.forEach((item)=>{const card=element('article',`item-card client-card heat-${String(item.heat||'COLD').toLowerCase()}`),head=element('div','item-head');head.append(identityHeader(item,{preview:item.latestMessage?.body_text||item.latestMessageText||''}));const badges=element('div','badges');badges.append(makeBadge(pendingSituationLabel(item.situation),pendingTone(item.situation)),makeBadge(`Checklist ${checklistCompleted(item)}/6`,checklistCompleted(item)===6?'green':'blue'));const heat=heatBadge(item);if(heat)badges.append(heat);if(item.searchStageLabel)badges.append(makeBadge(item.searchStageLabel,item.searchStage==='SENT'?'green':item.searchStage==='SAVED'?'blue':'yellow'));if(item.disposition)badges.append(makeBadge(item.disposition==='TREATED'?'Tratado':`Descartado${item.discardReason?' · '+discardLabel(item.discardReason):''}`,item.disposition==='DISCARDED'?'red':'blue'));head.append(badges);card.append(head);if(item.aiSummary||item.summary)card.append(element('p','pending-ai',`IA: ${item.aiSummary||item.summary}`));const waiting=waitClockNode(item),receipt=readReceiptNode(item),next=nextActionNode(item,()=>loadClients());if(waiting)card.append(waiting);if(receipt)card.append(receipt);if(next)card.append(next);if(!hasRef(item)){const copy=copyPhoneButton(item,card);if(copy)card.append(copy);}const actions=element('div','inline-actions'),open=element('button','small','Abrir lead');open.type='button';open.addEventListener('click',()=>openDetail('ficha',item.id));actions.append(open,journeySwitch(item,()=>loadClients()));if(item.chatId){const resolved=Boolean(item.resolved),done=element('button','quiet small',resolved?'Restaurar pendência':'Já resolvi');done.type='button';MCSAction.bind(done,()=>({scope:card,optimistic:()=>{done.textContent=resolved?'Restaurando…':'Salvando…';},commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:resolved?'unresolve':'resolve',journeyId:item.id,chatId:item.chatId})}),rollback:()=>{done.textContent=resolved?'Restaurar pendência':'Já resolvi';},refresh:()=>loadClients(),errorText:'Não consegui salvar — tente de novo'}));actions.append(done);}const lead=element('button','quiet small',item.isLead===false?'Restaurar lead':'Não é lead');lead.type='button';MCSAction.bind(lead,()=>{const before=item.isLead!==false;return{scope:card,optimistic:()=>{item.isLead=!before;lead.textContent=item.isLead?'Não é lead':'Restaurar lead';return before;},commit:()=>request('/api/panel/lead?id='+encodeURIComponent(item.id),{method:'POST',body:JSON.stringify({action:'contact_lead',journeyId:item.id,isLead:!before})}),rollback:(value)=>{item.isLead=value;lead.textContent=value?'Não é lead':'Restaurar lead';},refresh:()=>loadClients(),errorText:'Não consegui salvar — tente de novo'};});actions.append(lead);card.append(actions,dispositionControls(item));makeCardClickable(card,()=>openDetail('ficha',item.id));root.append(card);});
  }
  async function loadClients(){const [records,pending]=await Promise.all([request('/api/panel/records?sort='+encodeURIComponent($('clients-sort').value)),request('/api/panel/pendencias?situation=all&sort=hot&withRef=false&includeResolved=true')]);updateMeta(records.meta);renderClients({items:records.items||[],pending});}

  function downloadClientsCsv(){
    const pendingByJourney=new Map((clientsData.pending?.items||[]).map((item)=>[item.journeyId,item]));
    let items=(clientsData.items||[]).map((item)=>({...item,...(pendingByJourney.get(item.id)||{}),id:item.id,journeyId:item.id}));
    const situation=$('clients-situation').value,checklist=$('clients-checklist').value,ref=$('clients-ref').value,heat=$('clients-heat').value;
    items=items.filter((item)=>(situation==='all'||item.situation===situation)&&(checklist==='all'||(checklist==='complete'?checklistCompleted(item)===6:checklistCompleted(item)<6))&&(ref==='all'||(ref==='with'?hasRef(item):!hasRef(item)))&&(heat==='all'||String(item.heat||'').toUpperCase()===heat));
    const csvCell=(value)=>{const text=String(value??'');return /[",\r\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;};
    const rows=[['nome','telefone','Ref','situação','checklist','calor','etapa da busca','resumo da IA'],...items.map((item)=>[item.name||item.contact?.display_name||'',primaryPhone(item)?.phone_e164||primaryPhone(item)?.phone_raw||'',item.ref||item.referenceCode||item.reference_code||'',pendingSituationLabel(item.situation),`${checklistCompleted(item)}/6`,pendingHeatLabel(item.heat),item.searchStageLabel||'',item.aiSummary||item.summary||''])];
    const blob=new Blob(['\uFEFF'+rows.map((row)=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='clientes-mcs.csv';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
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
  function phoneDisplay(value){const raw=String(value||'');const digits=raw.replace(/\D/g,'');return digits.length===11&&digits[0]==='1'?`(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`:raw||'falta o número';}
  function referencePhone(item){const ref=item.referenceCode||item.reference_code||item.ref||'—';const phone=primaryPhone(item);return `Ref ${ref} · 📞 ${phone?phoneDisplay(phone.phone_e164||phone.phone_raw):'falta o número'}`;}
  function phoneNode(item){const phone=primaryPhone(item);if(!phone){if(item?.whatsappWithoutPhone){const username=String(item.whatsappUsername||'').replace(/^@/,'');const name=String(item.name||item.contactName||item.contact?.display_name||'').trim().replace(/^@/,'');const showUsername=username&&name.toLocaleLowerCase('pt-BR')!==username.toLocaleLowerCase('pt-BR');const withUsername=`💬 ${username?'@'+username+' · ':''}WhatsApp sem número`;return element('span','identity-ref-phone whatsapp-user-id',showUsername?withUsername:'💬 WhatsApp sem número');}return element('span','identity-ref-phone phone-missing','📞 falta o número');}const raw=phone.phone_e164||phone.phone_raw;const link=element('a','identity-ref-phone phone-link','📞 '+phoneDisplay(raw));link.href='tel:'+String(raw).replace(/[^+\d]/g,'');link.addEventListener('click',(event)=>event.stopPropagation());return link;}
  function contactChannelLabel(channel){return {WHATSAPP:'💬 WhatsApp',WHATSAPP_HISTORY:'💬 WhatsApp · histórico',WHATSAPP_CLICK:'💬 Clicou em WhatsApp',SMS_CLICK:'✉️ Clicou em mensagem de texto',CONTACT_CLICK_UNKNOWN:'💬 Clicou para falar (canal não registrado)',IMPORTED:'📎 Conversa importada/colada'}[channel]||'';}
  function floridaArrival(value){if(!value)return '';const date=new Date(value),now=new Date();const fmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',hour12:true});const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(date);const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(now);const yesterday=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(Date.now()-86400000));const prefix=day===today?'hoje':day===yesterday?'ontem':new Intl.DateTimeFormat('pt-BR',{timeZone:'America/New_York',day:'2-digit',month:'2-digit'}).format(date);return `chegou ${prefix} ${fmt.format(date)} (Flórida)`;}
  function heatBadge(item){const labels={HOT:'🔥 Quente',WARM:'🌤 Morno',COLD:'❄️ Frio'},tone={HOT:'red',WARM:'yellow',COLD:'blue'};const heat=String(item.heat||'').toUpperCase();if(!heat)return null;const badge=makeBadge(labels[heat]||labels.COLD,tone[heat]||'blue');badge.classList.add('heat-badge');return badge;}
  function contactMeta(item){const wrap=element('div','badges contact-meta');const channel=contactChannelLabel(item.contactChannel),arrival=floridaArrival(item.contactAt||item.lastCustomerAt);if(channel)wrap.append(makeBadge(channel,['WHATSAPP','WHATSAPP_HISTORY','WHATSAPP_CLICK'].includes(item.contactChannel)?'green':item.contactChannel==='SMS_CLICK'?'yellow':'blue'));if(arrival)wrap.append(makeBadge(arrival));const heat=heatBadge(item);if(heat){const details=element('details','temperature-details'),summary=element('summary','');summary.append(heat);details.append(summary,element('p','temperature-explanation',item.heatSource==='AI'?`Temperatura da IA: ${item.aiSummary||'Sem resumo.'}${item.aiNextStep?' Próximo passo: '+item.aiNextStep:''}`:'Temperatura calculada: telefone, checklist, prazo, orçamento x Manheim, conversa recente e horário.'));wrap.append(details);}return wrap.childNodes.length?wrap:null;}
  function directLeadLabel(item){return item?.directLeadSource==='WHATSAPP_DIRECT'?'📱 veio direto pelo WhatsApp (sem calculadora)':item?.directLeadSource==='SMS_DIRECT'?'✉️ veio direto por SMS (sem calculadora)':'';}
  function directLeadBadge(item){const label=directLeadLabel(item);return label?makeBadge(label,'blue'):null;}
  function clientSort(items,mode){const missing=(v)=>v===null||v===undefined||v==='';const value=(x)=>Number(x.confirmed_total_ceiling_cents||x.budgetCents||x.budget_cents)||null;const stamp=(x)=>Date.parse(x.last_seen_at||x.updated_at||x.occurredAt||x.created_at||0)||0;const field=(x,kind)=>kind==='location'?(x.state||x.estado||x.contact?.location_text):kind==='vehicle'?(x.make||x.vehicleText||x.vehicle_text):value(x);return items.slice().sort((a,b)=>{if(mode==='recent'||mode==='oldest')return(stamp(b)-stamp(a))*(mode==='recent'?1:-1);const av=field(a,mode),bv=field(b,mode);if(missing(av))return missing(bv)?0:1;if(missing(bv))return -1;if(mode==='value_desc'||mode==='value_asc')return(av-bv)*(mode==='value_desc'?-1:1);return String(av).localeCompare(String(bv),'pt-BR');});}

  function identityHeader(item, options = {}) {
    const ref = item.referenceCode || item.reference_code || item.ref || null;
    const name = item.name || item.contact && item.contact.display_name || item.contactName || (ref ? `Pedido ${ref}` : 'Pedido');
    const wrap = element('div', 'identity');
    wrap.append(element('span', 'avatar', initials(name)));
    const text = element('div');
    const identityPhone=phoneNode(item);if(!ref)identityPhone.classList.add('no-ref-phone');text.append(element('strong', 'identity-name', name), identityPhone);
    const details = [`Ref ${ref||'—'}`, item.vehicleText || item.vehicle_text || 'Veículo não informado', item.budgetCents||item.budget_cents ? formatMoney(item.budgetCents||item.budget_cents) : null].filter(Boolean).join(' · ');
    text.append(element('span', 'muted one-line', details));
    const direct=directLeadBadge(item);if(direct)text.append(direct);
    const contact=contactMeta(item);if(contact)text.append(contact);
    if (options.preview) text.append(element('span', 'one-line message-preview', options.preview));
    wrap.append(text);
    return wrap;
  }

  function smsPrintMissing(item) {
    if(item.contactChannel!=='SMS_CLICK'||item.smsPrintConfirmed||item.disposition)return null;
    const block=element('section','sms-print-missing'); block.append(element('strong','', 'Falta o print do SMS'),element('p','', 'Tire um print da mensagem no seu celular, com o número e a Ref, e anexe aqui.'));
    const attach=element('label','small','📷 Anexar print do SMS'),input=element('input');input.type='file';input.accept='image/*';input.multiple=true;input.hidden=true;attach.append(input);const absent=element('button','quiet small','Não chegou SMS'); absent.type='button';
    const resultRoot=element('div','card-action-result');
    input.addEventListener('change',()=>{const files=[...input.files];if(!files.length)return;const context={journeyId:item.journeyId||item.id||null,contactId:item.contact_id||item.contact?.id||null,ref:item.ref||item.referenceCode||item.reference_code||null};MCSAction.run({button:attach,scope:block,optimistic:()=>attach.classList.add('disabled'),commit:async()=>{let last;for(const file of files)last=await uploadAutoPrint(file,context,resultRoot);return last;},rollback:()=>attach.classList.remove('disabled'),onSuccess:()=>{attach.classList.remove('disabled');input.value='';},errorText:'Não consegui salvar — tente de novo'});});
    absent.addEventListener('click',(event)=>{event.preventDefault();event.stopPropagation();setDisposition({...item,kind:item.kind||'JOURNEY',id:item.id||item.journeyId},'DISCARDED',absent);});
    const actions=element('div','inline-actions'); actions.append(attach,absent); block.append(actions,resultRoot);
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
    const toggle = element('button', enabled ? 'switch-on small' : 'switch-off small', enabled ? 'Ligado' : canReactivate ? 'Desligado — religar' : 'Desligado');
    toggle.type = 'button';
    toggle.disabled = !canReactivate;
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(enabled));
    MCSAction.bind(toggle,()=>({scope:wrap,optimistic:()=>{toggle.textContent=enabled?'Desligando…':'Religando…';toggle.setAttribute('aria-checked',String(!enabled));},
      commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'toggle_journey',journeyId:item.id,enabled:!enabled,reason:null})}),
      rollback:()=>{toggle.textContent=enabled?'Ligado':canReactivate?'Desligado — religar':'Desligado';toggle.setAttribute('aria-checked',String(enabled));},refresh:reload,
      errorText:'Não consegui salvar — tente de novo'}));
    wrap.append(toggle);
    if (enabled) {
      const reasons = element('details', 'switch-reasons');
      reasons.append(element('summary', '', 'Desligar com motivo'));
      const choices = element('div', 'inline-actions');
      [['MCS_PURCHASE', 'Comprou com a MCS'], ['OTHER_PURCHASE', 'Comprou em outro lugar'], ['GAVE_UP', 'Desistiu'], ['NO_RESPONSE', 'Sem resposta']].forEach(([reason, label]) => {
        const button = element('button', 'quiet small', label);
        button.type = 'button';
        MCSAction.bind(button,()=>({scope:wrap,optimistic:()=>{button.textContent='Salvando…';},commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'toggle_journey',journeyId:item.id,enabled:false,reason})}),rollback:()=>{button.textContent=label;},refresh:reload,errorText:'Não consegui salvar — tente de novo'}));
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
    const roots = { today: 'today-list', entry: 'entry-queue', clients: 'clients-list', pending: 'pending-list', orders: 'orders-list', qualification: 'qualification-list', searches: 'searches-list', manheim: 'manheim-results', records: 'records-list' };
    if (roots[view] && $(roots[view])) empty($(roots[view]), 'Não foi possível carregar esta aba.');
  }

  async function loadSearches() {
    const data=await request('/api/panel/searches');
    const summary=$('searches-summary'),root=$('searches-list');summary.replaceChildren();root.replaceChildren();
    const makeButton=(label,handler,className='small')=>{const control=element('button',className,label);control.type='button';control.addEventListener('click',handler);return control;};
    [['MISSING','🔍 Falta buscar'],['SAVED','💾 Busca salva'],['SENT','📤 Opções enviadas']].forEach(([key,label])=>{const stat=element('div','pending-stat');stat.append(element('strong','',String(data.counts?.[key]||0)),element('span','muted',label));summary.append(stat);});
    (data.items||[]).forEach((item)=>{
      const card=element('article','item-card search-card');const head=element('div','item-head');head.append(element('strong','identity-name',item.name),phoneNode({phones:item.phone?[{phone_e164:item.phone,is_primary:true}]:[]}),element('span','muted',`Ref ${item.ref||'—'}`));const direct=directLeadBadge(item);if(direct)head.append(direct);head.append(element('span','search-stage '+item.stage,`${item.stageLabel}${item.days ? ` há ${item.days} dia${item.days===1?'':'s'}` : ''}`));card.append(head);
      card.append(element('strong','',item.exactSearch));
      if(item.alsoServes?.length){const names=item.alsoServes.slice(0,2).map((peer)=>`${peer.name} (Ref ${peer.ref||'—'})`).join(' e ');card.append(element('p','muted',`Também serve para: ${names}${item.alsoServes.length>2?` e mais ${item.alsoServes.length-2}`:''} — mesma busca no Manheim`));}
      if(item.stage==='SAVED')card.append(element('p','muted',`${item.matchCount} carro${item.matchCount===1?'':'s'} no último CSV do Manheim batem com esta busca`));
      const actions=element('div','inline-actions');
      const stageAction=(control,kind)=>MCSAction.bind(control,()=>{const previous=item.stage,next=kind==='SAVED'?'SAVED':'SENT';return{scope:card,optimistic:()=>{item.stage=next;card.querySelector('.search-stage').textContent=next==='SAVED'?'💾 Busca salva':'📤 Opções enviadas';return previous;},commit:()=>request('/api/panel/searches',{method:'POST',body:JSON.stringify({action:'mark',journeyId:item.journeyId,kind})}),rollback:(value)=>{item.stage=value;card.querySelector('.search-stage').textContent=item.stageLabel;},refresh:()=>loadSearches(),errorText:'Não consegui salvar — tente de novo'};});
      if(item.stage==='MISSING'){const saved=makeButton('💾 Salvei a busca no Manheim',null);stageAction(saved,'SAVED');actions.append(saved);}
      if(item.stage!=='SENT'){const sent=makeButton('📤 Enviei opções ao cliente',null,'quiet small');stageAction(sent,'SENT');actions.append(sent);}
      if(item.stage==='SAVED'&&item.matchCount)actions.append(makeButton(`Ver os ${item.matchCount} carros`,()=>switchPanel('searches'),'quiet small'));
      if(item.stage!=='MISSING'){const kind=item.stage==='SENT'?'SENT':'SAVED',undo=makeButton('Desfazer',null,'quiet small');if(item.stageSource==='MARK')MCSAction.bind(undo,()=>({scope:card,optimistic:()=>{undo.textContent='Desfazendo…';},commit:()=>request('/api/panel/searches',{method:'POST',body:JSON.stringify({action:'undo',journeyId:item.journeyId,kind})}),rollback:()=>{undo.textContent='Desfazer';},refresh:()=>loadSearches(),errorText:'Não consegui desfazer — tente de novo'}));else undo.addEventListener('click',()=>MCSAction.feedback(card,item.stageSource==='MANHEIM'?'Esta busca foi marcada no MANHEIM. Desfaça em “Quais buscas salvar”.':'As opções foram registradas pela ficha do cliente; desfaça na ficha.','error','search-origin'));actions.append(undo);}
      actions.append(makeButton('Abrir lead',()=>openDetail('ficha',item.journeyId),'quiet small'));card.append(actions);root.append(card);
    });
    if(!(data.items||[]).length)empty(root,'Nenhum cliente ativo com desejo completo e contato registrado.');
    window.__mcsSearchesRender=()=>loadSearches().catch(()=>{});
  }
  function renderSearchesAgain(){ if(window.__mcsSearchesRender)window.__mcsSearchesRender(); }

  async function loadCurrent(view = currentView, requestVersion = viewRequestVersion) {
    const current = () => currentView === view && viewRequestVersion === requestVersion;
    if (view === 'entry') {
      const data = await loadQueue(false);
      if (!current()) return;
      renderQueue(data.chats || [], data.reviews || []);
      return loadWhatsApp().catch(() => { $('whatsapp-signal').textContent = 'Não foi possível verificar o WhatsApp.'; });
    }
    if (view === 'pending') return loadPending();
    if (view === 'clients') return loadClients();
    if (view === 'today') {
      const data = await request('/api/panel/today?sort='+encodeURIComponent($('today-sort').value));
      if (!current()) return;
      updateMeta(data.meta);
      return renderToday(data.items || []);
    }
    if (view === 'orders') {
      return loadOrders(false, view, requestVersion);
    }
    if (view === 'qualification') {
      const data = await request('/api/panel/qualification?sort='+encodeURIComponent($('qualification-sort').value));
      if (!current()) return;
      updateMeta(data.meta);
      return renderQualification(data.items || []);
    }
    if (view === 'searches') {
      const [,data]=await Promise.all([loadSearches(),request('/api/panel/records?view=manheim')]);
      if (!current()) return;
      updateMeta(data.meta);renderManheim(data);return;
    }
    if (view === 'manheim') {
      const data = await request('/api/panel/records?view=manheim');
      if (!current()) return;
      updateMeta(data.meta);
      return renderManheim(data);
    }
    if (view === 'records') {
      const data = await request('/api/panel/records?sort='+encodeURIComponent($('records-sort').value));
      if (!current()) return;
      updateMeta(data.meta);
      return renderRecords(data.items || []);
    }
  }

  async function refreshCounters() {
    const [today, entry, pending, orders, searches, manheim, records] = await Promise.all([
      request('/api/panel/today'),
      request('/api/panel/entry'),
      request('/api/panel/pendencias'),
      request('/api/panel/orders?filter=Todos&period=30&limit=1&offset=0'),
      request('/api/panel/searches'),
      request('/api/panel/records?view=manheim'),
      request('/api/panel/records')
    ]);
    setCount('today',(today.items||[]).length);
    setCount('entry', (entry.chats || []).filter((chat) => chat.resolution_status !== 'RESOLVED' || chat.hasTimeUncertain).length + (entry.reviews || []).length);
    setCount('clients', (records.items || []).length);
    setCount('pending', Object.values(pending.counts || {}).reduce((total, value) => total + Number(value || 0), 0));
    setCount('orders', orders.page && orders.page.total || 0);
    setCount('searches', (searches.items || []).length);
    setCount('manheim', manheim.upload && manheim.upload.lead_count || 0);
    setCount('records', (records.items || []).length);
  }

  async function loadCaptureWarning() {
    const root=$('capture-warning'); if (!root) return;
    try {
      const data=await request('/api/panel/capture'),check=data.check;
      root.replaceChildren();
      if (!check || check.error_code || !check.checked_at) { root.className='capture-warning muted'; root.textContent='Checagem de captura indisponível'; return; }
      const missing=(check.missing_refs||[]).filter(Boolean);
      if (!missing.length) { root.className='capture-warning hidden'; return; }
      root.className='capture-warning error';
      const details=element('details',''); details.append(element('summary','',`${missing.length} contatos não estão aparecendo — ver lista`),element('p','',missing.join(' · '))); root.append(details);
    } catch (_) { root.className='capture-warning muted'; root.textContent='Checagem de captura indisponível'; }
  }

  async function loadOrders(append, view = currentView, requestVersion = viewRequestVersion) {
    if (!append) {
      orderOffset = 0;
      orderItems = [];
    }
    const params = new URLSearchParams({ filter: orderFilter, period: orderPeriod, sort:$('orders-sort').value,limit: '30', offset: String(orderOffset) });
    const data = await request('/api/panel/orders?' + params.toString());
    if (currentView !== view || viewRequestVersion !== requestVersion) return;
    updateMeta(data.meta);
    orderItems = append ? orderItems.concat(data.items || []) : (data.items || []);
    orderLinkTargets = data.linkTargets || orderLinkTargets;
    orderOffset = orderItems.length;
    orderHasMore = Boolean(data.page && data.page.hasMore);
    renderOrders(orderItems, orderLinkTargets, data.page || {});
  }

  async function postAction(payload) {
    const result = await request('/api/panel/actions', { method: 'POST', body: JSON.stringify(payload) });
    await refreshCurrentPreservingState();
    return result;
  }

  async function refreshCurrentPreservingState() {
    const scrollY=window.scrollY,loadedOrders=orderItems.length,view=currentView,version=viewRequestVersion;
    if(view==='orders'){
      await loadOrders(false,view,version);
      while(orderItems.length<loadedOrders&&orderHasMore)await loadOrders(true,view,version);
    }else await loadCurrent(view,version);
    requestAnimationFrame(()=>window.scrollTo(0,scrollY));
  }

  function captureOrigin() {
    const sorts = {};
    ['today','entry','pending','orders','qualification','manheim','records'].forEach((name) => { const select=$(name+'-sort'); if(select) sorts[name]=select.value; });
    return {
      view: currentView,
      scrollY: window.scrollY,
      orderFilter,
      orderPeriod,
      orderLoaded: orderItems.length,
      sorts,
      pendingSituation,
      pendingWithRef: Boolean($('pending-with-ref')?.checked),
      searchQuery: $('global-search-input')?.value || '',
      searchVisible: !$('search-results')?.classList.contains('hidden')
    };
  }

  function syncOrderControls() {
    document.querySelectorAll('[data-order-filter]').forEach((entry) => entry.classList.toggle('active', entry.dataset.orderFilter === orderFilter));
    document.querySelectorAll('[data-order-period]').forEach((entry) => entry.classList.toggle('active', entry.dataset.orderPeriod === orderPeriod));
  }

  async function restoreOrigin(origin = detailOrigin) {
    const target = origin || { view: 'today', scrollY: 0, orderFilter: 'Todos', orderPeriod: '30', orderLoaded: 0 };
    detailOrigin = null;
    currentDetail = null;
    orderFilter = target.orderFilter || orderFilter;
    orderPeriod = target.orderPeriod || orderPeriod;
    pendingSituation = target.pendingSituation || pendingSituation;
    if ($('pending-with-ref')) $('pending-with-ref').checked = Boolean(target.pendingWithRef);
    document.querySelectorAll('[data-pending-situation]').forEach((button) => button.classList.toggle('active', button.dataset.pendingSituation === pendingSituation));
    Object.entries(target.sorts||{}).forEach(([name,value])=>{const select=$(name+'-sort');if(select&&[...select.options].some((option)=>option.value===value))select.value=value;});
    syncOrderControls();
    await switchPanel(target.view || 'today');
    if ((target.view || 'today') === 'orders') {
      while (orderItems.length < Number(target.orderLoaded || 0) && orderHasMore) {
        await loadOrders(true, 'orders', viewRequestVersion);
      }
    }
    if (target.searchVisible && target.searchQuery) {
      $('global-search-input').value=target.searchQuery;
      await globalSearch({preventDefault(){}});
    }
    requestAnimationFrame(() => window.scrollTo(0, Number(target.scrollY || 0)));
  }

  const DISCARD_REASONS=Object.freeze({PRICE:'Preço',DISAPPEARED:'Sumiu',BOUGHT_ELSEWHERE:'Comprou em outro lugar',NO_CREDIT:'Sem crédito',CURIOSITY:'Só curiosidade',OTHER:'Outro'});
  function discardLabel(value){return DISCARD_REASONS[value]||'';}
  function showUndo({itemKind,itemKey,previousStatus,previousReason,label,scope,refresh}) {
    const scopeKey=currentDetail?`detail:${currentDetail.kind}:${currentDetail.key}`:`view:${currentView}`;
    clearTimeout(undoTimers.get(scopeKey));
    document.querySelectorAll(`.undo-toast[data-undo-scope="${scopeKey}"]`).forEach((node)=>node.remove());
    const toast = element('div', 'undo-toast');toast.dataset.undoScope=scopeKey;
    toast.append(element('span', '', label));
    const undo = element('button', 'quiet small', 'Desfazer');
    undo.type = 'button';
    MCSAction.bind(undo,()=>({scope:scope||document.body,feedbackKey:`undo:${scopeKey}`,optimistic:()=>{toast.classList.add('action-optimistic-hidden');return null;},
      commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'set_disposition',itemKind,itemKey,status:previousStatus,previousStatus,previousReason})}),
      rollback:()=>toast.classList.remove('action-optimistic-hidden'),successText:'Ação desfeita.',
      refresh:async()=>{toast.remove();if(refresh)await refresh();await refreshCounters();await loadCaptureWarning();}}));
    toast.append(undo);
    document.body.append(toast);
    undoTimers.set(scopeKey,setTimeout(() => toast.remove(), 10000));
  }

  function dispositionIdentity(item){
    const itemKind = item.kind === 'CALCULATOR_ORDER' || item.kind === 'CALCULATOR' ? 'REF' : 'JOURNEY';
    const itemKey = itemKind === 'REF' ? item.ref : item.id || item.journeyId;
    return {itemKind,itemKey};
  }

  function countValue(view){return Number(document.querySelector(`[data-count="${view}"]`)?.textContent)||0;}
  function applyDispositionVisual(button,item,status){
    const card=button.closest('.item-card,.lead-card,.record-block'),hide=Boolean(status)&&!currentDetail&&['today','clients'].includes(currentView);
    const snapshot={status:item.disposition||null,reason:item.discardReason||null,card,hidden:card?.classList.contains('action-optimistic-hidden'),count:countValue(currentView)};
    item.disposition=status;
    if(hide&&card){card.classList.add('action-optimistic-hidden');setCount(currentView,Math.max(0,snapshot.count-1));}
    else{const controls=button.closest('.disposition-controls');if(controls){controls.dataset.status=status||'';controls.querySelectorAll('.disposition-state').forEach((node)=>node.remove());if(status){const state=makeBadge(status==='TREATED'?'Tratado':'Descartado',status==='DISCARDED'?'red':'blue');state.classList.add('disposition-state');controls.prepend(state);}}}
    return snapshot;
  }

  function rollbackDisposition(item,snapshot){
    item.disposition=snapshot.status;
    item.discardReason=snapshot.reason;
    if(snapshot.card){snapshot.card.classList.toggle('action-optimistic-hidden',Boolean(snapshot.hidden));}
    setCount(currentView,snapshot.count);
  }

  function dispositionRefresh(){
    if(currentDetail)return openDetail(currentDetail.kind,currentDetail.key,{push:false,origin:detailOrigin});
    return refreshCurrentPreservingState();
  }

  function setDisposition(item,status,button,reason=null) {
    const {itemKind,itemKey}=dispositionIdentity(item),previousStatus=item.disposition||null,previousReason=item.discardReason||null,scope=button.closest('.item-card,.lead-card,.record-block')||document.body;
    return MCSAction.run({button,scope,feedbackKey:`disposition:${itemKind}:${itemKey}`,optimistic:()=>applyDispositionVisual(button,item,status),
      commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'set_disposition',itemKind,itemKey,status,reason})}),
      rollback:(snapshot)=>rollbackDisposition(item,snapshot),errorText:'Não consegui salvar — tente de novo',
      onSuccess:()=>{item.discardReason=status==='DISCARDED'?reason:null;showUndo({itemKind,itemKey,previousStatus,previousReason,label:status==='TREATED'?'Marcado como Tratado':status==='DISCARDED'?`Descartado · ${discardLabel(reason)}`:'Voltou para pendente',scope,refresh:dispositionRefresh});},
      refresh:async()=>{await dispositionRefresh();await refreshCounters();}});
  }

  function dispositionControls(item) {
    const actions = element('div', 'inline-actions disposition-controls');actions.dataset.status=item.disposition||'';
    if(item.disposition){
      const state=makeBadge(item.disposition==='TREATED'?'Tratado':`Descartado${item.discardReason?' · '+discardLabel(item.discardReason):''}`,item.disposition==='DISCARDED'?'red':'blue');state.classList.add('disposition-state');actions.append(state);
      const restore=element('button','quiet small','Voltar para pendente');restore.type='button';restore.addEventListener('click',(event)=>{event.preventDefault();event.stopPropagation();setDisposition(item,null,restore);});actions.append(restore);return actions;
    }
    const treated = element('button', 'small', 'Tratado');
    treated.type = 'button';
    treated.addEventListener('click', (event) => {event.preventDefault();event.stopPropagation();setDisposition(item,'TREATED',treated);});
    const discarded = element('button', 'quiet small', 'Descartar');
    discarded.type = 'button';
    discarded.addEventListener('click', (event) => {event.preventDefault();event.stopPropagation();if(actions.querySelector('.discard-reasons'))return;const reasons=element('div','discard-reasons');Object.entries(DISCARD_REASONS).forEach(([value,label])=>{const choice=element('button','quiet small',label);choice.type='button';choice.addEventListener('click',(choiceEvent)=>{choiceEvent.preventDefault();choiceEvent.stopPropagation();setDisposition(item,'DISCARDED',choice,value);});reasons.append(choice);});actions.append(reasons);});
    actions.append(treated, discarded);
    return actions;
  }

  function detailHash(kind, key) {
    return kind === 'order' ? '#pedido/' + encodeURIComponent(key) : '#ficha/' + encodeURIComponent(key);
  }

  function showDetailShell(kind, key) {
    const labels = { today: 'today-panel', entry: 'entry-panel', clients:'clients-panel', pending: 'pending-panel', orders: 'orders-panel', qualification: 'qualification-panel', searches: 'searches-panel', manheim: 'manheim-panel', records: 'records-panel' };
    Object.values(labels).forEach((id) => $(id).classList.add('hidden'));
    $('detail-panel').classList.remove('hidden');
    $('page-title').textContent = kind === 'order' ? 'PEDIDO' : 'FICHA';
    $('record-detail').replaceChildren(element('p', 'muted', 'Carregando…'));
    currentDetail = { kind, key };
  }

  async function openDetail(kind, key, options = {}) {
    const requestVersion=++detailRequestVersion;
    const push = options.push !== false;
    if (push) {
      detailOrigin = options.origin || captureOrigin();
      history.replaceState({ panelOrigin: detailOrigin }, '', location.pathname + location.search + (location.hash || ''));
      history.pushState({ detail: true, kind, key, origin: detailOrigin }, '', detailHash(kind, key));
    } else if (options.origin) {
      detailOrigin = options.origin;
    }
    showDetailShell(kind, key);
    $('page-title').textContent = 'TELA DO LEAD';
    try {
      let leadDetailData=null;
      const detailRequest=async(path,requestOptions)=>{const result=await request(path,requestOptions);if(String(path).startsWith('/api/panel/lead?')&&!String(path).includes('cityZip='))leadDetailData=result;return result;};
      await MCSLead.open({ kind, key, root: $('record-detail'), request:detailRequest,
        onChanged: () => openDetail(kind, key, { push: false, origin: detailOrigin }),
        actionMessage, downloadShortlist, dispositionControls });
      if(requestVersion!==detailRequestVersion)return;
      if(leadDetailData?.record?.whatsappWithoutPhone){const identity=$('record-detail').querySelector('.lead-head-name');if(identity)identity.append(element('p','muted whatsapp-no-phone-note','Responda pela conversa no app WhatsApp Business'));}
    } catch (failure) {
      if(requestVersion!==detailRequestVersion)return;
      const code=failure?.requestId||failure?.code||'SEM-CODIGO';
      const root=$('record-detail');root.replaceChildren();
      root.append(element('p','status error',`Não consegui abrir este lead agora. Código: ${code}`));
      const actions=element('div','inline-actions');
      const retry=element('button','small','Tentar de novo');retry.type='button';retry.addEventListener('click',()=>openDetail(kind,key,{push:false,origin:detailOrigin}));
      const back=element('button','quiet small','Voltar ao painel');back.type='button';back.addEventListener('click',()=>{if(history.state?.detail)history.back();else restoreOrigin(detailOrigin||captureOrigin()).catch(()=>{});});
      actions.append(retry,back);root.append(actions);
    }
  }

  function simulationBlock(item) {
    const section = element('section', 'record-block detail-simulations');
    section.append(element('h3', '', item.simulationCount > 1 ? `${item.simulationCount} simulações desta Ref` : 'Simulação desta Ref'));
    (item.simulations || [item]).forEach((simulation) => {
      const row = element('div', 'detail-simulation');
      const mode = simulation.logicalMode === 'VALOR' ? 'Por valor' : simulation.logicalMode === 'CARRO' ? 'Carro ideal' : 'Simulação';
      row.append(element('strong', '', mode));
      const dl = element('dl', 'definition-grid');
      definition(dl, 'Veículo', displayModel(simulation.vehicleText) || 'Não informado');
      definition(dl, 'Orçamento', simulation.budgetCents ? formatMoney(simulation.budgetCents) : 'Não informado');
      definition(dl, 'Pagamento', displayPayment(simulation.paymentText));
      definition(dl, 'Prazo', displayDeadline(simulation.deadlineText));
      definition(dl, 'Canal', simulation.contactChannel || 'Não informado');
      definition(dl, 'Data', simulation.occurredAt ? formatDate(simulation.occurredAt) : 'Não informada');
      row.append(dl);
      section.append(row);
    });
    return section;
  }

  async function openOrderDetail(ref) {
    const data = await request('/api/panel/orders?filter=Todos&period=all&limit=1&offset=0&ref=' + encodeURIComponent(ref));
    const item = data.items && data.items[0];
    const root = $('record-detail');
    if (!item) return empty(root, 'Pedido não encontrado.');
    updateMeta(data.meta);
    const intro = element('section', 'record-block');
    const title = element('div', 'identity');
    title.append(element('span', 'order-icon', orderIcon(item)));
    const text = element('div');
    text.append(element('h2', '', `Ref ${item.ref || item.referenceCode || '—'}`), element('p', 'muted', displayModel(item.vehicleText) || 'Veículo não informado'));
    title.append(text);
    intro.append(title);
    const badges = element('div', 'badges');
    if (item.simulationCount > 1) badges.append(makeBadge(`${item.simulationCount} simulações`, 'blue'));
    if (item.status) badges.append(makeBadge(item.status, item.status === 'RESPONDIDO' ? 'blue' : item.status === 'SEM RESPOSTA' ? 'yellow' : ''));
    if (item.outOfStandard) badges.append(makeBadge('Valor fora do padrão', 'yellow'));
    if (item.disposition === 'TREATED') badges.append(makeBadge('Tratado', 'blue'));
    if (item.disposition === 'DISCARDED') badges.append(makeBadge(`Descartado${item.discardReason?' · '+discardLabel(item.discardReason):''}`));
    intro.append(badges, simulationBlock(item), dispositionControls({ ...item, kind: 'CALCULATOR' }));

    const linkedJourneyId = item.journeyId || item.link && item.link.journeyId;
    if (linkedJourneyId) {
      await openRecord(linkedJourneyId, { prepend: intro });
      return;
    }

    if (item.kind === 'CALCULATOR' && !item.link) {
      const form = element('div', 'inline-form');
      const label = element('label', '', 'Ligar a um lead');
      const select = element('select');
      select.append(new Option('Escolha uma jornada', ''));
      (data.linkTargets || []).forEach((target) => select.append(new Option(target.label, `${target.journeyId}|${target.contactId}`)));
      label.append(select);
      const button = element('button', 'small', 'Ligar a um lead');
      button.type = 'button';
      button.disabled = true;
      select.addEventListener('change', () => { button.disabled = !select.value; });
      MCSAction.bind(button,()=>{const [journeyId,contactId]=select.value.split('|');return{scope:intro,optimistic:()=>{button.textContent='Ligando…';},commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'link_request',journeyId,contactId,calcRef:item.ref})}),rollback:()=>{button.textContent='Ligar a um lead';},refresh:()=>openDetail('order',item.ref,{push:false,origin:detailOrigin}),errorText:'Não consegui salvar — tente de novo'};});
      form.append(label, button);
      intro.append(form);
    }
    root.replaceChildren(intro);
  }

  function renderToday(items, preserveAll=false) {
    const root = $('today-list');
    const stats = $('today-stats');
    root.replaceChildren();
    stats.replaceChildren();
    if(!preserveAll)todayItems = items.slice();
    const all=preserveAll?todayItems:items.slice(),counts={all:all.length,with:all.filter(hasRef).length,without:all.filter((item)=>!hasRef(item)).length};
    document.querySelectorAll('[data-today-ref]').forEach((button)=>{button.classList.toggle('active',button.dataset.todayRef===todayRefFilter);const count=button.querySelector('span');if(count)count.textContent=String(counts[button.dataset.todayRef]||0);});
    items=all.filter((item)=>todayRefFilter==='all'||(todayRefFilter==='with'?hasRef(item):!hasRef(item))).sort((a,b)=>{const ao=a.next_action_at&&Date.parse(a.next_action_at)<Date.now()?1:0,bo=b.next_action_at&&Date.parse(b.next_action_at)<Date.now()?1:0;return bo-ao;});
    setCount('today', all.length);
    const stat = (value, label) => {
      const block = element('div', 'today-stat');
      block.append(element('strong', '', value), element('span', '', label));
      stats.append(block);
    };
    stat(items.length, 'Para responder');
    if (items.some((item) => item.heat)) stat(items.filter((item) => item.heat === 'HOT').length, 'Quentes');
    if (items.some((item) => item.searchStage)) {
      stat(items.filter((item) => item.searchStage === 'MISSING').length, 'Falta buscar');
      stat(items.filter((item) => item.searchStage === 'SENT').length, 'Opções enviadas');
    }
    if (!items.length) return empty(root, 'Nenhum item nas últimas 24 horas.');
    items.forEach((item) => {
      const heat = String(item.heat || '').toUpperCase();
      const card = element('article', `item-card today-card${heat ? ` heat-${heat.toLowerCase()}` : ''}`);
      const head = element('div', 'item-head');
      if (item.kind === 'CALCULATOR_ORDER') {
        const title = element('div', 'identity');
        title.append(element('span', 'order-icon', orderIcon(item)));
        const txt = element('div');
        txt.append(element('strong', 'identity-name', item.contactName||`Pedido ${item.ref}`),phoneNode(item), element('span', 'muted one-line', `Ref ${item.ref||'—'} · ${displayModel(item.vehicleText) || 'Veículo não informado'}${item.budgetCents?` · ${formatMoney(item.budgetCents)}`:''}`));
        title.append(txt);
        head.append(title);
      } else {
        head.append(identityHeader(item));
      }
      card.append(head);
      const badges = element('div', 'badges');
      if(item.searchStageLabel)badges.append(makeBadge(item.searchStageLabel,item.searchStage==='SENT'?'green':item.searchStage==='SAVED'?'blue':'yellow'));
      if (item.simulationCount > 1) badges.append(makeBadge(`${item.simulationCount} simulações`, 'blue'));
      if (item.wantsCar) badges.append(makeBadge('QUER ESTE CARRO', 'green'));
      if(item.returnedToTalk)badges.append(makeBadge('VOLTOU A FALAR','yellow'));
      if(item.pendingAiCount)badges.append(makeBadge(`📝 ${item.pendingAiCount} itens para confirmar`,'yellow'));
      if(item.aiLinkSuggested)badges.append(makeBadge('🔗 ligação sugerida','yellow'));
      if(item.kind==='CALCULATOR_ORDER'){const contact=contactMeta(item);if(contact)badges.append(contact);}
      badges.append(makeBadge(item.goodHour ? 'bom horário' : 'fora de horário', item.goodHour ? 'green' : 'yellow'));
      if (item.budgetCents) badges.append(makeBadge(formatMoney(item.budgetCents), 'blue'));
      if (item.outOfStandard) badges.append(makeBadge('Valor fora do padrão', 'yellow'));
      if (item.kind === 'JOURNEY') badges.append(makeBadge('Ficha nova', 'blue'));
      card.append(badges);
      const waiting=waitClockNode(item),receipt=readReceiptNode(item),next=nextActionNode(item,()=>loadCurrent('today',viewRequestVersion));if(waiting)card.append(waiting);if(receipt)card.append(receipt);if(next)card.append(next);
      if(!hasRef(item)){const copy=copyPhoneButton(item,card);if(copy)card.append(copy);}
      const smsMissing=smsPrintMissing(item); if(smsMissing)card.append(smsMissing);
      const actions = element('div', 'inline-actions');
      const open = element('button', 'today-primary small', item.kind === 'CALCULATOR_ORDER' ? 'Abrir pedido' : 'Abrir ficha');
      open.type = 'button';
      open.addEventListener('click', () => openDetail(item.kind === 'CALCULATOR_ORDER' ? 'order' : 'ficha', item.kind === 'CALCULATOR_ORDER' ? item.ref : item.id));
      actions.append(open);
      card.append(actions, dispositionControls(item));
      makeCardClickable(card, () => openDetail(item.kind === 'CALCULATOR_ORDER' ? 'order' : 'ficha', item.kind === 'CALCULATOR_ORDER' ? item.ref : item.id));
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
      const identity = element('div', 'identity');
      identity.append(element('span', 'order-icon', orderIcon(item)));
      const title = element('div');
      const heading = item.contactName || (item.ref || item.referenceCode ? `Ref ${item.ref || item.referenceCode}` : 'Pedido direto');
      title.append(element('h3', 'identity-name', heading),phoneNode(item), element('p', 'muted', `Ref ${item.ref||item.referenceCode||'—'} · ${displayModel(item.vehicleText) || 'Veículo não informado'}${item.budgetCents?` · ${formatMoney(item.budgetCents)}`:''}`));
      const direct=directLeadBadge(item);if(direct)title.append(direct);
      identity.append(title);
      head.append(identity);
      card.append(head);

      const contact=contactMeta(item);if(contact)card.append(contact);
      const smsMissing=smsPrintMissing(item); if(smsMissing)card.append(smsMissing);

      const badges = element('div', 'badges');
      if(item.searchStageLabel)badges.append(makeBadge(item.searchStageLabel,item.searchStage==='SENT'?'green':item.searchStage==='SAVED'?'blue':'yellow'));
      if (item.sourceLabel) badges.append(makeBadge(item.sourceLabel));
      if (item.simulationCount > 1) badges.append(makeBadge(`${item.simulationCount} simulações`, 'blue'));
      else badges.append(makeBadge(item.logicalMode === 'CARRO' ? 'CARRO IDEAL' : item.logicalMode === 'VALOR' ? 'POR VALOR' : 'PEDIDO'));
      if (item.status) badges.append(makeBadge(item.status, item.status === 'RESPONDIDO' ? 'blue' : item.status === 'SEM RESPOSTA' ? 'yellow' : item.status === 'ATIVO' ? 'green' : ''));
      if (item.disposition === 'TREATED') badges.append(makeBadge('Tratado', 'blue'));
      if (item.disposition === 'DISCARDED') badges.append(makeBadge(`Descartado${item.discardReason?' · '+discardLabel(item.discardReason):''}`));
      if (item.outOfStandard) badges.append(makeBadge('Valor fora do padrão', 'yellow'));
      card.append(badges);

      const details = element('dl', 'definition-grid order-details');
      definition(details, 'Ref', item.ref || item.referenceCode || null);
      definition(details, 'Orçamento', item.budgetCents ? formatMoney(item.budgetCents) : 'Não informado');
      definition(details, 'Pagamento', displayPayment(item.paymentText));
      definition(details, 'Estado', item.state || 'Não informado');
      definition(details, 'ZIP', item.zip || 'Não informado');
      definition(details, 'Anos', item.yearsText || 'Não informado');
      definition(details, 'Milhas', item.mileageText || 'Não informado');
      definition(details, 'Prazo', displayDeadline(item.deadlineText));
      definition(details, 'Contato escolhido', item.contactChannel || 'Não informado');
      definition(details, 'Data', item.occurredAt ? formatDate(item.occurredAt) : 'Não informada');
      card.append(details);

      if (item.kind === 'CALCULATOR' && !item.link) {
        const form = element('div', 'inline-form');
        const label = element('label', '', 'Ligar a um lead');
        const select = element('select');
        select.append(new Option('Escolha uma jornada', ''));
        linkTargets.forEach((target) => select.append(new Option(target.label, `${target.journeyId}|${target.contactId}`)));
        label.append(select);
        const button = element('button', 'small', 'Ligar a um lead');
        button.type = 'button';
        button.disabled = true;
        select.addEventListener('change', () => { button.disabled = !select.value; });
        MCSAction.bind(button,()=>{const [journeyId,contactId]=select.value.split('|');return{scope:card,optimistic:()=>{button.textContent='Ligando…';},commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'link_request',journeyId,contactId,calcRef:item.ref})}),rollback:()=>{button.textContent='Ligar a um lead';},refresh:refreshCurrentPreservingState,errorText:'Não consegui salvar — tente de novo'};});
        form.append(label, button);
        card.append(form);
      }

      card.append(dispositionControls(item));

      makeCardClickable(card, () => {
        if (item.kind === 'CALCULATOR') openDetail('order', item.ref);
        else if (item.journeyId) openDetail('ficha', item.journeyId);
      });
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
      if(item.searchStageLabel)badges.append(makeBadge(item.searchStageLabel,item.searchStage==='SENT'?'green':item.searchStage==='SAVED'?'blue':'yellow'));
      const qualificationStatus = item.enabled === false ? 'DESLIGADO' : item.status;
      badges.append(makeBadge(item.checklistSummary.label, item.checklistSummary.completed === 6 ? 'green' : 'blue'), makeBadge(item.stage, item.stage === 'RESPONDIDO' ? 'blue' : ''), makeBadge(qualificationStatus, qualificationStatus === 'ATIVO' ? 'green' : qualificationStatus === 'RESPONDIDO' ? 'blue' : ''));
      if (item.shortDeadline) badges.append(makeBadge('prazo curto', 'yellow'));
      head.append(title, badges);
      card.append(head);
      const smsMissing=smsPrintMissing(item); if(smsMissing)card.append(smsMissing);
      item.checklist.forEach((point) => {
        const block = element('div', 'check-point' + (point.status === 'COMPLETE' ? ' complete' : ''));
        block.append(element('strong', '', `${point.point_number}. ${point.point_label}`), makeBadge(checklistStatusLabel(point.status), point.status === 'COMPLETE' ? 'green' : ''));
        point.evidence.forEach((evidence) => block.append(element('p', 'evidence', evidence.excerpt_text)));
        card.append(block);
      });
      const open = element('button', 'quiet small', 'Abrir ficha e conversa');
      open.type = 'button';
      open.addEventListener('click', () => openDetail('ficha', item.id));
      makeCardClickable(card, () => openDetail('ficha', item.id));
      card.append(open, journeySwitch(item, () => loadCurrent()));
      root.append(card);
    });
  }

  function wishlistSummary(wishlist, budgetCents) {
    const wishes = Array.isArray(wishlist) ? wishlist : [wishlist || {}];
    const vehicles = wishes.slice(0, 5).map((wish) => {
      const years = wish.yearMin && wish.yearMax ? `${wish.yearMin}–${wish.yearMax}` : wish.yearMin || wish.yearMax || 'qualquer ano';
      const miles = wish.maxMiles ? `até ${Number(wish.maxMiles).toLocaleString('pt-BR')} milhas` : 'sem limite de milhas';
      return `${wish.make || 'Marca não informada'} ${wish.model || 'modelo não informado'} · ${years} · ${miles}`;
    });
    return `${vehicles.join(' | ')}${budgetCents ? ` · teto ${formatMoney(budgetCents)}` : ''}`;
  }

  function downloadShortlist(matches, referenceCode) {
    if (!matches.length) return;
    const plain = (value) => String(value || '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').slice(0, 105);
    const escape = (value) => plain(value).replace(/[\\()]/g, '\\$&');
    const lines = [`MY CAR SCOUT - SHORTLIST - REF ${plain(referenceCode || '')}`,
      ...matches.slice(0, 45).map((match) => {
        const vehicle = match.vehicle_json.parsed || match.vehicle_json.raw || {};
        return [vehicle.year || vehicle.Year, vehicle.make || vehicle.Make, vehicle.model || vehicle.Model,
          vehicle.miles || vehicle.Miles ? `${Number(vehicle.miles || vehicle.Miles).toLocaleString('en-US')} mi` : '',
          vehicle.locationDisplay || vehicle.location || ''].filter(Boolean).join(' | ');
      })];
    const content = `BT /F1 11 Tf 40 790 Td 14 TL ${lines.map((line,index) => `${index?'T* ':''}(${escape(line)}) Tj`).join('\n')} ET`;
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((object,index) => { offsets.push(pdf.length); pdf += `${index+1} 0 obj\n${object}\nendobj\n`; });
    const xref = pdf.length; pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
    offsets.slice(1).forEach((offset) => { pdf += String(offset).padStart(10,'0')+' 00000 n \n'; });
    pdf += `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `shortlist-${referenceCode || 'lead'}.pdf`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderManheimGroup(root, journey, matches, reactivation) {
    const card = element('article', 'item-card manheim-lead');
    const head = element('div', 'item-head');
    head.append(identityHeader(journey), makeBadge(`${matches.filter((match) => match.match_kind === 'BATE').length} BATE · ${matches.filter((match) => match.match_kind === 'QUASE').length} QUASE`, matches.some((match) => match.match_kind === 'BATE') ? 'green' : 'yellow'));if(journey.searchStageLabel)head.append(makeBadge(journey.searchStageLabel,journey.searchStage==='SENT'?'green':journey.searchStage==='SAVED'?'blue':'yellow'));
    card.append(head, element('p', 'muted', wishlistSummary(journey.wishlists || journey.wishlist, journey.budget_cents)));
    if (reactivation) {
      const reactivateButton = element('button', 'small', journey.status === 'PARADO' ? 'Retomar busca' : 'Religar busca');
      reactivateButton.type = 'button';
      MCSAction.bind(reactivateButton,()=>{const payload=journey.status==='PARADO'?{action:'set_funnel',journeyId:journey.id,value:'EM_BUSCA'}:{action:'toggle_journey',journeyId:journey.id,enabled:true,reason:null};return{scope:card,optimistic:()=>{reactivateButton.textContent='Retomando…';},commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify(payload)}),rollback:()=>{reactivateButton.textContent=journey.status==='PARADO'?'Retomar busca':'Religar busca';},refresh:()=>loadCurrent(),errorText:'Não consegui salvar — tente de novo'};});
      card.append(makeBadge(journey.status === 'PARADO' ? 'Parado — reativar' : 'Desligado — reativar', 'yellow'), reactivateButton);
    }
    const table = element('div', 'manheim-table');
    matches.forEach((match) => {
      const parsed = match.vehicle_json.parsed || {};
      const row = element('div', `manheim-row ${match.match_kind === 'BATE' ? 'match' : 'near'}`);
      const select = element('input'); select.type = 'checkbox'; select.className = 'manheim-select'; select.dataset.matchId = match.id;
      const vehicle = element('div');
      vehicle.append(
        element('strong', '', [parsed.year, parsed.make, parsed.model, parsed.trim].filter(Boolean).join(' ')),
        element('span', 'muted', `${Number(parsed.miles || 0).toLocaleString('pt-BR')} milhas${parsed.locationDisplay || parsed.location ? ` · ${parsed.locationDisplay || parsed.location}` : ''}${parsed.saleDate ? ` · ${parsed.saleDate}` : ''}`)
      );
      if (parsed.vin) vehicle.append(element('span', 'muted', `VIN: ${parsed.vin}`));
      if (parsed.matchedWishlistLabel) vehicle.append(element('span', 'muted', `Lista: ${parsed.matchedWishlistLabel}`));
      if (parsed.makeNotice) vehicle.append(element('span', 'muted', parsed.makeNotice));
      if (parsed.exteriorColor) vehicle.append(element('span', 'muted', `Cor externa: ${parsed.exteriorColor}`));
      if (parsed.buyNowPrice) vehicle.append(element('span', 'muted', `Buy Now: ${parsed.buyNowPrice}`));
      if (parsed.conditionGrade) vehicle.append(element('span', 'muted', `Nota de condição: ${parsed.conditionGrade}`));
      const badges = element('div', 'badges');
      badges.append(makeBadge(match.match_kind, match.match_kind === 'BATE' ? 'green' : 'yellow'));
      if (match.match_reason) badges.append(makeBadge(match.match_reason));
      if (match.mmr_status) badges.append(makeBadge(match.mmr_status, match.mmr_status.includes('acima') ? 'yellow' : 'blue'));
      const presented = element('button', 'quiet small', match.presented_unit_id ? 'Apresentado' : journey.enabled === false ? 'Religue antes de apresentar' : 'Apresentei ao cliente');
      presented.type = 'button'; presented.disabled = Boolean(match.presented_unit_id) || journey.enabled === false;
      MCSAction.bind(presented,()=>({scope:row,optimistic:()=>{presented.textContent='Apresentado';},commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'unit',journeyId:journey.id,manheimMatchId:match.id,status:'PRESENTED'})}),rollback:()=>{presented.textContent='Apresentei ao cliente';},refresh:()=>loadCurrent(),errorText:'Não consegui salvar — tente de novo'}));
      row.append(select, vehicle, badges, presented);
      table.append(row);
    });
    card.append(table);
    const exportButton = element('button', 'quiet small', 'Baixar PDF');
    exportButton.type = 'button';
    exportButton.addEventListener('click', () => {
      const selected = [...card.querySelectorAll('.manheim-select:checked')].map((checkbox) => matches.find((match) => match.id === checkbox.dataset.matchId)).filter(Boolean);
      downloadShortlist(selected, journey.reference_code);
    });
    card.append(exportButton,dispositionControls({kind:'JOURNEY',id:journey.id,journeyId:journey.id,disposition:journey.disposition}));
    makeCardClickable(card, () => openDetail('ficha', journey.id));
    root.append(card);
  }

  function renderManheimOrderGroup(root, order, matches) {
    const card = element('article', 'item-card manheim-lead');
    const head = element('div', 'item-head');
    const identity = element('div', 'identity');
    identity.append(element('span', 'order-icon', orderIcon(order)));
    const text = element('div');
    text.append(element('strong', 'identity-name', order.contactName||`Pedido ${order.ref}`),phoneNode(order), element('span', 'muted one-line', `Ref ${order.ref||'—'} · ${displayModel(order.vehicleText) || 'Pedido da calculadora'}${order.budgetCents?` · ${formatMoney(order.budgetCents)}`:''}`));
    identity.append(text);
    head.append(identity);
    card.append(head);
    const summary = element('div', 'badges');
    summary.append(makeBadge(`${matches.filter((match) => match.match_kind === 'BATE').length} BATE · ${matches.filter((match) => match.match_kind === 'QUASE').length} QUASE`, matches.some((match) => match.match_kind === 'BATE') ? 'green' : 'yellow'));
    summary.append(makeBadge(`Ref ${order.ref}`, 'blue'));
    card.append(summary, element('p', 'muted', order.simulationCount > 1 ? `${order.simulationCount} simulações agrupadas` : 'Pedido da calculadora'));
    const contact=contactMeta(order);if(contact)card.append(contact);
    const smsMissing=smsPrintMissing(order); if(smsMissing)card.append(smsMissing);

    const table = element('div', 'manheim-table');
    matches.forEach((match) => {
      const parsed = match.vehicle_json.parsed || {};
      const row = element('div', `manheim-row ${match.match_kind === 'BATE' ? 'match' : 'near'}`);
      const vehicle = element('div');
      vehicle.append(
        element('strong', '', [parsed.year, parsed.make, parsed.model, parsed.trim].filter(Boolean).join(' ')),
        element('span', 'muted', `${Number(parsed.miles || 0).toLocaleString('pt-BR')} milhas${parsed.locationDisplay || parsed.location ? ` · ${parsed.locationDisplay || parsed.location}` : ''}`)
      );
      if (parsed.vin) vehicle.append(element('span', 'muted', `VIN: ${parsed.vin}`));
      vehicle.append(element('span', 'muted', `Ref do pedido: ${order.ref}`));
      const badges = element('div', 'badges');
      badges.append(makeBadge(match.match_kind, match.match_kind === 'BATE' ? 'green' : 'yellow'));
      if (match.match_reason) badges.append(makeBadge(match.match_reason));
      if (match.mmr_status) badges.append(makeBadge(match.mmr_status, match.mmr_status.includes('acima') ? 'yellow' : 'blue'));
      row.append(vehicle, badges);
      makeCardClickable(row, () => openDetail('order', order.ref));
      table.append(row);
    });
    const actions=element('div','inline-actions');
    const open=element('button','small','Abrir pedido');open.type='button';open.addEventListener('click',(event)=>{event.stopPropagation();openDetail('order',order.ref);});
    actions.append(open);card.append(table,actions,dispositionControls({...order,kind:'CALCULATOR'}));
    makeCardClickable(card, () => openDetail('order', order.ref));
    root.append(card);
  }

  function renderManheim(data) {
    const mode=$('manheim-sort')?.value||'recent';
    const cardMode=mode==='customers'?'recent':mode;
    manheimJourneys = clientSort(data.items || [],cardMode);
    manheimOrders = clientSort(data.orders || [],cardMode);
    manheimMatches = data.matches || [];
    renderSavedSearches().catch(() => { $('manheim-saved-searches').textContent = 'Não foi possível carregar as buscas sugeridas.'; });
    setCount('manheim', data.upload && data.upload.lead_count || 0);
    $('manheim-summary').textContent = data.upload ? `${data.upload.vehicle_count} carro(s) analisado(s) · ${data.upload.matched_vehicle_count} combinação(ões) · ${data.upload.lead_count} lead(s) · ${formatDate(data.upload.uploaded_at)}` : 'Nenhuma exportação processada.';
    if(data.historyIncomplete)$('manheim-summary').textContent += ' · reenviar CSVs dos últimos 60 dias para completar o histórico';
    const root = $('manheim-results');
    root.replaceChildren();
    if (!manheimMatches.length) return empty(root, 'Nenhum carro compatível no último upload.');

    const byJourney = new Map(manheimJourneys.map((journey) => [journey.id, journey]));
    const byOrder = new Map(manheimOrders.map((order) => [order.ref, order]));
    const journeyGroups = new Map();
    const orderGroups = new Map();

    manheimMatches.forEach((match) => {
      if (match.calc_ref) {
        const ref = String(match.calc_ref).trim();
        if (!orderGroups.has(ref)) orderGroups.set(ref, []);
        orderGroups.get(ref).push(match);
      } else if (match.journey_id) {
        if (!journeyGroups.has(match.journey_id)) journeyGroups.set(match.journey_id, []);
        journeyGroups.get(match.journey_id).push(match);
      }
    });

    const standard = element('section', 'stack');
    standard.append(element('h3', '', 'Compatíveis'));
    const reactivate = element('section', 'stack');
    reactivate.append(element('h3', '', 'Reativar'));
    let standardCount = 0;
    let reactivateCount = 0;

    [...orderGroups.entries()].sort((a,b)=>manheimOrders.findIndex(x=>x.ref===a[0])-manheimOrders.findIndex(x=>x.ref===b[0])).forEach(([ref,matches]) => {
      const order = byOrder.get(ref);
      if (!order) return;
      renderManheimOrderGroup(standard, order, matches);
      standardCount += 1;
    });

    [...journeyGroups.entries()].sort((a,b)=>manheimJourneys.findIndex(x=>x.id===a[0])-manheimJourneys.findIndex(x=>x.id===b[0])).forEach(([journeyId,matches]) => {
      const journey = byJourney.get(journeyId);
      if (!journey) return;
      const isReactivation = journey.reactivationEligible || journey.status === 'PARADO';
      if (isReactivation) {
        const exact = matches.filter((match) => match.match_kind === 'BATE');
        if (exact.length) { renderManheimGroup(reactivate, journey, exact, true); reactivateCount += 1; }
      } else {
        renderManheimGroup(standard, journey, matches, false);
        standardCount += 1;
      }
    });

    if (standardCount) root.append(standard);
    if (reactivateCount) root.append(reactivate);
  }

  async function renderSavedSearches() {
    const data = savedSearchesData || await request('/api/panel/manheim-searches');
    savedSearchesData = data;
    const root = $('manheim-saved-searches');
    root.replaceChildren(element('h2', '', 'QUAIS BUSCAS SALVAR NO MANHEIM'));
    root.append(element('p','muted','Cada linha é uma busca para você salvar no Manheim. As primeiras atendem mais clientes. Conta só quem entrou em contato.'));
    if (!data.groups.length) return root.append(element('p', 'muted', 'Nenhum lead ativo com marca e modelo.'));
    const mode=$('manheim-sort')?.value||'customers';
    const groups=data.groups.slice().sort((a,b)=>mode==='vehicle'?`${a.make} ${a.model}`.localeCompare(`${b.make} ${b.model}`,'pt-BR'):mode==='recent'?(Date.parse(b.latestAt||0)-Date.parse(a.latestAt||0)||a.searches-b.searches):a.searches-b.searches);
    groups.forEach((group) => {
      const line = element('article', 'saved-search-line');
      const text = element('span'); const title=`#${group.searches} · ${group.make} ${group.model} · ${group.yearFrom}–${group.yearTo} · até ${Number(group.milesMax).toLocaleString('pt-BR')} milhas`;
      const clients=element('button','quiet small',`👥 ${group.leads} ${group.leads===1?'cliente quer':'clientes querem'} este carro`); clients.type='button';
      const people=element('div','saved-search-clients hidden'); (group.clients||[]).forEach((client)=>{const person=element('button','quiet small',`${client.name||'Pedido'} · 📞 ${client.phone?phoneDisplay(client.phone):'falta o número'} · Ref ${client.ref||'—'}`);person.type='button';person.addEventListener('click',()=>{if(client.journeyId)openDetail('ficha',client.journeyId);});people.append(person);}); clients.addEventListener('click',()=>people.classList.toggle('hidden'));
      text.append(element('strong','',title),clients,element('span','muted',mode==='customers'?`Salvando da #1 até esta, você atende ${group.percent}% dos clientes ativos.`:`Esta busca sozinha atende ${group.individualPercent}% dos clientes ativos.`),people);
      const toggle=element('button',group.created?'quiet small':'small',group.created?'✓ Busca criada':'Já criei esta busca'); toggle.type='button';
      const undo=element('button','quiet small','Desfazer');undo.type='button';undo.classList.toggle('hidden',!group.created);undo.addEventListener('click',()=>toggle.click());
      MCSAction.bind(toggle,()=>{const before=group.created;return{scope:line,optimistic:()=>{group.created=!before;toggle.textContent=group.created?'✓ Busca criada':'Já criei esta busca';undo.classList.toggle('hidden',!group.created);return before;},commit:()=>request('/api/panel/manheim-searches',{method:'POST',body:JSON.stringify({key:group.key,created:group.created})}),rollback:()=>{group.created=before;toggle.textContent=before?'✓ Busca criada':'Já criei esta busca';undo.classList.toggle('hidden',!before);},onSuccess:()=>{if(savedSearchesData?.groups){const cached=savedSearchesData.groups.find((entry)=>entry.key===group.key);if(cached)cached.created=group.created;}},errorText:'Não consegui salvar — tente de novo'};});
      const controls=element('div','inline-actions');controls.append(toggle,undo);line.append(text,controls);root.append(line);
    });
  }

  async function importManheim(files) {
    const selected = files.filter((file) => /\.csv$/i.test(file.name));
    if (!selected.length || selected.length !== files.length || selected.length > MAX_FILES) throw new Error('MANHEIM_FILES_INVALID');
    if (!window.MCSManheim) throw new Error('MANHEIM_READER_UNAVAILABLE');
    $('manheim-status').classList.remove('error');
    $('manheim-status').textContent = 'Lendo e comparando no navegador…';
    if (!manheimJourneys.length && !manheimOrders.length) {
      const data = await request('/api/panel/records?view=manheim');
      manheimJourneys = data.items || [];
      manheimOrders = data.orders || [];
    }
    const vehicles = [];
    const headerGroups = [];
    const mappings = [];
    const parsedCounts = [];
    for (const file of selected) {
      if (file.size > MAX_TEXT) throw new Error('MANHEIM_FILE_TOO_LARGE');
      let contents;
      try { contents = await file.text(); }
      catch { throw new Error('MANHEIM_FILE_READ_FAILED'); }
      const parsed = MCSManheim.parseCsv(contents);
      const mapping = MCSManheim.mapHeaders(parsed.headers);
      if (mapping.missing.length) {
        $('manheim-status').classList.add('error');
        $('manheim-status').textContent = `CSV incompleto: faltam ${mapping.missing.join(', ')}.`;
        return;
      }
      headerGroups.push(parsed.headers);
      mappings.push(mapping.fields);
      const normalized=MCSManheim.normalizeRows(parsed, mapping);parsedCounts.push({ignored:parsed.rows.length-normalized.length});vehicles.push(...normalized);
    }
    const ignoredRows = headerGroups.reduce((sum,_,index)=>sum+(parsedCounts[index]?.ignored||0),0);
    const matches = [];
    for (const journey of manheimJourneys) {
      const enabled = journey.enabled !== false;
      const reactivation = journey.reactivationEligible || journey.status === 'PARADO';
      if (!enabled && !reactivation) continue;
      for (const vehicle of vehicles) {
        const result = MCSManheim.matchVehicle(vehicle, journey.wishlists || journey.wishlist, journey.budget_cents);
        if (!result || (reactivation && result.kind !== 'BATE')) continue;
        matches.push({
          journeyId: journey.id, kind: result.kind, reason: result.reason, mmrStatus: result.mmrStatus,
          fingerprint: MCSManheim.fingerprint(vehicle),
          vehicle: { headers: vehicle.headers, raw: vehicle.raw, parsed: {
            vin: vehicle.vin, year: vehicle.year, make: vehicle.make, makeInferred: vehicle.makeInferred, makeNotice: vehicle.makeNotice,
            model: vehicle.model, trim: vehicle.trim, miles: vehicle.miles, location: vehicle.location, locationDisplay: vehicle.locationDisplay,
            saleDate: vehicle.saleDate, mmrCents: vehicle.mmrCents, exteriorColor: vehicle.exteriorColor, interiorColor: vehicle.interiorColor,
            buyNowPrice: vehicle.buyNowPrice, conditionGrade: vehicle.conditionGrade
          } }
        });
      }
    }
    for (const order of manheimOrders.filter((item) => item.disposition !== 'DISCARDED')) {
      for (const vehicle of vehicles) {
        const result = MCSManheim.matchOrder(vehicle, order);
        if (!result) continue;
        matches.push({
          targetType: 'ORDER', calcRef: order.ref, kind: result.kind, reason: result.reason, mmrStatus: result.mmrStatus,
          fingerprint: MCSManheim.fingerprint(vehicle),
          vehicle: { headers: vehicle.headers, raw: vehicle.raw, parsed: {
            vin: vehicle.vin, year: vehicle.year, make: vehicle.make, makeInferred: vehicle.makeInferred, makeNotice: vehicle.makeNotice,
            model: vehicle.model, trim: vehicle.trim, miles: vehicle.miles, location: vehicle.location, locationDisplay: vehicle.locationDisplay,
            saleDate: vehicle.saleDate, mmrCents: vehicle.mmrCents, exteriorColor: vehicle.exteriorColor, interiorColor: vehicle.interiorColor,
            buyNowPrice: vehicle.buyNowPrice, conditionGrade: vehicle.conditionGrade
          } }
        });
      }
    }
    if (matches.length > 2000) throw new Error('MANHEIM_MATCH_LIMIT');
    const result = await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'manheim_upload', sourceFileCount: selected.length, vehicleCount: vehicles.length, headers: headerGroups, headerMap: { files: mappings }, matches }) });
    if (result.uploadId) {
      const seen = new Set();
      const archive = vehicles.filter((vehicle) => { const id = MCSManheim.fingerprint(vehicle); if (seen.has(id)) return false; seen.add(id); return true; });
      let archived=0, ignored=ignoredRows;
      for (let index = 0; index < archive.length; index += 100) {
        const saved=await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'manheim_archive', uploadId: result.uploadId,
          vehicles: archive.slice(index, index + 100).map((vehicle) => ({ fingerprint: MCSManheim.fingerprint(vehicle), vehicle: {
            vin: vehicle.vin, year: vehicle.year, make: vehicle.make, model: vehicle.model, trim: vehicle.trim,
            miles: vehicle.miles, location: vehicle.location, locationDisplay: vehicle.locationDisplay,
            saleDate: vehicle.saleDate, mmrCents: vehicle.mmrCents
          } })) }) });
        archived+=saved.archived||0;ignored+=saved.ignored||0;
      }
      $('manheim-status').textContent = `${archived} carros arquivados, ${ignored} ignorados`;
    }
    await loadCurrent();
    await refreshCounters();
  }

  function showManheimFailure(failure) {
    const messages = {
      MANHEIM_FILE_TOO_LARGE: 'O CSV excede o limite permitido.',
      MANHEIM_FILE_READ_FAILED: 'O navegador não conseguiu ler o CSV selecionado. Selecione o arquivo novamente.',
      MANHEIM_MATCH_LIMIT: 'O CSV gerou combinações demais; reduza o arquivo.',
      MANHEIM_UPLOAD_INVALID: 'O resumo do CSV não passou na validação.',
      MANHEIM_MATCH_INVALID: 'Uma linha compatível não passou na validação.',
      MANHEIM_JOURNEY_DISABLED: 'Uma busca não está disponível para comparação.',
      PAYLOAD_TOO_LARGE: 'O resultado compatível excede o limite de envio.',
      PANEL_ACTION_FAILED: 'A comparação foi lida, mas não pôde ser gravada. Tente novamente.'
    };
    const moduleMissing = failure && failure.message === 'MCSManheim is not defined';
    $('manheim-status').classList.add('error');
    $('manheim-status').textContent = moduleMissing ? 'O leitor de CSV não carregou. Atualize a página e tente novamente.' : messages[failure && failure.code] || 'Não foi possível ler ou comparar este CSV.';
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
    const sorted = items.slice();
    sorted.forEach((item) => {
      const card = element('article', 'search-hit record-list-card');
      const text = identityHeader(item, { preview: item.latestMessage && item.latestMessage.body_text || '' });
      const controls = element('div', 'record-card-controls');
      const recordStatus = item.enabled === false ? 'DESLIGADO' : item.status;
      controls.append(makeBadge(item.stage, item.stage === 'RESPONDIDO' ? 'blue' : ''), makeBadge(recordStatus, recordStatus === 'ATIVO' ? 'green' : recordStatus === 'RESPONDIDO' ? 'blue' : ''));
      if(item.disposition)controls.append(makeBadge(item.disposition==='TREATED'?'Tratado':`Descartado${item.discardReason?' · '+discardLabel(item.discardReason):''}`,item.disposition==='DISCARDED'?'red':'blue'));
      if(item.searchStageLabel)controls.append(makeBadge(item.searchStageLabel,item.searchStage==='SENT'?'green':item.searchStage==='SAVED'?'blue':'yellow'));
      const heat=heatBadge(item);if(heat)controls.append(heat);
      if(item.pendingAiCount)controls.append(makeBadge(`📝 ${item.pendingAiCount} itens para confirmar`,'yellow'));
      if(item.aiLinkSuggested)controls.append(makeBadge('🔗 ligação sugerida','yellow'));
      const open = element('button', 'quiet small', 'Abrir ficha');
      open.type = 'button';
      open.addEventListener('click', () => openDetail('ficha', item.id));
      controls.append(open, journeySwitch(item, () => loadCurrent()));
      card.append(text, controls);
      makeCardClickable(card, () => openDetail('ficha', item.id));
      root.append(card);
    });
  }

  function definition(list, term, value) {
    const wrapper = element('div');
    wrapper.append(element('dt', '', term), element('dd', '', value === null || value === undefined || value === '' ? '—' : value));
    list.append(wrapper);
  }

  function actionMessage(message, journeyId, reload, ref, customerTimezone) {
    const root = element('details', 'message-menu');
    const summary = element('summary', '', '⋯');
    summary.setAttribute('aria-label', 'Ações desta mensagem');
    root.append(summary);
    const menu = element('div', 'message-menu-panel');
    const bindMutation=(control,commit,scope=menu)=>MCSAction.bind(control,()=>({scope,commit,refresh:reload,errorText:'Não consegui salvar — tente de novo'}));
    if (message.direction === 'CUSTOMER') {
      const wishlistForm = element('div', 'wishlist-menu');
      const wishlistRows = [];
      const addWishlistRow = () => {
        if (wishlistRows.length >= 5) return;
        const row = element('div', 'wishlist-row');
        const make = element('input'); make.placeholder = 'Marca'; make.maxLength = 80;
        const model = element('input'); model.placeholder = 'Modelo'; model.maxLength = 120;
        const yearMin = element('input'); yearMin.type = 'number'; yearMin.placeholder = 'Ano de'; yearMin.min = '1900'; yearMin.max = String(new Date().getFullYear() + 2);
        const yearMax = element('input'); yearMax.type = 'number'; yearMax.placeholder = 'Ano até'; yearMax.min = '1900'; yearMax.max = String(new Date().getFullYear() + 2);
        const maxMiles = element('input'); maxMiles.type = 'number'; maxMiles.placeholder = 'Milhas até'; maxMiles.min = '0'; maxMiles.max = '2000000';
        row.append(make, model, yearMin, yearMax, maxMiles);
        wishlistRows.push({ make, model, yearMin, yearMax, maxMiles });
        wishlistForm.append(row);
      };
      addWishlistRow();
      const addVehicle = element('button', 'quiet small', '+ outro carro');
      addVehicle.type = 'button';
      addVehicle.addEventListener('click', addWishlistRow);
      const wishlistButton = element('button', 'quiet small', 'Carro ou faixa');
      wishlistButton.type = 'button';
      bindMutation(wishlistButton,async () => {
        const wishlists = wishlistRows.filter((row) => row.model.value.trim()).map((row) => ({
          make: row.make.value, model: row.model.value, yearMin: row.yearMin.value || null,
          yearMax: row.yearMax.value || null, maxMiles: row.maxMiles.value || null
        }));
        await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({
          action: 'mark_message', journeyId, ref, messageId: message.id, kind: 'VEHICLE',
          wishlists
        }) });
      });
      wishlistForm.prepend(wishlistButton, addVehicle);
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
        bindMutation(button,()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'mark_message',journeyId,ref,messageId:message.id,kind,value:needsValue?value.value:null})}),row);
        row.append(button, value);
        menu.append(row);
      });
      const okButton = element('button', 'small', 'Cliente deu OK');
      okButton.type = 'button';
      bindMutation(okButton,()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'client_ok',journeyId,ref,messageId:message.id})}));
      menu.append(okButton);
    }
    if (message.direction === 'MCS') {
      const promiseForm = element('div', 'menu-action');
      const dueLabel = element('label', '', 'Prazo da promessa');
      const due = element('input');
      due.type = 'datetime-local';
      due.value = localInputForZone(new Date(Date.now() + 24 * 3600000),customerTimezone);
      dueLabel.append(due);
      dueLabel.append(element('small','muted','horário do cliente'));
      const dueTextLabel = element('label', '', 'Prazo em texto');
      const dueText = element('input');
      dueText.maxLength = 200;
      dueText.placeholder = 'Ex.: amanhã às 15h';
      dueTextLabel.append(dueText);
      const promiseButton = element('button', 'small', 'Marcar como promessa');
      promiseButton.type = 'button';
      bindMutation(promiseButton,()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'promise',journeyId,ref,messageId:message.id,dueLocal:due.value,dueText:dueText.value})}),promiseForm);
      promiseForm.append(dueLabel, dueTextLabel, promiseButton);
      menu.append(promiseForm);
    }
    root.append(menu);
    return root;
  }

  async function openRecord(id, options = {}) {
    const data = await request('/api/panel/records?id=' + encodeURIComponent(id));
    updateMeta(data.meta);
    const item = data.item;
    const root = $('record-detail');
    root.replaceChildren();
    if (options.prepend) root.append(options.prepend);
    const reload = () => openRecord(id, options);
    const bindRecordAction=(control,commit,scope)=>MCSAction.bind(control,()=>({scope:scope||control.closest('.record-block')||root,commit,refresh:reload,errorText:'Não consegui salvar — tente de novo'}));
    const split = element('div', 'record-split');
    const left = element('div', 'record-data-column');
    const right = element('div', 'record-conversation-column');
    split.append(left, right);
    root.append(split);

    const dataBlock = element('section', 'record-block');
    dataBlock.append(element('h2', '', item.contact && item.contact.display_name || 'Contato sem nome'));
    const statusBadges = element('div', 'badges');
    statusBadges.append(makeBadge(item.stage, item.stage === 'RESPONDIDO' ? 'blue' : ''), makeBadge(item.enabled ? 'LIGADO' : 'DESLIGADO', item.enabled ? 'green' : ''), makeBadge(item.checklistSummary.label, item.checklistSummary.completed === 6 ? 'green' : 'blue'));
    if (item.shortDeadline) statusBadges.append(makeBadge('prazo curto', 'yellow'));
    dataBlock.append(statusBadges);
    const definitions = element('dl', 'definition-grid');
    definition(definitions, 'Telefones', item.phones.map((phone) => phone.phone_e164 || phone.phone_raw).join(', '));
    definition(definitions, 'Ref', item.reference_code);
    definition(definitions, 'Refs da calculadora/conversa', item.refs.map((ref) => ref.ref_code).join(', '));
    const origin = sourceLabel(item.source);
    if (origin) definition(definitions, 'Origem', origin);
    definition(definitions, 'Pagamento', displayPayment(item.payment_text));
    definition(definitions, 'Prazo', displayDeadline(item.customer_deadline_text) || formatDate(item.customer_deadline_at));
    dataBlock.append(definitions);
    const smsMissing=smsPrintMissing({ ...item, id:item.id, journeyId:item.id, contactChannel:item.contactChannel || item.contact_channel, ref:item.reference_code, contact_id:item.contact_id }); if(smsMissing)dataBlock.append(smsMissing);
    const wishlist = element('section', 'wishlist-block');
    wishlist.append(element('h3', '', 'Lista de desejo'));
    const wishes = item.wishlists && item.wishlists.length ? item.wishlists : [item.wishlist || {}];
    wishes.forEach((wish, index) => {
      const wishDefinitions = element('dl', 'definition-grid');
      const wishModel = displayModel(wish.model);
      definition(wishDefinitions, `Carro ${index + 1}`, wishModel ? (String(wishModel).toLowerCase().startsWith(String(wish.make || '').toLowerCase() + ' ') ? wishModel : [wish.make, wishModel].filter(Boolean).join(' ')) : null);
      definition(wishDefinitions, 'Ano de', wish.yearMin);
      definition(wishDefinitions, 'Ano até', wish.yearMax);
      definition(wishDefinitions, 'Milhas até', wish.maxMiles ? Number(wish.maxMiles).toLocaleString('pt-BR') : null);
      wishlist.append(wishDefinitions);
    });
    const budgetDefinition = element('dl', 'definition-grid');
    definition(budgetDefinition, 'Teto único', formatMoney(item.budget_cents));
    wishlist.append(budgetDefinition);
    dataBlock.append(wishlist, journeySwitch(item, reload));
    if (!options.prepend) dataBlock.append(dispositionControls({ kind: 'JOURNEY', id: item.id, journeyId: item.id }));
    if (!options.prepend && item.calculatorRequests && item.calculatorRequests.length) {
      item.calculatorRequests.forEach((requestItem) => dataBlock.append(simulationBlock(requestItem)));
    }
    if (item.manheimMatchCount) {
      const matchNotice = element('button', 'manheim-notice', `${item.manheimMatchCount} carro(s) do export mais recente batem · abrir Manheim`);
      matchNotice.type = 'button';
      matchNotice.addEventListener('click', () => switchPanel('searches'));
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
    bindRecordAction(saveNote,()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'update_note',journeyId:id,note:note.value})}),noteForm);
    noteForm.append(noteLabel, saveNote);
    dataBlock.append(noteForm);

    if (item.enabled && !item.stage_frozen) {
      const operations = element('div', 'inline-actions');
      ['CALL_ANSWERED', 'CALL_ATTEMPT', 'IN_PERSON'].forEach((type) => {
        const labels = { CALL_ANSWERED: 'Ligação atendida', CALL_ATTEMPT: 'Tentativa sem resposta', IN_PERSON: 'Conversa presencial' };
        const button = element('button', 'quiet small', labels[type]);
        button.type = 'button';
        bindRecordAction(button,()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'interaction',journeyId:id,interactionType:type})}),operations);
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
      bindRecordAction(statusButton,()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'set_funnel',journeyId:id,value:statusSelect.value})}),statusForm);
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
          bindRecordAction(button,()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'resolve_divergence',journeyId:id,divergenceId:divergence.id,declarationId:select.value})}),row);
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
      row.append(element('strong', '', `${point.point_number}. ${point.point_label}`), makeBadge(checklistStatusLabel(point.status), point.status === 'COMPLETE' ? 'green' : ''));
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
      bindRecordAction(complete,()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'return_update',journeyId:id,returnKind:entry.kind,returnId:entry.kind==='PROMISE'?entry.id:null,operation:'COMPLETE'})}),row);
      const remove = element('button', 'quiet small', 'Remover');
      remove.type = 'button';
      bindRecordAction(remove,()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'return_update',journeyId:id,returnKind:entry.kind,returnId:entry.kind==='PROMISE'?entry.id:null,operation:'REMOVE'})}),row);
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
      bindRecordAction(nextButton,()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'next_action',operation:'CREATE',journeyId:id,text:nextText.value,at:new Date(nextDate.value).toISOString()})}),nextForm);
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
        bindRecordAction(save,()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'unit',journeyId:id,unitId:unit.id,status:select.value,declineReason:decline.value})}),form);
        const responded = element('button', 'quiet small', 'Registrar resposta do cliente');
        responded.type = 'button';
        bindRecordAction(responded,()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'unit',journeyId:id,unitId:unit.id,status:select.value,declineReason:decline.value,customerResponded:true})}),form);
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
      bindRecordAction(add,()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'unit',journeyId:id,vehicleText:vehicle.value,status:status.value})}),addForm);
      addForm.append(vehicle, status, add);
      unitsBlock.append(addForm);
    }
    left.append(unitsBlock);

    const conversationBlock = element('section', 'record-block');
    conversationBlock.append(element('h3', '', 'CONVERSA'));
    const conversationChatIds = [...new Set((item.conversation || []).map((message) => message.chat_id).filter(Boolean))];
    if (conversationChatIds.length) {
      const senderTools = element('div', 'inline-actions');
      conversationChatIds.forEach((chatId) => {
        const invert = element('button', 'quiet small', conversationChatIds.length === 1 ? 'Inverter remetentes desta conversa' : 'Inverter remetentes deste chat');
        invert.type = 'button';
        invert.addEventListener('click',()=>{if(invert.dataset.confirmed!=='true'){invert.dataset.confirmed='true';invert.textContent='Confirmar inversão';return;}MCSAction.run({button:invert,scope:senderTools,commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'invert_senders',journeyId:id,chatId})}),refresh:reload,errorText:'Não consegui salvar — tente de novo'});});
        senderTools.append(invert);
      });
      conversationBlock.append(senderTools);
    }
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
    const searchSort=localStorage.getItem('mcs_sort_search')||'recent';
    const result = await request('/api/panel/search?q=' + encodeURIComponent(q)+'&sort='+encodeURIComponent(searchSort));
    const root = $('search-results');
    root.replaceChildren(element('h2', '', 'Resultados da busca'));
    const sortLabel=element('label','','Ordenar');const sortSelect=element('select');[['recent','Mais recentes'],['oldest','Mais antigas'],['value_desc','Maior valor'],['value_asc','Menor valor'],['location','Localização'],['vehicle','Marca do carro']].forEach(([v,l])=>sortSelect.append(new Option(l,v)));sortSelect.value=searchSort;sortSelect.addEventListener('change',()=>{localStorage.setItem('mcs_sort_search',sortSelect.value);globalSearch(new Event('submit'));});sortLabel.append(sortSelect);root.append(sortLabel);
    if (!result.items.length) root.append(element('p', 'muted', 'Nenhum resultado.'));
    result.items.forEach((item) => {
      const button = element('button', 'search-hit');
      button.type = 'button';
      const label = item.kind === 'ORDER'
        ? `${referencePhone(item)}${item.simulationCount > 1 ? ` · ${item.simulationCount} simulações` : ''}${item.vehicleText ? ` — ${displayModel(item.vehicleText)}` : ''}`
        : `${item.name} · ${referencePhone(item)}${item.vehicleText ? ` — ${displayModel(item.vehicleText)}` : ''}`;
      button.append(element('span', '', label), makeBadge(item.matchedBy));const direct=directLeadBadge(item);if(direct)button.append(direct);if(item.disposition)button.append(makeBadge(item.disposition==='TREATED'?'Tratado':`Descartado${item.discardReason?' · '+discardLabel(item.discardReason):''}`,item.disposition==='DISCARDED'?'red':'blue'));if(item.searchStageLabel)button.append(makeBadge(item.searchStageLabel,item.searchStage==='SENT'?'green':item.searchStage==='SAVED'?'blue':'yellow'));
      button.addEventListener('click', () => {
        const origin=captureOrigin();
        root.classList.add('hidden');
        if (item.kind === 'ORDER') return openDetail('order', item.ref,{origin});
        if (item.journeyId) return openDetail('ficha', item.journeyId,{origin});
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
      $('report-status').textContent = 'Relatório gerado.';
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
        await loadCaptureWarning();
      } catch (_) { clearInterval(refreshTimer); }
    }, 120000);
  };
  async function routeFromHash(push = false) {
    const hash = String(location.hash || '');
    const legacy={fichas:'clients',qualificacao:'clients',pendencias:'clients',clientes:'clients',manheim:'searches',buscas:'searches'}[hash.replace(/^#/,'').toLowerCase()];
    if(legacy){history.replaceState({panelOrigin:{view:legacy,scrollY:0}},'',location.pathname+location.search);await switchPanel(legacy);return true;}
    const order = hash.match(/^#pedido\/([A-HJ-NP-Z2-9]{5})$/i);
    if (order) {
      const ref = decodeURIComponent(order[1]).toUpperCase();
      await openDetail('order', ref, { push, origin: history.state && history.state.origin || detailOrigin || captureOrigin() });
      return true;
    }
    const record = hash.match(/^#ficha\/([0-9a-f-]{36})$/i);
    if (record) {
      await openDetail('ficha', decodeURIComponent(record[1]), { push, origin: history.state && history.state.origin || detailOrigin || captureOrigin() });
      return true;
    }
    return false;
  }

  async function handlePopState(event) {
    detailRequestVersion++;
    if (!accessToken) return;
    const state = event.state || {};
    if (state.detail && state.kind && state.key) {
      await openDetail(state.kind, state.key, { push: false, origin: state.origin || detailOrigin });
      return;
    }
    if (await routeFromHash(false)) return;
    await restoreOrigin(state.panelOrigin || detailOrigin || { view: currentView || 'today', scrollY: 0 });
  }

  async function routeSession() {
    if (!accessToken) return show('login-view');
    try {
      const session = await request('/api/panel/session');
      if (session.mustChangePassword) return show('password-view');
      show('app-view');
      await switchPanel('today');
      if (!history.state) history.replaceState({ panelOrigin: captureOrigin() }, '', location.pathname + location.search + (location.hash || ''));
      await routeFromHash(false);
      await refreshCounters();
      await loadAutomaticMessages();
      startSafeRefresh();
    } catch (failure) {
      clearSession();
      show('login-view');
      if (failure.code === 'PANEL_ACCESS_DENIED') error('login-error', 'Esta conta não tem acesso ao painel.');
    }
  }
  async function loadAutomaticMessages(){
    const list=$('automatic-message-list');if(!list)return;
    try{const data=await request('/api/panel/automatic-messages');list.replaceChildren();(data.items||[]).forEach((item)=>{const row=element('div','queue-item');row.append(element('span','',item.body_normalized));const remove=element('button','quiet small','Remover');remove.type='button';MCSAction.bind(remove,()=>({scope:row,optimistic:()=>{row.classList.add('action-optimistic-hidden');},commit:()=>request('/api/panel/automatic-messages',{method:'POST',body:JSON.stringify({action:'delete',id:item.id})}),rollback:()=>{row.classList.remove('action-optimistic-hidden');},refresh:()=>loadAutomaticMessages(),errorText:'Não consegui salvar — tente de novo'}));row.append(remove);list.append(row);});}catch(_){list.textContent='Não foi possível carregar mensagens automáticas.';}
  }
  if($('automatic-message-save'))MCSAction.bind($('automatic-message-save'),()=>{const input=$('automatic-message-text'),value=input.value.trim();if(!value)return{scope:$('automatic-message-list'),commit:()=>Promise.reject(new Error('MESSAGE_REQUIRED')),errorText:'Digite a mensagem automática.'};return{scope:$('automatic-message-list'),commit:()=>request('/api/panel/automatic-messages',{method:'POST',body:JSON.stringify({action:'save',text:value})}),onSuccess:()=>{input.value='';},refresh:()=>loadAutomaticMessages(),errorText:'Não consegui salvar — tente de novo'};});
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
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', async () => {
      history.replaceState({ panelOrigin: { view: button.dataset.view, scrollY: 0, orderFilter, orderPeriod, orderLoaded: orderItems.length } }, '', location.pathname + location.search);
      await switchPanel(button.dataset.view);
    }));
    $('detail-back').addEventListener('click', () => {
      detailRequestVersion++;
      if (history.state && history.state.detail) history.back();
      else {
        history.replaceState({ panelOrigin: detailOrigin || { view: 'today', scrollY: 0 } }, '', location.pathname + location.search);
        restoreOrigin().catch(() => {});
      }
    });
    window.addEventListener('popstate', (event) => { handlePopState(event).catch(() => {}); });
    document.querySelectorAll('[data-order-filter]').forEach((button) => button.addEventListener('click', async () => {
      orderFilter = button.dataset.orderFilter;
      if (orderFilter === 'Pendentes') orderPeriod = 'all';
      document.querySelectorAll('[data-order-filter]').forEach((item) => item.classList.toggle('active', item === button));
      syncOrderControls();
      if (currentView === 'orders') await loadCurrent();
    }));
    document.querySelectorAll('[data-order-period]').forEach((button) => button.addEventListener('click', async () => {
      orderPeriod = button.dataset.orderPeriod;
      document.querySelectorAll('[data-order-period]').forEach((item) => item.classList.toggle('active', item === button));
      if (currentView === 'orders') await loadCurrent();
    }));
    $('orders-more').addEventListener('click', () => loadOrders(true).catch(() => { $('orders-more').textContent = 'Não foi possível carregar'; }));
    ['today','entry','clients','pending','orders','qualification','searches','manheim','records'].forEach((name)=>{const select=$(name+'-sort');if(!select)return;const saved=localStorage.getItem('mcs_sort_'+name);if(saved&&[...select.options].some((option)=>option.value===saved))select.value=saved;select.addEventListener('change',()=>{localStorage.setItem('mcs_sort_'+name,select.value);if(name==='clients'){if(currentView==='clients')renderClients(clientsData);return;}if(currentView!==name&&!(currentView==='searches'&&name==='manheim'))return;if(name==='manheim'){renderSavedSearches().catch(()=>{});renderManheim({items:manheimJourneys,orders:manheimOrders,matches:manheimMatches});return;}loadCurrent().catch(()=>{});});});
    ['clients-situation','clients-checklist','clients-ref','clients-heat'].forEach((id)=>{const select=$(id),saved=localStorage.getItem('mcs_'+id);if(saved&&[...select.options].some((option)=>option.value===saved))select.value=saved;select.addEventListener('change',()=>{localStorage.setItem('mcs_'+id,select.value);if(currentView==='clients')renderClients(clientsData);});});
    document.querySelectorAll('[data-today-ref]').forEach((button)=>{button.classList.toggle('active',button.dataset.todayRef===todayRefFilter);button.addEventListener('click',()=>{todayRefFilter=button.dataset.todayRef;localStorage.setItem('mcs_today_ref_filter',todayRefFilter);renderToday(todayItems,true);});});
    document.querySelectorAll('[data-pending-situation]').forEach((button)=>button.addEventListener('click',async()=>{pendingSituation=button.dataset.pendingSituation;document.querySelectorAll('[data-pending-situation]').forEach((item)=>item.classList.toggle('active',item===button));if(currentView==='pending')await loadPending();}));
    $('pending-with-ref').addEventListener('change',()=>{if(currentView==='pending')loadPending().catch(()=>{});});
    $('pending-download').addEventListener('click',async()=>{const button=$('pending-download');button.disabled=true;try{await downloadPendingCsv();}catch(_){button.after(element('span','error','Não foi possível baixar a planilha.'));}finally{button.disabled=false;}});
    $('clients-download').addEventListener('click',()=>{const button=$('clients-download');button.disabled=true;try{downloadClientsCsv();}catch(_){button.after(element('span','error','Não foi possível baixar a planilha.'));}finally{button.disabled=false;}});
    document.querySelectorAll('[data-report]').forEach((button) => button.addEventListener('click', () => openReport(button.dataset.report)));
    $('global-search').addEventListener('submit', (event) => globalSearch(event).catch(() => { $('search-results').replaceChildren(element('p', 'muted', 'Não foi possível buscar.')); $('search-results').classList.remove('hidden'); }));
    $('report-period').addEventListener('change', () => $('report-custom').classList.toggle('hidden', $('report-period').value !== 'custom'));
    $('report-generate').addEventListener('click', generateReport);
    $('report-copy').addEventListener('click', () => copyReport().catch(() => { $('report-status').textContent = 'Não foi possível copiar.'; }));
    $('whatsapp-files').addEventListener('change', (event) => importFiles([...event.target.files]).catch(showImportFailure));
    $('history-import-file').addEventListener('change', (event) => {
      historyImportFile = event.target.files?.[0] || null;
      $('history-import-send').disabled = !historyImportFile;
      $('history-import-status').textContent = historyImportFile ? `${historyImportFile.name} pronto para importar.` : '';
    });
    $('history-import-send').addEventListener('click', () => import360History().catch((failure) => {
      $('history-import-status').textContent = failure?.code === 'HISTORY_IMPORT_INVALID' || failure?.message === 'HISTORY_FILE_INVALID' ? 'Este não é o arquivo do histórico do 360dialog para o número configurado.' : 'Não foi possível importar agora. Você pode tentar de novo sem duplicar.';
      $('history-import-send').disabled = !historyImportFile;
    }));
    const zone = $('drop-zone');
    ['dragenter', 'dragover'].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove('dragging'); }));
    zone.addEventListener('drop', (event) => importFiles([...event.dataTransfer.files]).catch(showImportFailure));
    $('manheim-files').addEventListener('change', (event) => importManheim([...event.target.files]).catch(showManheimFailure));
    const manheimZone = $('manheim-drop-zone');
    ['dragenter', 'dragover'].forEach((name) => manheimZone.addEventListener(name, (event) => { event.preventDefault(); manheimZone.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach((name) => manheimZone.addEventListener(name, (event) => { event.preventDefault(); manheimZone.classList.remove('dragging'); }));
    manheimZone.addEventListener('drop', (event) => importManheim([...event.dataTransfer.files]).catch(showManheimFailure));
    $('sms-form').addEventListener('submit', addSms);
    $('sms-contact').addEventListener('change', () => { const fresh=$('sms-contact').value==='new';$('sms-new-name-label').hidden=!fresh;$('sms-new-phone-label').hidden=!fresh;refreshSmsJourneys(); });
    $('auto-print-file').addEventListener('change',()=>{const files=$('auto-print-file').files;if(files.length)showAutoPrintChoice(files);});
    $('auto-print-remove').addEventListener('click',clearAutoPrint);
    $('auto-print-send').addEventListener('click',()=>sendAutoPrint().catch(()=>{}));
    $('sms-date').value = localInput();
    await routeSession();
  }
  boot();
})();
