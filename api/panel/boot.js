'use strict';

// Abertura rápida do painel: uma chamada só entrega as listas da abertura.
// 1. Uma leitura só no banco: as listas rodam juntas sobre a mesma sessão, e cada leitura igual (tabela, filtros, página)
//    vai ao banco uma vez e serve a todas (panel-server.rows com ctx.readCache).
// 2. Só a prévia das mensagens: o texto completo fica para quando a conversa é aberta (/api/panel/lead).
// 3. Só o que mudou: o painel manda o que já tem (hash de cada parte e de cada caso do Atendimento); o servidor devolve
//    só as partes e os casos diferentes, mais a ordem completa para remontar a lista igual.
const crypto = require('crypto');
const { requirePanel, send, jsonBody } = require('../../panel-server');

const PARTS = {
  main: {
    today: (q) => ['/api/panel/today', require('./today'), { sort: q.sort || 'ready' }],
    entry: () => ['/api/panel/entry', require('./entry'), {}],
    triage: () => ['/api/panel/triage', require('./triage'), {}],
    whatsapp: () => ['/api/panel/whatsapp', require('./whatsapp'), {}]
  },
  counters: {
    pesquisas: () => ['/api/panel/pesquisas', require('./pesquisas'), {}],
    manheim: () => ['/api/panel/records', require('./records'), { view: 'manheim' }]
  }
};
const PREVIEW_CHARS = 600;
// Fields that change every millisecond (waitedMs, generatedAt) do not count as a change; their text ("há 3 h") does.
const VOLATILE = new Set(['waitedMs', 'generatedAt']);
const hashOf = (value) => crypto.createHash('sha1').update(JSON.stringify(value, (key, val) => VOLATILE.has(key) ? undefined : val)).digest('base64').slice(0, 16);

// One list handler run in memory: its own request/response, the shared session and reads.
function runList(base, path, handler, query) {
  return new Promise((resolve) => {
    const search = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '')).toString();
    const req = { method: 'GET', url: path + (search ? '?' + search : ''), query, headers: {}, __mcsCtx: { ...base } };
    const res = {
      statusCode: 200, headers: {},
      setHeader(name, value) { this.headers[name] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
      end(body) { resolve({ status: this.statusCode, body: body ? JSON.parse(String(body)) : null }); return this; }
    };
    Promise.resolve(handler(req, res)).catch((error) => resolve({ status: 500, body: { error: 'BOOT_PART_FAILED', message: String(error && error.message || error) } }));
  });
}

function trimMessage(message) {
  if (!message || typeof message !== 'object' || typeof message.body_text !== 'string' || message.body_text.length <= PREVIEW_CHARS) return message;
  return { ...message, body_text: message.body_text.slice(0, PREVIEW_CHARS) + '…', body_preview: true };
}
function previewToday(body) {
  if (!body || !Array.isArray(body.items)) return body;
  return { ...body, items: body.items.map((item) => ({ ...item, latestMessage: trimMessage(item.latestMessage), latestMcsMessage: trimMessage(item.latestMcsMessage), lastCustomerMessage: trimMessage(item.lastCustomerMessage) })) };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  const started = Date.now();
  const input = await jsonBody(req, 256 * 1024).catch(() => ({}));
  const group = PARTS[input.part] ? input.part : 'main';
  const have = input.have && typeof input.have === 'object' ? input.have : {};
  const knownItems = new Set(Array.isArray(have.todayItems) ? have.todayItems.map(String) : []);
  const base = { ...ctx, readCache: new Map() };
  const names = Object.keys(PARTS[group]);
  const results = await Promise.all(names.map((name) => { const [path, handler, query] = PARTS[group][name](input); return runList(base, path, handler, query); }));
  const parts = {};
  results.forEach((result, index) => {
    const name = names[index];
    if (result.status !== 200) { parts[name] = { ok: false, status: result.status, error: result.body && result.body.error || 'FAILED' }; return; }
    let body = name === 'today' ? previewToday(result.body) : result.body;
    const hash = hashOf(body);
    if (have[name] === hash) { parts[name] = { ok: true, hash, same: true }; return; }
    if (name === 'today' && Array.isArray(body.items)) {
      // Each case by content: the order is complete, the cases the panel already has are not sent again.
      const order = [], items = {};
      body.items.forEach((item) => { const key = hashOf(item); order.push(key); if (!knownItems.has(key)) items[key] = item; });
      const { items: _drop, ...rest } = body;
      parts[name] = { ok: true, hash, body: rest, order, items };
      return;
    }
    parts[name] = { ok: true, hash, body };
  });
  console.log('[boot-timing]', JSON.stringify({ part: group, ms: Date.now() - started, reads: base.readCache.size }));
  return send(res, 200, { part: group, generatedAt: new Date().toISOString(), parts });
};
