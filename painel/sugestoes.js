(() => {
  'use strict';
  // Sugestão de resposta dentro da conversa da ficha e fila de conversas antigas (CLIENTES).
  // Gerar, editar e copiar nunca enviam nada. O envio tem um caminho só, decidido pela janela de
  // 24 h do WhatsApp: aberta, sai pelo painel depois da sua confirmação; encerrada, abre a conversa
  // no WhatsApp do celular com o texto preenchido e você envia por lá.
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
  function box(journeyId, { request, mode = null, compact = false, onSent = null } = {}) {
    const card = e('section', 'lead-card suggestion-card' + (compact ? ' suggestion-compact' : ''));
    card.dataset.journeyId = journeyId;
    add(card, 'span', 'lead-label', mode === 'RETOMADA' ? 'SUGESTÃO DE RETOMADA' : 'SUGESTÃO DE RESPOSTA');
    add(card, 'p', 'muted', 'Nada sai sozinho · Você revisa e envia: pelo painel com sua confirmação (janela de 24 h aberta) ou pelo WhatsApp do celular (janela encerrada)');
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
        render(body, result, { request, onSent });
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

  function render(root, data, options = {}) {
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
    // 4. The window and the one send path it allows; 5. copy, send, discard.
    sendControls(root, data, textarea, options);
  }

  // ------------------------------------------------------------------ envio: um caminho só
  // The 24 h window decides the path, and the panel says which one before the click:
  //  · open: "Enviar pelo painel" asks for a confirmation (to whom, the text) and sends by the API
  //    (/api/panel/reply, which checks the window and the destination again);
  //  · closed: "Abrir no WhatsApp do celular" opens the conversation with the text filled in.
  // Used by the automatic suggestion, the guided reply and the old-conversation queue.
  const SEND_ERRORS = {
    WINDOW_CLOSED: 'A janela de 24 h fechou enquanto você revisava · Abra no WhatsApp do celular e envie por lá',
    REPLY_NOT_ELIGIBLE: 'Sem número de WhatsApp confiável nesta ficha: envio pelo painel indisponível',
    SEND_IN_PROGRESS: 'Já existe um envio em andamento para esta conversa',
    SENT_NOT_RECORDED: 'Enviado ao cliente, mas não registrado no painel · Não reenvie',
    TEXT_REQUIRED: 'Escreva a mensagem antes de enviar',
    TEXT_TOO_LONG: 'Mensagem longa demais (máximo 4.000 caracteres)'
  };
  const windowOpen = (path) => Boolean(path && path.open) && (!path.until || Date.parse(path.until) > Date.now());
  const clock = (value) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
  function sendControls(root, data, textarea, { request, onSent } = {}) {
    const reachable = Boolean(data.reachable && data.whatsappBase);
    let open = reachable && windowOpen(data.path);
    const path = add(root, 'div', 'suggestion-path ' + (open ? 'is-open' : 'is-closed'));
    const title = add(path, 'strong', '', '');
    const how = add(path, 'p', '', '');
    const actions = add(root, 'div', 'lead-actions');
    const copy = add(actions, 'button', 'quiet small', 'Copiar'); copy.type = 'button';
    const done = add(root, 'p', 'muted suggestion-result', '');
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(textarea.value); done.textContent = 'Copiado · Nada foi enviado'; } catch (_) { textarea.select(); done.textContent = 'Selecione o texto e copie · Nada foi enviado'; } });
    let sendButton = null, openLink = null, busy = false, sent = false;
    const paintPath = () => {
      path.className = 'suggestion-path ' + (open ? 'is-open' : 'is-closed');
      if (!reachable) { title.textContent = 'Sem número de WhatsApp confiável nesta ficha'; how.textContent = 'Só copiar: o painel não sabe para quem enviar'; return; }
      title.textContent = open ? 'Janela de 24 h aberta' + (data.path.until ? ' até ' + clock(data.path.until) + ' (Flórida)' : '') : 'Janela de 24 h encerrada';
      how.textContent = open
        ? 'Ao enviar, a mensagem sai pelo painel, só depois da sua confirmação'
        : 'Ao enviar, abre a conversa no WhatsApp do celular com o texto preenchido e você envia por lá';
    };
    const showOpenLink = () => {
      if (openLink || !reachable) return;
      openLink = e('a', 'small suggestion-open', 'Abrir no WhatsApp do celular'); openLink.target = '_blank'; openLink.rel = 'noopener';
      const refresh = () => { openLink.href = waUrl(data.whatsappBase, textarea.value); };
      refresh(); textarea.addEventListener('input', refresh);
      openLink.addEventListener('click', () => { done.textContent = 'WhatsApp aberto com o texto · O envio é feito por você no aplicativo'; });
      actions.insertBefore(openLink, discard);
    };
    const closeWindow = () => { open = false; if (sendButton) { sendButton.remove(); sendButton = null; } paintPath(); showOpenLink(); };
    const confirmSend = () => {
      if (busy || sent || root.querySelector('.suggestion-confirm')) return;
      const text = textarea.value.trim();
      if (!text) { done.textContent = SEND_ERRORS.TEXT_REQUIRED; return; }
      const box = e('div', 'warning inline-confirm suggestion-confirm');
      add(box, 'p', '', 'Enviar para ' + data.contact.name + ' · ' + data.contact.phone);
      add(box, 'p', 'muted', 'Sai pelo painel agora, uma mensagem para esta pessoa' + (data.path.until ? ' · Janela aberta até ' + clock(data.path.until) + ' (Flórida)' : ''));
      add(box, 'blockquote', 'context-evidence suggestion-confirm-text', text);
      const yes = add(box, 'button', 'small suggestion-confirm-yes', 'Confirmar envio'); yes.type = 'button';
      const no = add(box, 'button', 'quiet small', 'Cancelar'); no.type = 'button';
      no.addEventListener('click', () => box.remove());
      yes.addEventListener('click', async () => {
        if (busy) return; // double tap: one request only
        busy = true; yes.disabled = true; no.disabled = true; sendButton.disabled = true; yes.textContent = 'Enviando…';
        try {
          const result = await request('/api/panel/reply', { method: 'POST', timeoutMs: 30000, body: JSON.stringify({ action: 'send', journeyId: data.journeyId, textEn: text }) });
          sent = true; box.remove(); sendButton.remove(); sendButton = null; textarea.readOnly = true;
          done.textContent = 'Enviado pelo painel' + (result && result.simulated ? ' · simulado neste ambiente, nada saiu para o cliente' : ' · já está na conversa');
          if (onSent) onSent(result);
        } catch (failure) {
          box.remove();
          const code = failure && failure.code;
          done.textContent = SEND_ERRORS[code] || (/^D360_/.test(code || '') ? code + ' · Não enviado · nada foi registrado' : 'Não enviado · tente de novo');
          if (code === 'WINDOW_CLOSED') closeWindow();
          else if (code === 'SENT_NOT_RECORDED') { sent = true; sendButton.remove(); sendButton = null; }
          else if (sendButton) sendButton.disabled = false;
        } finally { busy = false; }
      });
      root.insertBefore(box, done);
    };
    if (open) {
      sendButton = add(actions, 'button', 'small suggestion-send', 'Enviar pelo painel'); sendButton.type = 'button';
      sendButton.addEventListener('click', confirmSend);
    }
    const discard = add(actions, 'button', 'quiet small', 'Descartar'); discard.type = 'button';
    discard.addEventListener('click', () => { root.replaceChildren(e('p', 'muted', 'Sugestão descartada · Nada foi enviado')); });
    if (!open) showOpenLink();
    paintPath();
    if (reachable) add(root, 'p', 'muted', 'Para ' + data.contact.name + ' · ' + data.contact.phone);
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

  // ------------------------------------------------------------------ resposta orientada
  // The operator writes in Portuguese what to convey; the AI writes it in the client's language.
  // Same review as the suggestion (edit, copy, discard, open WhatsApp). Generating never sends.
  const GUIDED_ERRORS = { ...ERRORS, GUIDANCE_REQUIRED: 'Escreva o que você quer transmitir antes de gerar', GUIDANCE_TOO_LONG: 'Orientação longa demais · Use até 1.500 caracteres', SUGGESTION_IN_PROGRESS: 'Já existe uma resposta sendo preparada para esta conversa' };
  function guided(journeyId, { request, onSent = null } = {}) {
    const card = e('section', 'lead-card guided-card');
    card.dataset.journeyId = journeyId;
    add(card, 'span', 'lead-label', 'RESPOSTA ORIENTADA');
    add(card, 'p', 'muted', 'Escreva em português os pontos que quer passar · A IA redige no idioma do cliente · Você revisa e envia pelo mesmo caminho da sugestão');
    const label = add(card, 'label', 'guided-label', 'O que você quer transmitir');
    const input = add(label, 'textarea', 'guided-input'); input.rows = 3; input.maxLength = 1500;
    input.placeholder = 'Ex.: o Camry 2020 que ele gostou já passou no leilão; temos outros parecidos esta semana; pedir confirmação do lance';
    const actions = add(card, 'div', 'lead-actions');
    const make = add(actions, 'button', 'small', 'Gerar resposta'); make.type = 'button';
    const status = add(card, 'p', 'status', '');
    const body = add(card, 'div', 'suggestion-body');
    let busy = false;
    make.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (busy) return; // double tap: one request only
      const guidance = input.value.trim();
      status.classList.remove('error');
      // Empty guidance: a warning, no call and no cost.
      if (!guidance) { status.classList.add('error'); status.textContent = GUIDED_ERRORS.GUIDANCE_REQUIRED; input.focus(); return; }
      busy = true; make.disabled = true; status.textContent = 'Preparando resposta…';
      try {
        const result = await request('/api/panel/suggestions', { method: 'POST', timeoutMs: 45000, body: JSON.stringify({ action: 'guided', journeyId, guidance }) });
        status.textContent = '';
        render(body, result, { request, onSent });
        const head = body.querySelector('.suggestion-head');
        if (head) add(head, 'span', 'lead-badge', 'Orientada por você');
        // What the guidance contradicts in the ficha or the conversation: shown, never chosen silently.
        if ((result.conflicts || []).length) {
          const box = e('div', 'warning guided-conflicts');
          add(box, 'strong', '', 'A orientação conflita com o que está registrado · Confira antes de usar');
          const list = add(box, 'ul', '');
          result.conflicts.forEach((item) => add(list, 'li', '', `${item.point} × ${item.recorded} (${item.source === 'conversa' ? 'conversa' : 'ficha'})`));
          body.insertBefore(box, body.children[1] || null);
        }
        make.textContent = 'Gerar outra versão';
      } catch (failure) {
        const code = failure && failure.code;
        status.classList.add('error');
        status.textContent = code === 'SUGGESTION_BLOCKED' ? 'Sem resposta: ' + ((failure.reason && failure.reason.text) || 'contato bloqueado') : GUIDED_ERRORS[code] || 'Não foi possível preparar a resposta agora';
      } finally { busy = false; make.disabled = false; }
    });
    card.addEventListener('click', (event) => event.stopPropagation());
    return card;
  }

  // ------------------------------------------------------------------ tradução da conversa
  // On demand, with cache: saved translations come back with no call; "Traduzir conversa" translates
  // the visible messages once; a new or changed message gets its own "traduzir" link. The original
  // messages are never changed: the translation is shown under them.
  function translator(journeyId, { request, onChange } = {}) {
    const state = { translations: {}, translatable: new Set(), busy: false, loaded: false };
    const notify = () => { if (onChange) onChange(); };
    async function load() {
      try {
        const out = await request('/api/panel/suggestions', { method: 'POST', body: JSON.stringify({ action: 'translations', journeyId }) });
        state.translations = out.translations || {}; state.translatable = new Set(out.translatable || []); state.loaded = true;
      } catch (_) { state.loaded = false; }
      notify();
    }
    async function translate(ids) {
      const wanted = ids.filter((id) => state.translatable.has(id) && !state.translations[id]).slice(0, 20);
      if (state.busy || !wanted.length) return { translated: 0 };
      state.busy = true; notify();
      try {
        const out = await request('/api/panel/suggestions', { method: 'POST', timeoutMs: 45000, body: JSON.stringify({ action: 'translate', journeyId, messageIds: wanted }) });
        Object.assign(state.translations, out.translations || {});
        // Sent and answered: what came back without a translation (already Portuguese, for instance)
        // is not offered again in this ficha, so it is not paid again on the next click.
        wanted.forEach((id) => state.translatable.delete(id));
        return out;
      } finally { state.busy = false; notify(); }
    }
    return {
      load, translate,
      get: (id) => state.translations[id] || null,
      canTranslate: (id) => state.translatable.has(id) && !state.translations[id],
      hasAny: () => Object.keys(state.translations).length > 0,
      pending: () => [...state.translatable].filter((id) => !state.translations[id]),
      busy: () => state.busy
    };
  }

  window.MCSSuggest = { box, render, queue, guided, translator };
})();
