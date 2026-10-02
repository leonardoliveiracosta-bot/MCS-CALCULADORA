(() => {
  'use strict';
  // Contexto do caso em qualquer aba: o mesmo resumo do cliente em cada cartão ligado a ele (quem é,
  // contato, origem, etapa, de quem depende, o que falta e a próxima ação), os dados campo a campo
  // com a origem de cada valor e um botão para a ficha completa. Os dados vêm de
  // /api/panel/client-context (só leitura); nada é ligado ou gravado aqui.
  const TTL_MS = 30 * 1000;
  const BATCH = 100;
  const cache = new Map();
  const e = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined && text !== null) node.textContent = String(text); return node; };
  const add = (parent, tag, cls, text) => { const node = e(tag, cls, text); parent.append(node); return node; };
  const date = (value) => value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
  const day = (value) => value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', dateStyle: 'short' }).format(new Date(value)) : '—';
  const phone = (value) => { const digits = String(value || '').replace(/\D/g, ''); return digits.length === 11 && digits[0] === '1' ? `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}` : String(value || ''); };
  const STATUS_CLASS = { CLIENTE: 'is-client', CONFIRMADO: 'is-confirmed', EQUIPE: 'is-team', IA: 'is-ai', AMBIGUO: 'is-ambiguous', AUSENTE: 'is-missing' };
  const OWNER_CLASS = { MCS: 'is-mcs', CLIENTE: 'is-client', NINGUEM: 'is-none' };
  const keyOf = (spec) => spec.journeyId ? 'journey:' + spec.journeyId : spec.ref ? 'ref:' + spec.ref : spec.contactId ? 'contact:' + spec.contactId : null;

  // A placeholder the tab puts in its card. hydrate() fills it.
  function slot(spec = {}, options = {}) {
    const node = e('div', 'client-context' + (options.variant ? ' client-context-' + options.variant : ''));
    if (spec.journeyId) node.dataset.contextJourney = spec.journeyId;
    if (spec.ref) node.dataset.contextRef = String(spec.ref).toUpperCase();
    if (spec.contactId) node.dataset.contextContact = spec.contactId;
    if (options.focus) node.dataset.contextFocus = options.focus;
    // Inside a card that already shows name and phone, the summary skips them (no repetition).
    if (options.withIdentity) node.dataset.contextIdentity = 'true';
    if (options.aiReading === false) node.dataset.contextAiReading = 'false';
    // The card already shows the "não atendido" line first (HOJE, ENTRADA, CLIENTES): not repeated here.
    if (options.unattended === false) node.dataset.contextUnattended = 'false';
    if (!keyOf(spec)) { node.classList.add('client-context-none'); node.textContent = options.emptyText || 'Sem cliente ligado a este item.'; return node; }
    add(node, 'span', 'client-context-loading muted', 'Carregando o contexto do cliente…');
    // A click inside the summary never opens the card around it.
    node.addEventListener('click', (event) => event.stopPropagation());
    return node;
  }

  const specOf = (node) => ({ journeyId: node.dataset.contextJourney || null, ref: node.dataset.contextRef || null, contactId: node.dataset.contextContact || null });
  const fresh = (key) => { const hit = cache.get(key); return hit && Date.now() - hit.at < TTL_MS ? hit.value : null; };

  async function load(specs, request) {
    const want = { journeyIds: new Set(), refs: new Set(), contactIds: new Set() };
    specs.forEach((spec) => {
      if (spec.journeyId && !fresh('journey:' + spec.journeyId)) want.journeyIds.add(spec.journeyId);
      else if (!spec.journeyId && spec.ref && !fresh('ref:' + spec.ref)) want.refs.add(spec.ref);
      else if (!spec.journeyId && !spec.ref && spec.contactId && !fresh('contact:' + spec.contactId)) want.contactIds.add(spec.contactId);
    });
    const lists = { journeyIds: [...want.journeyIds], refs: [...want.refs], contactIds: [...want.contactIds] };
    const rounds = Math.max(...Object.values(lists).map((list) => Math.ceil(list.length / BATCH)), 0);
    for (let round = 0; round < rounds; round++) {
      const body = Object.fromEntries(Object.entries(lists).map(([name, list]) => [name, list.slice(round * BATCH, (round + 1) * BATCH)]));
      const result = await request('/api/panel/client-context', { method: 'POST', body: JSON.stringify(body) });
      const at = Date.now();
      Object.entries(result.journeys || {}).forEach(([id, value]) => cache.set('journey:' + id, { at, value }));
      Object.entries(result.refs || {}).forEach(([ref, value]) => cache.set('ref:' + ref, { at, value: value.key ? value : { link: value } }));
      Object.entries(result.contacts || {}).forEach(([id, value]) => cache.set('contact:' + id, { at, value: { link: value } }));
      // A Ref or contact that belongs to exactly one ficha is shown as that ficha: load it.
      const follow = [...Object.values(result.refs || {}), ...Object.values(result.contacts || {})].map((value) => value.journeyId).filter((id) => id && !fresh('journey:' + id));
      if (follow.length) await load(follow.map((journeyId) => ({ journeyId })), request);
    }
  }

  function resolve(spec) {
    const direct = spec.journeyId ? fresh('journey:' + spec.journeyId) : null;
    if (direct) return direct;
    const viaRef = spec.ref ? fresh('ref:' + spec.ref) : null;
    if (viaRef && viaRef.key) return viaRef;
    if (viaRef && viaRef.link && viaRef.link.journeyId) return fresh('journey:' + viaRef.link.journeyId);
    const viaContact = spec.contactId ? fresh('contact:' + spec.contactId) : null;
    if (viaContact && viaContact.link && viaContact.link.journeyId) return fresh('journey:' + viaContact.link.journeyId);
    if (viaContact && viaContact.link) return { unlinked: viaContact.link.reason };
    return null;
  }

  function paint(nodes, open) {
    nodes.forEach((node) => {
      if (!node.isConnected) return;
      const context = resolve(specOf(node));
      node.dataset.contextState = 'done';
      if (!context) { node.replaceChildren(e('span', 'muted', 'Cliente não encontrado neste ambiente.')); return; }
      if (context.unlinked) { node.replaceChildren(e('span', 'client-context-warning', context.unlinked)); return; }
      node.replaceChildren(...compact(context, { open, focus: node.dataset.contextFocus || null, identity: node.dataset.contextIdentity === 'true', aiReading: node.dataset.contextAiReading !== 'false', unattended: node.dataset.contextUnattended !== 'false' }).childNodes);
    });
  }
  async function fill(nodes, { request, open }) {
    nodes.forEach((node) => { node.dataset.contextState = 'loading'; });
    try { await load(nodes.map(specOf), request); }
    catch (_) { nodes.forEach((node) => { node.dataset.contextState = 'failed'; node.replaceChildren(e('span', 'muted', 'Não foi possível carregar o contexto do cliente agora. O resto da tela continua valendo.')); }); return; }
    paint(nodes, open);
  }

  // Fills the summaries inside root as they come near the screen: the visible ones go together in
  // one request, so a long list never loads every client at once.
  const queue = new Set();
  let timer = null, observer = null, handlers = null;
  function flush() {
    timer = null;
    const nodes = [...queue].filter((node) => node.isConnected);
    queue.clear();
    if (nodes.length && handlers) fill(nodes, handlers);
  }
  async function hydrate(root, options) {
    if (!root || !options || typeof options.request !== 'function') return;
    handlers = options;
    const nodes = [...root.querySelectorAll('.client-context:not(.client-context-none)')].filter((node) => !node.dataset.contextState);
    if (!nodes.length) return;
    if (typeof IntersectionObserver !== 'function' || options.eager) { await fill(nodes, options); return; }
    if (!observer) observer = new IntersectionObserver((entries) => {
      entries.filter((entry) => entry.isIntersecting).forEach((entry) => { observer.unobserve(entry.target); queue.add(entry.target); });
      if (queue.size && !timer) timer = setTimeout(flush, 120);
    }, { rootMargin: '600px 0px' });
    nodes.forEach((node) => { node.dataset.contextState = 'waiting'; observer.observe(node); });
  }

  // ----------------------------------------------------------------- resumo compacto
  const fieldOf = (context, key) => (context.fields || []).find((item) => item.key === key) || null;
  function statusTag(item) { return e('span', 'context-status ' + (STATUS_CLASS[item.status] || ''), item.statusLabel); }
  function fieldLine(parent, item) {
    if (!item) return;
    const line = add(parent, 'div', 'context-field');
    add(line, 'span', 'context-field-label', item.label);
    add(line, 'span', 'context-field-value', item.value || (item.status === 'AMBIGUO' ? 'Fontes diferentes' : '—'));
    line.append(statusTag(item));
    if (item.divergent) add(line, 'span', 'context-status is-ambiguous', 'Diverge');
  }
  function essentialKeys(context) {
    const modes = (context.searches || []).map((item) => item.mode).filter(Boolean);
    const orderModes = ((context.links || {}).orders || []).map((item) => item.mode);
    const all = new Set([...modes, ...orderModes]);
    return ['carro', ...(all.has('VALOR') || !all.size ? ['valor'] : []), ...(all.has('CARRO') ? ['anos', 'milhas'] : []), 'prazo'];
  }

  function nextActionNode(action) {
    const box = e('div', 'context-next' + (action.kind === 'EQUIPE' ? ' is-team' : ' is-suggestion') + (action.overdue ? ' is-overdue' : ''));
    add(box, 'span', 'context-next-kind', action.kind === 'EQUIPE' ? 'Próxima ação · definida pela equipe' : 'Próxima ação · sugestão do painel');
    add(box, 'strong', 'context-next-text', action.text);
    if (action.at) add(box, 'span', 'muted', (action.overdue ? 'Venceu em ' : 'Para ') + date(action.at));
    return box;
  }

  // Não atendido: the reason, how long it has waited, what is missing and the next action, in every
  // tab where the client appears (same rule as the HOJE, ENTRADA and CLIENTES cards).
  function unattendedLine(parent, context) {
    const u = context.unattended;
    if (!u) return null;
    const line = add(parent, 'p', 'context-unattended decision-red');
    add(line, 'strong', '', 'Não atendido');
    line.append(document.createTextNode(` · ${u.reasonText} · Esperando há ${u.waitedText} · Falta: ${u.missing} · Agora: ${u.next}`));
    return line;
  }
  function compact(context, { open, focus, identity = true, aiReading = true, unattended = true } = {}) {
    const root = e('div');
    const head = add(root, 'div', 'context-head');
    const who = add(head, 'div', 'context-who');
    // DE ONDE VEIO: a short chip (never a sentence repeated on every line).
    const originChip = () => { const chip = e('span', 'badge origin-chip context-origin', context.origin.label); chip.title = 'De onde veio' + (context.origin.since ? ' · desde ' + day(context.origin.since) : ''); return chip; };
    if (identity) {
      add(who, 'strong', 'context-name', context.name || 'Contato sem nome');
      // The calculator Ref only (a code of the ficha without proof is internal, said in the facts).
      const shownRef = typeof context.hasCalcRef === 'boolean' ? context.calcRef : context.ref;
      add(who, 'span', 'context-ref', shownRef ? 'Ref ' + shownRef : 'sem Ref da calculadora');
      const contactLine = add(who, 'span', 'context-contact muted');
      contactLine.textContent = (context.contact.phones || []).map(phone).join(' · ') || (context.contact.whatsappUsername ? '@' + context.contact.whatsappUsername : context.contact.note || 'Sem telefone salvo');
      who.append(originChip());
      if (context.origin.financing) add(who, 'span', 'badge yellow origin-financing', 'Financiamento');
    } else {
      add(who, 'span', 'context-kicker', 'Contexto do cliente');
      who.append(originChip());
      if (context.origin.financing) add(who, 'span', 'badge yellow origin-financing', 'Financiamento');
    }
    // Inside a card, only the ficha is a new destination (the card already opens its order).
    if (typeof open === 'function' && (context.journeyId || (identity && context.ref))) {
      const button = add(head, 'button', 'quiet small context-open', context.journeyId ? 'Abrir ficha' : 'Abrir pedido');
      button.type = 'button';
      button.addEventListener('click', (event) => { event.stopPropagation(); open(context.journeyId ? 'ficha' : 'order', context.journeyId || context.ref); });
    }
    if (unattended) unattendedLine(root, context);
    const facts = add(root, 'dl', 'context-facts');
    const fact = (label, value, cls) => { const wrap = add(facts, 'div', 'context-fact' + (cls ? ' ' + cls : '')); add(wrap, 'dt', '', label); add(wrap, 'dd', '', value); return wrap; };
    const searchText = (context.searches || []).map((item) => (item.mode ? (item.mode === 'VALOR' ? 'Por valor: ' : 'Por carro: ') : '') + item.label).join(' · ');
    // Where the case stands (an order without a ficha has a situation, not a funnel stage), apart
    // from whether the search criteria are complete: complete criteria never mean "free to go".
    if (context.situation) fact('Situação', context.situation.label + (context.situation.detail ? ' · ' + context.situation.detail : ''), 'is-missing');
    else fact('Etapa', context.stage.label + (context.stage.closed ? ' · encerrado' : context.stage.off ? ' · desligado' : '') + (searchText ? ' · ' + searchText : ''));
    // A known Ref whose simulation is missing is still a Ref (never "Sem Ref"); said here, in the details.
    if (context.calcRef && (context.calcRefsWithoutRun || []).includes(context.calcRef)) fact('Ref', `${context.calcRef} comprovada pela mensagem da calculadora · simulação não registrada`);
    if (context.internalCode) fact('Código da ficha', `${context.internalCode} · interno, não é Ref da calculadora`);
    fact('Depende de', context.owner.label + (context.owner.since ? ' · desde ' + date(context.owner.since) : ''), OWNER_CLASS[context.owner.who]);
    const criteria = context.criteria || { complete: !(context.missing || []).length, text: (context.missing || []).length ? 'Faltam: ' + context.missing.join(', ') : 'Completos' };
    fact('Critérios da busca', criteria.text, criteria.complete ? '' : 'is-missing');
    if (context.blocker) fact('O que impede', context.blocker);
    root.append(nextActionNode(context.nextAction));
    // An order card already lists what the calculator received, field by field.
    if (focus !== 'order') { const essentials = add(root, 'div', 'context-fields'); essentialKeys(context).forEach((key) => fieldLine(essentials, fieldOf(context, key))); }
    if (focus === 'cars' || focus === 'search') {
      const cars = (context.links || {}).cars || {};
      add(root, 'p', 'muted context-cars', cars.uploadAt ? `Lote ativo de ${day(cars.uploadAt)}: ${cars.total || 0} carro(s) com MMR ligado(s) a este cliente` : 'Nenhum lote ativo do Manheim.');
      (context.searches || []).forEach((item) => searchGroupLine(root, context, item));
      fillReasons();
    }
    const more = add(root, 'details', 'context-more');
    add(more, 'summary', '', 'Ver dados campo a campo, origem e vínculos');
    more.append(fullTable(context), linksBlock(context, { aiReading }));
    return root;
  }

  // ----------------------------------------------------------------- dados completos
  // A message quoted for several fields appears once; the next fields point back to it.
  function sourceList(item, shown = new Set()) {
    const list = e('ul', 'context-sources');
    if (!item.sources.length) { add(list, 'li', 'muted', item.note || 'Nenhuma fonte informou.'); return list; }
    item.sources.forEach((source) => {
      const li = add(list, 'li');
      add(li, 'span', 'context-source-kind', source.label);
      add(li, 'span', '', ' ' + source.value);
      const extra = [source.ref ? 'Ref ' + source.ref : null, source.detail, source.at ? date(source.at) : null].filter(Boolean).join(' · ');
      if (extra) add(li, 'span', 'muted', ' · ' + extra);
      (source.messages || []).forEach((message) => {
        const key = (message.at || '') + '|' + message.text;
        if (shown.has(key)) { add(li, 'span', 'muted context-evidence-again', ' · mesma mensagem do cliente citada acima (' + date(message.at) + ')'); return; }
        shown.add(key);
        const quote = add(li, 'blockquote', 'context-evidence'); add(quote, 'span', 'muted', 'Mensagem do cliente · ' + date(message.at) + ': '); quote.append(document.createTextNode('“' + message.text + '”'));
      });
    });
    if (item.note) add(list, 'li', 'context-note', item.note);
    return list;
  }

  function fullTable(context) {
    const table = e('table', 'context-table');
    const head = add(add(table, 'thead'), 'tr');
    ['Campo', 'Valor usado', 'Situação', 'De onde veio'].forEach((label) => add(head, 'th', '', label));
    const body = add(table, 'tbody');
    const shown = new Set();
    (context.fields || []).forEach((item) => {
      const tr = add(body, 'tr', STATUS_CLASS[item.status] || '');
      add(tr, 'th', '', item.label).scope = 'row';
      add(tr, 'td', 'context-value', item.value || (item.status === 'AMBIGUO' ? 'Não escolhido: as fontes discordam' : '—'));
      const status = add(tr, 'td'); status.append(statusTag(item));
      add(tr, 'td').append(sourceList(item, shown));
    });
    const wrap = e('div', 'context-table-wrap');
    wrap.append(table);
    return wrap;
  }

  // Adendo, item 2: each search in one of three groups (com carros, sem carros, ainda não rodada).
  // A "sem carros" gets its plain-language reason from PESQUISAS (read only).
  function searchGroupLine(parent, context, item) {
    const cars = (context.links || {}).cars || {};
    const line = add(parent, 'p', 'context-search-group');
    const label = item.modeLabel || 'Tipo não definido';
    if (!item.mode) { line.dataset.searchGroup = 'NAO_RODADA'; line.textContent = `Busca ainda não rodada · ${label}: ${item.label}${(item.issues || []).length ? ' · falta: ' + item.issues.map((issue) => issue.text || issue).join(', ') : ''}`; return line; }
    if (!cars.uploadAt) { line.dataset.searchGroup = 'NAO_RODADA'; line.textContent = `Busca ainda não rodada · ${label}: nenhum lote ativo do Manheim`; return line; }
    if (item.cars > 0) { line.dataset.searchGroup = 'COM_CARROS'; line.textContent = `Com carros · ${label}: ${item.cars} carro(s) no lote ativo · ${item.label}`; return line; }
    line.dataset.searchGroup = 'SEM_CARROS';
    line.textContent = `Sem carros · ${label}: a busca rodou no lote ativo e nenhum carro serviu`;
    if (context.journeyId) { const reason = add(parent, 'p', 'search-empty-reason', 'Motivo: lendo o lote…'); reason.dataset.requestKey = `ficha:journey:${context.journeyId}:${item.mode}`; }
    return line;
  }
  // Reasons are read in one batch per moment (slots that appear together share one request).
  const reasonCache = new Map();
  let reasonTimer = null;
  function fillReasons() {
    clearTimeout(reasonTimer);
    reasonTimer = setTimeout(async () => {
      const slots = [...document.querySelectorAll('.client-context .search-empty-reason[data-request-key]:not([data-filled])')];
      if (!slots.length || !handlers || typeof handlers.request !== 'function') return;
      slots.forEach((slot) => { slot.dataset.filled = '1'; });
      const missing = [...new Set(slots.map((slot) => slot.dataset.requestKey))].filter((key) => !reasonCache.has(key));
      let failed = false;
      if (missing.length) {
        try { const out = await handlers.request('/api/panel/pesquisas', { method: 'POST', timeoutMs: 60000, body: JSON.stringify({ action: 'empty_reasons', keys: missing }) }); missing.forEach((key) => reasonCache.set(key, (out.reasons || {})[key] || null)); }
        catch (_) { failed = true; }
      }
      slots.forEach((slot) => { const found = reasonCache.get(slot.dataset.requestKey); slot.textContent = failed && !reasonCache.has(slot.dataset.requestKey) ? 'Motivo: não consegui ler o lote agora' : 'Motivo: ' + (found ? found.text : 'nenhum carro do lote ativo serviu para estes critérios'); });
    }, 80);
  }

  function linksBlock(context, { aiReading = true, searchGroups = true } = {}) {
    const box = e('div', 'context-links');
    const links = context.links || {};
    const orders = add(box, 'div');
    add(orders, 'strong', '', 'Pedidos da calculadora');
    if (!(links.orders || []).length) add(orders, 'p', 'muted', (context.sharedRefs || []).length ? `A Ref ${context.sharedRefs.join(', ')} está em mais de uma ficha: não é mostrada como pedido de nenhuma.` : 'Nenhum pedido da calculadora ligado.');
    (links.orders || []).forEach((order) => add(orders, 'p', '', `Ref ${order.ref} · ${order.modeLabel} · ${order.vehicle || 'sem carro'} · ${date(order.at)}`));
    const requests = add(box, 'div');
    add(requests, 'strong', '', 'Pedidos lidos da conversa (BUSCAR CARROS)');
    if (links.requestsNote) add(requests, 'p', 'muted', links.requestsNote);
    else if (!(links.requests || []).length) add(requests, 'p', 'muted', 'Nenhum pedido lido da conversa.');
    (links.requests || []).forEach((item) => add(requests, 'p', '', `${item.vehicle || 'Carro não informado'} · lido em ${date(item.at)}${item.needsReview ? ' · a IA pediu revisão' : ''}`));
    // In the ficha the per-search groups live in O QUE OFERECER; the batch line stays here.
    const searches = add(box, 'div');
    add(searches, 'strong', '', 'Busca e carros');
    const groupLines = searchGroups ? searches : e('div');
    if (!(context.searches || []).length) add(groupLines, 'p', 'muted', 'Sem busca: o pedido ainda não tem o que a busca precisa, ou o caso está encerrado.');
    (context.searches || []).forEach((item) => searchGroupLine(groupLines, context, item));
    if (!searchGroups) add(searches, 'p', 'muted', 'Com carros, sem carros e busca não rodada: veja O QUE OFERECER.');
    fillReasons();
    add(searches, 'p', 'muted', links.cars && links.cars.uploadAt ? `Lote ativo carregado em ${date(links.cars.uploadAt)}. Disponibilidade no leilão não confirmada.` : 'Nenhum lote ativo do Manheim.');
    if ((context.promises || []).length) { const promises = add(box, 'div'); add(promises, 'strong', '', 'Promessas em aberto'); context.promises.forEach((item) => add(promises, 'p', '', `${item.text} · ${date(item.dueAt)}`)); }
    // aiReading=false: the card already shows the reading on its own line (CLIENTES).
    if ((context.aiOrders || context.aiReading) && aiReading) {
      const ai = add(box, 'div'); add(ai, 'strong', '', 'Leitura da IA por pedido (não confirmada)');
      const orders = context.aiOrders;
      if (orders) {
        (orders.items || []).forEach((entry) => add(ai, 'p', '', `Resumo da IA · pedido ${entry.ref || 'sem Ref'}: ${entry.summary}`));
        if (orders.state !== 'POR_PEDIDO' && orders.text) add(ai, 'p', 'muted', orders.text);
      } else if (context.aiReading && context.aiReading.summary) add(ai, 'p', '', context.aiReading.summary);
      if (context.aiReading && context.aiReading.nextStep) add(ai, 'p', 'muted', 'A IA sugere: ' + context.aiReading.nextStep);
    }
    return box;
  }

  // The full case summary for the ficha (always open).
  function full(context) {
    const card = e('section', 'lead-card client-context-full');
    add(card, 'span', 'lead-label', 'RESUMO DO CASO');
    const summary = compact(context, { open: null });
    const more = summary.querySelector('.context-more');
    if (more) more.remove();
    card.append(...summary.childNodes);
    add(card, 'h3', 'context-subtitle', 'O que o cliente informou, campo a campo');
    add(card, 'p', 'muted', 'Cada valor mostra de onde veio. “Lido pela IA” nunca é confirmação do cliente; campos ambíguos não têm valor escolhido.');
    // The ficha shows the search groups in O QUE OFERECER (section 8): not repeated here.
    card.append(fullTable(context), linksBlock(context, { searchGroups: false }));
    return card;
  }

  async function forJourney(journeyId, request) {
    await load([{ journeyId }], request);
    return fresh('journey:' + journeyId);
  }
  async function forRef(ref, request) {
    await load([{ ref }], request);
    return resolve({ ref });
  }
  function forget() { cache.clear(); }

  window.MCSContext = { slot, hydrate, full, compact, forJourney, forRef, forget };
})();
