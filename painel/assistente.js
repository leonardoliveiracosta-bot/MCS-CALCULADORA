// Assistente do painel: aba lateral fixa à direita (no celular, tela cheia). O Leo dá a demanda em
// português e o assistente faz o máximo dentro do painel: lê de verdade, abre telas e, para gravar ou
// enviar, mostra um cartão montado pelo servidor; só o clique em Confirmar/Enviar executa, uma vez.
// - MCSAssistantLog: memória das últimas 20 ações (cliques, pedidos ao servidor, telas, erros) para o
//   "Não funcionou"; falhas (servidor 5xx, rede, erro de tela) vão também para a telemetria do servidor.
// - Teste de botões ("tem algo quebrado?"): roda o painel num quadro escondido em modo teste: navega de
//   verdade e toda gravação ou envio vai em simulação (cabeçalho x-mcs-dry-run), nada é gravado nem
//   enviado; a tela do Leo não muda.
// - "Seus chamados" em Configurações, com "Copiar chamados abertos".
(() => {
  const AUDIT = /[?&]auditoria=1\b/.test(location.search) && window.parent !== window;
  const MAX = 20;
  const buffer = [];
  const push = (entry) => { buffer.push({ ...entry, at: Date.now() }); if (buffer.length > MAX) buffer.shift(); };
  const bridge = () => window.MCSPanelBridge || null;
  const viewNow = () => (bridge() ? bridge().currentView() : null);
  const KNOWN = [[/^Gerar V1/i, 'v1-generate'], [/^Abrir ficha/i, 'ficha-open'], [/^Montar V2/i, 'v2-build'], [/^Enviar/i, 'v1-send'], [/^Selecionar/i, 'select'], [/^Remover/i, 'remove'], [/^Buscar/i, 'search'], [/Importar|CSV/i, 'import-csv'], [/^Atualizar/i, 'refresh']];
  const EXPECT = { 'v1-generate': 'gerar a V1 e abrir o WhatsApp', 'ficha-open': 'abrir a ficha do cliente', 'v2-build': 'abrir a montagem da V2', 'v1-send': 'enviar a mensagem', select: 'selecionar o carro', remove: 'remover o carro da seleção', search: 'buscar', 'import-csv': 'importar o CSV', refresh: 'atualizar a lista', today: 'abrir ATENDER AGORA', v1: 'abrir a aba V1', v2: 'abrir a aba V2', requests: 'abrir BUSCAR CARROS', searches: 'abrir ENVIAR OPÇÕES', imports: 'abrir IMPORTAÇÕES', settings: 'abrir Configurações' };
  const VIEW_NAMES = { today: 'ATENDER AGORA', v1: 'V1', v2: 'V2', requests: 'BUSCAR CARROS', searches: 'ENVIAR OPÇÕES', imports: 'IMPORTAÇÕES', settings: 'Configurações', ficha: 'Ficha' };
  const TAB_NAMES = { today: 'TODOS', v1: 'V1', v2: 'V2', requests: 'BUSCAR CARROS', searches: 'ENVIAR OPÇÕES', imports: 'IMPORTAÇÕES', settings: 'Configurações' };
  function describe(node) {
    const text = String(node.innerText || node.value || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const action = node.dataset.action || node.dataset.offerAction || node.dataset.view || (KNOWN.find(([re]) => re.test(text)) || [])[1] || null;
    return { action: action || 'outro', label: text || action || 'botão sem nome' };
  }
  const lastClick = () => { for (let i = buffer.length - 1; i >= 0; i -= 1) if (buffer[i].kind === 'click') return buffer[i]; return null; };

  // ---------------------------------------------------------------- telemetria (falhas)
  const telemetry = [];
  let telemetryTimer = null;
  const versionOf = () => { const tag = document.querySelector('script[src*="/painel/painel.js"]'); const match = tag && /[?&]v=([^&]+)/.exec(tag.getAttribute('src')); return match ? match[1] : null; };
  function report(entry) {
    if (AUDIT) return;
    const click = lastClick();
    telemetry.push({ ...entry, view: viewNow(), label: click && Date.now() - click.at < 15000 ? click.label : null, version: versionOf() });
    if (telemetry.length > 40) telemetry.shift();
    clearTimeout(telemetryTimer);
    telemetryTimer = setTimeout(() => { const entries = telemetry.splice(0); if (entries.length && bridge()) bridge().request('/api/panel/assistant', { method: 'POST', body: JSON.stringify({ action: 'telemetry', entries }) }).catch(() => {}); }, 8000);
  }
  document.addEventListener('click', (event) => {
    const node = event.target && event.target.closest && event.target.closest('button, a, summary, [role="button"], input[type="checkbox"], select');
    if (!node || node.closest('#mcs-assistant') || node.id === 'mcs-assistant-fab') return;
    push({ kind: 'click', ...describe(node), view: viewNow(), disabled: Boolean(node.disabled) });
  }, true);
  window.addEventListener('error', (event) => { const message = String(event.message || 'erro').slice(0, 300); push({ kind: 'error', message, view: viewNow() }); report({ kind: 'error', message }); });
  window.addEventListener('unhandledrejection', (event) => { const message = String(event.reason && (event.reason.code || event.reason.message) || event.reason || 'erro').slice(0, 300); push({ kind: 'error', message, view: viewNow() }); if (!/REQUEST_ABORTED|AbortError/.test(message)) report({ kind: 'error', message }); });
  window.MCSAssistantLog = {
    request: (entry) => {
      push({ kind: 'request', ...entry });
      if (!/^\/api\/panel\/assistant/.test(String(entry.path || '')) && (Number(entry.status) >= 500 || ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'SERVER_ERROR'].includes(entry.code))) report({ kind: 'request', path: entry.path, method: entry.method, status: entry.status, code: entry.code, ms: entry.ms });
    },
    view: (view) => push({ kind: 'view', view }),
    entries: () => buffer.slice()
  };

  // ---------------------------------------------------------------- modo teste (dentro do quadro do teste de botões)
  function installAuditGuards() {
    // Toda gravação e envio vai em simulação; a sessão e as preferências do Leo nunca mudam daqui.
    const original = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = String((init && init.method) || 'GET').toUpperCase();
      const own = url.startsWith('/') || url.startsWith(location.origin);
      if (!own && method !== 'GET') return Promise.reject(Object.assign(new Error('AUDIT_BLOCKED'), { code: 'AUDIT_BLOCKED' }));
      if (/\/auth\/v1\//.test(url)) return Promise.reject(Object.assign(new Error('AUDIT_BLOCKED'), { code: 'AUDIT_BLOCKED' }));
      if (own && /\/api\//.test(url) && method !== 'GET' && !/\/api\/panel\/boot(\?|$)/.test(url)) init = { ...init, headers: { ...(init.headers || {}), 'x-mcs-dry-run': '1' } };
      return original(input, init);
    };
    const noop = () => {};
    try { Storage.prototype.setItem = noop; Storage.prototype.removeItem = noop; Storage.prototype.clear = noop; } catch (_) {}
    window.open = () => null; window.print = noop; window.alert = noop; window.confirm = () => true; window.prompt = () => null;
    document.addEventListener('click', (event) => {
      const link = event.target && event.target.closest && event.target.closest('a[href]');
      if (link && !/^#/.test(link.getAttribute('href') || '')) event.preventDefault();
    }, true);
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Botões que nunca entram no teste: sair, imprimir/baixar (abrem janelas do sistema), escolher arquivo.
  const SKIP = /\b(sair|logout|pdf|imprimir|baixar|download|exportar|copiar)\b/i;
  async function runAudit(progress = () => {}) {
    const b = bridge();
    const views = ['today', 'v1', 'v2', 'requests', 'searches', 'imports', 'settings'];
    const results = [];
    const requests = [];
    const errors = [];
    const originalLog = window.MCSAssistantLog.request;
    window.MCSAssistantLog.request = (entry) => { requests.push({ ...entry, at: Date.now() }); originalLog(entry); };
    window.addEventListener('error', (event) => errors.push({ at: Date.now(), message: String(event.message || 'erro').slice(0, 200) }));
    const settle = async (since, limit = 9000) => { const end = Date.now() + limit; await sleep(400); while (Date.now() < end) { const pending = document.querySelectorAll('.loading, [aria-busy="true"]').length; const recent = requests.some((r) => r.at > Date.now() - 500); if (!pending && !recent) break; await sleep(300); } };
    const verdict = (since) => {
      const own = requests.filter((r) => r.at >= since);
      const bad = own.find((r) => Number(r.status) >= 500 || ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'SERVER_ERROR', 'RESPONSE_INVALID'].includes(r.code));
      const slow = own.find((r) => Number(r.ms) > 3000);
      const error = errors.find((e) => e.at >= since);
      const shown = (r) => r ? { path: r.path, method: r.method, status: r.status || null, code: r.code || null, ms: r.ms } : null;
      return bad ? { status: 'quebrado', request: shown(bad) } : error ? { status: 'quebrado', error: error.message } : slow ? { status: 'lento', request: shown(slow) } : { status: 'ok', request: shown(own[own.length - 1]) };
    };
    for (const view of views) {
      const since = Date.now();
      await b.switchPanel(view).catch(() => {});
      await settle(since, 15000);
      results.push({ view: TAB_NAMES[view], label: 'Abrir a aba ' + TAB_NAMES[view], ...verdict(since) });
      progress(results.length);
      const panel = document.getElementById(view + '-panel');
      if (!panel) continue;
      const seen = new Set();
      const candidates = [...panel.querySelectorAll('button, summary, [role="button"], select')].filter((node) => {
        const text = String(node.innerText || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (!text || node.disabled || !node.offsetParent || SKIP.test(text) || node.closest('label.v2-drop') || node.matches('input[type="file"]')) return false;
        const key = text.slice(0, 40);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 10);
      for (const node of candidates) {
        const label = String(node.innerText || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const start = Date.now();
        try { if (node.tagName === 'SELECT') { if (node.options.length > 1) { const before = node.selectedIndex; node.selectedIndex = (before + 1) % node.options.length; node.dispatchEvent(new Event('change', { bubbles: true })); await settle(start); node.selectedIndex = before; node.dispatchEvent(new Event('change', { bubbles: true })); } } else node.click(); }
        catch (error) { errors.push({ at: Date.now(), message: String(error && error.message || error).slice(0, 200) }); }
        await settle(start);
        results.push({ view: TAB_NAMES[view], label, ...verdict(start) });
        progress(results.length);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        if (b.currentView() !== view || b.detail()) { await b.switchPanel(view).catch(() => {}); await settle(Date.now(), 8000); }
      }
    }
    window.MCSAssistantLog.request = originalLog;
    const broken = results.filter((r) => r.status === 'quebrado'), slow = results.filter((r) => r.status === 'lento');
    return { testados: results.length, funcionando: results.filter((r) => r.status === 'ok').length, quebrados: broken.length, lentos: slow.length, results: broken.concat(slow).slice(0, 40), simulacao: 'gravações e envios em modo teste: nada foi gravado nem enviado' };
  }

  if (AUDIT) { installAuditGuards(); window.MCSAuditRunner = { run: runAudit }; return; }

  // ---------------------------------------------------------------- janela
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined && text !== null) node.textContent = text; return node; };
  const api = (body) => bridge().request('/api/panel/assistant', { method: 'POST', body: JSON.stringify(body), timeoutMs: 60000 });
  const CHIPS = ['Quem está sem resposta?', 'Resumo de hoje', 'Organizar Sem Ref', 'Quem está pronto para ligar?', 'Pedidos sem busca no Manheim'];
  let root = null, log = null, input = null, ctxLine = null, tray = null, sendButton = null, busy = false;
  const history = [];
  const files = [];          // anexos da conversa: { index, name, mime, size, sha256, base64, url }
  let pendingFiles = [];     // anexos da próxima mensagem
  let lastAudit = null;
  try { (JSON.parse(sessionStorage.getItem('mcs_assistant_history_v2') || '[]') || []).slice(-30).forEach((item) => history.push(item)); } catch (_) {}
  const saveHistory = () => { try { sessionStorage.setItem('mcs_assistant_history_v2', JSON.stringify(history.slice(-30))); } catch (_) {} };

  function seeing() {
    const view = viewNow();
    const detail = bridge() ? bridge().detail() : null;
    if (detail && /^(ficha|order):/.test(detail)) return { view, detail, text: 'Ficha aberta' };
    const counter = document.querySelector(`[data-count="${view}"]`);
    const count = counter && /^\d+$/.test(counter.textContent.trim()) ? Number(counter.textContent.trim()) : null;
    const unit = counter ? counter.dataset.unit || '' : '';
    return { view, detail, count, text: (TAB_NAMES[view] || 'Painel') + (count !== null ? ` · ${count} ${unit}`.trimEnd() : '') };
  }
  function refreshSeeing() { if (!ctxLine) return; ctxLine.replaceChildren(el('span', '', 'Vendo agora: '), el('b', '', seeing().text)); }

  function build() {
    if (root) return;
    const fab = el('button', 'mcs-assistant-fab', 'Assistente'); fab.type = 'button'; fab.id = 'mcs-assistant-fab'; fab.title = 'Assistente (Alt+A)';
    fab.addEventListener('click', () => toggle());
    root = el('aside', 'mcs-assistant hidden'); root.id = 'mcs-assistant'; root.setAttribute('aria-label', 'Assistente');
    const head = el('header', 'assistant-head');
    head.append(el('b', 'assistant-title', 'Assistente'));
    const headActions = el('div', 'assistant-head-actions');
    const fresh = el('button', 'assistant-link', 'Nova conversa'); fresh.type = 'button'; fresh.addEventListener('click', () => reset());
    const close = el('button', 'assistant-close', '✕'); close.type = 'button'; close.setAttribute('aria-label', 'Fechar'); close.addEventListener('click', () => toggle(false));
    headActions.append(fresh, close); head.append(headActions);
    ctxLine = el('div', 'assistant-ctx');
    log = el('div', 'assistant-log'); log.setAttribute('aria-live', 'polite');
    const foot = el('div', 'assistant-foot');
    tray = el('div', 'assistant-tray');
    const row = el('div', 'assistant-input-row');
    const clip = el('button', 'assistant-clip', '📎'); clip.type = 'button'; clip.setAttribute('aria-label', 'Anexar print, foto, ZIP/TXT ou PDF');
    const picker = el('input'); picker.type = 'file'; picker.multiple = true; picker.accept = 'image/*,.pdf,.txt,.zip,application/pdf,text/plain,application/zip'; picker.hidden = true;
    clip.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => { addFiles(picker.files); picker.value = ''; });
    input = el('textarea', 'assistant-input'); input.rows = 1; input.placeholder = 'Escreva do seu jeito…';
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChat(); } });
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });
    input.addEventListener('paste', (event) => { const images = [...(event.clipboardData && event.clipboardData.files || [])].filter((f) => /^image\//.test(f.type)); if (images.length) { event.preventDefault(); addFiles(images); } });
    sendButton = el('button', 'assistant-send', 'Enviar'); sendButton.type = 'button'; sendButton.addEventListener('click', () => sendChat());
    row.append(clip, picker, input, sendButton);
    const reportButton = el('button', 'assistant-report', 'Não funcionou'); reportButton.type = 'button'; reportButton.addEventListener('click', () => sendReport());
    foot.append(tray, row, reportButton);
    root.append(head, ctxLine, log, foot);
    root.addEventListener('dragover', (event) => { event.preventDefault(); });
    root.addEventListener('drop', (event) => { event.preventDefault(); addFiles(event.dataTransfer.files); });
    document.body.append(root, fab);
    if (history.length) history.forEach((item) => (item.role === 'user' ? bubble('me', item.content) : bubble('ai', item.content))); else welcome();
    const app = document.getElementById('app-view');
    const sync = () => { fab.hidden = Boolean(app && app.classList.contains('hidden')); if (fab.hidden) toggle(false); };
    if (app) new MutationObserver(sync).observe(app, { attributes: true, attributeFilter: ['class'] });
    sync();
    const observeTitle = document.getElementById('page-title');
    if (observeTitle) new MutationObserver(refreshSeeing).observe(observeTitle, { childList: true, characterData: true, subtree: true });
    document.querySelectorAll('[data-count]').forEach((node) => new MutationObserver(refreshSeeing).observe(node, { childList: true, characterData: true, subtree: true }));
    refreshSeeing();
  }
  function welcome() {
    log.append(el('div', 'assistant-ai', 'Oi Leo, o que você precisa?'));
    const chips = el('div', 'assistant-chips');
    CHIPS.forEach((text) => { const chip = el('button', 'assistant-chip', text); chip.type = 'button'; chip.addEventListener('click', () => sendChat(text)); chips.append(chip); });
    log.append(chips);
  }
  function reset() {
    history.splice(0); saveHistory(); files.splice(0); pendingFiles = []; lastAudit = null; paintTray();
    log.replaceChildren(); welcome();
  }
  function toggle(open) {
    build();
    const show = open === undefined ? root.classList.contains('hidden') : open;
    root.classList.toggle('hidden', !show);
    document.documentElement.classList.toggle('mcs-assistant-open', show);
    if (show) { refreshSeeing(); setTimeout(() => input.focus(), 0); }
  }
  document.addEventListener('keydown', (event) => { if (event.altKey && (event.key === 'a' || event.key === 'A')) { event.preventDefault(); toggle(); } });
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  function bubble(kind, text) { const node = el('div', kind === 'me' ? 'assistant-me' : 'assistant-ai', text); log.append(node); scroll(); return node; }
  function stepLine(text, container = log) { const node = el('div', 'assistant-tool', text); container.append(node); scroll(); return node; }

  // ---------------------------------------------------------------- anexos
  const toBase64 = (buffer) => { let binary = ''; const bytes = new Uint8Array(buffer); for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(binary); };
  const sha256 = async (buffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map((b) => b.toString(16).padStart(2, '0')).join('');
  // Foto e print saem reduzidos (lado maior 2000 px, JPEG): legíveis e leves.
  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp|heic|heif)/i.test(file.type) || file.size < 400 * 1024) return { blob: file, name: file.name || 'imagem.png', mime: file.type || 'image/png' };
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return { blob: file, name: file.name, mime: file.type };
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return { blob: blob || file, name: String(file.name || 'imagem').replace(/\.[a-z0-9]+$/i, '') + '.jpg', mime: blob ? 'image/jpeg' : file.type };
  }
  async function addFiles(list) {
    for (const file of [...(list || [])].slice(0, 10)) {
      if (!/^image\//.test(file.type) && !/\.(pdf|txt|zip)$/i.test(file.name || '') && !/pdf|text\/plain|zip/.test(file.type)) { stepLine(`${file.name}: só print, foto, PDF, TXT ou ZIP`); continue; }
      const shrunk = await shrink(file);
      const buffer = await shrunk.blob.arrayBuffer();
      if (buffer.byteLength > 3 * 1024 * 1024) { stepLine(`${shrunk.name}: passa de 3 MB, mande menor`); continue; }
      const mime = shrunk.mime || (/\.pdf$/i.test(shrunk.name) ? 'application/pdf' : /\.zip$/i.test(shrunk.name) ? 'application/zip' : 'text/plain');
      pendingFiles.push({ name: shrunk.name || 'arquivo', mime, size: buffer.byteLength, base64: toBase64(buffer), sha256: await sha256(buffer), url: /^image\//.test(mime) ? URL.createObjectURL(shrunk.blob) : null });
    }
    paintTray();
  }
  function paintTray() {
    if (!tray) return;
    tray.replaceChildren();
    pendingFiles.forEach((file, index) => {
      const chip = el('div', 'assistant-att');
      chip.append(file.url ? Object.assign(el('img', 'assistant-thumb'), { src: file.url, alt: '' }) : el('span', 'assistant-thumb assistant-thumb-doc', /\.zip$/i.test(file.name) ? 'ZIP' : /\.pdf$/i.test(file.name) ? 'PDF' : 'TXT'), el('span', 'assistant-att-name', file.name));
      const remove = el('button', 'assistant-att-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Tirar anexo'); remove.addEventListener('click', () => { pendingFiles.splice(index, 1); paintTray(); });
      chip.append(remove); tray.append(chip);
    });
  }
  const filesMeta = () => files.map((f) => ({ index: f.index, name: f.name, mime: f.mime, size: f.size, sha256: f.sha256 }));

  // ---------------------------------------------------------------- conversa
  async function stream(body, onStep) {
    const response = await bridge().authFetch('/api/panel/assistant', { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok || !response.body) throw Object.assign(new Error('ASSISTANT_FAILED'), { code: response.status === 401 ? 'AUTH' : 'ASSISTANT_FAILED' });
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let rest = '', final = null;
    for (;;) {
      const { value, done } = await reader.read();
      rest += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = rest.split('\n'); rest = lines.pop();
      for (const line of lines) { if (!line.trim()) continue; let item; try { item = JSON.parse(line); } catch (_) { continue; } if (item.type === 'step') onStep(item.text); if (item.type === 'final') final = item; }
      if (done) break;
    }
    if (rest.trim()) { try { const item = JSON.parse(rest); if (item.type === 'final') final = item; } catch (_) {} }
    if (!final) throw Object.assign(new Error('ASSISTANT_FAILED'), { code: 'ASSISTANT_FAILED' });
    return final;
  }
  async function ask({ message, auditResults = null }) {
    if (busy) return; busy = true; sendButton.disabled = true;
    const attachments = pendingFiles.splice(0).map((file) => { const index = files.length + 1; const entry = { ...file, index }; files.push(entry); return entry; });
    paintTray();
    if (message) {
      const me = bubble('me', message);
      attachments.forEach((file) => { const att = el('div', 'assistant-att assistant-att-sent'); att.append(file.url ? Object.assign(el('img', 'assistant-thumb'), { src: file.url, alt: '' }) : el('span', 'assistant-thumb assistant-thumb-doc', 'DOC'), el('span', 'assistant-att-name', file.name)); me.before(att); });
      history.push({ role: 'user', content: message + (attachments.length ? ` [anexos: ${attachments.map((f) => f.index + ' ' + f.name).join(', ')}]` : '') });
    }
    const steps = el('div', 'assistant-steps'); log.append(steps);
    const thinking = stepLine('pensando…', steps); thinking.classList.add('assistant-thinking');
    const view = seeing();
    let out;
    try {
      out = await stream({ action: 'chat', message, auditResults, history: history.slice(-13, message ? -1 : undefined), baseUrl: location.origin,
        context: { view: view.view, detail: view.detail, count: view.count, version: versionOf(), attachments: filesMeta() },
        attachments: attachments.map((f) => ({ index: f.index, name: f.name, mime: f.mime, base64: f.base64 })) }, (text) => { steps.insertBefore(el('div', 'assistant-tool', text), thinking); scroll(); });
    } catch (error) { out = { reply: error.code === 'AUTH' ? 'Sua sessão expirou · entre de novo' : 'Assistente indisponível agora · tente de novo', blocks: [] }; }
    finally { thinking.remove(); busy = false; sendButton.disabled = false; }
    render(out);
    if (out.clientTask === 'audit_buttons') await buttonAudit();
  }
  function render(out) {
    const reply = out.reply || 'Não consegui responder agora';
    bubble('ai', reply);
    history.push({ role: 'assistant', content: reply }); saveHistory();
    (out.blocks || []).forEach((block) => {
      if (block.type === 'leads') leadList(block);
      if (block.type === 'proposal') proposalCard(block);
      if (block.type === 'open') openNow(block);
    });
    if (out.report) reportButton();
    scroll();
  }
  function sendChat(text) {
    const message = String(text !== undefined ? text : input.value).trim();
    if (!message && !pendingFiles.length) return;
    if (text === undefined) { input.value = ''; input.style.height = 'auto'; }
    return ask({ message: message || 'Veja o anexo' });
  }
  async function sendReport() {
    if (busy) return;
    bubble('me', 'Não funcionou');
    let out;
    try { out = await api({ action: 'report', context: { view: viewNow(), detail: bridge() ? bridge().detail() : null, version: versionOf(), actions: buffer.slice() } }); }
    catch (_) { out = { reply: 'Não consegui registrar agora · tente de novo' }; }
    bubble('ai', out.reply || 'Registrado');
  }

  // ---------------------------------------------------------------- blocos
  const TONES = { vermelho: 'red', amarelo: 'gold', verde: 'green' };
  function leadList(block) {
    const box = el('div', 'assistant-leads');
    if (block.title) box.append(el('div', 'assistant-leads-title', block.title));
    (block.items || []).forEach((item) => {
      const row = el('button', 'assistant-row'); row.type = 'button';
      const [first, ...rest] = String(item.line || '').split(' · ');
      const phone = rest.length ? rest.pop() : '';
      row.append(el('span', 'assistant-row-name', [first, ...rest].join(' · ')));
      if (item.badge) row.append(el('span', 'assistant-badge ' + (TONES[item.tone] || 'red'), item.badge));
      row.append(el('span', 'assistant-row-tel', phone));
      if (item.detail) row.append(el('span', 'assistant-row-car', item.detail));
      row.addEventListener('click', () => { if (item.journeyId) bridge().openDetail('ficha', item.journeyId); });
      box.append(row);
    });
    if ((block.items || []).length) box.append(el('div', 'assistant-hint', 'Toque num lead para abrir a ficha'));
    log.append(box);
  }
  function openNow(block) {
    const b = bridge();
    if (block.journeyId) b.openDetail('ficha', block.journeyId); else if (block.view) b.switchPanel(block.view);
  }
  function proposalCard(block) {
    const card = el('div', 'assistant-confirm');
    card.append(el('div', 'assistant-confirm-label', block.title));
    const list = el('ul', 'assistant-confirm-list');
    (block.lines || []).forEach((line) => list.append(el('li', '', line)));
    card.append(list);
    const actions = el('div', 'assistant-btns');
    const yes = el('button', 'assistant-btn primary', block.button || 'Confirmar'); yes.type = 'button';
    const no = el('button', 'assistant-btn secondary', 'Cancelar'); no.type = 'button';
    actions.append(yes, no); card.append(actions);
    log.append(card); scroll();
    const lock = () => { yes.disabled = true; no.disabled = true; };
    yes.addEventListener('click', async () => {
      if (yes.disabled) return;
      lock();
      // A aba do WhatsApp é reservada no clique (depois de esperar o servidor o navegador bloquearia).
      const reserved = block.opensWhatsApp && window.MCSWaLink && MCSWaLink.reserve ? MCSWaLink.reserve() : null;
      const status = el('div', 'assistant-status', 'Fazendo…'); card.after(status); scroll();
      let out;
      try { out = await api({ action: 'confirm', id: block.id, baseUrl: location.origin, files: (block.files || []).map((index) => files.find((f) => f.index === index)).filter(Boolean).map((f) => ({ index: f.index, base64: f.base64 })) }); }
      catch (error) { out = { ok: false, text: 'Não consegui fazer agora · nada foi alterado' }; }
      card.classList.add('done');
      status.className = out.ok ? 'assistant-ok' : 'assistant-fail';
      status.textContent = (out.ok ? '✓ ' : '') + (out.text || (out.ok ? 'Feito' : 'Não deu certo'));
      if (out.link) { const link = el('a', 'assistant-ok-link', out.linkLabel || 'Abrir'); link.href = out.link; link.target = '_blank'; link.rel = 'noopener'; status.append(' · ', link); }
      if (out.whatsappLink && window.MCSWaLink) MCSWaLink.open(out.whatsappLink, window, reserved);
      else if (out.whatsappLink) window.open(out.whatsappLink, '_blank', 'noopener');
      else if (reserved && window.MCSWaLink && MCSWaLink.release) MCSWaLink.release(reserved);
      if (out.pdf) bridge().printVitrine(out.pdf.data, out.pdf.ref).catch(() => { status.textContent = 'O PDF não abriu · tente de novo'; });
      if (out.open && out.open.journeyId) bridge().openDetail('ficha', out.open.journeyId);
      if (out.ok) bridge().reload().catch(() => {});
      scroll();
    });
    no.addEventListener('click', async () => {
      lock(); card.classList.add('done');
      const out = await api({ action: 'cancel', id: block.id }).catch(() => ({ text: 'Cancelado' }));
      card.after(el('div', 'assistant-tool', out.text || 'Cancelado · nada foi feito'));
    });
  }
  function reportButton() {
    const actions = el('div', 'assistant-btns');
    const button = el('button', 'assistant-btn primary', 'Gerar relatório para corrigir'); button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const out = await api({ action: 'audit_report', buttons: lastAudit, version: versionOf() });
        try { await navigator.clipboard.writeText(out.text); button.textContent = 'Relatório copiado · cole no Claude ou no GPT'; }
        catch (_) { const box = el('textarea', 'assistant-report-text'); box.value = out.text; box.readOnly = true; actions.after(box); box.select(); button.textContent = 'Copie o texto abaixo'; }
      } catch (_) { button.textContent = 'Não consegui gerar · tente de novo'; button.disabled = false; }
    });
    actions.append(button); log.append(actions);
  }

  // ---------------------------------------------------------------- teste de botões (quadro escondido, modo teste)
  async function buttonAudit() {
    const line = stepLine('Abrindo o painel em modo teste…');
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;left:-12000px;top:0;width:1280px;height:900px;border:0;opacity:0;pointer-events:none';
    frame.src = '/painel/?auditoria=1' + location.hash;
    document.body.append(frame);
    let results;
    try {
      await new Promise((resolve, reject) => { frame.onload = resolve; setTimeout(() => reject(new Error('AUDIT_LOAD_TIMEOUT')), 60000); });
      const ready = Date.now() + 90000;
      while (Date.now() < ready) { const w = frame.contentWindow; const app = w && w.document.getElementById('app-view'); if (w && w.MCSAuditRunner && w.MCSPanelBridge && app && !app.classList.contains('hidden')) break; await sleep(500); }
      const runner = frame.contentWindow && frame.contentWindow.MCSAuditRunner;
      if (!runner) throw new Error('AUDIT_NOT_READY');
      // Um botão que recarregue o quadro acabaria com o teste: limite de tempo e recarga viram fim do teste.
      const reloaded = new Promise((_, reject) => { frame.onload = () => reject(new Error('AUDIT_FRAME_RELOADED')); });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('AUDIT_TIMEOUT')), 240000));
      results = await Promise.race([runner.run((n) => { line.textContent = `Testando botões em modo teste · ${n} testados`; }), reloaded, timeout]);
      line.textContent = `Testei ${results.testados} botões em modo teste · nada foi enviado`;
    } catch (error) {
      results = { erro: 'o teste de botões não abriu (' + String(error && error.message || error) + ')' };
      line.textContent = 'Não consegui abrir o painel em modo teste';
    } finally { frame.remove(); }
    lastAudit = results;
    await ask({ message: '', auditResults: results });
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
