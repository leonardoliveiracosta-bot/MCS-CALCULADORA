// Assistente do painel: conversa sempre à mão, sem sair da tela e sem travar o painel.
// - MCSAssistantLog: memória no navegador das últimas 20 ações (cliques, chamadas ao servidor,
//   trocas de tela e erros). Só sai daqui junto de uma pergunta ou de um "Não funcionou".
// - A janela: pergunta → resposta; ação → cartão de proposta. Nada executa sem o toque em
//   "Autorizar" (azul: só tela; laranja "Autorizar e gravar": grava). A ação roda pelo mesmo
//   caminho do botão normal (MCSPanelBridge). Desfazer para seleção. Dado desatualizado: não
//   executa e pede nova proposta.
// - "Seus chamados" em Configurações, com "Copiar chamados abertos".
(() => {
  const MAX = 20;
  const buffer = [];
  const push = (entry) => { buffer.push({ ...entry, at: Date.now() }); if (buffer.length > MAX) buffer.shift(); };
  const bridge = () => window.MCSPanelBridge || null;
  const viewNow = () => (bridge() ? bridge().currentView() : null);
  // Rótulo estável dos botões principais (data-action quando há; senão pelo texto conhecido).
  const KNOWN = [[/^Gerar V1/i, 'v1-generate'], [/^Abrir ficha/i, 'ficha-open'], [/^Montar V2/i, 'v2-build'], [/^Enviar/i, 'v1-send'], [/^Selecionar/i, 'select'], [/^Remover/i, 'remove'], [/^Buscar/i, 'search'], [/Importar|CSV/i, 'import-csv'], [/^Atualizar/i, 'refresh']];
  const EXPECT = { 'v1-generate': 'gerar a V1 e abrir o WhatsApp', 'ficha-open': 'abrir a ficha do cliente', 'v2-build': 'abrir a montagem da V2', 'v1-send': 'enviar a mensagem', select: 'selecionar o carro', remove: 'remover o carro da seleção', search: 'buscar', 'import-csv': 'importar o CSV', refresh: 'atualizar a lista', today: 'abrir ATENDER AGORA', v1: 'abrir a aba V1', v2: 'abrir a aba V2', requests: 'abrir BUSCAR CARROS', searches: 'abrir ENVIAR OPÇÕES', imports: 'abrir IMPORTAÇÕES', settings: 'abrir Configurações' };
  const VIEW_NAMES = { today: 'ATENDER AGORA', v1: 'V1', v2: 'V2', requests: 'BUSCAR CARROS', searches: 'ENVIAR OPÇÕES', imports: 'IMPORTAÇÕES', settings: 'Configurações', ficha: 'Ficha' };
  function describe(el) {
    const text = String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const action = el.dataset.action || el.dataset.offerAction || el.dataset.view || (KNOWN.find(([re]) => re.test(text)) || [])[1] || null;
    return { action: action || 'outro', label: text || action || 'botão sem nome' };
  }
  document.addEventListener('click', (event) => {
    const el = event.target && event.target.closest && event.target.closest('button, a, summary, [role="button"], input[type="checkbox"], select');
    if (!el || el.closest('#mcs-assistant') || el.id === 'mcs-assistant-fab') return;
    push({ kind: 'click', ...describe(el), view: viewNow(), disabled: Boolean(el.disabled) });
  }, true);
  window.addEventListener('error', (event) => push({ kind: 'error', message: String(event.message || 'erro').slice(0, 300), view: viewNow() }));
  window.addEventListener('unhandledrejection', (event) => push({ kind: 'error', message: String(event.reason && (event.reason.code || event.reason.message) || event.reason || 'erro').slice(0, 300), view: viewNow() }));
  window.MCSAssistantLog = {
    request: (entry) => push({ kind: 'request', ...entry }),
    view: (view) => push({ kind: 'view', view }),
    entries: () => buffer.slice()
  };

  const versionOf = () => { const tag = document.querySelector('script[src*="/painel/painel.js"]'); const match = tag && /[?&]v=([^&]+)/.exec(tag.getAttribute('src')); return match ? match[1] : null; };
  const context = () => ({ view: viewNow(), detail: bridge() ? bridge().detail() : null, version: versionOf(), actions: buffer.slice() });
  const api = (body) => bridge().request('/api/panel/assistant', { method: 'POST', body: JSON.stringify(body), timeoutMs: 60000 });
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };

  // ---------------------------------------------------------------- janela
  let root = null, log = null, input = null, busy = false;
  const history = [];
  try { (JSON.parse(sessionStorage.getItem('mcs_assistant_history') || '[]') || []).slice(-30).forEach((item) => history.push(item)); } catch (_) {}
  const saveHistory = () => { try { sessionStorage.setItem('mcs_assistant_history', JSON.stringify(history.slice(-30))); } catch (_) {} };

  function build() {
    if (root) return;
    const fab = el('button', 'mcs-assistant-fab', 'Assistente'); fab.type = 'button'; fab.id = 'mcs-assistant-fab'; fab.title = 'Assistente (Alt+A)';
    fab.addEventListener('click', () => toggle());
    root = el('aside', 'mcs-assistant hidden'); root.id = 'mcs-assistant'; root.setAttribute('aria-label', 'Assistente'); root.setAttribute('role', 'dialog');
    const head = el('header', 'assistant-head');
    head.append(el('strong', '', 'Assistente'));
    const headActions = el('div', 'assistant-head-actions');
    const fresh = el('button', 'quiet small', 'Nova conversa'); fresh.type='button'; fresh.addEventListener('click',()=>{history.splice(0);saveHistory();log.replaceChildren();});
    const close = el('button', 'quiet small', 'Fechar'); close.type = 'button'; close.addEventListener('click', () => toggle(false));
    headActions.append(fresh,close); head.append(headActions);
    log = el('div', 'assistant-log'); log.setAttribute('aria-live', 'polite');
    const foot = el('div', 'assistant-foot');
    const report = el('button', 'quiet small assistant-report', 'Não funcionou'); report.type = 'button';
    report.addEventListener('click', () => sendReport());
    input = el('textarea', 'assistant-input'); input.rows = 2; input.placeholder = 'Escreva do seu jeito…';
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChat(); } });
    const go = el('button', 'small', 'Enviar'); go.type = 'button'; go.addEventListener('click', () => sendChat());
    const row = el('div', 'assistant-input-row'); row.append(input, go);
    foot.append(report, row);
    root.append(head, log, foot);
    document.body.append(root, fab);
    history.forEach((item) => bubble(item.role, item.content));
    const app = document.getElementById('app-view');
    const sync = () => { fab.hidden = Boolean(app && app.classList.contains('hidden')); if (fab.hidden) toggle(false); };
    if (app) new MutationObserver(sync).observe(app, { attributes: true, attributeFilter: ['class'] });
    sync();
  }
  function toggle(open) {
    build();
    const show = open === undefined ? root.classList.contains('hidden') : open;
    root.classList.toggle('hidden', !show);
    if (show) setTimeout(() => input.focus(), 0);
  }
  document.addEventListener('keydown', (event) => { if (event.altKey && (event.key === 'a' || event.key === 'A')) { event.preventDefault(); toggle(); } });

  function bubble(role, text) {
    const node = el('p', 'assistant-msg ' + role, text);
    log.append(node); log.scrollTop = log.scrollHeight;
    return node;
  }
  async function ask(body, userText) {
    if (busy) return; busy = true;
    if (userText) { bubble('user', userText); history.push({ role: 'user', content: userText }); }
    const thinking = bubble('thinking', 'pensando…');
    let out;
    try { out = await api(body); }
    catch (_) { out = { reply: 'Assistente indisponível agora', proposal: null, unavailable: true }; }
    finally { thinking.remove(); busy = false; }
    const reply = out.reply || 'Não consegui responder agora';
    bubble('assistant', reply);
    history.push({ role: 'assistant', content: reply }); saveHistory();
    if (out.proposal) proposalCard(out.proposal);
  }
  function sendChat(text) {
    const message = String(text !== undefined ? text : input.value).trim();
    if (!message) return;
    if (text === undefined) input.value = '';
    return ask({ action: 'chat', message, history: history.slice(-12), context: context() }, message);
  }
  function sendReport() { return ask({ action: 'report', context: context() }, 'Não funcionou'); }

  // ---------------------------------------------------------------- propostas
  const STALE = new Set(['MANHEIM_SALE_ENDED', 'MANHEIM_MATCH_NOT_FOUND', 'MANHEIM_STAMP_INVALID', 'MANHEIM_OPTION_NOT_SELECTED', 'MANHEIM_SELECTION_LIMIT', 'MANHEIM_DEMAND_NOT_ACTIVE', 'MANHEIM_NO_ACTIVE_BATCH']);
  async function execute(proposal) {
    const b = bridge(), p = proposal.params || {};
    if (proposal.acao === 'abrir_ficha') { b.openDetail('ficha', p.journeyId); return { text: 'Ficha aberta' }; }
    if (proposal.acao === 'abrir_aba') { await b.switchPanel(p.view); return { text: 'Aba aberta' }; }
    if (proposal.acao === 'voltar') { if (b.back) await b.back(); else history.back(); return { text: 'Voltei para a tela anterior' }; }
    if (proposal.acao === 'recarregar') { await b.reload(); return { text: 'Recarregado' }; }
    if (proposal.acao === 'selecionar_carro' || proposal.acao === 'remover_carro') {
      const action = proposal.acao === 'selecionar_carro' ? 'select' : 'remove';
      await b.request('/api/panel/manheim-options', { method: 'POST', body: JSON.stringify({ action, matchId: p.matchId }) });
      return { text: action === 'select' ? 'Carro selecionado' : 'Carro removido da seleção', undo: () => b.request('/api/panel/manheim-options', { method: 'POST', body: JSON.stringify({ action: action === 'select' ? 'remove' : 'select', matchId: p.matchId }) }) };
    }
    if (proposal.acao === 'gerar_v1') {
      const created = await b.request('/api/panel/vitrines', { method: 'POST', body: JSON.stringify({ journeyId: p.journeyId, matchIds: p.matchIds, ...(p.demandKey ? { demandKey: p.demandKey } : {}) }) });
      let info = null;
      try { info = await b.request('/api/panel/v1-send', { method: 'POST', body: JSON.stringify({ action: 'prepare', token: created.token, baseUrl: location.origin, ...(p.demandKey ? { demandKey: p.demandKey } : {}) }) }); } catch (_) { info = null; }
      const phone = info && info.phone ? String(info.phone).replace(/\D/g, '') : '';
      if (phone) { const href = 'https://wa.me/' + phone + '?text=' + encodeURIComponent(info.text || info.link || ''); if (window.MCSWaLink) window.MCSWaLink.open(href); else window.open(href, '_blank', 'noopener'); }
      const removed = created && created.removed && created.removed.length ? ' · Fora da V1 (leilão passado): ' + created.removed.join(', ') : '';
      return { text: (phone ? 'V1 criada · WhatsApp aberto com a mensagem · o envio é você quem faz' : 'V1 criada · Link: ' + (created.link || '')) + removed };
    }
    if (proposal.acao === 'retomar_busca') {
      const keys = Array.isArray(p.demandKeys) ? p.demandKeys : [];
      if (!keys.length) throw Object.assign(new Error('SEM_DEMANDA'), { code: 'SEM_DEMANDA' });
      let compared = 0;
      for (const key of keys) {
        await b.request('/api/panel/manheim-options', { method: 'POST', body: JSON.stringify({ action: 'rematch', key }) });
        compared += 1;
      }
      await b.reload();
      return { text: `Comparado de novo · ${compared} busca(s)` };
    }
    if (proposal.acao === 'registrar_chamado') {
      const out = await api({ action: 'create_incident', context: p.context || context(), note: p.note || '' });
      return { text: (out && out.reply) || 'Chamado registrado' };
    }
    throw Object.assign(new Error('ACAO_DESCONHECIDA'), { code: 'ACAO_DESCONHECIDA' });
  }
  function proposalCard(proposal) {
    const card = el('div', 'assistant-proposal');
    card.append(el('p', 'assistant-proposal-line', proposal.linha));
    const actions = el('div', 'assistant-proposal-actions');
    const yes = el('button', 'small assistant-authorize ' + (proposal.grava ? 'write' : 'screen'), proposal.grava ? 'Autorizar e gravar' : 'Autorizar'); yes.type = 'button';
    const no = el('button', 'quiet small', 'Não'); no.type = 'button';
    const status = el('p', 'muted assistant-proposal-status', '');
    actions.append(yes, no);
    card.append(actions, status);
    log.append(card); log.scrollTop = log.scrollHeight;
    const done = () => { yes.hidden = true; no.hidden = true; card.classList.add('assistant-proposal-done'); };
    yes.addEventListener('click', async () => {
      done(); status.textContent = 'Executando…';
      try {
        const result = await execute(proposal);
        status.textContent = result.text;
        api({ action: 'event', type: 'AUTORIZADA', acao: proposal.acao, payload: proposal, result: result.text }).catch(() => {});
        if (result.undo) {
          const undo = el('button', 'quiet small', 'Desfazer'); undo.type = 'button';
          const timer = setTimeout(() => undo.remove(), 10000);
          undo.addEventListener('click', async () => { clearTimeout(timer); undo.disabled = true; try { await result.undo(); status.textContent = 'Desfeito'; } catch (_) { status.textContent = 'Não consegui desfazer · tente pela tela'; } undo.remove(); });
          actions.append(undo);
        }
      } catch (error) {
        const code = error && error.code || 'FALHOU';
        api({ action: 'event', type: 'AUTORIZADA', acao: proposal.acao, payload: proposal, result: 'erro ' + code }).catch(() => {});
        if (STALE.has(code)) {
          status.textContent = 'Os dados mudaram · não executei · pedindo uma nova proposta';
          sendChat('A ação "' + proposal.linha + '" não foi executada porque os dados mudaram (' + code + '). Leia de novo e refaça a proposta.');
        } else if (code === 'MANHEIM_SELECTION_REASON_REQUIRED') status.textContent = 'Esse carro não é Lane/Run: precisa de um motivo · selecione pela tela';
        else status.textContent = 'Não consegui executar (' + code + ') · nada foi alterado';
      }
    });
    no.addEventListener('click', () => { done(); status.textContent = 'Recusada'; api({ action: 'event', type: 'RECUSADA', acao: proposal.acao, payload: proposal }).catch(() => {}); });
  }

  // ---------------------------------------------------------------- Seus chamados (Configurações)
  const fmtDate = (value) => { try { return new Date(value).toLocaleString('pt-BR', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } };
  function incidentLine(item) {
    const ctx = item.context || {}, actions = Array.isArray(ctx.actions) ? ctx.actions : [];
    let index = -1; for (let i = actions.length - 1; i >= 0; i -= 1) if (actions[i].kind === 'click') { index = i; break; }
    const click = index >= 0 ? actions[index] : null;
    const after = index >= 0 ? actions.slice(index + 1) : [];
    const req = after.filter((a) => a.kind === 'request').pop();
    const err = after.filter((a) => a.kind === 'error').pop();
    const view = ctx.view || (click && click.view) || String(item.fingerprint || '').split('|')[0];
    const diag = item.diagnosis || {};
    return [VIEW_NAMES[view] || view || '—', click ? click.label || click.action : '—', click && EXPECT[click.action] || '—', diag.texto || '—',
      req ? `${req.method || 'GET'} ${req.path} ${req.status || req.code || ''}${req.ms ? ' ' + req.ms + ' ms' : ''}`.trim() : '—', err ? err.message : '—',
      item.last_version || '—', `${item.count || 1} vezes`, item.severity, diag.categoria || '—'].join(' · ');
  }
  let incidentsFilter = 'open', incidentsLimit = 50, incidentsVersion = 0;
  async function renderIncidents() {
    const box = document.getElementById('assistant-incidents');
    if (!box || !bridge()) return;
    const version = ++incidentsVersion;
    box.replaceChildren(el('h2', '', 'Seus chamados'), el('p', 'muted', 'Carregando…'));
    let list = [];
    try { list = (await bridge().request('/api/panel/assistant')).incidents; }
    catch (_) {
      if(version!==incidentsVersion)return;
      const retry=el('button','quiet small','Tentar novamente');retry.type='button';retry.addEventListener('click',()=>renderIncidents());
      box.replaceChildren(el('h2', '', 'Seus chamados'), el('p', 'warning', 'Não consegui carregar os chamados agora'),retry);return;
    }
    if(version!==incidentsVersion)return;
    if(!Array.isArray(list)){const retry=el('button','quiet small','Tentar novamente');retry.type='button';retry.addEventListener('click',()=>renderIncidents());box.replaceChildren(el('h2','','Seus chamados'),el('p','warning','Resposta de chamados inválida'),retry);return;}
    const order = { P0: 0, P1: 1, P2: 2 };
    list.sort((a, b) => (a.status === 'ABERTO' || a.status === 'EM_CORRECAO' ? 0 : 1) - (b.status === 'ABERTO' || b.status === 'EM_CORRECAO' ? 0 : 1) || order[a.severity] - order[b.severity]);
    const open = list.filter((item) => item.status === 'ABERTO' || item.status === 'EM_CORRECAO');
    box.replaceChildren(el('h2', '', 'Seus chamados'), el('p', 'muted', open.length ? `${open.length} aberto(s)` : 'Nenhum chamado aberto'));
    const copy = el('button', 'small', 'Copiar chamados abertos'); copy.type = 'button'; copy.disabled = !open.length;
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(open.map(incidentLine).join('\n')); copy.textContent = 'Copiado'; } catch (_) { copy.textContent = 'Não copiou'; } setTimeout(() => { copy.textContent = 'Copiar chamados abertos'; }, 2000); });
    box.append(copy);
    const STATUS = { ABERTO: 'Aberto', EM_CORRECAO: 'Em correção', CORRIGIDO: 'Corrigido', NAO_ERA_DEFEITO: 'Não era defeito' };
    const filters=el('div','inline-actions');
    [['open','Abertos'],['closed','Encerrados'],['all','Todos']].forEach(([key,label])=>{const button=el('button','quiet small'+(incidentsFilter===key?' active':''),label);button.type='button';button.setAttribute('aria-pressed',String(incidentsFilter===key));button.addEventListener('click',()=>{incidentsFilter=key;incidentsLimit=50;renderIncidents();});filters.append(button);});
    box.append(filters);
    const visible=list.filter((item)=>incidentsFilter==='all'||(incidentsFilter==='open')===(item.status==='ABERTO'||item.status==='EM_CORRECAO'));
    if(!visible.length)box.append(el('p','muted','Nenhum chamado neste filtro'));
    visible.slice(0, incidentsLimit).forEach((item) => {
      const row = el('div', 'assistant-incident');
      row.append(el('strong', '', `${item.severity} · ${STATUS[item.status] || item.status}`), el('span', '', incidentLine(item)), el('span', 'muted', `Último: ${fmtDate(item.last_seen_at)}`));
      if (item.pr_url) { const link = el('a', '', 'PR da correção'); link.href = item.pr_url; link.target = '_blank'; link.rel = 'noopener'; row.append(link); }
      const actions=el('div','inline-actions');
      const change=(label,status)=>{
        const previousStatus=item.status;
        const button=el('button','quiet small',label);button.type='button';
        MCSAction.bind(button,()=>({scope:row,successScope:document.body,feedbackKey:'incident:'+item.id,commit:()=>api({action:'incident_status',id:item.id,status}),successText:status==='ABERTO'?'Chamado reaberto':'Chamado encerrado',refresh:()=>renderIncidents(),undo:{commit:()=>api({action:'incident_status',id:item.id,status:previousStatus}),successText:'Status anterior restaurado',refresh:()=>renderIncidents()}}));
        actions.append(button);
      };
      if(item.status==='ABERTO'||item.status==='EM_CORRECAO'){change('Marcar como corrigido','CORRIGIDO');change('Encerrar sem defeito','NAO_ERA_DEFEITO');}
      else change('Reabrir','ABERTO');
      row.append(actions);
      box.append(row);
    });
    if(visible.length>incidentsLimit){const more=el('button','quiet small',`Mostrar mais (${visible.length-incidentsLimit} restantes)`);more.type='button';more.addEventListener('click',()=>{incidentsLimit+=50;renderIncidents();});box.append(more);}
  }

  window.MCSAssistant = { open: () => toggle(true), close: () => toggle(false), renderIncidents };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
