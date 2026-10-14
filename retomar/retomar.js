// RETOMAR: clients who wrote more than 15 days ago without a reply, each with the 3 messages ready. The operator sends
// one part at a time (WhatsApp Web, QR code for the phone, SMS); the part reached is saved on the server, so another
// device continues from the same point. The page uses the panel's login (same browser session, same refresh lock).
(function retomarPage() {
  'use strict';
  const SESSION_KEY = 'mcs_panel_session';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined && text !== null) node.textContent = text; return node; };
  const isPhone = () => window.MCSWaLink ? window.MCSWaLink.isPhone(navigator) : /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  const Msg = window.MCSRetomarMensagens, Hour = window.MCSHorario;
  const LANG_LABEL = { en: 'Inglês', pt: 'Português', es: 'Espanhol' };
  const PART_LABEL = ['Desculpas', 'Como compramos', 'Opções'];
  const FILTERS = [['todo', 'A fazer'], ['doing', 'Em andamento'], ['replied', 'Responderam'], ['done', 'Concluídos']];
  // One filter: channel and order together (Leo, 13/10).
  const VIEWS = [['recent', 'Mais recentes', null, -1], ['oldest', 'Mais antigos', null, 1], ['sms_recent', 'SMS mais recentes', 'SMS', -1], ['sms_oldest', 'SMS mais antigos', 'SMS', 1], ['wa_recent', 'WhatsApp mais recentes', 'WHATSAPP', -1], ['wa_oldest', 'WhatsApp mais antigos', 'WHATSAPP', 1]];
  const VIEW_KEY = 'mcs_retomar_view';
  let view = 'recent';
  try { const saved = localStorage.getItem(VIEW_KEY); if (VIEWS.some(([key]) => key === saved)) view = saved; } catch (_) {}
  const at = (item) => Date.parse(item.lastCustomerAt || '') || 0;
  let config = null, data = null, filter = 'todo', origin = 'CALCULADORA', readyOnly = true, loadedAt = 0;
  const items = new Map();

  // ------------------------------------------------------------------ sessão (a mesma do painel)
  const stored = () => { try { const value = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); return value && value.accessToken ? value : null; } catch (_) { return null; } };
  const lock = (work) => { try { if (navigator.locks && navigator.locks.request) return navigator.locks.request('mcs-panel-refresh', work); } catch (_) {} return work(); };
  async function loadConfig() { if (!config) { const response = await fetch('/api/panel/config'); config = await response.json(); } return config; }
  async function refresh(usedToken) {
    return lock(async () => {
      const now = stored();
      // Another tab (the panel) already renewed: use what it saved.
      if (now && now.accessToken !== usedToken && Number(now.accessExpiresAt) > Date.now()) return true;
      if (!now || !now.refreshToken) return false;
      const cfg = await loadConfig();
      const response = await fetch(cfg.url + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: cfg.publishableKey, 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: now.refreshToken }) });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok || !answer.access_token) return false;
      localStorage.setItem(SESSION_KEY, JSON.stringify({ accessToken: answer.access_token, refreshToken: answer.refresh_token || now.refreshToken, accessExpiresAt: Date.now() + Math.max(0, Number(answer.expires_in || 3600) - 60) * 1000 }));
      return true;
    });
  }
  async function request(path, options = {}, retried = false) {
    const session = stored();
    if (!session) throw Object.assign(new Error('LOGIN'), { code: 'LOGIN' });
    if (!retried && Number(session.accessExpiresAt) < Date.now()) await refresh(session.accessToken).catch(() => false);
    const token = (stored() || session).accessToken;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 45000);
    let response;
    try { response = await fetch(path, { ...options, signal: controller.signal, headers: { 'content-type': 'application/json', ...(options.headers || {}), authorization: 'Bearer ' + token } }); }
    finally { clearTimeout(timer); }
    if (response.status === 401 && !retried && await refresh(token).catch(() => false)) return request(path, options, true);
    if (response.status === 401) throw Object.assign(new Error('LOGIN'), { code: 'LOGIN' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || 'REQUEST_FAILED'), { code: body.error || 'REQUEST_FAILED', status: response.status });
    return body;
  }
  const post = (body) => request('/api/panel/retomar', { method: 'POST', body: JSON.stringify(body) });

  // ------------------------------------------------------------------ estado de cada cliente
  const stateOf = (item) => {
    const progress = item.progress;
    if (progress && progress.replied) return 'replied';
    if (progress && progress.partsSent >= 3) return 'done';
    if (progress && progress.partsSent > 0) return 'doing';
    return 'todo';
  };
  const langOf = (item) => item.uiLang || (item.progress && item.progress.lang) || item.language || 'en';
  const daysText = (days) => days === 1 ? 'há 1 dia' : `há ${days} dias`;
  // The texts shown before anything is saved: the same module the server uses (the link is added when preparing).
  const previewTexts = (item, lang) => Msg.sequence({ lang, name: item.name, link: item.options ? 'https://www.mycarscout.net/o/…' : null, car: item.car });
  const textsOf = (item) => {
    const progress = item.progress;
    if (progress && progress.texts && (progress.partsSent > 0 || progress.lang === langOf(item))) return progress.texts;
    return previewTexts(item, langOf(item));
  };
  const started = (item) => Boolean(item.progress && item.progress.partsSent > 0);

  // ------------------------------------------------------------------ envio
  const digits = (phone) => String(phone || '').replace(/\D/g, '');
  const waHref = (item, text) => 'https://wa.me/' + digits(item.phone) + '?text=' + encodeURIComponent(text);
  async function prepared(item) {
    const progress = item.progress;
    if (progress && progress.texts && (progress.partsSent > 0 || progress.lang === langOf(item))) return progress;
    const out = await post({ action: 'prepare', journeyId: item.journeyId, channel: item.channel, lang: langOf(item), optionsKey: item.options ? item.options.key : null, car: item.car });
    item.progress = { ...(item.progress || {}), ...out.progress };
    return item.progress;
  }
  async function saveStep(item, parts) {
    const out = await post({ action: 'step', journeyId: item.journeyId, parts });
    item.progress = { ...item.progress, ...out.progress, detected: (item.progress && item.progress.detected) || [false, false, false], replied: Boolean(item.progress && item.progress.replied) };
    if (out.resultError) item.resultError = out.resultError;
    return out;
  }
  // how: 'web' (WhatsApp Web / Messages on this computer), 'qr' (phone camera), 'phone' (this phone).
  async function send(item, how, say) {
    const next = (item.progress ? item.progress.partsSent : 0) + 1;
    if (next > 3) return;
    const reserved = how === 'web' && item.channel === 'WHATSAPP' && next === 1 && window.MCSWaLink ? window.MCSWaLink.reserve() : null;
    try {
      const progress = await prepared(item);
      const text = progress.texts[next - 1];
      // On the phone the page leaves for WhatsApp or Messages: the part is saved before leaving.
      if (how === 'phone') {
        await saveStep(item, next);
        if (item.channel === 'SMS') { await window.MCSWaHandoff.recordSms(request, item.journeyId, text, null); window.location.href = window.MCSWaHandoff.smsUrl(item.phone, text); }
        else window.MCSWaLink.open(waHref(item, text), window);
        return;
      }
      if (item.channel === 'WHATSAPP') {
        const href = waHref(item, text);
        if (how === 'qr') window.MCSWaHandoff.openModal(href, request);
        else if (next === 1 && reserved) window.MCSWaLink.open(href, window, reserved);
        else { const out = await window.MCSWaLink.sendPart({ href, text, index: next, total: 3 }); say(out.message || ''); }
      } else {
        const href = window.MCSWaHandoff.smsUrl(item.phone, text);
        if (how === 'qr') window.MCSWaHandoff.openModal(href, request, { sms: true });
        else window.location.href = href;
        // The SMS is recorded in the conversation (the panel sees the client was contacted), as the panel does.
        window.MCSWaHandoff.recordSms(request, item.journeyId, text, null);
      }
      await saveStep(item, next);
      if (next === 3) say(item.resultError ? 'Sequência concluída, mas não consegui gravar o resultado na ficha · marque "Opções enviadas" no painel' : 'Sequência concluída · "Opções enviadas" registrado na ficha');
    } catch (failure) {
      if (window.MCSWaLink && reserved) window.MCSWaLink.release(reserved);
      say(failure && failure.code === 'LOGIN' ? 'Sua sessão acabou · entre de novo pelo painel' : 'Não consegui preparar a mensagem agora · tente de novo');
    }
  }

  // ------------------------------------------------------------------ cartão
  function card(item) {
    const node = el('article', 'card');
    node.dataset.journey = item.journeyId;
    const render = () => {
      node.replaceChildren();
      const state = stateOf(item);
      node.classList.toggle('is-replied', state === 'replied');
      const head = el('div', 'card-head');
      const title = el('div');
      title.append(el('h2', '', item.name || 'Contato sem nome'));
      const meta = el('div', 'meta');
      meta.append(el('span', 'badge ' + (item.channel === 'SMS' ? 'sms' : 'wa'), item.channel === 'SMS' ? 'SMS' : 'WhatsApp'));
      if (item.purchaseWindow === 'NOW') meta.append(el('span', 'badge ready', 'Pronto para comprar agora'));
      if (item.ref) meta.append(el('span', '', 'Ref ' + item.ref));
      meta.append(el('span', '', 'escreveu ' + daysText(item.days)));
      title.append(meta);
      const open = el('a', 'quiet', 'Abrir no painel'); open.href = '/painel/#ficha/' + encodeURIComponent(item.journeyId); open.target = '_blank'; open.rel = 'noopener';
      head.append(title, open);
      node.append(head);
      if (item.lastMessage) node.append(el('p', 'quote', item.lastMessage));
      const hour = Hour.check(item.phone);
      if (hour.known) node.append(el('p', 'line' + (hour.allowed ? '' : ' warn'), hour.allowed ? `Horário do cliente: ${hour.local}` : `Fora do horário do cliente (são ${hour.local} lá) · envio liberado das 8:00 às 20:00 do horário dele`));
      node.append(el('p', 'line', item.options ? `${item.options.count} ${item.options.count === 1 ? 'opção' : 'opções'} no lote · a mensagem 3 leva o link das opções` : item.optionsKnown ? 'Sem opções no lote · a mensagem 3 pede o carro e o valor' : 'Não consegui ler as opções agora · a mensagem 3 pede o carro e o valor'));
      if (state === 'replied') {
        node.append(el('p', 'line ok', 'Respondeu · continue a conversa pelo painel'));
        // What to answer, by what the client said, in his language (Leo, 14/10). Each with Copiar.
        Msg.replies(langOf(item)).forEach((reply) => {
          const box = el('div', 'part');
          const copy = el('button', 'quiet', 'Copiar');
          copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(reply.text); copy.textContent = 'Copiado'; } catch (_) { copy.textContent = 'Não copiou'; } });
          const top = el('div', 'part-head'); top.append(el('span', '', reply.label), copy);
          box.append(top, el('p', 'part-text', reply.text));
          node.append(box);
        });
      }
      if (state === 'done') node.append(el('p', 'line ok', item.progress.resultRecorded ? 'Concluído · "Opções enviadas" registrado na ficha' : 'Concluído · o resultado não foi gravado: marque "Opções enviadas" no painel'));
      // Language: chosen before the first part; after that the texts are fixed.
      const langRow = el('div', 'actions');
      const select = el('select'); select.setAttribute('aria-label', 'Idioma');
      Msg.LANGS.forEach((lang) => { const option = el('option', '', LANG_LABEL[lang]); option.value = lang; select.append(option); });
      select.value = langOf(item); select.disabled = started(item);
      select.addEventListener('change', () => { item.uiLang = select.value; render(); });
      langRow.append(el('span', 'say', item.languageDetected ? 'Idioma do cliente' : 'Idioma (não identificado)'), select);
      node.append(langRow);
      const texts = textsOf(item), sent = item.progress ? item.progress.partsSent : 0;
      const detected = (item.progress && item.progress.detected) || [];
      const review = langOf(item) !== 'pt' && item.showReview ? Msg.review({ name: item.name, link: item.progress && item.progress.link || (item.options ? 'https://www.mycarscout.net/o/…' : null), car: item.car }) : null;
      const parts = el('ol', 'parts');
      texts.forEach((text, index) => {
        const part = el('li', 'part' + (index < sent ? ' is-sent' : index === sent && state !== 'replied' ? ' is-next' : ''));
        const top = el('div', 'part-head');
        top.append(el('span', '', `${index + 1} de 3 · ${PART_LABEL[index]}`));
        if (index < sent) top.append(el('span', 'part-state', detected[index] ? '✓ enviada · confirmada na conversa' : '✓ enviada'));
        part.append(top, el('p', 'part-text', text));
        if (review) part.append(el('p', 'part-review', review[index]));
        parts.append(part);
      });
      node.append(parts);
      const say = el('p', 'say', item.say || '');
      const talk = (message) => { item.say = message; say.textContent = message; };
      const actions = el('div', 'actions');
      const blocked = !hour.allowed || state === 'replied';
      const busy = (button, work) => button.addEventListener('click', async () => { button.disabled = true; try { await work(talk); } finally { render(); } });
      if (sent < 3) {
        const next = sent + 1;
        if (item.channel === 'WHATSAPP') {
          if (isPhone()) { const go = el('button', 'wa', `Enviar parte ${next} no WhatsApp`); go.disabled = blocked; busy(go, (t) => send(item, 'phone', t)); actions.append(go); }
          else {
            const web = el('button', 'wa', `Parte ${next} no WhatsApp Web`); web.disabled = blocked; busy(web, (t) => send(item, 'web', t));
            const qr = el('button', '', `Parte ${next} no celular (QR)`); qr.disabled = blocked; busy(qr, (t) => send(item, 'qr', t));
            actions.append(web, qr);
          }
        } else if (isPhone()) { const go = el('button', 'primary', `Enviar parte ${next} por SMS`); go.disabled = blocked; busy(go, (t) => send(item, 'phone', t)); actions.append(go); }
        else {
          const qr = el('button', 'primary', `Parte ${next} por SMS no celular (QR)`); qr.disabled = blocked; busy(qr, (t) => send(item, 'qr', t));
          const web = el('button', '', `Parte ${next} no computador`); web.disabled = blocked; busy(web, (t) => send(item, 'web', t));
          actions.append(qr, web);
        }
      }
      if (sent > 0 && state !== 'replied') {
        const back = el('button', 'quiet', '◀ Voltar uma parte');
        busy(back, async (t) => { try { await saveStep(item, sent - 1); t('Voltou para a parte ' + sent); } catch (_) { t('Não consegui voltar agora · tente de novo'); } });
        actions.append(back);
      }
      if (langOf(item) !== 'pt') {
        const toggle = el('button', 'quiet', item.showReview ? 'Esconder português' : 'Ver em português');
        toggle.addEventListener('click', () => { item.showReview = !item.showReview; render(); });
        actions.append(toggle);
      }
      node.append(actions, say);
    };
    render();
    return node;
  }

  // ------------------------------------------------------------------ lista
  function renderList() {
    const app = $('app');
    app.replaceChildren();
    const every = data.items.map((item) => items.get(item.journeyId) || item);
    // Origin first (Leo, 13/10: for now only the clients who came by the site's calculator). Unknown origin shows in both.
    const originCount = (key) => every.filter((item) => item.origin === key).length;
    const byOrigin = every.filter((item) => item.origin === null || item.origin === undefined || item.origin === origin);
    // Ready to buy now first (Leo, 14/10): the client who marked it in the calculator. Unknown window shows in both.
    const isReady = (item) => item.purchaseWindow === 'NOW' || item.purchaseWindow == null;
    const all = readyOnly ? byOrigin.filter(isReady) : byOrigin;
    const counts = {}; FILTERS.forEach(([key]) => { counts[key] = 0; });
    all.forEach((item) => { counts[stateOf(item)] += 1; });
    const nav = $('filters'); nav.hidden = false; nav.replaceChildren();
    [['CALCULADORA', 'Calculadora do site'], ['OUTRA', 'Outras origens']].forEach(([key, label]) => { const chip = el('button', 'chip origin', `${label} (${originCount(key)})`); chip.setAttribute('aria-pressed', String(origin === key)); chip.addEventListener('click', () => { origin = key; renderList(); }); nav.append(chip); });
    nav.append(el('span', 'chip-gap'));
    [[true, `Prontos para comprar agora (${byOrigin.filter(isReady).length})`], [false, `Todos os prazos (${byOrigin.length})`]].forEach(([key, label]) => { const chip = el('button', 'chip ready', label); chip.setAttribute('aria-pressed', String(readyOnly === key)); chip.addEventListener('click', () => { readyOnly = key; renderList(); }); nav.append(chip); });
    nav.append(el('span', 'chip-gap'));
    FILTERS.forEach(([key, label]) => { const chip = el('button', 'chip', `${label} (${counts[key]})`); chip.setAttribute('aria-pressed', String(filter === key)); chip.addEventListener('click', () => { filter = key; renderList(); }); nav.append(chip); });
    const stats = $('stats'); stats.hidden = false; stats.replaceChildren();
    const stat = (value, label) => { const span = el('span'); span.append(el('strong', '', String(value)), document.createTextNode(' ' + label)); stats.append(span); };
    stat(counts.todo, 'a fazer'); stat(data.today.started, 'iniciados hoje'); stat(data.today.completed, 'concluídos hoje');
    stats.append(el('span', 'muted', 'Sugestão: até 25 conversas novas por dia, começando pelos mais recentes'));
    if (every.length && every.every((item) => item.origin == null)) stats.append(el('span', 'line warn', 'Não consegui ler a origem agora · mostrando todos os clientes'));
    const order = el('select', 'sort'); order.setAttribute('aria-label', 'Filtrar e ordenar');
    VIEWS.forEach(([key, label]) => { const option = el('option', '', label); option.value = key; order.append(option); });
    order.value = view;
    order.addEventListener('change', () => { view = order.value; try { localStorage.setItem(VIEW_KEY, view); } catch (_) {} renderList(); });
    nav.append(order);
    const [, , only, direction] = VIEWS.find(([key]) => key === view);
    const shown = all.filter((item) => stateOf(item) === filter && (!only || item.channel === only)).sort((a, b) => direction * (at(a) - at(b)));
    if (!shown.length) { app.append(el('p', 'muted empty', 'Nenhum cliente aqui')); return; }
    shown.forEach((item) => app.append(card(item)));
  }

  async function load() {
    const status = $('status');
    if (!stored()) {
      const box = el('div', 'notice');
      box.append(el('p', '', 'Entre no painel neste navegador e volte para esta página.'));
      const link = el('a', 'button', 'Entrar pelo painel'); link.href = '/painel/'; link.target = '_blank'; link.rel = 'noopener';
      box.append(link);
      $('app').replaceChildren(box);
      window.addEventListener('storage', (event) => { if (event.key === SESSION_KEY && event.newValue) load(); }, { once: true });
      return;
    }
    if (status) status.textContent = 'Carregando a lista (pode levar alguns segundos)…';
    try {
      const fresh = await request('/api/panel/retomar', { method: 'GET' });
      loadedAt = Date.now();
      // What the operator chose on this page (language, Portuguese view) stays after a new read.
      fresh.items.forEach((item) => { const before = items.get(item.journeyId); if (before) { item.uiLang = before.uiLang; item.showReview = before.showReview; } });
      data = fresh;
      items.clear(); data.items.forEach((item) => items.set(item.journeyId, item));
      $('summary').textContent = `Clientes que escreveram há mais de ${data.minDays} dias e ainda não tiveram resposta`;
      renderList();
    } catch (failure) {
      $('app').replaceChildren(el('p', 'muted', failure && failure.code === 'LOGIN' ? 'Sua sessão acabou · entre de novo pelo painel e recarregue esta página' : 'Não consegui carregar a lista agora · recarregue a página'));
    }
  }
  // Back to this tab after a while: the list is read again, so what was sent from the other device shows up.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && data && Date.now() - loadedAt > 60000) load(); });
  load();
})();
