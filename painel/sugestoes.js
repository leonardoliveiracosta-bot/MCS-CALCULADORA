(() => {
  'use strict';
  // Sugestão de resposta dentro da conversa da ficha e fila de conversas antigas (CLIENTES).
  // Gerar, editar, copiar ou abrir o WhatsApp nunca envia nada: quem envia é você, no aplicativo.
  const e = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined && text !== null) node.textContent = String(text); return node; };
  const add = (parent, tag, cls, text) => { const node = e(tag, cls, text); parent.append(node); return node; };
  const date = (value) => value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
  const FACT = { CONFIRMADO: ['Confirmado', 'is-client'], INFERIDO: ['Inferido', 'is-ai'], DESCONHECIDO: ['Desconhecido', 'is-missing'] };
  const ERRORS = {
    SUGGESTION_BLOCKED: null,
    NO_CONVERSATION: 'Esta ficha ainda não tem conversa para sugerir resposta',
    SUGGESTION_IN_PROGRESS: 'Já existe uma sugestão sendo preparada para esta conversa',
    OPENAI_BUDGET_LIMIT: 'Sem saldo no teto de US$ 50 da OpenAI · Nada foi cobrado',
    AI_UNAVAILABLE: 'IA indisponível agora · Escreva a resposta manualmente',
    AI_RESPONSE_INVALID: 'A IA respondeu fora do formato · Tente de novo ou escreva manualmente'
  };
  const waUrl = (base, text) => base ? base + '?text=' + encodeURIComponent(text) : null;

  // The suggestion box. options.mode: 'RESPOSTA' | 'RETOMADA' (default: decided by the last message).
  function box(journeyId, { request, mode = null, compact = false } = {}) {
    const card = e('section', 'lead-card suggestion-card' + (compact ? ' suggestion-compact' : ''));
    card.dataset.journeyId = journeyId;
    add(card, 'span', 'lead-label', mode === 'RETOMADA' ? 'SUGESTÃO DE RETOMADA' : 'SUGESTÃO DE RESPOSTA');
    add(card, 'p', 'muted', 'A sugestão nunca é enviada pelo painel · Você edita, copia ou abre o WhatsApp e envia por lá');
    const actions = add(card, 'div', 'lead-actions');
    const make = add(actions, 'button', 'small', mode === 'RETOMADA' ? 'Sugerir retomada' : 'Sugerir resposta'); make.type = 'button';
    const status = add(card, 'p', 'status', '');
    const body = add(card, 'div', 'suggestion-body');
    let busy = false;
    make.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (busy) return;
      busy = true; make.disabled = true; status.textContent = 'Preparando sugestão…'; status.classList.remove('error');
      try {
        const result = await request('/api/panel/suggestions', { method: 'POST', timeoutMs: 45000, body: JSON.stringify({ action: 'suggest', journeyId, ...(mode ? { mode } : {}) }) });
        status.textContent = '';
        render(body, result);
        make.textContent = 'Gerar outra sugestão';
      } catch (failure) {
        const code = failure && failure.code;
        status.classList.add('error');
        status.textContent = code === 'SUGGESTION_BLOCKED' ? 'Sem sugestão: ' + ((failure.reason && failure.reason.text) || 'contato bloqueado') : ERRORS[code] || 'Não foi possível preparar a sugestão agora';
      } finally { busy = false; make.disabled = false; }
    });
    card.addEventListener('click', (event) => event.stopPropagation());
    return card;
  }

  function render(root, data) {
    root.replaceChildren();
    const head = add(root, 'div', 'suggestion-head');
    add(head, 'span', 'lead-badge', data.mode === 'RETOMADA' ? 'Retomada' : 'Resposta');
    add(head, 'span', 'lead-badge', 'Idioma do cliente: ' + data.language.label);
    if (data.simulated) add(head, 'span', 'lead-badge yellow', 'Simulada · sem IA e sem custo');
    else add(head, 'span', 'lead-badge', `IA ${data.model} · US$ ${Number(data.costUsd || 0).toFixed(4)}`);
    if (data.notice) add(root, 'p', 'warning', data.notice);
    // 1. The last message received, and its translation.
    if (data.received) {
      const received = add(root, 'div', 'suggestion-received');
      add(received, 'strong', '', 'Última mensagem do cliente · ' + date(data.received.at));
      add(received, 'blockquote', 'context-evidence', data.received.text);
      if (data.received.translationPt) { add(received, 'small', 'muted', 'Tradução para português'); add(received, 'p', 'suggestion-translation', data.received.translationPt); }
    }
    if (data.last && data.last.from === 'MCS') add(root, 'p', 'muted', 'A MCS escreveu por último (' + date(data.last.at) + ')');
    // 2. The editable suggestion in the client's language, and its translation.
    const label = add(root, 'label', 'suggestion-edit', 'Resposta sugerida (' + data.language.label + ') · editável');
    const textarea = add(label, 'textarea', 'suggestion-text'); textarea.rows = 6; textarea.maxLength = 4000; textarea.value = data.suggestion.text;
    if (data.suggestion.translationPt) { add(root, 'small', 'muted', 'Tradução da resposta para português (da sugestão original)'); add(root, 'p', 'suggestion-translation', data.suggestion.translationPt); }
    if (data.suggestion.questionPurpose) add(root, 'p', 'muted', 'Por que a pergunta: ' + data.suggestion.questionPurpose);
    // 3. Facts the answer relies on: confirmed, inferred or unknown.
    if ((data.facts || []).length) {
      const facts = add(root, 'ul', 'suggestion-facts');
      data.facts.forEach((fact) => { const li = add(facts, 'li'); const [text, cls] = FACT[fact.status] || FACT.INFERIDO; add(li, 'span', 'context-status ' + cls, text); li.append(document.createTextNode(' ' + fact.text)); });
    }
    (data.warnings || []).forEach((warning) => add(root, 'p', 'warning suggestion-warning', warning));
    // 4. The path allowed now.
    const path = add(root, 'div', 'suggestion-path ' + (data.path.open ? 'is-open' : 'is-closed'));
    add(path, 'strong', '', data.path.open ? 'Janela de 24 h aberta' + (data.path.until ? ' até ' + date(data.path.until) : '') : 'Janela de 24 h encerrada');
    add(path, 'p', '', data.path.text);
    add(path, 'p', 'muted', data.path.manual);
    // 5. Edit, copy, open WhatsApp (you send there) or discard. Never a send from here.
    const actions = add(root, 'div', 'lead-actions');
    const copy = add(actions, 'button', 'quiet small', 'Copiar'); copy.type = 'button';
    const done = add(root, 'p', 'muted suggestion-result', '');
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(textarea.value); done.textContent = 'Copiado · Nada foi enviado'; } catch (_) { textarea.select(); done.textContent = 'Selecione o texto e copie · Nada foi enviado'; } });
    if (data.reachable && data.whatsappBase) {
      const open = add(actions, 'a', 'small suggestion-open', 'Abrir no WhatsApp com o texto'); open.target = '_blank'; open.rel = 'noopener';
      const refresh = () => { open.href = waUrl(data.whatsappBase, textarea.value); };
      refresh(); textarea.addEventListener('input', refresh);
      open.addEventListener('click', () => { done.textContent = 'WhatsApp aberto com o texto · O envio é feito por você no aplicativo'; });
      add(root, 'p', 'muted', 'Para ' + data.contact.name + ' · ' + data.contact.phone);
    } else add(root, 'p', 'warning', 'Sem número de WhatsApp confiável nesta ficha: só copiar');
    const discard = add(actions, 'button', 'quiet small', 'Descartar'); discard.type = 'button';
    discard.addEventListener('click', () => { root.replaceChildren(e('p', 'muted', 'Sugestão descartada · Nada foi enviado')); });
  }

  // ------------------------------------------------------------------ fila de conversas antigas
  async function queue(root, { request, open, contextSlot, hydrate, minDays = 14 }) {
    root.replaceChildren(e('p', 'muted', 'Carregando conversas antigas…'));
    let data;
    try { data = await request('/api/panel/suggestions?minDays=' + encodeURIComponent(minDays)); }
    catch (_) { root.replaceChildren(e('p', 'error', 'Não foi possível carregar a fila agora')); return null; }
    root.replaceChildren();
    add(root, 'p', 'muted', `Sem atividade há ${data.minDays} dias ou mais · Das mais antigas para as mais novas · Revisão uma a uma: nada é enviado e ninguém recebe lembrete automático`);
    if (!data.eligible.length) add(root, 'p', 'muted', 'Nenhuma conversa elegível agora');
    data.eligible.forEach((item) => {
      const card = add(root, 'article', 'item-card followup-item');
      card.dataset.journeyId = item.journeyId;
      const head = add(card, 'div', 'item-head');
      const who = add(head, 'div');
      add(who, 'strong', 'identity-name', item.name);
      add(who, 'span', 'muted', ' ' + [item.ref ? 'Ref ' + item.ref : null, item.phone].filter(Boolean).join(' · '));
      add(head, 'span', 'lead-badge yellow', `${item.days} dias sem atividade`);
      add(card, 'p', 'muted', `Última mensagem (${item.lastFrom === 'CUSTOMER' ? 'cliente' : 'MCS'}, ${date(item.lastAt)}): ${item.lastMessage}`);
      add(card, 'p', item.windowOpen ? 'muted' : 'muted followup-window', item.windowOpen ? 'Janela de 24 h aberta' : 'Janela de 24 h encerrada · API bloqueada: só pelo WhatsApp no celular');
      if (contextSlot) card.append(contextSlot({ journeyId: item.journeyId }));
      const actions = add(card, 'div', 'inline-actions');
      const openFicha = add(actions, 'button', 'quiet small', 'Abrir ficha e histórico'); openFicha.type = 'button';
      openFicha.addEventListener('click', (event) => { event.stopPropagation(); open('ficha', item.journeyId); });
      card.append(box(item.journeyId, { request, mode: item.lastFrom === 'CUSTOMER' ? 'RESPOSTA' : 'RETOMADA', compact: true }));
    });
    const excluded = add(root, 'details', 'followup-excluded');
    add(excluded, 'summary', '', `Fora da fila (${data.excluded.length}) · com o motivo`);
    const REASONS = { OPT_OUT: 'pediu para não receber contato', NOT_LEAD: 'não é lead', CLOSED: 'caso encerrado', OFF: 'caso desligado', NO_WHATSAPP: 'sem conversa de WhatsApp', MANY_CHATS: 'mais de uma conversa', INVALID_NUMBER: 'número inválido', PHONE_UNCERTAIN: 'número incerto', MANY_FICHAS: 'mais de uma ficha', REF_AMBIGUOUS: 'Ref em mais de uma ficha (resolver a identidade)', DISCARDED: 'descartado', TRIAGE_OUT: 'fora do funil comercial' };
    const reasons = Object.entries(data.reasons || {}).map(([code, count]) => `${REASONS[code] || code}: ${count}`).join(' · ');
    if (reasons) add(excluded, 'p', 'muted', reasons);
    data.excluded.slice(0, 200).forEach((item) => {
      const line = add(excluded, 'p', 'followup-excluded-item');
      add(line, 'strong', '', item.name);
      line.append(document.createTextNode(` · ${item.days} dias · ${item.reason.text}`));
      // Ref in more than one ficha: open the ficha to resolve whose case it is (no suggestion until then).
      if (item.reason.code === 'REF_AMBIGUOUS') { const fix = add(line, 'button', 'quiet small', 'Abrir ficha para resolver'); fix.type = 'button'; fix.addEventListener('click', (event) => { event.stopPropagation(); open('ficha', item.journeyId); }); }
    });
    if (hydrate) hydrate(root);
    return data;
  }

  window.MCSSuggest = { box, render, queue };
})();
