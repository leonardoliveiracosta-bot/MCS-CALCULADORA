'use strict';

// Abertura rápida do painel: uma chamada só entrega as listas da abertura.
// 1. Uma leitura só no banco: as listas rodam juntas sobre a mesma sessão, e cada leitura igual (tabela, filtros, página)
//    vai ao banco uma vez e serve a todas (panel-server.rows com ctx.readCache).
// 2. Só a prévia das mensagens: o texto completo fica para quando a conversa é aberta (/api/panel/lead).
// 3. Só o que mudou: o painel manda o que já tem (hash de cada parte e de cada caso do Atendimento); o servidor devolve
//    só as partes e os casos diferentes, mais a ordem completa para remontar a lista igual.
const crypto = require('crypto');
const { requirePanel, send, jsonBody, rpc } = require('../../panel-server');
const createReadBudget = require('../../panel-read-budget');
const createHistoryBatch = require('../../panel-history-batch');

const PARTS = {
  main: {
    today: (q) => ['/api/panel/today', require('./today'), { sort: q.sort || 'ready' }],
    entry: () => ['/api/panel/entry', require('./entry'), {}],
    triage: () => ['/api/panel/triage', require('./triage'), {}],
    whatsapp: () => ['/api/panel/whatsapp', require('./whatsapp'), {}]
  },
  counters: {
    pesquisas: (q) => ['/api/panel/pesquisas', require('./pesquisas'), q.summary ? { summary: '1' } : {}],
    manheim: (q) => ['/api/panel/records', require('./records'), { view: 'manheim', ...(q.summary ? { summary: '1' } : {}) }]
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
  const base = { ...ctx, readCache: new Map(), buscasBases: new Map(), readBudget: createReadBudget(), bootBulkRows: true, readTimings: [] };
  base.bootTableReads = createHistoryBatch(
    requests => rpc(base, 'panel_boot_history_batch', { p_environment: base.environment, p_requests: requests }),
    (table,columns) => rpc(base, 'panel_boot_table_rows', { p_environment: base.environment, p_table: table, p_columns: columns })
  );
  const pageRequested = group === 'main' && input.page && typeof input.page === 'object';
  const requestsPart = input.includeCounters ? 'pesquisas' : 'completing';
  const definitions = group === 'main' && input.includeCounters ? {...PARTS.main, ...PARTS.counters} : {...PARTS[group]};
  if (pageRequested) {
    if (input.includeCounters) definitions.pesquisas = PARTS.counters.pesquisas;
    else definitions.completing = () => ['/api/panel/pesquisas', require('./pesquisas'), {view:'completion'}];
    definitions.v1 = () => ['/api/panel/vitrine-funnel', require('./vitrine-funnel'), {summary:'1'}];
  }
  const names = Object.keys(definitions);
  const results = await Promise.all(names.map((name) => { const [path, handler, query] = definitions[name](input.includeCounters || pageRequested ? {...input, summary:true} : input); return runList(base, path, handler, query); }));
  // The exact complete queue is assembled before slicing. An unavailable source keeps the
  // previous full-list fallback; it must never become an apparently complete, shorter page.
  if (pageRequested && ['today','entry','triage','whatsapp',requestsPart,'v1'].every(name => results[names.indexOf(name)]?.status === 200)) {
    try {
      const list = Object.fromEntries(names.map((name,index) => [name,results[index].body]));
      const pageRules = require('../../panel-attend-page');
      const {buildContexts, MAX_IDS} = require('../../panel-client-context');
      const model = pageRules.modelOf(list.today,list.entry,list.triage,list.whatsapp,list[requestsPart],input.sort||'ready',started);
      const ids = [...new Set(model.cases.filter(entry => !entry.item && entry.journeyId).map(entry => entry.journeyId))];
      const identities = new Map();
      const chunks = []; for (let index=0;index<ids.length;index+=MAX_IDS) chunks.push(ids.slice(index,index+MAX_IDS));
      await Promise.all(chunks.map(async journeyIds => {
        const contexts = await buildContexts(base,{journeyIds},{listOnly:true});
        journeyIds.forEach(id => identities.set(id,pageRules.identityOf(contexts.journeys?.[id])));
      }));
      const ref = ['all','with','recover','without'].includes(input.page.ref) ? input.page.ref : 'all';
      const stat = ['late24','hot','sent'].includes(input.page.stat) ? input.page.stat : null;
      const query = String(input.page.query||'').trim();
      const selectionAt=Date.now();
      const currentModel=pageRules.modelOf(list.today,list.entry,list.triage,list.whatsapp,list[requestsPart],input.sort||'ready',selectionAt);
      const selected = pageRules.select(currentModel,identities,{sort:input.sort||'ready',ref,stat,query,v1JourneyIds:list.v1.v1JourneyIds,now:selectionAt});
      const limit = Math.max(30,Math.min(10000,Number(input.page.limit)||30));
      const rows = selected.order.slice(0,limit);
      const page = {...selected, order:undefined, key:JSON.stringify([input.sort||'ready',ref,stat,query]), total:selected.order.length, limit, v1Today:list.v1.v1Today,
        identities:Object.fromEntries(rows.filter(row=>!row.entry.item && row.entry.journeyId).map(row=>[row.entry.journeyId,identities.get(row.entry.journeyId)])),
        rows:rows.map(row=>({...row,entry:{...row.entry,item:undefined,itemCaseKey:row.entry.item?row.entry.key:null}}))};
      results[names.indexOf('today')].body = {...list.today,items:rows.map(row=>row.entry.item).filter(Boolean),page};
    } catch (error) {
      console.error('[boot-page-fallback]', String(error?.message||error));
    }
  }
  const parts = {};
  const hashAt = Date.now();
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
  console.log('[boot-timing]', JSON.stringify({ part: group, ms: Date.now() - started, reads: base.readCache.size, hash: Date.now() - hashAt }));
  const sources = new Map();
  for (const { source, wait, network } of base.readTimings) {
    const entry = sources.get(source) || { source, calls: 0, wait: 0, network: 0, maxWait: 0, maxNetwork: 0 };
    entry.calls++; entry.wait += wait; entry.network += network;
    entry.maxWait = Math.max(entry.maxWait, wait); entry.maxNetwork = Math.max(entry.maxNetwork, network);
    sources.set(source, entry);
  }
  console.log('[boot-read-timing]', JSON.stringify({ part: group, sources: [...sources.values()].sort((a,b) => b.maxNetwork - a.maxNetwork) }));
  return send(res, 200, { part: group, generatedAt: new Date().toISOString(), parts });
};
