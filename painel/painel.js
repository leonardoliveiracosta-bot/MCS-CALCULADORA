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
  let contacts = [];
  let chats = [];
  let journeys = [];
  let printReviews = [];
  let failedPrints = [];
  let senderAliases = [];
  let chatAliases = [];
  let todayItems = [];
  let vitrineRequestCount = 0;
  let clientsData = { items: [], pending: { items: [], counts: {} } };
  let todayRefFilter = localStorage.getItem('mcs_today_ref_filter') || 'all';
  let clientsOverdue24=false;
  let pendingSituation = 'all';
  let pendingContinueTimer = null;
  let currentView = 'today';
  let manheimJourneys = [];
  let manheimOrders = [];
  let manheimMatches = [];
  let savedSearchesData = null;
  let reportView = 'today';
  let viewRequestVersion = 0;
  let detailRequestVersion = 0;
  let detailOrigin = null;
  let currentDetail = null;
  const undoTimers = new Map();
  let autoPrintContext = null;
  let historyImportFile = null;
  const $ = (id) => document.getElementById(id);
  const productionHost = location.hostname === 'www.mycarscout.net';
  const environmentBadge = $('environment-badge');
  if (environmentBadge) { environmentBadge.textContent = productionHost ? 'PRODUÇÃO' : 'VERSÃO DE TESTE, NÃO USE PARA TRABALHAR'; environmentBadge.classList.toggle('production', productionHost); }
  const show = (id) => { document.body.classList.toggle('login-screen', id === 'login-view'); ['login-view', 'password-view', 'app-view'].forEach((view) => $(view).classList.toggle('hidden', view !== id)); };
  const error = (id, message) => { $(id).textContent = message || ''; };
  const importFailureMessage = (failure) => {
    const messages = {
      IMPORT_START_FAILED: 'não foi possível criar a conversa no banco',
      IMPORT_BATCH_FAILED: 'não foi possível gravar as mensagens no banco',
      IMPORT_FINISH_FAILED: 'as mensagens foram recebidas, mas a jornada não pôde ser concluída',
      CONTACT_NOT_FOUND: 'o contato escolhido não existe mais',
      CHAT_NOT_FOUND: 'a conversa escolhida não existe mais',
      JOURNEY_CHOICE_REQUIRED: 'escolha a busca antes de confirmar',
      PANEL_ACCESS_DENIED: 'esta conta não tem acesso ao painel',
      AUTHENTICATION_REQUIRED: 'a sessão expirou; entre novamente'
    };
    // M23: local errors (file too big, bad ZIP) carry a readable message and no code
    const local = failure && !failure.code && failure.message && !/^[A-Z0-9_]+$/.test(failure.message) ? failure.message.replace(/\.$/, '') : '';
    const detail = messages[failure && failure.code] || local || 'não foi possível concluir a gravação';
    const saved = importProgress.inserted;
    return saved ? `Falha na importação: ${detail}. ${saved} mensagem(ns) já ficaram gravadas; importe o mesmo arquivo de novo para completar, sem duplicar` : `Falha na importação: ${detail}. Nada foi gravado`;
  };
  const importProgress = { inserted: 0 };
  const showImportFailure = (failure) => {
    const status = $('import-status');
    status.classList.add('error');
    status.textContent = importFailureMessage(failure);
    $('whatsapp-files').value = '';
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
  // Counters: "—" until the first valid answer; zero only when an answer says zero. A failed
  // update keeps the last confirmed number (marked as not updated) and never turns into zero.
  const counterState = new Map();
  const paintCount = (view) => {
    const entry = counterState.get(view);
    const text = window.MCSRefresh ? MCSRefresh.counterText(entry) : (entry && Number.isFinite(entry.value) ? String(entry.value) : '—');
    document.querySelectorAll(`[data-count="${view}"]`).forEach((node) => {
      node.textContent = text;
      node.classList.toggle('count-positive', Boolean(entry && entry.value > 0));
      node.classList.toggle('count-stale', Boolean(entry && entry.stale));
      node.title = entry && entry.stale ? (Number.isFinite(entry.value) ? 'Não foi possível atualizar; mostrando o último valor confirmado' : 'Não foi possível atualizar') : entry && entry.at ? 'Atualizado às ' + new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }).format(entry.at) : '';
    });
  };
  const nextCount = (previous, outcome) => window.MCSRefresh ? MCSRefresh.nextCounter(previous, outcome) : (outcome && outcome.ok ? { value: Number(outcome.value), stale: false, at: Date.now() } : { ...(previous || { value: null }), stale: true });
  const setCount = (view, value) => { const number = Number(value); if (!Number.isFinite(number)) return; counterState.set(view, nextCount(counterState.get(view), { ok: true, value: Math.max(0, number), at: Date.now() })); paintCount(view); };
  const setCountUnknown = (view) => { counterState.set(view, nextCount(counterState.get(view), { ok: false })); paintCount(view); };

  const PAYMENT_LABELS = Object.freeze({ cash: 'À vista', fin: 'Financiado', financing: 'Financiado' });
  const DEADLINE_LABELS = Object.freeze({ none: 'Sem prazo', now: 'Agora', '30d': '30 dias', '3m': '3 meses', '6m': '6 meses', '12m': '12 meses' });
  const SOURCE_LABELS = Object.freeze({ CALCULATOR: 'Calculadora', WHATSAPP_DIRECT: 'WhatsApp direto', SMS_DIRECT: 'SMS direto', MANUAL: 'Manual' });
  const displayPayment = (value) => PAYMENT_LABELS[String(value || '').toLowerCase()] || value || 'Não informado';
  const displayDeadline = (value) => DEADLINE_LABELS[String(value || '').toLowerCase()] || value || 'Sem prazo';
  const displayModel = (value) => String(value || '').replace(/\bnot sure\b/gi, '').replace(/\bother model\b/gi, 'Outro modelo').replace(/\s{2,}/g, ' ').trim();
  const checklistStatusLabel = (status) => status === 'COMPLETE' ? 'OK' : status === 'OPEN' ? 'Pendente' : status === 'NOT_APPLICABLE' ? 'Não se aplica' : status || '';
  const orderIcon = (item) => item.logicalMode === 'VALOR' || (item.logicalModes || []).every((mode) => mode === 'VALOR') ? '💰' : '🚗';


  // Every panel request has a time limit and can be canceled by a newer one (AbortController). A
  // timeout, a network failure or a cancel arrive as a coded error; nothing waits forever.
  const DEFAULT_TIMEOUT_MS = 30000;
  const request = async (path, options = {}) => {
    const { retryAuth: retryOption, timeoutMs, signal: outer, ...fetchOptions } = options;
    const retryAuth = retryOption !== false;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    const forward = () => controller.abort();
    if (outer) { if (outer.aborted) controller.abort(); else outer.addEventListener('abort', forward, { once: true }); }
    const coded = (code, extra) => Object.assign(new Error(code), { code }, extra || {});
    let response, result;
    try {
      try {
        response = await fetch(path, {
          ...fetchOptions, signal: controller.signal,
          headers: { 'content-type': 'application/json', ...(fetchOptions.headers || {}), ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}) }
        });
      } catch (cause) {
        throw coded(timedOut ? 'REQUEST_TIMEOUT' : outer && outer.aborted ? 'REQUEST_ABORTED' : 'NETWORK_ERROR', { cause });
      }
      if (response.status === 401 && retryAuth && refreshToken && await refreshAccessToken()) {
        return request(path, { ...options, retryAuth: false });
      }
      result = await response.json().catch(() => (timedOut ? null : {}));
      if (result === null) throw coded('REQUEST_TIMEOUT');
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', forward);
    }
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/panel/config') {
        stopAutoRefresh();
        clearSession();
        show('login-view');
        error('login-error', 'Sua sessão expirou · Entre novamente para continuar');
      }
      const failure = new Error(result.error || 'REQUEST_FAILED');
      failure.code = result.error || (response.status >= 500 ? 'SERVER_ERROR' : 'REQUEST_FAILED');
      failure.status = response.status;
      failure.requestId = result.requestId || null;
      // A batch the server refused to continue: its id lets the operator discard it.
      if (result.uploadId) failure.uploadId = result.uploadId;
      if (result.reason) failure.reason = result.reason;
      if (Number.isInteger(result.fileIndex)) failure.fileIndex = result.fileIndex;
      if (typeof result.whatsappLink === 'string' && result.whatsappLink.startsWith('https://wa.me/')) failure.whatsappLink = result.whatsappLink;
      throw failure;
    }
    return result;
  };
  // Same GET already running: one request for everyone. A counter can reuse a fresh answer.
  const requestPool = window.MCSRefresh ? MCSRefresh.createRequestPool() : null;
  const sharedGet = (path, ttlMs = 0) => requestPool ? requestPool.get(path, () => request(path), { ttlMs }) : request(path);

  const sha256 = async (value) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
  };

  async function extract(file) {
    if (file.size > (file.name.toLowerCase().endsWith('.zip') ? MAX_ZIP : MAX_TEXT)) throw new Error('Arquivo excede o limite permitido');
    if (!file.name.toLowerCase().endsWith('.zip')) return [{ name: file.name, text: await file.text() }];
    if (!window.zip) throw new Error('Não consegui abrir o arquivo ZIP neste navegador');
    const reader = new zip.ZipReader(new zip.BlobReader(file));
    try {
      const entries = await reader.getEntries();
      if (entries.length > MAX_ENTRIES) throw new Error('O ZIP tem arquivos demais');
      const txt = entries.filter((entry) => !entry.directory && /\.txt$/i.test(entry.filename));
      if (!txt.length) throw new Error('O ZIP não tem a conversa em texto (.txt)');
      const result = [];
      for (const entry of txt) {
        if (entry.encrypted || entry.uncompressedSize > MAX_TEXT) throw new Error('ZIP não atende aos limites de segurança');
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
    chatSelect.replaceChildren(new Option('Nova conversa', 'new'));
    chats.filter((chat) => chat.channel === 'WHATSAPP' && Boolean(chat.is_group) === group && (group || !chosenContact || chosenContact === 'new' || chat.contact_id === chosenContact)).forEach((chat) => option(chatSelect, `${chat.contact && chat.contact.display_name ? chat.contact.display_name : group ? 'Grupo existente' : 'Conversa existente'} · ${chat.channel}`, chat.id));
    journeySelect.replaceChildren(new Option('Escolha', ''));
    option(journeySelect, 'Nova jornada', 'new');
    const ownJourneys = journeys.filter((journey) => chosenContact !== 'new' && journey.contact_id === chosenContact);
    ownJourneys.forEach((journey) => {
      const refs = [journey.reference_code, ...(journey.refs || []).map((item) => item.ref_code)].filter(Boolean).join(', ');
      option(journeySelect, `${journey.vehicle_text || 'Busca sem veículo'}${refs ? ` — Ref ${refs}` : ''}`, journey.id);
    });
    // A17: the person's most recent open ficha comes selected; a new ficha is an explicit choice
    journeySelect.value = ownJourneys[0] ? ownJourneys[0].id : 'new';
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
      $('import-status').textContent = `${filename}: arquivo lido · Confirme os dados abaixo para gravar a conversa`;
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
          if (!$('chat-type').value) throw new Error('Confirme se é conversa individual ou grupo');
          if (!$('mcs-sender').value) throw new Error('Confirme qual remetente é a MCS');
          if ($('mcs-sender').dataset.confirmed === 'false') throw new Error('Confirme com um clique quem é você nesta conversa');
          const contactName = $('import-contact').value === 'new'
            ? MCSParser.clean($('import-contact-name').value)
            : ((contacts.find((item) => item.id === $('import-contact').value) || {}).display_name || inferredContactName(parsed.title));
          if (!isGroup && MCSParser.senderLooksLikeContact($('mcs-sender').value, contactName || inferredContactName(parsed.title))) {
            throw new Error('O remetente da MCS não pode ser o mesmo nome do contato · Revise quem é você');
          }
          if (!isGroup && $('import-contact').value === 'new' && !MCSParser.clean($('import-contact-name').value)) throw new Error('Informe o nome do novo contato');
          if (!isGroup && !$('import-journey').value) throw new Error('Escolha mesma busca ou nova jornada');
          const finalParsed = MCSParser.parseWhatsApp(raw, filename, { dateOrder });
          if (!finalParsed.supported || finalParsed.requiresDateOrder) throw new Error('Não foi possível confirmar as datas');
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
      // Cancel happens before anything is sent to the server: only this file is skipped, nothing
      // is created or changed, and the other files of the same selection go on.
      form.onreset = () => { card.classList.add('hidden'); reject(Object.assign(new Error('IMPORT_CANCELLED'), { code: 'IMPORT_CANCELLED' })); };
    });
  }

  async function submitConversation(raw, filename, sourceKind, sourceFilename, sourceSha) {
    const initial = MCSParser.parseWhatsApp(raw, filename, {});
    if (!initial.supported) {
      await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'review', sourceKind, sourceFilename, sourceSha256: sourceSha }) });
      $('import-status').textContent = `${sourceFilename}: formato não suportado, revisão, sem inserir mensagens`;
      return { pending: true, inserted: 0 };
    }
    const inferredName = inferredContactName(initial.title || filename);
    const automatic = MCSParser.automaticImportMatch(initial, chatAliases, chats, senderAliases, inferredName);
    // C4 residue: a Ref in the file that belongs to someone else sends the file to review
    const foreignRef = automatic && initial.refs.some((ref) => journeys.some((item) => item.contact_id !== automatic.chat.contact_id && (ref === item.reference_code || (item.refs || []).some((stored) => stored.ref_code === ref))));
    const knownChat = automatic && !foreignRef && automatic.chat;
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
      try { choice = await reviewConversation(raw, filename, initial); }
      catch (failure) { if (failure && failure.code === 'IMPORT_CANCELLED') return { cancelled: true, inserted: 0, pending: false }; throw failure; }
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
    let batch = 1;
    // A16: identical messages (same signature) always travel in the same batch, so the server
    // counts them against the webhook copies once, never split across two batches
    const groups = new Map();
    messages.forEach((item) => { if (!groups.has(item.signature_base)) groups.set(item.signature_base, []); groups.get(item.signature_base).push(item); });
    const encoder = new TextEncoder(), sizeOf = (item) => encoder.encode(JSON.stringify(item)).length + 1;
    const chunks = [];
    let current = [], currentBytes = 2;
    for (const group of groups.values()) {
      const groupBytes = group.reduce((total, item) => total + sizeOf(item), 0);
      if (current.length && (current.length + group.length > 500 || currentBytes + groupBytes > 1024 * 1024)) { chunks.push(current); current = []; currentBytes = 2; }
      for (const item of group) {
        const itemBytes = sizeOf(item);
        if (current.length && (current.length >= 500 || currentBytes + itemBytes > 1024 * 1024)) { chunks.push(current); current = []; currentBytes = 2; }
        current.push(item); currentBytes += itemBytes;
      }
    }
    if (current.length) chunks.push(current);
    for (const chunk of chunks) {
      const result = await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'batch', importJobId: start.importJobId, batchNumber: batch++, messages: chunk }) });
      inserted += result.inserted;
      importProgress.inserted += result.inserted;
    }
    const done = await request('/api/panel/entry', { method: 'POST', body: JSON.stringify({ action: 'finish', importJobId: start.importJobId, journey: choice.journey, refs: choice.parsed.refs }) });
    return { inserted, pending: done.pending, journeyId: done.journeyId || null, nothingNew: Boolean(done.nothingNew) };
  }

  async function importFiles(files) {
    importProgress.inserted = 0;
    if (!files.length || files.length > MAX_FILES) throw new Error('Selecione de 1 a 20 arquivos');
    await loadQueue(false);
    let inserted = 0;
    let pending = false;
    let lastJourneyId = null;
    let cancelled = 0;
    for (const file of files) {
      $('import-status').classList.remove('error');
      $('import-status').textContent = `Lendo ${file.name}…`;
      const extracted = await extract(file);
      const sourceSha = await sha256(await file.arrayBuffer());
      for (const item of extracted) {
        const result = await submitConversation(item.text, item.name, file.name.toLowerCase().endsWith('.zip') ? 'WHATSAPP_ZIP' : 'WHATSAPP_TXT', file.name, sourceSha);
        if (result.cancelled) { cancelled += 1; continue; }
        inserted += result.inserted;
        pending = pending || result.pending;
        lastJourneyId = result.journeyId || lastJourneyId;
      }
    }
    $('import-status').classList.remove('error');
    $('whatsapp-files').value = '';
    $('import-status').textContent = !inserted && !pending ? 'Nenhuma mensagem nova, a conversa já estava no painel' : `${inserted} mensagem(ns) nova(s). ${pending ? 'Há uma dúvida real para revisar.' : 'Importação concluída.'}`;
    if (cancelled) $('import-status').textContent = !inserted && !pending ? `${cancelled} arquivo(s) cancelado(s), nada foi gravado` : `${$('import-status').textContent} · ${cancelled} arquivo(s) cancelado(s), nada foi gravado deles`;
    await loadQueue();
    await refreshCounters().catch(() => {});
    if (!pending && lastJourneyId) await openDetail('ficha',lastJourneyId);
  }

  function clearRecordDetail(message = 'Escolha uma ficha') {
    const root = $('record-detail');
    if (root) root.replaceChildren(element('p', 'muted', message));
  }

  function renderLoading(view) {
    const roots = { today: 'today-list', entry: 'entry-queue', clients: 'clients-list', pending: 'pending-list', qualification: 'qualification-list', requests: 'requests-list', searches: 'manheim-summary', imports: 'manheim-batches', manheim: 'manheim-summary', records: 'records-list' };
    if (roots[view] && $(roots[view])) empty($(roots[view]), 'Carregando…');
  }

  async function switchPanel(view) {
    // Lote 4: PEDIDOS is part of ENTRADA and CLIENTES now; an old link or history entry opens ENTRADA.
    if (view === 'orders') view = 'entry';
    if (!['today', 'entry', 'clients', 'requests', 'searches', 'imports'].includes(view)) return;
    if (view !== 'pending') clearTimeout(pendingContinueTimer);
    currentView = view;
    $('search-results')?.classList.add('hidden');
    const requestVersion = ++viewRequestVersion;
    clearRecordDetail();
    const labels = { today: 'HOJE', entry: 'ENTRADA', clients: 'CLIENTES', requests: 'PESQUISAS', searches: 'OPÇÕES', imports: 'IMPORTAÇÕES' };
    currentDetail = null;
    if ($('detail-panel')) $('detail-panel').classList.add('hidden');
    ['today','entry','clients','requests','searches','imports','pending','qualification','manheim','records'].forEach((name) => $(name + '-panel')?.classList.toggle('hidden', name !== view));
    $('page-title').textContent = labels[view];
    document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
    renderLoading(view);
    try { await loadCurrent(view, requestVersion); } catch (failure) {
      console.error(failure);
      if (currentView === view && viewRequestVersion === requestVersion) renderFailure(view);
    }
  }

  // A18: a print that only matches a lead by name waits for the operator
  // A print kept but never saved to a lead (the reading failed, or the save did not happen). The
  // same actions of the automatic flow: read again, save with the automatic rules, or discard.
  function failedPrintCard(print) {
    const item = element('article', 'queue-item failed-print');
    const header = element('header', '');
    header.append(element('strong', '', `Print não guardado · ${print.name || print.phone || print.filename || 'sem nome'}`), element('span', 'badge', 'revisão'));
    item.append(header, element('span', 'muted', print.errorCode ? 'Não consegui ler este print' : print.justRead ? 'Print lido agora · confira os dados e guarde' : 'O print foi lido, mas não foi guardado em nenhum lead'));
    if (print.phone) item.append(element('span', 'muted', `Telefone do print: ${print.phone}`));
    if (print.message) item.append(element('p', '', print.message.length > 280 ? `${print.message.slice(0, 280)}…` : print.message));
    let phoneInput = null;
    if (print.message && !print.phone) { const label = element('label', '', 'Telefone do cliente (o print não mostra)'); phoneInput = element('input'); phoneInput.type = 'tel'; phoneInput.inputMode = 'tel'; phoneInput.placeholder = '+1 305 555 0000'; label.append(phoneInput); item.append(label); }
    const actions = element('div', 'inline-actions');
    const post = (body) => request('/api/panel/sms-print', { method: 'POST', body: JSON.stringify({ readId: print.id, ...body }) });
    if (print.errorCode) {
      const retry = element('button', 'small', 'Tentar ler de novo'); retry.type = 'button';
      // A successful read shows the values right here for Guardar pelo painel: nothing is saved on its own,
      // and the card does not vanish while the fresh read is still inside the 30-minute window.
      MCSAction.bind(retry, () => ({ scope: item, commit: async () => {
        const result = await post({ action: 'retry' });
        if (result.manual || !result.read) throw Object.assign(new Error('SMS_PRINT_READ_FAILED'), { code: 'SMS_PRINT_READ_FAILED' });
        const values = result.read.extracted_json || {};
        item.replaceWith(failedPrintCard({ ...print, errorCode: null, name: String(values.name || '').trim() || null, phone: values.phone || null, ref: values.ref || null, message: values.message || '', translation: values.translation || '', justRead: true }));
        return result;
      }, successScope: document.body, successText: 'Print lido · confira e use Guardar pelo painel', errorText: 'Ainda não consegui ler, tente mais tarde' }));
      actions.append(retry);
    }
    if (print.message || print.phone || print.ref) {
      const save = element('button', print.errorCode ? 'quiet small' : 'small', 'Guardar pelo painel'); save.type = 'button';
      MCSAction.bind(save, () => {
        const values = { phone: print.phone || phoneInput?.value.trim() || '', name: print.name || '', ref: print.ref || '', message: print.message || '', translation: print.translation || '' };
        return { scope: item, commit: () => post({ action: 'confirm', auto: true, ...values }), successText: 'Print guardado', refresh: () => loadQueue(), errorText: (error) => error?.code === 'SMS_PRINT_VALUES_INVALID' ? 'Digite o telefone do cliente antes de guardar' : 'Não consegui guardar, tente de novo' };
      });
      actions.append(save);
    }
    const discard = element('button', 'quiet small', 'Descartar print'); discard.type = 'button';
    MCSAction.bind(discard, () => ({ scope: item, successScope: document.body, optimistic: () => { item.classList.add('action-optimistic-hidden'); const before = countValue('entry'); setCount('entry', Math.max(0, before - 1)); return before; },
      commit: () => post({ action: 'discard' }), rollback: (before) => { item.classList.remove('action-optimistic-hidden'); setCount('entry', before); }, successText: 'Print descartado', refresh: () => loadQueue(), errorText: 'Não consegui descartar, tente de novo' }));
    actions.append(discard);
    item.append(actions);
    return item;
  }
  function printReviewCard(print) {
    const item = element('article', 'queue-item');
    const header = element('header', '');
    header.append(element('strong', '', `Print de SMS · ${print.name || print.phone || print.filename || 'sem nome'}`), element('span', 'badge', 'revisão'));
    item.append(header, element('span', 'muted', print.candidate ? `O nome bate com ${print.candidate.name}${print.candidate.ref ? ` · Ref ${print.candidate.ref}` : ''}, mas o telefone não` : 'O nome bate com um lead encerrado · Para guardar nele, reabra a ficha e anexe o print lá'));
    if (print.phone) item.append(element('span', 'muted', `Telefone do print: ${print.phone}`));
    // The confirm needs the customer's phone: when the print shows none, the operator types it
    let phoneInput = null;
    if (!print.phone && print.message) { const label = element('label', '', 'Telefone do cliente (o print não mostra)'); phoneInput = element('input'); phoneInput.type = 'tel'; phoneInput.inputMode = 'tel'; phoneInput.placeholder = '+1 305 555 0000'; label.append(phoneInput); item.append(label); }
    if (print.message) item.append(element('p', '', print.message.length > 280 ? `${print.message.slice(0, 280)}…` : print.message));
    const actions = element('div', 'inline-actions');
    const values = () => ({ phone: print.phone || phoneInput?.value.trim() || '', name: print.name || '', ref: print.ref || '', message: print.message || '', translation: print.translation || '' });
    const run = (button, bodyFor, successText) => MCSAction.bind(button, () => {
      const body = typeof bodyFor === 'function' ? bodyFor() : bodyFor;
      if (body.action === 'confirm' && !body.phone) return { scope: item, commit: () => Promise.reject(new Error('PHONE_REQUIRED')), errorText: 'Digite o telefone do cliente antes de salvar' };
      return {
      scope: item, successScope: document.body,
      optimistic: () => { item.classList.add('action-optimistic-hidden'); const before = countValue('entry'); setCount('entry', Math.max(0, before - 1)); return before; },
      commit: () => request('/api/panel/sms-print', { method: 'POST', body: JSON.stringify({ readId: print.id, ...body }) }),
      rollback: (before) => { item.classList.remove('action-optimistic-hidden'); setCount('entry', before); },
      successText, refresh: () => loadQueue(), errorText: 'Não consegui salvar, tente de novo'
    }; });
    if (print.candidate) {
      const keep = element('button', 'small', `Guardar em ${print.candidate.name}`); keep.type = 'button';
      run(keep, () => print.message ? { action: 'confirm', targetJourneyId: print.candidate.journeyId, keepSource: true, ...values() } : { action: 'photo', targetJourneyId: print.candidate.journeyId }, 'Print guardado no lead');
      actions.append(keep);
    }
    if (print.message) {
      const create = element('button', 'quiet small', 'Criar lead novo'); create.type = 'button';
      run(create, () => ({ action: 'confirm', auto: true, newLead: true, ...values() }), 'Lead novo criado com o print');
      actions.append(create);
    }
    const discard = element('button', 'quiet small', 'Descartar print'); discard.type = 'button';
    run(discard, { action: 'discard' }, 'Print descartado');
    actions.append(discard);
    item.append(actions);
    return item;
  }

  function renderQueue(items, reviews) {
    items=clientSort(items,$('entry-sort')?.value||'recent');
    const root = $('entry-queue');
    root.replaceChildren();
    printReviews.forEach((print) => root.append(printReviewCard(print)));
    failedPrints.forEach((print) => root.append(failedPrintCard(print)));
    if (!items.length && !reviews.length) {
      if (printReviews.length || failedPrints.length) return;
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'Nenhuma conversa importada';
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
        undo:{commit:(result)=>request('/api/panel/entry',{method:'POST',body:JSON.stringify({action:'review_undo',undo:result.undo})}),successText:'A conversa voltou para revisão',refresh:()=>loadQueue()},
        refresh:()=>loadQueue(false),errorText:'Não consegui salvar, tente de novo'
      }));
      const link=element('button','small','Ligar a um lead');link.type='button';
      MCSAction.bind(link,()=>{
        if(!select.value)return{scope:item,commit:()=>Promise.reject(new Error('JOURNEY_REQUIRED')),errorText:'Escolha um lead antes de ligar'};
        return{scope:item,successScope:document.body,feedbackKey:`entry:${kind}:${target.id}`,optimistic:()=>{item.classList.add('action-optimistic-hidden');const before=countValue('entry');setCount('entry',Math.max(0,before-1));return before;},commit:()=>request('/api/panel/entry',{method:'POST',body:JSON.stringify({action:'review_link',kind,id:target.id,journeyId:select.value})}),rollback:(before)=>{item.classList.remove('action-optimistic-hidden');setCount('entry',before);},successText:'Conversa ligada ao lead',undo:{commit:(result)=>request('/api/panel/entry',{method:'POST',body:JSON.stringify({action:'review_undo',undo:result.undo})}),successText:'A conversa voltou para revisão',refresh:()=>loadQueue()},refresh:()=>loadQueue(false),errorText:'Não consegui salvar, tente de novo'};
      });
      const create=element('button','quiet small','Criar lead novo');create.type='button';run(create,'review_create','Lead criado e conversa ligada');
      const dismiss=element('button','quiet small','Dispensar (não é cliente)');dismiss.type='button';run(dismiss,'review_dismiss','Conversa dispensada');
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
      badge.textContent = chat.is_group ? 'revisão, grupo' : chat.resolution_status === 'RESOLVED' ? 'lida' : chat.resolution_status === 'UNIDENTIFIED' ? 'não identificada' : 'revisão';
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
        MCSAction.bind(keep,()=>({scope:item,optimistic:()=>{const before=badge.textContent;badge.textContent='revisão';return before;},commit:()=>request('/api/panel/entry',{method:'POST',body:JSON.stringify({action:'resolve',chatId:chat.id,resolution:'review'})}),rollback:(before)=>{badge.textContent=before;},refresh:()=>loadQueue(),errorText:'Não consegui salvar, tente de novo'}));
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
      note.textContent = 'revisão, formato não suportado, manter em revisão';
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

  // Triagem da ENTRADA: REVISAR fica em "Precisa de você"; o que saiu do funil fica recolhido,
  // sempre com a categoria, o motivo curto, a correção manual e o desfazer.
  // ENTRADA badge = conversations waiting in the queue + triage items in REVISAR; both sources update it.
  let entryQueueCount=null,triageReviewCount=0;
  const renderEntryCount=()=>{if(entryQueueCount!==null)setCount('entry',entryQueueCount+triageReviewCount);};
  const TRIAGE_OPTIONS=[['PRE_COMPRA_MCS','Pré-compra MCS'],['POS_VENDA','Pós-venda'],['PESSOAL','Pessoal'],['OUTRO_NEGOCIO','Outro negócio'],['NAO_CLIENTE','Não é cliente'],['REVISAR','Manter pendente']];
  function triageCard(item,refresh){
    const row=element('div','queue-item triage-item');row.dataset.triageId=item.id;
    const head=element('div','triage-head');head.append(element('strong','',item.name),makeBadge(item.label,item.decision==='FORA_DO_FUNIL'?'':item.decision==='PENDENTE'?'yellow':'green'));row.append(head);
    const who=item.source==='MANUAL'?'Decisão manual':'IA';
    const why=item.errorCode?'Leitura automática falhou, decida manualmente':item.reason&&item.reason!==who?`${who} · ${item.reason}`:who;
    row.append(element('p','muted triage-reason',why));
    (item.evidence||[]).forEach((quote)=>row.append(element('p','evidence',quote)));
    const actions=element('div','inline-actions');
    // Every manual decision offers "Desfazer" right away (a pre-compra card leaves both lists).
    const undoLast={commit:(result)=>request('/api/panel/triage',{method:'POST',body:JSON.stringify({action:'undo',triageId:result.id})}),successText:'Decisão desfeita',refresh};
    const apply=(category,button)=>MCSAction.bind(button,()=>({scope:row,successScope:document.body,optimistic:()=>{row.classList.add('action-optimistic-hidden');},commit:()=>request('/api/panel/triage',{method:'POST',body:JSON.stringify({action:'set',chatId:item.chatId,category})}),rollback:()=>{row.classList.remove('action-optimistic-hidden');},successText:'Classificação salva',undo:undoLast,refresh,errorText:'Não consegui salvar, tente de novo'}));
    if(item.decision!=='FUNIL'){const funnel=element('button','small','É pré-compra');funnel.type='button';apply('PRE_COMPRA_MCS',funnel);actions.append(funnel);}
    const choose=element('select','triage-choice');choose.setAttribute('aria-label','Corrigir a classificação');TRIAGE_OPTIONS.filter(([value])=>value!==item.category&&(item.decision==='FUNIL'||value!=='PRE_COMPRA_MCS')).forEach(([value,label])=>choose.append(new Option(label,value)));
    const fix=element('button','quiet small','Corrigir');fix.type='button';MCSAction.bind(fix,()=>({scope:row,successScope:document.body,optimistic:()=>{row.classList.add('action-optimistic-hidden');},commit:()=>request('/api/panel/triage',{method:'POST',body:JSON.stringify({action:'set',chatId:item.chatId,category:choose.value})}),rollback:()=>{row.classList.remove('action-optimistic-hidden');},successText:'Classificação salva',undo:undoLast,refresh,errorText:'Não consegui salvar, tente de novo'}));
    actions.append(choose,fix);
    if(item.source==='MANUAL'){const back=element('button','quiet small','Desfazer');back.type='button';MCSAction.bind(back,()=>({scope:row,commit:()=>request('/api/panel/triage',{method:'POST',body:JSON.stringify({action:'undo',triageId:item.id})}),refresh,errorText:'Não consegui desfazer, tente de novo'}));actions.append(back);}
    if(item.journeyId){const open=element('button','quiet small','Abrir ficha');open.type='button';open.addEventListener('click',()=>openDetail('ficha',item.journeyId));actions.append(open);}
    row.append(actions);return row;
  }
  async function loadTriage(){
    const data=await request('/api/panel/triage').catch(()=>null);
    const review=$('triage-review'),out=$('triage-out-list');review.replaceChildren();out.replaceChildren();
    if(!data){$('triage-state').textContent='';$('triage-out-count').textContent='0';triageReviewCount=0;renderEntryCount();return {review:[],out:[]};}
    triageReviewCount=(data.review||[]).length;renderEntryCount();
    const refresh=()=>Promise.all([loadTriage(),loadWhatsApp()]).then(()=>refreshCounters().catch(()=>{}));
    (data.review||[]).forEach((item)=>review.append(triageCard(item,refresh)));
    (data.out||[]).forEach((item)=>out.append(triageCard(item,refresh)));
    if(!(data.out||[]).length)out.append(element('p','muted','Nenhuma conversa fora do funil'));
    $('triage-out-count').textContent=String((data.out||[]).length);
    $('triage-state').textContent=data.state==='LIGADA'?'':'Triagem automática desligada: as conversas novas seguem o fluxo normal';
    $('triage-run-pending').classList.toggle('hidden',data.state!=='LIGADA');
    $('entry-needs-empty').classList.toggle('hidden',Boolean($('whatsapp-errors').childElementCount||$('whatsapp-suggestions').childElementCount||review.childElementCount));
    return data;
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
      MCSAction.bind(retry,()=>({scope:row,optimistic:()=>{retry.textContent='Reprocessando…';},commit:()=>request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:'reprocess',id:event.id})}),rollback:()=>{retry.textContent='Reprocessar';},refresh:()=>loadWhatsApp(),errorText:'Não consegui salvar, tente de novo'}));
      row.append(retry); errors.append(row);
    });
    (data.ignored||[]).forEach((event)=>errors.append(element('div','queue-item',`ignorado: ${String(event.error_code||event.event_type||'campo desconhecido').replace(/^IGNORED:/,'')}`)));
    const itemErrorLabel=(code)=>({HISTORY_DECLINED:'Histórico não compartilhado pelo WhatsApp',PHONE_INVALID:'Telefone inválido',PHONE_AMBIGUOUS:'Telefone ligado a mais de um contato',MESSAGE_CONTENT_INVALID:'Mensagem inválida',ITEM_PROCESSING_FAILED:'Falha ao gravar a mensagem',PROCESSING_INTERRUPTED:'Processamento interrompido'})[code]||'Falha ao processar este item';
    (data.itemErrors||[]).forEach((event)=>{const row=element('div','queue-item');row.append(element('span','',`Item ${event.item_index+1}: ${itemErrorLabel(event.error_code)}`));const declined=event.error_code==='HISTORY_DECLINED';const retry=element('button','small',declined?'Dispensar':'Tentar de novo');retry.type='button';retry.disabled=event.status==='PROCESSING';MCSAction.bind(retry,()=>({scope:row,optimistic:()=>{retry.textContent=declined?'Dispensando…':'Processando…';},commit:()=>request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:declined?'dismiss_item':'reprocess_item',id:event.id})}),rollback:()=>{retry.textContent=declined?'Dispensar':'Tentar de novo';},refresh:()=>Promise.all([loadWhatsApp(),loadQueue()]),errorText:'Não consegui salvar, tente de novo'}));row.append(retry);errors.append(row);});
    const suggestions = $('whatsapp-suggestions'); suggestions.replaceChildren();
    (data.suggestions || []).forEach((item) => {
      const row = element('div', 'queue-item');
      row.append(element('strong', '', item.target_ref?`Esta conversa do WhatsApp (${item.phone_e164}) parece ser Ref ${item.target_ref}`:`Esta conversa do WhatsApp (${item.phone_e164}) parece ser a ficha ${item.targetName || 'sem nome'} — ${item.sourceName || 'novo contato'}`));
      if(item.motives)row.append(element('span','muted',`Motivos: ${item.motives}`));
      for (const [label, link] of [['Ligar', true], ['Não é', false]]) {
        const action = element('button', link ? 'small' : 'quiet small', label); action.type = 'button';
        MCSAction.bind(action,()=>({scope:row,optimistic:()=>{row.classList.add('action-optimistic-hidden');},commit:()=>request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:'suggestion',id:item.id,link})}),rollback:()=>{row.classList.remove('action-optimistic-hidden');},refresh:()=>Promise.all([loadWhatsApp(),loadQueue()]),errorText:'Não consegui salvar, tente de novo'}));
        row.append(action);
      }
      const notLead=element('button','quiet small',item.sourceIsLead===false?'Restaurar lead':'Não é lead');notLead.type='button';MCSAction.bind(notLead,()=>{const before=item.sourceIsLead!==false;return{scope:row,optimistic:()=>{item.sourceIsLead=!before;notLead.textContent=item.sourceIsLead?'Não é lead':'Restaurar lead';return before;},commit:()=>request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:'contact_lead',contactId:item.source_contact_id,isLead:!before})}),rollback:(value)=>{item.sourceIsLead=value;notLead.textContent=value?'Não é lead':'Restaurar lead';},refresh:()=>Promise.all([loadWhatsApp(),loadQueue()]),errorText:'Não consegui salvar, tente de novo'};});row.append(notLead);
      suggestions.append(row);
    });
    (data.phoneReviews||[]).forEach((item)=>{const row=element('div','queue-item');row.append(element('strong','',`O telefone ${item.phone_e164} está em mais de um contato. Escolha o correto:`));(item.candidates||[]).forEach((candidate)=>{const group=element('span','inline-actions');const choose=element('button','small',candidate.name);choose.type='button';MCSAction.bind(choose,()=>({scope:row,optimistic:()=>{row.classList.add('action-optimistic-hidden');},commit:()=>request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:'phone_review',id:item.id,contactId:candidate.id})}),rollback:()=>{row.classList.remove('action-optimistic-hidden');},refresh:()=>Promise.all([loadWhatsApp(),loadQueue()]),errorText:'Não consegui salvar, tente de novo'}));const lead=element('button','quiet small',candidate.isLead===false?'Restaurar':'Não é lead');lead.type='button';MCSAction.bind(lead,()=>{const before=candidate.isLead!==false;return{scope:row,optimistic:()=>{candidate.isLead=!before;lead.textContent=candidate.isLead?'Não é lead':'Restaurar';return before;},commit:()=>request('/api/panel/whatsapp',{method:'POST',body:JSON.stringify({action:'contact_lead',contactId:candidate.id,isLead:!before})}),rollback:(value)=>{candidate.isLead=value;lead.textContent=value?'Não é lead':'Restaurar';},refresh:()=>Promise.all([loadWhatsApp(),loadQueue()]),errorText:'Não consegui salvar, tente de novo'};});group.append(choose,lead);row.append(group);});suggestions.append(row);});
    $('entry-needs-empty').classList.toggle('hidden', Boolean(errors.childElementCount || suggestions.childElementCount || $('triage-review').childElementCount));
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
    Object.defineProperty(batches, 'skipped', { value: 0, writable: true, enumerable: false });
    for (const item of ordered) {
      const itemBytes = encoder.encode(JSON.stringify(item)).length;
      // P19.3: an item above the server limit is skipped and reported, the rest of the file still goes
      if (itemBytes > 800000) { batches.skipped++; continue; }
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
    if (historyImportFile.size > 100 * 1024 * 1024) throw new Error('HISTORY_FILE_TOO_LARGE');
    let entries;
    try { entries = JSON.parse(await historyImportFile.text()); } catch (_) { throw new Error('HISTORY_FILE_INVALID'); }
    if (!Array.isArray(entries) || !entries.length || !entries.every(validHistoryObject)) throw new Error('HISTORY_FILE_INVALID');
    const states = entries.filter((entry) => entry.event === 'smb_app_state_sync');
    const histories = entries.filter((entry) => entry.event === 'history' && Array.isArray(entry.data.history)).flatMap(historyParts).sort((left, right) => historyOrder(left)[0] - historyOrder(right)[0] || historyOrder(left)[1] - historyOrder(right)[1] || historyPartNumber(left) - historyPartNumber(right));
    const mediaHistories = entries.filter((entry) => entry.event === 'history' && !Array.isArray(entry.data.history)).sort((left, right) => mediaHistoryOrder(left) - mediaHistoryOrder(right));
    const ordered = states.concat(histories, mediaHistories), totals = { conversations: 0, imported: 0, alreadyExists: 0, errors: 0 };
    errors.replaceChildren(); sendButton.disabled = true;
    let completed = 0;
    const threads = new Set(), batches = historyBatches(ordered);
    totals.errors += batches.skipped; completed += batches.skipped;
    for (const originalBatch of batches) {
      let batch = originalBatch, attempts = 0;
      while (batch.length) {
        status.textContent = `Importando ${Math.min(completed, ordered.length)} de ${ordered.length}…`;
        const result = await requestHistoryBatch(batch, request, pause);
        (result.threadIds || []).forEach((id) => threads.add(id)); totals.imported += Number(result.imported || 0); totals.alreadyExists += Number(result.alreadyExists || 0); totals.errors += Number(result.errors || 0);
        if (result.more) { const processed = Math.max(1, Number(result.nextIndex || 1)); completed += Math.min(processed, batch.length); batch = batch.slice(processed); continue; }
        if (result.inProgress && attempts++ < 8) { await pause(1000); continue; }
        if (result.inProgress) totals.errors += batch.length;
        completed += batch.length;
        break;
      }
      status.textContent = `Importando ${Math.min(completed, ordered.length)} de ${ordered.length}…`;
    }
    totals.conversations = threads.size;
    const summary = `Importado: ${totals.conversations} conversas, ${totals.imported} mensagens novas, ${totals.alreadyExists} já existiam, ${totals.errors} com erro${batches.skipped ? ` (${batches.skipped} grande(s) demais, pulado(s))` : ''}`;
    status.textContent = summary;
    if (totals.errors) { const viewErrors = element('button', 'quiet small', 'ver erros'); viewErrors.type = 'button'; viewErrors.addEventListener('click', () => loadWhatsApp().catch(() => {})); errors.append(viewErrors); }
    historyImportFile = null; $('history-import-file').value = ''; sendButton.disabled = true;
    await Promise.all([loadWhatsApp(), loadQueue(false)]);
    await refreshCounters().catch(() => {});
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
    printReviews = data.printReviews || [];
    failedPrints = data.failedPrints || [];
    entryQueueCount = chats.filter((chat) => !chat.triageOut && (chat.resolution_status !== 'RESOLVED' || chat.hasTimeUncertain)).length + (data.reviews || []).length + printReviews.length + failedPrints.length;
    renderEntryCount();
    if (render) renderQueue(chats.filter((chat) => !chat.triageOut), data.reviews || []);
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
    if (!message || !localInput || (selected === 'new' && (!name||!phone))) {$('sms-status').textContent='Informe nome e telefone para o novo contato';return;}
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
    },onSuccess:({batch,date})=>{$('sms-status').textContent=`${batch.inserted} SMS adicionado(s)${date.timeUncertain?', hora incerta, revisão necessária':''}`;$('sms-text').value='';},refresh:()=>loadQueue(),onError:()=>{$('sms-status').classList.add('error');},errorText:'Não consegui salvar, tente de novo'});
  }

  function clearAutoPrint(){const input=$('auto-print-file');input.value='';autoPrintContext=null;$('auto-print-file-info').replaceChildren();$('auto-print-file-info').classList.add('hidden');$('auto-print-remove').classList.add('hidden');$('auto-print-send').disabled=true;$('auto-print-result').classList.add('hidden');}
  function showAutoPrintChoice(files){const info=$('auto-print-file-info');info.replaceChildren();[...files].forEach((file)=>info.append(element('span','',file.name),element('small','muted',`${(file.size/1024/1024).toFixed(1)} MB`)));info.classList.remove('hidden');$('auto-print-remove').classList.remove('hidden');$('auto-print-send').disabled=!files.length;}
  function autoPrintResult(filename,text,saved){const resultRoot=arguments[3],root=resultRoot||$('auto-print-result');root.classList.remove('hidden');const row=element('section',saved?'':'error');row.append(element('strong',saved?'':'warning',`${filename||'Print'} — ${text}`));root.append(row);return row;}
  async function saveAutoPrint(read,context,filename=read.original_filename,resultRoot){const values=read.extracted_json||{},hint=values.ref||context?.ref||'';const saved=await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'confirm',auto:true,readId:read.id,sourceJourneyId:context?.journeyId||null,phone:values.phone||'',name:values.name||'',ref:hint,message:values.message||'',translation:values.translation||''})});if(saved.review){autoPrintResult(filename,'O nome bate com um lead, mas o telefone não. Ficou em ENTRADA para você decidir',false,resultRoot);await loadQueue(currentView==='entry').catch(()=>{});return saved;}const name=saved.name||saved.phone||(saved.ref?`Pedido ${saved.ref}`:'lead novo');if(!saved.duplicate)[saved.journeyId,context?.journeyId].filter(Boolean).forEach((key)=>recentPrints.set(key,{readId:read.id,text:`✓ ${saved.photoOnly?'Foto guardada':'Guardado'} no lead de ${name} · Ref ${saved.ref||hint||'—'}`,at:Date.now()}));const root=autoPrintResult(filename,saved.duplicate?`Este print já foi guardado no lead de ${name} · Ref ${saved.ref||hint||'—'}`:`✓ ${saved.photoOnly?'Foto guardada':'Guardado'} no lead de ${name} · Ref ${saved.ref||hint||'—'}`,true,resultRoot);const actions=element('div','inline-actions');const open=element('button','small','Abrir lead');open.type='button';open.addEventListener('click',()=>openDetail('ficha',saved.journeyId));actions.append(open);if(!saved.duplicate){const undo=element('button','quiet small','Desfazer');undo.type='button';MCSAction.bind(undo,()=>({scope:root,commit:()=>request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'undo',readId:read.id})}),successText:`${filename||'Print'} · Desfeito · O arquivo permanece guardado`,errorText:'Não consegui desfazer, tente de novo',onSuccess:()=>root.querySelector('strong')?.remove()}));actions.append(undo);}root.append(actions);await refreshCounters().catch(()=>{});return saved;}
  async function handleAutoPrintRead(result,context,filename,resultRoot){if(result.manual){const root=autoPrintResult(filename||result.read?.original_filename,'Não consegui ler agora, tente mais tarde ou use outra imagem',false,resultRoot);const retry=element('button','quiet small','Tentar de novo');retry.type='button';MCSAction.bind(retry,()=>({scope:root,commit:()=>request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'retry',readId:result.read.id})}),onSuccess:(next)=>handleAutoPrintRead(next,context,filename,resultRoot),errorText:'Não consegui ler agora, tente de novo'}));root.append(retry);return false;}return saveAutoPrint(result.read,context,filename,resultRoot);}
  async function uploadAutoPrint(file,context={},resultRoot){const head=new Uint8Array(await file.slice(0,64).arrayBuffer());const signed=await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'sign',filename:file.name,mimeType:file.type,byteSize:file.size,magicBase64:btoa(String.fromCharCode(...head)),journeyId:context.journeyId||null,contactId:context.contactId||null})});const uploadUrl=new URL(signed.uploadUrl);uploadUrl.searchParams.set('token',signed.token);const uploaded=await fetch(uploadUrl.toString(),{method:'PUT',headers:{'content-type':file.type,'x-upsert':'false'},body:file});if(!uploaded.ok)throw Error('UPLOAD_FAILED');return handleAutoPrintRead(await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'read',readId:signed.readId})}),context,file.name,resultRoot);}
  function printErrorText(error){return {SMS_PRINT_TOO_LARGE:'A imagem passa de 5 MB. Tire um print novo ou reduza a imagem',SMS_PRINT_HEIC:'Foto HEIC do iPhone não é aceita · Use um print da tela (PNG) ou exporte como JPEG',SMS_PRINT_INVALID_IMAGE:'Use uma imagem JPEG, PNG ou WebP de até 5 MB'}[error?.code]||'Não consegui enviar agora · O arquivo não foi apagado';}
  async function sendAutoPrint(){const files=[...$('auto-print-file').files];if(!files.length)return;const status=$('auto-print-status'),result=$('auto-print-result');let failures=0;status.classList.remove('error');result.replaceChildren();result.classList.remove('hidden');$('auto-print-send').disabled=true;for(let index=0;index<files.length;index++){const file=files[index];status.textContent=`${index+1} de ${files.length}…`;try{if(await uploadAutoPrint(file,autoPrintContext||{})===false)failures++;}catch(error){failures++;autoPrintResult(file.name,printErrorText(error),false);}}$('auto-print-file').value='';$('auto-print-file-info').replaceChildren();$('auto-print-file-info').classList.add('hidden');$('auto-print-remove').classList.add('hidden');$('auto-print-send').disabled=true;autoPrintContext=null;status.textContent=`${files.length} de ${files.length} prontos${failures?` · ${failures} com erro`:''}`;}

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
      root.append(element('p','muted',`Aguardando o histórico terminar de chegar (última parte há ${pendingAgo(data.lastHistoryAt)})`));
      const button=element('button','quiet small','Fazer leitura geral');button.type='button';button.disabled=true;root.append(button);return;
    }
    const total=Number(run.total_conversations||0),completed=Number(run.completed_conversations||0),spent=Number(run.spent_usd||0),budget=Number(run.budget_usd||20);
    if(run.status==='IDLE'||!run.status){
      root.append(element('p','muted','Lê todas as conversas, das mais recentes às mais antigas, inclusive conversas longas em partes'));
      const start=element('button','small','Fazer leitura geral');start.type='button';MCSAction.bind(start,()=>({scope:root,commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'start_general'})}),onSuccess:()=>continuePendingGeneral(),errorText:'IA indisponível, tente de novo'}));root.append(start);return;
    }
    const status=limited?'limite atingido':paused?'pausada':run.status==='COMPLETED'?'concluída':'em andamento';
    root.append(element('p','',`Leitura geral ${status}`));
    if (paused && run.last_error) root.append(element('p','error',run.last_error==='IA_UNAVAILABLE'?'IA indisponível · O painel continua disponível para uso manual':'A leitura foi pausada; tente continuar novamente'));
    const bar=element('div','pending-bar'),fill=element('i');fill.style.width=`${total?Math.min(100,completed/total*100):100}%`;bar.append(fill);root.append(bar);
    root.append(element('p','muted',`${completed} de ${total} conversas lidas · gasto US$ ${spent.toFixed(2)} de US$ ${budget.toFixed(2)} · conversas longas são lidas em partes, até o fim`));
    const actions=element('div','inline-actions');
    if(active){const pause=element('button','quiet small','Pausar');pause.type='button';MCSAction.bind(pause,()=>({scope:root,optimistic:()=>{pause.textContent='Pausando…';},commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'pause_general'})}),rollback:()=>{pause.textContent='Pausar';},onSuccess:()=>currentView==='clients'?loadClients():loadPending(),errorText:'Não consegui salvar, tente de novo'}));actions.append(pause);}
    if(paused){const resume=element('button','small','Continuar');resume.type='button';MCSAction.bind(resume,()=>({scope:root,optimistic:()=>{resume.textContent='Continuando…';},commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'resume_general'})}),rollback:()=>{resume.textContent='Continuar';},onSuccess:()=>continuePendingGeneral(),errorText:'Não consegui salvar, tente de novo'}));actions.append(resume);}
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
        MCSAction.bind(approve,()=>({scope:confirmation,optimistic:()=>{cancel.disabled=true;},commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'increase_budget',confirm:true})}),rollback:()=>{cancel.disabled=false;},onSuccess:()=>{confirmation.remove();continuePendingGeneral();},errorText:'Não consegui salvar, tente de novo'}));
        root.append(confirmation);
      });actions.append(more);
    }
    root.append(actions);
  }
  function renderPending(data) {
    clearTimeout(pendingContinueTimer);renderPendingGeneral(data);setCount('pending',Object.values(data.counts||{}).reduce((total,value)=>total+Number(value||0),0));
    const stats=$('pending-stats');stats.replaceChildren();[['NO_RESPONSE','🔴 Sem resposta'],['MCS_PENDING','🟠 Parada com você'],['CUSTOMER_PENDING','🟡 Parada com o cliente'],['IN_PROGRESS','🟢 Em andamento'],['CLOSED','⚪ Concluída / sem interesse']].forEach(([key,label])=>{const stat=element('div','pending-stat');stat.append(element('strong','',String(data.counts?.[key]||0)),element('span','muted',label));stats.append(stat);});
    const root=$('pending-list');root.replaceChildren();if(!(data.items||[]).length)empty(root,'Nenhuma conversa neste filtro');
    (data.items||[]).forEach((item)=>{
      const card=element('article','item-card pending-card'),head=element('div','item-head'),identity=element('div','identity'),text=element('div'),phoneItem={phones:item.phone?[{phone_e164:item.phone,is_primary:true}]:[],ref:item.ref};text.append(element('strong','identity-name',item.name||`Pedido ${item.ref||'—'}`),phoneNode(phoneItem),element('span','muted one-line',`Ref ${item.ref||'—'} · ${item.vehicleText||'Veículo não informado'}`));const direct=directLeadBadge(item);if(direct)text.append(direct);identity.append(element('span','avatar',initials(item.name)),text);head.append(identity);const badges=element('div','badges');badges.append(makeBadge(`${pendingSituationLabel(item.situation)} · ${item.daysStalled} dias`,pendingTone(item.situation)),makeBadge(pendingHeatLabel(item.heat),item.heat==='HOT'?'red':item.heat==='WARM'?'yellow':''));if(item.searchStageLabel)badges.append(makeBadge(item.searchStageLabel,item.searchStage==='SENT'?'green':item.searchStage==='SAVED'?'blue':'yellow'));head.append(badges);card.append(head);const contact=contactMeta(item);if(contact)card.append(contact);
      const prefix=item.latestDirection==='MCS'?'Você: ':'';card.append(element('p','message-preview',prefix+item.latestMessage));if(item.translation)card.append(element('p','muted','Tradução: “'+item.translation+'”'));if(item.summary||item.nextStep){const ai=element('div','pending-ai');ai.append(element('strong','', 'IA: '),document.createTextNode(item.summary||'Sem resumo ainda'));if(item.nextStep)ai.append(element('strong','', ' Próximo passo: '),document.createTextNode(item.nextStep));card.append(ai);}
      const actions=element('div','inline-actions');const open=element('button','small','Abrir lead/conversa');open.type='button';open.addEventListener('click',()=>openDetail('ficha',item.journeyId));const copy=element('button','quiet small','Copiar número');copy.type='button';copy.disabled=!item.phone;MCSAction.bind(copy,()=>({scope:card,commit:()=>navigator.clipboard.writeText(item.phone),successText:'Copiado',errorText:'Não consegui copiar, tente de novo'}));const resolved=element('button','quiet small','Já resolvi');resolved.type='button';MCSAction.bind(resolved,()=>({scope:card,successScope:document.body,feedbackKey:`pending:${item.journeyId}:${item.chatId}`,optimistic:()=>{card.classList.add('action-optimistic-hidden');const count=countValue('pending');setCount('pending',Math.max(0,count-1));return count;},commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'resolve',journeyId:item.journeyId,chatId:item.chatId})}),rollback:(count)=>{card.classList.remove('action-optimistic-hidden');setCount('pending',count);},successText:'Marcado como resolvido',undo:{commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:'unresolve',journeyId:item.journeyId,chatId:item.chatId})}),successText:'Voltou para pendente',refresh:()=>loadPending()},errorText:'Não consegui salvar, tente de novo'}));const lead=element('button','quiet small',item.isLead?'Não é lead':'Restaurar lead');lead.type='button';MCSAction.bind(lead,()=>{const before=item.isLead;return{scope:card,optimistic:()=>{item.isLead=!before;lead.textContent=item.isLead?'Não é lead':'Restaurar lead';return before;},commit:()=>request('/api/panel/lead?id='+encodeURIComponent(item.journeyId),{method:'POST',body:JSON.stringify({action:'contact_lead',journeyId:item.journeyId,isLead:!before})}),rollback:(value)=>{item.isLead=value;lead.textContent=value?'Não é lead':'Restaurar lead';},refresh:()=>loadPending(),errorText:'Não consegui salvar, tente de novo'};});actions.append(open,copy,resolved,lead);card.append(actions);makeCardClickable(card,()=>openDetail('ficha',item.journeyId));root.append(card);
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
  // M30: the shortcuts are 17:00 on the Florida calendar (the panel's clock), whatever the phone's zone.
  const FLORIDA='America/New_York';
  function zoneToUtc(local,timeZone=FLORIDA){const guess=Date.parse(local+':00Z');if(!Number.isFinite(guess))return null;const parts=zonedInput(new Date(guess),timeZone);const asZone=Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);return new Date(guess-(asZone-guess)).toISOString();}
  function nextQuickLocal(kind){const today=zonedInput(new Date(),FLORIDA);const date=new Date(Date.UTC(Number(today.year),Number(today.month)-1,Number(today.day)));if(kind==='tomorrow')date.setUTCDate(date.getUTCDate()+1);if(kind==='friday'){const add=(5-date.getUTCDay()+7)%7||7;date.setUTCDate(date.getUTCDate()+add);}return date.toISOString().slice(0,10)+'T17:00';}
  function nextActionNode(item,reload){
    if(item.enabled===false||item.status==='ENCERRADO')return null;
    const journeyId=item.journeyId||item.id;if(!journeyId)return null;
    const block=element('section','next-action'+(item.next_action_at&&Date.parse(item.next_action_at)<Date.now()?' overdue':''));
    block.append(element('strong','',`Próximo passo: ${item.next_action_text||'não definido'}${item.next_action_at?' · '+formatDate(item.next_action_at):''}`));
    const define=element('button','quiet small','Definir');define.type='button';block.append(define);
    define.addEventListener('click',(event)=>{event.preventDefault();event.stopPropagation();if(block.querySelector('.next-action-editor'))return;
      const editor=element('div','next-action-editor'),text=element('input');text.type='text';text.maxLength=500;text.placeholder='Texto curto';text.value=item.next_action_text||'';
      const quick=element('select');[['today','Hoje'],['tomorrow','Amanhã'],['friday','Sexta'],['custom','Data']].forEach(([value,label])=>quick.append(new Option(label,value)));
      const date=element('input');date.type='datetime-local';date.value=nextQuickLocal('today');date.title='Horário da Flórida';date.classList.add('hidden');quick.addEventListener('change',()=>{date.classList.toggle('hidden',quick.value!=='custom');if(quick.value!=='custom')date.value=nextQuickLocal(quick.value);});
      const save=element('button','small','Salvar');save.type='button';MCSAction.bind(save,()=>({scope:block,optimistic:()=>{save.textContent='Salvando…';},commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'next_action',operation:'CREATE',journeyId,text:text.value,at:zoneToUtc(date.value)})}),rollback:()=>{save.textContent='Salvar';},refresh:reload,errorText:'Não consegui salvar, tente de novo'}));
      editor.append(text,quick,date,save);block.append(editor);
    });
    return block;
  }
  function copyPhoneButton(item,card){const phone=primaryPhone(item)?.phone_e164||primaryPhone(item)?.phone_raw||item.phone;if(!phone)return null;const copy=element('button','quiet small','Copiar número');copy.type='button';MCSAction.bind(copy,()=>({scope:card,commit:()=>navigator.clipboard.writeText(phone),successText:'Copiado',errorText:'Não consegui copiar, tente de novo'}));return copy;}

  // CLIENTES filters in one place (list and CSV). Lote 4: Origem, Tipo and Última atividade
  // come from PEDIDOS, which is now part of CLIENTES.
  function clientFilterMatch(item){
    const situation=$('clients-situation').value,checklist=$('clients-checklist').value,ref=$('clients-ref').value,heat=$('clients-heat').value;
    return (situation==='all'||item.situation===situation)&&(checklist==='all'||(checklist==='complete'?checklistCompleted(item)===6:checklistCompleted(item)<6))&&(ref==='all'||(ref==='with'?hasRef(item):!hasRef(item)))&&(heat==='all'||String(item.heat||'').toUpperCase()===heat)
      &&MCSOrigin.matchesClientFilters(item,{origin:$('clients-origin')?.value||'all',type:$('clients-type')?.value||'all',days:$('clients-activity')?.value||'all'});
  }
  // CLIENTES period (30 dias, 90 dias, 6 meses, 1 ano, Tudo): the last real activity of the ficha
  // (message from the client or from the MCS, or a calculator event). It filters the list, the badge,
  // the counters, the spreadsheet and the report; never the conversation inside the ficha.
  const clientsPeriod=()=>$('clients-activity')?.value||'30';
  const clientsInPeriod=(items)=>(items||[]).filter((item)=>item.isLead!==false&&MCSOrigin.insidePeriod(item,clientsPeriod()));
  function renderClients(data){
    clientsData=data;const pendingByJourney=new Map((data.pending.items||[]).map((item)=>[item.journeyId,item]));
    // A9: heat and score come from the same read as every other screen (records), not from the pending summary.
    let items=(data.items||[]).map((item)=>({...item,...(pendingByJourney.get(item.id)||{}),id:item.id,journeyId:item.id,latestMessage:item.latestMessage||null,heat:item.heat,heatSource:item.heatSource,score:item.score}));
    items=items.filter(clientFilterMatch);
    if(clientsOverdue24)items=items.filter((item)=>{const latest=item.latestMessage;if(!latest||latest.is_automatic||latest.direction!=='CUSTOMER')return false;return Date.now()-Date.parse(latest.occurred_at_utc||latest.occurred_at_local||latest.created_at)>86400000;});
    items=clientSort(items,$('clients-sort').value);if($('clients-sort').value==='hot')items.sort((a,b)=>({HOT:0,WARM:1,COLD:2}[a.heat]??3)-({HOT:0,WARM:1,COLD:2}[b.heat]??3));
    renderPendingGeneral(data.pending,'clients-general-card');const stats=$('clients-stats');stats.replaceChildren();const periodLeads=clientsInPeriod((data.items||[]).map((item)=>({...item,...(pendingByJourney.get(item.id)||{}),id:item.id})));const situationCount=(key)=>periodLeads.filter((item)=>item.situation===key).length;[['NO_RESPONSE','Sem resposta'],['MCS_PENDING','Parado com você'],['CUSTOMER_PENDING','Parado com o cliente'],['IN_PROGRESS','Em andamento'],['CLOSED','Concluída']].forEach(([key,label])=>{const stat=element('div','pending-stat');stat.append(element('strong','',String(situationCount(key))),element('span','muted',label));stats.append(stat);});
    const allLeads=(data.items||[]).filter((item)=>item.isLead!==false).length;$('clients-period-note').textContent=clientsPeriod()==='all'?`Período: tudo, sem corte por data · ${allLeads} clientes`:`Período: atividade real ${MCSOrigin.periodLabel(clientsPeriod())} · ${periodLeads.length} de ${allLeads} clientes`;
    // M5: "não é lead" stays reachable (to restore it) but at the end and outside the counter.
    items=[...items.filter((item)=>item.isLead!==false),...items.filter((item)=>item.isLead===false)];
    const root=$('clients-list');root.replaceChildren();setCount('clients',periodLeads.length);
    // M28: the ">24 h" shortcut from the weekly summary is a visible filter that can be cleared.
    if(clientsOverdue24){const chip=element('button','chip active','Sem resposta há mais de 24 h ✕');chip.type='button';chip.addEventListener('click',()=>{clientsOverdue24=false;renderClients(clientsData);});root.append(chip);}
    if(!items.length){if(clientsOverdue24)root.append(element('p','empty-state','Nenhum cliente neste filtro'));else empty(root,'Nenhum cliente neste filtro');return;}
    items.forEach((item)=>{const card=element('article',`item-card client-card heat-${String(item.heat||'COLD').toLowerCase()}`),head=element('div','item-head');head.append(identityHeader(item,{preview:item.latestMessage?.body_text||item.latestMessageText||''}));const badges=element('div','badges');if((item.origins||[]).includes('CALCULADORA'))badges.append(makeBadge(['Calculadora',...(item.calculatorTypes||[]).map((type)=>({BUSCA:'Busca',SIMULACAO:'Simulação'})[type]).filter(Boolean)].join(' · '),'blue'));badges.append(makeBadge(pendingSituationLabel(item.situation),pendingTone(item.situation)),makeBadge(`Checklist ${checklistCompleted(item)}/6`,checklistCompleted(item)===6?'green':'blue'));const heat=heatBadge(item);if(heat)badges.append(heat);if(item.searchStageLabel)badges.append(makeBadge(item.searchStageLabel,item.searchStage==='SENT'?'green':item.searchStage==='SAVED'?'blue':'yellow'));if(item.disposition)badges.append(makeBadge(item.disposition==='TREATED'?'Tratado':`Descartado${item.discardReason?' · '+discardLabel(item.discardReason):''}`,item.disposition==='DISCARDED'?'red':'blue'));head.append(badges);card.append(head);if(item.lastRealMessageAt)card.append(element('p','muted client-last-message',`última mensagem: ${floridaDayMonth(item.lastRealMessageAt)}`));if(item.aiSummary||item.summary)card.append(element('p','pending-ai',`IA: ${item.aiSummary||item.summary}`));const waiting=waitClockNode(item),receipt=readReceiptNode(item),next=nextActionNode(item,()=>loadClients());if(waiting)card.append(waiting);if(receipt)card.append(receipt);if(next)card.append(next);if(!hasRef(item)){const copy=copyPhoneButton(item,card);if(copy)card.append(copy);}const actions=element('div','inline-actions'),open=element('button','small','Abrir lead');open.type='button';open.addEventListener('click',()=>openDetail('ficha',item.id));actions.append(open,journeySwitch(item,()=>loadClients()));if(item.chatId){const resolved=Boolean(item.resolved),done=element('button','quiet small',resolved?'Restaurar pendência':'Já resolvi');done.type='button';MCSAction.bind(done,()=>({scope:card,optimistic:()=>{done.textContent=resolved?'Restaurando…':'Salvando…';},commit:()=>request('/api/panel/pendencias',{method:'POST',body:JSON.stringify({action:resolved?'unresolve':'resolve',journeyId:item.id,chatId:item.chatId})}),rollback:()=>{done.textContent=resolved?'Restaurar pendência':'Já resolvi';},refresh:()=>loadClients(),errorText:'Não consegui salvar, tente de novo'}));actions.append(done);}const lead=element('button','quiet small',item.isLead===false?'Restaurar lead':'Não é lead');lead.type='button';MCSAction.bind(lead,()=>{const before=item.isLead!==false;return{scope:card,optimistic:()=>{item.isLead=!before;lead.textContent=item.isLead?'Não é lead':'Restaurar lead';return before;},commit:()=>request('/api/panel/lead?id='+encodeURIComponent(item.id),{method:'POST',body:JSON.stringify({action:'contact_lead',journeyId:item.id,isLead:!before})}),rollback:(value)=>{item.isLead=value;lead.textContent=value?'Não é lead':'Restaurar lead';},refresh:()=>loadClients(),errorText:'Não consegui salvar, tente de novo'};});actions.append(lead);card.append(actions,dispositionControls(item));makeCardClickable(card,()=>openDetail('ficha',item.id));root.append(card);});
  }
  async function loadClients(){const [records,pending]=await Promise.all([request('/api/panel/records?sort='+encodeURIComponent($('clients-sort').value)),request('/api/panel/pendencias?situation=all&sort=hot&withRef=false&includeResolved=true')]);updateMeta(records.meta);renderClients({items:records.items||[],pending});}

  const trend=(item)=>item?.trend==='up'?'↑':item?.trend==='down'?'↓':'→';
  const metricValue=(value)=>value===null||value===undefined?'—':String(value);
  const responseTime=(minutes)=>minutes===null||minutes===undefined?'—':minutes<60?`${minutes} min`:`${Math.floor(minutes/60)}h ${minutes%60}min`;
  function renderWeekly(data){
    const root=$('weekly-summary-content');if(!root)return;root.replaceChildren();
    const row=(label,item,format=metricValue,action)=>{const block=element('div','weekly-metric'),name=element('span','',label),value=element(action?'button':'strong','weekly-value',`${format(item?.current)} ${trend(item)}`);if(action){value.type='button';value.classList.add('quiet');value.addEventListener('click',action);}block.append(name,value,element('small','muted',`anterior: ${format(item?.previous)}`));root.append(block);};
    row('Leads · WhatsApp',data.leads?.whatsapp);row('Leads · SMS',data.leads?.sms);row('Leads · Calculadora',data.leads?.calculator);
    row('Respondidos por mim',data.responded);row('Tempo médio até a 1ª resposta',data.averageResponseMinutes,responseTime);
    row('Sem resposta há mais de 24 h',data.unanswered24h,metricValue,async()=>{clientsOverdue24=true;$('clients-situation').value='all';await switchPanel('clients');});
    row('Opções enviadas',data.options);row('Descartados',data.discarded);row('Pedidos parados há mais de 3 dias',data.stalledOrders);
    const reasons=(data.discarded?.reasons||[]).map((item)=>`${discardLabel(item.reason)} (${item.count})`).join(' · ');root.append(element('p','weekly-reasons',`Motivos mais comuns: ${reasons||'—'}`));
  }
  async function loadWeekly(){const data=await request('/api/panel/weekly');renderWeekly(data);}

  function downloadClientsCsv(){
    const pendingByJourney=new Map((clientsData.pending?.items||[]).map((item)=>[item.journeyId,item]));
    let items=(clientsData.items||[]).map((item)=>({...item,...(pendingByJourney.get(item.id)||{}),id:item.id,journeyId:item.id}));
    // Same universe as the badge, the counters and the report: leads only ("não é lead" stays out).
    items=items.filter((item)=>item.isLead!==false&&clientFilterMatch(item));
    const csvCell=(value)=>{const raw=String(value??''),text=/^[=+\-@\t\r]/.test(raw)&&!/^[+-]?[\d\s().,-]+$/.test(raw)?"'"+raw:raw;return /[",\r\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;};
    const rows=[['nome','telefone','Ref','situação','checklist','calor','etapa da busca','resumo da IA'],...items.map((item)=>[item.name||item.contact?.display_name||'',primaryPhone(item)?.phone_e164||primaryPhone(item)?.phone_raw||'',item.ref||item.referenceCode||item.reference_code||'',pendingSituationLabel(item.situation),`${checklistCompleted(item)}/6`,pendingHeatLabel(item.heat),item.searchStageLabel||'',item.aiSummary||item.summary||''])];
    const blob=new Blob(['\uFEFF'+rows.map((row)=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='clientes-mcs.csv';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  function empty(root, message) {
    root.replaceChildren(element('p', 'empty-state', message));
  }

  function makeBadge(text, tone) {
    return element('span', 'badge' + (tone ? ' ' + tone : ''), text);
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
  function contactChannelLabel(channel){return {WHATSAPP:'💬 WhatsApp',WHATSAPP_HISTORY:'💬 WhatsApp · histórico',WHATSAPP_CLICK:'💬 Clicou em WhatsApp',SMS_CLICK:'✉️ Clicou em mensagem de texto',SMS:'✉️ SMS',CONTACT_CLICK_UNKNOWN:'💬 Clicou para falar (canal não registrado)',IMPORTED:'📎 Conversa importada/colada'}[channel]||'';}
  function floridaArrival(value){if(!value)return '';const date=new Date(value),now=new Date();const fmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',hour12:true});const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(date);const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(now);const yesterday=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(Date.now()-86400000));const prefix=day===today?'hoje':day===yesterday?'ontem':new Intl.DateTimeFormat('pt-BR',{timeZone:'America/New_York',day:'2-digit',month:'2-digit'}).format(date);return `chegou ${prefix} ${fmt.format(date)} (Flórida)`;}
  function heatBadge(item){const labels={HOT:'🔥 Quente',WARM:'🌤 Morno',COLD:'❄️ Frio'},tone={HOT:'red',WARM:'yellow',COLD:'blue'};const heat=String(item.heat||'').toUpperCase();if(!heat)return null;const badge=makeBadge(labels[heat]||labels.COLD,tone[heat]||'blue');badge.classList.add('heat-badge');return badge;}
  function contactMeta(item){const wrap=element('div','badges contact-meta');const channel=contactChannelLabel(item.contactChannel),arrival=floridaArrival(item.contactAt||item.lastCustomerAt);if(channel)wrap.append(makeBadge(channel,['WHATSAPP','WHATSAPP_HISTORY','WHATSAPP_CLICK'].includes(item.contactChannel)?'green':['SMS_CLICK','SMS'].includes(item.contactChannel)?'yellow':'blue'));if(arrival)wrap.append(makeBadge(arrival));const heat=heatBadge(item);if(heat){const details=element('details','temperature-details'),summary=element('summary','');summary.append(heat);details.append(summary,element('p','temperature-explanation',item.heatSource==='AI'?`Temperatura da IA: ${item.aiSummary||'Sem resumo.'}${item.aiNextStep?' Próximo passo: '+item.aiNextStep:''}`:'Temperatura calculada: telefone, checklist, prazo, orçamento x Manheim, conversa recente e horário.'));wrap.append(details);}return wrap.childNodes.length?wrap:null;}
  function directLeadLabel(item){return item?.directLeadSource==='WHATSAPP_DIRECT'?'📱 veio direto pelo WhatsApp (sem calculadora)':item?.directLeadSource==='SMS_DIRECT'?'✉️ veio direto por SMS (sem calculadora)':'';}
  function directLeadBadge(item){const label=directLeadLabel(item);return label?makeBadge(label,'blue'):null;}
  /* dd/mm no horario da Florida */
  function floridaDayMonth(value){const date=new Date(value);if(Number.isNaN(date.getTime()))return '';const parts=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/New_York',day:'2-digit',month:'2-digit'}).formatToParts(date);const get=(type)=>parts.find((part)=>part.type===type)?.value||'';return `${get('day')}/${get('month')}`;}
  function clientSort(items,mode){const missing=(v)=>v===null||v===undefined||v==='';const value=(x)=>Number(x.budgetCents||x.budget_cents)||null;const hasSortAt=(x)=>Object.prototype.hasOwnProperty.call(x,'sortAt');const stamp=(x)=>hasSortAt(x)?(x.sortAt?Date.parse(x.sortAt)||null:null):(Date.parse(x.last_seen_at||x.updated_at||x.occurredAt||x.created_at||0)||0);const field=(x,kind)=>kind==='location'?(x.state||x.estado||x.contact?.location_text):kind==='vehicle'?(x.make||x.vehicleText||x.vehicle_text):value(x);return items.slice().sort((a,b)=>{if(mode==='recent'||mode==='oldest'){/* sortAt vem do servidor (ultima mensagem real); sem data vai para o fim */const sa=stamp(a),sb=stamp(b);if(sa===null)return sb===null?0:1;if(sb===null)return -1;return(sb-sa)*(mode==='recent'?1:-1);}const av=field(a,mode),bv=field(b,mode);if(missing(av))return missing(bv)?0:1;if(missing(bv))return -1;if(mode==='value_desc'||mode==='value_asc')return(av-bv)*(mode==='value_desc'?-1:1);return String(av).localeCompare(String(bv),'pt-BR');});}

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

  // M27: a print just saved keeps its "Guardado" and "Desfazer" for 2 minutes, even after the list reloads
  const recentPrints=new Map();
  function recentPrintBlock(key,recent){
    const block=element('section','sms-print-missing');const row=element('div','inline-actions');row.append(element('strong','',recent.text));
    const undo=element('button','quiet small','Desfazer');undo.type='button';
    MCSAction.bind(undo,()=>({scope:block,commit:()=>request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'undo',readId:recent.readId})}),successText:'Desfeito · O arquivo permanece guardado',errorText:'Não consegui desfazer, tente de novo',onSuccess:()=>{recentPrints.delete(key);row.remove();},refresh:()=>refreshCounters().catch(()=>{})}));
    row.append(undo);block.append(row);return block;
  }
  function smsPrintMissing(item) {
    const printKey=item.journeyId||item.id,recent=printKey&&recentPrints.get(printKey);
    if(recent&&Date.now()-recent.at<120000&&item.smsPrintConfirmed)return recentPrintBlock(printKey,recent);
    if(item.contactChannel!=='SMS_CLICK'||item.smsPrintConfirmed||item.disposition)return null;
    const block=element('section','sms-print-missing'); block.append(element('strong','', 'Falta o print do SMS'),element('p','', 'Tire um print da mensagem no seu celular, com o número e a Ref, e anexe aqui'));
    const attach=element('label','small','📷 Anexar print do SMS'),input=element('input');input.type='file';input.accept='image/*';input.multiple=true;input.hidden=true;attach.append(input);const absent=element('button','quiet small','Não chegou SMS · descartar'); absent.type='button';
    const resultRoot=element('div','card-action-result');
    input.addEventListener('change',()=>{const files=[...input.files];if(!files.length)return;const context={journeyId:item.journeyId||item.id||null,contactId:item.contact_id||item.contact?.id||null,ref:item.ref||item.referenceCode||item.reference_code||null};MCSAction.run({button:attach,scope:block,optimistic:()=>attach.classList.add('disabled'),commit:async()=>{let last;for(const file of files)last=await uploadAutoPrint(file,context,resultRoot);return last;},rollback:()=>{attach.classList.remove('disabled');input.value='';},onSuccess:()=>{attach.classList.remove('disabled');input.value='';},errorText:(error)=>printErrorText(error)});});
    // A21: this button discards the lead, so it says so and asks first; the reason is recorded as "Outro"
    absent.addEventListener('click',async(event)=>{event.preventDefault();event.stopPropagation();if(block.querySelector('.inline-confirm'))return;if(!(await askInline(actions,'Isso descarta o lead com o motivo "Outro" · Ele sai de HOJE e das listas, e dá para desfazer','Descartar lead')))return;setDisposition({...item,kind:item.kind||'JOURNEY',id:item.id||item.journeyId},'DISCARDED',absent,'OTHER');});
    const actions=element('div','inline-actions'); actions.append(attach,absent); block.append(actions,resultRoot);
    return block;
  }

  function makeCardClickable(card, action) {
    card.tabIndex = 0;
    card.classList.add('clickable-card');
    card.addEventListener('click', (event) => {
      // A control stops the click unless it is an ancestor of the card (Lote 4: order cards now
      // live inside a <details>). A button removed by its own click (Cancelar) still stops it.
      const control = event.target.closest('button,input,select,textarea,a,details,summary');
      if (control && !control.contains(card)) return;
      action();
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === card) action();
    });
  }

  function journeySwitch(item, reload) {
    const enabled = item.status !== 'ENCERRADO' && (typeof item.enabled === 'boolean' ? item.enabled : true);
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
      errorText:'Não consegui salvar, tente de novo'}));
    wrap.append(toggle);
    if (enabled) {
      const reasons = element('details', 'switch-reasons');
      reasons.append(element('summary', '', 'Desligar com motivo'));
      const choices = element('div', 'inline-actions');
      [['MCS_PURCHASE', 'Comprou com a MCS'], ['OTHER_PURCHASE', 'Comprou em outro lugar'], ['GAVE_UP', 'Desistiu'], ['NO_RESPONSE', 'Sem resposta']].forEach(([reason, label]) => {
        const button = element('button', 'quiet small', label);
        button.type = 'button';
        MCSAction.bind(button,()=>({scope:wrap,optimistic:()=>{button.textContent='Salvando…';},commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'toggle_journey',journeyId:item.id,enabled:false,reason})}),rollback:()=>{button.textContent=label;},refresh:reload,errorText:'Não consegui salvar, tente de novo'}));
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
    const roots = { today: 'pending-list', entry: 'entry-queue', clients: 'clients-list', pending: 'pending-list', qualification: 'qualification-list', searches: 'manheim-summary', manheim: 'manheim-summary', records: 'records-list' };
    const root = roots[view] && $(roots[view]);
    if (!root) return;
    // Nothing is shown as zero: the tab says it did not load and offers to try again.
    empty(root, 'Não foi possível carregar esta aba');
    const retry = element('button', 'quiet small', 'Tentar novamente'); retry.type = 'button';
    retry.addEventListener('click', () => { retry.disabled = true; retry.textContent = 'Carregando…'; switchPanel(view).catch(() => {}); });
    root.append(retry);
  }

  async function loadSearches() {
    const data=await request('/api/panel/searches');
    // One card per ficha and mode: the VALOR card and the CARRO card of the same person keep their
    // own stage, and every action sends its mode.
    const summaries={VALOR:modeRoot('VALOR','summary'),CARRO:modeRoot('CARRO','summary')},roots={VALOR:modeRoot('VALOR','clients'),CARRO:modeRoot('CARRO','clients')};
    Object.values(summaries).forEach((root)=>root.replaceChildren());Object.values(roots).forEach((root)=>root.replaceChildren());
    const makeButton=(label,handler,className='small')=>{const control=element('button',className,label);control.type='button';control.addEventListener('click',handler);return control;};
    ['VALOR','CARRO'].forEach((mode)=>[['MISSING','🔍 Falta buscar'],['SAVED','💾 Busca salva'],['SENT','📤 Opções enviadas']].forEach(([key,label])=>{const stat=element('div','pending-stat');stat.append(element('strong','',String(data.countsByMode?.[mode]?.[key]||0)),element('span','muted',label));summaries[mode].append(stat);}));
    (data.items||[]).forEach((item)=>{
      const root=roots[item.mode];if(!root)return;
      const card=element('article','item-card search-card');card.dataset.mode=item.mode;const head=element('div','item-head');head.append(element('strong','identity-name',item.name),phoneNode({phones:item.phone?[{phone_e164:item.phone,is_primary:true}]:[]}),element('span','muted',item.ref?`Ref ${item.ref}`:'sem Ref'));const direct=directLeadBadge(item);if(direct)head.append(direct);head.append(element('span','search-stage '+item.stage,`${item.stageLabel}${item.days ? ` há ${item.days} dia${item.days===1?'':'s'}` : ''}`));card.append(head);
      card.append(makeBadge(item.mode==='VALOR'?'POR VALOR':'POR ANO E MILHAGEM',item.mode==='VALOR'?'blue':'green'),element('strong','',item.exactSearch));
      if(item.alsoServes?.length){const names=item.alsoServes.slice(0,2).map((peer)=>`${peer.name} (${peer.ref?`Ref ${peer.ref}`:'sem Ref'})`).join(' e ');card.append(element('p','muted',`Também serve para: ${names}${item.alsoServes.length>2?` e mais ${item.alsoServes.length-2}`:''} · mesma busca no Manheim`));}
      if(item.stage==='SAVED')card.append(element('p','muted',`${item.matchCount} carro${item.matchCount===1?'':'s'} no último CSV do Manheim batem com esta busca`));
      const actions=element('div','inline-actions');
      const stageAction=(control,kind)=>MCSAction.bind(control,()=>{const previous=item.stage,next=kind==='SAVED'?'SAVED':'SENT';return{scope:card,optimistic:()=>{item.stage=next;card.querySelector('.search-stage').textContent=next==='SAVED'?'💾 Busca salva':'📤 Opções enviadas';return previous;},commit:()=>request('/api/panel/searches',{method:'POST',body:JSON.stringify({action:'mark',journeyId:item.journeyId,kind,mode:item.mode})}),rollback:(value)=>{item.stage=value;card.querySelector('.search-stage').textContent=item.stageLabel;},refresh:()=>loadSearches(),errorText:'Não consegui salvar, tente de novo'};});
      if(item.stage==='MISSING'){const saved=makeButton('💾 Salvei a busca no Manheim',null);stageAction(saved,'SAVED');actions.append(saved);}
      if(item.stage!=='SENT'){const sent=makeButton('📤 Enviei opções ao cliente',null,'quiet small');stageAction(sent,'SENT');actions.append(sent);}
      if(item.stage==='SAVED'&&item.matchCount)actions.append(makeButton(`Ver os ${item.matchCount} carros`,()=>switchPanel('searches'),'quiet small'));
      if(item.stage!=='MISSING'){const kind=item.stage==='SENT'?'SENT':'SAVED',undo=makeButton('Desfazer',null,'quiet small');if(item.stageSource==='MARK')MCSAction.bind(undo,()=>({scope:card,optimistic:()=>{undo.textContent='Desfazendo…';},commit:()=>request('/api/panel/searches',{method:'POST',body:JSON.stringify({action:'undo',journeyId:item.journeyId,kind,mode:item.mode})}),rollback:()=>{undo.textContent='Desfazer';},refresh:()=>loadSearches(),errorText:'Não consegui desfazer, tente de novo'}));else undo.addEventListener('click',()=>MCSAction.feedback(card,item.stageSource==='MANHEIM'?'Esta busca foi marcada no MANHEIM, desfaça em “Quais buscas salvar”':'As opções foram registradas pela ficha do cliente, desfaça na ficha','error','search-origin'));actions.append(undo);}
      actions.append(makeButton('Abrir lead',()=>openDetail('ficha',item.journeyId),'quiet small'));card.append(actions);root.append(card);
    });
    Object.entries(roots).forEach(([mode,root])=>{if(!root.childElementCount)empty(root,'Nenhum cliente com busca ativa neste modo');});
  }

  // A newer load of the screen cancels the older one still running (AbortController): only the
  // newest answer is drawn and the old request stops waiting.
  let viewController = null;
  const viewFetch = () => ({ signal: viewController ? viewController.signal : undefined });
  async function loadCurrent(view = currentView, requestVersion = viewRequestVersion) {
    if (viewController) viewController.abort();
    const controller = new AbortController();
    viewController = controller;
    try { return await loadCurrentNow(view, requestVersion); }
    catch (failure) { if (failure && failure.code === 'REQUEST_ABORTED') return; throw failure; }
    finally { if (viewController === controller) viewController = null; }
  }
  async function loadCurrentNow(view, requestVersion) {
    const current = () => currentView === view && viewRequestVersion === requestVersion;
    if (view === 'entry') {
      const data = await loadQueue(false);
      if (!current()) return;
      renderQueue(data.chats || [], data.reviews || []);
      refreshEntryOrders().catch(() => { $('entry-orders-count').textContent = '?'; empty($('entry-orders-list'), 'Não foi possível carregar'); });
      loadTriage().catch(() => {});
      return loadWhatsApp().catch(() => { $('whatsapp-signal').textContent = 'Não foi possível verificar o WhatsApp'; });
    }
    if (view === 'pending') return loadPending();
    if (view === 'clients') return loadClients();
    if (view === 'today') {
      const [data,vitrineData]=await Promise.all([request('/api/panel/today?sort='+encodeURIComponent($('today-sort').value),viewFetch()),request('/api/panel/vitrine-requests',viewFetch()),loadWeekly()]);
      if (!current()) return;
      updateMeta(data.meta);
      renderVitrineRequests(vitrineData);
      return renderToday(data.items || []);
    }
    if (view === 'qualification') {
      const data = await request('/api/panel/qualification?sort='+encodeURIComponent($('qualification-sort').value),viewFetch());
      if (!current()) return;
      updateMeta(data.meta);
      return renderQualification(data.items || []);
    }
    if (view === 'searches') {
      const [,data]=await Promise.all([loadSearches(),request('/api/panel/records?view=manheim',viewFetch())]);
      if (!current()) return;
      updateMeta(data.meta);renderManheim(data);if(!productionHost)renderV1Demo();return;
    }
    // IMPORTAÇÕES reads the same batch data (the batch list and the import tools live there).
    if (view === 'imports') {
      // The manual imports (SMS, WhatsApp conversation) choose among the contacts and fichas of
      // ENTRADA: loaded here too, so opening IMPORTAÇÕES directly never shows empty choices.
      loadQueue(false).catch(() => {});
      loadV2Photos().catch(() => {});
      const data = await request('/api/panel/records?view=manheim', viewFetch());
      if (!current()) return;
      updateMeta(data.meta);renderManheim(data);return;
    }
    if (view === 'requests') {
      const data = await request('/api/panel/pesquisas', viewFetch());
      if (!current()) return;
      return renderRequests(data);
    }
    if (view === 'manheim') {
      const data = await request('/api/panel/records?view=manheim',viewFetch());
      if (!current()) return;
      updateMeta(data.meta);
      return renderManheim(data);
    }
    if (view === 'records') {
      const data = await request('/api/panel/records?sort='+encodeURIComponent($('records-sort').value),viewFetch());
      if (!current()) return;
      updateMeta(data.meta);
      return renderRecords(data.items || []);
    }
  }

  // C5: one failing counter never breaks the others nor the session; it shows "—".
  let countersRunning = null;
  async function refreshCounters() {
    // A second call while one is running waits for the same answer (actions in a row).
    if (countersRunning) return countersRunning;
    countersRunning = refreshCountersNow().finally(() => { countersRunning = null; });
    return countersRunning;
  }
  async function refreshCountersNow() {
    // C5: only the visible tabs are counted; the hidden PENDÊNCIAS and Manheim screens cost two heavy GETs for nothing
    // Each GET is shared with an identical one already running and reuses an answer of the last seconds.
    const settled = await Promise.allSettled([
      sharedGet('/api/panel/today', 10000),
      sharedGet('/api/panel/entry', 10000),
      sharedGet('/api/panel/searches', 10000),
      sharedGet('/api/panel/records', 10000),
      sharedGet('/api/panel/vitrine-requests', 10000),
      sharedGet('/api/panel/triage', 10000)
    ]);
    const [today, entry, searches, records, vitrineData, triageData] = settled.map((result) => result.status === 'fulfilled' ? result.value : null);
    // One failing counter never touches the others; it keeps its last confirmed number.
    const count = (view, data, compute) => { if (!data) return setCountUnknown(view); try { setCount(view, compute(data)); } catch (_) { setCountUnknown(view); } };
    if (today && vitrineData) setCount('today', (today.items || []).length + ((vitrineData && vitrineData.requests) || []).length); else setCountUnknown('today');
    // Conversations the triage left in REVISAR also wait for a decision in ENTRADA.
    if (triageData) triageReviewCount = (triageData.review || []).length;
    count('entry', triageData ? entry : null, (data) => { entryQueueCount = (data.chats || []).filter((chat) => !chat.triageOut && (chat.resolution_status !== 'RESOLVED' || chat.hasTimeUncertain)).length + (data.reviews || []).length + (data.printReviews || []).length + (data.failedPrints || []).length; return entryQueueCount + triageReviewCount; });
    // Same rule as the list: leads only, inside the CLIENTES period.
    count('clients', records, (data) => clientsInPeriod(data.items).length);
    // One person with a VALOR and a CARRO card is one person in the badge.
    count('searches', searches, (data) => new Set((data.items || []).map((item) => item.journeyId || item.key)).size);
    const failures = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) console.error('Contadores com falha', failures);
    renderCountersNote(failures.length);
    return { failed: failures.length };
  }
  // "Não foi possível atualizar" next to the counters, with the time of the last good update and a retry.
  let countersOkAt = null;
  function renderCountersNote(failed) {
    const holder = document.querySelector('.freshness');
    if (!holder) return;
    let note = $('counters-note');
    if (!failed) { countersOkAt = Date.now(); if (note) note.remove(); return; }
    if (!note) { note = element('span', 'counters-note error'); note.id = 'counters-note'; note.setAttribute('role', 'status'); holder.append(note); }
    note.replaceChildren(element('span', '', 'Não foi possível atualizar' + (countersOkAt ? ` · contadores de ${new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }).format(countersOkAt)}` : '')));
    const retry = element('button', 'quiet small', 'Tentar novamente'); retry.type = 'button';
    retry.addEventListener('click', () => { retry.disabled = true; retry.textContent = 'Atualizando…'; if (requestPool) requestPool.invalidate(); refreshCounters().catch(() => {}); });
    note.append(retry);
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
      const details=element('details',''); details.append(element('summary','',`${missing.length} contatos não estão aparecendo, ver lista`),element('p','',missing.join(' · '))); root.append(details);
    } catch (_) { root.className='capture-warning muted'; root.textContent='Checagem de captura indisponível'; }
  }

  // Lote 4: PEDIDOS now lives in ENTRADA as a collapsed section. Calculator Refs with no ficha
  // that clicked WhatsApp/SMS ("contacted") and the ones that only simulated ("simulated").
  // The section has its own counter and never adds to the ENTRADA badge (owner decision D2).
  const entryOrders = { period: '30', contacted: { items: [], hasMore: false, version: 0 }, simulated: { items: [], hasMore: false, version: 0 }, linkTargets: [] };
  async function loadEntryOrders(group = 'contacted', append = false, keep = 0) {
    const state = entryOrders[group], version = ++state.version, period = entryOrders.period;
    const offset = append ? state.items.length : 0;
    // After an action the list keeps as many cards as were loaded ("Carregar mais" is not lost)
    const limit = Math.min(100, Math.max(20, keep));
    const params = new URLSearchParams({ scope: 'unlinked', group, period, sort: 'recent', limit: String(limit), offset: String(offset) });
    const data = await request('/api/panel/orders?' + params.toString());
    // A slower, older answer (other period chip, auto-refresh) never overwrites a newer one
    if (version !== state.version || period !== entryOrders.period) return;
    state.items = append ? state.items.concat(data.items || []) : (data.items || []);
    state.hasMore = Boolean(data.page && data.page.hasMore);
    entryOrders.linkTargets = data.linkTargets || entryOrders.linkTargets;
    $('entry-orders-count').textContent = String(data.counts?.contacted ?? 0);
    $('entry-simulated-count').textContent = `(${data.counts?.simulated ?? 0})`;
    renderEntryOrders(group);
  }
  function renderEntryOrders(group) {
    const state = entryOrders[group], root = $(group === 'contacted' ? 'entry-orders-list' : 'entry-simulated-list');
    root.replaceChildren();
    $(group === 'contacted' ? 'entry-orders-more' : 'entry-simulated-more').classList.toggle('hidden', !state.hasMore);
    if (!state.items.length) return empty(root, group === 'contacted' ? 'Nenhum pedido sem conversa neste período' : 'Nenhuma simulação sem contato neste período');
    const refresh = () => refreshEntryOrders();
    state.items.forEach((item) => root.append(orderCard(item, entryOrders.linkTargets, refresh)));
  }
  async function refreshEntryOrders(keepLoaded = true) {
    await loadEntryOrders('contacted', false, keepLoaded ? entryOrders.contacted.items.length : 0);
    if ($('entry-simulated')?.open) await loadEntryOrders('simulated', false, keepLoaded ? entryOrders.simulated.items.length : 0);
  }


  async function refreshCurrentPreservingState() {
    const scrollY=window.scrollY,view=currentView,version=viewRequestVersion;
    await loadCurrent(view,version);
    requestAnimationFrame(()=>window.scrollTo(0,scrollY));
  }

  function captureOrigin() {
    const sorts = {};
    ['today','entry','pending','qualification','manheim','records'].forEach((name) => { const select=$(name+'-sort'); if(select) sorts[name]=select.value; });
    return {
      view: currentView,
      scrollY: window.scrollY,
      sorts,
      pendingSituation,
      pendingWithRef: Boolean($('pending-with-ref')?.checked),
      searchQuery: $('global-search-input')?.value || '',
      searchVisible: !$('search-results')?.classList.contains('hidden')
    };
  }

  async function restoreOrigin(origin = detailOrigin) {
    const target = origin || { view: 'today', scrollY: 0 };
    detailOrigin = null;
    currentDetail = null;
    pendingSituation = target.pendingSituation || pendingSituation;
    if ($('pending-with-ref')) $('pending-with-ref').checked = Boolean(target.pendingWithRef);
    document.querySelectorAll('[data-pending-situation]').forEach((button) => button.classList.toggle('active', button.dataset.pendingSituation === pendingSituation));
    Object.entries(target.sorts||{}).forEach(([name,value])=>{const select=$(name+'-sort');if(select&&[...select.options].some((option)=>option.value===value))select.value=value;});
    await switchPanel(target.view || 'today');
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
      rollback:()=>toast.classList.remove('action-optimistic-hidden'),successText:'Ação desfeita',
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

  // Unknown counter ("—"): NaN, so an optimistic step never invents a zero.
  function countValue(view){const entry=counterState.get(view);return entry&&Number.isFinite(entry.value)?entry.value:NaN;}
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
      rollback:(snapshot)=>rollbackDisposition(item,snapshot),errorText:'Não consegui salvar, tente de novo',
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

  function detailHash(kind, key) {
    return kind === 'order' ? '#pedido/' + encodeURIComponent(key) : '#ficha/' + encodeURIComponent(key);
  }

  function showDetailShell(kind, key) {
    const labels = { today: 'today-panel', entry: 'entry-panel', clients:'clients-panel', pending: 'pending-panel', qualification: 'qualification-panel', requests: 'requests-panel', searches: 'searches-panel', imports: 'imports-panel', manheim: 'manheim-panel', records: 'records-panel' };
    Object.values(labels).forEach((id) => $(id)?.classList.add('hidden'));
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
        actionMessage, downloadShortlist, dispositionControls, replyComposer,
        mediaObjectUrl:async(messageId)=>{const data=await request('/api/panel/media?signed=1&messageId='+encodeURIComponent(messageId));if(!data.url)throw Error('MEDIA_NOT_AVAILABLE');return data.url;} });
      if(requestVersion!==detailRequestVersion)return;
      if(leadDetailData?.record?.whatsappWithoutPhone){const identity=$('record-detail').querySelector('.lead-head-name');if(identity)identity.append(element('p','muted whatsapp-no-phone-note','Responda pela conversa no app WhatsApp Business'));}
    } catch (failure) {
      if(requestVersion!==detailRequestVersion)return;
      const code=failure?.requestId||failure?.code||'SEM-CODIGO';
      const root=$('record-detail');root.replaceChildren();
      root.append(element('p','status error',`Não consegui abrir este lead agora · Código: ${code}`));
      const actions=element('div','inline-actions');
      const retry=element('button','small','Tentar de novo');retry.type='button';retry.addEventListener('click',()=>openDetail(kind,key,{push:false,origin:detailOrigin}));
      const back=element('button','quiet small','Voltar ao painel');back.type='button';back.addEventListener('click',()=>{if(history.state?.detail)history.back();else restoreOrigin(detailOrigin||captureOrigin()).catch(()=>{});});
      actions.append(retry,back);root.append(actions);
    }
  }



  /* ===== IMPORTAÇÕES · Fotos da V2: acrescenta fotos ao carro de uma V2 que já existe ===== */
  // Only adds photos (same route and limits as Montar V2). It never creates, publishes or sends a V2.
  const v2Photos={list:[],photos:[],busy:false};
  const v2Target=()=>{const [vitrineId,carId]=($('import-v2-select')?.value||'').split('|');const v2=v2Photos.list.find((item)=>item.vitrineId===vitrineId);const car=v2?.cars.find((item)=>item.carId===carId);return v2&&car?{v2,car}:null;};
  function paintV2Photos(){
    const thumbs=$('import-v2-thumbs'),target=v2Target(),send=$('import-v2-send');if(!thumbs)return;
    $('import-v2-body')?.classList.toggle('hidden',!target);
    thumbs.replaceChildren();
    v2Photos.photos.forEach((photo,index)=>{const item=element('div','v2-thumb');const img=element('img');img.src=photo.url;img.alt='';const remove=element('button','quiet small','×');remove.type='button';remove.setAttribute('aria-label','Remover foto');remove.addEventListener('click',()=>{URL.revokeObjectURL(photo.url);v2Photos.photos.splice(index,1);paintV2Photos();});item.append(img,remove);thumbs.append(item);});
    if(send){send.disabled=v2Photos.busy||!target||!v2Photos.photos.length;send.textContent=v2Photos.photos.length?`Enviar ${v2Photos.photos.length} foto(s)`:'Enviar fotos';}
  }
  async function loadV2Photos(){
    const select=$('import-v2-select');if(!select)return;
    const keep=select.value;
    let data;try{data=await request('/api/panel/vitrines',{method:'GET'});}catch(_){select.replaceChildren(new Option('Não consegui carregar as V2',''));paintV2Photos();return;}
    v2Photos.list=data.v2||[];
    const options=[new Option(v2Photos.list.length?'Escolha a V2':'Nenhuma V2 aberta','')];
    for(const v2 of v2Photos.list)for(const car of v2.cars){const who=[v2.customerName,v2.referenceCode].filter(Boolean).join(' · ')||'Cliente sem nome';options.push(new Option(`${who} · ${car.vehicle} · ${car.photoCount}/${V2_MAX_PHOTOS} fotos`,v2.vitrineId+'|'+car.carId));}
    select.replaceChildren(...options);
    if([...select.options].some((option)=>option.value===keep))select.value=keep;
    paintV2Photos();
  }
  async function addV2Photos(files){
    const target=v2Target(),status=$('import-v2-status');if(!target)return;
    const room=V2_MAX_PHOTOS-target.car.photoCount-v2Photos.photos.length;
    let taken=0;
    for(const file of [...files]){if(taken>=room){status.textContent=`Esta V2 aceita só mais ${Math.max(0,V2_MAX_PHOTOS-target.car.photoCount)} foto(s)`;break;}try{const blob=await resizePhoto(file);v2Photos.photos.push({blob,url:URL.createObjectURL(blob)});taken++;}catch(error){status.textContent=error.message==='TOO_LARGE'?'Uma foto passou de 5 MB mesmo reduzida':/\.hei[cf]$/i.test(file.name||'')||/hei[cf]/i.test(file.type||'')?'Foto HEIC não abriu neste navegador · Use JPEG ou PNG':'Um dos arquivos não é uma imagem';}}
    paintV2Photos();
  }
  function bindV2Photos(){
    const select=$('import-v2-select'),input=$('import-v2-file'),drop=$('import-v2-drop'),send=$('import-v2-send'),status=$('import-v2-status');if(!select)return;
    select.addEventListener('change',()=>{v2Photos.photos.forEach((photo)=>URL.revokeObjectURL(photo.url));v2Photos.photos=[];const target=v2Target();status.textContent=target&&target.car.photoCount>=V2_MAX_PHOTOS?'Esta V2 já tem 12 fotos':'';paintV2Photos();});
    input.addEventListener('change',()=>{addV2Photos(input.files);input.value='';});
    drop.addEventListener('dragover',(event)=>{event.preventDefault();drop.classList.add('over');});
    drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
    drop.addEventListener('drop',(event)=>{event.preventDefault();drop.classList.remove('over');addV2Photos(event.dataTransfer.files);});
    $('import-v2-open').addEventListener('click',()=>{const target=v2Target();if(target)window.open(target.v2.link,'_blank','noopener');});
    send.addEventListener('click',async()=>{
      const target=v2Target();if(!target||v2Photos.busy||send.parentElement.parentElement.querySelector('.inline-confirm'))return;
      // The V2 link already went to the customer: the photos show up there as soon as they are saved.
      const count=v2Photos.photos.length;
      if(!(await askInline(send.parentElement,`${count} foto(s) vão aparecer imediatamente no link da V2 que o cliente já recebeu · Salvar mesmo assim?`,'Salvar fotos')))return;
      const chosen=v2Target();if(!chosen||chosen.car.carId!==target.car.carId||!v2Photos.photos.length||v2Photos.busy)return;
      v2Photos.busy=true;paintV2Photos();let sent=0;
      try{
        while(v2Photos.photos.length){const photo=v2Photos.photos[0];status.textContent=`Enviando foto ${sent+1}…`;await request('/api/panel/vitrine-photos?vitrineId='+encodeURIComponent(target.v2.vitrineId)+'&carId='+encodeURIComponent(target.car.carId),{method:'POST',headers:{'content-type':'application/octet-stream'},body:photo.blob});URL.revokeObjectURL(photo.url);v2Photos.photos.shift();sent++;}
        status.textContent=`${sent} foto(s) enviada(s) para esta V2`;
      }catch(error){status.textContent=(error.code==='PHOTO_LIMIT_REACHED'?'Esta V2 chegou a 12 fotos':error.code==='PHOTO_NOT_IMAGE'?'Uma foto foi recusada: não é imagem':error.code==='PHOTO_TOO_LARGE'?'Uma foto passou de 5 MB':'Não consegui enviar a foto')+(sent?` · ${sent} já enviada(s), as outras continuam aqui`:'');}
      v2Photos.busy=false;await loadV2Photos();
    });
  }
  bindV2Photos();

  /* ===== Montar V2: vitrine nova, so com o carro pedido, ligada a V1 ===== */
  const V2_MAX_PHOTOS=12,V2_MAX_SIDE=1600,V2_MAX_BYTES=5*1024*1024;
  function resizePhoto(file){return new Promise((resolve,reject)=>{if(!/^image\//.test(file.type||'')){reject(Error('NOT_IMAGE'));return;}const url=URL.createObjectURL(file),image=new Image();image.onload=()=>{const scale=Math.min(1,V2_MAX_SIDE/Math.max(image.naturalWidth,image.naturalHeight));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);URL.revokeObjectURL(url);canvas.toBlob((blob)=>{if(!blob){reject(Error('RESIZE_FAILED'));return;}if(blob.size>V2_MAX_BYTES){reject(Error('TOO_LARGE'));return;}resolve(blob);},'image/jpeg',0.85);};image.onerror=()=>{URL.revokeObjectURL(url);reject(Error('NOT_IMAGE'));};image.src=url;});}
  const dollarsText=(cents)=>cents?String(Math.round(Number(cents)/100)):'';
  function openV2Builder(request,card){
    const existing=card.querySelector('.v2-builder');if(existing){existing.remove();return;}
    const box=element('section','v2-builder'),photos=[];
    box.append(element('h4','',request.car||'Carro'));
    const status=element('p','muted v2-status','');
    const drop=element('label','v2-drop','Arraste as fotos aqui ou toque para escolher · até 12 · a primeira é a capa');
    const input=element('input');input.type='file';input.accept='image/*';input.multiple=true;input.className='visually-hidden';drop.append(input);
    const thumbs=element('div','v2-thumbs');
    const paint=()=>{thumbs.replaceChildren();photos.forEach((photo,index)=>{const item=element('div','v2-thumb');const img=element('img');img.src=photo.url;img.alt='';const remove=element('button','quiet small','×');remove.type='button';remove.setAttribute('aria-label','Remover foto');remove.addEventListener('click',()=>{URL.revokeObjectURL(photo.url);photos.splice(index,1);paint();});item.append(img,remove);if(index===0)item.append(element('span','v2-cover','Capa'));thumbs.append(item);});};
    const add=async(files)=>{for(const file of [...files]){if(photos.length>=V2_MAX_PHOTOS){status.textContent='Máximo de 12 fotos';break;}try{const blob=await resizePhoto(file);photos.push({blob,url:URL.createObjectURL(blob)});}catch(error){status.textContent=error.message==='TOO_LARGE'?'Uma foto passou de 5 MB mesmo reduzida':/\.hei[cf]$/i.test(file.name||'')||/hei[cf]/i.test(file.type||'')?'Foto HEIC não abriu neste navegador · Use JPEG ou PNG':'Um dos arquivos não é uma imagem';}}paint();};
    input.addEventListener('change',()=>{add(input.files);input.value='';});
    drop.addEventListener('dragover',(event)=>{event.preventDefault();drop.classList.add('over');});
    drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
    drop.addEventListener('drop',(event)=>{event.preventDefault();drop.classList.remove('over');add(event.dataTransfer.files);});
    const limitLabel=element('label','','Limite do cliente (US$) · em branco esconde o bloco');const limit=element('input');limit.type='text';limit.inputMode='numeric';limit.value=dollarsText(request.budgetCents);limitLabel.append(limit);
    const noteLabel=element('label','','Nota (opcional)');const note=element('textarea');note.rows=2;note.maxLength=1200;noteLabel.append(note);
    const generate=element('button','small','Gerar link da V2');generate.type='button';
    const result=element('div','inline-actions v2-result hidden');
    // A22: a retry reuses the same V2 (server side) and only sends the photos that did not go yet
    const sent={vitrineId:null,blobs:new Set()};
    generate.addEventListener('click',async()=>{
      generate.disabled=true;status.textContent='Criando a V2…';
      // B4: the typed amount goes as text; the server reads "20,000.50", "25k" and "US$ 25.000"
      const typedLimit=limit.value.trim();
      try{
        const created=await request('/api/panel/vitrines',{method:'POST',body:JSON.stringify({requestId:request.id,customerLimitCents:typedLimit||null,noteText:note.value.trim()||null})});
        if(sent.vitrineId!==created.vitrineId){sent.vitrineId=created.vitrineId;sent.blobs=new Set();}
        for(let index=0;index<photos.length;index++){if(sent.blobs.has(photos[index].blob))continue;status.textContent=`Enviando foto ${index+1} de ${photos.length}…`;await request('/api/panel/vitrine-photos?vitrineId='+encodeURIComponent(created.vitrineId)+'&carId='+encodeURIComponent(created.carId),{method:'POST',headers:{'content-type':'application/octet-stream'},body:photos[index].blob});sent.blobs.add(photos[index].blob);}
        const link=location.origin+created.link,message=`${request.name}, here's the car you asked to see\n${link}`;
        status.textContent='V2 pronta';result.replaceChildren();
        const view=element('button','quiet small','Ver como o cliente vê');view.type='button';view.addEventListener('click',()=>window.open(created.link,'_blank','noopener'));
        const copyText=async(text,done)=>{try{await navigator.clipboard.writeText(text);status.textContent=done;}catch(_){status.textContent=`Não consegui copiar · Link: ${link}`;}};
        const copyLink=element('button','quiet small','Copiar link');copyLink.type='button';copyLink.addEventListener('click',()=>copyText(link,'Link copiado'));
        const copyMessage=element('button','small','Copiar mensagem com link');copyMessage.type='button';copyMessage.addEventListener('click',()=>copyText(message,'Mensagem copiada'));
        result.append(view,copyLink,copyMessage);result.classList.remove('hidden');
      }catch(error){status.textContent=error.code==='VITRINE_REQUEST_TREATED'?'Este pedido já foi tratado':error.code==='MANHEIM_AUDIT_PENDING'?'A conferência deste pedido ainda não liberou a V2':error.code==='VITRINE_SOURCE_MISSING'||error.code==='MANHEIM_MATCH_WITHOUT_MMR'?'O carro original não tem MMR confirmado, a V2 não pode ser montada':error.code==='VITRINE_LIMIT_INVALID'?'Limite inválido · Use um valor entre US$ 1,000 e US$ 10,000,000, ou deixe em branco':error.code==='PHOTO_NOT_IMAGE'?'Uma foto foi recusada: não é imagem':error.code==='PHOTO_TOO_LARGE'?'Uma foto passou de 5 MB':sent.blobs.size?`Parei na foto ${sent.blobs.size+1}. Tente de novo: a mesma V2 continua de onde parou`:'Não consegui gerar a V2 · tente de novo';generate.disabled=false;}
    });
    box.append(drop,thumbs,limitLabel,noteLabel,generate,status,result);
    card.append(box);
  }

  function renderVitrineRequests(data) {
    const root=$('vitrine-requests'),signals=$('vitrine-signals');if(!root||!signals)return;
    root.replaceChildren();signals.replaceChildren();
    const requests=Array.isArray(data?.requests)?data.requests:[];
    vitrineRequestCount=requests.length;
    const group=(kind,title)=>{
      const list=requests.filter((request)=>request.kind===kind);const block=element('section','request-group');block.append(element('h3','',`${title} (${list.length})`));
      list.forEach((request)=>{
        const card=element('article','vitrine-request-card');
        card.append(element('strong','',request.name),element('span','muted',`${request.phone||'Sem telefone'} · Ref ${request.referenceCode||'—'} · pediu pelo WhatsApp ${request.ago||''}`),element('span','',request.car||'Carro não informado'));
        const auction=request.endsAt||request.startsAt;if(auction)card.append(element('span','auction-alert',`Leilão ${relativeAuction(auction)} · ${formatDate(auction)}`));
        if(request.referred)card.append(makeBadge(`Número novo pelo link de ${request.ownerName} (${request.ownerRef||'sem Ref'}) · provável indicação`,'yellow'));
        if(request.kind==='BID'&&request.depositUsd)card.append(element('span','v2-deposit',`Próximo passo: pedir o depósito · US$ ${Number(request.depositUsd).toLocaleString('en-US')}`));else if(request.kind==='BID'&&request.referred)card.append(element('span','v2-deposit','Próximo passo: pedir o depósito · valor a definir com o cliente novo'));const actions=element('div','inline-actions');const build=element('button','quiet small','Montar V2');build.type='button';build.disabled=!request.vitrineCarId;build.addEventListener('click',()=>openV2Builder(request,card));
        const open=element('button','quiet small','Abrir conversa');open.type='button';open.addEventListener('click',()=>request.journeyId&&openDetail('ficha',request.journeyId));open.disabled=!request.journeyId;
        const treated=element('button','small','Tratado');treated.type='button';
        // M26/D18: the failure is shown on the card, Desfazer handles its own failure and the counters follow
        MCSAction.bind(treated,()=>({scope:card,successScope:root,feedbackKey:`vitrine-request:${request.id}`,
          optimistic:()=>{card.classList.add('action-optimistic-hidden');},
          commit:()=>requestApi('/api/panel/vitrine-requests',{action:'treat',requestId:request.id}),
          rollback:()=>{card.classList.remove('action-optimistic-hidden');},
          successText:'Marcado como tratado',
          undo:{commit:()=>requestApi('/api/panel/vitrine-requests',{action:'undo',requestId:request.id}),successText:'Voltou para a lista',refresh:()=>{loadCurrent('today',viewRequestVersion);refreshCounters().catch(()=>{});}},
          refresh:()=>refreshCounters().catch(()=>{}),
          errorText:'Não consegui marcar como tratado, tente de novo'}));actions.append(build,open,treated);card.append(actions);block.append(card);
      });
      root.append(block);
    };
    group('VIEW','V1 · Pediram para ver o carro');group('BID','V2 · Querem dar lance');
    (data?.signals||[]).forEach((signal)=>signals.append(element('span','vitrine-signal',`Ref ${signal.referenceCode||'—'} · ${signal.text}`)));
  }

  function relativeAuction(value){const hours=Math.max(0,Math.ceil((Date.parse(value)-Date.now())/3600000));return hours>=24?`em ${Math.floor(hours/24)} dia${Math.floor(hours/24)===1?'':'s'} ${hours%24} h`:`em ${hours} h`;}
  async function requestApi(url,body){return request(url,{method:'POST',body:JSON.stringify(body)});}

  function renderToday(items, preserveAll=false) {
    const root = $('today-list');
    const stats = $('today-stats');
    root.replaceChildren();
    stats.replaceChildren();
    if(!preserveAll)todayItems = items.slice();
    const all=preserveAll?todayItems:items.slice(),counts={all:all.length,with:all.filter(hasRef).length,without:all.filter((item)=>!hasRef(item)).length};
    document.querySelectorAll('[data-today-ref]').forEach((button)=>{button.classList.toggle('active',button.dataset.todayRef===todayRefFilter);const count=button.querySelector('span');if(count)count.textContent=String(counts[button.dataset.todayRef]||0);});
    items=all.filter((item)=>todayRefFilter==='all'||(todayRefFilter==='with'?hasRef(item):!hasRef(item))).sort((a,b)=>{const ao=a.next_action_at&&Date.parse(a.next_action_at)<Date.now()?1:0,bo=b.next_action_at&&Date.parse(b.next_action_at)<Date.now()?1:0;return bo-ao;});
    setCount('today', all.length+vitrineRequestCount);
    const stat = (value, label) => {
      const block = element('div', 'today-stat');
      block.append(element('strong', '', value), element('span', '', label));
      stats.append(block);
    };
    // M8: "aguardando você" counts only people whose last real message is theirs.
    stat(items.filter((item) => item.awaitingReply).length, 'Aguardando você');
    stat(items.length, 'Na lista');
    if (items.some((item) => item.heat)) stat(items.filter((item) => item.heat === 'HOT').length, 'Quentes');
    if (items.some((item) => item.searchStage)) {
      stat(items.filter((item) => item.searchStage === 'MISSING').length, 'Falta buscar');
      stat(items.filter((item) => item.searchStage === 'SENT').length, 'Opções enviadas');
    }
    if (!items.length) return empty(root, 'Nada pendente para hoje');
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
      (item.todayReasons || []).forEach((reason) => badges.append(makeBadge(reason.detail ? `${reason.label} · ${reason.detail}` : reason.label, reason.urgency === 'red' ? 'red' : 'yellow')));
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

  // One calculator order card (Ref). Lote 4: used by the ENTRADA section that replaces PEDIDOS.
  function orderCard(item, linkTargets, refresh = refreshCurrentPreservingState) {
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
    // One person, two separate requests: each mode has its own badge (never a combined one).
    const itemModes = (item.logicalModes && item.logicalModes.length ? item.logicalModes : [item.logicalMode]).filter((mode) => mode === 'VALOR' || mode === 'CARRO');
    if (itemModes.length) itemModes.forEach((mode) => badges.append(makeBadge(mode === 'VALOR' ? 'Por valor' : 'Por ano e milhagem', mode === 'VALOR' ? 'blue' : 'green')));
    else if (item.simulationCount <= 1) badges.append(makeBadge('PEDIDO'));
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
      MCSAction.bind(button,()=>{const [journeyId,contactId]=select.value.split('|');return{scope:card,optimistic:()=>{button.textContent='Ligando…';},commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'link_request',journeyId,contactId,calcRef:item.ref})}),rollback:()=>{button.textContent='Ligar a um lead';},refresh:refresh,errorText:'Não consegui salvar, tente de novo'};});
      form.append(label, button);
      card.append(form);
    }

    const openOrder = element('button', 'quiet small', item.kind === 'CALCULATOR' ? 'Abrir pedido' : 'Abrir ficha'); openOrder.type = 'button';
    openOrder.addEventListener('click', (event) => { event.stopPropagation(); if (item.kind === 'CALCULATOR') openDetail('order', item.ref); else if (item.journeyId) openDetail('ficha', item.journeyId); });
    card.append(openOrder, dispositionControls(item));

    makeCardClickable(card, () => {
      if (item.kind === 'CALCULATOR') openDetail('order', item.ref);
      else if (item.journeyId) openDetail('ficha', item.journeyId);
    });
    return card;
  }

  function renderQualification(items) {
    const root = $('qualification-list');
    root.replaceChildren();
    setCount('qualification', items.length);
    if (!items.length) return empty(root, 'Nenhuma jornada para qualificar');
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

  // One demand = one person in one mode. VALOR shows make, model and bid; CARRO shows make,
  // model, trim, years and mileage. The two never borrow each other's criteria.
  function demandSummary(demand) {
    const wishes = (demand && demand.wishes || []).slice(0, 5);
    const number = (value) => Number(value).toLocaleString('pt-BR');
    if (demand && demand.mode === 'VALOR') return `${wishes.map((wish) => [wish.make, wish.model].filter(Boolean).join(' ')).join(' | ')}${demand.bidCents ? ` · lance até ${formatMoney(demand.bidCents)}` : ''}`;
    return wishes.map((wish) => [[wish.make, wish.model, wish.trim].filter(Boolean).join(' '), `${wish.yearMin} a ${wish.yearMax}`, `${number(wish.minMiles)} a ${number(wish.maxMiles)} milhas`].join(' · ')).join(' | ');
  }

  function wishlistSummary(wishlist, budgetCents) {
    const wishes = Array.isArray(wishlist) ? wishlist : [wishlist || {}];
    const vehicles = wishes.slice(0, 5).map((wish) => {
      const years = wish.yearMin && wish.yearMax ? `${wish.yearMin}–${wish.yearMax}` : wish.yearMin ? `${wish.yearMin} ou mais novo` : wish.yearMax ? `até ${wish.yearMax}` : 'ano não informado';
      const miles = wish.maxMiles ? `até ${Number(wish.maxMiles).toLocaleString('pt-BR')} milhas` : 'milhagem não informada';
      return `${wish.make || 'Marca não informada'} ${wish.model || 'modelo não informado'} · ${years} · ${miles}`;
    });
    return `${vehicles.join(' | ')}${budgetCents ? ` · lance até ${formatMoney(budgetCents)}` : ''}`;
  }

  function downloadShortlist(matches, referenceCode) {
    if (!matches.length) return;
    const plain = (value) => String(value || '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').slice(0, 105);
    const escape = (value) => plain(value).replace(/[\\()]/g, '\\$&');
    const lines = [`MY CAR SCOUT - SHORTLIST - REF ${plain(referenceCode || '')}`,
      ...matches.slice(0, 44).map((match) => {
        const vehicle = match.vehicle_json.parsed || match.vehicle_json.raw || {};
        const miles = vehicle.miles ?? vehicle.Miles;
        return [vehicle.year || vehicle.Year, vehicle.make || vehicle.Make, vehicle.model || vehicle.Model,
          miles !== null && miles !== undefined && miles !== '' && Number.isFinite(Number(miles)) ? `${Number(miles).toLocaleString('en-US')} mi` : '',
          vehicle.locationDisplay || vehicle.location || ''].filter(Boolean).join(' | ');
      }),
      // P19.10: the page holds 44 cars; the rest is said, never cut in silence
      ...(matches.length > 44 ? [`+ ${matches.length - 44} more cars not listed on this page`] : [])];
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

  // Unknown odometer is shown as unknown, never as 0 miles (R3e).
  const milesText = (miles) => miles === null || miles === undefined || miles === '' || !Number.isFinite(Number(miles)) ? 'milhagem não informada' : `${Number(miles).toLocaleString('pt-BR')} milhas`;
  const mmrLabel = (code) => window.MCSVehicleMatch ? MCSVehicleMatch.mmrStatusLabel(code) : code;
  // Match kinds: BATE (criteria met), POR_VALOR (bid range; call to define year/mileage), QUASE.
  const kindLabel = (kind) => window.MCSVehicleMatch ? MCSVehicleMatch.kindLabel(kind) : kind;
  const kindTone = (kind) => kind === 'BATE' ? 'green' : kind === 'POR_VALOR' ? 'blue' : 'yellow';
  const kindClass = (kind) => kind === 'BATE' ? 'match' : kind === 'POR_VALOR' ? 'value' : 'near';

  // MANHEIM_MATCH_AUDIT on screen: one status per demand. Off, nothing shows and V1 works as before.
  const AUDIT_OK=['CONFERIDO','APROVADO_MANUAL'];
  const auditOn=()=>manheimData?.audit?.state==='LIGADA';
  const auditEntry=(demand)=>auditOn()&&demand?manheimData.audit.byDemand?.[demand.key]||{status:'CONFERINDO',label:'Conferindo',divergences:[]}:null;
  const auditAllows=(demand)=>!auditOn()||!demand||AUDIT_OK.includes(auditEntry(demand).status);
  // Not read yet (no row, or no car selected when the page loaded): "Gerar link V1" asks the server
  // to check this demand first; the server still decides.
  const AUDIT_CHECK_FIRST=['CONFERINDO','SEM_SELECAO'];
  const auditCanTry=(demand)=>auditAllows(demand)||AUDIT_CHECK_FIRST.includes(auditEntry(demand).status);
  // Why a reading is pending, in words (never a bare code).
  function auditPendingText(entry){
    const code=entry?.errorCode;
    if(code==='OPENAI_BUDGET_LIMIT'||code==='OPENAI_BUDGET_UNAVAILABLE')return 'Sem saldo no teto de US$ 50 da OpenAI · Nada foi cobrado';
    if(code==='AUDIT_DEADLINE')return `Tempo esgotado antes de terminar a conferência (${entry.attempts||0} ${entry.attempts===1?'tentativa':'tentativas'})`+(entry.canRetry?'':' · Sem nova tentativa: V1 bloqueada, aprove com motivo se conferir à mão');
    return 'A IA não respondeu · As opções continuam visíveis, sem aprovação automática';
  }
  const AUDIT_TONES={CONFERIDO:'green',APROVADO_MANUAL:'green',REVISAR:'red'};
  function auditBlock(demand,matches){
    const entry=auditEntry(demand);if(!entry)return null;
    const box=element('div','audit-block');box.dataset.auditStatus=entry.status;
    box.append(makeBadge(entry.label||entry.status,AUDIT_TONES[entry.status]||'yellow'));
    const carName=(matchId)=>{const parsed=(matches||[]).find((match)=>match.id===matchId)?.vehicle_json?.parsed;return parsed?[parsed.year,parsed.make,parsed.model].filter(Boolean).join(' ')+(parsed.vin?` · VIN final ${String(parsed.vin).slice(-6)}`:''):'';};
    (entry.divergences||[]).slice(0,8).forEach((item)=>{const car=carName(item.matchId);box.append(element('p','audit-divergence',car?`${car}: ${item.text}`:item.text));});
    if(entry.status==='PENDENTE')box.append(element('p','muted',auditPendingText(entry)));
    if(entry.status==='SEM_SELECAO'&&entry.lastStatus==='PENDENTE')box.append(element('p','muted','Última conferência: '+auditPendingText(entry)));
    if(entry.approvedReason)box.append(element('p','muted',`Aprovado à mão · ${entry.approvedReason}`));
    const actions=element('div','inline-actions');
    if(entry.canRetry){const retry=element('button','quiet small','Tentar de novo');retry.type='button';MCSAction.bind(retry,()=>({scope:box,commit:()=>request('/api/panel/manheim-audit',{method:'POST',body:JSON.stringify({action:'retry',key:demand.key})}),refresh:()=>loadCurrent(),errorText:'Não consegui conferir de novo, tente mais tarde'}));actions.append(retry);}
    if(entry.canApprove){const reason=element('input','audit-reason');reason.type='text';reason.maxLength=300;reason.placeholder='Motivo da aprovação';reason.setAttribute('aria-label','Motivo da aprovação manual');const approve=element('button','quiet small','Aprovar com motivo');approve.type='button';MCSAction.bind(approve,()=>({scope:box,commit:()=>{if(reason.value.trim().length<5)throw Object.assign(Error('AUDIT_REASON_REQUIRED'),{code:'AUDIT_REASON_REQUIRED'});return request('/api/panel/manheim-audit',{method:'POST',body:JSON.stringify({action:'approve',key:demand.key,reason:reason.value.trim()})});},refresh:()=>loadCurrent(),errorText:(error)=>error?.code==='AUDIT_REASON_REQUIRED'?'Escreva o motivo, com pelo menos 5 letras':'Não consegui aprovar, tente de novo'}));actions.append(reason,approve);}
    if(actions.childElementCount)box.append(actions);
    if(!AUDIT_OK.includes(entry.status))box.append(element('p','muted','V1 e V2 deste pedido ficam liberadas depois da conferência'));
    return box;
  }
  function renderAuditNote(audit){
    const note=$('manheim-audit-note');if(!note)return;note.replaceChildren();
    const waiting=audit&&audit.state==='LIGADA'&&audit.run&&audit.run.status==='AGUARDANDO_AUTORIZACAO';
    note.classList.toggle('hidden',!waiting);if(!waiting)return;
    const cost=(value)=>'US$ '+Number(value||0).toFixed(2);
    note.append(element('p','',`Conferência estimada em ${cost(audit.run.estimateUsd)}, acima do limite de ${cost(audit.run.limitUsd??audit.limitUsd)} deste lote. Nada foi cobrado`));
    const authorize=element('button','small','Autorizar conferência');authorize.type='button';
    MCSAction.bind(authorize,()=>({scope:note,commit:()=>request('/api/panel/manheim-audit',{method:'POST',body:JSON.stringify({action:'authorize'})}),refresh:()=>loadCurrent(),errorText:(error)=>error?.code==='AUDIT_ADMIN_ONLY'?'Só o administrador autoriza':'Não consegui autorizar, tente de novo'}));
    note.append(authorize);
  }
  const MANHEIM_PAGE_ROWS = 10;
  // Counts of a demand, answered by the server (no car is loaded for this).
  const demandCountsBadge = (demand) => {
    const parts = [`${demand.bateCount || 0} BATE`];
    if (demand.porValorCount) parts.push(`${demand.porValorCount} POR VALOR`);
    return makeBadge(parts.join(' · '), demand.bateCount ? 'green' : demand.porValorCount ? 'blue' : 'yellow');
  };
  // The options of ONE demand arrive only when the operator opens it, 10 at a time, in the order of
  // the server (BATE, POR VALOR, lowest mileage) and with a stable cursor.
  function lazyOptions(card, demand, loaded, renderRow, filter) {
    const table = element('div', 'manheim-table');
    const button = element('button', 'quiet small manheim-options-toggle', `Ver opções (${demand.matchCount})`);
    button.type = 'button';
    let cursor = null, busy = false, pages = 0;
    const loadPage = async () => {
      if (busy) return;
      busy = true; button.disabled = true; button.textContent = 'Carregando…';
      try {
        const params = new URLSearchParams({ key: demand.key, limit: String(MANHEIM_PAGE_ROWS) });
        if (cursor) params.set('cursor', cursor);
        const page = await request('/api/panel/manheim-options?' + params.toString());
        pages += 1;
        (page.options || []).filter((option) => !filter || filter(option)).forEach((option) => { loaded.push(option); table.insertBefore(renderRow(option), button); });
        cursor = page.nextCursor || null;
        button.classList.toggle('manheim-more', Boolean(cursor));
        if (cursor) { button.textContent = `Ver mais (${Math.max(demand.matchCount - loaded.length, 1)})`; button.disabled = false; }
        else { button.remove(); if (!loaded.length) table.append(element('p', 'muted manheim-options-note', 'Nenhuma opção neste pedido agora')); }
        card.dispatchEvent(new CustomEvent('options-loaded'));
      } catch (failure) {
        console.error(failure);
        button.disabled = false;
        button.textContent = pages ? 'Não consegui carregar mais, tentar de novo' : 'Não consegui carregar as opções, tentar de novo';
      } finally { busy = false; }
    };
    button.addEventListener('click', (event) => { event.stopPropagation(); loadPage(); });
    table.append(button);
    return table;
  }
  // Criterion changed after the import: the options were compared with the old one.
  function staleNotice(card, demand) {
    if (!demand || !demand.stale) return null;
    const box = element('div', 'warning inline-confirm');
    box.append(element('p', '', 'O critério desta busca mudou depois da importação · As opções abaixo podem não servir mais'));
    const again = element('button', 'small', 'Conferir novamente'); again.type = 'button';
    MCSAction.bind(again, () => ({ scope: box, optimistic: () => { again.textContent = 'Conferindo…'; }, commit: () => request('/api/panel/manheim-options', { method: 'POST', body: JSON.stringify({ action: 'rematch', key: demand.key }), timeoutMs: 60000 }), rollback: () => { again.textContent = 'Conferir novamente'; }, successText: 'Opções comparadas de novo com o critério atual', refresh: () => loadCurrent(), errorText: 'Não consegui conferir de novo, tente mais tarde' }));
    box.append(again);
    return box;
  }

  // ---------------------------------------------------------------- seleção para o cliente
  // Match interno não é opção: cada demanda mostra três grupos (Lane/Run, Buy Now/Make Offer/fora de
  // Lane-Run, informação incompleta), 10 carros por vez, e o operador escolhe no máximo 10 para a
  // V1/V2. O servidor confere tudo de novo; nada é escolhido nem enviado sozinho.
  const OFFER = window.MCSManheimOffer || null;
  const OFFER_ERRORS = {
    MANHEIM_SELECTION_LIMIT: 'Este pedido já tem 10 carros selecionados · Remova um antes de selecionar outro',
    MANHEIM_SELECTION_REASON_REQUIRED: 'Escreva o motivo da inclusão manual, com pelo menos 5 letras',
    MANHEIM_SELECTION_PCT_INVALID: 'Percentual inválido: use de 0 a 50',
    MANHEIM_MATCH_WITHOUT_MMR: 'Carro sem MMR válido não pode ser selecionado',
    MANHEIM_MATCH_NOT_FOUND: 'Este carro não está mais no lote ativo',
    MANHEIM_SELECTION_PENDING: 'Seleção indisponível · O painel precisa de uma atualização para liberar este recurso · Avise o responsável'
  };
  const offerError = (error) => OFFER_ERRORS[error && error.code] || 'Não consegui salvar, tente de novo';
  const pctText = (value) => `${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
  const OFFER_STATUS = { SELECTED: 'Selecionado para cliente', EXCLUDED: 'Mantido fora', AVAILABLE: '' };
  function offerRow(option, state, groupKey) {
    const parsed = option.vehicle_json.parsed || {};
    const info = option.offer || {};
    const row = element('div', `manheim-row offer-row ${kindClass(option.match_kind)}`);
    row.dataset.matchId = option.id; row.dataset.status = info.status || 'AVAILABLE';
    const vehicle = element('div');
    vehicle.append(element('strong', '', [parsed.year, parsed.make, parsed.model, parsed.trim].filter(Boolean).join(' ')),
      element('span', 'muted', `${milesText(parsed.miles)}${parsed.locationDisplay || parsed.location ? ` · ${parsed.locationDisplay || parsed.location}` : ''}${parsed.startsAt || parsed.saleDate ? ` · ${parsed.startsAt || parsed.saleDate}` : ''}`));
    if (parsed.vin) vehicle.append(element('span', 'muted', `VIN: ${parsed.vin}`));
    const saleFacts = [parsed.lane ? `Lane ${parsed.lane}` : '', parsed.run ? `Run ${parsed.run}` : '', parsed.saleType || '', parsed.buyNowPrice && OFFER && OFFER.buyNowCents(parsed) ? `Buy Now ${parsed.buyNowPrice}` : ''].filter(Boolean);
    if (saleFacts.length) vehicle.append(element('span', 'muted', saleFacts.join(' · ')));
    const badges = element('div', 'badges');
    badges.append(makeBadge(kindLabel(option.match_kind), kindTone(option.match_kind)));
    if (info.cr !== null && info.cr !== undefined) badges.append(makeBadge(`CR ${info.cr}`, info.belowMinimum ? 'yellow' : 'green'));
    else badges.append(makeBadge('sem CR', 'yellow'));
    if (info.belowMinimum) badges.append(makeBadge(`Abaixo do CR recomendado (mínimo ${info.crMinimum})`, 'yellow'));
    if (option.criteriaChanged) badges.append(makeBadge('critério mudou desde o envio do CSV', 'yellow'));
    if (info.manual) badges.append(makeBadge('Inclusão manual', 'blue'));
    const statusBadge = makeBadge(OFFER_STATUS[info.status] || '', info.status === 'SELECTED' ? 'green' : 'yellow');
    statusBadge.classList.add('offer-status'); statusBadge.hidden = !OFFER_STATUS[info.status];
    badges.append(statusBadge);
    // Price: internal MMR, default markup, operator's markup and the value the customer sees.
    const price = element('div', 'offer-price');
    const pctInput = element('input', 'offer-pct'); pctInput.type = 'number'; pctInput.min = '0'; pctInput.max = '50'; pctInput.step = '0.1';
    pctInput.value = info.manualPct !== null && info.manualPct !== undefined ? String(info.manualPct) : String(info.defaultPct);
    pctInput.setAttribute('aria-label', 'Percentual ajustado');
    const finalValue = element('strong', 'offer-final', formatMoney(info.finalCents));
    const updateFinal = () => { const pct = OFFER ? OFFER.validPct(pctInput.value) : Number(pctInput.value); finalValue.textContent = OFFER && Number.isFinite(pct) ? formatMoney(OFFER.finalCents(info.mmrCents, pct)) : '—'; };
    pctInput.addEventListener('input', updateFinal);
    const note = element('input', 'offer-note'); note.type = 'text'; note.maxLength = 500; note.placeholder = 'Observação interna (opcional)'; note.value = info.note || '';
    price.append(element('span', 'muted', `MMR interno ${formatMoney(info.mmrCents)}`), element('span', 'muted', `Padrão ${pctText(info.defaultPct)}`),
      element('label', 'offer-pct-label', 'Ajustado '), pctInput, element('span', 'muted', 'Referência estimada para o cliente'), finalValue, note);
    price.querySelector('.offer-pct-label').append(pctInput);
    const actions = element('div', 'inline-actions offer-actions');
    const reason = element('input', 'offer-reason'); reason.type = 'text'; reason.maxLength = 300; reason.placeholder = 'Motivo da inclusão manual'; reason.value = info.manualReason || '';
    const send = (action) => request('/api/panel/manheim-options', { method: 'POST', body: JSON.stringify({ action, matchId: option.id, pct: pctInput.value === String(info.defaultPct) && info.manualPct === null ? null : pctInput.value, reason: reason.value.trim() || null, note: note.value.trim() || null }) });
    const apply = (result) => {
      Object.assign(info, { status: result.status, manual: result.manual, manualReason: result.manualReason, manualPct: result.manualPct, finalCents: result.finalCents, note: result.note });
      row.dataset.status = result.status; statusBadge.textContent = OFFER_STATUS[result.status] || ''; statusBadge.hidden = !OFFER_STATUS[result.status];
      finalValue.textContent = formatMoney(result.finalCents);
      state.setSelected(option.id, result.status === 'SELECTED', result.selectedCount);
      paintActions();
    };
    const button = (label, action, extra) => { const item = element('button', `small ${extra || ''}`.trim(), label); item.type = 'button'; item.dataset.offerAction = action;
      MCSAction.bind(item, () => ({ scope: row, commit: () => send(action), onSuccess: apply, errorText: offerError })); return item; };
    const selectButton = button('Selecionar para cliente', 'select');
    const manualButton = button('Incluir manualmente', 'select', 'quiet');
    const removeButton = button('Remover da seleção', 'remove', 'quiet');
    const excludeButton = button('Manter fora', 'exclude', 'quiet');
    const paintActions = () => {
      const selected = info.status === 'SELECTED';
      selectButton.hidden = selected || groupKey !== 'LANE';
      manualButton.hidden = selected || groupKey === 'LANE';
      reason.hidden = selected || groupKey === 'LANE';
      removeButton.hidden = !selected;
      excludeButton.hidden = info.status === 'EXCLUDED';
    };
    paintActions();
    // A percentage typed is kept by the server even before the car is selected.
    pctInput.addEventListener('change', () => { if (!OFFER || !Number.isFinite(OFFER.validPct(pctInput.value))) { finalValue.textContent = 'Percentual inválido'; return; }
      request('/api/panel/manheim-options', { method: 'POST', body: JSON.stringify({ action: 'price', matchId: option.id, pct: pctInput.value, note: note.value.trim() || null }) }).then(apply).catch((error) => { finalValue.textContent = offerError(error); }); });
    actions.append(reason, manualButton, selectButton, removeButton, excludeButton);
    row.append(vehicle, badges, price, actions);
    return row;
  }
  // One group of a demand: opened by the operator, 10 cars at a time, in the server's CR order.
  function offerGroup(demand, groupKey, count, state) {
    const details = element('details', 'offer-group');
    details.dataset.group = groupKey;
    details.append(element('summary', '', `${OFFER ? OFFER.GROUP_LABELS[groupKey] : groupKey} (${count})`));
    const list = element('div', 'manheim-table');
    const more = element('button', 'quiet small manheim-options-toggle', count ? `Ver opções (${count})` : 'Nenhum carro neste grupo');
    more.type = 'button'; more.disabled = !count;
    let cursor = null, loadedCount = 0, busy = false;
    const loadPage = async () => {
      if (busy) return; busy = true; more.disabled = true; more.textContent = 'Carregando…';
      try {
        const params = new URLSearchParams({ key: demand.key, group: groupKey, limit: String(MANHEIM_PAGE_ROWS) });
        if (cursor) params.set('cursor', cursor);
        const page = await request('/api/panel/manheim-options?' + params.toString());
        (page.options || []).forEach((option) => { loadedCount += 1; state.loaded.push(option); list.insertBefore(offerRow(option, state, groupKey), more); });
        cursor = page.nextCursor || null;
        if (cursor) { more.textContent = `Ver mais (${Math.max(count - loadedCount, 1)})`; more.disabled = false; } else more.remove();
      } catch (failure) {
        console.error(failure); more.disabled = false;
        more.textContent = failure && failure.code === 'MANHEIM_SELECTION_PENDING' ? OFFER_ERRORS.MANHEIM_SELECTION_PENDING : 'Não consegui carregar, tentar de novo';
      } finally { busy = false; }
    };
    more.addEventListener('click', (event) => { event.stopPropagation(); loadPage(); });
    details.addEventListener('toggle', () => { if (details.open && !loadedCount && count && !busy && cursor === null) loadPage(); });
    list.append(more); details.append(list);
    return details;
  }
  // Envio manual da V1 pelo WhatsApp (360dialog). Só depois de gerar a V1, sempre com confirmação:
  // o operador vê nome, telefone, texto e link, pode editar o texto e confirma com um segundo clique.
  // O destino é o telefone da ficha, decidido pelo servidor. Sem confirmação do WhatsApp o envio fica
  // "Não confirmado" e nada é tentado de novo sozinho.
  const V1_SEND_REASONS = {
    NO_VALID_PHONE: 'Ficha sem telefone de WhatsApp válido: envio pelo painel indisponível',
    V1_SEND_PENDING: 'Envio pelo painel indisponível · O painel precisa de uma atualização para liberar este recurso · Avise o responsável',
    OFF: 'Envio direto desligado em produção · Use "Abrir WhatsApp com mensagem pronta"'
  };
  const clock = (iso) => { const date = new Date(iso || Date.now()); return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
  function v1SendControls(demand, demo = null) {
    const node = element('div', 'v1-send');
    const button = element('button', 'small', 'Enviar no WhatsApp'); button.type = 'button'; button.disabled = true;
    const state = element('p', 'muted v1-send-state', 'Gere a V1 para enviar no WhatsApp');
    const fallback = element('a', 'quiet small hidden v1-send-fallback', 'Abrir WhatsApp com mensagem pronta');
    fallback.target = '_blank'; fallback.rel = 'noopener';
    // Approved message of the search's origin (Calculate My Cost or Find One For Me): only suggested,
    // editable and copied by the operator; nothing is sent from here.
    const suggestion = element('details', 'v1-suggestion hidden');
    const suggestionTitle = element('summary', '', 'Mensagem sugerida');
    const suggestionText = element('textarea', 'v1-suggestion-text'); suggestionText.rows = 8; suggestionText.maxLength = 4000;
    const copySuggestion = element('button', 'quiet small', 'Copiar mensagem sugerida'); copySuggestion.type = 'button';
    const suggestionNote = element('p', 'muted', 'Você revisa e decide se envia · Nada é enviado daqui');
    copySuggestion.addEventListener('click', async (event) => { event.stopPropagation(); try { await navigator.clipboard.writeText(suggestionText.value); suggestionNote.textContent = 'Mensagem copiada · Nada foi enviado'; } catch (_) { suggestionText.select(); suggestionNote.textContent = 'Não consegui copiar · Selecione o texto e copie'; } });
    suggestion.append(suggestionTitle, suggestionText, copySuggestion, suggestionNote);
    const showSuggestion = (data) => {
      if (!data || !data.text) { suggestion.classList.add('hidden'); return; }
      suggestionTitle.textContent = 'Mensagem sugerida · ' + (data.origin === 'VALOR' ? 'veio pela calculadora (Calculate My Cost)' : 'veio pelo Find One For Me');
      suggestionText.value = data.text; suggestion.classList.remove('hidden');
    };
    node.append(button, fallback, state, suggestion);
    let info = null;
    let token = null;
    let busy = false;
    const showLast = (last) => {
      if (!last) return;
      const simulated = last.simulated ? ' · simulado' : '';
      state.textContent = last.status === 'SENT' ? `Enviado às ${clock(last.at)}${simulated}`
        : last.status === 'UNCONFIRMED' ? 'Não confirmado pelo WhatsApp · Verifique a conversa antes de reenviar'
        : last.status === 'FAILED' ? 'Não enviado: o WhatsApp recusou o envio' : state.textContent;
      state.dataset.status = last.status;
      if (['SENT', 'UNCONFIRMED', 'FAILED'].includes(last.status)) button.textContent = 'Reenviar';
    };
    const setFallback = (href) => { if (href) { fallback.href = href; fallback.classList.remove('hidden'); } };
    async function setVitrine(newToken) {
      token = newToken; info = null; button.disabled = true; button.textContent = 'Enviar no WhatsApp'; showSuggestion(null);
      state.textContent = 'Conferindo o destino…'; delete state.dataset.status;
      try {
        info = await request('/api/panel/v1-send', { method: 'POST', body: JSON.stringify({ action: demo ? 'demo_prepare' : 'prepare', token, baseUrl: location.origin, ...(demo || {}), ...(demand?.key ? { demandKey: demand.key } : {}) }) });
      } catch (failure) {
        if (demo && demo.onUnavailable) { demo.onUnavailable(); return; }
        state.textContent = V1_SEND_REASONS[failure && failure.code] || 'Não consegui preparar o envio · Use "Copiar mensagem com link"';
        return;
      }
      showSuggestion(info);
      if (!info.eligible) { state.textContent = V1_SEND_REASONS[info.reason] || V1_SEND_REASONS.NO_VALID_PHONE; return; }
      setFallback(info.whatsappLink);
      if (info.mode === 'OFF') { state.textContent = V1_SEND_REASONS.OFF; return; }
      state.textContent = `Para ${info.name} · ${info.phone}${info.mode === 'SIMULATED' ? ' · envio simulado neste ambiente' : ''}`;
      button.disabled = false;
      showLast(info.last);
    }
    function openConfirm() {
      if (!info || busy || node.querySelector('.v1-send-confirm')) return;
      const resend = button.textContent === 'Reenviar';
      const requestKey = crypto.randomUUID();
      const box = element('div', 'warning inline-confirm v1-send-confirm');
      box.append(element('p', '', `${resend ? 'Reenviar' : 'Enviar'} para ${info.name} · ${info.phone}`),
        element('p', 'muted', `Link V1: ${info.link}`));
      if (!info.origin) box.append(element('p', 'muted', 'Origem da busca não identificada: escreva a mensagem (o link da V1 precisa ficar no texto)'));
      const label = element('label', '', 'Mensagem');
      const textarea = element('textarea', 'v1-send-text'); textarea.rows = 9; textarea.maxLength = 4000; textarea.value = info.text || info.link;
      label.append(textarea);
      const yes = element('button', 'small', 'Confirmar envio'); yes.type = 'button';
      const no = element('button', 'quiet small', 'Cancelar'); no.type = 'button';
      box.append(label, yes, no);
      no.addEventListener('click', () => box.remove());
      yes.addEventListener('click', async () => {
        if (busy) return;
        busy = true; yes.disabled = true; no.disabled = true; textarea.disabled = true; button.disabled = true;
        yes.textContent = 'Enviando…';
        try {
          const result = await request('/api/panel/v1-send', { method: 'POST', timeoutMs: 30000, body: JSON.stringify({ action: demo ? 'demo_send' : 'send', token, text: textarea.value, requestKey, confirmed: true, resend, ...(demo || {}), ...(demand?.key ? { demandKey: demand.key } : {}) }) });
          box.remove();
          showLast({ status: result.sendStatus, at: result.at, simulated: result.simulated });
        } catch (failure) {
          box.remove();
          const code = failure && failure.code;
          if (code === 'WINDOW_CLOSED') { state.textContent = 'Fora da janela de 24 h do WhatsApp: não foi enviado · Use "Abrir WhatsApp com mensagem pronta"'; setFallback(failure.whatsappLink || info.whatsappLink); }
          else if (code === 'V1_ALREADY_SENT') { state.textContent = 'Esta V1 já foi enviada'; button.textContent = 'Reenviar'; }
          else if (code === 'SEND_IN_PROGRESS') state.textContent = 'Já existe um envio desta V1 em andamento';
          else if (code === 'V1_DIRECT_SEND_DISABLED') state.textContent = V1_SEND_REASONS.OFF;
          else if (code === 'V1_SEND_PENDING') state.textContent = V1_SEND_REASONS.V1_SEND_PENDING;
          else if (['TEXT_REQUIRED', 'TEXT_TOO_LONG', 'V1_LINK_MISSING'].includes(code)) state.textContent = code === 'V1_LINK_MISSING' ? 'A mensagem precisa conter o link da V1 · Nada foi enviado' : 'Mensagem vazia ou longa demais · Nada foi enviado';
          else { state.textContent = 'Não confirmado: sem resposta do servidor · Verifique a conversa antes de reenviar'; state.dataset.status = 'UNCONFIRMED'; button.textContent = 'Reenviar'; }
        } finally { busy = false; button.disabled = !info || info.mode === 'OFF'; }
      });
      node.append(box);
      textarea.focus();
    }
    button.addEventListener('click', (event) => { event.stopPropagation(); openConfirm(); });
    node.addEventListener('click', (event) => event.stopPropagation());
    return { node, setVitrine };
  }

  // Selection not available on this database (migration pending): the list below is only internal
  // matches and V1 stays blocked by the server.
  function offerPendingNote() {
    return element('p', 'warning offer-pending', 'Seleção para o cliente indisponível · O painel precisa de uma atualização para liberar este recurso · Avise o responsável · A lista abaixo mostra só as combinações internas e a V1 fica bloqueada');
  }
  function offerSection(card, demand) {
    const offerCounts = demand.offer;
    const state = { loaded: [], selectedIds: new Set(offerCounts.selectedIds || []), listeners: [] };
    const box = element('div', 'offer-section');
    const counter = element('p', 'offer-counter');
    const auditText = auditOn() ? `Conferência: ${auditEntry(demand).label || auditEntry(demand).status}` : 'Conferência desligada';
    const paint = () => { counter.textContent = `${demand.matchCount} matches internos · ${offerCounts.lane} passam em Lane/Run · ${offerCounts.offLane} Buy Now / Make Offer / fora de Lane-Run · ${offerCounts.incomplete} incompletos · Selecionados ${state.selectedIds.size} de ${offerCounts.max || 10} · ${auditText}`; };
    state.setSelected = (id, on, total) => { if (on) state.selectedIds.add(id); else state.selectedIds.delete(id); paint(); state.listeners.forEach((listener) => listener()); };
    paint();
    box.append(counter, offerGroup(demand, 'LANE', offerCounts.lane, state), offerGroup(demand, 'OFFLANE', offerCounts.offLane, state), offerGroup(demand, 'INCOMPLETE', offerCounts.incomplete, state));
    card.offerState = state;
    return box;
  }

  // Exemplo fictício do Preview para conferir o envio da V1: dados inventados, nada é lido nem
  // gravado no banco e o 360dialog nunca é chamado. Só aparece quando o servidor aceita o exemplo
  // (fora de produção); em produção a ação não existe e o cartão some.
  function renderV1Demo() {
    const panel = $('searches-panel'), anchor = $('manheim-results');
    if (!panel || !anchor || $('v1-demo')) return;
    const box = element('section', 'card v1-demo'); box.id = 'v1-demo';
    box.append(element('h2', '', 'EXEMPLO FICTÍCIO · envio da V1'),
      element('p', 'warning', 'Só neste Preview · Cliente, telefone e link inventados · Nada é gravado no banco nem enviado ao WhatsApp'));
    const cards = [
      { title: 'Veio pela calculadora · janela de 24 h aberta', demo: { origin: 'VALOR', window: 'open', card: 'calculadora' } },
      { title: 'Veio pelo Find One For Me · fora da janela de 24 h', demo: { origin: 'CARRO', window: 'closed', card: 'find-one' } }
    ];
    cards.forEach((item) => {
      const card = element('article', 'item-card v1-demo-card');
      card.append(element('h3', '', item.title));
      const controls = v1SendControls(null, { ...item.demo, onUnavailable: () => box.remove() });
      card.append(controls.node); box.append(card);
      controls.setVitrine('EXEMPLO-FICTICIO-NAO-E-CLIENTE');
    });
    panel.insertBefore(box, anchor);
  }
  function renderManheimGroup(root, journey, reactivation, demand) {
    const card = element('article', 'item-card manheim-lead');
    card.dataset.mode = demand?.mode || '';
    card.dataset.demandKey = demand?.key || '';
    const loaded = [];
    const head = element('div', 'item-head');
    const stageLabel = demand ? demand.stageLabel : journey.searchStageLabel, stage = demand ? demand.stage : journey.searchStage;
    head.append(identityHeader(journey), demandCountsBadge(demand));if(stageLabel)head.append(makeBadge(stageLabel,stage==='SENT'?'green':stage==='SAVED'?'blue':'yellow'));
    card.append(head, element('p', 'muted', demand ? demandSummary(demand) : wishlistSummary(journey.matchWishes || journey.wishlists || journey.wishlist, journey.matchBidCents !== undefined ? journey.matchBidCents : journey.budget_cents)));
    const stale = staleNotice(card, demand); if (stale) card.append(stale);
    let audited=auditBlock(demand,loaded);if(audited)card.append(audited);
    card.addEventListener('options-loaded',()=>{const next=auditBlock(demand,loaded);if(audited&&next){audited.replaceWith(next);audited=next;}});
    if (reactivation) {
      const reactivateButton = element('button', 'small', journey.status === 'PARADO' ? 'Retomar busca' : 'Religar busca');
      reactivateButton.type = 'button';
      MCSAction.bind(reactivateButton,()=>{const payload=journey.status==='PARADO'?{action:'set_funnel',journeyId:journey.id,value:['DECIDINDO','QUALIFICADO'].includes(journey.stage)?journey.stage:'EM_BUSCA'}:{action:'toggle_journey',journeyId:journey.id,enabled:true,reason:null};return{scope:card,optimistic:()=>{reactivateButton.textContent='Retomando…';},commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify(payload)}),rollback:()=>{reactivateButton.textContent=journey.status==='PARADO'?'Retomar busca':'Religar busca';},refresh:()=>loadCurrent(),errorText:'Não consegui salvar, tente de novo'};});
      card.append(makeBadge(journey.status === 'PARADO' ? 'Parado — reativar' : 'Desligado — reativar', 'yellow'), reactivateButton);
    }
    const table = lazyOptions(card, demand, loaded, (match) => {
      const parsed = match.vehicle_json.parsed || {};
      const row = element('div', `manheim-row ${kindClass(match.match_kind)}`);
      const select = element('input'); select.type = 'checkbox'; select.className = 'manheim-select'; select.dataset.matchId = match.id;
      const vehicle = element('div');
      vehicle.append(
        element('strong', '', [parsed.year, parsed.make, parsed.model, parsed.trim].filter(Boolean).join(' ')),
        element('span', 'muted', `${milesText(parsed.miles)}${parsed.locationDisplay || parsed.location ? ` · ${parsed.locationDisplay || parsed.location}` : ''}${parsed.saleDate ? ` · ${parsed.saleDate}` : ''}`)
      );
      if (parsed.vin) vehicle.append(element('span', 'muted', `VIN: ${parsed.vin}`));
      if (parsed.matchedWishlistLabel) vehicle.append(element('span', 'muted', `Lista: ${parsed.matchedWishlistLabel}`));
      if (parsed.makeNotice) vehicle.append(element('span', 'muted', parsed.makeNotice));
      if (parsed.exteriorColor) vehicle.append(element('span', 'muted', `Cor externa: ${parsed.exteriorColor}`));
      if (parsed.buyNowPrice) vehicle.append(element('span', 'muted', `Buy Now: ${parsed.buyNowPrice}`));
      if (parsed.conditionGrade) vehicle.append(element('span', 'muted', `Nota de condição: ${parsed.conditionGrade}`));
      const badges = element('div', 'badges');
      badges.append(makeBadge(kindLabel(match.match_kind), kindTone(match.match_kind)));
      if (match.match_reason) badges.append(makeBadge(match.match_reason));
      if (match.criteriaChanged) badges.append(makeBadge('critério mudou desde o envio do CSV', 'yellow'));
      if (parsed.matchNotice) badges.append(makeBadge(parsed.matchNotice, 'yellow'));
      if (match.mmr_status) badges.append(makeBadge(mmrLabel(match.mmr_status), match.mmr_status.includes('acima') ? 'yellow' : 'blue'));
      if (match.fitsBid === true) badges.append(makeBadge('cabe no lance', 'green'));
      else if (match.fitsBid === false) badges.append(makeBadge('passa do lance', 'red'));
      if (Array.isArray(match.alsoFitsFor) && match.alsoFitsFor.length) badges.append(makeBadge(`também bate para ${match.alsoFitsFor.join(', ')}`, 'blue'));
      const presented = element('button', 'quiet small', match.presented_unit_id ? 'Apresentado' : journey.enabled === false ? 'Religue antes de apresentar' : 'Apresentei ao cliente');
      presented.type = 'button'; presented.disabled = Boolean(match.presented_unit_id) || journey.enabled === false;
      MCSAction.bind(presented,()=>({scope:row,optimistic:()=>{presented.textContent='Apresentado';},commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'unit',journeyId:journey.id,manheimMatchId:match.id,status:'PRESENTED'})}),rollback:()=>{presented.textContent='Apresentei ao cliente';},refresh:()=>loadCurrent(),errorText:'Não consegui salvar, tente de novo'}));
      row.append(select, vehicle, badges, presented);
      return row;
    }, reactivation ? (match) => match.match_kind === 'BATE' : null);
    // With the selection (migration 20261006010000) the demand shows the three groups; before it, the
    // list as it was.
    const selection = demand && demand.offer && OFFER ? offerSection(card, demand) : null;
    if (!selection && demand && demand.offerPending) card.append(offerPendingNote());
    card.append(selection || table);
    // Feedback of this card's actions (PDF, V1, copy) right next to them: the batch status line lives in
    // IMPORTAÇÕES and is hidden while OPÇÕES is open.
    const cardStatus=element('p','status manheim-card-status','');cardStatus.setAttribute('role','status');
    const exportButton = element('button', 'quiet small', 'Baixar PDF');
    exportButton.type = 'button';
    exportButton.addEventListener('click', (event) => {
      event.stopPropagation();
      // With the selection for the customer, the cars selected there (the old checkboxes are not
      // shown); before it, the checked rows. Never a silent no-op.
      const selected = card.offerState ? card.offerState.loaded.filter((option) => card.offerState.selectedIds.has(option.id))
        : [...card.querySelectorAll('.manheim-select:checked')].map((checkbox) => loaded.find((match) => match.id === checkbox.dataset.matchId)).filter(Boolean);
      if (!selected.length) { cardStatus.textContent = card.offerState && card.offerState.selectedIds.size ? 'Abra o grupo dos carros selecionados para incluí-los no PDF' : 'Selecione pelo menos um carro para o PDF'; return; }
      downloadShortlist(selected, journey.reference_code);
      cardStatus.textContent = `PDF com ${selected.length} ${selected.length === 1 ? 'carro' : 'carros'} baixado`;
    });
    const v1Send=v1SendControls(demand);
    const copyMessageButton=element('button','quiet small','Copiar mensagem com link');copyMessageButton.type='button';copyMessageButton.disabled=true;copyMessageButton.addEventListener('click',async(event)=>{event.stopPropagation();const link=copyMessageButton.dataset.link;if(!link)return;const customer=journey.contactName||journey.name||journey.display_name||'Hello';try{await navigator.clipboard.writeText(`${customer}, our team found some cars for you\n${link}`);cardStatus.textContent='Mensagem com link copiada';}catch(_){cardStatus.textContent='Não consegui copiar · Link: '+link;}});
    const vitrineButton=element('button','small','Gerar link V1');vitrineButton.type='button';
    const v1Error=(error)=>error?.code==='MANHEIM_AUDIT_PENDING'?'A conferência desta demanda ainda não liberou a V1':error?.code==='MANHEIM_OPTION_NOT_SELECTED'?'Só carros selecionados para o cliente entram na V1':error?.code==='MANHEIM_MATCH_WITHOUT_MMR'?'Carro sem MMR válido não entra na V1':error?.code==='MANHEIM_SELECTION_PENDING'?'V1 bloqueada: seleção para o cliente indisponível · O painel precisa de uma atualização para liberar este recurso · Avise o responsável':'Não consegui gerar o link';
    vitrineButton.addEventListener('click',async(event)=>{event.stopPropagation();
      /* Only the cars selected for the customer go to the V1 (the server checks it again). */
      const selected=card.offerState?[...card.offerState.selectedIds]:[...card.querySelectorAll('.manheim-select:checked')].map((box)=>box.dataset.matchId);
      if(!selected.length){cardStatus.textContent=card.offerState?'Selecione pelo menos um carro para o cliente':'Selecione pelo menos um carro';return;}
      vitrineButton.disabled=true;
      const create=()=>request('/api/panel/vitrines',{method:'POST',body:JSON.stringify({journeyId:journey.id,matchIds:selected,...(demand?.key?{demandKey:demand.key}:{})})});
      let created;
      try{
        try{created=await create();}
        catch(error){
          /* Not checked yet: one reading of this demand now (automatic rules and the US$ 50 ceiling on the server), then one more try. Never an approval. */
          if(error?.code!=='MANHEIM_AUDIT_PENDING'||!demand?.key||!AUDIT_CHECK_FIRST.includes(auditEntry(demand)?.status))throw error;
          cardStatus.textContent='Conferindo este pedido antes do link…';
          const checked=await request('/api/panel/manheim-audit',{method:'POST',body:JSON.stringify({action:'check',key:demand.key})}).catch(()=>null);
          try{created=await create();}
          catch(again){
            if(again?.code==='MANHEIM_AUDIT_PENDING'){cardStatus.textContent=checked?.providerLimit?'V1 bloqueada: sem saldo no teto de US$ 50 da OpenAI':checked?.inProgress?'V1 bloqueada: a conferência deste pedido já está em andamento, tente em instantes':'V1 bloqueada: a conferência não liberou este pedido · Atualize a página para ver o motivo';return;}
            throw again;
          }
        }
      }catch(error){cardStatus.textContent=v1Error(error);return;}
      finally{vitrineButton.disabled=!auditCanTry(demand);}
      const absolute=location.origin+created.link;copyMessageButton.dataset.link=absolute;copyMessageButton.disabled=false;v1Send.setVitrine(created.token);
      /* A22: the link exists even when the clipboard fails */
      try{await navigator.clipboard.writeText(absolute);cardStatus.textContent='Link V1 criado e copiado: '+absolute;}catch(_){cardStatus.textContent='Link V1 criado (não consegui copiar): '+absolute;}
    });vitrineButton.disabled=!auditCanTry(demand);
    card.append(exportButton,vitrineButton,copyMessageButton,cardStatus,v1Send.node,dispositionControls({kind:'JOURNEY',id:journey.id,journeyId:journey.id,disposition:journey.disposition}));
    makeCardClickable(card, () => openDetail('ficha', journey.id));
    root.append(card);
  }

  function renderManheimOrderGroup(root, order, demand) {
    const card = element('article', 'item-card manheim-lead');
    card.dataset.mode = demand?.mode || '';
    card.dataset.demandKey = demand?.key || '';
    const loaded = [];
    const head = element('div', 'item-head');
    const identity = element('div', 'identity');
    identity.append(element('span', 'order-icon', orderIcon(order)));
    const text = element('div');
    text.append(element('strong', 'identity-name', order.contactName||`Pedido ${order.ref}`),phoneNode(order), element('span', 'muted one-line', `Ref ${order.ref||'—'} · ${displayModel(order.vehicleText) || 'Pedido da calculadora'}${order.budgetCents?` · ${formatMoney(order.budgetCents)}`:''}`));
    identity.append(text);
    head.append(identity);
    card.append(head);
    const summary = element('div', 'badges');
    summary.append(demandCountsBadge(demand));
    let orderAudit=auditBlock(demand,loaded);
    summary.append(makeBadge(`Ref ${order.ref}`, 'blue'));
    card.append(summary, element('p', 'muted', demand ? demandSummary(demand) : order.simulationCount > 1 ? `${order.simulationCount} simulações agrupadas` : 'Pedido da calculadora'));
    const stale = staleNotice(card, demand); if (stale) card.append(stale);
    if (orderAudit) card.append(orderAudit);
    card.addEventListener('options-loaded',()=>{const next=auditBlock(demand,loaded);if(orderAudit&&next){orderAudit.replaceWith(next);orderAudit=next;}});
    const contact=contactMeta(order);if(contact)card.append(contact);
    const smsMissing=smsPrintMissing(order); if(smsMissing)card.append(smsMissing);

    const table = lazyOptions(card, demand, loaded, (match) => {
      const parsed = match.vehicle_json.parsed || {};
      const row = element('div', `manheim-row ${kindClass(match.match_kind)}`);
      const vehicle = element('div');
      vehicle.append(
        element('strong', '', [parsed.year, parsed.make, parsed.model, parsed.trim].filter(Boolean).join(' ')),
        element('span', 'muted', `${milesText(parsed.miles)}${parsed.locationDisplay || parsed.location ? ` · ${parsed.locationDisplay || parsed.location}` : ''}`)
      );
      if (parsed.vin) vehicle.append(element('span', 'muted', `VIN: ${parsed.vin}`));
      vehicle.append(element('span', 'muted', `Ref do pedido: ${order.ref}`));
      const badges = element('div', 'badges');
      badges.append(makeBadge(kindLabel(match.match_kind), kindTone(match.match_kind)));
      if (match.match_reason) badges.append(makeBadge(match.match_reason));
      if (match.criteriaChanged) badges.append(makeBadge('critério mudou desde o envio do CSV', 'yellow'));
      if (parsed.matchNotice) badges.append(makeBadge(parsed.matchNotice, 'yellow'));
      if (match.mmr_status) badges.append(makeBadge(mmrLabel(match.mmr_status), match.mmr_status.includes('acima') ? 'yellow' : 'blue'));
      if (match.fitsBid === true) badges.append(makeBadge('cabe no lance', 'green'));
      else if (match.fitsBid === false) badges.append(makeBadge('passa do lance', 'red'));
      if (Array.isArray(match.alsoFitsFor) && match.alsoFitsFor.length) badges.append(makeBadge(`também bate para ${match.alsoFitsFor.join(', ')}`, 'blue'));
      row.append(vehicle, badges);
      makeCardClickable(row, () => openDetail('order', order.ref));
      return row;
    });
    const actions=element('div','inline-actions');
    const open=element('button','small','Abrir pedido');open.type='button';open.addEventListener('click',(event)=>{event.stopPropagation();openDetail('order',order.ref);});
    const orderSelection = demand && demand.offer && OFFER ? offerSection(card, demand) : null;
    if (!orderSelection && demand && demand.offerPending) card.append(offerPendingNote());
    actions.append(open);card.append(orderSelection || table,actions,dispositionControls({...order,kind:'CALCULATOR'}));
    makeCardClickable(card, () => openDetail('order', order.ref));
    root.append(card);
  }

  const MODE_ROOTS = { VALOR: 'valor', CARRO: 'carro' };
  const modeRoot = (mode, part) => $(`buscas-${MODE_ROOTS[mode]}-${part}`);
  let manheimData = null;

  function renderManheim(data) {
    manheimData = data;
    const mode=$('manheim-sort')?.value||'recent';
    const cardMode=mode==='customers'?'recent':mode;
    manheimJourneys = clientSort(data.items || [],cardMode);
    manheimOrders = clientSort(data.orders || [],cardMode);
    manheimMatches = [];
    renderSavedSearches().catch(() => { $('manheim-saved-searches').textContent = 'Não foi possível carregar as buscas sugeridas'; });
    // B5: people served by today's combinations, not the count frozen at upload time.
    setCount('manheim', data.upload ? (data.upload.current_lead_count ?? data.upload.lead_count ?? 0) : 0);
    $('manheim-summary').textContent = data.upload ? `${data.upload.vehicle_count} carro(s) analisado(s) · ${data.upload.matched_vehicle_count} carro(s) com combinação · ${formatDate(data.upload.uploaded_at)}` : 'Nenhuma importação ativa';
    renderBuscasCounters(data.counts);
    renderBatches(data.uploads || [], data.undoAvailable !== false, data.hiddenBatchIds);
    renderReview(data.review || []);
    renderAuditNote(data.audit);

    const byJourney = new Map(manheimJourneys.map((journey) => [journey.id, journey]));
    const byOrder = new Map(manheimOrders.map((order) => [order.ref, order]));
    const withOptions = (data.demands || []).filter((demand) => demand.matchCount > 0);
    const position = (demand) => demand.journeyId ? manheimJourneys.findIndex((item) => item.id === demand.journeyId) : 10000 + manheimOrders.findIndex((item) => item.ref === demand.ref);
    ['VALOR', 'CARRO'].forEach((mode) => {
      const root = modeRoot(mode, 'results');
      root.replaceChildren();
      const standard = element('section', 'stack'), reactivate = element('section', 'stack');
      reactivate.append(element('h4', '', 'Reativar'));
      let standardCount = 0, reactivateCount = 0;
      withOptions.filter((demand) => demand.mode === mode).sort((a, b) => position(a) - position(b)).forEach((demand) => {
        if (!demand.journeyId) {
          const order = byOrder.get(String(demand.ref || '').trim());
          if (!order) return;
          renderManheimOrderGroup(standard, order, demand);
          standardCount += 1;
          return;
        }
        const journey = byJourney.get(demand.journeyId);
        if (!journey) return;
        if (journey.reactivationEligible || journey.status === 'PARADO') {
          if (demand.bateCount) { renderManheimGroup(reactivate, journey, true, { ...demand, matchCount: demand.bateCount }); reactivateCount += 1; }
        } else { renderManheimGroup(standard, journey, false, demand); standardCount += 1; }
      });
      if (standardCount) root.append(standard);
      if (reactivateCount) root.append(reactivate);
      if (!standardCount && !reactivateCount) empty(root, data.upload ? 'Nenhum carro compatível neste modo no lote ativo' : 'Nenhuma importação ativa');
    });
  }

  function renderBuscasCounters(counts) {
    const total = $('buscas-total');
    if (total) {
      total.replaceChildren();
      const all = counts && counts.total || {};
      total.append(element('strong', '', 'Total geral'), element('span', 'muted', `${all.people || 0} pessoa(s) com busca ativa · ${all.served || 0} atendida(s) no lote ativo · ${all.matches || 0} combinação(ões) · ${all.review || 0} para revisar`));
    }
    ['VALOR', 'CARRO'].forEach((mode) => {
      const root = modeRoot(mode, 'counters');
      if (!root) return;
      const value = counts && counts[mode] || {};
      root.replaceChildren();
      [[value.demands, 'demandas'], [value.served, 'pessoas atendidas'], [value.matches, 'matches']].forEach(([number, label]) => {
        const stat = element('div', 'pending-stat');
        stat.dataset.counter = label;
        stat.append(element('strong', '', String(number || 0)), element('span', 'muted', label));
        root.append(stat);
      });
    });
  }

  // One row per import batch (a batch can have several CSV files). Undo is reversible and
  // audited: nothing is deleted, cars and matches of the batch leave every screen.
  // PESQUISAS: todo pedido de veículo (ficha, calculadora e conversas lidas), com critérios exatos,
  // evidências e estado contra o lote ativo. Nenhum pedido sai da lista por estágio, prazo ou
  // classificação; "sem opção no lote" continua aqui para a próxima importação. Nada é enviado.
  // Regra MCS: busca POR CARRO (veículo, ano e milhagem, sem valor) ou POR VALOR (modelo e valor).
  // Sem critérios para nenhum dos dois o pedido fica visível com o que falta e nunca é comparado,
  // contado como opção ou marcado como atendido.
  const REQUEST_STATES = ['FALTA_BUSCAR', 'COM_OPCOES', 'COM_CANDIDATOS', 'SEM_OPCAO', 'PRECISA_DETALHE', 'PRECISA_REVISAO'];
  const REQUEST_STATE_LABELS = { FALTA_BUSCAR: 'FALTA BUSCAR', COM_OPCOES: 'COM OPÇÕES NO LOTE', COM_CANDIDATOS: 'CANDIDATOS · VALOR A CONFERIR', SEM_OPCAO: 'SEM OPÇÃO NO LOTE', PRECISA_DETALHE: 'PRECISA DETALHE', PRECISA_REVISAO: 'PRECISA DE REVISÃO' };
  const REQUEST_STATE_TONES = { FALTA_BUSCAR: 'yellow', COM_OPCOES: 'green', COM_CANDIDATOS: 'yellow', SEM_OPCAO: '', PRECISA_DETALHE: 'yellow', PRECISA_REVISAO: 'red' };
  const REQUEST_SOURCES = { FICHA: 'Ficha', CONVERSA: 'Conversa', CALCULADORA: 'Calculadora' };
  const EXTRACTION_TEXT = { SIMULADA: 'Leitura das conversas: simulada neste ambiente (sem IA)', DESLIGADA: 'Leitura das conversas por IA: desligada', SEM_CHAVE: 'Leitura das conversas por IA: sem chave', MODELO_INVALIDO: 'Leitura das conversas por IA: modelo não aprovado', LIGADA: 'Leitura das conversas por IA: ligada' };
  let requestsData = null;
  let requestsFilter = 'ALL';
  let requestsShown = 50;
  function renderRequests(data) {
    requestsData = data;
    setCount('requests', (data.items || []).length);
    const status = $('requests-status');
    const upload = data.upload ? `Lote ativo de ${formatDate(data.upload.uploadedAt)}` : 'Nenhum lote ativo';
    status.classList.remove('error');
    status.textContent = [upload, EXTRACTION_TEXT[data.extraction] || '', data.requestsPending ? 'Pedidos lidos das conversas indisponíveis · O painel precisa de uma atualização para liberar este recurso · Avise o responsável' : ''].filter(Boolean).join(' · ');
    const filters = $('requests-filters');
    filters.replaceChildren();
    const chip = (key, label, count) => {
      const button = element('button', 'chip' + (requestsFilter === key ? ' active' : ''), '');
      button.type = 'button'; button.dataset.requestState = key;
      button.append(document.createTextNode(label + ' '), element('span', '', String(count)));
      button.addEventListener('click', () => { requestsFilter = key; requestsShown = 50; renderRequests(requestsData); });
      filters.append(button);
    };
    chip('ALL', 'Todos', (data.items || []).length);
    REQUEST_STATES.forEach((state) => chip(state, REQUEST_STATE_LABELS[state], (data.counts || {})[state] || 0));
    const root = $('requests-list');
    root.replaceChildren();
    const visible = (data.items || []).filter((item) => requestsFilter === 'ALL' || item.state === requestsFilter);
    if (!visible.length) return empty(root, requestsFilter === 'ALL' ? 'Nenhum pedido de veículo registrado' : 'Nenhum pedido neste estado');
    // Same criteria, one task; every person and conversation stays listed inside it.
    const groups = new Map();
    visible.forEach((item) => { if (!groups.has(item.groupKey)) groups.set(item.groupKey, []); groups.get(item.groupKey).push(item); });
    const ordered = [...groups.values()].sort((left, right) => REQUEST_STATES.indexOf(left[0].state) - REQUEST_STATES.indexOf(right[0].state)
      || String(latestOf(right)).localeCompare(String(latestOf(left))));
    ordered.slice(0, requestsShown).forEach((members) => root.append(requestCard(members)));
    if (ordered.length > requestsShown) {
      const more = element('button', 'quiet small', `Mostrar mais (${ordered.length - requestsShown})`); more.type = 'button';
      more.addEventListener('click', () => { requestsShown += 50; renderRequests(requestsData); });
      root.append(more);
    }
  }
  const latestOf = (members) => members.map((item) => item.lastMessageAt || '').sort().at(-1) || '';
  function requestCard(members) {
    const first = members[0];
    const card = element('article', 'item-card request-card');
    card.dataset.state = first.state;
    const head = element('div', 'request-head');
    head.append(element('strong', '', 'Informado: ' + first.criteriaText), makeBadge(first.stateLabel, REQUEST_STATE_TONES[first.state]));
    card.append(head);
    if (members.length > 1) card.append(element('p', 'muted', `${members.length} pedidos com critérios exatamente iguais`));
    if (first.state === 'COM_OPCOES') card.append(element('p', '', `${first.optionCount} ${first.optionCount === 1 ? 'opção válida' : 'opções válidas'} no lote ativo`));
    if (first.state === 'COM_CANDIDATOS') card.append(element('p', '', `${first.optionCount} ${first.optionCount === 1 ? 'candidato' : 'candidatos'} no lote ativo por modelo, ano e milhagem. O valor do cliente ainda não foi conferido pelo cálculo oficial: não é opção confirmada`));
    if (first.state === 'SEM_OPCAO') card.append(element('p', 'muted', 'Sem opção no lote ativo · Continua aqui para a próxima importação'));
    if (first.comparedAt) card.append(element('p', 'muted', `${first.comparedAtImport ? 'Comparado na importação de' : 'Última comparação'}: ${formatDate(first.comparedAt)}`));
    if (first.missing && first.missing.length) card.append(element('p', 'muted', 'Não informado (sem restrição): ' + first.missing.join(', ')));
    if (first.typeNotChecked) card.append(element('p', 'muted', 'O tipo de carroceria não vem no arquivo do Manheim: as opções não filtram por tipo'));
    if (first.state === 'PRECISA_DETALHE') card.append(element('p', 'request-lacks', first.lacksText || ''),
      element('p', 'muted', 'Sem busca no lote até a pessoa detalhar · Continua aqui, ligado à conversa'));
    if (first.reviewReason) card.append(element('p', 'muted', 'Revisão: ' + first.reviewReason));
    members.forEach((item) => {
      const line = element('div', 'request-person');
      const who = element('div', 'request-person-head');
      who.append(element('span', '', item.person?.name || 'Sem nome'), makeBadge(REQUEST_SOURCES[item.source] || item.source, ''),
        element('span', 'muted', item.lastMessageAt ? 'Última mensagem: ' + formatDate(item.lastMessageAt) : 'Sem mensagem registrada'));
      if (item.versions > 1) who.append(element('span', 'muted', `${item.versions} versões do pedido`));
      if (item.person?.journeyId) {
        const open = element('button', 'quiet small', 'Abrir ficha'); open.type = 'button';
        open.addEventListener('click', (event) => { event.stopPropagation(); openDetail('ficha', item.person.journeyId); });
        who.append(open);
      }
      line.append(who);
      const evidence = element('details', 'request-evidence');
      evidence.append(element('summary', '', `Evidências (${(item.evidence || []).length})`));
      (item.evidence || []).forEach((entry) => evidence.append(element('p', 'muted', (entry.at ? formatDate(entry.at) + ' · ' : '') + entry.text)));
      line.append(evidence);
      card.append(line);
    });
    return card;
  }
  // Compares every request in FALTA BUSCAR with the active batch, 40 at a time, then reloads.
  async function compareRequests(button) {
    button.disabled = true;
    const status = $('requests-status');
    try {
      for (let round = 0; round < 50; round += 1) {
        const result = await request('/api/panel/pesquisas', { method: 'POST', timeoutMs: 60000, body: JSON.stringify({ action: 'compare' }) });
        status.textContent = `Comparando com o lote ativo · ${result.remaining} pedido(s) restantes`;
        if (!result.compared || !result.remaining) break;
      }
      await loadCurrent();
    } catch (failure) {
      status.classList.add('error');
      status.textContent = failure && failure.code === 'SEARCH_REQUESTS_PENDING' ? 'Comparação indisponível · O painel precisa de uma atualização para liberar este recurso · Avise o responsável' : 'Não consegui comparar agora, tente de novo';
    } finally { button.disabled = false; }
  }
  // Auditoria histórica: um botão só. Confirma, testa o modelo uma vez (produção) e processa os
  // lotes de 10 até acabar, pausar ou parar no teto. O ponto de retomada fica gravado no servidor:
  // fechar a aba e clicar de novo continua de onde parou. Nada é enviado a ninguém.
  let historyPaused = false;
  const HISTORY_ERRORS = { OPENAI_MODEL_UNAVAILABLE: 'O modelo gpt-6-luna não está disponível para a chave OpenAI de produção · Nenhuma conversa foi lida e nenhum outro modelo foi tentado',
    OPENAI_KEY_INVALID: 'A chave OpenAI de produção foi recusada · Nenhuma conversa foi lida', OPENAI_QUOTA: 'A OpenAI recusou por saldo ou cota · Nenhuma conversa foi lida',
    MODEL_NOT_CHECKED: 'O teste do modelo ainda não passou · Nenhuma conversa foi lida', SEARCH_EXTRACTION_OFF: 'A leitura por IA está desligada neste ambiente',
    PROVIDER_LIMIT: 'Teto de US$ 50 atingido · Parado com segurança; o restante continua pendente', PROVIDER_QUOTA: 'A OpenAI encerrou por saldo ou cota · Parado com segurança; o restante continua pendente',
    MODEL_UNAVAILABLE: 'O modelo deixou de estar disponível · Parado com segurança; o restante continua pendente' };
  const usd = (value) => 'US$ ' + Number(value || 0).toFixed(4);
  function historyText(state, prefix) {
    return `${prefix} · conversas processadas: ${state.processed} de ${state.total} · pedidos encontrados: ${state.requestsFound} · custo acumulado: ${usd(state.spentUsd)}${state.providerLimitUsd ? ' de US$ ' + state.providerLimitUsd : ''}`;
  }
  // Step 1: the click reads the state and shows the confirmation on the page itself (never a
  // browser dialog, which an installed app or an embedded browser can silently answer "no").
  async function openHistoryAudit(button) {
    const box = $('requests-history-progress'), text = $('requests-history-text');
    box.classList.remove('hidden'); $('requests-history-confirm').classList.add('hidden');
    text.className = ''; text.textContent = 'Verificando o estado da auditoria…';
    button.disabled = true;
    let state;
    try { state = await request('/api/panel/pesquisas', { method: 'POST', body: JSON.stringify({ action: 'history_status' }) }); }
    catch (failure) { text.className = 'error'; text.textContent = failure && failure.code === 'SEARCH_REQUESTS_PENDING' ? 'Auditoria indisponível · O painel precisa de uma atualização para liberar este recurso · Avise o responsável' : 'Não consegui ler o estado da auditoria, tente de novo'; button.disabled = false; return; }
    if (!state.available) { text.className = 'error'; text.textContent = HISTORY_ERRORS.SEARCH_EXTRACTION_OFF; button.disabled = false; return; }
    const who = state.provider === 'OPENAI' ? `OpenAI ${state.model}` : 'leitura simulada (sem IA, sem custo)';
    const terms = $('requests-history-terms');
    terms.replaceChildren(...['Lê as conversas de clientes desde 09/08/2026', 'Não envia nenhuma mensagem', `Usa ${who}`, 'Pode pausar e continuar depois do mesmo ponto', `Teto máximo de US$ ${state.providerLimitUsd || 50}`].map((line) => element('li', '', line)));
    $('requests-history-remaining').textContent = `Faltam ${state.remaining} de ${state.total} conversas · custo acumulado ${usd(state.spentUsd)}`;
    text.textContent = '';
    $('requests-history-confirm').classList.remove('hidden');
    $('requests-history-go').onclick = () => { $('requests-history-confirm').classList.add('hidden'); runHistoryAudit(button, state).catch(() => {}); };
    $('requests-history-cancel').onclick = () => { box.classList.add('hidden'); button.disabled = false; };
  }
  // Step 2, after the confirmation: model test once (production), then the batches until done,
  // paused or stopped at the ceiling.
  async function runHistoryAudit(button, state) {
    const text = $('requests-history-text'), pause = $('requests-history-pause');
    const say = (message, error) => { text.className = error ? 'error' : ''; text.textContent = message; };
    historyPaused = false; pause.classList.remove('hidden');
    try {
      if (!state.modelChecked) {
        say('Testando o modelo com uma chamada mínima, sem dados de cliente…');
        const check = await request('/api/panel/pesquisas', { method: 'POST', timeoutMs: 60000, body: JSON.stringify({ action: 'model_check' }) });
        if (!check.ok) { say((HISTORY_ERRORS[check.error] || 'O teste do modelo falhou: ' + (check.error || 'erro')) + '. Nada foi lido', true); return; }
      }
      say(historyText(state, 'Lendo'));
      for (let round = 0; round < 200 && !historyPaused; round += 1) {
        state = await request('/api/panel/pesquisas', { method: 'POST', timeoutMs: 90000, body: JSON.stringify({ action: 'extract_history' }) });
        say(historyText(state, 'Lendo'));
        if (state.stoppedReason) { say(historyText(state, HISTORY_ERRORS[state.stoppedReason] || 'Parado: ' + state.stoppedReason), true); break; }
        if (!state.remaining || !state.read) break;
      }
      if (historyPaused) say(historyText(state, 'Pausado · Clique de novo para continuar do mesmo ponto'));
      else if (!state.stoppedReason) {
        say(historyText(state, state.remaining ? 'Parado' : 'Leitura concluída, comparando com o lote ativo'));
        if (!state.remaining) { await compareRequests($('requests-compare')); say(historyText(state, 'Auditoria concluída e comparada com o lote ativo')); }
      }
    } catch (failure) {
      const code = failure && (failure.code || failure.error);
      say(historyText(state, HISTORY_ERRORS[code] || 'A auditoria parou por um erro · Clique de novo para continuar do ponto gravado'), true);
    } finally { button.disabled = false; pause.classList.add('hidden'); }
  }
  async function loadRequestsAudit() {
    const root = $('requests-audit-content');
    root.replaceChildren(element('p', 'muted', 'Calculando…'));
    let data;
    try { data = await request('/api/panel/pesquisas?view=audit', { timeoutMs: 60000 }); }
    catch (_) { root.replaceChildren(element('p', 'muted', 'Não consegui calcular a auditoria agora')); return; }
    const table = element('dl', 'requests-audit-table');
    const row = (label, value) => { table.append(element('dt', '', label), element('dd', '', String(value))); };
    row('Pessoas com mensagens', data.peopleWithMessages);
    row('Conversas com mensagem do cliente', data.conversationsWithCustomerMessages);
    row('Conversas com pedido identificado', data.tablesPending ? 'O painel precisa de uma atualização para liberar este recurso · Avise o responsável' : data.conversationsWithRequest);
    row('Conversas sem pedido de veículo', data.tablesPending ? 'O painel precisa de uma atualização para liberar este recurso · Avise o responsável' : data.conversationsWithoutRequest);
    row('Pedidos distintos', data.requests);
    row('Tarefas (critérios exatamente iguais)', data.groups);
    row('Prontos para buscar', data.ready);
    row('Prontos com opções (cálculo oficial)', data.readyWithOptions);
    row('Prontos com candidatos (valor a conferir)', data.readyWithCandidates);
    row('Prontos sem opção', data.readyWithoutOptions);
    row('Precisam de detalhe (sem busca)', data.needsDetail);
    row('Precisam de revisão humana', data.review);
    row('Ainda não comparados', data.notCompared);
    row('Sem vínculo confiável', data.withoutReliableLink);
    row('Conversas ainda não lidas', data.estimate.conversationsToRead);
    root.replaceChildren(table,
      element('p', data.allServed ? '' : 'warning', data.allServed ? 'Todos os pedidos têm opção válida no lote ativo' : 'Ainda não há prova de que todo pedido de veículo foi atendido'),
      element('p', 'muted', `Leitura do histórico: ${data.estimate.conversationsToRead} conversas, ${data.estimate.messagesToRead} mensagens, cerca de US$ ${Number(data.estimate.costUsd || 0).toFixed(2)} com ${data.estimate.model}, dentro do limite de US$ ${data.estimate.providerLimitUsd} do provedor. Nada é lido sem autorização`));
  }

  // Lotes: o ativo sempre à vista; os desfeitos num "Histórico de lotes" recolhido. Ocultar é só
  // preferência de exibição deste operador (o lote, os veículos e os matches não mudam).
  let batchHistoryOpen = false;
  let batchHiddenOpen = false;
  function renderBatches(batches, undoAvailable, hiddenIds) {
    const root = $('manheim-batches');
    if (!root) return;
    root.replaceChildren(element('h3', '', 'Lotes de importação'));
    if (!batches.length) return root.append(element('p', 'muted', 'Nenhum lote importado'));
    const hidden = new Set(hiddenIds || []);
    const active = batches.filter((batch) => batch.status !== 'UNDONE');
    const undone = batches.filter((batch) => batch.status === 'UNDONE');
    active.forEach((batch) => root.append(batchLine(batch, undoAvailable, null)));
    if (!active.length) root.append(element('p', 'muted', 'Nenhum lote ativo'));
    if (!undone.length) return;
    const visible = undone.filter((batch) => !hidden.has(batch.id));
    const hiddenList = undone.filter((batch) => hidden.has(batch.id));
    const history = element('details', 'batch-history');
    history.open = batchHistoryOpen;
    history.addEventListener('toggle', () => { batchHistoryOpen = history.open; });
    history.append(element('summary', '', `Histórico de lotes (${visible.length})`));
    if (hiddenIds === null || hiddenIds === undefined) history.append(element('p', 'muted', 'Ocultar lotes indisponível · O painel precisa de uma atualização para liberar este recurso · Avise o responsável'));
    else if (visible.length) {
      const all = element('button', 'quiet small', 'Ocultar todos os lotes desfeitos'); all.type = 'button';
      all.addEventListener('click', () => batchVisibility(all, { op: 'hide_all' }));
      const actions = element('div', 'inline-actions'); actions.append(all); history.append(actions);
    }
    visible.forEach((batch) => history.append(batchLine(batch, false, hiddenIds ? 'hide' : null)));
    if (!visible.length) history.append(element('p', 'muted', 'Nenhum lote desfeito à vista'));
    if (hiddenList.length) {
      const more = element('details', 'batch-hidden');
      more.open = batchHiddenOpen;
      more.addEventListener('toggle', () => { batchHiddenOpen = more.open; });
      more.append(element('summary', '', `Ver lotes ocultos (${hiddenList.length})`));
      hiddenList.forEach((batch) => more.append(batchLine(batch, false, 'restore')));
      history.append(more);
    }
    root.append(history);
  }
  function batchLine(batch, undoAvailable, visibility) {
    const line = element('article', 'batch-line' + (batch.status === 'UNDONE' ? ' undone' : ''));
    line.dataset.batchId = batch.id;
    const text = element('div', 'batch-text');
    const files = `${batch.fileCount} arquivo${batch.fileCount === 1 ? '' : 's'}`;
    text.append(element('strong', '', `${formatDate(batch.uploadedAt)} · ${files}`), element('span', 'muted', `${batch.vehicleCount} veículos · ${batch.matchCount} carros com combinação`));
    if (batch.ai && Number(batch.ai.rowsSentToAi) > 0) text.append(element('span', 'muted', `IA: OpenAI ${batch.ai.model || ''} · ${batch.ai.rowsSentToAi} linha(s)`));
    text.append(makeBadge(batch.status === 'UNDONE' ? 'Desfeito' : batch.current ? 'Ativo · em uso' : 'Ativo', batch.status === 'UNDONE' ? '' : 'green'));
    if (batch.status === 'UNDONE' && batch.undoSummary) text.append(element('span', 'muted', undoSummaryText(batch.undoSummary)));
    line.append(text);
    if (batch.status === 'ACTIVE' && undoAvailable) {
      const undo = element('button', 'quiet small', 'Desfazer importação');
      undo.type = 'button';
      undo.addEventListener('click', () => confirmUndoBatch(line, batch, undo));
      line.append(undo);
    }
    // Only an undone batch can leave the list; the active one never can.
    if (batch.status === 'UNDONE' && visibility) {
      const toggle = element('button', 'quiet small', visibility === 'hide' ? 'Ocultar da lista' : 'Restaurar');
      toggle.type = 'button';
      toggle.dataset.batchVisibility = visibility;
      toggle.addEventListener('click', () => batchVisibility(toggle, { op: visibility, uploadId: batch.id }));
      line.append(toggle);
    }
    return line;
  }
  async function batchVisibility(button, body) {
    button.disabled = true;
    try {
      await request('/api/panel/manheim-batch', { method: 'POST', body: JSON.stringify({ action: 'visibility', ...body }) });
      await loadCurrent();
    } catch (failure) {
      button.disabled = false;
      $('manheim-status').classList.add('error');
      $('manheim-status').textContent = failure && failure.code === 'MANHEIM_HISTORY_PENDING' ? 'Ocultar lotes indisponível · O painel precisa de uma atualização para liberar este recurso · Avise o responsável' : 'Não consegui mudar a lista de lotes, tente de novo';
    }
  }

  function undoSummaryText(summary) {
    const parts = [`${summary.vehiclesWithdrawn || 0} veículos e ${summary.matchesWithdrawn || 0} matches retirados do uso`];
    if (summary.unitsPreserved || summary.vitrinesPreserved) parts.push(`${summary.unitsPreserved || 0} unidade(s) e ${summary.vitrinesPreserved || 0} vitrine(s) preservadas para auditoria`);
    return parts.join(' · ');
  }

  async function confirmUndoBatch(line, batch, button) {
    const question = `Desfazer a importação de ${formatDate(batch.uploadedAt)} (${batch.fileCount} arquivo${batch.fileCount === 1 ? '' : 's'}, ${batch.vehicleCount} veículos, ${batch.matchCount} matches)? Os veículos e matches deste lote saem de BUSCAS, HOJE, fichas, score e relatórios. Unidades e vitrines já criadas ficam preservadas. Os outros lotes não mudam`;
    button.disabled = true;
    const confirmed = await askInline(line, question, 'Desfazer importação');
    if (!confirmed) { button.disabled = false; return; }
    button.textContent = 'Desfazendo…';
    try {
      const result = await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'manheim_undo', uploadId: batch.id }) });
      $('manheim-status').classList.remove('error');
      $('manheim-status').textContent = result.alreadyUndone ? 'Esta importação já estava desfeita' : `Importação desfeita · ${undoSummaryText(result.summary || {})}`;
      await loadCurrent();
      await refreshCounters();
    } catch (failure) {
      button.disabled = false; button.textContent = 'Desfazer importação';
      $('manheim-status').classList.add('error');
      $('manheim-status').textContent = failure && failure.code === 'MANHEIM_MIGRATION_PENDING' ? 'Desfazer lote indisponível · O painel precisa de uma atualização para liberar este recurso · Avise o responsável' : 'Não consegui desfazer a importação, tente de novo';
    }
  }

  // "Revisar tipo de busca": the mode is never guessed. CARRO or VALOR is set by the operator;
  // incomplete criteria only open the ficha or the order to be fixed there.
  function renderReview(items) {
    const root = $('buscas-review-list');
    if (!root) return;
    root.replaceChildren();
    $('buscas-review-count').textContent = String(items.length);
    if (!items.length) return empty(root, 'Nada para revisar');
    items.forEach((item) => {
      const line = element('article', 'item-card review-line');
      line.dataset.reviewKey = item.key;
      line.append(element('strong', 'identity-name', item.name || 'Cliente'), element('span', 'muted', `${item.ref ? `Ref ${item.ref}` : 'sem Ref'} · ${item.manual ? 'critério sem modo' : item.mode === 'REVIEW' ? 'tipo indefinido' : MCSVehicleMatch.modeLabel(item.mode)}`));
      const reasons = element('div', 'badges');
      (item.issues || []).forEach((issue) => reasons.append(makeBadge(issue.wish ? `${issue.wish}: ${issue.text}` : issue.text, 'yellow')));
      line.append(reasons);
      if (item.manual && (item.wishes || []).length) line.append(element('p', 'muted', 'Critério manual: ' + item.wishes.map((wish) => [[wish.make, wish.model, wish.trim].filter(Boolean).join(' '), wish.yearMin || wish.yearMax ? `${wish.yearMin || '?'} a ${wish.yearMax || '?'}` : '', wish.minMiles || wish.maxMiles ? `${wish.minMiles || '?'} a ${wish.maxMiles || '?'} milhas` : ''].filter(Boolean).join(' · ')).join(' | ')));
      const actions = element('div', 'inline-actions');
      if (item.canDefineMode) {
        // A ficha without mode gets its mode; a manual criterion without mode (ficha with both
        // searches) is assigned to ONE search. Nothing is applied to both.
        const action = item.manual ? 'assign_manual_mode' : 'set_search_mode';
        (item.manual ? [['CARRO', 'Aplicar a CARRO'], ['VALOR', 'Aplicar a VALOR']] : [['CARRO', 'Definir como CARRO'], ['VALOR', 'Definir como VALOR']]).forEach(([mode, label]) => {
          const button = element('button', 'small', label); button.type = 'button';
          MCSAction.bind(button, () => ({ scope: line, optimistic: () => { button.textContent = 'Salvando…'; }, commit: () => request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action, journeyId: item.journeyId, mode }) }), rollback: () => { button.textContent = label; }, refresh: () => loadCurrent(), errorText: 'Não consegui salvar, tente de novo' }));
          actions.append(button);
        });
        const keep = element('button', 'quiet small', 'Manter pendente'); keep.type = 'button';
        keep.addEventListener('click', () => MCSAction.feedback(line, 'Continua pendente', 'success', 'review-keep'));
        actions.append(keep);
      }
      const open = element('button', 'quiet small', item.journeyId ? 'Abrir ficha' : 'Abrir pedido'); open.type = 'button';
      open.addEventListener('click', () => item.journeyId ? openDetail('ficha', item.journeyId) : openDetail('order', item.ref));
      actions.append(open);
      line.append(actions);
      root.append(line);
    });
  }

  async function renderSavedSearches() {
    const data = savedSearchesData || await request('/api/panel/manheim-searches');
    savedSearchesData = data;
    const intro = $('manheim-saved-searches');
    intro.replaceChildren(element('p','muted','Cada linha é uma busca para você salvar no Manheim · As primeiras atendem mais clientes · Conta só quem entrou em contato · POR VALOR e POR ANO E MILHAGEM têm porcentagens separadas; o que está em revisão não entra no %'));
    const roots = { VALOR: modeRoot('VALOR', 'saved'), CARRO: modeRoot('CARRO', 'saved') };
    Object.entries(roots).forEach(([mode, root]) => { root.replaceChildren(); if (!data.groups.some((group) => group.mode === mode)) empty(root, 'Nenhuma busca ativa neste modo'); });
    const mode=$('manheim-sort')?.value||'customers';
    const rankOf=(group)=>group.searches===null||group.searches===undefined?Infinity:group.searches;
    const groups=data.groups.slice().sort((a,b)=>(mode==='vehicle'?`${a.make} ${a.model}`.localeCompare(`${b.make} ${b.model}`,'pt-BR'):mode==='recent'?(Date.parse(b.latestAt||0)-Date.parse(a.latestAt||0)||rankOf(a)-rankOf(b)):rankOf(a)-rankOf(b)));
    const searchTitle=(group)=>{
      const parts=[group.mode==='VALOR'?`POR VALOR #${group.searches}`:`POR ANO E MILHAGEM #${group.searches}`,`${group.make} ${group.model}`];
      if(group.mode==='CARRO'){parts.push(`${group.yearFrom} a ${group.yearTo}`);parts.push(`${Number(group.milesFrom).toLocaleString('pt-BR')} a ${Number(group.milesTo).toLocaleString('pt-BR')} milhas`);}
      else parts.push(`MMR ${formatMoney(group.mmrMinCents)} a ${formatMoney(group.mmrMaxCents)}`);
      return parts.join(' · ');
    };
    groups.forEach((group) => {
      const root = roots[group.mode];
      if (!root) return;
      const line = element('article', 'saved-search-line');
      line.dataset.mode = group.mode;
      const text = element('span'); const title=searchTitle(group);
      const clients=element('button','quiet small',`👥 ${group.leads} ${group.leads===1?'cliente quer':'clientes querem'} este carro`); clients.type='button';
      const people=element('div','saved-search-clients hidden'); (group.clients||[]).forEach((client)=>{const person=element('button','quiet small',`${client.name||'Pedido'} · 📞 ${client.phone?phoneDisplay(client.phone):'falta o número'} · Ref ${client.ref||'—'}`);person.type='button';person.addEventListener('click',()=>{if(client.journeyId)openDetail('ficha',client.journeyId);});people.append(person);}); clients.addEventListener('click',()=>people.classList.toggle('hidden'));
      const basisText=group.mode==='VALOR'?'clientes POR VALOR':'clientes POR ANO E MILHAGEM';
      const coverage=mode==='customers'?`Salvando da #1 até esta, você atende ${group.percent}% dos ${basisText}`:`Esta busca sozinha atende ${group.individualPercent}% dos ${basisText}`;
      const note=group.mode==='CARRO'?'A faixa amplia a busca no Manheim; cada carro do CSV é conferido de novo com o critério de cada cliente':null;
      text.append(element('strong','',title),clients,element('span','muted',coverage),people);if(note)text.append(element('span','muted',note));
      const toggle=element('button',group.created?'quiet small':'small',group.created?'✓ Busca criada':'Já criei esta busca'); toggle.type='button';
      const undo=element('button','quiet small','Desfazer');undo.type='button';undo.classList.toggle('hidden',!group.created);undo.addEventListener('click',()=>toggle.click());
      MCSAction.bind(toggle,()=>{const before=group.created;return{scope:line,optimistic:()=>{group.created=!before;toggle.textContent=group.created?'✓ Busca criada':'Já criei esta busca';undo.classList.toggle('hidden',!group.created);return before;},commit:()=>request('/api/panel/manheim-searches',{method:'POST',body:JSON.stringify({key:group.key,created:group.created})}),rollback:()=>{group.created=before;toggle.textContent=before?'✓ Busca criada':'Já criei esta busca';undo.classList.toggle('hidden',!before);},onSuccess:()=>{if(savedSearchesData?.groups){const cached=savedSearchesData.groups.find((entry)=>entry.key===group.key);if(cached)cached.created=group.created;}},errorText:'Não consegui salvar, tente de novo'};});
      const controls=element('div','inline-actions');controls.append(toggle,undo);line.append(text,controls);root.append(line);
    });
  }

  const manheimError = (code, details) => Object.assign(new Error(code), { code }, details || {});
  const MANHEIM_MAX_MATCHES = 100000;

  // In-page confirmation (the panel never uses browser dialogs).
  function askInline(anchor, text, confirmLabel) {
    return new Promise((resolve) => {
      const box = element('div', 'warning inline-confirm');
      box.append(element('p', '', text));
      const yes = element('button', 'small', confirmLabel), no = element('button', 'quiet small', 'Cancelar');
      yes.type = 'button'; no.type = 'button';
      const done = (value) => { box.remove(); resolve(value); };
      yes.addEventListener('click', () => done(true)); no.addEventListener('click', () => done(false));
      box.append(yes, no);
      anchor.after(box);
    });
  }

  // Manheim in high volume: every CSV chosen together is ONE batch (manheim-batch). The browser
  // reads the files, removes the same car found in two files and sends blocks of 500 cars; the
  // server compares them with the demands and only activates the batch after the last block. A
  // failure keeps what was confirmed: choosing the same files again continues from there. The screen
  // is reloaded once at the end, never after each file.
  let manheimUploadRunning = false;
  let manheimCancelRequested = false;
  function renderUploadProgress(plan, event, onCancel) {
    let root = $('manheim-progress');
    if (!root) { root = element('div', 'manheim-progress'); root.id = 'manheim-progress'; root.setAttribute('aria-live', 'polite'); $('manheim-status').after(root); }
    root.replaceChildren();
    if (!plan) { root.remove(); return; }
    const bar = element('progress'); bar.max = Math.max(1, event.total); bar.value = event.done;
    root.append(element('strong', '', `Lote único · ${plan.length} arquivo${plan.length === 1 ? '' : 's'} · bloco ${event.done} de ${event.total}`), bar);
    plan.forEach((file, index) => {
      const sent = event.doneByFile ? event.doneByFile[index] || 0 : 0;
      const line = element('div', 'manheim-progress-file');
      line.append(element('span', '', file.name), element('span', 'muted', `${file.vehicleCount} carros · ${sent} de ${file.chunkCount} blocos${sent === file.chunkCount ? ' ✓' : ''}`));
      root.append(line);
    });
    if (onCancel) {
      const actions = element('div', 'inline-actions');
      const cancel = element('button', 'quiet small', 'Cancelar importação'); cancel.type = 'button';
      cancel.addEventListener('click', () => { cancel.disabled = true; cancel.textContent = 'Cancelando…'; onCancel(); });
      actions.append(cancel); root.append(actions);
    }
  }

  async function importManheim(files) {
    const selected = files.filter((file) => /\.csv$/i.test(file.name));
    if (!selected.length || selected.length !== files.length || selected.length > MAX_FILES) throw manheimError('MANHEIM_FILES_INVALID');
    if (!window.MCSManheim || !window.MCSManheimUpload) throw manheimError('MANHEIM_READER_UNAVAILABLE');
    if (manheimUploadRunning) throw manheimError('MANHEIM_UPLOAD_RUNNING');
    manheimUploadRunning = true;
    manheimCancelRequested = false;
    const status = $('manheim-status');
    status.classList.remove('error');
    try {
      const vehicles = [];
      const headerGroups = [];
      const mappings = [];
      const fileMeta = [];
      let ignoredRows = 0;
      const ai = newAiRun();
      for (let fileIndex = 0; fileIndex < selected.length; fileIndex += 1) {
        const file = selected[fileIndex];
        status.textContent = `Lendo ${fileIndex + 1} de ${selected.length}: ${file.name}…`;
        if (file.size > MAX_TEXT) throw manheimError('MANHEIM_FILE_TOO_LARGE', { fileName: file.name });
        let contents;
        try { contents = await file.text(); }
        catch (cause) { throw manheimError('MANHEIM_FILE_READ_FAILED', { cause, fileName: file.name }); }
        // The batch key comes from the real content of the files, not only name and size.
        const contentHash = await sha256(contents);
        const parsed = MCSManheim.parseCsv(contents);
        contents = null;
        let mapping = MCSManheim.mapHeaders(parsed.headers);
        // An unknown header may be read by OpenAI (only the column names are sent).
        if (mapping.missing.length) mapping = await aiHeaderMapping(ai, parsed.headers, mapping, status);
        if (mapping.missing.length) throw manheimError('MANHEIM_CSV_COLUMNS_MISSING', { missing: mapping.missing, fileName: file.name });
        headerGroups.push(parsed.headers);
        mappings.push(mapping.fields);
        const classified = MCSManheim.classifyRows(parsed, mapping);
        ai.rowsTotal += parsed.rows.length;
        ai.rowsDeterministic += classified.vehicles.length;
        const resolved = await resolveAmbiguousRows(ai, classified.ambiguous, mapping, file.name, status);
        const normalized = MCSManheimUpload.markSearchFiltered(MCSManheim.chooseAuctionRows([...classified.vehicles, ...resolved]));
        ignoredRows += parsed.rows.length - normalized.length - (classified.ambiguous.length - resolved.length);
        // Only what travels stays in memory (the lot and the simulcast mark of the raw row).
        normalized.forEach((vehicle) => {
          const compact = MCSManheimUpload.compactVehicle(vehicle);
          vehicles.push({ ...compact, fileIndex, raw: { Inventory: vehicle.raw && vehicle.raw.Inventory || '' }, hasBuyNow: vehicle.hasBuyNow });
        });
        fileMeta.push({ name: file.name, size: file.size, lastModified: file.lastModified || 0, rowCount: parsed.rows.length, contentHash });
      }
      // The same car in two files is one car.
      const deduped = MCSManheimUpload.dedupeAcrossFiles(vehicles, MCSManheim);
      const uniqueCount = deduped.vehicles.length;
      if (uniqueCount > 100000) throw manheimError('MANHEIM_TOO_MANY_VEHICLES', { vehicleCount: uniqueCount });
      // M19: an empty batch, or one much smaller than the active one, replaces the combinations shown
      // in BUSCAS; the operator confirms before sending.
      const current = await request('/api/panel/manheim-batch').catch((failure) => { if (failure && failure.code === 'MANHEIM_MIGRATION_PENDING') throw failure; return { latest: null }; });
      const previousCount = Number(current.latest && current.latest.vehicleCount) || 0;
      const smaller = uniqueCount && previousCount >= 50 && uniqueCount < previousCount / 2;
      if (!uniqueCount || smaller) {
        status.textContent = 'Aguardando confirmação';
        const question = !uniqueCount ? 'Estes arquivos não têm nenhum carro · As combinações atuais de BUSCAS serão substituídas' : `Este lote tem ${uniqueCount} carros e o anterior tinha ${previousCount}. As combinações atuais serão substituídas`;
        if (!(await askInline(status, question, 'Enviar mesmo assim'))) { status.textContent = 'Envio cancelado'; return; }
      }
      const plan = MCSManheimUpload.planBatch(fileMeta, deduped.vehicles, MCSManheim);
      // Manifest: per block, how many cars and the hash of its content. The same files chosen again
      // (after a failure or a reload) give the same key and the same manifest, and the batch continues.
      const manifest = await MCSManheimUpload.sealPlan(plan, sha256);
      const clientKey = (await sha256(MCSManheimUpload.canonicalJson(fileMeta.map((file) => [file.name, file.size, file.contentHash])))).slice(0, 32);
      const doneByFile = plan.map(() => 0);
      status.textContent = `Enviando ${uniqueCount} carros de ${plan.length} arquivo${plan.length === 1 ? '' : 's'} como um lote…`;
      const cancel = () => { manheimCancelRequested = true; };
      let uploadId = null;
      let result;
      try {
        result = await MCSManheimUpload.sendBatch({
          plan, manifest, clientKey, vehicleCount: uniqueCount, headers: headerGroups, headerMap: { files: mappings }, request,
          canceled: () => manheimCancelRequested,
          onProgress: (event) => {
            uploadId = event.uploadId;
            if (event.fileIndex !== null && event.fileIndex !== undefined) doneByFile[event.fileIndex] += 1;
            else (event.resumed || []).forEach(([fileIndex]) => { if (doneByFile[fileIndex] !== undefined) doneByFile[fileIndex] += 1; });
            renderUploadProgress(plan, { ...event, doneByFile }, cancel);
          }
        });
      } catch (failure) {
        if (failure && failure.code === 'MANHEIM_BATCH_CANCELED_BY_OPERATOR') {
          const id = failure.uploadId || uploadId;
          if (id) await request('/api/panel/manheim-batch', { method: 'POST', body: JSON.stringify({ action: 'cancel', uploadId: id }) }).catch(() => null);
          renderUploadProgress(null);
          status.textContent = 'Importação cancelada · Nenhum carro deste lote entrou em BUSCAS e o lote ativo não mudou';
          return;
        }
        throw failure;
      }
      renderUploadProgress(null);
      const DISCARD_TEXT = result.discarded ? ` · ${result.discarded} descartada(s) porque a ficha mudou durante o envio` : '';
      const duplicatesText = deduped.duplicates ? ` · ${deduped.duplicates} repetido(s) entre arquivos` : '';
      status.textContent = `Lote ativo · ${result.fileCount || plan.length} arquivo(s) · ${result.vehicleCount} carros · ${result.matchedVehicleCount} carro(s) com combinação · ${ignoredRows} linha(s) ignorada(s)${duplicatesText}${DISCARD_TEXT}`;
      renderImportSummary(ai, uniqueCount);
      if (ai.rowsSentToAi || ai.review.length) await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'manheim_ai_summary', uploadId: result.uploadId, summary: aiSummary(ai) }) }).catch(() => null);
      if (requestPool) requestPool.invalidate();
      // One reload of the screen and of the counters, after the whole batch.
      await loadCurrent().catch(() => {});
      await refreshCounters().catch(() => {});
      // MANHEIM_MATCH_AUDIT: the options show "Conferindo" and the check starts right after the upload.
      if (manheimData?.audit?.state === 'LIGADA') request('/api/panel/manheim-audit', { method: 'POST', body: JSON.stringify({ action: 'run' }), timeoutMs: 60000 }).then(() => loadCurrent()).catch(() => loadCurrent().catch(() => {}));
    } finally {
      manheimUploadRunning = false;
    }
  }

  // OpenAI for ambiguous rows only. Rows the parser reads with safety never go to the AI; the AI
  // answer goes back through the same parser; what is still ambiguous goes to review. When the
  // AI is off or fails, the valid rows are imported and only the ambiguous ones go to review.
  function newAiRun() {
    return { rowsTotal: 0, rowsDeterministic: 0, rowsSentToAi: 0, rowsAccepted: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0, errors: 0, timeouts: 0, unavailable: false, model: null, review: [], cache: new Map(), headers: new Map(), at: new Date().toISOString() };
  }
  function aiUsage(ai, answer) {
    if (!answer || !answer.available) { ai.unavailable = true; if (answer && answer.reason === 'OPENAI_TIMEOUT') ai.timeouts += 1; else if (answer && answer.reason !== 'OPENAI_NOT_ENABLED') ai.errors += 1; return; }
    ai.model = answer.model || ai.model;
    ai.inputTokens += Number(answer.usage?.inputTokens) || 0; ai.outputTokens += Number(answer.usage?.outputTokens) || 0;
    ai.costUsd += Number(answer.costUsd) || 0; ai.ms += Number(answer.ms) || 0;
  }
  // Cost control: at most this many ambiguous rows per batch go to OpenAI; the rest go to review.
  const AI_MAX_ROWS_PER_BATCH = 1000;
  async function aiHeaderMapping(ai, headers, mapping, status) {
    const signature = JSON.stringify([headers, mapping.missing]);
    if (ai.headers.has(signature)) return MCSManheim.mapHeadersWith(headers, ai.headers.get(signature));
    status.textContent = 'Lendo cabeçalho desconhecido…';
    const answer = await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'manheim_ai_rows', headerMap: { headers, missing: mapping.missing } }) }).catch(() => ({ available: false, reason: 'OPENAI_FAILED' }));
    aiUsage(ai, answer);
    if (answer && answer.available && answer.mapping) ai.headers.set(signature, answer.mapping);
    return answer && answer.available && answer.mapping ? MCSManheim.mapHeadersWith(headers, answer.mapping) : mapping;
  }
  async function resolveAmbiguousRows(ai, rows, mapping, fileName, status) {
    if (!rows.length) return [];
    const keyOf = (row) => JSON.stringify([row.ambiguous, MCSManheim.AI_FIELDS.map((field) => row.cells[field])]);
    // The same normalized input is asked once per batch.
    const pending = [...new Map(rows.filter((row) => !ai.cache.has(keyOf(row))).map((row) => [keyOf(row), row])).values()];
    for (let index = 0; index < pending.length && !ai.unavailable && ai.rowsSentToAi < AI_MAX_ROWS_PER_BATCH; index += 25) {
      status.textContent = `Lendo ${rows.length} linha(s) ambígua(s)…`;
      const chunk = pending.slice(index, Math.min(index + 25, index + AI_MAX_ROWS_PER_BATCH - ai.rowsSentToAi));
      const answer = await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'manheim_ai_rows', rows: chunk.map((row, position) => ({ id: String(position), cells: row.cells, ambiguous: row.ambiguous })) }) }).catch(() => ({ available: false, reason: 'OPENAI_FAILED' }));
      aiUsage(ai, answer);
      if (!answer || !answer.available) break;
      ai.rowsSentToAi += chunk.length;
      chunk.forEach((row, position) => ai.cache.set(keyOf(row), (answer.suggestions || []).find((item) => item.id === String(position)) || null));
    }
    const accepted = [];
    rows.forEach((row) => {
      const key = keyOf(row);
      if (!ai.cache.has(key)) { ai.review.push({ row: row.rowNumber, file: fileName, reason: ai.unavailable ? 'leitura automática indisponível' : 'limite de leitura automática do lote' }); return; }
      const outcome = MCSManheim.applySuggestion(row, ai.cache.get(key), mapping, ai.model);
      if (outcome.vehicle) { accepted.push(outcome.vehicle); ai.rowsAccepted += 1; }
      else ai.review.push({ row: row.rowNumber, file: fileName, reason: outcome.review });
    });
    return accepted;
  }
  function aiSummary(ai) {
    return { provider: 'openai', model: ai.model, at: ai.at, rowsTotal: ai.rowsTotal, rowsDeterministic: ai.rowsDeterministic, rowsSentToAi: ai.rowsSentToAi, rowsAccepted: ai.rowsAccepted, rowsReview: ai.review.length, inputTokens: ai.inputTokens, outputTokens: ai.outputTokens, costUsd: ai.costUsd, ms: ai.ms, errors: ai.errors, timeouts: ai.timeouts, unavailable: ai.unavailable, review: ai.review.slice(0, 200) };
  }
  function renderImportSummary(ai, imported) {
    const root = $('manheim-import-summary');
    if (!root) return;
    root.replaceChildren();
    const usedAi = ai.rowsSentToAi > 0;
    if (!usedAi && !ai.review.length && !ai.rowsTotal) { root.classList.add('hidden'); return; }
    root.classList.remove('hidden');
    const line = (text) => root.append(element('span', '', text));
    // Rows of the CSV and cars are different things: never call cars "rows".
    const ignored = Math.max(ai.rowsTotal - imported - ai.review.length, 0);
    line(`${ai.rowsTotal.toLocaleString('pt-BR')} linhas lidas do CSV`);
    line(`${imported.toLocaleString('pt-BR')} veículos únicos importados`);
    line(`${ignored.toLocaleString('pt-BR')} linhas duplicadas ou inválidas ignoradas`);
    if (usedAi) {
      line(`${ai.rowsSentToAi} analisadas pela OpenAI`);
      line(`${ai.rowsAccepted} confirmadas`);
    }
    line(`${ai.review.length.toLocaleString('pt-BR')} linhas em revisão`);
    if (usedAi) {
      line(`Modelo: ${ai.model || 'não informado'}`);
      line(`Custo estimado: US$ ${ai.costUsd.toFixed(4)}`);
      line(`Tempo com IA: ${(ai.ms / 1000).toFixed(1)} s`);
    }
    if (ai.review.length) {
      const details = element('details', 'import-review');
      details.append(element('summary', '', 'Linhas para revisão'), ...ai.review.slice(0, 50).map((item) => element('p', 'muted', `${item.file} · linha ${item.row} · ${item.reason}`)));
      root.append(details);
    }
  }

  const MANHEIM_FAILURE_MESSAGES = {
    MANHEIM_FILES_INVALID: 'Selecione de 1 a ' + MAX_FILES + ' arquivos .csv do Manheim (outros formatos não são aceitos)',
    MANHEIM_READER_UNAVAILABLE: 'O leitor de CSV não carregou · Atualize a página e tente novamente',
    MANHEIM_FILE_TOO_LARGE: 'O CSV excede o limite permitido',
    MANHEIM_FILE_READ_FAILED: 'O navegador não conseguiu ler o CSV selecionado · Selecione o arquivo novamente',
    MANHEIM_MATCH_LIMIT: 'O CSV gerou mais de ' + MANHEIM_MAX_MATCHES.toLocaleString('pt-BR') + ' combinações; divida o arquivo',
    MANHEIM_MATCH_TOO_LARGE: 'Uma linha do CSV é grande demais para ser enviada',
    MANHEIM_TOO_MANY_VEHICLES: 'Os CSVs somam mais de 100.000 carros · Envie menos arquivos de cada vez',
    MANHEIM_UPLOAD_INVALID: 'O resumo do CSV não passou na validação',
    MANHEIM_MATCH_INVALID: 'Uma linha compatível não passou na validação',
    MANHEIM_JOURNEY_ID_INVALID: 'Uma combinação veio com identificador de cliente inválido · Atualize a página e envie de novo',
    MANHEIM_JOURNEY_DISABLED: 'Uma busca não está disponível para comparação',
    MANHEIM_UPLOAD_NOT_FOUND: 'O servidor não encontrou este envio · Envie o CSV de novo',
    MANHEIM_MIGRATION_PENDING: 'Importação em lote único indisponível · Nada foi enviado · O painel precisa de uma atualização para liberar este recurso · Avise o responsável',
    MANHEIM_UPLOAD_RUNNING: 'Já existe uma importação em andamento nesta aba · Espere terminar ou cancele',
    MANHEIM_BATCH_CANCELED: 'Esta importação foi cancelada · Selecione os arquivos de novo para começar outra',
    MANHEIM_BATCH_ALREADY_ACTIVE: 'Este lote já estava ativo; nada foi enviado de novo',
    MANHEIM_BATCH_INCOMPLETE: 'Faltam blocos deste envio no servidor · Nada foi ativado e o lote ativo não mudou · Selecione os mesmos arquivos de novo para completar o envio ou descarte-o',
    MANHEIM_BATCH_INTEGRITY_ERROR: 'A conferência final encontrou diferença entre os carros recebidos e os declarados no início do envio · Nada foi ativado e o lote ativo não mudou · Descarte este envio e selecione os arquivos de novo; se repetir, confira se os arquivos não foram alterados',
    MANHEIM_BATCH_RESUME_MISMATCH: 'Existe um envio interrompido destes arquivos, mas ele não confere com o que foi lido agora · Ele não será continuado · Descarte o envio anterior e selecione os arquivos de novo para começar outro lote',
    REQUEST_TIMEOUT: 'O servidor demorou para responder',
    NETWORK_ERROR: 'Sem conexão com o servidor',
    MANHEIM_ARCHIVE_INVALID: 'Os carros foram comparados, mas o arquivo de carros não passou na validação',
    PAYLOAD_TOO_LARGE: 'O resultado compatível excede o limite de envio',
    PANEL_ACTION_FAILED: 'A comparação foi lida, mas não pôde ser gravada · Tente novamente',
    AUTHENTICATION_REQUIRED: 'A sessão expirou · Entre novamente'
  };

  // What happened and what to do, for the refusals that protect the integrity of the batch.
  const CHUNK_REFUSALS = {
    MANHEIM_CHUNK_CONFLICT: (where) => `O bloco ${where} já tinha sido recebido com outro conteúdo: os arquivos mudaram desde o primeiro envio · Nada foi gravado neste bloco, nada foi ativado e o lote ativo não mudou · Descarte este envio e selecione os arquivos de novo para começar outro lote`,
    MANHEIM_CHUNK_HASH_MISMATCH: (where) => `O conteúdo do bloco ${where} não confere com o que foi declarado no início do envio · Nada foi gravado neste bloco, nada foi ativado e o lote ativo não mudou · Descarte este envio e selecione os arquivos de novo; se repetir, confira se o arquivo não está sendo alterado`
  };
  const RESUME_REASONS = {
    MANIFEST: 'Existe um envio interrompido destes arquivos, mas o conteúdo lido agora é diferente do primeiro envio · Ele não será continuado · Descarte o envio anterior e selecione os arquivos de novo para começar outro lote',
    TARGETS: 'Existe um envio interrompido destes arquivos, mas as buscas dos clientes mudaram desde que ele começou · Para não misturar critérios, ele não será continuado · Descarte o envio anterior e selecione os arquivos de novo para começar outro lote'
  };
  function manheimFailureText(failure) {
    const code = failure && failure.code;
    if (code === 'MANHEIM_BATCH_RESUME_MISMATCH' && RESUME_REASONS[failure.reason]) return RESUME_REASONS[failure.reason];
    if (code === 'MANHEIM_UPLOAD_INCOMPLETE' && failure.fileName && CHUNK_REFUSALS[failure.cause && failure.cause.code]) return CHUNK_REFUSALS[failure.cause.code](`${Number(failure.chunkIndex) + 1} de ${failure.fileName}`);
    if (code === 'MANHEIM_CSV_COLUMNS_MISSING') return `CSV incompleto: faltam ${(failure.missing || []).join(', ')}.`;
    if (code === 'MANHEIM_UPLOAD_INCOMPLETE') {
      const cause = failure.cause;
      const detail = MANHEIM_FAILURE_MESSAGES[cause && cause.code] || `${cause && (cause.code || cause.message) || 'sem resposta'}`;
      // Lote único: the blocks already confirmed stay on the server; the same files continue from there.
      if (failure.fileName) return `Envio interrompido em ${failure.fileName}, bloco ${Number(failure.chunkIndex) + 1} (${detail}) · Nada foi ativado e o lote ativo não mudou · Selecione os mesmos arquivos de novo para continuar de onde parou`;
      const retried = !(window.MCSManheimUpload && MCSManheimUpload.FINAL_ERRORS.has(cause && cause.code));
      return `Envio incompleto: a parte ${failure.partIndex} de ${failure.partCount} falhou${retried ? ' depois de 3 tentativas' : ''} (${detail}) · O último envio continua sendo o anterior`;
    }
    if (code === 'MANHEIM_ARCHIVE_FAILED') {
      const cause = failure.cause;
      return `As combinações foram gravadas, mas o arquivo de carros falhou (${MANHEIM_FAILURE_MESSAGES[cause && cause.code] || cause && (cause.code || cause.message) || 'sem resposta'}).`;
    }
    if (code && MANHEIM_FAILURE_MESSAGES[code]) return MANHEIM_FAILURE_MESSAGES[code];
    if (failure && failure.message === 'MCSManheim is not defined') return MANHEIM_FAILURE_MESSAGES.MANHEIM_READER_UNAVAILABLE;
    return `Erro inesperado: ${code || (failure && failure.message) || String(failure)}`;
  }

  // Complemento do lote ativo: os MESMOS CSVs lidos de novo só acrescentam Lane, Run, Inventory,
  // Status e Event Sale Name aos carros que o lote já tem. Cada arquivo é comparado com o manifesto
  // gravado no lote (hash canônico do conteúdo, a mesma normalização da importação); o servidor
  // confere de novo bloco a bloco. A prévia só lê. Depois do "Complementar agora" os blocos vão para
  // uma área de conferência e a gravação é uma transação só: faltou um carro, nada é gravado. Não cria
  // lote nem match, não mexe em MMR, critérios, seleção, V1/V2 ou histórico, não chama OpenAI e não
  // envia mensagem.
  const SALE_KEYS = ['lane', 'run', 'saleType', 'saleStatus', 'eventSaleName'];
  const COMPLEMENT_MESSAGES = {
    MANHEIM_COMPLEMENT_NOT_ACTIVE: 'Não há lote ativo para complementar, ou o lote ativo mudou · Nada foi gravado',
    MANHEIM_COMPLEMENT_MISMATCH: 'Estes arquivos não conferem com o manifesto do lote ativo · Nada foi gravado · Selecione exatamente os mesmos CSVs importados no lote ativo',
    MANHEIM_COMPLEMENT_FILES_DIFFER: 'A seleção não tem exatamente os arquivos do lote ativo (falta arquivo, sobra arquivo ou o nome mudou) · Nada foi gravado',
    MANHEIM_COMPLEMENT_COLUMNS_MISSING: 'Estes CSVs não têm as colunas Lane e Run · Nada foi gravado',
    MANHEIM_COMPLEMENT_INCOMPLETE: 'Nem todos os blocos chegaram para a conferência · Nada foi gravado · Selecione os mesmos arquivos de novo',
    MANHEIM_COMPLEMENT_CANCELED: 'Este complemento foi cancelado · Nada foi gravado · Selecione os mesmos arquivos de novo',
    MANHEIM_COMPLEMENT_CONFIRM_REQUIRED: 'O complemento precisa da sua confirmação antes de gravar · Nada foi gravado',
    MANHEIM_COMPLEMENT_PENDING: 'Complemento do lote indisponível · Nada foi lido nem gravado · O painel precisa de uma atualização para liberar este recurso · Avise o responsável',
    MANHEIM_UPLOAD_RUNNING: 'Já existe uma importação ou um complemento em andamento nesta aba · Espere terminar',
    MANHEIM_FILES_INVALID: 'Selecione só os arquivos CSV do Manheim'
  };
  function complementFailure(failure) {
    const status = $('manheim-complement-status');
    status.classList.add('error');
    const code = failure && failure.code;
    if (code === 'MANHEIM_COMPLEMENT_FILE_MISMATCH') { status.textContent = `O arquivo ${failure.fileName} não confere com o que foi importado no lote ativo (conteúdo diferente) · Nada foi gravado`; return; }
    status.textContent = COMPLEMENT_MESSAGES[code] || (MANHEIM_FAILURE_MESSAGES[code] ? MANHEIM_FAILURE_MESSAGES[code] + '. O complemento parou e nada foi gravado' : `O complemento parou e nada foi gravado: ${code || (failure && failure.message) || 'erro inesperado'}`);
  }
  async function complementManheim(files) {
    const selected = files.filter((file) => /\.csv$/i.test(file.name));
    if (!selected.length || selected.length !== files.length || selected.length > MAX_FILES) throw manheimError('MANHEIM_FILES_INVALID');
    if (!window.MCSManheim || !window.MCSManheimUpload) throw manheimError('MANHEIM_READER_UNAVAILABLE');
    if (manheimUploadRunning) throw manheimError('MANHEIM_UPLOAD_RUNNING');
    manheimUploadRunning = true;
    const status = $('manheim-complement-status');
    status.classList.remove('error');
    const post = (body) => request('/api/panel/manheim-batch', { method: 'POST', timeoutMs: 60000, body: JSON.stringify(body) });
    let runId = null;
    try {
      const { latest } = await request('/api/panel/manheim-batch');
      if (!latest || !Array.isArray(latest.files) || !latest.files.length) throw manheimError('MANHEIM_COMPLEMENT_NOT_ACTIVE');
      // Read in the order of the batch (a car in two files resolves as in the import). The name only
      // orders; the proof is the content hash of each file compared with the manifest.
      const ordered = latest.files.map((entry) => selected.find((file) => file.name === entry.name));
      if (ordered.some((file) => !file) || selected.length !== latest.files.length) throw manheimError('MANHEIM_COMPLEMENT_FILES_DIFFER');
      const vehicles = [];
      const fileMeta = [];
      for (let fileIndex = 0; fileIndex < ordered.length; fileIndex += 1) {
        const file = ordered[fileIndex];
        status.textContent = `Lendo ${fileIndex + 1} de ${ordered.length}: ${file.name}…`;
        if (file.size > MAX_TEXT) throw manheimError('MANHEIM_FILE_TOO_LARGE', { fileName: file.name });
        const contents = await file.text();
        const contentHash = await sha256(contents);
        const parsed = MCSManheim.parseCsv(contents);
        const mapping = MCSManheim.mapHeaders(parsed.headers);
        if (mapping.missing.length) throw manheimError('MANHEIM_COMPLEMENT_FILE_MISMATCH', { fileName: file.name });
        if (!mapping.fields.lane || !mapping.fields.run) throw manheimError('MANHEIM_COMPLEMENT_COLUMNS_MISSING');
        // Only the rows read without OpenAI, as in the import (rows in review stay out).
        const classified = MCSManheim.classifyRows(parsed, mapping);
        MCSManheimUpload.markSearchFiltered(MCSManheim.chooseAuctionRows(classified.vehicles)).forEach((vehicle) => {
          vehicles.push({ ...MCSManheimUpload.compactVehicle(vehicle), fileIndex, raw: { Inventory: vehicle.raw && vehicle.raw.Inventory || '' }, hasBuyNow: vehicle.hasBuyNow });
        });
        fileMeta.push({ name: file.name, size: file.size, rowCount: parsed.rows.length, contentHash });
      }
      status.textContent = 'Conferindo cada arquivo com o manifesto do lote ativo…';
      const deduped = MCSManheimUpload.dedupeAcrossFiles(vehicles, MCSManheim);
      const plan = MCSManheimUpload.planBatch(fileMeta, deduped.vehicles, MCSManheim);
      // The manifest as the batch was imported: without the sale data (older batch) or with it.
      const stripped = plan.map((file) => ({ ...file, chunks: file.chunks.map((chunk) => chunk.map((entry) => { const vehicle = { ...entry.vehicle }; SALE_KEYS.forEach((key) => { delete vehicle[key]; }); return { ...entry, vehicle }; })) }));
      const variants = [await MCSManheimUpload.sealPlan(stripped, sha256), await MCSManheimUpload.sealPlan(plan.map((file) => ({ ...file })), sha256)];
      const fileHashes = await Promise.all(variants.map((variant) => Promise.all(variant.files.map((entry) => sha256(MCSManheimUpload.canonicalJson(entry))))));
      const variant = fileHashes.findIndex((hashes) => hashes.every((hash, index) => hash === latest.files[index].hash));
      if (variant < 0) {
        const index = latest.files.findIndex((entry, position) => fileHashes.every((hashes) => hashes[position] !== entry.hash));
        throw manheimError('MANHEIM_COMPLEMENT_FILE_MISMATCH', { fileName: (latest.files[index] || latest.files[0]).name });
      }
      const manifestHash = variants[variant].manifestHash;
      const clientKey = (await sha256(MCSManheimUpload.canonicalJson(fileMeta.map((file) => [file.name, file.size, file.contentHash])))).slice(0, 32);
      const blocks = [];
      plan.forEach((file, fileIndex) => file.chunks.forEach((vehiclesOfChunk, chunkIndex) => blocks.push({ fileIndex, chunkIndex, vehicles: vehiclesOfChunk })));
      const keys = { uploadId: latest.id, clientKey, manifestHash };
      // 1) Preview, read only.
      const preview = { received: 0, found: 0, missing: 0, changed: 0, lane: 0, offLane: 0, incomplete: 0 };
      for (let index = 0; index < blocks.length; index += 1) {
        status.textContent = `Conferindo com o lote ativo · bloco ${index + 1} de ${blocks.length}`;
        const answer = await post({ action: 'complement-check', ...keys, ...blocks[index] }).catch((failure) => {
          if (failure && failure.code === 'MANHEIM_COMPLEMENT_MISMATCH' && Number.isInteger(failure.fileIndex)) throw manheimError('MANHEIM_COMPLEMENT_FILE_MISMATCH', { fileName: plan[failure.fileIndex].name });
          throw failure;
        });
        Object.keys(preview).forEach((key) => { preview[key] += Number(answer[key]) || 0; });
      }
      if (preview.missing || !preview.found) throw manheimError('MANHEIM_COMPLEMENT_MISMATCH');
      if (!preview.changed) { status.textContent = `Nada a complementar · os ${preview.found} carros do lote ativo já têm estes dados`; return; }
      status.textContent = 'Aguardando confirmação';
      const question = `${preview.found} carros do lote ativo conferidos com o manifesto · ${preview.changed} vão receber Lane, Run, Inventory, Status e Event Sale Name: ${preview.lane} com Lane/Run, ${preview.offLane} Buy Now / Make Offer, ${preview.incomplete} ainda incompletos · Nenhum lote, match, MMR, seleção ou V1/V2 muda e nenhuma mensagem é enviada`;
      if (!(await askInline(status, question, 'Complementar agora'))) { status.textContent = 'Complemento cancelado · Nada foi gravado'; return; }
      // 2) Conference area, then one transaction.
      const started = await post({ action: 'complement-start', ...keys, confirmed: true });
      runId = started.runId;
      const have = new Set((started.received || []).map(([file, chunk]) => file + ':' + chunk));
      for (let index = 0; index < blocks.length; index += 1) {
        if (have.has(blocks[index].fileIndex + ':' + blocks[index].chunkIndex)) continue;
        status.textContent = `Complementando · conferindo bloco ${index + 1} de ${blocks.length}`;
        await post({ action: 'complement-stage', ...keys, runId, ...blocks[index] });
      }
      status.textContent = 'Complementando · gravando tudo de uma vez…';
      const done = await post({ action: 'complement-apply', runId, confirmed: true });
      runId = null;
      if (!done.applied) { status.textContent = `Nada a complementar · os ${done.cars} carros do lote ativo já têm estes dados`; return; }
      status.textContent = 'Complemento gravado · somando os grupos…';
      const totals = await post({ action: 'complement-result', uploadId: latest.id }).catch(() => null);
      status.textContent = totals
        ? `Complemento concluído · ${totals.withSale} carros complementados · ${totals.lane} com Lane/Run · ${totals.offLane} Buy Now / Make Offer · ${totals.incomplete} ainda incompletos · ${totals.matches} combinações`
        : `Complemento concluído · ${done.cars} carros complementados · Os totais aparecem em BUSCAS`;
      if (requestPool) requestPool.invalidate();
      await loadCurrent().catch(() => {});
    } catch (failure) {
      if (runId) await post({ action: 'complement-cancel', runId }).catch(() => null);
      throw failure;
    } finally {
      manheimUploadRunning = false;
    }
  }

  function showManheimFailure(failure) {
    console.error(failure);
    renderUploadProgress(null);
    // An interrupted or refused batch waits on the server (never active). The operator may continue
    // (same files again, when that is possible) or discard it.
    if (failure && failure.uploadId && ['MANHEIM_UPLOAD_INCOMPLETE', 'MANHEIM_BATCH_RESUME_MISMATCH', 'MANHEIM_BATCH_INCOMPLETE', 'MANHEIM_BATCH_INTEGRITY_ERROR'].includes(failure.code)) {
      const holder = element('div', 'manheim-progress'); holder.id = 'manheim-progress';
      const discard = element('button', 'quiet small', 'Descartar este envio'); discard.type = 'button';
      MCSAction.bind(discard, () => ({ scope: holder, commit: () => request('/api/panel/manheim-batch', { method: 'POST', body: JSON.stringify({ action: 'cancel', uploadId: failure.uploadId }) }), onSuccess: () => { $('manheim-status').classList.remove('error'); $('manheim-status').textContent = 'Envio descartado · O lote ativo não mudou'; holder.remove(); }, errorText: 'Não consegui descartar, tente de novo' }));
      const actions = element('div', 'inline-actions'); actions.append(discard); holder.append(actions);
      $('manheim-status').after(holder);
    }
    $('manheim-status').classList.add('error');
    $('manheim-status').textContent = manheimFailureText(failure);
  }

  function renderRecords(items) {
    const root = $('records-list');
    root.replaceChildren();
    setCount('records', items.length);
    if (!items.length) {
      clearRecordDetail('Nenhuma ficha selecionada');
      return empty(root, 'Nenhuma ficha criada');
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
    const bindMutation=(control,commit,scope=menu)=>MCSAction.bind(control,()=>({scope,commit,refresh:reload,errorText:'Não consegui salvar, tente de novo'}));
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
        const minMiles = element('input'); minMiles.type = 'number'; minMiles.placeholder = 'Milhas de'; minMiles.min = '0'; minMiles.max = '2000000';
        const maxMiles = element('input'); maxMiles.type = 'number'; maxMiles.placeholder = 'Milhas até'; maxMiles.min = '0'; maxMiles.max = '2000000';
        row.append(make, model, yearMin, yearMax, minMiles, maxMiles);
        wishlistRows.push({ make, model, yearMin, yearMax, minMiles, maxMiles });
        wishlistForm.append(row);
      };
      addWishlistRow();
      const addVehicle = element('button', 'quiet small', '+ outro carro');
      addVehicle.type = 'button';
      addVehicle.addEventListener('click', addWishlistRow);
      const wishlistButton = element('button', 'quiet small', 'Carro ou faixa');
      wishlistButton.type = 'button';
      // Every change of car, range or bid says which search it belongs to. With both searches on
      // the ficha, the server refuses a change without mode instead of applying it to both.
      const wishlistMode = element('select', 'wishlist-mode');
      wishlistMode.setAttribute('aria-label', 'Para qual busca');
      [['', 'Para qual busca'], ['VALOR', 'Por valor'], ['CARRO', 'Por ano e milhagem']].forEach(([value, label]) => { const option = element('option', '', label); option.value = value; wishlistMode.append(option); });
      MCSAction.bind(wishlistButton, () => ({ scope: menu, refresh: reload, errorText: (failure) => failure && failure.code === 'SEARCH_MODE_REQUIRED' ? 'Esta ficha tem busca por valor e por ano e milhagem, escolha para qual é a mudança' : 'Não consegui salvar, tente de novo', commit: async () => {
        const wishlists = wishlistRows.filter((row) => row.model.value.trim()).map((row) => ({
          make: row.make.value, model: row.model.value, yearMin: row.yearMin.value || null,
          yearMax: row.yearMax.value || null, minMiles: row.minMiles.value || null, maxMiles: row.maxMiles.value || null
        }));
        await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({
          action: 'mark_message', journeyId, ref, messageId: message.id, kind: 'VEHICLE',
          wishlists, mode: wishlistMode.value || null
        }) });
      } }));
      wishlistForm.prepend(wishlistButton, wishlistMode, addVehicle);
      menu.append(wishlistForm);
      // Teto total (R2): the field starts empty, the amount is read locally and must be
      // confirmed before it is saved in confirmed_total_ceiling_cents.
      const ceilingRow = element('div', 'menu-action ceiling-action');
      const ceilingValue = element('input');
      ceilingValue.maxLength = 120;
      ceilingValue.placeholder = 'Teto total (ex.: 35k, US$ 35.000)';
      const ceilingReview = element('button', 'quiet small', 'Teto');
      ceilingReview.type = 'button';
      const ceilingConfirm = element('button', 'small hidden', '');
      ceilingConfirm.type = 'button';
      let ceilingCents = null;
      ceilingValue.addEventListener('input', () => { ceilingCents = null; ceilingConfirm.classList.add('hidden'); });
      ceilingReview.addEventListener('click', () => {
        ceilingCents = window.MCSMoneyText ? MCSMoneyText.parseMoneyCents(ceilingValue.value) : null;
        if (ceilingCents === null) { MCSAction.feedback(ceilingRow, 'Digite o valor do teto total (ex.: 35k ou US$ 35.000)', 'error', 'ceiling'); return; }
        ceilingConfirm.textContent = `Confirmar teto total: ${MCSMoneyText.formatUsd(ceilingCents)}?`;
        ceilingConfirm.classList.remove('hidden');
      });
      ceilingConfirm.addEventListener('click', async () => {
        if (ceilingCents === null || ceilingConfirm.disabled) return;
        ceilingConfirm.disabled = true;
        try {
          await request('/api/panel/actions', { method: 'POST', body: JSON.stringify({ action: 'mark_message', journeyId, ref, messageId: message.id, kind: 'BUDGET', value: ceilingValue.value }) });
          MCSAction.feedback(ceilingRow, `Teto total salvo: ${MCSMoneyText.formatUsd(ceilingCents)}`, '', 'ceiling');
          ceilingConfirm.classList.add('hidden');
          Promise.resolve(reload()).catch(() => {});
        } catch (failure) {
          const text = failure && failure.code === 'JOURNEY_CLOSED' ? 'Lead encerrado: reabra o lead antes de registrar o teto'
            : failure && failure.code === 'CEILING_VALUE_INVALID' ? 'Não encontrei um valor no texto · Digite só o teto total (ex.: 35k)'
            : 'Não consegui salvar, tente de novo';
          MCSAction.feedback(ceilingRow, text, 'error', 'ceiling');
        } finally { ceilingConfirm.disabled = false; }
      });
      ceilingRow.append(ceilingReview, ceilingValue, ceilingConfirm);
      menu.append(ceilingRow);
      const choices = [
        ['PAYMENT', 'Pagamento', true],
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


  // Resposta pelo painel: escrevo em português, a IA traduz, eu confiro a volta e envio pelo WhatsApp.
  // Só aparece quando o servidor diz que a ficha tem um único chat WhatsApp individual com telefone.
  // Lote 4: kept on purpose. No screen opens it any more (the ficha is lead.js), but tests
  // still pin its conversation sort, timeline and reply composer. Remove together with them.
  async function openRecord(id, options = {}) {
    const data = await request('/api/panel/records?id=' + encodeURIComponent(id));
    updateMeta(data.meta);
    const item = data.item;
    const root = $('record-detail');
    root.replaceChildren();
    if (options.prepend) root.append(options.prepend);
    const reload = () => openRecord(id, options);
    const bindRecordAction=(control,commit,scope)=>MCSAction.bind(control,()=>({scope:scope||control.closest('.record-block')||root,commit,refresh:reload,errorText:'Não consegui salvar, tente de novo'}));
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
    definition(budgetDefinition, 'Lance máximo', formatMoney(item.budget_cents));
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
    if (!openReturns.length) returnBlock.append(element('p', 'muted', 'Nenhum retorno aberto'));
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
    if (!item.units.length) unitsBlock.append(element('p', 'muted', 'Nenhuma unidade apresentada'));
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
        const invert = element('button', 'quiet small', conversationChatIds.length === 1 ? 'Inverter remetentes desta conversa' : 'Inverter remetentes desta conversa');
        invert.type = 'button';
        invert.addEventListener('click',()=>{if(invert.dataset.confirmed!=='true'){invert.dataset.confirmed='true';invert.textContent='Confirmar inversão';return;}MCSAction.run({button:invert,scope:senderTools,commit:()=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action:'invert_senders',journeyId:id,chatId})}),refresh:reload,errorText:'Não consegui salvar, tente de novo'});});
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
      if (!timeline.childNodes.length) timeline.append(element('p', 'muted', 'Nenhuma mensagem neste filtro'));
    };
    sort.addEventListener('change', () => { localStorage.setItem('mcs_conversation_sort', sort.value); renderConversation(); });
    filter.addEventListener('change', renderConversation);
    conversationBlock.append(timeline);
    renderConversation();
    replyComposer(conversationBlock, id, reload);
    right.append(conversationBlock);
  }

  async function replyComposer(block, journeyId, reload) {
    let state;
    try { state = await request('/api/panel/reply', { method: 'POST', body: JSON.stringify({ action: 'window', journeyId }) }); } catch (_) { return; }
    // A20: the composer only appears while the 24 h window (last customer message) is open.
    if (!state || !state.allowed || !(Date.parse(state.openUntil) > Date.now())) {
      const note = element('p', 'reply-window muted', 'Responder pelo painel: só com mensagem do cliente nas últimas 24 h · fora disso, responda pelo app do WhatsApp');
      note.dataset.replyClosed = 'true';
      block.append(note);
      return;
    }
    const box = element('div', 'reply-composer');
    box.append(element('h4', '', 'Responder pelo painel'));
    const windowLine = element('p', 'reply-window muted');
    const ptLabel = element('label', '', 'Sua mensagem (português)');
    const pt = element('textarea'); pt.maxLength = 4000; pt.rows = 4; ptLabel.append(pt);
    const translateButton = element('button', 'small', 'Traduzir'); translateButton.type = 'button';
    const enLabel = element('label', '', 'Vai para o cliente (inglês)');
    const en = element('textarea'); en.readOnly = true; en.rows = 4; enLabel.append(en);
    const backLabel = element('label', '', 'Conferência (volta para o português)');
    const back = element('textarea'); back.readOnly = true; back.rows = 4; backLabel.append(back);
    const sendButton = element('button', 'small', 'Enviar'); sendButton.type = 'button';
    const status = element('p', 'reply-status', '');
    let translatedFor = null, busy = false;
    const closedText = 'Mais de 24 h desde a última mensagem do cliente · responda pelo app do WhatsApp';
    const floridaTime = (value) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
    const windowOpen = () => state.allowed && Date.parse(state.openUntil) > Date.now();
    const refresh = () => {
      windowLine.textContent = windowOpen() ? `Janela aberta até ${floridaTime(state.openUntil)} (Flórida)` : closedText;
      translateButton.disabled = busy || !pt.value.trim();
      sendButton.disabled = busy || !windowOpen() || !en.value || translatedFor !== pt.value.trim();
    };
    pt.addEventListener('input', () => { if (translatedFor !== pt.value.trim()) status.textContent = en.value ? 'Texto mudou · traduza de novo antes de enviar' : ''; refresh(); });
    translateButton.addEventListener('click', async () => {
      const text = pt.value.trim(); if (!text) return;
      busy = true; status.textContent = 'Traduzindo…'; refresh();
      try {
        const out = await request('/api/panel/reply', { method: 'POST', body: JSON.stringify({ action: 'translate', text }) });
        en.value = out.en; back.value = out.pt_back; translatedFor = text; status.textContent = '';
      } catch (_) { status.textContent = 'IA indisponível'; }
      busy = false; refresh();
    });
    sendButton.addEventListener('click', async () => {
      if (sendButton.disabled) return;
      busy = true; status.textContent = 'Enviando…'; refresh();
      try {
        await request('/api/panel/reply', { method: 'POST', body: JSON.stringify({ action: 'send', journeyId, textEn: en.value }) });
        status.textContent = 'Enviado'; busy = false; reload(); return;
      } catch (failure) {
        const code = failure.code || 'REQUEST_FAILED';
        if (code === 'WINDOW_CLOSED') { state = { allowed: false }; status.textContent = closedText; }
        else if (code === 'SENT_NOT_RECORDED') status.textContent = 'Enviado ao cliente, mas não registrado no painel · não reenvie';
        else if (/^D360_/.test(code)) status.textContent = `${code} · Não enviado · nada foi registrado`;
        else status.textContent = `${code} · Não enviado`;
      }
      busy = false; refresh();
    });
    const translateRow = element('div', 'inline-actions'); translateRow.append(translateButton);
    const sendRow = element('div', 'inline-actions'); sendRow.append(sendButton);
    box.append(windowLine, ptLabel, translateRow, enLabel, backLabel, sendRow, status);
    refresh();
    block.append(box);
  }

  async function globalSearch(event) {
    event.preventDefault();
    const q = $('global-search-input').value.trim();
    if (!q) return;
    const searchSort=localStorage.getItem('mcs_sort_search')||'recent';
    const result = await request('/api/panel/search?q=' + encodeURIComponent(q)+'&sort='+encodeURIComponent(searchSort));
    const root = $('search-results');
    // M29: the results have a close button, and a hit without a ficha says so instead of doing nothing
    const head = element('div', 'inline-actions'), close = element('button', 'quiet small', 'Fechar busca');
    close.type = 'button'; close.addEventListener('click', () => { root.classList.add('hidden'); $('global-search-input').value = ''; });
    head.append(element('h2', '', 'Resultados da busca'), close);
    root.replaceChildren(head);
    const sortLabel=element('label','','Ordenar');const sortSelect=element('select');[['recent','Mais recentes'],['oldest','Mais antigas'],['value_desc','Maior valor'],['value_asc','Menor valor'],['location','Localização'],['vehicle','Marca do carro']].forEach(([v,l])=>sortSelect.append(new Option(l,v)));sortSelect.value=searchSort;sortSelect.addEventListener('change',()=>{localStorage.setItem('mcs_sort_search',sortSelect.value);globalSearch(new Event('submit'));});sortLabel.append(sortSelect);root.append(sortLabel);
    if (!result.items.length) root.append(element('p', 'muted', 'Nenhum resultado'));
    result.items.forEach((item) => {
      const button = element('button', 'search-hit');
      button.type = 'button';
      const label = item.kind === 'ORDER'
        ? `${referencePhone(item)}${item.simulationCount > 1 ? ` · ${item.simulationCount} simulações` : ''}${item.vehicleText ? ` — ${displayModel(item.vehicleText)}` : ''}`
        : `${item.name} · ${referencePhone(item)}${item.vehicleText ? ` — ${displayModel(item.vehicleText)}` : ''}`;
      button.append(element('span', '', label), makeBadge(item.matchedBy));const direct=directLeadBadge(item);if(direct)button.append(direct);if(item.disposition)button.append(makeBadge(item.disposition==='TREATED'?'Tratado':`Descartado${item.discardReason?' · '+discardLabel(item.discardReason):''}`,item.disposition==='DISCARDED'?'red':'blue'));if(item.searchStageLabel)button.append(makeBadge(item.searchStageLabel,item.searchStage==='SENT'?'green':item.searchStage==='SAVED'?'blue':'yellow'));
      if (item.kind !== 'ORDER' && !item.journeyId) { button.disabled = true; button.append(makeBadge('sem ficha aberta', 'yellow')); }
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

  // From CLIENTES the report follows the CLIENTES period (last real activity), not a date range.
  let reportClients = null;
  function openReport(view) {
    reportView = view;
    reportClients = view === 'records' && currentView === 'clients' ? { activity: clientsPeriod(), since: MCSOrigin.periodCutoff(clientsPeriod()) } : null;
    $('report-period-field').classList.toggle('hidden', Boolean(reportClients));
    $('report-custom').classList.toggle('hidden', Boolean(reportClients) || $('report-period').value !== 'custom');
    $('report-origin-note').classList.toggle('hidden', !reportClients);
    $('report-origin-note').textContent = reportClients ? (reportClients.activity === 'all' ? 'Período de CLIENTES: tudo, sem corte por data' : `Período de CLIENTES: atividade real ${MCSOrigin.periodLabel(reportClients.activity)}`) : '';
    $('report-text').value = '';
    $('report-status').textContent = '';
    $('report-dialog').showModal();
  }

  async function generateReport() {
    const period = $('report-period').value;
    const params = reportClients ? new URLSearchParams({ view: 'records', origin: 'clients', activity: reportClients.activity }) : new URLSearchParams({ period, view: reportView });
    if (reportClients && reportClients.since !== null) params.set('since', new Date(reportClients.since).toISOString());
    if (!reportClients && period === 'custom') {
      params.set('from', $('report-from').value);
      params.set('to', $('report-to').value);
    }
    try {
      const report = await request('/api/panel/report?' + params.toString());
      $('report-text').value = report.text;
      $('report-status').textContent = 'Relatório gerado';
    } catch (_) {
      $('report-status').textContent = 'Não foi possível gerar o relatório para esse período';
    }
  }

  async function copyReport() {
    if (!$('report-text').value) return;
    await navigator.clipboard.writeText($('report-text').value);
    $('report-status').textContent = 'Texto copiado';
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
  // A24: the automatic refresh keeps running after an error and never redraws the screen
  // while the operator is typing (it would erase the text being written).
  let lastTyping = { at: 0, node: null };
  document.addEventListener('input', (event) => {
    const node = event.target;
    if (node && (node.matches?.('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]),textarea') || node.isContentEditable)) lastTyping = { at: Date.now(), node };
  }, true);
  const operatorIsTyping = () => {
    const active = document.activeElement;
    if (active && (active.matches?.('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="button"]),textarea,select') || active.isContentEditable)) return true;
    const node = lastTyping.node;
    return Boolean(node && node.isConnected && String(node.value ?? node.textContent ?? '').trim() && Date.now() - lastTyping.at < 10 * 60000);
  };
  // Automatic refresh: only the leader tab (visible) asks, one refresh at a time, never while the
  // operator is typing, and after an error the wait doubles (up to 15 minutes) instead of insisting.
  let refreshCoordinator = null, refreshScheduler = null;
  const REFRESH_MS = Number(window.MCS_REFRESH_MS) > 0 ? Number(window.MCS_REFRESH_MS) : 120000;
  const refreshNote = (text, retry) => {
    let note = $('refresh-note');
    if (!note && text) { note = element('span', 'muted refresh-note'); note.id = 'refresh-note'; note.setAttribute('role', 'status'); document.querySelector('.freshness')?.append(note); }
    if (!note) return;
    note.replaceChildren(text ? element('span', '', text) : '');
    if (text && retry) {
      const button = element('button', 'quiet small', 'Tentar novamente'); button.type = 'button';
      button.addEventListener('click', () => { button.disabled = true; button.textContent = 'Atualizando…'; if (refreshScheduler) refreshScheduler.runNow(); else refreshCurrentPreservingState().catch(() => {}); });
      note.append(button);
    }
  };
  function stopAutoRefresh() {
    if (refreshScheduler) refreshScheduler.stop();
    if (refreshCoordinator) refreshCoordinator.stop();
    refreshScheduler = null; refreshCoordinator = null;
  }
  const startSafeRefresh = () => {
    stopAutoRefresh();
    if (!window.MCSRefresh) return;
    let channel = null;
    try { channel = 'BroadcastChannel' in window ? new BroadcastChannel('mcs-panel-refresh') : null; } catch (_) { channel = null; }
    let storage = null;
    try { storage = window.localStorage; } catch (_) { storage = null; }
    refreshCoordinator = MCSRefresh.createCoordinator({ storage, document, window, channel }).start();
    refreshScheduler = MCSRefresh.createScheduler({
      coordinator: refreshCoordinator, intervalMs: REFRESH_MS, maxBackoffMs: 15 * 60000, isBusy: operatorIsTyping,
      run: async () => { await loadCurrent(); await loadCaptureWarning(); },
      onSuccess: () => refreshNote(''),
      onFailure: (failure, nextMs) => { console.error('Atualização automática falhou', failure); refreshNote(`Não foi possível atualizar · os dados mostrados são os últimos confirmados · nova tentativa em ${Math.round(nextMs / 60000) || 1} min`, true); }
    }).start();
    window.__mcsRefresh = { coordinator: refreshCoordinator, scheduler: refreshScheduler, counters: () => refreshCounters() };
  };
  async function routeFromHash(push = false) {
    const hash = String(location.hash || '');
    const legacy={fichas:'clients',qualificacao:'clients',pendencias:'clients',clientes:'clients',manheim:'imports',buscas:'searches',opcoes:'searches',pesquisas:'requests',importacoes:'imports',pedidos:'entry',entrada:'entry'}[hash.replace(/^#/,'').toLowerCase()];
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

  // C5: only the session check can send the operator back to login. A real 401 is handled by
  // request() after the token refresh fails; any other failure keeps the session and the panel.
  // C5: only the session check can send the operator back to login. A real 401 is handled by
  // request() after the token refresh fails; any other failure keeps the session and offers to try
  // again. The session check is light (no Manheim, no lists) and has its own time limit.
  const SESSION_TIMEOUT_MS = Number(window.MCS_SESSION_TIMEOUT_MS) > 0 ? Number(window.MCS_SESSION_TIMEOUT_MS) : 12000;
  function sessionRetry(show) {
    let retry = $('login-retry');
    if (!retry && show) {
      retry = element('button', 'quiet', 'Tentar novamente'); retry.id = 'login-retry'; retry.type = 'button';
      retry.addEventListener('click', async () => { retry.disabled = true; retry.textContent = 'Conferindo…'; try { await routeSession(); } finally { retry.disabled = false; retry.textContent = 'Tentar novamente'; } });
      $('login-error').after(retry);
    }
    if (retry) retry.classList.toggle('hidden', !show);
  }
  async function routeSession() {
    if (!accessToken) { sessionRetry(false); return show('login-view'); }
    let session;
    try {
      session = await request('/api/panel/session', { timeoutMs: SESSION_TIMEOUT_MS });
    } catch (failure) {
      if (['AUTHENTICATION_REQUIRED', 'PANEL_ACCESS_DENIED'].includes(failure && failure.code) || !accessToken) {
        clearSession();
        show('login-view');
        sessionRetry(false);
        if (failure && failure.code === 'PANEL_ACCESS_DENIED') error('login-error', 'Esta conta não tem acesso ao painel');
        return;
      }
      show('login-view');
      error('login-error', failure && failure.code === 'REQUEST_TIMEOUT' ? 'O painel demorou para responder · Sua senha está certa; tente de novo em instantes' : 'Não consegui confirmar a sessão agora · Tente de novo em instantes');
      sessionRetry(true);
      return;
    }
    sessionRetry(false);
    error('login-error');
    if (session.mustChangePassword) return show('password-view');
    show('app-view');
    const step = async (label, run) => { try { await run(); } catch (failure) { console.error(`Falha ao carregar ${label}`, failure); bootWarning(); } };
    // The panel opens at once; the first tab and the counters arrive after, each on its own.
    await step('a aba inicial', () => switchPanel('today'));
    if (!history.state) history.replaceState({ panelOrigin: captureOrigin() }, '', location.pathname + location.search + (location.hash || ''));
    await step('o endereço aberto', () => routeFromHash(false));
    await step('os contadores', async () => { const result = await refreshCounters(); if (result && result.failed) bootWarning(); });
    await step('as mensagens automáticas', () => loadAutomaticMessages());
    startSafeRefresh();
  }
  function bootWarning() {
    if ($('boot-warning')) return;
    const warning = element('p', 'status error', 'Parte do painel não carregou agora (alguns contadores ficaram sem número) · Você continua conectado; a próxima atualização tenta de novo');
    warning.id = 'boot-warning';
    warning.setAttribute('role', 'alert');
    $('app-view').prepend(warning);
  }
  async function loadAutomaticMessages(){
    const list=$('automatic-message-list');if(!list)return;
    try{const data=await request('/api/panel/automatic-messages');list.replaceChildren();(data.items||[]).forEach((item)=>{const row=element('div','queue-item');row.append(element('span','',item.body_normalized));const remove=element('button','quiet small','Remover');remove.type='button';MCSAction.bind(remove,()=>({scope:row,optimistic:()=>{row.classList.add('action-optimistic-hidden');},commit:()=>request('/api/panel/automatic-messages',{method:'POST',body:JSON.stringify({action:'delete',id:item.id})}),rollback:()=>{row.classList.remove('action-optimistic-hidden');},refresh:()=>loadAutomaticMessages(),errorText:'Não consegui salvar, tente de novo'}));row.append(remove);list.append(row);});}catch(_){list.textContent='Não foi possível carregar mensagens automáticas';}
  }
  if($('automatic-message-save'))MCSAction.bind($('automatic-message-save'),()=>{const input=$('automatic-message-text'),value=input.value.trim();if(!value)return{scope:$('automatic-message-list'),commit:()=>Promise.reject(new Error('MESSAGE_REQUIRED')),errorText:'Digite a mensagem automática'};return{scope:$('automatic-message-list'),commit:()=>request('/api/panel/automatic-messages',{method:'POST',body:JSON.stringify({action:'save',text:value})}),onSuccess:()=>{input.value='';},refresh:()=>loadAutomaticMessages(),errorText:'Não consegui salvar, tente de novo'};});
  // The Entrar button always answers: "Entrando…" while Supabase checks the password, "Abrindo o
  // painel…" while the session is confirmed, a clear message on any failure, and it can be pressed
  // again. It never waits forever (time limit on both steps).
  let signingIn = false;
  async function signIn(event) {
    event.preventDefault();
    if (signingIn) return;
    signingIn = true;
    const button = $('login-form').querySelector('button[type="submit"]');
    const label = button ? button.textContent : 'Entrar';
    const busy = (text) => { if (button) { button.disabled = true; button.textContent = text; button.setAttribute('aria-busy', 'true'); } };
    error('login-error');
    sessionRetry(false);
    busy('Entrando…');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      let response, data;
      try {
        response = await fetch(config.url + '/auth/v1/token?grant_type=password', { method: 'POST', signal: controller.signal, headers: { apikey: config.publishableKey, 'content-type': 'application/json' }, body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }) });
        data = await response.json().catch(() => ({}));
      } catch (_) {
        return error('login-error', controller.signal.aborted ? 'O login demorou para responder · Tente de novo' : 'Não consegui falar com o servidor de login · Confira a conexão e tente de novo');
      } finally { clearTimeout(timer); }
      if (!response.ok || !data.access_token) return error('login-error', 'E-mail ou senha inválidos');
      acceptAuthSession(data, $('remember-login').checked);
      $('password').value = '';
      busy('Entrando…');
      await routeSession();
    } catch (failure) {
      console.error('Falha ao entrar', failure);
      error('login-error', 'Não consegui abrir o painel agora · Tente de novo');
      sessionRetry(Boolean(accessToken));
    } finally {
      signingIn = false;
      if (button) { button.disabled = false; button.textContent = label === 'Entrando…' ? 'Entrar' : label; button.removeAttribute('aria-busy'); }
    }
  }
  async function changePassword(event) {
    event.preventDefault();
    error('password-error');
    const password = $('new-password').value;
    if (password !== $('confirm-password').value) return error('password-error', 'As senhas não coincidem');
    try {
      await request('/api/panel/complete-password', { method: 'POST', body: JSON.stringify({ newPassword: password }) });
      await routeSession();
    } catch (failure) {
      error('password-error', failure.code === 'PASSWORD_REQUIREMENTS_NOT_MET' ? 'Use 12 caracteres, maiúscula, minúscula, número e símbolo' : 'Não foi possível atualizar a senha');
    }
  }
  async function boot() {
    try { config = await request('/api/panel/config'); } catch (_) { error('login-error', 'Painel indisponível no momento'); return; }
    await restoreSession();
    $('login-form').addEventListener('submit', signIn);
    $('password-form').addEventListener('submit', changePassword);
    $('logout').addEventListener('click', () => { stopAutoRefresh(); clearSession(); show('login-view'); });
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', async () => {
      if(button.dataset.view!=='clients')clientsOverdue24=false;
      history.replaceState({ panelOrigin: { view: button.dataset.view, scrollY: 0 } }, '', location.pathname + location.search);
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
    document.querySelectorAll('[data-entry-orders-period]').forEach((button) => button.addEventListener('click', () => {
      entryOrders.period = button.dataset.entryOrdersPeriod;
      document.querySelectorAll('[data-entry-orders-period]').forEach((item) => item.classList.toggle('active', item === button));
      refreshEntryOrders(false).catch(() => { $('entry-orders-count').textContent = '?'; empty($('entry-orders-list'), 'Não foi possível carregar'); });
    }));
    $('entry-orders-more').addEventListener('click', () => loadEntryOrders('contacted', true).catch(() => { $('entry-orders-more').textContent = 'Não foi possível carregar'; }));
    $('entry-simulated-more').addEventListener('click', () => loadEntryOrders('simulated', true).catch(() => { $('entry-simulated-more').textContent = 'Não foi possível carregar'; }));
    $('entry-simulated').addEventListener('toggle', () => { if ($('entry-simulated').open) loadEntryOrders('simulated').catch(() => empty($('entry-simulated-list'), 'Não foi possível carregar')); });
    ['today','entry','clients','pending','qualification','searches','manheim','records'].forEach((name)=>{const select=$(name+'-sort');if(!select)return;const saved=localStorage.getItem('mcs_sort_'+name);if(saved&&[...select.options].some((option)=>option.value===saved))select.value=saved;select.addEventListener('change',()=>{localStorage.setItem('mcs_sort_'+name,select.value);if(name==='clients'){if(currentView==='clients')renderClients(clientsData);return;}if(currentView!==name&&!(currentView==='searches'&&name==='manheim'))return;if(name==='manheim'){renderSavedSearches().catch(()=>{});renderManheim(manheimData||{items:manheimJourneys,orders:manheimOrders,matches:manheimMatches});return;}loadCurrent().catch(()=>{});});});
    $('clients-activity').value='30';localStorage.removeItem('mcs_clients-activity');$('clients-activity').addEventListener('change',()=>{if(currentView==='clients')renderClients(clientsData);refreshCounters().catch(()=>{});});
    ['clients-situation','clients-checklist','clients-ref','clients-heat','clients-origin','clients-type'].forEach((id)=>{const select=$(id),saved=localStorage.getItem('mcs_'+id);if(saved&&[...select.options].some((option)=>option.value===saved))select.value=saved;select.addEventListener('change',()=>{localStorage.setItem('mcs_'+id,select.value);if(currentView==='clients')renderClients(clientsData);});});
    document.querySelectorAll('[data-today-ref]').forEach((button)=>{button.classList.toggle('active',button.dataset.todayRef===todayRefFilter);button.addEventListener('click',()=>{todayRefFilter=button.dataset.todayRef;localStorage.setItem('mcs_today_ref_filter',todayRefFilter);renderToday(todayItems,true);});});
    const weekly=$('weekly-summary');weekly.open=localStorage.getItem('mcs_weekly_open')==='true';weekly.addEventListener('toggle',()=>localStorage.setItem('mcs_weekly_open',String(weekly.open)));
    document.querySelectorAll('[data-pending-situation]').forEach((button)=>button.addEventListener('click',async()=>{pendingSituation=button.dataset.pendingSituation;document.querySelectorAll('[data-pending-situation]').forEach((item)=>item.classList.toggle('active',item===button));if(currentView==='pending')await loadPending();}));
    $('pending-with-ref').addEventListener('change',()=>{if(currentView==='pending')loadPending().catch(()=>{});});
    $('pending-download').addEventListener('click',async()=>{const button=$('pending-download');button.disabled=true;try{await downloadPendingCsv();}catch(_){button.after(element('span','error','Não foi possível baixar a planilha'));}finally{button.disabled=false;}});
    // Separate, owner-authorized reading of the conversations in "Precisa de você" only.
    MCSAction.bind($('triage-run-pending'),()=>({scope:$('triage-run-pending').parentElement,commit:async()=>{const result=await request('/api/panel/triage',{method:'POST',body:JSON.stringify({action:'run_pending'})});if(result.skipped)throw Object.assign(Error('TRIAGE_OFF'),{code:'TRIAGE_OFF'});if(result.inProgress&&!result.processed)throw Object.assign(Error('TRIAGE_BUSY'),{code:'TRIAGE_BUSY'});if(result.failed||result.deferred||result.inProgress)throw Object.assign(Error('TRIAGE_PARTIAL'),{code:'TRIAGE_PARTIAL'});return result;},successText:'Leitura concluída, confira Precisa de você',refresh:()=>loadTriage().then(()=>refreshCounters().catch(()=>{})),errorText:(error)=>error?.code==='TRIAGE_ADMIN_ONLY'?'Só o administrador pode iniciar':error?.code==='TRIAGE_OFF'?'Triagem desligada, nada foi lido':error?.code==='TRIAGE_BUSY'?'Já em processamento pela rotina automática, confira em instantes':error?.code==='TRIAGE_PARTIAL'?'Parte das conversas ficou pendente, tente de novo':'Não consegui classificar, tente de novo'}));
    $('clients-download').addEventListener('click',()=>{const button=$('clients-download');button.disabled=true;try{downloadClientsCsv();}catch(_){button.after(element('span','error','Não foi possível baixar a planilha'));}finally{button.disabled=false;}});
    document.querySelectorAll('[data-report]').forEach((button) => button.addEventListener('click', () => openReport(button.dataset.report)));
    $('global-search').addEventListener('submit', (event) => globalSearch(event).catch(() => { $('search-results').replaceChildren(element('p', 'muted', 'Não foi possível buscar')); $('search-results').classList.remove('hidden'); }));
    $('report-period').addEventListener('change', () => $('report-custom').classList.toggle('hidden', $('report-period').value !== 'custom'));
    $('report-generate').addEventListener('click', generateReport);
    $('report-copy').addEventListener('click', () => copyReport().catch(() => { $('report-status').textContent = 'Não foi possível copiar'; }));
    $('whatsapp-files').addEventListener('change', (event) => importFiles([...event.target.files]).catch(showImportFailure));
    $('history-import-file').addEventListener('change', (event) => {
      historyImportFile = event.target.files?.[0] || null;
      $('history-import-send').disabled = !historyImportFile;
      $('history-import-status').textContent = historyImportFile ? `${historyImportFile.name} pronto para importar` : '';
    });
    $('history-import-send').addEventListener('click', () => import360History().catch((failure) => {
      $('history-import-status').textContent = failure?.code === 'HISTORY_IMPORT_INVALID' || failure?.message === 'HISTORY_FILE_INVALID' ? 'Este não é o arquivo do histórico do 360dialog para o número configurado' : failure?.message === 'HISTORY_FILE_TOO_LARGE' ? 'O arquivo passa de 100 MB. Exporte o histórico em partes' : failure?.code === 'HISTORY_ITEM_TOO_LARGE' ? 'Uma parte do arquivo é grande demais · O que já foi importado ficou gravado' : 'Não foi possível importar agora · Você pode tentar de novo sem duplicar';
      $('history-import-send').disabled = !historyImportFile;
    }));
    const zone = $('drop-zone');
    ['dragenter', 'dragover'].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove('dragging'); }));
    zone.addEventListener('drop', (event) => importFiles([...event.dataTransfer.files]).catch(showImportFailure));
    $('manheim-files').addEventListener('change', (event) => { const files = [...event.target.files]; event.target.value = ''; importManheim(files).catch(showManheimFailure); });
    $('requests-compare').addEventListener('click', (event) => compareRequests(event.currentTarget).catch(() => {}));
    $('entry-go-imports')?.addEventListener('click', () => document.querySelector('[data-view="imports"]')?.click());
    $('requests-history').addEventListener('click', (event) => openHistoryAudit(event.currentTarget).catch(() => {}));
    $('requests-history-pause').addEventListener('click', () => { historyPaused = true; $('requests-history-text').textContent = 'Pausando depois deste lote…'; });
    $('requests-audit').addEventListener('toggle', () => { if ($('requests-audit').open) loadRequestsAudit().catch(() => {}); });
    $('manheim-complement').addEventListener('click', () => $('manheim-complement-files').click());
    $('manheim-complement-files').addEventListener('change', (event) => { const files = [...event.target.files]; event.target.value = ''; complementManheim(files).catch(complementFailure); });
    const manheimZone = $('manheim-drop-zone');
    ['dragenter', 'dragover'].forEach((name) => manheimZone.addEventListener(name, (event) => { event.preventDefault(); manheimZone.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach((name) => manheimZone.addEventListener(name, (event) => { event.preventDefault(); manheimZone.classList.remove('dragging'); }));
    manheimZone.addEventListener('drop', (event) => importManheim([...event.dataTransfer.files]).catch(showManheimFailure));
    $('sms-form').addEventListener('submit', addSms);
    $('sms-contact').addEventListener('change', () => { const fresh=$('sms-contact').value==='new';$('sms-new-name-label').hidden=!fresh;$('sms-new-phone-label').hidden=!fresh;refreshSmsJourneys(); });
    $('auto-print-file').addEventListener('change',()=>{const files=$('auto-print-file').files;if(files.length)showAutoPrintChoice(files);});
    // Dropping a print on the card goes through the same choice as the file picker (images only;
    // the server checks the type again).
    const printDrop=document.querySelector('#auto-print-card .print-drop');
    if(printDrop){
      printDrop.addEventListener('dragover',(event)=>{event.preventDefault();printDrop.classList.add('over');});
      printDrop.addEventListener('dragleave',()=>printDrop.classList.remove('over'));
      printDrop.addEventListener('drop',(event)=>{event.preventDefault();printDrop.classList.remove('over');const images=[...(event.dataTransfer?.files||[])].filter((file)=>/^image\//.test(file.type||''));if(!images.length){$('auto-print-status').textContent='Solte uma imagem do print (JPG, PNG ou WebP)';return;}const transfer=new DataTransfer();images.forEach((file)=>transfer.items.add(file));const input=$('auto-print-file');input.files=transfer.files;input.dispatchEvent(new Event('change'));});
    }
    $('auto-print-remove').addEventListener('click',clearAutoPrint);
    $('auto-print-send').addEventListener('click',()=>sendAutoPrint().catch(()=>{}));
    $('sms-date').value = localInput();
    await routeSession();
  }
  boot();
})();
