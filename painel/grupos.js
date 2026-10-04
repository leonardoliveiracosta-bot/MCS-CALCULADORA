(() => {
  'use strict';
  // Contatos em HOJE, ENTRADA e CLIENTES. Cada contato fica em uma seção só (fora do assunto >
  // não atendidos > atendidos), com a origem como etiqueta curta e filtro; o que fazer agora vem primeiro.
  // Só apresentação: nada aqui grava, exceto a correção de "fora do assunto" que você pedir, e nada
  // é enviado. Tradução: só a já guardada aparece; sem ela, um link "traduzir" (nunca automático).
  const e = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined && text !== null) node.textContent = String(text); return node; };
  const add = (parent, tag, cls, text) => { const node = e(tag, cls, text); parent.append(node); return node; };
  const when = (value) => value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '';
  const groupsApi = () => window.MCSGroups;

  // The group of an item (computed by the server); an item without one counts as attended.
  const groupOf = (item) => item && item.group && item.group.key ? item.group : { key: 'ATENDIDO', label: groupsApi().SECTIONS.ATENDIDO.label, origin: null, unattended: null };

  // "DE ONDE VEIO": a short chip (never a sentence repeated on every line), with the financing tag.
  function originChip(item) {
    const origin = groupOf(item).origin;
    if (!origin) return null;
    const chip = e('span', 'badge origin-chip', origin.label);
    chip.dataset.origin = origin.key;
    chip.title = 'De onde veio';
    if (!origin.financing) return chip;
    const wrap = e('span', 'origin-chips');
    wrap.append(chip, e('span', 'badge yellow origin-financing', 'Financiamento'));
    return wrap;
  }
  // "ASSUNTO": what the person is asking about now (read by the Claude, or corrected by you). Separate from the origin and from
  // the channel. A source that did not load says so; it never shows as "Ainda não identificado".
  function subjectChip(item) {
    const subject = groupOf(item).subject;
    if (!subject) return null;
    const chip = e('span', 'badge subject-chip' + (subject.state === 'INDISPONIVEL' ? ' yellow' : ''), subject.label);
    chip.dataset.subject = subject.key || 'INDISPONIVEL';
    chip.title = 'Assunto' + (subject.source === 'MANUAL' ? ' · corrigido por você' : subject.source === 'CLAUDE' ? ' · lido pelo Claude' : subject.state === 'PENDENTE' ? ' · a conversa ainda não foi lida' : '') + (subject.reason ? ' · ' + subject.reason : '');
    return chip;
  }
  // Your correction of the subject: stored, never overwritten by the Claude's reading, with "Desfazer".
  function subjectSelect(item, { request, refresh, journeyId }) {
    if (!journeyId) return null;
    const current = groupOf(item).subject || {};
    const select = e('select', 'subject-correct small');
    select.setAttribute('aria-label', 'Corrigir o assunto');
    select.append(new Option('Corrigir assunto…', ''));
    Object.values(groupsApi().SUBJECTS).forEach((subject) => select.append(new Option(subject.label, subject.key)));
    if (current.source === 'MANUAL') select.append(new Option('Voltar à leitura do Claude', 'AUTO'));
    const post = (subject) => request('/api/panel/subject', { method: 'POST', body: JSON.stringify({ journeyId, subject }) });
    select.addEventListener('change', () => {
      const chosen = select.value;
      if (!chosen) return;
      const before = current.source === 'MANUAL' ? current.key : null;
      window.MCSAction.run({ button: select, successScope: document.body, commit: () => post(chosen === 'AUTO' ? null : chosen), successText: 'Assunto corrigido', undo: { commit: () => post(before), successText: 'Correção desfeita', refresh }, refresh, errorText: 'Não consegui corrigir o assunto, tente de novo' }).finally(() => { select.value = ''; });
    });
    return select;
  }
  // The origin filter (a select like "Ordenar"): everyone by default; it only narrows the list.
  function fillOriginSelect(select) {
    if (!select || select.dataset.filled) return;
    select.dataset.filled = '1';
    const current = select.value;
    select.replaceChildren(...groupsApi().ORIGIN_OPTIONS.map(([value, label]) => new Option(label, value)));
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }

  // What to do now, first on every card.
  function decision(item) {
    const group = groupOf(item);
    if (group.key === 'FORA_DO_ASSUNTO') return { tone: 'muted', text: `Fora do assunto (${group.offTopicSource === 'MANUAL' ? 'correção sua' : 'leitura da IA'}) · Nada a fazer · Se for sobre carro, use "É sobre carro"` };
    if (group.unattended) { const u = group.unattended; return { tone: 'red', text: `${u.reasonText} · Esperando há ${u.waitedText} · Falta: ${u.missing} · Agora: ${u.next}` }; }
    const next = item.next_action_text || item.nextActionText;
    if (next) return { tone: 'yellow', text: `Agora: ${next}${item.next_action_at ? ' · ' + when(item.next_action_at) : ''}` };
    if (item.searchStageLabel) return { tone: 'blue', text: `Agora: ${item.searchStageLabel}` };
    return { tone: 'muted', text: 'Nada pendente agora · Respondido e sem atraso' };
  }
  function decisionNode(item) {
    const info = decision(item);
    const node = e('p', `card-decision decision-${info.tone}`);
    node.dataset.group = groupOf(item).key;
    add(node, 'strong', 'card-decision-label', groupOf(item).label);
    node.append(document.createTextNode(' · ' + info.text));
    return node;
  }

  // The latest customer message, highlighted (cards without a calculator order).
  function lastMessageNode(item, journeyId) {
    const message = item && item.lastCustomerMessage;
    if (!message || !message.text) return null;
    const box = e('blockquote', 'card-last-message');
    box.dataset.lastMessageId = message.id;
    if (journeyId) box.dataset.journeyId = journeyId;
    add(box, 'span', 'card-last-message-label', `Última mensagem do cliente · ${when(message.at)}`);
    add(box, 'p', 'card-last-message-text', message.text);
    add(box, 'p', 'card-last-message-translation hidden', '');
    box.addEventListener('click', (event) => event.stopPropagation());
    return box;
  }

  // Suggest or generate a reply, inside the card, through the same 24 h window send path as the
  // ficha (MCSSuggest: panel send with confirmation when open, WhatsApp on the phone when closed).
  function replyTools(journeyId, { request, onSent } = {}) {
    if (!journeyId || !window.MCSSuggest) return null;
    const details = e('details', 'card-reply-tools');
    add(details, 'summary', '', 'Sugerir ou gerar resposta');
    details.addEventListener('click', (event) => event.stopPropagation());
    details.addEventListener('toggle', () => {
      if (!details.open || details.dataset.ready) return;
      details.dataset.ready = '1';
      details.append(MCSSuggest.box(journeyId, { request, compact: true, onSent }), MCSSuggest.guided(journeyId, { request, onSent }));
    });
    return details;
  }

  // "É sobre carro" / "Fora do assunto": your correction, stored and with "Desfazer".
  function topicButton(item, { request, refresh, chatId = null, journeyId = null }) {
    const offTopic = groupOf(item).key === 'FORA_DO_ASSUNTO';
    if (!chatId && !journeyId) return null;
    // A calculator order is always about a car: no "fora do assunto" for it.
    if (!offTopic && groupOf(item).hasCalculator) return null;
    const button = e('button', 'quiet small topic-correct', offTopic ? 'É sobre carro' : 'Fora do assunto');
    button.type = 'button';
    button.title = offTopic ? 'Volta para o fluxo principal e fica guardado' : 'A conversa nunca falou de carro · Vai para o grupo Fora do assunto · Nada é apagado';
    window.MCSAction.bind(button, () => ({
      successScope: document.body,
      commit: () => request('/api/panel/triage', { method: 'POST', body: JSON.stringify({ action: 'topic', chatId, journeyId, aboutCar: offTopic }) }),
      successText: offTopic ? 'Correção salva · Voltou para o fluxo principal' : 'Correção salva · Foi para Fora do assunto',
      undo: { commit: (result) => request('/api/panel/triage', { method: 'POST', body: JSON.stringify({ action: 'topic_undo', ids: result.ids || [] }) }), successText: 'Correção desfeita', refresh },
      refresh, errorText: 'Não consegui salvar a correção, tente de novo'
    }));
    return button;
  }

  // Sections per group: header with the label, the count and what the group means. Empty groups
  // are left out; "Fora do assunto" stays folded.
  function render(root, items, renderCard, { skip = [], emptyText = 'Nada aqui', onRendered = null, flat = false } = {}) {
    const sections = groupsApi().split(items, groupOf).filter((group) => group.items.length && !skip.includes(group.key));
    if (!sections.length) { add(root, 'p', 'empty-state', emptyText); return []; }
    if (flat) {
      // One grid for every case, in the same order (group, search type, subject), without section
      // headers: the card itself says why it is here and which calculator, so a header would repeat it.
      const grid = add(root, 'section', 'contact-group contact-group-flat');
      sections.forEach((group) => {
        const place = (item, area, subjectKey) => { const card = renderCard(item); if (!card) return; card.dataset.group = group.key; card.dataset.area = area; if (subjectKey) card.dataset.subject = subjectKey; grid.append(card); };
        groupsApi().areas(group.items).forEach((area) => {
          if (area.key === 'SEM_REF') groupsApi().bySubject(area.items).forEach((subject) => subject.items.forEach((item) => place(item, area.key, subject.key)));
          else area.items.forEach((item) => place(item, area.key));
        });
      });
      if (onRendered) onRendered(root);
      return sections;
    }
    sections.forEach((group) => {
      const folded = group.key === 'FORA_DO_ASSUNTO';
      const section = e(folded ? 'details' : 'section', `contact-group contact-group-${group.key.toLowerCase().replace(/_/g, '-')}`);
      section.dataset.group = group.key;
      const head = add(section, folded ? 'summary' : 'header', 'contact-group-head');
      add(head, 'strong', 'contact-group-label', group.label);
      add(head, 'span', 'badge contact-group-count', String(group.items.length));
      add(head, 'span', 'muted contact-group-hint', group.hint);
      // Inside each section, one area per search type (calculator by value, by car, direct
      // conversation incomplete, direct with the search defined); off-topic stays one list.
      const place = (target, item) => { const card = renderCard(item); if (card) { card.dataset.group = group.key; card.dataset.area = groupsApi().areaOf(item); target.append(card); } };
      if (folded) group.items.forEach((item) => place(section, item));
      else groupsApi().areas(group.items).forEach((area) => {
        const box = add(section, 'section', `contact-area contact-area-${area.key.toLowerCase().replace(/_/g, '-')}`);
        box.dataset.area = area.key;
        const areaHead = add(box, 'header', 'contact-area-head');
        add(areaHead, 'strong', 'contact-area-label', area.label);
        add(areaHead, 'span', 'badge contact-area-count', String(area.items.length));
        add(areaHead, 'span', 'muted contact-area-hint', area.hint);
        if (area.key === 'SEM_REF') {
          // One block for every conversation without a Ref, organized by the subject.
          groupsApi().bySubject(area.items).forEach((subject) => {
            const part = add(box, 'section', 'contact-subject contact-subject-' + String(subject.key).toLowerCase().replace(/_/g, '-'));
            part.dataset.subject = subject.key;
            const partHead = add(part, 'header', 'contact-subject-head');
            add(partHead, 'strong', 'contact-subject-label', subject.label);
            add(partHead, 'span', 'badge contact-subject-count', String(subject.items.length));
            subject.items.forEach((item) => place(part, item));
          });
        } else area.items.forEach((item) => place(box, item));
      });
      root.append(section);
    });
    if (onRendered) onRendered(root);
    return sections;
  }

  // Saved translations of the highlighted messages, in one read (no AI, no cost). Without one, a
  // foreign message gets a "traduzir" link; the click translates that message only.
  async function hydrateTranslations(root, { request }) {
    const boxes = [...root.querySelectorAll('.card-last-message[data-last-message-id]')].filter((box) => !box.dataset.translationChecked);
    if (!boxes.length) return;
    boxes.forEach((box) => { box.dataset.translationChecked = '1'; });
    const ids = [...new Set(boxes.map((box) => box.dataset.lastMessageId))];
    const translations = {}, translatable = new Set();
    for (let index = 0; index < ids.length; index += 150) {
      try {
        const out = await request('/api/panel/suggestions', { method: 'POST', body: JSON.stringify({ action: 'cached', messageIds: ids.slice(index, index + 150) }) });
        Object.assign(translations, out.translations || {}); (out.translatable || []).forEach((id) => translatable.add(id));
      } catch (_) { /* no translation shown; the message itself is always there */ }
    }
    boxes.forEach((box) => {
      const id = box.dataset.lastMessageId, target = box.querySelector('.card-last-message-translation');
      if (translations[id]) { target.textContent = 'Tradução: ' + translations[id].textPt; target.classList.remove('hidden'); return; }
      if (!translatable.has(id) || !box.dataset.journeyId) return;
      const link = e('button', 'quiet small translate-link', 'traduzir'); link.type = 'button';
      link.addEventListener('click', async (event) => {
        event.stopPropagation();
        link.disabled = true; link.textContent = 'traduzindo…';
        try {
          const out = await request('/api/panel/suggestions', { method: 'POST', timeoutMs: 45000, body: JSON.stringify({ action: 'translate', journeyId: box.dataset.journeyId, messageIds: [id] }) });
          const found = out.translations && out.translations[id];
          if (found) { target.textContent = 'Tradução: ' + found.textPt; target.classList.remove('hidden'); link.remove(); }
          else { link.textContent = 'sem tradução'; }
        } catch (_) { link.disabled = false; link.textContent = 'traduzir (tentar de novo)'; }
      });
      box.append(link);
    });
  }

  window.MCSContactGroups = Object.freeze({ render, decision, decisionNode, lastMessageNode, replyTools, topicButton, hydrateTranslations, groupOf, originChip, subjectChip, subjectSelect, fillOriginSelect });

  // ------------------------------------------------------------------ busca de carros em três grupos
  // Adendo, item 2: com carros × sem carros (a busca rodou) × busca ainda não rodada. Nunca misturados.
  // Every "sem carros" shows its reason in plain language; one field per piece of information.
  const SEARCH_GROUPS = [
    { key: 'COM_CARROS', label: 'Com carros no lote', hint: 'A busca achou carros no lote ativo', states: ['COM_OPCOES', 'COM_CANDIDATOS'] },
    { key: 'SEM_CARROS', label: 'Atendimento manual', hint: 'A busca rodou e não achou nenhum carro · O motivo aparece em cada pedido', states: ['SEM_OPCAO'] },
    { key: 'NAO_RODADA', label: 'Busca ainda não rodada', hint: 'Falta comparar com o lote, falta detalhe do cliente ou precisa de revisão', states: ['FALTA_BUSCAR', 'PRECISA_DETALHE', 'PRECISA_REVISAO'] }
  ];
  const searchGroupOf = (state) => (SEARCH_GROUPS.find((group) => group.states.includes(state)) || SEARCH_GROUPS[2]).key;
  const usdText = (value) => 'US$ ' + Math.round(Number(value) || 0).toLocaleString('en-US');
  const milesText = (value) => Number(value).toLocaleString('en-US');
  const between = (min, max, format = String) => min && max ? (min === max ? format(min) : `${format(min)} a ${format(max)}`) : min ? `a partir de ${format(min)}` : max ? `até ${format(max)}` : '';
  // The fields of one request: a wish of the official demand or the criteria read from a conversation.
  function searchFields(item) {
    const wish = (item.targets && item.targets[0] && (item.targets[0].wishes || [])[0]) || item.criteria || {};
    const target = item.targets && item.targets[0] || null;
    const mode = item.searchMode || (target && target.mode) || null;
    const rows = [
      ['Tipo de busca', mode === 'CARRO' ? 'Por carro (modelo, anos e milhagem)' : mode === 'VALOR' ? 'Por valor (modelo e lance máximo)' : ''],
      ['Marca', wish.make || ''],
      ['Modelo', wish.model || ''],
      ['Versão', wish.trim || ''],
      ['Carroceria', wish.bodyType || ''],
      ['Anos', between(wish.yearMin, wish.yearMax)],
      ['Milhagem', between(wish.minMiles, wish.maxMiles, (value) => milesText(value) + ' mi')],
      ['Lance máximo', target && target.bidCents ? usdText(target.bidCents / 100) : wish.budgetUsd ? usdText(wish.budgetUsd) : '']
    ].filter(([, value]) => value);
    if ((item.targets || []).length > 1 || ((item.targets && item.targets[0] && item.targets[0].wishes) || []).length > 1) rows.push(['Outros carros no pedido', String(((item.targets || []).flatMap((entry) => entry.wishes || [])).length - 1)]);
    const list = e('dl', 'search-fields');
    rows.forEach(([term, value]) => { add(list, 'dt', '', term); add(list, 'dd', '', value); });
    return rows.length ? list : null;
  }
  // Why the search did not run yet, in plain words.
  function notRunText(item) {
    if (item.state === 'PRECISA_DETALHE') return 'Falta o cliente dizer: ' + (item.lacksText || 'um detalhe do carro');
    if (item.state === 'PRECISA_REVISAO') return 'Precisa da sua revisão antes de buscar' + (item.reviewReason ? ': ' + item.reviewReason : '');
    return 'Ainda não comparado com o lote ativo · Use "Comparar com o lote"';
  }
  function renderSearchGroups(root, entries, renderEntry, stateOf) {
    SEARCH_GROUPS.forEach((group) => {
      const members = entries.filter((entry) => group.states.includes(stateOf(entry)) || (group.key === 'NAO_RODADA' && !SEARCH_GROUPS.some((other) => other.states.includes(stateOf(entry)))));
      if (!members.length) return;
      const section = e('section', `search-group search-group-${group.key.toLowerCase().replace(/_/g, '-')}`);
      section.dataset.searchGroup = group.key;
      const head = add(section, 'header', 'search-group-head');
      add(head, 'strong', '', group.label);
      add(head, 'span', 'badge', String(members.length));
      add(head, 'span', 'muted search-group-hint', group.hint);
      members.forEach((entry) => { const node = renderEntry(entry); if (node) section.append(node); });
      root.append(section);
    });
  }
  window.MCSSearchGroups = Object.freeze({ GROUPS: SEARCH_GROUPS, groupOf: searchGroupOf, fields: searchFields, notRunText, render: renderSearchGroups });
})();
